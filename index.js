require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { textToPdf } = require('./lib/pdf');
const {
  addLocalDays,
  buildDailyPrompt,
  buildDailyRecap,
  fallbackPollBatch,
  getDailyPollSchedule,
  localDateTime,
  parseChannelInviteCode,
  parseGeneratedPollBatch,
  parsePollTimes,
} = require('./lib/channel-polls');
const { canPublishToChannel, isAdminSender, parseAdminNumbers } = require('./lib/admin-numbers');
const { DAILY_INTERACTION_FORMATS, sendNativeChannelInteraction } = require('./lib/channel-native');
const { getAiFailureReply, getAiSystemInstruction } = require('./lib/ai-response');
const { importSessionId, exportSessionId } = require('./lib/session-id');

const PORT = process.env.PORT || 3000;
const BOT_NAME = process.env.BOT_NAME || 'CMR SCHOOL';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const REPLY_IN_GROUPS = (process.env.REPLY_IN_GROUPS || 'false').toLowerCase() === 'true';
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '237698877771').replace(/\D/g, '');
const ADMIN_NUMBERS = parseAdminNumbers(process.env.ADMIN_NUMBERS || '237677152300,237698877771,237679126098');
const ADMIN_JID = ADMIN_NUMBER + '@s.whatsapp.net';
const SESSION_API_TOKEN = process.env.SESSION_API_TOKEN || '';
const SESSION_API_TOKEN_HEADER = 'x-session-token';
const CHANNEL_URL = process.env.WHATSAPP_CHANNEL_URL || 'https://whatsapp.com/channel/0029VbC9sfi5q08hsj3JTp0W';
const CHANNEL_INVITE_CODE = parseChannelInviteCode(CHANNEL_URL);
const POLL_TIMES = parsePollTimes(process.env.POLL_TIMES);
const POLL_TIMEZONE = (() => {
  const candidate = process.env.POLL_TIMEZONE || 'Africa/Douala';
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: candidate });
    return candidate;
  } catch {
    console.warn('[POLL] Fuseau invalide, repli sur Africa/Douala :', candidate);
    return 'Africa/Douala';
  }
})();
const QUIZ_SYSTEM_PROMPT = 'Tu es un professeur et concepteur de quiz rigoureux en mathématiques, informatique, chimie, physique et culture scientifique. Produis uniquement des contenus éducatifs exacts en français et respecte strictement le format JSON demandé.';

const GEMINI_MODELS = [
  process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  'gemini-2.5-flash',
  'gemini-3.8-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
].filter((name, index, models) => name && models.indexOf(name) === index);

const DEFAULT_SYSTEM_PROMPT = `Tu es l'agent officiel de CMR SCHOOL (https://cmr-school.online).
Tu réponds uniquement à propos de CMR SCHOOL, ses offres, tarifs, inscription, paiement et fonctionnement.
Style : français ou anglais selon le message, court, clair, adapté à WhatsApp.
Site : https://cmr-school.online
Offres : CMR Fiches, CMR Répétitions (~20k/30k/40k FCFA selon classe), CMR Pack.
Contact : WhatsApp +237 677 152 300. PayPal ou Mobile Money.
Tu ne confirmes jamais un paiement sans validation admin (gérée par le système).
Hors sujet CMR SCHOOL : recentre poliment sur le site et les offres.`;

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
const logger = pino({ level: 'silent' });
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
if (process.env.SESSION_ID) {
  try {
    if (importSessionId(process.env.SESSION_ID, AUTH_DIR)) console.log('[SESSION] SESSION_ID restaurée.');
  } catch (e) {
    console.error('[SESSION] SESSION_ID invalide :', e.message);
  }
}
const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'bot_state.json');
const DEFAULT_QUICK_REPLIES = {
  tarifs: 'Consulte nos offres et tarifs sur https://cmr-school.online. Écris « inscription » pour commencer.',
  inscription: 'Pour t’inscrire, visite https://cmr-school.online ou écris au +237 677 152 300.',
  contact: 'Contact CMR SCHOOL : WhatsApp +237 677 152 300 — https://cmr-school.online',
};

function loadRuntimeState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

const runtimeState = loadRuntimeState();
function saveRuntimeState() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(runtimeState, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, STATE_FILE);
}

const msgStore = new Map();
function storeMsg(msg) {
  if (msg?.key?.id) {
    msgStore.set(msg.key.id, msg);
    if (msgStore.size > 300) msgStore.delete(msgStore.keys().next().value);
  }
}

const langByJid = new Map();
const pendingDeposits = new Map();
const conversationHistory = new Map();
const escalationThrottle = new Map();
const statusRecipients = new Set(
  Array.isArray(runtimeState.statusRecipients)
    ? runtimeState.statusRecipients.filter((jid) => typeof jid === 'string' && /^\d+@s\.whatsapp\.net$/.test(jid))
    : []
);
const quickReplies = { ...DEFAULT_QUICK_REPLIES, ...(runtimeState.quickReplies || {}) };
let maintenanceMode = !!runtimeState.maintenanceMode;
let scheduledStatuses = Array.isArray(runtimeState.scheduledStatuses)
  ? runtimeState.scheduledStatuses
  : [];
const adminEvents = Array.isArray(runtimeState.adminEvents) ? runtimeState.adminEvents : [];
let pendingStatus = null;
const scheduledStatusTimers = new Map();
let channelPollsEnabled = runtimeState.channelPollsEnabled === true;
let channelJid = null;
let channelRole = null;
let channelCanPost = false;
let lastChannelResolveAt = 0;
let scheduledPollJobs = Array.isArray(runtimeState.scheduledPollJobs) ? runtimeState.scheduledPollJobs : [];
let publishedQuizAnswers = Array.isArray(runtimeState.publishedQuizAnswers) ? runtimeState.publishedQuizAnswers : [];
const scheduledPollTimers = new Map();
let pollGenerationPromise = null;

function persistRuntime() {
  runtimeState.statusRecipients = [...statusRecipients];
  runtimeState.quickReplies = quickReplies;
  runtimeState.maintenanceMode = maintenanceMode;
  runtimeState.scheduledStatuses = scheduledStatuses;
  runtimeState.adminEvents = adminEvents.slice(-100);
  runtimeState.channelPollsEnabled = channelPollsEnabled;
  runtimeState.scheduledPollJobs = scheduledPollJobs;
  runtimeState.publishedQuizAnswers = publishedQuizAnswers.slice(-50);
  try {
    saveRuntimeState();
  } catch (e) {
    console.error('[STATE] Sauvegarde impossible:', e?.message || e);
  }
}

