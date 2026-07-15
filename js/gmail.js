/**
 * gmail.js — Envoi de mail via l'API Gmail, avec le token partagé FTSAuth.
 * Utilisé pour l'instant uniquement par Fiche Matériel, mais partagé
 * au cas où un autre module aurait besoin d'envoyer un mail.
 */

const FTSGmail = (() => {
  function authHeader() {
    if (!window.FTSAuth || !FTSAuth.isSignedIn()) {
      throw new Error("Non connecté : impossible d'envoyer un mail.");
    }
    return { Authorization: "Bearer " + FTSAuth.getToken() };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = reader.result.split(",")[1];
        resolve((b64.match(/.{1,76}/g) || []).join("\r\n"));
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Encode un texte contenant des caractères accentués au format
   * RFC 2047 (encoded-word), requis pour les en-têtes email (Subject,
   * From, To...). Sans ça, les accents et tirets spéciaux s'affichent
   * comme des caractères illisibles chez le destinataire, même si le
   * corps du mail (encodé différemment) reste correct.
   */
  function encodeHeader(text) {
    const b64 = btoa(unescape(encodeURIComponent(text)));
    return `=?UTF-8?B?${b64}?=`;
  }

  /**
   * Envoie un mail avec une pièce jointe PDF.
   * @param {Object} opts
   * @param {string[]} opts.to
   * @param {string} opts.subject
   * @param {string} opts.body       texte brut
   * @param {Blob} opts.attachment
   * @param {string} opts.fileName
   */
  async function envoyerAvecPieceJointe({ to, subject, body, attachment, fileName }) {
    const pdfB64 = await blobToBase64(attachment);
    const boundary = "FTSboundary" + Date.now();

    const mime = [
      `From: me`,
      `To: ${to.join(", ")}`,
      `Subject: ${encodeHeader(subject)}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      body,
      ``,
      `--${boundary}`,
      `Content-Type: application/pdf; name="${fileName}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${fileName}"`,
      ``,
      pdfB64,
      `--${boundary}--`,
    ].join("\r\n");

    const encoded = btoa(unescape(encodeURIComponent(mime)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ raw: encoded }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Erreur envoi mail (${res.status})`);
    }
    return res.json();
  }

  return { envoyerAvecPieceJointe };
})();

// Exposition explicite sur window : une déclaration top-level en const/let
// ne crée PAS de propriété window.FTSGmail automatiquement (contrairement à var),
// alors que tout le reste du code vérifie window.FTSGmail avant utilisation.
window.FTSGmail = FTSGmail;
