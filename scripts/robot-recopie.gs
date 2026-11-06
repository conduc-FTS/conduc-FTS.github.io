/**
 * FTS — Robot de recopie (Google Apps Script, compte conduc.fts)
 * ================================================================
 * Les tablettes des chefs ne rangent leurs documents QUE dans le dossier
 * du chantier (DOSSIER CHANTIER / {chantier}). Toutes les heures, ce robot
 * en range une COPIE dans les dossiers de l'encadrement :
 *
 *   {chantier}/RAPPORT JOURNALIER/*.pdf
 *        → RAPPORTS PAR CHEF / {CHEF} / {AAAA} / {MM - MOIS} /
 *   {chantier}/SECURITE/ACCUEIL SECURITE/*.pdf
 *        → ACCUEIL SECURITE / {AAAA} /
 *   {chantier}/ACCUEIL INTERIMAIRE/*.pdf
 *        → ACCUEIL INTERIMAIRE / {AAAA} /
 *   {chantier}/FICHE MATERIEL/{N° - machine}/*.pdf
 *        → FICHE MATERIEL / {N° - machine} /
 *
 * Les chantiers archivés (dossier ARCHIVES) sont traités de la même façon.
 *
 * Règles :
 *  - un document corrigé (même nom, version plus récente) REMPLACE la copie ;
 *  - aucun doublon : chaque copie garde en description l'identifiant et la
 *    date de l'original (« FTS-SRC:… ») ;
 *  - les copies appartiennent à conduc.fts (un PDF déposé par le compte Gmail
 *    d'un chef appartient à ce chef ; la copie, elle, reste à l'entreprise) ;
 *  - les originaux ne sont JAMAIS modifiés ni supprimés.
 *
 * INSTALLATION (une seule fois, connecté avec conduc.fts) : voir la notice
 * « Installer le robot de recopie ». En résumé : coller ce code dans un
 * nouveau projet sur script.google.com, choisir la fonction « installer »,
 * cliquer sur Exécuter, accepter les autorisations.
 */

// ─── Réglages ──────────────────────────────────────────────────────
var RACINE_CHANTIERS = 'DOSSIER CHANTIER';
var RACINE_ARCHIVES = 'ARCHIVES';
var DEST_RAPPORTS = 'RAPPORTS PAR CHEF';
var DEST_ACCUEIL_SECURITE = 'ACCUEIL SECURITE';
var DEST_ACCUEIL_INTERIMAIRE = 'ACCUEIL INTERIMAIRE';
var DEST_FICHE_MATERIEL = 'FICHE MATERIEL';
var CHEF_INCONNU = '_CHEF NON RECONNU';
var MOIS = ['JANVIER', 'FEVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILLET', 'AOUT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DECEMBRE'];
var DUREE_MAX_MS = 5 * 60 * 1000;   // Google coupe à 6 min : on s'arrête avant
var MARGE_MS = 2 * 3600 * 1000;     // on relit 2 h en arrière à chaque passage

// ─── Points d'entrée ───────────────────────────────────────────────

/** À lancer UNE FOIS : crée le déclencheur « toutes les heures » puis fait un premier passage complet. */
function installer() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'recopier') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('recopier').timeBased().everyHours(1).create();
  PropertiesService.getScriptProperties().deleteProperty('dernierPassage');
  recopier();
}

/** Relance un passage complet sur tous les chantiers (reprise de l'historique). */
function toutReprendre() {
  PropertiesService.getScriptProperties().deleteProperty('dernierPassage');
  recopier();
}

