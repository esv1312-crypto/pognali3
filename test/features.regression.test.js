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

test('unread event-message counts are capped at 99 in both API responses', () => {
  assert.ok((server.match(/LIMIT 99\) q/g) || []).length >= 2);
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
