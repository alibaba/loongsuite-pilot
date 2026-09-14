import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlsUploader } from '../../../src/multimodal/uploader/sls-uploader.js';
import * as slsClient from '../../../src/multimodal/uploader/sls-client.js';

describe('SlsUploader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const sls = {
    type: 'sls' as const,
    target: {
      endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
      project: 'proj',
      logstore: 'logstore',
    },
    auth: {
      mode: 'ak' as const,
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
    },
  };

  it('rejects invalid payload size without calling put', async () => {
    const put = vi.spyOn(slsClient, 'slsPutObject');
    const uploader = new SlsUploader(sls, 'sls://proj/logstore');
    const ok = await uploader.upload({
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: { mime_type: 'image/png' },
      data: Buffer.from('ab'),
      expectedSize: 9,
    });
    expect(ok).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it('skips put when successKeys already has the object key', async () => {
    const put = vi.spyOn(slsClient, 'slsPutObject').mockResolvedValue({
      ok: true,
      statusCode: 200,
      requestId: 'r1',
    });
    const uploader = new SlsUploader(sls, 'sls://proj/logstore');
    const item = {
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('ab'),
      expectedSize: 2,
    };
    expect(await uploader.upload(item)).toBe(true);
    expect(await uploader.upload(item)).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('returns false on put failure', async () => {
    vi.spyOn(slsClient, 'slsPutObject').mockResolvedValue({
      ok: false,
      statusCode: 500,
      error: 'boom',
      retryable: false,
    });
    const uploader = new SlsUploader(sls, 'sls://proj/logstore');
    const ok = await uploader.upload({
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    });
    expect(ok).toBe(false);
  });

  it('throws when project/logstore cannot be resolved', () => {
    expect(() => new SlsUploader({
      ...sls,
      target: { ...sls.target, project: '', logstore: '' },
    }, 'sls://only-project')).toThrow(/requires project and logstore/);
  });

  it('throws when delegatedOss is missing expectedPresignOrigin', () => {
    expect(() => new SlsUploader({
      ...sls,
      type: 'delegatedOss',
    }, 'sls://proj/logstore')).toThrow(/requires expectedPresignOrigin/);
  });

  it('rejects uploads after shutdown', async () => {
    const put = vi.spyOn(slsClient, 'slsPutObject').mockResolvedValue({
      ok: true,
      statusCode: 200,
      requestId: 'r1',
    });
    const uploader = new SlsUploader(sls, 'sls://proj/logstore');
    const item = {
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    };
    expect(await uploader.upload(item)).toBe(true);
    await uploader.shutdown();
    expect(await uploader.upload(item)).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('uploads via apiKey', async () => {
    const put = vi.spyOn(slsClient, 'slsPutObject').mockResolvedValue({
      ok: true,
      statusCode: 200,
      requestId: 'r-api',
    });
    const uploader = new SlsUploader({
      ...sls,
      auth: {
        mode: 'apiKey',
        apiKey: 'edge-key',
      },
    }, 'sls://proj/logstore');
    const ok = await uploader.upload({
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    });
    expect(ok).toBe(true);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'apiKey',
      apiKey: 'edge-key',
      objectKey: '20260101/a.png',
    }));
    expect(put.mock.calls[0]?.[0]).not.toHaveProperty('accessKeyId');
  });

  it('uploads via ApiKey presigned HTTP and skips PutObject', async () => {
    const put = vi.spyOn(slsClient, 'slsPutObject');
    const viaHttp = vi.spyOn(slsClient, 'slsPutViaPresignedHttp').mockResolvedValue({
      ok: true,
      statusCode: 200,
      requestId: 'r-http',
    });
    const uploader = new SlsUploader({
      ...sls,
      type: 'delegatedOss',
      auth: {
        mode: 'apiKey',
        apiKey: 'edge-key',
      },
    }, 'sls://proj/logstore', {
      expectedPresignOrigin: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com',
    });
    const ok = await uploader.upload({
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    });
    expect(ok).toBe(true);
    expect(put).not.toHaveBeenCalled();
    expect(viaHttp).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'apiKey',
      apiKey: 'edge-key',
      objectKey: '20260101/a.png',
    }));
  });

  it('uploads via AK presigned HTTP', async () => {
    const viaHttp = vi.spyOn(slsClient, 'slsPutViaPresignedHttp').mockResolvedValue({
      ok: true,
      statusCode: 200,
      requestId: 'r-ak-http',
    });
    const uploader = new SlsUploader({
      ...sls,
      type: 'delegatedOss',
    }, 'sls://proj/logstore', {
      expectedPresignOrigin: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com',
    });
    const ok = await uploader.upload({
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    });
    expect(ok).toBe(true);
    expect(viaHttp).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'ak',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      objectKey: '20260101/a.png',
    }));
  });

  it('returns success but skips successKeys when closed during in-flight put', async () => {
    let resolvePut!: (value: { ok: true; statusCode: number; requestId: string }) => void;
    const putGate = new Promise<{ ok: true; statusCode: number; requestId: string }>(resolve => {
      resolvePut = resolve;
    });
    const put = vi.spyOn(slsClient, 'slsPutObject').mockImplementation(async () => putGate);
    const uploader = new SlsUploader(sls, 'sls://proj/logstore');
    const item = {
      targetPath: '20260101/race.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    };

    const uploading = uploader.upload(item);
    await uploader.shutdown();
    resolvePut({ ok: true, statusCode: 200, requestId: 'late' });

    expect(await uploading).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(await uploader.upload(item)).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('does not issue the second-stage PUT after shutdown during presign', async () => {
    const seen: string[] = [];
    let releasePresign!: () => void;
    const presignGate = new Promise<void>(resolve => {
      releasePresign = resolve;
    });
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(`${url}`);
      if (String(url).includes('/presign')) {
        await presignGate;
        return new Response(JSON.stringify({
          url: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com/proj/logstore/20260101/a.png?sig=1',
        }), { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    const uploader = new SlsUploader({
      ...sls,
      type: 'delegatedOss',
    }, 'sls://proj/logstore', {
      expectedPresignOrigin: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com',
    });
    const uploading = uploader.upload({
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    });
    await uploader.shutdown();
    releasePresign();
    expect(await uploading).toBe(false);
    expect(seen.some(url => url.includes('/presign'))).toBe(true);
    expect(seen.some(url => url.includes('user-bucket.oss-'))).toBe(false);
  });
});

