const fs = require('fs');
const path = require('path');

const PREFIX = 'wa1.';

function listStateFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^[\w.-]+$/.test(name));
}

function importSessionId(sessionId, dir) {
  if (!sessionId || listStateFiles(dir).length) return false;
  const raw = String(sessionId).startsWith(PREFIX) ? String(sessionId).slice(PREFIX.length) : String(sessionId);
  const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  if (payload?.version !== 1 || !payload.files || typeof payload.files !== 'object') throw new Error('SESSION_ID invalide');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, encoded] of Object.entries(payload.files)) {
    if (!/^[\w.-]+$/.test(name) || typeof encoded !== 'string') throw new Error('SESSION_ID corrompu');
    fs.writeFileSync(path.join(dir, name), Buffer.from(encoded, 'base64'), { mode: 0o600 });
  }
  return true;
}

function exportSessionId(dir) {
  const files = {};
  for (const name of listStateFiles(dir)) files[name] = fs.readFileSync(path.join(dir, name)).toString('base64');
  if (!Object.keys(files).length) throw new Error('Aucune session Baileys disponible');
  return PREFIX + Buffer.from(JSON.stringify({ version: 1, files })).toString('base64url');
}

module.exports = { importSessionId, exportSessionId };
