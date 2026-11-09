// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { decodePayload } from '../shared/decode-payload.mjs';
import { collectResourceAttributesFromEnv, parseSpanAttributesFromEnv } from '../shared/resource-context.mjs';
import { recordUpstreamContextOnce } from '../shared/upstream-context.mjs';

export const MAX_WAKEUP_BYTES = 16 * 1024;
export const MAX_WAKEUPS_PER_SOURCE = 128;
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop']);
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const require = createRequire(import.meta.url);
let GateDatabase;

function gateDatabase() {
  if (GateDatabase) return GateDatabase;
  // Node 22 advertises the required builtin as experimental at require time.
  // Hook stderr is a protocol surface. Suppress only that exact advertisement
  // during synchronous loading; preserve every other warning and restore the
  // process handler before running any caller action.
  const original = process.emitWarning;
  process.emitWarning = function emitGateWarning(...args) {
    if (args[0] === 'SQLite is an experimental feature and might change at any time'
      && args[1] === 'ExperimentalWarning') return;
    return original.apply(this, args);
  };
  try { GateDatabase = require('node:sqlite').DatabaseSync; }
  finally { process.emitWarning = original; }
  return GateDatabase;
}

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

function canonicalSourcePath(file) {
  let candidate = path.resolve(file);
  const suffix = [];
  // realpath of the nearest existing ancestor also works before the native
  // writer creates a file or several trailing directories. Resolve dangling
  // symlinks explicitly so their eventual target keeps the same source key.
  for (let count = 0; count < 64; count++) {
    try { return path.join(fs.realpathSync(candidate), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) {
          candidate = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
          continue;
        }
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
  throw new Error('Qoder source path exceeds normalization budget');
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
  // Node's required SQLite runtime provides a process-owned OS transaction
  // lock: no age-based stealing, PID reuse, or path-unlink ownership race.
  // No schema or business data is written. Keep this file in place: unlinking
  // a database while another process has it open would split the lock domain.
  const file = path.join(directory, '.wakeup-gate.sqlite');
  const deadline = performance.now() + Math.max(0, Math.min(25, Number(waitMs) || 0));
  let database;
  let acquired = false;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); }
    catch (error) { if (error.code !== 'EEXIST') return { acquired: false }; }
    if (!fs.lstatSync(file).isFile()) return { acquired: false };
    const Database = gateDatabase();
    database = new Database(file);
    database.exec('PRAGMA busy_timeout=0');
    while (!acquired) {
      try { database.exec('BEGIN IMMEDIATE'); acquired = true; }
      catch (error) {
        if ((error.errcode !== 5 && error.errcode !== 6) || performance.now() >= deadline) return { acquired: false };
        Atomics.wait(LOCK_WAIT, 0, 0, Math.min(5, Math.max(0, deadline - performance.now())));
      }
    }
    return { acquired: true, value: action() };
  } catch (error) {
    if (acquired) throw error;
    return { acquired: false, ...(error.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
      ? { reason: 'runtime-sqlite-unavailable' } : {}) };
  } finally {
    if (acquired) { try { database.exec('ROLLBACK'); } catch {} }
    try { database?.close(); } catch {}
  }
}

/** No transcript body, tool input/result or prompt is read or copied here. */
export function publishQoderWakeup(payload, { dataDir, agentId, userIdentity } = {}) {
  const sessionId = field(payload?.session_id ?? payload?.conversation_id, 512);
  const parentPath = field(payload?.transcript_path);
  const subagentId = field(payload?.agent_id, 512);
  // Native sidechains share session_id but have their own agent_id and file.
  // Start can precede creation; never publish against the parent's cursor.
  if (subagentId && !/^[a-zA-Z0-9_-]+$/.test(subagentId)) return false;
  const suppliedPath = subagentId && parentPath
    ? field(payload.agent_transcript_path) ?? path.join(path.dirname(parentPath),
      path.basename(parentPath, '.jsonl'), 'subagents', `agent-${subagentId}.jsonl`)
    : parentPath;
  if (!sessionId || !suppliedPath || !path.isAbsolute(suppliedPath) || payload.stop_hooks_active) return false;
  let transcriptPath;
  let stat;
  try {
    transcriptPath = canonicalSourcePath(suppliedPath);
    try { stat = fs.statSync(transcriptPath); }
    catch (error) { if (error.code !== 'ENOENT') return false; }
    if (stat && !stat.isFile()) return false;
  } catch (error) {
    return false;
  }
  const root = qoderWakeupRoot(dataDir, agentId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = qoderSourceKey(sessionId, transcriptPath);
  const directory = path.join(root, key);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const event = EVENTS.has(payload.hook_event_name) ? payload.hook_event_name : 'Stop';
  const record = {
    schema: 1, key, agentId, sessionId, transcriptPath, event,
    ...(subagentId ? { subagentId, parentTranscriptPath: canonicalSourcePath(parentPath),
      ...(field(payload.agent_type, 512) ? { subagentName: payload.agent_type } : {}) } : {}),
    observationId: crypto.randomUUID(),
    ...(field(payload.request_set_id, 512) ? { requestSetId: payload.request_set_id } : {}),
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
    record.legacyTriggerLine, record.requestSetId,
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
    warnCapacity(root, published.reason ?? 'context-lock');
    return false;
  }
  if (!published.value) return false;
  if (!subagentId) recordUpstreamContextOnce({ agentId, sessionId, dataDir });
  else {
    const parentKey = qoderSourceKey(sessionId, canonicalSourcePath(parentPath));
    if (!fs.existsSync(path.join(root, parentKey, 'source.json'))) {
      // Index a still-running parent before its Stop arrives. This is discovery,
      // not a terminal observation, and carries no transcript/tool contents.
      publishQoderWakeup({ ...payload, agent_id: undefined, agent_transcript_path: undefined,
        hook_event_name: 'SubagentStart' }, { dataDir, agentId, userIdentity });
    }
  }
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
