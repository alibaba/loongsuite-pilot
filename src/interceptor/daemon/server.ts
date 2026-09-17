import * as http from 'node:http';
import {
  accessInputFromHookRequest,
  accessInputFromPayload,
  buildAccessLogEntry,
  writeInterceptorAccessLog,
  type InterceptorAccessLogEntry,
} from '../access-log.js';
import { RuleEngine } from '../rules/engine.js';
import {
  INTERCEPTOR_SERVICE,
  SUPPORTED_HOOK_EVENTS,
  type EvaluateHookResponse,
  type HookRequest,
  type InterceptorHealth,
} from '../types.js';

export interface InterceptorServerOptions {
  port: number;
  version: string;
  engine: RuleEngine;
  writeAccessLog?: (entry: InterceptorAccessLogEntry) => void;
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
      const verdict = await opts.engine.evaluate(request);
      recordAccess(opts, {
        event: request.event,
        agent: request.agent,
        sessionId: request.sessionId,
        input: accessInputFromHookRequest(request),
        result: {
          action: verdict.action,
          reason: verdict.reason,
          ruleId: verdict.ruleId,
          evaluatedRules: verdict.evaluatedRules,
        },
      });
      writeJson(res, 200, verdict satisfies EvaluateHookResponse);
      return;
    }
    writeJson(res, 404, { error: 'not-found' });
  } catch (err) {
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

function isHookRequest(value: unknown): value is HookRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const req = value as HookRequest;
  return (SUPPORTED_HOOK_EVENTS as readonly string[]).includes(req.event)
    && (req.agent === 'qoder' || req.agent === 'qodercli');
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
