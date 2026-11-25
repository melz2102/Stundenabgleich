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
    if (filter === 'licht' || filter === 'licht-bw') {
      const c = beleuchtungAusgleichen(prepareImage(bmp, max, 'none'), filter === 'licht-bw');
      return drehen(c, winkelSchaetzen(c));
    }
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

  // Beleuchtung ausgleichen: Grauwert geteilt durch den weichgezeichneten Hintergrund. Schatten, Farbstich und
  // ungleichmäßiges Licht verschwinden, das Papier wird weiß und die Schrift dunkel. Danach Kontrast strecken.
  function beleuchtungAusgleichen(c, binaer) {
    const w = c.width, h = c.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const sw = Math.max(16, Math.round(w / 24)), sh = Math.max(16, Math.round(h / 24));
    const klein = document.createElement('canvas');
    klein.width = sw; klein.height = sh;
    const kctx = klein.getContext('2d');
    kctx.filter = 'blur(2px)';
    kctx.drawImage(c, 0, 0, sw, sh);
    const gross = document.createElement('canvas');
    gross.width = w; gross.height = h;
    const gctx = gross.getContext('2d', { willReadFrequently: true });
    gctx.imageSmoothingQuality = 'high';
    gctx.drawImage(klein, 0, 0, w, h);
    const bg = gctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    const v = new Float32Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const g = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      const b = Math.max(1, 0.299 * bg[j] + 0.587 * bg[j + 1] + 0.114 * bg[j + 2]);
      const x = Math.min(1, g / b);
      v[i] = x;
      hist[Math.round(x * 255)]++;
    }
    let acc = 0, lo = 0;
    while (acc < n * 0.02 && lo < 255) acc += hist[lo++];
    const loV = lo / 255, spanne = Math.max(0.05, 0.92 - loV);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let x = (v[i] - loV) / spanne;
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      if (binaer) x = x < 0.6 ? 0 : 1;
      d[j] = d[j + 1] = d[j + 2] = Math.round(x * 255);
      d[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Schräglage schätzen: Bei richtigem Winkel sind die Textzeilen waagerecht und das Zeilenprofil
  // (dunkle Punkte pro Bildzeile) springt am stärksten zwischen Zeile und Zwischenraum.
  function winkelSchaetzen(c) {
    const sw = 500, sh = Math.max(1, Math.round(c.height * sw / c.width));
    const t = document.createElement('canvas');
    t.width = sw; t.height = sh;
    const tctx = t.getContext('2d', { willReadFrequently: true });
    const x0 = Math.round(sw * 0.1), x1 = Math.round(sw * 0.9);
    const bewerte = grad => {
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.fillStyle = '#fff';
      tctx.fillRect(0, 0, sw, sh);
      tctx.translate(sw / 2, sh / 2);
      tctx.rotate(grad * Math.PI / 180);
      tctx.drawImage(c, -sw / 2, -sh / 2, sw, sh);
      const d = tctx.getImageData(0, 0, sw, sh).data;
      let vorher = 0, score = 0;
      for (let y = 0; y < sh; y++) {
        let z = 0;
        for (let x = x0, j = (y * sw + x0) * 4; x < x1; x++, j += 4) if (d[j] < 128) z++;
        if (y) score += (z - vorher) * (z - vorher);
        vorher = z;
      }
      return score;
    };
    let best = 0, bestS = -1;
    for (let a = -8; a <= 8; a += 0.5) { const sc = bewerte(a); if (sc > bestS) { bestS = sc; best = a; } }
    const grob = best;
    for (let a = grob - 0.4; a <= grob + 0.41; a += 0.1) { const sc = bewerte(a); if (sc > bestS) { bestS = sc; best = a; } }
    return Math.round(best * 10) / 10;
  }

  function drehen(c, grad) {
    if (Math.abs(grad) < 1) return c; // kleine Schräglagen verkraftet die Erkennung selbst, Drehen macht die Schrift weicher
    const o = document.createElement('canvas');
    o.width = c.width; o.height = c.height;
    const ctx = o.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, o.width, o.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(o.width / 2, o.height / 2);
    ctx.rotate(grad * Math.PI / 180);
    ctx.drawImage(c, -c.width / 2, -c.height / 2);
    return o;
  }

  // Fotoqualität grob prüfen: zu dunkel, unscharf, sehr klein (z.B. per WhatsApp verschickt)
  function fotoPruefen(bmp) {
    const s = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      hist[Math.round(g[i])]++;
    }
    let acc = 0, papier = 0;
    while (acc < g.length * 0.9 && papier < 255) acc += hist[papier++];
    let sum = 0, sum2 = 0, m = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
        sum += l; sum2 += l * l; m++;
      }
    }
    const schaerfe = m ? sum2 / m - (sum / m) ** 2 : 0;
    const hinweise = [];
    if (papier < 110) hinweise.push('Das Foto ist sehr dunkel. Mach es am besten bei hellem Licht noch einmal.');
    if (schaerfe < 150) hinweise.push('Das Foto wirkt unscharf. Halte das Handy ruhig und tippe vor dem Auslösen auf den Zettel, damit scharf gestellt wird.');
    if (Math.max(bmp.width, bmp.height) < 1600) hinweise.push('Das Foto ist klein (vielleicht per WhatsApp verschickt). Das Originalfoto aus der Kamera wird genauer gelesen.');
    return { hinweise, papier, schaerfe: Math.round(schaerfe), groesse: `${bmp.width}×${bmp.height}` };
  }

  // Mehrere Durchläufe mit unterschiedlicher Aufbereitung: Fotos werden je nach Licht verschieden gut erkannt.
  // Erster Durchlauf mit ausgeglichener Beleuchtung und geradegerichtet: liest bei Kevins Fotos alle Werte.
  const PASSES = [
    { max: 3400, filter: 'licht' },
    { max: 2600, filter: 'licht' },
    { max: 5200, filter: 'none' },
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
  async function betraegeNachlesen(worker, canvas, data) {
    const istLa = l => /^\W{0,3}\d{4}\s+[A-Za-zÄÖÜäöü]/.test(l.text.trim());
    const alle = (data.lines || []).filter(istLa).sort((a, b) => a.bbox.y0 - b.bbox.y0);
    if (!alle.length) return null;
    const rowH = alle.reduce((s, l) => s + l.bbox.y1 - l.bbox.y0, 0) / alle.length;
    // größter zusammenhängender Block von Lohnarten-Zeilen (die Brutto-Bezüge)
    const bloecke = [];
    alle.forEach((l, i) => {
      if (i && l.bbox.y0 - alle[i - 1].bbox.y0 < 2.5 * rowH) bloecke[bloecke.length - 1].push(l);
      else bloecke.push([l]);
    });
    const block = bloecke.sort((x, y) => y.length - x.length)[0];
    const hatBetrag = l => /\d,\d{2}\s*\W{0,3}$/.test(l.text.trim());
    const ohneBetrag = block.filter(l => !hatBetrag(l));
    if (!ohneBetrag.length) return null; // alle Beträge schon gelesen
    const left = Math.round(Math.max(...(ohneBetrag.length ? ohneBetrag : block).map(l => l.bbox.x1)) + rowH);
    const top = Math.max(0, Math.round(Math.min(...block.map(l => l.bbox.y0)) - rowH));
    const bottom = Math.min(canvas.height, Math.round(Math.max(...block.map(l => l.bbox.y1)) + rowH));
    if (left >= canvas.width - 2 * rowH || bottom <= top) return null;
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const { data: col } = await worker.recognize(canvas, { rectangle: { left, top, width: canvas.width - left, height: bottom - top } });
    await worker.setParameters({ tessedit_pageseg_mode: '3' });
    const betraege = col.text.split('\n').map(z => (z.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*\W{0,3}$/) || [])[1]).filter(Boolean);
    if (betraege.length !== block.length) return null;
    const text = block.map((l, i) => (hatBetrag(l) ? l.text.trim() : `${l.text.trim()}   ${betraege[i]}`)).join('\n');
    const r = self.LohnParser.parseLohnzettel(text);
    return { posten: r.posten, verpflegungEuro: r.verpflegungEuro, verpflegung: r.verpflegung };
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
        if (passIdx === 0) {
          try {
            const nach = await betraegeNachlesen(worker, canvas, data);
            if (nach) {
              if (nach.posten.length >= r.posten.length) r.posten = nach.posten;
              if (r.verpflegungEuro == null && nach.verpflegungEuro != null) Object.assign(r, { verpflegungEuro: nach.verpflegungEuro, verpflegung: nach.verpflegung });
            }
          } catch (e) { /* dann von Hand eintragen */ }
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
    try { merged.foto = fotoPruefen(bmp); } catch (e) { /* nicht kritisch */ }
    merged.rohtext = results[0].rohtext;
    merged.rohtexte = results.map(r => r.rohtext); // alle Durchläufe, damit spätere App-Versionen neu auswerten können
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
