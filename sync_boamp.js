#!/usr/bin/env node
/**
 * Sync BOAMP — Sprint 2 du Radar AO Isograd
 *
 * Pull les avis du BOAMP (Bulletin Officiel des Annonces des Marchés Publics)
 * via l'API Opendatasoft publique : https://boamp-datadila.opendatasoft.com
 *
 * Avantages vs flux ATOM :
 *  - Réponse JSON native (pas besoin de parser XML)
 *  - Filtrage SQL-like côté serveur (search, where, dateparution)
 *  - Pagination claire
 *  - Dataset complet, pas limité aux 50 dernières
 *
 * Usage local :   node sync_boamp.js
 * Usage CI    :   appelé par .github/workflows/sync-ao.yml
 */

const fs = require("fs");
const path = require("path");

const FILTERS_PATH = path.join(__dirname, "config", "filters.json");
const BOAMP_CONFIG_PATH = path.join(__dirname, "config", "boamp.json");
const DATA_DIR = path.join(__dirname, "data");
const FETCH_TIMEOUT_MS = 30000;

// === Helpers ===
function log(msg) {
  console.log(`[${new Date().toISOString()}] [boamp] ${msg}`);
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

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function normalize(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// === Construction de la clause where Opendatasoft ===
function escapeForSearch(term) {
  // Opendatasoft search() prend une chaîne, on échappe les guillemets
  return term.replace(/"/g, '\\"');
}

function buildWhereClause(filters, boampConfig) {
  const window = boampConfig.window_days || 7;
  const dateFrom = daysAgoISO(window);

  // Mots-clés : agrégation FR + EN + extras
  // ODSQL veut (search("X") OR search("Y") OR search("Z")), pas search("X OR Y").
  const allKw = [
    ...(filters.keywords_fr || []),
    ...(filters.keywords_en || []),
    ...(boampConfig.search_terms_extra || [])
  ];
  const searchClause = "(" +
    allKw.map(kw => `search("${escapeForSearch(kw)}")`).join(" OR ") +
    ")";

  // Natures (types d'avis) : on filtre côté serveur si liste non vide
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

// === Fetch API page ===
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
        "User-Agent": "Isograd-Radar-AO/2.0 (sprint2 boamp)"
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

// === Extraction du montant depuis le JSON imbriqué 'donnees' ou 'criteres' ===
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
    // Cherche un montant à plusieurs endroits possibles
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
      // Si on a plusieurs montants (lots), on prend le max
      const max = Math.max(...valid);
      return Math.round(max / 1000); // EUR -> k€
    }
  }
  // Fallback : famille_libelle peut donner une fourchette
  const fam = record.famille_libelle || "";
  if (/<\s*90\s*k/i.test(fam)) return 50; // estimation conservatrice
  if (/entre\s*90\s*k.*seuils/i.test(fam)) return 150;
  return 0;
}

function extractAcheteurUrl(record) {
  const donnees = tryParseDonnees(record.donnees);
  if (donnees?.IDENTITE?.URL) return donnees.IDENTITE.URL;
  return record.url_avis || "";
}

// === Normalisation au schéma unifié ===
function normalizeRecord(rec) {
  const idClean = rec.idweb || rec.id || "";
  const url = rec.url_avis || (idClean ? `https://www.boamp.fr/pages/avis/?q=idweb:${idClean}` : "");
  const description = rec.objet || "";
  // Code département → on déduit pays FR
  return {
    id: idClean,
    ref: idClean,
    acheteur: rec.nomacheteur || "",
    objet: rec.objet || "",
    description,
    cpv: "", // BOAMP n'a pas de CPV direct, il a 'descripteur_code' (taxonomie maison). On laisse vide.
    pays: "FRA",
    deadline: (rec.datelimitereponse || "").slice(0, 10),
    montant: extractMontantKEur(rec),
    publication: (rec.dateparution || "").slice(0, 10),
    source: "BOAMP",
    url,
    // Métadonnées BOAMP additionnelles utiles à l'analyse
    _boamp: {
      famille: rec.famille_libelle || "",
      nature: rec.nature_libelle || "",
      procedure: rec.procedure_libelle || "",
      descripteurs: rec.descripteur_libelle || [],
      departement: (rec.code_departement || []).join(",")
    }
  };
}

// === Filtrage par mots-clés (re-vérif applicative pour resserrer le bruit) ===
function matchesKeywords(notice, filters) {
  const blob = `${notice.objet || ""} ${notice.description || ""} ${notice.acheteur || ""}`.toLowerCase();
  const allKw = [...(filters.keywords_fr || []), ...(filters.keywords_en || [])];
  const hits = allKw.filter(kw => blob.includes(kw.toLowerCase()));
  return { matched: hits.length > 0, hits };
}

// === Filtrage par phrases négatives ===
function passesNegativePhrases(notice, boampConfig) {
  const phrases = (boampConfig.negative_phrases || []).map(p => p.toLowerCase());
  if (!phrases.length) return { ok: true };
  const blob = `${notice.objet || ""} ${notice.description || ""}`.toLowerCase();
  for (const p of phrases) {
    if (blob.includes(p)) return { ok: false, phrase: p };
  }
  return { ok: true };
}

// === Filtrage par descripteurs BOAMP ===
// BOAMP utilise sa propre taxonomie ('descripteur_libelle'). On blackliste les domaines
// hors-périmètre (gardiennage, assurance, transport, BTP) pour virer le bruit
// que le full-text seul ne peut pas filtrer (ex: 'télésurveillance' qui match du gardiennage).
function passesDescripteursFilter(notice, boampConfig) {
  const descs = (notice._boamp?.descripteurs || []).map(d => normalize(d));
  const blacklist = (boampConfig.descripteurs_blacklist || []).map(d => normalize(d));
  const whitelist = (boampConfig.descripteurs_whitelist || []).map(d => normalize(d));

  // Blacklist : si AU MOINS un descripteur de l'avis est dans la blacklist, on rejette
  if (blacklist.length && descs.some(d => blacklist.includes(d))) {
    return { ok: false, reason: "descripteur blacklisté" };
  }
  // Whitelist (si non vide) : il faut au moins un descripteur whitelisté
  if (whitelist.length && !descs.some(d => whitelist.includes(d))) {
    return { ok: false, reason: "aucun descripteur whitelisté" };
  }
  return { ok: true };
}

function detectSegment(notice, filters) {
  const buyer = normalize(notice.acheteur);
  for (const rule of filters.buyer_segment_rules || []) {
    if (rule.match.some(m => buyer.includes(normalize(m)))) return rule.segment;
  }
  return "Autre";
}

// === Auto-scoring (cohérent avec sync_ted.js) ===
function autoScore(notice, filters) {
  let total = 0;
  const detail = {};
  const blob = `${notice.objet || ""} ${notice.description || ""}`.toLowerCase();

  // 1. Fit produit (0-40)
  const strongMatch = filters.scoring.fit_keywords_strong.some(k => blob.includes(k.toLowerCase()));
  const mediumMatch = filters.scoring.fit_keywords_medium.some(k => blob.includes(k.toLowerCase()));
  let fit = 10;
  if (strongMatch) fit = 40;
  else if (mediumMatch) fit = 25;
  // Bonus segment ESR / FPH (cœur de cible Tosa) si match modéré
  if (fit < 40 && (notice.segment === "ESR" || notice.segment === "Formation pro")) {
    fit = Math.min(40, fit + 5);
  }
  detail.fit = fit;
  total += fit;

  // 2. Taille / budget (0-15)
  let size = 5;
  if (notice.montant >= 1000) size = 15;
  else if (notice.montant >= 215) size = 13;
  else if (notice.montant >= 90) size = 10;
  else if (notice.montant === 0) size = 8;
  detail.size = size;
  total += size;

  // 3. Faisabilité technique (0-15)
  let tech = 12;
  const techBonus = filters.scoring.tech_keywords_bonus.some(k => blob.includes(k.toLowerCase()));
  if (techBonus) tech = 14;
  detail.tech = tech;
  total += tech;

  // 4. Faisabilité commerciale (0-15) — défaut, Charles ajuste
  detail.com = 5;
  total += 5;

  // 5. Exigences administratives (0-10) — défaut
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
    delay = 3;
  }
  detail.delay = delay;
  total += delay;

  return { total, detail };
}

// === Main ===
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
    const negFilter = passesNegativePhrases(n, boampConfig);
    if (!negFilter.ok) { rejectedByNeg++; continue; }
    const dFilter = passesDescripteursFilter(n, boampConfig);
    if (!dFilter.ok) { rejectedByDesc++; continue; }
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
    source: "BOAMP",
    window_days: boampConfig.window_days,
    total_fetched: allRecords.length,
    total_matched: enriched.length,
    total_go: enriched.filter(n => n.score_status === "go").length,
    notices: enriched
  };

  const outDated = path.join(DATA_DIR, `boamp_${today}.json`);
  fs.writeFileSync(outDated, JSON.stringify(out, null, 2));
  log(`Écrit : ${outDated}`);
  log(`Récap : ${enriched.length} AO matchés sur ${allRecords.length} avis | rejetés (phrases négatives) : ${rejectedByNeg} | rejetés (descripteurs) : ${rejectedByDesc} | ${out.total_go} en Go ferme`);
  log("=== Sync BOAMP — terminé ===");
}

main().catch(e => {
  console.error("ERREUR FATALE BOAMP :", e);
  process.exit(1);
});
