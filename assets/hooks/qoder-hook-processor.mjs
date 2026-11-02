#!/usr/bin/env node
/**
 * Qoder/QoderCN Hook: publish bounded metadata only. The collector imports
 * the exported semantic parser below and supplies bounded native Turn ranges.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  parseArgs,
  getErrorLogFile,
  LOONGSUITE_PILOT_DATA_DIR,
} from './shared/hook-processor-base.mjs';
import {
  buildQoderHookRecord,
  inferProviderName,
  toJsonValue,
} from './agent-event-normalizer.mjs';
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
  parseSpanAttributesFromEnv,
} from './shared/resource-context.mjs';
import { publishQoderWakeup, readQoderHookPayload } from './qoder/hook-wakeup.mjs';

const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: 'qoder' });
// Caller-supplied span attributes (e.g. multica.*) stamped as top-level record
// fields so the trace flusher can pass matching keys through to span attributes.
const SPAN_ATTRIBUTES = parseSpanAttributesFromEnv(process.env, {
  agentId: 'qoder',
  allowInvocationIdentity: true,
});

const MAX_USER_IDENTITY_VALUE_LENGTH = 512;
const QODER_HOME = path.join(os.homedir(), '.qoder');
const QODER_CLI_STATUS_TIMEOUT_MS = 3000;
const QODER_CLI_STATUS_FAILURE_TTL_MS = 60_000;
function smallText(file, limit = 16 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('metadata-byte-limit');
    const buffer = Buffer.alloc(limit + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > limit) throw new Error('metadata-byte-limit');
    return buffer.toString('utf8', 0, bytes);
  } finally { fs.closeSync(fd); }
}

function nonEmptyIdentityValue(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_USER_IDENTITY_VALUE_LENGTH ? trimmed : undefined;
}

export function extractUserIdentity(extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return undefined;
  const user = extra.user;
  if (!user || typeof user !== 'object' || Array.isArray(user)) return undefined;
  const name = nonEmptyIdentityValue(user.name);
  const email = nonEmptyIdentityValue(user.email);
  return name || email ? { ...(name ? { name } : {}), ...(email ? { email } : {}) } : undefined;
}

// CN IDE exposes email beside `user`; phone-only Alibaba Cloud accounts may
// have a name without an email. Never treat a login name/phone/account ID as email.
function accountEmail(value) {
  const email = nonEmptyIdentityValue(value);
  return email && /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
}

export function extractQoderCnUserIdentity(extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return undefined;
  const user = extra.user && typeof extra.user === 'object' && !Array.isArray(extra.user)
    ? extra.user : undefined;
  const name = nonEmptyIdentityValue(user?.name);
  const email = accountEmail(user?.email) ?? accountEmail(extra.email);
  return name || email ? { ...(name ? { name } : {}), ...(email ? { email } : {}) } : undefined;
}

function readQoderAppUserIdentity(agentId) {
  const product = { qoder: 'qoder', 'qoder-cn': 'qodercn' }[agentId];
  if (!product) return undefined;
  // This is the Desktop's public account projection, not its credential store.
  // It is rewritten on account changes (including logout), not on a heartbeat.
  // Read per Stop and carry that snapshot through retries, rather than caching
  // it by session or mixing the Desktop account into an IDE invocation.
  const statusPath = path.join(os.homedir(), `.${agentId}`, '.qoder-app-status.json');
  const limit = 16 * 1024;
  let fd;
  try {
    fd = fs.openSync(statusPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return undefined;
    const buffer = Buffer.alloc(limit + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > limit) return undefined;
    const status = JSON.parse(buffer.toString('utf8', 0, length));
    if (status?.schema_version !== 1 || status.product !== product
      || status.writer !== 'main' || status.logged_in !== true) return undefined;
    const snapshotAt = typeof status.snapshot_at === 'string' ? Date.parse(status.snapshot_at) : NaN;
    if (!Number.isFinite(snapshotAt) || snapshotAt > Date.now() + 5 * 60_000) return undefined;
    const name = nonEmptyIdentityValue(status.name);
    const email = accountEmail(status.email);
    return name || email ? { ...(name ? { name } : {}), ...(email ? { email } : {}) } : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export async function resolveQoderCliUserIdentity(dataDir = LOONGSUITE_PILOT_DATA_DIR) {
  const cacheFile = path.join(dataDir, 'state/hooks/qoder-cli-user-identity.json');
  const authPath = path.join(QODER_HOME, '.auth', 'user');
  let authStat;
  try {
    authStat = fs.statSync(authPath);
    if (!authStat.isFile()) return undefined;
  } catch {
    return undefined;
  }

  let cached;
  try {
    cached = JSON.parse(smallText(cacheFile));
  } catch {
    cached = undefined;
  }
  if (
    cached?.schemaVersion === 1
    && cached.authPath === authPath
    && cached.mtimeMs === authStat.mtimeMs
    && cached.size === authStat.size
  ) {
    if (Number.isFinite(cached.failedUntil)) {
      if (Date.now() < cached.failedUntil) return undefined;
    } else if (cached.loggedIn === false) {
      return undefined;
    } else {
      const name = nonEmptyIdentityValue(cached.name);
      const email = nonEmptyIdentityValue(cached.email);
      return name || email ? { ...(name ? { name } : {}), ...(email ? { email } : {}) } : undefined;
    }
  }

  let executable;
  try {
    const cliDir = path.join(QODER_HOME, 'bin', 'qodercli');
    const version = smallText(path.join(cliDir, 'version.txt'), 128).trim();
    if (!/^\d+(?:\.\d+)*$/.test(version)) return undefined;
    executable = path.join(
      cliDir,
      `qodercli-${version}${process.platform === 'win32' ? '.exe' : ''}`,
    );
    fs.accessSync(executable, fs.constants.X_OK);
    if (!fs.statSync(executable).isFile()) return undefined;
  } catch {
    return undefined;
  }

  const timedOut = Symbol();
  const child = spawn(executable, ['status', '--output', 'json'], {
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let stdout = '';
  let timer;
  const output = new Promise(resolve => {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('error', () => {});
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length <= 64 * 1024) return;
      try { child.stdout?.destroy(); } catch { /* ignore */ }
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      resolve(undefined);
    });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      if (code !== 0) return resolve(undefined);
      try {
        const parsed = JSON.parse(String(stdout || '').trim());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return resolve(undefined);
        if (parsed.logged_in === false) return resolve({ loggedIn: false });
        if (parsed.logged_in !== true) return resolve(undefined);
        const name = nonEmptyIdentityValue(parsed.username);
        const email = nonEmptyIdentityValue(parsed.email);
        resolve(name || email
          ? { loggedIn: true, ...(name ? { name } : {}), ...(email ? { email } : {}) }
          : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
  const status = await Promise.race([
    output,
    new Promise(resolve => {
      timer = setTimeout(() => resolve(timedOut), QODER_CLI_STATUS_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (status === timedOut) {
    try { child.stdout?.destroy(); } catch { /* ignore */ }
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
    } else {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }
  }

  const temporary = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(status && status !== timedOut ? {
      schemaVersion: 1,
      authPath,
      mtimeMs: authStat.mtimeMs,
      size: authStat.size,
      loggedIn: status.loggedIn,
      ...(status.name ? { name: status.name } : {}),
      ...(status.email ? { email: status.email } : {}),
    } : {
      schemaVersion: 1,
      authPath,
      mtimeMs: authStat.mtimeMs,
      size: authStat.size,
      failedUntil: Date.now() + QODER_CLI_STATUS_FAILURE_TTL_MS,
    }), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temporary, cacheFile);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* best-effort */ }
  }
  if (!status || status === timedOut || !status.loggedIn) return undefined;
  return {
    ...(status.name ? { name: status.name } : {}),
    ...(status.email ? { email: status.email } : {}),
  };
}

// --- Timestamp helpers -------------------------------------------------------

function isoToUnixNanos(isoString) {
  const nanos = timestampOrderNanos(isoString);
  return nanos === null ? '' : String(nanos);
}

function timestampToUnixNanos(value) {
  if (!value) return String(BigInt(Date.now()) * 1_000_000n);
  if (typeof value === 'number') return String(BigInt(Math.round(value)) * 1_000_000n);
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return value;
    const nanos = timestampOrderNanos(value);
    if (nanos !== null) return String(nanos);
  }
  return String(BigInt(Date.now()) * 1_000_000n);
}

function timestampOrderNanos(value) {
  if (typeof value !== 'string' || !value) return null;

  // Date.parse() truncates ISO fractions to milliseconds. Qoder emits
  // microsecond timestamps, so two ordered events such as .999176 and .999890
  // otherwise compare as equal and can collapse adjacent LLM boundaries.
  const match = value.match(/^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/);
  if (match) {
    const [, wholeSeconds, fraction = '', zone] = match;
    const wholeSecondsMs = Date.parse(`${wholeSeconds}${zone}`);
    if (!Number.isNaN(wholeSecondsMs)) {
      const fractionNanos = BigInt((fraction + '000000000').slice(0, 9));
      return BigInt(wholeSecondsMs) * 1_000_000n + fractionNanos;
    }
  }

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1_000_000n;
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
  const parsed = parseArgs();
  const agentId = parsed.agentId === 'qoder-cli' ? 'qoder' : parsed.agentId;
  try {
    let payload = await readQoderHookPayload();
    const args = process.argv.slice(2);
    if (args.includes('--retry')) {
      const argument = name => args[args.indexOf(name) + 1];
      payload = {
        session_id: argument('--session'), transcript_path: argument('--transcript'),
        hook_event_name: 'Stop', cwd: args.includes('--cwd') ? argument('--cwd') : undefined,
        legacy_trigger_line: Number(argument('--trigger-end-line')),
        extra: payload ? { user: payload } : undefined,
      };
    }
    if (!payload) return;
    const desktop = payload.parent_business_info?.product === 'app';
    const identity = agentId === 'qoder-cn'
      ? extractQoderCnUserIdentity(payload.extra)
      : extractUserIdentity(payload.extra);
    publishQoderWakeup(payload, {
      agentId, dataDir: LOONGSUITE_PILOT_DATA_DIR,
      userIdentity: identity ?? (desktop ? readQoderAppUserIdentity(agentId) : undefined),
    });
  } finally {
    process.stdout.write('{}\n');
  }
}

export function selectTurnSegmentsForCollection(turnSegments, rangeReason, agentId) {
  // QoderCN can inspect a complete snapshot to rebuild its ReAct chain. Other
  // variants do that only during cursor recovery. Only latest may be emitted.
  if (rangeReason !== 'incremental' || agentId === 'qoder-cn') {
    return turnSegments.slice(-1);
  }
  return turnSegments;
}

export function assessStableEofCandidate(previousKey, targetWindow, snapshot) {
  if (targetWindow?.reason !== 'stop-at-eof' || !snapshot?.contentHash) {
    return { candidateKey: null, targetWindow };
  }

  const candidateKey = [
    targetWindow.startLine,
    targetWindow.stopLine,
    targetWindow.endLine,
    snapshot.contentHash,
  ].join(':');
  if (candidateKey !== previousKey) {
    return { candidateKey, targetWindow };
  }

  return {
    candidateKey,
    targetWindow: {
      ...targetWindow,
      status: 'complete',
      reason: 'stable-stop-eof',
    },
  };
}

export function findIncrementalTurnEndLine(snapshot, startLine, scanEndLine) {
  const rows = snapshot?.rows || [];
  let sawStop = false;

  for (let i = startLine; i < scanEndLine && i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const hookEvent = hookEventOf(row);
    if (hookEvent === 'Stop') {
      sawStop = true;
    } else if (sawStop && (
      hookEvent === 'UserPromptSubmit' ||
      isRealUserPrompt(row)
    )) {
      // `last_line_count` is the next unread zero-based line index. Returning
      // the prompt line itself consumes the prior Stop/session metadata while
      // preserving the queued turn's timing marker and user content.
      return i;
    }
  }
  return scanEndLine;
}

// Anthropic's stop_reason mixes turn-terminal values with mid-turn ones.
// `tool_use` and `pause_turn` both mean the assistant resumes after a tool
// result or a server-side pause, so neither ends the turn. Treating every
// stop_reason as a boundary makes a mid-flight snapshot look finished, and
// assessStableEofCandidate can then promote that prefix to a commit.
// `stop_sequence` and `refusal` are terminal and must stay in this set: on real
// transcripts stop_sequence is sometimes the turn's only terminal row, so
// dropping it would turn an early commit into no commit at all.
const TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'refusal',
  // Generic spellings, in case a future Qoder build normalizes before writing.
  'stop',
  'cancelled',
  'error',
]);

