const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ADMIN_SYSTEM_PROMPT,
  getAiFailureReply,
  getAiSystemInstruction,
} = require('../lib/ai-response');

test('les clients restent dans le contexte CMR SCHOOL', () => {
  const prompt = 'Prompt client personnalisé';
  assert.equal(getAiSystemInstruction({ clientSystemPrompt: prompt }), prompt);
  assert.match(getAiFailureReply('fr', false), /CMR SCHOOL/);
  assert.match(getAiFailureReply('fr', false), /cmr-school\.online/);
  assert.doesNotMatch(getAiFailureReply('fr', false), /Gemini|Erreur IA|503/);
});

test('les administrateurs disposent d’un contexte polyvalent sans restriction CMR SCHOOL', () => {
  const systemPrompt = getAiSystemInstruction({ isAdmin: true, clientSystemPrompt: 'Contexte client limité' });
  assert.equal(systemPrompt, ADMIN_SYSTEM_PROMPT);
  assert.match(systemPrompt, /sans restriction au sujet/);
  assert.doesNotMatch(systemPrompt, /uniquement à propos de CMR SCHOOL/);
});

test('les messages de panne sont polis et localisés', () => {
  assert.match(getAiFailureReply('fr', true), /Désolé/);
  assert.match(getAiFailureReply('en', true), /Sorry/);
  assert.match(getAiFailureReply('en', false), /CMR SCHOOL/);
  assert.doesNotMatch(getAiFailureReply('en', false), /503|generativelanguage\.googleapis/);
});
