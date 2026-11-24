/**
 * serveur-fts.js — Dépôt des documents de l'appli sur le serveur FTS (lecteur P:).
 *
 * Chrome / Edge sur un PC qui voit le serveur (bureau ou VPN) : le navigateur
 * écrit directement dans le dossier réseau, avec les droits Windows de la
 * personne (API File System Access). Rien ne passe par internet, aucun
 * identifiant serveur n'est demandé ni stocké.
 *
 * - « Relier le serveur » une fois par PC : on montre au navigateur le dossier
 *   P:\PARTAGE\FTS\7 - TRAVAUX. Le navigateur le mémorise (IndexedDB) et
 *   redemande « Autoriser » une fois par session. (Un PC relié à l'ancienne
 *   façon, directement à 7-1, continue de marcher pour les chantiers de 7-1.)
 * - Le dossier chantier est retrouvé par son code (« 26 FTS 099 … » = 26FTS099)
 *   dans 7-1 - CHANTIERS EN COURS (micropieux, battage) puis 7-6 - CHANTIERS
 *   PIEUX. Introuvable (déplacé, rangé ailleurs) : on peut le choisir à la main,
 *   choix retenu pour ce chantier sur ce PC.
 * - L'appli ne crée JAMAIS de dossier chantier, ne remplace ni ne supprime
 *   JAMAIS un fichier : un fichier déjà présent est laissé tel quel.
 * - Serveur inaccessible : les documents vont dans une file d'attente rangée
 *   dans les infos du chantier (Drive), avec l'identifiant de leur copie Drive ;
 *   « Déposer maintenant » les reprend depuis le Drive plus tard, depuis
 *   n'importe quel PC du bureau.
 */
