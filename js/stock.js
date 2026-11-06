/**
 * stock.js — Stock de fin de mois (tablette du chef, page d'accueil)
 *
 * Règles validées avec Clément :
 *  - à compter le DERNIER JOUR OUVRÉ du mois (week-ends et jours fériés exclus) ;
 *  - bandeau sous les 4 applications : rappel 2 jours ouvrés avant, « aujourd'hui »
 *    le dernier jour ouvré, puis en rouge les 3 premiers jours ouvrés du mois
 *    suivant si ce n'est pas fait ; ensuite plus rien sur la tablette ;
 *  - on compte : palettes de ciment COMPLÈTES, et les tubes de chaque diamètre
 *    en 1,50 m et en 3 m ;
 *  - uniquement pour les chefs MICROPIEUX (catégorie « MICROPIEUX » ou « LES
 *    DEUX » dans Personnel FTS, retrouvés par l'e-mail du compte de la
 *    tablette). Compte absent de la base → on se fie au type du chantier
 *    (Micropieux / Battage) ;
 *  - un seul stock par chantier (pas par atelier) ; un nouvel envoi pour le
 *    même mois remplace le précédent (correction possible tant que le
 *    bandeau est affiché) ;
 *  - enregistré dans l'onglet « Stock » du suivi du chantier + mail simple à
 *    m.buchon@fts-btp.fr ;
 *  - fonctionne sans réseau : l'envoi attend sur la tablette et part tout
 *    seul (étapes mémorisées : suivi puis mail, jamais de doublon).
 *
 * FTSStock.monter(conteneur, { getChantierActif, toast, nomUtilisateur })
 */
