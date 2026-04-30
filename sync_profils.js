#!/usr/bin/env node
/**
 * Sync Profils Tier-1 — Sprint 2 du Radar AO Isograd
 *
 * Pull les AO publiés sur les profils acheteurs Tier-1 (universités autonomes,
 * établissements qui ne publient pas sur BOAMP) via Apify (token via
 * env APIFY_TOKEN).
 *
 * Si APIFY_TOKEN n'est pas défini, le script log un warning et sort propre
 * (le workflow GitHub continue sans bloquer).
 *
 * Usage local :   APIFY_TOKEN=xxx node sync_profils.js
 * Usage CI    :   appelé par .github/workflows/sync-ao.yml
 */

const path = require("path");
const { loadJSON, ensureDir, todayISO, sleep, makeLogger, writeJSON } = require("./lib/io");
const { matchesKeywords, detectSegment } = require("./lib/keywords");
const { autoScore, scoreStatus } = require("./lib/scoring");

const FILTERS_PATH = path.join(__dirname, "config", "filters.json");
const PROFILS_CONFIG_PATH = path.join(__dirname, "config", "profils_tier1.json");
const DATA_DIR = path.join(__dirname, "data");
const APIFY_BASE = "https://api.apify.com/v2";
const POLL_INTERVAL_MS = 4000;

const log = makeLogger("profils");

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
  return data.data;
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

// Format attendu d'un item Apify (à respecter dans la pageFunction de l'actor) :
//   { titre, url, date_publication?, deadline?, montant_kEur?, description?, reference? }
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

async function main() {
  log("=== Sync Profils Tier-1 — démarrage ===");
  const filters = loadJSON(FILTERS_PATH);
  const profilsConfig = loadJSON(PROFILS_CONFIG_PATH);
  ensureDir(DATA_DIR);

  const token = process.env.APIFY_TOKEN;
  const actifs = (profilsConfig.profils || []).filter(p => p.actif);
  log(`${actifs.length} profil(s) actif(s) sur ${profilsConfig.profils.length}`);

  const writeOutput = (notices, profilsActifs, warning = null) => {
    const out = {
      generated_at: new Date().toISOString(),
      source: "Profil",
      total_fetched: notices.length,
      total_matched: notices.filter(n => n.auto).length,
      total_go: notices.filter(n => n.score_status === "go").length,
      profils_actifs: profilsActifs,
      notices
    };
    if (warning) out._warning = warning;
    writeJSON(path.join(DATA_DIR, `profils_${todayISO()}.json`), out);
    log(`Écrit : data/profils_${todayISO()}.json`);
    return out;
  };

  if (!token) {
    log(`WARNING : APIFY_TOKEN absent (env). Sortie sans run, écriture d'un fichier vide.`);
    writeOutput([], actifs.map(p => p.id), "APIFY_TOKEN manquant — exécution sautée.");
    return;
  }

  if (actifs.length === 0) {
    log(`Aucun profil actif. Sortie sans run.`);
    writeOutput([], []);
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
    n.segment = detectSegment(n, filters, "ESR"); // défaut ESR pour les profils Tier-1
    n.keyword_hits = hits;
    const { total: score, detail } = autoScore(n, filters, { profilBoost: true });
    n.score = score;
    n.score_detail = detail;
    n.score_status = scoreStatus(score, filters.scoring.thresholds);
    n.notes = "";
    n.auto = true;
    enriched.push(n);
  }

  enriched.sort((a, b) => b.score - a.score);

  const out = writeOutput(enriched, actifs.map(p => p.id));
  log(`Récap : ${enriched.length} matchés / ${allItems.length} items (${out.total_go} en Go ferme)`);
  log("=== Sync Profils Tier-1 — terminé ===");
}

main().catch(e => {
  console.error("ERREUR FATALE PROFILS :", e);
  process.exit(1);
});
