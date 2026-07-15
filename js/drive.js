/**
 * drive.js — Logique Drive alignée sur l'architecture réelle FTS
 *
 * Architecture du Drive (existante, PAS créée par ce module) :
 *
 *   Google Drive/
 *     ├── ACCUEIL INTERIMAIRE/
 *     │     ├── 2026/
 *     │     ├── 2027/
 *     │     └── ...                        <- classé par ANNÉE, pas par chantier
 *     ├── DOSSIER CHANTIER/
 *     │     └── {CODE CHANTIER} {NOM}/      <- ex : "25FTS001 BORDEAUX HOPITAL"
 *     │           ├── PLAN/
 *     │           ├── NDC/
 *     │           ├── SECURITE/
 *     │           │     └── ACCUEIL SECURITE/
 *     │           ├── RAPPORT JOURNALIER/
 *     │           ├── DICT/
 *     │           └── SONDAGE/
 *     ├── ADMINISTRATIF/
 *     │     ├── CHEF n°1/
 *     │     ├── CHEF n°2/
 *     │     └── ...
 *     └── FICHE MATERIEL/
 *           ├── FUTURO N°1/                 <- classé par MACHINE, pas par chantier ni par année
 *           ├── MIXO N°1/
 *           ├── GROUPE 60KVA/
 *           └── ...
 *
 * Ce module :
 *  - NE CRÉE PAS les 4 dossiers racine (ACCUEIL INTERIMAIRE, DOSSIER CHANTIER,
 *    ADMINISTRATIF, FICHE MATERIEL) : ils doivent déjà exister. S'ils sont
 *    introuvables, on lève une erreur claire plutôt que d'en créer un doublon
 *    mal placé.
 *  - "Ouverture de chantier" crée UNIQUEMENT le dossier du chantier sous
 *    DOSSIER CHANTIER, avec ses 6 sous-dossiers (dont ACCUEIL SECURITE imbriqué
 *    dans SECURITE).
 *  - Fiche Matériel est envoyée par mail ET archivée sous FICHE MATERIEL,
 *    dans un sous-dossier nommé d'après la machine concernée (créé au
 *    premier envoi pour cette machine, réutilisé ensuite).
 *  - Expose une fonction de recherche tolérante aux espaces pour retrouver
 *    le dossier d'un chantier à partir de son code (ex: "25FTS001" doit
 *    retrouver "25FTS001 BORDEAUX HOPITAL" ou "25 FTS 001 - ..."), utile
 *    pour les futurs modules (Rapport Journalier, Accueil Sécurité) qui
 *    devront y déposer leurs PDF.
 */

