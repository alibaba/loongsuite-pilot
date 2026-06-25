import { describe, expect, it } from 'vitest';
import { ClientType } from '../../../../src/types/index.js';
import { buildCanonicalHookEntry } from '../../../../src/inputs/base/canonical-hook-record.js';
import { transformHookRecord } from '../../../../src/inputs/base/hook-record-transform.js';

describe('hook record resource attribute passthrough', () => {
  it('preserves resourceAttributes in generic hook transform', async () => {
    const entry = await transformHookRecord({
      'event.id': 'event-1',
      'event.name': 'llm.response',
      'gen_ai.session.id': 'session-1',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.response.finish_reasons': ['stop'],
      resourceAttributes: {
        'agentteams.worker.name': 'local-worker',
        'agentteams.instance.id': 'example-instance',
      },
    }, ClientType.ClaudeCliHook, 'claude-code');

    expect(entry).toMatchObject({
      resourceAttributes: {
        'agentteams.worker.name': 'local-worker',
        'agentteams.instance.id': 'example-instance',
      },
    });
  });

  it('preserves resourceAttributes in canonical hook transform', () => {
    const entry = buildCanonicalHookEntry({
      'event.id': 'event-2',
      'event.name': 'llm.response',
      'gen_ai.session.id': 'session-2',
      'gen_ai.agent.type': 'claude-code',
      resourceAttributes: {
        'agentteams.worker.name': 'local-worker',
        'agentteams.instance.id': 'example-instance',
      },
    }, ClientType.ClaudeCliHook);

    expect(entry).toMatchObject({
      resourceAttributes: {
        'agentteams.worker.name': 'local-worker',
        'agentteams.instance.id': 'example-instance',
      },
    });
  });
});
