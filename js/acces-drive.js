/**
 * acces-drive.js — écran « Accès Drive » de la Supervision : qui voit quoi
 * dans le Drive FTS, calculé et appliqué automatiquement.
 *
 * Règles (validées avec Clément le 06/11/2026) :
 *  - ENCADREMENT = Personnel FTS, catégorie ENCADREMENT, ACTIF, avec e-mail et
 *    « Accès Drive » Lecture + modification ou Lecture seule : accès à tous
 *    les dossiers racine. L'ancienne liste (REFERENTIEL / « Accès Drive FTS »)
 *    reste lue en transition pour les adresses absentes de Personnel FTS ;
 *  - CHEFS DE CHANTIER ACTIFS avec e-mail (Personnel FTS) :
 *      DOSSIER CHANTIER → modification · ADMINISTRATIF / {son dossier} →
 *      lecture (créé s'il manque) · ARCHIVES → AUCUN accès (réservé aux
 *      conducteurs : si un chef en a besoin, on désarchive le chantier) ;
 *  - dossiers INTERNES (ADMINISTRATIF, RAPPORTS PAR CHEF, ACCUEIL INTERIMAIRE,
 *    ACCUEIL SECURITE, FICHE MATERIEL, REFERENTIEL) : toute autre personne
 *    perd l'accès. Retrait automatique pour les personnes de Personnel FTS ;
 *    pour une adresse inconnue, retrait proposé (bouton) — jamais en silence ;
 *  - DOSSIER CHANTIER et ARCHIVES : les personnes extérieures (client, MOE,
 *    bureau d'études…) ne sont JAMAIS retirées ; seules les personnes PARTIES
 *    de Personnel FTS le sont ;
 *  - le propriétaire n'est jamais touché ; couleurs des dossiers racine.
 *
 * FTSAcces.monter(conteneur) · FTSAcces.verifier({ appliquerProposes })
 * Nécessite drive.js et personnel.js (FTSPersonnel chargé).
 */
