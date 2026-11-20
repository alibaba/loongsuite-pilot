// Already-running apps can retain retired overrides; forward only to their own runtime.
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

const WRAPPER_PATH = fileURLToPath(import.meta.url);
const PILOT_DATA_DIR = path.dirname(path.dirname(WRAPPER_PATH));
const LOG_DIR = path.join(PILOT_DATA_DIR, 'logs');
const ERROR_LOG = path.join(LOG_DIR, 'qoderwork-wrapper-error.log');

function logDiag(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

const SDK_WORKER_REL = path.join(
  'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', '_worker',
);
const RUNTIME_NAMES = ['qoder-worker-runtime.obf.mjs', 'qoder-worker-runtime.mjs'];

function candidateResourceRoots() {
  const roots = [];
  const exec = process.execPath || '';
  // Match the outer bundle, not a nested Electron Helper.app.
  const m = /^(.*?\.app)(?:\/|$)/.exec(exec);
  if (m) roots.push(path.join(m[1], 'Contents', 'Resources'));
  if (process.resourcesPath) roots.push(process.resourcesPath);
  return roots;
}

function findHostAppRuntime(resourceRoots) {
  let selfPath = '';
  try { selfPath = fs.realpathSync(fileURLToPath(import.meta.url)); } catch {}

  const seen = new Set();
  for (const root of resourceRoots) {
    for (const name of RUNTIME_NAMES) {
      const cand = path.join(root, SDK_WORKER_REL, name);
      if (seen.has(cand)) continue;
      seen.add(cand);
      try {
        if (!fs.existsSync(cand)) continue;
        const real = fs.realpathSync(cand);
        if (real === selfPath) continue;
        return real;
      } catch {}
    }
  }
  return null;
}

const hostRuntime = findHostAppRuntime(candidateResourceRoots());

if (hostRuntime) {
  try {
    await import(pathToFileURL(hostRuntime).href);
  } catch (e) {
    // Throwing here crashes the worker and prevents the SDK's transport fallback.
    logDiag(`host runtime import failed: runtime=${hostRuntime} :: ${e && e.message}`);
  }
} else {
  logDiag(
    'host app runtime not found — refusing to load a foreign runtime '
    + `(execPath=${process.execPath || ''}, resourcesPath=${process.resourcesPath || ''})`,
  );
}
