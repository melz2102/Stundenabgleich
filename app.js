'use strict';

/* ---------- Speicher (IndexedDB, nur auf diesem Gerät) ---------- */
const DB_NAME = 'stundenabgleich';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('docs')) {
          const s = db.createObjectStore('docs', { keyPath: 'id' });
          s.createIndex('type', 'type');
          s.createIndex('addedAt', 'addedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('docs', mode);
    const store = t.objectStore('docs');
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const Docs = {
  add: doc => tx('readwrite', s => reqP(s.put(doc))),
  all: () => tx('readonly', s => reqP(s.getAll())),
  get: id => tx('readonly', s => reqP(s.get(id))),
  remove: id => tx('readwrite', s => reqP(s.delete(id))),
};

/* ---------- Hilfsfunktionen ---------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const TYPE_LABEL = { woche: 'Wochenzettel', lohn: 'Lohnzettel' };
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
}

const STATUS_LABEL = {
  neu: 'Noch nicht ausgelesen',
  ausgelesen: 'Ausgelesen, bitte prüfen',
  geprueft: '✓ Geprüft',
  fehler: 'Auslesen nicht möglich',
};

function fmtH(v, signed) {
  if (v == null || isNaN(v)) return '–';
  const t = Math.abs(v).toFixed(2).replace('.', ',');
  return (v < 0 ? '−' : (signed && v > 0 ? '+' : '')) + t;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/* Zeitraum grob aus dem Dateinamen erraten (z.B. Wochenzettel_2026_KW46_...). Das eigentliche Auslesen folgt in Schritt 2. */
function guessFromName(name) {
  const n = name.toLowerCase();
  const out = {};
  if (n.includes('wochenzettel') || n.includes('stunden')) out.type = 'woche';
  if (n.includes('lohn') || n.includes('abrechnung') || n.includes('brutto')) out.type = 'lohn';
  const kw = name.match(/(20\d\d)[^0-9]{0,3}KW[^0-9]?(\d{1,2})/i) || name.match(/KW[^0-9]?(\d{1,2})[^0-9]{0,3}(20\d\d)/i);
  if (kw) {
    const [year, week] = /KW/i.test(kw[0].slice(0, 3)) ? [kw[2], kw[1]] : [kw[1], kw[2]];
    out.period = `KW ${parseInt(week, 10)}/${year}`;
  }
  return out;
}

async function makeThumb(file) {
  if (!file.type.startsWith('image/')) return null;
  try {
    const bmp = await createImageBitmap(file);
    const w = 120, h = Math.round(bmp.height * (w / bmp.width));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.7);
  } catch (e) {
    return null;
  }
}

/* ---------- Navigation ---------- */
const TITLES = { home: 'Übersicht', add: 'Zettel hinzufügen', docs: 'Meine Zettel', jahr: 'Jahresübersicht' };

function go(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.goto === view));
  $('#title').textContent = TITLES[view];
  $('#add-result').innerHTML = view === 'add' ? $('#add-result').innerHTML : '';
  if (view === 'docs') renderDocs();
  if (view === 'home') renderHome();
  if (view === 'jahr') renderJahr();
  window.scrollTo(0, 0);
}

// Nach dem Speichern die gerade sichtbare Auswertung neu zeichnen
function aktualisiereAnsicht() {
  const aktiv = $('.view.active');
  if (!aktiv) return;
  if (aktiv.id === 'view-home') renderHome();
  if (aktiv.id === 'view-jahr') renderJahr();
}

document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g) go(g.dataset.goto);
});

/* ---------- Hinzufügen ---------- */
let selectedType = 'woche';

$('#type-seg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  selectedType = b.dataset.type;
  $$('#type-seg .seg-btn').forEach(x => {
    x.classList.toggle('active', x === b);
    x.setAttribute('aria-checked', x === b);
  });
});

// Foto eines Wochenzettels (meist handgeschrieben): wird von Hand eingetragen
function isHandWoche(d) {
  return d.type === 'woche' && /^image\//.test(d.mime || '');
}

function isExcelFile(f) {
  return /\.(xlsx?|xlsm)$/i.test(f.name || '') || /spreadsheet|ms-excel/.test(f.type || '');
}

// Excel-Stundenzettel: jedes Blatt mit einem Stundenerfassungsblatt wird ein eigener Wochenzettel
async function handleExcel(file, out) {
  let wochen = [];
  let fehler = '';
  try {
    wochen = await self.Extract.readWochenzettelExcel(file);
  } catch (e) {
    fehler = e.message || String(e);
  }
  if (!wochen.length) {
    out.insertAdjacentHTML('beforeend', `<div class="notice err">„${esc(file.name)}“ konnte nicht ausgelesen werden: ${esc(fehler || 'kein Stundenerfassungsblatt gefunden.')}</div>`);
    return;
  }
  for (const { data, blatt } of wochen) {
    const doc = {
      id: uid(), type: 'woche', name: file.name, sheet: blatt,
      mime: file.type || 'application/vnd.ms-excel', size: file.size, addedAt: Date.now(),
      period: data.kw && data.jahr ? `KW ${data.kw}/${data.jahr}` : null,
      thumb: null, blob: file, status: 'ausgelesen', data,
    };
    try {
      await Docs.add(doc);
      out.insertAdjacentHTML('beforeend', `<div class="notice ok">✓ Als <strong>Wochenzettel</strong> gespeichert: ${esc(doc.period || doc.name)}
        <br>Ausgelesen aus Excel: ${data.tage.filter(t => t.eintraege.length).length} Tage, ${fmtH(data.summen.prod + data.summen.unprod)} Std., Saldo ${fmtH(data.saldo, true)}.
        <div style="margin-top:8px"><button class="btn small primary" data-review="${doc.id}">Jetzt prüfen</button></div></div>`);
    } catch (e) {
      out.insertAdjacentHTML('beforeend', `<div class="notice err">„${esc(file.name)}“ konnte nicht gespeichert werden: ${esc(e.message || e)}</div>`);
    }
  }
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const out = $('#add-result');
  out.innerHTML = '';
  for (const file of files) {
    if (isExcelFile(file)) {
      await handleExcel(file, out);
      continue;
    }
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isImg = file.type.startsWith('image/');
    if (!isPdf && !isImg) {
      out.insertAdjacentHTML('beforeend', `<div class="notice err">„${esc(file.name)}“ ist kein Foto, kein PDF und keine Excel-Datei und wurde nicht gespeichert.</div>`);
      continue;
    }
    const guess = guessFromName(file.name);
    const doc = {
      id: uid(),
      type: guess.type || selectedType,
      name: file.name || (isPdf ? 'Dokument.pdf' : 'Foto.jpg'),
      mime: isPdf ? 'application/pdf' : file.type,
      size: file.size,
      addedAt: Date.now(),
      period: guess.period || null,
      thumb: await makeThumb(file),
      blob: file,
      status: 'neu', // 'ausgelesen', 'geprueft', 'fehler'
    };
    let readMsg = '';
    if (doc.type === 'woche' && isPdf) {
      try {
        const data = await self.Extract.readWochenzettel(file);
        doc.data = data;
        if (data.kw && data.jahr) doc.period = `KW ${data.kw}/${data.jahr}`;
        doc.status = 'ausgelesen';
        readMsg = `<br>Ausgelesen: ${data.tage.filter(t => t.eintraege.length).length} Tage, ${fmtH(data.summen.prod + data.summen.unprod)} Std., Saldo ${fmtH(data.saldo, true)}.`;
      } catch (e) {
        doc.status = 'fehler';
        doc.readError = e.message || String(e);
        readMsg = `<br>Auslesen nicht möglich: ${esc(doc.readError)}`;
      }
    } else if (doc.type === 'woche') {
      readMsg = '<br>Handgeschriebene Zettel trägst du selbst ein. Das Foto siehst du dabei, die Tage sind schon mit dem Soll vorausgefüllt.';
    } else if (doc.type === 'lohn') {
      const prog = document.createElement('div');
      prog.className = 'notice';
      prog.textContent = `Lese Lohnzettel „${doc.name}“ … das kann bis zu einer Minute dauern.`;
      out.appendChild(prog);
      try {
        const data = await self.Extract.readLohnzettel(file, pct => {
          prog.textContent = `Lese Lohnzettel … ${pct} %`;
        });
        doc.data = data;
        if (data.monat && data.jahr) doc.period = `${MONATE[data.monat - 1]} ${data.jahr}`;
        doc.status = 'ausgelesen';
        readMsg = `<br>Ausgelesen: ${fmtH(data.bezahltStd)} bezahlte Std., Arbeitszeitkonto ${fmtH(data.azkStand, true)}, Resturlaub ${fmtH(data.urlaubRest)} Tage.`
          + (data.warnungen.length ? ` <strong>${data.warnungen.length} Hinweis(e), bitte prüfen.</strong>` : '');
      } catch (e) {
        doc.status = 'fehler';
        doc.readError = e.message || String(e);
        readMsg = `<br>Auslesen nicht möglich: ${esc(doc.readError)}`;
      }
      prog.remove();
    }
    try {
      await Docs.add(doc);
      out.insertAdjacentHTML('beforeend', `<div class="notice ok">✓ Als <strong>${TYPE_LABEL[doc.type]}</strong> gespeichert: ${esc(doc.period || doc.name)}${readMsg}
        ${doc.data ? `<div style="margin-top:8px"><button class="btn small primary" data-review="${doc.id}">Jetzt prüfen</button></div>`
          : isHandWoche(doc) ? `<div style="margin-top:8px"><button class="btn small primary" data-review="${doc.id}">Jetzt eintragen</button></div>` : ''}</div>`);
    } catch (e) {
      out.insertAdjacentHTML('beforeend', `<div class="notice err">„${esc(file.name)}“ konnte nicht gespeichert werden: ${esc(e.message || e)}</div>`);
    }
  }
  out.insertAdjacentHTML('beforeend', `<button class="btn" data-goto="docs">Zu meinen Zetteln</button>`);
}

