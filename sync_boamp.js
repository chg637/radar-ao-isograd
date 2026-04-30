#!/usr/bin/env node
/**
 * Sync BOAMP — Sprint 2 du Radar AO Isograd
 *
 * Pull les avis du BOAMP (Bulletin Officiel des Annonces des Marchés Publics)
 * via l'API Opendatasoft publique : https://boamp-datadila.opendatasoft.com
 *
 * Avantages vs flux ATOM :
 *  - Réponse JSON native (pas de parser XML)
 *  - Filtrage SQL-like côté serveur (search, where, dateparution)
 *  - Pagination claire
 *  - Dataset complet, pas limité aux 50 dernières
 *
 * Usage local :   node sync_boamp.js
 * Usage CI    :   appelé par .github/workflows/sync-ao.yml
 */

const path = require("path");
const { loadJSON, ensureDir, todayISO, daysAgoISO, makeLogger, writeJSON } = require("./lib/io");
const { matchesKeywords, passesNegativePhrases, detectSegment } = require("./lib/keywords");
const { autoScore, scoreStatus } = require("./lib/scoring");
const { normalize } = require("./lib/normalize");

const FILTERS_PATH = path.join(__dirname, "config", "filters.json");
const BOAMP_CONFIG_PATH = path.join(__dirname, "config", "boamp.json");
const DATA_DIR = path.join(__dirname, "data");
const FETCH_TIMEOUT_MS = 30000;

const log = makeLogger("boamp");

function escapeForSearch(term) {
  return term.replace(/"/g, '\\"');
}

function buildWhereClause(filters, boampConfig) {
  const window = boampConfig.window_days || 7;
  const dateFrom = daysAgoISO(window);

  // ODSQL veut (search("X") OR search("Y") OR search("Z")), pas search("X OR Y").
  const allKw = [
    ...(filters.keywords_fr || []),
    ...(filters.keywords_en || []),
    ...(boampConfig.search_terms_extra || [])
  ];
  const searchClause = "(" +
    allKw.map(kw => `search("${escapeForSearch(kw)}")`).join(" OR ") +
    ")";

  const natures = boampConfig.natures_libelle || [];
  const natureClause = natures.length
    ? "(" + natures.map(n => `nature_libelle = "${escapeForSearch(n)}"`).join(" OR ") + ")"
    : null;

  const parts = [
    searchClause,
    `dateparution >= "${dateFrom}"`
  ];
  if (natureClause) parts.push(natureClause);

  return parts.join(" AND ");
}

async function fetchPage(boampConfig, where, offset) {
  const url = new URL(boampConfig.api_endpoint);
  url.searchParams.set("limit", String(boampConfig.page_size || 100));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("where", where);
  if (boampConfig.order_by) url.searchParams.set("order_by", boampConfig.order_by);

  const controller = new AbortController();
  const tm = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Isograd-Radar-AO/2.0 (sprint2.5 boamp)"
      },
      signal: controller.signal
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} : ${txt.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(tm);
  }
}

function tryParseDonnees(donneesStr) {
  if (!donneesStr) return null;
  try {
    return typeof donneesStr === "string" ? JSON.parse(donneesStr) : donneesStr;
  } catch {
    return null;
  }
}

function extractMontantKEur(record) {
  const donnees = tryParseDonnees(record.donnees);
  if (donnees) {
    const candidates = [];
    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        if (k === "MONTANT" && v) {
          if (typeof v === "object" && v["#text"]) candidates.push(Number(v["#text"]));
          else if (typeof v === "string" || typeof v === "number") candidates.push(Number(v));
        } else if (k === "VALEUR" || k === "VALEUR_TOTALE") {
          if (typeof v === "object" && v["#text"]) candidates.push(Number(v["#text"]));
          else if (typeof v === "string" || typeof v === "number") candidates.push(Number(v));
        } else if (typeof v === "object") {
          walk(v);
        }
      }
    };
    walk(donnees);
    const valid = candidates.filter(n => Number.isFinite(n) && n > 0);
    if (valid.length) {
      const max = Math.max(...valid);
      return Math.round(max / 1000); // EUR -> k€
    }
  }
  // Fallback : famille_libelle peut donner une fourchette
  const fam = record.famille_libelle || "";
  if (/<\s*90\s*k/i.test(fam)) return 50;
  if (/entre\s*90\s*k.*seuils/i.test(fam)) return 150;
  return 0;
}

