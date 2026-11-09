/**
 * serveur-fts.js — Dépôt des documents de l'appli sur le serveur FTS (lecteur P:).
 *
 * Chrome / Edge sur un PC qui voit le serveur (bureau ou VPN) : le navigateur
 * écrit directement dans le dossier réseau, avec les droits Windows de la
 * personne (API File System Access). Rien ne passe par internet, aucun
 * identifiant serveur n'est demandé ni stocké.
 *
 * - « Relier le serveur » une fois par PC : on montre au navigateur le dossier
 *   P:\PARTAGE\FTS\7 - TRAVAUX\7-1 - CHANTIERS EN COURS. Le navigateur le
 *   mémorise (IndexedDB) et redemande « Autoriser » une fois par session.
 * - Le dossier chantier est retrouvé par son code (« 26 FTS 099 … » = 26FTS099).
 * - L'appli ne crée JAMAIS de dossier chantier, ne remplace ni ne supprime
 *   JAMAIS un fichier : un fichier déjà présent est laissé tel quel.
 * - Serveur inaccessible : les documents vont dans une file d'attente rangée
 *   dans les infos du chantier (Drive), avec l'identifiant de leur copie Drive ;
 *   « Déposer maintenant » les reprend depuis le Drive plus tard, depuis
 *   n'importe quel PC du bureau.
 */
