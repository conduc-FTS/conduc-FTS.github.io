/**
 * personnel.js — Base unique du personnel FTS
 *
 * Classeur « Personnel FTS » (onglet Personnel), rangé dans le dossier
 * REFERENTIEL (partagé en LECTURE SEULE avec les chefs) :
 *   Nom · Prénom · Catégorie · Poste habituel · E-mail · Statut
 *
 * - Le rapport journalier y prend les noms proposés et reconnaît le chef
 *   grâce à l'e-mail du compte Google de sa tablette (une tablette = un chef).
 * - Les adresses postales NE SONT PAS ici : elles restent dans le classeur
 *   « Adresses Personnel FTS », réservé à la Supervision (voir sheets.js).
 *
 * Hors ligne ou base pas encore partagée : copie locale, puis liste de
 * départ des chefs. Le rapport n'est jamais bloqué.
 */
const FTSPersonnel = (() => {
  const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DOSSIER = "REFERENTIEL";
  const NOM_CLASSEUR = "Personnel FTS";
  const ONGLET = "Personnel";
  const EN_TETE = ["Nom", "Prénom", "Catégorie", "Poste habituel", "E-mail", "Statut"];
  const CACHE_KEY = "fts_personnel_cache";

  const CATEGORIES = ["MICROPIEUX", "PIEUX", "LES DEUX"];
  const POSTES = ["CHEF DE CHANTIER", "SECOND", "FOREUR", "POMPISTE", "MANŒUVRE"];
  const STATUTS = ["ACTIF", "PARTI"];

  // Liste de départ : les chefs de chantier connus (e-mail à compléter
  // dans la Supervision avec le compte Google de leur tablette)
  const DEFAUT = [
    ["ABBOUCHE", "HAMID"], ["BERGADIEU", "CÉDRIC"], ["BOURBON", "FRÉDÉRIC"], ["CORBELLA", "JEFF"],
    ["DIAS", "DAVID"], ["LABARTHE", "BRUNO"], ["LAJUS", "HUGO"], ["RAIDI", "ROGER"], ["SEREMPIOUQUE", "ROMAIN"],
  ].map(([nom, prenom]) => ({ nom, prenom, categorie: "MICROPIEUX", poste: "CHEF DE CHANTIER", email: "", statut: "ACTIF" }));

  let etat = { personnes: DEFAUT.slice(), source: "defaut", spreadsheetId: null, modifiable: false };

  function majuscules(s) { return String(s == null ? "" : s).trim().replace(/\s+/g, " ").toUpperCase(); }
  function sansAccent(s) { return majuscules(s).normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  // « LAJUS HUGO » = « HUGO LAJUS » = « Hugo Lajus »
  function cle(s) { return sansAccent(s).split(" ").filter(Boolean).sort().join(" "); }
  function nomComplet(p) { return `${p.prenom} ${p.nom}`.trim(); }

  async function fetchAvecRetry(url, options, tentativesMax = 4) {
    let rep;
    for (let essai = 0; essai < tentativesMax; essai++) {
      rep = await fetch(url, options);
      if (rep.status !== 429 || essai === tentativesMax - 1) return rep;
      await new Promise((r) => setTimeout(r, 600 * Math.pow(2, essai) + Math.random() * 300));
    }
    return rep;
  }
  function authHeader() {
    if (!window.FTSAuth || !FTSAuth.isSignedIn()) throw new Error("Non connecté.");
    return { Authorization: "Bearer " + FTSAuth.getToken() };
  }
  function connecte() { return !!(window.FTSAuth && FTSAuth.isSignedIn() && window.FTSDrive); }
  function lireCache() { try { const r = localStorage.getItem(CACHE_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function ecrireCache() { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ personnes: etat.personnes, date: Date.now() })); } catch (e) {} }

  async function trouverClasseur() {
    const q = encodeURIComponent(`name = '${NOM_CLASSEUR}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`);
    const res = await fetchAvecRetry(`${DRIVE_API}/files?q=${q}&fields=files(id,name,capabilities/canEdit)&spaces=drive&includeItemsFromAllDrives=true&supportsAllDrives=true`, { headers: authHeader() });
    if (!res.ok) throw new Error(`Recherche de la base personnel : ${res.status}`);
    const data = await res.json();
    return data.files && data.files.length ? data.files[0] : null;
  }

  function depuisCache(existe) {
    const c = lireCache();
    if (c && c.personnes && c.personnes.length) {
      etat = { personnes: c.personnes, source: "cache", spreadsheetId: null, modifiable: false };
      return { source: "cache", existe, modifiable: false };
    }
    etat = { personnes: DEFAUT.slice(), source: "defaut", spreadsheetId: null, modifiable: false };
    return { source: "defaut", existe, modifiable: false };
  }

  /** Charge la base : classeur Google → copie locale → liste de départ. */
  async function charger() {
    if (!connecte()) return depuisCache(null);
    try {
      const f = await trouverClasseur();
      if (!f) return depuisCache(false);
      const res = await fetchAvecRetry(`${SHEETS_API}/${f.id}/values/${encodeURIComponent(ONGLET + "!A2:F")}`, { headers: authHeader() });
      if (!res.ok) throw new Error(`Lecture de la base personnel : ${res.status}`);
      const lignes = (await res.json()).values || [];
      etat = {
        personnes: lignes.filter((r) => r[0] || r[1]).map((r) => ({
          nom: majuscules(r[0]), prenom: majuscules(r[1]), categorie: majuscules(r[2]) || "MICROPIEUX",
          poste: majuscules(r[3]), email: String(r[4] || "").trim().toLowerCase(), statut: majuscules(r[5]) || "ACTIF",
        })),
        source: "sheet", spreadsheetId: f.id,
        modifiable: !(f.capabilities && f.capabilities.canEdit === false),
      };
      ecrireCache();
      return { source: "sheet", existe: true, modifiable: etat.modifiable };
    } catch (e) {
      console.warn("Base personnel : lecture Google impossible, copie locale utilisée.", e);
      return depuisCache(null);
    }
  }

  function verifier(personnes) {
    const erreurs = [];
    const vus = new Map(), mails = new Map();
    personnes.forEach((p) => {
      if (!p.nom || !p.prenom) erreurs.push("Nom et prénom sont obligatoires.");
      const k = cle(nomComplet(p));
      if (vus.has(k)) erreurs.push(`${nomComplet(p)} est présent deux fois.`);
      vus.set(k, true);
      if (p.email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) erreurs.push(`E-mail invalide pour ${nomComplet(p)}.`);
        if (mails.has(p.email)) erreurs.push(`L'e-mail ${p.email} est utilisé par ${mails.get(p.email)} et ${nomComplet(p)}.`);
        mails.set(p.email, nomComplet(p));
      }
      if (!CATEGORIES.includes(p.categorie)) erreurs.push(`${nomComplet(p)} : catégorie inconnue.`);
      if (p.poste && !POSTES.includes(p.poste)) erreurs.push(`${nomComplet(p)} : poste inconnu.`);
      if (!STATUTS.includes(p.statut)) erreurs.push(`${nomComplet(p)} : statut inconnu.`);
    });
    return [...new Set(erreurs)];
  }

  function nettoyer(p) {
    return {
      nom: majuscules(p.nom), prenom: majuscules(p.prenom), categorie: majuscules(p.categorie) || "MICROPIEUX",
      poste: majuscules(p.poste), email: String(p.email || "").trim().toLowerCase(), statut: majuscules(p.statut) || "ACTIF",
    };
  }

  async function ecrireTout(spreadsheetId, personnes) {
    let res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(ONGLET + "!A:Z")}:clear`, { method: "POST", headers: authHeader() });
    if (!res.ok) throw new Error(`Écriture de la base personnel : ${res.status}`);
    res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(ONGLET + "!A1")}?valueInputOption=RAW`, {
      method: "PUT", headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ values: [EN_TETE, ...personnes.map((p) => [p.nom, p.prenom, p.categorie, p.poste, p.email, p.statut])] }),
    });
    if (!res.ok) throw new Error(`Écriture de la base personnel : ${res.status}`);
  }

  async function enregistrer(personnes) {
    const propres = personnes.map(nettoyer).sort((a, b) => (a.nom + " " + a.prenom).localeCompare(b.nom + " " + b.prenom, "fr"));
    const erreurs = verifier(propres);
    if (erreurs.length) throw new Error(erreurs.join(" "));
    if (!etat.spreadsheetId) throw new Error("Base personnel non créée.");
    await ecrireTout(etat.spreadsheetId, propres);
    etat.personnes = propres;
    ecrireCache();
  }

  /**
   * Crée la base dans REFERENTIEL (Supervision). Reprend les chefs connus
   * et les personnes déjà saisies dans Adresses Personnel (nom + prénom).
   */
  async function creer(depuisAdresses) {
    const dossierId = await FTSDrive.findOrCreateFolder(DOSSIER, null);
    const res = await fetchAvecRetry(SHEETS_API, {
      method: "POST", headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { title: NOM_CLASSEUR }, sheets: [{ properties: { title: ONGLET } }] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Création de la base personnel : ${err.error?.message || res.status}`);
    }
    const { spreadsheetId } = await res.json();
    await fetchAvecRetry(`${DRIVE_API}/files/${spreadsheetId}?addParents=${dossierId}&removeParents=root&fields=id`, { method: "PATCH", headers: authHeader() });
    const liste = DEFAUT.slice();
    (depuisAdresses || []).forEach((a) => {
      const p = nettoyer({ nom: a.nom, prenom: a.prenom, categorie: "MICROPIEUX", poste: "", statut: "ACTIF" });
      if (p.nom && p.prenom && !liste.some((x) => cle(nomComplet(x)) === cle(nomComplet(p)))) liste.push(p);
    });
    etat = { personnes: [], source: "sheet", spreadsheetId, modifiable: true };
    await enregistrer(liste);
    return spreadsheetId;
  }

  // ── Lecture pour les modules ────────────────────────────────────
  function toutes() { return etat.personnes.slice(); }
  function actifs() { return etat.personnes.filter((p) => p.statut === "ACTIF"); }
  function chefs() { return actifs().filter((p) => p.poste === "CHEF DE CHANTIER"); }
  function parEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    return e ? etat.personnes.find((p) => p.email === e && p.statut === "ACTIF") || null : null;
  }
  function parNom(nomSaisi) {
    const k = cle(nomSaisi);
    return k ? etat.personnes.find((p) => cle(nomComplet(p)) === k) || null : null;
  }

  return {
    CATEGORIES, POSTES, STATUTS, DEFAUT, NOM_CLASSEUR,
    charger, creer, enregistrer, verifier, toutes, actifs, chefs, parEmail, parNom, nomComplet, cle, majuscules,
    source: () => etat.source,
  };
})();
