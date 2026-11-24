import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ZCODE_MODEL_CANCELLED, ZCODE_MODEL_ERROR } from '../normalization/zcode-rollout-outcome.js';
import type { AgentActivityEntry } from '../types/index.js';

export function enrichZCodeModelOutcomes(records: AgentActivityEntry[], spans: ReadableSpan[]): void {
  const failures = new Map<string, string>();
  for (const record of records) {
    if (record['event.name'] !== 'llm.response') continue;
    const responseId = record['gen_ai.response.id'];
    const errorType = record['error.type'];
    if (responseId && (errorType === ZCODE_MODEL_CANCELLED || errorType === ZCODE_MODEL_ERROR)) {
      failures.set(responseId, errorType);
    }
  }
  if (!failures.size) return;
  for (const span of spans) {
    if (span.attributes['gen_ai.span.kind'] !== 'LLM') continue;
    const responseId = span.attributes['gen_ai.response.id'];
    if (typeof responseId !== 'string') continue;
    const errorType = failures.get(responseId);
    if (!errorType) continue;
    span.attributes['error.type'] = errorType;
    Object.assign(span.status, { code: SpanStatusCode.ERROR });
  }
}