function normalizeRecord(rec) {
  const idClean = rec.idweb || rec.id || "";
  const url = rec.url_avis || (idClean ? `https://www.boamp.fr/pages/avis/?q=idweb:${idClean}` : "");
  return {
    id: idClean,
    ref: idClean,
    acheteur: rec.nomacheteur || "",
    objet: rec.objet || "",
    description: rec.objet || "",
    cpv: "",
    pays: "FRA",
    deadline: (rec.datelimitereponse || "").slice(0, 10),
    montant: extractMontantKEur(rec),
    publication: (rec.dateparution || "").slice(0, 10),
    source: "BOAMP",
    url,
    _boamp: {
      famille: rec.famille_libelle || "",
      nature: rec.nature_libelle || "",
      procedure: rec.procedure_libelle || "",
      descripteurs: rec.descripteur_libelle || [],
      departement: (rec.code_departement || []).join(",")
    }
  };
}

// Filtre par descripteurs BOAMP (taxonomie maison, on n'a pas de CPV)
function passesDescripteursFilter(notice, boampConfig) {
  const descs = (notice._boamp?.descripteurs || []).map(d => normalize(d));
  const blacklist = (boampConfig.descripteurs_blacklist || []).map(d => normalize(d));
  const whitelist = (boampConfig.descripteurs_whitelist || []).map(d => normalize(d));

  if (blacklist.length && descs.some(d => blacklist.includes(d))) {
    return { ok: false, reason: "descripteur blacklisté" };
  }
  if (whitelist.length && !descs.some(d => whitelist.includes(d))) {
    return { ok: false, reason: "aucun descripteur whitelisté" };
  }
  return { ok: true };
}

async function main() {
  log("=== Sync BOAMP — démarrage ===");
  const filters = loadJSON(FILTERS_PATH);
  const boampConfig = loadJSON(BOAMP_CONFIG_PATH);
  ensureDir(DATA_DIR);

  const where = buildWhereClause(filters, boampConfig);
  log(`Where clause : ${where.slice(0, 220)}${where.length > 220 ? "..." : ""}`);

  const allRecords = [];
  let page = 0;
  let totalCount = null;

  while (page < (boampConfig.max_pages || 5)) {
    const offset = page * (boampConfig.page_size || 100);
    let resp;
    try {
      resp = await fetchPage(boampConfig, where, offset);
    } catch (e) {
      log(`ERREUR fetch page ${page} : ${e.message}`);
      break;
    }
    if (totalCount === null) totalCount = resp.total_count || 0;
    const records = resp.results || [];
    if (records.length === 0) break;
    allRecords.push(...records);
    log(`Page ${page} : ${records.length} records (cumul ${allRecords.length} / total annoncé ${totalCount})`);
    if (allRecords.length >= totalCount) break;
    page++;
  }

  log(`BOAMP : ${allRecords.length} avis récupérés sur la fenêtre`);

  // Normalisation + filtrage applicatif (resserrage)
  const enriched = [];
  let rejectedByDesc = 0;
  let rejectedByNeg = 0;
  for (const rec of allRecords) {
    const n = normalizeRecord(rec);
    const { matched, hits } = matchesKeywords(n, filters);
    if (!matched) continue;
    // Phrases négatives = communes (filters.json) + spécifiques BOAMP (boamp.json)
    const allNegPhrases = [
      ...(filters.negative_phrases || []),
      ...(boampConfig.negative_phrases || [])
    ];
    const negFilter = passesNegativePhrases(n, allNegPhrases);
    if (!negFilter.ok) { rejectedByNeg++; continue; }
    const dFilter = passesDescripteursFilter(n, boampConfig);
    if (!dFilter.ok) { rejectedByDesc++; continue; }
    n.segment = detectSegment(n, filters);
    n.keyword_hits = hits;
    const { total: score, detail } = autoScore(n, filters, { segmentBoost: true });
    n.score = score;
    n.score_detail = detail;
    n.score_status = scoreStatus(score, filters.scoring.thresholds);
    n.notes = "";
    n.auto = true;
    enriched.push(n);
  }

  enriched.sort((a, b) => b.score - a.score);

  const today = todayISO();
  const out = {
    generated_at: new Date().toISOString(),
    source: "BOAMP",
    window_days: boampConfig.window_days,
    total_fetched: allRecords.length,
    total_matched: enriched.length,
    total_go: enriched.filter(n => n.score_status === "go").length,
    notices: enriched
  };

  writeJSON(path.join(DATA_DIR, `boamp_${today}.json`), out);
  log(`Écrit : data/boamp_${today}.json`);
  log(`Récap : ${enriched.length} matchés / ${allRecords.length} avis | rejetés (négatifs) : ${rejectedByNeg} | rejetés (descripteurs) : ${rejectedByDesc} | ${out.total_go} en Go ferme`);
  log("=== Sync BOAMP — terminé ===");
}

main().catch(e => {
  console.error("ERREUR FATALE BOAMP :", e);
  process.exit(1);
});
