import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { transformHookRecord } from '../base/hook-record-transform.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';

const DEFAULT_PILOT_DATA_DIR = '~/.loongsuite-pilot';

export type PiCodingAgentLogInputOptions =
  Omit<Partial<HookInputOptions>, 'stateStore'>
  & Pick<HookInputOptions, 'stateStore'>
  & { dataDir?: string };

export function resolvePiCodingAgentLogDir(dataDir?: string): string {
  const resolvedDataDir = resolveHome(
    dataDir || process.env.LOONGSUITE_PILOT_DATA_DIR || DEFAULT_PILOT_DATA_DIR,
  );
  return path.join(resolvedDataDir, 'logs', 'pi-coding-agent');
}

export async function ensurePiCodingAgentLogDir(logDir: string): Promise<void> {
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(logDir, 0o700);
}

export class PiCodingAgentLogInput extends BaseHookInput {
  readonly id = 'pi-coding-agent-log';
  readonly agentType = ClientType.PiCodingAgent;

  constructor(opts: PiCodingAgentLogInputOptions) {
    if (!opts?.stateStore) {
      throw new TypeError('PiCodingAgentLogInput requires a stateStore');
    }
    super({
      stateStore: opts.stateStore,
      logDir: opts.logDir ?? resolvePiCodingAgentLogDir(opts.dataDir),
      logPrefix: opts.logPrefix ?? 'pi-coding-agent',
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(dataDir?: string): Promise<boolean> {
    return directoryExists(resolvePiCodingAgentLogDir(dataDir));
  }

  static getWatchPaths(dataDir?: string): string[] {
    return [resolvePiCodingAgentLogDir(dataDir)];
  }

  protected override async onStart(): Promise<void> {
    await ensurePiCodingAgentLogDir(this.logDir);
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.PiCodingAgent, 'pi-coding-agent');
  }
}
