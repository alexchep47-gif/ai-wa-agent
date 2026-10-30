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

const GEMINI_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
].filter(Boolean);

const DEFAULT_SYSTEM_PROMPT = `Tu es un professeur de Maths et Physique pour les classes de Seconde, Première et Terminale au Cameroun.
Tu expliques clairement, tu donnes des exemples simples, et tu encourages l'élève.
Réponds toujours en français ou en anglais selon la langue du message reçu, de façon courte et adaptée à WhatsApp.

Tu peux analyser des images (exercices, énoncés) envoyées par l'élève.
Quand on te demande une fiche, un cours structuré ou un PDF, rédige un contenu clair et bien organisé (titres, points clés, exemples).

Tu es l'agent officiel de https://cmr-school.online.
Offres : CMR Fiches, CMR Répétitions (dès ~20 000 FCFA/mois selon classe), CMR Pack.
Contact : WhatsApp +237 677 152 300. Paiement PayPal ou Mobile Money (instructions via WhatsApp).`;

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
function detectLang(text) {
  const t = (text || '').toLowerCase();
  const en = /\b(the|what|how|why|please|explain|solve|help|hello|hi)\b/;
  const fr = /\b(le|la|les|des|une|est|pour|avec|comment|pourquoi|explique|bonjour|salut)\b/;
  if (en.test(t) && !fr.test(t)) return 'en';
  if (fr.test(t)) return 'fr';
  return null;
}

let genAI = null;
let activeModelName = null;
if (GEMINI_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_KEY);
  activeModelName = GEMINI_MODELS[0];
  console.log('[OK] Gemini —', GEMINI_MODELS.join(' → '));
} else console.log('[WARN] GEMINI_API_KEY absente');

function getModel(name) {
  return genAI.getGenerativeModel({ model: name, systemInstruction: SYSTEM_PROMPT });
}

async function generateWithFallback(parts) {
  if (!genAI) throw new Error('GEMINI_API_KEY manquante');
  let lastErr;
  for (const name of GEMINI_MODELS) {
    try {
      const result = await getModel(name).generateContent(parts);
      const text = result.response.text();
      if (activeModelName !== name) {
        activeModelName = name;
        console.log('[OK] Modèle actif:', name);
      }
      return text || '...';
    } catch (e) {
      lastErr = e;
      console.error('[WARN] modèle', name, e.message?.slice(0, 120));
    }
  }
  throw lastErr || new Error('Gemini échoué');
}

async function askAI(userMessage, lang) {
  if (!genAI) {
    return lang === 'en'
      ? 'Set GEMINI_API_KEY on Render.'
      : 'Ajoute GEMINI_API_KEY sur Render.';
  }
  const prefix =
    lang === 'en'
      ? 'Reply in English. Short WhatsApp style.\n\n'
      : 'Réponds en français. Style WhatsApp court.\n\n';
  try {
    return await generateWithFallback(prefix + userMessage);
  } catch (e) {
    return 'Erreur IA: ' + String(e.message).slice(0, 160);
  }
}

async function askAIWithImage(caption, buffer, mimeType, lang) {
  if (!genAI) return askAI(caption || 'Analyse image', lang);
  const prefix =
    lang === 'en'
      ? 'Analyze this exercise image. English, short.\n'
      : 'Analyse cette image d\'exercice. Français, court.\n';
  try {
    return await generateWithFallback([
      prefix + (caption || ''),
      { inlineData: { data: buffer.toString('base64'), mimeType: mimeType || 'image/jpeg' } },
    ]);
  } catch (e) {
    return askAI((caption || '') + '\n[vision échouée]', lang);
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
  if (m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage) return 'document';
  if (m.videoMessage) return 'video';
  return null;
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}
function isBroadcast(jid) {
  return !jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

/** Demande explicite de fiche / PDF */
function wantsPdf(text) {
  const t = (text || '').toLowerCase();
  return /\b(pdf|fiche|fichier|document|export)\b/.test(t);
}

let sock = null;
let waReady = false;
let pairingRequested = false;
let lastIncomingJid = null;
let reconnectTimer = null;

function scheduleReconnect(ms, reason) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[INFO] Reconnexion dans ${ms / 1000}s (${reason})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((e) => console.error('[ERR] restart', e.message));
  }, ms);
}

