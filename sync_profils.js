#!/usr/bin/env node
/**
 * Sync Profils Tier-1 — Sprint 2 du Radar AO Isograd
 *
 * Pull les AO publiés sur les profils acheteurs Tier-1 (universités autonomes,
 * établissements qui ne publient pas sur BOAMP). Stratégie de scraping via
 * Apify (token via env APIFY_TOKEN).
 *
 * Logique :
 *  - Charge config/profils_tier1.json (liste des profils + config Apify par profil)
 *  - Pour chaque profil 'actif: true', lance un run Apify et attend la fin
 *  - Récupère les items du dataset, normalise au schéma sprint 1, score
 *  - Écrit data/profils_YYYY-MM-DD.json
 *
 * Si APIFY_TOKEN n'est pas défini, le script log un warning et sort propre
 * (le workflow GitHub continuera sans bloquer).
 *
 * Usage local :   APIFY_TOKEN=xxx node sync_profils.js
 * Usage CI    :   appelé par .github/workflows/sync-ao.yml
 */

const fs = require("fs");
const path = require("path");

const FILTERS_PATH = path.join(__dirname, "config", "filters.json");
const PROFILS_CONFIG_PATH = path.join(__dirname, "config", "profils_tier1.json");
const DATA_DIR = path.join(__dirname, "data");
const APIFY_BASE = "https://api.apify.com/v2";
const POLL_INTERVAL_MS = 4000;

