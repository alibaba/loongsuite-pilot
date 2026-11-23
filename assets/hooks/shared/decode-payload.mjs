// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * decode-payload.mjs — 把 hook stdin 的原始字节解码为字符串,并修复
 * Cursor/Qoder 在 Windows 上的 UTF-8→ANSI 代码页双重编码。
 *
 * 背景:Windows 上部分 host agent(Cursor/Qoder)会先把 UTF-8 的 hook 负载按**系统 ANSI 代码页(ACP)**
 * 解码成字符串,再以 UTF-8 重新编码后经 stdin 传入,导致非 ASCII 乱码(ASCII/JSON 结构不受影响)。
 * ACP 取决于系统区域:中文 Windows 是 CP936(GBK),en-US 等西文 Windows 是 CP1252 —— 两者都在线上实测到,
 * 故依次尝试两张表。还原:对收到的字节做 cpEncode(utf8Decode(bytes)),若结果通过下面两道判据则采用。
 *
 * 该纠偏原先在 PowerShell hook wrapper 里用 .NET 完成,但 WDAC 受限语言模式(CLM)禁止
 * .NET 静态调用,故整体移入 node —— node 不受 CLM 约束,PS 侧从此无需触碰字节。
 * 注意:原 PowerShell 版本是 .ps1、只在 Windows 运行,纠偏只作用于 Windows;移入 node 后必须显式限定
 * process.platform === 'win32',否则在 macOS/Linux 上会误纠合法 UTF-8(严格 UTF-8 校验无法排除孤立 CJK 误纠)。
 * 即便限定 win32,严格 UTF-8 校验仍不足以排除干净单 CJK 的误纠(如「业」的 GBK 字节 D2 B5 恰是合法
 * UTF-8 的 U+04B5),故再加一道"膨胀判据":真正的双重编码必然使收到的中间串 code point 数 > 还原串
 * (UTF-8 的 CJK 占 3 字节,被误当 GBK 每字符 2 字节解码后字符数变多),仅当膨胀时才采纳,消除假阳性。
 *
 * 部分丢字节的情况:CP936 解码遇到非法/未定义的字节组合会吐出一个 U+FFFD,源字节就此永久丢失
 * (最常见:奇数个 CJK 之后紧跟 '"' ',' 等 < 0x40 的 ASCII 字节,末字节被当成首字节而报错)。
 * 实测这类负载在中文 Windows 上占比接近一半,若因此放弃整条负载,等于纠偏对中文 Windows 基本无效。
 * 故按 U+FFFD 把乱码切段、逐段还原,再用 U+FFFD 重新拼接:丢掉的那一个字符仍标记为 U+FFFD,
 * 其余内容全部恢复可读。切口两侧允许存在被吃掉的不完整 UTF-8 序列(丢的字节必然落在某个字符内部),
 * 段内部仍走严格 UTF-8 校验,不做任何字节猜测(不伪造内容)。
 */

// 待尝试的代码页。顺序有讲究:CP936 乱码里几乎全是 CJK 字符,CP1252 编不出来会立刻抛错、安全回退;
// 反之 CP936 每个非 ASCII 字符输出 2 字节,对 CP1252 乱码存在极小概率凑出合法 UTF-8 并通过膨胀判据,
// 故先试单字节的 CP1252,再试 CP936。
const CODE_PAGES = [
  { label: 'windows-1252', multiByte: false },
  { label: 'gbk', multiByte: true },
];

// label -> (char code point -> bytes[]);首次使用时用内置 TextDecoder 运行时反建,模块级缓存
// (不可用的代码页缓存 null,避免每条负载重复构建再抛错)。
const ENCODE_MAPS = new Map();

function buildEncodeMap(label, multiByte) {
  const map = new Map();
  // fatal:false → 无法映射的字节(对)解码为 U+FFFD,据此跳过。
  // 若当前 node 为 small-ICU 构建、不支持该 label,TextDecoder 构造会抛错 → 该代码页记为不可用。
  const dec = new TextDecoder(label, { fatal: false });
  const single = new Uint8Array(1);
  // 先建单字节映射,使其优先于双字节项。CP936 的 0x80 是**单字节**的 '€'(U+20AC):
  // 只要源负载里出现字节 0x80(码位为 64 的倍数的 UTF-8 字符,如「一」「什」「最」的末字节),
  // 旧版只枚举双字节对的编码表就查不到 '€' 而抛错,导致整条负载放弃纠偏。
  for (let b = 0x80; b <= 0xff; b++) {
    single[0] = b;
    const ch = dec.decode(single);
    if (ch.length !== 1 || ch.charCodeAt(0) === 0xfffd) continue; // 未映射(如 GBK 的首字节)
    map.set(ch.charCodeAt(0), [b]);
  }
  if (multiByte) {
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
  }
  return map;
}

function getEncodeMap(label, multiByte) {
  if (!ENCODE_MAPS.has(label)) {
    let map = null;
    try {
      map = buildEncodeMap(label, multiByte);
    } catch {
      map = null; // 该 node 构建不支持此代码页
    }
    ENCODE_MAPS.set(label, map);
  }
  const map = ENCODE_MAPS.get(label);
  if (!map) throw new Error('code page unavailable: ' + label);
  return map;
}

