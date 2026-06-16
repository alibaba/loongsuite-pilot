// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * react-step-builder.mjs — 把 codex turn events 组装成 ReAct steps。
 *
 * 移植自 codex-plugin .../src/replay.ts 的 buildReactSteps + 内部 helpers,改:
 *   - 仅保留 step 构造逻辑(丢弃 OTel span 创建路径)
 *   - 类型用 JSDoc 表达,不依赖 @loongsuite/opentelemetry-util-genai
 *
 * 算法核心(ReAct 循环):
 *   - PreToolUse / PostToolUse 按 tool_use_id 配对成 ToolRecord
 *   - 当 pendingToolIds 清空(本轮所有 tool 都收到 response)且 currentTools 非空,
 *     说明 LLM 又调了一次 → 关闭当前 step 进入下一个
 *   - 末尾如果有 last_assistant_message,补一个 final step(无 tools)
 *
 * @typedef {object} ToolRecord
 * @property {string} tool_name
 * @property {string} tool_use_id
 * @property {any}    tool_input
 * @property {any}    tool_response
 * @property {number} start_time
 * @property {number} end_time
 *
 * @typedef {{type:'text', content:string}|{type:'tool_call', id:string|null, name:string, arguments:any}|{type:'tool_call_response', id:string|null, response:any}|{type:'reasoning', content:string}} MessagePart
 *
 * @typedef {{role:string, parts:MessagePart[], finish_reason?:string}} Message
 *
 * @typedef {object} ReActStep
 * @property {number} round
 * @property {number} start_time
 * @property {number} end_time
 * @property {number} llm_start_time
 * @property {number} llm_end_time
 * @property {Message[]} llm_input_messages
 * @property {Message[]} llm_full_input_messages
 * @property {Message[]} llm_output_messages
 * @property {ToolRecord[]} tools
 */

export function buildReactSteps(turn) {
  const events = turn.events;
  const agentMessages = turn.agentMessages || [];
  /** @type {ReActStep[]} */
  const steps = [];

  const preToolMap = new Map();

  let llmStartTime = turn.start_time;
  /** @type {ToolRecord[]} */
  let currentTools = [];
  /** @type {Set<string>} */
  let pendingToolIds = new Set();
  let round = 0;
  /** @type {ToolRecord[]} */
  let previousToolResults = [];
  let lastAgentMsgIndex = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (event.type === 'pre_tool_use') {
      // pendingToolIds 清空 + 已有 tools = 上一步骤 LLM/Tool 完成,进入新 step
      if (pendingToolIds.size === 0 && currentTools.length > 0) {
        const llmEndTime = llmStartTime;
        const reasoning = extractStepReasoning(agentMessages, lastAgentMsgIndex, llmStartTime, currentTools[0].start_time);
        lastAgentMsgIndex = reasoning.nextIndex;
        steps.push(
          finalizeStep(++round, turn, llmStartTime, llmEndTime, previousToolResults, currentTools, reasoning.text),
        );
        previousToolResults = [...currentTools];
        currentTools = [];
        llmStartTime = steps[steps.length - 1].end_time;
      }

      preToolMap.set(event.tool_use_id, {
        timestamp: event.timestamp,
        tool_name: event.tool_name,
        tool_input: event.tool_input,
      });
      pendingToolIds.add(event.tool_use_id);
    } else if (event.type === 'post_tool_use') {
      const pre = preToolMap.get(event.tool_use_id);

      currentTools.push({
        tool_name: pre?.tool_name ?? event.tool_name,
        tool_use_id: event.tool_use_id,
        tool_input: pre?.tool_input ?? null,
        tool_response: event.tool_response,
        start_time: pre?.timestamp ?? event.timestamp,
        end_time: event.timestamp,
      });

      pendingToolIds.delete(event.tool_use_id);
      preToolMap.delete(event.tool_use_id);
    }
  }

  // 末尾:有未关闭的 tool step + 可选的 final assistant step
  if (currentTools.length > 0) {
    const reasoning = extractStepReasoning(agentMessages, lastAgentMsgIndex, llmStartTime, currentTools[0].start_time);
    lastAgentMsgIndex = reasoning.nextIndex;
    steps.push(
      finalizeStep(++round, turn, llmStartTime, 0, previousToolResults, currentTools, reasoning.text),
    );
    previousToolResults = [...currentTools];
    currentTools = [];

    if (turn.last_assistant_message) {
      const lastToolEnd = steps[steps.length - 1].end_time;
      const finalReasoning = extractStepReasoning(agentMessages, lastAgentMsgIndex, lastToolEnd, turn.end_time + 1);
      steps.push(finalizeFinalStep(++round, turn, lastToolEnd, previousToolResults, finalReasoning.text));
    }
  } else {
    const finalReasoning = extractStepReasoning(agentMessages, lastAgentMsgIndex, llmStartTime, turn.end_time + 1);
    steps.push(finalizeFinalStep(++round, turn, turn.start_time, previousToolResults, finalReasoning.text));
  }

  return steps;
}

