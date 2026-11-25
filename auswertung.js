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
  // Zahl für Hinweistexte: 25,5 statt 25.5, echtes Minus
  const de = v => (v == null ? '–' : String(r2(v)).replace('.', ',').replace('-', '−'));
  // Geldbetrag für Hinweistexte: 1.787,17 €
  const eur = v => (v == null ? '–' : `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`);
  const MONATSNAMEN = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const monatText = (j, m) => `${MONATSNAMEN[m - 1]} ${j}`;

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
        // Ein leerer Tag überschreibt keinen Tag mit Einträgen (z.B. zwei Zettel für eine Woche am Monatswechsel)
        const vorher = map.get(t.datum);
        if (vorher && vorher.eintraege.length && !(t.eintraege && t.eintraege.length)) return;
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

  // Letzter Lohnzettel vor diesem Monat (für den Vergleich der Stundensätze; Lücken sind egal)
  function frueherLohn(docs, jahr, monat) {
    const k = jahr * 12 + monat;
    const frueher = docs.filter(d => d.type === 'lohn' && d.data && d.data.jahr && d.data.monat && d.data.jahr * 12 + d.data.monat < k);
    if (!frueher.length) return null;
    const letzter = Math.max(...frueher.map(d => d.data.jahr * 12 + d.data.monat));
    const j = Math.floor((letzter - 1) / 12), m = letzter - j * 12;
    return findeLohn(docs, j, m);
  }

  // Satz einer Lohnart auf einem Lohnzettel (erste Zeile mit dieser Nummer)
  const satzVon = (L, nr) => {
    const p = (L.posten || []).find(x => x.nr === nr && x.satz != null);
    return p ? p.satz : nr === '1000' ? L.stundensatz ?? null : null;
  };

  // Geldbeträge: Stunden × Satz = Betrag je Lohnart, Stundensatz im Vergleich zum letzten Lohnzettel
  function geldPruefen(docs, res, L, geprueft) {
    const posten = L.posten || [];
    const vor = frueherLohn(docs, res.jahr, res.monat);
    const vorL = vor ? vor.data : null;
    const vorText = vorL ? monatText(vorL.jahr, vorL.monat) : '';
    const satz = satzVon(L, '1000');
    const vorSatz = vorL ? satzVon(vorL, '1000') : null;
    res.stundensatz = { jetzt: satz, vorher: vorSatz, vorherMonat: vorText, geaendert: satz != null && vorSatz != null && !near(satz, vorSatz) };
    const G = res.geld;
    const LP = (typeof self !== 'undefined' && self.LohnParser) || (typeof require !== 'undefined' ? require('./lohn-parser.js') : null);
    const feld = p => LP.stundenFeld(p.nr, p.bezeichnung);
    let summe = 0, fehlt = 0;
    posten.forEach(p => {
      if (p.betrag != null) summe += p.betrag; else fehlt++;
      const z = { titel: p.bezeichnung || p.nr, nr: p.nr, menge: p.menge, satz: p.satz, erwartet: null, betrag: p.betrag, status: 'info', hinweis: '' };
      G.push(z);
      if (!p.std) {
        if (/verpfl/i.test(p.bezeichnung)) z.hinweis = 'Tage und Sätze siehe Abgleich „Verpflegung“.';
        if (p.betrag == null) z.hinweis = 'Betrag nicht erkannt.';
        return;
      }
      const f = feld(p);
      if (!f) { z.hinweis = 'Zuschlag, wird nicht nachgerechnet.'; return; }
      if (p.menge == null || p.satz == null || p.betrag == null) {
        z.hinweis = `${p.satz == null ? 'Satz' : p.betrag == null ? 'Betrag' : 'Stunden'} auf dem Lohnzettel nicht erkannt. Öffne den Lohnzettel und trag ihn ein oder tippe „Neu auslesen“.`;
        return;
      }
      z.erwartet = r2(p.menge * p.satz);
      const rechnung = `${de(p.menge)} Std. × ${eur(p.satz)} = ${eur(z.erwartet)}`;
      if (Math.abs(z.erwartet - p.betrag) > 0.011) {
        z.status = 'abw';
        z.hinweis = `${rechnung}, auf dem Lohnzettel stehen ${eur(p.betrag)}. `
          + (geprueft ? `Differenz ${eur(r2(p.betrag - z.erwartet))}.` : 'Vergleich Satz und Betrag mit dem Foto, oft hat sich die Erkennung nur verlesen.');
        return;
      }
      z.status = 'ok';
      const extra = [];
      if (p.satzBerechnet) extra.push('Satz auf dem Foto schlecht lesbar, aus Betrag ÷ Stunden berechnet.');
      // Urlaub, Krank, Feiertag und AZK werden normalerweise mit dem Stundenlohn-Satz bezahlt
      if (['urlaubStd', 'krankStd', 'feiertagStd', 'azkAbbau', 'azkAufbau'].includes(f) && satz != null && !near(p.satz, satz)) {
        z.status = 'warn';
        extra.push(`Anderer Satz als beim Stundenlohn (${eur(satz)}). Frag im Zweifel im Lohnbüro nach.`);
      }
      if (f !== 'stundenlohn' && vorL) {
        const alt = satzVon(vorL, p.nr);
        if (alt != null && !near(alt, p.satz)) { z.status = 'warn'; extra.push(`Satz geändert: vorher ${eur(alt)} (${vorText}).`); }
      }
      if (f === 'stundenlohn' && res.stundensatz.geaendert) z.status = 'warn';
      z.hinweis = [rechnung + (extra.length ? '.' : ''), ...extra].join(' ');
    });
    if (posten.length) {
      res.geldSumme = { summe: r2(summe), fehlt };
    }
  }

  function auswerten(docs, jahr, monat) {
    const alleTage = sammleTage(docs);
    const kalender = tageImMonat(jahr, monat);
    const res = {
      jahr, monat,
      soll: monatssoll(jahr, monat), sollErfasst: 0,
      ist: 0, prod: 0, unprod: 0, mehr: 0, mind: 0, saldo: 0, mehrVerguetet: 0,
      tage: { baustelle: 0, arbeit: 0, krank: 0, urlaub: 0, feiertag: 0, gleitzeit: 0, lehrgang: 0, unproduktiv: 0, sonstiges: 0 },
      baustellen: [], ausloese: 0, fahrt: 0, verpflTage: {}, stdKat: { urlaub: 0, krank: 0, feiertag: 0 },
      fehlendeTage: [], fehlendeKW: [], ungeprueft: 0, vollstaendig: false,
      lohn: null, lohnVormonat: null, abgleich: [], geld: [], geldSumme: null, stundensatz: null,
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
        if (e.ausloese > 0) res.verpflTage[e.ausloese] = (res.verpflTage[e.ausloese] || 0) + 1;
        if (e.kategorie in res.stdKat) res.stdKat[e.kategorie] += e.prod + e.unprod;
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
    Object.keys(res.stdKat).forEach(k => { res.stdKat[k] = r2(res.stdKat[k]); });
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
    res.lohnId = lohnDoc ? lohnDoc.id : null;
    const L = res.lohn;
    const A = res.abgleich;
    const add = (titel, zettel, lohn, status, hinweis) => A.push({ titel, zettel, lohn, status, hinweis });

    if (L) {
      const abwLohn = (L.urlaubStd || 0) + (L.krankStd || 0) + (L.feiertagStd || 0) + (L.sonstigeStd || 0);
      const abwZettel = res.stdKat.urlaub + res.stdKat.krank + res.stdKat.feiertag;
      // 0) Passt der Lohnzettel in sich? Bez. Std. (Kopf) = Zeitlohn + Überstd. + Urlaub/Krank/Feiertag + AZK-Abbau.
      //    Wenn nicht, wurde meist eine Lohnart (z.B. Urlaubsstunden) beim Auslesen nicht erkannt.
      if (L.bezahltStd != null && L.zeitlohnStd != null) {
        const erkannt = r2(L.zeitlohnStd + (L.ueberstd || 0) + (L.azkAbbau || 0) + abwLohn);
        if (!near(erkannt, L.bezahltStd)) res.lohnLuecke = { bezahlt: L.bezahltStd, erkannt, fehlt: r2(L.bezahltStd - erkannt) };
      }
      const luecke = res.lohnLuecke;
      // 1) Bezahlte Grundstunden (Stundenlohn + Urlaub + Krank + Feiertag + AZK-Abbau) = Monatssoll
      if (L.stundenlohn != null) {
        const grund = r2(L.stundenlohn + abwLohn + (L.azkAbbau || 0) - (L.azkAufbau || 0));
        add('Bezahlte Grundstunden (Stundenlohn + Urlaub + Krank + AZK-Abbau)', res.soll, grund, near(grund, res.soll) ? 'ok' : 'abw',
          near(grund, res.soll) ? 'Entspricht dem Monatssoll.'
            : luecke ? `Der Lohnzettel ist nicht vollständig ausgelesen: Laut Kopf ${de(luecke.bezahlt)} bezahlte Std., erkannt nur ${de(luecke.erkannt)}. Es fehlen ${de(luecke.fehlt)} Std., meist Urlaubs- oder Krankstunden. Öffne den Lohnzettel und tippe „Neu auslesen“ oder trag die Werte ein.`
            : `Abweichung ${de(grund - res.soll)} Std. zum Monatssoll.`);
      }
      // 2) Stundenlohn = gearbeitete Stunden (Ist ohne Urlaub/Krank/Feiertag) − ausgezahlte Überstunden − aufs Konto gebuchte Mehrstunden
      if (L.stundenlohn != null) {
        const erwartet = r2(res.ist - abwZettel - res.mehrVerguetet - Math.max(res.saldoGesammelt, 0));
        if (res.vollstaendig) {
          add('Stundenlohn', erwartet, L.stundenlohn, near(erwartet, L.stundenlohn) ? 'ok' : 'abw',
            near(erwartet, L.stundenlohn) ? 'Passt zu deinen Wochenzetteln.' : `Abweichung ${de(L.stundenlohn - erwartet)} Std.`);
        } else {
          add('Stundenlohn', erwartet, L.stundenlohn, 'info', 'Wochenzettel für diesen Monat unvollständig, Vergleich nicht möglich.');
        }
      }
      // 2b) Urlaubs-, Krank- und Feiertagsstunden einzeln
      [['urlaub', 'urlaubStd', 'Urlaubsstunden'], ['krank', 'krankStd', 'Krankstunden'], ['feiertag', 'feiertagStd', 'Feiertagsstunden']]
        .forEach(([kat, feld, titel]) => {
          const z = res.stdKat[kat];
          const l = r2(L[feld] || 0);
          if (!z && !l) return;
          if (res.vollstaendig) {
            add(titel, z, l, near(z, l) ? 'ok' : 'abw', near(z, l) ? ''
              : L[feld] == null && luecke ? 'Auf dem Lohnzettel nicht erkannt. Bitte den Lohnzettel prüfen.'
              : `Laut Wochenzetteln ${de(z)} Std., abgerechnet ${de(l)} Std.`);
          } else {
            add(titel, z, l, 'info', 'Wochenzettel für diesen Monat unvollständig, Vergleich nicht möglich.');
          }
        });
      // 3) Fehlstunden werden vom Arbeitszeitkonto abgebaut
      if (res.vollstaendig) {
        const abbauErwartet = r2(Math.max(-res.saldoGesammelt, 0));
        const abbau = r2(L.azkAbbau || 0);
        add('Abbau Arbeitszeitkonto', abbauErwartet, abbau, near(abbauErwartet, abbau) ? 'ok' : 'abw',
          near(abbauErwartet, abbau) ? 'Passt zu deinem Monatssaldo.' : `Laut Wochenzetteln ${de(abbauErwartet)} Std., abgerechnet ${de(abbau)} Std.`);
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
            `Stand jetzt ${de(L.azkStand)} Std., Vormonat ${de(vorStand)} Std.`);
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
          add('Urlaubstage im Monat', res.tage.urlaub, imMonat, near(imMonat, res.tage.urlaub) ? 'ok' : 'abw',
            near(imMonat, res.tage.urlaub) ? ''
              : `„Urlaub genommen“ auf dem Lohnzettel: ${de(L.urlaubGenommen)} Tage, im Vormonat ${de(vorGen)}. `
                + (imMonat < res.tage.urlaub ? 'Fehlende Tage werden manchmal erst im Folgemonat abgezogen – schau dann auf den nächsten Lohnzettel.'
                  : 'Vielleicht wurden Tage aus einem Vormonat nachgebucht.'));
        } else {
          add('Urlaubstage im Monat', res.tage.urlaub, null, 'info',
            `Lohnzettel: ${L.urlaubGenommen} Tage genommen im Jahr, Rest ${L.urlaubRest ?? '–'}. Für den Monatsvergleich fehlt der Lohnzettel vom Vormonat.`);
        }
      }
      // 7) Fahrgeld-Stunden = Stunden "Vergütung Fahrtätigkeit" laut Wochenzetteln
      if (L.fahrgeldStd != null || res.fahrt > 0) {
        const z = r2(res.fahrt), l = r2(L.fahrgeldStd || 0);
        if (res.vollstaendig) {
          add('Fahrgeld-Stunden', z, l, near(z, l) ? 'ok' : 'abw',
            near(z, l) ? 'Passt zur Fahrtätigkeit auf deinen Wochenzetteln.' : `Laut Wochenzetteln ${de(z)} Std. Fahrtätigkeit, abgerechnet ${de(l)} Std.`);
        } else {
          add('Fahrgeld-Stunden', z, l, 'info', 'Wochenzettel für diesen Monat unvollständig, Vergleich nicht möglich.');
        }
      }
      // 8) Verpflegung (Auslöse/Verpfl. in €)
      if (L.verpflegungEuro != null || res.ausloese > 0) {
        const z = r2(res.ausloese);
        if (L.verpflegungEuro == null) {
          add('Verpflegung, €', z, null, 'info', 'Auf dem Lohnzettel nicht erkannt. Du kannst den Betrag beim Prüfen eintragen.');
        } else if (res.vollstaendig) {
          const l = r2(L.verpflegungEuro);
          const tageText = m => Object.keys(m).map(Number).sort((a, b) => a - b).map(k => `${m[k]} × ${k} €`).join(', ');
          const lohnTage = {};
          (L.verpflegung || []).forEach(v => { if (v.satz && v.tage) lohnTage[v.satz] = (lohnTage[v.satz] || 0) + v.tage; });
          const detail = `Wochenzettel: ${tageText(res.verpflTage) || '–'}.` + (Object.keys(lohnTage).length ? ` Lohnzettel: ${tageText(lohnTage)}.` : '');
          add('Verpflegung, €', z, l, near(z, l) ? 'ok' : 'abw',
            near(z, l) ? '' : `${detail} ${l > z ? `Dir wurden ${de(l - z)} € mehr bezahlt.` : `Es fehlen ${de(z - l)} €.`}`);
        } else {
          add('Verpflegung, €', z, L.verpflegungEuro, 'info', 'Wochenzettel für diesen Monat unvollständig, Vergleich nicht möglich.');
        }
      }
      geldPruefen(docs, res, L, res.lohnGeprueft);
    }
    return res;
  }

  /* ---------- Jahresübersicht ---------- */
  // Arbeitszeitkonto und Urlaub werden über Lohnzettel-Lücken hinweg verkettet: fehlt z.B. der September,
  // wird der Oktober mit dem August verglichen (wenn die Wochenzettel dazwischen vollständig sind).
  function jahresuebersicht(docs, jahr) {
    const mitDaten = new Set(monateMitDaten(docs).filter(k => k.startsWith(`${jahr}-`)).map(k => parseInt(k.slice(5), 10)));
    const letzter = Math.max(0, ...mitDaten);
    const out = { jahr, monate: [], summe: { ist: 0, sollErfasst: 0, saldo: 0, saldoGesammelt: 0, fahrt: 0, ausloese: 0, urlaubTage: 0, krankTage: 0, krankStdLohn: 0, abw: 0 },
      baustellen: [], azkAktuell: null, urlaub: null, urlaubOffen: null, saetze: [] };
    const bs = new Map();
    // Startwerte aus dem Dezember des Vorjahres (falls vorhanden); "Urlaub genommen" beginnt jedes Jahr bei 0
    const dez = findeLohn(docs, jahr - 1, 12);
    let azkBasis = dez && dez.data.azkStand != null ? { stand: dez.data.azkStand, monat: 0, text: monatText(jahr - 1, 12) } : null;
    let azkSumme = 0, azkLueckenlos = true;
    let urlBasis = { genommen: 0, monat: 0, text: 'Jahresbeginn' };
    let urlSumme = 0, urlLueckenlos = true, offen = null; // offen: Urlaubstage laut Wochenzetteln, die noch nicht abgezogen sind
    let satzVorher = null;

    for (let m = 1; m <= letzter; m++) {
      const r = auswerten(docs, jahr, m);
      const L = r.lohn;
      const hat = mitDaten.has(m);
      const z = {
        monat: m, hatDaten: hat, hatWochen: r.sollErfasst > 0 || r.ist > 0, vollstaendig: r.vollstaendig, ist: r.ist, soll: r.vollstaendig ? r.soll : r.sollErfasst,
        saldo: r.saldoGesammelt, lohn: !!L, abw: r.abgleich.filter(a => a.status === 'abw').length + r.geld.filter(g => g.status === 'abw').length,
        urlaubTage: r.tage.urlaub, krankTage: r.tage.krank, krankStdLohn: L ? L.krankStd : null, fehlendeTage: r.fehlendeTage.length,
        azkStand: L ? L.azkStand : null, azkErwartet: null, azkStatus: null, azkHinweis: '',
        urlaubGenommen: L ? L.urlaubGenommen : null, urlaubAbgezogen: null, urlaubOffen: null, urlaubStatus: null, urlaubHinweis: '',
        stundensatz: L ? satzVon(L, '1000') : null,
      };
      out.monate.push(z);
      const S = out.summe;
      if (hat) {
        S.ist += r.ist; S.sollErfasst += z.soll; S.saldo += r.saldo; S.saldoGesammelt += r.saldoGesammelt;
        S.fahrt += r.fahrt; S.ausloese += r.ausloese; S.urlaubTage += r.tage.urlaub; S.krankTage += r.tage.krank;
        S.krankStdLohn += (L && L.krankStd) || 0; S.abw += z.abw;
      }
      r.baustellen.forEach(b => {
        const key = b.kostentraeger || b.name;
        const x = bs.get(key) || { kostentraeger: b.kostentraeger, name: b.name, stunden: 0, tage: 0, monate: [] };
        x.stunden += b.stunden; x.tage += b.tage; x.monate.push(m);
        if (!x.name && b.name) x.name = b.name;
        bs.set(key, x);
      });

      // Arbeitszeitkonto
      if (azkBasis) { azkSumme += r.saldoGesammelt; if (!r.vollstaendig) azkLueckenlos = false; }
      if (L && L.azkStand != null) {
        if (azkBasis && azkLueckenlos) {
          z.azkErwartet = r2(azkBasis.stand + azkSumme);
          z.azkStatus = near(z.azkErwartet, L.azkStand) ? 'ok' : 'abw';
          const seit = azkBasis.monat === m - 1 ? '' : ` (verglichen mit ${azkBasis.text}, dazwischen fehlt ein Lohnzettel)`;
          z.azkHinweis = z.azkStatus === 'ok' ? (seit ? `Passt${seit}.` : '')
            : `Erwartet ${de(z.azkErwartet)} Std.: Stand ${azkBasis.text} ${de(azkBasis.stand)} ${azkSumme >= 0 ? '+' : '−'} ${de(Math.abs(r2(azkSumme)))} laut Wochenzetteln${seit}.`;
        } else {
          z.azkStatus = 'info';
          z.azkHinweis = azkBasis ? 'Wochenzettel unvollständig, Vergleich nicht möglich.' : 'Erster Lohnzettel mit AZK-Stand, noch kein Vergleich.';
        }
        azkBasis = { stand: L.azkStand, monat: m, text: monatText(jahr, m) };
        azkSumme = 0; azkLueckenlos = true;
        out.azkAktuell = { stand: L.azkStand, monat: m };
      }

      // Urlaub: Tage laut Wochenzetteln gegen "Urlaub genommen" auf dem Lohnzettel
      urlSumme += r.tage.urlaub;
      if (!r.vollstaendig) urlLueckenlos = false;
      if (L && L.urlaubGenommen != null) {
        z.urlaubAbgezogen = r2(L.urlaubGenommen - urlBasis.genommen);
        const seit = urlBasis.monat === m - 1 ? '' : ` seit ${urlBasis.text}`;
        if (urlLueckenlos) {
          // Kette läuft weiter (oder beginnt hier): Differenz dieses Zeitraums dazurechnen
          const vorher = offen || 0;
          offen = r2(vorher + urlSumme - z.urlaubAbgezogen);
          z.urlaubOffen = offen;
          z.urlaubStatus = near(offen, 0) ? 'ok' : 'warn';
          z.urlaubHinweis = near(offen, 0) ? (vorher > 0 && z.urlaubAbgezogen > urlSumme ? `Die ${de(vorher)} offenen Tag(e) wurden nachgebucht, jetzt passt alles.` : '')
            : offen > 0 ? `${de(offen)} Urlaubstag(e) laut Wochenzetteln noch nicht abgezogen. Das wird oft im Folgemonat nachgebucht.`
            : `${de(-offen)} Tag(e) mehr abgezogen, als auf deinen Wochenzetteln stehen${seit}.`;
        } else {
          offen = null;
          z.urlaubStatus = 'info';
          z.urlaubHinweis = urlBasis.monat === 0 && !out.urlaub ? 'Für den Vergleich fehlen Wochenzettel aus den Monaten davor.'
            : `Wochenzettel unvollständig. Abgezogen${seit}: ${de(z.urlaubAbgezogen)} Tag(e), auf den vorhandenen Wochenzetteln: ${de(urlSumme)}.`;
        }
        urlBasis = { genommen: L.urlaubGenommen, monat: m, text: monatText(jahr, m) };
        urlSumme = 0; urlLueckenlos = true;
        out.urlaub = { anspruch: L.urlaubAnspruch, genommen: L.urlaubGenommen, rest: L.urlaubRest, monat: m };
        out.urlaubOffen = offen == null ? null : { tage: offen, monat: m };
      }

      // Stundensatz-Verlauf
      if (z.stundensatz != null) {
        if (satzVorher == null || !near(satzVorher, z.stundensatz)) out.saetze.push({ monat: m, satz: z.stundensatz, vorher: satzVorher });
        satzVorher = z.stundensatz;
      }
    }
    Object.keys(out.summe).forEach(k => { out.summe[k] = r2(out.summe[k]); });
    out.baustellen = Array.from(bs.values()).map(b => ({ ...b, stunden: r2(b.stunden) })).sort((a, b) => b.stunden - a.stunden);
    return out;
  }

  const api = { auswerten, jahresuebersicht, monateMitDaten, monatssoll, sammleTage, SOLL, eur };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Auswertung = api;
})(typeof self !== 'undefined' ? self : this);
