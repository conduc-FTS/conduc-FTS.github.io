/**
 * documents-bureau.js — écran « Documents » de la Supervision (encadrement).
 *
 * Onglets :
 *  - Rapports par chef : compteur par chef et par mois, lu dans le dossier
 *    RAPPORTS PAR CHEF / {chef} / {AAAA} / {MM - MOIS} (rangé par le robot de
 *    recopie, un rapport par jour et par chantier). À côté : les jours où le
 *    chef est pointé (onglet Personnel des Suivi, chantiers en cours ET
 *    archivés) et, parmi eux, les jours « en renfort » (pointé sur un rapport
 *    fait par un autre chef). Pas d'alerte : un rapport oublié ne laisse
 *    aucune trace (ni rapport, ni pointage), le site ne peut pas le voir.
 *  - Accueils intérimaires, Accueils sécurité, Fiches matériel : liste des
 *    PDF rangés par le robot, filtres chantier / mois / machine / texte.
 *
 * FTSDocsBureau.monter(conteneur, { obtenirDonnees }) — obtenirDonnees() de
 * la Supervision renvoie { chantiers, suivis } des chantiers en cours.
 * Nécessite drive.js, sheets.js, personnel.js.
 */
const FTSDocsBureau = (() => {
  const DRIVE = "https://www.googleapis.com/drive/v3";
  const MOIS_C = ["JAN", "FÉV", "MAR", "AVR", "MAI", "JUIN", "JUIL", "AOÛT", "SEPT", "OCT", "NOV", "DÉC"];
  const MOIS_L = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const JOURS = ["LUN", "MAR", "MER", "JEU", "VEN", "SAM", "DIM"];
  const CHEF_INCONNU = "_CHEF NON RECONNU";
  const TTL = 5 * 60 * 1000;
  const ONGLETS = [
    { id: "rapports", lib: "📋 Rapports par chef" },
    { id: "interimaires", lib: "🦺 Accueils intérimaires", racine: "ACCUEIL INTERIMAIRE" },
    { id: "securite", lib: "🛡️ Accueils sécurité", racine: "ACCUEIL SECURITE" },
    { id: "materiel", lib: "🔧 Fiches matériel", racine: "FICHE MATERIEL" },
  ];

  let racine = null, opts = {}, onglet = "rapports", annee = String(new Date().getFullYear()), selection = null;
  const cache = {}; // par onglet : { le, donnees }
  let contexte = null; // { le, codes: {code: nom}, presences: Map(cleChef → Map(dateISO → Set(code))) }
  const filtres = { chantier: "", mois: "", machine: "", texte: "" };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cle = (s) => (window.FTSPersonnel ? FTSPersonnel.cle(s) : String(s || "").toUpperCase().trim());
  const auth = () => ({ Authorization: "Bearer " + FTSAuth.getToken() });
  const dateNom = (n) => { const m = String(n || "").match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
  const codeDe = (n) => { const m = String(n || "").toUpperCase().match(/(\d{2})\s?FTS\s?(\d{3})/); return m ? `${m[1]}FTS${m[2]}` : ""; };
  const isoDeFR = (s) => { const m = String(s || "").replace(/^'/, "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; };
  const frDeIso = (d) => (d ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4) : "");
  const titre = (s) => String(s || "").toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

  async function req(url) {
    for (let essai = 0; essai < 4; essai++) {
      const r = await fetch(url, { headers: auth() });
      if (r.status !== 429 || essai === 3) return r;
      await new Promise((ok) => setTimeout(ok, 700 * Math.pow(2, essai)));
    }
  }
  /** Sous-dossiers de plusieurs dossiers (par paquets de 40, avec pagination). */
  async function dossiersDans(ids) {
    const tous = [];
    for (let i = 0; i < ids.length; i += 40) {
      const parents = ids.slice(i, i + 40).map((id) => `'${id}' in parents`).join(" or ");
      const q = encodeURIComponent(`(${parents}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
      let page = "";
      do {
        const r = await req(`${DRIVE}/files?q=${q}&fields=nextPageToken,files(id,name,parents)&pageSize=1000${page ? "&pageToken=" + page : ""}`);
        if (!r.ok) throw new Error(`Lecture des dossiers : ${r.status}`);
        const d = await r.json();
        tous.push(...(d.files || []));
        page = d.nextPageToken || "";
      } while (page);
    }
    return tous;
  }
  const racineDossier = (nom) => FTSDrive.findFolderExact(nom, null).catch(() => null);

  // ─── Contexte commun : noms des chantiers + présences (pointage) ──────
  async function chargerContexte(forcer) {
    if (!forcer && contexte && Date.now() - contexte.le < TTL) return contexte;
    const d = opts.obtenirDonnees ? await opts.obtenirDonnees(forcer) : { chantiers: [], suivis: [] };
    let archives = [], suivisArch = [];
    try {
      archives = await FTSDrive.listChantiersArchives();
      suivisArch = archives.length ? await FTSSheets.chargerDonneesSupervision(archives.map((a) => ({ id: a.id, name: a.name }))) : [];
    } catch (e) { console.warn("Documents : archives illisibles", e); }
    const chantiers = (d.chantiers || []).concat(archives.map((a) => ({ id: a.id, name: a.name })));
    const suivis = (d.suivis || []).concat(suivisArch);
    const codes = {}, presences = new Map();
    chantiers.forEach((c) => { const k = codeDe(c.name); if (k) codes[k] = c.name; });
    suivis.forEach((s, i) => {
      const c = chantiers.find((x) => x.id === (s && s.id)) || chantiers[i];
      const code = codeDe(c && c.name);
      ((s && s.personnel) || []).forEach((r) => {
        const iso = isoDeFR(r[0]), k = cle(r[1]);
        if (!iso || !k) return;
        if (!presences.has(k)) presences.set(k, new Map());
        const m = presences.get(k);
        if (!m.has(iso)) m.set(iso, new Set());
        if (code) m.get(iso).add(code);
      });
    });
    return (contexte = { le: Date.now(), codes, presences });
  }

  // ─── Rapports par chef ─────────────────────────────────────────────
  async function chargerRapports() {
    const root = await racineDossier("RAPPORTS PAR CHEF");
    if (!root) return { absent: true, rapports: [], chefsDossiers: [], annees: [] };
    const chefs = await FTSDrive.listSubfolders(root);
    const ans = chefs.length ? await dossiersDans(chefs.map((c) => c.id)) : [];
    const mois = ans.length ? await dossiersDans(ans.map((a) => a.id)) : [];
    const fichiers = mois.length ? await FTSDrive.listFilesInFolders(mois.map((m) => m.id)) : [];
    const parId = new Map([...chefs, ...ans, ...mois].map((f) => [f.id, f]));
    const rapports = [];
    fichiers.forEach((f) => {
      const m = parId.get((f.parents || [])[0]); const a = m && parId.get((m.parents || [])[0]); const c = a && parId.get((a.parents || [])[0]);
      const date = dateNom(f.name);
      if (!c || !date) return;
      rapports.push({ chef: c.name.trim(), cleChef: c.name.trim() === CHEF_INCONNU ? CHEF_INCONNU : cle(c.name), date, code: codeDe(f.name), lien: f.webViewLink, nom: f.name });
    });
    const annees = [...new Set(ans.map((a) => a.name.trim()).filter((n) => /^\d{4}$/.test(n)))];
    return { rapports, chefsDossiers: chefs.map((c) => c.name.trim()), annees };
  }

  function tableauChefs(d, ctx) {
    const personnes = window.FTSPersonnel ? FTSPersonnel.toutes() : [];
    const chefsBase = personnes.filter((p) => p.poste === "CHEF DE CHANTIER" && p.statut === "ACTIF");
    const lignes = new Map(); // cle → { nom, mois:[{rapports, dates:Set, presents:Set, renfort:Set}] }
    const ligne = (k, nom) => {
      if (!lignes.has(k)) lignes.set(k, { cle: k, nom, mois: Array.from({ length: 12 }, () => ({ rapports: [], dates: new Set(), presents: new Set(), renfort: new Set() })) });
      return lignes.get(k);
    };
    const nomDe = (k, defaut) => { const p = personnes.find((x) => cle(`${x.prenom} ${x.nom}`) === k); return p ? `${p.prenom} ${p.nom}` : defaut; };
    chefsBase.forEach((p) => ligne(cle(`${p.prenom} ${p.nom}`), `${p.prenom} ${p.nom}`));
    d.rapports.filter((r) => r.date.startsWith(annee)).forEach((r) => {
      const l = ligne(r.cleChef, r.cleChef === CHEF_INCONNU ? "Chef non reconnu" : nomDe(r.cleChef, r.chef));
      const mm = l.mois[Number(r.date.slice(5, 7)) - 1];
      mm.rapports.push(r); mm.dates.add(r.date);
    });
    lignes.forEach((l, k) => {
      const pres = ctx.presences.get(k);
      if (!pres) return;
      pres.forEach((codes, iso) => {
        if (!iso.startsWith(annee)) return;
        const mm = l.mois[Number(iso.slice(5, 7)) - 1];
        mm.presents.add(iso);
        if (!mm.dates.has(iso)) mm.renfort.add(iso);
      });
    });
    return [...lignes.values()].sort((a, b) => (a.cle === CHEF_INCONNU) - (b.cle === CHEF_INCONNU) || a.nom.localeCompare(b.nom, "fr"));
  }

  function rendreRapports(d, ctx) {
    if (d.absent) return '<div class="se-panel"><div class="dx-vide">Le dossier RAPPORTS PAR CHEF n\'existe pas encore : il est créé par le robot de recopie.</div></div>';
    const annees = [...new Set(d.annees.concat([String(new Date().getFullYear())]))].sort().reverse();
    const lignes = tableauChefs(d, ctx);
    const cellule = (l, i) => {
      const m = l.mois[i];
      const n = m.rapports.length, p = m.presents.size, rf = m.renfort.size;
      if (!n && !p) return '<td><span class="dx-c zero">—</span></td>';
      const on = selection && selection.cle === l.cle && selection.mois === i ? " sel" : "";
      return `<td><button type="button" class="dx-c${n ? "" : " vide"}${on}" data-chef="${esc(l.cle)}" data-mois="${i}">${n}</button><span class="dx-sub">${p ? `${p} j` : ""}${rf ? ` · ${rf} renf.` : ""}</span></td>`;
    };
    const total = (l) => {
      const n = l.mois.reduce((s, m) => s + m.rapports.length, 0), p = l.mois.reduce((s, m) => s + m.presents.size, 0), rf = l.mois.reduce((s, m) => s + m.renfort.size, 0);
      return `<td><b>${n}</b><span class="dx-sub">${p ? `${p} j` : ""}${rf ? ` · ${rf} renf.` : ""}</span></td>`;
    };
    let detail = "";
    const l = selection && lignes.find((x) => x.cle === selection.cle);
    if (l) {
      const i = selection.mois, m = l.mois[i];
      const prem = new Date(Number(annee), i, 1), nbJ = new Date(Number(annee), i + 1, 0).getDate();
      let cases = JOURS.map((j) => `<div class="dx-jh">${j}</div>`).join("") + "<div></div>".repeat((prem.getDay() + 6) % 7);
      for (let j = 1; j <= nbJ; j++) {
        const iso = `${annee}-${String(i + 1).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
        const we = [0, 6].includes(new Date(Number(annee), i, j).getDay());
        const rs = m.rapports.filter((r) => r.date === iso);
        const pres = (ctx.presences.get(l.cle) || new Map()).get(iso);
        if (rs.length) cases += `<div class="dx-j r"><b>${j}</b>${rs.map((r) => `<a href="${esc(r.lien)}" target="_blank" rel="noopener" title="${esc(r.nom)}">📄 ${esc(r.code || "rapport")}</a>`).join("")}</div>`;
        else if (pres) cases += `<div class="dx-j f"><b>${j}</b>renfort${pres.size ? " · " + esc([...pres].join(", ")) : ""}</div>`;
        else cases += `<div class="dx-j${we ? " we" : ""}"><b>${j}</b></div>`;
      }
      detail = `<div class="dx-det"><div class="dx-det-h"><h3>${esc(titre(l.nom))} — ${MOIS_L[i]} ${annee}</h3><span class="dx-sub">${m.rapports.length} rapport(s) · ${m.presents.size} jour(s) pointé(s) · ${m.renfort.size} jour(s) en renfort</span><span class="ad-sp"></span><button type="button" class="ad-btn" id="dxFermer">✕</button></div>
        <div class="dx-leg"><span class="dx-j r">rapport (clic = PDF)</span><span class="dx-j f">pointé sur le rapport d'un autre chef</span></div>
        <div class="dx-jours">${cases}</div></div>`;
    }
    return `<div class="se-panel">
      <div class="dx-bar"><b>Année</b><select id="dxAnnee">${annees.map((a) => `<option ${a === annee ? "selected" : ""}>${a}</option>`).join("")}</select>
        <span class="dx-sub dx-src">Chiffre = rapports faits · dessous : jours pointés · jours en renfort (pointé sur le rapport d'un autre chef)</span><span class="ad-sp"></span>
        <button type="button" class="ad-btn" id="dxExport">⬇️ Export Excel</button></div>
      ${lignes.length ? `<div style="overflow:auto"><table class="dx-t"><thead><tr><th>Chef</th>${MOIS_C.map((m) => `<th>${m}</th>`).join("")}<th>Total</th></tr></thead><tbody>
        ${lignes.map((l) => `<tr${l.cle === CHEF_INCONNU ? ' class="dx-inc"' : ""}><td><b>${l.cle === CHEF_INCONNU ? "⚠️ Chef non reconnu" : esc(titre(l.nom))}</b></td>${MOIS_C.map((_, i) => cellule(l, i)).join("")}${total(l)}</tr>`).join("")}
      </tbody></table></div>` : '<div class="dx-vide">Aucun rapport pour cette année.</div>'}
      ${detail}
      <div class="ad-note">Source : dossier RAPPORTS PAR CHEF (un rapport par jour et par chantier ; un rapport corrigé remplace l'ancien). Un rapport oublié ne laisse aucune trace : le site ne peut pas le repérer sans planning.</div>
    </div>`;
  }

  function exporterRapports(d, ctx) {
    const lignes = tableauChefs(d, ctx);
    const out = [["Chef", "Mois", "Rapports", "Jours pointés", "Jours en renfort"]];
    lignes.forEach((l) => l.mois.forEach((m, i) => { if (m.rapports.length || m.presents.size) out.push([l.cle === CHEF_INCONNU ? "Chef non reconnu" : titre(l.nom), `${MOIS_L[i]} ${annee}`, m.rapports.length, m.presents.size, m.renfort.size]); }));
    const csv = out.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a"); a.href = url; a.download = `Rapports par chef ${annee}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ─── Listes de documents ───────────────────────────────────────────
  async function chargerListe(o) {
    const root = await racineDossier(o.racine);
    if (!root) return { absent: true, items: [] };
    const sous = await dossiersDans([root]);
    const fichiers = await FTSDrive.listFilesInFolders([root].concat(sous.map((s) => s.id)));
    const dossierDe = new Map(sous.map((s) => [s.id, s.name]));
    const items = fichiers.filter((f) => /pdf/i.test(f.mimeType || "") || /\.pdf$/i.test(f.name)).map((f) => {
      const n = f.name.replace(/\.pdf$/i, "");
      const date = dateNom(n) || String(f.modifiedTime || f.createdTime || "").slice(0, 10);
      const it = { id: f.id, nom: f.name, lien: f.webViewLink, date, code: codeDe(n), dossier: dossierDe.get((f.parents || [])[0]) || "" };
      if (o.id === "interimaires") { const m = n.match(/ACCUEIL_INTERIMAIRE_(.+)$/i); it.personne = m ? m[1].replace(/[-_]+/g, " ").trim() : n; }
      if (o.id === "materiel") { const m = n.match(/FICHE MATERIEL_([^_]+)_/i); it.chef = m ? m[1].trim() : ""; it.machine = it.dossier; }
      return it;
    });
    items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return { items };
  }

  function rendreListe(o, d, ctx) {
    if (d.absent) return `<div class="se-panel"><div class="dx-vide">Le dossier ${esc(o.racine)} n'existe pas encore : il est créé par le robot de recopie.</div></div>`;
    const t = filtres.texte.trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const garde = d.items.filter((it) =>
      (!filtres.chantier || it.code === filtres.chantier) && (!filtres.mois || (it.date || "").startsWith(filtres.mois)) &&
      (o.id !== "materiel" || !filtres.machine || it.machine === filtres.machine) &&
      (!t || `${it.nom} ${it.personne || ""} ${it.chef || ""} ${ctx.codes[it.code] || ""}`.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(t)));
    const codes = [...new Set(d.items.map((it) => it.code).filter(Boolean))].sort();
    const mois = [...new Set(d.items.map((it) => (it.date || "").slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))].sort().reverse();
    const machines = o.id === "materiel" ? [...new Set(d.items.map((it) => it.machine).filter(Boolean))].sort() : [];
    const nomCh = (c) => (c ? esc(ctx.codes[c] || c) : '<span class="dx-sub">—</span>');
    const entete = { interimaires: ["Date", "Personne", "Chantier", ""], securite: ["Mis à jour", "Chantier", "Fichier", ""], materiel: ["Date", "Machine", "Chantier", "Chef", ""] }[o.id];
    const ligne = (it) => {
      const ouvrir = `<td style="text-align:right"><a class="ad-btn" href="${esc(it.lien)}" target="_blank" rel="noopener">📄 Ouvrir</a></td>`;
      if (o.id === "interimaires") return `<tr><td>${frDeIso(it.date)}</td><td><b>${esc(it.personne)}</b></td><td>${nomCh(it.code)}</td>${ouvrir}</tr>`;
      if (o.id === "securite") return `<tr><td>${frDeIso(it.date)}</td><td><b>${nomCh(it.code)}</b></td><td class="dx-sub">${esc(it.nom)}</td>${ouvrir}</tr>`;
      return `<tr><td>${frDeIso(it.date)}</td><td><b>${esc(it.machine)}</b></td><td>${nomCh(it.code)}</td><td>${esc(titre(it.chef))}</td>${ouvrir}</tr>`;
    };
    const MAX = 300;
    return `<div class="se-panel">
      <div class="dx-bar">
        <select id="dxCh"><option value="">Tous les chantiers</option>${codes.map((c) => `<option value="${esc(c)}" ${c === filtres.chantier ? "selected" : ""}>${esc(ctx.codes[c] || c)}</option>`).join("")}</select>
        <select id="dxMois"><option value="">Tous les mois</option>${mois.map((m) => `<option value="${m}" ${m === filtres.mois ? "selected" : ""}>${MOIS_L[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}</option>`).join("")}</select>
        ${o.id === "materiel" ? `<select id="dxMach"><option value="">Toutes les machines</option>${machines.map((m) => `<option ${m === filtres.machine ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>` : ""}
        <input id="dxTxt" placeholder="🔍 Nom, chantier…" value="${esc(filtres.texte)}">
        <span class="ad-sp"></span><span class="dx-sub">${garde.length} document(s)</span>
      </div>
      ${garde.length ? `<div style="overflow:auto"><table class="dx-list"><thead><tr>${entete.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${garde.slice(0, MAX).map(ligne).join("")}</tbody></table></div>
        ${garde.length > MAX ? `<div class="dx-vide">${garde.length - MAX} document(s) de plus : affine avec les filtres.</div>` : ""}` : '<div class="dx-vide">Aucun document.</div>'}
    </div>`;
  }

  // ─── Écran ─────────────────────────────────────────────────────────
  const CSS = `
.dx-tabs{display:flex;gap:6px;margin:0 0 14px;flex-wrap:wrap}.dx-tab{padding:9px 14px;border-radius:9px;border:1px solid var(--border);background:#fff;font-weight:700;font-size:.85rem;color:#444;cursor:pointer;font-family:inherit}.dx-tab.on{background:#222;color:#fff;border-color:#222}
.dx-bar{display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap}.dx-bar select,.dx-bar input{padding:8px 10px;border:1px solid var(--border);border-radius:8px;font:inherit;font-size:.85rem;background:#fff}.dx-bar input{width:220px;text-transform:none}
.dx-src{max-width:560px}
.dx-t{width:100%;border-collapse:collapse;font-size:.85rem}.dx-t th{font-size:.68rem;color:var(--text-sub);text-transform:uppercase;padding:8px 6px;text-align:center;border-bottom:1px solid var(--border)}.dx-t th:first-child,.dx-t td:first-child{text-align:left;padding-left:16px;white-space:nowrap}
.dx-t td{padding:8px 4px;text-align:center;border-bottom:1px solid #EEF0F3}.dx-t tr.dx-inc td{background:#FFF8E1}
.dx-c{display:inline-block;min-width:32px;padding:4px 6px;border-radius:6px;font-weight:800;font-size:.9rem;border:0;background:#E6F4EA;color:#1E8E4E;cursor:pointer;font-family:inherit}.dx-c.vide{background:#F1F2F4;color:#888}.dx-c.zero{background:none;color:#ccc;cursor:default}.dx-c.sel{outline:2px solid #2457C5}
.dx-sub{font-size:.7rem;color:var(--text-sub);display:block;font-weight:600;white-space:nowrap}.dx-bar .dx-sub{display:inline;white-space:normal}
.dx-det{padding:14px 16px;background:#FAFBFC;border-top:1px solid var(--border)}.dx-det-h{display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap}.dx-det h3{margin:0;font-size:.95rem}.dx-det-h .dx-sub{display:inline}
.dx-leg{display:flex;gap:8px;margin:0 0 10px;font-size:.72rem}.dx-leg .dx-j{min-height:0;padding:3px 8px}
.dx-jours{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;max-width:760px}.dx-jh{font-size:.68rem;color:#888;font-weight:700;text-align:center}
.dx-j{border:1px solid var(--border);border-radius:8px;padding:5px 6px;font-size:.72rem;background:#fff;min-height:46px;overflow:hidden}.dx-j b{display:block}.dx-j a{display:block;color:#1E5E36;font-weight:700;text-decoration:none;white-space:nowrap}.dx-j a:hover{text-decoration:underline}
.dx-j.r{border-color:#1E8E4E;background:#F1FAF3}.dx-j.f{border-color:#2457C5;background:#EEF3FD;color:#2457C5}.dx-j.we{background:#F1F2F4;color:#aaa}
.dx-list{width:100%;border-collapse:collapse;font-size:.85rem}.dx-list td,.dx-list th{padding:9px 14px;border-bottom:1px solid #EEF0F3;text-align:left}.dx-list th{font-size:.68rem;color:var(--text-sub);text-transform:uppercase}.dx-list a.ad-btn{text-decoration:none;color:inherit;display:inline-block}
.dx-vide{padding:16px 20px;color:var(--text-sub)}`;
  function css() { if (document.getElementById("dxCss")) return; const s = document.createElement("style"); s.id = "dxCss"; s.textContent = CSS; document.head.appendChild(s); }

  async function donneesOnglet(forcer) {
    const o = ONGLETS.find((x) => x.id === onglet);
    const c = cache[o.id];
    if (!forcer && c && Date.now() - c.le < TTL) return c.donnees;
    const donnees = o.id === "rapports" ? await chargerRapports() : await chargerListe(o);
    cache[o.id] = { le: Date.now(), donnees };
    return donnees;
  }

  let jeton = 0;
  async function rendre(forcer = false) {
    if (!racine) return;
    css();
    const o = ONGLETS.find((x) => x.id === onglet);
    const tabs = `<div class="dx-tabs">${ONGLETS.map((x) => `<button type="button" class="dx-tab ${x.id === onglet ? "on" : ""}" data-onglet="${x.id}">${x.lib}</button>`).join("")}<span class="ad-sp" style="flex:1"></span><button type="button" class="ad-btn" id="dxMaj">🔄 Actualiser</button></div>`;
    const moi = ++jeton;
    const enCache = cache[o.id] && contexte && !forcer && Date.now() - cache[o.id].le < TTL;
    if (!enCache) { racine.innerHTML = tabs + '<div class="se-panel"><div class="dx-vide">Chargement des documents…</div></div>'; brancher(null, null); }
    let d, ctx;
    try { [d, ctx] = await Promise.all([donneesOnglet(forcer), chargerContexte(forcer)]); }
    catch (e) { if (moi === jeton) { racine.innerHTML = tabs + `<div class="se-panel"><div class="dx-vide">❌ ${esc(e.message)}</div></div>`; brancher(null, null); } return; }
    if (moi !== jeton) return;
    racine.innerHTML = tabs + (o.id === "rapports" ? rendreRapports(d, ctx) : rendreListe(o, d, ctx));
    brancher(d, ctx);
  }

  function brancher(d, ctx) {
    const $ = (id) => racine.querySelector("#" + id);
    racine.querySelectorAll("[data-onglet]").forEach((b) => (b.onclick = () => { onglet = b.dataset.onglet; selection = null; Object.assign(filtres, { chantier: "", mois: "", machine: "", texte: "" }); rendre(); }));
    if ($("dxMaj")) $("dxMaj").onclick = () => rendre(true);
    if (!d) return;
    if ($("dxAnnee")) $("dxAnnee").onchange = (e) => { annee = e.target.value; selection = null; rendre(); };
    if ($("dxExport")) $("dxExport").onclick = () => exporterRapports(d, ctx);
    if ($("dxFermer")) $("dxFermer").onclick = () => { selection = null; rendre(); };
    racine.querySelectorAll("button.dx-c[data-chef]").forEach((b) => (b.onclick = () => {
      const s = { cle: b.dataset.chef, mois: Number(b.dataset.mois) };
      selection = selection && selection.cle === s.cle && selection.mois === s.mois ? null : s;
      rendre();
    }));
    const f = (id, k) => { const el = $(id); if (el) el.onchange = () => { filtres[k] = el.value; rendre(); }; };
    f("dxCh", "chantier"); f("dxMois", "mois"); f("dxMach", "machine");
    const t = $("dxTxt");
    if (t) {
      let minuterie = null;
      t.oninput = () => { clearTimeout(minuterie); minuterie = setTimeout(() => { filtres.texte = t.value; const pos = t.selectionStart; rendre().then(() => { const n = $("dxTxt"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} } }); }, 250); };
    }
  }

  async function monter(conteneur, options = {}) {
    racine = conteneur;
    opts = options;
    // Ouverture directe sur #se-view-documents : on attend la connexion Google (30 s max)
    if (!(window.FTSAuth && FTSAuth.isSignedIn())) {
      racine.innerHTML = '<div class="se-panel"><div class="dx-vide">Connexion Google en attente…</div></div>';
      for (let i = 0; i < 60 && !(window.FTSAuth && FTSAuth.isSignedIn()); i++) await new Promise((ok) => setTimeout(ok, 500));
      if (!FTSAuth.isSignedIn()) { racine.innerHTML = '<div class="se-panel"><div class="dx-vide">Connecte-toi (bouton en bas à gauche), puis reviens sur « Documents ».</div></div>'; return; }
    }
    if (window.FTSPersonnel) await FTSPersonnel.charger({ rapide: true }).catch(() => {});
    return rendre();
  }

  return { monter };
})();
window.FTSDocsBureau = FTSDocsBureau;