function rememberStatusContact(contact) {
  const candidates = [contact?.id, contact?.phoneNumber];
  for (const jid of candidates) {
    if (typeof jid === 'string' && /^\d+@s\.whatsapp\.net$/.test(jid)) {
      statusRecipients.add(jid);
      persistRuntime();
    }
  }
}

function parseStatusCommand(text) {
  const body = (text || '').trim().replace(/^(?:!|\/)?(?:statut|status)\s*/i, '');
  const scheduled = body.match(/^dans\s+(\d+)\s*(m|min|minutes?|h|heures?)\s*:\s*([\s\S]+)$/i);
  if (scheduled) {
    const count = Number(scheduled[1]);
    const unit = scheduled[2].toLowerCase();
    const minutes = unit.startsWith('h') ? count * 60 : count;
    if (minutes < 1 || minutes > 10080) return null;
    return {
      caption: scheduled[3].trim(),
      audience: 'all',
      scheduledAt: new Date(Date.now() + minutes * 60000).toISOString(),
    };
  }
  const audience = body.match(/^(connus|liste)\s*:\s*([\s\S]+)$/i);
  const textMatch = body.match(/^:\s*([\s\S]+)$/);
  const caption = (audience ? audience[2] : textMatch ? textMatch[1] : body.replace(/^[-:]\s*/, '')).trim();
  if (!caption) return null;
  return { caption, audience: audience ? (audience[1].toLowerCase() === 'liste' ? 'list' : 'known') : 'all' };
}

function recipientsForAudience(audience) {
  if (audience === 'list') {
    return [...new Set((process.env.STATUS_RECIPIENTS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (entry.includes('@') ? entry : entry.replace(/\D/g, '') + '@s.whatsapp.net'))
      .filter((jid) => /^\d+@s\.whatsapp\.net$/.test(jid)))];
  }
  return [...statusRecipients];
}

function formatStatusDate(date) {
  return new Date(date).toLocaleString('fr-FR', { timeZone: 'Africa/Douala' });
}

function detectLang(text) {
  const t = (text || '').toLowerCase();
  if (/\b(the|what|how|payment|deposit|hello)\b/.test(t) && !/\b(le|la|bonjour|paiement)\b/.test(t)) return 'en';
  if (/\b(le|la|bonjour|paiement|depot|offre)\b/.test(t)) return 'fr';
  return null;
}

function isDepositClaim(text) {
  const t = (text || '').toLowerCase();
  return [
    /d[eé]pos/i,
    /d[eé]p[oô]t/i,
    /j'?ai pay/i,
    /j'?ai vers/i,
    /j'?ai envoy/i,
    /j'?ai effectu/i,
    /paiement effectu/i,
    /momo/i,
    /orange money/i,
    /i paid/i,
    /payment (done|sent|completed)/i,
  ].some((re) => re.test(t));
}

function parseAdminDecision(text) {
  const t = (text || '').trim();
  const m = t.match(/^(ok|oui|valider?|confirm(?:e|er)?|yes)\s+(\d{8,15})\s*$/i);
  if (m) return { decision: 'approve', phone: m[2].replace(/\D/g, '') };
  const r = t.match(/^(non|refuser?|no)\s+(\d{8,15})\s*$/i);
  if (r) return { decision: 'reject', phone: r[2].replace(/\D/g, '') };
  return null;
}

function jidToPhone(jid) {
  if (!jid) return '';
  const m = String(jid).match(/^(\d+)@/);
  if (m) return m[1];
  if (String(jid).includes('@lid')) return 'LID:' + String(jid).split('@')[0];
  return String(jid).replace(/\D/g, '') || jid;
}

function connectedAccountPhone() {
  const userId = String(sock?.user?.id || '');
  const socketPhone = /@(s\.whatsapp\.net|c\.us)$/.test(userId)
    ? userId.split('@')[0].split(':')[0].replace(/\D/g, '')
    : '';
  return /^\d{8,15}$/.test(socketPhone) ? socketPhone : OWNER;
}

let genAI = null;
let activeModelName = null;
if (GEMINI_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_KEY);
  activeModelName = GEMINI_MODELS[0];
  console.log('[OK] Gemini —', GEMINI_MODELS.join(' → '));
} else console.log('[WARN] GEMINI_API_KEY absente');
console.log('[OK] ADMIN commandes:', ADMIN_NUMBERS.join(', '), '| notifications:', ADMIN_NUMBER);

function getModel(name, systemInstruction = SYSTEM_PROMPT) {
  return genAI.getGenerativeModel({ model: name, systemInstruction });
}

async function generateWithFallback(parts, history = [], systemInstruction = SYSTEM_PROMPT) {
  if (!genAI) throw new Error('GEMINI_API_KEY manquante');
  let lastErr;
  for (const name of GEMINI_MODELS) {
    try {
      const model = getModel(name, systemInstruction);
      const result = history.length
        ? await model.startChat({ history }).sendMessage(parts)
        : await model.generateContent(parts);
      if (activeModelName !== name) {
        activeModelName = name;
        console.log('[OK] Modèle actif:', name);
      }
      return result.response.text() || '...';
    } catch (e) {
      lastErr = e;
      console.error('[WARN] modèle', name, e.message?.slice(0, 100));
    }
  }
  throw lastErr || new Error('Gemini échoué');
}

