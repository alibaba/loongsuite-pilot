#!/usr/bin/env node
/**
 * Qoder Work hook transcript processor.
 *
 * Parses transcript lines, groups assistant blocks by parentUuid
 * (= one LLM call), merges thinking+text+tool_use into unified
 * multi-part responses, assigns turn.id/step.id per spec.
 *
 * Follows the same architectural pattern as qoder-hook-processor.mjs
 * but adapted for QoderWork's transcript format (no progress events,
 * parentUuid-based grouping).
 */

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  parseArgs,
  parseStdinPayload,
  logDebug,
  getLineRange,
  readTranscriptLines,
  appendRowsToHistory,
  updateLineRecord,
  loadHookRuntimeConfig,
  HOOKS_DIR,
} from './shared/hook-processor-base.mjs';
import {
  inferProviderName,
  resolveUserId,
  timestampToUnixNanos,
  applyHookContentPolicy,
  sanitizeObject,
  getStringValue,
} from './agent-event-normalizer.mjs';

async function main() {
  const { agentId, logPrefix } = parseArgs();
  const payload = await parseStdinPayload(agentId);
  if (!payload) return;

  const { transcriptPath, sessionId, cwd: rawCwd } = payload;
  const cwd = resolveQoderWorkProjectDir(rawCwd, agentId);
  const runtimeConfig = loadHookRuntimeConfig(path.join(HOOKS_DIR, '..'));

  const range = getLineRange(agentId, transcriptPath, sessionId);
  if (!range) return;

  const [startLine, endLine] = range;
  const lines = readTranscriptLines(transcriptPath, startLine, endLine);
  logDebug(agentId, `Read ${lines.length} lines from ${transcriptPath} (range: ${startLine}-${endLine})`);
  if (!lines.length) {
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    return;
  }

  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* skip */ }
  }
  if (!parsed.length) {
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    return;
  }

  const records = processTranscript(parsed, sessionId, agentId, runtimeConfig, cwd);
  logDebug(agentId, `Produced ${records.length} events`);

  const rowsToAppend = records.filter(Boolean).map(r => JSON.stringify(r));
  const success = appendRowsToHistory(agentId, logPrefix, rowsToAppend);
  if (success) {
    logDebug(agentId, `Successfully appended ${rowsToAppend.length} rows`);
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
  }
}

function processTranscript(parsed, sessionId, agentId, runtimeConfig, cwd) {
  const observedTs = timestampToUnixNanos(Date.now());
  const records = [];

  // Skip review-copy sessions: QoderWork forks a duplicate transcript with an
  // appended automated review task. The original session already covers the
  // user conversation, so processing the copy would produce duplicate traces.
  const isReviewCopy = parsed.some(row =>
    row.type === 'user' &&
    typeof row.message?.content?.[0]?.text === 'string' &&
    row.message.content[0].text.startsWith('[SYSTEM: This is an automated background review task')
  );
  if (isReviewCopy) {
    logDebug(agentId, `Skipping review-copy session ${sessionId}`);
    return records;
  }

  // Filter out non-content rows
  const contentRows = parsed.filter(row => {
    const type = row.type;
    if (!type || type === 'ai-title' || type === 'last-prompt' || type === 'session_meta' || type === 'progress') return false;
    if (row.isSidechain === true || row.isSidechain === 'true') return false;
    if (row.isMeta === true || row.isMeta === 'true') return false;
    return type === 'user' || type === 'assistant';
  });

  if (!contentRows.length) return records;

  // Determine user info from first row
  const firstRow = contentRows[0];
  const userId = resolveUserId(firstRow, runtimeConfig);
  const providerName = inferProviderName({ 'gen_ai.agent.type': 'qoder-work' });
  const version = getStringValue(firstRow, 'version') || '';

  // Split into turns: each user message (non tool_result) starts a new turn
  const turns = splitIntoTurns(contentRows);

  for (const turn of turns) {
    const turnId = getTurnIdForRows(turn);
    const turnRecords = buildTurnEvents(turn, turnId, sessionId, userId, providerName, version, observedTs, runtimeConfig, cwd);
    records.push(...turnRecords);
  }

  return records;
}

