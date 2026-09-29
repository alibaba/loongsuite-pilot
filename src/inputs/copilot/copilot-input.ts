import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { resolveCopilotHome } from '../../deployment/env-agent-dirs.js';
import { resolveHome } from '../../utils/fs-utils.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { buildCopilotEvents, collectSessionCost, collectUsageTotals } from './copilot-event-builder.js';
import { readEventsFrom, readSessionHead } from './copilot-event-reader.js';
import type { CopilotEvent, CopilotSessionCost, CopilotUsageTotals, ReadEventsResult } from './copilot-types.js';

const SESSIONS_KEY = 'copilotSessions';
const INITIALIZED_KEY = 'copilotInitialized';
const DEFAULT_DEAD_GRACE_MS = 30 * 60 * 1_000;
const MAX_EMITTED_IDS = 4_096;

interface SessionCheckpoint {
  /** Start of the latest open interaction (or end of consumed data). */
  offset: number;
  /** event.ids already emitted for the span starting at `offset`. */
  emitted: string[];
  closed: boolean;
  lastGrowthMs: number;
  size: number;
  /** Cumulative per-model usage already reported (numbers only). */
  usage: Record<string, CopilotUsageTotals>;
  /** Session-wide cost already reported (numbers only). */
  cost: CopilotSessionCost;
}

interface SessionResult {
  checkpoint: SessionCheckpoint;
  entries: AgentActivityEntry[];
}

export interface CopilotInputOptions extends InputOptions {
  copilotRoot?: string;
  wakeupDir?: string;
  deadSessionGraceMs?: number;
}

/** Copilot's config dir: `COPILOT_HOME` when set (the SDK relocates session-state with it), else ~/.copilot. */
const defaultRoot = () => resolveHome(resolveCopilotHome());

export class CopilotInput extends BaseInput {
  readonly id = 'copilot';
  readonly agentType = ClientType.Copilot;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly root: string;
  private readonly wakeupDir: string;
  private readonly deadGraceMs: number;
  private watcher: fsSync.FSWatcher | null = null;

  constructor(opts: CopilotInputOptions) {
    super(opts);
    this.root = opts.copilotRoot ?? defaultRoot();
    this.wakeupDir = opts.wakeupDir
      ?? path.join(homedir(), '.loongsuite-pilot', 'state', 'copilot', 'wakeups');
    this.deadGraceMs = opts.deadSessionGraceMs ?? DEFAULT_DEAD_GRACE_MS;
  }

  static getWatchPaths(root = defaultRoot()): string[] {
    return [root, path.join(root, 'session-state')];
  }

  static async checkAvailability(root = defaultRoot()): Promise<boolean> {
    try {
      return (await fs.stat(root)).isDirectory();
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    try {
      await fs.mkdir(this.wakeupDir, { recursive: true });
      const watcher = fsSync.watch(this.wakeupDir, () => this.requestCollection());
      // A watcher error (for example EPERM when the directory disappears on Windows)
      // must degrade to polling, never take the collector process down.
      watcher.on('error', err => this.logger.debug('wakeup watcher error; polling only', { error: String(err) }));
      this.watcher = watcher;
    } catch (err) {
      this.logger.warn('wakeup watch unavailable; polling only', { error: String(err) });
    }
  }

  protected override async onStop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    await this.clearWakeups();
    const sessionsDir = path.join(this.root, 'session-state');
    const ids = await this.listSessions(sessionsDir);
    const state = this.getState();
    const initialized = state.extra?.[INITIALIZED_KEY] === true;
    const previous = normalizeCheckpoints(state.extra?.[SESSIONS_KEY]);
    const next: Record<string, SessionCheckpoint> = {};
    const entries: AgentActivityEntry[] = [];

    for (const id of ids) {
      const file = path.join(sessionsDir, id, 'events.jsonl');
      const checkpoint = previous[id] ?? (initialized ? freshCheckpoint() : await this.baseline(file));
      const result = await this.collectSession(id, file, checkpoint);
      next[id] = result.checkpoint;
      entries.push(...result.entries);
    }
    this.setState({ extra: { [INITIALIZED_KEY]: true, [SESSIONS_KEY]: next } });
    return entries;
  }

  private async listSessions(sessionsDir: string): Promise<string[]> {
    try {
      const dirents = await fs.readdir(sessionsDir, { withFileTypes: true });
      return dirents.filter(d => d.isDirectory()).map(d => d.name).sort();
    } catch (err) {
      if (this.isUnreadableError(err)) await this.diagnoseUnreadablePath(sessionsDir, 'session directory');
      return [];
    }
  }

  /** History that predates the first run is never replayed: start at the current end of file. */
  private async baseline(file: string): Promise<SessionCheckpoint> {
    try {
      const { size } = await fs.stat(file);
      return { ...freshCheckpoint(), offset: size, size };
    } catch {
      return freshCheckpoint();
    }
  }

  /** Consume wakeups without removing the directory: the watcher is attached to it. */
  private async clearWakeups(): Promise<void> {
    try {
      await fs.mkdir(this.wakeupDir, { recursive: true });
      const names = await fs.readdir(this.wakeupDir);
      await Promise.all(names.map(name => fs.rm(path.join(this.wakeupDir, name), { force: true })));
    } catch (err) {
      this.logger.debug('wakeup cleanup failed', { error: String(err) });
    }
  }

