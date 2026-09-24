import type { Context } from '@opentelemetry/api';
import {
  RandomIdGenerator,
  type IdGenerator,
} from '@opentelemetry/sdk-trace-base';
import type {
  ExecuteToolInvocation,
  ExtendedTelemetryHandler,
  LLMInvocation,
} from '@loongsuite/otel-util-genai';
import type { AgentActivityEntry } from '../types/index.js';

const VALID_SPAN_ID_RE = /^[0-9a-f]{16}$/;
const ZERO_SPAN_ID = '0'.repeat(16);

const TOOL_EVENT_NAMES = ['tool.call', 'tool.result'] as const;
const LLM_EVENT_NAMES = ['llm.request', 'llm.response'] as const;

function validSpanId(value: unknown): value is string {
  return typeof value === 'string'
    && VALID_SPAN_ID_RE.test(value)
    && value !== ZERO_SPAN_ID;
}

/**
 * OTel's public startSpan API cannot accept a caller-selected span id. This
 * generator provides one reserved id for the immediately following span and
 * otherwise delegates to the SDK's cryptographically random generator.
 */
export class ReservedSpanIdGenerator implements IdGenerator {
  private readonly fallback = new RandomIdGenerator();
  private reserved?: string;

  generateTraceId = (): string => this.fallback.generateTraceId();

  generateSpanId = (): string => {
    const reserved = this.reserved;
    this.reserved = undefined;
    return reserved ?? this.fallback.generateSpanId();
  };

  reserve(spanId: unknown): boolean {
    if (!validSpanId(spanId)) return false;
    this.reserved = spanId;
    return true;
  }

  clear(): void {
    this.reserved = undefined;
  }
}

/**
 * Maps converter invocations back to the canonical span_id their source events
 * already carry, joined on a per-kind correlation key.
 * Duplicate/conflicting ids fail open instead of selecting an ambiguous id.
 */
export class SpanIdReservations {
  private readonly byKey = new Map<string, string>();

  constructor(
    private readonly eventNames: readonly string[],
    private readonly keyField: keyof AgentActivityEntry,
  ) {}

  prepare(records: AgentActivityEntry[]): void {
    this.byKey.clear();
    const conflicts = new Set<string>();

    for (const record of records) {
      const eventName = record['event.name'];
      if (typeof eventName !== 'string' || !this.eventNames.includes(eventName)) continue;

      const key = record[this.keyField];
      const spanId = record.span_id;
      if (typeof key !== 'string' || !key || !validSpanId(spanId)) continue;

      const existing = this.byKey.get(key);
      if (existing && existing !== spanId) {
        conflicts.add(key);
        this.byKey.delete(key);
      } else if (!conflicts.has(key)) {
        this.byKey.set(key, spanId);
      }
    }
  }

  take(key: string | null | undefined): string | undefined {
    if (!key) return undefined;
    const spanId = this.byKey.get(key);
    this.byKey.delete(key);
    return spanId;
  }

  clear(): void {
    this.byKey.clear();
  }
}

/**
 * Decorate the converter handler so the generator reservation is active only
 * for the synchronous startExecuteTool -> startSpan call.
 */
export function attachReservedToolSpanIds(
  handler: ExtendedTelemetryHandler,
  idGenerator: ReservedSpanIdGenerator,
): SpanIdReservations {
  const reservations = new SpanIdReservations(TOOL_EVENT_NAMES, 'gen_ai.tool.call.id');
  const original = handler.startExecuteTool;

  // Unit tests mock the third-party handler with a minimal object.
  if (typeof original !== 'function') return reservations;

  handler.startExecuteTool = function startExecuteToolWithReservedId(
    invocation: ExecuteToolInvocation,
    parentContext?: Context,
    startTime?: number,
  ): ExecuteToolInvocation {
    const spanId = reservations.take(invocation.toolCallId);
    if (spanId) idGenerator.reserve(spanId);
    try {
      return original.call(handler, invocation, parentContext, startTime);
    } finally {
      // Prevent a converter/SDK exception from leaking the reservation to the
      // next unrelated span.
      idGenerator.clear();
    }
  };

  return reservations;
}

/**
 * LLM analogue, joined on gen_ai.response.id. The claude-code fetch preload
 * advertises its minted span id to the LLM gateway as traceparent parent-id, so
 * the exported LLM span has to claim that same id — otherwise the gateway's
 * spans parent to a span that was never exported.
 */
export function attachReservedLlmSpanIds(
  handler: ExtendedTelemetryHandler,
  idGenerator: ReservedSpanIdGenerator,
): SpanIdReservations {
  const reservations = new SpanIdReservations(LLM_EVENT_NAMES, 'gen_ai.response.id');
  const original = handler.startLlm;

  if (typeof original !== 'function') return reservations;

  handler.startLlm = function startLlmWithReservedId(
    invocation: LLMInvocation,
    parentContext?: Context,
    startTime?: number,
  ): LLMInvocation {
    const spanId = reservations.take(invocation.responseId);
    if (spanId) idGenerator.reserve(spanId);
    try {
      return original.call(handler, invocation, parentContext, startTime);
    } finally {
      idGenerator.clear();
    }
  };

  return reservations;
}
