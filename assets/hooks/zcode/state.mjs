// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * state.mjs — ZCode hook session state.
 *
 * State path: ~/.loongsuite-pilot/state/zcode/sessions/<sessionId>.json
 *
 * State file shape:
 *   {
 *     session_id, start_time, cwd,
 *     stop_time?,
 *     last_exported_turn?: string  // last turnId we emitted an AGENT envelope for
 *   }
 *
 * V3 hook path is envelope-only (ENTRY/AGENT), no transcript parsing — state is
 * minimal. Per-turn idempotency: if Stop fires twice for the same turnId, the
 * second invocation is a no-op (state.last_exported_turn guard).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

const STATE_DIR = path.join(pilotDataDir(), 'state', 'zcode', 'sessions');

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
    } catch {
      // corrupted — discard and start fresh
    }
  }
  return {
    session_id: sessionId,
    start_time: Date.now() / 1000,
    cwd: null,
    last_exported_turn: null,
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

export const ZCODE_STATE_DIR = STATE_DIR;
