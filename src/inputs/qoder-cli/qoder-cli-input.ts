import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

/**
 * Qoder CLI — Hook JSONL log input.
 *
 * Hook scripts intercept PreToolUse / PostToolUse / failure events
 * and write JSONL to ~/.ai-agent-collector/logs/qoder-cli/history/.
 *
 * Special: uses aac_pre_file_exists / aac_pre_file_content to distinguish
 * true create vs overwrite.
 */
export class QoderCliInput extends BaseHookInput {
  readonly id = 'qoder-cli-hook';
  readonly agentType = ClientType.QoderCliHook;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.ai-agent-collector/logs/qoder-cli/history'),
      logPrefix: opts?.logPrefix ?? 'qoder-cli',
      pollIntervalMs: opts?.pollIntervalMs ?? 60_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoder'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.qoder')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const eventType = record.event_type as string | undefined;
    if (!eventType || !eventType.includes('PostToolUse')) return null;

    const toolInput = record.tool_input as Record<string, unknown> | undefined;
    const toolName = (record.tool_name as string) ?? 'unknown';
    const filePath = (toolInput?.file_path as string)
      ?? (toolInput?.path as string)
      ?? '';
    if (!filePath) return null;

    const preFileExists = record.aac_pre_file_exists as boolean | undefined;
    let actionType = ActionType.Edit;
    if (toolName === 'create_file' || toolName === 'write_to_file') {
      actionType = preFileExists === false ? ActionType.Create : ActionType.Edit;
    }

    const content = (toolInput?.content as string)
      ?? (toolInput?.new_string as string)
      ?? '';
    const diff = (toolInput?.diff as string)
      ?? (record.tool_response as string)
      ?? undefined;

    return buildAgentActivityEntry({
      sessionId: (record.session_id as string) ?? '',
      userId: (record.user_id as string) ?? '',
      agentType: ClientType.QoderCliHook,
      actionType,
      filePath,
      content,
      inlineDiffMessage: diff,
      timestamp: (record.timestamp as number) ?? Date.now(),
      extra: {
        eventType,
        conversationId: record.conversation_id,
        callId: record.call_id,
      },
    });
  }
}
