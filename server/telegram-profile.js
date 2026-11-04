const crypto = require('node:crypto');
const sharp = require('sharp');

async function telegramRequest(token, method, payload) {
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(result?.description || ('Telegram ' + method + ' failed: ' + response.status));
  return result.result;
}

async function syncTelegramProfile(pool, userId, botToken) {
  const tasks = await Promise.allSettled([
    telegramRequest(botToken, 'getChat', { chat_id: userId }),
    telegramRequest(botToken, 'getUserProfilePhotos', { user_id: userId, offset: 0, limit: 1 })
  ]);

  const chat = tasks[0].status === 'fulfilled' ? tasks[0].value : null;
  const photos = tasks[1].status === 'fulfilled' ? tasks[1].value : null;
  const birthday = chat?.birthdate;
  if (birthday && Number.isInteger(birthday.day) && Number.isInteger(birthday.month)) {
    const year = Number.isInteger(birthday.year) && birthday.year >= 1900 && birthday.year <= new Date().getFullYear() ? birthday.year : null;
    const fullDate = year ? year + '-' + String(birthday.month).padStart(2, '0') + '-' + String(birthday.day).padStart(2, '0') : null;
    await pool.query(
      `UPDATE users SET birth_day=$2, birth_month=$3, birth_year=$4,
       birth_date=COALESCE($5::date,birth_date), updated_at=NOW() WHERE id=$1`,
      [userId, birthday.day, birthday.month, year, fullDate]
    );
  }

  const sizes = photos?.photos?.[0];
  if (!Array.isArray(sizes) || !sizes.length) return;
  const largest = sizes.reduce((best, item) => Number(item.file_size || 0) >= Number(best.file_size || 0) ? item : best, sizes[0]);
  try {
    const file = await telegramRequest(botToken, 'getFile', { file_id: largest.file_id });
    if (!file?.file_path) return;
    const response = await fetch('https://api.telegram.org/file/bot' + botToken + '/' + file.file_path, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Telegram photo download failed: ' + response.status);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 8 * 1024 * 1024) throw new Error('Telegram profile photo is too large');
    const source = Buffer.from(await response.arrayBuffer());
    if (!source.length || source.length > 8 * 1024 * 1024) throw new Error('Telegram profile photo has an invalid size');
    const image = await sharp(source, { limitInputPixels: 20_000_000 }).rotate().resize(512, 512, { fit: 'cover' }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
    const avatarKey = crypto.randomBytes(20).toString('hex');
    await pool.query(
      `UPDATE users SET photo_data=$2, photo_mime='image/jpeg', avatar_key=$3,
       photo_url=$4, updated_at=NOW() WHERE id=$1`,
      [userId, image, avatarKey, '/media/avatars/' + avatarKey]
    );
  } catch (error) {
    // Keep the last known-good photo (or Telegram's initData photo_url) if a refresh fails.
    console.warn('Telegram profile photo sync skipped:', error.message);
  }
}

module.exports = { syncTelegramProfile };