const FTSServeur = (() => {
  const BASE = "fts-serveur";
  const DOSSIER_ATTENDU = "7 - TRAVAUX";
  const CHEMIN_ATTENDU = "P:\\PARTAGE\\FTS\\7 - TRAVAUX";
  /** Sous-dossiers de 7 - TRAVAUX où sont rangés les chantiers, dans l'ordre de recherche */
  const ZONES = [
    { nom: "7-1 - CHANTIERS EN COURS", cle: "71CHANTIERS" },  // micropieux, battage
    { nom: "7-6 - CHANTIERS PIEUX", cle: "76CHANTIERS" },     // pieux
  ];
  const LS_DOSSIER_PAR_CODE = "fts_serveur_dossiers_v1"; // code → nom du dossier choisi parmi plusieurs
  const CLE_MANUEL = "chantier:"; // + code : dossier du chantier choisi à la main (IndexedDB)

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
    if (estDossierChantier(h.name)) return "mal-relie";
    try { return (await h.queryPermission(OPT)) === "granted" ? "relie" : "a-autoriser"; }
    catch (e) { return "a-autoriser"; }
  }
  /** Nom d'un dossier chantier (« 25 FTS 825 BORDEAUX… ») et non du dossier qui les contient tous */
  function estDossierChantier(nom) { return /^\d{2}\s*FTS\s*\d/i.test(String(nom || "").trim()); }
  const cleZone = (nom) => ZONES.find((z) => norm(nom).startsWith(z.cle));
  /**
   * Dossiers où chercher les chantiers : 7-1 et 7-6 si le dossier relié est
   * 7 - TRAVAUX ; le dossier relié lui-même s'il contient directement des
   * chantiers (ancien réglage : relié à 7-1).
   * @returns {Promise<Array<{nom:string, dossier}>>}
   */
  async function zonesDe(r) {
    const trouvees = [];
    for await (const [nom, e] of r.entries()) {
      if (e.kind !== "directory" || !cleZone(nom)) continue;
      // 7-6 - CHANTIERS PIEUX range ses chantiers un cran plus bas, dans « 01-Chantiers en cours » (24/11/2026)
      let dossier = e, libelle = nom;
      for await (const [n2, e2] of e.entries()) if (e2.kind === "directory" && /^\d{1,2}CHANTIERSENCOURS/.test(norm(n2))) { dossier = e2; libelle = `${nom} › ${n2}`; break; }
      trouvees.push({ nom: libelle, dossier, rang: ZONES.indexOf(cleZone(nom)), cle: cleZone(nom).cle });
    }
    if (trouvees.length) return trouvees.sort((a, b) => a.rang - b.rang);
    return [{ nom: r.name, dossier: r, cle: (cleZone(r.name) || {}).cle || "" }];
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
    if (estDossierChantier(h.name)) {
      return { ok: false, avert: `« ${h.name} » est le dossier d'un chantier. Il faut choisir « ${DOSSIER_ATTENDU} », le dossier qui contient 7-1 et 7-6. Rien n'a été relié.` };
    }
    const zones = await zonesDe(h);
    let nbChantiers = 0;
    for (const z of zones) for await (const [nom, e] of z.dossier.entries()) if (e.kind === "directory" && estDossierChantier(nom)) nbChantiers++;
    if (!nbChantiers) {
      return { ok: false, avert: `Aucun dossier chantier trouvé dans « ${h.name} ». Il faut choisir « ${DOSSIER_ATTENDU} » (${CHEMIN_ATTENDU}). Rien n'a été relié.` };
    }
    await ecrireHandle("racine", h);
    const complet = zones.length === ZONES.length;
    const avert = complet ? ""
      : `Relié à « ${h.name} » : seuls les chantiers de ce dossier seront trouvés. Pour trouver aussi les ${cleZone(h.name) === ZONES[1] ? "micropieux et le battage" : "pieux"}, relie plutôt « ${DOSSIER_ATTENDU} ».`;
    return { ok: true, nom: h.name, nbChantiers, avert, zones: zones.map((z) => z.nom) };
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
    // 1. Dossier choisi à la main pour ce chantier sur ce PC
    const manuel = await lireHandle(CLE_MANUEL + norm(code));
    if (manuel) return { etat: "ok", dossier: manuel, nom: manuel.name, zone: "choisi à la main", manuel: true };
    // 2. Recherche par le code dans 7-1 puis 7-6
    const memo = lireMemo()[norm(code)];
    const choix = [];
    for (const z of await zonesDe(r)) {
      for await (const [nom, e] of z.dossier.entries()) {
        if (e.kind !== "directory") continue;
        if (memo && nom === memo) return { etat: "ok", dossier: e, nom, zone: z.nom };
        if (correspond(nom, code)) choix.push({ nom, dossier: e, zone: z.nom });
      }
    }
    if (choix.length === 1) return { etat: "ok", dossier: choix[0].dossier, nom: choix[0].nom, zone: choix[0].zone };
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

  /**
   * Un fichier existe-t-il déjà dans un sous-dossier du dossier chantier ?
   * (rien n'est créé : sous-dossier absent = fichier absent)
   */
  async function existeDans(dossierChantier, chemin, nomFichier) {
    let dir = dossierChantier;
    for (const part of chemin) {
      let trouve = null;
      for await (const [nom, e] of dir.entries()) if (e.kind === "directory" && norm(nom) === norm(part)) { trouve = e; break; }
      if (!trouve) return false;
      dir = trouve;
    }
    try { return await existe(dir, nomFichier); } catch (e) { throw traduire(e); }
  }

  // ─── Création du dossier chantier depuis la trame (Ouverture, 24/11/2026) ───
  // Trame micropieux : « xx FTS xx trame » dans 7-1 ; trame pieux : « 00 FTS 000 Arborescence
  // chantiers pieux… » dans 7-6 › 01-Chantiers en cours. Copiée telle quelle (les modifications
  // de la trame suivent toutes seules), sauf la fiche d'affaire acquise Excel (remplacée par le PDF).
  const estTrame = (nom) => /^(xx|00)\s*FTS\s*(xx|0+)\b/i.test(String(nom || "").trim());
  const PREFIXE_TRAME = /^(xx|\d{2})\s*FTS\s*(x{2,3}|0{3})\b\s*/i;
  const espacerCode = (code) => String(code || "").toUpperCase().replace(/\s+/g, "").replace(/^(\d{2})FTS(\d+)$/, "$1 FTS $2");
  /** « 26 FTS 343 CLINIQUE HONORE » : code avec espaces + nom, SANS ACCENTS (règle FTS, 24/11/2026), sans caractères interdits par Windows */
  const sansAccents = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/Œ/g, "OE").replace(/œ/g, "oe").replace(/Æ/g, "AE").replace(/æ/g, "ae");
  function nomDossierServeur(code, nom) {
    return `${espacerCode(code)} ${sansAccents(nom).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim()}`.trim().replace(/[. ]+$/, "");
  }
  /** Zone de rangement : "71" (micropieux, battage) ou "76" (pieux) */
  const zoneParCle = async (r, z) => (await zonesDe(r)).find((x) => x.cle === (z === "76" ? "76CHANTIERS" : "71CHANTIERS")) || null;
  async function copierDossier(src, dst, code, compte) {
    for await (const [nom, e] of src.entries()) {
      if (e.kind === "directory") {
        const d = await dst.getDirectoryHandle(nom, { create: true }); compte.dossiers++;
        await copierDossier(e, d, code, compte);
      } else {
        if (/FICHE\s*(D.)?\s*AFFAIRE\s*ACQUISE/i.test(nom)) continue; // remplacée par la fiche PDF de l'appli
        if (/\.lnk$/i.test(nom) || /- Raccourci$/i.test(nom)) continue; // raccourcis Windows de la trame (pointent vers un autre chantier)
        const cible = nom.replace(PREFIXE_TRAME, espacerCode(code) + " ");
        if (await existe(dst, cible)) continue;
        const fh = await dst.getFileHandle(cible, { create: true });
        const w = await fh.createWritable();
        await w.write(await e.getFile()); await w.close(); compte.fichiers++;
      }
    }
  }
  /**
   * Crée le dossier du chantier sur le serveur en copiant la trame de la zone.
   * Le dossier relié doit être autorisé (appeler autoriser() sur un clic avant).
   * Dossier déjà présent pour ce code (7-1 ou 7-6) : rien n'est copié, il est renvoyé.
   * @param {{code:string, nomDossier:string, zone:"71"|"76"}} o
   * @returns {Promise<{ok:true, existait:boolean, dossier, nom:string, chemin:string, dossiers:number, fichiers:number}>}
   */
  async function creerDossierChantier({ code, nomDossier, zone }) {
    const r = await racineAutorisee();
    if (!r) throw new Error("Serveur FTS pas relié ou pas autorisé sur ce PC.");
    try {
      const t = await trouverChantier(code, r);
      if (t.etat === "ok") return { ok: true, existait: true, dossier: t.dossier, nom: t.nom, chemin: `${t.zone || ""} › ${t.nom}`, dossiers: 0, fichiers: 0 };
      if (t.etat === "plusieurs") throw new Error(`Plusieurs dossiers « ${code} » existent déjà sur le serveur : rien n'a été créé.`);
      const z = await zoneParCle(r, zone);
      if (!z) throw new Error(`Dossier ${zone === "76" ? "7-6 - CHANTIERS PIEUX" : "7-1 - CHANTIERS EN COURS"} introuvable : relie « ${DOSSIER_ATTENDU} » sur ce PC.`);
      let trame = null;
      for await (const [nom, e] of z.dossier.entries()) if (e.kind === "directory" && estTrame(nom)) { trame = e; break; }
      if (!trame) throw new Error(`Trame introuvable dans ${z.nom} (dossier « xx FTS xx trame » ou « 00 FTS 000 … »).`);
      const dossier = await z.dossier.getDirectoryHandle(nomDossier, { create: true });
      const compte = { dossiers: 0, fichiers: 0 };
      await copierDossier(trame, dossier, code, compte);
      return { ok: true, existait: false, dossier, nom: nomDossier, chemin: `${z.nom} › ${nomDossier}`, ...compte };
    } catch (e) { throw e && e.name && e.name !== "Error" ? traduire(e) : e; }
  }
  /**
   * Sous-dossier du devis dans le dossier chantier : « 1 - Marché › 1.3 Devis marché » (trame
   * micropieux) ; sinon le sous-dossier « devis » du dossier marché (« 01 - Marché »…), sinon le
   * dossier marché lui-même, sinon la racine du chantier. Aucun dossier n'est inventé.
   */
  async function cheminDevis(dossierChantier) {
    try {
      for await (const [n1, e1] of dossierChantier.entries()) {
        if (e1.kind !== "directory" || !/^0?1MARCHE/.test(norm(n1))) continue;
        for await (const [n2, e2] of e1.entries()) if (e2.kind === "directory" && /DEVIS/.test(norm(n2))) return [n1, n2];
        return [n1];
      }
    } catch (e) {}
    return [];
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
        const chemin = it.chemin[0] === "@devis" ? await cheminDevis(dossierChantier) : it.chemin;
        const [r] = await deposer(dossierChantier, chemin, [{ nom: it.nom, blob }]);
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
          ${choix.map((c, i) => `<label style="display:flex;gap:8px;padding:6px 0;font-weight:600"><input type="radio" name="srvChoix" value="${i}" ${i ? "" : "checked"}> 📁 ${esc(c.nom)}${c.zone ? `<span style="font-weight:400;color:#6B7280">· ${esc(c.zone)}</span>` : ""}</label>`).join("")}`,
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

  // ─── Petite fenêtre autonome (marche aussi sans FTSShell) ───────
  /**
   * @param {{titre:string, corps:string, boutons:Array<{lib:string, val:any, pri?:boolean}>}} o
   * @returns {Promise<any>} la valeur du bouton cliqué (null si fermée)
   */
  function fenetre({ titre, corps, boutons }) {
    return new Promise((ok) => {
      const ov = document.createElement("div");
      ov.className = "srv-ov";
      ov.innerHTML = `<div class="srv-mod" role="dialog" aria-modal="true">
        <div class="srv-mh"><b>${titre}</b><button type="button" class="srv-x" aria-label="Fermer">✕</button></div>
        <div class="srv-mb">${corps}</div>
        <div class="srv-mf">${boutons.map((b, i) => `<button type="button" class="srv-bt${b.pri ? " pri" : ""}" data-i="${i}">${b.lib}</button>`).join("")}</div></div>`;
      let fini = false;
      const fin = (v) => { if (fini) return; fini = true; ov.remove(); document.removeEventListener("keydown", echap); ok(v); };
      const echap = (e) => { if (e.key === "Escape") fin(null); };
      document.addEventListener("keydown", echap);
      ov.addEventListener("click", (e) => { if (e.target === ov) fin(null); });
      ov.querySelector(".srv-x").addEventListener("click", () => fin(null));
      ov.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => fin(boutons[Number(b.dataset.i)].val)));
      cssFenetre();
      document.body.appendChild(ov);
      const pri = ov.querySelector(".srv-bt.pri"); if (pri) pri.focus();
    });
  }
  function cssFenetre() {
    if (document.getElementById("srvFenCss")) return;
    const s = document.createElement("style");
    s.id = "srvFenCss";
    s.textContent = `.srv-ov{position:fixed;inset:0;background:rgba(20,24,32,.45);display:flex;align-items:center;justify-content:center;z-index:9999;font-family:inherit}
      .srv-mod{background:#fff;border-radius:14px;width:min(560px,94vw);box-shadow:0 18px 50px rgba(0,0,0,.25);color:#1E2430;overflow:hidden}
      .srv-mh{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #E7E9ED;font-size:1rem}
      .srv-x{border:0;background:none;font-size:1rem;cursor:pointer;color:#6B7280}
      .srv-mb{padding:14px 18px;font-size:.88rem;line-height:1.45}
      .srv-mb ol{margin:6px 0 10px;padding-left:20px}.srv-mb li{margin:4px 0}
      .srv-mb .ch{font-family:Consolas,monospace;background:#F4F5F7;border-radius:6px;padding:6px 9px;font-size:.8rem;margin:6px 0}
      .srv-mb .ne{background:#FDF1EF;border:1px solid #F2C4BE;border-radius:8px;padding:7px 10px;font-size:.82rem}
      .srv-mf{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid #E7E9ED;background:#FAFBFC}
      .srv-bt{border:1px solid #E7E9ED;background:#fff;border-radius:8px;padding:8px 14px;font-weight:700;font-size:.85rem;cursor:pointer;font-family:inherit}
      .srv-bt.pri{background:#FDCA01;border-color:#FDCA01;color:#1E1E1E}`;
    document.head.appendChild(s);
  }

  /** « Relier le serveur » avec l'explication avant la fenêtre Windows (à appeler sur un clic) */
  async function relierGuide() {
    if (!disponible()) throw new Error("Ce navigateur ne peut pas écrire sur le serveur : utilise Chrome ou Edge sur un ordinateur du bureau.");
    const go = await fenetre({
      titre: "🗄️ Relier le serveur FTS sur ce PC",
      corps: `<p style="margin:0 0 6px">À faire <b>une seule fois</b> sur ce PC. Dans la fenêtre qui va s'ouvrir :</p>
        <ol><li>va dans <div class="ch">${esc(CHEMIN_ATTENDU)}</div></li>
        <li>clique <b>une fois</b> sur le dossier <b>7 - TRAVAUX</b> pour le sélectionner (sans l'ouvrir) ;</li>
        <li>clique sur <b>« Sélectionner un dossier »</b>, puis sur « Modifier les fichiers ».</li></ol>
        <div class="ne">N'entre pas dans 7-1, 7-6 ni dans un chantier, et n'utilise pas la recherche : l'appli trouve toute seule le bon chantier, micropieux, battage ou pieux.</div>`,
      boutons: [{ lib: "Annuler", val: false }, { lib: "Ouvrir la fenêtre", val: true, pri: true }],
    });
    if (!go) return { ok: false, annule: true };
    return relier();
  }

  /**
   * Choisir à la main le dossier d'un chantier (retenu pour ce chantier sur ce PC).
   * À appeler sur un clic.
   * @returns {Promise<{ok:true, dossier, nom} | {ok:false, annule?:boolean, avert?:string}>}
   */
  async function choisirDossierChantier(code) {
    if (!disponible()) return { ok: false, avert: "Ce navigateur n'écrit pas sur le serveur (Chrome ou Edge sur un PC du bureau)." };
    const r = await lireHandle("racine");
    let h;
    try { h = await window.showDirectoryPicker({ id: "fts-chantier", mode: "readwrite", ...(r ? { startIn: r } : {}) }); }
    catch (e) { if (e && e.name === "AbortError") return { ok: false, annule: true }; return { ok: false, avert: traduire(e).message }; }
    if (cleZone(h.name) || norm(h.name) === norm(DOSSIER_ATTENDU)) return { ok: false, avert: `« ${h.name} » contient tous les chantiers : ouvre-le et choisis le dossier du chantier ${code}.` };
    if (estDossierChantier(h.name) && !correspond(h.name, code)) return { ok: false, avert: `« ${h.name} » est le dossier d'un autre chantier (le code ne correspond pas à ${code}). Rien n'a été retenu.` };
    if ((await h.queryPermission(OPT)) !== "granted" && (await h.requestPermission(OPT)) !== "granted") return { ok: false, avert: "Le droit de modifier les fichiers a été refusé." };
    await ecrireHandle(CLE_MANUEL + norm(code), h);
    return { ok: true, dossier: h, nom: h.name };
  }
  /** Oublie le dossier choisi à la main pour ce chantier (retour à la recherche automatique) */
  async function oublierDossierChantier(code) { await ecrireHandle(CLE_MANUEL + norm(code), undefined); }

  /**
   * Retrouve le dossier chantier en demandant à la personne si besoin.
   * À appeler juste après un clic (l'autorisation peut être redemandée).
   * @param {string} code
   * @param {{silencieux?:boolean}} [opt] silencieux : jamais de fenêtre (ni choix, ni dossier à la main)
   * @returns {Promise<{ok:true, dossier, nom} | {ok:false, raison:"indisponible"|"non-relie"|"refus"|"introuvable"|"annule", message:string}>}
   */
  async function dossierChantier(code, opt = {}) {
    const st = await etat();
    if (st === "indisponible") return { ok: false, raison: "indisponible", message: "Ce navigateur n'écrit pas sur le serveur (Chrome ou Edge sur un PC du bureau)." };
    if (st === "non-relie") return { ok: false, raison: "non-relie", message: "Le serveur n'est pas encore relié sur ce PC (bouton « Relier le serveur » en haut)." };
    if (st === "mal-relie") return { ok: false, raison: "non-relie", message: `Le serveur est relié au dossier d'un chantier (« ${await nomRacine()} ») au lieu de « ${DOSSIER_ATTENDU} » : clique sur « Relier le serveur » en haut.` };
    const r = await autoriser();
    if (!r) return { ok: false, raison: "refus", message: "Autorisation du serveur non donnée." };
    let t;
    try { t = await trouverChantier(code, r); }
    catch (e) { return { ok: false, raison: "indisponible", message: "Serveur FTS non accessible depuis ce PC (pas de VPN ?)." }; }
    if (t.etat === "ok" && t.manuel) {
      // Dossier choisi à la main : il doit toujours exister et être autorisé
      try {
        if ((await t.dossier.queryPermission(OPT)) !== "granted" && (await t.dossier.requestPermission(OPT)) !== "granted")
          return { ok: false, raison: "refus", message: "Autorisation du dossier chantier non donnée." };
        for await (const _ of t.dossier.entries()) break;
        return { ok: true, dossier: t.dossier, nom: t.nom };
      } catch (e) {
        await oublierDossierChantier(code);
        t = await trouverChantier(code, r);
      }
    }
    if (t.etat === "ok") return { ok: true, dossier: t.dossier, nom: t.nom };
    if (t.etat === "plusieurs") {
      if (opt.silencieux) return { ok: false, raison: "annule", message: "Plusieurs dossiers pour ce code." };
      const c = await demanderChoix(code, t.choix);
      return c ? { ok: true, dossier: c.dossier, nom: c.nom } : { ok: false, raison: "annule", message: "Dépôt remis à plus tard." };
    }
    const ou = (await zonesDe(r)).map((z) => z.nom).join(" ni dans ");
    const message = `Aucun dossier « ${code} » dans ${ou}. Il a peut-être été déplacé ou pas encore créé : l'appli ne crée jamais de dossier chantier.`;
    if (opt.silencieux) return { ok: false, raison: "introuvable", message };
    const choix = await fenetre({
      titre: `Dossier du chantier ${esc(code)} introuvable`,
      corps: `<p style="margin:0 0 8px">${esc(message)}</p><p style="margin:0">S'il existe ailleurs sur le serveur, choisis-le à la main : ce choix est retenu pour ce chantier sur ce PC.</p>`,
      boutons: [{ lib: "Plus tard", val: false }, { lib: "📁 Choisir le dossier du chantier", val: true, pri: true }],
    });
    if (!choix) return { ok: false, raison: "introuvable", message };
    const m = await choisirDossierChantier(code);
    if (m.ok) return m;
    return { ok: false, raison: m.annule ? "annule" : "introuvable", message: m.avert || "Dépôt remis à plus tard." };
  }

  // ─── Voyant de la barre du haut ─────────────────────────────────
  const LIB = {
    relie: ["ok", "🗄️ Serveur", "Serveur FTS relié sur ce PC. Clic : relier un autre dossier."],
    "a-autoriser": ["att", "🗄️ Autoriser", "Serveur FTS : le navigateur redemande l'autorisation une fois par session. Clic : autoriser."],
    "mal-relie": ["non", "🗄️ Relier le serveur", `Serveur FTS relié au dossier d'un seul chantier. Clic : relier ${CHEMIN_ATTENDU}`],
    "non-relie": ["non", "🗄️ Relier le serveur", `Serveur FTS pas encore relié sur ce PC. Clic : montrer une fois le dossier ${CHEMIN_ATTENDU}`],
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
          const r = await relierGuide();
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
    DOSSIER_ATTENDU, CHEMIN_ATTENDU, disponible, etat, relier, relierGuide, autoriser, racineAutorisee, trouverChantier, retenirChoix,
    choisirDossierChantier, oublierDossierChantier,
    dossierChantier, deposer, existeDans, lireAttente, ajouterAttente, retirerAttente, traiterAttente,
    creerDossierChantier, cheminDevis, nomDossierServeur, espacerCode, sansAccents,
    monterVoyant, codeDepuisNom, correspond, norm,
  };
})();
