#!/usr/bin/env node
/**
 * Dedicated QwenWorkCN transcript processor.
 *
 * QwenWorkCN uses the same transcript protocol as QoderWork. Keep this file
 * independent, but preserve the same semantic algorithm: split user turns,
 * split LLM steps at tool-result boundaries, merge assistant fragments, and
 * attach stable turn/step identifiers to every event in the graph.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import {
  appendRowsToHistory,
  getLineRangeInfo,
  HOOKS_DIR,
  loadHookRuntimeConfig,
  logDebug,
  parseArgs,
  parseStdinPayload,
  readTranscriptLines,
  updateLineRecord,
} from './shared/hook-processor-base.mjs';
import {
  applyHookContentPolicy,
  inferProviderName,
  resolveUserId,
  sanitizeObject,
  timestampToUnixNanos,
} from './agent-event-normalizer.mjs';

const REVIEW_COPY_PREFIX = '[SYSTEM: This is an automated background review task';

async function main() {
  const { agentId, logPrefix } = parseArgs();
  const payload = await parseStdinPayload(agentId);
  if (!payload) return;

  const range = getLineRangeInfo(agentId, payload.transcriptPath, payload.sessionId);
  if (!range) return;
  const lines = readTranscriptLines(payload.transcriptPath, range.startLine, range.endLine);
  if (!lines.length) {
    updateLineRecord(agentId, payload.transcriptPath, payload.sessionId, range.endLine);
    return;
  }

  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* skip malformed transcript rows */ }
  }
  const runtimeConfig = loadHookRuntimeConfig(path.join(HOOKS_DIR, '..'));
  const rows = processTranscript(parsed, payload.sessionId, runtimeConfig, payload.cwd, {
    rangeReason: range.reason,
  });
  const serialized = rows.filter(Boolean).map(row => JSON.stringify(row));
  if (appendRowsToHistory(agentId, logPrefix, serialized)) {
    updateLineRecord(agentId, payload.transcriptPath, payload.sessionId, range.endLine);
    logDebug(agentId, `Mapped ${serialized.length} QwenWorkCN event(s)`);
  }
}

function processTranscript(parsed, fallbackSessionId, runtimeConfig = {}, fallbackCwd, opts = {}) {
  // QwenWorkCN, like QoderWork, forks a copy of the original transcript and
  // appends an automated review task. The original session has already been
  // collected, so consuming the copy would duplicate every preceding turn.
  const isReviewCopy = parsed.some(row => (
    row?.type === 'user'
    && blocksOf(row).some(block =>
      block?.type === 'text'
      && typeof block.text === 'string'
      && block.text.trimStart().startsWith(REVIEW_COPY_PREFIX))
  ));
  if (isReviewCopy) {
    logDebug('qwen-work-cn', `Skipping review-copy session ${fallbackSessionId || ''}`);
    return [];
  }

  const contentRows = parsed.filter(row => {
    if (!row || (row.type !== 'user' && row.type !== 'assistant')) return false;
    if (row.isSidechain === true || row.isSidechain === 'true') return false;
    if (row.isMeta === true || row.isMeta === 'true') return false;
    return true;
  });
  if (!contentRows.length) return [];

  const allTurns = splitIntoTurns(contentRows);
  const rangeReason = opts.rangeReason || 'incremental';
  const isBootstrap = rangeReason !== 'incremental';
  const turns = isBootstrap ? allTurns.slice(-1) : allTurns;
  const observedTs = timestampToUnixNanos(Date.now());
  const records = [];

  for (const turnRows of turns) {
    const promptRow = turnRows.find(isPromptRow);
    if (!promptRow) continue;
    const sessionId = stringValue(promptRow.sessionId)
      || stringValue(promptRow.session_id)
      || fallbackSessionId
      || '';
    const turnId = stringValue(promptRow.promptId)
      || stringValue(promptRow.uuid)
      || stableId([sessionId, promptRow.timestamp, 'turn']);
    records.push(...buildTurnEvents(
      turnRows,
      turnId,
      sessionId,
      resolveUserId(promptRow, runtimeConfig),
      observedTs,
      runtimeConfig,
      stringValue(promptRow.cwd) || fallbackCwd,
    ));
  }

  const cursorMode = isBootstrap ? 'bootstrap' : 'incremental';
  const cursorBatchId = crypto.randomUUID();
  for (const record of records) {
    record['agent.transcript.cursor_mode'] = cursorMode;
    record['agent.transcript.cursor_reason'] = rangeReason;
    record['agent.transcript.cursor_batch_id'] = cursorBatchId;
  }
  return records;
}

