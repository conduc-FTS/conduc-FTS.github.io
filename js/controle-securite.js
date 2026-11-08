/**
 * controle-securite.js — bloc « Contrôle de sécurité » en bas de l'écran
 * Accès Drive de la Supervision.
 *
 * Règle (Clément, 07/11/2026) : FTS ne partage JAMAIS le Drive avec
 * l'extérieur (client, MOE, BE…) ; toute nouvelle personne est d'abord
 * ajoutée dans Personnel FTS par conduc.fts. Donc tout partage hors
 * Personnel FTS est une anomalie.
 *
 * Le contrôle parcourt TOUS les fichiers et dossiers de l'arborescence FTS
 * (y compris ceux créés depuis une tablette, qui appartiennent au compte du
 * chef) et relève :
 *  - les partages « avec le lien » (toute personne ou tout un domaine) ;
 *  - les anciens salariés (PARTI dans Personnel FTS) encore présents ;
 *  - les personnes extérieures (adresse absente de Personnel FTS) ;
 *  - le personnel FTS sur un dossier qui lui est réservé (interne, archives).
 * « Tout corriger » retire ces accès (avec confirmation), puis refait le
 * contrôle. Le rapport s'imprime ou s'enregistre en PDF.
 *
 * Réservé au compte propriétaire du Drive (conduc.fts) : lui seul voit tous
 * les partages. Date et résultat du dernier contrôle gardés dans les
 * propriétés du dossier DOSSIER CHANTIER (rappel au bout de 3 mois).
 *
 * FTSControle.monter(conteneur) · nécessite drive.js, personnel.js, acces-drive.js
 */
