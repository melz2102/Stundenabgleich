'use strict';
/*
 * Sicherung und Export – alles läuft auf dem Handy, nichts wird hochgeladen.
 * - Sicherungsdatei (.json) mit allen Zetteln samt Fotos, PDFs und Excel-Dateien.
 *   Ablegen z.B. in iCloud Drive oder Google Drive, auf einem neuen Handy wieder einlesen.
 * - Monatsbericht als PDF (jsPDF)
 * - Alle Stunden als Excel-Datei (SheetJS)
 */
(function () {
  const SICHERUNG_KEY = 'stundenabgleich.letzteSicherung';
  const ART = {
    baustelle: 'Baustelle', arbeit: 'Arbeit', lehrgang: 'Lehrgang', urlaub: 'Urlaub', krank: 'Krank',
    feiertag: 'Feiertag', gleitzeit: 'Gleitzeit (GZ)', unproduktiv: 'Unproduktiv', sonstiges: 'Sonstiges',
  };
  const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const TAG = 86400000;

  const zwei = n => String(n).padStart(2, '0');
  const ausIsoD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const deDatum = dt => `${zwei(dt.getDate())}.${zwei(dt.getMonth() + 1)}.${dt.getFullYear()}`;
  const dateiDatum = () => { const d = new Date(); return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`; };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* privater Modus */ } }

  /* ---------- Fertige Datei anbieten ---------- */
  // Teilen klappt nur direkt nach einem Tipp. Darum wird die Datei erst erstellt und dann mit einem eigenen Knopf geteilt.
  const fertigeDateien = new Map();
  let zaehler = 0;

  function anbieten(box, blob, name, text) {
    const file = new File([blob], name, { type: blob.type });
    const key = 'f' + (++zaehler);
    fertigeDateien.set(key, file);
    const teilbar = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    box.innerHTML = `<div class="notice ok">${text}
      <div class="export-actions">
        ${teilbar ? `<button class="btn small primary" data-ex="teilen" data-key="${key}">Teilen / In Dateien sichern</button>` : ''}
        <button class="btn small${teilbar ? '' : ' primary'}" data-ex="laden" data-key="${key}">Herunterladen</button>
      </div></div>`;
  }

  function herunterladen(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    gespeichert(file);
  }

  function teilen(file) {
    navigator.share({ files: [file], title: file.name }).then(() => gespeichert(file), e => {
      if (e && e.name === 'AbortError') return; // abgebrochen
      herunterladen(file);
    });
  }

  function gespeichert(file) {
    if (/Sicherung.*\.json$/.test(file.name)) {
      lsSet(SICHERUNG_KEY, String(Date.now()));
      Docs.all().then(aktualisiereInfo);
    }
  }

  function fehler(box, e) {
    box.innerHTML = `<div class="notice err">${esc(e && e.message ? e.message : String(e))}</div>`;
  }

  /* ---------- Sicherung ---------- */
  function blobZuDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function sicherungErstellen(box) {
    box.innerHTML = '<div class="notice">Sicherung wird erstellt …</div>';
    try {
      const docs = await Docs.all();
      if (!docs.length) throw new Error('Es sind noch keine Zettel gespeichert.');
      const teile = [`{"app":"Stundenabgleich","format":1,"erstellt":${JSON.stringify(new Date().toISOString())},"anzahl":${docs.length},"docs":[`];
      for (let i = 0; i < docs.length; i++) {
        const d = Object.assign({}, docs[i]);
        d.blob = d.blob instanceof Blob ? await blobZuDataUrl(d.blob) : null;
        teile.push((i ? ',' : '') + JSON.stringify(d));
      }
      teile.push(']}');
      const blob = new Blob(teile, { type: 'application/json' });
      anbieten(box, blob, `Stundenabgleich-Sicherung-${dateiDatum()}.json`,
        `<strong>Sicherung fertig:</strong> ${docs.length} Zettel, ${fmtSize(blob.size)}. Speichere sie in iCloud Drive oder Google Drive. Auf einem neuen Handy liest du sie mit „Sicherung einlesen“ wieder ein.`);
    } catch (e) { fehler(box, e); }
  }

  async function sicherungEinlesen(file, box) {
    box.innerHTML = '<div class="notice">Sicherung wird eingelesen …</div>';
    try {
      let j;
      try { j = JSON.parse(await file.text()); } catch (e) { j = null; }
      if (!j || j.app !== 'Stundenabgleich' || !Array.isArray(j.docs)) throw new Error('Das ist keine Sicherungsdatei dieser App.');
      const vorhanden = new Map((await Docs.all()).map(d => [d.id, d]));
      const stand = d => Math.max(d.checkedAt || 0, d.addedAt || 0);
      let neu = 0, ersetzt = 0, gleich = 0;
      for (const s of j.docs) {
        if (!s || typeof s.id !== 'string' || !['woche', 'lohn'].includes(s.type)) continue;
        const d = Object.assign({}, s);
        d.blob = typeof s.blob === 'string' && s.blob.startsWith('data:') ? await (await fetch(s.blob)).blob() : null;
        if (d.thumb && !/^data:image\//.test(d.thumb)) d.thumb = null;
        const alt = vorhanden.get(d.id);
        if (!alt) { await Docs.add(d); neu++; }
        else if (stand(d) > stand(alt)) { await Docs.add(d); ersetzt++; }
        else gleich++;
      }
      if (typeof repariereAlteZettel === 'function') await repariereAlteZettel();
      const vom = j.erstellt ? ` vom ${deDatum(new Date(j.erstellt))}` : '';
      box.innerHTML = `<div class="notice ok">Sicherung${vom} eingelesen: ${neu} neue Zettel${ersetzt ? `, ${ersetzt} aktualisiert` : ''}${gleich ? `, ${gleich} waren schon da` : ''}.</div>`;
      renderHome();
      renderDocs();
    } catch (e) { fehler(box, e); }
  }

  function aktualisiereInfo(docs) {
    const t = Number(lsGet(SICHERUNG_KEY)) || 0;
    const info = document.getElementById('backup-info');
    if (info) info.textContent = t ? `Letzte Sicherung: ${deDatum(new Date(t))}` : 'Noch keine Sicherung erstellt.';
    const rem = document.getElementById('backup-reminder');
    if (!rem) return;
    const geaendert = docs.some(d => Math.max(d.checkedAt || 0, d.addedAt || 0) > t);
    const faellig = docs.length > 0 && geaendert && (!t || Date.now() - t > 30 * TAG);
    rem.innerHTML = faellig ? `<div class="notice warn-note"><strong>${t ? 'Deine letzte Sicherung ist über einen Monat alt.' : 'Du hast noch keine Sicherung.'}</strong>
      Deine Zettel liegen nur auf diesem Handy. Mit einer Sicherungsdatei in iCloud Drive oder Google Drive gehen sie nicht verloren.
      <div class="export-actions"><button class="btn small primary" data-ex="sicherung">Jetzt sichern</button></div></div>` : '';
  }

  /* ---------- Monatsbericht als PDF ---------- */
  let jspdfPromise = null;
  function loadJspdf() {
    if (!jspdfPromise) {
      jspdfPromise = new Promise((resolve, reject) => {
        if (self.jspdf) return resolve(self.jspdf);
        const s = document.createElement('script');
        s.src = 'vendor/jspdf.umd.min.js';
        s.onload = () => resolve(self.jspdf);
        s.onerror = () => { jspdfPromise = null; reject(new Error('PDF-Erstellung konnte nicht geladen werden. Bitte einmal mit Internet öffnen.')); };
        document.head.appendChild(s);
      });
    }
    return jspdfPromise;
  }

  // Die Standardschrift im PDF kennt nur westeuropäische Zeichen
  const pdfText = s => String(s == null ? '' : s)
    .replace(/[−–—]/g, '-').replace(/[„“”]/g, '"').replace(/[‚‘’]/g, "'")
    .replace(/€/g, 'EUR').replace(/…/g, '...').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
  const z = (v, signed) => (v == null ? '-' : pdfText(zahl(v, signed)));

  function personAusZetteln(docs, jahr, monat) {
    const key = `${jahr}-${zwei(monat)}`;
    const wochen = docs.filter(d => d.type === 'woche' && d.data && (d.data.name || d.data.personalnummer));
    const imMonat = wochen.filter(d => (d.data.tage || []).some(t => t.datum && t.datum.startsWith(key)));
    const d = (imMonat[0] || wochen[0]);
    return d ? { name: d.data.name || '', nr: d.data.personalnummer || '' } : null;
  }

  async function monatsberichtPdf(jahr, monat) {
    const { jsPDF } = await loadJspdf();
    const docs = await Docs.all();
    const r = self.Auswertung.auswerten(docs, jahr, monat);
    const titel = `${MONATE[monat - 1]} ${jahr}`;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const L = 15, R = 195, UNTEN = 280;
    let y = 18;

    const schrift = (gr, fett, farbe) => {
      pdf.setFontSize(gr);
      pdf.setFont('helvetica', fett ? 'bold' : 'normal');
      pdf.setTextColor(...(farbe || [0, 0, 0]));
    };
    const platz = h => { if (y + h > UNTEN) { pdf.addPage(); y = 18; return true; } return false; };
    const linie = (farbe = 200) => { pdf.setDrawColor(farbe); pdf.line(L, y, R, y); };
    const absatz = (s, gr = 9, farbe, breite = R - L, x = L) => {
      schrift(gr, false, farbe);
      const zeilen = pdf.splitTextToSize(pdfText(s), breite);
      const h = zeilen.length * gr * 0.42;
      platz(h);
      pdf.text(zeilen, x, y + gr * 0.32);
      y += h + 1;
    };
    const ueberschrift = s => {
      platz(14);
      y += 6;
      schrift(12, true, [31, 78, 121]);
      pdf.text(pdfText(s), L, y);
      y += 2;
      linie(180);
      y += 4;
    };
    // Tabellenzeile: spalten = [{ x, w, text, align }]
    const zeile = (spalten, opt = {}) => {
      schrift(opt.gr || 9, opt.fett, opt.farbe);
      const teile = spalten.map(s => pdf.splitTextToSize(pdfText(s.text), s.w));
      const n = Math.max(...teile.map(t => t.length));
      const h = n * (opt.gr || 9) * 0.42 + 1.6;
      if (platz(h) && opt.kopf) opt.kopf();
      if (opt.hinterlegt) { pdf.setFillColor(...opt.hinterlegt); pdf.rect(L, y - 1, R - L, h, 'F'); }
      spalten.forEach((s, i) => {
        const x = s.align === 'right' ? s.x + s.w : s.x;
        pdf.text(teile[i], x, y + (opt.gr || 9) * 0.32 + 0.3, { align: s.align || 'left' });
      });
      y += h;
    };
    const kv = (links, rechts, opt) => zeile([{ x: L, w: 120, text: links }, { x: 135, w: 60, text: rechts, align: 'right' }], opt);

    // Kopf
    schrift(18, true, [31, 78, 121]);
    pdf.text(pdfText(`Monatsbericht ${titel}`), L, y);
    y += 7;
    const person = personAusZetteln(docs, jahr, monat);
    if (person && (person.name || person.nr)) {
      schrift(10, false);
      pdf.text(pdfText([person.name, person.nr ? `Personalnummer ${person.nr}` : ''].filter(Boolean).join(' · ')), L, y);
      y += 5;
    }
    schrift(8, false, [110, 110, 110]);
    pdf.text(pdfText(`Erstellt am ${deDatum(new Date())} mit der App Stundenabgleich aus den gespeicherten Wochen- und Lohnzetteln.`), L, y);
    y += 6;

    // Hinweise
    const hinweise = [];
    if (r.fehlendeTage.length) hinweise.push(`Es fehlen Wochenzettel für ${r.fehlendeTage.length} Arbeitstag(e) (KW ${r.fehlendeKW.join(', ')}). Die Werte gelten nur für die erfassten Tage.`);
    if (r.ungeprueft) hinweise.push(`${r.ungeprueft} Wochenzettel noch nicht geprüft.`);
    if (r.lohn && !r.lohnGeprueft) hinweise.push('Der Lohnzettel ist noch nicht geprüft.');
    if (r.lohnLuecke) hinweise.push(`Der Lohnzettel ist nicht vollständig ausgelesen (laut Kopf ${zahl(r.lohnLuecke.bezahlt)} bezahlte Std., erkannt ${zahl(r.lohnLuecke.erkannt)}).`);
    hinweise.forEach(h => absatz('Hinweis: ' + h, 9, [176, 0, 32]));

    // Stunden
    ueberschrift('Stunden laut Wochenzetteln');
    kv('Ist-Stunden', z(r.ist), { fett: true });
    kv(r.vollstaendig ? 'Soll-Stunden' : 'Soll-Stunden (erfasste Tage)', z(r.vollstaendig ? r.soll : r.sollErfasst));
    kv('Saldo', z(r.saldo, true), { fett: true });
    kv('davon produktiv', z(r.prod));
    kv('davon Urlaub, krank, Feiertag', z(r.unprod));
    kv('Mehrstunden', z(r.mehr, true));
    kv('Minderstunden (inkl. Gleitzeit)', z(r.mind));
    if (r.mehrVerguetet) kv('Überstunden zum Auszahlen ("vergüten")', z(r.mehrVerguetet));
    kv('Fürs Arbeitszeitkonto', z(r.saldoGesammelt, true));
    if (r.fahrt) kv('Fahrtätigkeit', `${z(r.fahrt)} Std.`);
    if (r.ausloese) kv('Auslöse / Verpflegung', `${z(r.ausloese)} EUR`);

    ueberschrift('Tage');
    Object.entries(r.tage).filter(([, n]) => n).forEach(([k, n]) => kv(ART[k] || k, String(n)));

    if (r.baustellen.length) {
      ueberschrift('Stunden pro Baustelle');
      r.baustellen.forEach(b => kv(`${b.name || 'ohne Name'}${b.kostentraeger ? ` (${b.kostentraeger})` : ''}`, `${z(b.stunden)} Std. (${b.tage} T.)`));
    }

    // Abgleich
    ueberschrift('Abgleich mit dem Lohnzettel');
    if (!r.lohn) {
      absatz(`Für ${titel} ist noch kein Lohnzettel gespeichert.`, 9, [110, 110, 110]);
    } else {
      const abw = r.abgleich.filter(a => a.status === 'abw').length;
      absatz(abw ? `${abw} Abweichung(en) zwischen Wochenzetteln und Lohnzettel.` : r.vollstaendig ? 'Keine Abweichungen gefunden.' : 'Bisher keine Abweichungen (Monat noch nicht vollständig erfasst).',
        10, abw ? [176, 0, 32] : [20, 110, 50]);
      const kopf = () => zeile([
        { x: L, w: 88, text: 'Punkt' }, { x: 105, w: 28, text: 'Wochenzettel', align: 'right' },
        { x: 135, w: 28, text: 'Lohnzettel', align: 'right' }, { x: 167, w: 28, text: 'Ergebnis' },
      ], { fett: true, gr: 8, farbe: [90, 90, 90] });
      kopf();
      r.abgleich.forEach(a => {
        const farbe = a.status === 'abw' ? [176, 0, 32] : a.status === 'ok' ? [20, 110, 50] : [90, 90, 90];
        platz(10);
        linie(225);
        y += 1.2;
        zeile([
          { x: L, w: 88, text: a.titel }, { x: 105, w: 28, text: z(a.zettel), align: 'right' },
          { x: 135, w: 28, text: z(a.lohn), align: 'right' },
          { x: 167, w: 28, text: a.status === 'ok' ? 'passt' : a.status === 'abw' ? 'Abweichung' : 'Info' },
        ], { farbe, kopf });
        if (a.hinweis) absatz(a.hinweis, 8, [100, 100, 100], R - L - 4, L + 2);
      });
    }

    // Tage im Einzelnen
    platz(40); // Überschrift nicht allein unten auf der Seite
    ueberschrift('Tage im Einzelnen');
    const key = `${jahr}-${zwei(monat)}`;
    const alle = self.Auswertung.sammleTage(docs);
    const fehlend = new Set(r.fehlendeTage);
    const kopfTage = () => zeile([
      { x: L, w: 20, text: 'Datum' }, { x: 36, w: 24, text: 'Art' }, { x: 61, w: 72, text: 'Baustelle / Beschreibung' },
      { x: 134, w: 13, text: 'Std.', align: 'right' }, { x: 148, w: 15, text: 'Mehr/Mind.', align: 'right' },
      { x: 164, w: 15, text: 'Auslöse', align: 'right' }, { x: 180, w: 15, text: 'Fahrt', align: 'right' },
    ], { fett: true, gr: 8, farbe: [90, 90, 90] });
    kopfTage();
    const letzter = new Date(jahr, monat, 0, 12).getDate();
    let gestreift = false;
    for (let tag = 1; tag <= letzter; tag++) {
      const iso = `${key}-${zwei(tag)}`;
      const dt = ausIsoD(iso);
      const t = alle.get(iso);
      const datum = `${WT[dt.getDay()]} ${zwei(tag)}.${zwei(monat)}.`;
      if (t && t.eintraege.length) {
        gestreift = !gestreift;
        t.eintraege.forEach((e, i) => {
          const desc = [e.kostentraeger, e.beschreibung].filter(Boolean).join(' · ');
          const mm = (e.mehr || 0) + (e.mind || 0);
          zeile([
            { x: L, w: 20, text: i === 0 ? datum : '' }, { x: 36, w: 24, text: ART[e.kategorie] || e.kategorie || '' },
            { x: 61, w: 72, text: desc }, { x: 134, w: 13, text: z((e.prod || 0) + (e.unprod || 0)), align: 'right' },
            { x: 148, w: 15, text: mm ? z(mm, true) : '', align: 'right' },
            { x: 164, w: 15, text: e.ausloese ? z(e.ausloese) : '', align: 'right' },
            { x: 180, w: 15, text: e.fahrt ? z(e.fahrt) : '', align: 'right' },
          ], { gr: 8, kopf: kopfTage, hinterlegt: gestreift ? [243, 246, 250] : null });
        });
      } else if (fehlend.has(iso)) {
        zeile([{ x: L, w: 20, text: datum }, { x: 36, w: 150, text: 'Kein Wochenzettel erfasst' }], { gr: 8, farbe: [176, 0, 32], kopf: kopfTage });
      }
    }

    // Fußzeile mit Seitenzahlen
    const seiten = pdf.getNumberOfPages();
    for (let i = 1; i <= seiten; i++) {
      pdf.setPage(i);
      schrift(8, false, [130, 130, 130]);
      pdf.text(pdfText(`Stundenabgleich · Monatsbericht ${titel}`), L, 290);
      pdf.text(`Seite ${i} von ${seiten}`, R, 290, { align: 'right' });
    }
    return pdf.output('blob');
  }

  async function pdfErstellen(box, monatKey) {
    box.innerHTML = '<div class="notice">Monatsbericht wird erstellt …</div>';
    try {
      const [jahr, monat] = monatKey.split('-').map(Number);
      const blob = await monatsberichtPdf(jahr, monat);
      anbieten(box, blob, `Monatsbericht-${jahr}-${zwei(monat)}.pdf`, `<strong>Monatsbericht ${MONATE[monat - 1]} ${jahr} fertig</strong> (${fmtSize(blob.size)}).`);
    } catch (e) { fehler(box, e); }
  }

  /* ---------- Alle Stunden als Excel ---------- */
  async function excelErstellen(box) {
    box.innerHTML = '<div class="notice">Excel-Datei wird erstellt …</div>';
    try {
      const XLSX = await self.Extract.loadXlsx();
      const docs = await Docs.all();
      const tage = Array.from(self.Auswertung.sammleTage(docs).values())
        .filter(t => t.eintraege.length).sort((a, b) => (a.datum < b.datum ? -1 : 1));
      if (!tage.length && !docs.some(d => d.type === 'lohn')) throw new Error('Es sind noch keine Stunden erfasst.');

      // Blatt 1: jeder Eintrag eine Zeile
      const t1 = [['Datum', 'KW', 'Tag', 'Art', 'Kostenträger', 'Beschreibung', 'Prod.-Std.', 'Unprod.-Std.', 'Mehr-Std.', 'Minder-Std.',
        'Auslöse/Verpfl. €', 'Fahrtätigkeit Std.', 'Mehrstunden vergüten', 'Geprüft']];
      for (const t of tage) {
        const dt = ausIsoD(t.datum);
        for (const e of t.eintraege) {
          t1.push([dt, t.kw || null, WT[dt.getDay()], ART[e.kategorie] || e.kategorie || '', e.kostentraeger || '', e.beschreibung || '',
            e.prod || 0, e.unprod || 0, e.mehr || 0, e.mind || 0, e.ausloese || 0, e.fahrt || 0, t.verguetet ? 'ja' : 'nein', t.geprueft ? 'ja' : 'nein']);
        }
      }

      // Blatt 2: Monate mit Auswertung und Abgleich
      const t2 = [['Monat', 'Ist-Std.', 'Soll-Std.', 'Saldo', 'Produktiv', 'Urlaub/Krank/Feiertag', 'Mehr-Std.', 'Minder-Std.', 'Fürs AZK',
        'Vergütete Überstd.', 'Fahrtätigkeit Std.', 'Auslöse €', 'Tage Baustelle', 'Tage Urlaub', 'Tage Krank', 'Tage GZ', 'Fehlende Arbeitstage',
        'Lohnzettel: Stundenlohn', 'Urlaubsstd.', 'Krankstd.', 'AZK-Abbau', 'AZK-Stand', 'Fahrgeld-Std.', 'Verpflegung €', 'Abweichungen']];
      const monate = self.Auswertung.monateMitDaten(docs).slice().sort();
      for (const m of monate) {
        const [j, mo] = m.split('-').map(Number);
        const r = self.Auswertung.auswerten(docs, j, mo);
        const L = r.lohn || {};
        t2.push([`${MONATE[mo - 1]} ${j}`, r.ist, r.vollstaendig ? r.soll : r.sollErfasst, r.saldo, r.prod, r.unprod, r.mehr, r.mind, r.saldoGesammelt,
          r.mehrVerguetet, r.fahrt, r.ausloese, r.tage.baustelle || 0, r.tage.urlaub || 0, r.tage.krank || 0, r.tage.gleitzeit || 0, r.fehlendeTage.length,
          L.stundenlohn ?? null, L.urlaubStd ?? null, L.krankStd ?? null, L.azkAbbau ?? null, L.azkStand ?? null, L.fahrgeldStd ?? null, L.verpflegungEuro ?? null,
          r.lohn ? r.abgleich.filter(a => a.status === 'abw').length : null]);
      }

      // Blatt 3: Lohnzettel
      const felder = [].concat(...LOHN_FELDER.map(([, f]) => f));
      const t3 = [['Monat', 'Status'].concat(felder.map(([, l]) => l))];
      docs.filter(d => d.type === 'lohn' && d.data)
        .sort((a, b) => ((a.data.jahr || 0) * 100 + (a.data.monat || 0)) - ((b.data.jahr || 0) * 100 + (b.data.monat || 0)))
        .forEach(d => t3.push([d.period || d.name, d.status === 'geprueft' ? 'geprüft' : 'nicht geprüft'].concat(felder.map(([k]) => d.data[k] ?? null))));

      const wb = XLSX.utils.book_new();
      const blatt = (rows, breiten, name) => {
        const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'dd\\.mm\\.yyyy' });
        ws['!cols'] = breiten.map(w => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      blatt(t1, [11, 4, 4, 13, 12, 30, 9, 9, 9, 9, 10, 10, 10, 8], 'Tage');
      blatt(t2, [16].concat(Array(24).fill(11)), 'Monate');
      blatt(t3, [16, 12].concat(felder.map(() => 14)), 'Lohnzettel');
      const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      anbieten(box, blob, `Stundenabgleich-Stunden-${dateiDatum()}.xlsx`,
        `<strong>Excel-Datei fertig:</strong> ${t1.length - 1} Einträge, ${monate.length} Monat(e), ${t3.length - 1} Lohnzettel.`);
    } catch (e) { fehler(box, e); }
  }

  /* ---------- Knöpfe ---------- */
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-ex]');
    if (!b) return;
    const art = b.dataset.ex;
    if (art === 'teilen' || art === 'laden') {
      const file = fertigeDateien.get(b.dataset.key);
      if (!file) return;
      if (art === 'teilen') teilen(file); else herunterladen(file);
      return;
    }
    const exportBox = document.getElementById('export-result');
    if (art === 'sicherung') {
      sicherungErstellen(exportBox);
      if (!b.closest('#storage-card')) exportBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (art === 'excel') excelErstellen(exportBox);
    if (art === 'pdf') pdfErstellen(document.getElementById('pdf-result'), b.dataset.monat);
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'in-backup' && e.target.files && e.target.files[0]) {
      sicherungEinlesen(e.target.files[0], document.getElementById('export-result'));
      e.target.value = '';
    }
  });

  self.Export = { aktualisiereInfo, monatsberichtPdf, sicherungErstellen, sicherungEinlesen };
})();
