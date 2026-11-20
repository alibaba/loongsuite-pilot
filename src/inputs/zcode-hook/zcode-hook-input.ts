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

  protected override async collect(): Promise<AgentActivityEntry[]> {
    const records = await super.collect();
    // Older envelopes omitted the ENTRY's turn ID. Recover it only from an
    // unambiguous AGENT pair read in this same batch, with all native IDs.
    const byParent = new Map<string, string | null>();
    const key = (record: AgentActivityEntry, entryId: unknown) => JSON.stringify([
      record['gen_ai.session.id'], record.trace_id, entryId,
    ]);
    for (const record of records) {
      const turnId = record['gen_ai.turn.id'];
      if (record['gen_ai.span.kind'] !== 'agent' || typeof turnId !== 'string' || !turnId
          || !record.parent_span_id || !record.trace_id || !record['gen_ai.session.id']) continue;
      const parent = key(record, record.parent_span_id);
      byParent.set(parent, !byParent.has(parent) || byParent.get(parent) === turnId ? turnId : null);
    }
    for (const record of records) {
      if (record['gen_ai.span.kind'] !== 'entry' || record['gen_ai.turn.id'] || !record.span_id) continue;
      const turnId = byParent.get(key(record, record.span_id));
      if (turnId) record['gen_ai.turn.id'] = turnId;
    }
    return records;
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    // The raw envelope's user is a Pilot fallback, never a native ZCode
    // identity. Resolve it at the same collector boundary as native rollout.
    return transformHookRecord({ ...record, 'user.id': '' }, ClientType.ZCode, 'zcode');
  }
}
