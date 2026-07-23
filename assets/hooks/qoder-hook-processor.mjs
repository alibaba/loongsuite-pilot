#!/usr/bin/env node
/**
 * Qoder / Qoder-CLI hook transcript processor.
 *
 * Parses the full transcript (including progress events) to determine
 * precise LLM call boundaries, merges thinking+text+tool_use into
 * unified multi-part responses, and uses progress timestamps for
 * accurate LLM span timing.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  parseArgs,
  parseStdinPayload,
  logDebug,
  getLineRangeInfo,
  getTranscriptLineCount,
  readTranscriptLines,
  appendRowsToHistory,
  updateLineRecord,
  loadHookRuntimeConfig,
  getErrorLogFile,
  HOOKS_DIR,
  LOONGSUITE_PILOT_LOGS_BASE_DIR,
} from './shared/hook-processor-base.mjs';
import {
  buildQoderHookRecord,
  inferProviderName,
} from './agent-event-normalizer.mjs';
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
  parseSpanAttributesFromEnv,
} from './shared/resource-context.mjs';
import { recordUpstreamContextOnce } from './shared/upstream-context.mjs';

const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: 'qoder' });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};
// Caller-supplied span attributes (e.g. multica.*) stamped as top-level record
// fields so the trace flusher can pass matching keys through to span attributes.
const SPAN_ATTRIBUTES = parseSpanAttributesFromEnv(process.env, { agentId: 'qoder' });

// --- Retry lockfile (qoder-cn only) -----------------------------------------
// QoderCN fires Stop hook multiple times per turn AND incomplete transcript
// causes background retries — without coordination these can stack up and
// produce duplicate records. We guard at two points:
//   1. parent process: skip spawn if a live lock exists
//   2. retry subprocess: refuse to enter processTranscript if a peer holds it
// The lock file lives at <HOOKS_DIR>/.retry-locks/<sha1>.lock and contains
// JSON `{ pid, sessionId, startedAt }`.

export const RETRY_LOCK_DIR = path.join(HOOKS_DIR, '.retry-locks');
export const RETRY_LOCK_MAX_AGE_MS = 60_000;

export function retryLockPath(transcriptPath, dir = RETRY_LOCK_DIR) {
  const hash = crypto.createHash('sha1').update(transcriptPath).digest('hex');
  return path.join(dir, `${hash}.lock`);
}

export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

export function readRetryLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through */ }
  return null;
}

export function isRetryLockStale(lock) {
  if (!lock) return true;
  const age = Date.now() - (Number(lock.startedAt) || 0);
  if (age > RETRY_LOCK_MAX_AGE_MS) return true;
  return !pidAlive(lock.pid);
}

export function tryAcquireRetryLock(transcriptPath, sessionId, dir = RETRY_LOCK_DIR) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = retryLockPath(transcriptPath, dir);
    const payload = JSON.stringify({ pid: process.pid, sessionId, startedAt: Date.now() });
    try {
      const handle = fs.openSync(lockPath, 'wx');
      fs.writeSync(handle, payload);
      fs.closeSync(handle);
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        const existing = readRetryLock(lockPath);
        if (isRetryLockStale(existing)) {
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
          try {
            const handle = fs.openSync(lockPath, 'wx');
            fs.writeSync(handle, payload);
            fs.closeSync(handle);
            return true;
          } catch { return false; }
        }
        return false;
      }
      return false;
    }
  } catch {
    return false;
  }
}

export function releaseRetryLock(transcriptPath, dir = RETRY_LOCK_DIR) {
  try {
    const lockPath = retryLockPath(transcriptPath, dir);
    const existing = readRetryLock(lockPath);
    // Only release if we own the lock (avoid wiping a peer's lock on crash recovery)
    if (existing && existing.pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch { /* best-effort */ }
}

// --- Timestamp helpers -------------------------------------------------------

function isoToUnixNanos(isoString) {
  if (!isoString) return '';
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) return '';
  return String(BigInt(ms) * 1_000_000n);
}

function timestampToUnixNanos(value) {
  if (!value) return String(BigInt(Date.now()) * 1_000_000n);
  if (typeof value === 'number') return String(BigInt(Math.round(value)) * 1_000_000n);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return String(BigInt(ms) * 1_000_000n);
    if (/^\d+$/.test(value)) return value;
  }
  return String(BigInt(Date.now()) * 1_000_000n);
}

