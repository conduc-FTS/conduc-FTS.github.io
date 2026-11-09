/**
 * ouverture-chantier.js — OUVERTURE CHANTIER par les chargés d'affaires
 * (+ fiche d'affaire acquise). Proposition de Clément à la direction (07/11/2026) :
 * tout est dans ce fichier, pour pouvoir le CACHER ou le SUPPRIMER sans casse.
 *
 *  - Cacher : écran Accès › Modules, décocher « Ouverture de chantier » pour
 *    tous les postes (et les exceptions) → l'entrée disparaît des menus.
 *  - Supprimer : effacer ce fichier et les points d'accroche marqués
 *    « OUVERTURE CHANTIER » (liste dans claude/conception-ouverture-chantier-commerciaux.md).
 *    Les chantiers déjà ouverts restent des chantiers normaux (meta.ouverture ignorée).
 *
 * Ce qui est créé à l'envoi :
 *  1. le chantier (même arborescence que « + Nouveau chantier »), montant vendu
 *     rangé à part comme d'habitude (jamais visible des chefs) ;
 *  2. meta.ouverture sur le dossier du chantier (sans facturation) → la fiche de
 *     préparation se pré-remplit, la liste Préparation affiche « NOUVEAU » ;
 *  3. dans REFERENTIEL › AFFAIRES ACQUISES (encadrement seulement, jamais les chefs) :
 *     la fiche d'affaire acquise (PDF), le devis signé s'il est joint, et le
 *     détail complet (JSON, facturation comprise) ;
 *  4. le mail d'information, SANS aucun montant : envoi direct (compte Gmail)
 *     ou mail Outlook pré-rempli depuis l'adresse pro, avec les liens Drive.
 *
 * FTSOuverture.monter(conteneur, { obtenirDonnees, apresCreation })
 * Nécessite drive.js, personnel.js, modules.js, mail-envoi.js, gmail.js (facultatif).
 */
