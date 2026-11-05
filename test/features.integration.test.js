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

  const reportedEvent = await makeEvent(ANNA, { title: 'Событие с жалобой' });
  await join(BORIS, reportedEvent.id);
  const contact = await call(ANNA, `/events/${reportedEvent.id}/participants/${BORIS.id}/contact`, { method: 'POST', body: {} });
  assert.equal(contact.status, 201, contact.text);
  assert.equal((await call(BORIS, `/event-contacts/${contact.json.conversation.id}/messages`, { method: 'POST', body: { body: 'Сообщение перед отменой' } })).status, 201);
  const unreadBeforeCancel = (await call(ANNA, '/messages/unread-count')).json.unreadCount;
  const report = await call(BORIS, `/events/${reportedEvent.id}/reports`, { method: 'POST', body: { reason: 'unsafe', details: 'Проверка сохранения истории' } });
  assert.equal(report.status, 201, report.text);
  const deletion = await call(ANNA, `/events/${reportedEvent.id}`, { method: 'DELETE' });
  assert.equal(deletion.status, 200, deletion.text);
  assert.equal(deletion.json.archived, true);
  assert.equal((await call(ANNA, `/events/${reportedEvent.id}`)).status, 404);
  assert.equal((await call(ANNA, `/events/${reportedEvent.id}/messages`)).status, 403);
  assert.equal((await call(ANNA, `/events/${reportedEvent.id}/messages`, { method: 'POST', body: { body: 'После отмены' } })).status, 403);
  assert.equal((await call(ANNA, `/event-contacts/${contact.json.conversation.id}/messages`)).status, 404);
  assert.equal((await call(ANNA, `/event-contacts/${contact.json.conversation.id}/messages`, { method: 'POST', body: { body: 'После отмены' } })).status, 404);
  assert.equal((await call(ANNA, '/messages/unread-count')).json.unreadCount, unreadBeforeCancel - 1);
  assert.equal((await call(ANNA, '/messages/read', { method: 'POST', body: { type: 'event_contact', conversation_id: contact.json.conversation.id } })).status, 403);
  const inboxAfterCancellation = await call(ANNA, '/messages');
  assert.equal(inboxAfterCancellation.status, 200, inboxAfterCancellation.text);
  assert.equal(inboxAfterCancellation.json.eventContacts.some(item => String(item.id) === String(contact.json.conversation.id)), false,
    'cancelled event-contact conversations must not appear in the messages inbox');
  const moderationQueue = await call(ADMIN, '/admin/moderation/reports?status=all');
  assert.ok(moderationQueue.json.reports.some(item => String(item.event_id) === String(reportedEvent.id) && item.event_status === 'cancelled'),
    'deleting a reported event must preserve the report and its audit trail');
});

t('joining is idempotent, capacity is enforced, and organizer cannot leave', async () => {
  const event = await makeEvent(ANNA, { capacity: 2 });
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query("DELETE FROM event_participants WHERE event_id=$1 AND user_id=$2", [event.id, ANNA.id]);
  } finally { await db.end(); }
  const legacyDetail = await call(ANNA, `/events/${event.id}`);
  assert.equal(legacyDetail.status, 200, legacyDetail.text);
  assert.equal(legacyDetail.json.event.participants_count, 1, 'detail count includes organizer without membership row');
  assert.equal(legacyDetail.json.event.joined_by_me, true, 'organizer remains joined without membership row');
  assert.ok((await call(ANNA, '/events/joined-ids')).json.ids.includes(String(event.id)));
  const myEvents = await call(ANNA, '/my/events');
  assert.ok(myEvents.json.events.some(item => String(item.id) === String(event.id) && item.my_status === 'joined' && item.participants_count === 1));
  assert.equal((await join(BORIS, event.id)).status, 200);
  const detailAfterJoin = await call(ANNA, `/events/${event.id}`);
  assert.equal(detailAfterJoin.json.event.participants_count, 2);
  assert.equal((await join(BORIS, event.id)).status, 200);
  assert.equal((await join(VERA, event.id)).status, 409);
  assert.equal((await call(BORIS, `/events/${event.id}/leave`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await join(VERA, event.id)).status, 200);
  assert.equal((await call(ANNA, `/events/${event.id}/leave`, { method: 'POST', body: {} })).status, 409);
  assert.equal((await call(ANNA, `/events/${event.id}/messages`)).status, 200);
});

