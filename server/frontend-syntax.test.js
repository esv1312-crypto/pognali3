const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Telegram Mini App inline JavaScript parses', () => {
  const file = path.join(__dirname, '..', 'docs', 'telegram', 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  assert.ok(scripts.length > 0, 'expected inline application script');
  for (const source of scripts) assert.doesNotThrow(() => new Function(source));
});
