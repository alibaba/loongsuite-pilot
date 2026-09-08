import { describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { projectLogEntry, serialiseLogEntry } from '../../../../src/normalization/entry-builder.js';
import { maskAgentActivityEntry } from '../../../../src/mask/entry-masker.js';

const KEY = 'agent.openclaw.session_key';
function turn(id: number, key?: unknown, sessionId = `session-${id}`): AgentActivityEntry[] {
  const base = { trace_id: id.toString(16).padStart(32, '0'), 'gen_ai.turn.id': `turn-${id}`,
    'gen_ai.agent.type': 'openclaw', 'gen_ai.session.id': sessionId, 'user.id': 'test',
    ...(key === undefined ? {} : { [KEY]: key }) };
  const event = (name: string, offset: number, fields = {}) => ({ ...base, 'event.name': name,
    time_unix_nano: `${Date.parse('2026-09-01T00:00:00Z') + offset}000000`, ...fields } as AgentActivityEntry);
  return [
    event('other', 0, { 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'test' }] }] }),
    event('llm.request', 1, { 'gen_ai.step.id': 'step', 'gen_ai.response.id': 'response', 'gen_ai.request.model': 'test' }),
    event('llm.response', 2, { 'gen_ai.step.id': 'step', 'gen_ai.response.id': 'response', 'gen_ai.response.model': 'test' }),
    event('tool.call', 3, { 'gen_ai.step.id': 'step', 'gen_ai.tool.call.id': 'tool', 'gen_ai.tool.name': 'read' }),
    event('tool.result', 4, { 'gen_ai.step.id': 'step', 'gen_ai.tool.call.id': 'tool', 'gen_ai.tool.name': 'read' }),
    event('other', 5, { 'agent.openclaw.hook': 'llm_output' }),
  ];
}
async function exportSpans(entries: AgentActivityEntry[]) {
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'session-key-test',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
  }, undefined, () => ({ export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {} }));
  try { await flusher.sendBatch(entries); } finally { await flusher.shutdown(); }
  return spans;
}

describe('OpenClaw session key output contract', () => {
  it('retains exactly the validated OpenClaw extension in JSONL and SLS', () => {
    const entry = { ...turn(1, 'agent:main:test')[0], 'agent.openclaw.sender.id': 'private', 'agent.openclaw.hook': 'private' };
    for (const project of [projectLogEntry, serialiseLogEntry]) {
      const out = project(entry, { dropAgentScopedFields: true });
      expect(out[KEY]).toBe('agent:main:test');
      expect(out['agent.openclaw.sender.id']).toBeUndefined();
      expect(out['agent.openclaw.hook']).toBeUndefined();
      expect(project({ ...entry, 'gen_ai.agent.type': 'codex' }, { dropAgentScopedFields: true })[KEY]).toBeUndefined();
    }
  });

  it.each([undefined, null, '', ' ', 42, {}, ['key'], 'x'.repeat(1025), 'key\nvalue'])('omits invalid key %#', async key => {
    const entries = turn(1, key);
    expect(projectLogEntry(entries[0], { dropAgentScopedFields: true })[KEY]).toBeUndefined();
    const spans = await exportSpans(entries);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every(s => s.attributes[KEY] === undefined)).toBe(true);
  });

  it('enriches all five span kinds; parallel turns/reset UUIDs do not share keys', async () => {
    const batches = [turn(1, 'agent:main:a'), turn(2, 'agent:main:b'), turn(3, 'agent:main:a', 'reset-uuid'), turn(4)];
    const entries = batches[0].flatMap((_, i) => batches.map(batch => batch[i]));
    const spans = await exportSpans(entries);
    expect(new Set(spans.map(s => s.attributes['gen_ai.span.kind']))).toEqual(new Set(['ENTRY', 'AGENT', 'STEP', 'LLM', 'TOOL']));
    for (const span of spans) {
      const id = parseInt(span.spanContext().traceId, 16);
      expect(span.attributes[KEY]).toBe(id === 4 ? undefined : id === 2 ? 'agent:main:b' : 'agent:main:a');
      expect(span.resource.attributes[KEY]).toBeUndefined();
    }
    expect(batches[2].every(r => r['gen_ai.session.id'] === 'reset-uuid')).toBe(true);
  });

  it.each(['different-key', 'ambiguous-marker', 'child-scope'])('does not guess for %s', async conflict => {
    const entries = turn(1, 'agent:main:a');
    if (conflict === 'different-key') entries[2][KEY] = 'agent:main:b';
    if (conflict === 'ambiguous-marker') entries[2]['agent.openclaw.session_key.ambiguous'] = true;
    if (conflict === 'child-scope') {
      entries[2]['gen_ai.agent.scope'] = 'subagent';
      delete entries[2][KEY];
    }
    const spans = await exportSpans(entries);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every(s => s.attributes[KEY] === undefined)).toBe(true);
  });

  it('does not enrich other agent products', async () => {
    const spans = await exportSpans(turn(1, 'agent:main:a').map(r => ({ ...r, 'gen_ai.agent.type': 'claude-code' })));
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every(s => s.attributes[KEY] === undefined)).toBe(true);
  });

  it('uses the same masked value in event logs and spans, without changing the session UUID', async () => {
    const entries = turn(1, 'agent:main:AKIAIOSFODNN7EXAMPLE').map(r => maskAgentActivityEntry(r, { mode: 'all', types: [] }));
    expect(projectLogEntry(entries[0], { dropAgentScopedFields: true })[KEY]).toBe('agent:main:[ACCESSKEY_MASKED]');
    expect(serialiseLogEntry(entries[0], { dropAgentScopedFields: true })[KEY]).toBe('agent:main:[ACCESSKEY_MASKED]');
    const spans = await exportSpans(entries);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every(s => s.attributes[KEY] === 'agent:main:[ACCESSKEY_MASKED]')).toBe(true);
    expect(entries.every(r => r['gen_ai.session.id'] === 'session-1')).toBe(true);
  });
});