t('repeated events require dates after the source event and within the three-year planning window', async () => {
  const baseStart = new Date(Date.now() + 3 * 864e5);
  const event = await makeEvent(ANNA, { title: 'Повторяемая встреча', starts_at: baseStart.toISOString() });

  const sameDate = await call(ANNA, `/events/${event.id}/repeat`, {
    method: 'POST', body: { dates: [baseStart.toISOString()] }
  });
  assert.equal(sameDate.status, 400, sameDate.text);

  const beforeSource = await call(ANNA, `/events/${event.id}/repeat`, {
    method: 'POST', body: { dates: [new Date(Date.now() + 864e5).toISOString()] }
  });
  assert.equal(beforeSource.status, 400, beforeSource.text);

  const tooFar = await call(ANNA, `/events/${event.id}/repeat`, {
    method: 'POST', body: { dates: [new Date(Date.now() + 4 * 365 * 864e5).toISOString()] }
  });
  assert.equal(tooFar.status, 400, tooFar.text);

  const validDate = new Date(baseStart.getTime() + 5 * 864e5);
  const repeated = await call(ANNA, `/events/${event.id}/repeat`, {
    method: 'POST', body: { dates: [validDate.toISOString()] }
  });
  assert.equal(repeated.status, 201, repeated.text);
  assert.equal(repeated.json.created_count, 2);
  assert.equal(repeated.json.events.length, 2);
  assert.equal(String(repeated.json.events[0].id), String(event.id));
  const detail = await call(ANNA, `/events/${repeated.json.events[1].id}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(String(detail.json.event.series_id), String(repeated.json.series_id));
});

t('event capacity cannot be reduced below the current joined participant count', async () => {
  const event = await makeEvent(ANNA, { capacity: 5 });
  assert.equal((await join(BORIS, event.id)).status, 200);

  const tooSmall = await call(ANNA, `/events/${event.id}`, {
    method: 'PATCH', body: eventBody({ title: 'Лимит меньше участников', capacity: 1 })
  });
  assert.equal(tooSmall.status, 409, tooSmall.text);
  assert.match(tooSmall.json.error, /лимит меньше текущего количества участников/i);

  const unchanged = await call(ANNA, `/events/${event.id}`);
  assert.equal(unchanged.json.event.capacity, 5, 'failed capacity update must not change the event');

  const exact = await call(ANNA, `/events/${event.id}`, {
    method: 'PATCH', body: eventBody({ title: 'Лимит равен участникам', capacity: 2 })
  });
  assert.equal(exact.status, 200, exact.text);
  assert.equal(exact.json.event.capacity, 2);
});

t('event participant photos and birthdays are visible only to event members', async () => {
  const event = await makeEvent(ANNA, { title: 'Проверка приватности профиля участников' });
  assert.equal((await join(BORIS, event.id)).status, 200);
  assert.equal((await call(BORIS, '/me', { method: 'PATCH', body: { birth_date: '1990-04-01' } })).status, 200);

  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query("UPDATE users SET photo_url=$1 WHERE id=$2", ['https://example.com/private-avatar.jpg', BORIS.id]);
  } finally { await db.end(); }

  const outsider = await call(VERA, `/events/${event.id}`);
  assert.equal(outsider.status, 200, outsider.text);
  const outsiderBoris = outsider.json.participants.find(person => String(person.id) === String(BORIS.id));
  assert.ok(outsiderBoris, 'public event details still include the participant entry');
  assert.equal(outsiderBoris.photo_url, null, 'non-members must not receive the participant photo URL');
  assert.equal(outsiderBoris.birth_date, null, 'non-members must not receive the full birthday');
  assert.equal(outsiderBoris.birth_day, null);
  assert.equal(outsiderBoris.birth_month, null);
  assert.equal(outsiderBoris.birth_year, null);

  const member = await call(ANNA, `/events/${event.id}`);
  const memberBoris = member.json.participants.find(person => String(person.id) === String(BORIS.id));
  assert.equal(memberBoris.photo_url, 'https://example.com/private-avatar.jpg');
  assert.equal(String(memberBoris.birth_date).slice(0, 10), '1990-04-01');
  assert.equal(memberBoris.birth_day, 1);
  assert.equal(memberBoris.birth_month, 4);
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

t('users can block, list and unblock accounts and blocked users cannot request direct messages', async () => {
  const directRequest = await call(ANNA, '/direct/requests', { method: 'POST', body: { user_id: BORIS.id } });
  assert.equal(directRequest.status, 201, directRequest.text);
  const directId = directRequest.json.conversation.id;
  assert.equal((await call(BORIS, `/direct/${directId}/respond`, { method: 'POST', body: { decision: 'accept' } })).status, 200);
  assert.equal((await call(BORIS, `/direct/${directId}/messages`, { method: 'POST', body: { body: 'Личное сообщение до блокировки' } })).status, 201);

  const event = await makeEvent(ANNA, { title: 'Личная переписка для проверки блокировки' });
  assert.equal((await join(BORIS, event.id)).status, 200);
  const eventContact = await call(ANNA, `/events/${event.id}/participants/${BORIS.id}/contact`, { method: 'POST', body: {} });
  assert.equal(eventContact.status, 201, eventContact.text);
  assert.equal((await call(BORIS, `/event-contacts/${eventContact.json.conversation.id}/messages`, { method: 'POST', body: { body: 'Сообщение участника до блокировки' } })).status, 201);
  const unreadBeforeBlock = (await call(ANNA, '/messages/unread-count')).json.unreadCount;

  assert.equal((await call(ANNA, '/messages')).json.direct.some(item => String(item.id) === String(directId)), true);
  assert.equal((await call(ANNA, '/messages')).json.eventContacts.some(item => String(item.id) === String(eventContact.json.conversation.id)), true);

  assert.equal((await call(ANNA, `/users/${ANNA.id}/block`, { method: 'POST', body: {} })).status, 400);
  const blocked = await call(ANNA, `/users/${BORIS.id}/block`, { method: 'POST', body: {} });
  assert.equal(blocked.status, 200, blocked.text);
  assert.equal(blocked.json.blocked, true);
  const inboxWhileBlocked = await call(ANNA, '/messages');
  assert.equal(inboxWhileBlocked.status, 200, inboxWhileBlocked.text);
  assert.equal(inboxWhileBlocked.json.direct.some(item => String(item.id) === String(directId)), false,
    'blocked direct conversations must be hidden from the inbox');
  assert.equal(inboxWhileBlocked.json.eventContacts.some(item => String(item.id) === String(eventContact.json.conversation.id)), false,
    'blocked event-contact conversations must be hidden from the inbox');
  assert.equal((await call(ANNA, '/messages/unread-count')).json.unreadCount, unreadBeforeBlock - 2);
  assert.equal((await call(ANNA, '/messages/read', { method: 'POST', body: { type: 'direct', conversation_id: directId } })).status, 403);
  assert.equal((await call(ANNA, '/messages/read', { method: 'POST', body: { type: 'event_contact', conversation_id: eventContact.json.conversation.id } })).status, 403);
  const list = await call(ANNA, '/users/blocked');
  assert.equal(list.status, 200, list.text);
  assert.ok(list.json.users.some(user => String(user.id) === String(BORIS.id)));
  assert.equal((await call(ANNA, '/direct/requests', { method: 'POST', body: { user_id: BORIS.id } })).status, 403);
  const unblocked = await call(ANNA, `/users/${BORIS.id}/block`, { method: 'DELETE' });
  assert.equal(unblocked.status, 200, unblocked.text);
  assert.equal(unblocked.json.blocked, false);
  const inboxAfterUnblock = await call(ANNA, '/messages');
  assert.equal(inboxAfterUnblock.json.direct.some(item => String(item.id) === String(directId)), true,
    'unblocking restores the direct conversation in the inbox');
  assert.equal(inboxAfterUnblock.json.eventContacts.some(item => String(item.id) === String(eventContact.json.conversation.id)), true,
    'unblocking restores the event-contact conversation in the inbox');
  assert.equal((await call(ANNA, '/messages/unread-count')).json.unreadCount, unreadBeforeBlock);
  assert.equal((await call(ANNA, '/users/blocked')).json.users.some(user => String(user.id) === String(BORIS.id)), false);
  assert.equal((await call(ANNA, `/users/${BORIS.id}/block`, { method: 'DELETE' })).json.unblocked, false);
});

t('a blocked pending direct-message request cannot be accepted', async () => {
  const request = await call(VERA, '/direct/requests', { method: 'POST', body: { user_id: ANNA.id } });
  assert.equal(request.status, 201, request.text);
  const conversationId = request.json.conversation.id;

  const block = await call(ANNA, `/users/${VERA.id}/block`, { method: 'POST', body: {} });
  assert.equal(block.status, 200, block.text);

  const response = await call(ANNA, `/direct/${conversationId}/respond`, {
    method: 'POST', body: { decision: 'accept' }
  });
  assert.equal(response.status, 403, response.text);
  assert.match(response.json.error, /unavailable/i);

  const inbox = await call(ANNA, '/messages');
  assert.equal(inbox.json.direct.some(item => String(item.id) === String(conversationId)), false);
  assert.equal((await call(ANNA, `/users/${VERA.id}/block`, { method: 'DELETE' })).json.blocked, false);
});

t('reporting and moderation require valid reasons, admin login and admin token', async () => {
  const event = await makeEvent(ANNA, { title: 'Проверка жалоб' });
  assert.equal((await call(BORIS, `/events/${event.id}/reports`, { method: 'POST', body: { reason: 'неизвестная причина' } })).status, 400);
  assert.equal((await call(ANNA, `/events/${event.id}/reports`, { method: 'POST', body: { reason: 'spam' } })).status, 400);
  const report = await call(VERA, `/events/${event.id}/reports`, { method: 'POST', body: { reason: 'fake', details: 'Похоже на фейк' } });
  assert.equal(report.status, 201, report.text);
  assert.equal((await call(ADMIN, '/admin/reports')).status, 403);
  assert.equal((await call(ANNA, '/admin/reports', { headers: { 'x-admin-token': 'admintoken' } })).status, 403);
  const list = await call(ADMIN, '/admin/reports', { headers: { 'x-admin-token': 'admintoken' } });
  assert.equal(list.status, 200, list.text);
  const row = list.json.reports.find(item => item.event_id === event.id);
  assert.ok(row);
  assert.equal((await call(ANNA, '/admin/moderation/reports?status=all')).status, 403);
  const miniList = await call(ADMIN, '/admin/moderation/reports?status=all');
  assert.equal(miniList.status, 200, miniList.text);
  assert.ok(miniList.json.reports.some(item => item.event_id === event.id));
  assert.equal((await call(ANNA, `/admin/moderation/reports/${row.id}/actions`)).status, 403);
  const changed = await call(ADMIN, `/admin/moderation/reports/${row.id}`, { method: 'PATCH', body: { status: 'reviewing' } });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.json.changed, true);
  const history = await call(ADMIN, `/admin/moderation/reports/${row.id}/actions`);
  assert.equal(history.status, 200, history.text);
  assert.equal(history.json.actions.length, 1);
  assert.deepEqual([history.json.actions[0].previous_status, history.json.actions[0].new_status, Number(history.json.actions[0].actor_id)], ['open', 'reviewing', ADMIN.id]);
  const unchanged = await call(ADMIN, `/admin/moderation/reports/${row.id}`, { method: 'PATCH', body: { status: 'reviewing' } });
  assert.equal(unchanged.json.changed, false);
  assert.equal((await call(ADMIN, `/admin/moderation/reports/${row.id}/actions`)).json.actions.length, 1);
  const legacyChange = await call(ADMIN, `/admin/reports/${row.id}`, { method: 'PATCH', body: { status: 'resolved' }, headers: { 'x-admin-token': 'admintoken' } });
  assert.equal(legacyChange.status, 200, legacyChange.text);
  assert.equal(legacyChange.json.changed, true);
  const fullHistory = await call(ADMIN, `/admin/moderation/reports/${row.id}/actions`);
  assert.equal(fullHistory.json.actions.length, 2);
  assert.deepEqual([fullHistory.json.actions[0].previous_status, fullHistory.json.actions[0].new_status], ['reviewing', 'resolved']);

  const duplicate = await call(VERA, `/events/${event.id}/reports`, {
    method: 'POST', body: { reason: 'spam', details: 'Повторная отправка не должна менять решение' }
  });
  assert.equal(duplicate.status, 200, duplicate.text);
  assert.equal(duplicate.json.alreadyReported, true);
  assert.equal(String(duplicate.json.reportId), String(row.id));
  assert.equal(duplicate.json.status, 'resolved');
  const afterDuplicate = await call(ADMIN, `/admin/moderation/reports/${row.id}/actions`);
  assert.equal(afterDuplicate.json.actions.length, 2, 'duplicate submission must not create a moderator action');
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


t('physical event deletion removes polymorphic read cursors for group and organizer-participant chats', async () => {
  const event = await makeEvent(ANNA, { title: 'Очистка курсоров после удаления' });
  assert.equal((await join(BORIS, event.id)).status, 200);
  assert.equal((await call(BORIS, `/events/${event.id}/messages`, { method: 'POST', body: { body: 'Сообщение в общем чате' } })).status, 201);
  assert.equal((await call(ANNA, '/messages/read', { method: 'POST', body: { type: 'event', conversation_id: event.id } })).status, 200);

  const contact = await call(ANNA, `/events/${event.id}/participants/${BORIS.id}/contact`, { method: 'POST', body: {} });
  assert.equal(contact.status, 201, contact.text);
  assert.equal((await call(BORIS, `/event-contacts/${contact.json.conversation.id}/messages`, { method: 'POST', body: { body: 'Личное сообщение' } })).status, 201);
  assert.equal((await call(ANNA, '/messages/read', { method: 'POST', body: { type: 'event_contact', conversation_id: contact.json.conversation.id } })).status, 200);

  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const before = await db.query(
      "SELECT conversation_type, conversation_id FROM message_reads WHERE (conversation_type='event' AND conversation_id=$1) OR (conversation_type='event_contact' AND conversation_id=$2)",
      [event.id, contact.json.conversation.id]
    );
    assert.equal(before.rowCount, 2, 'both read cursors exist before deletion');
    const deleted = await call(ANNA, `/events/${event.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200, deleted.text);
    const after = await db.query(
      "SELECT 1 FROM message_reads WHERE (conversation_type='event' AND conversation_id=$1) OR (conversation_type='event_contact' AND conversation_id=$2)",
      [event.id, contact.json.conversation.id]
    );
    assert.equal(after.rowCount, 0, 'event and event-contact cursors must be cleaned with deleted conversations');
  } finally {
    await db.end();
  }
});
