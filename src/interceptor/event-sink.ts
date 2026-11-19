import type { AgentActivityEntry } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('InterceptorEventSink');
type EntryKind = 'blockedPrompt' | 'evaluation';
export type InterceptorEntryConsumer = (entry: AgentActivityEntry, signal: AbortSignal) => void | Promise<void>;

interface PendingEntry { kind: EntryKind; entry: AgentActivityEntry; bytes: number }
interface SinkOptions {
  capacity?: number;
  maxBytes?: number;
  drainTimeoutMs?: number;
  warn?: (message: string, metadata: Record<string, unknown>) => void;
}

/** Finite collector-side admission with exactly one async consumer in flight. */
export class InterceptorEventSink {
  private readonly queue: PendingEntry[] = [];
  private queuedBytes = 0;
  private active = 0;
  private completed = 0;
  private dropped = 0;
  private unreportedDrops = 0;
  private reportTimer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  private abandoned = false;
  private readonly abort = new AbortController();
  private readonly capacity: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly warn: NonNullable<SinkOptions['warn']>;

  constructor(private readonly consumers: Partial<Record<EntryKind, InterceptorEntryConsumer>>, options: SinkOptions = {}) {
    this.capacity = options.capacity ?? 256;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.timeoutMs = options.drainTimeoutMs ?? 5000;
    this.warn = options.warn ?? ((message, metadata) => logger.warn(message, metadata));
  }

  get stats() {
    return { pending: this.queue.length, queuedBytes: this.queuedBytes, active: this.active,
      completed: this.completed, dropped: this.dropped };
  }

  /** ACK may follow admission, including explicit counted drops; never unbounded async work. */
  enqueue(blockedPrompts: readonly AgentActivityEntry[], evaluations: readonly AgentActivityEntry[]): void {
    for (const [kind, entries] of [['blockedPrompt', blockedPrompts], ['evaluation', evaluations]] as const) {
      for (const entry of entries) {
        if (!this.consumers[kind]) continue;
        let bytes = 0;
        try { bytes = Buffer.byteLength(JSON.stringify(entry)); } catch { /* Treat unserializable metadata as a drop. */ }
        if (this.closed || !bytes || this.queue.length >= this.capacity || this.queuedBytes + bytes > this.maxBytes) {
          this.dropped++;
          this.unreportedDrops++;
          this.scheduleReport();
          continue;
        }
        this.queue.push({ kind, entry, bytes });
        this.queuedBytes += bytes;
      }
    }
    if (!this.draining && this.queue.length) {
      this.draining = Promise.resolve().then(() => this.drain()).finally(() => {
        this.draining = null;
        if (!this.abandoned && this.queue.length) this.enqueue([], []);
      });
    }
  }

  /** Explicit output flush; the verdict mirror barrier only covers IPC/admission. */
  async flush(): Promise<void> {
    if (!this.draining) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const untilEmpty = async () => { while (this.draining) await this.draining; };
      await Promise.race([untilEmpty(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('interceptor event sink drain timed out')), this.timeoutMs);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      try { await this.flush(); }
      catch {
        const unfinished = this.queue.length + this.active;
        this.abandoned = true;
        this.abort.abort(new Error('interceptor event sink stopping'));
        this.dropped += this.queue.length;
        this.queue.length = 0;
        this.queuedBytes = 0;
        this.warn('interceptor event sink shutdown left unfinished events', { unfinished, ...this.stats });
      }
      if (this.reportTimer) clearTimeout(this.reportTimer);
      this.reportTimer = null;
      this.reportDrops();
    })();
    return this.closing;
  }

  private async drain(): Promise<void> {
    while (!this.abandoned && this.queue.length) {
      const item = this.queue.shift()!;
      this.queuedBytes -= item.bytes;
      this.active = 1;
      try {
        await this.consumers[item.kind]?.(item.entry, this.abort.signal);
        this.completed++;
      } catch (error) {
        this.warn('interceptor event sink delivery failed', { eventId: item.entry['event.id'], error: String(error) });
      } finally { this.active = 0; }
    }
  }

  private scheduleReport(): void {
    if (this.reportTimer) return;
    this.reportTimer = setTimeout(() => { this.reportTimer = null; this.reportDrops(); }, 1000);
    this.reportTimer.unref();
  }

  private reportDrops(): void {
    if (!this.unreportedDrops) return;
    this.warn('interceptor event sink admission dropped events', { ...this.stats, droppedSinceLastReport: this.unreportedDrops });
    this.unreportedDrops = 0;
  }
}
