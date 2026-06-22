// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * state.mjs — Kiro CLI hook 事件缓冲（per-cwd）。
 *
 * Kiro hook 事件分多次进程到达：postToolUse 比 stop 早。
 * 中间 tool 事件的 tool_response（transcript 拿不到的唯一产出）必须先缓冲，
 * stop 触发导出时再与 transcript join。
 *
 * 缓冲键：cwd（= conversations_v2.key）。每个 cwd 一个 JSONL 缓冲文件，
 * 存 PostToolUse 的 {tool_name, tool_input, tool_response, captureTs}。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

const BUFFER_DIR = path.join(pilotDataDir(), 'state', 'kiro-cli', 'buffers');
const PRE_TOOL_BUFFER_DIR = path.join(pilotDataDir(), 'state', 'kiro-cli', 'pre-tool-buffers');
const OFFSET_DIR = path.join(pilotDataDir(), 'state', 'kiro-cli', 'offsets');

function safeKey(cwd) {
  return Buffer.from(String(cwd || 'unknown')).toString('base64url');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

function bufferFile(cwd) {
  return path.join(ensureDir(BUFFER_DIR), `${safeKey(cwd)}.jsonl`);
}

function preToolBufferFile(cwd) {
  return path.join(ensureDir(PRE_TOOL_BUFFER_DIR), `${safeKey(cwd)}.jsonl`);
}

/**
 * 追加一条 PostToolUse 事件到 per-cwd 缓冲。
 */
export function appendToolEvent(cwd, entry) {
  const file = bufferFile(cwd);
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // fail-open
  }
}

/**
 * 读出并清空 per-cwd 缓冲。
 * @returns {Array<{toolName:string, toolInput:object, toolResponse:any, captureTs:string}>}
 */
export function drainToolEvents(cwd) {
  const file = bufferFile(cwd);
  if (!fs.existsSync(file)) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  try {
    fs.writeFileSync(file, '', 'utf-8');
  } catch {
    // ignore
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * 追加一条 PreToolUse 事件到 per-cwd 独立缓冲（与 postToolUse 分开 drain）。
 */
export function appendPreToolEvent(cwd, entry) {
  const file = preToolBufferFile(cwd);
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // fail-open
  }
}

/**
 * 读出并清空 per-cwd PreToolUse 缓冲。
 * @returns {Array<{toolName:string, toolInput:object, startTs:string}>}
 */
export function drainPreToolEvents(cwd) {
  const file = preToolBufferFile(cwd);
  if (!fs.existsSync(file)) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  try {
    fs.writeFileSync(file, '', 'utf-8');
  } catch {
    // ignore
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip malformed
    }
  }
  return out;
}

// ─── per-cwd transcript offset（updated_at 增量游标）───

function offsetFile(cwd) {
  return path.join(ensureDir(OFFSET_DIR), `${safeKey(cwd)}.json`);
}

/**
 * 读取某 cwd 上次已上报的 updated_at（毫秒）。
 */
export function loadOffset(cwd) {
  const file = offsetFile(cwd);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return typeof data?.updatedMs === 'number' ? data.updatedMs : 0;
    }
  } catch {
    // ignore
  }
  return 0;
}

/**
 * 记录某 cwd 已上报到的 updated_at。
 */
export function saveOffset(cwd, updatedMs) {
  const file = offsetFile(cwd);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `${safeKey(cwd)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ updatedMs }), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.writeFileSync(file, JSON.stringify({ updatedMs }), 'utf-8');
    } catch {
      // ignore
    }
  }
}
