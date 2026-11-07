/**
 * preparation.js — Fiche de préparation de chantier (micropieux)
 *
 * Moteur de calcul + lecture de la note de calcul collée depuis Excel +
 * enregistrement de la préparation dans le dossier Drive du chantier
 * ({chantier}/PREPARATION/preparation.json).
 *
 * Règles validées par Clément (06/11/2026) :
 *  - Tubes : longueur retenue = retouche du pieu, sinon longueur par
 *    diamètre, sinon longueur NDC. Découpe en tubes de la longueur max de
 *    la foreuse (selon sa course), complément avec le plus petit tube
 *    accepté qui couvre le reste (reste < 1 m → tube de 1,5 m).
 *  - Tubes secondaires : en tête de pieu, sur la longueur de la NDC, ils
 *    S'AJOUTENT aux tubes principaux.
 *  - Platine : barre → percée (table des perçages) ; sinon tube
 *    secondaire → collerette Ø tube secondaire ; sinon collerette Ø tube
 *    principal.
 *  - Ciment théorique : (section forage − section acier du tube principal)
 *    × longueur × dosage × (1 + surconsommation). Barres et tubes
 *    secondaires négligés.
 *  - As de carreau (pointes) : 1 par pieu au Ø du tube principal + 1 au Ø du
 *    tube secondaire s'il y en a un.
 *  - Tubes pastillés : lignes ajoutées à la main uniquement.
 *
 * Les fonctions de calcul sont pures (testables sans navigateur).
 */
