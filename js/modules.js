/**
 * modules.js — qui voit quels modules de la Supervision.
 *
 * Règles (Clément, 07-09/11/2026) :
 *  - seule la liste ENCADREMENT de Personnel FTS (actif, avec e-mail) a accès
 *    à la Supervision ; le personnel chantier voit « Réservé à l'encadrement » ;
 *  - chacun se connecte avec SON compte Google (adresse pro @fts-btp.fr) :
 *    l'appli sait qui il est, plus besoin de « Je suis » ;
 *  - les modules visibles dépendent du poste (défauts ci-dessous). Le lot 2
 *    ajoutera les réglages faits par conduc.fts (classeur à part, lecture
 *    seule pour l'encadrement) : ils viendront remplacer ces défauts ;
 *  - le compte propriétaire du Drive (conduc.fts) voit tout, page Accès comprise.
 *
 * ATTENTION : masquer un module n'est PAS une protection des données. La
 * vraie protection reste le partage du Drive (écran Accès Drive).
 *
 * Utilisation (pages bureau) :
 *   FTSModules.appliquer({ module: "preparation" })  // après la connexion
 *   FTSModules.autorise("stats") · FTSModules.moi() · FTSModules.MODULES
 * Nécessite auth.js, drive.js (facultatif) et personnel.js.
 */
