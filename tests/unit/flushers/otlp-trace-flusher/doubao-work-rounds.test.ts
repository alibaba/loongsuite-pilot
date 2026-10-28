import { describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { buildDoubaoTaskEvents, parseDoubaoLogLine } from '../../../../src/inputs/doubao-work/doubao-work-log.js';
import { nativeToolObservations, parseNativeContent } from '../../../../src/inputs/doubao-work/doubao-work-content.js';
import { buildNativeExecutionEvents, type NativeExecution } from '../../../../src/inputs/doubao-work/doubao-work-execution.js';
import { parseNativeGraph } from '../../../../src/inputs/doubao-work/doubao-work-native.js';
import { reconstructNativeRounds } from '../../../../src/inputs/doubao-work/doubao-work-rounds.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, DOUBAO_NATIVE_FILES, doubaoLine, doubaoToolLine } from '../../../helpers/doubao-work-fixture.js';
import type { AgentActivityEntry, JsonValue } from '../../../../src/types/index.js';

const actor = 'm_rounds';
const assistant = (ids: string[], name = 'Read') => ({ role: 'assistant', content: 'visible output',
  tool_calls: ids.map(id => ({ id, function: { name, arguments: { file_path: id } } })) });
const result = (id: string, content = `result ${id}`) => ({ role: 'tool', tool_call_id: id, content });
const final = { role: 'assistant', content: 'visible final' };
const nano = (time: number[]) => BigInt(time[0]) * 1_000_000_000n + BigInt(time[1]);
const ns = (ms: number) => BigInt(DOUBAO_EPOCH + ms) * 1_000_000n;
const sourceNs = (ms: number) => ns(ms) + 123_000n;

function entries(rows: unknown[], intervals: { id: string; start: number; end: number; status?: string }[]): AgentActivityEntry[] {
  const pairs = intervals.map(tool => ({
    start: parseDoubaoLogLine(doubaoToolLine({ tcid: tool.id, name: 'Read' }, tool.start).trimEnd(), DOUBAO_FILE)!,
    end: parseDoubaoLogLine(doubaoToolLine({ toolCallID: tool.id, name: 'Read', phase: 'execution_settled', status: tool.status ?? 'success' }, tool.end).trimEnd(), DOUBAO_FILE)!,
  }));
  const records = buildDoubaoTaskEvents('rounds', { turnId: 'synthetic-turn', conversationId: 'synthetic-conversation',
    queryMs: DOUBAO_EPOCH, updatedMs: DOUBAO_EPOCH }, parseDoubaoLogLine(doubaoLine('on_message_session_end', {}, 10_000), DOUBAO_FILE)!, Date.now(), pairs)
    .map(record => ({ ...record, 'gen_ai.agent.id': actor }));
  const content = parseNativeContent({ [actor]: rows.map(row => JSON.stringify(row)).join('\n') + '\n' },
    { [actor]: `## [${new Date(DOUBAO_EPOCH + 10).toISOString()}] 需求\nVISIBLE_INPUT\n` });
  const reconstruction = reconstructNativeRounds(content, actor, DOUBAO_EPOCH, ns(10_000).toString(), intervals.map(tool => tool.id));
  records[0]['agent.doubao_work.assistant_rounds'] = reconstruction as unknown as JsonValue;
  return records;
}
async function convert(records: AgentActivityEntry[]) {
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ endpoint: 'http://127.0.0.1:4318' }], serviceName: 'doubao-rounds' }, undefined,
    () => ({ export: (batch, cb) => { spans.push(...batch); cb({ code: 0 }); }, shutdown: async () => {} }));
  try { await flusher.sendBatch(records); await flusher.flush(); return spans; } finally { await flusher.shutdown(); }
}

