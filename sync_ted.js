#!/usr/bin/env node
/**
 * Sync TED — Sprint 1 du Radar AO Isograd
 *
 * Pull les avis de marchés publics européens publiés sur TED
 * (Tenders Electronic Daily) sur la fenêtre des 7 derniers jours,
 * filtre par CPV + mots-clés, auto-score, et écrit le résultat
 * dans data/ted_YYYY-MM-DD.json + data/latest.json.
 *
 * Documentation API : https://docs.ted.europa.eu/api/latest/search.html
 *
 * Usage local :   node sync_ted.js
 * Usage CI    :   appelé par .github/workflows/sync-ao.yml
 */

const fs = require("fs");
const path = require("path");

// === Constantes ===
const TED_API_URL = "https://api.ted.europa.eu/v3/notices/search";
const CONFIG_PATH = path.join(__dirname, "config", "filters.json");
const DATA_DIR = path.join(__dirname, "data");
const PAGE_SIZE = 100;
const MAX_PAGES = 5; // garde-fou : 500 avis max par run, large pour notre périmètre

// === Helpers ===
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

// === TED API call ===
/**
 * Appelle l'API TED Search v3.
 * Format de requête : "expert query" sur les champs eForms.
 * Référence des champs : https://docs.ted.europa.eu/api/latest/search.html
 */
async function searchTED(config, page = 1) {
  const cpvList = config.cpv_codes.map(c => c.code).join(" OR classification-cpv=");
  const countryFilter = config.countries.map(c => `place-of-performance=${c}`).join(" OR ");
  const dateFrom = daysAgoISO(config.publication_window_days).replace(/-/g, "");
  const dateTo = todayISO().replace(/-/g, "");

  // Expert query — combine CPV, pays, fenêtre de publication
  const query = [
    `(classification-cpv=${cpvList})`,
    `(${countryFilter})`,
    `publication-date >= ${dateFrom}`,
    `publication-date <= ${dateTo}`
  ].join(" AND ");

  const payload = {
    query,
    fields: [
      "publication-number",
      "notice-title",
      "buyer-name",
      "buyer-country",
      "place-of-performance",
      "classification-cpv",
      "deadline-receipt-tender-date-lot",
      "total-value",
      "links",
      "publication-date",
      "description-lot"
    ],
    limit: PAGE_SIZE,
    page,
    scope: "ACTIVE"
  };

  log(`TED API page ${page}, query length ${query.length}`);

  let response;
  try {
    response = await fetch(TED_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Isograd-Radar-AO/1.0 (sprint1)"
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    log(`ERREUR réseau TED : ${e.message}`);
    return { notices: [], total: 0 };
  }

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    log(`TED API HTTP ${response.status} : ${txt.slice(0, 300)}`);
    return { notices: [], total: 0 };
  }

  const data = await response.json();
  return {
    notices: data.notices || [],
    total: data.totalNoticeCount || 0
  };
}

// === Normalisation d'un avis TED ===
// Structures rencontrées :
//   - string                : "FRA"
//   - array de strings      : ["FRA","FRA"]  → on prend le premier
//   - { fra: ["..."] }      : objet par langue → on prend FRA puis ENG
//   - { amount, currency }  : pour les valeurs financières
function normalizeNotice(raw, config) {
  const flatten = v => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) {
      const parts = v.map(flatten).filter(Boolean);
      return Array.from(new Set(parts)).join(" / ");
    }
    if (typeof v === "object") {
      // objet par langue : essaie fra, fr, FR, eng, en, EN, puis premier non vide
      const langs = ["fra", "fr", "FR", "FRA", "eng", "en", "EN", "ENG"];
      for (const k of langs) if (v[k]) return flatten(v[k]);
      const first = Object.values(v).find(x => x);
      return flatten(first);
    }
    return String(v);
  };

  const title = flatten(raw["notice-title"]) || flatten(raw["description-lot"]).slice(0, 200);
  const buyer = flatten(raw["buyer-name"]);
  const country = flatten(raw["buyer-country"]) || flatten(raw["place-of-performance"]);
  const cpv = flatten(raw["classification-cpv"]).split(" / ")[0];
  const deadlineRaw = flatten(raw["deadline-receipt-tender-date-lot"]);
  const totalValue = raw["total-value"]?.amount ?? (typeof raw["total-value"] === "number" ? raw["total-value"] : null);
  const pubDate = flatten(raw["publication-date"]);
  const ref = flatten(raw["publication-number"]);
  const description = flatten(raw["description-lot"]);
  const url = raw.links?.html?.FRA || raw.links?.html?.FR || raw.links?.html?.ENG || raw.links?.html?.EN || raw.links?.xml?.MUL || "";

  return {
    id: ref,
    ref,
    acheteur: buyer,
    objet: title,
    description,
    cpv,
    pays: country,
    deadline: deadlineRaw ? deadlineRaw.slice(0, 10) : "",
    montant: totalValue ? Math.round(Number(totalValue) / 1000) : 0, // converti en k€
    publication: pubDate ? pubDate.slice(0, 10) : "",
    source: "TED",
    url
  };
}

