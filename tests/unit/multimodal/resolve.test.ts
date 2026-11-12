import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeBlobContent,
  extFromMime,
  isPathInsideRoots,
  isRealPathInsideRoots,
  isUncOrDevicePath,
  joinStorageUri,
  canonicalizeRootPath,
  lstatRegularFile,
  mergeAllowedRootPaths,
  mimeFromMediaPath,
  normalizeLocalMediaPath,
  openNormalizedLocalMedia,
  sniffImageMime,
  modalityFromMime,
  yyyymmddFromUnixMs,
  yyyymmddLocal,
} from '../../../src/multimodal/resolve.js';

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-mm-resolve-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type FileHandleRead = Awaited<ReturnType<typeof fsp.open>>['read'];
type FileHandleReadBuffer = (
  this: unknown,
  buffer: NodeJS.ArrayBufferView,
  offset?: number | null,
  length?: number | null,
  position?: number | null,
) => Promise<{ bytesRead: number; buffer: NodeJS.ArrayBufferView }>;

async function withFileHandleRead(
  file: string,
  wrap: (orig: FileHandleReadBuffer) => FileHandleReadBuffer,
  run: () => Promise<void>,
): Promise<void> {
  const probe = await fsp.open(file, 'r');
  const proto = Object.getPrototypeOf(probe) as { read: FileHandleRead };
  await probe.close();
  const orig = proto.read as unknown as FileHandleReadBuffer;
  const spy = vi.spyOn(proto, 'read').mockImplementation(
    wrap(orig) as unknown as FileHandleRead,
  );
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
}

