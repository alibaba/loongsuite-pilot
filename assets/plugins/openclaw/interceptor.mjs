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

import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = "openclaw";
const INTERCEPTOR_SERVICE = "loongsuite-pilot-interceptor";
const INTERCEPTOR_HOOK_TIMEOUT_MS = 4_000;
const INTERCEPTOR_HEALTH_TIMEOUT_MS = 200;
const ACCESS_LOG_MAX_CHARS = 256_000;
const ACCESS_LOG_MAX_BYTES = 10 * 1024 * 1024;
const ACCESS_LOG_ROTATE_COUNT = 5;

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
const SDK_HOOK_REQUEST_MAX_BYTES = 1024 * 1024;

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function readConfigFileDataDir() {
  const configured = (process.env.AGENT_DATA_COLLECTION_CONFIG || "").trim();
  const configPath = configured || path.join(os.homedir(), ".loongsuite-pilot", "config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    if (typeof parsed.dataDir === "string" && parsed.dataDir.trim()) return parsed.dataDir.trim();
  } catch {
    // A missing or unreadable config falls through to the default data dir.
  }
  return undefined;
}

export function resolveDataDir() {
  const fromEnv = [process.env.LOONGSUITE_PILOT_DATA_DIR, process.env.PILOT_DATA]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
  if (fromEnv) return expandHome(fromEnv);
  const fromFile = readConfigFileDataDir();
  if (fromFile) return expandHome(fromFile);
  return path.join(os.homedir(), ".loongsuite-pilot");
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function sharedIdentifier(first, second) {
  const a = pickString(first);
  const b = pickString(second);
  return a && b && a !== b ? null : a ?? b;
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

// Match native hook/runtime boundaries: an installed current pointer is a
// bounded single safe component, and default candidates never cross links or
// search PATH/cwd. Explicit legacy INTERCEPTOR_CLI scripts remain opt-in.
function nativeImage(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const header = Buffer.alloc(4);
    if (fs.readSync(fd, header, 0, 4, 0) < 2) return false;
    return header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || header.subarray(0, 2).equals(Buffer.from([0x4d, 0x5a]))
      || header.readUInt32BE(0) === 0xfeedfacf || header.readUInt32BE(0) === 0xcffaedfe;
  } catch { return false; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
function pathEntryExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { return error?.code !== "ENOENT"; }
}
function ordinaryPath(file, directory = false) {
  try {
    const stat = fs.lstatSync(file);
    return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile());
  } catch { return false; }
}
function nativeCommand(binary) {
  if (!path.isAbsolute(binary) || !ordinaryPath(binary) || !nativeImage(binary)) return undefined;
  try { fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); }
  catch { return undefined; }
  return { binary, args: ["interceptor", "hook", "--agent", "openclaw"] };
}
function nativeAt(root) {
  if (!ordinaryPath(root, true) || !ordinaryPath(path.join(root, "bin"), true)) return undefined;
  return nativeCommand(path.join(root, "bin", process.platform === "win32" ? "loongsuite-pilot.exe" : "loongsuite-pilot"));
}
function currentVersion(cache) {
  const pointer = path.join(cache, "current");
  if (!ordinaryPath(pointer)) return undefined;
  let fd;
  try {
    fd = fs.openSync(pointer, "r");
    const buffer = Buffer.alloc(1025);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > 1024) return undefined;
    const version = buffer.subarray(0, count).toString("utf8").replace(/^\uFEFF/, "").trim();
    return version.length > 0 && version.length <= 240 && version !== "." && version !== ".."
      && !version.endsWith(".") && /^[A-Za-z0-9._+-]+$/.test(version) ? version : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
function resolveCli(dataDir, deps) {
  const env = deps.env;
  const explicit = env.INTERCEPTOR_CLI;
  if (typeof explicit === "string" && explicit.length > 0 && fs.existsSync(expandHome(explicit))) {
    const file = path.resolve(expandHome(explicit));
    return nativeImage(file) ? nativeCommand(file)
      : { binary: deps.execPath, args: [file, "hook", "--agent", "openclaw"], legacyScript: true };
  }
  if (typeof env.LOONGSUITE_PILOT_BIN === "string" && env.LOONGSUITE_PILOT_BIN.length > 0) {
    return nativeCommand(env.LOONGSUITE_PILOT_BIN);
  }
  const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const manifest = path.join(packageRoot, "runtime-manifest.json");
  if (pathEntryExists(manifest)) return ordinaryPath(manifest) ? nativeAt(packageRoot) : undefined;
  const data = path.resolve(expandHome(dataDir));
  const cache = path.resolve(expandHome(env.LOONGSUITE_PILOT_CACHE_DIR || data));
  if (!ordinaryPath(cache, true)) return undefined;
  if (pathEntryExists(path.join(cache, "current"))) {
    const version = currentVersion(cache);
    if (!version || !ordinaryPath(path.join(cache, "versions"), true)) return undefined;
    return nativeAt(path.join(cache, "versions", version));
  }
  return nativeAt(data);
}

function rotateAccessLog(filePath) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }
  if (size < ACCESS_LOG_MAX_BYTES) return;
  for (let generation = ACCESS_LOG_ROTATE_COUNT; generation >= 1; generation -= 1) {
    const from = generation === 1 ? filePath : `${filePath}.${generation - 1}`;
    const to = `${filePath}.${generation}`;
    try {
      fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
    } catch {
      // A missing generation is normal.
    }
  }
}

