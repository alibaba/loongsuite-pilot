import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../types/index.js';
import { BaseIdeInput, type IdeInputOptions } from '../base/base-ide-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, fileExists } from '../../utils/fs-utils.js';

const DEFAULT_QODER_ROOT_MAC = '~/Library/Application Support/Qoder';
const DEFAULT_QODER_ROOT_LINUX = '~/.config/Qoder';

function resolveQoderRoot(): string {
  if (process.platform === 'darwin') {
    return resolveHome(DEFAULT_QODER_ROOT_MAC);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'Qoder');
  return resolveHome(DEFAULT_QODER_ROOT_LINUX);
}

/**
 * Qoder IDE — collects from three data sources:
 *
 *   1. User/History — VSCode-style file edit history snapshots
 *   2. SharedClientCache/cache/db/local.db — SQLite chat_record + chat_session
 *   3. SharedClientCache/cache/ai_tracker/*.jsonl — agent activity tracking
 */
export class QoderInput extends BaseIdeInput {
  readonly id = 'qoder';
  readonly agentType = ClientType.Qoder;
  private lastChatRowId = 0;

  constructor(opts?: Partial<IdeInputOptions> & { stateStore: IdeInputOptions['stateStore'] }) {
    const dataRoot = opts?.dataRoot ?? resolveQoderRoot();
    super({
      stateStore: opts!.stateStore,
      dataRoot,
      snapshotStorePath: opts?.snapshotStorePath
        ?? resolveHome('~/.r2c/logs/qoder/qoder-snapshot-store.json'),
      pollIntervalMs: opts?.pollIntervalMs
        ?? (Number(process.env.QODER_ANALYTICS_POLL_INTERVAL) || 60_000),
      snapshotRetentionMs: opts?.snapshotRetentionMs,
    });
  }

  protected override async onStart(): Promise<void> {
    await super.onStart();
    const saved = this.stateStore.get('qoder-chat-rowid');
    this.lastChatRowId = saved.lastRowId ?? 0;
  }

  static getWatchPaths(): string[] {
    const root = resolveQoderRoot();
    const parent = path.dirname(root);
    return [parent, root];
  }

  static async checkAvailability(): Promise<boolean> {
    try {
      await fs.access(resolveQoderRoot());
      return true;
    } catch {
      return false;
    }
  }

  protected async scanHistoryEntries(sinceTs: number): Promise<CodeGenerationEvent[]> {
    const events: CodeGenerationEvent[] = [];

    // Source 1: VSCode-style file edit history
    await this.scanFileHistory(events, sinceTs);

    // Source 2: SQLite chat_record + chat_session
    await this.scanChatRecords(events);

    // Source 3: ai_tracker JSONL (agent activity)
    await this.scanAiTracker(events, sinceTs);

    return events;
  }

  private async scanFileHistory(events: CodeGenerationEvent[], sinceTs: number): Promise<void> {
    const historyRoot = path.join(this.dataRoot, 'User', 'History');

    let dirs: string[];
    try {
      dirs = await fs.readdir(historyRoot);
    } catch {
      return;
    }

    for (const dir of dirs) {
      const entriesFile = path.join(historyRoot, dir, 'entries.json');
      try {
        const raw = await fs.readFile(entriesFile, 'utf-8');
        const data = JSON.parse(raw) as {
          resource?: string;
          entries?: Array<{ id?: string; timestamp?: number; source?: string }>;
        };
        if (!data.entries || !data.resource) continue;

        for (const entry of data.entries) {
          const ts = entry.timestamp ?? 0;
          if (ts < sinceTs) continue;

          const source = entry.source?.toLowerCase() ?? '';
          const isAI = /qoder|ai|agent|copilot|assistant|completion/.test(source);
          if (!isAI) continue;

          events.push({
            agentType: ClientType.Qoder,
            filePath: data.resource,
            actionType: ActionType.Edit,
            sourceTimestamp: ts,
            rawData: {
              historyDir: dir,
              entryId: entry.id,
              source: entry.source,
              toolName: 'qoder-history',
            },
          });
        }
      } catch { /* skip */ }
    }
  }

