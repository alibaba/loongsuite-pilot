import { convertEventLogToTrace, type EventLogRecord, type ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, trace, type Attributes, type Span, type Tracer } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../types/index.js';
import { doubaoDigest, doubaoRootAgentSpanId } from '../inputs/doubao-work/doubao-work-log.js';

type Options = NonNullable<Parameters<typeof convertEventLogToTrace>[1]> & { observationTracer?: Tracer };
const PREFIX = 'loongsuite.doubao_work.';
const OBSERVATION_CONTRACT = 'genai.observed-tools.v1';

/** The current passive producer proves client requests and local tool facts.
 * It does not prove model requests, ReAct timing, or delegated invocations.
 * Export evidenced local TOOL lifetimes under their real owner, as in OTel's
 * execute_tool convention. This is a partial observation contract, not Pilot's
 * complete ReAct topology: do not manufacture a STEP or LLM to fill that gap.
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
  let toolSpanCount = 0;
  const wrapped = handler && new Proxy(handler, {
    get(target, key) {
      if (key === 'stopInvokeAgent' || key === 'stopEntry') {
        return (invocation: Parameters<ExtendedTelemetryHandler['stopInvokeAgent']>[0], endTime?: number) => {
          if (key === 'stopInvokeAgent' && invocation.span) {
            if (options.observationTracer) toolSpanCount += addLocalToolSpans(invocation.span, records,
              options.observationTracer, start.time_unix_nano as string, end.time_unix_nano as string, start);
            else addRecordToolEvents(invocation.span, records);
          }
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
  return { ...result, spanCount: result.spanCount + toolSpanCount, warnings: [...result.warnings,
    'Doubao trace uses the observed-tools contract: local TOOL/TASK boundaries are known; full model/ReAct/delegated invocation coverage is unavailable'] };
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{19}$/.test(value);
}

/** Pair by identity, never by name/order. Inputs have already passed the
 * normal content/masking pipeline; no source content is re-read here.
 */
