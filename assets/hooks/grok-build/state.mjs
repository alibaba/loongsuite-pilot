// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Grok Build hook state v2.
 *
 * Only collection checkpoints and bounded deduplication metadata are persisted.
 * Message content, system prompts, tool results, and unified-log array indexes
 * are intentionally excluded.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const STATE_VERSION = 2;
export const MAX_RECENT_PROMPT_IDS = 64;
export const STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function stateDir() {
  return path.join(pilotDataDir(), 'state', 'grok-build', 'sessions');
}

export function sanitizeSessionId(sessionId) {
  const base = path.basename(String(sessionId));
  return base.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stateFilePath(sessionId) {
  return path.join(ensureStateDir(), `${sanitizeSessionId(sessionId)}.json`);
}

function emptyCheckpoint() {
  return { offset: 0, ino: null, size: 0 };
}

function freshState(sessionId) {
  return {
    version: STATE_VERSION,
    session_id: sessionId,
    initialized: false,
    transcript_path: null,
    cwd: null,
    chat_checkpoint: emptyCheckpoint(),
    updates_checkpoint: emptyCheckpoint(),
    recent_prompt_ids: [],
    turn_count: 0,
  };
}

function normalizeCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyCheckpoint();
  return {
    offset: Number.isFinite(value.offset) ? Math.max(0, value.offset) : 0,
    ino: value.ino != null ? String(value.ino) : null,
    size: Number.isFinite(value.size) ? Math.max(0, value.size) : 0,
  };
}

function migrateState(sessionId, raw) {
  if (raw?.version === STATE_VERSION) {
    return {
      ...freshState(sessionId),
      ...raw,
      version: STATE_VERSION,
      session_id: sessionId,
      chat_checkpoint: normalizeCheckpoint(raw.chat_checkpoint),
      updates_checkpoint: normalizeCheckpoint(raw.updates_checkpoint),
      recent_prompt_ids: Array.isArray(raw.recent_prompt_ids)
        ? raw.recent_prompt_ids.filter((id) => typeof id === 'string' && id).slice(-MAX_RECENT_PROMPT_IDS)
        : [],
    };
  }

  // v1 used a chat transcript offset and a global unified-log array index.
  // Neither is safe after file rewrite/rotation. Re-baseline on the next hook
  // and export only that hook's current turn.
  return {
    ...freshState(sessionId),
    transcript_path: typeof raw?.transcript_path === 'string' ? raw.transcript_path : null,
    cwd: typeof raw?.cwd === 'string' ? raw.cwd : null,
    turn_count: Number.isFinite(raw?.turn_count) ? Math.max(0, raw.turn_count) : 0,
    migrated_from: 1,
  };
}

export function loadState(sessionId) {
  const file = stateFilePath(sessionId);
  if (!fs.existsSync(file)) return freshState(sessionId);
  try {
    return migrateState(sessionId, JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[grok-build-hook] state file for session ${sessionId} corrupted; starting fresh (${err.message})`,
    );
    return freshState(sessionId);
  }
}

export function saveState(sessionId, state) {
  const dest = stateFilePath(sessionId);
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `${sanitizeSessionId(sessionId)}.${process.pid}.tmp`);
  const cleanState = {
    ...freshState(sessionId),
    ...state,
    version: STATE_VERSION,
    session_id: sessionId,
    chat_checkpoint: normalizeCheckpoint(state.chat_checkpoint),
    updates_checkpoint: normalizeCheckpoint(state.updates_checkpoint),
    recent_prompt_ids: Array.isArray(state.recent_prompt_ids)
      ? state.recent_prompt_ids.slice(-MAX_RECENT_PROMPT_IDS)
      : [],
  };
  delete cleanState.system_prompt;
  delete cleanState.events;
  delete cleanState.usage_events_consumed;
  delete cleanState.transcript_offset;
  delete cleanState._next_transcript_offset;

  try {
    fs.writeFileSync(tmp, JSON.stringify(cleanState), 'utf-8');
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function hasExportedPrompt(state, promptId) {
  return !!promptId && Array.isArray(state?.recent_prompt_ids)
    && state.recent_prompt_ids.includes(promptId);
}

export function markPromptExported(state, promptId) {
  if (!promptId) return;
  const ids = Array.isArray(state.recent_prompt_ids) ? state.recent_prompt_ids : [];
  state.recent_prompt_ids = [...ids.filter((id) => id !== promptId), promptId]
    .slice(-MAX_RECENT_PROMPT_IDS);
}

export function clearState(sessionId) {
  try { fs.unlinkSync(stateFilePath(sessionId)); } catch {}
}

function writeCleanupMarker(markerPath, now) {
  const tmp = `${markerPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ last_run_ms: now }), 'utf-8');
    fs.renameSync(tmp, markerPath);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function cleanupExpiredStates(now = Date.now()) {
  const dir = ensureStateDir();
  const marker = path.join(dir, '.cleanup.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf-8'));
    if (Number.isFinite(parsed?.last_run_ms) && now - parsed.last_run_ms < CLEANUP_INTERVAL_MS) {
      return { deleted: 0, skipped: true };
    }
  } catch {}

  let deleted = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name === '.cleanup.json') continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > STATE_RETENTION_MS) {
          fs.unlinkSync(file);
          deleted += 1;
        }
      } catch {}
    }
  } finally {
    writeCleanupMarker(marker, now);
  }
  return { deleted, skipped: false };
}

export function listStateFiles() {
  const dir = stateDir();
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json') && name !== '.cleanup.json')
      .map((name) => path.join(dir, name));
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

export const GROK_BUILD_STATE_DIR = stateDir();
