import { createHmac, createHash } from 'node:crypto';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('OssClient');

const OSS_V4_ALGORITHM = 'OSS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const DEFAULT_SIGNED_HEADERS = new Set(['content-md5', 'content-type']);
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const REGIONAL_ENDPOINT_RE = /^oss-(?<region>[a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com(?:\.cn)?$/;

export interface OssPutObjectParams {
  endpoint: string;
  bucket: string;
  objectKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  body: Buffer;
  contentType: string;
  timeoutMs: number;
  meta?: Record<string, string>;
  signal?: AbortSignal;
}

export interface OssPutObjectResult {
  ok: boolean;
  statusCode?: number;
  requestId?: string;
  error?: string;
  retryable?: boolean;
}

interface OssEndpoint {
  scheme: string;
  host: string;
  region: string;
}

/** OSS PutObject (V4). */
export async function ossPutObject(params: OssPutObjectParams): Promise<OssPutObjectResult> {
  try {
    const endpoint = normalizeOssEndpoint(params.endpoint);
    const bucket = validateBucket(params.bucket);
    const objectKey = normalizeObjectKey(params.objectKey);
    const { url, headers } = buildV4PutRequest({
      endpoint,
      bucket,
      objectKey,
      accessKeyId: params.accessKeyId.trim(),
      accessKeySecret: params.accessKeySecret.trim(),
      securityToken: params.securityToken?.trim() || undefined,
      contentType: params.contentType || 'application/octet-stream',
      meta: params.meta,
    });

    if (params.signal?.aborted) {
      return { ok: false, error: 'aborted', retryable: false };
    }
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    params.signal?.addEventListener('abort', onExternalAbort);
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers,
        body: params.body,
        signal: controller.signal,
        redirect: 'manual',
      });
      const requestId = resp.headers.get('x-oss-request-id') ?? undefined;
      if (resp.status >= 200 && resp.status < 300) {
        return { ok: true, statusCode: resp.status, requestId };
      }
      const retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
      logger.debug('oss putObject non-200', { statusCode: resp.status, requestId });
      return {
        ok: false,
        statusCode: resp.status,
        requestId,
        error: `oss putObject status ${resp.status}`,
        retryable,
      };
    } catch (err) {
      if (params.signal?.aborted) {
        return { ok: false, error: 'aborted', retryable: false };
      }
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error, retryable: true };
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onExternalAbort);
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
  }
}

export function parseOssStorageBasePath(storageBasePath: string): { bucket: string; prefix: string } {
  const match = storageBasePath.match(/^oss:\/\/([^/]+)(?:\/(.*))?$/);
  if (!match) {
    throw new Error(`invalid oss storageBasePath: ${storageBasePath}`);
  }
  return {
    bucket: match[1]!,
    prefix: (match[2] ?? '').replace(/^\/+|\/+$/g, ''),
  };
}

/** For tests (deterministic signing). */
export function buildV4PutRequest(args: {
  endpoint: OssEndpoint;
  bucket: string;
  objectKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  contentType: string;
  meta?: Record<string, string>;
  now?: Date;
}): { url: string; headers: Record<string, string> } {
  if (!args.accessKeyId || !args.accessKeySecret) {
    throw new Error('OSS access key ID and secret are required');
  }

  const now = args.now ?? new Date();
  const dateTime = toOssDateTime(now);
  const date = dateTime.slice(0, 8);

  // Omit Content-MD5 / Content-Length from signed headers.
  const headers: Record<string, string> = {
    'Content-Type': args.contentType,
    'User-Agent': 'loongsuite-pilot-multimodal-oss/1.0',
    'x-oss-content-sha256': UNSIGNED_PAYLOAD,
    'x-oss-date': dateTime,
  };
  if (args.securityToken) {
    headers['x-oss-security-token'] = args.securityToken;
  }
  Object.assign(headers, metadataHeaders(args.meta));

  const canonicalUri = v4UriEncode(`/${args.bucket}/${args.objectKey}`, true);
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders(headers),
    '',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const credentialScope = `${date}/${args.endpoint.region}/oss/aliyun_v4_request`;
  const stringToSign = [
    OSS_V4_ALGORITHM,
    dateTime,
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const signature = createHmac('sha256', signingKey(args.accessKeySecret, date, args.endpoint.region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  headers.Authorization = `${OSS_V4_ALGORITHM} Credential=${args.accessKeyId}/${credentialScope}, Signature=${signature}`;

  const encodedKey = v4UriEncode(args.objectKey, true);
  const url = `${args.endpoint.scheme}://${args.bucket}.${args.endpoint.host}/${encodedKey}`;
  return { url, headers };
}

export function normalizeOssEndpoint(endpoint: string): OssEndpoint {
  let raw = (endpoint || '').trim();
  if (!raw) throw new Error('OSS endpoint is required');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  const parsed = new URL(raw);
  if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/')
    || parsed.search || parsed.hash) {
    throw new Error('OSS endpoint must be a standard regional endpoint without path/query/credentials');
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('oss-accelerate.')) {
    throw new Error('OSS accelerate endpoints are not supported');
  }
  const match = REGIONAL_ENDPOINT_RE.exec(host);
  const region = match?.groups?.region;
  if (!region) {
    throw new Error('OSS endpoint must be a standard regional aliyuncs.com endpoint');
  }

  const port = parsed.port ? `:${parsed.port}` : '';
  return {
    scheme: parsed.protocol.replace(':', ''),
    host: `${host}${port}`,
    region,
  };
}

function validateBucket(bucket: string): string {
  const normalized = bucket.trim();
  if (!BUCKET_RE.test(normalized)) {
    throw new Error(`Invalid OSS bucket name: ${normalized}`);
  }
  return normalized;
}

function normalizeObjectKey(objectKey: string): string {
  const key = objectKey.replace(/^\/+/, '');
  if (!key) throw new Error('OSS object key is required');
  if (key.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('OSS object key must not contain dot segments');
  }
  return key;
}

function v4UriEncode(value: string, keepSlashes: boolean): string {
  let encoded = encodeURIComponent(value)
    .replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/gi, '~');
  if (keepSlashes) encoded = encoded.replace(/%2F/g, '/');
  return encoded;
}

function canonicalHeaders(headers: Record<string, string>): string {
  const items: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-oss-') || DEFAULT_SIGNED_HEADERS.has(lower)) {
      items.push([lower, String(value).trim()]);
    }
  }
  items.sort((a, b) => a[0].localeCompare(b[0]));
  return items.map(([name, value]) => `${name}:${value}\n`).join('');
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const dateKey = createHmac('sha256', `aliyun_v4${secret}`).update(date, 'utf8').digest();
  const regionKey = createHmac('sha256', dateKey).update(region, 'utf8').digest();
  const productKey = createHmac('sha256', regionKey).update('oss', 'utf8').digest();
  return createHmac('sha256', productKey).update('aliyun_v4_request', 'utf8').digest();
}

function metadataHeaders(meta?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(meta ?? {})) {
    const normalized = String(name).trim().toLowerCase().replace(/_/g, '-');
    if (!normalized || !/^[a-z0-9-]+$/.test(normalized)) continue;
    headers[`x-oss-meta-${normalized}`] = String(value).trim().slice(0, 256);
  }
  return headers;
}

function toOssDateTime(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}
