/**
 * DUPLIQUER LA TRAME CHANTIER — Google Apps Script
 *
 * Utilisation :
 * 1. Aller sur https://script.google.com
 * 2. Créer un nouveau projet, coller ce code
 * 3. Renseigner les 3 valeurs ci-dessous (ID_TRAME, ID_PARENT, NOM_NOUVEAU_CHANTIER)
 * 4. Cliquer sur "Exécuter" (bouton ▶) — autoriser l'accès à Drive la première fois
 * 5. Le nouveau dossier chantier apparaît dans Drive, avec toute l'arborescence
 *    et tous les fichiers de la trame copiés dedans.
 *
 * Pour retrouver un ID de dossier : ouvrir le dossier dans Drive, l'ID est
 * dans l'URL après "folders/" — ex: https://drive.google.com/drive/folders/ID_ICI
 */

// ─── À MODIFIER À CHAQUE NOUVEAU CHANTIER ──────────────────────
const ID_TRAME = "COLLER_ICI_ID_DU_DOSSIER_TRAME";
const ID_PARENT = "COLLER_ICI_ID_DU_DOSSIER_OU_CREER_LE_CHANTIER";
const NOM_NOUVEAU_CHANTIER = "25 FTS XXX - NOM DU CHANTIER";
// ────────────────────────────────────────────────────────────

function dupliquerTrame() {
  const trame = DriveApp.getFolderById(ID_TRAME);
  const parent = DriveApp.getFolderById(ID_PARENT);

  const nouveauDossier = copierDossierRecursif(trame, parent, NOM_NOUVEAU_CHANTIER);

  Logger.log("Chantier créé : " + nouveauDossier.getUrl());
  return nouveauDossier.getUrl();
}

/**
 * Copie récursivement un dossier (sous-dossiers + fichiers) sous un
 * nouveau parent, avec un nouveau nom pour le dossier racine copié.
 */
function copierDossierRecursif(dossierSource, nouveauParent, nouveauNom) {
  const nouveauDossier = nouveauParent.createFolder(nouveauNom || dossierSource.getName());

  // Copier les fichiers du dossier source
  const fichiers = dossierSource.getFiles();
  while (fichiers.hasNext()) {
    const fichier = fichiers.next();
    fichier.makeCopy(fichier.getName(), nouveauDossier);
  }

  // Copier récursivement les sous-dossiers (en gardant leur nom d'origine)
  const sousDossiers = dossierSource.getFolders();
  while (sousDossiers.hasNext()) {
    const sousDossier = sousDossiers.next();
    copierDossierRecursif(sousDossier, nouveauDossier, sousDossier.getName());
  }

  return nouveauDossier;
}
