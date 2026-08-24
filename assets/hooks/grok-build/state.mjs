// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Grok Build hook state.
 *
 * Only collection checkpoints and bounded deduplication metadata are persisted.
 * Message content, system prompts, tool results, and unified-log array indexes
 * are intentionally excluded.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const STATE_VERSION = 1;
export const MAX_RECENT_PROMPT_IDS = 64;
export const STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Grok's ordinary hooks (including SessionEnd) default to a 5 second timeout.
// Leave enough budget for the lock owner to finish its own bounded processing.
export const STATE_LOCK_TIMEOUT_MS = 3_000;
export const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_RETRY_MS = 25;
const ATOMIC_RENAME_RETRY_MS = [50, 100];
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export class GrokStateLockTimeoutError extends Error {
  constructor(sessionId) {
    super(`timed out acquiring Grok session state lock for ${sanitizeSessionId(sessionId)}`);
    this.name = 'GrokStateLockTimeoutError';
    this.code = 'STATE_LOCK_TIMEOUT';
  }
}

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function stateDir() {
  return path.join(pilotDataDir(), 'state', 'grok-build', 'sessions');
}

export function sanitizeSessionId(sessionId) {
  const raw = String(sessionId);
  const base = path.basename(raw).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${base.slice(0, 80)}-${digest}`;
}

function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function stateFilePath(sessionId) {
  return path.join(ensureStateDir(), `${sanitizeSessionId(sessionId)}.json`);
}

function stateLockPath(sessionId) {
  return path.join(ensureStateDir(), `${sanitizeSessionId(sessionId)}.lock`);
}

function closedMarkerPath(sessionId) {
  return path.join(ensureStateDir(), `${sanitizeSessionId(sessionId)}.closed`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameSyncWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (err) {
      if (
        !TRANSIENT_RENAME_CODES.has(err?.code)
        || attempt >= ATOMIC_RENAME_RETRY_MS.length
      ) {
        throw err;
      }
      sleepSync(ATOMIC_RENAME_RETRY_MS[attempt]);
    }
  }
}

function removeLockIfOwned(lockPath, token) {
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (current?.token === token) fs.unlinkSync(lockPath);
  } catch {}
}

/**
 * Serialize the complete state read-modify-write transaction for one session.
 *
 * Hook events execute in independent Node processes, so atomic state-file
 * replacement alone cannot prevent two processes from reading the same state
 * and both exporting the same prompt. The lock uses O_EXCL creation, bounded
 * waiting, and stale-lock recovery. A token check prevents a stale owner from
 * deleting a newer process's lock during release.
 */
export async function withSessionStateLock(sessionId, callback, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, options.timeoutMs)
    : STATE_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(options.staleMs)
    ? Math.max(1, options.staleMs)
    : STATE_LOCK_STALE_MS;
  const retryMs = Number.isFinite(options.retryMs)
    ? Math.max(1, options.retryMs)
    : STATE_LOCK_RETRY_MS;
  const lockPath = stateLockPath(sessionId);
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const startedAt = Date.now();
  let fd = null;

  while (fd == null) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({
        token,
        pid: process.pid,
        acquired_at_ms: Date.now(),
      }), 'utf-8');
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      if (Date.now() - startedAt >= timeoutMs) {
        throw new GrokStateLockTimeoutError(sessionId);
      }
      await sleep(retryMs);
    }
  }

  try {
    return await callback();
  } finally {
    try { fs.closeSync(fd); } catch {}
    removeLockIfOwned(lockPath, token);
  }
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

function normalizeState(sessionId, raw) {
  if (raw?.version !== STATE_VERSION) return freshState(sessionId);
  return {
    ...freshState(sessionId),
    initialized: raw.initialized === true,
    transcript_path: typeof raw.transcript_path === 'string' ? raw.transcript_path : null,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    chat_checkpoint: normalizeCheckpoint(raw.chat_checkpoint),
    updates_checkpoint: normalizeCheckpoint(raw.updates_checkpoint),
    recent_prompt_ids: Array.isArray(raw.recent_prompt_ids)
      ? raw.recent_prompt_ids.filter((id) => typeof id === 'string' && id).slice(-MAX_RECENT_PROMPT_IDS)
      : [],
    turn_count: Number.isFinite(raw.turn_count) ? Math.max(0, raw.turn_count) : 0,
  };
}

export function loadState(sessionId) {
  const file = stateFilePath(sessionId);
  if (!fs.existsSync(file)) return freshState(sessionId);
  try {
    return normalizeState(sessionId, JSON.parse(fs.readFileSync(file, 'utf-8')));
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
    version: STATE_VERSION,
    session_id: sessionId,
    initialized: state.initialized === true,
    transcript_path: typeof state.transcript_path === 'string' ? state.transcript_path : null,
    cwd: typeof state.cwd === 'string' ? state.cwd : null,
    chat_checkpoint: normalizeCheckpoint(state.chat_checkpoint),
    updates_checkpoint: normalizeCheckpoint(state.updates_checkpoint),
    recent_prompt_ids: Array.isArray(state.recent_prompt_ids)
      ? state.recent_prompt_ids.filter((id) => typeof id === 'string' && id).slice(-MAX_RECENT_PROMPT_IDS)
      : [],
    turn_count: Number.isFinite(state.turn_count) ? Math.max(0, state.turn_count) : 0,
  };

  try {
    fs.writeFileSync(tmp, JSON.stringify(cleanState), { encoding: 'utf-8', mode: 0o600 });
    renameSyncWithRetry(tmp, dest);
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

export function isSessionClosed(sessionId, now = Date.now()) {
  const file = closedMarkerPath(sessionId);
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const closedAt = Number(marker?.closed_at_ms);
    if (Number.isFinite(closedAt) && now - closedAt <= STATE_RETENTION_MS) return true;
    fs.unlinkSync(file);
  } catch {}
  return false;
}

export function markSessionClosed(sessionId, now = Date.now()) {
  const dest = closedMarkerPath(sessionId);
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ closed_at_ms: now }), { encoding: 'utf-8', mode: 0o600 });
    renameSyncWithRetry(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function writeCleanupMarker(markerPath, now) {
  const tmp = `${markerPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ last_run_ms: now }), { encoding: 'utf-8', mode: 0o600 });
    renameSyncWithRetry(tmp, markerPath);
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
      if (
        (!name.endsWith('.json') && !name.endsWith('.closed'))
        || name === '.cleanup.json'
      ) {
        continue;
      }
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