async function askAI(userMessage, lang, jid, isAdmin = false) {
  if (!genAI) return getAiFailureReply(lang, isAdmin);
  const prefix = isAdmin
    ? (lang === 'en' ? 'English, concise and useful.\n\n' : 'Français, réponse concise et utile.\n\n')
    : (lang === 'en' ? 'English, short, CMR SCHOOL only.\n\n' : 'Français, court, uniquement CMR SCHOOL.\n\n');
  const prompt = prefix + userMessage;
  const history = jid ? conversationHistory.get(jid) || [] : [];
  try {
    const systemInstruction = getAiSystemInstruction({ isAdmin, clientSystemPrompt: SYSTEM_PROMPT });
    const reply = await generateWithFallback(prompt, history, systemInstruction);
    if (jid) {
      const next = [
        ...history,
        { role: 'user', parts: [{ text: prompt }] },
        { role: 'model', parts: [{ text: reply }] },
      ].slice(-12);
      conversationHistory.set(jid, next);
    }
    return reply;
  } catch (e) {
    console.error('[AI] Réponse indisponible:', e?.message || e);
    return getAiFailureReply(lang, isAdmin);
  }
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  if (m.ephemeralMessage) return extractText({ message: m.ephemeralMessage.message });
  if (m.viewOnceMessage) return extractText({ message: m.viewOnceMessage.message });
  if (m.viewOnceMessageV2) return extractText({ message: m.viewOnceMessageV2.message });
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  );
}

function getMediaType(msg) {
  const m = msg.message;
  if (!m) return null;
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage) return 'document';
  return null;
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}
function isBroadcast(jid) {
  return !jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}
function wantsPdf(text) {
  return /\b(pdf|fiche|fichier|document)\b/i.test(text || '');
}

let sock = null;
let waReady = false;
let pairingRequested = false;
let lastPairingCode = null;
let pairingCodeExpiresAt = 0;
let lastIncomingJid = null;
let reconnectTimer = null;
let bootId = 0;

function logAdminEvent(type, jid, detail) {
  adminEvents.push({
    at: new Date().toISOString(),
    type,
    phone: jidToPhone(jid),
    detail: String(detail || '').slice(0, 240),
  });
  if (adminEvents.length > 100) adminEvents.splice(0, adminEvents.length - 100);
  persistRuntime();
}

async function notifyAdmin(text) {
  try {
    await sock.sendMessage(ADMIN_JID, { text });
  } catch (e) {
    console.error('[ADMIN] Notification impossible:', e?.message || e);
  }
}

async function publishStatus(draft) {
  if (!sock || !waReady) throw new Error('WhatsApp non connecté');
  const recipients = draft.recipients || (draft.audience === 'all' ? [] : recipientsForAudience(draft.audience));
  if (draft.audience !== 'all' && !recipients.length) throw new Error('Audience vide');
  let content;
  if (draft.mediaType === 'image' || draft.mediaType === 'video') {
    content = {
      [draft.mediaType]: Buffer.from(draft.mediaBase64, 'base64'),
      ...(draft.caption ? { caption: draft.caption } : {}),
    };
  } else {
    content = { text: draft.caption };
  }
  const options = { broadcast: true };
  if (recipients.length) options.statusJidList = recipients;
  await sock.sendMessage('status@broadcast', content, options);
  return recipients.length;
}

async function dispatchScheduledStatus(job) {
  scheduledStatusTimers.delete(job.id);
  if (Date.parse(job.scheduledAt) > Date.now()) {
    scheduleStatusJob(job);
    return;
  }
  if (!waReady || !sock) {
    job.scheduledAt = new Date(Date.now() + 60000).toISOString();
    persistRuntime();
    scheduleStatusJob(job);
    return;
  }
  try {
    const count = await publishStatus(job);
    logAdminEvent('statut programmé publié', ADMIN_JID, `${job.id}; ${count} destinataires`);
    await notifyAdmin(`✅ Statut programmé ${job.id} publié (${count} destinataires).`);
  } catch (e) {
    logAdminEvent('échec statut programmé', ADMIN_JID, `${job.id}: ${e?.message || e}`);
    await notifyAdmin(`❌ Statut programmé ${job.id} non publié : ${e?.message || e}`);
  }
  scheduledStatuses = scheduledStatuses.filter((item) => item.id !== job.id);
  persistRuntime();
}

function scheduleStatusJob(job) {
  if (scheduledStatusTimers.has(job.id)) return;
  const delay = Math.max(0, Date.parse(job.scheduledAt) - Date.now());
  const timer = setTimeout(() => dispatchScheduledStatus(job), Math.min(delay, 2147480000));
  scheduledStatusTimers.set(job.id, timer);
}

function scheduleAllStatuses() {
  for (const job of scheduledStatuses) scheduleStatusJob(job);
}

async function resolveChannelMetadata() {
  lastChannelResolveAt = Date.now();
  if (!sock || !CHANNEL_INVITE_CODE) throw new Error('Lien ou code d’invitation WhatsApp absent.');
  if (typeof sock.newsletterMetadata !== 'function') {
    throw new Error('La version de Baileys installée ne prend pas en charge les chaînes WhatsApp.');
  }
  const metadata = await sock.newsletterMetadata('invite', CHANNEL_INVITE_CODE);
  if (!metadata?.id || !metadata.id.endsWith('@newsletter')) {
    throw new Error('Impossible de récupérer le JID du canal depuis le lien fourni.');
  }
  channelJid = metadata.id;
  channelRole = String(metadata.viewer_metadata?.role || metadata.role || '').toUpperCase();
  const linkedPhone = connectedAccountPhone();
  channelCanPost = canPublishToChannel(channelRole, linkedPhone, ADMIN_NUMBERS);
  console.log('[CHANNEL] résolu', channelJid, '| rôle =', channelRole || 'inconnu', '| autorisation =', channelCanPost ? (channelRole ? 'WhatsApp' : `liste admin (${linkedPhone})`) : 'refusée');
  return metadata;
}

function channelScheduleLabel() {
  return `${POLL_TIMES.join(', ')} (${POLL_TIMEZONE})`;
}

function removePollJob(id) {
  const timer = scheduledPollTimers.get(id);
  if (timer) clearTimeout(timer);
  scheduledPollTimers.delete(id);
  scheduledPollJobs = scheduledPollJobs.filter((job) => job.id !== id);
  persistRuntime();
}

