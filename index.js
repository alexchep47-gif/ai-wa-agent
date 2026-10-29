require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PREFIX = process.env.PREFIX || '.';
const BOT_NAME = process.env.BOT_NAME || 'CMR AI Agent';
const OWNER = process.env.OWNER_NUMBER || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

const logger = pino({ level: 'silent' });
const AUTH_DIR = path.join(__dirname, 'auth_info');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// === Gemini ===
let model = null;
if (GEMINI_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
}

async function askAI(prompt) {
  if (!model) return '⚠️ Clé Gemini manquante. Ajoute GEMINI_API_KEY dans les variables Render.';
  try {
    const result = await model.generateContent(
      `Tu es un assistant éducatif camerounais amical et concis. Réponds en français, de façon claire et utile (WhatsApp). Question: ${prompt}`
    );
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
    browser: ['CMR AI Agent', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scanne le QR ou utilise le pairing code ci-dessous.\n');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connexion fermée. Reconnexion:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 3000);
    } else if (connection === 'open') {
      console.log(`\n✅ ${BOT_NAME} connecté à WhatsApp !\n`);
    }
  });

  // Pairing code (plus simple sur téléphone)
  if (!sock.authState.creds.registered) {
    const phone = OWNER || process.env.PAIRING_NUMBER;
    if (phone) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone.replace(/\D/g, ''));
          console.log(`\n🔑 CODE DE PAIRING : ${code}\nEntre-le dans WhatsApp > Appareils connectés > Lier avec un numéro\n`);
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
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    if (!text) return;

    const body = text.trim();
    const isCmd = body.startsWith(PREFIX);
    const command = isCmd ? body.slice(PREFIX.length).split(' ')[0].toLowerCase() : '';
    const args = isCmd ? body.slice(PREFIX.length + command.length).trim() : body;

    try {
      // Commandes
      if (command === 'menu' || command === 'help') {
        await sock.sendMessage(from, {
          text: `*${BOT_NAME}* 🤖\n\nCommandes :\n• ${PREFIX}ai [question] — Pose une question à l'IA\n• ${PREFIX}menu — Ce menu\n• ${PREFIX}ping — Test\n• ${PREFIX}info — Infos\n\nTu peux aussi m'écrire directement sans commande.`,
        });
        return;
      }

      if (command === 'ping') {
        await sock.sendMessage(from, { text: 'Pong ✅' });
        return;
      }

      if (command === 'info') {
        await sock.sendMessage(from, {
          text: `*${BOT_NAME}*\nAgent IA éducatif\nPowered by Gemini + Baileys\nDéployé sur Render`,
        });
        return;
      }

      if (command === 'ai' || command === 'bot' || command === 'ask') {
        if (!args) {
          await sock.sendMessage(from, { text: `Exemple : ${PREFIX}ai Explique la photosynthèse` });
          return;
        }
        await sock.sendPresenceUpdate('composing', from);
        const reply = await askAI(args);
        await sock.sendMessage(from, { text: reply });
        return;
      }

      // Message normal (sans commande) → réponse IA (uniquement en privé pour éviter le spam de groupe)
      if (!isCmd && !isGroup && model) {
        await sock.sendPresenceUpdate('composing', from);
        const reply = await askAI(body);
        await sock.sendMessage(from, { text: reply });
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });
}

startBot().catch((e) => {
  console.error('Start error:', e);
  setTimeout(startBot, 5000);
});
