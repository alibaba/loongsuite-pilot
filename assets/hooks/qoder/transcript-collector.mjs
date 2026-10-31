// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises';
import { constants, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildLlmBoundaries, buildEventsFromBoundaries, isRealUserPrompt,
  hasQoderCnTerminalMarker, resolveQoderCliUserIdentity,
} from '../qoder-hook-processor.mjs';
import { loadHookRuntimeConfig } from '../agent-event-normalizer.mjs';
import { qoderWakeupRoot, qoderSourceKey, MAX_WAKEUP_BYTES, withQoderWakeupLock } from './hook-wakeup.mjs';

export const QODER_SCAN_BYTES = 4 * 1024 * 1024;
export const QODER_MAX_TURN_BYTES = 16 * 1024 * 1024;
export const QODER_CACHE_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_TURNS_PER_CYCLE = 32;
const MAX_SOURCES_PER_CYCLE = 64;
const MAX_CONTEXT_FILES = 256;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_WARNING_KEYS = 1024;
const MAX_TURN_RECORDS = 8192;
const eventOf = row => row?.type === 'progress' ? row.data?.hookEvent ?? '' : '';
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function openRegular(file) {
  // A file can become a FIFO between the path stat and open. O_NONBLOCK makes
  // that open return so fstat can reject it instead of stranding the Input.
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error('not-regular-file');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function jsonSnapshot(file, limit = MAX_WAKEUP_BYTES) {
  const handle = await openRegular(file);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Qoder metadata exceeds limit');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('Qoder metadata grew past limit');
    return { value: JSON.parse(buffer.toString('utf8', 0, bytesRead)), stat };
  } finally { await handle.close(); }
}

async function smallJson(file, limit = MAX_WAKEUP_BYTES) {
  return (await jsonSnapshot(file, limit)).value;
}