const ACCESS_SECRET_PATTERNS = [
  [/\bLTAI[A-Za-z0-9]{12,}\b/g, "[ACCESSKEY_MASKED]"],
  [/\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, "[ACCESSKEY_MASKED]"],
  [/\bAKID[A-Za-z0-9]{13,}\b/g, "[ACCESSKEY_MASKED]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[APIKEY_MASKED]"],
  [/\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[APIKEY_MASKED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATEKEY_MASKED]"],
  [/\b(?:mysql|postgres|postgresql|mongodb|redis):\/\/[^:\s'"]+:[^@\s'"]+@[^\s'"]+/gi, "[DATABASEURL_MASKED]"],
  [/\bjdbc:(?:mysql|postgresql):\/\/[^\s'"]*(?:password|pwd)=[^\s'"]+/gi, "[DATABASEURL_MASKED]"],
];

export function redactAccessValue(value) {
  if (typeof value === "string") {
    let next = value;
    for (const [pattern, replacement] of ACCESS_SECRET_PATTERNS) {
      next = next.replace(pattern, replacement);
    }
    return next;
  }
  if (Array.isArray(value)) return value.map(redactAccessValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = redactAccessValue(child);
    return out;
  }
  return value;
}

function restrictAccessLogPermissions(dir, filePath) {
  if (process.platform === "win32") return;
  try { fs.chmodSync(dir, 0o700); } catch { /* logging must not change the verdict */ }
  if (!filePath) return;
  try { fs.chmodSync(filePath, 0o600); } catch { /* file may not exist until append */ }
}

function writeFailOpen(dataDir, request, error) {
  try {
    const dest = interceptorAccessLogPath(dataDir);
    const dir = path.dirname(dest);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    restrictAccessLogPermissions(dir);
    const entry = redactAccessValue({
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
    });
    let line = JSON.stringify(entry);
    if (line.length > ACCESS_LOG_MAX_CHARS) {
      line = JSON.stringify({
        ...entry,
        input: { cwd: request.cwd, rawText: "<truncated>" },
      });
    }
    rotateAccessLog(dest);
    fs.appendFileSync(dest, `${line}\n`, "utf8");
    restrictAccessLogPermissions(dir, dest);
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
    execFileImpl: execFile,
    execPath: process.execPath,
    env: process.env,
    ...overrides,
  };

  function currentRuntime() {
    return readRuntime(interceptorRuntimePath(deps.resolveDataDir()));
  }

  const postToolCache = new Map();

  function postToolCacheScope(request, event, ctx, dataDir) {
    if (request.event !== "PostToolUse") return undefined;
    const eventToolId = sharedIdentifier(event?.toolCallId, event?.message?.toolCallId);
    const toolId = eventToolId === null ? null : sharedIdentifier(eventToolId, ctx?.toolCallId);
    const sessionKey = sharedIdentifier(event?.sessionKey, ctx?.sessionKey);
    const sessionId = sharedIdentifier(event?.sessionId, ctx?.sessionId);
    const runId = sharedIdentifier(ctx?.runId, event?.message?.__openclaw?.runId);
    if (!toolId || sessionKey === null || sessionId === null || runId === null || !(sessionKey || sessionId)) {
      return undefined;
    }
    const key = JSON.stringify([dataDir, sessionKey ? "key" : "id", sessionKey ?? sessionId, toolId, request.toolName]);
    return { key, runId, sessionId, sessionKey };
  }

  function postToolAuditKey(request, scope, input) {
    if (!scope?.sessionKey || !scope.runId || !request.toolName) return undefined;
    try {
      if (Buffer.byteLength(input) > SDK_HOOK_REQUEST_MAX_BYTES) return undefined;
      const result = JSON.parse(input).tool_response;
      if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
      const hook = request.raw.openclaw_hook;
      let isError = request.raw.isError ?? false;
      if (hook === "tool_result_persist") {
        // The Gateway attaches the owning run before calling the transcript
        // hook. Only these verified message fields are the host wrapper.
        if (request.raw.isSynthetic !== false || result.role !== "toolResult"
          || result.toolName !== request.toolName || result.toolCallId !== request.toolUseId
          || !Number.isSafeInteger(result.timestamp) || typeof result.isError !== "boolean"
          || result.__openclaw?.runId !== scope.runId) return undefined;
        isError = result.isError;
        delete result.role;
        delete result.toolName;
        delete result.toolCallId;
        delete result.timestamp;
        delete result.isError;
        delete result.__openclaw.runId;
        if (Object.keys(result.__openclaw).length === 0) delete result.__openclaw;
      } else if (hook !== SAME_TURN_POST_TOOL_HOOK || !scope.sessionId || typeof isError !== "boolean") {
        return undefined;
      }
      // Only the audit writer sees this correlation. Both policy evaluations
      // still receive the original full input, including args and metadata.
      return createHash("sha256")
        .update(JSON.stringify([scope.key, scope.runId, request.cwd, request.prompt, isError, result]))
        .digest("hex");
    } catch {
      return undefined;
    }
  }

  function readPostToolCache(request, scope) {
    if (!scope || request.raw.openclaw_hook !== "tool_result_persist") return { miss: true };
    const { key, runId, sessionId } = scope;
    const hit = postToolCache.get(key);
    if (!hit) return { miss: true };
    if (Date.now() - hit.ts > POST_TOOL_CACHE_TTL_MS) {
      postToolCache.delete(key);
      return { miss: true };
    }
    if (hit.sessionId && sessionId && hit.sessionId !== sessionId) return { miss: true };
    if (hit.runId && runId && hit.runId !== runId) return { miss: true };
    postToolCache.delete(key);
    postToolCache.set(key, hit);
    return { result: openClawBlockResult(request, hit.reason) };
  }

  function rememberPostToolBlock(scope, reason) {
    if (!scope || (reason != null && typeof reason !== "string")) return;
    if (postToolCache.size >= POST_TOOL_CACHE_MAX) {
      const oldest = postToolCache.keys().next().value;
      postToolCache.delete(oldest);
    }
    postToolCache.set(scope.key, { ts: Date.now(), sessionId: scope.sessionId, runId: scope.runId, reason });
  }

  async function evaluateAsync(request, runtime, scope) {
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
        writeFailOpen(deps.resolveDataDir(), request, "daemon identity mismatch");
        return undefined;
      }
      if (health.version !== runtime.version || health.pid !== runtime.pid) {
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
        return undefined;
      }
      rememberPostToolBlock(scope, verdict.reason);
      return openClawBlockResult(request, verdict.reason);
    } catch (err) {
      writeFailOpen(deps.resolveDataDir(), request, err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  function toCliPayload(request) {
    return {
      hook_event_name: request.event,
      openclaw_hook: request.raw?.openclaw_hook,
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
    const cli = resolveCli(dataDir, deps);
    if (!cli) {
      writeFailOpen(dataDir, request, "interceptor cli missing");
      return undefined;
    }
    const result = deps.spawnSyncImpl(cli.binary, cli.args, {
      input: JSON.stringify(toCliPayload(request)),
      encoding: "utf8",
      timeout: INTERCEPTOR_HOOK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...deps.env, LOONGSUITE_PILOT_DATA_DIR: path.resolve(expandHome(dataDir)) },
    });
    if (result.error || (!cli.legacyScript && result.status !== 0)) {
      writeFailOpen(dataDir, request, result.error?.message || `interceptor cli exited ${result.status}`);
      return undefined;
    }
    const text = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      writeFailOpen(dataDir, request, "invalid interceptor cli stdout");
      return undefined;
    }
  }

  function evaluateSdk(request, sync, dataDir, scope) {
    const stateDir = path.resolve(expandHome(dataDir), "state", "standalone-openclaw-interceptor-sdk");
    const native = resolveCli(dataDir, deps);
    if (!native || native.legacyScript) return { available: false };
    if (!ordinaryPath(path.join(stateDir, "sdk-hooks-local.json"))) {
      return { available: true };
    }
    const binary = path.join(path.dirname(native.binary), process.platform === "win32"
      ? "loongsuite-pilot-sdk-hook.exe" : "loongsuite-pilot-sdk-hook");
    if (!ordinaryPath(binary)) {
      writeFailOpen(dataDir, request, "SDK Hook is missing");
      return { available: true };
    }
    const args = ["sdk-hook", "--channel", "local", "--agent", "openclaw",
      "--event", request.event, "--data-dir", stateDir];
    let input = JSON.stringify(toCliPayload(request));
    const auditKey = postToolAuditKey(request, scope, input);
    if (auditKey) {
      const metadata = `,"openclaw_post_tool_audit_key":"${auditKey}"`;
      // Preserve the exact policy bytes. Optional audit metadata must fit
      // inside the native request limit without re-evaluating user objects.
      if (Buffer.byteLength(input) + Buffer.byteLength(metadata) <= SDK_HOOK_REQUEST_MAX_BYTES) {
        input = `${input.slice(0, -1)}${metadata}}`;
      }
    }
    const options = {
      encoding: "utf8",
      timeout: INTERCEPTOR_HOOK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 32 * 1024,
      env: deps.env,
    };
    function verdict(error, stdout) {
      if (error) {
        writeFailOpen(dataDir, request, error.message);
        return undefined;
      }
      if (!stdout?.trim()) return undefined;
      try {
        const result = JSON.parse(stdout);
        if (result.action === "block") {
          if (request.raw.openclaw_hook === SAME_TURN_POST_TOOL_HOOK) rememberPostToolBlock(scope, result.reason);
          return openClawBlockResult(request, result.reason);
        }
      } catch {
        writeFailOpen(dataDir, request, "invalid SDK Hook stdout");
      }
      return undefined;
    }
    if (sync) {
      const result = deps.spawnSyncImpl(binary, args, { ...options, input });
      const error = result.error || (result.status !== 0
        ? new Error(`SDK Hook exited ${result.status}`) : undefined);
      return { available: true, result: verdict(error, result.stdout) };
    }
    const result = new Promise((resolve) => {
      const child = deps.execFileImpl(binary, args, options, (error, stdout) => {
        resolve(verdict(error, stdout));
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
    return { available: true, result };
  }

  function evaluate(hookName, event, ctx, opts = {}) {
    const request = buildHookRequest(hookName, event, ctx, opts.cwd);
    if (!request) return undefined;
    const dataDir = deps.resolveDataDir();
    const scope = postToolCacheScope(request, event, ctx, dataDir);
    const cached = readPostToolCache(request, scope);
    if (!cached.miss) return cached.result;
    const sync = opts.sync || SYNC_INTERCEPT_HOOKS.has(hookName);
    const sdk = evaluateSdk(request, sync, dataDir, scope);
    if (sdk.available) return sdk.result;
    const runtime = currentRuntime();
    if (!runtime) {
      return undefined;
    }
    if (sync) {
      return evaluateSync(request);
    }
    return evaluateAsync(request, runtime, scope);
  }

  return { evaluate, buildHookRequest, currentRuntime };
}

const defaultInterceptor = createOpenClawInterceptor();

export function evaluateInterceptor(hookName, event, ctx, opts = {}) {
  return defaultInterceptor.evaluate(hookName, event, ctx, opts);
}