function computeDurationMs(startNanos, endNanos) {
  if (!startNanos || !endNanos || startNanos === endNanos) return 0;
  try {
    const diffNs = BigInt(endNanos) - BigInt(startNanos);
    if (diffNs <= 0n) return 0;
    return Number(diffNs / 1_000_000n);
  } catch {
    return 0;
  }
}

// --- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const isRetry = args.includes('--retry');

  // Retry mode: called by background subprocess after delay, reads transcript directly
  if (isRetry) {
    const transcriptIdx = args.indexOf('--transcript');
    const sessionIdx = args.indexOf('--session');
    const cwdIdx = args.indexOf('--cwd');
    const transcriptPath = transcriptIdx >= 0 ? args[transcriptIdx + 1] : '';
    const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : '';
    const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : undefined;
    const { agentId, logPrefix } = parseArgs();
    if (!transcriptPath || !sessionId) return;
    logDebug(agentId, `Retry: processing ${transcriptPath} for session ${sessionId}`);
    const runtimeConfig = loadHookRuntimeConfig(path.join(HOOKS_DIR, '..'));

    // qoder-cn only: serialize concurrent retries on the same transcript.
    // We wait the HOOK_RETRY_DELAY first (so all queued Stop hooks have
    // already advanced the offset via updateLineRecord), then acquire the
    // lock. The losers see currentCount==lastCount in getLineRangeInfo and exit.
    const retryDelay = parseInt(process.env.HOOK_RETRY_DELAY || '0', 10);
    if (retryDelay > 0) {
      await new Promise(r => setTimeout(r, retryDelay));
    }

    if (agentId === 'qoder-cn') {
      if (!tryAcquireRetryLock(transcriptPath, sessionId)) {
        logDebug(agentId, `Retry skipped: lock held by peer for ${transcriptPath}`);
        return;
      }
    }
    try {
      const range = getLineRangeInfo(agentId, transcriptPath, sessionId);
      if (!range) return;
      await processTranscript(
        agentId, logPrefix, transcriptPath, sessionId,
        range.startLine, range.endLine, runtimeConfig, cwd,
        { delayApplied: true, rangeReason: range.reason },
      );
    } finally {
      if (agentId === 'qoder-cn') releaseRetryLock(transcriptPath);
    }
    return;
  }

  // Normal mode: called from Stop hook via stdin
  const { agentId, logPrefix } = parseArgs();
  const payload = await parseStdinPayload(agentId);
  if (!payload) return;

  const { transcriptPath, sessionId, cwd } = payload;

  // 方案1(env):首个 turn 读 TRACEPARENT 写 session 级关联记录(fail-open, 每 session 一次)
  if (sessionId) {
    recordUpstreamContextOnce({ agentId, sessionId, dataDir: path.dirname(LOONGSUITE_PILOT_LOGS_BASE_DIR) });
  }

  const runtimeConfig = loadHookRuntimeConfig(path.join(HOOKS_DIR, '..'));

  const range = getLineRangeInfo(agentId, transcriptPath, sessionId);
  if (!range) return;

  const startLine = range.startLine;
  const endLine = range.endLine;
  const lines = readTranscriptLines(transcriptPath, startLine, endLine);
  logDebug(agentId, `Read ${lines.length} lines (range: ${startLine}-${endLine})`);
  if (!lines.length) {
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    return;
  }

  // Detect incomplete transcript (race condition in print/non-interactive mode:
  // Stop hook fires BEFORE transcript is fully written, and writes happen AFTER hook returns).
  // Solution: spawn a background retry that runs after 5s delay.
  let parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* skip */ }
  }

  // last-prompt is the authoritative end-of-transcript marker written by qodercli on exit.
  // If absent, the file is still being flushed (race: Stop hook fires before transcript flush).
  const hasLastPrompt = parsed.some(p => p.type === 'last-prompt');
  if (parsed.length > 0 && !hasLastPrompt) {
    logDebug(agentId, `Transcript incomplete (${parsed.length} lines, no last-prompt marker). Spawning background retry in 5s.`);
    if (agentId === 'qoder-cn') {
      // qoder-cn: QoderCN fires Stop multiple times per turn. The retry's
      // child-side lock serializes actual processing, but skipping needless
      // spawn calls here keeps process churn down.
      const lockPath = retryLockPath(transcriptPath);
      const existing = readRetryLock(lockPath);
      if (existing && !isRetryLockStale(existing)) {
        logDebug(agentId, `Skip spawn: live retry lock held by pid ${existing.pid}`);
      } else {
        if (existing) { try { fs.unlinkSync(lockPath); } catch { /* ignore */ } }
        spawnDelayedRetry(agentId, transcriptPath, sessionId, logPrefix, cwd);
      }
    } else {
      spawnDelayedRetry(agentId, transcriptPath, sessionId, logPrefix, cwd);
    }
    return;
  }

  if (agentId === 'qoder-cn') {
    if (!tryAcquireRetryLock(transcriptPath, sessionId)) {
      logDebug(agentId, `Stop skipped: peer retry/handler holds lock for ${transcriptPath}`);
      return;
    }
    try {
      await processTranscript(
        agentId, logPrefix, transcriptPath, sessionId, startLine, endLine,
        runtimeConfig, cwd, { rangeReason: range.reason },
      );
    } finally {
      releaseRetryLock(transcriptPath);
    }
    return;
  }

  await processTranscript(
    agentId, logPrefix, transcriptPath, sessionId, startLine, endLine,
    runtimeConfig, cwd, { rangeReason: range.reason },
  );
}

