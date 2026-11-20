import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { ClientType, CollectionMethod, type AgentActivityEntry, type InputState } from '../../types/index.js';
import { resolveHome } from '../../utils/fs-utils.js';
import { fileIdentity } from '../../utils/file-identity.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { KimiCodeWireTurn } from './kimi-code-wire.js';

const READ_BUDGET = 4 * 1024 * 1024;
const MAX_SOURCES_PER_CYCLE = 8;
const MAX_DIRECTORY_ENTRIES_PER_CYCLE = 128;
const MAX_UNCOMMITTED_BYTES = 32 * 1024 * 1024;
const MAX_WAITING_SOURCES = 256;
const SESSION_STATE_LIMIT = 256 * 1024;
const ANCHOR_BYTES = 512;
const SESSION_READ_FLAGS = process.platform === 'win32' ? 'r'
  : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

interface KimiCodeCliInputOptions extends InputOptions {
  sessionDir?: string;
  captureMessageContent: boolean;
}

interface ActiveScan {
  wirePath: string;
  identity: string;
  reader: KimiCodeWireTurn;
  scanningOffset: number;
  endOffset: number;
  discardLine: boolean;
}

function defaultSessionDir(): string {
  return path.join(resolveHome(process.env.KIMI_CODE_HOME || '~/.kimi-code'), 'sessions');
}

export class KimiCodeCliInput extends BaseInput {
  readonly id = 'kimi-code-cli';
  readonly agentType = ClientType.KimiCodeCli;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly sessionDir: string;
  private readonly captureContent: boolean;
  private continuation?: { key: string; scan: ActiveScan };
  private discovery?: AsyncGenerator<string | undefined>;
  private discoveryRoot?: string;
  private readonly waitingSources = new Map<string, string>();
  private readonly staged = new Map<string, InputState>();
  private cutoff = 0;

  constructor(options: KimiCodeCliInputOptions) {
    super(options);
    this.sessionDir = options.sessionDir ?? defaultSessionDir();
    this.captureContent = options.captureMessageContent;
  }

  getWatchPaths(): string[] { return [path.dirname(this.sessionDir), this.sessionDir]; }

  async checkAvailability(): Promise<boolean> { return (await this.canonicalSessionDir()) !== undefined; }

  protected override async onStart(): Promise<void> {
    const cutoff = this.stateStore.get(this.id).extra?.firstObservedMs;
    this.cutoff = typeof cutoff === 'number' && cutoff > 0 ? cutoff : Date.now();
    if (this.cutoff !== cutoff) this.stateStore.update(this.id, { extra: { firstObservedMs: this.cutoff } });
  }

  protected override async onStop(): Promise<void> {
    this.continuation = undefined;
    this.waitingSources.clear();
    this.staged.clear();
    await this.closeDiscovery();
  }

  protected override onCollectionProcessed(): void {
    if (!this.checkpointFailed) {
      for (const [key, state] of this.staged) this.stateStore.update(key, state);
    } else {
      this.continuation = undefined;
      this.waitingSources.clear();
    }
    this.staged.clear();
  }

  private async canonicalSessionDir(): Promise<string | undefined> {
    try {
      // Honor a deliberately symlinked Kimi home, but do not follow session
      // directories escaping that configured home.
      const home = await fs.realpath(path.dirname(this.sessionDir));
      const sessions = path.join(home, path.basename(this.sessionDir));
      return (await fs.lstat(sessions)).isDirectory() ? sessions : undefined;
    } catch {
      return undefined;
    }
  }

