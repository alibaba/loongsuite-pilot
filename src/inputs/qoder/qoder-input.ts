import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClientType, ActionType } from '../../types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../types/index.js';
import { BaseIdeInput, type IdeInputOptions } from '../base/base-ide-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome } from '../../utils/fs-utils.js';

const DEFAULT_QODER_ROOT_MAC = '~/Library/Application Support/Qoder';
const DEFAULT_QODER_ROOT_LINUX = '~/.config/Qoder';

function resolveQoderRoot(): string {
  if (process.platform === 'darwin') {
    return resolveHome(DEFAULT_QODER_ROOT_MAC);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Qoder');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'Qoder');
  return resolveHome(DEFAULT_QODER_ROOT_LINUX);
}

/**
 * Qoder IDE — collects from two data sources:
 *
 *   1. User/History — VSCode-style file edit history snapshots
 *   2. SharedClientCache/cache/ai_tracker/*.jsonl — agent activity tracking
 */
export class QoderInput extends BaseIdeInput {
  readonly id = 'qoder';
  readonly agentType = ClientType.Qoder;

  constructor(opts?: Partial<IdeInputOptions> & { stateStore: IdeInputOptions['stateStore'] }) {
    const dataRoot = opts?.dataRoot ?? resolveQoderRoot();
    super({
      stateStore: opts!.stateStore,
      dataRoot,
      snapshotStorePath: opts?.snapshotStorePath
        ?? resolveHome('~/.loongsuite-pilot/logs/qoder/qoder-snapshot-store.json'),
      pollIntervalMs: opts?.pollIntervalMs
        ?? (Number(process.env.QODER_ANALYTICS_POLL_INTERVAL) || 30_000),
      snapshotRetentionMs: opts?.snapshotRetentionMs,
    });
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

    // Source 2: ai_tracker JSONL (agent activity)
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
