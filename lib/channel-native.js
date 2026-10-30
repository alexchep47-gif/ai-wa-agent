const { randomBytes } = require('crypto');
const { proto } = require('@whiskeysockets/baileys');
const DAILY_INTERACTION_FORMATS = ['quiz', 'poll', 'question', 'quiz', 'poll'];

function createNativeQuizMessage({ name, options, answerIndex }) {
  const question = String(name || '').trim();
  if (!question || question.length > 255) throw new Error('La question du quiz doit contenir entre 1 et 255 caractères.');
  if (!Array.isArray(options) || options.length < 2 || options.length > 12) throw new Error('Un quiz doit avoir entre 2 et 12 options.');
  const normalizedOptions = options.map((option) => String(option || '').trim());
  if (normalizedOptions.some((option) => !option || option.length > 100)) throw new Error('Chaque option doit contenir entre 1 et 100 caractères.');
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= normalizedOptions.length) throw new Error('L’index de la réponse correcte est invalide.');

  const protoOptions = normalizedOptions.map((optionName) => ({ optionName }));
  return proto.Message.create({
    messageContextInfo: { messageSecret: randomBytes(32) },
    pollCreationMessageV3: {
      name: question,
      selectableOptionsCount: 1,
      options: protoOptions,
      pollType: proto.Message.PollCreationMessage.PollType.QUIZ,
      correctAnswer: protoOptions[answerIndex],
    },
  });
}

function createNativeQuestionMessage(text) {
  const question = String(text || '').trim();
  if (!question || question.length > 255) throw new Error('La question doit contenir entre 1 et 255 caractères.');
  return proto.Message.create({
    questionMessage: {
      message: { conversation: question },
    },
  });
}

module.exports = { DAILY_INTERACTION_FORMATS, createNativeQuestionMessage, createNativeQuizMessage };
