const test = require('node:test');
const assert = require('node:assert/strict');
const { proto } = require('@whiskeysockets/baileys');
const {
  DAILY_INTERACTION_FORMATS,
  createNativeQuestionMessage,
  createNativeQuizMessage,
} = require('../lib/channel-native');

function roundTrip(message) {
  return proto.Message.decode(proto.Message.encode(message).finish());
}

test('la rotation quotidienne utilise les trois types natifs', () => {
  assert.deepEqual(DAILY_INTERACTION_FORMATS, ['quiz', 'poll', 'question', 'quiz', 'poll']);
});

test('le Quiz natif sérialise le type QUIZ et la réponse correcte', () => {
  const message = roundTrip(createNativeQuizMessage({
    name: 'Quelle est la valeur de 2 + 2 ?',
    options: ['3', '4', '5', '6'],
    answerIndex: 1,
  }));
  assert.equal(message.pollCreationMessageV3.pollType, proto.Message.PollCreationMessage.PollType.QUIZ);
  assert.equal(message.pollCreationMessageV3.correctAnswer.optionName, '4');
  assert.equal(message.pollCreationMessageV3.selectableOptionsCount, 1);
  assert.equal(message.messageContextInfo.messageSecret.length, 32);
});

test('la Question native sérialise une réponse libre', () => {
  const message = roundTrip(createNativeQuestionMessage('Pourquoi le ciel paraît-il bleu ?'));
  assert.equal(message.questionMessage.message.conversation, 'Pourquoi le ciel paraît-il bleu ?');
});

test('les contenus natifs rejettent une réponse correcte ou des options invalides', () => {
  assert.throws(() => createNativeQuizMessage({ name: 'Q ?', options: ['A', 'B'], answerIndex: 3 }), /réponse correcte/);
  assert.throws(() => createNativeQuestionMessage(''), /question doit/);
});