['#in-camera', '#in-file'].forEach(sel => {
  $(sel).addEventListener('change', async e => {
    await handleFiles(e.target.files);
    e.target.value = '';
  });
});

/* ---------- Liste ---------- */
let filter = 'alle';

$('#filter-seg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  filter = b.dataset.filter;
  $$('#filter-seg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
  renderDocs();
});

// Kalender-Einordnung: Montag der Woche bzw. Abrechnungsmonat eines Zettels
function mittag(y, m, d) { return new Date(y, m, d, 12); }
function plusTage(dt, n) { return mittag(dt.getFullYear(), dt.getMonth(), dt.getDate() + n); }
function montagDerWoche(dt) { return plusTage(dt, 1 - (dt.getDay() || 7)); }
function monatKey(dt) { return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; }
function kwVon(dt) {
  const t = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}
const kurzDatum = dt => `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.`;

function wocheMontag(d) {
  const w = d.data || {};
  let m = (w.vom || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return montagDerWoche(mittag(+m[3], +m[2] - 1, +m[1]));
  const t = (w.tage || []).find(x => x.datum);
  if (t) { const [y, mo, da] = t.datum.split('-').map(Number); return montagDerWoche(mittag(y, mo - 1, da)); }
  m = (d.period || '').match(/KW (\d+)\/(\d{4})/);
  if (m) return plusTage(montagDerWoche(mittag(+m[2], 0, 4)), (+m[1] - 1) * 7);
  return null;
}

// Eine Woche gehört zu dem Monat, in dem ihr Mittwoch liegt (dort sind die meisten Arbeitstage)
function einordnen(d) {
  if (d.type === 'woche') {
    const mo = wocheMontag(d);
    if (!mo) return null;
    return { key: monatKey(plusTage(mo, 2)), sort: mo.getTime(), montag: mo };
  }
  if (d.type === 'lohn' && d.data && d.data.jahr && d.data.monat) {
    const ende = mittag(d.data.jahr, d.data.monat, 0);
    return { key: monatKey(ende), sort: ende.getTime() + 1 };
  }
  return null;
}

const isoVon = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
const ausIso = s => { const [y, m, d] = s.split('-').map(Number); return mittag(y, m - 1, d); };

// Arbeitstage (Mo–Fr, ISO-Datum), die ein Wochenzettel abdeckt. Am Monatswechsel gibt es oft zwei Zettel
// für eine Woche (z.B. 31.08. und 01.–04.09.), jeder deckt dann nur seinen Teil ab.
function wocheArbeitstage(d) {
  const tage = ((d.data && d.data.tage) || []).map(t => t.datum).filter(Boolean)
    .filter(x => { const wd = ausIso(x).getDay(); return wd >= 1 && wd <= 5; });
  if (tage.length) return Array.from(new Set(tage)).sort();
  const mo = wocheMontag(d);
  return mo ? [0, 1, 2, 3, 4].map(i => isoVon(plusTage(mo, i))) : [];
}

// Alle Wochen mit mindestens einem Arbeitstag im Monat, jeweils nur mit den Tagen dieses Monats
function wochenAbschnitte(key) {
  const [y, m] = key.split('-').map(Number);
  const out = [];
  for (let mo = montagDerWoche(mittag(y, m - 1, 1)); mo <= mittag(y, m, 0); mo = plusTage(mo, 7)) {
    const tage = [0, 1, 2, 3, 4].map(i => plusTage(mo, i)).filter(t => t.getMonth() === m - 1).map(isoVon);
    if (tage.length) out.push({ montag: mo, tage });
  }
  return out;
}

function zeitraumText(isoTage) {
  if (!isoTage.length) return '';
  const a = ausIso(isoTage[0]), b = ausIso(isoTage[isoTage.length - 1]);
  if (isoTage.length === 1) return kurzDatum(a);
  return a.getMonth() === b.getMonth() ? `${String(a.getDate()).padStart(2, '0')}.–${kurzDatum(b)}` : `${kurzDatum(a)}–${kurzDatum(b)}`;
}

function monateZwischen(von, bis) {
  const out = [];
  let [y, m] = von.split('-').map(Number);
  const [y2, m2] = bis.split('-').map(Number);
  while (y < y2 || (y === y2 && m <= m2)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function docItemHtml(d, dup) {
  const wt = d.type === 'woche' ? wocheArbeitstage(d) : [];
  const titel = wt.length
    ? `KW ${kwVon(ausIso(wt[0]))} · ${zeitraumText(wt)}`
    : d.type === 'lohn' && d.period ? `Lohnzettel ${d.period}` : (d.period || d.name);
  const statusText = isHandWoche(d) && d.status === 'neu' ? 'Noch nicht eingetragen' : (STATUS_LABEL[d.status] || esc(d.status));
  const pruefKnopf = d.data
    ? `<button class="chk ${d.status === 'geprueft' ? 'on' : ''}" data-act="check">${d.status === 'geprueft' ? '✓ Geprüft' : '○ Als geprüft markieren'}</button>`
    : `<div class="doc-meta status-${d.status}">${statusText}</div>`;
  return `
    <li class="doc" data-id="${d.id}">
      ${d.thumb ? `<img class="thumb" src="${d.thumb}" alt="">` : `<div class="thumb">${isExcelFile({ name: d.name, type: d.mime }) ? 'XLS' : 'PDF'}</div>`}
      <div class="doc-info">
        <div class="doc-name">${esc(titel)}</div>
        <div class="doc-meta"><span class="badge">${TYPE_LABEL[d.type]}</span>${dup ? '<span class="badge warn">doppelt</span>' : ''}${fmtDate(d.addedAt)} · ${fmtSize(d.size)}</div>
        ${pruefKnopf}
      </div>
      <div class="doc-actions">
        ${isHandWoche(d) ? `<button class="btn small primary" data-review="${d.id}">${d.data ? 'Bearbeiten' : 'Eintragen'}</button>`
          : d.data || d.type === 'lohn' ? `<button class="btn small primary" data-review="${d.id}">Prüfen</button>` : ''}
        <button class="btn small" data-act="open">Ansehen</button>
        <button class="btn small danger" data-act="del">Löschen</button>
      </div>
    </li>`;
}

async function renderDocs() {
  const docs = await Docs.all();
  const shown = docs.filter(d => filter === 'alle' || d.type === filter);
  const list = $('#doc-list');
  const heute = mittag(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  const heuteIso = isoVon(heute);
  const wTage = new Map(docs.filter(d => d.type === 'woche').map(d => [d.id, wocheArbeitstage(d)]));

  // Wochenzettel erscheinen in jedem Monat, in dem sie Tage abdecken; Lohnzettel im Abrechnungsmonat
  const ohneDatum = [];
  const proMonat = new Map();
  const push = (key, x) => { if (!proMonat.has(key)) proMonat.set(key, []); proMonat.get(key).push(x); };
  for (const d of shown) {
    if (d.type === 'woche') {
      const t = wTage.get(d.id);
      if (!t.length) { ohneDatum.push(d); continue; }
      for (const key of new Set(t.map(x => x.slice(0, 7)))) push(key, { d, sort: ausIso(t.find(x => x.startsWith(key))).getTime() });
      continue;
    }
    const o = einordnen(d);
    if (!o) { ohneDatum.push(d); continue; }
    push(o.key, { d, sort: o.sort });
  }

  // Lückenlos alle Monate zwischen dem ersten und letzten Wochenzettel zeigen
  const wochenMonate = Array.from(new Set([].concat(...wTage.values()).map(x => x.slice(0, 7)))).sort();
  const zeigeLuecken = filter !== 'lohn' && wochenMonate.length > 0;
  let monate = Array.from(proMonat.keys());
  if (zeigeLuecken) monate = Array.from(new Set(monate.concat(monateZwischen(wochenMonate[0], wochenMonate[wochenMonate.length - 1]))));
  monate.sort().reverse();

  // Doppelt = zwei Zettel für dieselben Tage (zwei Teilwochen am Monatswechsel sind nicht doppelt)
  const doppelt = (d, liste) => liste.some(x => x.d !== d && wTage.get(x.d.id).some(t => wTage.get(d.id).includes(t)));

  let html = '';
  if (ohneDatum.length) {
    html += `<li class="month-head">Noch ohne Datum <span>${ohneDatum.length}</span></li>`;
    html += ohneDatum.sort((a, b) => b.addedAt - a.addedAt).map(d => docItemHtml(d, false)).join('');
  }
  for (const key of monate) {
    const [y, m] = key.split('-').map(Number);
    const eintraege = (proMonat.get(key) || []).sort((a, b) => a.sort - b.sort || a.d.addedAt - b.d.addedAt);
    const zeilen = [];
    let vorhanden = 0;
    let soll = 0;
    if (zeigeLuecken) {
      for (const ab of wochenAbschnitte(key)) {
        const dieseWoche = eintraege.filter(x => x.d.type === 'woche' && wTage.get(x.d.id).some(t => ab.tage.includes(t)));
        const vergangen = ab.tage.filter(t => t <= heuteIso);
        if (!dieseWoche.length && !vergangen.length) continue; // Woche liegt noch in der Zukunft
        soll++;
        const abgedeckt = new Set([].concat(...dieseWoche.map(x => wTage.get(x.d.id))));
        const fehlen = vergangen.filter(t => !abgedeckt.has(t));
        if (dieseWoche.length && !fehlen.length) vorhanden++;
        dieseWoche.forEach(x => zeilen.push(docItemHtml(x.d, doppelt(x.d, dieseWoche))));
        if (fehlen.length) {
          zeilen.push(`<li class="doc missing"><div class="doc-info"><div class="doc-name">KW ${kwVon(ab.montag)} · ${zeitraumText(fehlen)}</div>
            <div class="doc-meta neg-text">${dieseWoche.length ? 'Zettel für diese Tage fehlt' : 'Wochenzettel fehlt'}</div></div>
            <div class="doc-actions"><button class="btn small" data-goto="add">Hinzufügen</button></div></li>`);
        }
      }
      eintraege.filter(x => x.d.type !== 'woche').forEach(x => zeilen.push(docItemHtml(x.d, false)));
    } else {
      eintraege.forEach(x => zeilen.push(docItemHtml(x.d, false)));
    }
    if (!zeilen.length) continue;
    html += `<li class="month-head">${MONATE[m - 1]} ${y}${zeigeLuecken && soll ? ` <span>${vorhanden} von ${soll} Wochen</span>` : ''}</li>` + zeilen.join('');
  }
  list.innerHTML = html;
  $('#doc-empty').style.display = shown.length ? 'none' : 'block';
}

$('#doc-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.closest('.doc').dataset.id;
  if (b.dataset.act === 'open') openViewer(id);
  if (b.dataset.act === 'check') {
    const d = await Docs.get(id);
    if (!d || !d.data) return;
    if (d.status === 'geprueft') { d.status = 'ausgelesen'; d.checkedAt = null; }
    else { d.status = 'geprueft'; d.checkedAt = Date.now(); }
    await Docs.add(d);
    renderDocs();
  }
  if (b.dataset.act === 'del') {
    if (b.dataset.confirm) {
      await Docs.remove(id);
      renderDocs();
    } else {
      // Zweiter Tipp bestätigt das Löschen (kein Browser-Dialog nötig)
      b.dataset.confirm = '1';
      b.textContent = 'Wirklich?';
      setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = 'Löschen'; } }, 3000);
    }
  }
});

