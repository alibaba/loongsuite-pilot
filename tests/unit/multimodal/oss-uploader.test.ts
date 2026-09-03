import { afterEach, describe, expect, it, vi } from 'vitest';
import { OssUploader } from '../../../src/multimodal/uploader/oss-uploader.js';
import * as ossClient from '../../../src/multimodal/uploader/oss-client.js';

describe('OssUploader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ossStorage = (storageBasePath = 'oss://bucket/mm') => ({
    type: 'oss' as const,
    target: {
      endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
      storageBasePath,
    },
    auth: {
      mode: 'ak' as const,
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
    },
  });

  it('rejects invalid payload size without calling put', async () => {
    const put = vi.spyOn(ossClient, 'ossPutObject');
    const uploader = new OssUploader(ossStorage());
    const ok = await uploader.upload({
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: { mime_type: 'image/png' },
      data: Buffer.from('ab'),
      expectedSize: 1,
    });
    expect(ok).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it('skips put when successKeys already has the object key', async () => {
    const put = vi.spyOn(ossClient, 'ossPutObject').mockResolvedValue({
      ok: true,
      statusCode: 200,
    });
    const uploader = new OssUploader(ossStorage());
    const item = {
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: { mime_type: 'image/png' },
      data: Buffer.from('ab'),
      expectedSize: 2,
    };
    expect(await uploader.upload(item)).toBe(true);
    expect(await uploader.upload(item)).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('returns false on non-retryable put failure', async () => {
    vi.spyOn(ossClient, 'ossPutObject').mockResolvedValue({
      ok: false,
      statusCode: 403,
      error: 'forbidden',
      retryable: false,
    });
    const uploader = new OssUploader(ossStorage());
    const ok = await uploader.upload({
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    });
    expect(ok).toBe(false);
  });

  it('throws in constructor for invalid storageBasePath', () => {
    expect(() => new OssUploader(ossStorage('s3://bucket/mm'))).toThrow(/invalid oss storageBasePath/);
  });

  it('rejects uploads after shutdown and clears successKeys', async () => {
    const put = vi.spyOn(ossClient, 'ossPutObject').mockResolvedValue({
      ok: true,
      statusCode: 200,
    });
    const uploader = new OssUploader(ossStorage());
    const item = {
      targetPath: '20260101/a.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    };
    expect(await uploader.upload(item)).toBe(true);
    await uploader.shutdown();
    await uploader.shutdown(); // idempotent
    expect(await uploader.upload(item)).toBe(false);
    // Only the pre-shutdown upload should have hit the network.
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('returns success but skips successKeys when closed during in-flight put', async () => {
    let resolvePut!: (value: { ok: true; statusCode: number }) => void;
    const putGate = new Promise<{ ok: true; statusCode: number }>(resolve => {
      resolvePut = resolve;
    });
    const put = vi.spyOn(ossClient, 'ossPutObject').mockImplementation(async () => putGate);
    const uploader = new OssUploader(ossStorage());
    const item = {
      targetPath: '20260101/race.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    };

    const uploading = uploader.upload(item);
    await uploader.shutdown();
    resolvePut({ ok: true, statusCode: 200 });

    expect(await uploading).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);

    // Closed + successKeys cleared: a fresh upload must not short-circuit as idempotent.
    put.mockResolvedValue({ ok: true, statusCode: 200 });
    expect(await uploader.upload(item)).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight put on shutdown', async () => {
    let seenSignal: AbortSignal | undefined;
    vi.spyOn(ossClient, 'ossPutObject').mockImplementation(async (params) => {
      seenSignal = params.signal;
      return new Promise(() => {});
    });
    const uploader = new OssUploader(ossStorage());
    void uploader.upload({
      targetPath: '20260101/hang.png',
      contentType: 'image/png',
      meta: {},
      data: Buffer.from('x'),
      expectedSize: 1,
    });
    await Promise.resolve();
    await uploader.shutdown();
    expect(seenSignal?.aborted).toBe(true);
  });
});