const FTSAcces = (() => {
  const DRIVE = "https://www.googleapis.com/drive/v3";
  const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
  const NOM_CLASSEUR = "Accès Drive FTS";
  const ONGLET = "Encadrement";
  const EN_TETE = ["Nom", "E-mail", "Accès"];
  const DOSSIERS = [
    { nom: "DOSSIER CHANTIER", couleur: "#fad165", interne: false, chefs: "writer", lib: "MODIFICATION" },
    { nom: "ARCHIVES", couleur: "#c2c2c2", interne: false, chefs: null },
    { nom: "ADMINISTRATIF", couleur: "#4986e7", interne: true, chefs: "perso", lib: "SON DOSSIER · LECTURE" },
    { nom: "RAPPORTS PAR CHEF", couleur: "#9fc6e7", interne: true },
    { nom: "ACCUEIL INTERIMAIRE", couleur: "#f691b2", interne: true },
    { nom: "ACCUEIL SECURITE", couleur: "#16a765", interne: true },
    { nom: "FICHE MATERIEL", couleur: "#ff7537", interne: true },
    { nom: "REFERENTIEL", couleur: "#ac725e", interne: true },
  ];
  const RANG = { reader: 1, commenter: 1, writer: 2, fileOrganizer: 3, organizer: 3, owner: 4 };

  let racine = null;
  let encadrement = null; // ANCIENNE liste « Accès Drive FTS » : { spreadsheetId, liste:[{nom,email,acces}] }
  let dernier = null;     // dernier bilan
  let enCours = null;
  let messageStatut = ""; // message sous le formulaire, conservé entre deux affichages
  let aRefaire = false;     // une modification arrivée pendant une vérification : on en relance une après

  const esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  const auth = () => ({ Authorization: "Bearer " + FTSAuth.getToken() });
  const cle = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim().split(" ").sort().join(" ");
  // Gmail ignore les points (r.dupont@gmail.com = rdupont@gmail.com) et Drive
  // renvoie souvent l'adresse sans points : on compare toujours sous cette forme.
  // L'adresse telle qu'elle est saisie (avec ses points) est gardée pour l'affichage.
  const brut = new Map();
  const mail = (s) => {
    const e = String(s || "").trim().toLowerCase();
    const m = e.match(/^([^@+]+)(?:\+[^@]*)?@(gmail\.com|googlemail\.com)$/);
    const c = m ? m[1].replace(/\./g, "") + "@gmail.com" : e;
    if (e && !brut.has(c)) brut.set(c, e);
    return c;
  };
  const aff = (c) => brut.get(c) || c;
  async function req(url, opts = {}) {
    for (let essai = 0; essai < 4; essai++) {
      const r = await fetch(url, { ...opts, headers: { ...auth(), ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
      if (r.status !== 429 || essai === 3) return r;
      await new Promise((ok) => setTimeout(ok, 700 * Math.pow(2, essai)));
    }
  }

  // ─── Liste Encadrement (REFERENTIEL / Accès Drive FTS) ──────────
  async function idClasseur(creer) {
    const q = encodeURIComponent(`name = '${NOM_CLASSEUR}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`);
    const r = await req(`${DRIVE}/files?q=${q}&fields=files(id)&spaces=drive`);
    const f = r.ok ? ((await r.json()).files || [])[0] : null;
    if (f || !creer) return f ? f.id : null;
    const refId = await FTSDrive.findOrCreateFolder("REFERENTIEL", null);
    const c = await req(SHEETS, { method: "POST", body: JSON.stringify({ properties: { title: NOM_CLASSEUR }, sheets: [{ properties: { title: ONGLET } }] }) });
    if (!c.ok) throw new Error(`Création de la liste Encadrement : ${c.status}`);
    const id = (await c.json()).spreadsheetId;
    await req(`${DRIVE}/files/${id}?addParents=${refId}&removeParents=root&fields=id`, { method: "PATCH" });
    return id;
  }
  async function chargerEncadrement() {
    const id = await idClasseur(false);
    if (!id) return (encadrement = { spreadsheetId: null, liste: [] });
    const r = await req(`${SHEETS}/${id}/values/${encodeURIComponent(ONGLET + "!A2:C")}`);
    const v = r.ok ? (await r.json()).values || [] : [];
    return (encadrement = { spreadsheetId: id, liste: v.filter((x) => x[1]).map((x) => ({ nom: x[0] || "", email: mail(x[1]), acces: /MODIF/i.test(String(x[2] || "")) || !String(x[2] || "").trim() ? "MODIFICATION" : "LECTURE" })) });
  }
  /**
   * Encadrement en vigueur : Personnel FTS (catégorie ENCADREMENT) + les
   * personnes de l'ancienne liste dont l'adresse n'est pas dans Personnel FTS.
   * [{ nom, poste, email, acces: "MODIFICATION"|"LECTURE", source: "personnel"|"ancienne" }]
   */
  function listeEncadrement() {
    const personnes = window.FTSPersonnel ? FTSPersonnel.toutes() : [];
    const dansBase = new Set(personnes.filter((p) => p.email).map((p) => mail(p.email)));
    const res = personnes.filter((p) => p.categorie === "ENCADREMENT" && p.statut === "ACTIF" && p.email && p.acces !== "AUCUN")
      .map((p) => ({ nom: `${p.nom} ${p.prenom}`.trim(), poste: p.poste, email: mail(p.email), acces: p.acces === "LECTURE" ? "LECTURE" : "MODIFICATION", source: "personnel" }));
    ((encadrement && encadrement.liste) || []).forEach((e) => {
      if (!dansBase.has(e.email) && !res.some((x) => x.email === e.email)) res.push({ ...e, poste: "", source: "ancienne" });
    });
    return res;
  }
  async function personnelLu() {
    const rp = window.FTSPersonnel ? await FTSPersonnel.charger({ rapide: true }).catch(() => null) : null;
    return !!(rp && rp.source === "sheet");
  }

  async function enregistrerEncadrement(liste) {
    const id = encadrement && encadrement.spreadsheetId ? encadrement.spreadsheetId : await idClasseur(true);
    let r = await req(`${SHEETS}/${id}/values/${encodeURIComponent(ONGLET + "!A:Z")}:clear`, { method: "POST" });
    if (!r.ok) throw new Error(`Écriture de la liste Encadrement : ${r.status}`);
    r = await req(`${SHEETS}/${id}/values/${encodeURIComponent(ONGLET + "!A1")}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [EN_TETE, ...liste.map((p) => [p.nom, aff(p.email), p.acces === "LECTURE" ? "Lecture seule" : "Lecture + modification"])] }) });
    if (!r.ok) throw new Error(`Écriture de la liste Encadrement : ${r.status}`);
    encadrement = { spreadsheetId: id, liste };
  }

  // ─── Qui a le droit d'utiliser cet écran ───────────────────────
  // Le propriétaire du Drive FTS, ou une personne de l'Encadrement en
  // « Lecture + modification ». Les autres (chef connecté sur un poste du
  // bureau, encadrement en lecture seule) voient « Réservé à l'encadrement ».
  let droitsCache = null;
  async function droits() {
    if (droitsCache) return droitsCache;
    // Session pas encore prête (ouverture directe sur #se-view-acces, nouvel
    // ordinateur…) : on attend la connexion Google jusqu'à ~30 s.
    for (let i = 0; i < 60 && !(window.FTSAuth && FTSAuth.isSignedIn && FTSAuth.isSignedIn()); i++) await new Promise((ok) => setTimeout(ok, 500));
    if (!(window.FTSAuth && FTSAuth.isSignedIn && FTSAuth.isSignedIn())) return { ok: false, email: "", pasConnecte: true };
    let email = "";
    try { const u = window.FTSAuth && FTSAuth.getUserInfo ? await FTSAuth.getUserInfo() : null; email = mail(u && u.email); } catch (e) {}
    if (!email && window.FTSAuth && FTSAuth.emailMemorise) email = mail(FTSAuth.emailMemorise());
    const q = encodeURIComponent("name = 'DOSSIER CHANTIER' and mimeType = 'application/vnd.google-apps.folder' and 'me' in owners and trashed = false");
    const r = await req(`${DRIVE}/files?q=${q}&fields=files(id)`).catch(() => null);
    if (!r || !r.ok) return { ok: false, email, erreur: r ? r.status : "réseau" }; // pas mis en cache : on réessaiera
    if (r && r.ok && ((await r.json()).files || []).length) return (droitsCache = { ok: true, email, proprio: true, proprietaire: email });
    if (!encadrement) await chargerEncadrement().catch(() => (encadrement = { spreadsheetId: null, liste: [] }));
    if (!(await personnelLu())) return { ok: false, email, lecture: false }; // Personnel FTS illisible = pas l'encadrement
    const e = listeEncadrement().find((x) => x.email === email);
    let proprietaire = "";
    try {
      const q2 = encodeURIComponent("name = 'DOSSIER CHANTIER' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
      const r2 = await req(`${DRIVE}/files?q=${q2}&fields=files(owners(emailAddress))`);
      const f = r2.ok ? ((await r2.json()).files || [])[0] : null;
      proprietaire = mail(f && f.owners && f.owners[0] && f.owners[0].emailAddress);
    } catch (err) {}
    return (droitsCache = { ok: !!(e && e.acces === "MODIFICATION"), email, lecture: !!e, proprietaire });
  }

  // ─── Analyse : ce qu'il faut ajouter / modifier / retirer ──────
  async function permissions(id) {
    const r = await req(`${DRIVE}/files/${id}/permissions?fields=permissions(id,emailAddress,role,type)&supportsAllDrives=true`);
    if (!r.ok) throw new Error(`Lecture des partages : ${r.status}`);
    return ((await r.json()).permissions || []).filter((p) => p.type === "user" && p.emailAddress).map((p) => ({ ...p, emailAddress: mail(p.emailAddress) }));
  }
  async function enfants(id, dossiers) {
    const q = encodeURIComponent(`'${id}' in parents and trashed = false${dossiers ? " and mimeType = 'application/vnd.google-apps.folder'" : " and mimeType != 'application/vnd.google-apps.folder'"}`);
    const r = await req(`${DRIVE}/files?q=${q}&fields=files(id,name)&pageSize=500`);
    return r.ok ? (await r.json()).files || [] : [];
  }

  async function analyser() {
    if (!encadrement) await chargerEncadrement();
    // Sécurité : on ne touche à rien si la vraie base Personnel FTS n'est pas lue
    if (!(await personnelLu())) throw new Error("base Personnel FTS illisible : aucun accès modifié");
    const personnes = FTSPersonnel.toutes();
    const base = new Map(personnes.filter((p) => p.email).map((p) => [mail(p.email), p]));
    const chefs = personnes.filter((p) => p.statut === "ACTIF" && p.poste === "CHEF DE CHANTIER" && p.email);
    const chefsSansMail = personnes.filter((p) => p.statut === "ACTIF" && p.poste === "CHEF DE CHANTIER" && !p.email);
    const listeEnc = listeEncadrement();
    const enc = new Map(listeEnc.map((e) => [e.email, e.acces === "LECTURE" ? "reader" : "writer"]));
    const actions = [];
    const absents = [];
    const ajouter = (dossier, fileId, email, role, raison) => actions.push({ type: "ajout", dossier, fileId, email, role, raison, auto: true });
    const changer = (dossier, fileId, p, role, raison) => actions.push({ type: "role", dossier, fileId, email: p.emailAddress, permId: p.id, role, ancien: p.role, raison, auto: true });
    const retirer = (dossier, fileId, p, raison, auto) => actions.push({ type: "retrait", dossier, fileId, email: p.emailAddress, permId: p.id, ancien: p.role, raison, auto });

    // Accès voulu pour l'encadrement sur un dossier
    function encadrer(dossier, id, perms) {
      enc.forEach((role, email) => {
        const p = perms.find((x) => x.emailAddress === email);
        if (!p) ajouter(dossier, id, email, role, "encadrement");
        else if (p.role !== "owner" && p.role !== role && RANG[p.role] !== RANG[role]) changer(dossier, id, p, role, "encadrement");
      });
    }
    // Dossier interne : ni encadrement ni autorisé → retrait
    function nettoyer(dossier, id, perms, autorises) {
      perms.forEach((p) => {
        if (p.role === "owner" || enc.has(p.emailAddress) || autorises.has(p.emailAddress)) return;
        const connu = base.get(p.emailAddress);
        retirer(dossier, id, p, connu ? `${connu.prenom} ${connu.nom} n'a pas à voir ce dossier` : "adresse inconnue de Personnel FTS et de l'Encadrement", !!connu);
      });
    }

    const racines = {};
    for (const d of DOSSIERS) {
      const id = await FTSDrive.findFolderExact(d.nom, null).catch(() => null);
      if (!id) { absents.push(d.nom); continue; }
      racines[d.nom] = id;
      const perms = await permissions(id);
      encadrer(d.nom, id, perms);
      if (!d.interne) {
        if (d.chefs) chefs.forEach((c) => {
          const p = perms.find((x) => x.emailAddress === mail(c.email));
          if (!p) ajouter(d.nom, id, mail(c.email), d.chefs, "chef de chantier");
          else if (p.role !== "owner" && p.role !== d.chefs && !enc.has(p.emailAddress)) changer(d.nom, id, p, d.chefs, "chef de chantier");
        });
        // Personnes de la base : PARTIES retirées partout ; sur ARCHIVES, aucune
        // personne de la base hors encadrement. Les extérieurs (client, MOE…)
        // ne sont jamais touchés.
        perms.forEach((p) => {
          const b = base.get(p.emailAddress);
          if (!b || p.role === "owner" || enc.has(p.emailAddress)) return;
          if (b.statut !== "ACTIF") retirer(d.nom, id, p, `${b.prenom} ${b.nom} est parti(e)`, true);
          else if (!d.chefs) retirer(d.nom, id, p, `réservé aux conducteurs de travaux`, true);
        });
      } else {
        nettoyer(d.nom, id, perms, new Set());
      }
      // ADMINISTRATIF : chaque chef en lecture sur SON dossier, personne d'autre
      if (d.nom === "ADMINISTRATIF") {
        const sous = await enfants(id, true);
        for (const c of chefs) {
          const nomComplet = `${c.prenom} ${c.nom}`.trim();
          let dossierChef = sous.find((f) => cle(f.name) === cle(nomComplet));
          if (!dossierChef) { actions.push({ type: "dossier", dossier: "ADMINISTRATIF", parentId: id, nomDossier: nomComplet.toUpperCase(), email: mail(c.email), raison: "dossier personnel du chef", auto: true }); continue; }
          dossierChef.chef = mail(c.email);
        }
        for (const f of sous) {
          const perms2 = await permissions(f.id);
          const lib = `ADMINISTRATIF / ${f.name}`;
          if (f.chef) {
            const p = perms2.find((x) => x.emailAddress === f.chef);
            if (!p) ajouter(lib, f.id, f.chef, "reader", "son dossier personnel");
            else if (p.role !== "reader" && p.role !== "owner" && !enc.has(p.emailAddress)) changer(lib, f.id, p, "reader", "son dossier personnel (lecture seule)");
          }
          nettoyer(lib, f.id, perms2, new Set(f.chef ? [f.chef] : []));
        }
      }
      // REFERENTIEL : partages directs sur les fichiers
      if (d.nom === "REFERENTIEL") {
        for (const f of await enfants(id, false)) nettoyer(`REFERENTIEL / ${f.name}`, f.id, await permissions(f.id), new Set());
      }
    }
    // Partage bloqué pour les éditeurs (chefs) : DOSSIER CHANTIER, chaque
    // chantier et ses sous-dossiers. Seuls les dossiers dont le compte
    // connecté est propriétaire peuvent être réglés.
    const partages = [];
    if (racines["DOSSIER CHANTIER"]) {
      const lister = async (parent) => {
        const q = encodeURIComponent(`'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
        const r = await req(`${DRIVE}/files?q=${q}&fields=files(id,name,ownedByMe,writersCanShare)&pageSize=500`);
        return r.ok ? (await r.json()).files || [] : [];
      };
      const r0 = await req(`${DRIVE}/files/${racines["DOSSIER CHANTIER"]}?fields=id,name,ownedByMe,writersCanShare`);
      const tous = r0.ok ? [await r0.json()] : [];
      for (const c of await lister(racines["DOSSIER CHANTIER"])) { tous.push(c); tous.push(...(await lister(c.id))); }
      tous.forEach((f) => { if (f.writersCanShare !== false) partages.push({ id: f.id, nom: f.name, proprio: !!f.ownedByMe }); });
    }
    // Couleurs
    const couleurs = [];
    for (const d of DOSSIERS) {
      if (!racines[d.nom]) continue;
      const r = await req(`${DRIVE}/files/${racines[d.nom]}?fields=folderColorRgb`);
      const actuelle = r.ok ? ((await r.json()).folderColorRgb || "").toLowerCase() : "";
      if (actuelle !== d.couleur) couleurs.push({ id: racines[d.nom], couleur: d.couleur, nom: d.nom });
    }
    return { actions, couleurs, partages, chefs, chefsSansMail, absents, nbEncadrement: listeEnc.length };
  }

  async function executer(plan, inclureProposes) {
    const faits = [], erreurs = [];
    for (const a of plan.actions) {
      if (!a.auto && !inclureProposes) continue;
      try {
        let r;
        const poser = (role) => req(`${DRIVE}/files/${a.fileId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, { method: "POST", body: JSON.stringify({ role, type: "user", emailAddress: aff(a.email) }) });
        if (a.type === "ajout") r = await poser(a.role);
        else if (a.type === "role") {
          r = await req(`${DRIVE}/files/${a.fileId}/permissions/${a.permId}?supportsAllDrives=true`, { method: "PATCH", body: JSON.stringify({ role: a.role }) });
          // Accès hérité du dossier parent (déjà retiré plus haut, ou non
          // modifiable ici) : on pose un accès direct avec le bon rôle.
          if (r && (r.status === 404 || r.status === 403)) r = await poser(a.role);
        } else if (a.type === "retrait") {
          r = await req(`${DRIVE}/files/${a.fileId}/permissions/${a.permId}?supportsAllDrives=true`, { method: "DELETE" });
          // 404 : l'accès venait du dossier parent et a déjà disparu avec lui.
          if (r && r.status === 404) { faits.push({ ...a, herite: true }); continue; }
        }
        else if (a.type === "dossier") {
          const id = await FTSDrive.createFolder(a.nomDossier, a.parentId);
          r = await req(`${DRIVE}/files/${id}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, { method: "POST", body: JSON.stringify({ role: "reader", type: "user", emailAddress: aff(a.email) }) });
        }
        if (r && (r.ok || r.status === 204)) faits.push(a); else erreurs.push({ ...a, statut: r ? r.status : "?" });
      } catch (e) { erreurs.push({ ...a, statut: e.message }); }
    }
    for (const c of plan.couleurs) {
      try { await req(`${DRIVE}/files/${c.id}?fields=id`, { method: "PATCH", body: JSON.stringify({ folderColorRgb: c.couleur }) }); } catch (e) {}
    }
    let partagesBloques = 0;
    for (const f of (plan.partages || []).filter((x) => x.proprio)) {
      try { const r = await req(`${DRIVE}/files/${f.id}?fields=id`, { method: "PATCH", body: JSON.stringify({ writersCanShare: false }) }); if (r.ok) partagesBloques++; } catch (e) {}
    }
    return { faits, erreurs, partagesBloques };
  }

  /** Vérifie et applique (retraits d'adresses inconnues seulement si appliquerProposes). */
  async function verifier(options = {}) {
    if (enCours) return enCours;
    enCours = (async () => {
      const d = await droits();
      if (!d.ok) throw new Error("réservé à l'encadrement (lecture + modification)");
      let plan = await analyser();
      let res = await executer(plan, !!options.appliquerProposes);
      // Un retrait sur un dossier parent change les accès hérités des
      // sous-dossiers : on refait un passage pour finir le travail proprement.
      if (res.erreurs.length || res.faits.some((x) => x.type === "retrait" || x.type === "role")) {
        await new Promise((ok) => setTimeout(ok, 2500));
        plan = await analyser();
        // Dossiers créés au 1er passage : la recherche Drive peut mettre
        // quelques secondes à les voir, on ne les recrée surtout pas.
        const crees = new Set(res.faits.filter((x) => x.type === "dossier").map((x) => x.parentId + "/" + x.nomDossier));
        plan.actions = plan.actions.filter((x) => !(x.type === "dossier" && crees.has(x.parentId + "/" + x.nomDossier)));
        const res2 = await executer(plan, !!options.appliquerProposes);
        res = { faits: res.faits.filter((x) => !x.herite).concat(res2.faits.filter((x) => !x.herite)), erreurs: res2.erreurs, partagesBloques: res.partagesBloques + res2.partagesBloques };
      } else res.faits = res.faits.filter((x) => !x.herite);
      const proposes = options.appliquerProposes ? [] : plan.actions.filter((a) => !a.auto);
      dernier = { le: new Date(), plan, ...res, proposes };
      return dernier;
    })().finally(() => { enCours = null; });
    return enCours;
  }

  /** Comme verifier(), mais si une vérification tourne déjà, en relance une après (prend en compte la dernière modification). */
  async function verifierAJour(options = {}) {
    if (enCours) await enCours.catch(() => {});
    return verifier(options);
  }

  /** Résumé en une ligne (écran Personnel FTS). */
  function resume(b) {
    const aj = b.faits.filter((a) => a.type !== "retrait").length, re = b.faits.filter((a) => a.type === "retrait").length;
    return `Accès Drive à jour : ${b.plan.chefs.length} chef(s) équipé(s)` + (aj ? ` · ${aj} accès donné(s)` : "") + (re ? ` · ${re} accès retiré(s)` : "") +
      (b.proposes.length ? ` · ⚠️ ${b.proposes.length} accès à vérifier dans « Accès Drive »` : "") + (b.erreurs.length ? ` · ⚠️ ${b.erreurs.length} erreur(s)` : "") + ".";
  }

  // ─── Écran ─────────────────────────────────────────────────────
  const TXT = { ajout: "accès donné", role: "accès modifié", retrait: "accès retiré", dossier: "dossier créé et partagé" };
  const roleLib = (r) => (r === "writer" ? "modification" : r === "reader" ? "lecture" : r);
  function badge(r) {
    const c = { MOD: "r-mod", LEC: "r-lec", NON: "r-non", PERSO: "r-perso" };
    const t = { MOD: "MODIFICATION", LEC: "LECTURE", NON: "AUCUN", PERSO: "SON DOSSIER · LECTURE" };
    return `<span class="ad-r ${c[r]}">${t[r]}</span>`;
  }

  const restants = (b) => (b.plan.partages || []).filter((x) => !x.proprio).length;
  function rendre() {
    if (!racine) return;
    const liste = listeEncadrement();
    const anciens = liste.filter((p) => p.source === "ancienne");
    const badgeAcces = (a) => a === "LECTURE" ? '<span class="ad-r r-lec">LECTURE SEULE</span>' : '<span class="ad-r r-mod">LECTURE + MODIFICATION</span>';
    const posteLib = (t) => t ? t.charAt(0) + t.slice(1).toLowerCase() : "";
    const ligne = (p) => p.source === "ancienne"
      ? `<tr class="ad-ancien"><td><b>${esc(p.nom || "—")}</b></td><td><span class="ad-r r-perso">ANCIENNE LISTE</span></td><td>${esc(aff(p.email))}</td><td>${badgeAcces(p.acces)}</td>
          <td><button type="button" class="ad-btn" data-suppr-ancien="${esc(p.email)}" title="Retirer de l'ancienne liste">🗑️</button></td></tr>`
      : `<tr><td><b>${esc(p.nom)}</b></td><td class="ad-sub">${esc(posteLib(p.poste)) || "—"}</td><td>${esc(aff(p.email))}</td><td>${badgeAcces(p.acces)}</td><td></td></tr>`;
    const b = dernier;
    let bilan = '<div class="ad-vide">Vérification en cours…</div>';
    if (b) {
      const donnes = b.faits.filter((a) => a.type !== "retrait"), retires = b.faits.filter((a) => a.type === "retrait");
      bilan = `<div class="ad-ok">✅ <b>${b.plan.chefs.length} chef(s) de chantier</b> avec e-mail : DOSSIER CHANTIER (modification) et leur dossier ADMINISTRATIF (lecture). ARCHIVES réservé à l'encadrement.<br>✅ Dossiers internes réservés à l'encadrement (${b.plan.nbEncadrement} personne(s) + le propriétaire).<br>✅ Couleurs des dossiers appliquées.<br>${restants(b) ? "" : `✅ Les chefs ne peuvent pas partager DOSSIER CHANTIER ni les dossiers des chantiers${b.partagesBloques ? ` (réglé à l'instant sur ${b.partagesBloques} dossier(s))` : ""}.`}</div>`;
      if (restants(b)) bilan += `<div class="ad-warn">⚠️ <b>${restants(b)} dossier(s) de chantier</b> encore partageables par les chefs : seul le propriétaire du Drive peut bloquer le partage. Ouvre cet écran une fois avec le compte propriétaire (conduc.fts).</div>`;
      if (donnes.length) {
        const parMail = {};
        donnes.forEach((a) => { (parMail[a.email] = parMail[a.email] || []).push(`${a.dossier}${a.type === "dossier" ? " (dossier créé)" : ""} : ${roleLib(a.role || "reader")}`); });
        bilan += `<div class="ad-info">➕ <b>Fait à l'instant</b> :<ul>${Object.entries(parMail).map(([m, l]) => `<li><b>${esc(aff(m))}</b> — ${l.length > 3 ? `${l.length} dossiers` : esc(l.join(" · "))}</li>`).join("")}</ul></div>`;
      }
      if (retires.length) bilan += `<div class="ad-warn">🧹 <b>Accès retirés</b> : ${retires.map((a) => `${esc(aff(a.email))} (${esc(a.dossier)})`).join(" · ")}</div>`;
      if (b.proposes.length) bilan += `<div class="ad-alert">⚠️ <b>${b.proposes.length} accès à vérifier</b> — adresses inconnues de Personnel FTS et de l'Encadrement, sur des dossiers internes :<ul>${b.proposes.map((a) => `<li>${esc(aff(a.email))} — ${esc(a.dossier)} (${roleLib(a.ancien)})</li>`).join("")}</ul>Si ce sont des personnes de l'encadrement, ajoute-les dans Personnel FTS (catégorie ENCADREMENT) puis clique sur « Vérifier maintenant ». Sinon :<br><button type="button" class="ad-btn pri" id="adRetirer" style="margin-top:8px">Retirer ces ${b.proposes.length} accès</button></div>`;
      if (b.plan.chefsSansMail.length) bilan += `<div class="ad-warn">⚠️ <b>Chef(s) sans e-mail</b> : ${b.plan.chefsSansMail.map((p) => esc(`${p.nom} ${p.prenom}`)).join(", ")} — leur tablette n'a aucun accès tant que l'e-mail n'est pas renseigné dans Personnel FTS.</div>`;
      if (b.plan.absents.length) bilan += `<div class="ad-info">ℹ️ Dossiers pas encore créés : ${b.plan.absents.map(esc).join(", ")} (créés par le robot de recopie au besoin).</div>`;
      if (b.erreurs.length) bilan += `<div class="ad-alert">❌ ${b.erreurs.length} action(s) impossible(s) : ${b.erreurs.map((a) => `${esc(aff(a.email))} / ${esc(a.dossier)} (${esc(a.statut)})`).join(" · ")}</div>`;
    }
    const cellule = (d, qui) => {
      if (qui === "enc") return '<span class="ad-r r-mod">SELON LA LISTE</span>';
      if (qui === "chef") return d.chefs === "writer" ? badge("MOD") : d.chefs === "reader" ? badge("LEC") : d.chefs === "perso" ? badge("PERSO") : badge("NON");
      return d.interne ? '<span class="ad-r r-non">RETIRÉE</span>' : '<span class="ad-sub">jamais retirée (client, MOE… partagés sur un chantier)</span>';
    };
    racine.innerHTML = `
      <div class="se-page-sub" style="margin-bottom:14px">Qui voit quoi dans le Drive FTS. Tout vient de Personnel FTS : les chefs (poste « Chef de chantier » + e-mail) et l'encadrement (catégorie « Encadrement » + e-mail + accès Drive). Vérifié à chaque ouverture de cette page.</div>
      <div class="ad-grid">
        <div class="se-panel">
          <div class="ad-h"><h2>Encadrement</h2><span class="s">vient de Personnel FTS (catégorie ENCADREMENT)</span></div>
          <div class="ad-b">
            <table class="ad-t"><thead><tr><th>Nom</th><th>Poste</th><th>E-mail (compte Google)</th><th>Accès</th><th></th></tr></thead><tbody>
              <tr><td><b>Compte propriétaire</b></td><td class="ad-sub">compte commun</td><td>${esc(aff((droitsCache && droitsCache.proprietaire) || "") || "conduc.fts@gmail.com")}</td><td><span class="ad-r r-mod">PROPRIÉTAIRE</span></td><td></td></tr>
              ${liste.map(ligne).join("")}
            </tbody></table>
            ${liste.filter((p) => p.source === "personnel").length ? "" : '<div class="ad-vide" style="padding:10px 0">Personne de l\'encadrement dans Personnel FTS pour l\'instant.</div>'}
            ${anciens.length ? `<div class="ad-warn" style="margin-top:10px">ℹ️ <b>${anciens.length} personne(s) de l'ancienne liste</b> pas encore dans Personnel FTS : elles gardent leur accès. Ajoute-les dans Personnel FTS (catégorie <b>ENCADREMENT</b>, même e-mail) : elles quitteront alors l'ancienne liste d'elles-mêmes.</div>` : ""}
            <div style="margin-top:12px"><button type="button" class="ad-btn pri" id="adVersPersonnel">👥 Modifier dans Personnel FTS</button></div>
            <div class="ad-st" id="adStatut"></div>
          </div>
          <div class="ad-note">⚠️ <b>Nouvelle adresse (encadrement ou chef)</b> : l'ajouter aussi dans les <b>utilisateurs test</b> de la console Google Cloud (My First Project › Google Auth Platform › Audience › Add users), sinon elle ne pourra pas se connecter au site.</div>
        </div>
        <div class="se-panel">
          <div class="ad-h"><h2>Dernière vérification</h2><span class="s">${(lancement || enCours) ? "⏳ vérification en cours…" : b ? "à " + b.le.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : ""}</span><span class="ad-sp"></span><button type="button" class="ad-btn" id="adVerifier">🔄 Vérifier maintenant</button></div>
          <div class="ad-b">${bilan}</div>
        </div>
      </div>
      <div class="se-panel">
        <div class="ad-h"><h2>Qui voit quoi</h2><span class="s">règles appliquées automatiquement</span></div>
        <div style="overflow:auto"><table class="ad-t"><thead><tr><th style="padding-left:20px">Dossier</th><th>Encadrement</th><th>Chefs de chantier</th><th>Toute autre personne</th></tr></thead><tbody>
          ${DOSSIERS.map((d) => `<tr><td style="padding-left:20px"><span class="ad-dot" style="background:${d.couleur}"></span><b>${d.nom}</b></td><td>${cellule(d, "enc")}</td><td>${cellule(d, "chef")}</td><td>${cellule(d, "autre")}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="ad-note">Les chefs n'ont pas besoin des dossiers centraux : leur tablette range tout dans le chantier, et le robot de recopie Google range une copie au bon endroit. Une personne passée en « PARTI » dans Personnel FTS perd ses accès.</div>
      </div>`;
    const $ = (id) => racine.querySelector("#" + id);
    const statut = (t) => { messageStatut = t; const s = $("adStatut"); if (s) s.textContent = t; };
    statut(messageStatut);
    $("adVersPersonnel").onclick = () => { const bt = document.querySelector('.se-nav-btn[data-view="se-view-personnel"]'); if (bt) bt.click(); else location.href = "../supervision-encadrement/index.html#se-view-personnel"; };
    racine.querySelectorAll("[data-suppr-ancien]").forEach((x) => (x.onclick = async () => {
      const email = x.dataset.supprAncien;
      if (!confirm(`Retirer ${aff(email)} de l'ancienne liste ?\nSans fiche ENCADREMENT dans Personnel FTS, cette adresse perdra l'accès aux dossiers internes à la vérification.`)) return;
      statut("Enregistrement…");
      try {
        await enregistrerEncadrement(encadrement.liste.filter((q) => q.email !== email));
        messageStatut = `✅ ${aff(email)} retiré(e) de l'ancienne liste. Mise à jour des accès en cours…`;
        rendre();
        await lancer();
        messageStatut = `✅ ${aff(email)} retiré(e) de l'ancienne liste. Accès mis à jour.`; rendre();
      } catch (e) { statut("❌ " + e.message); }
    }));
    $("adVerifier").onclick = () => lancer();
    const ret = $("adRetirer");
    if (ret) ret.onclick = async () => {
      if (!confirm("Retirer l'accès à ces adresses inconnues sur les dossiers internes ?")) return;
      ret.disabled = true; ret.textContent = "Retrait…";
      await lancer(true);
    };
  }

  let lancement = null;
  function lancer(appliquerProposes = false) {
    if (lancement) { aRefaire = true; rendre(); return lancement; }
    lancement = (async () => {
      let ap = appliquerProposes;
      do {
        aRefaire = false;
        const p = verifier({ appliquerProposes: ap });
        ap = false;
        rendre();
        try { await p; }
        catch (e) { dernier = null; console.error("Accès Drive :", e); alert("Vérification des accès impossible : " + e.message); }
        rendre();
      } while (aRefaire);
    })().finally(() => { lancement = null; rendre(); });
    return lancement;
  }

  async function monter(conteneur) {
    racine = conteneur;
    if (!encadrement) { racine.innerHTML = '<div class="ad-vide">Chargement…</div>'; await chargerEncadrement().catch((e) => { encadrement = { spreadsheetId: null, liste: [] }; console.warn(e); }); }
    const d = await droits().catch(() => ({ ok: false, email: "", erreur: "?" }));
    if (d.ok) await personnelLu().catch(() => false);
    if (!d.ok && (d.pasConnecte || d.erreur)) {
      racine.innerHTML = `<div class="se-panel ad-verrou"><div class="ad-verrou-ic">⏳</div><h2>${d.pasConnecte ? "Connexion Google en attente" : "Vérification du compte impossible"}</h2>
        <p>${d.pasConnecte ? "Connecte-toi (bouton en bas à gauche), puis reviens sur « Accès Drive »." : "Google n'a pas répondu (" + esc(d.erreur) + "). Réessaie dans un instant."}</p>
        <button type="button" class="ad-btn pri" id="adReessayer" style="margin-top:10px">Réessayer</button></div>`;
      racine.querySelector("#adReessayer").onclick = () => monter(conteneur);
      return;
    }
    if (!d.ok) {
      racine.innerHTML = `<div class="se-panel ad-verrou"><div class="ad-verrou-ic">🔒</div><h2>Réservé à l'encadrement</h2>
        <p>Cet écran modifie les accès au Drive FTS. Il est réservé au propriétaire du Drive et aux personnes de l'encadrement en « Lecture + modification ».</p>
        <p class="ad-sub">Compte connecté : <b>${esc(aff(d.email || "") || "inconnu")}</b>${d.lecture ? " — inscrit en lecture seule" : ""}</p></div>`;
      return;
    }
    rendre();
    lancer();
  }

  return { monter, verifier, verifierAJour, resume, chargerEncadrement, droits, DOSSIERS };
})();
window.FTSAcces = FTSAcces;