function isTerminalStopReason(reason) {
  return typeof reason === 'string' && TERMINAL_STOP_REASONS.has(reason);
}

export function hasQoderCnTerminalMarker(progressEvents, rows) {
  return progressEvents.some(event => event?.hookEvent === 'Stop')
    || rows.some(row => row?.type === 'last-prompt')
    || rows.some(row => (
      row?.type === 'assistant'
      && isTerminalStopReason(row?.message?.stop_reason)
    ));
}

export function findTriggeredTurnWindow(snapshot, triggerEndLine) {
  const waiting = (reason, details = {}) => ({
    status: 'waiting',
    reason,
    startLine: null,
    stopLine: null,
    endLine: null,
    ...details,
  });

  try {
    if (snapshot?.reason !== 'ok') return waiting(snapshot?.reason || 'read-failed');
    const rows = snapshot.rows;
    const limit = snapshot.lineCount;

    // The trigger snapshot can end immediately before Qoder appends its Stop
    // progress rows. Its last visible prompt identifies the active turn; the
    // first Stop after that prompt is the Stop that launched this retry.
    let triggerPromptLine = -1;
    const triggerLimit = Math.min(Math.max(triggerEndLine, 0), limit);
    for (let i = triggerLimit - 1; i >= 0; i--) {
      if (hookEventOf(rows[i]) === 'UserPromptSubmit') {
        triggerPromptLine = i;
        break;
      }
    }
    if (triggerPromptLine < 0) {
      for (let i = triggerLimit - 1; i >= 0; i--) {
        if (isRealUserPrompt(rows[i])) {
          triggerPromptLine = i;
          break;
        }
      }
    }
    if (triggerPromptLine < 0) return waiting('prompt-not-found');

    let stopLine = -1;
    let stopSource = null;
    let assistantStopLine = -1;
    for (let i = triggerPromptLine + 1; i < limit; i++) {
      const hookEvent = hookEventOf(rows[i]);
      if (hookEvent === 'Stop') {
        stopLine = i;
        stopSource = 'progress-stop';
        break;
      }
      if (
        assistantStopLine < 0
        && rows[i]?.type === 'assistant'
        && isTerminalStopReason(rows[i]?.message?.stop_reason)
      ) {
        // Remember it but keep scanning: when a turn carries both signals the
        // progress Stop is the boundary the pre-B3 path used, and it sits after
        // the final assistant row.
        assistantStopLine = i;
        continue;
      }
      if (i >= triggerLimit && (
        hookEvent === 'UserPromptSubmit' ||
        isRealUserPrompt(rows[i])
      )) {
        // The next prompt ends this turn, so the search for a progress Stop must
        // not cross it — otherwise it would adopt the *next* turn's Stop. The
        // triggerLimit guard is what keeps this turn's own user row from reading
        // as that next prompt: it sits just after the UserPromptSubmit progress
        // row, inside the trigger snapshot. A terminal assistant row already seen
        // is still a valid Stop; without one there is nothing to commit yet.
        if (assistantStopLine < 0) return waiting('next-prompt-before-stop');
        break;
      }
    }
    if (stopLine < 0 && assistantStopLine >= 0) {
      stopLine = assistantStopLine;
      stopSource = 'assistant-stop-reason';
    }
    if (stopLine < 0) return waiting('stop-not-found');

    // Resolve the start from the actual Stop instead of trusting a global
    // cursor that may have been reset by redeployment.
    let startLine = -1;
    for (let i = stopLine - 1; i >= 0; i--) {
      if (hookEventOf(rows[i]) === 'UserPromptSubmit') {
        startLine = i;
        break;
      }
    }
    if (startLine < 0) {
      for (let i = stopLine - 1; i >= 0; i--) {
        if (isRealUserPrompt(rows[i])) {
          startLine = i;
          break;
        }
      }
    }
    if (startLine < 0) return waiting('turn-start-not-found');

    for (let i = stopLine + 1; i < limit; i++) {
      const hookEvent = hookEventOf(rows[i]);
      if (hookEvent === 'SessionEnd') {
        return {
          status: 'complete',
          reason: 'session-end',
          startLine,
          stopLine,
          endLine: i + 1,
        };
      }
      if (rows[i]?.type === 'last-prompt') {
        return {
          status: 'complete',
          reason: 'last-prompt',
          startLine,
          stopLine,
          endLine: i + 1,
        };
      }
      if (
        hookEvent === 'UserPromptSubmit' ||
        isRealUserPrompt(rows[i])
      ) {
        // The next real prompt is itself an unambiguous right boundary for the
        // completed Stop turn. Exclude it from this fixed window so its own Stop
        // callback can consume it later.
        return {
          status: 'complete',
          reason: 'next-prompt',
          startLine,
          stopLine,
          endLine: i,
        };
      }
    }
    // Desktop/JetBrains sessions may remain open after every Stop and therefore
    // emit neither SessionEnd nor qodercli's last-prompt marker. The retry caller
    // promotes this candidate only after two byte-identical snapshots, proving
    // the transcript has stopped growing before the fixed EOF window is used.
    return waiting('stop-at-eof', {
      startLine,
      stopLine,
      endLine: limit,
    });
  } catch {
    return waiting('read-failed');
  }
}

