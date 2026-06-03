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

      // API returns messages in append-only order; slice by count is safe.
      const newMessages = messages.slice(prevCount);
      const taskEntries = this.transformMessages(task, newMessages);
      entries.push(...taskEntries);

      seenCounts[task.session_id] = messages.length;
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

    for (const msg of messages) {
      try {
        const turnId = resolveTurnId(sessionId, msg);

        if (msg.role === 'user') {
          if (!msg.content) continue;
          entries.push(
            buildAgentActivityEntry({
              timestamp: msg.createdAt,
              'event.id': hashId([sessionId, msg.id, 'user']),
              'event.name': 'llm.request',
              ...commonFields,
              'gen_ai.turn.id': turnId,
              'gen_ai.request.model': model,
              'gen_ai.input.messages_delta': [
                { role: 'user', parts: [{ type: 'text', content: msg.content }] },
              ],
              attributes: {
                source: 'wukong',
                message_id: msg.id,
                conversation_id: msg.conversationId,
              },
            }),
          );
          continue;
        }

        if (msg.role !== 'assistant') continue;
        const events = msg.events;
        if (!events || events.length === 0) continue;

        let runId: string | undefined;
        let textContent = '';
        let usageEvent: AguiEvent | undefined;
        let firstTokenEvent: AguiEvent | undefined;
        let runStartedTs: number | undefined;
        let runFinishedTs: number | undefined;
        let toolIdx = 0;
        let toolStartCount = 0;
        const toolStartTimestamps = new Map<string, number>();

        for (const evt of events) {
          switch (evt.type) {
            case 'RUN_STARTED':
              runId = evt.runId as string | undefined;
              runStartedTs = evt.timestamp;
              break;
            case 'RUN_FINISHED':
              runFinishedTs = evt.timestamp;
              break;
            case 'TEXT_MESSAGE_CONTENT':
              if (typeof evt.delta === 'string') textContent += evt.delta;
              break;
            case 'TOOL_CALL_START': {
              const tcId = (evt.toolCallId as string | undefined) ?? `idx-${toolStartCount}`;
              toolStartTimestamps.set(tcId, evt.timestamp);
              entries.push(this.buildToolCallEntry(task, msg, evt, model, turnId, toolIdx, commonFields));
              toolIdx++;
              toolStartCount++;
              break;
            }
            case 'TOOL_CALL_END': {
              const tcId = (evt.toolCallId as string | undefined) ?? `idx-${toolStartCount - 1}`;
              const startTs = toolStartTimestamps.get(tcId);
              const duration = startTs && evt.timestamp ? evt.timestamp - startTs : undefined;
              entries.push(this.buildToolResultEntry(task, msg, evt, model, turnId, toolIdx, commonFields, duration));
              toolIdx++;
              break;
            }
            case 'USAGE':
              usageEvent = evt;
              break;
            case 'FIRST_TOKEN':
              firstTokenEvent = evt;
              break;
          }
        }

        if (textContent || usageEvent) {
          const inputTokens = numOr(usageEvent?.prompt_tokens);
          const outputTokens = numOr(usageEvent?.completion_tokens);
          const cachedTokens = numOr(usageEvent?.cached_tokens);
          const totalTokens = numOr(usageEvent?.total_tokens);

          const responseEntry = buildAgentActivityEntry({
            timestamp: msg.createdAt,
            'event.id': hashId([sessionId, msg.id, 'response']),
            'event.name': 'llm.response',
            ...commonFields,
            'gen_ai.turn.id': turnId,
            'gen_ai.response.id': runId,
            'gen_ai.request.model': model,
            'gen_ai.response.model': model,
            ...(textContent ? {
              'gen_ai.output.messages': [
                { role: 'assistant', parts: [{ type: 'text', content: textContent }] },
              ],
            } : {}),
            ...(inputTokens !== undefined ? { 'gen_ai.usage.input_tokens': inputTokens } : {}),
            ...(outputTokens !== undefined ? { 'gen_ai.usage.output_tokens': outputTokens } : {}),
            ...(cachedTokens !== undefined ? { 'gen_ai.usage.cache_read.input_tokens': cachedTokens } : {}),
            ...(totalTokens !== undefined ? { 'gen_ai.usage.total_tokens': totalTokens } : {}),
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
      } catch (err) {
        this.logger.warn('failed to transform message', { msgId: msg.id, error: String(err) });
      }
    }

    return entries;
  }

  private buildToolCallEntry(
    task: WukongTask,
    msg: WukongMessage,
    evt: AguiEvent,
    model: string,
    turnId: string,
    toolIdx: number,
    common: Record<string, unknown>,
  ): AgentActivityEntry {
    const toolCallId = (evt.toolCallId as string | undefined) ?? '';
    const toolName = (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
    return buildAgentActivityEntry({
      timestamp: evt.timestamp || msg.createdAt,
      'event.id': hashId([task.session_id, msg.id, 'tool_call', toolCallId, String(toolIdx)]),
      'event.name': 'tool.call',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': toolCallId,
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
  ): AgentActivityEntry {
    const toolCallId = (evt.toolCallId as string | undefined) ?? '';
    const toolName = (evt.toolName as string | undefined) ?? (evt.name as string | undefined) ?? '';
    const result = evt.result ?? evt.output;
    const hasError = Boolean(evt.error || evt.isError);
    return buildAgentActivityEntry({
      timestamp: evt.timestamp || msg.createdAt,
      'event.id': hashId([task.session_id, msg.id, 'tool_result', toolCallId, String(toolIdx)]),
      'event.name': 'tool.result',
      ...common,
      'gen_ai.turn.id': turnId,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': toolCallId,
      ...(result !== undefined ? { 'gen_ai.tool.call.result': toJsonValue(result) } : {}),
      ...(duration !== undefined ? { 'gen_ai.tool.call.duration': duration } : {}),
      'tool.result.status': hasError ? 'failure' : 'success',
      ...(hasError && evt.error ? { 'error.type': String(evt.error) } : {}),
      attributes: {
        source: 'wukong',
        message_id: msg.id,
      },
    });
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
