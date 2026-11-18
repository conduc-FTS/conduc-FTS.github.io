/**
 * statistiques.js — onglets Statistiques de la Supervision (ordinateur) :
 *   - Vendu / réalisé  : a-t-on tenu ce qu'on a vendu ?
 *   - Temps perdu      : pannes et arrêts, classés interne / à réclamer / neutre
 *   - Parc matériel    : utilisation et fiabilité des foreuses et centrales
 *   - Personnel        : jours-hommes, intérim, grands déplacements
 *
 * Refonte du 18/11/2026 (Clément) : des statistiques d'ACTIVITÉ, par métier
 * (cases Pieux / Micropieux / Battage), pas chantier par chantier (le détail
 * est dans la Vue d'ensemble). Aucun coût de revient, marge ni tarif ici :
 * seulement le CA vendu (marché + avenants). Les bilans de fin de chantier
 * sont remplacés par le module Résultats (js/resultats.js).
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
 * FTSStats.monter(conteneur, { obtenirDonnees }) puis FTSStats.ouvrir("vr"|"tp"|"parc"|"pers").
 * Nécessite drive.js, sheets.js, parc-materiel.js, ateliers.js.
 */
const FTSStats = (() => {
  const CLE_ARCHIVES = "fts_stats_archives_v2"; // v2 : avec le personnel
  const TTL = 120000;
  const H_JOUR = 8; // heures d'un jour d'atelier (conversion h → j)

  let racine = null;
  let opts = {};
  let jeu = null;          // { chargeA, chantiers: [...] }
  let enCours = null;
  let onglet = "vr";
  let periode = "annee";
  // Métiers affichés (le rapport journalier pieux n'existe pas encore)
  const METIERS = [["Micropieux", "Micropieux"], ["Battage", "Battage"], ["Pieux", "Pieux"]];
  const METIERS_A_VENIR = ["Pieux"];
  let metiers = new Set(["Micropieux", "Battage"]);
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
              cache.ids[a.id] = { name: a.name, meta: FTSDrive.parseMetadonnees(a.description), materiel: s.materiel || [], production: s.production || [], personnel: s.personnel || [], pannes: (pa[a.id] || {}).pannes || [], arrets: (pa[a.id] || {}).arrets || [] };
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
          return { id: c.id, name: c.name, meta: c.meta || {}, materiel: s.materiel || [], production: s.production || [], personnel: s.personnel || [], pannes: (pa[c.id] || {}).pannes || [], arrets: (pa[c.id] || {}).arrets || [], archive: false };
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
    return jeu.chantiers.filter((c) => c.mp && c.etat === "termine" && c.jours && c.tech.some((t) => metiers.has(t)) && (!b[0] || dansPeriode(c.dernier, b)));
  }

  // ─── Montage ─────────────────────────────────────────────────
  function monter(el, o) {
    racine = el;
    opts = o || {};
    racine.innerHTML = `
      <div class="st-filters">
        ${METIERS.map(([m, lib]) => METIERS_A_VENIR.includes(m)
          ? `<span class="st-chip off" title="Le rapport journalier ${lib.toLowerCase()} n'existe pas encore">${lib} · à venir</span>`
          : `<button type="button" class="st-chip ${metiers.has(m) ? "on" : ""}" data-metier="${m}">${metiers.has(m) ? "✓ " : ""}${lib}</button>`).join("")}
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
      const m = e.target.closest("[data-metier]");
      if (m) {
        const k = m.dataset.metier;
        if (metiers.has(k) && metiers.size === 1) return; // au moins un métier coché
        metiers.has(k) ? metiers.delete(k) : metiers.add(k);
        m.classList.toggle("on", metiers.has(k));
        m.textContent = (metiers.has(k) ? "✓ " : "") + k;
        afficher(); return;
      }
      const t = e.target.closest("[data-toggle]");
      if (t) { const c = racine.querySelector(t.dataset.toggle); if (c) { c.hidden = !c.hidden; t.textContent = t.textContent.replace(/^[▸▾]/, c.hidden ? "▸" : "▾"); } return; }
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
      vue.innerHTML = bandeauCouverture() + (onglet === "tp" ? vueTempsPerdu() : onglet === "parc" ? vueParc() : onglet === "pers" ? vuePersonnel() : vueVenduRealise());
    } catch (e) {
      console.error(e);
      vue.innerHTML = `<div class="st-vide">Erreur d'affichage : ${esc(e.message)}</div>`;
    }
  }

  const kpi = (l, v, s, cls = "") => `<div class="st-kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s || ""}</div></div>`;
  const vide = (t) => `<div class="st-vide">${t}</div>`;
  const barre = (pct, coul) => `<span class="st-bar"><i style="width:${Math.max(0, Math.min(100, pct))}%${coul ? ";background:" + coul : ""}"></i></span>`;

  // ═══ Bandeau commun : sur quoi portent les chiffres ═══════════
  function bandeauCouverture() {
    if (!jeu) return "";
    const b = bornes();
    const tous = jeu.chantiers.filter((c) => c.mp && c.etat === "termine" && c.tech.some((t) => metiers.has(t)) && (!b[0] || !c.dernier || dansPeriode(c.dernier, b)));
    const L = chantiersFiltres();
    if (!tous.length) return "";
    const sansRapport = tous.length - L.length;
    const incomplets = L.filter((c) => !c.prevu || !c.joursVendus);
    const lien = (c) => `<a href="#" data-detail="${esc(c.id)}" data-nom="${esc(c.name)}">${esc(court(c.name))}</a>`;
    const morceaux = [`ℹ️ Calculé sur <b>${L.length} chantier${L.length > 1 ? "s" : ""} terminé${L.length > 1 ? "s" : ""}</b> (${[...metiers].join(" + ").toLowerCase()})`];
    if (sansRapport > 0) morceaux.push(`${sansRapport} sans rapport journalier`);
    if (incomplets.length) morceaux.push(`${incomplets.length} sans quantité ou durée vendue, non comparé${incomplets.length > 1 ? "s" : ""} au vendu : ${incomplets.slice(0, 4).map(lien).join(", ")}${incomplets.length > 4 ? "…" : ""}`);
    return `<div class="st-cov">${morceaux.join(" · ")}</div>`;
  }

  // ═══ 1. VENDU / RÉALISÉ ═══════════════════════════════════════
  function lignesVR() {
    return chantiersFiltres().sort((a, b) => ((b.ecart ?? -99) - (a.ecart ?? -99)) || a.name.localeCompare(b.name));
  }
  function vueVenduRealise() {
    const L = lignesVR();
    if (!L.length) return vide("Aucun chantier terminé pour ces métiers sur cette période. Un chantier entre dans les statistiques quand il est marqué « Terminé » sur son Détail chantier (ou archivé).");
    const comp = L.filter((c) => c.ecart != null);
    const tenus = comp.filter((c) => c.ecart <= 0.5);
    const gagnes = comp.filter((c) => c.ecart < -0.05).reduce((s, c) => s - c.ecart, 0);
    const perdus = comp.filter((c) => c.ecart > 0.05).reduce((s, c) => s + c.ecart, 0);
    const avecCa = L.filter((c) => c.montant);
    const ca = avecCa.reduce((s, c) => s + c.montant, 0);
    const jCa = avecCa.reduce((s, c) => s + c.jours, 0);
    const mlCa = avecCa.reduce((s, c) => s + c.ml, 0);
    const k = (n) => n >= 10000 ? `${fmt(n / 1000)} <small>k€</small>` : `${fmt(n)} <small>€</small>`;

    const kpis = `<div class="st-kpis">
      ${kpi("Chantiers terminés", L.length, comp.length === L.length ? "tous comparables au vendu" : `dont ${comp.length} comparable${comp.length > 1 ? "s" : ""} au vendu`)}
      ${kpi("Délais tenus", comp.length ? `${tenus.length} <small>/ ${comp.length}</small>` : "—", comp.length ? (comp.length - tenus.length ? `${comp.length - tenus.length} chantier${comp.length - tenus.length > 1 ? "s" : ""} en retard` : "aucun retard") : "durées vendues non renseignées", comp.length ? (tenus.length === comp.length ? "ok" : "alert") : "")}
      ${kpi("Jours gagnés / perdus", comp.length ? `+${fmt1(gagnes)} <small>/</small> −${fmt1(perdus)} <small>j</small>` : "—", comp.length ? `bilan : ${perdus - gagnes > 0.05 ? fmt1(perdus - gagnes) + " j de retard" : gagnes - perdus > 0.05 ? fmt1(gagnes - perdus) + " j d'avance" : "à l'équilibre"} au total` : "", comp.length ? (perdus > gagnes + 0.05 ? "warn" : "ok") : "")}
      ${kpi("CA vendu", avecCa.length ? k(ca) : "—", avecCa.length ? `${fmt(ca / jCa)} € par jour de chantier` : "montants non renseignés")}
    </div>`;

    // Cadence par métier : jamais mélangée entre métiers
    const lignesMetier = [...metiers].map((m) => {
      const cs = L.filter((c) => c.tech.includes(m));
      const cmp = cs.filter((c) => c.prevu && c.joursVendus);
      const j = cs.reduce((s, c) => s + c.jours, 0), r = cs.reduce((s, c) => s + c.realise, 0), ml = cs.reduce((s, c) => s + c.ml, 0);
      const cadV = cmp.length ? cmp.reduce((s, c) => s + c.prevu, 0) / cmp.reduce((s, c) => s + c.joursVendus, 0) : null;
      const cadRc = cmp.length ? cmp.reduce((s, c) => s + c.realise, 0) / cmp.reduce((s, c) => s + c.jours, 0) : null;
      const ecart = cadV && cadRc != null ? (cadRc / cadV - 1) * 100 : null;
      const mixtes = cs.filter((c) => c.tech.filter((t) => metiers.has(t)).length > 1).length;
      if (!cs.length) return `<tr><td><b>${m}</b></td><td class="r">0</td><td class="r st-mut">—</td><td class="r st-mut">—</td><td class="r st-mut">—</td><td class="r st-mut">—</td><td class="r st-mut">pas encore de chantier terminé</td></tr>`;
      return `<tr><td><b>${m}</b>${mixtes ? ` <span class="st-mut st-small">dont ${mixtes} mixte${mixtes > 1 ? "s" : ""}</span>` : ""}</td><td class="r">${cs.length}</td><td class="r">${r ? fmt(ml / r, 1) + " m" : "—"}</td>
        <td class="r">${cadV ? fmt(cadV, 1) + " u/j" : '<span class="st-mut">—</span>'}</td><td class="r">${j ? fmt(r / j, 1) + " u/j" : "—"}</td><td class="r">${j ? fmt(ml / j) + " ml/j" : "—"}</td>
        <td class="r ${ecart == null ? "" : ecart < -5 ? "st-warn" : ecart > 5 ? "st-good" : ""}">${ecart == null ? '<span class="st-mut">—</span>' : (ecart > 0 ? "+" : "−") + fmt(Math.abs(ecart)) + " %"}</td></tr>`;
    }).join("");
    const cad = `<section class="st-card"><div class="st-ch"><h2>Cadence par métier</h2><span class="s">vendue / réalisée, jamais mélangées entre métiers</span></div>
      <div class="st-scroll"><table class="st-tbl"><thead><tr><th>Métier</th><th class="r">Chantiers</th><th class="r">Long. moy.</th><th class="r">Vendue</th><th class="r">Réalisée</th><th class="r">Réalisée (ml)</th><th class="r">Écart</th></tr></thead><tbody>${lignesMetier}</tbody></table></div>
      <div class="st-note">Cadence vendue = micropieux vendus ÷ jours vendus (marché + avenants), sur les chantiers où les deux sont renseignés ; l'écart compare ces mêmes chantiers. Le mètre par jour permet de comparer des chantiers de longueurs différentes. Un chantier mixte compte dans chacun de ses métiers ; tant que le rapport ne sépare pas le battage, sa production est comptée en micropieux.</div></section>`;

    const tot = { mpx: L.reduce((s, c) => s + c.realise, 0), ml: L.reduce((s, c) => s + c.ml, 0), j: L.reduce((s, c) => s + c.jours, 0) };
    const vol = `<section class="st-card"><div class="st-ch"><h2>Volume réalisé</h2><span class="s">métiers cochés · période choisie</span></div>
      <div class="st-cb"><div class="st-vr st-vr2">
        <div><div class="l">Micropieux</div><div class="n"><b>${fmt(tot.mpx)}</b></div></div>
        <div><div class="l">Mètres forés</div><div class="n"><b>${fmt(tot.ml)}</b> ml</div></div>
        <div><div class="l">Jours de chantier</div><div class="n"><b>${fmt(tot.j)}</b> j</div></div>
        <div><div class="l">CA vendu au mètre</div><div class="n">${mlCa ? `<b>${fmt(ca / mlCa)}</b> €/ml` : '<b class="st-mut">—</b>'}</div></div>
      </div></div></section>`;
    return kpis + `<div class="st-grid2">${cad}${vol}</div>`;
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

    const haut = `<div class="st-card"><div class="st-ch"><h2>Répartition du temps perdu</h2><span class="s">toutes causes, sur la période · le détail des pannes, machine par machine, est dans l'onglet Parc matériel</span></div>
        <div class="st-cb"><div class="st-stack">${stack}</div><div class="st-leg">${leg}</div></div></div>`;

    const tRec = `<div class="st-card"><div class="st-ch"><h2>Arrêts imputables au client / MOE — à réclamer</h2><span class="s">${reclam.length} arrêt${reclam.length > 1 ? "s" : ""} · pendant un chantier : onglet Pannes &amp; arrêts du Détail chantier</span>${reclam.length ? `<span class="st-sp"></span><button type="button" class="st-chip" data-toggle="#stReclam">▸ Voir le détail</button>` : ""}</div>
      ${reclam.length ? `<div class="st-scroll" id="stReclam" hidden style="max-height:460px"><table class="st-tbl"><thead><tr><th>Date</th><th>Chantier</th><th>Motif</th><th class="r">Durée</th><th>Observation du chef</th></tr></thead><tbody>
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

  // ═══ 4. PERSONNEL ═════════════════════════════════════════════
  const NON_TROUVE = "NON TROUVÉ DANS PERSONNEL FTS";
  const POSTE_ORDRE = ["CHEF DE CHANTIER", "SECOND", "FOREUR", "POMPISTE", "MANŒUVRE", "SOUDEUR", "RECÉPEUR", "POLYVALENT"];
  function calculPersonnel() {
    const L = chantiersFiltres();
    const postes = {}, vus = new Set();
    let jh = 0, jhInt = 0, gd = 0, heures = 0, ml = 0;
    const gdCh = new Set();
    L.forEach((c) => {
      ml += c.ml;
      (c.personnel || []).forEach((r) => {
        const nom = String(r[1] || "").trim();
        if (!parseFR(r[0]) || !nom) return;
        const cle = c.id + "|" + String(r[0]).trim() + "|" + sansAccent(nom);
        if (vus.has(cle)) return; // même personne, même jour, même chantier : une fois
        vus.add(cle);
        const interim = /INTERIM/.test(sansAccent(r[2]));
        const p = !interim && window.FTSPersonnel && FTSPersonnel.parNom ? FTSPersonnel.parNom(nom) : null;
        const poste = interim ? "INTÉRIM" : (p && p.poste) || NON_TROUVE;
        const x = (postes[poste] = postes[poste] || { jh: 0, h: 0, gd: 0, gens: new Set() });
        x.jh++; x.h += nb(r[4]); x.gens.add(sansAccent(nom));
        jh++; heures += nb(r[4]);
        if (interim) jhInt++;
        if (String(r[3] || "").trim()) { gd++; x.gd++; gdCh.add(c.id); }
      });
    });
    const lignes = Object.entries(postes).map(([poste, x]) => ({ poste, ...x, n: x.gens.size }))
      .sort((a, b) => (a.poste === "INTÉRIM") - (b.poste === "INTÉRIM") || ((POSTE_ORDRE.indexOf(a.poste) + 1 || 99) - (POSTE_ORDRE.indexOf(b.poste) + 1 || 99)));
    return { L, lignes, jh, jhInt, gd, nGdCh: gdCh.size, heures, ml };
  }
  function vuePersonnel() {
    const P = calculPersonnel();
    if (!P.L.length) return vide("Aucun chantier terminé pour ces métiers sur cette période.");
    if (!P.jh) return vide("Aucun personnel pointé sur les chantiers terminés de cette période.");
    const kpis = `<div class="st-kpis">
      ${kpi("Jours-hommes", fmt(P.jh), `${fmt1(P.heures)} h pointées · ${P.L.length} chantier${P.L.length > 1 ? "s" : ""}`)}
      ${kpi("Part d'intérim", `${fmt(P.jhInt / P.jh * 100)} <small>%</small>`, `${fmt(P.jhInt)} jour${P.jhInt > 1 ? "s" : ""}-hommes`)}
      ${kpi("Grands déplacements", `${fmt(P.gd)} <small>nuit${P.gd > 1 ? "s" : ""}</small>`, P.gd ? `sur ${P.nGdCh} chantier${P.nGdCh > 1 ? "s" : ""}` : "aucun")}
      ${kpi("Productivité", P.ml ? `${fmt(P.ml / P.jh, 1)} <small>ml / homme / j</small>` : "—", "mètres forés ÷ jours-hommes")}
    </div>`;
    const tab = `<div class="st-card"><div class="st-ch"><h2>Jours-hommes par poste</h2><span class="s">poste pris dans Personnel FTS · intérimaires à part</span></div>
      <div class="st-scroll"><table class="st-tbl"><thead><tr><th>Poste</th><th class="r">Personnes</th><th class="r">Jours-hommes</th><th class="r">Heures</th><th class="r">Nuits GD</th><th>Part</th></tr></thead><tbody>
      ${P.lignes.map((l) => `<tr><td><b>${esc(l.poste === NON_TROUVE ? "Non trouvé dans Personnel FTS" : l.poste.charAt(0) + l.poste.slice(1).toLowerCase())}</b></td><td class="r">${l.n}</td><td class="r">${fmt(l.jh)}</td><td class="r">${fmt1(l.h)}</td><td class="r">${l.gd || '<span class="st-mut">0</span>'}</td><td>${fmt(l.jh / P.jh * 100)} %${barre(l.jh / P.jh * 100)}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="st-note">Un jour-homme = une personne présente un jour sur un chantier (rapport journalier). « Non trouvé » = nom saisi par le chef absent de Personnel FTS (orthographe différente ?).</div></div>`;
    return kpis + tab;
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
    if (onglet === "pers") {
      const P = calculPersonnel();
      const L = [["Poste", "Personnes", "Jours-hommes", "Heures", "Nuits GD"]];
      P.lignes.forEach((l) => L.push([l.poste, l.n, l.jh, n1(l.h), l.gd]));
      return csv(L, "Statistiques_personnel.csv");
    }
    const src = lignesVR();
    const L = [["Chantier", "Statut", "Mpx vendus", "Mpx réalisés", "Jours vendus", "Jours réels (jours de rapport)", "Écart (j)", "Cadence vendue (Mpx/j)", "Cadence réelle (Mpx/j)", "ml réalisés", "ml moyen par Mpx", "Montant HT", "CA par jour", "Temps perdu (h)", "dont à réclamer (h)"]];
    src.forEach((c) => { const { h } = heuresParGroupe(c); L.push([c.name, c.archive ? "Archivé" : "Terminé", c.prevu || "", c.realise, c.joursVendus || "", c.jours, n1(c.ecart), n1(c.cadV), n1(c.cadR), n1(c.ml), n1(c.lMoy), c.montant || "", c.caJour != null ? Math.round(c.caJour) : "", n1(h.interne + h.reclamer + h.neutre), n1(h.reclamer)]); });
    csv(L, "Statistiques_vendu_realise.csv");
  }

  return { monter, ouvrir, charger, categorieArret, _analyser: analyser };
})();
window.FTSStats = FTSStats;
