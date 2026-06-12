import { describe, expect, it } from 'vitest';

import { maskAgentActivityEntry } from '../../../src/mask/entry-masker.js';
import type { AgentActivityEntry, MaskConfig } from '../../../src/types/index.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

describe('agent activity entry masker', () => {
  const allConfig: MaskConfig = { mode: 'all', types: [] };

  it('masks only collector whitelist fields before flusher dispatch', () => {
    const rawSecret = 'AKIAIOSFODNN7EXAMPLE';
    const entry = buildTestEntry({
      'gen_ai.input.messages': [{ role: 'user', content: `use ${rawSecret}` }],
      'workspace.current_root': `/tmp/${rawSecret}`,
    }) as AgentActivityEntry;

    const masked = maskAgentActivityEntry(entry, allConfig);

    expect(masked['gen_ai.input.messages']).toEqual([
      { role: 'user', content: 'use [ACCESSKEY_MASKED]' },
    ]);
    expect(masked['workspace.current_root']).toBe(`/tmp/${rawSecret}`);
    expect(entry['gen_ai.input.messages']).toEqual([
      { role: 'user', content: `use ${rawSecret}` },
    ]);
  });

  it('does not mask non-content metadata fields', () => {
    const rawSecret = 'AKIAIOSFODNN7EXAMPLE';
    const entry = buildTestEntry({
      'user.id': rawSecret,
      'service.name': `service-${rawSecret}`,
      'resource.attributes': { cloud: rawSecret },
      'process.command_line': `pilot --token ${rawSecret}`,
      'gen_ai.request.model': `model-${rawSecret}`,
      'gen_ai.session.id': `session-${rawSecret}`,
      'event.id': `event-${rawSecret}`,
    }) as AgentActivityEntry;

    const masked = maskAgentActivityEntry(entry, allConfig);

    expect(masked['user.id']).toBe(rawSecret);
    expect(masked['service.name']).toBe(`service-${rawSecret}`);
    expect(masked['resource.attributes']).toEqual({ cloud: rawSecret });
    expect(masked['process.command_line']).toBe(`pilot --token ${rawSecret}`);
    expect(masked['gen_ai.request.model']).toBe(`model-${rawSecret}`);
    expect(masked['gen_ai.session.id']).toBe(`session-${rawSecret}`);
    expect(masked['event.id']).toBe(`event-${rawSecret}`);
    expect(JSON.stringify(masked)).not.toContain('[ACCESSKEY_MASKED]');
  });

  it('respects custom mask categories', () => {
    const config: MaskConfig = { mode: 'custom', types: ['apiKey'] };
    const accessKey = 'LTAI1234567890ABCD';
    const apiKey = 'sk-1234567890abcdefghijklmnop';
    const entry = buildTestEntry({
      'gen_ai.tool.call.arguments': `ak=${accessKey} key=${apiKey}`,
    }) as AgentActivityEntry;

    const masked = maskAgentActivityEntry(entry, config);

    expect(masked['gen_ai.tool.call.arguments']).toContain(accessKey);
    expect(masked['gen_ai.tool.call.arguments']).toContain('[APIKEY_MASKED]');
    expect(masked['gen_ai.tool.call.arguments']).not.toContain(apiKey);
  });

  it('leaves entries unchanged when mask mode is none', () => {
    const apiKey = 'sk-1234567890abcdefghijklmnop';
    const entry = buildTestEntry({
      'gen_ai.output.messages': [{ role: 'assistant', content: apiKey }],
    }) as AgentActivityEntry;

    const masked = maskAgentActivityEntry(entry, { mode: 'none', types: [] });

    expect(masked).toEqual(entry);
  });

  it('returns the original entry reference when no rules are enabled', () => {
    const entry = buildTestEntry({
      'gen_ai.output.messages': [{ role: 'assistant', content: 'hello' }],
    }) as AgentActivityEntry;

    const masked = maskAgentActivityEntry(entry, { mode: 'none', types: [] });

    expect(masked).toBe(entry);
  });

  it('returns the original entry reference when enabled rules make no changes', () => {
    const entry = buildTestEntry({
      'gen_ai.output.messages': [{ role: 'assistant', content: 'plain content' }],
    }) as AgentActivityEntry;

    const masked = maskAgentActivityEntry(entry, allConfig);

    expect(masked).toBe(entry);
  });

  it('stops recursive traversal after the max mask depth', () => {
    const apiKey = 'sk-1234567890abcdefghijklmnop';
    let nested: Record<string, unknown> = { content: apiKey };
    for (let depth = 0; depth < 40; depth += 1) {
      nested = { child: nested };
    }
    const entry = buildTestEntry({
      'gen_ai.tool.call.arguments': nested,
    }) as AgentActivityEntry;

    const masked = maskAgentActivityEntry(entry, allConfig);

    expect(JSON.stringify(masked)).toContain(apiKey);
    expect(masked).toBe(entry);
  });

  it('still masks normally nested values within the max mask depth', () => {
    const apiKey = 'sk-1234567890abcdefghijklmnop';
    const entry = buildTestEntry({
      'gen_ai.tool.call.arguments': {
        request: {
          body: {
            content: apiKey,
          },
        },
      },
    }) as AgentActivityEntry;

    const masked = maskAgentActivityEntry(entry, allConfig);

    expect(JSON.stringify(masked)).toContain('[APIKEY_MASKED]');
    expect(JSON.stringify(masked)).not.toContain(apiKey);
  });
});
