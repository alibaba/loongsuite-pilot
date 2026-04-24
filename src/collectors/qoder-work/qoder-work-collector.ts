import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import {
  BaseSessionCollector,
  type SessionCollectorOptions,
} from '../base/base-session-collector.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

const QODER_PROJECTS_DIR = '~/.qoder/projects';
const QODER_EXPERTS_DIR = '~/.qoder/cache/experts';
const QODERWORK_PROJECTS_DIR = '~/Library/Application Support/QoderWork/cli/projects';

/**
 * Qoder Work — session transcript JSONL polling.
 *
 * Data sources:
 *   ~/Library/Application Support/QoderWork/cli/projects/{slug}/{session}.jsonl (QoderWork app)
 *   ~/.qoder/projects/{slug}/transcript/{session}.jsonl  (Qoder CLI transcripts)
 *
 * Incrementally reads JSONL transcript lines, extracting all tool calls as events.
 */
export class QoderWorkCollector extends BaseSessionCollector {
  readonly id = 'qoder-work';
  readonly agentType = ClientType.QoderWork;

  constructor(opts?: Partial<SessionCollectorOptions> & { stateStore: SessionCollectorOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      sessionDir: resolveHome(QODERWORK_PROJECTS_DIR),
      filePattern: '*.jsonl',
      pollIntervalMs: opts?.pollIntervalMs ?? 60_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return (
      (await directoryExists(resolveHome(QODERWORK_PROJECTS_DIR))) ||
      (await directoryExists(resolveHome(QODER_PROJECTS_DIR))) ||
      (await directoryExists(resolveHome(QODER_EXPERTS_DIR)))
    );
  }

  static getWatchPaths(): string[] {
    return [
      resolveHome(QODERWORK_PROJECTS_DIR),
      resolveHome(QODER_PROJECTS_DIR),
      resolveHome(QODER_EXPERTS_DIR),
    ];
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];

    // QoderWork app: ~/Library/Application Support/QoderWork/cli/projects/{slug}/{session}.jsonl
    await this.scanQoderWorkProjects(files);

    // Qoder CLI: ~/.qoder/projects/{slug}/transcript/{session}.jsonl
    await this.scanQoderCliProjects(files);

    return files;
  }

