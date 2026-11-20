import { describe, expect, it } from 'vitest';
import {
  buildLlmBoundaries, buildEventsFromBoundaries,
} from '../../assets/hooks/qoder-hook-processor.mjs';
import { processTranscript } from '../../assets/hooks/qwen-work-cn-hook-processor.mjs';
import { InterceptResultLinker } from '../../src/core/intercept-result-linker.js';
import { promptHash, promptRequestId, PROMPT_CORRELATION_FIELD } from '../../src/interceptor/prompt-verdict.js';
import { ToolVerdictStore } from '../../src/interceptor/tool-verdict-store.js';
import { projectLogEntry } from '../../src/normalization/entry-builder.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

const text = 'synthetic repeated prompt';

function nativeEvents(agent: string, id: string | undefined, at: number, turn = 'turn-1'): AgentActivityEntry[] {
  const rows = [
    { type: 'user', uuid: `${turn}:user`, sessionId: 'session-1', promptId: turn,
      requestSetId: id, humanInput: { text, mode: 'prompt' }, timestamp: new Date(at).toISOString(),
      message: { role: 'user', content: text } },
    { type: 'assistant', uuid: `${turn}:assistant`, sessionId: 'session-1', timestamp: new Date(at + 1).toISOString(),
      message: { role: 'assistant', id: `${turn}:response`, model: 'synthetic-model',
        content: [{ type: 'text', text: 'synthetic answer' }], stop_reason: 'end_turn' } },
  ];
  return (agent === 'qoder-cli'
    ? buildEventsFromBoundaries(buildLlmBoundaries([], rows), rows, rows, turn, 'session-1', agent, {}, undefined)
    : processTranscript(rows, 'session-1', {})) as AgentActivityEntry[];
}

describe.each(['qoder-cli', 'qwen-work-cn'])('%s native prompt correlation', agent => {
  it('separates repeated prompts by native requestSetId without exporting the id', () => {
    const now = Date.now();
    const store = new ToolVerdictStore('unused-prompt-native-checkpoint');
    const linker = new InterceptResultLinker(store, true);
    const key = { phase: 'UserPromptSubmit' as const, agentType: agent, sessionId: 'session-1', promptHash: promptHash(text) };
    store.put({ ...key, requestId: promptRequestId('native-first') }, { action: 'log', ruleId: 'first-rule', ruleVersion: '1' }, new Date(now));
    store.put({ ...key, requestId: promptRequestId('native-second') }, { action: 'allow' }, new Date(now + 2));
    for (const [id, action, turn, rule] of [
      ['native-first', 'log', 'turn-1', 'first-rule'],
      ['native-second', 'allow', 'turn-2', undefined],
    ]) {
      const events = nativeEvents(agent, id, now, turn);
      expect(JSON.stringify(events)).not.toContain(id);
      const originalRequestId = events.find(event => event['event.name'] === 'llm.request')?.['gen_ai.request.id'];
      linker.enrich(events);
      const requests = events.filter(event => event['event.name'] === 'llm.request');
      expect(requests).toHaveLength(1);
      expect(requests[0]['gen_ai.guardrail.action']).toBe(action);
      expect(requests[0]['gen_ai.guardrail.rule_id']).toBe(rule);
      expect(requests[0]['gen_ai.request.id']).toBe(originalRequestId);
      expect(events.every(event => !Object.hasOwn(event, PROMPT_CORRELATION_FIELD))).toBe(true);
      const output = JSON.stringify(events.map(event => projectLogEntry(event, { dropAgentScopedFields: true })));
      expect(output).not.toContain('native-first');
      expect(output).not.toContain('native-second');
      expect(output).not.toContain('requestSetId');
      expect(output).not.toContain('request_set_id');
      expect(output).not.toContain('interceptor.correlation');
    }
  });

  it('preserves original event fields and counts when only requestSetId is added', () => {
    const at = Date.now();
    const withId = nativeEvents(agent, 'private-native-id', at);
    const withoutId = nativeEvents(agent, undefined, at);
    const linker = new InterceptResultLinker(new ToolVerdictStore('unused-prompt-native-checkpoint'), true);
    linker.enrich(withId);
    linker.enrich(withoutId);
    const originalFields = (events: AgentActivityEntry[]) => events.map(event => {
      const { 'event.id': _eventId, observed_time_unix_nano: _observed, ...fields } = event;
      return projectLogEntry(fields as AgentActivityEntry, { dropAgentScopedFields: true });
    });
    expect(originalFields(withId)).toEqual(originalFields(withoutId));
    expect(JSON.stringify(withId)).not.toContain('private-native-id');
  });
});
