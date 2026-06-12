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
          // Flush pending user messages without trace linkage
          for (const userMsg of pendingUserMessages) {
            const turnId = resolveTurnId(sessionId, userMsg);
            entries.push(this.buildUserRequestEntry(
              task, userMsg, model, turnId, commonFields, undefined, undefined, undefined,
            ));
          }
          pendingUserMessages = [];
          continue;
        }

        const turnId = resolveTurnId(sessionId, msg);
        const turnEntries = this.transformAssistantMessage(task, msg, events, model, turnId, commonFields);

        // Extract trace_id and first step.id from the assistant's entries for user message linkage
        const firstAssistantEntry = turnEntries[0];
        const traceId = firstAssistantEntry?.['trace_id'] as string | undefined;
        const firstStepId = turnEntries.find(e =>
          e['gen_ai.step.id'])?.['gen_ai.step.id'] as string | undefined;
        const stepSpanId = firstAssistantEntry?.['parent_span_id'] as string | undefined;

        // Emit pending user messages linked to this trace
        // Use the assistant's turnId so request+response pair share the same turn
        for (const userMsg of pendingUserMessages) {
          entries.push(this.buildUserRequestEntry(
            task, userMsg, model, turnId, commonFields, traceId, firstStepId, stepSpanId,
          ));
        }
        pendingUserMessages = [];

        entries.push(...turnEntries);
      } catch (err) {
        this.logger.warn('failed to transform message', { msgId: msg.id, error: String(err) });
      }
    }

    // Flush any remaining user messages at end (no subsequent assistant)
    for (const userMsg of pendingUserMessages) {
      const turnId = resolveTurnId(sessionId, userMsg);
      entries.push(this.buildUserRequestEntry(
        task, userMsg, model, turnId, commonFields, undefined, undefined, undefined,
      ));
    }

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
    return buildAgentActivityEntry({
      timestamp: msg.createdAt,
      'event.id': hashId([task.session_id, msg.id, 'user']),
      'event.name': 'other',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.request.model': model,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: msg.content }] },
      ],
      ...(traceId ? { 'trace_id': traceId } : {}),
      ...(parentSpanId ? { 'span_id': generateSpanId(), 'parent_span_id': parentSpanId } : {}),
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
    };

    // If no STEP_STARTED events, create a single synthetic step
    if (!hasStepEvents) {
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
          // Auto-split step: if we haven't had explicit STEP events and the current step
          // already has tool calls, this text is the "final answer" from a new LLM decision.
          // Emit step N (tools) and start step N+1 (final answer).
          if (!hasStepEvents && currentStep && currentStep.hasToolCalls && !textContent) {
            // Emit intermediate llm.response for the tool-calling step
            // Use runStartedTs to ensure it precedes tool timestamps
            const midLlmSpanId = generateSpanId();
            const midFinish = this.inferFinishReasons(true, undefined);
            const midOutputParts: Array<Record<string, string>> = [];
            for (const tc of toolCallParts) {
              midOutputParts.push({ type: tc.type, id: tc.id, name: tc.name });
            }
            entries.push(buildAgentActivityEntry({
              timestamp: runStartedTs ?? currentStep.startTimestamp,
              'event.id': hashId([sessionId, msg.id, 'response', String(currentStep.stepIndex)]),
              'event.name': 'llm.response',
              ...common,
              'gen_ai.turn.id': turnId,
              'gen_ai.step.id': currentStep.stepId,
              'gen_ai.response.id': runId,
              'gen_ai.request.model': model,
              'gen_ai.response.model': model,
              'gen_ai.response.finish_reasons': midFinish,
              'trace_id': traceId,
              'span_id': midLlmSpanId,
              'parent_span_id': currentStep.stepSpanId,
              ...(midOutputParts.length > 0 ? {
                'gen_ai.output.messages': [{ role: 'assistant', parts: midOutputParts }],
              } : {}),
              'gen_ai.usage.input_tokens': 0,
              'gen_ai.usage.output_tokens': 0,
              'gen_ai.usage.cache_read.input_tokens': 0,
              'gen_ai.usage.total_tokens': 0,
              attributes: { source: 'wukong', message_id: msg.id, conversation_id: msg.conversationId },
            }));

            // Start new final step
            stepIndex++;
            currentStep = {
              stepIndex,
              stepId: `${turnId}:s${stepIndex}`,
              stepMessageId: `synth-step-${stepIndex}`,
              hasToolCalls: false,
              startTimestamp: evt.timestamp,
              stepSpanId: generateSpanId(),
            };
            toolCallParts.length = 0;
          }
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
          const duration = startTs && evt.timestamp ? evt.timestamp - startTs : undefined;
          const toolName = toolNames.get(tcId) ?? (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
          const args = toolArgsAccumulator.get(tcId);

          // Emit tool.call (deferred from TOOL_CALL_START to capture accumulated args)
          const syntheticStartEvt = { ...evt, timestamp: startEvtTimestamp, toolCallId: evt.toolCallId, toolName };
          entries.push(this.buildToolCallEntry(
            task, msg, syntheticStartEvt, model, turnId, toolIdx, common,
            currentStep, traceId, agentSpanId, args,
          ));
          toolIdx++;

          // Emit tool.result
          entries.push(this.buildToolResultEntry(
            task, msg, evt, model, turnId, toolIdx, common, duration,
            currentStep, traceId, agentSpanId, toolName,
          ));
          toolIdx++;
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

    // Emit llm.response for the current (possibly only) step
    if (currentStep && (textContent || usageEvent || toolCallParts.length > 0)) {
      const finishReasons = this.inferFinishReasons(currentStep.hasToolCalls, runError);
      const llmSpanId = generateSpanId();

      const inputTokens = numOr(usageEvent?.prompt_tokens) ?? 0;
      const outputTokens = numOr(usageEvent?.completion_tokens) ?? 0;
      const cachedTokens = numOr(usageEvent?.cached_tokens) ?? 0;
      const totalTokens = numOr(usageEvent?.total_tokens) ?? (inputTokens + outputTokens);

      // Build output message parts: text + tool_call declarations
      const outputParts: Array<Record<string, string>> = [];
      if (textContent) {
        outputParts.push({ type: 'text', content: textContent });
      }
      for (const tc of toolCallParts) {
        outputParts.push({ type: tc.type, id: tc.id, name: tc.name });
      }

      const responseEntry = buildAgentActivityEntry({
        timestamp: runFinishedTs ?? msg.createdAt,
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

    // Backfill step.id and trace IDs on all tool entries emitted during processing
    for (const entry of entries) {
      if (!entry['gen_ai.step.id'] && currentStep) {
        entry['gen_ai.step.id'] = currentStep.stepId;
      }
      if (!entry['trace_id']) {
        entry['trace_id'] = traceId;
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
    const finishTime = numOr(content?.finish_time) ?? evt.timestamp;
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
  for (let i = 0; i < messages.length; i++) {
    if (!isMessageComplete(messages[i])) return i - 1;
  }
  return messages.length - 1;
}

function findLastEntry(entries: AgentActivityEntry[], eventName: string): AgentActivityEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]['event.name'] === eventName) return entries[i];
  }
  return undefined;
}
