/**
 * In-process OpenClaw interceptor client.
 *
 * Maps OpenClaw policy hooks onto the shared interceptor daemon. Missing
 * runtime is silent fail-open so collection-only installs do not fill
 * access.log. Errors after a runtime is present are logged as fail-open.
 *
 * before_agent_run / before_tool_call / tool_result_middleware may return a
 * Promise (OpenClaw awaits them). tool_result_persist must stay synchronous,
 * so it uses spawnSync of interceptor-cli when a daemon runtime exists.
 * Same-turn PostToolUse intercept is middleware `{ result }`; persist only
 * rewrites the transcript `{ message }` and reuses a short TTL cache.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT = "openclaw";
const INTERCEPTOR_SERVICE = "loongsuite-pilot-interceptor";
const INTERCEPTOR_HOOK_TIMEOUT_MS = 4_000;
const INTERCEPTOR_HEALTH_TIMEOUT_MS = 200;
const ACCESS_LOG_MAX_CHARS = 256_000;
const TOOL_VERDICT_RETENTION_DAYS = 7;
const TOOL_VERDICT_MAX_RECORDS = 100_000;
const TOOL_VERDICT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const OPENCLAW_HOOK_TO_EVENT = {
  before_agent_run: "UserPromptSubmit",
  before_prompt_build: "UserPromptSubmit",
  llm_input: "UserPromptSubmit",
  before_tool_call: "PreToolUse",
  after_tool_call: "PostToolUse",
  tool_result_middleware: "PostToolUse",
  tool_result_persist: "PostToolUse",
};

export const SYNC_INTERCEPT_HOOKS = new Set(["tool_result_persist"]);
export const SAME_TURN_POST_TOOL_HOOK = "tool_result_middleware";

const POST_TOOL_CACHE_TTL_MS = 30_000;
const POST_TOOL_CACHE_MAX = 256;

function resolveDataDir() {
  return (
    process.env.LOONGSUITE_PILOT_DATA_DIR ||
    process.env.PILOT_DATA ||
    path.join(os.homedir(), ".loongsuite-pilot")
  );
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

export function wrapHostReason(event, interceptorReason) {
  const detail = interceptorReason?.trim() ?? "";
  if (event === "UserPromptSubmit") {
    return detail
      ? `检测到敏感信息：${detail}，本轮对话终止`
      : "检测到敏感信息，本轮对话终止";
  }
  if (event === "PostToolUse") {
    return detail
      ? `检测到非预期行为：${detail}，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。`
      : "检测到非预期行为，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。";
  }
  return detail
    ? `检测到非预期行为：${detail}，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。`
    : "检测到非预期行为，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。";
}

export function buildHookRequest(hookName, event, ctx, cwd) {
  const mapped = OPENCLAW_HOOK_TO_EVENT[hookName];
  if (!mapped) return null;
  const ev = isRecord(event) ? event : {};
  const context = isRecord(ctx) ? ctx : {};
  const message = isRecord(ev.message) ? ev.message : undefined;
  return {
    agent: AGENT,
    event: mapped,
    sessionId: pickString(ev.sessionId, context.sessionId),
    cwd: pickString(ev.cwd, cwd),
    prompt: typeof ev.prompt === "string" ? ev.prompt : undefined,
    toolName: pickString(ev.toolName),
    toolInput: ev.params ?? ev.toolInput,
    toolResponse: ev.message ?? ev.result ?? ev.toolResponse,
    toolUseId: pickString(ev.toolCallId, message?.toolCallId),
    raw: {
      openclaw_hook: hookName,
      ...(safeClone(ev) ?? {}),
    },
  };
}

function rewritePostToolContent(original, wrapped) {
  return {
    ...(isRecord(original) ? original : {}),
    content: [{ type: "text", text: wrapped }],
  };
}

export function openClawBlockResult(request, interceptorReason) {
  const wrapped = wrapHostReason(request.event, interceptorReason);
  const detail = interceptorReason?.trim() || "Blocked by security policy";
  if (request.event === "UserPromptSubmit") {
    return { outcome: "block", reason: detail, message: wrapped };
  }
  if (request.event === "PostToolUse") {
    const rewritten = rewritePostToolContent(request.toolResponse, wrapped);
    if (request.raw?.openclaw_hook === SAME_TURN_POST_TOOL_HOOK) {
      return { result: rewritten };
    }
    return { message: rewritten };
  }
  return { block: true, blockReason: wrapped };
}

function readRuntime(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    if (parsed.service !== INTERCEPTOR_SERVICE) return null;
    if (parsed.status !== "ok") return null;
    if (!Number.isInteger(parsed.daemon_port) || parsed.daemon_port < 1 || parsed.daemon_port > 65535) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function interceptorRuntimePath(dataDir) {
  return path.join(dataDir, "interceptor", "runtime.json");
}

function interceptorAccessLogPath(dataDir) {
  return path.join(dataDir, "interceptor", "logs", "access.log");
}

function toolVerdictDir(dataDir) {
  return path.join(dataDir, "interceptor", "tool-verdicts");
}

function toolVerdictHash(request) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([
      request.agent,
      request.sessionId ?? "",
      request.toolUseId,
      request.event,
    ]))
    .digest("hex");
}

function recordToolVerdict(dataDir, request, result) {
  if (
    !request.toolUseId
    || (request.event !== "PreToolUse" && request.event !== "PostToolUse")
  ) return;
  const root = toolVerdictDir(dataDir);
  const now = new Date();
  const bucket = path.join(root, now.toISOString().slice(0, 10));
  const dest = path.join(bucket, `${toolVerdictHash(request)}.json`);
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(bucket, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({
      schema: 1,
      agent: request.agent,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      phase: request.event,
      result,
      recordedAt: now.toISOString(),
    }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, dest);
    maybeCleanupToolVerdicts(root, now);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function maybeCleanupToolVerdicts(root, now) {
  const marker = path.join(root, ".cleanup-marker");
  const lock = path.join(root, ".cleanup-lock");
  try {
    if (now.getTime() - fs.statSync(marker).mtimeMs < TOOL_VERDICT_CLEANUP_INTERVAL_MS) return;
  } catch {}
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(lock, "wx", 0o600));
  } catch {
    return;
  }
  try {
    const retained = new Set();
    for (let age = 0; age < TOOL_VERDICT_RETENTION_DAYS; age += 1) {
      retained.add(new Date(now.getTime() - age * DAY_MS).toISOString().slice(0, 10));
    }
    const kept = [];
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name);
      if (/^\d{4}-\d{2}-\d{2}$/.test(name) && !retained.has(name)) {
        fs.rmSync(full, { recursive: true, force: true });
        continue;
      }
      if (!retained.has(name)) continue;
      for (const filename of fs.readdirSync(full)) {
        const file = path.join(full, filename);
        if (filename.endsWith(".tmp")) {
          try { fs.unlinkSync(file); } catch {}
        } else if (filename.endsWith(".json")) {
          try { kept.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); } catch {}
        }
      }
    }
    if (kept.length > TOOL_VERDICT_MAX_RECORDS) {
      kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (let i = 0; i < kept.length - TOOL_VERDICT_MAX_RECORDS; i += 1) {
        try { fs.unlinkSync(kept[i].file); } catch {}
      }
    }
    fs.writeFileSync(marker, now.toISOString(), { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best effort.
  } finally {
    try { fs.unlinkSync(lock); } catch {}
  }
}

function resolveCli(dataDir) {
  const explicit = process.env.INTERCEPTOR_CLI;
  if (typeof explicit === "string" && explicit.length > 0 && fs.existsSync(explicit)) {
    return explicit;
  }
  try {
    const version = fs.readFileSync(path.join(dataDir, "current"), "utf8").replace(/^\uFEFF/, "").trim();
    if (!version) return undefined;
    const cli = path.join(dataDir, "versions", version, "dist", "interceptor", "cli.cjs");
    return fs.existsSync(cli) ? cli : undefined;
  } catch {
    return undefined;
  }
}

function writeFailOpen(dataDir, request, error) {
  try {
    const dest = interceptorAccessLogPath(dataDir);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      event: request.event,
      agent: request.agent,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      input: {
        prompt: request.prompt,
        toolName: request.toolName,
        toolInput: request.toolInput,
        toolResponse: request.toolResponse,
        cwd: request.cwd,
        raw: request.raw,
      },
      result: { action: "fail-open", error },
    };
    let line = JSON.stringify(entry);
    if (line.length > ACCESS_LOG_MAX_CHARS) {
      line = JSON.stringify({
        ...entry,
        input: { cwd: request.cwd, rawText: "<truncated>" },
      });
    }
    fs.appendFileSync(dest, `${line}\n`, "utf8");
  } catch {
    // Access logs must never affect fail-open.
  }
}

async function doJson(fetchImpl, port, pathname, body, timeoutMs, method = body === undefined ? "GET" : "POST") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status < 200 || response.status > 299) {
      throw new Error(`daemon ${pathname}: HTTP ${response.status}`);
    }
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) throw new Error("empty JSON response");
    return JSON.parse(trimmed);
  } finally {
    clearTimeout(timer);
  }
}

export function createOpenClawInterceptor(overrides = {}) {
  const deps = {
    resolveDataDir,
    fetchImpl: globalThis.fetch?.bind(globalThis),
    spawnSyncImpl: spawnSync,
    execPath: process.execPath,
    env: process.env,
    ...overrides,
  };

  function currentRuntime() {
    return readRuntime(interceptorRuntimePath(deps.resolveDataDir()));
  }

  const postToolCache = new Map();

  function postToolCacheKey(request) {
    return typeof request.toolUseId === "string" && request.toolUseId.length > 0
      ? request.toolUseId
      : undefined;
  }

  function readPostToolCache(request) {
    if (request.event !== "PostToolUse") return { miss: true };
    const key = postToolCacheKey(request);
    if (!key) return { miss: true };
    const hit = postToolCache.get(key);
    if (!hit) return { miss: true };
    if (Date.now() - hit.ts > POST_TOOL_CACHE_TTL_MS) {
      postToolCache.delete(key);
      return { miss: true };
    }
    postToolCache.delete(key);
    postToolCache.set(key, hit);
    if (hit.action !== "block") return { hit: true, result: undefined };
    return { hit: true, result: openClawBlockResult(request, hit.reason) };
  }

  function rememberPostToolVerdict(request, action, reason) {
    if (request.event !== "PostToolUse") return;
    const key = postToolCacheKey(request);
    if (!key) return;
    if (postToolCache.size >= POST_TOOL_CACHE_MAX) {
      const oldest = postToolCache.keys().next().value;
      postToolCache.delete(oldest);
    }
    postToolCache.set(key, { ts: Date.now(), action, reason });
  }

  async function evaluateAsync(request, runtime) {
    try {
      const health = await doJson(
        deps.fetchImpl,
        runtime.daemon_port,
        "/health",
        undefined,
        INTERCEPTOR_HEALTH_TIMEOUT_MS,
        "GET",
      );
      if (health.service !== INTERCEPTOR_SERVICE || health.status !== "ok") {
        recordToolVerdict(deps.resolveDataDir(), request, "unknown");
        writeFailOpen(deps.resolveDataDir(), request, "daemon identity mismatch");
        return undefined;
      }
      if (health.version !== runtime.version || health.pid !== runtime.pid) {
        recordToolVerdict(deps.resolveDataDir(), request, "unknown");
        writeFailOpen(deps.resolveDataDir(), request, "daemon identity mismatch");
        return undefined;
      }
      const verdict = await doJson(
        deps.fetchImpl,
        runtime.daemon_port,
        "/v1/hooks/evaluate",
        request,
        INTERCEPTOR_HOOK_TIMEOUT_MS,
      );
      if (verdict?.action !== "block") {
        rememberPostToolVerdict(request, "allow");
        return undefined;
      }
      rememberPostToolVerdict(request, "block", verdict.reason);
      return openClawBlockResult(request, verdict.reason);
    } catch (err) {
      recordToolVerdict(deps.resolveDataDir(), request, "unknown");
      writeFailOpen(deps.resolveDataDir(), request, err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  function toCliPayload(request) {
    return {
      hook_event_name: request.event,
      session_id: request.sessionId,
      cwd: request.cwd,
      prompt: request.prompt,
      tool_name: request.toolName,
      tool_input: request.toolInput,
      tool_response: request.toolResponse,
      tool_use_id: request.toolUseId,
    };
  }

  function evaluateSync(request) {
    const dataDir = deps.resolveDataDir();
    const runtime = currentRuntime();
    if (!runtime) return undefined;
    const cli = resolveCli(dataDir);
    if (!cli) {
      recordToolVerdict(dataDir, request, "unknown");
      writeFailOpen(dataDir, request, "interceptor cli missing");
      return undefined;
    }
    const result = deps.spawnSyncImpl(deps.execPath, [cli, "hook", "--agent", "openclaw"], {
      input: JSON.stringify(toCliPayload(request)),
      encoding: "utf8",
      timeout: INTERCEPTOR_HOOK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: deps.env,
    });
    if (result.error) {
      recordToolVerdict(dataDir, request, "unknown");
      writeFailOpen(dataDir, request, result.error.message);
      return undefined;
    }
    const text = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (!text) {
      rememberPostToolVerdict(request, "allow");
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      recordToolVerdict(dataDir, request, "unknown");
      writeFailOpen(dataDir, request, "invalid interceptor cli stdout");
      return undefined;
    }
  }

  function evaluate(hookName, event, ctx, opts = {}) {
    const request = buildHookRequest(hookName, event, ctx, opts.cwd);
    if (!request) return undefined;
    const cached = readPostToolCache(request);
    if (!cached.miss) return cached.result;
    const runtime = currentRuntime();
    if (!runtime) {
      recordToolVerdict(deps.resolveDataDir(), request, "unknown");
      return undefined;
    }
    if (opts.sync || SYNC_INTERCEPT_HOOKS.has(hookName)) {
      return evaluateSync(request);
    }
    return evaluateAsync(request, runtime);
  }

  return { evaluate, buildHookRequest, currentRuntime };
}

const defaultInterceptor = createOpenClawInterceptor();

export function evaluateInterceptor(hookName, event, ctx, opts = {}) {
  return defaultInterceptor.evaluate(hookName, event, ctx, opts);
}
