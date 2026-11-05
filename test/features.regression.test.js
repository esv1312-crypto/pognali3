const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'docs', 'telegram', 'index.html'), 'utf8');
test('age range bounds parse preset and custom numeric ranges correctly', () => {
  const start = server.indexOf('function eventAgeBounds(value)');
  const end = server.indexOf('function ageOnDate(', start);
  const helper = server.slice(start, end);
  assert.match(helper, /range\.match\(\/\^\(\\d\{1,2\}\)\[–-\]\(\\d\{1,2\}\)\$\/\)/);
  assert.doesNotMatch(helper, /\\\\d\{1,2\}/);
  assert.ok(helper.includes("if (range === '18–30')") === false);
  assert.ok(server.includes("if (range === '18+') return { min: 18, max: null }"));
});

test('participant lists never expose another user\'s date of birth', () => {
  const start = server.indexOf("app.get('/api/events/:id'");
  const end = server.indexOf("app.post('/api/events'", start);
  const route = server.slice(start, end);
  assert.ok(route.includes('NULL::date AS birth_date'));
  assert.ok(route.includes('NULL::smallint AS birth_year'));
  assert.doesNotMatch(route, /viewer\.can_view_private_profile THEN u\.birth_/);
});

test('profile explains that date of birth is private', () => {
  assert.ok(page.includes('Дата рождения хранится в профиле «Погнали» и не показывается другим участникам.'));
  assert.doesNotMatch(page, /дата рождения из Telegram сохраняются в профиле «Погнали» и видны другим участникам/);
});

test('event contact chat exposes a join action after an organizer approves an age exception', () => {
  assert.ok(page.includes('data.conversation?.age_approved'));
  assert.ok(page.includes('Исключение разрешено — присоединиться'));
  assert.ok(server.includes('AS age_approved'));
  assert.ok(server.includes('Организатор разрешил тебе присоединиться к событию'));
  assert.ok(page.includes('ageExceptionJoinButton'));
  assert.ok(page.includes('result.conversation?.age_approved'));
});

