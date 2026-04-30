#!/usr/bin/env node
/**
 * Merge Sources — Sprint 2 du Radar AO Isograd
 *
 * Fusionne les outputs des 3 sync (TED, BOAMP, Profils Tier-1) en un seul
 * data/latest.json multi-source, dédupliqué par id, trié par score décroissant.
 *
 * Lit les fichiers data/{ted|boamp|profils}_YYYY-MM-DD.json du jour. Si une
 * source manque, on continue avec celles disponibles (compat sprint 1 standalone).
 *
 * Usage : node merge_sources.js [date_iso]
 *   - date_iso optionnel, par défaut aujourd'hui
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");

function log(msg) {
  console.log(`[${new Date().toISOString()}] [merge] ${msg}`);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function loadIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    log(`WARNING : ${p} illisible : ${e.message}`);
    return null;
  }
}

function main() {
  const date = process.argv[2] || todayISO();
  log(`=== Merge sources pour ${date} ===`);

  const sources = [
    { key: "TED", path: path.join(DATA_DIR, `ted_${date}.json`) },
    { key: "BOAMP", path: path.join(DATA_DIR, `boamp_${date}.json`) },
    { key: "Profil", path: path.join(DATA_DIR, `profils_${date}.json`) }
  ];

  const summary = {};
  const allNotices = [];
  for (const s of sources) {
    const d = loadIfExists(s.path);
    if (!d) {
      log(`Source ${s.key} : fichier absent (${s.path}), skip`);
      summary[s.key] = { present: false, fetched: 0, matched: 0, go: 0 };
      continue;
    }
    summary[s.key] = {
      present: true,
      fetched: d.total_fetched || 0,
      matched: d.total_matched || 0,
      go: d.total_go || 0,
      generated_at: d.generated_at || null
    };
    for (const n of d.notices || []) allNotices.push(n);
    log(`Source ${s.key} : ${(d.notices || []).length} notices ajoutées`);
  }

  // Déduplication par id (priorité au score le plus élevé en cas de doublon)
  const byId = new Map();
  for (const n of allNotices) {
    const key = n.id || `${n.source}_${n.ref}`;
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, n);
    } else {
      // En cas de collision, on garde celui qui a le meilleur score
      // et on annote la liste des sources où il apparaît
      const winner = (n.score || 0) >= (existing.score || 0) ? n : existing;
      const loser = winner === n ? existing : n;
      winner._also_seen_in = [...(winner._also_seen_in || []), loser.source];
      byId.set(key, winner);
    }
  }
  const merged = Array.from(byId.values());

  // Tri : score DESC, puis publication DESC
  merged.sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    return (b.publication || "").localeCompare(a.publication || "");
  });

  const out = {
    generated_at: new Date().toISOString(),
    source: "MERGE",
    sources_summary: summary,
    total_fetched: Object.values(summary).reduce((s, x) => s + x.fetched, 0),
    total_matched: merged.length,
    total_go: merged.filter(n => n.score_status === "go").length,
    total_dedup_collisions: allNotices.length - merged.length,
    notices: merged
  };

  const outPath = path.join(DATA_DIR, "latest.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  log(`Écrit : ${outPath}`);
  log(`Récap : ${merged.length} AO uniques | ${out.total_go} Go ferme | ${out.total_dedup_collisions} doublons fusionnés`);
  log(`Détail par source : ${JSON.stringify(summary)}`);
  log("=== Merge terminé ===");
}

main();