describe('Doubao assistant rounds through the actual OTLP converter', () => {
  it('exports four LLM decisions and five tools, preserving real parallel tool times and exact input/output', async () => {
    const source = [assistant(['write']), result('write'), assistant(['a', 'b', 'c']), result('b'), result('c'), result('a'), assistant(['recover']), result('recover'), final];
    const records = entries(source, [{ id: 'write', start: 1000, end: 1100 }, { id: 'a', start: 2000, end: 2300 },
      { id: 'b', start: 2100, end: 2400 }, { id: 'c', start: 2200, end: 2500, status: 'error' }, { id: 'recover', start: 5000, end: 5200 }]);
    const spans = await convert(records);
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    const steps = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'STEP');
    const tools = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
    expect([llms.length, steps.length, tools.length, spans.length]).toEqual([4, 4, 5, 15]);
    expect(llms.map(span => JSON.parse(String(span.attributes['gen_ai.input.messages'])).length)).toEqual([1, 3, 7, 9]);
    expect(llms.map(span => [nano(span.startTime), nano(span.endTime)])).toEqual([
      [ns(0), sourceNs(1000)], [sourceNs(1100), sourceNs(2000)], [sourceNs(2500), sourceNs(5000)], [sourceNs(5200), sourceNs(10_000)],
    ]);
    expect(JSON.parse(String(llms[1].attributes['gen_ai.output.messages']))[0].parts.filter((part: { type: string }) => part.type === 'tool_call')).toHaveLength(3);
    for (const tool of tools) {
      const start = records.find(record => record['event.name'] === 'tool.call' && record['gen_ai.tool.call.id'] === tool.attributes['gen_ai.tool.call.id'])!;
      const end = records.find(record => record['event.name'] === 'tool.result' && record['gen_ai.tool.call.id'] === tool.attributes['gen_ai.tool.call.id'])!;
      expect(nano(tool.startTime).toString()).toBe(start.time_unix_nano);
      expect(nano(tool.endTime).toString()).toBe(end.time_unix_nano);
      const owner = steps.find(step => step.spanContext().spanId === tool.parentSpanId)!;
      expect(owner).toBeDefined();
      expect(nano(owner.startTime)).toBeLessThanOrEqual(nano(tool.startTime));
      expect(nano(owner.endTime)).toBeGreaterThanOrEqual(nano(tool.endTime));
    }
    expect(tools.find(tool => tool.attributes['gen_ai.tool.call.id'] === 'c')!.status.code).toBe(2);
    expect(llms.every(span => span.status.code === 0 && span.name === 'chat')).toBe(true);
    expect(JSON.stringify(llms.map(span => span.attributes))).not.toMatch(/gen_ai.request.model|gen_ai.response.model|gen_ai.response.id|gen_ai.usage|reconstructed|finish_reason/);
    expect(new Set(spans.map(span => span.spanContext().spanId)).size).toBe(spans.length);
    const second = await convert(records);
    const stable = (values: ReadableSpan[]) => values.filter(span => span.attributes['gen_ai.span.kind'] !== 'ENTRY').map(span => span.spanContext().spanId);
    expect(stable(second)).toEqual(stable(spans));
  });

  it('bounds untimed coordination calls between adjacent source anchors and retains an explicit error result', async () => {
    const source = [assistant(['create'], 'create_agent'), result('create', 'create_agent failed: capacity limit'),
      assistant(['send'], 'send_message'), result('send', 'send_message ok'), assistant(['local']), result('local'), final];
    const spans = await convert(entries(source, [{ id: 'local', start: 6000, end: 6500 }]));
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms).toHaveLength(4);
    const create = spans.find(span => span.attributes['gen_ai.tool.call.id'] === 'create')!;
    const gap = sourceNs(6000) - ns(0);
    expect([nano(create.startTime), nano(create.endTime)]).toEqual([ns(0) + gap / 5n, ns(0) + gap * 2n / 5n]);
    expect(create.status.code).toBe(2);
    expect(create.attributes['gen_ai.tool.call.result']).toBe('create_agent failed: capacity limit');
    const send = spans.find(span => span.attributes['gen_ai.tool.call.id'] === 'send')!;
    expect([nano(send.startTime), nano(send.endTime)]).toEqual([ns(0) + gap * 3n / 5n, ns(0) + gap * 4n / 5n]);
    expect(send.attributes['tool.result.status']).toBeUndefined();
    for (const span of spans) {
      expect(nano(span.startTime)).toBeGreaterThanOrEqual(ns(0));
      expect(nano(span.endTime)).toBeLessThanOrEqual(sourceNs(10_000));
    }
  });

  it('keeps the native Wait interval out of the estimated LLM latency', async () => {
    const wait = JSON.stringify({ requested_seconds: 4, actual_waited_seconds: 4,
      started_at: new Date(DOUBAO_EPOCH + 4000).toISOString(), ended_at: new Date(DOUBAO_EPOCH + 8000).toISOString() });
    const source = [assistant(['wait'], 'Wait'), result('wait', wait), assistant(['local']), result('local'), final];
    const spans = await convert(entries(source, [{ id: 'local', start: 9000, end: 9100 }]));
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms.map(span => [nano(span.startTime), nano(span.endTime)])).toEqual([
      [ns(0), ns(4000)], [ns(8000), sourceNs(9000)], [sourceNs(9100), sourceNs(10_000)],
    ]);
    const tool = spans.find(span => span.attributes['gen_ai.tool.call.id'] === 'wait')!;
    expect([nano(tool.startTime), nano(tool.endTime)]).toEqual([ns(4000), ns(8000)]);
  });

  it('does not turn an orphan transcript intent into a completed tool', async () => {
    const spans = await convert(entries([assistant(['unfinished']), final], []));
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(2);
    expect(spans.some(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toBe(false);
  });

  it('keeps a child fragment and its rounds under the exact native TASK, without importing later coordination', async () => {
    const root = { turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH, conversationId: '12345678',
      localMessageId: '00000000-0000-4000-8000-000000000002', updatedMs: DOUBAO_EPOCH,
      terminal: parseDoubaoLogLine(doubaoLine('on_message_session_end', {}, 10000), DOUBAO_FILE)! };
    const execution: NativeExecution = { executionKey: '00000000-0000-4000-8000-000000000003',
      conversationId: root.conversationId, queryMessageId: root.localMessageId, agentId: 's_nativeLeaf', agentType: 'sub_agent',
      sandboxId: 'synthetic-sandbox', startedAtMs: DOUBAO_EPOCH + 5000, endedAtMs: DOUBAO_EPOCH + 8000 };
    const pair = {
      start: parseDoubaoLogLine(doubaoToolLine({ agent_id: execution.agentId, tcid: 'child-read' }, 6000).trimEnd(), DOUBAO_FILE)!,
      end: parseDoubaoLogLine(doubaoToolLine({ toolCallID: 'child-read', status: 'success', phase: 'execution_settled' }, 6500).trimEnd(), DOUBAO_FILE)!,
    };
    const rows = [assistant(['child-read']), result('child-read'), final,
      assistant(['later'], 'send_message'), result('later', 'LATER_COORDINATION')];
    const content = parseNativeContent({ [execution.agentId]: rows.map(row => JSON.stringify(row)).join('\n') + '\n' },
      { [execution.agentId]: `## [${new Date(DOUBAO_EPOCH + 10).toISOString()}] 需求\nCHILD_INPUT\n` });
    const records = buildNativeExecutionEvents('child-scope', root, parseNativeGraph(DOUBAO_NATIVE_FILES)!, execution, [execution], Date.now());
    for (const record of records) { delete record['gen_ai.turn.id']; delete record['gen_ai.agent.scope']; }
    records[0]['agent.doubao_work.tool_observations'] = nativeToolObservations([pair], content);
    records[0]['agent.doubao_work.assistant_rounds'] = reconstructNativeRounds(content, execution.agentId, DOUBAO_EPOCH,
      ns(8000).toString(), ['child-read'], 'local_execution_fragment') as unknown as JsonValue;
    const spans = await convert([...buildDoubaoTaskEvents('child-scope', root, root.terminal, Date.now()), ...records]);
    const task = spans.find(span => span.attributes['gen_ai.span.kind'] === 'TASK')!;
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    const steps = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'STEP');
    const tools = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
    expect([llms.length, steps.length, tools.length]).toEqual([2, 2, 1]);
    expect(llms.every(span => span.attributes['gen_ai.agent.id'] === execution.agentId
      && span.attributes['gen_ai.turn.id'] === root.turnId)).toBe(true);
    expect(steps.every(span => span.parentSpanId === task.spanContext().spanId)).toBe(true);
    expect(tools[0].parentSpanId).toBe(steps[0].spanContext().spanId);
    expect([nano(task.startTime), nano(task.endTime)]).toEqual([ns(5000), ns(8000)]);
    expect(llms.map(span => [nano(span.startTime), nano(span.endTime)])).toEqual([
      [ns(5000), sourceNs(6000)], [sourceNs(6500), ns(8000)],
    ]);
    expect(JSON.stringify(llms.map(span => span.attributes))).not.toContain('LATER_COORDINATION');
  });

  it('rejects inconsistent temporal order without losing the separately evidenced local tools', async () => {
    const source = [assistant(['late']), result('late'), assistant(['early']), result('early'), final];
    const spans = await convert(entries(source, [{ id: 'late', start: 7000, end: 8000 }, { id: 'early', start: 1000, end: 2000 }]));
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toHaveLength(2);
    expect(spans.some(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toBe(false);
  });
});