  private async collectSession(
    id: string,
    file: string,
    checkpoint: SessionCheckpoint,
  ): Promise<SessionResult> {
    try {
      const { size } = await fs.stat(file);
      if (checkpoint.closed && size <= checkpoint.size) return { checkpoint, entries: [] };
      // Growth after a shutdown (Copilot resumes the same transcript) or after a
      // "dead" close means the session is alive again.
      const current = checkpoint.closed
        ? { ...checkpoint, closed: false, lastGrowthMs: Date.now() }
        : checkpoint;
      // A file smaller than what was already consumed was truncated or replaced.
      const base = size < current.size ? freshCheckpoint() : current;
      const now = Date.now();
      // Growth is judged on file size: the open interaction is re-read from its start,
      // so "no new events" would never be observable from the read itself.
      if (size === base.size) {
        return { checkpoint: await this.idleCheckpoint(id, file, base, now), entries: [] };
      }
      const read = await readEventsFrom(file, base.offset);
      if (read.truncated) return { checkpoint: freshCheckpoint(), entries: [] };
      if (read.events.length === 0) {
        // Only a partial trailing line so far: the writer is active, nothing to emit yet.
        return { checkpoint: { ...base, size, lastGrowthMs: now }, entries: [] };
      }
      return await this.buildSession(id, file, base, read, size, now);
    } catch (err) {
      // A session directory can exist before Copilot writes its first event.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { checkpoint, entries: [] };
      if (this.isUnreadableError(err)) await this.diagnoseUnreadablePath(file, 'event file');
      this.logger.warn('session read failed', { session: id, error: String(err) });
      return { checkpoint, entries: [] };
    }
  }

  private async buildSession(
    id: string,
    file: string,
    base: SessionCheckpoint,
    read: ReadEventsResult,
    fileSize: number,
    now: number,
  ): Promise<SessionResult> {
    const opts = { sessionId: id, priorUsage: base.usage, priorCost: base.cost, ...(await readSessionHead(file)) };
    const split = lastUserIndex(read.events);
    const tailStartsInteraction = read.events[split]?.type === 'user.message';
    const tailStart = tailStartsInteraction ? split : 0;
    // One pass over the whole span keeps the usage bookkeeping consistent; per-interaction
    // state resets at every user.message. The tail alone provides the ids to remember.
    const tailEntries = buildCopilotEvents(read.events.slice(tailStart), opts);
    const emitted = new Set(base.emitted);
    const entries = buildCopilotEvents(read.events, opts).filter(e => !emitted.has(e['event.id']));
    const shutdown = read.events.some(e => e.type === 'session.shutdown');
    // A capped read cannot see the whole open interaction: advance instead of re-reading
    // the same first chunk forever.
    if (read.capped) this.logger.warn('open interaction exceeds the per-read cap; continuing mid-interaction', { session: id });
    const keepOpen = tailStartsInteraction && !shutdown && !read.capped;
    return {
      entries,
      checkpoint: {
        // Re-read the open interaction next cycle; skip past everything once it is closed.
        offset: keepOpen ? read.offsets[tailStart] : read.nextOffset,
        emitted: keepOpen ? tailEntries.map(e => e['event.id']).slice(-MAX_EMITTED_IDS) : [],
        closed: shutdown,
        lastGrowthMs: now,
        size: read.capped ? read.nextOffset : fileSize,
        usage: collectUsageTotals(read.events, base.usage),
        cost: collectSessionCost(read.events, base.cost),
      },
    };
  }

  private async idleCheckpoint(
    id: string,
    file: string,
    checkpoint: SessionCheckpoint,
    now: number,
  ): Promise<SessionCheckpoint> {
    const idleFor = now - checkpoint.lastGrowthMs;
    if (idleFor < this.deadGraceMs) return checkpoint;
    if (await hasLiveLock(path.dirname(file))) return checkpoint;
    this.logger.debug('closing dead session without shutdown', { session: id });
    return { ...checkpoint, closed: true };
  }
}

function freshCheckpoint(): SessionCheckpoint {
  return { offset: 0, emitted: [], closed: false, lastGrowthMs: Date.now(), size: 0, usage: {}, cost: {} };
}

/** Index of the last user.message, or 0 when the span has none (caller re-checks the type). */
function lastUserIndex(events: CopilotEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user.message') return i;
  }
  return 0;
}

async function hasLiveLock(sessionDir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.readdir(sessionDir);
  } catch {
    return false;
  }
  for (const name of names) {
    const match = /^inuse\.(\d+)\.lock$/.exec(name);
    if (!match) continue;
    try {
      process.kill(Number(match[1]), 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    }
  }
  return false;
}

function normalizeCheckpoints(raw: unknown): Record<string, SessionCheckpoint> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, SessionCheckpoint> = {};
  for (const [id, value] of Object.entries(raw as Record<string, Partial<SessionCheckpoint>>)) {
    if (!value || typeof value.offset !== 'number') continue;
    out[id] = {
      offset: value.offset,
      emitted: Array.isArray(value.emitted) ? value.emitted.filter(v => typeof v === 'string') : [],
      closed: value.closed === true,
      lastGrowthMs: typeof value.lastGrowthMs === 'number' ? value.lastGrowthMs : Date.now(),
      size: typeof value.size === 'number' ? value.size : 0,
      usage: value.usage && typeof value.usage === 'object' ? value.usage : {},
      cost: value.cost && typeof value.cost === 'object' ? value.cost : {},
    };
  }
  return out;
}
