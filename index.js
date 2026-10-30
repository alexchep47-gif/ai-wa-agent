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

// Numéro qui reçoit les alertes de dépôt et donne la permission
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '237698877771').replace(/\D/g, '');
const ADMIN_JID = ADMIN_NUMBER + '@s.whatsapp.net';

const GEMINI_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
].filter(Boolean);

// === Prompt : UNIQUEMENT connaissances site CMR SCHOOL ===
const DEFAULT_SYSTEM_PROMPT = `Tu es l'agent officiel de CMR SCHOOL (https://cmr-school.online).
Tu réponds uniquement à propos de CMR SCHOOL, ses offres, tarifs, inscription, paiement et fonctionnement.
Style : français ou anglais selon le message, court, clair, adapté à WhatsApp. Tu es professionnel et encourageant.

=== CONNAISSANCES AUTORISÉES (ne sors pas de ce cadre) ===
Site : https://cmr-school.online
Slogan : Comprendre. Progresser. Réussir. / Comprendre aujourd'hui. Réussir demain.
Public : élèves Seconde, Première, Terminale (Cameroun) — Maths, Physique, Chimie.
Canaux : Web, WhatsApp, Telegram.

Offres :
1) CMR Fiches — supports structurés chapitre par chapitre, livraison WhatsApp ou Telegram. Paiement PayPal sécurisé sur le site. Pour MTN MoMo / Orange Money : contacter WhatsApp avant tout versement.
2) CMR Répétitions — 3 séances/semaine · 2 h 30, Maths/Physique/Chimie, jusqu'à 4 séances avant examens. Tarifs indicatifs : ~20 000 FCFA/mois (2nde), ~30 000 (1ère), ~40 000 (Tle). Le conseiller confirme le montant exact.
3) CMR Pack — fiches + répétitions, suivi parent possible, prix négociable dès 3 enfants.

Contact inscription / Mobile Money : WhatsApp +237 677 152 300.
Méthode : identifier le besoin → bon support → ancrer les progrès.

=== RÈGLES ===
- Si la question n'a AUCUN lien avec CMR SCHOOL / le site / l'inscription / le paiement : dis poliment que tu es l'assistant CMR SCHOOL et propose de parler des offres ou du site.
- Tu n'inventes pas d'autres tarifs, numéros ou services hors de cette fiche.
- Tu ne confirmes JAMAIS qu'un paiement est validé tant que l'administrateur ne t'a pas donné la permission (géré automatiquement par le système).
- Pour les questions pédagogiques générales hors CMR SCHOOL, oriente vers les répétitions / fiches CMR SCHOOL.`;

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

// Dépôts en attente de validation admin : clientPhone -> { jid, at }
const pendingDeposits = new Map();

function detectLang(text) {
  const t = (text || '').toLowerCase();
  const en = /\b(the|what|how|why|please|help|hello|hi|payment|deposit)\b/;
  const fr = /\b(le|la|les|des|une|est|pour|avec|comment|bonjour|salut|dépôt|depot|paiement|payé)\b/;
  if (en.test(t) && !fr.test(t)) return 'en';
  if (fr.test(t)) return 'fr';
  return null;
}

/** Le client affirme avoir payé / déposé */
function isDepositClaim(text) {
  const t = (text || '').toLowerCase();
  return /(
    d[eé]pos[eé]|j'?ai (pay[eé]|vers[eé]|envoy[eé])|
    paiement (effectu[eé]|fait|ok|reussi|r[eé]ussi)|
    (momo|orange money|om|mtn).{0,20}(envoy|pay|d[eé]pos)|
    (envoy|pay|d[eé]pos).{0,20}(momo|orange|om|mtn)|
    j'?ai effectu[eé].{0,30}(d[eé]p[oô]t|paiement|transfert)|
    souscription (pay[eé]e|effectu[eé]e)|
    i (paid|sent|transferred|deposited)|
    payment (done|sent|completed)
  )/i.test(t);
}

/** Message admin : validation ou refus */
function parseAdminDecision(text) {
  const t = (text || '').trim().toLowerCase();
  // Formats : "ok 2376..." | "valider 2376..." | "oui 2376..." | "non 2376..." | "refuser 2376..."
  const m = t.match(/\b(ok|oui|valider?|confirm(?:e|er)?|yes|approve)\s*[:\-]?\s*(\d{8,15})\b/i);
  if (m) return { decision: 'approve', phone: m[2].replace(/\D/g, '') };
  const r = t.match(/\b(non|refuser?|reject|no)\s*[:\-]?\s*(\d{8,15})\b/i);
  if (r) return { decision: 'reject', phone: r[2].replace(/\D/g, '') };
  // "ok" seul si un seul pending
  if (/^(ok|oui|valider?|yes)$/i.test(t) && pendingDeposits.size === 1) {
    const phone = pendingDeposits.keys().next().value;
    return { decision: 'approve', phone };
  }
  if (/^(non|refuser?|no)$/i.test(t) && pendingDeposits.size === 1) {
    const phone = pendingDeposits.keys().next().value;
    return { decision: 'reject', phone };
  }
  return null;
}

