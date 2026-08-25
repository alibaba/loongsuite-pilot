import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultimodalProcessor, withDeadline } from '../../../src/multimodal/processor.js';
import { mergeAllowedRootPaths } from '../../../src/multimodal/resolve.js';
import { yyyymmddLocal } from '../../../src/multimodal/resolve.js';
import {
  MAX_MULTIMODAL_BASE64_CHARS,
  MAX_MULTIMODAL_DATA_SIZE,
  MAX_MULTIMODAL_PENDING_UPLOADS,
} from '../../../src/multimodal/types.js';
import { FakeUploader } from './fake-uploader.js';

const STORAGE_BASE = 'oss://bucket/pilot-mm';
const EVENT_TIME_MS = 1_700_000_000_000;
const EVENT_DAY = yyyymmddLocal(new Date(EVENT_TIME_MS));
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PNG_HDR = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TMP_ALLOW = { allowedRootPaths: mergeAllowedRootPaths([os.tmpdir()]) };

function writeTempPng(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-mm-proc-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([PNG_HDR, Buffer.from(content)]));
  return file;
}

describe('withDeadline', () => {
  it('returns the value when work finishes first', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 50, () => 'late')).resolves.toBe('ok');
  });

  it('returns onTimeout when work never settles', async () => {
    const started = Date.now();
    await expect(withDeadline(new Promise<string>(() => {}), 30, () => 'late')).resolves.toBe('late');
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('does not swallow a fast rejection', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 50, () => 'late'))
      .rejects.toThrow('boom');
  });

  it('deadlineMs <= 0 disables the race', async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>(r => {
      resolve = r;
    });
    const raced = withDeadline(pending, 0, () => 'late');
    resolve('ok');
    await expect(raced).resolves.toBe('ok');
  });
});

