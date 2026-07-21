import * as crypto from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { buildAgentActivityEntry, toJsonValue } from '../../normalization/entry-builder.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';

const execFile = promisify(execFileCb);

const CLI_TIMEOUT_MS = 10_000;
const TASK_BATCH_LIMIT = 50;
const MAX_TASKS = 500;
const BASELINE_CONCURRENCY = 5;
const COLLECT_CONCURRENCY = 5;
const DAEMON_SOCK_REL = '.real/daemon.sock';
// Number of consecutive list_tasks cycles a session must be absent before pruning its cursor.
// Prevents churn when sessions transiently fall off pagination or the daemon flakes.
const STALE_PRUNE_THRESHOLD = 5;
// listAllTasks may return large payloads with full task metadata; align maxBuffer with getMessages.
const CLI_MAX_BUFFER = 10 * 1024 * 1024;

interface WukongTask {
  id: string;
  session_id: string | null;
  name: string;
  status: string;
  agent_type: string;
  created_at: number;
  completed_at: number | null;
  started_at: number | null;
  last_active_at: number | null;
  metadata: {
    modelName?: string;
    modelProvider?: string;
    sandbox_level?: string;
    [key: string]: unknown;
  };
}

type ValidWukongTask = WukongTask & { session_id: string };

interface ListTasksResponse {
  hasMore: boolean;
  items: WukongTask[];
  nextCursor?: string;
}

interface WukongMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string | null;
  events: AguiEvent[] | null;
  createdAt: number;
  timestamp: number;
  turnIndex: number;
  userMsgId?: string;
  // Explicit completeness flag from get_spark_agui_messages (1 when the message
  // has fully settled). Older payloads may omit it; the gate falls back to events.
  isComplete?: number;
}

interface AguiEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

interface GetMessagesResponse {
  messages: WukongMessage[];
}

interface StepContext {
  stepIndex: number;
  stepId: string;
  stepMessageId: string;
  hasToolCalls: boolean;
  startTimestamp: number;
  stepSpanId: string;
}

// A step accumulates one assistant utterance (reasoning + text) plus the tools it
// triggered. A new step opens when a fresh utterance arrives after the current step
// has already emitted tools — i.e. one step == one LLM decision (spec §2.3).
interface StepAcc {
  ctx: StepContext;
  reasoning: string;
  text: string;
  toolCallParts: Array<{ type: string; id: string; name: string }>;
  firstToolTs?: number;
  lastToolTs?: number;
  lastContentTs: number;
  hasTools: boolean;
  usage?: { input: number; output: number; cache: number; total: number };
  // Per-utterance message id → used as gen_ai.response.id so each LLM call in a
  // run has a UNIQUE response id (the run-level runId is shared and must not be reused).
  responseId?: string;
}

const ACTIVITY_TYPE_TO_TOOL_NAME: Record<string, string> = {
  TERMINAL: 'terminal',
  FILE_WRITE: 'file_write',
  GREP_SEARCH: 'grep_search',
  DIRECTORY_LIST: 'directory_list',
  SKILL: 'skill',
  ARTIFACT: 'artifact',
};

export interface WukongInputOptions extends InputOptions {
  cliPath?: string;
}

export class WukongInput extends BaseInput {
  readonly id = 'wukong';
  readonly agentType = ClientType.Wukong;
  readonly collectionMethod = CollectionMethod.CliApiPolling;

  private readonly cliPath: string;
  private _collectInFlight: Promise<AgentActivityEntry[]> | null = null;
  private _abortController = new AbortController();
  private _lastSkipWarnAt = 0;

  constructor(opts: WukongInputOptions) {
    super(opts);
    this.cliPath = opts.cliPath ?? WukongInput.getCliPath();
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
  }

  static getCliPath(): string {
    if (process.platform === 'darwin') {
      return '/Applications/Wukong.app/Contents/MacOS/wukong-cli';
    }
    return 'wukong-cli';
  }

  static getWatchPaths(): string[] {
    return [path.join(os.homedir(), DAEMON_SOCK_REL)];
  }