const app = express();
app.get('/', (req, res) => {
  res.type('html').send(`
    <h2>${BOT_NAME}</h2>
    <p>WhatsApp: <b>${waReady ? 'CONNECTÉ' : 'hors ligne'}</b></p>
    <p>Gemini: <b>${genAI ? 'OK (' + (activeModelName || '?') + ')' : 'NON'}</b></p>
    <p><a href="/health">/health</a> · <a href="/test-send">/test-send</a></p>
  `);
});
app.get('/health', (req, res) =>
  res.json({ status: 'ok', whatsapp: waReady, gemini: !!genAI, model: activeModelName, owner: OWNER || null })
);
app.get('/test-send', async (req, res) => {
  try {
    if (!sock || !waReady) return res.status(503).json({ ok: false, error: 'WhatsApp offline' });
    const text = (req.query.text || `Test ${BOT_NAME}`).toString();
    let jid = (req.query.to || '').toString().replace(/\D/g, '');
    if (jid) jid += '@s.whatsapp.net';
    else if (lastIncomingJid) jid = lastIncomingJid;
    else if (OWNER) jid = OWNER + '@s.whatsapp.net';
    else return res.status(400).json({ ok: false, error: 'to= required' });
    await sock.sendMessage(jid, { text });
    res.json({ ok: true, to: jid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.listen(PORT, () => console.log('[OK] HTTP port', PORT));

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log(
    '[OK] Baileys', version.join('.'),
    '| OWNER=', OWNER || '(vide)',
    '| registered=', !!state.creds?.registered
  );
  if (!OWNER) console.log('[WARN] OWNER_NUMBER vide → pairing impossible');

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
    const { connection, lastDisconnect } = update;

    if (!sock.authState.creds.registered && OWNER && !pairingRequested) {
      pairingRequested = true;
      setTimeout(async () => {
        try {
          console.log('[INFO] Demande pairing pour WhatsApp (Business OK) numéro:', OWNER);
          const code = await sock.requestPairingCode(OWNER);
          const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
          console.log('\n========================================');
          console.log('  CODE DE PAIRING :', pretty);
          console.log('========================================');
          console.log('WhatsApp Business > Paramètres > Appareils connectés');
          console.log('> Connecter un appareil > Lier avec un numéro');
          console.log('Entre le code en moins d\'1 minute.\n');
        } catch (e) {
          pairingRequested = false;
          console.error('[ERR] pairing:', e.message);
          console.log('[TIP] Vérifie OWNER_NUMBER = numéro Business sans + (ex 2376...)');
        }
      }, 5000);
    }

    if (connection === 'close') {
      waReady = false;
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === 515) {
        console.log('[INFO] 515 restartRequired (normal après pairing)');
        pairingRequested = false;
        scheduleReconnect(2500, '515');
        return;
      }
      if (status === DisconnectReason.loggedOut || status === 401) {
        console.log('[ERR] loggedOut — re-pairer le numéro Business');
        pairingRequested = false;
        return;
      }
      console.log('[WARN] close', status);
      pairingRequested = false;
      scheduleReconnect(4000, 'close');
    } else if (connection === 'open') {
      waReady = true;
      console.log(`[OK] ${BOT_NAME} CONNECTÉ`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log('[MSG] type=', type, 'n=', messages?.length || 0);

    for (const msg of messages || []) {
      try {
        storeMsg(msg);
        if (!msg.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (isBroadcast(jid)) continue;
        if (isGroupJid(jid) && !REPLY_IN_GROUPS) continue;

        const text = extractText(msg).trim();
        const mediaType = getMediaType(msg);
        console.log('[MSG]', jid, mediaType, JSON.stringify(text.slice(0, 60)));

        if (!text && !mediaType) continue;
        lastIncomingJid = jid;

        let lang = langByJid.get(jid);
        const det = detectLang(text);
        if (det) {
          lang = det;
          langByJid.set(jid, lang);
        }
        if (!lang) lang = 'fr';

        const lower = text.toLowerCase();
        if (lower === 'ping') {
          await sock.sendMessage(jid, { text: 'Pong ✅' });
          continue;
        }
        if (lower === 'menu' || lower === 'aide' || lower === 'help') {
          await sock.sendMessage(jid, {
            text:
              lang === 'en'
                ? `*${BOT_NAME}*\nQuestions, photos d'exercices, "fiche PDF dérivées"...\nhttps://cmr-school.online`
                : `*${BOT_NAME}*\nQuestions, photos d'exercices.\nPour un PDF : "fiche PDF dérivées Terminale"\nhttps://cmr-school.online`,
          });
          continue;
        }

        await sock.sendPresenceUpdate('composing', jid).catch(() => {});

        if (mediaType === 'image') {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger,
            reuploadRequest: sock.updateMediaMessage,
          });
          const mime = msg.message.imageMessage?.mimetype || 'image/jpeg';
          const reply = await askAIWithImage(text, buffer, mime, lang);
          await sock.sendMessage(jid, { text: reply });
          continue;
        }

        if (mediaType === 'document') {
          const doc =
            msg.message.documentMessage ||
            msg.message.documentWithCaptionMessage?.message?.documentMessage;
          const fileName = doc?.fileName || 'fichier';
          const mime = doc?.mimetype || '';
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger,
            reuploadRequest: sock.updateMediaMessage,
          });
          if (mime.startsWith('image/')) {
            const reply = await askAIWithImage(text || fileName, buffer, mime, lang);
            await sock.sendMessage(jid, { text: reply });
          } else if (mime.includes('text') || /\.(txt|md)$/i.test(fileName)) {
            const content = buffer.toString('utf8').slice(0, 12000);
            const reply = await askAI(`Fichier ${fileName}:\n${content}\n\n${text || 'Aide'}`, lang);
            await sock.sendMessage(jid, { text: reply });
          } else {
            const reply = await askAI(
              `Document "${fileName}" reçu. ${text || 'Demande une photo des pages utiles.'}`,
              lang
            );
            await sock.sendMessage(jid, { text: reply });
          }
          continue;
        }

        if (!text) continue;

        // Contenu plus riche si demande PDF/fiche
        const prompt = wantsPdf(text)
          ? text +
            '\n\nRédige une fiche complète et structurée (titres, points, exemples), prête à mettre en PDF.'
          : text;

        const reply = await askAI(prompt, lang);

        if (wantsPdf(text) && reply.length > 60) {
          try {
            const title = (text.slice(0, 60) || 'Fiche CMR SCHOOL').replace(/\n/g, ' ');
            const pdfBuf = await textToPdf(title, reply);
            await sock.sendMessage(jid, {
              document: pdfBuf,
              mimetype: 'application/pdf',
              fileName: `fiche-cmr-school-${Date.now()}.pdf`,
              caption: lang === 'en' ? 'Your PDF sheet' : 'Ta fiche PDF CMR SCHOOL',
            });
            console.log('[MSG] PDF envoyé');
          } catch (e) {
            console.error('[ERR] PDF', e.message);
            await sock.sendMessage(jid, { text: reply });
          }
        } else {
          await sock.sendMessage(jid, { text: reply });
        }
        console.log('[MSG] ENVOYÉ OK');
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
