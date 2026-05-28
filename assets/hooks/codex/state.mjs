// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * state.mjs — Codex session state.
 *
 * 移植自 codex-plugin .../src/state.ts,改:
 *   - ESM 导出 + 去除 TS type
 *   - state 路径改为 ~/.loongsuite-pilot/state/codex/sessions/<sessionId>.json
 *   - 新增 listStateFiles / getStateMtime,供 hook-watchdog cleanup 使用
 *
 * State 字段(关键):
 *   - session_id, model, start_time, events: SessionEvent[]
 *   - transcript_path?: string
 *   - transcript_offset?: number       — 增量读 codex transcript 的字节偏移(跨 turn 持久化)
 *   - transcript_last_token_usage?     — 上次已采纳的 last_token_usage(跨 turn 心跳去重)
 *
 * Codex Stop hook 按 turn 触发,但 codex transcript 是 session 级累加的;state 文件**不能**清,
 * 仅清空 events + 固化 transcript_offset / transcript_last_token_usage,见 cli.ts:244 注释。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

const STATE_DIR = path.join(pilotDataDir(), 'state', 'codex', 'sessions');

function sanitizeSessionId(sessionId) {
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
    } catch {
      // corrupted — start fresh
    }
  }
  return {
    session_id: sessionId,
    model: 'unknown',
    start_time: Date.now() / 1000,
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
 * splitIntoTurns — 把 state.events 按 user_prompt_submit 边界切成 turns。
 * 移植自 codex-plugin state.ts:149。
 */
export function splitIntoTurns(state) {
  const turns = [];
  let current = null;

  const stopEvent = state.events.find((e) => e.type === 'stop');

  for (const event of state.events) {
    if (event.type === 'session_start') continue;

    if (event.type === 'user_prompt_submit') {
      if (current) {
        current.end_time = event.timestamp;
        turns.push(current);
      }
      current = {
        turn_id: event.turn_id,
        prompt: event.prompt,
        model: event.model,
        start_time: event.timestamp,
        end_time: event.timestamp,
        events: [],
      };
      continue;
    }

    if (event.type === 'stop') {
      if (current) {
        current.end_time = event.timestamp;
        current.last_assistant_message = event.last_assistant_message;
        if (event.model) current.model = event.model;
      }
      continue;
    }

    if (current) {
      current.events.push(event);
      current.end_time = event.timestamp;
    }
  }

  if (current) {
    if (stopEvent) {
      current.end_time = stopEvent.timestamp;
      current.last_assistant_message = stopEvent.last_assistant_message;
    }
    turns.push(current);
  }
  return turns;
}

// ─── Cleanup helpers ───

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

export const CODEX_STATE_DIR = STATE_DIR;
