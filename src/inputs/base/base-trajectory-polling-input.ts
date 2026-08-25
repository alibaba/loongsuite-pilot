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
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(this.trajectoryFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('trajectory stat failed', { file: this.trajectoryFile, error: String(err) });
      }
      return [];
    }
    if (!stat.isFile()) return [];

    const prevState = this.stateStore.get(stateKey);
    const prevExtra = (prevState.extra ?? {}) as TrajectoryExtra;
    const prevFingerprint = prevExtra.fingerprint;
    const currentFp = this.trajectoryFingerprint(stat);

    let sessionReset = false;
    let seenStepNumbers = new Set<number>(prevExtra.seenStepNumbers ?? []);
    if (prevFingerprint && prevFingerprint !== currentFp) {
      const truncated = this.isTruncation(prevFingerprint, currentFp, stat);
      if (truncated) {
        this.logger.info('trajectory truncated or replaced, resetting dedup state', {
          file: this.trajectoryFile,
          prev: prevFingerprint,
          current: currentFp,
        });
        seenStepNumbers = new Set<number>();
        sessionReset = true;
      }
    }

    let raw: string;
    try {
      raw = await fs.readFile(this.trajectoryFile, 'utf8');
    } catch (err) {
      this.logger.warn('trajectory read failed', { file: this.trajectoryFile, error: String(err) });
      return [];
    }
    if (!raw.trim()) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn('trajectory json parse failed', { file: this.trajectoryFile, error: String(err) });
      return [];
    }

    const ctx: TrajectoryEmitContext = {
      seenStepNumbers,
      sessionReset,
      prevFingerprint,
      currentFingerprint: currentFp,
    };
    const { entries, emittedStepNumbers } = await this.parseTrajectory(parsed as TrajectoryJson, ctx);
    for (const n of emittedStepNumbers) seenStepNumbers.add(n);

    this.stateStore.update(stateKey, {
      extra: {
        fingerprint: currentFp,
        seenStepNumbers: Array.from(seenStepNumbers).sort((a, b) => a - b),
        sessionReset,
        lastProcessedAt: Date.now(),
      },
    } as unknown as Partial<InputState>);

    return entries;
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
  ): Promise<{ entries: AgentActivityEntry[]; emittedStepNumbers: number[] }>;
}

export interface TrajectoryExtra {
  fingerprint?: string;
  seenStepNumbers?: number[];
  sessionReset?: boolean;
  lastProcessedAt?: number;
}

export interface TrajectoryEmitContext {
  seenStepNumbers: Set<number>;
  sessionReset: boolean;
  prevFingerprint?: string;
  currentFingerprint: string;
}

export interface TrajectoryJson {
  [key: string]: unknown;
}
