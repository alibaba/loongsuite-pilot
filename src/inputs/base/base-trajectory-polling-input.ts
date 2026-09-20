import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';

export interface TrajectoryPollingOptions extends InputOptions {
  /** Path to the trajectory JSON file to poll. */
  trajectoryFile: string;
  /** Polling interval, defaults to 30s via BaseInput. */
}

/**
 * Base input for tools that overwrite a single trajectory JSON file each
 * cycle (e.g. trae-agent `TrajectoryRecorder.save_trajectory()` does an
 * integral `json.dump` rewrite on every record_* call).
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
 *   - Persistent `state.extra.seenStepNumbers` is a Set<number> (serialised
 *     as a sorted array). The base class clears the set when truncation or
 *     file replacement is detected (see isTruncation).
 *   - Length-only comparisons (`len(agent_steps)`) are explicitly forbidden:
 *     same length with mutated content would silently lose events. The
 *     dedup key is `step_number` (a 1-based monotonic in trae-agent's
 *     trajectory schema) and persists across cycles via stateStore.
 *   - When the file fingerprint (inode+size+mtime) indicates truncation or
 *     replacement (size shrinks, or inode changes), the base class clears
 *     the seen set, sets `extra.sessionReset=true` on the next emitted
 *     batch so downstream consumers can mark a fresh session, and
 *     re-emits the full trajectory.
 */
export abstract class BaseTrajectoryPollingInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.LogWatchPolling;

  protected readonly trajectoryFile: string;

  constructor(opts: TrajectoryPollingOptions) {
    super(opts);
    this.trajectoryFile = opts.trajectoryFile;
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const stateKey = this.id;
    const trajectoryFile = await this.resolveTrajectoryFile();
    if (!trajectoryFile) return [];
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn('trajectory json parse failed', { file: trajectoryFile, error: String(err) });
      return [];
    }

    const prevState = this.stateStore.get(stateKey);
    const prevExtra = (prevState.extra ?? {}) as TrajectoryExtra;
    const prevFingerprint = prevExtra.fingerprint;
    const currentFp = this.trajectoryFingerprint(stat);

    // P1-3: dedup state is scoped to a LOGICAL RUN, not to the physical file.
    // trae-agent rewrites its trajectory via `open(path, "w")` (inode stable);
    // a new run reusing the same configured path can therefore present a larger
    // file with the same inode, so the size-shrink / inode-change truncation
    // heuristic alone would keep the previous run's seenStepNumbers and drop
    // the new run's same-numbered steps (a whole silent turn loss). Derive a
    // run identity from the trajectory content and reset dedup whenever it
    // changes, independent of the file fingerprint.
    const currentRunId = this.deriveRunIdentity(parsed as TrajectoryJson);
    const prevRunId = prevExtra.runId;
    const runChanged = Boolean(prevRunId && currentRunId && prevRunId !== currentRunId);

    let sessionReset = false;
    let seenStepNumbers = new Set<number>(prevExtra.seenStepNumbers ?? []);
    let runCompletionEmitted = Boolean(prevExtra.runCompletionEmitted);
    if (runChanged) {
      this.logger.info('trajectory run identity changed, resetting dedup state', {
        file: trajectoryFile,
        prevRunId,
        currentRunId,
      });
      seenStepNumbers = new Set<number>();
      sessionReset = true;
      runCompletionEmitted = false;
    } else if (prevFingerprint && prevFingerprint !== currentFp) {
      const truncated = this.isTruncation(prevFingerprint, currentFp, stat);
      if (truncated) {
        this.logger.info('trajectory truncated or replaced, resetting dedup state', {
          file: trajectoryFile,
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
      await this.parseTrajectory(parsed as TrajectoryJson, ctx);
    for (const n of emittedStepNumbers) seenStepNumbers.add(n);

    this.stateStore.update(stateKey, {
      extra: {
        fingerprint: currentFp,
        runId: currentRunId,
        seenStepNumbers: Array.from(seenStepNumbers).sort((a, b) => a - b),
        sessionReset,
        runCompletionEmitted: Boolean(terminalEmitted),
        lastProcessedAt: Date.now(),
      },
    } as unknown as Partial<InputState>);

    return entries;
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
   * Derive a stable LOGICAL RUN identity from a freshly-parsed trajectory. The
   * default keys on `start_time` + `task`, which trae-agent stamps once per run
   * in start_recording, so a new run reusing the same file path yields a new
   * identity. Returns '' when neither field is present (identity unknown →
   * callers must not treat '' as a run change).
   */
  protected deriveRunIdentity(json: TrajectoryJson): string {
    const start = typeof json?.start_time === 'string' ? json.start_time : '';
    const task = typeof json?.task === 'string' ? json.task : '';
    if (!start && !task) return '';
    return `${start}|${task}`;
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

export interface TrajectoryExtra {
  fingerprint?: string;
  /** Logical run identity (start_time|task); a change resets dedup (P1-3). */
  runId?: string;
  seenStepNumbers?: number[];
  sessionReset?: boolean;
  /** True once the finalize (turn.end) terminal was emitted for this run (P1-2). */
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
