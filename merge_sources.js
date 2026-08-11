#!/usr/bin/env node
/**
 * Merge Sources — Sprint 2 du Radar AO Isograd
 *
 * Fusionne les outputs des 3 sync (TED, BOAMP, Profils Tier-1) en un seul
 * data/latest.json multi-source.
 *
 * Deux passes de déduplication :
 *  1. Strict : par 'id' exact (élimine les doublons intra-source)
 *  2. Fuzzy : par signature (acheteur normalisé + premiers mots de l'objet)
 *     pour repérer un même AO publié à la fois sur TED et BOAMP avec des
 *     identifiants différents. Garde la version au meilleur score et annote
 *     _also_seen_in pour traçabilité.
 *
 * Lit data/{ted|boamp|profils}_YYYY-MM-DD.json. Source absente = on continue
 * avec celles disponibles (compat sprint 1 standalone).
 *
 * Usage : node merge_sources.js [date_iso]
 */

const fs = require("fs");
const path = require("path");
const { loadJSONIfExists, todayISO, makeLogger, writeJSON } = require("./lib/io");
const { normalize } = require("./lib/normalize");

const DATA_DIR = path.join(__dirname, "data");
const FEEDBACK_PATH = path.join(__dirname, "feedback", "verdicts.csv");
const log = makeLogger("merge");

/**
 * Métrique précision 4 semaines glissantes (schéma v2).
 *
 * Lit feedback/verdicts.csv si présent. Format attendu (souple) :
 *   Ref,Verdict,Date
 *   497445-2026,no,2026-08-11
 * Verdict ∈ {go, no, à creuser} — un "no" sur une notice que le radar avait
 * affichée (score >= 60) compte comme faux positif.
 * Retourne { precision_4w, human_verdicts_collected_4w, false_positives_human_verdict_4w }.
 */
function computePrecision4w() {
  const empty = {
    precision_4w: null,
    human_verdicts_collected_4w: 0,
    false_positives_human_verdict_4w: 0
  };
  if (!fs.existsSync(FEEDBACK_PATH)) return empty;
  let lines;
  try {
    lines = fs.readFileSync(FEEDBACK_PATH, "utf-8").split(/\r?\n/).filter(Boolean);
  } catch {
    return empty;
  }
  const cutoff = new Date(Date.now() - 28 * 86400000);
  let collected = 0;
  let falsePos = 0;
  for (const line of lines.slice(1)) { // skip header
    const cols = line.split(",").map(c => c.trim());
    if (cols.length < 2) continue;
    const verdict = normalize(cols[1] || "");
    const dateStr = cols[2] || "";
    const d = dateStr ? new Date(dateStr) : null;
    if (d && !isNaN(d) && d < cutoff) continue; // hors fenêtre 4 semaines
    if (!verdict) continue;
    collected++;
    if (verdict === "no") falsePos++;
  }
  return {
    precision_4w: collected > 0 ? Math.round(100 * (1 - falsePos / collected)) : null,
    human_verdicts_collected_4w: collected,
    false_positives_human_verdict_4w: falsePos
  };
}

/**
 * Signature fuzzy d'une notice. On hash la FIN de l'objet (et pas le début)
 * parce que TED préfixe systématiquement par "France – Services de XXX – "
 * alors que BOAMP saute directement à l'objet métier. La queue de l'objet est
 * en revanche identique des deux côtés.
 *
 * On mixe : acheteur normalisé (30 chars) + 100 derniers chars de l'objet.
 */
function fuzzySignature(n) {
  const acheteur = normalize(n.acheteur || "").replace(/[^a-z0-9]/g, "").slice(0, 30);
  const objetClean = normalize(n.objet || "").replace(/[^a-z0-9]/g, "");
  const tail = objetClean.length > 100 ? objetClean.slice(-100) : objetClean;
  return `${acheteur}::${tail}`;
}

/**
 * Vérifie si deux notices ont une similarité de tokens suffisante pour être
 * considérées comme le même AO. Calcule le Jaccard des mots de 4+ chars de
 * l'objet. Threshold de 0.5 = au moins la moitié des tokens en commun.
 *
 * Utilisé en complément de la signature fuzzy pour rattraper les cas où la
 * signature ne suffit pas (ordre des phrases différent, ponctuation, etc.).
 */
