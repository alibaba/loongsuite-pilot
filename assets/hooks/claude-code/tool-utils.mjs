// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * tool-utils.mjs — Claude Code tool response 归一化。
 *
 * 移植自 claude-code-plugin .../src/hooks.js 的 extractToolResult / extractToolError。
 * 仅保留 JSONL 输出需要的归一化函数,丢弃 OTel 事件构造 + UI 友好截断函数。
 */

/**
 * 从 Claude Code tool response 提取干净的结果值,用作 `gen_ai.tool.call.result` 字段。
 *
 *  - 字符串 → 直接返回
 *  - 对象 + isError/error → "Error: <msg>" 字符串
 *  - 对象有 result/content/message/output/stdout 任一键 → 取该键(content 数组聚合 text)
 *  - 其他 → 原样返回
 */
export function extractToolResult(toolResponse) {
  if (toolResponse == null) return null;
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse !== 'object' || Array.isArray(toolResponse)) return toolResponse;

  if (toolResponse.error || toolResponse.isError) {
    return `Error: ${toolResponse.error || 'Unknown error'}`;
  }

  for (const key of ['result', 'content', 'message', 'output', 'stdout']) {
    if (!(key in toolResponse)) continue;
    const raw = toolResponse[key];
    if (Array.isArray(raw)) {
      const texts = raw
        .filter((item) => item && typeof item === 'object' && item.type === 'text' && item.text)
        .map((item) => item.text);
      if (texts.length > 0) return texts.join('');
    }
    return raw;
  }

  return toolResponse;
}

/**
 * 检测 tool response 是否报错,返回标准化错误对象。
 */
export function extractToolError(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object' || Array.isArray(toolResponse)) return null;
  if (!toolResponse.error && !toolResponse.isError) return null;
  return {
    message: String(toolResponse.error || 'Unknown error'),
    type: 'ToolError',
  };
}
