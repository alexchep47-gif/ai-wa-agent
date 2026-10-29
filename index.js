require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_NAME = process.env.BOT_NAME || 'CMR AI Agent';
const OWNER = process.env.OWNER_NUMBER || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// Prompt système : défini AVANT la première utilisation (variable Render)
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  `Tu es ${BOT_NAME}, un assistant éducatif camerounais amical, clair et concis.
Tu aides les élèves (Seconde, Première, Terminale) en Maths, Physique, Chimie et culture générale.
Réponds toujours en français, de façon utile et adaptée à WhatsApp (messages courts, paragraphes brefs).
Si on te pose une question hors éducation, réponds quand même poliment et brièvement.`;

const logger = pino({ level: 'silent' });
const AUTH_DIR = path.join(__dirname, 'auth_info');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// === Gemini ===
let model = null;
if (GEMINI_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: SYSTEM_PROMPT,
  });
}

async function askAI(userMessage) {
  if (!model) {
    return '⚠️ Clé Gemini manquante. Ajoute GEMINI_API_KEY dans les variables Render.';
  }
  try {
    const result = await model.generateContent(userMessage);
    return result.response.text();
  } catch (e) {
    console.error('Gemini error:', e.message);
    return '❌ Erreur IA. Vérifie ta clé Gemini ou réessaie plus tard.';
  }
}

// === Express keep-alive (important pour Render) ===
const app = express();
app.get('/', (req, res) => res.send(`${BOT_NAME} is running ✅`));
app.get('/health', (req, res) => res.json({ status: 'ok', bot: BOT_NAME }));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// === WhatsApp ===
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: [BOT_NAME, 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scanne le QR ou utilise le pairing code ci-dessous.\n');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connexion fermée. Reconnexion:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 3000);
    } else if (connection === 'open') {
      console.log(`\n✅ ${BOT_NAME} connecté à WhatsApp !`);
      console.log('Mode: réponse automatique sans préfixe (messages privés)\n');
    }
  });

  // Pairing code (plus simple sur téléphone)
  if (!sock.authState.creds.registered) {
    const phone = OWNER || process.env.PAIRING_NUMBER;
    if (phone) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone.replace(/\D/g, ''));
          console.log(
            `\n🔑 CODE DE PAIRING : ${code}\nEntre-le dans WhatsApp > Appareils connectés > Lier avec un numéro\n`
          );
        } catch (e) {
          console.log('Pairing code error:', e.message);
        }
      }, 3000);
    }
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');

    // On ignore les groupes par défaut (pour éviter le spam)
    // Tu pourras activer les groupes plus tard si besoin
    if (isGroup) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    if (!text || !text.trim()) return;

    const body = text.trim();

    // Commandes spéciales (optionnelles, sans préfixe obligatoire)
    const lower = body.toLowerCase();

    try {
      if (lower === 'menu' || lower === 'aide' || lower === 'help') {
        await sock.sendMessage(from, {
          text: `*${BOT_NAME}* 🤖\n\nÉcris-moi n'importe quoi, je te réponds directement.\n\nExemples :\n• Explique la photosynthèse\n• Résous 2x + 5 = 15\n• Donne-moi un quiz de chimie\n\nPas besoin de préfixe.`,
        });
        return;
      }

      if (lower === 'ping') {
        await sock.sendMessage(from, { text: 'Pong ✅' });
        return;
      }

      if (lower === 'info') {
        await sock.sendMessage(from, {
          text: `*${BOT_NAME}*\nAgent IA éducatif\nPowered by Gemini + Baileys\nDéployé sur Render\n\nPrompt système configuré ✅`,
        });
        return;
      }

      // === Réponse IA automatique (sans préfixe) ===
      await sock.sendPresenceUpdate('composing', from);
      const reply = await askAI(body);
      await sock.sendMessage(from, { text: reply });
    } catch (err) {
      console.error('Message error:', err);
    }
  });
}

startBot().catch((e) => {
  console.error('Start error:', e);
  setTimeout(startBot, 5000);
});