  private async closeDiscovery(): Promise<void> {
    await this.discovery?.return(undefined).catch(() => undefined);
    this.discovery = undefined;
    this.discoveryRoot = undefined;
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    if (this.staged.size) {
      // A queue or policy exception can leave staged progress uncommitted.
      this.continuation = undefined;
      this.waitingSources.clear();
      this.staged.clear();
    }
    const entries: AgentActivityEntry[] = [];
    const root = await this.canonicalSessionDir();
    if (this.discoveryRoot !== root) {
      await this.closeDiscovery();
      this.continuation = undefined;
    }
    if (!root) return entries;

    let remaining = MAX_SOURCES_PER_CYCLE;
    if (this.continuation) {
      const { key, scan } = this.continuation;
      this.continuation = undefined;
      const session = path.resolve(path.dirname(scan.wirePath), '..', '..');
      entries.push(...await this.collectSession(session, key, scan));
      remaining--;
      // Drain one partially read turn before admitting another. A fixed
      // snapshot and turn budget release this slot even for a growing wire.
      if (this.continuation) return entries;
    }
    this.discoveryRoot = root;
    this.discovery ??= discoverSessions(root);
    for (let visited = 0; visited < MAX_DIRECTORY_ENTRIES_PER_CYCLE && remaining > 0; visited++) {
      const next = await this.discovery.next();
      if (next.done) {
        this.discovery = undefined;
        break; // Start a fresh sweep on the next poll.
      }
      if (!next.value) continue;
      const stateKey = `${this.id}:${path.basename(next.value)}`;
      entries.push(...await this.collectSession(next.value, stateKey));
      if (this.continuation) break;
      remaining--;
    }
    return entries;
  }

  private async collectSession(session: string, stateKey: string, scan?: ActiveScan): Promise<AgentActivityEntry[]> {
    const wirePath = path.join(session, 'agents', 'main', 'wire.jsonl');
    try {
      const opened = await openSessionFile(wirePath);
      if (!opened) return [];
      const { file, stat } = opened;
      try {
        return await this.collectWire(session, wirePath, file, stat, stateKey, scan) ?? [];
      } finally {
        await file.close().catch(() => undefined);
      }
    } catch (error) {
      if (this.isUnreadableError(error)) await this.diagnoseUnreadablePath(wirePath, 'event file');
      return [];
    }
  }