function splitIntoTurns(rows) {
  const turns = [];
  let current = [];
  for (const row of rows) {
    if (isPromptRow(row)) {
      if (current.length > 0) turns.push(current);
      current = [row];
    } else {
      current.push(row);
    }
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function isPromptRow(row) {
  return row?.type === 'user' && !isToolResult(row) && !isSystemInjection(row);
}

function isToolResult(row) {
  const blocks = blocksOf(row);
  return row?.type === 'user' && blocks.some(block => block?.type === 'tool_result');
}

function isSystemInjection(row) {
  const text = extractText(row).trimStart();
  if (text.startsWith('<command-message>')
    || text.startsWith('<command-name>')
    || text.startsWith('[Request interrupted')
    || text.startsWith('[SYSTEM: This is an automated background review task')) return true;
  return text.startsWith('<system-reminder>')
    && text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim().length === 0;
}

function buildTurnEvents(turnRows, turnId, sessionId, userId, observedTs, runtimeConfig, cwd) {
  const records = [];
  const promptRow = turnRows.find(isPromptRow);
  const promptText = extractText(promptRow);
  const promptTs = timestampToUnixNanos(promptRow.timestamp);
  const version = stringValue(promptRow.version);
  const turnMetadata = { 'agent.qwenworkcn.promptId': stringValue(promptRow.promptId) || turnId };

  if (promptText) {
    records.push(buildRecord({
      ...turnMetadata,
      'event.name': 'other',
      'gen_ai.turn.id': turnId,
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': 'qwen-work-cn',
      'gen_ai.provider.name': inferProviderName({ 'gen_ai.agent.type': 'qwen-work-cn' }),
      'user.id': userId,
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: promptText }] }],
      time_unix_nano: promptTs,
      observed_time_unix_nano: observedTs,
      version,
    }, promptRow, runtimeConfig, cwd, `${turnId}:other`));
  }

  const toolResults = indexToolResults(turnRows);
  const groups = groupAssistantRowsByToolResults(turnRows);
  let previousToolCalls = [];
  let previousToolResultTs;

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const stepId = `${turnId}:s${index + 1}`;
    let inputDelta;
    if (index === 0 && promptText) {
      inputDelta = [{ role: 'user', parts: [{ type: 'text', content: promptText }] }];
    } else if (previousToolCalls.length > 0) {
      const parts = previousToolCalls.flatMap(call => {
        const match = toolResults.get(call.id);
        if (!match) return [];
        return [{ type: 'tool_call_response', id: call.id, response: resultValue(match) }];
      });
      if (parts.length > 0) {
        inputDelta = [
          {
            role: 'assistant',
            parts: previousToolCalls.map(call => ({
              type: 'tool_call',
              id: call.id,
              name: call.name,
              arguments: toJsonValue(call.input),
            })),
          },
          { role: 'tool', parts },
        ];
      }
    }

    const result = buildStepEvents({
      group,
      toolResults,
      stepId,
      turnId,
      sessionId,
      userId,
      observedTs,
      runtimeConfig,
      cwd,
      version,
      inputDelta,
      requestTs: index === 0 ? promptTs : previousToolResultTs,
      isLastStep: index === groups.length - 1,
      turnMetadata,
    });
    records.push(...result.records);
    previousToolCalls = result.toolCalls;
    previousToolResultTs = result.lastToolResultTs || previousToolResultTs;
  }
  return records;
}

