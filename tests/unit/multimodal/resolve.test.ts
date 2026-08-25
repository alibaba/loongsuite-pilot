import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeBlobContent,
  extFromMime,
  isImageFilePath,
  isPathInsideRoots,
  isRealPathInsideRoots,
  isUncOrDevicePath,
  joinStorageUri,
  canonicalizeRootPath,
  lstatRegularImageFile,
  mergeAllowedRootPaths,
  mimeFromImagePath,
  normalizeLocalImagePath,
  openNormalizedLocalImage,
  sniffImageMime,
  modalityFromMime,
  statImagePath,
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
    expect(isImageFilePath('/a/b.png')).toBe(true);
    expect(isImageFilePath('/a/b.JPEG')).toBe(true);
    expect(mimeFromImagePath('/a/b.webp')).toBe('image/webp');
    expect(mimeFromImagePath('/a/b.txt')).toBeNull();
    expect(isImageFilePath('')).toBe(false);
    expect(mimeFromImagePath('/a/b.png?x=1')).toBe('image/png');
    expect(normalizeLocalImagePath('/a/b.png?x=1')).toBe(path.resolve('/a/b.png'));
    expect(normalizeLocalImagePath('not-an-image.txt')).toBeNull();
    expect(normalizeLocalImagePath('\\\\server\\share\\a.png')).toBeNull();
  });

  it('stats and reads a local image path', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'x.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(file, bytes);

    const stated = await statImagePath(file);
    expect(stated).toMatchObject({
      mime_type: 'image/png',
      size: bytes.length,
    });
    expect(stated?.mtimeMs).toEqual(expect.any(Number));
    expect(stated?.resolvedPath).toBe(path.resolve(file));

    const loaded = await openNormalizedLocalImage(stated!.resolvedPath);
    expect(loaded).toMatchObject({
      bytes,
      mime_type: 'image/png',
      size: bytes.length,
    });
  });

  it('statImagePath returns null for missing file, directory, and non-image', async () => {
    const dir = makeTempDir();
    expect(await statImagePath(path.join(dir, 'missing.png'))).toBeNull();
    expect(await statImagePath(path.join(dir, 'a.txt'))).toBeNull();

    const empty = path.join(dir, 'empty.png');
    fs.writeFileSync(empty, Buffer.alloc(0));
    expect(await statImagePath(empty)).toMatchObject({ size: 0, mime_type: 'image/png' });

    const asDir = path.join(dir, 'folder.png');
    fs.mkdirSync(asDir);
    expect(await statImagePath(asDir)).toBeNull();
  });

  it('detects UNC and device paths', () => {
    expect(isUncOrDevicePath('\\\\server\\share\\a.png')).toBe(true);
    expect(isUncOrDevicePath('//server/share/a.png')).toBe(true);
    expect(isUncOrDevicePath('\\\\?\\UNC\\server\\share\\a.png')).toBe(true);
    expect(isUncOrDevicePath('\\\\?\\C:\\tmp\\a.png')).toBe(false);
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
    expect(await openNormalizedLocalImage(path.resolve(escaped), undefined, roots)).toBeNull();
  });

  it('sniffs image magic and rejects non-images', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('not-an-image'))).toBeNull();
  });

  it('rejects a symlink target', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'x.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(file, bytes);
    const link = path.join(dir, 'y.png');
    fs.symlinkSync(file, link);
    expect(await lstatRegularImageFile(path.resolve(link))).toBeNull();
    expect(await statImagePath(link)).toBeNull();
    expect(await openNormalizedLocalImage(path.resolve(link))).toBeNull();
    const loaded = await openNormalizedLocalImage(path.resolve(file));
    expect(loaded?.mime_type).toBe('image/png');
    expect(loaded?.bytes.equals(bytes)).toBe(true);
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
      expect(await openNormalizedLocalImage(path.resolve(file), maxBytes)).toBeNull();
      expect(allocSpy.mock.calls.map(([n]) => n)).toEqual([maxBytes + 1]);
    } finally {
      allocSpy.mockRestore();
    }
  });
});
