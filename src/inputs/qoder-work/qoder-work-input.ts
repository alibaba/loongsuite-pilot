import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

/**
 * Qoder Work — transcript JSONL input.
 *
 * Reads rows from ~/.ai-agent-collector/logs/qoder-work/history/ and keeps
 * assistant/user messages that have message.content[0].type.
 *
 * Reuses the same hook script as Qoder CLI (aac-qoder-hook.sh)
 * with "qoder-work" as the agent ID parameter.
 * Hook config lives at ~/.qoderwork/settings.json.
 */
export class QoderWorkInput extends BaseHookInput {
  readonly id = 'qoder-work-hook';
  readonly agentType = ClientType.QoderWork;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.ai-agent-collector/logs/qoder-work/history'),
      logPrefix: opts?.logPrefix ?? 'qoder-work',
      pollIntervalMs: opts?.pollIntervalMs ?? 60_000,
    });
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
    const rowType = record.type as string | undefined;
    if (rowType !== 'assistant' && rowType !== 'user') return null;

    const message = (typeof record.message === 'object' && record.message !== null
      ? record.message
      : {}) as Record<string, unknown>;
    const messageContent = message.content;

    let ctype: unknown;
    let cname: unknown;
    let cinput: unknown;
    let ctext: unknown;
    let ccontent: unknown;
    let cthinking: unknown;
    let cid: unknown;
    let ctoolUseId: unknown;

    if (typeof messageContent === 'string') {
      ctype = 'text';
      ctext = messageContent;
    } else {
      const contentList = Array.isArray(messageContent) ? messageContent : [];
      const content0 = (contentList[0] && typeof contentList[0] === 'object' && contentList[0] !== null
        ? contentList[0]
        : null) as Record<string, unknown> | null;

      ctype = content0?.type;
      if (ctype === null || ctype === undefined) return null;

      cname = content0?.name;
      cinput = content0?.input;
      ctext = content0?.text;
      ccontent = content0?.content;
      cthinking = content0?.thinking;
      cid = content0?.id;
      ctoolUseId = content0?.tool_use_id;
    }

    const timestamp = parseTimestamp(record.timestamp) ?? Date.now();
    const content = typeof ctext === 'string'
      ? ctext
      : typeof cthinking === 'string'
        ? cthinking
        : typeof ccontent === 'string'
          ? ccontent
          : '';

    const entry = buildAgentActivityEntry({
      sessionId: (record.session_id as string)
        ?? (record.sessionId as string)
        ?? (record.sessionid as string)
        ?? '',
      userId: (record.user_id as string)
        ?? (record.userId as string)
        ?? '',
      agentType: ClientType.QoderWork,
      actionType: rowType === 'assistant' ? ActionType.Edit : ActionType.Other,
      filePath: (record.filePath as string) ?? '',
      content,
      timestamp,
      extra: {
        type: rowType,
        _ctype: ctype,
        _cname: cname,
        _cinput: cinput,
        _ctext: ctext,
        _ccontent: ccontent,
        _cthinking: cthinking,
        _cid: cid,
        _ctool_use_id: ctoolUseId,
        entrypoint: record.entrypoint,
        cwd: record.cwd,
        userType: record.userType,
        parentUuid: record.parentUuid,
        role: message.role,
        model: message.model,
        stop_reason: message.stop_reason,
      },
    });

    const sourceUuid = record.uuid;
    if (typeof sourceUuid === 'string' && sourceUuid.trim().length > 0) {
      entry.uuid = sourceUuid;
    }
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
