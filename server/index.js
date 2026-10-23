const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { verifyTelegramInitData } = require('./telegram-auth');

const app = express();
// Render sits behind a trusted reverse proxy; use its forwarded client IP for the fallback IP limiter.
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Keep security headers without a restrictive CSP: the Mini App loads Telegram and MapLibre assets.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '64kb' }));
const apiRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 1500, standardHeaders: 'draft-8', legacyHeaders: false, skip: req => req.path === '/health' });
// Per-account protection after Telegram initData is verified; the IP limit above is only a broad safety net.
const authenticatedApiRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, keyGenerator: req => String(req.telegramUser.id), standardHeaders: 'draft-8', legacyHeaders: false });
const webhookRateLimit = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });

const databaseSslMode = String(process.env.DATABASE_SSL || (String(process.env.DATABASE_URL || '').includes('localhost') ? 'disable' : 'verify-full')).toLowerCase();
if (!['disable', 'require', 'verify-full'].includes(databaseSslMode)) throw new Error('DATABASE_SSL must be one of: disable, require, verify-full');
const databaseSsl = databaseSslMode === 'disable' ? false : { rejectUnauthorized: databaseSslMode === 'verify-full' };
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseSsl,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000
}) : null;

app.get('/config', (_req, res) => {
  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ botUsername });
});

app.post('/telegram/webhook', webhookRateLimit, async (req, res) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret || req.get('x-telegram-bot-api-secret-token') !== expectedSecret) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const miniAppUrl = process.env.MINI_APP_URL;
  if (!token || !miniAppUrl || !miniAppUrl.startsWith('https://')) {
    return res.status(503).json({ error: 'Bot token or HTTPS Mini App URL is not configured' });
  }
  const message = req.body?.message;
  const chatId = message?.chat?.id;
  if (!chatId) return res.json({ ok: true });
  const text = String(message.text || '');
  let replyText = 'Погнали — это приложение для реальных встреч, прогулок, спорта и других планов. Выбирай событие и присоединяйся!';
  const startParts = text.trim().split(/\s+/);
  const startPayload = String(startParts[0] || '').toLowerCase() === '/start' ? (startParts[1] || '') : '';
  const isEventStart = startPayload.startsWith('event_') && /^\d+$/.test(startPayload.slice(6));
  const appUrl = new URL(miniAppUrl);
  if (isEventStart) appUrl.searchParams.set('startapp', startPayload);
  let replyMarkup = { inline_keyboard: [[{ text: '🚀 Открыть Погнали', web_app: { url: appUrl.toString() } }]] };
  if (text.toLowerCase().startsWith('/start') || text.toLowerCase().startsWith('/startapp')) {
    replyText = isEventStart
      ? 'Тебя пригласили на событие 👇 Открой карточку и присоединяйся!'
      : 'Не листай чужую жизнь — давай строить свою. Найди событие или создай своё 👇';  } else if (message.location) {
    replyText = 'Спасибо! Открой Погнали — там можно выбрать события рядом и поставить точку на карте.';
  }
  try {
    const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: replyText, reply_markup: replyMarkup })
    });
    if (!response.ok) throw new Error('Telegram Bot API returned ' + response.status);
    res.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook delivery failed:', error.message);
    res.status(502).json({ error: 'Could not reply through Telegram Bot API' });
  }
});

app.get('/api/health', async (_req, res) => {
  let database = 'not_configured';
  if (pool) {
    try { await pool.query('SELECT 1'); database = 'ok'; }
    catch { database = 'error'; }
  }
  res.status(database === 'ok' ? 200 : 503).json({
    ok: database !== 'error',
    service: 'pognali-api',
    database,
    telegramAuthConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    time: new Date().toISOString()
  });
});

function requireDatabase(_req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Сервис временно недоступен. Попробуй ещё раз позже.' });
  next();
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })
    });
    if (!response.ok) { console.warn('Telegram notification was not delivered:', response.status); return false; }
    return true;
  } catch (error) { console.warn('Telegram notification failed:', error.message); return false; }
}

async function requireTelegram(req, res, next) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(503).json({ error: 'Telegram bot token is not configured on the server' });
  const initData = req.get('x-telegram-init-data') || '';
  const auth = verifyTelegramInitData(initData, token);
  if (!auth.ok) {
    let initDataKeys = [];
    try { initDataKeys = [...new URLSearchParams(initData).keys()].sort(); } catch {}
    console.warn('Telegram initData rejected:', JSON.stringify({ reason: auth.error, initDataPresent: Boolean(initData), initDataLength: initData.length, keys: initDataKeys }));
    return res.status(401).json({ error: auth.error === 'Telegram login expired; reopen the Mini App' ? 'Сессия Telegram устарела. Открой приложение заново.' : 'Не удалось подтвердить вход через Telegram. Открой приложение заново.' });
  }
  req.telegramUser = auth.user;
  try {
    await pool.query(
      `INSERT INTO users (id, username, first_name, last_name, photo_url)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,
         first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
         photo_url=COALESCE(EXCLUDED.photo_url, users.photo_url), updated_at=NOW()`,
      [auth.user.id, auth.user.username, auth.user.first_name, auth.user.last_name, auth.user.photo_url]
    );
    next();
  } catch (error) {
    console.error('User upsert failed:', error.message);
    res.status(503).json({ error: 'База данных временно недоступна. Попробуй ещё раз чуть позже.' });
  }
}

