// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * state.mjs — Qwen Code CLI session state.
 *
 * Adapted from assets/hooks/claude-code/state.mjs (same shape, different dir).
 *
 * State path: ~/.loongsuite-pilot/state/qwen-code-cli/sessions/<sessionId>.json
 *
 * State file shape:
 *   {
 *     session_id, start_time, cwd,
 *     transcript_path, transcript_offset?,
 *     turn_count,                  // turns already exported (incl. skipped historic)
 *     stop_time?,
 *     events: []                   // v2 subagent_start/stop accumulator (unused in v1)
 *   }
 *
 * Atomic write via temp + rename to avoid half-written reads when concurrent
 * hooks fire (qwen-code's SubagentStart/Stop hooks run alongside Stop).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

const STATE_DIR = path.join(pilotDataDir(), 'state', 'qwen-code-cli', 'sessions');

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
        `[qwen-code-cli-hook] state file for session ${sessionId} corrupted; starting fresh (${err.message})`,
      );
    }
  }
  return {
    session_id: sessionId,
    start_time: Date.now() / 1000,
    cwd: null,
    transcript_path: null,
    transcript_offset: 0,
    turn_count: 0,
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
 * Read a child (subagent) session state and delete it — used by SubagentStop
 * to merge child state into parent. v1 stores child events but doesn't process
 * them; v2 will unfurl subagent records into the trace.
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

// ─── Cleanup helpers (for hook-watchdog) ───

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

export const QWEN_CODE_CLI_STATE_DIR = STATE_DIR;