describe('MultimodalProcessor.blobToUri', () => {
  it('returns optimistic uri and enqueues upload', async () => {
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    const bytes = Buffer.from('png-bytes');
    const result = processor.blobToUri({
      content: bytes.toString('base64'),
      mime_type: 'image/png',
      modality: 'image',
      time_unix_ms: EVENT_TIME_MS,
    });

    expect(result).not.toBeNull();
    expect(result!.uri).toMatch(new RegExp(`^oss://bucket/pilot-mm/${EVENT_DAY}/[a-f0-9]{64}\\.png$`));
    expect(result!.mime_type).toBe('image/png');
    expect(result!.modality).toBe('image');
    expect(result!.size).toBe(bytes.length);
    expect(result!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

    await processor.shutdown(1000);
    expect(uploader.items).toHaveLength(1);
  });

  it('returns uri even when upload will fail (dangling uri)', async () => {
    const uploader = new FakeUploader();
    uploader.failNext = true;
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    const result = processor.blobToUri({
      content: Buffer.from('x').toString('base64'),
      mime_type: 'image/png',
      time_unix_ms: 1_700_000_000_000,
    });
    expect(result?.uri).toMatch(/^oss:\/\/bucket\/pilot-mm\//);
    await processor.shutdown(1000);
    expect(uploader.items).toHaveLength(1);
  });

  it('rejects oversized payloads', () => {
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    const huge = Buffer.alloc(MAX_MULTIMODAL_DATA_SIZE + 1, 1).toString('base64');
    expect(processor.blobToUri({ content: huge, mime_type: 'image/png' })).toBeNull();
    expect(uploader.items).toHaveLength(0);
  });

  it('rejects empty content', () => {
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    expect(processor.blobToUri({ content: '', mime_type: 'image/png' })).toBeNull();
  });

  it('rejects overlong base64 strings before decode', () => {
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    const huge = 'A'.repeat(MAX_MULTIMODAL_BASE64_CHARS + 1);
    expect(processor.blobToUri({ content: huge, mime_type: 'image/png' })).toBeNull();
    expect(uploader.items).toHaveLength(0);
  });

  it('rejects content that cannot decode to bytes', () => {
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    expect(processor.blobToUri({ content: '!!!!', mime_type: 'image/png' })).toBeNull();
    expect(uploader.items).toHaveLength(0);
  });

  it('keeps optimistic uri when uploader throws', async () => {
    const uploader = new FakeUploader();
    uploader.throwOnUpload = true;
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    const result = processor.blobToUri({
      content: Buffer.from('boom').toString('base64'),
      mime_type: 'image/png',
      time_unix_ms: 1_700_000_000_000,
    });
    expect(result?.uri).toMatch(/^oss:\/\/bucket\/pilot-mm\//);
    await processor.shutdown(1000);
  });

  it('returns dangling uri when pending uploads hit the queue limit', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const uploader = new FakeUploader();
    uploader.hold = hold;
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);

    for (let i = 0; i < MAX_MULTIMODAL_PENDING_UPLOADS; i++) {
      const result = processor.blobToUri({
        content: Buffer.from(`img-${i}`).toString('base64'),
        mime_type: 'image/png',
        time_unix_ms: 1_700_000_000_000,
      });
      expect(result).not.toBeNull();
    }

    const overflow = processor.blobToUri({
      content: Buffer.from('overflow').toString('base64'),
      mime_type: 'image/png',
      time_unix_ms: 1_700_000_000_000,
    });
    expect(overflow?.uri).toMatch(/^oss:\/\/bucket\/pilot-mm\//);

    release();
    await processor.shutdown(1000);
    // Overflow uri was returned but not enqueued.
    expect(uploader.items).toHaveLength(MAX_MULTIMODAL_PENDING_UPLOADS);
  });

  it('returns dangling uri when pending bytes hit the limit', async () => {
    // Production pending-bytes budget is 1GiB; re-import processor with a tiny
    // mock so this case stays cheap without affecting other tests' static imports.
    vi.resetModules();
    vi.doMock('../../../src/multimodal/types.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/multimodal/types.js')>();
      return { ...actual, MAX_MULTIMODAL_PENDING_BYTES: 64 };
    });
    try {
      const { MultimodalProcessor: ProcessorWithTinyBudget } = await import(
        '../../../src/multimodal/processor.js'
      );
      let release!: () => void;
      const hold = new Promise<void>(resolve => {
        release = resolve;
      });
      const uploader = new FakeUploader();
      uploader.hold = hold;
      const processor = new ProcessorWithTinyBudget(STORAGE_BASE, uploader);

      const first = processor.blobToUri({
        content: Buffer.alloc(40, 1).toString('base64'),
        mime_type: 'image/png',
        time_unix_ms: 1_700_000_000_000,
      });
      expect(first).not.toBeNull();

      const overflow = processor.blobToUri({
        content: Buffer.alloc(40, 2).toString('base64'),
        mime_type: 'image/png',
        time_unix_ms: 1_700_000_000_000,
      });
      expect(overflow?.uri).toMatch(/^oss:\/\/bucket\/pilot-mm\//);

      release();
      await processor.shutdown(1000);
      expect(uploader.items).toHaveLength(1);
      expect(uploader.items[0]!.expectedSize).toBe(40);
    } finally {
      vi.doUnmock('../../../src/multimodal/types.js');
      vi.resetModules();
    }
  });

  it('dedupes in-flight uploads for the same targetPath', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const uploader = new FakeUploader();
    uploader.hold = hold;
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    const content = Buffer.from('same-blob').toString('base64');
    const params = {
      content,
      mime_type: 'image/png' as const,
      time_unix_ms: 1_700_000_000_000,
    };

    const first = processor.blobToUri(params);
    const second = processor.blobToUri(params);
    expect(first?.uri).toBe(second?.uri);
    expect(first?.sha256).toBe(second?.sha256);

    release();
    await processor.shutdown(1000);
    expect(uploader.items).toHaveLength(1);
  });

  it('rejects new blobs after shutdown starts', async () => {
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    const shutdown = processor.shutdown(1000);
    expect(processor.blobToUri({
      content: Buffer.from('late').toString('base64'),
      mime_type: 'image/png',
    })).toBeNull();
    await shutdown;
  });

  it('rejects empty storageBasePath at construction', () => {
    expect(() => new MultimodalProcessor('', new FakeUploader())).toThrow(
      /storageBasePath is required/,
    );
    expect(() => new MultimodalProcessor('   ', new FakeUploader())).toThrow(
      /storageBasePath is required/,
    );
  });

  it('shutdown drains in-flight uploads then closes uploader', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const uploader = new FakeUploader();
    uploader.hold = hold;
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);

    expect(processor.blobToUri({
      content: Buffer.from('drain-me').toString('base64'),
      mime_type: 'image/png',
      time_unix_ms: 1_700_000_000_000,
    })).not.toBeNull();

    const shuttingDown = processor.shutdown(1000);
    // Still blocked on hold — uploader not closed yet.
    expect(uploader.shutdownCalls).toBe(0);
    release();
    await shuttingDown;
    expect(uploader.shutdownCalls).toBe(1);
    expect(uploader.closed).toBe(true);
    expect(uploader.items).toHaveLength(1);
  });

  it('shutdown times out but still closes uploader and rejects new work', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const uploader = new FakeUploader();
    uploader.hold = hold;
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);

    expect(processor.blobToUri({
      content: Buffer.from('slow').toString('base64'),
      mime_type: 'image/png',
      time_unix_ms: 1_700_000_000_000,
    })).not.toBeNull();

    await processor.shutdown(20);
    expect(uploader.shutdownCalls).toBe(1);
    expect(uploader.closed).toBe(true);
    expect(processor.blobToUri({
      content: Buffer.from('after').toString('base64'),
      mime_type: 'image/png',
    })).toBeNull();

    release();
    // Give the abandoned upload a tick; closed uploader should not accept it as success path for new work.
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('shutdown is idempotent and closes uploader once', async () => {
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    await processor.shutdown(100);
    await processor.shutdown(100);
    expect(uploader.shutdownCalls).toBe(1);
    expect(uploader.closed).toBe(true);
  });
});

