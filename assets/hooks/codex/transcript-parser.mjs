// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-parser.mjs — Codex rollout transcript JSONL 解析。
 *
 * 移植自 codex-plugin .../src/transcript.ts,改 ESM + JSDoc 类型。
 *
 * Codex 在 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 持久化全 session 事件,跨 turn 累加。
 * Stop hook 触发时:
 *   - parseTranscript(path, byteOffset, lastEmittedUsage) 增量读取
 *   - 按 task_started / turn_context 中的 turn_id 把 token_count 事件分桶到 tokenEventsByTurn
 *   - 跨 turn 心跳去重(codex 在 turn 间会重发同一份 last_token_usage)
 *
 * 关键 bug fix(均已保留):
 *   9.6 system_instructions / tool.definitions 提取
 *   9.9 byteOffset 增量 + turn_id 关联 + 心跳去重 + total_tokens 用源值
 */

import fs from 'node:fs';

/**
 * @typedef {object} TokenUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cachedInputTokens
 * @property {number} reasoningOutputTokens
 * @property {number} totalTokens
 */

/**
 * @typedef {object} ToolEvent
 * @property {'pre_tool_use'|'post_tool_use'} type
 * @property {number} timestamp
 * @property {string} turn_id
 * @property {string} tool_name
 * @property {any} [tool_input]
 * @property {any} [tool_response]
 * @property {string} tool_use_id
 */

/**
 * @typedef {object} TranscriptData
 * @property {string} model
 * @property {string} modelProvider
 * @property {TokenUsage[]} tokenEvents 扁平视图(按 transcript 顺序),fallback 用
 * @property {Map<string, TokenUsage[]>} tokenEventsByTurn 按 turn_id 分组(主消费路径)
 * @property {TokenUsage|null} totalUsage
 * @property {Array<{type:string, content:string}>=} systemInstruction
 * @property {Array<{type:string, name:string, description:string|null, parameters:any}>=} toolDefinitions
 * @property {ToolEvent[]} toolEvents 从 response_item 提取的工具调用事件
 * @property {Array<{turn_id:string, timestamp:number, message:string, phase:string}>} agentMessages 从 event_msg:agent_message 提取的推理/评论文本
 * @property {number} nextOffset 增量读取的下一个字节偏移
 * @property {TokenUsage|null} lastEmittedUsage 跨调用心跳去重锚点
 */

const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024; // 50MB

function parseMaybeJsonValue(value) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function extractMessageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.filter(Boolean).join('\n');
}

function transcriptMessageToInputMessage(payload) {
  const role = typeof payload?.role === 'string' ? payload.role : '';
  if (!role || role === 'assistant') return null;
  const content = extractMessageContentText(payload.content);
  if (!content) return null;
  return { role, parts: [{ type: 'text', content }] };
}

function entryTimestampSeconds(entry) {
  const ms = Date.parse(entry?.timestamp || '');
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

function mapDynamicTool(t) {
  const rawName = typeof t.name === 'string' ? t.name : '';
  if (!rawName) return null;
  const ns = typeof t.namespace === 'string' ? t.namespace : '';
  return {
    type: 'function',
    name: ns ? `${ns}/${rawName}` : rawName,
    description: typeof t.description === 'string' ? t.description : null,
    parameters: t.inputSchema ?? {},
  };
}

function parseTokenUsage(raw) {
  return {
    inputTokens: Number(raw['input_tokens'] || 0),
    outputTokens: Number(raw['output_tokens'] || 0),
    cachedInputTokens: Number(raw['cached_input_tokens'] || 0),
    reasoningOutputTokens: Number(raw['reasoning_output_tokens'] || 0),
    totalTokens: Number(raw['total_tokens'] || 0),
  };
}

/**
 * 跨 turn 心跳去重:codex 在 turn 间隙会重发与上一次相同的 last_token_usage 事件,
 * 只看四个数值字段就能识别。
 */
function tokenUsageEqual(a, b) {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.reasoningOutputTokens === b.reasoningOutputTokens &&
    a.totalTokens === b.totalTokens
  );
}

