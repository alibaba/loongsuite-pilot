// BUN_OPTIONS preload script for qodercli token & system prompt capture.
// Injected via: BUN_OPTIONS="--preload=<this-file>" qodercli ...
// Writes to: ~/.loongsuite-pilot/logs/qodercli-intercept.jsonl
//
// Two hooks:
//   JSON.parse  → captures token usage from SSE response (last event with .usage + .choices)
//   JSON.stringify → captures system prompt before request encryption (first messages array with role=system)
//
// NOTE: This file uses require() which is Bun-specific in .mjs context.
// It only runs under BUN_OPTIONS --preload inside a compiled Bun binary (qodercli).

const fs = require("node:fs");
const path = require("node:path");

const INTERCEPT_DIR = path.join(process.env.HOME || "/tmp", ".loongsuite-pilot", "logs");
const INTERCEPT_FILE = path.join(INTERCEPT_DIR, "qodercli-intercept.jsonl");
const MIN_SYSTEM_PROMPT_LENGTH = 100;

try { fs.mkdirSync(INTERCEPT_DIR, { recursive: true }); } catch {}

const origParse = JSON.parse;
const origStringify = JSON.stringify;
let lastId = null;
let systemPromptCaptured = false;

// Global override of JSON.parse to intercept SSE-parsed token usage.
// Adds ~0.01ms per call (~600 calls/session). Verified <0.2% overhead.
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
      const sys = value.messages.find(function (m) { return m.role === "system"; });
      if (sys && typeof sys.content === "string" && sys.content.length > MIN_SYSTEM_PROMPT_LENGTH) {
        systemPromptCaptured = true;
        const rec = {
          type: "system_prompt",
          ts: Date.now(),
          content: sys.content,
        };
        fs.appendFileSync(INTERCEPT_FILE, origStringify.call(JSON, rec) + "\n");
      }
    }
  } catch {}
  return origStringify.call(JSON, value, replacer, space);
};
