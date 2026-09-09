// QoderWork-family worker runtime wrapper — transparent, app-agnostic shim.
//
// Loaded through QODER_WORKER_RUNTIME_PATH (QoderWork family) or the dedicated
// QW_QODER_WORKER_RUNTIME_PATH (QwenWorkCN). These User-level variables can
// coexist and are inherited globally, so the variable that happened to load us
// is never valid host identity. On macOS the overrides are also global to the
// launchd user domain. Consequences:
//   • Every GUI app inherits the variable, but only apps that actually run the
//     @qoder-ai SDK ever load this file as their worker entry.
//   • Therefore this wrapper CAN be the worker entry of ANY sibling app, not
//     just QoderWork. It MUST NOT assume which app loaded it.
//
// Design priority (do NOT weaken): NEVER break the host app. We only ever hand
// control to the *host app's OWN* bundled runtime, located dynamically from the
// running process. There is intentionally NO hardcoded/app-specific fallback:
// loading a foreign runtime (e.g. QoderWork's runtime inside QwenWorkCN) is
// exactly what corrupts the app. If we cannot locate the host app's own runtime
// with certainty, we report a worker error immediately. An empty successful
// worker cannot answer the SDK initialize request and causes a long timeout.
//
// On the success path only, token/system-prompt records are appended to the
// host-specific intercept file. Keeping these files separate is required even
// when sibling apps share the same SDK protocol: response-id namespaces and
// process lifecycles belong to different products.

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { isMainThread, workerData } from 'node:worker_threads';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

// The installer deploys this file at <dataDir>/hooks. Deriving the data root
// from the loaded wrapper keeps GUI workers aligned with the orchestrator even
// when no shell environment is inherited and dataDir is customized.
const WRAPPER_PATH = fileURLToPath(import.meta.url);
const PILOT_DATA_DIR = path.dirname(path.dirname(WRAPPER_PATH));
const INTERCEPT_DIR = path.join(PILOT_DATA_DIR, 'logs');
const ERROR_LOG = path.join(INTERCEPT_DIR, 'qoderwork-wrapper-error.log');
const MIN_SYSTEM_PROMPT_LENGTH = 100;

const HOSTS = [
  {
    id: 'qwen-work-cn',
    appNames: ['QwenWorkCN.app'],
    windowsAppNames: ['QwenWorkCN'],
    interceptFile: 'qwenworkcn-intercept.jsonl',
  },
  {
    id: 'qoder-work-cn',
    appNames: ['QoderWork CN.app', 'QoderWorkCN.app'],
    windowsAppNames: ['QoderWork CN', 'QoderWorkCN'],
    interceptFile: 'qoderworkcn-intercept.jsonl',
  },
  {
    id: 'qoder-work',
    appNames: ['QoderWork.app'],
    windowsAppNames: ['QoderWork'],
    interceptFile: 'qoderwork-intercept.jsonl',
  },
];

const origParse = JSON.parse;
const origStringify = JSON.stringify;
let lastId = null;
let systemPromptCaptured = false;

