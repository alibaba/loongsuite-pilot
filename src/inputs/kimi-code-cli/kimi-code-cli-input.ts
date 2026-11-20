import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../types/index.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { fileIdentity } from '../../utils/file-identity.js';
import { producerReadFlags } from '../../utils/producer-log-dir.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { KimiCodeWireTurn } from './kimi-code-wire.js';

const READ_BUDGET = 4 * 1024 * 1024;
const ACTIVE_FILES_LIMIT = 64;

interface KimiCodeCliInputOptions extends InputOptions {
  sessionDir?: string;
  captureMessageContent: boolean;
}

interface ActiveScan {
  identity: string;
  reader: KimiCodeWireTurn;
  scanningOffset: number;
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
  private readonly activeScans = new Map<string, ActiveScan>();
  private cutoff = 0;

  constructor(options: KimiCodeCliInputOptions) {
    super(options);
    this.sessionDir = options.sessionDir ?? defaultSessionDir();
    this.captureContent = options.captureMessageContent;
  }

  getWatchPaths(): string[] { return [path.dirname(this.sessionDir), this.sessionDir]; }

  async checkAvailability(): Promise<boolean> { return directoryExists(this.sessionDir); }

  protected override async onStart(): Promise<void> {
    const cutoff = this.stateStore.get(this.id).extra?.firstObservedMs;
    this.cutoff = typeof cutoff === 'number' && cutoff > 0 ? cutoff : Date.now();
    if (this.cutoff !== cutoff) this.stateStore.update(this.id, { extra: { firstObservedMs: this.cutoff } });
  }

  protected override async onStop(): Promise<void> { this.activeScans.clear(); }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const entries: AgentActivityEntry[] = [];
    for (const workspace of await childDirectories(this.sessionDir)) {
      for (const session of await childDirectories(workspace)) {
        const wirePath = path.join(session, 'agents', 'main', 'wire.jsonl');
        try {
          const wire = await fs.open(wirePath, producerReadFlags());
          try {
            entries.push(...await this.collectWire(session, wirePath, wire));
          } finally {
            await wire.close();
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EACCES' || code === 'EPERM') await this.diagnoseUnreadablePath(wirePath, 'event file');
        }
      }
    }
    return entries;
  }

  private async collectWire(sessionDir: string, wirePath: string, wire: FileHandle): Promise<AgentActivityEntry[]> {
    const stat = await wire.stat();
    if (!stat.isFile()) return [];
    const identity = fileIdentity(stat);
    const stateKey = `${this.id}:${wirePath}`;
    const state = this.stateStore.get(stateKey);
    const savedOffset = state.lastOffset;
    const previousOffset = typeof savedOffset === 'number' && Number.isSafeInteger(savedOffset) && savedOffset >= 0
      ? savedOffset : 0;
    const replaced = state.extra?.identity !== undefined
      && (state.extra.identity !== identity || stat.size < previousOffset);
    const previousFloor = state.extra?.minimumTurnTime;
    const minimumTurnTime = replaced ? Date.now() : typeof previousFloor === 'number' ? previousFloor : this.cutoff;
    const committed = replaced ? 0 : previousOffset;
    let scan = this.activeScans.get(wirePath);
    if (replaced || scan?.identity !== identity || (scan && stat.size < scan.scanningOffset)) scan = undefined;
    if (committed >= stat.size && !replaced) return [];
    if (!scan) {
      if ((replaced || !state.extra?.identity) && !await hasSupportedWireHeader(wire)) return [];
      const session = JSON.parse(await fs.readFile(path.join(sessionDir, 'state.json'), 'utf8')) as Record<string, unknown>;
      if (session.version !== 2 || session.id !== path.basename(sessionDir) || typeof session.cwd !== 'string') return [];
      scan = {
        identity,
        reader: new KimiCodeWireTurn(session.id, session.cwd, minimumTurnTime, this.captureContent),
        scanningOffset: committed,
        discardLine: false,
      };
    }
    const entries: AgentActivityEntry[] = [];
    const runtime = this.getInputRuntimeAccumulator();
    runtime?.observeBacklog(stat.size - committed);
    const from = scan.scanningOffset;
    const buffer = Buffer.allocUnsafe(Math.min(READ_BUDGET, stat.size - from));
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
    this.activeScans.delete(wirePath);
    if (scan.reader.hasActiveTurn || scan.discardLine) {
      if (this.activeScans.size >= ACTIVE_FILES_LIMIT) {
        const oldest = this.activeScans.keys().next().value;
        if (oldest !== undefined) this.activeScans.delete(oldest);
      }
      this.activeScans.set(wirePath, scan);
    }
    runtime?.observeCommittedBatch({
      bytes: lineStart, records: countedRecords, parseSuccessRecords,
      parseFailedRecords: countedRecords - parseSuccessRecords, maxRecordBytes,
    });
    if (nextCommit !== previousOffset || replaced || state.extra?.identity !== identity) {
      this.stateStore.update(stateKey, {
        lastOffset: nextCommit,
        extra: { identity, minimumTurnTime },
      });
    }
    return entries;
  }
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

async function childDirectories(dir: string): Promise<string[]> {
  try {
    const children = await fs.readdir(dir, { withFileTypes: true });
    return children.filter(child => child.isDirectory()).map(child => path.join(dir, child.name));
  } catch {
    // A missing or unreadable directory never deletes the saved cursor.
    return [];
  }
}
