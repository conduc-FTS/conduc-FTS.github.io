/**
 * resultats.js — module « Résultats » de la Supervision (catégorie CHANTIERS).
 *
 * Fiche « Résultat chantier micropieux » reprise ligne pour ligne de l'Excel
 * 26_FTS_XXX_RESULTATS_MICROPIEUX (feuille RESULTATS + annexe QUANTITES TUBES H).
 *
 * Règles (Clément, 18/11/2026) :
 *  - liste des chantiers TERMINÉS (actifs au statut Terminé + archivés),
 *    micropieux / battage : « À faire » tant que le résultat n'est pas
 *    clôturé, « Faits » une fois clôturé ;
 *  - visible et modifiable par les conducteurs de travaux et la directrice
 *    travaux (module « resultats ») ; personne d'autre pour l'instant ;
 *  - AUCUN PRIX DANS LE CODE (dépôt GitHub public) : tarifs et résultats
 *    sont dans le classeur « Tarifs et résultats FTS », propriété de
 *    conduc.fts, rangé HORS de l'arborescence FTS et partagé nominativement
 *    (modification) aux personnes qui ont le module. Rien n'est gardé sur
 *    l'appareil ;
 *  - tout est modifiable (quantités, prix, même les lignes remplies par
 *    l'appli) ; un prix différent du tarif est signalé « modifié » ;
 *  - provisions soutènement modifiables, ou « ne s'applique pas » (0 %) ;
 *  - PDF : logo FTS, seules les lignes renseignées, sous-total en bas de
 *    chaque groupe, pas d'annexe ; enregistré où l'on veut (fenêtre
 *    « Enregistrer sous »), nom « CODE NOM RESULTAT CHANTIER.pdf ».
 *
 * FTSResultats.monter(conteneur, { obtenirDonnees }) · FTSResultats.synchroniserPartages()
 * Nécessite auth.js, drive.js, sheets.js, personnel.js, modules.js (serveur-fts.js facultatif).
 */
