import { createLogger } from '../utils/logger.js';
import { appendLine, ensureDir } from '../utils/fs-utils.js';
import * as path from 'node:path';

const logger = createLogger('SlsTransport');

export const WEBTRACKING_TIMEOUT_MS = 10_000;
export const WEBTRACKING_MAX_BODY_BYTES = 2_800_000;
export const WEBTRACKING_MAX_LOGS = 4096;
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000;

export const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const SLS_FAILURE_REASON_MAX_LENGTH = 240;

export type SlsFailureClass =
  | 'network_timeout'
  | 'network_refused'
  | 'quota_throttle'
  | 'auth_failed'
  | 'permission_denied'
  | 'not_found'
  | 'server_error'
  | 'bad_request'
  | 'payload_too_large'
  | 'unknown';

export interface SlsFailureDiagnostics {
  failure_class: SlsFailureClass;
  status_code?: number;
  retryable: boolean;
  reason: string;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
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
  return classifySlsFailure(err).retryable;
}

export function extractEndpointHost(endpoint: string): string {
  const raw = endpoint.trim();
  if (!raw) return '';
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(candidate).hostname;
  } catch {
    return '';
  }
}

export function classifySlsFailure(err: unknown): SlsFailureDiagnostics {
  const statusCode = extractStatusCode(err);
  const text = extractFailureText(err);
  const lower = text.toLowerCase();
  const failureClass = classifyByStatus(statusCode) ?? classifyByText(lower);
  const retryable = isRetryableFailure(failureClass, statusCode, lower);

  return {
    failure_class: failureClass,
    ...(statusCode === undefined ? {} : { status_code: statusCode }),
    retryable,
    reason: sanitizeFailureReason(text || 'unknown error'),
  };
}

export function sanitizeFailureReason(reason: string): string {
  const redacted = reason
    .replace(/\s+/g, ' ')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
      try {
        const url = new URL(match);
        return `[url:${url.hostname}]`;
      } catch {
        return '[url:redacted]';
      }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(access[-_]?key(?:id|secret)?|accessKeyId|accessKeySecret|securityToken|authorization|signature|password|secret|token)\b["']?\s*[:=]\s*["']?[^"',\s&}\]]+/gi, '$1=[REDACTED]')
    .replace(/\b(?:AKIA|LTAI)[A-Z0-9]{12,}\b/gi, '[ACCESS_KEY_REDACTED]')
    .trim();

  if (redacted.length <= SLS_FAILURE_REASON_MAX_LENGTH) return redacted;
  return `${redacted.slice(0, SLS_FAILURE_REASON_MAX_LENGTH - 3)}...`;
}

function extractStatusCode(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.status;
  if (!err || typeof err !== 'object') return undefined;

  const record = err as Record<string, unknown>;
  for (const key of ['statusCode', 'status', 'httpStatusCode']) {
    const raw = record[key];
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  }
  return undefined;
}

function extractFailureText(err: unknown): string {
  if (err instanceof HttpError) {
    return `HTTP ${err.status}: ${err.body}`;
  }
  if (!err || typeof err !== 'object') return String(err);

  const record = err as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['name', 'code', 'statusCode', 'status', 'message']) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') {
      parts.push(`${key}=${String(value)}`);
    }
  }
  if (parts.length > 0) return parts.join(' ');
  return String(err);
}

function classifyByStatus(statusCode?: number): SlsFailureClass | undefined {
  if (statusCode === undefined) return undefined;
  if (statusCode === 408) return 'network_timeout';
  if (statusCode === 401) return 'auth_failed';
  if (statusCode === 403) return 'permission_denied';
  if (statusCode === 404) return 'not_found';
  if (statusCode === 413) return 'payload_too_large';
  if (statusCode === 429) return 'quota_throttle';
  if (statusCode >= 500 && statusCode <= 599) return 'server_error';
  if (statusCode >= 400 && statusCode <= 499) return 'bad_request';
  return 'unknown';
}

function classifyByText(lower: string): SlsFailureClass {
  if (
    lower.includes('aborterror') ||
    lower.includes('timeouterror') ||
    lower.includes('etimedout') ||
    lower.includes('timeout')
  ) return 'network_timeout';
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up') ||
    lower.includes('network')
  ) return 'network_refused';
  if (
    lower.includes('throttl') ||
    lower.includes('quota') ||
    lower.includes('serverbusy')
  ) return 'quota_throttle';
  if (
    lower.includes('invalidaccesskey') ||
    lower.includes('signature') ||
    lower.includes('unauthorized')
  ) return 'auth_failed';
  if (
    lower.includes('accessdenied') ||
    lower.includes('forbidden') ||
    lower.includes('permission')
  ) return 'permission_denied';
  if (
    lower.includes('notfound') ||
    lower.includes('not found') ||
    lower.includes('logstorenotexist') ||
    lower.includes('projectnotexist')
  ) return 'not_found';
  if (
    lower.includes('payloadtoolarge') ||
    lower.includes('entity too large') ||
    lower.includes('request body too large')
  ) return 'payload_too_large';
  if (
    lower.includes('internalservererror') ||
    lower.includes('internal server error') ||
    lower.includes('serviceunavailable')
  ) return 'server_error';
  return 'unknown';
}

function isRetryableFailure(
  _failureClass: SlsFailureClass,
  statusCode: number | undefined,
  lower: string,
): boolean {
  if (statusCode !== undefined) return RETRYABLE_STATUS_CODES.has(statusCode);
  return (
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('econnrefused') ||
    lower.includes('socket hang up') ||
    lower.includes('network') ||
    lower.includes('timeouterror') ||
    lower.includes('internalservererror') ||
    lower.includes('serverbusy')
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
  logGroup: unknown,
  err: unknown,
): Promise<void> {
  await ensureDir(failedLogDir);
  const fileName = `${name}.jsonl`;
  const filePath = path.join(failedLogDir, fileName);
  const line = JSON.stringify({
    ts: Date.now(),
    name,
    logGroup,
    error: String(err),
  });
  await appendLine(filePath, line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
