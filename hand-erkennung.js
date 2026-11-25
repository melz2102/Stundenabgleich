'use strict';
/*
 * Handgeschriebene Wochenzettel ("Stundenerfassungsblatt") vom Foto lesen – als Vorschlag zum Prüfen.
 *
 * 1. Beleuchtung ausgleichen: Tinte = deutlich dunkler als das Papier in der Umgebung.
 * 2. Linien des Formulars per Hough-Transformation finden und mit der Vorlage abgleichen:
 *    13 senkrechte Linien (Tag … Beschreibung), Kopfzeile + 6 Tage à 4 Unterzeilen, darunter die Summenzeile.
 * 3. Linien entfernen; was übrig bleibt, ist Handschrift. Je Zelle in Ziffern zerlegen.
 * 4. Jede Ziffer mit einem kleinen neuronalen Netz lesen (trainiert auf handgeschriebenen Ziffern, läuft offline).
 * 5. Mehrere Lesarten je Zelle gegen Soll, Mehr/Minder und Summenzeile prüfen und die stimmigste wählen.
 */
(function (root) {
  // Lage der senkrechten Linien zwischen linkem und rechtem Rand der Tabelle (gemessen an zwei Fotos)
  const SPALTEN = [0, 0.0305, 0.0800, 0.1290, 0.1785, 0.2285, 0.2770, 0.3265, 0.3745, 0.4230, 0.4715, 0.5705, 1];
  // Spalte i liegt zwischen Linie i und i+1
  const SP = { mehr: 1, mind: 2, prod: 3, unprod: 4, ausloese: 7, fahrt: 8, kosten: 10 };
  const ZAHL_SP = ['mehr', 'mind', 'prod', 'unprod', 'ausloese', 'fahrt'];
  const MAX = { mehr: 8, mind: 10, prod: 16, unprod: 16, ausloese: 60, fahrt: 12 };
  const SUMME_MAX = { mehr: 40, mind: 50, prod: 80, unprod: 80, ausloese: 300, fahrt: 60 };
  // Kopfzeile = 2 Unterzeilen hoch, dann 24 Unterzeilen (6 Tage à 4)
  const ZEILEN = [0].concat(Array.from({ length: 25 }, (_, i) => (i + 2) / 26));
  const SOLL = [8.5, 8.5, 8.5, 8.5, 5, 0];
  const TYPISCH_AUSLOESE = [14, 28];
  const LN = Math.log;

  /* ---------- Bild vorbereiten ---------- */
  // Tinte = deutlich dunkler als das Papier ringsum (Hintergrund aus stark verkleinertem, weichgezeichnetem Bild)
  function tinteVon(c) {
    const w = c.width, h = c.height;
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const sw = Math.max(16, Math.round(w / 24)), sh = Math.max(16, Math.round(h / 24));
    const k = document.createElement('canvas');
    k.width = sw; k.height = sh;
    const kctx = k.getContext('2d');
    kctx.filter = 'blur(2px)';
    kctx.drawImage(c, 0, 0, sw, sh);
    const g = document.createElement('canvas');
    g.width = w; g.height = h;
    const gctx = g.getContext('2d', { willReadFrequently: true });
    gctx.imageSmoothingQuality = 'high';
    gctx.drawImage(k, 0, 0, w, h);
    const bg = gctx.getImageData(0, 0, w, h).data;
    const tinte = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const grau = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      const papier = Math.max(1, 0.299 * bg[j] + 0.587 * bg[j + 1] + 0.114 * bg[j + 2]);
      if (grau / papier < 0.78) tinte[i] = 1;
    }
    return tinte;
  }

  // Schräglage aus dem Zeilenprofil der Tinte schätzen (die vielen waagerechten Linien des Formulars)
  function winkel(tinte, w, h) {
    const m = document.createElement('canvas');
    m.width = w; m.height = h;
    const mctx = m.getContext('2d');
    const img = mctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) { const v = tinte[i] ? 0 : 255; img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = v; img.data[4 * i + 3] = 255; }
    mctx.putImageData(img, 0, 0);
    const sw = 500, sh = Math.max(1, Math.round(h * sw / w));
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
      tctx.drawImage(m, -sw / 2, -sh / 2, sw, sh);
      const d = tctx.getImageData(0, 0, sw, sh).data;
      let vorher = 0, score = 0;
      for (let y = 0; y < sh; y++) {
        let z = 0;
        for (let x = x0, j = (y * sw + x0) * 4; x < x1; x++, j += 4) if (d[j] < 160) z++;
        if (y) score += (z - vorher) * (z - vorher);
        vorher = z;
      }
      return score;
    };
    let best = 0, bestS = -1;
    for (let a = -10; a <= 10; a += 0.5) { const sc = bewerte(a); if (sc > bestS) { bestS = sc; best = a; } }
    const grob = best;
    for (let a = grob - 0.4; a <= grob + 0.41; a += 0.1) { const sc = bewerte(a); if (sc > bestS) { bestS = sc; best = a; } }
    return Math.round(best * 10) / 10;
  }

  function bildDaten(bmp, max) {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    let tinte = tinteVon(c);
    const grad = winkel(tinte, w, h);
    if (Math.abs(grad) >= 1) {
      // gerade drehen; Ecken mit der mittleren Bildfarbe füllen
      const k = document.createElement('canvas');
      k.width = 1; k.height = 1;
      const kctx = k.getContext('2d', { willReadFrequently: true });
      kctx.drawImage(c, 0, 0, 1, 1);
      const [r, g, b] = kctx.getImageData(0, 0, 1, 1).data;
      const o = document.createElement('canvas');
      o.width = w; o.height = h;
      const octx = o.getContext('2d', { willReadFrequently: true });
      octx.fillStyle = `rgb(${r},${g},${b})`;
      octx.fillRect(0, 0, w, h);
      octx.imageSmoothingQuality = 'high';
      octx.translate(w / 2, h / 2);
      octx.rotate(grad * Math.PI / 180);
      octx.drawImage(bmp, -w / 2, -h / 2, w, h); // aus dem Original, damit dünne Linien kräftig bleiben
      tinte = tinteVon(o);
    }
    return { w, h, tinte, grad };
  }

  // Punkte, die zu langen waagerechten (bzw. senkrechten) Läufen gehören – das sind Linien, keine Schrift
  function laeufe(m, w, h, senkrecht, L) {
    const out = new Uint8Array(w * h);
    const n1 = senkrecht ? w : h, n2 = senkrecht ? h : w;
    const at = senkrecht ? (a, b) => b * w + a : (a, b) => a * w + b;
    for (let a = 0; a < n1; a++) {
      let b = 0;
      while (b < n2) {
        if (!m[at(a, b)]) { b++; continue; }
        const s = b;
        let luecke = 0;
        while (b < n2 && (m[at(a, b)] || luecke < 3)) { luecke = m[at(a, b)] ? 0 : luecke + 1; b++; }
        const e = b - luecke;
        if (e - s >= L) for (let x = s; x < e; x++) out[at(a, x)] = 1;
      }
    }
    return out;
  }

  // Hough für fast waagerechte Linien (y = c + k·x) bzw. fast senkrechte (x = c + k·y), ±6°
  function hough(m, w, h, senkrecht, minStimmen) {
    const U = senkrecht ? h : w, V = senkrecht ? w : h;
    const us = [], vs = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { us.push(senkrecht ? y : x); vs.push(senkrecht ? x : y); }
    const rand = Math.ceil(0.11 * U) + 2;
    const acc = new Int32Array(V + 2 * rand);
    const kand = [];
    for (let g = -6; g <= 6.001; g += 0.25) {
      const k = Math.tan(g * Math.PI / 180);
      acc.fill(0);
      for (let i = 0; i < us.length; i++) acc[Math.round(vs[i] - k * us[i]) + rand]++;
      for (let i = 0; i < acc.length; i++) if (acc[i] >= minStimmen) kand.push({ n: acc[i], c: i - rand, k });
    }
    kand.sort((a, b) => b.n - a.n);
    const mitte = U / 2, lage = l => l.c + l.k * mitte;
    const out = [];
    for (const l of kand) if (out.every(o => Math.abs(lage(o) - lage(l)) > 0.007 * U)) out.push(l);
    return out.map(l => ({ ...l, p: lage(l) })).sort((a, b) => a.p - b.p);
  }

  // Bestes Paar (Anfang, Ende), bei dem die Vorlage die meisten gefundenen Linien trifft
  function vorlageAnpassen(linien, vorlage, minSpanne, maxSpanne, tolAnteil) {
    let best = null;
    for (let i = 0; i < linien.length; i++) {
      for (let j = i + 1; j < linien.length; j++) {
        const a = linien[i].p, spanne = linien[j].p - a;
        if (spanne < minSpanne || spanne > maxSpanne) continue;
        const tol = spanne * tolAnteil;
        let treffer = 0, fehler = 0;
        const zuordnung = vorlage.map(f => {
          const soll = a + f * spanne;
          let bestL = null, bestD = tol;
          for (const l of linien) { const dd = Math.abs(l.p - soll); if (dd <= bestD) { bestD = dd; bestL = l; } }
          if (bestL) { treffer++; fehler += bestD; }
          return bestL;
        });
        const score = treffer - fehler / (tol * vorlage.length);
        if (!best || score > best.score) best = { score, treffer, zuordnung, i, j };
      }
    }
    if (!best) return null;
    // Nicht gefundene Linien zwischen den Nachbarn einsetzen
    const z = best.zuordnung;
    const linienOut = vorlage.map((f, idx) => {
      if (z[idx]) return z[idx];
      let lo = idx - 1; while (lo >= 0 && !z[lo]) lo--;
      let hi = idx + 1; while (hi < z.length && !z[hi]) hi++;
      const A = lo >= 0 ? z[lo] : linien[best.i], B = hi < z.length ? z[hi] : linien[best.j];
      const fa = lo >= 0 ? vorlage[lo] : 0, fb = hi < z.length ? vorlage[hi] : 1;
      const t = (f - fa) / ((fb - fa) || 1);
      return { c: A.c + (B.c - A.c) * t, k: A.k + (B.k - A.k) * t, p: A.p + (B.p - A.p) * t, interpoliert: true };
    });
    return { linien: linienOut, treffer: best.treffer };
  }

  /* ---------- Handschrift in Teile zerlegen ---------- */
  function komponenten(m, w, h, minN) {
    const lab = new Int32Array(w * h);
    const comps = [];
    const stack = [];
    let id = 0;
    for (let i = 0; i < w * h; i++) {
      if (!m[i] || lab[i]) continue;
      id++;
      const c = { x0: w, y0: h, x1: 0, y1: 0, n: 0, sx: 0, sy: 0, px: [] };
      stack.push(i); lab[i] = id;
      while (stack.length) {
        const p = stack.pop();
        const x = p % w, y = (p - x) / w;
        c.n++; c.sx += x; c.sy += y; c.px.push(p);
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (m[q] && !lab[q]) { lab[q] = id; stack.push(q); }
        }
      }
      if (c.n >= minN && c.x1 - c.x0 >= 1 && c.y1 - c.y0 >= 1) { c.cx = c.sx / c.n; c.cy = c.sy / c.n; comps.push(c); }
    }
    return comps;
  }

  function vereinige(teile) {
    const c = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0, sx: 0, sy: 0, px: [] };
    for (const t of teile) {
      c.x0 = Math.min(c.x0, t.x0); c.y0 = Math.min(c.y0, t.y0); c.x1 = Math.max(c.x1, t.x1); c.y1 = Math.max(c.y1, t.y1);
      c.n += t.n; c.sx += t.sx; c.sy += t.sy; c.px = c.px.concat(t.px);
    }
    c.cx = c.sx / c.n; c.cy = c.sy / c.n;
    return c;
  }

  function teilVonPunkten(px, w) {
    const c = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0, sx: 0, sy: 0, px };
    for (const p of px) {
      const x = p % w, y = (p - x) / w;
      c.x0 = Math.min(c.x0, x); c.y0 = Math.min(c.y0, y); c.x1 = Math.max(c.x1, x); c.y1 = Math.max(c.y1, y);
      c.n++; c.sx += x; c.sy += y;
    }
    c.cx = c.sx / c.n; c.cy = c.sy / c.n;
    return c;
  }

  // Zusammenhängende Tinte an den dünnsten Stellen in k Teile schneiden
  function schneiden(c, k, w) {
    const bw = c.x1 - c.x0 + 1;
    const proj = new Float32Array(bw);
    c.px.forEach(p => { proj[p % w - c.x0]++; });
    const schnitte = [];
    for (let j = 1; j < k; j++) {
      const soll = j * bw / k, r = 0.3 * bw / k;
      let best = Math.round(soll), bestV = Infinity;
      for (let x = Math.max(1, Math.round(soll - r)); x <= Math.min(bw - 2, Math.round(soll + r)); x++) {
        const v = proj[x - 1] + 2 * proj[x] + proj[x + 1] + Math.abs(x - soll) * 0.05;
        if (v < bestV) { bestV = v; best = x; }
      }
      schnitte.push(best + c.x0);
    }
    const gruppen = schnitte.map(() => []).concat([[]]);
    c.px.forEach(p => { const x = p % w; let i = 0; while (i < schnitte.length && x >= schnitte[i]) i++; gruppen[i].push(p); });
    if (gruppen.some(g => g.length < 3)) return null;
    return gruppen.map(g => teilVonPunkten(g, w));
  }

  // Zwei zusammengeschriebene Ziffern: mehrere Schnitte ausprobieren, auch schräg (Handschrift ist meist nach rechts geneigt).
  // Welcher Schnitt passt, entscheidet später das Netz (die Ziffern mit der höchsten Sicherheit).
  function zweiTeile(c, w) {
    const bw = c.x1 - c.x0 + 1, ym = (c.y0 + c.y1) / 2, bh = c.y1 - c.y0 + 1;
    const out = [];
    for (const f of [0.35, 0.43, 0.5, 0.57, 0.65]) for (const sl of [0, 0.25, 0.5]) {
      const xs = c.x0 + f * bw;
      const a = [], b = [];
      for (const p of c.px) { const x = p % w, y = (p - x) / w; (x < xs + sl * (ym - y) ? a : b).push(p); }
      if (a.length < 0.15 * c.n || b.length < 0.15 * c.n) continue;
      const A = teilVonPunkten(a, w), B = teilVonPunkten(b, w);
      if (A.y1 - A.y0 + 1 < 0.4 * bh || B.y1 - B.y0 + 1 < 0.4 * bh) continue;
      out.push([A, B]);
    }
    return out;
  }

  // Tinte einer Zelle in Zeichen zerlegen. Jede Stelle bekommt mehrere Deutungen mit Vorab-Gewicht:
  // eine Ziffer, zwei (oder drei) zusammengeschriebene Ziffern, ein Komma oder nichts (Fussel, Strich).
  function zeichen(cs, w, u) {
    cs = cs.filter(c => Math.max(c.x1 - c.x0, c.y1 - c.y0) + 1 >= 0.12 * u);
    if (!cs.length) return { stellen: [] };
    // Teile, die sich waagerecht stark überlappen, gehören zu einem Zeichen (z.B. Dach der 5, zweiteilige 4)
    cs = cs.slice().sort((a, b) => a.x0 - b.x0);
    const zus = [];
    for (const c of cs) {
      const l = zus[zus.length - 1];
      if (l) {
        const ov = Math.min(l.x1, c.x1) - Math.max(l.x0, c.x0);
        if (ov >= 0.5 * Math.min(l.x1 - l.x0 + 1, c.x1 - c.x0 + 1)) { zus[zus.length - 1] = vereinige([l, c]); continue; }
      }
      zus.push(c);
    }
    const H = Math.max(...zus.map(c => c.y1 - c.y0 + 1));
    const gross = zus.filter(c => c.y1 - c.y0 + 1 >= 0.6 * H);
    const bandO = Math.min(...gross.map(c => c.y0)), bandU = Math.max(...gross.map(c => c.y1));
    const stellen = zus.map((c, i) => {
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1, ar = bw / bh;
      const klein = bh < 0.55 * H;
      const tief = c.cy > bandO + 0.5 * (bandU - bandO);
      const flach = bh < 0.22 * u || ar > 3;
      const innen = i > 0 && i < zus.length - 1;
      const opt = [];
      opt.push({ art: 'nichts', lp: LN(flach ? 0.6 : klein ? 0.15 : 0.02) });
      if (klein && tief) opt.push({ art: 'komma', lp: LN(innen ? 0.7 : 0.3) });
      if (!flach) {
        opt.push({ art: 'ziffer', teile: [c], lp: LN(klein ? 0.2 : ar <= 0.9 ? 0.9 : ar <= 1.3 ? 0.5 : 0.1) });
        if (!klein && ar > 0.6) {
          const lp = LN(ar <= 0.9 ? 0.1 : ar <= 1.3 ? 0.5 : 0.9);
          zweiTeile(c, w).forEach(teile => opt.push({ art: 'ziffer', teile, lp }));
        }
        if (!klein && ar > 1.4) {
          const drei = schneiden(c, 3, w);
          if (drei) opt.push({ art: 'ziffer', teile: drei, lp: LN(ar > 1.9 ? 0.5 : 0.15) });
        }
      }
      return { c, opt };
    });
    return { stellen, H };
  }

  /* ---------- Ziffern-Netz ---------- */
  let netz = null;
  function ladeNetz() {
    if (netz) return netz;
    const M = root.ZIFFERN_NETZ;
    if (!M) throw new Error('Die Ziffernerkennung ist nicht geladen.');
    const deq = t => {
      const bin = atob(t.d);
      const a = new Float32Array(bin.length);
      for (let i = 0; i < bin.length; i++) { const v = bin.charCodeAt(i); a[i] = (v > 127 ? v - 256 : v) * t.s; }
      return a;
    };
    netz = {};
    Object.keys(M).forEach(k => { netz[k] = deq(M[k]); });
    return netz;
  }

  // Wie beim Training (MNIST): Ziffer in 20×20 einpassen (Flächenmittel), Schwerpunkt in die Mitte von 28×28
  function flaechenGewichte(nSrc, nDst) {
    const s = nDst / nSrc, W = [];
    for (let i = 0; i < nDst; i++) {
      const a = i / s, b = (i + 1) / s, row = [];
      let sum = 0;
      for (let y = Math.floor(a); y < nSrc && y < b; y++) {
        const ov = Math.min(b, y + 1) - Math.max(a, y);
        if (ov > 0) { row.push([y, ov]); sum += ov; }
      }
      row.forEach(r => { r[1] /= sum; });
      W.push(row);
    }
    return W;
  }

  function normalisieren(c, w) {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    const m = new Float32Array(bw * bh);
    c.px.forEach(p => { const x = p % w; m[((p - x) / w - c.y0) * bw + x - c.x0] = 1; });
    const s = 20 / Math.max(bw, bh);
    const nh = Math.max(1, Math.floor(bh * s + 0.5)), nw = Math.max(1, Math.floor(bw * s + 0.5));
    const Wy = flaechenGewichte(bh, nh), Wx = flaechenGewichte(bw, nw);
    const tmp = new Float32Array(nh * bw);
    for (let i = 0; i < nh; i++) for (const [y, g] of Wy[i]) for (let x = 0; x < bw; x++) tmp[i * bw + x] += g * m[y * bw + x];
    const klein = new Float32Array(nh * nw);
    for (let i = 0; i < nh; i++) for (let j = 0; j < nw; j++) { let v = 0; for (const [x, g] of Wx[j]) v += g * tmp[i * bw + x]; klein[i * nw + j] = v; }
    let tot = 0, sy = 0, sx = 0;
    for (let i = 0; i < nh; i++) for (let j = 0; j < nw; j++) { const v = klein[i * nw + j]; tot += v; sy += v * i; sx += v * j; }
    const oy = Math.min(Math.max(Math.floor(13.5 - sy / tot + 0.5), 0), 28 - nh);
    const ox = Math.min(Math.max(Math.floor(13.5 - sx / tot + 0.5), 0), 28 - nw);
    const out = new Float32Array(784);
    for (let i = 0; i < nh; i++) for (let j = 0; j < nw; j++) out[(oy + i) * 28 + ox + j] = klein[i * nw + j];
    return out;
  }

  function klassifiziere(x) {
    const N = ladeNetz();
    // conv1 5×5, 16 Filter, ReLU, MaxPool 2 (p1 startet bei 0 = ReLU)
    const p1 = new Float32Array(12 * 12 * 16);
    const a1 = new Float32Array(16);
    for (let oy = 0; oy < 24; oy++) for (let ox = 0; ox < 24; ox++) {
      a1.set(N.b1);
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
        const v = x[(oy + i) * 28 + ox + j];
        if (!v) continue;
        const r = (i * 5 + j) * 16;
        for (let f = 0; f < 16; f++) a1[f] += v * N.w1[r + f];
      }
      const q = ((oy >> 1) * 12 + (ox >> 1)) * 16;
      for (let f = 0; f < 16; f++) if (a1[f] > p1[q + f]) p1[q + f] = a1[f];
    }
    // conv2 5×5, 32 Filter, ReLU, MaxPool 2
    const p2 = new Float32Array(4 * 4 * 32);
    const a2 = new Float32Array(32);
    for (let oy = 0; oy < 8; oy++) for (let ox = 0; ox < 8; ox++) {
      a2.set(N.b2);
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
        const base = ((oy + i) * 12 + ox + j) * 16;
        for (let c = 0; c < 16; c++) {
          const v = p1[base + c];
          if (!v) continue;
          const r = (c * 25 + i * 5 + j) * 32;
          for (let f = 0; f < 32; f++) a2[f] += v * N.w2[r + f];
        }
      }
      const q = ((oy >> 1) * 4 + (ox >> 1)) * 32;
      for (let f = 0; f < 32; f++) if (a2[f] > p2[q + f]) p2[q + f] = a2[f];
    }
    const h = new Float32Array(64);
    h.set(N.b3);
    for (let i = 0; i < 512; i++) { const v = p2[i]; if (v) for (let f = 0; f < 64; f++) h[f] += v * N.w3[i * 64 + f]; }
    const K = N.b4.length; // 10 Ziffern + "keine Ziffer"
    const z = Array.from(N.b4);
    for (let i = 0; i < 64; i++) { const v = Math.max(0, h[i]); if (v) for (let f = 0; f < K; f++) z[f] += v * N.w4[i * K + f]; }
    const mx = Math.max(...z), e = z.map(v => Math.exp(v - mx)), s = e.reduce((a, b) => a + b, 0);
    return e.map(v => v / s);
  }

  /* ---------- Lesarten einer Zelle ---------- */
  // Klasse 10 = keine Ziffer (Komma, Strich, Punkt), Klasse 11 = mehrere zusammengeschriebene Ziffern
  const KEINE = g => Math.max(g.p[10] || 0, 0.003);
  const PAAR = g => (g.p.length > 11 ? Math.min(1, 0.1 + g.p[11]) : 1);
  // Strahlsuche über alle Deutungen der Stellen: Ergebnis = Ziffernfolge + Lage des Kommas mit Gewicht
  function folgen(z) {
    let strahl = [{ s: '', komma: -1, lp: 0 }];
    for (const st of z.stellen) {
      const neu = [];
      for (const b of strahl) {
        for (const o of st.opt) {
          if (o.art === 'nichts') neu.push({ ...b, lp: b.lp + o.lp + LN(KEINE(st.c)) });
          else if (o.art === 'komma') { if (b.s.length && b.komma < 0) neu.push({ ...b, komma: b.s.length, lp: b.lp + o.lp + LN(KEINE(st.c)) }); }
          else {
            let teil = [{ s: '', lp: 0 }];
            for (const g of o.teile) {
              const top = g.p.slice(0, 10).map((p, d) => ({ d, p })).sort((x, y) => y.p - x.p).slice(0, 3);
              teil = teil.flatMap(t => top.map(q => ({ s: t.s + q.d, lp: t.lp + LN(Math.max(q.p, 1e-4)) })));
            }
            const paar = o.teile.length > 1 ? LN(PAAR(st.c)) : 0;
            teil.forEach(t => neu.push({ ...b, s: b.s + t.s, lp: b.lp + o.lp + paar + t.lp }));
          }
        }
      }
      neu.sort((x, y) => y.lp - x.lp);
      strahl = neu.slice(0, 80);
    }
    return strahl.filter(b => b.komma < 0 || b.komma < b.s.length);
  }

  function lesarten(z, spalte, summe) {
    if (!z || !z.stellen.length) return [{ v: null, lp: 0 }];
    const max = (summe ? SUMME_MAX : MAX)[spalte];
    const schritt = spalte === 'ausloese' ? 0.5 : 0.25;
    const out = new Map();
    const add = (v, lp) => {
      if (v != null && (isNaN(v) || v > max || Math.abs(v / schritt - Math.round(v / schritt)) > 1e-6)) return;
      if (v != null) v = Math.round(v * 100) / 100;
      // Verpflegung: fast immer die Pauschalen 14 € oder 28 €
      if (spalte === 'ausloese' && !summe && v != null && !TYPISCH_AUSLOESE.includes(v)) lp += LN(0.2);
      const key = v == null ? 'leer' : v;
      if (!out.has(key) || out.get(key).lp < lp) out.set(key, { v, lp });
    };
    for (const f of folgen(z)) {
      const s = f.s;
      if (!s) { add(null, f.lp); continue; }
      if (s.length > 4) continue;
      if (f.komma > 0) {
        add(parseFloat(s.slice(0, f.komma) + '.' + s.slice(f.komma)), f.lp);
      } else {
        add(parseFloat(s), f.lp);
        // Komma nicht gesehen (z.B. mit der Ziffer verbunden)
        if (s.length >= 2) add(parseFloat(s.slice(0, -1) + '.' + s.slice(-1)), f.lp + LN(0.3));
        if (s.length >= 3) add(parseFloat(s.slice(0, -2) + '.' + s.slice(-2)), f.lp + LN(0.15));
      }
    }
    const liste = [...out.values()].sort((a, b) => b.lp - a.lp);
    if (!liste.length) return [{ v: null, lp: 0 }];
    const best = liste[0].lp;
    const res = liste.slice(0, 6).map(o => ({ v: o.v, lp: o.lp - best }));
    if (!res.some(o => o.v == null)) res.push({ v: null, lp: LN(0.002) });
    return res;
  }

  // Alle Kombinationen (mit Begrenzung) einer Liste von Lesarten-Listen
  function kombinationen(listen, maxN) {
    let res = [{ wahl: [], lp: 0 }];
    for (const l of listen) {
      res = res.flatMap(r => l.map(o => ({ wahl: r.wahl.concat([o.v]), lp: r.lp + o.lp })));
      if (res.length > maxN) { res.sort((a, b) => b.lp - a.lp); res = res.slice(0, maxN); }
    }
    return res;
  }

  const r2 = v => Math.round(v * 100) / 100;
  const STRAFE_TAG = LN(0.0005);  // Tag passt nicht zu Soll und Mehr/Minder (sehr verlässliche Regel)
  const STRAFE = LN(0.2);         // Summenzeile passt nicht (die Summen selbst sind schwerer zu lesen)

  /* ---------- Hauptfunktion ---------- */
  async function erkenne(blob, opts = {}) {
    const bmp = blob instanceof Blob ? await createImageBitmap(blob, { imageOrientation: 'from-image' }) : blob;
    const B = bildDaten(bmp, opts.max || 1600);
    const { w, h } = B;
    const Hm = laeufe(B.tinte, w, h, false, Math.round(0.06 * w));
    const Vm = laeufe(B.tinte, w, h, true, Math.round(0.05 * w));
    const hl = hough(Hm, w, h, false, 0.3 * w);
    const vl = hough(Vm, w, h, true, 0.2 * h);
    const S = vorlageAnpassen(vl, SPALTEN, 0.6 * w, w, 0.012);
    const Z = vorlageAnpassen(hl, ZEILEN, 0.35 * h, 0.9 * h, 0.009);
    if (opts.debug) root.RASTER = { w, h, S: S && S.treffer, Z: Z && Z.treffer, grad: B.grad, nh: hl.length, nv: vl.length, hl: hl.map(l => Math.round(l.p)), vl: vl.map(l => Math.round(l.p)) };
    if (!S || !Z || S.treffer < 9 || Z.treffer < 18) {
      throw new Error('Das Formular wurde auf dem Foto nicht sicher gefunden. Fotografiere den ganzen Zettel möglichst gerade von oben, ohne Schatten.');
    }
    const spalten = S.linien, zeilen = Z.linien;
    const u = (zeilen[25].p - zeilen[1].p) / 24; // Höhe einer Unterzeile
    // Summenzeile: von der Unterkante der Tabelle bis zur nächsten Linie darunter
    const unten = zeilen[25];
    const naechste = hl.find(l => l.p > unten.p + 0.7 * u && l.p < unten.p + 1.8 * u);
    const summeEnde = naechste || { c: unten.c + 1.15 * u, k: unten.k, p: unten.p + 1.15 * u };

    // Linien entfernen (etwas verbreitert), übrig bleibt die Handschrift
    const r = Math.max(1, Math.round(w / 700));
    const schrift = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!B.tinte[i]) continue;
      let linie = false;
      for (let d = -r; d <= r && !linie; d++) {
        if (y + d >= 0 && y + d < h && Hm[i + d * w]) linie = true;
        if (x + d >= 0 && x + d < w && Vm[i + d]) linie = true;
      }
      if (!linie) schrift[i] = 1;
    }
    // Auch kurze Linien (z.B. Kästchen der Summenzeile) entlang des gefundenen Rasters entfernen
    const rr = r + 1;
    const loesche = (x, y) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) schrift[y * w + x] = 0; };
    const yOben = zeilen[0].p - u, yUnten = summeEnde.p + 0.5 * u;
    spalten.forEach(l => { for (let y = Math.max(0, Math.floor(yOben)); y < Math.min(h, yUnten); y++) for (let d = -rr; d <= rr; d++) loesche(l.c + l.k * y + d, y); });
    zeilen.concat([summeEnde]).forEach(l => { for (let x = Math.max(0, Math.floor(spalten[0].p - u)); x < Math.min(w, spalten[12].p + u); x++) for (let d = -rr; d <= rr; d++) loesche(x, l.c + l.k * x + d); });
    if (opts.debug) root.SCHRIFT = { w, h, tinte: Array.from(B.tinte), schrift: Array.from(schrift), spalten, zeilen };
    const minN = Math.max(4, Math.round(6 * (u / 24) ** 2));
    const comps = komponenten(schrift, w, h, minN);

    // Teile den Zellen zuordnen (über den Schwerpunkt)
    const zellen = new Map();
    for (const c of comps) {
      let si = -1;
      for (let i = 0; i < 12; i++) {
        const xl = spalten[i].c + spalten[i].k * c.cy, xr = spalten[i + 1].c + spalten[i + 1].k * c.cy;
        if (c.cx >= xl && c.cx < xr) { si = i; break; }
      }
      if (si < 1 || si > SP.kosten) continue;
      const yAt = l => l.c + l.k * c.cx;
      let key = null;
      for (let zi = 1; zi < 25; zi++) {
        if (c.cy >= yAt(zeilen[zi]) && c.cy < yAt(zeilen[zi + 1])) { key = `${Math.floor((zi - 1) / 4)}:${(zi - 1) % 4}:${si}`; break; }
      }
      if (!key && c.cy >= yAt(unten) && c.cy < yAt(summeEnde)) key = `S:0:${si}`;
      if (!key) continue;
      if (!zellen.has(key)) zellen.set(key, []);
      zellen.get(key).push(c);
    }

    // Ziffern lesen
    const gelesen = {};
    for (const [key, cs] of zellen) {
      const z = zeichen(cs, w, u);
      if (!z.stellen.length) continue;
      z.stellen.forEach(st => {
        st.c.p = klassifiziere(normalisieren(st.c, w));
        st.opt.forEach(o => (o.teile || []).forEach(g => { if (!g.p) g.p = klassifiziere(normalisieren(g, w)); }));
      });
      gelesen[key] = z;
      if (opts.debug) {
        const top = g => { const m = Math.max(...g.p); const d = g.p.indexOf(m); return (d === 10 ? '·' : d) + ''; };
        z.text = z.stellen.map(st => top(st.c)).join('');
        z.bilder = z.stellen.map(st => Array.from(normalisieren(st.c, w), v => Math.round(v * 255)));
        z.sicher = z.stellen.map(st => Math.round(Math.max(...st.c.p) * 100));
      }
    }
    // Kalenderwoche: rechts neben "Kalenderwoche:" über der Spalte "Beschreibung"
    let kw = null;
    {
      const a = spalten[11], b = spalten[12], oben = zeilen[0];
      const kwTeile = comps.filter(c => {
        const xa = a.c + a.k * c.cy, xb = b.c + b.k * c.cy, yo = oben.c + oben.k * c.cx;
        return c.cx > xa + 0.12 * (xb - xa) && c.cx < xa + 0.55 * (xb - xa) && c.cy > yo - 1.7 * u && c.cy < yo - 0.1 * u;
      });
      const z = zeichen(kwTeile, w, u);
      if (z.stellen.length && z.stellen.length <= 3) {
        z.stellen.forEach(st => {
          st.c.p = klassifiziere(normalisieren(st.c, w));
          st.opt.forEach(o => (o.teile || []).forEach(g => { if (!g.p) g.p = klassifiziere(normalisieren(g, w)); }));
        });
        const f = folgen(z).find(x => x.komma < 0 && x.s.length >= 1 && x.s.length <= 2 && +x.s >= 1 && +x.s <= 53);
        if (f && f.lp > LN(0.3) * f.s.length) kw = +f.s;
      }
    }
    const res = auswerten(gelesen, { spalten: S.treffer, zeilen: Z.treffer, u });
    res.kw = kw;
    if (opts.debug) res.gelesen = gelesen;
    return res;
  }

  // Lesarten gegen Soll, Mehr/Minder und Summenzeile abwägen
  function auswerten(gelesen, info) {
    const L = (b, z, name) => lesarten(gelesen[`${b}:${z}:${SP[name]}`], name, b === 'S');
    // 1) Stunden je Tag: Prod + Unprod − Soll = Mehr − Minder
    const STD = ['prod', 'unprod', 'mehr', 'mind'];
    const tagKombis = [];
    for (let b = 0; b < 6; b++) {
      const zeilenMitTinte = [0, 1, 2, 3].filter(z => ZAHL_SP.concat(['kosten']).some(n => gelesen[`${b}:${z}:${SP[n]}`]));
      const listen = [], wo = [];
      for (const z of zeilenMitTinte) for (const n of STD) { listen.push(L(b, z, n)); wo.push([z, n]); }
      // Nur eine beschriebene Zeile: fehlende Lesart aus der Tagesregel ergänzen (schwach gewichtet),
      // z.B. Prod. = Soll + Mehr − Minder, wenn die Stunden selbst unleserlich sind
      const stdZeilen = zeilenMitTinte.filter(z => STD.some(n => gelesen[`${b}:${z}:${SP[n]}`]));
      if (stdZeilen.length === 1) {
        const z = stdZeilen[0], idx = n => wo.findIndex(([zz, nn]) => zz === z && nn === n);
        const Lx = n => listen[idx(n)];
        const dazu = (n, v) => {
          if (!gelesen[`${b}:${z}:${SP[n]}`] || v == null || v <= 0 || v > MAX[n]) return;
          v = r2(v);
          if (!Lx(n).some(o => o.v === v)) Lx(n).push({ v, lp: LN(0.003) });
        };
        const basis = { prod: Lx('prod').slice(), mehr: Lx('mehr').slice(), mind: Lx('mind').slice() };
        basis.mehr.forEach(m => basis.mind.forEach(d => { if (m.v != null || d.v != null) dazu('prod', SOLL[b] + (m.v || 0) - (d.v || 0)); }));
        basis.prod.forEach(o => { if (o.v != null) { dazu('mehr', o.v - SOLL[b]); dazu('mind', SOLL[b] - o.v); } });
      }
      const ks = kombinationen(listen, 400).map(k => {
        const sum = n => k.wahl.reduce((s, v, i) => s + (wo[i][1] === n && v != null ? v : 0), 0);
        const ist = sum('prod') + sum('unprod');
        const leer = k.wahl.every(v => v == null);
        const passt = leer ? null : Math.abs(ist - SOLL[b] - (sum('mehr') - sum('mind'))) < 0.01;
        return { ...k, wo, passt, lp: k.lp + (passt === false ? STRAFE_TAG : 0), summen: { prod: sum('prod'), unprod: sum('unprod'), mehr: sum('mehr'), mind: sum('mind') } };
      }).sort((a, c) => c.lp - a.lp).slice(0, 6);
      tagKombis.push({ zeilen: zeilenMitTinte, ks });
    }
    // 2) Summenzeile für Prod, Unprod, Mehr, Minder
    const summenL = Object.fromEntries(STD.map(n => [n, gelesen[`S:0:${SP[n]}`] ? L('S', 0, n) : null]));
    const summePasst = (n, wert) => {
      const l = summenL[n];
      if (!l) return { lp: 0, passt: null };
      const t = l.find(o => o.v != null && Math.abs(o.v - wert) < 0.01);
      return t ? { lp: t.lp - l[0].lp, passt: true } : { lp: STRAFE, passt: false };
    };
    let bestWahl = null;
    const rek = (b, wahl, lp) => {
      if (b === 6) {
        let ges = lp;
        const sum = {};
        STD.forEach(n => { sum[n] = r2(wahl.reduce((s, k) => s + k.summen[n], 0)); ges += summePasst(n, sum[n]).lp; });
        if (!bestWahl || ges > bestWahl.lp) bestWahl = { wahl: wahl.slice(), lp: ges, sum };
        return;
      }
      for (const k of tagKombis[b].ks) { wahl.push(k); rek(b + 1, wahl, lp + k.lp); wahl.pop(); }
    };
    rek(0, [], 0);
    // 3) Auslöse und Fahrt: unabhängig je Spalte, gegen die Summenzeile
    const extra = {};
    for (const n of ['ausloese', 'fahrt']) {
      const zellen = [];
      for (let b = 0; b < 6; b++) for (let z = 0; z < 4; z++) if (gelesen[`${b}:${z}:${SP[n]}`]) zellen.push([b, z]);
      const ks = kombinationen(zellen.map(([b, z]) => L(b, z, n)), 2000);
      const sl = gelesen[`S:0:${SP[n]}`] ? L('S', 0, n) : null;
      let best = null;
      for (const k of ks) {
        const sum = r2(k.wahl.reduce((s, v) => s + (v || 0), 0));
        let lp = k.lp, passt = null;
        if (sl) {
          const t = sl.find(o => o.v != null && Math.abs(o.v - sum) < 0.01);
          lp += t ? t.lp - sl[0].lp : STRAFE;
          passt = !!t;
        }
        if (!best || lp > best.lp) best = { k, lp, sum, passt };
      }
      extra[n] = { zellen, wahl: best ? best.k.wahl : [], sum: best ? best.sum : 0, passt: best ? best.passt : null, summe: sl ? sl[0].v : null };
    }
    // 4) Ergebnis je Tag
    const tage = [];
    for (let b = 0; b < 6; b++) {
      const k = bestWahl.wahl[b];
      const eintraege = tagKombis[b].zeilen.map(z => {
        const e = { mehr: null, mind: null, prod: null, unprod: null, ausloese: null, fahrt: null, kostentraeger: '' };
        k.wo.forEach(([zz, n], i) => { if (zz === z) e[n] = k.wahl[i]; });
        ['ausloese', 'fahrt'].forEach(n => {
          const i = extra[n].zellen.findIndex(([bb, zz]) => bb === b && zz === z);
          if (i >= 0) e[n] = extra[n].wahl[i];
        });
        e.kostentraeger = kostentraeger(gelesen[`${b}:${z}:${SP.kosten}`]);
        return e;
      }).filter(e => ZAHL_SP.some(n => e[n] != null) || e.kostentraeger);
      tage.push({ eintraege, passt: k.passt });
    }
    // Wiederholungszeichen ("-″-") beim Kostenträger: wie am Vortag
    let letzte = '';
    tage.forEach(t => t.eintraege.forEach(e => {
      if (e.kostentraeger === '″') e.kostentraeger = letzte;
      else if (e.kostentraeger) letzte = e.kostentraeger;
    }));
    const summe = {}, vergleich = {};
    STD.forEach(n => {
      summe[n] = summenL[n] ? (summenL[n].find(o => o.v != null && Math.abs(o.v - bestWahl.sum[n]) < 0.01) || summenL[n][0]).v : null;
      if (summenL[n]) vergleich[n] = summePasst(n, bestWahl.sum[n]).passt;
    });
    ['ausloese', 'fahrt'].forEach(n => {
      summe[n] = extra[n].passt ? extra[n].sum : extra[n].summe;
      if (extra[n].passt != null) vergleich[n] = extra[n].passt;
    });
    const ist = { ...bestWahl.sum, ausloese: extra.ausloese.sum, fahrt: extra.fahrt.sum };
    return { tage, summe, ist, vergleich, info };
  }

  // Kostenträger: 5–8 Ziffern; nur Striche (Wiederholungszeichen "-″-") = wie am Vortag
  function kostentraeger(z) {
    if (!z || !z.stellen.length) return '';
    const best = folgen(z)[0];
    if (!best || !best.s) return '″';
    if (best.s.length >= 5 && best.s.length <= 8 && best.lp > z.stellen.length * LN(0.5)) return best.s;
    return best.s.length < 3 ? '″' : '';
  }

  root.HandErkennung = { erkenne, auswerten, lesarten, zeichen, normalisieren, klassifiziere };
})(typeof self !== 'undefined' ? self : this);
