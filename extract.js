'use strict';
/*
 * Auslesen von Zetteln – läuft komplett auf dem Handy, nichts wird hochgeladen.
 * - PDFs mit Text: pdf.js liest den Text mit Position.
 * - Fotos und eingescannte PDFs: Texterkennung mit Tesseract (deutsch).
 */
(function () {
  const abs = p => new URL(p, location.href).href;

  /* ---------- pdf.js ---------- */
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('./vendor/pdf.min.mjs').then(pdfjs => {
        pdfjs.GlobalWorkerOptions.workerSrc = abs('vendor/pdf.worker.min.mjs');
        return pdfjs;
      });
    }
    return pdfjsPromise;
  }

  async function openPdf(blob) {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await blob.arrayBuffer());
    return pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  }

  async function pdfTextItems(blob) {
    const doc = await openPdf(blob);
    try {
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      return tc.items
        .filter(i => i.str && i.str.trim())
        .map(i => ({ x: i.transform[4], y: vp.height - i.transform[5], str: i.str }));
    } finally {
      doc.destroy();
    }
  }

  // Textstücke zu Zeilen zusammensetzen (für Auswertung per Text)
  function itemsToText(items) {
    const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(it.y - last.y) <= 3) last.parts.push(it);
      else lines.push({ y: it.y, parts: [it] });
    }
    return lines.map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.str.trim()).join('   ')).join('\n');
  }

  async function pdfPageToCanvas(blob) {
    const doc = await openPdf(blob);
    try {
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 3 });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      return c;
    } finally {
      doc.destroy();
    }
  }

  /* ---------- Tesseract ---------- */
  let tessPromise = null;
  function loadTesseract() {
    if (!tessPromise) {
      tessPromise = new Promise((resolve, reject) => {
        if (self.Tesseract) return resolve(self.Tesseract);
        const s = document.createElement('script');
        s.src = 'vendor/tesseract/tesseract.min.js';
        s.onload = () => resolve(self.Tesseract);
        s.onerror = () => { tessPromise = null; reject(new Error('Texterkennung konnte nicht geladen werden. Bitte einmal mit Internet öffnen.')); };
        document.head.appendChild(s);
      });
    }
    return tessPromise;
  }

  // Bild für die Texterkennung vorbereiten (Größe begrenzen, Filter anwenden)
  async function toBitmap(src) {
    if (!(src instanceof Blob)) return src;
    try { return await createImageBitmap(src, { imageOrientation: 'from-image' }); }
    catch (e) { return createImageBitmap(src); }
  }

  function prepareImage(bmp, max, filter) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    if (filter && filter !== 'none') ctx.filter = filter;
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }

  // Mehrere Durchläufe mit unterschiedlicher Aufbereitung: Fotos werden je nach Licht verschieden gut erkannt.
  const PASSES = [
    { max: 5200, filter: 'none' },
    { max: 3400, filter: 'grayscale(1) contrast(1.25)' },
    { max: 2600, filter: 'grayscale(1)' },
  ];

  async function createOcrWorker(onPct) {
    const T = await loadTesseract();
    const worker = await T.createWorker('deu', 1, {
      workerPath: abs('vendor/tesseract/worker.min.js'),
      corePath: abs('vendor/tesseract/'),
      langPath: abs('vendor/tesseract/lang'),
      gzip: true,
      logger: m => { if (onPct && m.status === 'recognizing text') onPct(m.progress); },
    });
    await worker.setParameters({ preserve_interword_spaces: '1' });
    return worker;
  }

  async function ocrLohnzettel(src, onProgress) {
    const bmp = await toBitmap(src);
    let passIdx = 0;
    const total = PASSES.length;
    const report = p => onProgress && onProgress(Math.min(99, Math.round(((passIdx + p) / total) * 100)));
    const worker = await createOcrWorker(report);
    const results = [];
    try {
      for (passIdx = 0; passIdx < PASSES.length; passIdx++) {
        const { max, filter } = PASSES[passIdx];
        const { data } = await worker.recognize(prepareImage(bmp, max, filter));
        const r = self.LohnParser.parseLohnzettel(data.text);
        r.rohtext = data.text;
        results.push(r);
        if (results.length >= 2) {
          const merged = self.LohnParser.zusammenfuehren(results);
          const unsicher = ['stundenlohn', 'bezahltStd', 'azkStand', 'urlaubRest'].some(f => !merged['_' + f + 'Sicher']);
          if (!merged.warnungen.length && !unsicher) break;
        }
      }
    } finally {
      await worker.terminate();
    }
    const merged = self.LohnParser.zusammenfuehren(results);
    merged.rohtext = results[0].rohtext;
    merged.durchlaeufe = results.length;
    return merged;
  }

  /* ---------- Öffentliche Funktionen ---------- */
  async function readWochenzettel(blob) {
    const items = await pdfTextItems(blob);
    if (items.length < 20) {
      throw new Error('Im PDF steht kein lesbarer Text (eingescannt?). Bitte die Werte von Hand prüfen.');
    }
    return self.WochenParser.parseWochenzettel(items);
  }

  async function readLohnzettel(blob, onProgress) {
    const isPdf = blob.type === 'application/pdf' || /\.pdf$/i.test(blob.name || '');
    if (isPdf) {
      const items = await pdfTextItems(blob);
      if (items.length >= 20) {
        const text = itemsToText(items);
        const r = self.LohnParser.parseLohnzettel(text);
        r.quelle = 'pdf-text';
        r.rohtext = text;
        return r;
      }
      const r = await ocrLohnzettel(await pdfPageToCanvas(blob), onProgress);
      r.quelle = 'pdf-scan';
      return r;
    }
    const r = await ocrLohnzettel(blob, onProgress);
    r.quelle = 'foto';
    return r;
  }

  self.Extract = { pdfTextItems, readWochenzettel, readLohnzettel };
})();
