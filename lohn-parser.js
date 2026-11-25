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
    return s.replace(/(?<=\d)[Oo](?=\d|\b)/g, '0').replace(/(?<=\d)[lI|](?=\d)/g, '1');
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

  function parse(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const all = lines.join('\n');
    const r = {
      art: 'lohn', monat: null, jahr: null, abrechnungsdatum: null,
      stundenlohn: null, stundensatz: null, fahrgeldStd: null, azkAbbau: null, azkAufbau: null, ueberstundenLohnart: null,
      azkStand: null,
      urlaubAnspruch: null, urlaubGenommen: null, urlaubRest: null,
      zeitlohnStd: null, ueberstd: null, bezahltStd: null,
      lohnarten: [], warnungen: [],
    };

    // Abrechnungsmonat
    const m = all.match(/f[üu]r\s+([A-Za-zäÄ]+)\s+(20\d\d)/i);
    if (m) {
      const i = MONATE.indexOf(m[1].toLowerCase().replace('maerz', 'märz'));
      if (i >= 0) { r.monat = i + 1; r.jahr = parseInt(m[2], 10); }
    }
    const d = all.match(/\b(\d{2}\.\d{2}\.20\d\d)\b/);
    if (d) r.abrechnungsdatum = d[1];

    // Lohnarten mit Einheit Std
    for (const raw of lines) {
      const l = fixDigits(raw);
      const la = l.match(/^\W{0,3}(\d{4})\s+(.+?)\s+[S5s]td\.?\s+(\d{1,3}(?:\.\d{3})*,\d{2})(?:\s+(\d{1,3}[,/.]\d{2}))?/i);
      if (!la) continue;
      const nr = la[1];
      const bez = la[2].trim();
      const menge = deNum(la[3]);
      r.lohnarten.push({ nr, bezeichnung: bez, menge });
      const b = bez.toLowerCase();
      if (nr === '1000' || /stundenlohn/.test(b)) {
        r.stundenlohn = (r.stundenlohn || 0) + menge;
        const f = la[4] && deNum(la[4].replace('/', ','));
        if (f) r.stundensatz = f;
      } else if (/fahrgeld|fahrzeit/.test(b)) r.fahrgeldStd = (r.fahrgeldStd || 0) + menge;
      else if (/abbau.*(arbeitszeit|azk)/.test(b)) r.azkAbbau = (r.azkAbbau || 0) + menge;
      else if (/aufbau.*(arbeitszeit|azk)|zuf[üu]hrung/.test(b)) r.azkAufbau = (r.azkAufbau || 0) + menge;
      else if (/[üu]berstund|mehrarbeit/.test(b) && !/zuschl/.test(b)) r.ueberstundenLohnart = (r.ueberstundenLohnart || 0) + menge;
    }

    // Arbeitszeitkonto-Stand ("AZK-Std. 4,25-")
    const azk = all.match(/AZK[-\s]?Std\.?\s*:?\s*(-?\d{1,4}(?:\.\d{3})*,\d{2}\s*-?)/i);
    if (azk) r.azkStand = deNum(azk[1]);

    // Urlaub: Überschrift "... Url. Anspr. | Url.Tg.gen. | Resturlaub", Werte in der Zeile darunter (letzte 3 Zahlen)
    const ui = findLineIndex(lines, /resturlaub|anspr/i);
    if (ui >= 0) {
      const { nums } = numbersBelow(lines, ui);
      // Urlaubswerte sind 3-4 Ziffern (z.B. 2700 = 27,00 Tage); Personalnummer/Geburtsdatum fallen so heraus
      const cand = nums.filter(n => n.length >= 3 && n.length <= 4);
      let triple = null;
      for (let i = cand.length - 3; i >= 0; i--) {
        const [a, g, rest] = cand.slice(i, i + 3).map(implied);
        if (Math.abs(a - g - rest) < 0.01) { triple = [a, g, rest]; break; }
      }
      if (!triple && cand.length >= 3) triple = cand.slice(-3).map(implied);
      if (triple) {
        [r.urlaubAnspruch, r.urlaubGenommen, r.urlaubRest] = triple;
      } else if (cand.length === 2) {
        [r.urlaubAnspruch, r.urlaubRest] = cand.map(implied);
      }
    }

    // Zeitlohn Std. | Überstd. | Bez. Std. – Werte darunter, Steuer-ID (11 Ziffern) wird übersprungen
    const zi = findLineIndex(lines, /zeitlohn|bez\.?\s*std/i);
    if (zi >= 0) {
      const { nums } = numbersBelow(lines, zi);
      const cand = nums.filter(n => n.length >= 3 && n.length <= 6);
      if (cand.length >= 3) [r.zeitlohnStd, r.ueberstd, r.bezahltStd] = cand.slice(-3).map(implied);
      else if (cand.length === 2) [r.zeitlohnStd, r.bezahltStd] = cand.map(implied);
      else if (cand.length === 1) r.bezahltStd = implied(cand[0]);
    }

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
    if (r.bezahltStd != null && r.zeitlohnStd != null &&
        !near(r.bezahltStd, r.zeitlohnStd + (r.ueberstd || 0) + (r.azkAbbau || 0))) {
      r.warnungen.push('Bezahlte Stunden passen nicht zu Zeitlohn + Überstunden + AZK-Abbau. Bitte prüfen.');
    }
    return r;
  }

  const FELDER = ['monat', 'jahr', 'abrechnungsdatum', 'stundenlohn', 'stundensatz', 'fahrgeldStd', 'azkAbbau', 'azkAufbau',
    'ueberstundenLohnart', 'azkStand', 'urlaubAnspruch', 'urlaubGenommen', 'urlaubRest', 'zeitlohnStd', 'ueberstd', 'bezahltStd'];

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
    // Zusammengehörige Werte, die sich gegenseitig bestätigen, gemeinsam aus einem stimmigen Durchlauf nehmen
    const near = (a, b) => Math.abs(a - b) < 0.01;
    const GRUPPEN = [
      [['urlaubAnspruch', 'urlaubGenommen', 'urlaubRest'], r => near(r.urlaubAnspruch - r.urlaubGenommen, r.urlaubRest)],
      [['stundenlohn', 'zeitlohnStd'], r => near(r.zeitlohnStd, r.stundenlohn + (r.fahrgeldStd || 0))],
      [['zeitlohnStd', 'bezahltStd'], r => near(r.bezahltStd, r.zeitlohnStd + (r.ueberstd || 0) + (r.azkAbbau || 0))],
    ];
    for (const [felder, ok] of GRUPPEN) {
      const probe = Object.assign({}, out);
      if (felder.every(f => out[f] != null) && ok(probe)) continue;
      const passend = results.find(r => felder.every(f => r[f] != null) && ok(Object.assign({}, out, felder.reduce((o, f) => (o[f] = r[f], o), {}))));
      if (passend) felder.forEach(f => { out[f] = passend[f]; out['_' + f + 'Sicher'] = true; });
    }
    return pruefe(out);
  }

  const api = { parseLohnzettel: parse, pruefe, zusammenfuehren, deNum };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LohnParser = api;
})(typeof self !== 'undefined' ? self : this);
