/**
 * personnel.js — Base unique du personnel FTS
 *
 * Classeur « Personnel FTS » (onglet Personnel), rangé dans le dossier
 * REFERENTIEL (partagé en LECTURE SEULE avec les chefs) :
 *   Nom · Prénom · Catégorie · Poste habituel · E-mail · Statut · Accès Drive · Téléphone · Fonction encadrement
 *   (Fonction encadrement : pour une personne de chantier qui fait AUSSI partie de
 *   l'encadrement, ex. soudeur + responsable d'atelier : elle reste sur la tablette)
 *   (le téléphone n'est pas copié sur les tablettes)
 *
 * Catégorie ENCADREMENT (conducteurs, direction, bureau) : jamais proposée
 * sur la tablette, au pointage ni au stock ; la colonne « Accès Drive »
 * (Lecture + modification / Lecture seule / Aucun) donne leur accès au
 * Drive FTS (voir js/acces-drive.js).
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
  const EN_TETE = ["Nom", "Prénom", "Catégorie", "Poste habituel", "E-mail", "Statut", "Accès Drive", "Téléphone", "Fonction encadrement"];
  const EN_TETE_TABLETTE = EN_TETE.slice(0, 6);
  const CACHE_KEY = "fts_personnel_cache";

  const CATEGORIES = ["MICROPIEUX", "PIEUX", "LES DEUX", "ENCADREMENT"];
  const POSTES_CHANTIER = ["CHEF DE CHANTIER", "SECOND", "FOREUR", "POMPISTE", "MANŒUVRE", "SOUDEUR", "RECÉPEUR", "POLYVALENT"];
  const POSTES_ENCADREMENT = ["CONDUCTEUR DE TRAVAUX PRINCIPAL", "CONDUCTEUR DE TRAVAUX", "DIRECTRICE TRAVAUX", "PRÉSIDENT", "PRÉSIDENT DIRECTEUR GÉNÉRAL", "RESPONSABLE MATÉRIEL", "RESPONSABLE D'ATELIER", "ASSISTANTE D'EXPLOITATION"];
  const POSTES = POSTES_CHANTIER.concat(POSTES_ENCADREMENT);
  // Accès Drive (encadrement) : valeur interne ↔ libellé du classeur
  const ACCES = ["MODIFICATION", "LECTURE", "AUCUN"];
  const ACCES_LIB = { MODIFICATION: "Lecture + modification", LECTURE: "Lecture seule", AUCUN: "Aucun" };
  function lireAcces(v, categorie, fonction) {
    if (categorie !== "ENCADREMENT" && !fonction) return "";
    const t = String(v || "").trim();
    if (/^aucun/i.test(t)) return "AUCUN";
    if (/seule|^lecture$/i.test(t)) return "LECTURE";
    return "MODIFICATION"; // vide = lecture + modification (valeur par défaut de l'encadrement)
  }
  // estEncadrement : encadrement SEUL (jamais sur la tablette) ; aEncadrement : encadrement seul OU personne de chantier avec une fonction d'encadrement
  const estEncadrement = (p) => p.categorie === "ENCADREMENT";
  const aEncadrement = (p) => p.categorie === "ENCADREMENT" || !!p.fonctionEnc;
  // Téléphone : « 06 12 34 56 78 » (ou +33 6 12 34 56 78 → 06 12 34 56 78) ; autre format gardé tel quel
  function formatTel(v) {
    let t = String(v == null ? "" : v).trim();
    if (!t) return "";
    let c = t.replace(/[\s.\-()\/]/g, "");
    if (/^(\+33|0033)\d{9}$/.test(c)) c = "0" + c.slice(-9);
    if (/^\d{9}$/.test(c) && /^[1-9]/.test(c)) c = "0" + c; // zéro perdu par le tableur
    return /^0\d{9}$/.test(c) ? c.replace(/(\d{2})(?=\d)/g, "$1 ") : t;
  }
  const telValide = (t) => !t || /^0\d( \d{2}){4}$/.test(t) || /^\+\d[\d ]{6,}$/.test(t);
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
  function ecrireCache() { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ personnes: etat.personnes, date: Date.now(), spreadsheetId: etat.spreadsheetId || null, modifiable: !!etat.modifiable })); } catch (e) {} }

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
  async function charger(options = {}) {
    // options.rapide : copie locale du classeur si elle a moins d'une heure
    if (options.rapide) {
      const c = lireCache();
      if (c && c.spreadsheetId && c.personnes && c.personnes.length && Date.now() - (c.date || 0) < 3600 * 1000) {
        etat = { personnes: c.personnes, source: "sheet", spreadsheetId: c.spreadsheetId, modifiable: !!c.modifiable };
        return { source: "sheet", existe: true, modifiable: etat.modifiable };
      }
    }
    if (!connecte()) return depuisCache(null);
    try {
      const f = await trouverClasseur();
      if (!f) {
        // Pas d'accès au référentiel (tablette) → copie allégée publiée par la Supervision
        const lp = FTSDrive.lireListeTablette ? await FTSDrive.lireListeTablette("Personnes").catch(() => null) : null;
        if (lp && lp.length) {
          etat = {
            personnes: lp.filter((r) => r[0] || r[1]).map((r) => ({
              nom: majuscules(r[0]), prenom: majuscules(r[1]), categorie: majuscules(r[2]),
              poste: majuscules(r[3]), email: String(r[4] || "").trim().toLowerCase(), statut: majuscules(r[5]) || "ACTIF",
            })),
            source: "liste", spreadsheetId: null, modifiable: false,
          };
          ecrireCache();
          return { source: "liste", existe: true, modifiable: false };
        }
        return depuisCache(false);
      }
      const res = await fetchAvecRetry(`${SHEETS_API}/${f.id}/values/${encodeURIComponent(ONGLET + "!A2:I")}`, { headers: authHeader() });
      if (!res.ok) throw new Error(`Lecture de la base personnel : ${res.status}`);
      const lignes = (await res.json()).values || [];
      etat = {
        personnes: lignes.filter((r) => r[0] || r[1]).map((r) => ({
          nom: majuscules(r[0]), prenom: majuscules(r[1]), categorie: majuscules(r[2]),
          poste: majuscules(r[3]), email: String(r[4] || "").trim().toLowerCase(), statut: majuscules(r[5]) || "ACTIF",
          fonctionEnc: majuscules(r[2]) === "ENCADREMENT" ? "" : majuscules(r[8]),
          acces: lireAcces(r[6], majuscules(r[2]), majuscules(r[2]) === "ENCADREMENT" ? "" : majuscules(r[8])),
          telephone: formatTel(r[7]),
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
      if (p.categorie && !CATEGORIES.includes(p.categorie)) erreurs.push(`${nomComplet(p)} : catégorie inconnue.`);
      if (p.poste && !POSTES.includes(p.poste)) erreurs.push(`${nomComplet(p)} : poste inconnu.`);
      if (p.fonctionEnc && !POSTES_ENCADREMENT.includes(p.fonctionEnc)) erreurs.push(`${nomComplet(p)} : fonction d'encadrement inconnue.`);
      if (!telValide(p.telephone)) erreurs.push(`Téléphone invalide pour ${nomComplet(p)} (ex : 06 12 34 56 78).`);
      if (!STATUTS.includes(p.statut)) erreurs.push(`${nomComplet(p)} : statut inconnu.`);
      if (p.categorie === "ENCADREMENT" && p.poste && !POSTES_ENCADREMENT.includes(p.poste)) erreurs.push(`${nomComplet(p)} : « ${p.poste} » n'est pas un poste d'encadrement.`);
      if (p.categorie !== "ENCADREMENT" && POSTES_ENCADREMENT.includes(p.poste)) erreurs.push(`${nomComplet(p)} : le poste « ${p.poste} » demande la catégorie ENCADREMENT.`);
    });
    return [...new Set(erreurs)];
  }

  function nettoyer(p) {
    return {
      nom: majuscules(p.nom), prenom: majuscules(p.prenom), categorie: majuscules(p.categorie),
      poste: majuscules(p.poste), email: String(p.email || "").trim().toLowerCase(), statut: majuscules(p.statut) || "ACTIF",
      telephone: formatTel(p.telephone),
      fonctionEnc: majuscules(p.categorie) === "ENCADREMENT" ? "" : majuscules(p.fonctionEnc),
      acces: majuscules(p.categorie) === "ENCADREMENT" || p.fonctionEnc ? (ACCES.includes(p.acces) ? p.acces : "MODIFICATION") : "",
    };
  }

  async function ecrireTout(spreadsheetId, personnes) {
    let res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(ONGLET + "!A:Z")}:clear`, { method: "POST", headers: authHeader() });
    if (!res.ok) throw new Error(`Écriture de la base personnel : ${res.status}`);
    res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(ONGLET + "!A1")}?valueInputOption=RAW`, {
      method: "PUT", headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ values: [EN_TETE, ...personnes.map((p) => [p.nom, p.prenom, p.categorie, p.poste, p.email, p.statut, aEncadrement(p) ? ACCES_LIB[p.acces || "MODIFICATION"] : "", p.telephone || "", p.fonctionEnc || ""])] }),
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
    await publierListeTablette(true).catch((e) => console.warn("Listes tablette (personnes) non mises à jour :", e));
  }

  /** Copie allégée pour les tablettes : personnes ACTIVES hors encadrement (nom, prénom, catégorie, poste, e-mail). */
  async function publierListeTablette(forcer = false) {
    if (etat.source !== "sheet" || !window.FTSDrive || !FTSDrive.ecrireListeTablette) return false;
    const cle = "fts_listes_pub_perso";
    try { if (!forcer && Date.now() - Number(localStorage.getItem(cle) || 0) < 24 * 3600 * 1000) return false; } catch (e) {}
    await FTSDrive.ecrireListeTablette("Personnes", [EN_TETE_TABLETTE, ...etat.personnes.filter((p) => p.statut === "ACTIF" && !estEncadrement(p)).map((p) => [p.nom, p.prenom, p.categorie, p.poste, p.email, p.statut])]);
    try { localStorage.setItem(cle, String(Date.now())); } catch (e) {}
    return true;
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
      const p = nettoyer({ nom: a.nom, prenom: a.prenom, categorie: "", poste: "", statut: "ACTIF" });
      if (p.nom && p.prenom && !liste.some((x) => cle(nomComplet(x)) === cle(nomComplet(p)))) liste.push(p);
    });
    etat = { personnes: [], source: "sheet", spreadsheetId, modifiable: true };
    await enregistrer(liste);
    return spreadsheetId;
  }

  /**
   * Personnes de la liste d'adresses absentes de la base (comparaison
   * sans accents et sans tenir compte de l'ordre nom/prénom).
   */
  function manquantesDepuisAdresses(adresses) {
    const presents = new Set(etat.personnes.map((p) => cle(nomComplet(p))));
    const vus = new Set();
    return (adresses || []).map((a) => nettoyer({ nom: a.nom, prenom: a.prenom, categorie: "", poste: "", statut: "ACTIF" }))
      .filter((p) => {
        const k = cle(nomComplet(p));
        if (!p.nom || !p.prenom || presents.has(k) || vus.has(k)) return false;
        vus.add(k);
        return true;
      });
  }

  /**
   * Accès Drive calculés à partir de la base (Supervision) :
   *  - REFERENTIEL (et ses fichiers) : ENCADREMENT UNIQUEMENT. Toute personne
   *    de la base qui y a un accès en lecture/commentaire le perd (les
   *    tablettes lisent la copie « _LISTES TABLETTE » de DOSSIER CHANTIER).
   *  - DOSSIER CHANTIER : chaque CHEF DE CHANTIER ACTIF avec un e-mail reçoit
   *    l'accès en modification (sans e-mail de notification) ; une personne
   *    PARTIE perd son accès.
   * Les accès propriétaire et ceux des personnes absentes de la base
   * (encadrement) ne sont jamais touchés.
   * @returns {Promise<{ajoutes:string[], retires:string[], erreurs:string[], total:number}>}
   */
  async function lirePermissions(fileId) {
    const res = await fetchAvecRetry(`${DRIVE_API}/files/${fileId}/permissions?fields=permissions(id,emailAddress,role,type)&supportsAllDrives=true`, { headers: authHeader() });
    if (!res.ok) throw new Error(`Lecture des partages : ${res.status}`);
    return new Map(((await res.json()).permissions || []).filter((p) => p.type === "user" && p.emailAddress).map((p) => [p.emailAddress.toLowerCase(), p]));
  }
  async function retirerPermission(fileId, permId) {
    const r = await fetchAvecRetry(`${DRIVE_API}/files/${fileId}/permissions/${permId}?supportsAllDrives=true`, { method: "DELETE", headers: authHeader() });
    return r.ok;
  }
  async function synchroniserPartages() {
    const bilan = { ajoutes: [], retires: [], erreurs: [], total: 0 };
    const avecMail = etat.personnes.filter((p) => p.email);

    // 1. REFERENTIEL : on retire les personnes de la base (lecteur / commentateur)
    const refId = await FTSDrive.findOrCreateFolder(DOSSIER, null);
    const cibles = [refId];
    try {
      const q = encodeURIComponent(`'${refId}' in parents and trashed = false`);
      const rf = await fetchAvecRetry(`${DRIVE_API}/files?q=${q}&fields=files(id)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: authHeader() });
      if (rf.ok) ((await rf.json()).files || []).forEach((f) => cibles.push(f.id));
    } catch (e) { /* le dossier suffit */ }
    for (const id of cibles) {
      const perms = await lirePermissions(id).catch(() => new Map());
      for (const p of avecMail) {
        const deja = perms.get(p.email);
        if (deja && (deja.role === "reader" || deja.role === "commenter")) {
          if (await retirerPermission(id, deja.id)) { if (!bilan.retires.includes(p.email + " (REFERENTIEL)")) bilan.retires.push(p.email + " (REFERENTIEL)"); }
          else bilan.erreurs.push(`${p.email} (REFERENTIEL)`);
        }
      }
    }

    // 2. DOSSIER CHANTIER : chefs actifs en modification, partis retirés
    const chantierId = await FTSDrive.getRootFolder("DOSSIER CHANTIER");
    const perms = await lirePermissions(chantierId);
    for (const p of avecMail) {
      const deja = perms.get(p.email);
      const chefActif = p.statut === "ACTIF" && p.poste === "CHEF DE CHANTIER";
      if (chefActif) {
        bilan.total++;
        if (deja && (deja.role === "writer" || deja.role === "owner" || deja.role === "organizer" || deja.role === "fileOrganizer")) continue;
        const r = deja
          ? await fetchAvecRetry(`${DRIVE_API}/files/${chantierId}/permissions/${deja.id}?supportsAllDrives=true`, { method: "PATCH", headers: { ...authHeader(), "Content-Type": "application/json" }, body: JSON.stringify({ role: "writer" }) })
          : await fetchAvecRetry(`${DRIVE_API}/files/${chantierId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
              method: "POST", headers: { ...authHeader(), "Content-Type": "application/json" },
              body: JSON.stringify({ role: "writer", type: "user", emailAddress: p.email }),
            });
        if (r.ok) bilan.ajoutes.push(p.email); else bilan.erreurs.push(`${p.email} (${r.status})`);
      } else if (p.statut !== "ACTIF" && deja && deja.role !== "owner") {
        if (await retirerPermission(chantierId, deja.id)) bilan.retires.push(p.email + " (DOSSIER CHANTIER)");
        else bilan.erreurs.push(`${p.email} (DOSSIER CHANTIER)`);
      }
    }
    return bilan;
  }

  // ── Lecture pour les modules ────────────────────────────────────
  function toutes() { return etat.personnes.slice(); }
  // actifs() = personnel de chantier (tablette, pointage, rapport) : l'encadrement n'y est jamais
  function actifs() { return etat.personnes.filter((p) => p.statut === "ACTIF" && !estEncadrement(p)); }
  function encadrement() { return etat.personnes.filter((p) => aEncadrement(p)); }
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
    formatTel, CATEGORIES, POSTES, POSTES_CHANTIER, POSTES_ENCADREMENT, ACCES, ACCES_LIB, STATUTS, DEFAUT, NOM_CLASSEUR,
    encadrement, estEncadrement, aEncadrement,
    charger, creer, enregistrer, verifier, publierListeTablette, manquantesDepuisAdresses, synchroniserPartages, toutes, actifs, chefs, parEmail, parNom, nomComplet, cle, majuscules,
    source: () => etat.source,
  };
})();

window.FTSPersonnel = FTSPersonnel;
