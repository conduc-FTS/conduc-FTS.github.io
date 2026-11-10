/**
 * mail-envoi.js — choix de la façon d'envoyer un mail depuis la Supervision.
 *
 *  - compte Gmail (conduc.fts, chefs…) : envoi direct par l'API Gmail
 *    (js/gmail.js), pièces jointes comprises, comme avant ;
 *  - compte Google créé sur une adresse pro @fts-btp.fr (sans Gmail) :
 *    « envoi de secours » — le mail s'ouvre pré-rempli dans Outlook, depuis
 *    l'adresse pro de la personne (avec sa signature Outlook) ; les PDF sont
 *    téléchargés sur l'ordinateur pour être glissés dans le mail.
 *
 * Plus tard (autorisation du service informatique, voir
 * claude/mail-informatique-outlook.md) : envoi direct par Outlook (Microsoft
 * Graph) à la place de l'envoi de secours — seul ce fichier changera.
 *
 * Depuis le 10/11/2026 (demande de Clément) : TOUS les mails de la
 * Supervision s'ouvrent dans Outlook, même connecté avec un compte Gmail
 * (conduc.fts) — le mail part toujours de l'adresse pro @fts-btp.fr.
 * L'envoi direct Gmail reste dans le code (ENVOI_GMAIL) pour revenir en
 * arrière si besoin.
 *
 * FTSMail.mode() → "gmail" | "outlook"
 * FTSMail.ouvrirOutlook({ to, cc, subject, body }) → { tronque: bool }
 */
const FTSMail = (() => {
  const LIMITE_URL = 1900; // au-delà, certains Outlook coupent le texte du mail
  const ENVOI_GMAIL = false; // true = ancien comportement (envoi direct pour les comptes Gmail)

  function emailConnecte() {
    try {
      if (window.FTSAuth && FTSAuth.emailMemorise) return String(FTSAuth.emailMemorise() || "").toLowerCase();
    } catch (e) {}
    return "";
  }

  /** Outlook (mail pré-rempli). Si ENVOI_GMAIL : Gmail pour une adresse Gmail. */
  function mode(email) {
    if (!ENVOI_GMAIL) return "outlook";
    const e = String(email == null ? emailConnecte() : email).trim().toLowerCase();
    if (!e) return "gmail"; // inconnu : comportement d'avant
    return /@(gmail|googlemail)\.com$/.test(e) ? "gmail" : "outlook";
  }

  const enc = (s) => encodeURIComponent(String(s || "")).replace(/%20/g, "%20");

  function adresseMailto({ to, cc, subject, body }) {
    const params = [];
    if (cc && cc.length) params.push("cc=" + enc(cc.join(";")));
    params.push("subject=" + enc(subject));
    if (body != null) params.push("body=" + enc(String(body).replace(/\r?\n/g, "\r\n")));
    return `mailto:${(to || []).map((x) => encodeURIComponent(x).replace(/%40/g, "@")).join(";")}?${params.join("&")}`;
  }

  /**
   * Ouvre le mail pré-rempli dans le logiciel de messagerie (Outlook).
   * À appeler juste après un clic (copie du texte dans le presse-papiers).
   * Texte trop long pour un lien mailto : il est copié dans le presse-papiers
   * et le mail contient une ligne « colle le texte ici ».
   */
  function ouvrirOutlook(o) {
    let url = adresseMailto(o);
    let tronque = false;
    if (url.length > LIMITE_URL) {
      tronque = true;
      try { if (navigator.clipboard) navigator.clipboard.writeText(String(o.body || "")); } catch (e) {}
      url = adresseMailto({ ...o, body: "(Texte copié : colle-le ici avec Ctrl+V, puis supprime cette ligne)" });
    }
    const a = document.createElement("a");
    a.href = url;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { tronque, url };
  }

  return { mode, ouvrirOutlook, adresseMailto, emailConnecte };
})();
if (typeof window !== "undefined") window.FTSMail = FTSMail;
if (typeof module !== "undefined") module.exports = FTSMail;
