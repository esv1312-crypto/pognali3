// Focused feature-level integration tests for the Pognali update 3 flows.
// Uses the real Express app and embedded PostgreSQL, matching api.integration.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let EmbeddedPostgres = null;
try { EmbeddedPostgres = require('embedded-postgres').default; } catch { /* optional in local runs */ }
const SKIP = !EmbeddedPostgres || process.env.SKIP_DB_TESTS === '1';
const TOKEN = '1:FEATURES_TOKEN';
const ADMIN = { id: 9001, first_name: 'Админ', username: 'admin_user' };
const ANNA = { id: 9101, first_name: 'Анна', username: 'anna_t' };
const BORIS = { id: 9102, first_name: 'Борис', username: 'boris_t' };
const VERA = { id: 9103, first_name: 'Вера', username: 'vera_t' };
const ctx = { base: '', pg: null, telegram: [] };

function initData(user) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH', user: JSON.stringify(user) });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
  p.set('hash', crypto.createHmac('sha256', crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest()).update(check).digest('hex'));
  return p.toString();
}
async function call(user, p, { method = 'GET', body, headers = {}, prefix = '/api' } = {}) {
  const res = await fetch(ctx.base + prefix + p, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-telegram-init-data': initData(user) } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* response isn't JSON */ }
  return { status: res.status, json, text };
}
const eventBody = (over = {}) => ({
  title: 'Футбол во дворе', category: 'Спорт', city: 'Симферополь', address: 'Парк Салгирка',
  latitude: 44.95, longitude: 34.1, starts_at: new Date(Date.now() + 864e5).toISOString(),
  capacity: 5, description: 'Играем два на два', ...over
});
const makeEvent = async (user, over) => {
  const res = await call(user, '/events', { method: 'POST', body: eventBody(over) });
  assert.equal(res.status, 201, res.text);
  return res.json.event;
};
const join = (user, id) => call(user, `/events/${id}/join`, { method: 'POST', body: {} });
const t = (name, fn) => test(name, { skip: SKIP && 'needs embedded-postgres (or SKIP_DB_TESTS=1)' }, fn);

test.before(async () => {
  if (SKIP) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pognali-feat-'));
  const dbPort = 40000 + Math.floor(Math.random() * 10000);
  ctx.pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'pw', port: dbPort, persistent: false,
    createPostgresUser: process.getuid && process.getuid() === 0,
    initdbFlags: ['--encoding=UTF8', '--locale=C.UTF-8']
  });
  await ctx.pg.initialise();
  await ctx.pg.start();
  await ctx.pg.createDatabase('pognali');
  const port = 50000 + Math.floor(Math.random() * 10000);
  Object.assign(process.env, {
    DATABASE_URL: `postgres://postgres:pw@127.0.0.1:${dbPort}/pognali`,
    DATABASE_SSL: 'disable', PORT: String(port), TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_BOT_USERNAME: 'feat_bot', MINI_APP_URL: 'https://app.example',
    TELEGRAM_WEBHOOK_SECRET: 'hook', ADMIN_API_TOKEN: 'admintoken',
    ADMIN_TELEGRAM_IDS: String(ADMIN.id)
  });
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.telegram.org')) {
      const method = String(url).split('/').pop();
      ctx.telegram.push({ method, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: method === 'savePreparedInlineMessage' ? { id: 'prepared-123' } : {} }) };
    }
    return realFetch(url, opts);
  };
  const { start } = require('../server/index.js');
  await start();
  ctx.base = `http://127.0.0.1:${port}`;
  for (const user of [ADMIN, ANNA, BORIS, VERA]) {
    const response = await call(user, '/me');
    assert.equal(response.status, 200, response.text);
  }
});
test.after(async () => {
  if (SKIP) return;
  if (ctx.pg) await ctx.pg.stop();
  setTimeout(() => process.exit(0), 200).unref();
});

t('profile edits trim and cap fields and identify administrators', async () => {
  const edit = await call(ANNA, '/me', { method: 'PATCH', body: { display_name: '  Анна К  ', city: 'Симферополь', bio: 'Люблю футбол' } });
  assert.equal(edit.status, 200, edit.text);
  assert.deepEqual([edit.json.user.display_name, edit.json.user.city, edit.json.user.bio], ['Анна К', 'Симферополь', 'Люблю футбол']);
  const unchanged = await call(ANNA, '/me', { method: 'PATCH', body: {} });
  assert.deepEqual([unchanged.json.user.display_name, unchanged.json.user.city, unchanged.json.user.bio], ['Анна К', 'Симферополь', 'Люблю футбол']);
  const long = await call(ANNA, '/me', { method: 'PATCH', body: { display_name: 'я'.repeat(200), bio: 'б'.repeat(900) } });
  assert.equal(long.json.user.display_name.length, 80);
  assert.equal(long.json.user.bio.length, 500);
  assert.equal((await call(ADMIN, '/me')).json.user.is_admin, true);
  assert.equal((await call(ANNA, '/me')).json.user.is_admin, false);
});

