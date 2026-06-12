import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

/**
 * Serialize ReadableSpan[] into an array of JSON strings (one per span).
 * Each string is a JSON object representing a simplified span for debug/failed-log purposes.
 * Uses the span's public API to extract attributes, events, links, etc.
 */
export function createReadableSpanToOtlpSpanJsonArray(spans: ReadableSpan[]): string[] {
  return spans.map((span) => {
    const obj = {
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startTimeUnixNano: hrTimeToNano(span.startTime),
      endTimeUnixNano: hrTimeToNano(span.endTime),
      attributes: span.attributes,
      status: span.status,
      resource: span.resource?.attributes,
    };
    return JSON.stringify(obj);
  });
}

function hrTimeToNano(hrTime: [number, number]): string {
  const [seconds, nanos] = hrTime;
  return `${BigInt(seconds) * BigInt(1_000_000_000) + BigInt(nanos)}`;
}