/**
 * 解析 codex transcript(rollout-*.jsonl)。
 *
 * @param {string} transcriptPath transcript 文件绝对路径
 * @param {number} [byteOffset=0] 起始字节偏移(>0 时增量读)
 * @param {TokenUsage|null} [initialLastUsage=null] 上次已采纳的 last_token_usage(跨调用去重锚点)
 * @returns {TranscriptData|null}
 */
export function parseTranscript(transcriptPath, byteOffset = 0, initialLastUsage = null) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  let content;
  let fileSize;
  try {
    const stat = fs.statSync(transcriptPath);
    fileSize = stat.size;

    if (byteOffset >= fileSize) {
      return {
        model: 'unknown',
        modelProvider: 'openai',
        tokenEvents: [],
        tokenEventsByTurn: new Map(),
        totalUsage: null,
        toolEvents: [],
        nextOffset: byteOffset,
        lastEmittedUsage: initialLastUsage,
      };
    }

    const readFrom = Math.max(byteOffset, 0);
    const rawLen = fileSize - readFrom;
    const readLen = Math.min(rawLen, MAX_TRANSCRIPT_READ_BYTES);
    if (readLen < rawLen) {
      process.stderr.write(`[codex-transcript-parser] transcript ${transcriptPath} truncated: ${rawLen} bytes > ${MAX_TRANSCRIPT_READ_BYTES} limit\n`);
    }
    if (readFrom > 0) {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, readFrom);
        content = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(transcriptPath, 'utf-8').slice(0, MAX_TRANSCRIPT_READ_BYTES);
    }
  } catch (err) {
    throw new Error(`[codex-transcript-parser] failed to read ${transcriptPath}: ${err?.message || err}`);
  }

  let model = 'unknown';
  let modelProvider = 'openai';
  /** @type {TokenUsage[]} */
  const tokenEvents = [];
  /** @type {Map<string, TokenUsage[]>} */
  const tokenEventsByTurn = new Map();
  /** @type {TokenUsage|null} */
  let lastTotalUsage = null;
  let baseInstructionsText = '';
  let lastDeveloperInstructions = '';
  /** @type {Array<ReturnType<typeof mapDynamicTool>>} */
  const toolDefs = [];

  // tool 事件提取（从 response_item:function_call/function_call_output）
  /** @type {ToolEvent[]} */
  const toolEvents = [];
  const pendingToolCalls = new Map();

  // agent_message 事件提取（从 event_msg:agent_message）— 模型的推理/评论文本
  /** @type {Array<{turn_id:string, timestamp:number, message:string, phase:string}>} */
  const agentMessages = [];

  // 当前正在处理的 turn_id;由 task_started / turn_context 设置
  let currentTurnId = null;

  // turn 边界列表：记录 transcript 中每个 turn_context 的 turn_id 和时间戳，
  // 用于在 writeSessionJsonl 中驱动 turn 切分（替代仅靠 user_prompt_submit hook）
  const turnBoundaries = [];
  const pendingInputMessages = [];

  // 父 agent 工具调用的 call_id 白名单。父 transcript 只包含父 agent 的 function_call，
  // 子 agent 的工具调用在子 transcript 中。resolveTurns 用此集合过滤 state.events 中
  // 混入的子 agent pre/post_tool_use 事件。
  const parentToolCallIds = new Set();

  // 子 agent 信息列表。从 spawn_agent 的 function_call_output 中提取。
  // 将来实现 subagent 嵌套时使用：通过 agent_id 定位子 transcript，
  // 通过 parent_call_id 关联到父 TOOL span。
  const childAgents = [];

  // 跨 turn 心跳去重锚点;由调用方从 state.transcript_last_token_usage 传入
  let lastEmittedUsage = initialLastUsage;

  let lineIndex = 0;
  // web_search_call 只有完成时间（web_search_end），没有开始时间。
  // 用搜索前最后一个非 web_search 事件的时间戳近似搜索发起时刻，
  // 使 tool.call 与 tool.result 有合理的时间差（duration > 0）。
  let lastNonWebSearchTs = 0;
  for (const line of content.split('\n')) {
    lineIndex++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const entryType = entry.type;
    const payload = entry.payload;
    if (!payload || typeof payload !== 'object') continue;

    // Track the last non-web_search timestamp for approximating web_search duration
    const payloadTypeForTs = payload.type;
    if (payloadTypeForTs !== 'web_search_end' && payloadTypeForTs !== 'web_search_call') {
      const ts = entryTimestampSeconds(entry);
      if (ts > 0) lastNonWebSearchTs = ts;
    }

    if (entryType === 'session_meta') {
      if (typeof payload.model_provider === 'string' && payload.model_provider) {
        modelProvider = payload.model_provider;
      }

      const bi = payload.base_instructions;
      if (bi && typeof bi === 'object') {
        if (typeof bi.text === 'string' && bi.text) baseInstructionsText = bi.text;
      } else if (typeof bi === 'string' && bi) {
        baseInstructionsText = bi;
      }

      if (Array.isArray(payload.dynamic_tools)) {
        for (const t of payload.dynamic_tools) {
          if (!t || typeof t !== 'object') continue;
          const mapped = mapDynamicTool(t);
          if (mapped) toolDefs.push(mapped);
        }
      }
    } else if (entryType === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) model = payload.model;
      if (typeof payload.developer_instructions === 'string' && payload.developer_instructions) {
        lastDeveloperInstructions = payload.developer_instructions;
      }
      if (typeof payload.turn_id === 'string' && payload.turn_id) {
        currentTurnId = payload.turn_id;
        const lastBoundary = turnBoundaries[turnBoundaries.length - 1];
        if (lastBoundary?.turn_id === payload.turn_id) {
          if (pendingInputMessages.length > 0) {
            lastBoundary.inputMessages ??= [];
            lastBoundary.inputMessages.push(...pendingInputMessages.splice(0));
          }
        } else {
          turnBoundaries.push({
            turn_id: payload.turn_id,
            timestamp: entryTimestampSeconds(entry),
            prompt: '',
            inputMessages: pendingInputMessages.splice(0),
          });
        }
      }
    } else if (entryType === 'event_msg') {
      const payloadType = payload.type;

      // 提取用户输入文本，关联到当前 turn（turnBoundaries 最后一项）
      if (payloadType === 'user_message') {
        const msg = typeof payload.message === 'string' ? payload.message : '';
        if (msg && turnBoundaries.length > 0) {
          const lastBoundary = turnBoundaries[turnBoundaries.length - 1];
          if (!lastBoundary.prompt) lastBoundary.prompt = msg;
        }
      }

      // 提取 agent_message（模型的推理/评论文本，Codex TUI 中显示的"思考"内容）
      if (payloadType === 'agent_message') {
        const msg = typeof payload.message === 'string' ? payload.message : '';
        if (msg) {
          agentMessages.push({
            turn_id: currentTurnId ?? '',
            timestamp: entryTimestampSeconds(entry),
            message: msg,
            phase: typeof payload.phase === 'string' ? payload.phase : '',
          });
        }
      }

      if (payloadType === 'task_started') {
        if (typeof payload.turn_id === 'string' && payload.turn_id) {
          currentTurnId = payload.turn_id;
        }
        continue;
      }

      if (payloadType === 'token_count') {
        const info = payload.info;
        if (!info || typeof info !== 'object') continue;

        if (info.last_token_usage && typeof info.last_token_usage === 'object') {
          const usage = parseTokenUsage(info.last_token_usage);
          // 跨 turn 全局去重:与上一次已采纳值相同 → 心跳事件,跳过
          if (lastEmittedUsage && tokenUsageEqual(lastEmittedUsage, usage)) {
            // skip heartbeat
          } else {
            const tid = currentTurnId ?? '';
            tokenEvents.push(usage);
            const list = tokenEventsByTurn.get(tid);
            if (list) {
              list.push(usage);
            } else {
              tokenEventsByTurn.set(tid, [usage]);
            }
            lastEmittedUsage = usage;
          }
        }

        if (info.total_token_usage && typeof info.total_token_usage === 'object') {
          lastTotalUsage = parseTokenUsage(info.total_token_usage);
        }
      }
    } else if (entryType === 'response_item') {
      const itemType = payload.type;
      if (itemType === 'message') {
        const inputMessage = transcriptMessageToInputMessage(payload);
        if (inputMessage) {
          const lastBoundary = turnBoundaries[turnBoundaries.length - 1];
          if (lastBoundary && currentTurnId) {
            lastBoundary.inputMessages ??= [];
            lastBoundary.inputMessages.push(inputMessage);
            if (inputMessage.role === 'user' && !lastBoundary.prompt) {
              lastBoundary.prompt = inputMessage.parts[0]?.content || '';
            }
          } else {
            pendingInputMessages.push(inputMessage);
          }
        }
      } else if (itemType === 'function_call') {
        const callId = String(payload.call_id || payload.id || '');
        if (callId) {
          const toolName = String(payload.name || 'unknown');
          const evt = {
            type: 'pre_tool_use',
            timestamp: entryTimestampSeconds(entry),
            turn_id: currentTurnId ?? '',
            tool_name: toolName,
            tool_input: parseMaybeJsonValue(payload.arguments),
            tool_use_id: callId,
          };
          pendingToolCalls.set(callId, evt);
          toolEvents.push(evt);
          // 父 transcript 中所有 function_call 的 call_id 都是父 agent 的工具调用。
          // 子 agent 的工具调用在子 transcript 中，不会出现在这里。
          parentToolCallIds.add(callId);
        }
      } else if (itemType === 'custom_tool_call') {
        const callId = String(payload.call_id || payload.id || '');
        if (callId) {
          const toolName = String(payload.name || 'custom_tool');
          const evt = {
            type: 'pre_tool_use',
            timestamp: entryTimestampSeconds(entry),
            turn_id: currentTurnId ?? '',
            tool_name: toolName,
            tool_input: parseMaybeJsonValue(payload.input),
            tool_use_id: callId,
          };
          pendingToolCalls.set(callId, evt);
          toolEvents.push(evt);
          parentToolCallIds.add(callId);
        }
      } else if (itemType === 'web_search_call') {
        const endTime = entryTimestampSeconds(entry);
        const startTime = lastNonWebSearchTs > 0 ? lastNonWebSearchTs : endTime;
        const callId = String(payload.call_id || payload.id || `web_search:${endTime}:${lineIndex}`);
        const evt = {
          type: 'pre_tool_use',
          timestamp: startTime,
          turn_id: currentTurnId ?? '',
          tool_name: 'web_search',
          tool_input: parseMaybeJsonValue(payload.action),
          tool_use_id: callId,
        };
        toolEvents.push(evt);
        toolEvents.push({
          type: 'post_tool_use',
          timestamp: endTime,
          turn_id: currentTurnId ?? '',
          tool_name: 'web_search',
          tool_response: {
            ...(payload.status !== undefined ? { status: payload.status } : {}),
            ...(payload.action !== undefined ? { action: parseMaybeJsonValue(payload.action) } : {}),
          },
          tool_use_id: callId,
        });
        parentToolCallIds.add(callId);
      } else if (itemType === 'tool_search_call') {
        const callId = String(payload.call_id || payload.id || '');
        if (callId) {
          const evt = {
            type: 'pre_tool_use',
            timestamp: entryTimestampSeconds(entry),
            turn_id: currentTurnId ?? '',
            tool_name: 'tool_search',
            tool_input: parseMaybeJsonValue(payload.arguments),
            tool_use_id: callId,
          };
          pendingToolCalls.set(callId, evt);
          toolEvents.push(evt);
          parentToolCallIds.add(callId);
        }
      } else if (itemType === 'function_call_output') {
        const callId = String(payload.call_id || payload.id || '');
        if (callId) {
          const pre = pendingToolCalls.get(callId);
          toolEvents.push({
            type: 'post_tool_use',
            timestamp: entryTimestampSeconds(entry),
            turn_id: currentTurnId ?? pre?.turn_id ?? '',
            tool_name: pre?.tool_name || 'unknown',
            tool_response: parseMaybeJsonValue(payload.output),
            tool_use_id: callId,
          });
          pendingToolCalls.delete(callId);

          // spawn_agent 的结果包含子 agent 的 session_id（agent_id）和 call_id 的映射。
          // 将来实现 subagent 嵌套时，可以用 agent_id 定位子 transcript，
          // 用 call_id 关联到父 TOOL span（类似 Cursor 的 parent_tool_call.id 协议）。
          if (pre?.tool_name === 'spawn_agent') {
            let output = parseMaybeJsonValue(payload.output);
            if (typeof output === 'string') {
              try { output = JSON.parse(output); } catch {}
            }
            if (output && typeof output === 'object' && output.agent_id) {
              childAgents.push({
                agent_id: output.agent_id,
                nickname: output.nickname || '',
                parent_call_id: callId,
                parent_turn_id: currentTurnId ?? '',
                timestamp: entryTimestampSeconds(entry),
              });
            }
          }
        }
      } else if (itemType === 'custom_tool_call_output') {
        const callId = String(payload.call_id || payload.id || '');
        if (callId) {
          const pre = pendingToolCalls.get(callId);
          toolEvents.push({
            type: 'post_tool_use',
            timestamp: entryTimestampSeconds(entry),
            turn_id: currentTurnId ?? pre?.turn_id ?? '',
            tool_name: pre?.tool_name || 'custom_tool',
            tool_response: parseMaybeJsonValue(payload.output),
            tool_use_id: callId,
          });
          pendingToolCalls.delete(callId);
        }
      } else if (itemType === 'tool_search_output') {
        const callId = String(payload.call_id || payload.id || '');
        if (callId) {
          const pre = pendingToolCalls.get(callId);
          toolEvents.push({
            type: 'post_tool_use',
            timestamp: entryTimestampSeconds(entry),
            turn_id: currentTurnId ?? pre?.turn_id ?? '',
            tool_name: pre?.tool_name || 'tool_search',
            tool_response: {
              ...(payload.status !== undefined ? { status: payload.status } : {}),
              ...(payload.execution !== undefined ? { execution: payload.execution } : {}),
              ...(payload.tools !== undefined ? { tools: parseMaybeJsonValue(payload.tools) } : {}),
            },
            tool_use_id: callId,
          });
          pendingToolCalls.delete(callId);
        }
      }
    }
  }

  // 为孤立的 function_call（无 function_call_output）生成 synthetic post_tool_use，
  // 避免 buildReactSteps 中 pendingToolIds 永远不清空导致 step 切分失效
  for (const [callId, preEvent] of pendingToolCalls) {
    toolEvents.push({
      type: 'post_tool_use',
      timestamp: preEvent.timestamp,
      turn_id: preEvent.turn_id,
      tool_name: preEvent.tool_name,
      tool_response: null,
      tool_use_id: callId,
    });
  }

  /** @type {Array<{type:string, content:string}>} */
  const systemInstruction = [];
  if (baseInstructionsText) {
    systemInstruction.push({ type: 'text', content: baseInstructionsText });
  }
  if (lastDeveloperInstructions) {
    systemInstruction.push({ type: 'text', content: lastDeveloperInstructions });
  }

  const hasContent =
    tokenEvents.length > 0 ||
    !!lastTotalUsage ||
    systemInstruction.length > 0 ||
    toolDefs.length > 0 ||
    toolEvents.length > 0 ||
    agentMessages.length > 0;

  if (!hasContent) {
    return {
      model,
      modelProvider,
      tokenEvents: [],
      tokenEventsByTurn: new Map(),
      turnBoundaries,
      parentToolCallIds,
      childAgents,
      agentMessages: [],
      totalUsage: null,
      toolEvents: [],
      nextOffset: fileSize,
      lastEmittedUsage,
    };
  }

  return {
    model,
    modelProvider,
    tokenEvents,
    tokenEventsByTurn,
    totalUsage: lastTotalUsage,
    systemInstruction: systemInstruction.length > 0 ? systemInstruction : undefined,
    toolDefinitions: toolDefs.length > 0 ? toolDefs : undefined,
    toolEvents,
    turnBoundaries,
    parentToolCallIds,
    childAgents,
    agentMessages,
    nextOffset: fileSize,
    lastEmittedUsage,
  };
}