function groupAssistantRowsByToolResults(rows) {
  const groups = [];
  let current = [];
  for (const row of rows) {
    if (row.type === 'assistant') {
      current.push(row);
    } else if (isToolResult(row) && current.length > 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function indexToolResults(rows) {
  const results = new Map();
  for (const row of rows) {
    if (!isToolResult(row)) continue;
    for (const block of blocksOf(row)) {
      if (block?.type === 'tool_result' && block.tool_use_id && !results.has(block.tool_use_id)) {
        results.set(block.tool_use_id, { row, block });
      }
    }
  }
  return results;
}

function buildStepEvents(opts) {
  const {
    group, toolResults, stepId, turnId, sessionId, userId, observedTs,
    runtimeConfig, cwd, version, inputDelta, requestTs, isLastStep, turnMetadata,
  } = opts;
  const firstRow = group[0];
  const lastRow = group[group.length - 1];
  const model = group.map(row => stringValue(row.message?.model)).find(Boolean) || 'unknown';
  const provider = inferProviderName({ model, 'gen_ai.agent.type': 'qwen-work-cn' });
  const outputParts = [];
  const toolCalls = [];

  for (const row of group) {
    for (const block of blocksOf(row)) {
      if (block?.type === 'thinking') {
        const content = stringValue(block.thinking) || stringValue(block.text);
        if (content) outputParts.push({ type: 'reasoning', content });
      } else if (block?.type === 'text') {
        const content = stringValue(block.text);
        if (content) outputParts.push({ type: 'text', content });
      } else if (block?.type === 'tool_use') {
        outputParts.push({ type: 'tool_call', id: block.id, name: block.name, arguments: toJsonValue(block.input) });
        toolCalls.push({ id: stringValue(block.id), name: stringValue(block.name), input: block.input, row });
      }
    }
  }

  const finishReason = toolCalls.length > 0 ? 'tool_calls' : (isLastStep ? 'end_turn' : 'stop');
  const responseRow = group.find(row => blocksOf(row).some(block => block?.type === 'thinking')) || lastRow;
  const responseId = group.map(row => stringValue(row.message?.id)).find(Boolean)
    || stringValue(firstRow.parentUuid)
    || stringValue(firstRow.uuid);
  const common = {
    ...turnMetadata,
    'gen_ai.step.id': stepId,
    'gen_ai.turn.id': turnId,
    'gen_ai.session.id': sessionId,
    'gen_ai.agent.type': 'qwen-work-cn',
    'gen_ai.provider.name': provider,
    'user.id': userId,
    version,
  };
  const records = [];

  records.push(buildRecord({
    ...common,
    'event.name': 'llm.request',
    'gen_ai.request.id': responseId ? `${responseId}:request` : `${stepId}:request`,
    'gen_ai.request.model': model,
    'gen_ai.input.messages_delta': inputDelta,
    time_unix_nano: requestTs || timestampToUnixNanos(firstRow.timestamp),
    observed_time_unix_nano: observedTs,
  }, firstRow, runtimeConfig, cwd, `${stepId}:request`));

  if (outputParts.length > 0) {
    records.push(buildRecord({
      ...common,
      'event.name': 'llm.response',
      'gen_ai.request.id': responseId ? `${responseId}:request` : `${stepId}:request`,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.response.id': responseId || undefined,
      'gen_ai.response.finish_reasons': [finishReason],
      'gen_ai.output.messages': [{ role: 'assistant', parts: outputParts, finish_reason: finishReason }],
      time_unix_nano: timestampToUnixNanos(responseRow.timestamp),
      observed_time_unix_nano: observedTs,
    }, firstRow, runtimeConfig, cwd, `${stepId}:response`));
  }

  let lastToolResultTs;
  for (const call of toolCalls) {
    records.push(buildRecord({
      ...common,
      'event.name': 'tool.call',
      'gen_ai.tool.name': call.name,
      'gen_ai.tool.call.id': call.id,
      'gen_ai.tool.call.exec.id': call.id,
      'gen_ai.tool.call.arguments': toJsonValue(call.input),
      time_unix_nano: timestampToUnixNanos(call.row.timestamp),
      observed_time_unix_nano: observedTs,
    }, call.row, runtimeConfig, cwd, `${stepId}:tool.call:${call.id}`));

    const match = toolResults.get(call.id);
    if (!match) continue;
    lastToolResultTs = timestampToUnixNanos(match.row.timestamp);
    records.push(buildRecord({
      ...common,
      'event.name': 'tool.result',
      'gen_ai.tool.name': call.name,
      'gen_ai.tool.call.id': call.id,
      'gen_ai.tool.call.exec.id': call.id,
      'gen_ai.tool.call.result': resultValue(match),
      'tool.result.status': match.block.is_error ? 'failure' : 'success',
      time_unix_nano: lastToolResultTs,
      observed_time_unix_nano: observedTs,
    }, match.row, runtimeConfig, cwd, `${stepId}:tool.result:${call.id}`));
  }

  return { records, toolCalls, lastToolResultTs };
}

function buildRecord(fields, sourceRow, runtimeConfig, cwd, eventKey) {
  const record = {
    'event.id': stableId([fields['gen_ai.session.id'], eventKey]),
    'agent.source': 'qwen-work-cn-transcript-hook',
    ...fields,
  };
  if (cwd) record['agent.qwenworkcn.cwd'] = cwd;
  if (sourceRow?.type) record['agent.qwenworkcn.raw_type'] = sourceRow.type;
  if (sourceRow?.version) record['agent.qwenworkcn.version'] = sourceRow.version;
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || null;
}

function blocksOf(row) {
  const content = row?.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function extractText(row) {
  return blocksOf(row)
    .flatMap(block => block?.type === 'text' && stringValue(block.text) ? [block.text] : [])
    .join('\n');
}

function resultValue(match) {
  return toJsonValue(match.row.toolUseResult ?? match.block.content);
}

function stableId(parts) {
  return crypto.createHash('sha256').update(parts.map(part => String(part ?? '')).join('\0')).digest('hex');
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function toJsonValue(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

export {
  extractText,
  groupAssistantRowsByToolResults,
  isPromptRow,
  isToolResult,
  processTranscript,
  splitIntoTurns,
};

if (process.env.NODE_ENV !== 'test') {
  main().catch(() => { /* hook must fail open */ });
}
