/**
 * ndc-pieux.js — Note de calcul des PIEUX (tarière creuse / inclusions)
 *
 * Lecture du tableau « TABLEAU RECAP. PIEUX » collé depuis l'Excel de la NDC,
 * puis enregistrement dans le dossier Drive du chantier
 * ({chantier}/PREPARATION/ndc-pieux.json). Cette liste alimente le N° Px du
 * rapport journalier pieux.
 *
 * Repris de la NDC (validé par Clément le 19-20/11/2026) : repère, Φ (converti
 * en mm), niveau AS (affiché au chef), longueur forée /PFT, contrôle renforcé
 * (CR), ferraillage. Charges, efforts, niveaux TN / PFT et colonnes de calcul
 * cachées sont ignorés. Les repères sont gardés tels qu'écrits (ex. « 23* »).
 *
 * Les fonctions de lecture sont pures (testables sans navigateur).
 */
const FTSNdcPieux = (() => {
  const NOM_DOSSIER = "PREPARATION";
  const NOM_FICHIER = "ndc-pieux.json";
  // Couleur d'un diamètre : attribuée dans l'ordre des Ø présents (petit → gros)
  const PALETTE = ["#FFE066", "#9AD48A", "#F2A39A", "#8FB8F0", "#B9A3E8", "#F7B267", "#7FD1C7", "#E0A3C8"];

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
  function fr(n, d = 2) {
    if (n === "" || n == null) return "";
    return arrondi(n, d).toFixed(d).replace(".", ",");
  }
  function majuscules(s) { return String(s == null ? "" : s).replace(/ /g, " ").trim().replace(/\s+/g, " ").toUpperCase(); }
  function sansAccent(s) { return majuscules(s).normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  function repere(s) { return String(s == null ? "" : s).replace(/ /g, " ").trim().replace(/\s+/g, " "); }
  function cleRep(s) { return repere(s).toUpperCase().replace(/\s+/g, ""); }
  function compareReperes(a, b) { return String(a).localeCompare(String(b), "fr", { numeric: true, sensitivity: "base" }); }

  /**
   * Découpe un collage Excel (texte tabulé). Excel met entre guillemets les
   * cellules qui contiennent un retour à la ligne (en-têtes « N° pieu » sur
   * deux lignes) : ces cellules restent entières.
   * @returns {string[][]}
   */
  function decouperTSV(texte) {
    const s = String(texte || "").replace(/\r\n?/g, "\n");
    const lignes = [];
    let ligne = [], cel = "", i = 0;
    const finCel = () => { ligne.push(cel); cel = ""; };
    while (i < s.length) {
      const c = s[i];
      if (c === '"' && cel === "") {
        // Cellule entre guillemets : jusqu'au guillemet fermant suivi d'une tabulation / fin de ligne
        let j = i + 1, v = "", ferme = false;
        while (j < s.length) {
          if (s[j] === '"') {
            if (s[j + 1] === '"') { v += '"'; j += 2; continue; }
            if (j + 1 >= s.length || s[j + 1] === "\t" || s[j + 1] === "\n") { ferme = true; j++; break; }
          }
          v += s[j]; j++;
        }
        if (ferme) { cel = v; i = j; continue; }
        // Pas de guillemet fermant : le guillemet fait partie du texte
        cel += c; i++; continue;
      }
      if (c === "\t") { finCel(); i++; continue; }
      if (c === "\n") { finCel(); lignes.push(ligne); ligne = []; i++; continue; }
      cel += c; i++;
    }
    if (cel !== "" || ligne.length) { finCel(); lignes.push(ligne); }
    return lignes;
  }

  // ── Lecture du collage ──────────────────────────────────────────
  const CHAMPS = [
    { k: "rep", lib: "Repère" },
    { k: "phi", lib: "Φ pieu" },
    { k: "as", lib: "Niveau AS" },
    { k: "long", lib: "Longueur forée" },
    { k: "cr", lib: "Contrôle renforcé" },
    { k: "fer", lib: "Ferraillage" },
  ];
  // « TABLEAU RECAP. PIEUX » copié sans entête : A repère · P Φ · S niveau AS · T longueur · U CR · V ferraillage
  const ORDRE_RECAP = { 0: "rep", 15: "phi", 18: "as", 19: "long", 20: "cr", 21: "fer" };

  /** Lignes au-dessus du tableau : indice, DDC, nombre de pieux annoncé, date */
  function lireEntete(brutes) {
    const infos = {}, reste = [];
    const apres = (cells, i) => { for (let j = i + 1; j < cells.length; j++) { const v = String(cells[j] || "").trim(); if (v) return v; } return ""; };
    brutes.forEach((cells) => {
      let info = false;
      cells.forEach((c, i) => {
        const t = sansAccent(c).replace(/\s*:\s*$/, "");
        let m;
        if ((m = t.match(/^NOMBRE DE PIEUX\s*[=:]\s*(\d+)/))) { infos.nbPx = Number(m[1]); info = true; }
        else if (/^NOMBRE DE PIEUX$/.test(t) && nombre(apres(cells, i)) !== "" && cells.filter((x) => String(x || "").trim()).length <= 3) { infos.nbPx = nombre(apres(cells, i)); info = true; }
        else if (/^INDICE( DE LA NOTE| NDC)?$/.test(t)) { const v = apres(cells, i); if (v && v.length <= 4) { infos.indice = v; info = true; } }
        else if (/^DESCENTE DE CHARGES? DE REFERENCE$|^DDC( DE REFERENCE)?$/.test(t)) { const v = apres(cells, i); if (v) { infos.ddc = v; info = true; } }
        else if (/^TABLEAU RECAPITULATIF/.test(t)) info = true;
        else if (/^DATE$/.test(t) && i <= 1) { const v = apres(cells, i); if (v) infos.date = v; info = true; }
      });
      if (!info) reste.push(cells);
    });
    return { infos, reste };
  }
  function estLigneEntete(cells) {
    const t = sansAccent(cells.join(" | "));
    const mots = /PIEU|COMBINAISON|LONGUEUR|FERRAILLAGE|NIVEAU|VMAX|VMIN|EFFORT|CONTROLE|\[M\]|\[-\]|NGF/.test(t);
    // Une ligne de pieu a un ferraillage (« C2A - 6HA16 ») ou des nombres partout
    const nb = cells.filter((x) => nombre(x) !== "").length;
    return mots && nb < 4;
  }
  /** Champ d'une colonne d'après son entête (haut = ligne du titre, bas = sous-titre) */
  function deviner(haut, bas) {
    const h = sansAccent(haut), t = `${h} ${sansAccent(bas)}`;
    if (/Φ|Ø|DIAMETRE|PHI/.test(t)) return "phi";
    if (/^N°|^NO\b|^REPERE/.test(h)) return "rep";
    if (/LONGUEUR/.test(t)) return "long";
    if (/NIVEAU/.test(t) && /\bAS\b|ARASE/.test(t)) return "as";
    if (/CONTROLE/.test(t)) return "cr";
    if (/FERRAILLAGE|ARMATURE|CAGE/.test(t)) return "fer";
    return "";
  }

  /**
   * Analyse un collage Excel du tableau récapitulatif des pieux.
   * @returns {{ colonnes: string[], lignes: string[][], entete: boolean, nbColonnes: number, infos: object }}
   */
  function analyserCollage(texte) {
    const lu = lireEntete(decouperTSV(texte).filter((c) => c.some((x) => String(x).trim() !== "")));
    const brutes = lu.reste;
    const entetes = [];
    let i = 0;
    while (i < brutes.length && i < 4 && estLigneEntete(brutes[i])) { entetes.push(brutes[i]); i++; }
    const lignes = brutes.slice(i);
    const nbColonnes = Math.max(0, ...brutes.map((c) => c.length));
    let colonnes;
    if (entetes.length) {
      const haut = entetes[0], bas = entetes[1] || [];
      let porte = "";
      colonnes = [];
      for (let c = 0; c < nbColonnes; c++) {
        const hh = String(haut[c] || "").trim(), bb = String(bas[c] || "").trim();
        if (hh) porte = hh; else if (!bb) porte = "";
        colonnes.push(deviner(hh || (bb ? porte : ""), bb));
      }
      const vus = new Set();
      colonnes = colonnes.map((k) => (k && !vus.has(k) ? (vus.add(k), k) : ""));
    } else {
      colonnes = Array.from({ length: nbColonnes }, (_, c) => ORDRE_RECAP[c] || "");
    }
    return { colonnes, lignes, entete: entetes.length > 0, nbColonnes, infos: lu.infos };
  }

  /**
   * Lignes collées → pieux, d'après la correspondance des colonnes.
   * @returns {{ pieux: object[], ignorees: number, note: string }}
   */
  function lirePieux(lignes, colonnes) {
    const pieux = [];
    let ignorees = 0, note = "";
    lignes.forEach((cells) => {
      const p = { rep: "", phi: "", as: "", long: "", cr: false, fer: "" };
      colonnes.forEach((k, c) => {
        if (!k) return;
        const v = cells[c] == null ? "" : String(cells[c]).replace(/ /g, " ").trim();
        if (k === "rep") p.rep = repere(v);
        else if (k === "cr") p.cr = /^(CR|OUI|X|1|VRAI)$/i.test(v);
        else if (k === "fer") p.fer = v.replace(/\s+/g, " ");
        else p[k] = nombre(v);
      });
      if (nombre(p.phi) !== "" && p.phi < 5) p.phi = arrondi(p.phi * 1000, 0); // 0,52 m → 520 mm
      const ok = p.rep && !/#N\/?A|#VAL/i.test(p.rep) && nombre(p.long) > 0 && nombre(p.phi) > 0;
      if (!ok) {
        const texteLong = cells.map((x) => String(x || "").trim()).find((x) => x.length > 40 && /[a-z]/.test(x));
        if (texteLong && !note) note = texteLong;
        else if (p.rep && !/#N\/?A|#VAL/i.test(p.rep)) ignorees++;
        return;
      }
      pieux.push(p);
    });
    return { pieux, ignorees, note };
  }

  // ── Calculs ─────────────────────────────────────────────────────
  /** Volume théorique (m³) d'un pieu : π × (Φ/2)² × longueur, Φ en mm */
  function volume(phiMm, longueur) {
    const d = nombre(phiMm), L = nombre(longueur);
    if (!(d > 0) || !(L > 0)) return "";
    return Math.PI * Math.pow(d / 2000, 2) * L;
  }
  /** Résumé d'une liste : par diamètre, CR, longueur et volume totaux */
  function resumer(pieux) {
    const parD = new Map();
    let longueur = 0, vol = 0, cr = 0, etoiles = [];
    (pieux || []).forEach((p) => {
      parD.set(p.phi, (parD.get(p.phi) || 0) + 1);
      longueur += nombre(p.long) || 0;
      vol += volume(p.phi, p.long) || 0;
      if (p.cr) cr++;
      if (/\*/.test(p.rep)) etoiles.push(p.rep);
    });
    const diametres = [...parD.entries()].sort((a, b) => a[0] - b[0]).map(([d, nb], i) => ({ d, nb, couleur: PALETTE[i % PALETTE.length] }));
    return { nb: (pieux || []).length, diametres, cr, longueur, volume: vol, etoiles };
  }
  function couleurs(pieux) {
    const m = {};
    resumer(pieux).diametres.forEach((x) => { m[x.d] = x.couleur; });
    return m;
  }

  /**
   * Fusionne un collage dans la liste enregistrée.
   * « remplacer » : la liste devient celle du collage ; « ajouter » : un repère déjà présent est mis à jour.
   */
  function fusionner(existants, colles, mode) {
    const avant = new Map((existants || []).map((p) => [cleRep(p.rep), p]));
    const dedoublon = new Map();
    (colles || []).forEach((p) => dedoublon.set(cleRep(p.rep), p));
    const nouveaux = [], misAJour = [], retires = [];
    dedoublon.forEach((p, k) => {
      if (!avant.has(k)) nouveaux.push(p.rep);
      else if (JSON.stringify(avant.get(k)) !== JSON.stringify(p)) misAJour.push(p.rep);
    });
    let resultat;
    if (mode === "ajouter") {
      const m = new Map(avant);
      dedoublon.forEach((p, k) => m.set(k, p));
      resultat = [...m.values()];
    } else {
      avant.forEach((p, k) => { if (!dedoublon.has(k)) retires.push(p.rep); });
      resultat = [...dedoublon.values()];
    }
    // Ordre de la NDC gardé (c'est l'ordre proposé au chef pour « Px suivant »)
    return { pieux: resultat, nouveaux, misAJour, retires };
  }

  // ── Données ─────────────────────────────────────────────────────
  function nouvelle() {
    return { version: 1, indice: "", ddc: "", date: "", nbAnnonce: "", note: "", pieux: [], historique: [], majLe: "", majPar: "" };
  }
  function normaliser(d) {
    const b = nouvelle();
    d = d || {};
    return {
      ...b, ...d,
      pieux: (Array.isArray(d.pieux) ? d.pieux : []).map((p) => ({ rep: repere(p.rep), phi: nombre(p.phi), as: nombre(p.as), long: nombre(p.long), cr: !!p.cr, fer: String(p.fer || "") })),
      historique: Array.isArray(d.historique) ? d.historique : [],
    };
  }

  // ── Drive ───────────────────────────────────────────────────────
  async function dossier(chantierId) { return FTSDrive.findOrCreateFolder(NOM_DOSSIER, chantierId); }
  /** @returns {Promise<object|null>} NDC pieux enregistrée, ou null */
  async function lire(chantierId) {
    const d = await dossier(chantierId);
    const f = await FTSDrive.findFilesExact(NOM_FICHIER, d);
    if (!f.length) return null;
    const texte = await FTSDrive.downloadFileText(f[0].id);
    try { return texte ? normaliser(JSON.parse(texte)) : null; } catch (e) { throw new Error("Le fichier de la NDC pieux est illisible."); }
  }
  /** Lecture côté tablette : ne crée jamais de dossier (null si pas de NDC) */
  async function lireSansCreer(chantierId) {
    const d = await FTSDrive.findFolderExact(NOM_DOSSIER, chantierId);
    if (!d) return null;
    const f = await FTSDrive.findFilesExact(NOM_FICHIER, d);
    if (!f.length) return null;
    const texte = await FTSDrive.downloadFileText(f[0].id);
    try { return texte ? normaliser(JSON.parse(texte)) : null; } catch (e) { return null; }
  }
  /** Enregistre la NDC + un résumé dans les métadonnées du chantier (liste Préparation) */
  async function enregistrer(chantierId, ndc) {
    const d = await dossier(chantierId);
    const data = { ...normaliser(ndc), majLe: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    await FTSDrive.uploadFile(blob, NOM_FICHIER, "application/json", d, { remplacerSiExiste: true });
    let meta = null;
    try {
      meta = await FTSDrive.getMetadonneesChantier(chantierId);
      meta = { ...meta, ndcPieux: { indice: data.indice || "", nb: data.pieux.length, majLe: data.majLe } };
      await FTSDrive.setMetadonneesChantier(chantierId, meta);
    } catch (e) {
      console.warn("Résumé de la NDC pieux non écrit dans le chantier :", e);
      meta = null;
    }
    return { data, meta };
  }

  return {
    NOM_DOSSIER, NOM_FICHIER, CHAMPS, ORDRE_RECAP,
    nombre, fr, arrondi, cleRep, compareReperes,
    decouperTSV, lireEntete, estLigneEntete, deviner, analyserCollage, lirePieux,
    volume, resumer, couleurs, fusionner, nouvelle, normaliser, lire, lireSansCreer, enregistrer,
  };
})();

if (typeof window !== "undefined") window.FTSNdcPieux = FTSNdcPieux;
if (typeof module !== "undefined") module.exports = FTSNdcPieux;
