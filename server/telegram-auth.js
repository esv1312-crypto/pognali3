const crypto = require('node:crypto');

function verifyTelegramInitData(initData, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!initData || !botToken) return { ok: false, error: 'Telegram authentication is not configured' };
  let params;
  try { params = new URLSearchParams(initData); } catch { return { ok: false, error: 'Invalid initData' }; }

  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return { ok: false, error: 'Missing or invalid hash' };
  params.delete('hash');

  // Bot-token HMAC validation includes every initData field except "hash".
  // The "signature" field is excluded only for Telegram's separate Ed25519 validation flow.
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + '=' + value)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const suppliedHash = Buffer.from(receivedHash, 'hex');
  if (suppliedHash.length !== calculatedHash.length || !crypto.timingSafeEqual(suppliedHash, calculatedHash)) {
    return { ok: false, error: 'Telegram signature verification failed' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > 86400) {
    return { ok: false, error: 'Telegram login expired; reopen the Mini App' };
  }

  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) {
    return { ok: false, error: 'Telegram user is missing' };
  }
  return { ok: true, user: {
    id: String(user.id),
    username: typeof user.username === 'string' ? user.username.slice(0, 64) : null,
    first_name: typeof user.first_name === 'string' ? user.first_name.slice(0, 128) : '',
    last_name: typeof user.last_name === 'string' ? user.last_name.slice(0, 128) : '',
    photo_url: typeof user.photo_url === 'string' && user.photo_url.startsWith('https://') ? user.photo_url.slice(0, 2048) : null
  }};
}

module.exports = { verifyTelegramInitData };
