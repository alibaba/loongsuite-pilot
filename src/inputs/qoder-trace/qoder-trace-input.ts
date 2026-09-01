import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, MultimodalUploadMode } from '../../types/index.js';
import { mergeAllowedRootPaths } from '../../multimodal/resolve.js';
import type { MultimodalProcessor } from '../../multimodal/processor.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { resolveHome, directoryExists, ensureDir } from '../../utils/fs-utils.js';
import { getTodayDateString } from '../../utils/fs-utils.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';
import { filterBootstrapHistoryTurns } from '../base/bootstrap-turn-filter.js';
import { createHookHistoryStartupCheckpoint } from '../base/hook-history-checkpoint.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { readSegmentTokensForSession, type SegmentTokenData } from './segment-token-reader.js';
import { readSqliteTokensForSession, isIdeaDbPath, resolveQoderAppRoot } from './sqlite-token-reader.js';
import { readInterceptData, type InterceptData } from './intercept-token-reader.js';
import { enrichCliTurn, enrichIdeTurn, injectTraceId } from './token-enricher.js';
import { enrichCliMultimodal } from './qoder-cli-multimodal.js';
import { clearAttachedImagePathsCache, enrichIdeMultimodal } from './qoder-ide-multimodal.js';
import { groupSegmentsByTurn, pickSegGroupByTimeOverlap } from './segment-turn-pairing.js';

export interface QoderTraceInputOptions extends InputOptions {
  logDir?: string;
  /** Cached multimodal policy; IDE + CLI extraction when enabled. */
  multimodal?: {
    enabled: boolean;
    uploadMode?: MultimodalUploadMode;
    processor?: MultimodalProcessor;
    allowedRootPaths?: string[];
  };
}

const QODER_ATTACHMENTS_FIELD = 'agent.qoder.attachments';

function stripQoderAttachmentCarrier(entries: AgentActivityEntry[]): void {
  for (const entry of entries) {
    delete (entry as Record<string, unknown>)[QODER_ATTACHMENTS_FIELD];
  }
}

function isQoderIdeaSession(entries: AgentActivityEntry[]): boolean {
  return entries.some(e => {
    const agentType = e['gen_ai.agent.type'] as string;
    return agentType === ClientType.QoderIdea || agentType === 'qoder-idea';
  });
}

const QODER_IDE_IMAGES_TAIL = path.join('SharedClientCache', 'cache', 'images');

export function qoderDefaultAllowedRootPaths(): string[] {
  const appRoot = resolveQoderAppRoot();
  const roots = [
    resolveHome('~/.qoder/tmp'),
    resolveHome('~/.qoder/vibe_images'),
    path.join(appRoot, QODER_IDE_IMAGES_TAIL),
  ];
  let names: string[];
  try {
    names = fsSync.readdirSync(appRoot);
  } catch {
    return roots;
  }
  for (const name of names) {
    if (name === 'SharedClientCache') continue;
    roots.push(path.join(appRoot, name, QODER_IDE_IMAGES_TAIL));
  }
  return roots;
}

export function resolveQoderAllowedRootPaths(userPaths?: string[]): string[] {
  return mergeAllowedRootPaths(qoderDefaultAllowedRootPaths(), userPaths);
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
  private readonly multimodalEnabled: boolean;
  private readonly multimodalUploadMode: MultimodalUploadMode;
  private readonly multimodalProcessor: MultimodalProcessor | null;
  private readonly allowedRootPaths: string[];
  private multimodalStopped = false;

  constructor(opts: QoderTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder/history');
    this.multimodalEnabled = opts.multimodal?.enabled === true && !!opts.multimodal.processor;
    this.multimodalUploadMode = opts.multimodal?.uploadMode ?? 'none';
    this.multimodalProcessor = opts.multimodal?.processor ?? null;
    this.allowedRootPaths = this.multimodalEnabled
      ? resolveQoderAllowedRootPaths(opts.multimodal?.allowedRootPaths)
      : [];
  }

  override async stop(): Promise<void> {
    this.multimodalStopped = true;
    await super.stop();
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
    this.multimodalStopped = false;
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

  protected override async onStop(): Promise<void> {
    clearAttachedImagePathsCache();
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
    const cliTurns: AgentActivityEntry[][] = [];
    // Segment turns are paired with OTLP turns by timestamp overlap
    // (stateless). seg.turn_id (qoder-cli per-turn UUID) and OTLP
    // gen_ai.turn.id (hook-processor per-turn UUID) come from different sources
    // and do NOT match. A prior sequential-index approach (sessionCliTurnIdx)
    // was stateful and reset per collect() call under incremental collection,
    // so T2/T3 OTLP turns always picked segGroups[0] = T1's segments. TS overlap
    // pairing is stateless: for each OTLP turn, pick the segment group whose
    // [min requestStartTs, max responseEndTs] range overlaps with the OTLP
    // turn's [min, max time_unix_nano] range. Picked groups are spliced out so
    // subsequent turns in the same collect() call don't re-pick them.
    const sessionSegGroups = new Map<string, SegmentTokenData[][]>();
    for (const [, turnEntries] of turnGroups) {
      const variant = this.inferTurnVariant(turnEntries);
      const sessionId = this.extractSessionId(turnEntries);

      if (variant === 'qoder-cli' && sessionId) {
        interceptData ??= await readInterceptData();
        let segGroups = sessionSegGroups.get(sessionId);
        if (!segGroups) {
          const allSegs = await readSegmentTokensForSession(sessionId);
          segGroups = groupSegmentsByTurn(allSegs);
          sessionSegGroups.set(sessionId, segGroups);
        }
        const turnSegs = pickSegGroupByTimeOverlap(segGroups, turnEntries);
        enrichCliTurn(
          turnEntries,
          turnSegs,
          interceptData.systemPrompt?.content,
          interceptData.tokens,
        );
        cliTurns.push(turnEntries);
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

    if (this.multimodalEnabled && this.multimodalProcessor) {
      const pathToUri = async (filePath: string, timeUnixMs?: number) => {
        if (this.multimodalStopped) return null;
        return this.multimodalProcessor!.pathToUri(filePath, timeUnixMs, {
          allowedRootPaths: this.allowedRootPaths,
        });
      };
      for (const sessionEntries of ideSessionGroups.values()) {
        // JetBrains shares this input but has no multimodal extractor yet.
        if (isQoderIdeaSession(sessionEntries)) continue;
        if (this.multimodalStopped) break;
        await enrichIdeMultimodal(sessionEntries, {
          uploadMode: this.multimodalUploadMode,
          pathToUri,
        });
      }
      for (const turnEntries of cliTurns) {
        if (this.multimodalStopped) break;
        await enrichCliMultimodal(turnEntries, {
          uploadMode: this.multimodalUploadMode,
          pathToUri,
        });
      }
    }
    stripQoderAttachmentCarrier(rawEntries);

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

// Segment turn pairing helpers (groupSegmentsByTurn, pickSegGroupByTimeOverlap)
// live in ./segment-turn-pairing.ts — pure logic, unit-testable without
// loading the heavy QoderTraceInput module.

