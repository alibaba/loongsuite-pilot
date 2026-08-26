import { createHash, createHmac } from 'node:crypto';
import type { MultimodalRuntimeConfig } from '../types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('SlsClient');

const SLS_API_VERSION = '0.6.0';
const RFC822_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const RFC822_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export interface SlsAuthAk {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
}

export interface SlsAuthApiKey {
  apiKey: string;
}

export type SlsObjectAuth = SlsAuthAk | SlsAuthApiKey;

export interface SlsObjectTarget {
  endpoint: string;
  project: string;
  logstore: string;
  objectKey: string;
  mode?: 'ak' | 'apiKey';
  accessKeyId?: string;
  accessKeySecret?: string;
  securityToken?: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface SlsPutObjectParams extends SlsObjectTarget {
  body: Buffer;
  contentType: string;
  meta?: Record<string, string>;
}

export interface SlsPutObjectResult {
  ok: boolean;
  statusCode?: number;
  requestId?: string;
  error?: string;
  retryable?: boolean;
}

export interface SlsPresignResult extends SlsPutObjectResult {
  url?: string;
}

export interface SlsEndpoint {
  scheme: string;
  host: string;
}

interface SlsHttpResult {
  ok: boolean;
  statusCode?: number;
  requestId?: string;
  error?: string;
  retryable?: boolean;
  text?: string;
}

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

/** RFC822 GMT, e.g. Wed, 19 Aug 2026 05:53:26 GMT. Required for ApiKey writes. */
export function formatRfc822Gmt(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${RFC822_WEEKDAYS[date.getUTCDay()]}, ${day} ${RFC822_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${hh}:${mm}:${ss} GMT`;
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

export function resolveSlsObjectAuth(params: {
  mode?: 'ak' | 'apiKey';
  accessKeyId?: string;
  accessKeySecret?: string;
  securityToken?: string;
  apiKey?: string;
}): { kind: 'ak' } & SlsAuthAk | { kind: 'apiKey' } & SlsAuthApiKey {
  const apiKey = params.apiKey?.trim() ?? '';
  const accessKeyId = params.accessKeyId?.trim() ?? '';
  const accessKeySecret = params.accessKeySecret?.trim() ?? '';
  const securityToken = params.securityToken?.trim() || undefined;
  if (params.mode === 'apiKey') {
    if (!apiKey) throw new Error('SLS apiKey is required');
    return { kind: 'apiKey', apiKey };
  }
  if (params.mode === 'ak') {
    if (!accessKeyId || !accessKeySecret) {
      throw new Error('SLS access key ID and secret are required');
    }
    return { kind: 'ak', accessKeyId, accessKeySecret, ...(securityToken ? { securityToken } : {}) };
  }
  throw new Error('SLS auth mode is required');
}

function prepareSlsObjectTarget(params: SlsObjectTarget): {
  endpoint: SlsEndpoint;
  project: string;
  logstore: string;
  objectKey: string;
  auth: ReturnType<typeof resolveSlsObjectAuth>;
} {
  const project = params.project.trim();
  const logstore = params.logstore.trim();
  if (!project || !logstore) {
    throw new Error('SLS project and logstore are required');
  }
  return {
    endpoint: normalizeSlsEndpoint(params.endpoint),
    project,
    logstore,
    objectKey: normalizeObjectKey(params.objectKey),
    auth: resolveSlsObjectAuth(params),
  };
}

function failClosed(err: unknown): SlsPutObjectResult {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}

function slsObjectResource(logstore: string, objectKey: string): string {
  return `/logstores/${logstore}/objects/${objectNameEncode(objectKey)}`;
}

function objectNameEncode(objectKey: string): string {
  return encodeURIComponent(objectKey)
    .replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/gi, '~')
    .replace(/%2F/g, '/');
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

function normalizeObjectKey(objectKey: string): string {
  const key = objectKey.replace(/^\/+/, '');
  if (!key) throw new Error('SLS object key is required');
  if (key.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('SLS object key must not contain dot segments');
  }
  return key;
}

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

export function buildBearerJsonRequest(args: {
  endpoint: SlsEndpoint;
  project: string;
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  resource: string;
  apiKey: string;
  contentType?: string;
  body?: Buffer;
  bodyLength?: number;
  extraHeaders?: Record<string, string>;
  now?: Date;
}): { url: string; headers: Record<string, string> } {
  if (!args.apiKey) {
    throw new Error('SLS apiKey is required');
  }
  const host = `${args.project}.${args.endpoint.host}`;
  const url = `${args.endpoint.scheme}://${host}${args.resource}`;
  const date = formatRfc822Gmt(args.now ?? new Date());
  const bodyLength = args.body?.length ?? args.bodyLength ?? 0;
  const headers: Record<string, string> = {
    Host: host,
    Date: date,
    'x-log-date': date,
    Authorization: `Bearer ${args.apiKey}`,
    'User-Agent': 'loongsuite-pilot-multimodal-sls/1.0',
    'x-log-apiversion': SLS_API_VERSION,
    'x-log-bodyrawsize': String(bodyLength),
    ...(args.extraHeaders ?? {}),
  };
  if (args.method !== 'GET' && args.method !== 'DELETE') {
    headers['Content-Type'] = args.contentType || (args.body ? 'application/json' : 'application/octet-stream');
    headers['Content-Length'] = String(bodyLength);
  }
  return { url, headers };
}

export function buildLogV1JsonRequest(args: {
  endpoint: SlsEndpoint;
  project: string;
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  resource: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  body?: Buffer;
  contentType?: string;
  contentMd5?: string;
  bodyLength?: number;
  extraHeaders?: Record<string, string>;
  now?: Date;
}): { url: string; headers: Record<string, string> } {
  if (!args.accessKeyId || !args.accessKeySecret) {
    throw new Error('SLS access key ID and secret are required');
  }

  const host = `${args.project}.${args.endpoint.host}`;
  const url = `${args.endpoint.scheme}://${host}${args.resource}`;
  const date = (args.now ?? new Date()).toUTCString();
  const contentMd5 = args.contentMd5
    ?? (args.body ? createHash('md5').update(args.body).digest('hex').toUpperCase() : '');
  const contentType = args.contentType ?? (args.body ? 'application/json' : '');
  const bodyLength = args.bodyLength ?? args.body?.length;

  const headers: Record<string, string> = {
    Host: host,
    Date: date,
    'User-Agent': 'loongsuite-pilot-multimodal-sls/1.0',
    'x-log-apiversion': SLS_API_VERSION,
    'x-log-bodyrawsize': String(bodyLength ?? 0),
    'x-log-signaturemethod': 'hmac-sha1',
    ...(args.extraHeaders ?? {}),
  };
  if (contentType) headers['Content-Type'] = contentType;
  if (bodyLength !== undefined) headers['Content-Length'] = String(bodyLength);
  if (contentMd5) headers['Content-MD5'] = contentMd5;
  if (args.securityToken) headers['x-acs-security-token'] = args.securityToken;

  const stringToSign = [
    args.method,
    contentMd5,
    contentType,
    headers.Date,
    `${canonicalizedLogHeaders(headers)}${args.resource}`,
  ].join('\n');

  const signature = createHmac('sha1', args.accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('base64');
  headers.Authorization = `LOG ${args.accessKeyId}:${signature}`;
  headers['x-log-date'] = headers.Date;
  return { url, headers };
}

async function slsHttpRequest(args: {
  url: string;
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
}): Promise<SlsHttpResult & { body?: Buffer }> {
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    return { ok: false, error: 'SLS request timeoutMs must be a positive number', retryable: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const resp = await fetch(args.url, {
      method: args.method,
      headers: args.headers,
      body: args.body,
      signal: controller.signal,
      redirect: 'manual',
    });
    const requestId =
      resp.headers.get('x-log-requestid')
      ?? resp.headers.get('x-log-request-id')
      ?? resp.headers.get('x-oss-request-id')
      ?? undefined;
    const body = Buffer.from(await resp.arrayBuffer());
    const text = body.length ? body.toString('utf8') : '';
    if (resp.status === 200 || resp.status === 204) {
      return { ok: true, statusCode: resp.status, requestId, text, body };
    }
    const error = `${resp.status} ${text || `${body.length}b`}`;
    const retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
    logger.warn('sls request non-200', { statusCode: resp.status, requestId, error, method: args.method });
    return {
      ok: false,
      statusCode: resp.status,
      requestId,
      error,
      retryable,
      text,
      body,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/** SLS PutObject via AK Auth V1 or ApiKey Bearer. */
export async function slsPutObject(params: SlsPutObjectParams): Promise<SlsPutObjectResult> {
  try {
    const prepared = prepareSlsObjectTarget(params);
    const contentType = params.contentType || 'application/octet-stream';
    const resource = slsObjectResource(prepared.logstore, prepared.objectKey);
    const { url, headers } = prepared.auth.kind === 'apiKey'
      ? buildBearerJsonRequest({
        endpoint: prepared.endpoint,
        project: prepared.project,
        method: 'PUT',
        resource,
        apiKey: prepared.auth.apiKey,
        contentType,
        bodyLength: params.body.length,
        extraHeaders: metadataHeaders(params.meta),
      })
      : buildLogV1JsonRequest({
        endpoint: prepared.endpoint,
        project: prepared.project,
        method: 'PUT',
        resource,
        accessKeyId: prepared.auth.accessKeyId,
        accessKeySecret: prepared.auth.accessKeySecret,
        securityToken: prepared.auth.securityToken,
        contentType,
        bodyLength: params.body.length,
        extraHeaders: metadataHeaders(params.meta),
      });

    return await slsHttpRequest({
      url,
      method: 'PUT',
      headers,
      body: params.body,
      timeoutMs: params.timeoutMs,
    });
  } catch (err) {
    return failClosed(err);
  }
}

/** POST /logstores/{logstore}/presign. Pilot only signs PUT. */
export async function slsGeneratePresignedUrl(params: SlsObjectTarget): Promise<SlsPresignResult> {
  try {
    const prepared = prepareSlsObjectTarget(params);
    const body = Buffer.from(JSON.stringify({ key: prepared.objectKey, method: 'PUT' }), 'utf8');
    const { url, headers } = prepared.auth.kind === 'apiKey'
      ? buildBearerJsonRequest({
        endpoint: prepared.endpoint,
        project: prepared.project,
        method: 'POST',
        resource: `/logstores/${prepared.logstore}/presign`,
        apiKey: prepared.auth.apiKey,
        body,
      })
      : buildLogV1JsonRequest({
        endpoint: prepared.endpoint,
        project: prepared.project,
        method: 'POST',
        resource: `/logstores/${prepared.logstore}/presign`,
        accessKeyId: prepared.auth.accessKeyId,
        accessKeySecret: prepared.auth.accessKeySecret,
        securityToken: prepared.auth.securityToken,
        body,
      });

    const result = await slsHttpRequest({
      url,
      method: 'POST',
      headers,
      body,
      timeoutMs: params.timeoutMs,
    });
    if (!result.ok) return result;

    const presignedUrl = parsePresignedUrl(result.text);
    if (!presignedUrl) {
      return {
        ok: false,
        statusCode: result.statusCode,
        requestId: result.requestId,
        error: 'presign response missing url',
        retryable: false,
      };
    }
    return { ...result, url: presignedUrl };
  } catch (err) {
    return failClosed(err);
  }
}

/** PUT bytes to a presigned URL (no extra auth headers). */
export async function slsPutPresignedObject(params: {
  url: string;
  body: Buffer;
  timeoutMs: number;
}): Promise<SlsPutObjectResult> {
  try {
    if (!params.url.trim()) throw new Error('presigned URL is required');
    return await slsHttpRequest({
      url: params.url,
      method: 'PUT',
      headers: {},
      body: params.body,
      timeoutMs: params.timeoutMs,
    });
  } catch (err) {
    return failClosed(err);
  }
}

/** ApiKey/AK presign PUT, then upload to the returned URL with no extra headers. */
export async function slsPutViaPresignedHttp(params: SlsPutObjectParams): Promise<SlsPutObjectResult> {
  const presign = await slsGeneratePresignedUrl(params);
  if (!presign.ok || !presign.url) return presign;
  return slsPutPresignedObject({
    url: presign.url,
    body: params.body,
    timeoutMs: params.timeoutMs,
  });
}

function parsePresignedUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const url = pickString(parsed, 'url', 'Url', 'URL');
    return url && /^https?:\/\//i.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Startup-only sniff. Shorter than upload timeout so a hung presign does not stall start. */
export const SLS_HTTP_STORAGE_SNIFF_TIMEOUT_MS = 5_000;
export const SLS_HTTP_STORAGE_PROBE_KEY = '_pilot/storage-probe';

/** Virtual-hosted OSS host → bucket. Does not log or return query credentials. */
export function parseOssBucketFromPresignedUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const match = parsed.hostname.toLowerCase().match(/^(.+?)\.oss[-.]/i);
    const bucket = match?.[1]?.trim() ?? '';
    return bucket || null;
  } catch {
    return null;
  }
}

export function buildSlsHttpEventStorageBasePath(args: {
  ossBucket: string;
  project: string;
  logstore: string;
}): string {
  const ossBucket = args.ossBucket.trim();
  const project = args.project.trim();
  const logstore = args.logstore.trim();
  if (!ossBucket || !project || !logstore) {
    throw new Error('oss bucket, project, and logstore are required');
  }
  return `oss://${ossBucket}/${project}/${logstore}`;
}

/** Presign once to learn the landing bucket. Never PUTs. Failure is fail-closed. */
export async function sniffSlsHttpEventStorageBasePath(
  params: Omit<SlsObjectTarget, 'objectKey' | 'timeoutMs'> & { timeoutMs?: number },
): Promise<{ ok: true; storageBasePath: string } | { ok: false; error: string }> {
  const timeoutMs = params.timeoutMs ?? SLS_HTTP_STORAGE_SNIFF_TIMEOUT_MS;
  const presign = await slsGeneratePresignedUrl({
    ...params,
    objectKey: SLS_HTTP_STORAGE_PROBE_KEY,
    timeoutMs,
  });
  if (!presign.ok || !presign.url) {
    return { ok: false, error: presign.error || 'presign failed' };
  }
  const bucket = parseOssBucketFromPresignedUrl(presign.url);
  if (!bucket) {
    return { ok: false, error: 'presign url missing oss bucket' };
  }
  try {
    return {
      ok: true,
      storageBasePath: buildSlsHttpEventStorageBasePath({
        ossBucket: bucket,
        project: params.project,
        logstore: params.logstore,
      }),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Event URI prefix for Processor. Uploader keeps config.storageBasePath (sls://).
 * writeVia=http sniffs one presign; timeout or error → fail-closed (no processor).
 */
export async function resolveMultimodalEventStorageBasePath(
  config: MultimodalRuntimeConfig,
): Promise<{ ok: true; storageBasePath: string } | { ok: false; error: string }> {
  if (config.uploader !== 'sls' || config.sls?.writeVia !== 'http') {
    const storageBasePath = (config.storageBasePath ?? '').trim();
    if (!storageBasePath) {
      return { ok: false, error: 'multimodal storageBasePath is required' };
    }
    return { ok: true, storageBasePath };
  }

  const sls = config.sls;
  return sniffSlsHttpEventStorageBasePath({
    endpoint: sls.endpoint,
    project: sls.project,
    logstore: sls.logstore,
    mode: sls.auth.mode,
    accessKeyId: sls.auth.accessKeyId,
    accessKeySecret: sls.auth.accessKeySecret,
    securityToken: sls.auth.securityToken,
    apiKey: sls.auth.apiKey,
    timeoutMs: SLS_HTTP_STORAGE_SNIFF_TIMEOUT_MS,
  });
}
