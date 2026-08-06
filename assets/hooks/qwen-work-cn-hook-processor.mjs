#!/usr/bin/env node
/** Dedicated QwenWorkCN transcript processor. */
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

async function main() {
  const { agentId, logPrefix } = parseArgs();
  const payload = await parseStdinPayload(agentId);
  if (!payload) return;
  const range = getLineRangeInfo(agentId, payload.transcriptPath, payload.sessionId);
  if (!range) return;
  const lines = readTranscriptLines(payload.transcriptPath, range.startLine, range.endLine);
  const runtimeConfig = loadHookRuntimeConfig(path.join(HOOKS_DIR, '..'));
  const parsed = [];
  for (const line of lines) {
    let source;
    try { source = JSON.parse(line); } catch { continue; }
    parsed.push(source);
  }
  const selected = range.reason === 'incremental' ? parsed : latestTurn(parsed);
  const rows = selected.flatMap(source =>
    mapTranscriptRow(source, payload.sessionId, runtimeConfig, payload.cwd));
  const serialized = rows.filter(Boolean).map(row => JSON.stringify(row));
  if (appendRowsToHistory(agentId, logPrefix, serialized)) {
    updateLineRecord(agentId, payload.transcriptPath, payload.sessionId, range.endLine);
    logDebug(agentId, `Mapped ${serialized.length} QwenWorkCN event(s)`);
  }
}

function latestTurn(rows) {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    const blocks = Array.isArray(row?.message?.content) ? row.message.content : [];
    const startsUserTurn = row?.type === 'user' && blocks.some(block => block?.type === 'text');
    if (startsUserTurn) return rows.slice(index);
  }
  return rows;
}

function mapTranscriptRow(row, fallbackSessionId, runtimeConfig = {}, fallbackCwd) {
  if (!row || (row.type !== 'user' && row.type !== 'assistant')) return [];
  if (row.isSidechain === true || row.isSidechain === 'true' || row.isMeta === true || row.isMeta === 'true') return [];
  const content = row.message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const sessionId = stringValue(row.sessionId) || stringValue(row.session_id) || fallbackSessionId || '';
  const model = stringValue(row.message?.model) || 'unknown';
  const provider = inferProviderName({ model, 'gen_ai.agent.type': 'qwen-work-cn' });
  const userId = resolveUserId(row, runtimeConfig);
  const cwd = stringValue(row.cwd) || fallbackCwd;
  const output = [];

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block || typeof block !== 'object') continue;
    const blockType = stringValue(block.type);
    let fields;
    if (blockType === 'tool_use') {
      fields = {
        'event.name': 'tool.call',
        'gen_ai.tool.name': stringValue(block.name),
        'gen_ai.tool.call.id': stringValue(block.id),
        'gen_ai.tool.call.exec.id': stringValue(block.id),
        'gen_ai.tool.call.arguments': toJsonValue(block.input),
      };
    } else if (blockType === 'tool_result') {
      fields = {
        'event.name': 'tool.result',
        'gen_ai.tool.call.id': stringValue(block.tool_use_id),
        'gen_ai.tool.call.exec.id': stringValue(block.tool_use_id),
        'gen_ai.tool.call.result': toJsonValue(row.toolUseResult ?? block.content),
        'tool.result.status': block.is_error ? 'failure' : 'success',
      };
    } else if (row.type === 'user' && blockType === 'text') {
      fields = {
        'event.name': 'llm.request',
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: stringValue(block.text) }] }],
      };
    } else if (row.type === 'assistant' && (blockType === 'text' || blockType === 'thinking')) {
      const partType = blockType === 'thinking' ? 'reasoning' : 'text';
      const text = stringValue(block.text) || stringValue(block.thinking);
      fields = {
        'event.name': 'llm.response',
        'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: partType, content: text }] }],
        'gen_ai.response.finish_reasons': row.message?.stop_reason ? [row.message.stop_reason] : undefined,
        'gen_ai.response.id': stringValue(row.message?.id) || undefined,
      };
    } else {
      continue;
    }

    const eventName = fields['event.name'];
    const sourceId = stringValue(row.uuid) || stringValue(row.promptId) || `${row.timestamp ?? ''}:${index}`;
    const record = sanitizeObject(applyHookContentPolicy({
      'event.id': crypto.createHash('sha256').update(`${sessionId}\0${sourceId}\0${eventName}\0${index}`).digest('hex'),
      ...fields,
      'user.id': userId,
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': 'qwen-work-cn',
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'workspace.current_root': cwd,
      'agent.source': 'qwen-work-cn-transcript-hook',
      'agent.qwenworkcn.cwd': cwd,
      'agent.qwenworkcn.raw_type': row.type,
      'agent.qwenworkcn.content_type': blockType,
      time_unix_nano: timestampToUnixNanos(row.timestamp ?? Date.now()),
      observed_time_unix_nano: timestampToUnixNanos(Date.now()),
      version: stringValue(row.version),
    }, runtimeConfig));
    if (record) output.push(record);
  }
  return output;
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function toJsonValue(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

export { latestTurn, mapTranscriptRow };

if (process.env.NODE_ENV !== 'test') {
  main().catch(() => { /* hook must fail open */ });
}