/** Passage normal (appelé toutes les heures par le déclencheur). */
function recopier() {
  var debut = Date.now();
  var props = PropertiesService.getScriptProperties();
  var dernier = Number(props.getProperty('dernierPassage') || 0);
  var bilan = { copies: 0, remplaces: 0, ignores: 0, erreurs: [] };

  var racines = trouverRacines_();
  if (!racines.chantiers) throw new Error('Dossier "' + RACINE_CHANTIERS + '" introuvable à la racine du Drive.');
  var dest = {
    rapports: dossierRacine_(DEST_RAPPORTS),
    securite: dossierRacine_(DEST_ACCUEIL_SECURITE),
    interimaire: dossierRacine_(DEST_ACCUEIL_INTERIMAIRE),
    materiel: dossierRacine_(DEST_FICHE_MATERIEL),
  };

  var depuis = dernier ? new Date(dernier - MARGE_MS) : new Date(2020, 0, 1);
  var q = 'mimeType = "application/pdf" and trashed = false and modifiedDate > "' + Utilities.formatDate(depuis, 'UTC', "yyyy-MM-dd'T'HH:mm:ss") + '"';
  var fichiers = DriveApp.searchFiles(q);
  var cacheChefs = {};
  var interrompu = false;

  while (fichiers.hasNext()) {
    if (Date.now() - debut > DUREE_MAX_MS) { interrompu = true; break; }
    var f = fichiers.next();
    try {
      var place = localiser_(f, racines);
      if (!place) continue; // pas un document de chantier (ex : une copie déjà rangée)
      var cible = destination_(f, place, dest, cacheChefs);
      if (!cible) { bilan.ignores++; continue; }
      var r = copierSiBesoin_(f, cible.dossier, cible.nom);
      if (r === 'copie') bilan.copies++;
      else if (r === 'remplace') bilan.remplaces++;
    } catch (e) {
      bilan.erreurs.push(f.getName() + ' : ' + e.message);
    }
  }

  // On ne valide le passage que s'il est allé jusqu'au bout (sinon le
  // suivant reprend : les copies déjà faites sont reconnues et sautées).
  if (!interrompu) props.setProperty('dernierPassage', String(debut));
  props.setProperty('dernierBilan', JSON.stringify({
    le: new Date().toISOString(), interrompu: interrompu,
    copies: bilan.copies, remplaces: bilan.remplaces, ignores: bilan.ignores, erreurs: bilan.erreurs.slice(0, 20),
  }));
  console.log('Recopie FTS : %s copie(s), %s remplacée(s), %s erreur(s)%s', bilan.copies, bilan.remplaces, bilan.erreurs.length, interrompu ? ' — passage interrompu, suite au prochain' : '');
  if (bilan.erreurs.length) console.warn(bilan.erreurs.join('\n'));
  return bilan;
}

/** Affiche le résultat du dernier passage (menu Exécuter → afficherBilan). */
function afficherBilan() {
  console.log(PropertiesService.getScriptProperties().getProperty('dernierBilan') || 'Aucun passage pour l\'instant.');
}

// ─── Où est rangé ce fichier ? ─────────────────────────────────────

function trouverRacines_() {
  var root = DriveApp.getRootFolder();
  var c = root.getFoldersByName(RACINE_CHANTIERS);
  var a = root.getFoldersByName(RACINE_ARCHIVES);
  return { chantiers: c.hasNext() ? c.next() : null, archives: a.hasNext() ? a.next() : null };
}

/**
 * Remonte les dossiers parents jusqu'au dossier du chantier.
 * @return {null|{chantier:Folder, chemin:string[]}} chemin = sous-dossiers entre le chantier et le fichier
 */
function localiser_(fichier, racines) {
  var idsRacines = [racines.chantiers.getId()];
  if (racines.archives) idsRacines.push(racines.archives.getId());
  var parents = fichier.getParents();
  if (!parents.hasNext()) return null;
  var dossier = parents.next();
  var chemin = [];
  for (var i = 0; i < 6 && dossier; i++) {
    var p = dossier.getParents();
    if (!p.hasNext()) return null;
    var parent = p.next();
    if (idsRacines.indexOf(parent.getId()) >= 0) return { chantier: dossier, chemin: chemin };
    chemin.unshift(dossier.getName());
    dossier = parent;
  }
  return null;
}

function destination_(f, place, dest, cacheChefs) {
  var module = (place.chemin[0] || '').toUpperCase();
  var nom = f.getName();
  var code = place.chantier.getName().split(/\s+/)[0];

  if (module === 'RAPPORT JOURNALIER') {
    var m = nom.match(/^(\d{4})-(\d{2})-(\d{2})_/);
    if (!m) return null;
    var chef = chefDuRapport_(f, place.chantier, m, cacheChefs) || CHEF_INCONNU;
    var nomMois = m[2] + ' - ' + MOIS[Number(m[2]) - 1];
    var dossier = sousDossier_(sousDossier_(dossierChef_(dest.rapports, chef), m[1]), nomMois);
    // Chef retrouvé après coup : on retire l'ancienne copie de « _CHEF NON RECONNU »
    if (chef !== CHEF_INCONNU) retirerCopieInconnue_(dest.rapports, m[1], nomMois, nom, f.getId());
    return { dossier: dossier, nom: nom };
  }
  if (module === 'SECURITE' && (place.chemin[1] || '').toUpperCase() === 'ACCUEIL SECURITE') {
    var annee = String(f.getDateCreated().getFullYear());
    return { dossier: sousDossier_(dest.securite, annee), nom: avecCode_(nom, code) };
  }
  if (module === 'ACCUEIL INTERIMAIRE') {
    var a = nom.match(/^(\d{4})-\d{2}-\d{2}/);
    var anneeI = a ? a[1] : String(f.getDateCreated().getFullYear());
    return { dossier: sousDossier_(dest.interimaire, anneeI), nom: avecCode_(nom, code) };
  }
  if (module === 'FICHE MATERIEL' && place.chemin[1]) {
    return { dossier: dossierMachine_(dest.materiel, place.chemin[1]), nom: avecCode_(nom, code) };
  }
  return null;
}