// 按指定代码页把字符串编码回字节;遇到无法映射的非 ASCII 字符则抛错(上层据此换表/放弃纠偏)。
function encodeToCodePage(str, label, multiByte) {
  const map = getEncodeMap(label, multiByte);
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      out.push(cp);
      continue;
    }
    const bytes = map.get(cp);
    if (!bytes) throw new Error('char not mappable to ' + label + ': U+' + cp.toString(16));
    for (const b of bytes) out.push(b);
  }
  return Buffer.from(out);
}

// host agent 解码失败处留下的替换字符 —— 既是切段依据,也是还原结果里"此处字节已丢失"的标记。
// 用转义而非字面量:这个字符本身就是编码事故的产物,写成字面量在任何一次文件转码里都可能被再次破坏。
const LOST = '\uFFFD';

// 严格解码一段还原出的字节。trimHead/trimTail 表示该段紧邻一个丢字节的切口:
// 丢掉的字节必然落在某个 UTF-8 字符内部,故切口一侧会残留不完整序列,允许丢弃(只丢那一个字符,
// 由调用方补回 U+FFFD 标记);段内部一律走严格校验,任何真实的非法字节都会抛错、放弃纠偏。
function decodeSegment(bytes, trimHead, trimTail) {
  let start = 0;
  let end = bytes.length;
  // 段首残留的续字节(10xxxxxx):它们所属字符的首字节被吃掉了。
  if (trimHead) {
    while (start < end && (bytes[start] & 0xc0) === 0x80) start++;
  }
  // 段尾不完整的序列:回退到最后一个首字节,若其续字节不足则整体丢弃。
  if (trimTail) {
    let i = end - 1;
    let cont = 0;
    while (i >= start && (bytes[i] & 0xc0) === 0x80) {
      cont++;
      i--;
    }
    if (i < start) {
      end = start;
    } else {
      const lead = bytes[i];
      const need = lead < 0x80 ? 0 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
      if (lead >= 0x80 && cont < need) end = i;
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
}

// 用一个代码页尝试还原整条负载。无 U+FFFD 时就是"整体回编码 + 严格校验";
// 有 U+FFFD 时按切口分段处理。任一段无法映射或非法都会抛错,由调用方换表/放弃。
function recoverWithCodePage(utf8, label, multiByte) {
  const segments = utf8.split(LOST);
  const last = segments.length - 1;
  const out = [];
  for (let i = 0; i <= last; i++) {
    const bytes = encodeToCodePage(segments[i], label, multiByte);
    out.push(decodeSegment(bytes, i > 0, i < last));
  }
  return out.join(LOST);
}

/**
 * 把 hook stdin 原始字节解码为字符串:去 UTF-8 BOM + 修复 ANSI 代码页双重编码。
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
  // 双重编码纠偏仅在 Windows 上进行。该乱码只源于 Windows 上的 host agent(Cursor/Qoder)
  // 先按系统 ANSI 代码页解码 UTF-8 负载再重新编码;原 PowerShell 版本本就是 .ps1、只在 Windows 运行。
  // 移入 node 后若不加平台判断,会在 macOS/Linux 上对本就合法的 UTF-8(如孤立中文字符)误纠而损坏遥测——
  // 因为孤立 CJK 字符的 GBK 编码字节本身也可能是合法 UTF-8,严格校验无法排除这种误纠。
  // 额外要求负载含非 ASCII 字节:纯 ASCII 不可能是该乱码,借此跳过绝大多数负载,也避免无谓构建编码表。
  if (process.platform === 'win32' && buf.length > 2 && /[^\x00-\x7f]/.test(utf8)) {
    for (const { label, multiByte } of CODE_PAGES) {
      try {
        // 段内严格 UTF-8 校验在 recoverWithCodePage 里完成(排除大部分正确输入被误纠)。
        const recoveredStr = recoverWithCodePage(utf8, label, multiByte);
        // 膨胀判据:真正的 UTF-8→ANSI 双重编码必然使收到的中间串 code point 数 > 还原串
        // ——UTF-8 的 CJK 占 3 字节,被误当 CP936(每字符 2 字节)/CP1252(每字符 1 字节)解码后字符数变多。
        // 反之干净单 CJK(如「业」→ GBK D2 B5 恰是合法 UTF-8 U+04B5「ҵ」)长度不变,严格校验放行却是误纠。
        if ([...utf8].length <= [...recoveredStr].length) continue;
        // 还原结果里除 U+FFFD 标记外必须仍有非 ASCII 字符。分段还原会丢弃切口处不完整的序列,
        // 若结果只剩标记,说明我们只是把非 ASCII 内容删掉了而非还原了它(该字符本就已被 host agent
        // 破坏,无从恢复),此时宁可保留原始乱码,也顺带堵住"干净负载恰好含 U+FFFD"被误纠的可能。
        if (!/[^\x00-\x7f\uFFFD]/.test(recoveredStr)) continue;
        return recoveredStr;
      } catch {
        // 该代码页不匹配(或此 node 构建不支持)——换下一张表
      }
    }
  }
  return utf8;
}
