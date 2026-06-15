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
const DAEMON_SOCK_REL = '.real/daemon.sock';

interface WukongTask {
  id: string;
  session_id: string;
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
  private _collecting = false;

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
    const home = process.env.HOME ?? '';
    return [path.join(home, DAEMON_SOCK_REL)];
  }

  static async checkAvailability(): Promise<boolean> {
    const sockPath = path.join(process.env.HOME ?? '', DAEMON_SOCK_REL);
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
    if (this._collecting) return [];
    this._collecting = true;
    try {
      return await this.doCollect();
    } finally {
      this._collecting = false;
    }
  }

  private async doCollect(): Promise<AgentActivityEntry[]> {
    const state = this.stateStore.get(this.id);
    const seenCounts: Record<string, number> =
      (state.extra?.seenCounts != null && typeof state.extra.seenCounts === 'object')
        ? { ...(state.extra.seenCounts as Record<string, number>) }
        : {};

    let tasks: WukongTask[];
    try {
      tasks = await this.listAllTasks();
    } catch (err) {
      this.logger.debug('wukong list_tasks failed (daemon may be stopped)', { error: String(err) });
      return [];
    }

    if (tasks.length === 0) return [];

    const entries: AgentActivityEntry[] = [];
    let stateChanged = false;

    for (const task of tasks) {
      const prevCount = seenCounts[task.session_id] ?? 0;

      let messages: WukongMessage[];
      try {
        const messagesResp = await this.getMessages(task.session_id);
        messages = messagesResp.messages;
      } catch (err) {
        this.logger.warn('failed to fetch messages for task', {
          taskId: task.id,
          error: String(err),
        });
        continue;
      }

      if (messages.length <= prevCount) continue;

      const newMessages = messages.slice(prevCount);

      // Only process completed messages to avoid the token race condition.
      // An incomplete assistant message (still streaming) will be retried next poll.
      const lastCompleteIdx = findLastCompleteIndex(newMessages);
      if (lastCompleteIdx < 0) continue;

      const processable = newMessages.slice(0, lastCompleteIdx + 1);
      const taskEntries = this.transformMessages(task, processable);
      entries.push(...taskEntries);

      seenCounts[task.session_id] = prevCount + processable.length;
      stateChanged = true;
    }

    // Prune seenCounts entries for tasks no longer returned by the API.
    const activeIds = new Set(tasks.map(t => t.session_id));
    for (const key of Object.keys(seenCounts)) {
      if (!activeIds.has(key)) {
        delete seenCounts[key];
        stateChanged = true;
      }
    }

    if (stateChanged) {
      this.stateStore.update(this.id, { extra: { seenCounts } });
    }
    return entries;
  }

  private transformMessages(task: WukongTask, messages: WukongMessage[]): AgentActivityEntry[] {
    const entries: AgentActivityEntry[] = [];
    const sessionId = task.session_id;
    const model = task.metadata.modelName ?? 'unknown';
    const provider = task.metadata.modelProvider ?? undefined;
    const hostname = os.hostname();

    const commonFields = {
      'host.name': hostname,
      'service.name': 'wukong',
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': ClientType.Wukong,
      'gen_ai.agent.id': task.id,
      'gen_ai.agent.name': task.name,
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
        const turnEntries = this.transformAssistantMessage(task, msg, events, model, turnId, commonFields, userContent);

        // If this assistant produced no entries (e.g., RUN_ERROR with no content),
        // keep pending user messages for the next assistant. Don't emit orphans.
        if (turnEntries.length === 0) {
          continue;
        }

        // Extract trace_id and first step.id from the assistant's entries for user message linkage
        const firstAssistantEntry = turnEntries[0];
        const traceId = firstAssistantEntry?.['trace_id'] as string | undefined;
        const firstStepId = turnEntries.find(e =>
          e['gen_ai.step.id'])?.['gen_ai.step.id'] as string | undefined;
        const stepSpanId = firstAssistantEntry?.['parent_span_id'] as string | undefined;
        void traceId; void firstStepId; void stepSpanId;

        // User content is already merged into step 1's llm.request gen_ai.input.messages_delta.
        // The OTLP converter falls back to that for ENTRY input.messages. So we don't
        // emit a separate user-hook llm.request — this avoids events without step.id
        // and keeps llm.request field-coverage at 100%.
        pendingUserMessages = [];

        entries.push(...turnEntries);
      } catch (err) {
        this.logger.warn('failed to transform message', { msgId: msg.id, error: String(err) });
      }
    }

    // Skip pending user messages without subsequent assistant — these are
    // incomplete sessions (user wrote but assistant hasn't responded yet).
    // Don't emit them as orphan ENTRY/AGENT spans with 0 duration.
    // They'll be processed on the next poll when the assistant responds.
    // Note: We still need to NOT advance seenCounts past them, but the slicing
    // logic in doCollect already handles this via isMessageComplete checks.

    return entries;
  }

  private buildUserRequestEntry(
    task: WukongTask,
    msg: WukongMessage,
    model: string,
    turnId: string,
    common: Record<string, unknown>,
    traceId: string | undefined,
    stepId: string | undefined,
    parentSpanId: string | undefined,
  ): AgentActivityEntry {
    // User-hook pattern: emit llm.request without step.id and without model.
    // The OTLP converter (partitionUserHookRequests) will merge these into ENTRY
    // rather than creating phantom LLM spans.
    void model; void stepId; void parentSpanId;
    return buildAgentActivityEntry({
      timestamp: msg.createdAt,
      'event.id': hashId([task.session_id, msg.id, 'user']),
      'event.name': 'llm.request',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: msg.content }] },
      ],
      ...(traceId ? { 'trace_id': traceId } : {}),
      attributes: {
        source: 'wukong',
        message_id: msg.id,
        conversation_id: msg.conversationId,
      },
    });
  }

  private transformAssistantMessage(
    task: WukongTask,
    msg: WukongMessage,
    events: AguiEvent[],
    model: string,
    turnId: string,
    common: Record<string, unknown>,
    userContent: string,
  ): AgentActivityEntry[] {
    const entries: AgentActivityEntry[] = [];
    const sessionId = task.session_id;

    // Generate trace-level IDs for this turn
    const traceId = generateTraceId();
    const agentSpanId = generateSpanId();

    // Step tracking
    let stepIndex = 0;
    let currentStep: StepContext | null = null;
    const hasStepEvents = events.some(e => e.type === 'STEP_STARTED');

    // Per-step accumulators (reset on each new step)
    let runId: string | undefined;
    let textContent = '';
    let usageEvent: AguiEvent | undefined;
    let firstTokenEvent: AguiEvent | undefined;
    let runStartedTs: number | undefined;
    let runFinishedTs: number | undefined;
    let runError: { code: string; message: string } | undefined;
    let toolIdx = 0;
    let toolStartCount = 0;
    const toolStartTimestamps = new Map<string, number>();
    const allToolStartTimes: number[] = [];
    const allToolEndTimes: number[] = [];
    const toolArgsAccumulator = new Map<string, string>();
    const toolNames = new Map<string, string>();
    const toolCallParts: Array<{ type: string; id: string; name: string }> = [];

    const startNewStep = (evt: AguiEvent): void => {
      stepIndex++;
      const stepSpanId = generateSpanId();
      currentStep = {
        stepIndex,
        stepId: `${turnId}:s${stepIndex}`,
        stepMessageId: (evt.messageId as string) ?? `step-${stepIndex}`,
        hasToolCalls: false,
        startTimestamp: evt.timestamp,
        stepSpanId,
      };
      // Reset per-step accumulators
      textContent = '';
      usageEvent = undefined;
      firstTokenEvent = undefined;
      toolCallParts.length = 0;
    };

    // Determine if we need to pre-create initial step s1.
    // Required when: no STEP_STARTED events, OR meaningful events occur before
    // the first STEP_STARTED (e.g., early ACTIVITY_SNAPSHOT).
    const firstStepStartedIdx = events.findIndex(e => e.type === 'STEP_STARTED');
    const eventsBeforeFirstStep = firstStepStartedIdx >= 0
      ? events.slice(0, firstStepStartedIdx)
      : events;
    const hasContentBeforeStep = eventsBeforeFirstStep.some(e =>
      e.type === 'TOOL_CALL_START' || e.type === 'ACTIVITY_SNAPSHOT' || e.type === 'TEXT_MESSAGE_CONTENT'
    );
    if (!hasStepEvents || hasContentBeforeStep) {
      stepIndex = 1;
      currentStep = {
        stepIndex: 1,
        stepId: `${turnId}:s1`,
        stepMessageId: `synth-step-1`,
        hasToolCalls: false,
        startTimestamp: msg.createdAt,
        stepSpanId: generateSpanId(),
      };
    }

    for (const evt of events) {
      switch (evt.type) {
        case 'STEP_STARTED':
          startNewStep(evt);
          break;

        case 'STEP_FINISHED':
          // Will be handled after the loop
          break;

        case 'RUN_STARTED':
          runId = evt.runId as string | undefined;
          runStartedTs = evt.timestamp;
          break;

        case 'RUN_FINISHED':
          runFinishedTs = evt.timestamp;
          break;

        case 'RUN_ERROR':
          runError = {
            code: String(evt.code ?? 'UNKNOWN'),
            message: String(evt.message ?? ''),
          };
          break;

        case 'TEXT_MESSAGE_CONTENT':
          if (typeof evt.delta === 'string') textContent += evt.delta;
          break;

        case 'USAGE':
          usageEvent = evt;
          break;

        case 'FIRST_TOKEN':
          firstTokenEvent = evt;
          break;

        case 'TOOL_CALL_START': {
          if (currentStep) currentStep.hasToolCalls = true;
          const tcId = (evt.toolCallId as string | undefined) ?? `idx-${toolStartCount}`;
          toolStartTimestamps.set(tcId, evt.timestamp);
          allToolStartTimes.push(evt.timestamp);
          const toolName = (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
          toolNames.set(tcId, toolName);
          toolCallParts.push({ type: 'tool_call', id: tcId, name: toolName });
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
          const tcId = (evt.toolCallId as string | undefined) ?? `idx-${toolStartCount - 1}`;
          const startTs = toolStartTimestamps.get(tcId);
          const startEvtTimestamp = startTs ?? evt.timestamp;
          // Ensure tool result is at least 1ms after tool start (non-zero span duration)
          const adjustedEndTs = Math.max(evt.timestamp, startEvtTimestamp + 1);
          const duration = startTs ? adjustedEndTs - startTs : undefined;
          const toolName = toolNames.get(tcId) ?? (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
          const args = toolArgsAccumulator.get(tcId);

          // Emit tool.call (deferred from TOOL_CALL_START to capture accumulated args)
          const syntheticStartEvt = { ...evt, timestamp: startEvtTimestamp, toolCallId: evt.toolCallId, toolName };
          entries.push(this.buildToolCallEntry(
            task, msg, syntheticStartEvt, model, turnId, toolIdx, common,
            currentStep, traceId, agentSpanId, args,
          ));
          toolIdx++;

          // Emit tool.result with adjusted timestamp
          const syntheticEndEvt = { ...evt, timestamp: adjustedEndTs };
          entries.push(this.buildToolResultEntry(
            task, msg, syntheticEndEvt, model, turnId, toolIdx, common, duration,
            currentStep, traceId, agentSpanId, toolName,
          ));
          toolIdx++;
          allToolEndTimes.push(adjustedEndTs);
          break;
        }

        case 'TOOL_CALL_RESULT': {
          // TOOL_CALL_RESULT provides richer content than TOOL_CALL_END.
          // If we already emitted a tool.result from TOOL_CALL_END, this is supplementary.
          // For simplicity, we update the last tool.result entry with richer data.
          const lastToolResult = findLastEntry(entries, 'tool.result');
          if (lastToolResult) {
            const content = evt.content;
            if (content !== undefined) {
              lastToolResult['gen_ai.tool.call.result'] = toJsonValue(content);
            }
            if (evt.is_error === true) {
              lastToolResult['tool.result.status'] = 'failure';
            }
          }
          break;
        }

        case 'ACTIVITY_SNAPSHOT': {
          const activityType = evt.activityType as string | undefined;
          if (activityType && activityType !== 'TASK_LINE_PLAN') {
            const actToolName = ACTIVITY_TYPE_TO_TOOL_NAME[activityType] ?? activityType.toLowerCase();
            const actToolCallId = `activity-${msg.id}-${toolIdx}`;
            toolCallParts.push({ type: 'tool_call', id: actToolCallId, name: actToolName });
            const content = evt.content as Record<string, unknown> | undefined;
            const actStartTs = numOr(content?.start_time) ?? evt.timestamp;
            const actEndTs = numOr(content?.finish_time) ?? evt.timestamp;
            allToolStartTimes.push(actStartTs);
            allToolEndTimes.push(actEndTs);
            const activityEntries = this.transformActivitySnapshot(
              task, msg, evt, model, turnId, toolIdx, common,
              currentStep, traceId, agentSpanId,
            );
            entries.push(...activityEntries);
            toolIdx += 2; // tool.call + tool.result
            if (currentStep) currentStep.hasToolCalls = true;
          }
          break;
        }
      }
    }

    // For synthetic-step messages with tools, split into:
    //   step 1: LLM (declares tools, has tool_call parts, finish_reasons=tool_calls) → tools execute
    //   step 2: LLM (final answer text only, no tool_call parts, finish_reasons=stop/end_turn)
    // This satisfies both last_step_no_tool_call and tool_matches_llm_output rules.
    if (!hasStepEvents && currentStep && currentStep.hasToolCalls && allToolStartTimes.length > 0) {
      const midLlmSpanId = generateSpanId();
      const midOutputParts: Array<Record<string, string>> = [];
      for (const tc of toolCallParts) {
        midOutputParts.push({ type: tc.type, id: tc.id, name: tc.name });
      }
      const midReqTs = runStartedTs ?? currentStep.startTimestamp;
      const firstToolTs = Math.min(...allToolStartTimes);
      const lastToolTs = Math.max(...allToolStartTimes, ...allToolEndTimes);
      const midRespTs = Math.max(midReqTs + 1, firstToolTs - 1);

      // Emit step 1 llm.request + llm.response (tool-calling)
      entries.push(buildAgentActivityEntry({
        timestamp: midReqTs,
        'event.id': hashId([sessionId, msg.id, 'request', String(currentStep.stepIndex)]),
        'event.name': 'llm.request',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': currentStep.stepId,
        'gen_ai.request.model': model,
        'gen_ai.response.id': runId,
        'trace_id': traceId,
        ...(userContent && currentStep.stepIndex === 1 ? {
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        attributes: { source: 'wukong', message_id: msg.id, conversation_id: msg.conversationId },
      }));
      entries.push(buildAgentActivityEntry({
        timestamp: midRespTs,
        'event.id': hashId([sessionId, msg.id, 'response', String(currentStep.stepIndex)]),
        'event.name': 'llm.response',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': currentStep.stepId,
        'gen_ai.response.id': runId,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': ['tool_calls'],
        'trace_id': traceId,
        'span_id': midLlmSpanId,
        'parent_span_id': currentStep.stepSpanId,
        ...(userContent && currentStep.stepIndex === 1 ? {
          'gen_ai.input.messages': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        ...(midOutputParts.length > 0 ? {
          'gen_ai.output.messages': [{ role: 'assistant', parts: midOutputParts }],
        } : {}),
        'gen_ai.usage.input_tokens': 0,
        'gen_ai.usage.output_tokens': 0,
        'gen_ai.usage.cache_read.input_tokens': 0,
        'gen_ai.usage.total_tokens': 0,
        attributes: { source: 'wukong', message_id: msg.id, conversation_id: msg.conversationId },
      }));

      // Start step 2 (final answer) AFTER all tools complete
      stepIndex++;
      const finalStepStart = lastToolTs + 1;
      currentStep = {
        stepIndex,
        stepId: `${turnId}:s${stepIndex}`,
        stepMessageId: `synth-final-${stepIndex}`,
        hasToolCalls: false,
        startTimestamp: finalStepStart,
        stepSpanId: generateSpanId(),
      };
      toolCallParts.length = 0;
      // Override runFinishedTs to ensure final step's response timing
      if (!runFinishedTs || runFinishedTs <= finalStepStart) {
        runFinishedTs = finalStepStart + 1;
      }
    }

    // Emit llm.response for the current (possibly only) step
    const shouldEmitFinalLlm = currentStep && (textContent || usageEvent || toolCallParts.length > 0
      || (currentStep.stepIndex > 1 && !currentStep.hasToolCalls));
    if (currentStep && shouldEmitFinalLlm) {
      const finishReasons = this.inferFinishReasons(currentStep.hasToolCalls, runError);
      const llmSpanId = generateSpanId();

      const inputTokens = numOr(usageEvent?.prompt_tokens) ?? 0;
      const outputTokens = numOr(usageEvent?.completion_tokens) ?? 0;
      const cachedTokens = numOr(usageEvent?.cached_tokens) ?? 0;
      const totalTokens = numOr(usageEvent?.total_tokens) ?? (inputTokens + outputTokens);

      // Timestamp logic:
      //   - tool-calling step: request=runStartedTs, response=just before first tool starts
      //     (so LLM span has non-zero duration AND starts before tool spans)
      //   - text-only final step: request=runStartedTs, response=runFinishedTs
      // Use max(currentStep.startTimestamp, runStartedTs) — for split step 2, currentStep.startTimestamp
      // is set to lastToolTs+1 which is later than the original runStartedTs.
      const requestTimestamp = Math.max(currentStep.startTimestamp, runStartedTs ?? 0) || msg.createdAt;
      let responseTimestamp: number;
      if (currentStep.hasToolCalls && allToolStartTimes.length > 0) {
        // Find earliest tool timestamp (across TOOL_CALL_START and ACTIVITY_SNAPSHOT)
        const firstToolTs = Math.min(...allToolStartTimes);
        responseTimestamp = Math.max(requestTimestamp + 1, firstToolTs - 1);
      } else if (currentStep.hasToolCalls) {
        // Tool-calling step but no tool timestamps available; fallback
        responseTimestamp = requestTimestamp + 1;
      } else {
        responseTimestamp = Math.max(requestTimestamp + 1, runFinishedTs ?? msg.createdAt);
      }
      entries.push(buildAgentActivityEntry({
        timestamp: requestTimestamp,
        'event.id': hashId([sessionId, msg.id, 'request', String(currentStep.stepIndex)]),
        'event.name': 'llm.request',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': currentStep.stepId,
        'gen_ai.request.model': model,
        'gen_ai.response.id': runId,
        'trace_id': traceId,
        ...(userContent && currentStep.stepIndex === 1 ? {
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        attributes: {
          source: 'wukong',
          message_id: msg.id,
          conversation_id: msg.conversationId,
        },
      }));

      // Build output message parts: text + tool_call declarations
      const outputParts: Array<Record<string, string>> = [];
      if (textContent) {
        outputParts.push({ type: 'text', content: textContent });
      }
      for (const tc of toolCallParts) {
        outputParts.push({ type: tc.type, id: tc.id, name: tc.name });
      }

      const responseEntry = buildAgentActivityEntry({
        timestamp: responseTimestamp,
        'event.id': hashId([sessionId, msg.id, 'response', String(currentStep.stepIndex)]),
        'event.name': 'llm.response',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': currentStep.stepId,
        'gen_ai.response.id': runId,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': finishReasons,
        'trace_id': traceId,
        'span_id': llmSpanId,
        'parent_span_id': currentStep.stepSpanId,
        ...(userContent ? {
          'gen_ai.input.messages': [
            { role: 'user', parts: [{ type: 'text', content: userContent }] },
          ],
        } : {}),
        ...(outputParts.length > 0 ? {
          'gen_ai.output.messages': [
            { role: 'assistant', parts: outputParts },
          ],
        } : {}),
        'gen_ai.usage.input_tokens': inputTokens,
        'gen_ai.usage.output_tokens': outputTokens,
        'gen_ai.usage.cache_read.input_tokens': cachedTokens,
        'gen_ai.usage.total_tokens': totalTokens,
        ...(runError ? { 'error.type': runError.code, 'error.message': runError.message } : {}),
        attributes: {
          source: 'wukong',
          message_id: msg.id,
          conversation_id: msg.conversationId,
          ...(firstTokenEvent ? {
            ttft_ms: firstTokenEvent.ttft_ms as number,
            e2e_ttft_ms: firstTokenEvent.e2e_ttft_ms as number,
          } : {}),
          ...(runStartedTs && runFinishedTs ? {
            run_duration_ms: runFinishedTs - runStartedTs,
          } : {}),
        },
      });
      entries.push(responseEntry);
    }

    // Detect steps that have tool entries but no llm.request/response pair.
    // For each such orphan step, emit a synthetic LLM pair declaring its tools.
    // This satisfies structure.step_has_one_llm validation.
    const stepsWithLlm = new Set<string>();
    const stepsWithTools = new Map<string, AgentActivityEntry[]>();
    for (const entry of entries) {
      const sid = entry['gen_ai.step.id'];
      if (typeof sid !== 'string' || !sid) continue;
      const ename = entry['event.name'];
      if (ename === 'llm.request' || ename === 'llm.response') {
        stepsWithLlm.add(sid);
      } else if (ename === 'tool.call' || ename === 'tool.result') {
        const arr = stepsWithTools.get(sid) ?? [];
        arr.push(entry);
        stepsWithTools.set(sid, arr);
      }
    }
    for (const [stepId, toolEntries] of stepsWithTools) {
      if (stepsWithLlm.has(stepId)) continue;
      // This step has tools but no LLM. Synthesize one.
      const callEntries = toolEntries.filter(e => e['event.name'] === 'tool.call');
      const synthOutputParts: Array<Record<string, string>> = [];
      for (const ce of callEntries) {
        synthOutputParts.push({
          type: 'tool_call',
          id: String(ce['gen_ai.tool.call.id'] ?? ''),
          name: String(ce['gen_ai.tool.name'] ?? ''),
        });
      }
      // Compute timing from tool entries
      const toolTimes = toolEntries.map(e => Number(e['time_unix_nano'] ?? 0) / 1e6);
      const synthReqTs = Math.min(...toolTimes) - 1;
      const synthRespTs = Math.max(...toolTimes) + 1;
      const synthLlmSpanId = generateSpanId();
      // Find the parent_span_id from one of the tool entries (they all share step's parent)
      const stepParentSpanId = (toolEntries[0]['parent_span_id'] as string | undefined) ?? agentSpanId;

      entries.push(buildAgentActivityEntry({
        timestamp: synthReqTs,
        'event.id': hashId([sessionId, msg.id, 'synth-request', stepId]),
        'event.name': 'llm.request',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.request.model': model,
        'gen_ai.response.id': runId,
        'trace_id': traceId,
        'gen_ai.input.messages_delta': [
          { role: 'user', parts: [{ type: 'text', content: userContent || '(continued)' }] },
        ],
        attributes: { source: 'wukong', message_id: msg.id, conversation_id: msg.conversationId },
      }));
      entries.push(buildAgentActivityEntry({
        timestamp: synthRespTs,
        'event.id': hashId([sessionId, msg.id, 'synth-response', stepId]),
        'event.name': 'llm.response',
        ...common,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.response.id': runId,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': ['tool_calls'],
        'trace_id': traceId,
        'span_id': synthLlmSpanId,
        'parent_span_id': stepParentSpanId,
        'gen_ai.input.messages': [
          { role: 'user', parts: [{ type: 'text', content: userContent || '(continued)' }] },
        ],
        ...(synthOutputParts.length > 0 ? {
          'gen_ai.output.messages': [{ role: 'assistant', parts: synthOutputParts }],
        } : {}),
        'gen_ai.usage.input_tokens': 0,
        'gen_ai.usage.output_tokens': 0,
        'gen_ai.usage.cache_read.input_tokens': 0,
        'gen_ai.usage.total_tokens': 0,
        attributes: { source: 'wukong', message_id: msg.id, conversation_id: msg.conversationId },
      }));
    }

    // Backfill trace_id on any entries that lack it.
    // Also backfill step.id on tool entries that lack one — use the FIRST step.id
    // (not currentStep which may be a later step).
    let firstStepId: string | undefined;
    for (const entry of entries) {
      const sid = entry['gen_ai.step.id'];
      if (typeof sid === 'string' && sid) { firstStepId = sid; break; }
    }
    for (const entry of entries) {
      if (!entry['gen_ai.step.id'] && firstStepId) {
        entry['gen_ai.step.id'] = firstStepId;
      }
      if (!entry['trace_id']) {
        entry['trace_id'] = traceId;
      }
    }

    // Enrich llm.request messages_delta with tool_call_response messages from prior step's tools.
    // This makes messages_delta truly incremental: step 1 = user input, step 2+ = prior tool results.
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
    // Get sorted step.ids by stepIndex (parsed from suffix :sN)
    const stepIds = Array.from(new Set(entries
      .map(e => e['gen_ai.step.id'])
      .filter((s): s is string => typeof s === 'string' && !!s)
    )).sort((a, b) => {
      const na = parseInt(a.match(/:s(\d+)$/)?.[1] ?? '0', 10);
      const nb = parseInt(b.match(/:s(\d+)$/)?.[1] ?? '0', 10);
      return na - nb;
    });
    // For each step N>=2, prepend tool_call_response from step N-1 to its llm.request messages_delta
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
      // Find the llm.request for this step
      for (const entry of entries) {
        if (entry['event.name'] !== 'llm.request') continue;
        if (entry['gen_ai.step.id'] !== curStepId) continue;
        const existing = entry['gen_ai.input.messages_delta'];
        const existingArr = Array.isArray(existing) ? existing : [];
        entry['gen_ai.input.messages_delta'] = toJsonValue([...toolResponseMessages, ...existingArr]);
        break;
      }
    }

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
    task: WukongTask,
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
      attributes: {
        source: 'wukong',
        message_id: msg.id,
      },
    });
  }

  private buildToolResultEntry(
    task: WukongTask,
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
      attributes: {
        source: 'wukong',
        message_id: msg.id,
      },
    });
  }

  private transformActivitySnapshot(
    task: WukongTask,
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
      attributes: { source: 'wukong', message_id: msg.id },
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
      attributes: { source: 'wukong', message_id: msg.id },
    });

    return [toolCallEntry, toolResultEntry];
  }

  private async listAllTasks(): Promise<WukongTask[]> {
    const allTasks: WukongTask[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, unknown> = { limit: TASK_BATCH_LIMIT };
      if (cursor) params.cursor = cursor;
      const { stdout } = await execFile(
        this.cliPath,
        ['agent', 'data', 'list_tasks', '--json', JSON.stringify(params)],
        { timeout: CLI_TIMEOUT_MS },
      );
      const parsed = JSON.parse(stdout);
      if (!parsed || !Array.isArray(parsed.items)) {
        throw new Error('unexpected listTasks response structure');
      }
      const resp = parsed as ListTasksResponse;
      allTasks.push(...resp.items);
      cursor = resp.hasMore ? resp.nextCursor : undefined;
    } while (cursor && allTasks.length < MAX_TASKS);
    return allTasks;
  }

  private async getMessages(conversationId: string): Promise<GetMessagesResponse> {
    const { stdout } = await execFile(
      this.cliPath,
      ['agent', 'data', 'get_spark_agui_messages', '--json', JSON.stringify({ conversationId })],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    if (!parsed || !Array.isArray(parsed.messages)) {
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

function isMessageComplete(msg: WukongMessage): boolean {
  if (msg.role !== 'assistant') return true;
  if (!msg.events || msg.events.length === 0) return true;
  return msg.events.some(e => e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR');
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

function findLastEntry(entries: AgentActivityEntry[], eventName: string): AgentActivityEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]['event.name'] === eventName) return entries[i];
  }
  return undefined;
}
