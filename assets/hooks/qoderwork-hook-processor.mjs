#!/usr/bin/env node
/**
 * Qoder Work hook transcript processor.
 * Simple pass-through: reads transcript lines, normalizes each record
 * via buildQoderHookRecord, and appends to daily JSONL history.
 * No step assignment, no llm.request synthesis.
 */

import path from 'node:path';
import {
  parseArgs,
  parseStdinPayload,
  logDebug,
  getLineRange,
  readTranscriptLines,
  parseTranscriptLine,
  appendRowsToHistory,
  updateLineRecord,
  loadHookRuntimeConfig,
  HOOKS_DIR,
} from './shared/hook-processor-base.mjs';

async function main() {
  const { agentId, logPrefix } = parseArgs();
  const payload = await parseStdinPayload(agentId);
  if (!payload) return;

  const { transcriptPath, sessionId } = payload;
  const runtimeConfig = loadHookRuntimeConfig(path.join(HOOKS_DIR, '..'));

  const range = getLineRange(agentId, transcriptPath, sessionId);
  if (!range) return;

  const [startLine, endLine] = range;

  const lines = readTranscriptLines(transcriptPath, startLine, endLine);
  logDebug(agentId, `Read ${lines.length} lines from ${transcriptPath} (range: ${startLine}-${endLine})`);
  if (!lines.length) return;

  const records = [];
  for (const line of lines) {
    const record = parseTranscriptLine(line, agentId, runtimeConfig, undefined);
    if (record) records.push(record);
  }

  const rowsToAppend = records.map((r) => JSON.stringify(r));
  const success = appendRowsToHistory(agentId, logPrefix, rowsToAppend);
  if (success) {
    logDebug(agentId, `Successfully appended ${rowsToAppend.length} rows from ${transcriptPath}`);
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
  } else {
    logDebug(agentId, `Failed to append rows from ${transcriptPath}`);
  }
}

main().catch(() => { /* fail-open */ });