function hookEventOf(row) {
  return row?.type === 'progress' ? row.data?.hookEvent || '' : '';
}

// --- LLM Boundary Detection --------------------------------------------------

export function buildLlmBoundaries(_progressEvents, contentEvents) {
  // Step 1: Group assistant blocks into LLM calls. Qoder transcript assistant
  // rows do not consistently carry message.id, and progress windows are hook
  // timing signals, not reliable provider-call boundaries.
  //
  // IDE transcript rows are content blocks, not one row per provider call. A
  // complete response may therefore be spread over thinking, text and multiple
  // tool_use rows, and parallel tool execution may even place an early
  // tool_result between later tool_use rows. The deterministic boundary is:
  // a non-empty stop_reason marks the current provider response complete. The
  // actual split is delayed until the next assistant row so any intervening
  // tool_result remains in the completed response's transcript range. For old
  // rows without stop_reason, matching every tool_use to a tool_result remains
  // the structural fallback.
  const assistantGroups = [];
  let currentGroup = [];
  let currentGroupStartIndex = -1;
  let currentToolIds = new Set();
  let resolvedToolIds = new Set();
  let currentResponseComplete = false;

  function flushGroup(contentEndIndex) {
    if (currentGroup.length > 0) {
      assistantGroups.push({
        rows: currentGroup,
        contentStartIndex: currentGroupStartIndex,
        contentEndIndex,
      });
    }
    currentGroup = [];
    currentGroupStartIndex = -1;
    currentToolIds = new Set();
    resolvedToolIds = new Set();
    currentResponseComplete = false;
  }

  for (let rowIndex = 0; rowIndex < contentEvents.length; rowIndex++) {
    const row = contentEvents[rowIndex];
    if (row.type !== 'assistant') {
      if (isToolResult(row)) {
        for (const block of row.message?.content || []) {
          if (block?.type === 'tool_result' && block.tool_use_id) {
            resolvedToolIds.add(block.tool_use_id);
          }
        }
      }
      continue;
    }
    const ts = timestampOrderNanos(row.timestamp);
    if (ts === null) continue;

    const toolCycleComplete = currentGroup.length > 0 &&
      currentToolIds.size > 0 &&
      [...currentToolIds].every(id => resolvedToolIds.has(id));
    // Progress hooks carry no tool id and third-party hooks share the same
    // transcript, so they cannot safely close an LLM group. stop_reason belongs
    // to the provider response itself and preserves a following terminal
    // response even when a cancelled/interrupted tool omitted tool_result.
    if (currentResponseComplete || toolCycleComplete) flushGroup(rowIndex);

    if (currentGroup.length === 0) currentGroupStartIndex = rowIndex;
    currentGroup.push(row);
    for (const block of row.message?.content || []) {
      if (block?.type === 'tool_use' && block.id) {
        currentToolIds.add(block.id);
      }
    }
    if (typeof row.message?.stop_reason === 'string' && row.message.stop_reason.length > 0) {
      currentResponseComplete = true;
    }
  }
  flushGroup(contentEvents.length);

  // Step 2: Keep each group's exact transcript range. Timing is only fallback
  // metadata and must never be used to reconstruct content ownership.
  const boundaries = [];
  for (let i = 0; i < assistantGroups.length; i++) {
    const group = assistantGroups[i];
    const firstAssistant = group.rows[0];
    const lastAssistant = group.rows[group.rows.length - 1];
    const groupStartNanos = timestampOrderNanos(firstAssistant.timestamp);
    const groupEndNanos = timestampOrderNanos(lastAssistant.timestamp) ?? groupStartNanos;
    if (groupStartNanos === null || groupEndNanos === null) continue;

    boundaries.push({
      startTs: firstAssistant.timestamp,
      endTs: lastAssistant.timestamp,
      contentStartIndex: group.contentStartIndex,
      contentEndIndex: group.contentEndIndex,
    });
  }

  return boundaries;
}

