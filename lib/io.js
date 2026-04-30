/**
 * lib/io.js — Helpers I/O communs aux scripts sync_*.js
 *
 * Évite la duplication de loadJSON / ensureDir / todayISO / log entre les
 * 3 sync. Pas de dépendance externe.
 */

const fs = require("fs");
const path = require("path");

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function loadJSONIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return null;
  }
}

function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Crée un logger préfixé (ex: makeLogger("boamp") -> "[2026-04-30T07:00Z] [boamp] msg")
 */
function makeLogger(tag) {
  const prefix = tag ? ` [${tag}]` : "";
  return function log(msg) {
    console.log(`[${new Date().toISOString()}]${prefix} ${msg}`);
  };
}

module.exports = {
  loadJSON,
  loadJSONIfExists,
  writeJSON,
  ensureDir,
  todayISO,
  daysAgoISO,
  sleep,
  makeLogger
};
