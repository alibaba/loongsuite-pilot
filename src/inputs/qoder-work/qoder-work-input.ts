import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

/**
 * Qoder Work — Hook JSONL log input.
 *
 * Hook scripts intercept PreToolUse / PostToolUse / failure events
 * and write JSONL to ~/.ai-agent-collector/logs/qoder-work/history/.
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
    const normalized = (inner.aac_tool_name_normalized as string) ?? '';
    const filePath = (toolInput?.file_path as string)
      ?? (toolInput?.path as string)
      ?? (toolInput?.filepath as string)
      ?? '';

    let actionType = ActionType.Edit;
    if (filePath) {
      const preFileExists = inner.aac_pre_file_exists as boolean | undefined;
      if (normalized === 'Create' || toolName === 'create_file') {
        actionType = preFileExists === false ? ActionType.Create : ActionType.Edit;
      } else if (normalized === 'Write' || toolName === 'write_to_file') {
        actionType = preFileExists === false ? ActionType.Create : ActionType.Edit;
      }
    } else {
      const lowerTool = toolName.toLowerCase();
      if (lowerTool.includes('search')) actionType = ActionType.Search;
      else if (lowerTool.includes('browse') || lowerTool.includes('fetch')) actionType = ActionType.Browse;
      else if (lowerTool.includes('bash') || lowerTool.includes('shell') || lowerTool.includes('terminal')) actionType = ActionType.Execute;
      else if (lowerTool.includes('read')) actionType = ActionType.Read;
      else actionType = ActionType.Other;
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
      agentType: ClientType.QoderWork,
      actionType,
      filePath: filePath || `[${toolName}]`,
      content,
      inlineDiffMessage: diff,
      timestamp: (inner.timestamp as number) ?? Date.now(),
      extra: {
        eventType,
        toolName,
        normalizedToolName: normalized,
        conversationId: inner.conversation_id,
        callId: inner.call_id,
      },
    });
  }
}
