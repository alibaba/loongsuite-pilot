import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertOpenClawEvidence, assertContentPresent } from '../../../../scripts/e2e/openclaw-assertions.mjs';

// Deliberately synthetic validator tests, not evidence of native hook behavior.
function fixture() {
  const base = { trace_id: 'trace', 'gen_ai.turn.id': 'turn', 'gen_ai.session.id': 'session' };
  const usage = { 'gen_ai.usage.input_tokens': 25, 'gen_ai.usage.output_tokens': 4,
    'gen_ai.usage.total_tokens': 29, 'gen_ai.usage.cache_read.input_tokens': 5 };
  const events = [
    { ...base, 'event.name': 'llm.request' },
    { ...base, ...usage, 'event.name': 'llm.response', 'gen_ai.response.id': 'response' },
    ...['a', 'b'].flatMap(id => ['tool.call', 'tool.result'].map(name => ({ ...base, 'event.name': name, 'gen_ai.tool.call.id': id }))),
  ].map((event, i) => ({ ...event, 'event.id': `e${i}` }));
  function span(id, kind, parent, attrs = {}) {
    return { traceId: 'trace', spanId: id, parentSpanId: parent, startTimeUnixNano: '100', endTimeUnixNano: '200',
      attributes: { 'gen_ai.span.kind': kind, ...attrs }, status: { code: 0 },
      resource: { 'service.name': 'service', 'agentteams.worker.name': 'worker' } };
  }
  const spans = [span('entry', 'ENTRY'), span('agent', 'AGENT', 'entry', { ...usage, 'gen_ai.agent.name': 'worker' }),
    span('step', 'STEP', 'agent'), span('llm', 'LLM', 'step', { ...usage, 'gen_ai.response.id': 'response',
      'gen_ai.provider.name': 'provider', 'gen_ai.request.model': 'model' }),
    ...['a', 'b'].map(id => span(id, 'TOOL', 'step', { 'gen_ai.tool.call.id': id }))];
  return { events, spans, nativeMessages: [{ role: 'assistant', usage: { input: 20, output: 4, cacheRead: 5 } }],
    provider: 'provider', model: 'model', service: 'service', workerName: 'worker', turns: 1 };
}

describe('OpenClaw Gateway E2E acceptance assertions', () => {
  it('refuses installation before doing work unless disposable execution is explicit', () => {
    const script = fileURLToPath(new URL('../../../../scripts/e2e/openclaw-compat.mjs', import.meta.url));
    const child = spawnSync(process.execPath, [script], {
      env: { ...process.env, OPENCLAW_E2E_DISPOSABLE: '0' }, encoding: 'utf8', timeout: 10_000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('Run only in a disposable Linux container');
  });
  it('accepts native token/cache parity and a complete trace', () => {
    expect(assertOpenClawEvidence(fixture())).toMatchObject({ traceIds: ['trace'], events: 6, spans: 6, tools: 2 });
  });
  it.each([
    ['empty', f => { f.events = []; }],
    ['duplicate events', f => { f.events.push(f.events[0]); }],
    ['replayed model response', f => { f.events.push({ ...f.events[1], 'event.id': 'new-id' }); }],
    ['wrong native tokens', f => { f.nativeMessages[0].usage.input++; }],
    ['missing LLM', f => { f.spans = f.spans.filter(s => s.spanId !== 'llm'); }],
    ['duplicate spans', f => { f.spans.push(f.spans[0]); }],
    ['wrong service', f => { f.spans[0].resource['service.name'] = 'other'; }],
    ['missing worker', f => { delete f.spans[0].resource['agentteams.worker.name']; }],
    ['orphan span', f => { f.spans[3].parentSpanId = 'missing'; }],
    ['wrong hierarchy', f => { f.spans[3].parentSpanId = 'agent'; }],
    ['negative duration', f => { f.spans[3].endTimeUnixNano = '99'; }],
    ['outside parent', f => { f.spans[3].endTimeUnixNano = '201'; }],
    ['missing tool result', f => { f.events.pop(); }],
    ['missing tool span', f => { f.spans.pop(); }],
    ['wrong aggregate', f => { f.spans[1].attributes['gen_ai.usage.total_tokens']++; }],
    ['lifecycle trace', f => { f.events[0]['agent.openclaw.hook'] = 'session_start'; }],
    ['unexpected provider error', f => { f.spans[3].status.code = 2; }],
  ])('rejects %s', (_name, mutate) => {
    const f = fixture(); mutate(f); expect(() => assertOpenClawEvidence(f)).toThrow();
  });
  it('requires reported content and the synthetic marker when legacy content config is false', () => {
    expect(() => assertContentPresent([], ['secret'])).toThrow();
    expect(() => assertContentPresent([{ 'gen_ai.usage.input_tokens': 1 }], ['secret'])).toThrow();
    expect(() => assertContentPresent([{ 'gen_ai.input.messages': [{ content: 'different' }] }], ['secret'])).toThrow();
    expect(() => assertContentPresent([{ 'gen_ai.input.messages': [{ content: 'secret' }] }], ['secret'])).not.toThrow();
  });
  it('allows only an explicitly expected read-tool error, not an LLM error', () => {
    const f = fixture(); f.expectedToolErrorTraceIds = ['trace'];
    f.spans[4].status.code = 2;
    Object.assign(f.spans[4].attributes, { 'gen_ai.tool.name': 'read', 'error.type': 'tool_use_failure' });
    expect(() => assertOpenClawEvidence(f)).not.toThrow();
    f.spans[3].status.code = 2;
    expect(() => assertOpenClawEvidence(f)).toThrow('unexpected error span');
  });
});
