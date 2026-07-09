#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * kiro-cli-hook-processor.mjs — Kiro CLI hook 主分发器。
 *
 * 由 kiro-cli-loongsuite-pilot-hook.sh 调用:
 *   $ node kiro-cli-hook-processor.mjs <subcommand>
 *
 * subcommand（camelCase，由 hook.sh 把 PascalCase 事件转过来）:
 *   userPromptSubmit / preToolUse / postToolUse / stop
 *
 * 双源关联（round3 APPROVED）:
 *   - transcript 主干（sqlite conversations_v2.value.history[]）→ STEP/LLM span
 *   - hook PostToolUse 仅补 tool_response（transcript 拿不到的唯一产出）
 *
 * 时间戳:
 *   - STEP/LLM span: transcript ms 级 request_start/end_timestamp_ms（真实时刻）
 *   - TOOL span: hook processor 接收时刻兜底（precision 1s，标注 time_source）
 *
 * token: 恒 null（AWS 后端只回吐 credit）；credit 仅作自定义 attribute。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { readStdinJson } from './shared/stdin-reader.mjs';
import {
  INITIAL_HASH,
  computeHash,
  shouldLogFullMessages,  // kept for reference; not called (kiro uses logFull=true directly)
  generateTraceId,
  generateSpanId,
  writeJsonlRecords,
} from './shared/event-emitter.mjs';
import { logHookError } from './shared/error-logger.mjs';
import {
  sanitizeObject,
  toJsonValue,
  loadHookRuntimeConfig,
  resolveUserId,
  applyHookContentPolicy,
} from './agent-event-normalizer.mjs';

import { readTranscriptForCwd, parseConversationValue } from './kiro-cli/transcript-parser.mjs';
import { readSessionJsonl } from './kiro-cli/session-parser.mjs';
import {
  appendToolEvent, drainToolEvents,
  appendPreToolEvent, drainPreToolEvents,
  loadOffset, saveOffset,
  loadSessionOffset, saveSessionOffset,
  loadEmittedSteps, saveEmittedSteps,
  loadTurnCount, saveTurnCount,
  enqueuePendingStop,
} from './kiro-cli/state.mjs';
import { resolveDbPath } from './kiro-cli/db-path.mjs';

const AGENT_ID = 'kiro-cli';
const PROVIDER_NAME = 'amazon'; // Kiro CLI = Amazon Q CodeWhisperer 再分发

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

/**
 * Send SIGUSR1 to the daemon process so KiroCliSessionInput triggers a
 * collect cycle after its mature delay, rather than waiting for the next
 * 60s fallback poll. Failures are silently ignored — the poll fallback
 * will pick up the pending record within a minute.
 */
function wakeDaemon(dataDir) {
  try {
    const pidFile = path.join(dataDir, 'loongsuite-pilot.pid');
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (pid > 0) process.kill(pid, 'SIGUSR1');
  } catch {
    // PID file missing, stale, or process gone — fallback poll will handle it.
  }
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
}

function tryReadStdin() {
  try {
    return readStdinJson();
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'stdin_parse',
      errorType: 'parse_failed',
      errorMessage: err?.message || String(err),
    });
    return {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function msToUnixNanos(ms) {
  if (!ms || !Number.isFinite(ms)) return '0';
  return String(Math.floor(ms)) + '000000';
}

function isoToUnixNanos(iso) {
  if (!iso) return '0';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '0';
  return String(ms) + '000000';
}

/** ISO 字符串 → epoch ms。用于从 hook 事件 startTs/captureTs 重算 step 时间。 */
function isoToMs(iso) {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

// ─── cmd handlers ───

/**
 * postToolUse: 把 tool_response 缓冲到 per-cwd 文件，stop 时再 join。
 * 不发任何 JSONL（避免无 step 上下文的孤立 tool 事件）。
 */
function cmdPostToolUse() {
  const event = tryReadStdin();
  const cwd = event && event.cwd;
  if (!cwd) return;
  const toolName = event.tool_name || 'unknown';
  const toolInput = event.tool_input ?? {};
  const toolResponse = event.tool_response ?? null;
  appendToolEvent(cwd, {
    toolName,
    toolInput,
    toolResponse,
    captureTs: nowIso(),
  });
}

/**
 * preToolUse: 缓冲 {toolName, toolInput, startTs} 到 per-cwd 独立文件。
 * stop 时与 transcript tool_use join，为 tool.call 提供真实起点时间。
 */
function cmdPreToolUse() {
  const event = tryReadStdin();
  const cwd = event && event.cwd;
  if (!cwd) return;
  const toolName = event.tool_name || 'unknown';
  const toolInput = event.tool_input ?? {};
  appendPreToolEvent(cwd, {
    toolName,
    toolInput,
    startTs: nowIso(),
  });
}

/**
 * userPromptSubmit: 不单独发 JSONL。
 * transcript 主干已覆盖 prompt。
 */
function cmdNoop() {
  // intentionally empty
}

/**
 * stop: 现在仅"投递"一条 pending 记录到队列，立即返回 {}。
 *  - 不再调用 transcript / session 读取（避免 sidecar 异步写延迟阻塞 kiro-cli）
 *  - 不再 drain 缓冲（postToolUse/preToolUse 缓冲文件由 delayedCollect 接管）
 *  - 真正的采集由主服务侧的 KiroCliSessionInput 延迟触发（SIGUSR1 唤醒 + 10s 成熟延迟）
 *
 * 入队字段：cwd / stop 时刻 / 两条 offset 快照 / assistant_response / userId。
 */
function cmdStop() {
  const event = tryReadStdin();
  const cwd = event && event.cwd;
  if (!cwd) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'cmd_stop',
      errorType: 'missing_cwd',
      errorMessage: 'stop hook stdin lacks cwd; skipping',
    });
    return;
  }

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);

  // offset 快照：把 stop 触发瞬间的位置传给延迟采集，避免 delayed scan 跟新 stop 抢同一段窗口
  const sinceMs = loadOffset(cwd);
  const sessionSinceMs = loadSessionOffset(cwd);

  enqueuePendingStop({
    cwd,
    stopUnixMs: Date.now(),
    sinceMs,
    sessionSinceMs,
    assistantResponse: typeof event?.assistant_response === 'string' ? event.assistant_response : null,
    userId,
  });

  // Wake the daemon so KiroCliSessionInput processes the pending record after
  // its mature delay instead of waiting for the next 60s fallback poll.
  wakeDaemon(pilotDataDir());
}

