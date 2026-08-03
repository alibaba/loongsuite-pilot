// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * decode-payload.mjs — 把 hook stdin 的原始字节解码为字符串,并修复
 * Cursor/Qoder 在中文 Windows 上的 UTF-8→GBK 双重编码。
 *
 * 背景:部分 host agent 会先把 UTF-8 的 hook 负载按系统代码页(GBK/CP936)解码成字符串,
 * 再以 UTF-8 重新编码后经 stdin 传入,导致中文乱码(ASCII/JSON 结构不受影响)。
 * 还原:对收到的字节做 gbkEncode(utf8Decode(bytes)),若结果是严格合法的 UTF-8 则采用,
 * 否则保留原始 UTF-8(正确输入天然走后者,无副作用)。
 *
 * 该纠偏原先在 PowerShell hook wrapper 里用 .NET 完成,但 WDAC 受限语言模式(CLM)禁止
 * .NET 静态调用,故整体移入 node —— node 不受 CLM 约束,PS 侧从此无需触碰字节。
 */

// char code point -> [lead, trail],首次使用时用内置 TextDecoder('gbk') 运行时反建,模块级缓存。
let GBK_ENCODE_MAP = null;

function buildGbkEncodeMap() {
  const map = new Map();
  // fatal:false → 无法映射的字节对解码为 U+FFFD,据此跳过。
  // 若当前 node 为 small-ICU 构建、不支持 'gbk',TextDecoder 构造会抛错 → 上层放弃纠偏。
  const dec = new TextDecoder('gbk', { fatal: false });
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue; // 0x7F 不是合法 GBK 尾字节
      pair[0] = lead;
      pair[1] = trail;
      const ch = dec.decode(pair);
      if (ch.length !== 1 || ch.charCodeAt(0) === 0xfffd) continue; // 未映射
      const cp = ch.charCodeAt(0);
      if (!map.has(cp)) map.set(cp, [lead, trail]);
    }
  }
  return map;
}

// 把字符串编码为 GBK 字节;遇到无法映射的非 ASCII 字符则抛错(上层据此放弃纠偏)。
function gbkEncode(str) {
  if (!GBK_ENCODE_MAP) GBK_ENCODE_MAP = buildGbkEncodeMap();
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      out.push(cp);
      continue;
    }
    const pair = GBK_ENCODE_MAP.get(cp);
    if (!pair) throw new Error('char not mappable to GBK: U+' + cp.toString(16));
    out.push(pair[0], pair[1]);
  }
  return Buffer.from(out);
}

/**
 * 把 hook stdin 原始字节解码为字符串:去 UTF-8 BOM + 修复 GBK 双重编码。
 * @param {Buffer} buf 原始 stdin 字节
 * @returns {string}
 */
export function decodePayload(buf) {
  if (!buf || buf.length === 0) return '';
  // 去 UTF-8 BOM (EF BB BF)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
  }
  const utf8 = buf.toString('utf-8');
  if (buf.length > 2) {
    try {
      const recovered = gbkEncode(utf8);
      // 严格 UTF-8 校验:仅当还原结果是合法 UTF-8 才采用(排除正确输入被误纠)。
      new TextDecoder('utf-8', { fatal: true }).decode(recovered);
      return recovered.toString('utf-8');
    } catch {
      // 非双重编码(或 gbk 不可用)——保留原始 UTF-8
    }
  }
  return utf8;
}