function splitIntoTurns(contentRows) {
  const turns = [];
  let currentTurn = [];

  for (const row of contentRows) {
    if (isPromptRow(row)) {
      if (currentTurn.length > 0) {
        turns.push(currentTurn);
      }
      currentTurn = [row];
    } else {
      currentTurn.push(row);
    }
  }
  if (currentTurn.length > 0) turns.push(currentTurn);
  return turns;
}

function isPromptRow(row) {
  return row.type === 'user' && !isToolResult(row) && !isSystemInjection(row);
}

function getTurnIdForRows(turnRows) {
  const promptRow = turnRows.find(isPromptRow);
  return promptRow?.promptId || promptRow?.uuid || crypto.randomUUID();
}

function isSystemInjection(row) {
  const text = extractText(row).trimStart();
  if (text.startsWith('<command-message>') ||
    text.startsWith('<command-name>') ||
    text.startsWith('[Request interrupted') ||
    text.startsWith('[SYSTEM: This is an automated background review task')) {
    return true;
  }
  return isPureSystemReminder(text);
}

function isPureSystemReminder(text) {
  return text.startsWith('<system-reminder>')
    && text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim().length === 0;
}

function buildTurnEvents(turnRows, turnId, sessionId, userId, providerName, version, observedTs, runtimeConfig, cwd) {
  const records = [];

  // Find the user prompt
  const userRow = turnRows.find(isPromptRow);
  const promptId = userRow?.promptId || turnId;
  const turnMetadata = promptId ? { 'agent.qoderwork.promptId': promptId } : {};

  // User-hook event (no step.id, no model — per §5 of EVENT_LOG_TO_TRACE_SPEC)
  if (userRow) {
    const userText = extractText(userRow);
    if (userText) {
      records.push(buildRecord({
        ...turnMetadata,
        'event.name': 'other',
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': 'qoder-work',
        'gen_ai.provider.name': providerName,
        'user.id': userId,
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: userText }] }],
        time_unix_nano: timestampToUnixNanos(userRow.timestamp),
        observed_time_unix_nano: observedTs,
        version,
      }, turnRows[0], runtimeConfig, cwd));
    }
  }

  // Group assistant rows by tool_result boundaries — each group = one LLM call.
  // Reason: QoderWork sometimes splits one LLM response across multiple assistant
  // rows with different parentUuids (e.g. thinking row + separate tool_use row).
  // groupByParentUuid would wrongly split these into multiple "steps" and break
  // timing (the second half would incorrectly inherit the tool_result's ts as
  // llm.request time). Tool_result boundaries are the semantically correct split
  // since the LLM only receives tool outputs and issues a new response at those points.
  const assistantRows = turnRows.filter(r => r.type === 'assistant');
  const toolResultRows = turnRows.filter(r => r.type === 'user' && isToolResult(r));
  const toolResultsByUseId = new Map();
  for (const row of toolResultRows) {
    const content = Array.isArray(row.message?.content) ? row.message.content : [];
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id && !toolResultsByUseId.has(block.tool_use_id)) {
        toolResultsByUseId.set(block.tool_use_id, { row, block });
      }
    }
  }

  const llmGroups = groupAssistantRowsByToolResults(turnRows);

  const userText = userRow ? extractText(userRow) : '';
  const userTs = userRow ? timestampToUnixNanos(userRow.timestamp) : undefined;
  let prevToolCalls = []; // tool_call ids from previous step, for building tool_result delta
  let prevStepLastToolResultTs = undefined; // 上一个 step 最后一个 tool_result 的 nano ts，用于本 step llm.request 时间

  let stepCounter = 0;
  for (const group of llmGroups) {
    stepCounter++;
    const stepId = `${turnId}:s${stepCounter}`;

    // Build input.messages_delta for this step's llm.request:
    // - Step 1: user prompt
    // - Step N>1: previous step's tool results
    let inputDelta;
    if (stepCounter === 1 && userText) {
      inputDelta = [{ role: 'user', parts: [{ type: 'text', content: userText }] }];
    } else if (prevToolCalls.length > 0) {
      const toolParts = [];
      for (const tc of prevToolCalls) {
        const matchingResult = toolResultsByUseId.get(tc.id);
        if (matchingResult) {
          const resultBlock = matchingResult.block;
          const resultText = typeof resultBlock?.content === 'string' ? resultBlock.content : JSON.stringify(resultBlock?.content);
          toolParts.push({ type: 'tool_call_response', id: tc.id, response: resultText });
        }
      }
      if (toolParts.length > 0) {
        inputDelta = [{ role: 'tool', parts: toolParts }];
      }
    }

    // llm.request time:
    //   step 1 = user input ts (user message arrival, a reasonable proxy for LLM start)
    //   step N>1 = 上一个 step 最后一个 tool_result ts (工具返回后模型立刻开始处理)
    // 否则用 assistant 行写盘时间会导致 LLM span 退化为 0ms（thinking/tool_use 同毫秒批量 flush）
    const llmRequestTs = stepCounter === 1 ? userTs : prevStepLastToolResultTs;

    const stepRecords = buildStepEvents(group, toolResultsByUseId, stepId, turnId, sessionId, userId, providerName, version, observedTs, runtimeConfig, stepCounter === llmGroups.length, inputDelta, cwd, llmRequestTs, turnMetadata);
    records.push(...stepRecords);

    // Collect this step's tool_calls for next step's input delta
    prevToolCalls = [];
    let lastToolResultTsInStep = undefined;
    for (const row of group) {
      const msg = row.message || {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const b of content) {
        if (b.type === 'tool_use') {
          prevToolCalls.push({ id: b.id, name: b.name });
          // 找到本 step 该 tool_use 对应的 tool_result 行，记录 ts；多 tool 场景保留最后一个
          const matchingResult = toolResultsByUseId.get(b.id);
          if (matchingResult?.row.timestamp) {
            const nano = timestampToUnixNanos(matchingResult.row.timestamp);
            if (nano) lastToolResultTsInStep = nano;
          }
        }
      }
    }
    if (lastToolResultTsInStep) {
      prevStepLastToolResultTs = lastToolResultTsInStep;
    }
  }

  return records;
}