// NOTE: Retry subprocess won't race with normal hook because non-interactive mode (--print)
// only fires Stop once per session (process exits after hook returns). The offset check in
// getLineRangeInfo prevents double-processing if another hook invocation somehow occurs.
function spawnDelayedRetry(agentId, transcriptPath, sessionId, logPrefix, cwd) {
  const nodebin = process.argv[0];
  const script = fileURLToPath(import.meta.url);
  const spawnArgs = [
    script,
    '--agent-id', agentId,
    '--log-prefix', logPrefix,
    '--retry',
    '--transcript', transcriptPath,
    '--session', sessionId,
    ...(cwd ? ['--cwd', cwd] : []),
  ];
  const child = spawn(nodebin, spawnArgs, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HOOK_RETRY_DELAY: '5000' },
  });
  child.unref();
  logDebug(agentId, `Spawned retry subprocess (PID ${child.pid})`);
}

async function processTranscript(agentId, logPrefix, transcriptPath, sessionId, startLine, initialEndLine, runtimeConfig, cwd, opts) {
  // Handle retry delay
  const delayApplied = !!(opts && opts.delayApplied);
  if (!delayApplied) {
    const retryDelay = parseInt(process.env.HOOK_RETRY_DELAY || '0', 10);
    if (retryDelay > 0) {
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  // Re-read transcript (may have grown since initial read)
  let endLine = initialEndLine;
  const currentCount = getTranscriptLineCount(transcriptPath);
  if (currentCount > endLine) {
    endLine = currentCount;
  }

  let lines = readTranscriptLines(transcriptPath, startLine, endLine);
  logDebug(agentId, `Processing ${lines.length} lines (range: ${startLine}-${endLine})`);
  if (!lines.length) {
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    return;
  }

  // --- Phase 1: Parse all transcript lines ---
  let parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* skip */ }
  }

  // --- Phase 2: Extract progress timing + content events ---
  const progressEvents = [];
  const contentEvents = [];

  let lastProgressHookEvent = '';
  for (const row of parsed) {
    const rowType = row.type;
    if (rowType === 'progress') {
      const data = row.data || {};
      const hookEvent = data.hookEvent || '';
      // Deduplicate: each hookEvent fires multiple progress lines (one per registered command).
      // Only take the first of each consecutive same-hookEvent group.
      if (hookEvent && hookEvent !== lastProgressHookEvent) {
        progressEvents.push({ hookEvent, ts: row.timestamp, hookName: data.hookName || '' });
      }
      if (hookEvent) lastProgressHookEvent = hookEvent;
    } else if (rowType === 'user' || rowType === 'assistant') {
      contentEvents.push(row);
    }
    // session_meta, other types: ignored
  }

  // --- Phase 2.5 (qoder-cn only): Skip processing if transcript hasn't reached Stop ---
  // For qoder-cn, only process the transcript when the Stop progress event has been
  // written. A PostToolUse retry (which runs before Stop is written) would see an
  // incomplete ReAct chain and produce partial events. The Stop retry (fired after
  // the final assistant text is written) sees the complete chain and can correctly
  // generate all llm.request events with proper input.messages_delta (including
  // tool_result as input delta for step 2).
  if (agentId === 'qoder-cn') {
    const hasStop = progressEvents.some(pe => pe.hookEvent === 'Stop');
    if (!hasStop) {
      logDebug(agentId, `Transcript not yet complete (no Stop event in progress). Skipping processing.`);
      return;
    }
    // Stop detected — reprocess the entire transcript from the beginning so
    // splitContentEventsIntoTurns sees the complete ReAct chain (user →
    // assistant(text+tool_use) → user(tool_result) → assistant(text)) and
    // generates one turn with all LLM calls and correct input.messages_delta.
    startLine = 0;
    lines = readTranscriptLines(transcriptPath, startLine, endLine);
    logDebug(agentId, `Reprocessing full transcript from 0-${endLine} (${lines.length} lines)`);
    // Re-parse since we reset startLine
    parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch { /* skip */ }
    }
    // Re-extract progress + content events from the full transcript
    progressEvents.length = 0;
    contentEvents.length = 0;
    lastProgressHookEvent = '';
    for (const row of parsed) {
      const rowType = row.type;
      if (rowType === 'progress') {
        const data = row.data || {};
        const hookEvent = data.hookEvent || '';
        if (hookEvent && hookEvent !== lastProgressHookEvent) {
          progressEvents.push({ hookEvent, ts: row.timestamp, hookName: data.hookName || '' });
        }
        if (hookEvent) lastProgressHookEvent = hookEvent;
      } else if (rowType === 'user' || rowType === 'assistant') {
        contentEvents.push(row);
      }
    }
  }

  // --- Phase 3: Split content events into turns by real user prompts ---
  // Each real user prompt starts a new turn. Tool results stay attached to the
  // preceding turn. This ensures each turn gets its own user input instead of
  // inheriting the first prompt of the whole transcript segment.
  const allTurnSegments = splitContentEventsIntoTurns(contentEvents);
  const rangeReason = opts?.rangeReason || 'incremental';
  // Cursor recovery always reads the full transcript to re-establish a safe
  // checkpoint, but only the latest logical turn is new. QoderCN also rebuilds
  // from line 0 on every completed Stop so its full ReAct chain is available;
  // it must therefore emit only the latest logical turn even with a valid
  // incremental cursor.
  const turnSegments = selectTurnSegmentsForCollection(allTurnSegments, rangeReason, agentId);
  const keepLatestTurnOnly = turnSegments.length < allTurnSegments.length;
  if (keepLatestTurnOnly && allTurnSegments.length > turnSegments.length) {
    const recoverySource = agentId === 'qoder-cn' && rangeReason === 'incremental'
      ? 'QoderCN full reparse'
      : `cursor recovery (${rangeReason})`;
    logDebug(agentId, `${recoverySource}: skipped ${allTurnSegments.length - turnSegments.length} historical turn(s), kept latest turn`);
  }
  logDebug(agentId, `Split transcript segment into ${turnSegments.length} turn(s)`);

  // --- Phase 4: Build events per turn ---
  const records = [];
  for (let turnIdx = 0; turnIdx < turnSegments.length; turnIdx++) {
    const turnContentEvents = turnSegments[turnIdx];
    const turnId = crypto.randomUUID();

    // Determine LLM call boundaries within this turn.
    const llmBoundaries = buildLlmBoundaries(progressEvents, turnContentEvents);
    logDebug(agentId, `Turn ${turnIdx + 1}: detected ${llmBoundaries.length} LLM call(s)`);

    const turnRecords = buildEventsFromBoundaries(
      llmBoundaries, turnContentEvents, parsed, turnId, sessionId, agentId, runtimeConfig, cwd,
    );
    records.push(...turnRecords);

    logDebug(agentId, `Turn ${turnIdx + 1}: produced ${turnRecords.length} events, turn_id=${turnId}`);
  }

  const cursorMode = rangeReason === 'incremental' ? 'incremental' : 'bootstrap';
  const cursorBatchId = crypto.randomUUID();
  for (const record of records) {
    record['agent.transcript.cursor_mode'] = cursorMode;
    record['agent.transcript.cursor_reason'] = rangeReason;
    record['agent.transcript.cursor_batch_id'] = cursorBatchId;
  }

  // --- Phase 5: Write to history ---
  const rowsToAppend = records.map(r => JSON.stringify(r));
  const success = appendRowsToHistory(agentId, logPrefix, rowsToAppend);
  if (success) {
    logDebug(agentId, `Appended ${rowsToAppend.length} rows`);
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
  }
}

