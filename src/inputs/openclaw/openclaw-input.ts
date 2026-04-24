import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

const DEFAULT_SESSION_DIR = '~/.openclaw/sessions';

/**
 * Openclaw — a new AI agent using session file polling.
 *
 * Demonstrates how to add a brand-new agent to the system.
 * Reads JSONL session files from ~/.openclaw/sessions/ (session-*.jsonl)
 */
export class OpenclawInput extends BaseSessionInput {
  readonly id = 'openclaw';
  readonly agentType = ClientType.Openclaw;

  private sessionContext: Map<string, SessionMeta> = new Map();

  constructor(opts?: Partial<SessionInputOptions> & { stateStore: SessionInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      sessionDir: opts?.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR),
      filePattern: opts?.filePattern ?? 'session-*.jsonl',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.openclaw'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.openclaw')];
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    try {
      const entries = await fs.readdir(this.sessionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subPath = path.join(this.sessionDir, entry.name);
          const subEntries = await fs.readdir(subPath);
          for (const sub of subEntries) {
            if (sub.startsWith('session-') && sub.endsWith('.jsonl')) {
              files.push(path.join(subPath, sub));
            }
          }
        } else if (entry.name.startsWith('session-') && entry.name.endsWith('.jsonl')) {
          files.push(path.join(this.sessionDir, entry.name));
        }
      }
    } catch {
      // directory may not exist yet
    }
    return files;
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    const recordType = record.type as string;

    if (recordType === 'session_meta') {
      this.sessionContext.set(filePath, {
        sessionId: (record.session_id as string) ?? '',
        model: (record.model as string) ?? '',
        cwd: (record.cwd as string) ?? '',
      });
      return null;
    }

    if (recordType !== 'tool_call') return null;

    const toolName = (record.tool_name as string) ?? 'unknown';
    const fileTarget = (record.file_path as string) ?? '';
    if (!fileTarget) return null;

    const FILE_TOOLS = new Set([
      'write_file', 'create_file', 'edit_file', 'replace_in_file',
      'apply_patch', 'insert_text', 'delete_file',
    ]);
    if (!FILE_TOOLS.has(toolName)) return null;

    let actionType = ActionType.Edit;
    if (toolName === 'create_file' || toolName === 'write_file') actionType = ActionType.Create;
    if (toolName === 'delete_file') actionType = ActionType.Delete;

    const meta = this.sessionContext.get(filePath);

    return buildAgentActivityEntry({
      sessionId: meta?.sessionId ?? (record.session_id as string) ?? '',
      userId: (record.user_id as string) ?? '',
      agentType: ClientType.Openclaw,
      actionType,
      filePath: fileTarget,
      content: (record.content as string) ?? undefined,
      inlineDiffMessage: (record.diff as string) ?? undefined,
      timestamp: (record.timestamp as number) ?? Date.now(),
      extra: {
        model: meta?.model,
        cwd: meta?.cwd,
        callId: record.call_id,
      },
    });
  }
}

interface SessionMeta {
  sessionId: string;
  model: string;
  cwd: string;
}