  private async collectWire(
    sessionDir: string, wirePath: string, wire: FileHandle, stat: Stats, stateKey: string, scan?: ActiveScan,
  ): Promise<AgentActivityEntry[] | undefined> {
    const identity = fileIdentity(stat);
    const durable = this.stateStore.get(stateKey);
    const staged = this.staged.get(stateKey);
    const state = staged ? { ...durable, ...staged, extra: { ...durable.extra, ...staged.extra } } : durable;
    const savedIdentity = state.extra?.identity;
    const savedPath = state.extra?.wirePath;
    if (savedPath && savedPath !== wirePath && savedIdentity !== identity) return undefined;
    const savedOffset = state.lastOffset;
    const previousOffset = typeof savedOffset === 'number' && Number.isSafeInteger(savedOffset) && savedOffset >= 0
      ? savedOffset : 0;
    const replaced = savedIdentity !== undefined && (savedIdentity !== identity || stat.size < previousOffset);
    const acceptedAnchor = state.extra?.anchor;
    const sameAcceptedPrefix = replaced && previousOffset > 0 && previousOffset <= stat.size
      && typeof acceptedAnchor === 'string' && await wireAnchor(wire, previousOffset) === acceptedAnchor;
    const previousFloor = state.extra?.minimumTurnTime;
    let minimumTurnTime = typeof previousFloor === 'number' ? previousFloor : this.cutoff;
    const acceptedEnd = state.extra?.acceptedEnd;
    const acceptedPrompt = typeof state.extra?.acceptedPrompt === 'string' ? state.extra.acceptedPrompt : undefined;
    if (replaced && !sameAcceptedPrefix && typeof acceptedEnd === 'number') {
      // Without a matching physical boundary, rescan from the source's last
      // completed turn timestamp. Never use the later observation wall clock.
      minimumTurnTime = Math.max(minimumTurnTime, acceptedEnd + 1);
    }
    const committed = replaced && !sameAcceptedPrefix ? 0 : previousOffset;
    if (scan && (replaced || scan.identity !== identity || scan.wirePath !== wirePath || stat.size < scan.endOffset)) {
      scan = undefined;
    }
    if (committed >= stat.size && !replaced && savedIdentity === identity) {
      if (savedPath !== wirePath) this.staged.set(stateKey, { extra: { wirePath } });
      return [];
    }
    const sourceStamp = `${identity}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${committed}`;
    if (!scan && this.waitingSources.get(stateKey) === sourceStamp) return [];
    this.waitingSources.delete(stateKey);
    if (!scan) {
      if ((replaced || !savedIdentity) && !await hasSupportedWireHeader(wire)) return undefined;
      const session = await readSessionState(sessionDir);
      if (session?.version !== 2 || session.id !== path.basename(sessionDir) || typeof session.cwd !== 'string') return undefined;
      let cutoff = minimumTurnTime;
      if (typeof session.forkedFrom === 'string') {
        // The native fork copies the source wire and preserves its turn times.
        const createdAt = session.createdAt;
        if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0) return undefined;
        cutoff = Math.max(cutoff, createdAt + 1);
      }
      scan = {
        wirePath, identity,
        reader: new KimiCodeWireTurn(session.id, session.cwd, cutoff, this.captureContent, acceptedPrompt),
        scanningOffset: committed,
        endOffset: stat.size,
        discardLine: false,
      };
    }
    const entries: AgentActivityEntry[] = [];
    const runtime = this.getInputRuntimeAccumulator();
    runtime?.observeBacklog(stat.size - committed);
    const from = scan.scanningOffset;
    const buffer = Buffer.allocUnsafe(Math.min(READ_BUDGET, scan.endOffset - from));
    const readAt = runtime?.now();
    const { bytesRead } = await wire.read(buffer, 0, buffer.length, from);
    if (readAt !== undefined) runtime?.observeRead(bytesRead, buffer.length, runtime.now() - readAt);
    let nextCommit = committed;
    let lineStart = 0;
    let countedRecords = 0;
    let parseSuccessRecords = 0;
    let maxRecordBytes = 0;
    const bytes = buffer.subarray(0, bytesRead);
    for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, lineStart)) {
      const offset = from + newline + 1;
      const line = buffer.subarray(lineStart, newline);
      lineStart = newline + 1;
      countedRecords++;
      maxRecordBytes = Math.max(maxRecordBytes, line.length + 1);
      if (scan.discardLine) {
        scan.discardLine = false;
      } else {
        const record = decodeWireLine(line);
        if (record) {
          parseSuccessRecords++;
          entries.push(...scan.reader.accept(record));
        } else {
          scan.reader.discardActiveTurn();
        }
      }
      if (offset - nextCommit >= MAX_UNCOMMITTED_BYTES) scan.reader.discardActiveTurn();
      if (!scan.reader.hasActiveTurn) nextCommit = offset;
    }
    scan.scanningOffset = from + lineStart;
    if (lineStart === 0 && bytesRead === READ_BUDGET) {
      // Quarantine oversized records in memory, then resume on the next complete line.
      // The on-disk cursor remains before the oversized record until its newline exists.
      scan.reader.discardActiveTurn();
      scan.discardLine = true;
      scan.scanningOffset = from + bytesRead;
    }
    const waitingForTurn = scan.reader.hasActiveTurn || scan.discardLine;
    if (waitingForTurn && !scan.reader.lastCompletedTurn) {
      if (from + bytesRead < scan.endOffset && scan.scanningOffset > from) {
        this.continuation = { key: stateKey, scan };
      } else if (from + bytesRead === scan.endOffset && scan.endOffset === stat.size) {
        this.waitingSources.set(stateKey, `${identity}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${nextCommit}`);
        if (this.waitingSources.size > MAX_WAITING_SOURCES) {
          const oldest = this.waitingSources.keys().next().value;
          if (oldest !== undefined) this.waitingSources.delete(oldest);
        }
      }
    }
    runtime?.observeCommittedBatch({
      bytes: lineStart, records: countedRecords, parseSuccessRecords,
      parseFailedRecords: countedRecords - parseSuccessRecords, maxRecordBytes,
    });
    if (nextCommit !== previousOffset || replaced || savedIdentity !== identity || savedPath !== wirePath) {
      const anchor = await wireAnchor(wire, nextCommit);
      const terminal = scan.reader.lastCompletedTurn;
      this.staged.set(stateKey, {
        lastOffset: nextCommit,
        extra: {
          identity, minimumTurnTime, wirePath, anchor,
          acceptedPrompt: terminal?.promptId ?? acceptedPrompt,
          acceptedEnd: terminal?.endTime ?? acceptedEnd,
        },
      });
    }
    return entries;
  }
}