const FTSServeur = (() => {
  const BASE = "fts-serveur";
  const DOSSIER_ATTENDU = "7-1 - CHANTIERS EN COURS";
  const LS_DOSSIER_PAR_CODE = "fts_serveur_dossiers_v1"; // code → nom du dossier choisi à la main

  // ─── Mémorisation du dossier relié (IndexedDB, propre à ce PC) ───
  function idb() {
    return new Promise((ok, ko) => {
      const r = indexedDB.open(BASE, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("h");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
  }
  async function lireHandle(cle) {
    try {
      const db = await idb();
      return await new Promise((ok) => {
        const q = db.transaction("h").objectStore("h").get(cle);
        q.onsuccess = () => ok(q.result || null);
        q.onerror = () => ok(null);
      });
    } catch (e) { return null; }
  }
  async function ecrireHandle(cle, h) {
    try {
      const db = await idb();
      await new Promise((ok) => {
        const t = db.transaction("h", "readwrite");
        t.objectStore("h").put(h, cle);
        t.oncomplete = ok; t.onerror = ok;
      });
    } catch (e) {}
  }

  const disponible = () => typeof window !== "undefined" && "showDirectoryPicker" in window && window.isSecureContext;
  const OPT = { mode: "readwrite" };

  /** Nom normalisé pour comparer les codes : « 26 FTS 099 » → « 26FTS099 » */
  const norm = (s) => String(s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s_.\-]/g, "");
  /** Code chantier pris en tête du nom du dossier Drive (« 26FTS099 SARLAT » → 26FTS099) */
  function codeDepuisNom(nom) {
    const s = String(nom || "").trim();
    const i = s.search(/\s/);
    return i > 0 ? s.slice(0, i) : s;
  }
  /** Le dossier commence-t-il par ce code (sans confondre 099 et 0990) ? */
  function correspond(nomDossier, code) {
    const n = norm(nomDossier), c = norm(code);
    return !!c && n.startsWith(c) && !/\d/.test(n.charAt(c.length));
  }

  /**
   * État du serveur sur ce PC.
   * @returns {Promise<"indisponible"|"non-relie"|"a-autoriser"|"relie">}
   */
  async function etat() {
    if (!disponible()) return "indisponible";
    const h = await lireHandle("racine");
    if (!h) return "non-relie";
    try { return (await h.queryPermission(OPT)) === "granted" ? "relie" : "a-autoriser"; }
    catch (e) { return "a-autoriser"; }
  }
  async function nomRacine() { const h = await lireHandle("racine"); return h ? h.name : ""; }

  /**
   * Montre la fenêtre de choix du dossier (clic de la personne obligatoire).
   * @returns {Promise<{ok:boolean, nom?:string, avert?:string, annule?:boolean}>}
   */
  async function relier() {
    if (!disponible()) throw new Error("Ce navigateur ne peut pas écrire sur le serveur : utilise Chrome ou Edge sur un ordinateur du bureau.");
    let h;
    try { h = await window.showDirectoryPicker({ id: "fts-serveur", mode: "readwrite" }); }
    catch (e) { if (e && e.name === "AbortError") return { ok: false, annule: true }; throw traduire(e); }
    if ((await h.queryPermission(OPT)) !== "granted" && (await h.requestPermission(OPT)) !== "granted") {
      return { ok: false, avert: "Le droit de modifier les fichiers a été refusé : rien n'a été relié." };
    }
    let nbChantiers = 0;
    for await (const [nom, e] of h.entries()) if (e.kind === "directory" && /^\d{2}\s*FTS/i.test(nom)) nbChantiers++;
    await ecrireHandle("racine", h);
    const avert = norm(h.name) !== norm(DOSSIER_ATTENDU) || !nbChantiers
      ? `Dossier relié : « ${h.name} » (${nbChantiers} dossier(s) chantier). Le dossier prévu est « ${DOSSIER_ATTENDU} » : vérifie que c'est le bon.`
      : "";
    return { ok: true, nom: h.name, nbChantiers, avert };
  }

  /**
   * Redonne l'autorisation (une fois par session). Doit être appelé juste
   * après un clic : le navigateur refuse sinon d'afficher la question.
   * @returns {Promise<FileSystemDirectoryHandle|null>} le dossier relié, ou null
   */
  async function autoriser() {
    if (!disponible()) return null;
    const h = await lireHandle("racine");
    if (!h) return null;
    try {
      if ((await h.queryPermission(OPT)) === "granted") return h;
      return (await h.requestPermission(OPT)) === "granted" ? h : null;
    } catch (e) { return null; }
  }
  /** Dossier relié, seulement s'il est déjà autorisé (sans rien demander) */
  async function racineAutorisee() {
    if (!disponible()) return null;
    const h = await lireHandle("racine");
    try { return h && (await h.queryPermission(OPT)) === "granted" ? h : null; } catch (e) { return null; }
  }

  function lireMemo() { try { return JSON.parse(localStorage.getItem(LS_DOSSIER_PAR_CODE) || "{}"); } catch (e) { return {}; } }
  function ecrireMemo(m) { try { localStorage.setItem(LS_DOSSIER_PAR_CODE, JSON.stringify(m)); } catch (e) {} }

  /**
   * Retrouve le dossier du chantier dans le dossier relié.
   * @returns {Promise<{etat:"ok", dossier, nom} | {etat:"plusieurs", choix:Array<{nom, dossier}>} | {etat:"introuvable"} | {etat:"non-relie"}>}
   */
  async function trouverChantier(code, racine) {
    const r = racine || (await racineAutorisee());
    if (!r) return { etat: "non-relie" };
    const memo = lireMemo()[norm(code)];
    const choix = [];
    for await (const [nom, e] of r.entries()) {
      if (e.kind !== "directory") continue;
      if (memo && nom === memo) return { etat: "ok", dossier: e, nom };
      if (correspond(nom, code)) choix.push({ nom, dossier: e });
    }
    if (choix.length === 1) return { etat: "ok", dossier: choix[0].dossier, nom: choix[0].nom };
    if (choix.length > 1) return { etat: "plusieurs", choix: choix.sort((a, b) => a.nom.localeCompare(b.nom, "fr")) };
    return { etat: "introuvable" };
  }
  /** Retient le dossier choisi parmi plusieurs pour ce code (sur ce PC) */
  function retenirChoix(code, nomDossier) { const m = lireMemo(); m[norm(code)] = nomDossier; ecrireMemo(m); }

  function traduire(e) {
    if (!e) return new Error("Erreur inconnue sur le serveur.");
    if (e.name === "NotAllowedError" || e.name === "SecurityError") return new Error("Le navigateur n'a pas l'autorisation d'écrire sur le serveur.");
    if (e.name === "NoModificationAllowedError") return new Error("Écriture refusée par le serveur : le fichier est peut-être ouvert sur un autre PC, ou tes droits sont en lecture seule. Ferme-le et réessaie.");
    if (e.name === "InvalidModificationError") return new Error("Le fichier est utilisé par une autre application (ouvert ?). Ferme-le et réessaie.");
    if (e.name === "NotFoundError") return new Error("Dossier introuvable sur le serveur (déplacé ou renommé ?).");
    return new Error(`${e.name || "Erreur"} : ${e.message || e}`);
  }
  async function existe(dir, nom) {
    try { await dir.getFileHandle(nom); return true; }
    catch (e) { if (e && e.name === "NotFoundError") return false; if (e && e.name === "TypeMismatchError") return true; throw e; }
  }

  /**
   * Dépose des fichiers dans un sous-dossier du dossier chantier.
   * Sous-dossiers créés s'ils manquent ; fichier déjà présent = laissé tel quel.
   * @param {FileSystemDirectoryHandle} dossierChantier
   * @param {string[]} chemin ex ["13 - Travaux", "PREPARATION CHANTIER"]
   * @param {Array<{nom:string, blob:Blob}>} fichiers
   * @returns {Promise<Array<{nom, statut:"depose"|"deja"|"erreur", erreur?:string}>>}
   */
  async function deposer(dossierChantier, chemin, fichiers) {
    let dir = dossierChantier;
    for (const part of chemin) {
      // Sous-dossier existant retrouvé sans tenir compte des majuscules / accents
      let trouve = null;
      for await (const [nom, e] of dir.entries()) if (e.kind === "directory" && norm(nom) === norm(part)) { trouve = e; break; }
      try { dir = trouve || (await dir.getDirectoryHandle(part, { create: true })); }
      catch (e) { throw traduire(e); }
    }
    const res = [];
    for (const f of fichiers) {
      try {
        if (await existe(dir, f.nom)) { res.push({ nom: f.nom, statut: "deja" }); continue; }
        const fh = await dir.getFileHandle(f.nom, { create: true });
        const w = await fh.createWritable();
        await w.write(f.blob); await w.close();
        res.push({ nom: f.nom, statut: "depose" });
      } catch (e) { res.push({ nom: f.nom, statut: "erreur", erreur: traduire(e).message }); }
    }
    return res;
  }

  // ─── File d'attente (infos du chantier dans le Drive) ───────────
  /** @returns {Promise<Array<{nom, chemin:string[], driveId, le, origine}>>} */
  async function lireAttente(chantierId) {
    const meta = await FTSDrive.getMetadonneesChantier(chantierId);
    return Array.isArray(meta.serveurAttente) ? meta.serveurAttente : [];
  }
  async function ajouterAttente(chantierId, items) {
    const meta = await FTSDrive.getMetadonneesChantier(chantierId);
    const liste = Array.isArray(meta.serveurAttente) ? meta.serveurAttente : [];
    const cle = (x) => x.chemin.join("/") + "/" + x.nom;
    const connus = new Set(liste.map(cle));
    items.forEach((x) => { if (x.driveId && !connus.has(cle(x))) liste.push({ ...x, le: x.le || new Date().toISOString() }); });
    await FTSDrive.setMetadonneesChantier(chantierId, { ...meta, serveurAttente: liste });
    return liste;
  }
  async function retirerAttente(chantierId, faits) {
    const cle = (x) => x.chemin.join("/") + "/" + x.nom;
    const ok = new Set(faits.map(cle));
    const meta = await FTSDrive.getMetadonneesChantier(chantierId);
    const liste = (Array.isArray(meta.serveurAttente) ? meta.serveurAttente : []).filter((x) => !ok.has(cle(x)));
    const m = { ...meta, serveurAttente: liste };
    if (!liste.length) delete m.serveurAttente;
    await FTSDrive.setMetadonneesChantier(chantierId, m);
    return liste;
  }

  /**
   * Dépose les documents en attente d'un chantier (repris depuis leur copie Drive).
   * @returns {Promise<{deposes:number, deja:number, erreurs:Array, reste:number}>}
   */
  async function traiterAttente(chantierId, dossierChantier) {
    const liste = await lireAttente(chantierId);
    const faits = [], erreurs = [];
    let deposes = 0, deja = 0;
    for (const it of liste) {
      try {
        const blob = await FTSDrive.downloadFileBlob(it.driveId);
        const [r] = await deposer(dossierChantier, it.chemin, [{ nom: it.nom, blob }]);
        if (r.statut === "erreur") { erreurs.push({ nom: it.nom, erreur: r.erreur }); continue; }
        if (r.statut === "depose") deposes++; else deja++;
        faits.push(it);
      } catch (e) { erreurs.push({ nom: it.nom, erreur: (e && e.message) || String(e) }); }
    }
    const reste = faits.length ? (await retirerAttente(chantierId, faits)).length : liste.length;
    return { deposes, deja, erreurs, reste };
  }

  // ─── Choix parmi plusieurs dossiers / dossier introuvable ───────
  const esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  /**
   * Fenêtre « plusieurs dossiers commencent par ce code ».
   * @returns {Promise<{nom, dossier}|null>}
   */
  function demanderChoix(code, choix) {
    return new Promise((ok) => {
      const { el, fermer } = FTSShell.modale({
        titre: `Plusieurs dossiers « ${esc(code)} » sur le serveur`,
        corps: `<p style="margin:0 0 10px">Choisis le dossier du chantier. Ce choix est retenu sur ce PC.</p>
          ${choix.map((c, i) => `<label style="display:flex;gap:8px;padding:6px 0;font-weight:600"><input type="radio" name="srvChoix" value="${i}" ${i ? "" : "checked"}> 📁 ${esc(c.nom)}</label>`).join("")}`,
        pied: `<button type="button" class="sv-btn" data-x>Plus tard</button><button type="button" class="sv-btn pri" id="srvChoixOk">Continuer</button>`,
      });
      let fini = false;
      const fin = (v) => { if (fini) return; fini = true; fermer(); ok(v); };
      el.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", () => fin(null)));
      el.querySelector("#srvChoixOk").addEventListener("click", () => {
        const i = Number((el.querySelector("input[name=srvChoix]:checked") || {}).value || 0);
        retenirChoix(code, choix[i].nom);
        fin(choix[i]);
      });
      el.addEventListener("click", (e) => { if (e.target === el) fin(null); });
    });
  }

  /**
   * Retrouve le dossier chantier en demandant à la personne si besoin.
   * À appeler juste après un clic (l'autorisation peut être redemandée).
   * @returns {Promise<{ok:true, dossier, nom} | {ok:false, raison:"indisponible"|"non-relie"|"refus"|"introuvable"|"annule", message:string}>}
   */
  async function dossierChantier(code) {
    const st = await etat();
    if (st === "indisponible") return { ok: false, raison: "indisponible", message: "Ce navigateur n'écrit pas sur le serveur (Chrome ou Edge sur un PC du bureau)." };
    if (st === "non-relie") return { ok: false, raison: "non-relie", message: "Le serveur n'est pas encore relié sur ce PC (bouton « Relier le serveur » en haut)." };
    const r = await autoriser();
    if (!r) return { ok: false, raison: "refus", message: "Autorisation du serveur non donnée." };
    let t;
    try { t = await trouverChantier(code, r); }
    catch (e) { return { ok: false, raison: "indisponible", message: "Serveur FTS non accessible depuis ce PC (pas de VPN ?)." }; }
    if (t.etat === "ok") return { ok: true, dossier: t.dossier, nom: t.nom };
    if (t.etat === "plusieurs") {
      const c = await demanderChoix(code, t.choix);
      return c ? { ok: true, dossier: c.dossier, nom: c.nom } : { ok: false, raison: "annule", message: "Dépôt remis à plus tard." };
    }
    return { ok: false, raison: "introuvable", message: `Aucun dossier « ${code} » dans « ${r.name} ». Il a peut-être été déplacé (chantier ancien) ou pas encore créé : l'appli ne crée jamais de dossier chantier.` };
  }

  // ─── Voyant de la barre du haut ─────────────────────────────────
  const LIB = {
    relie: ["ok", "🗄️ Serveur", "Serveur FTS relié sur ce PC. Clic : changer de dossier."],
    "a-autoriser": ["att", "🗄️ Autoriser", "Serveur FTS : le navigateur redemande l'autorisation une fois par session. Clic : autoriser."],
    "non-relie": ["non", "🗄️ Relier le serveur", `Serveur FTS pas encore relié sur ce PC. Clic : montrer une fois le dossier P:\\PARTAGE\\FTS\\7 - TRAVAUX\\${DOSSIER_ATTENDU}`],
  };
  /** Ajoute le voyant serveur dans un conteneur (barre du haut). Rien sur tablette / téléphone. */
  async function monterVoyant(conteneur) {
    if (!conteneur || !disponible() || window.matchMedia("(max-width: 820px)").matches) return;
    if (!document.getElementById("srvVoyantCss")) {
      const s = document.createElement("style");
      s.id = "srvVoyantCss";
      s.textContent = `.srv-v{border:1px solid var(--border);background:#fff;border-radius:20px;padding:6px 12px;font-weight:700;font-size:.78rem;cursor:pointer;font-family:inherit;white-space:nowrap;color:var(--text-main)}
        .srv-v.ok{background:#EAF6EE;border-color:#BFE3CB;color:#1D6E3E}.srv-v.att{background:#FFF3DC;border-color:#F1D9A6;color:#8A5A00}.srv-v.non{background:var(--fts-yellow);border-color:var(--fts-yellow);color:#1E1E1E}`;
      document.head.appendChild(s);
    }
    const b = document.createElement("button");
    b.type = "button"; b.id = "srvVoyant";
    conteneur.prepend(b);
    const maj = async () => {
      const st = await etat();
      const [cls, lib, titre] = LIB[st] || LIB["non-relie"];
      b.className = "srv-v " + cls; b.textContent = lib;
      b.title = st === "relie" ? `${titre}\nDossier : ${await nomRacine()}` : titre;
      b.dataset.etat = st;
    };
    b.addEventListener("click", async () => {
      const toast = (m) => (typeof FTSShell !== "undefined" ? FTSShell.toast(m, 4200) : alert(m));
      try {
        if (b.dataset.etat === "a-autoriser") {
          toast((await autoriser()) ? "✅ Serveur FTS autorisé pour cette session" : "Autorisation non donnée");
        } else {
          const r = await relier();
          if (r.ok) toast(r.avert || `✅ Serveur relié : ${r.nom} (${r.nbChantiers} chantiers)`);
          else if (r.avert) toast(r.avert);
        }
      } catch (e) { toast("⚠️ " + e.message); }
      await maj();
      document.dispatchEvent(new CustomEvent("fts-serveur-change"));
    });
    await maj();
  }

  return {
    DOSSIER_ATTENDU, disponible, etat, relier, autoriser, racineAutorisee, trouverChantier, retenirChoix,
    dossierChantier, deposer, lireAttente, ajouterAttente, retirerAttente, traiterAttente,
    monterVoyant, codeDepuisNom, correspond, norm,
  };
})();
