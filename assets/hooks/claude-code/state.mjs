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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

const STATE_DIR = path.join(pilotDataDir(), 'state', 'claude-code', 'sessions');
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

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

export function saveState(sessionId, state, { publish } = {}) {
  const dest = stateFilePath(sessionId);
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `${sanitizeSessionId(sessionId)}.${process.pid}.tmp`);
  try {
    // A queued Stop retries automatically. Check the destination and stage
    // the new cursor before publishing so a persistent state-write failure
    // cannot append another copy on each collector poll.
    if (publish) {
      const checkpoint = fs.lstatSync(dest, { throwIfNoEntry: false });
      if (checkpoint?.isDirectory()) throw new Error('Claude Code checkpoint path is a directory');
    }
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    publish?.();
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Serialize hook processes that mutate the same Claude session state.
 * Stop and SubagentStop may run concurrently for background agents.
 */
export async function withStateLock(sessionId, fn) {
  ensureStateDir();
  const lockPath = path.join(STATE_DIR, `${sanitizeSessionId(sessionId)}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockPath);
          continue;
        }
      } catch (_) {}
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for session state lock: ${sanitizeSessionId(sessionId)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try { fs.rmdirSync(lockPath); } catch {}
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

// ─── Deferred Stop queue ───

const MAX_PENDING_STOPS = 512;
const MAX_STOP_BYTES = 64 * 1024;
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STOP_FILE = /^\d{13}-[0-9a-f]{32}-[0-9a-f-]{36}\.json$/;

function stopsDir(dataDir) {
  return path.join(dataDir, 'state', 'claude-code', 'pending-stops');
}

function sessionKey(sessionId) {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

export function hashStopText(text) {
  return crypto.createHash('sha256').update(text.trim().replace(/\r\n/g, '\n')).digest('hex');
}

function listNames(dir) {
  try { return fs.readdirSync(dir); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function hasPendingStop(dataDir, sessionId) {
  const key = sessionKey(sessionId);
  return listNames(stopsDir(dataDir)).some((name) => STOP_FILE.test(name) && name.slice(14, 46) === key);
}

export function enqueueStop(dataDir, stop) {
  if (!path.isAbsolute(stop.transcriptPath)) throw new Error('Stop has no absolute transcript path');
  const dir = stopsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (listNames(dir).filter((name) => STOP_FILE.test(name)).length >= MAX_PENDING_STOPS) {
    throw new Error('Claude Code pending Stop queue is full');
  }

  const body = JSON.stringify({ version: 1, ...stop });
  if (Buffer.byteLength(body) > MAX_STOP_BYTES) throw new Error('Claude Code Stop metadata exceeds the queue limit');
  const file = path.join(dir, `${stop.observedAt}-${sessionKey(stop.sessionId)}-${crypto.randomUUID()}.json`);
  const temporary = file + '.tmp';
  try {
    fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

/** Each session is processed in Stop order. Retry order across sessions is fair. */
export function listPendingStops(dataDir) {
  const dir = stopsDir(dataDir);
  const now = Date.now();
  const sessions = new Map();
  for (const name of listNames(dir).sort()) {
    if (STOP_FILE.test(name)) {
      const key = name.slice(14, 46);
      const file = path.join(dir, name);
      const metadata = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!metadata?.isFile()) continue;
      const items = sessions.get(key) ?? [];
      items.push({ file, name, key, mtimeMs: metadata.mtimeMs });
      sessions.set(key, items);
    } else if (name.endsWith('.tmp') && STOP_FILE.test(name.slice(0, -4))) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isFile() && now - stat.mtimeMs > TEMP_MAX_AGE_MS) {
        fs.rmSync(file, { force: true });
      }
    }
  }
  return [...sessions.values()].sort((a, b) => a[0].mtimeMs - b[0].mtimeMs).flat();
}

export function readPendingStop({ file, name }) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_STOP_BYTES) return null;
  let stop;
  try {
    stop = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'ENOENT') return null;
    throw error;
  }
  return stop?.version === 1
    && typeof stop.sessionId === 'string' && sessionKey(stop.sessionId) === name.slice(14, 46)
    && typeof stop.transcriptPath === 'string' && path.isAbsolute(stop.transcriptPath)
    && Number.isFinite(stop.observedAt) && String(stop.observedAt) === name.slice(0, 13)
    && typeof stop.promptId === 'string'
    && (stop.replyHash === null || typeof stop.replyHash === 'string' && /^[0-9a-f]{64}$/.test(stop.replyHash))
    && typeof stop.stopReason === 'string'
    && typeof stop.context?.userId === 'string'
    ? stop : null;
}
