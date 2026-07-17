/**
 * calendar.js — Pointage machine et pointage personnel via Google Agenda.
 *
 * Deux agendas Google partagés séparés (créés une fois, à partager
 * manuellement avec les services concernés depuis Google Agenda) :
 *   - "FTS - Pointage Machine"   → un événement par machine et par jour
 *   - "FTS - Pointage Personnel" → un événement par personne et par jour
 *
 * Un rapport refait le même jour (après correction d'une erreur) doit
 * REMPLACER les événements déjà créés pour cette date sur un chantier
 * donné, pas s'y ajouter en double — même logique que pour Drive/Sheets.
 */

const FTSCalendar = (() => {
  const API_BASE = "https://www.googleapis.com/calendar/v3";

  const NOM_CAL_MACHINE = "FTS - Pointage Machine";
  const NOM_CAL_PERSONNEL = "FTS - Pointage Personnel";

  // Couleurs d'événement Google Agenda (colorId officiels de l'API)
  const COULEUR_TRAVAIL = "10";   // vert (Basil)
  const COULEUR_PANNE = "11";    // rouge (Tomato)
  const COULEUR_ARRET = "8";     // gris (Graphite)
  const COULEUR_TRANSPORT = "9"; // bleu (Blueberry)
  const COULEUR_FTS = "9";       // bleu
  const COULEUR_INTERIM = "6";   // orange (Tangerine)

  function authHeader() {
    if (!window.FTSAuth || !FTSAuth.isSignedIn()) {
      throw new Error("Non connecté : impossible d'accéder à Google Agenda.");
    }
    return { Authorization: "Bearer " + FTSAuth.getToken() };
  }

  /**
   * Trouve (ou crée) un agenda par son nom exact, dans la liste des
   * agendas du compte connecté.
   */
  async function getOuCreerAgenda(nom) {
    const resListe = await fetch(`${API_BASE}/users/me/calendarList?minAccessRole=owner`, {
      headers: authHeader(),
    });
    if (!resListe.ok) throw new Error(`Erreur listage des agendas : ${resListe.status}`);
    const dataListe = await resListe.json();
    const existant = (dataListe.items || []).find((c) => c.summary === nom);
    if (existant) return existant.id;

    const resCreate = await fetch(`${API_BASE}/calendars`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ summary: nom }),
    });
    if (!resCreate.ok) {
      const err = await resCreate.json().catch(() => ({}));
      throw new Error(`Erreur création agenda "${nom}" : ${err.error?.message || resCreate.status}`);
    }
    const created = await resCreate.json();
    return created.id;
  }

  /**
   * Supprime tous les événements d'un agenda, sur une date donnée, dont
   * le titre commence par un préfixe donné (ex: le nom du chantier) —
   * permet de remplacer proprement les événements d'un chantier précis
   * sans toucher aux événements des AUTRES chantiers ce même jour.
   */
  async function supprimerEvenementsJour(calendarId, dateISO, prefixeTitre) {
    const timeMin = `${dateISO}T00:00:00Z`;
    const timeMax = `${dateISO}T23:59:59Z`;
    const res = await fetch(
      `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${timeMin}&timeMax=${timeMax}&maxResults=250`,
      { headers: authHeader() }
    );
    if (!res.ok) return;
    const data = await res.json();
    const aSupprimer = (data.items || []).filter((e) => (e.summary || "").startsWith(prefixeTitre));
    for (const e of aSupprimer) {
      await fetch(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${e.id}`, {
        method: "DELETE",
        headers: authHeader(),
      });
    }
  }

  async function creerEvenementJournee(calendarId, dateISO, titre, colorId) {
    const res = await fetch(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: titre,
        start: { date: dateISO },
        end: { date: dateISO },
        colorId,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Erreur création événement "${titre}" : ${err.error?.message || res.status}`);
    }
    return res.json();
  }

  /**
   * Enregistre le pointage machine du jour pour un chantier : un
   * événement par machine, préfixé du nom du chantier pour pouvoir les
   * identifier/remplacer sans toucher aux autres chantiers ce jour-là.
   *
   * @param {string} chantierName
   * @param {string} dateISO        format AAAA-MM-JJ
   * @param {Array<{nom:string, statut:string}>} machines
   */
  async function enregistrerPointageMachine(chantierName, dateISO, machines) {
    const calendarId = await getOuCreerAgenda(NOM_CAL_MACHINE);
    const prefixe = `[${chantierName}]`;
    await supprimerEvenementsJour(calendarId, dateISO, prefixe);

    const couleurs = { TRAVAIL: COULEUR_TRAVAIL, PANNE: COULEUR_PANNE, ARRET: COULEUR_ARRET, TRANSPORT: COULEUR_TRANSPORT };
    for (const m of machines) {
      if (!m.nom) continue;
      const titre = `${prefixe} ${m.nom} — ${m.statut || "?"}`;
      await creerEvenementJournee(calendarId, dateISO, titre, couleurs[m.statut] || undefined);
    }
  }

  /**
   * Enregistre le pointage personnel du jour pour un chantier : un
   * événement par personne présente.
   *
   * @param {string} chantierName
   * @param {string} dateISO
   * @param {Array<{nom:string, type:string, gd:boolean}>} personnel  type: "FTS"|"Intérim"
   */
  async function enregistrerPointagePersonnel(chantierName, dateISO, personnel) {
    const calendarId = await getOuCreerAgenda(NOM_CAL_PERSONNEL);
    const prefixe = `[${chantierName}]`;
    await supprimerEvenementsJour(calendarId, dateISO, prefixe);

    for (const p of personnel) {
      if (!p.nom) continue;
      const suffixeGD = p.gd ? " · GD" : "";
      const titre = `${prefixe} ${p.nom} — ${p.type}${suffixeGD}`;
      const couleur = p.type === "Intérim" ? COULEUR_INTERIM : COULEUR_FTS;
      await creerEvenementJournee(calendarId, dateISO, titre, couleur);
    }
  }

  return {
    getOuCreerAgenda,
    enregistrerPointageMachine,
    enregistrerPointagePersonnel,
  };
})();

// Exposition explicite sur window : une déclaration top-level en const/let
// ne crée PAS de propriété window.FTSCalendar automatiquement (contrairement
// à var), alors que tout le reste du code vérifie window.FTSCalendar avant
// utilisation.
window.FTSCalendar = FTSCalendar;
