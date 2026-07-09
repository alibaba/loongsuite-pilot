// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * event-emitter.mjs — JSONL 写入 + chain hash + 自生成 trace_id/span_id。
 *
 * 复用 ../agent-event-normalizer.mjs 的 sanitizeObject / timestampToUnixNanos / hashJson,
 * 不重写。
 *
 * 主要导出:
 * - INITIAL_HASH                              链初始值 (SHA-256("") 前 32 字符)
 * - hashStep(prevHash, msg)                   单步链式 hash
 * - computeHash(prevHash, deltaMessages)      累积计算 delta 的 hash
 * - shouldLogFullMessages(prevHash, delta, currentFullHash)
 *                                             判断是否需要写出完整 input.messages
 * - generateTraceId() / generateSpanId()      纯 crypto.randomBytes 生成,无 OTel SDK 依赖
 *                                             每 turn 一个 traceId,每 record 一个 spanId
 *                                             解决 logOnly 模式下 span_id 缺失(Claude 7.9 修复)
 * - writeJsonlRecords(logDir, agentId, records)
 *                                             append 写 <logDir>/<agentId>-YYYY-MM-DD.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─── trace/span id 生成(纯 crypto,与 OTel JS SDK 内部 IdGenerator 行为一致) ───

export function generateTraceId() {
  return crypto.randomBytes(16).toString('hex'); // 32 hex chars
}

export function generateSpanId() {
  return crypto.randomBytes(8).toString('hex'); // 16 hex chars
}

// ─── chain hash(用于增量记录 input.messages_delta + 间或写出 input.messages 全量) ───

function stableSerialize(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean' || typeof obj === 'number') return JSON.stringify(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableSerialize).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + stableSerialize(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(obj);
}

export const INITIAL_HASH = crypto.createHash('sha256').update('').digest('hex').slice(0, 32);

export function hashStep(prevHash, msg) {
  const msgBytes = Buffer.from(stableSerialize(msg), 'utf-8');
  const combined = Buffer.concat([Buffer.from(prevHash, 'utf-8'), msgBytes]);
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 32);
}

export function computeHash(prevHash, deltaMessages) {
  let h = prevHash;
  for (const msg of deltaMessages || []) {
    h = hashStep(h, msg);
  }
  return h;
}

export function shouldLogFullMessages(prevHash, delta, currentFullHash) {
  return computeHash(prevHash, delta) !== currentFullHash;
}

// ─── JSONL 文件写入 ───

function todayStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getJsonlFilePath(logDir, agentId) {
  return path.join(logDir, `${agentId}-${todayStamp()}.jsonl`);
}

export function writeJsonlRecords(logDir, agentId, records) {
  if (!records || records.length === 0) return;
  const filePath = getJsonlFilePath(logDir, agentId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf-8');
}
