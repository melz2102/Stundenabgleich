'use strict';
/*
 * Wertet den erkannten Text einer DATEV-Lohnabrechnung ("Abrechnung der Brutto/Netto-Bezüge") aus.
 * Eingabe: der Text (Zeilen), so wie ihn die Texterkennung liefert.
 * Ausgabe: Monat, Stunden-Lohnarten, Arbeitszeitkonto, Urlaub, Zeitlohn-/Überstunden und Hinweise,
 *          wo etwas nicht zusammenpasst. Alle Werte werden in der App noch einmal zum Prüfen angezeigt.
 */
(function (root) {
  const MONATE = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];

  // "1.234,50" / "166,00" / "4,25-" -> Zahl
  function deNum(s) {
    if (s == null) return null;
    let t = String(s).trim();
    const neg = /-$/.test(t) || /^-/.test(t);
    t = t.replace(/[^\d,]/g, '');
    if (!t) return null;
    const n = parseFloat(t.replace(',', '.'));
    return isNaN(n) ? null : (neg ? -n : n);
  }

  // DATEV druckt Kopf-Werte ohne Komma mit 2 Nachkommastellen: "2700" = 27,00
  const implied = s => (s == null ? null : parseInt(s, 10) / 100);

  // OCR verwechselt gern O/0, l/1, S/5 in Zahlen
  function fixDigits(s) {
    return s.replace(/_/g, ' ').replace(/(?<=\d)[Oo](?=\d|\b)/g, '0').replace(/(?<=\d)[lI|](?=\d)/g, '1');
  }

  function findLineIndex(lines, re, from = 0) {
    for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
    return -1;
  }

  // Zahlen der nächsten Zeile(n) unter einer Überschriftszeile, die nicht leer ist
  function numbersBelow(lines, idx, maxLook = 3) {
    for (let j = idx + 1; j <= Math.min(idx + maxLook, lines.length - 1); j++) {
      const nums = (fixDigits(lines[j]).match(/\b\d{2,}\b/g) || []);
      if (nums.length) return { line: lines[j], nums };
    }
    return { line: '', nums: [] };
  }

  // Weitere bezahlte Stunden außer Stundenlohn (Urlaub, Krank, Feiertag, Sonstiges)
  const ABWESENHEIT = ['urlaubStd', 'krankStd', 'feiertagStd', 'sonstigeStd'];
  const sumAbw = r => ABWESENHEIT.reduce((s, f) => s + (r[f] || 0), 0);
  const bezahltErwartet = r => r.zeitlohnStd + (r.ueberstd || 0) + (r.azkAbbau || 0) + sumAbw(r);

  function parse(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const all = lines.join('\n');
    const r = {
      art: 'lohn', monat: null, jahr: null, abrechnungsdatum: null,
      stundenlohn: null, stundensatz: null, fahrgeldStd: null, azkAbbau: null, azkAufbau: null, ueberstundenLohnart: null,
      urlaubStd: null, krankStd: null, feiertagStd: null, sonstigeStd: null,
      verpflegungEuro: null, verpflegung: [],
      azkStand: null,
      urlaubAnspruch: null, urlaubGenommen: null, urlaubRest: null,
      zeitlohnStd: null, ueberstd: null, bezahltStd: null,
      lohnarten: [], warnungen: [],
    };
    const add = (f, v) => { r[f] = Math.round(((r[f] || 0) + v) * 100) / 100; };

    // Abrechnungsmonat ("für Oktober 2026"; bei schlechten Fotos wird "für" oft verlesen)
    const monRe = new RegExp(`(${MONATE.join('|')})\\s+(20\\d\\d)`, 'i');
    const m = all.match(new RegExp(`f\\S{1,2}r\\s+${monRe.source}`, 'i')) || all.match(monRe);
    if (m) {
      const i = MONATE.indexOf(m[1].toLowerCase());
      if (i >= 0) { r.monat = i + 1; r.jahr = parseInt(m[2], 10); }
    }
    const d = all.match(/\b(\d{2}\.\d{2}\.20\d\d)\b/);
    if (d) r.abrechnungsdatum = d[1];

    // Lohnarten mit Einheit Std (OCR liest "Std" auch als "Sta", "5td", "Sid" …)
    for (const raw of lines) {
      const l = fixDigits(raw);
      const la = l.match(/^\W{0,3}(\d{4})\s+(.+?)\s+[S5s][tfi][dao4l]\.?\s+(\d{1,3}(?:\.\d{3})*,\d{2})(?:\s+(\d{1,3}[,/.]\d{2}))?/i);
      if (!la) continue;
      const nr = la[1];
      const bez = la[2].trim();
      const menge = deNum(la[3]);
      r.lohnarten.push({ nr, bezeichnung: bez, menge });
      const b = bez.toLowerCase();
      if (/zuschl/.test(b)) continue; // Zuschläge sind keine zusätzlichen Stunden
      if (nr === '1000' || /stundenlohn/.test(b)) {
        add('stundenlohn', menge);
        const f = la[4] && deNum(la[4].replace('/', ','));
        if (f) r.stundensatz = f;
      } else if (/fahrgeld|fahrzeit/.test(b)) add('fahrgeldStd', menge);
      else if (/abbau.*(arbeitszeit|azk)/.test(b)) add('azkAbbau', menge);
      else if (/aufbau.*(arbeitszeit|azk)|zuf[üu]hrung/.test(b)) add('azkAufbau', menge);
      else if (/[üu]berstund|mehrarbeit/.test(b)) add('ueberstundenLohnart', menge);
      else if (/urlaub/.test(b)) add('urlaubStd', menge);
      else if (/krank/.test(b)) add('krankStd', menge);
      else if (/feiertag/.test(b)) add('feiertagStd', menge);
      else add('sonstigeStd', menge);
    }

    // Verpflegungsmehraufwand (z.B. "2045 Verpflegungsmehraufw 14€ stpfl ... 56,00"): Betrag am Zeilenende.
    // Ein Betrag zählt nur, wenn er ein Vielfaches des Tagessatzes ist – so fallen verlesene Zahlen auf.
    const gesehen = new Set();
    let verpflUnsicher = false;
    for (const raw of lines) {
      const l = fixDigits(raw);
      const v = l.match(/^\W{0,3}(\d{4})\s+(.*verpfl.*?)\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s*\W{0,3}$/i);
      if (!v || gesehen.has(v[1])) continue;
      gesehen.add(v[1]);
      const betrag = deNum(v[3]);
      const satzM = v[2].match(/\b(\d{1,2})\s*(?:€|e|eur)/i);
      const satz = satzM ? parseInt(satzM[1], 10) : null;
      if (satz && Math.abs(betrag / satz - Math.round(betrag / satz)) > 0.001) { verpflUnsicher = true; continue; }
      r.verpflegung.push({ nr: v[1], satz, betrag, tage: satz ? Math.round(betrag / satz) : null });
      add('verpflegungEuro', betrag);
    }
    if (verpflUnsicher) r.verpflegungEuro = null;

    // Arbeitszeitkonto-Stand ("AZK-Std. 4,25-")
    const azk = all.match(/AZK[-\s]?Std\.?\s*:?\s*(-?\d{1,4}(?:\.\d{3})*,\d{2}\s*-?)/i);
    if (azk) r.azkStand = deNum(azk[1]);

    // Urlaub (Anspruch | genommen | Rest): drei Kopfwerte mit 3-4 Ziffern, bei denen Anspruch − genommen = Rest
    const passendesTripel = cand => {
      for (let i = cand.length - 3; i >= 0; i--) {
        const [a, g, rest] = cand.slice(i, i + 3).map(implied);
        if (Math.abs(a - g - rest) < 0.01 && a <= 60) return [a, g, rest];
      }
      return null;
    };
    const kopfZahlen = l => (fixDigits(l).match(/\b\d{3,4}\b/g) || []);
    let triple = null;
    const ui = findLineIndex(lines, /resturlaub|anspr/i);
    if (ui >= 0) {
      const { nums } = numbersBelow(lines, ui);
      const cand = nums.filter(n => n.length >= 3 && n.length <= 4);
      triple = passendesTripel(cand) || (cand.length >= 3 ? cand.slice(-3).map(implied) : null);
      if (!triple && cand.length === 2) [r.urlaubAnspruch, r.urlaubRest] = cand.map(implied);
    }
    if (!triple) {
      // Überschrift nicht erkannt: in den ersten Zeilen nach einem stimmigen Tripel suchen
      for (const l of lines.slice(0, 15)) { triple = passendesTripel(kopfZahlen(l)); if (triple) break; }
    }
    if (triple) [r.urlaubAnspruch, r.urlaubGenommen, r.urlaubRest] = triple;

    // Zeitlohn Std. | Überstd. | Bez. Std. – Werte darunter bzw. in der Zeile mit der Steuer-ID (11 Ziffern)
    const setzeZeitlohn = cand => {
      if (cand.length >= 3) [r.zeitlohnStd, r.ueberstd, r.bezahltStd] = cand.slice(-3).map(implied);
      else if (cand.length === 2) [r.zeitlohnStd, r.bezahltStd] = cand.map(implied);
      else if (cand.length === 1) r.bezahltStd = implied(cand[0]);
    };
    const zi = findLineIndex(lines, /zeitlohn|bez\.?\s*std|[üu]berstd/i);
    let zCand = [];
    if (zi >= 0) zCand = numbersBelow(lines, zi).nums.filter(n => n.length >= 3 && n.length <= 6);
    if (!zCand.length) {
      const sid = lines.slice(0, 15).find(l => /\b\d{11}\b/.test(fixDigits(l)));
      if (sid) zCand = (fixDigits(sid).replace(/\b\d{11}\b/, '').match(/\b\d{3,6}\b/g) || []);
    }
    setzeZeitlohn(zCand);

    pruefe(r);
    return r;
  }

  // Plausibilitätsprüfungen (setzt r.warnungen neu)
  function pruefe(r) {
    r.warnungen = [];
    const near = (a, b) => Math.abs(a - b) < 0.01;
    if (r.monat == null) r.warnungen.push('Abrechnungsmonat nicht erkannt.');
    if (r.stundenlohn == null) r.warnungen.push('Lohnart „Stundenlohn“ nicht erkannt.');
    if (r.urlaubAnspruch != null && r.urlaubGenommen != null && r.urlaubRest != null &&
        !near(r.urlaubAnspruch - r.urlaubGenommen, r.urlaubRest)) {
      r.warnungen.push('Urlaub: Anspruch minus genommen ergibt nicht den Resturlaub. Bitte prüfen.');
    }
    if (r.zeitlohnStd != null && r.stundenlohn != null &&
        !near(r.zeitlohnStd, r.stundenlohn + (r.fahrgeldStd || 0))) {
      r.warnungen.push('Zeitlohn-Stunden passen nicht zu Stundenlohn + Fahrgeld. Bitte prüfen.');
    }
    if (r.bezahltStd != null && r.zeitlohnStd != null && !near(r.bezahltStd, bezahltErwartet(r))) {
      r.warnungen.push('Bezahlte Stunden passen nicht zu Zeitlohn + Urlaub/Krank/Feiertag + Überstunden + AZK-Abbau. Bitte prüfen.');
    }
    return r;
  }

  const FELDER = ['monat', 'jahr', 'abrechnungsdatum', 'stundenlohn', 'stundensatz', 'fahrgeldStd', 'azkAbbau', 'azkAufbau',
    'ueberstundenLohnart', 'urlaubStd', 'krankStd', 'feiertagStd', 'sonstigeStd', 'verpflegungEuro', 'azkStand',
    'urlaubAnspruch', 'urlaubGenommen', 'urlaubRest', 'zeitlohnStd', 'ueberstd', 'bezahltStd'];

  // Mehrere Erkennungsdurchläufe zusammenführen: pro Feld gewinnt der häufigste Wert, bei Gleichstand der frühere Durchlauf.
  function zusammenfuehren(results) {
    const out = Object.assign({}, results[0]);
    for (const f of FELDER) {
      const counts = new Map();
      results.forEach((r, i) => {
        if (r[f] == null) return;
        const k = String(r[f]);
        const c = counts.get(k) || { v: r[f], n: 0, first: i };
        c.n++;
        counts.set(k, c);
      });
      const best = Array.from(counts.values()).sort((a, b) => b.n - a.n || a.first - b.first)[0];
      out[f] = best ? best.v : null;
      out['_' + f + 'Sicher'] = best ? best.n >= 2 || results.length === 1 : false;
    }
    const vq = results.find(r => r.verpflegungEuro === out.verpflegungEuro);
    out.verpflegung = vq && vq.verpflegung ? vq.verpflegung : [];
    // Zusammengehörige Werte, die sich gegenseitig bestätigen, gemeinsam aus einem stimmigen Durchlauf nehmen
    const near = (a, b) => Math.abs(a - b) < 0.01;
    const GRUPPEN = [
      [['urlaubAnspruch', 'urlaubGenommen', 'urlaubRest'], r => near(r.urlaubAnspruch - r.urlaubGenommen, r.urlaubRest)],
      [['stundenlohn', 'zeitlohnStd'], r => near(r.zeitlohnStd, r.stundenlohn + (r.fahrgeldStd || 0))],
      [['zeitlohnStd', 'bezahltStd'], r => near(r.bezahltStd, bezahltErwartet(r))],
    ];
    for (const [felder, ok] of GRUPPEN) {
      const probe = Object.assign({}, out);
      if (felder.every(f => out[f] != null) && ok(probe)) continue;
      const passend = results.find(r => felder.every(f => r[f] != null) && ok(Object.assign({}, out, felder.reduce((o, f) => (o[f] = r[f], o), {}))));
      if (passend) felder.forEach(f => { out[f] = passend[f]; out['_' + f + 'Sicher'] = true; });
    }
    return pruefe(out);
  }

  const api = { parseLohnzettel: parse, pruefe, zusammenfuehren, deNum, ABWESENHEIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LohnParser = api;
})(typeof self !== 'undefined' ? self : this);
