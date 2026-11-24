import { ClientType, type AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';

const EVENT_NAMES = new Set(['other', 'llm.request', 'llm.response', 'tool.call', 'tool.result']);

/**
 * Opt-in input for canonical turns written by an explicitly configured Strands adapter.
 * Each source file is an immutable, newline-terminated BaseHookInput segment.
 */
export class StrandsHarnessInput extends BaseHookInput {
  readonly id = ClientType.StrandsHarness;
  readonly agentType = ClientType.StrandsHarness;

  constructor(options: Pick<HookInputOptions, 'stateStore' | 'logDir' | 'pollIntervalMs'>) {
    super({ ...options, logPrefix: ClientType.StrandsHarness, historyReplay: {} });
  }

  protected async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    if (record['gen_ai.agent.type'] !== this.agentType
      || typeof record['event.name'] !== 'string'
      || !EVENT_NAMES.has(record['event.name'])
      || typeof record['event.id'] !== 'string'
      || !record['event.id']
      || typeof record['gen_ai.session.id'] !== 'string'
      || !record['gen_ai.session.id']
      || typeof record['gen_ai.turn.id'] !== 'string'
      || !record['gen_ai.turn.id']
      || typeof record.time_unix_nano !== 'string'
      || !/^[1-9]\d{18}$/.test(record.time_unix_nano)) {
      return null;
    }

    const entry = buildCanonicalHookEntry({ ...record, 'gen_ai.framework': 'strands' }, this.agentType);
    if (entry) {
      // The canonical helper's fallback for legacy producers is not SDK evidence.
      for (const key of ['gen_ai.request.model', 'gen_ai.response.model'] as const) {
        if (typeof record[key] !== 'string' || !record[key]) delete entry[key];
      }
    }
    return entry;
  }
}