const FTSOuverture = (() => {
  const DOSSIER = "AFFAIRES ACQUISES"; // dans REFERENTIEL
  const CLE_DEST = "fts_ouverture_destinataires";
  const POSTES_DEST = /CONDUCTEUR|DIRECT(EUR|RICE) TRAVAUX|PRÉSIDENT/;

  let racine = null, opts = {}, onglet = "nouveau", f = null, devis = null, dernier = null, enCours = false;
  const esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  const $ = (id) => racine.querySelector("#ov_" + id);

  function vierge() {
    return {
      code: "", nom: "", techs: ["Micropieux"], nbMicropieux: "", nbPieux: "", nbBattage: "", realMode: "date", realVal: "", duree: "", devisLe: "", adresse: "",
      client: "", typeClient: "Entreprise générale", contact: "", moe: "", be: "",
      deblais: false, recepage: false, essai: false, essaiNb: "", bc: false, bcNom: "", g4: false, sondage: false, implantation: true,
      hauteur: false, hauteurVal: "", acces: false,
      montant: "", dateFact: "", acompte: false, acomptePct: "",
      infos: "", destinataires: "",
    };
  }

  // ─── Styles (dans le fichier, pour ne rien laisser ailleurs) ───────
  function styles() {
    if (document.getElementById("ovStyle")) return;
    const st = document.createElement("style");
    st.id = "ovStyle";
    st.textContent = `
.ov-tabs{display:flex;gap:6px;margin-bottom:12px}.ov-tabs button{border:0;background:#fff;border-radius:9px;padding:9px 15px;font-weight:700;font-size:.86rem;color:#555;cursor:pointer;font-family:inherit;box-shadow:0 1px 2px rgba(0,0,0,.05)}.ov-tabs button.on{background:#1d1d1f;color:#fff}
.ov-prog{display:flex;align-items:center;gap:10px;background:#fff;border-radius:12px;padding:10px 16px;margin-bottom:12px;font-size:.84rem}.ov-prog .bar{flex:1;height:8px;background:#eee;border-radius:5px;overflow:hidden}.ov-prog .bar i{display:block;height:100%;background:#34C759;transition:width .2s}
.ov-blk{background:#fff;border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.05);margin-bottom:10px;overflow:hidden}
.ov-bh{display:flex;align-items:center;gap:10px;padding:13px 18px;font-weight:700;font-size:.95rem;cursor:pointer;user-select:none}
.ov-bh .num{width:26px;height:26px;border-radius:50%;background:#1d1d1f;color:#fff;font-size:.8rem;display:flex;align-items:center;justify-content:center;flex:none}
.ov-bh .s{font-weight:400;color:var(--text-sub);font-size:.8rem}.ov-bh .ch{margin-left:auto;color:#9aa0aa}
.ov-bh .req{font-size:.7rem;font-weight:800;color:#C0392B;background:#FDECEC;border-radius:5px;padding:1px 6px}
.ov-blk.ferme .ov-bb{display:none}.ov-bb{border-top:1px solid #eee;padding:14px 18px 16px}
.ov-g{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px 14px}.ov-g .two{grid-column:span 2}.ov-g .full{grid-column:1/-1}
@media(max-width:1100px){.ov-g{grid-template-columns:1fr 1fr}}
.ov-f label{display:block;font-size:.76rem;font-weight:600;color:var(--text-sub);margin-bottom:5px}.ov-f label i{color:#C0392B;font-style:normal}
.ov-f input,.ov-f select,.ov-f textarea{width:100%;box-sizing:border-box;border:1px solid #d6d9de;border-radius:9px;padding:8px 11px;font:inherit;font-size:.9rem;background:#fff}
.ov-aide{font-size:.75rem;color:var(--text-sub);margin-top:4px}.ov-aide.ok{color:#1D6E3E}.ov-aide.ko{color:#C0392B}
.ov-chips{display:flex;gap:8px;flex-wrap:wrap}.ov-chip{border:1px solid #d6d9de;border-radius:20px;padding:6px 13px;font-weight:600;font-size:.84rem;cursor:pointer;background:#fff;font-family:inherit}.ov-chip.on{background:#1d1d1f;color:#fff;border-color:#1d1d1f}.ov-chips.petit .ov-chip{padding:3px 10px;font-size:.76rem}
.ov-oo{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px}@media(max-width:1100px){.ov-oo{grid-template-columns:1fr}}
.ov-tg{display:flex;align-items:center;gap:10px;border:1px solid #e5e7eb;border-radius:11px;padding:8px 12px;min-height:50px}
.ov-tg b{font-size:.86rem}.ov-tg small{display:block;font-size:.74rem;color:var(--text-sub)}
.ov-sw{width:42px;height:25px;border-radius:13px;background:#e5e5ea;position:relative;flex:none;border:0;cursor:pointer;padding:0}.ov-sw::after{content:"";position:absolute;top:2px;left:2px;width:21px;height:21px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .15s}
.ov-sw.on{background:#34C759}.ov-sw.on::after{left:19px}
.ov-tg .x{margin-left:auto}.ov-tg .x input{border:1px solid #d6d9de;border-radius:8px;padding:5px 8px;width:150px;font:inherit;font-size:.84rem}.ov-tg.off .x{opacity:.3;pointer-events:none}
.ov-lien{font-size:.7rem;color:#2A5DBF;font-weight:700}
.ov-drop{display:block;border:2px dashed #cfd3d9;border-radius:10px;padding:12px;text-align:center;color:var(--text-sub);font-size:.84rem;cursor:pointer}.ov-drop.ok{border-color:#34C759;color:#1D6E3E;background:#EAF6EE}
.ov-foot{display:flex;align-items:center;gap:10px;background:#fff;border-radius:14px;padding:14px 18px;margin-top:4px;flex-wrap:wrap}
.ov-res{background:#fff;border-radius:14px;padding:20px 22px}.ov-res h2{margin:0 0 10px;font-size:1.1rem}.ov-res ul{margin:0 0 14px 18px;padding:0;line-height:1.8}
.ov-res pre{white-space:pre-wrap;font-family:inherit;font-size:.84rem;line-height:1.5;background:#F4F5F7;border-radius:10px;padding:12px 14px;margin:8px 0 14px}
.ov-act{display:flex;gap:10px;flex-wrap:wrap}
.ov-fiche{position:fixed;left:-10000px;top:0;width:210mm;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;padding:12mm 13mm;box-sizing:border-box;display:flex;flex-direction:column;gap:3.2mm;height:297mm}
.ov-fiche table{border-collapse:collapse;width:100%;table-layout:fixed}.ov-fiche td{border:.3mm solid #000;padding:1.4mm 2.2mm;vertical-align:middle}
.ov-fiche .g{background:#c8c8c8;font-weight:bold;font-size:8.5pt}.ov-fiche .t{background:#3A3A3A;color:#fff;font-weight:bold;font-size:9pt;letter-spacing:.06em}
.ov-fiche .ck{display:inline-block;width:3.4mm;height:3.4mm;border:.35mm solid #000;vertical-align:-.6mm;margin-right:1.4mm;text-align:center;line-height:3.2mm;font-size:8pt;font-weight:bold}
.ov-fiche .non{color:#888}.ov-fiche .oui{font-weight:bold}.ov-fiche .g2{display:grid;grid-template-columns:1fr 1fr;gap:3.2mm}
.ov-fiche .note{height:42mm;vertical-align:top}.ov-fiche .sig td{height:22mm;vertical-align:top;font-size:8.5pt}
.ov-fiche .pied{margin-top:auto;font-size:7pt;color:#666;display:flex;justify-content:space-between;border-top:.2mm solid #999;padding-top:1.5mm}
.pp-nouveau{display:inline-block;margin-top:3px;font-size:.66rem;font-weight:800;color:#2457C5;background:#E8F0FE;border-radius:6px;padding:1px 6px}`;
    document.head.appendChild(st);
  }

  // ─── Outils ────────────────────────────────────────────────────────
  const moiNom = () => (window.FTSModules && FTSModules.moi()) || "";
  const moiEmail = () => { const e = window.FTSModules && FTSModules.etat(); return (e && e.email) || (FTSAuth.emailMemorise && FTSAuth.emailMemorise()) || ""; };
  function lundi(n, an) { const j4 = new Date(an, 0, 4), l = new Date(j4); l.setDate(j4.getDate() - ((j4.getDay() + 6) % 7) + (n - 1) * 7); return l; }
  const fr = (d) => d.toLocaleDateString("fr-FR");
  const frJ = (iso) => (iso ? fr(new Date(iso + "T00:00:00")) : "");
  function semaine(n) {
    n = Number(n); if (!(n >= 1 && n <= 53)) return null;
    const auj = new Date(), an = auj.getFullYear();
    // semaine déjà passée cette année → l'année prochaine
    let l = lundi(n, an); if (l < new Date(auj.getFullYear(), auj.getMonth(), auj.getDate() - 7)) l = lundi(n, an + 1);
    const v = new Date(l); v.setDate(l.getDate() + 4);
    return { lundi: l, vendredi: v, texte: `semaine ${n} (du ${l.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} au ${fr(v)})` };
  }
  function texteRealisation(x) {
    if (x.realMode === "date") return x.realVal ? frJ(x.realVal) : "à définir";
    if (x.realMode === "semaine") { const s = semaine(x.realVal); return s ? s.texte : "à définir"; }
    return "à définir";
  }
  const libNb = (t) => (t === "Micropieux" ? "micropieux" : t === "Pieux" ? "pieux" : "pieux battus");
  const TECHS = ["Micropieux", "Pieux", "Battage"];
  // Chantier mixte possible : une ou plusieurs techniques, un nombre pour chacune
  const techsDe = (x) => TECHS.filter((t) => (x.techs || []).includes(t));
  const nbDe = (x, t) => nombre(x["nb" + t]);
  const texteNombres = (x) => techsDe(x).map((t) => `${nbDe(x, t)} ${libNb(t)}`).join(" + ");
  const nombre = (v) => Number(String(v || "").replace(/\s/g, "").replace(",", ".").replace(/[^\d.]/g, "")) || 0;
  const codeNorm = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");

  let codesExistants = null; // Map code → libellé
  async function chargerCodes() {
    const m = new Map();
    try {
      const d = opts.obtenirDonnees ? await opts.obtenirDonnees(false) : null;
      ((d && d.chantiers) || []).forEach((c) => m.set(codeNorm(c.name.split(/\s/)[0]), c.name));
    } catch (e) {}
    try { (await FTSDrive.listChantiersArchives()).forEach((c) => m.set(codeNorm(c.name.split(/\s/)[0]), c.name + " (archivé)")); } catch (e) {}
    codesExistants = m;
  }
  function verifCode() {
    const c = codeNorm(f.code);
    if (!c) return { ok: false, txt: "" };
    if (!/^\d{2}FTS\d{3,4}$/.test(c)) return { ok: false, txt: "Format attendu : 26FTS123" };
    if (codesExistants && codesExistants.has(c)) return { ok: false, txt: `❌ Code déjà utilisé : ${codesExistants.get(c)}` };
    return { ok: true, txt: codesExistants ? "✓ Code libre (aucun chantier, même archivé)" : "✓ Format correct" };
  }
  function manque() {
    const m = [];
    if (!verifCode().ok) m.push("code");
    if (!f.nom.trim()) m.push("nom");
    if (!f.client.trim()) m.push("client");
    if (!techsDe(f).length) m.push("technique");
    else if (techsDe(f).some((t) => !(nbDe(f, t) > 0))) m.push("nombre");
    return m;
  }
  function destinatairesDefaut() {
    let memo = ""; try { memo = localStorage.getItem(CLE_DEST) || ""; } catch (e) {}
    if (memo) return memo;
    const moi = FTSModules.mail(moiEmail());
    return FTSPersonnel.toutes().filter((p) => p.statut === "ACTIF" && p.email && (p.categorie === "ENCADREMENT" || p.fonctionEnc) && POSTES_DEST.test(p.categorie === "ENCADREMENT" ? p.poste : p.fonctionEnc) && FTSModules.mail(p.email) !== moi)
      .map((p) => p.email).join(" ; ");
  }
  const adresses = (s) => String(s || "").split(/[;,\s]+/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x));

  // ─── Formulaire ────────────────────────────────────────────────────
  const sw = (k, titre, sous, extra = "") => `<div class="ov-tg ${f[k] ? "" : "off"}"><button type="button" class="ov-sw ${f[k] ? "on" : ""}" data-sw="${k}" aria-pressed="${f[k]}"></button><div><b>${titre}</b><small>${sous}</small></div>${extra}</div>`;
  const champ = (k, lib, o = {}) => `<div class="ov-f ${o.cls || ""}"><label>${lib}${o.req ? " <i>*</i>" : ""}</label><input data-k="${k}" value="${esc(f[k])}" ${o.type ? `type="${o.type}"` : ""} placeholder="${esc(o.ph || "")}">${o.aide ? `<div class="ov-aide ${o.aideCls || ""}" id="ov_aide_${k}">${o.aide}</div>` : ""}</div>`;
  const ouverts = new Set(["1", "2", "3", "6"]);
  const bloc = (n, titre, sous, corps, req) => `<div class="ov-blk ${ouverts.has(n) ? "" : "ferme"}" data-b="${n}"><div class="ov-bh"><span class="num">${n}</span>${titre}${req ? '<span class="req">obligatoire</span>' : ""}<span class="s">${sous || ""}</span><span class="ch">${ouverts.has(n) ? "▾" : "▸"}</span></div><div class="ov-bb">${corps}</div></div>`;

  function rendreForm() {
    const vc = verifCode(), s = f.realMode === "semaine" ? semaine(f.realVal) : null;
    const m = manque();
    const real = f.realMode === "date" ? `<input data-k="realVal" type="date" value="${esc(f.realVal)}">`
      : f.realMode === "semaine" ? `<input data-k="realVal" type="number" min="1" max="53" value="${esc(f.realVal)}" placeholder="n° de semaine">` : `<input value="à définir" disabled>`;
    return `
      <div class="ov-prog">Obligatoire : <b id="ov_prog" style="${m.length ? "color:#C0392B" : ""}">${m.length ? "il manque : " + m.join(", ") : "complet ✓"}</b><span class="bar"><i id="ov_bar" style="width:${Math.round(100 * (4 - m.length) / 4)}%"></i></span><span style="color:var(--text-sub)">ouvert par ${esc(moiNom() || moiEmail())}</span></div>
      ${bloc("1", "Le chantier", "", `<div class="ov-g">
        ${champ("code", "Code chantier", { req: true, ph: "26FTS123", aide: vc.txt || "le code que tu donnes au chantier", aideCls: vc.txt ? (vc.ok ? "ok" : "ko") : "" })}
        ${champ("nom", "Nom du chantier", { req: true, cls: "two", ph: "VILLE - NATURE DES TRAVAUX" })}
        <div class="ov-f full"><label>Technique(s) <i>*</i> <span style="font-weight:400">· plusieurs possibles pour un chantier mixte</span></label><div class="ov-chips">${TECHS.map((t) => `<button type="button" class="ov-chip ${f.techs.includes(t) ? "on" : ""}" data-tech="${t}">${f.techs.includes(t) ? "✓ " : ""}${t}</button>`).join("")}</div></div>
        ${techsDe(f).map((t) => champ("nb" + t, `Nombre de ${libNb(t)}`, { req: true, type: "number" })).join("")}
        ${techsDe(f).length < 3 ? `<div class="ov-f" style="${techsDe(f).length === 2 ? "" : "grid-column:span " + (3 - techsDe(f).length)}"></div>` : ""}
        <div class="ov-f"><label>Réalisation prévue</label><div class="ov-chips petit" style="margin-bottom:6px">${[["date", "Date"], ["semaine", "Semaine n°"], ["adefinir", "À définir"]].map(([k, l]) => `<button type="button" class="ov-chip ${f.realMode === k ? "on" : ""}" data-real="${k}">${l}</button>`).join("")}</div>${real}<div class="ov-aide" id="ov_aide_real">${f.realMode === "semaine" ? (s ? s.texte.replace(/^semaine \d+ /, "") : "numéro de semaine entre 1 et 53") : ""}</div></div>
        ${champ("duree", "Durée de chantier prévue", { ph: "ex. 6 jours" })}
        ${champ("devisLe", "Devis signé le", { type: "date", aide: "la date d'émission de la fiche se met toute seule à l'envoi" })}
        ${champ("adresse", "Adresse du chantier <span style='font-weight:400'>(si connue · servira au plan d'accès)</span>", { cls: "two" })}
      </div>`, true)}
      ${bloc("2", "Client et intervenants", "client obligatoire", `<div class="ov-g">
        ${champ("client", "Client", { req: true })}
        <div class="ov-f"><label>Type de client</label><select data-k="typeClient">${["Entreprise générale", "Particulier", "Marché public"].map((t) => `<option ${f.typeClient === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        ${champ("contact", "Contact", { ph: "nom et téléphone" })}
        ${champ("moe", "Maître d'œuvre")}
        ${champ("be", "Bureau d'études structure")}
      </div>`)}
      ${bloc("3", "Prévu au devis", "oui / non", `<div class="ov-oo">
        ${sw("deblais", "Déblais / évacuation", f.deblais ? "à notre charge" : "non", '<span class="ov-lien x">→ fiche prépa</span>')}
        ${sw("recepage", "Recépage", f.recepage ? "oui" : "non")}
        ${sw("essai", "Essai de traction", f.essai ? "oui" : "non", `<span class="x"><input data-k="essaiNb" type="number" min="1" value="${esc(f.essaiNb)}" placeholder="nombre" style="width:90px"></span>`)}
        ${sw("bc", "Bureau de contrôle", f.bc ? "oui" : "non", `<span class="x"><input data-k="bcNom" value="${esc(f.bcNom)}" placeholder="nom"></span>`)}
        ${sw("g4", "Mission G4", "supervision géotechnique d'exécution")}
        ${sw("sondage", "Sondage complémentaire vendu", f.sondage ? "oui" : "non")}
        ${sw("implantation", "Implantation à notre charge", f.implantation ? "oui" : "sinon : à leur charge", '<span class="ov-lien x">→ fiche prépa</span>')}
      </div>`)}
      ${bloc("4", "Contraintes du site", "hauteur limitée, accès difficile", `<div class="ov-oo">
        ${sw("hauteur", "Hauteur disponible limitée", "choix de la machine (raccourcie)", `<span class="x"><input data-k="hauteurVal" value="${esc(f.hauteurVal)}" placeholder="ex. 3,20 m"></span>`)}
        ${sw("acces", "Accès difficile", f.acces ? "oui" : "non")}
      </div>`)}
      ${bloc("5", "Facturation", "montant vendu, date de facturation, acompte · jamais dans le mail", `<div class="ov-g">
        ${champ("montant", "Montant vendu HT (€)", { type: "number" })}
        ${champ("dateFact", "Date de facturation prévue", { type: "date" })}
        <div class="ov-f">${sw("acompte", "Acompte", f.acompte ? "oui" : "non", `<span class="x"><input data-k="acomptePct" value="${esc(f.acomptePct)}" placeholder="%" style="width:70px"></span>`)}</div>
      </div>`)}
      ${bloc("6", "Informations complémentaires et devis", "", `
        <div class="ov-f"><textarea data-k="infos" rows="5" placeholder="Ce que le conducteur doit savoir">${esc(f.infos)}</textarea></div>
        <div class="ov-f" style="margin-top:12px"><label>Devis signé <span style="font-weight:400">(PDF, facultatif · rangé avec la fiche d'affaire acquise, jamais visible des chefs)</span></label>
          <label class="ov-drop ${devis ? "ok" : ""}">${devis ? "✅ " + esc(devis.name) + " · clique pour changer" : "📎 Clique pour joindre le devis signé"}<input type="file" accept="application/pdf" id="ov_devis" hidden></label></div>`)}
      <div class="ov-foot"><div class="ov-f" style="flex:1;min-width:280px"><label>✉️ Prévenir par mail (sans aucun montant)</label><input data-k="destinataires" value="${esc(f.destinataires)}"></div>
        <button type="button" class="sv-btn pri" id="ov_ouvrir" ${enCours ? "disabled" : ""} style="${m.length ? "opacity:.5" : ""}">${enCours ? "⏳ " + esc(enCours) : "Ouvrir le chantier et prévenir"}</button></div>`;
  }

  function rendre() {
    if (!racine) return;
    styles();
    const tabs = `<div class="ov-tabs"><button type="button" data-t="nouveau" class="${onglet === "nouveau" ? "on" : ""}">📝 Nouvelle ouverture</button><button type="button" data-t="miens" class="${onglet === "miens" ? "on" : ""}">📂 Mes chantiers ouverts</button></div>`;
    racine.innerHTML = tabs + `<div id="ov_corps">${onglet === "miens" ? '<div class="ad-vide">Chargement…</div>' : dernier ? rendreResultat() : rendreForm()}</div>`;
    racine.querySelectorAll(".ov-tabs button").forEach((b) => (b.onclick = () => { onglet = b.dataset.t; rendre(); }));
    if (onglet === "miens") return rendreMiens();
    if (dernier) return brancherResultat();
    brancherForm();
  }

  function majProgres() {
    const m = manque(), vc = verifCode();
    const p = $("prog"); if (p) { p.textContent = m.length ? "il manque : " + m.join(", ") : "complet ✓"; p.style.color = m.length ? "#C0392B" : ""; }
    const b = $("bar"); if (b) b.style.width = Math.round(100 * (4 - m.length) / 4) + "%";
    const a = $("aide_code"); if (a) { a.textContent = vc.txt || "le code que tu donnes au chantier"; a.className = "ov-aide " + (vc.txt ? (vc.ok ? "ok" : "ko") : ""); }
    const o = $("ouvrir"); if (o) o.style.opacity = m.length ? .5 : 1;
    if (f.realMode === "semaine") { const s = semaine(f.realVal), r = $("aide_real"); if (r) r.textContent = s ? s.texte.replace(/^semaine \d+ /, "") : "numéro de semaine entre 1 et 53"; }
  }

  function brancherForm() {
    racine.querySelectorAll("[data-k]").forEach((el) => {
      el.addEventListener("input", () => {
        f[el.dataset.k] = el.value;
        if (["code", "nom"].includes(el.dataset.k)) { const p = el.selectionStart; el.value = el.value.toUpperCase(); f[el.dataset.k] = el.value; el.setSelectionRange(p, p); }
        majProgres();
      });
    });
    racine.querySelectorAll(".ov-bh").forEach((h) => (h.onclick = () => {
      const b = h.parentElement, n = b.dataset.b;
      b.classList.toggle("ferme"); if (b.classList.contains("ferme")) ouverts.delete(n); else ouverts.add(n);
      h.querySelector(".ch").textContent = b.classList.contains("ferme") ? "▸" : "▾";
    }));
    racine.querySelectorAll("[data-sw]").forEach((b) => (b.onclick = () => { f[b.dataset.sw] = !f[b.dataset.sw]; rendre(); }));
    racine.querySelectorAll("[data-tech]").forEach((b) => (b.onclick = () => {
      const t = b.dataset.tech;
      f.techs = f.techs.includes(t) ? f.techs.filter((x) => x !== t) : [...f.techs, t];
      rendre();
    }));
    racine.querySelectorAll("[data-real]").forEach((b) => (b.onclick = () => { f.realMode = b.dataset.real; f.realVal = ""; rendre(); }));
    $("devis").onchange = () => { devis = $("devis").files[0] || null; rendre(); };
    $("ouvrir").onclick = ouvrir;
  }

  // ─── Fiche d'affaire acquise (PDF) ─────────────────────────────────
  function chargerScript(src) {
    return new Promise((ok, ko) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => ko(new Error("Outil PDF introuvable : " + src)); document.head.appendChild(s); });
  }
  async function outilsPdf() {
    if (!window.jspdf) await chargerScript("../lib/jspdf/jspdf.umd.min.js");
    if (!window.html2canvas) await chargerScript("../lib/html2canvas/html2canvas.min.js");
  }
  function htmlFiche(x, emiseLe) {
    const ck = (v) => `<span class="ck">${v ? "X" : ""}</span>`;
    const on = (v, txt) => (v ? `<td class="oui">${ck(1)}${txt || "Oui"}</td>` : `<td class="non">${ck(0)}Non</td>`);
    const s = x.realMode === "semaine" ? semaine(x.realVal) : null;
    const real = x.realMode === "date" && x.realVal ? frJ(x.realVal) : s ? `<b>Semaine ${esc(x.realVal)}</b> <span style="font-size:8pt;color:#444">(du ${s.lundi.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} au ${fr(s.vendredi)})</span>` : "À définir";
    const montant = nombre(x.montant) ? nombre(x.montant).toLocaleString("fr-FR", { maximumFractionDigits: 2 }) + " €" : "—";
    return `
      <table><colgroup><col style="width:26%"><col style="width:50%"><col style="width:24%"></colgroup><tr>
        <td rowspan="2" style="text-align:center"><img src="../assets/logo-fts.png" style="height:20mm"></td>
        <td rowspan="2" style="text-align:center;font-weight:bold"><div style="font-size:19pt">FICHE D'AFFAIRE ACQUISE</div><div style="font-size:9pt;color:#444;font-weight:normal;margin-top:1mm">document interne · ouverture du dossier</div></td>
        <td class="g" style="text-align:center">N° DOSSIER</td></tr><tr><td style="text-align:center;font-size:15pt;font-weight:bold">${esc(codeNorm(x.code))}</td></tr></table>
      <table><colgroup><col style="width:22%"><col style="width:28%"><col style="width:22%"><col style="width:28%"></colgroup>
        <tr><td class="g">DEVIS SIGNÉ LE</td><td>${esc(frJ(x.devisLe) || "—")}</td><td class="g">CHARGÉ D'AFFAIRES</td><td><b>${esc(moiNom() || moiEmail())}</b></td></tr>
        <tr><td class="g">FICHE ÉMISE LE</td><td colspan="3">${esc(fr(emiseLe))}</td></tr></table>
      <table><colgroup><col style="width:22%"><col style="width:28%"><col style="width:22%"><col style="width:28%"></colgroup>
        <tr><td class="t" colspan="4">LE CHANTIER</td></tr>
        <tr><td class="g">CHANTIER</td><td colspan="3"><b>${esc(x.nom)}</b></td></tr>
        <tr><td class="g">ADRESSE</td><td colspan="3">${esc(x.adresse || "—")}</td></tr>
        <tr><td class="g">TECHNIQUE</td><td colspan="3" style="white-space:nowrap">${TECHS.map((t) => `${ck(techsDe(x).includes(t))}${t}`).join("&nbsp;&nbsp;&nbsp;&nbsp;")}</td></tr>
        <tr><td class="g">NOMBRE</td><td><b>${techsDe(x).map((t) => `${nbDe(x, t)} ${libNb(t)}`).join("<br>")}</b></td><td class="g">RÉALISATION PRÉVUE</td><td>${real}</td></tr>
        <tr><td class="g">DURÉE DE CHANTIER PRÉVUE</td><td colspan="3">${esc(x.duree || "—")}</td></tr></table>
      <table><colgroup><col style="width:22%"><col style="width:28%"><col style="width:22%"><col style="width:28%"></colgroup>
        <tr><td class="t" colspan="4">CLIENT ET INTERVENANTS</td></tr>
        <tr><td class="g">CLIENT</td><td><b>${esc(x.client)}</b></td><td class="g">TYPE DE CLIENT</td><td>${esc(x.typeClient)}</td></tr>
        <tr><td class="g">CONTACT</td><td colspan="3">${esc(x.contact || "—")}</td></tr>
        <tr><td class="g">MAÎTRE D'ŒUVRE</td><td>${esc(x.moe || "—")}</td><td class="g">BUREAU D'ÉTUDES</td><td>${esc(x.be || "—")}</td></tr>
        <tr><td class="g">BUREAU DE CONTRÔLE</td><td>${x.bc ? esc(x.bcNom || "Oui") : '<span class="non">Non</span>'}</td><td class="g">MISSION G4</td>${x.g4 ? '<td class="oui">Oui</td>' : '<td class="non">Non</td>'}</tr></table>
      <div class="g2">
        <table><colgroup><col style="width:62%"><col style="width:38%"></colgroup><tr><td class="t" colspan="2">PRÉVU AU DEVIS</td></tr>
          <tr><td>Déblais / évacuation</td>${on(x.deblais)}</tr><tr><td>Recépage</td>${on(x.recepage)}</tr>
          <tr><td>Essai de traction</td>${on(x.essai, "Oui" + (x.essaiNb ? ` · ${esc(x.essaiNb)} essai(s)` : ""))}</tr>
          <tr><td>Sondage complémentaire</td>${on(x.sondage)}</tr><tr><td>Implantation</td><td class="oui">${x.implantation ? "À notre charge" : "À leur charge"}</td></tr></table>
        <div style="display:flex;flex-direction:column;gap:3.2mm">
          <table><colgroup><col style="width:52%"><col style="width:48%"></colgroup><tr><td class="t" colspan="2">CONTRAINTES DU SITE</td></tr>
            <tr><td>Hauteur disponible limitée</td>${on(x.hauteur, esc(x.hauteurVal || "Oui"))}</tr><tr><td>Accès difficile</td>${on(x.acces)}</tr></table>
          <table><colgroup><col style="width:52%"><col style="width:48%"></colgroup><tr><td class="t" colspan="2">FACTURATION</td></tr>
            <tr><td>Montant vendu HT</td><td style="font-size:15pt;font-weight:bold;white-space:nowrap">${montant}</td></tr>
            <tr><td>Date de facturation prévue</td><td>${esc(frJ(x.dateFact) || "—")}</td></tr>
            <tr><td>Acompte</td>${on(x.acompte, "Oui" + (x.acomptePct ? ` · ${esc(String(x.acomptePct).replace(/\s*%?$/, ""))} %` : ""))}</tr></table>
        </div></div>
      <table><tr><td class="t">INFORMATIONS COMPLÉMENTAIRES</td></tr><tr><td class="note">${esc(x.infos).replace(/\n/g, "<br>")}</td></tr></table>
      <table class="sig"><colgroup><col style="width:50%"><col style="width:50%"></colgroup>
        <tr><td class="g" style="height:auto">CHARGÉ D'AFFAIRES</td><td class="g" style="height:auto">CONDUCTEUR DE TRAVAUX ATTRIBUÉ</td></tr>
        <tr><td>${esc(moiNom() || moiEmail())}<br>le ${esc(fr(emiseLe))}<br>Visa :</td><td>Nom :<br>Le :<br>Visa :</td></tr></table>
      <div class="pied"><span>FTS - Fondations et Travaux Spéciaux · fiche générée par la Supervision le ${esc(fr(emiseLe))}</span><span>${esc(codeNorm(x.code))} · page 1/1</span></div>`;
  }
  async function pdfFiche(x, emiseLe) {
    await outilsPdf();
    const zone = document.createElement("div");
    zone.className = "ov-fiche";
    zone.innerHTML = htmlFiche(x, emiseLe);
    document.body.appendChild(zone);
    try {
      await Promise.all([...zone.querySelectorAll("img")].map((im) => (im.complete ? null : new Promise((ok) => { im.onload = im.onerror = ok; }))));
      const canvas = await html2canvas(zone, { scale: 2, backgroundColor: "#fff" });
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
      doc.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, 210, 297);
      doc.setProperties({ title: `${codeNorm(x.code)} - Fiche d'affaire acquise` });
      return doc.output("blob");
    } finally { zone.remove(); }
  }

  // ─── Mail ──────────────────────────────────────────────────────────
  function texteMail(x, liens) {
    const oui = [];
    if (x.deblais) oui.push("déblais / évacuation");
    if (x.recepage) oui.push("recépage");
    if (x.essai) oui.push("essai de traction" + (x.essaiNb ? ` (${x.essaiNb})` : ""));
    if (x.bc) oui.push("bureau de contrôle" + (x.bcNom ? ` (${x.bcNom})` : ""));
    if (x.g4) oui.push("mission G4");
    if (x.sondage) oui.push("sondage complémentaire");
    oui.push(x.implantation ? "implantation à notre charge" : "implantation à leur charge");
    const ctr = [];
    if (x.hauteur) ctr.push("hauteur limitée" + (x.hauteurVal ? ` (${x.hauteurVal})` : ""));
    if (x.acces) ctr.push("accès difficile");
    const l = [`Bonjour à tous,`, ``, `Nouveau chantier signé :`, `Chantier : ${codeNorm(x.code)} ${x.nom}`, `Client : ${x.client}`, ...techsDe(x).map((t) => `${t} : ${nbDe(x, t)} ${libNb(t)}`),
      `Réalisation prévue : ${texteRealisation(x)}${x.duree ? ` · durée de chantier prévue : ${x.duree}` : ""}`];
    if (x.adresse) l.push(`Adresse : ${x.adresse}`);
    if (x.contact) l.push(`Contact : ${x.contact}`);
    l.push(``, `Prévu au devis : ${oui.join(", ")}`);
    if (ctr.length) l.push(`Contraintes : ${ctr.join(", ")}`);
    if (x.infos.trim()) l.push(`Infos : ${x.infos.trim()}`);
    l.push(``, `Le chantier est créé dans la Supervision.`);
    if (liens.fiche) l.push(`Fiche d'affaire acquise : ${liens.fiche}`);
    if (liens.devis) l.push(`Devis signé : ${liens.devis}`);
    l.push(``, `Bonne journée,`, moiNom() || "");
    return l.join("\n");
  }

  // ─── Ouverture ─────────────────────────────────────────────────────
  async function ouvrir() {
    if (enCours) return;
    const m = manque();
    if (m.length) { FTSShell && FTSShell.toast ? FTSShell.toast("Il manque : " + m.join(", ")) : alert("Il manque : " + m.join(", ")); return; }
    const dest = adresses(f.destinataires);
    const x = { ...f, code: codeNorm(f.code), nom: f.nom.trim(), client: f.client.trim() };
    if (!confirm(`Ouvrir le chantier ${x.code} ${x.nom} ?\n\nLe chantier sera créé dans la Supervision${dest.length ? `, puis ${dest.length} personne(s) seront prévenues par mail` : ""}.`)) return;
    try { localStorage.setItem(CLE_DEST, f.destinataires); } catch (e) {}
    const etape = (t) => { enCours = t; const b = $("ouvrir"); if (b) { b.disabled = true; b.textContent = "⏳ " + t; } };
    const emiseLe = new Date();
    const faits = [];
    try {
      // Dernière vérification du code (un collègue a pu le prendre entre-temps)
      etape("Vérification du code…"); await chargerCodes();
      if (!verifCode().ok) throw new Error(verifCode().txt || "Code chantier incorrect");
      etape("Création du chantier…");
      const techs = techsDe(x);
      const n = (t) => (techs.includes(t) ? String(nbDe(x, t)) : "");
      const r = await FTSDrive.creerArborescenceChantier({
        // technique principale (pages qui ne lisent qu'un type), comme « + Nouveau chantier »
        numAffaire: x.code, nom: x.nom, typeChantier: techs.includes("Micropieux") ? "Micropieux" : techs.includes("Battage") ? "Battage" : "Pieux", techniques: techs,
        adresse: x.adresse.trim().toUpperCase(),
        micropieuxPrevus: n("Micropieux"), pieuxPrevus: n("Pieux"), battagePrevus: n("Battage"),
        dureeChantier: nombre(x.duree) ? String(nombre(x.duree)) : "", montantVendu: nombre(x.montant) ? String(nombre(x.montant)) : "",
      });
      faits.push(`Chantier « ${r.chantierName} » créé dans la Supervision (en « À faire » dans Préparation, marqué NOUVEAU)`);
      etape("Fiche d'affaire acquise…");
      const ref = await FTSDrive.findOrCreateFolder("REFERENTIEL", null);
      const dossier = await FTSDrive.findOrCreateFolder(DOSSIER, ref);
      const pdf = await pdfFiche(x, emiseLe);
      const fFiche = await FTSDrive.uploadFile(pdf, `${x.code}_Fiche-affaire-acquise.pdf`, "application/pdf", dossier, { remplacerSiExiste: true });
      faits.push("Fiche d'affaire acquise (PDF) rangée dans REFERENTIEL › AFFAIRES ACQUISES");
      let fDevis = null;
      if (devis) { etape("Devis signé…"); fDevis = await FTSDrive.uploadFile(devis, `${x.code}_Devis-signe.pdf`, "application/pdf", dossier, { remplacerSiExiste: true }); faits.push("Devis signé rangé avec la fiche"); }
      const detail = { version: 1, emiseLe: emiseLe.toISOString(), par: moiNom(), parEmail: moiEmail(), ...x, devis: fDevis ? fDevis.id : null, destinataires: dest };
      await FTSDrive.uploadFile(new Blob([JSON.stringify(detail, null, 1)], { type: "application/json" }), `${x.code}_ouverture.json`, "application/json", dossier, { remplacerSiExiste: true });
      // Ce qui sert aux conducteurs (sans facturation) sur le dossier du chantier
      etape("Infos pour la préparation…");
      const meta = await FTSDrive.getMetadonneesChantier(r.chantierId);
      const s = x.realMode === "semaine" ? semaine(x.realVal) : null;
      meta.ouverture = {
        le: emiseLe.toISOString(), par: moiNom(), parEmail: moiEmail(), devisLe: x.devisLe || "", ficheId: fFiche.id, ficheLien: fFiche.webViewLink || "",
        realisation: { mode: x.realMode, valeur: x.realVal || "", texte: texteRealisation(x), lundi: s ? s.lundi.toISOString().slice(0, 10) : "" },
        client: x.client, typeClient: x.typeClient, contact: x.contact, moe: x.moe, be: x.be,
        prevu: { deblais: x.deblais, recepage: x.recepage, essai: x.essai, essaiNb: nombre(x.essaiNb) || 0, bc: x.bc, bcNom: x.bc ? x.bcNom : "", g4: x.g4, sondage: x.sondage, implantation: x.implantation },
        contraintes: { hauteur: x.hauteur, hauteurVal: x.hauteur ? x.hauteurVal : "", acces: x.acces }, infos: x.infos,
      };
      await FTSDrive.setMetadonneesChantier(r.chantierId, meta);
      // Mail
      const objet = `Nouveau chantier signé - ${x.code} ${x.nom}`;
      const liens = { fiche: fFiche.webViewLink || "", devis: fDevis ? fDevis.webViewLink || "" : "" };
      const corps = texteMail(x, liens);
      let mail = { objet, corps, dest, mode: FTSMail.mode(moiEmail() || null), envoye: false };
      if (dest.length && mail.mode === "gmail" && window.FTSGmail) {
        etape("Envoi du mail…");
        const pj = [{ blob: pdf, fileName: `${x.code}_Fiche-affaire-acquise.pdf`, mimeType: "application/pdf" }];
        try { await FTSGmail.envoyer({ to: dest, subject: objet, body: corps.replace(/\nFiche d'affaire acquise : .*|\nDevis signé : .*/g, "") + "\n(fiche d'affaire acquise en pièce jointe)", attachments: pj }); mail.envoye = true; faits.push(`Mail envoyé à ${dest.length} personne(s), fiche en pièce jointe`); }
        catch (e) { mail.erreur = e.message; faits.push("⚠️ Mail non envoyé : " + e.message); }
      }
      dernier = { x, r, pdf, fFiche, fDevis, faits, mail };
      if (opts.apresCreation) try { opts.apresCreation(); } catch (e) {}
    } catch (e) {
      console.error("Ouverture de chantier :", e);
      alert("L'ouverture n'est pas allée au bout : " + e.message + (faits.length ? "\n\nDéjà fait :\n- " + faits.join("\n- ") : "\n\nRien n'a été créé."));
      enCours = false; rendre(); return;
    }
    enCours = false;
    rendre();
    // Compte sans Gmail : mail Outlook pré-rempli (liens Drive, pas de pièce jointe à glisser)
    if (dernier.mail.dest.length && dernier.mail.mode === "outlook") ouvrirOutlook();
  }
  function ouvrirOutlook() {
    const m = dernier.mail;
    FTSMail.ouvrirOutlook({ to: m.dest, subject: m.objet, body: m.corps });
    m.ouvert = true;
  }

  function rendreResultat() {
    const d = dernier, m = d.mail;
    const etatMail = !m.dest.length ? "Personne à prévenir (aucun destinataire)." : m.mode === "gmail" ? (m.envoye ? "✅ Mail envoyé." : "⚠️ Mail non envoyé.") : "📧 Le mail s'est ouvert dans Outlook, depuis ton adresse pro : vérifie-le et clique sur Envoyer.";
    return `<div class="ov-res"><h2>✅ Chantier ${esc(d.x.code)} ouvert</h2><ul>${d.faits.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <div class="ad-info" style="margin-bottom:10px">${esc(etatMail)}</div>
      <pre><b>Objet : ${esc(m.objet)}</b>\n\n${esc(m.corps)}</pre>
      <div class="ov-act"><button type="button" class="sv-btn pri" id="ov_imprimer">🖨️ Imprimer la fiche d'affaire acquise</button>
        ${m.dest.length && m.mode === "outlook" ? '<button type="button" class="sv-btn" id="ov_rouvrir">📧 Rouvrir le mail</button>' : ""}
        <button type="button" class="sv-btn" id="ov_nouvelle">📝 Nouvelle ouverture</button></div></div>`;
  }
  function brancherResultat() {
    $("imprimer").onclick = () => { const u = URL.createObjectURL(dernier.pdf); const w = window.open(u, "_blank"); if (!w) location.href = u; };
    const ro = $("rouvrir"); if (ro) ro.onclick = ouvrirOutlook;
    $("nouvelle").onclick = () => { dernier = null; f = vierge(); f.destinataires = destinatairesDefaut(); devis = null; codesExistants = null; chargerCodes().then(majProgres); rendre(); };
  }

  async function rendreMiens() {
    const corps = racine.querySelector("#ov_corps");
    let d = null;
    try { d = opts.obtenirDonnees ? await opts.obtenirDonnees(false) : null; } catch (e) {}
    const moi = FTSModules.mail(moiEmail());
    const tous = FTSModules.etat() && FTSModules.etat().statut === "proprio";
    const l = ((d && d.chantiers) || []).filter((c) => c.meta && c.meta.ouverture && (tous || FTSModules.mail(c.meta.ouverture.parEmail) === moi))
      .sort((a, b) => String(b.meta.ouverture.le).localeCompare(String(a.meta.ouverture.le)));
    if (onglet !== "miens") return;
    const ETATS = { encours: "En cours", envoyee: "Envoyée", modifiee: "Modifiée après envoi" };
    corps.innerHTML = `<div class="se-panel"><div class="ad-h"><h2>${tous ? "Chantiers ouverts par les chargés d'affaires" : "Mes chantiers ouverts"}</h2><span class="s">chantiers en cours (les archivés n'apparaissent pas)</span></div>
      ${l.length ? `<div style="overflow:auto"><table class="ad-t"><thead><tr><th style="padding-left:20px">Chantier</th><th>Ouvert le</th>${tous ? "<th>Par</th>" : ""}<th>Réalisation prévue</th><th>Conducteur</th><th>Préparation</th><th></th></tr></thead><tbody>
        ${l.map((c) => { const o = c.meta.ouverture, p = c.meta.preparation; return `<tr><td style="padding-left:20px"><b>${esc(c.name)}</b></td><td>${esc(new Date(o.le).toLocaleDateString("fr-FR"))}</td>${tous ? `<td>${esc(o.par || o.parEmail)}</td>` : ""}<td>${esc((o.realisation && o.realisation.texte) || "")}</td><td>${esc(c.meta.conducteur || "pas encore attribué")}</td><td>${p ? esc(ETATS[p.etat] || "En cours") : "À faire"}</td><td>${o.ficheLien ? `<a class="ad-btn" style="text-decoration:none;color:inherit" href="${esc(o.ficheLien)}" target="_blank" rel="noopener">Fiche</a>` : ""}</td></tr>`; }).join("")}
      </tbody></table></div>` : '<div class="ad-vide">Aucun chantier ouvert pour l\'instant.</div>'}</div>`;
  }

  async function monter(conteneur, o = {}) {
    racine = conteneur; opts = o;
    if (!f) { f = vierge(); }
    if (!f.destinataires) { await FTSPersonnel.charger({ rapide: true }).catch(() => null); f.destinataires = destinatairesDefaut(); }
    rendre();
    if (!codesExistants) chargerCodes().then(() => { if (!dernier && onglet === "nouveau") majProgres(); });
  }

  return { monter, htmlFiche, texteMail, semaine };
})();
if (typeof window !== "undefined") window.FTSOuverture = FTSOuverture;
