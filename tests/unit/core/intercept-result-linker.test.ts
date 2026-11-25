import { describe, expect, it, vi } from 'vitest';
import { InterceptResultLinker } from '../../../src/core/intercept-result-linker.js';
import { ToolVerdictStore } from '../../../src/interceptor/tool-verdict-store.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function toolEntry(event: 'tool.call' | 'tool.result', overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    'event.name': event,
    'gen_ai.agent.type': 'qoder',
    'gen_ai.session.id': 's1',
    'gen_ai.tool.call.id': 'call-1',
    ...overrides,
  } as AgentActivityEntry;
}

function storeWith(records: Array<Parameters<ToolVerdictStore['put']>[0] & { action: 'allow' | 'block' }>): ToolVerdictStore {
  const store = new ToolVerdictStore('/tmp/unused-tool-verdicts.json');
  for (const record of records) store.put(record, record.action);
  return store;
}

describe('InterceptResultLinker', () => {
  it('stamps an allowed audit match with its metadata and separate fail-open state', () => {
    const store = new ToolVerdictStore('/tmp/unused-tool-verdicts.json');
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, {
      action: 'log', failOpen: true, ruleId: 'audit', ruleVersion: '2',
    });
    const entry = toolEntry('tool.call');
    new InterceptResultLinker(store, true).enrich([entry]);
    expect(entry).toMatchObject({ 'gen_ai.guardrail.triggered': true,
      'gen_ai.guardrail.action': 'log', 'gen_ai.guardrail.fail_open': true,
      'gen_ai.guardrail.rule_id': 'audit', 'gen_ai.guardrail.rule_version': '2' });
    expect(entry).not.toHaveProperty('gen_ai.guardrail.matched');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.enforcement');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.reason');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.severity');
  });
  it('waits for IPC only for supported tool batches and enriches the resulting mirror', async () => {
    const store = new ToolVerdictStore('/tmp/unused-tool-verdicts.json');
    const barrier = vi.fn(async () => {
      store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, 'block');
    });
    const linker = new InterceptResultLinker(store, true, barrier);
    await linker.sync([toolEntry('tool.call', { 'gen_ai.agent.type': 'codex' })]);
    expect(barrier).not.toHaveBeenCalled();
    const entries = [toolEntry('tool.call')];
    await linker.sync(entries);
    linker.enrich(entries);
    expect(barrier).toHaveBeenCalledOnce();
    expect(entries[0]['gen_ai.guardrail.action']).toBe('block');
  });
  it.each(['qoder', 'qoder-app', 'qoder-cn'])('maps %s tool.call to PreToolUse and tool.result to PostToolUse', agentType => {
    const store = storeWith([
      { sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse', action: 'allow' },
      { sessionId: 's1', toolUseId: 'call-1', phase: 'PostToolUse', action: 'block' },
    ]);
    const entries = [toolEntry('tool.call', { 'gen_ai.agent.type': agentType }),
      toolEntry('tool.result', { 'gen_ai.agent.type': agentType })];

    new InterceptResultLinker(store, true).enrich(entries);

    expect(entries[0]['gen_ai.guardrail.triggered']).toBe(true);
    expect(entries[0]['gen_ai.guardrail.action']).toBe('allow');
    expect(entries[1]['gen_ai.guardrail.triggered']).toBe(true);
    expect(entries[1]['gen_ai.guardrail.action']).toBe('block');
  });

  it('copies the stored rule snapshot onto a blocked tool event', () => {
    const store = new ToolVerdictStore('/tmp/unused-tool-verdicts.json');
    store.put(
      { sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' },
      {
        action: 'block',
        ruleId: 'flow-probe',
        ruleVersion: '3',
      },
    );
    const entry = toolEntry('tool.call');
    new InterceptResultLinker(store, true).enrich([entry]);
    expect(entry['gen_ai.guardrail.rule_id']).toBe('flow-probe');
    expect(entry['gen_ai.guardrail.rule_version']).toBe('3');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.reason');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.severity');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.title');
    expect(entry).not.toHaveProperty('gen_ai.guardrail.message');
  });

  it('omits guardrail fields when the record is missing and skips other agents', () => {
    const store = storeWith([
      { sessionId: 'open-session', toolUseId: 'call-2', phase: 'PreToolUse', action: 'block' },
    ]);
    const matching = toolEntry('tool.call', {
      'gen_ai.agent.type': 'openclaw',
      'gen_ai.session.id': 'open-session',
      'gen_ai.tool.call.id': 'call-2',
    });
    const wrongSession = toolEntry('tool.call', {
      'gen_ai.agent.type': 'openclaw',
      'gen_ai.session.id': 'other',
      'gen_ai.tool.call.id': 'call-2',
    });
    const unsupported = toolEntry('tool.call', {
      'gen_ai.agent.type': 'codex',
      'gen_ai.tool.call.id': 'call-2',
    });
    const qoderWork = toolEntry('tool.call', {
      'gen_ai.agent.type': 'qoder-work',
      'gen_ai.session.id': 'open-session',
      'gen_ai.tool.call.id': 'call-2',
    });

    new InterceptResultLinker(store, true).enrich([matching, wrongSession, unsupported, qoderWork]);

    expect(matching['gen_ai.guardrail.action']).toBe('block');
    expect(wrongSession['gen_ai.guardrail.triggered']).toBeUndefined();
    expect(wrongSession['gen_ai.guardrail.action']).toBeUndefined();
    expect(unsupported['gen_ai.guardrail.triggered']).toBeUndefined();
    expect(unsupported['gen_ai.guardrail.action']).toBeUndefined();
    expect(qoderWork['gen_ai.guardrail.triggered']).toBeUndefined();
    expect(qoderWork['gen_ai.guardrail.action']).toBeUndefined();
  });

  it('omits guardrail fields when the tool call id or record is missing', () => {
    const store = storeWith([
      { sessionId: 's1', toolUseId: 'present', phase: 'PreToolUse', action: 'block' },
    ]);
    const missingId = toolEntry('tool.call', {
      'gen_ai.agent.type': 'qwen-work-cn',
      'gen_ai.tool.call.id': undefined,
    });
    const missingRecord = toolEntry('tool.call', {
      'gen_ai.agent.type': 'qwen-work-cn',
      'gen_ai.tool.call.id': 'absent',
    });
    const idea = toolEntry('tool.call', {
      'gen_ai.agent.type': 'qoder-idea',
      'gen_ai.tool.call.id': 'present',
    });

    new InterceptResultLinker(store, true).enrich([missingId, missingRecord, idea]);

    expect(missingId['gen_ai.guardrail.triggered']).toBeUndefined();
    expect(missingId['gen_ai.guardrail.action']).toBeUndefined();
    expect(missingRecord['gen_ai.guardrail.triggered']).toBeUndefined();
    expect(missingRecord['gen_ai.guardrail.action']).toBeUndefined();
    expect(idea['gen_ai.guardrail.action']).toBe('block');
  });

  it('writes nothing when interceptor is disabled', () => {
    const store = storeWith([
      { sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse', action: 'block' },
    ]);
    const entry = toolEntry('tool.call');
    new InterceptResultLinker(store, false).enrich([entry]);
    expect(entry['gen_ai.guardrail.triggered']).toBeUndefined();
    expect(entry['gen_ai.guardrail.action']).toBeUndefined();
  });
});