function groupByParentUuid(assistantRows) {
  const groups = [];
  const grouped = new Map();
  const order = [];

  for (const row of assistantRows) {
    // randomUUID fallback: rows without parentUuid/uuid are treated as individual LLM calls.
    // In practice QoderWork always sets parentUuid; this is a defensive fallback only.
    const parentUuid = row.parentUuid || row.uuid || crypto.randomUUID();
    if (!grouped.has(parentUuid)) {
      grouped.set(parentUuid, []);
      order.push(parentUuid);
    }
    grouped.get(parentUuid).push(row);
  }

  for (const key of order) {
    groups.push(grouped.get(key));
  }
  return groups;
}

/**
 * Group consecutive assistant rows between tool_result boundaries.
 *
 * Each group represents ONE LLM response. A tool_result row marks the
 * boundary because it delivers a tool's output back to the model — the
 * next assistant row is the start of the model's next response.
 *
 * Why not parentUuid: QoderWork occasionally emits a single LLM response
 * as multiple assistant rows with different parentUuids (e.g. a thinking
 * row + a separate tool_use row). Using parentUuid would incorrectly
 * split them into multiple "steps", and a "prev tool_result ts as
 * llm.request start" rule would then attribute the tool's execution time
 * to the second half's LLM time.
 */
function groupAssistantRowsByToolResults(turnRows) {
  const groups = [];
  let current = [];

  for (const row of turnRows) {
    if (row.type === 'assistant') {
      current.push(row);
    } else if (row.type === 'user' && isToolResult(row)) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
    }
    // Non-assistant non-tool_result user rows (the prompt) are ignored here;
    // they don't end an LLM-response group.
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildStepEvents(group, toolResultsByUseId, stepId, turnId, sessionId, userId, providerName, version, observedTs, runtimeConfig, isLastStep, inputDelta, cwd, llmRequestTs, turnMetadata = {}) {
  const records = [];
  const firstRow = group[0];
  const lastRow = group[group.length - 1];

  // thinking 行的 ts 用作 llm.response 时间（模型完成输出的真实时刻）；
  // 没有 thinking 时回退到 lastRow.timestamp（与现有行为一致）
  const thinkingRow = group.find(r => {
    const content = Array.isArray(r.message?.content) ? r.message.content : [];
    const firstType = content[0]?.type;
    return firstType === 'thinking' || r.content_type === 'thinking';
  });
  const llmResponseTs = timestampToUnixNanos(thinkingRow ? thinkingRow.timestamp : lastRow.timestamp);

  // Prefer message.id (chatcmpl-xxx, matches qoderwork-intercept.jsonl) for direct token matching.
  // Fall back to parentUuid for backward compat with older QoderWork versions.
  const responseId = firstRow.message?.id || firstRow.parentUuid || firstRow.uuid;

  // Build merged output parts
  const outputParts = [];
  const toolCalls = [];

  for (const row of group) {
    const msg = row.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    // Derive content type from message.content[0].type (raw transcript has no content_type field)
    const contentType = row.content_type || (content[0]?.type) || '';

    if (contentType === 'thinking') {
      const thinking = content.find(b => b.type === 'thinking')?.thinking
        || content.find(b => b.type === 'text')?.text
        || (typeof msg.content === 'string' ? msg.content : '');
      if (thinking) outputParts.push({ type: 'reasoning', content: thinking });
    } else if (contentType === 'text') {
      const text = content.find(b => b.type === 'text')?.text
        || (typeof msg.content === 'string' ? msg.content : '');
      if (text) outputParts.push({ type: 'text', content: text });
    } else if (contentType === 'tool_use') {
      const toolBlock = content.find(b => b.type === 'tool_use') || {};
      outputParts.push({ type: 'tool_call', id: toolBlock.id, name: toolBlock.name, arguments: toolBlock.input });
      toolCalls.push({ id: toolBlock.id, name: toolBlock.name, input: toolBlock.input });
    }
  }

  const finishReason = toolCalls.length > 0 ? 'tool_calls' : (isLastStep ? 'end_turn' : 'stop');

  // llm.request for this step.
  //
  // Field choice: gen_ai.input.messages_delta (incremental, NOT full).
  //
  // Each step's delta contains only the NEW content since the previous step:
  //   - Step 1: user prompt
  //   - Step N>1: previous step's tool_results
  // The converter (@loongsuite/otel-util-genai) accumulates deltas across
  // steps to reconstruct the full context window for each LLM span, which
  // is the correct behaviour.
  const llmRequestFields = {
    ...turnMetadata,
    'event.name': 'llm.request',
    'gen_ai.step.id': stepId,
    'gen_ai.turn.id': turnId,
    'gen_ai.session.id': sessionId,
    'gen_ai.agent.type': 'qoder-work',
    'gen_ai.provider.name': providerName,
    'gen_ai.request.model': 'auto',
    'user.id': userId,
    time_unix_nano: llmRequestTs || timestampToUnixNanos(firstRow.timestamp),
    observed_time_unix_nano: observedTs,
    version,
  };
  if (inputDelta) {
    llmRequestFields['gen_ai.input.messages_delta'] = inputDelta;
  }
  records.push(buildRecord(llmRequestFields, firstRow, runtimeConfig, cwd));

  // llm.response (merged multi-parts)
  if (outputParts.length > 0) {
    records.push(buildRecord({
      ...turnMetadata,
      'event.name': 'llm.response',
      'gen_ai.step.id': stepId,
      'gen_ai.turn.id': turnId,
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': 'qoder-work',
      'gen_ai.provider.name': providerName,
      'gen_ai.request.model': 'auto',
      'gen_ai.response.model': 'auto',
      'gen_ai.response.id': responseId,
      'gen_ai.response.finish_reasons': [finishReason],
      'user.id': userId,
      'gen_ai.output.messages': [{ role: 'assistant', parts: outputParts, finish_reason: finishReason }],
      time_unix_nano: llmResponseTs,
      observed_time_unix_nano: observedTs,
      version,
    }, firstRow, runtimeConfig, cwd));
  }

  // tool.call + tool.result events
  for (const tc of toolCalls) {
    records.push(buildRecord({
      ...turnMetadata,
      'event.name': 'tool.call',
      'gen_ai.step.id': stepId,
      'gen_ai.turn.id': turnId,
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': 'qoder-work',
      'gen_ai.tool.name': tc.name,
      'gen_ai.tool.call.id': tc.id,
      'gen_ai.tool.call.exec.id': tc.id,
      'gen_ai.tool.call.arguments': typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
      'user.id': userId,
      time_unix_nano: timestampToUnixNanos(lastRow.timestamp),
      observed_time_unix_nano: observedTs,
      version,
    }, firstRow, runtimeConfig, cwd));

    // Find matching tool_result
    const matchingResult = toolResultsByUseId.get(tc.id);
    if (matchingResult) {
      const { row: resultRow, block: resultBlock } = matchingResult;
      const resultText = typeof resultBlock?.content === 'string' ? resultBlock.content : JSON.stringify(resultBlock?.content);
      records.push(buildRecord({
        ...turnMetadata,
        'event.name': 'tool.result',
        'gen_ai.step.id': stepId,
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': 'qoder-work',
        'gen_ai.tool.name': tc.name,
        'gen_ai.tool.call.id': tc.id,
        'gen_ai.tool.call.exec.id': tc.id,
        'gen_ai.tool.call.result': resultText,
        'tool.result.status': resultBlock?.is_error ? 'failure' : 'success',
        'user.id': userId,
        time_unix_nano: timestampToUnixNanos(resultRow.timestamp),
        observed_time_unix_nano: observedTs,
        version,
      }, resultRow, runtimeConfig, cwd));
    }
  }

  return records;
}

function buildRecord(fields, sourceRow, runtimeConfig, cwd) {
  const record = {
    'event.id': crypto.randomUUID(),
    'agent.source': 'qoder-transcript-hook',
    'agent.qoderwork.variant': 'qoder-work',
    ...fields,
  };
  if (cwd) record['agent.qoderwork.cwd'] = cwd;
  if (sourceRow) {
    if (sourceRow.isSidechain !== undefined) record['agent.qoderwork.isSidechain'] = String(sourceRow.isSidechain);
    if (sourceRow.userType) record['agent.qoderwork.userType'] = sourceRow.userType;
    if (sourceRow.version) record['agent.qoderwork.version'] = sourceRow.version;
    if (sourceRow.agentId) record['agent.qoderwork.agentId'] = sourceRow.agentId;
  }
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || null;
}

function isToolResult(row) {
  const content = row.message?.content;
  return Array.isArray(content) && content.length > 0 && content[0]?.type === 'tool_result';
}

function extractText(row) {
  const msg = row.message || {};
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) parts.push(block.text);
      else if (typeof block === 'string') parts.push(block);
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Resolve QoderWork sandbox cwd to the real project directory.
 *
 * QoderWork stores the user's chosen project path in SQLite
 * (chats.additional_directories), but the hook payload only contains
 * the internal sandbox path (~/.qoderwork/workspace/<chatId>).
 * We query the DB to recover the real project path.
 */
function resolveQoderWorkProjectDir(sandboxCwd, agentId) {
  if (!sandboxCwd) return undefined;
  const qwWorkspacePrefix = path.join(os.homedir(), '.qoderwork', 'workspace') + path.sep;
  if (!sandboxCwd.startsWith(qwWorkspacePrefix)) return sandboxCwd;

  const relative = sandboxCwd.slice(qwWorkspacePrefix.length);
  const chatId = relative.split(path.sep)[0];
  if (!chatId || !/^[a-f0-9-]{1,64}$/i.test(chatId)) return sandboxCwd;

  const dbPath = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'QoderWork', 'data', 'agents.db')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'QoderWork', 'data', 'agents.db');

  try {
    const sql = `SELECT additional_directories FROM chats WHERE id = '${chatId.replace(/'/g, "''")}'`;
    const result = execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result) {
      const dirs = JSON.parse(result);
      if (Array.isArray(dirs) && dirs.length > 0 && typeof dirs[0] === 'string') {
        logDebug(agentId, `Resolved project dir: ${sandboxCwd} -> ${dirs[0]}`);
        return dirs[0];
      }
    }
  } catch (err) {
    logDebug(agentId, `Failed to resolve project dir from sqlite: ${err.message || err}`);
  }
  return sandboxCwd;
}

export { extractText, getTurnIdForRows, isSystemInjection, isToolResult, splitIntoTurns };

main().catch(() => { /* fail-open */ });
