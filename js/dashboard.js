/**
 * dashboard.js — Câblage de l'interface FTS Dashboard (style app tablette)
 * Onglets ACCUEIL / CHANTIERS / RÉGLAGES, badge chantier actif, avatar
 * utilisateur, bannière date, fil d'activité récente.
 */

const CHANTIER_ACTIF_KEY = "fts_chantier_actif";
const JOURS_SEMAINE = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS_ANNEE = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MOIS_ABBR = ["JAN", "FÉV", "MAR", "AVR", "MAI", "JUIN", "JUIL", "AOÛT", "SEP", "OCT", "NOV", "DÉC"];

document.addEventListener("DOMContentLoaded", () => {

  // --- Onglets ---
  const tabs = document.querySelectorAll(".app-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".app-view").forEach((v) => v.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.view).classList.add("active");
    });
  });

  // --- Bannière date (mise à jour une fois, la page reste ouverte en session courte) ---
  renderDateBanner();

  // --- Init auth ---
  if (window.FTSAuth) {
    FTSAuth.init();
    FTSAuth.onAuthChange(onAuthChange);
    onAuthChange(FTSAuth.isSignedIn());
  }
  if (window.FTSNotifications) {
    FTSNotifications.init();
  }

  async function onAuthChange(signedIn) {
    updateUserBlock(signedIn);
    if (signedIn) {
      chargerChantiers();
      renderChantierBadgeEtActivite();
    }
  }

  async function updateUserBlock(signedIn) {
    const avatar = document.getElementById("userAvatar");
    const name = document.getElementById("userName");
    const role = document.getElementById("userRole");
    const signInBtn = document.getElementById("signInBtn");
    const signOutBtn = document.getElementById("signOutBtn");
    const accountInfo = document.getElementById("adminAccountInfo");

    if (!signedIn) {
      avatar.textContent = "?";
      name.textContent = "Non connecté";
      role.textContent = "—";
      signInBtn.hidden = false;
      signOutBtn.hidden = true;
      accountInfo.textContent = "Non connecté";
      return;
    }

    signInBtn.hidden = true;
    signOutBtn.hidden = false;
    name.textContent = "Connecté";
    accountInfo.textContent = "Connecté";

    if (window.FTSAuth) {
      const info = await FTSAuth.getUserInfo();
      if (info) {
        const displayName = info.name || info.email || "Connecté";
        name.textContent = displayName;
        avatar.textContent = displayName.trim().charAt(0).toUpperCase();
        role.textContent = info.email || "";
        accountInfo.textContent = `Connecté : ${info.email || displayName}`;
      }
    }
  }

  // --- Boutons connexion / déconnexion (dans l'onglet Réglages) ---
  document.getElementById("signInBtn").addEventListener("click", () => window.FTSAuth && FTSAuth.signIn());
  document.getElementById("signOutBtn").addEventListener("click", () => {
    window.FTSAuth && FTSAuth.signOut();
    document.getElementById("chantierBadge").hidden = true;
    document.getElementById("activiteList").innerHTML = '<div class="activite-empty">Connecte-toi pour voir l\'activité.</div>';
  });

  // --- Chantier actif ---
  const chantierActifSelect = document.getElementById("chantierActifSelect");
  const chantierActifStatus = document.getElementById("chantierActifStatus");
  const refreshChantiersBtn = document.getElementById("refreshChantiersBtn");

  async function chargerChantiers() {
    if (!window.FTSAuth || !FTSAuth.isSignedIn() || !window.FTSDrive) {
      chantierActifStatus.textContent = "Connecte-toi pour voir la liste des chantiers.";
      return;
    }
    chantierActifStatus.textContent = "Chargement des chantiers...";
    try {
      const chantiers = await FTSDrive.listChantiers();
      chantierActifSelect.innerHTML = '<option value="">— Sélectionner un chantier —</option>';
      chantiers.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name;
        opt.dataset.name = c.name;
        chantierActifSelect.appendChild(opt);
      });

      const saved = getChantierActifSauvegarde();
      if (saved && chantiers.some((c) => c.id === saved.id)) {
        chantierActifSelect.value = saved.id;
        chantierActifStatus.textContent = `Chantier actif : ${saved.name}`;
      } else {
        chantierActifStatus.textContent = `${chantiers.length} chantier(s) trouvé(s).`;
      }
    } catch (err) {
      console.error("Erreur chargement chantiers :", err);
      chantierActifStatus.textContent = `Erreur : ${err.message}`;
    }
  }

  function getChantierActifSauvegarde() {
    try {
      const raw = localStorage.getItem(CHANTIER_ACTIF_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  chantierActifSelect.addEventListener("change", () => {
    const selectedOption = chantierActifSelect.selectedOptions[0];
    const id = chantierActifSelect.value;

    if (!id) {
      localStorage.removeItem(CHANTIER_ACTIF_KEY);
      chantierActifStatus.textContent = "Aucun chantier actif sélectionné.";
      renderChantierBadgeEtActivite();
      return;
    }

    const name = selectedOption.dataset.name || selectedOption.textContent;
    localStorage.setItem(CHANTIER_ACTIF_KEY, JSON.stringify({ id, name }));
    chantierActifStatus.textContent = `Chantier actif : ${name}`;
    renderChantierBadgeEtActivite();
  });

  refreshChantiersBtn.addEventListener("click", chargerChantiers);

  // --- Badge chantier + date + activité récente (vue Accueil) ---
  async function renderChantierBadgeEtActivite() {
    const badge = document.getElementById("chantierBadge");
    const badgeCode = document.getElementById("chantierBadgeCode");
    const badgeNom = document.getElementById("chantierBadgeNom");
    const activiteList = document.getElementById("activiteList");
    const dateSub = document.getElementById("dateSub");

    const actif = getChantierActifSauvegarde();

    if (!actif) {
      badge.hidden = true;
      activiteList.innerHTML = '<div class="activite-empty">Sélectionne un chantier (onglet Chantiers) pour voir son activité.</div>';
      return;
    }

    // Le nom stocké est "{CODE} {NOM...}" — on sépare au premier espace pour le badge
    const spaceIdx = actif.name.indexOf(" ");
    const code = spaceIdx > 0 ? actif.name.slice(0, spaceIdx) : actif.name;
    const nom = spaceIdx > 0 ? actif.name.slice(spaceIdx + 1) : "";

    badge.hidden = false;
    badgeCode.textContent = code;
    badgeNom.textContent = nom;

    if (!window.FTSAuth || !FTSAuth.isSignedIn() || !window.FTSDrive) return;

    // Nombre de jours depuis création
    try {
      const created = await FTSDrive.getFolderCreatedTime(actif.id);
      if (created) {
        const jours = Math.max(0, Math.floor((Date.now() - new Date(created).getTime()) / 86400000));
        dateSub.textContent = `${dateSub.dataset.base || dateSub.textContent} · Chantier actif depuis ${jours} jour${jours > 1 ? "s" : ""}`;
      }
    } catch (e) {
      console.warn("Impossible de récupérer la date de création du chantier :", e);
    }

    // Activité récente
    activiteList.innerHTML = '<div class="activite-empty">Chargement de l\'activité...</div>';
    try {
      const fichiers = await FTSDrive.getActiviteRecenteChantier(actif.id, 6);
      renderActivite(fichiers);
    } catch (err) {
      console.error("Erreur activité récente :", err);
      activiteList.innerHTML = `<div class="activite-empty">Erreur : ${err.message}</div>`;
    }
  }

  function renderActivite(fichiers) {
    const activiteList = document.getElementById("activiteList");
    if (!fichiers || fichiers.length === 0) {
      activiteList.innerHTML = '<div class="activite-empty">Aucune activité pour le moment.</div>';
      return;
    }

    const couleurs = ["blue", "red", "green", "yellow"];
    activiteList.innerHTML = fichiers
      .map((f, i) => {
        const date = new Date(f.modifiedTime);
        return `
        <div class="activite-item">
          <span class="activite-dot ${couleurs[i % couleurs.length]}"></span>
          <div class="activite-body">
            <div class="titre">${escapeHtml(f.name)}</div>
          </div>
          <div class="activite-time">${formatRelatif(date)}</div>
        </div>`;
      })
      .join("");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatRelatif(date) {
    const now = new Date();
    const jourDiff = Math.floor((now.setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86400000);
    const heure = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    if (jourDiff === 0) return `Auj. ${heure}`;
    if (jourDiff === 1) return `Hier ${heure}`;
    if (jourDiff < 7) return `${JOURS_SEMAINE[date.getDay()].slice(0, 3)}. ${heure}`;
    return date.toLocaleDateString("fr-FR");
  }

  function renderDateBanner() {
    const now = new Date();
    document.getElementById("dateBoxMois").textContent = MOIS_ABBR[now.getMonth()];
    document.getElementById("dateBoxJour").textContent = String(now.getDate()).padStart(2, "0");
    document.getElementById("dateMain").textContent = `${JOURS_SEMAINE[now.getDay()].charAt(0).toUpperCase()}${JOURS_SEMAINE[now.getDay()].slice(1)} ${now.getDate()} ${MOIS_ANNEE[now.getMonth()]} ${now.getFullYear()}`;
    const semaine = getNumeroSemaine(now);
    const dateSub = document.getElementById("dateSub");
    dateSub.dataset.base = `Semaine ${semaine}`;
    dateSub.textContent = `Semaine ${semaine}`;
  }

  function getNumeroSemaine(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  }

});
