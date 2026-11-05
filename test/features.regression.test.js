const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'docs', 'telegram', 'index.html'), 'utf8');

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

test('incremental chat polling validates numeric cursors and appends only new messages', () => {
  assert.ok(server.includes('function parseAfterMessageId(req, res)'));
  assert.match(server, /!\/\^\\d\{1,19\}\$\/\.test\(raw\)/);
  assert.doesNotMatch(server, /!\/\^\\\\d\{1,19\}\$\/\.test\(raw\)/);
  assert.ok(server.split('m.id>$2').length - 1 >= 3);
  assert.ok(page.includes("route.path + '?after_id=' + encodeURIComponent(state.lastMessageId || '0')"));
  assert.ok(page.includes("box.insertAdjacentHTML('beforeend'"));
  assert.ok(!page.includes('box.innerHTML = messages.map(message =>'));
});
