import * as fs from 'node:fs/promises';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { transformHookRecord } from '../base/hook-record-transform.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';

export async function ensurePiCodingAgentLogDir(logDir: string): Promise<void> {
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(logDir, 0o700);
}

export class PiCodingAgentLogInput extends BaseHookInput {
  readonly id = 'pi-coding-agent-log';
  readonly agentType = ClientType.PiCodingAgent;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/pi-coding-agent'),
      logPrefix: opts?.logPrefix ?? 'pi-coding-agent',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/pi-coding-agent'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/pi-coding-agent')];
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