/**
 * cmdDelayedCollect: 主服务侧 KiroCliSessionInput 在 pending 成熟后调起。
 * argv: node kiro-cli-hook-processor.mjs delayedCollect <pending-file> [--allow-fallback]
 *
 * 读取 pending 记录中的快照 (cwd / sinceMs / sessionSinceMs / assistantResponse / userId)，
 * 然后执行与原 cmdStop 等价的采集流程：
 *   1. drain per-cwd PostToolUse / PreToolUse 缓冲
 *   2. 读 SQLite transcript（带轮询）
 *   3. SQLite miss → session JSONL fallback（同样带轮询，但因为已经延迟过，
 *      正常情况下 sidecar 已就绪；--allow-fallback 时即便 timing 不完整也接受）
 *   4. 去重 / 构造 records / 写 JSONL / 推进 offset
 */
async function cmdDelayedCollect() {
  const pendingPath = process.argv[3];
  const allowFallback = process.argv.includes('--allow-fallback');
  if (!pendingPath) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'cmd_delayed_collect',
      errorType: 'missing_argv',
      errorMessage: 'delayedCollect missing pending file argv',
    });
    return;
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'cmd_delayed_collect',
      errorType: 'pending_read_failed',
      errorMessage: `${pendingPath}: ${err?.message || String(err)}`,
    });
    return;
  }
  const cwd = record?.cwd;
  if (!cwd) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'cmd_delayed_collect',
      errorType: 'missing_cwd',
      errorMessage: `pending record at ${pendingPath} lacks cwd`,
    });
    return;
  }
  // userId 已由 stop hook 时刻 resolve（rendering 与原 cmdStop 等价）。
  // assistantResponse 用作 history[] 缺最终 Response 步时的合成兜底。
  const ctx = {
    cwd,
    sinceMs: typeof record.sinceMs === 'number' ? record.sinceMs : loadOffset(cwd),
    sessionSinceMs: typeof record.sessionSinceMs === 'number' ? record.sessionSinceMs : loadSessionOffset(cwd),
    assistantResponse: typeof record.assistantResponse === 'string' ? record.assistantResponse : null,
    userId: typeof record.userId === 'string' && record.userId
      ? record.userId
      : resolveUserId({}, loadHookRuntimeConfig(pilotDataDir())),
    allowFallback,
  };

  const status = await runCollect(ctx);
  // 把状态打到 stdout，让 input 层据此决定 finish/release/log
  // 'ok'              → 已成功落盘 records / 或确认无新 step（删除 pending）
  // 'timing_pending'  → sidecar 仍不全 → 退回 ready/，下一轮再试
  // 'no_data'         → transcript & session 都为空 → 删除 pending（kiro-cli 这次没产数据）
  try {
    process.stdout.write(JSON.stringify({ status }) + '\n');
  } catch {
    // ignore
  }
}

/**
 * 核心采集流程（原 cmdStop 主体）。
 *
 * @param {object} ctx
 * @param {string}  ctx.cwd
 * @param {number}  ctx.sinceMs            SQLite updated_at 游标
 * @param {number}  ctx.sessionSinceMs     session JSONL updated_at 游标
 * @param {string?} ctx.assistantResponse  stop 事件自带的合成兜底文本
 * @param {string}  ctx.userId
 * @param {boolean} ctx.allowFallback      true: timing 不全也强制 fallback emit
 * @returns {Promise<'ok'|'timing_pending'|'no_data'>}
 */