async function dispatchChannelPollJob(job) {
  scheduledPollTimers.delete(job.id);
  if (!scheduledPollJobs.some((item) => item.id === job.id)) return;
  const scheduledAt = Date.parse(job.scheduledAt);
  const retryAt = Date.parse(job.retryAt || job.scheduledAt);
  if (Number.isFinite(retryAt) && retryAt > Date.now()) {
    scheduleChannelPollJob(job);
    return;
  }
  if (!channelPollsEnabled) {
    removePollJob(job.id);
    return;
  }
  if (!waReady || !sock || !channelJid) {
    if (Date.now() - scheduledAt > 15 * 60 * 1000) {
      removePollJob(job.id);
      await notifyAdmin(`⚠️ Publication manquée pour ${job.id} : WhatsApp/canal indisponible depuis plus de 15 minutes.`);
      return;
    }
    job.retryAt = new Date(Date.now() + 60 * 1000).toISOString();
    persistRuntime();
    scheduleChannelPollJob(job);
    return;
  }
  if (!channelCanPost) {
    removePollJob(job.id);
    await notifyAdmin(`⚠️ ${job.id} non publié : le compte WhatsApp lié n’est pas administrateur/propriétaire du canal.`);
    return;
  }
  if (Date.now() - scheduledAt > 15 * 60 * 1000) {
    removePollJob(job.id);
    await notifyAdmin(`⚠️ Publication ${job.id} ignorée : retard supérieur à 15 minutes, pour éviter un envoi groupé tardif.`);
    return;
  }

  try {
    if (job.kind === 'poll') {
      const poll = job.poll;
      const name = `${poll.subject} · ${poll.level} — ${poll.question}`;
      const messageId = await sendNativeChannelInteraction(sock, channelJid, job.format || 'poll', {
        name: name.slice(0, 255),
        options: poll.options,
        answerIndex: poll.answerIndex,
      });
      publishedQuizAnswers.push({ dateKey: job.dateKey, ...poll });
      publishedQuizAnswers = publishedQuizAnswers.slice(-50);
      logAdminEvent(`${job.format || 'poll'} natif transmis`, ADMIN_JID, `${poll.subject}; ${poll.level}; ${job.id}; messageId=${messageId}`);
    } else if (job.kind === 'recap') {
      const answers = publishedQuizAnswers.filter((item) => item.dateKey === job.dateKey);
      await sock.sendMessage(channelJid, { text: buildDailyRecap(job.dateKey, answers, POLL_TIMEZONE) });
      publishedQuizAnswers = publishedQuizAnswers.filter((item) => item.dateKey !== job.dateKey);
      logAdminEvent('corrigé et promotion publiés', ADMIN_JID, job.dateKey);
    }
    removePollJob(job.id);
  } catch (e) {
    removePollJob(job.id);
    logAdminEvent('échec publication canal', ADMIN_JID, `${job.id}: ${e?.message || e}`);
    await notifyAdmin(`❌ Publication du canal échouée (${job.id}) : ${e?.message || e}`);
  }
}

function scheduleChannelPollJob(job) {
  if (scheduledPollTimers.has(job.id)) return;
  const delay = Math.max(0, Date.parse(job.retryAt || job.scheduledAt) - Date.now());
  const timer = setTimeout(() => dispatchChannelPollJob(job), Math.min(delay, 2147480000));
  timer.unref?.();
  scheduledPollTimers.set(job.id, timer);
}

function scheduleAllChannelPolls() {
  for (const job of scheduledPollJobs) scheduleChannelPollJob(job);
}

function formatPollPreview() {
  const polls = scheduledPollJobs.filter((job) => job.kind === 'poll');
  if (!polls.length) return 'Aucun sondage en file. Active le programme avec !sondages on.';
  return `Aperçu des sondages programmés :\n${polls.map((job) => {
    const poll = job.poll;
    const formatName = { poll: 'Sondage natif', quiz: 'Quiz natif', question: 'Question native' }[job.format || 'poll'];
    return `\n${new Date(job.scheduledAt).toLocaleString('fr-FR', { timeZone: POLL_TIMEZONE })} · ${formatName} · ${poll.subject} (${poll.level})\n${poll.question}\n${poll.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}\nRéponse : ${poll.options[poll.answerIndex]}\n${poll.explanation}`;
  }).join('\n')}`;
}

async function ensureDailyPollJobs() {
  if (!channelPollsEnabled || !waReady || !sock || !channelJid || !channelCanPost) return;
  if (pollGenerationPromise) return pollGenerationPromise;
  const plan = getDailyPollSchedule(new Date(), POLL_TIMES, POLL_TIMEZONE);
  const targetDate = plan.dateKey;
  if (runtimeState.pollsGeneratedDate === targetDate) {
    scheduleAllChannelPolls();
    return;
  }
  if (scheduledPollJobs.some((job) => job.kind === 'poll' && job.dateKey === targetDate)) {
    runtimeState.pollsGeneratedDate = targetDate;
    persistRuntime();
    scheduleAllChannelPolls();
    return;
  }
  pollGenerationPromise = (async () => {
    let polls;
    try {
      const raw = await generateWithFallback(buildDailyPrompt(targetDate), [], QUIZ_SYSTEM_PROMPT);
      polls = parseGeneratedPollBatch(raw);
      console.log('[POLL] Quiz quotidiens générés par Gemini pour', targetDate);
    } catch (e) {
      polls = fallbackPollBatch(targetDate);
      console.warn('[POLL] Génération IA indisponible; banque locale utilisée:', e?.message || e);
      logAdminEvent('banque de secours quiz utilisée', ADMIN_JID, `${targetDate}: ${e?.message || e}`);
    }
    scheduledPollJobs = scheduledPollJobs.filter((job) => job.dateKey >= targetDate);
    const newJobs = polls.flatMap((poll, index) => {
      const time = POLL_TIMES[index];
      if (!plan.times.includes(time)) return [];
      return [{
        id: `quiz-${targetDate}-${index + 1}`,
        kind: 'poll',
        format: DAILY_INTERACTION_FORMATS[index],
        dateKey: targetDate,
        poll,
        scheduledAt: localDateTime(targetDate, time, POLL_TIMEZONE).toISOString(),
      }];
    });
    const [lastHour, lastMinute] = POLL_TIMES[POLL_TIMES.length - 1].split(':').map(Number);
    const recapTotal = lastHour * 60 + lastMinute + 30;
    const recapDate = recapTotal >= 1440 ? addLocalDays(targetDate, 1) : targetDate;
    const recapTime = `${String(Math.floor(recapTotal % 1440 / 60)).padStart(2, '0')}:${String(recapTotal % 60).padStart(2, '0')}`;
    newJobs.push({
      id: `quiz-recap-${targetDate}`,
      kind: 'recap',
      dateKey: targetDate,
      scheduledAt: localDateTime(recapDate, recapTime, POLL_TIMEZONE).toISOString(),
    });
    scheduledPollJobs.push(...newJobs);
    runtimeState.pollsGeneratedDate = targetDate;
    persistRuntime();
    scheduleAllChannelPolls();
  })().finally(() => {
    pollGenerationPromise = null;
  });
  return pollGenerationPromise;
}

