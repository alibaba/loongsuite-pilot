const MAX_CAUSE_DEPTH = 5;
const SAFE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const CONNECTION_RESET_CODES = new Set(['ECONNRESET']);
const CONNECTION_REFUSED_CODES = new Set(['ECONNREFUSED']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'TimeoutError',
  'AbortError',
]);
const ROUTE_CODES = new Set(['ENETUNREACH', 'EHOSTUNREACH']);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
]);
const PROXY_CODES = new Set([
  'UND_ERR_PROXY',
  'ERR_HTTP_PROXY_CONNECT',
  'ERR_PROXY_CONNECTION_FAILED',
]);

export type SlsSendErrorCategory =
  | 'quota'
  | 'dns'
  | 'connection_reset'
  | 'connection_refused'
  | 'timeout'
  | 'route'
  | 'tls'
  | 'proxy'
  | 'http'
  | 'unknown';

export interface SlsSendErrorClassification {
  category: SlsSendErrorCategory;
  code: string;
  httpStatus: number;
  detail: string;
}

interface ExtractedEvidence {
  code: string;
  httpStatus: number;
  name: string;
  message: string;
  detail: string;
}

/** Extract diagnostic evidence without making retry decisions. */
export function classifySlsSendError(error: unknown): SlsSendErrorClassification {
  const evidence = extractEvidence(error);
  const code = evidence.code || (evidence.httpStatus === 0
    ? codeFromLegacyMessage(evidence.message) || codeFromErrorName(evidence.name)
    : '');

  return {
    category: categoryForCode(code, evidence.httpStatus, evidence.name),
    code: code || (evidence.httpStatus ? `HTTP_${evidence.httpStatus}` : 'UNKNOWN'),
    httpStatus: evidence.httpStatus,
    detail: evidence.detail,
  };
}

export function formatSlsSendFailureMessage(
  transport: string,
  classification: SlsSendErrorClassification,
  attempts: number,
): string {
  const safeTransport = transport === 'ak' || transport === 'apiKey' || transport === 'webtracking'
    ? transport
    : 'unknown';
  const safeAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  const status = classification.httpStatus > 0
    ? ` status=${classification.httpStatus}`
    : '';
  const detail = classification.detail
    ? ` error=${JSON.stringify(classification.detail)}`
    : '';
  return `SLS ${safeTransport} send failed [category=${classification.category} code=${classification.code}${status} attempts=${safeAttempts}]${detail}`;
}

function extractEvidence(error: unknown): ExtractedEvidence {
  let code = '';
  let httpStatus = 0;
  let name = '';
  let message = '';
  const detailParts: string[] = [];
  let current: unknown = error;
  const visited = new Set<object>();

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null || visited.has(current)) break;
    visited.add(current);
    const value = current as Record<string, unknown>;
    try {
      const currentName = typeof value.name === 'string' ? value.name : '';
      const currentMessage = typeof value.message === 'string' ? value.message : '';
      if (!name && currentName) name = currentName;
      if (!message && currentMessage) message = currentMessage;
      if (currentMessage) {
        const part = currentName ? `${currentName}: ${currentMessage}` : currentMessage;
        if (detailParts.at(-1) !== part) detailParts.push(part);
      }
      if (!httpStatus) {
        httpStatus = normalizeHttpStatus(value.status) || normalizeHttpStatus(value.statusCode);
      }
      if (!code) {
        code = normalizeCode(value.errorCode) || normalizeCode(value.code);
      }
      if (!code && typeof value.body === 'string') {
        code = structuredCodeFromBody(value.body);
      }

      current = value.cause;
    } catch {
      break;
    }
  }

  if (!message) message = safeErrorString(error);
  const detail = detailParts.join(' <- ') || safeErrorString(error);
  return { code, httpStatus, name, message, detail };
}

function structuredCodeFromBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return '';
    const value = parsed as Record<string, unknown>;
    return normalizeCode(value.errorCode) || normalizeCode(value.code);
  } catch {
    return '';
  }
}

function normalizeCode(value: unknown): string {
  return typeof value === 'string' && SAFE_CODE_PATTERN.test(value) ? value : '';
}

function normalizeHttpStatus(value: unknown): number {
  const status = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{3}$/.test(value)
      ? Number(value)
      : 0;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function safeErrorString(value: unknown): string {
  try {
    return typeof value === 'string' ? value : String(value ?? '');
  } catch {
    return '';
  }
}

function categoryForCode(code: string, httpStatus: number, name: string): SlsSendErrorCategory {
  if (httpStatus === 429) return 'quota';
  if (DNS_CODES.has(code)) return 'dns';
  if (CONNECTION_RESET_CODES.has(code)) return 'connection_reset';
  if (CONNECTION_REFUSED_CODES.has(code)) return 'connection_refused';
  if (TIMEOUT_CODES.has(code) || name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (ROUTE_CODES.has(code)) return 'route';
  if (TLS_CODES.has(code)) return 'tls';
  if (PROXY_CODES.has(code) || httpStatus === 407) return 'proxy';
  if (httpStatus > 0 || code === 'InternalServerError' || code === 'ServerBusy') return 'http';
  return 'unknown';
}

function codeFromLegacyMessage(message: string): string {
  const candidates = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'TimeoutError',
    'InternalServerError',
    'ServerBusy',
  ];
  for (const candidate of candidates) {
    if (message.includes(candidate)) return candidate;
  }
  if (message.includes('socket hang up')) return 'ECONNRESET';
  if (message.includes('network')) return 'NETWORK_ERROR';
  return '';
}

function codeFromErrorName(name: string): string {
  return name === 'TimeoutError' || name === 'AbortError' ? name : '';
}
