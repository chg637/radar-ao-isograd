/**
 * lib/keywords.js — Filtrage par mots-clés et phrases négatives.
 *
 * Toutes les comparaisons sont faites sur des chaînes normalisées (lowercase
 * + accents enlevés + apostrophes Unicode -> ASCII) pour éviter les ratés sur
 * les variations typographiques.
 */

const { normalize } = require("./normalize");

/**
 * Vérifie si la notice match au moins un mot-clé FR ou EN du fichier filters.
 * Retourne { matched: bool, hits: [string] }.
 */
function matchesKeywords(notice, filters) {
  const blob = normalize(`${notice.objet || ""} ${notice.description || ""} ${notice.acheteur || ""}`);
  const allKw = [...(filters.keywords_fr || []), ...(filters.keywords_en || [])];
  const hits = allKw.filter(kw => blob.includes(normalize(kw)));
  return { matched: hits.length > 0, hits };
}

/**
 * Vérifie qu'aucune phrase négative n'apparaît dans l'objet ou la description.
 * Renvoie { ok: bool, phrase: string|null }.
 *
 * Sert à virer les faux positifs sémantiques (ex: "passation" qui match
 * "passation de marché" au lieu de "passation d'épreuves").
 */
function passesNegativePhrases(notice, phrases) {
  const list = (phrases || []).map(p => normalize(p));
  if (!list.length) return { ok: true, phrase: null };
  const blob = normalize(`${notice.objet || ""} ${notice.description || ""}`);
  for (const p of list) {
    if (blob.includes(p)) return { ok: false, phrase: p };
  }
  return { ok: true, phrase: null };
}

/**
 * Détecte le segment acheteur depuis filters.buyer_segment_rules.
 * defaultSegment est utilisé si rien ne matche (ex: "Autre" pour TED/BOAMP,
 * "ESR" pour Profils Tier-1 qui sont par construction de l'enseignement sup).
 */
function detectSegment(notice, filters, defaultSegment = "Autre") {
  const buyer = normalize(notice.acheteur);
  for (const rule of filters.buyer_segment_rules || []) {
    if (rule.match.some(m => buyer.includes(normalize(m)))) return rule.segment;
  }
  return defaultSegment;
}

module.exports = {
  matchesKeywords,
  passesNegativePhrases,
  detectSegment
};
