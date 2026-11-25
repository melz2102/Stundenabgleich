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
    // Große Fotos verkleinern, kleine (z.B. per WhatsApp verschickte) bis 2,5-fach vergrößern – Tesseract liest größere Schrift besser
    const scale = Math.min(2.5, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
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

  // Die Spalte "Betrag" steht hinter einem senkrechten Strich und wird bei großen Fotos oft übersprungen.
  // Dann lesen wir nur diese Spalte neben den Lohnarten noch einmal und ordnen die Beträge zeilenweise zu.
  async function verpflegungNachlesen(worker, canvas, data) {
    const istLa = l => /^\W{0,3}\d{4}\s+[A-Za-zÄÖÜäöü]/.test(l.text.trim());
    const alle = (data.lines || []).filter(istLa).sort((a, b) => a.bbox.y0 - b.bbox.y0);
    const start = alle.findIndex(l => /verpfl/i.test(l.text));
    if (start < 0) return null;
    const rowH = alle.reduce((s, l) => s + l.bbox.y1 - l.bbox.y0, 0) / alle.length;
    // zusammenhängender Lohnarten-Block um die Verpflegungszeilen
    let a = start, b = start;
    while (a > 0 && alle[a].bbox.y0 - alle[a - 1].bbox.y0 < 2.5 * rowH) a--;
    while (b < alle.length - 1 && alle[b + 1].bbox.y0 - alle[b].bbox.y0 < 2.5 * rowH) b++;
    const block = alle.slice(a, b + 1);
    const ohneBetrag = block.filter(l => !/\d,\d{2}\s*\W{0,3}$/.test(l.text.trim()));
    const left = Math.round(Math.max(...(ohneBetrag.length ? ohneBetrag : block).map(l => l.bbox.x1)) + rowH);
    const top = Math.max(0, Math.round(Math.min(...block.map(l => l.bbox.y0)) - rowH));
    const bottom = Math.min(canvas.height, Math.round(Math.max(...block.map(l => l.bbox.y1)) + rowH));
    if (left >= canvas.width - 2 * rowH || bottom <= top) return null;
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const { data: col } = await worker.recognize(canvas, { rectangle: { left, top, width: canvas.width - left, height: bottom - top } });
    await worker.setParameters({ tessedit_pageseg_mode: '3' });
    const betraege = col.text.split('\n').map(z => (z.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*\W{0,3}$/) || [])[1]).filter(Boolean);
    if (betraege.length !== block.length) return null;
    const text = block.map((l, i) => `${l.text.trim()}   ${betraege[i]}`).join('\n');
    const r = self.LohnParser.parseLohnzettel(text);
    return r.verpflegungEuro != null ? { verpflegungEuro: r.verpflegungEuro, verpflegung: r.verpflegung } : null;
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
        const canvas = prepareImage(bmp, max, filter);
        const { data } = await worker.recognize(canvas);
        const r = self.LohnParser.parseLohnzettel(data.text);
        r.rohtext = data.text;
        if (passIdx === 0 && r.verpflegungEuro == null && /verpfl/i.test(data.text)) {
          try { Object.assign(r, await verpflegungNachlesen(worker, canvas, data)); } catch (e) { /* dann von Hand eintragen */ }
        }
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

  /* ---------- Excel (SheetJS) ---------- */
  let xlsxPromise = null;
  function loadXlsx() {
    if (!xlsxPromise) {
      xlsxPromise = new Promise((resolve, reject) => {
        if (self.XLSX) return resolve(self.XLSX);
        const s = document.createElement('script');
        s.src = 'vendor/xlsx.full.min.js';
        s.onload = () => resolve(self.XLSX);
        s.onerror = () => { xlsxPromise = null; reject(new Error('Excel-Leser konnte nicht geladen werden. Bitte einmal mit Internet öffnen.')); };
        document.head.appendChild(s);
      });
    }
    return xlsxPromise;
  }

  async function openWorkbook(blob) {
    const XLSX = await loadXlsx();
    return { XLSX, wb: XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' }) };
  }

  // Liefert pro Tabellenblatt mit Stundenerfassungsblatt ein Ergebnis: [{ blatt, data }]
  async function readWochenzettelExcel(blob) {
    const { XLSX, wb } = await openWorkbook(blob);
    const out = [];
    let letzterFehler = null;
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
      try {
        out.push({ blatt: name, data: self.WochenParser.parseWochenzettelExcel(rows) });
      } catch (e) {
        letzterFehler = e;
      }
    }
    if (!out.length && letzterFehler) throw letzterFehler;
    return out;
  }

  async function excelHtml(blob, blatt) {
    const { XLSX, wb } = await openWorkbook(blob);
    const name = blatt && wb.Sheets[blatt] ? blatt : wb.SheetNames[0];
    return XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
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

  self.Extract = { pdfTextItems, readWochenzettel, readLohnzettel, readWochenzettelExcel, excelHtml, loadXlsx };
})();
