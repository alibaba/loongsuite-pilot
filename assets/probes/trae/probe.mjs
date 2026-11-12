// Loongsuite Pilot — Trae plugin-probe preload (standalone ESM .mjs).
//
// Loaded via `NODE_OPTIONS="--import file://<abs>/probe.mjs"` before Trae
// Electron (main process + ext-host fork) starts. Monkey-patches
// `node:https.request`, filters by the 4 chatverse hosts, buffers the request
// body, wraps the returned ClientRequest to listen for `'response'` +
// `'data'` + `'end'` on the IncomingMessage, and emits JSONL event records
// to `$PILOT_LOG_DIR/trae-YYYY-MM-DD.jsonl`.
//
// Event schema conforms to docs/EVENT_LOG_TO_TRACE_SPEC.md (event-log-spec):
//   event.name ∈ { llm.request, llm.response, tool.call, tool.result, other }
//   ID 三件套: gen_ai.session.id = conversation_id
//             gen_ai.turn.id    = chat_session_id
//             gen_ai.step.id    = chat_message_id
//             gen_ai.tool.call.id = tool_call_key
//   usage 字段重命名: prompt_tokens   → gen_ai.usage.input_tokens
//                     completion_tokens → gen_ai.usage.output_tokens
//                     total_tokens    → gen_ai.usage.total_tokens
//   tool 状态机 6→4 归并: pending/running → running; success → success;
//                         failed → failed; canceled/interrupted → cancelled
//
// Source fixture ground truth: researcher fx-1~fx-5 (AGE-2836).

