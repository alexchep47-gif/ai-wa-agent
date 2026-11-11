const test = require('node:test');
const assert = require('node:assert/strict');
const { textToPdf } = require('../lib/pdf');

test('génère une fiche PDFme compatible avec l’envoi WhatsApp', async () => {
  const pdf = await textToPdf('NCAM AI', 'Contenu de test pour le document WhatsApp.');
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 500);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
});