async function openSessionFile(filePath: string): Promise<{ file: FileHandle; stat: Stats } | undefined> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.nlink > 1 || path.relative(filePath, await fs.realpath(filePath)) !== '') return undefined;

  const file = await fs.open(filePath, SESSION_READ_FLAGS);
  let verified = false;
  try {
    const stat = await file.stat();
    const after = await fs.lstat(filePath);
    // Check the open descriptor before reading. The before/after pathname
    // checks also cover Windows, where a no-follow open flag is unavailable.
    verified = stat.isFile() && stat.nlink <= 1 && after.isFile()
      && fileIdentity(before) === fileIdentity(stat) && fileIdentity(after) === fileIdentity(stat)
      && path.relative(filePath, await fs.realpath(filePath)) === '';
    return verified ? { file, stat } : undefined;
  } finally {
    if (!verified) await file.close();
  }
}

async function readSessionState(sessionDir: string): Promise<Record<string, unknown> | undefined> {
  const opened = await openSessionFile(path.join(sessionDir, 'state.json'));
  if (!opened) return undefined;
  const { file, stat } = opened;
  try {
    if (stat.size > SESSION_STATE_LIMIT) return undefined;
    const buffer = Buffer.allocUnsafe(stat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (bytesRead !== buffer.length || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) return undefined;
    return decodeWireLine(buffer);
  } finally {
    await file.close();
  }
}

async function wireAnchor(wire: FileHandle, offset: number): Promise<string | undefined> {
  if (offset <= 0) return undefined;
  const window = Buffer.allocUnsafe(Math.min(ANCHOR_BYTES, offset));
  const { bytesRead } = await wire.read(window, 0, window.length, offset - window.length);
  return bytesRead === window.length ? createHash('sha256').update(window).digest('hex') : undefined;
}

async function hasSupportedWireHeader(wire: FileHandle): Promise<boolean> {
  const header = Buffer.allocUnsafe(1024);
  const { bytesRead } = await wire.read(header, 0, header.length, 0);
  const newline = header.subarray(0, bytesRead).indexOf(10);
  if (newline < 0) return false;
  const record = decodeWireLine(header.subarray(0, newline));
  return record?.type === 'metadata' && record.protocol_version === '1.5' && record.min_protocol_version === '1.5';
}

function decodeWireLine(line: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    // Node's JSON parse exception may quote raw prompt or tool text.
    return undefined;
  }
}

async function* discoverSessions(root: string): AsyncGenerator<string | undefined> {
  try {
    for await (const workspace of await fs.opendir(root)) {
      yield undefined; // Bound directory work even if there are no sessions.
      if (!workspace.isDirectory()) continue;
      const directory = path.join(root, workspace.name);
      try {
        if (path.relative(directory, await fs.realpath(directory)) !== '') continue;
        for await (const session of await fs.opendir(directory)) {
          yield session.isDirectory() ? path.join(directory, session.name) : undefined;
        }
      } catch {
        // One missing workspace must not hide others or delete saved state.
      }
    }
  } catch {
    // A missing or unreadable root will be retried on the next sweep.
  }
}
