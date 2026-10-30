const SUBJECTS = [
  'Mathématiques',
  'Informatique',
  'Chimie',
  'Physique',
  'Culture scientifique',
];

const DEFAULT_TIMES = ['08:00', '11:00', '14:00', '17:00', '20:00'];
const SOCIAL_LINKS = [
  ['Instagram', 'https://www.instagram.com/mathsfor.all?igsh=MzNlNGNkZWQ4Mg=='],
  ['Facebook', 'https://www.facebook.com/profile.php?id=61583757123828'],
  ['TikTok', 'https://www.tiktok.com/@mathsfor.all?_r=1&_t=ZS-99MftUxXXtM'],
  ['WhatsApp', 'https://whatsapp.com/channel/0029VbC9sfi5q08hsj3JTp0W'],
  ['YouTube', 'https://www.youtube.com/@lelivre04'],
  ['Site web', 'https://cmr-school.online'],
  ['Shop Mathsfor.all', 'https://app.amazecommerce.com/shop/mathsforall'],
];

const FALLBACK_BANK = {
  'Mathématiques': [
    { level: 'Seconde S', question: 'Résous dans ℝ : 3x − 4 = 11.', options: ['x = 5', 'x = 7', 'x = 15/4', 'x = −5'], answerIndex: 0, explanation: '3x = 15, donc x = 5.' },
    { level: 'Première S', question: 'Quelle factorisation de x² − 9 est correcte ?', options: ['(x − 3)(x + 3)', '(x − 9)(x + 1)', '(x − 3)²', '(x + 9)(x − 1)'], answerIndex: 0, explanation: 'C’est une différence de deux carrés : a² − b² = (a − b)(a + b).' },
    { level: 'Terminale S', question: 'Si f(x) = 3x², quelle est la valeur de f′(2) ?', options: ['6', '12', '3', '24'], answerIndex: 1, explanation: 'f′(x) = 6x, donc f′(2) = 12.' },
    { level: 'L1 Mathématiques', question: 'Quelle est la valeur de ∫₀² x dx ?', options: ['1', '2', '4', '8/3'], answerIndex: 1, explanation: 'Une primitive de x est x²/2 ; entre 0 et 2, cela donne 2.' },
    { level: 'L2 Mathématiques', question: 'Quelle est la valeur de ∫₀² x² dx ?', options: ['2', '8/3', '4', '3'], answerIndex: 1, explanation: 'Une primitive de x² est x³/3 ; entre 0 et 2, cela donne 8/3.' },
  ],
  Informatique: [
    { level: 'Seconde S', question: 'Quelle valeur représente 1010₂ en base 10 ?', options: ['8', '10', '12', '14'], answerIndex: 1, explanation: '1010₂ = 1×8 + 0×4 + 1×2 + 0×1 = 10.' },
    { level: 'Première S', question: 'Quelle structure suit la règle « dernier entré, premier sorti » ?', options: ['Une pile', 'Une file', 'Un tableau trié', 'Un graphe'], answerIndex: 0, explanation: 'Une pile suit le principe LIFO : Last In, First Out.' },
    { level: 'Terminale S', question: 'Pour une liste triée, quelle méthode recherche un élément en O(log n) ?', options: ['Recherche dichotomique', 'Recherche linéaire', 'Tri par insertion', 'Parcours complet'], answerIndex: 0, explanation: 'La recherche dichotomique divise par deux l’intervalle à chaque étape.' },
    { level: 'L1 Informatique', question: 'Un algorithme parcourt une liste de n éléments une seule fois. Sa complexité usuelle est :', options: ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], answerIndex: 2, explanation: 'Le nombre d’opérations croît proportionnellement à n.' },
    { level: 'L2 Informatique', question: 'Quel principe garantit qu’un algorithme termine après un nombre fini d’étapes ?', options: ['La terminaison', 'La récursivité', 'Le parallélisme', 'La compilation'], answerIndex: 0, explanation: 'La terminaison signifie que l’algorithme finit pour toute entrée de son domaine prévu.' },
  ],
  Chimie: [
    { level: 'Seconde S', question: 'Quelle est la formule chimique de l’eau ?', options: ['H₂O', 'HO₂', 'H₂O₂', 'OH'], answerIndex: 0, explanation: 'Une molécule d’eau contient deux atomes d’hydrogène et un atome d’oxygène.' },
    { level: 'Première S', question: 'À 25 °C, une solution de pH 3 est :', options: ['Acide', 'Neutre', 'Basique', 'Toujours saturée'], answerIndex: 0, explanation: 'Une solution est acide lorsque son pH est inférieur à 7.' },
    { level: 'Terminale S', question: 'Le numéro atomique Z d’un élément indique le nombre de :', options: ['Protons', 'Neutrons uniquement', 'Nucléons', 'Couches électroniques'], answerIndex: 0, explanation: 'Z est le nombre de protons du noyau ; il identifie l’élément.' },
    { level: 'L1 Chimie', question: 'Quelle relation donne la quantité de matière n à partir de la masse m et de la masse molaire M ?', options: ['n = m/M', 'n = M/m', 'n = m×M', 'n = m + M'], answerIndex: 0, explanation: 'La quantité de matière s’obtient par n = m/M.' },
    { level: 'L2 Chimie', question: 'Pour une réaction à l’équilibre, ajouter un réactif tend généralement à déplacer l’équilibre vers :', options: ['Les produits', 'Les réactifs', 'Aucun côté dans tous les cas', 'La phase gazeuse uniquement'], answerIndex: 0, explanation: 'Selon le principe de Le Châtelier, le système tend à consommer le réactif ajouté, toutes choses égales par ailleurs.' },
  ],
  Physique: [
    { level: 'Seconde S', question: 'Quelle relation permet de calculer une vitesse moyenne ?', options: ['v = distance / durée', 'v = durée / distance', 'v = masse × volume', 'v = force / temps'], answerIndex: 0, explanation: 'La vitesse moyenne est la distance parcourue divisée par la durée.' },
    { level: 'Première S', question: 'Dans un conducteur ohmique, quelle loi relie U, R et I ?', options: ['U = R × I', 'I = U × R', 'R = U × I', 'U = R + I'], answerIndex: 0, explanation: 'La loi d’Ohm s’écrit U = R I.' },
    { level: 'Terminale S', question: 'Quelle relation exprime la deuxième loi de Newton pour une masse constante ?', options: ['ΣF = m a', 'ΣF = m/v', 'ΣF = m + a', 'ΣF = a/m'], answerIndex: 0, explanation: 'La résultante des forces est égale au produit de la masse par l’accélération.' },
    { level: 'L1 Physique', question: 'Quelle expression donne l’énergie cinétique d’un point matériel de masse m et de vitesse v ?', options: ['½mv²', 'mv', 'mgh', '½m/v²'], answerIndex: 0, explanation: 'L’énergie cinétique vaut Ec = ½mv².' },
    { level: 'L2 Physique', question: 'Quelle est l’unité SI de la capacité électrique ?', options: ['Le farad', 'Le tesla', 'Le henry', 'Le weber'], answerIndex: 0, explanation: 'La capacité électrique se mesure en farads (F).' },
  ],
  'Culture scientifique': [
    { level: 'Seconde S', question: 'Quel gaz les plantes absorbent-elles principalement pour la photosynthèse ?', options: ['Dioxyde de carbone', 'Dioxygène', 'Diazote', 'Hélium'], answerIndex: 0, explanation: 'La photosynthèse utilise notamment le dioxyde de carbone et l’eau grâce à l’énergie lumineuse.' },
    { level: 'Première S', question: 'Quelle structure contient la majeure partie de l’information génétique d’une cellule humaine ?', options: ['L’ADN', 'L’amidon', 'La cellulose', 'Le glycogène'], answerIndex: 0, explanation: 'L’information génétique est portée principalement par l’ADN, organisé en chromosomes.' },
    { level: 'Terminale S', question: 'Quel est le symbole chimique de l’oxygène ?', options: ['O', 'Ox', 'Og', 'O₂'], answerIndex: 0, explanation: 'O est le symbole de l’élément oxygène ; O₂ désigne une molécule de dioxygène.' },
    { level: 'L1 Sciences', question: 'Quelle constante correspond approximativement au nombre d’entités dans une mole ?', options: ['6,02 × 10²³ mol⁻¹', '9,81 m·s⁻²', '3,00 × 10⁸ m·s⁻¹', '1,60 × 10⁻¹⁹ C'], answerIndex: 0, explanation: 'La constante d’Avogadro vaut environ 6,02 × 10²³ mol⁻¹.' },
    { level: 'L2 Sciences', question: 'À pression atmosphérique normale, quelle est la valeur approximative de la constante des gaz parfaits R ?', options: ['8,314 J·mol⁻¹·K⁻¹', '1,602 × 10⁻¹⁹ J', '6,022 × 10²³ mol⁻¹', '9,81 J·kg⁻¹'], answerIndex: 0, explanation: 'La constante universelle des gaz parfaits vaut environ 8,314 J·mol⁻¹·K⁻¹.' },
  ],
};

