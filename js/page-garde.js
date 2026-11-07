/**
 * page-garde.js — Page de garde du dossier papier (micropieux).
 *
 * Reprend l'onglet « PdG Mpx » de l'Excel : infos du chantier en haut,
 * deux colonnes de cases à cocher à la main (documents / points faits),
 * observations, conducteur de travaux. Dessinée directement en A4 (canvas)
 * puis mise en PDF, comme le plan d'accès.
 */
const FTSPageGarde = (() => {
  const GAUCHE = ["NOTE DE CALCUL", "PLAN", "LISTE MATÉRIEL", "PPSPS", "IMPLANTATION", "MICROPIEUX D'ESSAI"];
  const DROITE = ["ADMINISTRATIF", "POINT D'EAU", "DICT / RÉSEAUX", "ÉVAC. DES BOUES", "ÉVAC. DES DÉCHETS", "SONDAGE"];

  function chargerImage(src) {
    return new Promise((ok, ko) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ko(new Error("Image illisible")); im.src = src; });
  }

  /**
   * @param {object} o { code, nom, adresse, commune, equipe, conducteur, telConducteur, logoSrc }
   * @returns {Promise<{blob: Blob, pages: Array}>}
   */
  async function pdf(o) {
    if (!window.jspdf) throw new Error("Outil PDF non chargé : recharge la page.");
    const PX = 8; // pixels par mm
    const page = document.createElement("canvas");
    page.width = 210 * PX; page.height = 297 * PX;
    const c = page.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, page.width, page.height);
    const mm = (v) => v * PX;
    const police = (t, gras) => `${gras ? "bold " : ""}${mm(t)}px Arial, Helvetica, sans-serif`;
    const cadre = (x, y, w, h, { gris = false, ep = 0.35 } = {}) => {
      if (gris) { c.fillStyle = "#c8c8c8"; c.fillRect(mm(x), mm(y), mm(w), mm(h)); }
      c.lineWidth = mm(ep); c.strokeStyle = "#000"; c.strokeRect(mm(x), mm(y), mm(w), mm(h));
    };
    const texte = (t, x, y, w, h, { taille = 4, gras = false, centre = false } = {}) => {
      let fs = taille;
      c.font = police(fs, gras);
      while (c.measureText(t).width > mm(w - 4) && fs > 2) { fs -= 0.1; c.font = police(fs, gras); }
      c.fillStyle = "#000"; c.textBaseline = "middle"; c.textAlign = centre ? "center" : "left";
      c.fillText(t, centre ? mm(x + w / 2) : mm(x + 3), mm(y + h / 2));
    };

    // En-tête : logo + titre
    cadre(15, 15, 180, 30, { ep: 0.5 });
    cadre(15, 15, 46, 30, { ep: 0.5 });
    if (o.logoSrc) {
      try {
        const logo = await chargerImage(o.logoSrc);
        const r = Math.min(40 / logo.width, 25 / logo.height);
        c.drawImage(logo, mm(15 + (46 - logo.width * r) / 2), mm(15 + (30 - logo.height * r) / 2), mm(logo.width * r), mm(logo.height * r));
      } catch (e) {}
    }
    texte("DOSSIER CHANTIER", 61, 16, 134, 17, { taille: 9, gras: true, centre: true });
    texte("MICROPIEUX", 61, 31, 134, 11, { taille: 5.5, gras: true, centre: true });

    // Infos du chantier
    let y = 53;
    const ligne = (lib, val, h = 14, opt = {}) => {
      cadre(15, y, 50, h, { gris: true }); texte(lib, 15, y, 50, h, { taille: 3.6, gras: true });
      cadre(65, y, 130, h); texte(String(val || ""), 65, y, 130, h, { taille: opt.taille || 4.6, gras: !!opt.gras });
      y += h;
    };
    ligne("N° DOSSIER :", o.code, 12, { taille: 6, gras: true });
    ligne("CHANTIER :", o.nom, 10, { taille: 4.2, gras: true });
    cadre(15, y, 50, 14, { gris: true }); texte("ADRESSE :", 15, y, 50, 14, { taille: 3.6, gras: true });
    cadre(65, y, 130, 14); texte(String(o.adresse || ""), 65, y + 0.5, 130, 6.5, { taille: 4 }); texte(String(o.commune || ""), 65, y + 7, 130, 6.5, { taille: 4 });
    y += 14;
    ligne("ÉQUIPE :", o.equipe, 10, { taille: 4.2, gras: true });

    // Cases à cocher (à la main)
    y += 7;
    // Chaque case : le libellé et la case à cocher, puis une ligne pour écrire un mot si besoin
    const hL = 17, hHaut = 8.5, case_ = 6.5;
    const colonne = (x, w, libs) => libs.forEach((lib, i) => {
      const yy = y + i * hL;
      cadre(x, yy, w, hL);
      texte(lib, x, yy + 0.5, w - case_ - 6, hHaut, { taille: 3.8, gras: true });
      cadre(x + w - case_ - 3.5, yy + 1.5, case_, case_, { ep: 0.45 });
      c.save(); c.setLineDash([mm(1), mm(1)]); c.lineWidth = mm(0.2); c.strokeStyle = "#888";
      c.beginPath(); c.moveTo(mm(x + 3), mm(yy + hL - 2.5)); c.lineTo(mm(x + w - 3), mm(yy + hL - 2.5)); c.stroke(); c.restore();
    });
    colonne(15, 87, GAUCHE);
    colonne(108, 87, DROITE);
    y += GAUCHE.length * hL + 7;

    // Observations (lignes pour écrire)
    const hObs = 297 - 15 - 18 - 6 - y;
    cadre(15, y, 180, 9, { gris: true }); texte("OBSERVATIONS :", 15, y, 180, 9, { taille: 4, gras: true });
    cadre(15, y + 9, 180, hObs - 9);
    c.save(); c.setLineDash([mm(1), mm(1)]); c.lineWidth = mm(0.2); c.strokeStyle = "#777";
    for (let ly = y + 9 + 10; ly < y + hObs - 3; ly += 10) { c.beginPath(); c.moveTo(mm(18), mm(ly)); c.lineTo(mm(192), mm(ly)); c.stroke(); }
    c.restore();

    // Conducteur de travaux
    const yc = 297 - 15 - 18;
    cadre(15, yc, 70, 18, { gris: true }); texte("CONDUCTEUR DE TRAVAUX :", 15, yc, 70, 18, { taille: 4, gras: true });
    cadre(85, yc, 65, 18); texte(String(o.conducteur || ""), 85, yc, 65, 18, { taille: 4.6, gras: true });
    cadre(150, yc, 45, 18); texte(String(o.telConducteur || ""), 150, yc, 45, 18, { taille: 4.4, centre: true });

    const img = page.toDataURL("image/jpeg", 0.92);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    doc.addImage(img, "JPEG", 0, 0, 210, 297);
    doc.setProperties({ title: `${o.code} - Page de garde` });
    return { blob: doc.output("blob"), pages: [{ img, hMm: 297, pleinePage: true }] };
  }

  return { GAUCHE, DROITE, pdf };
})();

if (typeof window !== "undefined") window.FTSPageGarde = FTSPageGarde;
if (typeof module !== "undefined") module.exports = FTSPageGarde;
