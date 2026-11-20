// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { resolveHome, directoryExists, writeTextFileAtomic } from '../../utils/fs-utils.js';
import { resolveDataDir } from '../../utils/data-dir.js';
import { DEFAULT_POLL_INTERVAL_MS } from '../../utils/poll-interval.js';
import { BaseSessionInput, type SessionInputOptions } from '../base/base-session-input.js';
import { CopilotSourceIndex } from './source-index.js';
import { parseInteractions } from '../../../assets/hooks/copilot/interaction-parser.mjs';

const copilotHome = () => process.env.COPILOT_HOME || resolveHome('~/.copilot');
export interface CopilotLogInputOptions extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
  dataDir?: string;
  otelDir?: string;
  multimodal?: unknown;
  /** Wait for native evidence when session exporter capability is unknown. */
  nativeGraceMs?: number;
  /** Explicit event-time floor for controlled historical replay. Persisted once; defaults to first activation. */
  historyStartTimeMs?: number;
}

/** Incrementally index source files; checkpoint only complete queued interactions.
 * Durable read progress is independent of the delivery checkpoint.
 */
export class CopilotLogInput extends BaseSessionInput {
  readonly id = 'copilot-log';
  readonly agentType = ClientType.CopilotCli;
  override readonly collectionMethod = CollectionMethod.SessionFilePolling;
  private readonly otelDir: string;
  private readonly wakeupDir: string;
  private readonly index: CopilotSourceIndex;
  private queuedKeys: string[] = [];
  private watcher?: fsSync.FSWatcher;
  private readonly nativeGraceMs: number;
  private readonly policyFile: string;
  private readonly initialHistoryStartTimeMs?: number;
  private historyStartTimeMs?: number;

  constructor(opts: CopilotLogInputOptions) {
    super({ stateStore: opts.stateStore, sessionDir: opts.sessionDir ?? path.join(copilotHome(), 'session-state'),
      filePattern: opts.filePattern ?? '*/events.jsonl', pollIntervalMs: Number.isFinite(opts.pollIntervalMs) && opts.pollIntervalMs! > 0 ? opts.pollIntervalMs! : DEFAULT_POLL_INTERVAL_MS });
    const dataDir = opts.dataDir || resolveDataDir();
    this.initialHistoryStartTimeMs = opts.historyStartTimeMs;
    if (this.initialHistoryStartTimeMs !== undefined
      && (!Number.isSafeInteger(this.initialHistoryStartTimeMs) || this.initialHistoryStartTimeMs < 0)) {
      throw new RangeError('Copilot historyStartTimeMs must be a nonnegative epoch-millisecond integer');
    }
    this.policyFile = path.join(dataDir, 'state', 'copilot', 'collection-policy.json');
    this.nativeGraceMs = opts.nativeGraceMs ?? 30_000;
    this.index = new CopilotSourceIndex(path.join(dataDir, 'state', 'copilot', 'source-index.sqlite'), (file, offset) => {
      this.logger.warn('Skipping malformed complete Copilot record', { file, offset });
    });
    this.otelDir = opts.otelDir || path.join(dataDir, 'state', 'copilot', 'otel');
    this.wakeupDir = path.join(dataDir, 'state', 'copilot', 'session-wakeups');
  }
  static async checkAvailability(): Promise<boolean> { return directoryExists(copilotHome()); }
  static getWatchPaths(): string[] { return [copilotHome()]; }
  protected override async onStart(): Promise<void> {
    await fs.mkdir(this.wakeupDir, { recursive: true, mode: 0o700 });
    try {
      const watcher = fsSync.watch(this.wakeupDir, () => this.requestCollection());
      this.watcher = watcher;
      watcher.on('error', err => {
        this.logger.warn('Copilot wakeup watcher failed; using polling', { error: String(err) });
        watcher.close(); if (this.watcher === watcher) this.watcher = undefined;
      });
    } catch { /* polling fallback */ }
  }
  protected override async onStop(): Promise<void> { this.watcher?.close(); this.watcher = undefined; await this.index.close(); }
  protected async discoverSessionFiles(): Promise<string[]> {
    const names = await fs.readdir(this.sessionDir, { withFileTypes: true });
    return names.filter(n => n.isDirectory()).map(n => path.join(this.sessionDir, n.name, 'events.jsonl'));
  }
  protected async processSessionLine(): Promise<AgentActivityEntry | null> { return null; }

