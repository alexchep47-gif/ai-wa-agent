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
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const REPLY_IN_GROUPS = (process.env.REPLY_IN_GROUPS || 'false').toLowerCase() === 'true';

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Tu es ${BOT_NAME}, un assistant éducatif camerounais amical et concis.
Réponds en français, messages courts, adaptés à WhatsApp.`;

const logger = pino({ level: 'silent' });
const AUTH_DIR = path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Store minimal pour getMessage (nécessaire pour l'envoi fiable)
const msgStore = new Map();
function storeMsg(msg) {
  if (msg?.key?.id) {
    msgStore.set(msg.key.id, msg);
    if (msgStore.size > 200) {
      const first = msgStore.keys().next().value;
      msgStore.delete(first);
    }
  }
}

let model = null;
if (GEMINI_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_PROMPT,
    });
    console.log('[OK] Gemini prêt');
  } catch (e) {
    console.error('[ERR] Gemini:', e.message);
  }
} else {
  console.log('[WARN] GEMINI_API_KEY absente');
}

async function askAI(userMessage) {
  if (!model) return '⚠️ GEMINI_API_KEY manquante ou invalide sur Render.';
  try {
    const result = await model.generateContent(userMessage);
    return result.response.text() || 'OK';
  } catch (e) {
    console.error('[ERR] Gemini call:', e.message);
    try {
      const genAI = new GoogleGenerativeAI(GEMINI_KEY);
      const fb = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: SYSTEM_PROMPT,
      });
      const r = await fb.generateContent(userMessage);
      return r.response.text() || 'OK';
    } catch (e2) {
      return '❌ Erreur IA: ' + String(e.message || e2.message).slice(0, 150);
    }
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
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function isBroadcast(jid) {
  return (
    !jid ||
    jid === 'status@broadcast' ||
    jid.endsWith('@broadcast') ||
    jid.endsWith('@newsletter')
  );
}

// Socket global pour /test-send
let sock = null;
let waReady = false;
let pairingRequested = false;
let lastIncomingJid = null;

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
  res.json({
    status: 'ok',
    whatsapp: waReady,
    gemini: !!model,
    owner: OWNER || null,
    lastIncomingJid,
  });
});

// Force l'envoi d'un message (pour tester)
// Exemple: /test-send?text=Bonjour
// Ou: /test-send?to=2376XXXXXXXX&text=Bonjour
app.get('/test-send', async (req, res) => {
  try {
    if (!sock || !waReady) {
      return res.status(503).json({ ok: false, error: 'WhatsApp pas encore connecté' });
    }
    const text = (req.query.text || `Test ${BOT_NAME} ✅`).toString();
    let jid = (req.query.to || '').toString().replace(/\D/g, '');
    if (jid) jid = jid + '@s.whatsapp.net';
    else if (lastIncomingJid) jid = lastIncomingJid;
    else if (OWNER) jid = OWNER + '@s.whatsapp.net';
    else {
      return res.status(400).json({
        ok: false,
        error: 'Indique ?to=2376XXXXXXXX ou attends un message entrant',
      });
    }
    console.log('[TEST] Envoi vers', jid, ':', text);
    await sock.sendMessage(jid, { text });
    res.json({ ok: true, to: jid, text });
  } catch (e) {
    console.error('[TEST] ERR', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log('[OK] HTTP port', PORT));

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log('[OK] Baileys', version.join('.'), '| OWNER=', OWNER || '(vide)');

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
      const reconnect = status !== DisconnectReason.loggedOut;
      console.log('[WARN] close status=', status, 'reconnect=', reconnect);
      pairingRequested = false;
      if (reconnect) setTimeout(startBot, 4000);
    } else if (connection === 'open') {
      waReady = true;
      console.log(`[OK] ${BOT_NAME} CONNECTÉ — en attente de messages`);
      console.log('[TIP] Test envoi: ouvre https://TON-SERVICE.onrender.com/test-send?text=hello');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log('[MSG] event type=', type, 'n=', messages?.length || 0);

    for (const msg of messages || []) {
      try {
        storeMsg(msg);

        if (!msg.message) {
          console.log('[MSG] skip no content', msg.key?.remoteJid);
          continue;
        }
        if (msg.key.fromMe) {
          console.log('[MSG] skip fromMe');
          continue;
        }

        // JID d'envoi: garder le remoteJid tel quel (@lid ou @s.whatsapp.net)
        const jid = msg.key.remoteJid;
        if (isBroadcast(jid)) continue;

        if (isGroupJid(jid) && !REPLY_IN_GROUPS) {
          console.log('[MSG] skip group', jid);
          continue;
        }

        const text = extractText(msg).trim();
        console.log('[MSG] jid=', jid, '| text=', JSON.stringify(text.slice(0, 100)));

        if (!text) continue;

        lastIncomingJid = jid;
        const lower = text.toLowerCase();

        let reply;
        if (lower === 'ping') reply = 'Pong ✅';
        else if (lower === 'menu' || lower === 'aide' || lower === 'help') {
          reply = `*${BOT_NAME}*\nÉcris n'importe quoi, je réponds sans préfixe.`;
        } else if (lower === 'info') {
          reply = `*${BOT_NAME}*\nGemini: ${model ? 'OK' : 'NON'}\nWhatsApp: connecté`;
        } else {
          console.log('[MSG] Gemini...');
          await sock.sendPresenceUpdate('composing', jid).catch(() => {});
          reply = await askAI(text);
        }

        await sock.sendMessage(jid, { text: reply });
        console.log('[MSG] ENVOYÉ OK ->', jid);
      } catch (err) {
        console.error('[ERR] handler', err?.message || err);
      }
    }
  });
}

startBot().catch((e) => {
  console.error('[ERR] start', e);
  setTimeout(startBot, 5000);
});
