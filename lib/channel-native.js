const { randomBytes } = require('crypto');
const { proto, generateMessageIDV2 } = require('@whiskeysockets/baileys');
const DAILY_INTERACTION_FORMATS = ['quiz', 'poll', 'question', 'quiz', 'poll'];

function normalizePoll({ name, options, answerIndex }) {
  const question = String(name || '').trim();
  if (!question || question.length > 255) throw new Error('La question du sondage doit contenir entre 1 et 255 caractères.');
  if (!Array.isArray(options) || options.length < 2 || options.length > 12) throw new Error('Un sondage doit avoir entre 2 et 12 options.');
  const normalizedOptions = options.map((option) => String(option || '').trim());
  if (normalizedOptions.some((option) => !option || option.length > 100)) throw new Error('Chaque option doit contenir entre 1 et 100 caractères.');
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= normalizedOptions.length) throw new Error('L’index de la réponse correcte est invalide.');
  return { question, protoOptions: normalizedOptions.map((optionName) => ({ optionName })), answerIndex };
}

function createNativePollMessage({ name, options, answerIndex }) {
  const { question, protoOptions } = normalizePoll({ name, options, answerIndex });
  return proto.Message.create({
    messageContextInfo: { messageSecret: randomBytes(32) },
    pollCreationMessageV3: {
      name: question,
      selectableOptionsCount: 1,
      options: protoOptions,
      pollType: proto.Message.PollCreationMessage.PollType.POLL,
    },
  });
}

function createNativeQuizMessage({ name, options, answerIndex }) {
  const { question, protoOptions, answerIndex: correctIndex } = normalizePoll({ name, options, answerIndex });
  return proto.Message.create({
    messageContextInfo: { messageSecret: randomBytes(32) },
    pollCreationMessageV3: {
      name: question,
      selectableOptionsCount: 1,
      options: protoOptions,
      pollType: proto.Message.PollCreationMessage.PollType.QUIZ,
      correctAnswer: protoOptions[correctIndex],
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

async function sendNativeChannelInteraction(sock, jid, format, poll) {
  if (!sock || typeof sock.relayMessage !== 'function') throw new Error('Socket Baileys indisponible pour publier dans le canal.');
  if (!jid || !String(jid).endsWith('@newsletter')) throw new Error('JID du canal WhatsApp invalide.');
  const name = String(poll?.name || '').trim();
  let message;
  let additionalAttributes;
  if (format === 'quiz') {
    message = createNativeQuizMessage({ name, options: poll.options, answerIndex: poll.answerIndex });
  } else if (format === 'poll') {
    message = createNativePollMessage({ name, options: poll.options, answerIndex: poll.answerIndex });
  } else if (format === 'question') {
    message = createNativeQuestionMessage(name);
    additionalAttributes = { type: 'question' };
  } else {
    throw new Error(`Format natif de canal inconnu : ${format}`);
  }
  const messageId = generateMessageIDV2(sock.user?.id);
  await sock.relayMessage(jid, message, {
    messageId,
    ...(additionalAttributes ? { additionalAttributes } : {}),
  });
  return messageId;
}

module.exports = {
  DAILY_INTERACTION_FORMATS,
  createNativePollMessage,
  createNativeQuestionMessage,
  createNativeQuizMessage,
  sendNativeChannelInteraction,
};