describe('MultimodalProcessor.pathToUri', () => {
  it('reads a local image as bytes and returns uri', async () => {
    const file = writeTempPng('logo.png', 'png-bytes');
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);

    const result = await processor.pathToUri(file, EVENT_TIME_MS, TMP_ALLOW);
    expect(result).not.toBeNull();
    expect(result!.mime_type).toBe('image/png');
    expect(result!.uri).toMatch(new RegExp(`^oss://bucket/pilot-mm/${EVENT_DAY}/[a-f0-9]{64}\\.png$`));

    await processor.shutdown(1000);
    expect(uploader.items).toHaveLength(1);
  });

  it('LRU-caches path→uri so the same path is uploaded once', async () => {
    const file = writeTempPng('dup.png', 'same-bytes');
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);

    const a = await processor.pathToUri(file, undefined, TMP_ALLOW);
    const b = await processor.pathToUri(path.join(path.dirname(file), '.', 'dup.png'), undefined, TMP_ALLOW);
    expect(a?.uri).toBe(b?.uri);

    await processor.shutdown(1000);
    expect(uploader.items).toHaveLength(1);
  });

  it('shares one in-flight read for concurrent pathToUri calls', async () => {
    const file = writeTempPng('race.png', 'race');
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);

    const [a, b] = await Promise.all([
      processor.pathToUri(file, undefined, TMP_ALLOW),
      processor.pathToUri(file, undefined, TMP_ALLOW),
    ]);
    expect(a?.uri).toBe(b?.uri);

    await processor.shutdown(1000);
    expect(uploader.items).toHaveLength(1);
  });

  it('rejects new path reads when path inflight queue is full', async () => {
    vi.resetModules();
    let releaseReads!: () => void;
    const holdReads = new Promise<void>(resolve => {
      releaseReads = resolve;
    });
    vi.doMock('../../../src/multimodal/types.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/multimodal/types.js')>();
      return { ...actual, MAX_MULTIMODAL_PATH_INFLIGHT: 2 };
    });
    vi.doMock('../../../src/multimodal/resolve.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/multimodal/resolve.js')>();
      return {
        ...actual,
        openNormalizedLocalImage: async (
          filePath: string,
          maxBytes?: number,
          allowedRootPaths?: string[],
        ) => {
          await holdReads;
          return actual.openNormalizedLocalImage(filePath, maxBytes, allowedRootPaths);
        },
      };
    });
    try {
      const { MultimodalProcessor: ProcessorWithTinyPathBudget } = await import(
        '../../../src/multimodal/processor.js'
      );
      const f1 = writeTempPng('inflight-1.png', 'one');
      const f2 = writeTempPng('inflight-2.png', 'two');
      const f3 = writeTempPng('inflight-3.png', 'three');
      const uploader = new FakeUploader();
      const processor = new ProcessorWithTinyPathBudget(STORAGE_BASE, uploader);

      const first = processor.pathToUri(f1, EVENT_TIME_MS, TMP_ALLOW);
      const second = processor.pathToUri(f2, EVENT_TIME_MS, TMP_ALLOW);
      // Fill the two slots before the third distinct path is admitted.
      await Promise.resolve();
      const overflow = await processor.pathToUri(f3, EVENT_TIME_MS, TMP_ALLOW);
      expect(overflow).toBeNull();

      // Same path as an in-flight read still coalesces (does not consume a new slot).
      const coalesced = processor.pathToUri(f1, EVENT_TIME_MS, TMP_ALLOW);

      releaseReads();
      const [a, b, c] = await Promise.all([first, second, coalesced]);
      expect(a?.uri).toBeTruthy();
      expect(b?.uri).toBeTruthy();
      expect(c?.uri).toBe(a?.uri);

      await processor.shutdown(1000);
      expect(uploader.items).toHaveLength(2);
    } finally {
      releaseReads();
      vi.doUnmock('../../../src/multimodal/types.js');
      vi.doUnmock('../../../src/multimodal/resolve.js');
      vi.resetModules();
    }
  });

  it('does not cache missing paths (re-stat each call)', async () => {
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    expect(await processor.pathToUri('/no/such/image.png', undefined, TMP_ALLOW)).toBeNull();
    expect(await processor.pathToUri('/no/such/image.png', undefined, TMP_ALLOW)).toBeNull();
    expect(uploader.items).toHaveLength(0);
    await processor.shutdown(100);
  });

  it('invalidates path cache when mtime or size changes', async () => {
    const file = writeTempPng('rewrite.png', 'version-1');
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);

    const first = await processor.pathToUri(file, EVENT_TIME_MS, TMP_ALLOW);
    expect(first).not.toBeNull();

    // Ensure mtime moves forward even on coarse filesystem timestamps.
    const previous = fs.statSync(file);
    fs.writeFileSync(file, Buffer.concat([PNG_HDR, Buffer.from('version-2-different-bytes')]));
    fs.utimesSync(file, previous.atime, new Date(previous.mtimeMs + 1000));

    const second = await processor.pathToUri(file, EVENT_TIME_MS, TMP_ALLOW);
    expect(second).not.toBeNull();
    expect(second!.uri).not.toBe(first!.uri);

    await processor.shutdown(1000);
    expect(uploader.items).toHaveLength(2);
  });

  it('rejects pathToUri without allowed roots or outside them', async () => {
    const file = writeTempPng('deny.png', 'deny');
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    const denied = { allowedRootPaths: [path.join(os.tmpdir(), 'no-such-root')] };
    expect(await processor.pathToUri(file, EVENT_TIME_MS)).toBeNull();
    expect(await processor.pathToUri(file, EVENT_TIME_MS, denied)).toBeNull();
    expect(await processor.pathToUri(file, EVENT_TIME_MS, TMP_ALLOW)).not.toBeNull();
    // Cache must still honor roots if they change (no hot-reload today).
    expect(await processor.pathToUri(file, EVENT_TIME_MS, denied)).toBeNull();
    await processor.shutdown(100);
  });

  it('rejects a directory-symlink escape even when the lexical path is inside the root', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-mm-proc-'));
    tmpDirs.push(dir);
    const allowed = path.join(dir, 'allowed');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    const secret = path.join(outside, 'secret.png');
    fs.writeFileSync(secret, Buffer.concat([PNG_HDR, Buffer.from('escaped')]));
    fs.symlinkSync(outside, path.join(allowed, 'via'));
    const escaped = path.join(allowed, 'via', 'secret.png');
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    expect(await processor.pathToUri(escaped, EVENT_TIME_MS, {
      allowedRootPaths: mergeAllowedRootPaths([allowed]),
    })).toBeNull();
    await processor.shutdown(100);
  });

  it('rejects symlink targets even inside an allowed root', async () => {
    const real = writeTempPng('real.png', 'real');
    const link = path.join(path.dirname(real), 'alias.png');
    fs.symlinkSync(real, link);
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    expect(await processor.pathToUri(link, EVENT_TIME_MS, TMP_ALLOW)).toBeNull();
    await processor.shutdown(100);
  });

  it('rejects image-extension files whose magic is not an image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-mm-proc-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'secret.png');
    fs.writeFileSync(file, Buffer.from('not-an-image'));
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    expect(await processor.pathToUri(file, EVENT_TIME_MS, TMP_ALLOW)).toBeNull();
    await processor.shutdown(100);
  });

  it('times out a never-resolving stat and returns null', async () => {
    vi.resetModules();
    vi.doMock('../../../src/multimodal/resolve.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/multimodal/resolve.js')>();
      return {
        ...actual,
        lstatRegularImageFile: () => new Promise(() => {}),
      };
    });
    try {
      const { MultimodalProcessor: HungProcessor } = await import(
        '../../../src/multimodal/processor.js'
      );
      const file = writeTempPng('hang.png', 'hang');
      const uploader = new FakeUploader();
      const processor = new HungProcessor(STORAGE_BASE, uploader);
      const started = Date.now();
      expect(await processor.pathToUri(file, EVENT_TIME_MS, {
        ...TMP_ALLOW,
        deadlineMs: 40,
      })).toBeNull();
      expect(Date.now() - started).toBeLessThan(500);
      await processor.shutdown(100);
    } finally {
      vi.doUnmock('../../../src/multimodal/resolve.js');
      vi.resetModules();
    }
  });

  it('rejects pathToUri after shutdown', async () => {
    const file = writeTempPng('late.png', 'late');
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    await processor.shutdown(100);
    expect(await processor.pathToUri(file, undefined, TMP_ALLOW)).toBeNull();
  });
});