export function selectTurnSegmentsForCollection(turnSegments, rangeReason, agentId) {
  // QoderCN intentionally reparses the complete transcript on every Stop to
  // rebuild its ReAct chain. Other variants only do that during cursor
  // recovery. In both cases, only the latest logical turn may be emitted.
  if (rangeReason !== 'incremental' || agentId === 'qoder-cn') {
    return turnSegments.slice(-1);
  }
  return turnSegments;
}

// --- LLM Boundary Detection --------------------------------------------------

function buildLlmBoundaries(progressEvents, contentEvents) {
  // Step 1: Group assistant blocks into LLM calls.
  // Priority: use message.id (CLI variant has it) > progress window (IDE variant)
  // > fallback to timestamp proximity when progress events are absent.
  const assistantGroups = [];
  let currentGroup = [];
  let lastTs = null;
  let currentKey = null;
  const hasProgressWindows = progressEvents.some(pe =>
    pe.hookEvent === 'UserPromptSubmit' || pe.hookEvent === 'PostToolUse' ||
    pe.hookEvent === 'PreToolUse' || pe.hookEvent === 'Stop'
  );

  function flushGroup() {
    if (currentGroup.length > 0) assistantGroups.push(currentGroup);
    currentGroup = [];
    lastTs = null;
    currentKey = null;
  }

  for (const row of contentEvents) {
    if (row.type !== 'assistant') {
      flushGroup();
      continue;
    }
    const ts = row.timestamp ? Date.parse(row.timestamp) : 0;
    if (!ts) continue;

    const messageId = row.message?.id || null;
    const key = messageId
      ? `message:${messageId}`
      : hasProgressWindows
        ? progressWindowKey(progressEvents, ts)
        : null;

    // Determine if this row starts a new LLM call
    let isNewCall = false;
    if (currentGroup.length > 0 && key && currentKey) {
      isNewCall = key !== currentKey;
    } else if (currentGroup.length > 0 && !key && !currentKey) {
      isNewCall = lastTs !== null && (ts - lastTs) > 200;
    } else if (currentGroup.length > 0 && key !== currentKey) {
      // Mixed keyed/unkeyed rows are unusual; keep the old time-gap fallback.
      isNewCall = lastTs !== null && (ts - lastTs) > 200;
    }

    if (isNewCall) flushGroup();

    currentGroup.push(row);
    currentKey = key;
    lastTs = ts;
  }
  flushGroup();

  // Step 2: For each assistant group (= one LLM call), find timing from progress
  const boundaries = [];
  for (let i = 0; i < assistantGroups.length; i++) {
    const group = assistantGroups[i];
    const groupStartMs = Date.parse(group[0].timestamp) || 0;
    const groupEndMs = Date.parse(group[group.length - 1].timestamp) || groupStartMs;

    // Find start time: last PostToolUse or UserPromptSubmit BEFORE this group
    let startTs = null;
    for (const pe of progressEvents) {
      const peMs = Date.parse(pe.ts) || 0;
      if (peMs >= groupStartMs) break;
      if (pe.hookEvent === 'PostToolUse' || pe.hookEvent === 'UserPromptSubmit') {
        startTs = pe.ts;
      }
    }

    // Find end time: first PreToolUse or Stop AFTER this group
    let endTs = null;
    for (const pe of progressEvents) {
      const peMs = Date.parse(pe.ts) || 0;
      if (peMs <= groupEndMs) continue;
      if (pe.hookEvent === 'PreToolUse' || pe.hookEvent === 'Stop') {
        endTs = pe.ts;
        break;
      }
    }

    boundaries.push({
      startTs: startTs || group[0].timestamp,
      endTs: endTs || group[group.length - 1].timestamp,
    });
  }

  return boundaries;
}

