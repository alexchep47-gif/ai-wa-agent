const test = require('node:test');
const assert = require('node:assert/strict');
const { proto } = require('@whiskeysockets/baileys');
const {
  DAILY_INTERACTION_FORMATS,
  createNativePollMessage,
  createNativeQuestionMessage,
  createNativeQuizMessage,
  sendNativeChannelInteraction,
} = require('../lib/channel-native');

function roundTrip(message) {
  return proto.Message.decode(proto.Message.encode(message).finish());
}

const sample = {
  name: 'Quelle est la valeur de 2 + 2 ?',
  options: ['3', '4', '5', '6'],
  answerIndex: 1,
};

test('la rotation quotidienne utilise sondages, quiz et questions', () => {
  assert.deepEqual(DAILY_INTERACTION_FORMATS, ['quiz', 'poll', 'question', 'quiz', 'poll']);
});

test('le Sondage natif sérialise V3 avec type POLL et secret de vote', () => {
  const message = roundTrip(createNativePollMessage(sample));
  assert.equal(message.pollCreationMessageV3.pollType, proto.Message.PollCreationMessage.PollType.POLL);
  assert.equal(message.pollCreationMessageV3.name, sample.name);
  assert.equal(message.pollCreationMessageV3.options.length, 4);
  assert.equal(message.pollCreationMessageV3.selectableOptionsCount, 1);
  assert.equal(message.messageContextInfo.messageSecret.length, 32);
});

test('le Quiz natif sérialise V3 avec la bonne réponse correcte', () => {
  const message = roundTrip(createNativeQuizMessage(sample));
  assert.equal(message.pollCreationMessageV3.pollType, proto.Message.PollCreationMessage.PollType.QUIZ);
  assert.equal(message.pollCreationMessageV3.correctAnswer.optionName, '4');
  assert.equal(message.pollCreationMessageV3.selectableOptionsCount, 1);
  assert.equal(message.messageContextInfo.messageSecret.length, 32);
});

test('la Question native sérialise une réponse libre', () => {
  const message = roundTrip(createNativeQuestionMessage('Pourquoi le ciel paraît-il bleu ?'));
  assert.equal(message.questionMessage.message.conversation, 'Pourquoi le ciel paraît-il bleu ?');
});

test('la publication de canal relaie chaque format au JID newsletter avec attribut question si nécessaire', async () => {
  const sent = [];
  const sock = {
    user: { id: '237677152300:1@s.whatsapp.net' },
    async relayMessage(jid, message, options) {
      sent.push({ jid, message: roundTrip(message), options });
    },
  };
  const jid = '120363405662375326@newsletter';
  for (const format of ['poll', 'quiz', 'question']) {
    await sendNativeChannelInteraction(sock, jid, format, sample);
  }
  assert.equal(sent.length, 3);
  assert.ok(sent.every((entry) => entry.jid === jid && entry.options.messageId));
  assert.equal(sent[0].message.pollCreationMessageV3.pollType, proto.Message.PollCreationMessage.PollType.POLL);
  assert.equal(sent[1].message.pollCreationMessageV3.pollType, proto.Message.PollCreationMessage.PollType.QUIZ);
  assert.deepEqual(sent[2].options.additionalAttributes, { type: 'question' });
  assert.equal(sent[2].message.questionMessage.message.conversation, sample.name);
});

test('les contenus natifs rejettent une réponse correcte, des options ou un canal invalides', async () => {
  assert.throws(() => createNativeQuizMessage({ ...sample, answerIndex: 4 }), /réponse correcte/);
  assert.throws(() => createNativePollMessage({ ...sample, options: ['A'] }), /entre 2 et 12/);
  assert.throws(() => createNativeQuestionMessage(''), /question doit/);
  await assert.rejects(sendNativeChannelInteraction({ relayMessage() {} }, '123@s.whatsapp.net', 'poll', sample), /JID du canal/);
});
