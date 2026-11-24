// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