// --- Event Builder -----------------------------------------------------------

export function buildEventsFromBoundaries(boundaries, contentEvents, allParsed, turnId, sessionId, agentId, runtimeConfig, cwd) {
  const records = [];
  const observedTs = timestampToUnixNanos(Date.now());

  // Find user prompt
  const userRow = contentEvents.find(isRealUserPrompt)
    || contentEvents.find(r => r.type === 'user' && !isToolResult(r));
  const userText = userRow ? (extractUserTexts(userRow)[0] ?? '') : '';
  const userId = resolveUserId(userRow || contentEvents[0], runtimeConfig);
  const agentType = inferVariant(userRow || contentEvents[0], agentId);
  const providerName = inferProviderName({ 'gen_ai.agent.type': agentType });

  // User-hook event (ENTRY input)
  if (userRow && userText) {
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
      'gen_ai.input.messages_delta': [{ role: 'user', parts: buildUserMessageParts(userText, contentEvents, agentType) }],
      'agent.source': 'qoder-transcript-hook',
      'agent.qoder.raw_type': 'user',
      'agent.qoder.content_type': 'text',
      time_unix_nano: timestampToUnixNanos(userRow.timestamp),
      observed_time_unix_nano: observedTs,
      ...cliAttachmentFields(agentType, userRow, allParsed),
    });
  }

  // If no assistant boundaries were detected, fall back to legacy behavior. The turn
  // entry `other` is already in `records`, so hand the legacy path only the rows
  // it still owns. Qoder encodes tool results as type=user, so they must survive.
  if (boundaries.length === 0) {
    const residualEvents = contentEvents.filter(
      row => row.type === 'assistant' || isToolResult(row),
    );
    const legacyRecords = buildLegacyEvents(residualEvents, turnId, sessionId, agentId, runtimeConfig, records, observedTs);
    return finalizeRecords(legacyRecords, cwd, runtimeConfig);
  }

  // For each LLM call boundary, produce events
  let toolCallsForNextStep = [];
  let toolResultsForNextStep = [];
  let previousResponseNanos = '';
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const stepId = `${turnId}:s${i + 1}`;
    const content = contentEvents.slice(boundary.contentStartIndex, boundary.contentEndIndex);
    const candidateResponseEndNanos = isoToUnixNanos(boundary.endTs) || isoToUnixNanos(boundary.startTs);
    const precedingNanos = [];
    if (i === 0 && userRow?.timestamp) {
      precedingNanos.push(isoToUnixNanos(userRow.timestamp));
    } else {
      precedingNanos.push(previousResponseNanos);
      for (const result of toolResultsForNextStep) {
        if (result.resultTs) precedingNanos.push(isoToUnixNanos(result.resultTs));
      }
    }
    const { startNanos, endNanos: responseEndNanos } = orderedLlmInterval(
      precedingNanos,
      candidateResponseEndNanos,
      isoToUnixNanos(boundary.startTs),
    );
    const previousToolCallIds = new Set(toolCallsForNextStep.map(tc => tc.id).filter(Boolean));
    const currentContentToolResults = extractToolResults(content);
    const inputToolResultsById = new Map();
    for (const result of [...toolResultsForNextStep, ...currentContentToolResults]) {
      if (result.toolId && previousToolCallIds.has(result.toolId)) {
        inputToolResultsById.set(result.toolId, result);
      }
    }
    const inputToolResults = [...inputToolResultsById.values()];

    // Pre-scan: extract model name from this step's assistant rows (CLI has message.model)
    const stepModel = content.find(r => r.type === 'assistant' && r.message?.model)?.message?.model || 'auto';

    // llm.request for this step
    let inputDelta;
    let emitRequest = i > 0;
    if (i === 0 && userRow) {
      inputDelta = [{ role: 'user', parts: buildUserMessageParts(userText, contentEvents, agentType) }];
      emitRequest = true;
    } else if (inputToolResults.length > 0) {
      inputDelta = [];
      if (toolCallsForNextStep.length > 0) {
        inputDelta.push({
          role: 'assistant',
          parts: toolCallsForNextStep.map(tc => ({
            type: 'tool_call',
            id: tc.id,
            name: tc.name,
            arguments: tc.input,
          })),
        });
      }
      inputDelta.push(...inputToolResults.map(tr => ({
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: tr.toolId, response: tr.result }],
      })));
    }

    if (emitRequest) {
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
        ...(inputDelta ? { 'gen_ai.input.messages_delta': inputDelta } : {}),
        'agent.source': 'qoder-transcript-hook',
        time_unix_nano: startNanos,
        observed_time_unix_nano: observedTs,
        ...(i === 0 ? cliAttachmentFields(agentType, userRow, allParsed) : {}),
      });
    }

    // Build merged llm.response (multi-parts)
    const outputParts = [];
    const toolCalls = [];
    let responseId = undefined;
    let clientRequestId = undefined;
    let firstAssistantTs = null;

    for (const row of content) {
      if (row.type === 'assistant') {
        const msg = row.message || {};
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        if (msg.id && !responseId) responseId = msg.id;
        // The CLI's own request id, carried on the usage object of the row that
        // closes a streamed response (msg.id lands on the first row instead, so
        // the two cannot be read from the same row).
        if (!clientRequestId && msg.usage && typeof msg.usage === 'object' &&
            typeof msg.usage.request_id === 'string' && msg.usage.request_id) {
          clientRequestId = msg.usage.request_id;
        }
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
            toolCalls.push({
              id: block.id,
              name: block.name,
              input: block.input,
              callTs: row.timestamp,
            });
          }
        }
      }
    }
    const currentToolCallIds = new Set(toolCalls.map(tc => tc.id).filter(Boolean));
    toolResultsForNextStep = currentContentToolResults
      .filter(result => result.toolId && currentToolCallIds.has(result.toolId));
    toolCallsForNextStep = toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));

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
      finishReason = normalizeFinishReason(lastStopReason);
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
        ...(finishReason ? { 'gen_ai.response.finish_reasons': [finishReason] } : {}),
        'user.id': userId,
        'gen_ai.output.messages': [{
          role: 'assistant',
          parts: outputParts,
          ...(finishReason ? { finish_reason: finishReason } : {}),
        }],
        'agent.source': 'qoder-transcript-hook',
        // Raw vendor stop_reason, kept because normalizeFinishReason may map it
        // onto a different enum value or drop it. Deliberately a single segment
        // after `agent.`: AGENT_SCOPED_FIELD_RE in entry-builder.ts is
        // /^agent\.[^.]+\..+$/ and both sls-flusher and jsonl-flusher serialise
        // with dropAgentScopedFields: true, so an `agent.qoder.stop_reason`
        // spelling would reach neither sink.
        'agent.stop_reason': lastStopReason,
        // The CLI's own request id for this response, taken from the transcript's
        // usage object. It shares a namespace with a segment record's request_id
        // (gen_ai.response.id does not: that one is the provider's id), so the
        // token-enricher joins segments on this field and only falls back to
        // timestamp proximity when it is absent. Single segment after `agent.`
        // on purpose, same reason as agent.stop_reason above.
        'agent.client_request_id': clientRequestId,
        // Accurate per-response timestamp from the transcript's first assistant record
        // (≈ SQLite gmt_create). Used only for token-enricher matching; dropped from
        // SLS/JSONL output as an agent-scoped field. Absent for CLI (no firstAssistantTs).
        'agent.qoder.match_ts': firstAssistantTs ? Date.parse(firstAssistantTs) : undefined,
        time_unix_nano: responseEndNanos,
        observed_time_unix_nano: observedTs,
      });
    }
    previousResponseNanos = responseEndNanos;

    // tool.call + tool.result events. Parallel tools may finish out of order,
    // so array position is not a valid association key.
    const toolResultsById = new Map(
      toolResultsForNextStep
        .filter(result => result.toolId)
        .map(result => [result.toolId, result]),
    );
    for (let ti = 0; ti < toolCalls.length; ti++) {
      const tc = toolCalls[ti];
      const tr = toolResultsById.get(tc.id);
      const toolCallTs = tc.callTs
        ? isoToUnixNanos(tc.callTs) || responseEndNanos
        : responseEndNanos;

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
        'gen_ai.tool.call.arguments': toJsonValue(tc.input),
        'user.id': userId,
        'agent.source': 'qoder-transcript-hook',
        time_unix_nano: toolCallTs,
        observed_time_unix_nano: observedTs,
      });

      if (tr) {
        // tool_result carries both the tool ID and its actual completion
        // timestamp. PostToolUse progress rows have no tool ID and may arrive
        // out of order, so they cannot safely determine per-tool timing.
        const toolResultTs = ensureEndAfterStart(
          toolCallTs,
          tr.resultTs ? isoToUnixNanos(tr.resultTs) : '',
        );
        const toolDurationMs = computeDurationMs(toolCallTs, toolResultTs);
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
          'tool.result.status': tr.isError ? 'error' : 'success',
          ...(toolDurationMs > 0 ? { 'gen_ai.tool.call.duration': toolDurationMs } : {}),
          'user.id': userId,
          'agent.source': 'qoder-transcript-hook',
          time_unix_nano: toolResultTs,
          observed_time_unix_nano: observedTs,
        });
      }
    }
  }

  return finalizeRecords(records, cwd, runtimeConfig);
}

