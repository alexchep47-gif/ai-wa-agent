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

const PORT = process.env.PORT || 3000;
const BOT_NAME = process.env.BOT_NAME || 'CMR SCHOOL';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const REPLY_IN_GROUPS = (process.env.REPLY_IN_GROUPS || 'false').toLowerCase() === 'true';

const DEFAULT_SYSTEM_PROMPT = `Tu es un professeur de Maths et Physique pour les classes de Seconde, Première et Terminale au Cameroun.
Tu expliques clairement, tu donnes des exemples simples, et tu encourages l'élève.
Réponds toujours en français ou en anglais selon la langue du message reçu, de façon courte et adaptée à WhatsApp.

Tu peux analyser des images (exercices, énoncés, tableaux) et des documents texte / PDF quand l'élève les envoie.
Tu peux produire des fiches de révision sous forme de texte structuré (et un fichier .txt si demandé explicitement).

Tu es aussi l'agent officiel du site https://cmr-school.online.
Connaissance CMR SCHOOL :
- Slogan : Comprendre. Progresser. Réussir. / Comprendre aujourd'hui. Réussir demain.
- Matières : Maths, Physique, Chimie — programme camerounais (2nde, 1ère, Tle).
- Canaux : Web, WhatsApp, Telegram.
- Offres :
  1) CMR Fiches : supports structurés chapitre par chapitre, livraison WhatsApp/Telegram. Paiement PayPal sécurisé ; pour MTN MoMo / Orange Money contacter WhatsApp avant versement.
  2) CMR Répétitions : 3 séances/semaine · 2 h 30, Maths/Physique/Chimie, jusqu'à 4 séances avant examens. À partir de 20 000 FCFA/mois (indicatif site : 20k 2nde, 30k 1ère, 40k Tle — le conseiller confirme).
  3) CMR Pack : fiches + répétitions, suivi parent possible, prix négociable dès 3 enfants.
- Contact Mobile Money / inscription : WhatsApp +237 677 152 300.
- Méthode : identifier le besoin → bon support → ancrer les progrès. La régularité compte plus que la pression.
Si on te pose une question sur le site ou les offres, réponds avec ces infos et invite à visiter https://cmr-school.online ou à écrire pour s'inscrire.`;

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;

const logger = pino({ level: 'silent' });
const AUTH_DIR = path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const msgStore = new Map();
function storeMsg(msg) {
  if (msg?.key?.id) {
    msgStore.set(msg.key.id, msg);
    if (msgStore.size > 300) {
      const first = msgStore.keys().next().value;
      msgStore.delete(first);
    }
  }
}

const langByJid = new Map();

function detectLang(text) {
  const t = (text || '').toLowerCase();
  const enHints = /\b(the|what|how|why|please|explain|solve|help|hello|hi|thanks)\b/;
  const frHints = /\b(le|la|les|des|une|est|pour|avec|comment|pourquoi|explique|résous|bonjour|salut|merci)\b/;
  if (enHints.test(t) && !frHints.test(t)) return 'en';
  if (frHints.test(t)) return 'fr';
  return null;
}

let model = null;
let visionModel = null;
if (GEMINI_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_PROMPT,
    });
    visionModel = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_PROMPT,
    });
    console.log('[OK] Gemini prêt (texte + vision)');
  } catch (e) {
    console.error('[ERR] Gemini:', e.message);
  }
} else {
  console.log('[WARN] GEMINI_API_KEY absente');
}

async function askAI(userMessage, lang) {
  if (!model) {
    return lang === 'en'
      ? 'Gemini API key missing. Set GEMINI_API_KEY on Render.'
      : 'Clé Gemini manquante. Ajoute GEMINI_API_KEY sur Render.';
  }
  const prefix =
    lang === 'en'
      ? 'Reply in English. Short WhatsApp style.\n\n'
      : 'Réponds en français. Style WhatsApp court.\n\n';
  try {
    const result = await model.generateContent(prefix + userMessage);
    return result.response.text() || '...';
  } catch (e) {
    console.error('[ERR] Gemini:', e.message);
    try {
      const genAI = new GoogleGenerativeAI(GEMINI_KEY);
      const fb = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: SYSTEM_PROMPT,
      });
      const r = await fb.generateContent(prefix + userMessage);
      return r.response.text() || '...';
    } catch (e2) {
      return 'Erreur IA: ' + String(e.message).slice(0, 120);
    }
  }
}

