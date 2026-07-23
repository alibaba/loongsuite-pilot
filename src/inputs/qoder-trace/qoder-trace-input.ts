import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { resolveHome, directoryExists, ensureDir } from '../../utils/fs-utils.js';
import { getTodayDateString } from '../../utils/fs-utils.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';
import { filterBootstrapHistoryTurns } from '../base/bootstrap-turn-filter.js';
import { createHookHistoryStartupCheckpoint } from '../base/hook-history-checkpoint.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { readSegmentTokensForSession } from './segment-token-reader.js';
import { readSqliteTokensForSession, isIdeaDbPath } from './sqlite-token-reader.js';
import { readInterceptData, type InterceptData } from './intercept-token-reader.js';
import { enrichCliTurn, enrichIdeTurn, injectTraceId } from './token-enricher.js';

export interface QoderTraceInputOptions extends InputOptions {
  logDir?: string;
}

/**
 * Multi-source merge input for qoder/qoder-cli.
 * Reads hook JSONL (content+structure), session segments (CLI tokens),
 * and SQLite (IDE tokens), merges by variant, outputs enriched events
 * that serve both event logs (SLS) and trace conversion (ARMS).
 */
export class QoderTraceInput extends BaseInput {
  readonly id = 'qoder-trace';
  readonly agentType = ClientType.QoderCli;
  // Primary source is hook JSONL; also reads session segments + SQLite for token enrichment.
  readonly collectionMethod = CollectionMethod.HookJsonl;

  private readonly logDir: string;
  private readonly logPrefix = 'qoder';

  constructor(opts: QoderTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder/history');
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoder'));
  }

  static getWatchPaths(): string[] {
    return [
      resolveHome('~/.loongsuite-pilot/logs/qoder/history'),
      resolveHome('~/.qoder/logs/sessions'),
    ];
  }

  protected override async onStart(): Promise<void> {
    await ensureDir(this.logDir);
    const checkpoint = await createHookHistoryStartupCheckpoint(
      this.getState(),
      this.logDir,
      this.logPrefix,
    );
    if (!checkpoint) return;
    this.setState(checkpoint.state);
    if (checkpoint.skippedExistingBytes > 0) {
      this.logger.warn('history checkpoint missing, baselining existing file without replay', {
        skippedBytes: checkpoint.skippedExistingBytes,
      });
    } else {
      this.logger.info('history checkpoint initialized before first hook record');
    }
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    // 1. Read new hook JSONL lines
    const rawEntries = await this.readHookJsonl();
    if (rawEntries.length === 0) return [];

    // 2. Group by turn.id
    const turnGroups = this.groupByTurn(rawEntries);

    // 3. Enrich each turn. IDE turns are enriched per session so SQLite request_id
    // ordering can be matched against hook turn ordering without timestamp joins.
    // Intercept data is loaded lazily on first qoder-cli turn.
    let interceptData: InterceptData | null = null;
    const ideSessionGroups = new Map<string, AgentActivityEntry[]>();
    for (const [, turnEntries] of turnGroups) {
      const variant = this.inferTurnVariant(turnEntries);
      const sessionId = this.extractSessionId(turnEntries);

      if (variant === 'qoder-cli' && sessionId) {
        interceptData ??= await readInterceptData();
        const segments = await readSegmentTokensForSession(sessionId);
        enrichCliTurn(turnEntries, segments, interceptData.systemPrompt?.content);
      } else if ((variant === 'qoder' || variant === 'qoder-idea') && sessionId) {
        const sessionEntries = ideSessionGroups.get(sessionId) ?? [];
        sessionEntries.push(...turnEntries);
        ideSessionGroups.set(sessionId, sessionEntries);
      }
    }

    for (const [sessionId, sessionEntries] of ideSessionGroups) {
      const { rows: sqliteRows, matchedDbPath } = await readSqliteTokensForSession(sessionId);
      enrichIdeTurn(sessionEntries, sqliteRows);

      // Fix agent type when hook processor couldn't detect qoder-idea (Node < 22 fallback).
      // If all entries are labeled 'qoder' but tokens came from the IntelliJ-specific DB, relabel.
      const needsRelabel = sessionEntries.every(
        e => (e['gen_ai.agent.type'] as string) === ClientType.Qoder,
      );
      if (needsRelabel && isIdeaDbPath(matchedDbPath)) {
        for (const entry of sessionEntries) {
          entry['gen_ai.agent.type'] = ClientType.QoderIdea;
        }
      }
    }

    // 4. Inject trace_id per turn
    for (const turnEntries of turnGroups.values()) {
      injectTraceId(turnEntries);
    }

    return rawEntries;
  }

