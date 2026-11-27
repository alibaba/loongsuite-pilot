import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';
import { DEFAULT_POLL_INTERVAL_MS } from '../../utils/poll-interval.js';

const execFileAsync = promisify(execFile);
const DRAIN_TIMEOUT_MS = 20_000;

interface ClaudeCodeLogOptions extends Partial<HookInputOptions> {
  stateStore: HookInputOptions['stateStore'];
  dataDir?: string;
}

export class ClaudeCodeLogInput extends BaseHookInput {
  readonly id = 'claude-code-log';
  readonly agentType = ClientType.ClaudeCliHook;

  constructor(opts: ClaudeCodeLogOptions) {
    super({
      stateStore: opts.stateStore,
      logDir: opts.logDir ?? path.join(opts.dataDir ?? resolveHome('~/.loongsuite-pilot'), 'logs', 'claude-code'),
      logPrefix: opts.logPrefix ?? 'claude-code',
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    });
    this.dataDir = opts.dataDir ?? resolveHome('~/.loongsuite-pilot');
  }

  private readonly dataDir: string;
  private nextDrainWarningAt = 0;

  static pendingStopsDir(dataDir: string): string {
    return path.join(dataDir, 'state', 'claude-code', 'pending-stops');
  }

  static async checkAvailability(): Promise<boolean> {
    for (const dir of ClaudeCodeLogInput.getWatchPaths()) {
      if (await directoryExists(dir)) return true;
    }
    return false;
  }

  static getWatchPaths(): string[] {
    const dataDir = resolveHome('~/.loongsuite-pilot');
    return [path.join(dataDir, 'logs', 'claude-code'), ClaudeCodeLogInput.pendingStopsDir(dataDir)];
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    try {
      const stops = await readdir(ClaudeCodeLogInput.pendingStopsDir(this.dataDir));
      if (stops.some((name) => name.endsWith('.json'))) {
        await execFileAsync(process.execPath, [path.join(this.dataDir, 'hooks', 'claude-code-hook-processor.mjs'), 'drain-stops'], {
          env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: this.dataDir },
          timeout: DRAIN_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: 32 * 1024,
          windowsHide: true,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && Date.now() >= this.nextDrainWarningAt) {
        this.nextDrainWarningAt = Date.now() + 60_000;
        this.logger.warn('Claude Code pending Stop processing failed', {
          code: (error as NodeJS.ErrnoException).code,
        });
      }
    }
    return super.collect();
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.ClaudeCliHook, 'claude-code', { preserveInvocationAttributes: true });
  }
}
