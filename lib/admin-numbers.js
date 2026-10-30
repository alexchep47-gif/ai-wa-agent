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

module.exports = { canPublishToChannel, parseAdminNumbers };
