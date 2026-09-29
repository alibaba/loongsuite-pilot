import { describe, expect, it } from 'vitest';
import { buildCopilotEvents } from '../../../../src/inputs/copilot/copilot-event-builder.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import {
  ev, failedToolTurn, modelErrorTurn, parallelToolTurn, resetFixtureIds, T0, textOnlyTurn, toolTurn,
} from '../../../fixtures/copilot/events.js';

const opts = { sessionId: 's-1' };
const names = (entries: AgentActivityEntry[]) => entries.map(e => e['event.name']);
const usageKeys = (e: AgentActivityEntry) => Object.keys(e).filter(k => k.startsWith('gen_ai.usage.'));

describe('text-only turn', () => {
  const entries = buildCopilotEvents(textOnlyTurn(), opts);
  const [request, response] = entries;

  it('emits one request/response pair', () => {
    expect(names(entries)).toEqual(['llm.request', 'llm.response']);
  });

  it('puts the prompt in the request delta and marks the turn start', () => {
    expect(request['gen_ai.turn.start']).toBe(true);
    expect(request['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hello world' }] },
    ]);
  });

  it('reports requested and answered model separately', () => {
    expect(request['gen_ai.request.model']).toBe('auto');
    expect(response['gen_ai.response.model']).toBe('model-a');
  });

  it('closes the turn with stop and the assistant text', () => {
    expect(response['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(response['gen_ai.turn.end']).toBe(true);
    expect(response['gen_ai.output.messages']).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'hi there' }], finish_reason: 'stop' },
    ]);
  });

  it('carries identity fields and never invents per-call tokens', () => {
    for (const e of entries) {
      expect(e['gen_ai.agent.type']).toBe('copilot');
      expect(e['gen_ai.provider.name']).toBe('github-copilot');
      expect(e['gen_ai.session.id']).toBe('s-1');
      expect(e['gen_ai.turn.id']).toBe('i-1');
      expect(e['workspace.path']).toBe('/work/demo');
      expect(usageKeys(e)).toEqual([]);
    }
  });

  it('is deterministic across replays', () => {
    const again = buildCopilotEvents(textOnlyTurn(), opts);
    expect(again.map(e => e['event.id'])).toEqual(entries.map(e => e['event.id']));
    expect(new Set(entries.map(e => e['event.id'])).size).toBe(entries.length);
  });
});

describe('tool turn', () => {
  const entries = buildCopilotEvents(toolTurn(), opts);

  it('orders request, response, call, result, then the next step', () => {
    expect(names(entries)).toEqual([
      'llm.request', 'llm.response', 'tool.call', 'tool.result', 'llm.request', 'llm.response',
    ]);
  });

  it('marks the tool-requesting response as tool_call without ending the turn', () => {
    const response = entries[1];
    expect(response['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    expect(response['gen_ai.turn.end']).toBeUndefined();
    expect(response['gen_ai.output.messages']).toEqual([{
      role: 'assistant',
      parts: [{ type: 'tool_call', id: 'call-1', name: 'view', arguments: { path: 'a.txt' } }],
      finish_reason: 'tool_call',
    }]);
  });

  it('pairs call and result by id with a positive duration', () => {
    const call = entries[2];
    const result = entries[3];
    expect(call['gen_ai.tool.call.id']).toBe('call-1');
    expect(call['gen_ai.tool.name']).toBe('view');
    expect(call['gen_ai.tool.call.arguments']).toEqual({ path: 'a.txt' });
    expect(result['gen_ai.tool.call.id']).toBe('call-1');
    expect(result['gen_ai.tool.call.result']).toBe('file body');
    expect(result['tool.result.status']).toBe('success');
    expect(result['gen_ai.tool.call.duration']).toBe(200);
  });

  it('feeds the tool result into the next request and ends the turn on the last response', () => {
    expect(entries[4]['gen_ai.turn.start']).toBeUndefined();
    expect(entries[4]['gen_ai.input.messages_delta']).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-1', name: 'view', arguments: { path: 'a.txt' } }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-1', response: 'file body' }] },
    ]);
    expect(entries[5]['gen_ai.turn.end']).toBe(true);
    expect(entries[4]['gen_ai.step.id']).not.toBe(entries[0]['gen_ai.step.id']);
  });
});

describe('parallel tools', () => {
  it('matches out-of-order results by toolCallId', () => {
    const results = buildCopilotEvents(parallelToolTurn(), opts).filter(e => e['event.name'] === 'tool.result');
    expect(results.map(e => [e['gen_ai.tool.call.id'], e['gen_ai.tool.call.result']])).toEqual([
      ['call-b', 'B'], ['call-a', 'A'],
    ]);
    expect(new Set(results.map(e => e['event.id'])).size).toBe(2);
  });
});

