import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import {
  BaseTrajectoryPollingInput,
  type TrajectoryEmitContext,
  type TrajectoryJson,
  type TrajectoryPollingOptions,
} from '../base/base-trajectory-polling-input.js';

const DEFAULT_TRAJECTORY_DIR = '~/.trae-agent/trajectories';
const AGENT_ID = 'trae-agent-trajectory';
// trae-agent's TrajectoryRecorder defaults to `trajectories/trajectory_<ts>.json`
// (timestamped, relative to the CLI's CWD) unless `--trajectory-file` is passed.
// Pilot cannot know an arbitrary invocation's CWD, so discovery scans a watched
// directory for any `trajectory*.json` and polls the most recently modified one.
const DEFAULT_TRAJECTORY_FILE_PATTERN = /^trajectory.*\.json$/i;

interface ConverterModule {
  convertTrajectory(
    json: TrajectoryJson,
    opts?: { seenStepNumbers?: Set<number>; sessionReset?: boolean; runCompletionEmitted?: boolean },
  ): { entries: AgentActivityEntry[]; emittedStepNumbers: number[]; runCompletionEmitted?: boolean };
}

export interface TraeAgentTrajectoryOptions extends TrajectoryPollingOptions {
  /**
   * Absolute path to the converter mjs. Required when running from the
   * bundled dist (where the source-tree path is gone) so the input can
   * dynamically import the converter without resolving `import.meta.url`
   * against a stale relative path. Caller (orchestrator) computes this
   * from `pilotDir/assets/hooks/trae-agent/trajectory-converter.mjs`.
   */
  converterPath: string;
  /**
   * Directory to scan for trae-agent trajectory files (P1-1). When set, every
   * matching file is re-discovered and processed each poll cycle in stable
   * oldest-first order. Per-run checkpoints suppress files already consumed,
   * while ensuring multiple runs created between polls are never skipped. When
   * omitted, the input falls back to the fixed `trajectoryFile`.
   */
  trajectoryDir?: string;
  /**
   * Filename filter for directory discovery. Defaults to `/^trajectory.*\.json$/i`.
   */
  trajectoryFilePattern?: RegExp;
}

/**
 * Polls a trae-agent trajectory JSON file (overwritten each cycle by
 * `TrajectoryRecorder.save_trajectory`) and emits a 5-layer ENTRY → AGENT →
 * STEP → {LLM_CALL, TOOL*} span tree. The ENTRY/AGENT/STEP layers are
 * synthesized by the OTLP converter library from the LLM/TOOL records'
 * gen_ai.session.id / gen_ai.step.id / gen_ai.agent.type fields; the
 * converter mjs emits LLM/TOOL records plus a flush-only `other` control
 * marker when end_time appears after the final business record.
 *
 * Conversion logic lives in `assets/hooks/trae-agent/trajectory-converter.mjs`
 * so the same code backs the runtime input and the standalone smoke-test CLI.
 * trae-agent has no shell hook (deployMode "log-watch"); the path is retained
 * to align with the existing per-agent asset directory convention.
 *
 * P1-1: the trajectory source is discovered, not hardcoded. When `trajectoryDir`
 * is configured the input scans it each cycle for every `trajectory*.json` and
 * processes them oldest-first, so two runs produced between polls are both
 * collected. Per-run checkpoints make repeated scans idempotent. Because
 * LogWatchStrategy cannot redirect the CLI's output
 * location, an operator running trae-cli with its CWD-relative default should
 * either pass `--trajectory-file <watchedDir>/trajectory.json` so the file lands
 * where discovery scans, or set `listeners['trae-agent-trajectory'].trajectoryDir`
 * in config.json to the actual CWD-relative `trajectories/` directory.
 */
export class TraeAgentTrajectoryInput extends BaseTrajectoryPollingInput {
  readonly id = AGENT_ID;
  readonly agentType = ClientType.TraeAgent;

  private readonly converterPath: string;
  private readonly trajectoryDir?: string;
  private readonly trajectoryFilePattern: RegExp;
  private converter: ConverterModule | null = null;

  constructor(opts: TraeAgentTrajectoryOptions) {
    super(opts);
    this.converterPath = opts.converterPath;
    this.trajectoryDir = opts.trajectoryDir ? resolveHome(opts.trajectoryDir) : undefined;
    this.trajectoryFilePattern = opts.trajectoryFilePattern ?? DEFAULT_TRAJECTORY_FILE_PATTERN;
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_TRAJECTORY_DIR));
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_TRAJECTORY_DIR)];
  }

  static getDefaultTrajectoryDir(): string {
    return resolveHome(DEFAULT_TRAJECTORY_DIR);
  }

  /**
   * Re-resolve all trajectory files each cycle (P1-1). A newest-only scan loses
   * run A forever when A and B both appear between polls and B is newer. Return
   * every matching file ordered by mtime then path; the base class's per-run
   * checkpoints make repeated scans idempotent. Without a directory, preserve
   * the fixed-file behavior.
   */
  protected async resolveTrajectoryFiles(): Promise<string[]> {
    if (!this.trajectoryDir) return this.trajectoryFile ? [this.trajectoryFile] : [];
    let names: string[];
    try {
      names = await fs.readdir(this.trajectoryDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('trajectory dir scan failed', { dir: this.trajectoryDir, error: String(err) });
      }
      return [];
    }
    const discovered: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of names) {
      this.trajectoryFilePattern.lastIndex = 0;
      if (!this.trajectoryFilePattern.test(name)) continue;
      const full = path.join(this.trajectoryDir, name);
      try {
        const st = await fs.stat(full);
        if (st.isFile()) discovered.push({ file: full, mtimeMs: st.mtimeMs });
      } catch {
        // A file that vanished mid-scan is simply skipped this cycle.
      }
    }
    discovered.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
    return discovered.map(item => item.file);
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    if (!this.converter) {
      const url = pathToFileURL(this.converterPath).href;
      this.converter = (await import(url)) as unknown as ConverterModule;
    }
    return super.collect();
  }

  protected async parseTrajectory(
    json: TrajectoryJson,
    ctx: TrajectoryEmitContext,
  ): Promise<{ entries: AgentActivityEntry[]; emittedStepNumbers: number[]; runCompletionEmitted?: boolean }> {
    if (!this.converter) {
      throw new Error('trajectory converter not loaded');
    }
    return this.converter.convertTrajectory(json, {
      seenStepNumbers: ctx.seenStepNumbers,
      sessionReset: ctx.sessionReset,
      runCompletionEmitted: ctx.runCompletionEmitted,
    });
  }
}

export type { TrajectoryPollingOptions };
