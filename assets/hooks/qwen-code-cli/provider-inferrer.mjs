// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * provider-inferrer.mjs — Infer gen_ai.provider.name from a qwen-code session.
 *
 * qwen-code reports the model name on every assistant record (e.g. "qwen3.6-plus",
 * "claude-3-5-sonnet", "gpt-4o") and the auth_type on api_response telemetry
 * records (e.g. "openai", "anthropic"). We derive the provider primarily from
 * the model name (most specific), falling back to auth_type, then a default.
 *
 * Provider names follow the loongsuite-pilot event_t schema enumeration:
 *   anthropic / openai / qwen / gcp.gemini / deepseek / x_ai
 * (Mirrors src/normalization/entry-builder.ts inferProviderName).
 */

/**
 * @param {string|undefined} model    Model name from assistant.model
 * @param {string|undefined} authType auth_type from system.ui_telemetry record
 * @returns {string}                  Provider enum value
 */
export function inferProvider(model, authType) {
  const m = (model || '').toLowerCase();
  if (/claude|anthropic/.test(m))     return 'anthropic';
  if (/qwen|tongyi/.test(m))          return 'qwen';
  if (/gpt|openai|codex|^o[1-9]/.test(m)) return 'openai';
  if (/gemini/.test(m))               return 'gcp.gemini';
  if (/deepseek/.test(m))             return 'deepseek';
  if (/grok|xai|x_ai/.test(m))        return 'x_ai';

  const a = (authType || '').toLowerCase();
  if (a === 'openai')    return 'openai';
  if (a === 'anthropic') return 'anthropic';
  if (a === 'gemini')    return 'gcp.gemini';
  if (a === 'qwen')      return 'qwen';

  // qwen-code's default endpoint is DashScope (Alibaba's qwen service);
  // when we have neither a recognized model nor auth_type, qwen is the
  // safest fallback (and downstream entry-builder will also infer this
  // from the agentType="qwen-code-cli").
  return 'qwen';
}