const FTSDrive = (() => {
  const API_BASE = "https://www.googleapis.com/drive/v3";

  const ROOT_DOSSIER_CHANTIER = "DOSSIER CHANTIER";
  const ROOT_ACCUEIL_INTERIMAIRE = "ACCUEIL INTERIMAIRE";
  const ROOT_ADMINISTRATIF = "ADMINISTRATIF";
  const ROOT_FICHE_MATERIEL = "FICHE MATERIEL";

  // Sous-dossiers créés à l'ouverture d'un chantier
  const CHANTIER_SUBFOLDERS = ["PLAN", "NDC", "SECURITE", "RAPPORT JOURNALIER", "DICT", "SONDAGE"];
  const SECURITE_SUBFOLDER = "ACCUEIL SECURITE"; // imbriqué dans SECURITE

  function authHeader() {
    if (!window.FTSAuth || !FTSAuth.isSignedIn()) {
      throw new Error("Non connecté : impossible d'accéder à Drive.");
    }
    return { Authorization: "Bearer " + FTSAuth.getToken() };
  }

  function escapeForQuery(str) {
    return str.replace(/'/g, "\\'");
  }

  /**
   * Normalise un code chantier pour comparaison tolérante :
   * supprime tous les espaces et met en majuscules.
   * "25 FTS 001" et "25FTS001" deviennent tous deux "25FTS001".
   */
  function normalizeCode(str) {
    return (str || "").replace(/\s+/g, "").toUpperCase();
  }

  /**
   * Cherche un dossier par nom EXACT sous un parent (ou à la racine
   * "root" si parentId est null/undefined).
   */
  async function findFolderExact(name, parentId) {
    const parentClause = parentId ? `'${parentId}' in parents` : `'root' in parents`;
    const q = encodeURIComponent(
      `name = '${escapeForQuery(name)}' and mimeType = 'application/vnd.google-apps.folder' and ${parentClause} and trashed = false`
    );
    const res = await fetch(`${API_BASE}/files?q=${q}&fields=files(id,name)&spaces=drive`, {
      headers: authHeader(),
    });
    if (!res.ok) {
      throw new Error(`Erreur recherche dossier "${name}" : ${res.status}`);
    }
    const data = await res.json();
    return data.files && data.files.length > 0 ? data.files[0].id : null;
  }

  /**
   * Liste tous les sous-dossiers directs d'un parent.
   */
  async function listSubfolders(parentId) {
    const q = encodeURIComponent(
      `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    );
    const res = await fetch(`${API_BASE}/files?q=${q}&fields=files(id,name)&spaces=drive&pageSize=1000`, {
      headers: authHeader(),
    });
    if (!res.ok) {
      throw new Error(`Erreur listage des sous-dossiers : ${res.status}`);
    }
    const data = await res.json();
    return data.files || [];
  }

  async function createFolder(name, parentId) {
    const metadata = { name, mimeType: "application/vnd.google-apps.folder" };
    if (parentId) metadata.parents = [parentId];

    const res = await fetch(`${API_BASE}/files?fields=id,name`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Erreur création dossier "${name}" : ${err.error?.message || res.status}`);
    }
    const data = await res.json();
    return data.id;
  }

  async function findOrCreateFolder(name, parentId) {
    const existingId = await findFolderExact(name, parentId);
    if (existingId) return existingId;
    return createFolder(name, parentId);
  }

  /**
   * Trouve un des 3 dossiers racine FTS (DOSSIER CHANTIER, ACCUEIL
   * INTERIMAIRE, ADMINISTRATIF). Ils doivent déjà exister dans le Drive
   * connecté — on ne les crée jamais automatiquement pour éviter un
   * doublon mal placé si le nom réel diffère légèrement (accent, casse...).
   */
  async function getRootFolder(name) {
    const id = await findFolderExact(name, null);
    if (!id) {
      throw new Error(
        `Dossier racine "${name}" introuvable à la racine du Drive connecté. ` +
        `Vérifie que tu es connecté avec le bon compte et que ce dossier existe bien.`
      );
    }
    return id;
  }

  /**
   * Recherche le dossier d'un chantier sous DOSSIER CHANTIER, à partir
   * de son code, en tolérant les variations d'espaces
   * (ex: "25FTS001" retrouve "25FTS001 BORDEAUX HOPITAL").
   * Retourne {id, name} ou null si aucun ne correspond.
   */
  async function findChantierFolder(codeChantier) {
    const dossierChantierRootId = await getRootFolder(ROOT_DOSSIER_CHANTIER);
    const candidats = await listSubfolders(dossierChantierRootId);
    const codeNorm = normalizeCode(codeChantier);

    const match = candidats.find((f) => normalizeCode(f.name).startsWith(codeNorm));
    return match ? { id: match.id, name: match.name } : null;
  }

  /**
   * Crée l'arborescence complète d'un nouveau chantier sous DOSSIER CHANTIER :
   *   {CODE} {NOM}/
   *     PLAN, NDC, SECURITE (+ ACCUEIL SECURITE dedans), RAPPORT JOURNALIER, DICT, SONDAGE
   *
   * Si un dossier correspondant au code existe déjà (recherche tolérante
   * aux espaces), on le réutilise plutôt que d'en créer un second —
   * évite les doublons si le conducteur clique deux fois ou rouvre le
   * formulaire plus tard.
   *
   * @param {Object} chantier
   * @param {string} chantier.numAffaire   ex: "25 FTS 001"
   * @param {string} chantier.nom          ex: "BORDEAUX HOPITAL"
   */
  async function creerArborescenceChantier(chantier) {
    if (!chantier.numAffaire || !chantier.nom) {
      throw new Error("N° affaire et nom du chantier requis.");
    }

    const dossierChantierRootId = await getRootFolder(ROOT_DOSSIER_CHANTIER);

    // Réutiliser le dossier existant si un chantier avec ce code existe déjà
    const existant = await findChantierFolder(chantier.numAffaire);
    let chantierId, chantierName;

    if (existant) {
      chantierId = existant.id;
      chantierName = existant.name;
    } else {
      chantierName = `${chantier.numAffaire} ${chantier.nom}`.trim();
      chantierId = await createFolder(chantierName, dossierChantierRootId);
    }

    // Sous-dossiers standards
    const subfolders = {};
    for (const sub of CHANTIER_SUBFOLDERS) {
      subfolders[sub] = await findOrCreateFolder(sub, chantierId);
    }

    // ACCUEIL SECURITE imbriqué dans SECURITE
    subfolders["SECURITE/" + SECURITE_SUBFOLDER] = await findOrCreateFolder(
      SECURITE_SUBFOLDER,
      subfolders["SECURITE"]
    );

    return {
      chantierId,
      chantierName,
      reused: !!existant,
      subfolders,
    };
  }

  /**
   * Trouve (ou crée) le dossier de l'année en cours sous ACCUEIL INTERIMAIRE.
   * À utiliser par le futur module Accueil Intérimaire pour déposer ses PDF —
   * ce classement est par année, pas par chantier.
   */
  async function getDossierAnneeAccueilInterimaire(annee) {
    const rootId = await getRootFolder(ROOT_ACCUEIL_INTERIMAIRE);
    const year = String(annee || new Date().getFullYear());
    return findOrCreateFolder(year, rootId);
  }

  /**
   * Retrouve le sous-dossier de destination pour un module donné, à
   * l'intérieur du dossier d'un chantier existant. Pratique pour les
   * futurs modules Rapport Journalier et Accueil Sécurité.
   *
   * @param {string} codeChantier  ex: "25FTS001" ou "25 FTS 001"
   * @param {"RAPPORT JOURNALIER"|"SECURITE"|"ACCUEIL SECURITE"|"PLAN"|"NDC"|"DICT"|"SONDAGE"} module
   */
  async function getDossierModuleChantier(codeChantier, module) {
    const chantier = await findChantierFolder(codeChantier);
    if (!chantier) {
      throw new Error(`Aucun dossier chantier trouvé pour le code "${codeChantier}".`);
    }

    if (module === "ACCUEIL SECURITE") {
      const securiteId = await findFolderExact("SECURITE", chantier.id);
      if (!securiteId) throw new Error(`Sous-dossier SECURITE introuvable dans "${chantier.name}".`);
      const id = await findFolderExact(SECURITE_SUBFOLDER, securiteId);
      if (!id) throw new Error(`Sous-dossier ACCUEIL SECURITE introuvable dans "${chantier.name}/SECURITE".`);
      return { id, chantierName: chantier.name };
    }

    const id = await findFolderExact(module, chantier.id);
    if (!id) throw new Error(`Sous-dossier "${module}" introuvable dans "${chantier.name}".`);
    return { id, chantierName: chantier.name };
  }

  /**
   * Trouve (ou crée) le dossier d'une machine sous FICHE MATERIEL.
   * Classement par machine (pas par année ni par chantier), donc le nom
   * de la machine doit être cohérent d'un envoi à l'autre (ex: toujours
   * "FUTURO N°1" et pas tantôt "Futuro 1" tantôt "FUTURO N°1") pour éviter
   * de créer des dossiers différents pour la même machine.
   *
   * @param {string} nomMachine  ex: "FUTURO N°1"
   */
  async function getDossierMachineFicheMateriel(nomMachine) {
    if (!nomMachine || !nomMachine.trim()) {
      throw new Error("Nom de machine requis pour archiver la fiche matériel.");
    }
    const rootId = await getRootFolder(ROOT_FICHE_MATERIEL);
    return findOrCreateFolder(nomMachine.trim().toUpperCase(), rootId);
  }

  /**
   * Liste tous les chantiers existants sous DOSSIER CHANTIER, triés par
   * nom. Utilisé pour peupler le sélecteur "chantier actif" côté chef,
   * qui n'a pas à créer de chantier — seulement à choisir celui sur
   * lequel il travaille aujourd'hui.
   *
   * @returns {Promise<Array<{id:string, name:string}>>}
   */
  async function listChantiers() {
    const rootId = await getRootFolder(ROOT_DOSSIER_CHANTIER);
    const folders = await listSubfolders(rootId);
    return folders.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Envoie un fichier (Blob) dans un dossier Drive donné.
   * Utilisée par tous les modules (rapport, accueils, fiche matériel)
   * pour déposer leur PDF au bon endroit.
   *
   * @param {Blob} blob
   * @param {string} fileName
   * @param {string} mimeType  ex: "application/pdf"
   * @param {string} folderId
   */
  async function uploadFile(blob, fileName, mimeType, folderId) {
    const metadata = { name: fileName, parents: [folderId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", blob);

    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
      method: "POST",
      headers: authHeader(), // ne pas fixer Content-Type : le navigateur gère le multipart/form-data
      body: form,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Erreur envoi fichier "${fileName}" : ${err.error?.message || res.status}`);
    }
    return res.json();
  }

  /**
   * Retrouve la date de création d'un dossier (utilisé pour calculer
   * "chantier actif depuis X jours").
   */
  async function getFolderCreatedTime(folderId) {
    const res = await fetch(`${API_BASE}/files/${folderId}?fields=createdTime`, {
      headers: authHeader(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.createdTime || null;
  }

  /**
   * Liste les fichiers les plus récemment modifiés dans les sous-dossiers
   * d'un chantier (tous modules confondus), pour le fil "Activité récente".
   * Retourne les infos brutes (nom, date, sous-dossier d'origine) — la
   * mise en forme du texte d'activité est faite côté interface.
   */
  async function getActiviteRecenteChantier(chantierId, limite) {
    const q = encodeURIComponent(
      `'${chantierId}' in parents or mimeType != 'application/vnd.google-apps.folder'`
    );
    // Requête en deux temps : on récupère d'abord les sous-dossiers du
    // chantier, puis les fichiers récents à l'intérieur de chacun.
    const sousDossiers = await listSubfolders(chantierId);
    // Inclut aussi ACCUEIL SECURITE, imbriqué dans SECURITE
    const securite = sousDossiers.find((f) => f.name === "SECURITE");
    let tousDossiers = [...sousDossiers];
    if (securite) {
      const accueilSecu = await listSubfolders(securite.id);
      tousDossiers = tousDossiers.concat(accueilSecu);
    }

    if (tousDossiers.length === 0) return [];

    const parentsClause = tousDossiers.map((f) => `'${f.id}' in parents`).join(" or ");
    const qFiles = encodeURIComponent(
      `(${parentsClause}) and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
    );
    const res = await fetch(
      `${API_BASE}/files?q=${qFiles}&fields=files(id,name,modifiedTime,parents)&orderBy=modifiedTime desc&pageSize=${limite || 5}&spaces=drive`,
      { headers: authHeader() }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  }

  return {
    creerArborescenceChantier,
    findChantierFolder,
    listChantiers,
    getDossierAnneeAccueilInterimaire,
    getDossierModuleChantier,
    getDossierMachineFicheMateriel,
    findOrCreateFolder,
    uploadFile,
    getFolderCreatedTime,
    getActiviteRecenteChantier,
  };
})();
