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

  // ── Cartes automatiques (IGN Géoplateforme, gratuit, sans clé) ────
  // Vue de loin = Plan IGN, vue d'approche = photo aérienne ; centrées sur le point GPS.
  const PLAN_IGN = { layer: "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", fmt: "image/png" };
  const PHOTO = { layer: "ORTHOIMAGERY.ORTHOPHOTOS", fmt: "image/jpeg" };
  const ROUTES = { layer: "TRANSPORTNETWORKS.ROADS", fmt: "image/png" };
  const NOMS = { layer: "GEOGRAPHICALNAMES.NAMES", fmt: "image/png" };
  const COUCHES = {
    plan: { calques: [PLAN_IGN], min: 6, max: 18, lib: "Plan" },
    ortho: { calques: [PHOTO], min: 6, max: 19, lib: "Photo" },
    mixte: { calques: [PHOTO, ROUTES, NOMS], min: 10, max: 18, lib: "Photo + rues" },
  };
  const AUTO_DEFAUT = [{ type: "plan", z: 11 }, { type: "mixte", z: 17 }];
  const TAILLE_AUTO = { W: 1200, H: Math.round(1200 * VUES[0].h / VUES[0].l) };
  /** Point GPS → pixels « monde » Web Mercator au zoom z (tuiles de 256 px) */
  function versMonde(lat, lng, z) {
    const n = 256 * Math.pow(2, z), r = (lat * Math.PI) / 180;
    return [((lng + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
  }
  const urlTuile = (c, z, x, y) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${c.layer}&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=${encodeURIComponent(c.fmt)}`;
  // ── Tuiles : mémoire + délai maxi ──
  // Les serveurs IGN n'autorisent pas le navigateur à garder les tuiles :
  // sans mémoire, chaque changement de zoom ou de type retéléchargeait
  // tout. On les garde donc ici le temps de la session (≈ 1 000 tuiles).
  const MEMOIRE_MAX = 1000, DELAI_TUILE = 4000, ABANDON_TUILE = 30000;
  const memoireTuiles = new Map(); // url → Promise<Image|null> (chargement complet)
  let premierPlanEnCours = 0;      // cartes demandées par l'utilisateur en cours
  /** Chargement d'une tuile, gardé en mémoire (sans délai maxi, abandon à 30 s) */
  function chargerTuile(url) {
    if (memoireTuiles.has(url)) {
      const p = memoireTuiles.get(url);
      memoireTuiles.delete(url); memoireTuiles.set(url, p); // remonte en tête (plus récente)
      return p;
    }
    const p = new Promise((fin) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      const t = setTimeout(() => { im.onload = im.onerror = null; im.src = ""; fin(null); }, ABANDON_TUILE);
      im.onload = () => { clearTimeout(t); fin(im); };
      im.onerror = () => { clearTimeout(t); fin(null); };
      im.src = url;
    }).then((im) => { if (!im) memoireTuiles.delete(url); return im; }); // échec : on réessaiera plus tard
    memoireTuiles.set(url, p);
    while (memoireTuiles.size > MEMOIRE_MAX) memoireTuiles.delete(memoireTuiles.keys().next().value);
    return p;
  }
  /**
   * Tuile pour une carte affichée : une tuile lente ne bloque plus toute la
   * carte, après 4 s on dessine sans elle (case grise). Elle continue de se
   * charger en arrière-plan : au clic suivant, elle sera là.
   */
  function tuileUrl(url) {
    return Promise.race([chargerTuile(url), new Promise((fin) => setTimeout(() => fin(null), DELAI_TUILE))]);
  }
  /** Liste des tuiles (par calque, dans l'ordre de superposition) d'une carte */
  function tuilesCarte({ lat, lng, z, type, W, H }) {
    const c = COUCHES[type] || COUCHES.plan;
    const [cx, cy] = versMonde(lat, lng, z);
    const x0 = cx - W / 2, y0 = cy - H / 2, n = Math.pow(2, z);
    return { x0, y0, calques: c.calques.map((calque) => {
      const l = [];
      for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W) / 256); tx++)
        for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H) / 256); ty++)
          if (ty >= 0 && ty < n) l.push({ tx, ty, url: urlTuile(calque, z, ((tx % n) + n) % n, ty) });
      return l;
    }) };
  }
  // Préchargement discret des réglages voisins (zoom −/+ et autres types),
  // pour que le prochain clic soit instantané. Il se met en pause dès que
  // l'utilisateur demande une carte, et ne lance que 6 tuiles à la fois.
  const filePrechargement = [];
  let prechargementsActifs = 0;
  function pomperPrechargement() {
    while (!premierPlanEnCours && prechargementsActifs < 6 && filePrechargement.length) {
      const url = filePrechargement.shift();
      if (memoireTuiles.has(url)) continue;
      prechargementsActifs++;
      chargerTuile(url).then(() => { prechargementsActifs--; pomperPrechargement(); });
    }
  }
  function precharger(o) {
    const voisins = [{ ...o, z: o.z + 1 }, { ...o, z: o.z - 1 },
      ...Object.keys(COUCHES).filter((t) => t !== o.type).map((t) => ({ ...o, type: t }))];
    filePrechargement.length = 0;
    voisins.forEach((v) => {
      const cv = COUCHES[v.type];
      if (v.z < cv.min || v.z > cv.max) return;
      tuilesCarte(v).calques.forEach((l) => l.forEach((t) => filePrechargement.push(t.url)));
    });
    setTimeout(pomperPrechargement, 400);
  }
  /**
   * Carte centrée sur le point : assemble les tuiles IGN dans un canvas W × H.
   * Tous les calques sont chargés en même temps (avant : l'un après l'autre).
   * @returns {Promise<HTMLCanvasElement>}
   */
  async function carteIGN({ lat, lng, z, type, W = TAILLE_AUTO.W, H = TAILLE_AUTO.H }) {
    const { x0, y0, calques } = tuilesCarte({ lat, lng, z, type, W, H });
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#e5e7eb"; ctx.fillRect(0, 0, W, H);
    let ok = 0;
    premierPlanEnCours++;
    let images;
    try {
      images = await Promise.all(calques.map((l) => Promise.all(l.map((t) => tuileUrl(t.url)))));
    } finally {
      premierPlanEnCours--;
    }
    // Calques superposés dans l'ordre (photo, puis routes, puis noms des rues)
    calques.forEach((l, k) => l.forEach((t, j) => {
      const im = images[k][j];
      if (im) { ok++; ctx.drawImage(im, Math.round(t.tx * 256 - x0), Math.round(t.ty * 256 - y0)); }
    }));
    if (!ok) throw new Error("Carte IGN indisponible (connexion internet ?)");
    precharger({ lat, lng, z, type, W, H });
    // Mention obligatoire de la source
    ctx.font = "bold 15px Arial, sans-serif";
    const t = "© IGN – Géoplateforme", tw = ctx.measureText(t).width;
    ctx.fillStyle = "rgba(255,255,255,.8)"; ctx.fillRect(W - tw - 14, H - 24, tw + 14, 24);
    ctx.fillStyle = "#333"; ctx.textBaseline = "middle"; ctx.fillText(t, W - tw - 7, H - 12);
    return cv;
  }
  /** Point de la carte automatique (u, v de 0 à 1) → coordonnées GPS */
  function versGps(auto, u, v, W = TAILLE_AUTO.W, H = TAILLE_AUTO.H) {
    const [cx, cy] = versMonde(auto.lat, auto.lng, auto.z), n = 256 * Math.pow(2, auto.z);
    const x = cx - W / 2 + u * W, y = cy - H / 2 + v * H;
    return { lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI, lng: (x / n) * 360 - 180 };
  }
  /**
   * Adresse → point GPS (géocodage IGN / Base Adresse Nationale, gratuit, sans clé).
   * @returns {Promise<{lat, lng, label, precis: boolean}|null>}  precis = numéro ou rue trouvés
   */
  async function geocoder(adresse) {
    const q = String(adresse || "").replace(/—/g, " ").trim();
    if (q.length < 5) return null;
    const res = await fetch(`https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=1`);
    if (!res.ok) throw new Error(`Recherche d'adresse impossible (${res.status})`);
    const f = ((await res.json()).features || [])[0];
    if (!f || !f.geometry) return null;
    const [lng, lat] = f.geometry.coordinates, pr = f.properties || {};
    return { lat, lng, label: pr.label || q, score: pr.score || 0, precis: (pr.type === "housenumber" || pr.type === "street") && (pr.score || 0) >= 0.5 };
  }
  /**
   * Recalcule la place des annotations quand la carte automatique change
   * de point ou de zoom (elles restent au même endroit sur le terrain).
   */
  function deplacerAnnots(annots, avant, apres, W = TAILLE_AUTO.W, H = TAILLE_AUTO.H) {
    const [ax, ay] = versMonde(avant.lat, avant.lng, avant.z), [bx, by] = versMonde(apres.lat, apres.lng, apres.z);
    const k = Math.pow(2, apres.z - avant.z);
    const conv = (u, v) => [((ax - W / 2 + u * W) * k - (bx - W / 2)) / W, ((ay - H / 2 + v * H) * k - (by - H / 2)) / H];
    return annots.map((a) => {
      if (a.t === "pin" && a.auto) return { ...a, u: 0.5, v: 0.5 };
      const [u, v] = conv(a.u, a.v), b = { ...a, u, v };
      if (a.u2 != null) { const [u2, v2] = conv(a.u2, a.v2); b.u2 = u2; b.v2 = v2; }
      return b;
    });
  }

  /** Empreinte du plan : sert à savoir s'il a changé depuis le dernier envoi */
  function empreinte(plan) {
    if (!plan) return "";
    return JSON.stringify([plan.gps, plan.precision, plan.contact, plan.adresse, plan.instructions,
      plan.vues.map((v) => [v.titre, v.fichierId, v.w, v.h, v.zoom, Math.round((v.cx || 0) * 1000), Math.round((v.cy || 0) * 1000), v.annots, v.version || 0, v.auto || null])]);
  }

  return {
    ETIQUETTES, VUES, planVide, vueVide, normaliser, vide, aImage,
    lireGps, texteGps, urlItineraire, urlCarte, qrDataUrl,
    COUCHES, AUTO_DEFAUT, TAILLE_AUTO, carteIGN, deplacerAnnots, versGps, geocoder,
    geometrie, versCadre, versImage, dessinerVue, cadres, pdf, chargerImage, empreinte,
  };
})();

if (typeof window !== "undefined") window.FTSPlanAcces = FTSPlanAcces;
if (typeof module !== "undefined") module.exports = FTSPlanAcces;
