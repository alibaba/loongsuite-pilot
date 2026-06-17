// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-assembler.mjs — Cursor Windows transcript 驱动的 output 组装。
 *
 * 仅在 Windows 平台 (process.platform === 'win32') 的 stop 事件中调用。
 * 解析 Cursor agent-transcripts/<sessionId>/<sessionId>.jsonl，
 * 结合 journal hook events 提供的 metadata（tokens, timestamps, tool details），
 * 生成符合 schema 的 output records，彻底绕过 hook payload 的中文乱码问题。
 *
 * 架构参考 claude-code/transcript-parser.mjs 的 exportSession 模式。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  resolveUserId,
  timestampToUnixNanos,
  applyHookContentPolicy,
  sanitizeObject,
  toJsonValue,
  parseMaybeJson,
  inferProviderName,
} from '../agent-event-normalizer.mjs';

// ─── Public API ───

/**
 * 从 transcript 文件 + journal events 构建 output records。
 *
 * @param {string}   transcriptPath - Cursor transcript JSONL 文件路径
 * @param {object[]} journalEvents  - 当前 turn 的所有 journal events
 * @param {object}   options        - { runtimeConfig, stopConversationId }
 * @returns {object[]|null}  records，失败时返回 null（触发 fallback）
 */
export function buildCursorRecordsFromTranscript(transcriptPath, journalEvents, options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  const turn = parseCursorTranscript(transcriptPath);
  if (!turn) return null;

  const runtimeConfig = options.runtimeConfig || {};
  const stopConversationId = options.stopConversationId;

  const promptEvent = stopConversationId
    ? journalEvents.find(e => e.hook_event === 'beforeSubmitPrompt' && e.conversation_id === stopConversationId)
    : journalEvents.find(e => e.hook_event === 'beforeSubmitPrompt');
  if (!promptEvent) return null;

  const parentConvId = promptEvent.conversation_id;
  const turnId = promptEvent.generation_id || parentConvId;
  const traceId = deriveTraceId(turnId);
  const userId = resolveUserId({}, runtimeConfig);
  const model = promptEvent.model || 'unknown';

  const parentEvents = journalEvents
    .filter(e => e.conversation_id === parentConvId)
    .filter(e => e.hook_event !== 'sessionStart')
    .sort((a, b) => tsMs(a) - tsMs(b));

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': parentConvId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': 'cursor',
    'user.id': userId,
  };

  const records = [];

  // 1. user prompt entry (other event)
  const userText = turn.userText || promptEvent.prompt;
  if (userText) {
    records.push(applyPolicy({
      time_unix_nano: eventTs(promptEvent),
      observed_time_unix_nano: eventTs(promptEvent),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      'gen_ai.provider.name': inferProvider(model),
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: userText }] },
      ],
      'agent.cursor.hook_event_name': 'beforeSubmitPrompt',
      'agent.cursor.composer_mode': promptEvent.composer_mode,
    }, runtimeConfig));
  }

  // 2. Align transcript assistant entries with hook steps
  const steps = alignSteps(turn.assistantEntries, parentEvents);

  // 3. Build per-step records
  const stopEvent = parentEvents.find(e => e.hook_event === 'stop');
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepRound = i + 1;
    const stepId = `${turnId}:s${stepRound}`;
    const isLast = i === steps.length - 1;

    // llm.request
    const reqEvent = step.thoughtEvent || step.responseEvent || parentEvents[0];
    const prevToolResults = step.toolResults.map(tr => ({
      toolUseId: tr.tool_use_id,
      result: tr.tool_output,
    }));
    const inputMessages = [];
    if (stepRound === 1 && userText) {
      inputMessages.push({ role: 'user', parts: [{ type: 'text', content: userText }] });
    } else if (prevToolResults.length > 0) {
      inputMessages.push({
        role: 'tool',
        parts: prevToolResults.map(tr => ({
          type: 'tool_call_response',
          id: tr.toolUseId || null,
          response: tr.result ? (typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result)) : '',
        })),
      });
    }

    records.push(applyPolicy({
      time_unix_nano: eventTs(reqEvent),
      observed_time_unix_nano: eventTs(reqEvent),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      'gen_ai.step.id': stepId,
      'gen_ai.provider.name': inferProvider(model),
      'gen_ai.request.model': reqEvent.model || model,
      'gen_ai.input.messages': inputMessages.length > 0 ? inputMessages : undefined,
      'agent.cursor.hook_event_name': reqEvent.hook_event,
      'agent.cursor.llm_request_time_source': reqEvent.hook_event === 'afterAgentThought' && reqEvent.duration_ms != null
        ? 'thought_duration' : undefined,
    }, runtimeConfig));

    // tool.call records
    for (const toolCallEv of step.toolCalls) {
      records.push(applyPolicy({
        time_unix_nano: eventTs(toolCallEv),
        observed_time_unix_nano: eventTs(toolCallEv),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': toolCallEv.tool_name,
        'gen_ai.tool.call.id': toolCallEv.tool_use_id,
        'gen_ai.tool.call.arguments': toJsonValue(parseMaybeJson(toolCallEv.tool_input)),
        'agent.cursor.hook_event_name': toolCallEv.hook_event,
      }, runtimeConfig));
    }

    // tool.result records
    for (const toolResultEv of step.toolResults) {
      const isFailure = toolResultEv.hook_event === 'postToolUseFailure';
      records.push(applyPolicy({
        time_unix_nano: eventTs(toolResultEv),
        observed_time_unix_nano: eventTs(toolResultEv),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.result',
        ...baseFields,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': toolResultEv.tool_name,
        'gen_ai.tool.call.id': toolResultEv.tool_use_id,
        'gen_ai.tool.call.result': isFailure ? undefined : toJsonValue(parseMaybeJson(toolResultEv.tool_output)),
        'gen_ai.tool.call.duration': toolResultEv.duration_ms,
        'tool.result.status': isFailure ? 'failure' : undefined,
        'error.type': isFailure ? (toolResultEv.failure_type || 'tool_use_failure') : undefined,
        'error.message': isFailure ? toolResultEv.error_message : undefined,
        'agent.cursor.hook_event_name': toolResultEv.hook_event,
      }, runtimeConfig));
    }

    // llm.response — text from transcript, tokens from hook
    const respEvent = step.responseEvent || step.thoughtEvent || (isLast ? stopEvent : null);
    const respTs = respEvent ? eventTs(respEvent) : eventTs(parentEvents[parentEvents.length - 1] || promptEvent);
    const assistantText = step.text;

    const responseRec = applyPolicy({
      time_unix_nano: respTs,
      observed_time_unix_nano: respTs,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': crypto.randomUUID(),
      'gen_ai.provider.name': inferProvider(respEvent?.model || model),
      'gen_ai.request.model': respEvent?.model || model,
      'gen_ai.response.model': respEvent?.model || model,
      'gen_ai.output.messages': [
        {
          role: 'assistant',
          parts: assistantText ? [{ type: 'text', content: assistantText }] : [],
          finish_reason: isLast ? 'stop' : (step.toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        },
      ],
      'gen_ai.response.finish_reasons': [isLast ? 'stop' : (step.toolCalls.length > 0 ? 'tool_calls' : 'stop')],
      'agent.cursor.hook_event_name': respEvent?.hook_event || 'afterAgentResponse',
      'agent.cursor.llm_response_time_source': respEvent?.hook_event === 'afterAgentThought'
        ? 'after_agent_thought' : 'after_agent_response',
    }, runtimeConfig);

    // Merge tokens from hook event
    if (respEvent) mergeTokens(responseRec, respEvent);
    // If last step and no per-step tokens, use stop event tokens
    if (isLast && !responseRec['gen_ai.usage.input_tokens'] && stopEvent) {
      mergeTokens(responseRec, stopEvent);
    }

    records.push(responseRec);
  }

  return records.length > 0 ? records : null;
}

