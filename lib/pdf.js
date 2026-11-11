let pdfmeRuntime;

async function loadPdfme() {
  if (!pdfmeRuntime) {
    const [{ generate }, common, schemas] = await Promise.all([
      import('@pdfme/generator'),
      import('@pdfme/common'),
      import('@pdfme/schemas'),
    ]);
    pdfmeRuntime = {
      generate,
      BLANK_PDF: common.BLANK_PDF,
      text: schemas.text,
    };
  }
  return pdfmeRuntime;
}

function textSchema(name, x, y, width, height, fontSize) {
  return {
    name,
    type: 'text',
    content: '',
    position: { x, y },
    width,
    height,
    fontSize,
    lineHeight: 1.2,
    alignment: 'left',
    verticalAlignment: 'top',
    characterSpacing: 0,
    fontColor: '#222222',
  };
}

/**
 * Génère une fiche PDF avec PDFme.
 * L'API reste compatible avec l'ancien textToPdf utilisé par le worker WhatsApp.
 * @returns {Promise<Buffer>}
 */
async function textToPdf(title, body) {
  const { generate, BLANK_PDF, text } = await loadPdfme();
  const safeTitle = String(title || 'NCAM AI').slice(0, 160);
  const safeBody = String(body || '').slice(0, 12000);
  const template = {
    basePdf: BLANK_PDF,
    schemas: [[
      textSchema('title', 20, 20, 170, 16, 20),
      textSchema('subtitle', 20, 40, 170, 12, 9),
      textSchema('body', 20, 58, 170, 220, 11),
      textSchema('footer', 20, 285, 170, 10, 8),
    ]],
  };
  const pdf = await generate({
    template,
    inputs: [{
      title: safeTitle,
      subtitle: 'NCAM AI · Document généré depuis WhatsApp',
      body: safeBody,
      footer: 'Document généré automatiquement — vérifiez les informations importantes.',
    }],
    plugins: { text },
  });
  return Buffer.from(pdf);
}

module.exports = { textToPdf };