async function askAIWithImage(caption, buffer, mimeType, lang) {
  if (!visionModel) return askAI(caption || 'Analyse cette image', lang);
  const prefix =
    lang === 'en'
      ? 'Analyze this image (exercise, diagram, text). Reply in English, short.\n'
      : 'Analyse cette image (exercice, schéma, texte). Réponds en français, court.\n';
  try {
    const result = await visionModel.generateContent([
      prefix + (caption || ''),
      { inlineData: { data: buffer.toString('base64'), mimeType: mimeType || 'image/jpeg' } },
    ]);
    return result.response.text() || '...';
  } catch (e) {
    console.error('[ERR] vision:', e.message);
    return askAI(
      (caption || '') + '\n[Image reçue mais analyse vision échouée: ' + e.message + ']',
      lang
    );
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
  if (m.documentMessage) return 'document';
  if (m.documentWithCaptionMessage?.message?.documentMessage) return 'document';
  if (m.videoMessage) return 'video';
  return null;
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}
function isBroadcast(jid) {
  return !jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

function wantsFile(text) {
  const t = (text || '').toLowerCase();
  return (
    /\b(fiche|fichier|file|génère|genere|generate|export|txt|pdf)\b/.test(t) &&
    /\b(fiche|révision|revision|cours|summary|notes|fichier|file)\b/.test(t)
  );
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
    <p>Gemini: <b>${model ? 'OK' : 'NON'}</b></p>
    <p><a href="/health">/health</a> · <a href="/test-send">/test-send</a></p>
  `);
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsapp: waReady, gemini: !!model, owner: OWNER || null, lastIncomingJid });
});
app.get('/test-send', async (req, res) => {
  try {
    if (!sock || !waReady) return res.status(503).json({ ok: false, error: 'WhatsApp offline' });
    const text = (req.query.text || `Test ${BOT_NAME} ✅`).toString();
    let jid = (req.query.to || '').toString().replace(/\D/g, '');
    if (jid) jid = jid + '@s.whatsapp.net';
    else if (lastIncomingJid) jid = lastIncomingJid;
    else if (OWNER) jid = OWNER + '@s.whatsapp.net';
    else return res.status(400).json({ ok: false, error: 'to= required' });
    await sock.sendMessage(jid, { text });
    res.json({ ok: true, to: jid, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.listen(PORT, () => console.log('[OK] HTTP port', PORT));

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log('[OK] Baileys', version.join('.'), '| OWNER=', OWNER || '(vide)', '| registered=', !!state.creds?.registered);

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
          const code = await sock.requestPairingCode(OWNER);
          const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
          console.log('\n*** CODE DE PAIRING:', pretty, '***\n');
        } catch (e) {
          pairingRequested = false;
          console.error('[ERR] pairing', e.message);
        }
      }, 4000);
    }

    if (connection === 'close') {
      waReady = false;
      const status = lastDisconnect?.error?.output?.statusCode;
      // 515 = restartRequired : normal juste après un pairing réussi
      if (status === 515) {
        console.log('[INFO] status 515 = restartRequired (normal après pairing). Relance...');
        pairingRequested = false;
        scheduleReconnect(2000, '515 restartRequired');
        return;
      }
      if (status === DisconnectReason.loggedOut || status === 401) {
        console.log('[ERR] Session déconnectée (loggedOut). Il faut re-pairer.');
        pairingRequested = false;
        return;
      }
      console.log('[WARN] close status=', status, '— reconnexion...');
      pairingRequested = false;
      scheduleReconnect(4000, 'close ' + status);
    } else if (connection === 'open') {
      waReady = true;
      console.log(`[OK] ${BOT_NAME} CONNECTÉ — multimédia + CMR SCHOOL actifs`);
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
        console.log('[MSG] jid=', jid, 'media=', mediaType, 'text=', JSON.stringify(text.slice(0, 80)));

        if (!text && !mediaType) continue;

        lastIncomingJid = jid;

        let lang = langByJid.get(jid);
        const detected = detectLang(text);
        if (detected) {
          lang = detected;
          langByJid.set(jid, lang);
        }
        if (!lang) lang = 'fr';

        const lower = text.toLowerCase();

        if (lower === 'ping') {
          await sock.sendMessage(jid, { text: 'Pong ✅' });
          continue;
        }
        if (lower === 'menu' || lower === 'aide' || lower === 'help') {
          const menu =
            lang === 'en'
              ? `*${BOT_NAME}*\nSend any Maths/Physics question.\nSend a photo of an exercise.\nAsk about https://cmr-school.online`
              : `*${BOT_NAME}*\nEnvoie une question Maths/Physique.\nEnvoie une photo d'exercice.\nQuestions sur https://cmr-school.online`;
          await sock.sendMessage(jid, { text: menu });
          continue;
        }

        await sock.sendPresenceUpdate('composing', jid).catch(() => {});

        if (mediaType === 'image') {
          try {
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );
            const mime = msg.message.imageMessage?.mimetype || 'image/jpeg';
            const reply = await askAIWithImage(text, buffer, mime, lang);
            await sock.sendMessage(jid, { text: reply });
            console.log('[MSG] image OK');
          } catch (e) {
            console.error('[ERR] image', e.message);
            await sock.sendMessage(jid, {
              text: lang === 'en' ? 'Could not read the image.' : "Impossible de lire l'image.",
            });
          }
          continue;
        }

        if (mediaType === 'document') {
          try {
            const doc =
              msg.message.documentMessage ||
              msg.message.documentWithCaptionMessage?.message?.documentMessage;
            const mime = doc?.mimetype || '';
            const fileName = doc?.fileName || 'fichier';
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );

            if (mime.startsWith('image/')) {
              const reply = await askAIWithImage(text || fileName, buffer, mime, lang);
              await sock.sendMessage(jid, { text: reply });
            } else if (mime.includes('text') || fileName.endsWith('.txt') || fileName.endsWith('.md')) {
              const content = buffer.toString('utf8').slice(0, 12000);
              const reply = await askAI(
                `Fichier reçu (${fileName}):\n${content}\n\n${text || "Résume et aide l'élève."}`,
                lang
              );
              await sock.sendMessage(jid, { text: reply });
            } else if (mime.includes('pdf') || fileName.endsWith('.pdf')) {
              const reply = await askAI(
                `L'élève a envoyé un PDF "${fileName}". ` +
                  (text ? `Question: ${text}` : "Demande une photo des pages ou une description de l'énoncé.") +
                  ' Ne invente pas le contenu du PDF.',
                lang
              );
              await sock.sendMessage(jid, { text: reply });
            } else {
              await sock.sendMessage(jid, {
                text:
                  lang === 'en'
                    ? `File (${fileName}) received. Send a photo of the exercise.`
                    : `Fichier (${fileName}) reçu. Envoie une photo de l'exercice.`,
              });
            }
            console.log('[MSG] document OK', fileName);
          } catch (e) {
            console.error('[ERR] document', e.message);
          }
          continue;
        }

        if (!text) continue;

        const reply = await askAI(text, lang);

        if (wantsFile(text) && reply.length > 80) {
          const fileBuf = Buffer.from(reply, 'utf8');
          const fname = `fiche-cmr-school-${Date.now()}.txt`;
          await sock.sendMessage(jid, {
            document: fileBuf,
            mimetype: 'text/plain',
            fileName: fname,
            caption: lang === 'en' ? 'Your revision sheet' : 'Ta fiche de révision',
          });
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
  scheduleReconnect(5000, 'start error');
});