  static async checkAvailability(): Promise<boolean> {
    const sockPath = path.join(os.homedir(), DAEMON_SOCK_REL);
    try {
      await fsp.access(sockPath);
    } catch {
      return false;
    }
    try {
      const cliPath = WukongInput.getCliPath();
      const { stdout } = await execFile(cliPath, ['service', 'status'], {
        timeout: CLI_TIMEOUT_MS,
      });
      return /running/i.test(stdout);
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    const state = this.stateStore.get(this.id);
    if (state.extra?.seenCounts != null && typeof state.extra.seenCounts === 'object') return;

    try {
      const tasks = await this.listAllTasks();
      const seenCounts: Record<string, number> = {};
      let baselined = 0;
      for (let i = 0; i < tasks.length; i += BASELINE_CONCURRENCY) {
        const batch = tasks.slice(i, i + BASELINE_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(task => this.getMessages(task.session_id)),
        );
        for (let j = 0; j < batch.length; j++) {
          const r = results[j];
          if (r.status === 'fulfilled') {
            seenCounts[batch[j].session_id] = r.value.messages.length;
            baselined++;
          } else {
            seenCounts[batch[j].session_id] = 0;
          }
        }
      }
      this.stateStore.update(this.id, { extra: { seenCounts } });
      this.logger.info('baseline complete', { total: tasks.length, baselined });
    } catch (err) {
      this.logger.warn('failed to baseline wukong cursor', { error: String(err) });
      this.stateStore.update(this.id, { extra: { seenCounts: {} } });
    }
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    if (this._collectInFlight) {
      // Observability: a previous cycle is still running. Rate-limit warnings to once per minute.
      const now = Date.now();
      if (now - this._lastSkipWarnAt > 60_000) {
        this._lastSkipWarnAt = now;
        this.logger.warn('skip collect: previous cycle still running', {
          pollIntervalMs: this.pollIntervalMs,
        });
      }
      return [];
    }
    const startedAt = Date.now();
    this._collectInFlight = this.doCollect();
    try {
      const result = await this._collectInFlight;
      const elapsed = Date.now() - startedAt;
      if (elapsed > this.pollIntervalMs) {
        this.logger.warn('collect cycle exceeded poll interval', {
          elapsedMs: elapsed,
          pollIntervalMs: this.pollIntervalMs,
        });
      }
      return result;
    } finally {
      this._collectInFlight = null;
    }
  }

  protected override async onStop(): Promise<void> {
    // Abort in-flight execFile children and wait for the cycle to settle.
    this._abortController.abort();
    if (this._collectInFlight) {
      try {
        await this._collectInFlight;
      } catch {
        // ignore — already logged inside doCollect
      }
    }
    // Reset for potential subsequent start()
    this._abortController = new AbortController();
  }

  private async doCollect(): Promise<AgentActivityEntry[]> {
    const state = this.stateStore.get(this.id);
    const seenCounts: Record<string, number> =
      (state.extra?.seenCounts != null && typeof state.extra.seenCounts === 'object')
        ? { ...(state.extra.seenCounts as Record<string, number>) }
        : {};

    let tasks: ValidWukongTask[];
    try {
      tasks = await this.listAllTasks();
    } catch (err) {
      this.logger.debug('wukong list_tasks failed (daemon may be stopped)', { error: String(err) });
      return [];
    }

    if (tasks.length === 0) return [];

    const entries: AgentActivityEntry[] = [];
    let stateChanged = false;

    // Process tasks in concurrent batches (parallel within batch, sequential between batches)
    // — mirrors the BASELINE_CONCURRENCY pattern in onStart.
    for (let i = 0; i < tasks.length; i += COLLECT_CONCURRENCY) {
      // Cooperative cancellation: stop processing more batches if shutdown signaled
      if (!this.running) break;
      const batch = tasks.slice(i, i + COLLECT_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(task => this.processOneTask(task, seenCounts[task.session_id] ?? 0)),
      );
      let batchChanged = false;
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        const task = batch[j];
        if (r.status === 'fulfilled') {
          if (r.value) {
            entries.push(...r.value.entries);
            seenCounts[task.session_id] = r.value.newSeenCount;
            batchChanged = true;
          }
        } else {
          this.logger.warn('failed to process task', {
            taskId: task.id,
            sessionId: task.session_id,
            error: String(r.reason),
          });
        }
      }
      if (batchChanged) stateChanged = true;
      // Note: stateStore.save() is called once per cycle by BaseInput.runCycle
      // after collect() returns. Mid-cycle batch progress is held in memory only
      // and committed atomically at end-of-cycle (no per-batch disk fsync).
    }

    // Prune seenCounts entries for tasks no longer returned by the API.
    // Use a grace window: only delete after STALE_PRUNE_THRESHOLD consecutive
    // missed cycles, to avoid churn when sessions transiently fall off pagination.
    const staleCounters: Record<string, number> =
      (state.extra?.staleCounters != null && typeof state.extra.staleCounters === 'object')
        ? { ...(state.extra.staleCounters as Record<string, number>) }
        : {};
    const activeIds = new Set(tasks.map(t => t.session_id));
    for (const key of Object.keys(seenCounts)) {
      if (activeIds.has(key)) {
        if (staleCounters[key] !== undefined) {
          delete staleCounters[key];
          stateChanged = true;
        }
        continue;
      }
      const missed = (staleCounters[key] ?? 0) + 1;
      if (missed >= STALE_PRUNE_THRESHOLD) {
        delete seenCounts[key];
        delete staleCounters[key];
        stateChanged = true;
      } else {
        staleCounters[key] = missed;
        stateChanged = true;
      }
    }
    // Drop staleCounters that are no longer tied to any tracked seenCounts entry
    for (const key of Object.keys(staleCounters)) {
      if (seenCounts[key] === undefined) {
        delete staleCounters[key];
        stateChanged = true;
      }
    }

    if (stateChanged) {
      this.stateStore.update(this.id, { extra: { seenCounts, staleCounters } });
    }
    return entries;
  }

  private async processOneTask(
    task: ValidWukongTask,
    prevCount: number,
  ): Promise<{ entries: AgentActivityEntry[]; newSeenCount: number } | null> {
    const messagesResp = await this.getMessages(task.session_id);
    const messages = messagesResp.messages;

    if (messages.length <= prevCount) return null;

    const newMessages = messages.slice(prevCount);

    // Only process fully-settled messages. An assistant message that is still
    // streaming (missing RUN_FINISHED / USAGE / a closing TEXT_MESSAGE_END) is
    // deferred to the next poll so we never emit a truncated answer or 0 tokens
    // and never advance the cursor past a half-baked message.
    const lastCompleteIdx = findLastCompleteIndex(newMessages);
    if (lastCompleteIdx < 0) return null;

    const processable = newMessages.slice(0, lastCompleteIdx + 1);
    const entries = this.transformMessages(task, processable);
    return { entries, newSeenCount: prevCount + processable.length };
  }

