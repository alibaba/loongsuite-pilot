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
    input();
    fire('before_message_write', { message: message('fallback') });
    finish();
    const responses = records().filter(r => r['event.name'] === 'llm.response');
    expect(responses).toHaveLength(2);
    expect(new Set(responses.map(r => r.trace_id)).size).toBe(2);
    expect(new Set(responses.map(r => r['gen_ai.turn.id'])).size).toBe(2);
    expect(responses[1]['agent.openclaw.run_id']).toBe('run-1');
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
