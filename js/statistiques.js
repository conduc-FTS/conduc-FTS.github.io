/**
 * statistiques.js — onglets Statistiques de la Supervision (ordinateur) :
 *   - Vendu / réalisé  : a-t-on tenu ce qu'on a vendu ?
 *   - Temps perdu      : pannes et arrêts, classés interne / à réclamer / neutre
 *   - Parc matériel    : utilisation et fiabilité des foreuses et centrales
 *   - Bilans           : fiche de fin de chantier (+ PDF) et cadences réelles
 *
 * Règle (Clément) : TOUTES les statistiques portent uniquement sur les
 * chantiers terminés et archivés — un chantier en cours se suit sur son
 * Détail chantier. La période retient les chantiers dont le dernier
 * rapport tombe dans la période.
 *
 * Données : la lecture groupée de la Vue d'ensemble (chantiers actifs,
 * Materiel + Production), complétée par les onglets Pannes / Arrets et par
 * les chantiers archivés (gardés en copie locale : ils ne changent plus).
 *
 * FTSStats.monter(conteneur, { obtenirDonnees }) puis FTSStats.ouvrir("vr"|"tp"|"parc"|"bilans").
 * Nécessite drive.js, sheets.js, parc-materiel.js, ateliers.js.
 */
const FTSStats = (() => {
  const CLE_ARCHIVES = "fts_stats_archives_v1";
  const TTL = 120000;
  const H_JOUR = 8; // heures d'un jour d'atelier (conversion h → j)

  let racine = null;
  let opts = {};
  let jeu = null;          // { chargeA, chantiers: [...] }
  let enCours = null;
  let onglet = "vr";
  let periode = "annee";
  let bilanSel = null;
  let derniereErreur = "";

  // ─── Outils ──────────────────────────────────────────────────
  const esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  const nb = (v) => parseFloat(String(v == null ? "" : v).replace(",", ".")) || 0;
  const fmt = (n, d = 0) => Number(n).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmt1 = (n) => fmt(n, Math.abs(n - Math.round(n)) < 0.05 ? 0 : 1);
  const euros = (n) => fmt(n, 0) + " €";
  const signe = (n) => (n > 0.05 ? "+" : n < -0.05 ? "−" : "") + fmt1(Math.abs(n));
  const parseFR = (s) => { const [j, m, a] = String(s || "").split("/"); return j && m && a ? new Date(+a, +m - 1, +j) : null; };
  const jj = (d) => d ? String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") : "";
  const jja = (d) => d ? jj(d) + "/" + d.getFullYear() : "";
  const sansAccent = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const code = (nom) => { const i = String(nom).search(/\s/); return i > 0 ? String(nom).slice(0, i) : String(nom); };
  const libelle = (nom) => { const i = String(nom).search(/\s/); return i > 0 ? String(nom).slice(i + 1) : String(nom); };
  // Nom court : 3 mots utiles (le « - » ne compte pas), sans finir sur un tiret ni sur « de », « la »…
  const PETITS_MOTS = /^(de|du|des|d'|la|le|les|l'|à|a|au|aux|en|et|sur)$/i;
  const court = (nom) => {
    const mots = libelle(nom).split(/\s+/).filter(Boolean), garde = [];
    let n = 0;
    for (const m of mots) { const sep = /^[-–—·]$/.test(m); if (!sep && n === 3) break; garde.push(m); if (!sep) n++; }
    while (garde.length > 1 && (/^[-–—·]$/.test(garde[garde.length - 1]) || PETITS_MOTS.test(garde[garde.length - 1]))) garde.pop();
    return garde.join(" ");
  };
  const nomChantier = (nom) => `<span class="st-code">${esc(code(nom))}</span>${esc(libelle(nom))}`;

  function bornes() {
    const n = new Date();
    if (periode === "annee") return [new Date(n.getFullYear(), 0, 1), new Date(n.getFullYear(), 11, 31)];
    if (periode === "12m") return [new Date(n.getFullYear() - 1, n.getMonth(), n.getDate() + 1), new Date(n.getFullYear(), n.getMonth(), n.getDate())];
    if (periode === "an-1") return [new Date(n.getFullYear() - 1, 0, 1), new Date(n.getFullYear() - 1, 11, 31)];
    return [null, null];
  }
  const dansPeriode = (d, [deb, fin]) => !!d && (!deb || (d >= deb && d <= fin));

  // ─── Classement des motifs d'arrêt (validé avec Clément) ───────
  const CATS = {
    panne: { lib: "Pannes matériel", grp: "interne", col: "#C0392B" },
    appro: { lib: "Attente coulis / matériaux", grp: "interne", col: "#E57368" },
    client: { lib: "Client / MOE (attente, implantation, accès, réseau / obstacle)", grp: "reclamer", col: "#E08A00" },
    meteo: { lib: "Météo", grp: "neutre", col: "#4C82F0" },
    beton: { lib: "Attente béton (fournisseur)", grp: "neutre", col: "#9AA0AA" },
    autre: { lib: "Autres motifs", grp: "neutre", col: "#C9CDD3" },
  };
  const GRP = { interne: ["interne", "st-t-int"], reclamer: ["à réclamer", "st-t-cli"], neutre: ["neutre", "st-t-neu"] };
  function categorieArret(motif) {
    const m = sansAccent(motif);
    if (/COULIS|MATERIAU/.test(m)) return "appro";
    if (/BETON/.test(m)) return "beton";
    if (/METEO|INTEMPERIE|PLUIE|ORAGE|NEIGE|GEL\b|VENT/.test(m)) return "meteo";
    if (/CLIENT|MOE|MAITR|IMPLANT|ACCES|RESEAU|OBSTACLE/.test(m)) return "client";
    return "autre";
  }
  const tag = (grp) => `<span class="st-tag ${GRP[grp][1]}">${GRP[grp][0]}</span>`;

  // ─── Chargement ──────────────────────────────────────────────
  function lireCacheArchives() {
    try {
      const c = JSON.parse(localStorage.getItem(CLE_ARCHIVES) || "null");
      const compte = (window.FTSAuth && FTSAuth.emailMemorise && FTSAuth.emailMemorise()) || "";
      if (c && c.compte === compte && c.ids) return c;
    } catch (e) {}
    return { compte: (window.FTSAuth && FTSAuth.emailMemorise && FTSAuth.emailMemorise()) || "", ids: {} };
  }
  function ecrireCacheArchives(c) { try { localStorage.setItem(CLE_ARCHIVES, JSON.stringify(c)); } catch (e) {} }

  async function charger(forcer = false) {
    if (!forcer && jeu && Date.now() - jeu.chargeA < TTL) { afficher(); return; }
    if (enCours) return enCours;
    enCours = (async () => {
      derniereErreur = "";
      if (!jeu) afficher();
      majEtat("Chargement…");
      try {
        const refs = window.FTSParc ? FTSParc.charger({ rapide: true }).catch(() => {}) : null;
        const d = await opts.obtenirDonnees(forcer);
        const connecte = window.FTSAuth && FTSAuth.isSignedIn();
        // Chantiers archivés : copie locale, seuls les nouveaux sont lus
        const cache = lireCacheArchives();
        let archives = [];
        if (connecte) {
          try { archives = await FTSDrive.listChantiersArchives(); } catch (e) { console.warn("Statistiques : archives illisibles", e); archives = null; }
        }
        if (archives) {
          // Montants encore dans la description des dossiers archivés → Marchés
          const aMigrer = archives.map((a) => ({ id: a.id, name: a.name, meta: FTSDrive.parseMetadonnees(a.description) }));
          FTSDrive.migrerMontants(aMigrer).catch((e) => console.warn("Migration des montants (archives) :", e));
          const manquants = archives.filter((a) => !cache.ids[a.id]);
          if (manquants.length) {
            const suivis = await FTSSheets.chargerDonneesSupervision(manquants.map((a) => ({ id: a.id, name: a.name })));
            const pa = await FTSSheets.lirePannesArrets(suivis);
            manquants.forEach((a, i) => {
              const s = suivis[i] || {};
              if (s.erreur) return; // on réessaiera la prochaine fois
              cache.ids[a.id] = { name: a.name, meta: FTSDrive.parseMetadonnees(a.description), materiel: s.materiel || [], production: s.production || [], pannes: (pa[a.id] || {}).pannes || [], arrets: (pa[a.id] || {}).arrets || [] };
            });
          }
          const garder = new Set(archives.map((a) => a.id));
          Object.keys(cache.ids).forEach((id) => { if (!garder.has(id)) delete cache.ids[id]; });
          ecrireCacheArchives(cache);
        }
        const termines = new Set(d.chantiers.filter((c) => (c.meta || {}).statutChantier === "Termine" || (c.meta || {}).archive).map((c) => c.id));
        const pa = connecte ? await FTSSheets.lirePannesArrets((d.suivis || []).filter((x) => x && termines.has(x.id))) : {};
        const actifs = d.chantiers.map((c, i) => {
          const s = d.suivis[i] || {};
          return { id: c.id, name: c.name, meta: c.meta || {}, materiel: s.materiel || [], production: s.production || [], pannes: (pa[c.id] || {}).pannes || [], arrets: (pa[c.id] || {}).arrets || [], archive: false };
        });
        const vus = new Set(actifs.map((c) => c.id));
        // Montants : toujours ceux du classeur Marchés (encadrement)
        const marches = await FTSDrive.lireMarches().catch(() => new Map());
        const arch = Object.entries(cache.ids).filter(([id]) => !vus.has(id)).map(([id, c]) => ({ id, ...c, meta: FTSDrive.appliquerMontants(id, c.meta || {}, marches), archive: true }));
        await refs;
        jeu = { chargeA: Date.now(), chantiers: [...actifs, ...arch].map(analyser), complet: !!connecte };
      } catch (e) {
        console.error("Statistiques :", e);
        derniereErreur = e.message || String(e);
      } finally {
        enCours = null;
        afficher();
      }
    })();
    return enCours;
  }

  // ─── Calcul par chantier ─────────────────────────────────────
  function analyser(c) {
    const meta = c.meta || {};
    const tech = FTSDrive.techniquesChantier(meta);
    const mp = tech.includes("Micropieux") || tech.includes("Battage");
    const prevuPrincipal = (tech.includes("Micropieux") ? Number(meta.micropieuxPrevus) || 0 : 0)
      + (tech.includes("Battage") ? Number(meta.battagePrevus || (!tech.includes("Micropieux") ? meta.micropieuxPrevus : 0)) || 0 : 0);
    const avenants = Array.isArray(meta.avenants) ? meta.avenants : [];
    const avMpx = avenants.reduce((s, a) => s + (Number(a.mpx) || 0), 0);
    const prevu = prevuPrincipal + avMpx;
    const joursVendus = (Number(meta.dureeChantier) || 0) + avenants.reduce((s, a) => s + (Number(a.jours) || 0), 0);
    const montant = (Number(meta.montantVendu) || 0) + avenants.reduce((s, a) => s + (Number(a.montant) || 0), 0);

    const prod = (c.production || []).filter((r) => parseFR(r[0]));
    const dates = [...new Set(prod.map((r) => r[0]))].sort((a, b) => parseFR(a) - parseFR(b));
    const jours = dates.length;
    const realise = prod.reduce((s, r) => s + nb(r[1]), 0);
    const ml = prod.reduce((s, r) => s + nb(r[2]), 0);
    const termine = meta.statutChantier === "Termine" || !!meta.archive || !!c.archive;
    const etat = termine ? "termine" : jours ? "cours" : "attente";
    const cadR = jours ? realise / jours : null;
    const cadV = prevu && joursVendus ? prevu / joursVendus : null;
    let projetes = null;
    if (etat === "cours" && prevu && cadR > 0) projetes = realise >= prevu ? jours : jours + (prevu - realise) / cadR;
    const joursRef = termine ? jours : projetes;
    const ecart = joursVendus && jours && joursRef != null ? joursRef - joursVendus : null;
    // CA / jour = montant (marché + avenants) ÷ jours de rapport (chantier terminé)
    const caProduit = montant ? (termine ? montant : (prevu ? montant * Math.min(1, realise / prevu) : null)) : null;
    const caJour = caProduit != null && jours ? caProduit / jours : null;
    const ecartMpx = termine && prevu ? realise - prevu : null;
    const chefs = [...new Set(prod.map((r) => String(r[4] || "").trim()).filter(Boolean))];
    const pannes = (c.pannes || []).filter((r) => parseFR(r[0])).map((r) => ({ d: parseFR(r[0]), ds: r[0], quoi: String(r[1] || "").trim() || "—", h: nb(r[2]), obs: r[3] || "", atelier: r[4] || "", cat: "panne" }));
    const arrets = (c.arrets || []).filter((r) => parseFR(r[0])).map((r) => ({ d: parseFR(r[0]), ds: r[0], quoi: String(r[1] || "").trim() || "Arrêt", h: nb(r[2]), obs: r[3] || "", atelier: r[4] || "", cat: categorieArret(r[1]) }));
    return {
      ...c, meta, tech, mp, prevu, avMpx, nbAvenants: avenants.length, joursVendus, montant, prod, dates, jours, realise, ml,
      termine, etat, cadR, cadV, projetes, ecart, caProduit, caJour, ecartMpx, chefs, evts: [...pannes, ...arrets],
      lMoy: realise ? ml / realise : null,
      premier: dates.length ? parseFR(dates[0]) : null,
      dernier: dates.length ? parseFR(dates[dates.length - 1]) : null,
    };
  }

  // Chantiers retenus : micropieux, TERMINÉS ou ARCHIVÉS, avec au moins un
  // rapport, dont le dernier rapport tombe dans la période choisie.
  function chantiersFiltres() {
    const b = bornes();
    return jeu.chantiers.filter((c) => c.mp && c.etat === "termine" && c.jours && (!b[0] || dansPeriode(c.dernier, b)));
  }

  // ─── Montage ─────────────────────────────────────────────────
  function monter(el, o) {
    racine = el;
    opts = o || {};
    racine.innerHTML = `
      <div class="st-filters">
        <span class="st-chip on">Micropieux + Battage</span>
        <span class="st-chip off" title="Le rapport journalier pieux n'existe pas encore">Pieux · à venir</span>
        <select id="stPeriode">
          <option value="annee">Cette année</option>
          <option value="12m">12 derniers mois</option>
          <option value="an-1">Année dernière</option>
          <option value="tout">Toutes périodes</option>
        </select>
        <span class="st-etat" title="Un chantier en cours se suit sur son Détail chantier">Chantiers terminés et archivés uniquement</span>
        <span class="st-sp"></span>
        <span class="st-etat" id="stEtat"></span>
        <button type="button" class="st-btn" id="stExport">⬇ Exporter Excel</button>
      </div>
      <div id="stVue"></div>`;
    racine.querySelector("#stPeriode").addEventListener("change", (e) => { periode = e.target.value; afficher(); });
    racine.querySelector("#stExport").addEventListener("click", exporter);
    racine.addEventListener("click", (e) => {
      const b = e.target.closest("[data-bilan]");
      if (b) { bilanSel = b.dataset.bilan; afficher(); return; }
      if (e.target.closest("#stPdf")) genererPdf();
      const lien = e.target.closest("[data-detail]");
      if (lien) location.href = `../detail-chantier/index.html?id=${encodeURIComponent(lien.dataset.detail)}&name=${encodeURIComponent(lien.dataset.nom)}`;
    });
  }

  function ouvrir(o) {
    onglet = o || onglet;
    afficher();
    charger(false);
  }

  function majEtat(txt) { const e = racine && racine.querySelector("#stEtat"); if (e) e.textContent = txt || ""; }

  function afficher() {
    if (!racine) return;
    const vue = racine.querySelector("#stVue");
    if (!jeu) {
      vue.innerHTML = `<div class="st-vide">${derniereErreur ? "Erreur : " + esc(derniereErreur) : enCours ? "Chargement des statistiques…" : "Connecte-toi pour afficher les statistiques."}</div>`;
      return;
    }
    majEtat(enCours ? "Actualisation…" : derniereErreur ? "Erreur : " + derniereErreur : "");
    try {
      vue.innerHTML = onglet === "tp" ? vueTempsPerdu() : onglet === "parc" ? vueParc() : onglet === "bilans" ? vueBilans() : vueVenduRealise();
    } catch (e) {
      console.error(e);
      vue.innerHTML = `<div class="st-vide">Erreur d'affichage : ${esc(e.message)}</div>`;
    }
  }

  const kpi = (l, v, s, cls = "") => `<div class="st-kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s || ""}</div></div>`;
  const vide = (t) => `<div class="st-vide">${t}</div>`;
  const barre = (pct, coul) => `<span class="st-bar"><i style="width:${Math.max(0, Math.min(100, pct))}%${coul ? ";background:" + coul : ""}"></i></span>`;

  // ═══ 1. VENDU / RÉALISÉ ═══════════════════════════════════════
  function lignesVR() {
    const ordre = { cours: 0, termine: 1, attente: 2 };
    return chantiersFiltres().sort((a, b) => (ordre[a.etat] - ordre[b.etat]) || ((b.ecart ?? -99) - (a.ecart ?? -99)) || a.name.localeCompare(b.name));
  }
  function vueVenduRealise() {
    const L = lignesVR();
    if (!L.length) return vide("Aucun chantier micropieux terminé sur cette période. Un chantier entre dans les statistiques quand il est marqué « Terminé » sur son Détail chantier (ou archivé).");
    const dem = L.filter((c) => c.jours);
    const nT = L.filter((c) => c.etat === "termine").length, nC = L.filter((c) => c.etat === "cours").length, nA = L.filter((c) => c.etat === "attente").length;
    const avecEcart = dem.filter((c) => c.ecart != null);
    const ecartTot = avecEcart.reduce((s, c) => s + c.ecart, 0);
    const vendusTot = avecEcart.reduce((s, c) => s + c.joursVendus, 0);
    const dep = avecEcart.filter((c) => c.ecart > 0.5);
    const avecCa = dem.filter((c) => c.caJour != null);
    const caMoy = avecCa.length ? avecCa.reduce((s, c) => s + c.caProduit, 0) / avecCa.reduce((s, c) => s + c.jours, 0) : null;
    const caMin = avecCa.length ? Math.min(...avecCa.map((c) => c.caJour)) : 0, caMax = avecCa.length ? Math.max(...avecCa.map((c) => c.caJour)) : 0;

    const kpis = `<div class="st-kpis">
      ${kpi("Chantiers terminés analysés", L.length, (() => { const na = L.filter((c) => c.archive).length, nt = L.length - na; return [nt && `${nt} terminé${nt > 1 ? "s" : ""}`, na && `${na} archivé${na > 1 ? "s" : ""}`].filter(Boolean).join(" · "); })())}
      ${kpi("Écart de jours (vendu → réel)", avecEcart.length ? `${signe(ecartTot)} <small>j</small>` : "—", avecEcart.length ? `sur ${fmt1(vendusTot)} j vendus` : "durée vendue non renseignée", avecEcart.length ? (ecartTot > 0.5 ? "alert" : "ok") : "")}
      ${kpi("Chantiers en dépassement", `${dep.length} <small>/ ${avecEcart.length}</small>`, dep.length ? `${fmt1(dep.reduce((x, c) => x + c.ecart, 0))} j de dépassement au total` : "aucun", dep.length ? "warn" : "")}
      ${kpi("CA par jour de rapport", caMoy != null ? `${fmt(caMoy)} <small>€/j</small>` : "—", caMoy != null ? (avecCa.length > 1 ? `de ${fmt(caMin)} à ${fmt(caMax)} €/j selon le chantier` : "1 chantier") : "montants non renseignés")}
    </div>`;

    // Graphique des écarts
    const graph = [...avecEcart].sort((a, b) => b.ecart - a.ecart);
    const maxAbs = Math.max(1, ...graph.map((c) => Math.abs(c.ecart)));
    const lignesGraph = graph.map((c) => {
      const w = Math.abs(c.ecart) / maxAbs * 46;
      const coul = c.ecart > 0.5 ? "#C0392B" : c.ecart > 0.05 ? "#E08A00" : "#1E8E4E";
      const proj = c.etat === "cours";
      return `<div class="st-div-row"><span class="st-ell">${nomChantier(c.name)}</span><div class="st-axis"><i style="${c.ecart >= 0 ? "left:50%" : `left:${50 - w}%`};width:${Math.max(w, 0.8)}%;background:${coul};${proj ? "opacity:.55" : ""}"></i></div><b class="${c.ecart > 0.5 ? "st-bad" : c.ecart < -0.05 ? "st-good" : ""}">${signe(c.ecart)} j${proj ? "*" : ""}</b></div>`;
    }).join("");

    const prio = priorites(L);
    const haut = `<div class="st-grid2">
      <div class="st-card"><div class="st-ch"><h2>Écart de jours par chantier</h2><span class="s">vert = plus rapide que vendu · rouge = dépassement</span></div>
        <div class="st-cb">${lignesGraph || '<span class="st-mut">Aucun chantier avec une durée vendue.</span>'}</div></div>
      <div class="st-card"><div class="st-ch"><h2>À regarder en priorité</h2></div><div class="st-cb st-prio">${prio || '<span class="st-mut">Rien de particulier à signaler.</span>'}</div></div>
    </div>`;

    const lignes = L.map((c) => {
      const pill = c.ecart > 0.5 ? `<span class="st-pill p-late">${c.archive ? "Archivé" : "Terminé"} · dépassé</span>` : c.etat === "termine" ? `<span class="st-pill p-done">${c.archive ? "Archivé" : "Terminé"}</span>`
        : c.etat === "attente" ? '<span class="st-pill p-wait">Pas démarré</span>'
        : c.ecart > 0.5 ? '<span class="st-pill p-late">En cours · retard</span>' : '<span class="st-pill p-run">En cours</span>';
      const q = (v, f = fmt1) => v == null || v === 0 && false ? '<span class="st-mut">—</span>' : f(v);
      const manq = (t) => `<span class="st-mut" title="${t}">?</span>`;
      const pct = c.prevu ? Math.min(100, c.realise / c.prevu * 100) : null;
      const clsCad = c.cadR != null && c.cadV ? (c.cadR < c.cadV * 0.95 ? "st-bad" : c.cadR > c.cadV * 1.05 ? "st-good" : "") : "";
      const clsE = c.ecart == null ? "" : c.ecart > 0.5 ? "st-bad" : c.ecart < -0.05 ? "st-good" : "";
      return `<tr class="st-lien" data-detail="${esc(c.id)}" data-nom="${esc(c.name)}" title="Ouvrir le détail du chantier">
        <td>${nomChantier(c.name)}</td><td>${pill}</td>
        <td class="r">${c.prevu ? fmt(c.prevu) + (c.avMpx ? ` <small class="st-mut">(${c.avMpx > 0 ? "+" : ""}${c.avMpx} TS)</small>` : "") : manq("quantité vendue non renseignée")}</td>
        <td class="r">${fmt(c.realise)}${c.ecartMpx ? ` <span class="st-warn" title="Mpx réalisés différents des Mpx vendus (marché + avenants) : vérifier le montant / les avenants">⚠</span>` : ""}</td>
        <td>${pct != null && c.jours ? `${fmt(pct)} %${barre(pct)}` : '<span class="st-mut">—</span>'}</td>
        <td class="r">${c.joursVendus ? fmt1(c.joursVendus) : manq("durée vendue non renseignée")}</td>
        <td class="r">${c.jours ? c.jours : '<span class="st-mut">—</span>'}</td>
        <td class="r ${clsE}">${c.ecart != null ? signe(c.ecart) : '<span class="st-mut">—</span>'}</td>
        <td class="r">${c.cadV ? fmt(c.cadV, 1) : '<span class="st-mut">—</span>'}</td>
        <td class="r ${clsCad}">${c.cadR != null ? fmt(c.cadR, 1) : '<span class="st-mut">—</span>'}</td>
        <td class="r">${c.caJour != null ? euros(c.caJour) : c.jours ? manq("montant ou quantité vendue non renseigné") : '<span class="st-mut">—</span>'}</td></tr>`;
    }).join("");

    const tableau = `<div class="st-card"><div class="st-ch"><h2>Détail par chantier</h2><span class="s">quantités, durées et montants = marché principal + avenants / TS validés · clic sur une ligne = détail du chantier</span></div>
      <div class="st-scroll"><table class="st-tbl">
        <thead><tr><th rowspan="2">Chantier</th><th rowspan="2">Statut</th><th class="g" colspan="3">MICROPIEUX</th><th class="g" colspan="3">JOURS</th><th class="g" colspan="2">CADENCE (Mpx/j)</th><th rowspan="2" class="r">CA / jour</th></tr>
        <tr><th class="r">Vendus</th><th class="r">Réalisés</th><th>Avancement</th><th class="r">Vendus</th><th class="r">Réels</th><th class="r">Écart</th><th class="r">Vendue</th><th class="r">Réelle</th></tr></thead>
        <tbody>${lignes}</tbody></table></div>
      <div class="st-note"><b>Comment lire :</b> jours réels = jours de rapport (deux ateliers le même jour = 1 jour). Cadence vendue = Mpx vendus ÷ jours vendus. CA / jour = montant (marché + avenants validés) ÷ jours de rapport. ⚠ = Mpx réalisés différents des Mpx vendus (avenant manquant ?). « ? » = donnée manquante dans les infos du chantier (à compléter avec ✏️ Modifier les infos sur le Détail chantier).</div></div>`;
    return kpis + haut + tableau;
  }

  function heuresParGroupe(c) {
    const h = { interne: 0, reclamer: 0, neutre: 0 }, cats = {};
    c.evts.forEach((e) => { h[CATS[e.cat].grp] += e.h; cats[e.cat] = (cats[e.cat] || 0) + e.h; });
    return { h, cats };
  }
  function topPanne(c) {
    const m = {};
    c.evts.filter((e) => e.cat === "panne").forEach((e) => { m[e.quoi] = (m[e.quoi] || 0) + e.h; });
    return Object.entries(m).sort((a, b) => b[1] - a[1])[0] || null;
  }
  function priorites(L) {
    const dem = L.filter((c) => c.ecart != null);
    const mauvais = dem.filter((c) => c.ecart > 0.5).sort((a, b) => b.ecart - a.ecart).slice(0, 2);
    const bon = dem.filter((c) => c.ecart < -0.05).sort((a, b) => a.ecart - b.ecart)[0];
    const out = mauvais.map((c, i) => {
      const { h } = heuresParGroupe(c);
      const tp = topPanne(c);
      let t = `${i === 0 ? "🔴" : "🟠"} <b>${esc(code(c.name))} ${esc(court(c.name))}</b> : `;
      if (c.etat === "cours") t += `${fmt(c.cadR, 1)} Mpx/j${c.cadV ? ` au lieu des ${fmt(c.cadV, 1)} vendus` : ""}. À ce rythme, ${fmt1(c.projetes)} j au lieu de ${fmt1(c.joursVendus)} → <b>${signe(c.ecart)} j</b>.`;
      else t += `terminé avec <b>${signe(c.ecart)} j</b>${c.cadV ? ` (${fmt(c.cadR, 1)} Mpx/j pour ${fmt(c.cadV, 1)} vendus)` : ""}.`;
      if (tp && tp[1] > 0) t += ` ${fmt1(tp[1])} h de pannes ${esc(tp[0])}.`;
      if (h.reclamer > 0) t += ` ${fmt1(h.reclamer)} h d'arrêts imputables au client / MOE → onglet Temps perdu (à réclamer).`;
      return t;
    });
    if (bon) out.push(`🟢 <b>${esc(code(bon.name))} ${esc(court(bon.name))}</b> : ${fmt(bon.cadR, 1)} Mpx/j${bon.cadV ? ` pour ${fmt(bon.cadV, 1)} vendus` : ""}, ${fmt1(-bon.ecart)} j d'avance${bon.etat === "cours" ? " (projection)" : ""}.`);
    const sansInfos = L.filter((c) => !c.prevu || !c.joursVendus).length;
    if (sansInfos) out.push(`<span class="st-mut">ℹ️ ${sansInfos} chantier${sansInfos > 1 ? "s" : ""} sans quantité ou durée vendue : non comparé${sansInfos > 1 ? "s" : ""}.</span>`);
    return out.join("<br><br>");
  }

  // ═══ 2. TEMPS PERDU ═══════════════════════════════════════════
  function evenementsPeriode() {
    const b = bornes();
    const out = [];
    chantiersFiltres().forEach((c) => c.evts.forEach((e) => out.push({ ...e, c })));
    return out.sort((a, b) => b.d - a.d);
  }
  function vueTempsPerdu() {
    const E = evenementsPeriode();
    if (!E.length) return vide("Aucune panne ni aucun arrêt déclaré sur les chantiers terminés de cette période (les pannes et arrêts existent depuis le rapport journalier v2).");
    const parCat = {};
    E.forEach((e) => { parCat[e.cat] = (parCat[e.cat] || 0) + e.h; });
    const tot = E.reduce((s, e) => s + e.h, 0);
    const hGrp = (g) => Object.entries(parCat).filter(([k]) => CATS[k].grp === g).reduce((s, [, h]) => s + h, 0);
    const reclam = E.filter((e) => CATS[e.cat].grp === "reclamer");
    const nChRec = new Set(reclam.map((e) => e.c.id)).size;
    const hNeutre = hGrp("neutre");

    const kpis = `<div class="st-kpis">
      ${kpi("Temps perdu total", `${fmt1(tot)} <small>h</small>`, `≈ ${fmt(tot / H_JOUR, 1)} jours d'atelier (${H_JOUR} h/j)`, "alert")}
      ${kpi("Causes internes", `${fmt1(hGrp("interne"))} <small>h</small>`, `pannes ${fmt1(parCat.panne || 0)} h${parCat.appro ? ` · appro coulis ${fmt1(parCat.appro)} h` : ""} → à corriger chez nous`)}
      ${kpi("Imputables client / MOE", `${fmt1(hGrp("reclamer"))} <small>h</small>`, reclam.length ? `${reclam.length} arrêt${reclam.length > 1 ? "s" : ""} sur ${nChRec} chantier${nChRec > 1 ? "s" : ""} → à réclamer / TS` : "aucun", reclam.length ? "warn" : "")}
      ${kpi("Météo · fournisseurs · autres", `${fmt1(hNeutre)} <small>h</small>`, [parCat.meteo ? `météo ${fmt1(parCat.meteo)} h` : "", parCat.beton ? `béton ${fmt1(parCat.beton)} h` : "", parCat.autre ? `autres ${fmt1(parCat.autre)} h` : ""].filter(Boolean).join(" · ") || "aucun")}
    </div>`;

    const ordreCats = Object.keys(CATS).filter((k) => parCat[k] > 0);
    const stack = ordreCats.map((k) => { const p = parCat[k] / tot * 100; return `<div style="width:${p}%;background:${CATS[k].col}" title="${esc(CATS[k].lib)} : ${fmt1(parCat[k])} h">${p > 12 ? `${esc(CATS[k].lib.split(" (")[0])} ${fmt1(parCat[k])} h` : ""}</div>`; }).join("");
    const leg = ordreCats.map((k) => `<span class="sq" style="background:${CATS[k].col}"></span><span>${esc(CATS[k].lib)}</span><b>${fmt1(parCat[k])} h</b>${tag(CATS[k].grp)}`).join("");

    const parMachine = {};
    E.filter((e) => e.cat === "panne").forEach((e) => {
      const g = window.FTSAteliers ? FTSAteliers.groupeDePointage(e.quoi, "", "", e.atelier) : { cle: e.quoi, libelle: e.quoi };
      const m = (parMachine[g.cle] = parMachine[g.cle] || { lib: g.libelle, n: 0, h: 0, ch: new Set() });
      m.n++; m.h += e.h; m.ch.add(court(e.c.name));
    });
    const machines = Object.values(parMachine).sort((a, b) => b.h - a.h);
    const maxH = machines.length ? machines[0].h : 0;

    const haut = `<div class="st-grid2">
      <div class="st-card"><div class="st-ch"><h2>Répartition du temps perdu</h2><span class="s">toutes causes, sur la période</span></div>
        <div class="st-cb"><div class="st-stack">${stack}</div><div class="st-leg">${leg}</div></div></div>
      <div class="st-card"><div class="st-ch"><h2>Pannes par machine</h2><span class="s">détail dans l'onglet Parc matériel</span></div>
        ${machines.length ? `<table class="st-tbl"><thead><tr><th>Machine</th><th class="r">Pannes</th><th class="r">Heures</th><th>Chantiers</th></tr></thead><tbody>
        ${machines.slice(0, 8).map((m) => `<tr><td><b>${esc(m.lib)}</b></td><td class="r">${m.n}</td><td class="r ${m.h === maxH && maxH > 0 ? "st-bad" : ""}">${fmt1(m.h)} h</td><td class="st-mut st-ell" style="max-width:260px">${esc([...m.ch].join(", "))}</td></tr>`).join("")}
        </tbody></table>` : '<div class="st-cb st-mut">Aucune panne sur la période.</div>'}</div>
    </div>`;

    const tRec = `<div class="st-card"><div class="st-ch"><h2>Arrêts imputables au client / MOE — à réclamer</h2><span class="s">retour d'expérience sur les chantiers terminés (pendant un chantier : onglet Pannes &amp; arrêts du Détail chantier)</span></div>
      ${reclam.length ? `<div class="st-scroll" style="max-height:460px"><table class="st-tbl"><thead><tr><th>Date</th><th>Chantier</th><th>Motif</th><th class="r">Durée</th><th>Observation du chef</th></tr></thead><tbody>
      ${reclam.map((e) => `<tr><td>${esc(jj(e.d))}</td><td>${nomChantier(e.c.name)}</td><td>${esc(e.quoi)}</td><td class="r">${fmt1(e.h)} h</td><td class="st-mut st-wrap">${esc(e.obs)}</td></tr>`).join("")}
      </tbody></table></div>` : '<div class="st-cb st-mut">Aucun arrêt imputable au client ou à la MOE sur la période.</div>'}
      <div class="st-note">Classement des motifs du rapport journalier — <b>interne</b> : pannes, attente coulis / matériaux · <b>à réclamer</b> : attente client / MOE, implantation, accès chantier, réseau / obstacle · <b>neutre</b> : météo, attente béton, autre.</div></div>`;
    return kpis + haut + tRec;
  }

  // ═══ 3. PARC MATÉRIEL ═════════════════════════════════════════
  function joursOuvres(deb, fin) {
    let n = 0;
    const d = new Date(deb.getFullYear(), deb.getMonth(), deb.getDate());
    while (d <= fin) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); }
    return n;
  }
  function calculParc() {
    const b = bornes();
    const C = chantiersFiltres();
    const A = window.FTSAteliers;
    const groupes = new Map();
    const loc = new Map();
    let premiere = null, derniere = null;
    const grp = (g) => {
      if (!groupes.has(g.cle)) groupes.set(g.cle, { g, jours: new Map(), ch: new Set(), n: 0, h: 0 });
      return groupes.get(g.cle);
    };
    C.forEach((c) => {
      (c.materiel || []).forEach((r) => {
        const d = parseFR(r[0]);
        if (!d) return;
        if (!premiere || d < premiere) premiere = d;
        if (!derniere || d > derniere) derniere = d;
        const g = A ? A.groupeDePointage(r[1], r[4], r[3], r[5]) : { cle: sansAccent(r[1]), libelle: String(r[1] || "").toUpperCase(), section: String(r[3]).toUpperCase() === "LOC" ? "loc" : "autre" };
        if (g.section === "loc") {
          const l = loc.get(g.cle) || { lib: g.libelle, jours: new Set(), par: {} };
          if (!l.jours.has(r[0] + "|" + c.id)) { l.jours.add(r[0] + "|" + c.id); l.par[court(c.name)] = (l.par[court(c.name)] || 0) + 1; }
          loc.set(g.cle, l);
          return;
        }
        const x = grp(g);
        (x.jours.get(r[0]) || x.jours.set(r[0], []).get(r[0])).push(sansAccent(r[2]));
        x.ch.add(c.id);
      });
      c.evts.filter((e) => e.cat === "panne").forEach((e) => {
        const g = A ? A.groupeDePointage(e.quoi, "", "", e.atelier) : { cle: sansAccent(e.quoi), libelle: e.quoi, section: "autre" };
        if (g.section === "loc") return;
        const x = grp(g); x.n++; x.h += e.h; x.ch.add(c.id);
      });
    });
    if (A) A.lignesDuParc().filter((g) => g.section === "foreuse" || g.section === "centrale").forEach((g) => grp(g));
    // Jours ouvrés entre le premier et le dernier pointage des chantiers retenus
    const fin = derniere || new Date();
    const debut = premiere || fin;
    const jo = Math.max(1, joursOuvres(debut, fin));
    const lignes = [...groupes.values()].map((x) => {
      const cpt = { TRAVAIL: 0, PANNE: 0, ARRET: 0, TRANSPORT: 0 };
      x.jours.forEach((st) => { const s = A ? A.statutDuJour(st) : st[0]; if (cpt[s] != null) cpt[s]++; });
      return { ...x, cpt, util: cpt.TRAVAIL / jo * 100, nCh: x.ch.size };
    });
    return { lignes, loc: [...loc.values()].map((l) => ({ ...l, n: l.jours.size })).sort((a, b) => b.n - a.n), jo, debut, fin };
  }
  function vueParc() {
    const P = calculParc();
    const SECT = [["foreuse", "FOREUSES"], ["centrale", "CENTRALES D'INJECTION"], ["autre", "AUTRES MATÉRIELS"]];
    const actif = (l) => l.jours.size > 0 || l.n > 0;
    const foTous = P.lignes.filter((l) => l.g.section === "foreuse");
    const fo = foTous.filter(actif);
    const foIdle = foTous.length - fo.length;
    const utilMoy = fo.length ? fo.reduce((s, l) => s + l.util, 0) / fo.length : null;
    const moins = fo.length > 1 ? [...fo].sort((a, b) => a.util - b.util)[0] : null;
    const plusPanne = [...P.lignes].filter((l) => l.h > 0 || l.n > 0).sort((a, b) => b.h - a.h || b.n - a.n)[0];
    const locJ = P.loc.reduce((s, l) => s + l.n, 0);
    const locCh = new Set(P.loc.flatMap((l) => Object.keys(l.par))).size;

    const kpis = `<div class="st-kpis">
      ${kpi("Utilisation moyenne des foreuses sorties", utilMoy != null ? `${fmt(utilMoy)} <small>%</small>` : "—", `jours travaillés ÷ ${P.jo} jours ouvrés (${jj(P.debut)} → ${jj(P.fin)})`)}
      ${kpi("Foreuse sortie la moins utilisée", moins ? `<span class="st-v-txt">${esc(moins.g.libelle)}</span>` : "—", (moins ? `${moins.cpt.TRAVAIL} j sur ${P.jo} jours ouvrés (${fmt(moins.util)} %)` : "") + (foIdle ? `${moins ? " · " : ""}${foIdle} foreuse${foIdle > 1 ? "s" : ""} jamais pointée${foIdle > 1 ? "s" : ""}` : ""), moins && moins.util < 30 ? "warn" : "")}
      ${kpi("Machine la plus en panne", plusPanne ? `<span class="st-v-txt">${esc(plusPanne.g.libelle)}</span>` : `<span class="st-v-txt">Aucune panne</span>`, plusPanne ? `${plusPanne.n} panne${plusPanne.n > 1 ? "s" : ""} · ${fmt1(plusPanne.h)} h · ${plusPanne.cpt.PANNE} jour${plusPanne.cpt.PANNE > 1 ? "s" : ""} pointé${plusPanne.cpt.PANNE > 1 ? "s" : ""} en panne` : "", plusPanne ? "alert" : "ok")}
      ${kpi("Jours de location", `${locJ} <small>j</small>`, P.loc.length ? `${P.loc.length} machine${P.loc.length > 1 ? "s" : ""} · ${locCh} chantier${locCh > 1 ? "s" : ""}` : "aucune location pointée")}
    </div>`;
    const maxH = Math.max(0, ...P.lignes.map((l) => l.h));
    const ligne = (l) => `<tr><td><b>${esc(l.g.libelle)}</b>${l.g.sous ? `<div class="st-mut st-small">${esc(l.g.sous)}</div>` : ""}</td><td class="r">${l.cpt.TRAVAIL}</td>
      <td>${l.cpt.TRAVAIL || l.g.section !== "autre" ? `<span class="${l.util < 30 && l.g.section !== "autre" ? "st-warn" : ""}">${fmt(l.util)} %</span>${barre(l.util, l.util < 30 ? "#E08A00" : "")}` : '<span class="st-mut">—</span>'}</td>
      <td class="r">${l.cpt.PANNE || '<span class="st-mut">0</span>'}</td><td class="r">${l.cpt.ARRET || '<span class="st-mut">0</span>'}</td><td class="r">${l.cpt.TRANSPORT || '<span class="st-mut">0</span>'}</td>
      <td class="r">${l.n || '<span class="st-mut">0</span>'}</td><td class="r ${l.h === maxH && maxH > 0 ? "st-bad" : ""}">${l.h ? fmt1(l.h) + " h" : '<span class="st-mut">—</span>'}</td><td class="r st-mut">${l.nCh || "—"}</td></tr>`;
    const tri = (a, b) => b.cpt.TRAVAIL - a.cpt.TRAVAIL || a.g.libelle.localeCompare(b.g.libelle, "fr", { numeric: true });
    let corps = "";
    const idle = P.lignes.filter((l) => (l.g.section === "foreuse" || l.g.section === "centrale") && !actif(l)).sort(tri);
    SECT.forEach(([id, titre]) => {
      const ls = P.lignes.filter((l) => l.g.section === id && actif(l)).sort(tri);
      if (!ls.length) return;
      if (id === "autre") corps += `<tbody class="st-autres"><tr class="st-sect st-toggle"><td colspan="9">▸ AUTRES MATÉRIELS (${ls.length}) — compresseurs, pelles, dessableurs…</td></tr></tbody><tbody class="st-autres-corps" hidden>${ls.map(ligne).join("")}</tbody>`;
      else corps += `<tbody><tr class="st-sect"><td colspan="9">${titre}</td></tr>${ls.map(ligne).join("")}</tbody>`;
    });
    if (idle.length) corps += `<tbody><tr class="st-sect"><td colspan="9">PAS POINTÉES SUR LA PÉRIODE (${idle.length})</td></tr><tr><td colspan="9" class="st-wrap st-mut">${esc(idle.map((l) => l.g.libelle).join(" · "))}</td></tr></tbody>`;
    const tab = `<div class="st-card"><div class="st-ch"><h2>Utilisation et fiabilité</h2><span class="s">même regroupement que le Pointage matériel (une ligne par foreuse, une ligne par centrale)</span></div>
      <div class="st-scroll"><table class="st-tbl"><thead><tr><th>Machine</th><th class="r">Jours travail</th><th>Utilisation</th><th class="r">Jours panne</th><th class="r">Jours arrêt</th><th class="r">Jours transport</th><th class="r">Pannes déclarées</th><th class="r">Heures de panne</th><th class="r">Chantiers</th></tr></thead>
      ${corps || '<tbody><tr><td colspan="9" class="st-mut">Aucun pointage matériel sur la période.</td></tr></tbody>'}</table></div>
      <div class="st-note">Utilisation = jours pointés « Travail » ÷ jours ouvrés entre le premier et le dernier pointage des chantiers terminés retenus. Une machine au dépôt n'est pas pointée : un taux bas veut dire « peu sortie », pas forcément « disponible » (congés, entretien…). Une centrale compte en panne dès qu'une de ses machines l'est.</div></div>`;
    const tLoc = `<div class="st-card"><div class="st-ch"><h2>Matériel de location</h2><span class="s">jours pointés « LOC » sur les chantiers terminés</span></div>
      ${P.loc.length ? `<table class="st-tbl"><thead><tr><th>Machine louée</th><th class="r">Jours</th><th>Chantiers</th></tr></thead><tbody>
      ${P.loc.map((l) => `<tr><td><b>${esc(l.lib)}</b></td><td class="r">${l.n}</td><td class="st-mut">${esc(Object.entries(l.par).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(" · "))}</td></tr>`).join("")}
      </tbody></table>` : '<div class="st-cb st-mut">Aucune location pointée sur la période.</div>'}</div>`;
    setTimeout(() => {
      const t = racine.querySelector(".st-toggle");
      if (t) t.onclick = () => { const c = racine.querySelector(".st-autres-corps"); c.hidden = !c.hidden; t.firstElementChild.textContent = t.firstElementChild.textContent.replace(/^[▸▾]/, c.hidden ? "▸" : "▾"); };
    }, 0);
    return kpis + tab + tLoc;
  }

  // ═══ 4. BILANS ════════════════════════════════════════════════
  function bilansListe() {
    const b = bornes();
    return chantiersFiltres().sort((a, c) => (c.dernier || 0) - (a.dernier || 0));
  }
  function machinesChantier(c) {
    const A = window.FTSAteliers;
    if (!A) return [];
    const vus = new Map();
    (c.materiel || []).forEach((r) => {
      if (sansAccent(r[2]) !== "TRAVAIL") return;
      const g = A.groupeDePointage(r[1], r[4], r[3], r[5]);
      if (g.section === "foreuse" || g.section === "centrale") vus.set(g.cle, g.libelle);
    });
    return [...vus.values()];
  }
  function bilan(c) {
    const { h, cats } = heuresParGroupe(c);
    const parMachine = {};
    c.evts.filter((e) => e.cat === "panne").forEach((e) => { const m = (parMachine[e.quoi] = parMachine[e.quoi] || { n: 0, h: 0 }); m.n++; m.h += e.h; });
    const parMotif = {};
    c.evts.filter((e) => e.cat !== "panne").forEach((e) => { const k = e.quoi; const m = (parMotif[k] = parMotif[k] || { h: 0, cat: e.cat }); m.h += e.h; });
    const temps = [
      ...Object.entries(parMachine).map(([k, v]) => ({ lib: `Pannes ${k} (${v.n} panne${v.n > 1 ? "s" : ""})`, h: v.h, grp: "interne" })),
      ...Object.entries(parMotif).map(([k, v]) => ({ lib: k, h: v.h, grp: CATS[v.cat].grp })),
    ].sort((a, b) => b.h - a.h);
    const totPerdu = h.interne + h.reclamer + h.neutre;
    // À retenir
    let retenir;
    const lm = c.lMoy ? fmt(c.lMoy, 1) : null;
    if (!c.joursVendus) retenir = `Durée vendue non renseignée : impossible de comparer au chiffrage. Cadence réelle : ${fmt(c.cadR, 1)} Mpx/j${lm ? ` pour des Mpx de ${lm} m en moyenne` : ""}.`;
    else if (c.ecart > 0.05) {
      const hp = cats.panne || 0;
      const parts = [];
      if (hp > 0) {
        const reste = c.ecart - hp / H_JOUR;
        parts.push(`sans les ${fmt1(hp)} h de panne (≈ ${fmt(hp / H_JOUR, 1)} j), le chantier aurait fini à ${reste > 0.05 ? signe(reste) + " j" : "l'heure"}.`);
      }
      if (h.reclamer > 0) parts.push(`${fmt1(h.reclamer)} h d'arrêts étaient imputables au client / MOE (à réclamer).`);
      if (c.cadV && c.cadR < c.cadV) parts.push(`${parts.length ? "Le reste de l'écart vient de la cadence" : "L'écart vient de la cadence"} : ${fmt(c.cadR, 1)} Mpx/j${lm ? ` pour des Mpx de ${lm} m en moyenne` : ""}, contre ${fmt(c.cadV, 1)} retenus au chiffrage.`);
      retenir = parts.length ? parts.join(" ") : `Dépassement de ${signe(c.ecart)} j sans cause déclarée dans les rapports.`;
      retenir = retenir.charAt(0).toUpperCase() + retenir.slice(1);
    } else {
      retenir = `Chantier tenu${c.ecart < -0.05 ? ` avec ${fmt1(-c.ecart)} j d'avance` : ""} : ${fmt(c.cadR, 1)} Mpx/j${lm ? ` pour des Mpx de ${lm} m en moyenne` : ""}${c.cadV ? `, pour ${fmt(c.cadV, 1)} retenus au chiffrage` : ""}. Cadence à retenir pour des chantiers similaires.`;
    }
    return { temps, totPerdu, retenir, machines: machinesChantier(c) };
  }

  function cadencesReelles() {
    const T = jeu.chantiers.filter((c) => c.mp && c.etat === "termine" && c.jours && c.realise);
    const tr = [["moins de 8 m", (l) => l < 8], ["8 à 12 m", (l) => l >= 8 && l <= 12], ["plus de 12 m", (l) => l > 12]];
    return tr.map(([lib, f]) => {
      const cs = T.filter((c) => c.lMoy != null && f(c.lMoy));
      const j = cs.reduce((s, c) => s + c.jours, 0);
      return { lib, n: cs.length, mpxj: j ? cs.reduce((s, c) => s + c.realise, 0) / j : null, mlj: j ? cs.reduce((s, c) => s + c.ml, 0) / j : null, hpj: j ? cs.reduce((s, c) => s + c.evts.reduce((x, e) => x + e.h, 0), 0) / j : null };
    });
  }

  function vueBilans() {
    const L = bilansListe();
    const cad = cadencesReelles();
    const fiab = (n) => n >= 5 ? "🟢 fiable" : n >= 3 ? "🟠 à confirmer" : n ? `⚪ ${n} chantier${n > 1 ? "s" : ""} — indicatif` : "aucun chantier";
    const tCad = `<div class="st-card"><div class="st-ch"><h2>Cadences réelles constatées — pour chiffrer</h2><span class="s">tous les chantiers terminés (et archivés), par longueur moyenne de Mpx</span></div>
      <table class="st-tbl"><thead><tr><th>Longueur moyenne des Mpx</th><th class="r">Chantiers</th><th class="r">Mpx / jour</th><th class="r">ml / jour</th><th class="r">Temps perdu moyen</th><th>Fiabilité</th></tr></thead><tbody>
      ${cad.map((t) => `<tr><td>${t.lib}</td><td class="r">${t.n}</td><td class="r">${t.mpxj != null ? fmt(t.mpxj, 1) : '<span class="st-mut">—</span>'}</td><td class="r">${t.mlj != null ? fmt(t.mlj) : '<span class="st-mut">—</span>'}</td><td class="r">${t.hpj != null ? fmt(t.hpj, 1) + " h/j" : '<span class="st-mut">—</span>'}</td><td class="st-mut">${fiab(t.n)}</td></tr>`).join("")}
      </tbody></table>
      <div class="st-note">Devient fiable à partir de 4–5 chantiers terminés par tranche. Les chantiers terminés avant le rapport journalier v2 n'ont pas de pannes / arrêts.</div></div>`;
    if (!L.length) return vide("Aucun chantier terminé sur cette période. Un chantier apparaît ici quand il est marqué « Terminé » sur son Détail chantier (ou archivé).") + tCad;
    if (!bilanSel || !L.some((c) => c.id === bilanSel)) bilanSel = L[0].id;
    const c = L.find((x) => x.id === bilanSel);
    const B = bilan(c);
    const liste = L.map((x) => `<a data-bilan="${esc(x.id)}" class="${x.id === bilanSel ? "on" : ""}"><b>${esc(x.name)}</b><small>${x.archive ? "archivé" : "terminé"} · dernier rapport ${esc(jja(x.dernier))}${x.ecart != null ? ` · <span class="${x.ecart > 0.5 ? "st-bad" : x.ecart < -0.05 ? "st-good" : ""}">${signe(x.ecart)} j</span>` : ""}</small></a>`).join("");
    const box = (l, n, s) => `<div><div class="l">${l}</div><div class="n">${n}</div><div class="st-mut st-small">${s || ""}</div></div>`;
    const clsE = c.ecart == null ? "" : c.ecart > 0.5 ? "st-bad" : c.ecart < -0.05 ? "st-good" : "";
    const fiche = `<div class="st-card"><div class="st-ch"><h2>Bilan — ${esc(c.name)}</h2><span class="s">du ${esc(jja(c.premier))} au ${esc(jja(c.dernier))}${c.chefs.length ? " · chef " + esc(c.chefs.join(", ")) : ""}${B.machines.length ? " · " + esc(B.machines.join(", ")) : ""}</span><span class="st-sp"></span><button type="button" class="st-btn" id="stPdf">⬇ PDF du bilan</button></div>
      <div class="st-cb">
        <div class="st-vr">
          ${box("Micropieux", `<b>${fmt(c.realise)}</b> réalisés${c.prevu ? ` / ${fmt(c.prevu)} vendus` : ""}`, c.avMpx ? `dont ${c.avMpx} en avenant${c.nbAvenants > 1 ? "s" : ""}` : "")}
          ${box("Jours", `<b class="${clsE}">${c.jours}</b> réels${c.joursVendus ? ` / ${fmt1(c.joursVendus)} vendus` : ""}`, c.ecart != null ? `${signe(c.ecart)} j (${c.ecart >= 0 ? "+" : "−"}${fmt(Math.abs(c.ecart) / c.joursVendus * 100)} %)` : "durée vendue non renseignée")}
          ${box("Cadence", `<b class="${c.cadV && c.cadR < c.cadV * 0.95 ? "st-bad" : c.cadV && c.cadR > c.cadV * 1.05 ? "st-good" : ""}">${fmt(c.cadR, 1)}</b> Mpx/j${c.cadV ? ` / ${fmt(c.cadV, 1)} vendue` : ""}`, `${fmt(c.ml / c.jours)} ml/j${c.lMoy ? ` · ${fmt(c.lMoy, 1)} ml par Mpx` : ""}`)}
          ${box("Montant HT", c.montant ? `<b>${euros(c.montant)}</b>` : '<b class="st-mut">?</b>', c.montant ? `${c.caJour != null ? euros(c.caJour) + "/j réel" : ""}${c.joursVendus ? ` · ${euros(c.montant / c.joursVendus)}/j vendu` : ""}` : "montant non renseigné")}
        </div>
        ${B.temps.length ? `<table class="st-tbl"><thead><tr><th>Temps perdu (${fmt1(B.totPerdu)} h)</th><th class="r">Heures</th><th></th></tr></thead><tbody>
          ${B.temps.map((t) => `<tr><td>${esc(t.lib)}</td><td class="r ${t.grp === "interne" ? "st-bad" : ""}">${fmt1(t.h)} h</td><td>${tag(t.grp)}</td></tr>`).join("")}</tbody></table>`
          : '<div class="st-mut">Aucune panne ni aucun arrêt déclaré sur ce chantier.</div>'}
        <div class="st-lesson">💡 <b>À retenir :</b> ${esc(B.retenir)}</div>
      </div></div>`;
    return `<div class="st-bil"><div class="st-card st-bl"><div class="st-ch"><h2>Chantiers terminés</h2><span class="s">${L.length}</span></div>${liste}</div><div>${fiche}${tCad}</div></div>`;
  }

  // ─── PDF du bilan (jsPDF, chargé à la demande) ───────────────
  function chargerScript(src) {
    return new Promise((ok, ko) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => ko(new Error("Bibliothèque PDF introuvable")); document.head.appendChild(s); });
  }
  function chargerLogo() {
    return new Promise((ok) => {
      const img = new Image();
      img.onload = () => { try { const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight; cv.getContext("2d").drawImage(img, 0, 0); ok({ data: cv.toDataURL("image/png"), r: img.naturalWidth / img.naturalHeight }); } catch (e) { ok(null); } };
      img.onerror = () => ok(null);
      img.src = "../assets/logo-fts.png";
    });
  }
  const pdfTxt = (s) => String(s == null ? "" : s).replace(/[\u202F\u00A0\u2009]/g, " ").replace(/[−–]/g, "-").replace(/≈/g, "env.").replace(/→/g, ">").replace(/[’]/g, "'").replace(/[^\x00-\xFF€]/g, "");
  async function genererPdf() {
    const c = jeu && jeu.chantiers.find((x) => x.id === bilanSel);
    if (!c) return;
    const bouton = racine.querySelector("#stPdf");
    if (bouton) { bouton.disabled = true; bouton.textContent = "Génération…"; }
    try {
      if (!window.jspdf) await chargerScript("../lib/jspdf/jspdf.umd.min.js");
      const logo = await chargerLogo();
      const doc = construirePdf(c, bilan(c), logo);
      doc.save(`Bilan ${c.name}.pdf`.replace(/[\\/:*?"<>|]/g, "-"));
    } catch (e) {
      alert("PDF impossible : " + e.message);
    } finally {
      if (bouton) { bouton.disabled = false; bouton.textContent = "⬇ PDF du bilan"; }
    }
  }
  function construirePdf(c, B, logo) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const W = 210, M = 14, LARG = W - 2 * M;
    const ANTH = [58, 58, 58], JAUNE = [245, 197, 24], GRIS = [110, 110, 110], ROUGE = [192, 57, 43], VERT = [30, 142, 78], BORD = [215, 215, 215];
    const T = pdfTxt;
    let y = M;
    // En-tête
    if (logo) doc.addImage(logo.data, "PNG", M, y, 11 * logo.r, 11);
    doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(...ANTH);
    doc.text("BILAN DE FIN DE CHANTIER", W - M, y + 5, { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...GRIS);
    doc.text(T(`Édité le ${jja(new Date())}`), W - M, y + 10, { align: "right" });
    y += 16;
    doc.setFillColor(...JAUNE); doc.rect(M, y, LARG, 1.2, "F"); y += 7;
    doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(20, 20, 20);
    doc.text(T(c.name), M, y); y += 6;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...GRIS);
    const sous = [`Du ${jja(c.premier)} au ${jja(c.dernier)}`, c.chefs.length ? `Chef : ${c.chefs.join(", ")}` : "", c.meta.adresse ? c.meta.adresse : ""].filter(Boolean).join("   ·   ");
    doc.splitTextToSize(T(sous), LARG).forEach((l) => { doc.text(l, M, y); y += 4.5; });
    if (B.machines.length) { doc.splitTextToSize(T("Matériel : " + B.machines.join(", ")), LARG).forEach((l) => { doc.text(l, M, y); y += 4.5; }); }
    y += 3;
    // 4 cases
    const cases = [
      ["MICROPIEUX", `${fmt(c.realise)}${c.prevu ? " / " + fmt(c.prevu) : ""}`, c.prevu ? `réalisés / vendus${c.avMpx ? ` (dont ${c.avMpx} en avenant)` : ""}` : "réalisés", null],
      ["JOURS", `${c.jours}${c.joursVendus ? " / " + fmt1(c.joursVendus) : ""}`, c.ecart != null ? `réels / vendus  (${signe(c.ecart)} j)` : "réels (durée vendue non renseignée)", c.ecart == null ? null : c.ecart > 0.5 ? ROUGE : c.ecart < -0.05 ? VERT : null],
      ["CADENCE", `${fmt(c.cadR, 1)}${c.cadV ? " / " + fmt(c.cadV, 1) : ""} Mpx/j`, `réelle / vendue · ${fmt(c.ml / c.jours)} ml/j${c.lMoy ? ` · ${fmt(c.lMoy, 1)} ml/Mpx` : ""}`, c.cadV && c.cadR < c.cadV * 0.95 ? ROUGE : c.cadV && c.cadR > c.cadV * 1.05 ? VERT : null],
      ["MONTANT HT", c.montant ? euros(c.montant) : "?", c.montant ? `${c.caJour != null ? euros(c.caJour) + "/j réel" : ""}${c.joursVendus ? " · " + euros(c.montant / c.joursVendus) + "/j vendu" : ""}` : "montant non renseigné", null],
    ];
    const cw = (LARG - 3 * 3) / 4, ch = 23;
    cases.forEach(([l, v, s, col], i) => {
      const x = M + i * (cw + 3);
      doc.setDrawColor(...BORD); doc.setLineWidth(0.3); doc.roundedRect(x, y, cw, ch, 1.5, 1.5, "S");
      doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(...GRIS); doc.text(T(l), x + 3, y + 5);
      doc.setFontSize(13); doc.setTextColor(...(col || [20, 20, 20])); doc.text(T(v), x + 3, y + 12.5);
      doc.setFont("helvetica", "normal"); doc.setFontSize(6.8); doc.setTextColor(...GRIS);
      doc.splitTextToSize(T(s), cw - 5).slice(0, 2).forEach((ln, k) => doc.text(ln, x + 3, y + 17 + k * 3));
    });
    y += ch + 8;
    // Temps perdu
    doc.setFillColor(...ANTH); doc.rect(M, y, LARG, 6.5, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(255, 255, 255);
    doc.text(T("TEMPS PERDU"), M + 3, y + 4.4); doc.text(T(`${fmt1(B.totPerdu)} h  (env. ${fmt(B.totPerdu / H_JOUR, 1)} j)`), W - M - 3, y + 4.4, { align: "right" });
    y += 6.5;
    doc.setFontSize(8.5);
    const lib = { interne: "interne", reclamer: "à réclamer", neutre: "neutre" };
    const lignes = B.temps.length ? B.temps : [{ lib: "Aucune panne ni aucun arrêt déclaré", h: null, grp: null }];
    lignes.slice(0, 14).forEach((t, i) => {
      if (i % 2) { doc.setFillColor(247, 247, 247); doc.rect(M, y, LARG, 6, "F"); }
      doc.setFont("helvetica", "normal"); doc.setTextColor(40, 40, 40); doc.text(T(t.lib).slice(0, 80), M + 3, y + 4.1);
      if (t.h != null) {
        doc.setFont("helvetica", "bold"); doc.setTextColor(...(t.grp === "interne" ? ROUGE : [40, 40, 40])); doc.text(T(fmt1(t.h) + " h"), W - M - 32, y + 4.1, { align: "right" });
        doc.setFont("helvetica", "normal"); doc.setTextColor(...GRIS); doc.text(T(lib[t.grp]), W - M - 3, y + 4.1, { align: "right" });
      }
      y += 6;
    });
    doc.setDrawColor(...BORD); doc.line(M, y, W - M, y);
    y += 8;
    // À retenir
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    const txt = doc.splitTextToSize(T(B.retenir), LARG - 10);
    const hR = 9 + txt.length * 4.4;
    doc.setFillColor(255, 248, 219); doc.roundedRect(M, y, LARG, hR, 1.5, 1.5, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(20, 20, 20); doc.text(T("À RETENIR"), M + 5, y + 6);
    doc.setFont("helvetica", "normal"); txt.forEach((l, k) => doc.text(l, M + 5, y + 11 + k * 4.4));
    y += hR + 8;
    // Rappel des avenants
    const av = Array.isArray(c.meta.avenants) ? c.meta.avenants : [];
    if (av.length) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...ANTH); doc.text(T("AVENANTS / TS VALIDÉS"), M, y); y += 5;
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.2); doc.setTextColor(40, 40, 40);
      av.slice(0, 8).forEach((a) => { doc.text(T(`• ${a.designation || "Avenant"}${a.ref ? " (" + a.ref + ")" : ""} : ${a.mpx ? "+" + a.mpx + " Mpx · " : ""}${a.jours ? "+" + a.jours + " j · " : ""}${a.montant ? "+" + euros(Number(a.montant)) : ""}`).slice(0, 110), M + 2, y); y += 4.6; });
    }
    // Pied
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...GRIS);
    doc.text(T("FTS — Fondations & Travaux Spéciaux · calculé à partir des rapports journaliers et des infos du chantier (marché + avenants validés)"), W / 2, 289, { align: "center" });
    return doc;
  }

  // ─── Export (CSV lisible par Excel) ──────────────────────────
  function csv(lignes, nom) {
    const t = lignes.map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + t], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a"); a.href = url; a.download = nom; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const n1 = (v) => v == null ? "" : String(Math.round(v * 10) / 10).replace(".", ",");
  function exporter() {
    if (!jeu) return;
    if (onglet === "tp") {
      const L = [["Date", "Chantier", "Type", "Machine / motif", "Classement", "Durée (h)", "Observation"]];
      evenementsPeriode().forEach((e) => L.push([e.ds, e.c.name, e.cat === "panne" ? "Panne" : "Arrêt", e.quoi, GRP[CATS[e.cat].grp][0], n1(e.h), e.obs]));
      return csv(L, "Statistiques_temps_perdu.csv");
    }
    if (onglet === "parc") {
      const P = calculParc();
      const L = [["Section", "Machine", "Jours travail", "Utilisation (%)", "Jours panne", "Jours arrêt", "Jours transport", "Pannes déclarées", "Heures de panne", "Chantiers"]];
      P.lignes.forEach((l) => L.push([l.g.section, l.g.libelle, l.cpt.TRAVAIL, Math.round(l.util), l.cpt.PANNE, l.cpt.ARRET, l.cpt.TRANSPORT, l.n, n1(l.h), l.nCh]));
      P.loc.forEach((l) => L.push(["location", l.lib, l.n, "", "", "", "", "", "", Object.keys(l.par).join(" / ")]));
      return csv(L, "Statistiques_parc_materiel.csv");
    }
    const src = onglet === "bilans" ? bilansListe() : lignesVR();
    const L = [["Chantier", "Statut", "Mpx vendus", "Mpx réalisés", "Jours vendus", "Jours réels (jours de rapport)", "Écart (j)", "Cadence vendue (Mpx/j)", "Cadence réelle (Mpx/j)", "ml réalisés", "ml moyen par Mpx", "Montant HT", "CA par jour", "Temps perdu (h)", "dont à réclamer (h)"]];
    src.forEach((c) => { const { h } = heuresParGroupe(c); L.push([c.name, c.archive ? "Archivé" : "Terminé", c.prevu || "", c.realise, c.joursVendus || "", c.jours, n1(c.ecart), n1(c.cadV), n1(c.cadR), n1(c.ml), n1(c.lMoy), c.montant || "", c.caJour != null ? Math.round(c.caJour) : "", n1(h.interne + h.reclamer + h.neutre), n1(h.reclamer)]); });
    csv(L, onglet === "bilans" ? "Statistiques_bilans.csv" : "Statistiques_vendu_realise.csv");
  }

  return { monter, ouvrir, charger, categorieArret, _analyser: analyser };
})();
window.FTSStats = FTSStats;
