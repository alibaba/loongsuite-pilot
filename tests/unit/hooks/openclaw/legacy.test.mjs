import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';

// Shapes checked against upstream v2026.3.8 src/plugins/types.ts and
// pi-embedded-runner/run/attempt.ts. In particular agent_end and persistence
// have NO runId in either event or context, unlike the modern fixture replay.
let root, handlers, clock;
let seq = 0;
const ctx = { agentId: 'main', sessionKey: 'agent:main:test', sessionId: 'session-1' };
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-oc-legacy-'));
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', root);
  vi.stubEnv('LOONGSUITE_USER_ID', 'test');
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const pluginPath = path.resolve('assets/plugins/openclaw/plugin.mjs');
  const plugin = (await import(/* @vite-ignore */ `${pluginPath}?legacy=${++seq}`)).default;
  handlers = {};
  plugin.register({ runtime: { version: '2026.3.8' }, on(name, handler) { handlers[name] = handler; } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function fire(name, event, context = ctx) {
  clock += 10;
  expect(handlers[name](event, context)).toBeUndefined(); // sync/void contract
}
function input(runId = 'run-1', context = ctx) {
  fire('llm_input', { runId, sessionId: context.sessionId, provider: 'openai', model: 'gpt-test', prompt: 'private prompt' }, context);
}
function message(id, content = [{ type: 'text', text: 'private output' }], stopReason = 'stop') {
  return { role: 'assistant', responseId: id, timestamp: clock,
    provider: 'openai', model: 'gpt-test', content, stopReason,
    usage: { input: 20, output: 4, cacheRead: 5, totalTokens: 29 } };
}
function records() {
  const dir = path.join(root, 'logs/openclaw');
  return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).flatMap(n =>
    fs.readFileSync(path.join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
function finish(runId = 'run-1', context = ctx, usage = { input: 20, output: 4, cacheRead: 5 }) {
  fire('agent_end', { success: true, messages: [] }, context);
  fire('llm_output', { runId, sessionId: context.sessionId, usage }, context);
}

describe('OpenClaw 3.8 legacy adapter', () => {
  it('emits system instructions as canonical text parts', () => {
    fire('llm_input', { runId: 'run-1', sessionId: ctx.sessionId, provider: 'openai', model: 'gpt-test',
      prompt: 'private prompt', systemPrompt: 'system rules' });
    fire('before_message_write', { message: message('response-1') });
    finish();
    const instructions = records().filter(r => r['gen_ai.system_instructions'] !== undefined);
    expect(instructions).toHaveLength(2);
    for (const record of instructions) expect(record['gen_ai.system_instructions'])
      .toEqual([{ type: 'text', content: 'system rules' }]);
  });

  it('retains configured identity and worker metadata without a native sender', async () => {
    vi.stubEnv('AGENTTEAMS_WORKER_NAME', 'legacy-worker');
    const pluginPath = path.resolve('assets/plugins/openclaw/plugin.mjs');
    const plugin = (await import(/* @vite-ignore */ `${pluginPath}?legacy-worker=${++seq}`)).default;
    handlers = {};
    plugin.register({ runtime: { version: '2026.3.8' }, on(name, handler) { handlers[name] = handler; } });
    expect(handlers.message_received).toBeUndefined();
    input();
    fire('before_message_write', { message: message('worker-response') });
    finish();
    for (const record of records()) {
      expect(record['user.id']).toBe('test');
      expect(record['gen_ai.agent.name']).toBe('legacy-worker');
      expect(record.resourceAttributes['agentteams.worker.name']).toBe('legacy-worker');
    }
  });

  it('registers only hooks supported by 3.8 and emits a coherent text turn', () => {
    expect(Object.keys(handlers)).toHaveLength(9);
    expect(handlers.model_call_started).toBeUndefined();
    input();
    const msg = message('response-1');
    fire('before_message_write', { message: msg });
    fire('before_message_write', { message: structuredClone(msg) });
    finish();
    const result = records();
    expect(result.filter(r => r['event.name'] === 'llm.request')).toHaveLength(1);
    const response = result.find(r => r['event.name'] === 'llm.response');
    expect(response['gen_ai.usage.output_tokens']).toBe(4);
    expect(response['agent.openclaw.timing.inferred']).toBe(true);
    expect(result.at(-1)['agent.openclaw.per_call_usage.count']).toBe(1);
    expect(result.at(-1)['agent.openclaw.per_call_usage.mismatch']).toBeUndefined();
    expect(new Set(result.map(r => r.trace_id)).size).toBe(1);
    expect(result.every(r => r['gen_ai.session.id'] === 'session-1')).toBe(true);
  });

  it('preserves parallel tool IDs, per-call tokens and inferred timing through final spans', async () => {
    input();
    fire('before_message_write', { message: message('r1', [
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a' } },
      { type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'b' } },
    ], 'toolUse') });
    for (const id of ['t1', 't2']) fire('before_tool_call', { runId: 'run-1', toolCallId: id, toolName: 'read', params: { path: id } });
    for (const id of ['t2', 't1']) {
      fire('after_tool_call', { runId: 'run-1', toolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: id }] }, durationMs: 10 });
      fire('tool_result_persist', { toolCallId: id, toolName: 'read', message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: id }] } });
    }
    fire('before_message_write', { message: message('r2') });
    finish('run-1', ctx, { input: 40, output: 8, cacheRead: 10 });
    const result = records();
    const requests = result.filter(r => r['event.name'] === 'llm.request');
    const responses = result.filter(r => r['event.name'] === 'llm.response');
    expect(requests).toHaveLength(2);
    expect(responses).toHaveLength(2);
    expect(requests[1]['gen_ai.input.messages_delta'].map(m => m.parts[0].id)).toEqual(['t2', 't1']);
    expect(requests[1]['agent.openclaw.timing.source']).toBe('tool_result_persist');
    expect(result.filter(r => r['event.name'] === 'tool.result').map(r => r['gen_ai.tool.call.id'])).toEqual(['t2', 't1']);
    expect(result.at(-1)['agent.openclaw.per_call_usage.mismatch']).toBeUndefined();
    vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental');
    vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'SPAN_ONLY');
    const converted = await convertEventLogToReadableSpans(result, { strict: false });
    expect(converted.warnings).toEqual([]);
    const kinds = converted.spans.map(s => s.attributes['gen_ai.span.kind']);
    expect(kinds.filter(k => k === 'LLM')).toHaveLength(2);
    expect(kinds.filter(k => k === 'TOOL')).toHaveLength(2);
    expect(kinds.filter(k => k === 'AGENT')).toHaveLength(1);
    for (const span of converted.spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')) {
      expect(span.duration[0] * 1e9 + span.duration[1]).toBeGreaterThan(0);
      expect(span.attributes['gen_ai.usage.output_tokens']).toBe(4);
    }
    expect(converted.spans.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT').attributes['gen_ai.usage.output_tokens']).toBe(8);
  });

  it.each(['error', 'aborted'])('preserves empty %s assistant completion without inventing output', reason => {
    input();
    fire('before_message_write', { message: message('failure', [], reason) });
    fire('agent_end', { success: false, error: 'private error' });
    const result = records();
    expect(result.find(r => r['event.name'] === 'llm.response')['gen_ai.response.finish_reasons']).toEqual([reason === 'aborted' ? 'cancelled' : 'error']);
    expect(result.find(r => r['event.name'] === 'llm.response')['gen_ai.output.messages']).toBeUndefined();
    expect(result.at(-1)['agent.openclaw.success']).toBe(false);
  });

  it('does not fabricate model calls from aggregate or historic output', () => {
    input();
    fire('agent_end', { success: false, error: 'provider unreachable', messages: [message('historic')] });
    fire('llm_output', { runId: 'run-1', lastAssistant: message('historic'), usage: { output: 5 } });
    expect(records().some(r => r['event.name'].startsWith('llm.'))).toBe(false);
  });

  it('isolates concurrent sessions and ignores persistence after completion', () => {
    const second = { ...ctx, sessionKey: 'agent:main:second', sessionId: 'session-2' };
    input(); input('run-2', second);
    fire('before_message_write', { message: message('r2') }, second);
    finish('run-2', second);
    fire('before_message_write', { message: message('late') }, second);
    fire('before_message_write', { message: message('r1') });
    finish();
    const responses = records().filter(r => r['event.name'] === 'llm.response');
    expect(responses.map(r => r['gen_ai.turn.id'])).toEqual(['run-2', 'run-1']);
    expect(new Set(responses.map(r => r.trace_id)).size).toBe(2);
  });

  it('opens a distinct turn for fallback reusing a native run ID after failure was flushed', () => {
    input();
    fire('before_message_write', { message: message('failed', [], 'error') });
    fire('agent_end', { success: false, error: 'provider unavailable' });
    // Native 3.8 attempt.ts emits the old aggregate synchronously before the
    // attempt returns and the fallback's next llm_input can run.
    fire('llm_output', { runId: 'run-1', usage: { output: 99 } });
    input();
    fire('before_message_write', { message: message('fallback') });
    finish();
    const responses = records().filter(r => r['event.name'] === 'llm.response');
    expect(responses).toHaveLength(2);
    expect(new Set(responses.map(r => r.trace_id)).size).toBe(2);
    expect(new Set(responses.map(r => r['gen_ai.turn.id'])).size).toBe(2);
    expect(responses[1]['agent.openclaw.run_id']).toBe('run-1');
  });

  it.each([false, true])('keeps same-millisecond spans positive/contained through clock rollback (tools=%s)', async withTool => {
    input();
    handlers.before_message_write({ message: withTool
      ? message('r1', [{ type: 'toolCall', id: 't', name: 'read', arguments: {} }], 'toolUse')
      : message('r1') }, ctx);
    if (withTool) {
      const tool = { runId: 'run-1', toolCallId: 't', toolName: 'read' };
      handlers.before_tool_call(tool, ctx);
      handlers.after_tool_call({ ...tool, durationMs: 0, result: 'ok' }, ctx);
      handlers.tool_result_persist({ toolCallId: 't', message: { role: 'toolResult', toolCallId: 't', content: [{ type: 'text', text: 'ok' }] } }, ctx);
    }
    clock -= 1000;
    handlers.before_message_write({ message: message('r2') }, ctx);
    handlers.agent_end({ success: true }, ctx);
    handlers.llm_output({ runId: 'run-1' }, ctx);
    const result = await convertEventLogToReadableSpans(records(), { strict: false });
    const nanos = t => BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]);
    for (const span of result.spans) {
      if (['LLM', 'TOOL'].includes(span.attributes['gen_ai.span.kind'])) expect(nanos(span.duration)).toBeGreaterThan(0n);
      const parent = result.spans.find(s => s.spanContext().spanId === span.parentSpanId);
      if (parent) {
        expect(nanos(span.startTime)).toBeGreaterThanOrEqual(nanos(parent.startTime));
        expect(nanos(span.endTime)).toBeLessThanOrEqual(nanos(parent.endTime));
      }
    }
    expect(result.spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(2);
  });

  it('seals ambiguous failure as incomplete without assigning native failure to every run', () => {
    input('one'); input('two');
    fire('agent_end', { success: false, error: 'private unassigned failure' });
    const terminal = records().filter(r => r['agent.openclaw.hook'] === 'legacy_cleanup');
    expect(terminal).toHaveLength(2);
    for (const r of terminal) {
      expect(r['gen_ai.turn.end']).toBe(true);
      expect(r['agent.openclaw.collection.end_reason']).toBe('ambiguous_agent_end');
      expect(r['agent.openclaw.success']).toBeUndefined();
      expect(r['error.message']).toBeUndefined();
    }
    fire('llm_output', { runId: 'one' }); fire('llm_output', { runId: 'two' });
    expect(records().filter(r => r['agent.openclaw.hook'] === 'llm_output')).toHaveLength(0);
    input('three'); fire('before_message_write', { message: message('new') }); finish('three');
    expect(records().filter(r => r['event.name'] === 'llm.response')).toHaveLength(1);
  });

  it.each([true, false])('cleans owners at session_end before a missing output (sessionKey=%s)', withKey => {
    input('old');
    handlers.session_end({ sessionId: ctx.sessionId, ...(withKey ? { sessionKey: ctx.sessionKey } : {}) }, {});
    input('new'); fire('before_message_write', { message: message('new') }); finish('new');
    expect(records().filter(r => r['event.name'] === 'llm.response')).toHaveLength(1);
    expect(records().filter(r => r['agent.openclaw.collection.end_reason'] === 'session_end')).toHaveLength(1);
  });

  it('retains a long active run while hundreds of other sessions finish', () => {
    input('held');
    for (let i = 0; i < 210; i++) {
      const c = { ...ctx, sessionKey: `other-${i}`, sessionId: `session-${i}` };
      input(`r${i}`, c); finish(`r${i}`, c);
    }
    fire('before_message_write', { message: message('held') }); finish('held');
    expect(records().filter(r => r['event.name'] === 'llm.response')).toHaveLength(1);
    expect(records().find(r => r['event.name'] === 'llm.response')['gen_ai.turn.id']).toBe('held');
  });

  it('emits bounded incomplete terminals when every cached run is active', () => {
    for (let i = 0; i < 205; i++) input(`active-${i}`, { ...ctx, sessionKey: `key-${i}`, sessionId: `session-${i}` });
    const evicted = records().filter(r => r['agent.openclaw.collection.end_reason'] === 'capacity_evicted');
    expect(evicted).toHaveLength(5);
    expect(evicted.every(r => r['gen_ai.turn.end'] === true && r['error.type'] === undefined)).toBe(true);
    fire('llm_output', { runId: 'active-0' });
    expect(records().filter(r => r['agent.openclaw.hook'] === 'llm_output')).toHaveLength(0);
  });

  it('expires orphaned state on new traffic with an incomplete terminal', () => {
    input('old'); clock += 31 * 60_000; input('new');
    fire('before_message_write', { message: message('new') }); finish('new');
    expect(records().filter(r => r['agent.openclaw.collection.end_reason'] === 'idle_expired')).toHaveLength(1);
    expect(records().filter(r => r['event.name'] === 'llm.response')).toHaveLength(1);
  });

  it('does not assign session-only persistence to an ambiguous overlapping run', () => {
    input('first'); input('second');
    fire('before_message_write', { message: message('ambiguous') });
    fire('llm_output', { runId: 'first' });
    fire('before_message_write', { message: message('late-first') });
    fire('llm_output', { runId: 'second' });
    expect(records().filter(r => r['event.name'] === 'llm.response')).toHaveLength(0);
    expect(records().filter(r => r['agent.openclaw.correlation.ambiguous'])).toHaveLength(2);
    input('third');
    fire('before_message_write', { message: message('unambiguous') });
    finish('third');
    expect(records().filter(r => r['event.name'] === 'llm.response')).toHaveLength(1);
  });

  it('removes prompts, responses, tool payloads and errors with content off', () => {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ agents: { openclaw: { captureMessageContent: false } } }));
    input();
    fire('before_message_write', { message: message('r1') });
    fire('before_tool_call', { runId: 'run-1', toolCallId: 't', toolName: 'read', params: { path: 'private args' } });
    fire('after_tool_call', { runId: 'run-1', toolCallId: 't', toolName: 'read', error: 'private error', result: 'private result' });
    fire('agent_end', { success: false, error: 'private error' });
    const text = JSON.stringify(records());
    expect(text).not.toContain('private');
    expect(records().find(r => r['event.name'] === 'llm.response')['gen_ai.usage.output_tokens']).toBe(4);
  });
});