async function runCollect(ctx) {
  const { cwd, assistantResponse, userId, allowFallback } = ctx;
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());

  // Offset：处理时现取当前持久化值（参考 codex/claude-code 模式），与 pending 快照取 max。
  // pending 快照在 stop 时刻写入，若那时 daemon 已挂、state 丢失，快照=0；处理时若 state
  // 已恢复（current>0），用 current 避免 cold-start 回放。两者都 0 才真 cold-start → 走 stale 检查。
  const currentSinceMs = loadOffset(cwd);
  const currentSessionSinceMs = loadSessionOffset(cwd);
  const sinceMs = Math.max(typeof ctx.sinceMs === 'number' ? ctx.sinceMs : 0, currentSinceMs || 0);
  const sessionSinceMs = Math.max(typeof ctx.sessionSinceMs === 'number' ? ctx.sessionSinceMs : 0, currentSessionSinceMs || 0);

  const toolEvents = drainToolEvents(cwd);
  const preToolEvents = drainPreToolEvents(cwd);

  let transcript;

  // 优先 SQLite transcript
  const dbPath = resolveDbPath();
  if (fs.existsSync(dbPath)) {
    // transcript 落盘略滞后于 stop hook，轮询等待稳定。
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        transcript = await readTranscriptForCwd(cwd, { dbPath, sinceUpdatedMs: sinceMs });
        if (transcript && transcript.steps.length > 0) break;
      } catch (err) {
        logHookError({
          agentId: AGENT_ID,
          stage: 'transcript_read',
          errorType: 'read_failed',
          errorMessage: err?.message || String(err),
        });
        break;
      }
      await new Promise((r) => setTimeout(r, 200 * (1 << attempt)));
    }
    // Cold-start stale-session skip（SQLite 路径，与 session_jsonl 路径对齐）：
    // sinceMs===0（offset 快照在 stop 时已丢）且 SQLite 行 updated_at 距今 >5min
    // → 这是重启前遗留的旧 session 回放，整个跳过。
    if (transcript && transcript.steps.length > 0 && sinceMs === 0 &&
        transcript.updatedMs > 0 &&
        (Date.now() - transcript.updatedMs) > 5 * 60 * 1000) {
      logHookError({
        agentId: AGENT_ID,
        stage: 'transcript_read',
        errorType: 'cold_start_stale_session_skipped',
        errorMessage: `cold start (sqlite): row updated ${Math.round((Date.now() - transcript.updatedMs) / 1000)}s ago — skipping stale replay`,
      });
      transcript = null;
    }
  }

  // SQLite miss → session JSONL fallback (with retry + offset)
  if (!transcript || transcript.steps.length === 0) {
    transcript = await trySessionJsonl(cwd, sessionSinceMs, { allowFallback });
  }

  if (!transcript || transcript.steps.length === 0) {
    return 'no_data';
  }

  // step-level idempotent dedup
  const currentConvId = transcript.conversationId || transcript.continuationId || 'unknown';
  const emittedMap = loadEmittedSteps(cwd);
  const seenIds = emittedMap.get(currentConvId) || new Set();

  const originalHasFinalResponse = transcript.steps.some(
    (s) => s.kind === 'NotToolUse' && s.assistantText,
  );

  const newSteps = transcript.steps.filter((s) => {
    const sid = s.stepId || '';
    if (!sid) return true;
    return !seenIds.has(sid);
  });

  if (newSteps.length === 0) return 'ok';

  // timing 完整性：fallback 模式即使不全也走；否则一旦有 0 → 退回 ready
  const allTimingValid = newSteps.every((s) => s.startTimeMs > 0);
  if (!allTimingValid && !allowFallback) {
    return 'timing_pending';
  }

  const dedupedTranscript = { ...transcript, steps: newSteps };

  const stopEventLike = assistantResponse
    ? { cwd, assistant_response: assistantResponse }
    : { cwd };

  const records = buildRecords(
    dedupedTranscript, toolEvents, preToolEvents, cwd, userId, stopEventLike,
    { originalHasFinalResponse },
  );
  if (records.length === 0) return 'ok';

  const cleaned = records.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));

  let writeOk = false;
  try {
    writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
    writeOk = true;
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'jsonl_write',
      errorType: 'write_failed',
      errorMessage: err?.message || String(err),
    });
  }

  if (!writeOk) return 'timing_pending';

  // timing valid 才推进去重 + offset；fallback 强发也同样推进（避免下次重复处理）
  saveEmittedSteps(cwd, currentConvId, newSteps.map((s) => s.stepId));
  if (transcript.source === 'session_jsonl' && transcript.updatedMs) {
    saveSessionOffset(cwd, transcript.updatedMs);
  } else if (transcript.source !== 'session_jsonl' && transcript.updatedMs) {
    saveOffset(cwd, transcript.updatedMs);
  }

  return 'ok';
}

/**
 * session JSONL fallback：扫描 ~/.kiro/sessions/cli/ 找 cwd 匹配的最新 session。
 * 带 3 次重试 + 指数退避（200ms, 400ms, 800ms），合计 ~1.4s。
 * 因为本函数现在由 delayedCollect 在 30s 等待后调用，sidecar 通常已就绪；
 * 这层重试仅吸收边界毛刺。
 *
 * @param {string} cwd
 * @param {number} [sinceMs]            session offset，跳过已处理的旧 session
 * @param {object} [opts]
 * @param {boolean} [opts.allowFallback]  true: timing 不全也返回（让 caller emit fallback）
 * @returns {Promise<import('./kiro-cli/transcript-parser.mjs').TranscriptData|null>}
 */