function progressWindowKey(progressEvents, rowMs) {
  let startTs = null;
  for (const pe of progressEvents) {
    const peMs = Date.parse(pe.ts) || 0;
    if (peMs >= rowMs) break;
    if (pe.hookEvent === 'PostToolUse' || pe.hookEvent === 'UserPromptSubmit') {
      startTs = pe.ts;
    }
  }

  // If no start boundary found, this row appears before any progress event.
  // Return null to let the caller fall back to time-gap grouping, avoiding
  // incorrect merging of distinct LLM calls that precede the first progress event.
  if (!startTs) return null;

  let endTs = null;
  for (const pe of progressEvents) {
    const peMs = Date.parse(pe.ts) || 0;
    if (peMs <= rowMs) continue;
    if (pe.hookEvent === 'PreToolUse' || pe.hookEvent === 'Stop') {
      endTs = pe.ts;
      break;
    }
  }

  return `progress:${startTs}->${endTs || ''}`;
}

// --- Event Builder -----------------------------------------------------------

function buildEventsFromBoundaries(boundaries, contentEvents, allParsed, turnId, sessionId, agentId, runtimeConfig, cwd) {
  const records = [];
  const observedTs = timestampToUnixNanos(Date.now());

  // Find user prompt
  const userRow = contentEvents.find(r => r.type === 'user' && !isToolResult(r));
  const userId = resolveUserId(userRow || contentEvents[0], runtimeConfig);
  const agentType = inferVariant(userRow || contentEvents[0], agentId);
  const providerName = inferProviderName({ 'gen_ai.agent.type': agentType });

  // User-hook event (ENTRY input)
  if (userRow) {
    const userText = extractUserText(userRow);
    if (userText) {
      const userHookModel = contentEvents.find(r => r.type === 'assistant' && r.message?.model)?.message?.model || 'unknown';
      records.push({
        'event.id': crypto.randomUUID(),
        'event.name': 'other',
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.provider.name': providerName,
        'gen_ai.request.model': userHookModel,
        'user.id': userId,
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: userText }] }],
        'agent.source': 'qoder-transcript-hook',
        'agent.qoder.raw_type': 'user',
        'agent.qoder.content_type': 'text',
        time_unix_nano: timestampToUnixNanos(userRow.timestamp),
        observed_time_unix_nano: observedTs,
      });
    }
  }

  // If no progress boundaries detected, fall back to legacy behavior
  if (boundaries.length === 0) {
    const legacyRecords = buildLegacyEvents(contentEvents, turnId, sessionId, agentId, runtimeConfig, records, observedTs);
    return finalizeRecords(legacyRecords, cwd);
  }

  // Assign content events to boundaries.
  // Use extended ranges: each boundary "owns" content from its startTs up to the NEXT boundary's startTs.
  // This ensures tool_result events (which occur between boundaries) are assigned to the preceding boundary.
  const assignedContent = assignContentToBoundaries(boundaries, contentEvents);

  // For each LLM call boundary, produce events
  let toolResultsForNextStep = [];
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const stepId = `${turnId}:s${i + 1}`;
    const content = assignedContent[i] || [];
    const startNanos = isoToUnixNanos(boundary.startTs);
    const endNanos = boundary.endTs ? isoToUnixNanos(boundary.endTs) : startNanos;

    // Pre-scan: extract model name from this step's assistant rows (CLI has message.model)
    const stepModel = content.find(r => r.type === 'assistant' && r.message?.model)?.message?.model || 'auto';

    // llm.request for this step
    let inputDelta;
    if (i === 0 && userRow) {
      inputDelta = [{ role: 'user', parts: [{ type: 'text', content: extractUserText(userRow) }] }];
    } else if (toolResultsForNextStep.length > 0) {
      inputDelta = toolResultsForNextStep.map(tr => ({
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: tr.toolId, response: tr.result }],
      }));
    }

    if (inputDelta) {
      records.push({
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.request',
        'gen_ai.step.id': stepId,
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.provider.name': providerName,
        'gen_ai.request.model': stepModel,
        'user.id': userId,
        'gen_ai.input.messages_delta': inputDelta,
        'agent.source': 'qoder-transcript-hook',
        time_unix_nano: startNanos,
        observed_time_unix_nano: observedTs,
      });
    }

    // Build merged llm.response (multi-parts)
    const outputParts = [];
    const toolCalls = [];
    toolResultsForNextStep = [];
    let responseId = undefined;
    let lastAssistantTs = null;
    let firstAssistantTs = null;

    for (const row of content) {
      if (row.type === 'assistant') {
        const msg = row.message || {};
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        if (msg.id && !responseId) responseId = msg.id;
        if (row.timestamp) lastAssistantTs = row.timestamp;
        if (row.timestamp && !firstAssistantTs) firstAssistantTs = row.timestamp;
        for (const block of blocks) {
          if (block.type === 'thinking') {
            outputParts.push({ type: 'reasoning', content: block.thinking || '' });
          } else if (block.type === 'redacted_thinking') {
            // Redacted thinking blocks are skipped (content not available)
          } else if (block.type === 'text') {
            outputParts.push({ type: 'text', content: block.text || '' });
          } else if (block.type === 'tool_use') {
            outputParts.push({ type: 'tool_call', id: block.id, name: block.name, arguments: block.input });
            toolCalls.push({ id: block.id, name: block.name, input: block.input, preToolTs: endNanos });
          }
        }
      } else if (row.type === 'user' && isToolResult(row)) {
        const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            toolResultsForNextStep.push({ toolId: block.tool_use_id, result: resultText });
          }
        }
      }
    }

    // When startTs == endTs (no distinguishable progress boundary), use assistant timestamp as end
    let responseEndNanos = endNanos;
    if (startNanos === endNanos && lastAssistantTs) {
      responseEndNanos = isoToUnixNanos(lastAssistantTs) || endNanos;
    }

    // Determine finish reason from the last assistant row's stop_reason (authoritative),
    // falling back to inference when not available.
    const lastStopReason = [...content].reverse()
      .find(r => r.type === 'assistant' && r.message?.stop_reason)?.message?.stop_reason;
    let finishReason;
    if (toolCalls.length > 0) {
      finishReason = 'tool_call';
    } else if (lastStopReason === 'max_tokens') {
      finishReason = 'max_tokens';
    } else if (lastStopReason === 'end_turn' || (i === boundaries.length - 1)) {
      finishReason = 'end_turn';
    } else if (lastStopReason) {
      finishReason = lastStopReason;
    } else {
      finishReason = 'stop';
    }

    if (outputParts.length > 0) {
      records.push({
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.response',
        'gen_ai.step.id': stepId,
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.provider.name': providerName,
        'gen_ai.request.model': stepModel,
        'gen_ai.response.model': stepModel,
        'gen_ai.response.id': responseId,
        'gen_ai.response.finish_reasons': [finishReason],
        'user.id': userId,
        'gen_ai.output.messages': [{ role: 'assistant', parts: outputParts, finish_reason: finishReason }],
        'agent.source': 'qoder-transcript-hook',
        // Accurate per-response timestamp from the transcript's first assistant record
        // (≈ SQLite gmt_create). Used only for token-enricher matching; dropped from
        // SLS/JSONL output as an agent-scoped field. Absent for CLI (no firstAssistantTs).
        'agent.qoder.match_ts': firstAssistantTs ? Date.parse(firstAssistantTs) : undefined,
        time_unix_nano: responseEndNanos,
        observed_time_unix_nano: observedTs,
      });
    }

    // tool.call + tool.result events
    for (let ti = 0; ti < toolCalls.length; ti++) {
      const tc = toolCalls[ti];
      const tr = toolResultsForNextStep[ti];
      const toolCallTs = endNanos;

      records.push({
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        'gen_ai.step.id': stepId,
        'gen_ai.turn.id': turnId,
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.tool.name': tc.name,
        'gen_ai.tool.call.id': tc.id,
        'gen_ai.tool.call.exec.id': tc.id,
        'gen_ai.tool.call.arguments': typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
        'user.id': userId,
        'agent.source': 'qoder-transcript-hook',
        time_unix_nano: toolCallTs,
        observed_time_unix_nano: observedTs,
      });

      if (tr) {
        // Find PostToolUse timestamp for this tool
        const postToolTs = findPostToolUseTs(boundaries, i)
          || (BigInt(toolCallTs) + 1_000_000n).toString(); // +1ms fallback → tool span duration ≥ 1ms
        const toolDurationMs = computeDurationMs(toolCallTs, postToolTs);
        records.push({
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          'gen_ai.step.id': stepId,
          'gen_ai.turn.id': turnId,
          'gen_ai.session.id': sessionId,
          'gen_ai.agent.type': agentType,
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.exec.id': tc.id,
          'gen_ai.tool.call.result': tr.result,
          'tool.result.status': 'success',
          ...(toolDurationMs > 0 ? { 'gen_ai.tool.call.duration': toolDurationMs } : {}),
          'user.id': userId,
          'agent.source': 'qoder-transcript-hook',
          time_unix_nano: postToolTs,
          observed_time_unix_nano: observedTs,
        });
      }
    }
  }

  return finalizeRecords(records, cwd);
}

