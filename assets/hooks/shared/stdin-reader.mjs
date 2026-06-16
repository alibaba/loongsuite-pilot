// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * stdin-reader.mjs — 共享 stdin 解析 + Cursor 调用方检测。
 *
 * Hook 进程由 host agent (Claude Code / Codex / Cursor / ...) 通过 stdin 传入 JSON 事件。
 * - readStdinJson(): 同步读 fd 0,4KB buffer 循环,容错 fallback,失败返回 {}。
 * - isCursorCaller(event): 仅 Claude 端使用 — Cursor IDE 启动 Claude 时会通过 Claude 的 hook
 *   路径触发同样事件,会与 cursor-hook 双重采集,故在 Claude handler 入口早返回。
 */

import fs from 'node:fs';

export function readStdinJson() {
  try {
    const chunks = [];
    const buf = Buffer.alloc(4096);
    let fd;
    try {
      fd = fs.openSync('/dev/stdin', 'rs');
    } catch {
      fd = 0;
    }
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      chunks.push(Buffer.from(buf.subarray(0, bytes)));
    }
    if (fd !== 0) {
      try { fs.closeSync(fd); } catch {}
    }
    let raw = Buffer.concat(chunks).toString('utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Cursor IDE 在调用 Claude Code 时,hook stdin 会携带 `cursor_version` 字段。
 * Claude handler 检测到此字段则早返回 — 让 Cursor 自己的 cursor-hook 采集即可。
 */
export function isCursorCaller(event) {
  return !!(event && event.cursor_version);
}