  // ─── Hook JSONL reading (adapted from BaseHookInput) ────────────────────────

  private async readHookJsonl(): Promise<AgentActivityEntry[]> {
    const today = getTodayDateString();
    const logFileName = `${this.logPrefix}-${today}.jsonl`;
    const logFile = path.join(this.logDir, logFileName);

    let stat;
    try {
      stat = await fs.stat(logFile);
    } catch {
      return [];
    }

    const state = this.getState();
    let offset = state.lastFile === logFileName ? (state.lastOffset ?? 0) : 0;

    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated, resetting offset', { file: logFile, recorded: offset, actual: stat.size });
      offset = 0;
    }
    if (stat.size <= offset) return [];

    const handle = await fs.open(logFile, 'r');
    let entries: AgentActivityEntry[] = [];
    try {
      // NOTE: No MAX_READ_BYTES cap here. Hook JSONL is daily-rotated and typically <100KB/day.
      // If a cap is added in the future, must truncate to last newline to avoid splitting JSONL lines.
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');
      this.setState({ lastFile: logFileName, lastOffset: stat.size });

      const lines = text.split('\n').filter(l => l.trim().length > 0);

      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const entry = await this.transformRecord(record);
          if (entry) entries.push(entry);
        } catch (err) {
          this.logger.warn('invalid JSONL line', { error: String(err) });
        }
      }
    } finally {
      await handle.close();
    }

    entries = filterBootstrapHistoryTurns(entries);

    return entries;
  }

  // ─── Record transformation (canonical passthrough) ──────────────────────────

  private async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    const canonicalEntry = buildCanonicalHookEntry(record, ClientType.QoderCli);
    if (canonicalEntry) {
      await enrichCanonicalEntryWithGit(canonicalEntry, record, 'qoder');
      return canonicalEntry;
    }
    return null;
  }

  // ─── Grouping and variant detection ─────────────────────────────────────────

  private groupByTurn(entries: AgentActivityEntry[]): Map<string, AgentActivityEntry[]> {
    // NOTE: 'unknown' fallback can merge unrelated events if turn.id is missing (legacy JSONL).
    // Current hook processor always injects turn.id, so this only affects pre-existing data.
    const groups = new Map<string, AgentActivityEntry[]>();
    for (const entry of entries) {
      const turnId = (entry['gen_ai.turn.id'] as string) || 'unknown';
      const group = groups.get(turnId) ?? [];
      group.push(entry);
      groups.set(turnId, group);
    }
    return groups;
  }

  private inferTurnVariant(entries: AgentActivityEntry[]): 'qoder-cli' | 'qoder' | 'qoder-idea' {
    for (const entry of entries) {
      const agentType = entry['gen_ai.agent.type'] as string;
      if (agentType === ClientType.QoderCli || agentType === 'qoder-cli') return 'qoder-cli';
      if (agentType === ClientType.QoderIdea || agentType === 'qoder-idea') return 'qoder-idea';
      if (agentType === ClientType.Qoder || agentType === 'qoder') return 'qoder';
    }
    return 'qoder-cli';
  }

  private extractSessionId(entries: AgentActivityEntry[]): string | undefined {
    for (const entry of entries) {
      const sid = entry['gen_ai.session.id'] as string;
      if (sid) return sid;
    }
    return undefined;
  }
}