/** Préfixe le code chantier si le nom ne le contient pas déjà (évite les homonymes entre chantiers). */
function avecCode_(nom, code) {
  return nom.toUpperCase().indexOf(code.toUpperCase()) >= 0 ? nom : code + '_' + nom;
}

/**
 * Chef du rapport : étiquette « FTS-CHEF:… » posée par la tablette, sinon
 * le suivi du chantier (onglet Production : date + atelier → nom du chef).
 */
function chefDuRapport_(f, chantier, m, cacheChefs) {
  var desc = String(f.getDescription() || '');
  var e = desc.match(/FTS-CHEF:\s*([^\n|]+)/);
  if (e && e[1].trim()) return e[1].trim().toUpperCase();
  var parAdmin = chefParAdministratif_(f.getName());
  if (parAdmin) return parAdmin;
  var id = chantier.getId();
  if (!cacheChefs[id]) cacheChefs[id] = lireChefsDuSuivi_(chantier);
  var dateFR = m[3] + '/' + m[2] + '/' + m[1];
  var parDate = cacheChefs[id][dateFR] || [];
  if (!parDate.length) return '';
  var suffixe = (f.getName().replace(/\.pdf$/i, '').split('_')[3] || '');
  if (suffixe) {
    var cle = cleAtelier_(suffixe);
    for (var i = 0; i < parDate.length; i++) if (parDate[i].atelier && cleAtelier_(parDate[i].atelier) === cle) return parDate[i].chef;
  }
  return parDate.length === 1 ? parDate[0].chef : (parDate[0].chef || '');
}

/**
 * Anciens rapports (avant le rapport v2, sans nom du chef dans le suivi) :
 *  1. la tablette rangeait aussi une copie dans ADMINISTRATIF / {CHEF} /
 *     RAPPORT JOURNALIER / RJ {année} → le nom du dossier donne le chef ;
 *  2. sinon, parmi les personnes pointées ce jour-là (onglet Personnel), le
 *     seul CHEF DE CHANTIER de la base Personnel FTS.
 */
var indexAdministratif_ = null;
function chefParAdministratif_(nomFichier) {
  if (!indexAdministratif_) {
    indexAdministratif_ = {};
    try {
      var it = DriveApp.getRootFolder().getFoldersByName('ADMINISTRATIF');
      if (it.hasNext()) {
        var chefs = it.next().getFolders();
        while (chefs.hasNext()) {
          var dChef = chefs.next();
          var rj = dChef.getFoldersByName('RAPPORT JOURNALIER');
          while (rj.hasNext()) {
            var annees = rj.next().getFolders();
            while (annees.hasNext()) {
              var fs = annees.next().getFiles();
              while (fs.hasNext()) indexAdministratif_[fs.next().getName()] = dChef.getName().trim().toUpperCase();
            }
          }
        }
      }
    } catch (e) { /* pas d'ADMINISTRATIF : tant pis */ }
  }
  return indexAdministratif_[nomFichier] || '';
}

var chefsBase_ = null;
function chefsDeLaBase_() {
  if (chefsBase_) return chefsBase_;
  chefsBase_ = {};
  try {
    var ref = DriveApp.getRootFolder().getFoldersByName('REFERENTIEL');
    if (!ref.hasNext()) return chefsBase_;
    var it = ref.next().getFilesByName('Personnel FTS');
    if (!it.hasNext()) return chefsBase_;
    var feuille = SpreadsheetApp.openById(it.next().getId()).getSheetByName('Personnel');
    var v = feuille ? feuille.getDataRange().getDisplayValues() : [];
    for (var i = 1; i < v.length; i++) {
      if (String(v[i][3]).toUpperCase() === 'CHEF DE CHANTIER') {
        var nomComplet = (String(v[i][1]) + ' ' + String(v[i][0])).trim().toUpperCase();
        chefsBase_[cleAtelier_(nomComplet)] = nomComplet;
      }
    }
  } catch (e) {}
  return chefsBase_;
}