/**
 * 从 agentMessages 中提取属于当前 step 的 reasoning 文本。
 * 使用 (afterTime, beforeTime] 区间：排除上一轮的，包含当前轮的。
 * agent_message 与 function_call 时间戳相同时，应归入当前 step。
 */
function extractStepReasoning(agentMessages, startIndex, afterTime, beforeTime) {
  const parts = [];
  let idx = startIndex;
  for (let i = startIndex; i < agentMessages.length; i++) {
    const am = agentMessages[i];
    if (am.timestamp <= afterTime) { idx = i + 1; continue; }
    if (am.timestamp > beforeTime) break;
    parts.push(am.message);
    idx = i + 1;
  }
  return { text: parts.length > 0 ? parts.join('\n\n') : null, nextIndex: idx };
}

function finalizeStep(round, turn, llmStartTime, _llmEndTimeHint, previousTools, tools, reasoning) {
  const firstToolStart = tools.length > 0 ? tools[0].start_time : turn.end_time;
  const lastToolEnd =
    tools.length > 0 ? Math.max(...tools.map((t) => t.end_time)) : turn.end_time;

  const llmEndTime = firstToolStart;

  const llmInputMessages = buildLlmInputMessages(round === 1 ? turn.prompt : null, previousTools);
  const llmFullInputMessages = buildLlmFullInputMessages(
    round === 1 ? turn.inputMessages : null,
    llmInputMessages,
    previousTools,
  );
  const llmOutputMessages = buildLlmOutputMessagesWithTools(tools, reasoning);

  return {
    round,
    start_time: llmStartTime,
    end_time: lastToolEnd,
    llm_start_time: llmStartTime,
    llm_end_time: llmEndTime,
    llm_input_messages: llmInputMessages,
    llm_full_input_messages: llmFullInputMessages,
    llm_output_messages: llmOutputMessages,
    tools,
  };
}

function finalizeFinalStep(round, turn, llmStartTime, previousTools, reasoning) {
  const llmInputMessages = buildLlmInputMessages(round === 1 ? turn.prompt : null, previousTools);
  const llmFullInputMessages = buildLlmFullInputMessages(
    round === 1 ? turn.inputMessages : null,
    llmInputMessages,
    previousTools,
  );

  /** @type {MessagePart[]} */
  const parts = [];
  if (reasoning) {
    parts.push({ type: 'reasoning', content: reasoning });
  }
  if (turn.last_assistant_message) {
    parts.push({ type: 'text', content: turn.last_assistant_message });
  }

  /** @type {Message[]} */
  const llmOutputMessages = parts.length > 0
    ? [{ role: 'assistant', parts, finish_reason: 'stop' }]
    : [];

  return {
    round,
    start_time: llmStartTime,
    end_time: turn.end_time,
    llm_start_time: llmStartTime,
    llm_end_time: turn.end_time,
    llm_input_messages: llmInputMessages,
    llm_full_input_messages: llmFullInputMessages,
    llm_output_messages: llmOutputMessages,
    tools: [],
  };
}

function buildLlmInputMessages(userPrompt, previousTools) {
  if (userPrompt) {
    return [{ role: 'user', parts: [{ type: 'text', content: userPrompt }] }];
  }
  if (previousTools.length > 0) {
    return [
      {
        role: 'tool',
        parts: previousTools.map((t) => ({
          type: 'tool_call_response',
          id: t.tool_use_id,
          response: t.tool_response,
        })),
      },
    ];
  }
  return [];
}

function buildLlmFullInputMessages(turnInputMessages, deltaMessages, previousTools) {
  const hasTurnInput = Array.isArray(turnInputMessages) && turnInputMessages.length > 0;
  const base = hasTurnInput ? [...turnInputMessages] : [...deltaMessages];
  if (!hasTurnInput || previousTools.length === 0) return base;
  return [
    ...base,
    {
      role: 'tool',
      parts: previousTools.map((t) => ({
        type: 'tool_call_response',
        id: t.tool_use_id,
        response: t.tool_response,
      })),
    },
  ];
}

function buildLlmOutputMessagesWithTools(tools, reasoning) {
  if (tools.length === 0 && !reasoning) return [];
  /** @type {MessagePart[]} */
  const parts = [];
  if (reasoning) {
    parts.push({ type: 'reasoning', content: reasoning });
  }
  for (const t of tools) {
    parts.push({
      type: 'tool_call',
      id: t.tool_use_id,
      name: t.tool_name,
      arguments: t.tool_input,
    });
  }
  return [
    {
      role: 'assistant',
      parts,
      finish_reason: 'tool_call',
    },
  ];
}