// ─── Transcript Parser ───

/**
 * 解析 Cursor transcript JSONL，返回当前 turn 的 userText 和 assistantEntries。
 * Cursor transcript 格式：
 *   {"role":"user","message":{"content":[{"type":"text","text":"<user_query>...<user_query>"}]}}
 *   {"role":"assistant","message":{"content":[{"type":"text","text":"..."},{"type":"tool_use","name":"...","id":"..."}]}}
 *   {"type":"turn_ended","status":"success"}
 */
function parseCursorTranscript(transcriptPath) {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    let lastUserText = null;
    const assistantEntries = [];

    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.role === 'user' && entry.message?.content) {
        const parts = entry.message.content.filter(p => p.type === 'text' && p.text);
        const text = parts.map(p => p.text.replace(/<\/?user_query>\n?/g, '').trim()).filter(Boolean).join('');
        if (text) lastUserText = text;
      }

      if (entry.role === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter(p => p.type === 'text' && p.text);
        const toolUseParts = entry.message.content.filter(p => p.type === 'tool_use');

        const rawText = textParts.map(p => p.text).join('');
        const text = isUsableText(rawText) ? rawText : null;
        const toolUseIds = toolUseParts.map(p => p.id).filter(Boolean);

        assistantEntries.push({ text, toolUseIds });
      }
    }

    if (!lastUserText && assistantEntries.length === 0) return null;
    return { userText: lastUserText, assistantEntries };
  } catch {
    return null;
  }
}

/** Text is usable if it's non-empty and not purely [REDACTED] */
function isUsableText(text) {
  if (!text || !text.trim()) return false;
  const stripped = text.replace(/\[REDACTED\]/g, '').trim();
  return stripped.length > 0;
}

// ─── Step Alignment ───

/**
 * 将 transcript assistant entries 与 journal hook events 对齐，构建 steps 数组。
 *
 * 对齐策略：
 * 1. 构建 toolUseId → assistantEntry index 的映射
 * 2. 遍历 journal preToolUse events，通过 tool_use_id 找到对应的 entry index
 * 3. 将 journal events（thoughts/responses/toolCalls/toolResults）按 step 分组
 * 4. 最后一个无 toolUseIds 的 assistant entry = 最终 step
 */