function finalizeRecords(records, cwd, runtimeConfig) {
  const userIdentity = runtimeConfig?.userIdentity;
  const attributes = runtimeConfig?.resourceAttributes ?? RESOURCE_ATTRIBUTES;
  const spanAttributes = runtimeConfig?.spanAttributes ?? SPAN_ATTRIBUTES;
  markTurnBoundaries(records);
  for (const record of records) {
    if (cwd) record['agent.qoder.cwd'] = cwd;
    if (userIdentity?.name) record['user.name'] = userIdentity.name;
    if (userIdentity?.email) record['user.email'] = userIdentity.email;
    Object.assign(record, spanAttributes, agentBaseFieldPatch(attributes),
      Object.keys(attributes).length > 0 ? { resourceAttributes: attributes } : {});
  }
  return records;
}

// Variants whose records are committed one complete turn at a time, so the
// batch boundaries coincide with the turn boundaries. qoder-cli is excluded:
// its transcript may commit several turns in one batch.
const TURN_BOUNDARY_VARIANTS = new Set(['qoder', 'qoder-cn']);

/**
 * Mark the turn's opening and closing event (qoder / qoder-cn IDE only).
 *
 * The records of one turn arrive in emission order, so the first one is the
 * user-input `other` event and the turn closes with its last `llm.response`.
 * The event-log contract allows exactly one start and one end per turn, so the
 * flags are only ever set to true and never stamped on the events in between.
 * A turn without any `llm.response` (interrupted before the model replied)
 * falls back to closing on its last record, which keeps the single-end
 * guarantee intact.
 */
