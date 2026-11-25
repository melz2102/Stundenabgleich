'use strict';
/*
 * Monatsauswertung aus den ausgelesenen Wochenzetteln und Abgleich mit dem Lohnzettel.
 *
 * Annahmen (aus Kevins Oktober-Abrechnung abgeleitet, siehe README):
 *  - Soll: Mo–Do 8,5 Std., Fr 5,0 Std., Sa/So 0. Feiertage zählen zum Soll (werden bezahlt).
 *  - Stundenlohn (Lohnart 1000) + Abbau Arbeitszeitkonto − Aufbau = Monatssoll.
 *  - Ist-Stunden = produktive + unproduktive Stunden (Urlaub, krank …). Saldo = Mehr- + Minderstunden.
 *  - Fehlen Stunden (Saldo < 0), werden sie vom Arbeitszeitkonto abgebaut.
 */
(function (root) {
  const SOLL = [0, 8.5, 8.5, 8.5, 8.5, 5.0, 0]; // So, Mo, Di, Mi, Do, Fr, Sa
  const r2 = v => Math.round(v * 100) / 100;
  const near = (a, b) => Math.abs(a - b) < 0.01;

  function iso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function tageImMonat(jahr, monat) {
    const out = [];
    const d = new Date(jahr, monat - 1, 1, 12);
    while (d.getMonth() === monat - 1) { out.push(new Date(d)); d.setDate(d.getDate() + 1); }
    return out;
  }

  function monatssoll(jahr, monat) {
    return r2(tageImMonat(jahr, monat).reduce((s, d) => s + SOLL[d.getDay()], 0));
  }

  function kw(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / 86400000 + 1) / 7);
  }

  // Alle Tage aus allen Wochenzetteln; doppelt hochgeladene Tage: geprüfter bzw. neuerer Zettel gewinnt
  function sammleTage(docs) {
    const rang = d => (d.status === 'geprueft' ? 1e15 : 0) + (d.checkedAt || d.addedAt || 0);
    const map = new Map();
    docs.filter(d => d.type === 'woche' && d.data && d.data.tage).sort((a, b) => rang(a) - rang(b)).forEach(doc => {
      doc.data.tage.forEach(t => {
        if (!t.datum) return;
        map.set(t.datum, {
          datum: t.datum, tag: t.tag, eintraege: t.eintraege,
          verguetet: !!doc.data.mehrstundenVerguetet, geprueft: doc.status === 'geprueft', kw: doc.data.kw,
        });
      });
    });
    return map;
  }

  function monateMitDaten(docs) {
    const set = new Set();
    sammleTage(docs).forEach((t, datum) => { if (t.eintraege.length) set.add(datum.slice(0, 7)); });
    docs.filter(d => d.type === 'lohn' && d.data && d.data.monat && d.data.jahr)
      .forEach(d => set.add(`${d.data.jahr}-${String(d.data.monat).padStart(2, '0')}`));
    return Array.from(set).sort().reverse();
  }

  function findeLohn(docs, jahr, monat) {
    const passend = docs.filter(d => d.type === 'lohn' && d.data && d.data.jahr === jahr && d.data.monat === monat)
      .sort((a, b) => (b.status === 'geprueft') - (a.status === 'geprueft') || (b.checkedAt || b.addedAt) - (a.checkedAt || a.addedAt));
    return passend[0] || null;
  }

  function auswerten(docs, jahr, monat) {
    const alleTage = sammleTage(docs);
    const kalender = tageImMonat(jahr, monat);
    const res = {
      jahr, monat,
      soll: monatssoll(jahr, monat), sollErfasst: 0,
      ist: 0, prod: 0, unprod: 0, mehr: 0, mind: 0, saldo: 0, mehrVerguetet: 0,
      tage: { baustelle: 0, arbeit: 0, krank: 0, urlaub: 0, feiertag: 0, gleitzeit: 0, lehrgang: 0, unproduktiv: 0, sonstiges: 0 },
      baustellen: [], ausloese: 0, fahrt: 0,
      fehlendeTage: [], fehlendeKW: [], ungeprueft: 0, vollstaendig: false,
      lohn: null, lohnVormonat: null, abgleich: [],
    };
    const bs = new Map();
    const ungeprueftKW = new Set();

    for (const d of kalender) {
      const datum = iso(d);
      const t = alleTage.get(datum);
      const soll = SOLL[d.getDay()];
      // Wochenendzeile hat das Datum vom Samstag; Sonntag gilt als erfasst, wenn Samstag erfasst ist
      const erfasst = t || (d.getDay() === 0 && alleTage.get(iso(new Date(d.getTime() - 86400000))));
      if (!erfasst) {
        if (soll > 0) { res.fehlendeTage.push(datum); res.fehlendeKW.push(kw(d)); }
        continue;
      }
      res.sollErfasst += soll;
      if (!t) continue;
      if (!t.geprueft && t.eintraege.length) ungeprueftKW.add(t.kw);
      const kats = new Set();
      for (const e of t.eintraege) {
        res.prod += e.prod; res.unprod += e.unprod; res.mehr += e.mehr; res.mind += e.mind;
        // "Mehrstunden vergüten" angekreuzt: der Saldo dieser Tage wird ausgezahlt statt aufs Arbeitszeitkonto gebucht
        if (t.verguetet) res.mehrVerguetet += e.mehr + e.mind;
        res.ausloese += e.ausloese || 0; res.fahrt += e.fahrt || 0;
        kats.add(e.kategorie);
        if (e.prod > 0 && (e.kategorie === 'baustelle' || e.kategorie === 'arbeit')) {
          const key = e.kostentraeger || e.beschreibung || 'ohne Angabe';
          const b = bs.get(key) || { kostentraeger: e.kostentraeger || '', name: e.beschreibung || '', stunden: 0, tage: new Set() };
          b.stunden += e.prod;
          b.tage.add(datum);
          if (!b.name && e.beschreibung) b.name = e.beschreibung;
          bs.set(key, b);
        }
      }
      kats.forEach(k => { if (k in res.tage) res.tage[k]++; });
    }

    ['prod', 'unprod', 'mehr', 'mind', 'ausloese', 'fahrt', 'sollErfasst', 'mehrVerguetet'].forEach(k => { res[k] = r2(res[k]); });
    res.ist = r2(res.prod + res.unprod);
    res.saldo = r2(res.mehr + res.mind);
    res.mehrVerguetet = r2(Math.max(res.mehrVerguetet, 0));
    res.saldoGesammelt = r2(res.saldo - res.mehrVerguetet);
    res.fehlendeKW = Array.from(new Set(res.fehlendeKW));
    res.ungeprueft = ungeprueftKW.size;
    res.vollstaendig = res.fehlendeTage.length === 0;
    res.baustellen = Array.from(bs.values()).map(b => ({ ...b, stunden: r2(b.stunden), tage: b.tage.size }))
      .sort((a, b) => b.stunden - a.stunden);

    // ---------- Abgleich mit dem Lohnzettel ----------
    const lohnDoc = findeLohn(docs, jahr, monat);
    const vm = monat === 1 ? [jahr - 1, 12] : [jahr, monat - 1];
    const vorDoc = findeLohn(docs, vm[0], vm[1]);
    res.lohn = lohnDoc ? lohnDoc.data : null;
    res.lohnGeprueft = lohnDoc ? lohnDoc.status === 'geprueft' : false;
    res.lohnVormonat = vorDoc ? vorDoc.data : null;
    const L = res.lohn;
    const A = res.abgleich;
    const add = (titel, zettel, lohn, status, hinweis) => A.push({ titel, zettel, lohn, status, hinweis });

    if (L) {
      // 1) Bezahlte Grundstunden = Monatssoll
      if (L.stundenlohn != null) {
        const grund = r2(L.stundenlohn + (L.azkAbbau || 0) - (L.azkAufbau || 0));
        add('Bezahlte Grundstunden (Stundenlohn + AZK-Abbau)', res.soll, grund, near(grund, res.soll) ? 'ok' : 'abw',
          near(grund, res.soll) ? 'Entspricht dem Monatssoll.' : `Abweichung ${r2(grund - res.soll)} Std. zum Monatssoll.`);
      }
      // 2) Stundenlohn = Ist − ausgezahlte Überstunden − aufs Konto gebuchte Mehrstunden
      if (L.stundenlohn != null) {
        const erwartet = r2(res.ist - res.mehrVerguetet - Math.max(res.saldoGesammelt, 0));
        if (res.vollstaendig) {
          add('Stundenlohn', erwartet, L.stundenlohn, near(erwartet, L.stundenlohn) ? 'ok' : 'abw',
            near(erwartet, L.stundenlohn) ? 'Passt zu deinen Wochenzetteln.' : `Abweichung ${r2(L.stundenlohn - erwartet)} Std.`);
        } else {
          add('Stundenlohn', erwartet, L.stundenlohn, 'info', 'Wochenzettel für diesen Monat unvollständig, Vergleich nicht möglich.');
        }
      }
      // 3) Fehlstunden werden vom Arbeitszeitkonto abgebaut
      if (res.vollstaendig) {
        const abbauErwartet = r2(Math.max(-res.saldoGesammelt, 0));
        const abbau = r2(L.azkAbbau || 0);
        add('Abbau Arbeitszeitkonto', abbauErwartet, abbau, near(abbauErwartet, abbau) ? 'ok' : 'abw',
          near(abbauErwartet, abbau) ? 'Passt zu deinem Monatssaldo.' : `Laut Wochenzetteln ${abbauErwartet} Std., abgerechnet ${abbau} Std.`);
        if (res.saldoGesammelt > 0) {
          const auf = L.azkAufbau;
          add('Aufbau Arbeitszeitkonto', res.saldoGesammelt, auf, auf == null ? 'info' : (near(auf, res.saldoGesammelt) ? 'ok' : 'abw'),
            auf == null ? 'Auf dem Lohnzettel steht kein Aufbau. Prüfe, ob der AZK-Stand gestiegen ist.' : '');
        }
      }
      // 4) Vergütete Überstunden
      if (res.mehrVerguetet > 0 || L.ueberstd || L.ueberstundenLohnart) {
        const lohnUe = r2(L.ueberstundenLohnart || L.ueberstd || 0);
        add('Vergütete Überstunden', res.mehrVerguetet, lohnUe, near(lohnUe, res.mehrVerguetet) ? 'ok' : 'abw', '');
      }
      // 5) Arbeitszeitkonto-Stand
      if (L.azkStand != null) {
        const vorStand = res.lohnVormonat && res.lohnVormonat.azkStand;
        if (vorStand != null && res.vollstaendig) {
          const veraenderung = r2(L.azkStand - vorStand);
          add('Veränderung Arbeitszeitkonto', res.saldoGesammelt, veraenderung, near(veraenderung, res.saldoGesammelt) ? 'ok' : 'abw',
            `Stand jetzt ${L.azkStand} Std., Vormonat ${vorStand} Std.`);
        } else {
          add('AZK-Stand laut Lohnzettel', null, L.azkStand, 'info',
            vorStand == null ? 'Zum Vergleich der Veränderung fehlt der Lohnzettel vom Vormonat.'
              : 'Wochenzettel für diesen Monat unvollständig, Vergleich nicht möglich.');
        }
      }
      // 6) Urlaub
      if (L.urlaubGenommen != null) {
        const vorGen = res.lohnVormonat && res.lohnVormonat.urlaubGenommen;
        if (vorGen != null && res.vollstaendig) {
          const imMonat = r2(L.urlaubGenommen - vorGen);
          add('Urlaubstage im Monat', res.tage.urlaub, imMonat, near(imMonat, res.tage.urlaub) ? 'ok' : 'abw', '');
        } else {
          add('Urlaubstage im Monat', res.tage.urlaub, null, 'info',
            `Lohnzettel: ${L.urlaubGenommen} Tage genommen im Jahr, Rest ${L.urlaubRest ?? '–'}. Für den Monatsvergleich fehlt der Lohnzettel vom Vormonat.`);
        }
      }
      // 7) Fahrgeld
      if (L.fahrgeldStd != null) {
        add('Fahrgeld-Stunden', res.fahrt || null, L.fahrgeldStd, 'info', 'Nur zur Info, die Regel dahinter kenne ich noch nicht.');
      }
    }
    return res;
  }

  const api = { auswerten, monateMitDaten, monatssoll, SOLL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Auswertung = api;
})(typeof self !== 'undefined' ? self : this);