/* ---------- Anzeige ---------- */
let viewerUrl = null;

async function openViewer(id) {
  const d = await Docs.get(id);
  if (!d) return;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(d.blob);
  $('#viewer-title').textContent = d.name;
  if (isExcelFile({ name: d.name, type: d.mime })) {
    $('#viewer-body').innerHTML = '<p class="muted center">Lade Tabelle …</p>';
    $('#viewer').showModal();
    try {
      $('#viewer-body').innerHTML = `<div class="sheet-view">${await self.Extract.excelHtml(d.blob, d.sheet)}</div>`;
    } catch (e) {
      $('#viewer-body').innerHTML = `<p class="notice err">Tabelle kann nicht angezeigt werden: ${esc(e.message || e)}</p>`;
    }
    return;
  }
  $('#viewer-body').innerHTML = d.mime === 'application/pdf'
    ? `<iframe src="${viewerUrl}" title="${esc(d.name)}"></iframe><p class="center"><a href="${viewerUrl}" target="_blank" rel="noopener">PDF in neuem Fenster öffnen</a></p>`
    : `<img src="${viewerUrl}" alt="${esc(d.name)}">`;
  $('#viewer').showModal();
}

$('#viewer-close').addEventListener('click', () => $('#viewer').close());

/* ---------- Prüfen und Korrigieren ---------- */
const KAT_LABEL = {
  baustelle: 'Baustelle', arbeit: 'Arbeit (ohne Baustelle)', lehrgang: 'Lehrgang', krank: 'Krank', urlaub: 'Urlaub',
  feiertag: 'Feiertag', gleitzeit: 'Gleitzeit (GZ)', unproduktiv: 'Unproduktiv', sonstiges: 'Sonstiges',
};
const UNPROD_KAT = ['krank', 'urlaub', 'feiertag', 'unproduktiv'];
let reviewId = null;