async function trySessionJsonl(cwd, sinceMs = 0, opts = {}) {
  const { allowFallback = false } = opts;
  const MAX_ATTEMPTS = 3;
  // 冷启动时判定 session 是否为"重启前遗留的旧 session"的阈值：
  // sinceMs===0（offset 丢失）且 session.updated_at 距今 > 此值 → 整个跳过，
  // 不采（避免重启后旧 session 的最后 Prompt 被当新数据回放）。
  // 5min 足以覆盖正常 matureDelay(10s)+poll(60s) 处理延迟，又 < 用户换 session 的间隔。
  const COLD_START_STALE_SESSION_MS = 5 * 60 * 1000;
  let lastSession = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const session = await readSessionJsonl(cwd, { sinceUpdatedMs: sinceMs });
      if (session && session.steps.length > 0) {
        // Cold-start stale-session skip: 重启后处理遗留的旧 pending 时，
        // sinceMs===0 且 session 已陈旧（>5min）→ 这是旧 session 回放，整个跳过。
        // 用户当前 session 是 recent（<5min），仍正常采。
        if (sinceMs === 0 && session.updatedMs > 0 &&
            (Date.now() - session.updatedMs) > COLD_START_STALE_SESSION_MS) {
          logHookError({
            agentId: AGENT_ID,
            stage: 'session_jsonl_read',
            errorType: 'cold_start_stale_session_skipped',
            errorMessage: `cold start: session updated ${Math.round((Date.now() - session.updatedMs) / 1000)}s ago (>${COLD_START_STALE_SESSION_MS / 1000}s) — skipping stale replay`,
          });
          return null;
        }
        // Cold-start replay protection: sinceMs===0 表示无 prior offset（如 daemon
        // 重启擦了 session-offsets），此时 session 文件被从头读，含多个已发过的
        // 历史 Prompt。重发会产重复 span + 多 Prompt 一次采集被 run-gap 切碎。
        // 只保留最后一个 Prompt（最后一个唯一 turnStartMs 的 steps）。
        if (sinceMs === 0 && session.steps.length > 1) {
          const lastTurnStart = session.steps[session.steps.length - 1].turnStartMs;
          if (lastTurnStart) {
            const before = session.steps.length;
            session.steps = session.steps.filter((s) => s.turnStartMs === lastTurnStart);
            logHookError({
              agentId: AGENT_ID,
              stage: 'session_jsonl_read',
              errorType: 'cold_start_replay_filtered',
              errorMessage: `cold start (sinceMs=0): kept last prompt only (${session.steps.length}/${before} steps)`,
            });
          }
        }
        lastSession = session;
        const timingValid = session.steps.every((s) => s.startTimeMs > 0);
        if (timingValid) return session;
        if (attempt === MAX_ATTEMPTS - 1) {
          if (allowFallback) {
            logHookError({
              agentId: AGENT_ID,
              stage: 'session_jsonl_read',
              errorType: 'timing_incomplete_fallback',
              errorMessage: `sidecar timing incomplete; falling back (${session.steps.length} steps)`,
            });
            return session;
          }
          // sidecar 异步刷盘，3 次退避（~1.4s）可能还没写完 turn_duration/end_timestamp。
          // 返回 session（而非 null）让 runCollect 的 timing 检查走 'timing_pending' →
          // 重新入队，下轮（60s poll / SIGUSR1）再采，那时 sidecar 已 flush。避免丢 turn。
          logHookError({
            agentId: AGENT_ID,
            stage: 'session_jsonl_read',
            errorType: 'timing_incomplete_requeue',
            errorMessage: `sidecar timing incomplete after ${MAX_ATTEMPTS} retries (${session.steps.length} steps with startTimeMs=0) — returning for requeue`,
          });
          return session;
        }
      }
    } catch (err) {
      logHookError({
        agentId: AGENT_ID,
        stage: 'session_jsonl_read',
        errorType: 'read_failed',
        errorMessage: err?.message || String(err),
      });
      break;
    }
    await new Promise((r) => setTimeout(r, 200 * (1 << attempt)));
  }
  if (allowFallback && lastSession) return lastSession;
  return null;
}

// ─── buildRecords — 整会话的 trace 记录构造 ───

