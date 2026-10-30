function parseAdminNumbers(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(
    entries
      .map((entry) => String(entry).replace(/\D/g, ''))
      .filter((number) => /^\d{8,15}$/.test(number)),
  )];
}

function canPublishToChannel(role, linkedNumber, adminNumbers) {
  const normalizedRole = String(role || '').trim().toUpperCase();
  if (normalizedRole === 'ADMIN' || normalizedRole === 'OWNER') return true;
  if (normalizedRole) return false;
  const normalizedLinkedNumber = String(linkedNumber || '').replace(/\D/g, '');
  return parseAdminNumbers(adminNumbers).includes(normalizedLinkedNumber);
}

function phoneFromSenderJid(value) {
  const jid = String(value || '').trim();
  if (!jid || /@lid$/i.test(jid)) return '';
  if (/@(?:s\.whatsapp\.net|c\.us)$/i.test(jid)) {
    const phone = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
    return /^\d{8,15}$/.test(phone) ? phone : '';
  }
  if (jid.includes('@')) return '';
  const phone = jid.replace(/\D/g, '');
  return /^\d{8,15}$/.test(phone) ? phone : '';
}

function isAdminSender(senderIds, adminNumbers) {
  const allowed = parseAdminNumbers(adminNumbers);
  const candidates = Array.isArray(senderIds) ? senderIds : [senderIds];
  return candidates.some((candidate) => allowed.includes(phoneFromSenderJid(candidate)));
}

module.exports = { canPublishToChannel, isAdminSender, parseAdminNumbers };
