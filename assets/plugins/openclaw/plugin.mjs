/**
 * loongsuite-pilot OpenClaw event_t plugin
 *
 * Runs inside the OpenClaw process (Node.js). Modern hosts register lifecycle,
 * conversation and default-active hooks via `api.on(hookName, handler)` and
 * converts OpenClaw hook events into ARMS GenAI event_t JSONL records for
 * consumption by loongsuite-pilot's BaseHookInput pipeline. Hosts before
 * 2026.5.12 use the separate 9-hook legacy-adapter.mjs.
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
 *   ENTRY / AGENT ← before_agent_run → agent_end (runId)
 *   STEP   ← model_call_started / model_call_ended (callId = <runId>:model:<N>)
 *   LLM    ← llm_input / llm_output / model_call_* (callId)
 *   TOOL   ← before_tool_call / after_tool_call / tool_result_persist (toolCallId)
 *   session_start / session_end stay in the private raw log as lifecycle signals
 *   and are filtered by OpenClawPluginInput before the canonical event pipeline.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { appendRawJsonl } from "../shared/raw-jsonl-writer.mjs";
import { pilotConfigPath, readPilotConfig } from "../shared/pilot-config.mjs";
import { createSubagentContexts, stampSubagent } from "./subagent-context.mjs";
import { createCronContexts } from "./cron-context.mjs";
import { createCronRecovery, cronRunEndMs, hasFinishedCronRun } from "./cron-recovery.mjs";
import { invocationId, auditRecord, textMessages, deliveredText } from "./invocation-audit.mjs";
import { MIN_OPENCLAW_VERSION } from "./compatibility.mjs";
import { resolveRuntimeCapabilities } from "./runtime-version.mjs";
import { installSteeredDeliveryObserver } from "./steered-delivery.mjs";
import { createLegacyHandlers } from "./legacy-adapter.mjs";
import { createObservationClock } from "./legacy-utils.mjs";
import {
  evaluateInterceptor,
  resolveDataDir,
  SAME_TURN_POST_TOOL_HOOK,
  SYNC_INTERCEPT_HOOKS,
} from "./interceptor.mjs";
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
} from "../shared/resource-context.mjs";
import { installFirstTokenObserver } from "./first-token.mjs";
import { createRequire } from 'node:module';
// A partial asset update must never make the host fail to import its plugin.
// Missing observability support disables writing until the next asset repair.
let privateLog;
try { privateLog = createRequire(import.meta.url)('../shared/private-log-dir.cjs'); }
catch { privateLog = { ensurePrivateLogDir() {}, appendPrivateFile() {}, writerSuffix: () => '' }; }
const { ensurePrivateLogDir, appendPrivateFile: appendSharedPrivateFile, writerSuffix } = privateLog;
const sharedRootLogs = /^(1|true|yes|on)$/i.test(String(process.env.LOONGSUITE_PILOT_ROOT_TRIGGER || '').trim());

let firstTokenObserver;

const AGENT_TYPE = "openclaw";
const PLUGIN_ID = "loongsuite-pilot-openclaw";
const MAX_RUNS = 200;
const MAX_SESSIONS = 100;
const MAX_RUN_STATE_ENTRIES = 512;
const MAX_CONTENT_SIZE = 64 * 1024;
const MAX_INPUT_MESSAGES = 1024;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_RESULT_SIZE = 64 * 1024;
const PILOT_CONFIG_CACHE_TTL_MS = 5_000;
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, {
  agentId: AGENT_TYPE,
  fieldMap: {
    AGENTTEAMS_WORKER_NAME: "agentteams.worker.name",
  },
});
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};

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
const INVOCATION_USER_ID_FIELD = "agent.pilot.invocation.user.id";
const INVOCATION_IDENTITY_FIELD_MAP = {
  "gen_ai.session.id": "agent.pilot.invocation.session.id",
  "gen_ai.user.id": INVOCATION_USER_ID_FIELD,
};

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
    const invocationIdentityField = INVOCATION_IDENTITY_FIELD_MAP[key];
    if (invocationIdentityField) {
      if (value.length <= SPAN_ATTR_MAX_VALUE_LENGTH) {
        out[invocationIdentityField] = value;
      }
      continue;
    }
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

function logDir() {
  return path.join(resolveDataDir(), "logs", "openclaw");
}

function ensureDir(dir) {
  if (sharedRootLogs) return ensurePrivateLogDir(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
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

function generateSpanId() {
  let id;
  do { id = crypto.randomBytes(8).toString("hex"); } while (/^0+$/.test(id));
  return id;
}

function modelSpanId(run, callId) {
  if (!run.modelSpanIds.has(callId)) setBounded(run.modelSpanIds, callId, generateSpanId());
  return run.modelSpanIds.get(callId);
}

let legacyClock;
function nowNanos() {
  return legacyClock ? legacyClock() : `${Date.now()}000000`;
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
  const cfgPath = pilotConfigPath();
  const now = Date.now();
  if (
    pilotConfigCache.path === cfgPath
    && now - pilotConfigCache.loadedAt < PILOT_CONFIG_CACHE_TTL_MS
  ) {
    return pilotConfigCache.value;
  }

  const value = readPilotConfig(cfgPath);
  pilotConfigCache = { path: cfgPath, loadedAt: now, value };
  return value;
}

function normalizeIdentityValue(value) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 && normalized.length <= SPAN_ATTR_MAX_VALUE_LENGTH
    ? normalized
    : undefined;
}

function resolveSenderId(event, ctx) {
  return normalizeIdentityValue(event?.senderId)
    || normalizeIdentityValue(ctx?.senderId)
    || normalizeIdentityValue(ctx?.channelContext?.sender?.id);
}

function resolveUserIdentity(cfg, senderId) {
  const invocationUserId = normalizeIdentityValue(SPAN_ATTRIBUTES[INVOCATION_USER_ID_FIELD]);
  if (invocationUserId) return { userId: invocationUserId, source: "invocation" };

  const environmentUserId = normalizeIdentityValue(
    process.env.LOONGSUITE_PILOT_USER_ID || process.env.LOONGSUITE_USER_ID,
  );
  if (environmentUserId) return { userId: environmentUserId, source: "environment" };

  const nativeSenderId = normalizeIdentityValue(senderId);
  if (nativeSenderId) return { userId: nativeSenderId, source: "sender" };

  const configuredUserId = normalizeIdentityValue(cfg.userId || cfg["user.id"]);
  if (configuredUserId) return { userId: configuredUserId, source: "config" };

  return {
    userId: normalizeIdentityValue(os.hostname()) || "unknown",
    source: "hostname",
  };
}

function resolveUserId(cfg) {
  return resolveUserIdentity(cfg).userId;
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
  if (sharedRootLogs) return appendSharedPrivateFile(filePath, content);
  fs.appendFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32' && !_securedFiles.has(filePath)) {
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
  "error.message",
];

function redactRecordContent(record) {
  const redacted = { ...record };
  for (const field of CONTENT_RECORD_FIELDS) delete redacted[field];
  return redacted;
}

const childContexts = createSubagentContexts(resolveDataDir, writeError);

function releasePendingChild(run, parent) {
  if (run.pendingChildTimer) clearTimeout(run.pendingChildTimer);
  const pending = run.pendingChildRecords || [];
  run.pendingChildRecords = [];
  run.pendingChildBytes = 0;
  if (parent && !run.childUnlinked) run.parentContext = parent;
  else run.childUnlinked = true;
  for (const record of pending) persistRecord(run.parentContext ? stampSubagent(record, run.parentContext) : {
    ...record,
    ...(run.auditParentContext?.invocationId ? { "gen_ai.agent.parent.invocation.id": run.auditParentContext.invocationId } : {}),
    "agent.openclaw.subagent.collection": "parent_unresolved",
  });
}

function writeRecord(record, captureContent = true) {
  const candidate = runs.get(record["agent.openclaw.run_id"] || record["gen_ai.turn.id"]);
  // A late terminal from an older incarnation must not inherit the identity
  // or parent of a newer run that happens to reuse the same native ID.
  const run = candidate && (candidate.turnId || candidate.runId) === record["gen_ai.turn.id"]
    ? candidate : undefined;
  if (run?.cronExecution && /^\d{1,24}$/.test(String(record.time_unix_nano || ""))) {
    const observed = String(record.time_unix_nano);
    if (!run.lastObservedNanos || BigInt(observed) > BigInt(run.lastObservedNanos)) run.lastObservedNanos = observed;
  }
  const auditParent = run?.auditParentContext || run?.parentContext;
  if (auditParent?.invocationId) record["gen_ai.agent.parent.invocation.id"] = auditParent.invocationId;
  if (auditParent && run.sessionId && auditParent.childSessionId !== run.sessionId) {
    auditParent.childSessionId = run.sessionId;
    childContexts.write(run.runId, auditParent);
  }
  const safeRecord = captureContent ? record : redactRecordContent(record);
  if (run?.parentContext) return persistRecord(stampSubagent(safeRecord, run.parentContext));
  // sessions_spawn may start its child before returning the native runId. Hold
  // that child's early records until the exact tool result supplies the join.
  // Never guess from an active tool, timestamps or task text under concurrency.
  if (isSessionKey(run?.sessionKey) && /:subagent:[^:]+$/.test(run.sessionKey) && !run.childUnlinked) {
    run.pendingChildRecords ||= [];
    run.pendingChildRecords.push(safeRecord);
    run.pendingChildBytes = (run.pendingChildBytes || 0) + Buffer.byteLength(safeStringify(safeRecord));
    if (!run.pendingChildTimer) {
      run.pendingChildTimer = setTimeout(() => releasePendingChild(run), 30_000);
      run.pendingChildTimer.unref?.();
      run.onEvict = () => releasePendingChild(run);
    }
    if (run.pendingChildRecords.length >= 512 || run.pendingChildBytes >= 4 * 1024 * 1024) releasePendingChild(run);
    return;
  }
  return persistRecord(safeRecord);
}

function persistRecord(record) {
  try {
    if (!_logDirReady) {
      ensureDir(logDir());
      _logDirReady = true;
    }
    const filePath = path.join(logDir(), `openclaw-${todayStamp()}${sharedRootLogs ? writerSuffix() : ''}.jsonl`);
    appendRawJsonl(filePath, safeStringify(record) + "\n", undefined, { privateOwner: sharedRootLogs });
    return true;
  } catch (err) {
    writeError("writeRecord", err);
    return false;
  }
}

function writeError(source, err) {
  try {
    ensureDir(logDir());
    const errPath = path.join(logDir(), `openclaw-error-${todayStamp()}${sharedRootLogs ? writerSuffix() : ''}.log`);
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
// Only fixed-session cron jobs with an observed native start are tracked here.
// A provider fallback is another attempt inside the same cron execution.
// Preserve this small bounded state when OpenClaw reloads a plugin in-process.
const cronRegistryKey = Symbol.for("loongsuite-pilot.openclaw.cron-executions");
const cronRegistry = globalThis[cronRegistryKey] ||= new Map();
const cronDataDir = resolveDataDir();
let cronState = cronRegistry.get(cronDataDir);
if (!cronState) {
  cronState = { executions: new Map(), runs: new Map() };
  cronRegistry.set(cronDataDir, cronState);
  if (cronRegistry.size > MAX_SESSIONS) {
    for (const [key, value] of cronRegistry) {
      if (key !== cronDataDir && value.executions.size === 0) cronRegistry.delete(key);
      if (cronRegistry.size <= MAX_SESSIONS) break;
    }
  }
}
const cronExecutions = cronState.executions;
const cronRuns = cronState.runs;
const cronContexts = createCronContexts(resolveDataDir, writeError);

function persistCronContext(run) {
  const execution = run?.cronExecution;
  if (!execution || !run.sessionId || !run.sessionKey) return false;
  const written = cronContexts.write(execution.jobId, {
    runAtMs: execution.runAtMs, sessionKey: run.sessionKey, sessionId: run.sessionId,
    runId: run.runId, turnId: run.turnId, traceId: run.traceId,
    terminalEventId: execution.terminalEventId,
    lastObservedNanos: run.lastObservedNanos,
    userId: run.userId, userIdSource: run.userIdSource, senderId: run.senderId,
    channel: run.channel, accountId: run.accountId, channelId: run.channelId,
  });
  if (written) cronState.recovery?.wake();
  return written;
}

function emitCronFinished(run, execution, userId, emit, incomplete = false, nativeEndMs) {
  let endNanos = nativeEndMs === undefined ? undefined : `${nativeEndMs}000000`;
  let inferred = false;
  // Recovery may run minutes after the real task ended. Never use that
  // observation time as the task's end. If host/hook timestamps disagree,
  // retain the latest actually observed record and mark the inference.
  if (incomplete && run.lastObservedNanos
    && (!endNanos || BigInt(endNanos) < BigInt(run.lastObservedNanos))) {
    endNanos = run.lastObservedNanos;
    inferred = true;
  }
  if (incomplete && !endNanos) return false;
  const written = emit({
    ...buildCommonFields(run, run.sessionId, userId),
    ...(endNanos ? { time_unix_nano: endNanos } : {}),
    "event.id": execution.terminalEventId,
    "event.name": "other",
    "agent.openclaw.hook": "cron_finished",
    "gen_ai.turn.end": true,
    ...(incomplete ? { "agent.openclaw.collection.incomplete": true,
      "agent.openclaw.collection.end_reason": "missing_cron_finished" } : {}),
    ...(inferred ? { "agent.openclaw.timing.inferred": true,
      "agent.openclaw.timing.source": "last_observed_cron_hook" } : {}),
    ...(execution.ambiguous ? { "agent.openclaw.correlation.ambiguous": true } : {}),
  });
  if (written !== false) cronContexts.remove(execution.jobId, execution.runAtMs);
  return written !== false;
}

function recoverCronFinished(snapshot, userId, emit, incomplete = false, nativeEndMs) {
  const execution = { jobId: snapshot.jobId, runAtMs: snapshot.runAtMs,
    terminalEventId: snapshot.terminalEventId };
  const run = { ...snapshot, cronExecution: execution, telemetrySessionKey: snapshot.sessionKey };
  return emitCronFinished(run, execution, userId, emit, incomplete, nativeEndMs);
}

function closeCronExecution(execution, userId, emit, incomplete = false, nativeEndMs) {
  const run = execution.run;
  if (run) {
    if (!run.completed) {
      // A blocked, cancelled, or failed job may finish without llm_output.
      flushUnmatchedModelResponses(run, userId, emit);
      completeRun(run);
    }
    // Keep ownership and the durable context if the terminal write fails so
    // another native event or reconciliation can retry it.
    if (!emitCronFinished(run, execution, userId, emit, incomplete, nativeEndMs)) return false;
    if (cronRuns.get(run.runId) === execution) cronRuns.delete(run.runId);
  }
  if (cronExecutions.get(execution.jobId) === execution) cronExecutions.delete(execution.jobId);
  return true;
}

function recoverStoredCron(snapshot, job, userId, emit) {
  // A normal finish, newer execution or another recovery may have changed
  // ownership while the asynchronous scheduler query was in flight.
  const current = cronContexts.read(snapshot.jobId);
  if (!current || current.runAtMs !== snapshot.runAtMs
    || current.terminalEventId !== snapshot.terminalEventId) return true;
  const execution = cronExecutions.get(snapshot.jobId);
  const nativeEndMs = cronRunEndMs(snapshot.runAtMs, job?.state?.lastDurationMs);
  if (execution?.runAtMs === snapshot.runAtMs && execution.run) {
    return closeCronExecution(execution, userId, emit, true, nativeEndMs);
  }
  if (!recoverCronFinished(snapshot, userId, emit, true, nativeEndMs)) return false;
  if (execution?.runAtMs === snapshot.runAtMs) cronExecutions.delete(snapshot.jobId);
  return true;
}

function configureCronRecovery(ctx, userId, emit) {
  if (typeof ctx?.getCron !== "function") return;
  cronState.recovery ??= createCronRecovery(cronContexts, debugFailureOnce);
  cronState.recovery.configure(ctx.getCron, (snapshot, job) => recoverStoredCron(snapshot, job, userId, emit));
  cronState.recovery.wake();
}

function handleCronGatewayStart(_event, ctx, userId, emit) {
  configureCronRecovery(ctx, userId, emit);
}

function handleCronGatewayStop() {
  cronState.recovery?.stop();
}

function handleCronChanged(event, ctx, userId, emit) {
  configureCronRecovery(ctx, userId, emit);
  const jobId = event?.jobId;
  const runAtMs = event?.runAtMs;
  if (typeof jobId !== "string" || !jobId || jobId.length > 1024) return;
  // One-shot jobs may be removed immediately after completion, before a
  // later scheduler scan can find them. The removal snapshot is usable only
  // when it proves this exact run has already completed.
  if (event.action === "removed") {
    const saved = cronContexts.read(jobId);
    if (saved && hasFinishedCronRun(event.job, saved)) recoverStoredCron(saved, event.job, userId, emit);
    return;
  }
  if (typeof runAtMs !== "number" || !Number.isFinite(runAtMs)) return;
  if (event.action === "started") {
    const target = event.sessionTarget;
    if (typeof target !== "string" || !target.startsWith("session:")
      || !isSessionKey(target.slice("session:".length))) return;
    const previous = cronExecutions.get(jobId);
    if (previous?.runAtMs === runAtMs) return;
    if (previous) {
      const state = event.job?.state;
      // A newer scheduler start can recover a missed finish only when the
      // host's job snapshot identifies the earlier run as completed. A mere
      // llm_output or a different timestamp is not proof: fallback and
      // overlapping work must not be split by a guessed boundary.
      if (!(runAtMs > previous.runAtMs && state?.runningAtMs === runAtMs
        && hasFinishedCronRun({ id: jobId, state }, previous))) {
        previous.ambiguous = true;
        return;
      }
      if (!closeCronExecution(previous, userId, emit, true,
        cronRunEndMs(previous.runAtMs, state.lastDurationMs))) return;
    }
    if (cronExecutions.size >= MAX_RUNS) return;
    const saved = cronContexts.read(jobId);
    if (saved && saved.runAtMs !== runAtMs) {
      const state = event.job?.state;
      if (!(runAtMs > saved.runAtMs && state?.runningAtMs === runAtMs
        && hasFinishedCronRun({ id: jobId, state }, saved))) return;
      if (!recoverCronFinished(saved, userId, emit, true,
        cronRunEndMs(saved.runAtMs, state.lastDurationMs))) return;
    }
    cronExecutions.set(jobId, { jobId, runAtMs, sessionKey: target.slice("session:".length),
      terminalEventId: crypto.randomUUID(), run: null });
    return;
  }
  if (event.action !== "finished") return;
  const execution = cronExecutions.get(jobId);
  if (!execution) {
    const saved = cronContexts.read(jobId);
    if (saved?.runAtMs === runAtMs) recoverCronFinished(saved, userId, emit, false,
      cronRunEndMs(runAtMs, event.durationMs ?? event.job?.state?.lastDurationMs));
    return;
  }
  if (execution.runAtMs !== runAtMs) return;
  closeCronExecution(execution, userId, emit, false,
    cronRunEndMs(runAtMs, event.durationMs ?? event.job?.state?.lastDurationMs));
}

function observedCronExecution(runId, ctx) {
  const execution = cronExecutions.get(ctx?.jobId);
  if (!execution || execution.ambiguous || execution.disabled || ctx?.trigger !== "cron"
    || !ctx?.sessionId || runId !== ctx.sessionId
    || ctx?.sessionKey !== execution.sessionKey) return null;
  return execution;
}

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

// Keep this validator aligned with normalization/openclaw-session-key.ts.
function isSessionKey(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function observeSessionKey(run, event, ctx) {
  // Separate telemetry identity from the existing native hook-routing cache.
  // A conflicting key must not silently relabel this run or its exported spans.
  for (const value of [event?.sessionKey, ctx?.sessionKey]) {
    if (value == null || value === "") continue;
    if (!isSessionKey(value) || (run.telemetrySessionKey && run.telemetrySessionKey !== value)) {
      run.sessionKeyAmbiguous = true;
    } else {
      run.telemetrySessionKey = value;
    }
  }
}

function getRun(runId, event, ctx) {
  if (!runId) return null;
  let r = runs.get(runId);
  const cronExecution = observedCronExecution(runId, ctx)
    || (!r ? cronRuns.get(runId) : null);
  if (cronExecution?.run && (!r || r.cronExecution === cronExecution)) {
    // Keep an observed execution stable if its tombstone left the LRU before
    // a fallback attempt arrived; the job remains the ownership boundary.
    r = cronExecution.run;
  } else if (cronExecution && r?.completed && r.cronExecution !== cronExecution) {
    r.onEvict?.();
    runs.delete(runId);
    r = undefined;
  }
  if (!r) {
    // A scheduler-owned fixed-session execution is independent work. An old
    // delegated child context keyed only by its reused native ID is not proof
    // that this newly started cron invocation belongs to the former parent.
    const savedParent = cronExecution ? undefined : childContexts.read(runId);
    r = {
      runId,
      ...(cronExecution ? { turnId: crypto.randomUUID(), cronExecution } : {}),
      traceId: generateTraceId(),
      parentContext: savedParent?.auditOnly ? undefined : savedParent,
      auditParentContext: savedParent,
      callSeq: 0,
      currentStepCallId: null,
      lastCallId: null,
      nativeCallIds: new Map(),
      modelSpanIds: new Map(),
      pendingToolInvocations: [],
      llmInputStash: null,
      llmInputPending: false,
      cycleInputSnapshot: null,
      completed: false,
      sessionId: null,
      provider: null,
      model: null,
      userPromptText: null,
      systemPrompt: null,
      modelCallEnds: new Map(),
      pendingAssistantResponses: new Map(),
      modelCallStartedAtNanos: new Map(),
      assistantResponseCallIds: new Set(),
      toolStepCallIds: new Map(),
      pendingToolInputMessages: [],
      persistedToolCallIds: new Set(),
      perCallUsage: new Map(),
      delegatedToolCallIds: new Set(),
    };
    if (cronExecution) {
      r.sessionId = ctx.sessionId;
      r.sessionKey = ctx.sessionKey;
      if (persistCronContext(r)) {
        cronExecution.run = r;
        cronRuns.set(runId, cronExecution);
      } else {
        // Without a durable ownership record a Gateway crash could leave the
        // collector waiting forever. Preserve the old fail-open behavior.
        cronExecution.disabled = true;
        delete r.cronExecution;
        delete r.turnId;
      }
    }
  } else {
    // Refresh insertion order so the bounded Map behaves as an actual LRU.
    runs.delete(runId);
  }
  runs.set(runId, r);
  const receiverSession = event?.sessionId || ctx?.sessionId || r.sessionId;
  if (!r.announcedWork && receiverSession && runId.startsWith('announce:v1:')
    && (r.announcementCheckedAt === undefined || Date.now() - r.announcementCheckedAt >= 25)) {
    r.announcementCheckedAt = Date.now();
    const candidates = childContexts.list().filter(work => work.invocationId
      && work.sessionId === receiverSession
      && runId === `announce:v1:${work.childSessionKey}:${work.runId}`);
    if (candidates.length === 1) {
      r.announcedWork = candidates[0];
      // A descendant announcement can replace its waiting coordinator's
      // native run id. Its exact submitting parent run is already persisted;
      // follow that causal edge, never the latest work in the same session.
      const incoming = candidates[0].parentRunId && childContexts.read(candidates[0].parentRunId);
      if (!r.auditParentContext && incoming?.invocationId && incoming.childSessionId === receiverSession) {
        r.auditParentContext = { ...incoming, runId };
        if (!incoming.auditOnly && !r.childUnlinked) r.parentContext = r.auditParentContext;
        childContexts.write(runId, r.auditParentContext);
      }
    }
  }
  observeSessionKey(r, event, ctx);
  const sessionKey = event?.sessionKey || ctx?.sessionKey || r.sessionKey;
  if (sessionKey && !r.completed) {
    r.sessionKey = sessionKey;
    bindSessionRun(sessionKey, runId);
  }
  if (runs.size > MAX_RUNS) {
    // Completed tombstones must not evict a long-running active turn.
    const oldest = [...runs].find(([, run]) => run.completed)?.[0] ?? runs.keys().next().value;
    const evicted = runs.get(oldest);
    flushUnmatchedModelResponses(evicted, resolveUserId(loadPilotConfig()), emitRecord);
    runs.delete(oldest);
    for (const [key, value] of sessionRunIds) {
      if (value === oldest) sessionRunIds.delete(key);
    }
    evicted?.onEvict?.();
  }
  return r;
}

function updateRunUserIdentity(run, event, ctx, cfg) {
  if (!run) return;
  const senderId = resolveSenderId(event, ctx) || run.senderId;

  const identity = resolveUserIdentity(cfg, senderId);
  run.userId = identity.userId;
  run.userIdSource = identity.source;
  if (senderId) {
    run.senderId = senderId;
    run.channel = normalizeIdentityValue(ctx?.channel || event?.channel) || run.channel;
    run.accountId = normalizeIdentityValue(event?.accountId || ctx?.accountId) || run.accountId;
    run.channelId = normalizeIdentityValue(event?.channelId || ctx?.channelId) || run.channelId;
  }
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
  run.modelSpanIds.clear();
  run.pendingToolInvocations.length = 0;
  run.llmInputStash = null;
  run.llmInputPending = false;
  run.cycleInputSnapshot = null;
  run.userPromptText = null;
  run.systemPrompt = null;
  run.modelCallEnds.clear();
  run.pendingAssistantResponses.clear();
  run.modelCallStartedAtNanos.clear();
  run.assistantResponseCallIds.clear();
  run.toolStepCallIds.clear();
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
  const resolvedUserId = run?.userId || userId;
  const base = {
    time_unix_nano: nowNanos(),
    observed_time_unix_nano: legacyClock ? legacyClock.observed() : nowNanos(),
    "event.id": crypto.randomUUID(),
    "gen_ai.agent.type": AGENT_TYPE,
    "gen_ai.agent.name": AGENT_TYPE,
    "user.id": resolvedUserId,
    ...(agentCwd ? { "agent.openclaw.cwd": agentCwd } : {}),
    ...(run?.senderId ? { "agent.openclaw.sender.id": run.senderId } : {}),
    ...(run?.channel ? { "agent.openclaw.channel": run.channel } : {}),
    ...(run?.accountId ? { "agent.openclaw.account.id": run.accountId } : {}),
    ...(run?.channelId ? { "agent.openclaw.channel.id": run.channelId } : {}),
    ...(run?.userIdSource ? { "agent.openclaw.user.id.source": run.userIdSource } : {}),
    ...(["invocation", "environment", "sender"].includes(run?.userIdSource)
      ? { [INVOCATION_USER_ID_FIELD]: resolvedUserId }
      : {}),
    ...SPAN_ATTRIBUTES,
    ...RESOURCE_BASE_FIELD_PATCH,
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };
  if (run) {
    base.trace_id = run.traceId;
    base["gen_ai.turn.id"] = run.turnId || run.runId;
    // The producer owns the start even if the collector restarts mid-run.
    // An explicit false keeps suffix responses from becoming a second start.
    base["gen_ai.turn.start"] = false;
    if (run.turnId) base["agent.openclaw.run_id"] = run.runId;
    if (run.cronExecution) base["agent.openclaw.collection"] = "cron-lifecycle-v1";
    base["gen_ai.session.id"] = run.sessionId || sessionId || "";
    if (base["gen_ai.session.id"]) base["gen_ai.agent.id"] = base["gen_ai.session.id"];
    if (run.sessionKeyAmbiguous) base["agent.openclaw.session_key.ambiguous"] = true;
    else if (isSessionKey(run.telemetrySessionKey)) base["agent.openclaw.session_key"] = run.telemetrySessionKey;
    if (run.provider) base["gen_ai.provider.name"] = run.provider;
    if (run.model) base["gen_ai.request.model"] = run.model;
  } else if (sessionId) {
    const s = getSession(sessionId);
    base.trace_id = s.traceId;
    base["gen_ai.session.id"] = sessionId;
    if (isSessionKey(s.sessionKey)) base["agent.openclaw.session_key"] = s.sessionKey;
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

function historyInputMessage(message) {
  if (!message || typeof message !== "object") return undefined;
  if (Array.isArray(message.content)) message = { ...message, content: message.content.slice(0, 64) };
  if (message.role === "assistant") {
    return buildAssistantOutputMessagesFromOpenClawMessage(message)?.[0]
      || (typeof message.content === "string"
        ? { role: "assistant", parts: [{ type: "text", content: truncate(message.content, MAX_CONTENT_SIZE) }] }
        : undefined);
  }
  if (message.role === "toolResult" || message.role === "tool") {
    return buildToolResultInputMessage({ message, toolCallId: message.toolCallId || message.tool_call_id });
  }
  if (["user", "system", "developer"].includes(message.role)) {
    const parts = typeof message.content === "string"
      ? [{ type: "text", content: truncate(message.content, MAX_CONTENT_SIZE) }]
      : (Array.isArray(message.content) ? message.content : []).slice(0, 64)
          .filter(block => block?.type === "text" && typeof block.text === "string")
          .map(block => ({ type: "text", content: truncate(block.text, MAX_CONTENT_SIZE) }));
    if (parts.length) return { role: message.role, parts };
  }
  return undefined;
}

function buildUserInputMessages(systemPrompt, userPromptText, historyMessages) {
  const prefix = [];
  if (systemPrompt) {
    prefix.push({
      role: "system",
      parts: [{ type: "text", content: truncate(systemPrompt, MAX_CONTENT_SIZE) }],
    });
  }
  const suffix = [];
  if (userPromptText) {
    suffix.push({
      role: "user",
      parts: [{ type: "text", content: truncate(userPromptText, MAX_CONTENT_SIZE) }],
    });
  }
  // llm_input.historyMessages excludes the prompt being submitted. Snapshot
  // the host's replay view now, retaining recent history within a byte budget
  // rather than keeping the caller's mutable/unbounded objects in run state.
  const history = Array.isArray(historyMessages) ? historyMessages : [];
  const captured = [];
  let bytes = Buffer.byteLength(safeStringify([...prefix, ...suffix]), "utf8");
  let truncated = false;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history.length - 1 - i >= MAX_INPUT_MESSAGES
        || captured.length >= MAX_INPUT_MESSAGES - prefix.length - suffix.length) { truncated = true; break; }
    if (Array.isArray(history[i]?.content) && history[i].content.length > 64) truncated = true;
    const message = historyInputMessage(history[i]);
    if (!message) continue;
    bytes += Buffer.byteLength(safeStringify(message), "utf8") + 1;
    if (bytes > MAX_INPUT_BYTES) { truncated = true; break; }
    captured.push(message);
  }
  const messages = [...prefix, ...captured.reverse(), ...suffix];
  return { messages: messages.length ? messages : undefined, requiredMessages: [...prefix, ...suffix], truncated };
}

function appendCycleInputMessages(snapshot, delta) {
  const messages = [...(snapshot.messages || []), ...delta];
  // Reserve the cycle's system/prompt while retaining the most recent replay
  // and tool inputs. Full snapshots must remain bounded as a tool loop grows.
  const required = new Set(snapshot.requiredMessages);
  const keep = new Set(required);
  let bytes = Buffer.byteLength(safeStringify(snapshot.requiredMessages), "utf8");
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (required.has(message)) continue;
    const size = Buffer.byteLength(safeStringify(message), "utf8") + 1;
    if (keep.size >= MAX_INPUT_MESSAGES || bytes + size > MAX_INPUT_BYTES) {
      snapshot.truncated = true;
      break;
    }
    bytes += size;
    keep.add(message);
  }
  // Do not mutate arrays already emitted on earlier requests.
  snapshot.messages = messages.filter(message => keep.has(message));
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
  const uncachedInput = finiteTokenCount(usage.input);
  const output = finiteTokenCount(usage.output);
  const cacheRead = finiteTokenCount(usage.cacheRead);
  const cacheWrite = finiteTokenCount(usage.cacheWrite);
  // Some newer runtimes expose this extra field even though it is not part of
  // the minimum-version hook contract. Keep it strictly best-effort.
  const reasoning = finiteTokenCount(usage.reasoningTokens);
  // OpenClaw reports uncached, cache-read and cache-write input separately.
  // GenAI input_tokens is inclusive: the cache fields remain as breakdowns,
  // while both input_tokens and total_tokens include them.
  const input = uncachedInput === undefined && cacheRead === undefined && cacheWrite === undefined
    ? undefined
    : (uncachedInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
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

function modelEndFields(ended) {
  if (!ended) return {};
  return {
    "agent.openclaw.call_id": ended.callId,
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
}

function emitPendingAssistantResponse(run, callId, emit) {
  const record = run.pendingAssistantResponses.get(callId);
  if (!record) return;
  const ended = run.modelCallEnds.get(callId);
  // Keep the original response timestamp/identity, not the later flush time.
  const fields = modelEndFields(ended);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = value;
  }
  if (record["error.type"] && ended?.error) record["error.message"] = ended.error;
  run.pendingAssistantResponses.delete(callId);
  run.modelCallEnds.delete(callId);
  addBounded(run.assistantResponseCallIds, callId);
  emit(record);
}

function emitUnmatchedModelResponse(run, callId, userId, emit) {
  const ended = run?.modelCallEnds?.get(callId);
  if (!ended || run.assistantResponseCallIds.has(callId)) return;
  run.modelCallEnds.delete(callId);
  const failed = ended.outcome === "error";
  const record = {
    ...buildCommonFields(run, run.sessionId, userId),
    time_unix_nano: ended.pilotObservedAtNanos,
    "event.name": "llm.response",
    span_id: modelSpanId(run, callId),
    "gen_ai.step.id": callId,
    "gen_ai.response.id": callId,
    "gen_ai.provider.name": inferProviderName(ended.provider || run.provider, ended.model || run.model),
    "gen_ai.request.model": ended.model || run.model,
    "gen_ai.response.model": ended.model || run.model,
    "gen_ai.response.finish_reasons": failed ? ["error"] : undefined,
    ...modelEndFields(ended),
    "error.type": failed ? "model_call_error" : undefined,
    "error.message": failed ? ended.error : undefined,
    "agent.openclaw.hook": "model_call_ended",
    "agent.openclaw.call_id": ended.callId || callId,
  };
  emit(record);
  addBounded(run.assistantResponseCallIds, callId);
}

function flushUnmatchedModelResponses(run, userId, emit, exceptCallId) {
  for (const callId of [...run.pendingAssistantResponses.keys()]) {
    if (callId !== exceptCallId) emitPendingAssistantResponse(run, callId, emit);
  }
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
  const sessionKey = event?.sessionKey || ctx?.sessionKey;
  if (!sessionId && !sessionKey) return;
  for (const run of runs.values()) {
    if (!run.completed && ((sessionId && run.sessionId === sessionId)
      || (sessionKey && run.sessionKey === sessionKey))) {
      flushUnmatchedModelResponses(run, userId, emit);
      completeRun(run);
    }
  }
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

function handleBeforeModelResolve(event, ctx, userId, emit, cfg) {
  const runId = ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  updateRunUserIdentity(run, event, ctx, cfg);
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

function handleBeforePromptBuild(event, ctx, userId, emit, cfg) {
  const runId = ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  updateRunUserIdentity(run, event, ctx, cfg);
  if (event?.prompt) run.userPromptText = event.prompt;
  // No emission — redundant with before_agent_run which has richer fields.
}

function handleBeforeAgentRun(event, ctx, userId, emit, cfg) {
  const runId = ctx?.runId || event?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  updateRunUserIdentity(run, event, ctx, cfg);
  if (event?.prompt) run.userPromptText = event.prompt;
  if (event?.systemPrompt) run.systemPrompt = event.systemPrompt;
  if (ctx?.sessionId) run.sessionId = ctx.sessionId;
  if (ctx?.sessionKey) run.sessionKey = ctx.sessionKey;
  const record = {
    ...buildCommonFields(run, ctx?.sessionId, userId),
    "event.name": "other",
    "agent.openclaw.hook": "before_agent_run",
    "gen_ai.turn.start": !run.turnStartEmitted,
    "gen_ai.input.messages_delta": run.userPromptText
      ? [{ role: "user", parts: [{ type: "text", content: truncate(run.userPromptText, MAX_CONTENT_SIZE) }] }]
      : undefined,
    "gen_ai.system_instructions": run.systemPrompt
      ? [{ type: "text", content: truncate(run.systemPrompt, MAX_CONTENT_SIZE) }]
      : undefined,
  };
  emit(record);
  persistCronContext(run);
  run.turnStartEmitted = true;
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

function handleLlmInput(event, ctx, userId, emit, cfg) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  updateRunUserIdentity(run, event, ctx, cfg);
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
    ...buildUserInputMessages(event.systemPrompt, event.prompt, event.historyMessages),
    systemInstructions: event.systemPrompt
      ? [{ type: "text", content: truncate(event.systemPrompt, MAX_CONTENT_SIZE) }]
      : undefined,
    toolDefinitions: safeJsonClone(buildToolDefinitions(event.tools)),
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
  // Assistant persistence and model_call_ended can arrive in either order.
  // If the next call starts first, close the unmatched
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

  if (run.announcedWork) {
    // New OpenClaw can suppress the persisted user prompt for internal events.
    // The native announcement's first model call proves actual consumption.
    // Prefer the earlier before_message_write payload when it was available.
    recordAgentDelivery(run, run.announcedWork,
      { content: run.llmInputStash?.prompt ?? run.userPromptText }, userId, emit);
  }

  const common = buildCommonFields(run, run.sessionId, userId);
  setBounded(run.modelCallStartedAtNanos, callId, common.time_unix_nano);

  const startsAgentCycle = run.llmInputPending;
  run.llmInputPending = false;
  const stash = run.llmInputStash;
  if (startsAgentCycle) {
    // The converter accumulates deltas across the entire turn and does not
    // reset them on a full request. A same-runId fallback therefore needs an
    // authoritative snapshot on every later step, not another history seed.
    run.cycleInputSnapshot = run.callSeq > 1 && stash ? {
      messages: stash.messages,
      requiredMessages: stash.requiredMessages,
      truncated: stash.truncated,
    } : null;
  }
  const inputDelta = startsAgentCycle && stash
    // The first cycle can use deltas; fallback cycles must not seed history
    // again into that same accumulator. Keep normal tool loops incremental.
    ? (run.cycleInputSnapshot ? undefined
        : stash.messages?.filter(message => message.role !== "system" && message.role !== "developer"))
    : (run.pendingToolInputMessages.length > 0
        ? run.pendingToolInputMessages.splice(0)
        : undefined);
  if (!startsAgentCycle && run.cycleInputSnapshot && inputDelta) {
    appendCycleInputMessages(run.cycleInputSnapshot, inputDelta);
  }
  const inputMessages = startsAgentCycle ? stash?.messages : run.cycleInputSnapshot?.messages;
  const systemInstructions = startsAgentCycle ? stash?.systemInstructions : undefined;
  const toolDefinitions = startsAgentCycle ? stash?.toolDefinitions : undefined;
  if (startsAgentCycle) {
    run.llmInputStash = null;
    run.pendingToolInputMessages.length = 0;
  }

  const record = {
    ...common,
    "event.name": "llm.request",
    span_id: modelSpanId(run, callId),
    "gen_ai.step.id": callId,
    "gen_ai.response.id": callId,
    "gen_ai.provider.name": inferProviderName(event?.provider || run.provider, event?.model || run.model),
    "gen_ai.request.model": event?.model || run.model,
    "gen_ai.response.model": event?.model || run.model,
    "gen_ai.input.messages": truncateContent(inputMessages),
    "gen_ai.input.messages_delta": run.cycleInputSnapshot ? undefined : inputDelta,
    "gen_ai.system_instructions": systemInstructions,
    "gen_ai.tool.definitions": truncateContent(toolDefinitions),
    "agent.pilot.request_context.truncated": (run.cycleInputSnapshot?.truncated || (startsAgentCycle && stash?.truncated)) ? true : undefined,
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
  // An unknown/late native ID must not decorate a different active call.
  const callId = event?.callId ? run.nativeCallIds.get(event.callId) : run.currentStepCallId;
  if (run.completed || run.assistantResponseCallIds.has(callId)) return;
  if (callId) {
    // OpenClaw 6.5 writes the assistant first; newer hosts may end first.
    // Join both hooks before emitting one canonical response in either order.
    if (!run.modelCallEnds.has(callId)) {
      setBounded(run.modelCallEnds, callId, { ...event, pilotObservedAtNanos: nowNanos() });
    }
    emitPendingAssistantResponse(run, callId, emit);
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
  persistCronContext(run);
  completeRun(run);
}

function handleBeforeToolCall(event, ctx, userId, emit) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  // Tool belongs to the current ReAct step (= most recent LLM call's callId).
  const stepId = run.currentStepCallId || run.lastCallId;
  const common = buildCommonFields(run, run.sessionId, userId);
  const spanId = generateSpanId();
  const toolCallId = event?.toolCallId || ctx?.toolCallId;
  const toolName = event?.toolName || ctx?.toolName;
  const invocation = toolCallId ? {
    toolCallId, toolName, spanId, stepId,
    startedAtNanos: common.time_unix_nano,
  } : undefined;
  if (invocation) {
    // Keep invocation state together. Reusing a native ID in a later step must
    // not overwrite a pending result's span, step or start time.
    pushBounded(run.pendingToolInvocations, invocation);
    if (stepId) setBounded(run.toolStepCallIds, toolCallId, stepId);
  }
  const record = {
    ...common,
    "event.name": "tool.call",
    span_id: spanId,
    "gen_ai.step.id": stepId,
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.call.id": toolCallId,
    "gen_ai.tool.call.exec.id": toolCallId,
    "gen_ai.tool.call.arguments": event?.params
      ? truncateContent(safeJsonClone(event.params))
      : undefined,
    "agent.openclaw.hook": "before_tool_call",
  };
  emit(record);
  if (invocation && run.sessionId && ["sessions_spawn", "sessions_send"].includes(toolName)) {
    // Each send is new work; polling/history/cancellation tools never enter here.
    // Retain the original audit ID while we can prove this is its first use.
    const firstUse = run.delegatedToolCallIds.size < MAX_RUN_STATE_ENTRIES
      && !run.delegatedToolCallIds.has(invocation.toolCallId);
    if (firstUse) run.delegatedToolCallIds.add(invocation.toolCallId);
    const work = {
      invocationId: invocationId(run.sessionId, run.turnId || run.runId, invocation.toolCallId, firstUse ? undefined : spanId),
      childSessionKey: event.params?.sessionKey,
    };
    invocation.delegation = work;
    emit(auditRecord(common, work, "invoke", textMessages(event.params?.task ?? event.params?.message, "user")));
  }
}

function takePendingToolInvocation(run, toolCallId, toolName) {
  if (!toolCallId) return undefined;
  const pending = run.pendingToolInvocations;
  const compatible = pending.filter(item => item.toolCallId === toolCallId
    && (!toolName || !item.toolName || item.toolName === toolName));
  // Same-name reuse remains FIFO. Without a name on either side, use the ID
  // alone only when one pending call could own the result.
  const exact = toolName && compatible.find(item => item.toolName === toolName);
  const invocation = exact || (compatible.length === 1 ? compatible[0] : undefined);
  if (invocation) pending.splice(pending.indexOf(invocation), 1);
  return invocation;
}

function handleAfterToolCall(event, ctx, userId, emit) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  // Tool execution may finish after OpenClaw has already started the next
  // model call. Keep the result on the step where before_tool_call began so
  // the converter merges arguments, result and duration into one TOOL span.
  const toolCallId = event?.toolCallId || ctx?.toolCallId;
  const observedToolName = event?.toolName || ctx?.toolName;
  const invocation = takePendingToolInvocation(run, toolCallId, observedToolName);
  const toolName = observedToolName || invocation?.toolName;
  const stepId = invocation ? invocation.stepId : run.currentStepCallId || run.lastCallId;
  const common = buildCommonFields(run, run.sessionId, userId);
  const startedAtNanos = invocation?.startedAtNanos;
  if (invocation && stepId) {
    // Persistence hooks must see the invocation that just completed.
    setBounded(run.toolStepCallIds, invocation.toolCallId, stepId);
  }
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
  const work = invocation?.delegation;
  const details = result?.details || result;
  if (invocation && invocation.toolName === toolName && ["sessions_spawn", "sessions_send"].includes(toolName)) {
    // Dispatch identity is independent of visible reply delivery. Native send
    // can finish silently or fail after sending; a pre-dispatch error's runId
    // alone is not evidence that the target actually received this work.
    const dispatched = ["accepted", "ok"].includes(details?.status)
      || (toolName === "sessions_send" && (details?.status === "no_reply"
        || (details?.sentBeforeError === true && ["timeout", "error"].includes(details?.status))));
    if (dispatched && typeof details.runId === "string") {
      const parent = {
        traceId: run.parentContext?.traceId || run.traceId,
        parentSpanId: invocation.spanId,
        sessionId: run.sessionId, turnId: run.turnId || run.runId,
        parentRunId: run.runId,
        toolCallId, userId: run.parentContext?.userId || run.userId || userId,
        invocationId: work?.invocationId,
        childSessionKey: details.childSessionKey || details.sessionKey || work?.childSessionKey,
        auditOnly: toolName === "sessions_send",
      };
      const retained = childContexts.read(details.runId);
      if (retained && retained.invocationId === parent.invocationId) {
        parent.childSessionId = retained.childSessionId;
        parent.resultIds = retained.resultIds;
      }
      const child = runs.get(details.runId);
      if (child?.sessionId) parent.childSessionId = child.sessionId;
      if (work && parent.childSessionId) work.childSessionId = parent.childSessionId;
      childContexts.write(details.runId, parent);
      if (child) {
        child.auditParentContext = parent;
        if (!parent.auditOnly) releasePendingChild(child, parent);
      }
    }
  }
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
    span_id: invocation?.spanId || generateSpanId(),
    "gen_ai.step.id": stepId,
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.call.id": toolCallId,
    "gen_ai.tool.call.exec.id": toolCallId,
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
  emit(record, startedAtNanos);
  // A send may synchronously deliver a reply. Accepted/timeout is never success.
  if (work && ((toolName === "sessions_send" && details?.status === "ok" && typeof details.reply === "string")
    || isError || details?.status === "error" || details?.status === "forbidden")) {
    const audit = auditRecord(common, work, "result", textMessages(details?.reply ?? errorMessage ?? details?.error, "assistant"), work.childSessionId);
    if (isError || ["error", "forbidden"].includes(details?.status)) audit["error.type"] = "agent_dispatch_error";
    if (!work.resultIds?.includes(audit["event.id"])) {
      if (emit(audit) !== false) work.resultIds = [...(work.resultIds || []), audit["event.id"]].slice(-32);
    }
  }
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

function recordAgentDelivery(receiver, work, message, userId, emit) {
  const retained = childContexts.read(work.runId);
  if (retained?.invocationId === work.invocationId) work = retained;
  // One native child-run completion is one logical result, including when
  // both persistence and model-consumption hooks observe the same receipt.
  if (work.resultIds?.length) return;
  const audit = auditRecord(buildCommonFields(receiver, receiver.sessionId, userId), work,
    'result', textMessages(deliveredText(message), 'assistant'), work.childSessionId);
  if (emit(audit) === false) return;
  work.resultIds = [audit['event.id']];
  childContexts.write(work.runId, work);
}

function prepareSteeredDelivery(params) {
  const source = params?.sourceSessionKey;
  const prefix = `announce:v1:${source}:`;
  if (!isSessionKey(source) || !params.directIdempotencyKey?.startsWith(prefix)) return;
  const work = childContexts.read(params.directIdempotencyKey.slice(prefix.length));
  if (!work?.invocationId || work.childSessionKey !== source) return;
  const receivers = [...runs.values()].filter(run => !run.completed && run.sessionId === work.sessionId
    && run.sessionKey === params.targetRequesterSessionKey);
  if (receivers.length !== 1) return;
  const events = params.internalEvents?.filter(event => event.type === 'task_completion'
    && event.source === 'subagent' && event.childSessionKey === source);
  if (events?.length !== 1) return;
  return { receiver: receivers[0], turnId: receivers[0].turnId, work, result: events[0].result };
}

function completeSteeredDelivery(receipt, delivery) {
  if (!receipt || delivery?.delivered !== true || delivery.path !== 'steered'
    || !Number.isFinite(delivery.deliveredAt)) return;
  const { receiver, work, result } = receipt;
  // The native queue targets the live receiver. A different or terminated
  // receiver after its commit is ambiguous; retain ordinary independent data.
  if (runs.get(receiver.runId) !== receiver || receiver.completed || receiver.turnId !== receipt.turnId) return;
  recordAgentDelivery(receiver, work, { content: typeof result === 'string' ? result : undefined },
    resolveUserId(loadPilotConfig()), emitRecord);
}

function handleBeforeMessageWrite(event, ctx, userId, emit, cfg, waitForEnd = true) {
  const message = event?.message;
  const role = message?.role;

  // Observe the actual parent-side persisted delivery, not child agent_end or
  // subagent_ended. Only native structured provenance is authoritative; never
  // parse a user-authored prompt, task label, nickname, or nearest timestamp.
  if (role === "user" && message.provenance?.kind === "inter_session"
    && message.provenance.sourceTool === "subagent_announce") {
    const receiver = resolveContextRun(event, ctx);
    const source = message.provenance.sourceSessionKey;
    if (!receiver?.sessionId || !isSessionKey(source)) return;
    // OpenClaw's native announce idempotency key is derived from the exact
    // child session/run pair. This disambiguates reused sessions without
    // parsing prompt text or selecting whichever invocation is newest.
    const prefix = `announce:v1:${source}:`;
    const nativeWork = receiver.runId?.startsWith(prefix)
      ? childContexts.read(receiver.runId.slice(prefix.length)) : undefined;
    const candidates = receiver.runId?.startsWith(prefix)
      ? (nativeWork ? [nativeWork] : []) : childContexts.list();
    const matches = candidates.filter(work => work.invocationId && work.childSessionKey === source
      && work.sessionId === receiver.sessionId);
    // Older delivery paths lack this work key. Retain only unique provenance.
    if (matches.length !== 1) return;
    recordAgentDelivery(receiver, matches[0], message, userId, emit);
    return;
  }

  // AssistantMessage is the supported OpenClaw per-call completion contract:
  // it carries output, stopReason, provider responseId and usage together.
  // Emit exactly one canonical llm.response from it; llm_output is aggregate
  // run metadata and must not be merged into the last model span.
  if (role === "assistant") {
    const run = resolveContextRun(event, ctx);
    if (!run) return;
    const targetCallId = run.currentStepCallId || run.lastCallId;
    if (!targetCallId) return;
    if (run.assistantResponseCallIds.has(targetCallId)) return;
    if (run.pendingAssistantResponses.has(targetCallId)) return;
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
    // The converter accumulates request deltas; it does not copy responses
    // into the next request. Persisted assistant messages are observed input
    // for the following model call, before the matching tool results.
    if (rawOutputMessages) {
      for (const output of rawOutputMessages) pushBounded(run.pendingToolInputMessages, safeJsonClone(output));
    }
    const outputMessages = addFinishReason(rawOutputMessages, finishReason);
    const usage = normalizeUsage(message.usage);
    const ended = run.modelCallEnds.get(targetCallId);
    const responseId = message.responseId || targetCallId;
    rememberCallUsage(run, targetCallId, usage);
    const stopReason = message.stopReason;
    const record = {
      ...buildCommonFields(run, run.sessionId, userId),
      "event.name": "llm.response",
      span_id: modelSpanId(run, targetCallId),
      "gen_ai.step.id": targetCallId,
      "gen_ai.response.id": responseId,
      "gen_ai.response.time_to_first_token": firstTokenObserver?.take(message.api, message.responseId),
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
      "agent.openclaw.call_id": targetCallId,
      "agent.openclaw.api": message.api,
    };
    // Legacy hosts have no model_call_ended; preserve their immediate adapter emission.
    if (!waitForEnd) {
      addBounded(run.assistantResponseCallIds, targetCallId);
      emit(record);
      return;
    }
    // A new call flushes the previous pending response, so this map is bounded
    // by the existing per-run call lifecycle. Apply privacy at observation as
    // well as emission so a later config change cannot expose withheld content.
    setBounded(run.pendingAssistantResponses, targetCallId,
      shouldCaptureContent(cfg) ? record : redactRecordContent(record));
    if (ended) emitPendingAssistantResponse(run, targetCallId, emit);
    return;
  }

  // Non-assistant messages (user / toolResult) are metadata-only at the
  // gen_ai.* level — the converter already discards "other" events without
  // gen_ai.input.messages inside a turn (converter.js:73), and the flusher
  // drops metadata-only ephemeral events to prevent phantom ENTRY+AGENT.
  // Skip writing them so they don't surface as standalone spans.
}

function handleAgentEnd(event, ctx, userId, emit) {
  const runId = event?.runId || ctx?.runId;
  if (!runId) return;
  const run = getRun(runId, event, ctx);
  const success = event?.success !== false;
  flushUnmatchedModelResponses(run, userId, emit);
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

function emitRecord(record) {
  return writeRecord(record, shouldCaptureContent(loadPilotConfig()));
}

function makeHandler(fn, interceptHook) {
  // Keep persistence hooks synchronous: OpenClaw's tool_result_persist and
  // before_message_write hooks reject Promise-returning handlers.
  return function safeHandler(event, ctx) {
    const collect = () => {
      try {
        const cfg = loadPilotConfig();
        const userId = resolveUserId(cfg);
        fn(event, ctx, userId, emitRecord, cfg);
      } catch (err) {
        writeError(fn.name || "handler", err);
      }
    };
    if (!interceptHook) {
      collect();
      return;
    }

    const options = {
      cwd: agentCwd,
      sync: SYNC_INTERCEPT_HOOKS.has(interceptHook),
    };
    if (options.sync) {
      let decision;
      try {
        decision = evaluateInterceptor(interceptHook, event, ctx, options);
      } catch (err) {
        writeError("interceptor", err);
      }
      // Publish transcript/plugin JSONL only after the verdict record is durable.
      collect();
      return decision;
    }

    let pending;
    try {
      pending = evaluateInterceptor(interceptHook, event, ctx, options);
    } catch (err) {
      writeError("interceptor", err);
      collect();
      return undefined;
    }
    // Missing runtime is a synchronous fail-open; preserve the host hook's
    // synchronous return contract while still recording unknown first.
    if (!pending || typeof pending.then !== "function") {
      collect();
      return pending;
    }
    return Promise.resolve(pending)
      .catch((err) => {
        writeError("interceptor", err);
        return undefined;
      })
      .then((decision) => {
        // Prevent the collector from consuming this event before verdict storage.
        collect();
        return decision;
      });
  };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Same-turn PostToolUse: OpenClaw awaits tool-result middleware before the
// current ReAct model call. tool_result_persist only rewrites transcript.
function registerSameTurnToolResultIntercept(api) {
  if (typeof api?.registerAgentToolResultMiddleware !== "function") {
    debugFailureOnce(
      "interceptor-middleware",
      new Error("registerAgentToolResultMiddleware is unavailable; PostToolUse same-turn intercept disabled"),
    );
    return;
  }
  try {
    api.registerAgentToolResultMiddleware(async (event, ctx) => {
      try {
        const payload = isPlainObject(event) ? event : {};
        const decision = await evaluateInterceptor(
          SAME_TURN_POST_TOOL_HOOK,
          {
            toolName: payload.toolName,
            toolCallId: payload.toolCallId,
            params: payload.args ?? payload.params,
            result: payload.result,
            sessionId: payload.sessionId,
          },
          isPlainObject(ctx) ? ctx : {},
          { cwd: agentCwd },
        );
        if (isPlainObject(decision) && isPlainObject(decision.result)) {
          return { result: decision.result };
        }
        return undefined;
      } catch (err) {
        writeError("interceptor-middleware", err);
        return undefined;
      }
    }, { runtimes: ["openclaw"] });
  } catch (err) {
    writeError("interceptor-middleware-register", err);
  }
}

function reportUnsupportedHost(api, detail) {
  const message =
    `[${PLUGIN_ID}] incompatible OpenClaw plugin API: `
    + `${detail}; OpenClaw >=${MIN_OPENCLAW_VERSION} is required`;
  try {
    if (typeof api?.logger?.error === "function") {
      api.logger.error(message);
    } else {
      console.error(message);
    }
  } catch {
    // Telemetry diagnostics must never affect the host process.
  }
}

export default {
  id: PLUGIN_ID,
  name: "loongsuite-pilot-openclaw",
  description:
    "ARMS GenAI event_t producer with automatic legacy/modern OpenClaw hook adaptation.",

  register(api) {
    // OpenClaw's CLI metadata discovery provides a stub runtime and noop hook
    // registrar. This plugin has no CLI commands, so there is nothing to do
    // until the host performs a full registration.
    if (api?.registrationMode === "cli-metadata") {
      return;
    }

    if (typeof api?.on !== "function") {
      reportUnsupportedHost(api, "api.on is unavailable");
      return;
    }

    const hostVersion = api?.runtime?.version;
    const capabilities = resolveRuntimeCapabilities(hostVersion);
    if (!capabilities) {
      const versionLabel = typeof hostVersion === "string" && hostVersion.length > 0
        ? hostVersion
        : "unavailable";
      reportUnsupportedHost(api, `api.runtime.version=${versionLabel} is unsupported`);
      return;
    }

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

    const on = (name, fn, opts) => {
      const intercept = opts?.intercept;
      const hookOpts = {};
      if (opts) {
        for (const [key, value] of Object.entries(opts)) {
          if (key !== "intercept") hookOpts[key] = value;
        }
      }
      const handler = makeHandler(fn, intercept);
      if (Object.keys(hookOpts).length > 0) api.on(name, handler, hookOpts);
      else api.on(name, handler);
    };

    if (capabilities.adapter === "legacy") {
      legacyClock = createObservationClock();
      const handlers = createLegacyHandlers({
        nowNanos, buildCommonFields, advanceClockTo: value => legacyClock.advanceTo(value),
        resolveContextRun, safeStringify, buildAssistantOutputMessagesFromOpenClawMessage,
        handleLlmInput, handleBeforeAgentRun, handleModelCallStarted,
        handleBeforeMessageWrite: (event, ctx, userId, emit) =>
          handleBeforeMessageWrite(event, ctx, userId, emit, undefined, false),
        handleBeforeToolCall, handleAfterToolCall, handleToolResultPersist,
        handleAgentEnd, handleLlmOutput, handleSessionStart, handleSessionEnd, completeRun,
      });
      for (const [name, handler] of Object.entries(handlers)) on(name, handler);
      return;
    }

    try { firstTokenObserver = installFirstTokenObserver(); } catch (err) {
      debugFailureOnce("first-token-observer", err);
    }
    try { installSteeredDeliveryObserver({ prepare: prepareSteeredDelivery, complete: completeSteeredDelivery }); }
    catch (err) { debugFailureOnce('steered-delivery-observer', err); }

    // The hook is optional on older hosts. Failure leaves their prior producer
    // and flusher behavior intact instead of disabling the plugin.
    try { on("cron_changed", handleCronChanged); }
    catch (err) { debugFailureOnce("cron-changed-register", err); }
    try { on("gateway_start", handleCronGatewayStart); on("gateway_stop", handleCronGatewayStop); }
    catch (err) { debugFailureOnce("cron-gateway-register", err); }

    // Observe completion via agent_end. Merely registering before_agent_finalize
    // enables the host's answer-revision gate and defers streaming delivery.
    // 6 conversation-access hooks (OpenClaw CONVERSATION_HOOK_NAMES)
    on("before_model_resolve", handleBeforeModelResolve);
    on("before_agent_reply", handleBeforeAgentReply);
    on("llm_input", handleLlmInput);
    on("llm_output", handleLlmOutput);
    on("agent_end", handleAgentEnd);
    on("before_agent_run", handleBeforeAgentRun, {
      intercept: "before_agent_run",
      priority: 1000,
      timeoutMs: 8_000,
    });

    // 9 default-active hooks (prompt / model / tool / session / message write)
    on("before_prompt_build", handleBeforePromptBuild);
    on("model_call_started", handleModelCallStarted);
    on("model_call_ended", handleModelCallEnded);
    on("before_tool_call", handleBeforeToolCall, {
      intercept: "before_tool_call",
      priority: 1000,
      timeoutMs: 8_000,
    });
    on("after_tool_call", handleAfterToolCall);
    on("tool_result_persist", handleToolResultPersist, {
      intercept: "tool_result_persist",
    });
    on("before_message_write", handleBeforeMessageWrite);
    on("session_start", handleSessionStart);
    on("session_end", handleSessionEnd);
    registerSameTurnToolResultIntercept(api);
  },
};
