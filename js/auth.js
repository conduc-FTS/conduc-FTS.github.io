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
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ].join(" ");

  const STORAGE_KEY = "fts_auth_token";

  let tokenClient = null;
  let accessToken = null;
  let onChangeCallbacks = [];

  function loadStoredToken() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed.expiresAt && Date.now() < parsed.expiresAt) {
        return parsed;
      }
      return null;
    } catch (e) {
      return null;
    }
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
    return cachedUserInfo;
  }

  function onAuthChange(callback) {
    onChangeCallbacks.push(callback);
  }

  /**
   * Initialise le client OAuth2 (nécessite le script Google Identity Services
   * chargé au préalable : https://accounts.google.com/gsi/client)
   */
  function init() {
    const stored = loadStoredToken();
    if (stored) {
      accessToken = stored.access_token;
    }

    if (typeof google === "undefined" || !google.accounts) {
      console.warn("FTSAuth : Google Identity Services non chargé. Ajouter le script GSI dans le HTML.");
      return;
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (tokenResponse) => {
        if (tokenResponse && tokenResponse.access_token) {
          storeToken(tokenResponse);
        }
      },
    });
  }

  function signIn() {
    if (!tokenClient) {
      console.warn("FTSAuth : tokenClient non initialisé. Appeler init() d'abord.");
      return;
    }
    tokenClient.requestAccessToken();
  }

  function signOut() {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    clearToken();
  }

  return {
    init,
    signIn,
    signOut,
    isSignedIn,
    getToken,
    getUserInfo,
    onAuthChange,
  };
})();
