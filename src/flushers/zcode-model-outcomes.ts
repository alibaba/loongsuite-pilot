import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ZCODE_MODEL_CANCELLED, ZCODE_MODEL_ERROR, ZCODE_NATIVE_OUTPUT_UNAVAILABLE } from '../normalization/zcode-rollout-outcome.js';
import type { AgentActivityEntry } from '../types/index.js';

export function enrichZCodeModelOutcomes(records: AgentActivityEntry[], spans: ReadableSpan[]): void {
  const failures = new Map<string, { errorType: string; outputUnavailable: boolean }>();
  for (const record of records) {
    if (record['event.name'] !== 'llm.response') continue;
    const responseId = record['gen_ai.response.id'];
    const errorType = record['error.type'];
    if (responseId && (errorType === ZCODE_MODEL_CANCELLED || errorType === ZCODE_MODEL_ERROR)) {
      failures.set(responseId, { errorType, outputUnavailable: record[ZCODE_NATIVE_OUTPUT_UNAVAILABLE] === true });
    }
  }
  if (!failures.size) return;
  for (const span of spans) {
    if (span.attributes['gen_ai.span.kind'] !== 'LLM') continue;
    const responseId = span.attributes['gen_ai.response.id'];
    if (typeof responseId !== 'string') continue;
    const failure = failures.get(responseId);
    if (!failure) continue;
    span.attributes['error.type'] = failure.errorType;
    if (failure.outputUnavailable) span.attributes[ZCODE_NATIVE_OUTPUT_UNAVAILABLE] = true;
    Object.assign(span.status, { code: SpanStatusCode.ERROR });
  }
}
