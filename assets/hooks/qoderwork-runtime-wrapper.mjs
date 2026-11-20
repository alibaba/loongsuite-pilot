// Already-running apps can retain retired overrides; forward only to their own runtime.
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { isMainThread, workerData } from 'node:worker_threads';
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
const SDK_NAME = '@qoder-ai/qoder-agent-sdk';

function candidateResourceRoots() {
  const roots = [];
  const exec = process.execPath || '';
  // Match the outer bundle, not a nested Electron Helper.app.
  const m = /^(.*?\.app)(?:\/|$)/.exec(exec);
  if (m) roots.push(path.join(m[1], 'Contents', 'Resources'));
  if (process.resourcesPath) roots.push(process.resourcesPath);
  return roots;
}

function findRuntime(directories) {
  let selfPath = WRAPPER_PATH;
  try { selfPath = fs.realpathSync(WRAPPER_PATH); } catch {}
  for (const directory of new Set(directories)) {
    for (const name of RUNTIME_NAMES) {
      try {
        const real = fs.realpathSync(path.join(directory, name));
        if (real === selfPath) continue;
        if (fs.statSync(real).isFile()) return real;
      } catch {}
    }
  }
  return null;
}

function findDevelopmentRuntime() {
  // Bind the development project to the executable Electron selected.
  let executable;
  try { executable = fs.realpathSync(process.execPath); } catch { return null; }
  const normalized = executable.replace(/\\/g, '/');
  if (!normalized.includes('/node_modules/electron/dist/')) return null;
  const project = executable.slice(0, normalized.indexOf('/node_modules/'));
  const manifests = [process.env.npm_package_json, path.join(project, 'package.json')];
  for (const manifest of new Set(manifests)) {
    if (!manifest || !path.isAbsolute(manifest)) continue;
    let hostRequire;
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (![pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]
        .some(deps => deps && Object.hasOwn(deps, SDK_NAME))) continue;
      hostRequire = createRequire(manifest);
      const electron = path.dirname(hostRequire.resolve('electron/package.json'));
      const binary = fs.readFileSync(path.join(electron, 'path.txt'), 'utf8').trim();
      if (fs.realpathSync(path.join(electron, 'dist', binary)) !== executable) continue;
    } catch {
      continue;
    }
    // A verified workspace owns this SDK, even if its runtime is missing.
    // Package exports may make its manifest inaccessible, so resolve its entry.
    try {
      const entry = path.dirname(hostRequire.resolve(SDK_NAME));
      return findRuntime([path.join(entry, '_worker'), path.join(entry, 'dist', '_worker')]);
    } catch {
      return null;
    }
  }
  return null;
}

async function failWorker(error) {
  if (!isMainThread && !process.stdout.writableEnded) {
    // Some SDK versions destroy stdout on Worker error without ending the
    // downstream line reader. Close stdout first so initialize can reject.
    await new Promise(resolve => process.stdout.end(resolve));
  }
  throw error;
}

const hostRuntime = findRuntime(candidateResourceRoots().map(root => path.join(root, SDK_WORKER_REL)))
  || findDevelopmentRuntime();

if (hostRuntime) {
  try {
    const runtimeRoot = path.dirname(hostRuntime);
    process.env.QODER_WORKER_RUNTIME_ASSET_ROOT = runtimeRoot;
    if (workerData?.qoderWorkerRuntime) {
      workerData.qoderWorkerRuntime.runtimeRoot = runtimeRoot;
    }
    await import(pathToFileURL(hostRuntime).href);
  } catch (e) {
    logDiag(`host runtime import failed: runtime=${hostRuntime} :: ${e && e.message}`);
    await failWorker(e);
  }
} else {
  const message = 'Pilot host app runtime not found; refusing to load a foreign runtime '
    + `(execPath=${process.execPath || ''}, resourcesPath=${process.resourcesPath || ''})`;
  logDiag(message);
  await failWorker(new Error(message));
}