function finalizeRecords(records, cwd) {
  for (const record of records) {
    if (cwd) record['agent.qoder.cwd'] = cwd;
    Object.assign(record, SPAN_ATTRIBUTES, RESOURCE_BASE_FIELD_PATCH, RESOURCE_ATTRIBUTE_FIELDS);
  }
  return records;
}

// --- Content assignment to boundaries ----------------------------------------

function assignContentToBoundaries(boundaries, contentEvents) {
  const assigned = boundaries.map(() => []);

  for (const row of contentEvents) {
    // Skip the user prompt row (already handled as user-hook outside boundaries)
    if (row.type === 'user' && !isToolResult(row)) continue;

    const rowTs = row.timestamp ? Date.parse(row.timestamp) : 0;
    if (!rowTs) continue;

    // Each boundary "owns" from its startTs to the NEXT boundary's startTs (exclusive).
    // This ensures tool_result events (which occur between endTs and next startTs)
    // are assigned to the current boundary, not lost in the gap.
    let bestIdx = -1;
    for (let i = 0; i < boundaries.length; i++) {
      const startMs = Date.parse(boundaries[i].startTs) || 0;
      const nextStartMs = (i + 1 < boundaries.length)
        ? Date.parse(boundaries[i + 1].startTs) || Infinity
        : Infinity;
      if (rowTs >= startMs && rowTs < nextStartMs) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx >= 0) assigned[bestIdx].push(row);
  }

  return assigned;
}