function parseChannelInviteCode(value) {
  const input = String(value || '').trim();
  const match = input.match(/(?:whatsapp\.com\/channel\/)?([A-Za-z0-9_-]{10,})/i);
  return match ? match[1] : null;
}

function parsePollTimes(value) {
  const parsed = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(entry));
  const unique = [...new Set(parsed)].sort();
  return unique.length === 5 ? unique : DEFAULT_TIMES;
}

function getLocalDateKey(date = new Date(), timeZone = 'Africa/Douala') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addLocalDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function timeZoneOffsetMs(date, timeZone) {
  const value = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = value.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return (match[1] === '+' ? 1 : -1) * minutes * 60000;
}

function localDateTime(dateKey, time, timeZone = 'Africa/Douala') {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offset = timeZoneOffsetMs(new Date(localAsUtc), timeZone);
  return new Date(localAsUtc - offset);
}

function validatePollBatch(value) {
  const polls = Array.isArray(value) ? value : value?.polls;
  if (!Array.isArray(polls) || polls.length !== SUBJECTS.length) {
    throw new Error(`Il faut exactement ${SUBJECTS.length} sondages.`);
  }
  const seen = new Set();
  return polls.map((poll) => {
    if (!poll || !SUBJECTS.includes(poll.subject) || seen.has(poll.subject)) {
      throw new Error('Catégorie de sondage invalide ou répétée.');
    }
    seen.add(poll.subject);
    if (typeof poll.level !== 'string' || poll.level.length > 40) throw new Error('Niveau scolaire invalide.');
    if (typeof poll.question !== 'string' || !poll.question.trim() || poll.question.length > 200) throw new Error('Question vide ou trop longue.');
    if (!Array.isArray(poll.options) || poll.options.length !== 4 || poll.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 100)) {
      throw new Error('Chaque sondage doit avoir quatre choix courts.');
    }
    if (!Number.isInteger(poll.answerIndex) || poll.answerIndex < 0 || poll.answerIndex > 3) throw new Error('Index de réponse correcte invalide.');
    if (typeof poll.explanation !== 'string' || !poll.explanation.trim() || poll.explanation.length > 350) throw new Error('Explication absente ou trop longue.');
    return {
      subject: poll.subject,
      level: poll.level,
      question: poll.question.trim(),
      options: poll.options.map((option) => option.trim()),
      answerIndex: poll.answerIndex,
      explanation: poll.explanation.trim(),
    };
  });
}

