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

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const out = $('#add-result');
  out.innerHTML = '';
  for (const file of files) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isImg = file.type.startsWith('image/');
    if (!isPdf && !isImg) {
      out.insertAdjacentHTML('beforeend', `<div class="notice err">„${esc(file.name)}“ ist kein Foto und kein PDF und wurde nicht gespeichert.</div>`);
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
      status: 'neu', // später: 'ausgelesen', 'geprüft'
    };
    try {
      await Docs.add(doc);
      out.insertAdjacentHTML('beforeend', `<div class="notice ok">✓ Als <strong>${TYPE_LABEL[doc.type]}</strong> gespeichert: ${esc(doc.name)}${doc.period ? ' (' + esc(doc.period) + ')' : ''}</div>`);
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
      ${d.thumb ? `<img class="thumb" src="${d.thumb}" alt="">` : `<div class="thumb">PDF</div>`}
      <div class="doc-info">
        <div class="doc-name">${esc(d.period || d.name)}</div>
        <div class="doc-meta"><span class="badge">${TYPE_LABEL[d.type]}</span>${fmtDate(d.addedAt)} · ${fmtSize(d.size)}</div>
        <div class="doc-meta">${d.status === 'neu' ? 'Noch nicht ausgelesen' : esc(d.status)}</div>
      </div>
      <div class="doc-actions">
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
  $('#viewer-body').innerHTML = d.mime === 'application/pdf'
    ? `<iframe src="${viewerUrl}" title="${esc(d.name)}"></iframe><p class="center"><a href="${viewerUrl}" target="_blank" rel="noopener">PDF in neuem Fenster öffnen</a></p>`
    : `<img src="${viewerUrl}" alt="${esc(d.name)}">`;
  $('#viewer').showModal();
}

$('#viewer-close').addEventListener('click', () => $('#viewer').close());

/* ---------- Übersicht ---------- */
async function renderHome() {
  const docs = await Docs.all();
  $('#count-woche').textContent = docs.filter(d => d.type === 'woche').length;
  $('#count-lohn').textContent = docs.filter(d => d.type === 'lohn').length;
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
  renderHome();
})();