function jidToPhone(jid) {
  if (!jid) return '';
  // @s.whatsapp.net
  const m = String(jid).match(/^(\d+)@/);
  if (m) return m[1];
  // @lid — on ne peut pas déduire le PN ; on garde un id lisible
  if (String(jid).includes('@lid')) return 'LID:' + String(jid).split('@')[0];
  return String(jid).replace(/\D/g, '') || jid;
}

function phoneToJid(phone) {
  return String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
}

function isAdminJid(jid) {
  if (!jid) return false;
  const p = jidToPhone(jid);
  return p === ADMIN_NUMBER || jid === ADMIN_JID;
}

let genAI = null;
let activeModelName = null;
if (GEMINI_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_KEY);
  activeModelName = GEMINI_MODELS[0];
  console.log('[OK] Gemini —', GEMINI_MODELS.join(' → '));
} else console.log('[WARN] GEMINI_API_KEY absente');

console.log('[OK] ADMIN alertes dépôt:', ADMIN_NUMBER);

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
      ? 'Reply in English. Short WhatsApp style. Stay strictly on CMR SCHOOL topics.\n\n'
      : 'Réponds en français. Style WhatsApp court. Reste strictement sur CMR SCHOOL.\n\n';
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
  return null;
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}
function isBroadcast(jid) {
  return !jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

function wantsPdf(text) {
  const t = (text || '').toLowerCase();
  return /\b(pdf|fiche|fichier|document)\b/.test(t);
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

/** Notifie l'admin qu'un client affirme avoir déposé */
async function notifyAdminDeposit(clientPhone, clientJid) {
  const displayPhone = String(clientPhone).startsWith('237')
    ? clientPhone
    : clientPhone;

  const adminMsg =
    `Le client de numéro ${displayPhone} affirme avoir effectué un dépôt d'argent sur l'un de vos numéros de téléphone, veuillez vérifier et me donner la permission de lui confirmer le succès de sa souscription.\n\n` +
    `Pour valider : ok ${displayPhone}\n` +
    `Pour refuser : non ${displayPhone}`;

  pendingDeposits.set(String(clientPhone).replace(/\D/g, '') || clientPhone, {
    jid: clientJid,
    at: Date.now(),
  });

  await sock.sendMessage(ADMIN_JID, { text: adminMsg });
  console.log('[DEPOT] Alerte envoyée à', ADMIN_NUMBER, 'pour client', displayPhone);
}

const app = express();
app.get('/', (req, res) => {
  res.type('html').send(`
    <h2>${BOT_NAME}</h2>
    <p>WhatsApp: <b>${waReady ? 'CONNECTÉ' : 'hors ligne'}</b></p>
    <p>Admin dépôts: <b>${ADMIN_NUMBER}</b></p>
    <p>Pending: ${pendingDeposits.size}</p>
  `);
});
app.get('/health', (req, res) =>
  res.json({
    status: 'ok',
    whatsapp: waReady,
    admin: ADMIN_NUMBER,
    pendingDeposits: pendingDeposits.size,
  })
);
app.listen(PORT, () => console.log('[OK] HTTP port', PORT));

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log('[OK] Baileys', version.join('.'), '| OWNER=', OWNER || '(vide)', '| ADMIN=', ADMIN_NUMBER);

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
      }, 5000);
    }

    if (connection === 'close') {
      waReady = false;
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === 515) {
        pairingRequested = false;
        scheduleReconnect(2500, '515');
        return;
      }
      if (status === DisconnectReason.loggedOut || status === 401) {
        console.log('[ERR] loggedOut');
        pairingRequested = false;
        return;
      }
      pairingRequested = false;
      scheduleReconnect(4000, 'close');
    } else if (connection === 'open') {
      waReady = true;
      console.log(`[OK] ${BOT_NAME} CONNECTÉ | alertes dépôt → ${ADMIN_NUMBER}`);
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
        let lang = langByJid.get(jid) || detectLang(text) || 'fr';
        if (detectLang(text)) langByJid.set(jid, detectLang(text));

        const lower = (text || '').toLowerCase();

        // ---------- ADMIN : validation / refus dépôt ----------
        if (isAdminJid(jid) && text) {
          const decision = parseAdminDecision(text);
          if (decision) {
            const key = decision.phone;
            const pending = pendingDeposits.get(key);
            // Aussi chercher si le numéro est stocké avec/sans 237
            let entry = pending;
            let foundKey = key;
            if (!entry) {
              for (const [k, v] of pendingDeposits) {
                if (k.endsWith(key) || key.endsWith(k)) {
                  entry = v;
                  foundKey = k;
                  break;
                }
              }
            }

            if (!entry) {
              await sock.sendMessage(jid, {
                text: `Aucun dépôt en attente pour ${key}.\nEn attente: ${[...pendingDeposits.keys()].join(', ') || 'aucun'}`,
              });
              continue;
            }

            if (decision.decision === 'approve') {
              await sock.sendMessage(entry.jid, {
                text:
                  lang === 'en' || false
                    ? '✅ Your payment has been confirmed. Welcome to CMR SCHOOL! We will contact you for the next steps.\nhttps://cmr-school.online'
                    : '✅ Votre paiement a été confirmé. Bienvenue chez CMR SCHOOL ! Nous vous recontactons pour la suite.\nhttps://cmr-school.online',
              });
              await sock.sendMessage(jid, {
                text: `✅ Client ${foundKey} : souscription confirmée.`,
              });
              pendingDeposits.delete(foundKey);
              console.log('[DEPOT] VALIDÉ', foundKey);
            } else {
              await sock.sendMessage(entry.jid, {
                text:
                  '❌ Nous n\'avons pas encore retrouvé votre dépôt. Merci de vérifier le numéro / montant ou d\'envoyer la capture du transfert, puis réécrivez-nous.',
              });
              await sock.sendMessage(jid, {
                text: `❌ Client ${foundKey} : dépôt non confirmé (refusé).`,
              });
              pendingDeposits.delete(foundKey);
              console.log('[DEPOT] REFUSÉ', foundKey);
            }
            continue;
          }
          // Admin peut aussi poser des questions normales → tombe dans le flux IA
        }

        // ---------- CLIENT : affirmation de dépôt ----------
        if (text && isDepositClaim(text) && !isAdminJid(jid)) {
          const clientPhone = jidToPhone(jid);
          try {
            await notifyAdminDeposit(clientPhone, jid);
            await sock.sendMessage(jid, {
              text:
                lang === 'en'
                  ? 'Thank you. We have notified the team to verify your payment. You will receive a confirmation shortly.'
                  : 'Merci. Nous avons informé l\'équipe pour vérifier votre dépôt. Vous recevrez une confirmation sous peu.',
            });
          } catch (e) {
            console.error('[ERR] notify admin', e.message);
            await sock.sendMessage(jid, {
              text:
                'Votre message est bien reçu. Un conseiller va vérifier le paiement manuellement. Contact : +237 677 152 300',
            });
          }
          continue;
        }

        if (lower === 'ping') {
          await sock.sendMessage(jid, { text: 'Pong ✅' });
          continue;
        }
        if (lower === 'menu' || lower === 'aide' || lower === 'help') {
          await sock.sendMessage(jid, {
            text: `*${BOT_NAME}* — https://cmr-school.online\n\nJe réponds sur :\n• Offres (Fiches, Répétitions, Pack)\n• Tarifs & inscription\n• Paiement / Mobile Money\n\nSi vous avez déjà payé, écrivez par ex. : "J'ai effectué un dépôt".`,
          });
          continue;
        }

        await sock.sendPresenceUpdate('composing', jid).catch(() => {});

        // Médias : on reste dans le cadre site (légende = question sur CMR)
        if (getMediaType(msg) === 'image') {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger,
            reuploadRequest: sock.updateMediaMessage,
          });
          // Si la légende ressemble à un dépôt (capture MoMo), traiter comme dépôt
          if (isDepositClaim(text) || /momo|orange|reçu|recu|transfert|deposit|payment/i.test(text || '')) {
            const clientPhone = jidToPhone(jid);
            await notifyAdminDeposit(clientPhone, jid);
            await sock.sendMessage(jid, {
              text:
                'Merci pour la capture. L\'équipe vérifie votre dépôt et vous confirmera sous peu.',
            });
            continue;
          }
          const reply = await askAI(
            `L'utilisateur a envoyé une image avec légende: "${text || '(aucune)'}". Réponds uniquement dans le cadre CMR SCHOOL / inscription / paiement.`,
            lang
          );
          await sock.sendMessage(jid, { text: reply });
          continue;
        }

        if (!text) continue;

        const prompt = wantsPdf(text)
          ? text + '\n\nRédige une fiche claire sur ce sujet lié à CMR SCHOOL si pertinent, sinon présente les offres.'
          : text;

        const reply = await askAI(prompt, lang);

        if (wantsPdf(text) && reply.length > 60) {
          try {
            const pdfBuf = await textToPdf(text.slice(0, 50), reply);
            await sock.sendMessage(jid, {
              document: pdfBuf,
              mimetype: 'application/pdf',
              fileName: `cmr-school-${Date.now()}.pdf`,
              caption: 'Document CMR SCHOOL',
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
