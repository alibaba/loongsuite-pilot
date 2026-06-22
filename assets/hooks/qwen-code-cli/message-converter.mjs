// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * message-converter.mjs — qwen-code transcript message → ARMS event_t messages.
 *
 * qwen-code stores chat history in the `@google/genai` Content shape:
 *   { role: 'user' | 'model' | 'tool', parts: [TextPart | FunctionCallPart | FunctionResponsePart] }
 * where each part is one of:
 *   { text: string, thought?: true }                  // text / reasoning
 *   { functionCall: { name, args, id? } }              // tool call
 *   { functionResponse: { name, response } }           // tool result
 *
 * Target ARMS schema (per ai_event_schema.md + EVENT_LOG_TO_TRACE_SPEC.md §7):
 *   { role, parts: [TextPart | ReasoningPart | ToolCallPart | ToolCallResponsePart] }
 * where parts use:
 *   { type: 'text', content }
 *   { type: 'reasoning', content }                     // ← qwen `thought: true` text
 *   { type: 'tool_call', id, name, arguments }
 *   { type: 'tool_call_response', id, response }
 *
 * MUST output nested-parts structure (not OpenAI's flat content). MUST keep
 * reasoning + text + tool_call together in one assistant message (don't split
 * across multiple messages) — EVENT_LOG_TO_TRACE_SPEC §4.2.
 */

/**
 * Convert a single qwen-code message.parts[] element → ARMS part object.
 * Returns null for unrecognized parts (caller filters).
 *
 * @param {Object} qwenPart  e.g. { text: 'hi' } or { functionCall: {...} }
 * @param {string|null} [toolCallIdForResponse]  Optional callId to attach when
 *   converting a functionResponse part (qwen's functionResponse doesn't carry
 *   the original call id, so we accept it from caller's tool_result.toolCallResult.callId).
 */
export function convertQwenPart(qwenPart, toolCallIdForResponse = null) {
  if (!qwenPart || typeof qwenPart !== 'object') return null;

  // Reasoning (thought-tagged text) — must precede the plain text branch
  // because qwen sets BOTH `text` and `thought: true` on the same part.
  if (qwenPart.thought === true && typeof qwenPart.text === 'string') {
    return { type: 'reasoning', content: qwenPart.text };
  }

  if (typeof qwenPart.text === 'string') {
    return { type: 'text', content: qwenPart.text };
  }

  if (qwenPart.functionCall && typeof qwenPart.functionCall === 'object') {
    const fc = qwenPart.functionCall;
    return {
      type: 'tool_call',
      id: fc.id || null,
      name: fc.name || '',
      arguments: fc.args ?? null,
    };
  }

  if (qwenPart.functionResponse && typeof qwenPart.functionResponse === 'object') {
    const fr = qwenPart.functionResponse;
    return {
      type: 'tool_call_response',
      id: toolCallIdForResponse || null,
      response: fr.response ?? null,
    };
  }

  // Unknown part shape — drop it (rather than emit `{type:'unknown'}` which
  // would pollute downstream validation).
  return null;
}

/**
 * Convert qwen's message.parts[] array → ARMS parts[] array.
 * Maintains source order so reasoning/text/tool_call appear in the same
 * sequence the model produced them.
 */
export function convertQwenParts(qwenParts, toolCallIdForResponse = null) {
  if (!Array.isArray(qwenParts)) return [];
  const out = [];
  for (const p of qwenParts) {
    const converted = convertQwenPart(p, toolCallIdForResponse);
    if (converted) out.push(converted);
  }
  return out;
}

/**
 * Build the assistant output messages array for a single `llm.response` event.
 * MUST emit exactly one message with role='assistant' and all parts in one
 * messages[0].parts[] — never split reasoning/text/tool_call into multiple
 * messages (EVENT_LOG_TO_TRACE_SPEC §4.2).
 *
 * @param {Object} assistantRecord  A qwen-code transcript record of type='assistant'
 * @returns {Array} gen_ai.output.messages payload
 */
export function buildOutputMessages(assistantRecord) {
  const message = assistantRecord?.message || {};
  const parts = convertQwenParts(message.parts);
  const finishReason = inferAssistantFinishReason(assistantRecord);
  return [{
    role: 'assistant',
    parts,
    finish_reason: finishReason,
  }];
}

/**
 * Infer finish_reason for an assistant record. qwen-code's transcript doesn't
 * have an explicit stop_reason field, so we derive from message contents:
 *   - has functionCall parts → "tool_call"  (pilot's normalized singular form)
 *   - has only text parts    → "stop"
 *   - empty                  → "stop" (defensive default)
 */
export function inferAssistantFinishReason(assistantRecord) {
  const parts = assistantRecord?.message?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return 'stop';
  const hasFunctionCall = parts.some(
    (p) => p && typeof p === 'object' && p.functionCall && typeof p.functionCall === 'object',
  );
  return hasFunctionCall ? 'tool_call' : 'stop';
}

/**
 * Build a `gen_ai.input.messages_delta` array for a single LLM call.
 * The delta contains all input messages that were ADDED between the previous
 * LLM call (or turn start) and this LLM call — i.e. one of:
 *
 *   - the original user prompt (for the first step of a turn)
 *   - tool_result records produced since the last assistant call
 *   - mid-turn user messages
 *
 * Each input is a qwen-code transcript record. We extract its message.parts
 * and convert to ARMS format, mapping role appropriately:
 *   - type=user → role: 'user'
 *   - type=tool_result → role: 'tool' (with tool_call_response parts)
 *
 * @param {Array} sourceRecords  qwen-code transcript records (user or tool_result)
 * @param {Map<string,string>} [toolCallIdByResponseUuid]
 *   Optional map: tool_result record uuid → original tool call id. Used because
 *   qwen's functionResponse doesn't carry the call id; we recover it from the
 *   tool_result record's toolCallResult.callId.
 */
export function buildInputMessagesDelta(sourceRecords, toolCallIdByResponseUuid = new Map()) {
  if (!Array.isArray(sourceRecords)) return [];
  const messages = [];
  for (const rec of sourceRecords) {
    if (!rec || typeof rec !== 'object') continue;
    const msg = rec.message || {};
    if (rec.type === 'tool_result') {
      const callId = toolCallIdByResponseUuid.get(rec.uuid) || rec?.toolCallResult?.callId || null;
      const parts = convertQwenParts(msg.parts, callId);
      if (parts.length > 0) {
        messages.push({ role: 'tool', parts });
      }
      continue;
    }
    // type=user (also mid_turn_user_message)
    const parts = convertQwenParts(msg.parts);
    if (parts.length > 0) {
      const role = msg.role === 'tool' ? 'tool' : 'user';
      messages.push({ role, parts });
    }
  }
  return messages;
}
