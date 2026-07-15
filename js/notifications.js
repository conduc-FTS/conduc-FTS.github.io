/**
 * notifications.js — Cloche de notification Drive
 *
 * Objectif : détecter les changements récents dans les dossiers chantier
 * (nouveaux rapports, nouvelles fiches) et les afficher dans la cloche.
 *
 * Stratégie prévue : Drive API `changes.list` avec un pageToken stocké
 * (localStorage) pour ne récupérer que les nouveautés depuis la dernière
 * visite, plutôt que de re-scanner tous les dossiers à chaque fois.
 *
 * Pour l'instant : stub qui affiche une liste vide et se branche sur
 * l'état de connexion (FTSAuth). La logique d'appel Drive réelle sera
 * ajoutée une fois l'auth validée en prod.
 */

const FTSNotifications = (() => {
  let notifications = [];

  function render() {
    const badge = document.getElementById("notifBadge");
    const list = document.getElementById("notifList");
    if (!badge || !list) return;

    if (notifications.length === 0) {
      badge.hidden = true;
      list.innerHTML = '<li class="notif-empty">Aucune notification pour le moment.</li>';
      return;
    }

    badge.hidden = false;
    badge.textContent = notifications.length;
    list.innerHTML = notifications
      .map((n) => `<li class="notif-item"><strong>${n.title}</strong><br><span>${n.detail}</span></li>`)
      .join("");
  }

  /**
   * À brancher plus tard sur Drive changes.list.
   * Exemple de forme attendue pour chaque notification :
   * { title: "Nouveau rapport", detail: "CAP8000 — 10/07/2026" }
   */
  async function poll() {
    if (!window.FTSAuth || !FTSAuth.isSignedIn()) {
      notifications = [];
      render();
      return;
    }
    // TODO : appel réel à l'API Drive ici (changes.list avec pageToken stocké)
    render();
  }

  function init() {
    render();
    if (window.FTSAuth) {
      FTSAuth.onAuthChange(() => poll());
    }
    // Polling toutes les 2 minutes une fois branché
    setInterval(poll, 120000);
  }

  return { init, poll };
})();