function numIn(v) {
  const n = parseFloat(String(v).replace('−', '-').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function inVal(v) {
  return v || v === 0 ? String(v).replace('.', ',') : '';
}

// Geldbetrag aus einem Eingabefeld: "1.787,17" oder "1787,17" oder "1787.17"
function geldIn(v) {
  let t = String(v).replace(/[€\s]/g, '').replace('−', '-');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}
const geldVal = v => (v == null ? '' : v.toFixed(2).replace('.', ','));
const eur = v => self.Auswertung.eur(v);

const LOHN_FELDER = [
  ['Stunden', [
    ['stundenlohn', 'Stundenlohn (Lohnart 1000), Std.'],
    ['urlaubStd', 'Urlaubsstunden'],
    ['krankStd', 'Krankstunden'],
    ['feiertagStd', 'Feiertagsstunden'],
    ['sonstigeStd', 'Sonstige bezahlte Std. (andere Lohnarten)'],
    ['fahrgeldStd', 'Fahrgeld, Std.'],
    ['verpflegungEuro', 'Verpflegung (alle Sätze zusammen), €'],
    ['zeitlohnStd', 'Zeitlohn Std. (Kopf)'],
    ['ueberstd', 'Überstunden (Kopf)'],
    ['azkAbbau', 'Abbau Arbeitszeitkonto, Std.'],
    ['azkAufbau', 'Aufbau Arbeitszeitkonto, Std.'],
    ['bezahltStd', 'Bezahlte Std. (Kopf)'],
  ]],
  ['Arbeitszeitkonto', [
    ['azkStand', 'AZK-Stand (Hinweise), Std.'],
  ]],
  ['Urlaub', [
    ['urlaubAnspruch', 'Urlaubsanspruch, Tage'],
    ['urlaubGenommen', 'Urlaub genommen, Tage'],
    ['urlaubRest', 'Resturlaub, Tage'],
  ]],
];

function openReviewLohn(d) {
  const r = d.data;
  const monate = MONATE.map((m, i) => `<option value="${i + 1}"${r.monat === i + 1 ? ' selected' : ''}>${m}</option>`).join('');
  const groups = LOHN_FELDER.map(([titel, felder]) => `
    <div class="day"><div class="day-head"><strong>${titel}</strong></div>
      ${felder.map(([k, l]) => `<label class="field">${l}<input inputmode="decimal" data-lf="${k}" value="${r[k] == null ? '' : inVal(r[k])}"></label>`).join('')}
    </div>`).join('');
  const posten = r.posten || [];
  const postenHtml = posten.length ? `
    <div class="day"><div class="day-head"><strong>Geldbeträge</strong></div>
      <p class="muted small">Satz und Betrag je Lohnart wie auf dem Lohnzettel. Die Stunden kommen aus den Feldern oben.</p>
      ${posten.map((p, i) => `
        <div class="posten">
          <div class="posten-titel">${esc(p.nr)} ${esc(p.bezeichnung)}${p.std && p.menge != null ? ` <span class="muted small">· ${fmtH(p.menge)} Std.</span>` : ''}</div>
          <div class="entry-grid two">
            ${p.std ? `<label class="field">Satz, € pro Std.<input inputmode="decimal" data-pf="${i}:satz" value="${geldVal(p.satz)}"></label>` : '<span></span>'}
            <label class="field">Betrag, €<input inputmode="decimal" data-pf="${i}:betrag" value="${geldVal(p.betrag)}"></label>
          </div>
        </div>`).join('')}
    </div>` : '';
  // Hinweise immer frisch berechnen (z.B. wenn Urlaubsstunden fehlen, passen die bezahlten Stunden nicht)
  const warnungen = self.LohnParser.pruefe(Object.assign({}, r)).warnungen;
  const kannNeuLesen = d.blob && (/^image\//.test(d.mime || '') || /pdf/.test(d.mime || ''));
  $('#viewer-title').textContent = 'Prüfen: ' + (d.period || d.name);
  $('#viewer-body').innerHTML = `
    <div class="review">
      ${warnungen.length ? `<div class="notice err">${warnungen.map(esc).join('<br>')}${kannNeuLesen ? '<br>Tipp: „Neu auslesen“ liest das Foto mit der neuesten App-Version noch einmal.' : ''}</div>` : ''}
      ${d.readError ? `<div class="notice err">Automatisches Auslesen hat nicht geklappt: ${esc(d.readError)}<br>Du kannst die Werte hier von Hand eintragen.</div>` : ''}
      <p class="muted small">Vergleiche die Werte mit deinem Lohnzettel. Leere Felder kommen auf dem Zettel nicht vor. ${r.quelle === 'foto' ? 'Bei Fotos verliest sich die Erkennung manchmal, also bitte genau hinschauen.' : ''}</p>
      <div class="day"><div class="day-head"><strong>Abrechnungsmonat</strong></div>
        <div class="entry-grid two">
          <label class="field">Monat<select data-lf="monat"><option value="">–</option>${monate}</select></label>
          <label class="field">Jahr<input inputmode="numeric" data-lf="jahr" value="${r.jahr || ''}"></label>
        </div>
      </div>
      ${groups}
      ${postenHtml}
      ${r.rohtext ? `<details class="small"><summary class="muted">Erkannter Text anzeigen</summary><pre class="rohtext">${esc(r.rohtext)}</pre></details>` : ''}
      <div class="review-actions">
        <button class="btn" data-review-open="${d.id}">Zettel ansehen</button>
        ${kannNeuLesen ? `<button class="btn" data-reread="${d.id}">Neu auslesen</button>` : ''}
        <button class="btn primary" id="review-save">✓ Geprüft, speichern</button>
      </div>
    </div>`;
  if (!$('#viewer').open) $('#viewer').showModal();
}

// Lohnzettel mit der aktuellen Erkennung noch einmal auslesen (ersetzt die bisherigen Werte)
async function neuAuslesen(id, btn) {
  const d = await Docs.get(id);
  if (!d || !d.blob) return;
  $$('#viewer-body button').forEach(b => { b.disabled = true; });
  btn.textContent = 'Lese … 0 %';
  try {
    const file = new File([d.blob], d.name || 'lohnzettel', { type: d.mime || d.blob.type || '' });
    const data = await self.Extract.readLohnzettel(file, pct => { btn.textContent = `Lese … ${pct} %`; });
    d.data = data;
    d.readError = null;
    d.status = 'ausgelesen';
    d.checkedAt = null;
    if (data.monat && data.jahr) d.period = `${MONATE[data.monat - 1]} ${data.jahr}`;
    await Docs.add(d);
    openReviewLohn(d);
    renderDocs();
  } catch (e) {
    $$('#viewer-body button').forEach(b => { b.disabled = false; });
    btn.textContent = 'Neu auslesen';
    $('#viewer-body .review').insertAdjacentHTML('afterbegin', `<div class="notice err">Neu auslesen hat nicht geklappt: ${esc(e.message || String(e))}</div>`);
  }
}

async function saveReviewLohn(d) {
  const r = d.data || self.LohnParser.parseLohnzettel('');
  $$('#viewer-body [data-lf]').forEach(el => {
    const v = el.value.trim();
    const k = el.dataset.lf;
    if (k === 'monat' || k === 'jahr') r[k] = v ? parseInt(v, 10) : null;
    else r[k] = v === '' ? null : numIn(v);
  });
  $$('#viewer-body [data-pf]').forEach(el => {
    const [i, k] = el.dataset.pf.split(':');
    const p = (r.posten || [])[+i];
    if (!p) return;
    const v = el.value.trim();
    const n = v === '' ? null : geldIn(v);
    if (n !== p[k]) { p[k] = n; if (k === 'satz') delete p.satzBerechnet; }
  });
  self.LohnParser.mengenAbgleichen(r);
  self.LohnParser.pruefe(r);
  // Verpflegung von Hand geändert: Aufteilung nach Tagessätzen passt dann nicht mehr
  const vSumme = (r.verpflegung || []).reduce((s, v) => s + v.betrag, 0);
  if (r.verpflegungEuro == null || Math.abs(vSumme - r.verpflegungEuro) > 0.01) r.verpflegung = [];
  d.data = r;
  if (r.monat && r.jahr) d.period = `${MONATE[r.monat - 1]} ${r.jahr}`;
  d.readError = null;
  d.status = 'geprueft';
  d.checkedAt = Date.now();
  await Docs.add(d);
  $('#viewer').close();
  renderDocs();
  aktualisiereAnsicht();
}

async function openReview(id) {
  const d = await Docs.get(id);
  if (!d) return;
  if (isHandWoche(d)) return self.openManualWeek(id);
  if (d.type === 'lohn') {
    if (!d.data) d.data = self.LohnParser.parseLohnzettel('');
    reviewId = id;
    return openReviewLohn(d);
  }
  if (!d.data) return;
  reviewId = id;
  const w = d.data;
  const dayHtml = w.tage.map((t, ti) => {
    const datum = t.datum ? new Date(t.datum + 'T12:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '';
    const rows = t.eintraege.length ? t.eintraege.map((e, ei) => `
      <div class="entry" data-t="${ti}" data-e="${ei}">
        <select data-f="kategorie">${Object.entries(KAT_LABEL).map(([k, l]) => `<option value="${k}"${k === e.kategorie ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <div class="entry-grid">
          <label>Stunden<input inputmode="decimal" data-f="std" value="${inVal(e.prod + e.unprod)}"></label>
          <label>Mehr<input inputmode="decimal" data-f="mehr" value="${inVal(e.mehr)}"></label>
          <label>Minder<input inputmode="decimal" data-f="mind" value="${inVal(e.mind)}"></label>
        </div>
        <input data-f="beschreibung" value="${esc([e.kostentraeger, e.beschreibung].filter(Boolean).join(' · '))}" placeholder="Baustelle / Beschreibung">
      </div>`).join('') : '<div class="muted small">kein Eintrag</div>';
    return `<div class="day"><div class="day-head"><strong>${esc(t.tag)}</strong> <span class="muted">${datum}</span></div>${rows}</div>`;
  }).join('');

  $('#viewer-title').textContent = 'Prüfen: ' + (d.period || d.name);
  $('#viewer-body').innerHTML = `
    <div class="review">
      ${w.warnungen && w.warnungen.length ? `<div class="notice err">${w.warnungen.map(esc).join('<br>')}</div>` : ''}
      <div class="card small">
        Zeitraum ${esc(w.vom || '')} bis ${esc(w.bis || '')}<br>
        Summe laut Zettel: ${fmtH(w.summen.prod)} produktive + ${fmtH(w.summen.unprod)} unproduktive Std.<br>
        Saldo <strong>${fmtH(w.saldo, true)}</strong> · Mehrstunden: ${w.mehrstundenGesammelt ? 'sammeln (Arbeitszeitkonto)' : w.mehrstundenVerguetet ? 'vergüten' : 'nichts angekreuzt'}
      </div>
      <p class="muted small">Vergleiche mit dem Zettel und korrigiere, falls etwas falsch erkannt wurde.</p>
      ${dayHtml}
      <div class="review-actions">
        <button class="btn" data-review-open="${d.id}">Zettel ansehen</button>
        <button class="btn primary" id="review-save">✓ Geprüft, speichern</button>
      </div>
    </div>`;
  if (!$('#viewer').open) $('#viewer').showModal();
}

async function saveReview() {
  const d = await Docs.get(reviewId);
  if (!d) return;
  if (d.type === 'lohn') return saveReviewLohn(d);
  const w = d.data;
  $$('#viewer-body .entry').forEach(el => {
    const e = w.tage[+el.dataset.t].eintraege[+el.dataset.e];
    const get = f => el.querySelector(`[data-f="${f}"]`).value;
    e.kategorie = get('kategorie');
    const std = numIn(get('std'));
    if (UNPROD_KAT.includes(e.kategorie)) { e.unprod = std; e.prod = 0; } else { e.prod = std; e.unprod = 0; }
    e.mehr = numIn(get('mehr'));
    e.mind = numIn(get('mind'));
    const desc = get('beschreibung').trim();
    const m = desc.match(/^(\d{4,})\s*·?\s*(.*)$/);
    if (m) { e.kostentraeger = m[1]; e.beschreibung = m[2]; } else { e.kostentraeger = ''; e.beschreibung = desc; }
  });
  w.tage.forEach(t => {
    t.summe = ['mehr', 'mind', 'prod', 'unprod'].reduce((o, k) => { o[k] = t.eintraege.reduce((s, e) => s + e[k], 0); return o; }, {});
    t.kategorien = Array.from(new Set(t.eintraege.map(e => e.kategorie)));
  });
  d.status = 'geprueft';
  d.checkedAt = Date.now();
  await Docs.add(d);
  $('#viewer').close();
  renderDocs();
}

document.addEventListener('click', e => {
  const r = e.target.closest('[data-review]');
  if (r) { openReview(r.dataset.review); return; }
  const o = e.target.closest('[data-review-open]');
  if (o) { $('#viewer').close(); openViewer(o.dataset.reviewOpen); return; }
  const rr = e.target.closest('[data-reread]');
  if (rr) { neuAuslesen(rr.dataset.reread, rr); return; }
  if (e.target.id === 'review-save') saveReview();
});



/* ---------- Monatsauswertung ---------- */
let gewaehlterMonat = null;

const KAT_TAGE = [
  ['baustelle', 'Baustelle'], ['arbeit', 'Arbeit (ohne Baustelle)'], ['lehrgang', 'Lehrgang'], ['urlaub', 'Urlaub'],
  ['krank', 'Krank'], ['feiertag', 'Feiertag'], ['gleitzeit', 'Gleitzeit (GZ)'],
];

function zahl(v, signed) {
  if (v == null) return '–';
  return fmtH(v, signed).replace(/,00$/, '');
}

async function renderAuswertung(docs) {
  const box = $('#auswertung');
  const monate = self.Auswertung.monateMitDaten(docs);
  if (!monate.length) {
    box.innerHTML = `
      <div class="card">
        <h2>Monatsauswertung</h2>
        <p class="muted">Sobald du Wochenzettel oder Lohnzettel hochlädst, siehst du hier pro Monat Gesamtstunden, Überstunden, Baustellen-, Kranken- und Urlaubstage und den Abgleich mit dem Lohnzettel.</p>
        <button class="btn primary" data-goto="add">Zettel hinzufügen</button>
      </div>`;
    return;
  }
  if (!gewaehlterMonat || !monate.includes(gewaehlterMonat)) gewaehlterMonat = monate[0];
  const [jahr, monat] = gewaehlterMonat.split('-').map(Number);
  const r = self.Auswertung.auswerten(docs, jahr, monat);

  const auswahl = `<select id="monat-wahl" class="monat-wahl">${monate.map(m => {
    const [j, mm] = m.split('-').map(Number);
    return `<option value="${m}"${m === gewaehlterMonat ? ' selected' : ''}>${MONATE[mm - 1]} ${j}</option>`;
  }).join('')}</select>`;

  const hinweise = [];
  if (r.fehlendeKW.length) {
    hinweise.push(`Es fehlen Wochenzettel für ${r.fehlendeTage.length} Arbeitstag(e) (KW ${r.fehlendeKW.join(', ')}). Die Werte unten gelten nur für die erfassten Tage.`);
  }
  if (r.ungeprueft) hinweise.push(`${r.ungeprueft} Wochenzettel noch nicht geprüft.`);
  if (r.lohn && !r.lohnGeprueft) hinweise.push('Der Lohnzettel ist noch nicht geprüft.');

  const tageHtml = KAT_TAGE.filter(([k]) => r.tage[k] || ['baustelle', 'urlaub', 'krank'].includes(k))
    .map(([k, l]) => `<div class="kv"><span>${l}</span><strong>${r.tage[k]}</strong></div>`).join('');

  const bsHtml = r.baustellen.length ? r.baustellen.map(b => `
    <div class="kv"><span>${esc(b.name || 'ohne Name')}${b.kostentraeger ? ` <span class="muted small">${esc(b.kostentraeger)}</span>` : ''}</span>
      <strong>${zahl(b.stunden)} Std. <span class="muted small">(${b.tage} T.)</span></strong></div>`).join('')
    : '<p class="muted small">Keine Baustellenstunden erfasst.</p>';

  let abgleichHtml;
  if (!r.lohn) {
    abgleichHtml = `<p class="muted">Für ${MONATE[monat - 1]} ${jahr} ist noch kein Lohnzettel gespeichert. Die Abrechnung kommt meist Mitte des Folgemonats.</p>
      <button class="btn" data-goto="add">Lohnzettel hinzufügen</button>`;
  } else {
    const abw = r.abgleich.filter(a => a.status === 'abw').length;
    abgleichHtml = `
      ${r.lohnLuecke ? `<div class="notice err"><strong>Lohnzettel nicht vollständig ausgelesen.</strong> Laut Kopf sind ${fmtH(r.lohnLuecke.bezahlt)} Std. bezahlt, erkannt wurden nur ${fmtH(r.lohnLuecke.erkannt)}. Meist fehlen Urlaubs- oder Krankstunden, daher stimmen die Abweichungen unten nicht.
        <div style="margin-top:8px"><button class="btn small primary" data-review="${r.lohnId}">Lohnzettel prüfen</button></div></div>` : ''}
      <div class="notice ${abw ? 'err' : r.vollstaendig ? 'ok' : ''}">${abw ? `<strong>${abw} Abweichung(en)</strong> zwischen Wochenzetteln und Lohnzettel.`
        : r.vollstaendig ? 'Keine Abweichungen gefunden.'
        : 'Bisher keine Abweichungen. Stundenlohn, Urlaub, Krank und Arbeitszeitkonto kann ich erst vergleichen, wenn alle Wochenzettel des Monats da sind.'}</div>
      <div class="abgleich">
        <div class="ab-head"><span></span><span>Wochenzettel</span><span>Lohnzettel</span></div>
        ${r.abgleich.map(a => `
          <div class="ab-row ab-${a.status}">
            <div class="ab-titel">${a.status === 'ok' ? '✓' : a.status === 'abw' ? '✗' : 'ℹ︎'} ${esc(a.titel)}</div>
            <span>${zahl(a.zettel)}</span><span>${zahl(a.lohn)}</span>
            ${a.hinweis ? `<div class="ab-hinweis">${esc(a.hinweis)}</div>` : ''}
          </div>`).join('')}
      </div>`;
  }

  const geldHtml = r.lohn ? geldKarte(r) : '';

  box.innerHTML = `
    <div class="card">
      <div class="row-between"><h2>Monatsauswertung</h2>${auswahl}</div>
      ${hinweise.map(h => `<div class="notice">${esc(h)}</div>`).join('')}
      <div class="stats three">
        <div class="stat"><span class="num">${zahl(r.ist)}</span><span class="lbl">Ist-Std.</span></div>
        <div class="stat"><span class="num">${zahl(r.vollstaendig ? r.soll : r.sollErfasst)}</span><span class="lbl">Soll-Std.</span></div>
        <div class="stat"><span class="num ${r.saldo < 0 ? 'neg' : r.saldo > 0 ? 'pos' : ''}">${zahl(r.saldo, true)}</span><span class="lbl">Saldo</span></div>
      </div>
      <div class="kv"><span>davon produktiv</span><strong>${zahl(r.prod)}</strong></div>
      <div class="kv"><span>davon Urlaub, krank, Feiertag</span><strong>${zahl(r.unprod)}</strong></div>
      <div class="kv"><span>Mehrstunden</span><strong>${zahl(r.mehr, true)}</strong></div>
      <div class="kv"><span>Minderstunden (inkl. Gleitzeit)</span><strong>${zahl(r.mind)}</strong></div>
      ${r.mehrVerguetet ? `<div class="kv"><span>Überstunden zum Auszahlen („vergüten“)</span><strong>${zahl(r.mehrVerguetet)}</strong></div>` : ''}
      <div class="kv"><span>Fürs Arbeitszeitkonto</span><strong>${zahl(r.saldoGesammelt, true)}</strong></div>
      ${r.fahrt ? `<div class="kv"><span>Fahrtätigkeit</span><strong>${zahl(r.fahrt)} Std.</strong></div>` : ''}
      ${r.ausloese ? `<div class="kv"><span>Auslöse / Verpflegung</span><strong>${zahl(r.ausloese)} €</strong></div>` : ''}
    </div>
    <div class="card"><h2>Tage</h2>${tageHtml}</div>
    <div class="card"><h2>Stunden pro Baustelle</h2>${bsHtml}</div>
    <div class="card"><h2>Abgleich mit dem Lohnzettel</h2>${abgleichHtml}</div>
    ${geldHtml}
    <div class="card"><h2>Monatsbericht</h2>
      <p class="muted small">Übersicht, Abgleich und alle Tage von ${MONATE[monat - 1]} ${jahr} auf einer PDF, zum Ablegen oder fürs Lohnbüro.</p>
      <div class="export-actions"><button class="btn primary" data-ex="pdf" data-monat="${gewaehlterMonat}">📄 Monatsbericht als PDF</button></div>
      <div id="pdf-result"></div>
    </div>`;
}

const ICON = { ok: '✓', abw: '✗', warn: '!', info: 'ℹ︎' };

// Geldbeträge: Stundensatz und Stunden × Satz = Betrag je Lohnart
function geldKarte(r) {
  const ss = r.stundensatz;
  if (!r.geld.length) {
    return `<div class="card"><h2>Geldbeträge</h2><p class="muted small">Auf dem Lohnzettel wurden keine Beträge erkannt. Tippe beim Lohnzettel auf „Prüfen“ und dann „Neu auslesen“.</p>
      <button class="btn small" data-review="${r.lohnId}">Lohnzettel prüfen</button></div>`;
  }
  const abw = r.geld.filter(g => g.status === 'abw').length;
  const offen = r.geld.filter(g => g.status === 'info' && /nicht erkannt/.test(g.hinweis)).length;
  const satzHtml = ss && ss.jetzt != null ? `
    <div class="kv"><span>Stundensatz</span><strong>${eur(ss.jetzt)}</strong></div>
    ${ss.geaendert ? `<div class="notice warn-note"><strong>Neuer Stundensatz:</strong> vorher ${eur(ss.vorher)} (${esc(ss.vorherMonat)}), jetzt ${eur(ss.jetzt)}. Passt das zu deinem Vertrag oder einer Lohnerhöhung?</div>`
      : `<p class="muted small">${ss.vorher != null ? `Gleich wie im ${esc(ss.vorherMonat)}.` : 'Noch kein früherer Lohnzettel zum Vergleich.'}</p>`}` : '';
  const s = r.geldSumme;
  return `
    <div class="card"><h2>Geldbeträge</h2>
      ${satzHtml}
      <div class="notice ${abw ? 'err' : offen ? '' : 'ok'}">${abw ? `<strong>${abw} Betrag/Beträge</strong> passen nicht zu Stunden × Satz.`
        : offen ? `${offen} Wert(e) auf dem Lohnzettel nicht erkannt, sonst rechnet sich alles.` : 'Alle Beträge rechnen sich: Stunden × Satz = Betrag.'}
        ${abw || offen ? `<div style="margin-top:8px"><button class="btn small" data-review="${r.lohnId}">Lohnzettel prüfen</button></div>` : ''}</div>
      <div class="abgleich geld">
        <div class="ab-head"><span></span><span>Std. × Satz</span><span>Lohnzettel</span></div>
        ${r.geld.map(g => `
          <div class="ab-row ab-${g.status}">
            <div class="ab-titel">${ICON[g.status]} ${esc(g.titel)}</div>
            <span>${g.erwartet == null ? '' : eur(g.erwartet)}</span><span>${eur(g.betrag)}</span>
            ${g.hinweis ? `<div class="ab-hinweis">${esc(g.hinweis)}</div>` : ''}
          </div>`).join('')}
        ${s ? `<div class="ab-row ab-summe"><div class="ab-titel">Summe</div><span></span><span>${eur(s.summe)}</span>
          <div class="ab-hinweis">Sollte dem „Gesamt-Brutto“ auf deinem Lohnzettel entsprechen. ${s.fehlt ? `${s.fehlt} Betrag/Beträge fehlen noch.` : 'Ist sie kleiner, wurde eine Lohnart nicht erkannt.'}</div></div>` : ''}
      </div>
    </div>`;
}

/* ---------- Jahresübersicht ---------- */
let gewaehltesJahr = null;
const MON_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

async function renderJahr() {
  const box = $('#jahr-box');
  const docs = await Docs.all();
  const jahre = Array.from(new Set(self.Auswertung.monateMitDaten(docs).map(k => parseInt(k.slice(0, 4), 10)))).sort((a, b) => b - a);
  if (!jahre.length) {
    box.innerHTML = `<div class="card"><h2>Jahresübersicht</h2><p class="muted">Sobald du Zettel hochlädst, siehst du hier dein Jahr: Arbeitszeitkonto Monat für Monat, Urlaub, Kranktage und Baustellen.</p>
      <button class="btn primary" data-goto="add">Zettel hinzufügen</button></div>`;
    return;
  }
  if (!gewaehltesJahr || !jahre.includes(gewaehltesJahr)) gewaehltesJahr = jahre[0];
  const J = self.Auswertung.jahresuebersicht(docs, gewaehltesJahr);
  const auswahl = jahre.length > 1
    ? `<select id="jahr-wahl" class="monat-wahl">${jahre.map(j => `<option value="${j}"${j === gewaehltesJahr ? ' selected' : ''}>${j}</option>`).join('')}</select>` : '';
  const mon = J.monate.filter(z => z.hatDaten);
  const key = m => `${gewaehltesJahr}-${String(m).padStart(2, '0')}`;
  const S = J.summe;

  const monateHtml = `
    <div class="jt jt5 jt-head"><span>Monat</span><span>Ist</span><span>Soll</span><span>Saldo</span><span>Abgleich</span></div>
    ${mon.map(z => `
      <button class="jt jt5 jt-row${z.abw ? ' jt-abw' : ''}" data-jahr-monat="${key(z.monat)}">
        <span>${MON_KURZ[z.monat - 1]}${z.vollstaendig ? '' : '<sup>*</sup>'}</span>
        ${z.hatWochen ? `<span>${zahl(z.ist)}</span><span>${zahl(z.soll)}</span>
        <span class="${z.saldo < 0 ? 'neg' : z.saldo > 0 ? 'pos' : ''}">${zahl(z.saldo, true)}</span>` : '<span class="muted">–</span><span class="muted">–</span><span class="muted">–</span>'}
        <span>${!z.lohn ? '<span class="muted">–</span>' : z.abw ? `✗ ${z.abw}` : '✓'}</span>
      </button>`).join('')}
    <div class="jt jt5 jt-sum"><span>Summe</span><span>${zahl(S.ist)}</span><span>${zahl(S.sollErfasst)}</span><span>${zahl(S.saldoGesammelt, true)}</span><span>${S.abw ? `✗ ${S.abw}` : ''}</span></div>
    <p class="muted small">Saldo = Stunden fürs Arbeitszeitkonto. ${mon.some(z => !z.vollstaendig) ? '* Wochenzettel nicht vollständig, Soll nur für die erfassten Tage. ' : ''}Tippe auf einen Monat für die Details.</p>`;

  const azkMon = J.monate.filter(z => z.azkStand != null);
  const azkHtml = azkMon.length ? `
    ${J.azkAktuell ? `<div class="kv"><span>Stand laut Lohnzettel ${MONATE[J.azkAktuell.monat - 1]}</span><strong class="${J.azkAktuell.stand < 0 ? 'neg' : ''}">${zahl(J.azkAktuell.stand, true)} Std.</strong></div>` : ''}
    <div class="jt jt4 jt-head"><span>Monat</span><span>Wochenzettel</span><span>Stand</span><span></span></div>
    ${J.monate.filter(z => z.hatWochen || z.azkStand != null).map(z => `
      <div class="jt jt4 jt-row${z.azkStatus === 'abw' ? ' jt-abw' : ''}">
        <span>${MON_KURZ[z.monat - 1]}</span><span>${z.hatWochen ? zahl(z.saldo, true) : '<span class="muted">–</span>'}</span><span>${z.azkStand == null ? '<span class="muted">–</span>' : zahl(z.azkStand, true)}</span>
        <span>${z.azkStatus ? ICON[z.azkStatus] : ''}</span>
        ${z.azkHinweis ? `<div class="jt-hinweis">${esc(z.azkHinweis)}</div>` : ''}
      </div>`).join('')}
    <p class="muted small">„Wochenzettel“ = Mehr- oder Minderstunden fürs Konto im Monat. „Stand“ = AZK-Std. auf dem Lohnzettel. ✓ heißt: Der Stand hat sich genau um deine Stunden verändert.</p>`
    : '<p class="muted small">Noch kein Lohnzettel mit AZK-Stand gespeichert.</p>';

  const u = J.urlaub;
  const urlMon = J.monate.filter(z => z.urlaubTage || z.urlaubGenommen != null);
  const urlaubHtml = `
    ${u ? `<div class="kv"><span>Anspruch</span><strong>${zahl(u.anspruch)} Tage</strong></div>
      <div class="kv"><span>Genommen laut Lohnzettel ${MONATE[u.monat - 1]}</span><strong>${zahl(u.genommen)} Tage</strong></div>
      <div class="kv"><span>Rest</span><strong>${zahl(u.rest)} Tage</strong></div>` : '<p class="muted small">Noch kein Lohnzettel mit Urlaubsangaben gespeichert.</p>'}
    <div class="kv"><span>Urlaubstage laut deinen Wochenzetteln</span><strong>${S.urlaubTage}</strong></div>
    ${J.urlaubOffen && J.urlaubOffen.tage > 0 ? `<div class="notice warn-note"><strong>${zahl(J.urlaubOffen.tage)} Urlaubstag(e)</strong> von deinen Wochenzetteln sind bis zum Lohnzettel ${MONATE[J.urlaubOffen.monat - 1]} noch nicht abgezogen. Schau, ob sie auf dem nächsten Lohnzettel nachgebucht werden.</div>` : ''}
    ${urlMon.length ? `<div class="jt jt4 jt-head"><span>Monat</span><span>Wochenzettel</span><span>abgezogen</span><span>offen</span></div>
      ${urlMon.map(z => `
        <div class="jt jt4 jt-row${z.urlaubStatus === 'warn' ? ' jt-warn' : ''}">
          <span>${MON_KURZ[z.monat - 1]}</span><span>${z.urlaubTage}</span><span>${z.urlaubAbgezogen == null ? '<span class="muted">–</span>' : zahl(z.urlaubAbgezogen)}</span>
          <span>${z.urlaubOffen == null ? '' : zahl(z.urlaubOffen)}</span>
          ${z.urlaubHinweis ? `<div class="jt-hinweis">${esc(z.urlaubHinweis)}</div>` : ''}
        </div>`).join('')}` : ''}`;

  const krankMon = J.monate.filter(z => z.krankTage || z.krankStdLohn);
  const krankHtml = `
    <div class="kv"><span>Kranktage laut deinen Wochenzetteln</span><strong>${S.krankTage}</strong></div>
    <div class="kv"><span>Krankstunden laut Lohnzetteln</span><strong>${zahl(S.krankStdLohn)} Std.</strong></div>
    ${krankMon.map(z => `<div class="kv small"><span>${MONATE[z.monat - 1]}</span><span>${z.krankTage} Tag(e)${z.krankStdLohn ? `, ${zahl(z.krankStdLohn)} Std. bezahlt` : ''}</span></div>`).join('')}`;

  const satzHtml = J.saetze.length ? J.saetze.map((x, i) => `
    <div class="kv${x.vorher != null ? ' kv-neu' : ''}"><span>${i === 0 ? 'ab' : 'neu ab'} ${MONATE[x.monat - 1]}</span>
      <strong>${eur(x.satz)}${x.vorher != null ? ` <span class="muted small">(vorher ${eur(x.vorher)})</span>` : ''}</strong></div>`).join('')
    + `<p class="muted small">${J.saetze.length === 1 ? 'Auf allen Lohnzetteln dieses Jahres gleich.' : 'Der Stundensatz hat sich im Jahr geändert.'}</p>`
    : '<p class="muted small">Noch kein Stundensatz erkannt.</p>';

  const bsHtml = J.baustellen.length ? J.baustellen.map(b => `
    <div class="kv"><span>${esc(b.name || 'ohne Name')}${b.kostentraeger ? ` <span class="muted small">${esc(b.kostentraeger)}</span>` : ''}</span>
      <strong>${zahl(b.stunden)} Std. <span class="muted small">(${b.tage} T.)</span></strong></div>`).join('')
    : '<p class="muted small">Keine Baustellenstunden erfasst.</p>';

  box.innerHTML = `
    <div class="card"><div class="row-between"><h2>Jahr ${gewaehltesJahr}</h2>${auswahl}</div>${monateHtml}</div>
    <div class="card"><h2>Arbeitszeitkonto</h2>${azkHtml}</div>
    <div class="card"><h2>Urlaub</h2>${urlaubHtml}</div>
    <div class="card"><h2>Krank</h2>${krankHtml}</div>
    <div class="card"><h2>Stundensatz</h2>${satzHtml}</div>
    <div class="card"><h2>Stunden pro Baustelle</h2>${bsHtml}</div>`;
}

document.addEventListener('click', e => {
  const m = e.target.closest('[data-jahr-monat]');
  if (m) { gewaehlterMonat = m.dataset.jahrMonat; go('home'); }
});

document.addEventListener('change', e => {
  if (e.target.id === 'monat-wahl') { gewaehlterMonat = e.target.value; renderHome(); }
  if (e.target.id === 'jahr-wahl') { gewaehltesJahr = parseInt(e.target.value, 10); renderJahr(); }
});

/* ---------- Übersicht ---------- */
async function renderHome() {
  const docs = await Docs.all();
  $('#count-woche').textContent = docs.filter(d => d.type === 'woche').length;
  $('#count-lohn').textContent = docs.filter(d => d.type === 'lohn').length;
  await renderAuswertung(docs);
  if (self.Export) self.Export.aktualisiereInfo(docs);
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('#storage-info').textContent =
      `Deine Zettel werden nur auf diesem Handy gespeichert (${fmtSize(est.usage || 0)} belegt). ` +
      (persisted ? 'Dauerhafte Speicherung ist aktiv.' : 'Tipp: App zum Startbildschirm hinzufügen, damit nichts automatisch gelöscht wird.');
  }
}

/* ---------- Start ---------- */
(async function init() {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) { /* egal */ }
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  await repariereAlteZettel();
  renderHome();
})();

// Ältere Version hat bei Wochenzetteln ohne eingetragenes Jahr kein Datum gesetzt.
// Datum aus "vom:" nachtragen, ohne geprüfte Korrekturen zu verändern.
async function repariereAlteZettel() {
  try {
    const docs = await Docs.all();
    for (const d of docs) {
      // Ältere Lohnzettel: Lohnarten mit Satz und Betrag (Geldprüfung) aus dem gespeicherten Erkennungstext nachtragen
      if (d.type === 'lohn' && d.data && !('posten' in d.data)) {
        const texte = d.data.rohtexte || (d.data.rohtext ? [d.data.rohtext] : []);
        d.data.posten = texte.length ? self.LohnParser.zusammenfuehren(texte.map(t => self.LohnParser.parseLohnzettel(t))).posten : [];
        self.LohnParser.mengenAbgleichen(d.data);
        self.LohnParser.pruefe(d.data);
        await Docs.add(d);
      }
      // Ältere Lohnzettel: Urlaubs-, Krank-, Feiertags- und sonstige Stunden aus dem gespeicherten Erkennungstext nachtragen
      if (d.type === 'lohn' && d.data && (!('urlaubStd' in d.data) || !('verpflegungEuro' in d.data))) {
        const neu = d.data.rohtext ? self.LohnParser.parseLohnzettel(d.data.rohtext) : {};
        if (!('urlaubStd' in d.data)) {
          let gefunden = false;
          self.LohnParser.ABWESENHEIT.forEach(f => { d.data[f] = neu[f] ?? null; if (neu[f]) gefunden = true; });
          self.LohnParser.pruefe(d.data);
          if (gefunden && d.status === 'geprueft') d.status = 'ausgelesen'; // neue Werte bitte noch einmal ansehen
        }
        // Verpflegung (€) nachtragen
        if (!('verpflegungEuro' in d.data)) {
          d.data.verpflegungEuro = neu.verpflegungEuro ?? null;
          d.data.verpflegung = neu.verpflegung || [];
        }
        await Docs.add(d);
        continue;
      }
      if (d.type !== 'woche' || !d.data || !d.data.tage) continue;
      if (d.data.quelle === 'hand') {
        // Leere Tage gehören nicht zum Zettel (z.B. Teilwoche am Monatswechsel)
        const n = d.data.tage.length;
        d.data.tage = d.data.tage.filter(t => t.eintraege && t.eintraege.length);
        if (d.data.tage.length !== n) await Docs.add(d);
        continue;
      }
      // Daten der Tage aus "vom" (Montag der Woche) setzen, leere Tage außerhalb vom–bis entfernen
      if (!self.WochenParser.korrigiereTage(d.data)) continue;
      if (d.data.kw) d.period = `KW ${d.data.kw}/${d.data.jahr}`;
      await Docs.add(d);
    }
  } catch (e) { /* nicht kritisch */ }
}