  private async applyHistoryPolicy(): Promise<void> {
    if (this.historyStartTimeMs === undefined) {
      let policy: unknown;
      try { policy = JSON.parse((await fs.readFile(this.policyFile, 'utf8')).replace(/^\uFEFF/, '')); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read Copilot collection policy: ${String(err)}`);
      }
      const indexedStart = await this.index.historyStartTime();
      if (policy !== undefined) {
        const value = policy as { schema?: unknown; historyStartTimeMs?: unknown } | null;
        if (!value || value.schema !== 1 || !Number.isSafeInteger(value.historyStartTimeMs)
          || typeof value.historyStartTimeMs !== 'number' || value.historyStartTimeMs < 0) {
          throw new Error('Invalid Copilot collection policy; refusing to reset the historical boundary');
        }
        if (indexedStart !== undefined && indexedStart !== value.historyStartTimeMs) {
          throw new Error('Copilot collection policy disagrees with the source index');
        }
        this.historyStartTimeMs = value.historyStartTimeMs;
      } else {
        const start = indexedStart ?? this.initialHistoryStartTimeMs ?? Date.now();
        await writeTextFileAtomic(this.policyFile, JSON.stringify({ schema: 1, historyStartTimeMs: start }) + '\n', {
          mode: 0o600, expected: { exists: false },
        });
        this.historyStartTimeMs = start;
      }
    }
    await this.index.applyHistoryPolicy(this.historyStartTimeMs);
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    this.queuedKeys = [];
    await this.index.open();
    await this.applyHistoryPolicy();
    let files: string[];
    try { files = await this.discoverSessionFiles(); } catch { return []; }
    await this.index.pruneDeletedSessions(files);
    // Import the previous delivery ledger once. Source offsets remain unrelated
    // to delivery, so an interrupted import is safe to repeat.
    for (const key of this.stateStore.keys().filter(k => k.startsWith(`${this.id}:v2:`))) {
      await this.index.markDelivered(this.stateStore.get(key).extra?.interactions as string[] || []);
      this.stateStore.delete(key);
    }
    const otelFiles = new Set<string>();
    try { for (const n of await fs.readdir(this.otelDir)) if (n.endsWith('.jsonl')) otelFiles.add(path.join(this.otelDir, n)); } catch { /* first launch */ }
    const externalOtel = new Map<string, string>();
    const markerSessions = new Set<string>();

    try {
      for (const name of await fs.readdir(this.wakeupDir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const marker = JSON.parse(await fs.readFile(path.join(this.wakeupDir, name), 'utf8'));
          if (typeof marker.session_id === 'string') markerSessions.add(marker.session_id);
          if (typeof marker.otel_file === 'string' && path.isAbsolute(marker.otel_file) && typeof marker.session_id === 'string') {
            externalOtel.set(marker.session_id, marker.otel_file); otelFiles.add(marker.otel_file);
          }
        } catch { /* markers are advisory */ }
      }
    } catch { /* no hooks yet */ }
    // A real user boundary is authoritative when native clocks differ. Index it
    // before native evidence so a late/skewed span cannot suppress a new turn.
    for (const file of files) {
      try { await this.index.ingest(file, 'event'); }
      catch (err) { this.logger.warn('Copilot source unavailable; checkpoint retained', { file, error: String(err) }); }
    }
    for (const file of otelFiles) {
      try { await this.index.ingest(file, 'span'); }
      catch (err) { this.logger.warn('Copilot OTel source unavailable; retaining source state', { file, error: String(err) }); }
    }
    await this.index.restoreDeferredSpans();
    for (const pending of await this.index.pending()) {
      const sid = pending.session;
      if (!await this.index.isEligible(sid, pending.id)) continue;
      const requireOtel = externalOtel.has(sid) || await this.index.hasNative(sid);
      const source = await this.index.load(sid, pending.id);
      // Global installation state says nothing about an already-open terminal.
      // Unknown sessions wait for delayed native evidence before transcript-only
      // degradation; explicit no-file markers do not wait. Never degrade while
      // a discovered source is still being drained.
      if (!requireOtel && !markerSessions.has(sid) && !pending.id.startsWith('summary:')) {
        const closed = parseInteractions(source.events, [], { requireOtel: false }).length > 0;
        if (!closed || await this.index.awaitingNative(sid, pending.id, Date.now(), this.nativeGraceMs) || await this.index.hasUnreadSource()) continue;
      }
      const key = `copilot:${sid}:${pending.id}`;
      const batch = parseInteractions(source.events, source.spans, { requireOtel }).find(b => b.key === key);
      if (batch?.records.length) {
        this.queuedKeys = [key];
        return batch.records.map(record => ({ ...record, 'gen_ai.copilot.telemetry.source': requireOtel ? 'native-otel' : 'transcript-only' })); // explicit degradation, never invented usage
      }
    }
    return [];
  }
  protected override async onEntriesQueued(): Promise<void> {
    // Another input may freeze the shared checkpoint during our async collect.
    // InputManager then rejects this batch without throwing; leave SQLite pending.
    if (this.checkpointFailed) return;
    await this.index.markDelivered(this.queuedKeys);
    this.queuedKeys = [];
  }
}