import { appendFileSync, mkdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const SCHEMA = "loongsuite.pilot.trae.v1";
const MODULE = "loongsuite-pilot-trae-probe";
const LOG_PREFIX = "trae";

// P1 host 白名单 (architect `2fdcb032` 收敛)：只匹配 4 个 chatverse 生产域，
// 不再使用 /chatverse|byteintl|trae|marscode|icube/i 宽正则。
const CHAVERSE_HOSTS = new Set([
  "chatverse-prod.byteintl.net",
  "chatverse-us-prod.byteintl.net",
  "chatverse-us.byteintl.net",
  "chatverse.byteintl.net",
]);

// 路径 → 业务类别。chatverse 路径前缀全部为 `/api/ide/v1/` 或 `/api/ide/v2/`。
const PATH_CHAT = /^\/api\/ide\/v\d\/llm_raw_chat(\/|$)|^\/api\/ide\/v\d\/chat(\/|$)/;
const PATH_AGENT_RUN = /^\/api\/ide\/v\d\/agents\/runs$/;
const PATH_TOOL_OUTPUT = /^\/api\/ide\/v\d\/agents\/runs\/[^/]+\/tool_call_outputs$/;
const PATH_WEB_SEARCH = /^\/api\/ide\/v\d\/web_search$/;
const PATH_FAST_APPLY = /^\/api\/ide\/v\d\/fast_apply$/;

const TOOL_STATUS_MAP = {
  pending: "running",
  running: "running",
  success: "success",
  failed: "failed",
  canceled: "cancelled",
  interrupted: "cancelled",
};

let _installed = false;
let _captureOverride = null;

// Test hook: a capture sink may be registered before activation via
// `globalThis.__TRAE_PROBE_CAPTURE`. Production code leaves this unset and
// emit() falls through to appendFileSync/stdout.
if (typeof globalThis !== "undefined" && typeof globalThis.__TRAE_PROBE_CAPTURE === "function") {
  _captureOverride = globalThis.__TRAE_PROBE_CAPTURE;
}

function resolveLogDir() {
  return process.env.PILOT_LOG_DIR || process.env.PILOT_DATA_DIR || null;
}

function todayStamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function logFile() {
  const dir = resolveLogDir();
  if (!dir) return null;
  try { mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
  return pathJoin(dir, `${LOG_PREFIX}-${todayStamp()}.jsonl`);
}

function nowNanos() {
  // Date.now() returns ms; *1e6 to ns. String to preserve uint64 precision.
  return String(Date.now() * 1_000_000);
}

function emit(record) {
  const line = JSON.stringify({ schema: SCHEMA, ...record }) + "\n";
  if (_captureOverride) {
    _captureOverride(line);
    return;
  }
  const file = logFile();
  if (file) {
    try { appendFileSync(file, line); return; } catch { /* fall through to stdout */ }
  }
  try { process.stdout.write(line); } catch { /* no-op */ }
}

function isTargetHost(host) {
  if (typeof host !== "string") return false;
  // Strip port if present.
  const bare = host.split(":")[0];
  return CHAVERSE_HOSTS.has(bare);
}

function normalizeToolStatus(raw) {
  if (typeof raw !== "string") return undefined;
  return TOOL_STATUS_MAP[raw] ?? raw;
}

function asString(v) {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function safeJsonParse(s) {
  if (typeof s !== "string") return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

function pickRequestMeta(opts) {
  const host = asString(opts.hostname || opts.host || (opts.uri && opts.uri.host));
  const reqPath = asString(opts.path || (opts.uri && opts.uri.path));
  const method = asString(opts.method) || "GET";
  return { host, path: reqPath, method };
}

// Parse the buffered request body. Returns the parsed object or undefined.
// Trae uses `got` with `{json:true}` — body is JSON serialized before write.
function parseRequestBody(chunks) {
  if (!chunks || chunks.length === 0) return undefined;
  const buf = Buffer.concat(chunks);
  const text = buf.toString("utf8");
  if (!text) return undefined;
  return safeJsonParse(text);
}

function categorizePath(reqPath) {
  if (!reqPath) return "other";
  if (PATH_CHAT.test(reqPath)) return "chat";
  if (PATH_AGENT_RUN.test(reqPath)) return "agent_run";
  if (PATH_TOOL_OUTPUT.test(reqPath)) return "tool_output";
  if (PATH_WEB_SEARCH.test(reqPath)) return "web_search";
  if (PATH_FAST_APPLY.test(reqPath)) return "fast_apply";
  return "other";
}

function buildUserMessages(body) {
  const query = asString(body && body.query);
  if (!query) return undefined;
  return [{ role: "user", parts: [{ type: "text", content: query }] }];
}

function extractAgentFields(body) {
  const agent = body && body.agent;
  if (!agent || typeof agent !== "object") return {};
  return {
    "gen_ai.agent.name": asString(agent.agent_name),
    "gen_ai.agent.type": asString(agent.agent_type),
    agent_id: asString(agent.agent_id),
    agent_source: asString(agent.agent_source),
  };
}

function extractSessionIds(body) {
  // 三件套可能出现在顶层 (fx-1 chatAPI) 或 rpc 包裹内 (fx-3 tool_call_outputs)。
  const rpc = body && body.rpc;
  return {
    conversation_id: asString(body && body.conversation_id) || asString(rpc && rpc.conversation_id),
    chat_session_id: asString(body && body.chat_session_id) || asString(rpc && rpc.chat_session_id),
    chat_message_id: asString(body && body.chat_message_id) || asString(rpc && rpc.chat_message_id),
  };
}

function buildIdBlock(body) {
  const ids = extractSessionIds(body);
  const out = {};
  if (ids.conversation_id) {
    out["gen_ai.session.id"] = ids.conversation_id;
    out.trace_id = ids.conversation_id;
  }
  if (ids.chat_session_id) out["gen_ai.turn.id"] = ids.chat_session_id;
  if (ids.chat_message_id) out["gen_ai.step.id"] = ids.chat_message_id;
  return out;
}

function emitChatRequest(body, meta) {
  const record = {
    "event.id": `trae-llm-req-${process.pid}-${Date.now()}`,
    "event.name": "llm.request",
    time_unix_nano: nowNanos(),
    ...buildIdBlock(body),
    "gen_ai.request.model": asString(body && body.model),
    "gen_ai.input.messages": buildUserMessages(body),
    ...extractAgentFields(body),
    "gen_ai.tool.definitions": (body && body.userSelectedTools) || undefined,
  };
  emit(record);
}

function emitChatResponse(meta, bufferText, usageRaw, finishReason) {
  const out = [];
  if (bufferText) {
    out.push({ role: "assistant", parts: [{ type: "text", content: bufferText }] });
  }
  const record = {
    "event.id": `trae-llm-resp-${process.pid}-${Date.now()}`,
    "event.name": "llm.response",
    time_unix_nano: nowNanos(),
    "gen_ai.response.id": meta.responseId,
    "gen_ai.response.model": asString(meta.model),
    "gen_ai.response.finish_reasons": finishReason ? [finishReason] : undefined,
    "gen_ai.output.messages": out.length > 0 ? out : undefined,
  };
  if (usageRaw) {
    // fx-5 字段重命名 (prompt_tokens/completion_tokens → input/output_tokens)
    record["gen_ai.usage.input_tokens"] =
      asNumber(usageRaw.input_tokens) ?? asNumber(usageRaw.prompt_tokens);
    record["gen_ai.usage.output_tokens"] =
      asNumber(usageRaw.output_tokens) ?? asNumber(usageRaw.completion_tokens);
    record["gen_ai.usage.total_tokens"] =
      asNumber(usageRaw.total_tokens);
  }
  emit(record);
}

function emitToolCall(body, meta) {
  const tool = body && body.tool;
  const toolName = asString(tool && tool.name) || asString(body && body.tool_name);
  const record = {
    "event.id": `trae-tool-call-${process.pid}-${Date.now()}`,
    "event.name": "tool.call",
    time_unix_nano: nowNanos(),
    ...buildIdBlock(body),
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.call.id": asString(body && body.tool_call_key)
      || asString(body && body.rpc && body.rpc.tool_call_key)
      || asString(tool && tool.call_id),
    "gen_ai.tool.call.arguments": (tool && tool.arguments) || undefined,
  };
  emit(record);
}

function emitToolResult(body, meta) {
  const tool = body && body.tool;
  const rawStatus = asString(tool && tool.status) || asString(body && body.status);
  const record = {
    "event.id": `trae-tool-result-${process.pid}-${Date.now()}`,
    "event.name": "tool.result",
    time_unix_nano: nowNanos(),
    ...buildIdBlock(body),
    "gen_ai.tool.name": asString(tool && tool.name) || asString(body && body.tool_name),
    "gen_ai.tool.call.id": asString(body && body.tool_call_key)
      || asString(body && body.rpc && body.rpc.tool_call_key)
      || asString(tool && tool.call_id),
    "gen_ai.tool.call.result": (tool && tool.output) || (body && body.output),
    "tool.result.status": normalizeToolStatus(rawStatus),
    "gen_ai.tool.call.duration":
      asNumber(tool && tool.duration_ms) ?? asNumber(body && body.duration_ms),
  };
  emit(record);
}

// Parse a single SSE chunk line `data: {...}\n\n`. Returns parsed JSON or undefined.
function parseSseDataLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return { done: true };
  return safeJsonParse(payload);
}

// Try to parse a chatverse streamed JSON message. The exact shape varies by
// endpoint (chat vs llm_raw_chat); we look for common delta+content fields.
function extractDeltaText(message) {
  if (!message || typeof message !== "object") return undefined;
  // OpenAI-style choices[0].delta.content
  const choices = message.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const delta = choices[0].delta || choices[0].message;
    const content = delta && (delta.content || delta.text);
    if (typeof content === "string") return content;
  }
  // Trae/byteintl envelope: { data: { content: "..." } } or { delta: { content } }
  const data = message.data;
  if (data && typeof data === "object") {
    const c = data.content || data.delta || (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content);
    if (typeof c === "string") return c;
  }
  if (message.delta && typeof message.delta === "object" && typeof message.delta.content === "string") {
    return message.delta.content;
  }
  if (typeof message.content === "string") return message.content;
  return undefined;
}

function extractUsage(message) {
  if (!message || typeof message !== "object") return undefined;
  const u = message.usage || (message.data && message.data.usage);
  if (u && typeof u === "object") return u;
  return undefined;
}

function extractFinishReason(message) {
  if (!message || typeof message !== "object") return undefined;
  const choices = message.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const reason = choices[0].finish_reason || choices[0].finishReason;
    if (typeof reason === "string") return reason;
  }
  if (typeof message.finish_reason === "string") return message.finish_reason;
  return undefined;
}

// Wrap an IncomingMessage to collect streamed text + usage. Returns
// `{ collectedText, rawBodyText, usageRaw, finishReason, parsedFinalMessage }`.
// `collectedText` holds extracted delta content (SSE-framed OpenAI choices);
// `rawBodyText` holds the raw response bytes for endpoints that reply with a
// single JSON body instead of an SSE stream (e.g. tool_call_outputs).
function createResponseCollector() {
  let collected = "";
  let rawBuf = [];
  let usageRaw;
  let finishReason;
  let parsedFinalMessage;

  function onData(buf) {
    const text = buf.toString("utf8");
    rawBuf.push(text);
    // SSE framing: split on \n\n. Otherwise treat as raw JSON line.
    const segments = text.split(/\n\n/);
    for (const seg of segments) {
      const lines = seg.split(/\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseSseDataLine(line);
        if (!parsed) {
          // Maybe a raw JSON object (not SSE-framed).
          const rawJson = safeJsonParse(line.trim());
          if (rawJson) handleParsedMessage(rawJson);
          continue;
        }
        if (parsed.done) { finishReason = finishReason || "stop"; continue; }
        handleParsedMessage(parsed);
      }
    }
  }

  function handleParsedMessage(msg) {
    const delta = extractDeltaText(msg);
    if (delta) collected += delta;
    const u = extractUsage(msg);
    if (u) usageRaw = u;
    const r = extractFinishReason(msg);
    if (r) finishReason = r;
    // Heuristic: chatverse wraps the final message with usage on the last
    // chunk; if a chunk contains usage, treat it as the canonical final.
    if (u) parsedFinalMessage = msg;
  }

  return {
    onData,
    get collectedText() { return collected; },
    get rawBodyText() { return rawBuf.join(""); },
    get usageRaw() { return usageRaw; },
    get finishReason() { return finishReason; },
    get parsedFinalMessage() { return parsedFinalMessage; },
  };
}

function wrapRequest(req, opts, meta) {
  const category = categorizePath(meta.path);
  if (category === "other") return req;

  const chunks = [];
  const origWrite = req.write.bind(req);
  const origEnd = req.end.bind(req);

  req.write = function (chunk, ...rest) {
    if (chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buf);
    }
    return origWrite(chunk, ...rest);
  };

  // `end` may be called as end(chunk, encoding, cb) | end(chunk, cb) | end(cb) | end()
  req.end = function (...args) {
    if (typeof args[0] !== "function" && args[0] != null) {
      const buf = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(String(args[0]));
      chunks.push(buf);
    }
    const body = parseRequestBody(chunks);
    dispatchRequestByCategory(category, body, meta);

    return origEnd(...args);
  };

  // Wrap response listener.
  try {
    req.on("response", (res) => {
      const statusCode = res.statusCode;
      const collector = createResponseCollector();
      res.on("data", (chunk) => {
        collector.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });
      res.on("end", () => {
        dispatchResponseByCategory(category, collector, { statusCode, ...meta });
      });
    });
  } catch (e) {
    emit({
      "event.id": `trae-wrap-failed-${process.pid}-${Date.now()}`,
      "event.name": "other",
      time_unix_nano: nowNanos(),
      "error.type": "wrap_failed",
      "error.message": String(e),
    });
  }
  return req;
}

