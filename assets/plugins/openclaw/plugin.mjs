/**
 * loongsuite-pilot OpenClaw event_t plugin
 *
 * Runs inside the OpenClaw process (Node.js). Registers 16 plugin hooks
 * (7 conversation-access + 9 default-active) via `api.on(hookName, handler)` and
 * converts OpenClaw hook events into ARMS GenAI event_t JSONL records for
 * consumption by loongsuite-pilot's BaseHookInput pipeline.
 *
 * Zero external dependencies — only Node.js built-in APIs. The plugin entry
 * shape mirrors what `definePluginEntry(...)` from `openclaw/plugin-sdk/core`
 * returns; the loader accepts a plain object with the same fields.
 *
 * Hook event shape ground-truth: researcher fixtures
 *   /tmp/pilot-probe-events-smoke.jsonl (10 hooks, single LLM call)
 *   /tmp/pilot-probe-events-cp2.jsonl    (21 hooks, ReAct + 2 parallel tools)
 * Both fixtures are attached to issue AGE-1304 and are the unit-test
 * ground truth — do NOT synthesize payloads.
 *
 * Span mapping (per /event-log-spec):
 *   ENTRY  ← session_start / session_end (sessionId)
 *   AGENT  ← before_agent_run → agent_end (runId)
 *   STEP   ← model_call_started / model_call_ended (callId = <runId>:model:<N>)
 *   LLM    ← llm_input / llm_output / model_call_* (callId)
 *   TOOL   ← before_tool_call / after_tool_call / tool_result_persist (toolCallId)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const AGENT_TYPE = "openclaw";
const PLUGIN_ID = "loongsuite-pilot-openclaw";
const MAX_RUNS = 200;
const MAX_SESSIONS = 100;
const MAX_RUN_STATE_ENTRIES = 512;
const MAX_CONTENT_SIZE = 64 * 1024;
const MAX_TOOL_RESULT_SIZE = 64 * 1024;
const PILOT_CONFIG_CACHE_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// Caller-supplied span attributes (inlined mirror of resource-context.mjs)
// ---------------------------------------------------------------------------
const SPAN_ATTR_RESERVED_PREFIXES = [
  "gen_ai.",
  "git.",
  "workspace.",
  "event.",
  "trace_",
  "user.",
  "cost_",
  "agent.",
  "time_unix_nano",
  "observed_time_unix_nano",
];
const SPAN_ATTR_MAX_VALUE_LENGTH = 512;
const SPAN_ATTR_SENSITIVE_RE =
  /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;

function parseSpanAttributesFromEnv(env = process.env) {
  const out = {};
  const raw = env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
  if (typeof raw !== "string" || raw.length === 0) return out;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key || !value) continue;
    if (SPAN_ATTR_RESERVED_PREFIXES.some((p) => key === p || key.startsWith(p))) continue;
    if (SPAN_ATTR_SENSITIVE_RE.test(key)) continue;
    if (value.length > SPAN_ATTR_MAX_VALUE_LENGTH) continue;
    out[key] = value;
  }
  return out;
}

const SPAN_ATTRIBUTES = parseSpanAttributesFromEnv(process.env);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveDataDir() {
  return (
    process.env.LOONGSUITE_PILOT_DATA_DIR ||
    process.env.PILOT_DATA ||
    path.join(os.homedir(), ".loongsuite-pilot")
  );
}

function logDir() {
  return path.join(resolveDataDir(), "logs", "openclaw");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function todayStamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

// ---------------------------------------------------------------------------
// ID + time helpers
// ---------------------------------------------------------------------------

function generateTraceId() {
  return crypto.randomBytes(16).toString("hex");
}

function nowNanos() {
  return `${Date.now()}000000`;
}

function completionNanos(startNanos, durationMs) {
  if (!startNanos || typeof durationMs !== "number" || !Number.isFinite(durationMs)) return undefined;
  // Preserve a non-zero span when OpenClaw reports a rounded 0 ms duration;
  // strict trace validation rejects zero-length tool spans.
  const durationNanos = Math.max(1_000_000, Math.round(durationMs * 1_000_000));
  return (BigInt(startNanos) + BigInt(durationNanos)).toString();
}

function firstModelStartAfter(run, stepId, startNanos) {
  if (!run || !startNanos) return undefined;
  const start = BigInt(startNanos);
  let first;
  for (const [callId, callStartNanos] of run.modelCallStartedAtNanos) {
    if (callId === stepId || !callStartNanos) continue;
    const callStart = BigInt(callStartNanos);
    if (callStart <= start) continue;
    if (first === undefined || callStart < first) first = callStart;
  }
  return first?.toString();
}

// ---------------------------------------------------------------------------
// Safe JSON serialization
// ---------------------------------------------------------------------------

function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, function (_key, value) {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    if (typeof value === "function") return undefined;
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}

function safeJsonClone(value) {
  const serialized = safeStringify(value);
  return serialized === undefined ? undefined : JSON.parse(serialized);
}

function truncate(str, max) {
  if (typeof str !== "string") return str;
  return str.length > max ? str.slice(0, max) + "...[truncated]" : str;
}

function truncateContent(val) {
  if (typeof val === "string") return truncate(val, MAX_CONTENT_SIZE);
  if (Array.isArray(val)) {
    return val.map((item) => {
      if (typeof item !== "object" || !item) return item;
      const out = { ...item };
      if (out.parts && Array.isArray(out.parts)) {
        out.parts = out.parts.map((p) => {
          if (typeof p?.content === "string")
            return { ...p, content: truncate(p.content, MAX_CONTENT_SIZE) };
          if (typeof p?.response === "string")
            return { ...p, response: truncate(p.response, MAX_CONTENT_SIZE) };
          return p;
        });
      }
      return out;
    });
  }
  return val;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let pilotConfigCache = { path: null, loadedAt: 0, value: {} };

function loadPilotConfig() {
  const cfgPath = path.join(resolveDataDir(), "config.json");
  const now = Date.now();
  if (
    pilotConfigCache.path === cfgPath
    && now - pilotConfigCache.loadedAt < PILOT_CONFIG_CACHE_TTL_MS
  ) {
    return pilotConfigCache.value;
  }

  let value = {};
  try {
    const raw = fs.readFileSync(cfgPath, "utf-8");
    value = JSON.parse(raw);
  } catch {}
  pilotConfigCache = { path: cfgPath, loadedAt: now, value };
  return value;
}

function resolveUserId(cfg) {
  return (
    process.env.LOONGSUITE_USER_ID ||
    process.env.LOONGSUITE_PILOT_USER_ID ||
    cfg.userId ||
    cfg["user.id"] ||
    os.hostname() ||
    "unknown"
  );
}

function isExplicitlyFalse(value) {
  return value === false || (typeof value === "string" && value.trim().toLowerCase() === "false");
}

let openClawPluginConfig = {};

function shouldCaptureContent(pilotConfig) {
  return !isExplicitlyFalse(openClawPluginConfig?.captureMessageContent)
    && !isExplicitlyFalse(pilotConfig?.agents?.openclaw?.captureMessageContent);
}

// Working directory of the OpenClaw instance, captured once at register().
// Emitted as agent.openclaw.cwd so the pilot pipeline can enrich git context.
let agentCwd;

// ---------------------------------------------------------------------------
// JSONL writer
// ---------------------------------------------------------------------------

let _logDirReady = false;
let _debugFailureReported = false;
const _securedFiles = new Set();

function debugFailureOnce(source, err) {
  const enabled = String(process.env.LOONGSUITE_PILOT_DEBUG || "").trim().toLowerCase();
  if (enabled !== "1" && enabled !== "true") return;
  if (_debugFailureReported) return;
  _debugFailureReported = true;
  try {
    console.debug(`[loongsuite-pilot-openclaw] ${source}: ${err?.message || err}`);
  } catch {}
}

function appendPrivateFile(filePath, content) {
  fs.appendFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32" && !_securedFiles.has(filePath)) {
    fs.chmodSync(filePath, 0o600);
    _securedFiles.add(filePath);
  }
}

const CONTENT_RECORD_FIELDS = [
  "gen_ai.input.messages",
  "gen_ai.input.messages_delta",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
  "agent.openclaw.persisted_message",
  "agent.openclaw.message",
  "agent.openclaw.last_assistant_message",
];

function redactRecordContent(record) {
  const redacted = { ...record };
  for (const field of CONTENT_RECORD_FIELDS) delete redacted[field];
  return redacted;
}

function writeRecord(record, captureContent = true) {
  try {
    if (!_logDirReady) {
      ensureDir(logDir());
      _logDirReady = true;
    }
    const filePath = path.join(logDir(), `openclaw-${todayStamp()}.jsonl`);
    const persistedRecord = captureContent ? record : redactRecordContent(record);
    appendPrivateFile(filePath, safeStringify(persistedRecord) + "\n");
  } catch (err) {
    writeError("writeRecord", err);
  }
}

function writeError(source, err) {
  try {
    ensureDir(logDir());
    const errPath = path.join(logDir(), `openclaw-error-${todayStamp()}.log`);
    appendPrivateFile(
      errPath,
      `${new Date().toISOString()} [${source}] ${err?.stack || err}\n`
    );
  } catch (writeErr) {
    debugFailureOnce(`failed to persist ${source} error`, writeErr);
  }
}

// ---------------------------------------------------------------------------
// Run + session state (LRU-bounded Maps)
// ---------------------------------------------------------------------------

const runs = new Map();
const sessions = new Map();
const sessionRunIds = new Map();

function setBounded(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > MAX_RUN_STATE_ENTRIES) {
    map.delete(map.keys().next().value);
  }
}

function addBounded(set, value) {
  if (set.has(value)) return;
  set.add(value);
  while (set.size > MAX_RUN_STATE_ENTRIES) {
    set.delete(set.values().next().value);
  }
}

function pushBounded(list, value) {
  list.push(value);
  if (list.length > MAX_RUN_STATE_ENTRIES) {
    list.splice(0, list.length - MAX_RUN_STATE_ENTRIES);
  }
}

function bindSessionRun(sessionKey, runId) {
  if (!sessionKey || !runId) return;
  sessionRunIds.delete(sessionKey);
  sessionRunIds.set(sessionKey, runId);
  if (sessionRunIds.size > MAX_SESSIONS) {
    sessionRunIds.delete(sessionRunIds.keys().next().value);
  }
}

function getRun(runId, event, ctx) {
  if (!runId) return null;
  let r = runs.get(runId);
  if (!r) {
    r = {
      runId,
      traceId: generateTraceId(),
      callSeq: 0,
      currentStepCallId: null,
      lastCallId: null,
      nativeCallIds: new Map(),
      llmInputStash: null,
      llmInputPending: false,
      completed: false,
      sessionId: null,
      provider: null,
      model: null,
      userPromptText: null,
      systemPrompt: null,
      modelCallEnds: new Map(),
      modelCallStartedAtNanos: new Map(),
      assistantResponseCallIds: new Set(),
      toolStepCallIds: new Map(),
      toolStartedAtNanos: new Map(),
      pendingToolInputMessages: [],
      persistedToolCallIds: new Set(),
      perCallUsage: new Map(),
    };
  } else {
    // Refresh insertion order so the bounded Map behaves as an actual LRU.
    runs.delete(runId);
  }
  runs.set(runId, r);
  const sessionKey = event?.sessionKey || ctx?.sessionKey || r.sessionKey;
  if (sessionKey && !r.completed) {
    r.sessionKey = sessionKey;
    bindSessionRun(sessionKey, runId);
  }
  if (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    runs.delete(oldest);
    for (const [key, value] of sessionRunIds) {
      if (value === oldest) sessionRunIds.delete(key);
    }
  }
  return r;
}

function resolveContextRun(event, ctx) {
  const directRunId = event?.runId || ctx?.runId;
  if (directRunId) return getRun(directRunId, event, ctx);

  const sessionKey = event?.sessionKey || ctx?.sessionKey;
  const sessionRunId = sessionKey ? sessionRunIds.get(sessionKey) : null;
  if (sessionRunId) return getRun(sessionRunId, event, ctx);
  return null;
}

function completeRun(run) {
  if (!run) return;
  run.completed = true;
  if (run.sessionKey && sessionRunIds.get(run.sessionKey) === run.runId) {
    sessionRunIds.delete(run.sessionKey);
  }
  resetCompletedRunState(run);
}

function resetCompletedRunState(run) {
  // Keep only the identity needed when OpenClaw v2026.6.10 reuses a runId for
  // a provider fallback. traceId and callSeq deliberately survive so fallback
  // calls remain in one trace and plugin-generated step IDs stay unique.
  run.currentStepCallId = null;
  run.lastCallId = null;
  run.nativeCallIds.clear();
  run.llmInputStash = null;
  run.llmInputPending = false;
  run.userPromptText = null;
  run.systemPrompt = null;
  run.modelCallEnds.clear();
  run.modelCallStartedAtNanos.clear();
  run.assistantResponseCallIds.clear();
  run.toolStepCallIds.clear();
  run.toolStartedAtNanos.clear();
  run.pendingToolInputMessages.length = 0;
  run.persistedToolCallIds.clear();
  run.perCallUsage.clear();
}

function reactivateRun(run, event, ctx) {
  if (!run?.completed) return;
  run.completed = false;
  const sessionKey = event?.sessionKey || ctx?.sessionKey || run.sessionKey;
  if (sessionKey) {
    run.sessionKey = sessionKey;
    bindSessionRun(sessionKey, run.runId);
  }
}

function getSession(sessionId) {
  if (!sessionId) return null;
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      sessionId,
      traceId: generateTraceId(),
      resumedFrom: null,
      sessionKey: null,
    };
  } else {
    sessions.delete(sessionId);
  }
  sessions.set(sessionId, s);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    const evicted = sessions.get(oldest);
    sessions.delete(oldest);
    if (evicted?.sessionKey) sessionRunIds.delete(evicted.sessionKey);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Record builder
// ---------------------------------------------------------------------------

function buildCommonFields(run, sessionId, userId) {
  const base = {
    time_unix_nano: nowNanos(),
    observed_time_unix_nano: nowNanos(),
    "event.id": crypto.randomUUID(),
    "gen_ai.agent.type": AGENT_TYPE,
    "gen_ai.agent.name": AGENT_TYPE,
    "user.id": userId,
    ...(agentCwd ? { "agent.openclaw.cwd": agentCwd } : {}),
    ...SPAN_ATTRIBUTES,
  };
  if (run) {
    base.trace_id = run.traceId;
    base["gen_ai.turn.id"] = run.runId;
    base["gen_ai.session.id"] = run.sessionId || sessionId || "";
    if (run.provider) base["gen_ai.provider.name"] = run.provider;
    if (run.model) base["gen_ai.request.model"] = run.model;
  } else if (sessionId) {
    const s = getSession(sessionId);
    base.trace_id = s.traceId;
    base["gen_ai.session.id"] = sessionId;
    if (s.sessionKey) base["agent.openclaw.session_key"] = s.sessionKey;
  }
  return base;
}

function inferProviderName(provider, model) {
  if (provider) return provider;
  const m = String(model || "").toLowerCase();
  if (/claude|anthropic/.test(m)) return "anthropic";
  if (/gpt|openai|codex/.test(m)) return "openai";
  if (/qwen|tongyi/.test(m)) return "qwen";
  if (/deepseek/.test(m)) return "deepseek";
  if (/gemini/.test(m)) return "gcp.gemini";
  if (/grok|xai/.test(m)) return "x_ai";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Message format helpers (ARMS nested parts structure)
// ---------------------------------------------------------------------------

function buildUserInputMessages(systemPrompt, userPromptText) {
  const messages = [];
  if (systemPrompt) {
    messages.push({
      role: "system",
      parts: [{ type: "text", content: truncate(systemPrompt, MAX_CONTENT_SIZE) }],
    });
  }
  if (userPromptText) {
    messages.push({
      role: "user",
      parts: [{ type: "text", content: truncate(userPromptText, MAX_CONTENT_SIZE) }],
    });
  }
  return messages.length > 0 ? messages : undefined;
}

function buildToolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t?.name,
    description: t?.description ? truncate(t.description, MAX_CONTENT_SIZE) : undefined,
    parameters: t?.input_schema ?? t?.parameters ?? t?.schema,
  }));
}

function finiteTokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeUsage(rawUsage) {
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  const input = finiteTokenCount(usage.input);
  const output = finiteTokenCount(usage.output);
  const cacheRead = finiteTokenCount(usage.cacheRead);
  const cacheWrite = finiteTokenCount(usage.cacheWrite);
  // Some newer runtimes expose this extra field even though it is not part of
  // the minimum-version hook contract. Keep it strictly best-effort.
  const reasoning = finiteTokenCount(usage.reasoningTokens);
  const missing = input === undefined && output === undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total: missing ? undefined : (input ?? 0) + (output ?? 0),
    missing,
  };
}

function mapStopReason(stopReason, outputMessages) {
  switch (stopReason) {
    case "toolUse": return "tool_calls";
    case "length": return "length";
    case "error": return "error";
    case "aborted": return "cancelled";
    case "stop": return "stop";
    default: {
      const hasToolCall = outputMessages?.some((message) =>
        message?.parts?.some((part) => part?.type === "tool_call"));
      return hasToolCall ? "tool_calls" : "stop";
    }
  }
}

function addFinishReason(outputMessages, finishReason) {
  if (!Array.isArray(outputMessages)) return outputMessages;
  return outputMessages.map((message) => ({
    ...message,
    finish_reason: finishReason,
  }));
}

function buildToolResultInputMessage(event) {
  const message = event?.message;
  if (!message || typeof message !== "object") return undefined;
  const toolCallId = message.toolCallId || event?.toolCallId;
  if (!toolCallId) return undefined;

  const content = Array.isArray(message.content) ? message.content : [];
  const textParts = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
  let response;
  if (textParts.length > 0) {
    response = truncate(textParts.join("\n"), MAX_TOOL_RESULT_SIZE);
  } else if (content.length > 0) {
    response = truncate(safeStringify(content), MAX_TOOL_RESULT_SIZE);
  } else if (message.details !== undefined) {
    response = truncate(safeStringify(message.details), MAX_TOOL_RESULT_SIZE);
  } else {
    response = "";
  }

  return {
    role: "tool",
    parts: [{
      type: "tool_call_response",
      id: toolCallId,
      response,
    }],
  };
}

function rememberCallUsage(run, callId, usage) {
  if (!run || !callId || usage.missing || run.perCallUsage.has(callId)) return;
  setBounded(run.perCallUsage, callId, usage);
}

function sumCallUsage(run) {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  for (const usage of run.perCallUsage.values()) {
    sum.input += usage.input ?? 0;
    sum.output += usage.output ?? 0;
    sum.cacheRead += usage.cacheRead ?? 0;
    sum.cacheWrite += usage.cacheWrite ?? 0;
    sum.reasoning += usage.reasoning ?? 0;
    sum.total += usage.total ?? 0;
  }
  return sum;
}

function usageMismatch(aggregate, summed, observedCalls) {
  if (aggregate.missing || observedCalls === 0) return undefined;
  return (
    (aggregate.input ?? 0) !== summed.input
    || (aggregate.output ?? 0) !== summed.output
    || (aggregate.cacheRead ?? 0) !== summed.cacheRead
    || (aggregate.cacheWrite ?? 0) !== summed.cacheWrite
    || (aggregate.reasoning ?? 0) !== summed.reasoning
  ) || undefined;
}

function emitUnmatchedModelResponse(run, callId, userId, emit) {
  const ended = run?.modelCallEnds?.get(callId);
  if (!ended || run.assistantResponseCallIds.has(callId)) return;
  run.modelCallEnds.delete(callId);
  const failed = ended.outcome === "error";
  const record = {
    ...buildCommonFields(run, run.sessionId, userId),
    "event.name": "llm.response",
    "gen_ai.step.id": callId,
    "gen_ai.response.id": callId,
    "gen_ai.provider.name": inferProviderName(ended.provider || run.provider, ended.model || run.model),
    "gen_ai.request.model": ended.model || run.model,
    "gen_ai.response.model": ended.model || run.model,
    "gen_ai.response.finish_reasons": failed ? ["error"] : undefined,
    "error.type": failed ? "model_call_error" : undefined,
    "error.message": failed ? ended.error : undefined,
    "agent.openclaw.hook": "model_call_ended",
    "agent.openclaw.call_id": ended.callId || callId,
    "agent.openclaw.duration_ms": ended.durationMs,
    "agent.openclaw.outcome": ended.outcome,
    "agent.openclaw.error_category": ended.errorCategory,
    "agent.openclaw.failure_kind": ended.failureKind,
    "agent.openclaw.request_payload_bytes": ended.requestPayloadBytes,
    "agent.openclaw.response_stream_bytes": ended.responseStreamBytes,
    "agent.openclaw.time_to_first_byte_ms": ended.timeToFirstByteMs,
    "agent.openclaw.api": ended.api,
    "agent.openclaw.transport": ended.transport,
    "gen_ai.usage.context_token_budget": ended.contextTokenBudget,
    "agent.openclaw.context_window_source": ended.contextWindowSource,
  };
  emit(record);
  addBounded(run.assistantResponseCallIds, callId);
}

function flushUnmatchedModelResponses(run, userId, emit, exceptCallId) {
  for (const callId of [...run.modelCallEnds.keys()]) {
    if (callId !== exceptCallId) emitUnmatchedModelResponse(run, callId, userId, emit);
  }
}

// ---------------------------------------------------------------------------
// Event handlers (16 hooks)
// ---------------------------------------------------------------------------

function handleSessionStart(event, ctx, userId, emit) {
  const sessionId = event?.sessionId || ctx?.sessionId;
  if (!sessionId) return;
  const s = getSession(sessionId);
  s.sessionKey = event?.sessionKey || ctx?.sessionKey || s.sessionKey;
  s.resumedFrom = event?.resumedFrom || null;
  const record = {
    ...buildCommonFields(null, sessionId, userId),
    "event.name": "other",
    "agent.openclaw.hook": "session_start",
    "agent.openclaw.resumed_from": s.resumedFrom,
  };
  emit(record);
}

function handleSessionEnd(event, ctx, userId, emit) {
  const sessionId = event?.sessionId || ctx?.sessionId;
  if (!sessionId) return;
  const s = getSession(sessionId);
  const record = {
    ...buildCommonFields(null, sessionId, userId),
    "event.name": "other",
    "agent.openclaw.hook": "session_end",
    "agent.openclaw.session_end_reason": event?.reason || undefined,
  };
  emit(record);
  sessions.delete(sessionId);
  if (s.sessionKey) sessionRunIds.delete(s.sessionKey);
}

function handleBeforeModelResolve(event, ctx, userId, emit) {
  const runId = ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  const record = {
    ...buildCommonFields(run, ctx?.sessionId, userId),
    "event.name": "other",
    "agent.openclaw.hook": "before_model_resolve",
    "gen_ai.input.messages_delta": event?.prompt
      ? [{ role: "user", parts: [{ type: "text", content: truncate(event.prompt, MAX_CONTENT_SIZE) }] }]
      : undefined,
  };
  emit(record);
}

function handleBeforePromptBuild(event, ctx, userId) {
  const runId = ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  if (event?.prompt) run.userPromptText = event.prompt;
  // No emission — redundant with before_agent_run which has richer fields.
}

function handleBeforeAgentRun(event, ctx, userId, emit) {
  const runId = ctx?.runId || event?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  if (event?.prompt) run.userPromptText = event.prompt;
  if (event?.systemPrompt) run.systemPrompt = event.systemPrompt;
  if (ctx?.sessionId) run.sessionId = ctx.sessionId;
  if (ctx?.sessionKey) run.sessionKey = ctx.sessionKey;

  const record = {
    ...buildCommonFields(run, ctx?.sessionId, userId),
    "event.name": "other",
    "agent.openclaw.hook": "before_agent_run",
    "gen_ai.input.messages_delta": run.userPromptText
      ? [{ role: "user", parts: [{ type: "text", content: truncate(run.userPromptText, MAX_CONTENT_SIZE) }] }]
      : undefined,
    "gen_ai.system_instructions": run.systemPrompt
      ? truncate(run.systemPrompt, MAX_CONTENT_SIZE)
      : undefined,
  };
  emit(record);
}

function handleBeforeAgentReply(event, ctx, userId, emit) {
  const runId = ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  const record = {
    ...buildCommonFields(run, ctx?.sessionId, userId),
    "event.name": "other",
    "agent.openclaw.hook": "before_agent_reply",
  };
  emit(record);
}

function handleLlmInput(event, ctx, userId) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  // OpenClaw v2026.6.10 can reuse a runId for a provider fallback after the
  // first agent cycle has already emitted llm_output. A fresh llm_input is the
  // unambiguous start of that next cycle; late terminal hooks must not revive
  // completed state on their own.
  reactivateRun(run, event, ctx);
  if (ctx?.sessionId) run.sessionId = run.sessionId || ctx.sessionId;
  const sessionKey = event?.sessionKey || ctx?.sessionKey;
  if (sessionKey) {
    run.sessionKey = sessionKey;
    bindSessionRun(sessionKey, runId);
  }
  run.llmInputStash = {
    systemPrompt: event.systemPrompt,
    tools: event.tools,
    prompt: event.prompt,
    imagesCount: event.imagesCount,
  };
  run.llmInputPending = true;
  if (event?.provider) run.provider = event.provider;
  if (event?.model) run.model = event.model;
  // Emission deferred to first model_call_started (llm.request) so the
  // LLM span's input messages land on the right step.id.
}

function handleModelCallStarted(event, ctx, userId, emit) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  // A supported OpenClaw runtime writes the assistant message immediately
  // after model_call_ended. If the next call starts first, close the unmatched
  // previous call explicitly so retries/errors do not become orphan requests.
  flushUnmatchedModelResponses(run, userId, emit);
  const callId = `${runId}:model:${++run.callSeq}`;
  if (event?.callId) setBounded(run.nativeCallIds, event.callId, callId);
  run.currentStepCallId = callId;
  run.lastCallId = callId;
  if (event?.provider) run.provider = event.provider;
  if (event?.model) run.model = event.model;
  if (event?.sessionId) run.sessionId = run.sessionId || event.sessionId;
  if (event?.sessionKey) run.sessionKey = run.sessionKey || event.sessionKey;

  const common = buildCommonFields(run, run.sessionId, userId);
  setBounded(run.modelCallStartedAtNanos, callId, common.time_unix_nano);

  const startsAgentCycle = run.llmInputPending;
  run.llmInputPending = false;
  const stash = run.llmInputStash;
  const inputMessages = startsAgentCycle && stash
    ? buildUserInputMessages(stash.systemPrompt, stash.prompt)
    : undefined;
  const inputDelta = startsAgentCycle && stash?.prompt
    ? [{ role: "user", parts: [{ type: "text", content: truncate(stash.prompt, MAX_CONTENT_SIZE) }] }]
    : (run.pendingToolInputMessages.length > 0
        ? run.pendingToolInputMessages.splice(0)
        : undefined);
  const systemInstructions = startsAgentCycle && stash?.systemPrompt
    ? truncate(stash.systemPrompt, MAX_CONTENT_SIZE)
    : undefined;
  const toolDefinitions = startsAgentCycle ? buildToolDefinitions(stash?.tools) : undefined;
  if (startsAgentCycle) run.llmInputStash = null;

  const record = {
    ...common,
    "event.name": "llm.request",
    "gen_ai.step.id": callId,
    "gen_ai.response.id": callId,
    "gen_ai.provider.name": inferProviderName(event?.provider || run.provider, event?.model || run.model),
    "gen_ai.request.model": event?.model || run.model,
    "gen_ai.response.model": event?.model || run.model,
    "gen_ai.input.messages": truncateContent(inputMessages),
    "gen_ai.input.messages_delta": inputDelta,
    "gen_ai.system_instructions": systemInstructions,
    "gen_ai.tool.definitions": truncateContent(toolDefinitions),
    "agent.openclaw.hook": "model_call_started",
    "agent.openclaw.call_id": event?.callId,
    "agent.openclaw.api": event?.api,
    "agent.openclaw.transport": event?.transport,
    "gen_ai.usage.context_token_budget": event?.contextTokenBudget,
    "agent.openclaw.context_window_source": event?.contextWindowSource,
  };
  emit(record);
}

function handleModelCallEnded(event, ctx, userId, emit) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  const callId = (event?.callId && run.nativeCallIds.get(event.callId))
    || run.currentStepCallId;
  if (callId) run.lastCallId = callId;
  if (callId) {
    // Per-call usage, output and stopReason arrive on the following
    // before_message_write AssistantMessage. Stash end metadata and emit one
    // canonical llm.response there instead of producing split response records.
    setBounded(run.modelCallEnds, callId, { ...event });
  }
}

function handleLlmOutput(event, ctx, userId, emit) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  if (event?.sessionId) run.sessionId = run.sessionId || event.sessionId;
  if (event?.provider) run.provider = event.provider;
  if (event?.model) run.model = event.model;

  flushUnmatchedModelResponses(run, userId, emit);

  // llm_output is a run-level aggregate in OpenClaw, not a single model call.
  // Keep it as the explicit flush boundary and diagnostic checksum only. The
  // canonical per-call tokens/output/finish reason are emitted exactly once by
  // before_message_write, avoiding both final-span inflation and AGENT double
  // counting.
  const aggregate = normalizeUsage(event?.usage);
  const summed = sumCallUsage(run);
  const observedCalls = run.perCallUsage.size;

  const record = {
    ...buildCommonFields(run, run.sessionId, userId),
    "event.name": "other",
    "agent.openclaw.hook": "llm_output",
    "agent.openclaw.aggregate_usage.input_tokens": aggregate.input,
    "agent.openclaw.aggregate_usage.output_tokens": aggregate.output,
    "agent.openclaw.aggregate_usage.cache_read_input_tokens": aggregate.cacheRead,
    "agent.openclaw.aggregate_usage.cache_creation_input_tokens": aggregate.cacheWrite,
    "agent.openclaw.aggregate_usage.reasoning_tokens": aggregate.reasoning,
    "agent.openclaw.aggregate_usage.total_tokens": aggregate.total,
    "agent.openclaw.aggregate_usage.missing": aggregate.missing || undefined,
    "agent.openclaw.per_call_usage.count": observedCalls,
    "agent.openclaw.per_call_usage.mismatch": usageMismatch(aggregate, summed, observedCalls),
    "agent.openclaw.resolved_ref": event?.resolvedRef,
    "agent.openclaw.harness_id": event?.harnessId,
    "gen_ai.usage.context_token_budget": event?.contextTokenBudget,
    "agent.openclaw.context_window_source": event?.contextWindowSource,
  };
  emit(record);
  completeRun(run);
}

function handleBeforeToolCall(event, ctx, userId, emit) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  // Tool belongs to the current ReAct step (= most recent LLM call's callId).
  const stepId = run.currentStepCallId || run.lastCallId;
  const common = buildCommonFields(run, run.sessionId, userId);
  if (event?.toolCallId) {
    if (stepId) setBounded(run.toolStepCallIds, event.toolCallId, stepId);
    setBounded(run.toolStartedAtNanos, event.toolCallId, common.time_unix_nano);
  }
  const record = {
    ...common,
    "event.name": "tool.call",
    "gen_ai.step.id": stepId,
    "gen_ai.tool.name": event?.toolName,
    "gen_ai.tool.call.id": event?.toolCallId,
    "gen_ai.tool.call.exec.id": event?.toolCallId,
    "gen_ai.tool.call.arguments": event?.params
      ? truncateContent(safeJsonClone(event.params))
      : undefined,
    "agent.openclaw.hook": "before_tool_call",
  };
  emit(record);
}

function handleAfterToolCall(event, ctx, userId, emit) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  // Tool execution may finish after OpenClaw has already started the next
  // model call. Keep the result on the step where before_tool_call began so
  // the converter merges arguments, result and duration into one TOOL span.
  const stepId = (event?.toolCallId && run.toolStepCallIds.get(event.toolCallId))
    || run.currentStepCallId
    || run.lastCallId;
  const common = buildCommonFields(run, run.sessionId, userId);
  const startedAtNanos = event?.toolCallId
    ? run.toolStartedAtNanos.get(event.toolCallId)
    : undefined;
  const nativeCompletedAtNanos = completionNanos(startedAtNanos, event?.durationMs);
  const observedAtNanos = common.observed_time_unix_nano;
  const completionExceedsObservation = nativeCompletedAtNanos && observedAtNanos && startedAtNanos
    ? BigInt(observedAtNanos) > BigInt(startedAtNanos)
      && BigInt(nativeCompletedAtNanos) > BigInt(observedAtNanos)
    : false;
  const observedBoundedCompletion = completionExceedsObservation
    ? observedAtNanos
    : nativeCompletedAtNanos;
  const nextModelStartedAtNanos = firstModelStartAfter(run, stepId, startedAtNanos);
  const completionOverlapsNextModel = observedBoundedCompletion && nextModelStartedAtNanos
    ? BigInt(observedBoundedCompletion) > BigInt(nextModelStartedAtNanos)
    : false;
  // OpenClaw's durationMs can include the tail of asynchronous hook dispatch,
  // while the tool result has already been made available to the next model
  // call. Preserve durationMs as native metadata, but keep the event timestamp
  // inside its causal ReAct step so adjacent STEP spans cannot overlap.
  const completedAtNanos = completionOverlapsNextModel
    ? nextModelStartedAtNanos
    : observedBoundedCompletion;
  const result = event?.result;
  const nestedError = result && typeof result === "object" ? result.error : undefined;
  const toolError = event?.error ?? nestedError;
  const isError = event?.error !== undefined || result?.isError === true || nestedError !== undefined;
  const errorMessage = typeof toolError === "string"
    ? toolError
    : (toolError && typeof toolError === "object" && typeof toolError.message === "string"
        ? toolError.message
        : undefined);
  const record = {
    ...common,
    ...(completedAtNanos ? { time_unix_nano: completedAtNanos } : {}),
    "event.name": "tool.result",
    "gen_ai.step.id": stepId,
    "gen_ai.tool.name": event?.toolName,
    "gen_ai.tool.call.id": event?.toolCallId,
    "gen_ai.tool.call.exec.id": event?.toolCallId,
    "gen_ai.tool.call.result": result !== undefined
      ? truncateContent(safeJsonClone(result))
      : undefined,
    "gen_ai.tool.call.duration": event?.durationMs,
    "tool.result.status": isError ? "failure" : "success",
    "error.type": isError ? "tool_use_failure" : undefined,
    "error.message": errorMessage,
    "agent.openclaw.hook": "after_tool_call",
    "agent.openclaw.duration_ms": event?.durationMs,
    "agent.openclaw.duration_clipped_to_observation": completionExceedsObservation || undefined,
    "agent.openclaw.duration_clipped_to_next_model": completionOverlapsNextModel || undefined,
  };
  emit(record);
}

function handleToolResultPersist(event, ctx, userId, emit) {
  const run = resolveContextRun(event, ctx);
  if (!run) return;
  const toolCallId = event?.message?.toolCallId || event?.toolCallId;
  if (toolCallId && !run.persistedToolCallIds.has(toolCallId)) {
    const inputMessage = buildToolResultInputMessage(event);
    if (inputMessage) pushBounded(run.pendingToolInputMessages, inputMessage);
    addBounded(run.persistedToolCallIds, toolCallId);
  }
  const stepId = run
    ? ((toolCallId && run.toolStepCallIds.get(toolCallId)) || run.currentStepCallId || run.lastCallId)
    : undefined;
  const record = {
    ...buildCommonFields(run, ctx?.sessionId, userId),
    "event.name": "other",
    "gen_ai.step.id": stepId,
    "gen_ai.tool.name": event?.toolName,
    "gen_ai.tool.call.id": event?.toolCallId,
    "agent.openclaw.hook": "tool_result_persist",
    "agent.openclaw.persisted_message": event?.message
      ? truncateContent(safeJsonClone(event.message))
      : undefined,
    "agent.openclaw.is_synthetic": event?.isSynthetic,
  };
  emit(record);
}

function buildAssistantOutputMessagesFromOpenClawMessage(message) {
  if (!message || typeof message !== "object") return undefined;
  const parts = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", content: truncate(block.text, MAX_CONTENT_SIZE) });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push({ type: "reasoning", content: truncate(block.thinking, MAX_CONTENT_SIZE) });
    } else if (block.type === "toolCall" || block.type === "tool_use") {
      parts.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        arguments: block.arguments
          ? truncate(safeStringify(block.arguments), MAX_CONTENT_SIZE)
          : (block.partialArgs ? truncate(safeStringify(block.partialArgs), MAX_CONTENT_SIZE) : undefined),
      });
    }
  }
  if (parts.length === 0) return undefined;
  return [{ role: "assistant", parts }];
}

function handleBeforeMessageWrite(event, ctx, userId, emit) {
  const message = event?.message;
  const role = message?.role;

  // AssistantMessage is the supported OpenClaw per-call completion contract:
  // it carries output, stopReason, provider responseId and usage together.
  // Emit exactly one canonical llm.response from it; llm_output is aggregate
  // run metadata and must not be merged into the last model span.
  if (role === "assistant") {
    const run = resolveContextRun(event, ctx);
    if (!run) return;
    const targetCallId = run.lastCallId || run.currentStepCallId;
    if (!targetCallId) return;
    if (run.assistantResponseCallIds.has(targetCallId)) return;
    const rawOutputMessages = buildAssistantOutputMessagesFromOpenClawMessage(message);
    const finishReason = mapStopReason(message.stopReason, rawOutputMessages);
    // OpenClaw legitimately persists empty assistant messages for provider
    // errors, cancellation and silent replies. Treat an empty message as a
    // terminal response only when native completion metadata is present; this
    // preserves usage/timing without fabricating output content.
    const hasTerminalMetadata = typeof message.stopReason === "string"
      || (message.usage && typeof message.usage === "object")
      || typeof message.responseId === "string";
    if (!rawOutputMessages && !hasTerminalMetadata) return;
    const outputMessages = addFinishReason(rawOutputMessages, finishReason);
    const usage = normalizeUsage(message.usage);
    const ended = run.modelCallEnds.get(targetCallId);
    const responseId = message.responseId || targetCallId;
    rememberCallUsage(run, targetCallId, usage);
    run.modelCallEnds.delete(targetCallId);
    addBounded(run.assistantResponseCallIds, targetCallId);
    const stopReason = message.stopReason;
    const record = {
      ...buildCommonFields(run, run.sessionId, userId),
      "event.name": "llm.response",
      "gen_ai.step.id": targetCallId,
      "gen_ai.response.id": responseId,
      "gen_ai.provider.name": inferProviderName(message.provider || run.provider, message.model || run.model),
      "gen_ai.request.model": message.model || run.model,
      "gen_ai.response.model": message.model || run.model,
      "gen_ai.response.finish_reasons": [finishReason],
      "gen_ai.output.messages": truncateContent(outputMessages),
      "gen_ai.usage.input_tokens": usage.input,
      "gen_ai.usage.output_tokens": usage.output,
      "gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
      "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite,
      "gen_ai.usage.reasoning_tokens": usage.reasoning,
      "gen_ai.usage.total_tokens": usage.total,
      // OpenClaw reports timeToFirstByteMs in milliseconds; the GenAI field is nanoseconds.
      "gen_ai.response.time_to_first_token": ended?.timeToFirstByteMs !== undefined
        ? Number(ended.timeToFirstByteMs) * 1_000_000
        : undefined,
      "error.type": finishReason === "error"
        ? "model_call_error"
        : (finishReason === "cancelled" ? "model_call_cancelled" : undefined),
      "error.message": finishReason === "error" || finishReason === "cancelled"
        ? ended?.error
        : undefined,
      "agent.openclaw.hook": "before_message_write",
      "agent.openclaw.message_role": role,
      "agent.openclaw.stop_reason": stopReason,
      "agent.openclaw.response_id": message.responseId,
      "agent.openclaw.call_id": ended?.callId || targetCallId,
      "agent.openclaw.duration_ms": ended?.durationMs,
      "agent.openclaw.outcome": ended?.outcome,
      "agent.openclaw.error_category": ended?.errorCategory,
      "agent.openclaw.failure_kind": ended?.failureKind,
      "agent.openclaw.request_payload_bytes": ended?.requestPayloadBytes,
      "agent.openclaw.response_stream_bytes": ended?.responseStreamBytes,
      "agent.openclaw.time_to_first_byte_ms": ended?.timeToFirstByteMs,
      "agent.openclaw.api": ended?.api || message.api,
      "agent.openclaw.transport": ended?.transport,
      "gen_ai.usage.context_token_budget": ended?.contextTokenBudget,
      "agent.openclaw.context_window_source": ended?.contextWindowSource,
    };
    emit(record);
    return;
  }

  // Non-assistant messages (user / toolResult) are metadata-only at the
  // gen_ai.* level — the converter already discards "other" events without
  // gen_ai.input.messages inside a turn (converter.js:73), and the flusher
  // drops metadata-only ephemeral events to prevent phantom ENTRY+AGENT.
  // Skip writing them so they don't surface as standalone spans.
}

function handleBeforeAgentFinalize(event, ctx, userId, emit) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  const record = {
    ...buildCommonFields(run, run.sessionId, userId),
    "event.name": "other",
    "agent.openclaw.hook": "before_agent_finalize",
    "agent.openclaw.transcript_path": event?.transcriptPath,
    "agent.openclaw.stop_hook_active": event?.stopHookActive,
    "agent.openclaw.last_assistant_message": event?.lastAssistantMessage
      ? truncate(safeStringify(event.lastAssistantMessage), MAX_CONTENT_SIZE)
      : undefined,
    "agent.openclaw.cwd": event?.cwd || agentCwd,
  };
  emit(record);
}

function handleAgentEnd(event, ctx, userId, emit) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  const success = event?.success !== false;
  if (!success) flushUnmatchedModelResponses(run, userId, emit);
  const record = {
    ...buildCommonFields(run, run.sessionId, userId),
    "event.name": "other",
    "agent.openclaw.hook": "agent_end",
    "agent.openclaw.success": success,
    "agent.openclaw.duration_ms": event?.durationMs,
    "error.type": success ? undefined : "_OTHER",
    "error.message": success ? undefined : (event?.error || "agent_end reported failure"),
  };
  emit(record);
  // Run state is bounded by MAX_RUNS LRU eviction — do not explicitly delete
  // here, because llm_output fires AFTER agent_end in --local mode and would
  // recreate the run with a fresh trace_id, splitting the turn's trace.
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

function makeHandler(fn) {
  // Keep this wrapper synchronous: OpenClaw's tool_result_persist and
  // before_message_write hooks reject Promise-returning handlers.
  return function safeHandler(event, ctx) {
    try {
      const cfg = loadPilotConfig();
      const userId = resolveUserId(cfg);
      const emit = (record) => writeRecord(record, shouldCaptureContent(cfg));
      fn(event, ctx, userId, emit);
    } catch (err) {
      writeError(fn.name || "handler", err);
    }
  };
}

export default {
  id: PLUGIN_ID,
  name: "loongsuite-pilot-openclaw",
  description:
    "ARMS GenAI event_t producer: captures 16 OpenClaw plugin hooks and writes JSONL for loongsuite-pilot BaseHookInput.",

  register(api) {
    agentCwd = process.cwd() || undefined;
    openClawPluginConfig = api?.pluginConfig && typeof api.pluginConfig === "object"
      ? api.pluginConfig
      : {};
    try {
      ensureDir(logDir());
      _logDirReady = true;
    } catch (err) {
      _logDirReady = false;
      debugFailureOnce("register", err);
    }

    const on = (name, fn) => {
      if (typeof api?.on === "function") api.on(name, makeHandler(fn));
    };

    // 7 conversation-access hooks (OpenClaw CONVERSATION_HOOK_NAMES)
    on("before_model_resolve", handleBeforeModelResolve);
    on("before_agent_reply", handleBeforeAgentReply);
    on("llm_input", handleLlmInput);
    on("llm_output", handleLlmOutput);
    on("before_agent_finalize", handleBeforeAgentFinalize);
    on("agent_end", handleAgentEnd);
    on("before_agent_run", handleBeforeAgentRun);

    // 9 default-active hooks (prompt / model / tool / session / message write)
    on("before_prompt_build", handleBeforePromptBuild);
    on("model_call_started", handleModelCallStarted);
    on("model_call_ended", handleModelCallEnded);
    on("before_tool_call", handleBeforeToolCall);
    on("after_tool_call", handleAfterToolCall);
    on("tool_result_persist", handleToolResultPersist);
    on("before_message_write", handleBeforeMessageWrite);
    on("session_start", handleSessionStart);
    on("session_end", handleSessionEnd);
  },
};
