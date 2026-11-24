import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ZCODE_MODEL_CANCELLED, ZCODE_MODEL_ERROR, ZCODE_NATIVE_OUTPUT_UNAVAILABLE } from '../normalization/zcode-rollout-outcome.js';
import type { AgentActivityEntry } from '../types/index.js';

export function enrichZCodeModelSpans(records: AgentActivityEntry[], spans: ReadableSpan[]): void {
  const failures = new Map<string, { errorType: string; outputUnavailable: boolean }>();
  const requests = new Map<string, AgentActivityEntry | null>();
  for (const record of records) {
    const responseId = record['gen_ai.response.id'];
    if (!responseId) continue;
    if (record['event.name'] === 'llm.request') {
      // ZCode uses the response ID on both events. A reused ID provides no
      // unique request to attribute metadata to.
      requests.set(responseId, requests.has(responseId) ? null : record);
    } else if (record['event.name'] === 'llm.response') {
      const errorType = record['error.type'];
      if (errorType === ZCODE_MODEL_CANCELLED || errorType === ZCODE_MODEL_ERROR) {
        failures.set(responseId, { errorType, outputUnavailable: record[ZCODE_NATIVE_OUTPUT_UNAVAILABLE] === true });
      }
    }
  }
  for (const span of spans) {
    if (span.attributes['gen_ai.span.kind'] !== 'LLM') continue;
    const responseId = span.attributes['gen_ai.response.id'];
    if (typeof responseId !== 'string') continue;
    const request = requests.get(responseId);
    const maxTokens = request?.['gen_ai.request.max_tokens'];
    if (typeof maxTokens === 'number') span.attributes['gen_ai.request.max_tokens'] = maxTokens;
    const definitions = request?.['gen_ai.tool.definitions'];
    if (Array.isArray(definitions)) {
      if (definitions.length) span.attributes['gen_ai.tool.definitions'] = JSON.stringify(definitions);
      else delete span.attributes['gen_ai.tool.definitions'];
    }
    const failure = failures.get(responseId);
    if (!failure) continue;
    span.attributes['error.type'] = failure.errorType;
    if (failure.outputUnavailable) span.attributes[ZCODE_NATIVE_OUTPUT_UNAVAILABLE] = true;
    Object.assign(span.status, { code: SpanStatusCode.ERROR });
  }
}