export function markTurnBoundaries(records) {
  if (records.length === 0) return records;
  if (!TURN_BOUNDARY_VARIANTS.has(records[0]['gen_ai.agent.type'])) return records;

  records[0]['gen_ai.turn.start'] = true;

  let closing = records[records.length - 1];
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]['event.name'] === 'llm.response') {
      closing = records[i];
      break;
    }
  }
  closing['gen_ai.turn.end'] = true;

  return records;
}

// --- Helpers -----------------------------------------------------------------

/**
 * Split a list of content events into turns.
 * isMeta rows stay on the preceding prompt, same as tool results.
 * Slash-command control rows are dropped entirely: they neither start a turn
 * nor contribute content to one.
 */
export function splitContentEventsIntoTurns(contentEvents) {
  const turns = [];
  let currentTurn = [];

  for (const row of contentEvents) {
    if (isControlUserRow(row)) continue;
    if (isRealUserPrompt(row)) {
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

function ensureEndAfterStart(startNanos, candidateEndNanos) {
  try {
    const start = BigInt(startNanos);
    if (candidateEndNanos && BigInt(candidateEndNanos) > start) {
      return candidateEndNanos;
    }
    return String(start + 1n);
  } catch {
    return candidateEndNanos || startNanos;
  }
}

function orderedLlmInterval(precedingNanos, candidateResponseNanos, fallbackStartNanos) {
  try {
    const preceding = precedingNanos
      .filter(value => typeof value === 'string' && /^\d+$/.test(value))
      .map(value => BigInt(value));
    const fallbackStart = /^\d+$/.test(fallbackStartNanos || '')
      ? BigInt(fallbackStartNanos)
      : null;
    let response = /^\d+$/.test(candidateResponseNanos || '')
      ? BigInt(candidateResponseNanos)
      : null;
    let request = preceding.length > 0
      ? preceding.reduce((latest, value) => value > latest ? value : latest) + 1n
      : fallbackStart;

    if (request === null && response !== null) request = response - 1n;
    if (request === null) return { startNanos: '', endNanos: '' };
    if (response === null || response <= request) response = request + 1n;
    return {
      startNanos: request >= 0n ? String(request) : '',
      endNanos: response >= 0n ? String(response) : '',
    };
  } catch {
    return {
      startNanos: fallbackStartNanos || '',
      endNanos: candidateResponseNanos || fallbackStartNanos || '',
    };
  }
}

function isToolResult(row) {
  const content = row.message?.content;
  return Array.isArray(content) && content.length > 0 && content[0].type === 'tool_result';
}

function extractToolResults(rows) {
  const results = [];
  for (const row of rows) {
    if (row.type !== 'user' || !isToolResult(row)) continue;
    for (const block of row.message?.content || []) {
      if (block.type !== 'tool_result') continue;
      results.push({
        toolId: block.tool_use_id,
        result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        isError: block.is_error === true,
        resultTs: row.timestamp,
      });
    }
  }
  return results;
}

// The transcript carries Anthropic's native stop_reason values, but
// gen_ai.response.finish_reasons / output.messages[].finish_reason are the
// normalized OTel GenAI enum shared with every other agent. Anthropic's
// documented set is wider (stop_sequence, pause_turn, refusal,
// model_context_window_exceeded), and validate-trace.mjs raises an *error* for
// values outside VALID_FINISH_REASONS while only warning when the field is
// absent — so an unmappable value is dropped rather than passed through. The raw
// value stays on agent.stop_reason, which survives dropAgentScopedFields.
// Exported so a test can pin it against the validator's set: this file is copied
// into ~/.loongsuite-pilot/hooks and runs standalone, so it cannot import it.
export const VALID_FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_call',
  'tool_calls',
  'error',
  'end_turn',
  'max_tokens',
  // Terminal in otlp-trace-flusher's TERMINAL_FINISH_REASONS and already emitted
  // by the Codex and WorkBuddy paths, so it belongs in the enum.
  'cancelled',
]);

// stop_sequence and refusal both end the turn, so they map onto values that
// TERMINAL_FINISH_REASONS ({stop, end_turn, cancelled, error}) recognizes;
// spelling refusal as `content_filter` would be more faithful but would leave
// that turn's buffer without a Signal A closer.
const FINISH_REASON_ALIASES = {
  tool_use: 'tool_call',
  stop_sequence: 'stop',
  refusal: 'stop',
  model_context_window_exceeded: 'length',
};

// Exported for direct unit coverage: the record path forces `end_turn` on the
// last boundary, so a fixture cannot exercise the drop branch there.
export function normalizeFinishReason(reason) {
  const mapped = FINISH_REASON_ALIASES[reason] ?? reason;
  // Unknown values are dropped, never coerced to `stop`: a mid-turn value such
  // as pause_turn would then read as terminal and Signal A would flush the turn
  // buffer early, trading a validator error for a fragmented trace.
  return VALID_FINISH_REASONS.has(mapped) ? mapped : undefined;
}

function isMetaUser(row) {
  return row?.isMeta === true || row?.isMeta === 'true';
}

function isImageFileAttachment(row) {
  return row?.type === 'attachment' && row?.attachment?.type === 'image_file';
}

function collectTurnImageFileAttachments(rows, userRow) {
  const out = [];
  const userUuid = typeof userRow?.uuid === 'string' ? userRow.uuid : '';
  if (!Array.isArray(rows) || !userUuid) return out;

  for (const row of rows) {
    if (!isImageFileAttachment(row) || row.parentUuid !== userUuid) continue;
    const att = row.attachment || {};
    const filename = typeof att.filename === 'string' ? att.filename.trim() : '';
    if (filename) out.push(slimImageFileAttachment(att, filename));
  }
  return out;
}

function slimImageFileAttachment(att, filename) {
  const slim = { type: 'image_file', filename };
  if (typeof att.displayPath === 'string' && att.displayPath.trim()) {
    slim.displayPath = att.displayPath.trim();
  }
  if (typeof att.mediaType === 'string' && att.mediaType.trim()) {
    slim.mediaType = att.mediaType.trim();
  }
  return slim;
}

function cliAttachmentFields(agentType, userRow, allParsed) {
  if (agentType !== 'qoder-cli') return {};
  const attachments = collectTurnImageFileAttachments(allParsed, userRow);
  return attachments.length > 0 ? { 'agent.qoder.attachments': attachments } : {};
}

export function isRealUserPrompt(row) {
  return row?.type === 'user' && !isToolResult(row) && !isMetaUser(row) && !isControlUserRow(row);
}

// Slash-command plumbing qoder-cli writes as type=user rows. Confirmed shapes,
// all of them a plain-string content and entrypoint=cli:
//   [local-command-caveat]                  isMeta
//   [command-message, command-name]         no isMeta (one row holds both)
//   [local-command-stdout | ...-stderr]     isMeta
// None involves a model call. Only the caveat/stdout rows carry isMeta, so the
// content is what identifies the pair, and no metadata field identifies all three.
const CONTROL_TAGS = new Set([
  'local-command-caveat',
  'command-message',
  'command-name',
  'local-command-stdout',
  'local-command-stderr',
]);

const CAVEAT_OR_OUTPUT_TAGS = new Set([
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
]);

function isEnvelopeSpace(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

/**
 * Return the tag sequence `text` consists of, or null if it holds anything else.
 *
 * Deliberately a single forward scan rather than a regex: a pattern that repeats
 * a lazily-matched envelope is ambiguous about where each envelope ends, and
 * backtracks exponentially on input that nearly matches. The cursor here only
 * ever moves forward, so cost is linear in the length of the text and a hostile
 * prompt cannot stall the Stop hook.
 */
function scanControlEnvelopes(text) {
  const tags = [];
  let i = 0;

  while (i < text.length) {
    while (i < text.length && isEnvelopeSpace(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] !== '<') return null;

    const openEnd = text.indexOf('>', i + 1);
    if (openEnd === -1) return null;
    const tag = text.slice(i + 1, openEnd);
    if (!CONTROL_TAGS.has(tag)) return null;

    const closeAt = text.indexOf(`</${tag}>`, openEnd + 1);
    if (closeAt === -1) return null;

    tags.push(tag);
    i = closeAt + tag.length + 3;
  }

  return tags.length > 0 ? tags : null;
}

function isControlEnvelopeSequence(tags, row) {
  if (tags.length === 1) {
    // A lone <command-name> is something a user can plausibly type or paste, so
    // the banner and output rows are only recognized together with their isMeta.
    return CAVEAT_OR_OUTPUT_TAGS.has(tags[0]) && isMetaUser(row);
  }
  if (tags.length === 2) {
    return tags[0] === 'command-message' && tags[1] === 'command-name';
  }
  return false;
}

export function isControlUserRow(row) {
  // A promptId means the CLI itself booked the row as a submitted prompt, so it
  // can never be plumbing. Most rows carry no promptId, so this only
  // short-circuits; the envelope shape is what decides.
  if (row?.type !== 'user' || isToolResult(row) || row.promptId) return false;
  // Only qoder-cli emits this plumbing, and only ever as a plain string. A
  // content-block array is a real message, whatever its first block looks like.
  if (row.entrypoint !== 'cli') return false;
  const content = row.message?.content;
  if (typeof content !== 'string') return false;

  const tags = scanControlEnvelopes(content);
  return tags !== null && isControlEnvelopeSequence(tags, row);
}

function extractUserTexts(row) {
  const content = row.message?.content;
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block) texts.push(block);
      continue;
    }
    if (block?.type === 'text' && block.text) texts.push(block.text);
  }
  return texts;
}

