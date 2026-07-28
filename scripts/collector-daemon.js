'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const CACHE_DIR = path.join(HOME, '.loongsuite-pilot');
const CURRENT_FILE = path.join(CACHE_DIR, 'current');
const PREVIOUS_FILE = path.join(CACHE_DIR, 'previous');
const VERSIONS_DIR = path.join(CACHE_DIR, 'versions');

function loadVersion(pointerFile) {
  try {
    const name = fs.readFileSync(pointerFile, 'utf-8').trim();
    if (!name) return null;
    const entry = path.join(VERSIONS_DIR, name, 'dist', 'index.js');
    if (fs.existsSync(entry)) return entry;
  } catch {}
  return null;
}

// Resolve the data dir the updater will read the breadcrumb from (honors override).
function resolveDataDir() {
  const raw = process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (!raw) return CACHE_DIR;
  if (raw === '~') return HOME;
  if (raw.startsWith('~/')) return path.join(HOME, raw.slice(2));
  return raw;
}

function resolveInstalledVersion() {
  try {
    const name = fs.readFileSync(CURRENT_FILE, 'utf-8').trim();
    const content = fs.readFileSync(path.join(VERSIONS_DIR, name, 'VERSION'), 'utf-8');
    const match = content.match(/^version=(.+)$/m);
    return match ? match[1] : (name || 'unknown');
  } catch {
    return 'unknown';
  }
}

// Fatal early-death happens during ESM module-graph resolution (e.g. a top-level
// `import sqlite3` failing under npm12), before dist/index.js main() runs. This is
// the only place that can capture the real cause for the updater to report.
function writeStartupCrash(err) {
  try {
    const breadcrumb = {
      schema: 1,
      ts: Math.floor(Date.now() / 1000),
      phase: 'module_load',
      version: resolveInstalledVersion(),
      pid: process.pid,
      error_message: err && err.message ? String(err.message) : String(err),
      error_stack_head: err && err.stack
        ? String(err.stack).split(/\r?\n/).slice(0, 10).join('\n')
        : '',
    };
    const dir = path.join(resolveDataDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'last-startup-crash.json');
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(breadcrumb, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // best-effort: never mask the original error
  }
}

const entry = loadVersion(CURRENT_FILE) || loadVersion(PREVIOUS_FILE);
if (!entry) {
  console.error('[loongsuite-pilot] No valid collector version found');
  process.exit(1);
}
import(pathToFileURL(entry).href).catch(err => {
  writeStartupCrash(err);
  console.error('[loongsuite-pilot] Failed to load collector:', err.message);
  process.exit(1);
});
