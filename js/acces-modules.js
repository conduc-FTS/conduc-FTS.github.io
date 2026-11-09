/**
 * acces-modules.js — onglet « Modules de la Supervision » de l'écran Accès :
 * qui voit quels modules. Réservé au compte propriétaire du Drive (conduc.fts).
 *
 * - Personnes : l'encadrement ACTIF de Personnel FTS avec e-mail, rangé par poste.
 * - Chaque poste a ses modules par défaut (bouton « Défauts par poste… ») ;
 *   on coche / décoche ensuite personne par personne (contour jaune = exception).
 * - Enregistrement dans le classeur « Accès Supervision FTS » (voir js/modules.js),
 *   partagé en LECTURE SEULE à l'encadrement, retiré aux autres.
 * - Masquer un module ne protège pas les données : c'est le partage du Drive
 *   (onglet Dossiers Drive) qui les protège.
 *
 * FTSAccesModules.monter(conteneur) · nécessite modules.js, personnel.js, acces-drive.js
 */
const FTSAccesModules = (() => {
  const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
  const DRIVE = "https://www.googleapis.com/drive/v3";
  // Exception décidée par Clément le 07/11/2026 : la directrice travaux ouvre aussi des chantiers
  const EXCEPTIONS_DEPART = { "m.buchon@fts-btp.fr": { ouverture: true } };

  let racine = null;
  let reg = null;        // { id, postes: {POSTE: [ids]}, exceptions: {email: {id: bool}} }
  let gens = [];         // [{ nom, poste, email }]
  let sale = false;
  let statut = "";
  let voir = "";
  let enCours = false;

  const M = () => FTSModules;
  const esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  const req = (url, o = {}) => fetch(url, { ...o, headers: { Authorization: "Bearer " + FTSAuth.getToken(), ...(o.body ? { "Content-Type": "application/json" } : {}) } });
  const posteDe = (p) => (p.categorie === "ENCADREMENT" ? p.poste : p.fonctionEnc) || "";
  const postesListe = () => {
    const l = (window.FTSPersonnel && FTSPersonnel.POSTES_ENCADREMENT) || Object.keys(M().DEFAUTS);
    return [...new Set([...l, ...gens.map((g) => g.poste)].filter(Boolean))];
  };
  const defautPoste = (p) => (reg.postes[p] ? reg.postes[p] : (M().DEFAUTS[p] || M().DEFAUT_INCONNU)).slice();
  const modulesDe = (g) => M().modulesPour(g.poste, g.email, reg);

  function lireGens() {
    gens = FTSPersonnel.toutes().filter((p) => p.statut === "ACTIF" && p.email && (p.categorie === "ENCADREMENT" || p.fonctionEnc))
      .map((p) => ({ nom: `${p.prenom} ${p.nom}`.trim(), poste: posteDe(p), email: p.email }));
    const ordre = postesListe();
    gens.sort((a, b) => ordre.indexOf(a.poste) - ordre.indexOf(b.poste) || a.nom.localeCompare(b.nom));
  }
  async function charger() {
    await FTSPersonnel.charger({ rapide: false }).catch(() => null);
    lireGens();
    const lu = await M().lireReglages();
    reg = lu || { id: null, postes: {}, exceptions: {} };
    if (!lu) {
      // Premier réglage : défauts du code + exceptions déjà décidées
      postesListe().forEach((p) => { reg.postes[p] = defautPoste(p); });
      Object.entries(EXCEPTIONS_DEPART).forEach(([e, x]) => { reg.exceptions[M().mail(e)] = { ...x }; });
      sale = true;
      statut = "Réglages pas encore enregistrés : ce sont les défauts proposés. Vérifie puis clique sur Enregistrer.";
    }
  }

  function basculer(g, id) {
    const e = M().mail(g.email);
    const ex = (reg.exceptions[e] = reg.exceptions[e] || {});
    const actuel = modulesDe(g).includes(id);
    const parDefaut = defautPoste(g.poste).includes(id);
    if (!actuel === parDefaut) delete ex[id]; else ex[id] = !actuel;
    if (!Object.keys(ex).length) delete reg.exceptions[e];
    sale = true;
  }

  function rendre() {
    if (!racine) return;
    const MODS = M().MODULES;
    let corps = "", dernier = null;
    gens.forEach((g, i) => {
      if (g.poste !== dernier) { corps += `<tr class="am-gh"><td colspan="${MODS.length + 1}">${esc(g.poste || "POSTE NON RENSEIGNÉ")} · défaut du poste</td></tr>`; dernier = g.poste; }
      const mods = modulesDe(g), def = defautPoste(g.poste);
      corps += `<tr><td class="am-l"><b>${esc(g.nom)}</b><small>${esc(g.email)}</small></td>${MODS.map((m) => {
        const on = mods.includes(m.id), dif = on !== def.includes(m.id);
        return `<td><button type="button" class="am-c ${on ? "on" : ""} ${dif ? "dif" : ""}" data-i="${i}" data-m="${m.id}" title="${esc(m.lib)}${dif ? " (exception)" : ""}" aria-pressed="${on}"></button></td>`;
      }).join("")}</tr>`;
    });
    const tete = MODS.map((m) => `<th>${esc(m.lib)}</th>`).join("");
    const gv = voir === "" ? null : gens[Number(voir)];
    const apercu = gv ? `<b>${esc(gv.nom)}</b> voit : ${modulesDe(gv).map((id) => esc(MODS.find((m) => m.id === id).lib)).join(" · ") || "aucun module (seulement le message « Page non autorisée »)"}` : "Choisis une personne pour voir son menu.";
    racine.innerHTML = `
      <div class="ad-info" style="margin-bottom:12px">🔒 Masquer un module simplifie le menu de chacun, mais <b>ne protège pas les données</b> : une personne qui a accès à un dossier dans le Drive peut toujours l'ouvrir. La vraie protection, c'est l'onglet <b>Dossiers Drive</b>.</div>
      <div class="se-panel">
        <div class="ad-h"><h2>Qui voit quels modules</h2><span class="s">encadrement actif de Personnel FTS, avec e-mail</span><span class="ad-sp"></span>
          <button type="button" class="ad-btn" id="amDefauts">Défauts par poste…</button>
          <button type="button" class="ad-btn pri" id="amEnregistrer" ${enCours ? "disabled" : ""}>${enCours ? "Enregistrement…" : sale ? "💾 Enregistrer *" : "💾 Enregistrer"}</button></div>
        <div class="ad-b">
          ${gens.length ? `<div style="overflow:auto"><table class="ad-t am-t"><thead><tr><th class="am-l">Personne</th>${tete}</tr></thead><tbody>${corps}</tbody></table></div>`
            : '<div class="ad-vide">Personne de l\'encadrement avec e-mail dans Personnel FTS pour l\'instant.</div>'}
          <div class="am-leg"><span><i class="am-c on"></i> accès</span><span><i class="am-c dif"></i> exception (différent du poste)</span><span>« Accès » : toujours réservé à conduc.fts</span></div>
          <div class="am-voir">👁️ Aperçu du menu de <select id="amVoir"><option value="">— choisir —</option>${gens.map((g, i) => `<option value="${i}" ${String(i) === voir ? "selected" : ""}>${esc(g.nom)}</option>`).join("")}</select><span>${apercu}</span></div>
          <div class="ad-st" id="amStatut">${esc(statut)}</div>
        </div>
        <div class="ad-note">Un nouvel encadrant reçoit les modules de son poste dès qu'il est ajouté dans Personnel FTS (catégorie ENCADREMENT, avec son adresse pro). Il voit son menu à sa prochaine ouverture de la Supervision. Le personnel chantier n'a pas accès à la Supervision.</div>
      </div>`;
    const $ = (id) => racine.querySelector("#" + id);
    racine.querySelectorAll(".am-t .am-c").forEach((b) => (b.onclick = () => { basculer(gens[Number(b.dataset.i)], b.dataset.m); statut = ""; rendre(); }));
    $("amVoir").onchange = () => { voir = $("amVoir").value; rendre(); };
    $("amDefauts").onclick = fenetreDefauts;
    $("amEnregistrer").onclick = enregistrer;
  }

  function fenetreDefauts() {
    const MODS = M().MODULES;
    const ov = document.createElement("div");
    ov.className = "am-ov";
    const dessiner = () => {
      ov.innerHTML = `<div class="am-md" role="dialog" aria-modal="true"><h3>Modules par défaut de chaque poste</h3>
        <p>Une personne reçoit les modules de son poste ; ses exceptions restent en plus. Pense à enregistrer ensuite.</p>
        <div style="overflow:auto"><table class="ad-t am-t"><thead><tr><th class="am-l">Poste</th>${MODS.map((m) => `<th>${esc(m.lib)}</th>`).join("")}</tr></thead><tbody>
        ${postesListe().map((p) => `<tr><td class="am-l"><b>${esc(p)}</b><small>${gens.filter((g) => g.poste === p).length} personne(s)</small></td>${MODS.map((m) => `<td><button type="button" class="am-c ${defautPoste(p).includes(m.id) ? "on" : ""}" data-p="${esc(p)}" data-m="${m.id}" title="${esc(m.lib)}"></button></td>`).join("")}</tr>`).join("")}
        </tbody></table></div><div style="display:flex;justify-content:flex-end;margin-top:14px"><button type="button" class="ad-btn pri" data-x>Fermer</button></div></div>`;
      ov.querySelectorAll(".am-c[data-p]").forEach((b) => (b.onclick = () => {
        const p = b.dataset.p, l = defautPoste(p), id = b.dataset.m;
        reg.postes[p] = l.includes(id) ? l.filter((x) => x !== id) : [...l, id];
        sale = true; dessiner();
      }));
      ov.querySelector("[data-x]").onclick = fermer;
    };
    const fermer = () => { ov.remove(); rendre(); };
    ov.addEventListener("click", (e) => { if (e.target === ov) fermer(); });
    document.body.appendChild(ov);
    dessiner();
  }

  // ─── Enregistrement + partage en lecture seule ─────────────────────
  async function creerClasseur() {
    const r = await req(SHEETS, { method: "POST", body: JSON.stringify({ properties: { title: M().NOM_REGLAGES }, sheets: [{ properties: { title: "Postes" } }, { properties: { title: "Exceptions" } }] }) });
    if (!r.ok) throw new Error(`Création du classeur des accès : ${r.status}`);
    const id = (await r.json()).spreadsheetId;
    await req(`${DRIVE}/files/${id}?fields=id`, { method: "PATCH", body: JSON.stringify({ appProperties: { ftsRole: "accesSupervision" }, description: "Réglages des modules de la Supervision FTS. Modifiés uniquement depuis l'écran Accès (compte conduc.fts). Ne pas déplacer dans les dossiers FTS." }) });
    return id;
  }
  async function ecrire(id) {
    const MODS = M().MODULES;
    const val = (on) => (on ? "oui" : "");
    const postes = [["Poste", ...MODS.map((m) => m.lib)], ...postesListe().map((p) => [p, ...MODS.map((m) => val(defautPoste(p).includes(m.id)))])];
    const noms = new Map(gens.map((g) => [M().mail(g.email), g.nom]));
    const exc = [["E-mail", "Nom", ...MODS.map((m) => m.lib)], ...Object.entries(reg.exceptions).map(([e, x]) => [e, noms.get(e) || "", ...MODS.map((m) => (m.id in x ? (x[m.id] ? "oui" : "non") : ""))])];
    let r = await req(`${SHEETS}/${id}/values:batchClear`, { method: "POST", body: JSON.stringify({ ranges: ["Postes!A:Z", "Exceptions!A:Z"] }) });
    if (!r.ok) throw new Error(`Écriture des réglages : ${r.status}`);
    r = await req(`${SHEETS}/${id}/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data: [{ range: "Postes!A1", values: postes }, { range: "Exceptions!A1", values: exc }] }) });
    if (!r.ok) throw new Error(`Écriture des réglages : ${r.status}`);
  }
  async function partager(id) {
    const r = await req(`${DRIVE}/files/${id}/permissions?fields=permissions(id,type,role,emailAddress)`);
    const perms = r.ok ? (await r.json()).permissions || [] : [];
    const voulus = new Set(gens.map((g) => M().mail(g.email)));
    const sansCompte = [];
    for (const g of gens) {
      if (perms.some((p) => p.type === "user" && M().mail(p.emailAddress) === M().mail(g.email))) continue;
      const a = await req(`${DRIVE}/files/${id}/permissions?sendNotificationEmail=false`, { method: "POST", body: JSON.stringify({ role: "reader", type: "user", emailAddress: g.email }) });
      if (!a.ok) sansCompte.push(g.email);
    }
    // Personne d'autre : ni ancien encadrant, ni lien public
    for (const p of perms) {
      if (p.role === "owner") continue;
      if (p.type === "user" && voulus.has(M().mail(p.emailAddress)) && p.role === "reader") continue;
      if (p.type === "user" && voulus.has(M().mail(p.emailAddress))) {
        await req(`${DRIVE}/files/${id}/permissions/${p.id}`, { method: "PATCH", body: JSON.stringify({ role: "reader" }) }).catch(() => {});
        continue;
      }
      await req(`${DRIVE}/files/${id}/permissions/${p.id}`, { method: "DELETE" }).catch(() => {});
    }
    return sansCompte;
  }
  async function enregistrer() {
    if (enCours) return;
    enCours = true; statut = ""; rendre();
    try {
      const id = reg.id || (await creerClasseur());
      reg.id = id;
      await ecrire(id);
      const sansCompte = await partager(id);
      try { localStorage.setItem("fts_modules_reglages_v1", JSON.stringify(reg)); } catch (e) {}
      sale = false;
      statut = `✅ Accès enregistrés : chacun verra son menu à sa prochaine ouverture de la Supervision.${sansCompte.length ? ` ⚠️ Pas encore de compte Google pour : ${sansCompte.join(", ")} (le menu de son poste s'appliquera quand le compte existera).` : ""}`;
    } catch (e) { console.error(e); statut = "❌ " + e.message + " — rien n'a été perdu, réessaie."; }
    enCours = false; rendre();
  }

  async function monter(conteneur) {
    racine = conteneur;
    racine.innerHTML = '<div class="ad-vide">Chargement des accès…</div>';
    const d = await FTSAcces.droits().catch(() => ({ ok: false }));
    if (!d.proprio) {
      racine.innerHTML = `<div class="se-panel ad-verrou"><div class="ad-verrou-ic">🔒</div><h2>Réservé au compte conduc.fts</h2><p>Les accès aux modules se règlent uniquement avec le compte propriétaire du Drive.</p></div>`;
      return;
    }
    try { await charger(); } catch (e) { racine.innerHTML = `<div class="ad-alert">❌ Lecture impossible : ${esc(e.message)}</div>`; return; }
    rendre();
  }

  /**
   * Partage du classeur des accès tenu à jour avec Personnel FTS (nouvel
   * encadrant, départ) : appelé à chaque ouverture de l'écran Accès par conduc.fts.
   */
  async function synchroniser() {
    try {
      const f = await M().trouverReglages();
      if (!f || !f.ownedByMe) return;
      if (!(await FTSPersonnel.charger({ rapide: true }).catch(() => null))) return;
      if (!FTSPersonnel.toutes().some((p) => p.email)) return; // base vide : on ne retire rien
      lireGens();
      await partager(f.id);
    } catch (e) { console.warn("Partage du classeur des accès :", e); }
  }

  return { monter, synchroniser };
})();
window.FTSAccesModules = FTSAccesModules;
