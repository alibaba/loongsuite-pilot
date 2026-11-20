import { ROOT_CONTEXT } from '@opentelemetry/api';
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
