const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const helmet = require('helmet');
const compression = require('compression');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
const sharp = require('sharp');
const { verifyTelegramInitData } = require('./telegram-auth');
const { syncTelegramProfile } = require('./telegram-profile');

const app = express();
// Ids in URLs are numeric: answer 404 for anything else instead of letting PostgreSQL fail with a 500.
app.param('id', (req, res, next, value) => (/^\d{1,15}$/.test(value) ? next() : res.status(404).json({ error: 'Не найдено' })));
// Render sits behind a trusted reverse proxy; use its forwarded client IP for the fallback IP limiter.
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Keep security headers without a restrictive CSP: the Mini App loads Telegram and MapLibre assets.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression({ filter: (req, res) => req.path.startsWith('/api/') && compression.filter(req, res) }));
app.use(express.json({ limit: '64kb' }));
// PostgreSQL text columns cannot store NUL characters: reject them as a client error rather than a 500.
app.use((req, res, next) => (req.body && typeof req.body === 'object' && JSON.stringify(req.body).includes('\\u0000') ? res.status(400).json({ error: 'Некорректные символы в тексте' }) : next()));

// Cache shared event-list data briefly; every API write invalidates it before route handlers run.
const eventsCache = new Map();
const configuredEventsTtl = Number(process.env.EVENTS_CACHE_TTL_MS);
const EVENTS_TTL_MS = Number.isFinite(configuredEventsTtl) && configuredEventsTtl >= 0 ? Math.min(configuredEventsTtl, 60000) : 5000;
const LIST_CHANGING_WRITE = /^\/events(\/\d+(\/finish)?)?$/;
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && LIST_CHANGING_WRITE.test(req.path)) res.on('finish', () => eventsCache.clear());
  next();
});
const apiRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 1500, standardHeaders: 'draft-8', legacyHeaders: false, skip: req => req.path === '/health' });
// Per-account protection after Telegram initData is verified; the IP limit above is only a broad safety net.
const authenticatedApiRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, keyGenerator: req => String(req.telegramUser.id), standardHeaders: 'draft-8', legacyHeaders: false });
const webhookRateLimit = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const ADMIN_TELEGRAM_IDS = new Set(String(process.env.ADMIN_TELEGRAM_IDS || '172790098').split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id)));
function isAdminTelegramUser(id) { return ADMIN_TELEGRAM_IDS.has(String(id)); }

const databaseSslMode = String(process.env.DATABASE_SSL || (String(process.env.DATABASE_URL || '').includes('localhost') ? 'disable' : 'verify-full')).toLowerCase();
if (!['disable', 'require', 'verify-full'].includes(databaseSslMode)) throw new Error('DATABASE_SSL must be one of: disable, require, verify-full');
const databaseSsl = databaseSslMode === 'disable' ? false : { rejectUnauthorized: databaseSslMode === 'verify-full' };
// pg-connection-string URL sslmode can override the explicit TLS object; strip it so DATABASE_SSL is authoritative.
const databaseConnectionString = process.env.DATABASE_URL
  ? (() => { const url = new URL(process.env.DATABASE_URL); url.searchParams.delete('sslmode'); return url.toString(); })()
  : '';
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: databaseConnectionString,
  ssl: databaseSsl,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000
}) : null;

// Opt-in performance diagnostics. Enable with POGNALI_PERF_DIAGNOSTICS=true.
if (String(process.env.POGNALI_PERF_DIAGNOSTICS || '').toLowerCase() === 'true') {
  if (pool) {
    pool.on('error', error => console.error('[perf] postgres pool error:', error.message));
    pool.on('connect', () => console.log('[perf] pool connect', JSON.stringify({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount })));
    pool.on('remove', () => console.log('[perf] pool remove', JSON.stringify({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount })));
  }
  app.use((req, res, next) => {
    const started = performance.now();
    res.once('finish', () => {
      const elapsedMs = Math.round(performance.now() - started);
      if (elapsedMs >= 500) console.warn('[perf] slow request', JSON.stringify({
        method: req.method, path: req.path, status: res.statusCode, elapsedMs,
        pool: pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : null
      }));
    });
    next();
  });
}

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
  const inlineQuery = req.body?.inline_query;
  if (inlineQuery) {
    const query = String(inlineQuery.query || '').trim();
    const match = query.match(/^event_(\d+)(?:_i_([A-Za-z0-9_-]+))?$/);
    let results = [];
    if (match && pool) {
      try {
        const found = await pool.query("SELECT title, description, city, address, starts_at FROM events WHERE id=$1 AND status='published'", [match[1]]);
        const event = found.rows[0];
        if (event) {
          const when = event.starts_at ? new Date(event.starts_at).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }) : '';
          const place = [event.address, event.city].filter(Boolean).join(', ');
          const detail = [when, place, event.description].filter(Boolean).join(' · ').slice(0, 350);
          const caption = (['🚀 ' + event.title, 'Пойдём вместе?', [when, place].filter(Boolean).join(' · '), event.description, 'Жми «Открыть событие» и присоединяйся!'].filter(Boolean).join('\n\n')).slice(0, 1024);
          const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'Pognali_pognali_bot').replace(/^@/, '').trim();
          const startUrl = 'https://t.me/' + botUsername + '?startapp=' + encodeURIComponent(query);
          const origin = new URL(miniAppUrl).origin;
          const photoUrl = origin + '/pognali-share-cover.jpg?v=share-square-20261023';
          results = [{
            type: 'photo',
            id: 'pognali-event-' + String(match[1]),
            photo_url: photoUrl,
            thumbnail_url: photoUrl,
            photo_width: 1254,
            photo_height: 1254,
            title: '🚀 ' + String(event.title).slice(0, 120),
            description: detail || 'Пойдём вместе? Открой событие в Погнали.',
            caption,
            reply_markup: { inline_keyboard: [[{ text: 'Открыть событие', url: startUrl }]] }
          }];
        }
      } catch (error) {
        console.error('Telegram inline invitation lookup failed:', error.message);
      }
    }
    try {
      const response = await fetch('https://api.telegram.org/bot' + token + '/answerInlineQuery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inline_query_id: inlineQuery.id, results, cache_time: 0, is_personal: true })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) console.warn('Telegram inline query response failed:', response.status, result?.description || 'Telegram API returned an unsuccessful response');
    } catch (error) {
      console.error('Telegram inline query response error:', error.message);
    }
    return res.json({ ok: true });
  }
  const message = req.body?.message;
  const chatId = message?.chat?.id;
  if (!chatId) return res.json({ ok: true });
  const text = String(message.text || '');
  let replyText = 'Погнали — это приложение для реальных встреч, прогулок, спорта и других планов. Выбирай событие и присоединяйся!';
  const startParts = text.trim().split(/\s+/);
  const startPayload = String(startParts[0] || '').toLowerCase() === '/start' ? (startParts[1] || '') : '';
  const eventPayloadMatch = startPayload.match(/^event_(\d+)(?:_i_([A-Za-z0-9_-]+))?$/);
  const isEventStart = Boolean(eventPayloadMatch);
  let inviterName = '';
  if (eventPayloadMatch?.[2]) {
    try { inviterName = Buffer.from(eventPayloadMatch[2], 'base64url').toString('utf8').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40); } catch {}
  }
  const appUrl = new URL(miniAppUrl);
  if (isEventStart) { appUrl.searchParams.set('startapp', startPayload); appUrl.searchParams.set('shared_event', startPayload); }
  let replyMarkup = { inline_keyboard: [[{ text: 'Посмотреть событие', web_app: { url: appUrl.toString() } }]] };
  if (text.toLowerCase().startsWith('/start') || text.toLowerCase().startsWith('/startapp')) {
    replyText = isEventStart
      ? (inviterName ? 'Тебя пригласил(а) ' + inviterName + ' 👋 Нажми «Посмотреть событие», чтобы присоединиться.' : 'Тебя пригласили на событие 👇 Нажми кнопку «Посмотреть событие», чтобы открыть карточку.')
      : 'Не листай чужую жизнь — давай строить свою 👇';
  } else if (text.trim().toLowerCase() === '/id') {
    replyText = 'Твой Telegram ID: ' + String(message.from?.id || message.chat?.id || 'не удалось определить') + '\nСкопируй этот номер для настройки уведомлений администратора.';
  } else if (message.location) {
    replyText = 'Спасибо! Открой Погнали — там можно выбрать события рядом и поставить точку на карте.';
  }
  try {
    let notFoundStart = false;
    let response;
    if (isEventStart) {
      const eventId = eventPayloadMatch[1];
      const found = await pool.query("SELECT title, description, category, city, address, starts_at FROM events WHERE id=$1 AND status='published'", [eventId]);
      const event = found.rows[0];
      if (event) {
        const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
        const when = event.starts_at ? new Date(event.starts_at).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }) : '';
        const place = [event.address, event.city].filter(Boolean).join(', ');
        const caption = ([inviterName ? '👋 Тебя пригласил(а) ' + inviterName : '', '🚀 ' + event.title, [when, place, event.description].filter(Boolean).join('\n\n'), 'Открой карточку события и присоединяйся!'].filter(Boolean).join('\n\n')).slice(0, 1024);
        const photoUrl = new URL('/pognali-share-cover.png?v=share-square-20261023', miniAppUrl).toString();
        response = await fetch('https://api.telegram.org/bot' + token + '/sendPhoto', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, reply_markup: replyMarkup })
        });
      } else {
        notFoundStart = true;
        replyText = 'Не нашёл это событие — возможно, оно уже завершилось или удалено. Открой «Погнали» и выбери другое 👇';
      }
    }
    if (!response && !notFoundStart && (text.toLowerCase().startsWith('/start') || text.toLowerCase().startsWith('/startapp'))) {
      const welcomePhoto = new URL('/pognali-share-cover.png?v=share-square-20261023', miniAppUrl).toString();
      response = await fetch('https://api.telegram.org/bot' + token + '/sendPhoto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          photo: welcomePhoto,
          caption: '🚀 Погнали!\n\nНе листай чужую жизнь — давай строить свою.\n\nНаходи людей, выбирай планы и присоединяйся к событиям рядом.',
          reply_markup: replyMarkup
        })
      });
    }
    if (!response) {
      const isStartCommand = text.toLowerCase().startsWith('/start') || text.toLowerCase().startsWith('/startapp');
      if (isStartCommand) {
        const photoUrl = new URL('/pognali-share-cover.png?v=share-square-20261023', miniAppUrl).toString();
        response = await fetch('https://api.telegram.org/bot' + token + '/sendPhoto', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption: replyText, reply_markup: replyMarkup })
        });
      } else {
        response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: replyText, reply_markup: replyMarkup })
        });
      }
    }
    if (!response.ok) throw new Error('Telegram Bot API returned ' + response.status);
    const result = await response.json().catch(() => null);
    if (result && result.ok === false) throw new Error(result.description || 'Telegram Bot API returned an unsuccessful response');
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

