import { createLogger } from '../utils/logger.js';
import {
  SlsFailureLogWriter,
  type SlsFailureLogInput,
} from './sls-failure-log-writer.js';

const logger = createLogger('SlsTransport');

export const WEBTRACKING_TIMEOUT_MS = 10_000;
export const WEBTRACKING_MAX_BODY_BYTES = 2_800_000;
export const WEBTRACKING_MAX_LOGS = 4096;
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000;

export const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`${status} ${body}`);
  }
}

export interface SlsTransportConfig {
  endpoint: string;
  project: string;
  logstore: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export interface PostWebtrackingOptions {
  topic?: string;
  source?: string;
  tags?: Record<string, string>;
  userAgent?: string;
}

export type PersistFailedLogContext = Omit<SlsFailureLogInput, 'endpoint' | 'error'>;

const failedLogWriters = new Map<string, SlsFailureLogWriter>();

export function splitForWebtracking(
  logs: Record<string, string>[],
  maxLogs = WEBTRACKING_MAX_LOGS,
  maxBytes = WEBTRACKING_MAX_BODY_BYTES,
): Record<string, string>[][] {
  const chunks: Record<string, string>[][] = [];
  let current: Record<string, string>[] = [];
  let currentSize = 0;

  for (const log of logs) {
    const logSize = Buffer.byteLength(JSON.stringify(log));

    if (
      current.length > 0 &&
      (current.length >= maxLogs || currentSize + logSize > maxBytes)
    ) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }

    current.push(log);
    currentSize += logSize;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return RETRYABLE_STATUS_CODES.has(err.status);
  const msg = String(err);
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('TimeoutError') ||
    msg.includes('InternalServerError') ||
    msg.includes('ServerBusy')
  );
}

export async function postWebtracking(
  config: SlsTransportConfig,
  logs: Record<string, string>[],
  opts?: PostWebtrackingOptions,
): Promise<void> {
  const chunks = splitForWebtracking(logs);
  for (const chunk of chunks) {
    await postWebtrackingChunk(config, chunk, opts);
  }
}

async function postWebtrackingChunk(
  config: SlsTransportConfig,
  logs: Record<string, string>[],
  opts?: PostWebtrackingOptions,
): Promise<void> {
  const body = {
    __topic__: opts?.topic ?? '',
    __source__: opts?.source ?? '',
    __logs__: logs,
    __tags__: opts?.tags ?? ({} as Record<string, string>),
  };

  const raw = JSON.stringify(body);
  const base = config.endpoint.replace(
    /^(https?:\/\/)/,
    `$1${config.project}.`,
  );
  const url = `${base}/logstores/${config.logstore}/track`;

  const maxRetries = config.maxRetries ?? RETRY_MAX_ATTEMPTS;
  const retryBaseDelay = config.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  const timeoutMs = config.timeoutMs ?? WEBTRACKING_TIMEOUT_MS;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'x-log-apiversion': '0.6.0',
          'x-log-bodyrawsize': String(Buffer.byteLength(raw)),
          'Content-Type': 'application/json',
          ...(opts?.userAgent ? { 'user-agent': opts.userAgent } : {}),
        },
        body: raw,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!resp.ok) {
        const text = await resp.text();
        const err = new HttpError(resp.status, text);
        if (
          !RETRYABLE_STATUS_CODES.has(resp.status) ||
          attempt === maxRetries - 1
        ) {
          throw err;
        }
        lastErr = err;
      } else {
        logger.debug('batch sent via webtracking', {
          project: config.project,
          logstore: config.logstore,
          count: logs.length,
        });
        return;
      }
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && !RETRYABLE_STATUS_CODES.has(err.status))
        break;
      if (attempt === maxRetries - 1) break;
    }

    const delay = retryBaseDelay * 2 ** attempt;
    logger.warn('SLS webtracking retrying', {
      attempt: attempt + 1,
      delayMs: delay,
      error: String(lastErr),
    });
    await sleep(delay);
  }

  throw lastErr;
}

export async function persistFailedLogs(
  failedLogDir: string,
  name: string,
  context: PersistFailedLogContext,
  err: unknown,
): Promise<void> {
  let writer = failedLogWriters.get(failedLogDir);
  if (!writer) {
    writer = new SlsFailureLogWriter(failedLogDir);
    failedLogWriters.set(failedLogDir, writer);
  }
  await writer.write({
    ...context,
    endpoint: name,
    error: err,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
