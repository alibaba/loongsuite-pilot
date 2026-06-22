import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry, toJsonValue } from '../../normalization/entry-builder.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';

export interface QoderWorkInputOptions extends Partial<HookInputOptions> {
  stateStore: HookInputOptions['stateStore'];
  agentType?: ClientType;
}

/**
 * Qoder Work — transcript JSONL input.
 *
 * Reads rows from ~/.loongsuite-pilot/logs/qoder-work/history/ and keeps
 * assistant/user messages that have message.content[0].type.
 *
 * Hook config lives at ~/.qoderwork/settings.json and invokes the dedicated
 * qoderwork-loongsuite-pilot-hook.sh entrypoint.
 *
 * Parameterized to support both QoderWork and QoderWork CN variants.
 */
export class QoderWorkInput extends BaseHookInput {
  readonly id: string;
  readonly agentType: ClientType;
  private lastAgentVersion = '';

  getAgentVersion(): string {
    return this.lastAgentVersion;
  }

  constructor(opts: QoderWorkInputOptions) {
    const agentType = opts.agentType ?? ClientType.QoderWork;
    const logPrefix = opts.logPrefix ?? (agentType === ClientType.QoderWork ? 'qoder-work' : agentType);
    const defaultLogDir = agentType === ClientType.QoderWork
      ? '~/.loongsuite-pilot/logs/qoder-work/history'
      : `~/.loongsuite-pilot/logs/${agentType}/history`;
    super({
      stateStore: opts.stateStore,
      logDir: opts.logDir ?? resolveHome(defaultLogDir),
      logPrefix,
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.agentType = agentType;
    this.id = `${agentType}-hook`;
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoderwork'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.qoderwork')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const ver = record['agent.qoderwork.version'];
    if (typeof ver === 'string' && ver) this.lastAgentVersion = ver;
    delete record['version'];

    const canonicalEntry = buildCanonicalHookEntry(record, this.agentType);
    if (canonicalEntry) {
      await enrichCanonicalEntryWithGit(canonicalEntry as Record<string, unknown>, record, 'qoder-work');
      return canonicalEntry;
    }

    const hookEntry = buildPostToolUseEntry(record, this.agentType);
    if (hookEntry) {
      await enrichCanonicalEntryWithGit(hookEntry as Record<string, unknown>, record, 'qoder-work');
      return hookEntry;
    }

    const rowType = record.type as string | undefined;
    if (rowType !== 'assistant' && rowType !== 'user') return null;

    const message = (typeof record.message === 'object' && record.message !== null
      ? record.message
      : {}) as Record<string, unknown>;
    const role = typeof message.role === 'string' && message.role.length > 0
      ? message.role
      : rowType;
    const messageContent = message.content;

    // Parse the single part QoderWork hook emits per transcript row.
    let partType: string | undefined;
    let partText: string | undefined;
    let partThinking: string | undefined;
    let toolName: string | undefined;
    let toolCallId: string | undefined;
    let toolArgs: JsonValue | undefined;
    let toolUseId: string | undefined;
    let toolResult: JsonValue | undefined;

    if (typeof messageContent === 'string') {
      partType = 'text';
      partText = messageContent;
    } else {
      const contentList = Array.isArray(messageContent) ? messageContent : [];
      const content0 = (contentList[0] && typeof contentList[0] === 'object' && contentList[0] !== null
        ? contentList[0]
        : null) as Record<string, unknown> | null;
      if (!content0 || typeof content0.type !== 'string') return null;

      partType = content0.type;
      if (typeof content0.text === 'string') partText = content0.text;
      if (typeof content0.thinking === 'string') partThinking = content0.thinking;
      if (typeof content0.name === 'string') toolName = content0.name;
      if (typeof content0.id === 'string') toolCallId = content0.id;
      if (typeof content0.tool_use_id === 'string') toolUseId = content0.tool_use_id;
      toolArgs = toJsonValue(content0.input);
      toolResult = toJsonValue(content0.content);
    }

    // Route event.name by part type + role.
    let eventName: AgentEventName;
    if (partType === 'tool_use') eventName = 'tool.call';
    else if (partType === 'tool_result') eventName = 'tool.result';
    else if (role === 'assistant') eventName = 'llm.response';
    else eventName = 'llm.request';

    const timestamp = parseTimestamp(record.timestamp) ?? Date.now();
    const standard: Record<string, JsonValue | undefined> = {};

    if (eventName === 'llm.request' && typeof partText === 'string') {
      standard['gen_ai.input.messages_delta'] = [
        { role: 'user', parts: [{ type: 'text', content: partText }] },
      ];
    } else if (eventName === 'llm.response') {
      const parts: JsonValue[] = [];
      if (partType === 'thinking' && typeof partThinking === 'string') {
        parts.push({ type: 'reasoning', content: partThinking });
      } else if (typeof partText === 'string') {
        parts.push({ type: 'text', content: partText });
      }
      if (parts.length > 0) {
        const msg: { [key: string]: JsonValue } = { role: 'assistant', parts };
        if (typeof message.stop_reason === 'string' && message.stop_reason.length > 0) {
          msg.finish_reason = message.stop_reason;
        }
        standard['gen_ai.output.messages'] = [msg];
      }
      if (typeof message.stop_reason === 'string' && message.stop_reason.length > 0) {
        standard['gen_ai.response.finish_reasons'] = [message.stop_reason];
      }
      if (typeof message.id === 'string' && message.id.length > 0) {
        standard['gen_ai.response.id'] = message.id;
      }
    } else if (eventName === 'tool.call') {
      if (toolName) standard['gen_ai.tool.name'] = toolName;
      if (toolCallId) standard['gen_ai.tool.call.id'] = toolCallId;
      if (toolArgs !== undefined) standard['gen_ai.tool.call.arguments'] = toolArgs;
    } else if (eventName === 'tool.result') {
      if (toolUseId) standard['gen_ai.tool.call.id'] = toolUseId;
      if (toolResult !== undefined) standard['gen_ai.tool.call.result'] = toolResult;
    }

    const attributes: { [key: string]: JsonValue } = {};
    if (typeof record.cwd === 'string' && record.cwd.length > 0) attributes.cwd = record.cwd;
    if (typeof record.parentUuid === 'string' && record.parentUuid.length > 0) {
      attributes.parent_uuid = record.parentUuid;
    }
    if (typeof record.userType === 'string' && record.userType.length > 0) {
      attributes.user_type = record.userType;
    }
    if (typeof record.entrypoint === 'string' && record.entrypoint.length > 0) {
      attributes.entrypoint = record.entrypoint;
    }
    if (typeof rowType === 'string') attributes.row_type = rowType;

    // Backward-compatible fields for downstream dashboards still referencing
    // the legacy agent._c* naming convention. Remove once all consumers have
    // migrated to the OTel-aligned gen_ai.* fields above.
    if (partType !== undefined) attributes._ctype = partType;
    if (toolName) attributes._cname = toolName;
    if (toolArgs !== undefined) attributes._cinput = toolArgs;
    if (partText !== undefined) attributes._ctext = partText;
    if (toolResult !== undefined) attributes._ccontent = toolResult;
    if (partThinking !== undefined) attributes._cthinking = partThinking;
    if (toolCallId) attributes._cid = toolCallId;
    if (toolUseId) attributes._ctool_use_id = toolUseId;

    const entry = buildAgentActivityEntry({
      ...standard,
      timestamp,
      'session.id': (record.session_id as string)
        ?? (record.sessionId as string)
        ?? (record.sessionid as string)
        ?? '',
      'user.id': (record.user_id as string) ?? (record.userId as string) ?? '',
      'agent.type': this.agentType,
      'event.name': eventName,
      attributes,
    });
    if (!entry) return null;

    const sourceUuid = record.uuid;
    if (typeof sourceUuid === 'string' && sourceUuid.trim().length > 0) {
      entry['event.id'] = sourceUuid;
      entry.uuid = sourceUuid;
    }
    await enrichCanonicalEntryWithGit(entry as Record<string, unknown>, record, 'qoder-work');
    return entry;
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;

  const num = Number(value);
  if (Number.isFinite(num)) return num;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function buildPostToolUseEntry(
  record: Record<string, unknown>,
  agentType: ClientType,
): AgentActivityEntry | null {
  const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
    ? record.data as Record<string, unknown>
    : record;
  const eventType = (data.event_type ?? data.hook_event_name ?? record.hookEvent) as string | undefined;
  if (eventType !== 'PostToolUse') return null;

  const toolInput = (data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input))
    ? data.tool_input as Record<string, unknown>
    : {};
  const filePath = typeof toolInput.file_path === 'string'
    ? toolInput.file_path
    : typeof data.file_path === 'string'
      ? data.file_path
      : '';
  if (!filePath) return null;

  return buildAgentActivityEntry({
    sessionId: (data.session_id as string) ?? '',
    userId: (data.user_id as string) ?? '',
    agentType,
    actionType: data.loongsuite_pilot_pre_file_exists === false ? ActionType.Create : ActionType.Edit,
    filePath,
    content: typeof toolInput.content === 'string'
      ? toolInput.content
      : typeof toolInput.new_string === 'string'
        ? toolInput.new_string
        : undefined,
    timestamp: parseTimestamp(data.timestamp) ?? Date.now(),
    extra: data,
  });
}
