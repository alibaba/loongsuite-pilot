import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBearerJsonRequest,
  buildLogV1JsonRequest,
  formatRfc822Gmt,
  normalizeSlsEndpoint,
  resolveSlsObjectAuth,
  resolveMultimodalEventStorageBasePath,
  parseOssBucketFromPresignedUrl,
  slsGeneratePresignedUrl,
  slsPutObject,
  slsPutPresignedObject,
  slsPutViaPresignedHttp,
  sniffSlsHttpEventStorageBasePath,
  SLS_HTTP_STORAGE_PROBE_KEY,
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
    expect(tryParseSlsStorageBasePath('sls://proj/logstore-multimodal')).toEqual({
      project: 'proj',
      logstore: 'logstore-multimodal',
    });
    // Extra path segments after logstore are ignored.
    expect(tryParseSlsStorageBasePath('sls://proj/logstore-multimodal/pilot-mm/')).toEqual({
      project: 'proj',
      logstore: 'logstore-multimodal',
    });
  });

  it('builds LOG hmac-sha1 Authorization without Content-MD5', () => {
    const endpoint = normalizeSlsEndpoint('https://cn-hangzhou.log.aliyuncs.com');
    const { url, headers } = buildLogV1JsonRequest({
      endpoint,
      project: 'example-project',
      method: 'PUT',
      resource: '/logstores/logstore-multimodal/objects/arms/a%20b.png',
      accessKeyId: 'AKIDEXAMPLE',
      accessKeySecret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      contentType: 'image/png',
      bodyLength: 3,
      extraHeaders: {
        'x-log-meta-mime-type': 'image/png',
        'x-log-meta-some-key': 'v',
      },
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
    const { headers } = buildLogV1JsonRequest({
      endpoint,
      project: 'p',
      method: 'PUT',
      resource: '/logstores/l/objects/k.png',
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
    expect(tryParseSlsStorageBasePath('')).toBeNull();
    expect(tryParseSlsStorageBasePath('sls://only-project')).toBeNull();
    expect(tryParseSlsStorageBasePath('proj')).toBeNull();
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
    expect(() => buildLogV1JsonRequest({
      endpoint,
      project: 'p',
      method: 'PUT',
      resource: '/logstores/l/objects/k.png',
      accessKeyId: '',
      accessKeySecret: 'sk',
      contentType: 'image/png',
      bodyLength: 1,
    })).toThrow(/access key ID and secret are required/);
    expect(() => buildLogV1JsonRequest({
      endpoint,
      project: 'p',
      method: 'PUT',
      resource: '/logstores/l/objects/k.png',
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
      mode: 'ak',
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
      mode: 'ak',
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
      mode: 'ak',
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
      mode: 'ak',
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

  it('rejects non-positive timeoutMs without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await slsPutObject({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: 'k.png',
      mode: 'ak',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/timeoutMs must be a positive number/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('puts object with LOG auth, encodes spaces, and omits Content-MD5', async () => {
    let seen: { url: string; headers: Headers } | undefined;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init?.headers) };
      return new Response('', { status: 200, headers: { 'x-log-requestid': 'rid-ak' } });
    });

    const result = await slsPutObject({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: '20260101/a b.png',
      mode: 'ak',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({ ok: true, statusCode: 200, requestId: 'rid-ak' });
    expect(seen?.url).toContain('/logstores/l/objects/20260101/a%20b.png');
    expect(seen?.headers.get('Authorization')).toMatch(/^LOG ak:/);
    expect(seen?.headers.get('Content-MD5')).toBeNull();
    expect(seen?.headers.get('Content-Type')).toBe('image/png');
  });

  it('marks 408/429/5xx retryable and 403 not retryable', async () => {
    const put = (status: number) => {
      vi.stubGlobal('fetch', async () => new Response('err', { status }));
      return slsPutObject({
        endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
        project: 'p',
        logstore: 'l',
        objectKey: 'k.png',
        mode: 'ak',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
        body: Buffer.from('x'),
        contentType: 'image/png',
        timeoutMs: 1000,
      });
    };
    expect(await put(403)).toMatchObject({ ok: false, statusCode: 403, retryable: false });
    expect(await put(408)).toMatchObject({ ok: false, statusCode: 408, retryable: true });
    expect(await put(429)).toMatchObject({ ok: false, statusCode: 429, retryable: true });
    expect(await put(500)).toMatchObject({ ok: false, statusCode: 500, retryable: true });
  });
});

describe('sls-client (ApiKey Bearer PutObject)', () => {
  it('formats Date as RFC822 GMT (not ISO8601)', () => {
    expect(formatRfc822Gmt(new Date('2026-08-19T05:53:26Z'))).toBe(
      'Wed, 19 Aug 2026 05:53:26 GMT',
    );
  });

  it('builds Bearer Authorization without LOG signature headers', () => {
    const endpoint = normalizeSlsEndpoint('https://cn-hangzhou.log.aliyuncs.com');
    const { url, headers } = buildBearerJsonRequest({
      endpoint,
      project: 'example-project',
      method: 'PUT',
      resource: '/logstores/logstore-multimodal/objects/arms/a%20b.png',
      apiKey: 'edge-writer-key',
      contentType: 'image/png',
      bodyLength: 3,
      extraHeaders: { 'x-log-meta-mime-type': 'image/png' },
      now: new Date('2026-08-19T05:53:26Z'),
    });

    expect(url).toBe(
      'https://example-project.cn-hangzhou.log.aliyuncs.com/logstores/logstore-multimodal/objects/arms/a%20b.png',
    );
    expect(headers.Authorization).toBe('Bearer edge-writer-key');
    expect(headers['x-log-apiversion']).toBe('0.6.0');
    expect(headers.Date).toBe('Wed, 19 Aug 2026 05:53:26 GMT');
    expect(headers['x-log-date']).toBe(headers.Date);
    expect(headers['x-log-signaturemethod']).toBeUndefined();
    expect(headers['x-log-meta-mime-type']).toBe('image/png');
  });

  it('sends Bearer headers on putObject when apiKey is set', async () => {
    const seen: Array<{ url: string; headers: Headers; method: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push({
        url: String(url),
        headers: new Headers(init?.headers),
        method: init?.method ?? 'GET',
      });
      return new Response('', {
        status: 200,
        headers: { 'x-log-requestid': 'rid-apikey' },
      });
    });

    const result = await slsPutObject({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: '20260101/abc.png',
      mode: 'apiKey',
      apiKey: 'edge-key',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({ ok: true, statusCode: 200, requestId: 'rid-apikey' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.headers.get('Authorization')).toBe('Bearer edge-key');
    expect(seen[0]!.headers.get('x-log-apiversion')).toBe('0.6.0');
    expect(seen[0]!.headers.get('x-log-date')).toMatch(/GMT$/);
    expect(seen[0]!.url).toContain('/logstores/l/objects/20260101/abc.png');
  });

  it('requires mode and rejects incomplete credentials for the selected mode', () => {
    expect(() => resolveSlsObjectAuth({
      apiKey: 'k',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
    })).toThrow(/auth mode is required/);
    expect(resolveSlsObjectAuth({
      mode: 'apiKey',
      apiKey: 'k',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
    })).toEqual({ kind: 'apiKey', apiKey: 'k' });
    expect(resolveSlsObjectAuth({
      mode: 'ak',
      apiKey: 'k',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
    })).toEqual({ kind: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' });
    expect(() => resolveSlsObjectAuth({ mode: 'apiKey', apiKey: '' })).toThrow(/apiKey is required/);
    expect(() => resolveSlsObjectAuth({
      mode: 'ak',
      accessKeyId: 'ak',
      accessKeySecret: '',
    })).toThrow(/access key ID and secret are required/);
  });

  it('returns non-retryable failure when apiKey is empty and AK is missing', async () => {
    const result = await slsPutObject({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: 'k.png',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/auth mode is required/);
  });

  it('returns non-retryable failure when mode=apiKey but apiKey is empty', async () => {
    const result = await slsPutObject({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: 'k.png',
      mode: 'apiKey',
      apiKey: '  ',
      body: Buffer.from('x'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/apiKey is required/);
  });

});

describe('sls-client (presign)', () => {
  it('builds V1 JSON POST /presign with uppercase hex Content-MD5', () => {
    const endpoint = normalizeSlsEndpoint('https://cn-hangzhou.log.aliyuncs.com');
    const body = Buffer.from(JSON.stringify({ key: 'my_object', method: 'PUT' }), 'utf8');
    const { url, headers } = buildLogV1JsonRequest({
      endpoint,
      project: 'p',
      method: 'POST',
      resource: '/logstores/l/presign',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      body,
      now: new Date('2026-08-19T05:53:26Z'),
    });
    expect(url).toBe('https://p.cn-hangzhou.log.aliyuncs.com/logstores/l/presign');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Content-MD5']).toMatch(/^[0-9A-F]{32}$/);
    expect(headers.Authorization).toMatch(/^LOG ak:[A-Za-z0-9+/=]+$/);
    expect(headers['x-log-date']).toBe(headers.Date);
  });

  it('posts /presign with Bearer and returns url', async () => {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain('/logstores/l/presign');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer edge-key');
      return new Response(JSON.stringify({ url: 'https://oss.example/obj?sig=1' }), {
        status: 200,
        headers: { 'x-log-requestid': 'rid-presign' },
      });
    });

    const result = await slsGeneratePresignedUrl({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: 'my_object',
      mode: 'apiKey',
      apiKey: 'edge-key',
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({
      ok: true,
      url: 'https://oss.example/obj?sig=1',
      requestId: 'rid-presign',
    });
  });

  it('PUTs body to presigned URL without auth headers', async () => {
    let seenHeaders: Headers | undefined;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      expect(init?.method).toBe('PUT');
      return new Response('', { status: 200, headers: { 'x-oss-request-id': 'oss-1' } });
    });

    const result = await slsPutPresignedObject({
      url: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/my_object?STS=1',
      body: Buffer.from('hello'),
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ ok: true, requestId: 'oss-1' });
    expect(seenHeaders?.get('Authorization')).toBeNull();
  });

  it('presigns then PUTs via HTTP without sending the apiKey on the object URL', async () => {
    const seen: Array<{ url: string; method: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), method: String(init?.method), auth: headers.get('Authorization') });
      if (String(url).includes('/presign')) {
        return new Response(JSON.stringify({
          url: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/20260101/a.png?sig=1',
        }), { status: 200, headers: { 'x-log-requestid': 'rid-presign' } });
      }
      return new Response('', { status: 200, headers: { 'x-oss-request-id': 'oss-http' } });
    });

    const result = await slsPutViaPresignedHttp({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: '20260101/a.png',
      mode: 'apiKey',
      apiKey: 'edge-key',
      body: Buffer.from('hello'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ ok: true, requestId: 'oss-http' });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ method: 'POST', auth: 'Bearer edge-key' });
    expect(seen[0]!.url).toContain('/logstores/l/presign');
    expect(seen[1]).toMatchObject({
      method: 'PUT',
      auth: null,
      url: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/20260101/a.png?sig=1',
    });
  });

  it('posts /presign with AK and method PUT in the JSON body', async () => {
    let bodyText = '';
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      bodyText = Buffer.from(init?.body as Uint8Array).toString('utf8');
      expect(new Headers(init?.headers).get('Authorization')).toMatch(/^LOG ak:/);
      expect(new Headers(init?.headers).get('Content-MD5')).toMatch(/^[0-9A-F]{32}$/);
      return new Response(JSON.stringify({ Url: 'https://oss.example/obj?sig=1' }), { status: 200 });
    });

    const result = await slsGeneratePresignedUrl({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: '20260101/a.png',
      mode: 'ak',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.url).toBe('https://oss.example/obj?sig=1');
    expect(JSON.parse(bodyText)).toEqual({ key: '20260101/a.png', method: 'PUT' });
  });

  it('fails closed when presign body has no http url', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ url: 'not-a-url' }), { status: 200 }));
    const result = await slsGeneratePresignedUrl({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: 'k',
      mode: 'ak',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/presign response missing url/);
  });

  it('does not PUT when presign fails', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url));
      return new Response('nope', { status: 403 });
    });
    const result = await slsPutViaPresignedHttp({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: 'k.png',
      mode: 'apiKey',
      apiKey: 'edge-key',
      body: Buffer.from('hello'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/presign');
  });

  it('does not PUT a non-https presign URL', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({
        url: 'http://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/20260101/a.png?sig=1',
      }), { status: 200 });
    });
    const result = await slsPutViaPresignedHttp({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: '20260101/a.png',
      mode: 'apiKey',
      apiKey: 'edge-key',
      body: Buffer.from('hello'),
      contentType: 'image/png',
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/presign response missing url|must be https/);
    expect(seen).toHaveLength(1);
  });

  it('does not PUT when presign bucket or object path does not match', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({
        url: 'https://other-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/20260101/a.png?sig=1',
      }), { status: 200 });
    });
    const result = await slsPutViaPresignedHttp({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: '20260101/a.png',
      mode: 'ak',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      body: Buffer.from('hello'),
      contentType: 'image/png',
      timeoutMs: 1000,
      expectedBucket: 'user-bucket',
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/bucket mismatch/);
    expect(seen).toHaveLength(1);
  });

  it('does not start the second-stage PUT after abort', async () => {
    const seen: string[] = [];
    let releasePresign!: () => void;
    const presignGate = new Promise<void>(resolve => {
      releasePresign = resolve;
    });
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url));
      if (String(url).includes('/presign')) {
        await presignGate;
        return new Response(JSON.stringify({
          url: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/20260101/a.png?sig=1',
        }), { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    const abort = new AbortController();
    const pending = slsPutViaPresignedHttp({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      objectKey: '20260101/a.png',
      mode: 'apiKey',
      apiKey: 'edge-key',
      body: Buffer.from('hello'),
      contentType: 'image/png',
      timeoutMs: 1000,
      signal: abort.signal,
      expectedBucket: 'user-bucket',
    });
    abort.abort();
    releasePresign();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/aborted|presign/);
    expect(seen.filter(url => !url.includes('/presign'))).toHaveLength(0);
  });

  it('fails closed when presigned URL is empty', async () => {
    const result = await slsPutPresignedObject({
      url: '  ',
      body: Buffer.from('hello'),
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/presigned URL is required/);
  });

  it('parses virtual-hosted OSS bucket from a presigned URL', () => {
    expect(parseOssBucketFromPresignedUrl(
      'https://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/k.png?Expires=1&Signature=secret',
    )).toBe('user-bucket');
    expect(parseOssBucketFromPresignedUrl(
      'https://sls-multimodal-storage-cn-zhangjiakou-spe-01.oss-cn-zhangjiakou.aliyuncs.com/p/l/k',
    )).toBe('sls-multimodal-storage-cn-zhangjiakou-spe-01');
    expect(parseOssBucketFromPresignedUrl('https://oss.example/obj?sig=1')).toBeNull();
    expect(parseOssBucketFromPresignedUrl('not-a-url')).toBeNull();
  });

  it('sniffs oss:// event prefix from one presign and does not PUT', async () => {
    const seen: string[] = [];
    let bodyText = '';
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      bodyText = Buffer.from(init?.body as Uint8Array).toString('utf8');
      return new Response(JSON.stringify({
        url: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/_pilot/storage-probe?sig=secret',
      }), { status: 200 });
    });

    const result = await sniffSlsHttpEventStorageBasePath({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      mode: 'apiKey',
      apiKey: 'edge-key',
      timeoutMs: 1000,
    });
    expect(result).toEqual({
      ok: true,
      storageBasePath: 'oss://user-bucket/p/l',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/presign');
    expect(seen[0]).toMatch(/^POST /);
    expect(JSON.parse(bodyText)).toEqual({ key: SLS_HTTP_STORAGE_PROBE_KEY, method: 'PUT' });
  });

  it('fails closed when sniff presign times out or is forbidden', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const hung = sniffSlsHttpEventStorageBasePath({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      mode: 'ak',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    const timeout = await hung;
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(timeout.error).toMatch(/aborted/i);

    vi.useRealTimers();
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 403 }));
    const forbidden = await sniffSlsHttpEventStorageBasePath({
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'p',
      logstore: 'l',
      mode: 'ak',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      timeoutMs: 1000,
    });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error).toMatch(/403/);
  });

  it('keeps sls:// for type=sls without calling SLS', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await resolveMultimodalEventStorageBasePath({
      storage: {
        type: 'sls',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
        },
        auth: { mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
      },
      storageBasePath: 'sls://proj/logstore',
    });
    expect(result).toEqual({ ok: true, storageBasePath: 'sls://proj/logstore' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves oss:// for delegatedOss via one presign', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      url: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com/proj/logstore/k?sig=1',
    }), { status: 200 }));
    const result = await resolveMultimodalEventStorageBasePath({
      storage: {
        type: 'delegatedOss',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
        },
        auth: { mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
      },
      storageBasePath: 'sls://proj/logstore',
    });
    expect(result).toEqual({
      ok: true,
      storageBasePath: 'oss://user-bucket/proj/logstore',
    });
  });

  it('sniffs delegatedOss and accepts matching target.ossBucket', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      url: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com/proj/logstore/k?sig=1',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await resolveMultimodalEventStorageBasePath({
      storage: {
        type: 'delegatedOss',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
          ossBucket: 'user-bucket',
        },
        auth: { mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
      },
      storageBasePath: 'sls://proj/logstore',
    });
    expect(result).toEqual({
      ok: true,
      storageBasePath: 'oss://user-bucket/proj/logstore',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('disables delegatedOss when target.ossBucket does not match sniff', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      url: 'https://other-bucket.oss-cn-hangzhou.aliyuncs.com/proj/logstore/k?sig=1',
    }), { status: 200 }));
    const result = await resolveMultimodalEventStorageBasePath({
      storage: {
        type: 'delegatedOss',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
          ossBucket: 'user-bucket',
        },
        auth: { mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
      },
      storageBasePath: 'sls://proj/logstore',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/does not match current landing bucket \(other-bucket\)/);
    }
  });

  it('sniffs type=sls when ossBucket is set and keeps sls:// on match', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      url: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com/proj/logstore/k?sig=1',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await resolveMultimodalEventStorageBasePath({
      storage: {
        type: 'sls',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
          ossBucket: 'user-bucket',
        },
        auth: { mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
      },
      storageBasePath: 'sls://proj/logstore',
    });
    expect(result).toEqual({ ok: true, storageBasePath: 'sls://proj/logstore' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('disables type=sls when target.ossBucket does not match sniff', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      url: 'https://other-bucket.oss-cn-hangzhou.aliyuncs.com/proj/logstore/k?sig=1',
    }), { status: 200 }));
    const result = await resolveMultimodalEventStorageBasePath({
      storage: {
        type: 'sls',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
          ossBucket: 'user-bucket',
        },
        auth: { mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
      },
      storageBasePath: 'sls://proj/logstore',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/does not match current landing bucket \(other-bucket\)/);
    }
  });
});
