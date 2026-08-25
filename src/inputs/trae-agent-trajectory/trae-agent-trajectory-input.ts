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

interface ConverterModule {
  convertTrajectory(
    json: TrajectoryJson,
    opts?: { seenStepNumbers?: Set<number>; sessionReset?: boolean },
  ): { entries: AgentActivityEntry[]; emittedStepNumbers: number[] };
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
}

/**
 * Polls a trae-agent trajectory JSON file (overwritten each cycle by
 * `TrajectoryRecorder.save_trajectory`) and emits a 5-layer ENTRY → AGENT →
 * STEP → {LLM_CALL, TOOL*} span tree. The ENTRY/AGENT/STEP layers are
 * synthesized by the OTLP converter library from the LLM/TOOL records'
 * gen_ai.session.id / gen_ai.step.id / gen_ai.agent.type fields; the
 * converter mjs here only emits llm.request/llm.response/tool.call/
 * tool.result records.
 *
 * Conversion logic lives in `assets/hooks/trae-agent/trajectory-converter.mjs`
 * so the same code backs the runtime input and the standalone smoke-test CLI.
 * trae-agent has no shell hook (deployMode "log-watch"); the path is retained
 * to align with the existing per-agent asset directory convention.
 */
export class TraeAgentTrajectoryInput extends BaseTrajectoryPollingInput {
  readonly id = AGENT_ID;
  readonly agentType = ClientType.TraeAgent;

  private readonly converterPath: string;
  private converter: ConverterModule | null = null;

  constructor(opts: TraeAgentTrajectoryOptions) {
    super(opts);
    this.converterPath = opts.converterPath;
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_TRAJECTORY_DIR));
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_TRAJECTORY_DIR)];
  }

  static resolveDefaultTrajectoryFile(): string {
    return path.join(resolveHome(DEFAULT_TRAJECTORY_DIR), 'trajectory.json');
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
  ): Promise<{ entries: AgentActivityEntry[]; emittedStepNumbers: number[] }> {
    if (!this.converter) {
      throw new Error('trajectory converter not loaded');
    }
    return this.converter.convertTrajectory(json, {
      seenStepNumbers: ctx.seenStepNumbers,
      sessionReset: ctx.sessionReset,
    });
  }
}

export type { TrajectoryPollingOptions };
