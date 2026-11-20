import { createHash } from 'node:crypto';
import { constants, watch, type Dirent, type FSWatcher, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../types/index.js';
import { fileIdentity } from '../../utils/file-identity.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { buildMinimaxCodeTurn } from './minimax-code-events.js';
import {
  parseMinimaxCodeHookObservation, parseMinimaxCodeSessionManifest, parseMinimaxCodeSessionMessage,
  type MinimaxCodeHookObservation, type MinimaxCodeSessionMessage,
} from './minimax-code-session-source.js';

const RETRY_MS = 1_000;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const SESSION_SHARD = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];

interface Options extends InputOptions {
  profileDir: string;
  hookDir: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function snapshot(stat: Stats): string {
  return `${fileIdentity(stat)}:${stat.size}:${stat.mtimeMs}`;
}

async function children(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Only complete turns announced by the installed local plugin are collected. */
export class MinimaxCodeSessionInput extends BaseInput {
  readonly id = 'minimax-code-session';
  readonly agentType = ClientType.MiniMaxCode;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly sessionsDir: string;
  private readonly hookDir: string;
  private readonly pendingSnapshots = new Map<string, string>();
  private pendingTurnKeys: string[] = [];
  private watcher?: FSWatcher;
  private retry?: ReturnType<typeof setTimeout>;

  constructor(opts: Options) {
    super(opts);
    this.sessionsDir = path.join(opts.profileDir, 'v2', 'sessions');
    this.hookDir = opts.hookDir;
  }

  protected override async onStart(): Promise<void> {
    await fs.mkdir(this.hookDir, { recursive: true, mode: 0o700 });
    try {
      this.watcher = watch(this.hookDir, { recursive: true }, () => this.requestCollection());
      this.watcher.on('error', () => this.watcher?.close());
    } catch {
      // The periodic poll also discovers observations when watch is unavailable.
    }
  }

  protected override async onStop(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.pendingSnapshots.clear();
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    this.pendingTurnKeys = [];
    const bySession = await this.readObservations();
    const sessions = await this.findSessions(new Set(bySession.keys()));
    const activeSources = new Set(sessions.values());
    for (const source of this.pendingSnapshots.keys()) {
      if (!activeSources.has(source)) this.pendingSnapshots.delete(source);
    }
    const entries: AgentActivityEntry[] = [];
    for (const [sessionId, observations] of bySession) {
      const source = sessions.get(sessionId);
      if (!source) continue;
      const turns = new Set(observations.filter(item => item.event === 'Stop').map(item => item.turnId!));
      try {
        const rows = await this.readStableMessages(source, turns);
        if (!rows) continue;
        for (const turnId of turns) {
          const built = buildMinimaxCodeTurn(sessionId, turnId, rows, observations);
          if (!built.length) continue;
          const key = this.turnStateKey(sessionId, turnId);
          const allowed = this.workspacePolicy.filter(built, this.agentType);
          if (!allowed.length) {
            // The whole turn belongs to one workspace. Policy-excluded
            // observations are terminal without sending any content.
            this.completeTurn(key);
            continue;
          }
          entries.push(...allowed);
          this.pendingTurnKeys.push(key);
        }
      } catch (error) {
        // I/O failure leaves both the checkpoint and observations intact.
        const code = (error as NodeJS.ErrnoException).code;
        this.logger.debug('MiniMax Code native session unavailable', { code: code ?? 'invalid-source' });
      }
    }
    return entries;
  }

  protected override onEntriesQueued(): void {
    // InputManager establishes the output hold synchronously when enqueuing.
    for (const key of this.pendingTurnKeys) this.completeTurn(key);
    this.pendingTurnKeys = [];
  }

  private completeTurn(key: string): void {
    this.stateStore.set(key, { extra: { completed: true } });
  }

  private async readObservations(): Promise<Map<string, MinimaxCodeHookObservation[]>> {
    const bySession = new Map<string, MinimaxCodeHookObservation[]>();
    for (const dir of await children(this.hookDir)) {
      if (!dir.isDirectory() || !/^[a-f0-9]{64}$/.test(dir.name)) continue;
      const sessionPath = path.join(this.hookDir, dir.name);
      for (const entry of await children(sessionPath)) {
        if (!entry.isFile() || !/^\d+-[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
        const file = path.join(sessionPath, entry.name);
        try {
          const handle = await fs.open(file, OPEN_FLAGS);
          let raw: { payload?: unknown; observedAtMs?: unknown };
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 16 * 1024) continue;
            raw = JSON.parse(await handle.readFile('utf8')) as typeof raw;
          } finally {
            await handle.close();
          }
          const observation = parseMinimaxCodeHookObservation(raw.payload, raw.observedAtMs);
          if (!observation?.turnId || hash(observation.sessionId) !== dir.name) continue;
          const key = this.turnStateKey(observation.sessionId, observation.turnId);
          if (this.stateStore.getPersistedState(key)?.extra?.completed === true) {
            await fs.unlink(file);
            continue;
          }
          const queued = bySession.get(observation.sessionId) ?? [];
          const matching = queued.some(known => known.turnId === observation.turnId
            && known.event === observation.event && known.toolCallId === observation.toolCallId
            && known.observedAtMs === observation.observedAtMs && known.workspace === observation.workspace);
          if (!matching) queued.push(observation);
          bySession.set(observation.sessionId, queued);
        } catch {
          // A file can change between discovery and read. Never consume it on failure.
        }
      }
    }
    for (const [sessionId, observations] of bySession) {
      if (!observations.some(observation => observation.event === 'Stop')) bySession.delete(sessionId);
    }
    return bySession;
  }

  private async findSessions(pending: ReadonlySet<string>): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!pending.size) return result;
    const ambiguous = new Set<string>();
    const suffixes = [...pending].map(sessionId => `-session_${Buffer.from(sessionId).toString('base64url')}`);
    const walk = async (dir: string, depth: number): Promise<void> => {
      const pattern = SESSION_SHARD[depth];
      for (const entry of await children(dir)) {
        if (!entry.isDirectory()) continue;
        const folder = path.join(dir, entry.name);
        if (pattern) {
          if (pattern.test(entry.name)) await walk(folder, depth + 1);
          continue;
        }
        if (!suffixes.some(suffix => entry.name.endsWith(suffix))) continue;
        try {
          const manifest = await fs.open(path.join(folder, 'manifest.json'), OPEN_FLAGS);
          let data: unknown;
          try {
            const stat = await manifest.stat();
            if (!stat.isFile() || stat.size > 64 * 1024) continue;
            data = JSON.parse(await manifest.readFile('utf8'));
          } finally {
            await manifest.close();
          }
          const session = parseMinimaxCodeSessionManifest(data);
          if (session && pending.has(session.sessionId) && !ambiguous.has(session.sessionId)) {
            if (result.has(session.sessionId)) {
              result.delete(session.sessionId);
              ambiguous.add(session.sessionId);
            } else {
              result.set(session.sessionId, path.join(folder, 'messages.jsonl'));
            }
          }
        } catch {
          // A just-created session can exist before its manifest is readable.
        }
      }
    };
    await walk(this.sessionsDir, 0);
    return result;
  }