let notificationWorkerTimer = null;
let notificationWorkerRunning = false;
let notificationLastRecoveryAt = 0;
async function notifyUser(chatId, messageText, key, intervalMs = 60000) {
  if (!pool || !chatId || !messageText) return false;
  const dedupeKey = key ? String(key) : null;
  let client;
  let queued = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    if (dedupeKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['telegram-notify:' + dedupeKey]);
      const recent = await client.query(
        "SELECT 1 FROM telegram_notification_dedup WHERE dedupe_key=$1 AND last_sent_at > NOW() - ($2::double precision * INTERVAL '1 millisecond')",
        [dedupeKey, Math.max(0, Number(intervalMs) || 0)]
      );
      if (recent.rowCount) {
        await client.query('COMMIT');
        return false;
      }
    }
    const count = await client.query("SELECT COUNT(*)::int AS count FROM telegram_notification_outbox WHERE status IN ('pending','sending')");
    if (count.rows[0].count >= 5000) {
      await client.query('COMMIT');
      console.warn('Telegram notification queue is full; dropping a new notification');
      return false;
    }
    const result = await client.query(
      'INSERT INTO telegram_notification_outbox (chat_id,message_text,dedupe_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',
      [String(chatId), String(messageText), dedupeKey]
    );
    queued = result.rowCount > 0;
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Could not enqueue Telegram notification:', error.message);
    return false;
  } finally {
    client?.release();
  }
  if (queued) void processTelegramNotification();
  return queued;
}
async function processTelegramNotification() {
  if (!pool || notificationWorkerRunning) return;
  notificationWorkerRunning = true;
  let job = null;
  let processed = false;
  try {
    if (Date.now() - notificationLastRecoveryAt > 30000) {
      await pool.query("UPDATE telegram_notification_outbox SET status='pending',available_at=NOW(),locked_at=NULL WHERE status='sending' AND locked_at < NOW() - INTERVAL '2 minutes'");
      notificationLastRecoveryAt = Date.now();
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT id, chat_id, message_text, dedupe_key, attempts
         FROM telegram_notification_outbox
         WHERE status='pending' AND available_at <= NOW()
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );
      if (!selected.rowCount) {
        await client.query('COMMIT');
        return;
      }
      const claimed = await client.query(
        `UPDATE telegram_notification_outbox
         SET status='sending', attempts=attempts+1, locked_at=NOW()
         WHERE id=$1
         RETURNING id, chat_id, message_text, dedupe_key, attempts`,
        [selected.rows[0].id]
      );
      job = claimed.rows[0];
      processed = true;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (!job) return;
    const delivered = await sendTelegramMessage(job.chat_id, job.message_text);
    const finish = await pool.connect();
    try {
      await finish.query('BEGIN');
      if (delivered) {
        if (job.dedupe_key) {
          await finish.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['telegram-notify:' + job.dedupe_key]);
          await finish.query(
            `INSERT INTO telegram_notification_dedup(dedupe_key,last_sent_at)
             VALUES($1,NOW())
             ON CONFLICT(dedupe_key) DO UPDATE SET last_sent_at=EXCLUDED.last_sent_at`,
            [job.dedupe_key]
          );
        }
        await finish.query('DELETE FROM telegram_notification_outbox WHERE id=$1', [job.id]);
      } else {
        await finish.query(
          `UPDATE telegram_notification_outbox
           SET status=CASE WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END,
               available_at=NOW() + (LEAST(300, 5 * POWER(2, LEAST(attempts-1, 6))) * INTERVAL '1 second'),
               locked_at=NULL,
               last_error='Telegram delivery failed'
           WHERE id=$1`,
          [job.id]
        );
      }
      await finish.query('COMMIT');
    } catch (error) {
      await finish.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      finish.release();
    }
  } catch (error) {
    console.error('Telegram notification worker failed:', error.message);
    if (job?.id && pool) {
      await pool.query(
        "UPDATE telegram_notification_outbox SET status='pending',available_at=NOW()+INTERVAL '10 seconds',locked_at=NULL,last_error='Notification worker error' WHERE id=$1 AND status='sending'",
        [job.id]
      ).catch(() => {});
    }
  } finally {
    notificationWorkerRunning = false;
    if (processed) {
      const continuation = setTimeout(() => { void processTelegramNotification(); }, 100);
      continuation.unref?.();
    }
  }
}
async function startNotificationWorker() {
  if (!pool) return;
  await pool.query(
    "UPDATE telegram_notification_outbox SET status='pending',available_at=NOW(),locked_at=NULL WHERE status='sending' AND locked_at < NOW() - INTERVAL '2 minutes'"
  );
  if (!notificationWorkerTimer) {
    notificationWorkerTimer = setInterval(() => { void processTelegramNotification(); }, 2000);
    notificationWorkerTimer.unref?.();
  }
  void processTelegramNotification();
}
async function sendTelegramMessage(chatId, text, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      console.warn('Telegram notification was not delivered:', response.status, result?.description || 'Telegram API returned an unsuccessful response');
      return false;
    }
    return true;
  } catch (error) { console.warn('Telegram notification failed:', error.message); return false; }
}

const userSeen = new Map();
const USER_SEEN_TTL_MS = 10 * 60 * 1000;
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
  const profileKey = [auth.user.username, auth.user.first_name, auth.user.last_name, auth.user.photo_url].join('\u0001');
  const seen = userSeen.get(auth.user.id);
  if (seen && seen.key === profileKey && Date.now() - seen.at < USER_SEEN_TTL_MS) return next();
  try {
    await pool.query(
      `INSERT INTO users (id, username, first_name, last_name, photo_url)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,
         first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
         photo_url=CASE WHEN users.photo_data IS NOT NULL THEN users.photo_url ELSE COALESCE(EXCLUDED.photo_url, users.photo_url) END, updated_at=NOW()`,
      [auth.user.id, auth.user.username, auth.user.first_name, auth.user.last_name, auth.user.photo_url]
    );
    if (userSeen.size > 20000) userSeen.clear();
    userSeen.set(auth.user.id, { key: profileKey, at: Date.now() });
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
  await syncTelegramProfile(pool, req.telegramUser.id, process.env.TELEGRAM_BOT_TOKEN);
  const result = await pool.query(
    'SELECT id, username, first_name, last_name, display_name, photo_url, city, bio, birth_date, birth_day, birth_month, birth_year, created_at FROM users WHERE id=$1',
    [req.telegramUser.id]
  );
  res.json({ user: { ...result.rows[0], is_admin: isAdminTelegramUser(req.telegramUser.id) } });
});

app.patch('/api/me', async (req, res) => {
  const displayName = typeof req.body.display_name === 'string' ? req.body.display_name.trim().slice(0, 80) : undefined;
  const city = typeof req.body.city === 'string' ? req.body.city.trim().slice(0, 120) : undefined;
  const bio = typeof req.body.bio === 'string' ? req.body.bio.trim().slice(0, 500) : undefined;
  const hasBirthDate = Object.prototype.hasOwnProperty.call(req.body, 'birth_date');
  let birthDate = null;
  let clearBirthDate = false;
  if (hasBirthDate) {
    const raw = req.body.birth_date;
    if (raw === null || raw === '') {
      clearBirthDate = true;
    } else if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const [year, month, day] = raw.split('-').map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      if (year < 1900 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
          parsed.getUTCDate() !== day || parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
        return res.status(400).json({ error: 'Укажи корректную дату рождения не из будущего' });
      }
      birthDate = raw;
    } else {
      return res.status(400).json({ error: 'Укажи корректную дату рождения в формате ГГГГ-ММ-ДД' });
    }
  }
  const result = await pool.query(
    `UPDATE users SET display_name=COALESCE($2, display_name), city=COALESCE($3, city), bio=COALESCE($4, bio),
     birth_date=CASE WHEN $6 THEN NULL WHEN $5::date IS NOT NULL THEN $5::date ELSE birth_date END,
     birth_day=CASE WHEN $6 THEN NULL WHEN $5::date IS NOT NULL THEN EXTRACT(DAY FROM $5::date)::smallint ELSE birth_day END,
     birth_month=CASE WHEN $6 THEN NULL WHEN $5::date IS NOT NULL THEN EXTRACT(MONTH FROM $5::date)::smallint ELSE birth_month END,
     birth_year=CASE WHEN $6 THEN NULL WHEN $5::date IS NOT NULL THEN EXTRACT(YEAR FROM $5::date)::smallint ELSE birth_year END,
     updated_at=NOW()
     WHERE id=$1 RETURNING id, username, first_name, last_name, display_name, photo_url, city, bio, birth_date, birth_day, birth_month, birth_year`,
    [req.telegramUser.id, displayName ?? null, city ?? null, bio ?? null, birthDate, clearBirthDate]
  );
  res.json({ user: result.rows[0] });
});

