import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

export class ClaudeCodeLogInput extends BaseHookInput {
  readonly id = 'claude-code-log';
  readonly agentType = ClientType.ClaudeCliHook;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/claude-code'),
      logPrefix: opts?.logPrefix ?? 'claude-code',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/claude-code'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/claude-code')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.ClaudeCliHook, 'claude-code');
  }
}