  private transformMessages(task: ValidWukongTask, messages: WukongMessage[]): AgentActivityEntry[] {
    const entries: AgentActivityEntry[] = [];
    const sessionId = task.session_id;
    const meta = (task.metadata && typeof task.metadata === 'object')
      ? task.metadata as Record<string, unknown>
      : {};
    const model = (typeof meta.modelName === 'string' && meta.modelName) ? meta.modelName : 'unknown';
    const provider = (typeof meta.modelProvider === 'string' && meta.modelProvider) ? meta.modelProvider : undefined;
    const hostname = os.hostname();

    const commonFields = {
      'host.name': hostname,
      'service.name': 'wukong',
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': ClientType.Wukong,
      'gen_ai.agent.id': task.id,
      // Use the agent type as the stable name for OTLP grouping.
      // task.name is the user-created session title (changes per conversation)
      // which would cause consistent_agent_name validation to fail.
      'gen_ai.agent.name': ClientType.Wukong,
      ...(provider ? { 'gen_ai.provider.name': provider } : {}),
    } as const;

    // Process messages in pairs: user messages get linked to the next assistant's trace
    let pendingUserMessages: WukongMessage[] = [];

    for (const msg of messages) {
      try {
        if (msg.role === 'user') {
          if (msg.content) pendingUserMessages.push(msg);
          continue;
        }

        if (msg.role !== 'assistant') continue;
        const events = msg.events;
        if (!events || events.length === 0) {
          // Assistant with no events — defer user messages, don't emit orphans
          pendingUserMessages = [];
          continue;
        }

        const turnId = resolveTurnId(sessionId, msg);
        const userContent = pendingUserMessages.map(m => m.content).filter(Boolean).join('\n');
        // Earliest user message time = the moment the user submitted the prompt.
        // Used to timestamp the `other` event before the run starts.
        const userPromptTs = pendingUserMessages.length > 0
          ? minOf(pendingUserMessages.map(m => numOr(m.timestamp) ?? numOr(m.createdAt) ?? msg.createdAt))
          : undefined;
        const turnEntries = this.transformAssistantMessage(task, msg, events, model, turnId, commonFields, userContent, userPromptTs);

        // If this assistant produced no entries (e.g., RUN_ERROR with no content),
        // keep pending user messages for the next assistant. Don't emit orphans.
        if (turnEntries.length === 0) {
          continue;
        }

        pendingUserMessages = [];

        entries.push(...turnEntries);
      } catch (err) {
        this.logger.warn('failed to transform message', {
          taskId: task.id,
          sessionId: task.session_id,
          msgId: msg.id,
          error: String(err),
        });
      }
    }

    // Skip pending user messages without subsequent assistant — these are
    // incomplete sessions (user wrote but assistant hasn't responded yet).
    // Don't emit them as orphan ENTRY/AGENT spans with 0 duration.
    // They'll be processed on the next poll when the assistant responds.

    return entries;
  }

