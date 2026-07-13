// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * message-converter.mjs — ZCode rollout `model_io` → ARMS GenAI message parts.
 *
 * ARMS GenAI message format (see docs/EVENT_LOG_TO_TRACE_SPEC.md):
 *   input message:  { role: 'user'|'system'|'tool', parts: [{type:'text', content}] }
 *   output message: { role: 'assistant', parts: [{type:'text',content},{type:'tool_call',...}] }
 *   tool result:    { role: 'tool', tool_call_id, parts: [{type:'tool_result', content}] }
 *
 * This module is shared logic — both the hook-processor (mjs envelope path)
 * and the rollout input (ts path that re-implements inline) must produce
 * identical message shapes. Tests verify equivalence on the paired fixture.
 */

/**
 * Convert parsed rollout input messages (role+content pairs) into the ARMS
 * gen_ai.input.messages shape. Content is the raw text; we don't split into
 * multiple parts because zcode's rollout only gives us a single text per role.
 */
export function buildInputMessages(parsedMessages) {
  if (!Array.isArray(parsedMessages) || parsedMessages.length === 0) return [];
  return parsedMessages.map((m) => ({
    role: m.role,
    parts: [{ type: 'text', content: String(m.content ?? '') }],
  }));
}

/**
 * Convert rollout response.text + response.toolCalls[] into the ARMS
 * gen_ai.output.messages shape: one assistant message with text + tool_call
 * parts (per C5: all parts in the SAME response).
 */
export function buildOutputMessages(responseText, toolCalls) {
  const parts = [];
  if (typeof responseText === 'string' && responseText.length > 0) {
    parts.push({ type: 'text', content: responseText });
  }
  for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!tc || !tc.id || !tc.name) continue;
    const part = {
      type: 'tool_call',
      id: tc.id,
      name: tc.name,
    };
    if (tc.args !== undefined && tc.args !== null) {
      part.arguments = tc.args;
    }
    parts.push(part);
  }
  if (parts.length === 0) return [];
  return [{ role: 'assistant', parts }];
}

/**
 * Map zcode's providerId (e.g. "dashscope", "openai") to ARMS GenAI provider
 * name. Falls back to lowercased providerId, then 'unknown'.
 */
export function inferProviderName(providerId, modelId = '') {
  const p = String(providerId || '').toLowerCase();
  if (p) return p;
  const m = String(modelId || '').toLowerCase();
  if (/qwen|tongyi/.test(m)) return 'qwen';
  if (/gpt|openai|codex/.test(m)) return 'openai';
  if (/claude|anthropic/.test(m)) return 'anthropic';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/glm/.test(m)) return 'zhipuai';
  return 'unknown';
}
