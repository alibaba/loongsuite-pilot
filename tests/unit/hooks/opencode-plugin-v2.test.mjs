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

  it('omits all content and error text from the V2 spool when capture is disabled', async () => {
    const h = await harness({ captureMessageContent: false });
    h.hooks.get('context')({ sessionID: 'ses_a', system: [{ text: 'PRIVATE_SYSTEM' }], messages: [{ role: 'user', content: 'PRIVATE_INPUT' }] });
    await h.start();
    await h.send('session.text.ended', { assistantMessageID: 'msg_one', ordinal: 0, text: 'PRIVATE_OUTPUT' });
    await h.send('session.tool.input.started', { assistantMessageID: 'msg_one', id: 'call_one', name: 'read' });
    await h.send('session.tool.called', { assistantMessageID: 'msg_one', id: 'call_one', input: { path: 'PRIVATE_PATH' } });
    await h.send('session.tool.failed', { assistantMessageID: 'msg_one', id: 'call_one', error: { name: 'ReadError', message: 'PRIVATE_ERROR' } });
    await h.send('session.step.ended', { assistantMessageID: 'msg_one', finish: 'stop', tokens: usage });
    expect(JSON.stringify(h.records)).not.toContain('PRIVATE_');
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
