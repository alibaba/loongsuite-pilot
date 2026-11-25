import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Dirent } from 'node:fs';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { ensureDir } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('CodeBuddyInput');

const OFFSET_MAP_KEY = 'codebuddyHookEventOffsets';
const INITIALIZED_KEY = 'codebuddyHookInitialized';
const BOUNDARIES_KEY = 'boundaries';
const MAX_STOPS_PER_SESSION = 64;
const ORPHAN_GRACE_MS = 60 * 60 * 1_000;
const STABILITY_RETRY_MS = 5_000;

/** Record shape written by assets/hooks/codebuddy-hook-event-writer.mjs. */
interface CodeBuddyHookEventRecord {
  observed_at_ms: number;
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  cwd?: string;
  tool_name?: string;
  tool_call_id?: string;
  model?: string;
  permission_mode?: string;
  agent_type?: string;
}

/**
 * Input for legacy CodeBuddy clients (pre-rename, e.g. CodeBuddy CN / genie).
 *
 * CodeBuddy shares WorkBuddy's hook contract (SessionStart / UserPromptSubmit /
 * PreToolUse / PostToolUse / Stop with the same stdin payload shape), so the
 * hook deployment is declared in agents.d/codebuddy.json and the writer reuses
 * workbuddy-hook-event-writer.mjs — only the output directory differs
 * (`<dataDir>/state/codebuddy/hook-events`).
 *
 * This input is a pure boundary collector: it emits no {@link AgentActivityEntry}
 * events. Instead it records the hook-observed Stop boundaries per session into
 * its StateStore entry (`extra.boundaries`), which {@link CodeBuddyHistoryInput}
 * reads to seal turns the history store alone cannot close (tool-call endings,
 * cancelled runs) with a real client-side timestamp. Emitting boundary entries
 * here would orphan them — hook records carry no turn id the history stream
 * could know — and duplicate tool events; hooks signal, the content source
 * speaks (mirrors the WorkBuddy split).
 */
export class CodeBuddyInput extends BaseInput {
  readonly id = 'codebuddy';
  readonly agentType = ClientType.CodeBuddy;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly hookEventDir: string;
  private watchers: fsSync.FSWatcher[] = [];
  private stabilityRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: InputOptions & { hookEventDir?: string }) {
    super(opts);
    this.hookEventDir = opts.hookEventDir
      ?? path.join(homedir(), '.loongsuite-pilot', 'state', 'codebuddy', 'hook-events');
  }

  static getWatchPaths(): string[] {
    return [path.join(homedir(), '.codebuddy')];
  }

  static async checkAvailability(): Promise<boolean> {
    try {
      await fs.access(path.join(homedir(), '.codebuddy'));
      return true;
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    await ensureDir(this.hookEventDir);
    this.watchDirectory(this.hookEventDir);
  }

  protected override async onStop(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.stabilityRetry) {
      clearTimeout(this.stabilityRetry);
      this.stabilityRetry = null;
    }
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const state = this.getState();
    const initialized = state.extra?.[INITIALIZED_KEY] === true;
    const prevOffsets = normalizeOffsetMap(state.extra?.[OFFSET_MAP_KEY]);
    const nextOffsets: Record<string, number> = { ...prevOffsets };
    const boundaries = normalizeBoundaries(state.extra?.[BOUNDARIES_KEY]);

    const sessionEntries = await this.listSessionDirs();

    for (const sessionDir of sessionEntries) {
      const eventFiles = (await fs.readdir(sessionDir)).sort();
      for (const name of eventFiles) {
        const eventFile = path.join(sessionDir, name);
        if (name.startsWith('.') && name.endsWith('.tmp')) {
          await this.removeStaleTmp(eventFile);
          continue;
        }
        if (!name.endsWith('.json')) continue;

        const offset = initialized ? (prevOffsets[eventFile] ?? 0) : 0;
        let content: string;
        try {
          const stat = await fs.stat(eventFile);
          if (stat.size <= offset) continue;
          content = await fs.readFile(eventFile, 'utf8');
        } catch {
          // A concurrent writer may have removed it.
          continue;
        }
        nextOffsets[eventFile] = Buffer.byteLength(content, 'utf8');
        const record = this.parseRecord(content);
        if (record) recordStopBoundary(boundaries, record);
      }
    }

    this.setState({
      extra: {
        ...state.extra,
        [INITIALIZED_KEY]: true,
        [OFFSET_MAP_KEY]: nextOffsets,
        [BOUNDARIES_KEY]: boundaries,
      },
    });
    // No entries: this input only feeds the Stop-boundary timeline consumed by
    // CodeBuddyHistoryInput (see class doc).
    return [];
  }

  private async listSessionDirs(): Promise<string[]> {
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(this.hookEventDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return dirents.filter(d => d.isDirectory()).map(d => path.join(this.hookEventDir, d.name));
  }

  private async removeStaleTmp(tmpFile: string): Promise<void> {
    try {
      const stat = await fs.stat(tmpFile);
      if (Date.now() - stat.mtimeMs > ORPHAN_GRACE_MS) await fs.unlink(tmpFile);
    } catch {
      // Already removed by a concurrent writer.
    }
  }

  private parseRecord(content: string): CodeBuddyHookEventRecord | null {
    try {
      const obj = JSON.parse(content) as CodeBuddyHookEventRecord;
      if (typeof obj.session_id !== 'string' || typeof obj.hook_event_name !== 'string') return null;
      return obj;
    } catch {
      return null;
    }
  }

  private watchDirectory(dir: string): void {
    try {
      const watcher = fsSync.watch(dir, { recursive: true }, () => this.requestCollection());
      watcher.on('error', () => undefined);
      this.watchers.push(watcher);
    } catch {
      // Polling remains active when the path is absent or recursive watch is unsupported.
    }
  }

  private scheduleStabilityRetry(): void {
    if (!this.running || this.stabilityRetry) return;
    this.stabilityRetry = setTimeout(() => {
      this.stabilityRetry = null;
      this.requestCollection();
    }, STABILITY_RETRY_MS);
  }
}

