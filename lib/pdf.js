const PDFDocument = require('pdfkit');

/**
 * Génère un PDF simple (fiche de révision) à partir d'un texte.
 * @returns {Promise<Buffer>}
 */
function textToPdf(title, body) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(16).fillColor('#0B3D91').text(title || 'CMR SCHOOL', { align: 'left' });
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor('#666').text('cmr-school.online · Fiche de révision');
      doc.moveDown(0.8);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#0B3D91').stroke();
      doc.moveDown(0.8);
      doc.fontSize(11).fillColor('#222').text(body || '', {
        align: 'left',
        lineGap: 4,
      });
      doc.moveDown(1.5);
      doc.fontSize(8).fillColor('#999').text('Généré par CMR SCHOOL Agent — à but éducatif');
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { textToPdf };
