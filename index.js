require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_NAME = process.env.BOT_NAME || 'CMR AI Agent';
const OWNER = (process.env.OWNER_NUMBER || process.env.PAIRING_NUMBER || '').replace(/\D/g, '');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
// true = répond aussi dans les groupes (pour test)
const REPLY_IN_GROUPS = (process.env.REPLY_IN_GROUPS || 'false').toLowerCase() === 'true';

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Tu es ${BOT_NAME}, un assistant éducatif camerounais amical, clair et concis.
Tu aides les élèves (Seconde, Première, Terminale) en Maths, Physique, Chimie et culture générale.
Réponds toujours en français, de façon utile et adaptée à WhatsApp (messages courts).`;

const logger = pino({ level: 'silent' });
const AUTH_DIR = path.join(__dirname, 'auth_info');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let model = null;
if (GEMINI_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_PROMPT,
    });
    console.log('[OK] Gemini initialisé (gemini-2.0-flash)');
  } catch (e) {
    console.error('[ERR] Gemini init:', e.message);
  }
} else {
  console.log('[WARN] GEMINI_API_KEY manquante — le bot ne pourra pas répondre en IA');
}

async function askAI(userMessage) {
  if (!model) {
    return '⚠️ Clé Gemini manquante ou invalide. Vérifie GEMINI_API_KEY sur Render.';
  }
  try {
    const result = await model.generateContent(userMessage);
    const text = result.response.text();
    return text || '...';
  } catch (e) {
    console.error('[ERR] Gemini:', e.message);
    // Fallback ancien modèle
    try {
      const genAI = new GoogleGenerativeAI(GEMINI_KEY);
      const fallback = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: SYSTEM_PROMPT,
      });
      const result = await fallback.generateContent(userMessage);
      return result.response.text() || '...';
    } catch (e2) {
      console.error('[ERR] Gemini fallback:', e2.message);
      return '❌ Erreur IA: ' + (e.message || 'clé ou quota').slice(0, 120);
    }
  }
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  );
}

const app = express();
app.get('/', (req, res) => res.send(`${BOT_NAME} is running ✅`));
app.get('/health', (req, res) =>
  res.json({ status: 'ok', bot: BOT_NAME, gemini: !!model, owner: OWNER || null })
);
app.listen(PORT, () => console.log(`[OK] HTTP on port ${PORT}`));

let pairingRequested = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log('[OK] Baileys', version.join('.'));
  console.log('[INFO] OWNER_NUMBER:', OWNER || '(vide)');
  console.log('[INFO] REPLY_IN_GROUPS:', REPLY_IN_GROUPS);

  const sock = makeWASocket({
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
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[INFO] QR reçu (pairing préféré si possible)');
    }

    if (!sock.authState.creds.registered && OWNER && !pairingRequested) {
      pairingRequested = true;
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(OWNER);
          const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
          console.log('\n======== CODE DE PAIRING ========');
          console.log(`  ${pretty}`);
          console.log('=================================\n');
        } catch (e) {
          pairingRequested = false;
          console.error('[ERR] Pairing:', e.message);
        }
      }, 4000);
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = status !== DisconnectReason.loggedOut;
      console.log('[WARN] Connexion fermée. status=', status, 'reconnect=', shouldReconnect);
      pairingRequested = false;
      if (shouldReconnect) setTimeout(startBot, 4000);
    } else if (connection === 'open') {
      console.log(`\n[OK] ${BOT_NAME} CONNECTÉ À WHATSAPP`);
      console.log('[OK] En attente de messages privés...\n');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Log TOUT pour debug
    console.log('[MSG] upsert type=', type, 'count=', messages?.length);

    for (const msg of messages || []) {
      try {
        if (!msg.message) {
          console.log('[MSG] skip: pas de message (proto vide)');
          continue;
        }
        if (msg.key.fromMe) {
          console.log('[MSG] skip: fromMe');
          continue;
        }

        const from = msg.key.remoteJid;
        const isGroup = from?.endsWith('@g.us');
        const text = extractText(msg).trim();

        console.log('[MSG] from=', from, 'group=', isGroup, 'text=', text.slice(0, 80));

        if (!text) {
          console.log('[MSG] skip: texte vide (média sans légende ?)');
          continue;
        }

        if (isGroup && !REPLY_IN_GROUPS) {
          console.log('[MSG] skip: groupe (mets REPLY_IN_GROUPS=true pour activer)');
          continue;
        }

        // Ignore status / broadcast
        if (from === 'status@broadcast') continue;

        const lower = text.toLowerCase();

        if (lower === 'menu' || lower === 'aide' || lower === 'help') {
          await sock.sendMessage(from, {
            text: `*${BOT_NAME}* 🤖\n\nÉcris-moi n'importe quoi, je te réponds.\n\nExemples :\n• Explique la photosynthèse\n• Résous 2x + 5 = 15`,
          });
          console.log('[MSG] répondu: menu');
          continue;
        }
        if (lower === 'ping') {
          await sock.sendMessage(from, { text: 'Pong ✅' });
          console.log('[MSG] répondu: ping');
          continue;
        }
        if (lower === 'info') {
          await sock.sendMessage(from, {
            text: `*${BOT_NAME}*\nGemini: ${model ? 'OK' : 'NON'}\nRender + Baileys`,
          });
          console.log('[MSG] répondu: info');
          continue;
        }

        console.log('[MSG] appel Gemini...');
        await sock.sendPresenceUpdate('composing', from).catch(() => {});
        const reply = await askAI(text);
        await sock.sendMessage(from, { text: reply });
        console.log('[MSG] réponse envoyée (', reply.slice(0, 60), '...)');
      } catch (err) {
        console.error('[ERR] handler:', err.message || err);
      }
    }
  });
}

startBot().catch((e) => {
  console.error('[ERR] start:', e);
  setTimeout(startBot, 5000);
});
