import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { createHash } from 'node:crypto';
import {
  convertEventLogToTrace,
  type ConvertOptions,
  type EntryInvocation,
  type EventLogRecord,
  type ExtendedTelemetryHandler,
} from '@loongsuite/otel-util-genai';
import type { ReservedSpanIdGenerator } from './span-id-reservation.js';
import { prepareDelegatedTurn } from './delegated-turn-converter.js';

const SYNTHETIC_PARENT = '0000000000000001';
export const QODER_TRANSCRIPT_AGENT_TYPES = new Set(['qoder', 'qoder-cli', 'qoder-cn', 'qoder-idea']);
const WORK_KEYS = ['gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.agent.scope',
  'gen_ai.agent.parent.id', 'gen_ai.agent.parent.invocation.id', 'gen_ai.subagent.parent_tool_call.id'] as const;
const OUTGOING_KEYS = ['gen_ai.agent.invocation.id', 'gen_ai.agent.peer.id', 'gen_ai.agent.peer.name'] as const;

function consensus(records: EventLogRecord[], keys: readonly string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    const values = new Set(records.map(record => record[key]));
    if (values.size === 1 && !values.has(undefined)) fields[key] = records[0]?.[key];
  }
  return fields;
}

function validId(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length
    && /^[0-9a-f]+$/.test(value) && !/^0+$/.test(value);
}

/** Match the util converter's turn grouping and upstream-parent semantics. */
function independentTraceIds(records: EventLogRecord[]): Set<string> {
  const turns = new Map<string, { traceId?: string; upstream: boolean }>();
  for (const record of records) {
    const turn = record['gen_ai.turn.id'];
    const session = record['gen_ai.session.id'];
    const key = typeof turn === 'string' && turn ? `turn:${turn}`
      : typeof session === 'string' && session ? `session:${session}` : '__no_turn__';
    let group = turns.get(key);
    if (!group) { group = { upstream: false }; turns.set(key, group); }
    if (!group.traceId && validId(record.trace_id, 32)) group.traceId = record.trace_id;
    // LLM/TOOL parent_span_id fields describe internal edges, not an upstream
    // ENTRY parent. A real upstream id of 000...001 must also be preserved.
    if (record['event.name'] === 'other' && validId(record.parent_span_id, 16)) group.upstream = true;
  }
  const roots = new Set<string>();
  const linked = new Set<string>();
  for (const group of turns.values()) {
    if (group.traceId) (group.upstream ? linked : roots).add(group.traceId);
  }
  // Be conservative if several turns reuse a trace id with mixed provenance.
  for (const id of linked) roots.delete(id);
  return roots;
}

/**
 * util beta.13 carries a supplied trace_id in a non-recording virtual parent.
 * For independent Qoder turns, create a genuine SDK root with that same id via
 * the provider's IdGenerator instead. Explicit upstream contexts pass through.
 * This uses public startEntry/startSpan APIs; ended/exported spans are untouched.
 */
export function convertQoderTurn(
  records: EventLogRecord[],
  options: ConvertOptions & { handler: ExtendedTelemetryHandler; idGenerator: ReservedSpanIdGenerator },
) {
  const prepared = prepareQoderTurn(records, options);
  try {
    const result = convertEventLogToTrace(prepared.records, { ...options, handler: prepared.handler });
    return { ...result, spanCount: result.spanCount - prepared.removedEntryCount };
  } finally {
    prepared.cleanup?.();
  }
}

/** One native execution per conversion. Keep incoming work on the whole child,
 * outgoing work only on its actual tool, and make the child ENTRY transparent. */
export function prepareQoderTurn(
  records: EventLogRecord[],
  options: { handler: ExtendedTelemetryHandler; idGenerator: ReservedSpanIdGenerator },
) {
  const delegated = prepareDelegatedTurn(records, options.handler);
  const roots = independentTraceIds(records);
  const { idGenerator } = options;
  const handler = delegated.handler;
  const work = consensus(records, WORK_KEYS);
  const byStep = new Map<unknown, EventLogRecord[]>();
  const byTool = new Map<unknown, EventLogRecord[]>();
  for (const record of records) {
    if (record['event.name'] === 'other') continue;
    const step = record['gen_ai.step.id'];
    if (step) byStep.set(step, [...(byStep.get(step) ?? []), record]);
    const call = record['gen_ai.tool.call.id'];
    if (call) byTool.set(call, [...(byTool.get(call) ?? []), record]);
  }
  const steps = [...byStep.keys()];
  let stepIndex = 0;
  let currentStep: unknown;
  const first = records[0];
  const stableId = (kind: string, key?: unknown) => createHash('sha256')
    .update(JSON.stringify(['qoder-span', first?.['gen_ai.session.id'], first?.['gen_ai.turn.id'],
      first?.['gen_ai.agent.id'], kind, key])).digest('hex').slice(0, 16);
  function reserved<T>(id: string, call: () => T): T {
    idGenerator.reserve(id);
    try { return call(); } finally { idGenerator.clear(); }
  }
  function attributes(inv: { passthroughAttributes?: Record<string, unknown> }, own: Record<string, unknown>) {
    const fields = { ...inv.passthroughAttributes };
    for (const key of [...WORK_KEYS, ...OUTGOING_KEYS, 'gen_ai.step.id']) delete fields[key];
    inv.passthroughAttributes = { ...fields, ...own };
  }
  const overrides: Partial<ExtendedTelemetryHandler> = {
    startEntry(invocation: EntryInvocation, parentContext, startTime) {
      attributes(invocation, work);
      const parent = parentContext && trace.getSpanContext(parentContext);
      if (!parent || parent.spanId !== SYNTHETIC_PARENT || !roots.has(parent.traceId)) {
        return reserved(stableId('entry'), () => handler.startEntry(invocation, parentContext, startTime));
      }
      idGenerator.reserveTraceId(parent.traceId);
      try {
        return reserved(stableId('entry'), () => handler.startEntry(invocation, ROOT_CONTEXT, startTime));
      } finally { idGenerator.clearTraceId(); }
    },
    startInvokeAgent(invocation, context, start) {
      attributes(invocation, work);
      return reserved(stableId('agent'), () => handler.startInvokeAgent(invocation, context, start));
    },
    startReactStep(invocation, context, start) {
      currentStep = steps[stepIndex++];
      attributes(invocation, { ...consensus(byStep.get(currentStep) ?? [], WORK_KEYS),
        ...(currentStep ? { 'gen_ai.step.id': currentStep } : {}) });
      return reserved(stableId('step', currentStep), () => handler.startReactStep(invocation, context, start));
    },
    startLlm(invocation, context, start) {
      attributes(invocation, { ...consensus(byStep.get(currentStep) ?? [], WORK_KEYS),
        ...(currentStep ? { 'gen_ai.step.id': currentStep } : {}) });
      return reserved(stableId('llm', currentStep), () => handler.startLlm(invocation, context, start));
    },
    startExecuteTool(invocation, context, start) {
      const own = byTool.get(invocation.toolCallId) ?? [];
      attributes(invocation, consensus(own, [...WORK_KEYS, ...OUTGOING_KEYS, 'gen_ai.step.id']));
      const ids = new Set(own.map(record => record.span_id).filter(id => validId(id, 16)));
      const id = ids.size === 1 ? String([...ids][0]) : stableId('tool', invocation.toolCallId);
      return reserved(id, () => handler.startExecuteTool(invocation, context, start));
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
  return { records: delegated.records, handler: wrapped,
    get removedEntryCount() { return delegated.removedEntryCount; },
    cleanup() { idGenerator.clear(); idGenerator.clearTraceId(); } };
}
