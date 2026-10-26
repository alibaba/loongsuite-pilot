import { afterEach, describe, expect, it } from 'vitest';
import { setupV2 } from '../../../assets/plugins/opencode/v2.mjs';

const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function harness(options = {}) {
  const records = [], errors = [], hooks = new Map(), pending = [];
  let wake, seq = 0;
  const ctx = {
    location: { directory: '/test/project' },
    session: { hook: async (name, callback) => { hooks.set(name, callback); return { dispose() { hooks.delete(name); } }; } },
    event: { async *subscribe({ signal }) {
      signal.addEventListener('abort', () => wake?.(), { once: true });
      while (!signal.aborted) {
        if (pending.length) yield pending.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    } },
  };
  const cleanup = await setupV2(ctx, {
    common: (id, state) => ({ 'gen_ai.session.id': id, 'gen_ai.turn.id': state.currentTurn?.turnId, trace_id: state.currentTurn?.traceId }),
    writeRecord: record => records.push(record), writeError: (...args) => errors.push(args),
    inferProviderName: id => id, recordUpstreamEnvOnce() {}, ...options,
  });
  cleanups.push(cleanup);
  async function send(type, data = {}, options = {}) {
    const event = { id: `evt_${++seq}`, type, created: 1750000000000 + seq * 10, data: { sessionID: 'ses_a', ...data }, ...options };
    pending.push(event); wake?.(); await new Promise(resolve => setTimeout(resolve, 0));
    return event;
  }
  const start = async (id = 'msg_one', sessionID = 'ses_a') => send('session.step.started', { sessionID, assistantMessageID: id, agent: 'build', model: { id: 'test-model', providerID: 'openai' }, started: 1750000000000 });
  return { records, errors, hooks, ctx, cleanup, send, start };
}

const usage = { input: 10, output: 5, reasoning: 2, cache: { read: 20, write: 3 } };

describe('OpenCode V2 adapter', () => {
  it('captures model input/output, native times, model identity and non-duplicated token usage', async () => {
    const h = await harness();
    h.hooks.get('context')({ sessionID: 'ses_a', system: [{ text: 'system prompt' }], messages: [{ role: 'user', content: 'hello' }] });
    await h.start();
    await h.send('session.text.ended', { assistantMessageID: 'msg_one', ordinal: 0, text: 'first' });
    await h.send('session.text.ended', { assistantMessageID: 'msg_one', ordinal: 1, text: 'second' });
    const terminal = await h.send('session.step.ended', { assistantMessageID: 'msg_one', finish: 'stop', tokens: usage, cost: 0.002 });
    await h.send('session.step.ended', {}, terminal); // identical source event is ignored
    await h.send('session.usage.updated', { tokens: usage }); // cumulative usage is not another response
    await h.send('session.execution.succeeded');
    const request = h.records.find(r => r['event.name'] === 'llm.request');
    const responses = h.records.filter(r => r['event.name'] === 'llm.response');
    expect(request['gen_ai.request.model']).toBe('test-model');
    expect(request['gen_ai.input.messages'][1].parts[0].content).toBe('hello');
    expect(request.time_unix_nano).toBe('1750000000000000000');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ 'gen_ai.usage.input_tokens': 33, 'gen_ai.usage.output_tokens': 5, 'gen_ai.usage.total_tokens': 38, cost_usd: 0.002 });
    expect(responses[0]['gen_ai.output.messages'][0].parts.map(p => p.content)).toEqual(['first', 'second']);
    expect(h.records.filter(r => r['gen_ai.turn.start'])).toHaveLength(1);
    expect(h.records.filter(r => r['gen_ai.turn.end'])).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it('pairs parallel tools by native ID and records failures without inventing successful results', async () => {
    const h = await harness(); await h.start();
    for (const id of ['call_one', 'call_two']) {
      await h.send('session.tool.input.started', { assistantMessageID: 'msg_one', id, name: 'read' });
      await h.send('session.tool.called', { assistantMessageID: 'msg_one', id, input: { filePath: id } });
    }
    await h.send('session.tool.failed', { assistantMessageID: 'msg_one', id: 'call_two', error: { name: 'ReadError', message: 'missing file' } });
    await h.send('session.tool.success', { assistantMessageID: 'msg_one', id: 'call_one', content: [{ type: 'text', text: 'file contents' }] });
    const calls = h.records.filter(r => r['event.name'] === 'tool.call');
    const results = h.records.filter(r => r['event.name'] === 'tool.result');
    expect(calls.map(r => r['gen_ai.tool.call.id']).sort()).toEqual(results.map(r => r['gen_ai.tool.call.id']).sort());
    expect(results[0]).toMatchObject({ 'tool.result.status': 'failure', 'error.type': 'ReadError' });
    expect(results.every(r => r['gen_ai.tool.call.duration'] > 0)).toBe(true);
  });

  it.each(['session.execution.interrupted', 'session.execution.failed', 'session.deleted'])(
    'gives each pending step/tool a distinct replay-stable ID on %s', async type => {
      const replay = async () => {
        const h = await harness();
        for (const step of ['step_one', 'step_two']) {
          await h.start(step);
          for (const id of ['call_one', 'call_two']) {
            await h.send('session.tool.input.started', { assistantMessageID: step, id, name: 'read' });
            await h.send('session.tool.called', { assistantMessageID: step, id, input: {} });
          }
        }
        const terminal = await h.send(type, { reason: 'user', error: { name: 'APIError' } });
        await h.send(type, {}, terminal);
        expect(h.records.filter(r => r['event.name'] === 'tool.result')).toHaveLength(4);
        expect(h.records.filter(r => r['event.name'] === 'llm.response')).toHaveLength(2);
        expect(new Set(h.records.map(r => r['event.id'])).size).toBe(h.records.length);
        expect(h.errors).toEqual([]);
        return h.records.map(r => r['event.id']);
      };
      expect(await replay()).toEqual(await replay());
    },
  );

  it('keeps the start and input records distinct when inbox delivery begins a turn', async () => {
    const h = await harness();
    await h.send('session.inbox.enqueued', { inboxID: 'prompt_one', item: { type: 'user', payload: { text: 'hello' } } });
    await h.send('session.inbox.delivered', { inboxID: 'prompt_one' });
    expect(h.records).toHaveLength(2);
    expect(new Set(h.records.map(r => r['event.id'])).size).toBe(2);
  });

  it.each([20, 200000])('bounds a %s-character tool argument consistently without changing small JSON types', async size => {
    const h = await harness(); await h.start();
    const input = { content: 'x'.repeat(size) };
    await h.send('session.tool.input.started', { assistantMessageID: 'msg_one', id: 'call_one', name: 'write' });
    await h.send('session.tool.called', { assistantMessageID: 'msg_one', id: 'call_one', input });
    input.content = 'mutated after the event';
    await h.send('session.tool.success', { assistantMessageID: 'msg_one', id: 'call_one', content: [{ type: 'text', text: 'written' }] });
    await h.send('session.step.ended', { assistantMessageID: 'msg_one', finish: 'tool-calls', tokens: usage });
    const call = h.records.find(r => r['event.name'] === 'tool.call');
    const intent = h.records.find(r => r['event.name'] === 'llm.response')['gen_ai.output.messages'][0].parts[0];
    const args = call['gen_ai.tool.call.arguments'];
    if (size < 65536) {
      expect(args).toEqual({ content: 'x'.repeat(size) });
      expect(JSON.parse(intent.arguments)).toEqual(args);
      expect(call['agent.opencode.tool.arguments_truncated']).toBeUndefined();
    } else {
      expect(typeof args).toBe('string');
      expect(args.length).toBeLessThanOrEqual(65536 + '...[truncated]'.length);
      expect(args.endsWith('...[truncated]')).toBe(true);
      expect(intent.arguments).toBe(args);
      expect(call['agent.opencode.tool.arguments_truncated']).toBe(true);
    }
    expect(h.errors).toEqual([]);
  });

  it('carries native tool result parts into the next request without stringifying the parts array', async () => {
    const h = await harness(); await h.start();
    await h.send('session.tool.input.started', { assistantMessageID: 'msg_one', id: 'call_one', name: 'read' });
    await h.send('session.tool.called', { assistantMessageID: 'msg_one', id: 'call_one', input: {} });
    await h.send('session.tool.success', { assistantMessageID: 'msg_one', id: 'call_one', content: [{ type: 'text', text: 'actual tool output' }] });
    await h.send('session.step.ended', { assistantMessageID: 'msg_one', finish: 'tool-calls', tokens: usage });
    await h.start('msg_two');
    const next = h.records.filter(r => r['event.name'] === 'llm.request')[1];
    const result = h.records.find(r => r['event.name'] === 'tool.result')['gen_ai.tool.call.result'];
    expect(next['gen_ai.input.messages_delta'].find(m => m.role === 'tool').parts).toEqual([
      { type: 'tool_call_response', id: 'call_one', response: result },
    ]);
    expect(h.errors).toEqual([]);
  });

  it('does not evict an active session while more than 100 other turns complete', async () => {
    const h = await harness(); await h.start();
    const originalTurn = h.records[0]['gen_ai.turn.id'];
    for (let n = 0; n < 101; n++) {
      await h.start(`msg_${n}`, `ses_${n}`);
      await h.send('session.execution.interrupted', { sessionID: `ses_${n}`, reason: 'user' });
    }
    await h.send('session.text.ended', { assistantMessageID: 'msg_one', ordinal: 0, text: 'retained answer' });
    await h.send('session.step.ended', { assistantMessageID: 'msg_one', finish: 'stop', tokens: usage });
    const response = h.records.find(r => r['gen_ai.session.id'] === 'ses_a' && r['event.name'] === 'llm.response');
    expect(response['gen_ai.turn.id']).toBe(originalTurn);
    expect(response['gen_ai.output.messages'][0].parts[0].content).toBe('retained answer');
    expect(h.errors).toEqual([]);
  });

  it('preserves admitted active sessions at capacity and diagnoses overflow without fabricating completion', async () => {
    const h = await harness();
    for (let n = 0; n < 100; n++) await h.start(`msg_${n}`, `ses_${n}`);
    const originalTurn = h.records.find(r => r['gen_ai.session.id'] === 'ses_0')['gen_ai.turn.id'];
    await h.start('msg_overflow', 'ses_overflow');
    await h.start('msg_overflow_two', 'ses_overflow_two');
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0][0]).toBe('v2-session-capacity');
    expect(h.records.some(r => r['gen_ai.turn.end'])).toBe(false);
    await h.send('session.step.ended', { sessionID: 'ses_0', assistantMessageID: 'msg_0', finish: 'stop', tokens: usage });
    await h.send('session.execution.succeeded', { sessionID: 'ses_0' });
    expect(h.records.find(r => r['gen_ai.session.id'] === 'ses_0' && r['event.name'] === 'llm.response')['gen_ai.turn.id']).toBe(originalTurn);
    await h.start('msg_after_capacity', 'ses_after_capacity');
    expect(h.records.some(r => r['gen_ai.session.id'] === 'ses_after_capacity' && r['event.name'] === 'llm.request')).toBe(true);
  });

  describe.each(['session.step.ended', 'session.step.failed'])('%s token tolerance', (type) => {
    it.each([
      ['missing cache', { input: 10, output: 5 }, 10, 0, 0],
      ['null cache', { input: 10, output: 5, cache: null }, 10, 0, 0],
      ['empty cache', { input: 10, output: 5, cache: {} }, 10, 0, 0],
      ['read-only cache', { input: 10, output: 5, cache: { read: 20 } }, 30, 20, 0],
      ['write-only cache', { input: 10, output: 5, cache: { write: 3 } }, 13, 0, 3],
    ])('preserves output and finite usage with %s', async (_name, tokens, input, read, write) => {
      const h = await harness(); await h.start();
      await h.send('session.text.ended', { assistantMessageID: 'msg_one', ordinal: 0, text: 'retained output' });
      const terminal = await h.send(type, {
        assistantMessageID: 'msg_one', finish: 'stop', tokens,
        ...(type.endsWith('failed') ? { error: { name: 'APIError' } } : {}),
      });
      await h.send(type, {}, terminal);
      await h.send(type.endsWith('failed') ? 'session.execution.failed' : 'session.execution.succeeded');
      const responses = h.records.filter(r => r['event.name'] === 'llm.response');
      expect(responses).toHaveLength(1);
      expect(h.records.filter(r => r['event.name'] === 'llm.request')).toHaveLength(1);
      expect(h.records.filter(r => r['gen_ai.turn.end'])).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        'gen_ai.step.id': 'msg_one', 'gen_ai.usage.input_tokens': input,
        'gen_ai.usage.output_tokens': 5, 'gen_ai.usage.total_tokens': input + 5,
        'gen_ai.usage.cache_read.input_tokens': read, 'gen_ai.usage.cache_creation.input_tokens': write,
        'gen_ai.response.finish_reasons': [type.endsWith('failed') ? 'error' : 'stop'],
      });
      expect(responses[0]['gen_ai.output.messages'][0].parts[0].content).toBe('retained output');
      expect(Object.entries(responses[0]).filter(([key]) => key.startsWith('gen_ai.usage.'))
        .every(([, value]) => Number.isFinite(value) && value >= 0)).toBe(true);
      expect(h.errors).toEqual([]);
    });

    it.each([undefined, null])('does not fabricate usage when tokens is %s', async tokens => {
      const h = await harness(); await h.start();
      await h.send('session.text.ended', { assistantMessageID: 'msg_one', ordinal: 0, text: 'unmetered output' });
      await h.send(type, { assistantMessageID: 'msg_one', finish: 'stop', tokens });
      await h.send('session.execution.succeeded');
      const responses = h.records.filter(r => r['event.name'] === 'llm.response');
      expect(responses).toHaveLength(1);
      expect(responses[0]['gen_ai.output.messages'][0].parts[0].content).toBe('unmetered output');
      expect(Object.keys(responses[0]).filter(key => key.startsWith('gen_ai.usage.'))).toEqual([]);
      expect(h.errors).toEqual([]);
    });
  });

  it.each([NaN, Infinity, -1, '10'])('omits invalid token counts (%s) and dependent totals', async invalid => {
    const h = await harness(); await h.start();
    await h.send('session.step.ended', {
      assistantMessageID: 'msg_one', finish: 'stop',
      tokens: { input: 10, output: 5, reasoning: invalid, cache: { read: invalid, write: 3 } },
    });
    const response = h.records.find(r => r['event.name'] === 'llm.response');
    expect(response).toMatchObject({ 'gen_ai.usage.output_tokens': 5, 'gen_ai.usage.cache_creation.input_tokens': 3 });
    for (const key of ['input_tokens', 'total_tokens', 'cache_read.input_tokens', 'reasoning_tokens']) {
      expect(response).not.toHaveProperty(`gen_ai.usage.${key}`);
    }
    expect(h.errors).toEqual([]);
  });

  it('keeps a step open for execution termination if response emission throws', async () => {
    const records = [];
    let fail = true;
    const h = await harness({ writeRecord(record) {
      if (record['event.name'] === 'llm.response' && fail) {
        fail = false; throw new Error('synthetic emission failure');
      }
      records.push(record);
    } });
    await h.start();
    await h.send('session.step.ended', { assistantMessageID: 'msg_one', finish: 'stop', tokens: usage });
    expect(h.errors).toHaveLength(1);
    await h.send('session.execution.interrupted', { reason: 'user' });
    const responses = records.filter(r => r['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
    expect(responses[0]['gen_ai.usage.total_tokens']).toBeUndefined();
    expect(records.filter(r => r['gen_ai.turn.end'])).toHaveLength(1);
  });

  it('keeps retries inside one turn and seals observed requests on interruption', async () => {
    const h = await harness(); await h.start();
    await h.send('session.step.failed', { assistantMessageID: 'msg_one', error: { name: 'APIError' } });
    await h.start('msg_two');
    await h.send('session.execution.interrupted', { reason: 'user' });
    expect(new Set(h.records.map(r => r['gen_ai.turn.id'])).size).toBe(1);
    expect(h.records.filter(r => r['gen_ai.turn.end'])).toHaveLength(1);
    expect(h.records.filter(r => r['event.name'] === 'llm.response').map(r => r['gen_ai.response.finish_reasons'])).toEqual([['error'], ['cancelled']]);
    expect(h.records.filter(r => r['event.name'] === 'llm.response').every(r => r['gen_ai.usage.total_tokens'] === undefined)).toBe(true);
    await h.start('msg_three');
    expect(h.records.at(-1)['gen_ai.turn.id']).not.toBe(h.records[0]['gen_ai.turn.id']);
  });

  it('does not start a queued prompt as a turn before delivery and removes cancelled prompts', async () => {
    const h = await harness();
    await h.send('session.inbox.enqueued', { inboxID: 'msg_prompt', item: { type: 'user', payload: { text: 'queued' }, delivery: 'queue' } });
    expect(h.records).toHaveLength(0);
    await h.send('session.inbox.cancelled', { inboxID: 'msg_prompt' });
    await h.send('session.inbox.delivered', { inboxID: 'msg_prompt' });
    expect(h.records.some(r => r['gen_ai.input.messages_delta'])).toBe(false);
  });

  it('isolates sessions and locations, and stops processing after disposal', async () => {
    const h = await harness();
    await h.start(); await h.start('msg_other', 'ses_b');
    const a = h.records.find(r => r['gen_ai.session.id'] === 'ses_a');
    const b = h.records.find(r => r['gen_ai.session.id'] === 'ses_b');
    expect(a.trace_id).not.toBe(b.trace_id);
    await h.send('session.step.started', { assistantMessageID: 'ignored' }, { location: { directory: '/another/project' } });
    expect(h.records.some(r => r['gen_ai.step.id'] === 'ignored')).toBe(false);
    const count = h.records.length;
    h.cleanup(); await h.send('session.execution.succeeded');
    expect(h.records).toHaveLength(count);
    expect(h.hooks.size).toBe(0);
  });

  it('keeps source Agent usable if telemetry writes fail', async () => {
    const h = await harness();
    Object.freeze(h.records);
    await h.start();
    expect(h.errors).toHaveLength(1);
  });

  it('fails open if an unexpected context value cannot be serialized', async () => {
    const h = await harness();
    const circular = {}; circular.self = circular;
    expect(() => h.hooks.get('context')({ sessionID: 'ses_a', messages: [{ role: 'tool', content: [{ type: 'tool-result', output: circular }] }] })).not.toThrow();
    await h.start();
    expect(h.records.some(r => r['event.name'] === 'llm.request')).toBe(true);
    expect(h.errors).toHaveLength(1);
  });

  it('reports content and error text despite the obsolete capture flag', async () => {
    const h = await harness({ captureMessageContent: false });
    h.hooks.get('context')({ sessionID: 'ses_a', system: [{ text: 'PRIVATE_SYSTEM' }], messages: [{ role: 'user', content: 'PRIVATE_INPUT' }] });
    await h.start();
    await h.send('session.text.ended', { assistantMessageID: 'msg_one', ordinal: 0, text: 'PRIVATE_OUTPUT' });
    await h.send('session.tool.input.started', { assistantMessageID: 'msg_one', id: 'call_one', name: 'read' });
    await h.send('session.tool.called', { assistantMessageID: 'msg_one', id: 'call_one', input: { path: 'PRIVATE_PATH' } });
    await h.send('session.tool.failed', { assistantMessageID: 'msg_one', id: 'call_one', error: { name: 'ReadError', message: 'PRIVATE_ERROR' } });
    await h.send('session.step.ended', { assistantMessageID: 'msg_one', finish: 'stop', tokens: usage });
    const output = JSON.stringify(h.records);
    for (const content of ['PRIVATE_SYSTEM', 'PRIVATE_INPUT', 'PRIVATE_OUTPUT', 'PRIVATE_PATH', 'PRIVATE_ERROR']) {
      expect(output).toContain(content);
    }
    expect(h.records.find(r => r['event.name'] === 'llm.response')['gen_ai.usage.total_tokens']).toBe(38);
  });

  it('seals outstanding tools on interruption and uses the provider stream boundary for LLM time', async () => {
    const h = await harness(); await h.start();
    await h.send('session.tool.input.started', { assistantMessageID: 'msg_one', id: 'call_one', name: 'read' });
    await h.send('session.tool.called', { assistantMessageID: 'msg_one', id: 'call_one', input: {} });
    const streamed = await h.send('session.step.streamed', { assistantMessageID: 'msg_one' });
    await h.send('session.step.ended', { assistantMessageID: 'msg_one', finish: 'tool-calls', tokens: usage });
    expect(h.records.find(r => r['event.name'] === 'llm.response').time_unix_nano).toBe(String(BigInt(streamed.created) * 1000000n));
    // A separate, still-running step is interrupted while its tool executes.
    await h.start('msg_two');
    await h.send('session.tool.input.started', { assistantMessageID: 'msg_two', id: 'call_two', name: 'read' });
    await h.send('session.tool.called', { assistantMessageID: 'msg_two', id: 'call_two', input: {} });
    await h.send('session.execution.interrupted', { reason: 'user' });
    const result = h.records.find(r => r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'call_two');
    expect(result['tool.result.status']).toBe('cancelled');
    expect(result['gen_ai.tool.call.result']).toBeUndefined();
  });
});