describe('multimodal resolve helpers', () => {
  it('decodes raw base64 content', () => {
    const bytes = Buffer.from('hello');
    const decoded = decodeBlobContent({
      type: 'blob',
      content: bytes.toString('base64'),
    });
    expect(decoded?.bytes.equals(bytes)).toBe(true);
  });

  it('returns null for empty content', () => {
    expect(decodeBlobContent({ type: 'blob', content: '' })).toBeNull();
    expect(decodeBlobContent({ type: 'blob', content: '   ' })).toBeNull();
  });

  it('returns null for non-base64 garbage that decodes empty', () => {
    // Buffer.from is lenient; strings that decode to zero bytes are rejected.
    expect(decodeBlobContent({ type: 'blob', content: '!!!!' })).toBeNull();
  });

  it('maps mime to extension', () => {
    expect(extFromMime('image/jpeg')).toBe('jpg');
    expect(extFromMime('image/png')).toBe('png');
    expect(extFromMime('video/mp4')).toBe('mp4');
    expect(extFromMime('video/quicktime')).toBe('mov');
    expect(extFromMime('video/webm')).toBe('webm');
    expect(extFromMime('video/x-matroska')).toBe('mkv');
    expect(extFromMime('video/x-msvideo')).toBe('avi');
    expect(extFromMime('application/octet-stream')).toBe('bin');
    expect(extFromMime('IMAGE/JPEG; charset=utf-8')).toBe('jpg');
    expect(extFromMime('unknown/type')).toBe('bin');
    expect(extFromMime('')).toBe('bin');
  });

  it('infers modality from mime prefix', () => {
    expect(modalityFromMime('image/png')).toBe('image');
    expect(modalityFromMime('audio/wav')).toBe('audio');
    expect(modalityFromMime('video/mp4')).toBe('video');
    expect(modalityFromMime('application/octet-stream')).toBeUndefined();
    expect(modalityFromMime('')).toBeUndefined();
  });

  it('joins storage uri without duplicate slashes', () => {
    expect(joinStorageUri('oss://bucket/prefix/', '20260804/abc.png')).toBe(
      'oss://bucket/prefix/20260804/abc.png',
    );
    expect(joinStorageUri('oss://bucket/prefix', '/20260804/abc.png')).toBe(
      'oss://bucket/prefix/20260804/abc.png',
    );
  });

  it('formats local yyyymmdd', () => {
    // Local-calendar constructors stay stable across CI timezones.
    expect(yyyymmddLocal(new Date(2026, 7, 4, 3, 50, 18))).toBe('20260804');
  });

  it('formats local yyyymmdd from time_unix_ms', () => {
    const local = new Date(2026, 7, 4, 15, 30, 0);
    expect(yyyymmddFromUnixMs(local.getTime())).toBe('20260804');
    expect(yyyymmddFromUnixMs(undefined, local)).toBe('20260804');
    expect(yyyymmddFromUnixMs(Number.NaN, local)).toBe('20260804');
  });

  it('uses local calendar day rather than UTC near midnight', () => {
    // 00:30 local on Jan 2 — east-of-UTC zones still have UTC on Jan 1.
    const localMorning = new Date(2026, 0, 2, 0, 30, 0);
    expect(yyyymmddLocal(localMorning)).toBe('20260102');
    if (localMorning.getTimezoneOffset() < 0) {
      const utc = `${localMorning.getUTCFullYear()}${String(localMorning.getUTCMonth() + 1).padStart(2, '0')}${String(localMorning.getUTCDate()).padStart(2, '0')}`;
      expect(utc).toBe('20260101');
    }
  });

  it('detects image extensions and mime types from path', () => {
    expect(mimeFromMediaPath('/a/b.png')).toBe('image/png');
    expect(mimeFromMediaPath('/a/b.JPEG')).toBe('image/jpeg');
    expect(mimeFromMediaPath('/a/b.webp')).toBe('image/webp');
    expect(mimeFromMediaPath('/a/b.txt')).toBeNull();
    expect(mimeFromMediaPath('')).toBeNull();
    expect(mimeFromMediaPath('/a/b.png?x=1')).toBeNull();
    expect(normalizeLocalMediaPath('/a/b.png?x=1')).toBeNull();
    expect(mimeFromMediaPath('/a/photo?.png')).toBe('image/png');
    expect(normalizeLocalMediaPath('/a/photo?.png')).toBe(path.resolve('/a/photo?.png'));
    expect(normalizeLocalMediaPath('not-an-image.txt')).toBeNull();
    expect(normalizeLocalMediaPath('\\\\server\\share\\a.png')).toBeNull();
    expect(normalizeLocalMediaPath('\\\\.\\pipe\\a.png')).toBeNull();
    expect(normalizeLocalMediaPath('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\a.png')).toBeNull();
    if (process.platform === 'win32') {
      expect(normalizeLocalMediaPath('\\\\?\\C:\\tmp\\a.png')).toBe(path.win32.resolve('C:\\tmp\\a.png'));
    } else {
      expect(normalizeLocalMediaPath('\\\\?\\C:\\tmp\\a.png')).toBeNull();
    }
  });

  it('stats and reads a local image path', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'x.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(file, bytes);

    const resolved = normalizeLocalMediaPath(file);
    expect(resolved).toBe(path.resolve(file));
    expect((await lstatRegularFile(resolved!))?.size).toBe(bytes.length);
    expect(mimeFromMediaPath(resolved!)).toBe('image/png');

    const loaded = await openNormalizedLocalMedia(resolved!);
    expect(loaded).toMatchObject({
      bytes,
      mime_type: 'image/png',
      size: bytes.length,
    });
  });

  it('rejects missing file, directory, and non-image', async () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'missing.png');
    expect(normalizeLocalMediaPath(missing)).toBe(path.resolve(missing));
    expect(await lstatRegularFile(path.resolve(missing))).toBeNull();
    expect(normalizeLocalMediaPath(path.join(dir, 'a.txt'))).toBeNull();

    const empty = path.join(dir, 'empty.png');
    fs.writeFileSync(empty, Buffer.alloc(0));
    expect((await lstatRegularFile(path.resolve(empty)))?.size).toBe(0);

    const asDir = path.join(dir, 'folder.png');
    fs.mkdirSync(asDir);
    expect(await lstatRegularFile(path.resolve(asDir))).toBeNull();
  });

  it('detects UNC and device paths', () => {
    expect(isUncOrDevicePath('\\\\server\\share\\a.png')).toBe(true);
    expect(isUncOrDevicePath('//server/share/a.png')).toBe(true);
    expect(isUncOrDevicePath('\\\\?\\UNC\\server\\share\\a.png')).toBe(true);
    expect(isUncOrDevicePath('\\\\.\\UNC\\server\\share\\a.png')).toBe(true);
    expect(isUncOrDevicePath('\\\\.\\pipe\\a.png')).toBe(true);
    expect(isUncOrDevicePath('//./pipe/a.png')).toBe(true);
    expect(isUncOrDevicePath('\\\\.\\GLOBALROOT\\Device\\HarddiskVolume1\\a.png')).toBe(true);
    expect(isUncOrDevicePath('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\a.png')).toBe(true);
    expect(isUncOrDevicePath('\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\a.png')).toBe(true);
    expect(isUncOrDevicePath('\\\\.\\C:\\tmp\\a.png')).toBe(true);
    expect(isUncOrDevicePath('\\??\\C:\\tmp\\a.png')).toBe(true);
    expect(isUncOrDevicePath('\\\\?\\C:\\tmp\\a.png')).toBe(false);
    expect(isUncOrDevicePath('//?/C:/tmp/a.png')).toBe(false);
    expect(isUncOrDevicePath('/tmp/a.png')).toBe(false);
  });

  it('checks path containment without following parent escapes', () => {
    const root = path.join(os.tmpdir(), 'mm-root');
    expect(isPathInsideRoots(path.join(root, 'a.png'), [root])).toBe(true);
    expect(isPathInsideRoots(path.join(root, '..', 'outside.png'), [root])).toBe(false);
    expect(isPathInsideRoots(root, [root])).toBe(true);
  });

  it('canonicalizes existing roots once and leaves missing paths lexical', () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'does-not-exist');
    expect(canonicalizeRootPath(dir)).toBe(fs.realpathSync(dir));
    expect(canonicalizeRootPath(missing)).toBe(path.resolve(missing));
    const merged = mergeAllowedRootPaths([dir, os.tmpdir()]);
    expect(merged).toContain(fs.realpathSync(dir));
    expect(merged).toContain(fs.realpathSync(os.tmpdir()));
  });

  it('merges caller defaults with user roots, expands ~, and dedupes', () => {
    const tmp = canonicalizeRootPath(path.join(os.homedir(), '.qoder', 'tmp'));
    const foo = canonicalizeRootPath('~/workspace/foo');
    const merged = mergeAllowedRootPaths([tmp, tmp, '  '], ['~/workspace/foo', tmp]);
    expect(merged).toContain(tmp);
    expect(merged).toContain(foo);
    expect(merged.filter(p => p === tmp)).toHaveLength(1);
  });

  it('rejects a file reached through a directory symlink outside the root', async () => {
    const dir = makeTempDir();
    const allowed = path.join(dir, 'allowed');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    const secret = path.join(outside, 'secret.png');
    fs.writeFileSync(secret, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.symlinkSync(outside, path.join(allowed, 'via'));
    const escaped = path.join(allowed, 'via', 'secret.png');
    const roots = mergeAllowedRootPaths([allowed]);
    expect(isPathInsideRoots(escaped, [allowed])).toBe(true);
    expect(await isRealPathInsideRoots(escaped, roots)).toBe(false);
    expect(await openNormalizedLocalMedia(path.resolve(escaped), undefined, roots)).toBeNull();
  });

  it('rejects when a parent directory is swapped to a symlink around open', async () => {
    const dir = makeTempDir();
    const allowed = path.join(dir, 'allowed');
    const outside = path.join(dir, 'outside');
    const via = path.join(allowed, 'via');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    fs.mkdirSync(via);
    const png = (label: string) => Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(label),
    ]);
    fs.writeFileSync(path.join(via, 'pic.png'), png('inside'));
    fs.writeFileSync(path.join(outside, 'pic.png'), png('outside'));
    const roots = mergeAllowedRootPaths([allowed]);
    const target = path.resolve(path.join(via, 'pic.png'));
    const parked = `${via}.parked`;
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        open: async (p: Parameters<typeof actual.open>[0], flags?: Parameters<typeof actual.open>[1]) => {
          if (path.resolve(String(p)) === target) {
            fs.renameSync(via, parked);
            fs.symlinkSync(outside, via);
          }
          const fh = await actual.open(p, flags);
          if (fs.existsSync(via) && fs.lstatSync(via).isSymbolicLink()) {
            fs.unlinkSync(via);
            fs.renameSync(parked, via);
          }
          return fh;
        },
      };
    });
    try {
      const { openNormalizedLocalMedia: openWithSwap } = await import(
        '../../../src/multimodal/resolve.js'
      );
      expect(await openWithSwap(target, undefined, roots)).toBeNull();
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('sniffs image magic and rejects non-images', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('not-an-image'))).toBeNull();
  });

  it('reads a video only when the suffix and header are the same family', async () => {
    const dir = makeTempDir();
    const ftyp = (brand: string) => {
      const bytes = Buffer.alloc(16);
      bytes.write('ftyp', 4, 'ascii');
      bytes.write(brand, 8, 4, 'ascii');
      return bytes;
    };
    const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    const avi = Buffer.alloc(12);
    avi.write('RIFF', 0, 'ascii');
    avi.write('AVI ', 8, 'ascii');
    const wave = Buffer.alloc(12);
    wave.write('RIFF', 0, 'ascii');
    wave.write('WAVE', 8, 'ascii');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

    const read = async (name: string, bytes: Buffer) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      return openNormalizedLocalMedia(path.resolve(file));
    };

    expect((await read('clip.mp4', ftyp('isom')))?.mime_type).toBe('video/mp4');
    expect((await read('clip.mov', ftyp('qt  ')))?.mime_type).toBe('video/quicktime');
    expect((await read('clip.webm', ebml))?.mime_type).toBe('video/webm');
    expect((await read('clip.avi', avi))?.mime_type).toBe('video/x-msvideo');
    expect(await read('audio.mp4', ftyp('M4A '))).toBeNull();
    expect(await read('clip.mp4', png)).toBeNull();
    expect(await read('clip.mp4', ebml)).toBeNull();
    expect(await read('clip.webm', ftyp('isom'))).toBeNull();
    expect(await read('clip.avi', wave)).toBeNull();
    expect(await read('song.m4a', ftyp('isom'))).toBeNull();
    expect((await read('photo.png', jpeg))?.mime_type).toBe('image/jpeg');
    expect(await read('photo.png', ftyp('isom'))).toBeNull();
    expect(normalizeLocalMediaPath('/a/b.mp4?x=1')).toBeNull();
  });

  it('rejects a symlink target', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'x.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(file, bytes);
    const link = path.join(dir, 'y.png');
    fs.symlinkSync(file, link);
    expect(await lstatRegularFile(path.resolve(link))).toBeNull();
    expect(await openNormalizedLocalMedia(path.resolve(link))).toBeNull();
    const loaded = await openNormalizedLocalMedia(path.resolve(file));
    expect(loaded?.mime_type).toBe('image/png');
    expect(loaded?.bytes.equals(bytes)).toBe(true);
  });

  it('assembles a full image across short FileHandle.read calls', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'x.png');
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 7),
    ]);
    fs.writeFileSync(file, bytes);

    await withFileHandleRead(file, orig => async function (this: unknown, buffer, offset, length, position) {
      return orig.call(this, buffer, offset, Math.min(length ?? buffer.byteLength, 5), position);
    }, async () => {
      const loaded = await openNormalizedLocalMedia(path.resolve(file));
      expect(loaded?.bytes.equals(bytes)).toBe(true);
      expect(loaded?.mime_type).toBe('image/png');
    });
  });

  it('rejects when reads end before the stated size', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'x.png');
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 7),
    ]);
    fs.writeFileSync(file, bytes);

    let first = true;
    await withFileHandleRead(file, orig => async function (this: unknown, buffer, offset, length, position) {
      if (!first) return { bytesRead: 0, buffer };
      first = false;
      return orig.call(this, buffer, offset, Math.min(length ?? buffer.byteLength, 8), position);
    }, async () => {
      expect(await openNormalizedLocalMedia(path.resolve(file))).toBeNull();
    });
  });

  it('rejects when the file size changes during read', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'x.png');
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 7),
    ]);
    fs.writeFileSync(file, bytes);

    await withFileHandleRead(file, orig => async function (this: unknown, buffer, offset, length, position) {
      const result = await orig.call(this, buffer, offset, length, position);
      fs.appendFileSync(file, Buffer.from([1]));
      return result;
    }, async () => {
      expect(await openNormalizedLocalMedia(path.resolve(file))).toBeNull();
    });
  });

  it('returns null when abort fires during read', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'x.png');
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 7),
    ]);
    fs.writeFileSync(file, bytes);
    const ac = new AbortController();
    await withFileHandleRead(file, orig => async function (this: unknown, buffer, offset, length, position) {
      ac.abort();
      return orig.call(this, buffer, offset, length, position);
    }, async () => {
      expect(await openNormalizedLocalMedia(path.resolve(file), undefined, undefined, ac.signal)).toBeNull();
    });
  });

  it('rejects an oversized file without allocating the whole file', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'huge.png');
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(200, 1),
    ]));
    const maxBytes = 32;
    const allocSpy = vi.spyOn(Buffer, 'allocUnsafe');
    try {
      expect(await openNormalizedLocalMedia(path.resolve(file), maxBytes)).toBeNull();
      expect(allocSpy.mock.calls.map(([n]) => n)).toEqual([maxBytes + 1]);
    } finally {
      allocSpy.mockRestore();
    }
  });
});
