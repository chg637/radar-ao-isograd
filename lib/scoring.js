/**
 * lib/scoring.js — Auto-scoring unifié pour TED, BOAMP, Profils.
 *
 * Le scoring de base est identique pour les 3 sources, on paramètre les bonus
 * via options.{segmentBoost, profilBoost} pour respecter les particularités :
 *   - TED : pas de boost (CPV déjà filtrant)
 *   - BOAMP : +5 fit si segment ESR ou Formation pro (pas de CPV donc on pondère
 *     par segment pour rester en cœur de cible)
 *   - Profils : +5 fit toujours (le profil est par construction un compte cible)
 *
 * Sortie : { total: 0..100, detail: { fit, size, tech, com, admin, delay } }
 */

const { normalize } = require("./normalize");

function autoScore(notice, filters, options = {}) {
  const { segmentBoost = false, profilBoost = false } = options;

  let total = 0;
  const detail = {};
  const blob = normalize(`${notice.objet || ""} ${notice.description || ""}`);

  // === 1. Fit produit (0-40) ===
  const strongMatch = (filters.scoring.fit_keywords_strong || []).some(k => blob.includes(normalize(k)));
  const mediumMatch = (filters.scoring.fit_keywords_medium || []).some(k => blob.includes(normalize(k)));
  let fit = 10;
  if (strongMatch) fit = 40;
  else if (mediumMatch) fit = 25;

  // Bonus CPV very_high (utile pour TED qui a un CPV)
  const cpvWeight = (filters.cpv_codes || []).find(c => c.code === notice.cpv)?.weight;
  if (cpvWeight === "very_high" && fit < 40) fit = Math.min(40, fit + 5);

  // Bonus segment cœur de cible (BOAMP)
  if (segmentBoost && fit < 40 && (notice.segment === "ESR" || notice.segment === "Formation pro")) {
    fit = Math.min(40, fit + 5);
  }

  // Bonus profil Tier-1 (Profils) — toujours +5 car par construction cible
  if (profilBoost && fit < 40) {
    fit = Math.min(40, fit + 5);
  }

  detail.fit = fit;
  total += fit;

  // === 2. Taille / budget (0-15) ===
  let size = 5;
  if (notice.montant >= 1000) size = 15;
  else if (notice.montant >= 215) size = 13;
  else if (notice.montant >= 90) size = 10;
  else if (notice.montant === 0) size = 8; // valeur non publiée, mid-point
  detail.size = size;
  total += size;

  // === 3. Faisabilité technique (0-15) ===
  let tech = 12;
  const techBonus = (filters.scoring.tech_keywords_bonus || []).some(k => blob.includes(normalize(k)));
  if (techBonus) tech = 14;
  detail.tech = tech;
  total += tech;

  // === 4. Faisabilité commerciale (0-15) ===
  // Auto = 5 par défaut. Charles ajuste à la main dans le dashboard.
  detail.com = 5;
  total += 5;

  // === 5. Exigences administratives (0-10) ===
  // Auto = 7 par défaut.
  detail.admin = 7;
  total += 7;

  // === 6. Délai (0-5) ===
  let delay = 0;
  if (notice.deadline) {
    const days = Math.round((new Date(notice.deadline) - new Date()) / 86400000);
    if (days > 30) delay = 5;
    else if (days >= 20) delay = 3;
    else if (days >= 15) delay = 1;
  } else {
    delay = 3; // pas de deadline = inconnue, mid-point
  }
  detail.delay = delay;
  total += delay;

  return { total, detail };
}

/**
 * Détermine le statut go/cond/no à partir du score et des seuils du config.
 */
function scoreStatus(score, thresholds) {
  if (score >= (thresholds.go || 75)) return "go";
  if (score >= (thresholds.conditional || 55)) return "cond";
  return "no";
}

module.exports = { autoScore, scoreStatus };
