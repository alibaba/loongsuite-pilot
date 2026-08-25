// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * trae-agent trajectory parser.
 *
 * Reads a single trajectory JSON file produced by trae-agent's
 * TrajectoryRecorder (trae_agent/utils/trajectory_recorder.py) and exposes
 * a typed view used by both the polling input and the OTLP converter.
 *
 * Schema reference (from researcher fixture):
 *   root: { task, start_time, end_time, provider, model, max_steps,
 *           llm_interactions[], agent_steps[], success, final_result,
 *           execution_time }
 *   llm_interactions[i]: { timestamp, provider, model, input_messages[],
 *     response{content, model, finish_reason, usage, tool_calls[{call_id,
 *     name, arguments, id}]}, tools_available[] }
 *   agent_steps[i]: { step_number (1-based, monotonic), timestamp, state,
 *     llm_messages[], llm_response{simplified}, tool_calls[], tool_results[]
 *     reflection, error, lakeview_summary? }
 *
 * Field location notes (architect P1):
 *   - `llm_interactions[i].tool_calls` lives at `.response.tool_calls`, NOT
 *     at the top level. The researcher field table was wrong; the fixture is
 *     authoritative.
 *   - `llm_interactions[i].response.usage` carries the full token breakdown
 *     (input/output/cache_creation/cache_read/reasoning_tokens) and is the
 *     authoritative source. `agent_steps[i].llm_response.usage` only has
 *     {input, output} and MUST NOT be used for span emission.
 *   - input_messages normalization: trae-agent stores messages as
 *     `{role, content}` for text and `{role:'user', content:null,
 *     tool_result:{call_id, result, error, ...}}` for tool responses. The
 *     ARMS GenAI spec wants `{role, parts:[{type, ...}]}` — text parts use
 *     `{type:'text', content}` and tool responses become a separate message
 *     `{role:'tool', parts:[{type:'tool_call_response', id, response}]}`.
 */

/**
 * @typedef {Object} TrajectoryToolCall
 * @property {string|null} call_id
 * @property {string|null} name
 * @property {Record<string, unknown>|null} arguments
 * @property {string|null} id
 *
 * @typedef {Object} TrajectoryToolResult
 * @property {string|null} call_id
 * @property {boolean} success
 * @property {unknown} result
 * @property {string|null} error
 * @property {string|null} id
 *
 * @typedef {Object} TrajectoryUsage
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 * @property {number} [reasoning_tokens]
 *
 * @typedef {Object} TrajectoryLLMResponse
 * @property {unknown} content
 * @property {string} [model]
 * @property {string} [finish_reason]
 * @property {TrajectoryUsage} [usage]
 * @property {TrajectoryToolCall[]} [tool_calls]
 *
 * @typedef {Object} TrajectoryLLMInteraction
 * @property {string} timestamp
 * @property {string} provider
 * @property {string} [model]
 * @property {unknown[]} [input_messages]
 * @property {TrajectoryLLMResponse} [response]
 * @property {unknown[]} [tools_available]
 *
 * @typedef {Object} TrajectoryAgentStep
 * @property {number} step_number
 * @property {string} timestamp
 * @property {string} [state]
 * @property {unknown[]} [llm_messages]
 * @property {{usage?: {input?: number, output?: number}}} [llm_response]
 * @property {TrajectoryToolCall[]} [tool_calls]
 * @property {TrajectoryToolResult[]} [tool_results]
 * @property {string} [reflection]
 * @property {string} [error]
 * @property {unknown} [lakeview_summary]
 *
 * @typedef {Object} TrajectoryJson
 * @property {string} task
 * @property {string} start_time
 * @property {string} [end_time]
 * @property {string} provider
 * @property {string} [model]
 * @property {number} [max_steps]
 * @property {TrajectoryLLMInteraction[]} [llm_interactions]
 * @property {TrajectoryAgentStep[]} [agent_steps]
 * @property {boolean} [success]
 * @property {string} [final_result]
 * @property {number} [execution_time]
 */

/**
 * Parse a trajectory JSON object (already parsed). Returns a normalised view
 * with the same step ordering as the file. Does not deduplicate — the caller
 * is responsible for skipping step_numbers it has already emitted.
 *
 * @param {TrajectoryJson} json
 */
export function parseTrajectory(json) {
  if (!json || typeof json !== 'object') {
    return {
      task: '',
      startTime: '',
      endTime: '',
      provider: '',
      model: '',
      success: false,
      finalResult: '',
      executionTime: 0,
      interactions: [],
      steps: [],
    };
  }
  const interactions = Array.isArray(json.llm_interactions) ? json.llm_interactions : [];
  const steps = Array.isArray(json.agent_steps) ? json.agent_steps : [];
  return {
    task: stringOr(json.task, ''),
    startTime: stringOr(json.start_time, ''),
    endTime: stringOr(json.end_time, ''),
    provider: stringOr(json.provider, ''),
    model: stringOr(json.model, ''),
    success: Boolean(json.success),
    finalResult: stringOr(json.final_result, ''),
    executionTime: Number.isFinite(json.execution_time) ? Number(json.execution_time) : 0,
    interactions: interactions.map(normalizeInteraction),
    steps: steps.map(normalizeStep),
  };
}

