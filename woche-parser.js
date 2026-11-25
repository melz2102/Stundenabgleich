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

    let jahr = parseInt(rightOf(/^Jahr:$/), 10) || null;
    const kw = parseInt(rightOf(/^Kalenderwoche:$/), 10) || null;
    const vom = rightOf(/^vom:$/);
    const bis = rightOf(/^bis:$/, 60);
    // Jahr nicht eingetragen? Dann aus "vom:" (Jahr des Donnerstags = Jahr der Kalenderwoche)
    const vomM = vom && vom.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!jahr && vomM) jahr = new Date(+vomM[3], +vomM[2] - 1, +vomM[1] + 3, 12).getFullYear();
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
      // Bevorzugt aus "vom:" (Montag) berechnen – klappt auch, wenn das Jahr fehlt oder die Woche über Silvester geht
      const vm = vom && vom.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (vm) {
        const dt = new Date(+vm[3], +vm[2] - 1, +vm[1] + idx, 12);
        datum = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      } else if (datumItem && jahr) {
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

  /*
   * Excel-Version desselben Formulars ("Stundenerfassung Monteure", .xls/.xlsx).
   * Eingabe: Zeilen als Array von Arrays mit Rohwerten (Zahlen bleiben Zahlen, Datum/Uhrzeit als Excel-Seriennummer).
   */
  const EXCEL_HEADER = [
    [/^mehr/i, 'mehr'], [/^mind/i, 'mind'], [/^prod/i, 'prod'], [/^un-?\s*prod|^un-/i, 'unprod'], [/^ga-?\s*rantie|^ga-/i, 'garantie'],
    [/^er-?\s*schwer|^er-/i, 'erschwernis'], [/^aus-?\s*l|^aus-/i, 'ausloese'], [/^ver-?\s*g|fahr/i, 'fahrt'], [/^bereit/i, 'bereitschaft'],
    [/^kosten/i, 'kostentraeger'], [/^beschreibung/i, 'beschreibung'],
  ];
  const DAY_ROWS = ['montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];

  function excelDate(v) {
    if (typeof v !== 'number') return null;
    const ms = Math.round((v - 25569) * 86400000);
    const d = new Date(ms);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  }
  const fmtD = d => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const isoD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function excelTime(v) {
    if (typeof v !== 'number' || v <= 0 || v >= 1) return '';
    const min = Math.round(v * 1440);
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }
  const xnum = v => (typeof v === 'number' ? Math.round(v * 100) / 100 : num(v));
  const xstr = v => (v == null ? '' : String(v).trim());

  function parseExcel(rows) {
    const cell = (r, c) => (rows[r] ? rows[r][c] : null);
    const findCell = re => {
      for (let r = 0; r < rows.length; r++) for (let c = 0; c < (rows[r] || []).length; c++) {
        if (typeof rows[r][c] === 'string' && re.test(rows[r][c].trim())) return { r, c };
      }
      return null;
    };
    const rightValue = (pos, test = v => v !== null && v !== '' && xstr(v) !== '') => {
      if (!pos) return null;
      for (let c = pos.c + 1; c < (rows[pos.r] || []).length; c++) if (test(rows[pos.r][c])) return { v: rows[pos.r][c], c };
      return null;
    };

    if (!findCell(/^Stundenerfassungsblatt/i)) throw new Error('Das sieht nicht wie ein Stundenerfassungsblatt aus.');

    // Kopf
    const vomPos = findCell(/^vom:?$/i);
    const vomCell = rightValue(vomPos, v => typeof v === 'number');
    const vomDate = vomCell ? excelDate(vomCell.v) : null;
    const bisCell = vomCell ? rightValue({ r: vomPos.r, c: vomCell.c }, v => typeof v === 'number') : null;
    const bisDate = bisCell ? excelDate(bisCell.v) : null;
    const kwCell = rightValue(findCell(/^Kalenderwoche/i), v => typeof v === 'number');
    const jahrCell = rightValue(findCell(/^Jahr:?$/i), v => typeof v === 'number');
    const persCell = rightValue(findCell(/^Personalnummer/i));
    const nameCell = rightValue(findCell(/^Name:?$/i));
    let jahr = jahrCell ? jahrCell.v : null;
    if (!jahr && vomDate) jahr = new Date(vomDate.getTime() + 3 * 86400000).getFullYear();

    // Spalten über die Überschriften zuordnen
    const hdr = findCell(/^Mehr/i);
    if (!hdr) throw new Error('Die Spaltenüberschriften wurden nicht gefunden.');
    const cols = {};
    (rows[hdr.r] || []).forEach((v, c) => {
      const s = xstr(v).replace(/\s+/g, ' ');
      const hit = EXCEL_HEADER.find(([re]) => re.test(s));
      if (hit && !(hit[1] in cols)) cols[hit[1]] = c;
    });
    for (let r = hdr.r; r <= hdr.r + 2; r++) (rows[r] || []).forEach((v, c) => {
      const s = xstr(v).toLowerCase();
      if (s === 'von') cols.von = c; else if (s === 'bis') cols.bis = c; else if (s.startsWith('pause')) cols.pause = c;
    });

    // Tagesblöcke über Spalte A
    const starts = [];
    for (let r = hdr.r + 1; r < rows.length; r++) {
      const a = xstr(cell(r, 0)).toLowerCase();
      const i = DAY_ROWS.findIndex(n => a.startsWith(n));
      if (i >= 0 && !starts.some(s => s.i === i)) starts.push({ i, r });
    }
    const summePos = findCell(/^Summe$/i);
    const endRow = summePos ? summePos.r : rows.length;
    if (starts.length < 5) throw new Error('Die Tageszeilen wurden nicht gefunden.');

    const tage = starts.map((s, k) => {
      const to = k + 1 < starts.length ? starts[k + 1].r : endRow;
      const eintraege = [];
      for (let r = s.r; r < to; r++) {
        const e = { kostentraeger: '', beschreibung: '', von: '', bis: '' };
        NUM_COLS.forEach(c => { e[c] = cols[c] != null ? xnum(cell(r, cols[c])) : 0; });
        e.kostentraeger = cols.kostentraeger != null ? xstr(cell(r, cols.kostentraeger)) : '';
        e.beschreibung = cols.beschreibung != null ? xstr(cell(r, cols.beschreibung)) : '';
        e.von = cols.von != null ? excelTime(cell(r, cols.von)) : '';
        e.bis = cols.bis != null ? excelTime(cell(r, cols.bis)) : '';
        const leer = NUM_COLS.every(c => c === 'pause' || !e[c]) && !e.kostentraeger && !e.beschreibung && !e.von;
        if (leer) continue;
        e.kategorie = kategorie(e);
        eintraege.push(e);
      }
      let datum = null;
      if (vomDate) datum = isoD(new Date(vomDate.getTime() + s.i * 86400000));
      const isWE = s.i === 5;
      return {
        tag: isWE ? 'Samstag/Sonntag' : ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'][s.i],
        datum, eintraege,
        summe: ['mehr', 'mind', 'prod', 'unprod'].reduce((o, k2) => { o[k2] = Math.round(eintraege.reduce((a, e) => a + e[k2], 0) * 100) / 100; return o; }, {}),
        kategorien: Array.from(new Set(eintraege.map(e => e.kategorie))),
      };
    });

    // Summenzeile, Saldo, Kreuze
    const summen = {};
    NUM_COLS.forEach(c => { summen[c] = summePos && cols[c] != null ? xnum(cell(summePos.r, cols[c])) : 0; });
    let saldo = null;
    const saldoPos = findCell(/^Saldo/i);
    if (saldoPos) {
      for (let c = 0; c < (rows[saldoPos.r] || []).length; c++) if (typeof rows[saldoPos.r][c] === 'number') { saldo = xnum(rows[saldoPos.r][c]); break; }
    }
    if (saldo == null) saldo = Math.round((summen.mehr + summen.mind) * 100) / 100;
    const kreuz = re => {
      const p = findCell(re);
      if (!p) return false;
      for (let r = p.r; r <= p.r + 1; r++) for (let c = p.c + 1; c < (rows[r] || []).length; c++) if (/^x$/i.test(xstr(cell(r, c)))) return true;
      return false;
    };

    const r2 = v => Math.round(v * 100) / 100;
    const warnungen = [];
    ['mehr', 'mind', 'prod', 'unprod'].forEach(k => {
      const t = r2(tage.reduce((a, d) => a + d.summe[k], 0));
      if (summePos && t !== r2(summen[k])) warnungen.push(`Summe ${k}: Tage ergeben ${t}, Zettel sagt ${r2(summen[k])}`);
    });

    return {
      art: 'woche', quelle: 'excel', jahr, kw: kwCell ? kwCell.v : null,
      vom: vomDate ? fmtD(vomDate) : null, bis: bisDate ? fmtD(bisDate) : null,
      personalnummer: persCell ? xstr(persCell.v) : null, name: nameCell ? xstr(nameCell.v) : null,
      tage, summen, saldo,
      mehrstundenVerguetet: kreuz(/^Mehrstunden vergüten/i),
      mehrstundenGesammelt: kreuz(/^Mehrstunden sammeln/i),
      warnungen,
    };
  }

  const api = { parseWochenzettel: parse, parseWochenzettelExcel: parseExcel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WochenParser = api;
})(typeof self !== 'undefined' ? self : this);
