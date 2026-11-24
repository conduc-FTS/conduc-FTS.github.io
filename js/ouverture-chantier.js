/**
 * ouverture-chantier.js — OUVERTURE DE CHANTIER + fiche d'affaire acquise.
 *
 * Depuis le 24/11/2026, c'est la SEULE façon de créer un chantier (l'ancienne
 * fenêtre « + Nouveau chantier » est supprimée) : chargés d'affaires, Marielle,
 * conducteurs, direction. Formulaire v2 calqué sur la fiche d'affaire acquise
 * papier (marché, DICT, intervenants avec téléphones, tableau technique,
 * planning, documents transmis, prix de vente).
 *
 * Ce qui est créé :
 *  1. le chantier (FTSDrive.creerArborescenceChantier) ; conducteur attribué si choisi ;
 *  2. meta.ouverture sur le dossier du chantier (sans facturation) → la fiche de
 *     préparation se pré-remplit, la liste Préparation affiche « NOUVEAU » ;
 *  3. dans REFERENTIEL › AFFAIRES ACQUISES (encadrement seulement, jamais les chefs) :
 *     la fiche d'affaire acquise (PDF, prix compris), le devis signé s'il est joint,
 *     et le détail complet (JSON) ;
 *  4. SEULEMENT si « Prévenir par mail » est coché : le mail d'information (texte
 *     sans montant, fiche en pièce jointe — la fiche contient le prix, validé par
 *     Clément le 24/11/2026 : les destinataires sont l'encadrement).
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

  const INTER = [
    ["client", "Client", true], ["contact", "Contact chantier"], ["moa", "Maître d'ouvrage"], ["moe", "Maître d'œuvre"],
    ["be", "Bureau d'études béton"], ["bc", "Bureau de contrôle"], ["sps", "Coordonnateur SPS"], ["geo", "Géotechnicien"],
  ];
  const carteVide = () => ({ soc: "", nom: "", tel: "", mail: "" });
  function vierge() {
    const inter = {}; INTER.forEach(([k]) => (inter[k] = carteVide()));
    inter.contact.idem = true; inter.geo.g4 = false;
    return {
      code: "", nom: "", responsable: moiNom(), adresse: "", cp: "", ville: "", marche: "Bâtiment", contrat: "Sous-traitance", paiement: "Client", dict: true, conducteur: "",
      techs: ["Micropieux"], typeTech: "", lignes: [{ tech: "Micropieux", nb: "", diam: "250", long: "", arm: "" }],
      inter,
      deblais: false, recepage: false, gainage: false, traction: false, essai: false, essaiNb: "", essaiMotif: "", sondage: false, implantation: true,
      hauteur: false, hauteurVal: "", acces: false,
      realMode: "adefinir", realVal: "", precision: "", duree: "", dateNdc: "",
      plan: "", sol: "", devisNo: "", devisLe: "",
      montant: "", dateFact: "", acompte: false, acomptePct: "",
      infos: "", prevenir: false, destinataires: "",
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
.ov-fiche{position:fixed;left:-10000px;top:0;width:210mm;height:297mm;background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif;font-size:9pt;line-height:1.3;padding:11mm 12mm;box-sizing:border-box;display:flex;flex-direction:column}
.ov-fiche .ent{display:flex;align-items:center;gap:6mm;border-bottom:.6mm solid #111;padding-bottom:3mm}.ov-fiche .ent img{height:17mm}
.ov-fiche .titre{flex:1;text-align:center;font-size:17pt;font-weight:bold;letter-spacing:.04em}.ov-fiche .code{background:#FDCA01;font-weight:bold;font-size:16pt;padding:1.5mm 4mm;border-radius:1mm;white-space:nowrap}
.ov-fiche .meta{display:flex;justify-content:space-between;font-size:8.2pt;color:#333;margin:2mm 0 1mm}
.ov-fiche .sec{margin-top:3mm}.ov-fiche h3{margin:0 0 1.6mm;background:#1F2228;color:#fff;font-size:8.6pt;padding:1mm 2.2mm;letter-spacing:.06em}
.ov-fiche .g2{display:grid;grid-template-columns:1fr 1fr;gap:1.3mm 6mm}.ov-fiche .g4{display:grid;grid-template-columns:repeat(4,1fr);gap:1.6mm}
.ov-fiche .kv{display:flex;gap:2mm}.ov-fiche .kv i{font-style:normal;color:#555;min-width:23mm;flex:none}
.ov-fiche .carte{border:.3mm solid #bbb;border-radius:.8mm;padding:1.3mm 1.8mm;min-height:15mm;font-size:8.2pt}.ov-fiche .carte i{display:block;font-style:normal;font-size:6.8pt;color:#555;font-weight:bold;letter-spacing:.04em;margin-bottom:.6mm}
.ov-fiche .tt{width:100%;border-collapse:collapse;margin-bottom:1.8mm}.ov-fiche .tt th,.ov-fiche .tt td{border:.3mm solid #999;padding:1mm 2mm;text-align:center}.ov-fiche .tt th{background:#E9EBEF;font-size:8.2pt}
.ov-fiche .opts{display:grid;grid-template-columns:repeat(4,1fr);gap:1mm 4mm;font-size:8.4pt}.ov-fiche .oui{font-weight:bold}.ov-fiche .non{color:#888}
.ov-fiche .vide{color:#999}.ov-fiche .infos{min-height:12mm;font-size:8.6pt}
.ov-fiche .prix{margin-top:4mm;border:.6mm solid #111;padding:2mm 3mm;display:flex;justify-content:space-between;font-size:12pt;font-weight:bold}.ov-fiche .fact{font-size:8.2pt;color:#333;margin-top:1mm;text-align:right}
.ov-fiche .pied{margin-top:auto;font-size:7pt;color:#666;display:flex;justify-content:space-between;border-top:.2mm solid #999;padding-top:1.5mm}
.ov-f{min-width:0}.ov-f label{font-size:.86rem;font-weight:700;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px}
.ov-g4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px 16px;align-items:start}.ov-g4 .two{grid-column:span 2}.ov-g4 .full{grid-column:1/-1}
@media(max-width:1100px){.ov-g4{grid-template-columns:repeat(2,minmax(0,1fr))}}
.ov-f input,.ov-f select{height:40px}.ov-f .ov-chips{min-height:40px;align-items:center}
.ov-st{font-size:.7rem;font-weight:800;color:var(--text-sub);letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid #eee;padding-bottom:5px;margin:6px 0 10px}.ov-st .ov-tot{text-transform:none;letter-spacing:0}
.ov-it{display:grid;grid-template-columns:190px minmax(0,1.3fr) minmax(0,1fr) 150px minmax(0,1.1fr);gap:8px 10px;align-items:center}
.ov-it .h{font-size:.84rem;font-weight:700;color:var(--text-main)}.ov-it .r{font-size:.86rem;font-weight:700;display:flex;align-items:center;gap:6px;min-height:40px}.ov-it .r i{color:#C0392B;font-style:normal}
.ov-it input{width:100%;box-sizing:border-box;height:40px;border:1px solid #d6d9de;border-radius:9px;padding:8px 11px;font:inherit;font-size:.9rem}.ov-it input:disabled{background:#F4F5F7;color:#9aa0aa}
.ov-it .idem{grid-column:2/-1;font-size:.84rem;display:flex;align-items:center;gap:8px;min-height:40px}
.ov-it .g4{font-size:.75rem;font-weight:700;display:flex;align-items:center;gap:4px;white-space:nowrap}
.ov-tt{width:100%;border-collapse:separate;border-spacing:0 6px}.ov-tt th{font-size:.84rem;font-weight:700;text-align:left;padding:0 6px}
.ov-tt td{padding:0 6px}.ov-tt input,.ov-tt select{width:100%;box-sizing:border-box;height:40px;border:1px solid #d6d9de;border-radius:9px;padding:8px 10px;font:inherit;font-size:.9rem}
.ov-tt .x{width:40px}.ov-tt .x button{border:0;background:#F4F5F7;border-radius:8px;width:36px;height:36px;cursor:pointer}
.ov-tot{font-weight:800;color:#1D6E3E;font-size:.86rem}
.ov-calc{height:40px;display:flex;align-items:center;border:1px dashed #d6d9de;border-radius:9px;padding:0 11px;color:var(--text-sub);font-size:.88rem;background:#FAFBFC}
.ov-mail{display:flex;align-items:center;gap:10px;font-weight:700;font-size:.9rem;cursor:pointer}.ov-mail input{width:18px;height:18px;accent-color:#1d1d1f}
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
    let t = "à définir";
    if (x.realMode === "date" && x.realVal) t = frJ(x.realVal);
    if (x.realMode === "semaine") { const s = semaine(x.realVal); if (s) t = s.texte; }
    return x.precision && x.precision.trim() ? (t === "à définir" ? x.precision.trim() : `${t} (${x.precision.trim()})`) : t;
  }
  const libNb = (t) => (t === "Micropieux" ? "micropieux" : t === "Pieux" ? "pieux" : "pieux battus");
  const TECHS = ["Micropieux", "Pieux", "Battage"];
  // Chantier mixte possible : une ou plusieurs techniques, un nombre pour chacune
  const techsDe = (x) => TECHS.filter((t) => (x.techs || []).includes(t));
  // Nombre d'une technique = somme des lignes du tableau technique (une seule technique : toutes les lignes)
  const lignesDe = (x, t) => (x.lignes || []).filter((l) => (techsDe(x).length > 1 ? l.tech === t : true));
  const nbDe = (x, t) => lignesDe(x, t).reduce((a, l) => a + nombre(l.nb), 0);
  const adresseComplete = (x) => [x.adresse.trim(), [x.cp.trim(), x.ville.trim()].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  /** Date de fin : démarrage + durée en jours ouvrés (lundi-vendredi), seulement si la date est connue */
  function dateFin(x) {
    const n = Math.round(nombre(x.duree));
    if (x.realMode !== "date" || !x.realVal || !n) return "";
    const d = new Date(x.realVal + "T00:00:00"); let k = 1;
    while (k < n) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) k++; }
    return fr(d);
  }
  /** Personnes de l'encadrement (responsable, conducteur) */
  function listeEnc(filtre) {
    try { return [...new Set(FTSPersonnel.encadrement().filter((p) => !filtre || filtre.test(`${p.poste || ""} ${p.fonctionEnc || ""}`.toUpperCase())).map(FTSPersonnel.nomComplet))].sort(); }
    catch (e) { return []; }
  }
  const CONDUCTEURS = /CONDUCTEUR|DIRECT\w* TRAVAUX/;
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
    if (!f.ville.trim()) m.push("ville");
    if (!f.inter.client.soc.trim()) m.push("client");
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
  const champ = (k, lib, o = {}) => `<div class="ov-f ${o.cls || ""}"><label title="${esc(String(lib).replace(/<[^>]+>/g, ""))}">${lib}${o.req ? " <i>*</i>" : ""}</label><input data-k="${k}" value="${esc(f[k])}" ${o.type ? `type="${o.type}"` : ""} placeholder="${esc(o.ph || "")}">${o.aide ? `<div class="ov-aide ${o.aideCls || ""}" id="ov_aide_${k}">${o.aide}</div>` : ""}</div>`;
  const choix = (k, lib, valeurs) => `<div class="ov-f"><label>${lib}</label><div class="ov-chips petit">${valeurs.map((v) => `<button type="button" class="ov-chip ${String(f[k]) === String(v[0]) ? "on" : ""}" data-ch="${k}" data-v="${esc(v[0])}">${esc(v[1])}</button>`).join("")}</div></div>`;
  const liste = (k, lib, noms, vide) => {
    const l = noms.slice(); if (f[k] && !l.includes(f[k])) l.unshift(f[k]);
    return `<div class="ov-f"><label>${lib}</label><select data-k="${k}"><option value="">${vide}</option>${l.map((n) => `<option ${n === f[k] ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div>`;
  };
  const ouverts = new Set(["1", "2", "3", "4"]);
  const bloc = (n, titre, sous, corps, req) => `<div class="ov-blk ${ouverts.has(n) ? "" : "ferme"}" data-b="${n}"><div class="ov-bh"><span class="num">${n}</span>${titre}${req ? '<span class="req">obligatoire</span>' : ""}<span class="s">${sous || ""}</span><span class="ch">${ouverts.has(n) ? "▾" : "▸"}</span></div><div class="ov-bb">${corps}</div></div>`;

  function blocIntervenants() {
    const ligne = ([k, lib, req]) => {
      const c = f.inter[k];
      const tete = `<div class="r">${lib}${req ? " <i>*</i>" : ""}${k === "geo" ? `<label class="g4"><input type="checkbox" data-g4 ${c.g4 ? "checked" : ""}> G4</label>` : ""}</div>`;
      if (k === "contact" && c.idem) return tete + `<div class="idem"><label class="ov-mail" style="font-weight:600"><input type="checkbox" data-idem checked> idem client</label></div>`;
      return tete + ["soc", "nom", "tel", "mail"].map((ch) => `<input data-it="${k}.${ch}" value="${esc(c[ch])}" ${ch === "tel" ? 'inputmode="tel"' : ch === "mail" ? 'type="email"' : ""} placeholder="${k === "contact" && ch === "soc" ? "décocher « idem client » pour remplir" : ""}">`).join("")
        + (k === "contact" ? "" : "");
    };
    return `<div class="ov-it"><span></span><span class="h">Société</span><span class="h">Interlocuteur</span><span class="h">Téléphone</span><span class="h">E-mail</span>
      ${INTER.map((d) => d[0] === "contact" && !f.inter.contact.idem ? ligne(d) + "" : ligne(d)).join("")}</div>
      ${!f.inter.contact.idem ? `<div style="margin-top:6px"><label class="ov-mail" style="font-weight:600"><input type="checkbox" data-idem> contact chantier = idem client</label></div>` : ""}`;
  }

  function blocTechnique() {
    const multi = techsDe(f).length > 1;
    const tot = techsDe(f).map((t) => `${nbDe(f, t)} ${libNb(t)}`).join(" + ");
    return `<div class="ov-st">Techniques</div>
      <div class="ov-g4" style="margin-bottom:12px">
        <div class="ov-f two"><label>Technique(s) <i>*</i> · plusieurs possibles pour un chantier mixte</label><div class="ov-chips">${TECHS.map((t) => `<button type="button" class="ov-chip ${f.techs.includes(t) ? "on" : ""}" data-tech="${t}">${t}</button>`).join("")}</div></div>
        ${champ("typeTech", "Type", { cls: "two", ph: "ex. MICROPIEU TYPE III IGU" })}
      </div>
      <div class="ov-st">Quantités prévues au devis <span class="ov-tot" id="ov_tot">${tot ? "· total : " + esc(tot) : ""}</span></div>
      <table class="ov-tt"><thead><tr>${multi ? "<th>Technique</th>" : ""}<th>Nombre <i style="color:#C0392B;font-style:normal">*</i></th><th>Ø forage (mm)</th><th>Longueur max (m)</th><th>Armature</th><th class="x"></th></tr></thead><tbody>
        ${f.lignes.map((l, i) => `<tr>${multi ? `<td><select data-l="${i}.tech">${techsDe(f).map((t) => `<option ${l.tech === t ? "selected" : ""}>${t}</option>`).join("")}</select></td>` : ""}
          <td><input data-l="${i}.nb" value="${esc(l.nb)}" inputmode="numeric" placeholder="ex. 6"></td><td><input data-l="${i}.diam" value="${esc(l.diam)}" inputmode="numeric"></td>
          <td><input data-l="${i}.long" value="${esc(l.long)}" inputmode="decimal" placeholder="ex. 14,50"></td><td><input data-l="${i}.arm" value="${esc(l.arm)}" placeholder="ex. 88,9"></td>
          <td class="x">${f.lignes.length > 1 ? `<button type="button" data-suppr="${i}" title="Supprimer la ligne">✕</button>` : ""}</td></tr>`).join("")}
      </tbody></table>
      <button type="button" class="sv-btn" id="ov_ligne" style="margin:2px 0 14px">+ Ajouter une ligne</button>
      <div class="ov-st">Prévu au devis</div>
      <div class="ov-oo">
        ${sw("implantation", "Implantation à notre charge", f.implantation ? "oui" : "sinon : à leur charge", '<span class="ov-lien x">→ fiche prépa</span>')}
        ${sw("deblais", "Déblais / évacuation", f.deblais ? "à notre charge" : "non", '<span class="ov-lien x">→ fiche prépa</span>')}
        ${sw("gainage", "Gainage", f.gainage ? "oui" : "non")}
        ${sw("traction", "Micropieux travaillant en traction", f.traction ? "oui" : "non")}
        ${sw("essai", "Essai de traction", f.essai ? "oui" : "non", `<span class="x" style="display:flex;gap:6px"><input data-k="essaiNb" type="number" min="1" value="${esc(f.essaiNb)}" placeholder="nombre" style="width:80px"><input data-k="essaiMotif" value="${esc(f.essaiMotif)}" placeholder="motif (ex. DDC lourdes)" style="width:170px"></span>`)}
        ${sw("recepage", "Recépage", f.recepage ? "oui" : "non")}
        ${sw("sondage", "Sondage complémentaire vendu", f.sondage ? "oui" : "non")}
      </div>`;
  }

  function rendreForm() {
    const vc = verifCode();
    const m = manque();
    const real = f.realMode === "date" ? `<input data-k="realVal" type="date" value="${esc(f.realVal)}">`
      : f.realMode === "semaine" ? `<input data-k="realVal" type="number" min="1" max="53" value="${esc(f.realVal)}" placeholder="n° de semaine">` : `<input value="à définir" disabled>`;
    const fin = dateFin(f);
    return `
      <div class="ov-prog">Obligatoire : <b id="ov_prog" style="${m.length ? "color:#C0392B" : ""}">${m.length ? "il manque : " + m.join(", ") : "complet ✓"}</b><span class="bar"><i id="ov_bar" style="width:${Math.round(100 * (6 - m.length) / 6)}%"></i></span></div>
      ${bloc("1", "Le chantier", "", `
        <div class="ov-st">Identification</div>
        <div class="ov-g4" style="margin-bottom:14px">
          ${champ("code", "Code chantier", { req: true, ph: "26FTS123", aide: vc.txt || "le code que tu donnes au chantier", aideCls: vc.txt ? (vc.ok ? "ok" : "ko") : "" })}
          ${champ("nom", "Nom du chantier", { req: true, cls: "two", ph: "VILLE - NATURE DES TRAVAUX" })}
          ${liste("responsable", "Responsable de l'affaire", listeEnc(), "—")}
        </div>
        <div class="ov-st">Adresse du chantier</div>
        <div class="ov-g4" style="margin-bottom:14px">
          ${champ("adresse", "Adresse", { cls: "two", ph: "n° et rue (si connue · servira au plan d'accès)" })}
          ${champ("cp", "Code postal", { ph: "ex. 82000" })}
          ${champ("ville", "Ville", { req: true })}
        </div>
        <div class="ov-st">Marché, contrat et attribution</div>
        <div class="ov-g4">
          ${choix("marche", "Marché", [["Bâtiment", "Bâtiment"], ["Génie civil", "Génie civil"]])}
          ${choix("contrat", "Contrat", [["Sous-traitance", "Sous-traitance"], ["Direct", "Direct"]])}
          ${choix("paiement", "Mode de paiement", [["Client", "Client"], ["Paiement direct", "Direct"], ["Marché public", "Public"]])}
          ${choix("dict", "DICT à faire", [["true", "Oui"], ["false", "Non"]])}
          ${liste("conducteur", "Conducteur de travaux (facultatif)", listeEnc(CONDUCTEURS), "Non attribué")}
        </div>`, true)}
      ${bloc("2", "Intervenants", "client obligatoire · le reste si connu", blocIntervenants(), true)}
      ${bloc("3", "Technique", "techniques, quantités, prévu au devis", blocTechnique(), true)}
      ${bloc("4", "Planning et documents transmis", "", `
        <div class="ov-st">Planning</div>
        <div class="ov-g4" style="margin-bottom:14px">
          <div class="ov-f"><label>Démarrage prévu</label><div style="display:flex;gap:6px"><select id="ov_realsel" style="width:118px;flex:none">${[["date", "Date"], ["semaine", "Semaine n°"], ["adefinir", "À définir"]].map(([k, l]) => `<option value="${k}" ${f.realMode === k ? "selected" : ""}>${l}</option>`).join("")}</select>${f.realMode === "adefinir" ? "" : real}</div>${f.realMode === "semaine" ? `<div class="ov-aide" id="ov_aide_real">${esc((semaine(f.realVal) || { texte: "numéro de semaine entre 1 et 53" }).texte.replace(/^semaine \d+ /, ""))}</div>` : ""}</div>
          ${champ("precision", "Précision sur le démarrage", { cls: "two", ph: "ex. fin d'année ou début 2027, à confirmer avec le client" })}
          ${champ("dateNdc", "Date NDC", { type: "date" })}
          ${champ("duree", "Durée de chantier (jours)", { ph: "ex. 4" })}
          <div class="ov-f"><label>Date de fin</label><div class="ov-calc" id="ov_fin">${fin ? esc(fin) : "calculée si date + durée"}</div></div>
        </div>
        <div class="ov-st">Documents transmis</div>
        <div class="ov-g4">
          ${champ("plan", "Plan", { ph: "ex. DDC papier, plan de fondations" })}
          ${champ("sol", "Étude de sol", { ph: "ex. ARGITEC G2 PRO du 02/11/2026" })}
          ${champ("devisNo", "Devis n°")}
          ${champ("devisLe", "Devis du", { type: "date" })}
        </div>`)}
      ${bloc("5", "Contraintes du site", "hauteur limitée, accès difficile", `<div class="ov-oo">
        ${sw("hauteur", "Hauteur disponible limitée", "choix de la machine (raccourcie)", `<span class="x"><input data-k="hauteurVal" value="${esc(f.hauteurVal)}" placeholder="ex. 3,20 m"></span>`)}
        ${sw("acces", "Accès difficile", f.acces ? "oui" : "non")}
      </div>`)}
      ${bloc("6", "Facturation", "prix de vente, date de facturation, acompte · jamais dans le texte du mail", `<div class="ov-g4">
        ${champ("montant", "Prix de vente HT (€)", { type: "number" })}
        ${champ("dateFact", "Date de facturation prévue", { type: "date" })}
        <div class="ov-f two"><label>Acompte</label>${sw("acompte", "Acompte", f.acompte ? "oui" : "non", `<span class="x"><input data-k="acomptePct" value="${esc(f.acomptePct)}" placeholder="%" style="width:70px"></span>`)}</div>
      </div>`)}
      ${bloc("7", "Informations complémentaires et devis", "", `
        <div class="ov-f"><label>Informations pour le conducteur</label><textarea data-k="infos" rows="4" placeholder="Ce que le conducteur doit savoir">${esc(f.infos)}</textarea></div>
        <div class="ov-f" style="margin-top:12px"><label>Devis signé (PDF, facultatif · rangé avec la fiche d'affaire acquise, jamais visible des chefs)</label>
          <label class="ov-drop ${devis ? "ok" : ""}" style="white-space:normal">${devis ? "✅ " + esc(devis.name) + " · clique pour changer" : "📎 Clique pour joindre le devis signé"}<input type="file" accept="application/pdf" id="ov_devis" hidden></label></div>`)}
      <div class="ov-foot">
        <label class="ov-mail"><input type="checkbox" id="ov_prevenir" ${f.prevenir ? "checked" : ""}> ✉️ Prévenir par mail</label>
        ${f.prevenir ? `<div class="ov-f" style="flex:1;min-width:280px;margin:0"><input data-k="destinataires" value="${esc(f.destinataires)}" placeholder="adresses séparées par ;"></div>` : `<span style="flex:1;color:var(--text-sub);font-size:.84rem">aucun mail ne partira</span>`}
        <button type="button" class="sv-btn pri" id="ov_ouvrir" ${enCours ? "disabled" : ""} style="${m.length ? "opacity:.5" : ""}">${enCours ? "⏳ " + esc(enCours) : f.prevenir ? "Ouvrir le chantier et prévenir" : "Ouvrir le chantier"}</button></div>`;
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
    const b = $("bar"); if (b) b.style.width = Math.round(100 * (6 - m.length) / 6) + "%";
    const a = $("aide_code"); if (a) { a.textContent = vc.txt || "le code que tu donnes au chantier"; a.className = "ov-aide " + (vc.txt ? (vc.ok ? "ok" : "ko") : ""); }
    const o = $("ouvrir"); if (o) o.style.opacity = m.length ? .5 : 1;
    const t = $("tot"); if (t) { const tot = techsDe(f).map((x) => `${nbDe(f, x)} ${libNb(x)}`).join(" + "); t.textContent = tot ? "· total : " + tot : ""; }
    const fi = $("fin"); if (fi) fi.textContent = dateFin(f) || "calculée si date + durée";
    if (f.realMode === "semaine") { const s = semaine(f.realVal), r = $("aide_real"); if (r) r.textContent = s ? s.texte.replace(/^semaine \d+ /, "") : "numéro de semaine entre 1 et 53"; }
  }

  function brancherForm() {
    racine.querySelectorAll("[data-k]").forEach((el) => {
      el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
        f[el.dataset.k] = el.value;
        if (["code", "nom", "ville"].includes(el.dataset.k)) { const p = el.selectionStart; el.value = el.value.toUpperCase(); f[el.dataset.k] = el.value; el.setSelectionRange(p, p); }
        majProgres();
      });
    });
    racine.querySelectorAll("[data-it]").forEach((el) => el.addEventListener("input", () => {
      const [k, ch] = el.dataset.it.split(".");
      if (ch === "soc") { const p = el.selectionStart; el.value = el.value.toUpperCase(); el.setSelectionRange(p, p); }
      f.inter[k][ch] = el.value; majProgres();
    }));
    racine.querySelectorAll("[data-l]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      const [i, ch] = el.dataset.l.split("."); f.lignes[Number(i)][ch] = el.value; majProgres();
    }));
    racine.querySelectorAll("[data-suppr]").forEach((b) => (b.onclick = () => { f.lignes.splice(Number(b.dataset.suppr), 1); rendre(); }));
    $("ligne").onclick = () => { const d = f.lignes[f.lignes.length - 1] || {}; f.lignes.push({ tech: d.tech || techsDe(f)[0] || "Micropieux", nb: "", diam: d.diam || "", long: "", arm: "" }); rendre(); };
    racine.querySelectorAll("[data-idem]").forEach((c) => (c.onchange = () => { f.inter.contact.idem = c.checked; rendre(); }));
    racine.querySelectorAll("[data-g4]").forEach((c) => (c.onchange = () => { f.inter.geo.g4 = c.checked; }));
    racine.querySelectorAll("[data-ch]").forEach((b) => (b.onclick = () => { const k = b.dataset.ch; f[k] = k === "dict" ? b.dataset.v === "true" : b.dataset.v; rendre(); }));
    racine.querySelectorAll(".ov-bh").forEach((h) => (h.onclick = () => {
      const b = h.parentElement, n = b.dataset.b;
      b.classList.toggle("ferme"); if (b.classList.contains("ferme")) ouverts.delete(n); else ouverts.add(n);
      h.querySelector(".ch").textContent = b.classList.contains("ferme") ? "▸" : "▾";
    }));
    racine.querySelectorAll("[data-sw]").forEach((b) => (b.onclick = () => { f[b.dataset.sw] = !f[b.dataset.sw]; rendre(); }));
    racine.querySelectorAll("[data-tech]").forEach((b) => (b.onclick = () => {
      const t = b.dataset.tech;
      f.techs = f.techs.includes(t) ? f.techs.filter((x) => x !== t) : [...f.techs, t];
      // Les lignes d'une technique décochée passent sur la première technique restante
      f.lignes.forEach((l) => { if (!f.techs.includes(l.tech)) l.tech = techsDe(f)[0] || "Micropieux"; });
      rendre();
    }));
    $("realsel").onchange = () => { f.realMode = $("realsel").value; f.realVal = ""; rendre(); };
    $("prevenir").onchange = () => { f.prevenir = $("prevenir").checked; rendre(); };
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
    const v = (t) => (t && String(t).trim() ? esc(String(t).trim()) : '<span class="vide">—</span>');
    const on = (b, txt) => `<span class="${b ? "oui" : "non"}">${b ? "OUI" : "NON"}</span> ${txt}`;
    const carte = (k, lib) => {
      const c = x.inter[k] || {};
      if (k === "contact" && c.idem) return `<div class="carte"><i>${lib}</i><span class="vide">idem client</span></div>`;
      const l = [c.soc && `<b>${esc(c.soc)}</b>`, c.nom && esc(c.nom), c.tel && esc(c.tel), c.mail && esc(c.mail)].filter(Boolean);
      return `<div class="carte"><i>${lib}${k === "geo" ? ` · G4 ${c.g4 ? "OUI" : "NON"}` : ""}</i>${l.length ? l.join("<br>") : '<span class="vide">—</span>'}</div>`;
    };
    const multi = techsDe(x).length > 1;
    const tot = techsDe(x).map((t) => `${nbDe(x, t)} ${libNb(t)}`).join(" + ");
    const montant = nombre(x.montant) ? nombre(x.montant).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €" : "—";
    const ctr = [x.hauteur ? `Hauteur limitée${x.hauteurVal ? " : " + esc(x.hauteurVal) : ""}` : "", x.acces ? "Accès difficile" : ""].filter(Boolean);
    const fact = [x.dateFact ? `facturation prévue le ${esc(frJ(x.dateFact))}` : "", x.acompte ? `acompte${x.acomptePct ? " " + esc(String(x.acomptePct).replace(/\s*%?$/, "")) + " %" : ""}` : ""].filter(Boolean).join(" · ");
    return `
      <div class="ent"><img src="../assets/logo-fts.png" alt="FTS"><div class="titre">FICHE D'AFFAIRE ACQUISE</div><div class="code">${esc(codeNorm(x.code).replace(/^(\d{2})FTS(\d+)$/, "$1 FTS $2"))}</div></div>
      <div class="meta"><span>Établie le ${esc(fr(emiseLe))} · responsable : <b>${v(x.responsable)}</b></span><span>Conducteur de travaux : <b>${x.conducteur ? esc(x.conducteur) : "non attribué"}</b></span></div>
      <div class="sec"><h3>CHANTIER</h3><div class="g2">
        <div class="kv"><i>Nom</i><b>${v(x.nom)}</b></div><div class="kv"><i>Marché</i><b>${v(x.marche)}</b></div>
        <div class="kv"><i>Adresse</i><b>${v(adresseComplete(x))}</b></div><div class="kv"><i>Contrat</i><b>${v(x.contrat === "Direct" ? "Marché direct" : x.contrat)} · paiement : ${v(x.paiement)}</b></div>
        <div class="kv"><i>DICT à faire</i><b>${x.dict ? "OUI" : "NON"}</b></div><div class="kv"><i>Technique</i><b>${esc(techsDe(x).join(" + "))}${x.typeTech ? " · " + esc(x.typeTech) : ""}</b></div>
      </div></div>
      <div class="sec"><h3>INTERVENANTS</h3><div class="g4">${INTER.map(([k, lib]) => carte(k, lib.toUpperCase())).join("")}</div></div>
      <div class="sec"><h3>TECHNIQUE — ${esc(tot.toUpperCase())}</h3>
        <table class="tt"><tr>${multi ? "<th>Technique</th>" : ""}<th>Nombre</th><th>Ø forage</th><th>Longueur max</th><th>Armature</th></tr>
          ${(x.lignes || []).filter((l) => nombre(l.nb)).map((l) => `<tr>${multi ? `<td>${esc(l.tech)}</td>` : ""}<td><b>${esc(l.nb)}</b></td><td>${l.diam ? esc(l.diam) + " mm" : "—"}</td><td>${l.long ? esc(String(l.long).replace(".", ",")) + " m" : "—"}</td><td>${v(l.arm)}</td></tr>`).join("")}</table>
        <div class="opts">
          <span>${on(x.implantation, "Implantation")}</span><span>${on(x.deblais, "Déblais / évacuation")}</span><span>${on(x.gainage, "Gainage")}</span><span>${on(x.traction, "Traction")}</span>
          <span style="grid-column:span 2">${on(x.essai, "Essai de traction" + (x.essai && x.essaiNb ? ` ×${esc(x.essaiNb)}` : "") + (x.essai && x.essaiMotif ? ` (${esc(x.essaiMotif)})` : ""))}</span><span>${on(x.recepage, "Recépage")}</span><span>${on(x.sondage, "Sondage vendu")}</span>
        </div></div>
      <div class="sec"><h3>PLANNING</h3><div class="g2">
        <div class="kv"><i>Démarrage</i><b>${esc(texteRealisation(x))}</b></div><div class="kv"><i>Date NDC</i><b>${v(frJ(x.dateNdc))}</b></div>
        <div class="kv"><i>Durée</i><b>${x.duree ? esc(x.duree) + (/^\s*[\d,.]+\s*$/.test(x.duree) ? " jours" : "") : '<span class="vide">—</span>'}</b></div><div class="kv"><i>Date de fin</i><b>${v(dateFin(x))}</b></div>
      </div></div>
      <div class="sec"><h3>DOCUMENTS TRANSMIS</h3><div class="g2">
        <div class="kv"><i>Plan</i><b>${v(x.plan)}</b></div><div class="kv"><i>Étude de sol</i><b>${v(x.sol)}</b></div>
        <div class="kv"><i>Devis</i><b>${x.devisNo || x.devisLe ? `${x.devisNo ? "n° " + esc(x.devisNo) : ""}${x.devisLe ? " du " + esc(frJ(x.devisLe)) : ""}` : '<span class="vide">—</span>'}</b></div><div class="kv"><i>Devis PDF</i><b>${devis ? "joint (AFFAIRES ACQUISES)" : '<span class="vide">non joint</span>'}</b></div>
      </div></div>
      <div class="sec"><h3>CONTRAINTES ET INFORMATIONS</h3><div class="infos">${ctr.length ? `<b>${ctr.join(" · ")}</b><br>` : ""}${x.infos && x.infos.trim() ? esc(x.infos.trim()).replace(/\n/g, "<br>") : ctr.length ? "" : '<span class="vide">—</span>'}</div></div>
      <div class="prix"><span>PRIX DE VENTE HT</span><span>${montant}</span></div>${fact ? `<div class="fact">${fact}</div>` : ""}
      <div class="pied"><span>Document interne FTS — ne pas transmettre aux chefs de chantier ni à l'extérieur</span><span>${esc(codeNorm(x.code))} · générée par la Supervision le ${esc(fr(emiseLe))}</span></div>`;
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
    oui.push(x.implantation ? "implantation à notre charge" : "implantation à leur charge");
    if (x.deblais) oui.push("déblais / évacuation");
    if (x.gainage) oui.push("gainage");
    if (x.traction) oui.push("micropieux en traction");
    if (x.essai) oui.push("essai de traction" + (x.essaiNb ? ` (${x.essaiNb})` : "") + (x.essaiMotif ? ` : ${x.essaiMotif}` : ""));
    if (x.recepage) oui.push("recépage");
    if (x.sondage) oui.push("sondage complémentaire");
    const ctr = [];
    if (x.hauteur) ctr.push("hauteur limitée" + (x.hauteurVal ? ` (${x.hauteurVal})` : ""));
    if (x.acces) ctr.push("accès difficile");
    // Texte validé par Clément le 24/11/2026 (le détail des intervenants reste sur la fiche jointe)
    const c = x.inter.client, moa = x.inter.moa;
    const l = [`Bonjour à tous,`, ``, `Nouveau chantier signé : ${techsDe(x).join(" + ").toUpperCase()}`, `Chantier : ${codeNorm(x.code)} ${x.nom}`, `Adresse : ${adresseComplete(x)}`,
      ...techsDe(x).map((t) => `${t} : ${nbDe(x, t)} ${libNb(t)}`),
      `Démarrage : ${texteRealisation(x)}${x.duree ? ` · durée prévue : ${x.duree}${/^\s*[\d,.]+\s*$/.test(x.duree) ? " jours" : ""}` : ""}`,
      `Client : ${[c.soc, c.nom, c.tel].filter(Boolean).join(" · ")}`,
      `Marché : ${x.marche} · ${x.contrat === "Direct" ? "marché direct" : "sous-traitance"}`,
      moa && moa.soc ? `Maître d'ouvrage : ${moa.soc}` : null,
      x.infos.trim() ? `Infos : ${x.infos.trim()}` : null].filter((t) => t !== null); // garde les lignes vides
    l.push(``, `Prévu au devis : ${oui.join(", ")}`);
    if (ctr.length) l.push(`Contraintes : ${ctr.join(", ")}`);
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
    const dest = f.prevenir ? adresses(f.destinataires) : [];
    if (f.prevenir && !dest.length) { alert("Coche « Prévenir par mail » seulement avec au moins une adresse, ou décoche-la."); return; }
    const x = { ...f, code: codeNorm(f.code), nom: f.nom.trim(), ville: f.ville.trim(), lignes: f.lignes.filter((l) => nombre(l.nb) > 0) };
    if (x.inter.contact.idem) x.inter = { ...x.inter, contact: { ...x.inter.client, idem: true } };
    // Champs simples gardés pour la préparation et les anciens écrans
    const ic = x.inter;
    x.client = ic.client.soc.trim();
    x.contact = [ic.contact.nom || ic.contact.soc, ic.contact.tel].filter(Boolean).join(" · ");
    x.moe = ic.moe.soc; x.be = ic.be.soc; x.bc = !!ic.bc.soc.trim(); x.bcNom = ic.bc.soc; x.g4 = !!ic.geo.g4;
    x.typeClient = x.paiement === "Marché public" ? "Marché public" : "Entreprise générale";
    if (!confirm(`Ouvrir le chantier ${x.code} ${x.nom} ?\n\nLe chantier sera créé dans la Supervision${dest.length ? `, puis ${dest.length} personne(s) seront prévenues par mail` : " (aucun mail ne partira)"}.`)) return;
    if (dest.length) try { localStorage.setItem(CLE_DEST, f.destinataires); } catch (e) {}
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
        adresse: adresseComplete(x).toUpperCase(),
        micropieuxPrevus: n("Micropieux"), pieuxPrevus: n("Pieux"), battagePrevus: n("Battage"),
        dureeChantier: nombre(x.duree) ? String(nombre(x.duree)) : "", montantVendu: nombre(x.montant) ? String(nombre(x.montant)) : "",
      });
      faits.push(`Chantier « ${r.chantierName} » créé dans la Supervision (en « À faire » dans Préparation, marqué NOUVEAU${x.conducteur ? `, attribué à ${x.conducteur}` : ", non attribué"})`);
      etape("Fiche d'affaire acquise…");
      const ref = await FTSDrive.findOrCreateFolder("REFERENTIEL", null);
      const dossier = await FTSDrive.findOrCreateFolder(DOSSIER, ref);
      const pdf = await pdfFiche(x, emiseLe);
      const fFiche = await FTSDrive.uploadFile(pdf, `${x.code}_Fiche-affaire-acquise.pdf`, "application/pdf", dossier, { remplacerSiExiste: true });
      faits.push("Fiche d'affaire acquise (PDF) rangée dans REFERENTIEL › AFFAIRES ACQUISES");
      let fDevis = null;
      if (devis) { etape("Devis signé…"); fDevis = await FTSDrive.uploadFile(devis, `${x.code}_Devis-signe.pdf`, "application/pdf", dossier, { remplacerSiExiste: true }); faits.push("Devis signé rangé avec la fiche"); }
      const detail = { version: 2, emiseLe: emiseLe.toISOString(), par: moiNom(), parEmail: moiEmail(), ...x, devis: fDevis ? fDevis.id : null, destinataires: dest };
      await FTSDrive.uploadFile(new Blob([JSON.stringify(detail, null, 1)], { type: "application/json" }), `${x.code}_ouverture.json`, "application/json", dossier, { remplacerSiExiste: true });
      // Ce qui sert aux conducteurs (sans facturation) sur le dossier du chantier
      etape("Infos pour la préparation…");
      const meta = await FTSDrive.getMetadonneesChantier(r.chantierId);
      const s = x.realMode === "semaine" ? semaine(x.realVal) : null;
      meta.ouverture = {
        version: 2, le: emiseLe.toISOString(), par: moiNom(), parEmail: moiEmail(), responsable: x.responsable || moiNom(), devisLe: x.devisLe || "", devisNo: x.devisNo || "", ficheId: fFiche.id, ficheLien: fFiche.webViewLink || "",
        realisation: { mode: x.realMode, valeur: x.realVal || "", texte: texteRealisation(x), lundi: s ? s.lundi.toISOString().slice(0, 10) : "", precision: x.precision || "" },
        dureeTexte: x.duree || "", dateNdc: x.dateNdc || "", dateFin: dateFin(x),
        adresse: { rue: x.adresse.trim(), cp: x.cp.trim(), ville: x.ville },
        marche: x.marche, contrat: x.contrat, paiement: x.paiement, dict: !!x.dict,
        client: x.client, typeClient: x.typeClient, contact: x.contact, moe: x.moe, be: x.be,
        intervenants: x.inter,
        technique: { type: x.typeTech || "", lignes: x.lignes },
        documents: { plan: x.plan || "", sol: x.sol || "" },
        prevu: { deblais: x.deblais, recepage: x.recepage, gainage: x.gainage, traction: x.traction, essai: x.essai, essaiNb: nombre(x.essaiNb) || 0, essaiMotif: x.essai ? x.essaiMotif || "" : "", bc: x.bc, bcNom: x.bc ? x.bcNom : "", g4: x.g4, sondage: x.sondage, implantation: x.implantation },
        contraintes: { hauteur: x.hauteur, hauteurVal: x.hauteur ? x.hauteurVal : "", acces: x.acces }, infos: x.infos,
      };
      if (x.conducteur) meta.conducteur = x.conducteur; // attribution directe (sinon « Non attribué » dans Préparation)
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
    const etatMail = !m.dest.length ? "Aucun mail envoyé (« Prévenir par mail » non coché)." : m.mode === "gmail" ? (m.envoye ? "✅ Mail envoyé." : "⚠️ Mail non envoyé.") : "📧 Le mail s'est ouvert dans Outlook, depuis ton adresse pro : vérifie-le et clique sur Envoyer.";
    return `<div class="ov-res"><h2>✅ Chantier ${esc(d.x.code)} ouvert</h2><ul>${d.faits.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <div class="ad-info" style="margin-bottom:10px">${esc(etatMail)}</div>
      ${m.dest.length ? `<pre><b>Objet : ${esc(m.objet)}</b>\n\n${esc(m.corps)}</pre>` : ""}
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
