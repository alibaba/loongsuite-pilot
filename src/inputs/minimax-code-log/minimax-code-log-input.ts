import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

/**
 * MiniMax Code hook JSONL tail input.
 *
 * Mirrors MimoCodeLogInput / ZcodeLogInput: reads event_t records emitted by
 * assets/hooks/minimax-code-hook-processor.mjs and converts each into a
 * normalized AgentActivityEntry through the shared transformHookRecord.
 *
 * Detection: ~/.loongsuite-pilot/logs/minimax-code/ is pre-created at
 * startup (orchestrator) so fs.watch succeeds immediately after install,
 * matching the opencode/mimo-code pattern.
 *
 * Sibling input: MinimaxCodeRolloutInput reads ~/.minimax-code/rollout/*.jsonl
 * to backfill per-LLM llm.request/llm.response pairs that the hook stream
 * alone cannot provide (the hook only fires on lifecycle boundaries, not per
 * LLM step). See docs/agent-onboarding.md "Reliable Hybrid Collection".
 */
export class MinimaxCodeLogInput extends BaseHookInput {
  readonly id = 'minimax-code-log';
  readonly agentType = ClientType.MiniMaxCode;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/minimax-code'),
      logPrefix: opts?.logPrefix ?? 'minimax-code',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/minimax-code'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/minimax-code')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.MiniMaxCode, 'minimax-code');
  }
}
