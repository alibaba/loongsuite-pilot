import { convertEventLogToTrace, type EventLogRecord, type ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import { ROOT_CONTEXT, SpanKind, TraceFlags, trace, type Attributes, type Span, type Tracer } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../types/index.js';
import { doubaoRootAgentSpanId } from '../inputs/doubao-work/doubao-work-log.js';

type Options = NonNullable<Parameters<typeof convertEventLogToTrace>[1]> & { observationTracer?: Tracer };
const PREFIX = 'loongsuite.doubao_work.';

/** The current passive producer proves client requests and local tool facts.
 * It does not prove model requests, ReAct timing, or delegated invocations.
 * Keep those facts in the event output, but never promote partial observations
 * into standard invocation spans or fabricate a STEP to accommodate a TOOL.
 */
export function convertDoubaoWorkTurn(records: EventLogRecord[], options: Options) {
  const native = records.find(record => record[`${PREFIX}observation_scope`] === 'native_sandbox_execution');
  if (native) return convertLocalExecution(records, options);
  const boundaries = records.filter(record => record['event.name'] === 'other'
    && record[`${PREFIX}observation_scope`] === 'client_message'
    && (record['gen_ai.turn.start'] === true || record['gen_ai.turn.end'] === true));
  const start = boundaries.find(record => record['gen_ai.turn.start'] === true);
  const end = boundaries.find(record => record['gen_ai.turn.end'] === true);
  if (!start || !end || boundaries.length !== 2
    || start['gen_ai.turn.id'] !== end['gen_ai.turn.id']
    || start['gen_ai.session.id'] !== end['gen_ai.session.id']
    || typeof start.time_unix_nano !== 'string' || !/^\d{19}$/.test(start.time_unix_nano)
    || typeof end.time_unix_nano !== 'string' || !/^\d{19}$/.test(end.time_unix_nano)
    || BigInt(end.time_unix_nano) <= BigInt(start.time_unix_nano)) {
    return { spanCount: 0, traceIds: [], warnings: ['Doubao observation has no evidenced client invocation boundary; no invocation spans exported'] };
  }
  const handler = options.handler;
  const wrapped = handler && new Proxy(handler, {
    get(target, key) {
      if (key === 'stopInvokeAgent' || key === 'stopEntry') {
        return (invocation: Parameters<ExtendedTelemetryHandler['stopInvokeAgent']>[0], endTime?: number) => {
          if (key === 'stopInvokeAgent' && invocation.span) addRecordToolEvents(invocation.span, records);
          const output = end['gen_ai.output.messages'];
          if (Array.isArray(output)) invocation.outputMessages = output;
          return key === 'stopInvokeAgent' ? target.stopInvokeAgent(invocation, endTime) : target.stopEntry(invocation, endTime);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = convertEventLogToTrace(boundaries, { ...options, ...(wrapped ? { handler: wrapped } : {}) });
  return { ...result, warnings: [...result.warnings,
    'Doubao trace is partial: local tool events and TASK observations are available; cloud model/ReAct/delegated invocation boundaries are unavailable'] };
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{19}$/.test(value);
}

function addRecordToolEvents(span: Span, records: EventLogRecord[]): void {
  const calls = records.filter(record => record['event.name'] === 'tool.call');
  let emitted = 0;
  for (const call of calls) {
    const id = call['gen_ai.tool.call.id'];
    const result = records.find(record => record['event.name'] === 'tool.result' && record['gen_ai.tool.call.id'] === id);
    if (!result || !validTime(call.time_unix_nano) || !validTime(result.time_unix_nano)
      || BigInt(result.time_unix_nano) <= BigInt(call.time_unix_nano)) continue;
    if (emitted >= 64) continue;
    const common: Attributes = {};
    for (const key of ['gen_ai.tool.call.id', 'gen_ai.tool.name', `${PREFIX}native_decision_id`, `${PREFIX}local_executor_tool_name`]) {
      if (typeof call[key] === 'string') common[key] = call[key] as string;
    }
    const args = call['gen_ai.tool.call.arguments'], output = result['gen_ai.tool.call.result'];
    span.addEvent('gen_ai.tool.call', { ...common, ...(typeof args === 'string' ? { 'gen_ai.tool.call.arguments': args } : {}) }, nanoTime(call.time_unix_nano));
    span.addEvent('gen_ai.tool.result', { ...common,
      ...(typeof output === 'string' ? { 'gen_ai.tool.call.result': output } : {}),
      ...(typeof result['tool.result.status'] === 'string' ? { 'tool.result.status': result['tool.result.status'] as string } : {}) }, nanoTime(result.time_unix_nano));
    emitted++;
  }
  span.setAttribute(`${PREFIX}tool_observations_count`, emitted);
  span.setAttribute(`${PREFIX}tool_observations_not_in_span`, calls.length - emitted);
}

/** One TASK per actual local execution UUID. Its resource lifetime is known;
 * the cloud Agent's invocation is not. The exact owning request is a causal
 * parent for contained work; never stretch it to accommodate background work.
 */
function convertLocalExecution(records: EventLogRecord[], options: Options) {
  const start = records.find(record => record['gen_ai.turn.start'] === true);
  const end = records.find(record => record['gen_ai.turn.end'] === true);
  const traceId = start?.trace_id, spanId = start?.[`${PREFIX}local_execution_span_id`];
  if (!start || !end || !options.observationTracer || !validTime(start.time_unix_nano) || !validTime(end.time_unix_nano)
    || BigInt(end.time_unix_nano) <= BigInt(start.time_unix_nano)
    || typeof traceId !== 'string' || !/^[0-9a-f]{32}$/.test(traceId)
    || typeof spanId !== 'string' || !/^[0-9a-f]{16}$/.test(spanId)) {
    return { spanCount: 0, traceIds: [], warnings: ['Invalid local execution observation; no TASK exported'] };
  }
  const rootStart = start[`${PREFIX}root_request_start_unix_nano`], rootEnd = start[`${PREFIX}root_request_end_unix_nano`];
  if (!validTime(rootStart) || !validTime(rootEnd) || BigInt(start.time_unix_nano) < BigInt(rootStart)
    || BigInt(end.time_unix_nano) > BigInt(rootEnd)) {
    return { spanCount: 0, traceIds: [], warnings: ['Local execution extends outside the observed client request; retained as canonical facts without inventing an enclosing invocation'] };
  }
  const rootContext = { traceId, spanId: doubaoRootAgentSpanId(traceId), traceFlags: TraceFlags.SAMPLED };
  const parentId = start.parent_span_id;
  const hasLocalParent = start[`${PREFIX}parent_resolution`] === 'same_query_native_execution'
    && start[`${PREFIX}native_parent_in_request`] === true
    && typeof parentId === 'string' && /^[0-9a-f]{16}$/.test(parentId);
  const context = trace.setSpanContext(ROOT_CONTEXT, hasLocalParent ? { ...rootContext, spanId: parentId as string } : rootContext);
  const attributes: Attributes = {
    'gen_ai.span.kind': 'TASK', 'gen_ai.operation.name': 'run_task',
    'gen_ai.task.name': 'doubao.local_execution', 'gen_ai.framework': 'doubao-work',
    [`${PREFIX}observation_scope`]: 'native_sandbox_execution',
    [`${PREFIX}trace_completeness`]: 'local_execution_observation',
    [`${PREFIX}trace_parent_resolution`]: hasLocalParent ? 'enclosing_local_execution' : 'owning_client_request',
  };
  for (const [key, value] of Object.entries(start)) {
    if ((key.startsWith(PREFIX) || ['gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.user.id'].includes(key))
      && typeof value === 'string') attributes[key] = value;
  }
  if (typeof start['user.id'] === 'string') attributes['gen_ai.user.id'] = start['user.id'];
  for (const [source, target] of [['agent.doubao_work.task_input', 'input.value'], ['agent.doubao_work.task_output', 'output.value']]) {
    if (typeof start[source] === 'string') {
      attributes[target] = start[source] as string;
      attributes[target.replace('.value', '.mime_type')] = 'text/plain';
    }
  }
  const span = options.observationTracer.startSpan('run_task doubao.local_execution', {
    kind: SpanKind.INTERNAL, startTime: nanoTime(start.time_unix_nano), attributes,
    links: [{ context: rootContext, attributes: { 'loongsuite.link.type': 'origin_client_request' } }],
  }, context);
  const originalContext = span.spanContext();
  Object.defineProperty(span, 'spanContext', { value: () => ({ ...originalContext, traceId, spanId }), configurable: true });
  const observations = start['agent.doubao_work.tool_observations'];
  const toolRecords: EventLogRecord[] = [];
  if (Array.isArray(observations)) for (const raw of observations.slice(0, 64)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (!validTime(item.startNano) || !validTime(item.endNano)
      || BigInt(item.startNano) < BigInt(start.time_unix_nano) || BigInt(item.endNano) > BigInt(end.time_unix_nano)
      || typeof item.callId !== 'string' || typeof item.name !== 'string') continue;
    const common = { 'gen_ai.tool.call.id': item.callId, 'gen_ai.tool.name': item.name,
      [`${PREFIX}native_decision_id`]: item.decisionId, [`${PREFIX}local_executor_tool_name`]: item.executorName };
    toolRecords.push({ ...common, 'event.name': 'tool.call', time_unix_nano: item.startNano, 'gen_ai.tool.call.arguments': item.arguments },
      { ...common, 'event.name': 'tool.result', time_unix_nano: item.endNano, 'tool.result.status': item.status, 'gen_ai.tool.call.result': item.result });
  }
  addRecordToolEvents(span, toolRecords);
  if (Array.isArray(observations)) span.setAttribute(`${PREFIX}tool_observations_not_in_span`, observations.length - toolRecords.length / 2);
  span.end(nanoTime(end.time_unix_nano));
  return { spanCount: 1, traceIds: [traceId], warnings: [] };
}

function nanoTime(value: string): [number, number] {
  const nano = BigInt(value);
  return [Number(nano / 1_000_000_000n), Number(nano % 1_000_000_000n)];
}

/** Preserve the real client request precision and publish the capability gap.
 * This is intentionally not a full Agent/ReAct readiness verdict.
 */
export function enrichDoubaoClientRequest(records: AgentActivityEntry[], spans: ReadableSpan[]): void {
  const start = records.find(record => record['gen_ai.turn.start'] === true);
  const end = records.find(record => record['gen_ai.turn.end'] === true);
  const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
  if (!start || !end || !agent) return;
  const previous = agent.spanContext().spanId;
  const id = doubaoRootAgentSpanId(agent.spanContext().traceId);
  const context = { ...agent.spanContext(), spanId: id };
  Object.defineProperty(agent, 'spanContext', { value: () => context, configurable: true });
  for (const span of spans) {
    if (span.parentSpanId === previous) Object.assign(span, { parentSpanId: id });
    Object.defineProperties(span, {
      startTime: { value: nanoTime(start.time_unix_nano), configurable: true },
      endTime: { value: nanoTime(end.time_unix_nano), configurable: true },
      duration: { value: nanoTime((BigInt(end.time_unix_nano) - BigInt(start.time_unix_nano)).toString()), configurable: true },
    });
    span.attributes[`${PREFIX}trace_completeness`] = 'client_request_and_local_events';
    span.attributes[`${PREFIX}unsupported_trace_layers`] = ['react', 'llm', 'tool_span', 'full_delegated_agent', 'out_of_request_local_execution_span'];
    span.attributes[`${PREFIX}observed_local_tool_calls`] = records.filter(record => record['event.name'] === 'tool.call').length;
    const firstOutput = records.find(record => record['event.name'] === 'other'
      && record[`${PREFIX}observation_scope`] === 'native_first_model_output');
    const duration = firstOutput?.[`${PREFIX}client_time_to_first_cot_ms`];
    if (typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0) {
      span.attributes[`${PREFIX}client_time_to_first_cot_ms`] = duration;
    }
  }
}
