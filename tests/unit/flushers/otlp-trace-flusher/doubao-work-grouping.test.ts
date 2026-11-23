import { describe, expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { buildDoubaoTaskEvents, parseDoubaoLogLine } from '../../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine } from '../../../helpers/doubao-work-fixture.js';

function request(platform: 'darwin' | 'win32', offset: number, conversation = '12345678') {
  const queryMs = DOUBAO_EPOCH + offset;
  let line = doubaoLine('on_message_session_end', {
    chat_session_id: 'synthetic-reused-session', query_send_timestamp: queryMs, conversation_id: conversation,
  }, offset + 1000);
  let file = DOUBAO_FILE;
  if (platform === 'win32') {
    file = file.replace('saman_frontend_', 'saman_');
    line = line.replace(/(\.\d{3})\d{3}:INFO:FRONTEND\(0\)/, '$1:INFO:CONSOLE(0)');
  }
  return buildDoubaoTaskEvents('synthetic-scope', {
    turnId: 'synthetic-reused-session', queryMs, conversationId: conversation, updatedMs: queryMs,
  }, parseDoubaoLogLine(line, file)!, Date.now());
}

function collector(spans: ReadableSpan[]) {
  return new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'memory', endpoint: 'http://127.0.0.1:1' }], serviceName: 'grouping-test' }, undefined, () => ({
    export: (batch, callback) => { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
  }));
}

describe.each(['darwin', 'win32'] as const)('Doubao request identity from %s logs', platform => {
  it('exports both requests when a native session ID is reused, while deduplicating replay', async () => {
    const first = request(platform, 0), second = request(platform, 60_000);
    expect(first[0].trace_id).not.toBe(second[0].trace_id);
    const spans: ReadableSpan[] = [], flusher = collector(spans);
    try {
      await flusher.sendBatch(first);
      await vi.waitFor(() => expect(spans).toHaveLength(2));
      // Do not call flush(): it clears the completed-key guard and hides the bug.
      await flusher.sendBatch(second);
      await vi.waitFor(() => expect(spans).toHaveLength(4));
      expect(new Set(spans.map(span => span.spanContext().traceId))).toEqual(new Set([first[0].trace_id, second[0].trace_id]));
      await flusher.sendBatch(first); await flusher.sendBatch(second);
      await flusher.flush();
      expect(spans).toHaveLength(4);
    } finally { await flusher.shutdown(); }
  });

  it('keeps interleaved requests in different conversations separate despite a reused session ID', async () => {
    const first = request(platform, 0), second = request(platform, 100, '87654321');
    const spans: ReadableSpan[] = [], flusher = collector(spans);
    try {
      await flusher.sendBatch([first[0], second[0], first[1], second[1]]);
      await vi.waitFor(() => expect(spans).toHaveLength(4));
      for (const records of [first, second]) {
        const own = spans.filter(span => span.spanContext().traceId === records[0].trace_id);
        expect(own.map(span => span.attributes['gen_ai.span.kind']).sort()).toEqual(['AGENT', 'ENTRY']);
      }
    } finally { await flusher.shutdown(); }
  });

  it('does not suppress another Agent with the same turn ID', async () => {
    const own = request(platform, 0);
    const other = request(platform, 60_000).map(entry => ({ ...entry, 'gen_ai.agent.type': 'claude-code',
      'gen_ai.response.finish_reasons': ['stop'],
    }));
    const spans: ReadableSpan[] = [], flusher = collector(spans);
    try {
      await flusher.sendBatch(own);
      await vi.waitFor(() => expect(spans).toHaveLength(2));
      await flusher.sendBatch(other);
      await vi.waitFor(() => expect(spans).toHaveLength(4));
      expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(2);
    } finally { await flusher.shutdown(); }
  });

  it('keeps reused App requests and colliding background execution IDs separate from Work', async () => {
    const work = request(platform, 0);
    const app = request(platform, 0, '87654321').map(entry => ({ ...entry, 'gen_ai.agent.type': 'doubao',
      'gen_ai.agent.id': 'doubao', 'gen_ai.agent.name': 'Doubao', 'loongsuite.doubao_work.client': 'doubao' }));
    const appSecond = request(platform, 60_000, '87654321').map(entry => ({ ...entry, 'gen_ai.agent.type': 'doubao',
      'gen_ai.agent.id': 'doubao', 'gen_ai.agent.name': 'Doubao', 'loongsuite.doubao_work.client': 'doubao' }));
    const spans: ReadableSpan[] = [], flusher = collector(spans);
    try {
      await flusher.sendBatch([work[0], app[0], work[1], app[1]]);
      await vi.waitFor(() => expect(spans).toHaveLength(4));
      await flusher.sendBatch(appSecond);
      await vi.waitFor(() => expect(spans).toHaveLength(6));
      for (const records of [work, app]) {
        const local = records.map((entry, index) => ({ ...entry,
          time_unix_nano: String(BigInt(entry.time_unix_nano!) + 1000n),
          'gen_ai.turn.start': undefined, 'gen_ai.turn.end': undefined,
          'loongsuite.doubao_work.observation_scope': 'native_sandbox_execution',
          'loongsuite.doubao_work.local_execution_phase': index ? 'end' : 'start',
          'loongsuite.doubao_work.native_execution_id': 'same-native-execution',
          'loongsuite.doubao_work.local_execution_span_id': '1222222222222222',
          'loongsuite.doubao_work.root_request_start_unix_nano': records[0].time_unix_nano,
          'loongsuite.doubao_work.root_request_end_unix_nano': records[1].time_unix_nano,
        }));
        await flusher.sendBatch(local);
      }
      await vi.waitFor(() => expect(spans).toHaveLength(8));
      const tasks = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TASK');
      expect(tasks).toHaveLength(2);
      expect(tasks.map(span => span.attributes['gen_ai.framework']).sort()).toEqual(['doubao', 'doubao-work']);
      await flusher.sendBatch(app); await flusher.sendBatch(appSecond); await flusher.sendBatch(work);
      await flusher.flush(); expect(spans).toHaveLength(8);
    } finally { await flusher.shutdown(); }
  });
});
