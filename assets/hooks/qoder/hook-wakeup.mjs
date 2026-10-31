// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decodePayload } from '../shared/decode-payload.mjs';
import { collectResourceAttributesFromEnv, parseSpanAttributesFromEnv } from '../shared/resource-context.mjs';
import { recordUpstreamContextOnce } from '../shared/upstream-context.mjs';
import { withSyncFileLock } from '../shared/sync-file-lock.mjs';

export const MAX_WAKEUP_BYTES = 16 * 1024;
export const MAX_WAKEUPS_PER_SOURCE = 128;
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);

function field(value, limit = 4096) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit ? value : undefined;
}

export function qoderWakeupRoot(dataDir, agentId) {
  if (agentId !== 'qoder' && agentId !== 'qoder-cn') throw new Error('Invalid Qoder agent');
  return path.join(dataDir, 'state', 'qoder-transcripts', agentId, 'sources');
}

export function qoderSourceKey(sessionId, transcriptPath) {
  return crypto.createHash('sha256').update(JSON.stringify([sessionId, transcriptPath])).digest('hex');
}

function atCapacity(directory, limit) {
  let handle;
  try {
    handle = fs.opendirSync(directory);
    let count = 0;
    for (let entry; (entry = handle.readSync());) {
      if (!entry.name.startsWith('.') && ++count >= limit) return true;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { handle?.closeSync(); }
  return false;
}

function atomicJson(file, value, exclusive = false) {
  const temporary = path.join(path.dirname(file), `.${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (exclusive) {
      // Same-directory hard-link publication is atomic and never replaces the
      // first observation when concurrent Hooks discover one transcript.
      try { fs.linkSync(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } else {
      fs.renameSync(temporary, file);
    }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

function warnCapacity(root, reason) {
  const file = path.join(root, '..', 'capacity.json');
  try {
    try { if (Date.now() - fs.statSync(file).mtimeMs < 60_000) return; } catch {}
    atomicJson(file, { schema: 1, reason, observedAt: Date.now() });
  } catch {}
}

// Coordinate only tiny metadata publication/reclamation, never native parsing.
// Capacity must be reserved before publishing, including competing Hook PIDs.
export function withQoderWakeupLock(directory, action, waitMs = 25) {
  return withSyncFileLock(path.join(directory, '.wakeup.lock'), waitMs, 60_000, action);
}

/** No transcript body, tool input/result or prompt is read or copied here. */
export function publishQoderWakeup(payload, { dataDir, agentId, userIdentity } = {}) {
  const sessionId = field(payload?.session_id ?? payload?.conversation_id, 512);
  const suppliedPath = field(payload?.transcript_path);
  if (!sessionId || !suppliedPath || !path.isAbsolute(suppliedPath) || payload.stop_hooks_active) return false;
  let transcriptPath;
  let stat;
  try {
    transcriptPath = fs.realpathSync(suppliedPath);
    stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') return false;
    // A Hook can precede the native writer. Keep the observation for polling.
    transcriptPath = path.resolve(suppliedPath);
  }
  const root = qoderWakeupRoot(dataDir, agentId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = qoderSourceKey(sessionId, transcriptPath);
  const directory = path.join(root, key);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const event = EVENTS.has(payload.hook_event_name) ? payload.hook_event_name : 'Stop';
  const record = {
    schema: 1, key, agentId, sessionId, transcriptPath, event,
    ...(transcriptPath !== suppliedPath ? { suppliedPath } : {}),
    observedSize: stat?.size ?? 0, observedAt: Date.now(),
    ...(stat ? { inode: stat.ino } : {}),
    ...(field(payload.cwd) ? { cwd: payload.cwd } : {}),
    ...(payload.parent_business_info?.product === 'app' ? { desktop: true } : {}),
    ...(userIdentity ? { userIdentity } : {}),
    ...(Number.isSafeInteger(payload.legacy_trigger_line) && payload.legacy_trigger_line >= 0
      ? { legacyTriggerLine: payload.legacy_trigger_line } : {}),
    resourceAttributes: collectResourceAttributesFromEnv(process.env, { agentId }),
    spanAttributes: parseSpanAttributesFromEnv(process.env, { agentId, allowInvocationIdentity: true }),
  };
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_WAKEUP_BYTES) {
    warnCapacity(root, 'metadata-bytes');
    return false;
  }
  const descriptor = path.join(directory, 'source.json');
  if (!fs.existsSync(descriptor)) atomicJson(descriptor, record, true);
  const events = path.join(directory, 'events');
  fs.mkdirSync(events, { recursive: true, mode: 0o700 });
  // Repeated notifications at the same watermark and with the same context
  // coalesce; different lifecycle facts/identities retain their own record.
  const context = crypto.createHash('sha256').update(JSON.stringify([
    record.userIdentity, record.desktop, record.cwd, record.spanAttributes, record.resourceAttributes,
    record.legacyTriggerLine,
  ])).digest('hex').slice(0, 24);
  const destination = path.join(events, `${record.observedSize}-${event}-${context}.json`);
  const published = withQoderWakeupLock(directory, () => {
    if (!fs.existsSync(destination) && atCapacity(events, MAX_WAKEUPS_PER_SOURCE)) {
      warnCapacity(root, 'context-limit');
      return false;
    }
    atomicJson(destination, record);
    return true;
  });
  if (!published.acquired) {
    // The descriptor remains durable: polling can still drain native data.
    // Metadata contention/capacity is observable and never acts as a cursor ACK.
    warnCapacity(root, 'context-lock');
    return false;
  }
  if (!published.value) return false;
  recordUpstreamContextOnce({ agentId, sessionId, dataDir });
  return true;
}

export async function readQoderHookPayload() {
  return new Promise(resolve => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 1000);
    process.stdin.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { chunks.length = 0; finish(null); return; }
      chunks.push(chunk);
    });
    process.stdin.once('error', () => finish(null));
    process.stdin.once('end', () => {
      try {
        const parsed = JSON.parse(decodePayload(Buffer.concat(chunks)) || '{}');
        finish(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch { finish(null); }
    });
    process.stdin.resume();
  });
}
