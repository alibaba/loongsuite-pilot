import { convertEventLogToTrace, type EventLogRecord, type ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ROOT_CONTEXT, SpanStatusCode, trace, TraceFlags } from '@opentelemetry/api';
import type { AgentActivityEntry } from '../types/index.js';
import { doubaoDigest, doubaoRootAgentSpanId } from '../inputs/doubao-work/doubao-work-log.js';

type Options = NonNullable<Parameters<typeof convertEventLogToTrace>[1]>;
const BOUNDARY = 'client_received_to_execution_settled';

/** Local execution logs contain no model/React step. Make only the converter's
 * implicit STEP transparent; actual tools remain children of the request AGENT. */
export function convertDoubaoWorkTurn(records: EventLogRecord[], options: Options & { handler: ExtendedTelemetryHandler }) {
  if (records.some(record => record['event.name'] === 'llm.request' || record['event.name'] === 'llm.response')) {
    return convertEventLogToTrace(records, options);
  }
  let steps = 0;
  let entries = 0;
  const fragment = records.find(record => ['native_local_tool_fragment', 'native_sandbox_execution'].includes(String(record['loongsuite.doubao_work.observation_scope'])));
  const parent = fragment && /^[0-9a-f]{32}$/.test(String(fragment.trace_id)) && /^[0-9a-f]{16}$/.test(String(fragment.parent_span_id))
    ? trace.setSpanContext(ROOT_CONTEXT, { traceId: String(fragment.trace_id), spanId: String(fragment.parent_span_id), traceFlags: TraceFlags.SAMPLED }) : undefined;
  const wrapped = new Proxy(options.handler, {
    get(target, key) {
      if (parent && key === 'startEntry') return (inv: Parameters<ExtendedTelemetryHandler['startEntry']>[0]) => {
        entries++; inv.contextToken = parent; return inv;
      };
      if (parent && key === 'stopEntry') return (inv: unknown) => inv;
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
  const local = parent ? records.map(record => { const copy = { ...record }; delete copy['gen_ai.agent.scope']; return copy; }) : records;
  const result = convertEventLogToTrace(local, { ...options, handler: wrapped });
  return { ...result, spanCount: result.spanCount - steps - entries };
}

function reserveSpanId(span: ReadableSpan, id: string): void {
  const context = { ...span.spanContext(), spanId: id };
  Object.defineProperty(span, 'spanContext', { value: () => context, configurable: true });
}

/** Deterministic native fragments can arrive independently of the root export.
 * Each ancestor is explicitly an observation of this descendant tool interval,
 * rather than a guessed whole invocation or synthetic dispatch TOOL. */
export function enrichDoubaoNativeFragments(records: AgentActivityEntry[], spans: ReadableSpan[]): void {
  const marker = records.find(record => record['gen_ai.turn.start'] === true && record['event.name'] === 'other');
  const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
  if (!marker || !agent) return;
  const native = marker['loongsuite.doubao_work.observation_scope'] === 'native_local_tool_fragment';
  const execution = marker['loongsuite.doubao_work.observation_scope'] === 'native_sandbox_execution';
  const old = agent.spanContext().spanId;
  const id = native || execution ? String(marker['loongsuite.doubao_work.agent_span_id']) : doubaoRootAgentSpanId(agent.spanContext().traceId);
  if (!/^[0-9a-f]{16}$/.test(id)) return;
  reserveSpanId(agent, id);
  for (const span of spans) if (span.parentSpanId === old) Object.assign(span, { parentSpanId: id });
  if (execution) {
    Object.assign(agent, { parentSpanId: marker.parent_span_id });
    Object.assign(agent, { name: `invoke_agent ${String(marker['gen_ai.agent.id'])}` });
    agent.attributes['gen_ai.agent.id'] = String(marker['gen_ai.agent.id']);
    agent.attributes['gen_ai.agent.name'] = String(marker['gen_ai.agent.id']);
    agent.attributes['gen_ai.agent.scope'] = 'subagent';
    agent.attributes['gen_ai.agent.parent.id'] = String(marker['gen_ai.agent.parent.id']);
    agent.attributes['agent.pilot.parent.turn.id'] = String(marker['loongsuite.doubao_work.root_turn_id']);
    agent.attributes['gen_ai.agent.description'] = 'Native local sandbox lifecycle; cloud inference lifetime and business outcome are unknown';
    const ancestors = marker['loongsuite.doubao_work.native_ancestor_ids'];
    if (Array.isArray(ancestors) && ancestors.length <= 8 && ancestors.every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value))) {
      agent.attributes['loongsuite.doubao_work.native_ancestor_ids'] = ancestors as string[];
    }
    for (const key of ['observation_scope', 'agent_boundary', 'timing_basis', 'relation_basis', 'parent_resolution',
      'native_parent_execution_id', 'native_execution_id', 'native_query_message_id', 'native_sandbox_id',
      'native_creation_call_id', 'native_thread_id', 'root_turn_id', 'root_agent_id']) {
      const value = marker[`loongsuite.doubao_work.${key}`];
      if (typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value)) agent.attributes[`loongsuite.doubao_work.${key}`] = value;
    }
    return;
  }
  if (!native) return;
  const ids = marker['loongsuite.doubao_work.native_agent_ids'];
  const parents = marker['loongsuite.doubao_work.native_parent_ids'];
  const calls = marker['loongsuite.doubao_work.native_creation_call_ids'];
  const threads = marker['loongsuite.doubao_work.native_thread_ids'];
  const fragmentId = marker['loongsuite.doubao_work.fragment_id'];
  if (!Array.isArray(ids) || !Array.isArray(parents) || !Array.isArray(calls) || !Array.isArray(threads)
    || ids.length < 1 || ids.length > 8 || [parents, calls, threads].some(values => values.length !== ids.length)
    || [...ids, ...parents, ...calls, ...threads].some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    || typeof fragmentId !== 'string' || !/^[0-9a-f]{64}$/.test(fragmentId)) return;
  const decorate = (span: ReadableSpan, index: number) => {
    span.attributes['gen_ai.agent.id'] = ids[index] as string;
    span.attributes['gen_ai.agent.name'] = ids[index] as string;
    span.attributes['gen_ai.agent.scope'] = 'subagent';
    span.attributes['gen_ai.agent.parent.id'] = parents[index] as string;
    span.attributes['agent.pilot.parent.turn.id'] = String(marker['loongsuite.doubao_work.root_turn_id']);
    span.attributes['loongsuite.doubao_work.relation_basis'] = 'native_create_agent_ancestry';
    span.attributes['gen_ai.agent.description'] = index === 0 ? 'Observed local tool execution fragment' : 'Observation of descendant local tool activity';
    span.attributes['loongsuite.doubao_work.observation_scope'] = 'native_local_tool_fragment';
    span.attributes['loongsuite.doubao_work.agent_boundary'] = 'native_local_tool_interval';
    span.attributes['loongsuite.doubao_work.native_creation_call_id'] = calls[index] as string;
    span.attributes['loongsuite.doubao_work.native_thread_id'] = threads[index] as string;
    span.attributes['loongsuite.doubao_work.fragment_id'] = fragmentId;
    span.attributes['loongsuite.doubao_work.root_turn_id'] = String(marker['loongsuite.doubao_work.root_turn_id']);
    span.attributes['loongsuite.doubao_work.root_agent_id'] = String(marker['loongsuite.doubao_work.root_agent_id']);
    span.attributes['loongsuite.doubao_work.timing_basis'] = index === 0 ? 'own_local_tool' : 'descendant_local_tool';
  };
  decorate(agent, 0);
  Object.assign(agent, { parentSpanId: marker.parent_span_id });
  for (let i = 1; i < ids.length; i++) {
    const ancestor: ReadableSpan = {
      ...agent, name: `observe ${ids[i]}`, attributes: { ...agent.attributes },
      startTime: agent.startTime, endTime: agent.endTime, duration: agent.duration,
      spanContext: () => ({ ...agent.spanContext(), spanId: doubaoDigest(`${fragmentId}:agent:${ids[i]}`).slice(0, 16) }),
      parentSpanId: i + 1 < ids.length ? doubaoDigest(`${fragmentId}:agent:${ids[i + 1]}`).slice(0, 16)
        : doubaoRootAgentSpanId(agent.spanContext().traceId),
    };
    decorate(ancestor, i);
    spans.push(ancestor);
  }
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