  /**
   * Convert one assistant AGUI message (one RUN cycle) into an ordered event-log
   * stream: `other` (user prompt) → per-step `llm.request`/`llm.response` with the
   * step's tools interleaved → final `llm.response`. See EVENT_LOG_TO_TRACE_SPEC.
   *
   * Segmentation: a step is one assistant utterance (reasoning + text) plus the
   * tools it triggered. A new step opens when a fresh utterance arrives after the
   * current step already emitted tools, so STEP count == LLM decision count.
   */
  private transformAssistantMessage(
    task: ValidWukongTask,
    msg: WukongMessage,
    events: AguiEvent[],
    model: string,
    turnId: string,
    common: Record<string, unknown>,
    userContent: string,
    userPromptTs?: number,
  ): AgentActivityEntry[] {
    const entries: AgentActivityEntry[] = [];
    const sessionId = task.session_id;
    const traceId = generateTraceId();
    const agentSpanId = generateSpanId();

    // Defensive: AGUI is external data. Sanitize timestamps once up front.
    const evs: AguiEvent[] = events.map(e => {
      const ts = numOr(e.timestamp) ?? msg.createdAt;
      return ts === e.timestamp ? e : { ...e, timestamp: ts };
    });

    // Run-level scan: these apply to the whole turn, not a single step.
    let runId: string | undefined;
    let runStartedTs: number | undefined;
    let runFinishedTs: number | undefined;
    let runError: { code: string; message: string } | undefined;
    for (const e of evs) {
      switch (e.type) {
        case 'RUN_STARTED':
          runId = e.runId as string | undefined;
          runStartedTs = e.timestamp;
          break;
        case 'RUN_FINISHED':
          runFinishedTs = e.timestamp;
          break;
        case 'RUN_ERROR':
          runError = { code: String(e.code ?? 'UNKNOWN'), message: String(e.message ?? '') };
          break;
      }
    }

    // Step segmentation state.
    const steps: StepAcc[] = [];
    let stepIndex = 0;
    let cur: StepAcc | null = null;
    const openStep = (ts: number): StepAcc => {
      stepIndex++;
      const ctx: StepContext = {
        stepIndex,
        stepId: `${turnId}:s${stepIndex}`,
        stepMessageId: `s${stepIndex}`,
        hasToolCalls: false,
        startTimestamp: ts,
        stepSpanId: generateSpanId(),
      };
      const s: StepAcc = { ctx, reasoning: '', text: '', toolCallParts: [], lastContentTs: ts, hasTools: false };
      steps.push(s);
      cur = s;
      return s;
    };
    // A new assistant utterance opens a fresh step only if the current step has
    // already produced tools (i.e. it was a distinct earlier decision). Consecutive
    // text/reasoning with no intervening tool stays in the same step.
    const stepForUtterance = (ts: number): StepAcc => {
      if (!cur || cur.hasTools) return openStep(ts);
      return cur;
    };
    const markTool = (s: StepAcc, startTs: number, endTs: number): void => {
      s.firstToolTs = s.firstToolTs === undefined ? startTs : Math.min(s.firstToolTs, startTs);
      s.lastToolTs = s.lastToolTs === undefined ? endTs : Math.max(s.lastToolTs, endTs);
      s.hasTools = true;
      s.ctx.hasToolCalls = true;
    };

    let toolIdx = 0;
    let toolStartCount = 0;
    const toolStartTimestamps = new Map<string, number>();
    const toolArgsAccumulator = new Map<string, string>();
    const toolNames = new Map<string, string>();
    // USAGE seen before any step opened (rare); attached to the final step later.
    let pendingUsage: { input: number; output: number; cache: number; total: number } | undefined;

    for (const evt of evs) {
      switch (evt.type) {
        case 'REASONING_START': {
          const s = stepForUtterance(evt.timestamp);
          if (!s.responseId && typeof evt.messageId === 'string') s.responseId = evt.messageId;
          break;
        }

        case 'REASONING_MESSAGE_CHUNK': {
          const s = stepForUtterance(evt.timestamp);
          if (!s.responseId && typeof evt.messageId === 'string') s.responseId = evt.messageId;
          if (typeof evt.delta === 'string') s.reasoning += evt.delta;
          else if (typeof evt.content === 'string') s.reasoning += evt.content;
          s.lastContentTs = evt.timestamp;
          break;
        }

        case 'REASONING_END': {
          const last = steps[steps.length - 1];
          if (last) last.lastContentTs = evt.timestamp;
          break;
        }

        case 'TEXT_MESSAGE_START': {
          const s = stepForUtterance(evt.timestamp);
          if (!s.responseId && typeof evt.messageId === 'string') s.responseId = evt.messageId;
          break;
        }

        case 'TEXT_MESSAGE_CONTENT': {
          const s = stepForUtterance(evt.timestamp);
          if (!s.responseId && typeof evt.messageId === 'string') s.responseId = evt.messageId;
          if (typeof evt.delta === 'string') s.text += evt.delta;
          s.lastContentTs = evt.timestamp;
          break;
        }

        case 'TEXT_MESSAGE_END': {
          const last = steps[steps.length - 1];
          if (last) last.lastContentTs = evt.timestamp;
          break;
        }

        case 'USAGE': {
          const input = numOr(evt.prompt_tokens) ?? 0;
          const output = numOr(evt.completion_tokens) ?? 0;
          const cache = numOr(evt.cached_tokens) ?? 0;
          const total = numOr(evt.total_tokens) ?? (input + output);
          const u = { input, output, cache, total };
          const last = steps[steps.length - 1];
          if (last) last.usage = u;
          else pendingUsage = u;
          break;
        }

        case 'TOOL_CALL_START': {
          const s = cur ?? openStep(evt.timestamp);
          const tcId = (evt.toolCallId as string | undefined) ?? `idx-${toolStartCount}`;
          toolStartTimestamps.set(tcId, evt.timestamp);
          const toolName = (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
          toolNames.set(tcId, toolName);
          s.toolCallParts.push({ type: 'tool_call', id: tcId, name: toolName });
          markTool(s, evt.timestamp, evt.timestamp);
          toolStartCount++;
          break;
        }

        case 'TOOL_CALL_ARGS': {
          const tcId = (evt.toolCallId as string | undefined) ?? `idx-${toolStartCount - 1}`;
          const prev = toolArgsAccumulator.get(tcId) ?? '';
          toolArgsAccumulator.set(tcId, prev + (typeof evt.delta === 'string' ? evt.delta : ''));
          break;
        }

        case 'TOOL_CALL_END': {
          const s = cur ?? openStep(evt.timestamp);
          const tcId = (evt.toolCallId as string | undefined) ?? `idx-${toolStartCount - 1}`;
          const startTs = toolStartTimestamps.get(tcId);
          const startEvtTimestamp = startTs ?? evt.timestamp;
          // Ensure tool result is at least 1ms after tool start (non-zero span duration)
          const adjustedEndTs = Math.max(evt.timestamp, startEvtTimestamp + 1);
          const duration = startTs ? adjustedEndTs - startTs : undefined;
          const toolName = toolNames.get(tcId) ?? (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
          const args = toolArgsAccumulator.get(tcId);

          const syntheticStartEvt = { ...evt, timestamp: startEvtTimestamp, toolCallId: evt.toolCallId, toolName };
          entries.push(this.buildToolCallEntry(
            task, msg, syntheticStartEvt, model, turnId, toolIdx, common,
            s.ctx, traceId, agentSpanId, args,
          ));
          toolIdx++;

          const syntheticEndEvt = { ...evt, timestamp: adjustedEndTs };
          entries.push(this.buildToolResultEntry(
            task, msg, syntheticEndEvt, model, turnId, toolIdx, common, duration,
            s.ctx, traceId, agentSpanId, toolName,
          ));
          toolIdx++;
          markTool(s, startEvtTimestamp, adjustedEndTs);
          break;
        }

        case 'TOOL_CALL_RESULT': {
          // Richer content than TOOL_CALL_END; match by toolCallId.
          const tcId = evt.toolCallId as string | undefined;
          if (!tcId) break;
          const match = findEntryByToolCallId(entries, 'tool.result', tcId);
          if (match) {
            if (evt.content !== undefined) match['gen_ai.tool.call.result'] = toJsonValue(evt.content);
            if (evt.is_error === true) match['error.type'] = match['error.type'] ?? '_OTHER';
          }
          break;
        }

        case 'ACTIVITY_SNAPSHOT': {
          const activityType = evt.activityType as string | undefined;
          if (!activityType || activityType === 'TASK_LINE_PLAN') break;
          const s = cur ?? openStep(evt.timestamp);
          const actToolName = ACTIVITY_TYPE_TO_TOOL_NAME[activityType] ?? activityType.toLowerCase();
          const actToolCallId = `activity-${msg.id}-${toolIdx}`;
          s.toolCallParts.push({ type: 'tool_call', id: actToolCallId, name: actToolName });
          const content = evt.content as Record<string, unknown> | undefined;
          const actStartTs = numOr(content?.start_time) ?? evt.timestamp;
          const actEndTs = numOr(content?.finish_time) ?? evt.timestamp;
          const activityEntries = this.transformActivitySnapshot(
            task, msg, evt, model, turnId, toolIdx, common,
            s.ctx, traceId, agentSpanId,
          );
          entries.push(...activityEntries);
          toolIdx += 2; // tool.call + tool.result
          markTool(s, actStartTs, actEndTs);
          break;
        }
      }
    }

    // Guarantee at least one step (e.g. RUN_ERROR-only or content-less run).
    if (steps.length === 0) openStep(runStartedTs ?? msg.createdAt);

    const finalIdx = steps.length - 1;
    // A USAGE seen before any step opened is attributed to the final step.
    if (pendingUsage && !steps[finalIdx].usage) steps[finalIdx].usage = pendingUsage;

    // `other` — the user prompt begins the turn. Not a span; merged into ENTRY input.
    if (userContent) {
      const otherTs = userPromptTs ?? ((runStartedTs ?? msg.createdAt) - 1);
      entries.push(buildAgentActivityEntry({
        timestamp: otherTs,
        'event.id': hashId([sessionId, msg.id, 'other']),
        'event.name': 'other',
        ...common,
        'gen_ai.turn.id': turnId,
        'trace_id': traceId,
        'gen_ai.input.messages_delta': [
          { role: 'user', parts: [{ type: 'text', content: userContent }] },
        ],
      }));
    }

    // Emit one llm.request + llm.response per step. Timing is computed sequentially
    // so requests precede responses precede the step's tools, and steps ascend.
    let cursorTs = runStartedTs ?? steps[0].ctx.startTimestamp;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const isFinal = i === finalIdx;

      const reqTs = i === 0
        ? (runStartedTs ?? s.ctx.startTimestamp)
        : Math.max(s.ctx.startTimestamp, cursorTs + 1);
      let respTs: number;
      if (s.hasTools && s.firstToolTs !== undefined) {
        respTs = Math.max(reqTs + 1, s.firstToolTs - 1);
      } else if (isFinal) {
        respTs = Math.max(reqTs + 1, runFinishedTs ?? s.lastContentTs);
      } else {
        respTs = Math.max(reqTs + 1, s.lastContentTs);
      }
      cursorTs = Math.max(respTs, s.lastToolTs ?? respTs);

      const finishReasons = this.inferFinishReasons(s.hasTools, isFinal ? runError : undefined);
      const llmSpanId = generateSpanId();
      const includeUserContent = i === 0 && !!userContent;
      // Unique per-LLM-call response id. runId is shared across the whole run, so
      // reusing it would collapse distinct steps in the converter; prefer the
      // utterance messageId, fall back to a deterministic per-step id.
      const responseId = s.responseId ?? (runId ? `${runId}:s${s.ctx.stepIndex}` : `${s.ctx.stepId}:r`);

      entries.push(buildAgentActivityEntry({
        timestamp: reqTs,
        'event.id': hashId([sessionId, msg.id, 'request', String(s.ctx.stepIndex)]),
        'event.name': 'llm.request',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': s.ctx.stepId,
        'gen_ai.request.model': model,
        'gen_ai.response.id': responseId,
        'trace_id': traceId,
        ...(includeUserContent ? {
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
      }));

      // Output parts: reasoning + text merged into ONE message (spec §4.2),
      // followed by tool_call declarations for the tools this step triggered.
      const outputParts: Array<Record<string, string>> = [];
      if (s.reasoning) outputParts.push({ type: 'reasoning', content: s.reasoning });
      if (s.text) outputParts.push({ type: 'text', content: s.text });
      for (const tc of s.toolCallParts) outputParts.push({ type: tc.type, id: tc.id, name: tc.name });
      if (outputParts.length === 0 && runError && isFinal) {
        outputParts.push({ type: 'text', content: `[error] ${runError.code}: ${runError.message}` });
      }

      // Each step carries the tokens from the USAGE event that landed on it
      // (0 if none). The run's aggregate USAGE naturally lands on the final step,
      // so the AGENT-level sum equals the real reported usage (spec §3.4).
      const u = s.usage ?? { input: 0, output: 0, cache: 0, total: 0 };
      const tokIn = u.input;
      const tokOut = u.output;
      const tokCache = u.cache;
      const tokTotal = u.total;

      entries.push(buildAgentActivityEntry({
        timestamp: respTs,
        'event.id': hashId([sessionId, msg.id, 'response', String(s.ctx.stepIndex)]),
        'event.name': 'llm.response',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': s.ctx.stepId,
        'gen_ai.response.id': responseId,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': finishReasons,
        'trace_id': traceId,
        'span_id': llmSpanId,
        'parent_span_id': s.ctx.stepSpanId,
        ...(includeUserContent ? {
          'gen_ai.input.messages': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        ...(outputParts.length > 0 ? {
          'gen_ai.output.messages': [{ role: 'assistant', parts: outputParts }],
        } : {}),
        'gen_ai.usage.input_tokens': tokIn,
        'gen_ai.usage.output_tokens': tokOut,
        'gen_ai.usage.cache_read.input_tokens': tokCache,
        'gen_ai.usage.total_tokens': tokTotal,
        ...(runError && isFinal ? { 'error.type': runError.code, 'error.message': runError.message } : {}),
      }));
    }

    // Make messages_delta incremental: for each step N>=2, prepend the tool_call
    // responses produced by step N-1 to that step's llm.request.
    injectPriorStepToolResults(entries);

    // Sort chronologically so the emitted stream reads other → llm.request →
    // llm.response → tool.call → tool.result → … (spec §8), independent of push order.
    entries.sort((a, b) => {
      const ta = BigInt(String(a['time_unix_nano'] ?? '0'));
      const tb = BigInt(String(b['time_unix_nano'] ?? '0'));
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

    return entries;
  }

  private inferFinishReasons(
    hasToolCalls: boolean,
    runError: { code: string; message: string } | undefined,
  ): string[] {
    if (runError) return ['stop'];
    if (hasToolCalls) return ['tool_calls'];
    return ['end_turn'];
  }

  private buildToolCallEntry(
    task: ValidWukongTask,
    msg: WukongMessage,
    evt: AguiEvent,
    model: string,
    turnId: string,
    toolIdx: number,
    common: Record<string, unknown>,
    step: StepContext | null,
    traceId: string,
    agentSpanId: string,
    args: string | undefined,
  ): AgentActivityEntry {
    const toolCallId = (evt.toolCallId as string | undefined) ?? '';
    const toolName = (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
    const toolSpanId = generateSpanId();

    let parsedArgs: unknown | undefined;
    if (args) {
      try { parsedArgs = JSON.parse(args); } catch { parsedArgs = args; }
    }

    return buildAgentActivityEntry({
      timestamp: evt.timestamp || msg.createdAt,
      'event.id': hashId([task.session_id, msg.id, 'tool_call', toolCallId, String(toolIdx)]),
      'event.name': 'tool.call',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': step?.stepId,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': toolCallId,
      ...(parsedArgs !== undefined ? { 'gen_ai.tool.call.arguments': toJsonValue(parsedArgs) } : {}),
      'trace_id': traceId,
      'span_id': toolSpanId,
      'parent_span_id': step?.stepSpanId ?? agentSpanId,
    });
  }

  private buildToolResultEntry(
    task: ValidWukongTask,
    msg: WukongMessage,
    evt: AguiEvent,
    model: string,
    turnId: string,
    toolIdx: number,
    common: Record<string, unknown>,
    duration: number | undefined,
    step: StepContext | null,
    traceId: string,
    agentSpanId: string,
    toolName?: string,
  ): AgentActivityEntry {
    const toolCallId = (evt.toolCallId as string | undefined) ?? '';
    const resolvedToolName = toolName ?? (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
    const result = evt.result ?? evt.output;
    const hasError = Boolean(evt.error || evt.isError);
    const toolSpanId = generateSpanId();

    return buildAgentActivityEntry({
      timestamp: evt.timestamp || msg.createdAt,
      'event.id': hashId([task.session_id, msg.id, 'tool_result', toolCallId, String(toolIdx)]),
      'event.name': 'tool.result',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': step?.stepId,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': resolvedToolName,
      'gen_ai.tool.call.id': toolCallId,
      ...(result !== undefined ? { 'gen_ai.tool.call.result': toJsonValue(result) } : {}),
      ...(duration !== undefined ? { 'gen_ai.tool.call.duration': duration } : {}),
      'tool.result.status': hasError ? 'failure' : 'success',
      ...(hasError && evt.error ? { 'error.type': String(evt.error) } : {}),
      'trace_id': traceId,
      'span_id': toolSpanId,
      'parent_span_id': step?.stepSpanId ?? agentSpanId,
    });
  }

  private transformActivitySnapshot(
    task: ValidWukongTask,
    msg: WukongMessage,
    evt: AguiEvent,
    model: string,
    turnId: string,
    toolIdx: number,
    common: Record<string, unknown>,
    step: StepContext | null,
    traceId: string,
    agentSpanId: string,
  ): AgentActivityEntry[] {
    const activityType = evt.activityType as string;
    const toolName = ACTIVITY_TYPE_TO_TOOL_NAME[activityType] ?? activityType.toLowerCase();
    const content = evt.content as Record<string, unknown> | undefined;

    const startTime = numOr(content?.start_time) ?? evt.timestamp;
    const rawFinishTime = numOr(content?.finish_time) ?? evt.timestamp;
    // Ensure tool span has non-zero duration (start != end)
    const finishTime = rawFinishTime > startTime ? rawFinishTime : startTime + 1;
    const duration = finishTime > startTime ? finishTime - startTime : undefined;

    const toolCallId = `activity-${msg.id}-${toolIdx}`;

    // Extract arguments based on activity type
    let args: unknown | undefined;
    let result: unknown | undefined;

    if (content) {
      switch (activityType) {
        case 'TERMINAL':
          args = content.command ? { command: content.command } : undefined;
          result = { output: content.output, exit_code: content.exit_code };
          break;
        case 'FILE_WRITE':
          args = content.path ? { path: content.path } : undefined;
          result = { status: content.status ?? 'done' };
          break;
        case 'GREP_SEARCH':
          args = content.query ? { query: content.query } : undefined;
          result = content.matches ?? content.output;
          break;
        case 'DIRECTORY_LIST':
          args = content.path ? { path: content.path } : undefined;
          result = content.entries ?? content.output;
          break;
        default:
          args = content.input ?? undefined;
          result = content.output ?? content.result ?? undefined;
          break;
      }
    }

    const callSpanId = generateSpanId();
    const resultSpanId = generateSpanId();
    const parentSpanId = step?.stepSpanId ?? agentSpanId;

    const toolCallEntry = buildAgentActivityEntry({
      timestamp: startTime,
      'event.id': hashId([task.session_id, msg.id, 'activity_call', toolCallId, String(toolIdx)]),
      'event.name': 'tool.call',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': step?.stepId,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': toolCallId,
      ...(args !== undefined ? { 'gen_ai.tool.call.arguments': toJsonValue(args) } : {}),
      'trace_id': traceId,
      'span_id': callSpanId,
      'parent_span_id': parentSpanId,
    });

    const hasError = content?.exit_code !== undefined && content.exit_code !== 0;
    const toolResultEntry = buildAgentActivityEntry({
      timestamp: finishTime,
      'event.id': hashId([task.session_id, msg.id, 'activity_result', toolCallId, String(toolIdx + 1)]),
      'event.name': 'tool.result',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': step?.stepId,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': toolCallId,
      ...(result !== undefined ? { 'gen_ai.tool.call.result': toJsonValue(result) } : {}),
      ...(duration !== undefined ? { 'gen_ai.tool.call.duration': duration } : {}),
      'tool.result.status': hasError ? 'failure' : 'success',
      'trace_id': traceId,
      'span_id': resultSpanId,
      'parent_span_id': parentSpanId,
    });

    return [toolCallEntry, toolResultEntry];
  }

  private async listAllTasks(): Promise<Array<WukongTask & { session_id: string }>> {
    const allTasks: Array<WukongTask & { session_id: string }> = [];
    let cursor: string | undefined;
    let hasMore = false;
    do {
      const params: Record<string, unknown> = { limit: TASK_BATCH_LIMIT };
      if (cursor) params.cursor = cursor;
      const { stdout, stderr } = await execFile(
        this.cliPath,
        ['agent', 'data', 'list_tasks', '--json', JSON.stringify(params)],
        { timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER, signal: this._abortController.signal },
      );
      if (!stdout || !/\S/.test(stdout)) {
        this.logger.debug('wukong-cli list_tasks returned empty stdout', {
          stderr: (stderr ?? '').slice(0, 256),
        });
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        throw new Error(`wukong-cli list_tasks returned non-JSON (stderr=${(stderr ?? '').slice(0, 256)}, head=${stdout.slice(0, 256)}): ${e}`);
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
        throw new Error('unexpected listTasks response structure');
      }
      const resp = parsed as ListTasksResponse;
      for (const item of resp.items) {
        if (item.session_id != null) allTasks.push(item as WukongTask & { session_id: string });
      }
      cursor = resp.hasMore ? resp.nextCursor : undefined;
      hasMore = !!resp.hasMore;
    } while (cursor && allTasks.length < MAX_TASKS);
    if (cursor && hasMore) {
      this.logger.warn('wukong task pagination truncated by MAX_TASKS', {
        limit: MAX_TASKS,
        fetched: allTasks.length,
      });
    }
    return allTasks;
  }

  private async getMessages(conversationId: string): Promise<GetMessagesResponse> {
    const { stdout, stderr } = await execFile(
      this.cliPath,
      ['agent', 'data', 'get_spark_agui_messages', '--json', JSON.stringify({ conversationId })],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER, signal: this._abortController.signal },
    );
    if (!stdout || !/\S/.test(stdout)) {
      const stderrSnippet = (stderr ?? '').slice(0, 256);
      const logLevel = stderrSnippet ? 'warn' : 'debug';
      this.logger[logLevel]('wukong-cli get_spark_agui_messages returned empty stdout, treating as no messages', {
        conversationId,
        stderr: stderrSnippet,
      });
      return { messages: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`wukong-cli get_spark_agui_messages returned non-JSON (stderr=${(stderr ?? '').slice(0, 256)}, head=${stdout.slice(0, 256)}): ${e}`);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { messages?: unknown }).messages)) {
      throw new Error('unexpected getMessages response structure');
    }
    return parsed as GetMessagesResponse;
  }
}

function hashId(parts: Array<string | number | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map(p => p ?? '').join('\0'))
    .digest('hex');
}

function numOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveTurnId(sessionId: string, msg: WukongMessage): string {
  if (msg.turnIndex >= 0) return `${sessionId}:t${msg.turnIndex}`;
  return `${sessionId}:${msg.id}`;
}

function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// Iterative min to avoid spread-arg call stack limits on large arrays.
function minOf(arr: ReadonlyArray<number>): number {
  let m = Number.POSITIVE_INFINITY;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < m) m = v;
  }
  return m;
}

/**
 * A message is safe to emit only when it has fully settled. This prevents
 * capturing a mid-stream snapshot (truncated answer / 0 tokens) and then
 * advancing the cursor past it. Settled means:
 *   - isComplete flag (when present) is 1, AND
 *   - a terminal RUN_FINISHED (or RUN_ERROR) is present, AND
 *   - a USAGE event is present (RUN_ERROR turns may legitimately lack one), AND
 *   - the last TEXT_MESSAGE_START is closed by a TEXT_MESSAGE_END.
 */
function isMessageComplete(msg: WukongMessage): boolean {
  if (msg.role !== 'assistant') return true;
  const events = msg.events;
  if (!events || events.length === 0) return true;

  // Explicit flag from the API takes precedence when present.
  if (msg.isComplete !== undefined && msg.isComplete !== 1) return false;

  const hasRunError = events.some(e => e.type === 'RUN_ERROR');
  if (hasRunError) return true; // error is a terminal state; tolerate missing USAGE/text

  const hasRunFinished = events.some(e => e.type === 'RUN_FINISHED');
  if (!hasRunFinished) return false;

  const hasUsage = events.some(e => e.type === 'USAGE');
  if (!hasUsage) return false;

  // The last opened text message must be closed (not still streaming).
  let lastTextStart = -1;
  let lastTextEnd = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'TEXT_MESSAGE_START') lastTextStart = i;
    else if (events[i].type === 'TEXT_MESSAGE_END') lastTextEnd = i;
  }
  if (lastTextStart >= 0 && lastTextEnd < lastTextStart) return false;

  return true;
}

function findLastCompleteIndex(messages: WukongMessage[]): number {
  // First find the last index where all messages 0..i are complete (no streaming)
  let lastComplete = messages.length - 1;
  for (let i = 0; i < messages.length; i++) {
    if (!isMessageComplete(messages[i])) {
      lastComplete = i - 1;
      break;
    }
  }
  // Then trim trailing user messages that don't have a paired assistant.
  // These would create orphan ENTRY/AGENT spans with no LLM children.
  while (lastComplete >= 0 && messages[lastComplete].role === 'user') {
    lastComplete--;
  }
  return lastComplete;
}

function findEntryByToolCallId(
  entries: AgentActivityEntry[],
  eventName: string,
  toolCallId: string,
): AgentActivityEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (
      entries[i]['event.name'] === eventName &&
      entries[i]['gen_ai.tool.call.id'] === toolCallId
    ) {
      return entries[i];
    }
  }
  return undefined;
}

