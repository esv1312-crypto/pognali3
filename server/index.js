const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { verifyTelegramInitData } = require('./telegram-auth');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : (process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }),
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000
}) : null;

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
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet' });
  next();
}

async function requireTelegram(req, res, next) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(503).json({ error: 'Telegram bot token is not configured on the server' });
  const initData = req.get('x-telegram-init-data') || '';
  const auth = verifyTelegramInitData(initData, token);
  if (!auth.ok) return res.status(401).json({ error: auth.error });
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
    res.status(503).json({ error: 'Database temporarily unavailable' });
  }
}

app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  return requireDatabase(req, res, () => requireTelegram(req, res, next));
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
  const city = typeof b.city === 'string' ? b.city.trim() : '';
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
});

app.post('/api/events/:id/join', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await client.query('SELECT id, capacity, status FROM events WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!event.rowCount || event.rows[0].status !== 'published') {
      await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' });
    }
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
      `INSERT INTO event_participants (event_id,user_id,status) VALUES ($1,$2,'joined')
       ON CONFLICT (event_id,user_id) DO UPDATE SET status='joined', joined_at=NOW()`,
      [req.params.id, req.telegramUser.id]
    );
    await client.query('COMMIT');
    res.json({ joined: true, eventId: String(req.params.id) });
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

app.use((err, _req, res, _next) => {
  console.error('Unhandled API error:', err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const webRoot = path.resolve(process.env.WEB_ROOT || 'docs/telegram');
app.use(express.static(webRoot));
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  try { res.sendFile(path.join(webRoot, 'index.html')); } catch { next(); }
});

async function start() {
  if (pool) {
    const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
  }
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.log(`Pognali API listening on ${port}; DB ${pool ? 'configured' : 'missing'}`));
}
if (require.main === module) start().catch(error => { console.error('Startup failed:', error.message); process.exit(1); });
module.exports = { app, start };
