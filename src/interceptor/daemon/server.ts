import * as http from 'node:http';
import { RuleEngine } from '../rules/engine.js';
import {
  INTERCEPTOR_SERVICE,
  type EvaluateHookResponse,
  type HookRequest,
  type InterceptorHealth,
} from '../types.js';

export interface InterceptorServerOptions {
  port: number;
  version: string;
  engine: RuleEngine;
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
      const request = await readJson<HookRequest>(req);
      if (!isHookRequest(request)) {
        writeJson(res, 400, { error: 'invalid-request' });
        return;
      }
      const verdict = await opts.engine.evaluate(request);
      writeJson(res, 200, verdict satisfies EvaluateHookResponse);
      return;
    }
    writeJson(res, 404, { error: 'not-found' });
  } catch {
    writeJson(res, 500, { error: 'internal' });
  }
}

function isHookRequest(value: unknown): value is HookRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const req = value as HookRequest;
  return (req.event === 'UserPromptSubmit' || req.event === 'PreToolUse')
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
