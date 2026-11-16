import { trace } from '@opentelemetry/api';
import type { ExtendedTelemetryHandler, EventLogRecord } from '@loongsuite/otel-util-genai';
import { extractUpstreamContext } from '../core/upstream-link/w3c-context.js';

export function withUpstreamContextParent(records: EventLogRecord[], handler: ExtendedTelemetryHandler): ExtendedTelemetryHandler {
  const marker = records.find(record => typeof record['agent.pilot.upstream.traceparent'] === 'string');
  if (!marker || records.some(record => record['gen_ai.agent.scope'] === 'subagent' || record['agent.codex.delegated'] === true
    || record['agent.pilot.upstream.traceparent'] !== marker['agent.pilot.upstream.traceparent']
    || record['agent.pilot.upstream.tracestate'] !== marker['agent.pilot.upstream.tracestate'])) return handler;
  const parent = extractUpstreamContext({ traceparent: marker['agent.pilot.upstream.traceparent'], tracestate: marker['agent.pilot.upstream.tracestate'] });
  if (!parent || records.some(record => record.trace_id !== trace.getSpanContext(parent)?.traceId)) return handler;
  return new Proxy(handler, {
    get(target, key) {
      if (key === 'startEntry') return (invocation: Parameters<ExtendedTelemetryHandler['startEntry']>[0], _parent: unknown, start?: number) => target.startEntry(invocation, parent, start);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