function alignSteps(assistantEntries, parentEvents) {
  if (!assistantEntries || assistantEntries.length === 0) {
    // No transcript entries: create a single step with all events
    return [buildStepFromEvents(parentEvents, null)];
  }

  // Build toolUseId → entryIndex map
  const toolIdToEntryIdx = new Map();
  for (let i = 0; i < assistantEntries.length; i++) {
    for (const id of assistantEntries[i].toolUseIds) {
      toolIdToEntryIdx.set(id, i);
    }
  }

  // Find which journal tool calls belong to which entry
  const toolCalls = parentEvents.filter(e => e.hook_event === 'preToolUse');
  const toolResults = parentEvents.filter(e =>
    e.hook_event === 'postToolUse' || e.hook_event === 'postToolUseFailure'
  );

  // Determine entry index for each tool call
  const entryToToolCalls = new Map();
  const entryToToolResults = new Map();
  for (const tc of toolCalls) {
    const entryIdx = toolIdToEntryIdx.has(tc.tool_use_id)
      ? toolIdToEntryIdx.get(tc.tool_use_id)
      : assistantEntries.length - 1; // fallback: last entry
    if (!entryToToolCalls.has(entryIdx)) entryToToolCalls.set(entryIdx, []);
    entryToToolCalls.get(entryIdx).push(tc);
  }
  for (const tr of toolResults) {
    const entryIdx = toolIdToEntryIdx.has(tr.tool_use_id)
      ? toolIdToEntryIdx.get(tr.tool_use_id)
      : assistantEntries.length - 1;
    if (!entryToToolResults.has(entryIdx)) entryToToolResults.set(entryIdx, []);
    entryToToolResults.get(entryIdx).push(tr);
  }

  // Find thought/response hook events per step
  // Group thought events: each thought event corresponds to the step that produced it
  const thoughtEvents = parentEvents.filter(e => e.hook_event === 'afterAgentThought');
  const responseEvents = parentEvents.filter(e => e.hook_event === 'afterAgentResponse');

  // Build steps: one per assistant entry
  const steps = [];
  for (let i = 0; i < assistantEntries.length; i++) {
    const entry = assistantEntries[i];
    steps.push({
      text: entry.text,
      toolUseIds: entry.toolUseIds,
      toolCalls: entryToToolCalls.get(i) || [],
      toolResults: entryToToolResults.get(i) || [],
      // Assign thought events: steps with tool calls get earlier thoughts; last step gets last thought
      thoughtEvent: thoughtEvents[i] || thoughtEvents[thoughtEvents.length - 1] || null,
      responseEvent: responseEvents[i] || (i === assistantEntries.length - 1 ? responseEvents[responseEvents.length - 1] : null) || null,
    });
  }

  // If no transcript entries matched steps, fall back to single step
  if (steps.length === 0) {
    return [buildStepFromEvents(parentEvents, null)];
  }

  return steps;
}

function buildStepFromEvents(parentEvents, text) {
  return {
    text,
    toolUseIds: [],
    toolCalls: parentEvents.filter(e => e.hook_event === 'preToolUse'),
    toolResults: parentEvents.filter(e => e.hook_event === 'postToolUse' || e.hook_event === 'postToolUseFailure'),
    thoughtEvent: parentEvents.find(e => e.hook_event === 'afterAgentThought') || null,
    responseEvent: parentEvents.find(e => e.hook_event === 'afterAgentResponse') || null,
  };
}

// ─── Helpers ───

function mergeTokens(rec, ev) {
  if (ev.input_tokens != null) rec['gen_ai.usage.input_tokens'] = ev.input_tokens;
  if (ev.output_tokens != null) rec['gen_ai.usage.output_tokens'] = ev.output_tokens;
  if (ev.cache_read_tokens != null) rec['gen_ai.usage.cache_read.input_tokens'] = ev.cache_read_tokens;
  if (ev.cache_write_tokens != null) rec['gen_ai.usage.cache_creation.input_tokens'] = ev.cache_write_tokens;
  if (ev.input_tokens != null && ev.output_tokens != null) {
    rec['gen_ai.usage.total_tokens'] = ev.input_tokens + ev.output_tokens;
  }
}

function deriveTraceId(turnId) {
  if (!turnId) return crypto.randomUUID().replace(/-/g, '');
  return crypto.createHash('sha256').update(`cursor:${turnId}`).digest('hex').slice(0, 32);
}

function eventTs(ev) {
  if (ev?._journal_ts) return timestampToUnixNanos(ev._journal_ts);
  return timestampToUnixNanos(new Date());
}

function tsMs(ev) {
  if (ev?._journal_ts) return new Date(ev._journal_ts).getTime();
  return Date.now();
}

function inferProvider(model) {
  const provider = inferProviderName({ 'gen_ai.request.model': model, 'gen_ai.agent.type': 'cursor' });
  if (provider === 'unknown' && /composer/i.test(model)) return 'openai';
  return provider;
}

function applyPolicy(record, runtimeConfig) {
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || {};
}
