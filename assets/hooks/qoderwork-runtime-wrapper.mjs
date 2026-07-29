// QoderWork-family worker runtime wrapper — transparent, app-agnostic shim.
//
// Loaded via the SHARED env var QODER_WORKER_RUNTIME_PATH. The ENTIRE
// @qoder-ai/qoder-agent-sdk family honours this variable (QoderWork,
// QwenWorkCN, QoderWork CN, ...), and on macOS we set it with `launchctl
// setenv`, which is GLOBAL to the launchd user domain. Consequences:
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
// with certainty, we install nothing and load nothing — token interception is
// sacrificed, the app is never handed a wrong runtime.
//
// On the success path only, token/system-prompt records are appended to
// ~/.loongsuite-pilot/logs/qoderwork-intercept.jsonl.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

const INTERCEPT_DIR = path.join(process.env.HOME || '/tmp', '.loongsuite-pilot', 'logs');
const INTERCEPT_FILE = path.join(INTERCEPT_DIR, 'qoderwork-intercept.jsonl');
const ERROR_LOG = path.join(INTERCEPT_DIR, 'qoderwork-wrapper-error.log');
const MIN_SYSTEM_PROMPT_LENGTH = 100;

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

// Install the JSON.parse / JSON.stringify interception hooks. Only ever called
// right before we import the host app's own runtime, so a worker that fails to
// self-locate is left completely untouched.
function installInterceptHooks() {
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
        fs.appendFileSync(INTERCEPT_FILE, origStringify.call(JSON, rec) + "\n");
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
          fs.appendFileSync(INTERCEPT_FILE, origStringify.call(JSON, rec) + "\n");
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

// Locate the host app's OWN worker runtime. Returns an absolute path or null.
function findHostAppRuntime() {
  let selfPath = '';
  try { selfPath = fs.realpathSync(fileURLToPath(import.meta.url)); } catch {}

  const seen = new Set();
  for (const root of candidateResourceRoots()) {
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

const hostRuntime = findHostAppRuntime();

if (hostRuntime) {
  // Certain we will hand control to the host app's OWN runtime. Install
  // interception, then load it. The app behaves exactly as if unhooked, plus we
  // capture token usage.
  installInterceptHooks();
  try {
    await import(hostRuntime);
  } catch (e) {
    // The app's own runtime failed to load — the app would have hit this even
    // without us. Do not throw (module-level throw crashes the worker_thread and
    // blocks the SDK's own transport fallback) and do not try any other runtime.
    logDiag(`host runtime import failed: ${hostRuntime} :: ${e && e.message}`);
  }
} else {
  // Could not locate the host app's own runtime. Per design priority we refuse
  // to load any guessed/foreign runtime (that is what broke QwenWorkCN). Install
  // nothing, load nothing: token interception is lost, the app is never handed a
  // wrong runtime. The SDK detects the empty worker entry and degrades on its own.
  logDiag(
    'host app runtime not found — skipping intercept to avoid loading a foreign runtime '
    + `(execPath=${process.execPath || ''}, resourcesPath=${process.resourcesPath || ''})`,
  );
}
