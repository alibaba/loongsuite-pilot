// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { resolveDataDir } from '../../utils/data-dir.js';
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

  constructor(opts: CopilotLogInputOptions) {
    super({ stateStore: opts.stateStore, sessionDir: opts.sessionDir ?? path.join(copilotHome(), 'session-state'),
      filePattern: opts.filePattern ?? '*/events.jsonl', pollIntervalMs: opts.pollIntervalMs ?? 5_000 });
    const dataDir = opts.dataDir || resolveDataDir();
    this.index = new CopilotSourceIndex(path.join(dataDir, 'state', 'copilot', 'source-index.sqlite'));
    this.otelDir = opts.otelDir || path.join(dataDir, 'state', 'copilot', 'otel');
    this.wakeupDir = path.join(dataDir, 'state', 'copilot', 'session-wakeups');
  }
  static async checkAvailability(): Promise<boolean> { return directoryExists(copilotHome()); }
  static getWatchPaths(): string[] { return [copilotHome()]; }
  protected override async onStart(): Promise<void> {
    await fs.mkdir(this.wakeupDir, { recursive: true, mode: 0o700 });
    try { this.watcher = fsSync.watch(this.wakeupDir, () => this.requestCollection()); } catch { /* polling fallback */ }
  }
  protected override async onStop(): Promise<void> { this.watcher?.close(); this.watcher = undefined; await this.index.close(); }
  protected async discoverSessionFiles(): Promise<string[]> {
    const names = await fs.readdir(this.sessionDir, { withFileTypes: true });
    return names.filter(n => n.isDirectory()).map(n => path.join(this.sessionDir, n.name, 'events.jsonl'));
  }
  protected async processSessionLine(): Promise<AgentActivityEntry | null> { return null; }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    this.queuedKeys = [];
    await this.index.open();
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
    const managedOtel = fsSync.existsSync(path.join(this.otelDir, '..', 'otel-enabled'));
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
    for (const file of otelFiles) {
      try { await this.index.ingest(file, 'span'); }
      catch (err) { this.logger.warn('Copilot OTel source unavailable; retaining source state', { file, error: String(err) }); }
    }
    for (const file of files) {
      try { await this.index.ingest(file, 'event'); }
      catch (err) { this.logger.warn('Copilot source unavailable; checkpoint retained', { file, error: String(err) }); }
    }
    for (const pending of await this.index.pending()) {
      const sid = pending.session;
      const requireOtel = (managedOtel && !markerSessions.has(sid)) || externalOtel.has(sid) || await this.index.hasNative(sid);
      const source = await this.index.load(sid, pending.id);
      const key = `copilot:${sid}:${pending.id}`;
      const ready = parseInteractions(source.events, source.spans, { requireOtel, contextEvents: [] }).some(b => b.key === key);
      if (!ready) continue;
      const context = pending.id.startsWith('summary:') ? [] : await this.index.context(sid, source.events.at(-1)?.timestamp || '');
      const batch = parseInteractions(source.events, source.spans, { requireOtel, contextEvents: context }).find(b => b.key === key);
      if (batch?.records.length) {
        this.queuedKeys = [key];
        return batch.records; // one materialized interaction at a time
      }
    }
    return [];
  }
  protected override async onEntriesQueued(): Promise<void> {
    await this.index.markDelivered(this.queuedKeys);
    this.queuedKeys = [];
  }
}
