const ADMIN_SYSTEM_PROMPT = 'Tu es un assistant IA polyvalent au service des administrateurs de CMR SCHOOL. Réponds librement aux demandes des administrateurs, sans restriction au sujet commercial ou éducatif de CMR SCHOOL. Reste utile, exact et respectueux. Pour les demandes liées à CMR SCHOOL, tu peux aussi aider sur ses offres, son site et son fonctionnement.';

function getAiSystemInstruction({ isAdmin = false, clientSystemPrompt = '' } = {}) {
  return isAdmin ? ADMIN_SYSTEM_PROMPT : clientSystemPrompt;
}

function getAiFailureReply(lang = 'fr', isAdmin = false) {
  if (lang === 'en') {
    return isAdmin
      ? 'Sorry, I’m temporarily unable to process your request. Please try again shortly.'
      : 'Sorry, I can’t process your request right now. I can help with CMR SCHOOL courses, prices, registration, payments, and services. Visit https://cmr-school.online or contact +237 677 152 300.';
  }
  return isAdmin
    ? 'Désolé, je ne peux pas traiter ta demande pour le moment. Réessaie dans quelques instants.'
    : 'Désolé, je ne peux pas traiter ta demande pour le moment. Je peux vous aider au sujet de CMR SCHOOL : cours, tarifs, inscription, paiement et services. Consultez https://cmr-school.online ou écrivez au +237 677 152 300.';
}

module.exports = { ADMIN_SYSTEM_PROMPT, getAiSystemInstruction, getAiFailureReply };
