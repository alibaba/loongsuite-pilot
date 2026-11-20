import { ROOT_CONTEXT, trace, createTraceState } from '@opentelemetry/api';
import type { ExtendedTelemetryHandler, EventLogRecord } from '@loongsuite/otel-util-genai';
import type { ReservedSpanIdGenerator } from './span-id-reservation.js';

function agreed(records: EventLogRecord[], key: string): unknown {
  const values = new Set(records.map(record => record[key]).filter(value => value !== undefined));
  return values.size === 1 ? [...values][0] : undefined;
}

export function withTraceContextParent(records: EventLogRecord[], handler: ExtendedTelemetryHandler,
  idGenerator: ReservedSpanIdGenerator): ExtendedTelemetryHandler {
  const bindingId = agreed(records, 'agent.pilot.context.binding_id');
  const traceId = agreed(records, 'trace_id');
  const entrySpanId = agreed(records, 'agent.pilot.context.entry_span_id');
  const agentSpanId = agreed(records, 'agent.pilot.context.agent_span_id');
  const upstream = agreed(records, 'agent.pilot.context.upstream_span_id');
  const flags = agreed(records, 'agent.pilot.context.flags');
  const tracestate = agreed(records, 'agent.pilot.context.tracestate');
  const required = ['trace_id', 'agent.pilot.context.binding_id', 'agent.pilot.context.entry_span_id',
    'agent.pilot.context.agent_span_id', 'agent.pilot.context.flags'];
  if (typeof bindingId !== 'string' || typeof traceId !== 'string' || !/^[0-9a-f]{32}$/.test(traceId)
    || /^0+$/.test(traceId) || typeof entrySpanId !== 'string' || !/^[0-9a-f]{16}$/.test(entrySpanId)
    || typeof agentSpanId !== 'string' || !/^[0-9a-f]{16}$/.test(agentSpanId) || entrySpanId === agentSpanId
    || /^0+$/.test(entrySpanId) || /^0+$/.test(agentSpanId) || typeof flags !== 'number' || !Number.isInteger(flags)
    || flags < 0 || flags > 255 || !required.every(key => records.every(record => record[key] === records[0]?.[key]))
    || (records.some(record => record['agent.pilot.context.upstream_span_id'] !== undefined)
      && (typeof upstream !== 'string' || !/^[0-9a-f]{16}$/.test(upstream) || /^0+$/.test(upstream)
        || upstream === entrySpanId || upstream === agentSpanId))
    || (records.some(record => record['agent.pilot.context.tracestate'] !== undefined) && typeof tracestate !== 'string')) return handler;
  const parent = typeof upstream === 'string' && /^[0-9a-f]{16}$/.test(upstream) && !/^0+$/.test(upstream)
    ? trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId: upstream, traceFlags: flags, isRemote: true,
      ...(typeof tracestate === 'string' ? { traceState: createTraceState(tracestate) } : {}) }) : ROOT_CONTEXT;
  const started = agreed(records, 'agent.pilot.context.started_ms');
  let entryInvocation: ReturnType<ExtendedTelemetryHandler['startEntry']> | undefined;
  let rootAgent: ReturnType<ExtendedTelemetryHandler['startInvokeAgent']> | undefined;
  return new Proxy(handler, {
    get(target, key) {
      if (key === 'startEntry') return (invocation: Parameters<ExtendedTelemetryHandler['startEntry']>[0], _parent: unknown, start: number | undefined) => {
        const effectiveStart = typeof started === 'number' ? Math.min(start ?? started, started) : start;
        if (parent === ROOT_CONTEXT) idGenerator.reserveTraceId(traceId);
        try {
          entryInvocation = idGenerator.withAuthoritativeSpanId(entrySpanId, () => target.startEntry(invocation, parent, effectiveStart));
          return entryInvocation;
        } finally { idGenerator.clearTraceId(); }
      };
      if (key === 'startInvokeAgent') return (invocation: Parameters<ExtendedTelemetryHandler['startInvokeAgent']>[0], context: Parameters<ExtendedTelemetryHandler['startInvokeAgent']>[1], start: number | undefined) => {
        const entryId = entryInvocation?.span?.spanContext().spanId;
        const isRoot = !rootAgent && entryId && context && trace.getSpanContext(context)?.spanId === entryId;
        if (!isRoot) return target.startInvokeAgent(invocation, context, start);
        rootAgent = idGenerator.withAuthoritativeSpanId(agentSpanId, () => target.startInvokeAgent(invocation, context,
          typeof started === 'number' ? Math.min(start ?? started, started) : start));
        return rootAgent;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
