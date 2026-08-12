import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultimodalProcessor } from '../../../src/multimodal/processor.js';
import {
  MAX_MULTIMODAL_BASE64_CHARS,
  MAX_MULTIMODAL_DATA_SIZE,
  MAX_MULTIMODAL_PENDING_UPLOADS,
} from '../../../src/multimodal/types.js';
import { FakeUploader } from './fake-uploader.js';

const STORAGE_BASE = 'oss://bucket/pilot-mm';
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTempPng(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-mm-proc-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(content));
  return file;
}

describe('MultimodalProcessor.blobToUri', () => {
  it('returns optimistic uri and enqueues upload', async () => {
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    const bytes = Buffer.from('png-bytes');
    const result = processor.blobToUri({
      content: bytes.toString('base64'),
      mime_type: 'image/png',
      modality: 'image',
      time_unix_ms: 1_700_000_000_000,
    });

    expect(result).not.toBeNull();
    expect(result!.uri).toMatch(/^oss:\/\/bucket\/pilot-mm\/20231114\/[a-f0-9]{64}\.png$/);
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

    const result = await processor.pathToUri(file, 1_700_000_000_000);
    expect(result).not.toBeNull();
    expect(result!.mime_type).toBe('image/png');
    expect(result!.uri).toMatch(/^oss:\/\/bucket\/pilot-mm\/20231114\/[a-f0-9]{64}\.png$/);

    await processor.shutdown(1000);
    expect(uploader.items).toHaveLength(1);
  });

  it('LRU-caches path→uri so the same path is uploaded once', async () => {
    const file = writeTempPng('dup.png', 'same-bytes');
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);

    const a = await processor.pathToUri(file);
    const b = await processor.pathToUri(path.join(path.dirname(file), '.', 'dup.png'));
    expect(a?.uri).toBe(b?.uri);

    await processor.shutdown(1000);
    expect(uploader.items).toHaveLength(1);
  });

  it('shares one in-flight read for concurrent pathToUri calls', async () => {
    const file = writeTempPng('race.png', 'race');
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);

    const [a, b] = await Promise.all([
      processor.pathToUri(file),
      processor.pathToUri(file),
    ]);
    expect(a?.uri).toBe(b?.uri);

    await processor.shutdown(1000);
    expect(uploader.items).toHaveLength(1);
  });

  it('caches null for missing / non-image paths until eviction', async () => {
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    expect(await processor.pathToUri('/no/such/image.png')).toBeNull();
    expect(await processor.pathToUri('/no/such/image.png')).toBeNull();
    expect(uploader.items).toHaveLength(0);
    await processor.shutdown(100);
  });

  it('rejects pathToUri after shutdown', async () => {
    const file = writeTempPng('late.png', 'late');
    const uploader = new FakeUploader();
    const processor = new MultimodalProcessor(STORAGE_BASE, uploader);
    await processor.shutdown(100);
    expect(await processor.pathToUri(file)).toBeNull();
  });
});


