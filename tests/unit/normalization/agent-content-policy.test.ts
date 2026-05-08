import { describe, it, expect } from 'vitest';
import { applyAgentContentPolicy } from '../../../src/normalization/agent-content-policy.js';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry, AgentsConfig } from '../../../src/types/index.js';

function makeEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    time_unix_nano: '1700000000000000000',
    'event.id': 'event-1',
    'event.name': 'tool.result',
    'user.id': 'user-1',
    'gen_ai.session.id': 'session-1',
    'gen_ai.agent.type': ClientType.Cursor,
    'gen_ai.provider.name': 'openai',
    'gen_ai.request.model': 'gpt-5.5',
    'gen_ai.usage.input_tokens': 12,
    'gen_ai.input.messages': [{ role: 'user', content: 'secret prompt' }],
    'gen_ai.input.messages_delta': [{ role: 'user', content: 'secret delta' }],
    'gen_ai.output.messages': [{ type: 'text', content: 'secret response' }],
    'gen_ai.tool.call.arguments': { command: 'cat secret.txt' },
    'gen_ai.tool.call.result': { output: 'secret output' },
    content: 'legacy secret',
    inlineDiffMessage: 'legacy diff',
    'agent.content': 'agent secret',
    'agent.inline_diff_message': 'agent diff',
    'agent.file_path': '/workspace/app.ts',
    ...overrides,
  };
}

describe('applyAgentContentPolicy', () => {
  it('preserves content fields when message content capture is enabled', () => {
    const entry = makeEntry();
    const result = applyAgentContentPolicy(entry, {
      [ClientType.Cursor]: { captureMessageContent: true },
    });

    expect(result).not.toBe(entry);
    expect(result['gen_ai.input.messages']).toEqual(entry['gen_ai.input.messages']);
    expect(result['gen_ai.tool.call.result']).toEqual(entry['gen_ai.tool.call.result']);
    expect(result.content).toBe('legacy secret');
    expect(result['agent.content']).toBe('agent secret');
  });

  it('deletes content fields when message content capture is disabled', () => {
    const result = applyAgentContentPolicy(makeEntry(), {
      [ClientType.Cursor]: { captureMessageContent: false },
    });

    expect(result).not.toHaveProperty('gen_ai.input.messages');
    expect(result).not.toHaveProperty('gen_ai.input.messages_delta');
    expect(result).not.toHaveProperty('gen_ai.output.messages');
    expect(result).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(result).not.toHaveProperty('gen_ai.tool.call.result');
    expect(result).not.toHaveProperty('content');
    expect(result).not.toHaveProperty('inlineDiffMessage');
    expect(result).not.toHaveProperty('agent.content');
    expect(result).not.toHaveProperty('agent.inline_diff_message');
  });

  it('retains non-content metadata when message content capture is disabled', () => {
    const result = applyAgentContentPolicy(makeEntry(), {
      [ClientType.Cursor]: { captureMessageContent: false },
    });

    expect(result['event.name']).toBe('tool.result');
    expect(result['gen_ai.agent.type']).toBe(ClientType.Cursor);
    expect(result['gen_ai.session.id']).toBe('session-1');
    expect(result['gen_ai.request.model']).toBe('gpt-5.5');
    expect(result['gen_ai.usage.input_tokens']).toBe(12);
    expect(result['agent.file_path']).toBe('/workspace/app.ts');
  });

  it('does not mutate the input entry', () => {
    const entry = makeEntry();
    applyAgentContentPolicy(entry, {
      [ClientType.Cursor]: { captureMessageContent: false },
    });

    expect(entry['gen_ai.input.messages']).toBeDefined();
    expect(entry['gen_ai.tool.call.result']).toBeDefined();
    expect(entry['agent.content']).toBe('agent secret');
  });

  it('uses fail-open defaults for missing agent policy', () => {
    const result = applyAgentContentPolicy(makeEntry(), {});

    expect(result['gen_ai.input.messages']).toBeDefined();
    expect(result['gen_ai.tool.call.result']).toBeDefined();
  });

  it('ignores unsupported agent config fields for this stage', () => {
    const config = {
      [ClientType.Cursor]: {
        captureMessageContent: true,
        unknownFutureOption: true,
      },
    } as unknown as AgentsConfig;

    const result = applyAgentContentPolicy(makeEntry(), config);

    expect(result['gen_ai.input.messages']).toEqual([{ role: 'user', content: 'secret prompt' }]);
    expect(result['gen_ai.tool.call.result']).toEqual({ output: 'secret output' });
  });

  it('uses legacy agent.type as policy lookup fallback', () => {
    const result = applyAgentContentPolicy(makeEntry({
      'gen_ai.agent.type': undefined,
      'agent.type': ClientType.Cursor,
      'input.messages': [{ role: 'user', content: 'legacy secret' }],
    }), {
      [ClientType.Cursor]: { captureMessageContent: false },
    });

    expect(result).not.toHaveProperty('input.messages');
  });
});
