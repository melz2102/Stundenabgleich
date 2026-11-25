'use strict';
/*
 * Handgeschriebene Wochenzettel: Das Foto wird angezeigt, die Werte tippt man ein.
 * Die Tage sind mit dem Soll vorausgefüllt, Mehr-/Minderstunden rechnet die App wie das Excel-Formular aus.
 * Neu: Die App versucht, die Zahlen vom Foto zu lesen (hand-erkennung.js) und trägt sie als Vorschlag ein.
 */
(function () {
  const TAGE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag/Sonntag'];
  const SOLL_TAG = [8.5, 8.5, 8.5, 8.5, 5.0, 0];
  const OHNE_STUNDEN = ['gleitzeit'];
  let state = null; // { docId, vom: 'YYYY-MM-DD', tage: [[entry]], baustelle, verguetet, zoom, erkennung, bearbeitet }
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
    return { kategorie, std, beschreibung: '', ausloese: 0, fahrt: 0 };
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
        // Tage über das Datum zuordnen: leere Tage (z.B. der andere Teil einer Woche am Monatswechsel) werden nicht gespeichert
        tage: TAGE.map((_, ti) => {
          const t = d.data.tage.find(x => x.datum === isoD(addDays(parseIso(d.data.vomIso), ti)));
          return t ? t.eintraege.map(e => ({
            kategorie: e.kategorie, std: e.prod + e.unprod,
            beschreibung: [e.kostentraeger, e.beschreibung].filter(Boolean).join(' · '),
            ausloese: e.ausloese || 0, fahrt: e.fahrt || 0,
          })) : [];
        }),
      };
    }
    let mo;
    const m = (d.period || '').match(/KW (\d+)\/(\d{4})/);
    if (m) mo = montagAusKW(+m[1], +m[2]);
    else mo = addDays(montagVon(new Date()), -7); // Standard: letzte Woche
    return {
      docId: d.id, vom: isoD(mo), zoom: 1, baustelle: '', verguetet: false, neu: true,
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
      const vs = (e, k) => (e.vorschlag && e.vorschlag.includes(k) ? ' vorschlag' : '');
      const rows = eintraege.map((e, ei) => `
        <div class="entry hand" data-t="${ti}" data-e="${ei}">
          <div class="hand-row">
            <select data-h="kategorie" class="${vs(e, 'kategorie')}">${katOptions(e.kategorie)}</select>
            <input inputmode="decimal" data-h="std" class="${vs(e, 'std')}" value="${OHNE_STUNDEN.includes(e.kategorie) ? '' : inVal(e.std)}" placeholder="Std." ${OHNE_STUNDEN.includes(e.kategorie) ? 'disabled' : ''}>
            <button class="btn small" data-h-del="${ti}:${ei}" aria-label="Zeile entfernen">✕</button>
          </div>
          <input data-h="beschreibung" class="${vs(e, 'beschreibung')}" value="${esc(e.beschreibung || '')}" placeholder="${e.kategorie === 'baustelle' && state.baustelle ? esc(state.baustelle) : 'Baustelle / Beschreibung'}">
          <div class="hand-extra">
            <label>Auslöse €<input inputmode="decimal" data-h="ausloese" class="${vs(e, 'ausloese')}" value="${e.ausloese ? inVal(e.ausloese) : ''}" placeholder="0"></label>
            <label>Fahrt Std.<input inputmode="decimal" data-h="fahrt" class="${vs(e, 'fahrt')}" value="${e.fahrt ? inVal(e.fahrt) : ''}" placeholder="0"></label>
          </div>
          ${e.hinweis ? `<div class="small warn-text">${esc(e.hinweis)}</div>` : ''}
        </div>`).join('');
      const tagHinweis = state.erkennung && state.erkennung.tage ? state.erkennung.tage[ti] : null;
      return `<div class="day${tagHinweis && tagHinweis.unsicher ? ' day-unsicher' : ''}">
        <div class="day-head row-between"><span><strong>${TAGE[ti]}</strong> <span class="muted">${datum}</span></span><span class="small" data-info="${ti}">${info}</span></div>
        ${tagHinweis && tagHinweis.text ? `<div class="small warn-text">${esc(tagHinweis.text)}</div>` : ''}
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
          <label class="field">Woche ab Montag${state.vomVorschlag ? ` <span class="warn-text">(KW ${isoWoche(parseIso(state.vom)).kw} vom Foto gelesen)</span>` : ''}<input type="date" data-h-top="vom" class="${state.vomVorschlag ? 'vorschlag' : ''}" value="${state.vom}"></label>
          <label class="field">Baustelle diese Woche (für leere Felder)<input data-h-top="baustelle" value="${esc(state.baustelle)}" placeholder="z.B. 732437 · Pathologie Tübingen"></label>
          <label class="check"><input type="checkbox" data-h-top="verguetet" ${state.verguetet ? 'checked' : ''}> Mehrstunden vergüten (sonst sammeln)</label>
        </div>
        ${erkennungHtml()}
        <p class="muted small">${state.erkennung && state.erkennung.ok ? 'Gelb markierte Felder hat die App vom Foto gelesen.' : 'Die Tage sind mit dem Soll vorausgefüllt (Mo–Do 8,5 / Fr 5 Std.). Ändere nur, was auf deinem Zettel anders ist.'} Mehr- und Minderstunden rechnet die App selbst aus. Gilt der Zettel nur für einen Teil der Woche (Monatswechsel), lösche die Zeilen der übrigen Tage mit ✕.</p>
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
      e.ausloese = numIn(el.querySelector('[data-h="ausloese"]').value);
      e.fahrt = numIn(el.querySelector('[data-h="fahrt"]').value);
    });
    const top = k => $(`#viewer-body [data-h-top="${k}"]`);
    if (top('vom') && top('vom').value) {
      const neu = isoD(montagVon(parseIso(top('vom').value)));
      if (neu !== state.vom) state.vomVorschlag = false;
      state.vom = neu;
    }
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
          garantie: 0, erschwernis: 0, ausloese: e.ausloese || 0, fahrt: e.fahrt || 0, bereitschaft: 0, pause: 0, von: '', bis: '',
        };
        if (ei === 0) { out.mehr = Math.max(r.diff, 0); out.mind = Math.min(r.diff, 0); }
        return out;
      });
      const sum = k => Math.round(liste.reduce((s, e) => s + e[k], 0) * 100) / 100;
      return {
        tag: TAGE[ti], datum: isoD(addDays(mo, ti)), eintraege: liste,
        summe: { mehr: sum('mehr'), mind: sum('mind'), prod: sum('prod'), unprod: sum('unprod'), ausloese: sum('ausloese'), fahrt: sum('fahrt') },
        kategorien: Array.from(new Set(liste.map(e => e.kategorie))),
      };
    }).filter(t => t.eintraege.length); // leere Tage gehören nicht zu diesem Zettel (z.B. Teilwoche am Monatswechsel)
    const summen = { garantie: 0, erschwernis: 0, ausloese: 0, fahrt: 0, bereitschaft: 0, pause: 0 };
    ['mehr', 'mind', 'prod', 'unprod', 'ausloese', 'fahrt'].forEach(k => { summen[k] = Math.round(tage.reduce((s, t) => s + t.summe[k], 0) * 100) / 100; });
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
    if (state.neu) fotoLesen(d, true);
  }

  /* ---------- Vorschlag vom Foto ---------- */
  let ladePromise = null;
  function ladeErkennung() {
    if (self.HandErkennung && self.ZIFFERN_NETZ) return Promise.resolve();
    if (!ladePromise) {
      const lade = src => new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.onload = res;
        s.onerror = () => { ladePromise = null; rej(new Error('Die Erkennung konnte nicht geladen werden. Bitte einmal mit Internet öffnen.')); };
        document.head.appendChild(s);
      });
      ladePromise = Promise.all([lade('ziffern-netz.js'), lade('hand-erkennung.js')]);
    }
    return ladePromise;
  }

  const KURZ = { prod: 'Prod.', unprod: 'Unprod.', mehr: 'Mehr', mind: 'Minder', ausloese: 'Auslöse', fahrt: 'Fahrt' };

  function erkennungHtml() {
    const E = state.erkennung;
    if (!E) return `<div class="card small hand-auto"><button class="btn small" id="hand-lesen">📷 Werte vom Foto lesen (Vorschlag)</button></div>`;
    if (E.laeuft) return `<div class="card small hand-auto">📷 Lese die Zahlen vom Foto …</div>`;
    if (E.fehler) return `<div class="notice warn-note small">📷 ${esc(E.fehler)} Trag die Werte bitte selbst ein. <button class="btn small" id="hand-lesen">Nochmal versuchen</button></div>`;
    if (E.offen) return `<div class="notice warn-note small">📷 Vorschlag vom Foto liegt bereit. <button class="btn small primary" id="hand-uebernehmen">Vorschlag übernehmen</button> (ersetzt deine Eingaben)</div>`;
    const teile = Object.keys(E.vergleich).map(k => `${KURZ[k]} ${E.vergleich[k] ? '✓' : '✗'}`);
    const abw = Object.keys(E.vergleich).filter(k => !E.vergleich[k]);
    const unsicher = E.tage.filter(t => t && t.unsicher).length;
    const gut = !abw.length && !unsicher && teile.length;
    return `<div class="notice ${gut ? '' : 'warn-note'} small">📷 <strong>Vorschlag vom Foto eingetragen.</strong>
      ${teile.length ? `Summenzeile: ${teile.join(', ')}.` : 'Die Summenzeile konnte nicht gelesen werden.'}
      ${abw.length ? `<br>${abw.map(k => `${KURZ[k]}: die Tage ergeben ${k === 'ausloese' ? eur(E.ist[k]) : fmtH(E.ist[k])}`).join(', ')} – bitte mit der Summenzeile auf dem Zettel vergleichen.` : ''}
      ${unsicher ? `<br>${unsicher === 1 ? 'Ein Tag passt' : `${unsicher} Tage passen`} nicht zu Soll und Mehr/Minder – dort genau hinschauen.` : ''}
      <br>Handschrift wird nicht immer richtig gelesen: bitte jeden Tag mit dem Foto vergleichen, bevor du speicherst.</div>`;
  }

  // Erkannte Werte in Einträge des Formulars übersetzen
  function vorschlagAnwenden(r) {
    const tage = r.tage.map((t, ti) => {
      const liste = [];
      let rest = { ausloese: 0, fahrt: 0 };
      t.eintraege.forEach(e => {
        // Kostenträger werden (noch) nicht vorgeschlagen: zu kleine Schrift, zu unsicher
        if (e.prod != null) liste.push({ kategorie: 'baustelle', std: e.prod, beschreibung: '', ausloese: e.ausloese || 0, fahrt: e.fahrt || 0, vorschlag: ['std'].concat(e.ausloese ? ['ausloese'] : [], e.fahrt ? ['fahrt'] : []) });
        if (e.unprod != null) liste.push({ kategorie: 'unproduktiv', std: e.unprod, beschreibung: '', ausloese: e.prod == null ? e.ausloese || 0 : 0, fahrt: e.prod == null ? e.fahrt || 0 : 0, vorschlag: ['std', 'kategorie'], hinweis: 'Unproduktive Stunden: bitte die Art wählen (Urlaub, Krank, Feiertag …).' });
        if (e.prod == null && e.unprod == null) { rest.ausloese += e.ausloese || 0; rest.fahrt += e.fahrt || 0; }
      });
      const mind = t.eintraege.reduce((s, e) => s + (e.mind || 0), 0);
      if (!liste.length && mind > 0) liste.push({ kategorie: 'gleitzeit', std: 0, beschreibung: '', ausloese: 0, fahrt: 0, vorschlag: ['kategorie'] });
      if (liste.length) { liste[0].ausloese += rest.ausloese; liste[0].fahrt += rest.fahrt; }
      return liste;
    });
    state.tage = tage;
    // Kalenderwoche vom Zettel: im laufenden Jahr, außer sie läge in der Zukunft
    if (r.kw && state.neu) {
      const heute = new Date();
      let mo = montagAusKW(r.kw, heute.getFullYear());
      if (mo - heute > 7 * 86400000) mo = montagAusKW(r.kw, heute.getFullYear() - 1);
      state.vom = isoD(mo);
      state.vomVorschlag = true;
    }
    state.erkennung = {
      ok: true, vergleich: r.vergleich, summe: r.summe, ist: r.ist,
      tage: r.tage.map((t, ti) => {
        if (!tage[ti].length && SOLL_TAG[ti] > 0) return { unsicher: true, text: 'Auf dem Foto nichts erkannt. Bitte prüfen (oder Zeile hinzufügen).' };
        if (t.passt === false) return { unsicher: true, text: 'Gelesene Stunden passen nicht zu Mehr/Minder auf dem Zettel – bitte prüfen.' };
        return null;
      }),
    };
  }

  async function fotoLesen(d, automatisch) {
    const id = state.docId;
    state.erkennung = { laeuft: true };
    neuZeichnen();
    try {
      await ladeErkennung();
      const r = await self.HandErkennung.erkenne(d.blob);
      if (!state || state.docId !== id) return;
      if (automatisch && state.bearbeitet) { state.erkennung = { offen: true, r }; neuZeichnen(); return; }
      vorschlagAnwenden(r);
    } catch (e) {
      if (!state || state.docId !== id) return;
      state.erkennung = { fehler: e.message || String(e) };
    }
    neuZeichnen();
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
    } else if (t.id === 'hand-lesen') {
      lies();
      Docs.get(state.docId).then(d => d && fotoLesen(d, false));
    } else if (t.id === 'hand-uebernehmen') {
      vorschlagAnwenden(state.erkennung.r);
      neuZeichnen();
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
    if (e.target.matches('[data-h], [data-h-top]')) {
      state.bearbeitet = true;
      e.target.classList.remove('vorschlag');
      const el = e.target.closest('.entry.hand');
      if (el && e.target.dataset.h) {
        const en = state.tage[+el.dataset.t][+el.dataset.e];
        if (en && en.vorschlag) en.vorschlag = en.vorschlag.filter(k => k !== e.target.dataset.h);
      }
    }
    if (e.target.matches('[data-h="std"]')) {
      lies();
      aktualisiereInfos();
    }
  });

  self.openManualWeek = openManualWeek;
})();