test('repeat-event feature is removed from the user interface and API', () => {
  assert.doesNotMatch(page, /openRepeatEvent|submitRepeatEvent|repeatCalendarMonth|Повторять встречу/);
  assert.doesNotMatch(server, /app\\.post\\('\\/api\\/events\\/:id\\/repeat'/);
});


test('bot /id response uses a real line break escape, not a literal \\n', () => {
  assert.match(server, /Твой Telegram ID:[^\n]*\\nСкопируй/);
  assert.doesNotMatch(server, /Твой Telegram ID:[^\n]*\\\\nСкопируй/);
});

test('missing event invitation does not fall through to generic welcome', () => {
  assert.match(server, /let notFoundStart = false/);
  assert.match(server, /notFoundStart = true/);
  assert.match(server, /!response && !notFoundStart && \(text\.toLowerCase\(\)\.startsWith\('\/start'\)/);
});

test('unread event-chat badges are capped per conversation and the aggregate query is bounded', () => {
  assert.ok(server.includes('LIMIT 99) q) AS unread_count'));
  assert.ok(server.includes('LIMIT 9900) event_unread'));
});

test('organizer cannot leave their own event through the API', () => {
  assert.match(server, /SELECT creator_id FROM events WHERE id=\$1/);
  assert.match(server, /status\(409\)\.json\(\{ error: 'Организатор не может выйти из своего события/);
});

test('report IDs use a working numeric validation regex', () => {
  assert.match(server, /!\/\^\[1-9\]\\d\{0,18\}\$\/\.test\(id\)/);
  assert.doesNotMatch(server, /!\/\^\[1-9\]\\\\d\{0,18\}\$\/\.test\(id\)/);
});

test('organizer does not see the leave button in event cards or details', () => {
  assert.ok((page.match(/joined&&e\.owner===2\?'':/g) || []).length >= 2);
});

test('all open chat types start a five-second refresh loop', () => {
  assert.ok(page.includes('function startChatPolling(type, id, lastMessageId)'));
  assert.ok(page.includes("startChatPolling('event', id, lastMessageId)"));
  assert.ok(page.includes("startChatPolling('direct', id, lastMessageId)"));
  assert.ok(page.includes("startChatPolling('event_contact', conversationId, lastMessageId)"));
  assert.ok(page.includes('}, 5000);'));
});

test('opening personal messages from a direct chat closes the modal before navigation', () => {
  const start = page.indexOf('async function openPersonalMessages');
  const end = page.indexOf('async function loadDirectInbox', start);
  const handler = page.slice(start, end);
  const closeAt = handler.indexOf('closeModal()');
  const navigateAt = handler.indexOf("go('messages')");
  assert.ok(closeAt >= 0 && navigateAt > closeAt);
});

test('MapLibre initialization waits for the vendor module and falls back to list mode on failure', () => {
  assert.ok(page.includes('pognali-maplibre-ready'));
  assert.ok(page.includes('pognali-maplibre-failed'));
  assert.ok(page.includes('if (!window.maplibregl)'));
});

test('event end time from the API is used by the client event-state logic', () => {
  assert.ok(page.includes('endAt:x.ends_at||null'));
  assert.ok(page.includes('const explicitEnd=e.endAt||e.end_at||e.endDateTime||e.end_datetime'));
});

test('open chat polling requests only messages after the last received ID', () => {
  assert.ok(page.includes("route.path + '?after_id=' + encodeURIComponent(state.lastMessageId || '0')"));
  assert.ok(page.includes("box.insertAdjacentHTML('beforeend'"));
  assert.ok(!page.includes('box.innerHTML = messages.map(message =>'));
  assert.ok(server.includes('function parseAfterMessageId(req, res)'));
  assert.ok((server.match(/m\.id>\$2/g) || []).length >= 3);
});


test('participant list hydrates real members and Telegram IDs before showing profiles', () => {
  const start = page.indexOf('async function openParticipants');
  const end = page.indexOf('async function openChat', start);
  const handler = page.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /apiRequest\('\/events\//);
  assert.match(handler, /detail\.participants/);
  assert.match(handler, /telegramId:String\(p\.id\)/);
  assert.match(handler, /showToast\(error\.message\|\|'Не удалось загрузить участников'/);
});


test('event detail hydrates organizer Telegram ID even for legacy events without a participant row', () => {
  const start = page.indexOf('async function openEvent');
  const end = page.indexOf('function reportEvent', start);
  const handler = page.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /ev\.owner=localUserId\(raw\.creator_id\);if\(ev\.owner!==2\)db\.users\[ev\.owner\]=/);
  assert.match(handler, /telegramId:String\(raw\.creator_id\)/);
});


test('organizer cannot finish a published event before its start time', () => {
  const start = server.indexOf("app.post('/api/events/:id/finish'");
  const end = server.indexOf("app.get('/api/events/:id/messages'", start);
  const route = server.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(route, /starts_at <= NOW\(\)/);
  assert.match(route, /status\(409\)\.json\(\{ error: 'Завершить событие можно только после начала встречи'/);
});


test('Telegram notifications use a durable PostgreSQL outbox with retry and persistent deduplication', () => {
  assert.ok(server.includes('telegram_notification_outbox'));
  assert.ok(server.includes('telegram_notification_dedup'));
  assert.ok(server.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(server.includes("'telegram-notify:' + dedupeKey"));
  assert.ok(server.includes("'telegram-notify:' + job.dedupe_key"));
  assert.ok(server.includes("SET status='pending',available_at=NOW(),locked_at=NULL WHERE status='sending' AND locked_at < NOW() - INTERVAL '2 minutes'"));
  assert.ok(server.includes("CASE WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END"));
  assert.ok(server.includes('ON CONFLICT(dedupe_key) DO UPDATE SET last_sent_at=EXCLUDED.last_sent_at'));
  assert.ok(server.includes('await startNotificationWorker()'));
});


test('message sends and direct requests serialize with block operations using a shared pair lock', () => {
  const helper = server.slice(server.indexOf('function sortedUserPair'), server.indexOf("app.get('/api/users/search'"));
  assert.ok(helper.includes('async function lockMessagingPair(client,a,b)'));
  assert.ok(helper.includes('pg_advisory_xact_lock(hashtextextended'));
  const block = server.slice(server.indexOf("app.post('/api/users/:id/block'"), server.indexOf("app.get('/api/messages/organized-events'"));
  assert.ok(block.includes('await lockMessagingPair(client,actor,target)'));
  const direct = server.slice(server.indexOf("app.post('/api/direct/:id/messages'"), server.indexOf("app.get('/api/users/blocked'"));
  assert.ok(direct.includes('await lockMessagingPair(client,actor,other)'));
  const contact = server.slice(server.indexOf("app.post('/api/event-contacts/:id/messages'"), server.indexOf('async function recordEventShareAction'));
  assert.ok(contact.includes('await lockMessagingPair(client,actor,other)'));
  const requests = server.slice(server.indexOf("app.post('/api/direct/requests'"), server.indexOf("app.post('/api/direct/:id/respond'"));
  assert.ok(requests.includes('await lockMessagingPair(client,actor,target)'));
});


test('new report notifications use the durable PostgreSQL outbox', () => {
  const start = server.indexOf("app.post('/api/events/:id/reports'");
  const end = server.indexOf("app.post('/api/events/:id/prepare-share'", start);
  const route = server.slice(start, end);
  assert.ok(route.includes("notifyUser(adminChatId, note, 'event-report:' + reportId, 0)"));
  assert.ok(!route.includes('sendTelegramMessage(adminChatId, note)'));
});


test('legacy admin middleware checks both Telegram allowlist and timing-safe token validation', () => {
  const start = server.indexOf('function requireAdmin(req, res, next)');
  const end = server.indexOf("app.get('/api/admin/reports'", start);
  const middleware = server.slice(start, end);
  assert.ok(middleware.includes('isAdminTelegramUser(req.telegramUser.id)'));
  assert.ok(middleware.includes('process.env.ADMIN_API_TOKEN'));
  assert.ok(middleware.includes('timingSafeEqual'));
  assert.ok(middleware.includes('supplied.length !== configured.length'));
});


test('moderator event cancellation records an audit action transactionally', () => {
  assert.ok(server.includes("INSERT INTO event_moderation_actions(event_id,actor_id,action,previous_status,new_status)"));
  assert.ok(server.includes("app.get('/api/admin/moderation/events/:id/actions',requireTelegramAdmin"));
  assert.ok(server.includes('event_moderation_actions'));
});


test('organizer removal archives events with moderator audit history', () => {
  const start = server.indexOf("app.delete('/api/events/:id'");
  const end = server.indexOf("app.post('/api/events/:id/finish'", start);
  const route = server.slice(start, end);
  assert.ok(route.includes('FROM event_moderation_actions WHERE event_id=$1'));
  assert.ok(route.includes('const archived = existingModerationHistory.rowCount > 0'));
});


test('notification enqueue handles pool connection failures without an unhandled rejection', () => {
  const start = server.indexOf('async function notifyUser(');
  const end = server.indexOf('async function processTelegramNotification()', start);
  const helper = server.slice(start, end);
  assert.ok(helper.includes('let client;'));
  assert.ok(helper.indexOf('try {') < helper.indexOf('client = await pool.connect()'));
  assert.ok(helper.includes('client?.release()'));
});

test('report event metadata is loaded before persisting a report', () => {
  const start = server.indexOf("app.post('/api/events/:id/reports'");
  const end = server.indexOf("app.post('/api/events/:id/prepare-share'", start);
  const route = server.slice(start, end);
  assert.ok(route.indexOf('SELECT id, creator_id, status, title, city FROM events') < route.indexOf('INSERT INTO event_reports'));
  assert.ok(!route.includes("SELECT title, city FROM events WHERE id=$1"));
});


test('admin event details expose moderation history through the protected audit endpoint', () => {
  assert.ok(page.includes('async function openAdminEventHistory(id)'));
  assert.ok(page.includes("'/admin/moderation/events/'+encodeURIComponent(id)+'/actions'"));
  assert.ok(page.includes('openAdminEventHistory(${e.id})'));
  assert.ok(page.includes('История модерации события'));
});


test('admin moderation environment variables are documented in the example file', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.ok(example.includes('ADMIN_TELEGRAM_IDS='));
  assert.ok(example.includes('ADMIN_API_TOKEN='));
  assert.ok(example.includes('ADMIN_TELEGRAM_CHAT_ID='));
});


test('notification worker backs off while idle but drains queued jobs promptly', () => {
  const start = server.indexOf('async function processTelegramNotification()');
  const end = server.indexOf('async function startNotificationWorker()', start);
  const worker = server.slice(start, end);
  assert.ok(worker.includes('let processed = false;'));
  assert.ok(worker.includes('if (processed)'));
  assert.ok(worker.includes('setTimeout(() => { void processTelegramNotification(); }, 100)'));
  assert.ok(server.includes('notificationWorkerTimer = setInterval(() => { void processTelegramNotification(); }, 2000)'));
});
