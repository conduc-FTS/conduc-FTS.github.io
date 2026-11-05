/**
 * supervision-shell.js — habillage commun des pages bureau hors
 * supervision-encadrement/ (Détail chantier, Pointage matériel/personnel) :
 * menu de gauche (toujours visible sur ordinateur, onglet actif en jaune),
 * barre du haut, barre d'onglets en bas sur téléphone, compte Google et
 * bandeau "Reprendre la session".
 *
 * La page fournit son contenu dans <div id="svPage">…</div>, puis appelle :
 *   FTSShell.monter({
 *     actif: "materiel",               // entrée du menu à surligner
 *     titre: "Pointage matériel",      // texte ou HTML (barre du haut)
 *     sousTitre: "…", crumb: "…",      // optionnels (HTML)
 *     titreMobile: "…", sousTitreMobile: "…", retour: "url",  // téléphone
 *     actions: "<button …>",           // boutons de la barre du haut (HTML)
 *     menuMobile: [{ label, action }], // bouton ⋯ sur téléphone
 *     onSession: (connecte) => {},     // appelé à chaque changement de session
 *   });
 * Nécessite auth.js chargé avant.
 */
const FTSShell = (() => {
  const SUP = "../supervision-encadrement/index.html";
  const MENU = [
    { grp: "PILOTAGE" },
    { id: "se-view-overview", ic: "📊", label: "Vue d'ensemble", href: SUP },
    { id: "se-view-stats", ic: "📈", label: "Statistiques", href: SUP + "#se-view-stats" },
    { grp: "POINTAGES" },
    { id: "materiel", ic: "🔧", label: "Matériel", href: "../recap-hebdo/index.html?type=materiel" },
    { id: "personnel", ic: "👷", label: "Personnel", href: "../recap-hebdo/index.html?type=personnel" },
    { grp: "RÉFÉRENTIELS" },
    { id: "se-view-personnel", ic: "👥", label: "Personnel FTS", href: SUP + "#se-view-personnel" },
    { id: "se-view-parc", ic: "🚜", label: "Parc matériel", href: SUP + "#se-view-parc" },
    { grp: "CHANTIERS" },
    { id: "se-view-archives", ic: "🗄️", label: "Archives", href: SUP + "#se-view-archives" },
  ];

  let opts = {};

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function toast(msg, ms = 2600) {
    let t = document.getElementById("svToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "svToast";
      t.className = "sv-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("on"), ms);
  }

  function monter(o) {
    opts = o || {};
    const page = document.getElementById("svPage");
    const nav = MENU.map((m) => m.grp
      ? `<div class="sv-grp">${m.grp}</div>`
      : `<a href="${m.href}" class="${m.id === opts.actif ? "active" : ""}"><span class="ic">${m.ic}</span>${m.label}</a>`).join("");

    const sidebar = document.createElement("aside");
    sidebar.className = "sv-sidebar";
    sidebar.id = "sidebar";
    sidebar.innerHTML = `
      <a class="sv-brand" href="${SUP}">
        <img src="../assets/logo-fts.png" alt="FTS" width="54" height="28">
        <div><b>SUPERVISION</b><small>Fondations &amp; Travaux Spéciaux</small></div>
      </a>
      <nav class="sv-nav">${nav}</nav>
      <div class="sv-acct">
        <div class="sv-av" id="userAvatar">?</div>
        <div class="sv-who"><span id="userName">Non connecté</span><small id="userLabel">—</small></div>
        <button type="button" class="sv-logout" id="signOutBtn" title="Se déconnecter" hidden>🚪</button>
      </div>`;

    const backdrop = document.createElement("div");
    backdrop.className = "sv-backdrop";
    backdrop.id = "menuBackdrop";

    const mtop = document.createElement("div");
    mtop.className = "sv-mtop";
    mtop.innerHTML = (opts.retour ? `<a class="sv-back" href="${opts.retour}" aria-label="Retour">←</a>` : `<img src="../assets/logo-fts.png" alt="FTS" width="54" height="28">`) +
      `<div class="sv-mtitle">${opts.titreMobile || opts.titre || ""}${opts.sousTitreMobile ? `<small>${opts.sousTitreMobile}</small>` : ""}</div>` +
      ((opts.menuMobile && opts.menuMobile.length) ? `<button type="button" class="sv-mmore" id="mMoreBtn" aria-label="Plus d'actions">⋯</button>` : "");

    const main = document.createElement("div");
    main.className = "sv-main";
    main.innerHTML = `
      <header class="sv-top">
        <div style="min-width:0">${opts.crumb ? `<div class="sv-crumb">${opts.crumb}</div>` : ""}<h1 id="pageTitle">${opts.titre || ""}</h1>${opts.sousTitre ? `<div class="sv-date">${opts.sousTitre}</div>` : ""}</div>
        <span class="sv-sp"></span>
        <div class="sv-actions">${opts.actions || ""}</div>
      </header>
      <div class="sv-content">
        <div class="sv-banner" id="sessionBanner" hidden>
          <span id="sessionBannerTxt"></span><span class="sv-sp"></span>
          <button type="button" class="sv-btn pri" id="signInBtn">Reprendre la session</button>
        </div>
      </div>`;
    if (page) main.querySelector(".sv-content").appendChild(page);

    const tabbar = document.createElement("nav");
    tabbar.className = "sv-tabbar";
    const tab = (id, ic, label, href) => `<a href="${href}" class="${id === opts.actif ? "on" : ""}"><span>${ic}</span>${label}</a>`;
    tabbar.innerHTML = tab("se-view-overview", "📊", "Accueil", SUP) + tab("materiel", "🔧", "Matériel", "../recap-hebdo/index.html?type=materiel") +
      tab("personnel", "👷", "Personnel", "../recap-hebdo/index.html?type=personnel") + tab("se-view-stats", "📈", "Stats", SUP + "#se-view-stats") +
      `<button type="button" id="menuPlusBtn"><span>☰</span>Plus</button>`;

    const mmenu = document.createElement("div");
    mmenu.className = "sv-mmenu";
    mmenu.id = "mMenu";
    (opts.menuMobile || []).forEach((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label;
      b.addEventListener("click", () => { mmenu.classList.remove("open"); it.action(); });
      mmenu.appendChild(b);
    });

    document.body.prepend(mmenu);
    document.body.prepend(tabbar);
    document.body.prepend(main);
    document.body.prepend(mtop);
    document.body.prepend(backdrop);
    document.body.prepend(sidebar);

    document.getElementById("menuPlusBtn").addEventListener("click", () => document.body.classList.toggle("menu-ouvert"));
    backdrop.addEventListener("click", () => document.body.classList.remove("menu-ouvert"));
    const more = document.getElementById("mMoreBtn");
    if (more) more.addEventListener("click", (e) => { e.stopPropagation(); mmenu.classList.toggle("open"); });
    document.addEventListener("click", (e) => { if (!mmenu.contains(e.target)) mmenu.classList.remove("open"); });

    document.getElementById("signInBtn").addEventListener("click", () => window.FTSAuth && FTSAuth.signIn());
    document.getElementById("signOutBtn").addEventListener("click", () => {
      if (!confirm("Se déconnecter de Google sur cet appareil ?")) return;
      try { localStorage.removeItem("fts_supervision_cache_v1"); } catch (e) {}
      window.FTSAuth && FTSAuth.signOut();
    });

    if (window.FTSAuth) {
      FTSAuth.onAuthChange(majSession);
      FTSAuth.init();
      majSession();
    }
  }

  function majSession() {
    const connecte = !!(window.FTSAuth && FTSAuth.isSignedIn());
    const connue = !!(window.FTSAuth && FTSAuth.sessionConnue && FTSAuth.sessionConnue());
    const email = (window.FTSAuth && FTSAuth.emailMemorise && FTSAuth.emailMemorise()) || "";
    const av = document.getElementById("userAvatar");
    av.classList.toggle("on", connecte);
    av.classList.toggle("exp", !connecte && connue);
    document.getElementById("signOutBtn").hidden = !connecte && !connue;
    document.getElementById("userLabel").textContent = email || (connecte ? "Connecté" : "—");
    if (!connecte) document.getElementById("userName").textContent = connue ? "Session expirée" : "Non connecté";

    const banner = document.getElementById("sessionBanner");
    banner.hidden = connecte;
    if (!connecte) {
      document.getElementById("signInBtn").textContent = connue ? "Reprendre la session" : "Se connecter avec Google";
      document.getElementById("sessionBannerTxt").textContent = connue
        ? "⚠️ Session Google expirée — les données affichées peuvent dater de ta dernière visite."
        : "Connecte-toi avec le compte Google du bureau pour afficher les données.";
    } else {
      FTSAuth.getUserInfo().then((info) => {
        if (!info) return;
        document.getElementById("userName").textContent = info.name || "Connecté";
        document.getElementById("userLabel").textContent = info.email || "";
        const ini = (info.name || info.email || "?").split(/[\s.@]+/).filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join("");
        av.textContent = ini || "?";
      }).catch(() => {});
    }
    if (typeof opts.onSession === "function") opts.onSession(connecte);
  }

  /** Fenêtre modale simple : retourne { el, fermer } ; contenu HTML fourni. */
  function modale({ titre, corps, pied, large }) {
    const ov = document.createElement("div");
    ov.className = "sv-ov open";
    ov.innerHTML = `<div class="sv-modal" style="${large ? "width:760px" : ""}">
      <div class="sv-mh"><h3>${titre}</h3><button type="button" class="sv-x" aria-label="Fermer">✕</button></div>
      <div class="sv-mb">${corps}</div>
      ${pied ? `<div class="sv-mf">${pied}</div>` : ""}
    </div>`;
    document.body.appendChild(ov);
    const fermer = () => { ov.remove(); document.removeEventListener("keydown", echap); };
    const echap = (e) => { if (e.key === "Escape") fermer(); };
    document.addEventListener("keydown", echap);
    ov.addEventListener("click", (e) => { if (e.target === ov) fermer(); });
    ov.querySelector(".sv-x").addEventListener("click", fermer);
    return { el: ov, fermer };
  }

  /** Version téléphone allégée (même seuil que la feuille de style) */
  function estTelephone() { return window.matchMedia("(max-width: 760px)").matches; }

  return { monter, toast, modale, esc, estTelephone };
})();
window.FTSShell = FTSShell;
