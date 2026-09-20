import type { HookEventName } from '../types.js';

export function wrapHostReason(event: HookEventName, interceptorReason?: string): string {
  const detail = interceptorReason?.trim() ?? '';
  if (event === 'UserPromptSubmit') {
    return detail
      ? `检测到敏感信息：${detail}，本轮对话终止`
      : '检测到敏感信息，本轮对话终止';
  }
  if (event === 'PostToolUse') {
    return detail
      ? `检测到非预期行为：${detail}，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。`
      : '检测到非预期行为，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。';
  }
  return detail
    ? `检测到非预期行为：${detail}，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。`
    : '检测到非预期行为，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。';
}
