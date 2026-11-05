/**
 * ateliers.js — regroupement des machines pour le Pointage matériel et
 * le Détail chantier (lignes du planning et du récap par chantier).
 *
 * Règle validée avec Clément :
 *  - une FOREUSE peut travailler seule → une ligne par foreuse ;
 *  - MA12 + PH15 + GE fonctionnent TOUJOURS ensemble → une seule ligne
 *    "centrale d'injection" par chef attitré (ex. "MA12 + PH15 + GE HUGO"),
 *    déduite du Parc matériel (même chef attitré) ;
 *  - le reste (compresseur, pelles, Pajot, dessableur…) → AUTRES MATÉRIELS ;
 *  - machines pieux (PTC) → section PIEUX ; location → MATÉRIEL LOCATION.
 *
 * Les noms affichés sont ceux du Parc ("Nom chantier", celui du rapport).
 * Nécessite parc-materiel.js (FTSParc) chargé, idéalement avec charger().
 */
const FTSAteliers = (() => {
  const SECTIONS = [
    { id: "foreuse", titre: "FOREUSES", fam: "mp" },
    { id: "centrale", titre: "CENTRALES D'INJECTION", fam: "mp" },
    { id: "autre", titre: "AUTRES MATÉRIELS", fam: "mp", repliable: true },
    { id: "pieux", titre: "PIEUX", fam: "px" },
    { id: "loc", titre: "MATÉRIEL LOCATION", fam: "tous" },
  ];
  const CAT_CENTRALE = ["MALAXEURS", "POMPES", "GROUPES ÉLECTROGÈNES"];
  const ORDRE_CAT = { "MALAXEURS": 0, "POMPES": 1, "GROUPES ÉLECTROGÈNES": 2 };

  const sansAccent = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const mots = (s) => sansAccent(s).split(" ").filter(Boolean);
  const parc = () => (window.FTSParc ? FTSParc.toutes().filter((m) => m.statut === "EN SERVICE") : []);

  // Nom court dans une centrale : "MA12 HUGO" → "MA12", "GROUPE ÉLECTROGÈNE HUGO" → "GE"
  function nomCourt(m, prenom) {
    let n = String(m.nom).split(/\s+/).filter((w) => sansAccent(w) !== sansAccent(prenom)).join(" ");
    if (/^GROUPE/.test(sansAccent(n))) n = "GE";
    return n;
  }
  // Prénom commun aux noms des machines du chef ("HUGO", "FRED", "CÉDRIC"),
  // gardé avec ses accents tel qu'écrit dans le Parc.
  function prenomCommun(membres) {
    const premier = String(membres[0].nom).split(/\s+/);
    const commun = premier.filter((w) => membres.every((x) => mots(x.nom).includes(sansAccent(w))));
    if (commun.length) return commun[commun.length - 1];
    const chef = mots(membres[0].chef);
    return premier.find((w) => chef.includes(sansAccent(w))) || "";
  }
  function estCentrale(m) {
    if (!CAT_CENTRALE.includes(m.categorie)) return false;
    if (m.chef) return true;
    if (m.categorie === "MALAXEURS") return true;
    return /PH15|TECHNIWELL/.test(sansAccent(m.nom));
  }

  /** Ligne (groupe) d'une machine du parc */
  function groupeDeMachine(m) {
    if (m.categorie === "PIEUX (PTC)") return { cle: "M|" + m.numero, libelle: m.nom, sous: "", section: "pieux" };
    if (m.categorie === "FOREUSES MICROPIEUX") return { cle: "M|" + m.numero, libelle: m.nom, sous: "", section: "foreuse" };
    if (estCentrale(m) && m.chef) {
      const k = mots(m.chef).sort().join(" ");
      const membres = parc().filter((x) => estCentrale(x) && x.chef && mots(x.chef).sort().join(" ") === k)
        .sort((a, b) => (ORDRE_CAT[a.categorie] - ORDRE_CAT[b.categorie]) || a.nom.localeCompare(b.nom));
      const prenom = prenomCommun(membres);
      const libelle = membres.map((x) => nomCourt(x, prenom)).join(" + ") + (prenom ? " " + prenom : "");
      return { cle: "C|" + k, libelle, sous: membres.length > 1 ? membres.map((x) => String(x.nom).replace(/^GROUPE [ÉE]LECTROG[ÈE]NE/i, "GE")).join(" · ") : "", section: "centrale" };
    }
    if (estCentrale(m)) return { cle: "M|" + m.numero, libelle: m.nom, sous: "", section: "centrale" };
    return { cle: "M|" + m.numero, libelle: m.nom, sous: "", section: "autre" };
  }

  /**
   * Ligne d'une machine telle que pointée dans le Sheet Matériel.
   * @param {string} nom     colonne Machine
   * @param {string} numero  colonne N° machine (peut être vide sur les anciens rapports)
   * @param {string} ftsLoc  colonne FTS/LOC
   * @param {string} chef    nom du chef (pour résoudre les anciens noms)
   */
  function groupeDePointage(nom, numero, ftsLoc, chef) {
    const P = window.FTSParc;
    let m = P ? (numero && P.parNumero(numero)) || P.parNom(nom) : null;
    if (!m && P && P.resoudreAncienNom) {
      // Ancien nom (avant le référentiel) : "MA12 + PH15" → MA12 + PH15 du chef
      const r = P.resoudreAncienNom(nom, chef || "");
      if (r && r.length) {
        const g = r.map(groupeDeMachine);
        if (g.every((x) => x.cle === g[0].cle)) return g[0];
        m = r[0];
      }
    }
    if (m) return groupeDeMachine(m);
    if (String(ftsLoc || "").toUpperCase() === "LOC" || (P && P.estLocation && P.estLocation(nom))) {
      return { cle: "L|" + sansAccent(nom), libelle: String(nom || "").toUpperCase(), sous: "", section: "loc" };
    }
    return { cle: "X|" + sansAccent(nom), libelle: String(nom || "").toUpperCase() || "—", sous: "", section: "autre" };
  }

  /** Toutes les lignes du parc (même sans activité), dans l'ordre d'affichage */
  function lignesDuParc() {
    const vus = new Map();
    parc().forEach((m) => {
      const g = groupeDeMachine(m);
      if (!vus.has(g.cle)) vus.set(g.cle, g);
    });
    const ordre = (id) => SECTIONS.findIndex((x) => x.id === id);
    return [...vus.values()].sort((a, b) => (ordre(a.section) - ordre(b.section)) ||
      a.libelle.localeCompare(b.libelle, "fr", { numeric: true }));
  }

  /**
   * Statut d'une ligne pour un jour, à partir des statuts de ses machines :
   * une centrale en panne dès qu'une de ses machines l'est.
   */
  const PRIORITE = ["PANNE", "TRAVAIL", "ARRET", "TRANSPORT"];
  function statutDuJour(statuts) {
    const s = statuts.map((x) => String(x || "").toUpperCase());
    return PRIORITE.find((p) => s.includes(p)) || s[0] || "";
  }

  return { SECTIONS, groupeDeMachine, groupeDePointage, lignesDuParc, statutDuJour, sansAccent };
})();
window.FTSAteliers = FTSAteliers;