function jaccardObjet(a, b) {
  const toks = (s) => new Set(
    normalize(s || "")
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(t => t.length >= 4)
  );
  const ta = toks(a.objet);
  const tb = toks(b.objet);
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

function sameAcheteur(a, b) {
  const na = normalize(a.acheteur || "").replace(/[^a-z0-9]/g, "");
  const nb = normalize(b.acheteur || "").replace(/[^a-z0-9]/g, "");
  if (!na || !nb) return false;
  // Match strict ou inclusion (cas où un acheteur a un suffixe "/ Direction XX")
  return na === nb || na.includes(nb) || nb.includes(na);
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
    const d = loadJSONIfExists(s.path);
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

  // === Passe 1 : dédup par id strict ===
  const byId = new Map();
  for (const n of allNotices) {
    const key = n.id || `${n.source}_${n.ref}`;
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, n);
    } else {
      const winner = (n.score || 0) >= (existing.score || 0) ? n : existing;
      const loser = winner === n ? existing : n;
      winner._also_seen_in = Array.from(new Set([...(winner._also_seen_in || []), loser.source]));
      byId.set(key, winner);
    }
  }
  const afterIdDedup = Array.from(byId.values());
  const collisionsId = allNotices.length - afterIdDedup.length;

  // === Passe 2 : dédup fuzzy ===
  // a) Dédup par signature (acheteur + queue de l'objet normalisé).
  // b) Pour les notices restantes, dédup par Jaccard de tokens > 0.5 ET acheteur
  //    identique. Couvre les cas où la signature rate (formulations différentes,
  //    ordre des phrases inversé).
  const mergeNotices = (winner, loser) => {
    const seen = Array.from(new Set([
      ...(winner._also_seen_in || []),
      loser.source,
      ...(loser._also_seen_in || [])
    ])).filter(s => s !== winner.source);
    if (seen.length) winner._also_seen_in = seen;
    return winner;
  };

  // 2a. Signature fuzzy
  const bySig = new Map();
  for (const n of afterIdDedup) {
    const sig = fuzzySignature(n);
    const existing = bySig.get(sig);
    if (!existing) {
      bySig.set(sig, n);
    } else {
      const winner = (n.score || 0) >= (existing.score || 0) ? n : existing;
      const loser = winner === n ? existing : n;
      bySig.set(sig, mergeNotices(winner, loser));
    }
  }
  let candidates = Array.from(bySig.values());
  const collisionsSig = afterIdDedup.length - candidates.length;

  // 2b. Jaccard pairwise sur les notices restantes (n² mais N petit)
  let collisionsJaccard = 0;
  const merged = [];
  for (const n of candidates) {
    let absorbed = false;
    for (let i = 0; i < merged.length; i++) {
      if (sameAcheteur(merged[i], n) && jaccardObjet(merged[i], n) >= 0.5) {
        const winner = (n.score || 0) >= (merged[i].score || 0) ? n : merged[i];
        const loser = winner === n ? merged[i] : n;
        merged[i] = mergeNotices(winner, loser);
        collisionsJaccard++;
        absorbed = true;
        break;
      }
    }
    if (!absorbed) merged.push(n);
  }
  const collisionsFuzzy = collisionsSig + collisionsJaccard;

  // Tri : score DESC, puis publication DESC
  merged.sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    return (b.publication || "").localeCompare(a.publication || "");
  });

  // === Bloc metrics (schéma v2) ===
  // Agrège les compteurs de gating remontés par chaque sync (gating_stats),
  // compte les notices affichables, et calcule la précision 4 semaines
  // glissantes depuis feedback/verdicts.csv si le fichier existe.
  const gatingAgg = { filtered_cpv_blacklist: 0, filtered_stopword: 0, capped_no_context: 0 };
  for (const s of sources) {
    const d = loadJSONIfExists(s.path);
    const gs = d && d.gating_stats ? d.gating_stats : {};
    gatingAgg.filtered_cpv_blacklist += gs.filtered_cpv_blacklist || 0;
    gatingAgg.filtered_stopword += gs.filtered_stopword || 0;
    gatingAgg.capped_no_context += gs.capped_no_context || 0;
  }
  const precision = computePrecision4w();
  const metrics = {
    ...precision,
    ...gatingAgg,
    displayed_in_radar: merged.filter(n => n.score >= 60 && n.score_status !== "filtered").length
  };

  const out = {
    generated_at: new Date().toISOString(),
    source: "MERGE",
    schema_version: 2,
    sources_summary: summary,
    total_fetched: Object.values(summary).reduce((s, x) => s + x.fetched, 0),
    total_matched: merged.length,
    total_go: merged.filter(n => n.score_status === "go").length,
    total_dedup_collisions: collisionsId + collisionsFuzzy,
    dedup_breakdown: {
      by_id: collisionsId,
      fuzzy_signature: collisionsSig,
      fuzzy_jaccard: collisionsJaccard
    },
    metrics,
    notices: merged
  };

  writeJSON(path.join(DATA_DIR, "latest.json"), out);
  log(`Écrit : data/latest.json`);
  log(`Récap : ${merged.length} AO uniques | ${out.total_go} Go ferme | dédup : ${collisionsId} par id + ${collisionsSig} signature + ${collisionsJaccard} Jaccard`);
  log(`Détail par source : ${JSON.stringify(summary)}`);
  log("=== Merge terminé ===");
}

main();
