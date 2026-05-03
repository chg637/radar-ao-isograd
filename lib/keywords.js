/**
 * lib/keywords.js — Filtrage par mots-clés et phrases négatives.
 *
 * Toutes les comparaisons sont faites sur des chaînes normalisées (lowercase
 * + accents enlevés + apostrophes Unicode -> ASCII) pour éviter les ratés sur
 * les variations typographiques.
 *
 * Sprint 2.5 — Patch BOAMP (mai 2026)
 *  - Inclusion de keywords_bureautique dans le matching (oubli de la factorisation).
 *  - Matching tolérant aux multi-mots : si un keyword est composé (ex: "plateforme d'évaluation"),
 *    on accepte aussi un avis qui contient tous les tokens significatifs séparément.
 *    Évite de rater "plateforme nationale d'évaluation" ou "évaluation sur plateforme".
 */

const { normalize } = require("./normalize");

const STOPWORDS = new Set([
  "d", "de", "du", "des", "la", "le", "les", "l", "et", "en", "à", "a", "au", "aux",
  "of", "the", "for", "to", "in", "and", "or", "on", "by", "with"
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Vérifie si la notice match au moins un mot-clé FR / EN / bureautique du fichier filters.
 * Stratégie en deux temps :
 *   1) match phrase exacte (rapide, robuste pour les acronymes type DigComp)
 *   2) fallback : pour les phrases multi-mots, tous les tokens significatifs doivent
 *      apparaître comme mots dans le blob (ordre indifférent, stopwords ignorés).
 * Retourne { matched: bool, hits: [string] }.
 */
function matchesKeywords(notice, filters) {
  const blob = normalize(`${notice.objet || ""} ${notice.description || ""} ${notice.acheteur || ""}`);
  const allKw = [
    ...(filters.keywords_fr || []),
    ...(filters.keywords_en || []),
    ...(filters.keywords_bureautique || [])
  ];

  const hits = allKw.filter(kw => {
    const nkw = normalize(kw);
    if (!nkw) return false;
    // 1) phrase exacte
    if (blob.includes(nkw)) return true;
    // 2) fallback multi-mots : tous les tokens significatifs présents
    const tokens = nkw.split(/\s+/).filter(t => t.length > 1 && !STOPWORDS.has(t));
    if (tokens.length < 2) return false;
    return tokens.every(t => new RegExp("\\b" + escapeRegex(t) + "\\b").test(blob));
  });

  return { matched: hits.length > 0, hits };
}

/**
 * Vérifie qu'aucune phrase négative n'apparaît dans l'objet ou la description.
 * Renvoie { ok: bool, phrase: string|null }.
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
