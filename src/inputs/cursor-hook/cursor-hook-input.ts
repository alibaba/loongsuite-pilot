import { ActionType, ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

function toActionType(hookEvent: string): ActionType {
  const event = hookEvent.toLowerCase();
  if (event.includes('readfile')) return ActionType.Read;
  if (event.includes('fileedit')) return ActionType.Edit;
  if (
    event.includes('toolexecution')
    || event.includes('tooluse')
    || event.includes('shellexecution')
    || event.includes('mcpexecution')
  ) {
    return ActionType.Execute;
  }
  return ActionType.Other;
}

function getStringRecordValue(record: Record<string, unknown>, key: string): string | undefined {
  const val = record[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function getStringDataValue(data: Record<string, unknown>, key: string): string | undefined {
  const val = data[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

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
    const hookEvent = getStringRecordValue(record, 'hookEvent') ?? 'unknown';
    const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
      ? (record.data as Record<string, unknown>)
      : {};

    const sessionId = getStringDataValue(data, 'gen_ai.session_id')
      ?? getStringDataValue(data, 'gen_ai.session_id')
      ?? getStringRecordValue(record, 'session_id')
      ?? '';
    const filePath = getStringDataValue(data, 'file_path')
      ?? getStringDataValue(data, 'path')
      ?? getStringDataValue(data, 'filePath')
      ?? '';
    const textContent = getStringDataValue(data, 'text');
    const timestamp = Date.parse(getStringRecordValue(record, 'logTime') ?? '');

    const extra: Record<string, unknown> = {
      hookEvent,
      reported: record.reported,
      cursorRecordUuid: record.uuid,
      cursorClientType: record.clientType,
      ...data,
    };

    return buildAgentActivityEntry({
      sessionId,
      userId: '',
      agentType: ClientType.CursorHook,
      actionType: toActionType(hookEvent),
      filePath: filePath || getStringDataValue(data, 'cwd') || '',
      content: textContent,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      extra,
    });
  }
}
