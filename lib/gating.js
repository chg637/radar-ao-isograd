/**
 * lib/gating.js — Gating v2 (août 2026).
 *
 * Implémente côté repo le référentiel de filtrage qui était jusqu'ici appliqué
 * à la main par l'agent du radar hebdo (spec "v2 — 18 mai 2026") :
 *   - classification CPV : core / secondary / blacklist / unknown
 *   - stop-words sémantiques (avec overrides contextuels)
 *   - bigrammes contextuels : requis pour valider un keyword solo ambigu
 *
 * Annotations ajoutées à chaque notice :
 *   - cpv_class        : "core" | "secondary" | "unknown" | "blacklist"
 *   - bigrams_matched  : [string]
 *   - stop_hits        : [string]
 *   - quality_flag     : "actionable" | "noise"
 *   - gating_reason    : cause de l'écartage/plafonnement (traçabilité)
 *
 * Effets sur le score :
 *   - CPV blacklist            → score 0, score_status "filtered"
 *   - stop-word sans override  → score 0, score_status "filtered"
 *   - hits uniquement solo ambigus sans bigramme → score plafonné à 35, status "no"
 *
 * Le score brut d'avant gating est conservé dans score_raw pour audit.
 * Toutes les listes vivent dans config/filters.json → bloc "gating".
 */

const { normalize } = require("./normalize");

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match word-boundary pour un token unique, includes pour une phrase. */
function hitPhrase(blob, phrase) {
  const np = normalize(phrase);
  if (!np) return false;
  if (!/\s/.test(np)) {
    // Même tolérance pluriel que lib/keywords.matchSingle
    return new RegExp("\\b" + escapeRegex(np) + "(?:s|x)?\\b", "i").test(blob);
  }
  return blob.includes(np);
}

/**
 * Classe le CPV d'une notice.
 * Ordre : core → secondary → codes déjà whitelistés dans filters.cpv_codes
 * (exception : un code que Charles a explicitement mis en cpv_codes, comme
 * 73111000 psychométrie, ne doit pas être tué par le préfixe blacklist 73*)
 * → blacklist (codes exacts puis préfixes) → unknown.
 */
function classifyCPV(cpv, filters) {
  const g = filters.gating || {};
  if (!cpv) return "unknown";
  if ((g.whitelist_cpv_core || []).includes(cpv)) return "core";
  if ((g.whitelist_cpv_secondary || []).includes(cpv)) return "secondary";
  if ((filters.cpv_codes || []).some(c => c.code === cpv)) return "secondary";
  if ((g.blacklist_cpv_exact || []).includes(cpv)) return "blacklist";
  if ((g.blacklist_cpv_prefix || []).some(p => cpv.startsWith(p))) return "blacklist";
  return "unknown";
}

/**
 * Applique le gating v2 à une notice déjà scorée. Mute la notice en place
 * et la retourne. Compteurs de causes remontés via le paramètre stats
 * (objet mutable { filtered_cpv_blacklist, filtered_stopword, capped_no_context }).
 */
function applyGating(notice, filters, stats = {}) {
  const g = filters.gating || {};
  const blob = normalize(`${notice.objet || ""} ${notice.description || ""}`);

  notice.score_raw = notice.score;
  notice.cpv_class = classifyCPV(notice.cpv, filters);

  // Bigrammes contextuels présents dans la notice
  notice.bigrams_matched = (g.context_bigrams || []).filter(b => hitPhrase(blob, b));

  // Stop-words : matchent sauf si un de leurs overrides est présent
  notice.stop_hits = [];
  for (const rule of g.stop_words || []) {
    const phrase = typeof rule === "string" ? rule : rule.phrase;
    const overrides = typeof rule === "string" ? [] : (rule.override || []);
    if (!hitPhrase(blob, phrase)) continue;
    const overridden = overrides.some(o => hitPhrase(blob, o));
    if (!overridden) notice.stop_hits.push(phrase);
  }

  // === Verdicts, dans l'ordre de sévérité ===

  // 1. CPV blacklisté → écartage direct
  if (notice.cpv_class === "blacklist") {
    notice.score = 0;
    notice.score_status = "filtered";
    notice.quality_flag = "noise";
    notice.gating_reason = `CPV blacklist (${notice.cpv})`;
    stats.filtered_cpv_blacklist = (stats.filtered_cpv_blacklist || 0) + 1;
    return notice;
  }

  // 2. Stop-word non overridé → écartage
  if (notice.stop_hits.length > 0) {
    notice.score = 0;
    notice.score_status = "filtered";
    notice.quality_flag = "noise";
    notice.gating_reason = `stop-word : ${notice.stop_hits.join(", ")}`;
    stats.filtered_stopword = (stats.filtered_stopword || 0) + 1;
    return notice;
  }

  // 3. Tous les hits sont des keywords solo ambigus, sans bigramme contextuel
  //    → plafonnement à 35 (pas d'écartage : un humain peut repêcher)
  const soloSet = new Set((g.solo_ambiguous_keywords || []).map(k => normalize(k)));
  const hits = notice.keyword_hits || [];
  const allSolo = hits.length > 0 && hits.every(h => soloSet.has(normalize(h)));
  if (allSolo && notice.bigrams_matched.length === 0) {
    notice.score = Math.min(notice.score, 35);
    notice.score_status = "no";
    notice.quality_flag = "noise";
    notice.gating_reason = "keyword solo ambigu sans bigramme contextuel";
    stats.capped_no_context = (stats.capped_no_context || 0) + 1;
    return notice;
  }

  notice.quality_flag = notice.score >= 60 ? "actionable" : "noise";
  notice.gating_reason = "";
  return notice;
}

module.exports = { applyGating, classifyCPV };
