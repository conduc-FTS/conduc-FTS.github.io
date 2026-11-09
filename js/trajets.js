/**
 * trajets.js — Km domicile → chantier et zone FTS (Pointage Personnel).
 *
 * Deux calculs différents :
 *  - Km domicile → chantier : PAR LA ROUTE, aller simple, depuis l'adresse
 *    de la personne (classeur « Adresses Personnel FTS ») jusqu'au chantier.
 *    Service d'itinéraire IGN Géoplateforme : gratuit, sans clé.
 *  - Zone FTS : cercles autour du dépôt, distance À VOL D'OISEAU dépôt →
 *    chantier. Ne dépend pas de la personne. Calcul local, sans réseau.
 *
 * Point du chantier : GPS des métadonnées, sinon adresse géocodée (IGN).
 * Km domicile → chantier enregistré UNE fois par binôme personne + chantier
 * (onglet « Distances » du classeur Adresses Personnel FTS), repris ensuite
 * par tout le monde ; recalculé seulement si l'adresse ou le point change.
 */
const FTSTrajets = (() => {
  // Dépôt FTS — 13 rue du Commandant Charcot, 33290 Blanquefort (BAN)
  const DEPOT = { lat: 44.922498, lng: -0.61896, label: "13 rue du Commandant Charcot, Blanquefort" };

  // Zones FTS par défaut (rayons à vol d'oiseau depuis le dépôt), remplacées
  // par l'onglet « Zones » du classeur Adresses Personnel FTS (modifiable dans
  // le Pointage Personnel avec le compte conduc.fts). Borne haute incluse :
  // 10,0 km = zone 1B. Au-delà de la zone 5 : zone 6 si la personne rentre
  // chez elle, sinon grand déplacement (case GD du pointage).
  const ZONES_DEFAUT = [
    { nom: "1B", max: 10, lib: "0 à 10 km" },
    { nom: "2", max: 20, lib: "10 à 20 km" },
    { nom: "3", max: 30, lib: "20 à 30 km" },
    { nom: "4", max: 40, lib: "30 à 40 km" },
    { nom: "5", max: 50, lib: "40 à 50 km" },
  ];
  let ZONES = ZONES_DEFAUT.map((z) => ({ ...z }));
  let ZONE_6 = { nom: "6", lib: "au-delà de 50 km" };
  let infoZones = { date: "", par: "", source: "defaut" };
  const libKm = (n) => String(n).replace(".", ",");
  /** Applique une liste de limites (1B à 5) : recalcule les libellés « x à y km » */
  function appliquerZones(liste, info) {
    let bas = 0;
    ZONES = ZONES_DEFAUT.map((d) => {
      const z = (liste || []).find((x) => x.nom === d.nom);
      const max = z && Number.isFinite(z.max) ? z.max : d.max;
      const r = { nom: d.nom, max, lib: `${libKm(bas)} à ${libKm(max)} km` };
      bas = max;
      return r;
    });
    ZONE_6 = { nom: "6", lib: `au-delà de ${libKm(bas)} km` };
    infoZones = info || infoZones;
  }
  /** Contrôle : limites positives et croissantes. Renvoie un message d'erreur ou "". */
  function verifierZones(liste) {
    let bas = 0;
    for (const d of ZONES_DEFAUT) {
      const z = liste.find((x) => x.nom === d.nom);
      if (!z || !Number.isFinite(z.max) || z.max <= 0) return `Zone ${d.nom} : indique une distance en km.`;
      if (z.max <= bas) return `Zone ${d.nom} : la limite doit être plus grande que celle de la zone du dessus (${libKm(bas)} km).`;
      bas = z.max;
    }
    return "";
  }
  let zonesChargees = null;
  function chargerZones(forcer) {
    if (zonesChargees && !forcer) return zonesChargees;
    zonesChargees = (async () => {
      try {
        const z = await FTSSheets.lireZones();
        if (z) appliquerZones(z, { date: z[0].date, par: z[0].par, source: "sheet" });
      } catch (e) { console.warn("Zones FTS : valeurs par défaut utilisées", e); }
      return getZones();
    })();
    return zonesChargees;
  }
  async function enregistrerZones(liste, par) {
    const err = verifierZones(liste);
    if (err) throw new Error(err);
    const d = new Date(), date = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    await FTSSheets.enregistrerZones(ZONES_DEFAUT.map((x) => ({ nom: x.nom, max: liste.find((z) => z.nom === x.nom).max })), date, par);
    appliquerZones(liste, { date, par, source: "sheet" });
    zonesChargees = Promise.resolve(getZones());
  }
  const getZones = () => ({ zones: ZONES.map((z) => ({ ...z })), zone6: { ...ZONE_6 }, ...infoZones });
  const ZONE_1A = { nom: "1A", lib: "dépôt" };
  const RAYON_DEPOT_KM = 0.5; // chantier au dépôt même

  const CLE_CACHE = "fts_trajets_v2"; // v2 : choix des homonymes corrigé
  const sansAccent = (s) => String(s == null ? "" : s).trim().replace(/\s+/g, " ").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const cleNom = (s) => sansAccent(s).split(" ").filter(Boolean).sort().join(" ");

  try { localStorage.removeItem("fts_trajets_v1"); } catch (e) {}
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CLE_CACHE)) || {}; } catch (e) { cache = {}; }
  const sauver = () => { try { localStorage.setItem(CLE_CACHE, JSON.stringify(cache)); } catch (e) {} };
  const enVol = new Map(); // évite deux appels identiques en même temps
  function memo(cle, fn) {
    if (cache[cle] !== undefined) return Promise.resolve(cache[cle]);
    if (enVol.has(cle)) return enVol.get(cle);
    const p = fn().then((v) => { if (v !== undefined) { cache[cle] = v; sauver(); } return v; }).finally(() => enVol.delete(cle));
    enVol.set(cle, p);
    return p;
  }

  /** Distance à vol d'oiseau (km) */
  function volOiseau(a, b) {
    const R = 6371, rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** Zone FTS d'un point (chantier) */
  function zoneDe(point, nomChantier) {
    const km = volOiseau(DEPOT, point);
    if (km <= RAYON_DEPOT_KM || /\bDEPOT\b/.test(sansAccent(nomChantier))) return { ...ZONE_1A, km };
    const z = ZONES.find((x) => km <= x.max);
    return { ...(z || ZONE_6), km };
  }

  function lireGps(t) {
    if (typeof FTSPlanAcces !== "undefined") return FTSPlanAcces.lireGps(t);
    const m = String(t || "").match(/(-?\d+\.\d+)\s*[,; ]\s*(-?\d+\.\d+)/);
    return m ? { lat: +m[1], lng: +m[2] } : null;
  }

  /**
   * Adresse → point (IGN / Base Adresse Nationale).
   * Attention aux homonymes : « SARLAT » seul renvoie d'abord un lieu-dit
   * « Sarlat » du Puy-de-Dôme. On lit donc 10 réponses et, parmi les mieux
   * notées, on préfère : numéro / rue > commune > lieu-dit, puis le plus
   * proche du dépôt (FTS travaille autour de Bordeaux).
   */
  const RANG_TYPE = { housenumber: 0, street: 1, municipality: 2, locality: 3 };
  async function geocoder(adresse) {
    const q = String(adresse || "").replace(/—/g, " ").trim();
    if (q.length < 3) return null;
    return memo("g|" + sansAccent(q), async () => {
      const res = await fetch(`https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=10`);
      if (!res.ok) throw new Error(`Recherche d'adresse impossible (${res.status})`);
      const feats = ((await res.json()).features || []).filter((f) => f && f.geometry);
      if (!feats.length) return null;
      const sc = (f) => (f.properties || {}).score || 0;
      const meilleur = Math.max(...feats.map(sc));
      const cand = feats.filter((f) => sc(f) >= meilleur - 0.15).map((f) => {
        const [lng, lat] = f.geometry.coordinates, pr = f.properties || {};
        return { lat, lng, pr, rang: RANG_TYPE[pr.type] ?? 4, dist: volOiseau(DEPOT, { lat, lng }) };
      });
      cand.sort((a, b) => a.rang - b.rang || a.dist - b.dist);
      const c = cand[0];
      return { lat: c.lat, lng: c.lng, label: c.pr.label || q, ville: c.pr.city || c.pr.name || "", precis: c.rang <= 1 && (c.pr.score || 0) >= 0.5 };
    });
  }

  /** Point du chantier : GPS en priorité, sinon adresse */
  async function pointChantier(meta) {
    meta = meta || {};
    const g = lireGps(meta.gps);
    if (g) return { lat: g.lat, lng: g.lng, source: "gps", precis: true };
    if (!meta.adresse) return null;
    const r = await geocoder(meta.adresse);
    return r ? { ...r, source: "adresse" } : null;
  }

  /** Itinéraire voiture (IGN) → { km, min } */
  function route(a, b) {
    const f = (p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`;
    return memo(`r|${f(a)}|${f(b)}`, async () => {
      const url = `https://data.geopf.fr/navigation/itineraire?resource=bdtopo-osrm&profile=car&optimization=fastest&start=${f(a)}&end=${f(b)}&distanceUnit=kilometer&timeUnit=minute&getSteps=false&geometryFormat=polyline`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Calcul d'itinéraire impossible (${res.status})`);
      const d = await res.json();
      if (!Number.isFinite(d.distance)) throw new Error("Itinéraire introuvable");
      return { km: d.distance, min: d.duration };
    });
  }

  // ── Adresses Personnel + Distances enregistrées (une lecture par page) ──
  let adresses = null, distances = null;
  async function chargerAdresses() {
    if (adresses) return adresses;
    const { adresses: liste } = await FTSSheets.listerAdresses();
    adresses = new Map();
    liste.forEach((a) => { if (a.adresse) adresses.set(cleNom(`${a.prenom} ${a.nom}`), a.adresse); });
    return adresses;
  }
  async function chargerDistances() {
    if (distances) return distances;
    distances = new Map();
    try { (await FTSSheets.listerDistances()).forEach((d) => distances.set(cleNom(d.nom) + "|" + d.chantierId, d)); }
    catch (e) { console.warn("Distances enregistrées illisibles :", e); }
    return distances;
  }
  const oublierAdresses = () => { adresses = null; distances = null; };
  const textePoint = (p) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  const aujourdhui = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; };

  /**
   * Km domicile → chantier : déjà enregistré pour ce binôme (même adresse,
   * même point chantier) → on le reprend ; sinon on calcule et on enregistre.
   */
  async function kmDomicile(nom, chantierId, chantierName, adr, pc) {
    const cle = cleNom(nom) + "|" + chantierId;
    const point = textePoint(pc);
    const deja = (await chargerDistances()).get(cle);
    if (deja && Number.isFinite(deja.km) && sansAccent(deja.adresse) === sansAccent(adr) && deja.point === point) {
      return { km: deja.km, min: deja.min, enregistre: deja.date };
    }
    const pd = await geocoder(adr);
    if (!pd) return null;
    const r = await route(pd, pc);
    const ligne = { nom: String(nom).trim().toUpperCase(), chantier: chantierName, km: r.km, min: r.min, adresse: adr, point, chantierId, date: aujourdhui() };
    try {
      const sheetRow = await FTSSheets.enregistrerDistance(ligne, deja && deja.sheetRow);
      distances.set(cle, { ...ligne, sheetRow: sheetRow || (deja && deja.sheetRow) });
    } catch (e) { console.warn("Distance non enregistrée :", e); }
    return { ...r, villeDomicile: String(pd.label || "").replace(/^.*\d{5}\s*/, "") };
  }

  /**
   * Tout le calcul pour une ligne de pointage.
   * @returns {Promise<{zone, zoneErr, domicile:{km,min}|null, domErr, chantierApprox}>}
   */
  async function calculer({ nom, chantierId, chantierName, meta, interim }) {
    const out = { zone: null, zoneErr: "", domicile: null, domErr: "", chantierApprox: false };
    let pc = null;
    try { pc = await pointChantier(meta); } catch (e) { out.zoneErr = out.domErr = "Adresse du chantier introuvable"; return out; }
    if (!pc) { out.zoneErr = out.domErr = "Adresse chantier manquante"; return out; }
    out.chantierApprox = !pc.precis;
    out.lieuChantier = pc.source === "adresse" ? pc.ville || pc.label : "";
    await chargerZones();
    out.zone = zoneDe(pc, chantierName);
    // Intérimaires : pas de km domicile → chantier (ni calcul, ni enregistrement)
    if (interim) { out.interim = true; return out; }
    try {
      const adr = (await chargerAdresses()).get(cleNom(nom));
      if (!adr) { out.domErr = "Adresse non trouvée"; out.domDetail = "Nom absent d'Adresses Personnel"; return out; }
      const d = await kmDomicile(nom, chantierId, chantierName, adr, pc);
      if (!d) { out.domErr = "Adresse du domicile illisible"; out.domDetail = adr; return out; }
      out.domicile = d;
      out.villeDomicile = d.villeDomicile || "";
    } catch (e) {
      out.domErr = "Calcul impossible"; out.domDetail = e.message;
    }
    return out;
  }

  return { DEPOT, getZones, chargerZones, enregistrerZones, verifierZones, volOiseau, zoneDe, pointChantier, route, calculer, chargerAdresses, oublierAdresses, cleNom };
})();