function normalizeBoundaries(raw: unknown): Record<string, { stops: number[]; prompts: number[] }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, { stops: number[]; prompts: number[] }> = {};
  for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const validNums = (list: unknown): number[] =>
      Array.isArray(list) ? list.filter((s): s is number => typeof s === 'number' && Number.isFinite(s) && s > 0) : [];
    const stops = validNums((value as { stops?: unknown }).stops);
    const prompts = validNums((value as { prompts?: unknown }).prompts);
    if (stops.length > 0 || prompts.length > 0) out[sessionId] = { stops, prompts };
  }
  return out;
}

/**
 * Record a hook boundary observation into the session boundary timeline.
 * Both event kinds prove "the previous turn ended": Stop because the run
 * finished, UserPromptSubmit because the user started a new turn. The latter
 * matters because CodeBuddy does NOT emit Stop when the user aborts a running
 * turn — the next prompt is then the only client-observed end signal for the
 * aborted turn.
 */
function recordStopBoundary(
  boundaries: Record<string, { stops: number[]; prompts: number[] }>,
  record: CodeBuddyHookEventRecord,
): void {
  const isStop = record.hook_event_name === 'Stop';
  const isPrompt = record.hook_event_name === 'UserPromptSubmit';
  if (!isStop && !isPrompt) return;
  const atMs = typeof record.observed_at_ms === 'number' && Number.isFinite(record.observed_at_ms)
    ? Math.trunc(record.observed_at_ms)
    : undefined;
  if (!record.session_id || atMs === undefined || atMs <= 0) return;
  const entry = boundaries[record.session_id] ??= { stops: [], prompts: [] };
  if (isStop) {
    entry.stops.push(atMs);
    if (entry.stops.length > MAX_STOPS_PER_SESSION) {
      entry.stops = entry.stops.slice(-MAX_STOPS_PER_SESSION);
    }
  } else {
    entry.prompts.push(atMs);
    if (entry.prompts.length > MAX_STOPS_PER_SESSION) {
      entry.prompts = entry.prompts.slice(-MAX_STOPS_PER_SESSION);
    }
  }
}

function normalizeOffsetMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}
