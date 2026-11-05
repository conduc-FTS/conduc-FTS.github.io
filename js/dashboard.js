/**
 * dashboard.js — Accueil de la tablette du chef (FTS Dashboard)
 *
 *  - Ligne du haut : date (+ « Jour X de chantier ») à gauche, carte
 *    « Chantier en cours » à droite (touche = fenêtre de choix).
 *  - Objectif chantier : jours de chantier et micropieux réalisés par
 *    rapport aux prévisions saisies au bureau (jamais le montant vendu).
 *  - Bouton compte en haut à droite (fenêtre connexion / déconnexion).
 *  - Onglet DOCUMENTS : voir js/documents.js.
 *  - Pastille « Hors ligne » et affichage de la dernière version connue
 *    quand il n'y a pas de réseau.
 */

const CHANTIER_ACTIF_KEY = "fts_chantier_actif";
const CLE_LISTE_CHANTIERS = "fts_chantiers_liste";
const PREFIXE_ACCUEIL = "fts_accueil_";
const DUREE_FRAICHE_MS = 120000;
const VERSION_APPLI = "05/11/2026";
const JOURS_SEMAINE = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS_ANNEE = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MOIS_ABBR = ["JAN", "FÉV", "MAR", "AVR", "MAI", "JUIN", "JUIL", "AOÛT", "SEP", "OCT", "NOV", "DÉC"];

