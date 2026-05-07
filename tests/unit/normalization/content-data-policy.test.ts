import { describe, it, expect } from 'vitest';
import { applyContentDataPolicy } from '../../../src/normalization/content-data-policy.js';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry, ContentDataConfig } from '../../../src/types/index.js';

function makeEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    time_unix_nano: '1700000000000000000',
    'event.id': 'event-1',
    'event.name': 'tool.result',
    'user.id': 'user-1',
    'session.id': 'session-1',
    'agent.type': ClientType.Cursor,
    'request.model': 'gpt-5.5',
    'usage.input_tokens': 12,
    'input.messages': [{ role: 'user', content: 'secret prompt' }],
    'input.messages_delta': [{ role: 'user', content: 'secret delta' }],
    'output.messages': [{ type: 'text', content: 'secret response' }],
    'tool.arguments': { command: 'cat secret.txt' },
    'tool.result.payload': { output: 'secret output' },
    content: 'legacy secret',
    inlineDiffMessage: 'legacy diff',
    attributes: {
      content: 'attribute secret',
      inlineDiffMessage: 'attribute diff',
      filePath: '/workspace/app.ts',
    },
    ...overrides,
  };
}

describe('applyContentDataPolicy', () => {
  it('preserves content fields when upload is enabled', () => {
    const entry = makeEntry();
    const result = applyContentDataPolicy(entry, {
      [ClientType.Cursor]: { uploadEnabled: true },
    });

    expect(result).not.toBe(entry);
    expect(result['input.messages']).toEqual(entry['input.messages']);
    expect(result['tool.result.payload']).toEqual(entry['tool.result.payload']);
    expect(result.content).toBe('legacy secret');
    expect(result.attributes?.content).toBe('attribute secret');
  });

  it('deletes content fields when upload is disabled', () => {
    const result = applyContentDataPolicy(makeEntry(), {
      [ClientType.Cursor]: { uploadEnabled: false },
    });

    expect(result).not.toHaveProperty('input.messages');
    expect(result).not.toHaveProperty('input.messages_delta');
    expect(result).not.toHaveProperty('output.messages');
    expect(result).not.toHaveProperty('tool.arguments');
    expect(result).not.toHaveProperty('tool.result.payload');
    expect(result).not.toHaveProperty('content');
    expect(result).not.toHaveProperty('inlineDiffMessage');
    expect(result.attributes).not.toHaveProperty('content');
    expect(result.attributes).not.toHaveProperty('inlineDiffMessage');
  });

  it('retains non-content metadata when upload is disabled', () => {
    const result = applyContentDataPolicy(makeEntry(), {
      [ClientType.Cursor]: { uploadEnabled: false },
    });

    expect(result['event.name']).toBe('tool.result');
    expect(result['agent.type']).toBe(ClientType.Cursor);
    expect(result['session.id']).toBe('session-1');
    expect(result['request.model']).toBe('gpt-5.5');
    expect(result['usage.input_tokens']).toBe(12);
    expect(result.attributes?.filePath).toBe('/workspace/app.ts');
  });

  it('does not mutate the input entry', () => {
    const entry = makeEntry();
    applyContentDataPolicy(entry, {
      [ClientType.Cursor]: { uploadEnabled: false },
    });

    expect(entry['input.messages']).toBeDefined();
    expect(entry['tool.result.payload']).toBeDefined();
    expect(entry.attributes?.content).toBe('attribute secret');
  });

  it('uses fail-open defaults for missing agent policy', () => {
    const result = applyContentDataPolicy(makeEntry(), {});

    expect(result['input.messages']).toBeDefined();
    expect(result['tool.result.payload']).toBeDefined();
  });

  it('ignores unsupported mask and workspace fields for this stage', () => {
    const config = {
      [ClientType.Cursor]: {
        uploadEnabled: true,
        maskEnabled: true,
        excludedWorkspace: ['/workspace'],
      },
    } as unknown as ContentDataConfig;

    const result = applyContentDataPolicy(makeEntry(), config);

    expect(result['input.messages']).toEqual([{ role: 'user', content: 'secret prompt' }]);
    expect(result['tool.result.payload']).toEqual({ output: 'secret output' });
  });
});
