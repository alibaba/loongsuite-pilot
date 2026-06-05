// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * message-converter.mjs — Claude Code 消息归一化。
 *
 * 移植自 claude-code-plugin .../src/message-converter.js,改 ESM 导出。
 * 删除了 convertSystemPrompt / convertToolDefinitions(Claude transcript 不含此数据)。
 *
 * 三种协议格式归一化:
 *   - Anthropic native (默认)
 *   - openai-chat
 *   - openai-responses
 *
 * 目标 schema:
 *   InputMessage:  { role, parts: [TextPart | ToolCallPart | ToolCallResponsePart | BlobPart | UriPart | ReasoningPart] }
 *   OutputMessage: { role, parts: [...], finish_reason }
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

// ─── Anthropic content block ↔ MessagePart ───

export function convertAnthropicContentBlock(block) {
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
    case 'image': {
      const src = block.source || {};
      const mimeType = src.media_type || 'image/unknown';
      const data = src.data || '';
      return { type: 'blob', mime_type: mimeType, modality: 'image', content: data };
    }
    case 'thinking':
      return { type: 'reasoning', content: block.thinking || '' };
    default:
      if (block.text != null) return { type: 'text', content: block.text };
      return { type: block.type || 'unknown' };
  }
}

// ─── input messages 归一化 ───

export function convertInputMessages(messages, protocol) {
  if (!messages) return [];
  if (typeof messages === 'string') {
    return messages ? [{ role: 'user', parts: [{ type: 'text', content: messages }] }] : [];
  }
  if (!Array.isArray(messages)) return [];

  const result = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    if (protocol === 'openai-chat') {
      result.push(convertOpenAIChatMessage(msg));
    } else if (protocol === 'openai-responses') {
      const converted = convertOpenAIResponsesItem(msg);
      if (converted) result.push(converted);
    } else {
      result.push(convertAnthropicMessage(msg));
    }
  }
  return result;
}

function convertAnthropicMessage(msg) {
  const role = msg.role || 'user';
  const content = msg.content;

  if (typeof content === 'string') {
    return { role, parts: [{ type: 'text', content }] };
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      const part = convertAnthropicContentBlock(block);
      if (part) parts.push(part);
    }
    const effectiveRole = parts.some((p) => p.type === 'tool_call_response') ? 'tool' : role;
    return { role: effectiveRole, parts };
  }

  return { role, parts: content != null ? [{ type: 'text', content: String(content) }] : [] };
}

function convertOpenAIChatMessage(msg) {
  const role = msg.role || 'user';
  const parts = [];

  if (role === 'tool' && msg.tool_call_id) {
    parts.push({
      type: 'tool_call_response',
      id: msg.tool_call_id,
      response: msg.content ?? null,
    });
    return { role: 'tool', parts };
  }

  if (msg.content != null) {
    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ type: 'text', content: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'string') {
          parts.push({ type: 'text', content: block });
        } else if (block && block.type === 'text') {
          parts.push({ type: 'text', content: block.text || '' });
        } else if (block && block.type === 'image_url' && block.image_url) {
          const url = typeof block.image_url === 'string' ? block.image_url : block.image_url.url || '';
          const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
          if (dataMatch) {
            parts.push({ type: 'blob', mime_type: dataMatch[1], modality: 'image', content: dataMatch[2] });
          } else {
            parts.push({ type: 'uri', mime_type: 'image/unknown', modality: 'image', uri: url });
          }
        }
      }
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      parts.push({
        type: 'tool_call',
        id: tc.id || null,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments ?? null,
      });
    }
  }

  return { role, parts };
}

function convertOpenAIResponsesItem(item) {
  if (!item || typeof item !== 'object') return null;

  if (typeof item === 'string') {
    return { role: 'user', parts: [{ type: 'text', content: item }] };
  }

  if (item.type === 'function_call_output') {
    return {
      role: 'tool',
      parts: [{
        type: 'tool_call_response',
        id: item.call_id || null,
        response: item.output ?? null,
      }],
    };
  }

  const role = item.role || 'user';
  const content = item.content;
  if (typeof content === 'string') {
    return { role, parts: [{ type: 'text', content }] };
  }
  if (Array.isArray(content)) {
    const parts = content.map((c) => {
      if (typeof c === 'string') return { type: 'text', content: c };
      if (c && c.type === 'input_text') return { type: 'text', content: c.text || '' };
      if (c && c.type === 'text') return { type: 'text', content: c.text || '' };
      if (c && c.type === 'input_image') {
        const url = c.image_url || c.url || '';
        const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
        if (dataMatch) {
          return { type: 'blob', mime_type: dataMatch[1], modality: 'image', content: dataMatch[2] };
        }
        return { type: 'uri', mime_type: 'image/unknown', modality: 'image', uri: url };
      }
      return { type: c?.type || 'unknown' };
    });
    return { role, parts };
  }

  return { role, parts: [] };
}

// ─── output messages 归一化 ───

export function convertOutputMessages(outputContent, stopReason) {
  if (!outputContent || !Array.isArray(outputContent) || outputContent.length === 0) {
    return [{
      role: 'assistant',
      parts: [],
      finish_reason: mapStopReason(stopReason),
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
    finish_reason: mapStopReason(stopReason),
  }];
}
