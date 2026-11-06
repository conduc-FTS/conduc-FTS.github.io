/**
 * boite-envoi.js — Boîte d'envoi des rapports journaliers (tablette)
 *
 * Chaque rapport validé est d'abord rangé dans la boîte d'envoi de la
 * tablette (IndexedDB : PDF + données du suivi), PUIS envoyé. S'il n'y a
 * pas de réseau (ou si la connexion Google a expiré), il reste dans la
 * boîte et part tout seul dès que possible, appli ouverte : au retour du
 * réseau, à la reconnexion, à l'ouverture de l'appli, et toutes les minutes.
 *
 * L'envoi se fait par étapes mémorisées (PDF chantier → archive du chef →
 * suivi Sheets → Agenda) : une coupure au milieu reprend là où elle s'est
 * arrêtée, sans doublon. Les contrôles qui demandent le réseau (pieux déjà
 * réalisés, rapport déjà présent) sont faits au moment de l'envoi s'ils
 * n'ont pas pu l'être à la validation : en cas de conflit, le rapport
 * attend la décision du chef, rien n'est écrasé.
 */
const FTSBoiteEnvoi = (() => {
  const DB_NOM = "fts-boite-envoi";
  const STORE = "rapports";
  const CLE_ENVOYES = "fts_boite_envoyes";
  const JOURS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
  const VERT_PENDANT_MS = 30 * 60000; // « envoyé » reste affiché 30 min

  const ecouteurs = [];
  let canal = null;
  try { canal = new BroadcastChannel("fts-boite-envoi"); canal.onmessage = () => notifier(false); } catch (e) { /* navigateur ancien */ }
  let enCours = null;           // id du rapport en cours d'envoi (cette page)
  let derniereListe = [];

  // ─── Stockage (IndexedDB) ────────────────────────────────────
  let dbPromesse = null;
  function db() {
    if (!dbPromesse) {
      dbPromesse = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NOM, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromesse = null; reject(req.error); };
      });
    }
    return dbPromesse;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const s = t.objectStore(STORE);
      let res;
      Promise.resolve(fn(s)).then((r) => { res = r; });
      t.oncomplete = () => resolve(res);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function lister() {
    try {
      const tous = await tx("readonly", (s) => req2p(s.getAll()));
      return (tous || []).sort((a, b) => a.creeLe - b.creeLe);
    } catch (e) {
      console.warn("Boîte d'envoi illisible :", e);
      return [];
    }
  }
  const sauver = (item) => tx("readwrite", (s) => req2p(s.put(item)));
  const supprimer = (id) => tx("readwrite", (s) => req2p(s.delete(id)));

  function lireEnvoyes() { try { return JSON.parse(localStorage.getItem(CLE_ENVOYES) || "[]"); } catch (e) { return []; } }
  function noterEnvoye(item, avertissements) {
    const l = lireEnvoyes().filter((x) => x.id !== item.id);
    l.push({ id: item.id, titre: titre(item), le: Date.now(), avertissements, vu: false });
    try { localStorage.setItem(CLE_ENVOYES, JSON.stringify(l.slice(-10))); } catch (e) { /* plein */ }
  }

  // ─── Utilitaires ─────────────────────────────────────────────
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const enLigne = () => navigator.onLine !== false;
  const connecte = () => !!(window.FTSAuth && FTSAuth.isSignedIn());
  function titre(item) {
    const [a, m, j] = String(item.dateISO || "").split("-");
    const d = new Date(Number(a), Number(m) - 1, Number(j));
    const at = /#\s*(\d+)$/.exec(String(item.atelier || ""));
    return `Rapport du ${isNaN(d) ? item.dateISO : JOURS[d.getDay()]} ${j}/${m}${at ? ` · atelier ${at[1]}` : ""}`;
  }
  function estErreurReseau(e) {
    return !enLigne() || e instanceof TypeError || /failed to fetch|networkerror|load failed|network request failed|non connecté/i.test(String(e && e.message));
  }
  function estErreurConnexion(e) { return /\b401\b|invalid credentials|non connecté/i.test(String(e && e.message)); }

  function notifier(diffuser) {
    lister().then((l) => {
      derniereListe = l;
      ecouteurs.forEach((cb) => { try { cb(l); } catch (e) { console.warn(e); } });
    });
    if (diffuser && canal) { try { canal.postMessage("maj"); } catch (e) { /* rien */ } }
  }

  // ─── Ajout d'un rapport ──────────────────────────────────────
  /**
   * @param {object} r { pdfBlob, fileName, code, chantierName, nomChef, atelier, dateISO,
   *                     suivi:{date, machines, personnel, nbPieux, longueurTotale, numerosPieux, horaires, pannes, arrets},
   *                     controles:{pieux:boolean, existant:boolean} }
   */
  async function ajouter(r) {
    const cle = `${String(r.code).toUpperCase()}|${r.dateISO}|${String(r.atelier || "").toUpperCase()}`;
    // Une nouvelle version du même rapport remplace celle qui attendait
    const anciens = (await lister()).filter((x) => x.cle === cle);
    for (const a of anciens) await supprimer(a.id);
    const item = {
      id: `rj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      cle, creeLe: Date.now(),
      pdfBlob: r.pdfBlob, fileName: r.fileName, code: r.code, chantierName: r.chantierName,
      nomChef: r.nomChef, atelier: r.atelier, dateISO: r.dateISO, suivi: r.suivi,
      controles: { pieux: !!(r.controles && r.controles.pieux), existant: !!(r.controles && r.controles.existant) },
      etapes: { pdf: false, chef: false, suivi: false, agenda: false },
      statut: "attente", message: "", avertissements: [], essais: 0,
    };
    await sauver(item);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    notifier(true);
    return item;
  }

  // ─── Envoi ───────────────────────────────────────────────────
  async function envoyerUn(item) {
    const maj = async (champs) => { Object.assign(item, champs); await sauver(item); notifier(true); };
    if (!enLigne()) { await maj({ statut: "attente", message: "" }); return "reseau"; }
    if (!connecte()) { await maj({ statut: "connexion", message: "" }); return "connexion"; }
    enCours = item.id;
    await maj({ statut: "envoi", message: "", essais: item.essais + 1 });
    try {
      const aucuneEtape = !item.etapes.pdf;
      // Contrôles qui n'ont pas pu être faits à la validation (pas de réseau)
      if (aucuneEtape && (!item.controles.pieux || !item.controles.existant)) {
        const conflits = [];
        const racine = await FTSDrive.findChantierFolder(item.code);
        if (!item.controles.pieux && racine && window.FTSSheets && item.suivi.numerosPieux.length) {
          const doublons = await FTSSheets.verifierPieuxDejaRealises(racine.id, racine.name, item.suivi.numerosPieux, item.suivi.date, item.atelier);
          doublons.forEach((c) => conflits.push(`Pieu n°${c.numero} déjà déclaré le ${c.date}${c.atelier ? ` par l'atelier ${c.atelier}` : ""}`));
        }
        if (!item.controles.existant) {
          const { id: dossierId } = await FTSDrive.getDossierModuleChantier(item.code, "RAPPORT JOURNALIER");
          const fichiers = await FTSDrive.listFilesInFolder(dossierId);
          const ancienFormat = `${item.dateISO}_Rapport journalier_${String(item.code).toUpperCase()}.pdf`;
          if (fichiers.some((f) => f.name === item.fileName || f.name === ancienFormat)) {
            conflits.push("Un rapport de ce jour existe déjà sur le Drive pour cet atelier (il serait remplacé)");
          }
        }
        if (conflits.length) {
          await maj({ statut: "conflit", message: conflits.join(" · ") });
          return "conflit";
        }
        item.controles = { pieux: true, existant: true };
      }

      // 1. PDF dans le dossier RAPPORT JOURNALIER du chantier
      if (!item.etapes.pdf) {
        const { id: dossierId } = await FTSDrive.getDossierModuleChantier(item.code, "RAPPORT JOURNALIER");
        // L'étiquette « FTS-CHEF » permet au robot de recopie de ranger une
        // copie dans RAPPORTS PAR CHEF / chef / année / mois (primes).
        await FTSDrive.uploadFile(item.pdfBlob, item.fileName, "application/pdf", dossierId, { remplacerSiExiste: true, description: item.nomChef ? `FTS-CHEF:${String(item.nomChef).trim().toUpperCase()}` : "" });
        item.etapes.pdf = true; await sauver(item);
      }
      // 2. (supprimé) L'archive par chef n'est plus écrite par la tablette :
      //    le robot de recopie Google la range dans RAPPORTS PAR CHEF.
      if (!item.etapes.chef) { item.etapes.chef = true; await sauver(item); }
      // 3. Suivi du chantier (Sheets) : remplace les lignes de ce jour / atelier
      let racine = null;
      if (!item.etapes.suivi) {
        try {
          racine = await FTSDrive.findChantierFolder(item.code);
          if (racine && window.FTSSheets) {
            await FTSSheets.enregistrerDonneesRapport({
              chantierFolderId: racine.id, chantierName: racine.name, date: item.suivi.date,
              machines: item.suivi.machines, personnel: item.suivi.personnel,
              nbPieux: item.suivi.nbPieux, longueurTotale: item.suivi.longueurTotale, numerosPieux: item.suivi.numerosPieux,
              nomChef: item.nomChef, atelier: item.atelier,
              horaires: item.suivi.horaires, pannes: item.suivi.pannes, arrets: item.suivi.arrets,
            });
          }
        } catch (e) {
          if (estErreurReseau(e) || estErreurConnexion(e)) throw e;
          item.avertissements.push("suivi Sheets non mis à jour (" + e.message + ")");
        }
        item.etapes.suivi = true; await sauver(item);
      }
      // 4. Pointage Agenda (au mieux)
      if (!item.etapes.agenda) {
        if (window.FTSCalendar) {
          if (!racine) racine = await FTSDrive.findChantierFolder(item.code).catch(() => null);
          if (racine) {
            try { await FTSCalendar.enregistrerPointageMachine(racine.name, item.dateISO, item.suivi.machines, item.atelier); }
            catch (e) { if (estErreurReseau(e)) throw e; console.warn("Agenda machines :", e); }
            try { if (item.suivi.personnel.length) await FTSCalendar.enregistrerPointagePersonnel(racine.name, item.dateISO, item.suivi.personnel, item.atelier); }
            catch (e) { if (estErreurReseau(e)) throw e; console.warn("Agenda personnel :", e); }
          }
        }
        item.etapes.agenda = true;
      }
      await supprimer(item.id);
      noterEnvoye(item, item.avertissements);
      notifier(true);
      return "envoye";
    } catch (e) {
      console.warn("Envoi du rapport reporté :", e);
      if (estErreurConnexion(e)) await maj({ statut: "connexion", message: "" });
      else if (estErreurReseau(e)) await maj({ statut: "attente", message: "" });
      else await maj({ statut: "erreur", message: e.message || String(e) });
      return "echec";
    } finally {
      enCours = null;
    }
  }

  /** Envoie tout ce qui attend (un seul envoi à la fois, toutes pages confondues). */
  async function envoyerTout(options = {}) {
    const travail = async () => {
      const liste = await lister();
      const resultats = [];
      for (const item of liste) {
        if (item.statut === "conflit" && !options.forcerId) continue;
        if (item.statut === "erreur" && !options.manuel && Date.now() - (item.dernierEssai || 0) < 5 * 60000) continue;
        item.dernierEssai = Date.now();
        const r = await envoyerUn(item);
        resultats.push(r);
        if (r === "reseau" || r === "connexion") break;
      }
      return resultats;
    };
    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request("fts-boite-envoi", { ifAvailable: true }, (lock) => (lock ? travail() : []));
    }
    return travail();
  }

  async function envoyerQuandMeme(id) {
    const item = (await lister()).find((x) => x.id === id);
    if (!item) return;
    item.controles = { pieux: true, existant: true };
    item.statut = "attente";
    item.message = "";
    await sauver(item);
    return envoyerTout({ manuel: true, forcerId: id });
  }

  async function retirer(id) { await supprimer(id); notifier(true); }

  async function telechargerPdf(id) {
    const item = (await lister()).find((x) => x.id === id);
    if (!item) return;
    const url = URL.createObjectURL(item.pdfBlob);
    const a = document.createElement("a");
    a.href = url; a.download = item.fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ─── Bandeau (accueil et rapport) ────────────────────────────
  const CSS = `
  .be-box{margin:14px 0 0;border-radius:14px;padding:12px 16px;font-family:inherit}
  .be-att{background:#FFF4E0;border:2px solid #F5A800}
  .be-ok{background:#EAF6EE;border:2px solid #3FAE63;display:flex;align-items:center;gap:12px}
  .be-ok .be-x{margin-left:auto}
  .be-tete{display:flex;align-items:center;gap:12px}
  .be-ic{font-size:1.6rem;line-height:1}
  .be-tete b{display:block;font-size:.95rem;color:#2A2A2A}
  .be-tete span.s{font-size:.8rem;color:#7A5A00}
  .be-go{margin-left:auto;background:#222;color:#fff;font-weight:800;font-size:.8rem;padding:10px 14px;border-radius:10px;border:none;white-space:nowrap;cursor:pointer;font-family:inherit}
  .be-go:disabled{opacity:.5}
  .be-it{display:flex;align-items:flex-start;gap:10px;border-top:1px dashed #E8C774;margin-top:10px;padding-top:10px;font-size:.82rem;color:#4B3A00}
  .be-it .t{font-weight:800;color:#2A2A2A;white-space:nowrap}
  .be-it .m{flex:1;min-width:0}
  .be-it .m.err{color:#A03000;font-weight:700}
  .be-act{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .be-b{background:#fff;border:1.5px solid #D9C08A;color:#2A2A2A;font-weight:800;font-size:.75rem;padding:7px 10px;border-radius:8px;cursor:pointer;font-family:inherit;white-space:nowrap}
  .be-b.rouge{border-color:#C0392B;color:#C0392B}
  .be-b.rouge.conf{background:#C0392B;color:#fff}
  .be-note{font-size:.72rem;color:#8A6D1F;margin-top:8px}
  .be-x{background:none;border:none;font-size:1.1rem;cursor:pointer;color:#2A2A2A;padding:4px 8px}
  @media(max-width:640px){.be-it{flex-wrap:wrap}.be-act{width:100%;justify-content:flex-start}}`;

  function monterBandeau(conteneur, options = {}) {
    if (!document.getElementById("be-style")) {
      const st = document.createElement("style");
      st.id = "be-style"; st.textContent = CSS;
      document.head.appendChild(st);
    }
    let confirmSuppr = "";
    const rendre = (liste) => {
      if (!liste.length) {
        const recents = lireEnvoyes().filter((x) => !x.vu && Date.now() - x.le < VERT_PENDANT_MS);
        if (!recents.length) { conteneur.innerHTML = ""; return; }
        const d = recents[recents.length - 1];
        const h = new Date(d.le).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        conteneur.innerHTML = `<div class="be-box be-ok"><span class="be-ic">✅</span><div><b>${recents.length > 1 ? `${recents.length} rapports envoyés` : `${esc(d.titre)} envoyé`}</b>
          <span style="font-size:.8rem;color:#1E6B3A">${recents.length > 1 ? "Dernier envoi" : "Envoyé"} à ${h}${d.avertissements && d.avertissements.length ? ` · ⚠️ ${esc(d.avertissements.join(" · "))}` : " · PDF sur le Drive, suivi à jour"}</span></div>
          <button type="button" class="be-x" aria-label="Fermer">✕</button></div>`;
        conteneur.querySelector(".be-x").addEventListener("click", () => {
          const l = lireEnvoyes().map((x) => ({ ...x, vu: true }));
          try { localStorage.setItem(CLE_ENVOYES, JSON.stringify(l)); } catch (e) { /* rien */ }
          conteneur.innerHTML = "";
        });
        return;
      }
      const reseau = enLigne(), cx = connecte();
      const pl = liste.length > 1;
      const sousTitre = !reseau ? `Pas de réseau : ${pl ? "ils partiront tout seuls" : "il partira tout seul"} dès que le réseau revient.`
        : !cx ? `Connecte-toi pour ${pl ? "les " : "l'"}envoyer (bouton compte en haut à droite de l'accueil).`
        : liste.some((x) => x.statut === "envoi") ? "Envoi en cours…" : "Réseau disponible : envoi automatique.";
      const lignes = liste.map((it) => {
        let msg, cls = "";
        if (it.statut === "envoi") msg = "⏳ Envoi en cours…";
        else if (it.statut === "conflit") { msg = `⚠️ À vérifier avant envoi : ${esc(it.message)}`; cls = "err"; }
        else if (it.statut === "erreur") { msg = `⚠️ Échec : ${esc(it.message)} — nouvel essai automatique dans quelques minutes.`; cls = "err"; }
        else if (!reseau) msg = "En attente du réseau.";
        else if (!cx || it.statut === "connexion") msg = "En attente de connexion Google.";
        else msg = "En attente…";
        const actions = [`<button type="button" class="be-b" data-a="pdf" data-id="${it.id}">⬇ PDF</button>`];
        if (it.statut === "conflit") {
          actions.push(`<button type="button" class="be-b" data-a="force" data-id="${it.id}">Envoyer quand même</button>`);
          actions.push(`<button type="button" class="be-b rouge${confirmSuppr === it.id ? " conf" : ""}" data-a="suppr" data-id="${it.id}">${confirmSuppr === it.id ? "Confirmer la suppression" : "Supprimer"}</button>`);
        }
        return `<div class="be-it"><span class="t">${esc(titre(it))}</span><span class="m ${cls}">${msg}</span><span class="be-act">${actions.join("")}</span></div>`;
      }).join("");
      conteneur.innerHTML = `<div class="be-box be-att"><div class="be-tete"><span class="be-ic">📤</span>
          <div><b>${liste.length} rapport${liste.length > 1 ? "s" : ""} en attente d'envoi</b><span class="s">${sousTitre}</span></div>
          ${reseau && cx ? `<button type="button" class="be-go" ${liste.some((x) => x.statut === "envoi") ? "disabled" : ""}>Envoyer maintenant</button>` : ""}
          ${reseau && !cx && options.seConnecter ? '<button type="button" class="be-go" data-a="login">Se connecter</button>' : ""}
        </div>${lignes}
        <div class="be-note">Ne vide pas les données de la tablette (ni le cache du navigateur) tant que ce bandeau est affiché : les rapports sont gardés dedans.</div></div>`;
      const go = conteneur.querySelector(".be-go");
      if (go) go.addEventListener("click", () => {
        if (go.dataset.a === "login") { options.seConnecter(); return; }
        go.disabled = true;
        envoyerTout({ manuel: true });
      });
      conteneur.querySelectorAll(".be-b").forEach((b) => b.addEventListener("click", async () => {
        const id = b.dataset.id;
        if (b.dataset.a === "pdf") telechargerPdf(id);
        if (b.dataset.a === "force") envoyerQuandMeme(id);
        if (b.dataset.a === "suppr") {
          if (confirmSuppr !== id) { confirmSuppr = id; rendre(derniereListe); setTimeout(() => { if (confirmSuppr === id) { confirmSuppr = ""; rendre(derniereListe); } }, 5000); return; }
          confirmSuppr = "";
          await retirer(id);
        }
      }));
    };
    ecouteurs.push(rendre);
    window.addEventListener("online", () => rendre(derniereListe));
    window.addEventListener("offline", () => rendre(derniereListe));
    notifier(false);
  }

  // ─── Déclencheurs automatiques ───────────────────────────────
  let demarre = false;
  function demarrer() {
    if (demarre) return;
    demarre = true;
    const tenter = () => { if (enLigne() && connecte()) envoyerTout().catch((e) => console.warn(e)); };
    window.addEventListener("online", () => setTimeout(tenter, 1500));
    if (window.FTSAuth && FTSAuth.onAuthChange) FTSAuth.onAuthChange((ok) => { notifier(false); if (ok) setTimeout(tenter, 500); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tenter(); });
    setInterval(async () => { if ((await lister()).length) tenter(); }, 60000);
    setTimeout(tenter, 2000);
  }

  function onChange(cb) { ecouteurs.push(cb); notifier(false); }

  return { ajouter, envoyerTout, envoyerQuandMeme, retirer, lister, monterBandeau, demarrer, onChange, titre, lireEnvoyes };
})();
window.FTSBoiteEnvoi = FTSBoiteEnvoi;
