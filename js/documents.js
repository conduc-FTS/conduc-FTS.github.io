/**
 * documents.js — Onglet DOCUMENTS de la tablette + visionneuse intégrée
 *
 *  - Dossiers du chantier à gauche (avec « Récents » et compteurs),
 *    fichiers en vignettes à droite, recherche sur tout le chantier.
 *  - Visionneuse plein écran (PDF.js, servi depuis /lib/pdfjs) : toutes
 *    les pages, zoom au pincement / double-tap / boutons, mini-plan.
 *  - Mode hors ligne : chaque fichier ouvert est gardé sur la tablette
 *    (Cache Storage), « Tout garder hors ligne » enregistre un dossier
 *    entier. Ce qui appartient à un autre chantier est retiré quand le
 *    chef change de chantier.
 */
const FTSDocs = (() => {
  const CACHE_DOCS = "fts-docs-v1";
  const CLE_INDEX_HL = "fts_docs_horsligne";
  const CLE_VUS = "fts_docs_vus";
  const CLE_AIDE = "fts_docs_aide_zoom";
  const PREFIXE_LISTE = "fts_docs_index_";
  const DUREE_LISTE_FRAICHE = 120000;      // relecture Drive au-delà de 2 min
  const NOUVEAU_MS = 3 * 86400000;          // « NOUVEAU » pendant 3 jours
  const SEUIL_CONFIRMATION = 50 * 1048576;  // au-delà de 50 Mo on demande confirmation

  const ORDRE_DOSSIERS = ["PLAN", "NDC", "SECURITE", "ACCUEIL SECURITE", "RAPPORT JOURNALIER", "DICT", "SONDAGE"];
  const ICONES = { "RECENTS": "🕒", "PLAN": "📐", "NDC": "📄", "SECURITE": "🦺", "ACCUEIL SECURITE": "🛡️", "RAPPORT JOURNALIER": "📋", "DICT": "📑", "SONDAGE": "🪨" };
  const LIBELLES = { "RECENTS": "Récents", "ACCUEIL SECURITE": "ACCUEIL SÉCURITÉ", "SECURITE": "SÉCURITÉ" };
  const JOURS_ABBR = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

  let opts = { getChantierActif: () => null, toast: () => {} };
  let liste = null;            // { chantierId, dossiers:[{id,cle,name}], fichiers:[...], maj }
  let dossierCourant = "RECENTS";
  let chargementEnCours = null;
  let confirmationGarder = 0;

  // ─── Utilitaires ─────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
  }
  function enLigne() { return navigator.onLine !== false; }
  function connecte() { return !!(window.FTSAuth && FTSAuth.isSignedIn() && window.FTSDrive); }
  function lireJSON(cle, defaut) {
    try { const r = localStorage.getItem(cle); return r ? JSON.parse(r) : defaut; } catch (e) { return defaut; }
  }
  function ecrireJSON(cle, v) {
    try { localStorage.setItem(cle, JSON.stringify(v)); } catch (e) { /* stockage plein : on continue sans */ }
  }
  function taille(octets) {
    const n = Number(octets) || 0;
    if (!n) return "";
    if (n < 1048576) return `${Math.max(1, Math.round(n / 1024))} Ko`;
    return `${(n / 1048576).toFixed(1).replace(".", ",")} Mo`;
  }
  function dateRelative(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const auj = new Date(); auj.setHours(0, 0, 0, 0);
    const j = new Date(d); j.setHours(0, 0, 0, 0);
    const diff = Math.round((auj - j) / 86400000);
    const h = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    if (diff === 0) return `Auj. ${h}`;
    if (diff === 1) return `Hier ${h}`;
    if (diff > 1 && diff < 7) return `${JOURS_ABBR[d.getDay()]} ${h}`;
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}${d.getFullYear() !== new Date().getFullYear() ? "/" + d.getFullYear() : ""}`;
  }
  function titreCas(s) {
    return String(s || "").toLowerCase().replace(/(^|[\s-])\S/g, (m) => m.toUpperCase());
  }

  /** Type d'affichage d'un fichier Drive. */
  function genre(f) {
    const m = f.mimeType || "";
    const n = (f.name || "").toLowerCase();
    if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
    if (m.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic)$/.test(n)) return "img";
    if (m.includes("spreadsheet") || m.includes("excel") || /\.(xlsx?|csv|ods)$/.test(n)) return "xls";
    if (m.includes("document") || m.includes("word") || /\.(docx?|odt)$/.test(n)) return "doc";
    return "autre";
  }
  function estGoogleNatif(f) { return (f.mimeType || "").startsWith("application/vnd.google-apps."); }
  /** Seuls les PDF et les images s'affichent dans l'appli (et se gardent hors ligne). */
  function estAffichable(f) { return !estGoogleNatif(f) && (genre(f) === "pdf" || (genre(f) === "img" && !/heic/i.test(f.mimeType + f.name))); }
  function extension(f) {
    if (estGoogleNatif(f)) return (f.mimeType || "").includes("spreadsheet") ? "SHEET" : (f.mimeType || "").includes("document") ? "GDOC" : "DRIVE";
    const m = /\.([a-z0-9]{2,5})$/i.exec(f.name || "");
    return m ? m[1].toUpperCase() : "FICHIER";
  }

  /**
   * Nom lisible : « 2026-11-05_Rapport journalier_26FTS099_HUGO LAJUS ATELIER 2.pdf »
   * devient « Rapport du jeu. 05/11 » + « Hugo Lajus · atelier 2 ».
   */
  function nomAffiche(f) {
    const nom = f.name || "";
    const rj = /^(\d{4})-(\d{2})-(\d{2})_Rapport journalier_[^_]+_(.+?)\.pdf$/i.exec(nom);
    if (rj) {
      const d = new Date(Number(rj[1]), Number(rj[2]) - 1, Number(rj[3]));
      let chef = rj[4];
      let atelier = "";
      const at = / ATELIER (\d+)$/i.exec(chef);
      if (at) { atelier = ` · atelier ${at[1]}`; chef = chef.slice(0, at.index); }
      return { titre: `Rapport du ${JOURS_ABBR[d.getDay()]} ${rj[3]}/${rj[2]}`, detail: titreCas(chef) + atelier, rapport: true };
    }
    return { titre: nom.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/_/g, " "), detail: "", rapport: false };
  }

  // ─── Mode hors ligne (Cache Storage + index) ──────────────────
  const HorsLigne = {
    dispo() { return typeof caches !== "undefined"; },
    index() { return lireJSON(CLE_INDEX_HL, {}); },
    url(id) { return new URL(`/__docs/${encodeURIComponent(id)}`, location.origin).href; },
    a(id) { return !!this.index()[id]; },
    async lire(id) {
      if (!this.dispo() || !this.a(id)) return null;
      try {
        const c = await caches.open(CACHE_DOCS);
        const r = await c.match(this.url(id));
        return r ? await r.blob() : null;
      } catch (e) { return null; }
    },
    async garder(f, blob, chantierId) {
      if (!this.dispo()) return false;
      try {
        const c = await caches.open(CACHE_DOCS);
        await c.put(this.url(f.id), new Response(blob, { headers: { "Content-Type": blob.type || f.mimeType || "application/octet-stream" } }));
        const idx = this.index();
        idx[f.id] = { chantierId, nom: f.name, taille: blob.size, mimeType: f.mimeType || blob.type, modifiedTime: f.modifiedTime || "", le: Date.now() };
        ecrireJSON(CLE_INDEX_HL, idx);
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        return true;
      } catch (e) {
        console.warn("Impossible de garder le fichier hors ligne :", e);
        return false;
      }
    },
    async retirer(ids) {
      const idx = this.index();
      if (this.dispo()) {
        try {
          const c = await caches.open(CACHE_DOCS);
          await Promise.all(ids.map((id) => c.delete(this.url(id))));
        } catch (e) { /* rien */ }
      }
      ids.forEach((id) => delete idx[id]);
      ecrireJSON(CLE_INDEX_HL, idx);
    },
    async retirerSauf(chantierId) {
      const idx = this.index();
      const ids = Object.keys(idx).filter((id) => idx[id].chantierId !== chantierId);
      if (ids.length) await this.retirer(ids);
      return ids.length;
    },
    async toutRetirer() {
      if (this.dispo()) { try { await caches.delete(CACHE_DOCS); } catch (e) { /* rien */ } }
      ecrireJSON(CLE_INDEX_HL, {});
    },
    stats() {
      const idx = this.index();
      const ids = Object.keys(idx);
      return { nb: ids.length, taille: ids.reduce((s, id) => s + (Number(idx[id].taille) || 0), 0) };
    },
    /** Le fichier enregistré est-il encore la dernière version Drive ? */
    aJour(f) {
      const e = this.index()[f.id];
      return !!e && (!f.modifiedTime || !e.modifiedTime || e.modifiedTime === f.modifiedTime);
    },
  };

  function marquerVu(id) {
    const vus = lireJSON(CLE_VUS, []);
    if (vus.includes(id)) return;
    vus.push(id);
    ecrireJSON(CLE_VUS, vus.slice(-800));
  }
  function estNouveau(f, vus) {
    const t = new Date(f.createdTime || f.modifiedTime || 0).getTime();
    return Date.now() - t < NOUVEAU_MS && !vus.includes(f.id);
  }

  // ─── Liste des documents du chantier ──────────────────────────
  async function lireDepuisDrive(actif) {
    const code = actif.name.split(/\s+/)[0];
    const { dossiers } = await FTSDrive.getSousDossiersChantier(code);
    // Dossiers de 1er niveau (PLAN, NDC…) + ACCUEIL SECURITE à part
    const hauts = dossiers.filter((d) => !d.name.includes("/"));
    const entrees = hauts.map((d) => ({ id: d.id, cle: norm(d.name), name: d.name }));
    const accueil = dossiers.find((d) => d.name.includes("/"));
    if (accueil) entrees.push({ id: accueil.id, cle: "ACCUEIL SECURITE", name: "ACCUEIL SECURITE" });

    // Sous-dossiers (indices de plans…) rattachés à leur dossier principal
    const rattache = {};
    entrees.forEach((e) => { rattache[e.id] = { cle: e.cle, sous: "" }; });
    const sous = await FTSDrive.listFoldersInFolders(hauts.map((d) => d.id)).catch(() => []);
    sous.forEach((sd) => {
      if (rattache[sd.id]) return; // ACCUEIL SECURITE, déjà listé à part
      const parent = rattache[(sd.parents || [])[0]];
      if (parent) rattache[sd.id] = { cle: parent.cle, sous: sd.name };
    });

    const bruts = await FTSDrive.listFilesInFolders(Object.keys(rattache));
    const fichiers = bruts.map((f) => {
      const r = rattache[(f.parents || []).find((p) => rattache[p])] || { cle: "", sous: "" };
      return {
        id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, createdTime: f.createdTime,
        modifiedTime: f.modifiedTime, webViewLink: f.webViewLink, thumbnailLink: f.thumbnailLink,
        dossier: r.cle, sous: r.sous,
      };
    }).sort((a, b) => new Date(b.modifiedTime || b.createdTime) - new Date(a.modifiedTime || a.createdTime));

    entrees.sort((a, b) => {
      const ia = ORDRE_DOSSIERS.indexOf(a.cle), ib = ORDRE_DOSSIERS.indexOf(b.cle);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.cle.localeCompare(b.cle);
    });
    return { chantierId: actif.id, dossiers: entrees, fichiers, maj: Date.now() };
  }

  async function charger(forcer) {
    const actif = opts.getChantierActif();
    if (!actif) { liste = null; return null; }
    const enStock = lireJSON(PREFIXE_LISTE + actif.id, null);
    if (!liste || liste.chantierId !== actif.id) liste = enStock;
    const frais = liste && Date.now() - liste.maj < DUREE_LISTE_FRAICHE;
    if ((forcer || !frais) && enLigne() && connecte()) {
      if (!chargementEnCours) {
        chargementEnCours = lireDepuisDrive(actif)
          .then((l) => {
            liste = l;
            // vignettes : liens temporaires, inutiles à garder
            ecrireJSON(PREFIXE_LISTE + actif.id, { ...l, fichiers: l.fichiers.map((f) => ({ ...f, thumbnailLink: undefined })) });
            return l;
          })
          .finally(() => { chargementEnCours = null; });
      }
      await chargementEnCours;
    }
    return liste;
  }

  // ─── Rendu de l'onglet ────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  function fichiersDuDossier(cle) {
    if (!liste) return [];
    if (cle === "RECENTS") return liste.fichiers.slice(0, 12);
    return liste.fichiers.filter((f) => f.dossier === cle);
  }

  function rendreDossiers() {
    const vus = lireJSON(CLE_VUS, []);
    const items = [{ cle: "RECENTS", name: "RECENTS" }, ...((liste && liste.dossiers) || [])];
    $("dcSide").innerHTML = `<h4>Dossiers du chantier</h4>` + items.map((d) => {
      const fs = fichiersDuDossier(d.cle);
      const nouveau = fs.some((f) => estNouveau(f, vus));
      return `<button type="button" class="dc-f${d.cle === dossierCourant ? " on" : ""}" data-cle="${esc(d.cle)}">
        <span class="ic">${ICONES[d.cle] || "📁"}</span>${esc(LIBELLES[d.cle] || d.name)}${nouveau ? '<span class="new"></span>' : ""}<span class="n">${fs.length}</span></button>`;
    }).join("");
    $("dcSide").querySelectorAll(".dc-f").forEach((b) => b.addEventListener("click", () => {
      dossierCourant = b.dataset.cle;
      $("dcRecherche").value = "";
      confirmationGarder = 0;
      rendre();
      b.scrollIntoView({ block: "nearest", inline: "nearest" });
    }));
  }

  function carte(f, vus, avecDossier) {
    const g = genre(f);
    const n = nomAffiche(f);
    const hl = HorsLigne.a(f.id);
    const indispo = !enLigne() && !hl;
    const icone = { pdf: "📕", img: "🖼️", xls: "📊", doc: "📝", autre: "📄" }[g];
    const vignette = f.thumbnailLink && enLigne() && !n.rapport
      ? `<img src="${esc(f.thumbnailLink)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" style="position:absolute;inset:0">` : "";
    const meta = n.rapport
      ? [n.detail, dateRelative(f.createdTime)].filter(Boolean).join(" · ")
      : [f.sous, dateRelative(f.modifiedTime || f.createdTime), taille(f.size)].filter(Boolean).join(" · ");
    const dossier = avecDossier && f.dossier ? `<span class="dos">${esc(LIBELLES[f.dossier] || f.dossier)}</span>` : "";
    return `<button type="button" class="dc-card${indispo ? " indispo" : ""}" data-id="${esc(f.id)}">
      <div class="dc-th ${g}">${icone}${vignette}${estNouveau(f, vus) ? '<span class="dc-nv">NOUVEAU</span>' : ""}${hl ? '<span class="dc-off">✓ HORS LIGNE</span>' : ""}<span class="dc-ext">${esc(extension(f))}</span></div>
      <div class="dc-info"><b>${esc(n.titre)}</b>${dossier}<span>${esc(meta)}</span></div></button>`;
  }

  function rendre() {
    const actif = opts.getChantierActif();
    const grid = $("dcGrid");
    const statut = $("dcStatus");
    statut.className = "dc-status";
    if (!actif) {
      $("dcSide").innerHTML = "";
      $("dcTitre").textContent = "Documents";
      $("dcSub").textContent = "";
      $("dcGarder").hidden = true;
      grid.innerHTML = '<div class="dc-vide">Choisis d\'abord ton chantier : touche la carte « Chantier en cours » sur l\'accueil.</div>';
      statut.textContent = "";
      return;
    }
    if (!liste) {
      $("dcSide").innerHTML = "";
      $("dcTitre").textContent = "Documents";
      $("dcSub").textContent = actif.name;
      $("dcGarder").hidden = true;
      grid.innerHTML = `<div class="dc-vide">${!enLigne() ? "Pas de réseau, et la liste des documents de ce chantier n'a pas encore été enregistrée sur la tablette." : !connecte() ? "Connecte-toi (bouton en haut à droite) pour voir les documents du chantier." : "Chargement des documents…"}</div>`;
      return;
    }
    if (dossierCourant !== "RECENTS" && !liste.dossiers.some((d) => d.cle === dossierCourant)) dossierCourant = "RECENTS";
    rendreDossiers();

    const vus = lireJSON(CLE_VUS, []);
    const q = norm($("dcRecherche").value);
    const code = actif.name.split(/\s+/)[0];
    let fs, titre;
    if (q) {
      fs = liste.fichiers.filter((f) => norm(`${f.name} ${nomAffiche(f).titre} ${f.sous}`).includes(q));
      titre = `🔍 « ${$("dcRecherche").value.trim()} »`;
    } else {
      fs = fichiersDuDossier(dossierCourant);
      titre = `${ICONES[dossierCourant] || "📁"} ${titreCas(LIBELLES[dossierCourant] || dossierCourant)}`;
    }
    $("dcTitre").textContent = titre;
    const nbHL = fs.filter((f) => HorsLigne.a(f.id)).length;
    $("dcSub").textContent = `${code} · ${fs.length} fichier${fs.length > 1 ? "s" : ""}${nbHL ? ` · ${nbHL} disponible${nbHL > 1 ? "s" : ""} hors ligne` : ""}${dossierCourant === "RECENTS" && !q ? " · les plus récents" : ""}`;

    if (!enLigne()) {
      statut.textContent = `📡 Hors ligne · liste enregistrée le ${new Date(liste.maj).toLocaleDateString("fr-FR")} à ${new Date(liste.maj).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}. Les fichiers grisés n'ont pas été gardés sur la tablette.`;
      statut.className = "dc-status alerte";
    } else if (!connecte()) {
      statut.textContent = "Connecte-toi (bouton en haut à droite) pour mettre la liste à jour.";
      statut.className = "dc-status alerte";
    } else if (!confirmationGarder) {
      statut.textContent = "";
    }

    // Bouton « Tout garder hors ligne »
    const aGarder = fs.filter((f) => estAffichable(f) && !HorsLigne.aJour(f));
    const btn = $("dcGarder");
    btn.hidden = !HorsLigne.dispo() || !fs.some(estAffichable);
    if (!btn.hidden && !btn.dataset.enCours) {
      const total = aGarder.reduce((s, f) => s + (Number(f.size) || 0), 0);
      btn.disabled = !aGarder.length || !enLigne() || !connecte();
      btn.textContent = !aGarder.length ? "✓ Tout est hors ligne"
        : confirmationGarder ? `Confirmer : ${taille(total)} à télécharger`
        : `📥 Tout garder hors ligne (${aGarder.length})`;
    }

    grid.innerHTML = fs.length
      ? fs.map((f) => carte(f, vus, !!q || dossierCourant === "RECENTS")).join("")
      : `<div class="dc-vide">${q ? "Aucun fichier ne correspond à ta recherche." : "Ce dossier est vide."}</div>`;
    grid.querySelectorAll(".dc-card").forEach((c) => c.addEventListener("click", () => {
      const f = liste.fichiers.find((x) => x.id === c.dataset.id);
      if (f) ouvrir(f);
    }));
  }

  async function afficher(forcer) {
    rendre();
    try {
      await charger(forcer);
    } catch (e) {
      console.error("Erreur chargement documents :", e);
      if (!liste) {
        $("dcGrid").innerHTML = `<div class="dc-vide">Impossible de lire les documents : ${esc(e.message)}</div>`;
        return;
      }
      $("dcStatus").textContent = `Liste non mise à jour (${e.message}) : affichage de la dernière liste enregistrée.`;
      $("dcStatus").className = "dc-status alerte";
    }
    rendre();
  }

  async function toutGarder() {
    const btn = $("dcGarder");
    const actif = opts.getChantierActif();
    if (!liste || !actif || btn.dataset.enCours) return;
    const q = norm($("dcRecherche").value);
    const fs = (q ? liste.fichiers.filter((f) => norm(`${f.name} ${nomAffiche(f).titre}`).includes(q)) : fichiersDuDossier(dossierCourant))
      .filter((f) => estAffichable(f) && !HorsLigne.aJour(f));
    if (!fs.length) return;
    const total = fs.reduce((s, f) => s + (Number(f.size) || 0), 0);
    if (total > SEUIL_CONFIRMATION && !confirmationGarder) {
      confirmationGarder = Date.now();
      $("dcStatus").textContent = `${fs.length} fichiers pour ${taille(total)} : touche à nouveau le bouton pour confirmer (de préférence en wifi).`;
      rendre();
      setTimeout(() => { if (confirmationGarder && Date.now() - confirmationGarder >= 7900) { confirmationGarder = 0; rendre(); } }, 8000);
      return;
    }
    confirmationGarder = 0;
    btn.dataset.enCours = "1";
    btn.disabled = true;
    let ok = 0, ko = 0;
    for (let i = 0; i < fs.length; i++) {
      btn.textContent = `📥 Enregistrement ${i + 1} / ${fs.length}…`;
      try {
        const blob = await FTSDrive.downloadFileBlob(fs[i].id);
        if (await HorsLigne.garder(fs[i], blob, actif.id)) ok++; else ko++;
      } catch (e) {
        ko++;
        console.warn("Échec hors ligne", fs[i].name, e);
        if (!enLigne()) break;
      }
    }
    delete btn.dataset.enCours;
    opts.toast(ko ? `${ok} fichier(s) gardé(s) hors ligne, ${ko} en échec (réseau ?).` : `✓ ${ok} fichier(s) disponibles sans réseau.`);
    rendre();
  }

  // ─── Visionneuse ──────────────────────────────────────────────
  let pdfjsPromesse = null;
  function chargerPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsPromesse) {
      pdfjsPromesse = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "/lib/pdfjs/pdf.min.js";
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/lib/pdfjs/pdf.worker.min.js";
          resolve(window.pdfjsLib);
        };
        s.onerror = () => { pdfjsPromesse = null; reject(new Error("Visionneuse PDF introuvable (réseau ?)")); };
        document.head.appendChild(s);
      });
    }
    return pdfjsPromesse;
  }

  const V = {
    fichier: null, blob: null, urlObjet: null, pdf: null, worker: null,
    pages: [],          // { el, w1, h1, page (pdf.js), img, base, rendu, tache, detail, tacheDetail }
    echelle: 1, ajuste: 1, jeton: 0,
  };
  const RAPPORT_MAX = 8;          // zoom max = 8 × « ajusté »
  const PIXELS_BASE = 4e6;        // résolution max du rendu d'une page entière
  const PIXELS_DETAIL = 9e6;      // résolution max de la zone zoomée

  function zone() { return $("vwZone"); }

  async function ouvrir(f) {
    const vw = $("vw");
    const jeton = ++V.jeton;
    fermerContenu();
    V.fichier = f;
    const n = nomAffiche(f);
    $("vwTitre").textContent = n.titre;
    $("vwSousTitre").textContent = [LIBELLES[f.dossier] || f.dossier, f.sous, n.detail, taille(f.size)].filter(Boolean).join(" · ");
    $("vwDrive").href = f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`;
    $("vwTelecharger").hidden = true;
    $("vwBarre").hidden = true;
    $("vwMini").hidden = true;
    $("vwOff").hidden = true;
    message("⏳", "Ouverture…");
    vw.hidden = false;
    document.body.style.overflow = "hidden";
    history.pushState({ vw: true }, "");
    marquerVu(f.id);

    if (!estAffichable(f)) {
      if (enLigne() && connecte()) {
        message("", "");
        $("vwMessage").hidden = true;
        $("vwInner").innerHTML = `<iframe class="vw-frame" src="https://drive.google.com/file/d/${encodeURIComponent(f.id)}/preview" title="Aperçu"></iframe>`;
        $("vwInner").style.cssText = "width:100%;height:100%;padding:0";
      } else {
        message("📡", "Ce type de fichier ne s'affiche qu'avec du réseau. Utilise « Ouvrir dans Drive » quand le réseau revient.");
      }
      return;
    }

    try {
      let blob = await HorsLigne.lire(f.id);
      const perime = blob && !HorsLigne.aJour(f) && enLigne() && connecte();
      if (!blob || perime) {
        if (!enLigne()) throw new Error("hors-ligne");
        if (!connecte()) throw new Error("non-connecte");
        try {
          blob = await FTSDrive.downloadFileBlob(f.id);
          const actif = opts.getChantierActif();
          if (actif) await HorsLigne.garder(f, blob, actif.id);
        } catch (e) {
          if (!blob) throw e; // ancienne version gardée : on l'affiche quand même
        }
      }
      if (jeton !== V.jeton) return;
      V.blob = blob;
      V.urlObjet = URL.createObjectURL(blob);
      $("vwTelecharger").hidden = false;
      $("vwOff").hidden = !HorsLigne.a(f.id);
      setTimeout(() => { if (jeton === V.jeton) $("vwOff").hidden = true; }, 3500);
      if (genre(f) === "pdf") await afficherPdf(blob, jeton); else await afficherImage(jeton);
      if (jeton !== V.jeton) return;
      $("vwMessage").hidden = true;
      $("vwBarre").hidden = false;
      aideZoom();
      rendrir();
    } catch (e) {
      if (jeton !== V.jeton) return;
      console.warn("Visionneuse :", e);
      if (e.message === "hors-ligne") message("📡", "Pas de réseau, et ce fichier n'a pas été gardé hors ligne sur la tablette.<br>Pense à l'ouvrir (ou à « Tout garder hors ligne ») quand tu as du réseau.");
      else if (e.message === "non-connecte") message("🔒", "Connecte-toi (bouton en haut à droite de l'accueil) pour ouvrir ce fichier.");
      else message("⚠️", `Impossible d'afficher ce fichier : ${esc(e.message)}.<br>Essaie « Ouvrir dans Drive ».`);
    }
  }

  function message(icone, html) {
    const m = $("vwMessage");
    m.hidden = !html;
    m.innerHTML = `${icone ? `<span class="big">${icone}</span>` : ""}${html}`;
  }

  function aideZoom() {
    const n = Number(lireJSON(CLE_AIDE, 0)) || 0;
    if (n >= 3) return;
    ecrireJSON(CLE_AIDE, n + 1);
    const a = $("vwAide");
    a.hidden = false;
    setTimeout(() => { a.hidden = true; }, 4000);
  }

  async function afficherPdf(blob, jeton) {
    const lib = await chargerPdfJs();
    const donnees = new Uint8Array(await blob.arrayBuffer());
    // Un seul « worker » PDF.js réutilisé : il est chargé une fois, et
    // reste disponible même si le réseau tombe ensuite.
    if (!V.worker) V.worker = new lib.PDFWorker();
    const pdf = await lib.getDocument({ data: donnees, isEvalSupported: false, worker: V.worker }).promise;
    if (jeton !== V.jeton) { pdf.destroy(); return; }
    V.pdf = pdf;
    const inner = $("vwInner");
    inner.innerHTML = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      if (jeton !== V.jeton) return;
      const vp = page.getViewport({ scale: 1 });
      const el = document.createElement("div");
      el.className = "vw-page";
      el.innerHTML = '<div class="vw-load">Page ' + i + "…</div>";
      inner.appendChild(el);
      V.pages.push({ el, w1: vp.width, h1: vp.height, page });
    }
    calculerAjuste();
    V.echelle = V.ajuste;
    disposer();
  }

  async function afficherImage(jeton) {
    const img = new Image();
    img.decoding = "async";
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("image illisible")); img.src = V.urlObjet; });
    if (jeton !== V.jeton) return;
    const el = document.createElement("div");
    el.className = "vw-page";
    el.appendChild(img);
    $("vwInner").innerHTML = "";
    $("vwInner").appendChild(el);
    V.pages.push({ el, w1: img.naturalWidth, h1: img.naturalHeight, img });
    calculerAjuste();
    V.echelle = V.ajuste;
    disposer();
  }

  function calculerAjuste() {
    if (!V.pages.length) return;
    const z = zone();
    const maxW = Math.max(...V.pages.map((p) => p.w1));
    const largeur = Math.max(200, z.clientWidth - 24);
    let a = largeur / maxW;
    // une page seule (plan, photo) : elle doit tenir entière à l'écran
    if (V.pages.length === 1) a = Math.min(a, Math.max(150, z.clientHeight - 24) / V.pages[0].h1);
    V.ajuste = a;
  }

  function disposer() {
    V.pages.forEach((p) => {
      p.el.style.width = `${Math.round(p.w1 * V.echelle)}px`;
      p.el.style.height = `${Math.round(p.h1 * V.echelle)}px`;
    });
    $("vwZoom").textContent = `${Math.round((V.echelle / V.ajuste) * 100)} %`;
  }

  /** Point de la page sous (cx, cy) — coordonnées relatives à la zone. */
  function ancre(cx, cy) {
    const zr = zone().getBoundingClientRect();
    const x = zr.left + cx, y = zr.top + cy;
    let best = 0, dist = Infinity;
    V.pages.forEach((p, i) => {
      const r = p.el.getBoundingClientRect();
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (dx + dy < dist) { dist = dx + dy; best = i; }
    });
    const r = V.pages[best].el.getBoundingClientRect();
    return { i: best, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
  }
  /** Fait revenir le point ancré sous (cx, cy) après un changement de zoom. */
  function replacer(a, cx, cy) {
    const z = zone();
    const zr = z.getBoundingClientRect();
    const r = V.pages[a.i].el.getBoundingClientRect();
    z.scrollLeft += r.left + a.fx * r.width - (zr.left + cx);
    z.scrollTop += r.top + a.fy * r.height - (zr.top + cy);
  }
  function bornes() { return [V.ajuste * 0.75, Math.max(V.ajuste * RAPPORT_MAX, 3)]; }

  function zoomer(nouvelle, cx, cy) {
    if (!V.pages.length) return;
    const z = zone();
    const [min, max] = bornes();
    nouvelle = Math.min(max, Math.max(min, nouvelle));
    if (cx == null) { cx = z.clientWidth / 2; cy = z.clientHeight / 2; }
    const a = ancre(cx, cy);
    V.echelle = nouvelle;
    disposer();
    replacer(a, cx, cy);
    rendrir();
  }

  // Rendu des pages visibles (rendu de base + zone zoomée nette)
  let rafRendu = 0, minuterieDetail = 0;
  function rendrir() {
    if (rafRendu) return;
    rafRendu = requestAnimationFrame(() => {
      rafRendu = 0;
      rendreVisibles();
      majCompteurEtMini();
      clearTimeout(minuterieDetail);
      minuterieDetail = setTimeout(rendreDetails, 180);
    });
  }

  function rectVisible(p) {
    const z = zone();
    const zr = z.getBoundingClientRect();
    const r = p.el.getBoundingClientRect();
    return { zr, r, visible: r.bottom > zr.top - zr.height && r.top < zr.bottom + zr.height && r.right > zr.left && r.left < zr.right };
  }

  function rendreVisibles() {
    if (!V.pdf) return;
    const dpr = window.devicePixelRatio || 1;
    V.pages.forEach((p, i) => {
      const { visible } = rectVisible(p);
      if (!visible) {
        // pages éloignées : on libère la mémoire
        if (p.base && Math.abs(i - pageCourante()) > 3) { p.base.width = 0; p.base.remove(); p.base = null; p.rendu = 0; }
        if (p.detail) { p.detail.remove(); p.detail = null; }
        return;
      }
      let s = V.echelle * dpr;
      const pix = p.w1 * p.h1 * s * s;
      if (pix > PIXELS_BASE) s = Math.sqrt(PIXELS_BASE / (p.w1 * p.h1));
      if (p.base && Math.abs(p.rendu - s) / s < 0.15) return;
      if (p.tache) { try { p.tache.cancel(); } catch (e) { /* rien */ } }
      const c = document.createElement("canvas");
      const vp = p.page.getViewport({ scale: s });
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      c.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
      p.tache = p.page.render({ canvasContext: c.getContext("2d"), viewport: vp });
      p.tache.promise.then(() => {
        if (p.base) { p.base.width = 0; p.base.remove(); }
        const ld = p.el.querySelector(".vw-load"); if (ld) ld.remove();
        p.el.insertBefore(c, p.el.firstChild);
        p.base = c; p.rendu = s; p.tache = null;
        if (i === pageCourante()) dessinerMini(true);
      }).catch(() => { /* rendu annulé */ });
    });
  }

  function rendreDetails() {
    if (!V.pdf) return;
    const dpr = window.devicePixelRatio || 1;
    const s = V.echelle * dpr;
    V.pages.forEach((p) => {
      const { zr, r, visible } = rectVisible(p);
      if (!visible || !p.base || p.rendu >= s * 0.9) { if (p.detail && (!visible || (p.base && p.rendu >= s * 0.9))) { p.detail.remove(); p.detail = null; } return; }
      // portion de la page réellement à l'écran (en px CSS dans la page)
      const x0 = Math.max(0, zr.left - r.left), y0 = Math.max(0, zr.top - r.top);
      const x1 = Math.min(r.width, zr.right - r.left), y1 = Math.min(r.height, zr.bottom - r.top);
      if (x1 <= x0 || y1 <= y0) return;
      let w = x1 - x0, h = y1 - y0, sd = s / V.echelle; // px canvas par px CSS
      if (w * h * sd * sd > PIXELS_DETAIL) sd = Math.sqrt(PIXELS_DETAIL / (w * h));
      if (p.tacheDetail) { try { p.tacheDetail.cancel(); } catch (e) { /* rien */ } }
      const c = document.createElement("canvas");
      c.width = Math.floor(w * sd);
      c.height = Math.floor(h * sd);
      c.style.cssText = `position:absolute;left:${x0}px;top:${y0}px;width:${w}px;height:${h}px`;
      const vp = p.page.getViewport({ scale: V.echelle * sd, offsetX: -x0 * sd, offsetY: -y0 * sd });
      const echelleTache = V.echelle;
      p.tacheDetail = p.page.render({ canvasContext: c.getContext("2d"), viewport: vp });
      p.tacheDetail.promise.then(() => {
        p.tacheDetail = null;
        if (echelleTache !== V.echelle) return;
        if (p.detail) p.detail.remove();
        p.el.appendChild(c);
        p.detail = c;
      }).catch(() => { /* rendu annulé */ });
    });
  }

  function pageCourante() {
    const z = zone();
    const milieu = z.getBoundingClientRect().top + z.clientHeight / 2;
    let best = 0, dist = Infinity;
    V.pages.forEach((p, i) => {
      const r = p.el.getBoundingClientRect();
      const d = milieu < r.top ? r.top - milieu : milieu > r.bottom ? milieu - r.bottom : 0;
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  }

  let miniPage = -1;
  function dessinerMini(forcer) {
    const i = pageCourante();
    const p = V.pages[i];
    if (!p) return;
    if (!forcer && miniPage === i) return;
    const source = p.base || p.img;
    if (!source) return;
    const c = $("vwMiniCanvas");
    const w = 150 * 2;
    c.width = w;
    c.height = Math.round((w * p.h1) / p.w1);
    try { c.getContext("2d").drawImage(source, 0, 0, c.width, c.height); miniPage = i; } catch (e) { /* rien */ }
  }

  function majCompteurEtMini() {
    if (!V.pages.length) return;
    const i = pageCourante();
    $("vwPage").textContent = `Page ${i + 1} / ${V.pages.length}`;
    const p = V.pages[i];
    const z = zone();
    const zr = z.getBoundingClientRect(), r = p.el.getBoundingClientRect();
    const deborde = r.width > zr.width * 1.05 || r.height > zr.height * 1.05;
    const zoome = V.echelle > V.ajuste * 1.3;
    $("vwMini").hidden = !(deborde && zoome);
    if ($("vwMini").hidden) return;
    dessinerMini(false);
    const fx0 = Math.max(0, (zr.left - r.left) / r.width), fy0 = Math.max(0, (zr.top - r.top) / r.height);
    const fx1 = Math.min(1, (zr.right - r.left) / r.width), fy1 = Math.min(1, (zr.bottom - r.top) / r.height);
    const cad = $("vwCad");
    cad.style.left = `${fx0 * 100}%`;
    cad.style.top = `${fy0 * 100}%`;
    cad.style.width = `${Math.max(2, (fx1 - fx0) * 100)}%`;
    cad.style.height = `${Math.max(2, (fy1 - fy0) * 100)}%`;
  }

  // Gestes : pincement (2 doigts) et double-tap
  const geste = { actif: false, d0: 0, e0: 1, a: null, ox: 0, oy: 0, cx0: 0, cy0: 0, cx: 0, cy: 0, f: 1, dernierTap: 0, tx: 0, ty: 0 };
  function distance(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
  function centre(t, zr) { return { x: (t[0].clientX + t[1].clientX) / 2 - zr.left, y: (t[0].clientY + t[1].clientY) / 2 - zr.top }; }

  function initGestes() {
    const z = zone();
    const inner = $("vwInner");
    z.addEventListener("scroll", rendrir, { passive: true });
    z.addEventListener("touchstart", (e) => {
      if (!V.pages.length) return;
      if (e.touches.length === 2) {
        const zr = z.getBoundingClientRect();
        const c = centre(e.touches, zr);
        const ir = inner.getBoundingClientRect();
        Object.assign(geste, { actif: true, d0: distance(e.touches), e0: V.echelle, cx0: c.x, cy0: c.y, cx: c.x, cy: c.y, f: 1,
          a: ancre(c.x, c.y), ox: zr.left + c.x - ir.left, oy: zr.top + c.y - ir.top });
        inner.style.transformOrigin = `${geste.ox}px ${geste.oy}px`;
      }
    }, { passive: true });
    z.addEventListener("touchmove", (e) => {
      if (!geste.actif || e.touches.length !== 2) return;
      e.preventDefault();
      const zr = z.getBoundingClientRect();
      const c = centre(e.touches, zr);
      const [min, max] = bornes();
      geste.f = Math.min(max / geste.e0, Math.max(min / geste.e0, distance(e.touches) / geste.d0));
      geste.cx = c.x; geste.cy = c.y;
      inner.style.transform = `translate(${c.x - geste.cx0}px, ${c.y - geste.cy0}px) scale(${geste.f})`;
    }, { passive: false });
    const fin = (e) => {
      if (geste.actif && e.touches.length < 2) {
        geste.actif = false;
        inner.style.transform = "";
        V.echelle = geste.e0 * geste.f;
        disposer();
        replacer(geste.a, geste.cx, geste.cy);
        rendrir();
        geste.dernierTap = 0;
        return;
      }
      // double-tap (un doigt)
      if (e.changedTouches.length === 1 && e.touches.length === 0) {
        const t = e.changedTouches[0];
        const maintenant = Date.now();
        if (maintenant - geste.dernierTap < 300 && Math.hypot(t.clientX - geste.tx, t.clientY - geste.ty) < 40) {
          geste.dernierTap = 0;
          doubleTap(t.clientX, t.clientY);
          e.preventDefault();
        } else {
          geste.dernierTap = maintenant; geste.tx = t.clientX; geste.ty = t.clientY;
        }
      }
    };
    z.addEventListener("touchend", fin, { passive: false });
    z.addEventListener("touchcancel", fin, { passive: false });
    z.addEventListener("dblclick", (e) => doubleTap(e.clientX, e.clientY));
    // molette + Ctrl (PC) : zoom
    z.addEventListener("wheel", (e) => {
      if (!e.ctrlKey || !V.pages.length) return;
      e.preventDefault();
      const zr = z.getBoundingClientRect();
      zoomer(V.echelle * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - zr.left, e.clientY - zr.top);
    }, { passive: false });
    window.addEventListener("resize", () => {
      if ($("vw").hidden || !V.pages.length) return;
      const rel = V.echelle / V.ajuste;
      calculerAjuste();
      V.echelle = V.ajuste * rel;
      disposer();
      rendrir();
    });
  }

  function doubleTap(x, y) {
    if (!V.pages.length) return;
    const zr = zone().getBoundingClientRect();
    if (V.echelle < V.ajuste * 1.5) zoomer(V.ajuste * 2.5, x - zr.left, y - zr.top);
    else zoomer(V.ajuste);
  }

  function fermerContenu() {
    V.pages.forEach((p) => {
      try { if (p.tache) p.tache.cancel(); if (p.tacheDetail) p.tacheDetail.cancel(); } catch (e) { /* rien */ }
      if (p.base) p.base.width = 0;
    });
    V.pages = [];
    if (V.pdf) { try { V.pdf.destroy(); } catch (e) { /* rien */ } V.pdf = null; }
    if (V.urlObjet) { URL.revokeObjectURL(V.urlObjet); V.urlObjet = null; }
    V.blob = null;
    miniPage = -1;
    const inner = $("vwInner");
    inner.innerHTML = "";
    inner.style.cssText = "";
  }

  function fermer(depuisHistorique) {
    if ($("vw").hidden) return;
    V.jeton++;
    fermerContenu();
    $("vw").hidden = true;
    $("vwMessage").hidden = true;
    document.body.style.overflow = "";
    if (!depuisHistorique && history.state && history.state.vw) history.back();
    rendre(); // badges « hors ligne » / « nouveau » à jour
  }

  function telecharger() {
    if (!V.urlObjet || !V.fichier) return;
    const a = document.createElement("a");
    a.href = V.urlObjet;
    a.download = V.fichier.name || "document";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ─── Initialisation ───────────────────────────────────────────
  function init(o) {
    opts = { ...opts, ...o };
    $("dcRecherche").addEventListener("input", () => { confirmationGarder = 0; rendre(); });
    $("dcGarder").addEventListener("click", toutGarder);
    $("dcActualiser").addEventListener("click", () => afficher(true));
    $("vwRetour").addEventListener("click", () => fermer(false));
    $("vwTelecharger").addEventListener("click", telecharger);
    $("vwPlus").addEventListener("click", () => zoomer(V.echelle * 1.5));
    $("vwMoins").addEventListener("click", () => zoomer(V.echelle / 1.5));
    $("vwAjuster").addEventListener("click", () => { zoomer(V.ajuste); zone().scrollLeft = 0; });
    // bouton « retour » d'Android : ferme la visionneuse au lieu de quitter l'appli
    window.addEventListener("popstate", () => { if (!$("vw").hidden) fermer(true); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("vw").hidden) fermer(false); });
    initGestes();
  }

  /** Ouvre un fichier venant d'ailleurs (activité récente de l'accueil). */
  function ouvrirDepuisActivite(f) {
    const connu = liste && liste.fichiers.find((x) => x.id === f.id);
    ouvrir(connu || f);
  }

  async function changementDeChantier(nouveauId) {
    liste = null;
    dossierCourant = "RECENTS";
    return HorsLigne.retirerSauf(nouveauId);
  }

  return {
    init, afficher, rendre, ouvrir: ouvrirDepuisActivite, nomAffiche, changementDeChantier,
    statsHorsLigne: () => HorsLigne.stats(),
    toutRetirerHorsLigne: () => HorsLigne.toutRetirer(),
    _test: { HorsLigne, V, zoomer, genre, estAffichable },
  };
})();
window.FTSDocs = FTSDocs;
