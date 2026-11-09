import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

const directories: string[] = [];
const flushers: OtlpTraceFlusher[] = [];
const epoch = 1_794_220_000_000;
const time = (offset: number) => String(BigInt(epoch + offset) * 1_000_000n);

async function createFlusher() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hermes-idle-'));
  directories.push(dir);
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({
    enabled: true, serviceName: 'synthetic-hermes-idle', protocol: 'http/protobuf',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
    dataDir: dir, turnIdleTimeoutMs: 60_000,
  }, undefined, () => ({
    export(batch, callback) { spans.push(...batch); callback({ code: 0 }); },
    async shutdown() {},
  }));
  flushers.push(flusher);
  return { flusher, spans };
}

function record(name: string, index: number, extra: Record<string, unknown> = {}): AgentActivityEntry {
  return {
    'event.name': name, 'event.id': `synthetic-${name}-${index}`,
    time_unix_nano: time(index * 100), trace_id: 'aa'.repeat(16),
    'gen_ai.agent.type': 'hermes', 'agent.hermes.collection': 'realtime-v1',
    'gen_ai.agent.name': 'synthetic-hermes', 'gen_ai.session.id': 'synthetic-session',
    'gen_ai.turn.id': 'synthetic-turn', 'gen_ai.step.id': `synthetic-turn:s${index}`,
    'gen_ai.provider.name': 'test', 'gen_ai.request.model': 'synthetic-model',
    ...extra,
  } as AgentActivityEntry;
}

function api(index: number): AgentActivityEntry[] {
  const spanId = index.toString(16).padStart(16, '0');
  return [record('llm.request', index, {
    span_id: spanId,
    'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: `input ${index}` }] }],
  }), record('llm.response', index, {
    span_id: spanId, time_unix_nano: time(index * 100 + 50),
    'gen_ai.response.id': `response-${index}`, 'gen_ai.response.finish_reasons': ['stop'],
    'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 2,
    'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: `answer ${index}` }] }],
  })];
}

afterEach(async () => {
  for (const flusher of flushers.splice(0)) await flusher.shutdown();
  vi.useRealTimers();
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('realtime Hermes idle timeout', () => {
  it('exports all 20 calls after a long gap, with one root pair and source token totals', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const { flusher, spans } = await createFlusher();
    await flusher.sendBatch([1, 2, 3].flatMap(api));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(spans).toHaveLength(0);
    expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({ pending_buffers: 1, pending_records: 6 });
    await flusher.sendBatch([
      ...Array.from({ length: 17 }, (_, i) => i + 4).flatMap(api),
      record('other', 20, { 'gen_ai.turn.end': true }),
    ]);
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms).toHaveLength(20);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'ENTRY')).toHaveLength(1);
    const agents = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
    expect(agents).toHaveLength(1);
    expect(agents[0].attributes['gen_ai.usage.input_tokens']).toBe(200);
    expect(agents[0].attributes['gen_ai.usage.output_tokens']).toBe(40);
    expect(new Set(spans.map(span => span.spanContext().spanId)).size).toBe(spans.length);
    expect(llms.map(span => span.attributes['gen_ai.response.id']).sort())
      .toEqual(Array.from({ length: 20 }, (_, i) => `response-${i + 1}`).sort());
    expect(llms.reduce((sum, span) => sum + Number(span.attributes['gen_ai.usage.input_tokens']), 0)).toBe(200);
    expect(llms.reduce((sum, span) => sum + Number(span.attributes['gen_ai.usage.output_tokens']), 0)).toBe(40);
    expect(flusher.getTraceRuntimeSnapshot()[0].pending_records).toBe(0);
  });

  it('retains a pending tool across the timeout until its real result arrives', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const { flusher, spans } = await createFlusher();
    await flusher.sendBatch([
      ...api(1),
      record('tool.call', 1, { time_unix_nano: time(175), span_id: 'cc'.repeat(8),
        'gen_ai.tool.call.id': 'synthetic-tool', 'gen_ai.tool.name': 'terminal',
        'gen_ai.tool.call.arguments': { command: 'synthetic command' } }),
    ]);
    await vi.advanceTimersByTimeAsync(62_000);
    expect(spans).toHaveLength(0);
    const second = api(2);
    second[0].time_unix_nano = time(62_100);
    second[1].time_unix_nano = time(62_150);
    await flusher.sendBatch([
      record('tool.result', 1, { time_unix_nano: time(62_000), span_id: 'cc'.repeat(8),
        'gen_ai.tool.call.id': 'synthetic-tool', 'gen_ai.tool.name': 'terminal',
        'gen_ai.tool.call.result': { output: 'synthetic result' } }),
      ...second,
      record('other', 2, { time_unix_nano: time(62_151), 'gen_ai.turn.end': true }),
    ]);
    const tools = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(tools).toHaveLength(1);
    expect(tools[0].spanContext().spanId).toBe('cc'.repeat(8));
    expect(tools[0].attributes['gen_ai.tool.call.id']).toBe('synthetic-tool');
    expect(JSON.parse(String(tools[0].attributes['gen_ai.tool.call.arguments'])))
      .toEqual({ command: 'synthetic command' });
    expect(JSON.parse(String(tools[0].attributes['gen_ai.tool.call.result'])))
      .toEqual({ output: 'synthetic result' });
    expect(tools[0].duration[0] * 1000 + tools[0].duration[1] / 1e6).toBe(61_825);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(2);
  });

  it.each(['hermes', 'claude-code'])('preserves legacy %s idle flushing', async agentType => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const { flusher, spans } = await createFlusher();
    const records = api(1).map(entry => ({ ...entry, 'gen_ai.agent.type': agentType,
      'agent.hermes.collection': undefined, 'gen_ai.response.finish_reasons': ['tool_calls'] }));
    await flusher.sendBatch(records);
    await vi.advanceTimersByTimeAsync(62_000);
    await vi.waitFor(() => expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1));
  });
});
