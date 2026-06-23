// QoderWork worker runtime wrapper — intercepts token data via JSON.parse hook.
//
// Loaded via: QODER_WORKER_RUNTIME_PATH=<this-file>
//
// QoderWork 0.6.2+ no longer spawns a qodercli Bun subprocess; its LLM calls run
// inside a Node.js worker_thread that loads qoder-worker-runtime.obf.mjs. We can't
// use BUN_OPTIONS --preload (no Bun child) or NODE_OPTIONS --require (Electron
// strips it). Instead the SDK honors the QODER_WORKER_RUNTIME_PATH env var to
// locate the worker runtime — so we point it at this wrapper, which installs the
// same JSON.parse / JSON.stringify hooks as assets/hooks/qodercli-token-intercept.mjs
// and then `await import()`s the real runtime.
//
// Flow: install hook → import real runtime → worker runs normally with hook active.
// Token + system-prompt records are written to the SAME intercept JSONL as the
// qodercli CLI intercept, so pilot's intercept-token-reader.ts needs no changes.
//
// Deployment: postinstall.js copies this file to ~/.loongsuite-pilot/hooks/ and runs
// `launchctl setenv QODER_WORKER_RUNTIME_PATH <this-file>` (macOS). QoderWork must be
// restarted after install/uninstall for the env change to take effect.

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const INTERCEPT_DIR = path.join(process.env.HOME || '/tmp', '.loongsuite-pilot', 'logs');
const INTERCEPT_FILE = path.join(INTERCEPT_DIR, 'qodercli-intercept.jsonl');
const MIN_SYSTEM_PROMPT_LENGTH = 100;

try { fs.mkdirSync(INTERCEPT_DIR, { recursive: true }); } catch {}

const DEBUG = !!process.env.LOONGSUITE_PILOT_INTERCEPT_DEBUG;
function debug(msg) { if (DEBUG) try { fs.appendFileSync(path.join(INTERCEPT_DIR, 'qoderwork-wrapper.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {} }

const origParse = JSON.parse;
const origStringify = JSON.stringify;
let lastId = null;
let systemPromptCaptured = false;

// ── JSON.parse hook: capture token usage from the SSE response ──────────────
// Must stay byte-for-byte consistent with qodercli-token-intercept.mjs so both
// producers emit the identical record shape consumed by intercept-token-reader.ts.
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
        id: result.id,
        model: result.model || "",
        prompt_tokens: u.prompt_tokens || 0,
        cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
        completion_tokens: u.completion_tokens || 0,
        reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
        total_tokens: u.total_tokens || 0,
      };
      fs.appendFileSync(INTERCEPT_FILE, origStringify.call(JSON, rec) + "\n");
    }
  } catch {}
  return result;
};

// ── JSON.stringify hook: capture system prompt before request encryption ─────
JSON.stringify = function (value, replacer, space) {
  try {
    if (!systemPromptCaptured && value && typeof value === "object"
        && value.messages && Array.isArray(value.messages)) {
      const sys = value.messages.find(function (m) { return m.role === "system"; });
      if (sys && typeof sys.content === "string" && sys.content.length > MIN_SYSTEM_PROMPT_LENGTH) {
        systemPromptCaptured = true;
        const rec = { type: "system_prompt", ts: Date.now(), content: sys.content };
        fs.appendFileSync(INTERCEPT_FILE, origStringify.call(JSON, rec) + "\n");
      }
    }
  } catch {}
  return origStringify.call(JSON, value, replacer, space);
};

// ── Load the real QoderWork runtime ──────────────────────────────────────────
// Resolve the original runtime the SDK would have loaded. Allow an explicit
// override (useful for tests / pinned paths); otherwise probe the standard
// app.asar.unpacked layout on macOS for both the obfuscated and plain bundles.
const RUNTIME_CANDIDATES = [
  process.env.QODER_WORKER_RUNTIME_REAL_PATH,
  '/Applications/QoderWork.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs',
  '/Applications/QoderWork.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.mjs',
  path.join(process.env.HOME || '', 'Applications/QoderWork.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs'),
  path.join(process.env.HOME || '', 'Applications/QoderWork.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.mjs'),
].filter(Boolean);

let loaded = false;
for (const candidate of RUNTIME_CANDIDATES) {
  try {
    if (fs.existsSync(candidate)) {
      debug(`loading real runtime: ${candidate}`);
      await import(candidate);
      loaded = true;
      break;
    }
  } catch (err) {
    debug(`failed to load ${candidate}: ${err && err.message}`);
  }
}

if (!loaded) {
  // Fatal: can't find real runtime. The worker will throw, and the SDK's
  // WorkerFallbackTransport falls back to ProcessTransport (spawns qodercli),
  // so AI stays functional — token capture is just degraded.
  debug('real runtime not found in any candidate path — SDK will fall back to ProcessTransport');
  throw new Error('qoderwork-runtime-wrapper: real runtime not found in any candidate path');
}

debug('wrapper initialized, hooks active');
