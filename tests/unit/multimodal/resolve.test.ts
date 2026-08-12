import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeBlobContent,
  extFromMime,
  isImageFilePath,
  joinStorageUri,
  mimeFromImagePath,
  modalityFromMime,
  readImagePathBytes,
  statImagePath,
  yyyymmddFromUnixMs,
  yyyymmddUTC,
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

  it('formats UTC yyyymmdd', () => {
    expect(yyyymmddUTC(new Date('2026-08-04T03:50:18.354Z'))).toBe('20260804');
  });

  it('formats UTC yyyymmdd from time_unix_ms', () => {
    // 2026-08-04T03:50:18.354Z
    expect(yyyymmddFromUnixMs(1_785_815_418_354)).toBe('20260804');
    expect(yyyymmddFromUnixMs(undefined, new Date('2026-08-04T03:50:18.354Z'))).toBe('20260804');
    expect(yyyymmddFromUnixMs(Number.NaN, new Date('2026-08-04T03:50:18.354Z'))).toBe('20260804');
  });

  it('detects image extensions and mime types from path', () => {
    expect(isImageFilePath('/a/b.png')).toBe(true);
    expect(isImageFilePath('/a/b.JPEG')).toBe(true);
    expect(mimeFromImagePath('/a/b.webp')).toBe('image/webp');
    expect(mimeFromImagePath('/a/b.txt')).toBeNull();
    expect(isImageFilePath('')).toBe(false);
    expect(mimeFromImagePath('/a/b.png?x=1')).toBe('image/png');
  });

  it('stats and reads a local image path', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'x.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    fs.writeFileSync(file, bytes);

    const stated = await statImagePath(file);
    expect(stated).toMatchObject({
      mime_type: 'image/png',
      size: bytes.length,
    });
    expect(stated?.resolvedPath).toBe(path.resolve(file));

    const loaded = await readImagePathBytes(stated!);
    expect(loaded).toEqual({
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
});