const FTSResultats = (() => {
  const NOM_CLASSEUR = "Tarifs et résultats FTS";
  const ROLE = "tarifsResultats";
  const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
  const DRIVE = "https://www.googleapis.com/drive/v3";
  const O_TARIFS = "Tarifs", O_INFOS = "Infos", O_RES = "Resultats";
  const ENTETE_RES = ["Chantier (id)", "Code", "Nom", "État", "Conducteur", "Facturation", "Dépenses", "Résultat net", "Marge %", "Modifié le", "Par", "Données"];

  // ─── Catalogue : désignations de l'Excel (les PRIX sont dans le Drive) ──
  // t : "p" personnel (nb × (jours × PU + GD × forfait GD)), "j" (nb × jours × PU),
  //     "q" (quantité × PU), "a" (total pris dans l'annexe)
  const GROUPES = [
    { id: "personnel", lib: "Personnel", t: "p", auto: "pointage personnel", lignes: [
      ["foreur", "Foreur"], ["aideForeur", "Aide foreur"], ["manoeuvre", "Manœuvre"], ["soudeur", "Soudeur"],
      ["pelliste", "Pelliste"], ["boiseur", "Boiseur"], ["mecanicien", "Mécanicien"], ["recepeur", "Recépeur"]] },
    { id: "interne", lib: "Matériel interne", t: "j", auto: "pointage matériel", lignes: [
      ["mc15", "MC15"], ["mc8", "MC8 / DCH / EGT / MC6"], ["t41", "T41 / T46"], ["futuro", "FUTURO 1/2"],
      ["ma12", "MA12 / TMD + PH15"], ["mixo", "MIXO"], ["lutz", "Enregistreur LUTZ"], ["groupe", "Groupe électrogène"],
      ["comp20", "Compresseur 20 000 L"], ["pdm", "Pompe PDM"], ["dessableur", "Dessableur"], ["cuve", "Cuve GNR"],
      ["pajot600", "Marteau PAJOT 600"], ["pajot1400", "Marteau PAJOT 1400"], ["membrane", "Pompe membrane"],
      ["consommables", "Consommables"], ["fourgon", "Fourgon"]] },
    { id: "location", lib: "Matériel de location", t: "j", auto: "pointage matériel", lignes: [
      ["telesco", "Télesco"], ["comp10", "Compresseur 10 000 L"], ["minipelle", "Mini pelle"],
      ["gyro", "Gyroscopique + treuil"], ["soudure", "Groupe soudure"]] },
    { id: "fournitures", lib: "Fournitures", t: "q", lignes: [
      ["ciment", "Ciment", "sacs"], ["tubes", "Tubes", "a"], ["platines", "Platines", "a"],
      ["pointes", "Pointes / bilames / tricônes", "a"], ["profiles", "Profilés HEB / HEA", "a"], ["gewi", "Barres GEWI", "a"],
      ["toles", "Tôles", "kg"], ["treillis", "Treillis", "kg"], ["beton", "Béton", "m³"], ["bois", "Bois", "planches"],
      ["gnr", "GNR", "jours"]] },
    { id: "divers", lib: "Divers", t: "q", lignes: [
      ["geometre", "Géomètre", "forfait"], ["deblais", "Déblais", "m³"], ["essai", "Essai de traction", "forfait"], ["autreDiv", "Autre", "forfait"]] },
    { id: "transports", lib: "Transports", t: "q", lignes: [
      ["trForage", "Matériel forage / battage", "forfait"], ["trSupp", "Matériel supplémentaire", "forfait"], ["trLoc", "Matériel location", "forfait"]] },
  ];
  // Annexe « Quantités tubes » (désignations et poids techniques, pas de prix)
  const TUBES = [["60,3 × 5", ["1", "1,5", "2", "3", "5"]], ["73 × 5,51", ["1", "1,5", "1,5+P", "2", "3", "3+P"]],
    ["88,9 × 6,5", ["1", "1,5", "1,5+P", "2", "3", "3+P"]], ["114 × 7", ["1", "1,5", "2", "3", "3+P"]],
    ["127 × 9,19", ["1,5", "2", "3", "3+P"]], ["139 × 10,5", ["1", "1,5", "3", "3+P"]], ["152,4 × 10", ["3"]],
    ["177,8 × 10", ["1"]], ["177,8 × 10,5", ["1,5", "2", "3"]]]
    .flatMap(([d, ls]) => ls.map((l) => ({ k: "tb_" + (d + "_" + l).replace(/[^0-9a-zA-Z+]/g, "").replace(/\+/g, "P"), lib: `Tube Ø ${d}`, l: l + " m" })));
  const PROFILES = [["HEB 120", 26.7], ["HEB 140", 33.7], ["HEB 160", 42.6], ["HEB 180", 51.2], ["HEB 200", 61.3], ["HEB 220", 71.5],
    ["HEB 240", 83.2], ["HEB 260", 93], ["HEB 280", 103], ["HEB 300", 117], ["HEB 320", 127], ["HEB 340", 135], ["HEB 360", 142],
    ["HEB 380", 155], ["HEB 400", 171], ["HEA 200", 42.3], ["HEA 220", 50.5], ["HEA 240", 60.3], ["HEA 260", 68.2], ["HEA 280", 76.4],
    ["HEA 300", 88.3], ["HEA 320", 97.6], ["HEA 340", 105], ["HEA 360", 112], ["CORNIÈRE", 0]]
    .map(([n, pml]) => ({ k: "pf_" + n.normalize("NFD").replace(/[^0-9A-Z]/gi, ""), lib: n, pml }))
    .concat([1, 2, 3].map((i) => ({ k: "pf_libre" + i, lib: "", pml: 0, libre: true })));
  const PLATINES = [["60,3", "150×150", 15], ["percée", "150×150", 15], ["73", "160×160", 15], ["114", "160×160", 15], ["88,9", "200×200", 20],
    ["127", "200×200", 20], ["114", "220×220", 20], ["177,8", "220×220", 20], ["127", "300×300", 25], ["139", "300×300", 25], ["177,8", "300×300", 30]]
    .map(([d, s, e], i) => ({ k: "pl_" + (i + 1), lib: `Platine Ø ${d} · ${s} · ép. ${e}` }));
  const POINTES = ["60", "73", "88,9", "114", "127", "139", "177,8"].map((d) => ({ k: "bi_" + d.replace(",", ""), lib: `Bilame Ø ${d} · 250 mm` }))
    .concat(["160", "180", "200", "220", "250", "300"].map((d) => ({ k: "tr_" + d, lib: `Tricône perdu ${d}` })));
  const GEWI = ["16", "20", "25", "28", "32", "40"].map((d) => ({ k: "gw_" + d, lib: `Barre GEWI ${d}`, u: "ml" }));
  const ANNEXES = { tubes: TUBES, platines: PLATINES, pointes: POINTES, profiles: PROFILES, gewi: GEWI };
  const PARAMS = [["_fg", "Frais généraux, assurance", "%"], ["_prov", "Provisions soutènement", "%"], ["_gd", "Grand déplacement", "€ / nuit"]];

  const libLigne = (k) => { for (const g of GROUPES) { const l = g.lignes.find((x) => x[0] === k); if (l) return l[1]; } return k; };
  const groupeDe = (k) => GROUPES.find((g) => g.lignes.some((l) => l[0] === k));
  /** Toutes les lignes tarifées (clé, groupe, désignation, unité), pour la feuille Tarifs */
  function catalogue() {
    const out = [];
    GROUPES.forEach((g) => g.lignes.forEach(([k, lib, u]) => { if (u !== "a") out.push([k, g.lib, lib, g.t === "q" ? u : "jour"]); }));
    [["tubes", "Tubes"], ["platines", "Platines"], ["pointes", "Pointes"], ["profiles", "Profilés"], ["gewi", "Barres GEWI"]].forEach(([a, lib]) =>
      ANNEXES[a].forEach((x) => { if (!x.libre) out.push([x.k, "Annexe " + lib, x.lib + (x.l ? " · " + x.l : ""), a === "profiles" ? "kg" : x.u || "u"]); }));
    PARAMS.forEach(([k, lib, u]) => out.push([k, "Paramètres", lib, u]));
    return out;
  }

  // ─── Outils ──────────────────────────────────────────────────
  const esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  const num = (v) => { if (typeof v === "number") return isFinite(v) ? v : 0; const n = parseFloat(String(v == null ? "" : v).replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
  const fmt = (n, d = 2) => { const v = Math.round(num(n) * 100) / 100; return v.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: d }).replace(/[\u202f\u00a0]/g, " "); };
  const eur = (n) => Math.round(num(n)).toLocaleString("fr-FR").replace(/[\u202f\u00a0]/g, " ") + " €"; // espaces normales (le PDF n'a pas l'espace fine)
  const val = (v) => (v === "" || v == null ? "" : fmt(v, 3));
  const sansAccent = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const code = (nom) => { const i = String(nom).search(/\s/); return i > 0 ? String(nom).slice(0, i) : String(nom); };
  const libelle = (nom) => { const i = String(nom).search(/\s/); return i > 0 ? String(nom).slice(i + 1) : ""; };
  const parseFR = (s) => { const m = String(s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; };
  const auj = () => new Date().toLocaleDateString("fr-FR");
  const semaineISO = (d) => { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const j = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - j); const a = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return Math.ceil(((x - a) / 86400000 + 1) / 7); };
  const moi = () => (window.FTSModules && FTSModules.moi && FTSModules.moi()) || (window.FTSAuth && FTSAuth.emailMemorise && FTSAuth.emailMemorise()) || "";
  const ent = (json) => ({ Authorization: "Bearer " + FTSAuth.getToken(), ...(json ? { "Content-Type": "application/json" } : {}) });
  async function req(url, o = {}, essais = 4) {
    for (let i = 0; ; i++) {
      const r = await fetch(url, { ...o, headers: { ...ent(!!o.body), ...(o.headers || {}) } });
      if ((r.status === 429 || r.status >= 500) && i < essais - 1) { await new Promise((ok) => setTimeout(ok, 600 * (i + 1) * (i + 1))); continue; }
      return r;
    }
  }
  async function reqJson(url, o, quoi) {
    const r = await req(url, o);
    if (!r.ok) throw new Error(`${quoi} : ${r.status}`);
    return r.status === 204 ? null : r.json();
  }

  // ─── Classeur « Tarifs et résultats FTS » ────────────────────
  let classeur = null; // { id, canEdit, owned }
  async function trouverClasseur() {
    for (const q of [`appProperties has { key='ftsRole' and value='${ROLE}' } and trashed = false`,
      `name = '${NOM_CLASSEUR}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`]) {
      const d = await reqJson(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,ownedByMe,capabilities/canEdit)`, {}, "Recherche du classeur des résultats");
      const f = (d.files || [])[0];
      if (f) return (classeur = { id: f.id, owned: !!f.ownedByMe, canEdit: !!(f.capabilities && f.capabilities.canEdit) });
    }
    return (classeur = null);
  }
  async function creerClasseur() {
    const d = await reqJson(SHEETS, { method: "POST", body: JSON.stringify({ properties: { title: NOM_CLASSEUR, locale: "fr_FR" }, sheets: [O_TARIFS, O_INFOS, O_RES].map((t) => ({ properties: { title: t } })) }) }, "Création du classeur des résultats");
    const id = d.spreadsheetId;
    await reqJson(`${DRIVE}/files/${id}?fields=id`, { method: "PATCH", body: JSON.stringify({ appProperties: { ftsRole: ROLE }, description: "Tarifs et résultats chantier de la Supervision FTS. Confidentiel : partagé uniquement aux personnes qui ont le module Résultats (écran Accès, compte conduc.fts). Ne pas déplacer dans les dossiers FTS." }) }, "Classeur des résultats");
    const lignes = [["Clé", "Groupe", "Désignation", "Unité", "P.U."], ...catalogue().map((l) => [...l, ""])];
    await reqJson(`${SHEETS}/${id}/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data: [
      { range: `${O_TARIFS}!A1`, values: lignes },
      { range: `${O_INFOS}!A1`, values: [["Tarifs de l'année", ""], ["Mis à jour le", ""], ["Par", ""]] },
      { range: `${O_RES}!A1`, values: [ENTETE_RES] }] }) }, "Initialisation du classeur des résultats");
    classeur = { id, owned: true, canEdit: true };
    return classeur;
  }

  /**
   * Partage du classeur tenu à jour : modification pour chaque encadrant
   * actif qui a le module « resultats », personne d'autre (ni lien public).
   * Appelé par conduc.fts (écran Accès, et à la création du classeur).
   */
  async function synchroniserPartages() {
    try {
      const f = classeur || (await trouverClasseur());
      if (!f || !f.owned) return { ok: false };
      if (!(await FTSPersonnel.charger({ rapide: true }).catch(() => null))) return { ok: false };
      const gens = FTSPersonnel.toutes().filter((p) => p.email && p.statut === "ACTIF" && (p.categorie === "ENCADREMENT" || p.fonctionEnc));
      if (!gens.length) return { ok: false }; // base vide : on ne retire rien
      const reg = await FTSModules.lireReglages().catch(() => null);
      const poste = (p) => (p.categorie === "ENCADREMENT" ? p.poste : p.fonctionEnc) || "";
      const voulus = gens.filter((p) => FTSModules.modulesPour(poste(p), p.email, reg).includes("resultats"));
      const cle = (e) => FTSModules.mail(e);
      const set = new Set(voulus.map((p) => cle(p.email)));
      const d = await reqJson(`${DRIVE}/files/${f.id}/permissions?fields=permissions(id,type,role,emailAddress)`, {}, "Partages du classeur des résultats");
      const perms = d.permissions || [];
      const sansCompte = [];
      for (const p of voulus) {
        const ex = perms.find((x) => x.type === "user" && cle(x.emailAddress) === cle(p.email));
        if (ex && ex.role === "writer") continue;
        if (ex) { await req(`${DRIVE}/files/${f.id}/permissions/${ex.id}`, { method: "PATCH", body: JSON.stringify({ role: "writer" }) }); continue; }
        const a = await req(`${DRIVE}/files/${f.id}/permissions?sendNotificationEmail=false`, { method: "POST", body: JSON.stringify({ role: "writer", type: "user", emailAddress: p.email }) });
        if (!a.ok) sansCompte.push(p.email);
      }
      for (const x of perms) {
        if (x.role === "owner") continue;
        if (x.type === "user" && set.has(cle(x.emailAddress))) continue;
        await req(`${DRIVE}/files/${f.id}/permissions/${x.id}`, { method: "DELETE" }).catch(() => {});
      }
      return { ok: true, nb: voulus.length, sansCompte };
    } catch (e) { console.warn("Partage du classeur des résultats :", e); return { ok: false, erreur: e.message }; }
  }

  let tarifs = null; // { pu: {clé: nombre|""}, annee, majLe, par, lignes: n° de ligne par clé }
  async function lireTarifs() {
    const d = await reqJson(`${SHEETS}/${classeur.id}/values:batchGet?ranges=${O_TARIFS}!A2:E&ranges=${O_INFOS}!A1:B3`, {}, "Lecture des tarifs");
    const [t, inf] = (d.valueRanges || []).map((v) => v.values || []);
    const pu = {}, lignes = {};
    t.forEach((l, i) => { if (l[0]) { pu[l[0]] = l[4] === undefined || l[4] === "" ? "" : num(l[4]); lignes[l[0]] = i + 2; } });
    const info = (n) => ((inf[n] || [])[1] || "");
    tarifs = { pu, lignes, annee: info(0), majLe: info(1), par: info(2) };
    return tarifs;
  }
  async function ecrireTarifs(pu, annee) {
    const cat = catalogue();
    const lignes = [["Clé", "Groupe", "Désignation", "Unité", "P.U."], ...cat.map((l) => [...l, pu[l[0]] === "" || pu[l[0]] == null ? "" : num(pu[l[0]])])];
    await reqJson(`${SHEETS}/${classeur.id}/values:batchClear`, { method: "POST", body: JSON.stringify({ ranges: [`${O_TARIFS}!A:E`] }) }, "Enregistrement des tarifs");
    await reqJson(`${SHEETS}/${classeur.id}/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data: [
      { range: `${O_TARIFS}!A1`, values: lignes },
      { range: `${O_INFOS}!A1`, values: [["Tarifs de l'année", annee], ["Mis à jour le", auj()], ["Par", moi()]] }] }) }, "Enregistrement des tarifs");
    return lireTarifs();
  }

  let resultats = new Map(); // chantierId → { ligne, etat, data, ... }
  async function lireResultats() {
    const d = await reqJson(`${SHEETS}/${classeur.id}/values/${O_RES}!A2:L`, {}, "Lecture des résultats");
    resultats = new Map();
    (d.values || []).forEach((l, i) => {
      if (!l[0]) return;
      let data = null;
      try { data = JSON.parse(l[11] || "null"); } catch (e) { data = null; }
      resultats.set(l[0], { ligne: i + 2, etat: l[3] || "", facturation: num(l[5]), depenses: num(l[6]), resultat: num(l[7]), marge: num(l[8]), modifieLe: l[9] || "", par: l[10] || "", data });
    });
    return resultats;
  }
  async function ecrireResultat(fiche) {
    const c = calculer(fiche);
    const ligne = [fiche.chantierId, fiche.code, fiche.nom, fiche.etat === "cloture" ? "Clôturé" : "En saisie", fiche.entete.conducteur || "",
      Math.round(c.fact * 100) / 100, Math.round(c.dep * 100) / 100, Math.round(c.res * 100) / 100, c.fact ? Math.round((c.res / c.fact) * 1000) / 10 : "",
      new Date().toLocaleString("fr-FR"), moi(), JSON.stringify(fiche)];
    const ex = resultats.get(fiche.chantierId);
    if (ex && ex.ligne) {
      await reqJson(`${SHEETS}/${classeur.id}/values/${O_RES}!A${ex.ligne}:L${ex.ligne}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [ligne] }) }, "Enregistrement du résultat");
    } else {
      const d = await reqJson(`${SHEETS}/${classeur.id}/values/${O_RES}!A1:L1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: "POST", body: JSON.stringify({ values: [ligne] }) }, "Enregistrement du résultat");
      const m = String((d.updates || {}).updatedRange || "").match(/!A(\d+)/);
      resultats.set(fiche.chantierId, { ligne: m ? +m[1] : null });
    }
    const r = resultats.get(fiche.chantierId);
    Object.assign(r, { etat: ligne[3], facturation: ligne[5], depenses: ligne[6], resultat: ligne[7], marge: ligne[8], modifieLe: ligne[9], par: ligne[10], data: fiche });
  }

  // ─── Chantiers terminés (actifs « Terminé » + archivés) ──────
  let chantiers = []; // [{ id, name, meta, archive }]
  async function chargerChantiers(forcer) {
    const d = await opts.obtenirDonnees(forcer);
    const marches = await FTSDrive.lireMarches().catch(() => new Map());
    const actifs = (d.chantiers || []).filter((c) => (c.meta || {}).statutChantier === "Termine").map((c) => ({ id: c.id, name: c.name, meta: c.meta || {}, archive: false }));
    let archives = [];
    try { archives = await FTSDrive.listChantiersArchives(); } catch (e) { console.warn("Résultats : archives illisibles", e); }
    const vus = new Set(actifs.map((c) => c.id));
    const arch = archives.filter((a) => !vus.has(a.id)).map((a) => ({ id: a.id, name: a.name, meta: FTSDrive.appliquerMontants(a.id, FTSDrive.parseMetadonnees(a.description), marches), archive: true }));
    const mp = (c) => { const t = FTSDrive.techniquesChantier(c.meta); return t.includes("Micropieux") || t.includes("Battage"); };
    chantiers = [...actifs, ...arch].filter(mp);
    return chantiers;
  }
  const facturationVendue = (meta) => (num(meta.montantVendu) || 0) + (Array.isArray(meta.avenants) ? meta.avenants.reduce((s, a) => s + num(a.montant), 0) : 0);

  // ─── Pré-remplissage depuis les pointages et les rapports ────
  // Correspondance machine du pointage → ligne de l'Excel (FTS / location)
  const MACHINES_FTS = [
    ["mc15", /MC ?15/], ["mc8", /MC ?8|MC ?6|DCH|EGT|MD ?1500|GEO ?205/], ["t41", /T ?41|T ?46/], ["futuro", /FUTURO/],
    ["ma12", /MA ?12|PH ?15|TMD|AUTONOME/], ["mixo", /MIXO|MI ?100/], ["lutz", /LUTZ|ENREGISTREUR/], ["groupe", /GROUPE|GE ?60|KVA/],
    ["comp20", /COMPRESSEUR|00COMP/], ["pdm", /PDM/], ["dessableur", /DESSABLEUR|MR ?2000/], ["cuve", /CUVE/],
    ["pajot600", /PAJOT ?600/], ["pajot1400", /PAJOT ?1400/], ["membrane", /MEMBRANE/]];
  const MACHINES_LOC = [["telesco", /TELESCO/], ["comp10", /COMPRESSEUR/], ["minipelle", /PELLE/], ["gyro", /GYRO/], ["soudure", /SOUDURE/]];
  // Jours comptés au résultat : seulement les jours « Travail » (Clément, 18/11/2026 : une machine
  // qui a travaillé ne serait-ce qu'une heure est pointée Travail ; panne, arrêt, transport non comptés)
  const STATUTS_COMPTES = /^TRAVAIL$/i;
  // Lignes qui comptent pour les consommables et le GNR (règle de l'Excel, MC15 ajoutée)
  const POUR_CONSO = ["mc15", "mc8", "t41", "futuro", "pajot600", "pajot1400", "membrane"];
  const POUR_GNR = ["mc15", "mc8", "t41", "futuro", "pajot600", "pajot1400"];
  // Poste de Personnel FTS → ligne personnel de l'Excel
  const POSTE_LIGNE = { "CHEF DE CHANTIER": "foreur", FOREUR: "foreur", SECOND: "aideForeur", POMPISTE: "aideForeur", "MANŒUVRE": "manoeuvre", MANOEUVRE: "manoeuvre", POLYVALENT: "manoeuvre", SOUDEUR: "soudeur", "RECÉPEUR": "recepeur", RECEPEUR: "recepeur" };

  function preRemplir(c, s, pu) {
    const L = {}, avert = [];
    const p = (k) => (pu[k] === "" || pu[k] == null ? "" : pu[k]);
    // Production
    const prod = (s.production || []).filter((r) => parseFR(r[0]));
    const dates = [...new Set(prod.map((r) => String(r[0]).trim()))].map(parseFR).sort((a, b) => a - b);
    const joursProd = dates.length;
    const nbMpx = prod.reduce((t, r) => t + num(r[1]), 0);
    const ml = prod.reduce((t, r) => t + num(r[2]), 0);
    // Personnel : jours-hommes par poste, grands déplacements
    const pers = {};
    const inconnus = new Set();
    (s.personnel || []).filter((r) => parseFR(r[0]) && String(r[1] || "").trim()).forEach((r) => {
      const nom = String(r[1]).trim();
      const interim = /INTERIM/.test(sansAccent(r[2]));
      const fiche = !interim && window.FTSPersonnel ? FTSPersonnel.parNom(nom) : null;
      let k = fiche ? POSTE_LIGNE[String(fiche.poste || "").toUpperCase()] : null;
      if (!k) { k = "manoeuvre"; if (!interim) inconnus.add(nom); }
      pers[k] = pers[k] || { jours: new Set(), j: 0, gd: 0 };
      const cle = String(r[0]).trim() + "|" + sansAccent(nom);
      if (pers[k].jours.has(cle)) return; // même personne, même jour : une seule fois
      pers[k].jours.add(cle);
      pers[k].j += 1;
      if (String(r[3] || "").trim()) pers[k].gd += 1;
    });
    GROUPES[0].lignes.forEach(([k]) => { L[k] = { nb: 1, j: pers[k] ? pers[k].j : "", pu: p(k), gd: pers[k] && pers[k].gd ? pers[k].gd : "" }; });
    if (inconnus.size) avert.push(`Absents de Personnel FTS, comptés en manœuvre : ${[...inconnus].join(", ")}.`);
    // Matériel : jours-machine par ligne (MA12 + PH15 le même jour = un seul ensemble)
    const jm = {}, nonReconnus = {};
    const parJour = {};
    (s.materiel || []).filter((r) => parseFR(r[0]) && STATUTS_COMPTES.test(String(r[2] || "").trim())).forEach((r) => {
      const nomM = sansAccent(`${r[1] || ""} ${r[4] || ""}`);
      const loc = /LOC/i.test(String(r[3] || ""));
      const t = (loc ? MACHINES_LOC : MACHINES_FTS).find(([, re]) => re.test(nomM));
      if (!t) { const n = String(r[1] || "?").trim() + (loc ? " (location)" : ""); nonReconnus[n] = (nonReconnus[n] || 0) + 1; return; }
      const k = t[0], jour = String(r[0]).trim();
      const unite = k === "ma12" ? (/PH ?15|AUTONOME/.test(nomM) ? "ph" : /TMD/.test(nomM) ? "tmd" : "ma") : sansAccent(r[4] || r[1]);
      parJour[k] = parJour[k] || {};
      parJour[k][jour] = parJour[k][jour] || {};
      parJour[k][jour][unite] = (parJour[k][jour][unite] || new Set()).add(sansAccent(r[4] || r[1]));
    });
    Object.entries(parJour).forEach(([k, jours]) => {
      jm[k] = Object.values(jours).reduce((t, u) => t + (k === "ma12" ? Math.max(...Object.values(u).map((x) => x.size)) : Object.keys(u).length), 0);
    });
    // Jours de chantier (fourgon) : jours de production ou de matériel au travail
    const joursChantier = new Set([...(s.materiel || []).filter((r) => STATUTS_COMPTES.test(String(r[2] || "").trim())), ...prod].map((r) => String(r[0] || "").trim()).filter((x) => parseFR(x))).size;
    GROUPES[1].lignes.forEach(([k]) => { L[k] = { nb: 1, j: jm[k] || "", pu: p(k) }; });
    const somme = (ks) => ks.reduce((t, k) => t + (jm[k] || 0), 0);
    L.consommables.j = somme(POUR_CONSO) || "";
    L.fourgon.j = joursChantier || "";
    GROUPES[2].lignes.forEach(([k]) => { L[k] = { nb: 1, j: jm[k] || "", pu: p(k) }; });
    const nr = Object.entries(nonReconnus);
    if (nr.length) avert.push(`Machines du pointage sans ligne dans la fiche (à reporter à la main) : ${nr.map(([n, j]) => `${n} ${j} j`).join(", ")}.`);
    // Fournitures, divers, transports
    GROUPES.slice(3).forEach((g) => g.lignes.forEach(([k, , u]) => { L[k] = u === "a" ? {} : { q: "", pu: p(k) }; }));
    L.gnr.q = somme(POUR_GNR) || "";
    // Annexe
    const A = {};
    Object.values(ANNEXES).forEach((liste) => liste.forEach((x) => { A[x.k] = x.pml !== undefined ? { long: "", nb: "", pml: x.pml || "", pu: p(x.k), lib: x.libre ? "" : undefined } : { q: "", pu: p(x.k) }; }));
    const meta = c.meta || {};
    const sem = dates.length ? [semaineISO(dates[0]), semaineISO(dates[dates.length - 1])] : null;
    return {
      fiche: {
        v: 1, chantierId: c.id, code: code(c.name), nom: libelle(c.name), etat: "saisie", creeLe: auj(),
        entete: { conducteur: meta.conducteur || "", semaines: sem ? (sem[0] === sem[1] ? `semaine ${sem[0]}` : `semaines ${sem[0]} à ${sem[1]}`) : "", montant: facturationVendue(meta) },
        prod: { nb: nbMpx, lm: nbMpx ? Math.round((ml / nbMpx) * 100) / 100 : "", jours: joursProd },
        facturation: facturationVendue(meta),
        fg: pu._fg === "" || pu._fg == null ? "" : pu._fg, prov: pu._prov === "" || pu._prov == null ? "" : pu._prov, provNA: false,
        gd: pu._gd === "" || pu._gd == null ? "" : pu._gd,
        tarifsDu: tarifs ? `${tarifs.annee || ""}${tarifs.majLe ? ` (mis à jour le ${tarifs.majLe})` : ""}`.trim() : "",
        L, A,
      },
      avert,
    };
  }

  // ─── Calculs ─────────────────────────────────────────────────
  function totalLigne(f, g, k) {
    const x = f.L[k] || {};
    if (g.t === "p") return num(x.nb) * (num(x.j) * num(x.pu) + num(x.gd) * num(f.gd));
    if (g.t === "j") return num(x.nb) * num(x.j) * num(x.pu);
    const u = (g.lignes.find((l) => l[0] === k) || [])[2];
    if (u === "a") return totalAnnexe(f, k);
    return num(x.q) * num(x.pu);
  }
  const totalAnnexeLigne = (f, x) => { const a = f.A[x.k] || {}; return x.pml !== undefined ? num(a.long) * num(a.nb) * num(a.pml) * num(a.pu) : num(a.q) * num(a.pu); };
  const totalAnnexe = (f, a) => ANNEXES[a].reduce((t, x) => t + totalAnnexeLigne(f, x), 0);
  function calculer(f) {
    const g = {};
    GROUPES.forEach((gr) => { g[gr.id] = gr.lignes.reduce((t, [k]) => t + totalLigne(f, gr, k), 0); });
    const dep = Object.values(g).reduce((a, b) => a + b, 0);
    const fact = num(f.facturation);
    const fg = (num(f.fg) / 100) * fact;
    const prov = f.provNA ? 0 : (num(f.prov) / 100) * fact;
    return { g, dep, fact, fg, prov, res: fact - dep - fg - prov };
  }
  const ligneRemplie = (f, g, k) => Math.abs(totalLigne(f, g, k)) > 0.004;

  // ─── Affichage ───────────────────────────────────────────────
  let racine = null, opts = {}, vue = "liste", fiche = null, avertissements = [], statut = "", enCours = false, sauveTimer = null, derniereErreur = "";
  const $ = (s) => racine.querySelector(s);

  function monter(el, o) {
    racine = el;
    opts = o || {};
    racine.classList.add("rs");
    if (!racine.dataset.ecoute) {
      racine.dataset.ecoute = "1";
      racine.addEventListener("click", clic);
      racine.addEventListener("input", saisie);
      racine.addEventListener("change", (e) => { if (e.target.matches("[data-provna]")) saisie(e); });
    }
    vue = "liste";
    charger();
  }

  async function charger(forcer = false) {
    if (enCours) return;
    enCours = true; derniereErreur = "";
    rendreListe("Chargement…");
    try {
      if (!window.FTSAuth || !FTSAuth.isSignedIn()) throw new Error("Connecte-toi d'abord (bouton en haut de la page).");
      await trouverClasseur();
      if (!classeur) { enCours = false; rendreSansClasseur(); return; }
      if (window.FTSPersonnel) await FTSPersonnel.charger({ rapide: true }).catch(() => null);
      await Promise.all([lireTarifs(), lireResultats(), chargerChantiers(forcer)]);
      majPastille();
    } catch (e) {
      console.error("Résultats :", e);
      derniereErreur = e.message || String(e);
    }
    enCours = false;
    if (vue === "liste") rendreListe();
  }

  const proprio = () => !!(window.FTSModules && FTSModules.etat() && FTSModules.etat().statut === "proprio");
  function rendreSansClasseur() {
    racine.innerHTML = proprio()
      ? `<section class="sv-card rs-vide"><h2>Classeur des résultats à créer</h2><p>Les tarifs et les résultats sont rangés dans un classeur « ${esc(NOM_CLASSEUR)} » qui appartient à ce compte (conduc.fts), hors des dossiers FTS. Il sera partagé uniquement aux personnes qui ont le module Résultats (conducteurs de travaux et directrice travaux par défaut).</p>
         <button type="button" class="sv-btn pri" data-a="creer">Créer le classeur</button><p class="rs-st-msg">${esc(statut)}</p></section>`
      : `<section class="sv-card rs-vide"><h2>🔒 Classeur des résultats non accessible</h2><p>Le classeur des tarifs et des résultats n'est pas encore partagé avec ton compte. Demande à Clément MALECOT : il suffit d'ouvrir la page Accès avec le compte conduc.fts.</p></section>`;
  }

  function majPastille() {
    const n = chantiers.filter((c) => (resultats.get(c.id) || {}).etat !== "Clôturé").length;
    document.querySelectorAll("#navResultatsPill").forEach((p) => { p.textContent = n; p.hidden = !n; });
  }

  function bandeauTarifs() {
    const t = tarifs || { pu: {} };
    const rempli = Object.keys(t.pu).filter((k) => t.pu[k] !== "").length;
    const fg = t.pu._fg, pr = t.pu._prov, gd = t.pu._gd;
    const infos = [fg !== "" && fg != null ? `FG ${fmt(fg)} %` : "", pr !== "" && pr != null ? `provisions ${fmt(pr)} %` : "", gd !== "" && gd != null ? `grand déplacement ${fmt(gd)} €` : ""].filter(Boolean).join(" · ");
    return `<div class="rs-tarifs">💶 <span>${rempli ? `<b>Tarifs ${esc(t.annee || "")}</b>${t.majLe ? ` · mis à jour le ${esc(t.majLe)}${t.par ? ` par ${esc(t.par)}` : ""}` : ""}${infos ? " · " + infos : ""}` : "<b>Aucun tarif enregistré</b> · renseigne les prix avant de commencer une fiche"}</span>
      <span class="sv-sp"></span><button type="button" class="sv-btn" data-a="tarifs">${rempli ? "Mettre à jour les tarifs" : "Saisir les tarifs"}</button></div>`;
  }

  function rendreListe(msg) {
    vue = "liste";
    if (!classeur && !msg && !derniereErreur) { rendreSansClasseur(); return; }
    const etat = (c) => resultats.get(c.id) || null;
    const aFaire = chantiers.filter((c) => (etat(c) || {}).etat !== "Clôturé");
    const faits = chantiers.filter((c) => (etat(c) || {}).etat === "Clôturé");
    const tri = (a, b) => (parseFR(b.meta.dateFinChantier) || 0) - (parseFR(a.meta.dateFinChantier) || 0);
    const ligne = (c) => {
      const r = etat(c);
      const st = !r ? '<span class="rs-st st-a">à faire</span>' : r.etat === "Clôturé" ? `<span class="rs-st st-c">clôturé${r.data && r.data.clotureLe ? " " + esc(String(r.data.clotureLe).slice(0, 5)) : ""}</span>` : '<span class="rs-st st-p">commencé</span>';
      return `<tr data-ouvrir="${esc(c.id)}"><td><b>${esc(code(c.name))}</b> ${esc(libelle(c.name))}${c.archive ? ' <span class="rs-arch">archivé</span>' : ""}</td><td>${esc(c.meta.conducteur || "—")}</td><td>${esc(String(c.meta.dateFinChantier || "").slice(0, 5) || "—")}</td>
        <td class="r">${r ? eur(r.facturation) : "—"}</td><td class="r">${r ? eur(r.resultat) : "—"}</td><td class="r">${r && r.facturation ? fmt(r.marge, 1) + " %" : "—"}</td><td>${st}</td></tr>`;
    };
    const corps = !chantiers.length
      ? `<tr><td colspan="7" class="rs-rien">${msg ? esc(msg) : "Aucun chantier micropieux terminé pour l'instant. Un chantier apparaît ici dès qu'il est marqué Terminé."}</td></tr>`
      : `<tr class="rs-grp"><td colspan="7">À FAIRE · ${aFaire.length}</td></tr>${aFaire.sort(tri).map(ligne).join("") || '<tr><td colspan="7" class="rs-rien">Rien à faire 👍</td></tr>'}
         <tr class="rs-grp"><td colspan="7">FAITS · ${faits.length}</td></tr>${faits.sort(tri).map(ligne).join("") || '<tr><td colspan="7" class="rs-rien">Aucun résultat clôturé.</td></tr>'}`;
    racine.innerHTML = `${classeur ? bandeauTarifs() : ""}
      ${derniereErreur ? `<div class="sv-banner">❌ ${esc(derniereErreur)} <span class="sv-sp"></span><button type="button" class="sv-btn" data-a="recharger">Réessayer</button></div>` : ""}
      <section class="sv-card"><div class="sv-ch"><h2>Résultats chantier</h2><span class="s">micropieux et battage · chantiers terminés et archivés · confidentiel</span><span class="sv-sp"></span>${msg ? `<span class="s">${esc(msg)}</span>` : `<button type="button" class="sv-btn" data-a="recharger" title="Recharger depuis Google">🔄</button>`}</div>
      <div class="se-table-scroll"><table class="sv-tbl rs-list"><thead><tr><th>Chantier</th><th>Conducteur</th><th>Fin</th><th class="r">Facturation</th><th class="r">Résultat net</th><th class="r">Marge</th><th>État</th></tr></thead><tbody>${corps}</tbody></table></div></section>
      <p class="rs-foot">« À faire » = chantier terminé dont le résultat n'est pas clôturé. Clic sur une ligne = la fiche. Les chiffres sont lus dans le classeur « ${esc(NOM_CLASSEUR)} » du Drive, partagé uniquement aux personnes qui ont ce module.</p>`;
  }

  // ─── Fiche ───────────────────────────────────────────────────
  async function ouvrir(id) {
    const c = chantiers.find((x) => x.id === id);
    if (!c) return;
    vue = "fiche"; statut = ""; avertissements = [];
    racine.innerHTML = `<div class="rs-chargement">Chargement de la fiche ${esc(code(c.name))}…</div>`;
    try {
      const r = resultats.get(id);
      if (r && r.data) { fiche = r.data; }
      else {
        const s = (await FTSSheets.chargerDonneesSupervision([{ id: c.id, name: c.name }]))[0] || {};
        const p = preRemplir(c, s, (tarifs && tarifs.pu) || {});
        fiche = p.fiche; avertissements = p.avert;
      }
      rendreFiche();
    } catch (e) { console.error(e); racine.innerHTML = `<div class="sv-banner">❌ ${esc(e.message)} <span class="sv-sp"></span><button type="button" class="sv-btn" data-a="liste">← Retour</button></div>`; }
  }

  async function reprendrePointages() {
    const c = chantiers.find((x) => x.id === fiche.chantierId);
    if (!c || !confirm("Reprendre les jours du personnel et du matériel, le GNR, les consommables, le fourgon et la production depuis les pointages ?\n\nLes prix, les fournitures, les divers et les transports ne bougent pas.")) return;
    const s = (await FTSSheets.chargerDonneesSupervision([{ id: c.id, name: c.name }]))[0] || {};
    const p = preRemplir(c, s, (tarifs && tarifs.pu) || {});
    GROUPES.slice(0, 3).forEach((g) => g.lignes.forEach(([k]) => { fiche.L[k] = { ...fiche.L[k], nb: p.fiche.L[k].nb, j: p.fiche.L[k].j, ...(g.t === "p" ? { gd: p.fiche.L[k].gd } : {}) }; }));
    fiche.L.gnr = { ...fiche.L.gnr, q: p.fiche.L.gnr.q };
    fiche.prod = p.fiche.prod;
    fiche.entete.semaines = p.fiche.entete.semaines;
    avertissements = p.avert;
    rendreFiche(); planifierSauvegarde(true);
  }

  const inp = (path, v, cls = "", ph = "0") => `<input class="${cls}" data-p="${path}" value="${esc(v === "" || v == null ? "" : val(v))}" placeholder="${ph}" inputmode="decimal"${fiche.etat === "cloture" ? " disabled" : ""}>`;
  function marqueModif(k, pu) {
    const t = tarifs && tarifs.pu ? tarifs.pu[k] : "";
    return t !== "" && t != null && pu !== "" && pu != null && Math.abs(num(pu) - num(t)) > 0.0001 ? `<span class="rs-mod" data-mod="${k}">modifié · tarif ${esc(fmt(t))}</span>` : `<span class="rs-mod" data-mod="${k}"></span>`;
  }
  function htmlGroupe(g) {
    const auto = g.auto ? `<span class="rs-b rs-auto">auto</span> <span class="rs-src">${esc(g.auto)}</span>` : '<span class="rs-b rs-man">à saisir</span>';
    let h = `<tr class="sep"><td colspan="6">${esc(g.lib.toUpperCase())} ${auto}</td></tr>`;
    g.lignes.forEach(([k, lib, u]) => {
      const x = fiche.L[k] || {};
      const cl = `${g.auto ? "" : "loc"} ${ligneRemplie(fiche, g, k) ? "" : "vide"}`;
      if (g.t === "p") h += `<tr class="${cl}" data-l="${k}"><td>${esc(lib)}</td><td class="r">${inp(`L.${k}.nb`, x.nb, "a")}</td><td class="r">${inp(`L.${k}.j`, x.j, "a")}</td><td class="r">${inp(`L.${k}.pu`, x.pu, "a")}${marqueModif(k, x.pu)}</td><td class="r">${inp(`L.${k}.gd`, x.gd, "a")}</td><td class="r" data-t="${k}"></td></tr>`;
      else if (g.t === "j") h += `<tr class="${cl}" data-l="${k}"><td>${esc(lib)}</td><td class="r">${inp(`L.${k}.nb`, x.nb, g.auto ? "a" : "")}</td><td class="r">${inp(`L.${k}.j`, x.j, g.auto ? "a" : "")}</td><td class="r">${inp(`L.${k}.pu`, x.pu, g.auto ? "a" : "")}${marqueModif(k, x.pu)}</td><td></td><td class="r" data-t="${k}"></td></tr>`;
      else if (u === "a") h += `<tr class="loc ${cl}" data-l="${k}"><td>${esc(lib)}</td><td class="r" colspan="4"><button type="button" class="sv-btn mini" data-annexe="${k}">Détail ${annexesOuvertes.has(k) ? "▴" : "▾"}</button></td><td class="r" data-t="${k}"></td></tr>${htmlAnnexe(k)}`;
      else h += `<tr class="${k === "gnr" ? "" : "loc"} ${cl}" data-l="${k}"><td>${esc(lib)}</td><td class="r rs-u">${esc(u)}</td><td class="r">${inp(`L.${k}.q`, x.q, k === "gnr" ? "a" : "")}</td><td class="r">${inp(`L.${k}.pu`, x.pu, k === "gnr" ? "a" : "", "P.U.")}${marqueModif(k, x.pu)}</td><td></td><td class="r" data-t="${k}"></td></tr>`;
    });
    h += `<tr class="stot"><td colspan="5">Sous-total ${esc(g.lib.toLowerCase())}</td><td class="r" data-st="${g.id}"></td></tr>`;
    return h;
  }
  const annexesOuvertes = new Set();
  function htmlAnnexe(a) {
    if (!annexesOuvertes.has(a)) return "";
    const liste = ANNEXES[a];
    const prof = a === "profiles";
    const tete = prof ? "<th>Profilé</th><th class=\"r\">Long. (m)</th><th class=\"r\">Nb barres</th><th class=\"r\">kg / ml</th><th class=\"r\">P.U. (€/kg)</th><th class=\"r\">Total</th>"
      : `<th>Article</th><th class="r">${a === "tubes" ? "Longueur" : ""}</th><th class="r">Quantité${a === "gewi" ? " (ml)" : ""}</th><th class="r">P.U.</th><th class="r">Total</th>`;
    const lignes = liste.map((x) => {
      const v = fiche.A[x.k] || {};
      const vide = totalAnnexeLigne(fiche, x) ? "" : "vide";
      if (prof) return `<tr class="${vide}"><td>${x.libre ? `<input class="rs-lib" data-p="A.${x.k}.lib" value="${esc(v.lib || "")}" placeholder="autre profilé"${fiche.etat === "cloture" ? " disabled" : ""}>` : esc(x.lib)}</td><td class="r">${inp(`A.${x.k}.long`, v.long)}</td><td class="r">${inp(`A.${x.k}.nb`, v.nb)}</td><td class="r">${inp(`A.${x.k}.pml`, v.pml)}</td><td class="r">${inp(`A.${x.k}.pu`, v.pu)}${marqueModif(x.k, v.pu)}</td><td class="r" data-ta="${x.k}"></td></tr>`;
      return `<tr class="${vide}"><td>${esc(x.lib)}</td><td class="r">${esc(x.l || "")}</td><td class="r">${inp(`A.${x.k}.q`, v.q)}</td><td class="r">${inp(`A.${x.k}.pu`, v.pu)}${marqueModif(x.k, v.pu)}</td><td class="r" data-ta="${x.k}"></td></tr>`;
    }).join("");
    return `<tr class="annexe"><td colspan="6"><table class="sv-tbl sub"><thead><tr>${tete}</tr></thead><tbody>${lignes}</tbody></table></td></tr>`;
  }

  function rendreFiche() {
    vue = "fiche";
    const f = fiche, clos = f.etat === "cloture";
    const c = chantiers.find((x) => x.id === f.chantierId) || {};
    racine.innerHTML = `
      <div class="dt-meta rs-meta"><a href="#" data-a="liste">← Résultats</a><span><b>${esc(f.code)}</b> ${esc(f.nom)}</span>
        <span>Conducteur <input class="rs-txt" data-p="entete.conducteur" value="${esc(f.entete.conducteur || "")}" placeholder="—"${clos ? " disabled" : ""}></span>
        <span>Exécution <input class="rs-txt" data-p="entete.semaines" value="${esc(f.entete.semaines || "")}" placeholder="semaines …"${clos ? " disabled" : ""}></span>
        <span class="rs-st ${clos ? "st-c" : "st-p"}">${clos ? `clôturé le ${esc(f.clotureLe || "")}` : "en cours de saisie"}</span>${c.archive ? '<span class="rs-arch">archivé</span>' : ""}
        <span class="sv-sp"></span><span class="rs-save" id="rsSave">${esc(statut)}</span></div>
      ${avertissements.length ? `<div class="sv-banner rs-avert">⚠️ ${avertissements.map(esc).join("<br>")}</div>` : ""}
      <div class="sv-kpis" style="--nk:4">
        <div class="sv-kpi"><div class="ico">🧾</div><div><div class="l">Facturation</div><div class="v" data-k="fact"></div><div class="s">marché + avenants validés</div></div></div>
        <div class="sv-kpi"><div class="ico">🛠️</div><div><div class="l">Dépenses</div><div class="v" data-k="dep"></div><div class="s">détail ci-dessous</div></div></div>
        <div class="sv-kpi"><div class="ico">🏢</div><div><div class="l">FG + provisions</div><div class="v" data-k="fgp"></div><div class="s" data-k="fgps"></div></div></div>
        <div class="sv-kpi rs-kres"><div class="ico">✅</div><div><div class="l">Résultat net</div><div class="v" data-k="res"></div><div class="s" data-k="marge"></div></div></div>
      </div>
      <div class="dt-grid rs-grid"><div class="dt-col">
        <section class="sv-card"><div class="sv-ch"><h2>Dépenses</h2><span class="s">toutes les lignes de l'Excel · tout est modifiable · grisé = vide, absent du PDF</span></div>
          <div class="se-table-scroll"><table class="sv-tbl rs-dep"><thead><tr><th>Désignation</th><th class="r">Nb / unité</th><th class="r">Jours / qté</th><th class="r">P.U.</th><th class="r">Gd dép.</th><th class="r">Total HT</th></tr></thead>
          <tbody>${GROUPES.map(htmlGroupe).join("")}<tr class="tot"><td colspan="5">Total des dépenses</td><td class="r" data-k="dep2"></td></tr></tbody></table></div></section>
      </div><div class="dt-col">
        <section class="sv-card"><div class="sv-ch"><h2>Production</h2><span class="rs-b rs-auto">auto</span> <span class="rs-src">rapports journaliers</span></div>
          <div class="rs-prod"><label><small>Micropieux</small>${inp("prod.nb", f.prod.nb, "a")} u</label><label><small>Longueur moyenne</small>${inp("prod.lm", f.prod.lm, "a")} ml</label>
          <label><small>Jours de production</small>${inp("prod.jours", f.prod.jours, "a")} j</label><div><small>Cadence moyenne</small><b data-k="cad"></b></div></div></section>
        <section class="sv-card"><div class="sv-ch"><h2>Calcul du résultat</h2></div>
          <table class="sv-tbl rs-calc"><tbody>
            <tr><td>Facturation <span class="rs-src">(montant total marché)</span></td><td class="r">${inp("facturation", f.facturation, "a rs-big")} €</td></tr>
            <tr><td>− Total des dépenses</td><td class="r" data-k="dep3"></td></tr>
            <tr><td>− F.G. assurance ${inp("fg", f.fg, "pc", "%")} %</td><td class="r" data-k="fgv"></td></tr>
            <tr><td>− Provisions soutènement ${inp("prov", f.prov, "pc", "%")} % <label class="rs-na"><input type="checkbox" data-provna${f.provNA ? " checked" : ""}${clos ? " disabled" : ""}> ne s'applique pas</label></td><td class="r" data-k="provv"></td></tr>
            <tr><td>Grand déplacement (forfait par nuit) ${inp("gd", f.gd, "pc", "€")} €</td><td></td></tr>
            <tr class="res"><td data-k="resl">Résultat net</td><td class="r" data-k="res2"></td></tr></tbody></table>
          <div class="rs-actions">
            ${clos ? "" : '<button type="button" class="sv-btn" data-a="pointages" title="Relire les pointages et les rapports">↻ Reprendre les pointages</button>'}
            <button type="button" class="sv-btn" data-a="apercu">🔍 Aperçu PDF</button><button type="button" class="sv-btn" data-a="imprimer">🖨️ Imprimer</button>
            <button type="button" class="sv-btn" data-a="pdf">💾 Enregistrer le PDF…</button>
            ${clos ? '<button type="button" class="sv-btn" data-a="rouvrir">Rouvrir la fiche</button>' : '<button type="button" class="sv-btn pri" data-a="cloturer">Clôturer le résultat</button>'}
          </div></section>
        <p class="rs-foot">Enregistré au fur et à mesure dans le classeur « ${esc(NOM_CLASSEUR)} » : on peut revenir finir plus tard. Un prix différent du tarif est signalé « modifié ». « Clôturer » fige la fiche et la range dans « Faits » (on peut la rouvrir). Le PDF ne va jamais sur le Drive : tu choisis où l'enregistrer.${f.tarifsDu ? ` Tarifs utilisés : ${esc(f.tarifsDu)}.` : ""}</p>
      </div></div>`;
    recalculer();
  }

  function recalculer() {
    const f = fiche, c = calculer(f);
    const set = (sel, txt) => racine.querySelectorAll(sel).forEach((e) => (e.textContent = txt));
    GROUPES.forEach((g) => {
      g.lignes.forEach(([k]) => {
        const t = totalLigne(f, g, k);
        set(`[data-t="${k}"]`, t ? fmt(t) : "0");
        const tr = racine.querySelector(`tr[data-l="${k}"]`);
        if (tr) tr.classList.toggle("vide", Math.abs(t) < 0.005);
      });
      set(`[data-st="${g.id}"]`, eur(c.g[g.id]));
    });
    Object.values(ANNEXES).forEach((liste) => liste.forEach((x) => {
      const cell = racine.querySelector(`[data-ta="${x.k}"]`);
      if (!cell) return;
      const t = totalAnnexeLigne(f, x);
      cell.textContent = t ? fmt(t) : "0";
      cell.parentElement.classList.toggle("vide", Math.abs(t) < 0.005);
    }));
    set('[data-k="fact"]', eur(c.fact));
    set('[data-k="dep"]', eur(c.dep)); set('[data-k="dep2"]', eur(c.dep)); set('[data-k="dep3"]', eur(c.dep));
    set('[data-k="fgp"]', eur(c.fg + c.prov));
    set('[data-k="fgps"]', `${fmt(f.fg)} % + provisions ${f.provNA ? "0" : fmt(f.prov)} %`);
    set('[data-k="fgv"]', eur(c.fg)); set('[data-k="provv"]', eur(c.prov));
    set('[data-k="res"]', eur(c.res)); set('[data-k="res2"]', eur(c.res));
    const marge = c.fact ? `${fmt((c.res / c.fact) * 100, 1)} % de la facturation` : "facturation à renseigner";
    set('[data-k="marge"]', marge);
    set('[data-k="resl"]', `Résultat net${c.fact ? " · " + fmt((c.res / c.fact) * 100, 1) + " %" : ""}`);
    const k = racine.querySelector(".rs-kres");
    if (k) k.classList.toggle("neg", c.res < 0);
    const nbp = num(f.prod.nb), j = num(f.prod.jours), lm = num(f.prod.lm);
    set('[data-k="cad"]', j ? `${fmt(nbp / j, 1)} u/j · ${fmt((nbp * lm) / j, 1)} ml/j` : "—");
    const na = racine.querySelector('[data-p="prov"]');
    if (na) na.disabled = !!f.provNA || f.etat === "cloture";
  }

  function saisie(e) {
    if (vue !== "fiche" || !fiche || fiche.etat === "cloture") return;
    const t = e.target;
    if (t.matches("[data-provna]")) { fiche.provNA = t.checked; recalculer(); planifierSauvegarde(); return; }
    const p = t.dataset.p;
    if (!p) return;
    const parts = p.split(".");
    let o = fiche;
    for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
    const dernier = parts[parts.length - 1];
    const brut = t.value.trim();
    o[dernier] = t.classList.contains("rs-txt") || t.classList.contains("rs-lib") ? brut : brut === "" ? "" : num(brut);
    if (dernier === "pu") {
      const k = parts[1];
      const m = racine.querySelector(`[data-mod="${k}"]`);
      if (m) { const ref = tarifs && tarifs.pu ? tarifs.pu[k] : ""; m.textContent = ref !== "" && ref != null && brut !== "" && Math.abs(num(brut) - num(ref)) > 0.0001 ? `modifié · tarif ${fmt(ref)}` : ""; }
      t.toggleAttribute("data-m", !!(m && m.textContent));
    }
    recalculer();
    planifierSauvegarde();
  }

  function planifierSauvegarde(tout_de_suite) {
    clearTimeout(sauveTimer);
    majSave("Modifications non enregistrées…");
    sauveTimer = setTimeout(sauvegarder, tout_de_suite ? 10 : 1500);
  }
  function majSave(t) { statut = t; const s = racine && racine.querySelector("#rsSave"); if (s) s.textContent = t; }
  let sauveEnCours = Promise.resolve();
  function sauvegarder() {
    clearTimeout(sauveTimer);
    const f = fiche;
    sauveEnCours = sauveEnCours.then(async () => {
      try { await ecrireResultat(f); majSave(`✓ Enregistré à ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`); majPastille(); }
      catch (e) { console.error(e); majSave("❌ Non enregistré : " + e.message); }
    });
    return sauveEnCours;
  }

  async function clic(e) {
    const ouvrirL = e.target.closest("[data-ouvrir]");
    if (ouvrirL) { ouvrir(ouvrirL.dataset.ouvrir); return; }
    const an = e.target.closest("[data-annexe]");
    if (an) { const k = an.dataset.annexe; annexesOuvertes.has(k) ? annexesOuvertes.delete(k) : annexesOuvertes.add(k); const y = window.scrollY; rendreFiche(); window.scrollTo(0, y); return; }
    const b = e.target.closest("[data-a]");
    if (!b) return;
    e.preventDefault();
    const a = b.dataset.a;
    if (a === "liste") { if (vue === "fiche") await sauveEnCours; fiche = null; rendreListe(); window.scrollTo(0, 0); return; }
    if (a === "recharger") { charger(true); return; }
    if (a === "tarifs") { editerTarifs(); return; }
    if (a === "creer") {
      b.disabled = true; statut = "Création…"; rendreSansClasseur();
      try { await creerClasseur(); const p = await synchroniserPartages(); statut = p.ok ? `Partagé à ${p.nb} personne(s).` : ""; charger(true); }
      catch (err) { statut = "❌ " + err.message; rendreSansClasseur(); }
      return;
    }
    if (!fiche) return;
    if (a === "pointages") { reprendrePointages().catch((err) => alert(err.message)); return; }
    if (a === "cloturer") {
      if (!confirm("Clôturer ce résultat ?\n\nLa fiche passe dans « Faits » et n'est plus modifiable (tu pourras la rouvrir).")) return;
      fiche.etat = "cloture"; fiche.clotureLe = auj(); fiche.cloturePar = moi();
      await sauvegarder(); rendreFiche(); return;
    }
    if (a === "rouvrir") { if (!confirm("Rouvrir la fiche pour la modifier ?")) return; fiche.etat = "saisie"; delete fiche.clotureLe; await sauvegarder(); rendreFiche(); return; }
    if (a === "apercu" || a === "imprimer" || a === "pdf") {
      b.disabled = true;
      try {
        const blob = await fabriquerPdf(fiche);
        if (a === "apercu") window.open(URL.createObjectURL(blob), "_blank");
        else if (a === "imprimer") imprimer(blob);
        else await enregistrerPdf(blob, fiche);
      } catch (err) { if (!(err && err.name === "AbortError")) { console.error(err); alert("PDF : " + err.message); } }
      b.disabled = false;
    }
  }

  // ─── Éditeur des tarifs ──────────────────────────────────────
  function editerTarifs() {
    const t = tarifs || { pu: {} };
    const pu = { ...t.pu };
    const ov = document.createElement("div");
    ov.className = "rs-ov";
    const groupes = {};
    catalogue().forEach(([k, g, lib, u]) => (groupes[g] = groupes[g] || []).push([k, lib, u]));
    const dessiner = () => {
      ov.innerHTML = `<div class="rs-pop"><div class="rs-pop-h"><h2>Tarifs</h2><span class="s">prix unitaires HT · mis à jour en général une fois par an</span><span class="sv-sp"></span><button type="button" class="sv-btn" data-x>✕</button></div>
        <div class="rs-pop-b">
          <div class="rs-pop-barre"><label>Année des tarifs <input class="rs-annee" value="${esc(t.annee || String(new Date().getFullYear()))}"></label>
            <label class="sv-btn">📄 Importer un fichier CSV<input type="file" accept=".csv,.txt" hidden data-csv></label>
            <span class="rs-src">Les fiches déjà commencées gardent leurs prix ; les nouvelles fiches prennent ces tarifs.</span></div>
          ${Object.entries(groupes).map(([g, ls]) => `<h3>${esc(g)}</h3><table class="sv-tbl rs-tar"><tbody>${ls.map(([k, lib, u]) => `<tr><td>${esc(lib)}</td><td class="rs-u">${esc(u)}</td><td class="r"><input data-tk="${k}" value="${esc(pu[k] === "" || pu[k] == null ? "" : val(pu[k]))}" inputmode="decimal" placeholder="—"></td></tr>`).join("")}</tbody></table>`).join("")}
        </div>
        <div class="rs-pop-f"><span class="rs-pop-msg"></span><span class="sv-sp"></span><button type="button" class="sv-btn" data-x>Annuler</button><button type="button" class="sv-btn pri" data-ok>Enregistrer les tarifs</button></div></div>`;
    };
    dessiner();
    const msg = (m) => { ov.querySelector(".rs-pop-msg").textContent = m; };
    ov.addEventListener("input", (e) => { if (e.target.dataset.tk) pu[e.target.dataset.tk] = e.target.value.trim() === "" ? "" : num(e.target.value); });
    ov.addEventListener("change", (e) => {
      if (!e.target.matches("[data-csv]") || !e.target.files[0]) return;
      const r = new FileReader();
      r.onload = () => {
        let n = 0;
        String(r.result).split(/\r?\n/).forEach((l) => {
          const c = l.split(/[;\t]/).map((x) => x.trim().replace(/^"|"$/g, ""));
          if (c.length >= 2 && catalogue().some((x) => x[0] === c[0]) && c[c.length - 1] !== "") { pu[c[0]] = num(c[c.length - 1]); n++; }
        });
        const an = ov.querySelector(".rs-annee").value;
        dessiner(); ov.querySelector(".rs-annee").value = an;
        msg(n ? `${n} prix importés : vérifie puis enregistre.` : "Aucun prix reconnu dans ce fichier (format attendu : clé;prix).");
      };
      r.readAsText(e.target.files[0], "utf-8");
    });
    ov.addEventListener("click", async (e) => {
      if (e.target === ov || e.target.closest("[data-x]")) { ov.remove(); return; }
      if (!e.target.closest("[data-ok]")) return;
      const btn = e.target.closest("[data-ok]");
      btn.disabled = true; msg("Enregistrement…");
      try { await ecrireTarifs(pu, ov.querySelector(".rs-annee").value.trim()); ov.remove(); if (vue === "liste") rendreListe(); else rendreFiche(); }
      catch (err) { msg("❌ " + err.message); btn.disabled = false; }
    });
    document.body.appendChild(ov);
  }

  // ─── PDF (jsPDF, A4 portrait, plusieurs pages si besoin) ─────
  function chargerScript(src) {
    return new Promise((ok, ko) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => ko(new Error("Outil PDF introuvable : " + src)); document.head.appendChild(s); });
  }
  async function logoDataUrl() {
    try {
      const r = await fetch("../assets/logo-fts.png");
      const b = await r.blob();
      return await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => ok(null); fr.readAsDataURL(b); });
    } catch (e) { return null; }
  }
  /** Lignes imprimées d'un groupe : seulement les lignes renseignées. */
  function lignesPdf(f, g) {
    return g.lignes.filter(([k]) => ligneRemplie(f, g, k)).map(([k, lib, u]) => {
      const x = f.L[k] || {};
      if (g.t === "p") return [lib, `${fmt(num(x.nb) > 1 ? num(x.nb) * num(x.j) : x.j)} j${num(x.gd) ? ` + ${fmt(x.gd)} GD` : ""}${num(x.nb) > 1 ? ` (${fmt(x.nb)} pers.)` : ""}`, fmt(x.pu), fmt(totalLigne(f, g, k))];
      if (g.t === "j") return [lib, `${fmt(num(x.nb) * num(x.j))} j${num(x.nb) > 1 ? ` (${fmt(x.nb)} × ${fmt(x.j)})` : ""}`, fmt(x.pu), fmt(totalLigne(f, g, k))];
      if (u === "a") return [lib, "forfait", "", fmt(totalLigne(f, g, k))];
      return [lib, `${fmt(x.q)} ${u}`, fmt(x.pu), fmt(totalLigne(f, g, k))];
    });
  }
  async function fabriquerPdf(f) {
    if (!window.jspdf) await chargerScript("../lib/jspdf/jspdf.umd.min.js");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    const c = calculer(f);
    const logo = await logoDataUrl();
    const X0 = 15, X1 = 195, W = X1 - X0;
    const COL = [X0 + 2, X1 - 62, X1 - 32, X1 - 2]; // désignation (gauche), qté / P.U. / total (droite)
    let y = 0, page = 1;
    const entete = () => {
      doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(17);
      doc.text("RÉSULTAT CHANTIER MICROPIEUX", X0, 20);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(60);
      doc.text(`${f.code} · ${f.nom}`, X0, 26.5);
      if (logo) { try { doc.addImage(logo, "PNG", X1 - 36, 10, 36, 18.5); } catch (e) {} }
      doc.setDrawColor(253, 202, 1); doc.setLineWidth(1); doc.line(X0, 31, X1, 31);
      y = 37;
    };
    const pied = () => {
      doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(140);
      doc.text(`FTS · document interne, confidentiel · édité le ${auj()}${f.tarifsDu ? ` · tarifs ${f.tarifsDu}` : ""} · seules les lignes renseignées sont imprimées`, X0, 289);
      doc.text(`page ${page}`, X1, 289, { align: "right" });
    };
    const place = (h) => { if (y + h > 280) { pied(); doc.addPage(); page++; entete(); } };
    entete();
    // Bloc d'informations
    const infos = [
      ["Conducteur travaux", f.entete.conducteur || "—"], ["Nombre micropieux", f.prod.nb ? `${fmt(f.prod.nb)} u` : "—"],
      ["Exécution", f.entete.semaines || "—"], ["Longueur moyenne", f.prod.lm ? `${fmt(f.prod.lm)} ml` : "—"],
      ["Montant total marché", eur(c.fact)], ["Cadence moyenne", num(f.prod.jours) ? `${fmt(num(f.prod.nb) / num(f.prod.jours), 1)} u/j · ${fmt((num(f.prod.nb) * num(f.prod.lm)) / num(f.prod.jours), 1)} ml/j` : "—"]];
    doc.setFontSize(9);
    infos.forEach(([l, v], i) => {
      const x = i % 2 ? X0 + W / 2 + 2 : X0, yy = y + Math.floor(i / 2) * 5.2;
      doc.setFont("helvetica", "normal"); doc.setTextColor(90); doc.text(l + " :", x, yy);
      doc.setFont("helvetica", "bold"); doc.setTextColor(17); doc.text(String(v), x + 36, yy);
    });
    y += 18;
    // En-tête du tableau
    const ligneTab = (cells, o = {}) => {
      const h = o.h || 5.6;
      place(h + (o.garde || 0));
      if (o.fond) { doc.setFillColor(...o.fond); doc.rect(X0, y - h + 1.6, W, h, "F"); }
      doc.setFont("helvetica", o.gras ? "bold" : "normal"); doc.setFontSize(o.taille || 8.6); doc.setTextColor(...(o.coul || [17, 17, 17]));
      doc.text(String(cells[0] || ""), COL[0], y);
      [1, 2, 3].forEach((i) => { if (cells[i] !== undefined && cells[i] !== "") doc.text(String(cells[i]), COL[i], y, { align: "right" }); });
      if (o.trait) { doc.setDrawColor(230); doc.setLineWidth(0.2); doc.line(X0, y + 1.6, X1, y + 1.6); }
      y += h;
    };
    ligneTab(["Désignation", "Qté", "P.U.", "Total HT"], { gras: true, taille: 8.4 });
    GROUPES.forEach((g) => {
      const ls = lignesPdf(f, g);
      if (!ls.length) return;
      ligneTab([g.lib.toUpperCase()], { gras: true, taille: 7.6, fond: [34, 34, 34], coul: [253, 202, 1], h: 5.4, garde: 5.6 * Math.min(2, ls.length) });
      ls.forEach((l) => ligneTab(l, { trait: true }));
      ligneTab([`Sous-total ${g.lib.toLowerCase()}`, "", "", eur(c.g[g.id])], { gras: true, fond: [255, 248, 219] });
      y += 1.2;
    });
    y += 1;
    place(5.6 * 6);
    doc.setDrawColor(34); doc.setLineWidth(0.5); doc.line(X0, y - 4, X1, y - 4);
    ligneTab(["Total des dépenses", "", "", eur(c.dep)], { gras: true, trait: true });
    ligneTab([`F.G. assurance ${fmt(f.fg)} %`, "", "", eur(c.fg)], { trait: true });
    ligneTab([`Provisions soutènement ${f.provNA ? "(ne s'applique pas)" : fmt(f.prov) + " %"}`, "", "", eur(c.prov)], { trait: true });
    ligneTab(["Facturation", "", "", eur(c.fact)], { trait: true });
    ligneTab([`Résultat net${c.fact ? " · " + fmt((c.res / c.fact) * 100, 1) + " %" : ""}`, "", "", eur(c.res)], { gras: true, taille: 11, h: 7.5, fond: c.res < 0 ? [253, 236, 234] : [234, 246, 238] });
    pied();
    doc.setProperties({ title: `${f.code} ${f.nom} RESULTAT CHANTIER` });
    return doc.output("blob");
  }
  const nomFichier = (f) => `${f.code} ${f.nom} RESULTAT CHANTIER`.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() + ".pdf";
  function imprimer(blob) {
    const url = URL.createObjectURL(blob);
    const fr = document.createElement("iframe");
    fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    fr.src = url;
    fr.onload = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) { window.open(url, "_blank"); } setTimeout(() => fr.remove(), 60000); };
    document.body.appendChild(fr);
  }
  async function enregistrerPdf(blob, f) {
    const nom = nomFichier(f);
    if (!window.showSaveFilePicker) { // navigateur sans fenêtre « Enregistrer sous » : téléchargement
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nom; a.click(); return;
    }
    let startIn = "documents";
    try {
      if (window.FTSServeur && (await FTSServeur.etat()) === "relie") {
        const d = await FTSServeur.dossierChantier(f.code);
        if (d && d.ok && d.dossier) startIn = d.dossier;
      }
    } catch (e) { /* serveur non joignable : dossier Documents */ }
    let h;
    try { h = await window.showSaveFilePicker({ suggestedName: nom, startIn, types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }] }); }
    catch (e) { if (e && e.name === "AbortError") return; h = await window.showSaveFilePicker({ suggestedName: nom, types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }] }); }
    const w = await h.createWritable();
    await w.write(blob); await w.close();
    majSave(`✓ PDF enregistré : ${h.name}`);
  }

  return { monter, synchroniserPartages, recharger: () => charger(true), _test: { preRemplir, calculer, catalogue, fabriquerPdf, nomFichier, GROUPES, ANNEXES } };
})();
window.FTSResultats = FTSResultats;
