import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlsUploader } from '../../../src/multimodal/uploader/sls-uploader.js';
import * as slsClient from '../../../src/multimodal/uploader/sls-client.js';

describe('SlsUploader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sls = {
    endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
    project: 'proj',
    logstore: 'logstore',
    accessKeyId: 'ak',
    accessKeySecret: 'sk',
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
      project: '',
      logstore: '',
    }, 'sls://only-project')).toThrow(/requires project and logstore/);
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

  it('does not record successKeys when closed during in-flight put', async () => {
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
    expect(await uploading).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
    expect(await uploader.upload(item)).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