async function handleControlCommand(msg, jid, text, fromAdmin) {
  const lower = (text || '').trim().toLowerCase();
  const adminOnly = /^(?:!|\/)(?:statut|status|confirmer statut|annuler statut|statuts|annulerstatut|maintenance|pause|resume|reponse|reponses|journal|sondages)(?:\s|$|:)/i.test(text || '');
  if (adminOnly && !fromAdmin) {
    await sock.sendMessage(jid, { text: 'Cette commande est réservée à l’administrateur.' });
    return true;
  }

  const pollCommand = text.trim().match(/^(?:!|\/)sondages(?:\s+(on|off|status|statut|aperçu|apercu))?\s*$/i);
  if (fromAdmin && pollCommand) {
    const action = (pollCommand[1] || 'status').toLowerCase();
    if (action === 'on') {
      try {
        if (!channelJid) await resolveChannelMetadata();
      } catch (e) {
        await sock.sendMessage(jid, { text: `Impossible d’activer les sondages : ${e?.message || e}` });
        return true;
      }
      if (!channelCanPost) {
        await sock.sendMessage(jid, { text: `Activation refusée : le compte lié doit être administrateur ou propriétaire du canal. Rôle détecté : ${channelRole || 'inconnu'}.` });
        return true;
      }
      channelPollsEnabled = true;
      persistRuntime();
      logAdminEvent('sondages automatiques activés', jid, `${channelJid}; ${channelScheduleLabel()}`);
      await sock.sendMessage(jid, { text: `✅ Programme activé pour ${channelJid}. Cinq publications natives WhatsApp par jour (2 Quiz, 2 Sondages, 1 Question) aux horaires ${channelScheduleLabel()}, puis un corrigé avec les liens Mathsfor.all 30 minutes après le dernier. Commandes : !sondages aperçu, !sondages off.` });
      ensureDailyPollJobs().catch((e) => notifyAdmin(`❌ Préparation des sondages impossible : ${e?.message || e}`));
    } else if (action === 'off') {
      channelPollsEnabled = false;
      for (const timer of scheduledPollTimers.values()) clearTimeout(timer);
      scheduledPollTimers.clear();
      scheduledPollJobs = [];
      runtimeState.pollsGeneratedDate = null;
      persistRuntime();
      logAdminEvent('sondages automatiques désactivés', jid, channelJid || 'canal non résolu');
      await sock.sendMessage(jid, { text: 'Programme de sondages désactivé ; toutes les publications futures en file ont été annulées.' });
    } else if (action === 'aperçu' || action === 'apercu') {
      await sock.sendMessage(jid, { text: formatPollPreview() });
    } else {
      const count = scheduledPollJobs.filter((job) => job.kind === 'poll').length;
      const roleStatus = channelRole || (channelCanPost ? 'inconnu — autorisé par la liste admin configurée' : 'non vérifié');
      await sock.sendMessage(jid, { text: `Sondages automatiques : ${channelPollsEnabled ? 'ACTIFS' : 'inactifs'}\nCanal : ${channelJid || CHANNEL_URL}\nRôle du compte : ${roleStatus}\nHoraires : ${channelScheduleLabel()}\nQuiz en attente : ${count}\n${channelPollsEnabled ? 'Désactiver : !sondages off' : 'Activer : !sondages on'}` });
    }
    return true;
  }

  if (fromAdmin && /^(?:!|\/)maintenance(?:\s|$)/i.test(text)) {
    const mode = lower.split(/\s+/)[1];
    if (mode === 'on' || mode === 'off') {
      maintenanceMode = mode === 'on';
      persistRuntime();
      logAdminEvent('maintenance', jid, maintenanceMode ? 'activée' : 'désactivée');
      await sock.sendMessage(jid, { text: `Mode maintenance ${maintenanceMode ? 'activé' : 'désactivé'}.` });
    } else {
      await sock.sendMessage(jid, { text: `Maintenance : ${maintenanceMode ? 'active' : 'inactive'}. Utilise !maintenance on|off.` });
    }
    return true;
  }
  if (fromAdmin && /^(?:!|\/)pause$/i.test(text)) {
    maintenanceMode = true;
    persistRuntime();
    logAdminEvent('maintenance', jid, 'activée');
    await sock.sendMessage(jid, { text: 'Réponses automatiques suspendues. Utilise !resume pour reprendre.' });
    return true;
  }
  if (fromAdmin && /^(?:!|\/)resume$/i.test(text)) {
    maintenanceMode = false;
    persistRuntime();
    logAdminEvent('maintenance', jid, 'désactivée');
    await sock.sendMessage(jid, { text: 'Réponses automatiques réactivées.' });
    return true;
  }
  if (fromAdmin && /^(?:!|\/)reponses$/i.test(text)) {
    const keys = Object.keys(quickReplies);
    await sock.sendMessage(jid, { text: `Réponses rapides : ${keys.map((key) => `!${key}`).join(', ')}\nModifier : !reponse clé | texte` });
    return true;
  }
  if (fromAdmin && /^(?:!|\/)reponse\s+/i.test(text)) {
    const match = text.trim().match(/^(?:!|\/)reponse\s+([\w-]+)\s*\|\s*([\s\S]+)$/i);
    if (!match) {
      await sock.sendMessage(jid, { text: 'Usage : !reponse tarifs | Nouveau texte de la réponse' });
    } else {
      quickReplies[match[1].toLowerCase()] = match[2].trim().slice(0, 1500);
      persistRuntime();
      logAdminEvent('réponse rapide modifiée', jid, match[1].toLowerCase());
      await sock.sendMessage(jid, { text: `Réponse rapide !${match[1].toLowerCase()} enregistrée.` });
    }
    return true;
  }
  if (fromAdmin && /^(?:!|\/)journal$/i.test(text)) {
    const lines = adminEvents.slice(-10).reverse().map((event) =>
      `${new Date(event.at).toLocaleString('fr-FR')} · ${event.type} · ${event.phone} · ${event.detail}`
    );
    await sock.sendMessage(jid, { text: lines.length ? `Journal récent :\n${lines.join('\n')}` : 'Le journal est vide.' });
    return true;
  }
  if (fromAdmin && /^(?:!|\/)statuts$/i.test(text)) {
    const lines = scheduledStatuses.map((job) =>
      `${job.id} · ${formatStatusDate(job.scheduledAt)} · ${job.caption || '[média]'}`
    );
    await sock.sendMessage(jid, { text: lines.length ? `Statuts programmés :\n${lines.join('\n')}\nAnnuler : !annulerstatut ID` : 'Aucun statut programmé.' });
    return true;
  }
  const cancelScheduled = text.trim().match(/^(?:!|\/)annulerstatut\s+([\w-]+)$/i);
  if (fromAdmin && cancelScheduled) {
    const id = cancelScheduled[1];
    const timer = scheduledStatusTimers.get(id);
    if (timer) clearTimeout(timer);
    scheduledStatusTimers.delete(id);
    const before = scheduledStatuses.length;
    scheduledStatuses = scheduledStatuses.filter((job) => job.id !== id);
    persistRuntime();
    if (before !== scheduledStatuses.length) logAdminEvent('statut programmé annulé', jid, id);
    await sock.sendMessage(jid, { text: before === scheduledStatuses.length ? 'Aucun statut avec cet identifiant.' : `Statut ${id} annulé.` });
    return true;
  }
  const reset = text.trim().match(/^(?:!|\/)reset(?:\s+(\d{8,15}))?$/i);
  if (reset) {
    let target = jid;
    if (reset[1]) {
      if (!fromAdmin) {
        await sock.sendMessage(jid, { text: 'La réinitialisation d’un autre contact est réservée à l’administrateur.' });
        return true;
      }
      target = reset[1] + '@s.whatsapp.net';
    }
    conversationHistory.delete(target);
    await sock.sendMessage(jid, { text: reset[1] && fromAdmin ? `Mémoire effacée pour ${reset[1]}.` : 'Mémoire de conversation effacée.' });
    return true;
  }

  if (/^(?:!|\/)?confirmer\s+statut$/i.test(text)) {
    if (!fromAdmin) {
      await sock.sendMessage(jid, { text: 'Cette commande est réservée à l’administrateur.' });
      return true;
    }
    if (!pendingStatus) {
      await sock.sendMessage(jid, { text: 'Aucun statut en attente de confirmation.' });
      return true;
    }
    const draft = pendingStatus;
    pendingStatus = null;
    if (draft.scheduledAt) {
      const job = { ...draft, id: `st-${Date.now()}` };
      scheduledStatuses.push(job);
      persistRuntime();
      scheduleStatusJob(job);
      logAdminEvent('statut programmé', jid, `${job.id}; ${job.scheduledAt}`);
      await sock.sendMessage(jid, { text: `✅ Statut programmé pour ${formatStatusDate(job.scheduledAt)} (ID ${job.id}).` });
    } else {
      try {
        const count = await publishStatus(draft);
        logAdminEvent('statut publié', jid, `${count} destinataires`);
        await sock.sendMessage(jid, { text: `✅ Statut publié pour ${count} destinataire(s).` });
      } catch (e) {
        logAdminEvent('échec publication statut', jid, e?.message || e);
        await sock.sendMessage(jid, { text: `❌ Publication échouée : ${e?.message || e}` });
      }
    }
    return true;
  }
  if (/^(?:!|\/)?annuler\s+statut$/i.test(text)) {
    if (!fromAdmin) {
      await sock.sendMessage(jid, { text: 'Cette commande est réservée à l’administrateur.' });
      return true;
    }
    pendingStatus = null;
    await sock.sendMessage(jid, { text: 'Brouillon de statut annulé.' });
    return true;
  }

  if (/^(?:!|\/)?(?:statut|status)(?:\b|$)/i.test(text)) {
    if (!fromAdmin) {
      await sock.sendMessage(jid, { text: 'Cette commande est réservée à l’administrateur.' });
      return true;
    }
    if (pendingStatus) {
      await sock.sendMessage(jid, { text: 'Un brouillon est déjà en attente. Réponds confirmer statut ou annuler statut avant d’en préparer un autre.' });
      return true;
    }
    const request = parseStatusCommand(text);
    const mediaType = getMediaType(msg);
    if (!request || (!request.caption && !mediaType)) {
      await sock.sendMessage(jid, { text: 'Usage : statut: texte (publie à la demande) | statut connus: texte | statut liste: texte | statut dans 15m: texte. Ajoute une photo/vidéo avec cette légende pour un statut média.' });
      return true;
    }
    if (request.caption.length > 700) {
      await sock.sendMessage(jid, { text: 'Le texte/légende du statut ne peut pas dépasser 700 caractères.' });
      return true;
    }
    const recipients = request.audience === 'all' ? [] : recipientsForAudience(request.audience);
    if (request.audience !== 'all' && !recipients.length) {
      await sock.sendMessage(jid, { text: request.audience === 'list'
        ? 'La liste est vide. Configure STATUS_RECIPIENTS (numéros séparés par des virgules) dans Render.'
        : 'Aucun contact connu pour cette audience. Utilise « statut: texte » pour publier à la demande.' });
      return true;
    }
    const draft = {
      caption: request.caption,
      audience: request.audience,
      recipients,
      scheduledAt: request.scheduledAt || null,
      mediaType: mediaType === 'image' || mediaType === 'video' ? mediaType : null,
      mediaBase64: null,
    };
    if (draft.mediaType) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
          logger,
          reuploadRequest: sock.updateMediaMessage,
        });
        if (!buffer?.length || buffer.length > 64 * 1024 * 1024) {
          await sock.sendMessage(jid, { text: 'Média vide ou supérieur à 64 Mo ; statut non préparé.' });
          return true;
        }
        draft.mediaBase64 = Buffer.from(buffer).toString('base64');
      } catch (e) {
        await sock.sendMessage(jid, { text: `Impossible de récupérer le média : ${e?.message || e}` });
        return true;
      }
    }
    pendingStatus = draft;
    const audienceName = request.audience === 'all' ? 'statut WhatsApp (publication immédiate)' : (request.audience === 'list' ? 'liste configurée' : 'contacts connus');
    const timing = draft.scheduledAt
      ? `Programmation : ${formatStatusDate(draft.scheduledAt)}`
      : 'Publication immédiate après confirmation';
    await sock.sendMessage(jid, {
      text: `Aperçu du statut${draft.mediaType ? ` (${draft.mediaType})` : ''}\n${draft.caption || '[sans légende]'}\nAudience : ${audienceName} (${recipients.length})\n${timing}\n\nRéponds « confirmer statut » pour valider ou « annuler statut » pour abandonner.`,
    });
    return true;
  }

  if (maintenanceMode && !fromAdmin) {
    await sock.sendMessage(jid, { text: 'Le service est temporairement en maintenance. Réessaie un peu plus tard.' });
    return true;
  }
  const quickKey = lower.match(/^!(\w[\w-]*)$/)?.[1];
  if (quickKey && quickReplies[quickKey]) {
    await sock.sendMessage(jid, { text: quickReplies[quickKey] });
    return true;
  }
  return false;
}

