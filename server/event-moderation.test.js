const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyEventText, normalize } = require('./event-moderation');

const safe = {
  title: 'Футбол во дворе',
  description: 'Играем два на два, берите удобную обувь',
  category: 'Спорт',
  city: 'Симферополь',
  capacity: 12
};

test('normalizes Russian text consistently for duplicate detection', () => {
  assert.equal(normalize('  Ёлки — ПАЛКИ! '), 'елки палки');
});

test('automatically publishes an ordinary real-life event', () => {
  const result = classifyEventText(safe);
  assert.equal(result.status, 'published');
  assert.equal(result.decision, 'auto_published');
  assert.deepEqual(result.reasons, []);
});

test('sends external links and advertising to manual review', () => {
  const link = classifyEventText({ ...safe, description: 'Играем в футбол. Подробности https://example.com' });
  assert.equal(link.status, 'pending_review');
  assert.ok(link.reasons.some(reason => reason.includes('ссылк')));

  const ad = classifyEventText({ ...safe, description: 'Реклама, скидки и промокоды для всех участников' });
  assert.equal(ad.status, 'pending_review');
  assert.ok(ad.reasons.some(reason => reason.includes('реклама')));
});

test('sends vague events without enough details to manual review', () => {
  const result = classifyEventText({ ...safe, title: 'Встреча', description: '', category: 'Другое' });
  assert.equal(result.status, 'pending_review');
  assert.ok(result.reasons.some(reason => reason.includes('подробностей')));
});

test('blocks clear offers of prohibited or dangerous activity', () => {
  const result = classifyEventText({ ...safe, description: 'Продам наркотики, доставка сегодня' });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.decision, 'auto_blocked');
  assert.ok(result.reasons.length > 0);
});

test('does not block ordinary sport events mentioning contact or training', () => {
  const result = classifyEventText({ ...safe, title: 'Тренировка по боксу', description: 'Отрабатываем технику и спарринги в зале' });
  assert.equal(result.status, 'published');
});
