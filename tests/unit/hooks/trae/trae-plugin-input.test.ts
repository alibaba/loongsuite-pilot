import { describe, expect, it } from 'vitest';
import { TraePluginInput } from '../../../../src/inputs/trae-plugin/trae-plugin-input.js';
import { ClientType } from '../../../../src/types/client-type.js';

describe('TraePluginInput', () => {
  it('exposes the correct id + agentType', () => {
    const input = new TraePluginInput({
      stateStore: { load: () => ({}), save: () => {} } as any,
    });
    expect(input.id).toBe('trae-plugin');
    expect(input.agentType).toBe(ClientType.Trae);
  });

  it('defaults logDir + logPrefix to the trae namespace', () => {
    const input = new TraePluginInput({
      stateStore: { load: () => ({}), save: () => {} } as any,
    });
    // logDir/logPrefix are protected on BaseHookInput; read via cast.
    const anyInput = input as any;
    expect(anyInput.logDir).toContain('logs/trae');
    expect(anyInput.logPrefix).toBe('trae');
  });

  it('respects caller-provided logDir override', () => {
    const input = new TraePluginInput({
      stateStore: { load: () => ({}), save: () => {} } as any,
      logDir: '/tmp/trae-test-logs',
      logPrefix: 'trae-test',
    });
    const anyInput = input as any;
    expect(anyInput.logDir).toBe('/tmp/trae-test-logs');
    expect(anyInput.logPrefix).toBe('trae-test');
  });

  it('transforms a basic llm.request record via transformHookRecord', async () => {
    const input = new TraePluginInput({
      stateStore: { load: () => ({}), save: () => {} } as any,
    });
    const record = {
      'event.name': 'llm.request',
      'event.id': 'evt-1',
      time_unix_nano: '1794393000000000000',
      'gen_ai.session.id': 'conv-1',
      'gen_ai.turn.id': 'sess-1',
      'gen_ai.step.id': 'msg-1',
      'gen_ai.request.model': 'claude-3-7-sonnet',
      'gen_ai.agent.type': 'trae',
    };
    const entry = await (input as any).transformRecord(record);
    expect(entry).not.toBeNull();
    expect((entry as any)['gen_ai.session.id']).toBe('conv-1');
    expect((entry as any)['gen_ai.request.model']).toBe('claude-3-7-sonnet');
    expect((entry as any)['gen_ai.agent.type']).toBe(ClientType.Trae);
  });
});
