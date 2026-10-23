const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyTelegramInitData } = require('./telegram-auth');

function signedInitData(token, values) {
  const params = new URLSearchParams(values);
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => k+'='+v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

test('accepts a valid Telegram initData payload', () => {
  const token = '123456:test-token';
  const now = 1800000000;
  const data = signedInitData(token, {
    auth_date: String(now),
    query_id: 'AAE-test',
    user: JSON.stringify({id: 123456789, first_name: 'Test', username: 'tester', photo_url: 'https://t.me/i/userpic/320/test.jpg'})
  });
  const result = verifyTelegramInitData(data, token, now);
  assert.equal(result.ok, true);
  assert.equal(result.user.id, '123456789');
  assert.equal(result.user.first_name, 'Test');
});

test('rejects a modified payload', () => {
  const token = '123456:test-token';
  const now = 1800000000;
  const data = signedInitData(token, {auth_date:String(now), user:JSON.stringify({id:123,first_name:'A'})})
    .replace('first_name%22%3A%22A', 'first_name%22%3A%22B');
  assert.equal(verifyTelegramInitData(data, token, now).ok, false);
});

test('rejects expired initData', () => {
  const token = '123456:test-token';
  const now = 1800000000;
  const data = signedInitData(token, {auth_date:String(now-86401), user:JSON.stringify({id:123,first_name:'A'})});
  assert.match(verifyTelegramInitData(data, token, now).error, /expired/i);
});
