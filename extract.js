'use strict';
/* Liest Text mit Position aus der ersten PDF-Seite (pdf.js, läuft komplett auf dem Handy). */
(function () {
  let pdfjsPromise = null;

  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('./vendor/pdf.min.mjs').then(pdfjs => {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
        return pdfjs;
      });
    }
    return pdfjsPromise;
  }

  async function pdfTextItems(blob) {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await blob.arrayBuffer());
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(i => i.str && i.str.trim())
      .map(i => ({ x: i.transform[4], y: vp.height - i.transform[5], str: i.str }));
    doc.destroy();
    return items;
  }

  async function readWochenzettel(blob) {
    const items = await pdfTextItems(blob);
    if (items.length < 20) {
      throw new Error('Im PDF steht kein lesbarer Text (eingescannt?). Fotos und Scans werden in einem späteren Schritt unterstützt.');
    }
    return self.WochenParser.parseWochenzettel(items);
  }

  self.Extract = { pdfTextItems, readWochenzettel };
})();