const FTSControle = (() => {
  const DRIVE = "https://www.googleapis.com/drive/v3";
  const RAPPEL_JOURS = 90;
  const CHAMPS = "nextPageToken,files(id,name,mimeType,parents,webViewLink,owners(emailAddress,displayName,me),permissions(id,type,role,emailAddress,domain,displayName))";
  const DOSSIER = "application/vnd.google-apps.folder";

  let racine = null;
  let resultat = null;   // dernier contrôle fait dans cette session
  let corrections = null; // dernières corrections faites
  let enCours = false;
  let progression = "";
  let dernierResume = null; // { le: Date, res: "liens/anciens/ext/nonprevus/nb" } lu dans le Drive
  let idChantiers = null;

  const O = () => FTSAcces.outils;
  const esc = (s) => O().esc(s);
  const dateFr = (d) => d.toLocaleDateString("fr-FR") + " à " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const roleLib = (r) => (r === "writer" || r === "fileOrganizer" || r === "organizer" ? "MODIFICATION" : r === "commenter" ? "COMMENTAIRE" : "LECTURE");
  const badgeRole = (r) => `<span class="ad-r ${roleLib(r) === "MODIFICATION" ? "r-mod" : "r-lec"}">${roleLib(r)}</span>`;

  // ─── Résumé gardé dans le Drive (propriétés du dossier DOSSIER CHANTIER) ──
  async function lireResume() {
    try {
      idChantiers = idChantiers || (await FTSDrive.findFolderExact("DOSSIER CHANTIER", null));
      if (!idChantiers) return null;
      const r = await O().req(`${DRIVE}/files/${idChantiers}?fields=appProperties`);
      const p = r.ok ? (await r.json()).appProperties || {} : {};
      return p.ctrlLe ? { le: new Date(p.ctrlLe), res: String(p.ctrlRes || "") } : null;
    } catch (e) { return null; }
  }
  async function ecrireResume(res) {
    try {
      if (!idChantiers) return;
      const val = [res.liens.length, res.anciens.length, res.exterieurs.length, res.nonPrevus.length, res.nb].join("/");
      await O().req(`${DRIVE}/files/${idChantiers}?fields=id`, { method: "PATCH", body: JSON.stringify({ appProperties: { ctrlLe: res.le.toISOString(), ctrlRes: val } }) });
      dernierResume = { le: res.le, res: val };
    } catch (e) {}
  }

  // ─── Lecture de tout le Drive ───────────────────────────────────────
  async function toutLire() {
    const fichiers = [];
    let page = "";
    do {
      const q = encodeURIComponent("trashed = false");
      const r = await O().req(`${DRIVE}/files?q=${q}&fields=${encodeURIComponent(CHAMPS)}&pageSize=1000${page ? "&pageToken=" + encodeURIComponent(page) : ""}`);
      if (!r.ok) throw new Error(`lecture du Drive impossible (${r.status})`);
      const j = await r.json();
      fichiers.push(...(j.files || []));
      page = j.nextPageToken || "";
      progression = `${fichiers.length} fichiers et dossiers lus…`;
      rendre();
    } while (page);
    return fichiers;
  }

  /** Contrôle sans rien modifier. */
  async function controler() {
    const outils = O();
    await outils.chargerEncadrement().catch(() => null);
    if (!(await outils.personnelLu())) throw new Error("base Personnel FTS illisible : contrôle impossible");
    const d = await FTSAcces.droits();
    const moi = outils.mail(d.email);
    const personnes = FTSPersonnel.toutes();
    const base = new Map(personnes.filter((p) => p.email).map((p) => [outils.mail(p.email), p]));
    if (!base.size) throw new Error("base Personnel FTS vide : contrôle impossible");
    const enc = new Set(outils.listeEncadrement().map((e) => e.email));

    // Dossiers racine FTS
    const racines = new Map(); // id → définition
    for (const def of FTSAcces.DOSSIERS) {
      const id = await FTSDrive.findFolderExact(def.nom, null).catch(() => null);
      if (id) racines.set(id, def);
    }
    idChantiers = [...racines].find(([, v]) => v.nom === "DOSSIER CHANTIER")?.[0] || idChantiers;

    progression = "Lecture du Drive…"; rendre();
    const fichiers = await toutLire();
    const parId = new Map(fichiers.map((f) => [f.id, f]));

    // Position de chaque élément dans l'arborescence FTS
    const memo = new Map();
    function position(f) {
      if (memo.has(f.id)) return memo.get(f.id);
      let pos = null;
      if (racines.has(f.id)) pos = { racine: racines.get(f.id), chemin: [], niveau1: null };
      else {
        const parent = f.parents && parId.get(f.parents[0]);
        const pp = parent ? position(parent) : null;
        if (pp) pos = { racine: pp.racine, chemin: [...pp.chemin, f.name], niveau1: pp.niveau1 || f };
      }
      memo.set(f.id, pos);
      return pos;
    }
    const cleP = (p) => `${p.type}|${p.type === "domain" ? p.domain : p.type === "anyone" ? "" : outils.mail(p.emailAddress)}|${p.role}`;

    const res = { le: new Date(), nb: 0, liens: [], anciens: [], exterieurs: [], nonPrevus: [] };
    for (const f of fichiers) {
      const pos = position(f);
      if (!pos) continue; // hors de l'arborescence FTS (fichier partagé avec le compte, Mon Drive…)
      res.nb++;
      const parent = f.parents && parId.get(f.parents[0]);
      const clesParent = new Set(((parent && position(parent) && parent.permissions) || []).map(cleP));
      const proprio = (f.owners && f.owners[0]) || {};
      const proprioNom = proprio.me ? "conduc.fts" : (base.get(outils.mail(proprio.emailAddress)) ? `${base.get(outils.mail(proprio.emailAddress)).prenom} ${base.get(outils.mail(proprio.emailAddress)).nom}` : proprio.displayName || proprio.emailAddress || "?");
      const ou = [pos.racine.nom, ...pos.chemin.slice(0, -1)].join(" › ") || pos.racine.nom;
      const chantier = !pos.racine.interne && pos.niveau1 ? pos.niveau1.name : "";
      for (const p of f.permissions || []) {
        if (p.role === "owner") continue;
        if (clesParent.has(cleP(p))) continue; // hérité du dossier parent : relevé une seule fois, plus haut
        const item = {
          fileId: f.id, permId: p.id, nom: f.name || "(sans nom)", dossier: f.mimeType === DOSSIER, lien: f.webViewLink || "",
          ou: racines.has(f.id) ? "(dossier racine)" : ou, racine: pos.racine.nom, chantier, toutLeChantier: !!(pos.niveau1 && pos.niveau1.id === f.id && !pos.racine.interne),
          archive: pos.racine.nom === "ARCHIVES", role: p.role, proprietaire: proprioNom,
        };
        if (p.type === "anyone" || p.type === "domain") { res.liens.push({ ...item, qui: p.type === "anyone" ? "toute personne ayant le lien" : `tout le domaine ${p.domain}` }); continue; }
        const m = outils.mail(p.emailAddress);
        if (!m || m === moi || enc.has(m)) continue;
        const b = base.get(m);
        const qui = outils.aff(m) || p.displayName || "?";
        if (p.type === "group" || !b) { res.exterieurs.push({ ...item, qui }); continue; }
        if (b.statut !== "ACTIF") { res.anciens.push({ ...item, qui, nomPersonne: `${b.prenom} ${b.nom}`.trim(), statut: b.statut || "PARTI" }); continue; }
        // Personnel FTS actif, hors encadrement : prévu seulement sur DOSSIER
        // CHANTIER, et sur SON dossier dans ADMINISTRATIF
        const chef = b.poste === "CHEF DE CHANTIER";
        let prevu = pos.racine.nom === "DOSSIER CHANTIER";
        if (pos.racine.nom === "ADMINISTRATIF" && chef && pos.niveau1 && outils.cle(pos.niveau1.name) === outils.cle(`${b.prenom} ${b.nom}`)) prevu = true;
        if (!prevu) res.nonPrevus.push({ ...item, qui, nomPersonne: `${b.prenom} ${b.nom}`.trim() });
      }
    }
    return res;
  }

  /** Retire tous les accès relevés. */
  async function toutCorriger(res) {
    const tous = [...res.liens, ...res.anciens, ...res.exterieurs, ...res.nonPrevus];
    const faits = [], erreurs = [];
    let i = 0;
    for (const a of tous) {
      progression = `Correction ${++i} / ${tous.length}…`; rendre();
      try {
        const r = await O().req(`${DRIVE}/files/${a.fileId}/permissions/${a.permId}?supportsAllDrives=true`, { method: "DELETE" });
        // 404 : accès déjà parti avec celui du dossier parent
        if (r.ok || r.status === 204 || r.status === 404) faits.push(a); else erreurs.push({ ...a, statut: r.status });
      } catch (e) { erreurs.push({ ...a, statut: e.message }); }
    }
    return { le: new Date(), faits, erreurs };
  }

  // ─── Affichage ──────────────────────────────────────────────────────
  const total = (r) => r.liens.length + r.anciens.length + r.exterieurs.length + r.nonPrevus.length;
  function lignesExterieurs(liste) {
    // Une ligne par personne et par chantier (ou dossier racine)
    const groupes = new Map();
    liste.forEach((a) => {
      const k = a.qui + "|" + (a.chantier || a.racine);
      if (!groupes.has(k)) groupes.set(k, []);
      groupes.get(k).push(a);
    });
    return [...groupes.values()].map((g) => {
      const a = g[0];
      const surQuoi = g.some((x) => x.ou === "(dossier racine)") ? "tout le dossier" : g.some((x) => x.toutLeChantier) ? "tout le chantier" : g.length === 1 ? (a.dossier ? `dossier ${a.nom}` : a.nom) : `${g.length} éléments`;
      const role = g.some((x) => roleLib(x.role) === "MODIFICATION") ? "writer" : "reader";
      const proprios = [...new Set(g.map((x) => x.proprietaire))].join(", ");
      return { qui: a.qui, lieu: a.chantier || a.racine, archive: a.archive, surQuoi, role, proprios };
    });
  }
  function htmlDetail(res, pourRapport) {
    const vide = (t) => `<div class="ad-ok" style="margin:0 0 10px">✅ ${t}</div>`;
    const ouvrir = (a) => (!pourRapport && a.lien ? ` <a class="ad-btn" href="${esc(a.lien)}" target="_blank" rel="noopener">Ouvrir</a>` : "");
    let h = `<div class="cs-kp">
      <div class="${res.liens.length ? "red" : "gr"}"><b>${res.liens.length}</b>partagé(s) avec le lien</div>
      <div class="${res.anciens.length ? "red" : "gr"}"><b>${new Set(res.anciens.map((a) => a.qui)).size}</b>ancien(s) salarié(s) avec un accès</div>
      <div class="${res.exterieurs.length ? "red" : "gr"}"><b>${new Set(res.exterieurs.map((a) => a.qui)).size}</b>personne(s) extérieure(s)</div>
      <div class="${res.nonPrevus.length ? "red" : "gr"}"><b>${res.nonPrevus.length}</b>accès non prévu(s) au personnel</div></div>`;
    h += `<div class="cs-sec"><h3>🔗 Partagés « avec le lien » ${res.liens.length ? '<span class="ad-r r-red">À CORRIGER</span>' : ""}</h3>`;
    h += res.liens.length ? `<div class="ad-alert" style="margin-bottom:8px">N'importe quelle personne qui a le lien peut ouvrir ces éléments, sans compte et sans être invitée.</div>
      <table class="ad-t"><thead><tr><th>Élément</th><th>Où</th><th>Accès donné</th><th>Propriétaire</th><th></th></tr></thead><tbody>
      ${res.liens.map((a) => `<tr><td><b>${a.dossier ? "📁" : "📄"} ${esc(a.nom)}</b><div class="ad-sub">${esc(a.qui)}</div></td><td>${esc(a.ou)}</td><td>${badgeRole(a.role)}</td><td class="ad-sub">${esc(a.proprietaire)}</td><td style="text-align:right">${ouvrir(a)}</td></tr>`).join("")}</tbody></table>` : vide("Aucun élément partagé avec le lien.");
    h += `</div><div class="cs-sec"><h3>🚪 Anciens salariés ${res.anciens.length ? '<span class="ad-r r-red">À CORRIGER</span>' : ""}</h3>`;
    h += res.anciens.length ? `<table class="ad-t"><thead><tr><th>Personne</th><th>Statut</th><th>A encore accès à</th><th>Accès</th></tr></thead><tbody>
      ${res.anciens.map((a) => `<tr><td><b>${esc(a.nomPersonne)}</b><div class="ad-sub">${esc(a.qui)}</div></td><td><span class="ad-r r-non">${esc(a.statut)}</span></td><td>${esc(a.ou)} › <b>${esc(a.nom)}</b></td><td>${badgeRole(a.role)}</td></tr>`).join("")}</tbody></table>` : vide("Aucun ancien salarié n'a encore accès.");
    h += `</div><div class="cs-sec"><h3>👤 Personnes extérieures ${res.exterieurs.length ? '<span class="ad-r r-red">À CORRIGER</span>' : ""}</h3>`;
    h += res.exterieurs.length ? `<div class="ad-info" style="margin-bottom:8px">FTS ne partage pas le Drive avec l'extérieur : ces accès n'ont rien à faire là. Si une adresse est celle d'une personne de FTS, ajoute-la d'abord dans Personnel FTS : elle disparaîtra de cette liste.</div>
      <table class="ad-t"><thead><tr><th>Personne</th><th>Chantier / dossier</th><th>Sur quoi</th><th>Accès</th><th>Propriétaire</th></tr></thead><tbody>
      ${lignesExterieurs(res.exterieurs).map((g) => `<tr><td><b>${esc(g.qui)}</b></td><td>${esc(g.lieu)}${g.archive ? ' <span class="ad-r r-non">ARCHIVÉ</span>' : ""}</td><td>${esc(g.surQuoi)}</td><td>${badgeRole(g.role)}</td><td class="ad-sub">${esc(g.proprios)}</td></tr>`).join("")}</tbody></table>` : vide("Aucune personne extérieure n'a accès au Drive.");
    h += `</div><div class="cs-sec"><h3>🔒 Personnel FTS sur un dossier réservé ${res.nonPrevus.length ? '<span class="ad-r r-red">À CORRIGER</span>' : ""}</h3>`;
    h += res.nonPrevus.length ? `<table class="ad-t"><thead><tr><th>Personne</th><th>Où</th><th>Élément</th><th>Accès</th></tr></thead><tbody>
      ${res.nonPrevus.map((a) => `<tr><td><b>${esc(a.nomPersonne)}</b><div class="ad-sub">${esc(a.qui)}</div></td><td>${esc(a.ou)}</td><td>${esc(a.nom)}</td><td>${badgeRole(a.role)}</td></tr>`).join("")}</tbody></table>` : vide("Dossiers internes et archives réservés à l'encadrement (et chaque chef à son seul dossier administratif).");
    return h + "</div>";
  }

  function htmlCorrections(c) {
    if (!c) return "";
    let h = `<div class="ad-warn">🧹 <b>Corrigé le ${dateFr(c.le)}</b> : ${c.faits.length} accès retiré(s).`;
    if (c.faits.length) h += `<ul>${c.faits.slice(0, 40).map((a) => `<li>${esc(a.qui)} — ${esc(a.ou)} › ${esc(a.nom)}</li>`).join("")}${c.faits.length > 40 ? `<li>… et ${c.faits.length - 40} autre(s)</li>` : ""}</ul>`;
    h += "</div>";
    if (c.erreurs.length) h += `<div class="ad-alert">❌ ${c.erreurs.length} accès n'ont pas pu être retirés (souvent un fichier dont le compte n'est ni propriétaire ni éditeur) :<ul>${c.erreurs.map((a) => `<li>${esc(a.qui)} — ${esc(a.ou)} › ${esc(a.nom)} (${esc(a.statut)})</li>`).join("")}</ul>Retire-les à la main depuis le Drive, ou demande au propriétaire du fichier.</div>`;
    return h;
  }

  function rendre() {
    if (!racine || !racine._droits) return;
    const d = racine._droits;
    if (!d.proprio) {
      racine.innerHTML = `<div class="se-panel"><div class="ad-h"><h2>🛡️ Contrôle de sécurité</h2></div>
        <div class="ad-b ad-sub">Le contrôle se lance avec le compte propriétaire du Drive (conduc.fts) : c'est le seul qui voit tous les partages.</div></div>`;
      return;
    }
    const r = resultat;
    let sous = enCours ? `⏳ ${esc(progression)}` : r ? `contrôle du ${dateFr(r.le)} · ${r.nb} fichiers et dossiers vérifiés` : dernierResume ? `dernier contrôle le ${dateFr(dernierResume.le)}` : "jamais lancé";
    let corps = "";
    if (!r && !enCours) {
      const jours = dernierResume ? Math.floor((Date.now() - dernierResume.le) / 86400000) : null;
      if (jours === null) corps += `<div class="ad-warn">Aucun contrôle n'a encore été fait. Lance-le une première fois : il passe en revue tous les fichiers du Drive FTS (quelques dizaines de secondes).</div>`;
      else if (jours > RAPPEL_JOURS) corps += `<div class="ad-warn">⏰ Le dernier contrôle date de <b>${jours} jours</b>. Pense à le relancer (une fois par trimestre).</div>`;
      if (dernierResume) {
        const [l, a, e, n, nb] = dernierResume.res.split("/").map(Number);
        corps += `<div class="${l + a + e + n ? "ad-warn" : "ad-ok"}">${l + a + e + n ? "⚠️" : "✅"} Dernier résultat : ${l} lien(s) public(s), ${a} accès d'ancien salarié, ${e} accès extérieur(s), ${n} accès non prévu(s) — ${nb} éléments vérifiés.</div>`;
      }
    }
    corps += htmlCorrections(corrections);
    if (r) {
      corps += htmlDetail(r, false);
      corps += total(r) ? `<div style="display:flex;justify-content:flex-end;margin-top:4px"><button type="button" class="ad-btn dang" id="csCorriger">🧹 Tout corriger (${total(r)} accès)</button></div>`
        : `<div class="ad-ok" style="margin:0">✅ <b>Rien à corriger.</b> Aucun accès en dehors des règles FTS.</div>`;
    }
    racine.innerHTML = `<div class="se-panel">
      <div class="ad-h"><h2>🛡️ Contrôle de sécurité</h2><span class="s">${sous}</span><span class="ad-sp"></span>
        ${r ? '<button type="button" class="ad-btn" id="csRapport">⬇️ Rapport PDF</button>' : ""}
        <button type="button" class="ad-btn pri" id="csLancer" ${enCours ? "disabled" : ""}>🔍 Lancer le contrôle</button></div>
      <div class="ad-b">${corps}</div>
      <div class="ad-note">Le contrôle ne modifie rien : seul « Tout corriger » retire des accès, après confirmation. Les fichiers créés depuis une tablette appartiennent au compte du chef et sont vérifiés aussi.<br>La validation en deux étapes ne peut pas être vérifiée par l'appli sur des comptes Gmail : chaque personne la contrôle dans son compte Google (myaccount.google.com › Sécurité).</div>
    </div>`;
    const $ = (id) => racine.querySelector("#" + id);
    $("csLancer").onclick = () => lancer();
    if ($("csRapport")) $("csRapport").onclick = () => rapport();
    if ($("csCorriger")) $("csCorriger").onclick = async () => {
      if (!confirm(`Retirer ces ${total(resultat)} accès ?\nLes personnes concernées ne pourront plus ouvrir ces fichiers ou dossiers. Les liens publics seront coupés.`)) return;
      enCours = true; rendre();
      try {
        corrections = await toutCorriger(resultat);
        await new Promise((ok) => setTimeout(ok, 2000));
        resultat = await controler();
        await ecrireResume(resultat);
      } catch (e) { alert("Correction impossible : " + e.message); }
      enCours = false; rendre();
    };
  }

  async function lancer() {
    if (enCours) return;
    enCours = true; progression = "Préparation…"; corrections = null; rendre();
    try { resultat = await controler(); await ecrireResume(resultat); }
    catch (e) { console.error("Contrôle de sécurité :", e); alert("Contrôle impossible : " + e.message); }
    enCours = false; rendre();
  }

  /** Rapport imprimable (Enregistrer en PDF depuis la fenêtre d'impression). */
  function rapport() {
    const r = resultat;
    if (!r) return;
    const w = window.open("", "_blank");
    if (!w) { alert("La fenêtre du rapport a été bloquée : autorise les fenêtres pour ce site."); return; }
    const css = `body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:18mm 14mm;font-size:10pt}
      h1{font-size:17pt;margin:0 0 2mm}h3{font-size:11pt;margin:6mm 0 2mm}.sous{color:#555;margin-bottom:5mm}
      table{border-collapse:collapse;width:100%;font-size:9pt}th,td{border:0.3mm solid #999;padding:1.5mm 2mm;text-align:left;vertical-align:top}th{background:#eee}
      .ad-sub{color:#555;font-size:8.5pt}.ad-r{font-weight:bold;font-size:8pt}.ad-ok,.ad-warn,.ad-alert,.ad-info{border:0.3mm solid #bbb;padding:2mm 3mm;margin:2mm 0}
      .cs-kp{display:flex;gap:3mm}.cs-kp div{flex:1;border:0.3mm solid #999;padding:2mm;font-size:8.5pt}.cs-kp b{display:block;font-size:15pt}
      .pied{margin-top:8mm;font-size:8pt;color:#666;border-top:0.3mm solid #999;padding-top:2mm}@page{size:A4;margin:0}`;
    w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Contrôle de sécurité Drive FTS - ${r.le.toLocaleDateString("fr-FR")}</title><style>${css}</style></head><body>
      <h1>Contrôle de sécurité du Drive FTS</h1>
      <div class="sous">Contrôle du ${dateFr(r.le)} · ${r.nb} fichiers et dossiers vérifiés · compte ${esc(O().aff(racine._droits.email))}</div>
      ${corrections ? htmlCorrections(corrections) : ""}
      ${htmlDetail(r, true)}
      ${total(r) ? "" : "<p><b>Résultat : aucun accès en dehors des règles FTS.</b></p>"}
      <div class="pied">Règle FTS : le Drive n'est jamais partagé avec une personne extérieure ; seules les personnes inscrites dans Personnel FTS y ont accès, selon leur poste. Rapport généré par la Supervision FTS.</div>
      <script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>`);
    w.document.close();
  }

  async function monter(conteneur) {
    racine = conteneur;
    racine.innerHTML = "";
    const d = await FTSAcces.droits().catch(() => ({ ok: false }));
    if (!d.ok) return; // l'écran Accès Drive affiche déjà « Réservé à l'encadrement »
    racine._droits = d;
    if (d.proprio && !dernierResume) dernierResume = await lireResume();
    rendre();
  }

  return { monter, controler, toutCorriger };
})();
window.FTSControle = FTSControle;
