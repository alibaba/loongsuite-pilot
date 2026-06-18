'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const CACHE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.loongsuite-pilot');
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

const entry = loadVersion(CURRENT_FILE) || loadVersion(PREVIOUS_FILE);
if (!entry) {
  console.error('[loongsuite-pilot] No valid collector version found');
  process.exit(1);
}
import(pathToFileURL(entry).href).catch(err => {
  console.error('[loongsuite-pilot] Failed to load collector:', err.message);
  process.exit(1);
});
