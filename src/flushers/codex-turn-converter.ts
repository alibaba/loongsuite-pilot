import { createHash } from 'node:crypto';
import { ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { convertEventLogToTrace, type EventLogRecord, type ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import type { ReservedSpanIdGenerator } from './span-id-reservation.js';

type Options = NonNullable<Parameters<typeof convertEventLogToTrace>[1]>;
const WORK_KEYS = [
  'gen_ai.agent.id', 'gen_ai.agent.scope', 'gen_ai.agent.depth',
  'gen_ai.agent.parent.id', 'gen_ai.agent.parent.invocation.id',
  'gen_ai.subagent.parent_tool_call.id',
] as const;
const OUTGOING_KEYS = ['gen_ai.agent.invocation.id', 'gen_ai.agent.peer.id'] as const;

function consensus(records: EventLogRecord[], keys: readonly string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    const values = new Set(records.map(r => r[key]));
    if (values.size === 1 && !values.has(undefined)) fields[key] = records[0]?.[key];
  }
  return fields;
}

function stableId(parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

/** Convert one native Codex turn. The virtual child ENTRY is transparent only
 * when every record agrees on its real upstream context. Operation parent IDs
 * in audit records are retained; they are not the subtree attachment marker. */
export function convertCodexTurn(
  records: EventLogRecord[],
  options: Options & { handler: ExtendedTelemetryHandler; idGenerator: ReservedSpanIdGenerator },
) {
  const first = records[0];
  if (!first) return { traceIds: [], spanCount: 0, warnings: [] };
  const attachment = first['agent.codex.parent_span_id'];
  const traceId = first.trace_id;
  const delegated = first['agent.codex.delegated'] === true
    && typeof traceId === 'string' && /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId)
    && typeof attachment === 'string' && /^[0-9a-f]{16}$/.test(attachment) && !/^0+$/.test(attachment)
    && records.every(r => r.trace_id === traceId && r['agent.codex.parent_span_id'] === attachment
      && r['agent.codex.delegated'] === true);
  const parent = delegated ? trace.setSpanContext(ROOT_CONTEXT, {
    traceId: String(traceId), spanId: String(attachment), traceFlags: TraceFlags.SAMPLED,
  }) : undefined;
  const session = String(first['gen_ai.session.id']);
  const rawTurn = String(first['agent.codex.transcript_turn_id'] ?? first['gen_ai.turn.id']);
  const byStep = new Map<unknown, EventLogRecord[]>();
  const byResponse = new Map<unknown, EventLogRecord[]>();
  const byCall = new Map<unknown, EventLogRecord[]>();
  function index(map: Map<unknown, EventLogRecord[]>, key: unknown, record: EventLogRecord) {
    const group = map.get(key) ?? [];
    group.push(record);
    map.set(key, group);
  }
  for (const record of records) {
    const name = record['event.name'];
    if (name === 'other') continue;
    index(byStep, record['gen_ai.step.id'] || undefined, record);
    if (name === 'llm.request' || name === 'llm.response') index(byResponse, record['gen_ai.response.id'], record);
    if (name === 'tool.call' || name === 'tool.result') index(byCall, record['gen_ai.tool.call.id'], record);
  }
  const steps = [...byStep.keys()];
  let stepIndex = 0;
  let entries = 0;
  const handler = options.handler;
  const work = consensus(records, WORK_KEYS);
  function attributes(inv: { passthroughAttributes?: Record<string, unknown> }, own: Record<string, unknown>) {
    const attrs = { ...inv.passthroughAttributes };
    for (const key of [...WORK_KEYS, ...OUTGOING_KEYS, 'gen_ai.step.id']) delete attrs[key];
    inv.passthroughAttributes = { ...attrs, ...own };
  }
  function reserved<T>(id: unknown, call: () => T): T {
    options.idGenerator.reserve(id);
    try { return call(); } finally { options.idGenerator.clear(); }
  }
  const overrides: Partial<ExtendedTelemetryHandler> = {
    startEntry(inv, context, start) {
      attributes(inv, work);
      if (parent) { entries++; inv.contextToken = parent; return inv; }
      return reserved(stableId([session, rawTurn, 'entry']), () => handler.startEntry(inv, context, start));
    },
    stopEntry(inv, end) { return parent ? inv : handler.stopEntry(inv, end); },
    startInvokeAgent(inv, context, start) {
      attributes(inv, work);
      return reserved(stableId([session, rawTurn, 'agent']), () => handler.startInvokeAgent(inv, context, start));
    },
    startReactStep(inv, context, start) {
      const step = steps[stepIndex++];
      const own = byStep.get(step) ?? [];
      attributes(inv, { ...consensus(own, WORK_KEYS), ...(step ? { 'gen_ai.step.id': step } : {}) });
      const span = own.find(r => typeof r.parent_span_id === 'string')?.parent_span_id;
      return reserved(span ?? stableId([session, rawTurn, 'step', String(step)]), () => handler.startReactStep(inv, context, start));
    },
    startLlm(inv, context, start) {
      const own = byResponse.get(inv.responseId ?? undefined) ?? [];
      attributes(inv, { ...consensus(own, WORK_KEYS), ...consensus(own, ['gen_ai.step.id']) });
      return handler.startLlm(inv, context, start);
    },
    startExecuteTool(inv, context, start) {
      const own = byCall.get(inv.toolCallId ?? undefined) ?? [];
      attributes(inv, { ...consensus(own, [...WORK_KEYS, ...OUTGOING_KEYS]), ...consensus(own, ['gen_ai.step.id']) });
      return handler.startExecuteTool(inv, context, start);
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
  const hasDelegatedWork = records.some(record => record['agent.codex.delegated'] === true);
  const local = records.map(r => {
    const copy = { ...r };
    delete copy['gen_ai.agent.scope']; // independent turn, never an inline child group
    // The library treats `other.parent_span_id` as the virtual ENTRY parent.
    // Codex boundary logs describe the AGENT operation instead; attachment is
    // supplied explicitly above. Keep their real parents in the audit log.
    if (hasDelegatedWork && copy['event.name'] === 'other') delete copy.parent_span_id;
    return copy;
  });
  const result = convertEventLogToTrace(local, { ...options, handler: wrapped });
  return { ...result, spanCount: result.spanCount - entries };
}
