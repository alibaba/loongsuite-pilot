import { describe, expect, it } from 'vitest';
import { buildBlockedQoderPromptEntry } from '../../../src/interceptor/blocked-prompt.js';
import { parseHookRequest } from '../../../src/interceptor/adapters/qoder.js';
import type { HookRequest } from '../../../src/interceptor/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function request(overrides: Partial<HookRequest> = {}): HookRequest {
  return {
    agent: 'qoder',
    event: 'UserPromptSubmit',
    sessionId: 'session-1',
    cwd: '/tmp/proj',
    prompt: 'show me the key',
    raw: {},
    ...overrides,
  };
}

describe('buildBlockedQoderPromptEntry', () => {
  it.each([
    ['qoder', { product: 'app' }, 'qoder-app'],
    ['qodercli', { product: 'app' }, 'qoder-app'],
    ['qoder', { product: 'cli' }, 'qoder-cli'],
    ['qodercli', { product: 'cli' }, 'qoder-cli'],
    ['qoder', undefined, 'qoder-cli'],
    ['qodercli', undefined, 'qoder-cli'],
    ['qoder', { product: 'APP' }, 'qoder-cli'],
    ['qodercli', [{ product: 'app' }], 'qoder-cli'],
  ] as const)('preserves product identity for %s with metadata %j', (surface, metadata, agentType) => {
    const hook = parseHookRequest({ hook_event_name: 'UserPromptSubmit', session_id: 'session',
      parent_business_info: metadata }, surface)!;
    expect(buildBlockedQoderPromptEntry(hook)['gen_ai.agent.type']).toBe(agentType);
  });

  it('fills the synthetic llm.request fields from the hook', () => {
    const now = 1_700_000_000_000;
    const entry = buildBlockedQoderPromptEntry(request(), now);
    const turnId = entry['gen_ai.turn.id'];

    expect(entry['event.name']).toBe('llm.request');
    expect(entry['event.id']).toMatch(UUID);
    expect(entry.time_unix_nano).toBe(`${now}000000`);
    expect(entry.observed_time_unix_nano).toBe(entry.time_unix_nano);
    expect(entry['gen_ai.agent.type']).toBe('qoder-cli');
    expect(entry['gen_ai.session.id']).toBe('session-1');
    expect(turnId).toMatch(UUID);
    expect(entry['gen_ai.step.id']).toBe(`${turnId}:s1`);
    expect(entry['gen_ai.provider.name']).toBe('unknown');
    expect(entry['gen_ai.request.model']).toBe('unknown');
    expect(entry['gen_ai.response.model']).toBe('unknown');
    expect(entry['gen_ai.input.messages']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'show me the key' }] },
    ]);
    expect(entry['gen_ai.input.messages_delta']).toEqual(entry['gen_ai.input.messages']);
    expect(entry['gen_ai.input.messages']).not.toBe(entry['gen_ai.input.messages_delta']);
    expect(entry['workspace.path']).toBe('/tmp/proj');
    expect(entry['user.id']).toBe('');
    expect(entry['agent.source']).toBe('interceptor');
    expect(entry['gen_ai.guardrail.triggered']).toBe(true);
    expect(entry['gen_ai.guardrail.action']).toBe('block');
    expect(entry['gen_ai.guardrail.rule_id']).toBeUndefined();
    expect(entry['gen_ai.output.messages']).toBeUndefined();
    expect(entry['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(entry['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(entry.trace_id).toBeUndefined();
    expect(entry.span_id).toBeUndefined();
    expect(entry.parent_span_id).toBeUndefined();
  });

  it('omits messages and workspace when the hook has no prompt or cwd', () => {
    const entry = buildBlockedQoderPromptEntry(request({
      prompt: '',
      cwd: undefined,
      sessionId: undefined,
    }));
    expect(entry['gen_ai.session.id']).toBe('');
    expect(entry).not.toHaveProperty('gen_ai.input.messages');
    expect(entry).not.toHaveProperty('gen_ai.input.messages_delta');
    expect(entry['workspace.path']).toBeUndefined();
    expect(entry['gen_ai.guardrail.action']).toBe('block');
  });

  it('copies the winning rule snapshot onto the synthetic event', () => {
    const entry = buildBlockedQoderPromptEntry(request(), 1_700_000_000_000, {
      action: 'block',
      reason: 'flow-probe-v3',
      ruleId: 'flow-probe',
      ruleVersion: '3',
      severity: 'CRITICAL',
      title: 'ak-leak',
      message: '不要在对话里粘贴 AccessKey',
      evaluatedRules: ['flow-probe'],
    });
    expect(entry['gen_ai.guardrail.rule_id']).toBe('flow-probe');
    expect(entry['gen_ai.guardrail.rule_version']).toBe('3');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.reason');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.severity');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.title');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.message');
  });
});