  private async readStableMessages(file: string, turns: ReadonlySet<string>): Promise<MinimaxCodeSessionMessage[] | undefined> {
    const fh = await fs.open(file, OPEN_FLAGS);
    try {
      const initial = await fh.stat();
      if (!initial.isFile() || initial.size === 0) return undefined;
      const initialSnapshot = snapshot(initial);
      const previous = this.pendingSnapshots.get(file);
      this.pendingSnapshots.set(file, initialSnapshot);
      if (previous !== initialSnapshot) {
        if (!this.retry && this.running) {
          this.retry = setTimeout(() => {
            this.retry = undefined;
            this.requestCollection();
          }, RETRY_MS);
        }
        return undefined;
      }
      const lastByte = Buffer.alloc(1);
      const { bytesRead } = await fh.read(lastByte, 0, 1, initial.size - 1);
      if (bytesRead !== 1 || lastByte[0] !== 10) return undefined;
      const stream = fh.createReadStream({ start: 0, end: initial.size - 1, encoding: 'utf8', autoClose: false });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      const rows = new Map<string, MinimaxCodeSessionMessage>();
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          const row = parseMinimaxCodeSessionMessage(JSON.parse(line));
          if (row && turns.has(row.turnId)) rows.set(row.messageId, row);
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      const latest = await fs.lstat(file);
      if (!latest.isFile() || snapshot(latest) !== initialSnapshot) return undefined;
      return [...rows.values()];
    } finally {
      await fh.close();
    }
  }

  private turnStateKey(sessionId: string, turnId: string): string {
    return `${this.id}:${hash(JSON.stringify([sessionId, turnId]))}`;
  }
}