function lireChefsDuSuivi_(chantier) {
  var res = {};
  try {
    var it = chantier.getFilesByName('Suivi ' + chantier.getName());
    if (!it.hasNext()) return res;
    var classeur = SpreadsheetApp.openById(it.next().getId());
    var feuille = classeur.getSheetByName('Production');
    var valeurs = feuille ? feuille.getDataRange().getDisplayValues() : [];
    for (var i = 1; i < valeurs.length; i++) {
      var r = valeurs[i];
      if (!r[0] || !r[4]) continue;
      (res[r[0]] = res[r[0]] || []).push({ chef: String(r[4]).trim().toUpperCase(), atelier: r[5] || '' });
    }
    // Jours sans nom du chef : le seul chef de chantier pointé ce jour-là
    var pers = classeur.getSheetByName('Personnel');
    var vp = pers ? pers.getDataRange().getDisplayValues() : [];
    var parJour = {};
    var base = chefsDeLaBase_();
    for (var j = 1; j < vp.length; j++) {
      var nom = String(vp[j][1] || '').trim().toUpperCase();
      if (vp[j][0] && base[cleAtelier_(nom)]) (parJour[vp[j][0]] = parJour[vp[j][0]] || {})[base[cleAtelier_(nom)]] = true;
    }
    Object.keys(parJour).forEach(function (d) {
      var chefs = Object.keys(parJour[d]);
      if (!res[d] && chefs.length === 1) res[d] = [{ chef: chefs[0], atelier: '', devine: true }];
    });
  } catch (e) { /* suivi illisible : chef inconnu */ }
  return res;
}

/** Retire de « _CHEF NON RECONNU » la copie d'un original dont le chef vient d'être retrouvé. */
function retirerCopieInconnue_(racine, annee, nomMois, nom, idSource) {
  var it = racine.getFoldersByName(CHEF_INCONNU);
  if (!it.hasNext()) return;
  var a = it.next().getFoldersByName(annee); if (!a.hasNext()) return;
  var mo = a.next().getFoldersByName(nomMois); if (!mo.hasNext()) return;
  var fs = mo.next().getFilesByName(nom);
  while (fs.hasNext()) {
    var c = fs.next();
    if (String(c.getDescription() || '').indexOf('FTS-SRC:' + idSource + ':') === 0) c.setTrashed(true);
  }
}

function cleAtelier_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/^ATELIER\s*/, '#').replace(/\s+/g, ' ').trim().split(' ').sort().join(' ');
}

// ─── Dossiers de destination ───────────────────────────────────────

function dossierRacine_(nom) {
  var root = DriveApp.getRootFolder();
  var it = root.getFoldersByName(nom);
  return it.hasNext() ? it.next() : root.createFolder(nom);
}

var cacheSousDossiers_ = {};
function sousDossier_(parent, nom) {
  var k = parent.getId() + '|' + nom;
  if (cacheSousDossiers_[k]) return cacheSousDossiers_[k];
  var it = parent.getFoldersByName(nom);
  return (cacheSousDossiers_[k] = it.hasNext() ? it.next() : parent.createFolder(nom));
}

/** Dossier d'un chef : « HUGO LAJUS » retrouve aussi « LAJUS HUGO » (ordre des mots et accents ignorés). */
function dossierChef_(racine, chef) {
  var k = racine.getId() + '|C|' + cleAtelier_(chef);
  if (cacheSousDossiers_[k]) return cacheSousDossiers_[k];
  var it = racine.getFolders(), trouve = null;
  while (it.hasNext() && !trouve) { var d = it.next(); if (cleAtelier_(d.getName()) === cleAtelier_(chef)) trouve = d; }
  return (cacheSousDossiers_[k] = trouve || racine.createFolder(chef));
}

/** Dossier machine central : retrouvé par son N° (« GE60-HUGO - … »), sinon par le nom exact. */
function dossierMachine_(racine, nomDossier) {
  var k = racine.getId() + '|M|' + nomDossier;
  if (cacheSousDossiers_[k]) return cacheSousDossiers_[k];
  var num = nomDossier.indexOf(' - ') > 0 ? nomDossier.split(' - ')[0].trim().toUpperCase() : '';
  var trouve = null;
  if (num) {
    var it = racine.getFolders();
    while (it.hasNext() && !trouve) {
      var d = it.next();
      if (d.getName().trim().toUpperCase().indexOf(num + ' ') === 0) trouve = d;
    }
  }
  return (cacheSousDossiers_[k] = trouve || sousDossier_(racine, nomDossier));
}

// ─── Copie (sans doublon, avec remplacement si corrigé) ───────────

function copierSiBesoin_(source, dossier, nom) {
  var marque = 'FTS-SRC:' + source.getId() + ':' + source.getLastUpdated().getTime();
  var existants = dossier.getFilesByName(nom);
  var remplace = false;
  while (existants.hasNext()) {
    var e = existants.next();
    var d = String(e.getDescription() || '');
    if (d === marque) return 'deja';
    // Même original déjà copié dans une version plus récente : rien à faire
    var m = d.match(/^FTS-SRC:([^:]+):(\d+)$/);
    if (m && m[1] === source.getId() && Number(m[2]) >= source.getLastUpdated().getTime()) return 'deja';
    // Ancienne version (ou rapport refait le même jour) : on la remplace
    e.setTrashed(true);
    remplace = true;
  }
  var copie = source.makeCopy(nom, dossier);
  copie.setDescription(marque);
  return remplace ? 'remplace' : 'copie';
}
