/**
 * module-common.js — Utilitaires partagés par Rapport Journalier,
 * Accueil Intérimaire et Accueil Sécurité.
 */

const FTSCommon = (() => {
  const CHANTIER_ACTIF_KEY = "fts_chantier_actif";

  function getChantierActif() {
    try {
      const raw = localStorage.getItem(CHANTIER_ACTIF_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Affiche la bannière chantier actif en haut de page, ou un avertissement
   * si aucun chantier n'est sélectionné (renvoie vers le dashboard).
   * @param {string} bannerElId
   * @returns {{id:string,name:string}|null}
   */
  function afficherBanniereChantier(bannerElId) {
    const el = document.getElementById(bannerElId);
    const actif = getChantierActif();
    if (!el) return actif;

    if (actif) {
      el.classList.remove("missing");
      el.textContent = `Chantier actif : ${actif.name}`;
    } else {
      el.classList.add("missing");
      el.innerHTML = `Aucun chantier actif. <a href="/index.html">Retourner au dashboard pour en choisir un</a>.`;
    }
    return actif;
  }

  let toastTimer;
  function showToast(msg, type) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "show" + (type ? " " + type : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ""), type === "error" ? 4000 : 3000);
  }

  function formatDate(d) {
    if (!d) return "";
    const [y, m, j] = d.split("-");
    return `${j}/${m}/${y}`;
  }

  function todayISO() {
    return new Date().toISOString().split("T")[0];
  }

  return { getChantierActif, afficherBanniereChantier, showToast, formatDate, todayISO };
})();
