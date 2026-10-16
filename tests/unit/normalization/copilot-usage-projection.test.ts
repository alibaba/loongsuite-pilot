import { describe, expect, it } from 'vitest';
import { projectLogEntry, serialiseLogEntry } from '../../../src/normalization/entry-builder.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function entry(agentType: string, extra: Record<string, string | number>): AgentActivityEntry {
  return {
    time_unix_nano: '1700000000000000000',
    'event.id': 'e-1',
    'event.name': 'other',
    'user.id': 'u-1',
    'gen_ai.session.id': 's-1',
    'gen_ai.agent.type': agentType,
    'gen_ai.provider.name': 'p',
    ...extra,
  };
}

const usage = {
  'agent.copilot.usage.scope': 'session',
  'agent.copilot.usage.source': 'checkpoint',
  'agent.copilot.usage.nano_aiu': 12345,
  'agent.copilot.usage.premium_requests': 1,
  'agent.copilot.usage.turn_id': 'i-1',
  'agent.copilot.usage.reasoning_tokens': 7,
  'agent.copilot.usage.model_nano_aiu': 99,
};

describe('Copilot usage keys in log outputs', () => {
  it('survive the JSONL/SLS projection for a copilot entry', () => {
    const out = projectLogEntry(entry('copilot', usage), { dropAgentScopedFields: true });
    for (const [key, value] of Object.entries(usage)) expect(out[key]).toBe(value);
  });

  it('stay strings and numbers as serialised for string-only sinks', () => {
    const out = serialiseLogEntry(entry('copilot', usage), { dropAgentScopedFields: true });
    expect(out['agent.copilot.usage.nano_aiu']).toBe('12345');
    expect(out['agent.copilot.usage.source']).toBe('checkpoint');
  });

  it('are still dropped when the entry is not a copilot entry', () => {
    const out = projectLogEntry(entry('qoder', usage), { dropAgentScopedFields: true });
    expect(Object.keys(out).filter(k => k.startsWith('agent.'))).toEqual([]);
  });

  it('do not open the filter for other copilot-scoped keys', () => {
    const out = projectLogEntry(entry('copilot', {
      'agent.copilot.internal.secret': 'x',
      'agent.copilot.usage.nested.deeper': 'y',
      'agent.other.usage.nano_aiu': 1,
    }), { dropAgentScopedFields: true });
    expect(Object.keys(out).filter(k => k.startsWith('agent.'))).toEqual([]);
  });
});