/**
 * Prepend, to each step N>=2's llm.request, the tool_call_response messages
 * produced by step N-1. Keeps gen_ai.input.messages_delta truly incremental:
 * step 1 = user input, step 2+ = prior tool results.
 */
function injectPriorStepToolResults(entries: AgentActivityEntry[]): void {
  const toolResultsByStep = new Map<string, Array<{ id: string; name: string; result: unknown }>>();
  for (const entry of entries) {
    if (entry['event.name'] !== 'tool.result') continue;
    const sid = entry['gen_ai.step.id'];
    if (typeof sid !== 'string' || !sid) continue;
    const arr = toolResultsByStep.get(sid) ?? [];
    arr.push({
      id: String(entry['gen_ai.tool.call.id'] ?? ''),
      name: String(entry['gen_ai.tool.name'] ?? ''),
      result: entry['gen_ai.tool.call.result'],
    });
    toolResultsByStep.set(sid, arr);
  }

  const stepIds = Array.from(new Set(entries
    .map(e => e['gen_ai.step.id'])
    .filter((s): s is string => typeof s === 'string' && !!s)
  )).sort((a, b) => {
    const na = parseInt(a.match(/:s(\d+)$/)?.[1] ?? '0', 10);
    const nb = parseInt(b.match(/:s(\d+)$/)?.[1] ?? '0', 10);
    return na - nb;
  });

  for (let i = 1; i < stepIds.length; i++) {
    const prevStepId = stepIds[i - 1];
    const curStepId = stepIds[i];
    const priorTools = toolResultsByStep.get(prevStepId) ?? [];
    if (priorTools.length === 0) continue;
    const toolResponseMessages = priorTools.map(t => ({
      role: 'tool',
      parts: [{
        type: 'tool_call_response',
        id: t.id,
        response: typeof t.result === 'string' ? t.result : JSON.stringify(t.result ?? ''),
      }],
    }));
    for (const entry of entries) {
      if (entry['event.name'] !== 'llm.request') continue;
      if (entry['gen_ai.step.id'] !== curStepId) continue;
      const existing = entry['gen_ai.input.messages_delta'];
      const existingArr = Array.isArray(existing) ? existing : [];
      entry['gen_ai.input.messages_delta'] = toJsonValue([...toolResponseMessages, ...existingArr]);
      break;
    }
  }
}