function scheduleReconnect(ms, reason) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log('[INFO] Reconnexion dans', ms / 1000, 's —', reason);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((e) => console.error('[ERR] restart', e.message));
  }, ms);
}

async function notifyAdminDeposit(clientPhone, clientJid) {
  const displayPhone = String(clientPhone);
  const adminMsg =
    'Le client de numéro ' +
    displayPhone +
    " affirme avoir effectué un dépôt d'argent sur l'un de vos numéros de téléphone, veuillez vérifier et me donner la permission de lui confirmer le succès de sa souscription.\n\n" +
    'Pour valider : ok ' +
    displayPhone +
    '\nPour refuser : non ' +
    displayPhone +
    "\n\n(Tu peux aussi m'écrire normalement pour toute autre question CMR SCHOOL.)";
  const key = String(clientPhone).replace(/\D/g, '') || clientPhone;
  pendingDeposits.set(key, { jid: clientJid, at: Date.now() });
  logAdminEvent('paiement à vérifier', clientJid, displayPhone);
  await sock.sendMessage(ADMIN_JID, { text: adminMsg });
  console.log('[DEPOT] Alerte →', ADMIN_NUMBER, '| client', displayPhone);
}

async function escalateToHuman(jid, text) {
  const previous = escalationThrottle.get(jid) || 0;
  if (Date.now() - previous < 30 * 60 * 1000) return;
  escalationThrottle.set(jid, Date.now());
  logAdminEvent('demande humaine', jid, text);
  await notifyAdmin(`🔔 Intervention humaine demandée par ${jidToPhone(jid)} :\n${String(text).slice(0, 400)}`);
}

