import { createHmac } from 'node:crypto';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('SlsClient');

const SLS_API_VERSION = '0.6.0';

export interface SlsPutObjectParams {
  endpoint: string;
  project: string;
  logstore: string;
  objectKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  body: Buffer;
  contentType: string;
  timeoutMs: number;
  meta?: Record<string, string>;
}

export interface SlsPutObjectResult {
  ok: boolean;
  statusCode?: number;
  requestId?: string;
  error?: string;
  retryable?: boolean;
}

interface SlsEndpoint {
  scheme: string;
  host: string;
}

/**
 * Minimal SLS PutObject client (Auth V1 / LOG ak:hmac-sha1).
 * Independent from SlsFlusher / @alicloud/log.
 */
export async function slsPutObject(params: SlsPutObjectParams): Promise<SlsPutObjectResult> {
  try {
    const endpoint = normalizeSlsEndpoint(params.endpoint);
    const project = params.project.trim();
    const logstore = params.logstore.trim();
    const objectKey = normalizeObjectKey(params.objectKey);
    if (!project || !logstore) {
      throw new Error('SLS project and logstore are required');
    }

    const { url, headers } = buildV1PutRequest({
      endpoint,
      project,
      logstore,
      objectKey,
      accessKeyId: params.accessKeyId.trim(),
      accessKeySecret: params.accessKeySecret.trim(),
      securityToken: params.securityToken?.trim() || undefined,
      contentType: params.contentType || 'application/octet-stream',
      bodyLength: params.body.length,
      meta: params.meta,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers,
        body: params.body,
        signal: controller.signal,
        redirect: 'manual',
      });
      const requestId =
        resp.headers.get('x-log-requestid')
        ?? resp.headers.get('x-log-request-id')
        ?? undefined;
      if (resp.status === 200) {
        return { ok: true, statusCode: resp.status, requestId };
      }
      const text = await resp.text();
      const error = `${resp.status} ${text}`;
      const retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
      logger.warn('sls putObject non-200', { statusCode: resp.status, requestId, error });
      return {
        ok: false,
        statusCode: resp.status,
        requestId,
        error,
        retryable,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
  }
}

/** Parse sls://project/logstore (no object-key prefix). */
export function parseSlsStorageBasePath(storageBasePath: string): {
  project: string;
  logstore: string;
} {
  let path = (storageBasePath || '').trim();
  if (path.startsWith('sls://')) path = path.slice('sls://'.length);
  path = path.replace(/^\/+/, '');
  const parts = path.split('/');
  const project = parts[0] ?? '';
  const logstore = parts[1] ?? '';
  if (!project || !logstore) {
    throw new Error(`invalid sls storageBasePath: ${storageBasePath}`);
  }
  return { project, logstore };
}

export function tryParseSlsStorageBasePath(storageBasePath: string): {
  project: string;
  logstore: string;
} | null {
  try {
    return parseSlsStorageBasePath(storageBasePath);
  } catch {
    return null;
  }
}

/** Exported for unit tests (deterministic signing). */
export function buildV1PutRequest(args: {
  endpoint: SlsEndpoint;
  project: string;
  logstore: string;
  objectKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  contentType: string;
  bodyLength: number;
  meta?: Record<string, string>;
  now?: Date;
}): { url: string; headers: Record<string, string> } {
  if (!args.accessKeyId || !args.accessKeySecret) {
    throw new Error('SLS access key ID and secret are required');
  }

  const encodedKey = objectNameEncode(args.objectKey);
  const resource = `/logstores/${args.logstore}/objects/${encodedKey}`;
  const host = `${args.project}.${args.endpoint.host}`;
  const url = `${args.endpoint.scheme}://${host}${resource}`;
  const date = (args.now ?? new Date()).toUTCString();

  const headers: Record<string, string> = {
    Host: host,
    Date: date,
    'Content-Type': args.contentType,
    'Content-Length': String(args.bodyLength),
    'User-Agent': 'loongsuite-pilot-multimodal-sls/1.0',
    'x-log-apiversion': SLS_API_VERSION,
    'x-log-bodyrawsize': String(args.bodyLength),
    'x-log-signaturemethod': 'hmac-sha1',
  };
  if (args.securityToken) {
    headers['x-acs-security-token'] = args.securityToken;
  }
  Object.assign(headers, metadataHeaders(args.meta));

  // Auth V1 PutObject: Content-MD5 is omitted from the signature and request headers.
  const stringToSign = [
    'PUT',
    '', // empty Content-MD5
    headers['Content-Type'] ?? '',
    headers.Date,
    `${canonicalizedLogHeaders(headers)}${resource}`,
  ].join('\n');

  const signature = createHmac('sha1', args.accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('base64');
  headers.Authorization = `LOG ${args.accessKeyId}:${signature}`;
  // Set after signing; not part of the signature.
  headers['x-log-date'] = headers.Date;

  return { url, headers };
}

export function normalizeSlsEndpoint(endpoint: string): SlsEndpoint {
  let raw = (endpoint || '').trim();
  if (!raw) throw new Error('SLS endpoint is required');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  const parsed = new URL(raw);
  if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/')
    || parsed.search || parsed.hash) {
    throw new Error('SLS endpoint must not include path, query, or credentials');
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const port = parsed.port ? `:${parsed.port}` : '';
  return {
    scheme: parsed.protocol.replace(':', ''),
    host: `${host}${port}`,
  };
}

function normalizeObjectKey(objectKey: string): string {
  const key = objectKey.replace(/^\/+/, '');
  if (!key) throw new Error('SLS object key is required');
  if (key.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('SLS object key must not contain dot segments');
  }
  return key;
}

/** Percent-encode object key; keep `/` and unreserved `-_.~`. */
function objectNameEncode(objectKey: string): string {
  return encodeURIComponent(objectKey)
    .replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/gi, '~')
    .replace(/%2F/g, '/');
}

/** Canonicalize signed headers: x-acs-* and x-log-* except x-log-meta-*. */
function canonicalizedLogHeaders(headers: Record<string, string>): string {
  const items: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-acs-')
      || (lower.startsWith('x-log-') && !lower.startsWith('x-log-meta-'))) {
      items.push([lower, String(value)]);
    }
  }
  items.sort((a, b) => a[0].localeCompare(b[0]));
  return items.map(([name, value]) => `${name}:${value}\n`).join('');
}

function metadataHeaders(meta?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(meta ?? {})) {
    const normalized = String(name).trim().toLowerCase().replace(/_/g, '-');
    if (!normalized || !/^[a-z0-9-]+$/.test(normalized)) continue;
    headers[`x-log-meta-${normalized}`] = String(value).trim().slice(0, 256);
  }
  return headers;
}