function logDiag(msg) {
  try {
    fs.mkdirSync(INTERCEPT_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

async function failWorker(error) {
  if (!isMainThread) {
    // Some SDK versions destroy Worker stdout on error without ending their
    // downstream line reader. End stdout first so readMessages can reach the
    // Worker error and reject initialize, instead of waiting for its timeout.
    await new Promise(resolve => process.stdout.end(resolve));
  }
  throw error;
}

// Install the JSON.parse / JSON.stringify interception hooks. Only ever called
// right before we import the host app's own runtime, so a worker that fails to
// self-locate is left completely untouched.
function installInterceptHooks(interceptFile) {
  try { fs.mkdirSync(INTERCEPT_DIR, { recursive: true }); } catch {}

  // Intercept SSE-parsed token usage.
  JSON.parse = function (text, reviver) {
    const result = origParse.call(JSON, text, reviver);
    try {
      if (result && typeof result === "object"
          && result.usage && result.choices !== undefined
          && result.id !== lastId) {
        lastId = result.id;
        const u = result.usage;
        const rec = {
          type: "token",
          ts: Date.now(),
          id: result.id,  // chatcmpl-xxx, matches transcript message.id
          model: result.model || "",
          prompt_tokens: u.prompt_tokens || 0,
          cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
          completion_tokens: u.completion_tokens || 0,
          reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
          total_tokens: u.total_tokens || 0,
        };
        // Token records are ~200 bytes, well under PIPE_BUF — atomic on POSIX.
        fs.appendFileSync(interceptFile, origStringify.call(JSON, rec) + "\n");
      }
    } catch {}
    return result;
  };

  // Capture system prompt before request encryption. Each process captures once.
  JSON.stringify = function (value, replacer, space) {
    try {
      if (!systemPromptCaptured && value && typeof value === "object"
          && value.messages && Array.isArray(value.messages)) {
        const sys = value.messages.find(m => m.role === "system");
        if (sys && typeof sys.content === "string" && sys.content.length > MIN_SYSTEM_PROMPT_LENGTH) {
          systemPromptCaptured = true;
          const rec = { type: "system_prompt", ts: Date.now(), content: sys.content };
          fs.appendFileSync(interceptFile, origStringify.call(JSON, rec) + "\n");
        }
      }
    } catch {}
    return origStringify.call(JSON, value, replacer, space);
  };
}

// The SDK worker runtime always lives at this fixed path relative to an app's
// Resources dir. It bundles native deps (sharp / node-pty / keytar), so it must
// be asar-UNPACKED and is guaranteed to exist on disk for a shipped app.
const SDK_WORKER_REL = path.join(
  'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', '_worker',
);
const RUNTIME_NAMES = ['qoder-worker-runtime.obf.mjs', 'qoder-worker-runtime.mjs'];

// Resource roots derived purely from the running process, so they resolve to
// WHICHEVER app is hosting this worker — no app name is ever hardcoded.
function candidateResourceRoots() {
  const roots = [];

  // (1) Enclosing .app bundle from the executable path. In an Electron worker
  // thread process.execPath is the host app's own binary, e.g.
  //   /Applications/QwenWorkCN.app/Contents/MacOS/QwenWorkCN
  // Match the FIRST ".app" (non-greedy) so a nested "*Helper.app" cannot shadow
  // the outer bundle. This is a hard macOS bundle-layout guarantee.
  const exec = process.execPath || '';
  const m = /^(.*?\.app)(?:\/|$)/.exec(exec);
  if (m) roots.push(path.join(m[1], 'Contents', 'Resources'));

  // (2) Electron's resourcesPath, when present, is <App>/Contents/Resources.
  if (process.resourcesPath) roots.push(process.resourcesPath);

  return roots;
}

function classifyHost(resourceRoots) {
  for (const root of resourceRoots) {
    const normalized = root.replace(/\\/g, '/');
    const normalizedLower = normalized.toLowerCase();
    for (const host of HOSTS) {
      if (host.appNames.some(appName => normalized.includes(`/${appName}/Contents/Resources`))) {
        return host;
      }
      if (host.windowsAppNames?.some(appName =>
        matchesWindowsResourcePath(normalizedLower, appName))) {
        return host;
      }
    }
  }
  return null;
}

function matchesWindowsResourcePath(normalizedLower, appName) {
  const parts = normalizedLower.split('/').filter(Boolean);
  const appIndex = parts.lastIndexOf(appName.toLowerCase());
  const resourcesIndex = parts.lastIndexOf('resources');
  return appIndex >= 0
    && resourcesIndex === parts.length - 1
    && resourcesIndex > appIndex
    // Support both <App>/resources and <App>/<version>/resources. Do not
    // accept an arbitrary descendant: that could classify a nested sibling.
    && resourcesIndex - appIndex <= 2;
}

// Locate the host app's OWN worker runtime. Returns an absolute path or null.
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
        if (real === selfPath) continue; // anti-recursion: never import ourselves
        return real;
      } catch {}
    }
  }
  return null;
}

