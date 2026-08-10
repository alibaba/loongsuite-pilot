import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildV1PutRequest,
  normalizeSlsEndpoint,
  parseSlsStorageBasePath,
  slsPutObject,
  tryParseSlsStorageBasePath,
} from '../../../src/multimodal/uploader/sls-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sls-client (SLS Auth V1 PutObject)', () => {
  it('normalizes endpoint host', () => {
    expect(normalizeSlsEndpoint('https://cn-hangzhou.log.aliyuncs.com')).toEqual({
      scheme: 'https',
      host: 'cn-hangzhou.log.aliyuncs.com',
    });
    expect(normalizeSlsEndpoint('cn-shanghai.log.aliyuncs.com').host).toBe(
      'cn-shanghai.log.aliyuncs.com',
    );
  });

  it('parses sls://project/logstore (no prefix)', () => {
    expect(parseSlsStorageBasePath('sls://proj/logstore-multimodal')).toEqual({
      project: 'proj',
      logstore: 'logstore-multimodal',
    });
    // Extra path segments after logstore are ignored.
    expect(parseSlsStorageBasePath('sls://proj/logstore-multimodal/pilot-mm/')).toEqual({
      project: 'proj',
      logstore: 'logstore-multimodal',
    });
  });

  it('builds LOG hmac-sha1 Authorization without Content-MD5', () => {
    const endpoint = normalizeSlsEndpoint('https://cn-hangzhou.log.aliyuncs.com');
    const { url, headers } = buildV1PutRequest({
      endpoint,
      project: 'example-project',
      logstore: 'logstore-multimodal',
      objectKey: 'arms/a b.png',
      accessKeyId: 'AKIDEXAMPLE',
      accessKeySecret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      contentType: 'image/png',
      bodyLength: 3,
      meta: { mime_type: 'image/png', some_key: 'v' },
      now: new Date('2026-07-29T01:02:03Z'),
    });

    expect(url).toBe(
      'https://example-project.cn-hangzhou.log.aliyuncs.com/logstores/logstore-multimodal/objects/arms/a%20b.png',
    );
    expect(headers['Content-MD5']).toBeUndefined();
    expect(headers['x-log-apiversion']).toBe('0.6.0');
    expect(headers['x-log-signaturemethod']).toBe('hmac-sha1');
    expect(headers['x-log-meta-mime-type']).toBe('image/png');
    expect(headers['x-log-meta-some-key']).toBe('v');
    expect(headers['x-log-date']).toBe(headers.Date);
    // Golden Authorization locks signing inputs (resource, signed headers, empty MD5).
    expect(headers.Authorization).toBe('LOG AKIDEXAMPLE:sWmDOSzZSQVzknzC7djUd1duY6U=');
  });

  it('includes security token header when provided', () => {
    const endpoint = normalizeSlsEndpoint('https://cn-hangzhou.log.aliyuncs.com');
    const { headers } = buildV1PutRequest({
      endpoint,
      project: 'p',
      logstore: 'l',
      objectKey: 'k.png',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      securityToken: 'sts-token',
      contentType: 'image/png',
      bodyLength: 1,
      now: new Date('2026-08-05T00:00:00Z'),
    });
    expect(headers['x-acs-security-token']).toBe('sts-token');
    expect(headers.Authorization).toMatch(/^LOG ak:[A-Za-z0-9+/=]+$/);
  });

  it('rejects invalid storageBasePath', () => {
    expect(() => parseSlsStorageBasePath('')).toThrow(/invalid sls storageBasePath/);
    expect(() => parseSlsStorageBasePath('sls://only-project')).toThrow(/invalid sls storageBasePath/);
    expect(() => parseSlsStorageBasePath('proj')).toThrow(/invalid sls storageBasePath/);
    expect(tryParseSlsStorageBasePath('sls://only-project')).toBeNull();
    expect(tryParseSlsStorageBasePath('sls://proj/logstore')).toEqual({
      project: 'proj',
      logstore: 'logstore',
    });
  });

  it('rejects empty endpoint or endpoint with path/query/credentials', () => {
    expect(() => normalizeSlsEndpoint('')).toThrow(/SLS endpoint is required/);
    expect(() => normalizeSlsEndpoint('https://cn-hangzhou.log.aliyuncs.com/extra')).toThrow(
      /must not include path, query, or credentials/,
    );
    expect(() => normalizeSlsEndpoint('https://user:pass@cn-hangzhou.log.aliyuncs.com')).toThrow(
      /must not include path, query, or credentials/,
    );
  });

  it('rejects missing access keys when building the request', () => {
    const endpoint = normalizeSlsEndpoint('https://cn-hangzhou.log.aliyuncs.com');
    expect(() => buildV1PutRequest({
      endpoint,
      project: 'p',
      logstore: 'l',
      objectKey: 'k.png',
      accessKeyId: '',
      accessKeySecret: 'sk',
      contentType: 'image/png',
      bodyLength: 1,
    })).toThrow(/access key ID and secret are required/);
    expect(() => buildV1PutRequest({
      endpoint,
      project: 'p',
      logstore: 'l',
      objectKey: 'k.png',
      accessKeyId: 'ak',
      accessKeySecret: '',
      contentType: 'image/png',
      bodyLength: 1,
    })).toThrow(/access key ID and secret are required/);
  });

  it('returns non-retryable failure for missing project/logstore or bad object key (no network)', async () => {
    const missingProject = await slsPutObject({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: '',
      logstore: 'l',
      objectKey: '20260101/abc.png',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });
    expect(missingProject.ok).toBe(false);
    expect(missingProject.retryable).toBe(false);
    expect(missingProject.error).toMatch(/project and logstore are required/);

    const dotKey = await slsPutObject({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: 'a/../b.png',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });
    expect(dotKey.ok).toBe(false);
    expect(dotKey.retryable).toBe(false);
    expect(dotKey.error).toMatch(/must not contain dot segments/);

    const emptyKey = await slsPutObject({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: '/',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });
    expect(emptyKey.ok).toBe(false);
    expect(emptyKey.retryable).toBe(false);
    expect(emptyKey.error).toMatch(/object key is required/);
  });

  it('aborts hung PUT after timeoutMs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));

    const put = slsPutObject({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: '20260101/abc.png',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    const result = await put;
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toMatch(/aborted/i);
  });
});
