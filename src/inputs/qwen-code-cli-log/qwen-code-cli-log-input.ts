import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

/**
 * Tail JSONL files written by assets/hooks/qwen-code-cli-hook-processor.mjs
 * (event_t schema, parsed from qwen-code transcript JSONL).
 *
 * Records already use canonical `gen_ai.*` dotted fields, so we delegate
 * straight to the shared transformHookRecord (same pattern as ClaudeCodeLog
 * and CodexLog inputs).
 */
export class QwenCodeCliLogInput extends BaseHookInput {
  readonly id = 'qwen-code-cli-log';
  readonly agentType = ClientType.QwenCodeCli;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qwen-code-cli'),
      logPrefix: opts?.logPrefix ?? 'qwen-code-cli',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/qwen-code-cli'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/qwen-code-cli')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.QwenCodeCli, 'qwen-code-cli');
  }
}
