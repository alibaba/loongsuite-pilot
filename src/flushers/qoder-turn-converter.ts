import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import {
  convertEventLogToTrace,
  type ConvertOptions,
  type EntryInvocation,
  type EventLogRecord,
  type ExtendedTelemetryHandler,
} from '@loongsuite/otel-util-genai';
import type { ReservedSpanIdGenerator } from './span-id-reservation.js';

const SYNTHETIC_PARENT = '0000000000000001';
export const QODER_TRANSCRIPT_AGENT_TYPES = new Set(['qoder', 'qoder-cli', 'qoder-cn', 'qoder-idea']);

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
    return convertEventLogToTrace(prepared.records, { ...options, handler: prepared.handler });
  } finally {
    prepared.cleanup?.();
  }
}

/** Keep the existing entry wrapper until either conversion path completes.
 * The flusher serializes turns sharing this handler through convertLocks. */
export function prepareQoderTurn(
  records: EventLogRecord[],
  options: { handler: ExtendedTelemetryHandler; idGenerator: ReservedSpanIdGenerator },
) {
  const roots = independentTraceIds(records);
  const { handler, idGenerator } = options;
  const original = handler.startEntry;
  handler.startEntry = function startQoderEntry(invocation: EntryInvocation, parentContext, startTime) {
    const parent = parentContext && trace.getSpanContext(parentContext);
    if (!parent || parent.spanId !== SYNTHETIC_PARENT || !roots.has(parent.traceId)) {
      return original.call(handler, invocation, parentContext, startTime);
    }
    idGenerator.reserveTraceId(parent.traceId);
    try {
      return original.call(handler, invocation, ROOT_CONTEXT, startTime);
    } finally {
      idGenerator.clearTraceId();
    }
  };
  return { records, handler, removedEntryCount: 0, cleanup() {
    handler.startEntry = original;
    idGenerator.clearTraceId();
  } };
}
