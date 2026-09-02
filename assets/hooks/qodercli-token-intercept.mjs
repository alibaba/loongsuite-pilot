// Cross-runtime preload script for token & system prompt capture, shared by the
// qodercli (international) and qoderclicn (CN) product lines.
// Injected via:
//   Bun:  BUN_OPTIONS="--preload=<this-file>" <cli> ...
//   Node: NODE_OPTIONS="--import=<this-file>" <cli> ...
// Writes to: ~/.loongsuite-pilot/logs/<LOONGSUITE_INTERCEPT_FILE>, defaulting to
// qodercli-intercept.jsonl. The runtime wrapper sets the variable per product
// line so two installs on one machine do not interleave into one stream.
//
// Two hooks:
//   JSON.parse  → captures token usage from SSE response (last event with .usage + .choices)
//   JSON.stringify → captures system prompt before request encryption (first messages array with role=system)
//
// Keep this file standard ESM so the same asset works in both Node and Bun.

import * as fs from "node:fs";
import * as path from "node:path";

const INTERCEPT_DIR = path.join(process.env.HOME || "/tmp", ".loongsuite-pilot", "logs");
// basename() keeps the value inside the log dir no matter what it holds.
const INTERCEPT_FILE = path.join(
  INTERCEPT_DIR,
  path.basename(process.env.LOONGSUITE_INTERCEPT_FILE || "qodercli-intercept.jsonl"),
);
const MIN_SYSTEM_PROMPT_LENGTH = 100;

try { fs.mkdirSync(INTERCEPT_DIR, { recursive: true }); } catch {}

const origParse = JSON.parse;
const origStringify = JSON.stringify;
let lastTokenFingerprint = null;
let systemPromptCaptured = false;

function finiteToken(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

// Global override of JSON.parse to intercept SSE-parsed token usage.
// Adds ~0.01ms per call (~600 calls/session). Verified <0.2% overhead.
JSON.parse = function (text, reviver) {
  const result = origParse.call(JSON, text, reviver);
  try {
    if (result && typeof result === "object"
        && result.usage && result.choices !== undefined
        && typeof result.id === "string" && result.id) {
      const u = result.usage;
      const rec = {
        type: "token",
        ts: Date.now(),
        id: result.id,
        model: result.model || "",
        prompt_tokens: finiteToken(u.prompt_tokens),
        cached_tokens: finiteToken(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens),
        completion_tokens: finiteToken(u.completion_tokens),
        reasoning_tokens: finiteToken(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
        total_tokens: finiteToken(u.total_tokens),
      };
      // The same final SSE object can be parsed more than once. Suppress exact
      // duplicates while allowing a later, more complete usage object for the
      // same response id to replace the earlier value in the reader/enricher.
      const fingerprint = [
        rec.id,
        rec.prompt_tokens,
        rec.cached_tokens,
        rec.completion_tokens,
        rec.reasoning_tokens,
        rec.total_tokens,
      ].join(":");
      if (fingerprint !== lastTokenFingerprint) {
        lastTokenFingerprint = fingerprint;
        // Token records are ~200 bytes, well under PIPE_BUF — atomic on POSIX.
        fs.appendFileSync(INTERCEPT_FILE, origStringify.call(JSON, rec) + "\n");
      }
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