// --- Helpers -----------------------------------------------------------------

/**
 * Split a list of content events into turns.
 * Each real user prompt (type === 'user' and not a tool result) starts a new
 * turn. Tool results and assistant content following a prompt belong to that
 * turn until the next real user prompt.
 */
function splitContentEventsIntoTurns(contentEvents) {
  const turns = [];
  let currentTurn = [];

  for (const row of contentEvents) {
    if (row.type === 'user' && !isToolResult(row)) {
      if (currentTurn.length > 0) {
        turns.push(currentTurn);
      }
      currentTurn = [row];
    } else {
      currentTurn.push(row);
    }
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}

function findPostToolUseTs(boundaries, currentIdx) {
  if (currentIdx + 1 < boundaries.length) {
    return isoToUnixNanos(boundaries[currentIdx + 1].startTs);
  }
  return null;
}

function isToolResult(row) {
  const content = row.message?.content;
  return Array.isArray(content) && content.length > 0 && content[0].type === 'tool_result';
}

function extractUserText(row) {
  const content = row.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') return block.text || '';
      if (typeof block === 'string') return block;
    }
  }
  return '';
}

function inferVariant(row, sourceAgentId) {
  if (sourceAgentId === 'qoder-cn') return 'qoder-cn';
  if (!row) return sourceAgentId === 'qoder' ? 'qoder' : 'qoder-cli';
  if (row.entrypoint === 'cli' || row.promptId || row.permissionMode || row.userType) {
    return 'qoder-cli';
  }
  return 'qoder';
}

