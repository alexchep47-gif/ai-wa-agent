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
const { useMongoAuthState } = require('./lib/mongoAuth');

const PORT = process.env.PORT || 3000;
const BOT_NAME = process.env.BOT_NAME || 'CMR SCHOOL';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const REPLY_IN_GROUPS = (process.env.REPLY_IN_GROUPS || 'false').toLowerCase() === 'true';
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '237698877771').replace(/\D/g, '');
const ADMIN_JID = ADMIN_NUMBER + '@s.whatsapp.net';
const MONGODB_URI = process.env.MONGODB_URI || '';

const GEMINI_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
].filter(Boolean);

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

const msgStore = new Map();
function storeMsg(msg) {
  if (msg?.key?.id) {
    msgStore.set(msg.key.id, msg);
    if (msgStore.size > 300) msgStore.delete(msgStore.keys().next().value);
  }
}

const langByJid = new Map();
const pendingDeposits = new Map();

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
if (MONGODB_URI) console.log('[OK] MONGODB_URI défini → session persistante');
else console.log('[WARN] Pas de MONGODB_URI → session perdue à chaque deploy Render');

function getModel(name) {
  return genAI.getGenerativeModel({ model: name, systemInstruction: SYSTEM_PROMPT });
}

async function generateWithFallback(parts) {
  if (!genAI) throw new Error('GEMINI_API_KEY manquante');
  let lastErr;
  for (const name of GEMINI_MODELS) {
    try {
      const result = await getModel(name).generateContent(parts);
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

async function askAI(userMessage, lang) {
  if (!genAI) return 'Ajoute GEMINI_API_KEY sur Render.';
  const prefix =
    lang === 'en'
      ? 'English, short, CMR SCHOOL only.\n\n'
      : 'Français, court, uniquement CMR SCHOOL.\n\n';
  try {
    return await generateWithFallback(prefix + userMessage);
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
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  );
}

function getMediaType(msg) {
  const m = msg.message;
  if (!m) return null;
  if (m.imageMessage) return 'image';
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
  await sock.sendMessage(ADMIN_JID, { text: adminMsg });
  console.log('[DEPOT] Alerte →', ADMIN_NUMBER, '| client', displayPhone);
}

async function loadAuthState() {
  if (MONGODB_URI) {
    try {
      return await useMongoAuthState(MONGODB_URI);
    } catch (e) {
      console.error('[AUTH] Mongo échoué:', e.message, '— fallback fichiers locaux');
    }
  }
  const local = await useMultiFileAuthState(AUTH_DIR);
  return { state: local.state, saveCreds: local.saveCreds };
}

const app = express();
app.get('/', (req, res) => {
  res.type('html').send(
    '<h2>' +
      BOT_NAME +
      '</h2><p>WhatsApp: <b>' +
      (waReady ? 'CONNECTÉ' : 'hors ligne') +
      '</b></p><p>Session: <b>' +
      (MONGODB_URI ? 'MongoDB (persistante)' : 'locale (volatile)') +
      '</b></p>'
  );
});
app.get('/health', (req, res) =>
  res.json({
    status: 'ok',
    whatsapp: waReady,
    session: MONGODB_URI ? 'mongodb' : 'local',
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
  console.log('[BOOT] session store =', MONGODB_URI ? 'MongoDB' : 'fichiers locaux');
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
      console.log('\n[OK] CONNECTÉ À WHATSAPP | store=', MONGODB_URI ? 'MongoDB' : 'local', '\n');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages || []) {
      try {
        storeMsg(msg);
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
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

        if (lower === 'ping') {
          await sock.sendMessage(jid, { text: 'Pong ✅' });
          continue;
        }
        if (lower === 'menu' || lower === 'aide' || lower === 'help') {
          await sock.sendMessage(jid, {
            text:
              '*' +
              BOT_NAME +
              '*\nhttps://cmr-school.online\nOffres, tarifs, inscription, paiement.\nDépôt fait ? Écrivez: J\'ai effectué un dépôt',
          });
          continue;
        }

        await sock.sendPresenceUpdate('composing', jid).catch(() => {});

        if (getMediaType(msg) === 'image') {
          if (!fromAdmin && (isDepositClaim(text) || /momo|orange|transfert|payment/i.test(text || ''))) {
            await notifyAdminDeposit(jidToPhone(jid), jid);
            await sock.sendMessage(jid, { text: 'Capture reçue. Vérification en cours.' });
            continue;
          }
          const reply = await askAI(
            'Image + légende: ' + (text || '') + ' — cadre CMR SCHOOL uniquement.',
            lang
          );
          await sock.sendMessage(jid, { text: reply });
          continue;
        }

        if (!text) continue;
        const reply = await askAI(
          wantsPdf(text) ? text + '\nFiche structurée CMR SCHOOL si pertinent.' : text,
          lang
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
      }
    }
  });
}

startBot().catch((e) => {
  console.error('[ERR] start', e);
  scheduleReconnect(5000, 'start');
});
