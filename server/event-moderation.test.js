const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyEventText, normalize, validateEventContactText } = require('./event-moderation');

const safe = {
  title: 'Футбол во дворе',
  description: 'Играем два на два, берите удобную обувь',
  category: 'Спорт',
  city: 'Симферополь',
  capacity: 12
};

test('normalizes Russian text consistently', () => {
  assert.equal(normalize('  Ёлки — ПАЛКИ! '), 'елки палки');
});

test('automatically publishes an ordinary real-life event', () => {
  const result = classifyEventText(safe);
  assert.equal(result.status, 'published');
  assert.equal(result.decision, 'auto_published');
  assert.deepEqual(result.reasons, []);
});

test('does not send vague, short or location-free events to manual review', () => {
  const result = classifyEventText({ ...safe, title: 'Встреча', description: '', category: 'Другое', city: 'Не указан', capacity: 1000 });
  assert.equal(result.status, 'published');
  assert.equal(result.decision, 'auto_published');
});

test('does not penalize commercial format, duplicates or high publishing frequency', () => {
  const result = classifyEventText({ ...safe, description: 'Платная тренировка, запись на месте. Есть свободные места.' });
  assert.equal(result.status, 'published');
});

test('blocks explicit offers to sell prohibited drugs', () => {
  const result = classifyEventText({ ...safe, description: 'Продам наркотики, доставка сегодня' });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.decision, 'auto_blocked');
});

test('does not block ordinary events mentioning a shooting range or video games', () => {
  for (const title of ['Пойдём в тир', 'Играем в стрелялки']) {
    const result = classifyEventText({ ...safe, title, description: 'Встречаемся и проводим время вместе' });
    assert.equal(result.status, 'published');
  }
});

test('routes ambiguous direct threats to manual review', () => {
  const result = classifyEventText({ ...safe, description: 'Хочу напасть на человека после встречи' });
  assert.equal(result.status, 'pending_review');
});

test('rejects external links, social handles and phone numbers as editable text errors', () => {
  assert.deepEqual(validateEventContactText({ title: 'Футбол', description: 'Подробности https://example.com' }), {
    field: 'description', kind: 'link', code: 'CONTACT_DETAILS_NOT_ALLOWED'
  });
  assert.equal(validateEventContactText({ title: 'Встреча @some_user', description: '' })?.kind, 'handle');
  assert.equal(validateEventContactText({ title: 'Встреча', description: 'Звони +7 999 123-45-67' })?.kind, 'phone');
});

test('allows physical venue names and ordinary addresses', () => {
  assert.equal(validateEventContactText({ title: 'Кофе в центре', description: 'Встречаемся на улице Ленина, дом 10' }), null);
});
