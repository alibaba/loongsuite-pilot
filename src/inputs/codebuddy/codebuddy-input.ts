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
/**
 * How long a session's boundary timeline is kept after its last observation.
 * Bounds the `boundaries` state map without losing seal evidence in practice:
 * a session that resumes after the window simply re-creates its entry with the
 * next prompt — which is exactly the boundary needed to seal the turn it had
 * left open. 30d is deliberately generous: the only loss case is a turn left
 * open with zero hook events for the whole window.
 */
const BOUNDARY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** Legacy StateStore keys from the offset-tracking design (pre consume-and-delete). */
const LEGACY_STATE_KEYS = [OFFSET_MAP_KEY, INITIALIZED_KEY] as const;

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
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const state = this.getState();
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

        let content: string;
        try {
          content = await fs.readFile(eventFile, 'utf8');
        } catch {
          // A concurrent writer may have removed it.
          continue;
        }
        const record = this.parseRecord(content);
        if (record) recordStopBoundary(boundaries, record);
        // Consume-and-delete, mirroring WorkBuddyInput: the writer publishes
        // each record via tmp+rename, so a visible file is complete and invalid
        // JSON can never become valid later — every read event file is removed.
        // Without this the state dir, an offset map keyed by every file ever
        // seen, and the boundary map would all grow without bound. The crash
        // window (deleted here, state persisted at the end of this pass) is the
        // same best-effort trade WorkBuddyInput makes.
        await fs.unlink(eventFile).catch(() => undefined);
      }
      // Only succeeds when the directory is empty; a freshly written .tmp file
      // (within the orphan grace window) keeps it alive until the next pass.
      await fs.rmdir(sessionDir).catch(() => undefined);
    }

    const nextExtra: Record<string, unknown> = { ...state.extra, [BOUNDARIES_KEY]: pruneStaleBoundaries(boundaries) };
    // StateStore.update merges extra keys, so legacy keys are retired by
    // explicitly writing undefined (JSON.stringify drops them on the next
    // persist) — a plain delete here would be resurrected by the merge.
    for (const key of LEGACY_STATE_KEYS) nextExtra[key] = undefined;
    this.setState({ extra: nextExtra });
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

/**
 * Drop sessions whose last boundary observation is older than the retention
 * window. Bounded growth without losing live seal evidence: a resumed session
 * re-creates its entry with the next prompt (see BOUNDARY_RETENTION_MS).
 */
function pruneStaleBoundaries(
  boundaries: Record<string, { stops: number[]; prompts: number[] }>,
  nowMs: number = Date.now(),
): Record<string, { stops: number[]; prompts: number[] }> {
  const oldest = nowMs - BOUNDARY_RETENTION_MS;
  const out: Record<string, { stops: number[]; prompts: number[] }> = {};
  for (const [sessionId, entry] of Object.entries(boundaries)) {
    const latest = Math.max(...entry.stops, ...entry.prompts);
    if (Number.isFinite(latest) && latest >= oldest) out[sessionId] = entry;
  }
  return out;
}
