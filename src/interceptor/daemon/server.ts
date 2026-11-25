import * as http from 'node:http';
import type { AgentActivityEntry } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';
import {
  accessInputFromHookRequest,
  accessInputFromPayload,
  buildAccessLogEntry,
  writeInterceptorAccessLog,
  type InterceptorAccessLogEntry,
} from '../access-log.js';
import { parseQwenWorkHookRequest, qwenWorkAllowBody, qwenWorkBlockBody } from '../adapters/qwenwork.js';
import { buildBlockedQoderPromptEntry } from '../blocked-prompt.js';
import { guardrailSnapshotFromVerdict, hostBlockDetail } from '../guardrail.js';
import { promptKeyFromRequest } from '../prompt-verdict.js';
import {
  INTERCEPTOR_SERVICE,
  SUPPORTED_HOOK_EVENTS,
  isInterceptorAgent,
  type EvaluateHookResponse,
  type HookEvaluator,
  type HookRequest,
  type InterceptorHealth,
} from '../types.js';
import {
  isToolInterceptPhase,
  type ToolVerdictAction,
  type ToolVerdictKey,
  type ToolVerdictSnapshot,
  type PromptVerdictKey,
  type PromptVerdictSnapshot,
} from '../tool-verdict-store.js';

const logger = createLogger('InterceptorServer');
const MAX_HOOK_BODY_BYTES = 5 * 1024 * 1024;

class HookBodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'HookBodyTooLargeError';
  }
}

export interface InterceptorServerOptions {
  port: number;
  version: string;
  engine: HookEvaluator;
  writeAccessLog?: (entry: InterceptorAccessLogEntry) => void;
  writeToolVerdict?: (key: ToolVerdictKey, snapshot: ToolVerdictSnapshot) => void;
  writePromptVerdict?: (key: PromptVerdictKey, snapshot: PromptVerdictSnapshot) => void;
  /** Async sink for a denied Qoder UserPromptSubmit. Must not affect the host response. */
  emitBlockedPrompt?: (entry: AgentActivityEntry, signal?: AbortSignal) => void | Promise<void>;
}

export function createInterceptorServer(opts: InterceptorServerOptions): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res, opts);
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: InterceptorServerOptions,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      const body: InterceptorHealth = {
        service: INTERCEPTOR_SERVICE,
        status: 'ok',
        pid: process.pid,
        version: opts.version,
        daemon_port: opts.port,
      };
      writeJson(res, 200, body);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/hooks/qwenwork') {
      await handleQwenWorkHttp(req, res, opts);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/hooks/evaluate') {
      const body = await readJson<unknown>(req);
      if (!isHookRequest(body)) {
        recordAccess(opts, {
          event: isRecord(body) && typeof body.event === 'string' ? body.event : 'unknown',
          agent: isRecord(body) && typeof body.agent === 'string' ? body.agent : undefined,
          input: isRecord(body) ? accessInputFromPayload(body) : { raw: body },
          result: { action: 'fail-open', error: 'invalid-request' },
        });
        writeJson(res, 400, { error: 'invalid-request' });
        return;
      }
      const request = body;
      const promptKey = beginPromptEvaluation(opts, request);
      const verdict = await opts.engine.evaluate(request);
      recordToolVerdict(opts, request, verdict.failOpen && verdict.matched !== true ? 'unknown' : verdict.action, verdict);
      recordPromptVerdict(opts, promptKey, verdict);
      recordAccess(opts, {
        event: request.event,
        agent: request.agent,
        sessionId: request.sessionId,
        toolUseId: request.toolUseId,
        input: accessInputFromHookRequest(request),
        result: { ...verdict },
      });
      writeJson(res, 200, verdict satisfies EvaluateHookResponse);
      emitBlockedPrompt(opts, request, verdict);
      return;
    }
    writeJson(res, 404, { error: 'not-found' });
  } catch (err) {
    if (err instanceof HookBodyTooLargeError) {
      recordAccess(opts, {
        event: 'unknown',
        input: {},
        result: { action: 'fail-open', error: err.message },
      });
      writeJson(res, 200, {
        action: 'allow',
        evaluatedRules: [],
        failOpen: true,
      } satisfies EvaluateHookResponse);
      req.destroy();
      return;
    }
    recordAccess(opts, {
      event: 'unknown',
      input: {},
      result: {
        action: 'fail-open',
        error: err instanceof Error ? err.message : 'internal',
      },
    });
    writeJson(res, 500, { error: 'internal' });
  }
}