function dispatchRequestByCategory(category, body, meta) {
  try {
    switch (category) {
      case "chat":
        emitChatRequest(body, meta);
        break;
      case "tool_output":
        emitToolCall(body, meta);
        break;
      case "web_search":
        emitToolCall(body, meta);
        break;
      case "agent_run":
        // fx-5 agent_finish may arrive here; the tool_result path carries the
        // agent_finish signal. For agent_run POST itself, no event emitted
        // (the AGENT span is derived from session/turn ids).
        break;
      case "fast_apply":
        // file edit tool — emit as tool.call (no separate result path)
        emitToolCall({ tool: { name: "fast_apply", arguments: body }, ...body }, meta);
        break;
      default:
        break;
    }
  } catch (e) {
    emit({
      "event.id": `trae-dispatch-req-failed-${process.pid}-${Date.now()}`,
      "event.name": "other",
      time_unix_nano: nowNanos(),
      "error.type": "request_dispatch_failed",
      "error.message": String(e),
    });
  }
}

function dispatchResponseByCategory(category, collector, meta) {
  try {
    switch (category) {
      case "chat": {
        emitChatResponse(meta, collector.collectedText, collector.usageRaw, collector.finishReason);
        break;
      }
      case "tool_output": {
        // fx-3/fx-5: tool_call_outputs response carries the tool result body.
        // When tool.name === agent_finish, this is the turn-end signal — emit
        // as llm.response with usage tokens (per spec: usage goes on llm.response).
        const finalMsg = collector.parsedFinalMessage;
        const body = finalMsg || safeJsonParse(collector.rawBodyText);
        const tool = body && (body.tool || body);
        const toolName = asString(tool && tool.name) || asString(body && body.tool_name);
        if (toolName === "agent_finish") {
          emitChatResponse(meta, undefined, tool && tool.usage, "stop");
          break;
        }
        emitToolResult(body, meta);
        break;
      }
      case "web_search": {
        const finalMsg = collector.parsedFinalMessage;
        const body = finalMsg || safeJsonParse(collector.rawBodyText);
        emitToolResult(body, meta);
        break;
      }
      case "fast_apply": {
        const finalMsg = collector.parsedFinalMessage;
        const body = finalMsg || safeJsonParse(collector.rawBodyText);
        emitToolResult(body, meta);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    emit({
      "event.id": `trae-dispatch-resp-failed-${process.pid}-${Date.now()}`,
      "event.name": "other",
      time_unix_nano: nowNanos(),
      "error.type": "response_dispatch_failed",
      "error.message": String(e),
    });
  }
}

function installHttpsHook() {
  const https = require("node:https");
  const origRequest = https.request;
  https.request = function patchedRequest(urlOrOpts, optsOrCb, maybeCb) {
    const args = arguments;
    const opts = typeof urlOrOpts === "string" || urlOrOpts instanceof URL
      ? (typeof optsOrCb === "object" && optsOrCb !== null ? optsOrCb : {})
      : (urlOrOpts && typeof urlOrOpts === "object" ? urlOrOpts : {});
    const meta = pickRequestMeta(opts);

    const req = origRequest.apply(this, args);
    if (!isTargetHost(meta.host)) return req;
    return wrapRequest(req, opts, meta);
  };
  _installed = true;
}

function activate() {
  emit({
    "event.id": `trae-activate-${process.pid}-${Date.now()}`,
    "event.name": "other",
    time_unix_nano: nowNanos(),
    module: MODULE,
    pid: process.pid,
    ppid: process.ppid,
    node_version: process.version,
    electron: typeof process.versions.electron === "string" ? process.versions.electron : null,
    pilot_log_dir: resolveLogDir(),
  });
  try {
    installHttpsHook();
  } catch (e) {
    emit({
      "event.id": `trae-hook-failed-${process.pid}-${Date.now()}`,
      "event.name": "other",
      time_unix_nano: nowNanos(),
      "error.type": "hook_install_failed",
      "error.message": String(e),
    });
  }
}

// Test-only escape hatch: substitute the emit sink. Pass null to revert.
export function __setEmitOverride(fn) {
  _captureOverride = typeof fn === "function" ? fn : null;
}

export function __isInstalled() { return _installed; }

export {
  activate,
  installHttpsHook,
  isTargetHost,
  categorizePath,
  normalizeToolStatus,
  CHAVERSE_HOSTS,
};

activate();