app.use('/api', apiRateLimit, (req, res, next) => {
  if (req.path === '/health') return next();
  return requireDatabase(req, res, () => requireTelegram(req, res, () => authenticatedApiRateLimit(req, res, next)));
});

app.get('/api/me', async (req, res) => {
  const result = await pool.query(
    'SELECT id, username, first_name, last_name, display_name, photo_url, city, bio, created_at FROM users WHERE id=$1',
    [req.telegramUser.id]
  );
  res.json({ user: result.rows[0] });
});

app.patch('/api/me', async (req, res) => {
  const displayName = typeof req.body.display_name === 'string' ? req.body.display_name.trim().slice(0, 80) : undefined;
  const city = typeof req.body.city === 'string' ? req.body.city.trim().slice(0, 120) : undefined;
  const bio = typeof req.body.bio === 'string' ? req.body.bio.trim().slice(0, 500) : undefined;
  const result = await pool.query(
    `UPDATE users SET display_name=COALESCE($2, display_name), city=COALESCE($3, city), bio=COALESCE($4, bio), updated_at=NOW()
     WHERE id=$1 RETURNING id, username, first_name, last_name, display_name, photo_url, city, bio`,
    [req.telegramUser.id, displayName ?? null, city ?? null, bio ?? null]
  );
  res.json({ user: result.rows[0] });
});

app.get('/api/events', async (req, res) => {
  const city = typeof req.query.city === 'string' ? req.query.city.trim().slice(0, 120) : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim().slice(0, 40) : '';
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 40));
  const result = await pool.query(
    `SELECT e.*, COALESCE(u.display_name, u.first_name) AS creator_first_name, u.username AS creator_username,
       COUNT(ep.user_id) FILTER (WHERE ep.status='joined')::int AS participants_count,
       BOOL_OR(ep.user_id=$3 AND ep.status='joined') AS joined_by_me
     FROM events e JOIN users u ON u.id=e.creator_id
     LEFT JOIN event_participants ep ON ep.event_id=e.id
     WHERE e.status='published' AND e.starts_at >= NOW() - INTERVAL '12 hours'
       AND ($1='' OR LOWER(e.city)=LOWER($1)) AND ($2='' OR e.category=$2)
     GROUP BY e.id, u.id ORDER BY e.starts_at ASC LIMIT $4`,
    [city, category, req.telegramUser.id, limit]
  );
  res.json({ events: result.rows });
});

