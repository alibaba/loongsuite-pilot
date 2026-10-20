import { INTERCEPTOR_HOOK_TIMEOUT_MS, INTERCEPTOR_SERVICE } from '../types.js';
import type { EvaluateHookResponse, HookRequest, InterceptorHealth } from '../types.js';

export class DaemonClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DaemonClientError';
  }
}

export class DaemonClient {
  constructor(private readonly port: number) {}

  async checkHook(request: HookRequest): Promise<EvaluateHookResponse> {
    const body = await this.doJson<EvaluateHookResponse>(
      '/v1/hooks/evaluate',
      request,
      INTERCEPTOR_HOOK_TIMEOUT_MS,
    );
    if (body.action !== 'allow' && body.action !== 'block') {
      throw new DaemonClientError('invalid-response', `unknown action ${JSON.stringify(body.action)}`);
    }
    return body;
  }

  async health(timeoutMs = 200): Promise<InterceptorHealth> {
    const body = await this.doJson<InterceptorHealth>('/health', undefined, timeoutMs, 'GET');
    if (body.service !== INTERCEPTOR_SERVICE || body.status !== 'ok') {
      throw new DaemonClientError('invalid-response', 'health identity does not match');
    }
    if (!Number.isInteger(body.pid) || body.pid <= 0) {
      throw new DaemonClientError('invalid-response', 'health pid is invalid');
    }
    if (body.daemon_port !== this.port) {
      throw new DaemonClientError('invalid-response', 'health port does not match');
    }
    return body;
  }

  private async doJson<T>(
    pathname: string,
    body: unknown,
    timeoutMs: number,
    method: 'GET' | 'POST' = body === undefined ? 'GET' : 'POST',
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status < 200 || response.status > 299) {
        throw new DaemonClientError('non-2xx-response', `daemon ${pathname}: HTTP ${response.status}`);
      }
      return parseSingleJson<T>(await response.text());
    } catch (err) {
      if (err instanceof DaemonClientError) throw err;
      throw new DaemonClientError('unavailable', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseSingleJson<T>(text: string): T {
  const trimmed = text.trim();
  if (!trimmed) throw new DaemonClientError('invalid-response', 'empty JSON response');
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new DaemonClientError('invalid-response', 'invalid JSON response');
  }
}
