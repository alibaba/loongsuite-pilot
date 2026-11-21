import { describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { buildDoubaoTaskEvents, parseDoubaoLogLine } from '../../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine, doubaoToolLine } from '../../../helpers/doubao-work-fixture.js';

const nano = (t: number[]) => BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]);
function records() {
  const pairs = [
    { start: parseDoubaoLogLine(doubaoToolLine({ agent_id: 'synthetic-turn', tcid: 'same-name-a', name: 'Read' }, 1000, 111).trimEnd(), DOUBAO_FILE)!,
      end: parseDoubaoLogLine(doubaoToolLine({ toolCallID: 'same-name-a', name: 'Read', status: 'success', phase: 'execution_settled' }, 1500, 222).trimEnd(), DOUBAO_FILE)! },
    { start: parseDoubaoLogLine(doubaoToolLine({ agent_id: 'synthetic-turn', tcid: 'same-name-b', name: 'Read' }, 1100, 333).trimEnd(), DOUBAO_FILE)!,
      end: parseDoubaoLogLine(doubaoToolLine({ toolCallID: 'same-name-b', name: 'Read', status: 'error', phase: 'execution_settled' }, 1400, 444).trimEnd(), DOUBAO_FILE)! },
  ];
  return buildDoubaoTaskEvents('scope', { turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH,
    conversationId: 'synthetic-conversation', updatedMs: DOUBAO_EPOCH },
  parseDoubaoLogLine(doubaoLine('on_message_session_end'), DOUBAO_FILE)!, Date.now(), pairs);
}
async function convert(entries: ReturnType<typeof records>) {
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }], serviceName: 'observed-tools' }, undefined,
    () => ({ export: (batch, cb) => { spans.push(...batch); cb({ code: 0 }); }, shutdown: async () => {} }));
  try { await flusher.sendBatch(entries); await flusher.flush(); return spans; } finally { await flusher.shutdown(); }
}

describe('source-evidenced Doubao local tool spans', () => {
  it('exports concurrent same-name tools under the evidenced owner without inventing a ReAct/model span', async () => {
    const entries = records();
    const call = entries.find(e => e['event.name'] === 'tool.call' && e['gen_ai.tool.call.id'] === 'same-name-a')!;
    const result = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.tool.call.id'] === 'same-name-a')!;
    call['gen_ai.tool.call.arguments'] = { file_path: 'synthetic-a' }; result['gen_ai.tool.call.result'] = 'synthetic result';
    const spans = await convert(entries), tools = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(tools).toHaveLength(2);
    const agent = spans.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!;
    for (const tool of tools) {
      const id = tool.attributes['gen_ai.tool.call.id'];
      const start = entries.find(e => e['event.name'] === 'tool.call' && e['gen_ai.tool.call.id'] === id)!;
      const end = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.tool.call.id'] === id)!;
      expect(tool.parentSpanId).toBe(agent.spanContext().spanId);
      expect(tool.spanContext().traceId).toBe(agent.spanContext().traceId);
      expect(nano(tool.startTime).toString()).toBe(start.time_unix_nano);
      expect(nano(tool.endTime).toString()).toBe(end.time_unix_nano);
      expect(nano(tool.duration)).toBe(BigInt(end.time_unix_nano) - BigInt(start.time_unix_nano));
      expect(tool.attributes['gen_ai.operation.name']).toBe('execute_tool');
      expect(tool.name).toBe('execute_tool Read');
      expect(tool.status.code).toBe(id === 'same-name-b' ? 2 : 0);
    }
    expect(tools.find(t => t.attributes['gen_ai.tool.call.id'] === 'same-name-a')!.attributes['gen_ai.tool.call.arguments']).toContain('synthetic-a');
    expect(tools.find(t => t.attributes['gen_ai.tool.call.id'] === 'same-name-a')!.attributes['gen_ai.tool.call.result']).toBe('synthetic result');
    expect(agent.events).toHaveLength(0);
    expect(spans.some(s => ['LLM', 'STEP'].includes(String(s.attributes['gen_ai.span.kind'])))).toBe(false);
    expect(JSON.stringify(spans.map(s => s.attributes))).not.toMatch(/gen_ai.request.model|gen_ai.usage/);
    expect(new Set(spans.map(s => s.spanContext().spanId)).size).toBe(spans.length);
  });

  it('omits an ambiguous call instead of binding one of its duplicate results', async () => {
    const entries = records(), end = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.tool.call.id'] === 'same-name-a')!;
    entries.splice(-1, 0, { ...end, 'event.id': 'different-result-record', time_unix_nano: String(BigInt(end.time_unix_nano) + 1000n) });
    const spans = await convert(entries);
    expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL').map(s => s.attributes['gen_ai.tool.call.id'])).toEqual(['same-name-b']);
  });

  it.each(['wrong-name', 'wrong-actor', 'different-owner', 'wrong-trace', 'outside-owner', 'nonpositive', 'log-only'])(
    'rejects %s boundaries while preserving the other parallel call', async failure => {
      const entries = records(), result = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.tool.call.id'] === 'same-name-a')!;
      const call = entries.find(e => e['event.name'] === 'tool.call' && e['gen_ai.tool.call.id'] === 'same-name-a')!;
      if (failure === 'wrong-name') result['gen_ai.tool.name'] = 'Write';
      if (failure === 'wrong-actor') result['gen_ai.agent.id'] = 'another-actor';
      if (failure === 'different-owner') call['gen_ai.agent.id'] = result['gen_ai.agent.id'] = 'another-actor';
      if (failure === 'wrong-trace') result.trace_id = 'f'.repeat(32);
      if (failure === 'outside-owner') result.time_unix_nano = String(BigInt(entries.at(-1)!.time_unix_nano) + 1n);
      if (failure === 'nonpositive') result.time_unix_nano = call.time_unix_nano;
      if (failure === 'log-only') result['loongsuite.doubao_work.trace_role'] = 'log_only';
      const tools = (await convert(entries)).filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL');
      expect(tools.map(s => s.attributes['gen_ai.tool.call.id'])).toEqual(['same-name-b']);
    },
  );

  it('keeps deterministic tool identity across restart/reconversion and does not invent absent content', async () => {
    const entries = records();
    const first = (await convert(entries)).filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL');
    const second = (await convert(entries)).filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(second.map(s => s.spanContext().spanId)).toEqual(first.map(s => s.spanContext().spanId));
    for (const span of first) {
      expect(span.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
      expect(span.attributes['gen_ai.tool.call.result']).toBeUndefined();
    }
  });

  it('preserves a cancelled local execution as an ERROR tool without changing its real bounds', async () => {
    const entries = records(), result = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.tool.call.id'] === 'same-name-a')!;
    result['tool.result.status'] = 'cancelled';
    const tool = (await convert(entries)).find(s => s.attributes['gen_ai.tool.call.id'] === 'same-name-a')!;
    expect(tool.status.code).toBe(2);
    expect(tool.attributes['error.type']).toBe('doubao.local_tool_cancelled');
    expect(nano(tool.endTime).toString()).toBe(result.time_unix_nano);
  });
});