document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);

  // ─── Petits utilitaires ──────────────────────────────────────
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
  const enLigne = () => navigator.onLine !== false;
  const connecte = () => !!(window.FTSAuth && FTSAuth.isSignedIn() && window.FTSDrive);
  function lireJSON(cle, defaut) {
    try { const r = localStorage.getItem(cle); return r ? JSON.parse(r) : defaut; } catch (e) { return defaut; }
  }
  function ecrireJSON(cle, v) {
    try { localStorage.setItem(cle, JSON.stringify(v)); } catch (e) { /* stockage plein */ }
  }
  let minuterieToast = 0;
  function toast(txt) {
    const t = $("toast");
    t.textContent = txt;
    t.hidden = false;
    clearTimeout(minuterieToast);
    minuterieToast = setTimeout(() => { t.hidden = true; }, 3800);
  }
  const fr = (n) => String(n).replace(".", ",");

  function getChantierActif() {
    const c = lireJSON(CHANTIER_ACTIF_KEY, null);
    return c && c.id && c.name ? c : null;
  }

  /** « 26FTS099 SARLAT 15 LOGEMENTS » → code (1er mot) + reste du nom. */
  function decouperChantier(name) {
    const morceaux = String(name || "").trim().split(/\s+/);
    const code = morceaux.shift() || "";
    return { code, nom: morceaux.join(" ") };
  }

  // ─── Onglets ─────────────────────────────────────────────────
  const tabs = document.querySelectorAll(".app-tab");
  function ouvrirOnglet(vue) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.view === vue));
    document.querySelectorAll(".app-view").forEach((v) => v.classList.toggle("active", v.id === vue));
    if (vue === "view-documents") FTSDocs.afficher(false);
    window.scrollTo(0, 0);
  }
  tabs.forEach((tab) => tab.addEventListener("click", () => ouvrirOnglet(tab.dataset.view)));

  FTSDocs.init({ getChantierActif, toast });

  // ─── Fenêtres (popups) ───────────────────────────────────────
  function ouvrirPopup(id) { $(id).hidden = false; }
  function fermerPopup(id) { $(id).hidden = true; }
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => fermerPopup(b.dataset.close)));
  document.querySelectorAll(".pop-ov").forEach((ov) => ov.addEventListener("click", (e) => { if (e.target === ov) fermerPopup(ov.id); }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".pop-ov").forEach((ov) => { ov.hidden = true; });
  });

  // ─── Date ────────────────────────────────────────────────────
  function semaine(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const jour = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - jour);
    const debut = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date - debut) / 86400000 + 1) / 7);
  }
  let jourDeChantier = null;
  function rendreDate() {
    const d = new Date();
    $("dateBoxMois").textContent = MOIS_ABBR[d.getMonth()];
    $("dateBoxJour").textContent = String(d.getDate()).padStart(2, "0");
    const j = JOURS_SEMAINE[d.getDay()];
    $("dateMain").textContent = `${j.charAt(0).toUpperCase()}${j.slice(1)} ${d.getDate()} ${MOIS_ANNEE[d.getMonth()]} ${d.getFullYear()}`;
    $("dateSub").textContent = `Semaine ${semaine(d)}${jourDeChantier ? ` · Jour ${jourDeChantier} de chantier` : ""}`;
  }

  // ─── Pastille hors ligne ─────────────────────────────────────
  function majReseau() {
    $("pastilleHorsLigne").hidden = enLigne();
  }
  window.addEventListener("online", () => {
    majReseau();
    toast("📶 Réseau retrouvé : mise à jour…");
    if (connecte()) { rendreAccueil(true); if ($("view-documents").classList.contains("active")) FTSDocs.afficher(true); }
  });
  window.addEventListener("offline", () => {
    majReseau();
    FTSDocs.rendre();
    rendreAccueil(false);
    toast("📡 Plus de réseau : les documents gardés hors ligne restent consultables.");
  });

  // ─── Compte (bouton en haut à droite) ────────────────────────
  let infoUtilisateur = null;
  async function majBoutonCompte() {
    const av = $("userAvatar"), nom = $("userName"), role = $("userRole");
    if (!connecte()) {
      infoUtilisateur = null;
      av.textContent = "?";
      nom.textContent = "Non connecté";
      role.innerHTML = `<span class="ac-st off">● ${enLigne() ? "Toucher pour se connecter" : "Hors ligne"}</span>`;
      return;
    }
    nom.textContent = "Connecté";
    role.innerHTML = '<span class="ac-st">● Connecté</span>';
    try {
      const info = await FTSAuth.getUserInfo();
      if (info) {
        infoUtilisateur = info;
        const affiche = info.name || info.email || "Connecté";
        nom.textContent = affiche;
        av.textContent = affiche.trim().charAt(0).toUpperCase();
      }
    } catch (e) { /* hors ligne : on garde « Connecté » */ }
  }

  let confirmationDeconnexion = 0;
  function rendrePopupCompte() {
    const st = FTSDocs.statsHorsLigne();
    const mo = (st.taille / 1048576).toFixed(st.taille > 10485760 ? 0 : 1).replace(".", ",");
    const blocHL = `<div class="acc-off">📥 <b>Sur la tablette :</b> ${st.nb ? `${st.nb} document${st.nb > 1 ? "s" : ""} hors ligne · ${mo} Mo` : "aucun document gardé hors ligne"}
      ${st.nb ? '<button type="button" class="acc-btn light" id="accViderHL">Retirer les documents hors ligne de la tablette</button>' : ""}</div>`;
    const pied = `<div class="pop-note">Tableau de bord FTS · version du ${VERSION_APPLI}</div>`;
    let html;
    if (connecte()) {
      const i = infoUtilisateur || {};
      const affiche = i.name || i.email || "Connecté";
      html = `<div class="acc-row"><div class="acc-av">${esc(affiche.trim().charAt(0).toUpperCase())}</div><div>
          <b style="font-size:1.05rem">${esc(affiche)}</b><br><span style="color:#6B7280;font-size:.85rem">${esc(i.email || "")}</span><br>
          <span style="color:#27AE60;font-size:.8rem;font-weight:700">● Connecté à Google Drive</span></div></div>
        <button type="button" class="acc-btn out${confirmationDeconnexion ? " confirm" : ""}" id="accDeconnexion">${confirmationDeconnexion ? "Confirmer la déconnexion" : "Se déconnecter"}</button>
        ${confirmationDeconnexion ? '<div class="pop-note">Sans connexion, les rapports ne pourront plus être enregistrés sur le Drive. Touche encore pour confirmer.</div>' : ""}
        ${blocHL}${pied}`;
    } else {
      html = `<div class="acc-row"><div class="acc-av" style="background:#E5E7EB">?</div><div><b style="font-size:1.05rem">Non connecté</b><br>
          <span style="color:#6B7280;font-size:.85rem">Connecte-toi avec le compte Google de la tablette.</span></div></div>
        ${enLigne() ? '<button type="button" class="acc-btn in" id="accConnexion">Se connecter avec Google</button>'
          : '<div class="pop-note" style="margin-top:0">📡 Pas de réseau : la connexion sera possible au retour du réseau. Les documents gardés hors ligne restent consultables dans l\'onglet DOCUMENTS.</div>'}
        ${blocHL}${pied}`;
    }
    $("popCompteCorps").innerHTML = html;
    const bc = $("accConnexion");
    if (bc) bc.addEventListener("click", () => { fermerPopup("popCompte"); FTSAuth.signIn(); });
    const bd = $("accDeconnexion");
    if (bd) bd.addEventListener("click", () => {
      if (!confirmationDeconnexion) {
        confirmationDeconnexion = Date.now();
        rendrePopupCompte();
        setTimeout(() => { if (confirmationDeconnexion && Date.now() - confirmationDeconnexion >= 5900) { confirmationDeconnexion = 0; if (!$("popCompte").hidden) rendrePopupCompte(); } }, 6000);
        return;
      }
      confirmationDeconnexion = 0;
      FTSAuth.signOut();
      fermerPopup("popCompte");
      toast("Déconnecté.");
    });
    const bv = $("accViderHL");
    if (bv) bv.addEventListener("click", async () => {
      await FTSDocs.toutRetirerHorsLigne();
      rendrePopupCompte();
      FTSDocs.rendre();
      toast("Documents hors ligne retirés de la tablette.");
    });
  }
  $("userBtn").addEventListener("click", () => { confirmationDeconnexion = 0; rendrePopupCompte(); ouvrirPopup("popCompte"); });

  // ─── Choix du chantier ───────────────────────────────────────
  let listeChantiers = lireJSON(CLE_LISTE_CHANTIERS, null); // { liste:[{id,name}], maj }
  async function chargerListeChantiers(forcer) {
    if (!connecte() || !enLigne()) return listeChantiers;
    if (!forcer && listeChantiers && Date.now() - listeChantiers.maj < DUREE_FRAICHE_MS) return listeChantiers;
    const chantiers = await FTSDrive.listChantiers();
    listeChantiers = { liste: chantiers.map((c) => ({ id: c.id, name: c.name })), maj: Date.now() };
    ecrireJSON(CLE_LISTE_CHANTIERS, listeChantiers);
    return listeChantiers;
  }

  function rendreListeChantiers(message) {
    const actif = getChantierActif();
    const q = norm($("popChantierRecherche").value);
    const box = $("popChantierListe");
    if (!listeChantiers || !listeChantiers.liste) {
      box.innerHTML = `<div class="pop-vide">${message || (connecte() ? "Chargement des chantiers…" : enLigne() ? "Connecte-toi (bouton en haut à droite) pour voir tes chantiers." : "Pas de réseau : la liste des chantiers n'est pas encore enregistrée sur la tablette.")}</div>`;
      return;
    }
    const items = listeChantiers.liste
      .map((c) => ({ ...c, ...decouperChantier(c.name) }))
      .filter((c) => !q || norm(c.name).includes(q))
      .sort((a, b) => (actif && b.id === actif.id) - (actif && a.id === actif.id) || b.code.localeCompare(a.code));
    box.innerHTML = (message ? `<div class="pop-vide">${esc(message)}</div>` : "") + (items.length ? items.map((c) => `
      <button type="button" class="ch-it${actif && actif.id === c.id ? " on" : ""}" data-id="${esc(c.id)}">
        <span class="c">${esc(c.code)}</span>
        <span class="v">${esc(c.nom || c.name)}</span>
        ${actif && actif.id === c.id ? '<span class="ok">✓ EN COURS</span>' : ""}
      </button>`).join("") : `<div class="pop-vide">${q ? "Aucun chantier ne correspond." : "Aucun chantier ne t'est partagé pour le moment."}</div>`);
    box.querySelectorAll(".ch-it").forEach((b) => b.addEventListener("click", () => choisirChantier(b.dataset.id)));
  }

  async function ouvrirChoixChantier() {
    $("popChantierRecherche").value = "";
    rendreListeChantiers();
    ouvrirPopup("popChantier");
    try {
      await chargerListeChantiers(true);
      rendreListeChantiers();
    } catch (e) {
      console.error("Erreur chargement chantiers :", e);
      rendreListeChantiers(`Liste non mise à jour : ${e.message}`);
    }
  }
  $("chantierCard").addEventListener("click", ouvrirChoixChantier);
  $("popChantierRecherche").addEventListener("input", () => rendreListeChantiers());

  async function choisirChantier(id) {
    const c = listeChantiers && listeChantiers.liste.find((x) => x.id === id);
    if (!c) return;
    const ancien = getChantierActif();
    fermerPopup("popChantier");
    if (ancien && ancien.id === id) return;
    ecrireJSON(CHANTIER_ACTIF_KEY, { id: c.id, name: c.name });
    const retires = await FTSDocs.changementDeChantier(c.id);
    toast(`Chantier en cours : ${decouperChantier(c.name).code}${retires ? ` · ${retires} document(s) de l'ancien chantier retiré(s) de la tablette` : ""}`);
    jourDeChantier = null;
    rendreAccueil(true);
    if ($("view-documents").classList.contains("active")) FTSDocs.afficher(true);
  }

  // ─── Carte chantier + objectif + activité ────────────────────
  function rendreCarteChantier() {
    const actif = getChantierActif();
    const carte = $("chantierCard");
    if (!actif) {
      carte.classList.add("vide");
      $("chantierCode").textContent = "Aucun chantier";
      $("chantierNom").textContent = "Touche ici pour choisir ton chantier";
      $("chantierChg").textContent = "Choisir";
      return;
    }
    const d = decouperChantier(actif.name);
    carte.classList.remove("vide");
    $("chantierCode").textContent = d.code;
    $("chantierNom").textContent = d.nom;
    $("chantierChg").textContent = "⇄ Changer";
  }

  function blocObjectif(prevus, duree, av) {
    const j = av.joursRapportes, p = av.totalMicropieux;
    const lignes = [];
    if (duree) {
      const retard = j > duree;
      lignes.push(`<div class="obj-row"><div class="obj-top"><span class="obj-lbl">⏱️ Jours de chantier</span><span class="obj-val">${j} <small>/ ${duree} jour${duree > 1 ? "s" : ""} prévu${duree > 1 ? "s" : ""}</small></span></div>
        <div class="obj-bar"><div class="obj-fill${retard ? " retard" : ""}" style="width:${Math.min(100, (j / duree) * 100)}%"></div></div>
        <div class="obj-sub"><span>${Math.round((j / duree) * 100)} % du temps prévu</span>${retard ? `<span class="rouge">${j - duree} jour(s) au-delà du prévu</span>` : `<span><b>${duree - j}</b> jour(s) restant(s)</span>`}</div></div>`);
    }
    if (prevus) {
      const fini = p >= prevus;
      lignes.push(`<div class="obj-row"><div class="obj-top"><span class="obj-lbl">📍 Micropieux réalisés</span><span class="obj-val">${p} <small>/ ${prevus} prévus</small></span></div>
        <div class="obj-bar"><div class="obj-fill" style="width:${Math.min(100, (p / prevus) * 100)}%"></div></div>
        <div class="obj-sub"><span>${Math.round((p / prevus) * 100)} % réalisé</span>${fini ? '<span><b>Objectif atteint ✓</b></span>' : `<span><b>${prevus - p}</b> micropieu${prevus - p > 1 ? "x" : ""} restant${prevus - p > 1 ? "s" : ""}</span>`}</div></div>`);
    }
    // Rythme à tenir (seulement si on a les deux prévisions)
    if (duree && prevus && p < prevus) {
      const restJ = duree - j, restP = prevus - p;
      const moy = j > 0 ? p / j : null;
      const txtMoy = moy !== null ? ` Moyenne actuelle : <b>${fr(moy.toFixed(1))} / jour</b>.` : "";
      if (restJ > 0) {
        const besoin = restP / restJ;
        const alerte = moy !== null && besoin > moy * 1.15;
        lignes.push(`<div class="obj-rythme${alerte ? " alerte" : ""}">Pour finir dans les temps : <b>${fr(besoin.toFixed(1))} micropieux / jour</b> sur les ${restJ} jour(s) restant(s).${txtMoy}</div>`);
      } else {
        lignes.push(`<div class="obj-rythme alerte">Durée prévue atteinte : il reste <b>${restP} micropieu${restP > 1 ? "x" : ""}</b>.${txtMoy}</div>`);
      }
    }
    return `<div class="activite-title" style="margin-top:0">Objectif chantier</div><div class="obj-card">${lignes.join("")}</div>`;
  }

  function rendreObjectifEtActivite(cache) {
    const bloc = $("objectifBloc");
    const titreAct = $("activiteTitre");
    if (!cache) {
      bloc.hidden = true;
      titreAct.style.marginTop = "0";
      jourDeChantier = null;
      rendreDate();
      return;
    }
    const estMicropieux = !cache.typeChantier || cache.typeChantier === "Micropieux";
    const prevus = Number(cache.micropieuxPrevus) || 0;
    const duree = Number(cache.dureeChantier) || 0;
    if (cache.avancement && (prevus || duree)) {
      bloc.innerHTML = blocObjectif(estMicropieux ? prevus : 0, duree, cache.avancement) +
        (!enLigne() ? `<div class="obj-maj" style="margin-top:4px">Hors ligne · chiffres du ${new Date(cache.maj).toLocaleDateString("fr-FR")}</div>` : "");
      bloc.hidden = !(duree || (estMicropieux && prevus));
    } else {
      bloc.hidden = true;
    }
    titreAct.style.marginTop = bloc.hidden ? "0" : "";
    jourDeChantier = cache.avancement ? cache.avancement.joursRapportes + (cache.avancement.rapportAujourdhui ? 0 : 1) : null;
    rendreDate();
    rendreActivite(cache.activite);
  }

  function rendreActivite(fichiers) {
    const box = $("activiteList");
    if (!fichiers) { box.innerHTML = `<div class="activite-empty">${connecte() ? "Chargement de l'activité…" : "Connecte-toi pour voir l'activité du chantier."}</div>`; return; }
    if (!fichiers.length) { box.innerHTML = '<div class="activite-empty">Aucune activité pour le moment.</div>'; return; }
    const couleurs = ["blue", "red", "green", "yellow"];
    box.innerHTML = fichiers.map((f, i) => {
      const n = FTSDocs.nomAffiche(f);
      return `<button type="button" class="activite-item" data-i="${i}" style="width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer">
        <span class="activite-dot ${couleurs[i % couleurs.length]}"></span>
        <div class="activite-body"><div class="titre">${esc(n.titre)}</div>${n.detail ? `<div class="detail">${esc(n.detail)}</div>` : ""}</div>
        <div class="activite-time">${esc(formatRelatif(new Date(f.createdTime)))}</div></button>`;
    }).join("");
    box.querySelectorAll(".activite-item").forEach((b) => b.addEventListener("click", () => FTSDocs.ouvrir(fichiers[Number(b.dataset.i)])));
  }

  function formatRelatif(date) {
    const auj = new Date(); auj.setHours(0, 0, 0, 0);
    const j = new Date(date); j.setHours(0, 0, 0, 0);
    const diff = Math.round((auj - j) / 86400000);
    const h = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    if (diff === 0) return `Auj. ${h}`;
    if (diff === 1) return `Hier ${h}`;
    if (diff > 1 && diff < 7) return `${JOURS_SEMAINE[date.getDay()].slice(0, 3)}. ${h}`;
    return date.toLocaleDateString("fr-FR");
  }

  let rendreAccueilEnCours = null;
  async function rendreAccueil(forcer) {
    rendreCarteChantier();
    const actif = getChantierActif();
    if (!actif) {
      rendreObjectifEtActivite(null);
      $("activiteList").innerHTML = '<div class="activite-empty">Choisis ton chantier (carte « Chantier en cours ») pour voir son activité.</div>';
      return;
    }
    const cle = PREFIXE_ACCUEIL + actif.id;
    const cache = lireJSON(cle, null);
    rendreObjectifEtActivite(cache || { activite: null });
    if (!connecte() || !enLigne()) {
      if (!cache) $("activiteList").innerHTML = `<div class="activite-empty">${enLigne() ? "Connecte-toi (bouton en haut à droite) pour voir l'activité du chantier." : "Pas de réseau : rien d'enregistré pour ce chantier sur la tablette."}</div>`;
      return;
    }
    if (!forcer && cache && Date.now() - cache.maj < DUREE_FRAICHE_MS) return;
    if (rendreAccueilEnCours) return rendreAccueilEnCours;
    rendreAccueilEnCours = (async () => {
      // On ne recopie QUE ce qui sert à la tablette : jamais le montant vendu
      const [meta, avancement, activite] = await Promise.all([
        FTSDrive.getMetadonneesChantier(actif.id).catch(() => ({})),
        window.FTSSheets ? FTSSheets.avancementChantier(actif.id, actif.name).catch((e) => { console.warn("Avancement :", e); return null; }) : null,
        FTSDrive.getActiviteRecenteChantier(actif.id, 6).catch((e) => { console.warn("Activité :", e); return cache ? cache.activite : []; }),
      ]);
      if (!getChantierActif() || getChantierActif().id !== actif.id) return; // chantier changé entre-temps
      const nouveau = {
        typeChantier: meta.typeChantier || "",
        micropieuxPrevus: meta.micropieuxPrevus || 0,
        dureeChantier: meta.dureeChantier || 0,
        avancement: avancement || (cache && cache.avancement) || null,
        activite: (activite || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, createdTime: f.createdTime, modifiedTime: f.modifiedTime, webViewLink: f.webViewLink })),
        maj: Date.now(),
      };
      ecrireJSON(cle, nouveau);
      rendreCarteChantier();
      rendreObjectifEtActivite(nouveau);
    })().finally(() => { rendreAccueilEnCours = null; });
    return rendreAccueilEnCours;
  }

  // ─── Authentification ────────────────────────────────────────
  let dernierEtat = null;
  function onAuthChange(signedIn) {
    majBoutonCompte();
    if (!$("popCompte").hidden) rendrePopupCompte();
    if (signedIn === dernierEtat) return;
    dernierEtat = signedIn;
    rendreAccueil(false);
    if ($("view-documents").classList.contains("active")) FTSDocs.afficher(false);
  }

  // ─── Boîte d'envoi des rapports (livraison 2) ────────────────
  if (window.FTSBoiteEnvoi) {
    FTSBoiteEnvoi.monterBandeau($("boiteEnvoi"), { seConnecter: () => FTSAuth.signIn() });
    let nbAvant = null;
    FTSBoiteEnvoi.onChange((liste) => {
      // un rapport vient de partir : objectif et activité à jour
      if (nbAvant !== null && liste.length < nbAvant) rendreAccueil(true);
      nbAvant = liste.length;
    });
  }

  // ─── Démarrage ───────────────────────────────────────────────
  rendreDate();
  majReseau();
  rendreAccueil(false);

  if (window.FTSAuth) {
    FTSAuth.init();
    FTSAuth.onAuthChange(onAuthChange);
    onAuthChange(FTSAuth.isSignedIn());
  }
  if (window.FTSNotifications) FTSNotifications.init();
  if (window.FTSBoiteEnvoi) FTSBoiteEnvoi.demarrer();

  // Lien « Choisis ton chantier » du rapport journalier (/index.html#chantiers)
  if (window.location.hash === "#chantiers") {
    history.replaceState(null, "", window.location.pathname);
    setTimeout(ouvrirChoixChantier, 0);
  } else if (window.location.hash === "#documents") {
    history.replaceState(null, "", window.location.pathname);
    ouvrirOnglet("view-documents");
  }
  // La date change à minuit si la tablette reste allumée
  setInterval(rendreDate, 60000);
});
