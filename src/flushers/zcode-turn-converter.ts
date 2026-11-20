import { ROOT_CONTEXT } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { EventLogRecord, ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import { deriveSpanId } from '../../assets/hooks/shared/event-emitter.mjs';
import type { ReservedSpanIdGenerator } from './span-id-reservation.js';

/** ZCode's envelope parents are local edges, not upstream trace context. */
export function prepareZCodeTurn(
  records: EventLogRecord[],
  { handler, idGenerator }: { handler: ExtendedTelemetryHandler; idGenerator: ReservedSpanIdGenerator },
) {
  const first = records[0];
  const traceId = first?.trace_id;
  const sessionId = first?.['gen_ai.session.id'];
  const turnId = first?.['gen_ai.turn.id'];
  if (typeof traceId !== 'string' || !/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)
      || typeof sessionId !== 'string' || !sessionId || typeof turnId !== 'string' || !turnId) {
    return { records, handler, removedEntryCount: 0 };
  }
  const entryId = deriveSpanId('entry', sessionId);
  const agentId = deriveSpanId('agent', sessionId, turnId);
  const conversionRecords = records.map(record => {
    if (record['event.name'] !== 'other'
        || (record.parent_span_id !== entryId && record.parent_span_id !== agentId)) return record;
    const { parent_span_id: _localParent, ...local } = record;
    return local;
  });
  const hasUpstream = conversionRecords.some(record => record['event.name'] === 'other' && record.parent_span_id);
  function reserve<T>(id: string, start: () => T): T {
    idGenerator.reserve(id);
    try { return start(); } finally { idGenerator.clear(); }
  }
  const overrides: Partial<ExtendedTelemetryHandler> = {
    startEntry(inv, context, start) {
      if (hasUpstream) return reserve(entryId, () => handler.startEntry(inv, context, start));
      idGenerator.reserveTraceId(traceId);
      try {
        return reserve(entryId, () => handler.startEntry(inv, ROOT_CONTEXT, start));
      } finally { idGenerator.clearTraceId(); }
    },
    startInvokeAgent(inv, context, start) {
      return reserve(agentId, () => handler.startInvokeAgent(inv, context, start));
    },
  };
  const wrapped = new Proxy(handler, {
    get(target, key) {
      const override = overrides[key as keyof ExtendedTelemetryHandler];
      if (override) return override;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { records: conversionRecords, handler: wrapped, removedEntryCount: 0 };
}


/** A request to call a tool is an observation even when no outcome is recorded. */
export function markZCodeToolObservations(records: EventLogRecord[], spans: ReadableSpan[]): void {
  const calls = new Map<string, EventLogRecord>();
  const results = new Set<string>();
  const stepStarts = new Map<string, bigint>();
  for (const record of records) {
    if (record['agent.source'] !== 'zcode-rollout') continue;
    const spanId = record.span_id;
    const stepId = record['gen_ai.step.id'];
    const time = record.time_unix_nano;
    if (record['event.name'] === 'tool.call' && typeof spanId === 'string') calls.set(spanId, record);
    if (record['event.name'] === 'tool.result' && typeof spanId === 'string') results.add(spanId);
    if (record['event.name'] === 'llm.request' && typeof stepId === 'string' && typeof time === 'string' && /^\d+$/.test(time)) {
      stepStarts.set(stepId, BigInt(time));
    }
  }
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    if (span.attributes['gen_ai.span.kind'] !== 'TOOL') continue;
    const spanId = span.spanContext().spanId;
    if (results.has(spanId)) continue;
    const call = calls.get(spanId);
    if (!call) continue;
    span.attributes['agent.zcode.tool.result_observed'] = false;

    const [seconds, nanos] = span.endTime;
    if (span.startTime[0] !== seconds || span.startTime[1] !== nanos) continue;
    const stepStart = stepStarts.get(String(call['gen_ai.step.id']));
    const observedAt = BigInt(seconds) * 1_000_000_000n + BigInt(nanos);
    if (stepStart === undefined || stepStart >= observedAt) continue;
    // Encode the instantaneous observation within its existing STEP. The
    // native timestamp remains the interval's end and no result is supplied.
    spans[index] = {
      ...span,
      startTime: nanos === 0 ? [seconds - 1, 999_999_999] : [seconds, nanos - 1],
      duration: [0, 1],
      spanContext: () => span.spanContext(),
      ended: span.ended,
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
    };
  }
}
