import { convertEventLogToTrace, type EventLogRecord, type ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import type { AgentActivityEntry } from '../types/index.js';

type Options = NonNullable<Parameters<typeof convertEventLogToTrace>[1]>;
const BOUNDARY = 'client_received_to_execution_settled';

/** Local execution logs contain no model/React step. Make only the converter's
 * implicit STEP transparent; actual tools remain children of the request AGENT. */
export function convertDoubaoWorkTurn(records: EventLogRecord[], options: Options & { handler: ExtendedTelemetryHandler }) {
  if (records.some(record => record['event.name'] === 'llm.request' || record['event.name'] === 'llm.response')) {
    return convertEventLogToTrace(records, options);
  }
  let steps = 0;
  const wrapped = new Proxy(options.handler, {
    get(target, key) {
      if (key === 'startReactStep') return (inv: Parameters<ExtendedTelemetryHandler['startReactStep']>[0], parent: unknown) => {
        steps++;
        inv.contextToken = parent as typeof inv.contextToken;
        return inv;
      };
      if (key === 'stopReactStep') return (inv: unknown) => inv;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = convertEventLogToTrace(records, { ...options, handler: wrapped });
  return { ...result, spanCount: result.spanCount - steps };
}

function nanoTime(value: string): [number, number] {
  const nano = BigInt(value);
  return [Number(nano / 1_000_000_000n), Number(nano % 1_000_000_000n)];
}

function setTimes(span: ReadableSpan, start: string, end: string): void {
  Object.defineProperties(span, {
    startTime: { value: nanoTime(start), configurable: true },
    endTime: { value: nanoTime(end), configurable: true },
    duration: { value: nanoTime((BigInt(end) - BigInt(start)).toString()), configurable: true },
  });
}

/** Preserve native microsecond boundaries even for tools shorter than one ms.
 * All attributes below are a fixed, content-free projection after masking. */
export function enrichDoubaoWorkTools(records: AgentActivityEntry[], spans: ReadableSpan[]): void {
  const start = records.find(record => record['event.name'] === 'other' && record['gen_ai.turn.start'] === true);
  const terminal = records.find(record => record['event.name'] === 'other' && record['gen_ai.turn.end'] === true);
  const calls = new Map<string, AgentActivityEntry>();
  const results = new Map<string, AgentActivityEntry>();
  for (const record of records) {
    const id = record['gen_ai.tool.call.id'];
    if (typeof id !== 'string' || record['loongsuite.doubao_work.tool_boundary'] !== BOUNDARY) continue;
    if (record['event.name'] === 'tool.call') calls.set(id, record);
    if (record['event.name'] === 'tool.result') results.set(id, record);
  }
  for (const span of spans) {
    if ((span.attributes['gen_ai.span.kind'] === 'ENTRY' || span.attributes['gen_ai.span.kind'] === 'AGENT')
      && start && terminal && BigInt(terminal.time_unix_nano) > BigInt(start.time_unix_nano)) {
      setTimes(span, start.time_unix_nano, terminal.time_unix_nano);
    }
    if (span.attributes['gen_ai.span.kind'] !== 'TOOL') continue;
    const id = span.attributes['gen_ai.tool.call.id'];
    if (typeof id !== 'string') continue;
    const call = calls.get(id);
    const result = results.get(id);
    if (!call || !result || BigInt(result.time_unix_nano) <= BigInt(call.time_unix_nano)) continue;
    const status = result['tool.result.status'];
    span.attributes['gen_ai.framework'] = 'doubao-work';
    span.attributes['loongsuite.doubao_work.tool_boundary'] = BOUNDARY;
    span.attributes['gen_ai.tool.call.duration'] = Number(BigInt(result.time_unix_nano) - BigInt(call.time_unix_nano)) / 1_000_000;
    if (status === 'success' || status === 'error' || status === 'cancelled') {
      span.attributes['tool.result.status'] = status;
      Object.assign(span.status, { code: status === 'success' ? SpanStatusCode.UNSET : SpanStatusCode.ERROR });
      if (status !== 'success') span.attributes['error.type'] = status === 'cancelled' ? 'doubao.local_tool_cancelled' : 'doubao.local_tool_failed';
    }
    setTimes(span, call.time_unix_nano, result.time_unix_nano);
  }
}
