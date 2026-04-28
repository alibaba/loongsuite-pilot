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
    const inner = (typeof record.data === 'object' && record.data !== null
      ? record.data
      : record) as Record<string, unknown>;

    const eventType = (inner.hook_event_name as string)
      ?? (record.hookEvent as string)
      ?? (inner.event_type as string)
      ?? '';
    if (!eventType.includes('PostToolUse')) return null;

    const toolInput = (inner.tool_input ?? inner.toolInput) as Record<string, unknown> | undefined;
    const toolName = (inner.tool_name as string)
      ?? (inner.toolName as string)
      ?? 'unknown';
    const filePath = (toolInput?.file_path as string)
      ?? (toolInput?.path as string)
      ?? (toolInput?.filepath as string)
      ?? '';
    if (!filePath) return null;

    const preFileExists = inner.aac_pre_file_exists as boolean | undefined;
    let actionType = ActionType.Edit;
    const normalized = (inner.aac_tool_name_normalized as string) ?? '';
    if (normalized === 'Create' || toolName === 'create_file') {
      actionType = preFileExists === false ? ActionType.Create : ActionType.Edit;
    } else if (normalized === 'Write' || toolName === 'write_to_file') {
      actionType = preFileExists === false ? ActionType.Create : ActionType.Edit;
    }

    const content = (toolInput?.content as string)
      ?? (toolInput?.new_string as string)
      ?? '';
    const diff = (toolInput?.diff as string)
      ?? (inner.tool_response as string)
      ?? undefined;

    return buildAgentActivityEntry({
      sessionId: (inner.session_id as string) ?? '',
      userId: (inner.user_id as string) ?? '',
      agentType: ClientType.QoderCliHook,
      actionType,
      filePath,
      content,
      inlineDiffMessage: diff,
      timestamp: (inner.timestamp as number) ?? Date.now(),
      extra: {
        eventType,
        conversationId: inner.conversation_id,
        callId: inner.call_id,
      },
    });
  }
}