async function loadAuthState() {
  return useMultiFileAuthState(AUTH_DIR);
}

const app = express();
app.get('/', (req, res) => {
  res.type('html').send(
    '<h2>' +
      BOT_NAME +
      '</h2><p>WhatsApp: <b>' +
      (waReady ? 'CONNECTÉ' : 'hors ligne') +
      '</b></p><p>Session: <b>locale (fichiers)</b></p>'
  );
});
app.get('/api/session/export', (req, res) => {
  if (!SESSION_API_TOKEN || req.get(SESSION_API_TOKEN_HEADER) !== SESSION_API_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ sessionId: exportSessionId(AUTH_DIR) });
  } catch (e) {
    return res.status(409).json({ error: e.message });
  }
});
app.get('/api/session', (req, res) => {
  if (!SESSION_API_TOKEN || req.get(SESSION_API_TOKEN_HEADER) !== SESSION_API_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const pairingCode = pairingCodeExpiresAt > Date.now() ? lastPairingCode : null;
  res.set('Cache-Control', 'no-store');
  return res.json({
    whatsapp: waReady ? 'connected' : 'waiting',
    pairingCode,
    pairingCodeExpiresAt: pairingCode ? new Date(pairingCodeExpiresAt).toISOString() : null,
    connectedAccount: connectedAccountPhone(),
  });
});
app.get('/health', (req, res) =>
  res.json({
    status: 'ok',
    whatsapp: waReady,
    session: 'local',
    admin: ADMIN_NUMBER,
  })
);
app.listen(PORT, () => console.log('[OK] HTTP port', PORT));

async function startBot() {
  const myBoot = ++bootId;
  const { state, saveCreds } = await loadAuthState();
  const { version } = await fetchLatestBaileysVersion();
  const registered = !!state.creds?.registered;

  console.log('----------------------------------------');
  console.log('[BOOT]', myBoot, '| Baileys', version.join('.'));
  console.log('[BOOT] OWNER_NUMBER =', OWNER || '(VIDE)');
  console.log('[BOOT] registered =', registered);
  console.log('[BOOT] session store = fichiers locaux');
  console.log('----------------------------------------');

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: true,
    getMessage: async (key) => msgStore.get(key.id) || undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (myBoot !== bootId) return;
    const { connection, lastDisconnect } = update;
    if (connection) console.log('[CONN] état =', connection);

    if (!sock.authState.creds.registered && OWNER && !pairingRequested) {
      pairingRequested = true;
      setTimeout(async () => {
        if (myBoot !== bootId || sock.authState.creds.registered) return;
        try {
          const code = await sock.requestPairingCode(OWNER);
          lastPairingCode = code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
          pairingCodeExpiresAt = Date.now() + 10 * 60 * 1000;
          console.log('[PAIR] Code généré et disponible via l’interface de session protégée.');
        } catch (e) {
          pairingRequested = false;
          console.error('[PAIR] ERREUR:', e.message);
        }
      }, 6000);
    }

    if (connection === 'close') {
      waReady = false;
      const status = lastDisconnect?.error?.output?.statusCode;
      console.log('[CONN] FERMÉ status=', status);
      if (status === 515) {
        pairingRequested = false;
        scheduleReconnect(3000, '515');
        return;
      }
      if (status === DisconnectReason.loggedOut || status === 401 || status === 440) {
        pairingRequested = false;
        console.log('[CONN] Session invalidée — il faudra re-pairer une fois');
        return;
      }
      pairingRequested = false;
      scheduleReconnect(5000, 'close');
    } else if (connection === 'open') {
      waReady = true;
      console.log('\n[OK] CONNECTÉ À WHATSAPP | store= local\n');
      resolveChannelMetadata()
        .then((metadata) => {
          if (!channelCanPost) {
            notifyAdmin(`ℹ️ Canal détecté (${metadata.name || channelJid}), mais le compte lié a le rôle ${channelRole || 'inconnu'}. Ajoute-le comme administrateur pour publier les sondages.`);
            return;
          }
          if (channelPollsEnabled) return ensureDailyPollJobs();
        })
        .catch((e) => notifyAdmin(`⚠️ Le canal WhatsApp n’a pas pu être résolu : ${e?.message || e}`));
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages || []) {
      try {
        storeMsg(msg);
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (jid && jid.endsWith('@s.whatsapp.net')) rememberStatusContact({ id: jid });
        if (isBroadcast(jid)) continue;
        if (isGroupJid(jid) && !REPLY_IN_GROUPS) continue;

        const text = extractText(msg).trim();
        if (!text && !getMediaType(msg)) continue;
        lastIncomingJid = jid;

        const det = detectLang(text);
        if (det) langByJid.set(jid, det);
        const lang = langByJid.get(jid) || 'fr';
        const lower = (text || '').toLowerCase();
        const fromAdmin = isAdminSender(
          [jid, msg.key.senderPn, msg.key.remoteJidAlt, msg.key.participantAlt],
          ADMIN_NUMBERS,
        );

        if (fromAdmin && text) {
          const decision = parseAdminDecision(text);
          if (decision) {
            let entry = pendingDeposits.get(decision.phone);
            let foundKey = decision.phone;
            if (!entry) {
              for (const [k, v] of pendingDeposits) {
                if (k.endsWith(decision.phone) || decision.phone.endsWith(k)) {
                  entry = v;
                  foundKey = k;
                  break;
                }
              }
            }
            if (!entry) {
              await sock.sendMessage(jid, {
                text: 'Aucun dépôt en attente pour ' + decision.phone,
              });
              continue;
            }
            if (decision.decision === 'approve') {
              await sock.sendMessage(entry.jid, {
                text:
                  '✅ Votre paiement a été confirmé. Bienvenue chez CMR SCHOOL !\nhttps://cmr-school.online',
              });
              await sock.sendMessage(jid, { text: '✅ Client ' + foundKey + ' confirmé.' });
              pendingDeposits.delete(foundKey);
            } else {
              await sock.sendMessage(entry.jid, {
                text: '❌ Dépôt non retrouvé. Vérifiez et réenvoyez une capture.',
              });
              await sock.sendMessage(jid, { text: '❌ Client ' + foundKey + ' refusé.' });
              pendingDeposits.delete(foundKey);
            }
            continue;
          }
        }

        if (text && isDepositClaim(text) && !fromAdmin) {
          try {
            await notifyAdminDeposit(jidToPhone(jid), jid);
            await sock.sendMessage(jid, {
              text: "Merci. L'équipe vérifie votre dépôt. Confirmation sous peu.",
            });
          } catch (e) {
            await sock.sendMessage(jid, { text: 'Message reçu. Contact: +237 677 152 300' });
          }
          continue;
        }

        if (!fromAdmin && getMediaType(msg) === 'image' && /momo|orange|transfert|payment|deposit|dép[oô]t/i.test(text || '')) {
          await notifyAdminDeposit(jidToPhone(jid), jid);
          await sock.sendMessage(jid, { text: 'Capture reçue. Vérification en cours.' });
          continue;
        }

        if (!fromAdmin && /\b(humain|conseiller|agent humain|parler à quelqu|réclamation|plainte|urgence|urgent)\b/i.test(text)) {
          await escalateToHuman(jid, text);
        }
        if (await handleControlCommand(msg, jid, text, fromAdmin)) continue;

        if (lower === 'ping') {
          await sock.sendMessage(jid, { text: 'Pong ✅' });
          continue;
        }
        if (lower === 'menu' || lower === 'aide' || lower === 'help') {
          await sock.sendMessage(jid, {
            text:
              '*' +
              BOT_NAME +
              '*\nhttps://cmr-school.online\nOffres, tarifs, inscription, paiement.\nRaccourcis : !tarifs, !inscription, !contact.\nDépôt fait ? Écrivez: J\'ai effectué un dépôt',
          });
          continue;
        }

        await sock.sendPresenceUpdate('composing', jid).catch(() => {});

        if (getMediaType(msg) === 'image') {
          const reply = await askAI(
            'Image + légende: ' + (text || '') + (fromAdmin ? '' : ' — cadre CMR SCHOOL uniquement.'),
            lang,
            jid,
            fromAdmin
          );
          await sock.sendMessage(jid, { text: reply });
          continue;
        }

        if (!text) continue;
        const reply = await askAI(
          wantsPdf(text) ? text + '\nFiche structurée CMR SCHOOL si pertinent.' : text,
          lang,
          jid,
          fromAdmin
        );
        if (wantsPdf(text) && reply.length > 60) {
          try {
            const pdfBuf = await textToPdf(text.slice(0, 50), reply);
            await sock.sendMessage(jid, {
              document: pdfBuf,
              mimetype: 'application/pdf',
              fileName: 'cmr-school-' + Date.now() + '.pdf',
              caption: 'CMR SCHOOL',
            });
          } catch (e) {
            await sock.sendMessage(jid, { text: reply });
          }
        } else {
          await sock.sendMessage(jid, { text: reply });
        }
      } catch (err) {
        console.error('[ERR] handler', err?.message || err);
        logAdminEvent('erreur handler', msg.key?.remoteJid, err?.message || err);
      }
    }
  });
}

scheduleAllStatuses();
const pollHeartbeat = setInterval(() => {
  if (channelPollsEnabled && waReady) {
    if (!channelJid && Date.now() - lastChannelResolveAt >= 5 * 60 * 1000) {
      resolveChannelMetadata()
        .then(() => ensureDailyPollJobs())
        .catch((e) => console.error('[POLL] résolution canal', e?.message || e));
    } else {
      ensureDailyPollJobs().catch((e) => console.error('[POLL] scheduler', e?.message || e));
    }
  }
}, 60 * 1000);
pollHeartbeat.unref?.();
startBot().catch((e) => {
  console.error('[ERR] start', e);
  scheduleReconnect(5000, 'start');
});
