// Regression guards for Pognali update 3.
// These are source-level checks for previously identified regressions; they complement, not replace,
// the API integration suite and manual Telegram-on-device checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'docs/telegram/index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('admin report IDs use a digit regex that accepts ordinary positive IDs', () => {
  assert.match(server, /if \(!\/\^\[1-9\]\\d\{0,18\}\$\/\.test\(id\)/);
});

test('organizers cannot leave their own event and lose access to its chat', () => {
  assert.match(server, /Организатор не может выйти из своего события/);
  assert.match(server, /res\.status\(409\).*Организатор не может выйти/s);
});

test('organizers do not get a leave button in event cards or the event detail modal', () => {
  const ownerGuard = "joined&&e.owner===2?'':`<button";
  assert.ok(html.split(ownerGuard).length - 1 >= 2, 'both card and modal should hide the leave button');
});

test('expired event invitations do not fall back to the generic welcome photo', () => {
  assert.match(server, /notFoundStart = true/);
  assert.match(server, /!notFoundStart && \(text\.toLowerCase\(\)\.startsWith\('\/start'\)/);
});

test('event unread counters cap per-chat scans at 99 messages', () => {
  assert.ok((server.match(/LIMIT 99/g) || []).length >= 2);
});

test('the bot /id response uses an actual newline escape in its message string', () => {
  assert.match(server, /\\nСкопируй этот номер для настройки уведомлений администратора/);
  assert.doesNotMatch(server, /\\\\nСкопируй этот номер для настройки уведомлений администратора/);
});

test('MapLibre is pinned to 6.15.0 and served through the matching ESM paths', () => {
  assert.equal(pkg.dependencies['maplibre-gl'], '6.15.0');
  assert.ok(html.includes('/vendor/maplibre-gl-6.15.0/maplibre-gl.mjs'));
  assert.ok(html.includes('/vendor/maplibre-gl-6.15.0/maplibre-gl-worker.mjs'));
});
