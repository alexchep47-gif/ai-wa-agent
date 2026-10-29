require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
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
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: SYSTEM_PROMPT,
  });
  console.log('Gemini: OK');
} else {
  console.log('ATTENTION: GEMINI_API_KEY manquante');
}

async function askAI(userMessage) {
  if (!model) return '⚠️ Clé Gemini manquante. Ajoute GEMINI_API_KEY sur Render.';
  try {
    const result = await model.generateContent(userMessage);
    return result.response.text();
  } catch (e) {
    console.error('Gemini error:', e.message);
    return '❌ Erreur IA. Vérifie ta clé Gemini.';
  }
}

const app = express();
app.get('/', (req, res) => res.send(`${BOT_NAME} is running ✅`));
app.get('/health', (req, res) => res.json({ status: 'ok', bot: BOT_NAME }));
app.listen(PORT, () => console.log(`HTTP server on port ${PORT}`));

let pairingRequested = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log('Baileys version:', version.join('.'));
  console.log('OWNER_NUMBER (digits only):', OWNER || '(vide — pairing impossible)');

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
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Afficher le QR en texte si présent (backup)
    if (qr) {
      console.log('\n--- QR CODE (si pairing échoue, scanne avec un autre appareil) ---');
      console.log(qr);
      console.log('---------------------------------------------------------------\n');
    }

    // Demander le pairing code dès que possible
    if (!sock.authState.creds.registered && OWNER && !pairingRequested) {
      pairingRequested = true;
      setTimeout(async () => {
        try {
          console.log(`Demande de pairing code pour le numéro: ${OWNER}`);
          const code = await sock.requestPairingCode(OWNER);
          // Format lisible: ABCD-EFGH
          const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
          console.log('\n========================================');
          console.log(`  CODE DE PAIRING : ${pretty}`);
          console.log('========================================');
          console.log('Sur iPhone: WhatsApp > Réglages > Appareils connectés');
          console.log('> Connecter un appareil > Lier avec un numéro de téléphone');
          console.log('Entre ce code (il expire en ~1 minute).\n');
        } catch (e) {
          pairingRequested = false;
          console.error('Erreur pairing code:', e.message);
          console.log('Vérifie OWNER_NUMBER (ex: 2376XXXXXXXX sans +).');
        }
      }, 4000);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('Connexion fermée. Code:', code, '| Reconnexion:', shouldReconnect);
      pairingRequested = false;
      if (shouldReconnect) setTimeout(startBot, 4000);
      else {
        console.log('Déconnecté (logged out). Supprime auth_info et redéploie pour re-pairer.');
      }
    } else if (connection === 'open') {
      console.log(`\n✅ ${BOT_NAME} connecté à WhatsApp !\n`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    if (from.endsWith('@g.us')) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    if (!text || !text.trim()) return;
    const body = text.trim();
    const lower = body.toLowerCase();

    try {
      if (lower === 'menu' || lower === 'aide' || lower === 'help') {
        await sock.sendMessage(from, {
          text: `*${BOT_NAME}* 🤖\n\nÉcris-moi n'importe quoi, je te réponds.\n\nExemples :\n• Explique la photosynthèse\n• Résous 2x + 5 = 15`,
        });
        return;
      }
      if (lower === 'ping') {
        await sock.sendMessage(from, { text: 'Pong ✅' });
        return;
      }
      if (lower === 'info') {
        await sock.sendMessage(from, {
          text: `*${BOT_NAME}*\nAgent IA éducatif\nGemini + Baileys\nRender`,
        });
        return;
      }

      await sock.sendPresenceUpdate('composing', from);
      const reply = await askAI(body);
      await sock.sendMessage(from, { text: reply });
    } catch (err) {
      console.error('Message error:', err.message);
    }
  });
}

startBot().catch((e) => {
  console.error('Start error:', e);
  setTimeout(startBot, 5000);
});