const FTSPreparation = (() => {
  const NOM_DOSSIER = "PREPARATION";
  const NOM_FICHIER = "preparation.json";
  const TYPES_BARRE = ["GEWI", "DYWIDAG"];
  const DIAMETRES_TUBE = [60, 73, 88.9, 114, 127, 139.7, 177.8];
  // Code couleur des diamètres (identique à l'onglet NDC de l'Excel FTS)
  const COULEURS_TUBE = { 73: "#FFFF00", 88.9: "#00B050", 114: "#00B0F0", 127: "#7030A0", 139.7: "#FF0000", 177.8: "#FFC000" };
  const EPS = 1e-6;

  // ── Outils ──────────────────────────────────────────────────────
  function nombre(v) {
    if (v === "" || v == null) return "";
    if (typeof v === "number") return Number.isFinite(v) ? v : "";
    const t = String(v).replace(/ /g, " ").trim().replace(/\s/g, "").replace(",", ".");
    if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(t)) return "";
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : "";
  }
  const arrondi = (n, d = 2) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
  function fr(n, d) {
    if (n === "" || n == null) return "";
    const v = d == null ? arrondi(n, 3) : arrondi(n, d);
    return String(v).replace(".", ",");
  }
  function majuscules(s) { return String(s == null ? "" : s).replace(/ /g, " ").trim().replace(/\s+/g, " ").toUpperCase(); }
  function sansAccent(s) { return majuscules(s).normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  // Repère tel qu'écrit dans la NDC (« Mp1 ») ; comparaison sans casse ni espaces
  function repere(s) { return String(s == null ? "" : s).replace(/\u00a0/g, " ").trim().replace(/\s+/g, " "); }
  function cleRep(s) { return repere(s).toUpperCase().replace(/\s+/g, ""); }
  /** Tri naturel des repères : MP2 avant MP10, puis les autres préfixes */
  function compareReperes(a, b) {
    return String(a).localeCompare(String(b), "fr", { numeric: true, sensitivity: "base" });
  }
  function couleurTube(d) { return COULEURS_TUBE[nombre(d)] || ""; }

  // ── Tubes ───────────────────────────────────────────────────────
  /** Longueurs de tube acceptées par une foreuse dont la longueur max est `max` */
  function tubesAcceptes(max) {
    const m = nombre(max);
    if (!(m > 0)) return [];
    return m > 1.5 ? [m, 1.5] : [m];
  }
  /**
   * Découpe une longueur en tubes.
   * @returns {number[]} longueurs des tubes, du plus long au plus court
   */
  function decoupe(longueur, max) {
    const L = nombre(longueur), M = nombre(max);
    if (!(L > 0) || !(M > 0)) return [];
    const n = Math.floor(L / M + EPS);
    const tubes = Array(n).fill(M);
    const reste = arrondi(L - n * M, 3);
    if (reste > EPS) {
      const acceptes = tubesAcceptes(M).slice().sort((a, b) => a - b);
      tubes.push(acceptes.find((t) => t + EPS >= reste) || M);
    }
    return tubes;
  }
  function texteDecoupe(tubes) { return tubes.length ? tubes.map((t) => fr(t)).join(" + ") : "—"; }

  // ── Pieux ───────────────────────────────────────────────────────
  function pieuVide() {
    return {
      rep: "", charge: "", traction: "", forage: "", tubeD: "", tubeE: "", longNdc: "", longMain: "",
      platine: "", tubeSecD: "", tubeSecE: "", tubeSecL: "", barreType: "", barreD: "", barreL: "",
    };
  }
  /** Longueur retenue d'un pieu (m) et son origine : "main" | "diametre" | "ndc" */
  function longueurRetenue(p, longParDiam) {
    if (nombre(p.longMain) !== "") return { L: nombre(p.longMain), origine: "main" };
    const parD = longParDiam ? nombre(longParDiam[String(nombre(p.tubeD))]) : "";
    if (parD !== "") return { L: parD, origine: "diametre" };
    return { L: nombre(p.longNdc), origine: "ndc" };
  }
  /** Coiffe de la platine (texte de la fiche) */
  function coiffePlatine(p, percagePour) {
    const barre = nombre(p.barreD);
    if (barre > 0) {
      const pc = percagePour ? nombre(percagePour(barre)) : "";
      return pc !== "" ? `PERCE EN ${fr(pc)}mm` : `PERCE (barre Ø${fr(barre)} : perçage à définir)`;
    }
    if (nombre(p.tubeSecD) > 0) return `COLLERETTE Ø ${fr(p.tubeSecD)}`;
    if (nombre(p.tubeD) > 0) return `COLLERETTE Ø ${fr(p.tubeD)}`;
    return "";
  }
  function sectionPlatine(s) { return String(s || "").replace(/\s+/g, "").replace(/[xX×]/, " x ").trim(); }

  // ── Calcul complet des fournitures ─────────────────────────────
  /**
   * @param {object} prep   préparation (voir nouvellePreparation)
   * @param {object} ctx    { tubeMax, percagePour(barre), ciment:{sac, sacsPalette}, dosage }
   */
  function calculer(prep, ctx) {
    const pieux = (prep.ndc && prep.ndc.pieux) || [];
    const longParDiam = (prep.ndc && prep.ndc.longParDiam) || {};
    const tubeMax = nombre(ctx.tubeMax);
    const forageMm = nombre(prep.ndc && prep.ndc.forage) || 250;
    const tubes = new Map();      // "D|L" → { d, l, qte, pastille }
    const platines = new Map();   // "section|coiffe"
    const centreurs = new Map();  // "forage|tubeD"
    const barres = new Map();     // "type|D|L"
    const detail = [];
    let lineaire = 0, volume = 0;
    const ajoute = (map, cle, base) => { const x = map.get(cle) || { ...base, qte: 0 }; x.qte++; map.set(cle, x); };
    const sForage = Math.PI * Math.pow(forageMm / 1000, 2) / 4;

    pieux.forEach((p) => {
      const { L, origine } = longueurRetenue(p, longParDiam);
      const d = nombre(p.tubeD);
      const t = d > 0 ? decoupe(L, tubeMax) : [];
      t.forEach((l) => ajoute(tubes, `${d}|${l}`, { d, l, pastille: false }));
      const ds = nombre(p.tubeSecD);
      const ts = ds > 0 ? decoupe(nombre(p.tubeSecL), tubeMax) : [];
      ts.forEach((l) => ajoute(tubes, `${ds}|${l}`, { d: ds, l, pastille: false }));
      const coiffe = coiffePlatine(p, ctx.percagePour);
      const section = sectionPlatine(p.platine);
      if (section || coiffe) ajoute(platines, `${section}|${coiffe}`, { section, coiffe });
      // As de carreau (pointes) : un par tube principal, et un de plus par tube secondaire, au Ø du tube
      if (d > 0) ajoute(centreurs, `${forageMm}|${d}`, { forage: forageMm, d });
      if (ds > 0) ajoute(centreurs, `${forageMm}|${ds}`, { forage: forageMm, d: ds });
      const bd = nombre(p.barreD);
      if (bd > 0) {
        const type = majuscules(p.barreType) || "GEWI";
        ajoute(barres, `${type}|${bd}|${nombre(p.barreL)}`, { type, d: bd, l: nombre(p.barreL) });
      }
      if (L > 0) {
        lineaire += L;
        const e = nombre(p.tubeE);
        const sAcier = d > 0 && e > 0 ? Math.PI * (Math.pow(d / 1000, 2) - Math.pow((d - 2 * e) / 1000, 2)) / 4 : 0;
        volume += L * Math.max(0, sForage - sAcier);
      }
      detail.push({ rep: p.rep, L, origine, tubes: t, tubesSec: ts, coiffe });
    });

    (prep.pastilles && prep.pastilles.actif ? prep.pastilles.lignes || [] : []).forEach((x) => {
      const d = nombre(x.d), l = nombre(x.l), q = nombre(x.qte);
      if (d > 0 && l > 0 && q > 0) {
        const cle = `${d}|${l}|P`;
        const y = tubes.get(cle) || { d, l, pastille: true, qte: 0 };
        y.qte += q; tubes.set(cle, y);
      }
    });

    const tri = (a, b) => a.d - b.d || (a.pastille === b.pastille ? b.l - a.l : a.pastille ? 1 : -1);
    const surconso = nombre(prep.ciment && prep.ciment.surconso);
    const dosage = nombre(ctx.dosage) || 1200;
    const kg = volume * dosage * (1 + (surconso === "" ? 0 : surconso) / 100);
    const sac = nombre(ctx.ciment && ctx.ciment.sac);
    const sacsPalette = nombre(ctx.ciment && ctx.ciment.sacsPalette);
    const sacs = sac > 0 ? Math.ceil(kg / sac - EPS) : "";
    const palettes = sacs !== "" && sacsPalette > 0 ? Math.ceil(sacs / sacsPalette - EPS) : "";

    return {
      nbPieux: pieux.length,
      lineaire: arrondi(lineaire, 3),
      tubes: [...tubes.values()].sort(tri),
      platines: [...platines.values()].sort((a, b) => a.coiffe.localeCompare(b.coiffe, "fr", { numeric: true })),
      centreurs: [...centreurs.values()].sort((a, b) => a.d - b.d),
      barres: [...barres.values()].sort((a, b) => a.type.localeCompare(b.type) || a.d - b.d),
      ciment: { volume: arrondi(volume, 3), kg: Math.round(kg), sacs, palettes, sac, sacsPalette, surconso, dosage },
      detail,
    };
  }

  /**
   * Tubes pour la fiche : calculés (avec marge) + ajoutés à la main, regroupés
   * par Ø / longueur / pastillé.
   */
  function tubesFiche(calc, prep) {
    const m = new Map();
    const marges = prep.marges || {};
    calc.tubes.forEach((t) => {
      const q = Math.max(0, t.qte + (nombre(marges[cleArticle("tube", t)]) || 0));
      const k = `${t.d}|${t.l}|${t.pastille ? "P" : ""}`;
      const x = m.get(k) || { d: t.d, l: t.l, pastille: t.pastille, qte: 0 };
      x.qte += q; m.set(k, x);
    });
    (prep.tubesManuels || []).forEach((t) => {
      const d = nombre(t.d), l = nombre(t.l), q = nombre(t.qte);
      if (!(d > 0 && l > 0 && q > 0)) return;
      const k = `${d}|${l}|`;
      const x = m.get(k) || { d, l, pastille: false, qte: 0 };
      x.qte += q; m.set(k, x);
    });
    return [...m.values()].filter((x) => x.qte > 0)
      .sort((a, b) => a.d - b.d || (a.pastille === b.pastille ? a.l - b.l : a.pastille ? 1 : -1));
  }

  /** Clé stable d'un article (pour les marges) */
  function cleArticle(type, a) {
    if (type === "tube") return `tube|${a.d}|${a.l}${a.pastille ? "|P" : ""}`;
    if (type === "platine") return `platine|${a.section}|${a.coiffe}`;
    if (type === "centreur") return `centreur|${a.forage}|${a.d}`;
    if (type === "barre") return `barre|${a.type}|${a.d}|${a.l}`;
    return type;
  }

  /** Diamètres de tube principal présents dans la NDC, avec nombre de pieux et longueurs NDC min/max */
  function diametresPresents(pieux) {
    const m = new Map();
    (pieux || []).forEach((p) => {
      const d = nombre(p.tubeD);
      if (!(d > 0)) return;
      const x = m.get(d) || { d, e: nombre(p.tubeE), nb: 0, min: Infinity, max: -Infinity };
      x.nb++;
      const L = nombre(p.longNdc);
      if (L !== "") { x.min = Math.min(x.min, L); x.max = Math.max(x.max, L); }
      m.set(d, x);
    });
    return [...m.values()].sort((a, b) => a.d - b.d).map((x) => ({ ...x, min: x.min === Infinity ? "" : x.min, max: x.max === -Infinity ? "" : x.max }));
  }

  // ── Lecture de la note de calcul collée depuis Excel ───────────
  const CHAMPS = [
    { k: "rep", lib: "Repère" },
    { k: "charge", lib: "Charge ELS (t)" },
    { k: "traction", lib: "Traction" },
    { k: "forage", lib: "Ø forage" },
    { k: "tubeD", lib: "Tube Ø (mm)" },
    { k: "tubeE", lib: "Tube épaisseur (mm)" },
    { k: "longNdc", lib: "Longueur (m)" },
    { k: "platine", lib: "Platine" },
    { k: "tubeSecD", lib: "Tube sec. Ø" },
    { k: "tubeSecE", lib: "Tube sec. épaisseur" },
    { k: "tubeSecL", lib: "Tube sec. longueur" },
    { k: "barreType", lib: "Barre type" },
    { k: "barreD", lib: "Barre Ø" },
    { k: "barreL", lib: "Barre longueur" },
  ];
  // Ordre des colonnes de l'onglet « A-5 TABLEAU RECAP » (si aucune entête n'est collée)
  const ORDRE_A5 = ["rep", "charge", "traction", "forage", "tubeD", "tubeE", "longNdc", "", "platine", "tubeSecD", "tubeSecE", "tubeSecL", "", "barreType", "barreD", "barreL", ""];

  function decouperLignes(texte) {
    return String(texte || "").replace(/\r/g, "").split("\n").map((l) => l.split("\t"));
  }
  function estLigneEntete(cells) {
    const t = sansAccent(cells.join(" "));
    return /MICROPIEU|CHARGE|DIAMETRE|EPAISSEUR|PLATINE|BARRE|FORAGE|LONG/.test(t) && !cells.some((c) => /^\s*MP\s*\d/i.test(c));
  }
  /** Devine le champ d'une colonne à partir de son entête (ligne du haut + sous-entête) */
  function deviner(haut, bas) {
    const h = sansAccent(haut), b = sansAccent(bas), t = `${h} ${b}`;
    if (/PASTILL|ANCRAGE|ARASE|SUBSTRATUM/.test(t)) return "";
    if (/SECONDAIRE/.test(h)) {
      if (/EPAIS/.test(b)) return "tubeSecE";
      if (/LG|LONG/.test(b)) return "tubeSecL";
      return "tubeSecD";
    }
    if (/BARRE/.test(h)) {
      if (/TYPE/.test(b)) return "barreType";
      if (/LG|LONG/.test(b)) return "barreL";
      return "barreD";
    }
    if (/TYPE DE TUBE|TUBE PRINCIPAL/.test(h)) return /EPAIS/.test(b) ? "tubeE" : "tubeD";
    if (/MICROPIEU|^N°/.test(h) || /^N°$/.test(b)) return "rep";
    if (/TRACTION/.test(t)) return "traction";
    if (/CHARGE|ELS/.test(t)) return "charge";
    if (/PLATINE/.test(t)) return "platine";
    if (/FORAGE/.test(t)) return "forage";
    if (/LONG/.test(t)) return "longNdc";
    if (/EPAIS/.test(t)) return "tubeE";
    if (/DIAMETRE/.test(t)) return "tubeD";
    return "";
  }

  /**
   * Analyse un collage Excel.
   * @returns {{ colonnes: string[], lignes: string[][], entete: boolean, nbColonnes: number }}
   *   colonnes[i] = champ deviné pour la colonne i ("" = ignorée)
   */
  function analyserCollage(texte) {
    const brutes = decouperLignes(texte).filter((c) => c.some((x) => String(x).trim() !== ""));
    const entetes = [];
    let i = 0;
    while (i < brutes.length && i < 3 && estLigneEntete(brutes[i])) { entetes.push(brutes[i]); i++; }
    const lignes = brutes.slice(i);
    const nbColonnes = Math.max(0, ...brutes.map((c) => c.length));
    let colonnes;
    if (entetes.length) {
      const haut = entetes[0], bas = entetes[1] || [];
      let porte = "";
      colonnes = [];
      for (let c = 0; c < nbColonnes; c++) {
        const hh = String(haut[c] || "").trim();
        const bb = String(bas[c] || "").trim();
        if (hh) porte = hh; else if (!bb) porte = "";
        colonnes.push(deviner(hh || (bb ? porte : ""), bb));
      }
      // un même champ ne peut être attribué qu'une fois (on garde le premier)
      const vus = new Set();
      colonnes = colonnes.map((k) => (k && !vus.has(k) ? (vus.add(k), k) : ""));
    } else {
      colonnes = Array.from({ length: nbColonnes }, (_, c) => ORDRE_A5[c] || "");
    }
    return { colonnes, lignes, entete: entetes.length > 0, nbColonnes };
  }

  /**
   * Transforme les lignes collées en pieux, d'après la correspondance des colonnes.
   * @returns {{ pieux: object[], ignorees: number, note: string }}
   */
  function lirePieux(lignes, colonnes) {
    const pieux = [];
    let ignorees = 0, note = "";
    lignes.forEach((cells) => {
      const p = pieuVide();
      colonnes.forEach((k, c) => {
        if (!k) return;
        const v = cells[c] == null ? "" : String(cells[c]).replace(/ /g, " ").trim();
        if (k === "rep") p.rep = repere(v);
        else if (k === "platine") p.platine = v;
        else if (k === "barreType") p.barreType = majuscules(v);
        else if (k === "traction") p.traction = majuscules(v);
        else p[k] = nombre(v);
      });
      const L = nombre(p.longNdc);
      const vide = !p.rep || /#N\/?A/i.test(p.rep) || !(L > 0 || nombre(p.tubeD) > 0);
      if (vide) {
        const texteLong = cells.map((x) => String(x || "").trim()).find((x) => x.length > 25 && /[a-z]/i.test(x));
        if (texteLong && !note) note = texteLong;
        else if (cells.some((x) => String(x || "").trim())) ignorees++;
        return;
      }
      if (nombre(p.forage) !== "" && p.forage < 5) p.forage = arrondi(p.forage * 1000, 1); // 0,25 m → 250 mm
      if (p.barreD !== "" && !p.barreType) p.barreType = "GEWI";
      if (!(nombre(p.barreD) > 0)) { p.barreType = ""; p.barreD = ""; p.barreL = ""; }
      if (!(nombre(p.tubeSecD) > 0)) { p.tubeSecD = ""; p.tubeSecE = ""; p.tubeSecL = ""; }
      pieux.push(p);
    });
    return { pieux, ignorees, note };
  }

  /**
   * Fusionne des pieux collés dans la liste existante.
   * mode "ajouter" : nouveaux repères ajoutés, existants mis à jour (la retouche
   * de longueur est perdue : le pieu reprend la longueur de son diamètre).
   * mode "remplacer" : la liste devient celle du collage.
   */
  function fusionner(existants, colles, mode) {
    const parRep = new Map((existants || []).map((p) => [cleRep(p.rep), p]));
    const nouveaux = [], misAJour = [], retires = [];
    if (mode === "remplacer") {
      const repsColles = new Set(colles.map((p) => cleRep(p.rep)));
      (existants || []).forEach((p) => { if (!repsColles.has(cleRep(p.rep))) retires.push(p.rep); });
      dedoublonner(colles).forEach((p) => (parRep.has(cleRep(p.rep)) ? misAJour : nouveaux).push(p.rep));
      return { pieux: dedoublonner(colles).sort((a, b) => compareReperes(a.rep, b.rep)), nouveaux, misAJour, retires, inchanges: 0 };
    }
    const resultat = new Map(parRep);
    dedoublonner(colles).forEach((p) => {
      const k = cleRep(p.rep);
      if (resultat.has(k)) misAJour.push(p.rep); else nouveaux.push(p.rep);
      resultat.set(k, { ...p, longMain: "" });
    });
    const inchanges = (existants || []).length - misAJour.length;
    return { pieux: [...resultat.values()].sort((a, b) => compareReperes(a.rep, b.rep)), nouveaux, misAJour, retires, inchanges };
  }
  function dedoublonner(pieux) {
    const m = new Map();
    pieux.forEach((p) => m.set(cleRep(p.rep), p));
    return [...m.values()];
  }

  // ── Préparation (données) ───────────────────────────────────────
  function nouvellePreparation(meta) {
    meta = meta || {};
    return {
      version: 1,
      indice: 1,
      majLe: "",
      infos: {
        adresse: meta.adresse || "", commune: meta.commune || "", conducteur: "",
        dateConnue: false, date: "", duree: meta.dureeChantier || "", dureeUnite: "JOUR(S)", priseMateriel: "DEPÔT",
      },
      equipe: { chef: "" },
      materiel: {
        foreuse: "", reglage: "standard", injection: "", presse: "", cuveGnr: "OUI", cuveEau: "1", caisseFlexible: "",
        elevateur: "", compresseur: "", groupe: "", pelle: "", pelleLivraison: "", godet: false,
      },
      remarques: { objectif: "", essais: "Aucun", essaiOui: false, essaiNb: 1, implantation: "A NOTRE CHARGE", boues: "NON", dechets: "A NOTRE CHARGE", outil: "", outilDiam: "", divers: "" },
      ndc: { indice: "", ddc: "", forage: 250, pieux: [], longParDiam: {}, note: "" },
      pastilles: { actif: false, lignes: [] },
      tubesManuels: [],
      ciment: { type: "32.5", surconso: "", premiereLivraison: "" },
      marges: {},
    };
  }
  /** Complète une préparation lue (ancienne version / champs manquants) */
  function normaliser(p, meta) {
    const base = nouvellePreparation(meta);
    p = p || {};
    return {
      ...base, ...p,
      infos: { ...base.infos, ...(p.infos || {}) },
      equipe: { ...base.equipe, ...(p.equipe || {}) },
      materiel: { ...base.materiel, ...(p.materiel || {}) },
      remarques: essais({ ...base.remarques, ...(p.remarques || {}) }, p.remarques),
      ndc: { ...base.ndc, ...(p.ndc || {}), pieux: ((p.ndc && p.ndc.pieux) || []).map((x) => ({ ...pieuVide(), ...x })) },
      pastilles: { ...base.pastilles, ...(p.pastilles || {}) },
      tubesManuels: Array.isArray(p.tubesManuels) ? p.tubesManuels : [],
      ciment: { ...base.ciment, ...(p.ciment || {}) },
      marges: { ...(p.marges || {}) },
      envoi: p.envoi && p.envoi.indice ? { historique: [], recap: [], ...p.envoi } : null,
    };
  }

  /** Micropieux d'essai : interrupteur oui / non + nombre (anciennes fiches : déduit du texte) */
  function essais(re, lu) {
    if (!lu || lu.essaiOui == null) {
      const m = String(re.essais || "").match(/(\d+)/);
      re.essaiOui = !!m && Number(m[1]) > 0;
      re.essaiNb = m ? Number(m[1]) || 1 : 1;
    }
    re.essaiNb = Math.max(1, Math.round(nombre(re.essaiNb) || 1));
    re.essais = texteEssais(re);
    return re;
  }
  function texteEssais(re) { return re && re.essaiOui ? `${Math.max(1, Math.round(nombre(re.essaiNb) || 1))} U` : "Aucun"; }
  /** Épaisseur déjà utilisée dans la NDC pour ce diamètre (la plus fréquente, tube principal ou secondaire) */
  function epaisseurPour(pieux, d) {
    const v = nombre(d);
    if (!(v > 0)) return "";
    const compte = new Map();
    (pieux || []).forEach((p) => {
      [[p.tubeD, p.tubeE], [p.tubeSecD, p.tubeSecE]].forEach(([dd, ee]) => {
        if (nombre(dd) === v && nombre(ee) > 0) compte.set(nombre(ee), (compte.get(nombre(ee)) || 0) + 1);
      });
    });
    let best = "", n = 0;
    compte.forEach((c, e) => { if (c > n) { best = e; n = c; } });
    return best;
  }

  // ── Envoi (lot 3a) ──────────────────────────────────────────────
  const DESTINATAIRES = ["m.delarche@fts-btp.fr", "e.doux@fts-btp.fr"];
  /** Liste d'adresses saisie (séparées par ; , espace ou retour ligne) */
  function adresses(texte) {
    return String(texte || "").split(/[;,\s]+/).map((x) => x.trim()).filter(Boolean);
  }
  const adresseValide = (a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a);
  /** Nom de fichier sans accent ni caractère interdit */
  function nomFichier(t) {
    return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  }
  function nomPdf(code, indice) { return `${nomFichier(code)}_Fiche-preparation_Ind${nomFichier(indice)}.pdf`; }
  /** Indice proposé pour le prochain envoi */
  function prochainIndice(prep, modifiee) {
    const e = prep.envoi;
    if (!e || !e.indice) return prep.indice === "" || prep.indice == null ? 1 : prep.indice;
    if (!modifiee) return e.indice;
    const n = Number(e.indice);
    return Number.isFinite(n) ? n + 1 : e.indice;
  }
  /**
   * Changements entre deux relevés de la fiche ([libellé, valeur] dans l'ordre de la fiche).
   * @returns {string[]} lignes « libellé : avant → après »
   */
  function comparer(avant, apres) {
    const a = new Map((avant || []).map(([k, v]) => [k, v]));
    const b = new Map((apres || []).map(([k, v]) => [k, v]));
    const vide = (v) => v == null || v === "";
    const out = [];
    for (const [k, v] of b) {
      const old = a.get(k);
      if (!a.has(k) || vide(old)) { if (!vide(v)) out.push(`${k} : ${v}${a.has(k) ? "" : " (ajouté)"}`); }
      else if (vide(v)) out.push(`${k} : supprimé (était ${old})`);
      else if (String(old) !== String(v)) out.push(`${k} : ${v} au lieu de ${old}`);
    }
    for (const [k, old] of a) if (!b.has(k) && !vide(old)) out.push(`${k} : supprimé (était ${old})`);
    return out;
  }

  // ── Drive ───────────────────────────────────────────────────────
  async function dossierPreparation(chantierId) {
    return FTSDrive.findOrCreateFolder(NOM_DOSSIER, chantierId);
  }
  /** @returns {Promise<object|null>} préparation enregistrée, ou null */
  async function lire(chantierId) {
    const dossierId = await dossierPreparation(chantierId);
    const fichiers = await FTSDrive.findFilesExact(NOM_FICHIER, dossierId);
    if (!fichiers.length) return null;
    const texte = await FTSDrive.downloadFileText(fichiers[0].id);
    try { return texte ? JSON.parse(texte) : null; } catch (e) { throw new Error("Le fichier de préparation est illisible."); }
  }
  /**
   * Résumé de la fiche, rangé dans les métadonnées du dossier chantier : la
   * liste « Préparation » de la Supervision l'affiche sans ouvrir chaque fiche.
   */
  function resume(prep) {
    const p = prep || {};
    const inf = p.infos || {}, ma = p.materiel || {};
    return {
      etat: p.envoi && p.envoi.indice ? (p.envoi.modifieApres ? "modifiee" : "envoyee") : "encours",
      indice: p.indice === "" || p.indice == null ? "" : p.indice,
      dateConnue: !!inf.dateConnue, date: inf.dateConnue ? inf.date || "" : "",
      chef: (p.equipe && p.equipe.chef) || "", conducteur: inf.conducteur || "",
      nbPieux: ((p.ndc && p.ndc.pieux) || []).length, foreuse: ma.foreuse || "",
      envoi: p.envoi ? { indice: p.envoi.indice || "", le: p.envoi.le || "" } : null,
      majLe: p.majLe || "",
    };
  }
  async function enregistrer(chantierId, prep) {
    const dossierId = await dossierPreparation(chantierId);
    const data = { ...prep, majLe: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    await FTSDrive.uploadFile(blob, NOM_FICHIER, "application/json", dossierId, { remplacerSiExiste: true });
    // Résumé dans les métadonnées du chantier (non bloquant : la fiche est déjà enregistrée)
    let meta = null;
    try {
      meta = await FTSDrive.getMetadonneesChantier(chantierId);
      meta = { ...meta, preparation: resume(data) };
      // Le conducteur de la fiche devient le conducteur du chantier (liste « Mes chantiers »)
      const cond = String((data.infos && data.infos.conducteur) || "").trim();
      if (cond) meta.conducteur = cond;
      // Point GPS du plan d'accès : gardé aussi sur le chantier
      const gps = data.plan && data.plan.gps && typeof FTSPlanAcces !== "undefined" ? FTSPlanAcces.lireGps(data.plan.gps) : null;
      if (gps) meta.gps = FTSPlanAcces.texteGps(gps);
      await FTSDrive.setMetadonneesChantier(chantierId, meta);
    } catch (e) {
      console.warn("Résumé de la préparation non écrit dans le chantier :", e);
      meta = null;
    }
    return { data, meta };
  }

  /** Libellés du nouveau relevé qui ont changé (ou sont nouveaux) : cases à surligner sur la fiche */
  function clesChangees(avant, apres) {
    const a = new Map((avant || []).map(([k, v]) => [k, v == null ? "" : String(v)]));
    const out = new Set();
    for (const [k, v] of apres || []) {
      const val = v == null ? "" : String(v);
      if (a.has(k) ? a.get(k) !== val : val !== "") out.add(k);
    }
    return out;
  }

  return {
    NOM_DOSSIER, NOM_FICHIER, TYPES_BARRE, DIAMETRES_TUBE, COULEURS_TUBE, CHAMPS, ORDRE_A5,
    nombre, fr, arrondi, majuscules, compareReperes, couleurTube, cleRep,
    tubesAcceptes, decoupe, texteDecoupe, pieuVide, longueurRetenue, coiffePlatine, sectionPlatine,
    calculer, cleArticle, diametresPresents, tubesFiche,
    analyserCollage, lirePieux, fusionner,
    nouvellePreparation, normaliser, lire, enregistrer, resume,
    DESTINATAIRES, adresses, adresseValide, nomFichier, nomPdf, prochainIndice, comparer, clesChangees, texteEssais, epaisseurPour,
  };
})();

if (typeof window !== "undefined") window.FTSPreparation = FTSPreparation;
if (typeof module !== "undefined") module.exports = FTSPreparation;
