import { describe, it, expect, afterEach } from 'vitest';
import { decodePayload } from '../../../../assets/hooks/shared/decode-payload.mjs';

// decodePayload reads process.platform at call time, so overriding the property before a call
// is enough — no module re-import required.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

// Simulate a host that mis-decoded UTF-8 bytes as GBK (CP936) and re-encoded them as UTF-8 —
// the exact double-encoding decodePayload is meant to repair on Chinese Windows.
function doubleEncode(text) {
  const utf8Bytes = Buffer.from(text, 'utf-8');
  const asGbk = new TextDecoder('gbk').decode(utf8Bytes);
  return Buffer.from(asGbk, 'utf-8');
}

describe('decodePayload', () => {
  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('returns empty string for empty or nullish input', () => {
    expect(decodePayload(Buffer.alloc(0))).toBe('');
    expect(decodePayload(undefined)).toBe('');
    expect(decodePayload(null)).toBe('');
  });

  it('strips a UTF-8 BOM regardless of platform', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf-8')]);
    setPlatform('linux');
    expect(decodePayload(withBom)).toBe('{"a":1}');
    setPlatform('win32');
    expect(decodePayload(withBom)).toBe('{"a":1}');
  });

  it('leaves clean ASCII untouched on every platform', () => {
    const buf = Buffer.from('{"tool":"Read","ok":true}', 'utf-8');
    for (const platform of ['darwin', 'linux', 'win32']) {
      setPlatform(platform);
      expect(decodePayload(buf)).toBe('{"tool":"Read","ok":true}');
    }
  });

  // --- C1 regression: the GBK correction must NOT run off Windows -------------------------
  // The correction lived in a Windows-only PowerShell wrapper; porting it to node dropped the
  // implicit platform scope, so clean isolated CJK (whose GBK bytes happen to be valid UTF-8)
  // was silently corrupted on macOS/Linux.
  it('preserves clean UTF-8 CJK on non-Windows platforms', () => {
    const cases = ['业', '中文', '{"serviceNamePrefix":"支付网关"}', '测试'];
    for (const platform of ['darwin', 'linux']) {
      setPlatform(platform);
      for (const text of cases) {
        expect(decodePayload(Buffer.from(text, 'utf-8'))).toBe(text);
      }
    }
  });

  it('never rewrites bytes on non-Windows (platform gate short-circuits before gbkEncode)', () => {
    // A buffer that WOULD be rewritten on win32 must pass through verbatim off Windows.
    const mojibake = doubleEncode('测试日志');
    setPlatform('darwin');
    expect(decodePayload(mojibake)).toBe(mojibake.toString('utf-8'));
  });

  // --- Windows behaviour: the intended correction still works --------------------------------
  it('repairs UTF-8→GBK double-encoded multi-char CJK on Windows', () => {
    setPlatform('win32');
    for (const text of ['中文', '测试日志', '中文abc123']) {
      expect(decodePayload(doubleEncode(text))).toBe(text);
    }
  });

  it('leaves clean ASCII untouched on Windows (non-ASCII precheck skips correction)', () => {
    setPlatform('win32');
    const buf = Buffer.from('{"session_id":"abc-123","n":42}', 'utf-8');
    expect(decodePayload(buf)).toBe('{"session_id":"abc-123","n":42}');
  });

  // --- Regression: clean UTF-8 CJK must NOT be corrupted on Windows either -------------------
  // The win32 gate stopped the false-correction on macOS/Linux, but the strict-UTF-8 check alone
  // still misfires on Windows for isolated CJK whose GBK bytes happen to be valid UTF-8 — notably
  // '业' (GBK D2 B5 == UTF-8 U+04B5 'ҵ'). The inflation criterion (mojibake code points must
  // exceed the recovered string's) closes this: clean input never inflates, so it is preserved.
  it('preserves clean UTF-8 CJK on Windows (inflation criterion rejects false correction)', () => {
    setPlatform('win32');
    const cases = [
      '业',
      '{"user":"业"}',
      '{"cwd":"C:/Users/业/proj"}',
      '{"a":"业","b":1}',
      '{"serviceNamePrefix":"支付网关"}',
      '中文',
      '测试日志',
      '你好world',
    ];
    for (const text of cases) {
      expect(decodePayload(Buffer.from(text, 'utf-8'))).toBe(text);
    }
  });

  // The inflation criterion must not weaken any genuine repair: every multi-char mojibake the
  // prior code recovered still recovers (the double-encoded intermediate has more code points
  // than the clean original). Clean-input preservation above is the only added behavior.
  it('still repairs genuine multi-char double-encoded CJK on Windows', () => {
    setPlatform('win32');
    for (const text of ['中文', '测试日志', '中文abc123']) {
      expect(decodePayload(doubleEncode(text))).toBe(text);
    }
  });
});