function buildUserMessageParts(userText, contentEvents, agentType) {
  const parts = [{ type: 'text', content: userText }];
  if (agentType !== 'qoder-cli' || !Array.isArray(contentEvents)) return parts;
  const seen = new Set([userText]);
  for (const row of contentEvents) {
    if (row.type !== 'user' || isToolResult(row)) continue;
    for (const text of extractUserTexts(row)) {
      if (!text || seen.has(text)) continue;
      parts.push({ type: 'text', content: text });
      seen.add(text);
    }
  }
  return parts;
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

// --- Legacy fallback (no LLM boundaries) -------------------------------------
// Used when `buildLlmBoundaries` yields nothing, i.e. the turn has no assistant
// block. Progress events alone do not prevent this path.
// Limitations: no llm.request synthesis (LLM spans will be 0ms orphan responses),
// no multi-part merging. QoderTraceInput's token enricher provides tokens but timing is approximate.

function buildLegacyEvents(residualEvents, turnId, sessionId, agentId, runtimeConfig, existingRecords, observedTs) {
  // Per-line normalization for the rows the caller did not emit itself. The
  // turn's user prompt already arrives via `existingRecords`.
  for (const row of residualEvents) {
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
  // The exported parser is also bundled into dist/index.js. That bundle must
  // never run this stdin Hook entry point during collector startup.
  if (path.basename(fileURLToPath(import.meta.url)) !== 'qoder-hook-processor.mjs') return false;
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
