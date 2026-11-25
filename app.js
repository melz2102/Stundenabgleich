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
const TITLES = { home: 'Übersicht', add: 'Zettel hinzufügen', docs: 'Meine Zettel' };

function go(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.goto === view));
  $('#title').textContent = TITLES[view];
  $('#add-result').innerHTML = view === 'add' ? $('#add-result').innerHTML : '';
  if (view === 'docs') renderDocs();
  if (view === 'home') renderHome();
  window.scrollTo(0, 0);
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

async function renderDocs() {
  const docs = (await Docs.all()).sort((a, b) => b.addedAt - a.addedAt);
  const shown = docs.filter(d => filter === 'alle' || d.type === filter);
  const list = $('#doc-list');
  list.innerHTML = shown.map(d => `
    <li class="doc" data-id="${d.id}">
      ${d.thumb ? `<img class="thumb" src="${d.thumb}" alt="">` : `<div class="thumb">${isExcelFile({ name: d.name, type: d.mime }) ? 'XLS' : 'PDF'}</div>`}
      <div class="doc-info">
        <div class="doc-name">${esc(d.period || d.name)}</div>
        <div class="doc-meta"><span class="badge">${TYPE_LABEL[d.type]}</span>${fmtDate(d.addedAt)} · ${fmtSize(d.size)}</div>
        <div class="doc-meta status-${d.status}">${isHandWoche(d) && d.status === 'neu' ? 'Noch nicht eingetragen' : (STATUS_LABEL[d.status] || esc(d.status))}</div>
      </div>
      <div class="doc-actions">
        ${isHandWoche(d) ? `<button class="btn small primary" data-review="${d.id}">${d.data ? 'Bearbeiten' : 'Eintragen'}</button>`
          : d.data || d.type === 'lohn' ? `<button class="btn small primary" data-review="${d.id}">Prüfen</button>` : ''}
        <button class="btn small" data-act="open">Ansehen</button>
        <button class="btn small danger" data-act="del">Löschen</button>
      </div>
    </li>`).join('');
  $('#doc-empty').style.display = shown.length ? 'none' : 'block';
}

$('#doc-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.closest('.doc').dataset.id;
  if (b.dataset.act === 'open') openViewer(id);
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

const LOHN_FELDER = [
  ['Stunden', [
    ['stundenlohn', 'Stundenlohn (Lohnart 1000), Std.'],
    ['fahrgeldStd', 'Fahrgeld, Std.'],
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
  $('#viewer-title').textContent = 'Prüfen: ' + (d.period || d.name);
  $('#viewer-body').innerHTML = `
    <div class="review">
      ${r.warnungen && r.warnungen.length ? `<div class="notice err">${r.warnungen.map(esc).join('<br>')}</div>` : ''}
      ${d.readError ? `<div class="notice err">Automatisches Auslesen hat nicht geklappt: ${esc(d.readError)}<br>Du kannst die Werte hier von Hand eintragen.</div>` : ''}
      <p class="muted small">Vergleiche die Werte mit deinem Lohnzettel. Leere Felder kommen auf dem Zettel nicht vor. ${r.quelle === 'foto' ? 'Bei Fotos verliest sich die Erkennung manchmal, also bitte genau hinschauen.' : ''}</p>
      <div class="day"><div class="day-head"><strong>Abrechnungsmonat</strong></div>
        <div class="entry-grid two">
          <label class="field">Monat<select data-lf="monat"><option value="">–</option>${monate}</select></label>
          <label class="field">Jahr<input inputmode="numeric" data-lf="jahr" value="${r.jahr || ''}"></label>
        </div>
      </div>
      ${groups}
      <div class="review-actions">
        <button class="btn" data-review-open="${d.id}">Zettel ansehen</button>
        <button class="btn primary" id="review-save">Stimmt so, speichern</button>
      </div>
    </div>`;
  if (!$('#viewer').open) $('#viewer').showModal();
}

async function saveReviewLohn(d) {
  const r = d.data || self.LohnParser.parseLohnzettel('');
  $$('#viewer-body [data-lf]').forEach(el => {
    const v = el.value.trim();
    const k = el.dataset.lf;
    if (k === 'monat' || k === 'jahr') r[k] = v ? parseInt(v, 10) : null;
    else r[k] = v === '' ? null : numIn(v);
  });
  r.warnungen = [];
  d.data = r;
  if (r.monat && r.jahr) d.period = `${MONATE[r.monat - 1]} ${r.jahr}`;
  d.readError = null;
  d.status = 'geprueft';
  d.checkedAt = Date.now();
  await Docs.add(d);
  $('#viewer').close();
  renderDocs();
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
        <button class="btn primary" id="review-save">Stimmt so, speichern</button>
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
      <div class="notice ${abw ? 'err' : 'ok'}">${abw ? `<strong>${abw} Abweichung(en)</strong> zwischen Wochenzetteln und Lohnzettel.` : 'Keine Abweichungen gefunden.'}</div>
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
    <div class="card"><h2>Abgleich mit dem Lohnzettel</h2>${abgleichHtml}</div>`;
}

document.addEventListener('change', e => {
  if (e.target.id === 'monat-wahl') { gewaehlterMonat = e.target.value; renderHome(); }
});

/* ---------- Übersicht ---------- */
async function renderHome() {
  const docs = await Docs.all();
  $('#count-woche').textContent = docs.filter(d => d.type === 'woche').length;
  $('#count-lohn').textContent = docs.filter(d => d.type === 'lohn').length;
  await renderAuswertung(docs);
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
      if (d.type !== 'woche' || !d.data || !d.data.tage) continue;
      const m = d.data.vom && d.data.vom.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (!m || d.data.tage.every(t => t.datum)) continue;
      d.data.tage.forEach((t, i) => {
        const dt = new Date(+m[3], +m[2] - 1, +m[1] + i, 12);
        t.datum = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      });
      if (!d.data.jahr) d.data.jahr = new Date(+m[3], +m[2] - 1, +m[1] + 3, 12).getFullYear();
      if (d.data.kw) d.period = `KW ${d.data.kw}/${d.data.jahr}`;
      await Docs.add(d);
    }
  } catch (e) { /* nicht kritisch */ }
}