function buildRecords(transcript, toolEvents, preToolEvents, cwd, userId, stopEvent, opts = {}) {
  const records = [];
  const sessionId = transcript.conversationId || transcript.continuationId || 'unknown';
  // turn 计数按 cwd 持久化：每次 stop 导出一个新 turn，turn.id 跨轮递增（:t1 → :t2 …）。
  const turnNumber = loadTurnCount(cwd) + 1;
  saveTurnCount(cwd, turnNumber);
  const turnIdBase = `${sessionId}:t${turnNumber}`;

  // 静态 baseFields（不含 trace_id / turn_id，这两个按 run 边界动态生成）
  const baseFields = {
    'gen_ai.session.id': sessionId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'gen_ai.conversation.id': transcript.conversationId || sessionId,
    'user.id': userId,
    ...(cwd ? { 'agent.kiro-cli.cwd': cwd } : {}),
    ...(transcript.source === 'session_jsonl'
      ? {
          'kiro.id_source': 'session_jsonl',
          'kiro.time_precision': 'turn_estimate',
        }
      : {}),
  };

  // ─── Run-boundary detection ───
  // conversations_v2 将同 cwd 的多次 --no-interactive 运行合并为一个 conversation。
  // 按 step 时间间隔 > RUN_GAP_MS 拆分运行边界，每个 run 独立 trace_id。
  const RUN_GAP_MS = 30_000;
  let currentTraceId = generateTraceId();
  let currentTurnId = `${turnIdBase}:r0`;
  let prevEndTimeMs = 0;
  let runIndex = 0;
  let runStepRound = 0;

  let runningHash = INITIAL_HASH;
  let prevInputMsgs = [];
  let stepRound = 0;

  // session_jsonl 路径下用真实 hook 工具边界重算 step LLM 时序的游标：
  //   currentTurnStartMs — 当前 turn 起点，跨 turn 变化时重置 lastToolResultEndMs
  //   lastToolResultEndMs — 上一个 tool.result 的真实结束，作为下一个 LLM step 的起点
  const isSessionJsonl = transcript.source === 'session_jsonl';
  let currentTurnStartMs = NaN;
  let lastToolResultEndMs = 0;

  const steps = transcript.steps;
  const hasFinalResponse = opts.originalHasFinalResponse
    ?? steps.some((s) => s.kind === 'NotToolUse' && s.assistantText);

  for (const step of steps) {
    stepRound++;

    // ── 先匹配本 step 全部 tool（session_jsonl 才重算；SQLite 已有真实时序）──
    // 匹配前置是为了：(1) tool.call/result 复用结果不重复 match；(2) 用真实工具边界
    // 重算 step.startTimeMs/endTimeMs，让 llm.request/response 不再依赖 flushTurn 均分。
    const toolMatches = step.tools.map((tool) => ({
      tool,
      preMatch: matchToolEvent(preToolEvents, tool),
      matched: matchToolEvent(toolEvents, tool),
    }));

    let newPromptBoundary = false; // session_jsonl: 本 step 开启了新 Prompt（turnStartMs 变化）
    if (isSessionJsonl && step.turnStartMs && step.turnStartMs !== currentTurnStartMs) {
      currentTurnStartMs = step.turnStartMs;
      lastToolResultEndMs = 0; // 新 turn：无前置工具
      newPromptBoundary = true;
    }
    if (isSessionJsonl && step.turnStartMs) {
      const turnEnd = step.turnEndMs || step.endTimeMs;
      const firstPre = toolMatches.find((m) => m.preMatch);
      if (firstPre && firstPre.preMatch) {
        // ToolUse step：LLM 响应结束 = 工具调用开始（preToolUse startTs，真实边界）
        step.endTimeMs = isoToMs(firstPre.preMatch.startTs);
        // startTimeMs 仅在有真实前置工具边界时覆盖；否则保留 even-slice，
        // 避免多个无 preMatch 的 step 全塌缩到 turnStart 产生重复 llm.request。
        if (lastToolResultEndMs > 0) step.startTimeMs = lastToolResultEndMs;
      } else if (step.kind === 'NotToolUse' && lastToolResultEndMs > 0) {
        // 终步：仅当存在真实前置工具边界时才重算（startTime=工具结果, endTime=turnEnd）。
        // 无前置匹配时保留 even-slice（其末步 endTime 本就=turnEnd），避免塌缩到 turnStart。
        step.startTimeMs = lastToolResultEndMs;
        step.endTimeMs = turnEnd;
      }
      // else：无 preMatch 且（非终步 或 无前置边界）→ 保留 even-slice 兜底
      const lastMatched = [...toolMatches].reverse().find((m) => m.matched);
      if (lastMatched && lastMatched.matched) {
        lastToolResultEndMs = isoToMs(lastMatched.matched.captureTs);
      }
    }

    // ── Run-boundary detection ──
    // session_jsonl: 按 Prompt 边界切（turnStartMs 变化 = 新用户 turn = 新 run）。
    //   旧逻辑用 >30s 时间差会误切——inter-Prompt 用户思考时间、工具执行时间都会
    //   把一个 turn 切成 r0/r1/r2，且 daemon 重启后多 Prompt 一次采集时切得更碎。
    // SQLite: 保持 >30s 时间差（无 turnStartMs；多 run 合并在一行靠时间差拆）。
    let splitRun = false;
    if (isSessionJsonl) {
      // 跳过首个 step（stepRound==1 是第一条 run，不切）
      if (newPromptBoundary && stepRound > 1) splitRun = true;
    } else {
      if (prevEndTimeMs > 0 && step.startTimeMs > 0 &&
          (step.startTimeMs - prevEndTimeMs) > RUN_GAP_MS) splitRun = true;
    }
    if (splitRun) {
      currentTraceId = generateTraceId();
      runIndex++;
      currentTurnId = `${turnIdBase}:r${runIndex}`;
      runStepRound = 0;
    }
    // Only advance prevEndTimeMs when this step has valid timing; otherwise
    // a 0-timing step would clobber the cursor and mask the next legitimate
    // run boundary (allowFallback / partial-sidecar edge).
    if (step.endTimeMs > 0 || step.startTimeMs > 0) {
      prevEndTimeMs = step.endTimeMs || step.startTimeMs;
    }
    runStepRound++;

    // Per-step fields: baseFields + dynamic trace_id / turn_id + react attributes
    const stepFinishReason = step.kind === 'NotToolUse' ? 'stop' : 'tool_call';
    const stepFields = {
      ...baseFields,
      trace_id: currentTraceId,
      'gen_ai.turn.id': currentTurnId,
      'gen_ai.react.round': runStepRound,
      'gen_ai.react.finish_reason': stepFinishReason,
    };

    const currentStepId = step.stepId || `${currentTurnId}:s${stepRound}`;
    const currentStepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();
    const responseId = step.responseId || `${currentStepId}:r`;
    const modelId = step.modelId || transcript.modelId || 'auto';

    const finishReason = step.kind === 'NotToolUse' ? 'stop' : 'tool_call';

    // input messages: 每个 step 若有 userPrompt 则带用户输入（交互式每个 turn 都有独立 prompt）；
    // 无 userPrompt 时从 ToolUseResults 构建 role: "tool" 消息（SQLite 后续步）。
    const inputMsgs = [];
    if (step.userPrompt) {
      inputMsgs.push({ role: 'user', parts: [{ type: 'text', content: step.userPrompt }] });
    } else if (Array.isArray(step.toolUseResults) && step.toolUseResults.length > 0) {
      for (const resultText of step.toolUseResults) {
        inputMsgs.push({ role: 'tool', parts: [{ type: 'text', content: resultText }] });
      }
    }

    let currentFullHash;
    let delta;
    let logFull;
    if (stepRound === 1) {
      currentFullHash = computeHash(INITIAL_HASH, inputMsgs);
      delta = inputMsgs;
      // kiro-cli always logs full messages: step input is non-cumulative
      // (only previous prompt or tool_result, not a running conversation).
      // Don't use shared shouldLogFullMessages — that's for agents with
      // cumulative context (Claude Code) where delta can reconstruct full.
      logFull = true;
    } else {
      currentFullHash = computeHash(runningHash, inputMsgs);
      delta = inputMsgs;
      logFull = inputMsgs.length > 0;
    }

    // llm.request
    const reqRecord = {
      time_unix_nano: msToUnixNanos(step.startTimeMs),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...stepFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': modelId,
      'gen_ai.input.messages_hash': currentFullHash,
      'gen_ai.input.messages_delta': delta,
    };
    if (logFull) {
      reqRecord['gen_ai.input.messages'] = inputMsgs;
    }
    records.push(reqRecord);

    // output messages:
    //   - NotToolUse 终步: 真 Response.content
    //   - ToolUse 步: 由 transcript tool_uses[] 合成 tool_call parts（derived=true，
    //     表示模型本轮产出即工具调用，无自然语言文本）。
    const outMessages = [];
    if (step.kind === 'NotToolUse' && step.assistantText) {
      outMessages.push({
        role: 'assistant',
        parts: [{ type: 'text', content: step.assistantText }],
        finish_reason: 'stop',
      });
    } else {
      const toolCallParts = step.tools.map((t) => ({
        type: 'tool_call',
        id: t.id || null,
        name: t.name,
        arguments: t.args ?? null,
      }));
      outMessages.push({
        role: 'assistant',
        parts: toolCallParts,
        finish_reason: 'tool_call',
        derived: true,
      });
    }

    // credit 对齐到 step（usage_info 与 history 等长；round3 实证对齐）
    const credit = step.creditIndex >= 0 ? transcript.credits[step.creditIndex] : undefined;

    const respRecord = {
      time_unix_nano: msToUnixNanos(step.endTimeMs || step.startTimeMs),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...stepFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': modelId,
      'gen_ai.response.model': modelId,
      'gen_ai.response.finish_reasons': [finishReason],
      'gen_ai.output.messages': outMessages,
      // token 恒 null（AWS 后端不回吐）；不臆造 0
      'kiro.token_source': 'unavailable',
      ...(credit !== undefined ? { 'kiro.credit_cost': credit } : {}),
    };
    records.push(respRecord);

    runningHash = currentFullHash;
    prevInputMsgs = inputMsgs;

    // tool.call + tool.result: preToolUse 提供 tool.call 真实起点，postToolUse 补 tool_response
    // 复用循环顶部已匹配的 toolMatches，不重复 match（重复 match 会因 splice 已消费而返回 null）
    for (const { tool, preMatch, matched } of toolMatches) {
      const toolSpanId = generateSpanId();
      const toolResult = matched ? matched.toolResponse : null;
      const toolTimeNs = matched ? isoToUnixNanos(matched.captureTs) : msToUnixNanos(step.endTimeMs || step.startTimeMs);

      // tool.call time: preToolUse startTs > step.endTimeMs（LLM 流结束）; 禁用 step.startTimeMs（LLM 请求起点）
      const toolCallTimeNs = preMatch
        ? isoToUnixNanos(preMatch.startTs)
        : msToUnixNanos(step.endTimeMs || step.startTimeMs);

      records.push({
        time_unix_nano: toolCallTimeNs,
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...stepFields,
        span_id: toolSpanId,
        parent_span_id: currentStepSpanId,
        'gen_ai.step.id': currentStepId,
        'gen_ai.tool.name': tool.name,
        'gen_ai.tool.call.id': tool.id,
        'gen_ai.tool.call.arguments': toJsonValue(stripMetaKeys(tool.args ?? {})),
        'kiro.time_source': preMatch ? 'processor_receive' : 'transcript_estimate',
        'kiro.time_precision': preMatch ? 'ms' : (isSessionJsonl ? 'turn_estimate' : 'ms'),
      });

      if (toolResult !== null && toolResult !== undefined) {
        const toolErr = detectToolError(matched?.toolResponse);
        const resultRecord = {
          time_unix_nano: toolTimeNs,
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          ...stepFields,
          span_id: toolSpanId,
          parent_span_id: currentStepSpanId,
          'gen_ai.step.id': currentStepId,
          'gen_ai.tool.name': tool.name,
          'gen_ai.tool.call.id': tool.id,
          'gen_ai.tool.call.result': toJsonValue(extractToolResultText(toolResult)),
          'tool.result.status': toolErr ? 'error' : 'success',
          'kiro.time_source': matched ? 'processor_receive' : 'transcript_estimate',
          'kiro.time_precision': matched ? 'ms' : (isSessionJsonl ? 'turn_estimate' : 'ms'),
        };
        if (toolErr) {
          resultRecord['error.type'] = 'ToolError';
          resultRecord['error.message'] = toolErr.message;
        }
        records.push(resultRecord);
      } else {
        // 无对应 hook 事件（transcript-only）：发一条 derived 的 tool.result 兜底，
        // 用 transcript 的 ToolUseResults（history 下一 entry 的 user.content）。
        // 结果文本仅纯文本，无 success/exit_status 等失败语义字段，
        // 无法据此判定成功/失败（kiro 工具级失败如 fs_read 权限拒绝会在 harness 层崩溃、
        // 不回吐 postToolUse，整个 session 无 pilot 数据，此分支不可达），故恒记 success。
        const derivedResult = deriveToolResultText(step, transcript, tool);
        // 无 postToolUse hook 时 tool.call.time == step.endTimeMs（无真实起点），
        // 若 result 也取同一时刻 → 0ms TOOL span（validate-trace time.non_zero_duration ERROR）。
        // 与已合成的 NotToolUse step 一致：result 时刻至少 +1ms 偏移，保证非零时长。
        records.push({
          time_unix_nano: msToUnixNanos((step.endTimeMs || step.startTimeMs) + 1),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          ...stepFields,
          span_id: toolSpanId,
          parent_span_id: currentStepSpanId,
          'gen_ai.step.id': currentStepId,
          'gen_ai.tool.name': tool.name,
          'gen_ai.tool.call.id': tool.id,
          'gen_ai.tool.call.result': toJsonValue(derivedResult),
          'tool.result.status': 'success',
          'kiro.time_source': 'transcript_derived',
        });
      }
    }
  }

  // 兜底：history[] 缺最终 Response 步 → 用 stop.assistant_response 合成一条 NotToolUse step。
  if (!hasFinalResponse && stopEvent && stopEvent.assistant_response) {
    stepRound++;
    runStepRound++;
    const synthStepId = `${currentTurnId}:s${stepRound}`;
    const synthStepSpanId = generateSpanId();
    const synthLlmSpanId = generateSpanId();
    const synthResponseId = crypto.randomUUID();

    // 合成 request/response 加 +1ms 偏移，避免 validate-trace 报 time.non_zero_duration ERROR
    const synthTimeMs = Date.now();
    const synthReqNano = msToUnixNanos(synthTimeMs);
    const synthRespNano = msToUnixNanos(synthTimeMs + 1);

    const inputMsgs = [];
    const currentFullHash = computeHash(runningHash, inputMsgs);

    const synthFields = {
      ...baseFields,
      trace_id: currentTraceId,
      'gen_ai.turn.id': currentTurnId,
      'gen_ai.react.round': runStepRound,
      'gen_ai.react.finish_reason': 'stop',
    };

    records.push({
      time_unix_nano: synthReqNano,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...synthFields,
      span_id: synthLlmSpanId,
      parent_span_id: synthStepSpanId,
      'gen_ai.step.id': synthStepId,
      'gen_ai.response.id': synthResponseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': transcript.modelId || 'auto',
      'gen_ai.input.messages_hash': currentFullHash,
      'gen_ai.input.messages_delta': [],
    });

    records.push({
      time_unix_nano: synthRespNano,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...synthFields,
      span_id: synthLlmSpanId,
      parent_span_id: synthStepSpanId,
      'gen_ai.step.id': synthStepId,
      'gen_ai.response.id': synthResponseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': transcript.modelId || 'auto',
      'gen_ai.response.model': transcript.modelId || 'auto',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.output.messages': [
        {
          role: 'assistant',
          parts: [{ type: 'text', content: stopEvent.assistant_response }],
          finish_reason: 'stop',
          derived: true,
        },
      ],
      'kiro.token_source': 'unavailable',
      'kiro.synthesized': true,
      'kiro.id_source': 'synthesized',
      'kiro.time_source': 'processor_receive',
      'kiro.time_precision': '1s',
    });
  }

  // 按时间排序，tool 事件交错在 LLM 事件之间，避免 OTLP finish=stop 提前 flush 丢弃。
  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  return records;
}