function resolveUserId(row, runtimeConfig) {
  if (runtimeConfig?.userId) return runtimeConfig.userId;
  if (row?.userId) return String(row.userId);
  return '';
}

// --- Legacy fallback (no progress events) ------------------------------------
// Used when transcript has no progress events AND no assistant blocks detected.
// Limitations: no llm.request synthesis (LLM spans will be 0ms orphan responses),
// no multi-part merging. QoderTraceInput's token enricher provides tokens but timing is approximate.

function buildLegacyEvents(contentEvents, turnId, sessionId, agentId, runtimeConfig, existingRecords, observedTs) {
  // When no progress events are available, use the old per-line normalization
  for (const row of contentEvents) {
    const record = buildQoderHookRecord(row, { agentId, runtimeConfig, turnId });
    if (record) existingRecords.push(record);
  }

  // Apply step.id with timestamp proximity (legacy logic)
  let stepCounter = 0;
  let lastResponseTs = null;
  for (const record of existingRecords) {
    const eventName = record['event.name'];
    const rawType = record['agent.qoder.raw_type'];
    if (rawType === 'user') continue;
    if (eventName === 'llm.response') {
      const responseTs = record['time_unix_nano'] || '';
      const tsDiff = lastResponseTs === null ? Infinity : Math.abs(Number(responseTs) - Number(lastResponseTs));
      if (tsDiff > 100_000_000) stepCounter++;
      lastResponseTs = responseTs;
    }
    if (stepCounter === 0) stepCounter = 1;
    record['gen_ai.step.id'] = `${turnId}:s${stepCounter}`;
  }

  return existingRecords;
}

// --- Entry point -------------------------------------------------------------

function isDirectExec() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const here = fileURLToPath(import.meta.url);
  if (path.resolve(argv1) === here) return true;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(here);
  } catch {
    return false;
  }
}

if (isDirectExec()) {
  main().catch((e) => {
    try {
      const agentId = process.argv.find((_, i) => process.argv[i - 1] === '--agent-id') || 'unknown';
      const file = getErrorLogFile(agentId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      fs.appendFileSync(file, `[${ts}] ${e.message}\n`, 'utf-8');
    } catch { /* ignore */ }
  });
}