function parseGeneratedPollBatch(raw) {
  const clean = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Réponse IA sans objet JSON.');
  return validatePollBatch(JSON.parse(clean.slice(start, end + 1)));
}

function fallbackPollBatch(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const dayIndex = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86400000);
  return SUBJECTS.map((subject) => {
    const question = FALLBACK_BANK[subject][dayIndex % FALLBACK_BANK[subject].length];
    return { subject, ...question, options: [...question.options] };
  });
}

function buildDailyPrompt(dateKey) {
  return `Prépare cinq quiz en français pour le canal WhatsApp Mathsfor.all, pour la date ${dateKey}. Retourne STRICTEMENT un objet JSON, sans markdown, de forme {"polls":[{"subject":"Mathématiques","level":"Seconde S","question":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"..."}]}. Il faut exactement un quiz pour chacune de ces cinq catégories, avec ces libellés exacts : ${SUBJECTS.join(', ')}. Niveau pédagogique de Seconde scientifique à L2; adapte réellement la difficulté au niveau indiqué. Quatre options de réponse courtes et une seule bonne réponse. answerIndex est l’index de l’option correcte, entre 0 et 3. Donne une explication exacte, brève et vérifiable. Varie les questions et les niveaux chaque jour. Pour « Culture scientifique », choisis une notion scientifique stable et ne fabrique pas d’actualité. Ne répète pas la réponse correcte dans la question. Pas d’autopromotion dans les questions. Maximum 200 caractères par question, 100 par option et 350 par explication.`;
}

function buildDailyRecap(dateKey, publishedPolls, timeZone = 'Africa/Douala') {
  const dateLabel = new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'long',
    timeZone,
  }).format(localDateTime(dateKey, '12:00', timeZone));
  const answers = publishedPolls.map((poll) =>
    `• ${poll.subject} (${poll.level}) : ${poll.options[poll.answerIndex]} — ${poll.explanation}`
  );
  const links = SOCIAL_LINKS.map(([name, url]) => `${name} : ${url}`).join('\n');
  return `📚 Corrigé du jour — ${dateLabel}\n\n${answers.length ? answers.join('\n') : 'Les sondages du jour n’ont pas pu être publiés.'}\n\nLe futur c'est maintenant ! Suis Mathsfor.all et partage nos contenus :\n${links}`;
}

module.exports = {
  DEFAULT_TIMES,
  SUBJECTS,
  SOCIAL_LINKS,
  parseChannelInviteCode,
  parsePollTimes,
  getLocalDateKey,
  addLocalDays,
  localDateTime,
  validatePollBatch,
  parseGeneratedPollBatch,
  fallbackPollBatch,
  buildDailyPrompt,
  buildDailyRecap,
};