describe('failed tool', () => {
  it('reports failure with the error and no result payload', () => {
    const result = buildCopilotEvents(failedToolTurn(), opts).find(e => e['event.name'] === 'tool.result')!;
    expect(result['tool.result.status']).toBe('failure');
    expect(result['error.type']).toBe('tool_execution_failed');
    expect(result['error.message']).toBe('boom');
    expect(result['gen_ai.tool.call.result']).toBeUndefined();
  });
});

describe('model error', () => {
  it('keeps the prompt and reports the failed call as an error response that ends the turn', () => {
    const entries = buildCopilotEvents(modelErrorTurn(), opts);
    expect(names(entries)).toEqual(['llm.request', 'llm.response']);
    const [request, response] = entries;
    expect(request['gen_ai.turn.start']).toBe(true);
    expect(request['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'do it' }] },
    ]);
    expect(response['gen_ai.response.finish_reasons']).toEqual(['error']);
    expect(response['gen_ai.turn.end']).toBe(true);
    expect(response['error.type']).toBe('query');
    expect(response['error.message']).toContain('requested model is not supported');
    expect(response['gen_ai.output.messages']).toBeUndefined();
    expect(response['gen_ai.turn.id']).toBe(request['gen_ai.turn.id']);
  });

  it('fails the round that was waiting after earlier rounds succeeded', () => {
    const entries = buildCopilotEvents(modelErrorTurn(true), opts);
    expect(names(entries)).toEqual([
      'llm.request', 'llm.response', 'tool.call', 'tool.result', 'llm.request', 'llm.response',
    ]);
    const [, , , , request, response] = entries;
    expect(request['gen_ai.turn.start']).toBeUndefined();
    expect(request['gen_ai.input.messages_delta']).toHaveLength(2);
    expect(response['gen_ai.response.finish_reasons']).toEqual(['error']);
    expect(response['gen_ai.turn.end']).toBe(true);
  });

  it('emits nothing for an error outside a turn, and only once per turn', () => {
    resetFixtureIds();
    const idle = [ev('session.error', { errorType: 'x', message: 'm' }, T0)];
    expect(buildCopilotEvents(idle, opts)).toEqual([]);
    const twice = [...modelErrorTurn(), ev('session.error', { errorType: 'x', message: 'again' }, T0 + 61_000)];
    expect(buildCopilotEvents(twice, opts)).toHaveLength(2);
  });

  it('does not add an error to a turn that already ended normally', () => {
    const done = [...textOnlyTurn(), ev('session.error', { errorType: 'x', message: 'late' }, T0 + 9_000)];
    expect(names(buildCopilotEvents(done, opts))).toEqual(['llm.request', 'llm.response']);
  });
});

describe('robustness', () => {
  it('ignores a tool result that has no earlier start', () => {
    resetFixtureIds();
    const orphan = [ev('tool.execution_complete', { toolCallId: 'x', success: true, result: { content: 'r' } }, T0)];
    expect(buildCopilotEvents(orphan, opts)).toEqual([]);
  });

  it('ignores unknown event types and events with invalid timestamps', () => {
    resetFixtureIds();
    const noise = [ev('session.mystery', {}, T0), { ...ev('user.message', { content: 'x' }, T0), timestamp: 'garbage' }];
    expect(buildCopilotEvents(noise, opts)).toEqual([]);
  });

  it('tags subagent steps so they do not corrupt the parent turn', () => {
    resetFixtureIds();
    const events = [
      ev('user.message', { content: 'p', interactionId: 'i-1', messageId: 'm' }, T0),
      ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, T0 + 10),
      ev('assistant.message', {
        messageId: 'am', content: 'sub', model: 'model-a', apiCallId: 'a1', turnId: '0', parentToolCallId: 'parent-1',
      }, T0 + 20),
    ];
    const entries = buildCopilotEvents(events, opts);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e['gen_ai.agent.scope'] === 'subagent')).toBe(true);
  });

  it('falls back to opts models when the span lacks session.start', () => {
    const span = textOnlyTurn().slice(2);
    const entries = buildCopilotEvents(span, { sessionId: 's-1', selectedModel: 'auto', autoModel: 'model-a', cwd: '/work/demo' });
    expect(entries[0]['gen_ai.request.model']).toBe('auto');
    expect(entries[0]['workspace.path']).toBe('/work/demo');
  });
});

