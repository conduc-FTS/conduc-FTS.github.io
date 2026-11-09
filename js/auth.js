/**
 * auth.js — Module d'authentification partagé FTS
 *
 * Objectif : centraliser la connexion Google OAuth2 pour que le dashboard
 * ET les modules (rapport, accueil intérimaire, accueil sécurité, fiche matériel)
 * consomment le même token, au lieu de chaque PWA gérant sa propre session.
 *
 * À terme : ce fichier doit être servi depuis la racine du site
 * (conduc-FTS.github.io/js/auth.js) et importé par chaque module.
 *
 * Config actuelle (cf. mémoire projet) :
 *   Client ID : 57374487071-p0n3ronlmqt8gcdvo409rlotcobhnpp8.apps.googleusercontent.com
 *   Project ID : beaming-surfer-500313-r8
 *   Scopes nécessaires : Drive (déjà en place), Gmail (à ajouter si on choisit
 *   l'envoi automatique pour Fiche Matériel — décision en attente)
 */

const FTSAuth = (() => {
  const CLIENT_ID = "57374487071-p0n3ronlmqt8gcdvo409rlotcobhnpp8.apps.googleusercontent.com";

  // Scopes nécessaires à l'ensemble des modules FTS :
  // - Drive : ouverture de chantier, notifications, archivage rapports/accueils/fiche matériel
  // - Gmail send : envoi de la fiche matériel par mail
  // - email/profile : afficher le nom du conducteur/chef connecté dans l'en-tête
  const SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ].join(" ");

  const STORAGE_KEY = "fts_auth_token";
  const EMAIL_KEY = "fts_auth_email";

  function emailMemorise() {
    try { return localStorage.getItem(EMAIL_KEY) || ""; } catch (e) { return ""; }
  }

  let tokenClient = null;
  let accessToken = null;
  let onChangeCallbacks = [];

  function chargerTokenBrut() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function loadStoredToken() {
    const parsed = chargerTokenBrut();
    if (parsed && parsed.expiresAt && Date.now() < parsed.expiresAt) {
      return parsed;
    }
    return null;
  }

  function storeToken(tokenResponse) {
    const expiresAt = Date.now() + (tokenResponse.expires_in * 1000);
    const toStore = {
      access_token: tokenResponse.access_token,
      expiresAt,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    accessToken = toStore.access_token;
    notifyChange();
  }

  function clearToken() {
    localStorage.removeItem(STORAGE_KEY);
    accessToken = null;
    cachedUserInfo = null;
    notifyChange();
  }

  function notifyChange() {
    onChangeCallbacks.forEach((cb) => cb(isSignedIn()));
  }

  function isSignedIn() {
    return !!accessToken;
  }

  function getToken() {
    return accessToken;
  }

  let cachedUserInfo = null;

  /**
   * Récupère nom/email de la personne connectée (mis en cache pour la
   * session). Utilisé pour afficher "DUPONT Jean" + avatar dans l'en-tête.
   */
  async function getUserInfo() {
    if (cachedUserInfo) return cachedUserInfo;
    if (!isSignedIn()) return null;

    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!res.ok) return null;
    cachedUserInfo = await res.json(); // { name, email, given_name, family_name, picture, ... }
    // Mémorisé pour la reconnexion en un clic (voir signIn) : Google
    // reconnaît alors directement le compte, sans écran de choix.
    try { if (cachedUserInfo.email) localStorage.setItem(EMAIL_KEY, cachedUserInfo.email); } catch (e) {}
    return cachedUserInfo;
  }

  /**
   * Google donne un accès valable ~1h, sans renouvellement automatique
   * intégré. Sans ceci, quiconque revient sur l'appli plus d'une heure
   * après sa dernière connexion se retrouve déconnecté à chaque fois.
   * On tente donc un renouvellement silencieux (sans redemander de
   * cliquer) dès qu'on détecte une session expirée — ça ne marche pas
   * à 100% du temps (dépend des réglages de cookies du navigateur),
   * mais ça réduit nettement la fréquence des déconnexions ressenties.
   */
  let renouvellementEnCours = false;
  let renouvellementTimer = null;
  let verificationPeriodiqueDemarree = false;
  let silencieuxTentePour = 0;   // expiresAt du token pour lequel on a déjà tenté
  let clicArme = false;
  let derniereDemande = 0;

  // Renouvellement anticipé : on s'y prend 10 min avant la fin de l'heure,
  // pendant que l'accès est encore valable, pour ne jamais "décrocher".
  const MARGE_RENOUVELLEMENT = 10 * 60 * 1000;

  function optionsRenouvellement(prompt) {
    // Le compte mémorisé est donné à Google : sans lui, si le navigateur a
    // plusieurs comptes Google (pro + perso), Google ne sait pas lequel
    // choisir et le renouvellement échoue.
    const email = emailMemorise();
    const o = { prompt };
    if (email) { o.hint = email; o.login_hint = email; }
    return o;
  }

  function lancerDemande(prompt) {
    if (!tokenClient || renouvellementEnCours) return false;
    renouvellementEnCours = true;
    derniereDemande = Date.now();
    // Sécurité : si Google ne répond jamais (fenêtre bloquée sans erreur),
    // on libère le verrou pour pouvoir réessayer.
    clearTimeout(renouvellementTimer);
    renouvellementTimer = setTimeout(() => { renouvellementEnCours = false; }, 30000);
    try {
      tokenClient.requestAccessToken(optionsRenouvellement(prompt));
    } catch (e) {
      renouvellementEnCours = false;
      return false;
    }
    return true;
  }

  function tenterRenouvellementSilencieux() {
    lancerDemande("none");
  }

  // Le navigateur bloque souvent la fenêtre Google quand elle s'ouvre
  // toute seule (sans clic). Donc, quand l'accès arrive en fin de vie, on
  // profite du prochain clic / toucher de l'utilisateur, n'importe où dans
  // l'appli, pour renouveler : la fenêtre Google s'ouvre et se referme seule.
  function armerRenouvellementAuClic() {
    if (clicArme) return;
    clicArme = true;
    const surClic = () => {
      document.removeEventListener("pointerdown", surClic, true);
      clicArme = false;
      if (!besoinRenouvellement()) return;
      lancerDemande("");
    };
    document.addEventListener("pointerdown", surClic, true);
  }

  function besoinRenouvellement() {
    const stored = chargerTokenBrut();
    if (!stored || !stored.expiresAt) return false;
    return stored.expiresAt - Date.now() < MARGE_RENOUVELLEMENT;
  }

  function verifierSession() {
    const stored = chargerTokenBrut();
    if (!stored || !stored.expiresAt) return;
    const reste = stored.expiresAt - Date.now();
    if (reste <= 0) {
      // Vraiment expiré : on bascule en "déconnecté" (la page affiche alors
      // son bouton de reconnexion) et on tente quand même en silence.
      if (accessToken) { accessToken = null; notifyChange(); }
      if (silencieuxTentePour !== stored.expiresAt) {
        silencieuxTentePour = stored.expiresAt;
        tenterRenouvellementSilencieux();
      }
      armerRenouvellementAuClic();
    } else if (reste < MARGE_RENOUVELLEMENT) {
      // Encore valable : on garde l'accès actuel pendant le renouvellement.
      if (silencieuxTentePour !== stored.expiresAt) {
        silencieuxTentePour = stored.expiresAt;
        tenterRenouvellementSilencieux();
      }
      armerRenouvellementAuClic();
    }
  }

  function demarrerVerificationPeriodique() {
    if (verificationPeriodiqueDemarree) return;
    verificationPeriodiqueDemarree = true;
    // Vérifie toutes les 30 s : utile si la page reste ouverte longtemps
    // (tablette laissée allumée toute la journée) sans être rechargée.
    setInterval(verifierSession, 30000);
    // Retour sur l'appli (sortie de veille, changement d'onglet/appli) :
    // les minuteries sont souvent gelées pendant la veille, on revérifie.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") verifierSession();
    });
    window.addEventListener("focus", verifierSession);
  }

  function onAuthChange(callback) {
    onChangeCallbacks.push(callback);
  }

  /**
   * Initialise le client OAuth2 (nécessite le script Google Identity Services
   * chargé au préalable : https://accounts.google.com/gsi/client)
   */
  function init() {
    const brutAvantExpiration = chargerTokenBrut(); // pour savoir si une session existait avant, même expirée
    const stored = loadStoredToken();
    if (stored) {
      accessToken = stored.access_token;
    }

    // Le script Google (accounts.google.com/gsi/client) est chargé en
    // async/defer : il peut ne pas encore être prêt au moment où init()
    // est appelé au chargement de la page. On réessaie automatiquement
    // toutes les 100ms pendant quelques secondes plutôt que d'abandonner,
    // pour éviter que le bouton "Se connecter" ne reste silencieusement
    // inopérant tant que la page n'est pas rechargée.
    if (typeof google === "undefined" || !google.accounts) {
      if (!window.__ftsAuthInitRetries) window.__ftsAuthInitRetries = 0;
      if (window.__ftsAuthInitRetries < 100) { // ~10 secondes max
        window.__ftsAuthInitRetries++;
        setTimeout(init, 100);
      } else {
        console.warn("FTSAuth : Google Identity Services n'a pas pu être chargé après plusieurs tentatives.");
      }
      return;
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (tokenResponse) => {
        renouvellementEnCours = false;
        clearTimeout(renouvellementTimer);
        if (tokenResponse && tokenResponse.access_token) {
          storeToken(tokenResponse);
        } else {
          // Le renouvellement silencieux a échoué (pas de session Google
          // active, cookies tiers bloqués...) : il faudra recliquer sur
          // "Se connecter" — pas d'erreur bruyante, c'est un cas normal.
          notifyChange();
        }
      },
      error_callback: () => {
        renouvellementEnCours = false;
        clearTimeout(renouvellementTimer);
        notifyChange();
      },
    });

    demarrerVerificationPeriodique();

    // Une session existait avant (même expirée maintenant) : on tente de
    // la renouveler silencieusement plutôt que d'attendre un clic manuel,
    // et le premier clic dans l'appli fera la reconnexion si besoin.
    if (brutAvantExpiration && !accessToken) {
      silencieuxTentePour = brutAvantExpiration.expiresAt || 0;
      tenterRenouvellementSilencieux();
      armerRenouvellementAuClic();
    } else {
      verifierSession();
    }
  }

  // Appli ouverte sans réseau : le script Google n'a pas pu se charger.
  // Au retour du réseau, on le recharge et on relance la connexion
  // silencieuse — sinon les rapports en attente ne pourraient pas partir
  // sans recharger la page.
  window.addEventListener("online", () => {
    if (typeof google === "undefined" || !google.accounts) {
      if (document.querySelector("script[data-fts-gsi]")) return;
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.dataset.ftsGsi = "1";
      s.onload = () => { window.__ftsAuthInitRetries = 0; init(); };
      s.onerror = () => s.remove();
      document.head.appendChild(s);
    } else if (!accessToken) {
      tenterRenouvellementSilencieux();
    }
  });

  function signIn() {
    if (!tokenClient) {
      console.warn("FTSAuth : tokenClient non initialisé. Appeler init() d'abord.");
      return;
    }
    // Compte déjà connu sur cet appareil : on le donne à Google (hint) pour
    // sauter l'écran de choix du compte — la reconnexion se fait alors en
    // un clic, la fenêtre Google s'ouvre et se referme seule.
    // Le même clic vient peut-être déjà de lancer le renouvellement
    // (voir armerRenouvellementAuClic) : pas de deuxième fenêtre Google.
    if (renouvellementEnCours && Date.now() - derniereDemande < 3000) return;
    const email = emailMemorise();
    renouvellementEnCours = true;
    derniereDemande = Date.now();
    clearTimeout(renouvellementTimer);
    renouvellementTimer = setTimeout(() => { renouvellementEnCours = false; }, 30000);
    tokenClient.requestAccessToken(email ? { hint: email, login_hint: email, prompt: "" } : {});
  }

  /** Une session a déjà existé sur cet appareil (même expirée). */
  function sessionConnue() {
    return !!chargerTokenBrut() || !!emailMemorise();
  }

  function signOut() {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    clearToken();
    try { localStorage.removeItem(EMAIL_KEY); } catch (e) {}
  }

  return {
    sessionConnue,
    emailMemorise,
    init,
    signIn,
    signOut,
    isSignedIn,
    getToken,
    getUserInfo,
    onAuthChange,
  };
})();

// Exposition explicite sur window : une déclaration top-level en const/let
// ne crée PAS de propriété window.FTSAuth automatiquement (contrairement à var),
// alors que tout le reste du code vérifie window.FTSAuth avant utilisation.
window.FTSAuth = FTSAuth;
