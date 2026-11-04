// Integration tests: the real Express app against a real (embedded) PostgreSQL. No mocks of our own code.
// Skipped automatically when embedded-postgres is not installed or SKIP_DB_TESTS=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let EmbeddedPostgres = null;
try { EmbeddedPostgres = require('embedded-postgres').default; } catch { /* optional */ }
const SKIP = !EmbeddedPostgres || process.env.SKIP_DB_TESTS === '1';

const TOKEN = '1:TEST_TOKEN';
const A = { id: 111, first_name: 'Стас', username: 'stas' };
const B = { id: 222, first_name: 'Антон', username: 'anton' };
const C = { id: 333, first_name: 'Олег', username: 'oleg' };

function initData(user, { ageSec = 0, tamper = false } = {}) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), query_id: 'AAH', user: JSON.stringify(user) });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  let hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (tamper) hash = (hash[0] === 'a' ? 'b' : 'a') + hash.slice(1);
  p.set('hash', hash);
  return p.toString();
}

const ctx = { base: '', pg: null, db: null, server: null, telegram: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(user, p, { method = 'GET', body, raw, headers = {} } = {}) {
  const res = await fetch(ctx.base + '/api' + p, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-telegram-init-data': initData(user) } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json, headers: res.headers };
}
const newEvent = (over = {}) => ({
  title: 'Футбол во дворе', category: 'Спорт', city: 'Симферополь', address: 'Парк', latitude: 44.95, longitude: 34.1,
  starts_at: new Date(Date.now() + 864e5).toISOString(), capacity: 10, description: 'Описание', ...over
});
const create = async (user, over) => (await api(user, '/events', { method: 'POST', body: newEvent(over) })).json.event;

test.before(async () => {
  if (SKIP) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pognali-pg-'));
  const dbPort = 20000 + Math.floor(Math.random() * 10000);
  ctx.pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: dbPort, persistent: false, createPostgresUser: process.getuid && process.getuid() === 0 });
  await ctx.pg.initialise();
  await ctx.pg.start();
  await ctx.pg.createDatabase('pognali');
  const port = 30000 + Math.floor(Math.random() * 10000);
  Object.assign(process.env, {
    DATABASE_URL: `postgres://postgres:pw@127.0.0.1:${dbPort}/pognali`, DATABASE_SSL: 'disable', PORT: String(port),
    TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_USERNAME: 'test_bot', MINI_APP_URL: 'https://app.test', TELEGRAM_WEBHOOK_SECRET: 's', ADMIN_API_TOKEN: 'adm'
  });
  ctx.db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { // never talk to the real Telegram; record outgoing bot calls
    if (String(url).includes('api.telegram.org')) { ctx.telegram.push({ method: String(url).split('/').pop(), body: opts && opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; }
    return realFetch(url, opts);
  };
  const { start } = require('../server/index.js');
  await start();
  ctx.base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (SKIP) return;
  if (ctx.db) await ctx.db.end();
  if (ctx.pg) await ctx.pg.stop();
  setTimeout(() => process.exit(0), 200).unref();
});

const t = (name, fn) => test(name, { skip: SKIP && 'needs embedded-postgres (or SKIP_DB_TESTS=1)' }, fn);

t('health is public and reports the database', async () => {
  const r = await api(null, '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.database, 'ok');
});

t('rejects missing, tampered and expired Telegram initData', async () => {
  assert.equal((await api(null, '/me')).status, 401);
  assert.equal((await api(null, '/me', { headers: { 'x-telegram-init-data': initData(A, { tamper: true }) } })).status, 401);
  assert.equal((await api(null, '/me', { headers: { 'x-telegram-init-data': initData(A, { ageSec: 3 * 86400 }) } })).status, 401);
  assert.equal((await api(A, '/me')).status, 200);
});

t('profile changes from Telegram are picked up despite the user cache', async () => {
  const first = await api({ id: 777, first_name: 'Первое' }, '/me');
  const again = await api({ id: 777, first_name: 'Первое' }, '/me');
  const renamed = await api({ id: 777, first_name: 'Новое' }, '/me');
  assert.equal(first.json.user.first_name, 'Первое');
  assert.equal(again.json.user.first_name, 'Первое');
  assert.equal(renamed.json.user.first_name, 'Новое');
});

t('Telegram profile sync is throttled for repeated profile reads', async () => {
  const user = { id: 778, first_name: 'Проверка синхронизации' };
  ctx.telegram.length = 0;
  assert.equal((await api(user, '/me')).status, 200);
  const firstSyncCalls = ctx.telegram.filter(call => ['getChat', 'getUserProfilePhotos'].includes(call.method)).length;
  assert.equal(firstSyncCalls, 2, 'first profile read syncs birthday and photo');
  assert.equal((await api(user, '/me')).status, 200);
  const allSyncCalls = ctx.telegram.filter(call => ['getChat', 'getUserProfilePhotos'].includes(call.method)).length;
  assert.equal(allSyncCalls, firstSyncCalls, 'second profile read reuses the recent sync');
});

t('profile birthday can be cleared and invalid calendar dates are rejected', async () => {
  await api(A, '/me');
  assert.equal((await api(A, '/me', { method: 'PATCH', body: { birth_date: '1990-02-28' } })).status, 200);
  const invalid = await api(A, '/me', { method: 'PATCH', body: { birth_date: '1990-02-30' } });
  assert.equal(invalid.status, 400);
  const future = await api(A, '/me', { method: 'PATCH', body: { birth_date: '2999-01-01' } });
  assert.equal(future.status, 400);
  const cleared = await api(A, '/me', { method: 'PATCH', body: { birth_date: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.user.birth_date, null);
  assert.equal(cleared.json.user.birth_day, null);
  assert.equal(cleared.json.user.birth_month, null);
  assert.equal(cleared.json.user.birth_year, null);
});

t('user search does not expose full birth dates or unnecessary profile data', async () => {
  const searchable = { id: 779, first_name: 'SearchableBirthday', username: 'searchablebirthday' };
  await api(A, '/me');
  await api(searchable, '/me');
  const result = await api(A, '/users/search?q=SearchableBirthday');
  assert.equal(result.status, 200);
  assert.equal(result.json.users.length, 1);
  for (const field of ['birth_date', 'birth_day', 'birth_month', 'birth_year', 'photo_url', 'bio']) {
    assert.equal(Object.hasOwn(result.json.users[0], field), false, field + ' must not be exposed by user search');
  }
});

t('event validation answers 4xx (never 500) for hostile input', async () => {
  const bad = [
    ['empty title', newEvent({ title: '' }), 400], ['lat 999', newEvent({ latitude: 999 }), 400], ['lat text', newEvent({ latitude: 'abc' }), 400],
    ['negative capacity', newEvent({ capacity: -5 }), 400], ['bad date', newEvent({ starts_at: 'вчера' }), 400],
    ['year 1999', newEvent({ starts_at: '1999-01-01T00:00:00Z' }), 400], ['year 9999', newEvent({ starts_at: '9999-12-31T00:00:00Z' }), 400],
    ['NUL byte', newEvent({ title: 'a\u0000b' }), 400], ['100 KB description', newEvent({ description: 'x'.repeat(100000) }), 413]
  ];
  for (const [name, body, expected] of bad) assert.equal((await api(A, '/events', { method: 'POST', body })).status, expected, name);
  assert.equal((await api(A, '/events', { method: 'POST', raw: '{bad json' })).status, 400, 'invalid JSON');
  assert.equal((await api(A, '/events', { method: 'POST', body: newEvent({ title: "'; DROP TABLE events;--" }) })).status, 201, 'SQL text is just text');
});

t('non-numeric or absurd ids are 404, not 500', async () => {
  for (const id of ['abc', '99999999999999999999', '-1', '1%20OR%201=1']) assert.equal((await api(A, '/events/' + id)).status, 404, id);
});

t('event list is cached, ETag/304 works and creating an event refreshes it', async () => {
  await create(A);
  const first = await api(A, '/events?limit=100');
  const etag = first.headers.get('etag');
  assert.ok(etag, 'ETag present');
  const res = await fetch(ctx.base + '/api/events?limit=100', { headers: { 'x-telegram-init-data': initData(A), 'if-none-match': etag } });
  assert.equal(res.status, 304);
  await create(A, { title: 'Новое событие' });
  const after = await api(A, '/events?limit=100');
  assert.notEqual(after.headers.get('etag'), etag, 'new event changes the list');
  assert.ok(after.json.events.some(e => e.title === 'Новое событие'));
});

t('joining: capacity limit, idempotent, safe under parallel requests, joined-ids is per user', async () => {
  const small = await create(A, { capacity: 2 });
  assert.equal((await api(B, `/events/${small.id}/join`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await api(C, `/events/${small.id}/join`, { method: 'POST', body: {} })).status, 409, 'event is full');
  const big = await create(A, { capacity: 20 });
  const results = await Promise.all(Array.from({ length: 8 }, () => api(B, `/events/${big.id}/join`, { method: 'POST', body: {} })));
  assert.ok(results.every(r => r.status === 200), 'no 500 under parallel joins');
  const detail = await api(B, `/events/${big.id}`);
  assert.equal(detail.json.participants.length, 2, 'creator + B exactly once');
  const mine = await api(B, '/events/joined-ids');
  assert.ok(mine.json.ids.includes(String(big.id)) && mine.json.ids.includes(String(small.id)));
  assert.ok(!(await api(C, '/events/joined-ids')).json.ids.includes(String(big.id)));
});

t('joining an ended event is rejected while an ongoing event remains joinable', async () => {
  const ended = await create(A, { starts_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() });
  const endedJoin = await api(B, `/events/${ended.id}/join`, { method: 'POST', body: {} });
  assert.equal(endedJoin.status, 409);
  const active = await create(A, { starts_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const activeJoin = await api(B, `/events/${active.id}/join`, { method: 'POST', body: {} });
  assert.equal(activeJoin.status, 200);
  const explicitEnd = await create(A, {
    starts_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    ends_at: new Date(Date.now() - 30 * 60 * 1000).toISOString()
  });
  assert.equal((await api(C, `/events/${explicitEnd.id}/join`, { method: 'POST', body: {} })).status, 409);
});

t('chat: unread counter is capped per conversation and cleared by reading', async () => {
  const ev = await create(A, { capacity: 20 });
  await api(B, `/events/${ev.id}/join`, { method: 'POST', body: {} });
  assert.equal((await api(B, `/events/${ev.id}/messages`, { method: 'POST', body: { body: 'Привет!' } })).status, 201);
  assert.equal((await api(A, '/messages/unread-count')).json.unreadCount >= 1, true);
  for (let i = 0; i < 120; i++) await api(B, `/events/${ev.id}/messages`, { method: 'POST', body: { body: 'сообщение ' + i } });
  const capped = (await api(A, '/messages/unread-count')).json.unreadCount;
  assert.ok(capped <= 99 * 10, 'bounded work per conversation');
  const read = await api(A, '/messages/read', { method: 'POST', body: { type: 'event', conversationType: 'event', conversation_id: ev.id, conversationId: ev.id } });
  assert.equal(read.status, 200);
});

t('direct message requests notify both users and mutual consent gates messages', async () => {
  await api(A, '/me');
  await api(B, '/me');
  ctx.telegram.length = 0;
  const requested = await api(A, '/direct/requests', { method: 'POST', body: { user_id: String(B.id) } });
  assert.equal(requested.status, 201);
  const conversationId = requested.json.conversation.id;
  await sleep(200);
  assert.ok(ctx.telegram.some(call =>
    call.method === 'sendMessage' &&
    String(call.body?.chat_id) === String(B.id) &&
    /запрос на личную переписку/.test(String(call.body?.text || ''))
  ), 'recipient receives the new request notification');
  assert.equal((await api(A, `/direct/${conversationId}/messages`, { method: 'POST', body: { body: 'До согласия' } })).status, 403);
  ctx.telegram.length = 0;
  assert.equal((await api(B, `/direct/${conversationId}/respond`, { method: 'POST', body: { decision: 'accept' } })).status, 200);
  await sleep(200);
  assert.ok(ctx.telegram.some(call =>
    call.method === 'sendMessage' &&
    String(call.body?.chat_id) === String(A.id) &&
    /запрос на личную переписку.*принят/i.test(String(call.body?.text || ''))
  ), 'requester receives the acceptance notification');
  assert.equal((await api(A, `/direct/${conversationId}/messages`, { method: 'POST', body: { body: 'Теперь можно общаться' } })).status, 201);
  const inbox = await api(B, `/direct/${conversationId}/messages`);
  assert.ok(inbox.json.messages.some(message => message.body === 'Теперь можно общаться'));
});

t('event chat returns the newest 500 messages in chronological order', async () => {
  const ev = await create(A, { title: 'История чата', capacity: 20 });
  await api(B, `/events/${ev.id}/join`, { method: 'POST', body: {} });
  await ctx.db.query(
    `INSERT INTO event_messages(event_id,sender_id,body,created_at)
     SELECT $1,$2,'history-'||n,NOW()-INTERVAL '10 minutes'+n*INTERVAL '1 second'
     FROM generate_series(1,510) AS n`,
    [ev.id, B.id]
  );
  const result = await api(A, `/events/${ev.id}/messages`);
  assert.equal(result.status, 200);
  assert.equal(result.json.messages.length, 500);
  assert.equal(result.json.messages[0].body, 'history-11');
  assert.equal(result.json.messages[499].body, 'history-510');
});



t('event chat notifications reach the organizer even without a participant row', async () => {
  const ev = await create(A, { title: 'Чат без строки организатора', capacity: 20 });
  await api(B, `/events/${ev.id}/join`, { method: 'POST', body: {} });
  await sleep(200);
  await ctx.db.query('DELETE FROM event_participants WHERE event_id=$1 AND user_id=$2', [ev.id, A.id]);
  ctx.telegram.length = 0;
  const sent = await api(B, `/events/${ev.id}/messages`, { method: 'POST', body: { body: 'Проверка уведомления организатору' } });
  assert.equal(sent.status, 201);
  await sleep(250);
  const delivered = ctx.telegram.filter(call =>
    call.method === 'sendMessage' &&
    String(call.body?.chat_id) === String(A.id) &&
    /Новое сообщение в чате события/.test(String(call.body?.text || ''))
  );
  assert.equal(delivered.length, 1, 'organizer receives the group-chat notification');
});

t('telegram notifications are throttled: repeated chat messages notify once', async () => {
  const ev = await create(A, { title: 'Уведомления', capacity: 20 });
  await api(B, `/events/${ev.id}/join`, { method: 'POST', body: {} });
  ctx.telegram.length = 0;
  for (let i = 0; i < 5; i++) await api(B, `/events/${ev.id}/messages`, { method: 'POST', body: { body: 'м' + i } });
  await sleep(400);
  const chat = ctx.telegram.filter(c => c.method === 'sendMessage' && /чате события «Уведомления»/.test(c.body && c.body.text));
  assert.equal(chat.length, 1, 'five messages -> one notification');
});

t('share endpoints: landing page, 404 for unknown, cached cover with ETag', async () => {
  const ev = await create(A, { title: 'Событие для ссылки' });
  const page = await fetch(`${ctx.base}/share/event_${ev.id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Событие для ссылки/);
  assert.equal((await fetch(`${ctx.base}/share/event_99999999`)).status, 404);
  const cover = await fetch(ctx.base + '/pognali-share-cover.jpg');
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/jpeg');
  const again = await fetch(ctx.base + '/pognali-share-cover.jpg', { headers: { 'if-none-match': cover.headers.get('etag'), 'cache-control': 'max-age=0' } }); // plain fetch adds no-cache, which disables 304
  assert.equal(again.status, 304);
});

t('static delivery: split script is immutable, index has ETag/304, vendor files are real, unknown ones 404', async () => {
  const index = await fetch(ctx.base + '/', { headers: { 'accept-encoding': 'br' } });
  assert.equal(index.status, 200);
  const html = await index.text();
  const etag = index.headers.get('etag');
  assert.ok(etag);
  assert.equal((await fetch(ctx.base + '/', { headers: { 'if-none-match': etag } })).status, 304);
  const asset = html.match(/src="(\/assets\/app\.[0-9a-f]+\.js)"/);
  assert.ok(asset, 'main script is split into a hashed asset');
  const js = await fetch(ctx.base + asset[1]);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(ctx.base + '/assets/nope.js')).status, 404);
  const ml = await fetch(ctx.base + '/vendor/maplibre-gl-6.15.0/maplibre-gl.mjs');
  assert.equal(ml.status, 200);
  assert.match(ml.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(ctx.base + '/vendor/missing.js')).status, 404);
});

t('admin can update a report with a numeric ID', async () => {
  const ev = await create(A, { title: 'Событие для жалобы' });
  const reported = await api(B, `/events/${ev.id}/reports`, { method: 'POST', body: { reason: 'other', details: 'Проверка модерации' } });
  assert.equal(reported.status, 201);
  const reportId = reported.json.reportId ?? reported.json.id ?? reported.json.report?.id;
  assert.ok(reportId, 'report endpoint returns the created report ID');
  const updated = await api(A, `/admin/reports/${reportId}`, {
    method: 'PATCH', body: { status: 'reviewing' }, headers: { 'x-admin-token': 'adm' }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.report.status, 'reviewing');
});

t('event updates reject dates outside the supported range', async () => {
  const ev = await create(A, { title: 'Событие для проверки даты' });
  const farFuture = await api(A, `/events/${ev.id}`, {
    method: 'PATCH', body: newEvent({ title: 'Обновление даты', starts_at: '9999-12-31T00:00:00Z' })
  });
  assert.equal(farFuture.status, 400);
  const tooOld = await api(A, `/events/${ev.id}`, {
    method: 'PATCH', body: newEvent({ title: 'Обновление даты', starts_at: '1999-01-01T00:00:00Z' })
  });
  assert.equal(tooOld.status, 400);
});