/**
 * 规范化工具名：strip @namespace/ 前缀。
 * hook 事件对 MCP 工具发 `@filesystem/write_file`，transcript 解析出 `write_file`；
 * builtin 工具无前缀，不变。规范化后两侧对齐，解决 MCP 工具匹配不上导致
 * tool.call/result 退化为 transcript_estimate 的问题。
 */
function normalizeToolName(name) {
  if (!name) return 'unknown';
  return name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
}

/**
 * 通用 hook 事件 → tool_use 匹配（consume-on-match，按规范化名 + 顺序消费）。
 * 命中即 splice，解决同名并行工具串台。
 * 不再按 args 深比：hook(snake_case) 与 transcript(camelCase) 字段名永对不上，
 * 且串行工具按顺序消费即可区分（splice first-match 本身就是顺序语义）。
 */
function matchToolEvent(toolEvents, tool, nameKey = 'toolName') {
  const target = normalizeToolName(tool.name);
  const idx = toolEvents.findIndex((e) => normalizeToolName(e[nameKey]) === target);
  if (idx === -1) return null;
  return toolEvents.splice(idx, 1)[0];
}

function stripMetaKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripMetaKeys);
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('__')) continue;
    clean[k] = stripMetaKeys(v);
  }
  return clean;
}

/**
 * hook tool_response 结构: { success: bool, result: string[] } → 取 result 文本。
 *
 * result 数组元素可能是字符串（fs_read/fs_write 直接文本）或对象（execute_bash
 * 携带 exit_status/stdout/stderr）。对象元素必须 JSON.stringify，否则
 * Array.prototype.join 会调用 String(item) 产出 "[object Object]"，下游
 * OTLP TOOL span 的 gen_ai.tool.call.result 会显示 "[object Object]"。
 */
