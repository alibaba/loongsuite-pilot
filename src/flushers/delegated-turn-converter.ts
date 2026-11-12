// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import { convertEventLogToTrace, type ExtendedTelemetryHandler, type EventLogRecord } from '@loongsuite/otel-util-genai';

import { ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import type { ReservedSpanIdGenerator } from './span-id-reservation.js';

type Options = NonNullable<Parameters<typeof convertEventLogToTrace>[1]>;

/** A delegated run keeps its own turn/buffer, including when its parent already
 * exported. The producer supplies the actual reserved TOOL span id. Reuse the
 * converter, making only the child's virtual ENTRY transparent (as Qwen does).
 * No parent waiting, timestamp stretching, replay or token aggregation. */
export function convertDelegatedTurn(records: EventLogRecord[], options: Options & { handler: ExtendedTelemetryHandler }) {
  const prepared = prepareDelegatedTurn(records, options.handler);
  const result = convertEventLogToTrace(prepared.records, { ...options, handler: prepared.handler });
  return { ...result, spanCount: result.spanCount - prepared.removedEntryCount };
}

/** Share the transparent child ENTRY contract with incremental conversion. */
export function prepareDelegatedTurn(records: EventLogRecord[], handler: ExtendedTelemetryHandler, idGenerator?: ReservedSpanIdGenerator) {
  const marker = records.find(r => r['gen_ai.agent.scope'] === 'subagent' && r['parent_span_id']);
  if (!marker || !/^[0-9a-f]{32}$/.test(String(marker.trace_id))
    || !/^[0-9a-f]{16}$/.test(String(marker.parent_span_id))
    || /^0+$/.test(String(marker.trace_id)) || /^0+$/.test(String(marker.parent_span_id))
    || records.some(r => r.trace_id !== marker.trace_id || r.parent_span_id !== marker.parent_span_id)) {
    return prepareIndependentTurn(records, handler, idGenerator);
  }
  const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: String(marker.trace_id), spanId: String(marker.parent_span_id), traceFlags: TraceFlags.SAMPLED,
  });
  let entries = 0;
  const wrapped = new Proxy(handler, {
    get(target, key) {
      if (key === 'startEntry') return (inv: Parameters<ExtendedTelemetryHandler['startEntry']>[0]) => {
        entries++;
        inv.contextToken = parentContext;
        return inv;
      };
      if (key === 'stopEntry') return (inv: unknown) => inv;
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (String(key).startsWith('start')) return (inv: { passthroughAttributes?: Record<string, unknown> }, ...args: unknown[]) => {
        inv.passthroughAttributes = { ...inv.passthroughAttributes, 'gen_ai.agent.scope': 'subagent' };
        return value.call(target, inv, ...args);
      };
      return value.bind(target);
    },
  });
  const local = records.map(r => {
    const copy = { ...r };
    delete copy['gen_ai.agent.scope']; // do not treat a standalone child as an inline child group
    return copy;
  });
  return { records: local, handler: wrapped, get removedEntryCount() { return entries; } };
}

/** beta.13 uses a virtual parent to preserve a producer's trace id. When no
 * upstream context was supplied, start a genuine SDK root with that same id.
 * Explicit upstream parents (including 000...001) and delegated TOOL parents
 * remain authoritative. Never rewrite an ended/exported span. */
function prepareIndependentTurn(records: EventLogRecord[], handler: ExtendedTelemetryHandler, idGenerator?: ReservedSpanIdGenerator) {
  if (!idGenerator) return { records, handler, removedEntryCount: 0 };
  const independent = new Set(records.map(record => record.trace_id));
  for (const record of records) {
    if (record['event.name'] === 'other' && /^[0-9a-f]{16}$/.test(String(record.parent_span_id))
      && !/^0+$/.test(String(record.parent_span_id))) independent.delete(record.trace_id);
  }
  const wrapped = new Proxy(handler, {
    get(target, key) {
      if (key === 'startEntry') return (...args: Parameters<ExtendedTelemetryHandler['startEntry']>) => {
        const parent = args[1] && trace.getSpanContext(args[1]);
        if (!parent || parent.spanId !== '0000000000000001' || !independent.has(parent.traceId)) {
          return target.startEntry(...args);
        }
        idGenerator.reserveTraceId(parent.traceId);
        try { return target.startEntry(args[0], ROOT_CONTEXT, args[2]); }
        finally { idGenerator.clearTraceId(); }
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { records, handler: wrapped, removedEntryCount: 0 };
}
