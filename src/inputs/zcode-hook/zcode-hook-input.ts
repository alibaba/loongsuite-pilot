import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

/**
 * Tail JSONL files written by assets/hooks/zcode-hook-processor.mjs.
 *
 * Records are ENTRY/AGENT envelopes emitted from the zcode Stop hook stdin
 * payload — they contain sessionId/turnId/traceId boundary metadata but NO
 * gen_ai.input/output.messages (those come from ZCodeRolloutInput reading
 * ~/.zcode/cli/rollout/model-io-sess_*.jsonl). The two inputs feed the
 * flusher independently; cross-source parent linking happens by trace_id +
 * gen_ai.session.id + gen_ai.turn.id.
 *
 * Records already use canonical `gen_ai.*` dotted fields, so we delegate
 * straight to the shared transformHookRecord (same pattern as QwenCodeCliLog
 * and CodexLog inputs).
 */
export class ZCodeHookInput extends BaseHookInput {
  readonly id = 'zcode-hook';
  readonly agentType = ClientType.ZCode;

  constructor(opts: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts.stateStore,
      logDir: opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/zcode'),
      logPrefix: opts.logPrefix ?? 'zcode',
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/zcode'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/zcode')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.ZCode, 'zcode');
  }
}
