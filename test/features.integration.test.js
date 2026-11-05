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
let eventSequence = 0;
const eventBody = (over = {}) => ({
  title: 'Футбол во дворе ' + (++eventSequence), category: 'Спорт', city: 'Симферополь', address: 'Парк Салгирка',
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

t('agreed moderation policy publishes normal events and rejects contact details without review', async () => {
  const safe = await makeEvent(ANNA, { title: 'Футбол для автоматической проверки', capacity: 1000 });
  assert.equal(safe.status, 'published');

  const vague = await makeEvent(BORIS, { title: 'Встреча', category: 'Другое', description: '', city: 'Не указан' });
  assert.equal(vague.status, 'published', 'short descriptions and missing places must not trigger manual review');

  const shootingRange = await makeEvent(VERA, { title: 'Пойдём в тир', description: 'Постреляем по мишеням' });
  assert.equal(shootingRange.status, 'published');
  const videoGame = await makeEvent(VERA, { title: 'Играем в стрелялки' });
  assert.equal(videoGame.status, 'published');

  const link = await call(BORIS, '/events', {
    method: 'POST', body: eventBody({ title: 'Встреча со ссылкой', description: 'Подробности https://example.com' })
  });
  assert.equal(link.status, 400);
  assert.equal(link.json.code, 'CONTACT_DETAILS_NOT_ALLOWED');
  assert.equal(link.json.field, 'description');

  const phone = await call(BORIS, '/events', {
    method: 'POST', body: eventBody({ title: 'Встреча +7 999 123-45-67' })
  });
  assert.equal(phone.status, 400);
  assert.equal(phone.json.code, 'CONTACT_DETAILS_NOT_ALLOWED');
  assert.equal(phone.json.field, 'title');

  const suspicious = await makeEvent(BORIS, {
    title: 'Встреча', category: 'Другое', description: 'Собираюсь напасть после встречи'
  });
  assert.equal(suspicious.status, 'pending_review');
  const hiddenFromPublic = await call(ANNA, '/events/' + suspicious.id);
  assert.equal(hiddenFromPublic.status, 404);
  assert.equal((await call(BORIS, '/events/' + suspicious.id)).status, 200);
  assert.ok((await call(BORIS, '/events/created')).json.events.some(item => String(item.id) === String(suspicious.id)));

  const denied = await call(ANNA, '/admin/moderation/events?status=all');
  assert.equal(denied.status, 403);
  const queue = await call(ADMIN, '/admin/moderation/events?status=pending_review');
  assert.ok(queue.json.events.some(item => String(item.id) === String(suspicious.id)));
  const approved = await call(ADMIN, '/admin/moderation/events/' + suspicious.id, { method: 'PATCH', body: { action: 'approve' } });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.event.status, 'published');

  const blocked = await makeEvent(VERA, {
    title: 'Запрещённое предложение', description: 'Продам наркотики, доставка сегодня'
  });
  assert.equal(blocked.status, 'cancelled');
  const blockedRow = await call(ADMIN, '/admin/moderation/events?status=cancelled');
  assert.ok(blockedRow.json.events.some(item => String(item.id) === String(blocked.id)));
  const restored = await call(ADMIN, '/admin/moderation/events/' + blocked.id, { method: 'PATCH', body: { action: 'restore' } });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.event.status, 'published');

  const history = await call(ADMIN, '/admin/moderation/events/' + suspicious.id + '/actions');
  assert.equal(history.status, 200, history.text);
  assert.ok(history.json.actions.some(action => action.action === 'auto_sent_to_review' && action.actor_type === 'system'));
  assert.ok(history.json.actions.some(action => action.action === 'approved_by_moderator' && Number(action.actor_id) === ADMIN.id));
  const blockedHistory = await call(ADMIN, '/admin/moderation/events/' + blocked.id + '/actions');
  assert.ok(blockedHistory.json.actions.some(action => action.action === 'auto_blocked' && action.actor_type === 'system'));
  assert.ok(blockedHistory.json.actions.some(action => action.action === 'restored_by_moderator'));

  const duplicateTitle = 'Повторное событие для проверки дубликатов';
  const first = await makeEvent(ANNA, { title: duplicateTitle });
  const duplicate = await makeEvent(VERA, { title: duplicateTitle });
  assert.equal(first.status, 'published');
  assert.equal(duplicate.status, 'published', 'duplicates alone must not trigger manual review');
});
t('event lifecycle enforces organizer permissions and completed-event rules', async () => {
  const event = await makeEvent(ANNA);
  assert.equal((await call(BORIS, `/events/${event.id}`)).status, 200);
  assert.equal((await call(BORIS, `/events/${event.id}`, { method: 'PATCH', body: eventBody({ title: 'Чужое событие' }) })).status, 404);
  assert.equal((await call(ANNA, `/events/${event.id}`, { method: 'PATCH', body: eventBody({ title: 'Новое название' }) })).status, 200);
  assert.equal((await call(ANNA, `/events/${event.id}`)).json.event.title, 'Новое название');
  const startEvent = await call(ANNA, `/events/${event.id}`, {
    method: 'PATCH', body: eventBody({ title: 'Новое название', starts_at: new Date(Date.now() - 60_000).toISOString() })
  });
  assert.equal(startEvent.status, 200, startEvent.text);
  assert.equal((await call(ANNA, `/events/${event.id}/finish`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await join(BORIS, event.id)).status, 409, 'an early finish closes joining immediately while the confirmation worker completes the event');
  assert.equal((await call(ANNA, `/events/${event.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(ANNA, `/events/${event.id}`)).status, 404);

  const reportedEvent = await makeEvent(ANNA, { title: 'Событие с жалобой' });
  await join(BORIS, reportedEvent.id);
  const groupMessage = await call(BORIS, `/events/${reportedEvent.id}/messages`, { method: 'POST', body: { body: 'Сообщение в общем чате перед отменой' } });
  assert.equal(groupMessage.status, 201, groupMessage.text);
  const contact = await call(ANNA, `/events/${reportedEvent.id}/participants/${BORIS.id}/contact`, { method: 'POST', body: {} });
  assert.equal(contact.status, 201, contact.text);
  assert.equal((await call(BORIS, `/event-contacts/${contact.json.conversation.id}/messages`, { method: 'POST', body: { body: 'Сообщение перед отменой' } })).status, 201);
  assert.equal((await call(VERA, `/event-contacts/${contact.json.conversation.id}/messages`)).status, 404,
    'users outside an event-contact conversation must not read its messages');
  assert.equal((await call(VERA, `/event-contacts/${contact.json.conversation.id}/messages`, { method: 'POST', body: { body: 'Чужое сообщение' } })).status, 404,
    'users outside an event-contact conversation must not send messages');
  assert.equal((await call(VERA, `/events/${reportedEvent.id}/participants/${BORIS.id}/contact`, { method: 'POST', body: {} })).status, 403,
    'only the event organizer may open an organizer-to-participant conversation');
  const unreadBeforeCancel = (await call(ANNA, '/messages/unread-count')).json.unreadCount;
  const report = await call(BORIS, `/events/${reportedEvent.id}/reports`, { method: 'POST', body: { reason: 'unsafe', details: 'Проверка сохранения истории' } });
  assert.equal(report.status, 201, report.text);
  const deletion = await call(ANNA, `/events/${reportedEvent.id}`, { method: 'DELETE' });
  assert.equal(deletion.status, 200, deletion.text);
  assert.equal(deletion.json.archived, true);
  assert.equal((await call(ANNA, `/events/${reportedEvent.id}`)).status, 404);
  assert.equal((await call(ANNA, `/events/${reportedEvent.id}/messages`)).status, 403);
  assert.equal((await call(BORIS, '/events/joined-ids')).json.ids.includes(String(reportedEvent.id)), false,
    'cancelled events must not remain in a user\'s joined event IDs');
  assert.equal((await call(ANNA, `/events/${reportedEvent.id}/messages`, { method: 'POST', body: { body: 'После отмены' } })).status, 403);
  assert.equal((await call(ANNA, `/event-contacts/${contact.json.conversation.id}/messages`)).status, 404);
  assert.equal((await call(ANNA, `/event-contacts/${contact.json.conversation.id}/messages`, { method: 'POST', body: { body: 'После отмены' } })).status, 404);
  assert.equal((await call(ANNA, '/messages/unread-count')).json.unreadCount, unreadBeforeCancel - 2);
  assert.equal((await call(ANNA, '/messages/read', { method: 'POST', body: { type: 'event_contact', conversation_id: contact.json.conversation.id } })).status, 403);
  const inboxAfterCancellation = await call(ANNA, '/messages');
  assert.equal(inboxAfterCancellation.status, 200, inboxAfterCancellation.text);
  assert.equal(inboxAfterCancellation.json.eventContacts.some(item => String(item.id) === String(contact.json.conversation.id)), false,
    'cancelled event-contact conversations must not appear in the messages inbox');
  assert.equal(inboxAfterCancellation.json.eventChats.some(item => String(item.event_id) === String(reportedEvent.id)), false,
    'cancelled event group chats must not appear in the messages inbox');
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

t('event age range and organizer note persist across create, edit and dedicated update', async () => {
  const event = await makeEvent(ANNA, { age_range: '25–35', live_note: 'Берём воду' });
  assert.equal(event.age_range, '25–35');
  assert.equal(event.live_note, 'Берём воду');

  const edited = await call(ANNA, `/events/${event.id}`, {
    method: 'PATCH', body: eventBody({ title: 'Обновлённая встреча', age_range: '18+', live_note: 'Начинаем вовремя' })
  });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.event.age_range, '18+');
  assert.equal(edited.json.event.live_note, 'Начинаем вовремя');

  const note = await call(ANNA, `/events/${event.id}/live-note`, {
    method: 'PATCH', body: { live_note: 'Мы уже на месте' }
  });
  assert.equal(note.status, 200, note.text);
  assert.equal(note.json.live_note, 'Мы уже на месте');
  assert.equal((await call(BORIS, `/events/${event.id}/live-note`, {
    method: 'PATCH', body: { live_note: 'Чужая заметка' }
  })).status, 404);
  assert.equal((await call(ANNA, '/events', {
    method: 'POST', body: eventBody({ age_range: '0–101' })
  })).status, 400);
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

t('favorites and activity count legacy organizers without a membership row', async () => {
  const event = await makeEvent(ANNA, { title: 'Старое событие без строки организатора' });
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('DELETE FROM event_participants WHERE event_id=$1 AND user_id=$2', [event.id, ANNA.id]);
  } finally {
    await db.end();
  }

  assert.equal((await call(ANNA, `/events/${event.id}/favorite`, { method: 'POST', body: {} })).status, 200);
  const favorites = await call(ANNA, '/favorites');
  const favorite = favorites.json.events.find(item => String(item.id) === String(event.id));
  assert.equal(favorite.participants_count, 1);

  const activity = await call(ANNA, '/me/activity');
  const ownActivity = activity.json.events.find(item => String(item.id) === String(event.id));
  assert.equal(ownActivity.participants_count, 1);
  assert.equal(ownActivity.my_role, 'organizer');
});

t('event participant photos are visible only to event members and birthdays remain private', async () => {
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
  assert.equal(memberBoris.birth_date, null, 'even event members must not receive another user\'s full birthday');
  assert.equal(memberBoris.birth_day, null);
  assert.equal(memberBoris.birth_month, null);
  assert.equal(memberBoris.birth_year, null);
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
  assert.equal((await call(ANNA, `/direct/${directId}/messages`)).status, 403,
    'blocked direct conversations must not expose message history');
  assert.equal((await call(ANNA, `/event-contacts/${eventContact.json.conversation.id}/messages`)).status, 403,
    'blocked event-contact conversations must not expose message history');
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


t('age limits never hide meetings and organizer approval is scoped to one participant and event', async () => {
  const birth = await call(BORIS, '/me', { method: 'PATCH', body: { birth_date: '2009-01-01' } });
  assert.equal(birth.status, 200, birth.text);

  const categories = ['Спорт', 'Прогулки', 'Путешествия', 'Вечеринки'];
  const events = [];
  for (const category of categories) {
    events.push(await makeEvent(ANNA, {
      title: 'Открытая встреча · ' + category,
      category,
      age_range: '18+'
    }));
  }

  const listing = await call(VERA, '/events?city=Симферополь');
  assert.equal(listing.status, 200, listing.text);
  for (const event of events) {
    assert.ok(listing.json.events.some(item => String(item.id) === String(event.id)),
      'age-restricted events must remain visible in every category');
  }

  const target = events[1];
  const denied = await join(BORIS, target.id);
  assert.equal(denied.status, 403, denied.text);
  assert.equal(denied.json.code, 'AGE_RESTRICTION');

  const contact = await call(BORIS, `/events/${target.id}/contact`, { method: 'POST', body: {} });
  assert.equal(contact.status, 201, contact.text);
  const conversationId = contact.json.conversation.id;
  assert.equal((await call(BORIS, `/event-contacts/${conversationId}/messages`, {
    method: 'POST', body: { body: 'Можно ли мне присоединиться?' }
  })).status, 201);

  const forbiddenApproval = await call(VERA, `/event-contacts/${conversationId}/age-approval`, { method: 'POST', body: {} });
  assert.equal(forbiddenApproval.status, 403, 'only this event organizer can approve');

  const approval = await call(ANNA, `/event-contacts/${conversationId}/age-approval`, { method: 'POST', body: {} });
  assert.equal(approval.status, 200, approval.text);
  assert.equal(approval.json.approved, true);
  const approvedConversation = await call(BORIS, `/event-contacts/${conversationId}/messages`);
  assert.equal(approvedConversation.json.conversation.age_approved, true,
    'the participant conversation must expose the approval state so the UI can offer the join action');
  assert.equal((await join(BORIS, target.id)).status, 200,
    'the approved participant can join despite the age range');

  const otherEventDenied = await join(BORIS, events[2].id);
  assert.equal(otherEventDenied.status, 403,
    'approval for one meeting must not grant access to another meeting');
});


t('simultaneous joins cannot exceed event capacity', async () => {
  const full = await makeEvent(ANNA, { title: 'Одновременная запись на последнее место', capacity: 2 });
  const joins = await Promise.all([join(BORIS, full.id), join(VERA, full.id)]);
  assert.deepEqual(joins.map(result => result.status).sort(), [200, 409],
    'only one of two simultaneous users can claim the final place');
  const detail = await call(ANNA, `/events/${full.id}`);
  assert.equal(detail.json.event.participants_count, 2, 'capacity must remain exact after concurrent joins');
});
