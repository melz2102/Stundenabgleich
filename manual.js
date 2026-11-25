'use strict';
/*
 * Handgeschriebene Wochenzettel: Das Foto wird angezeigt, die Werte tippt man ein.
 * Die Tage sind mit dem Soll vorausgefüllt, Mehr-/Minderstunden rechnet die App wie das Excel-Formular aus.
 */
(function () {
  const TAGE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag/Sonntag'];
  const SOLL_TAG = [8.5, 8.5, 8.5, 8.5, 5.0, 0];
  const OHNE_STUNDEN = ['gleitzeit'];
  let state = null; // { docId, vom: 'YYYY-MM-DD', tage: [[entry]], baustelle, verguetet, zoom }
  let photoUrl = null;

  const isoD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const deD = d => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);

  function montagVon(d) {
    const wd = d.getDay() || 7;
    return addDays(d, 1 - wd);
  }

  function isoWoche(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return { kw: Math.ceil(((t - y0) / 86400000 + 1) / 7), jahr: t.getUTCFullYear() };
  }

  function montagAusKW(kw, jahr) {
    const jan4 = new Date(jahr, 0, 4, 12);
    return addDays(montagVon(jan4), (kw - 1) * 7);
  }

  function leererEintrag(kategorie, std) {
    return { kategorie, std, beschreibung: '' };
  }

  // Ein Tag: Ist = alle Stunden außer Gleitzeit; Differenz zum Soll = Mehr (+) oder Minder (−)
  function tagRechnung(eintraege, i) {
    const soll = SOLL_TAG[i];
    const ist = eintraege.filter(e => !OHNE_STUNDEN.includes(e.kategorie)).reduce((s, e) => s + (e.std || 0), 0);
    if (!eintraege.length) return { ist: 0, diff: 0, leer: soll > 0 };
    const diff = Math.round((ist - soll) * 100) / 100;
    return { ist, diff, leer: false };
  }

  function stateAusDoc(d) {
    if (d.data && d.data.quelle === 'hand' && d.data.vomIso) {
      return {
        docId: d.id, vom: d.data.vomIso, zoom: 1,
        baustelle: d.data.baustelle || '',
        verguetet: !!d.data.mehrstundenVerguetet,
        tage: d.data.tage.map(t => t.eintraege.map(e => ({
          kategorie: e.kategorie, std: e.prod + e.unprod,
          beschreibung: [e.kostentraeger, e.beschreibung].filter(Boolean).join(' · '),
        }))),
      };
    }
    let mo;
    const m = (d.period || '').match(/KW (\d+)\/(\d{4})/);
    if (m) mo = montagAusKW(+m[1], +m[2]);
    else mo = addDays(montagVon(new Date()), -7); // Standard: letzte Woche
    return {
      docId: d.id, vom: isoD(mo), zoom: 1, baustelle: '', verguetet: false,
      tage: SOLL_TAG.map(s => (s ? [leererEintrag('baustelle', s)] : [])),
    };
  }

  function katOptions(sel) {
    return Object.entries(KAT_LABEL).map(([k, l]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${l}</option>`).join('');
  }

  function infoHtml(r) {
    return r.leer ? '<span class="neg-text">kein Eintrag</span>'
      : r.diff > 0 ? `<span class="pos-text">Mehr +${fmtH(r.diff)}</span>`
        : r.diff < 0 ? `<span class="neg-text">Minder ${fmtH(r.diff)}</span>` : '<span class="muted">Soll erfüllt</span>';
  }

  function saldoHtml(v) {
    return `<span class="${v < 0 ? 'neg-text' : v > 0 ? 'pos-text' : ''}">${fmtH(v, true)}</span>`;
  }

  // Nur Anzeigen aktualisieren, ohne neu zu zeichnen (Fokus bleibt im Eingabefeld)
  function aktualisiereInfos() {
    let saldo = 0;
    state.tage.forEach((eintraege, ti) => {
      const r = tagRechnung(eintraege, ti);
      saldo += r.diff;
      const el = $(`#viewer-body [data-info="${ti}"]`);
      if (el) el.innerHTML = infoHtml(r);
    });
    const s = $('#hand-saldo');
    if (s) s.innerHTML = saldoHtml(Math.round(saldo * 100) / 100);
  }

  function render() {
    const mo = parseIso(state.vom);
    const { kw, jahr } = isoWoche(mo);
    let saldo = 0;
    const tageHtml = state.tage.map((eintraege, ti) => {
      const datum = ti < 5 ? deD(addDays(mo, ti)).slice(0, 6) : `${deD(addDays(mo, 5)).slice(0, 6)}/${deD(addDays(mo, 6)).slice(0, 6)}`;
      const r = tagRechnung(eintraege, ti);
      saldo += r.diff;
      const info = infoHtml(r);
      const rows = eintraege.map((e, ei) => `
        <div class="entry hand" data-t="${ti}" data-e="${ei}">
          <div class="hand-row">
            <select data-h="kategorie">${katOptions(e.kategorie)}</select>
            <input inputmode="decimal" data-h="std" value="${OHNE_STUNDEN.includes(e.kategorie) ? '' : inVal(e.std)}" placeholder="Std." ${OHNE_STUNDEN.includes(e.kategorie) ? 'disabled' : ''}>
            <button class="btn small" data-h-del="${ti}:${ei}" aria-label="Zeile entfernen">✕</button>
          </div>
          <input data-h="beschreibung" value="${esc(e.beschreibung || '')}" placeholder="${e.kategorie === 'baustelle' && state.baustelle ? esc(state.baustelle) : 'Baustelle / Beschreibung'}">
        </div>`).join('');
      return `<div class="day">
        <div class="day-head row-between"><span><strong>${TAGE[ti]}</strong> <span class="muted">${datum}</span></span><span class="small" data-info="${ti}">${info}</span></div>
        ${rows}
        <button class="btn small" data-h-add="${ti}">+ Zeile</button>
      </div>`;
    }).join('');
    saldo = Math.round(saldo * 100) / 100;

    $('#viewer-title').textContent = `Eintragen: KW ${kw}/${jahr}`;
    $('#viewer-body').innerHTML = `
      <div class="hand-photo" style="--zoom:${state.zoom}">
        <img src="${photoUrl}" alt="Foto des Wochenzettels">
        <div class="zoom-btns">
          <button class="btn small" data-zoom="-1" aria-label="Verkleinern">−</button>
          <button class="btn small" data-zoom="1" aria-label="Vergrößern">+</button>
        </div>
      </div>
      <div class="review">
        <div class="day">
          <label class="field">Woche ab Montag<input type="date" data-h-top="vom" value="${state.vom}"></label>
          <label class="field">Baustelle diese Woche (für leere Felder)<input data-h-top="baustelle" value="${esc(state.baustelle)}" placeholder="z.B. 732437 · Pathologie Tübingen"></label>
          <label class="check"><input type="checkbox" data-h-top="verguetet" ${state.verguetet ? 'checked' : ''}> Mehrstunden vergüten (sonst sammeln)</label>
        </div>
        <p class="muted small">Die Tage sind mit dem Soll vorausgefüllt (Mo–Do 8,5 / Fr 5 Std.). Ändere nur, was auf deinem Zettel anders ist. Mehr- und Minderstunden rechnet die App selbst aus.</p>
        ${tageHtml}
        <div class="card small">Saldo der Woche: <strong id="hand-saldo">${saldoHtml(saldo)}</strong></div>
        <div class="review-actions">
          <button class="btn" id="hand-cancel">Abbrechen</button>
          <button class="btn primary" id="hand-save">Speichern</button>
        </div>
      </div>`;
  }

  // Eingaben in den Zustand übernehmen (ohne neu zu zeichnen)
  function lies() {
    $$('#viewer-body .entry.hand').forEach(el => {
      const e = state.tage[+el.dataset.t][+el.dataset.e];
      e.kategorie = el.querySelector('[data-h="kategorie"]').value;
      e.std = OHNE_STUNDEN.includes(e.kategorie) ? 0 : numIn(el.querySelector('[data-h="std"]').value);
      e.beschreibung = el.querySelector('[data-h="beschreibung"]').value.trim();
    });
    const top = k => $(`#viewer-body [data-h-top="${k}"]`);
    if (top('vom') && top('vom').value) state.vom = isoD(montagVon(parseIso(top('vom').value)));
    if (top('baustelle')) state.baustelle = top('baustelle').value.trim();
    if (top('verguetet')) state.verguetet = top('verguetet').checked;
  }

  function neuZeichnen() {
    const y = $('#viewer-body').scrollTop;
    render();
    $('#viewer-body').scrollTop = y;
  }

  async function speichern() {
    lies();
    const d = await Docs.get(state.docId);
    if (!d) return;
    const mo = parseIso(state.vom);
    const { kw, jahr } = isoWoche(mo);
    const tage = state.tage.map((eintraege, ti) => {
      const r = tagRechnung(eintraege, ti);
      const liste = eintraege.map((e, ei) => {
        let desc = e.beschreibung || (e.kategorie === 'baustelle' ? state.baustelle : '');
        let kt = '';
        const m = desc.match(/^(\d{4,})\s*[·\-–]?\s*(.*)$/);
        if (m) { kt = m[1]; desc = m[2]; }
        const unprod = UNPROD_KAT.includes(e.kategorie);
        const std = OHNE_STUNDEN.includes(e.kategorie) ? 0 : (e.std || 0);
        const out = {
          kategorie: e.kategorie, kostentraeger: kt, beschreibung: desc || (e.kategorie === 'gleitzeit' ? 'GZ' : ''),
          prod: unprod ? 0 : std, unprod: unprod ? std : 0, mehr: 0, mind: 0,
          garantie: 0, erschwernis: 0, ausloese: 0, fahrt: 0, bereitschaft: 0, pause: 0, von: '', bis: '',
        };
        if (ei === 0) { out.mehr = Math.max(r.diff, 0); out.mind = Math.min(r.diff, 0); }
        return out;
      });
      const sum = k => Math.round(liste.reduce((s, e) => s + e[k], 0) * 100) / 100;
      return {
        tag: TAGE[ti], datum: isoD(addDays(mo, ti)), eintraege: liste,
        summe: { mehr: sum('mehr'), mind: sum('mind'), prod: sum('prod'), unprod: sum('unprod') },
        kategorien: Array.from(new Set(liste.map(e => e.kategorie))),
      };
    });
    const summen = { garantie: 0, erschwernis: 0, ausloese: 0, fahrt: 0, bereitschaft: 0, pause: 0 };
    ['mehr', 'mind', 'prod', 'unprod'].forEach(k => { summen[k] = Math.round(tage.reduce((s, t) => s + t.summe[k], 0) * 100) / 100; });
    d.data = {
      art: 'woche', quelle: 'hand', jahr, kw, vomIso: state.vom,
      vom: deD(mo), bis: deD(addDays(mo, 4)), baustelle: state.baustelle,
      tage, summen, saldo: Math.round((summen.mehr + summen.mind) * 100) / 100,
      mehrstundenVerguetet: state.verguetet, mehrstundenGesammelt: !state.verguetet, warnungen: [],
    };
    d.period = `KW ${kw}/${jahr}`;
    d.status = 'geprueft';
    d.checkedAt = Date.now();
    await Docs.add(d);
    $('#viewer').close();
    if (typeof renderDocs === 'function') renderDocs();
  }

  async function openManualWeek(id) {
    const d = await Docs.get(id);
    if (!d) return;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = URL.createObjectURL(d.blob);
    state = stateAusDoc(d);
    render();
    if (!$('#viewer').open) $('#viewer').showModal();
    $('#viewer-body').scrollTop = 0;
  }

  document.addEventListener('click', e => {
    if (!state || !$('#viewer').open || !$('#viewer-body .hand-photo')) return;
    const t = e.target;
    if (t.closest('[data-h-add]')) {
      lies();
      const ti = +t.closest('[data-h-add]').dataset.hAdd;
      state.tage[ti].push(leererEintrag(state.tage[ti].length ? 'baustelle' : (SOLL_TAG[ti] ? 'baustelle' : 'arbeit'), 0));
      neuZeichnen();
    } else if (t.closest('[data-h-del]')) {
      lies();
      const [ti, ei] = t.closest('[data-h-del]').dataset.hDel.split(':').map(Number);
      state.tage[ti].splice(ei, 1);
      neuZeichnen();
    } else if (t.closest('[data-zoom]')) {
      state.zoom = Math.min(4, Math.max(1, state.zoom + +t.closest('[data-zoom]').dataset.zoom));
      $('#viewer-body .hand-photo').style.setProperty('--zoom', state.zoom);
    } else if (t.id === 'hand-save') {
      speichern();
    } else if (t.id === 'hand-cancel') {
      $('#viewer').close();
    }
  });

  // Kategorie oder Woche geändert: neu zeichnen. Stunden getippt: nur Anzeigen aktualisieren.
  document.addEventListener('change', e => {
    if (!state || !$('#viewer-body .hand-photo')) return;
    if (e.target.matches('[data-h="kategorie"], [data-h-top="vom"]')) {
      lies();
      neuZeichnen();
    }
  });
  document.addEventListener('input', e => {
    if (!state || !$('#viewer-body .hand-photo')) return;
    if (e.target.matches('[data-h="std"]')) {
      lies();
      aktualisiereInfos();
    }
  });

  self.openManualWeek = openManualWeek;
})();
