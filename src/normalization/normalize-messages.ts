import type { JsonValue } from '../types/index.js';

/**
 * Normalize `gen_ai.output.messages` to the canonical schema
 * defined in tests/schemas/gen-ai-output-messages.json:
 *   [{role: "assistant", parts: [...], finish_reason?: string}]
 *
 * Handles:
 * - Bare parts: [{type,content}] → [{role:"assistant", parts:[{type,content}]}]
 * - camelCase finishReason → finish_reason
 * - Already canonical → pass-through (idempotent)
 */
export function normalizeOutputMessages(raw: JsonValue | undefined): JsonValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return raw;

  const first = raw[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return raw;
  const firstObj = first as Record<string, JsonValue>;

  if (Array.isArray(firstObj.parts)) {
    return raw.map(msg => normalizeOutputMessageKeys(msg));
  }

  if (typeof firstObj.type === 'string') {
    const parts = raw.filter(
      (p): p is Record<string, JsonValue> => p !== null && typeof p === 'object' && !Array.isArray(p),
    );
    return [{ role: 'assistant', parts }];
  }

  return raw;
}

function normalizeOutputMessageKeys(msg: JsonValue): JsonValue {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return msg;
  const obj = msg as Record<string, JsonValue>;

  if ('finishReason' in obj && !('finish_reason' in obj)) {
    const { finishReason, ...rest } = obj;
    return { ...rest, finish_reason: finishReason };
  }
  return obj;
}

/**
 * Normalize `gen_ai.input.messages_delta` to the canonical schema
 * defined in tests/schemas/gen-ai-input-messages.json:
 *   [{role, parts: [{type: "text", content}]}]
 *
 * Handles:
 * - Flat content: [{role, content: string}] → [{role, parts: [{type:"text", content}]}]
 * - Already canonical → pass-through (idempotent)
 */
export function normalizeInputMessagesDelta(raw: JsonValue | undefined): JsonValue | undefined {
  return normalizeInputMessagesArray(raw);
}

/**
 * Normalize `gen_ai.input.messages` — same logic as messages_delta.
 */
export function normalizeInputMessages(raw: JsonValue | undefined): JsonValue | undefined {
  return normalizeInputMessagesArray(raw);
}

function normalizeInputMessagesArray(raw: JsonValue | undefined): JsonValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return raw;

  return raw.map(msg => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return msg;
    const obj = msg as Record<string, JsonValue>;

    if (Array.isArray(obj.parts)) return msg;

    if (typeof obj.content === 'string' && typeof obj.role === 'string') {
      const { content, ...rest } = obj;
      return { ...rest, parts: [{ type: 'text', content }] };
    }

    return msg;
  });
}
