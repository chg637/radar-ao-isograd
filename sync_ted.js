#!/usr/bin/env node
/**
 * Sync TED — Sprint 1 du Radar AO Isograd
 *
 * Pull les avis de marchés publics européens publiés sur TED
 * (Tenders Electronic Daily) sur la fenêtre des 7 derniers jours,
 * filtre par CPV + mots-clés, auto-score, et écrit le résultat
 * dans data/ted_YYYY-MM-DD.json.
 *
 * Documentation API : https://docs.ted.europa.eu/api/latest/search.html
 *
 * Usage local :   node sync_ted.js
 * Usage CI    :   appelé par .github/workflows/sync-ao.yml
 */

const path = require("path");
const { loadJSON, ensureDir, todayISO, daysAgoISO, makeLogger, writeJSON } = require("./lib/io");
const { matchesKeywords, passesNegativePhrases, detectSegment } = require("./lib/keywords");
const { autoScore, scoreStatus } = require("./lib/scoring");

const TED_API_URL = "https://api.ted.europa.eu/v3/notices/search";
const CONFIG_PATH = path.join(__dirname, "config", "filters.json");
const DATA_DIR = path.join(__dirname, "data");
const PAGE_SIZE = 100;
const MAX_PAGES = 5; // garde-fou : 500 avis max par run

const log = makeLogger();

async function searchTED(config, page = 1) {
  const cpvList = config.cpv_codes.map(c => c.code).join(" OR classification-cpv=");
  const countryFilter = config.countries.map(c => `place-of-performance=${c}`).join(" OR ");
  const dateFrom = daysAgoISO(config.publication_window_days).replace(/-/g, "");
  const dateTo = todayISO().replace(/-/g, "");

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
        "User-Agent": "Isograd-Radar-AO/2.0 (sprint2.5)"
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
function normalizeNotice(raw) {
  const flatten = v => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) {
      const parts = v.map(flatten).filter(Boolean);
      return Array.from(new Set(parts)).join(" / ");
    }
    if (typeof v === "object") {
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
    montant: totalValue ? Math.round(Number(totalValue) / 1000) : 0,
    publication: pubDate ? pubDate.slice(0, 10) : "",
    source: "TED",
    url
  };
}

async function main() {
  log("=== Sync TED — démarrage ===");
  const config = loadJSON(CONFIG_PATH);
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

  const enriched = [];
  let rejectedByNeg = 0;
  for (const raw of allNotices) {
    const n = normalizeNotice(raw);
    const { matched, hits } = matchesKeywords(n, config);
    if (!matched) continue;
    const negFilter = passesNegativePhrases(n, config.negative_phrases);
    if (!negFilter.ok) { rejectedByNeg++; continue; }
    n.segment = detectSegment(n, config);
    n.keyword_hits = hits;
    const { total: score, detail } = autoScore(n, config);
    n.score = score;
    n.score_detail = detail;
    n.score_status = scoreStatus(score, config.scoring.thresholds);
    n.notes = "";
    n.auto = true;
    enriched.push(n);
  }

  enriched.sort((a, b) => b.score - a.score);

  const today = todayISO();
  const out = {
    generated_at: new Date().toISOString(),
    source: "TED",
    window_days: config.publication_window_days,
    total_fetched: allNotices.length,
    total_matched: enriched.length,
    total_go: enriched.filter(n => n.score_status === "go").length,
    notices: enriched
  };

  writeJSON(path.join(DATA_DIR, `ted_${today}.json`), out);
  log(`Écrit : data/ted_${today}.json`);
  log(`Récap : ${enriched.length} matchés / ${allNotices.length} avis | rejetés (négatifs) : ${rejectedByNeg} | ${out.total_go} en Go ferme`);
  log("=== Sync TED — terminé ===");
}

main().catch(e => {
  console.error("ERREUR FATALE TED :", e);
  process.exit(1);
});
