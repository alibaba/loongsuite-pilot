import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildV4PutRequest,
  normalizeOssEndpoint,
  ossPutObject,
  parseOssStorageBasePath,
} from '../../../src/multimodal/uploader/oss-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('oss-client (OSS V4)', () => {
  it('derives region from regional endpoint host', () => {
    expect(normalizeOssEndpoint('https://oss-cn-shanghai.aliyuncs.com')).toEqual({
      scheme: 'https',
      host: 'oss-cn-shanghai.aliyuncs.com',
      region: 'cn-shanghai',
    });
    expect(normalizeOssEndpoint('oss-cn-hangzhou.aliyuncs.com').region).toBe('cn-hangzhou');
  });

  it('parses oss:// storage base path', () => {
    expect(parseOssStorageBasePath('oss://bucket/pilot-mm/')).toEqual({
      bucket: 'bucket',
      prefix: 'pilot-mm',
    });
  });

  it('builds OSS4-HMAC-SHA256 Authorization without Content-MD5', () => {
    const endpoint = normalizeOssEndpoint('https://oss-cn-shanghai.aliyuncs.com');
    const { url, headers } = buildV4PutRequest({
      endpoint,
      bucket: 'example-bucket',
      objectKey: 'arms/a b.png',
      accessKeyId: 'AKIDEXAMPLE',
      accessKeySecret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      contentType: 'image/png',
      meta: { mime_type: 'image/png', some_key: 'v' },
      now: new Date('2026-07-29T01:02:03Z'),
    });

    expect(url).toBe('https://example-bucket.oss-cn-shanghai.aliyuncs.com/arms/a%20b.png');
    expect(headers['x-oss-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(headers['x-oss-date']).toBe('20260729T010203Z');
    expect(headers['Content-MD5']).toBeUndefined();
    expect(headers['x-oss-meta-mime-type']).toBe('image/png');
    expect(headers['x-oss-meta-some-key']).toBe('v');
    expect(headers.Authorization).toMatch(/^OSS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260729\/cn-shanghai\/oss\/aliyun_v4_request, Signature=[0-9a-f]{64}$/);
  });

  it('includes security token header when provided', () => {
    const endpoint = normalizeOssEndpoint('https://oss-cn-hangzhou.aliyuncs.com');
    const { headers } = buildV4PutRequest({
      endpoint,
      bucket: 'bkt',
      objectKey: 'k.png',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      securityToken: 'sts-token',
      contentType: 'image/png',
      now: new Date('2026-08-05T00:00:00Z'),
    });
    expect(headers['x-oss-security-token']).toBe('sts-token');
    expect(headers.Authorization).toContain('OSS4-HMAC-SHA256');
  });

  it('rejects invalid storageBasePath', () => {
    expect(() => parseOssStorageBasePath('s3://bucket/mm')).toThrow(/invalid oss storageBasePath/);
    expect(() => parseOssStorageBasePath('bucket/mm')).toThrow(/invalid oss storageBasePath/);
    expect(() => parseOssStorageBasePath('')).toThrow(/invalid oss storageBasePath/);
  });

  it('rejects empty or non-regional endpoints', () => {
    expect(() => normalizeOssEndpoint('')).toThrow(/OSS endpoint is required/);
    expect(() => normalizeOssEndpoint('https://oss-cn-shanghai.aliyuncs.com/path')).toThrow(
      /without path\/query\/credentials/,
    );
    expect(() => normalizeOssEndpoint('https://oss-accelerate.aliyuncs.com')).toThrow(
      /accelerate endpoints are not supported/,
    );
    expect(() => normalizeOssEndpoint('https://example.com')).toThrow(
      /standard regional aliyuncs\.com endpoint/,
    );
  });

  it('rejects missing access keys when building the request', () => {
    const endpoint = normalizeOssEndpoint('https://oss-cn-shanghai.aliyuncs.com');
    expect(() => buildV4PutRequest({
      endpoint,
      bucket: 'bucket',
      objectKey: 'k.png',
      accessKeyId: '',
      accessKeySecret: 'sk',
      contentType: 'image/png',
    })).toThrow(/access key ID and secret are required/);
    expect(() => buildV4PutRequest({
      endpoint,
      bucket: 'bucket',
      objectKey: 'k.png',
      accessKeyId: 'ak',
      accessKeySecret: '',
      contentType: 'image/png',
    })).toThrow(/access key ID and secret are required/);
  });

  it('returns non-retryable failure for invalid bucket or object key (no network)', async () => {
    const invalidBucket = await ossPutObject({
      endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
      bucket: 'Bad_Bucket',
      objectKey: '20260101/abc.png',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });
    expect(invalidBucket.ok).toBe(false);
    expect(invalidBucket.retryable).toBe(false);
    expect(invalidBucket.error).toMatch(/Invalid OSS bucket name/);

    const dotKey = await ossPutObject({
      endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
      bucket: 'valid-bucket',
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

    const emptyKey = await ossPutObject({
      endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
      bucket: 'valid-bucket',
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

    const put = ossPutObject({
      endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
      bucket: 'valid-bucket',
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

  it('does not retry when the caller abort signal fires', async () => {
    const abort = new AbortController();
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));

    const put = ossPutObject({
      endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
      bucket: 'valid-bucket',
      objectKey: '20260101/abc.png',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 5000,
      signal: abort.signal,
    });
    abort.abort();
    const result = await put;
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toBe('aborted');
  });
});
