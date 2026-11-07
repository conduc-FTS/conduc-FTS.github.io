/**
 * plan-acces.js — Plan d'accès du chantier (étape de la fiche de préparation).
 *
 * Données (prep.plan) : point GPS, précision, contact, instructions et
 * jusqu'à 3 vues (captures collées). Chaque vue garde son cadrage (zoom,
 * centre) et ses annotations ; les coordonnées des annotations sont
 * relatives à l'IMAGE (0 à 1), pour rester accrochées au fond de carte
 * quand on recadre. Les images elles-mêmes sont des fichiers à part dans
 * le dossier PREPARATION du chantier (vue.fichierId).
 *
 * Le même dessin (dessinerVue) sert à l'écran (éditeur) et au PDF : ce
 * qu'on voit est ce qui est imprimé.
 */
const FTSPlanAcces = (() => {
  const ETIQUETTES = ["ACCÈS PL", "ACCÈS VL", "STOCKAGE", "PARKING", "POINT D'EAU", "BASE VIE", "CHANTIER"];
  // Cadres du PDF (mm) quand les 3 vues sont présentes : sert aussi au format des cadres à l'écran
  const VUES = [
    { titre: "Vue de loin", l: 93, h: 80 },
    { titre: "Vue d'approche", l: 93, h: 80 },
    { titre: "Chantier", l: 190, h: 139 },
  ];
  const ROUGE = "#E3242B";

  function vueVide(i) { return { titre: VUES[i].titre, fichierId: "", w: 0, h: 0, zoom: 1, cx: 0.5, cy: 0.5, annots: [] }; }
  function planVide() { return { gps: "", precision: "", contact: "", adresse: "", instructions: "", vues: VUES.map((v, i) => vueVide(i)) }; }
  function normaliser(p) {
    const base = planVide();
    p = p || {};
    return {
      ...base, ...p,
      vues: base.vues.map((v, i) => ({ ...v, ...((p.vues && p.vues[i]) || {}), annots: (((p.vues && p.vues[i]) || {}).annots || []).slice() })),
    };
  }
  const aImage = (v) => !!(v && (v.fichierId || v.w));
  function vide(plan) { return !plan || (!lireGps(plan.gps) && !plan.vues.some(aImage)); }

  // ── GPS ──────────────────────────────────────────────────────────
  const dans = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  /**
   * Lit un point GPS collé : « 46.7712, 1.7208 », « 46,7712 1,7208 »,
   * un lien Google Maps (…/@46.77,1.72,17z ou ?q=46.77,1.72 ou !3d…!4d…),
   * ou des degrés-minutes-secondes (46°46'16.3"N 1°43'14.9"E).
   * @returns {{lat:number, lng:number}|null}
   */
  function lireGps(texte) {
    const t = String(texte || "").trim();
    if (!t) return null;
    let m = t.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (m && dans(+m[1], +m[2])) return { lat: +m[1], lng: +m[2] };
    m = t.match(/[?&](?:q|query|destination|ll)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i);
    if (m && dans(+m[1], +m[2])) return { lat: +m[1], lng: +m[2] };
    m = t.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (m && dans(+m[1], +m[2])) return { lat: +m[1], lng: +m[2] };
    // Degrés, minutes, secondes
    const dms = [...t.matchAll(/(\d+(?:[.,]\d+)?)\s*°\s*(?:(\d+(?:[.,]\d+)?)\s*['’′]\s*)?(?:(\d+(?:[.,]\d+)?)\s*(?:"|''|”|″)\s*)?([NSEOW])/gi)];
    if (dms.length === 2) {
      const val = (x) => {
        const n = (s) => (s ? parseFloat(s.replace(",", ".")) : 0);
        const v = n(x[1]) + n(x[2]) / 60 + n(x[3]) / 3600;
        return /[SOW]/i.test(x[4]) ? -v : v;
      };
      const a = dms.find((x) => /[NS]/i.test(x[4])), b = dms.find((x) => /[EOW]/i.test(x[4]));
      if (a && b && dans(val(a), val(b))) return { lat: val(a), lng: val(b) };
    }
    // Deux nombres décimaux (virgule ou point décimal)
    const nums = t.replace(/(\d),(\d)/g, (s, x, y) => (t.includes(".") ? s : `${x}.${y}`)).match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 2) {
      const lat = parseFloat(nums[0]), lng = parseFloat(nums[1]);
      if (dans(lat, lng) && String(nums[0]).includes(".")) return { lat, lng };
    }
    return null;
  }
  const texteGps = (g) => (g ? `${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}` : "");
  const urlItineraire = (g) => `https://www.google.com/maps/dir/?api=1&destination=${g.lat.toFixed(6)},${g.lng.toFixed(6)}`;
  const urlCarte = (g) => `https://www.google.com/maps/search/?api=1&query=${g.lat.toFixed(6)},${g.lng.toFixed(6)}`;

  /** QR code (image PNG) — librairie locale lib/qrcode/qrcode.js */
  function qrDataUrl(texte, px = 600) {
    if (typeof qrcode !== "function") throw new Error("Générateur de QR code non chargé : recharge la page.");
    const q = qrcode(0, "M");
    q.addData(texte);
    q.make();
    const n = q.getModuleCount(), marge = 2, cell = Math.max(1, Math.floor(px / (n + marge * 2)));
    const c = document.createElement("canvas");
    c.width = c.height = cell * (n + marge * 2);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) ctx.fillRect((k + marge) * cell, (r + marge) * cell, cell, cell);
    return c.toDataURL("image/png");
  }

  // ── Dessin d'une vue ─────────────────────────────────────────────
  /**
   * Géométrie de l'image dans un cadre W × H (px) : l'image couvre le
   * cadre (comme background-size: cover), agrandie par vue.zoom, centrée
   * sur (cx, cy) — centre ramené pour ne jamais laisser de blanc.
   */
  function geometrie(vue, W, H) {
    if (!vue.w || !vue.h) return null;
    const s = Math.max(W / vue.w, H / vue.h) * Math.max(1, vue.zoom || 1);
    const iw = vue.w * s, ih = vue.h * s;
    const demiX = W / 2 / iw, demiY = H / 2 / ih;
    const cx = Math.min(1 - demiX, Math.max(demiX, vue.cx == null ? 0.5 : vue.cx));
    const cy = Math.min(1 - demiY, Math.max(demiY, vue.cy == null ? 0.5 : vue.cy));
    return { s, iw, ih, cx, cy, ox: W / 2 - cx * iw, oy: H / 2 - cy * ih };
  }
  const versCadre = (g, u, v) => [g.ox + u * g.iw, g.oy + v * g.ih];
  const versImage = (g, x, y) => [(x - g.ox) / g.iw, (y - g.oy) / g.ih];

  function boiteTexte(ctx, texte, x, y, k, style) {
    const fs = 3.1 * k, pad = 1.3 * k;
    ctx.font = `bold ${fs}px Arial, Helvetica, sans-serif`;
    const lignes = String(texte || "").split("\n");
    const w = Math.max(...lignes.map((l) => ctx.measureText(l).width)) + pad * 2;
    const h = lignes.length * fs * 1.2 + pad * 1.4;
    const bx = x - w / 2, by = y - h / 2;
    if (style === "lab") {
      ctx.fillStyle = "#fff"; ctx.fillRect(bx, by, w, h);
      ctx.lineWidth = 0.45 * k; ctx.strokeStyle = "#000"; ctx.strokeRect(bx, by, w, h);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    lignes.forEach((l, i) => {
      const ly = by + pad * 0.7 + fs * 1.2 * (i + 0.5);
      if (style !== "lab") { ctx.lineWidth = 0.9 * k; ctx.strokeStyle = "#fff"; ctx.lineJoin = "round"; ctx.strokeText(l, x, ly); }
      ctx.fillStyle = style === "lab" ? "#000" : ROUGE; ctx.fillText(l, x, ly);
    });
    return [bx, by, w, h];
  }
  /** Repère rouge façon Google Maps : la pointe est sur le point */
  function repere(ctx, x, y, k) {
    const r = 2.6 * k, h = 8 * k;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 1.2 * k; ctx.shadowOffsetY = 0.4 * k;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x - r * 0.35, y - h * 0.35, x - r, y - h + r * 1.25, x - r, y - h + r);
    ctx.arc(x, y - h + r, r, Math.PI, 0);
    ctx.bezierCurveTo(x + r, y - h + r * 1.25, x + r * 0.35, y - h * 0.35, x, y);
    ctx.fillStyle = ROUGE; ctx.fill();
    ctx.restore();
    ctx.lineWidth = 0.3 * k; ctx.strokeStyle = "#A50E15"; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y - h + r, r * 0.38, 0, Math.PI * 2); ctx.fillStyle = "#6E0A0E"; ctx.fill();
    return [x - r, y - h, r * 2, h];
  }
  function fleche(ctx, x1, y1, x2, y2, k) {
    const a = Math.atan2(y2 - y1, x2 - x1), t = 3.2 * k;
    ctx.strokeStyle = ROUGE; ctx.fillStyle = ROUGE; ctx.lineWidth = 0.9 * k; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 - Math.cos(a) * t * 0.8, y2 - Math.sin(a) * t * 0.8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - t * Math.cos(a - 0.45), y2 - t * Math.sin(a - 0.45));
    ctx.lineTo(x2 - t * Math.cos(a + 0.45), y2 - t * Math.sin(a + 0.45));
    ctx.closePath(); ctx.fill();
  }
  /**
   * Dessine une vue (image cadrée + annotations) dans un cadre W × H.
   * @param {number} k  pixels par millimètre du PDF (tailles des étiquettes)
   * @returns {Array} boîtes [x, y, w, h] de chaque annotation (pour cliquer dessus)
   */
  function dessinerVue(ctx, img, vue, W, H, k, options = {}) {
    ctx.fillStyle = "#f3f4f6"; ctx.fillRect(0, 0, W, H);
    const g = img ? geometrie(vue, W, H) : null;
    const boites = [];
    if (!g) return boites;
    ctx.drawImage(img, g.ox, g.oy, g.iw, g.ih);
    (vue.annots || []).forEach((a, i) => {
      const [x, y] = versCadre(g, a.u, a.v);
      let b;
      if (a.t === "zone") {
        const [x2, y2] = versCadre(g, a.u2, a.v2);
        const zx = Math.min(x, x2), zy = Math.min(y, y2), zw = Math.abs(x2 - x), zh = Math.abs(y2 - y);
        ctx.fillStyle = "rgba(253,202,1,.35)"; ctx.fillRect(zx, zy, zw, zh);
        ctx.lineWidth = 0.6 * k; ctx.strokeStyle = "#E8A900"; ctx.strokeRect(zx, zy, zw, zh);
        b = [zx, zy, zw, zh];
      } else if (a.t === "fleche") {
        const [x2, y2] = versCadre(g, a.u2, a.v2);
        fleche(ctx, x, y, x2, y2, k);
        b = [Math.min(x, x2) - 2 * k, Math.min(y, y2) - 2 * k, Math.abs(x2 - x) + 4 * k, Math.abs(y2 - y) + 4 * k];
        b.ligne = [x, y, x2, y2];
      } else if (a.t === "pin") b = repere(ctx, x, y, k);
      else b = boiteTexte(ctx, a.texte, x, y, k, a.t === "lab" ? "lab" : "texte");
      boites[i] = b;
    });
    // Sélection (éditeur seulement)
    if (options.selection != null && boites[options.selection]) {
      const [bx, by, bw, bh] = boites[options.selection];
      ctx.save(); ctx.setLineDash([5, 4]); ctx.lineWidth = 2; ctx.strokeStyle = "#2F6FED";
      ctx.strokeRect(bx - 4, by - 4, bw + 8, bh + 8); ctx.restore();
    }
    return boites;
  }

  // ── PDF A4 ───────────────────────────────────────────────────────
  /** Cadres des vues présentes (mm), selon celles qui ont une image */
  function cadres(plan) {
    const haut = [0, 1].filter((i) => aImage(plan.vues[i]));
    const bas = aImage(plan.vues[2]);
    const Y = 64, FIN = 287, L = 190, G = 4;
    const out = [];
    const hHaut = bas ? 80 : FIN - Y;
    haut.forEach((i, j) => {
      const w = haut.length === 2 ? (L - G) / 2 : L;
      out.push({ i, x: 10 + j * (w + G), y: Y, w, h: hHaut });
    });
    if (bas) { const y = haut.length ? Y + 80 + G : Y; out.push({ i: 2, x: 10, y, w: L, h: FIN - y }); }
    return out;
  }
  function chargerImage(src) {
    return new Promise((ok, ko) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ko(new Error("Image illisible")); im.src = src; });
  }
  /**
   * @param {object} o { plan, code, nom, adresse, contact, logoSrc, images: [HTMLImageElement|null] }
   * @returns {Promise<{blob: Blob, pages: string[]}>}  pages = aperçu JPEG de la page
   */
  async function pdf(o) {
    if (!window.jspdf) throw new Error("Outil PDF non chargé : recharge la page.");
    const { jsPDF } = window.jspdf;
    const plan = o.plan;
    const PX = 8; // pixels par mm (≈ 200 dpi)
    const page = document.createElement("canvas");
    page.width = 210 * PX; page.height = 297 * PX;
    const c = page.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, page.width, page.height);
    const mm = (v) => v * PX;
    const cadre = (x, y, w, h, gris) => { if (gris) { c.fillStyle = "#c8c8c8"; c.fillRect(mm(x), mm(y), mm(w), mm(h)); } c.lineWidth = mm(0.3); c.strokeStyle = "#000"; c.strokeRect(mm(x), mm(y), mm(w), mm(h)); };
    const texte = (t, x, y, w, h, { taille = 2.6, gras = false, centre = false } = {}) => {
      let fs = taille;
      c.font = `${gras ? "bold " : ""}${mm(fs)}px Arial, Helvetica, sans-serif`;
      while (c.measureText(t).width > mm(w - 2) && fs > 1.6) { fs -= 0.1; c.font = `${gras ? "bold " : ""}${mm(fs)}px Arial, Helvetica, sans-serif`; }
      c.fillStyle = "#000"; c.textBaseline = "middle"; c.textAlign = centre ? "center" : "left";
      c.fillText(t, centre ? mm(x + w / 2) : mm(x + 1.5), mm(y + h / 2));
    };
    // En-tête (50 mm) : logo + titre, lignes d'infos, QR code
    cadre(10, 10, 150, 50);
    cadre(10, 10, 32, 26);
    if (o.logoSrc) {
      try {
        const logo = await chargerImage(o.logoSrc);
        const r = Math.min(28 / logo.width, 22 / logo.height);
        c.drawImage(logo, mm(10 + (32 - logo.width * r) / 2), mm(10 + (26 - logo.height * r) / 2), mm(logo.width * r), mm(logo.height * r));
      } catch (e) {}
    }
    cadre(42, 10, 118, 26);
    texte("PLAN D'ACCÈS", 42, 10, 118, 26, { taille: 8, gras: true, centre: true });
    const g = lireGps(plan.gps);
    const lignes = [
      [["N° DOSSIER", o.code, 28, 32], ["CHANTIER", o.nom, 24, 66]],
      [["ADRESSE", o.adresse, 28, 122]],
      [["POINT GPS", g ? texteGps(g) + (plan.precision ? ` (${plan.precision})` : "") : "", 28, 32], ["CONTACT", o.contact, 24, 66]],
      [["INSTRUCTIONS", plan.instructions || "", 28, 122]],
    ];
    lignes.forEach((ligne, r) => {
      let x = 10; const y = 36 + r * 6;
      ligne.forEach(([lib, val, wl, wv]) => {
        cadre(x, y, wl, 6, true); texte(lib, x, y, wl, 6, { taille: 2.3, gras: true });
        cadre(x + wl, y, wv, 6); texte(String(val || ""), x + wl, y, wv, 6, { taille: 2.4, gras: r === 0 && lib === "N° DOSSIER" });
        x += wl + wv;
      });
    });
    cadre(163, 10, 37, 50);
    if (g) {
      const qr = await chargerImage(qrDataUrl(urlItineraire(g)));
      c.drawImage(qr, mm(166.5), mm(12), mm(30), mm(30));
      texte("SCANNER POUR", 163, 43, 37, 5, { taille: 2.2, gras: true, centre: true });
      texte("L'ITINÉRAIRE", 163, 47.5, 37, 5, { taille: 2.2, gras: true, centre: true });
    } else texte("POINT GPS À RENSEIGNER", 163, 10, 37, 50, { taille: 2.1, centre: true });
    // Vues
    for (const f of cadres(plan)) {
      const v = plan.vues[f.i], img = o.images[f.i];
      const tmp = document.createElement("canvas");
      tmp.width = mm(f.w); tmp.height = mm(f.h);
      dessinerVue(tmp.getContext("2d"), img, v, tmp.width, tmp.height, PX);
      c.drawImage(tmp, mm(f.x), mm(f.y));
      cadre(f.x, f.y, f.w, f.h);
      const etiq = `${f.i + 1} · ${String(v.titre || VUES[f.i].titre).toUpperCase()}`;
      c.font = `bold ${mm(2.2)}px Arial, Helvetica, sans-serif`;
      const lw = c.measureText(etiq).width + mm(3);
      c.fillStyle = "#fff"; c.fillRect(mm(f.x), mm(f.y), lw, mm(4.2));
      c.lineWidth = mm(0.25); c.strokeStyle = "#000"; c.strokeRect(mm(f.x), mm(f.y), lw, mm(4.2));
      c.fillStyle = "#000"; c.textAlign = "left"; c.textBaseline = "middle"; c.fillText(etiq, mm(f.x + 1.5), mm(f.y + 2.1));
    }
    const img = page.toDataURL("image/jpeg", 0.9);
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    doc.addImage(img, "JPEG", 0, 0, 210, 297);
    doc.setProperties({ title: `${o.code} - Plan d'accès` });
    return { blob: doc.output("blob"), pages: [{ img, hMm: 297, pleinePage: true }] };
  }

  /** Empreinte du plan : sert à savoir s'il a changé depuis le dernier envoi */
  function empreinte(plan) {
    if (!plan) return "";
    return JSON.stringify([plan.gps, plan.precision, plan.contact, plan.adresse, plan.instructions,
      plan.vues.map((v) => [v.titre, v.fichierId, v.w, v.h, v.zoom, Math.round((v.cx || 0) * 1000), Math.round((v.cy || 0) * 1000), v.annots, v.version || 0])]);
  }

  return {
    ETIQUETTES, VUES, planVide, vueVide, normaliser, vide, aImage,
    lireGps, texteGps, urlItineraire, urlCarte, qrDataUrl,
    geometrie, versCadre, versImage, dessinerVue, cadres, pdf, chargerImage, empreinte,
  };
})();

if (typeof window !== "undefined") window.FTSPlanAcces = FTSPlanAcces;
if (typeof module !== "undefined") module.exports = FTSPlanAcces;
