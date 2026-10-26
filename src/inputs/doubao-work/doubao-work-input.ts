import * as fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import type { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../types/index.js';
import { buildDoubaoTaskEvents, doubaoDigest, parseDoubaoLogLine, type DoubaoPendingTurn, type DoubaoLogEvent } from './doubao-work-log.js';

const FILE_PATTERN = /^saman_frontend_\d{4}\.\d{4}\.\d+\.log$/;
const MAX_FILES = 128;
const READ_BYTES = 1024 * 1024;
const CYCLE_BYTES = 8 * READ_BYTES;
const MAX_PENDING = 512;
const MAX_COMPLETED = 4096;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETED_TTL_MS = 7 * PENDING_TTL_MS;

interface FileCursor { identity: string; offset: number; anchor?: string; skippingLine?: boolean }
interface PendingTurn extends DoubaoPendingTurn { startObserved: boolean; terminal?: DoubaoLogEvent }
interface Checkpoint {
  schema: 1;
  sinceMs: number;
  files: Record<string, FileCursor>;
  pending: Record<string, PendingTurn>;
  completed: Record<string, number>;
}

export interface DoubaoWorkInputOptions extends InputOptions { logDir?: string }

/** Read-only macOS adapter for Doubao Work 2.33.10's frontend message lifecycle. */
export class DoubaoWorkInput extends BaseInput {
  readonly id = 'doubao-work';
  readonly agentType = ClientType.DoubaoWork;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;
  private readonly logDir: string | undefined;
  private readonly scope: string;
  private watcher: FSWatcher | undefined;
  private wakeup: ReturnType<typeof setTimeout> | undefined;
  private warnedFileLimit = false;

  constructor(opts: DoubaoWorkInputOptions) {
    super(opts);
    this.logDir = opts.logDir ? path.resolve(opts.logDir) : DoubaoWorkInput.defaultLogDir();
    this.scope = doubaoDigest(this.logDir ?? 'unsupported-platform');
  }

  static defaultLogDir(): string | undefined {
    return process.platform === 'darwin'
      ? path.join(homedir(), 'Library', 'Application Support', 'DoubaoWork', 'sdk_storage', 'log')
      : undefined;
  }

  static getWatchPaths(logDir = DoubaoWorkInput.defaultLogDir()): string[] {
    return logDir ? [logDir] : [];
  }

  static async checkAvailability(logDir = DoubaoWorkInput.defaultLogDir()): Promise<boolean> {
    if (!logDir) return false;
    try {
      return (await fs.readdir(logDir, { withFileTypes: true }))
        .some(entry => entry.isFile() && FILE_PATTERN.test(entry.name));
    } catch { return false; }
  }

  protected override async onStart(): Promise<void> {
    if (!this.logDir) return;
    try {
      this.watcher = watch(this.logDir, { persistent: false }, (_event, name) => {
        if (name && !FILE_PATTERN.test(name.toString())) return;
        if (this.wakeup) return;
        this.wakeup = setTimeout(() => {
          this.wakeup = undefined;
          this.requestCollection();
        }, 100);
        this.wakeup.unref();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
        this.logger.warn('Doubao Work file watcher unavailable; using bounded polling');
      });
    } catch {
      this.logger.warn('Doubao Work file watcher unavailable; using bounded polling');
    }
  }

  protected override async onStop(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.wakeup) clearTimeout(this.wakeup);
    this.wakeup = undefined;
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    if (!this.logDir) return [];
    let allNames: string[];
    try {
      allNames = (await fs.readdir(this.logDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && FILE_PATTERN.test(entry.name)).map(entry => entry.name).sort();
    } catch {
      this.logger.warn('Doubao Work log directory unavailable; preserving checkpoint');
      return [];
    }
    const names = allNames.slice(-MAX_FILES);
    if (allNames.length > MAX_FILES && !this.warnedFileLimit) {
      this.warnedFileLimit = true;
      this.logger.warn('Doubao Work source file limit reached; only newest files are read', { limit: MAX_FILES });
    }
    const saved = this.getState().extra?.doubaoWork as Checkpoint | undefined;
    if (saved && saved.schema !== 1) {
      this.logger.warn('Unsupported Doubao Work checkpoint schema; preserving state');
      return [];
    }
    // Baseline all existing files once. New rotations are subsequently read from byte zero.
    if (!saved) {
      const initial: Checkpoint = { schema: 1, sinceMs: Date.now(), files: {}, pending: {}, completed: {} };
      for (const name of names) {
        try {
          const stat = await fs.stat(path.join(this.logDir, name));
          // Fingerprint the cursor boundary to detect in-place truncate-and-regrow.
          const handle = await fs.open(path.join(this.logDir, name), 'r');
          try {
            initial.files[name] = { identity: fileIdentity(stat), offset: stat.size, anchor: await boundaryAnchor(handle, stat.size, this.getInputRuntimeAccumulator()) };
          } finally { await handle.close(); }
        } catch { return []; } // Do not commit an incomplete initial baseline.
      }
      this.setState({ extra: { doubaoWork: initial } });
      return [];
    }
    const next: Checkpoint = JSON.parse(JSON.stringify(saved));
    const entries: AgentActivityEntry[] = [];
    const events: DoubaoLogEvent[] = [];
    let remainingBytes = CYCLE_BYTES;
    for (const name of names) {
      if (remainingBytes <= 0) break;
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(path.join(this.logDir, name), 'r');
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        const identity = fileIdentity(stat);
        const prior = next.files[name] ?? Object.values(next.files).find(cursor => cursor.identity === identity);
        const cursor: FileCursor = prior?.identity === identity && prior.offset <= stat.size
          ? { ...prior } : { identity, offset: 0 };
        if (cursor.anchor && cursor.anchor !== await boundaryAnchor(handle, cursor.offset, this.getInputRuntimeAccumulator())) {
          cursor.offset = 0;
          cursor.skippingLine = false;
        }
        const unread = stat.size - cursor.offset;
        this.getInputRuntimeAccumulator()?.observeBacklog(unread);
        if (unread > 0) {
          const requested = Math.min(READ_BYTES, remainingBytes, unread);
          const buffer = Buffer.allocUnsafe(requested);
          const started = performance.now();
          const { bytesRead } = await handle.read(buffer, 0, requested, cursor.offset);
          this.getInputRuntimeAccumulator()?.observeRead(bytesRead, requested, performance.now() - started);
          remainingBytes -= bytesRead;
          const chunk = buffer.subarray(0, bytesRead);
          let from = 0;
          let records = 0;
          let parsed = 0;
          const fileEvents: DoubaoLogEvent[] = [];
          let maxLineBytes = 0;
          while (from < chunk.length) {
            const newline = chunk.indexOf(10, from);
            if (newline < 0) break; // A normal trailing half-line keeps its old offset.
            const end = newline + 1;
            records++;
            maxLineBytes = Math.max(maxLineBytes, end - from);
            if (!cursor.skippingLine) {
              const event = parseDoubaoLogLine(chunk.subarray(from, newline).toString('utf8'), name);
              if (event) {
                parsed++;
                fileEvents.push(event);
              }
            }
            cursor.skippingLine = false;
            from = end;
          }
          // An oversized line is skipped through its newline without unbounded buffering.
          if (from === 0 && bytesRead === READ_BYTES) {
            from = bytesRead;
            cursor.skippingLine = true;
            this.logger.warn('Doubao Work oversized log line skipped');
          }
          cursor.offset += from;
          const after = await handle.stat();
          if (fileIdentity(after) !== identity || after.size < cursor.offset) continue;
          cursor.anchor = await boundaryAnchor(handle, cursor.offset, this.getInputRuntimeAccumulator());
          events.push(...fileEvents);
          this.getInputRuntimeAccumulator()?.observeCommittedBatch({
            bytes: from, records, parseSuccessRecords: parsed, parseFailedRecords: 0, maxRecordBytes: maxLineBytes,
          });
        }
        next.files[name] = cursor;
      } catch {
        // Failed stat/read is not deletion. Do not mutate this file's committed cursor.
        this.logger.warn('Doubao Work log read unavailable; preserving file checkpoint');
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    events.sort((a, b) => BigInt(a.timeNano) < BigInt(b.timeNano) ? -1 : BigInt(a.timeNano) > BigInt(b.timeNano) ? 1 : 0);
    for (const event of events) this.consume(next, event, entries);
    // A successful directory enumeration is positive evidence of which paths disappeared.
    const present = new Set(allNames);
    for (const name of Object.keys(next.files)) if (!present.has(name)) delete next.files[name];
    const dropped = compact(next.pending, MAX_PENDING, PENDING_TTL_MS, item => item.updatedMs);
    if (dropped) this.logger.warn('Doubao Work incomplete requests expired or exceeded capacity; no trace inferred', { requests: dropped });
    compact(next.completed, MAX_COMPLETED, COMPLETED_TTL_MS, item => item);
    this.setState({ extra: { doubaoWork: next } });
    return entries;
  }

  private consume(
    state: Checkpoint, event: DoubaoLogEvent, entries: AgentActivityEntry[],
  ): void {
    if (event.name === 'general_agent_message_id_mapping') {
      if (!event.localMessageId || !event.conversationId) return;
      for (const [key, pending] of Object.entries(state.pending)) {
        if (pending.localMessageId !== event.localMessageId) continue;
        pending.conversationId = event.conversationId;
        this.complete(state, key, pending, entries);
      }
      return;
    }
    if (!event.turnId || event.queryMs === undefined || event.queryMs < Math.max(state.sinceMs, Date.now() - COMPLETED_TTL_MS)) return;
    const key = `${event.turnId}:${event.queryMs}`;
    if (state.completed[key] !== undefined) return;
    let pending = state.pending[key];
    if (event.name === 'on_message_session_end') {
      pending = state.pending[key] = {
        ...pending, turnId: event.turnId, queryMs: event.queryMs,
        startObserved: pending?.startObserved ?? false,
        terminal: event, updatedMs: Date.now(),
      };
    } else {
      pending = state.pending[key] = {
        ...pending,
        turnId: event.turnId, queryMs: event.queryMs,
        conversationId: event.conversationId ?? pending?.conversationId,
        localMessageId: event.localMessageId ?? pending?.localMessageId,
        startObserved: pending?.startObserved === true || event.name === 'on_message_session_start' || event.name === 'on_message_sending_start',
        updatedMs: Date.now(),
      };
    }
    this.complete(state, key, pending, entries);
  }

  private complete(state: Checkpoint, key: string, pending: PendingTurn, entries: AgentActivityEntry[]): void {
    if (pending.startObserved && pending.terminal) {
      const complete = buildDoubaoTaskEvents(this.scope, pending, pending.terminal, Date.now());
      if (complete.length === 0) return;
      entries.push(...complete);
      delete state.pending[key];
      state.completed[key] = Date.now();
    }
  }
}

function fileIdentity(stat: { dev: number; ino: number }): string { return `${stat.dev}:${stat.ino}`; }

async function boundaryAnchor(
  handle: Awaited<ReturnType<typeof fs.open>>, offset: number, runtime: InputRuntimeAccumulator | null,
): Promise<string> {
  const length = Math.min(64, offset);
  const buffer = Buffer.alloc(length);
  const started = performance.now();
  const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
  runtime?.observeRead(bytesRead, length, performance.now() - started);
  if (bytesRead !== length) throw new Error('Doubao Work cursor boundary changed during read');
  return doubaoDigest(buffer.toString('hex'));
}

function compact<T>(items: Record<string, T>, max: number, ttl: number, time: (value: T) => number): number {
  const before = Object.keys(items).length;
  const cutoff = Date.now() - ttl;
  for (const [key, value] of Object.entries(items)) if (time(value) < cutoff) delete items[key];
  const oldest = Object.keys(items).sort((a, b) => time(items[a]) - time(items[b]));
  for (const key of oldest.slice(0, Math.max(0, oldest.length - max))) delete items[key];
  return before - Object.keys(items).length;
}
