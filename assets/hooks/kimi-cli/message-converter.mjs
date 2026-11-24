// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * message-converter.mjs — Kimi CLI 消息归一化。
 *
 * kimi-cli 的 wire.jsonl ContentPart / ToolCall / ToolResult 与 Anthropic native
 * content block 同形（type=text/thinking/tool_use/tool_result），因此直接复用
 * claude-code 的转换范式（参考 assets/hooks/claude-code/message-converter.mjs）。
 *
 * 目标 schema（对齐 docs/output-event-schema.md）:
 *   InputMessage:  { role, parts: [TextPart | ToolCallPart | ToolCallResponsePart | ReasoningPart] }
 *   OutputMessage: { role: 'assistant', parts: [...], finish_reason }
 */

const STOP_REASON_MAP = {
  end_turn: 'stop',
  stop: 'stop',
  completed: 'stop',
  tool_use: 'tool_call',
  tool_calls: 'tool_call',
  max_tokens: 'length',
  length: 'length',
  content_filter: 'content_filter',
  error: 'error',
};

export function mapStopReason(raw) {
  if (!raw) return 'stop';
  return STOP_REASON_MAP[raw] || raw;
}

function convertContentBlock(block) {
  if (!block || typeof block !== 'object') return null;
  switch (block.type) {
    case 'text':
      return { type: 'text', content: block.text || '' };
    case 'tool_use':
      return {
        type: 'tool_call',
        id: block.id || null,
        name: block.name || '',
        arguments: block.input ?? null,
      };
    case 'tool_result':
      return {
        type: 'tool_call_response',
        id: block.tool_use_id || null,
        response: block.content ?? null,
      };
    case 'thinking':
      return { type: 'reasoning', content: block.thinking || '' };
    default:
      if (block.text != null) return { type: 'text', content: block.text };
      return null;
  }
}

/**
 * 把 kimi native message（{role, content: block[] | string}）归一化为
 * { role, parts: [...] }。content 数组按 Anthropic block 转换；
 * content 字符串视为单个 text part。
 */
export function convertInputMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const role = msg.role || 'user';
  const content = msg.content;

  if (typeof content === 'string') {
    return { role, parts: content ? [{ type: 'text', content }] : [] };
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      const part = convertContentBlock(block);
      if (part) parts.push(part);
    }
    const effectiveRole = parts.some((p) => p.type === 'tool_call_response') ? 'tool' : role;
    return { role: effectiveRole, parts };
  }

  return { role, parts: content != null ? [{ type: 'text', content: String(content) }] : [] };
}

export function convertInputMessages(messages) {
  if (!messages) return [];
  if (!Array.isArray(messages)) return [];
  const result = [];
  for (const msg of messages) {
    const converted = convertInputMessage(msg);
    if (converted) result.push(converted);
  }
  return result;
}

/**
 * gen_ai.output.messages 组装。outputContent 是本 step 累积的 Anthropic 风格
 * block 数组（text / thinking / tool_use）。finishReason 为已映射后的 stop reason
 * （stop / tool_call / length / error / ...）。
 */
export function convertOutputMessages(outputContent, finishReason) {
  if (!outputContent || !Array.isArray(outputContent) || outputContent.length === 0) {
    return [{
      role: 'assistant',
      parts: [],
      finish_reason: mapStopReason(finishReason),
    }];
  }

  const parts = [];
  for (const block of outputContent) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', content: block.text || '' });
        break;
      case 'tool_use':
        parts.push({
          type: 'tool_call',
          id: block.id || null,
          name: block.name || '',
          arguments: block.input ?? null,
        });
        break;
      case 'thinking':
        parts.push({ type: 'reasoning', content: block.thinking || '' });
        break;
      default:
        if (block.text != null) {
          parts.push({ type: 'text', content: block.text });
        }
        break;
    }
  }

  return [{
    role: 'assistant',
    parts,
    finish_reason: mapStopReason(finishReason),
  }];
}