function extractToolResultText(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return toolResponse;
  if (Array.isArray(toolResponse.result)) {
    return toolResponse.result
      .map(item => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join('\n');
  }
  if (typeof toolResponse.result === 'string') return toolResponse.result;
  // result 为对象或其他结构时整体 stringify，避免下游 String() 产出 [object Object]。
  return JSON.stringify(toolResponse);
}

/**
 * 从 postToolUse tool_response 判定工具是否失败（kiro-cli v2.8.0 pilot-probe 实证语义）。
 *
 * 实测（pilot-probe 抓 kiro 原始 postToolUse payload）：
 *   - execute_bash 命令失败: success=true，退出码在 result[].exit_status（!= "0"）
 *     例: cat /nonexistent → {"success":true,"result":[{"exit_status":"1",...}]}
 *   - success===false 的 postToolUse 在 v2.8.0 下未被观测到（保留判定以兼容未来版本）
 *   - 工具级失败（如 fs_read 权限拒绝）→ kiro 在 harness 层崩溃、不回吐 postToolUse，
 *     整个 session 无 pilot 数据，故该路径无 postToolUse 可检，不在此构造死代码。
 *
 * @returns {{ message: string } | null} 失败时携带真实错误信息（退出码 / 错误文本）
 */
function detectToolError(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return null;
  if (toolResponse.success === false) {
    return { message: extractToolErrorMessage(toolResponse) };
  }
  const items = Array.isArray(toolResponse.result) ? toolResponse.result : [];
  for (const item of items) {
    if (item && typeof item === 'object' &&
      item.exit_status !== undefined && item.exit_status !== null &&
      String(item.exit_status) !== '0') {
      const detail = [item.stderr, item.error, item.output, item.stdout]
        .find((v) => typeof v === 'string' && v.trim());
      return {
        message: detail
          ? `exit_status ${item.exit_status}: ${detail.trim()}`
          : `exit_status ${item.exit_status}`,
      };
    }
  }
  return null;
}

function extractToolErrorMessage(toolResponse) {
  const m = toolResponse.error || toolResponse.message;
  if (typeof m === 'string' && m.trim()) return m.trim();
  try {
    return JSON.stringify(toolResponse).slice(0, 200);
  } catch {
    return 'tool execution reported failure';
  }
}

/**
 * 从 transcript history 的下一个 entry 的 user.content.ToolUseResults 取 tool 结果文本。
 * round3 实证：history[i+1].user.content.ToolUseResults.tool_use_results[].content[].Text
 *
 * session JSONL: 从 toolResultMap（toolUseId → resultText）取。
 */
function deriveToolResultText(step, transcript, tool) {
  if (transcript?.toolResultMap && tool?.id) {
    const result = transcript.toolResultMap.get(tool.id);
    if (result !== undefined) return result;
  }
  return '';
}

// ─── dispatcher ───

const DISPATCH = {
  'stop': cmdStop,
  'postToolUse': cmdPostToolUse,
  'preToolUse': cmdPreToolUse,
  'userPromptSubmit': cmdNoop,
  'delayedCollect': cmdDelayedCollect,
};

const sub = process.argv[2] || 'unknown';
const fn = DISPATCH[sub];
if (fn) {
  Promise.resolve(fn()).catch((err) => {
    logHookError({
      agentId: AGENT_ID,
      stage: `dispatch_${sub}`,
      errorType: 'unhandled',
      errorMessage: err?.message || String(err),
    });
  }).finally(() => {
    process.stdout.write('{}\n');
  });
} else {
  process.stdout.write('{}\n');
}
