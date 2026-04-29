import { ActionType, ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

/**
 * Cursor Hook — transcript JSONL input.
 *
 * Reads rows from ~/.ai-agent-collector/logs/cursor-hook/history/ written by
 * hook-processor.mjs, which incrementally forwards Cursor's transcript lines.
 *
 * Each row is a transcript line with { role, message: { content: [...] } }.
 */
export class CursorHookInput extends BaseHookInput {
  readonly id = 'cursor-hook';
  readonly agentType = ClientType.CursorHook;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.ai-agent-collector/logs/cursor-hook/history'),
      logPrefix: opts?.logPrefix ?? 'cursor',
      pollIntervalMs: opts?.pollIntervalMs ?? 60_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.ai-agent-collector/logs/cursor-hook/history'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.ai-agent-collector/logs/cursor-hook/history')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const rowRole = (record.role as string | undefined)
      ?? (record.type as string | undefined);
    if (rowRole !== 'assistant' && rowRole !== 'user') return null;

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
        ?? '',
      userId: (record.user_id as string)
        ?? (record.userId as string)
        ?? '',
      agentType: ClientType.CursorHook,
      actionType: rowRole === 'assistant' ? ActionType.Edit : ActionType.Other,
      filePath: (record.filePath as string) ?? '',
      content,
      timestamp,
      extra: {
        role: rowRole,
        _ctype: ctype,
        _cname: cname,
        _cinput: cinput,
        _ctext: ctext,
        _ccontent: ccontent,
        _cthinking: cthinking,
        _cid: cid,
        _ctool_use_id: ctoolUseId,
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