describe('native tool result types', () => {
  const withResult = (content: unknown) => {
    const events = toolTurn().map(e => (e.type === 'tool.execution_complete'
      ? { ...e, data: { ...e.data, result: { content } } }
      : e));
    return buildCopilotEvents(events, opts);
  };

  it('turns a JSON-looking string result into a native object', () => {
    const entries = withResult('{"ok":true,"items":[1,2]}');
    const result = entries.find(e => e['event.name'] === 'tool.result')!;
    expect(result['gen_ai.tool.call.result']).toEqual({ ok: true, items: [1, 2] });
    const next = entries.filter(e => e['event.name'] === 'llm.request')[1];
    expect(next['gen_ai.input.messages_delta']).toContainEqual({
      role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-1', response: { ok: true, items: [1, 2] } }],
    });
  });

  it('keeps plain text as a string', () => {
    const plain = withResult('file body').find(e => e['event.name'] === 'tool.result')!;
    expect(plain['gen_ai.tool.call.result']).toBe('file body');
  });

  it('wraps text that starts like JSON but is not valid JSON, keeping every character', () => {
    const truncated = '{\n  "papeis": {\n    "narradora": {\n      "id": "x",';
    const entries = withResult(truncated);
    const result = entries.find(e => e['event.name'] === 'tool.result')!;
    expect(result['gen_ai.tool.call.result']).toEqual({ type: 'text', content: truncated });
    const listing = withResult('[INFO] 3 files').find(e => e['event.name'] === 'tool.result')!;
    expect(listing['gen_ai.tool.call.result']).toEqual({ type: 'text', content: '[INFO] 3 files' });
    const next = entries.filter(e => e['event.name'] === 'llm.request')[1];
    expect(next['gen_ai.input.messages_delta']).toContainEqual({
      role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-1', response: { type: 'text', content: truncated } }],
    });
  });
});

describe('subagent isolation', () => {
  function parentWithSubagent() {
    resetFixtureIds();
    return [
      ev('user.message', { content: 'delegate', interactionId: 'i-1', messageId: 'm-1' }, T0),
      ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, T0 + 10),
      ev('assistant.message', {
        messageId: 'am-1', content: '', model: 'model-a', apiCallId: 'api-1', turnId: '0', interactionId: 'i-1',
        toolRequests: [{ toolCallId: 'call-p', name: 'task', arguments: { prompt: 'sub work' }, type: 'function' }],
      }, T0 + 100),
      ev('tool.execution_start', { toolCallId: 'call-p', toolName: 'task', arguments: { prompt: 'sub work' }, turnId: '0' }, T0 + 110),
      // The subagent restarts native turn numbering at "0".
      ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, T0 + 120),
      ev('assistant.message', {
        messageId: 'am-sub', content: 'sub answer', model: 'model-a', apiCallId: 'api-sub', turnId: '0',
        interactionId: 'i-1', parentToolCallId: 'call-p',
      }, T0 + 200),
      ev('tool.execution_complete', { toolCallId: 'call-p', success: true, result: { content: 'sub done' }, turnId: '0' }, T0 + 300),
      ev('assistant.turn_start', { turnId: '1', interactionId: 'i-1' }, T0 + 310),
      ev('assistant.message', {
        messageId: 'am-2', content: 'all done', model: 'model-a', apiCallId: 'api-2', turnId: '1', interactionId: 'i-1',
      }, T0 + 400),
    ];
  }

  it('keeps the parent request delta intact and never leaks it into the subagent', () => {
    const entries = buildCopilotEvents(parentWithSubagent(), opts);
    const requests = entries.filter(e => e['event.name'] === 'llm.request');
    expect(requests).toHaveLength(3);
    const [parentFirst, subagent, parentSecond] = requests;
    expect(subagent['gen_ai.agent.scope']).toBe('subagent');
    expect(subagent['gen_ai.input.messages_delta']).toBeUndefined();
    expect(parentSecond['gen_ai.agent.scope']).toBeUndefined();
    expect(parentSecond['gen_ai.input.messages_delta']).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-p', name: 'task', arguments: { prompt: 'sub work' } }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-p', response: 'sub done' }] },
    ]);
    expect(parentFirst['gen_ai.turn.start']).toBe(true);
  });

  it('gives the subagent step a distinct step id and event ids', () => {
    const entries = buildCopilotEvents(parentWithSubagent(), opts);
    const requests = entries.filter(e => e['event.name'] === 'llm.request');
    expect(new Set(requests.map(e => e['gen_ai.step.id'])).size).toBe(3);
    expect(new Set(entries.map(e => e['event.id'])).size).toBe(entries.length);
  });
});
