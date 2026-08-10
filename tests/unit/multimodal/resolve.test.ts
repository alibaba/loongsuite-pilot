import { describe, expect, it } from 'vitest';
import {
  decodeBlobContent,
  extFromMime,
  joinStorageUri,
  modalityFromMime,
  yyyymmddFromUnixMs,
  yyyymmddUTC,
} from '../../../src/multimodal/resolve.js';

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
});
