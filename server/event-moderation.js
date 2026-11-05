// Moderation is intentionally narrow: ordinary events are published automatically.
// Contact details are rejected by validateEventContactText before moderation; they do not
// trigger account penalties or a manual-review queue.
const BLOCK_PATTERNS = [
  /(?:продам|продажа|купить|куплю|доставка|закладки|заказать).{0,60}(?:наркот\w*|кокаин\w*|героин\w*|мефедрон\w*|метамфетамин\w*)/iu,
  /(?:наркот\w*|кокаин\w*|героин\w*|мефедрон\w*|метамфетамин\w*).{0,60}(?:продам|продажа|купить|куплю|доставка|закладки|заказать)/iu,
  /(?:эксплуатац\w*|торговл\w* людьми|вовлечени\w*).{0,50}(?:несовершеннолетн\w*|дет\w*|человек\w*)/iu,
  /(?:несовершеннолетн\w*|дет\w*).{0,50}(?:проституц\w*|эскорт\w*|эксплуатац\w*)/iu,
  /(?:давайте|собираемся|планирую|хочу|нужно|мы).{0,45}(?:убить|избить|напасть|поджечь|взорвать|похитить).{0,45}(?:человек\w*|люд\w*|здан\w*|школ\w*|толп\w*|кого-то|кого нибудь)/iu,
  /(?:организуем|планируем|готовим).{0,45}(?:нападени\w*|теракт\w*|поджог\w*|похищени\w*|разбой\w*)/iu
];

const REVIEW_PATTERNS = [
  /(?:хочу|планирую|собираюсь|давайте).{0,40}(?:убить|избить|напасть|поджечь|взорвать|похитить)/iu,
  /(?:организуем|планируем|готовим).{0,40}(?:нападени\w*|теракт\w*|поджог\w*|похищени\w*)/iu,
  /(?:принуждени\w*|шантаж\w*|угроз\w* расправ\w*|насильственн\w* удержани\w*)/iu
];

function normalize(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

// URLs, social handles and phone numbers are not allowed in event title/description.
// Physical addresses and venue names are separate fields and remain allowed.
function findForbiddenContact(value) {
  const text = String(value || '').normalize('NFKC');
  const url = /(?:https?:\/\/|www\.)\S+|(?:^|\s)(?:t\.me|telegram\.me|wa\.me|vk\.com|instagram\.com|facebook\.com|youtube\.com|discord\.gg)\/?\S*|(?:^|\s)(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/iu;
  if (url.test(text)) return 'link';
  if (/(?:^|\s)@[a-z0-9_]{4,}/iu.test(text)) return 'handle';
  const candidates = text.match(/(?:\+|(?<!\w)(?:7|8)[\s().-]*)?(?:\d[\s().-]*){9,14}\d/gu) || [];
  if (candidates.some(candidate => {
    const digits = candidate.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15;
  })) return 'phone';
  return null;
}

function validateEventContactText(event) {
  for (const field of ['title', 'description']) {
    const kind = findForbiddenContact(event?.[field]);
    if (kind) return { field, kind, code: 'CONTACT_DETAILS_NOT_ALLOWED' };
  }
  return null;
}

function classifyEventText(event) {
  const text = [event.title, event.description, event.category].map(value => String(value || '')).join('\n');
  if (BLOCK_PATTERNS.some(pattern => pattern.test(text))) {
    return { status: 'cancelled', decision: 'auto_blocked', reasons: ['Обнаружено явное предложение запрещённой или опасной деятельности'] };
  }
  if (REVIEW_PATTERNS.some(pattern => pattern.test(text))) {
    return { status: 'pending_review', decision: 'auto_sent_to_review', reasons: ['Нужна проверка возможной угрозы или насилия'] };
  }
  return { status: 'published', decision: 'auto_published', reasons: [] };
}

async function evaluateEventModeration(_db, event) {
  // No automatic penalties for event frequency, duplicates, capacity, location,
  // short descriptions, unusual themes, commercial format or a user's interests.
  return classifyEventText(event);
}

module.exports = { classifyEventText, evaluateEventModeration, findForbiddenContact, validateEventContactText, normalize };
