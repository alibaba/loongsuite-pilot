'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const CACHE_DIR = resolveCacheDir();
const CURRENT_FILE = path.join(CACHE_DIR, 'current');
const PREVIOUS_FILE = path.join(CACHE_DIR, 'previous');
const VERSIONS_DIR = path.join(CACHE_DIR, 'versions');

function resolveCacheDir() {
  const raw = process.env.LOONGSUITE_PILOT_CACHE_DIR;
  if (!raw) return path.join(HOME, '.loongsuite-pilot');
  if (raw === '~') return HOME;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(HOME, raw.slice(2));
  return raw;
}

function loadVersion(pointerFile) {
  try {
    const name = fs.readFileSync(pointerFile, 'utf-8').trim();
    if (!name) return null;
    const entry = path.join(VERSIONS_DIR, name, 'dist', 'interceptor', 'daemon.cjs');
    if (fs.existsSync(entry)) return entry;
  } catch {}
  return null;
}

const entry = loadVersion(CURRENT_FILE) || loadVersion(PREVIOUS_FILE);
if (!entry) {
  console.error('[loongsuite-pilot] No valid interceptor version found');
  process.exit(1);
}
import(pathToFileURL(entry).href).catch(err => {
  console.error('[loongsuite-pilot] Failed to load interceptor:', err.message);
  process.exit(1);
});
