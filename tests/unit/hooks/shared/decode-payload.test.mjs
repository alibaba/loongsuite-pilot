import { describe, it, expect, afterEach } from 'vitest';
import { decodePayload } from '../../../../assets/hooks/shared/decode-payload.mjs';

// decodePayload reads process.platform at call time, so overriding the property before a call
// is enough — no module re-import required.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

// Simulate a host that mis-decoded UTF-8 bytes with the system ANSI code page and re-encoded them
// as UTF-8 — the exact double-encoding decodePayload is meant to repair on Windows. The ACP is
// CP936 on Chinese Windows and CP1252 on en-US Windows; both were observed in production.
function doubleEncodeAs(text, codePage) {
  const utf8Bytes = Buffer.from(text, 'utf-8');
  const asCodePage = new TextDecoder(codePage).decode(utf8Bytes);
  return Buffer.from(asCodePage, 'utf-8');
}

function doubleEncode(text) {
  return doubleEncodeAs(text, 'gbk');
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

  // --- Regression: CP936 single-byte mappings (the '€' abort) --------------------------------
  // The encode map only enumerated 2-byte GBK pairs, but 0x80 is a SINGLE-byte CP936 mapping to
  // '€' (U+20AC). Any source char whose code point is a multiple of 64 ends its UTF-8 encoding
  // with 0x80 — 一 (U+4E00), 什 (U+4EC0), 最 (U+6700), 327 such chars in the CJK block alone —
  // so the mojibake contained '€', the map lookup threw, and the ENTIRE payload stayed garbled.
  // The prior fixtures ('中文', '测试日志') never produce 0x80, which is why CI stayed green.
  it('repairs CP936 mojibake containing € (single-byte 0x80 mapping)', () => {
    setPlatform('win32');
    for (const text of ['{"c":"一"}', '{"c":"什"}', '{"c":"最"}', '{"c":"稀"}', '{"c":"耀"}']) {
      const mojibake = doubleEncode(text);
      expect(mojibake.toString('utf-8')).toContain('€'); // fixture really hits the trigger
      expect(decodePayload(mojibake)).toBe(text);
    }
  });

  // --- New: CP1252 (en-US Windows) ------------------------------------------------------------
  // The ACP is not always CP936. On en-US Windows the host agent decodes with CP1252, producing
  // 'å¤ªä¸š'-style mojibake; gbkEncode threw on 'ä' (U+00E4) so nothing was ever repaired there.
  // CP1252 is a lossless 256-byte table, so these payloads recover exactly — no byte is ever lost.
  it('repairs CP1252 double-encoded payloads on Windows', () => {
    setPlatform('win32');
    const cases = [
      '{"c":"中文"}',
      '{"c":"一下"}',
      '{"c":"帮我看一下这个问题"}',
      '{"workspace":{"path":"C:/Users/太业/项目"}}',
      '{"status":"完成","summary":"已修复三个缺陷"}',
    ];
    for (const text of cases) {
      expect(decodePayload(doubleEncodeAs(text, 'windows-1252'))).toBe(text);
    }
  });

  it('does not run the CP1252 repair off Windows', () => {
    const mojibake = doubleEncodeAs('{"c":"中文"}', 'windows-1252');
    for (const platform of ['darwin', 'linux']) {
      setPlatform(platform);
      expect(decodePayload(mojibake)).toBe(mojibake.toString('utf-8'));
    }
  });

  // --- New: partial repair around bytes the host agent destroyed ------------------------------
  // CP936 decoding emits U+FFFD for illegal byte combinations and the source byte is gone for
  // good (an odd number of CJK chars followed by an ASCII byte < 0x40 such as '"' or ',' — close
  // to half of real Chinese-Windows payloads). Aborting the whole payload over one lost byte left
  // the correction effectively useless there, so each U+FFFD-delimited run is repaired on its own
  // and only the destroyed character stays marked as U+FFFD.
  it('repairs around a destroyed byte, keeping one U+FFFD marker (CP936)', () => {
    setPlatform('win32');
    const cases = [
      ['{"c":"一下"}', '{"c":"一\ufffd"}'],
      ['{"c":"什么"}', '{"c":"什\ufffd"}'],
      ['{"c":"帮我看一下这个问题"}', '{"c":"帮我看一下这个问\ufffd"}'],
      ['{"status":"完成","summary":"已修复三个缺陷"}', '{"status":"完成","summary":"已修复三个缺\ufffd"}'],
    ];
    for (const [text, expected] of cases) {
      const mojibake = doubleEncode(text);
      expect(mojibake.toString('utf-8')).toContain('\ufffd'); // fixture really loses a byte
      expect(decodePayload(mojibake)).toBe(expected);
    }
  });

  // Nothing is ever guessed: if the destroyed character was the payload's ONLY non-ASCII content,
  // the "repair" would just delete it, so the original mojibake is kept instead. This also closes
  // the false-positive door for a clean payload that happens to carry a literal U+FFFD.
  it('keeps the original when the only non-ASCII char was destroyed', () => {
    setPlatform('win32');
    const mojibake = doubleEncode('{"c":"上"}');
    expect(decodePayload(mojibake)).toBe(mojibake.toString('utf-8'));
  });

  it('preserves clean payloads containing € or a literal U+FFFD on Windows', () => {
    setPlatform('win32');
    for (const text of ['{"c":"€100"}', '{"c":"一下"}', '{"c":"坏\ufffd字"}', '{"c":"café"}']) {
      expect(decodePayload(Buffer.from(text, 'utf-8'))).toBe(text);
    }
  });

  // Bulk sweep: no clean CJK payload may ever be rewritten, on any of the code pages tried.
  it('never corrupts clean CJK payloads (bulk sweep)', () => {
    setPlatform('win32');
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 500; i++) {
      let s = '';
      for (let j = 0, n = 1 + Math.floor(rnd() * 12); j < n; j++) {
        s += String.fromCodePoint(0x4e00 + Math.floor(rnd() * 0x51a6));
      }
      const text = JSON.stringify({ content: s, n: 42 });
      expect(decodePayload(Buffer.from(text, 'utf-8'))).toBe(text);
    }
  });
});
