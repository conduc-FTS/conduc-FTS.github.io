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
  const ROOT_ARCHIVES = "ARCHIVES";

  /**
   * Même logique que dans sheets.js : Google limite le nombre de requêtes
   * par minute, et charger plusieurs chantiers d'un coup (Vue d'ensemble,
   * Statistiques) peut dépasser ce quota — erreur 429 normale, pas une
   * panne. On réessaie automatiquement avant d'abandonner.
   */
  async function fetchAvecRetry(url, options, tentativesMax = 4) {
    let derniereReponse;
    for (let essai = 0; essai < tentativesMax; essai++) {
      derniereReponse = await fetch(url, options);
      if (derniereReponse.status !== 429 || essai === tentativesMax - 1) return derniereReponse;
      const attente = 600 * Math.pow(2, essai) + Math.random() * 300;
      await new Promise((resolve) => setTimeout(resolve, attente));
    }
    return derniereReponse;
  }

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
    // Pour un sous-dossier (parentId connu), on cherche précisément à cet
    // endroit. Pour un dossier racine (parentId absent), on ne suppose PAS
    // qu'il est à la racine du compte connecté : selon qui se connecte
    // (le conducteur propriétaire, ou un chef à qui le dossier est
    // seulement partagé), il peut apparaître ailleurs dans son Drive.
    // On cherche donc par nom sur tout ce qui est accessible au compte
    // (possédé ou partagé avec lui), sans restriction de parent.
    // Dossier racine : on cherche d'abord à la racine du Drive connecté.
    // Indispensable quand un sous-dossier porte le même nom (ex : un dossier
    // « ADMINISTRATIF » rangé dans le dossier d'un chef) : sans ça, on
    // pouvait tomber sur le mauvais et ne pas y trouver les classeurs.
    if (!parentId) {
      const qRacine = encodeURIComponent(
        `name = '${escapeForQuery(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`
      );
      const resRacine = await fetchAvecRetry(`${API_BASE}/files?q=${qRacine}&fields=files(id,name)&spaces=drive`, { headers: authHeader() });
      if (resRacine.ok) {
        const d = await resRacine.json();
        if (d.files && d.files.length > 0) return d.files[0].id;
      }
    }
    const parentClause = parentId ? ` and '${parentId}' in parents` : "";
    const q = encodeURIComponent(
      `name = '${escapeForQuery(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentClause}`
    );
    const res = await fetchAvecRetry(
      `${API_BASE}/files?q=${q}&fields=files(id,name)&spaces=drive&includeItemsFromAllDrives=true&supportsAllDrives=true`,
      { headers: authHeader() }
    );
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
    const res = await fetchAvecRetry(`${API_BASE}/files?q=${q}&fields=files(id,name,description)&spaces=drive&pageSize=1000`, {
      headers: authHeader(),
    });
    if (!res.ok) {
      throw new Error(`Erreur listage des sous-dossiers : ${res.status}`);
    }
    const data = await res.json();
    return data.files || [];
  }

  /**
   * Métadonnées d'un chantier (adresse, GPS, nombre de micropieux prévus),
   * stockées en JSON dans le champ "description" du dossier du chantier
   * sur Drive — pas besoin d'un fichier séparé pour ces quelques valeurs.
   * Prévu pour le futur plan d'accès et les carrés récapitulatifs des
   * chantiers en cours.
   */
  async function getMetadonneesChantier(chantierId) {
    const [res, marches] = await Promise.all([
      fetchAvecRetry(`${API_BASE}/files/${chantierId}?fields=description`, { headers: authHeader() }),
      lireMarches().catch(() => new Map()),
    ]);
    if (!res.ok) return {};
    const data = await res.json();
    return appliquerMontants(chantierId, parseMetadonnees(data.description), marches);
  }

  // ─── Montants des marchés : réservés à l'encadrement ───────────
  // Le montant vendu et les montants des avenants ne sont PAS stockés dans
  // la description du dossier chantier (lisible par les chefs qui ont accès
  // au dossier), mais dans le classeur « Marchés FTS » du dossier
  // REFERENTIEL (encadrement). Lecture / écriture transparentes : get/set
  // des métadonnées fusionnent / séparent les montants automatiquement.
  // Un compte sans accès au classeur (tablette) obtient simplement des
  // métadonnées sans montants.
  const DOSSIER_REFERENTIEL = "REFERENTIEL";
  const NOM_MARCHES = "Marchés FTS";
  const ONGLET_MARCHES = "Marches";
  const EN_TETE_MARCHES = ["ID dossier", "Chantier", "Montant vendu HT", "Montants avenants (JSON)", "Mis à jour"];
  const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
  const CLE_MARCHES = "fts_id_marches";
  let marchesCache = null, marchesA = 0, marchesPromesse = null;

  function lireMemoMarches() {
    try { const m = JSON.parse(localStorage.getItem(CLE_MARCHES) || "null"); return m && m.compte === compteActuel() ? m : null; } catch (e) { return null; }
  }
  function ecrireMemoMarches(m) { try { localStorage.setItem(CLE_MARCHES, JSON.stringify({ compte: compteActuel(), ...m })); } catch (e) {} }

  /** id du classeur Marchés (null si inaccessible). creer = le créer dans REFERENTIEL s'il manque. */
  async function idClasseurMarches(creer = false) {
    const memo = lireMemoMarches();
    if (memo && memo.id) return memo.id;
    if (memo && memo.absent && !creer && Date.now() - memo.absent < 6 * 3600 * 1000) return null;
    const q = encodeURIComponent(`name = '${escapeForQuery(NOM_MARCHES)}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`);
    const res = await fetchAvecRetry(`${API_BASE}/files?q=${q}&fields=files(id,capabilities/canEdit)&spaces=drive&includeItemsFromAllDrives=true&supportsAllDrives=true`, { headers: authHeader() });
    if (!res.ok) throw new Error(`Recherche du classeur Marchés : ${res.status}`);
    const f = ((await res.json()).files || [])[0];
    if (f) { ecrireMemoMarches({ id: f.id }); return f.id; }
    if (!creer) { ecrireMemoMarches({ absent: Date.now() }); return null; }
    const refId = await findOrCreateFolder(DOSSIER_REFERENTIEL, null);
    const rc = await fetchAvecRetry(SHEETS_API, {
      method: "POST", headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { title: NOM_MARCHES }, sheets: [{ properties: { title: ONGLET_MARCHES } }] }),
    });
    if (!rc.ok) throw new Error(`Création du classeur Marchés : ${rc.status}`);
    const { spreadsheetId } = await rc.json();
    await fetchAvecRetry(`${API_BASE}/files/${spreadsheetId}?addParents=${refId}&removeParents=root&fields=id`, { method: "PATCH", headers: authHeader() });
    await ecrireToutMarches(spreadsheetId, new Map());
    ecrireMemoMarches({ id: spreadsheetId });
    return spreadsheetId;
  }

  /** Map idDossier → { name, montantVendu, avenants:{idAvenant: montant} } (vide si inaccessible). */
  async function lireMarches(forcer = false) {
    if (!forcer && marchesCache && Date.now() - marchesA < 60000) return marchesCache;
    if (marchesPromesse) return marchesPromesse;
    marchesPromesse = (async () => {
      const id = await idClasseurMarches(false);
      const map = new Map();
      if (id) {
        const res = await fetchAvecRetry(`${SHEETS_API}/${id}/values/${encodeURIComponent(ONGLET_MARCHES + "!A2:E")}`, { headers: authHeader() });
        if (res.status === 404 || res.status === 403) { ecrireMemoMarches({ absent: Date.now() }); }
        else if (res.ok) {
          ((await res.json()).values || []).forEach((r) => {
            if (!r[0]) return;
            let av = {};
            try { av = r[3] ? JSON.parse(r[3]) : {}; } catch (e) {}
            const mv = String(r[2] == null ? "" : r[2]).replace(/\s/g, "").replace(",", ".");
            map.set(r[0], { name: r[1] || "", montantVendu: mv === "" ? undefined : Number(mv) || 0, avenants: av });
          });
        }
      }
      marchesCache = map; marchesA = Date.now();
      return map;
    })().finally(() => { marchesPromesse = null; });
    return marchesPromesse;
  }

  async function ecrireToutMarches(spreadsheetId, map) {
    const maintenant = new Date().toLocaleString("fr-FR");
    const lignes = [...map.entries()].sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)))
      .map(([id, m]) => [id, m.name || "", m.montantVendu == null ? "" : m.montantVendu, JSON.stringify(m.avenants || {}), m.maj || maintenant]);
    let res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(ONGLET_MARCHES + "!A:Z")}:clear`, { method: "POST", headers: authHeader() });
    if (!res.ok) throw new Error(`Écriture du classeur Marchés : ${res.status}`);
    res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(ONGLET_MARCHES + "!A1")}?valueInputOption=RAW`, {
      method: "PUT", headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ values: [EN_TETE_MARCHES, ...lignes] }),
    });
    if (!res.ok) throw new Error(`Écriture du classeur Marchés : ${res.status}`);
  }

  /** Enregistre les montants de plusieurs chantiers (relit, fusionne, réécrit) — une écriture à la fois. */
  let fileMarches = Promise.resolve();
  function enregistrerMarches(entrees) {
    const p = fileMarches.then(() => enregistrerMarchesDirect(entrees));
    fileMarches = p.catch(() => {});
    return p;
  }
  async function enregistrerMarchesDirect(entrees) {
    const id = await idClasseurMarches(true);
    const map = new Map(await lireMarches(true));
    const maintenant = new Date().toLocaleString("fr-FR");
    entrees.forEach((e) => map.set(e.id, { name: e.name || (map.get(e.id) || {}).name || "", montantVendu: e.montantVendu, avenants: e.avenants || {}, maj: maintenant }));
    await ecrireToutMarches(id, map);
    marchesCache = map; marchesA = Date.now();
  }

  // ─── Listes pour la tablette ──────────────────────────────────
  // Les référentiels (Parc matériel, Personnel FTS) restent réservés à
  // l'encadrement dans REFERENTIEL. La tablette lit une COPIE ALLÉGÉE,
  // le classeur « _LISTES TABLETTE » rangé dans DOSSIER CHANTIER (déjà
  // accessible aux chefs), réécrite par la Supervision à chaque
  // enregistrement d'un référentiel. Aucune adresse ni aucun montant dedans.
  const NOM_LISTES = "_LISTES TABLETTE";
  const CLE_LISTES = "fts_id_listes_tablette";
  async function idListesTablette(creer = false) {
    try { const m = JSON.parse(localStorage.getItem(CLE_LISTES) || "null"); if (m && m.compte === compteActuel() && m.id) return m.id; } catch (e) {}
    const q = encodeURIComponent(`name = '${escapeForQuery(NOM_LISTES)}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`);
    const res = await fetchAvecRetry(`${API_BASE}/files?q=${q}&fields=files(id)&spaces=drive&includeItemsFromAllDrives=true&supportsAllDrives=true`, { headers: authHeader() });
    if (!res.ok) throw new Error(`Recherche des listes tablette : ${res.status}`);
    let id = (((await res.json()).files || [])[0] || {}).id || null;
    if (!id && creer) {
      const racine = await getRootFolder(ROOT_DOSSIER_CHANTIER);
      const rc = await fetchAvecRetry(SHEETS_API, {
        method: "POST", headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { title: NOM_LISTES }, sheets: ["Machines", "Location", "Personnes"].map((t) => ({ properties: { title: t } })) }),
      });
      if (!rc.ok) throw new Error(`Création des listes tablette : ${rc.status}`);
      id = (await rc.json()).spreadsheetId;
      await fetchAvecRetry(`${API_BASE}/files/${id}?addParents=${racine}&removeParents=root&fields=id`, { method: "PATCH", headers: authHeader() });
    }
    if (id) try { localStorage.setItem(CLE_LISTES, JSON.stringify({ compte: compteActuel(), id })); } catch (e) {}
    return id;
  }
  /** Réécrit un onglet des listes tablette (lignes avec l'en-tête en premier). */
  async function ecrireListeTablette(onglet, lignes) {
    const id = await idListesTablette(true);
    const meta = await fetchAvecRetry(`${SHEETS_API}/${id}?fields=sheets.properties.title`, { headers: authHeader() });
    const titres = meta.ok ? ((await meta.json()).sheets || []).map((x) => x.properties.title) : [];
    if (!titres.includes(onglet)) {
      await fetchAvecRetry(`${SHEETS_API}/${id}:batchUpdate`, { method: "POST", headers: { ...authHeader(), "Content-Type": "application/json" }, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: onglet } } }] }) });
    }
    let r = await fetchAvecRetry(`${SHEETS_API}/${id}/values/${encodeURIComponent(onglet + "!A:Z")}:clear`, { method: "POST", headers: authHeader() });
    if (!r.ok) throw new Error(`Écriture des listes tablette : ${r.status}`);
    r = await fetchAvecRetry(`${SHEETS_API}/${id}/values/${encodeURIComponent(onglet + "!A1")}?valueInputOption=RAW`, {
      method: "PUT", headers: { ...authHeader(), "Content-Type": "application/json" }, body: JSON.stringify({ values: lignes }),
    });
    if (!r.ok) throw new Error(`Écriture des listes tablette : ${r.status}`);
  }
  /** Lignes d'un onglet des listes tablette (sans l'en-tête), ou null si absent. */
  async function lireListeTablette(onglet) {
    const id = await idListesTablette(false);
    if (!id) return null;
    const r = await fetchAvecRetry(`${SHEETS_API}/${id}/values/${encodeURIComponent(onglet + "!A2:F")}`, { headers: authHeader() });
    if (r.status === 404) { try { localStorage.removeItem(CLE_LISTES); } catch (e) {} return null; }
    if (!r.ok) return null;
    return (await r.json()).values || [];
  }

  /** Copie de meta avec les montants du classeur Marchés (si connus). */
  function appliquerMontants(chantierId, meta, marches) {
    const m = marches && marches.get(chantierId);
    if (!m) return meta;
    const out = { ...meta };
    if (m.montantVendu != null) out.montantVendu = m.montantVendu;
    if (Array.isArray(out.avenants)) out.avenants = out.avenants.map((a) => (m.avenants && m.avenants[a.id] != null ? { ...a, montant: m.avenants[a.id] } : a));
    return out;
  }
  /** Sépare la description publique (sans montants) et les montants. */
  function separerMontants(meta) {
    const publique = { ...meta };
    const aMontants = meta.montantVendu != null || (Array.isArray(meta.avenants) && meta.avenants.some((a) => a.montant != null));
    delete publique.montantVendu;
    const avenants = {};
    if (Array.isArray(meta.avenants)) {
      publique.avenants = meta.avenants.map((a) => { const { montant, ...reste } = a; if (montant != null) avenants[a.id] = Number(montant) || 0; return reste; });
    }
    return { publique, montants: aMontants ? { montantVendu: meta.montantVendu == null ? undefined : Number(meta.montantVendu) || 0, avenants } : null };
  }
  const aMontantsDansDescription = (meta) => meta.montantVendu != null || (Array.isArray(meta.avenants) && meta.avenants.some((a) => a.montant != null));

  /**
   * Migration (une fois, encadrement) : sort les montants encore présents dans
   * les descriptions des dossiers vers le classeur Marchés, puis réécrit les
   * descriptions sans montants. Ne fait rien si le classeur n'est pas
   * accessible en écriture.
   * @param {Array<{id, name, meta}>} chantiers  meta = description brute
   * @returns {Promise<number>} nombre de chantiers migrés
   */
  async function migrerMontants(chantiers) {
    const aMigrer = (chantiers || []).filter((c) => c && c.meta && aMontantsDansDescription(c.meta));
    if (!aMigrer.length) return 0;
    const marches = await lireMarches(true);
    const entrees = aMigrer.map((c) => {
      const { montants } = separerMontants(c.meta);
      const deja = marches.get(c.id);
      // Si le classeur a déjà une valeur (saisie après la migration), elle gagne
      return { id: c.id, name: c.name, montantVendu: deja && deja.montantVendu != null ? deja.montantVendu : montants.montantVendu, avenants: { ...montants.avenants, ...((deja && deja.avenants) || {}) } };
    });
    await enregistrerMarches(entrees);
    for (const c of aMigrer) {
      await fetchAvecRetry(`${API_BASE}/files/${c.id}?fields=id`, {
        method: "PATCH", headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ description: JSON.stringify(separerMontants(c.meta).publique) }),
      });
    }
    return aMigrer.length;
  }

  function parseMetadonnees(description) {
    try { return description ? JSON.parse(description) : {}; } catch (e) { return {}; }
  }

  /**
   * Techniques d'un chantier (un chantier peut en cumuler plusieurs) :
   * tableau parmi "Micropieux", "Pieux", "Battage". Les anciens chantiers
   * n'ont que typeChantier (une seule valeur) : on s'en sert à défaut.
   */
  function techniquesChantier(meta) {
    const t = meta && Array.isArray(meta.techniques) && meta.techniques.length ? meta.techniques : null;
    return t || [(meta && meta.typeChantier) || "Micropieux"];
  }

  /**
   * Chantiers de DOSSIER CHANTIER avec leurs métadonnées, en UNE requête
   * (la description du dossier, qui contient le JSON, est lue avec la
   * liste) — au lieu d'une requête par chantier.
   */
  async function listChantiersAvecMeta() {
    const [chantiers, marches] = await Promise.all([listChantiers(), lireMarches().catch(() => new Map())]);
    return chantiers.map((c) => {
      const brute = parseMetadonnees(c.description);
      return { id: c.id, name: c.name, meta: appliquerMontants(c.id, brute, marches), montantsDansDescription: aMontantsDansDescription(brute), metaBrute: brute };
    });
  }

  async function setMetadonneesChantier(chantierId, metadonnees) {
    const { publique, montants } = separerMontants(metadonnees || {});
    const res = await fetchAvecRetry(`${API_BASE}/files/${chantierId}?fields=id,name`, {
      method: "PATCH",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ description: JSON.stringify(publique) }),
    });
    if (montants) {
      // Rien à réécrire si les montants n'ont pas changé (archivage, clôture…)
      const connus = (await lireMarches().catch(() => new Map())).get(chantierId);
      if (connus && connus.montantVendu === montants.montantVendu && JSON.stringify(connus.avenants || {}) === JSON.stringify(montants.avenants || {})) return;
      const nom = res.ok ? ((await res.json()).name || "") : "";
      await enregistrerMarches([{ id: chantierId, name: nom, montantVendu: montants.montantVendu, avenants: montants.avenants }]);
    }
  }

  async function createFolder(name, parentId) {
    const metadata = { name, mimeType: "application/vnd.google-apps.folder" };
    if (parentId) metadata.parents = [parentId];

    const res = await fetchAvecRetry(`${API_BASE}/files?fields=id,name`, {
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
  // Les dossiers racine ne changent pas d'identifiant : on les garde en
  // mémoire le temps de la page, au lieu de les rechercher à chaque appel.
  // Mémorisés aussi sur l'appareil (par compte Google) : la recherche d'un
  // dossier racine parcourt tout le Drive et c'est l'une des demandes les
  // plus lentes ; son identifiant, lui, ne change jamais.
  const CLE_RACINES = "fts_ids_racines";
  const compteActuel = () => (window.FTSAuth && FTSAuth.emailMemorise && FTSAuth.emailMemorise()) || "";
  function lireRacinesMemo() {
    try {
      const m = JSON.parse(localStorage.getItem(CLE_RACINES) || "null");
      return m && m.compte === compteActuel() ? m.ids || {} : {};
    } catch (e) { return {}; }
  }
  function ecrireRacinesMemo(ids) {
    try { localStorage.setItem(CLE_RACINES, JSON.stringify({ compte: compteActuel(), ids })); } catch (e) {}
  }
  const cacheRacines = lireRacinesMemo();

  function oublierRacine(name) {
    delete cacheRacines[name];
    ecrireRacinesMemo(cacheRacines);
  }

  async function getRootFolder(name) {
    if (cacheRacines[name]) return cacheRacines[name];
    const id = await findFolderExact(name, null);
    if (id) { cacheRacines[name] = id; ecrireRacinesMemo(cacheRacines); }
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
   * Archive/désarchive un dossier chantier en le déplaçant entre
   * DOSSIER CHANTIER et un dossier ARCHIVES (créé automatiquement à la
   * racine du Drive s'il n'existe pas encore — contrairement aux autres
   * dossiers racine, celui-ci est entièrement géré par l'appli, donc pas
   * de risque de doublon mal placé). L'identifiant Drive du dossier ne
   * change JAMAIS lors d'un déplacement : un lien vers la page détail
   * d'un chantier continue de fonctionner à l'identique, archivé ou non.
   */
  async function archiverChantier(chantierFolderId) {
    const archivesId = await findOrCreateFolder(ROOT_ARCHIVES, null);
    const dossierChantierRootId = await getRootFolder(ROOT_DOSSIER_CHANTIER);
    const res = await fetchAvecRetry(
      `${API_BASE}/files/${chantierFolderId}?addParents=${archivesId}&removeParents=${dossierChantierRootId}&fields=id,parents`,
      { method: "PATCH", headers: authHeader() }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Erreur archivage : ${err.error?.message || res.status}`);
    }
    const meta = await getMetadonneesChantier(chantierFolderId);
    const aujourdhui = new Date();
    const dateArchivage = `${String(aujourdhui.getDate()).padStart(2, "0")}/${String(aujourdhui.getMonth() + 1).padStart(2, "0")}/${aujourdhui.getFullYear()}`;
    await setMetadonneesChantier(chantierFolderId, { ...meta, archive: true, dateArchivage });
  }

  async function desarchiverChantier(chantierFolderId) {
    const archivesId = await findOrCreateFolder(ROOT_ARCHIVES, null);
    const dossierChantierRootId = await getRootFolder(ROOT_DOSSIER_CHANTIER);
    const res = await fetchAvecRetry(
      `${API_BASE}/files/${chantierFolderId}?addParents=${dossierChantierRootId}&removeParents=${archivesId}&fields=id,parents`,
      { method: "PATCH", headers: authHeader() }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Erreur désarchivage : ${err.error?.message || res.status}`);
    }
    const meta = await getMetadonneesChantier(chantierFolderId);
    const metaMisAJour = { ...meta };
    delete metaMisAJour.archive;
    delete metaMisAJour.dateArchivage;
    await setMetadonneesChantier(chantierFolderId, metaMisAJour);
  }

  async function listChantiersArchives() {
    const archivesId = await findOrCreateFolder(ROOT_ARCHIVES, null);
    return listSubfolders(archivesId);
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

    // Métadonnées du chantier (type, adresse, GPS, nombre de micropieux
    // prévus, durée, montant vendu) stockées sur le dossier lui-même, en
    // JSON dans son champ description — réutilisées plus tard pour le plan
    // d'accès et les carrés récapitulatifs.
    {
      const metaExistante = await getMetadonneesChantier(chantierId);
      const metaMisAJour = {
        ...metaExistante,
        typeChantier: chantier.typeChantier || metaExistante.typeChantier || "Micropieux",
        ...(chantier.techniques && chantier.techniques.length ? { techniques: chantier.techniques } : {}),
        ...(chantier.pieuxPrevus ? { pieuxPrevus: Number(chantier.pieuxPrevus) } : {}),
        ...(chantier.battagePrevus ? { battagePrevus: Number(chantier.battagePrevus) } : {}),
        ...(chantier.adresse ? { adresse: chantier.adresse } : {}),
        ...(chantier.gps ? { gps: chantier.gps } : {}),
        ...(chantier.micropieuxPrevus ? { micropieuxPrevus: Number(chantier.micropieuxPrevus) } : {}),
        ...(chantier.dureeChantier ? { dureeChantier: Number(chantier.dureeChantier) } : {}),
        ...(chantier.montantVendu ? { montantVendu: Number(chantier.montantVendu) } : {}),
      };
      await setMetadonneesChantier(chantierId, metaMisAJour);
    }

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
  /**
   * Dossier de dépôt DANS LE CHANTIER (la tablette n'écrit plus que dans
   * DOSSIER CHANTIER ; le robot de recopie Google range ensuite une copie
   * dans les dossiers centraux de l'encadrement).
   *   ACCUEIL INTERIMAIRE → {chantier}/ACCUEIL INTERIMAIRE
   *   FICHE MATERIEL      → {chantier}/FICHE MATERIEL/{N° - nom machine}
   * @returns {Promise<string>} id du dossier
   */
  async function getDossierDepotChantier(codeChantier, module, sousDossier) {
    const chantier = await findChantierFolder(codeChantier);
    if (!chantier) throw new Error(`Aucun dossier chantier trouvé pour le code "${codeChantier}".`);
    const moduleId = await findOrCreateFolder(module, chantier.id);
    return sousDossier ? findOrCreateFolder(sousDossier, moduleId) : moduleId;
  }
  /** Nom du dossier d'une machine : « {N°} - {nom} » (ou le nom seul). */
  function nomDossierMachine(nomMachine, numeroMachine) {
    const nom = String(nomMachine || "DIVERS").trim().toUpperCase();
    const num = String(numeroMachine || "").trim().toUpperCase();
    return num ? `${num} - ${nom}` : nom;
  }

  async function getDossierMachineFicheMateriel(nomMachine, numeroMachine) {
    if (!nomMachine || !nomMachine.trim()) {
      throw new Error("Nom de machine requis pour archiver la fiche matériel.");
    }
    const rootId = await getRootFolder(ROOT_FICHE_MATERIEL);
    const nom = nomMachine.trim().toUpperCase();
    // Machine du Parc matériel : dossier « {N°} - {nom chantier} », retrouvé
    // par son N° (le nom chantier peut être renommé sans créer de doublon).
    if (numeroMachine && numeroMachine.trim()) {
      const num = numeroMachine.trim().toUpperCase();
      const dossiers = await listSubfolders(rootId);
      const existant = dossiers.find((f) => f.name.trim().toUpperCase().startsWith(num + " "));
      if (existant) return existant.id;
      return createFolder(`${num} - ${nom}`, rootId);
    }
    return findOrCreateFolder(nom, rootId);
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
    const memorise = !!cacheRacines[ROOT_DOSSIER_CHANTIER];
    let folders;
    try {
      folders = await listSubfolders(await getRootFolder(ROOT_DOSSIER_CHANTIER));
      if (memorise && folders.length === 0) throw new Error("vide");
    } catch (e) {
      if (!memorise) throw e;
      // Identifiant mémorisé périmé (autre compte, dossier déplacé…) : on le
      // recherche à nouveau une fois.
      oublierRacine(ROOT_DOSSIER_CHANTIER);
      folders = await listSubfolders(await getRootFolder(ROOT_DOSSIER_CHANTIER));
    }
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
  /**
   * Cherche des fichiers (pas des dossiers) portant EXACTEMENT ce nom
   * dans un dossier donné.
   */
  async function findFilesExact(name, parentId) {
    const q = encodeURIComponent(
      `name = '${escapeForQuery(name)}' and '${parentId}' in parents and trashed = false`
    );
    const res = await fetchAvecRetry(`${API_BASE}/files?q=${q}&fields=files(id,name)&spaces=drive`, {
      headers: authHeader(),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  }

  async function deleteFile(fileId) {
    await fetchAvecRetry(`${API_BASE}/files/${fileId}`, { method: "DELETE", headers: authHeader() });
  }

  /**
   * Télécharge le contenu texte d'un fichier Drive (JSON, texte brut...).
   * Renvoie null si le fichier n'existe pas ou est vide — pratique pour
   * les petits fichiers de données qu'un module veut faire persister
   * (ex : le registre Accueil Sécurité) sans passer par Google Sheets.
   */
  async function downloadFileText(fileId) {
    const res = await fetchAvecRetry(`${API_BASE}/files/${fileId}?alt=media`, { headers: authHeader() });
    if (!res.ok) throw new Error(`Erreur lecture fichier : ${res.status}`);
    return res.text();
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
   * @param {Object} [options]
   * @param {boolean} [options.remplacerSiExiste]  si true, supprime tout
   *   fichier existant portant le même nom dans ce dossier avant l'envoi
   *   (évite les doublons si un rapport du même jour est refait après
   *   correction d'une erreur).
   */
  async function uploadFile(blob, fileName, mimeType, folderId, options) {
    if (options && options.remplacerSiExiste) {
      const existants = await findFilesExact(fileName, folderId);
      for (const f of existants) {
        await deleteFile(f.id);
      }
    }

    const metadata = { name: fileName, parents: [folderId] };
    // Description = étiquette lue par le robot de recopie (ex : « FTS-CHEF:HUGO LAJUS »)
    if (options && options.description) metadata.description = options.description;
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", blob);

    const res = await fetchAvecRetry("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
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
    const res = await fetchAvecRetry(`${API_BASE}/files/${folderId}?fields=createdTime`, {
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
    const res = await fetchAvecRetry(
      `${API_BASE}/files?q=${qFiles}&fields=files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents)&orderBy=createdTime desc&pageSize=${limite || 5}&spaces=drive`,
      { headers: authHeader() }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  }

  /**
   * Liste les sous-dossiers d'un chantier (PLAN, NDC, SECURITE, RAPPORT
   * JOURNALIER, DICT, SONDAGE), plus ACCUEIL SECURITE imbriqué dans
   * SECURITE, pour affichage dans l'onglet Chantiers du dashboard.
   *
   * @param {string} codeChantier
   * @returns {Promise<Array<{id:string, name:string}>>}
   */
  async function getSousDossiersChantier(codeChantier) {
    const chantier = await findChantierFolder(codeChantier);
    if (!chantier) {
      throw new Error(`Aucun dossier chantier trouvé pour le code "${codeChantier}".`);
    }

    const sousDossiers = await listSubfolders(chantier.id);
    const resultat = sousDossiers.map((f) => ({ id: f.id, name: f.name }));

    const securite = sousDossiers.find((f) => f.name === "SECURITE");
    if (securite) {
      const accueilSecu = await listSubfolders(securite.id);
      const accueil = accueilSecu.find((f) => f.name === SECURITE_SUBFOLDER);
      if (accueil) {
        resultat.push({ id: accueil.id, name: "SECURITE / ACCUEIL SECURITE" });
      }
    }

    return { chantierName: chantier.name, dossiers: resultat };
  }

  /**
   * Liste les fichiers (pas les dossiers) directement à l'intérieur
   * d'un dossier donné, triés du plus récent au plus ancien.
   *
   * @param {string} folderId
   * @returns {Promise<Array<{id:string, name:string, modifiedTime:string, size:string, mimeType:string, webViewLink:string}>>}
   */
  async function listFilesInFolder(folderId) {
    const q = encodeURIComponent(
      `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
    );
    const res = await fetchAvecRetry(
      `${API_BASE}/files?q=${q}&fields=files(id,name,modifiedTime,size,mimeType,webViewLink)&orderBy=modifiedTime desc&pageSize=100&spaces=drive`,
      { headers: authHeader() }
    );
    if (!res.ok) {
      throw new Error(`Erreur listage des fichiers : ${res.status}`);
    }
    const data = await res.json();
    return data.files || [];
  }

  /**
   * Liste en UNE requête tous les fichiers (hors dossiers) contenus dans
   * plusieurs dossiers : sert à l'onglet Documents de la tablette (compteurs
   * par dossier, « Récents », recherche) sans une requête par dossier.
   * Chaque fichier garde son champ parents pour savoir d'où il vient.
   */
  async function listFilesInFolders(folderIds) {
    if (!folderIds || !folderIds.length) return [];
    const tous = [];
    // Par paquets de 40 dossiers (limite de longueur de la requête Drive)
    for (let i = 0; i < folderIds.length; i += 40) {
      const parents = folderIds.slice(i, i + 40).map((id) => `'${id}' in parents`).join(" or ");
      const q = encodeURIComponent(`(${parents}) and mimeType != 'application/vnd.google-apps.folder' and trashed = false`);
      let pageToken = "";
      do {
        const res = await fetchAvecRetry(
          `${API_BASE}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,thumbnailLink,parents)&orderBy=modifiedTime desc&pageSize=500&spaces=drive${pageToken ? "&pageToken=" + pageToken : ""}`,
          { headers: authHeader() }
        );
        if (!res.ok) throw new Error(`Erreur listage des fichiers : ${res.status}`);
        const data = await res.json();
        tous.push(...(data.files || []));
        pageToken = data.nextPageToken || "";
      } while (pageToken);
    }
    return tous;
  }

  /** Sous-dossiers (un niveau) de plusieurs dossiers, en une requête. */
  async function listFoldersInFolders(folderIds) {
    if (!folderIds || !folderIds.length) return [];
    const parents = folderIds.map((id) => `'${id}' in parents`).join(" or ");
    const q = encodeURIComponent(`(${parents}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const res = await fetchAvecRetry(`${API_BASE}/files?q=${q}&fields=files(id,name,parents)&pageSize=500&spaces=drive`, { headers: authHeader() });
    if (!res.ok) throw new Error(`Erreur listage des dossiers : ${res.status}`);
    const data = await res.json();
    return data.files || [];
  }

  /**
   * Télécharge le contenu brut d'un fichier (PDF, image…) pour la
   * visionneuse intégrée et le mode hors ligne.
   */
  async function downloadFileBlob(fileId) {
    const res = await fetchAvecRetry(`${API_BASE}/files/${fileId}?alt=media`, { headers: authHeader() });
    if (!res.ok) throw new Error(`Téléchargement impossible (${res.status})`);
    return await res.blob();
  }

  /**
   * Trouve (ou crée) l'arborescence d'archivage personnel d'un chef de
   * chantier pour les rapports journaliers :
   *   ADMINISTRATIF / {NOM DU CHEF} / RAPPORT JOURNALIER / RJ {année}
   *
   * La recherche du dossier du chef est tolérante à l'ordre des mots
   * (ex: "HUGO LAJUS" retrouve aussi bien "LAJUS HUGO" si c'est déjà
   * organisé ainsi sur le Drive), pour éviter de créer un doublon si
   * le nom a été saisi dans un ordre différent d'une fois sur l'autre.
   *
   * @param {string} nomChef  ex: "HUGO LAJUS"
   * @param {string|number} annee  ex: 2026
   * @returns {Promise<string>} id du dossier "RJ {année}"
   */
  async function getDossierRapportChef(nomChef, annee) {
    if (!nomChef || !nomChef.trim()) {
      throw new Error("Nom du chef de chantier requis pour l'archivage administratif.");
    }

    const administratifId = await getRootFolder(ROOT_ADMINISTRATIF);
    const dossiersChef = await listSubfolders(administratifId);

    // Comparaison tolérante à l'ordre des mots ET aux accents
    // (« FRÉDÉRIC BOURBON » retrouve le dossier « BOURBON FREDERIC »)
    const normaliser = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase().split(/\s+/).sort().join(" ");
    const motsCibles = normaliser(nomChef);
    const existant = dossiersChef.find((f) => normaliser(f.name) === motsCibles);

    const chefId = existant
      ? existant.id
      : await createFolder(nomChef.trim().toUpperCase(), administratifId);

    const rapportJournalierId = await findOrCreateFolder("RAPPORT JOURNALIER", chefId);
    const anneeId = await findOrCreateFolder(`RJ ${annee}`, rapportJournalierId);

    return anneeId;
  }

  return {
    creerArborescenceChantier,
    findChantierFolder,
    listChantiers,
    getDossierAnneeAccueilInterimaire,
    getDossierDepotChantier,
    nomDossierMachine,
    getDossierModuleChantier,
    getDossierMachineFicheMateriel,
    findOrCreateFolder,
    uploadFile,
    getFolderCreatedTime,
    getActiviteRecenteChantier,
    getSousDossiersChantier,
    listFilesInFolder,
    listFilesInFolders,
    listFoldersInFolders,
    downloadFileBlob,
    getMetadonneesChantier,
    setMetadonneesChantier,
    lireMarches,
    appliquerMontants,
    ecrireListeTablette,
    lireListeTablette,
    migrerMontants,
    listChantiersAvecMeta,
    parseMetadonnees,
    techniquesChantier,
    getDossierRapportChef,
    getRootFolder,
    archiverChantier,
    desarchiverChantier,
    listChantiersArchives,
    findFolderExact,
    listSubfolders,
    createFolder,
    findFilesExact,
    downloadFileText,
    deleteFile,
  };
})();

// Exposition explicite sur window : une déclaration top-level en const/let
// ne crée PAS de propriété window.FTSDrive automatiquement (contrairement à var),
// alors que tout le reste du code vérifie window.FTSDrive avant utilisation.
window.FTSDrive = FTSDrive;
