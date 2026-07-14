// QoderWork worker runtime wrapper — intercepts token data via JSON.parse hook.
// Loaded via: QODER_WORKER_RUNTIME_PATH=<this-file>
//
// QoderWork runs its agent SDK in a Node.js worker_thread (not Bun), so the
// qodercli BUN_OPTIONS --preload trick does not apply. The SDK honors
// QODER_WORKER_RUNTIME_PATH as the worker entry, so we wrap it: install a
// JSON.parse/JSON.stringify hook, then `await import()` the real runtime.
//
// Writes to: ~/.loongsuite-pilot/logs/qoderwork-intercept.jsonl
// The captured `id` (chatcmpl-xxx) matches the hook processor's
// gen_ai.response.id (derived from transcript message.id), enabling direct
// token matching in qoder-work-trace-input without a transcript mapping module.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

const INTERCEPT_DIR = path.join(process.env.HOME || '/tmp', '.loongsuite-pilot', 'logs');
const INTERCEPT_FILE = path.join(INTERCEPT_DIR, 'qoderwork-intercept.jsonl');
const MIN_SYSTEM_PROMPT_LENGTH = 100;

try { fs.mkdirSync(INTERCEPT_DIR, { recursive: true }); } catch {}

const origParse = JSON.parse;
const origStringify = JSON.stringify;
let lastId = null;
let systemPromptCaptured = false;

// Global override of JSON.parse to intercept SSE-parsed token usage.
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

// Global override of JSON.stringify to capture system prompt before request encryption.
// Each process captures at most once (systemPromptCaptured flag).
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

// Discover and load the real QoderWork runtime. Cover both the system-wide
// install (`/Applications/...`) and the per-user install (`~/Applications/...`),
// each with obfuscated (`.obf.mjs`) and non-obfuscated (`.mjs`) variants.
const SDK_REL_BASE = 'Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker';
const RUNTIME_CANDIDATES = [
  `/Applications/QoderWork.app/${SDK_REL_BASE}/qoder-worker-runtime.obf.mjs`,
  `/Applications/QoderWork.app/${SDK_REL_BASE}/qoder-worker-runtime.mjs`,
  path.join(process.env.HOME || '', `Applications/QoderWork.app/${SDK_REL_BASE}/qoder-worker-runtime.obf.mjs`),
  path.join(process.env.HOME || '', `Applications/QoderWork.app/${SDK_REL_BASE}/qoder-worker-runtime.mjs`),
];

let loaded = false;
let lastErr = null;
for (const candidate of RUNTIME_CANDIDATES) {
  try {
    if (fs.existsSync(candidate)) {
      await import(candidate);
      loaded = true;
      break;
    }
  } catch (e) { lastErr = e; }
}

if (!loaded) {
  // Log a diagnostic but do NOT throw. Throwing at module level crashes the
  // worker_thread entirely, which would also prevent the QoderWork SDK from
  // falling back to its ProcessTransport. By returning silently we let the SDK
  // detect "no runtime registered" and degrade on its own — token interception
  // is lost (acceptable) but normal agent operation is not disrupted.
  try {
    fs.appendFileSync(path.join(INTERCEPT_DIR, 'qoderwork-wrapper-error.log'),
      `[${new Date().toISOString()}] real runtime not found in candidates: ${RUNTIME_CANDIDATES.join(', ')}\n` +
      (lastErr ? `last error: ${lastErr.message}\n` : ''));
  } catch {}
}
