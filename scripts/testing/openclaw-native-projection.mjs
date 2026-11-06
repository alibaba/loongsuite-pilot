// OpenClaw host tests need the SDK ReadableSpan identity method on the Native DTO.
import { convertEventLogToReadableSpans as nativeProjection } from './native-plugin-projection.mjs';
export async function convertEventLogToReadableSpans(records, options) {
  const result = await nativeProjection(records, options);
  for (const span of result.spans) span.spanContext = () => ({ traceId: span.traceId, spanId: span.spanId });
  return result;
}
