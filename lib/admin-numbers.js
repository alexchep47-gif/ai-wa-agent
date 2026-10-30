function parseAdminNumbers(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(
    entries
      .map((entry) => String(entry).replace(/\D/g, ''))
      .filter((number) => /^\d{8,15}$/.test(number)),
  )];
}

module.exports = { parseAdminNumbers };