// === Helpers ===
function log(msg) {
  console.log(`[${new Date().toISOString()}] [profils] ${msg}`);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function normalize(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// === Apify API ===
async function apifyFetch(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Apify HTTP ${res.status} : ${(data.error?.message || text).slice(0, 300)}`);
  }
  return data;
}

async function startRun(actorId, input, token) {
  const url = `${APIFY_BASE}/acts/${actorId}/runs?token=${encodeURIComponent(token)}`;
  log(`Apify start run : actor=${actorId}`);
  const data = await apifyFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input || {})
  });
  return data.data; // contient { id, status, defaultDatasetId, ... }
}

async function waitForRun(runId, token, timeoutSec) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutSec * 1000) {
    const url = `${APIFY_BASE}/actor-runs/${runId}?token=${encodeURIComponent(token)}`;
    const data = await apifyFetch(url);
    const status = data.data.status;
    if (status === "SUCCEEDED") return data.data;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      throw new Error(`Run ${runId} terminé en ${status}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Run ${runId} timeout après ${timeoutSec}s`);
}

async function getDatasetItems(datasetId, token, limit = 50) {
  const url = `${APIFY_BASE}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&format=json&limit=${limit}`;
  return await apifyFetch(url);
}

// === Normalisation ===
// Format attendu d'un item Apify (à respecter dans la pageFunction de l'actor) :
//   { titre, url, date_publication?, deadline?, montant_kEur?, description?, reference? }
// Si l'actor renvoie un format différent, ajuste cette fonction.
function normalizeApifyItem(item, profil) {
  const titre = item.titre || item.title || item.objet || "";
  const url = item.url || item.link || "";
  const ref = item.reference || item.ref || (item.url ? new URL(item.url, "https://x.x").pathname.split("/").pop() : "") || "";
  const description = item.description || item.summary || titre;
  const datePub = (item.date_publication || item.publication || item.published || "").slice(0, 10);
  const deadline = (item.deadline || item.date_limite || "").slice(0, 10);
  const montant = Number(item.montant_kEur || item.montant || item.amount || 0);

  return {
    id: ref || `${profil.id}_${Buffer.from(titre).toString("base64").slice(0, 10)}`,
    ref,
    acheteur: profil.nom,
    objet: titre,
    description,
    cpv: "",
    pays: "FRA",
    deadline,
    montant: Math.round(montant),
    publication: datePub,
    source: "Profil",
    url,
    _profil: {
      id: profil.id,
      platform: profil.platform || "",
      url_profil: profil.url_profil || ""
    }
  };
}

// === Filtrage et scoring (mêmes règles que TED / BOAMP) ===
function matchesKeywords(notice, filters) {
  const blob = `${notice.objet || ""} ${notice.description || ""} ${notice.acheteur || ""}`.toLowerCase();
  const allKw = [...(filters.keywords_fr || []), ...(filters.keywords_en || [])];
  const hits = allKw.filter(kw => blob.includes(kw.toLowerCase()));
  return { matched: hits.length > 0, hits };
}

function detectSegment(notice, filters) {
  const buyer = normalize(notice.acheteur);
  for (const rule of filters.buyer_segment_rules || []) {
    if (rule.match.some(m => buyer.includes(normalize(m)))) return rule.segment;
  }
  return "ESR"; // par défaut, les profils Tier-1 sont des établissements ESR
}

function autoScore(notice, filters) {
  let total = 0;
  const detail = {};
  const blob = `${notice.objet || ""} ${notice.description || ""}`.toLowerCase();

  const strongMatch = filters.scoring.fit_keywords_strong.some(k => blob.includes(k.toLowerCase()));
  const mediumMatch = filters.scoring.fit_keywords_medium.some(k => blob.includes(k.toLowerCase()));
  let fit = 10;
  if (strongMatch) fit = 40;
  else if (mediumMatch) fit = 25;
  // Bonus profils Tier-1 : on est sur des comptes cibles, +5
  if (fit < 40) fit = Math.min(40, fit + 5);
  detail.fit = fit;
  total += fit;

  let size = 5;
  if (notice.montant >= 1000) size = 15;
  else if (notice.montant >= 215) size = 13;
  else if (notice.montant >= 90) size = 10;
  else if (notice.montant === 0) size = 8;
  detail.size = size;
  total += size;

  let tech = 12;
  const techBonus = filters.scoring.tech_keywords_bonus.some(k => blob.includes(k.toLowerCase()));
  if (techBonus) tech = 14;
  detail.tech = tech;
  total += tech;

  detail.com = 5;
  total += 5;
  detail.admin = 7;
  total += 7;

  let delay = 0;
  if (notice.deadline) {
    const days = Math.round((new Date(notice.deadline) - new Date()) / 86400000);
    if (days > 30) delay = 5;
    else if (days >= 20) delay = 3;
    else if (days >= 15) delay = 1;
  } else {
    delay = 3;
  }
  detail.delay = delay;
  total += delay;

  return { total, detail };
}

// === Main ===
async function main() {
  log("=== Sync Profils Tier-1 — démarrage ===");
  const filters = loadJSON(FILTERS_PATH);
  const profilsConfig = loadJSON(PROFILS_CONFIG_PATH);
  ensureDir(DATA_DIR);

  const token = process.env.APIFY_TOKEN;
  const actifs = (profilsConfig.profils || []).filter(p => p.actif);
  log(`${actifs.length} profil(s) actif(s) sur ${profilsConfig.profils.length}`);

  if (!token) {
    log(`WARNING : APIFY_TOKEN absent (env). Sortie sans run, écriture d'un fichier vide.`);
    const empty = {
      generated_at: new Date().toISOString(),
      source: "Profil",
      total_fetched: 0,
      total_matched: 0,
      total_go: 0,
      profils_actifs: actifs.map(p => p.id),
      notices: [],
      _warning: "APIFY_TOKEN manquant — exécution sautée."
    };
    const out = path.join(DATA_DIR, `profils_${todayISO()}.json`);
    fs.writeFileSync(out, JSON.stringify(empty, null, 2));
    log(`Écrit (vide) : ${out}`);
    return;
  }

  if (actifs.length === 0) {
    log(`Aucun profil actif. Sortie sans run.`);
    const empty = {
      generated_at: new Date().toISOString(),
      source: "Profil",
      total_fetched: 0,
      total_matched: 0,
      total_go: 0,
      profils_actifs: [],
      notices: []
    };
    const out = path.join(DATA_DIR, `profils_${todayISO()}.json`);
    fs.writeFileSync(out, JSON.stringify(empty, null, 2));
    log(`Écrit (vide) : ${out}`);
    return;
  }

  const allItems = [];
  for (const profil of actifs) {
    log(`--- Profil : ${profil.nom} (${profil.id}) ---`);
    const actorId = profil.actor_id || profilsConfig.apify.default_actor_id;
    const input = profil.actor_input || {};
    if (!profil.url_profil && (!input.startUrls || input.startUrls.length === 0)) {
      log(`SKIP ${profil.id} : pas d'URL profil ni de startUrls. Configure-le.`);
      continue;
    }
    let runStarted;
    try {
      runStarted = await startRun(actorId, input, token);
      log(`Run started : ${runStarted.id} (status ${runStarted.status})`);
    } catch (e) {
      log(`ERREUR start run ${profil.id} : ${e.message}`);
      continue;
    }
    let runDone;
    try {
      runDone = await waitForRun(runStarted.id, token, profilsConfig.apify.timeout_run_seconds || 240);
      log(`Run done : ${runDone.id} (status ${runDone.status})`);
    } catch (e) {
      log(`ERREUR wait run ${profil.id} : ${e.message}`);
      continue;
    }
    let items;
    try {
      items = await getDatasetItems(runDone.defaultDatasetId, token, profilsConfig.apify.max_items_per_run || 50);
      log(`Dataset items : ${items.length}`);
    } catch (e) {
      log(`ERREUR get dataset ${profil.id} : ${e.message}`);
      continue;
    }
    for (const item of items) allItems.push({ item, profil });
  }

  log(`Total items récupérés : ${allItems.length}`);

  const enriched = [];
  for (const { item, profil } of allItems) {
    const n = normalizeApifyItem(item, profil);
    const { matched, hits } = matchesKeywords(n, filters);
    if (!matched) continue;
    n.segment = detectSegment(n, filters);
    n.keyword_hits = hits;
    const { total: score, detail } = autoScore(n, filters);
    n.score = score;
    n.score_detail = detail;
    n.score_status = score >= filters.scoring.thresholds.go ? "go"
                   : score >= filters.scoring.thresholds.conditional ? "cond"
                   : "no";
    n.notes = "";
    n.auto = true;
    enriched.push(n);
  }

  enriched.sort((a, b) => b.score - a.score);

  const today = todayISO();
  const out = {
    generated_at: new Date().toISOString(),
    source: "Profil",
    total_fetched: allItems.length,
    total_matched: enriched.length,
    total_go: enriched.filter(n => n.score_status === "go").length,
    profils_actifs: actifs.map(p => p.id),
    notices: enriched
  };

  const outDated = path.join(DATA_DIR, `profils_${today}.json`);
  fs.writeFileSync(outDated, JSON.stringify(out, null, 2));
  log(`Écrit : ${outDated}`);
  log(`Récap : ${enriched.length} AO matchés sur ${allItems.length} items (${out.total_go} en Go ferme)`);
  log("=== Sync Profils Tier-1 — terminé ===");
}

main().catch(e => {
  console.error("ERREUR FATALE PROFILS :", e);
  process.exit(1);
});
