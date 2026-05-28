// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * state.mjs — Claude Code session state.
 *
 * 移植自 claude-code-plugin .../src/state.js,改:
 *   - ESM 导出
 *   - state 路径改为 ~/.loongsuite-pilot/state/claude-code/sessions/<sessionId>.json
 *   - 新增 listStateFiles / getStateMtime,供 hook-watchdog cleanup 使用
 *
 * State 文件格式(向后兼容老插件结构):
 *   { session_id, start_time, prompt, model, transcript_path, transcript_offset?,
 *     metrics: { input_tokens, output_tokens, tools_used, turns },
 *     tools_used: [], events: [], stop_time?: number, ... }
 *
 * 写入采用 temp + rename 原子,防止半写文件被并发 hook 读到。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

const STATE_DIR = path.join(pilotDataDir(), 'state', 'claude-code', 'sessions');

export function sanitizeSessionId(sessionId) {
  const base = path.basename(String(sessionId));
  return base.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

function stateFilePath(sessionId) {
  return path.join(ensureStateDir(), `${sanitizeSessionId(sessionId)}.json`);
}

export function loadState(sessionId) {
  const sf = stateFilePath(sessionId);
  if (fs.existsSync(sf)) {
    try {
      return JSON.parse(fs.readFileSync(sf, 'utf-8'));
    } catch (err) {
      // corrupted — discard and start fresh
      // eslint-disable-next-line no-console
      console.error(
        `[claude-code-hook] state file for session ${sessionId} corrupted; starting fresh (${err.message})`,
      );
    }
  }
  return {
    session_id: sessionId,
    start_time: Date.now() / 1000,
    prompt: '',
    model: 'unknown',
    transcript_path: null,
    transcript_offset: 0,
    metrics: { input_tokens: 0, output_tokens: 0, tools_used: 0, turns: 0 },
    tools_used: [],
    events: [],
  };
}

export function saveState(sessionId, state) {
  const dest = stateFilePath(sessionId);
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `${sanitizeSessionId(sessionId)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function clearState(sessionId) {
  const sf = stateFilePath(sessionId);
  try { fs.unlinkSync(sf); } catch {}
}

/**
 * 读子 session 的 state 并删除文件(SubagentStop 合并子 state 用)。
 */
export function readAndDeleteChildState(childSessionId) {
  const sf = stateFilePath(childSessionId);
  if (!fs.existsSync(sf)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(sf, 'utf-8'));
    try { fs.unlinkSync(sf); } catch {}
    return data;
  } catch {
    return null;
  }
}

// ─── Cleanup helpers (供 hook-watchdog 调用) ───

export function listStateFiles() {
  try {
    if (!fs.existsSync(STATE_DIR)) return [];
    return fs.readdirSync(STATE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(STATE_DIR, f));
  } catch {
    return [];
  }
}

export function getStateMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export const CLAUDE_STATE_DIR = STATE_DIR;