async function names(directory, limit) {
  let handle;
  const entries = [];
  try {
    handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (entry.name.startsWith('.')) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return entries;
}

function validSource(value, agentId, key) {
  return value?.schema === 1 && value.key === key && value.agentId === agentId
    && typeof value.sessionId === 'string' && value.sessionId.length <= 512
    && typeof value.transcriptPath === 'string' && path.isAbsolute(value.transcriptPath)
    && Number.isSafeInteger(value.observedSize) && value.observedSize >= 0
    && qoderSourceKey(value.sessionId, value.transcriptPath) === key;
}

/**
 * Collector-owned tailer. State stores offsets and semantic boundaries, never
 * conversation bodies. collect() stages a new state; the Input commits it only
 * after canonicalization/token enrichment succeeds and uses its normal save.
 */
export class QoderTranscriptCollector {
  constructor({ dataDir, agentId, scanBytes = QODER_SCAN_BYTES,
    maxTurnBytes = QODER_MAX_TURN_BYTES, cacheBytes = QODER_CACHE_BYTES,
    stableMs = 250, settleMs = 5000, now = Date.now, warn = () => {}, runtime = () => null } = {}) {
    this.dataDir = dataDir;
    this.agentId = agentId;
    this.root = qoderWakeupRoot(dataDir, agentId);
    this.scanBytes = Math.max(CHUNK_BYTES, Math.min(QODER_SCAN_BYTES, scanBytes));
    this.maxTurnBytes = Math.max(CHUNK_BYTES, Math.min(QODER_MAX_TURN_BYTES, maxTurnBytes));
    this.cacheLimit = Math.max(this.maxTurnBytes, Math.min(QODER_CACHE_BYTES, cacheBytes));
    this.stableMs = Math.max(0, stableMs);
    this.settleMs = Math.max(0, Math.min(5000, settleMs));
    this.now = now;
    this.warn = warn;
    this.runtime = runtime;
    this.cache = new Map();
    this.cacheSize = 0;
    this.warned = new Map();
    this.metadata = new Map();
    this.metadataBytes = 0;
    this.discovery = null;
    this.pendingSources = [];
    this.cleanupRotation = 0;
    this.stopped = false;
    this.inFlight = null;
  }

  start() { this.stopped = false; }
  stop() {
    this.stopped = true;
    this.cache.clear(); this.cacheSize = 0;
    this.metadata.clear(); this.metadataBytes = 0;
    const directory = this.discovery;
    this.discovery = null;
    this.pendingSources = [];
    if (directory) void directory.close().catch(() => {});
  }

  report(key, reason) {
    const id = key + ':' + reason;
    if (this.now() - (this.warned.get(id) ?? -Infinity) < 60_000) return;
    if (this.warned.size >= MAX_WARNING_KEYS) this.warned.delete(this.warned.keys().next().value);
    this.warned.set(id, this.now());
    this.warn('Qoder transcript collection deferred', { source: key, reason });
  }

  collect(state = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collectOnce(state).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async sources() {
    // Keep a directory cursor across cycles. Historical sessions do not impose
    // a lifetime admission limit or an unbounded readdir/all-source stat walk.
    if (this.pendingSources.length) return this.pendingSources;
    try {
      if (!this.discovery) this.discovery = await fs.opendir(this.root);
      for (let count = 0; count < MAX_SOURCES_PER_CYCLE; count++) {
        const entry = await this.discovery.read();
        if (!entry) {
          await this.discovery.close(); this.discovery = null; break;
        }
        if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) this.pendingSources.push(entry);
      }
    } catch (error) {
      this.discovery = null;
      if (error.code !== 'ENOENT' && !this.stopped) throw error;
    }
    return this.pendingSources;
  }

  async metadataFor(directory) {
    const stamp = await fs.stat(path.join(directory, 'events'));
    const previous = this.metadata.get(directory);
    if (previous?.mtime === stamp.mtimeMs && previous?.ctime === stamp.ctimeMs) return previous;
    const source = previous?.source ?? await smallJson(path.join(directory, 'source.json'));
    const contexts = await this.contexts(directory, source);
    const value = { source, contexts, mtime: stamp.mtimeMs, ctime: stamp.ctimeMs,
      bytes: Buffer.byteLength(JSON.stringify([source, contexts])) };
    if (previous) { this.metadataBytes -= previous.bytes; this.metadata.delete(directory); }
    while (this.metadata.size && this.metadataBytes + value.bytes > MAX_METADATA_BYTES) {
      const key = this.metadata.keys().next().value;
      this.metadataBytes -= this.metadata.get(key).bytes;
      this.metadata.delete(key);
    }
    if (value.bytes <= MAX_METADATA_BYTES) {
      this.metadata.set(directory, value); this.metadataBytes += value.bytes;
    }
    return value;
  }

  async collectOnce(state) {
    const next = { ...state };
    const records = [];
    let changed = false;
    this.metrics = { bytesRead: 0, recordsParsed: 0, sourceFilesOpened: 0, peakCachedBytes: this.cacheSize };
    this.remainingBytes = this.scanBytes;
    if (this.stopped) return { records, state: next, metrics: this.metrics, changed };
    try {
      const capacity = await smallJson(path.join(this.root, '..', 'capacity.json'));
      if (capacity.observedAt > this.now() - 60_000) this.report('wakeup', capacity.reason);
    } catch {}
    const entries = await this.sources();
    if (!entries.length) return { records, state: next, metrics: this.metrics, changed };
    let visited = 0;
    for (const entry of entries) {
      if (this.stopped || this.remainingBytes <= 0 || records.length >= 4096) break;
      visited++;
      const key = entry.name;
      const directory = path.join(this.root, key);
      let source;
      let observedContexts;
      try { ({ source, contexts: observedContexts } = await this.metadataFor(directory)); }
      catch (error) { this.report(key, error.code ?? error.message); continue; }
      if (!validSource(source, this.agentId, key)) { this.report(key, 'invalid-source'); continue; }
      const old = next[key];
      let checkpoint = old ? clone(old) : null;
      try {
        const stat = await fs.stat(source.transcriptPath);
        if (!stat.isFile()) continue;
        if (await this.legacyWorkerAlive(source.transcriptPath)) continue;
        if (source.suppliedPath && source.suppliedPath !== source.transcriptPath && await this.legacyWorkerAlive(source.suppliedPath)) continue;
        const contexts = observedContexts.filter(context => context.inode === undefined || context.inode === stat.ino);
        if (!contexts.length) continue; // Replacement has not been observed by a Hook yet.
        const rewritten = checkpoint?.fingerprint && (checkpoint.fileMtime !== stat.mtimeMs || checkpoint.fileCtime !== stat.ctimeMs)
          && !await this.matchesFingerprint(source.transcriptPath, checkpoint);
        if (!checkpoint || checkpoint.inode !== stat.ino || stat.size < checkpoint.offset || rewritten) {
          checkpoint = await this.initialize(source, contexts, stat, !old);
          if (old) checkpoint.recoveryReason = 'truncated';
          this.dropCache(key);
        }
        const batch = await this.scanSource(source, contexts, checkpoint, stat);
        if (this.stopped) break;
        if (checkpoint.offset !== old?.offset || rewritten || !checkpoint.fingerprint) {
          checkpoint.fingerprint = await this.fingerprint(source.transcriptPath, checkpoint.offset);
        }
        const after = await fs.stat(source.transcriptPath);
        if (after.ino !== stat.ino || after.size < checkpoint.offset
          || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) throw new Error('source-changed-during-read');
        checkpoint.fileMtime = stat.mtimeMs;
        checkpoint.fileCtime = stat.ctimeMs;
        records.push(...batch);
        next[key] = checkpoint;
        changed ||= JSON.stringify(old) !== JSON.stringify(checkpoint);
      } catch (error) {
        this.dropCache(key);
        this.report(key, error.code ?? error.message);
        // Retain the prior checkpoint and published observations on any I/O,
        // parse, capacity or cancellation failure. Other sources still run.
      }
    }
    this.pendingSources = entries.slice(visited);
    return { records, state: next, metrics: this.metrics, changed };
  }

  /** Called on the next serialized Input cycle, after its prior save settled. */
  async acknowledge(state = {}) {
    const keys = Object.keys(state);
    if (!keys.length || this.stopped) return;
    const start = this.cleanupRotation % keys.length;
    const selected = [...keys.slice(start), ...keys.slice(0, start)].slice(0, MAX_SOURCES_PER_CYCLE);
    this.cleanupRotation = (start + selected.length) % keys.length;
    for (const key of selected) {
      const checkpoint = state[key];
      if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(checkpoint?.committedOffset)) continue;
      const directory = path.join(this.root, key, 'events');
      for (const entry of await names(directory, MAX_CONTEXT_FILES)) {
        if (!entry.isFile() || !/^\d+-(?:SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SessionEnd)-[a-f0-9]{24}\.json$/.test(entry.name)) continue;
        try {
          const file = path.join(directory, entry.name);
          const { value: event, stat } = await jsonSnapshot(file);
          if (event.inode === checkpoint.inode && event.observedSize <= checkpoint.committedOffset) {
            withQoderWakeupLock(path.dirname(directory), () => {
              // A same-watermark publication can replace the path after our
              // async read. Reclaim only the exact metadata generation read.
              const current = statSync(file);
              if (current.ino === stat.ino && current.size === stat.size
                && current.mtimeMs === stat.mtimeMs && current.ctimeMs === stat.ctimeMs) unlinkSync(file);
            }, 0);
          }
        } catch { /* Never turn a cleanup/read failure into an input ACK. */ }
      }
    }
  }

  async legacyWorkerAlive(transcriptPath) {
    const lock = path.join(this.dataDir, 'hooks/.retry-locks', crypto.createHash('sha1').update(transcriptPath).digest('hex') + '.lock');
    let value;
    try { value = await smallJson(lock); } catch (error) { return error.code !== 'ENOENT'; }
    if (!Number.isInteger(value?.pid) || value.pid <= 0) return true;
    try { process.kill(value.pid, 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
  }

  async contexts(directory, source) {
    const result = [source];
    for (const entry of await names(path.join(directory, 'events'), MAX_CONTEXT_FILES)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const context = await smallJson(path.join(directory, 'events', entry.name));
      if (!validSource(context, this.agentId, source.key)) throw new Error('invalid-context');
      result.push(context);
    }
    return result.sort((a, b) => a.observedSize - b.observedSize || a.observedAt - b.observedAt);
  }

  async initialize(source, contexts, stat, migrate) {
    const checkpoint = { inode: stat.ino, offset: 0, committedOffset: 0, activeStart: null, hasUser: false,
      recoveryReason: 'missing-cursor',
      terminal: false, stableSize: null, stableMtime: null, stableAt: null,
      anchorSize: Math.min(stat.size, ...contexts.map(context => context.observedSize)), bootstrapEnd: null };
    const firstObservation = contexts[0];
    checkpoint.skipToPrompt = firstObservation.event === 'UserPromptSubmit' || firstObservation.event === 'SessionStart';
    if (migrate) {
      const sessionHash = crypto.createHash('sha256').update(source.sessionId).digest('hex');
      const legacyFiles = [
        path.join(this.dataDir, 'state/hooks', `${this.agentId}-line-records`, `${sessionHash}.json`),
        path.join(this.dataDir, 'state/hooks', `${this.agentId}-line-records.json`),
        path.join(this.dataDir, 'hooks', `.line_records.${this.agentId}.json`),
      ];
      for (const file of legacyFiles) {
        try {
          const value = await smallJson(file, 1024 * 1024);
          const record = value.transcript_path ? value : value[source.transcriptPath] ?? value[source.suppliedPath];
          if (record?.session_id === source.sessionId && (!record.transcript_path
            || record.transcript_path === source.transcriptPath || record.transcript_path === source.suppliedPath)
            && Number.isSafeInteger(record.last_line_count) && record.last_line_count >= 0) {
            checkpoint.migration = { target: record.last_line_count, seen: 0 };
            checkpoint.recoveryReason = 'incremental';
            return checkpoint;
          }
        } catch {}
      }
    }
    const legacyTrigger = contexts.filter(context => Number.isSafeInteger(context.legacyTriggerLine))
      .sort((a, b) => a.legacyTriggerLine - b.legacyTriggerLine)[0];
    if (legacyTrigger) {
      checkpoint.findAnchorLine = { target: legacyTrigger.legacyTriggerLine, seen: 0 };
    } else {
      checkpoint.bootstrapEnd = checkpoint.anchorSize;
    }
    return checkpoint;
  }

  async open(file) {
    this.metrics.sourceFilesOpened++;
    return openRegular(file);
  }

  async fingerprint(file, offset) {
    const handle = await this.open(file);
    try {
      const head = Buffer.alloc(Math.min(128, offset));
      const tail = Buffer.alloc(Math.min(128, offset));
      await this.read(handle, head, 0);
      await this.read(handle, tail, Math.max(0, offset - tail.length));
      return digest([head.toString('base64'), tail.toString('base64')]);
    } finally { await handle.close(); }
  }

  async matchesFingerprint(file, checkpoint) {
    return checkpoint.fingerprint === await this.fingerprint(file, checkpoint.offset);
  }

  async read(handle, buffer, position, length = buffer.length) {
    if (this.stopped) throw new Error('stopped');
    const runtime = this.runtime();
    const started = runtime?.now();
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    this.metrics.bytesRead += bytesRead;
    this.remainingBytes -= bytesRead;
    if (runtime && started !== undefined) runtime.observeRead(bytesRead, buffer.length, runtime.now() - started);
    return bytesRead;
  }

  async *lines(file, start, end, { allowFinal = false, rebuild = false } = {}) {
    const handle = await this.open(file);
    let position = start;
    let lineStart = start;
    let pending = [];
    let pendingBytes = 0;
    try {
      while (position < end && (this.remainingBytes > 0 || pendingBytes > 0 || rebuild)) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, end - position));
        const read = await this.read(handle, buffer, position);
        if (!read) break;
        position += read;
        let cursor = 0;
        while (cursor < read) {
          const newline = buffer.indexOf(0x0a, cursor);
          const stop = newline >= 0 && newline < read ? newline : read;
          const fragment = buffer.subarray(cursor, stop);
          pending.push(fragment);
          pendingBytes += fragment.length;
          if (pendingBytes > this.maxTurnBytes) throw new Error('record-byte-limit');
          if (stop === read) break;
          const text = Buffer.concat(pending, pendingBytes).toString('utf8').trim();
          const lineEnd = position - read + stop + 1;
          let row = null;
          if (text) {
            try { row = JSON.parse(text); } catch { throw new Error('invalid-json-line'); }
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid-json-line');
            this.metrics.recordsParsed++;
          }
          yield { row, start: lineStart, end: lineEnd, bytes: lineEnd - lineStart };
          lineStart = lineEnd;
          pending = [];
          pendingBytes = 0;
          cursor = stop + 1;
        }
      }
      if (allowFinal && position === end && pendingBytes) {
        let row;
        try { row = JSON.parse(Buffer.concat(pending, pendingBytes).toString('utf8').trim()); }
        catch { return; } // Incomplete native write: preserve its starting byte.
        if (!row || typeof row !== 'object' || Array.isArray(row)) return;
        this.metrics.recordsParsed++;
        yield { row, start: lineStart, end, bytes: end - lineStart };
      }
    } finally { await handle.close(); }
  }

  async findBootstrap(file, checkpoint) {
    const end = checkpoint.bootstrapEnd;
    if (end === 0) { checkpoint.offset = 0; checkpoint.bootstrapEnd = null; return true; }
    const window = checkpoint.bootstrapWindow ?? 1024 * 1024;
    const start = Math.max(0, end - window);
    const handle = await this.open(file);
    let buffer;
    try {
      buffer = Buffer.alloc(end - start);
      const read = await this.read(handle, buffer, start);
      buffer = buffer.subarray(0, read);
    } finally { await handle.close(); }
    let right = buffer.lastIndexOf(0x0a);
    const completeEnd = right >= 0 ? start + right + 1 : 0;
    while (right >= 0) {
      const left = buffer.lastIndexOf(0x0a, right - 1) + 1;
      if (left === 0 && start > 0) break;
      try {
        const row = JSON.parse(buffer.subarray(left, right).toString('utf8'));
        if (checkpoint.skipToPrompt && (row.type === 'last-prompt' || eventOf(row) === 'Stop' || eventOf(row) === 'SessionEnd')) {
          // A prompt Hook can run either side of the native user write. If the
          // latest range is already closed, wait at the complete-line watermark;
          // otherwise the real user row below anchors the in-progress Turn.
          checkpoint.offset = completeEnd;
          checkpoint.committedOffset = completeEnd;
          checkpoint.bootstrapEnd = null;
          checkpoint.bootstrapWindow = null;
          return true;
        }
        if (isRealUserPrompt(row)) {
          checkpoint.offset = start + left;
          checkpoint.committedOffset = checkpoint.offset;
          checkpoint.bootstrapEnd = null;
          checkpoint.bootstrapWindow = null;
          return true;
        }
      } catch { /* Non-message lines and the cut prefix cannot be anchors. */ }
      if (left === 0) break;
      right = left - 1;
    }
    if (start === 0) {
      checkpoint.offset = 0;
      checkpoint.bootstrapEnd = null;
      return true;
    }
    const firstNewline = buffer.indexOf(0x0a);
    const nextEnd = firstNewline < 0 ? end : start + firstNewline + 1;
    if (nextEnd === end) {
      if (window >= this.maxTurnBytes) throw new Error('bootstrap-record-byte-limit');
      checkpoint.bootstrapWindow = Math.min(this.maxTurnBytes, window * 2);
    } else {
      checkpoint.bootstrapEnd = nextEnd;
      checkpoint.bootstrapWindow = null;
    }
    return false;
  }

  dropCache(key) {
    const previous = this.cache.get(key);
    if (previous) this.cacheSize -= previous.bytes;
    this.cache.delete(key);
  }

  remember(key, value) {
    this.dropCache(key);
    if (this.stopped || value.start === null || value.bytes === 0) return;
    if (value.bytes > this.maxTurnBytes) throw new Error('turn-byte-limit');
    while (this.cache.size && this.cacheSize + value.bytes > this.cacheLimit) this.dropCache(this.cache.keys().next().value);
    this.cache.set(key, value);
    this.cacheSize += value.bytes;
    this.metrics.peakCachedBytes = Math.max(this.metrics.peakCachedBytes, this.cacheSize);
  }

  async rowsFor(source, checkpoint) {
    if (checkpoint.activeStart === null) return { start: null, end: checkpoint.offset, rows: [], bytes: 0 };
    const cached = this.cache.get(source.key);
    let value = cached ? { ...cached, rows: [...cached.rows] } : null;
    if (!value || value.start !== checkpoint.activeStart || value.end > checkpoint.offset) {
      value = { start: checkpoint.activeStart, end: checkpoint.activeStart, rows: [], bytes: 0 };
    }
    if (value.end < checkpoint.offset) {
      // Rehydration is one bounded active-turn range, even if it exceeds the
      // normal cycle budget. Idle evicted turns never enter this path.
      if (checkpoint.offset - value.end > this.maxTurnBytes) throw new Error('turn-byte-limit');
      for await (const line of this.lines(source.transcriptPath, value.end, checkpoint.offset, { rebuild: true, allowFinal: true })) {
        if (line.row) value.rows.push(line.row);
        value.bytes += line.bytes;
        value.end = line.end;
        if (value.bytes > this.maxTurnBytes) throw new Error('turn-byte-limit');
      }
      this.remember(source.key, value);
      if (value.end < checkpoint.offset) return null;
    }
    return value;
  }

  async build(source, contexts, checkpoint, value, endOffset, terminalSource) {
    if (this.stopped) throw new Error('stopped');
    if (!checkpoint.hasUser || !value.rows.length) return [];
    const context = [...contexts].reverse().find(item => item.observedSize <= endOffset
      && (item.observedSize > checkpoint.activeStart || (item.observedSize >= (checkpoint.contextFloor ?? checkpoint.activeStart)
        && (item.event === 'UserPromptSubmit' || item.event === 'SessionStart'))))
      ?? { cwd: source.cwd, desktop: source.desktop };
    const config = { ...loadHookRuntimeConfig(this.dataDir),
      userIdentity: context.userIdentity, resourceAttributes: context.resourceAttributes ?? {}, spanAttributes: context.spanAttributes ?? {} };
    const content = value.rows.filter(row => row.type === 'user' || row.type === 'assistant');
    if (!config.userIdentity && !context.desktop && this.agentId === 'qoder'
      && content.some(row => row.entrypoint === 'cli' || row.promptId || row.permissionMode || row.userType)) {
      config.userIdentity = await resolveQoderCliUserIdentity(this.dataDir);
    }
    const turnId = digest([this.agentId, source.sessionId, source.transcriptPath, checkpoint.inode,
      checkpoint.activeStart, value.rows.find(isRealUserPrompt)]);
    const boundaries = buildLlmBoundaries([], content);
    const records = buildEventsFromBoundaries(boundaries, content, value.rows, turnId,
      source.sessionId, this.agentId, config, context.cwd ?? source.cwd);
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      record['event.id'] = digest([turnId, index, record['event.name'], record['gen_ai.tool.call.id']]);
      record['agent.transcript.cursor_mode'] = checkpoint.recoveryReason === 'incremental' ? 'incremental' : 'bootstrap';
      record['agent.transcript.cursor_reason'] = checkpoint.recoveryReason ?? 'incremental';
      record['agent.transcript.cursor_batch_id'] = turnId;
      record['agent.transcript.terminal_source'] = terminalSource;
    }
    checkpoint.recoveryReason = 'incremental';
    return records;
  }

  clearActive(checkpoint) {
    checkpoint.activeStart = null;
    checkpoint.contextFloor = null;
    checkpoint.hasUser = false;
    checkpoint.terminal = false;
    checkpoint.terminalAt = null;
    checkpoint.stableSize = null;
    checkpoint.stableMtime = null;
    checkpoint.stableAt = null;
  }

  async scanSource(source, contexts, checkpoint, stat) {
    const records = [];
    for (const property of ['migration', 'findAnchorLine']) {
      if (!checkpoint[property]) continue;
      const migration = checkpoint[property];
      if (migration.target > migration.seen) {
        for await (const line of this.lines(source.transcriptPath, checkpoint.offset, stat.size)) {
          checkpoint.offset = line.end;
          migration.seen++;
          if (migration.seen >= migration.target) break;
        }
      }
      if (migration.seen < migration.target && checkpoint.offset < stat.size) return records;
      if (migration.seen < migration.target) {
        checkpoint.offset = 0; // Native file was truncated/replaced since the legacy cursor.
        checkpoint.recoveryReason = 'truncated';
        checkpoint.bootstrapEnd = checkpoint.anchorSize;
      } else if (property === 'findAnchorLine') {
        checkpoint.anchorSize = checkpoint.offset;
        checkpoint.bootstrapEnd = checkpoint.offset;
        checkpoint.offset = 0;
      } else {
        checkpoint.committedOffset = checkpoint.offset;
      }
      delete checkpoint[property];
      if (this.remainingBytes <= 0) return records;
    }
    if (checkpoint.bootstrapEnd !== null && !await this.findBootstrap(source.transcriptPath, checkpoint)) return records;
    if (checkpoint.stableSize !== stat.size || checkpoint.stableMtime !== stat.mtimeMs) {
      checkpoint.stableSize = stat.size;
      checkpoint.stableMtime = stat.mtimeMs;
      checkpoint.stableAt = this.now();
    }
    const stable = this.now() - checkpoint.stableAt >= this.stableMs;
    const ready = stable && checkpoint.terminal
      && this.now() - (checkpoint.terminalAt ?? checkpoint.stableAt) >= this.settleMs;
    if (checkpoint.offset === stat.size && checkpoint.activeStart !== null && !ready) return records;
    let value = await this.rowsFor(source, checkpoint);
    if (!value) return records;
    let turns = 0;
    for await (const line of this.lines(source.transcriptPath, checkpoint.offset, stat.size, { allowFinal: stable })) {
      const row = line.row;
      const prompt = row && isRealUserPrompt(row);
      const contextFloor = Math.max(checkpoint.committedOffset, checkpoint.nativeStopOffset ?? 0);
      if (eventOf(row) === 'Stop') checkpoint.nativeStopOffset = line.end;
      // Hook progress is a completion notification of a command, often late
      // (including third-party commands). Only a real user row owns a new Turn.
      if (prompt && checkpoint.hasUser) {
        records.push(...await this.build(source, contexts, checkpoint, value, line.start, 'next-prompt'));
        checkpoint.committedOffset = line.start;
        this.clearActive(checkpoint);
        value = { start: null, end: line.start, rows: [], bytes: 0 };
        turns++;
      }
      if (prompt && checkpoint.activeStart === null) {
        checkpoint.activeStart = line.start;
        checkpoint.contextFloor = contextFloor;
        value.start = line.start;
      }
      if (checkpoint.activeStart !== null) {
        if (row) value.rows.push(row);
        if (value.rows.length > MAX_TURN_RECORDS) throw new Error('turn-record-limit');
        value.bytes += line.bytes;
        if (value.bytes > this.maxTurnBytes) throw new Error('turn-byte-limit');
        if (prompt) checkpoint.hasUser = true;
        if (eventOf(row) === 'Stop' || (row && hasQoderCnTerminalMarker([], [row]))) {
          if (!checkpoint.terminal) checkpoint.terminalAt = this.now();
          checkpoint.terminal = true;
        }
      }
      checkpoint.offset = line.end;
      value.end = line.end;
      if ((row?.type === 'last-prompt' || eventOf(row) === 'SessionEnd') && checkpoint.hasUser) {
        records.push(...await this.build(source, contexts, checkpoint, value, line.end, row.type === 'last-prompt' ? 'last-prompt' : 'session-end'));
        checkpoint.committedOffset = line.end;
        this.clearActive(checkpoint);
        value = { start: null, end: line.end, rows: [], bytes: 0 };
        turns++;
      }
      if (turns >= MAX_TURNS_PER_CYCLE || records.length >= 4096 || this.stopped) break;
    }
    // Some native versions write neither last-prompt nor an assistant terminal
    // flag. The real Stop observation supplies that fact, while the collector
    // still waits for a stable native tail before it closes the turn.
    if (checkpoint.hasUser && !checkpoint.terminal && !checkpoint.nativeStopOffset
      && value.rows.some(row => row.type === 'assistant') && contexts.some(context => context.event === 'Stop'
      && context.observedSize > checkpoint.activeStart && context.observedSize <= checkpoint.offset)) {
      checkpoint.terminal = true;
      checkpoint.terminalAt = this.now();
    }
    if (checkpoint.activeStart !== null && checkpoint.terminal && checkpoint.offset === stat.size) {
      if (checkpoint.stableSize !== stat.size || checkpoint.stableMtime !== stat.mtimeMs) {
        checkpoint.stableSize = stat.size;
        checkpoint.stableMtime = stat.mtimeMs;
        checkpoint.stableAt = this.now();
      } else if (this.now() - checkpoint.stableAt >= this.stableMs
        && this.now() - (checkpoint.terminalAt ?? checkpoint.stableAt) >= this.settleMs) {
        records.push(...await this.build(source, contexts, checkpoint, value, checkpoint.offset, 'stable-terminal-eof'));
        checkpoint.committedOffset = checkpoint.offset;
        this.clearActive(checkpoint);
        value = { start: null, end: checkpoint.offset, rows: [], bytes: 0 };
      }
    }
    this.remember(source.key, value);
    return records;
  }
}
