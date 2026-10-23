const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyTelegramInitData } = require('../server/telegram-auth');

function makeInitData(user, botToken, authDate, extra = {}) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAExampleQuery',
    user: JSON.stringify(user),
    ...extra
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('accepts valid Telegram initData and returns normalized user', () => {
  const now = 1_800_000_000;
  const token = 'test-bot-token';
  const initData = makeInitData({ id: 12345, first_name: 'Test', username: 'tester' }, token, now - 60);
  const result = verifyTelegramInitData(initData, token, now);
  assert.equal(result.ok, true);
  assert.equal(result.user.id, '12345');
  assert.equal(result.user.first_name, 'Test');
  assert.equal(result.user.username, 'tester');
});

test('rejects expired Telegram initData with a reopen hint', () => {
  const now = 1_800_000_000;
  const token = 'test-bot-token';
  const initData = makeInitData({ id: 12345, first_name: 'Test' }, token, now - 86401);
  const result = verifyTelegramInitData(initData, token, now);
  assert.equal(result.ok, false);
  assert.match(result.error, /expired/i);
});

test('rejects initData signed with a different bot token', () => {
  const now = 1_800_000_000;
  const initData = makeInitData({ id: 12345, first_name: 'Test' }, 'right-token', now - 60);
  const result = verifyTelegramInitData(initData, 'wrong-token', now);
  assert.equal(result.ok, false);
  assert.match(result.error, /signature/i);
});

test('rejects malformed user data even when the signature is valid', () => {
  const now = 1_800_000_000;
  const token = 'test-bot-token';
  const initData = makeInitData({ id: 0, first_name: 'Test' }, token, now - 60);
  const result = verifyTelegramInitData(initData, token, now);
  assert.equal(result.ok, false);
  assert.match(result.error, /user/i);
});