t('event lifecycle enforces organizer permissions and completed-event rules', async () => {
  const event = await makeEvent(ANNA);
  assert.equal((await call(BORIS, `/events/${event.id}`)).status, 200);
  assert.equal((await call(BORIS, `/events/${event.id}`, { method: 'PATCH', body: eventBody({ title: 'Чужое событие' }) })).status, 404);
  assert.equal((await call(ANNA, `/events/${event.id}`, { method: 'PATCH', body: eventBody({ title: 'Новое название' }) })).status, 200);
  assert.equal((await call(ANNA, `/events/${event.id}`)).json.event.title, 'Новое название');
  assert.equal((await call(ANNA, `/events/${event.id}/finish`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await join(BORIS, event.id)).status, 404);
  assert.equal((await call(ANNA, `/events/${event.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(ANNA, `/events/${event.id}`)).status, 404);
});

t('joining is idempotent, capacity is enforced, and organizer cannot leave', async () => {
  const event = await makeEvent(ANNA, { capacity: 2 });
  assert.equal((await join(BORIS, event.id)).status, 200);
  assert.equal((await join(BORIS, event.id)).status, 200);
  assert.equal((await join(VERA, event.id)).status, 409);
  assert.equal((await call(BORIS, `/events/${event.id}/leave`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await join(VERA, event.id)).status, 200);
  assert.equal((await call(ANNA, `/events/${event.id}/leave`, { method: 'POST', body: {} })).status, 409);
  assert.equal((await call(ANNA, `/events/${event.id}/messages`)).status, 200);
});

t('event chat is limited to participants and validates message length', async () => {
  const event = await makeEvent(ANNA);
  await join(BORIS, event.id);
  assert.equal((await call(VERA, `/events/${event.id}/messages`)).status, 403);
  assert.equal((await call(BORIS, `/events/${event.id}/messages`, { method: 'POST', body: { body: 'Привет всем' } })).status, 201);
  assert.equal((await call(BORIS, `/events/${event.id}/messages`, { method: 'POST', body: { body: 'x'.repeat(5000) } })).status, 400);
  const messages = await call(ANNA, `/events/${event.id}/messages`);
  assert.equal(messages.status, 200);
  assert.ok(messages.json.messages.some(message => message.body === 'Привет всем'));
});

t('reporting and moderation require valid reasons, admin login and admin token', async () => {
  const event = await makeEvent(ANNA, { title: 'Проверка жалоб' });
  assert.equal((await call(BORIS, `/events/${event.id}/reports`, { method: 'POST', body: { reason: 'неизвестная причина' } })).status, 400);
  assert.equal((await call(ANNA, `/events/${event.id}/reports`, { method: 'POST', body: { reason: 'spam' } })).status, 400);
  const report = await call(VERA, `/events/${event.id}/reports`, { method: 'POST', body: { reason: 'fake', details: 'Похоже на фейк' } });
  assert.equal(report.status, 201, report.text);
  assert.equal((await call(ADMIN, '/admin/reports')).status, 403);
  const list = await call(ADMIN, '/admin/reports', { headers: { 'x-admin-token': 'admintoken' } });
  assert.equal(list.status, 200, list.text);
  const row = list.json.reports.find(item => item.event_id === event.id);
  assert.ok(row);
  assert.equal((await call(ADMIN, `/admin/reports/${row.id}`, { method: 'PATCH', body: { status: 'resolved' }, headers: { 'x-admin-token': 'admintoken' } })).status, 200);
});

t('Telegram webhook validates its secret and formats /id without a literal backslash-n', async () => {
  const hook = (body, secret = 'hook') => call(null, '/telegram/webhook', { prefix: '', method: 'POST', body, headers: { 'x-telegram-bot-api-secret-token': secret } });
  assert.equal((await hook({ message: { chat: { id: 1 }, text: '/start' } }, 'wrong')).status, 401);
  ctx.telegram.length = 0;
  assert.equal((await hook({ message: { chat: { id: 2 }, from: { id: 4242 }, text: '/id' } })).status, 200);
  const reply = ctx.telegram.find(item => item.method === 'sendMessage');
  assert.ok(reply);
  assert.match(reply.body.text, /4242/);
  assert.equal(reply.body.text.includes('\\n'), false);
});
