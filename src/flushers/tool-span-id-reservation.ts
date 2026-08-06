import type { Context } from '@opentelemetry/api';
import {
  RandomIdGenerator,
  type IdGenerator,
} from '@opentelemetry/sdk-trace-base';
import type {
  ExecuteToolInvocation,
  ExtendedTelemetryHandler,
} from '@loongsuite/otel-util-genai';
import type { AgentActivityEntry } from '../types/index.js';

const VALID_SPAN_ID_RE = /^[0-9a-f]{16}$/;
const ZERO_SPAN_ID = '0'.repeat(16);

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
export class ReservedToolSpanIdGenerator implements IdGenerator {
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
 * Maps converter tool invocations back to their canonical event span_id.
 * Duplicate/conflicting ids fail open instead of selecting an ambiguous id.
 */
export class ToolSpanIdReservations {
  private readonly byToolCallId = new Map<string, string>();

  prepare(records: AgentActivityEntry[]): void {
    this.byToolCallId.clear();
    const conflicts = new Set<string>();

    for (const record of records) {
      const eventName = record['event.name'];
      if (eventName !== 'tool.call' && eventName !== 'tool.result') continue;

      const toolCallId = record['gen_ai.tool.call.id'];
      const spanId = record.span_id;
      if (typeof toolCallId !== 'string' || !toolCallId || !validSpanId(spanId)) continue;

      const existing = this.byToolCallId.get(toolCallId);
      if (existing && existing !== spanId) {
        conflicts.add(toolCallId);
        this.byToolCallId.delete(toolCallId);
      } else if (!conflicts.has(toolCallId)) {
        this.byToolCallId.set(toolCallId, spanId);
      }
    }
  }

  take(toolCallId: string | null | undefined): string | undefined {
    if (!toolCallId) return undefined;
    const spanId = this.byToolCallId.get(toolCallId);
    this.byToolCallId.delete(toolCallId);
    return spanId;
  }

  clear(): void {
    this.byToolCallId.clear();
  }
}

/**
 * Decorate the converter handler so the generator reservation is active only
 * for the synchronous startExecuteTool -> startSpan call.
 */
export function attachReservedToolSpanIds(
  handler: ExtendedTelemetryHandler,
  idGenerator: ReservedToolSpanIdGenerator,
): ToolSpanIdReservations {
  const reservations = new ToolSpanIdReservations();
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