// Development Electron has no app.asar.unpacked. Anchor resolution to the
// executable's owning project, never the conversation CWD or installed apps.
// npm_package_json supports workspaces with a hoisted Electron, but is accepted
// only when that package declares the SDK and resolves the running Electron.
function findDevelopmentRuntime() {
  const exec = fs.realpathSync(process.execPath);
  const normalized = exec.replace(/\\/g, '/');
  if (!normalized.includes('/node_modules/electron/dist/')) return null;
  const projectRoot = exec.slice(0, normalized.indexOf('/node_modules/'));
  const manifests = [process.env.npm_package_json, path.join(projectRoot, 'package.json')];
  for (const manifest of [...new Set(manifests.filter(Boolean))]) {
    if (!path.isAbsolute(manifest)) continue;
    let verifiedProject = false;
    try {
      const pkg = origParse(fs.readFileSync(manifest, 'utf8'));
      const sdkName = '@qoder-ai/qoder-agent-sdk';
      if (![pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]
        .some(deps => deps && Object.hasOwn(deps, sdkName))) continue;
      const hostRequire = createRequire(manifest);
      const electronDir = path.dirname(hostRequire.resolve('electron/package.json'));
      const electronBinary = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim();
      if (fs.realpathSync(path.join(electronDir, 'dist', electronBinary)) !== exec) continue;
      verifiedProject = true;
      // Resolve the public entry instead of package.json: SDK exports may hide
      // its manifest, and the installed package may be an npm alias.
      const entryDir = path.dirname(hostRequire.resolve(sdkName));
      for (const dir of [path.join(entryDir, '_worker'), path.join(entryDir, 'dist', '_worker')]) {
        for (const name of RUNTIME_NAMES) {
          const candidate = path.join(dir, name);
          if (fs.existsSync(candidate)) {
            const real = fs.realpathSync(candidate);
            if (real !== fs.realpathSync(WRAPPER_PATH)) return real;
          }
        }
      }
      // A verified workspace owns this SDK even when its worker is missing.
      // Do not fall through to a different SDK hoisted at the repository root.
      return null;
    } catch {
      if (verifiedProject) return null;
    }
  }
  return null;
}

const resourceRoots = candidateResourceRoots();
const host = classifyHost(resourceRoots);
// Runtime discovery is intentionally independent from host classification.
// A future/unknown sibling app still needs its own worker to run normally even
// though we do not yet know which product-specific intercept file to use.
const hostRuntime = findHostAppRuntime(resourceRoots) || findDevelopmentRuntime();

if (hostRuntime) {
  // Only recognized products get interception. Unknown hosts are transparently
  // forwarded to their own bundled runtime without modifying JSON globals.
  if (host) {
    const interceptFile = path.join(INTERCEPT_DIR, host.interceptFile);
    installInterceptHooks(interceptFile);
  }
  try {
    // The SDK derives these from the override path (our hooks directory).
    // Restore the real runtime's asset root without changing the task CWD.
    const runtimeRoot = path.dirname(hostRuntime);
    process.env.QODER_WORKER_RUNTIME_ASSET_ROOT = runtimeRoot;
    if (workerData?.qoderWorkerRuntime) {
      workerData.qoderWorkerRuntime.runtimeRoot = runtimeRoot;
    }
    // Use file:// URL so Windows absolute paths (C:\...) work with ESM import.
    await import(pathToFileURL(hostRuntime).href);
  } catch (e) {
    // Propagate through Worker 'error'; never leave initialize pending behind
    // a successful empty worker or try a different SDK after a load failure.
    logDiag(
      `host runtime import failed: host=${host?.id || 'unrecognized'}, runtime=${hostRuntime} `
      + `:: ${e && e.message}`,
    );
    await failWorker(e);
  }
} else {
  const message =
    'Pilot host app runtime not found; refusing to load a foreign runtime '
    + `(execPath=${process.execPath || ''}, resourcesPath=${process.resourcesPath || ''})`;
  logDiag(message);
  await failWorker(new Error(message));
}
