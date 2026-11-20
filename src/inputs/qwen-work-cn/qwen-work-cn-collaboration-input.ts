import * as fs from 'node:fs/promises';
import { constants, type Dir } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import type { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../types/index.js';
import { collaborationTurns } from './qwen-work-cn-collaboration-parser.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_READS_PER_CYCLE = 2;
const MAX_SCAN_STEPS = 128;
const MAX_TURNS_PER_CYCLE = 100;
const MAX_COMPLETED = 50_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHED_FILES = 256;

interface Checkpoint {
  version: 1;
  sinceMs: number;
  completed: Record<string, number>;
}

interface FileStamp { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface Pending { checkpoint: Checkpoint; previous: Checkpoint; cache: Array<[string, FileStamp]> }

export function resolveQwenWorkCNCollaborationRoot(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const userData = platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA || paths.join(home, 'AppData', 'Roaming'))
    : (env.XDG_CONFIG_HOME || paths.join(home, '.config'));
  return paths.join(userData, 'QwenWorkCN', 'data', 'collaboration');
}

/** Poll the app's atomic IM state snapshots without modifying the app or its SDK. */
export class QwenWorkCNCollaborationInput extends BaseInput {
  readonly id = 'qwen-work-cn-collaboration';
  readonly agentType = ClientType.QwenWorkCN;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;
  private readonly root: string;
  private readonly includedConversations: ReadonlySet<string> | undefined;
  private scan: AsyncGenerator<string | undefined | false> | undefined;
  private readonly cache = new Map<string, FileStamp>();
  private pending: Pending | undefined;
  private queuedPrevious: Checkpoint | undefined;
  private readonly warnings = new Set<string>();
  private lastCompleted: Record<string, number> | undefined;
  private lastCompletedCount = 0;
  private nextPruneAt = 0;

  constructor(opts: InputOptions & { root?: string; includeConversationIds?: string[] }) {
    super(opts);
    this.root = opts.root ?? resolveQwenWorkCNCollaborationRoot();
    this.includedConversations = opts.includeConversationIds === undefined
      ? undefined : new Set(opts.includeConversationIds);
  }

  static getWatchPaths(): string[] {
    return [path.dirname(resolveQwenWorkCNCollaborationRoot())];
  }

  static async checkAvailability(): Promise<boolean> {
    try { return (await fs.stat(resolveQwenWorkCNCollaborationRoot())).isDirectory(); } catch { return false; }
  }

  protected override async onStart(): Promise<void> {
    const saved = this.getState().extra?.collaboration;
    if (saved === undefined) {
      // Do not replay all historical workspace messages on first installation.
      this.setState({ extra: { collaboration: { version: 1, sinceMs: Date.now(), completed: {} } } });
    }
  }

  protected override async onStop(): Promise<void> {
    await this.scan?.return(undefined);
    this.scan = undefined;
    this.pending = undefined;
    this.cache.clear();
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const saved = readCheckpoint(this.getState().extra?.collaboration);
    if (!saved) {
      this.warnOnce('checkpoint', 'unsupported collaboration checkpoint; preserving source progress');
      return [];
    }
    const now = Date.now();
    const cutoff = Math.max(saved.sinceMs, now - RETENTION_MS);
    if (saved.completed !== this.lastCompleted) {
      const values = Object.values(saved.completed);
      if (values.some(time => typeof time !== 'number' || !Number.isFinite(time))) {
        this.warnOnce('checkpoint', 'unsupported collaboration checkpoint; preserving source progress');
        return [];
      }
      this.lastCompleted = saved.completed;
      this.lastCompletedCount = values.length;
    }
    let completed = saved.completed;
    let completedCount = this.lastCompletedCount;
    let pruned = false;
    if (now >= this.nextPruneAt || completedCount >= MAX_COMPLETED) {
      const kept = Object.fromEntries(Object.entries(completed).filter(([, time]) => time >= cutoff));
      const count = Object.keys(kept).length;
      if (count !== completedCount) { completed = kept; completedCount = count; pruned = true; }
      this.nextPruneAt = now + 60 * 60 * 1000;
    }
    let copied = pruned;
    // Once old identities are discarded, do not move the lower bound back if
    // the host clock is later corrected backwards.
    const checkpoint: Checkpoint = { ...saved, sinceMs: pruned ? cutoff : saved.sinceMs, completed };
    const cache: Array<[string, FileStamp]> = [];
    const entries: AgentActivityEntry[] = [];
    let reads = 0;
    this.scan ??= discoverStateFiles(this.root);
    try {
      for (let step = 0; step < MAX_SCAN_STEPS && reads < MAX_READS_PER_CYCLE; step++) {
        const result = await this.scan.next();
        if (result.done) { this.scan = undefined; break; }
        const file = result.value;
        if (file === false) { this.warnOnce('scan', 'part of the collaboration directory is unreadable; will retry'); continue; }
        if (!file) continue;
        let before: FileStamp | undefined;
        try { before = await regularStamp(file); } catch {
          this.warnOnce('read', 'collaboration state could not be read consistently; will retry');
          continue;
        }
        if (!before) continue;
        if (before.size > MAX_FILE_BYTES) {
          this.warnOnce('file-size', 'collaboration state exceeds the 16 MiB read limit; retaining source progress');
          continue;
        }
        if (sameStamp(this.cache.get(file), before)) continue;
        reads++;
        let snapshot: unknown;
        try {
          snapshot = await readStableJson(file, before, this.getInputRuntimeAccumulator());
        } catch {
          // Atomic replacement, corruption and transient permission errors all retry.
          this.warnOnce('read', 'collaboration state could not be read consistently; will retry');
          continue;
        }
        let complete = true;
        const firstEntry = entries.length;
        const addedKeys: string[] = [];
        try {
          for (const turn of collaborationTurns(snapshot, this.includedConversations)) {
            if (turn.completedAtMs < cutoff || completed[turn.key] !== undefined) continue;
            if (entries.length / 2 >= MAX_TURNS_PER_CYCLE || completedCount >= MAX_COMPLETED) {
              complete = false;
              this.warnOnce('capacity', 'collaboration collection is backlogged or its checkpoint is full; will retry');
              break;
            }
            if (!copied) { completed = { ...completed }; checkpoint.completed = completed; copied = true; }
            completed[turn.key] = turn.completedAtMs;
            addedKeys.push(turn.key);
            completedCount++;
            entries.push(...turn.entries);
          }
        } catch {
          for (const key of addedKeys) delete completed[key];
          completedCount -= addedKeys.length;
          entries.length = firstEntry;
          this.getInputRuntimeAccumulator()?.observeCommittedBatch({ bytes: before.size, records: 1,
            parseSuccessRecords: 0, parseFailedRecords: 1, maxRecordBytes: before.size });
          this.warnOnce('format', 'unsupported collaboration state format; will retry');
          continue;
        }
        this.getInputRuntimeAccumulator()?.observeCommittedBatch({ bytes: before.size, records: 1,
          parseSuccessRecords: 1, parseFailedRecords: 0, maxRecordBytes: before.size });
        if (complete) cache.push([file, before]);
      }
    } catch {
      this.warnOnce('scan', 'collaboration directory scan failed; will retry');
      await this.scan?.return(undefined).catch(() => undefined);
      this.scan = undefined;
    }

    if (entries.length) {
      // InputManager installs the output hold synchronously on emit; the
      // checkpoint is changed only in onEntriesQueued after that hold exists.
      this.pending = { checkpoint, previous: saved, cache };
    } else {
      if (pruned) {
        this.setState({ extra: { collaboration: checkpoint } });
      }
      this.remember(cache);
    }
    return entries;
  }

  protected override onEntriesQueued(): void {
    if (!this.pending) return;
    this.queuedPrevious = this.pending.previous;
    this.setState({ extra: { collaboration: this.pending.checkpoint } });
    this.remember(this.pending.cache);
    this.pending = undefined;
  }

  /** Restore the pre-delivery cursor when the manager cancels a retry on stop. */
  restoreAbortedDelivery(): void {
    const previous = this.queuedPrevious ?? this.pending?.previous;
    if (previous) this.setState({ extra: { collaboration: previous } });
    this.queuedPrevious = undefined;
    this.pending = undefined;
    this.cache.clear();
  }

  private remember(entries: Array<[string, FileStamp]>): void {
    for (const [file, stamp] of entries) {
      this.cache.delete(file);
      this.cache.set(file, stamp);
      if (this.cache.size > MAX_CACHED_FILES) this.cache.delete(this.cache.keys().next().value!);
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warnings.has(key)) return;
    this.warnings.add(key);
    this.logger.warn(message);
  }
}

async function* discoverStateFiles(root: string): AsyncGenerator<string | undefined | false> {
  let environments: Dir;
  try { environments = await fs.opendir(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for await (const environment of environments) {
    yield undefined;
    if (!environment.isDirectory()) continue;
    const environmentPath = path.join(root, environment.name);
    let accounts: Dir;
    try { accounts = await fs.opendir(environmentPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      yield false;
      continue;
    }
    for await (const account of accounts) {
      yield undefined;
      if (!account.isDirectory()) continue;
      const directory = path.join(environmentPath, account.name);
      const channelDirectory = path.join(directory, 'channel-v1');
      try {
        if ((await fs.lstat(channelDirectory)).isDirectory()) yield path.join(channelDirectory, 'state.json');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') yield false;
      }
      yield path.join(directory, 'state.json'); // SDK's pre-channel legacy location.
    }
  }
}

async function regularStamp(file: string): Promise<FileStamp | undefined> {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() ? stamp(stat) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readStableJson(file: string, expected: FileStamp, runtime: InputRuntimeAccumulator | null): Promise<unknown> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameStamp(stamp(await handle.stat()), expected)) throw new Error('source changed');
    const buffer = Buffer.alloc(expected.size);
    let offset = 0;
    while (offset < buffer.length) {
      const started = runtime?.now() ?? 0;
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      runtime?.observeRead(bytesRead, buffer.length - offset, runtime.now() - started);
      if (!bytesRead) throw new Error('short read');
      offset += bytesRead;
    }
    if (!sameStamp(stamp(await handle.stat()), expected)
      || !sameStamp(await regularStamp(file), expected)) throw new Error('source changed');
    return JSON.parse(buffer.toString('utf8'));
  } finally { await handle.close(); }
}

function stamp(value: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): FileStamp {
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs);
}

function readCheckpoint(value: unknown): Checkpoint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const checkpoint = value as Partial<Checkpoint>;
  if (checkpoint.version !== 1 || !Number.isFinite(checkpoint.sinceMs)
    || !checkpoint.completed || typeof checkpoint.completed !== 'object' || Array.isArray(checkpoint.completed)) return undefined;
  return checkpoint as Checkpoint;
}