app.get('/api/events/:id', async (req, res) => {
  const result = await pool.query(
    `SELECT e.*, COALESCE(u.display_name, u.first_name) AS creator_first_name, u.username AS creator_username,
       COUNT(ep.user_id) FILTER (WHERE ep.status='joined')::int AS participants_count,
       BOOL_OR(ep.user_id=$2 AND ep.status='joined') AS joined_by_me
     FROM events e JOIN users u ON u.id=e.creator_id
     LEFT JOIN event_participants ep ON ep.event_id=e.id
     WHERE e.id=$1 AND e.status <> 'cancelled'
     GROUP BY e.id, u.id`,
    [req.params.id, req.telegramUser.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Event not found' });
  const people = await pool.query(
    `SELECT u.id, u.username, u.first_name, u.last_name, u.photo_url
     FROM event_participants ep JOIN users u ON u.id=ep.user_id
     WHERE ep.event_id=$1 AND ep.status='joined' ORDER BY ep.joined_at`,
    [req.params.id]
  );
  res.json({ event: result.rows[0], participants: people.rows });
});

app.post('/api/events', async (req, res) => {
  const b = req.body || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const cityInput = typeof b.city === 'string' ? b.city.trim().slice(0, 120) : '';
  const addressInput = typeof b.address === 'string' ? b.address.trim().slice(0, 120) : '';
  // A map-picked point can be valid even when reverse geocoding cannot identify a city.
  const city = cityInput || addressInput || 'Не указан';
  const startsAt = new Date(b.starts_at);
  if (title.length < 3 || title.length > 120 || !city || city.length > 120 || !Number.isFinite(startsAt.getTime())) {
    return res.status(400).json({ error: 'Title (3–120 chars), city and valid starts_at are required' });
  }
  const capacity = b.capacity == null || b.capacity === '' ? null : Number(b.capacity);
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 5000)) {
    return res.status(400).json({ error: 'capacity must be between 1 and 5000' });
  }
  const lat = b.latitude == null || b.latitude === '' ? null : Number(b.latitude);
  const lon = b.longitude == null || b.longitude === '' ? null : Number(b.longitude);
  if ((lat === null) !== (lon === null) || (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180))) {
    return res.status(400).json({ error: 'Invalid map coordinates' });
  }
  const endsAt = b.ends_at ? new Date(b.ends_at) : null;
  if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt < startsAt)) return res.status(400).json({ error: 'Invalid ends_at' });
  const result = await pool.query(
    `INSERT INTO events (creator_id,title,description,category,city,address,latitude,longitude,starts_at,ends_at,capacity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.telegramUser.id, title, typeof b.description === 'string' ? b.description.trim().slice(0,3000) : '',
      typeof b.category === 'string' ? b.category.slice(0,40) : 'other', city, typeof b.address === 'string' ? b.address.trim().slice(0,250) : '',
      lat, lon, startsAt.toISOString(), endsAt ? endsAt.toISOString() : null, capacity]
  );
  await pool.query(
    `INSERT INTO event_participants (event_id,user_id,status) VALUES ($1,$2,'joined')
     ON CONFLICT (event_id,user_id) DO UPDATE SET status='joined', joined_at=NOW()`,
    [result.rows[0].id, req.telegramUser.id]
  );
  res.status(201).json({ event: { ...result.rows[0], participants_count: 1, joined_by_me: true } });
});

app.patch('/api/events/:id', async (req, res) => {
  const b = req.body || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const city = typeof b.city === 'string' ? b.city.trim() : '';
  const startsAt = new Date(b.starts_at);
  const capacity = b.capacity == null || b.capacity === '' ? null : Number(b.capacity);
  const lat = b.latitude == null || b.latitude === '' ? null : Number(b.latitude);
  const lon = b.longitude == null || b.longitude === '' ? null : Number(b.longitude);
  const endsAt = b.ends_at ? new Date(b.ends_at) : null;
  if (title.length < 3 || title.length > 120 || !city || city.length > 120 || !Number.isFinite(startsAt.getTime())) {
    return res.status(400).json({ error: 'Title (3–120 chars), city and valid starts_at are required' });
  }
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 5000)) return res.status(400).json({ error: 'Invalid capacity' });
  if ((lat === null) !== (lon === null) || (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180))) return res.status(400).json({ error: 'Invalid map coordinates' });
  if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt < startsAt)) return res.status(400).json({ error: 'Invalid ends_at' });
  const result = await pool.query(
    `UPDATE events SET title=$3, description=$4, category=$5, city=$6, address=$7,
       latitude=$8, longitude=$9, starts_at=$10, ends_at=$11, capacity=$12, updated_at=NOW()
     WHERE id=$1 AND creator_id=$2 AND status='published' RETURNING *`,
    [req.params.id, req.telegramUser.id, title, typeof b.description === 'string' ? b.description.trim().slice(0,3000) : '',
      typeof b.category === 'string' ? b.category.slice(0,40) : 'other', city,
      typeof b.address === 'string' ? b.address.trim().slice(0,250) : '', lat, lon,
      startsAt.toISOString(), endsAt ? endsAt.toISOString() : null, capacity]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Event not found or you are not its organizer' });
  res.json({ event: result.rows[0] });
});

app.delete('/api/events/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM events WHERE id=$1 AND creator_id=$2 RETURNING id', [req.params.id, req.telegramUser.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Event not found or you are not its organizer' });
  res.json({ deleted: true, eventId: String(req.params.id) });
});

app.post('/api/events/:id/finish', async (req, res) => {
  const result = await pool.query(
    `UPDATE events SET status='completed', updated_at=NOW()
     WHERE id=$1 AND creator_id=$2 AND status='published' RETURNING id`,
    [req.params.id, req.telegramUser.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Event not found or you are not its organizer' });
  res.json({ finished: true, eventId: String(req.params.id) });
});

app.get('/api/events/:id/messages', async (req, res) => {
  const member = await pool.query(
    `SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2 AND status='joined'`,
    [req.params.id, req.telegramUser.id]
  );
  if (!member.rowCount) return res.status(403).json({ error: 'Join the event to access its chat' });
  const result = await pool.query(
    `SELECT m.id, m.event_id, m.sender_id, m.body, m.created_at,
       COALESCE(u.display_name, u.first_name) AS sender_name, u.username, u.photo_url
     FROM event_messages m JOIN users u ON u.id=m.sender_id
     WHERE m.event_id=$1 ORDER BY m.created_at ASC LIMIT 500`,
    [req.params.id]
  );
  res.json({ messages: result.rows });
});

app.post('/api/events/:id/messages', async (req, res) => {
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!body || body.length > 2000) return res.status(400).json({ error: 'Message must contain 1–2000 characters' });
  const member = await pool.query(
    `SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2 AND status='joined'`,
    [req.params.id, req.telegramUser.id]
  );
  if (!member.rowCount) return res.status(403).json({ error: 'Join the event to send messages' });
  const result = await pool.query(
    'INSERT INTO event_messages (event_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, event_id, sender_id, body, created_at',
    [req.params.id, req.telegramUser.id, body]
  );
  res.status(201).json({ message: result.rows[0] });
  const recipients = await pool.query("SELECT ep.user_id FROM event_participants ep WHERE ep.event_id=$1 AND ep.status='joined' AND ep.user_id<>$2", [req.params.id, req.telegramUser.id]);
  const eventTitle = await pool.query('SELECT title FROM events WHERE id=$1', [req.params.id]);
  const title = eventTitle.rows[0]?.title || 'событие';
  for (const recipient of recipients.rows) void sendTelegramMessage(recipient.user_id, '💬 Новое сообщение в чате события «' + title + '». Открой «Погнали», чтобы ответить.');
});


function sortedUserPair(a,b){return BigInt(a)<BigInt(b)?[String(a),String(b)]:[String(b),String(a)]}
async function hasMessagingBlock(a,b){const r=await pool.query("SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1",[a,b]);return r.rowCount>0}
app.get('/api/users/search',async(req,res)=>{const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,80):'';if(q.length<2)return res.json({users:[]});const pattern='%'+q.replaceAll('%','').replaceAll('_','')+'%';const r=await pool.query("SELECT id,username,first_name,last_name,display_name,photo_url,city FROM users WHERE id<>$1 AND (COALESCE(display_name,'') ILIKE $2 OR COALESCE(username,'') ILIKE $2 OR first_name ILIKE $2 OR last_name ILIKE $2) ORDER BY COALESCE(display_name,first_name) LIMIT 20",[req.telegramUser.id,pattern]);res.json({users:r.rows})});
app.get('/api/messages/unread-count', async (req, res) => {
  const uid = req.telegramUser.id;
  const result = await pool.query(
    `SELECT (
      (SELECT COUNT(*) FROM direct_messages m
       JOIN direct_conversations c ON c.id=m.conversation_id
       WHERE (c.user_low=$1 OR c.user_high=$1) AND c.status='accepted' AND m.sender_id<>$1
         AND m.created_at > COALESCE((SELECT r.last_read_at FROM message_reads r WHERE r.user_id=$1 AND r.conversation_type='direct' AND r.conversation_id=c.id), 'epoch'::timestamptz))
      +
      (SELECT COUNT(*) FROM event_contact_messages m
       JOIN event_contact_conversations c ON c.id=m.conversation_id
       WHERE (c.participant_id=$1 OR c.organizer_id=$1) AND m.sender_id<>$1
         AND m.created_at > COALESCE((SELECT r.last_read_at FROM message_reads r WHERE r.user_id=$1 AND r.conversation_type='event_contact' AND r.conversation_id=c.id), 'epoch'::timestamptz))
      +
      (SELECT COUNT(*) FROM event_messages m
       JOIN event_participants ep ON ep.event_id=m.event_id AND ep.user_id=$1 AND ep.status='joined'
       WHERE m.sender_id<>$1
         AND m.created_at > COALESCE((SELECT r.last_read_at FROM message_reads r WHERE r.user_id=$1 AND r.conversation_type='event' AND r.conversation_id=m.event_id), 'epoch'::timestamptz))
    )::int AS unread_count`,
    [uid]
  );
  res.json({ unreadCount: Number(result.rows[0]?.unread_count || 0) });
});

app.post('/api/messages/read', async (req, res) => {
  const type = String(req.body?.type || '');
  const id = String(req.body?.conversation_id || '');
  if (!['event','direct','event_contact'].includes(type) || !/^[1-9]\d{0,18}$/.test(id)) {
    return res.status(400).json({ error: 'A valid conversation type and ID are required' });
  }
  const uid = req.telegramUser.id;
  let allowed = false;
  if (type === 'event') {
    const r = await pool.query("SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2 AND status='joined'", [id, uid]);
    allowed = r.rowCount > 0;
  } else if (type === 'direct') {
    const r = await pool.query("SELECT 1 FROM direct_conversations WHERE id=$1 AND status='accepted' AND (user_low=$2 OR user_high=$2)", [id, uid]);
    allowed = r.rowCount > 0;
  } else {
    const r = await pool.query("SELECT 1 FROM event_contact_conversations WHERE id=$1 AND (participant_id=$2 OR organizer_id=$2)", [id, uid]);
    allowed = r.rowCount > 0;
  }
  if (!allowed) return res.status(403).json({ error: 'Conversation is not available to this user' });
  await pool.query(
    `INSERT INTO message_reads (user_id, conversation_type, conversation_id, last_read_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (user_id, conversation_type, conversation_id)
     DO UPDATE SET last_read_at=EXCLUDED.last_read_at`,
    [uid, type, id]
  );
  res.json({ markedRead: true });
});

app.get('/api/messages',async(req,res)=>{const uid=req.telegramUser.id;const [direct,contacts,eventChats]=await Promise.all([
pool.query("SELECT c.id,c.status,c.requested_by,c.updated_at,CASE WHEN c.user_low=$1 THEN c.user_high ELSE c.user_low END AS other_user_id,COALESCE(u.display_name,u.first_name) AS other_name,u.username,(SELECT body FROM direct_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message FROM direct_conversations c JOIN users u ON u.id=CASE WHEN c.user_low=$1 THEN c.user_high ELSE c.user_low END WHERE (c.user_low=$1 OR c.user_high=$1) AND (c.status<>'rejected' OR c.requested_by=$1) ORDER BY c.updated_at DESC LIMIT 100",[uid]),
pool.query("SELECT c.id,c.event_id,c.participant_id,c.organizer_id,c.updated_at,e.title AS event_title,CASE WHEN c.participant_id=$1 THEN c.organizer_id ELSE c.participant_id END AS other_user_id,COALESCE(u.display_name,u.first_name) AS other_name,(SELECT body FROM event_contact_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message FROM event_contact_conversations c JOIN events e ON e.id=c.event_id JOIN users u ON u.id=CASE WHEN c.participant_id=$1 THEN c.organizer_id ELSE c.participant_id END WHERE c.participant_id=$1 OR c.organizer_id=$1 ORDER BY c.updated_at DESC LIMIT 100",[uid]),
pool.query("SELECT e.id AS event_id,e.title,e.starts_at,(SELECT body FROM event_messages m WHERE m.event_id=e.id ORDER BY m.created_at DESC LIMIT 1) AS last_message FROM event_participants ep JOIN events e ON e.id=ep.event_id WHERE ep.user_id=$1 AND ep.status='joined' AND e.status<>'cancelled' ORDER BY e.starts_at DESC LIMIT 100",[uid])]);res.json({direct:direct.rows,eventContacts:contacts.rows,eventChats:eventChats.rows})});
app.post('/api/direct/requests',async(req,res)=>{const target=String(req.body&&req.body.user_id||'');if(!target || target.length>20 || ![...target].every(ch=>ch>='0'&&ch<='9') || BigInt(target)<=0n)return res.status(400).json({error:'A valid user_id is required'});if(target===String(req.telegramUser.id))return res.status(400).json({error:'You cannot message yourself'});const u=await pool.query('SELECT id FROM users WHERE id=$1',[target]);if(!u.rowCount)return res.status(404).json({error:'User not found'});if(await hasMessagingBlock(req.telegramUser.id,target))return res.status(403).json({error:'Messaging is unavailable between these users'});const [low,high]=sortedUserPair(req.telegramUser.id,target);const r=await pool.query("INSERT INTO direct_conversations(user_low,user_high,requested_by,status) VALUES($1,$2,$3,'pending') ON CONFLICT(user_low,user_high) DO UPDATE SET requested_by=EXCLUDED.requested_by,status='pending',updated_at=NOW() WHERE direct_conversations.status='rejected' AND direct_conversations.requested_by<>EXCLUDED.requested_by RETURNING id,status,requested_by",[low,high,req.telegramUser.id]);if(r.rowCount)return res.status(201).json({conversation:r.rows[0]});const old=await pool.query('SELECT id,status,requested_by FROM direct_conversations WHERE user_low=$1 AND user_high=$2',[low,high]);if(old.rows[0]&&old.rows[0].status==='accepted')return res.json({conversation:old.rows[0],alreadyAccepted:true});if(old.rows[0]&&old.rows[0].status==='pending')return res.json({conversation:old.rows[0],requestPending:true});return res.status(403).json({error:'The other user must initiate a new request'})});
app.post('/api/direct/:id/respond',async(req,res)=>{const d=req.body&&req.body.decision;const status=d==='accept'?'accepted':d==='reject'?'rejected':'';if(!status)return res.status(400).json({error:'decision must be accept or reject'});const r=await pool.query("UPDATE direct_conversations SET status=$2,updated_at=NOW() WHERE id=$1 AND (user_low=$3 OR user_high=$3) AND requested_by<>$3 AND status='pending' RETURNING id,status",[req.params.id,status,req.telegramUser.id]);if(!r.rowCount)return res.status(404).json({error:'Pending request not found'});res.json({conversation:r.rows[0]})});
app.get('/api/direct/:id/messages',async(req,res)=>{const c=await pool.query('SELECT id,status,user_low,user_high,requested_by FROM direct_conversations WHERE id=$1 AND (user_low=$2 OR user_high=$2)',[req.params.id,req.telegramUser.id]);if(!c.rowCount)return res.status(404).json({error:'Conversation not found'});const row=c.rows[0];if(row.status!=='accepted'){if(row.status==='pending'&&String(row.requested_by)!==String(req.telegramUser.id))return res.json({messages:[],request:row});return res.status(403).json({error:'Personal messages require mutual consent'})}const other=String(row.user_low)===String(req.telegramUser.id)?row.user_high:row.user_low;if(await hasMessagingBlock(req.telegramUser.id,other))return res.status(403).json({error:'Messaging is unavailable between these users'});const r=await pool.query('SELECT m.id,m.sender_id,m.body,m.created_at,COALESCE(u.display_name,u.first_name) AS sender_name FROM direct_messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=$1 ORDER BY m.created_at ASC LIMIT 500',[req.params.id]);res.json({messages:r.rows})});
app.post('/api/direct/:id/messages',async(req,res)=>{const body=typeof(req.body&&req.body.body)==='string'?req.body.body.trim():'';if(!body||body.length>2000)return res.status(400).json({error:'Message must contain 1–2000 characters'});const c=await pool.query("SELECT id,user_low,user_high FROM direct_conversations WHERE id=$1 AND status='accepted' AND (user_low=$2 OR user_high=$2)",[req.params.id,req.telegramUser.id]);if(!c.rowCount)return res.status(403).json({error:'Personal messages require mutual consent'});const other=String(c.rows[0].user_low)===String(req.telegramUser.id)?c.rows[0].user_high:c.rows[0].user_low;if(await hasMessagingBlock(req.telegramUser.id,other))return res.status(403).json({error:'Messaging is unavailable between these users'});const r=await pool.query('INSERT INTO direct_messages(conversation_id,sender_id,body) VALUES($1,$2,$3) RETURNING id,sender_id,body,created_at',[req.params.id,req.telegramUser.id,body]);await pool.query('UPDATE direct_conversations SET updated_at=NOW() WHERE id=$1',[req.params.id]);res.status(201).json({message:r.rows[0]});void sendTelegramMessage(other,'💬 Новое личное сообщение в «Погнали». Открой приложение, чтобы ответить.')});
app.post('/api/users/:id/block',async(req,res)=>{if(String(req.params.id)===String(req.telegramUser.id))return res.status(400).json({error:'You cannot block yourself'});const u=await pool.query('SELECT id FROM users WHERE id=$1',[req.params.id]);if(!u.rowCount)return res.status(404).json({error:'User not found'});await pool.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.telegramUser.id,req.params.id]);res.json({blocked:true})});
app.post('/api/events/:id/contact',async(req,res)=>{const e=await pool.query("SELECT id,creator_id,title FROM events WHERE id=$1 AND status='published'",[req.params.id]);if(!e.rowCount)return res.status(404).json({error:'Event not found or no longer available'});const organizer=String(e.rows[0].creator_id),participant=String(req.telegramUser.id);if(organizer===participant)return res.status(400).json({error:'You are the organizer of this event'});if(await hasMessagingBlock(participant,organizer))return res.status(403).json({error:'Messaging is unavailable between these users'});const r=await pool.query('INSERT INTO event_contact_conversations(event_id,participant_id,organizer_id) VALUES($1,$2,$3) ON CONFLICT(event_id,participant_id) DO UPDATE SET updated_at=NOW() RETURNING id,event_id,participant_id,organizer_id',[req.params.id,participant,organizer]);res.status(201).json({conversation:r.rows[0],eventTitle:e.rows[0].title})});
app.get('/api/event-contacts/:id/messages',async(req,res)=>{const c=await pool.query('SELECT id,event_id,participant_id,organizer_id FROM event_contact_conversations WHERE id=$1 AND (participant_id=$2 OR organizer_id=$2)',[req.params.id,req.telegramUser.id]);if(!c.rowCount)return res.status(404).json({error:'Conversation not found'});const row=c.rows[0],other=String(row.participant_id)===String(req.telegramUser.id)?row.organizer_id:row.participant_id;if(await hasMessagingBlock(req.telegramUser.id,other))return res.status(403).json({error:'Messaging is unavailable between these users'});const r=await pool.query('SELECT m.id,m.sender_id,m.body,m.created_at,COALESCE(u.display_name,u.first_name) AS sender_name FROM event_contact_messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=$1 ORDER BY m.created_at ASC LIMIT 500',[req.params.id]);res.json({messages:r.rows,conversation:row})});
app.post('/api/event-contacts/:id/messages',async(req,res)=>{const body=typeof(req.body&&req.body.body)==='string'?req.body.body.trim():'';if(!body||body.length>2000)return res.status(400).json({error:'Message must contain 1–2000 characters'});const c=await pool.query('SELECT id,participant_id,organizer_id FROM event_contact_conversations WHERE id=$1 AND (participant_id=$2 OR organizer_id=$2)',[req.params.id,req.telegramUser.id]);if(!c.rowCount)return res.status(404).json({error:'Conversation not found'});const row=c.rows[0],other=String(row.participant_id)===String(req.telegramUser.id)?row.organizer_id:row.participant_id;if(await hasMessagingBlock(req.telegramUser.id,other))return res.status(403).json({error:'Messaging is unavailable between these users'});const r=await pool.query('INSERT INTO event_contact_messages(conversation_id,sender_id,body) VALUES($1,$2,$3) RETURNING id,sender_id,body,created_at',[req.params.id,req.telegramUser.id,body]);await pool.query('UPDATE event_contact_conversations SET updated_at=NOW() WHERE id=$1',[req.params.id]);res.status(201).json({message:r.rows[0]});void sendTelegramMessage(other,'💬 Новое сообщение по событию в «Погнали». Открой приложение, чтобы ответить.')});

async function recordEventShareAction(eventId, userId, action) {
  const table = await pool.query("SELECT to_regclass('public.event_share_events') AS table_name");
  if (!table.rows[0]?.table_name) return false;
  await pool.query('INSERT INTO event_share_events (event_id,user_id,action) VALUES ($1,$2,$3)', [eventId,userId,action]);
  return true;
}
app.post('/api/events/:id/reports', async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 40) : '';
  const details = typeof req.body?.details === 'string' ? req.body.details.trim().slice(0, 1000) : '';
  const allowedReasons = new Set(['spam', 'fake', 'inappropriate', 'unsafe', 'other']);
  if (!allowedReasons.has(reason)) return res.status(400).json({ error: 'Choose a valid report reason' });
  const event = await pool.query('SELECT id, creator_id, status FROM events WHERE id = $1', [req.params.id]);
  if (!event.rowCount || event.rows[0].status !== 'published') return res.status(404).json({ error: 'Event not found' });
  if (String(event.rows[0].creator_id) === String(req.telegramUser.id)) return res.status(400).json({ error: 'You cannot report your own event' });
  const result = await pool.query('INSERT INTO event_reports (event_id, reporter_id, reason, details) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id, reporter_id) DO UPDATE SET reason = EXCLUDED.reason, details = EXCLUDED.details, created_at = NOW() RETURNING id', [req.params.id, req.telegramUser.id, reason, details || null]);
  const reportId = result.rows[0].id;
  const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (adminChatId) {
    const eventInfo = await pool.query('SELECT title, city FROM events WHERE id=$1', [req.params.id]);
    const reporter = req.telegramUser.username ? '@' + req.telegramUser.username : [req.telegramUser.first_name, req.telegramUser.last_name].filter(Boolean).join(' ') || String(req.telegramUser.id);
    const reasonLabels = { spam: 'Спам или реклама', fake: 'Обман или фальшивое событие', inappropriate: 'Неприемлемый контент', unsafe: 'Опасное событие', other: 'Другое' };
    const note = '🚨 Новая жалоба на событие\n' + 'Жалоба №' + reportId + '\n' + 'Событие: ' + (eventInfo.rows[0]?.title || ('#' + req.params.id)) + '\n' + 'Город: ' + (eventInfo.rows[0]?.city || 'не указан') + '\n' + 'Причина: ' + reasonLabels[reason] + '\n' + 'От: ' + reporter + '\n' + (details ? 'Подробности: ' + details.slice(0, 700) + '\n' : '') + 'Статус: open';
    void sendTelegramMessage(adminChatId, note).then(delivered => { if (!delivered) console.warn('Admin report notification was not delivered; check ADMIN_TELEGRAM_CHAT_ID and that the admin started the bot.'); });
  } else {
    console.warn('Report saved without Telegram notification: ADMIN_TELEGRAM_CHAT_ID is not configured.');
  }
  res.status(201).json({ reported: true, reportId });
});

app.post('/api/events/:id/share', async (req, res) => {
  const event = await pool.query("SELECT id FROM events WHERE id=$1 AND status='published'", [req.params.id]);
  if (!event.rowCount) return res.status(404).json({ error: 'Event not found or no longer available' });
  const tracked = await recordEventShareAction(req.params.id, req.telegramUser.id, 'share_opened');
  res.json({ tracked, eventId: String(req.params.id) });
});
app.post('/api/events/:id/share-opened', async (req, res) => {
  const event = await pool.query("SELECT id FROM events WHERE id=$1 AND status='published'", [req.params.id]);
  if (!event.rowCount) return res.status(404).json({ error: 'Event not found or no longer available' });
  const tracked = await recordEventShareAction(req.params.id, req.telegramUser.id, 'opened_from_share');
  res.json({ tracked, eventId: String(req.params.id) });
});

app.post('/api/events/:id/join', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await client.query('SELECT id, capacity, status FROM events WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!event.rowCount || event.rows[0].status !== 'published') {
      await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' });
    }
    const source = ['share','organic'].includes(req.body?.source) ? req.body.source : 'organic';
    const existing = await client.query(
      `SELECT status FROM event_participants WHERE event_id=$1 AND user_id=$2`,
      [req.params.id, req.telegramUser.id]
    );
    if (existing.rows[0]?.status !== 'joined' && event.rows[0].capacity !== null) {
      const count = await client.query(`SELECT COUNT(*)::int AS n FROM event_participants WHERE event_id=$1 AND status='joined'`, [req.params.id]);
      if (count.rows[0].n >= event.rows[0].capacity) {
        await client.query('ROLLBACK'); return res.status(409).json({ error: 'Event is full' });
      }
    }
    await client.query(
      `INSERT INTO event_participants (event_id,user_id,status,join_source) VALUES ($1,$2,'joined',$3)
       ON CONFLICT (event_id,user_id) DO UPDATE SET status='joined', joined_at=NOW(), join_source=EXCLUDED.join_source`,
      [req.params.id, req.telegramUser.id, source]
    );
    const eventInfo = await client.query('SELECT title, creator_id FROM events WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ joined: true, eventId: String(req.params.id) });
    if (eventInfo.rowCount && String(eventInfo.rows[0].creator_id) !== String(req.telegramUser.id)) {
      void sendTelegramMessage(eventInfo.rows[0].creator_id, '👋 На событие «' + eventInfo.rows[0].title + '» записался новый участник. Открой «Погнали», чтобы посмотреть участников.');
    }
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
});

app.post('/api/events/:id/leave', async (req, res) => {
  const result = await pool.query(
    `UPDATE event_participants SET status='left' WHERE event_id=$1 AND user_id=$2 AND status='joined'`,
    [req.params.id, req.telegramUser.id]
  );
  res.json({ left: result.rowCount > 0, eventId: String(req.params.id) });
});

app.get('/api/my/events', async (req, res) => {
  const result = await pool.query(
    `SELECT e.*, ep.status AS my_status,
       COUNT(allp.user_id) FILTER (WHERE allp.status='joined')::int AS participants_count
     FROM event_participants ep JOIN events e ON e.id=ep.event_id
     LEFT JOIN event_participants allp ON allp.event_id=e.id
     WHERE ep.user_id=$1 AND ep.status='joined' AND e.status='published'
     GROUP BY e.id, ep.status ORDER BY e.starts_at ASC`,
    [req.telegramUser.id]
  );
  res.json({ events: result.rows });
});

// Moderation API: requires both a valid Telegram session and a separately configured admin token.
function requireAdmin(req, res, next) {
  const configured = process.env.ADMIN_API_TOKEN;
  const supplied = req.get('x-admin-token') || '';
  if (!configured) return res.status(503).json({ error: 'Admin moderation is not configured' });
  if (supplied.length !== configured.length || !require('node:crypto').timingSafeEqual(Buffer.from(supplied), Buffer.from(configured))) {
    return res.status(403).json({ error: 'Admin access denied' });
  }
  next();
}

app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  const status = ['open', 'reviewing', 'resolved', 'dismissed'].includes(String(req.query.status || 'open'))
    ? String(req.query.status || 'open') : 'open';
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const result = await pool.query(
    `SELECT r.id, r.event_id, r.reporter_id, r.reason, r.details, r.status, r.created_at,
            e.title AS event_title, e.city AS event_city, e.starts_at AS event_starts_at,
            e.status AS event_status, e.creator_id,
            COALESCE(u.display_name, u.first_name, u.username, r.reporter_id::text) AS reporter_name
     FROM event_reports r
     JOIN events e ON e.id = r.event_id
     LEFT JOIN users u ON u.id = r.reporter_id
     WHERE r.status = $1
     ORDER BY r.created_at DESC
     LIMIT $2`,
    [status, limit]
  );
  res.json({ reports: result.rows });
});

app.patch('/api/admin/reports/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const status = String(req.body?.status || '');
  if (!/^[1-9]\\d{0,18}$/.test(id) || !['open', 'reviewing', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'A valid report ID and status are required' });
  }
  const result = await pool.query(
    'UPDATE event_reports SET status = $2 WHERE id = $1 RETURNING id, event_id, status',
    [id, status]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Report not found' });
  res.json({ report: result.rows[0] });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled API error:', err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Что-то пошло не так. Попробуй ещё раз.' });
});

const webRoot = path.resolve(process.env.WEB_ROOT || 'docs/telegram');
app.use(express.static(webRoot));
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  try { res.sendFile(path.join(webRoot, 'index.html')); } catch { next(); }
});

async function configureTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const miniAppUrl = process.env.MINI_APP_URL;
  if (!token || !secret || !miniAppUrl || !miniAppUrl.startsWith('https://')) {
    console.log('Telegram webhook not configured: required environment variables are missing');
    return;
  }
  const webhookUrl = 'https://pognali-telegram-mini-app.onrender.com/telegram/webhook';
  try {
    const identityResponse = await fetch('https://api.telegram.org/bot' + token + '/getMe');
    const identity = await identityResponse.json();
    if (identity.ok && identity.result && identity.result.username) {
      console.log('Telegram token belongs to bot @' + identity.result.username);
    } else {
      console.error('Telegram getMe failed:', identity.description || identityResponse.status);
    }
    const response = await fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      console.error('Telegram webhook setup failed:', result.description || response.status);
      return;
    }
    console.log('Telegram webhook configured');
  } catch (error) {
    console.error('Telegram webhook setup failed:', error.message);
  }
}

async function start() {
  if (pool) {
    const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
  }
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Pognali API listening on ${port}; DB ${pool ? 'configured' : 'missing'}`);
    configureTelegramWebhook();
  });
}
if (require.main === module) start().catch(error => { console.error('Startup failed:', error.message); process.exit(1); });
module.exports = { app, start };