const FTSModules = (() => {
  const MODULES = [
    { id: "overview", lib: "Vue d'ensemble" },
    { id: "stats", lib: "Statistiques" },
    { id: "preparation", lib: "Préparation" },
    { id: "archives", lib: "Archives" },
    { id: "documents", lib: "Documents" },
    { id: "ouverture", lib: "Ouverture de chantier" },
    { id: "pointMat", lib: "Pointage matériel" },
    { id: "pointPers", lib: "Pointage personnel" },
    { id: "personnel", lib: "Personnel FTS" },
    { id: "parc", lib: "Parc matériel" },
  ];
  const TOUS = MODULES.map((m) => m.id);
  const SAUF = (...ex) => TOUS.filter((m) => !ex.includes(m));
  // Modules par défaut de chaque poste d'encadrement (validés le 07/11/2026 ;
  // Président, BE et assistante : proposition, à ajuster au lot 2)
  const DEFAUTS = {
    "CONDUCTEUR DE TRAVAUX PRINCIPAL": SAUF("ouverture"),
    "CONDUCTEUR DE TRAVAUX": SAUF("ouverture"),
    "DIRECTRICE TRAVAUX": SAUF("ouverture"),
    "DIRECTEUR TRAVAUX": SAUF("ouverture"),
    "CHARGÉ D'AFFAIRES": ["overview", "stats", "ouverture"],
    "CHARGÉE D'AFFAIRES": ["overview", "stats", "ouverture"],
    "DIRECTEUR COMMERCIAL": ["overview", "stats", "ouverture"],
    "DIRECTRICE COMMERCIALE": ["overview", "stats", "ouverture"],
    "PRÉSIDENT": TOUS,
    "PRÉSIDENT DIRECTEUR GÉNÉRAL": TOUS,
    "DIRECTEUR BUREAU D'ÉTUDES": ["overview", "stats", "preparation", "archives", "documents"],
    "RESPONSABLE MATÉRIEL": ["overview", "preparation", "pointMat", "parc"],
    "RESPONSABLE D'ATELIER": ["overview", "preparation", "pointMat", "parc"],
    "ASSISTANTE D'EXPLOITATION": ["overview", "documents", "pointMat", "pointPers", "personnel"],
  };
  const DEFAUT_INCONNU = ["overview", "stats"];
  // Qui peut créer un chantier (bouton « + Nouveau chantier ») : les conducteurs et la direction.
  // Les chargés d'affaires passeront par « Ouverture de chantier ».
  const CREENT_CHANTIER = ["CONDUCTEUR DE TRAVAUX PRINCIPAL", "CONDUCTEUR DE TRAVAUX", "DIRECTRICE TRAVAUX", "DIRECTEUR TRAVAUX", "PRÉSIDENT", "PRÉSIDENT DIRECTEUR GÉNÉRAL"];
  const CACHE = "fts_modules_v1";

  // ─── Réglages faits par conduc.fts (écran Accès › Modules) ─────────
  // Classeur « Accès Supervision FTS », propriété de conduc.fts, rangé HORS
  // de l'arborescence FTS (dans REFERENTIEL, l'encadrement en modification
  // pourrait le modifier : Drive ne permet pas de restreindre sous un droit
  // hérité). Partagé en LECTURE SEULE à l'encadrement. Deux onglets :
  //  - « Postes » : Poste | un module par colonne (oui / vide)
  //  - « Exceptions » : E-mail | Nom | un module par colonne (oui / non / vide = comme le poste)
  const NOM_REGLAGES = "Accès Supervision FTS";
  const CACHE_REGLAGES = "fts_modules_reglages_v1";
  const API = "https://www.googleapis.com";
  const ent = () => ({ Authorization: "Bearer " + FTSAuth.getToken() });
  const OUI = (v) => /^(oui|x|1|true)$/i.test(String(v || "").trim());
  const NON = (v) => /^(non|0|false)$/i.test(String(v || "").trim());

  async function trouverReglages() {
    for (const q of [`appProperties has { key='ftsRole' and value='accesSupervision' } and trashed = false`,
      `name = '${NOM_REGLAGES}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`]) {
      const r = await fetch(`${API}/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,ownedByMe,capabilities/canEdit)`, { headers: ent() });
      if (!r.ok) throw new Error(`Recherche des réglages : ${r.status}`);
      const f = ((await r.json()).files || [])[0];
      if (f) return f;
    }
    return null;
  }
  /** Lit les réglages ; null si le classeur n'existe pas encore (défauts du code). */
  async function lireReglages() {
    const f = await trouverReglages();
    if (!f) { try { localStorage.removeItem(CACHE_REGLAGES); } catch (e) {} return null; }
    const r = await fetch(`${API.replace("www", "sheets")}/v4/spreadsheets/${f.id}/values:batchGet?ranges=Postes!A1:Z&ranges=Exceptions!A1:Z`, { headers: ent() });
    if (!r.ok) throw new Error(`Lecture des réglages : ${r.status}`);
    const [postes, exc] = ((await r.json()).valueRanges || []).map((v) => v.values || []);
    const cols = (tete) => (tete || []).map((t) => (MODULES.find((m) => m.lib.toUpperCase() === String(t).trim().toUpperCase()) || {}).id || null);
    const reg = { id: f.id, postes: {}, exceptions: {} };
    if (postes && postes.length) {
      const c = cols(postes[0]);
      postes.slice(1).forEach((l) => { if (l[0]) reg.postes[String(l[0]).trim().toUpperCase()] = c.map((id, i) => (id && OUI(l[i]) ? id : null)).filter(Boolean); });
    }
    if (exc && exc.length) {
      const c = cols(exc[0]);
      exc.slice(1).forEach((l) => {
        if (!l[0]) return;
        const e = {};
        c.forEach((id, i) => { if (id && OUI(l[i])) e[id] = true; else if (id && NON(l[i])) e[id] = false; });
        reg.exceptions[mail(l[0])] = e;
      });
    }
    try { localStorage.setItem(CACHE_REGLAGES, JSON.stringify(reg)); } catch (e) {}
    return reg;
  }
  const reglagesCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_REGLAGES) || "null"); } catch (e) { return null; } };

  /** Modules d'une personne : défaut du poste (réglage ou code) puis ses exceptions. */
  function modulesPour(poste, email, reg) {
    const P = String(poste || "").toUpperCase();
    const base = reg && reg.postes && reg.postes[P] ? reg.postes[P] : DEFAUTS[P] || DEFAUT_INCONNU;
    const ex = (reg && reg.exceptions && reg.exceptions[mail(email)]) || {};
    return TOUS.filter((m) => (m in ex ? ex[m] : base.includes(m)));
  }

  // Gmail ignore les points : r.dupont@gmail.com = rdupont@gmail.com
  const mail = (s) => {
    const e = String(s || "").trim().toLowerCase();
    const m = e.match(/^([^@+]+)(?:\+[^@]*)?@(gmail\.com|googlemail\.com)$/);
    return m ? m[1].replace(/\./g, "") + "@gmail.com" : e;
  };
  const posteDe = (p) => (p.categorie === "ENCADREMENT" ? p.poste : p.fonctionEnc) || "";
  const esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };

  let etat = null;   // { statut: "proprio"|"encadrement"|"refuse"|"inconnu", email, personne, poste, modules: [] }
  let enCours = null;

  function lireCache() { try { return JSON.parse(localStorage.getItem(CACHE) || "null"); } catch (e) { return null; } }
  function ecrireCache(d) { try { localStorage.setItem(CACHE, JSON.stringify({ ...d, le: Date.now() })); } catch (e) {} }

  async function estProprietaire() {
    if (!window.FTSAuth || !FTSAuth.isSignedIn()) return false;
    try {
      const q = encodeURIComponent("name = 'DOSSIER CHANTIER' and mimeType = 'application/vnd.google-apps.folder' and 'me' in owners and trashed = false");
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, { headers: { Authorization: "Bearer " + FTSAuth.getToken() } });
      if (!r.ok) return null; // inconnu (réseau, session)
      return ((await r.json()).files || []).length > 0;
    } catch (e) { return null; }
  }

  /** Calcule les droits du compte connecté (mis en cache sur l'ordinateur). */
  async function calculer() {
    if (enCours) return enCours;
    enCours = (async () => {
      let email = "";
      try { const u = await FTSAuth.getUserInfo(); email = (u && u.email) || ""; } catch (e) {}
      if (!email && FTSAuth.emailMemorise) email = FTSAuth.emailMemorise() || "";
      const cle = mail(email);
      const proprio = await estProprietaire();
      if (proprio) return (etat = { statut: "proprio", email, personne: null, poste: "", modules: TOUS.slice() });
      const rp = window.FTSPersonnel ? await FTSPersonnel.charger({ rapide: true }).catch(() => null) : null;
      const lisible = rp && ["sheet", "liste", "cache"].includes(rp.source);
      if (!lisible) {
        // Pas d'accès du tout au classeur Personnel FTS (réservé à l'encadrement) :
        // ce compte ne fait pas partie de l'encadrement
        if (rp && rp.existe === false) return (etat = { statut: "refuse", email, personne: null, poste: "", modules: [] });
        // Erreur de lecture (réseau…) : dernière décision connue pour ce compte
        const c = lireCache();
        if (c && mail(c.email) === cle && c.statut !== "inconnu") return (etat = c);
        return (etat = { statut: "inconnu", email, personne: null, poste: "", modules: [] });
      }
      const p = FTSPersonnel.toutes().find((x) => x.email && mail(x.email) === cle);
      const enc = p && p.statut === "ACTIF" && (p.categorie === "ENCADREMENT" || !!p.fonctionEnc);
      if (!enc) return (etat = { statut: "refuse", email, personne: p ? { nom: p.nom, prenom: p.prenom } : null, poste: "", modules: [] });
      const poste = posteDe(p);
      let reg = null;
      try { reg = await lireReglages(); } catch (e) { console.warn("Réglages des modules illisibles, dernière copie utilisée :", e); reg = reglagesCache(); }
      return (etat = { statut: "encadrement", email, personne: { nom: p.nom, prenom: p.prenom }, poste, modules: modulesPour(poste, p.email, reg) });
    })();
    try { const r = await enCours; if (r.statut !== "inconnu") ecrireCache(r); return r; }
    finally { enCours = null; }
  }

  const autorise = (m, e = etat) => !!e && (e.statut === "proprio" || (e.statut === "encadrement" && (m === "overview" ? e.modules.includes("overview") : e.modules.includes(m))));
  /** Nom de la personne connectée (« Prénom NOM »), vide pour conduc.fts. */
  function moi() { const e = etat || lireCache(); return e && e.personne ? `${e.personne.prenom} ${e.personne.nom}`.trim() : ""; }

  // Lien des entrées de menu → module (Supervision et pages bureau)
  const VUE_MODULE = {
    "se-view-overview": "overview", "se-view-stats": "stats", "se-view-preparation": "preparation", "se-view-archives": "archives",
    "se-view-documents": "documents", "se-view-personnel": "personnel", "se-view-adresses": "personnel", "se-view-parc": "parc",
    "se-view-acces": "acces", "se-view-ouverture": "ouverture", materiel: "pointMat", personnel: "pointPers",
  };
  const moduleDuLien = (el) => {
    if (el.dataset.view) return VUE_MODULE[el.dataset.view];
    const h = el.getAttribute("href") || "";
    if (/recap-hebdo.*type=materiel/.test(h)) return "pointMat";
    if (/recap-hebdo.*type=personnel/.test(h)) return "pointPers";
    const m = h.match(/#(se-view-[a-z]+)/);
    if (m) return VUE_MODULE[m[1]];
    if (/supervision-encadrement\/index\.html$|^index\.html$/.test(h)) return "overview";
    return null;
  };
  const autoriseLien = (m, e) => m === "acces" ? !!e && e.statut === "proprio" : autorise(m, e);

  /** Masque les entrées de menu non autorisées (barre de gauche + onglets téléphone). */
  function filtrerMenu(e = etat) {
    if (!e || e.statut === "inconnu") return;
    if (!document.getElementById("ftsModulesStyle")) {
      const st = document.createElement("style");
      st.id = "ftsModulesStyle";
      st.textContent = ".sv-nav [hidden],.sv-tabbar [hidden],#nouveauChantierBtn[hidden],#nouveauChantierFab[hidden]{display:none!important}";
      document.head.appendChild(st);
    }
    document.querySelectorAll(".sv-nav a, .sv-nav button[data-view], .sv-tabbar a, .sv-tabbar button[data-view]").forEach((el) => {
      const m = moduleDuLien(el);
      if (m) el.hidden = !autoriseLien(m, e);
    });
    // Création de chantier réservée aux conducteurs et à la direction
    const creer = e.statut === "proprio" || (e.statut === "encadrement" && CREENT_CHANTIER.includes(e.poste));
    ["nouveauChantierBtn", "nouveauChantierFab"].forEach((id) => { const b = document.getElementById(id); if (b) b.hidden = !creer; });
    // Titres de groupe sans entrée visible
    document.querySelectorAll(".sv-nav .sv-grp").forEach((g) => {
      let n = g.nextElementSibling, vis = false;
      while (n && !n.classList.contains("sv-grp")) { if (!n.hidden) vis = true; n = n.nextElementSibling; }
      g.hidden = !vis;
    });
  }

  /** Première page autorisée (lien), pour le bouton du message de refus. */
  function premierLien(e = etat, base = "../supervision-encadrement/index.html") {
    const ordre = [["overview", ""], ["stats", "#se-view-stats"], ["preparation", "#se-view-preparation"], ["archives", "#se-view-archives"], ["documents", "#se-view-documents"],
      ["pointMat", "../recap-hebdo/index.html?type=materiel"], ["pointPers", "../recap-hebdo/index.html?type=personnel"], ["personnel", "#se-view-personnel"], ["parc", "#se-view-parc"]];
    const t = ordre.find(([m]) => autorise(m, e));
    if (!t) return null;
    return t[1].startsWith("..") ? t[1] : base + t[1];
  }

  function voile(html) {
    let v = document.getElementById("ftsModulesVoile");
    if (!v) {
      v = document.createElement("div");
      v.id = "ftsModulesVoile";
      v.setAttribute("role", "dialog");
      v.style.cssText = "position:fixed;inset:0;z-index:9000;background:#F4F5F7;display:flex;align-items:center;justify-content:center;padding:20px;font-family:inherit";
      document.body.appendChild(v);
    }
    v.innerHTML = `<div style="background:#fff;border-radius:16px;box-shadow:0 2px 14px rgba(0,0,0,.08);max-width:520px;width:100%;padding:34px 30px;text-align:center">${html}</div>`;
    v.querySelectorAll("a[href]").forEach((a) => (a.onclick = (ev) => {
      ev.preventDefault();
      const u = new URL(a.href, location.href);
      location.href = u.href;
      if (u.pathname === location.pathname && u.search === location.search) location.reload();
    }));
    const b = v.querySelector("[data-deco]");
    if (b) b.onclick = () => { try { localStorage.removeItem(CACHE); localStorage.removeItem("fts_supervision_cache_v1"); } catch (e) {} if (window.FTSAuth) FTSAuth.signOut(); location.reload(); };
    return v;
  }
  function retirerVoile() { const v = document.getElementById("ftsModulesVoile"); if (v) v.remove(); }

  /**
   * Message bloquant si le compte n'a pas accès.
   * @param {string} module module de la page (ou de la vue) demandée
   * @returns {boolean} true si la page peut s'afficher
   */
  function controler(module, e = etat) {
    if (!e || e.statut === "inconnu") { retirerVoile(); return true; }
    const qui = `<p style="color:#6B7280;font-size:13px;margin:14px 0 0">Compte connecté : <b>${esc(e.email || "inconnu")}</b></p>`;
    const deco = `<button type="button" data-deco style="margin-top:16px;border:1px solid #d6d9de;background:#fff;border-radius:10px;padding:9px 16px;font-weight:700;cursor:pointer;font-family:inherit">Changer de compte</button>`;
    if (e.statut === "refuse") {
      voile(`<div style="font-size:46px">⛔</div><h2 style="margin:8px 0 10px;font-size:21px">Réservé à l'encadrement</h2>
        <p style="color:#4B5563;line-height:1.5;margin:0">La Supervision est réservée à l'encadrement FTS.</p>${qui}${deco}`);
      return false;
    }
    if (module && !autoriseLien(module, e)) {
      const lien = premierLien(e);
      voile(`<div style="font-size:46px">🔒</div><h2 style="margin:8px 0 10px;font-size:21px">Page non autorisée</h2>
        <p style="color:#4B5563;line-height:1.5;margin:0">Cette page ne fait pas partie de tes accès. Demande à Clément MALECOT.</p>${qui}
        ${lien ? `<a href="${lien}" style="display:inline-block;margin-top:16px;background:#FDCA01;border-radius:10px;padding:10px 16px;font-weight:700;color:#000;text-decoration:none">Aller à mes pages</a>` : deco}`);
      return false;
    }
    retirerVoile();
    return true;
  }

  /**
   * À appeler sur chaque page bureau une fois la session Google prête.
   * Applique d'abord la dernière décision connue (affichage immédiat), puis
   * recalcule. options.module : module de la page ; options.surChange(etat).
   */
  async function appliquer(options = {}) {
    const memo = lireCache();
    const email = window.FTSAuth && FTSAuth.emailMemorise ? FTSAuth.emailMemorise() : "";
    if (memo && email && mail(memo.email) === mail(email)) {
      etat = etat || memo;
      filtrerMenu(memo);
      const m = typeof options.module === "function" ? options.module() : options.module;
      controler(m, memo);
    }
    if (!window.FTSAuth || !FTSAuth.isSignedIn()) return etat;
    const e = await calculer().catch((err) => { console.warn("Accès aux modules :", err); return etat; });
    filtrerMenu(e);
    const m = typeof options.module === "function" ? options.module() : options.module;
    controler(m, e);
    if (typeof options.surChange === "function") options.surChange(e);
    return e;
  }

  return { MODULES, DEFAUTS, DEFAUT_INCONNU, NOM_REGLAGES, trouverReglages, lireReglages, modulesPour, mail, appliquer, calculer, autorise: (m) => autoriseLien(m, etat), controler: (m) => controler(m, etat), filtrerMenu, moi, etat: () => etat, VUE_MODULE };
})();
if (typeof window !== "undefined") window.FTSModules = FTSModules;