app.get('/media/avatars/:key', async (req, res) => {
  if (!/^[a-f0-9]{40}$/.test(req.params.key)) return res.status(404).end();
  const result = await pool.query('SELECT photo_data, photo_mime FROM users WHERE avatar_key=$1', [req.params.key]);
  const avatar = result.rows[0];
  if (!avatar?.photo_data) return res.status(404).end();
  res.set({ 'Content-Type': avatar.photo_mime || 'image/jpeg', 'Cache-Control': 'public, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.send(avatar.photo_data);
});

function normalizeEventAgeRange(value) {
  const range = typeof value === 'string' ? value.trim() : 'Любой возраст';
  const presets = new Set(['Любой возраст', '18+', '18–30', '25–40', '40+']);
  if (presets.has(range)) return range;
  const match = range.match(/^(\d{1,2})[–-](\d{1,2})$/);
  if (!match) return null;
  const min = Number(match[1]), max = Number(match[2]);
  if (min < 1 || max > 100 || min > max) return null;
  return min + '–' + max;
}

function eventAgeBounds(value) {
  const range = normalizeEventAgeRange(value) || 'Любой возраст';
  if (range === 'Любой возраст') return null;
  if (range === '18+') return { min: 18, max: null };
  if (range === '40+') return { min: 40, max: null };
  const match = range.match(/^(\d{1,2})[–-](\d{1,2})$/);
  return match ? { min: Number(match[1]), max: Number(match[2]) } : null;
}
function ageOnDate(birthDate, eventDate) {
  if (!birthDate) return null;
  const birth = new Date(String(birthDate).slice(0, 10) + 'T00:00:00Z');
  const at = new Date(eventDate);
  if (!Number.isFinite(birth.getTime()) || !Number.isFinite(at.getTime())) return null;
  let age = at.getUTCFullYear() - birth.getUTCFullYear();
  if (at.getUTCMonth() < birth.getUTCMonth() ||
      (at.getUTCMonth() === birth.getUTCMonth() && at.getUTCDate() < birth.getUTCDate())) age--;
  return age >= 0 && age <= 120 ? age : null;
}

function parseAfterMessageId(req, res) {
  if (req.query.after_id === undefined) return null;
  const raw = req.query.after_id;
  if (typeof raw !== 'string' || !/^\d{1,19}$/.test(raw) || BigInt(raw) > 9223372036854775807n) {
    res.status(400).json({ error: 'after_id must be a valid message ID' });
    return undefined;
  }
  return raw;
}

async function buildEventsPayload(city, category, limit) {
  const result = await pool.query(
    `SELECT e.*, COALESCE(u.display_name, u.first_name) AS creator_first_name, u.username AS creator_username,
       (COUNT(ep.user_id) FILTER (WHERE ep.status='joined')
         + CASE WHEN COUNT(ep.user_id) FILTER (WHERE ep.user_id=e.creator_id AND ep.status='joined') > 0 THEN 0 ELSE 1 END)::int AS participants_count
     FROM events e JOIN users u ON u.id=e.creator_id
     LEFT JOIN event_participants ep ON ep.event_id=e.id
     WHERE e.status='published' AND e.starts_at >= NOW() - INTERVAL '12 hours'
       AND ($1='' OR LOWER(e.city)=LOWER($1)) AND ($2='' OR e.category=$2)
     GROUP BY e.id, u.id ORDER BY e.starts_at ASC LIMIT $3`,
    [city, category, limit]
  );
  const json = Buffer.from(JSON.stringify({ events: result.rows }));
  const gz = await new Promise((resolve, reject) => zlib.gzip(json, { level: 6 }, (error, buffer) => error ? reject(error) : resolve(buffer)));
  const etag = 'W/"' + crypto.createHash('sha1').update(json).digest('hex').slice(0, 20) + '"';
  return { json, gz, etag };
}

app.get('/api/events', async (req, res) => {
  const city = typeof req.query.city === 'string' ? req.query.city.trim().slice(0, 120) : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim().slice(0, 40) : '';
  const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  const key = `${city.toLowerCase()}|${category}|${limit}`;
  let entry = eventsCache.get(key);
  if (EVENTS_TTL_MS === 0 || !entry || Date.now() - entry.at > EVENTS_TTL_MS) {
    entry = { at: Date.now(), payload: buildEventsPayload(city, category, limit) };
    if (eventsCache.size >= 200) eventsCache.clear();
    eventsCache.set(key, entry);
    entry.payload.catch(() => {
      if (eventsCache.get(key) === entry) eventsCache.delete(key);
    });
  }
  const { json, gz, etag } = await entry.payload;
  res.set({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding', 'Cache-Control': 'private, no-cache', ETag: etag });
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  if (req.acceptsEncodings('gzip')) {
    res.set('Content-Encoding', 'gzip');
    return res.send(gz);
  }
  return res.send(json);
});

app.get('/api/events/joined-ids', async (req, res) => {
  const mine = await pool.query(
    `SELECT ep.event_id FROM event_participants ep JOIN events e ON e.id=ep.event_id WHERE ep.user_id=$1 AND ep.status='joined' AND e.status='published' UNION SELECT id AS event_id FROM events WHERE creator_id=$1 AND status='published'`,
    [req.telegramUser.id]
  );
  res.json({ ids: mine.rows.map(row => String(row.event_id)) });
});

app.get('/api/events/:id', async (req, res) => {
  const result = await pool.query(
    `SELECT e.*, COALESCE(u.display_name, u.first_name) AS creator_first_name, u.username AS creator_username,
       (COUNT(ep.user_id) FILTER (WHERE ep.status='joined') + CASE WHEN COUNT(ep.user_id) FILTER (WHERE ep.user_id=e.creator_id AND ep.status='joined') > 0 THEN 0 ELSE 1 END)::int AS participants_count,
       (COALESCE(BOOL_OR(ep.user_id=$2 AND ep.status='joined'), FALSE) OR e.creator_id=$2) AS joined_by_me,
       EXISTS(SELECT 1 FROM event_favorites ef WHERE ef.event_id=e.id AND ef.user_id=$2) AS is_favorite,
       e.series_id, e.series_index
     FROM events e JOIN users u ON u.id=e.creator_id
     LEFT JOIN event_participants ep ON ep.event_id=e.id
     WHERE e.id=$1 AND e.status <> 'cancelled'
     GROUP BY e.id, u.id`,
    [req.params.id, req.telegramUser.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Event not found' });
  const people = await pool.query(
    `WITH viewer AS (
       SELECT (
         e.creator_id=$2 OR EXISTS (
           SELECT 1 FROM event_participants mine
           WHERE mine.event_id=e.id AND mine.user_id=$2 AND mine.status='joined'
         )
       ) AS can_view_private_profile
       FROM events e WHERE e.id=$1
     )
     SELECT u.id, u.username, u.first_name, u.last_name, u.display_name,
       CASE WHEN viewer.can_view_private_profile THEN u.photo_url ELSE NULL END AS photo_url,
       u.city, u.bio,
       NULL::date AS birth_date,
       NULL::smallint AS birth_day,
       NULL::smallint AS birth_month,
       NULL::smallint AS birth_year
     FROM event_participants ep JOIN users u ON u.id=ep.user_id
     JOIN viewer ON TRUE
     WHERE ep.event_id=$1 AND ep.status='joined' ORDER BY ep.joined_at`,
    [req.params.id, req.telegramUser.id]
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
  const startMs = startsAt.getTime();
  if (Number.isFinite(startMs) && (startMs < Date.now() - 24 * 3600 * 1000 || startMs > Date.now() + 3 * 365 * 24 * 3600 * 1000)) {
    return res.status(400).json({ error: 'starts_at must be within the next 3 years' });
  }
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
  const ageRange = normalizeEventAgeRange(b.age_range);
  if (ageRange === null) return res.status(400).json({ error: 'Invalid age_range' });
  const liveNote = typeof b.live_note === 'string' ? b.live_note.trim().slice(0,240) : '';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO events (creator_id,title,description,category,city,address,latitude,longitude,starts_at,ends_at,capacity,emoji,age_range,live_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.telegramUser.id, title, typeof b.description === 'string' ? b.description.trim().slice(0,3000) : '',
        typeof b.category === 'string' ? b.category.slice(0,40) : 'other', city, typeof b.address === 'string' ? b.address.trim().slice(0,250) : '',
        lat, lon, startsAt.toISOString(), endsAt ? endsAt.toISOString() : null, capacity,
        typeof b.emoji === 'string' ? b.emoji.trim().slice(0, 32) : '', ageRange, liveNote]
    );
    await client.query(
      `INSERT INTO event_participants (event_id,user_id,status) VALUES ($1,$2,'joined')
       ON CONFLICT (event_id,user_id) DO UPDATE SET status='joined', joined_at=NOW()`,
      [result.rows[0].id, req.telegramUser.id]
    );
    await client.query('COMMIT');
    res.status(201).json({ event: { ...result.rows[0], participants_count: 1, joined_by_me: true } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

app.patch('/api/events/:id', async (req, res) => {
  const b = req.body || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const city = typeof b.city === 'string' ? b.city.trim() : '';
  const startsAt = new Date(b.starts_at);
  const startMs = startsAt.getTime();
  if (Number.isFinite(startMs) && (startMs < Date.now() - 24 * 3600 * 1000 || startMs > Date.now() + 3 * 365 * 24 * 3600 * 1000)) {
    return res.status(400).json({ error: 'starts_at must be within the next 3 years' });
  }
  const capacity = b.capacity == null || b.capacity === '' ? null : Number(b.capacity);
  const lat = b.latitude == null || b.latitude === '' ? null : Number(b.latitude);
  const lon = b.longitude == null || b.longitude === '' ? null : Number(b.longitude);
  const endsAt = b.ends_at ? new Date(b.ends_at) : null;
  const ageRange = b.age_range === undefined ? null : normalizeEventAgeRange(b.age_range);
  const liveNote = b.live_note === undefined ? null : (typeof b.live_note === 'string' ? b.live_note.trim().slice(0,240) : null);
  if (ageRange === null && b.age_range !== undefined) return res.status(400).json({ error: 'Invalid age_range' });
  if (liveNote === null && b.live_note !== undefined) return res.status(400).json({ error: 'Invalid live_note' });
  if (title.length < 3 || title.length > 120 || !city || city.length > 120 || !Number.isFinite(startsAt.getTime())) {
    return res.status(400).json({ error: 'Title (3–120 chars), city and valid starts_at are required' });
  }
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 5000)) return res.status(400).json({ error: 'Invalid capacity' });
  if ((lat === null) !== (lon === null) || (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180))) return res.status(400).json({ error: 'Invalid map coordinates' });
  if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt < startsAt)) return res.status(400).json({ error: 'Invalid ends_at' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      "SELECT id FROM events WHERE id=$1 AND creator_id=$2 AND status='published' FOR UPDATE",
      [req.params.id, req.telegramUser.id]
    );
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found or you are not its organizer' });
    }
    if (capacity !== null) {
      const count = await client.query(
        `SELECT COUNT(*)::int + CASE WHEN EXISTS (
           SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2 AND status='joined'
         ) THEN 0 ELSE 1 END AS participants_count
         FROM event_participants WHERE event_id=$1 AND status='joined'`,
        [req.params.id, req.telegramUser.id]
      );
      if (capacity < count.rows[0].participants_count) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Нельзя установить лимит меньше текущего количества участников' });
      }
    }
    const result = await client.query(
      `UPDATE events SET title=$3, description=$4, category=$5, city=$6, address=$7,
         latitude=$8, longitude=$9, starts_at=$10, ends_at=$11, capacity=$12, emoji=$13,
         age_range=COALESCE($14,age_range), live_note=COALESCE($15,live_note), updated_at=NOW()
       WHERE id=$1 AND creator_id=$2 AND status='published' RETURNING *`,
      [req.params.id, req.telegramUser.id, title, typeof b.description === 'string' ? b.description.trim().slice(0,3000) : '',
        typeof b.category === 'string' ? b.category.slice(0,40) : 'other', city,
        typeof b.address === 'string' ? b.address.trim().slice(0,250) : '', lat, lon,
        startsAt.toISOString(), endsAt ? endsAt.toISOString() : null, capacity,
        typeof b.emoji === 'string' ? b.emoji.trim().slice(0, 32) : '', ageRange, liveNote]
    );
    await client.query('COMMIT');
    res.json({ event: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

app.patch('/api/events/:id/live-note', async (req, res) => {
  if (typeof req.body?.live_note !== 'string') return res.status(400).json({ error: 'live_note must be a string' });
  const liveNote = req.body.live_note.trim().slice(0,240);
  const result = await pool.query(
    "UPDATE events SET live_note=$3,updated_at=NOW() WHERE id=$1 AND creator_id=$2 AND status='published' RETURNING live_note",
    [req.params.id, req.telegramUser.id, liveNote]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Event not found or you are not its organizer' });
  res.json({ live_note: result.rows[0].live_note });
});

app.delete('/api/events/:id', async (req, res) => {
  if (isAdminTelegramUser(req.telegramUser.id)) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        "SELECT id,status FROM events WHERE id=$1 AND status='published' FOR UPDATE",
        [req.params.id]
      );
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Event not found or already removed' });
      }
      await client.query(
        "UPDATE events SET status='cancelled', updated_at=NOW() WHERE id=$1",
        [req.params.id]
      );
      await client.query(
        "INSERT INTO event_moderation_actions(event_id,actor_id,action,previous_status,new_status) VALUES($1,$2,'cancelled_by_moderator',$3,'cancelled')",
        [req.params.id, req.telegramUser.id, current.rows[0].status]
      );
      await client.query('COMMIT');
      res.json({ deleted: true, moderated: true, eventId: String(req.params.id) });
      return;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await client.query('SELECT id FROM events WHERE id=$1 AND creator_id=$2 FOR UPDATE', [req.params.id, req.telegramUser.id]);
    if (!event.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found or you are not its organizer' });
    }
    const existingModerationHistory = await client.query(
      `SELECT 1 FROM event_reports WHERE event_id=$1
       UNION ALL
       SELECT 1 FROM event_moderation_actions WHERE event_id=$1
       LIMIT 1`,
      [req.params.id]
    );
    const archived = existingModerationHistory.rowCount > 0;
    if (archived) {
      // Keep reported events and their moderation/audit history instead of cascading it away.
      await client.query("UPDATE events SET status='cancelled', updated_at=NOW() WHERE id=$1", [req.params.id]);
    } else {
      // message_reads uses polymorphic conversation IDs (no FK), so remove cursors before cascading event chats.
      await client.query(
        `DELETE FROM message_reads
         WHERE (conversation_type='event' AND conversation_id=$1)
            OR (conversation_type='event_contact' AND conversation_id IN (
              SELECT id FROM event_contact_conversations WHERE event_id=$1
            ))`,
        [req.params.id]
      );
      await client.query('DELETE FROM events WHERE id=$1 AND creator_id=$2', [req.params.id, req.telegramUser.id]);
    }
    await client.query('COMMIT');
    res.json({ deleted: true, moderated: false, archived, eventId: String(req.params.id) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/events/:id/finish', async (req, res) => {
  const result = await pool.query(
    `UPDATE events SET status='completed', updated_at=NOW()
     WHERE id=$1 AND creator_id=$2 AND status='published' AND starts_at <= NOW() RETURNING id`,
    [req.params.id, req.telegramUser.id]
  );
  if (!result.rowCount) {
    const owned = await pool.query(
      `SELECT 1 FROM events WHERE id=$1 AND creator_id=$2 AND status='published'`,
      [req.params.id, req.telegramUser.id]
    );
    if (!owned.rowCount) return res.status(404).json({ error: 'Event not found or you are not its organizer' });
    return res.status(409).json({ error: 'Завершить событие можно только после начала встречи' });
  }
  res.json({ finished: true, eventId: String(req.params.id) });
});

app.get('/api/events/:id/messages', async (req, res) => {
  const afterId = parseAfterMessageId(req, res);
  if (afterId === undefined) return;
  const member = await pool.query(
    `SELECT 1 FROM events e WHERE e.id=$1 AND e.status <> 'cancelled' AND (e.creator_id=$2 OR EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id=e.id AND ep.user_id=$2 AND ep.status='joined'))`,
    [req.params.id, req.telegramUser.id]
  );
  if (!member.rowCount) return res.status(403).json({ error: 'Join the event to access its chat' });
  if (afterId !== null) {
    const result = await pool.query(
      `SELECT m.id, m.event_id, m.sender_id, m.body, m.created_at,
              COALESCE(u.display_name, u.first_name) AS sender_name, u.username, u.photo_url
       FROM event_messages m JOIN users u ON u.id=m.sender_id
       WHERE m.event_id=$1 AND m.id>$2
       ORDER BY m.id ASC LIMIT 500`,
      [req.params.id, afterId]
    );
    return res.json({ messages: result.rows });
  }
  const result = await pool.query(
    `SELECT recent.id, recent.event_id, recent.sender_id, recent.body, recent.created_at,
       COALESCE(recent.display_name, recent.first_name) AS sender_name, recent.username, recent.photo_url
     FROM (
       SELECT m.id, m.event_id, m.sender_id, m.body, m.created_at,
              u.display_name, u.first_name, u.username, u.photo_url
       FROM event_messages m JOIN users u ON u.id=m.sender_id
       WHERE m.event_id=$1
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 500
     ) recent
     ORDER BY recent.created_at ASC, recent.id ASC`,
    [req.params.id]
  );
  res.json({ messages: result.rows });
});

app.post('/api/events/:id/messages', async (req, res) => {
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!body || body.length > 2000) return res.status(400).json({ error: 'Message must contain 1–2000 characters' });
  const client = await pool.connect();
  let recipients = [];
  let title = 'событие';
  try {
    await client.query('BEGIN');
    // Hold the event row until the message is committed. Leave/cancel use the same lock.
    const event = await client.query(
      `SELECT id, creator_id, title FROM events WHERE id=$1 AND status <> 'cancelled' FOR UPDATE`,
      [req.params.id]
    );
    if (!event.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Join the event to send messages' });
    }
    const member = String(event.rows[0].creator_id) === String(req.telegramUser.id)
      ? true
      : (await client.query(
          `SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2 AND status='joined'`,
          [req.params.id, req.telegramUser.id]
        )).rowCount > 0;
    if (!member) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Join the event to send messages' });
    }
    const result = await client.query(
      'INSERT INTO event_messages (event_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, event_id, sender_id, body, created_at',
      [req.params.id, req.telegramUser.id, body]
    );
    const audience = await client.query(
      `SELECT creator_id AS user_id FROM events WHERE id=$1
       UNION
       SELECT ep.user_id FROM event_participants ep WHERE ep.event_id=$1 AND ep.status='joined'`,
      [req.params.id]
    );
    recipients = audience.rows.filter(row => String(row.user_id) !== String(req.telegramUser.id));
    title = event.rows[0].title || 'событие';
    await client.query('COMMIT');
    res.status(201).json({ message: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  for (const recipient of recipients) notifyUser(recipient.user_id, '💬 Новое сообщение в чате события «' + title + '». Открой «Погнали», чтобы ответить.', 'chat:' + recipient.user_id + ':' + req.params.id, 5 * 60 * 1000);
});


function sortedUserPair(a,b){return BigInt(a)<BigInt(b)?[String(a),String(b)]:[String(b),String(a)]}
async function lockMessagingPair(client,a,b){const [low,high]=sortedUserPair(a,b);await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['messaging:'+low+':'+high]);}
async function hasMessagingBlock(a,b){const r=await pool.query("SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1",[a,b]);return r.rowCount>0}
async function readMessagingHistory(a,b,read){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await lockMessagingPair(client,a,b);
    const blocked=await client.query("SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1",[a,b]);
    if(blocked.rowCount){await client.query('ROLLBACK');return null;}
    const result=await read(client);
    await client.query('COMMIT');
    return result;
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{
    client.release();
  }
}
app.get('/api/users/search', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  if (query.length < 2) return res.json({ users: [] });
  const pattern = '%' + query.replaceAll('%', '').replaceAll('_', '') + '%';
  const result = await pool.query(
    `SELECT id, username, first_name, last_name, display_name, city
     FROM users
     WHERE id<>$1 AND (COALESCE(display_name,'') ILIKE $2 OR COALESCE(username,'') ILIKE $2 OR first_name ILIKE $2 OR last_name ILIKE $2)
     ORDER BY COALESCE(display_name, first_name) LIMIT 20`,
    [req.telegramUser.id, pattern]
  );
  res.json({ users: result.rows });
});
app.get('/api/messages/unread-count', async (req, res) => {
  const uid = req.telegramUser.id;
  const result = await pool.query(
    `SELECT (
      (SELECT COUNT(*) FROM direct_messages m
       JOIN direct_conversations c ON c.id=m.conversation_id
       WHERE (c.user_low=$1 OR c.user_high=$1) AND c.status='accepted' AND m.sender_id<>$1
         AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$1 AND ub.blocked_id=CASE WHEN c.user_low=$1 THEN c.user_high ELSE c.user_low END) OR (ub.blocker_id=CASE WHEN c.user_low=$1 THEN c.user_high ELSE c.user_low END AND ub.blocked_id=$1))
         AND m.created_at > COALESCE((SELECT r.last_read_at FROM message_reads r WHERE r.user_id=$1 AND r.conversation_type='direct' AND r.conversation_id=c.id), 'epoch'::timestamptz))
      +
      (SELECT COUNT(*) FROM event_contact_messages m
       JOIN event_contact_conversations c ON c.id=m.conversation_id
       JOIN events e ON e.id=c.event_id
       WHERE e.status <> 'cancelled' AND (c.participant_id=$1 OR c.organizer_id=$1) AND m.sender_id<>$1
         AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$1 AND ub.blocked_id=CASE WHEN c.participant_id=$1 THEN c.organizer_id ELSE c.participant_id END) OR (ub.blocker_id=CASE WHEN c.participant_id=$1 THEN c.organizer_id ELSE c.participant_id END AND ub.blocked_id=$1))
         AND m.created_at > COALESCE((SELECT r.last_read_at FROM message_reads r WHERE r.user_id=$1 AND r.conversation_type='event_contact' AND r.conversation_id=c.id), 'epoch'::timestamptz))
      +
      (SELECT COUNT(*)::int FROM (
         SELECT 1 FROM event_messages m JOIN events e ON e.id=m.event_id
         WHERE e.status <> 'cancelled' AND m.sender_id<>$1
           AND (e.creator_id=$1 OR EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id=e.id AND ep.user_id=$1 AND ep.status='joined'))
           AND m.created_at > COALESCE((SELECT r.last_read_at FROM message_reads r WHERE r.user_id=$1 AND r.conversation_type='event' AND r.conversation_id=e.id), 'epoch'::timestamptz)
         LIMIT 9900) event_unread)
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
    const r = await pool.query("SELECT 1 FROM events e WHERE e.id=$1 AND e.status <> 'cancelled' AND (e.creator_id=$2 OR EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id=e.id AND ep.user_id=$2 AND ep.status='joined'))", [id, uid]);
    allowed = r.rowCount > 0;
  } else if (type === 'direct') {
    const r = await pool.query("SELECT 1 FROM direct_conversations c WHERE c.id=$1 AND c.status='accepted' AND (c.user_low=$2 OR c.user_high=$2) AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$2 AND ub.blocked_id=CASE WHEN c.user_low=$2 THEN c.user_high ELSE c.user_low END) OR (ub.blocker_id=CASE WHEN c.user_low=$2 THEN c.user_high ELSE c.user_low END AND ub.blocked_id=$2))", [id, uid]);
    allowed = r.rowCount > 0;
  } else {
    const r = await pool.query("SELECT 1 FROM event_contact_conversations c JOIN events e ON e.id=c.event_id WHERE c.id=$1 AND e.status <> 'cancelled' AND (c.participant_id=$2 OR c.organizer_id=$2) AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$2 AND ub.blocked_id=CASE WHEN c.participant_id=$2 THEN c.organizer_id ELSE c.participant_id END) OR (ub.blocker_id=CASE WHEN c.participant_id=$2 THEN c.organizer_id ELSE c.participant_id END AND ub.blocked_id=$2))", [id, uid]);
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
pool.query("SELECT c.id,c.status,c.requested_by,c.updated_at,CASE WHEN c.user_low=$1 THEN c.user_high ELSE c.user_low END AS other_user_id,COALESCE(u.display_name,u.first_name) AS other_name,u.username,(SELECT body FROM direct_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,(SELECT COUNT(*)::int FROM direct_messages um WHERE um.conversation_id=c.id AND um.sender_id<>$1 AND um.created_at>COALESCE((SELECT mr.last_read_at FROM message_reads mr WHERE mr.user_id=$1 AND mr.conversation_type='direct' AND mr.conversation_id=c.id),'epoch'::timestamptz)) AS unread_count FROM direct_conversations c JOIN users u ON u.id=CASE WHEN c.user_low=$1 THEN c.user_high ELSE c.user_low END WHERE (c.user_low=$1 OR c.user_high=$1) AND (c.status<>'rejected' OR c.requested_by=$1) AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$1 AND ub.blocked_id=CASE WHEN c.user_low=$1 THEN c.user_high ELSE c.user_low END) OR (ub.blocker_id=CASE WHEN c.user_low=$1 THEN c.user_high ELSE c.user_low END AND ub.blocked_id=$1)) ORDER BY c.updated_at DESC LIMIT 100",[uid]),
pool.query("SELECT c.id,c.event_id,c.participant_id,c.organizer_id,c.updated_at,e.title AS event_title,CASE WHEN c.participant_id=$1 THEN c.organizer_id ELSE c.participant_id END AS other_user_id,COALESCE(u.display_name,u.first_name,u.username,'Участник') AS other_name,(SELECT body FROM event_contact_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,(SELECT COUNT(*)::int FROM event_contact_messages um WHERE um.conversation_id=c.id AND um.sender_id<>$1 AND um.created_at>COALESCE((SELECT mr.last_read_at FROM message_reads mr WHERE mr.user_id=$1 AND mr.conversation_type='event_contact' AND mr.conversation_id=c.id),'epoch'::timestamptz)) AS unread_count FROM event_contact_conversations c JOIN events e ON e.id=c.event_id JOIN users u ON u.id=CASE WHEN c.participant_id=$1 THEN c.organizer_id ELSE c.participant_id END WHERE e.status <> 'cancelled' AND (c.participant_id=$1 OR c.organizer_id=$1) AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$1 AND ub.blocked_id=CASE WHEN c.participant_id=$1 THEN c.organizer_id ELSE c.participant_id END) OR (ub.blocker_id=CASE WHEN c.participant_id=$1 THEN c.organizer_id ELSE c.participant_id END AND ub.blocked_id=$1)) ORDER BY c.updated_at DESC LIMIT 100",[uid]),
pool.query("SELECT e.id AS event_id,e.title,e.starts_at,e.updated_at,(SELECT body FROM event_messages m WHERE m.event_id=e.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,(SELECT COUNT(*)::int FROM (SELECT 1 FROM event_messages um WHERE um.event_id=e.id AND um.sender_id<>$1 AND um.created_at>COALESCE((SELECT mr.last_read_at FROM message_reads mr WHERE mr.user_id=$1 AND mr.conversation_type='event' AND mr.conversation_id=e.id),'epoch'::timestamptz) LIMIT 99) q) AS unread_count FROM events e WHERE (e.creator_id=$1 OR EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id=e.id AND ep.user_id=$1 AND ep.status='joined')) AND e.status<>'cancelled' ORDER BY COALESCE((SELECT MAX(m.created_at) FROM event_messages m WHERE m.event_id=e.id),e.updated_at) DESC LIMIT 100",[uid])]);res.json({direct:direct.rows,eventContacts:contacts.rows,eventChats:eventChats.rows})});
app.post('/api/direct/requests', async (req, res) => {
  const target=String(req.body&&req.body.user_id||''),actor=String(req.telegramUser.id);
  if(!target||target.length>20||![...target].every(ch=>ch>='0'&&ch<='9')||BigInt(target)<=0n)return res.status(400).json({error:'A valid user_id is required'});
  if(target===actor)return res.status(400).json({error:'You cannot message yourself'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');await lockMessagingPair(client,actor,target);
    const user=await client.query('SELECT id FROM users WHERE id=$1',[target]);
    if(!user.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'User not found'});}
    const blocked=await client.query("SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1",[actor,target]);
    if(blocked.rowCount){await client.query('ROLLBACK');return res.status(403).json({error:'Messaging is unavailable between these users'});}
    const [low,high]=sortedUserPair(actor,target);
    const created=await client.query("INSERT INTO direct_conversations(user_low,user_high,requested_by,status) VALUES($1,$2,$3,'pending') ON CONFLICT(user_low,user_high) DO UPDATE SET requested_by=EXCLUDED.requested_by,status='pending',updated_at=NOW() WHERE direct_conversations.status='rejected' AND direct_conversations.requested_by<>EXCLUDED.requested_by RETURNING id,status,requested_by",[low,high,actor]);
    if(created.rowCount){await client.query('COMMIT');const conversation=created.rows[0];res.status(201).json({conversation});notifyUser(target,'✉️ Тебе отправили запрос на личную переписку в «Погнали». Открой приложение, чтобы принять или отклонить его.','dm-request:'+target+':'+conversation.id,60000);return;}
    const existing=await client.query('SELECT id,status,requested_by FROM direct_conversations WHERE user_low=$1 AND user_high=$2',[low,high]);
    await client.query('COMMIT');
    if(existing.rows[0]?.status==='accepted')return res.json({conversation:existing.rows[0],alreadyAccepted:true});
    if(existing.rows[0]?.status==='pending')return res.json({conversation:existing.rows[0],requestPending:true});
    return res.status(403).json({error:'The other user must initiate a new request'});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
});
app.post('/api/direct/:id/respond', async (req, res) => {
  const decision = req.body && req.body.decision;
  const status = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : '';
  if (!status) return res.status(400).json({ error: 'decision must be accept or reject' });
  const client = await pool.connect();
  let conversation;
  try {
    await client.query('BEGIN');
    const pending = await client.query(
      "SELECT user_low,user_high FROM direct_conversations WHERE id=$1 AND (user_low=$2 OR user_high=$2) AND requested_by<>$2 AND status='pending'",
      [req.params.id, req.telegramUser.id]
    );
    if (!pending.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending request not found' });
    }
    const other = String(pending.rows[0].user_low) === String(req.telegramUser.id)
      ? pending.rows[0].user_high : pending.rows[0].user_low;
    // Acquire the pair lock before locking the conversation row, matching
    // the lock order used by request creation and block/unblock.
    await lockMessagingPair(client, req.telegramUser.id, other);
    const lockedPending = await client.query(
      "SELECT id FROM direct_conversations WHERE id=$1 AND (user_low=$2 OR user_high=$2) AND requested_by<>$2 AND status='pending' FOR UPDATE",
      [req.params.id, req.telegramUser.id]
    );
    if (!lockedPending.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending request not found' });
    }
    const blocked = await client.query(
      "SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1",
      [req.telegramUser.id, other]
    );
    if (blocked.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Messaging is unavailable between these users' });
    }
    const result = await client.query(
      "UPDATE direct_conversations SET status=$2,updated_at=NOW() WHERE id=$1 AND (user_low=$3 OR user_high=$3) AND requested_by<>$3 AND status='pending' RETURNING id,status,requested_by",
      [req.params.id, status, req.telegramUser.id]
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending request not found' });
    }
    conversation = result.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  res.json({ conversation: { id: conversation.id, status: conversation.status } });
  const notice = status === 'accepted'
    ? '✓ Твой запрос на личную переписку в «Погнали» принят. Теперь можно общаться.'
    : 'Твой запрос на личную переписку в «Погнали» отклонён.';
  notifyUser(conversation.requested_by, notice, 'dm-response:' + conversation.requested_by + ':' + conversation.id + ':' + status, 60000);
});
app.get('/api/direct/:id/messages', async (req, res) => {
  const afterId = parseAfterMessageId(req, res);
  if (afterId === undefined) return;
  const conversation = await pool.query(
    'SELECT id,status,user_low,user_high,requested_by FROM direct_conversations WHERE id=$1 AND (user_low=$2 OR user_high=$2)',
    [req.params.id, req.telegramUser.id]
  );
  if (!conversation.rowCount) return res.status(404).json({ error: 'Conversation not found' });
  const row = conversation.rows[0];
  if (row.status !== 'accepted') {
    if (row.status === 'pending' && String(row.requested_by) !== String(req.telegramUser.id)) {
      return res.json({ messages: [], request: row });
    }
    return res.status(403).json({ error: 'Personal messages require mutual consent' });
  }
  const other = String(row.user_low) === String(req.telegramUser.id) ? row.user_high : row.user_low;
  const result = await readMessagingHistory(req.telegramUser.id, other, async client => {
    if (afterId !== null) {
      const messages = await client.query(
        `SELECT m.id, m.sender_id, m.body, m.created_at,
                COALESCE(u.display_name, u.first_name) AS sender_name
         FROM direct_messages m JOIN users u ON u.id=m.sender_id
         WHERE m.conversation_id=$1 AND m.id>$2
         ORDER BY m.id ASC LIMIT 500`,
        [req.params.id, afterId]
      );
      return { messages: messages.rows };
    }
    const messages = await client.query(
      `SELECT recent.id, recent.sender_id, recent.body, recent.created_at,
              COALESCE(recent.display_name, recent.first_name) AS sender_name
       FROM (
         SELECT m.id, m.sender_id, m.body, m.created_at, u.display_name, u.first_name
         FROM direct_messages m JOIN users u ON u.id=m.sender_id
         WHERE m.conversation_id=$1
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 500
       ) recent
       ORDER BY recent.created_at ASC, recent.id ASC`,
      [req.params.id]
    );
    return { messages: messages.rows };
  });
  if (result === null) return res.status(403).json({ error: 'Messaging is unavailable between these users' });
  res.json(result);
});
app.post('/api/direct/:id/messages',async(req,res)=>{const body=typeof(req.body&&req.body.body)==='string'?req.body.body.trim():'';if(!body||body.length>2000)return res.status(400).json({error:'Message must contain 1–2000 characters'});const actor=String(req.telegramUser.id),client=await pool.connect();let other;try{await client.query('BEGIN');const c=await client.query("SELECT id,user_low,user_high FROM direct_conversations WHERE id=$1 AND status='accepted' AND (user_low=$2 OR user_high=$2)",[req.params.id,actor]);if(!c.rowCount){await client.query('ROLLBACK');return res.status(403).json({error:'Personal messages require mutual consent'});}other=String(c.rows[0].user_low)===actor?String(c.rows[0].user_high):String(c.rows[0].user_low);await lockMessagingPair(client,actor,other);const blocked=await client.query("SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1",[actor,other]);if(blocked.rowCount){await client.query('ROLLBACK');return res.status(403).json({error:'Messaging is unavailable between these users'});}const r=await client.query('INSERT INTO direct_messages(conversation_id,sender_id,body) VALUES($1,$2,$3) RETURNING id,sender_id,body,created_at',[req.params.id,actor,body]);await client.query('UPDATE direct_conversations SET updated_at=NOW() WHERE id=$1',[req.params.id]);await client.query('COMMIT');res.status(201).json({message:r.rows[0]});}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}notifyUser(other,'💬 Новое личное сообщение в «Погнали». Открой приложение, чтобы ответить.','dm:'+other+':'+req.params.id,60000)});
app.get('/api/users/blocked',async(req,res)=>{
  const result=await pool.query(
    `SELECT u.id,u.username,u.first_name,u.last_name,u.display_name,u.city,ub.created_at AS blocked_at
     FROM user_blocks ub JOIN users u ON u.id=ub.blocked_id
     WHERE ub.blocker_id=$1 ORDER BY ub.created_at DESC,u.id DESC LIMIT 200`,
    [req.telegramUser.id]
  );
  res.json({users:result.rows});
});
app.post('/api/users/:id/block',async(req,res)=>{
  const target=String(req.params.id),actor=String(req.telegramUser.id);
  if(target===actor)return res.status(400).json({error:'You cannot block yourself'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await lockMessagingPair(client,actor,target);
    const user=await client.query('SELECT id FROM users WHERE id=$1',[target]);
    if(!user.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'User not found'});}
    await client.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor,target]);
    await client.query('COMMIT');
    res.json({blocked:true});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
});
app.delete('/api/users/:id/block',async(req,res)=>{
  const target=String(req.params.id),actor=String(req.telegramUser.id);
  if(target===actor)return res.status(400).json({error:'You cannot unblock yourself'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await lockMessagingPair(client,actor,target);
    const result=await client.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2',[actor,target]);
    await client.query('COMMIT');
    res.json({blocked:false,unblocked:result.rowCount>0});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
});
app.get('/api/messages/organized-events',async(req,res)=>{const uid=req.telegramUser.id;const r=await pool.query("SELECT e.id AS event_id,e.title,e.starts_at,ep.user_id AS participant_id,COALESCE(u.display_name,u.first_name,u.username,'Участник') AS participant_name,u.username FROM events e JOIN event_participants ep ON ep.event_id=e.id AND ep.status='joined' JOIN users u ON u.id=ep.user_id WHERE e.creator_id=$1 AND e.status='published' AND ep.user_id<>$1 ORDER BY e.starts_at DESC,COALESCE(u.display_name,u.first_name) LIMIT 300",[uid]);res.json({participants:r.rows})});
app.post('/api/events/:id/participants/:participantId/contact',async(req,res)=>{const eventId=String(req.params.id||''),participant=String(req.params.participantId||''),organizer=String(req.telegramUser.id);if(!/^[1-9]\d{0,18}$/.test(eventId)||!/^[1-9]\d{0,18}$/.test(participant)||participant===organizer)return res.status(400).json({error:'Некорректный участник или событие'});const e=await pool.query("SELECT id,title FROM events WHERE id=$1 AND creator_id=$2 AND status='published'",[eventId,organizer]);if(!e.rowCount)return res.status(403).json({error:'Только организатор может написать участнику своей встречи'});const member=await pool.query("SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2 AND status='joined'",[eventId,participant]);if(!member.rowCount)return res.status(404).json({error:'Участник больше не записан на эту встречу'});if(await hasMessagingBlock(organizer,participant))return res.status(403).json({error:'Переписка между пользователями недоступна'});const r=await pool.query('INSERT INTO event_contact_conversations(event_id,participant_id,organizer_id) VALUES($1,$2,$3) ON CONFLICT(event_id,participant_id) DO UPDATE SET updated_at=NOW() RETURNING id,event_id,participant_id,organizer_id',[eventId,participant,organizer]);res.status(201).json({conversation:r.rows[0],eventTitle:e.rows[0].title})});
app.post('/api/events/:id/contact',async(req,res)=>{const e=await pool.query("SELECT id,creator_id,title FROM events WHERE id=$1 AND status='published'",[req.params.id]);if(!e.rowCount)return res.status(404).json({error:'Event not found or no longer available'});const organizer=String(e.rows[0].creator_id),participant=String(req.telegramUser.id);if(organizer===participant)return res.status(400).json({error:'You are the organizer of this event'});if(await hasMessagingBlock(participant,organizer))return res.status(403).json({error:'Messaging is unavailable between these users'});const r=await pool.query('INSERT INTO event_contact_conversations(event_id,participant_id,organizer_id) VALUES($1,$2,$3) ON CONFLICT(event_id,participant_id) DO UPDATE SET updated_at=NOW() RETURNING id,event_id,participant_id,organizer_id',[req.params.id,participant,organizer]);res.status(201).json({conversation:r.rows[0],eventTitle:e.rows[0].title})});
app.post('/api/event-contacts/:id/age-approval', async (req,res) => {
  const organizer=String(req.telegramUser.id);
  const conversation=await pool.query(
    `SELECT c.id,c.event_id,c.participant_id,c.organizer_id,e.age_range,e.status,e.title
     FROM event_contact_conversations c JOIN events e ON e.id=c.event_id
     WHERE c.id=$1 AND c.organizer_id=$2 AND e.status='published'`,
    [req.params.id,organizer]
  );
  if(!conversation.rowCount)return res.status(403).json({error:'Только организатор этого события может разрешить участие'});
  const row=conversation.rows[0];
  if(!eventAgeBounds(row.age_range))return res.status(400).json({error:'Для этого события возрастное исключение не требуется'});
  await pool.query(
    `INSERT INTO event_age_approvals(event_id,user_id,approved_by)
     VALUES($1,$2,$3) ON CONFLICT(event_id,user_id)
     DO UPDATE SET approved_by=EXCLUDED.approved_by,approved_at=NOW()`,
    [row.event_id,row.participant_id,organizer]
  );
  notifyUser(row.participant_id, 'Организатор разрешил тебе присоединиться к событию «' + row.title + '». Открой переписку и нажми «Присоединиться».', 'age-approval:' + row.event_id + ':' + row.participant_id, 30000);
  res.json({approved:true,event_id:String(row.event_id),user_id:String(row.participant_id)});
});
app.get('/api/event-contacts/:id/messages', async (req, res) => {
  const afterId = parseAfterMessageId(req, res);
  if (afterId === undefined) return;
  const conversation = await pool.query(
    `SELECT c.id,c.event_id,c.participant_id,c.organizer_id,
              EXISTS(SELECT 1 FROM event_age_approvals a WHERE a.event_id=c.event_id AND a.user_id=c.participant_id) AS age_approved
       FROM event_contact_conversations c JOIN events e ON e.id=c.event_id
       WHERE c.id=$1 AND e.status <> 'cancelled' AND (c.participant_id=$2 OR c.organizer_id=$2)`,
    [req.params.id, req.telegramUser.id]
  );
  if (!conversation.rowCount) return res.status(404).json({ error: 'Conversation not found' });
  const row = conversation.rows[0];
  const other = String(row.participant_id) === String(req.telegramUser.id) ? row.organizer_id : row.participant_id;
  const result = await readMessagingHistory(req.telegramUser.id, other, async client => {
    if (afterId !== null) {
      const messages = await client.query(
        `SELECT m.id, m.sender_id, m.body, m.created_at,
                COALESCE(u.display_name, u.first_name) AS sender_name
         FROM event_contact_messages m JOIN users u ON u.id=m.sender_id
         WHERE m.conversation_id=$1 AND m.id>$2
         ORDER BY m.id ASC LIMIT 500`,
        [req.params.id, afterId]
      );
      return { messages: messages.rows, conversation: row };
    }
    const messages = await client.query(
      `SELECT recent.id, recent.sender_id, recent.body, recent.created_at,
              COALESCE(recent.display_name, recent.first_name) AS sender_name
       FROM (
         SELECT m.id, m.sender_id, m.body, m.created_at, u.display_name, u.first_name
         FROM event_contact_messages m JOIN users u ON u.id=m.sender_id
         WHERE m.conversation_id=$1
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 500
       ) recent
       ORDER BY recent.created_at ASC, recent.id ASC`,
      [req.params.id]
    );
    return { messages: messages.rows, conversation: row };
  });
  if (result === null) return res.status(403).json({ error: 'Messaging is unavailable between these users' });
  res.json(result);
});
app.post('/api/event-contacts/:id/messages',async(req,res)=>{const body=typeof(req.body&&req.body.body)==='string'?req.body.body.trim():'';if(!body||body.length>2000)return res.status(400).json({error:'Message must contain 1–2000 characters'});const actor=String(req.telegramUser.id),client=await pool.connect();let other;try{await client.query('BEGIN');const c=await client.query(`SELECT c.id,c.participant_id,c.organizer_id FROM event_contact_conversations c JOIN events e ON e.id=c.event_id WHERE c.id=$1 AND e.status <> 'cancelled' AND (c.participant_id=$2 OR c.organizer_id=$2)`,[req.params.id,actor]);if(!c.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Conversation not found'});}const row=c.rows[0];other=String(row.participant_id)===actor?String(row.organizer_id):String(row.participant_id);await lockMessagingPair(client,actor,other);const blocked=await client.query("SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1",[actor,other]);if(blocked.rowCount){await client.query('ROLLBACK');return res.status(403).json({error:'Messaging is unavailable between these users'});}const r=await client.query('INSERT INTO event_contact_messages(conversation_id,sender_id,body) VALUES($1,$2,$3) RETURNING id,sender_id,body,created_at',[req.params.id,actor,body]);await client.query('UPDATE event_contact_conversations SET updated_at=NOW() WHERE id=$1',[req.params.id]);await client.query('COMMIT');res.status(201).json({message:r.rows[0]});}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}notifyUser(other,'💬 Новое сообщение по событию в «Погнали». Открой приложение, чтобы ответить.','ec:'+other+':'+req.params.id,60000)});

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
  const event = await pool.query('SELECT id, creator_id, status, title, city FROM events WHERE id = $1', [req.params.id]);
  if (!event.rowCount || event.rows[0].status !== 'published') return res.status(404).json({ error: 'Event not found' });
  if (String(event.rows[0].creator_id) === String(req.telegramUser.id)) return res.status(400).json({ error: 'You cannot report your own event' });
  // One report per user/event. A repeat request must not silently reopen a resolved
  // report, rewrite its evidence, or generate another moderator notification.
  const result = await pool.query(
    'INSERT INTO event_reports (event_id, reporter_id, reason, details) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id, reporter_id) DO NOTHING RETURNING id',
    [req.params.id, req.telegramUser.id, reason, details || null]
  );
  if (!result.rowCount) {
    const existing = await pool.query(
      'SELECT id, status FROM event_reports WHERE event_id=$1 AND reporter_id=$2',
      [req.params.id, req.telegramUser.id]
    );
    if (!existing.rowCount) return res.status(409).json({ error: 'Could not save report; please try again' });
    return res.status(200).json({ reported: true, alreadyReported: true, reportId: existing.rows[0].id, status: existing.rows[0].status });
  }
  const reportId = result.rows[0].id;
  const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (adminChatId) {
    const reporter = req.telegramUser.username ? '@' + req.telegramUser.username : [req.telegramUser.first_name, req.telegramUser.last_name].filter(Boolean).join(' ') || String(req.telegramUser.id);
    const reasonLabels = { spam: 'Спам или реклама', fake: 'Обман или фальшивое событие', inappropriate: 'Неприемлемый контент', unsafe: 'Опасное событие', other: 'Другое' };
    const note = '🚨 Новая жалоба на событие\n' + 'Жалоба №' + reportId + '\n' + 'Событие: ' + (event.rows[0]?.title || ('#' + req.params.id)) + '\n' + 'Город: ' + (event.rows[0]?.city || 'не указан') + '\n' + 'Причина: ' + reasonLabels[reason] + '\n' + 'От: ' + reporter + '\n' + (details ? 'Подробности: ' + details.slice(0, 700) + '\n' : '') + 'Статус: open';
    void notifyUser(adminChatId, note, 'event-report:' + reportId, 0).then(queued => { if (!queued) console.warn('Admin report notification was not queued; check ADMIN_TELEGRAM_CHAT_ID and notification outbox health.'); });
  } else {
    console.warn('Report saved without Telegram notification: ADMIN_TELEGRAM_CHAT_ID is not configured.');
  }
  res.status(201).json({ reported: true, reportId });
});

app.post('/api/events/:id/prepare-share', async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const miniAppUrl = process.env.MINI_APP_URL;
  if (!botToken || !miniAppUrl || !miniAppUrl.startsWith('https://')) {
    return res.status(503).json({ error: 'Telegram sharing is not configured' });
  }
  const eventResult = await pool.query(
    `SELECT e.id, e.title, e.description, e.city, e.address, e.starts_at,
       COALESCE(u.display_name, u.first_name, 'Друг') AS inviter_name
     FROM events e LEFT JOIN users u ON u.id=$2
     WHERE e.id=$1 AND e.status='published'`,
    [req.params.id, req.telegramUser.id]
  );
  if (!eventResult.rowCount) return res.status(404).json({ error: 'Событие не найдено или больше недоступно.' });
  const event = eventResult.rows[0];
  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'Pognali_pognali_bot').replace(/^@/, '').trim();
  const inviter = String(event.inviter_name || 'Друг').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().split(/\s+/)[0].slice(0, 18);
  const inviterPayload = Buffer.from(inviter, 'utf8').toString('base64url');
  const startPayload = 'event_' + String(event.id) + (inviterPayload ? '_i_' + inviterPayload : '');
  const startUrl = 'https://t.me/' + botUsername + '?startapp=' + encodeURIComponent(startPayload);
  const when = event.starts_at ? new Date(event.starts_at).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }) : '';
  const place = [event.address, event.city].filter(Boolean).join(', ');
  const details = [when, place, event.description].filter(Boolean).join(' · ').slice(0, 300);
  const caption = (['🚀 ' + event.title, 'Пойдём вместе?', [when, place].filter(Boolean).join(' · '), event.description, 'Жми «Открыть событие» и присоединяйся!'].filter(Boolean).join('\n\n')).slice(0, 1024);
  const photoUrl = new URL('/pognali-share-cover.png?v=share-square-20261023', miniAppUrl).toString();
  const preparedResult = {
    type: 'photo',
    id: 'pognali-event-' + String(event.id) + '-' + Date.now(),
    photo_url: photoUrl,
    thumbnail_url: photoUrl,
    photo_width: 1254,
    photo_height: 1254,
    title: ('🚀 ' + event.title).slice(0, 120),
    description: details || 'Пойдём вместе? Открой событие в Погнали.',
    caption,
    reply_markup: { inline_keyboard: [[{ text: 'Открыть событие', url: startUrl }]] }
  };
  try {
    const response = await fetch('https://api.telegram.org/bot' + botToken + '/savePreparedInlineMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: req.telegramUser.id,
        result: preparedResult,
        allow_user_chats: true,
        allow_group_chats: true
      })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !payload?.result?.id) {
      console.warn('Telegram prepared invitation failed:', response.status, payload?.description || 'Telegram API returned an unsuccessful response');
      return res.status(502).json({ error: 'Не удалось подготовить приглашение через Telegram.' });
    }
    res.json({ id: payload.result.id, eventId: String(event.id) });
  } catch (error) {
    console.error('Telegram prepared invitation error:', error.message);
    res.status(502).json({ error: 'Не удалось подготовить приглашение через Telegram.' });
  }
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


app.get('/api/favorites', async (req, res) => {
  const result = await pool.query(
    `SELECT e.*, COALESCE(u.display_name,u.first_name) AS creator_first_name,
       (COUNT(ep.user_id) FILTER (WHERE ep.status='joined')
         + CASE WHEN COUNT(ep.user_id) FILTER (WHERE ep.user_id=e.creator_id AND ep.status='joined') > 0 THEN 0 ELSE 1 END)::int AS participants_count
     FROM event_favorites f JOIN events e ON e.id=f.event_id
     JOIN users u ON u.id=e.creator_id
     LEFT JOIN event_participants ep ON ep.event_id=e.id
     WHERE f.user_id=$1 AND e.status <> 'cancelled'
     GROUP BY e.id,u.id ORDER BY MAX(f.created_at) DESC LIMIT 200`,
    [req.telegramUser.id]
  );
  res.json({ events: result.rows });
});

app.post('/api/events/:id/favorite', async (req, res) => {
  const event = await pool.query("SELECT id FROM events WHERE id=$1 AND status='published'", [req.params.id]);
  if (!event.rowCount) return res.status(404).json({ error: 'Событие недоступно' });
  await pool.query('INSERT INTO event_favorites(event_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.params.id, req.telegramUser.id]);
  res.json({ favorite: true });
});

app.delete('/api/events/:id/favorite', async (req, res) => {
  await pool.query('DELETE FROM event_favorites WHERE event_id=$1 AND user_id=$2', [req.params.id, req.telegramUser.id]);
  res.json({ favorite: false });
});

app.get('/api/me/activity', async (req, res) => {
  const result = await pool.query(
    `SELECT e.id,e.title,e.category,e.emoji,e.city,e.address,e.starts_at,e.ends_at,e.status,e.creator_id,
       CASE WHEN e.creator_id=$1 THEN 'organizer' ELSE 'participant' END AS my_role,
       (COUNT(ep.user_id) FILTER (WHERE ep.status='joined')
       + CASE WHEN COUNT(ep.user_id) FILTER (WHERE ep.user_id=e.creator_id AND ep.status='joined') > 0 THEN 0 ELSE 1 END)::int AS participants_count
     FROM events e LEFT JOIN event_participants ep ON ep.event_id=e.id
     WHERE e.status <> 'cancelled' AND (e.creator_id=$1 OR EXISTS(
       SELECT 1 FROM event_participants mine WHERE mine.event_id=e.id AND mine.user_id=$1 AND mine.status='joined'))
     GROUP BY e.id ORDER BY e.starts_at DESC LIMIT 300`,
    [req.telegramUser.id]
  );
  res.json({ events: result.rows });
});

app.post('/api/events/:id/join', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await client.query('SELECT id, creator_id, capacity, status, starts_at, ends_at, age_range FROM events WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!event.rowCount || event.rows[0].status !== 'published') {
      await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' });
    }
    const ageBounds=eventAgeBounds(event.rows[0].age_range);
    if(ageBounds && String(event.rows[0].creator_id)!==String(req.telegramUser.id)){
      const approved=await client.query('SELECT 1 FROM event_age_approvals WHERE event_id=$1 AND user_id=$2',[req.params.id,req.telegramUser.id]);
      if(!approved.rowCount){
        const profile=await client.query('SELECT birth_date FROM users WHERE id=$1',[req.telegramUser.id]);
        const age=ageOnDate(profile.rows[0]?.birth_date,event.rows[0].starts_at);
        if(age===null || age<ageBounds.min || (ageBounds.max!==null && age>ageBounds.max)){
          await client.query('ROLLBACK');
          return res.status(403).json({
            code:'AGE_RESTRICTION',
            error:age===null?'Укажи дату рождения в профиле или попроси организатора разрешить участие.':'Возраст не совпадает с условием события. Напиши организатору — он может разрешить исключение.',
            age_range:event.rows[0].age_range
          });
        }
      }
    }
    const startMs = new Date(event.rows[0].starts_at).getTime();
    const endMs = event.rows[0].ends_at
      ? new Date(event.rows[0].ends_at).getTime()
      : startMs + 180 * 60 * 1000;
    if (Date.now() >= endMs) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Событие уже завершено, присоединиться нельзя' });
    }
    const source = ['share','organic'].includes(req.body?.source) ? req.body.source : 'organic';
    const existing = await client.query(
      `SELECT status FROM event_participants WHERE event_id=$1 AND user_id=$2`,
      [req.params.id, req.telegramUser.id]
    );
    if (existing.rows[0]?.status !== 'joined' && event.rows[0].capacity !== null) {
      const count = await client.query(`SELECT COUNT(*)::int + CASE WHEN EXISTS (SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2 AND status='joined') THEN 0 ELSE 1 END AS n FROM event_participants WHERE event_id=$1 AND status='joined'`, [req.params.id, event.rows[0].creator_id]);
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
      notifyUser(eventInfo.rows[0].creator_id, '👋 На событие «' + eventInfo.rows[0].title + '» записался новый участник. Открой «Погнали», чтобы посмотреть участников.', 'join:' + eventInfo.rows[0].creator_id + ':' + req.params.id, 30000);
    }
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
});

app.post('/api/events/:id/leave', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize leave with join, chat sends and event cancellation.
    const event = await client.query('SELECT creator_id FROM events WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!event.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    if (String(event.rows[0].creator_id) === String(req.telegramUser.id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Организатор не может выйти из своего события. Заверши или удали его.' });
    }
    const result = await client.query(
      `UPDATE event_participants SET status='left' WHERE event_id=$1 AND user_id=$2 AND status='joined'`,
      [req.params.id, req.telegramUser.id]
    );
    await client.query('COMMIT');
    res.json({ left: result.rowCount > 0, eventId: String(req.params.id) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

app.get('/api/my/events', async (req, res) => {
  const result = await pool.query(
    `SELECT e.*, COALESCE(ep.status, 'joined') AS my_status,
       (COUNT(allp.user_id) FILTER (WHERE allp.status='joined') + CASE WHEN COUNT(allp.user_id) FILTER (WHERE allp.user_id=e.creator_id AND allp.status='joined') > 0 THEN 0 ELSE 1 END)::int AS participants_count
     FROM events e
     LEFT JOIN event_participants ep ON ep.event_id=e.id AND ep.user_id=$1 AND ep.status='joined'
     LEFT JOIN event_participants allp ON allp.event_id=e.id
     WHERE e.status='published' AND (e.creator_id=$1 OR ep.user_id IS NOT NULL)
     GROUP BY e.id, ep.status ORDER BY e.starts_at ASC`,
    [req.telegramUser.id]
  );
  res.json({ events: result.rows });
});

// Moderation API: requires both a valid Telegram session and a separately configured admin token.
function requireAdmin(req, res, next) {
  if (!isAdminTelegramUser(req.telegramUser.id)) return res.status(403).json({ error: 'Admin access denied' });
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
  if (!/^[1-9]\d{0,18}$/.test(id) || !['open', 'reviewing', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'A valid report ID and status are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id,event_id,status FROM event_reports WHERE id=$1 FOR UPDATE', [id]);
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Report not found' });
    }
    const previous = current.rows[0];
    if (previous.status !== status) {
      await client.query('UPDATE event_reports SET status=$2 WHERE id=$1', [id, status]);
      await client.query(
        'INSERT INTO event_report_actions(report_id,actor_id,previous_status,new_status) VALUES($1,$2,$3,$4)',
        [id, req.telegramUser.id, previous.status, status]
      );
    }
    await client.query('COMMIT');
    res.json({ report: { id: previous.id, event_id: previous.event_id, status }, changed: previous.status !== status });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

// Telegram-admin moderation endpoints for the Mini App. Access is restricted to the verified Telegram ID allowlist.
function requireTelegramAdmin(req,res,next){
  if(!isAdminTelegramUser(req.telegramUser.id))return res.status(403).json({error:'Admin access denied'});
  next();
}
app.get('/api/admin/moderation/events/:id/actions',requireTelegramAdmin,async(req,res)=>{
  const id=String(req.params.id||'');
  if(!/^[1-9]\d{0,18}$/.test(id))return res.status(400).json({error:'Invalid event ID'});
  const result=await pool.query(
    `SELECT a.id,a.action,a.previous_status,a.new_status,a.created_at,a.actor_id,
            COALESCE(u.display_name,u.first_name,u.username,a.actor_id::text) AS actor_name
     FROM event_moderation_actions a
     LEFT JOIN users u ON u.id=a.actor_id
     WHERE a.event_id=$1
     ORDER BY a.created_at DESC,a.id DESC
     LIMIT 100`,
    [id]
  );
  res.json({actions:result.rows});
});
app.get('/api/admin/moderation/reports',requireTelegramAdmin,async(req,res)=>{
  const status=String(req.query.status||'open');
  if(!['all','open','reviewing','resolved','dismissed'].includes(status))return res.status(400).json({error:'Invalid report status'});
  const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||50));
  const result=await pool.query(
    `SELECT r.id,r.event_id,r.reporter_id,r.reason,r.details,r.status,r.created_at,
            e.title AS event_title,e.city AS event_city,e.starts_at AS event_starts_at,
            e.status AS event_status,e.creator_id,
            COALESCE(u.display_name,u.first_name,u.username,r.reporter_id::text) AS reporter_name
     FROM event_reports r
     JOIN events e ON e.id=r.event_id
     LEFT JOIN users u ON u.id=r.reporter_id
     WHERE ($1='all' OR r.status=$1)
     ORDER BY r.created_at DESC
     LIMIT $2`,
    [status,limit]
  );
  res.json({reports:result.rows});
});
app.get('/api/admin/moderation/reports/:id/actions',requireTelegramAdmin,async(req,res)=>{
  const id=String(req.params.id||'');
  if(!/^[1-9]\d{0,18}$/.test(id))return res.status(400).json({error:'Invalid report ID'});
  const result=await pool.query(
    `SELECT a.id,a.previous_status,a.new_status,a.created_at,a.actor_id,
            COALESCE(u.display_name,u.first_name,u.username,a.actor_id::text) AS actor_name
     FROM event_report_actions a
     LEFT JOIN users u ON u.id=a.actor_id
     WHERE a.report_id=$1
     ORDER BY a.created_at DESC,a.id DESC
     LIMIT 100`,
    [id]
  );
  res.json({actions:result.rows});
});
app.patch('/api/admin/moderation/reports/:id',requireTelegramAdmin,async(req,res)=>{
  const id=String(req.params.id||''),status=String(req.body?.status||'');
  if(!/^[1-9]\d{0,18}$/.test(id)||!['open','reviewing','resolved','dismissed'].includes(status))return res.status(400).json({error:'A valid report ID and status are required'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const current=await client.query('SELECT id,event_id,status FROM event_reports WHERE id=$1 FOR UPDATE',[id]);
    if(!current.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Report not found'});}
    const previousStatus=current.rows[0].status;
    const updated=await client.query('UPDATE event_reports SET status=$2 WHERE id=$1 RETURNING id,event_id,status',[id,status]);
    if(previousStatus!==status){
      await client.query(
        'INSERT INTO event_report_actions(report_id,actor_id,previous_status,new_status) VALUES($1,$2,$3,$4)',
        [id,req.telegramUser.id,previousStatus,status]
      );
    }
    await client.query('COMMIT');
    res.json({report:updated.rows[0],changed:previousStatus!==status});
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client.release();}
});

app.use((err, _req, res, _next) => {
  const status = Number(err.status || err.statusCode);
  if (status >= 400 && status < 500) { // bad JSON, body too large, etc. are the client's problem, not a server error
    if (res.headersSent) return;
    return res.status(status).json({ error: status === 413 ? 'Слишком большой запрос' : 'Некорректный запрос' });
  }
  console.error('Unhandled API error:', err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Что-то пошло не так. Попробуй ещё раз.' });
});

const webRoot = path.resolve(process.env.WEB_ROOT || 'docs/telegram');

const shareCover = {};
function loadShareCover(kind) {
  if (!shareCover[kind]) {
    shareCover[kind] = fs.readFile(path.join(webRoot, 'file_00000000c5a081f488c652aeb4ab4bfa.png'))
      .then(source => kind === 'png' ? source : sharp(source).jpeg({ quality: 90, mozjpeg: true }).toBuffer())
      .catch(error => { delete shareCover[kind]; throw error; });
  }
  return shareCover[kind];
}
for (const kind of ['jpg', 'png']) {
  app.get('/pognali-share-cover.' + kind, async (_req, res) => {
    try {
      const body = await loadShareCover(kind);
      res.set('Cache-Control', 'public, max-age=86400');
      res.type(kind === 'jpg' ? 'jpeg' : 'png').send(body);
    } catch (error) {
      console.error('Could not load Pognali share cover:', error.message);
      res.status(503).send('Share cover temporarily unavailable');
    }
  });
}

// Public share landing page: Open Graph preview uses the real event details and the shared Pognali cover.
const sharePageCache = new Map();
app.get('/share/:payload', async (req, res, next) => {
  const cacheKey = req.get('host') + req.originalUrl;
  const cached = sharePageCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60000) {
    res.set('Cache-Control', 'public, max-age=60');
    return res.type('html').send(cached.html);
  }
  const originalSend = res.send.bind(res);
  res.send = body => {
    if (res.statusCode === 200 && typeof body === 'string') {
      if (sharePageCache.size > 500) sharePageCache.clear();
      sharePageCache.set(cacheKey, { at: Date.now(), html: body });
    }
    return originalSend(body);
  };
  const match = String(req.params.payload || '').match(/^event_(\d+)$/);
  if (!match) return next();
  const eventId = match[1];
  const origin = `${req.protocol}://${req.get('host')}`;
  const cover = origin + '/pognali-share-cover.png?v=share-square-20261023';
  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'Pognali_pognali_bot').replace(/^@/, '');
  // The inviter is carried in a short, URL-safe start payload so the bot can show who sent the invite.
  const inviterFirstName = String(req.query.inviter || '').trim().split(/\s+/)[0].replace(/[\u0000-\u001f\u007f<>]/g, '');
  let inviterPayload = '';
  for (let length = Array.from(inviterFirstName).length; length > 0; length--) {
    const encoded = Buffer.from(Array.from(inviterFirstName).slice(0, length).join('')).toString('base64url');
    if (('event_' + eventId + '_i_' + encoded).length <= 64) { inviterPayload = '_i_' + encoded; break; }
  }
  // Keep the reliable bot-chat fallback until the Main Mini App is explicitly configured in BotFather.
  // Once configured, set TELEGRAM_MAIN_MINI_APP_ENABLED=true in Render to open the exact event directly.
  const directMiniAppEnabled = String(process.env.TELEGRAM_MAIN_MINI_APP_ENABLED || '').toLowerCase() === 'true';
  const deepLinkParam = 'event_' + eventId + inviterPayload;
  const botUrl = 'https://t.me/' + encodeURIComponent(botUsername) + (directMiniAppEnabled
    ? '?startapp=' + encodeURIComponent(deepLinkParam)
    : '?start=' + encodeURIComponent(deepLinkParam));
  let event = null;
  if (pool) {
    try {
      const result = await pool.query("SELECT title, description, category, city, address, starts_at FROM events WHERE id=$1 AND status='published'", [eventId]);
      event = result.rows[0] || null;
    } catch (error) {
      console.warn('Could not load event share metadata:', error.message);
    }
  }
  if (!event) return res.status(404).type('text').send('Событие не найдено или уже недоступно.');
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const title = (String(event.title || 'Событие') + ' — Погнали').slice(0, 180);
  const when = event.starts_at ? new Date(event.starts_at).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }) : '';
  const place = [event.address, event.city].filter(Boolean).join(', ');
  const detail = [when, place, String(event.description || '').trim()].filter(Boolean).join(' · ');
  const description = (detail || 'Тебя пригласили на событие. Открой карточку и присоединяйся!').slice(0, 500);
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeBotUrl = escapeHtml(botUrl);
  res.set('Cache-Control', 'public, max-age=60');
  res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title><meta name="description" content="${safeDescription}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Погнали"><meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDescription}"><meta property="og:url" content="${origin}/share/event_${eventId}?v=share-square-20261023">
<meta property="og:image" content="${cover}"><meta property="og:image:secure_url" content="${cover}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1254"><meta property="og:image:height" content="1254">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${safeTitle}"><meta name="twitter:description" content="${safeDescription}"><meta name="twitter:image" content="${cover}">
<meta http-equiv="refresh" content="1;url=${safeBotUrl}">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08152c;color:#fff;font:16px system-ui,sans-serif;text-align:center}.wrap{max-width:420px;padding:28px}.brand{font-size:32px;font-weight:850}.sub{color:#c5e7ff;line-height:1.5;margin:14px 0 24px}a{display:inline-block;background:#60bfff;color:#07172e;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:15px}</style></head><body><main class="wrap"><div class="brand">🚀 ${safeTitle}</div><p class="sub">${safeDescription}</p><a href="${safeBotUrl}">Посмотреть событие</a></main><script>setTimeout(()=>{window.location.href=${JSON.stringify(botUrl)}},800)</script></body></html>`);
});
// Prepare the Mini App shell and a fingerprinted app script once at startup.
let indexCache = null;
const appAssets = new Map();
fs.readFile(path.join(webRoot, 'index.html'), 'utf8').then(source => {
  let html = source;
  if (String(process.env.SPLIT_ASSETS || '1') !== '0') {
    const open = html.lastIndexOf('<script>');
    const close = html.lastIndexOf('</script>');
    if (open >= 0 && close > open) {
      const script = html.slice(open + 8, close);
      const hash = crypto.createHash('sha1').update(script).digest('hex').slice(0, 16);
      const name = '/assets/app.' + hash + '.js';
      const js = Buffer.from(script);
      appAssets.set(name, { raw: js, gz: zlib.gzipSync(js, { level: 9 }), br: zlib.brotliCompressSync(js) });
      html = html.slice(0, open) + '<script defer src="' + name + '"></script>' + html.slice(close + 9);
      html = html.replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', '<script defer src="https://telegram.org/js/telegram-web-app.js"></script>');
    }
  }
  const raw = Buffer.from(html);
  indexCache = {
    raw,
    gz: zlib.gzipSync(raw, { level: 9 }),
    br: zlib.brotliCompressSync(raw),
    etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"'
  };
}).catch(error => console.error('Could not prepare cached index.html:', error.message));
app.get('/assets/:name', (req, res) => {
  const entry = appAssets.get('/assets/' + req.params.name);
  if (!entry) return res.status(404).end();
  res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable', Vary: 'Accept-Encoding' });
  if (req.acceptsEncodings('br')) { res.set('Content-Encoding', 'br'); return res.send(entry.br); }
  if (req.acceptsEncodings('gzip')) { res.set('Content-Encoding', 'gzip'); return res.send(entry.gz); }
  return res.send(entry.raw);
});
function sendIndex(req, res) {
  if (!indexCache) return false;
  res.set({ ETag: indexCache.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', 'Content-Type': 'text/html; charset=utf-8' });
  if (req.headers['if-none-match'] === indexCache.etag) {
    res.status(304).end();
    return true;
  }
  if (req.acceptsEncodings('br')) { res.set('Content-Encoding', 'br'); res.end(indexCache.br); }
  else if (req.acceptsEncodings('gzip')) { res.set('Content-Encoding', 'gzip'); res.end(indexCache.gz); }
  else res.end(indexCache.raw);
  return true;
}
function serveVendor(urlPath, pkg, file, type, subdir = '') {
  let loading = null;
  app.get(urlPath, async (req, res, next) => {
    try {
      loading = loading || fs.readFile(path.join(path.dirname(require.resolve(pkg)), subdir, file))
        .then(raw => ({ raw, gz: zlib.gzipSync(raw, { level: 9 }), br: zlib.brotliCompressSync(raw) }));
      const entry = await loading;
      res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', Vary: 'Accept-Encoding' });
      if (req.acceptsEncodings('br')) { res.set('Content-Encoding', 'br'); return res.send(entry.br); }
      if (req.acceptsEncodings('gzip')) { res.set('Content-Encoding', 'gzip'); return res.send(entry.gz); }
      return res.send(entry.raw);
    } catch { loading = null; return next(); }
  });
}
// maplibre-gl 6 is ESM-only: the page imports /vendor/maplibre-gl-<ver>/maplibre-gl.mjs, which finds its worker
// (maplibre-gl-worker.mjs) next to itself, so both files must be served from the same folder.
// 'maplibre-gl/package.json' is the only entry point the package exports that resolves from CommonJS.
const MAPLIBRE_DIR = '/vendor/maplibre-gl-6.15.0';
serveVendor(`${MAPLIBRE_DIR}/maplibre-gl.mjs`, 'maplibre-gl/package.json', 'maplibre-gl.mjs', 'text/javascript; charset=utf-8', 'dist');
serveVendor(`${MAPLIBRE_DIR}/maplibre-gl-worker.mjs`, 'maplibre-gl/package.json', 'maplibre-gl-worker.mjs', 'text/javascript; charset=utf-8', 'dist');
serveVendor(`${MAPLIBRE_DIR}/maplibre-gl.css`, 'maplibre-gl/package.json', 'maplibre-gl.css', 'text/css; charset=utf-8', 'dist');
serveVendor('/vendor/supercluster-8.0.1.js', 'supercluster', 'supercluster.min.js', 'application/javascript; charset=utf-8', 'dist');
app.get('/vendor/{*splat}', (_req, res) => res.status(404).end());

app.get(['/', '/index.html'], (req, res, next) => {
  if (!sendIndex(req, res)) next();
});
app.use(express.static(webRoot));
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (sendIndex(req, res)) return;
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
  const webhookUrl = new URL('/telegram/webhook', miniAppUrl).toString();
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
      body: JSON.stringify({ url: webhookUrl, secret_token: secret, allowed_updates: ['message', 'inline_query'], drop_pending_updates: false })
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
    await startNotificationWorker();
  }
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Pognali API listening on ${port}; DB ${pool ? 'configured' : 'missing'}`);
    configureTelegramWebhook();
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
}
if (require.main === module) start().catch(error => { console.error('Startup failed:', error.message); process.exit(1); });
module.exports = { app, start };
