// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises';
import { constants, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  buildLlmBoundaries, buildEventsFromBoundaries, isRealUserPrompt, isControlUserRow,
  hasQoderCnTerminalMarker,
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
const MAX_TAIL_SCANS = 256;
const MAX_DEFERRED_SOURCES = 1024;
const LEGACY_LOCK_GRACE_MS = 1000;
const LEGACY_LOCK_AGE_MS = 60_000;
const MAX_TRAILING_CONTROL_BYTES = 64 * 1024;
const TERMINAL_CONTEXT_EVENTS = new Set(['Stop', 'SessionEnd']);
const DEFERRED_CONTENT_ERRORS = new Set([
  'record-byte-limit', 'turn-byte-limit', 'turn-record-limit',
  'bootstrap-record-byte-limit', 'invalid-json-line',
]);
const fileVersion = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const eventOf = row => row?.type === 'progress' ? row.data?.hookEvent ?? '' : '';
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const noticeVersion = (value, stat) => typeof value.observationId === 'string' && value.observationId.length <= 128
  ? `id:${value.observationId}` : `stat:${digest([stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])}`;
const noticeName = name => /^\d+-(?:SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SessionEnd)-[a-f0-9]{24}\.json$/.test(name);

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
    stableMs = 250, settleMs = 5000, now = Date.now, warn = () => {}, runtime = () => null,
    resolveInitialPrompt } = {}) {
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
    this.resolveInitialPrompt = resolveInitialPrompt;
    this.cache = new Map();
    this.cacheSize = 0;
    this.warned = new Map();
    this.metadata = new Map();
    this.metadataBytes = 0;
    // Physical tail progress is disposable: semantic checkpoints still end at
    // complete records. Keep only a small append witness, never partial bodies.
    this.tailScans = new Map();
    this.deferredSources = new Map();
    this.legacyOwners = new Map();
    this.legacyPending = new Set();
    this.legacyInspections = new Map();
    this.legacyInspectionSequence = 0;
    this.promptInspections = new Map();
    this.promptInspectionSequence = 0;
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
    this.tailScans.clear(); this.deferredSources.clear();
    this.legacyOwners.clear();
    this.legacyPending.clear(); this.legacyInspections.clear();
    this.promptInspections.clear();
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
    this.ownerInspectionBudget = 1;
    this.promptInspectionBudget = 1;
    if (this.stopped) return { records, state: next, metrics: this.metrics, changed };
    try {
      const capacity = await smallJson(path.join(this.root, '..', 'capacity.json'));
      if (capacity.observedAt > this.now() - 60_000) this.report('wakeup', capacity.reason);
    } catch {}
    const entries = await this.sources();
    if (!entries.length) return { records, state: next, metrics: this.metrics, changed };
    // One unavailable owner must not consume every cycle's shared DB budget.
    // Choose fairly from this bounded discovery batch, even if that source's
    // native file or legacy writer prevents its lookup from running today.
    this.promptChosenKey = entries.filter(entry => next[entry.name]?.initialOwnership)
      .reduce((chosen, entry) => !chosen || (this.promptInspections.get(entry.name) ?? 0)
        < (this.promptInspections.get(chosen) ?? 0) ? entry.name : chosen, null);
    if (this.promptChosenKey) this.rememberPromptInspection(this.promptChosenKey);
    this.legacyChosenKey = entries.filter(entry => this.legacyPending.has(entry.name))
      .reduce((chosen, entry) => !chosen || (this.legacyInspections.get(entry.name) ?? 0)
        < (this.legacyInspections.get(chosen) ?? 0) ? entry.name : chosen, null);
    if (this.legacyChosenKey) this.rememberLegacyInspection(this.legacyChosenKey);
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
      let version;
      try {
        const stat = await fs.stat(source.transcriptPath);
        if (!stat.isFile()) continue;
        version = fileVersion(stat);
        const deferred = this.deferredSources.get(key);
        if (deferred?.version === version) {
          this.report(key, deferred.reason);
          continue;
        }
        this.deferredSources.delete(key);
        if (await this.legacyWorkerAlive(source.transcriptPath, key)) continue;
        if (source.suppliedPath && source.suppliedPath !== source.transcriptPath && await this.legacyWorkerAlive(source.suppliedPath, key)) continue;
        const contexts = observedContexts.filter(context => context.inode === undefined || context.inode === stat.ino);
        if (!contexts.length) continue; // Replacement has not been observed by a Hook yet.
        const rewritten = checkpoint?.fingerprint && (checkpoint.fileMtime !== stat.mtimeMs || checkpoint.fileCtime !== stat.ctimeMs)
          && !await this.matchesFingerprint(source.transcriptPath, checkpoint);
        if (!checkpoint || checkpoint.inode !== stat.ino || stat.size < checkpoint.offset || rewritten) {
          checkpoint = await this.initialize(source, contexts, stat, !old);
          if (old) checkpoint.recoveryReason = 'truncated';
          this.dropCache(key);
          this.tailScans.delete(source.transcriptPath);
        }
        if (checkpoint.unresolvedPrompt && !checkpoint.unresolvedPrompt.reason && !checkpoint.initialOwnership
          && !checkpoint.backfill && checkpoint.committedOffset === 0 && checkpoint.activeStart === null
          && contexts.some(context => context.event === 'UserPromptSubmit' && context.requestSetId)) {
          checkpoint.bootstrapEnd = checkpoint.unresolvedPrompt.through;
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
        // A durable cursor alone is not an ACK for notices published later at
        // that same watermark (or after an in-place rewrite). Persist the exact
        // versions observed while a completed range was accepted instead.
        const advanced = checkpoint.committedOffset !== old?.committedOffset
          || checkpoint.inode !== old?.inode || rewritten
          || ((old?.initialOwnership || old?.backfill) && !checkpoint.initialOwnership && !checkpoint.backfill);
        const saved = new Set((checkpoint.receipts ?? []).map(receipt => `${receipt.name}:${receipt.version}`));
        checkpoint.receipts = contexts.filter(context => context.receipt && (
          saved.has(`${context.receipt.name}:${context.receipt.version}`)
          || (advanced && !(checkpoint.unresolvedPrompt && context.observedSize <= checkpoint.unresolvedPrompt.through)
            && context.observedSize <= checkpoint.committedOffset
            && (!['UserPromptSubmit', 'SessionStart'].includes(context.event)
              || context.observedSize < checkpoint.committedOffset))
        )).map(context => context.receipt);
        records.push(...batch);
        next[key] = checkpoint;
        changed ||= JSON.stringify(old) !== JSON.stringify(checkpoint);
      } catch (error) {
        this.dropCache(key);
        if (version && DEFERRED_CONTENT_ERRORS.has(error.message)) {
          if (this.deferredSources.size >= MAX_DEFERRED_SOURCES) this.deferredSources.delete(this.deferredSources.keys().next().value);
          this.deferredSources.set(key, { version, reason: error.message });
        }
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
      if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(checkpoint?.receipts)) continue;
      for (const receipt of checkpoint.receipts.slice(0, MAX_CONTEXT_FILES)) {
        if (!receipt || !noticeName(receipt.name) || typeof receipt.version !== 'string') continue;
        const directory = path.join(this.root, key, 'events');
        try {
          const file = path.join(directory, receipt.name);
          const { value: event, stat } = await jsonSnapshot(file);
          if (noticeVersion(event, stat) === receipt.version) {
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

  rememberLegacyInspection(key) {
    this.legacyInspections.delete(key);
    if (this.legacyInspections.size >= MAX_TAIL_SCANS) this.legacyInspections.delete(this.legacyInspections.keys().next().value);
    this.legacyInspections.set(key, ++this.legacyInspectionSequence);
  }

  async legacyWorkerAlive(transcriptPath, sourceKey = transcriptPath) {
    const lock = path.join(this.dataDir, 'hooks/.retry-locks', crypto.createHash('sha1').update(transcriptPath).digest('hex') + '.lock');
    let value, stat;
    try { ({ value, stat } = await jsonSnapshot(lock)); }
    catch (error) {
      if (error.code === 'ENOENT') { this.legacyPending.delete(sourceKey); return false; }
      try { stat = await fs.stat(lock); } catch { this.legacyPending.delete(sourceKey); return false; }
      // The old writer creates an empty file before writing its JSON. Give
      // that publication a bounded grace, without deleting another writer's
      // lock or treating a crash/corrupt file as a permanently live worker.
      this.legacyPending.delete(sourceKey);
      return this.now() - stat.mtimeMs < LEGACY_LOCK_GRACE_MS;
    }
    if (!Number.isInteger(value?.pid) || value.pid <= 0 || !Number.isFinite(value.startedAt)) {
      this.legacyPending.delete(sourceKey);
      return this.now() - stat.mtimeMs < LEGACY_LOCK_GRACE_MS;
    }
    let permissionDenied = false;
    try { process.kill(value.pid, 0); }
    catch (error) {
      if (error.code !== 'EPERM') { this.legacyPending.delete(sourceKey); return false; }
      permissionDenied = true;
    }
    if (this.now() - value.startedAt <= LEGACY_LOCK_AGE_MS) {
      this.legacyPending.delete(sourceKey);
      if (permissionDenied) this.report(lock, 'legacy-owner-permission-denied');
      return true;
    }
    const version = fileVersion(stat);
    const known = this.legacyOwners.get(lock);
    if (known?.version === version && (!known.alive || this.now() - known.checkedAt < 5000)) {
      this.legacyPending.delete(sourceKey);
      return known.alive;
    }
    if (!this.legacyPending.has(sourceKey) && this.legacyPending.size >= MAX_TAIL_SCANS) this.legacyPending.delete(this.legacyPending.values().next().value);
    this.legacyPending.add(sourceKey);
    if (this.stopped || this.ownerInspectionBudget === 0 || (this.legacyChosenKey && this.legacyChosenKey !== sourceKey)) return true;
    this.ownerInspectionBudget = 0;
    this.legacyPending.delete(sourceKey);
    this.rememberLegacyInspection(sourceKey);
    // PID existence alone is not ownership: a recycled PID starts after this
    // lock's acquisition. Read only the process birth time, never argv/auth.
    const command = process.platform === 'win32' ? 'powershell.exe' : 'ps';
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${value.pid}).StartTime.ToUniversalTime().ToString('o')`]
      : ['-p', String(value.pid), '-o', 'lstart='];
    const born = await new Promise(resolve => execFile(command, args, {
      encoding: 'utf8', timeout: 1500, maxBuffer: 1024, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout) => resolve(error ? NaN : Date.parse(stdout.trim()))));
    if (this.stopped) return true;
    const alive = !Number.isFinite(born) || born <= value.startedAt + 1000;
    if (this.legacyOwners.size >= MAX_TAIL_SCANS) this.legacyOwners.delete(this.legacyOwners.keys().next().value);
    this.legacyOwners.set(lock, { version, alive, checkedAt: this.now() });
    this.report(crypto.createHash('sha1').update(transcriptPath).digest('hex'), !alive ? 'legacy-lock-pid-reused'
      : Number.isFinite(born) ? 'legacy-worker-still-active' : 'legacy-owner-unverified');
    return alive;
  }

  async contexts(directory, source) {
    const result = [source];
    for (const entry of await names(path.join(directory, 'events'), MAX_CONTEXT_FILES)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const { value: context, stat } = await jsonSnapshot(path.join(directory, 'events', entry.name));
      if (!validSource(context, this.agentId, source.key)) throw new Error('invalid-context');
      context.receipt = { name: entry.name, version: noticeVersion(context, stat) };
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

  async *lines(file, start, end, { allowFinal = false, rebuild = false, countOnly = false, legacyCountFinal = false,
    checkpoint, skipRanges = [] } = {}) {
    const countFinal = countOnly && legacyCountFinal;
    const handle = await this.open(file);
    const tailKey = rebuild ? file + '#rebuild' : file;
    let position = start, lineStart = start, pending = [], pendingBytes = 0, replay = false, lastBuffer, oversized = false;
    try {
      const stat = await handle.stat();
      let tail = checkpoint?.pendingLine ?? this.tailScans.get(tailKey);
      if (tail && tail.start === start && tail.ino === stat.ino && tail.dev === stat.dev
        && end >= tail.position && stat.size >= tail.size) {
        const witness = Buffer.from(tail.witness, 'base64');
        let valid = tail.version === fileVersion(stat);
        if (!valid && stat.size > tail.size) {
          const actual = Buffer.alloc(witness.length);
          valid = await this.read(handle, actual, tail.position - witness.length) === witness.length && actual.equals(witness);
        }
        if (valid) {
          position = tail.position; pendingBytes = position - start; replay = pendingBytes > 0;
          oversized = tail.oversized === true || pendingBytes > this.maxTurnBytes;
          lastBuffer = witness;
          if (position === end && !countFinal && (!allowFinal || tail.finalTried || oversized)) return;
        } else tail = null;
      } else tail = null;
      if (!tail) { this.tailScans.delete(tailKey); if (checkpoint) delete checkpoint.pendingLine; }
      const fullLine = async (from, to) => {
        const bytes = to - from;
        const body = Buffer.alloc(bytes);
        for (let offset = 0; offset < bytes;) {
          const read = await this.read(handle, body.subarray(offset, Math.min(bytes, offset + CHUNK_BYTES)), from + offset);
          if (!read) throw new Error('source-changed-during-read');
          offset += read;
        }
        return body;
      };
      const parse = body => {
        if (countOnly) return {};
        const text = body.toString('utf8').trim();
        if (!text) return {};
        try {
          const row = JSON.parse(text);
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
          this.metrics.recordsParsed++;
          return { row };
        } catch { return { quarantine: 'invalid-json-line' }; }
      };
      while (position < end && this.remainingBytes > 0) {
        // Rehydrate known quarantines by seeking, rather than rereading a huge
        // bad record. Older evicted ranges still scan under the cycle budget.
        const skipped = !pendingBytes && skipRanges.find(range => range.start === position
          && Number.isSafeInteger(range.end) && range.end > position && range.end <= end);
        if (skipped) {
          const from = position; position = skipped.end; lineStart = position;
          yield { row: null, start: from, end: position, bytes: position - from, quarantine: skipped.reason };
          continue;
        }
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, end - position, this.remainingBytes));
        const read = await this.read(handle, buffer, position);
        if (!read) break;
        position += read; lastBuffer = buffer.subarray(0, read);
        let cursor = 0;
        while (cursor < read) {
          const newline = buffer.indexOf(0x0a, cursor);
          const stop = newline >= 0 && newline < read ? newline : read;
          const fragment = buffer.subarray(cursor, stop);
          pendingBytes += fragment.length;
          if (!countOnly && pendingBytes <= this.maxTurnBytes && !replay) pending.push(fragment);
          if (pendingBytes > this.maxTurnBytes) oversized = true;
          if (oversized) pending = [];
          if (stop === read) break;
          const lineEnd = position - read + stop + 1;
          let parsed;
          if (countOnly) parsed = {};
          else if (oversized) parsed = { quarantine: 'record-byte-limit' };
          else parsed = parse(replay ? await fullLine(lineStart, lineEnd - 1) : Buffer.concat(pending, pendingBytes));
          this.tailScans.delete(tailKey); if (checkpoint) delete checkpoint.pendingLine;
          yield { row: null, ...parsed, start: lineStart, end: lineEnd, bytes: lineEnd - lineStart };
          lineStart = lineEnd; pending = []; pendingBytes = 0; replay = false; oversized = false; cursor = stop + 1;
        }
      }
      // The old cursor already includes its final physical line, with or
      // without LF. Count bytes only for that migration; this is not evidence
      // that an ordinary native partial row is ready to parse or deliver.
      if (countFinal && position === end && pendingBytes) {
        this.tailScans.delete(tailKey); if (checkpoint) delete checkpoint.pendingLine;
        yield { row: null, start: lineStart, end, bytes: end - lineStart };
        return;
      }
      if (pendingBytes) {
        if (this.tailScans.size >= MAX_TAIL_SCANS) this.tailScans.delete(this.tailScans.keys().next().value);
        tail = { start: lineStart, position, size: stat.size, ino: stat.ino, dev: stat.dev,
          version: fileVersion(stat), witness: Buffer.from(lastBuffer.subarray(-64)).toString('base64'), oversized, finalTried: false };
        this.tailScans.set(tailKey, tail);
        if (checkpoint) checkpoint.pendingLine = tail;
      }
      if (allowFinal && position === end && pendingBytes && !oversized && !countOnly
        && lastBuffer.toString('utf8').trimEnd().endsWith('}')) {
        if (tail) tail.finalTried = true;
        const parsed = parse(replay ? await fullLine(lineStart, end) : Buffer.concat(pending, pendingBytes));
        if (!parsed.row) return; // A non-newline malformed tail is still a partial native write.
        this.tailScans.delete(tailKey); if (checkpoint) delete checkpoint.pendingLine;
        yield { ...parsed, start: lineStart, end, bytes: end - lineStart };
      }
    } finally { await handle.close(); }
  }

  async findOwnedPrompt(source, contexts, checkpoint, stat) {
    const pending = checkpoint.initialOwnership;
    if (this.promptInspectionBudget <= 0 || (this.promptChosenKey && this.promptChosenKey !== source.key)) return false;
    this.promptInspectionBudget--;
    this.rememberPromptInspection(source.key);
    const proof = await this.resolveInitialPrompt?.(source, pending.requestSetId, pending.dbCursor, pending.dbSearch ??= {});
    if (!proof || !Array.isArray(proof.rows) || proof.rows.length > 256) {
      this.report(source.key, 'initial-prompt-owner-unavailable'); return false;
    }
    if (proof.reset) {
      Object.assign(pending, { offset: 0, seen: 0, candidate: null });
      delete pending.dbCursor; delete pending.pendingLine;
      return false;
    }
    let index = 0;
    for await (const line of this.lines(source.transcriptPath, pending.offset, stat.size, { checkpoint: pending })) {
      if (line.quarantine) {
        this.quarantine(source, pending, line, line.quarantine);
        pending.offset = line.end;
        // A complete bad row advances physical scanning, not the DB/user
        // ordinal. A hidden user leaves unmatched inventory below and cannot
        // establish ownership. Backfill reuses normal quarantine accounting.
        continue;
      }
      if (isRealUserPrompt(line.row)) {
        const row = proof.rows[index];
        const at = Date.parse(line.row.timestamp);
        // Request IDs select the ordinal in a complete ordered inventory.
        // Clocks validate the pairing; they never select a nearest prompt.
        if (!row || !Number.isFinite(row.at) || typeof row.requestId !== 'string' || row.requestId.length > 512
          || !Number.isFinite(at) || Math.abs(at - row.at) > 5000
          || row.at <= (pending.dbCursor?.at ?? 0)) {
          this.report(source.key, 'initial-prompt-owner-pending'); return false;
        }
        if (row.requestId === pending.requestSetId) pending.candidate = line.start;
        pending.lastUserOffset = line.start;
        pending.dbCursor = { ...row, inventoryId: proof.inventoryId };
        pending.seen++; index++;
      }
      pending.offset = line.end;
    }
    if (pending.offset < stat.size || index < proof.rows.length || !proof.complete || pending.candidate === null) {
      this.report(source.key, 'initial-prompt-owner-pending'); return false;
    }
    if (pending.candidate < pending.anchorEnd) {
      checkpoint.backfill = { inode: stat.ino, offset: pending.candidate, committedOffset: pending.candidate,
        activeStart: null, hasUser: false, bootstrapEnd: null, recoveryReason: 'initial-prompt-recovery',
        activeRequestSetId: pending.requestSetId, end: pending.anchorEnd,
        sealedBoundary: pending.lastUserOffset >= pending.anchorEnd };
    }
    delete checkpoint.initialOwnership;
    if (!checkpoint.backfill) delete checkpoint.unresolvedPrompt;
    this.tailScans.delete(source.transcriptPath);
    return true;
  }

  rememberPromptInspection(key) {
    this.promptInspections.delete(key);
    if (this.promptInspections.size >= MAX_TAIL_SCANS) this.promptInspections.delete(this.promptInspections.keys().next().value);
    this.promptInspections.set(key, ++this.promptInspectionSequence);
  }

  async findBootstrap(source, contexts, checkpoint, stat) {
    const file = source.transcriptPath;
    const end = checkpoint.bootstrapEnd;
    if (end === 0) { checkpoint.offset = 0; checkpoint.bootstrapEnd = null; return true; }
    const window = Math.min(checkpoint.bootstrapWindow ?? Math.min(1024 * 1024, this.scanBytes), this.maxTurnBytes);
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
          const prompt = contexts.find(context => context.event === 'UserPromptSubmit' && context.requestSetId);
          if (prompt) {
            checkpoint.initialOwnership = { requestSetId: prompt.requestSetId, anchorEnd: completeEnd,
              offset: 0, seen: 0, candidate: null };
          }
          // Until ownership is proven, this closed prefix might be either
          // history or a late current prompt (older producers may lack IDs).
          // Keep the unresolved range and its notices, while allowing future
          // appended prompts to proceed. Never label that range consumed.
          checkpoint.unresolvedPrompt = { through: completeEnd };
          checkpoint.offset = completeEnd;
          checkpoint.bootstrapEnd = null;
          checkpoint.bootstrapWindow = null;
          this.report(source.key, 'initial-prompt-owner-unavailable');
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
      if (window >= this.maxTurnBytes) {
        // A backwards anchor search must not park forever at one huge row.
        // The cut prefix is not a JSON record or a consumed prompt. Retain its
        // uncertainty and seek its LF forwards under the ordinary scan budget.
        checkpoint.unresolvedPrompt = { through: end, reason: 'bootstrap-record-byte-limit' };
        checkpoint.bootstrapEnd = null;
        checkpoint.bootstrapWindow = null;
        if (firstNewline >= 0) {
          checkpoint.offset = completeEnd;
          this.quarantine(source, checkpoint, { start, end: completeEnd }, 'bootstrap-record-byte-limit');
        } else {
          checkpoint.offset = start;
          checkpoint.pendingLine = { start, position: end, size: stat.size, ino: stat.ino, dev: stat.dev,
            version: fileVersion(stat), witness: buffer.subarray(-64).toString('base64'), oversized: true, finalTried: true };
          this.tailScans.delete(file);
          this.report(source.key, 'bootstrap-record-byte-limit');
        }
        return true;
      }
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
      const end = checkpoint.retainedEnd ?? checkpoint.offset;
      for await (const line of this.lines(source.transcriptPath, value.end, end, {
        rebuild: true, allowFinal: true, checkpoint: value, skipRanges: checkpoint.quarantines,
      })) {
        if (line.row) value.rows.push(line.row);
        if (line.row) value.bytes += line.bytes;
        value.end = line.end;
        if (value.bytes > this.maxTurnBytes) throw new Error('turn-byte-limit');
      }
      this.remember(source.key, value);
      if (value.end < end) return null;
    }
    return value;
  }

  async trailingTerminalContext(source, contexts, endOffset) {
    const candidate = contexts.find(item => item.observedSize > endOffset
      && TERMINAL_CONTEXT_EVENTS.has(item.event));
    if (!candidate) return null;
    const bytes = candidate.observedSize - endOffset;
    // A later invocation can publish the next terminal context when this
    // Turn's Stop notice is absent. Only borrow across the small native CLI
    // control tail that follows last-prompt; any content row keeps ownership
    // unproven and falls back to source metadata.
    if (bytes <= 0 || bytes > MAX_TRAILING_CONTROL_BYTES || bytes > this.remainingBytes) return null;
    let handle;
    try {
      handle = await this.open(source.transcriptPath);
      const stat = await handle.stat();
      if (candidate.observedSize > stat.size) return null;
      const buffer = Buffer.alloc(bytes);
      for (let offset = 0; offset < bytes;) {
        const read = await this.read(handle, buffer.subarray(offset), endOffset + offset);
        if (!read) return null;
        offset += read;
      }
      // Hook watermarks can observe a concurrent partial write. Such a range
      // cannot prove ownership, even when its prefix resembles a CLI control.
      if (buffer[buffer.length - 1] !== 0x0a) return null;
      const lines = buffer.toString('utf8').split('\n');
      lines.pop();
      for (const line of lines) {
        if (!line) return null;
        const row = JSON.parse(line);
        if (!isControlUserRow(row) && !TERMINAL_CONTEXT_EVENTS.has(eventOf(row))) return null;
      }
      return candidate;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async build(source, contexts, checkpoint, value, endOffset, terminalSource) {
    if (this.stopped) throw new Error('stopped');
    if (!checkpoint.hasUser || !value.rows.length) return [];
    const reverseContexts = [...contexts].reverse();
    let context = reverseContexts.find(item => checkpoint.activeRequestSetId
      && item.requestSetId === checkpoint.activeRequestSetId)
      ?? reverseContexts.find(item => item.observedSize <= endOffset
      && (item.observedSize > checkpoint.activeStart || (item.observedSize >= (checkpoint.contextFloor ?? checkpoint.activeStart)
        && (item.event === 'UserPromptSubmit' || item.event === 'SessionStart'))));
    // Qoder can invoke Stop after appending last-prompt or a local /exit row.
    // Prove that intervening bytes are only that control tail before borrowing
    // the following context; a next-prompt boundary must never look forward.
    if (!context && terminalSource === 'last-prompt') {
      context = await this.trailingTerminalContext(source, contexts, endOffset);
    }
    context ??= { cwd: source.cwd, desktop: source.desktop, userIdentity: source.userIdentity };
    const config = { ...loadHookRuntimeConfig(this.dataDir),
      userIdentity: context.userIdentity ?? source.userIdentity,
      resourceAttributes: context.resourceAttributes ?? {},
      spanAttributes: context.spanAttributes ?? {} };
    // The CLI persists local slash commands as user rows, including /exit
    // after the final response. Reuse the legacy parser's control-row contract
    // for both boundaries and messages so these cannot create an empty Turn
    // or leak into the next model request when a turn is still being drained.
    const content = value.rows.filter(row => (row.type === 'user' || row.type === 'assistant') && !isControlUserRow(row));
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
      if (checkpoint.incomplete) {
        record['agent.transcript_incomplete'] = true;
        // A damaged record may have been a terminal or a tool result. Do not
        // turn the parser's last-step inference into a fabricated completion.
        if (record['event.name'] === 'llm.response' && !record['agent.stop_reason']
          && record['gen_ai.response.finish_reasons']?.[0] === 'end_turn') {
          delete record['gen_ai.response.finish_reasons'];
          for (const message of record['gen_ai.output.messages'] ?? []) delete message.finish_reason;
        }
      }
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
    delete checkpoint.incomplete;
    delete checkpoint.retainedEnd;
    delete checkpoint.turnTruncated;
    delete checkpoint.activeRequestSetId;
  }

  quarantine(source, checkpoint, line, reason) {
    const ranges = checkpoint.quarantines ??= [];
    if (!ranges.some(range => range.start === line.start && range.end === line.end && range.reason === reason)) {
      ranges.push({ start: line.start, end: line.end, reason });
      if (ranges.length > 32) ranges.shift();
    }
    if (checkpoint.hasUser) checkpoint.incomplete = true;
    this.report(source.key, reason);
  }

  async scanSource(source, contexts, checkpoint, stat) {
    const records = [];
    for (const property of ['migration', 'findAnchorLine']) {
      if (!checkpoint[property]) continue;
      const migration = checkpoint[property];
      if (migration.target > migration.seen) {
        for await (const line of this.lines(source.transcriptPath, checkpoint.offset, stat.size, {
          countOnly: true, legacyCountFinal: property === 'migration', checkpoint,
        })) {
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
    if (checkpoint.bootstrapEnd !== null && !await this.findBootstrap(source, contexts, checkpoint, stat)) return records;
    if (checkpoint.initialOwnership) await this.findOwnedPrompt(source, contexts, checkpoint, stat);
    if (checkpoint.backfill) {
      const backfill = checkpoint.backfill;
      // Ownership lookup may wait for the DB. Keep its bounded historical
      // range separate from the live cursor so new Turns are never parked or
      // replayed when delayed evidence eventually arrives.
      const recoverySource = { ...source, key: source.key + ':backfill' };
      records.push(...await this.scanSource(recoverySource, contexts, backfill, { ...stat, size: backfill.end }));
      if (backfill.offset >= backfill.end && backfill.activeStart === null) {
        checkpoint.committedOffset = Math.max(checkpoint.committedOffset, backfill.end);
        delete checkpoint.backfill;
        delete checkpoint.unresolvedPrompt;
        this.dropCache(recoverySource.key);
      }
    }
    if (checkpoint.stableSize !== stat.size || checkpoint.stableMtime !== stat.mtimeMs) {
      checkpoint.stableSize = stat.size;
      checkpoint.stableMtime = stat.mtimeMs;
      checkpoint.stableAt = this.now();
    }
    const stable = this.now() - checkpoint.stableAt >= this.stableMs;
    const ready = stable && checkpoint.terminal
      && this.now() - (checkpoint.terminalAt ?? checkpoint.stableAt) >= this.settleMs;
    if (checkpoint.offset === stat.size && checkpoint.activeStart !== null && !ready && !checkpoint.sealedBoundary) return records;
    let value = await this.rowsFor(source, checkpoint);
    if (!value) return records;
    let turns = 0;
    for await (const line of this.lines(source.transcriptPath, checkpoint.offset, stat.size, { allowFinal: stable, checkpoint })) {
      const row = line.row;
      if (line.quarantine) this.quarantine(source, checkpoint, line, line.quarantine);
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
        if (row && !checkpoint.turnTruncated) {
          const reason = value.rows.length >= MAX_TURN_RECORDS ? 'turn-record-limit'
            : value.bytes + line.bytes > this.maxTurnBytes ? 'turn-byte-limit' : null;
          if (reason) {
            checkpoint.turnTruncated = true;
            checkpoint.retainedEnd = line.start;
            this.quarantine(source, checkpoint, line, reason);
          } else { value.rows.push(row); value.bytes += line.bytes; }
        }
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
    if (checkpoint.pendingLine && checkpoint.pendingLine.position - checkpoint.pendingLine.start > this.maxTurnBytes) {
      if (checkpoint.hasUser) checkpoint.incomplete = true;
      this.report(source.key, 'record-byte-limit');
    }
    if (checkpoint.hasUser && !checkpoint.terminal && !checkpoint.nativeStopOffset
      && value.rows.some(row => row.type === 'assistant') && contexts.some(context => context.event === 'Stop'
      && context.observedSize > checkpoint.activeStart && context.observedSize <= checkpoint.offset)) {
      checkpoint.terminal = true;
      checkpoint.terminalAt = this.now();
    }
    if (checkpoint.activeStart !== null && checkpoint.sealedBoundary && checkpoint.offset === stat.size) {
      records.push(...await this.build(source, contexts, checkpoint, value, checkpoint.offset, 'next-prompt-backfill'));
      checkpoint.committedOffset = checkpoint.offset;
      this.clearActive(checkpoint);
      value = { start: null, end: checkpoint.offset, rows: [], bytes: 0 };
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
