import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { createHash } from 'node:crypto';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';

export interface TrajectoryPollingOptions extends InputOptions {
  /** Path to the trajectory JSON file to poll. */
  trajectoryFile: string;
  /** Polling interval, defaults to 30s via BaseInput. */
}

const TRAJECTORY_STATE_VERSION = 3;
const RUN_ID_PREFIX = 'trajectory-run-v3:';

/**
 * Base input for tools that write one or more trajectory JSON files
 * (e.g. trae-agent `TrajectoryRecorder.save_trajectory()` does an integral
 * `json.dump` rewrite on every record_* call).
 *
 * Subclass implements parseTrajectory(json, ctx): convert a freshly-read
 * trajectory into the AgentActivityEntry set emitted this cycle. The
 * subclass's converter MUST:
 *   - skip any step whose step_number is already in ctx.seenStepNumbers
 *   - return the set of step_numbers newly emitted so the base class can
 *     persist them for next cycle's dedup
 *   - sort entries by time_unix_nano ascending
 *
 * The converter MUST NOT emit a separate SESSION 'other' marker event —
 * the OTLP converter library synthesizes the ENTRY/AGENT pair from the
 * LLM/TOOL records' gen_ai.session.id / gen_ai.agent.type fields. A
 * stray SESSION 'other' event forms its own trace-keyed turn buffer and
 * the library synthesizes a duplicate bare ENTRY/AGENT pair from it.
 *
 * Dedup model:
 *   - Persistent `state.extra.runsById` stores one checkpoint per logical run;
 *     each checkpoint owns its own sorted `seenStepNumbers` and completion bit.
 *     Switching A -> B -> A therefore restores A instead of clearing it.
 *   - Length-only comparisons (`len(agent_steps)`) are explicitly forbidden:
 *     the dedup key is the 1-based monotonic `step_number` within each run.
 *   - When one run's file fingerprint (inode+size+mtime) indicates truncation
 *     or replacement on the same path, only that run's seen set is cleared and
 *     the next emitted batch is stamped as a session reset.
 */
export abstract class BaseTrajectoryPollingInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.LogWatchPolling;

  protected readonly trajectoryFile: string;

  constructor(opts: TrajectoryPollingOptions) {
    super(opts);
    this.trajectoryFile = opts.trajectoryFile;
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const trajectoryFiles = await this.resolveTrajectoryFiles();
    const entries: AgentActivityEntry[] = [];
    for (const trajectoryFile of trajectoryFiles) {
      try {
        entries.push(...await this.processTrajectoryFile(trajectoryFile));
      } catch (err) {
        // One corrupt or concurrently-removed file must not block other runs
        // discovered in the same polling cycle.
        this.logger.warn('trajectory processing failed', { file: trajectoryFile, error: String(err) });
      }
    }
    return entries;
  }

  private async processTrajectoryFile(trajectoryFile: string): Promise<AgentActivityEntry[]> {
    const stateKey = this.id;
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(trajectoryFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('trajectory stat failed', { file: trajectoryFile, error: String(err) });
      }
      return [];
    }
    if (!stat.isFile()) return [];

    let raw: string;
    try {
      raw = await fs.readFile(trajectoryFile, 'utf8');
    } catch (err) {
      this.logger.warn('trajectory read failed', { file: trajectoryFile, error: String(err) });
      return [];
    }
    if (!raw.trim()) return [];

    let parsed: TrajectoryJson;
    try {
      parsed = JSON.parse(raw) as TrajectoryJson;
    } catch (err) {
      this.logger.warn('trajectory json parse failed', { file: trajectoryFile, error: String(err) });
      return [];
    }

    const prevState = this.stateStore.get(stateKey);
    const prevExtra = (prevState.extra ?? {}) as TrajectoryExtra;
    let runsById = this.cloneRunCheckpoints(prevExtra.runsById);
    const currentFp = this.trajectoryFingerprint(stat);
    const currentRunId = this.deriveRunIdentity(parsed);
    // Identity-less files still need isolated checkpoints; otherwise two such
    // files share a seen-step set and suppress each other.
    const currentRunKey = currentRunId || `file:${trajectoryFile}`;

    // Version 3 replaces plaintext `${start_time}|${task}` keys with a stable
    // SHA-256 digest. Migrate every v2 map key before lookup so no raw task is
    // written back to checkpoint state, including runs not active this cycle.
    if (prevExtra.trajectoryStateVersion !== TRAJECTORY_STATE_VERSION) {
      runsById = this.migrateRunCheckpoints(runsById);
    }

    // Backward-compatible migration from the former input-level single slot.
    // A known legacy run is restored under its digest key before any other file
    // in this cycle is processed, so an upgrade does not replay seen steps.
    if (prevExtra.trajectoryStateVersion !== TRAJECTORY_STATE_VERSION
      && Object.keys(runsById).length === 0) {
      const hasLegacyState = Boolean(
        prevExtra.runId
        || prevExtra.fingerprint
        || (prevExtra.seenStepNumbers && prevExtra.seenStepNumbers.length > 0)
        || prevExtra.runCompletionEmitted,
      );
      if (hasLegacyState) {
        const legacyRunKey = prevExtra.runId
          ? this.normalizeStoredRunKey(prevExtra.runId)
          : currentRunKey;
        runsById[legacyRunKey] = {
          fingerprint: prevExtra.fingerprint,
          seenStepNumbers: [...(prevExtra.seenStepNumbers ?? [])],
          runCompletionEmitted: Boolean(prevExtra.runCompletionEmitted),
          lastProcessedAt: prevExtra.lastProcessedAt,
        };
      }
    }

    // A fixed path may be overwritten by a brand-new logical run. Once the new
    // identity is visible, an older checkpoint for that same physical path can
    // never be reached from the current file and would otherwise grow forever.
    for (const [runKey, checkpoint] of Object.entries(runsById)) {
      if (runKey !== currentRunKey && checkpoint.lastFile === trajectoryFile) {
        delete runsById[runKey];
      }
    }

    const checkpoint = runsById[currentRunKey];
    const storedActiveRunId = prevExtra.activeRunId ?? prevExtra.runId;
    const previousActiveRunId = storedActiveRunId
      ? this.normalizeStoredRunKey(storedActiveRunId)
      : undefined;
    let sessionReset = !checkpoint
      && Boolean(previousActiveRunId && previousActiveRunId !== currentRunKey);
    let seenStepNumbers = new Set<number>(checkpoint?.seenStepNumbers ?? []);
    let runCompletionEmitted = Boolean(checkpoint?.runCompletionEmitted);
    const prevFingerprint = checkpoint?.fingerprint;

    // Truncation is meaningful only for the same logical run observed through
    // the same physical file. Switching A -> B -> A must restore A's checkpoint,
    // not clear it merely because B was processed most recently.
    const samePhysicalFile = !checkpoint?.lastFile || checkpoint.lastFile === trajectoryFile;
    if (prevFingerprint && prevFingerprint !== currentFp && samePhysicalFile) {
      const truncated = this.isTruncation(prevFingerprint, currentFp, stat);
      if (truncated) {
        this.logger.info('trajectory truncated or replaced, resetting run checkpoint', {
          file: trajectoryFile,
          runId: currentRunId,
          prev: prevFingerprint,
          current: currentFp,
        });
        seenStepNumbers = new Set<number>();
        sessionReset = true;
        runCompletionEmitted = false;
      }
    }

    const ctx: TrajectoryEmitContext = {
      seenStepNumbers,
      sessionReset,
      runCompletionEmitted,
      prevFingerprint,
      currentFingerprint: currentFp,
    };
    const { entries, emittedStepNumbers, runCompletionEmitted: terminalEmitted } =
      await this.parseTrajectory(parsed, ctx);
    for (const n of emittedStepNumbers) seenStepNumbers.add(n);

    const lastProcessedAt = Date.now();
    const sortedSeenStepNumbers = Array.from(seenStepNumbers).sort((a, b) => a - b);
    const completionEmitted = Boolean(terminalEmitted || runCompletionEmitted);
    runsById[currentRunKey] = {
      fingerprint: currentFp,
      seenStepNumbers: sortedSeenStepNumbers,
      runCompletionEmitted: completionEmitted,
      lastProcessedAt,
      lastFile: trajectoryFile,
      lastMtimeMs: stat.mtimeMs,
    };

    this.stateStore.update(stateKey, {
      extra: {
        trajectoryStateVersion: TRAJECTORY_STATE_VERSION,
        activeRunId: currentRunKey,
        runsById,
        // Compatibility mirror for diagnostics and downgrade tolerance. Runtime
        // dedup reads runsById exclusively once state version 3 is present.
        fingerprint: currentFp,
        runId: currentRunId,
        seenStepNumbers: sortedSeenStepNumbers,
        sessionReset,
        runCompletionEmitted: completionEmitted,
        lastProcessedAt,
      },
    } as unknown as Partial<InputState>);

    return entries;
  }

  private cloneRunCheckpoints(
    raw: TrajectoryExtra['runsById'],
  ): Record<string, TrajectoryRunCheckpoint> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, TrajectoryRunCheckpoint> = {};
    for (const [runId, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      out[runId] = {
        ...value,
        seenStepNumbers: Array.isArray(value.seenStepNumbers)
          ? value.seenStepNumbers.filter((n): n is number => Number.isInteger(n) && n > 0)
          : [],
      };
    }
    return out;
  }

  private migrateRunCheckpoints(
    checkpoints: Record<string, TrajectoryRunCheckpoint>,
  ): Record<string, TrajectoryRunCheckpoint> {
    const migrated: Record<string, TrajectoryRunCheckpoint> = {};
    for (const [storedRunId, checkpoint] of Object.entries(checkpoints)) {
      const safeRunId = this.normalizeStoredRunKey(storedRunId);
      const existing = migrated[safeRunId];
      if (!existing) {
        migrated[safeRunId] = checkpoint;
        continue;
      }
      const newer = (checkpoint.lastProcessedAt ?? 0) >= (existing.lastProcessedAt ?? 0)
        ? checkpoint
        : existing;
      migrated[safeRunId] = {
        ...existing,
        ...newer,
        seenStepNumbers: [...new Set([
          ...(existing.seenStepNumbers ?? []),
          ...(checkpoint.seenStepNumbers ?? []),
        ])].sort((a, b) => a - b),
        runCompletionEmitted: Boolean(
          existing.runCompletionEmitted || checkpoint.runCompletionEmitted,
        ),
      };
    }
    return migrated;
  }

  private normalizeStoredRunKey(storedRunId: string): string {
    if (storedRunId.startsWith(RUN_ID_PREFIX) || storedRunId.startsWith('file:')) {
      return storedRunId;
    }
    const separator = storedRunId.indexOf('|');
    if (separator >= 0) {
      return this.hashRunIdentity(
        storedRunId.slice(0, separator),
        storedRunId.slice(separator + 1),
      );
    }
    return `${RUN_ID_PREFIX}${createHash('sha256').update(storedRunId).digest('hex').slice(0, 32)}`;
  }

  private hashRunIdentity(startTime: string, task: string): string {
    const seed = JSON.stringify([startTime, task]);
    return `${RUN_ID_PREFIX}${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
  }

  /**
   * Resolve the trajectory file to poll this cycle. Defaults to the fixed
   * `trajectoryFile` from options; subclasses that discover the active file
   * (e.g. trae-agent's timestamped `trajectory_<ts>.json` in a watched
   * directory) override this to re-resolve every cycle. Returning an empty
   * string skips the cycle.
   */
  protected async resolveTrajectoryFile(): Promise<string> {
    return this.trajectoryFile;
  }

  /**
   * Resolve every trajectory file that should be processed this cycle. The
   * default preserves the historical single-file contract; directory-backed
   * subclasses can override this to return all matching files in stable order.
   */
  protected async resolveTrajectoryFiles(): Promise<string[]> {
    const trajectoryFile = await this.resolveTrajectoryFile();
    return trajectoryFile ? [trajectoryFile] : [];
  }

  /**
   * Derive a stable, non-reversible logical run identity. Raw task content is
   * used only as hash input and must never enter checkpoint keys or logs.
   * Returns '' when both fields are absent so callers can fall back to the path.
   */
  protected deriveRunIdentity(json: TrajectoryJson): string {
    const start = typeof json?.start_time === 'string' ? json.start_time : '';
    const task = typeof json?.task === 'string' ? json.task : '';
    if (!start && !task) return '';
    return this.hashRunIdentity(start, task);
  }

  /**
   * Default fingerprint: inode+size+mtime. inode is captured via Stats.ino
   * (NaN on platforms without stable inode semantics — caller should treat
   * NaN-inode as a 0 for fingerprint purposes).
   */
  protected trajectoryFingerprint(stat: fsSync.Stats): string {
    const inode = Number.isNaN(stat.ino) ? 0 : stat.ino;
    return `${inode}:${stat.size}:${stat.mtimeMs}`;
  }

  /**
   * Heuristic for "did the trajectory file get truncated or replaced out from
   * under us". Default rule:
   *   - size shrank ⇒ truncation
   *   - inode changed (and inode is non-zero on both sides) ⇒ file replaced
   *   - size same or grew + mtime newer ⇒ normal append-style overwrite; NOT a reset
   */
  protected isTruncation(prevFp: string, currentFp: string, _stat: fsSync.Stats): boolean {
    const [prevInodeStr, prevSizeStr] = prevFp.split(':');
    const [curInodeStr, curSizeStr] = currentFp.split(':');
    const prevInode = Number(prevInodeStr);
    const curInode = Number(curInodeStr);
    const prevSize = Number(prevSizeStr);
    const curSize = Number(curSizeStr);
    if (curSize < prevSize) return true;
    if (prevInode !== 0 && curInode !== 0 && prevInode !== curInode) return true;
    return false;
  }

  /**
   * Convert the freshly-parsed trajectory JSON into a sorted list of
   * AgentActivityEntry to emit this cycle. Implementations MUST:
   *   - skip any step whose step_number is already in ctx.seenStepNumbers
   *   - return the set of step_numbers newly emitted (so the base class can
   *     persist them for next cycle's dedup)
   *   - sort entries by time_unix_nano ascending before returning
   */
  protected abstract parseTrajectory(
    json: TrajectoryJson,
    ctx: TrajectoryEmitContext,
  ): Promise<{ entries: AgentActivityEntry[]; emittedStepNumbers: number[]; runCompletionEmitted?: boolean }>;
}

export interface TrajectoryRunCheckpoint {
  fingerprint?: string;
  seenStepNumbers?: number[];
  /** True once the finalize (turn.end) terminal was emitted for this run (P1-2). */
  runCompletionEmitted?: boolean;
  lastProcessedAt?: number;
  lastFile?: string;
  lastMtimeMs?: number;
}

export interface TrajectoryExtra {
  /** Version 3 stores per-run state under task-safe digest identities. */
  trajectoryStateVersion?: number;
  activeRunId?: string;
  runsById?: Record<string, TrajectoryRunCheckpoint>;
  // Legacy single-slot fields retained as a compatibility mirror/migration source.
  fingerprint?: string;
  /** Versioned SHA-256 logical run identity; never contains raw task text. */
  runId?: string;
  seenStepNumbers?: number[];
  sessionReset?: boolean;
  runCompletionEmitted?: boolean;
  lastProcessedAt?: number;
}

export interface TrajectoryEmitContext {
  seenStepNumbers: Set<number>;
  sessionReset: boolean;
  /** A prior cycle already emitted this run's finalize terminal (P1-2). */
  runCompletionEmitted: boolean;
  prevFingerprint?: string;
  currentFingerprint: string;
}

export interface TrajectoryJson {
  [key: string]: unknown;
}
