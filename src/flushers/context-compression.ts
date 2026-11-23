import { createHash } from 'node:crypto';
import { SpanKind, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import type { ExtendedTelemetryHandler, EventLogRecord } from '@loongsuite/otel-util-genai';
import type { ReservedSpanIdGenerator } from './span-id-reservation.js';

const COMPRESSION_ATTRIBUTES = new Set([
  'gen_ai.context.compress.id', 'gen_ai.context.compress.status', 'gen_ai.context.compress.trigger',
  'gen_ai.context.compress.duration', 'gen_ai.context.compress.start_time_unix_nano',
  'gen_ai.context.compress.standalone', 'gen_ai.context.compress.native_tokens_before',
  'gen_ai.context.counting.method', 'gen_ai.context.counting.scope',
  'gen_ai.context.tokens_before', 'gen_ai.context.tokens_after', 'gen_ai.context.compression_ratio',
  'gen_ai.context.window_size', 'gen_ai.context.messages_before', 'gen_ai.context.messages_after',
  'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.agent.name', 'user.id',
  'agent.codex.compaction.input_tokens', 'agent.codex.compaction.output_tokens',
  'gen_ai.context.version', 'gen_ai.context.previous_version', 'gen_ai.context.replacement.boundary',
  'gen_ai.context.content.availability', 'gen_ai.context.source_span_ids',
  'gen_ai.context.source.scope', 'gen_ai.context.source.complete', 'gen_ai.context.retained_message_ids',
  'agent.codex.context.sampled_through_sequence',
  'agent.pi.context.first_kept_entry_id',
]);

export function isCompression(record: EventLogRecord): boolean {
  return record['event.name'] === 'gen_ai.context.compress'
    || record['event.name'] === 'gen_ai.context.compress.start';
}

function nanos(value: unknown): bigint | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

/** Prepare the complete operation before conversion. The shared SDK receives
 * content-free bounds and creates its usual containers. Native INTERNAL spans
 * use the executing AGENT's SDK context and the existing export pipeline. */
export function prepareCompression(records: EventLogRecord[], handler: ExtendedTelemetryHandler,
  tracer: Tracer, ids: ReservedSpanIdGenerator) {
  if (!records.some(isCompression)) return { records, handler };
  const starts = new Map<string, EventLogRecord>();
  for (const record of records) {
    if (record['event.name'] === 'gen_ai.context.compress.start') starts.set(key(record), record);
  }
  const seen = new Set<string>();
  const operations: { record: EventLogRecord; start: bigint; end: bigint }[] = [];
  for (const record of records) {
    if (record['event.name'] !== 'gen_ai.context.compress' || seen.has(key(record))) continue;
    seen.add(key(record));
    const end = nanos(record.time_unix_nano);
    let start = nanos(record['gen_ai.context.compress.start_time_unix_nano'])
      ?? nanos(starts.get(key(record))?.time_unix_nano);
    const duration = record['gen_ai.context.compress.duration'];
    if (start === undefined && end !== undefined && typeof duration === 'number'
      && Number.isFinite(duration) && duration > 0) start = end - BigInt(Math.round(duration * 1e9));
    if (start !== undefined && end !== undefined && start >= 0n && end > start) operations.push({ record, start, end });
  }
  const local = records.filter(record => !isCompression(record));
  // Completion-only evidence cannot establish a timed standalone execution.
  if (!local.length && !operations.length) return { records: [], handler };
  for (const operation of operations) {
    for (const time of [operation.start, operation.end]) {
      local.push({ ...operation.record, 'event.name': 'other', time_unix_nano: String(time) });
    }
  }
  const emitted = new Set<string>();
  const wrapped = new Proxy(handler, {
    get(target, property) {
      if (property === 'startEntry') return (...args: Parameters<ExtendedTelemetryHandler['startEntry']>) => {
        const source = operations[0]?.record;
        if (source) {
          args[0].sessionId ??= String(source['gen_ai.session.id'] ?? '');
          args[0].userId ??= String(source['user.id'] ?? '');
          args[0].agentName ??= String(source['gen_ai.agent.name'] ?? source['gen_ai.agent.type'] ?? '');
        }
        return target.startEntry(...args);
      };
      if (property === 'startInvokeAgent') return (...args: Parameters<ExtendedTelemetryHandler['startInvokeAgent']>) => {
        const source = operations[0]?.record;
        if (source) {
          args[0].sessionId ??= String(source['gen_ai.session.id'] ?? '');
          args[0].userId ??= String(source['user.id'] ?? '');
          args[0].agentName ??= String(source['gen_ai.agent.name'] ?? source['gen_ai.agent.type'] ?? '');
        }
        const invocation = target.startInvokeAgent(...args);
        const parent = invocation.contextToken;
        if (!parent) return invocation;
        const parentTrace = trace.getSpanContext(parent)?.traceId;
        for (const { record, start, end } of operations) {
          if (emitted.has(key(record)) || (record.trace_id && record.trace_id !== parentTrace)
            || (invocation.sessionId && record['gen_ai.session.id'] !== invocation.sessionId)) continue;
          emitted.add(key(record));
          const attributes: Record<string, string | number | boolean | string[]> = {
            'gen_ai.span.kind': 'COMPRESSION', 'gen_ai.operation.name': 'compress_context',
          };
          for (const [name, value] of Object.entries(record)) {
            if (COMPRESSION_ATTRIBUTES.has(name)
              && (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
                || (Array.isArray(value) && value.every(item => typeof item === 'string')))) {
              attributes[name] = value as string | number | boolean | string[];
            }
          }
          attributes['gen_ai.context.compress.duration'] = Number(end - start) / 1e9;
          if (typeof record['user.id'] === 'string') attributes['gen_ai.user.id'] = record['user.id'];
          ids.reserve(createHash('sha256').update(key(record)).digest('hex').slice(0, 16));
          try {
            const span = tracer.startSpan('gen_ai.context.compress', { kind: SpanKind.INTERNAL,
              startTime: hrTime(start), attributes,
              links: Array.isArray(record['gen_ai.context.source_span_ids']) && parentTrace
                ? (record['gen_ai.context.source_span_ids'] as unknown[])
                  .filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id))
                  .map(spanId => ({ context: { traceId: parentTrace, spanId, traceFlags: 1 } })) : [],
            }, parent);
            if (record['gen_ai.context.compress.status'] === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
            span.end(hrTime(end));
          } finally { ids.clear(); }
        }
        return invocation;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { records: local, handler: wrapped };
}

function key(record: EventLogRecord): string {
  return JSON.stringify([record['gen_ai.session.id'], record['gen_ai.turn.id'],
    record['gen_ai.context.compress.id'] ?? record['event.id']]);
}

function hrTime(time: bigint): [number, number] {
  return [Number(time / 1_000_000_000n), Number(time % 1_000_000_000n)];
}

/** An unmatched start delays idle sealing for at most one hour. Existing
 * buffer caps and shutdown still bound retention after a producer disappears. */
export function hasActiveCompression(records: EventLogRecord[], now: number): boolean {
  const completed = new Set(records.filter(r => r['event.name'] === 'gen_ai.context.compress').map(key));
  return records.some(record => record['event.name'] === 'gen_ai.context.compress.start'
    && !completed.has(key(record)) && now - Number(nanos(record.time_unix_nano) ?? 0n) / 1e6 < 3_600_000);
}