  private async scanChatRecords(events: CodeGenerationEvent[]): Promise<void> {
    const dbPath = path.join(this.dataRoot, 'SharedClientCache', 'cache', 'db', 'local.db');
    if (!(await fileExists(dbPath))) return;

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });

      const rows = db.prepare(`
        SELECT
          r.rowid,
          r.request_id,
          r.session_id,
          r.chat_task,
          r.question,
          r.answer,
          r.gmt_create,
          r.mode,
          r.session_type,
          r.summary,
          r.intention_type,
          s.session_title,
          s.project_name
        FROM chat_record r
        LEFT JOIN chat_session s ON r.session_id = s.session_id
        WHERE r.rowid > ?
        ORDER BY r.rowid ASC
        LIMIT 500
      `).all(this.lastChatRowId) as Array<Record<string, unknown>>;

      for (const row of rows) {
        const rowid = row.rowid as number;
        if (rowid > this.lastChatRowId) this.lastChatRowId = rowid;

        const ts = row.gmt_create as number ?? Date.now();
        const question = (row.question as string) ?? '';
        const answer = (row.answer as string) ?? '';

        events.push({
          agentType: ClientType.Qoder,
          filePath: (row.project_name as string) ?? '',
          actionType: ActionType.Other,
          sourceTimestamp: ts,
          content: answer.slice(0, 2000),
          rawData: {
            toolName: 'qoder-chat',
            requestId: row.request_id,
            sessionId: row.session_id,
            sessionTitle: row.session_title,
            chatTask: row.chat_task,
            mode: row.mode,
            sessionType: row.session_type,
            question: question.slice(0, 2000),
            summary: row.summary,
            intentionType: row.intention_type,
            projectName: row.project_name,
          },
        });
      }

      this.stateStore.update('qoder-chat-rowid', { lastRowId: this.lastChatRowId });
    } catch (err) {
      this.logger.warn('failed to scan chat_record', { error: String(err) });
    } finally {
      db?.close();
    }
  }

  private async scanAiTracker(events: CodeGenerationEvent[], sinceTs: number): Promise<void> {
    const trackerDir = path.join(this.dataRoot, 'SharedClientCache', 'cache', 'ai_tracker');

    let files: string[];
    try {
      files = await fs.readdir(trackerDir);
    } catch {
      return;
    }

    for (const file of files.filter(f => f.endsWith('.jsonl'))) {
      const filePath = path.join(trackerDir, file);
      const stateKey = `qoder-tracker:${file}`;
      let offset: number;
      try {
        const stat = await fs.stat(filePath);
        const prev = this.stateStore.get(stateKey);
        offset = prev.lastOffset ?? 0;
        if (stat.size <= offset) continue;

        const handle = await fs.open(filePath, 'r');
        try {
          const buf = Buffer.alloc(stat.size - offset);
          await handle.read(buf, 0, buf.length, offset);
          const text = buf.toString('utf-8');
          this.stateStore.update(stateKey, { lastOffset: stat.size });

          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
              const record = JSON.parse(line) as Record<string, unknown>;
              const fp = record.filePath as string ?? '';
              const aiAddedLines = record.aiAddedLines as string[] ?? [];
              const aiDeletedLines = record.aiDeletedLines as string[] ?? [];
              const modifiedContent = record.aiModifiedContent as string ?? '';

              events.push({
                agentType: ClientType.Qoder,
                filePath: fp,
                actionType: ActionType.Edit,
                sourceTimestamp: Date.now(),
                content: modifiedContent.slice(0, 2000),
                rawData: {
                  toolName: 'qoder-ai-tracker',
                  trackerFile: file,
                  aiAddedLines,
                  aiDeletedLines,
                },
              });
            } catch { /* skip bad lines */ }
          }
        } finally {
          await handle.close();
        }
      } catch (err) {
        this.logger.warn('failed to scan ai_tracker file', { file, error: String(err) });
      }
    }
  }

  protected async buildEntry(event: CodeGenerationEvent): Promise<AgentActivityEntry | null> {
    return buildAgentActivityEntry({
      sessionId: (event.rawData.sessionId as string)
        ?? (event.rawData.entryId as string)
        ?? '',
      userId: '',
      agentType: ClientType.Qoder,
      actionType: event.actionType,
      filePath: event.filePath,
      content: event.content,
      inlineDiffMessage: event.diff,
      timestamp: event.sourceTimestamp,
      extra: event.rawData,
    });
  }
}