const FTSStock = (() => {
  const DESTINATAIRES = ["m.buchon@fts-btp.fr"];
  const DIAMETRES = ["60", "73", "88,9", "114", "127", "139,7", "177,8"];
  const LONGUEURS = ["1,50 m", "3 m"];
  const JOURS_AVANT = 2;   // rappel : jours ouvrés avant le dernier jour ouvré
  const JOURS_APRES = 3;   // rattrapage : premiers jours ouvrés du mois suivant
  const CLE_ATTENTE = "fts_stock_attente";
  const CLE_FAITS = "fts_stock_faits";
  const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

  let opts = {};
  let zone = null;
  let envoiEnCours = null;
  const verifies = {}; // cle → true quand l'onglet Stock a été relu pendant cette visite

  // ─── Petits outils ───────────────────────────────────────────
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lire = (k, d) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : d; } catch (e) { return d; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const jour0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fr = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  const jj = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  const jourLong = (d) => `${JOURS[d.getDay()]} ${jj(d)}`;
  const cleMois = (a, m) => `${String(m + 1).padStart(2, "0")}/${a}`; // "11/2026"
  const enLigne = () => navigator.onLine !== false;
  const connecte = () => !!(window.FTSAuth && FTSAuth.isSignedIn());

  // ─── Jours ouvrés (France) ───────────────────────────────────
  function paques(a) { // algorithme de Meeus
    const b = a % 19, c = Math.floor(a / 100), d = a % 100, e = Math.floor(c / 4), f = c % 4, g = Math.floor((c + 8) / 25), h = Math.floor((c - g + 1) / 3);
    const i = (19 * b + c - e - h + 15) % 30, k = Math.floor(d / 4), l = d % 4, m = (32 + 2 * f + 2 * k - i - l) % 7, n = Math.floor((b + 11 * i + 22 * m) / 451);
    const mois = Math.floor((i + m - 7 * n + 114) / 31), jour = ((i + m - 7 * n + 114) % 31) + 1;
    return new Date(a, mois - 1, jour);
  }
  const ferCache = {};
  function feries(a) {
    if (ferCache[a]) return ferCache[a];
    const p = paques(a);
    const dec = (n) => new Date(p.getFullYear(), p.getMonth(), p.getDate() + n);
    const l = [new Date(a, 0, 1), dec(1), new Date(a, 4, 1), new Date(a, 4, 8), dec(39), dec(50), new Date(a, 6, 14), new Date(a, 7, 15), new Date(a, 10, 1), new Date(a, 10, 11), new Date(a, 11, 25)];
    return (ferCache[a] = new Set(l.map(iso)));
  }
  const estOuvre = (d) => d.getDay() !== 0 && d.getDay() !== 6 && !feries(d.getFullYear()).has(iso(d));
  function dernierOuvre(a, m) {
    const d = new Date(a, m + 1, 0);
    while (!estOuvre(d)) d.setDate(d.getDate() - 1);
    return d;
  }
  function decalerOuvres(d, n) { // n jours ouvrés avant (n<0) ou après (n>0)
    const x = new Date(d);
    const pas = n < 0 ? -1 : 1;
    let reste = Math.abs(n);
    while (reste > 0) { x.setDate(x.getDate() + pas); if (estOuvre(x)) reste--; }
    return x;
  }
  function premiersOuvres(a, m, n) { // n-ième jour ouvré du mois
    const d = new Date(a, m, 1);
    while (!estOuvre(d)) d.setDate(d.getDate() + 1);
    return n > 1 ? decalerOuvres(d, n - 1) : d;
  }

  /**
   * Où en est-on aujourd'hui ? → null (rien à afficher) ou
   * { a, m, mois:"MM/AAAA", libelle:"novembre", phase:"avant"|"jour"|"apres", dernier: Date }
   */
  function periode(auj = new Date()) {
    const t = jour0(auj);
    const a = t.getFullYear(), m = t.getMonth();
    const dern = dernierOuvre(a, m);
    const debut = decalerOuvres(dern, -JOURS_AVANT);
    const info = (aa, mm, phase, d) => ({ a: aa, m: mm, mois: cleMois(aa, mm), libelle: MOIS[mm], phase, dernier: d });
    if (t >= debut && t < dern) return info(a, m, "avant", dern);
    if (+t === +dern) return info(a, m, "jour", dern);
    if (t > dern) return info(a, m, "apres", dern); // week-end / férié après le dernier jour ouvré
    // début de mois : rattrapage du mois précédent
    const pa = m === 0 ? a - 1 : a, pm = m === 0 ? 11 : m - 1;
    if (t <= premiersOuvres(a, m, JOURS_APRES)) return info(pa, pm, "apres", dernierOuvre(pa, pm));
    return null;
  }

  // ─── Mémoire locale : stocks faits / en attente ──────────────
  const cle = (chantierId, mois) => `${chantierId}|${mois}`;
  function fait(chantierId, mois) { return lire(CLE_FAITS, {})[cle(chantierId, mois)] || null; }
  function noterFait(chantierId, mois, info) {
    const f = lire(CLE_FAITS, {});
    if (info) f[cle(chantierId, mois)] = info; else delete f[cle(chantierId, mois)];
    // on ne garde que les 6 derniers mois
    const garder = Object.entries(f).sort((x, y) => (y[1].le || 0) - (x[1].le || 0)).slice(0, 30);
    ecrire(CLE_FAITS, Object.fromEntries(garder));
  }
  const attente = () => lire(CLE_ATTENTE, []);
  const enAttente = (chantierId, mois) => attente().find((x) => x.chantierId === chantierId && x.mois === mois) || null;

  function totalTubes(lignes) { return lignes.filter((l) => l.article === "Tube").reduce((s, l) => s + (Number(l.quantite) || 0), 0); }
  function totalPalettes(lignes) { const l = lignes.find((x) => x.article === "Ciment (palettes complètes)"); return l ? Number(l.quantite) || 0 : 0; }
  function resume(lignes) { const p = totalPalettes(lignes), t = totalTubes(lignes); return `${p} palette${p > 1 ? "s" : ""} de ciment · ${t} tube${t > 1 ? "s" : ""}`; }

  // ─── Qui doit faire le stock ? (chefs micropieux) ─────────────
  function concerne() {
    const email = (window.FTSAuth && FTSAuth.emailMemorise && FTSAuth.emailMemorise()) || "";
    const pers = window.FTSPersonnel && email ? FTSPersonnel.parEmail(email) : null;
    if (pers && pers.categorie) return pers.categorie === "MICROPIEUX" || pers.categorie === "LES DEUX";
    const tech = opts.techniquesChantier ? opts.techniquesChantier() : null;
    return !!(tech && (tech.includes("Micropieux") || tech.includes("Battage")));
  }

  // ─── Bandeau ─────────────────────────────────────────────────
  function rendre() {
    if (!zone) return;
    const ch = opts.getChantierActif && opts.getChantierActif();
    const p = periode();
    // un envoi en attente reste toujours visible (même si les droits ont changé)
    if (!ch || !p || (!enAttente(ch.id, p.mois) && !concerne())) { zone.innerHTML = ""; return; }
    const attenteItem = enAttente(ch.id, p.mois);
    const f = fait(ch.id, p.mois);
    const nomCh = String(ch.name).split(/\s+/).slice(1).join(" ") || ch.name;
    let html;
    if (attenteItem) {
      html = `<div class="stk ok att" data-stk="corriger"><span class="ic">⏳</span><div><b>Stock de ${p.libelle} enregistré sur la tablette</b><span class="t">${esc(resume(attenteItem.lignes))} — ${enLigne() ? (connecte() ? "envoi en cours…" : "en attente de connexion Google") : "part dès que la tablette capte le réseau"}</span></div><span class="go sec">Corriger</span></div>`;
    } else if (f) {
      html = `<div class="stk ok" data-stk="corriger"><span class="ic">✅</span><div><b>Stock de ${p.libelle} envoyé</b><span class="t">${esc(f.resume || "")}${f.par ? " · par " + esc(f.par) : ""}${f.le ? " · le " + esc(jj(new Date(f.le))) + " à " + new Date(f.le).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : ""}</span></div><span class="go sec">Corriger</span></div>`;
    } else if (p.phase === "avant") {
      html = `<div class="stk rap" data-stk="saisir"><span class="ic">📦</span><div><b>Stock de fin de mois à faire ${esc(jourLong(p.dernier))}</b><span class="t">Ciment et tubes restant sur ${esc(nomCh)}. Tu seras absent ce jour-là ? Tu peux le faire dès maintenant.</span></div><span class="go">Faire le stock ›</span></div>`;
    } else if (p.phase === "jour") {
      html = `<div class="stk" data-stk="saisir"><span class="ic">📦</span><div><b>Stock de fin de mois à faire aujourd'hui</b><span class="t">Compte le ciment et les tubes restant sur ${esc(nomCh)} avant de partir ce soir.</span></div><span class="go">Faire le stock ›</span></div>`;
    } else {
      html = `<div class="stk retard" data-stk="saisir"><span class="ic">⚠️</span><div><b>Stock de ${p.libelle} pas encore fait</b><span class="t">À faire dès que possible : compte ce qu'il reste aujourd'hui (la date du comptage sera indiquée).</span></div><span class="go">Faire le stock ›</span></div>`;
    }
    zone.innerHTML = html;
    // Un autre atelier l'a peut-être déjà fait : on relit le suivi une fois
    if (!f && !attenteItem && connecte() && enLigne() && !verifies[cle(ch.id, p.mois)] && window.FTSSheets && FTSSheets.lireStock) {
      verifies[cle(ch.id, p.mois)] = true;
      FTSSheets.lireStock(ch.id, ch.name, p.mois).then((s) => {
        if (!s) return;
        noterFait(ch.id, p.mois, { resume: resume(s.lignes), par: s.comptePar, le: dateDepuisTexte(s.enregistreLe), lignes: s.lignes, remarque: s.remarque, distant: true });
        rendre();
      }).catch(() => {});
    }
  }
  function dateDepuisTexte(t) { // "27/11/2026 16:42" → timestamp
    const m = String(t || "").match(/(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)).getTime() : null;
  }

  // ─── Fenêtre de saisie ───────────────────────────────────────
  function stepper(id, v) {
    return `<div class="stk-st"><button type="button" data-moins="${id}" aria-label="Moins">−</button><input id="${id}" type="text" inputmode="numeric" pattern="[0-9]*" value="${v || ""}" placeholder="0" autocomplete="off"><button type="button" data-plus="${id}" aria-label="Plus">+</button></div>`;
  }
  const idTube = (d, l) => `stkT_${d.replace(",", "_")}_${l.startsWith("1") ? "150" : "300"}`;

  function ouvrir() {
    const ch = opts.getChantierActif && opts.getChantierActif();
    const p = periode();
    if (!ch || !p || !concerne()) return;
    const precedent = enAttente(ch.id, p.mois) || fait(ch.id, p.mois);
    const val = (article, diametre, longueur) => {
      if (!precedent || !precedent.lignes) return "";
      const l = precedent.lignes.find((x) => x.article === article && (x.diametre || "") === (diametre || "") && (x.longueur || "") === (longueur || ""));
      return l && Number(l.quantite) ? Number(l.quantite) : "";
    };
    const auj = new Date();
    const ancien = document.getElementById("popStock");
    if (ancien) ancien.remove();
    const ov = document.createElement("div");
    ov.className = "pop-ov";
    ov.id = "popStock";
    ov.innerHTML = `<div class="pop stk-pop" role="dialog" aria-labelledby="popStockTitre">
      <div class="pop-h"><span id="popStockTitre">📦 Stock de fin de mois — ${esc(p.libelle)} ${p.a}<small>${esc(ch.name)} · compté le ${esc(jourLong(auj))}${p.phase !== "jour" && !(p.phase === "apres" && +jour0(auj) <= +p.dernier) ? ` (dernier jour ouvré : ${esc(jourLong(p.dernier))})` : ""}</small></span><button type="button" class="pop-x" data-fermer aria-label="Fermer">✕</button></div>
      <div class="pop-b">
        ${precedent ? `<div class="stk-info">${precedent.distant ? "Stock déjà envoyé pour ce mois" : "Tu corriges le stock déjà saisi"} : le nouvel envoi remplacera l'ancien.</div>` : ""}
        <div class="stk-sec">CIMENT</div>
        <div class="stk-row"><div class="n">Palettes de ciment complètes<small>ne compte pas les palettes entamées</small></div>${stepper("stkCiment", val("Ciment (palettes complètes)", "", ""))}</div>
        <div class="stk-sec" style="margin-top:10px">TUBES RESTANTS <small>(laisse vide = 0)</small></div>
        <table class="stk-tb"><thead><tr><th>Diamètre</th>${LONGUEURS.map((l) => `<th>Tubes ${l}</th>`).join("")}</tr></thead><tbody>
          ${DIAMETRES.map((d) => `<tr><td>Ø ${d}</td>${LONGUEURS.map((l) => `<td>${stepper(idTube(d, l), val("Tube", d, l))}</td>`).join("")}</tr>`).join("")}
        </tbody></table>
        <div class="stk-sec" style="margin-top:12px">REMARQUE (FACULTATIF)</div>
        <textarea id="stkRemarque" maxlength="400" placeholder="Ex : 2 palettes abîmées par la pluie, tubes Ø114 à rapatrier au dépôt…">${esc((precedent && precedent.remarque) || "")}</textarea>
      </div>
      <div class="stk-f"><span class="m">${enLigne() ? "Envoyé au bureau (m.buchon) et enregistré dans le suivi du chantier." : "📡 Pas de réseau : le stock partira dès que la tablette capte."}</span><button type="button" class="stk-b" data-fermer>Annuler</button><button type="button" class="stk-b p" id="stkEnvoyer">Envoyer le stock</button></div>
    </div>`;
    document.body.appendChild(ov);
    const fermer = () => ov.remove();
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.closest("[data-fermer]")) return fermer();
      const plus = e.target.closest("[data-plus]"), moins = e.target.closest("[data-moins]");
      if (plus || moins) {
        const inp = ov.querySelector("#" + (plus || moins).dataset[plus ? "plus" : "moins"]);
        const v = Math.max(0, (parseInt(inp.value, 10) || 0) + (plus ? 1 : -1));
        inp.value = v || "";
      }
    });
    ov.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => { i.value = i.value.replace(/\D/g, "").slice(0, 4); }));
    ov.querySelector("#stkEnvoyer").addEventListener("click", () => {
      const n = (id) => parseInt(ov.querySelector("#" + id).value, 10) || 0;
      const lignes = [{ article: "Ciment (palettes complètes)", diametre: "", longueur: "", quantite: n("stkCiment") }];
      DIAMETRES.forEach((d) => LONGUEURS.forEach((l) => { const q = n(idTube(d, l)); if (q) lignes.push({ article: "Tube", diametre: d, longueur: l, quantite: q }); }));
      if (!lignes[0].quantite && lignes.length === 1 && !confirm("Aucune palette et aucun tube : le chantier n'a vraiment plus rien en stock ?")) return;
      const remarque = ov.querySelector("#stkRemarque").value.trim();
      ajouter({ chantierId: ch.id, chantierName: ch.name, mois: p.mois, libelle: `${p.libelle} ${p.a}`, dateComptage: fr(auj), jourComptage: jourLong(auj), lignes, remarque, correction: !!precedent });
      fermer();
      if (opts.toast) opts.toast(enLigne() ? "📦 Stock enregistré : envoi en cours…" : "📦 Stock enregistré sur la tablette : il partira dès le retour du réseau.");
    });
  }

  // ─── File d'envoi (hors ligne) ───────────────────────────────
  function ajouter(item) {
    const l = attente().filter((x) => !(x.chantierId === item.chantierId && x.mois === item.mois));
    l.push({ ...item, id: `${item.chantierId}|${item.mois}|${Date.now()}`, creeLe: Date.now(), etapes: { suivi: false, mail: false } });
    ecrire(CLE_ATTENTE, l);
    rendre();
    envoyer();
  }
  function texteMail(x, par) {
    const tubes = DIAMETRES.map((d) => {
      const q = LONGUEURS.map((l) => ({ l, q: (x.lignes.find((y) => y.article === "Tube" && y.diametre === d && y.longueur === l) || {}).quantite || 0 }));
      return q.some((z) => z.q) ? `- Ø ${d} : ${q.map((z) => `${z.q} x ${z.l}`).join(" / ")}` : null;
    }).filter(Boolean);
    return [
      "Bonjour,",
      "",
      `${x.correction ? "Correction du stock" : "Stock"} de fin de mois (${x.libelle}) du chantier ${x.chantierName}, compté le ${x.jourComptage}/${x.dateComptage.slice(6)}${par ? " par " + par : ""}.`,
      "",
      `Ciment : ${totalPalettes(x.lignes)} palette${totalPalettes(x.lignes) > 1 ? "s" : ""} complète${totalPalettes(x.lignes) > 1 ? "s" : ""}`,
      "",
      "Tubes :",
      ...(tubes.length ? tubes : ["- aucun tube"]),
      ...(x.remarque ? ["", `Remarque : ${x.remarque}`] : []),
      "",
      "Message envoyé depuis la tablette du chantier.",
    ].join("\n");
  }
  async function envoyer() {
    if (envoiEnCours) return envoiEnCours;
    if (!attente().length || !enLigne() || !connecte()) { rendre(); return; }
    envoiEnCours = (async () => {
      let par = "";
      try { const info = await FTSAuth.getUserInfo(); par = (info && (info.name || info.email)) || ""; } catch (e) {}
      for (const x of attente()) {
        const maj = (etapes) => { const l = attente(); const i = l.findIndex((y) => y.id === x.id); if (i >= 0) { l[i].etapes = { ...l[i].etapes, ...etapes }; ecrire(CLE_ATTENTE, l); } };
        try {
          if (!x.etapes.suivi) {
            await FTSSheets.enregistrerStock(x.chantierId, x.chantierName, { mois: x.mois, dateComptage: x.dateComptage, lignes: x.lignes, comptePar: par, remarque: x.remarque });
            maj({ suivi: true });
          }
          if (!x.etapes.mail) {
            await FTSGmail.envoyerTexte({ to: DESTINATAIRES, subject: `${x.correction ? "Correction - " : ""}Stock fin de mois ${x.libelle} - ${x.chantierName}`, body: texteMail(x, par) });
            maj({ mail: true });
          }
          ecrire(CLE_ATTENTE, attente().filter((y) => y.id !== x.id));
          noterFait(x.chantierId, x.mois, { resume: resume(x.lignes), par, le: Date.now(), lignes: x.lignes, remarque: x.remarque });
          if (opts.toast) opts.toast(`✅ Stock de ${x.libelle} envoyé au bureau.`);
        } catch (e) {
          console.warn("Stock de fin de mois : envoi reporté", e);
        }
      }
    })().finally(() => { envoiEnCours = null; rendre(); });
    return envoiEnCours;
  }

  // ─── Montage ─────────────────────────────────────────────────
  function monter(conteneur, o) {
    zone = conteneur;
    opts = o || {};
    zone.addEventListener("click", (e) => { if (e.target.closest("[data-stk]")) ouvrir(); });
    window.addEventListener("online", () => { rendre(); envoyer(); });
    window.addEventListener("offline", rendre);
    if (window.FTSAuth) FTSAuth.onAuthChange(() => { rendre(); envoyer(); chargerPersonnel(); });
    setInterval(() => { rendre(); envoyer(); }, 60000);
    rendre();
    envoyer();
    chargerPersonnel();
  }
  // Base Personnel FTS (copie locale de moins d'une heure, sinon relue)
  function chargerPersonnel() {
    if (window.FTSPersonnel) FTSPersonnel.charger({ rapide: true }).catch(() => {}).then(rendre);
  }

  return { monter, rendre, envoyer, periode, estOuvre, dernierOuvre, _texteMail: texteMail };
})();
window.FTSStock = FTSStock;
