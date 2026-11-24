import { toJsonValue } from './entry-builder.js';
import type { JsonValue } from '../types/index.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function readZCodeToolDefinitions(record: Record<string, unknown>): JsonValue[] | undefined {
  const request = asRecord(record.request);
  const body = asRecord(request.body);
  const candidates = [
    body.tools, request.tools, body.function_definitions, request.function_definitions,
    request.toolDefinitions, body.toolDefinitions, record.tools,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    if (candidate.length === 0) return [];
    const definitions: JsonValue[] = [];
    for (const value of candidate) {
      const wrapper = asRecord(value);
      const tool = wrapper.function && typeof wrapper.function === 'object' && !Array.isArray(wrapper.function)
        ? asRecord(wrapper.function) : wrapper;
      const name = nonemptyString(tool.name);
      if (!name) continue;
      const description = nonemptyString(tool.description);
      const parameters = toJsonValue(tool.parameters ?? tool.input_schema ?? tool.inputSchema);
      definitions.push({
        type: nonemptyString(wrapper.type) ?? 'function',
        name,
        ...(description ? { description } : {}),
        ...(parameters !== undefined && parameters !== null ? { parameters } : {}),
      });
    }
    if (definitions.length) return definitions;
  }
  return undefined;
}

export function readZCodeRequestMaxTokens(request: Record<string, unknown>): number | undefined {
  const body = asRecord(request.body);
  return [body.max_completion_tokens, body.max_tokens, request.maxOutputTokens].find(
    (limit): limit is number => typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0,
  );
}
