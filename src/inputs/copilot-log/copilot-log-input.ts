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
import { parseInteractions } from '../../../assets/hooks/copilot/interaction-parser.mjs';

const copilotHome = () => process.env.COPILOT_HOME || resolveHome('~/.copilot');
const READ_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
interface CachedFile { inode: number; offset: number; records: any[] }
export interface CopilotLogInputOptions extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
  dataDir?: string;
  otelDir?: string;
  multimodal?: unknown;
}

/** Replay source files on restart; checkpoint only complete queued interactions.
 * Read progress is an in-memory optimization, never evidence of delivery.
 */
export class CopilotLogInput extends BaseSessionInput {
  readonly id = 'copilot-log';
  readonly agentType = ClientType.CopilotCli;
  override readonly collectionMethod = CollectionMethod.SessionFilePolling;
  private readonly otelDir: string;
  private readonly wakeupDir: string;
  private readonly cache = new Map<string, CachedFile>();
  private queuedMarks: Array<{ stateKey: string; keys: string[] }> = [];
  private watcher?: fsSync.FSWatcher;

  constructor(opts: CopilotLogInputOptions) {
    super({ stateStore: opts.stateStore, sessionDir: opts.sessionDir ?? path.join(copilotHome(), 'session-state'),
      filePattern: opts.filePattern ?? '*/events.jsonl', pollIntervalMs: opts.pollIntervalMs ?? 5_000 });
    const dataDir = opts.dataDir || resolveDataDir();
    this.otelDir = opts.otelDir || path.join(dataDir, 'state', 'copilot', 'otel');
    this.wakeupDir = path.join(dataDir, 'state', 'copilot', 'session-wakeups');
  }
  static async checkAvailability(): Promise<boolean> { return directoryExists(copilotHome()); }
  static getWatchPaths(): string[] { return [copilotHome()]; }
  protected override async onStart(): Promise<void> {
    await fs.mkdir(this.wakeupDir, { recursive: true, mode: 0o700 });
    try { this.watcher = fsSync.watch(this.wakeupDir, () => this.requestCollection()); } catch { /* polling fallback */ }
  }
  protected override async onStop(): Promise<void> { this.watcher?.close(); this.watcher = undefined; this.cache.clear(); }
  protected async discoverSessionFiles(): Promise<string[]> {
    const names = await fs.readdir(this.sessionDir, { withFileTypes: true });
    return names.filter(n => n.isDirectory()).map(n => path.join(this.sessionDir, n.name, 'events.jsonl'));
  }
  protected async processSessionLine(): Promise<AgentActivityEntry | null> { return null; }

  private async readComplete(file: string): Promise<{ records: any[]; complete: boolean }> {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Copilot source exceeds 64 MiB per-file limit');
    let cache = this.cache.get(file);
    if (!cache || cache.inode !== Number(stat.ino) || stat.size < cache.offset) {
      cache = { inode: Number(stat.ino), offset: 0, records: [] }; this.cache.set(file, cache);
    }
    if (stat.size > cache.offset) {
      const handle = await fs.open(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(READ_BYTES, stat.size - cache.offset));
        const { bytesRead } = await handle.read(buf, 0, buf.length, cache.offset);
        const end = buf.subarray(0, bytesRead).lastIndexOf(10);
        if (end >= 0) {
          const parsed: any[] = [];
          for (const line of buf.subarray(0, end + 1).toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            const record = JSON.parse(line); // never advance past an invalid complete line
            if (record && typeof record === 'object' && !Array.isArray(record)) parsed.push(record);
          }
          cache.records.push(...parsed);
          cache.offset += end + 1;
        }
      } finally { await handle.close(); }
    }
    return { records: cache.records, complete: cache.offset === stat.size };
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    this.queuedMarks = [];
    let files: string[];
    try { files = await this.discoverSessionFiles(); } catch { return []; }
    // Only prune state after a complete directory enumeration and definite deletion.
    for (const key of this.stateStore.keys().filter(k => k.startsWith(`${this.id}:v2:`))) {
      const file = key.slice(`${this.id}:v2:`.length);
      if (!files.includes(file)) { this.stateStore.delete(key); this.cache.delete(file); }
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
    const native: any[] = [];
    for (const file of otelFiles) {
      try { native.push(...(await this.readComplete(file)).records); }
      catch (err) { this.logger.warn('Copilot OTel source unavailable; retaining transcript', { file, error: String(err) }); }
    }
    const entries: AgentActivityEntry[] = [];
    // Bound the number of active cached files; do not silently evict unread sources.
    for (const file of files) {
      try {
        const snapshot = await this.readComplete(file);
        if (!snapshot.complete) continue;
        const sid = snapshot.records.find(e => e.type === 'session.start')?.data?.sessionId;
        const requireOtel = (managedOtel && !markerSessions.has(sid)) || externalOtel.has(sid) || native.some(s => s.attributes?.['gen_ai.conversation.id'] === sid);
        const stateKey = `${this.id}:v2:${file}`;
        const done = new Set(this.stateStore.get(stateKey).extra?.interactions as string[] || []);
        const batches = parseInteractions(snapshot.records, native, { requireOtel });
        const fresh = batches.filter(b => !done.has(b.key));
        if (fresh.length) {
          entries.push(...fresh.flatMap(b => b.records));
          this.queuedMarks.push({ stateKey, keys: [...done, ...fresh.map(b => b.key)] });
        }
      } catch (err) { this.logger.warn('Copilot source unavailable; checkpoint retained', { file, error: String(err) }); }
    }
    // Cache is only an optimization: eviction replays source and the queued
    // interaction ledger prevents duplicate delivery. No file is skipped.
    while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
    return entries;
  }
  protected override onEntriesQueued(): void {
    for (const mark of this.queuedMarks) this.stateStore.update(mark.stateKey, { extra: { interactions: mark.keys } });
    this.queuedMarks = [];
  }
}