function addLocalToolSpans(owner: Span, records: EventLogRecord[], tracer: Tracer, startNano: string, endNano: string, ownerRecord: EventLogRecord): number {
  const groups = new Map<string, { calls: EventLogRecord[]; results: EventLogRecord[] }>();
  for (const record of records) {
    const event = record['event.name'], id = record['gen_ai.tool.call.id'];
    if (!['tool.call', 'tool.result'].includes(String(event)) || typeof id !== 'string'
      || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(id) || record[`${PREFIX}trace_role`] === 'log_only') continue;
    const group = groups.get(id) ?? { calls: [], results: [] };
    (event === 'tool.call' ? group.calls : group.results).push(record);
    groups.set(id, group);
  }
  const parent = owner.spanContext();
  const pairs = [...groups.entries()].flatMap(([id, group]) => {
    if (group.calls.length !== 1 || group.results.length !== 1) return [];
    const call = group.calls[0], result = group.results[0], name = call['gen_ai.tool.name'];
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(name) || name !== result['gen_ai.tool.name']
      || !validTime(call.time_unix_nano) || !validTime(result.time_unix_nano)
      || BigInt(call.time_unix_nano) < BigInt(startNano) || BigInt(result.time_unix_nano) > BigInt(endNano)
      || BigInt(result.time_unix_nano) <= BigInt(call.time_unix_nano)
      || !['success', 'error', 'cancelled'].includes(String(result['tool.result.status']))) return [];
    for (const key of ['trace_id', 'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.agent.id', 'span_id']) {
      if (call[key] !== result[key] || (key === 'trace_id' && call[key] !== undefined && call[key] !== parent.traceId)) return [];
      if (key !== 'span_id' && ownerRecord[key] !== undefined && call[key] !== ownerRecord[key]) return [];
    }
    const fixed = call.span_id;
    const spanId = fixed === undefined ? doubaoDigest(`${parent.traceId}:${parent.spanId}:local-tool:${id}`).slice(0, 16) : fixed;
    if (typeof spanId !== 'string' || !/^[0-9a-f]{16}$/.test(spanId) || /^0+$/.test(spanId) || spanId === parent.spanId) return [];
    return [{ call, result, name, id, spanId }];
  });
  const counts = new Map<string, number>();
  for (const pair of pairs) counts.set(pair.spanId, (counts.get(pair.spanId) ?? 0) + 1);
  let emitted = 0;
  for (const { call, result, name, id, spanId } of pairs) {
    if (emitted >= 64 || counts.get(spanId) !== 1) continue;
    const attributes: Attributes = {
      'gen_ai.span.kind': 'TOOL', 'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': name, 'gen_ai.tool.call.id': id, 'gen_ai.tool.type': 'function',
      'loongsuite.trace.contract': OBSERVATION_CONTRACT,
      [`${PREFIX}observation_scope`]: 'native_local_tool_execution',
      [`${PREFIX}tool_boundary`]: 'client_received_to_execution_settled',
      [`${PREFIX}trace_completeness`]: 'local_tool_observation',
      'tool.result.status': result['tool.result.status'] as string,
    };
    for (const key of ['gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.user.id',
      'gen_ai.conversation.id', 'gen_ai.framework', `${PREFIX}native_decision_id`, `${PREFIX}local_executor_tool_name`]) {
      if (typeof call[key] === 'string') attributes[key] = call[key] as string;
    }
    if (typeof call['user.id'] === 'string') attributes['gen_ai.user.id'] = call['user.id'];
    const args = call['gen_ai.tool.call.arguments'], output = result['gen_ai.tool.call.result'];
    if (typeof args === 'string') attributes['gen_ai.tool.call.arguments'] = args;
    else if (args && typeof args === 'object' && !Array.isArray(args)) attributes['gen_ai.tool.call.arguments'] = JSON.stringify(args);
    if (typeof output === 'string') attributes['gen_ai.tool.call.result'] = output;
    const span = tracer.startSpan(`execute_tool ${name}`, {
      kind: SpanKind.INTERNAL, startTime: nanoTime(call.time_unix_nano as string), attributes,
    }, trace.setSpanContext(ROOT_CONTEXT, parent));
    const generated = span.spanContext();
    Object.defineProperty(span, 'spanContext', { value: () => ({ ...generated, traceId: parent.traceId, spanId }), configurable: true });
    if (result['tool.result.status'] !== 'success') {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute('error.type', result['tool.result.status'] === 'cancelled' ? 'doubao.local_tool_cancelled' : 'doubao.local_tool_failed');
    }
    span.end(nanoTime(result.time_unix_nano as string));
    emitted++;
  }
  owner.setAttribute('loongsuite.trace.contract', OBSERVATION_CONTRACT);
  owner.setAttribute(`${PREFIX}tool_observations_count`, emitted);
  owner.setAttribute(`${PREFIX}tool_observations_not_in_span`, [...groups.values()].reduce((n, g) => n + g.calls.length, 0) - emitted);
  return emitted;
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
    const rawArgs = call['gen_ai.tool.call.arguments'], output = result['gen_ai.tool.call.result'];
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? JSON.stringify(rawArgs) : rawArgs;
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
  const start = records.find(record => record[`${PREFIX}local_execution_phase`] === 'start');
  const end = records.find(record => record[`${PREFIX}local_execution_phase`] === 'end');
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
    'loongsuite.trace.contract': OBSERVATION_CONTRACT,
    [`${PREFIX}observation_scope`]: 'native_sandbox_execution',
    [`${PREFIX}trace_completeness`]: 'local_execution_observation',
    [`${PREFIX}trace_parent_resolution`]: hasLocalParent ? 'enclosing_local_execution' : 'owning_client_request',
    ...(typeof start[`${PREFIX}root_turn_id`] === 'string' ? { 'gen_ai.turn.id': start[`${PREFIX}root_turn_id`] as string } : {}),
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
    const common = { trace_id: traceId, 'gen_ai.agent.id': start['gen_ai.agent.id'],
      'gen_ai.session.id': start['gen_ai.session.id'], 'gen_ai.turn.id': start['gen_ai.turn.id'],
      'gen_ai.agent.name': start['gen_ai.agent.name'], 'gen_ai.framework': 'doubao-work', 'user.id': start['user.id'],
      'gen_ai.tool.call.id': item.callId, 'gen_ai.tool.name': item.name,
      [`${PREFIX}native_decision_id`]: item.decisionId, [`${PREFIX}local_executor_tool_name`]: item.executorName };
    toolRecords.push({ ...common, 'event.name': 'tool.call', time_unix_nano: item.startNano, 'gen_ai.tool.call.arguments': item.arguments },
      { ...common, 'event.name': 'tool.result', time_unix_nano: item.endNano, 'tool.result.status': item.status, 'gen_ai.tool.call.result': item.result });
  }
  const toolSpanCount = addLocalToolSpans(span, toolRecords, options.observationTracer, start.time_unix_nano, end.time_unix_nano, start);
  if (Array.isArray(observations)) span.setAttribute(`${PREFIX}tool_observations_not_in_span`, observations.length - toolSpanCount);
  span.end(nanoTime(end.time_unix_nano));
  return { spanCount: 1 + toolSpanCount, traceIds: [traceId], warnings: [] };
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
    if (!['ENTRY', 'AGENT'].includes(String(span.attributes['gen_ai.span.kind']))) continue;
    Object.defineProperties(span, {
      startTime: { value: nanoTime(start.time_unix_nano), configurable: true },
      endTime: { value: nanoTime(end.time_unix_nano), configurable: true },
      duration: { value: nanoTime((BigInt(end.time_unix_nano) - BigInt(start.time_unix_nano)).toString()), configurable: true },
    });
    span.attributes['loongsuite.trace.contract'] = OBSERVATION_CONTRACT;
    span.attributes[`${PREFIX}trace_completeness`] = 'client_request_and_local_observations';
    span.attributes[`${PREFIX}unsupported_trace_layers`] = ['react', 'llm', 'cloud_tool_span', 'full_delegated_agent', 'out_of_request_local_execution_span'];
    span.attributes[`${PREFIX}observed_local_tool_calls`] = records.filter(record => record['event.name'] === 'tool.call').length;
    const firstOutput = records.find(record => record['event.name'] === 'other'
      && record[`${PREFIX}observation_scope`] === 'native_first_model_output');
    const duration = firstOutput?.[`${PREFIX}client_time_to_first_cot_ms`];
    if (typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0) {
      span.attributes[`${PREFIX}client_time_to_first_cot_ms`] = duration;
    }
  }
}