function normalizeInteraction(raw) {
  const response = raw?.response && typeof raw.response === 'object' ? raw.response : {};
  return {
    timestamp: stringOr(raw.timestamp, ''),
    provider: stringOr(raw.provider, ''),
    model: stringOr(raw.model, '') || stringOr(response.model, ''),
    inputMessages: normalizeInputMessages(Array.isArray(raw.input_messages) ? raw.input_messages : []),
    toolsAvailable: Array.isArray(raw.tools_available) ? raw.tools_available : [],
    response: {
      content: response.content,
      model: stringOr(response.model, ''),
      finishReason: stringOr(response.finish_reason, ''),
      usage: normalizeUsage(response.usage),
      // Architect P1: tool_calls live under response, not at the top level.
      toolCalls: Array.isArray(response.tool_calls) ? response.tool_calls.map(normalizeToolCall) : [],
    },
  };
}

function normalizeStep(raw) {
  return {
    stepNumber: Number.isFinite(raw?.step_number) ? Number(raw.step_number) : 0,
    timestamp: stringOr(raw?.timestamp, ''),
    state: stringOr(raw?.state, ''),
    llmMessages: Array.isArray(raw?.llm_messages) ? raw.llm_messages : [],
    llmResponse: raw?.llm_response && typeof raw.llm_response === 'object' ? raw.llm_response : {},
    toolCalls: Array.isArray(raw?.tool_calls) ? raw.tool_calls.map(normalizeToolCall) : [],
    toolResults: Array.isArray(raw?.tool_results) ? raw.tool_results.map(normalizeToolResult) : [],
    reflection: stringOr(raw?.reflection, ''),
    error: stringOr(raw?.error, ''),
    lakeviewSummary: raw?.lakeview_summary,
  };
}

function normalizeToolCall(raw) {
  return {
    callId: stringOr(raw?.call_id, ''),
    name: stringOr(raw?.name, ''),
    arguments: raw?.arguments ?? null,
    id: stringOr(raw?.id, ''),
  };
}

function normalizeToolResult(raw) {
  return {
    callId: stringOr(raw?.call_id, ''),
    success: Boolean(raw?.success),
    result: raw?.result,
    error: stringOr(raw?.error, ''),
    id: stringOr(raw?.id, ''),
  };
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw;
  return {
    inputTokens: numberOr(u.input_tokens, 0),
    outputTokens: numberOr(u.output_tokens, 0),
    cacheCreationInputTokens: numberOr(u.cache_creation_input_tokens, 0),
    cacheReadInputTokens: numberOr(u.cache_read_input_tokens, 0),
    reasoningTokens: numberOr(u.reasoning_tokens, 0),
  };
}

/**
 * Convert trae-agent input_messages into the ARMS GenAI parts schema:
 *   {role, content}                       -> {role, parts: [{type: 'text', content}]}
 *   {role: 'user', content: null, tool_result: {call_id, result, error, ...}}
 *                                          -> {role: 'tool', parts: [{type: 'tool_call_response', id, response}]}
 *
 * Empty content + no tool_result -> message dropped (degenerate, no parts).
 * Unknown shapes pass through as a single text part containing the stringified
 * payload so downstream consumers still see the data.
 */
function normalizeInputMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' && m.role.length > 0 ? m.role : 'user';
    const parts = [];
    const content = m.content;
    const toolResult = m.tool_result;
    if (toolResult && typeof toolResult === 'object') {
      const id = typeof toolResult.call_id === 'string' && toolResult.call_id.length > 0
        ? toolResult.call_id
        : (typeof toolResult.id === 'string' && toolResult.id.length > 0 ? toolResult.id : undefined);
      const response = toolResult.result !== null && toolResult.result !== undefined
        ? serializePayload(toolResult.result)
        : (typeof toolResult.error === 'string' && toolResult.error.length > 0 ? toolResult.error : '');
      parts.push({ type: 'tool_call_response', id, response });
      out.push({ role: 'tool', parts });
      continue;
    }
    if (typeof content === 'string' && content.length > 0) {
      parts.push({ type: 'text', content });
    } else if (content !== null && content !== undefined) {
      parts.push({ type: 'text', content: serializePayload(content) });
    }
    if (parts.length === 0) continue;
    out.push({ role, parts });
  }
  return out;
}

function serializePayload(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}
function numberOr(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}
