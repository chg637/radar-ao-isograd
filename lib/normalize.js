/**
 * lib/normalize.js — Helpers de normalisation de chaînes pour le matching.
 *
 * Le BOAMP utilise souvent l'apostrophe typographique (U+2019) alors que nos
 * filtres sont écrits avec l'ASCII (U+0027). On normalise tout en ASCII pour
 * que le matching marche dans les deux sens.
 */

/**
 * Lowercase + suppression des accents + apostrophes Unicode -> ASCII.
 * Utilisé pour matcher du texte saisi par humain dans des configs.
 */
function normalize(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")        // accents
    .replace(/[‘’ʼ]/g, "'")  // apostrophes typographiques -> ASCII
    .replace(/[“”]/g, '"');       // guillemets typographiques -> ASCII
}

/**
 * Normalisation moins agressive : juste l'apostrophe + lowercase, on garde
 * les accents (utile pour comparer des libellés affichables).
 */
function normalizeLight(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"');
}

module.exports = { normalize, normalizeLight };
