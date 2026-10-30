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

const PORT = process.env.PORT || 3000;
const BOT_NAME = process.env.BOT_NAME || 'CMR SCHOOL';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const REPLY_IN_GROUPS = (process.env.REPLY_IN_GROUPS || 'false').toLowerCase() === 'true';
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '237698877771').replace(/\D/g, '');
const ADMIN_JID = ADMIN_NUMBER + '@s.whatsapp.net';

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
const AUTH_DIR = path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
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

function persistRuntime() {
  runtimeState.statusRecipients = [...statusRecipients];
  runtimeState.quickReplies = quickReplies;
  runtimeState.maintenanceMode = maintenanceMode;
  runtimeState.scheduledStatuses = scheduledStatuses;
  runtimeState.adminEvents = adminEvents.slice(-100);
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
      audience: 'known',
      scheduledAt: new Date(Date.now() + minutes * 60000).toISOString(),
    };
  }
  const audience = body.match(/^(connus|liste)\s*:\s*([\s\S]+)$/i);
  const textMatch = body.match(/^:\s*([\s\S]+)$/);
  const caption = (audience ? audience[2] : textMatch ? textMatch[1] : body.replace(/^[-:]\s*/, '')).trim();
  if (!caption) return null;
  return { caption, audience: audience?.[1]?.toLowerCase() === 'liste' ? 'list' : 'known' };
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

function isAdminJid(jid) {
  return jidToPhone(jid) === ADMIN_NUMBER || jid === ADMIN_JID;
}

let genAI = null;
let activeModelName = null;
if (GEMINI_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_KEY);
  activeModelName = GEMINI_MODELS[0];
  console.log('[OK] Gemini —', GEMINI_MODELS.join(' → '));
} else console.log('[WARN] GEMINI_API_KEY absente');
console.log('[OK] ADMIN dépôts:', ADMIN_NUMBER);

function getModel(name) {
  return genAI.getGenerativeModel({ model: name, systemInstruction: SYSTEM_PROMPT });
}

async function generateWithFallback(parts, history = []) {
  if (!genAI) throw new Error('GEMINI_API_KEY manquante');
  let lastErr;
  for (const name of GEMINI_MODELS) {
    try {
      const model = getModel(name);
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

async function askAI(userMessage, lang, jid) {
  if (!genAI) return 'Ajoute GEMINI_API_KEY sur Render.';
  const prefix =
    lang === 'en'
      ? 'English, short, CMR SCHOOL only.\n\n'
      : 'Français, court, uniquement CMR SCHOOL.\n\n';
  const prompt = prefix + userMessage;
  const history = jid ? conversationHistory.get(jid) || [] : [];
  try {
    const reply = await generateWithFallback(prompt, history);
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
    return 'Erreur IA: ' + String(e.message).slice(0, 160);
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
  const recipients = draft.recipients || recipientsForAudience(draft.audience);
  if (!recipients.length) throw new Error('Audience vide');
  let content;
  if (draft.mediaType === 'image' || draft.mediaType === 'video') {
    content = {
      [draft.mediaType]: Buffer.from(draft.mediaBase64, 'base64'),
      ...(draft.caption ? { caption: draft.caption } : {}),
    };
  } else {
    content = { text: draft.caption };
  }
  await sock.sendMessage('status@broadcast', content, {
    broadcast: true,
    statusJidList: recipients,
  });
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

async function handleControlCommand(msg, jid, text, fromAdmin) {
  const lower = (text || '').trim().toLowerCase();
  const adminOnly = /^(?:!|\/)(?:statut|status|confirmer statut|annuler statut|statuts|annulerstatut|maintenance|pause|resume|reponse|reponses|journal)(?:\s|$|:)/i.test(text || '');
  if (adminOnly && !fromAdmin) {
    await sock.sendMessage(jid, { text: 'Cette commande est réservée à l’administrateur.' });
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
      await sock.sendMessage(jid, { text: 'Usage : statut: texte | statut connus: texte | statut liste: texte | statut dans 15m: texte. Ajoute une photo/vidéo avec cette légende pour un statut média.' });
      return true;
    }
    if (request.caption.length > 700) {
      await sock.sendMessage(jid, { text: 'Le texte/légende du statut ne peut pas dépasser 700 caractères.' });
      return true;
    }
    const recipients = recipientsForAudience(request.audience);
    if (!recipients.length) {
      await sock.sendMessage(jid, { text: request.audience === 'list'
        ? 'La liste est vide. Configure STATUS_RECIPIENTS (numéros séparés par des virgules) dans Render.'
        : 'Aucun contact connu. Cette audience se remplit quand des contacts écrivent au bot.' });
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
    const audienceName = request.audience === 'list' ? 'liste configurée' : 'contacts connus';
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
          const pretty = code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
          console.log('\n******** CODE DE PAIRING ********');
          console.log('         ', pretty);
          console.log('********************************\n');
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
        const fromAdmin = isAdminJid(jid);

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
            'Image + légende: ' + (text || '') + ' — cadre CMR SCHOOL uniquement.',
            lang,
            jid
          );
          await sock.sendMessage(jid, { text: reply });
          continue;
        }

        if (!text) continue;
        const reply = await askAI(
          wantsPdf(text) ? text + '\nFiche structurée CMR SCHOOL si pertinent.' : text,
          lang,
          jid
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
startBot().catch((e) => {
  console.error('[ERR] start', e);
  scheduleReconnect(5000, 'start');
});
