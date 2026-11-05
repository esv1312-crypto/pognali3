const BLOCK_PATTERNS = [
  /(?:продам|куплю|продаж\w*|купить|достав\w*).{0,45}(?:наркот\w*|кокаин\w*|героин\w*|мефедрон\w*|закладк\w*|метамфетамин\w*)/iu,
  /(?:наркот\w*|кокаин\w*|героин\w*|мефедрон\w*|закладк\w*|метамфетамин\w*).{0,45}(?:продам|куплю|продаж\w*|купить|достав\w*)/iu,
  /(?:проститут\w*|эскорт\w*|интимн\w* услуг\w*|секс[- ]услуг\w*|секс за деньги)/iu,
  /(?:купить|продать|сбыт\w*).{0,35}(?:оруж\w*|пистолет\w*|автомат\w*|взрывчат\w*)/iu,
  /(?:теракт\w*|террористическ\w* акт\w*|взрывчат\w* изготов\w*)/iu,
  /(?:планирую|давайте|нужно|хочу).{0,35}(?:убить|избить|напасть|поджечь|взорвать).{0,35}(?:человек\w*|люд\w*|здан\w*|школ\w*|толп\w*)/iu
];

const REVIEW_PATTERNS = [
  { pattern: /(?:https?:\\/\\/|www\\.|t\\.me\\/|telegram\\.me\\/)/iu, reason: 'В описании есть внешняя ссылка' },
  { pattern: /(?:реклам\w*|продам|куплю|продаж\w*|скидк\w*|промокод\w*|прайс\w*|закаж\w*|подписывай\w*|партнёрск\w* ссылк\w*)/iu, reason: 'Возможная реклама или коммерческое предложение' },
  { pattern: /(?:казино|букмекер\w*|ставк\w*|криптовалют\w*|инвестиц\w*|заработ\w*|доход от вложен\w*|реферал\w*)/iu, reason: 'Финансовое или азартное предложение требует проверки' },
  { pattern: /(?:\\+?\\d[\\d ()-]{7,}\\d)/u, reason: 'В тексте указан телефонный номер' },
  { pattern: /(?:18\\+|только для взрослых|алкогол\\w*|вейп\\w*|табак\\w*)/iu, reason: 'Возрастное или регулируемое предложение требует проверки' }
];

function normalize(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim().replace(/\\s+/g, ' ');
}

function classifyEventText(event) {
  const title = String(event.title || '');
  const description = String(event.description || '');
  const category = String(event.category || '');
  const text = [title, description, category].join(' ');
  const blocked = BLOCK_PATTERNS.find(pattern => pattern.test(text));
  if (blocked) return { status: 'cancelled', decision: 'auto_blocked', reasons: ['Обнаружено предложение запрещённой или опасной деятельности'] };

  const reasons = [];
  let score = 0;
  for (const item of REVIEW_PATTERNS) {
    if (item.pattern.test(text)) {
      score += item.reason.includes('ссылк') || item.reason.includes('реклам') ? 3 : 2;
      reasons.push(item.reason);
    }
  }

  const normalizedTitle = normalize(title);
  const genericTitles = new Set(['встреча', 'мероприятие', 'тусовка', 'отдых', 'событие', 'план', 'ищу компанию']);
  if ((!description.trim() || description.trim().length < 10) && (genericTitles.has(normalizedTitle) || !category.trim() || category.toLowerCase() === 'other')) {
    score += 2;
    reasons.push('Недостаточно подробностей: непонятно, что именно планируется');
  }

  if (!String(event.city || '').trim() || String(event.city).trim().toLowerCase() === 'не указан') {
    score += 2;
    reasons.push('Не удалось определить место проведения');
  }
  if (Number(event.capacity) > 500) {
    score += 2;
    reasons.push('Необычно большая вместимость события');
  }

  return {
    status: score >= 3 ? 'pending_review' : 'published',
    decision: score >= 3 ? 'auto_sent_to_review' : 'auto_published',
    score,
    reasons: [...new Set(reasons)]
  };
}

async function evaluateEventModeration(db, event) {
  const textDecision = classifyEventText(event);
  if (textDecision.decision === 'auto_blocked') return textDecision;

  const reasons = [...textDecision.reasons];
  let score = textDecision.score || 0;
  const title = normalize(event.title);
  const city = normalize(event.city);

  const duplicate = await db.query(
    `SELECT id FROM events
     WHERE status IN ('published','pending_review')
       AND LOWER(REGEXP_REPLACE(title, '[^[:alnum:]]+', ' ', 'g')) = $1
       AND LOWER(city) = $2
       AND starts_at BETWEEN $3::timestamptz - INTERVAL '24 hours' AND $3::timestamptz + INTERVAL '24 hours'
     LIMIT 1`,
    [title, city, event.starts_at]
  );
  if (duplicate.rowCount) {
    score += 5;
    reasons.push('Похоже на дубликат уже созданного события');
  }

  const recentEvents = await db.query(
    "SELECT COUNT(*)::int AS count FROM events WHERE creator_id=$1 AND created_at > NOW() - INTERVAL '24 hours'",
    [event.creator_id]
  );
  if (Number(recentEvents.rows[0]?.count || 0) >= 4) {
    score += 3;
    reasons.push('Организатор создал необычно много событий за сутки');
  }

  const reportHistory = await db.query(
    `SELECT COUNT(DISTINCT r.id)::int AS count
     FROM event_reports r JOIN events e ON e.id=r.event_id
     WHERE e.creator_id=$1 AND r.created_at > NOW() - INTERVAL '30 days'
       AND r.status IN ('open','reviewing','resolved')`,
    [event.creator_id]
  );
  if (Number(reportHistory.rows[0]?.count || 0) >= 2) {
    score += 3;
    reasons.push('У организатора есть несколько недавних жалоб на другие события');
  }

  const manual = score >= 3;
  return {
    status: manual ? 'pending_review' : 'published',
    decision: manual ? 'auto_sent_to_review' : 'auto_published',
    score,
    reasons: [...new Set(reasons)]
  };
}

module.exports = { classifyEventText, evaluateEventModeration, normalize };
