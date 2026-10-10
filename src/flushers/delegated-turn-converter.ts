// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import { convertEventLogToTrace, type ExtendedTelemetryHandler, type EventLogRecord } from '@loongsuite/otel-util-genai';

import { ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';

type Options = NonNullable<Parameters<typeof convertEventLogToTrace>[1]>;

/** A delegated run keeps its own turn/buffer, including when its parent already
 * exported. The producer supplies the actual reserved TOOL span id. Reuse the
 * converter, making only the child's virtual ENTRY transparent (as Qwen does).
 * No parent waiting, timestamp stretching, replay or token aggregation. */
export function convertDelegatedTurn(records: EventLogRecord[], options: Options & { handler: ExtendedTelemetryHandler }) {
  const marker = records.find(r => r['gen_ai.agent.scope'] === 'subagent' && r['parent_span_id']);
  if (!marker || !/^[0-9a-f]{32}$/.test(String(marker.trace_id))
    || !/^[0-9a-f]{16}$/.test(String(marker.parent_span_id))
    || /^0+$/.test(String(marker.trace_id)) || /^0+$/.test(String(marker.parent_span_id))
    || records.some(r => r.trace_id !== marker.trace_id || r.parent_span_id !== marker.parent_span_id)) {
    return convertEventLogToTrace(records, options);
  }
  const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: String(marker.trace_id), spanId: String(marker.parent_span_id), traceFlags: TraceFlags.SAMPLED,
  });
  const handler = options.handler;
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
  const result = convertEventLogToTrace(local, { ...options, handler: wrapped });
  return { ...result, spanCount: result.spanCount - entries };
}