  private async scanQoderWorkProjects(files: string[]): Promise<void> {
    const baseDir = resolveHome(QODERWORK_PROJECTS_DIR);
    try {
      const slugs = await fs.readdir(baseDir);
      for (const slug of slugs) {
        const slugDir = path.join(baseDir, slug);
        try {
          const entries = await fs.readdir(slugDir);
          for (const entry of entries) {
            if (entry.endsWith('.jsonl')) {
              files.push(path.join(slugDir, entry));
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* dir may not exist */ }
  }

  private async scanQoderCliProjects(files: string[]): Promise<void> {
    const baseDir = resolveHome(QODER_PROJECTS_DIR);
    try {
      const slugs = await fs.readdir(baseDir);
      for (const slug of slugs) {
        const transcriptDir = path.join(baseDir, slug, 'transcript');
        try {
          const entries = await fs.readdir(transcriptDir);
          for (const entry of entries) {
            if (entry.endsWith('.jsonl')) {
              files.push(path.join(transcriptDir, entry));
            }
          }
        } catch { /* transcript dir may not exist */ }
      }
    } catch { /* dir may not exist */ }
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    const type = record.type as string | undefined;
    if (!type) return null;

    const sessionId = (record.sessionId as string) ?? '';
    const timestamp = record.timestamp as string | undefined;
    const cwd = record.cwd as string | undefined;
    const ts = timestamp ? new Date(timestamp).getTime() : undefined;

    const message = record.message as Record<string, unknown> | undefined;
    const data = record.data as Record<string, unknown> | undefined;

    if (type === 'assistant' || type === 'user') {
      if (!message) return null;
      const content = message.content;

      if (typeof content === 'string') {
        return buildAgentActivityEntry({
          sessionId,
          userId: '',
          agentType: ClientType.QoderWork,
          actionType: ActionType.Other,
          filePath: cwd ?? '',
          content: content.slice(0, 2000),
          timestamp: ts,
          extra: { sourceFile: filePath, messageType: type },
        });
      }

      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || !block) continue;
          const b = block as Record<string, unknown>;

          if (b.type === 'tool_use') {
            const toolName = (b.name as string) ?? 'unknown';
            const input = (b.input as Record<string, unknown>) ?? {};
            const { actionType, targetFilePath, codeContent } =
              this.classifyToolCall(toolName, input, cwd);

            return buildAgentActivityEntry({
              sessionId,
              userId: '',
              agentType: ClientType.QoderWork,
              actionType,
              filePath: targetFilePath ?? cwd ?? '',
              content: codeContent,
              timestamp: ts,
              extra: { sourceFile: filePath, toolUseId: b.id as string },
            });
          }

          if (b.type === 'tool_result') {
            return buildAgentActivityEntry({
              sessionId,
              userId: '',
              agentType: ClientType.QoderWork,
              actionType: ActionType.Other,
              filePath: cwd ?? '',
              content: typeof b.content === 'string'
                ? b.content.slice(0, 2000)
                : JSON.stringify(b.content).slice(0, 2000),
              timestamp: ts,
              extra: { sourceFile: filePath, toolUseId: b.tool_use_id as string },
            });
          }

          if (b.type === 'text') {
            return buildAgentActivityEntry({
              sessionId,
              userId: '',
              agentType: ClientType.QoderWork,
              actionType: ActionType.Other,
              filePath: cwd ?? '',
              content: ((b.text as string) ?? '').slice(0, 2000),
              timestamp: ts,
              extra: { sourceFile: filePath, messageType: type },
            });
          }
        }
      }

      return null;
    }

    if (type === 'session_meta') {
      return buildAgentActivityEntry({
        sessionId,
        userId: '',
        agentType: ClientType.QoderWork,
        actionType: ActionType.Other,
        filePath: cwd ?? '',
        content: data ? JSON.stringify(data).slice(0, 2000) : undefined,
        timestamp: ts,
        extra: { sourceFile: filePath, messageType: type },
      });
    }

    if (type === 'progress') {
      return buildAgentActivityEntry({
        sessionId,
        userId: '',
        agentType: ClientType.QoderWork,
        actionType: ActionType.Other,
        filePath: cwd ?? '',
        content: data ? JSON.stringify(data).slice(0, 2000) : undefined,
        timestamp: ts,
        extra: { sourceFile: filePath, messageType: type },
      });
    }

    return null;
  }

  private classifyToolCall(
    toolName: string,
    input: Record<string, unknown>,
    cwd?: string,
  ): { actionType: ActionType; targetFilePath?: string; codeContent?: string } {
    switch (toolName) {
      case 'create_file':
      case 'Write':
        return {
          actionType: ActionType.Create,
          targetFilePath: (input.file_path ?? input.path) as string,
          codeContent: input.content as string,
        };
      case 'search_replace':
      case 'Edit':
        return {
          actionType: ActionType.Edit,
          targetFilePath: (input.file_path ?? input.path) as string,
          codeContent: (input.new_string ?? input.new_str) as string,
        };
      case 'delete_file':
        return {
          actionType: ActionType.Delete,
          targetFilePath: (input.file_path ?? input.path) as string,
        };
      case 'run_in_terminal':
      case 'Bash':
        return {
          actionType: ActionType.Execute,
          targetFilePath: cwd,
          codeContent: input.command as string,
        };
      case 'read_file':
      case 'Read':
        return {
          actionType: ActionType.Read,
          targetFilePath: (input.file_path ?? input.path) as string,
        };
      case 'search_file':
      case 'Glob':
      case 'grep_code':
      case 'Grep':
      case 'search_codebase':
        return {
          actionType: ActionType.Search,
          targetFilePath: (input.path ?? input.directory) as string,
          codeContent: (input.pattern ?? input.query ?? input.regex) as string,
        };
      case 'fetch_content':
      case 'WebFetch':
      case 'search_web':
      case 'WebSearch':
        return {
          actionType: ActionType.Browse,
          codeContent: (input.url ?? input.query ?? input.search_term) as string,
        };
      default:
        return {
          actionType: ActionType.Other,
          codeContent: JSON.stringify(input).slice(0, 500),
        };
    }
  }
}