// === Filtrage par mots-clés ===
function matchesKeywords(notice, config) {
  const blob = `${notice.objet || ""} ${notice.description || ""} ${notice.acheteur || ""}`.toLowerCase();
  const allKw = [...config.keywords_fr, ...config.keywords_en];
  const hits = allKw.filter(kw => blob.includes(kw.toLowerCase()));
  return { matched: hits.length > 0, hits };
}

// === Détection du segment acheteur ===
// Normalise casse et accents pour matcher "UNIVERSITE" comme "université".
function normalize(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function detectSegment(notice, config) {
  const buyer = normalize(notice.acheteur);
  for (const rule of config.buyer_segment_rules) {
    if (rule.match.some(m => buyer.includes(normalize(m)))) return rule.segment;
  }
  return "Autre";
}

// === Auto-scoring v1 ===
function autoScore(notice, config, keywordHits) {
  let total = 0;
  const detail = {};

  // 1. Fit produit (0-40)
  const blob = `${notice.objet || ""} ${notice.description || ""}`.toLowerCase();
  const strongMatch = config.scoring.fit_keywords_strong.some(k => blob.includes(k.toLowerCase()));
  const mediumMatch = config.scoring.fit_keywords_medium.some(k => blob.includes(k.toLowerCase()));
  let fit = 10;
  if (strongMatch) fit = 40;
  else if (mediumMatch) fit = 25;
  // bonus CPV very_high
  const cpvWeight = config.cpv_codes.find(c => c.code === notice.cpv)?.weight;
  if (cpvWeight === "very_high" && fit < 40) fit = Math.min(40, fit + 5);
  detail.fit = fit;
  total += fit;

  // 2. Taille / budget (0-15)
  let size = 5;
  if (notice.montant >= 1000) size = 15;
  else if (notice.montant >= 215) size = 13;
  else if (notice.montant >= 90) size = 10;
  else if (notice.montant === 0) size = 8; // valeur non publiée, on prend un mid-point
  detail.size = size;
  total += size;

  // 3. Faisabilité technique (0-15)
  let tech = 12;
  const techBonus = config.scoring.tech_keywords_bonus.some(k => blob.includes(k.toLowerCase()));
  if (techBonus) tech = 14;
  detail.tech = tech;
  total += tech;

  // 4. Faisabilité commerciale (0-15)
  // Auto = 5 par défaut. Charles ajuste à la main dans le dashboard.
  detail.com = 5;
  total += 5;

  // 5. Exigences administratives (0-10)
  // Auto = 7 par défaut.
  detail.admin = 7;
  total += 7;

  // 6. Délai (0-5)
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

// === Main ===
async function main() {
  log("=== Sync TED — démarrage ===");
  const config = loadConfig();
  ensureDir(DATA_DIR);

  let allNotices = [];
  let page = 1;
  let totalAvailable = null;

  while (page <= MAX_PAGES) {
    const { notices, total } = await searchTED(config, page);
    if (totalAvailable === null) totalAvailable = total;
    if (notices.length === 0) break;
    allNotices.push(...notices);
    log(`Page ${page} : ${notices.length} avis (cumul ${allNotices.length} / total annoncé ${total})`);
    if (allNotices.length >= total) break;
    page++;
  }

  log(`TED : ${allNotices.length} avis récupérés sur la fenêtre`);

  // Normalisation + filtrage
  const enriched = [];
  for (const raw of allNotices) {
    const n = normalizeNotice(raw, config);
    const { matched, hits } = matchesKeywords(n, config);
    if (!matched) continue; // on garde uniquement ceux qui matchent un mot-clé
    n.segment = detectSegment(n, config);
    n.keyword_hits = hits;
    const { total: score, detail } = autoScore(n, config, hits);
    n.score = score;
    n.score_detail = detail;
    n.score_status = score >= config.scoring.thresholds.go ? "go"
                   : score >= config.scoring.thresholds.conditional ? "cond"
                   : "no";
    n.notes = "";
    n.auto = true;
    enriched.push(n);
  }

  // Tri par score décroissant
  enriched.sort((a, b) => b.score - a.score);

  // Output JSON
  const today = todayISO();
  const outDated = path.join(DATA_DIR, `ted_${today}.json`);
  const outLatest = path.join(DATA_DIR, "latest.json");

  const output = {
    generated_at: new Date().toISOString(),
    source: "TED",
    window_days: config.publication_window_days,
    total_fetched: allNotices.length,
    total_matched: enriched.length,
    total_go: enriched.filter(n => n.score_status === "go").length,
    notices: enriched
  };

  fs.writeFileSync(outDated, JSON.stringify(output, null, 2));
  fs.writeFileSync(outLatest, JSON.stringify(output, null, 2));

  log(`Écrit : ${outDated}`);
  log(`Écrit : ${outLatest}`);
  log(`Récap : ${enriched.length} AO matchés, dont ${output.total_go} en "Go ferme"`);
  log("=== Sync TED — terminé ===");
}

// Run
main().catch(e => {
  console.error("ERREUR FATALE :", e);
  process.exit(1);
});