async function handleQwenWorkHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: InterceptorServerOptions,
): Promise<void> {
  // QwenWork: HTTP 2xx + invalid JSON fail-closes PreToolUse. Fail-open must be 200 {}.
  let body: unknown;
  try {
    body = await readJson<unknown>(req);
  } catch (err) {
    recordAccess(opts, {
      event: 'unknown',
      agent: 'qwen-work-cn',
      input: {},
      result: {
        action: 'fail-open',
        error: err instanceof Error ? err.message : 'invalid-json',
      },
    });
    writeJson(res, 200, qwenWorkAllowBody());
    if (err instanceof HookBodyTooLargeError) req.destroy();
    return;
  }

  const payload = isRecord(body) ? body : null;
  const request = payload ? parseQwenWorkHookRequest(payload) : null;
  if (!request) {
    recordAccess(opts, {
      event: payload && typeof payload.hook_event_name === 'string'
        ? payload.hook_event_name
        : 'unknown',
      agent: 'qwen-work-cn',
      input: payload ? accessInputFromPayload(payload) : { raw: body },
      result: { action: 'fail-open', error: 'unsupported hook event' },
    });
    writeJson(res, 200, qwenWorkAllowBody());
    return;
  }

  const promptKey = beginPromptEvaluation(opts, request);
  try {
    const verdict = await opts.engine.evaluate(request);
    recordToolVerdict(opts, request, verdict.failOpen && verdict.matched !== true ? 'unknown' : verdict.action, verdict);
    recordPromptVerdict(opts, promptKey, verdict);
    recordAccess(opts, {
      event: request.event,
      agent: request.agent,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      input: accessInputFromHookRequest(request),
      result: { ...verdict },
    });
    if (verdict.action !== 'block') {
      writeJson(res, 200, qwenWorkAllowBody());
      return;
    }
    writeJson(res, 200, qwenWorkBlockBody(request, hostBlockDetail(verdict.message, verdict.reason)));
    emitBlockedPrompt(opts, request, verdict);
  } catch (err) {
    recordToolVerdict(opts, request, 'unknown');
    recordAccess(opts, {
      event: request.event,
      agent: request.agent,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      input: accessInputFromHookRequest(request),
      result: {
        action: 'fail-open',
        error: err instanceof Error ? err.message : 'internal',
      },
    });
    writeJson(res, 200, qwenWorkAllowBody());
  }
}

function emitBlockedPrompt(
  opts: InterceptorServerOptions,
  request: HookRequest,
  verdict: EvaluateHookResponse,
): void {
  if (!opts.emitBlockedPrompt) return;
  if (verdict.failOpen || verdict.action !== 'block') return;
  if (request.event !== 'UserPromptSubmit') return;
  if (!['qoder', 'qodercli', 'qoder-cn', 'qoderclicn'].includes(request.agent)) return;
  try {
    void Promise.resolve(opts.emitBlockedPrompt(buildBlockedQoderPromptEntry(request, Date.now(), verdict)))
      .catch(err => logger.warn('blocked prompt emit failed', { error: String(err) }));
  } catch (err) {
    logger.warn('blocked prompt emit failed', { error: String(err) });
  }
}

function beginPromptEvaluation(opts: InterceptorServerOptions, request: HookRequest): PromptVerdictKey | null {
  if (!opts.writePromptVerdict || request.event !== 'UserPromptSubmit') return null;
  const key = promptKeyFromRequest(request);
  if (key) {
    try { opts.writePromptVerdict(key, { action: 'unknown' }); }
    catch { /* Verdict observation must never affect the host response. */ }
  }
  return key;
}

function recordPromptVerdict(opts: InterceptorServerOptions, key: PromptVerdictKey | null, verdict: EvaluateHookResponse): void {
  // The pending marker remains for failures and blocked prompts: neither owns a native request.
  if (!opts.writePromptVerdict || verdict.action !== 'allow'
    || (verdict.failOpen && verdict.matched !== true)) return;
  if (!key) return;
  try { opts.writePromptVerdict(key, guardrailSnapshotFromVerdict(verdict)); }
  catch { /* Verdict observation must never affect the host response. */ }
}

function recordToolVerdict(
  opts: InterceptorServerOptions,
  request: HookRequest,
  result: ToolVerdictAction | 'unknown',
  verdict?: EvaluateHookResponse,
): void {
  if (!opts.writeToolVerdict || !request.toolUseId || !isToolInterceptPhase(request.event)) return;
  if (result !== 'allow' && result !== 'block') return;
  try {
    opts.writeToolVerdict({
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      phase: request.event,
    }, verdict
      ? guardrailSnapshotFromVerdict(verdict)
      : { action: result });
  } catch {
    // Verdict persistence must never affect the host response.
  }
}

function isHookRequest(value: unknown): value is HookRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const req = value as HookRequest;
  return (SUPPORTED_HOOK_EVENTS as readonly string[]).includes(req.event)
    && isInterceptorAgent(req.agent);
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buf.length;
    if (received > MAX_HOOK_BODY_BYTES) {
      throw new HookBodyTooLargeError();
    }
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function recordAccess(
  opts: InterceptorServerOptions,
  partial: Omit<InterceptorAccessLogEntry, 'ts'>,
): void {
  try {
    const write = opts.writeAccessLog ?? writeInterceptorAccessLog;
    write(buildAccessLogEntry(partial));
  } catch {
    // Access logs must never affect the HTTP verdict.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
