'use strict';
/*
 * Liest ein "Stundenerfassungsblatt" (Wochenzettel-PDF) aus.
 * Eingabe: Textstücke mit Position {x, y, str} (y von oben gemessen, PDF-Punkte, Seite A4 = 595 x 842).
 * Ausgabe: Kopfdaten, Einträge pro Tag und Summen.
 */
(function (root) {
  // Spaltengrenzen (linker Rand in PDF-Punkten) – das Formular ist immer gleich aufgebaut.
  const COLS = [
    ['tag', 0], ['mehr', 80], ['mind', 105], ['prod', 127], ['unprod', 155], ['garantie', 177],
    ['erschwernis', 198], ['ausloese', 222], ['fahrt', 252], ['bereitschaft', 278],
    ['kostentraeger', 305], ['beschreibung', 334], ['von', 445], ['bis', 480], ['pause', 515],
  ];
  const NUM_COLS = ['mehr', 'mind', 'prod', 'unprod', 'garantie', 'erschwernis', 'ausloese', 'fahrt', 'bereitschaft', 'pause'];
  const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag/'];

  function colOf(x) {
    let name = COLS[0][0];
    for (const [n, left] of COLS) if (x >= left - 2) name = n;
    return name;
  }

  function num(s) {
    if (s == null) return 0;
    const m = String(s).replace(/\s|€/g, '').replace(/\./g, '').replace(',', '.').match(/^[+-]?\d+(\.\d+)?$/);
    return m ? parseFloat(m[0]) : 0;
  }

  function groupLines(items, tol) {
    const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(it.y - last.y) <= tol) last.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    return lines;
  }

  function kategorie(e) {
    const b = (e.beschreibung || '').toLowerCase();
    if (/krank/.test(b)) return 'krank';
    if (/urlaub/.test(b)) return 'urlaub';
    if (/feiertag/.test(b)) return 'feiertag';
    if (/^gz\b|gleitzeit|freizeitausgleich/.test(b)) return 'gleitzeit';
    if (/lehrgang|schulung|seminar|unterweisung/.test(b)) return 'lehrgang';
    if (e.kostentraeger && e.prod > 0) return 'baustelle';
    if (e.prod > 0) return 'arbeit';
    if (e.unprod > 0) return 'unproduktiv';
    return 'sonstiges';
  }

  function parse(items) {
    const txt = items.filter(i => i.str && i.str.trim()).map(i => ({ x: i.x, y: i.y, str: i.str.trim() }));
    const find = re => txt.find(i => re.test(i.str));
    const rightOf = (label, maxDx = 120) => {
      const l = find(label);
      if (!l) return null;
      const cand = txt.filter(i => Math.abs(i.y - l.y) < 3 && i.x > l.x + 1 && i.x - l.x < maxDx && !/←/.test(i.str))
        .sort((a, b) => a.x - b.x);
      return cand[0] ? cand[0].str : null;
    };

    if (!find(/Stundenerfassungsblatt/)) throw new Error('Das sieht nicht wie ein Stundenerfassungsblatt aus.');

    const jahr = parseInt(rightOf(/^Jahr:$/), 10) || null;
    const kw = parseInt(rightOf(/^Kalenderwoche:$/), 10) || null;
    const vom = rightOf(/^vom:$/);
    const bis = rightOf(/^bis:$/, 60);
    const personalnummer = rightOf(/^Personalnummer:$/);
    const name = rightOf(/^Name:$/);

    const dayLabels = DAY_NAMES.map(n => txt.find(i => i.str === n && i.x < 80)).filter(Boolean);
    const summe = find(/^Summe$/);
    const saldoLbl = find(/^Saldo$/);
    if (dayLabels.length < 5 || !summe) throw new Error('Die Tageszeilen wurden nicht gefunden.');

    const tage = [];
    const tableItems = txt.filter(i => i.y >= dayLabels[0].y - 3 && i.y < summe.y - 3);
    dayLabels.forEach((lbl, idx) => {
      const yEnd = idx + 1 < dayLabels.length ? dayLabels[idx + 1].y - 3 : summe.y - 3;
      const inDay = tableItems.filter(i => i.y >= lbl.y - 3 && i.y < yEnd);
      const datumItem = inDay.find(i => i.x < 80 && /^\d{1,2}\.\d{1,2}\./.test(i.str));
      let datum = null;
      if (datumItem && jahr) {
        const [d, m] = datumItem.str.split('.').map(Number);
        datum = `${jahr}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
      const eintraege = [];
      for (const line of groupLines(inDay.filter(i => i.x >= 80), 3)) {
        const e = { kostentraeger: '', beschreibung: '', von: '', bis: '' };
        NUM_COLS.forEach(c => { e[c] = 0; });
        for (const it of line.items) {
          const c = colOf(it.x);
          if (NUM_COLS.includes(c)) e[c] = num(it.str);
          else if (c !== 'tag') e[c] = e[c] ? e[c] + ' ' + it.str : it.str;
        }
        e.kategorie = kategorie(e);
        eintraege.push(e);
      }
      const isWE = lbl.str.startsWith('Samstag');
      tage.push({
        tag: isWE ? 'Samstag/Sonntag' : lbl.str,
        datum,
        eintraege,
        summe: {
          mehr: eintraege.reduce((s, e) => s + e.mehr, 0),
          mind: eintraege.reduce((s, e) => s + e.mind, 0),
          prod: eintraege.reduce((s, e) => s + e.prod, 0),
          unprod: eintraege.reduce((s, e) => s + e.unprod, 0),
        },
        kategorien: Array.from(new Set(eintraege.map(e => e.kategorie))),
      });
    });

    // Summenzeile
    const summen = {};
    NUM_COLS.forEach(c => { summen[c] = 0; });
    txt.filter(i => Math.abs(i.y - summe.y) < 3 && i.x < summe.x - 2).forEach(i => {
      const c = colOf(i.x);
      if (NUM_COLS.includes(c)) summen[c] = num(i.str);
    });
    let saldo = null;
    if (saldoLbl) {
      const s = txt.find(i => Math.abs(i.y - saldoLbl.y) < 3 && i.x > saldoLbl.x + 10 && /^[+-]?\d/.test(i.str));
      if (s) saldo = num(s.str);
    }
    const kreuz = (label) => {
      const l = find(label);
      return !!(l && txt.find(i => Math.abs(i.y - l.y) < 4 && i.x > l.x + 40 && i.x < l.x + 140 && /^x$/i.test(i.str)));
    };

    // Kontrolle: stimmen die Tageswerte mit der Summenzeile überein?
    const r = v => Math.round(v * 100) / 100;
    const calc = { mehr: 0, mind: 0, prod: 0, unprod: 0 };
    tage.forEach(t => Object.keys(calc).forEach(k => { calc[k] += t.summe[k]; }));
    const warnungen = [];
    Object.keys(calc).forEach(k => {
      if (r(calc[k]) !== r(summen[k])) warnungen.push(`Summe ${k}: Tage ergeben ${r(calc[k])}, Zettel sagt ${r(summen[k])}`);
    });

    return {
      art: 'woche', jahr, kw, vom, bis, personalnummer, name,
      tage, summen, saldo,
      mehrstundenVerguetet: kreuz(/^Mehrstunden vergüten$/),
      mehrstundenGesammelt: kreuz(/^Mehrstunden sammeln$/),
      warnungen,
    };
  }

  const api = { parseWochenzettel: parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WochenParser = api;
})(typeof self !== 'undefined' ? self : this);
