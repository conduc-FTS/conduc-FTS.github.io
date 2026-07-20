/**
 * sheets.js — Suivi chantier via Google Sheets (matériel + personnel + production).
 *
 * Un seul classeur par chantier, nommé "Suivi {NOM DU CHANTIER}",
 * déposé directement dans le dossier du chantier sur Drive.
 * Trois onglets de pointage/suivi :
 *   - "Materiel"   : Date | Machine | Statut | FTS/LOC
 *   - "Personnel"  : Date | Nom | Type | GD
 *   - "Production" : Date | Nb pieux | Longueur totale (m) | Longueur moyenne/jour (m)
 *
 * Le Pointage Matériel/Personnel affiché côté conducteur est extrait
 * directement de ces onglets (via listerPointageToutesChantiers), et
 * non plus de Google Agenda : les Sheets sont déjà accessibles au
 * conducteur (propriétaire du dossier chantier), quel que soit le
 * compte Google du chef qui a soumis le rapport — ça évite d'avoir à
 * partager un agenda avec chaque nouveau chef un par un.
 *
 * Utilise l'API Google Sheets v4, avec le même token que Drive/Gmail
 * (scope spreadsheets ajouté à l'auth partagée).
 */

const FTSSheets = (() => {
  const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
  const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

  const ONGLET_MATERIEL = "Materiel";
  const ONGLET_PERSONNEL = "Personnel";
  const ONGLET_PRODUCTION = "Production";
  const ONGLET_PIEUX = "Pieux";

  function authHeader() {
    if (!window.FTSAuth || !FTSAuth.isSignedIn()) {
      throw new Error("Non connecté : impossible d'accéder à Google Sheets.");
    }
    return { Authorization: "Bearer " + FTSAuth.getToken() };
  }

  /**
   * Trouve le classeur de suivi d'un chantier dans son dossier Drive,
   * ou le crée avec ses deux onglets et leurs en-têtes s'il n'existe pas.
   *
   * @param {string} chantierFolderId  id du dossier du chantier sur Drive
   * @param {string} chantierName      nom complet du chantier (pour le titre du classeur)
   * @returns {Promise<string>} spreadsheetId
   */
  async function getOuCreerClasseurSuivi(chantierFolderId, chantierName) {
    const nomClasseur = `Suivi ${chantierName}`;

    // Chercher un classeur existant portant ce nom dans le dossier du chantier
    const q = encodeURIComponent(
      `name = '${nomClasseur.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.spreadsheet' and '${chantierFolderId}' in parents and trashed = false`
    );
    const resFind = await fetch(`${DRIVE_API_BASE}/files?q=${q}&fields=files(id,name)&spaces=drive`, {
      headers: authHeader(),
    });
    if (!resFind.ok) throw new Error(`Erreur recherche classeur suivi : ${resFind.status}`);
    const dataFind = await resFind.json();
    if (dataFind.files && dataFind.files.length > 0) {
      const spreadsheetId = dataFind.files[0].id;
      await assurerOngletsPresents(spreadsheetId);
      return spreadsheetId;
    }

    // Sinon, créer le classeur avec ses deux onglets
    const resCreate = await fetch(API_BASE, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: { title: nomClasseur },
        sheets: [
          { properties: { title: ONGLET_MATERIEL } },
          { properties: { title: ONGLET_PERSONNEL } },
          { properties: { title: ONGLET_PRODUCTION } },
          { properties: { title: ONGLET_PIEUX } },
        ],
      }),
    });
    if (!resCreate.ok) {
      const err = await resCreate.json().catch(() => ({}));
      throw new Error(`Erreur création classeur suivi : ${err.error?.message || resCreate.status}`);
    }
    const created = await resCreate.json();
    const spreadsheetId = created.spreadsheetId;

    // Déplacer le classeur créé (à la racine du Drive par défaut) dans le dossier du chantier
    await fetch(`${DRIVE_API_BASE}/files/${spreadsheetId}?addParents=${chantierFolderId}&removeParents=root&fields=id,parents`, {
      method: "PATCH",
      headers: authHeader(),
    });

    // En-têtes des onglets
    await ecrireValeurs(spreadsheetId, `${ONGLET_MATERIEL}!A1:D1`, [["Date", "Machine", "Statut", "FTS/LOC"]]);
    await ecrireValeurs(spreadsheetId, `${ONGLET_PERSONNEL}!A1:E1`, [["Date", "Nom", "Type", "GD", "Heures"]]);
    await ecrireValeurs(spreadsheetId, `${ONGLET_PRODUCTION}!A1:D1`, [["Date", "Nb pieux", "Longueur totale (m)", "Longueur moyenne/jour (m)"]]);
    await ecrireValeurs(spreadsheetId, `${ONGLET_PIEUX}!A1:B1`, [["Date", "N° Pieu"]]);

    return spreadsheetId;
  }

  const EN_TETES_ONGLETS = {
    [ONGLET_MATERIEL]: ["Date", "Machine", "Statut", "FTS/LOC"],
    [ONGLET_PERSONNEL]: ["Date", "Nom", "Type", "GD", "Heures"],
    [ONGLET_PRODUCTION]: ["Date", "Nb pieux", "Longueur totale (m)", "Longueur moyenne/jour (m)"],
    [ONGLET_PIEUX]: ["Date", "N° Pieu"],
  };

  /**
   * Retrofit : les classeurs de suivi créés avant l'ajout d'un onglet
   * (ex: "Personnel", ajouté après coup) ne l'ont pas. Écrire dedans
   * échoue alors silencieusement en pleine sauvegarde de rapport,
   * coupant tout ce qui suit (production, pieux). On vérifie donc à
   * chaque ouverture du classeur que les 4 onglets attendus existent,
   * et on crée ceux qui manquent avec leur en-tête.
   */
  async function assurerOngletsPresents(spreadsheetId) {
    const res = await fetch(`${API_BASE}/${spreadsheetId}?fields=sheets.properties.title`, {
      headers: authHeader(),
    });
    if (!res.ok) return; // best-effort : ne bloque pas le rapport si cette vérif échoue
    const data = await res.json();
    const titresExistants = new Set((data.sheets || []).map((s) => s.properties.title));

    const manquants = Object.keys(EN_TETES_ONGLETS).filter((onglet) => !titresExistants.has(onglet));
    if (manquants.length === 0) return;

    await fetch(`${API_BASE}/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: manquants.map((onglet) => ({ addSheet: { properties: { title: onglet } } })),
      }),
    });

    for (const onglet of manquants) {
      const entetes = EN_TETES_ONGLETS[onglet];
      const finCol = String.fromCharCode("A".charCodeAt(0) + entetes.length - 1);
      await ecrireValeurs(spreadsheetId, `${onglet}!A1:${finCol}1`, [entetes]);
    }
  }

  async function ecrireValeurs(spreadsheetId, range, values) {
    const res = await fetch(
      `${API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      }
    );
    if (!res.ok) throw new Error(`Erreur écriture Sheets : ${res.status}`);
    return res.json();
  }

  async function getSheetId(spreadsheetId, onglet) {
    const res = await fetch(`${API_BASE}/${spreadsheetId}?fields=sheets.properties`, {
      headers: authHeader(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const sheet = (data.sheets || []).find((s) => s.properties.title === onglet);
    return sheet ? sheet.properties.sheetId : null;
  }

  /**
   * Supprime toutes les lignes d'un onglet dont la colonne Date (A)
   * correspond exactement à la date donnée. Utilisé pour qu'un rapport
   * refait le même jour (après correction d'une erreur) REMPLACE les
   * données déjà enregistrées plutôt que de s'y ajouter en double.
   */
  async function supprimerLignesDate(spreadsheetId, onglet, date) {
    const sheetId = await getSheetId(spreadsheetId, onglet);
    if (sheetId == null) return;

    const lignes = await lireOnglet(spreadsheetId, onglet);
    const indices = [];
    lignes.forEach((l, idx) => {
      if (l[0] === date) indices.push(idx + 1); // +1 : la lecture démarre à la ligne 2 (index de grille 1)
    });
    if (indices.length === 0) return;

    // Suppression de bas en haut pour ne pas décaler les index restants
    indices.sort((a, b) => b - a);
    const requests = indices.map((rowIndex) => ({
      deleteDimension: {
        range: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 },
      },
    }));

    await fetch(`${API_BASE}/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
  }

  async function ajouterLignes(spreadsheetId, onglet, values) {
    const res = await fetch(
      `${API_BASE}/${spreadsheetId}/values/${encodeURIComponent(onglet)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      }
    );
    if (!res.ok) throw new Error(`Erreur ajout de lignes Sheets : ${res.status}`);
    return res.json();
  }

  /**
   * Enregistre les données d'un rapport journalier dans le suivi du chantier :
   * une ligne par machine (statut du jour), une ligne par personne présente,
   * une ligne de production du jour, et une ligne par numéro de pieu réalisé
   * (pour la détection de doublons sur les jours suivants).
   *
   * @param {Object} opts
   * @param {string} opts.chantierFolderId
   * @param {string} opts.chantierName
   * @param {string} opts.date            format JJ/MM/AAAA (affichage)
   * @param {Array<{nom:string, statut:string, ftsLoc:string}>} opts.machines
   * @param {Array<{nom:string, type:string, gd:boolean, heures?:string}>} [opts.personnel]  type: "FTS"|"Intérim"
   * @param {number} opts.nbPieux
   * @param {number} opts.longueurTotale
   * @param {string[]} [opts.numerosPieux]  numéros de pieu saisis ce jour
   */
  async function enregistrerDonneesRapport({ chantierFolderId, chantierName, date, machines, personnel, nbPieux, longueurTotale, numerosPieux }) {
    const spreadsheetId = await getOuCreerClasseurSuivi(chantierFolderId, chantierName);

    // Un rapport refait le même jour (après correction d'une erreur) doit
    // REMPLACER les données déjà enregistrées pour cette date, pas s'y
    // ajouter en double.
    await Promise.all([
      supprimerLignesDate(spreadsheetId, ONGLET_MATERIEL, date),
      supprimerLignesDate(spreadsheetId, ONGLET_PERSONNEL, date),
      supprimerLignesDate(spreadsheetId, ONGLET_PRODUCTION, date),
      supprimerLignesDate(spreadsheetId, ONGLET_PIEUX, date),
    ]);

    if (machines && machines.length > 0) {
      const lignesMateriel = machines
        .filter((m) => m.nom)
        .map((m) => [date, m.nom, m.statut || "", m.ftsLoc || ""]);
      if (lignesMateriel.length > 0) {
        await ajouterLignes(spreadsheetId, ONGLET_MATERIEL, lignesMateriel);
      }
    }

    if (personnel && personnel.length > 0) {
      const lignesPersonnel = personnel
        .filter((p) => p.nom)
        .map((p) => [date, p.nom, p.type || "FTS", p.gd ? "GD" : "", p.heures || ""]);
      if (lignesPersonnel.length > 0) {
        await ajouterLignes(spreadsheetId, ONGLET_PERSONNEL, lignesPersonnel);
      }
    }

    // Toujours une ligne de production, même à 0 pieu réalisé ce jour-là :
    // nécessaire pour un suivi journalier continu et une cadence moyenne
    // qui reflète aussi les jours sans production.
    const moyenne = nbPieux > 0 ? longueurTotale / nbPieux : 0;
    await ajouterLignes(spreadsheetId, ONGLET_PRODUCTION, [
      [date, nbPieux, longueurTotale.toFixed(2), moyenne.toFixed(2)],
    ]);

    if (numerosPieux && numerosPieux.length > 0) {
      await ajouterLignes(spreadsheetId, ONGLET_PIEUX, numerosPieux.map((n) => [date, n]));
    }

    return spreadsheetId;
  }

  /**
   * Vérifie si des numéros de pieu ont déjà été enregistrés un AUTRE jour
   * sur ce chantier (ex: le chef ressaisit par erreur le même numéro que
   * la veille). Retourne la liste des conflits trouvés.
   *
   * @param {string} chantierFolderId
   * @param {string} chantierName
   * @param {string[]} numerosPieux   numéros saisis aujourd'hui (non vides)
   * @param {string} dateDuJour       date du jour en cours, format JJ/MM/AAAA
   * @returns {Promise<Array<{numero:string, date:string}>>}
   */
  async function verifierPieuxDejaRealises(chantierFolderId, chantierName, numerosPieux, dateDuJour) {
    if (!numerosPieux || numerosPieux.length === 0) return [];

    const spreadsheetId = await getOuCreerClasseurSuivi(chantierFolderId, chantierName);
    const lignes = await lireOnglet(spreadsheetId, ONGLET_PIEUX);

    const conflits = [];
    numerosPieux.forEach((numero) => {
      const normalise = String(numero).trim().toUpperCase();
      if (!normalise) return;
      const trouve = lignes.find(
        (l) => String(l[1] || "").trim().toUpperCase() === normalise && l[0] !== dateDuJour
      );
      if (trouve) {
        conflits.push({ numero, date: trouve[0] });
      }
    });
    return conflits;
  }

  /**
   * Lit toutes les lignes d'un onglet (hors en-tête) pour affichage dans
   * l'écran "Suivi chantier" côté conducteur.
   */
  async function lireOnglet(spreadsheetId, onglet) {
    const res = await fetch(`${API_BASE}/${spreadsheetId}/values/${encodeURIComponent(onglet)}!A2:Z`, {
      headers: authHeader(),
    });
    if (!res.ok) throw new Error(`Erreur lecture Sheets : ${res.status}`);
    const data = await res.json();
    return data.values || [];
  }

  async function lireSuiviComplet(chantierFolderId, chantierName) {
    const spreadsheetId = await getOuCreerClasseurSuivi(chantierFolderId, chantierName);
    const [materiel, production] = await Promise.all([
      lireOnglet(spreadsheetId, ONGLET_MATERIEL),
      lireOnglet(spreadsheetId, ONGLET_PRODUCTION),
    ]);
    return {
      spreadsheetId,
      materiel: materiel.map((r) => ({ date: r[0], machine: r[1], statut: r[2], ftsLoc: r[3] })),
      production: production.map((r) => ({
        date: r[0],
        nbPieux: Number(r[1]) || 0,
        longueurTotale: parseFloat(r[2]) || 0,
        longueurMoyenne: parseFloat(r[3]) || 0,
      })),
    };
  }

  /**
   * Résumé condensé d'un chantier pour affichage sur une vignette :
   * la première machine du rapport le plus récent (avec son statut),
   * et le total de micropieux réalisés depuis le début du chantier.
   * Beaucoup plus léger que lireSuiviComplet pour un simple aperçu.
   */
  async function resumeChantier(chantierFolderId, chantierName) {
    const spreadsheetId = await getOuCreerClasseurSuivi(chantierFolderId, chantierName);
    const [materiel, production] = await Promise.all([
      lireOnglet(spreadsheetId, ONGLET_MATERIEL),
      lireOnglet(spreadsheetId, ONGLET_PRODUCTION),
    ]);

    // Date la plus récente présente dans l'onglet Matériel (les dates
    // sont au format JJ/MM/AAAA, donc on convertit pour bien comparer)
    const versDate = (s) => {
      const [j, m, a] = (s || "").split("/");
      return j && m && a ? new Date(`${a}-${m}-${j}`) : null;
    };
    let derniereDate = null;
    materiel.forEach((r) => {
      const d = versDate(r[0]);
      if (d && (!derniereDate || d > derniereDate)) derniereDate = d;
    });
    const derniereDateStr = derniereDate
      ? `${String(derniereDate.getDate()).padStart(2, "0")}/${String(derniereDate.getMonth() + 1).padStart(2, "0")}/${derniereDate.getFullYear()}`
      : null;

    const lignesDuJour = derniereDateStr
      ? materiel.filter((r) => r[0] === derniereDateStr)
      : [];

    // Les foreuses sont les seules machines qui comptent vraiment pour
    // la vignette (le statut d'une pelle ou d'un groupe électrogène est
    // moins parlant). On reconnaît les modèles courants par mots-clés ;
    // si aucun ne correspond, on retombe sur la première ligne du jour.
    const MOTS_CLES_FOREUSE = ["FUTURO", "MA12", "MA 12", "COMACCHIO", "BERETTA", "PH15", "PH 15", "CASAGRANDE", "SOILMEC", "IMT"];
    const estForeuse = (nomMachine) => {
      const n = (nomMachine || "").toUpperCase();
      return MOTS_CLES_FOREUSE.some((mot) => n.includes(mot));
    };
    const ligneForeuse = lignesDuJour.find((r) => estForeuse(r[1]));
    const premiereLigne = ligneForeuse || lignesDuJour[0] || null;

    const totalMicropieux = production.reduce((sum, r) => sum + (Number(r[1]) || 0), 0);

    return {
      derniereMachine: premiereLigne ? { nom: premiereLigne[1], statut: premiereLigne[2], date: premiereLigne[0] } : null,
      totalMicropieux,
    };
  }

  function parseDateFR(s) {
    const [j, m, a] = (s || "").split("/");
    return j && m && a ? new Date(`${a}-${m}-${j}`) : null;
  }

  /**
   * Agrège les lignes Matériel ou Personnel de TOUS les chantiers actifs,
   * sur une période donnée. C'est ce qui alimente les onglets Pointage
   * Matériel / Pointage Personnel côté conducteur — une simple lecture
   * des Sheets déjà accessibles, plutôt qu'un agenda séparé par compte.
   *
   * @param {"Materiel"|"Personnel"} onglet
   * @param {string} dateDebutISO  format AAAA-MM-JJ
   * @param {string} dateFinISO    format AAAA-MM-JJ
   * @returns {Promise<Array<{chantierName, chantierFolderId, spreadsheetId, sheetRow, cols}>>}
   */
  async function listerPointageToutesChantiers(onglet, dateDebutISO, dateFinISO) {
    if (!window.FTSDrive) throw new Error("Module Drive non chargé.");
    const chantiers = await FTSDrive.listChantiers();
    const dateDebut = new Date(`${dateDebutISO}T00:00:00`);
    const dateFin = new Date(`${dateFinISO}T23:59:59`);

    const parChantier = await Promise.all(
      chantiers.map(async (c) => {
        try {
          const spreadsheetId = await getOuCreerClasseurSuivi(c.id, c.name);
          const lignes = await lireOnglet(spreadsheetId, onglet);
          return lignes
            .map((r, idx) => ({
              chantierName: c.name,
              chantierFolderId: c.id,
              spreadsheetId,
              sheetRow: idx + 2, // +2 : ligne 1 = en-tête, lireOnglet démarre à la ligne 2
              cols: r,
            }))
            .filter((entry) => {
              const d = parseDateFR(entry.cols[0]);
              return d && d >= dateDebut && d <= dateFin;
            });
        } catch (e) {
          console.warn(`Erreur lecture pointage pour "${c.name}" :`, e);
          return [];
        }
      })
    );

    return parChantier.flat().sort((a, b) => (parseDateFR(b.cols[0]) || 0) - (parseDateFR(a.cols[0]) || 0));
  }

  /**
   * Remplace le contenu d'une ligne de pointage (correction d'une erreur
   * de saisie). `valeurs` doit contenir toutes les colonnes de l'onglet,
   * dans l'ordre (ex: [date, machine, statut, ftsLoc]).
   */
  async function modifierLignePointage(spreadsheetId, onglet, sheetRow, valeurs) {
    const finCol = String.fromCharCode("A".charCodeAt(0) + valeurs.length - 1);
    await ecrireValeurs(spreadsheetId, `${onglet}!A${sheetRow}:${finCol}${sheetRow}`, [valeurs]);
  }

  /**
   * Supprime une ligne de pointage saisie par erreur.
   */
  async function supprimerLignePointage(spreadsheetId, onglet, sheetRow) {
    const sheetId = await getSheetId(spreadsheetId, onglet);
    if (sheetId == null) return;
    await fetch(`${API_BASE}/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: sheetRow - 1, endIndex: sheetRow } },
        }],
      }),
    });
  }

  /**
   * Ajoute une ligne de pointage saisie manuellement par le conducteur
   * (ex: le chef a oublié de pointer une machine ou une personne).
   *
   * @param {string} chantierFolderId
   * @param {string} chantierName
   * @param {"Materiel"|"Personnel"} onglet
   * @param {Array} valeurs  colonnes dans l'ordre de l'onglet, ex: [date, machine, statut, ftsLoc]
   */
  async function ajouterLignePointage(chantierFolderId, chantierName, onglet, valeurs) {
    const spreadsheetId = await getOuCreerClasseurSuivi(chantierFolderId, chantierName);
    await ajouterLignes(spreadsheetId, onglet, [valeurs]);
    return spreadsheetId;
  }

  return {
    getOuCreerClasseurSuivi,
    enregistrerDonneesRapport,
    lireSuiviComplet,
    resumeChantier,
    verifierPieuxDejaRealises,
    listerPointageToutesChantiers,
    modifierLignePointage,
    supprimerLignePointage,
    ajouterLignePointage,
    ONGLET_MATERIEL,
    ONGLET_PERSONNEL,
  };
})();

// Exposition explicite sur window : une déclaration top-level en const/let
// ne crée PAS de propriété window.FTSSheets automatiquement (contrairement à var),
// alors que tout le reste du code vérifie window.FTSSheets avant utilisation.
window.FTSSheets = FTSSheets;
