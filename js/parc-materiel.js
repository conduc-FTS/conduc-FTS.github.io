/**
 * parc-materiel.js — Référentiel unique du matériel FTS
 *
 * Une seule liste de machines pour toute l'appli : rapport journalier,
 * fiche matériel et pointage hebdo écrivent tous chaque machine de la
 * même façon (son « nom chantier »), et l'identifient par son N° machine.
 *
 * Stockage : classeur Google « Parc materiel FTS » (onglets Parc et
 * Location), rangé dans le dossier REFERENTIEL du Drive conducteurs.
 * Ce dossier doit être partagé EN LECTURE SEULE avec les chefs : ils
 * lisent la liste, seule la Supervision la modifie.
 *
 * Si le classeur est inaccessible (pas encore créé, pas partagé, hors
 * réseau), on utilise la dernière copie connue (cache de la tablette),
 * puis à défaut la liste de départ ci-dessous : le rapport n'est jamais
 * bloqué.
 *
 * Foreuses : longueur de tube maximale en course standard et en course
 * raccourcie (colonnes G et H), utilisée par la fiche de préparation de
 * chantier. Le classeur contient aussi les paramètres de préparation
 * (onglets « Percages platines », « Ciments », « Parametres prepa »).
 */
const FTSParc = (() => {
  const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DOSSIER = "REFERENTIEL";
  const NOM_CLASSEUR = "Parc materiel FTS";
  const ONGLET_PARC = "Parc";
  const ONGLET_LOC = "Location";
  const EN_TETE_PARC = ["N° machine", "Nom chantier", "Désignation complète", "Catégorie", "Chef attitré", "Statut",
    "Tube max course standard (m)", "Tube max course raccourcie (m)"];
  const ONGLET_PERCAGES = "Percages platines";
  const ONGLET_CIMENTS = "Ciments";
  const ONGLET_PARAMS = "Parametres prepa";
  const CACHE_PREPA = "fts_parametres_prepa_cache";
  const CATEGORIE_FOREUSE = "FOREUSES MICROPIEUX";
  // Longueurs de tube utilisées chez FTS (le 2 m est abandonné)
  const LONGUEURS_TUBE = [3, 1.5, 1];
  const CACHE_KEY = "fts_parc_materiel_cache";

  const CATEGORIES = [
    "FOREUSES MICROPIEUX", "MALAXEURS", "POMPES", "GROUPES ÉLECTROGÈNES", "COMPRESSEURS",
    "DESSABLEURS", "BATTAGE", "PELLES", "MANUTENTION", "DIVERS", "PIEUX (PTC)",
  ];
  // Catégories masquées dans le rapport journalier micropieux (pour plus tard)
  const CATEGORIES_MASQUEES_RAPPORT = ["PIEUX (PTC)"];
  const STATUTS = ["EN SERVICE", "HORS SERVICE", "VENDUE"];

  // Liste de départ : fichier du service matériel, normalisé (majuscules,
  // fautes corrigées, nom chantier court). [N°, nom chantier, désignation
  // complète, catégorie, chef attitré, statut]
  const DEFAUT = [
    ["00COMP", "COMPRESSEUR", "ATLAS COPCO XATS327 N°1", "COMPRESSEURS", "", "EN SERVICE"],
    ["01CF3", "TESCAR CF3", "TESCAR CF 3 N°1", "PIEUX (PTC)", "", "EN SERVICE"],
    ["01CUVEGNR", "CUVE GNR", "CUVE GNR", "DIVERS", "", "EN SERVICE"],
    ["01DCH100", "DCH100", "DCH100 N°1", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["01FUTURO", "FUTURO N°1", "FUTURO N°1", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["01GEO205", "GEO 205", "COMMACCHIO GEO 205", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["01MC15", "MC15", "COMMACCHIO MC15 N°1", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["01MC6", "MC6", "COMMACCHIO MC6 N°1", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["01MC8", "MC8", "COMMACCHIO MC8 N°1", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["01MD1500", "EGT MD1500", "EGT MD1500 N°1", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["01MECBO", "MECBO N°1", "MECBO N°1", "PIEUX (PTC)", "", "EN SERVICE"],
    ["01MI100P", "MIXO MI100 N°1", "MI100-P N°1", "MALAXEURS", "", "EN SERVICE"],
    ["01MR2000", "DESSABLEUR", "TEC SYSTEM MR2000 N°1 (DESSABLEUR)", "DESSABLEURS", "", "EN SERVICE"],
    ["01P105TT", "P105TT N°1", "LLAMADA P105TT N°1", "PIEUX (PTC)", "", "EN SERVICE"],
    ["01P135TT", "P135 N°1", "LLAMADA P135 N°1", "PIEUX (PTC)", "", "EN SERVICE"],
    ["01PAJOT1200", "PAJOT 1200 N°1", "PAJOT 1200 N°1", "BATTAGE", "", "EN SERVICE"],
    ["01PAJOT1400", "PAJOT 1400", "PAJOT 1400 N°1", "BATTAGE", "", "EN SERVICE"],
    ["01PAJOT600", "PAJOT 600", "PAJOT 600 N°1", "BATTAGE", "", "EN SERVICE"],
    ["01PDM3", "POMPE PDM3", "TEC SYSTEM PDM3 N°1", "POMPES", "", "EN SERVICE"],
    ["01PK85TT", "P85 N°1", "LLAMADA P85 N°1", "PIEUX (PTC)", "", "EN SERVICE"],
    ["01POMPEMEMB", "POMPE A MEMBRANE", "POMPE A MEMBRANE", "POMPES", "", "EN SERVICE"],
    ["01SEBHSA", "SEBHSA BD-3907-OR N°1", "SEBHSA BD-3907-OR N°1", "PIEUX (PTC)", "", "EN SERVICE"],
    ["01T41", "T41 N°1", "BERETTA T41 N°1", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["01T46", "T46", "BERETTA T46 N°1", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["01TH337", "TÉLESCO CAT TH337", "CATERPILLAR TH 337", "MANUTENTION", "", "EN SERVICE"],
    ["02FUTURO", "FUTURO N°2", "FUTURO N°2", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["02MECBO", "MECBO N°2", "MECBO N°2", "PIEUX (PTC)", "", "EN SERVICE"],
    ["02MI100P", "MIXO MI100 N°2", "MI100-P N°2", "MALAXEURS", "", "EN SERVICE"],
    ["02PAJOT1200", "PAJOT 1200 N°2", "PAJOT 1200 N°2", "BATTAGE", "", "EN SERVICE"],
    ["02PK85TT", "P85 N°2", "LLAMADA P85 N°2", "PIEUX (PTC)", "", "EN SERVICE"],
    ["02T41", "T41 N°2", "BERETTA T41 N°2", "FOREUSES MICROPIEUX", "", "EN SERVICE"],
    ["03MECBO", "MECBO N°3", "MECBO N°3", "PIEUX (PTC)", "", "EN SERVICE"],
    ["04PELLE", "PELLE CAT 313 N°4", "CAT 313 GC N°4 LUDO", "PELLES", "", "EN SERVICE"],
    ["05PELLE", "PELLE CAT 313 N°5", "CAT 313 GC N°5 FRANCK", "PELLES", "", "EN SERVICE"],
    ["06PELLE", "PELLE CAT 313 N°6", "CAT 313 GC N°6 ALRICK", "PELLES", "", "EN SERVICE"],
    ["GE60-BRUNO", "GROUPE ÉLECTROGÈNE BRUNO", "SDMO R66C3 BRUNO", "GROUPES ÉLECTROGÈNES", "BRUNO LABARTHE", "EN SERVICE"],
    ["GE60-CEDRIC", "GROUPE ÉLECTROGÈNE CÉDRIC", "SDMO R66C3 CEDRIC", "GROUPES ÉLECTROGÈNES", "CÉDRIC BERGADIEU", "EN SERVICE"],
    ["GE60-FRED", "GROUPE ÉLECTROGÈNE FRED", "SDMO R66C3 FREDERIC B", "GROUPES ÉLECTROGÈNES", "FRÉDÉRIC BOURBON", "EN SERVICE"],
    ["GE60-HUGO", "GROUPE ÉLECTROGÈNE HUGO", "ATLAS COPCO QES60 PD S3A HUGO", "GROUPES ÉLECTROGÈNES", "HUGO LAJUS", "EN SERVICE"],
    ["GE60-JEFF", "GROUPE ÉLECTROGÈNE JEFF", "SDMO R66C3 JEFF", "GROUPES ÉLECTROGÈNES", "JEFF CORBELLA", "EN SERVICE"],
    ["GE60-ROMAIN", "GROUPE ÉLECTROGÈNE ROMAIN", "SDMO R66C3 ROMAIN", "GROUPES ÉLECTROGÈNES", "ROMAIN SEREMPIOUQUE", "EN SERVICE"],
    ["GMP59V", "TECHNIWELL FRED", "TECHNIWELL GMP59V FREDERIC BOURBON", "POMPES", "FRÉDÉRIC BOURBON", "EN SERVICE"],
    ["MA12-BRUNO", "MA12 BRUNO", "TEC SYSTEM MA12 BRUNO LABARTHE", "MALAXEURS", "BRUNO LABARTHE", "EN SERVICE"],
    ["MA12-CEDRIC", "MA12 CÉDRIC", "TEC SYSTEM MA12 CEDRIC BERGADIEU", "MALAXEURS", "CÉDRIC BERGADIEU", "EN SERVICE"],
    ["MA12-HUGO", "MA12 HUGO", "TEC SYSTEM MA12 HUGO LAJUS", "MALAXEURS", "HUGO LAJUS", "EN SERVICE"],
    ["MA12-JEFF", "MA12 JEFF", "TEC SYSTEM MA12 JEFF CORBELLA", "MALAXEURS", "JEFF CORBELLA", "EN SERVICE"],
    ["MA12-ROMAIN", "MA12 ROMAIN", "TEC SYSTEM MA12 ROMAIN SEREMPIOUQUE", "MALAXEURS", "ROMAIN SEREMPIOUQUE", "EN SERVICE"],
    ["PH15-AUTO", "PH15 AUTONOME", "TEC SYSTEM PH15 UNITRAILLER", "POMPES", "", "EN SERVICE"],
    ["PH15-BRUNO", "PH15 BRUNO", "TEC SYSTEM PH15 BRUNO LABARTHE", "POMPES", "BRUNO LABARTHE", "EN SERVICE"],
    ["PH15-CEDRIC", "PH15 CÉDRIC", "TEC SYSTEM PH15 CEDRIC BERGADIEU", "POMPES", "CÉDRIC BERGADIEU", "EN SERVICE"],
    ["PH15-HUGO", "PH15 HUGO", "TEC SYSTEM PH15 HUGO LAJUS", "POMPES", "HUGO LAJUS", "EN SERVICE"],
    ["PH15-JEFF", "PH15 JEFF", "TEC SYSTEM PH15 JEFF CORBELLA", "POMPES", "JEFF CORBELLA", "EN SERVICE"],
    ["PH15-ROMAIN", "PH15 ROMAIN", "TEC SYSTEM PH15 ROMAIN SEREMPIOUQUE", "POMPES", "ROMAIN SEREMPIOUQUE", "EN SERVICE"],
    ["TMD-PAT", "MALAXEUR TMD+PAT", "TEC SYSTEM TMD+PAT", "MALAXEURS", "", "EN SERVICE"]
  ].map(([numero, nom, designation, categorie, chef, statut]) => ({ numero, nom, designation, categorie, chef, statut, ...tubesDefaut(numero) }));

  // Tube max par foreuse : [course standard, course raccourcie] (validé par Clément le 06/11/2026)
  function tubesDefaut(numero) {
    const t = {
      "01DCH100": [3, ""], "01MD1500": [3, ""], "01MC15": [3, ""], "01MC6": [3, 1.5], "01MC8": [3, 1.5],
      "01T41": [1.5, ""], "02T41": [1.5, ""], "01T46": [1.5, ""], "01FUTURO": [1.5, 1], "02FUTURO": [1.5, 1],
      "01GEO205": [1.5, ""],
    }[numero] || ["", ""];
    return { tubeStd: t[0], tubeRac: t[1] };
  }

  // Paramètres de la fiche de préparation de chantier (tous modifiables dans la Supervision)
  const PREPA_DEFAUT = {
    percages: [[16, 20], [20, 25], [25, 30], [28, 35], [32, 40], [40, 45]].map(([barre, percage]) => ({ barre, percage })),
    ciments: [{ type: "32.5", sac: 35, sacsPalette: 42 }, { type: "PM/ES", sac: 25, sacsPalette: "" }],
    dosage: 1200,
    surconso: 20,
  };

  const LOCATION_DEFAUT = [
    "FUTURO ELEC", "BUGGY", "TELESCO 6M", "TELESCO 7M", "TELESCO 9M", "TELESCO 10M", "TELESCO 12M",
    "TELESCO 17M", "TELESCO 21M", "GYROSCOPIQUE 17M", "GYROSCOPIQUE 21M", "PELLE 2.7T", "PELLE 3.5T",
    "PELLE 5T", "PELLE 8T", "PELLE 14T", "PELLE 20T VOLET VARIABLE", "COMPRESSEUR 5000L",
    "COMPRESSEUR 7000L", "COMPRESSEUR 10000L", "COMPRESSEUR 15000L", "COMPRESSEUR 20000L",
  ];

  // Anciens noms (rapport avant le référentiel) → N° machine. "CHEF" =
  // dépend du chef du rapport (ex : GROUPE 60 KVA d'Hugo → GE60-HUGO).
  const CORRESPONDANCE = {
    "FUTURO N°1": ["01FUTURO"], "FUTURO N°2": ["02FUTURO"], "T41 N°1": ["01T41"], "T41 N°2": ["02T41"],
    "T46": ["01T46"], "MC6": ["01MC6"], "MC8": ["01MC8"], "MC15": ["01MC15"], "DCH": ["01DCH100"],
    "EGT": ["01MD1500"], "MIXO N°1": ["01MI100P"], "MIXO N°2": ["02MI100P"], "TECNIWELL": ["GMP59V"],
    "AUTONOME": ["PH15-AUTO"], "COMPRESSEUR": ["00COMP"], "PDM": ["01PDM3"], "DESSABLEUR": ["01MR2000"],
    "CUVE GNR": ["01CUVEGNR"], "POMPE MEMBRANE": ["01POMPEMEMB"], "PAJOT 600": ["01PAJOT600"],
    "PAJOT 1400": ["01PAJOT1400"], "MA12 + PH15": ["MA12-CHEF", "PH15-CHEF"], "GROUPE 60 KVA": ["GE60-CHEF"],
  };
  // Prénom utilisé dans les N° machine attitrés (GE60-HUGO, MA12-BRUNO…)
  const PRENOM_CODE = {
    "BRUNO LABARTHE": "BRUNO", "CÉDRIC BERGADIEU": "CEDRIC", "FRÉDÉRIC BOURBON": "FRED",
    "HUGO LAJUS": "HUGO", "JEFF CORBELLA": "JEFF", "ROMAIN SEREMPIOUQUE": "ROMAIN",
  };

  let etat = { machines: DEFAUT.slice(), location: LOCATION_DEFAUT.slice(), source: "defaut", spreadsheetId: null };
  let prepa = copiePrepa(PREPA_DEFAUT);

  // ── Outils ──────────────────────────────────────────────────────
  function majuscules(s) { return String(s == null ? "" : s).trim().replace(/\s+/g, " ").toUpperCase(); }
  // Comparaison tolérante aux accents et à l'ordre des mots (« LAJUS HUGO » = « HUGO LAJUS »)
  function cle(s) {
    return majuscules(s).normalize("NFD").replace(/[̀-ͯ]/g, "").split(" ").sort().join(" ");
  }
  function sansAccent(s) { return majuscules(s).normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  // Nombre saisi à la française (« 1,5 ») ou vide
  function nombre(v) {
    if (v === "" || v == null) return "";
    const n = parseFloat(String(v).replace(",", ".").trim());
    return Number.isFinite(n) ? n : "";
  }
  function copiePrepa(p) {
    return {
      percages: (p.percages || []).map((x) => ({ ...x })), ciments: (p.ciments || []).map((x) => ({ ...x })),
      dosage: p.dosage, surconso: p.surconso,
    };
  }
  /** Ligne du classeur → machine. Ancien classeur sans colonnes tubes : valeurs de départ. */
  function ligneVersMachine(r, avecTubes) {
    const numero = majuscules(r[0]);
    const tubes = avecTubes ? { tubeStd: nombre(r[6]), tubeRac: nombre(r[7]) } : tubesDefaut(numero);
    return {
      numero, nom: majuscules(r[1] || r[0]), designation: majuscules(r[2]),
      categorie: majuscules(r[3]) || "DIVERS", chef: majuscules(r[4]), statut: majuscules(r[5]) || "EN SERVICE", ...tubes,
    };
  }
  function machineVersLigne(m) {
    return [m.numero, m.nom, m.designation, m.categorie, m.chef, m.statut, m.tubeStd === "" ? "" : m.tubeStd, m.tubeRac === "" ? "" : m.tubeRac];
  }

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

  function lireCache() {
    try { const raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function ecrireCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ machines: etat.machines, location: etat.location, date: Date.now(), spreadsheetId: etat.spreadsheetId || null, modifiable: !!etat.modifiable })); } catch (e) {}
  }

  // ── Accès au classeur ───────────────────────────────────────────
  async function trouverClasseur() {
    const q = encodeURIComponent(`name = '${NOM_CLASSEUR}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`);
    const res = await fetchAvecRetry(`${DRIVE_API}/files?q=${q}&fields=files(id,name,capabilities/canEdit)&spaces=drive&includeItemsFromAllDrives=true&supportsAllDrives=true`, { headers: authHeader() });
    if (!res.ok) throw new Error(`Recherche du parc matériel : ${res.status}`);
    const data = await res.json();
    return data.files && data.files.length ? data.files[0] : null;
  }

  async function lireValeurs(spreadsheetId, range) {
    const res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}`, { headers: authHeader() });
    if (!res.ok) throw new Error(`Lecture du parc matériel : ${res.status}`);
    return (await res.json()).values || [];
  }

  async function remplacerOnglet(spreadsheetId, onglet, valeurs) {
    let res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(onglet + "!A:Z")}:clear`, {
      method: "POST", headers: authHeader(),
    });
    if (!res.ok) throw new Error(`Écriture du parc matériel : ${res.status}`);
    res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(onglet + "!A1")}?valueInputOption=RAW`, {
      method: "PUT", headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ values: valeurs }),
    });
    if (!res.ok) throw new Error(`Écriture du parc matériel : ${res.status}`);
  }

  /**
   * Charge le parc. Ordre : classeur Google → copie locale → liste de départ.
   * @returns {Promise<{source:'sheet'|'cache'|'defaut', existe:boolean, modifiable:boolean}>}
   */
  async function charger(options = {}) {
    // options.rapide : pages de consultation (Détail, Pointages) — la copie
    // locale suffit si elle vient du classeur et a moins d'une heure.
    if (options.rapide) {
      const c = lireCache();
      if (c && c.spreadsheetId && c.machines && c.machines.length && Date.now() - (c.date || 0) < 3600 * 1000) {
        etat = { machines: c.machines, location: c.location || [], source: "sheet", spreadsheetId: c.spreadsheetId, modifiable: !!c.modifiable };
        return { source: "sheet", existe: true, modifiable: etat.modifiable };
      }
    }
    if (connecte()) {
      try {
        const fichier = await trouverClasseur();
        if (fichier) {
          const [lignesParc, lignesLoc] = await Promise.all([
            lireValeurs(fichier.id, `${ONGLET_PARC}!A1:H`),
            lireValeurs(fichier.id, `${ONGLET_LOC}!A2:A`).catch(() => []),
          ]);
          const avecTubes = (lignesParc[0] || []).length >= 7;
          etat = {
            machines: lignesParc.slice(1).filter((r) => r[0]).map((r) => ligneVersMachine(r, avecTubes)),
            location: lignesLoc.map((r) => majuscules(r[0])).filter(Boolean),
            source: "sheet",
            spreadsheetId: fichier.id,
            modifiable: !(fichier.capabilities && fichier.capabilities.canEdit === false),
          };
          ecrireCache();
          return { source: "sheet", existe: true, modifiable: etat.modifiable };
        }
        // Classeur introuvable : pas partagé avec ce compte (tablette) → copie
        // allégée « _LISTES TABLETTE » publiée par la Supervision
        const lp = FTSDrive.lireListeTablette ? await FTSDrive.lireListeTablette("Machines").catch(() => null) : null;
        if (lp && lp.length) {
          const ll = (await FTSDrive.lireListeTablette("Location").catch(() => null)) || [];
          etat = {
            machines: lp.filter((r) => r[0] && majuscules(r[0]) !== "N° MACHINE").map((r) => ligneVersMachine(r, r.length >= 7 || lp.some((x) => x.length >= 7))),
            location: ll.map((r) => majuscules(r[0])).filter(Boolean),
            source: "liste", spreadsheetId: null, modifiable: false,
          };
          ecrireCache();
          return { source: "liste", existe: true, modifiable: false };
        }
        const c = lireCache();
        if (c && c.machines && c.machines.length) {
          etat = { machines: c.machines, location: c.location || [], source: "cache", spreadsheetId: null };
          return { source: "cache", existe: false, modifiable: false };
        }
        etat = { machines: DEFAUT.slice(), location: LOCATION_DEFAUT.slice(), source: "defaut", spreadsheetId: null };
        return { source: "defaut", existe: false, modifiable: false };
      } catch (e) {
        console.warn("Parc matériel : lecture Google impossible, copie locale utilisée.", e);
      }
    }
    const c = lireCache();
    if (c && c.machines && c.machines.length) {
      etat = { machines: c.machines, location: c.location || [], source: "cache", spreadsheetId: null };
      return { source: "cache", existe: null, modifiable: false };
    }
    etat = { machines: DEFAUT.slice(), location: LOCATION_DEFAUT.slice(), source: "defaut", spreadsheetId: null };
    return { source: "defaut", existe: null, modifiable: false };
  }

  /** Crée le classeur dans REFERENTIEL à partir de la liste de départ (Supervision). */
  async function creerDepuisListeDeDepart() {
    const dossierId = await FTSDrive.findOrCreateFolder(DOSSIER, null);
    const res = await fetchAvecRetry(SHEETS_API, {
      method: "POST", headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: { title: NOM_CLASSEUR },
        sheets: [ONGLET_PARC, ONGLET_LOC, ONGLET_PERCAGES, ONGLET_CIMENTS, ONGLET_PARAMS].map((title) => ({ properties: { title } })),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Création du parc matériel : ${err.error?.message || res.status}`);
    }
    const { spreadsheetId } = await res.json();
    await fetchAvecRetry(`${DRIVE_API}/files/${spreadsheetId}?addParents=${dossierId}&removeParents=root&fields=id`, {
      method: "PATCH", headers: authHeader(),
    });
    etat = { machines: DEFAUT.slice(), location: LOCATION_DEFAUT.slice(), source: "sheet", spreadsheetId, modifiable: true };
    await enregistrer(etat.machines, etat.location);
    await enregistrerParametresPrepa(PREPA_DEFAUT);
    return spreadsheetId;
  }

  /**
   * Vérifie une liste de machines avant enregistrement.
   * @returns {string[]} erreurs (vide si tout va bien)
   */
  function verifier(machines) {
    const erreurs = [];
    const vusNum = new Map(), vusNom = new Map();
    machines.forEach((m) => {
      if (!m.numero) erreurs.push("Une machine n'a pas de N° machine.");
      if (!m.nom) erreurs.push(`${m.numero} : le nom chantier est obligatoire.`);
      const kn = sansAccent(m.numero), km = sansAccent(m.nom);
      if (vusNum.has(kn)) erreurs.push(`Le N° machine ${m.numero} est utilisé deux fois.`);
      if (km && vusNom.has(km)) erreurs.push(`Le nom chantier « ${m.nom} » est déjà pris par ${vusNom.get(km)}.`);
      vusNum.set(kn, true); if (km) vusNom.set(km, m.numero);
      if (!STATUTS.includes(m.statut)) erreurs.push(`${m.numero} : statut inconnu « ${m.statut} ».`);
      [["tubeStd", "course standard"], ["tubeRac", "course raccourcie"]].forEach(([k, lib]) => {
        const v = nombre(m[k]);
        if (v !== "" && !LONGUEURS_TUBE.includes(v)) erreurs.push(`${m.numero} : tube ${lib} de ${v} m inconnu (3 / 1,5 / 1 m).`);
      });
    });
    return erreurs;
  }

  async function enregistrer(machines, location) {
    const propres = machines.map((m) => ({
      numero: majuscules(m.numero), nom: majuscules(m.nom), designation: majuscules(m.designation),
      categorie: majuscules(m.categorie) || "DIVERS", chef: majuscules(m.chef), statut: majuscules(m.statut) || "EN SERVICE",
      tubeStd: nombre(m.tubeStd), tubeRac: nombre(m.tubeRac),
    })).sort((a, b) => a.numero.localeCompare(b.numero));
    const erreurs = verifier(propres);
    if (erreurs.length) throw new Error(erreurs.join(" "));
    const loc = [...new Set((location || []).map(majuscules).filter(Boolean))];
    if (!etat.spreadsheetId) throw new Error("Parc matériel non créé.");
    await remplacerOnglet(etat.spreadsheetId, ONGLET_PARC, [EN_TETE_PARC, ...propres.map(machineVersLigne)]);
    await remplacerOnglet(etat.spreadsheetId, ONGLET_LOC, [["Type de matériel de location"], ...loc.map((l) => [l])]);
    etat.machines = propres;
    etat.location = loc;
    ecrireCache();
    await publierListeTablette(true).catch((e) => console.warn("Listes tablette (machines) non mises à jour :", e));
  }

  /** Copie allégée pour les tablettes (DOSSIER CHANTIER / _LISTES TABLETTE). */
  async function publierListeTablette(forcer = false) {
    if (etat.source !== "sheet" || !FTSDrive.ecrireListeTablette) return false;
    const cle = "fts_listes_pub_parc";
    try { if (!forcer && Date.now() - Number(localStorage.getItem(cle) || 0) < 24 * 3600 * 1000) return false; } catch (e) {}
    await FTSDrive.ecrireListeTablette("Machines", [EN_TETE_PARC, ...etat.machines.map(machineVersLigne)]);
    await FTSDrive.ecrireListeTablette("Location", [["Type de matériel de location"], ...etat.location.map((l) => [l])]);
    try { localStorage.setItem(cle, String(Date.now())); } catch (e) {}
    return true;
  }

  // ── Paramètres de la préparation de chantier ───────────────────
  async function ongletsExistants(spreadsheetId) {
    const res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}?fields=sheets.properties.title`, { headers: authHeader() });
    if (!res.ok) throw new Error(`Lecture du parc matériel : ${res.status}`);
    return ((await res.json()).sheets || []).map((x) => x.properties.title);
  }
  async function assurerOnglets(spreadsheetId, titres) {
    const existants = await ongletsExistants(spreadsheetId);
    const manquants = titres.filter((t) => !existants.includes(t));
    if (!manquants.length) return;
    const res = await fetchAvecRetry(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
      method: "POST", headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ requests: manquants.map((title) => ({ addSheet: { properties: { title } } })) }),
    });
    if (!res.ok) throw new Error(`Création des onglets de préparation : ${res.status}`);
  }

  /**
   * Charge les paramètres de préparation (perçages, ciments, dosage,
   * surconsommation). Onglets absents → valeurs de départ.
   * À appeler après charger() (il faut l'identifiant du classeur).
   */
  async function chargerParametresPrepa() {
    if (etat.source === "sheet" && etat.spreadsheetId && connecte()) {
      try {
        const existants = await ongletsExistants(etat.spreadsheetId);
        const p = copiePrepa(PREPA_DEFAUT);
        if (existants.includes(ONGLET_PERCAGES)) {
          const l = await lireValeurs(etat.spreadsheetId, `${ONGLET_PERCAGES}!A2:B`);
          p.percages = l.map((r) => ({ barre: nombre(r[0]), percage: nombre(r[1]) })).filter((x) => x.barre !== "");
        }
        if (existants.includes(ONGLET_CIMENTS)) {
          const l = await lireValeurs(etat.spreadsheetId, `${ONGLET_CIMENTS}!A2:C`);
          p.ciments = l.filter((r) => String(r[0] || "").trim()).map((r) => ({ type: String(r[0]).trim(), sac: nombre(r[1]), sacsPalette: nombre(r[2]) }));
        }
        if (existants.includes(ONGLET_PARAMS)) {
          const l = await lireValeurs(etat.spreadsheetId, `${ONGLET_PARAMS}!A2:B`);
          l.forEach((r) => {
            const k = sansAccent(r[0]);
            if (k.startsWith("DOSAGE")) p.dosage = nombre(r[1]);
            if (k.startsWith("SURCONSOMMATION")) p.surconso = nombre(r[1]);
          });
        }
        prepa = p;
        try { localStorage.setItem(CACHE_PREPA, JSON.stringify(prepa)); } catch (e) {}
        return copiePrepa(prepa);
      } catch (e) {
        console.warn("Paramètres de préparation : lecture impossible, copie locale utilisée.", e);
      }
    }
    try { const c = JSON.parse(localStorage.getItem(CACHE_PREPA) || "null"); if (c) prepa = c; } catch (e) {}
    return copiePrepa(prepa);
  }

  function verifierParametresPrepa(p) {
    const erreurs = [];
    const vus = new Set();
    (p.percages || []).forEach((x) => {
      const b = nombre(x.barre), pc = nombre(x.percage);
      if (b === "" || pc === "") erreurs.push("Perçages : chaque ligne doit avoir un Ø de barre et un perçage.");
      else if (pc <= b) erreurs.push(`Perçages : le perçage (${pc} mm) doit être plus grand que la barre Ø${b}.`);
      if (b !== "" && vus.has(b)) erreurs.push(`Perçages : la barre Ø${b} est en double.`);
      vus.add(b);
    });
    const types = new Set();
    (p.ciments || []).forEach((c) => {
      const t = String(c.type || "").trim().toUpperCase();
      if (!t) erreurs.push("Ciments : chaque ligne doit avoir un type.");
      if (t && types.has(t)) erreurs.push(`Ciments : le type ${c.type} est en double.`);
      types.add(t);
      if (nombre(c.sac) === "" || nombre(c.sac) <= 0) erreurs.push(`Ciments : poids du sac manquant pour ${c.type || "une ligne"}.`);
      if (c.sacsPalette !== "" && c.sacsPalette != null && !(nombre(c.sacsPalette) > 0)) erreurs.push(`Ciments : nombre de sacs par palette invalide pour ${c.type}.`);
    });
    if (!(nombre(p.dosage) > 0)) erreurs.push("Le dosage ciment doit être un nombre positif.");
    const sc = nombre(p.surconso);
    if (sc === "" || sc < 0 || sc > 200) erreurs.push("La surconsommation doit être comprise entre 0 et 200 %.");
    return [...new Set(erreurs)];
  }

  async function enregistrerParametresPrepa(p) {
    const erreurs = verifierParametresPrepa(p);
    if (erreurs.length) throw new Error(erreurs.join(" "));
    if (!etat.spreadsheetId) throw new Error("Parc matériel non créé.");
    const propre = {
      percages: p.percages.map((x) => ({ barre: nombre(x.barre), percage: nombre(x.percage) })).sort((a, b) => a.barre - b.barre),
      ciments: p.ciments.map((c) => ({ type: String(c.type).trim().toUpperCase(), sac: nombre(c.sac), sacsPalette: nombre(c.sacsPalette) })),
      dosage: nombre(p.dosage), surconso: nombre(p.surconso),
    };
    await assurerOnglets(etat.spreadsheetId, [ONGLET_PERCAGES, ONGLET_CIMENTS, ONGLET_PARAMS]);
    await remplacerOnglet(etat.spreadsheetId, ONGLET_PERCAGES, [["Ø barre (mm)", "Perçage platine (mm)"], ...propre.percages.map((x) => [x.barre, x.percage])]);
    await remplacerOnglet(etat.spreadsheetId, ONGLET_CIMENTS, [["Type de ciment", "Poids du sac (kg)", "Sacs par palette"], ...propre.ciments.map((c) => [c.type, c.sac, c.sacsPalette])]);
    await remplacerOnglet(etat.spreadsheetId, ONGLET_PARAMS, [["Paramètre", "Valeur"], ["Dosage ciment (kg/m3)", propre.dosage], ["Surconsommation par défaut (%)", propre.surconso]]);
    prepa = propre;
    try { localStorage.setItem(CACHE_PREPA, JSON.stringify(prepa)); } catch (e) {}
    return copiePrepa(prepa);
  }

  function parametresPrepa() { return copiePrepa(prepa); }
  /** Perçage de platine pour une barre (mm), ou "" si la barre n'est pas dans la table */
  function percagePour(diamBarre) {
    const d = nombre(diamBarre);
    const t = prepa.percages.find((x) => x.barre === d);
    return t ? t.percage : "";
  }
  /** Longueurs de tube max d'une foreuse : { standard, raccourcie } (en m, "" si non renseigné) */
  function tubesMachine(m) {
    if (typeof m === "string") m = parNumero(m) || parNom(m);
    return m ? { standard: nombre(m.tubeStd), raccourcie: nombre(m.tubeRac) } : { standard: "", raccourcie: "" };
  }

  // ── Lecture pour les modules ────────────────────────────────────
  function toutes() { return etat.machines.slice(); }
  function location() { return etat.location.slice(); }
  function source() { return etat.source; }
  /** Machines utilisables sur chantier (en service, hors catégories masquées) */
  function disponibles() {
    return etat.machines.filter((m) => m.statut === "EN SERVICE" && !CATEGORIES_MASQUEES_RAPPORT.includes(m.categorie));
  }
  function parNumero(numero) {
    const k = sansAccent(numero);
    return etat.machines.find((m) => sansAccent(m.numero) === k) || null;
  }
  function parNom(nom) {
    const k = sansAccent(nom);
    return etat.machines.find((m) => sansAccent(m.nom) === k) || null;
  }
  /** Machines attitrées à un chef (en service), dans l'ordre du parc */
  function kitDuChef(nomChef) {
    const k = cle(nomChef);
    if (!k) return [];
    return disponibles().filter((m) => m.chef && cle(m.chef) === k);
  }
  function estLocation(nom) {
    const k = sansAccent(nom);
    return etat.location.some((l) => sansAccent(l) === k);
  }
  /** Libellé complet pour le service matériel : « NOM CHANTIER - DÉSIGNATION (N°) » */
  function libelleComplet(m) {
    if (!m) return "";
    const d = m.designation && sansAccent(m.designation) !== sansAccent(m.nom) ? ` - ${m.designation}` : "";
    return `${m.nom}${d} (${m.numero})`;
  }
  /**
   * Ancien nom (rapports d'avant le référentiel) → machine(s) du parc.
   * @returns {Array<object>} machines trouvées (vide si inconnu)
   */
  function resoudreAncienNom(ancien, nomChef) {
    const direct = parNom(ancien) || parNumero(ancien);
    if (direct) return [direct];
    const cibles = CORRESPONDANCE[sansAccent(ancien).replace(/\s*N°\s*/g, " N°")];
    if (!cibles) return [];
    const prenom = PRENOM_CODE[Object.keys(PRENOM_CODE).find((c) => cle(c) === cle(nomChef))] || "";
    return cibles.map((num) => parNumero(num.replace("-CHEF", prenom ? "-" + prenom : "-?"))).filter(Boolean);
  }

  return {
    CATEGORIES, STATUTS, CATEGORIES_MASQUEES_RAPPORT, DEFAUT, LOCATION_DEFAUT, DOSSIER, NOM_CLASSEUR,
    charger, creerDepuisListeDeDepart, enregistrer, verifier, publierListeTablette,
    toutes, location, source, disponibles, parNumero, parNom, kitDuChef, estLocation, libelleComplet,
    resoudreAncienNom, majuscules,
    CATEGORIE_FOREUSE, LONGUEURS_TUBE, PREPA_DEFAUT, nombre, tubesMachine,
    chargerParametresPrepa, parametresPrepa, enregistrerParametresPrepa, verifierParametresPrepa, percagePour,
  };
})();

window.FTSParc = FTSParc;
