const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TIMES,
  SUBJECTS,
  SOCIAL_LINKS,
  addLocalDays,
  buildDailyRecap,
  fallbackPollBatch,
  localDateTime,
  parseChannelInviteCode,
  parseGeneratedPollBatch,
  parsePollTimes,
  validatePollBatch,
} = require('../lib/channel-polls');

test('résout le code d’invitation du canal fourni', () => {
  assert.equal(
    parseChannelInviteCode('https://whatsapp.com/channel/0029VbC9sfi5q08hsj3JTp0W'),
    '0029VbC9sfi5q08hsj3JTp0W',
  );
  assert.equal(parseChannelInviteCode('0029VbC9sfi5q08hsj3JTp0W'), '0029VbC9sfi5q08hsj3JTp0W');
  assert.equal(parseChannelInviteCode(''), null);
});

test('utilise cinq créneaux valides et retombe sur les valeurs par défaut sinon', () => {
  assert.deepEqual(parsePollTimes('07:30,10:30,13:30,16:30,19:30'), ['07:30', '10:30', '13:30', '16:30', '19:30']);
  assert.deepEqual(parsePollTimes('99:00,12:70'), DEFAULT_TIMES);
  assert.deepEqual(parsePollTimes('08:00,08:00,11:00,14:00,17:00,20:00'), DEFAULT_TIMES);
});

test('convertit les horaires Africa/Douala en UTC et gère le changement d’année', () => {
  assert.equal(localDateTime('2026-10-30', '08:00', 'Africa/Douala').toISOString(), '2026-10-30T07:00:00.000Z');
  assert.equal(addLocalDays('2026-12-31', 1), '2027-01-01');
});

test('la banque locale produit cinq sondages validés couvrant chaque catégorie', () => {
  for (let day = 1; day <= 5; day += 1) {
    const date = `2026-01-${String(day).padStart(2, '0')}`;
    const batch = fallbackPollBatch(date);
    assert.equal(batch.length, 5);
    assert.deepEqual([...batch.map((poll) => poll.subject)].sort(), [...SUBJECTS].sort());
    assert.deepEqual(parseGeneratedPollBatch(JSON.stringify({ polls: batch })), batch);
    for (const poll of batch) {
      assert.equal(poll.options.length, 4);
      assert.ok(poll.answerIndex >= 0 && poll.answerIndex < 4);
    }
  }
});

test('refuse un sondage mal formé ou une catégorie dupliquée', () => {
  const batch = fallbackPollBatch('2026-10-30');
  assert.throws(() => validatePollBatch(batch.slice(1)), /exactement/);
  const duplicate = [...batch];
  duplicate[4] = { ...duplicate[0] };
  assert.throws(() => validatePollBatch(duplicate), /invalide ou répétée/);
});

test('le corrigé quotidien inclut le slogan et les sept liens fournis', () => {
  const recap = buildDailyRecap('2026-10-30', fallbackPollBatch('2026-10-30'));
  assert.ok(recap.includes("Le futur c'est maintenant"));
  for (const [, url] of SOCIAL_LINKS) assert.ok(recap.includes(url));
});
