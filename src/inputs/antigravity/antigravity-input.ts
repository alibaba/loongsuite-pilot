import { createHash } from 'node:crypto';
import * as fileWatch from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import {
  ClientType,
  CollectionMethod,
  multimodalUploadIncludesInput,
  multimodalUploadIncludesOutput,
  type AgentActivityEntry,
  type JsonValue,
  type MultimodalUploadMode,
} from '../../types/index.js';
import {
  attachMultimodalMetadataForEntry,
  convertPathsToUriParts,
  type MultimodalProcessor,
  type PathToUriFn,
  type UriPart,
} from '../../multimodal/index.js';
import { mergeAllowedRootPaths } from '../../multimodal/resolve.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { loadDatabaseSync } from '../../utils/node-sqlite.js';
import { DEFAULT_ANTIGRAVITY_POLL_INTERVAL_MS } from '../../utils/poll-interval.js';
import {
  AntigravityDbReadCache,
  readAntigravityConversationDb,
  type AntigravityConversationSnapshot,
  type AntigravityStepInfo,
  type AntigravityUsageEvent,
} from './sqlite-reader.js';
import {
  AntigravityTranscriptChangedError,
  readAntigravityTranscript,
  type AntigravityTranscript,
  type AntigravityTranscriptCache,
  type AntigravityTranscriptStep,
} from './transcript-reader.js';
import {
  modelResolutionRank,
  normalizeAntigravityModel,
  resolveAntigravityProvider,
} from './model-normalizer.js';

export type AntigravityClientType =
  | ClientType.Antigravity
  | ClientType.AntigravityCli;

const DEFAULT_ROOT_SEGMENTS: Readonly<Record<AntigravityClientType, string>> = {
  [ClientType.Antigravity]: '~/.gemini/antigravity',
  [ClientType.AntigravityCli]: '~/.gemini/antigravity-cli',
};

const MAX_DBS_PER_CYCLE = 16;
const MAX_CACHED_SESSIONS = 16;
const WATCH_BATCH_MS = 300;
const SOURCE_AUDIT_DELAY_MS = 30_000;
const SOURCE_AUDIT_MAX_DELAY_MS = 120_000;
const BACKLOG_DRAIN_DELAY_MS = 50;
const TRANSCRIPT_JOIN_GRACE_MS = 30_000;
const DB_FAILURE_BACKOFF_BASE_MS = 15_000;
const DB_FAILURE_BACKOFF_MAX_MS = 300_000;

const EVENT_ORDER_WEIGHT: Readonly<Record<string, number>> = {
  other: 0,
  'agent.input': 0,
  'llm.request': 1,
  'llm.response': 2,
  'tool.call': 3,
  'tool.result': 4,
};

const NON_TOOL_RESULT_STEP_TYPES = new Set([
  'PLANNER_RESPONSE',
  'USER_INPUT',
  'SYSTEM_MESSAGE',
  'CHECKPOINT',
  'CONVERSATION_HISTORY',
  'KNOWLEDGE_ARTIFACTS',
  'TASK_BOUNDARY',
]);

const TURN_BOUNDARY_STEP_TYPES = new Set([
  'PLANNER_RESPONSE',
  'USER_INPUT',
  'SYSTEM_MESSAGE',
]);

const IN_PROGRESS_STEP_STATUSES = new Set([
  'RUNNING',
  'PENDING',
  'IN_PROGRESS',
  'GENERATING',
  'WAITING',
]);

function isStepInProgress(step: AntigravityTranscriptStep): boolean {
  return typeof step.status === 'string' && IN_PROGRESS_STEP_STATUSES.has(step.status.toUpperCase());
}

function isToolResultStep(step: AntigravityTranscriptStep): boolean {
  return !NON_TOOL_RESULT_STEP_TYPES.has(step.type);
}

function isCancelledStatus(status: string | undefined): boolean {
  if (!status) return false;
  const upper = status.toUpperCase();
  return upper === 'CANCELED' || upper === 'CANCELLED';
}

function isToolErrorStatus(status: string | undefined): boolean {
  if (!status) return false;
  const upper = status.toUpperCase();
  return upper === 'ERROR' || upper === 'CANCELED' || upper === 'CANCELLED';
}

function plannerFinishReason(step: AntigravityTranscriptStep | undefined): 'cancelled' | 'tool_call' | 'stop' {
  if (isCancelledStatus(step?.status)) return 'cancelled';
  return step?.toolCalls.length ? 'tool_call' : 'stop';
}

function usageResponseKey(usage: AntigravityUsageEvent): string | undefined {
  return usage.identities.find((id) => id.startsWith('response:'));
}

function extractStepOrder(stepId: string | undefined): number {
  if (!stepId) return Number.MAX_SAFE_INTEGER;
  const m = /:(?:step|gen):(\d+)$/.exec(stepId);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

interface PendingToolCall {
  plannerStepIndex: number;
  /** Ordinal index of this tool call within the parent PLANNER_RESPONSE (0-based). */
  toolIndex?: number;
  turnId: string;
  stepId: string;
  resultStepIndex: number;
  callId: string;
  toolName: string;
  model?: string;
  callTsMs?: number;
}

interface SourceAudit {
  atMs: number;
  byMs: number;
}

interface PendingPlanner {
  turnId: string;
  responseId: string;
  stepIndices: number[];
  provider: string;
  isRetry: boolean;
}

interface SessionCheckpoint {
  sourceSignature?: string;
  /** Durable deadlines to verify older records after incremental reads. */
  dbAudit?: SourceAudit;
  transcriptAudit?: SourceAudit;
  /** Earliest deadline for rechecking an incomplete SQLite/transcript join. */
  retryAtMs?: number;
  joinDeadlines?: Record<string, number>;
  pendingPlanners?: PendingPlanner[];
  emittedUsageKeys: string[];
  usageResponseKeysBySource?: Record<string, string>;
  /** Legacy eviction state, used only on the first rescan of older checkpoints. */
  maxEmittedGenIdx?: number;
  maxEmittedStepIdx?: number;
  deferredGenIdxs?: number[];
  deferredStepIdxs?: number[];
  /** Emitted response IDs retained for cross-cycle collision disambiguation. */
  emittedResponseIds?: string[];
  /** Step indices whose primary LLM usage has already been emitted across cycles (for retry detection). */
  emittedPrimaryStepIdxs?: number[];
  lastTranscriptStepIndex: number;
  processedTranscriptSteps?: number[];
  pendingToolCalls: PendingToolCall[];
  /** Latched turnId per turn-start stepIndex so delayed native UUIDs never split an already-emitted turn. */
  turnIdByStartStep?: Record<string, string>;
  /** Turn IDs that have already emitted `gen_ai.turn.start: true`. */
  emittedTurnStarts?: string[];
  /** Turn IDs for which this input has already published a terminal response. */
  endedTurns?: string[];
  /** Model completed while a tool result or earlier planner was still outstanding. */
  turnsAwaitingToolResults?: string[];
  /** Latched tool call IDs keyed by `${plannerStepIndex}:${toolIndex}` for cross-cycle stability. */
  toolCallIdMap?: Record<string, string>;
  /** Committed result step indices keyed by the same planner step and call ordinal. */
  toolResultStepIndexMap?: Record<string, number>;
}

interface AntigravityCheckpoint {
  schema: 1;
  seeded: boolean;
  /** Legacy cutoff, discarded after the first inventory of existing sessions. */
  evictedWatermarkMtimeMs?: number;
  /** Sessions discovered during initial seed whose DB failed to read transiently. */
  pendingSeedSessionIds?: string[];
  sessions: Record<string, SessionCheckpoint>;
}

export interface AntigravityMultimodalOptions {
  enabled: boolean;
  uploadMode: MultimodalUploadMode;
  allowedRootPaths?: string[];
  processor?: Pick<MultimodalProcessor, 'pathToUri'>;
  /** Optional direct override for unit tests. */
  pathToUri?: PathToUriFn;
}

export interface AntigravityInputOptions extends InputOptions {
  /** Which Antigravity product variant this input represents. */
  clientType: AntigravityClientType;
  /** Optional override for the product data root (defaults to ~/.gemini/antigravity*). */
  dataRoot?: string;
  /**
   * When false (default in production), a fresh start without prior checkpoint
   * seeds existing conversation files without replaying historical events.
   * Set true in tests or backfill runs to emit existing events immediately.
   */
  collectHistorical?: boolean;
  /** Optional opt-in multimodal upload configuration. */
  multimodal?: AntigravityMultimodalOptions;
}

function hashId(parts: readonly string[], length: number): string {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, length);
  return /^0+$/.test(hex) ? `${'0'.repeat(length - 1)}1` : hex;
}

function toUnixNanoString(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : Date.now();
  return `${BigInt(safeMs) * 1_000_000n}`;
}

async function statFileInfo(filePath: string): Promise<{
  mtimeMs: number;
  signature: string;
  stat?: fileWatch.BigIntStats;
}> {
  try {
    const st = await fs.stat(filePath, { bigint: true });
    if (st.isFile()) {
      return {
        mtimeMs: Number(st.mtimeNs) / 1_000_000,
        signature: `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${st.size}`,
        stat: st,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { mtimeMs: 0, signature: '' };
}

function loadSourceAudit(value: SourceAudit | undefined): SourceAudit | undefined {
  return Number.isFinite(value?.atMs) && Number.isFinite(value?.byMs) ? value : undefined;
}

function nextSourceAudit(previous: SourceAudit | undefined, changed: boolean, readFull: boolean, nowMs: number): SourceAudit | undefined {
  if (readFull) return undefined;
  if (!changed) return previous;
  const byMs = previous?.byMs ?? nowMs + SOURCE_AUDIT_MAX_DELAY_MS;
  return { atMs: Math.min(nowMs + SOURCE_AUDIT_DELAY_MS, byMs), byMs };
}

function isLegacyUsageCovered(
  usage: AntigravityUsageEvent,
  cursor: SessionCheckpoint,
  seenKeys: Set<string>,
): boolean {
  if (cursor.sourceSignature !== undefined) return false;
  if (usage.identities.some((id) => seenKeys.has(id))) return true;
  if (usage.isRetry) return false;
  if (usage.genIdx !== undefined) {
    return usage.genIdx <= (cursor.maxEmittedGenIdx ?? -1)
      && !cursor.deferredGenIdxs?.includes(usage.genIdx);
  }
  return usage.stepIndices.length > 0
    && usage.stepIndices.every((idx) =>
      idx <= (cursor.maxEmittedStepIdx ?? -1) && !cursor.deferredStepIdxs?.includes(idx),
    );
}

function binarySearchTurnNumber(userInputSteps: readonly number[], targetStep: number): number {
  let lo = 0;
  let hi = userInputSteps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (userInputSteps[mid]! <= targetStep) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}

export class AntigravityInput extends BaseInput {
  readonly id: string;
  readonly agentType: AntigravityClientType;
  readonly collectionMethod = CollectionMethod.SqlitePolling;

  private readonly dataRoot: string;
  private readonly conversationsDir: string;
  private readonly collectHistorical: boolean;
  private readonly multimodalUploadMode: MultimodalUploadMode;
  private readonly pathToUri?: PathToUriFn;
  private pendingCheckpoint: AntigravityCheckpoint | null = null;
  private lastCheckpoint?: AntigravityCheckpoint;
  private backlogTimer: ReturnType<typeof setTimeout> | null = null;
  private conversationsWatcher: fileWatch.FSWatcher | null = null;
  private watchedDirectoryId?: string;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private watchNeedsInventory = false;
  private needsInventory = true;
  private readonly watchingSessions = new Set<string>();
  private readonly watchedChanges = new Set<string>();
  private readonly readySessions = new Set<string>();
  private readonly scheduledSessions = new Map<string, number>();
  private readonly sourceCaches = new Map<string, {
    db: AntigravityDbReadCache;
    transcript: AntigravityTranscriptCache;
  }>();
  private readonly failedDbBackoff = new Map<string, { failures: number; retryAfterMs: number }>();
  private warnedSqliteUnavailable = false;

  constructor(opts: AntigravityInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_ANTIGRAVITY_POLL_INTERVAL_MS });
    this.agentType = opts.clientType;
    this.id = opts.clientType;
    this.dataRoot = opts.dataRoot
      ? path.resolve(resolveHome(opts.dataRoot))
      : AntigravityInput.getDefaultDataRoot(opts.clientType);
    this.conversationsDir = path.join(this.dataRoot, 'conversations');
    this.collectHistorical = opts.collectHistorical ?? false;

    const mm = opts.multimodal;
    if (mm?.enabled && mm.uploadMode !== 'none') {
      this.multimodalUploadMode = mm.uploadMode;
      if (mm.pathToUri) {
        this.pathToUri = mm.pathToUri;
      } else if (mm.processor) {
        const processor = mm.processor;
        const allowedRootPaths = mergeAllowedRootPaths(
          [path.join(this.dataRoot, 'brain')],
          mm.allowedRootPaths,
        );
        this.pathToUri = (filePath, timeMs) =>
          processor.pathToUri(filePath, timeMs, { allowedRootPaths });
      }
    } else {
      this.multimodalUploadMode = 'none';
    }
  }

  static getDefaultDataRoot(clientType: AntigravityClientType): string {
    return resolveHome(DEFAULT_ROOT_SEGMENTS[clientType]);
  }

  static getWatchPaths(clientType: AntigravityClientType, dataRoot?: string): string[] {
    const root = dataRoot
      ? path.resolve(resolveHome(dataRoot))
      : AntigravityInput.getDefaultDataRoot(clientType);
    return [root, path.join(root, 'conversations')];
  }

  static async checkAvailability(
    clientType: AntigravityClientType,
    dataRoot?: string,
  ): Promise<boolean> {
    const root = dataRoot
      ? path.resolve(resolveHome(dataRoot))
      : AntigravityInput.getDefaultDataRoot(clientType);
    if (await directoryExists(path.join(root, 'conversations'))) return true;
    return directoryExists(root);
  }

  private clearBacklogTimer(): void {
    if (this.backlogTimer) {
      clearTimeout(this.backlogTimer);
      this.backlogTimer = null;
    }
  }

  protected override async onStop(): Promise<void> {
    this.clearBacklogTimer();
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.conversationsWatcher?.close();
    this.conversationsWatcher = null;
    this.watchedDirectoryId = undefined;
    this.watchNeedsInventory = false;
    this.needsInventory = true;
    this.watchingSessions.clear();
    this.watchedChanges.clear();
    this.readySessions.clear();
    this.scheduledSessions.clear();
    this.sourceCaches.clear();
    this.failedDbBackoff.clear();
    this.lastCheckpoint = undefined;
  }

  protected override onPoll(): void {
    this.needsInventory = true;
    this.requestCollection(true);
  }

  private async ensureConversationWatcher(): Promise<void> {
    let directoryId: string | undefined;
    try {
      const stat = await fs.stat(this.conversationsDir, { bigint: true });
      if (stat.isDirectory()) directoryId = `${stat.dev}:${stat.ino}`;
    } catch {
      // The inventory handles an absent directory and reports unreadable paths.
    }
    if (!this.running || (this.conversationsWatcher && this.watchedDirectoryId === directoryId)) return;
    this.conversationsWatcher?.close();
    this.conversationsWatcher = null;
    this.watchedDirectoryId = undefined;
    if (!directoryId) return;

    try {
      const watcher = fileWatch.watch(this.conversationsDir, { persistent: false }, (_event, filename) => {
        if (!this.running || this.conversationsWatcher !== watcher) return;
        if (filename) {
          if (filename.includes('/') || filename.includes('\\')) return;
          const dbName = filename.endsWith('.db-wal') ? filename.slice(0, -4) : filename;
          const sessionId = this.sessionIdFromDbName(dbName);
          if (!sessionId) return;
          this.watchingSessions.add(sessionId);
        } else {
          this.watchNeedsInventory = true;
        }
        this.scheduleWatchCollection();
      });
      this.conversationsWatcher = watcher;
      this.watchedDirectoryId = directoryId;
      watcher.on('error', () => {
        if (this.conversationsWatcher !== watcher) return;
        watcher.close();
        this.conversationsWatcher = null;
        this.watchedDirectoryId = undefined;
        // Inventory on the next regular poll. Immediate reattachment can spin
        // if the OS has exhausted its watch resources.
      });
    } catch {
      // Polling also covers systems where a filesystem watch is unavailable.
    }
  }

  private sessionIdFromDbName(name: string): string | undefined {
    if (name === 'conversation_summaries.db' || !name.endsWith('.db')) return undefined;
    const sessionId = name.slice(0, -3);
    return sessionId && sessionId !== '.' && sessionId !== '..' ? sessionId : undefined;
  }

  private scheduleWatchCollection(): void {
    if (this.watchTimer) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.needsInventory ||= this.watchNeedsInventory;
      this.watchNeedsInventory = false;
      for (const sessionId of this.watchingSessions) this.watchedChanges.add(sessionId);
      this.watchingSessions.clear();
      this.requestCollection(true);
    }, WATCH_BATCH_MS);
  }

  protected override onEntriesQueued(): void {
    if (!this.pendingCheckpoint) return;
    const cp = this.pendingCheckpoint;
    this.pendingCheckpoint = null;
    this.saveCheckpoint(cp);
  }

  private loadCheckpoint(): AntigravityCheckpoint {
    const state = this.stateStore.get(this.id);
    const raw = state?.extra?.antigravityCheckpoint;
    if (this.lastCheckpoint && raw === this.lastCheckpoint) {
      // Earlier revisions may still be waiting for a durable output ACK.
      // Share unchanged session records and keep each revision's map immutable.
      return { ...this.lastCheckpoint, sessions: Object.assign(Object.create(null), this.lastCheckpoint.sessions) };
    }
    if (raw && typeof raw === 'object' && (raw as AntigravityCheckpoint).schema === 1) {
      const cp = raw as Partial<AntigravityCheckpoint>;
      const sessions: Record<string, SessionCheckpoint> = Object.create(null);
      if (cp.sessions && typeof cp.sessions === 'object') {
        for (const [sid, cur] of Object.entries(cp.sessions)) {
          if (!cur || typeof cur !== 'object') continue;
          const pendingToolCalls: PendingToolCall[] = Array.isArray(cur.pendingToolCalls)
            ? cur.pendingToolCalls.filter(
                (p): p is PendingToolCall =>
                  Boolean(p) &&
                  typeof p === 'object' &&
                  typeof p.plannerStepIndex === 'number' &&
                  typeof p.resultStepIndex === 'number' &&
                  typeof p.callId === 'string' &&
                  typeof p.toolName === 'string' &&
                  typeof p.turnId === 'string' &&
                  typeof p.stepId === 'string',
              )
            : [];
          const emittedUsageKeys = Array.isArray(cur.emittedUsageKeys)
            ? cur.emittedUsageKeys.filter((k): k is string => typeof k === 'string')
            : [];
          const turnIdByStartStep: Record<string, string> | undefined =
            cur.turnIdByStartStep && typeof cur.turnIdByStartStep === 'object'
              ? Object.fromEntries(
                  Object.entries(cur.turnIdByStartStep).filter(
                    (kv): kv is [string, string] => typeof kv[1] === 'string',
                  ),
                )
              : undefined;
          const emittedTurnStarts = Array.isArray(cur.emittedTurnStarts)
            ? cur.emittedTurnStarts.filter((t): t is string => typeof t === 'string')
            : undefined;
          const toolCallIdMap: Record<string, string> | undefined =
            cur.toolCallIdMap && typeof cur.toolCallIdMap === 'object'
              ? Object.fromEntries(
                  Object.entries(cur.toolCallIdMap).filter(
                    (kv): kv is [string, string] => typeof kv[1] === 'string',
                  ),
                )
              : undefined;
          const toolResultStepIndexMap =
            cur.toolResultStepIndexMap && typeof cur.toolResultStepIndexMap === 'object'
              ? Object.fromEntries(Object.entries(cur.toolResultStepIndexMap).filter(
                  ([, index]) => Number.isSafeInteger(index) && index >= 0,
                ))
              : undefined;
          const deferredGenIdxs = Array.isArray(cur.deferredGenIdxs)
            ? cur.deferredGenIdxs.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
            : undefined;
          const deferredStepIdxs = Array.isArray(cur.deferredStepIdxs)
            ? cur.deferredStepIdxs.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
            : undefined;
          const emittedResponseIds = Array.isArray(cur.emittedResponseIds)
            ? cur.emittedResponseIds.filter((s): s is string => typeof s === 'string')
            : undefined;
          const emittedPrimaryStepIdxs = Array.isArray(cur.emittedPrimaryStepIdxs)
            ? cur.emittedPrimaryStepIdxs.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
            : undefined;
          sessions[sid] = {
            sourceSignature: typeof cur.sourceSignature === 'string' ? cur.sourceSignature : undefined,
            dbAudit: loadSourceAudit(cur.dbAudit),
            transcriptAudit: loadSourceAudit(cur.transcriptAudit),
            retryAtMs: typeof cur.retryAtMs === 'number' ? cur.retryAtMs : undefined,
            joinDeadlines: cur.joinDeadlines,
            pendingPlanners: Array.isArray(cur.pendingPlanners) ? cur.pendingPlanners.filter(pending =>
              pending && typeof pending.turnId === 'string' && typeof pending.responseId === 'string' &&
              typeof pending.provider === 'string' && typeof pending.isRetry === 'boolean' &&
              Array.isArray(pending.stepIndices) && pending.stepIndices.length > 0 &&
              pending.stepIndices.every(idx => Number.isSafeInteger(idx) && idx >= 0),
            ) : undefined,
            maxEmittedGenIdx: typeof cur.maxEmittedGenIdx === 'number' ? cur.maxEmittedGenIdx : -1,
            maxEmittedStepIdx:
              typeof cur.maxEmittedStepIdx === 'number' ? cur.maxEmittedStepIdx : -1,
            emittedUsageKeys,
            usageResponseKeysBySource: cur.usageResponseKeysBySource,
            ...(deferredGenIdxs && deferredGenIdxs.length > 0 ? { deferredGenIdxs } : {}),
            ...(deferredStepIdxs && deferredStepIdxs.length > 0 ? { deferredStepIdxs } : {}),
            ...(emittedResponseIds && emittedResponseIds.length > 0 ? { emittedResponseIds } : {}),
            ...(emittedPrimaryStepIdxs && emittedPrimaryStepIdxs.length > 0
              ? { emittedPrimaryStepIdxs }
              : {}),
            lastTranscriptStepIndex:
              typeof cur.lastTranscriptStepIndex === 'number' ? cur.lastTranscriptStepIndex : -1,
            processedTranscriptSteps: cur.processedTranscriptSteps,
            pendingToolCalls,
            ...(turnIdByStartStep && Object.keys(turnIdByStartStep).length > 0
              ? { turnIdByStartStep }
              : {}),
            ...(emittedTurnStarts && emittedTurnStarts.length > 0 ? { emittedTurnStarts } : {}),
            endedTurns: cur.endedTurns,
            turnsAwaitingToolResults: cur.turnsAwaitingToolResults,
            ...(toolCallIdMap && Object.keys(toolCallIdMap).length > 0 ? { toolCallIdMap } : {}),
            ...(toolResultStepIndexMap && Object.keys(toolResultStepIndexMap).length > 0
              ? { toolResultStepIndexMap }
              : {}),
          };
        }
      }
      const pendingSeedSessionIds = Array.isArray(cp.pendingSeedSessionIds)
        ? cp.pendingSeedSessionIds.filter((id): id is string => typeof id === 'string')
        : [];
      return {
        schema: 1,
        seeded: Boolean(cp.seeded),
        evictedWatermarkMtimeMs: typeof cp.evictedWatermarkMtimeMs === 'number'
          ? cp.evictedWatermarkMtimeMs : undefined,
        ...(pendingSeedSessionIds.length > 0 ? { pendingSeedSessionIds } : {}),
        sessions,
      };
    }
    return { schema: 1, seeded: false, sessions: Object.create(null) };
  }

  private saveCheckpoint(cp: AntigravityCheckpoint): void {
    const prev = this.stateStore.get(this.id);
    this.stateStore.set(this.id, {
      ...prev,
      lastTimestamp: Date.now(),
      extra: {
        ...(prev?.extra ?? {}),
        antigravityCheckpoint: cp,
      },
    });
    this.lastCheckpoint = cp;
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    this.pendingCheckpoint = null;
    this.clearBacklogTimer();

    if (!loadDatabaseSync()) {
      if (!this.warnedSqliteUnavailable) {
        this.warnedSqliteUnavailable = true;
        this.logger.warn(
          'node:sqlite is unavailable; Antigravity collection disabled (requires Node.js >= 22.13 or >= 23.4)',
          { agentType: this.agentType },
        );
      }
      return [];
    }

    const checkpoint = this.loadCheckpoint();
    const isFreshSeed = !checkpoint.seeded && !this.collectHistorical;

    const nowMs = Date.now();
    const watchedChanges = new Set(this.watchedChanges);
    const sessionIds = new Set([...this.readySessions, ...watchedChanges]);
    this.readySessions.clear();
    this.watchedChanges.clear();
    for (const [sessionId, deadline] of this.scheduledSessions) {
      if (deadline <= nowMs) sessionIds.add(sessionId);
    }
    if (isFreshSeed || this.needsInventory) {
      this.needsInventory = false;
      await this.ensureConversationWatcher();
      let dirEntries: string[];
      try {
        dirEntries = await fs.readdir(this.conversationsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.needsInventory = true;
          throw err;
        }
        dirEntries = [];
      }
      const presentSessionIds = new Set(dirEntries.sort().flatMap(name => {
        const sessionId = this.sessionIdFromDbName(name);
        return sessionId ? [sessionId] : [];
      }));
      for (const sessionId of presentSessionIds) sessionIds.add(sessionId);
      for (const sessionId of this.sourceCaches.keys()) {
        if (!presentSessionIds.has(sessionId)) this.sourceCaches.delete(sessionId);
      }
      for (const sessionId of this.scheduledSessions.keys()) {
        if (presentSessionIds.has(sessionId)) continue;
        this.scheduledSessions.delete(sessionId);
        this.failedDbBackoff.delete(sessionId);
      }
    }
    const pendingSeedSet = new Set(checkpoint.pendingSeedSessionIds ?? []);
    if (isFreshSeed) {
      for (const id of sessionIds) pendingSeedSet.add(id);
    }

    const legacyEvictionCutoff = checkpoint.evictedWatermarkMtimeMs ?? 0;
    const candidates: Array<{
      sessionId: string;
      dbPath: string;
      mtimeMs: number;
      sourceSignature: string;
      transcriptStat?: fileWatch.BigIntStats;
      dbChanged: boolean;
      transcriptChanged: boolean;
    }> = [];

    for (const sessionId of sessionIds) {
      if (!this.running) return [];
      const backoff = this.failedDbBackoff.get(sessionId);
      if (backoff && nowMs < backoff.retryAfterMs) {
        if (watchedChanges.has(sessionId)) this.watchedChanges.add(sessionId);
        this.scheduledSessions.set(sessionId, backoff.retryAfterMs);
        continue;
      }

      const dbPath = path.join(this.conversationsDir, `${sessionId}.db`);
      const transcriptPath = path.join(
        this.dataRoot, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl',
      );
      try {
        const [dbInfo, walInfo, transcriptInfo] = await Promise.all([
          statFileInfo(dbPath), statFileInfo(`${dbPath}-wal`), statFileInfo(transcriptPath),
        ]);
        if (!dbInfo.signature) {
          this.scheduledSessions.delete(sessionId);
          this.failedDbBackoff.delete(sessionId);
          this.sourceCaches.delete(sessionId);
          continue;
        }

        const mtimeMs = Math.max(dbInfo.mtimeMs, walInfo.mtimeMs, transcriptInfo.mtimeMs);
        const sourceSignature = [dbInfo.signature, walInfo.signature, transcriptInfo.signature].join('|');
        const prev = checkpoint.sessions[sessionId];
        // The old checkpoint cannot enumerate its evicted sessions. Seed the
        // existing files it would have skipped once, then retain exact cursors.
        if (!prev && legacyEvictionCutoff > 0 && mtimeMs <= legacyEvictionCutoff) {
          pendingSeedSet.add(sessionId);
        }
        const [prevDb, prevWal, prevTranscript] = prev?.sourceSignature?.split('|') ?? [];
        const dbChanged = watchedChanges.has(sessionId) || dbInfo.signature !== prevDb || walInfo.signature !== prevWal;
        const transcriptChanged = transcriptInfo.signature !== prevTranscript;
        if (!dbChanged && !transcriptChanged && prev && !pendingSeedSet.has(sessionId)) {
          const nextReadAt = Math.min(prev.retryAtMs ?? Infinity, prev.dbAudit?.atMs ?? Infinity, prev.transcriptAudit?.atMs ?? Infinity);
          if (nowMs < nextReadAt) {
            this.scheduleSession(sessionId, nextReadAt);
            continue;
          }
        }
        candidates.push({ sessionId, dbPath, mtimeMs, sourceSignature, transcriptStat: transcriptInfo.stat, dbChanged, transcriptChanged });
      } catch (err) {
        if (watchedChanges.has(sessionId)) this.watchedChanges.add(sessionId);
        this.scheduledSessions.set(sessionId, this.backOffSession(sessionId, err));
      }
    }

    // Drain older pending work first, even when other sessions keep receiving writes.
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const batch = candidates.splice(0, MAX_DBS_PER_CYCLE);
    for (const { sessionId } of candidates) {
      this.readySessions.add(sessionId);
      if (watchedChanges.has(sessionId)) this.watchedChanges.add(sessionId);
    }
    const emitted: AgentActivityEntry[] = [];
    let checkpointDirty = isFreshSeed || legacyEvictionCutoff > 0;
    const isRunning = () => this.running;

    for (const candidate of batch) {
      if (!this.running) break;
      const { sessionId, sourceSignature } = candidate;
      try {
        const previous = checkpoint.sessions[sessionId];
        const cached = this.sourceCaches.get(sessionId);
        const sources = cached ?? { db: new AntigravityDbReadCache(), transcript: {} };
        const fullDb = !cached || (previous?.dbAudit?.atMs ?? Infinity) <= nowMs;
        const fullTranscript = !cached || (previous?.transcriptAudit?.atMs ?? Infinity) <= nowMs;
        const transcript = await readAntigravityTranscript(this.dataRoot, sessionId, isRunning, {
          cache: sources.transcript,
          forceFullRead: fullTranscript,
          observedStat: candidate.transcriptStat,
        });
        if (!this.running) break;
        const snapshot = await readAntigravityConversationDb(candidate.dbPath, isRunning, {
          cache: sources.db,
          forceFull: fullDb,
          refreshWorkspace: this.workspacePolicy.enabled,
          stepIndices: [
            ...(previous?.pendingToolCalls ?? []).flatMap(call => [call.plannerStepIndex, call.resultStepIndex]),
            ...(transcript?.changedStepIndices ?? []),
            ...(previous?.deferredStepIdxs ?? []),
          ],
        });
        if (!this.running) break;

        // Quiet sessions reconcile once after the burst. A continuous writer
        // cannot postpone historical reconciliation beyond the persisted cap.
        const dbAudit = nextSourceAudit(previous?.dbAudit, candidate.dbChanged, fullDb, nowMs);
        const transcriptAudit = nextSourceAudit(previous?.transcriptAudit, candidate.transcriptChanged, fullTranscript, nowMs);
        const seed = pendingSeedSet.has(sessionId);
        const workspaceAllowed = this.workspacePolicy.allows(
          {
            'gen_ai.agent.type': this.agentType,
            'gen_ai.session.id': sessionId,
            ...(snapshot?.workspacePaths ? { workspace_roots: snapshot.workspacePaths } : {}),
          },
          this.agentType,
        );
        if (seed || !workspaceAllowed) {
          const seededKeys = new Set(previous?.emittedUsageKeys);
          const responseKeysBySource = new Map(Object.entries(previous?.usageResponseKeysBySource ?? {}));
          for (const usage of snapshot?.events ?? []) {
            const responseKey = usageResponseKey(usage);
            if (responseKey) seededKeys.add(responseKey);
            for (const key of usage.sourceKeys) {
              seededKeys.add(key);
              if (responseKey) responseKeysBySource.set(key, responseKey);
            }
          }
          checkpoint.sessions[sessionId] = {
            ...previous,
            sourceSignature,
            dbAudit,
            transcriptAudit,
            retryAtMs: undefined,
            joinDeadlines: undefined,
            pendingPlanners: undefined,
            emittedUsageKeys: [...seededKeys],
            usageResponseKeysBySource: Object.fromEntries(responseKeysBySource),
            lastTranscriptStepIndex: previous?.lastTranscriptStepIndex ?? -1,
            processedTranscriptSteps: [...new Set([
              ...(previous?.processedTranscriptSteps ?? []),
              ...(transcript?.steps ?? []).map((step) => step.stepIndex),
            ])],
            pendingToolCalls: [],
          };
          pendingSeedSet.delete(sessionId);
        } else if (this.workspacePolicy.enabled && !snapshot?.workspacePaths?.length) {
          // No content or media may leave while the exclusion policy cannot yet
          // determine the workspace. Retain the old event ledger for the next write.
          checkpoint.sessions[sessionId] = {
            ...previous,
            sourceSignature,
            dbAudit,
            transcriptAudit,
            retryAtMs: undefined,
            emittedUsageKeys: previous?.emittedUsageKeys ?? [],
            lastTranscriptStepIndex: previous?.lastTranscriptStepIndex ?? -1,
            pendingToolCalls: previous?.pendingToolCalls ?? [],
          };
        } else {
          const prevCursor: SessionCheckpoint = previous ?? {
            emittedUsageKeys: [],
            lastTranscriptStepIndex: -1,
            pendingToolCalls: [],
          };
          const { entries, cursor } = await this.buildSessionEntries(sessionId, snapshot, transcript, prevCursor);
          if (!this.running) break;
          for (const entry of entries) emitted.push(entry);
          checkpoint.sessions[sessionId] = { ...cursor, sourceSignature, dbAudit, transcriptAudit };
        }
        this.sourceCaches.delete(sessionId);
        this.sourceCaches.set(sessionId, sources);
        if (this.sourceCaches.size > MAX_CACHED_SESSIONS) {
          const oldest = this.sourceCaches.keys().next().value;
          if (oldest !== undefined) this.sourceCaches.delete(oldest);
        }
        this.scheduleSession(sessionId, Math.min(
          checkpoint.sessions[sessionId]!.retryAtMs ?? Infinity,
          dbAudit?.atMs ?? Infinity,
          transcriptAudit?.atMs ?? Infinity,
        ));
        this.failedDbBackoff.delete(sessionId);
        checkpointDirty = true;
      } catch (err) {
        if (watchedChanges.has(sessionId)) this.watchedChanges.add(sessionId);
        if (err instanceof AntigravityTranscriptChangedError) {
          this.readySessions.add(sessionId);
          this.scheduleSession(sessionId, Date.now() + WATCH_BATCH_MS);
          continue;
        }
        this.sourceCaches.delete(sessionId);
        this.scheduledSessions.set(sessionId, this.backOffSession(sessionId, err));
      }
    }

    if (checkpointDirty) {
      checkpoint.seeded = true;
      delete checkpoint.evictedWatermarkMtimeMs;
      checkpoint.pendingSeedSessionIds = pendingSeedSet.size > 0 ? [...pendingSeedSet] : undefined;
      if (emitted.length > 0) this.pendingCheckpoint = checkpoint;
      else this.saveCheckpoint(checkpoint);
    }

    let nextRetryAt = candidates.length > 0 ? Date.now() + BACKLOG_DRAIN_DELAY_MS : Infinity;
    for (const deadline of this.scheduledSessions.values()) nextRetryAt = Math.min(nextRetryAt, deadline);
    if (Number.isFinite(nextRetryAt) && this.running) {
      this.backlogTimer = setTimeout(() => {
        this.backlogTimer = null;
        this.requestCollection(true);
      }, Math.max(BACKLOG_DRAIN_DELAY_MS, nextRetryAt - Date.now()));
    }

    return emitted;
  }

  private scheduleSession(sessionId: string, deadline: number): void {
    if (Number.isFinite(deadline)) this.scheduledSessions.set(sessionId, deadline);
    else this.scheduledSessions.delete(sessionId);
  }

  private backOffSession(sessionId: string, error: unknown): number {
    const failures = (this.failedDbBackoff.get(sessionId)?.failures ?? 0) + 1;
    const delayMs = Math.min(DB_FAILURE_BACKOFF_MAX_MS, DB_FAILURE_BACKOFF_BASE_MS * 2 ** (failures - 1));
    const retryAfterMs = Date.now() + delayMs;
    this.failedDbBackoff.set(sessionId, { failures, retryAfterMs });
    this.logger.warn('failed to read Antigravity conversation', {
      agentType: this.agentType,
      sessionId,
      error: String(error),
    });
    return retryAfterMs;
  }

  private async buildSessionEntries(
    sessionId: string,
    snapshot: AntigravityConversationSnapshot | null,
    transcript: AntigravityTranscript | null,
    prevCursor: SessionCheckpoint,
  ): Promise<{ entries: AgentActivityEntry[]; cursor: SessionCheckpoint }> {
    const entries: AgentActivityEntry[] = [];
    const hashEventId = (parts: readonly string[], length: number) =>
      hashId([this.agentType, ...parts], length);
    const cwd = snapshot?.workspacePath;
    const stepInfos = snapshot?.stepInfos ?? new Map<number, AntigravityStepInfo>();
    const seenKeys = new Set(prevCursor.emittedUsageKeys);
    const responseKeysBySource = new Map(Object.entries(prevCursor.usageResponseKeysBySource ?? {}));
    const processedTranscriptSteps = new Set(prevCursor.processedTranscriptSteps);
    const joinDeadlines = new Map<string, number>();
    const pendingPlanners: PendingPlanner[] = [];
    let retryAtMs: number | undefined;
    const usedResponseIds = new Set<string>(prevCursor.emittedResponseIds ?? []);
    const seenPrimaryStepIdx = new Set<number>(prevCursor.emittedPrimaryStepIdxs ?? []);
    const latchedTurnByStartStep = new Map<number, string>(
      Object.entries(prevCursor.turnIdByStartStep ?? {}).map(([k, v]) => [Number(k), v]),
    );
    const emittedTurnStartsSet = new Set<string>(prevCursor.emittedTurnStarts ?? []);
    const previouslyEndedTurns = new Set(prevCursor.endedTurns);
    const endedTurns = new Set(previouslyEndedTurns);
    const turnsAwaitingToolResults = new Set(prevCursor.turnsAwaitingToolResults);
    const latchedToolCallIds = new Map<string, string>(
      Object.entries(prevCursor.toolCallIdMap ?? {}),
    );
    const toolResultStepIndices = new Map(Object.entries(prevCursor.toolResultStepIndexMap ?? {}));
    const toolCallKey = (stepIndex: number, ordinal: number) => `${stepIndex}:${ordinal}`;
    const pendingOrdinal = (call: PendingToolCall) =>
      call.toolIndex ?? Math.max(0, call.resultStepIndex - call.plannerStepIndex - 1);
    for (const pending of prevCursor.pendingToolCalls) {
      latchedToolCallIds.set(toolCallKey(pending.plannerStepIndex, pendingOrdinal(pending)), pending.callId);
    }

    const resolvedMediaCache = new Map<string, UriPart[]>();
    const getStepMedia = async (
      step: AntigravityTranscriptStep,
      timeMs: number,
      direction: 'input' | 'output',
    ): Promise<UriPart[]> => {
      const cacheKey = `${step.stepIndex}:${direction}`;
      const cached = resolvedMediaCache.get(cacheKey);
      if (cached) return cached;
      const parts = await this.resolveMediaParts(step, timeMs, direction);
      resolvedMediaCache.set(cacheKey, parts);
      return parts;
    };

    // Single O(S) pass over transcript steps to precompute:
    // - stepPositionByIndex & prevPlannerByStepIndex (for O(delta) buildInputMessagesDelta)
    // - turnPromptStepIndices (USER_INPUT, step-0 SYSTEM_MESSAGE, or mid-session SYSTEM_MESSAGE
    //   that starts a new native turn UUID)
    // - latestFollowupStepIndex & latestCompletedStepIndex (so stuck/backgrounded RUNNING steps
    //   never stall later completed steps or get permanently dropped)
    const prevPlannerByStepIndex = new Map<number, AntigravityTranscriptStep | undefined>();
    const stepPositionByIndex = new Map<number, number>();
    const turnPromptStepSet = new Set<number>();
    const turnGroups: Array<{ startStep: number; steps: number[] }> = [];
    let latestFollowupStepIndex = -1;
    let latestCompletedStepIndex = -1;

    if (transcript) {
      let lastPlanner: AntigravityTranscriptStep | undefined;
      let lastNativeTurn: string | undefined;
      let currentGroup: { startStep: number; steps: number[] } | null = null;
      let currentGroupHasPlanner = false;

      for (let pos = 0; pos < transcript.steps.length; pos++) {
        const step = transcript.steps[pos]!;
        const info = stepInfos.get(step.stepIndex);
        stepPositionByIndex.set(step.stepIndex, pos);
        prevPlannerByStepIndex.set(step.stepIndex, lastPlanner);

        if (!isStepInProgress(step) || info?.completedAtMs !== undefined) {
          if (step.stepIndex > latestCompletedStepIndex) {
            latestCompletedStepIndex = step.stepIndex;
          }
        }

        const nativeTurn = info?.turnId;
        const isMidSessionSystemTurnStart =
          step.type === 'SYSTEM_MESSAGE' &&
          step.stepIndex > 0 &&
          nativeTurn !== undefined &&
          nativeTurn !== lastNativeTurn;
        const isPrompt =
          step.type === 'USER_INPUT' ||
          (step.stepIndex === 0 && step.type === 'SYSTEM_MESSAGE') ||
          isMidSessionSystemTurnStart;

        if (isPrompt) {
          turnPromptStepSet.add(step.stepIndex);
          if (step.stepIndex > latestFollowupStepIndex) {
            latestFollowupStepIndex = step.stepIndex;
          }
          // Merge step-0 SYSTEM_MESSAGE + immediate USER_INPUT (before any PLANNER_RESPONSE)
          // into one turn group when they share the same nativeTurn (or both lack nativeTurn).
          const mergeIntoStep0SystemGroup =
            step.type === 'USER_INPUT' &&
            currentGroup !== null &&
            currentGroup.startStep === 0 &&
            currentGroup.steps.length === 1 &&
            transcript.byStepIndex.get(0)?.type === 'SYSTEM_MESSAGE' &&
            !currentGroupHasPlanner &&
            (nativeTurn === undefined ||
              lastNativeTurn === undefined ||
              nativeTurn === lastNativeTurn);
          if (mergeIntoStep0SystemGroup) {
            currentGroup!.steps.push(step.stepIndex);
          } else {
            currentGroup = { startStep: step.stepIndex, steps: [step.stepIndex] };
            currentGroupHasPlanner = false;
            turnGroups.push(currentGroup);
          }
        } else {
          if (step.type === 'PLANNER_RESPONSE') {
            lastPlanner = step;
            currentGroupHasPlanner = true;
            if (step.stepIndex > latestFollowupStepIndex) {
              latestFollowupStepIndex = step.stepIndex;
            }
          }
          if (!currentGroup) {
            currentGroup = { startStep: step.stepIndex, steps: [step.stepIndex] };
            turnGroups.push(currentGroup);
          } else {
            currentGroup.steps.push(step.stepIndex);
          }
        }
        if (nativeTurn) lastNativeTurn = nativeTurn;
      }
    }

    // Include any SQLite usage stepIndices in their corresponding turn group so
    // Loop 2 and Loop 3 always resolve the exact same turnId even when only a child
    // result step carries the native Turn UUID. Never fold an early Turn N+1 step
    // (whose own native Turn UUID conflicts with Turn N) into Turn N.
    const stepToTurn = new Map<number, string>();
    const transcriptIndices = new Set(stepPositionByIndex.keys());
    const groupStartSteps = turnGroups.map((g) => g.startStep);
    const groupNativeTurns: Array<string | undefined> = turnGroups.map((g) => {
      for (const idx of g.steps) {
        const t = stepInfos.get(idx)?.turnId;
        if (t) return t;
      }
      return undefined;
    });
    if (snapshot && turnGroups.length > 0) {
      for (const usage of snapshot.events) {
        for (const idx of usage.stepIndices) {
          const groupNum = binarySearchTurnNumber(groupStartSteps, idx);
          const groupIdx = groupNum - 1;
          const group = turnGroups[groupIdx];
          if (!group || transcriptIndices.has(idx)) continue;
          const idxNativeTurn = stepInfos.get(idx)?.turnId;
          const existingNativeTurn = groupNativeTurns[groupIdx];
          if (idxNativeTurn && existingNativeTurn && idxNativeTurn !== existingNativeTurn) {
            // Early Turn N+1 SQLite row before Turn N+1 USER_INPUT flushes to transcript;
            // keep it out of Turn N so resolveTurnForStep honors its own native Turn UUID.
            continue;
          }
          const existingLatched = latchedTurnByStartStep.get(group.startStep);
          if (idxNativeTurn && existingLatched && existingLatched !== `${sessionId}:${idxNativeTurn}`) {
            continue;
          }
          group.steps.push(idx);
          transcriptIndices.add(idx);
          if (!existingNativeTurn && idxNativeTurn) {
            groupNativeTurns[groupIdx] = idxNativeTurn;
          }
        }
      }
    }
    const allocatedTurnIds = new Set(latchedTurnByStartStep.values());
    for (let gi = 0; gi < turnGroups.length; gi++) {
      const group = turnGroups[gi]!;
      let resolvedTurn = group.steps
        .map((idx) => latchedTurnByStartStep.get(idx))
        .find((turn) => turn !== undefined);
      if (!resolvedTurn) {
        const nativeTurn = groupNativeTurns[gi];
        const ordinalTurn = `${sessionId}:turn:${gi + 1}`;
        resolvedTurn = nativeTurn
          ? `${sessionId}:${nativeTurn}`
          : allocatedTurnIds.has(ordinalTurn) ? `${sessionId}:turn-step:${group.startStep}` : ordinalTurn;
      }
      latchedTurnByStartStep.set(group.startStep, resolvedTurn);
      allocatedTurnIds.add(resolvedTurn);
      for (const idx of group.steps) {
        stepToTurn.set(idx, resolvedTurn);
      }
    }

    const resolveTurnForStep = (
      stepIdx: number | undefined,
      candidateIndices?: readonly number[],
    ): string => {
      if (stepIdx !== undefined) {
        const mapped = stepToTurn.get(stepIdx);
        if (mapped) return mapped;
      }
      if (candidateIndices) {
        for (const idx of candidateIndices) {
          const mapped = stepToTurn.get(idx);
          if (mapped) return mapped;
        }
      }
      if (stepIdx !== undefined) {
        const nativeTurn = stepInfos.get(stepIdx)?.turnId;
        if (nativeTurn) return `${sessionId}:${nativeTurn}`;
      }
      if (candidateIndices) {
        for (const idx of candidateIndices) {
          const nativeTurn = stepInfos.get(idx)?.turnId;
          if (nativeTurn) return `${sessionId}:${nativeTurn}`;
        }
      }
      if (stepIdx !== undefined && groupStartSteps.length > 0) {
        const groupNum = binarySearchTurnNumber(groupStartSteps, stepIdx);
        const startStep = groupStartSteps[groupNum - 1];
        if (startStep !== undefined) {
          const latched = latchedTurnByStartStep.get(startStep);
          if (latched) return latched;
        }
        return `${sessionId}:turn:${groupNum}`;
      }
      return `${sessionId}:turn:1`;
    };

    const hasUsageTurn = (usage: AntigravityUsageEvent): boolean =>
      usage.stepIndices.some((idx) => stepToTurn.has(idx) || stepInfos.get(idx)?.turnId);
    const resolveUsageTurn = (usage: AntigravityUsageEvent, stepIdx: number | undefined): string => {
      if (hasUsageTurn(usage)) {
        return resolveTurnForStep(stepIdx, usage.stepIndices);
      }
      // With SQLite usage alone there is no evidence that two invocations belong
      // to one turn. Reusing a fallback turn would discard all later OTLP batches.
      return `${sessionId}:usage:${hashId([usageResponseKey(usage) ?? usage.key], 16)}`;
    };

    // Preserve monotonic turn ordering for deterministic sorting.
    // Register carried-over pending turns FIRST so they never sort after newer turns.
    const turnOrderMap = new Map<string, number>();
    const registerTurnOrder = (turnId: string): void => {
      if (!turnOrderMap.has(turnId)) {
        turnOrderMap.set(turnId, turnOrderMap.size);
      }
    };
    for (const pending of prevCursor.pendingToolCalls) {
      registerTurnOrder(pending.turnId);
    }
    if (transcript) {
      for (const step of transcript.steps) {
        registerTurnOrder(resolveTurnForStep(step.stepIndex));
      }
    }

    type ToolResult = { step: AntigravityTranscriptStep; nativeId?: string; name?: string };
    const nativeToolCallId = (plannerStep: number, ordinal: number, explicitId?: string) => {
      const latchedId = latchedToolCallIds.get(toolCallKey(plannerStep, ordinal));
      return explicitId ?? (latchedId === `${sessionId}:step:${plannerStep}:tc:${ordinal}` ? undefined : latchedId);
    };
    const nativeCallOwners = new Map<string, string | null>();
    const nativeResults = new Map<string, ToolResult | null>();
    const committedResultOwners = new Map(
      [...toolResultStepIndices].map(([owner, stepIndex]) => [stepIndex, owner]),
    );
    const resultFor = (step: AntigravityTranscriptStep): ToolResult => {
      const info = stepInfos.get(step.stepIndex);
      return { step, nativeId: info?.toolCallId, name: info?.toolName };
    };
    const lastTurnPrompt = [...turnPromptStepSet].at(-1);
    for (const step of transcript?.steps ?? []) {
      if (step.type === 'PLANNER_RESPONSE') {
        for (const [ordinal, call] of step.toolCalls.entries()) {
          const nativeId = nativeToolCallId(step.stepIndex, ordinal, call.id);
          if (nativeId) {
            nativeCallOwners.set(nativeId, nativeCallOwners.has(nativeId) ? null : toolCallKey(step.stepIndex, ordinal));
          }
        }
      } else if (isToolResultStep(step)) {
        const result = resultFor(step);
        if (result.nativeId) nativeResults.set(result.nativeId, nativeResults.has(result.nativeId) ? null : result);
      }
    }
    const plannerResults = new Map<number, {
      matched: Map<number, ToolResult>;
      boundaryReached: boolean;
    }>();
    const findToolResultStep = (plannerStepIndex: number, toolIndex: number) => {
      let results = plannerResults.get(plannerStepIndex);
      if (!results) {
        const matched = new Map<number, ToolResult>();
        results = { matched, boundaryReached: latestFollowupStepIndex > plannerStepIndex };
        plannerResults.set(plannerStepIndex, results);
        const startPos = stepPositionByIndex.get(plannerStepIndex);
        const planner = transcript?.byStepIndex.get(plannerStepIndex);
        if (!transcript || !planner || startPos === undefined) {
          return { step: undefined, boundaryReached: results.boundaryReached };
        }

        const byOrdinal = new Map<number, ToolResult>();
        const byNativeId = new Map<string, ToolResult>();
        const byName = new Map<string, ToolResult[]>();
        let bookkeepingCount = 0;
        let previousStepIndex = plannerStepIndex;
        let positionsKnown = true;
        results.boundaryReached = false;
        for (let pos = startPos + 1; pos < transcript.steps.length; pos++) {
          const candidate = transcript.steps[pos]!;
          if (TURN_BOUNDARY_STEP_TYPES.has(candidate.type)) {
            results.boundaryReached = true;
            break;
          }
          positionsKnown &&= candidate.stepIndex === previousStepIndex + 1;
          previousStepIndex = candidate.stepIndex;
          if (!isToolResultStep(candidate)) {
            bookkeepingCount++;
            continue;
          }
          const result = resultFor(candidate);
          const owner = committedResultOwners.get(candidate.stepIndex)
            ?? (result.nativeId ? nativeCallOwners.get(result.nativeId) : undefined);
          if (owner && !owner.startsWith(`${plannerStepIndex}:`)) {
            bookkeepingCount++;
            continue;
          }
          // A missing lower step could be a tool result or bookkeeping, so
          // position alone cannot identify a result beyond a transcript gap.
          if (positionsKnown) {
            byOrdinal.set(candidate.stepIndex - plannerStepIndex - 1 - bookkeepingCount, result);
          }
          if (result.nativeId && !byNativeId.has(result.nativeId)) byNativeId.set(result.nativeId, result);
          if (result.name) {
            const named = byName.get(result.name) ?? [];
            named.push(result);
            byName.set(result.name, named);
          }
        }

        const usedSteps = new Set<number>();
        const calls = planner.toolCalls.map((call, ordinal) => {
          const key = toolCallKey(plannerStepIndex, ordinal);
          return {
            name: call.name,
            committedStep: toolResultStepIndices.get(key),
            nativeId: nativeToolCallId(plannerStepIndex, ordinal, call.id),
          };
        });
        const assign = (ordinal: number, result: ToolResult | undefined) => {
          if (!result || usedSteps.has(result.step.stepIndex)) return;
          const owner = committedResultOwners.get(result.step.stepIndex);
          if (owner && owner !== toolCallKey(plannerStepIndex, ordinal)) return;
          matched.set(ordinal, result);
          usedSteps.add(result.step.stepIndex);
        };
        const compatible = (ordinal: number, result: ToolResult | undefined): result is ToolResult => {
          const call = calls[ordinal]!;
          return result !== undefined && !usedSteps.has(result.step.stepIndex) &&
            (!call.nativeId || !result.nativeId || call.nativeId === result.nativeId) &&
            (!result.name || call.name === result.name);
        };

        // Preserve already-published results, then reserve every exact native
        // match before any call can claim a result by position or name.
        for (const [ordinal, call] of calls.entries()) {
          const committedStep = call.committedStep === undefined
            ? undefined
            : transcript.byStepIndex.get(call.committedStep);
          if (committedStep && isToolResultStep(committedStep)) assign(ordinal, resultFor(committedStep));
        }
        for (const [ordinal, call] of calls.entries()) {
          if (matched.has(ordinal) || call.committedStep !== undefined || !call.nativeId) continue;
          const local = byNativeId.get(call.nativeId);
          if (local) {
            assign(ordinal, local);
          } else if (nativeCallOwners.get(call.nativeId) === toolCallKey(plannerStepIndex, ordinal)) {
            const result = nativeResults.get(call.nativeId);
            if (!result || result.step.stepIndex <= plannerStepIndex) continue;
            const plannerTurn = stepInfos.get(plannerStepIndex)?.turnId;
            const resultTurn = stepInfos.get(result.step.stepIndex)?.turnId;
            if (plannerTurn && resultTurn && plannerTurn !== resultTurn) continue;
            if ((plannerTurn && plannerTurn === resultTurn) ||
              resolveTurnForStep(result.step.stepIndex) === resolveTurnForStep(plannerStepIndex)) {
              assign(ordinal, result);
            }
          }
        }
        for (const [ordinal, call] of calls.entries()) {
          if (matched.has(ordinal) || call.committedStep !== undefined) continue;
          const positional = byOrdinal.get(ordinal);
          if (compatible(ordinal, positional)) assign(ordinal, positional);
        }
        const unmatchedCallCounts = new Map<string, number>();
        for (const [ordinal, call] of calls.entries()) {
          if (matched.has(ordinal) || call.committedStep !== undefined) continue;
          unmatchedCallCounts.set(call.name, (unmatchedCallCounts.get(call.name) ?? 0) + 1);
        }
        for (const [ordinal, call] of calls.entries()) {
          if (matched.has(ordinal) || call.committedStep !== undefined || unmatchedCallCounts.get(call.name) !== 1) continue;
          const named = byName.get(call.name)?.filter((result) => compatible(ordinal, result));
          if (named?.length === 1) assign(ordinal, named[0]);
        }
      }
      const call = transcript?.byStepIndex.get(plannerStepIndex)?.toolCalls[toolIndex];
      const nativeId = nativeToolCallId(plannerStepIndex, toolIndex, call?.id);
      const canWaitForNativeResult = nativeId !== undefined
        && nativeCallOwners.get(nativeId) === toolCallKey(plannerStepIndex, toolIndex)
        && (stepInfos.get(plannerStepIndex)?.turnId !== undefined
          || lastTurnPrompt === undefined || lastTurnPrompt <= plannerStepIndex
          || resolveTurnForStep(lastTurnPrompt) === resolveTurnForStep(plannerStepIndex));
      return {
        step: results.matched.get(toolIndex)?.step,
        boundaryReached: results.boundaryReached && !canWaitForNativeResult,
      };
    };

    const resolveToolCallId = (
      plannerStepIndex: number,
      toolIndex: number,
      explicitId?: string,
    ): string => {
      const latchKey = toolCallKey(plannerStepIndex, toolIndex);
      const latched = latchedToolCallIds.get(latchKey);
      if (latched) return latched;
      const { step } = findToolResultStep(plannerStepIndex, toolIndex);
      const nativeId = step ? stepInfos.get(step.stepIndex)?.toolCallId : undefined;
      const chosen = explicitId ?? nativeId ?? `${sessionId}:step:${plannerStepIndex}:tc:${toolIndex}`;
      latchedToolCallIds.set(latchKey, chosen);
      return chosen;
    };

    // Symmetric streaming gate for Loop 2 AND Loop 3 on prompt/PLANNER_RESPONSE steps:
    // defer while transcript status is in-progress at the session tip (even if SQLite
    // already wrote completedAtMs or partial content) so toolCalls never split across cycles.
    const isPlannerOrPromptStillStreaming = (step: AntigravityTranscriptStep): boolean => {
      if (!isStepInProgress(step)) return false;
      if (latestCompletedStepIndex > step.stepIndex) return false;
      return true;
    };

    // Tool-result active gate (Loop 1 & Loop 2 tool results): also treats a backgrounded
    // RUNNING run_command as finished once SQLite records completedAtMs or later steps complete.
    const isToolStepStillActive = (
      step: AntigravityTranscriptStep,
      info: AntigravityStepInfo | undefined,
    ): boolean => {
      if (!isStepInProgress(step)) return false;
      if (info?.completedAtMs !== undefined) return false;
      if (latestCompletedStepIndex > step.stepIndex) return false;
      return true;
    };

    // Precompute per-turn primary provider and per-step LLM completion timestamp
    // from SQLite usage events (excluding context-compaction CHECKPOINT steps).
    const turnProviderMap = new Map<string, string>();
    const stepCompletionMsMap = new Map<number, number>();
    if (snapshot) {
      for (const usage of snapshot.events) {
        if (usage.isRetry || this.isCompactionOnlyUsage(usage, transcript)) continue;
        const linkedStep = this.findLinkedPlannerStep(usage, transcript);
        const primaryIdx = linkedStep?.stepIndex ?? usage.stepIndices[0];
        if (linkedStep) {
          const info = stepInfos.get(linkedStep.stepIndex);
          const durationNs = (usage.ttftNs ?? 0) + (usage.streamDurationNs ?? 0);
          const durationMs = durationNs > 0 ? Math.max(1, Math.round(durationNs / 1_000_000)) : 0;
          let completedMs = Math.max(info?.completedAtMs ?? 0, usage.timestampMs);
          if (info?.createdAtMs !== undefined && completedMs <= info.createdAtMs) {
            completedMs = info.createdAtMs + Math.max(1, durationMs || 1);
          }
          const prev = stepCompletionMsMap.get(linkedStep.stepIndex);
          if (prev === undefined || completedMs > prev) {
            stepCompletionMsMap.set(linkedStep.stepIndex, completedMs);
          }
        }
        const turnId = resolveUsageTurn(usage, primaryIdx);
        registerTurnOrder(turnId);
        if (!turnProviderMap.has(turnId)) {
          const transcriptModel = normalizeAntigravityModel(linkedStep?.model);
          const model =
            transcriptModel && modelResolutionRank(transcriptModel) > modelResolutionRank(usage.model)
              ? transcriptModel
              : usage.model;
          turnProviderMap.set(turnId, resolveAntigravityProvider(model));
        }
      }
    }

    // 1) Drain any pending tool calls from previous poll cycles whose tool results have now landed
    const remainingPending: PendingToolCall[] = [];
    for (const pending of prevCursor.pendingToolCalls) {
      const toolIndex = pendingOrdinal(pending);
      const { step: resultStep, boundaryReached } = findToolResultStep(pending.plannerStepIndex, toolIndex);
      const resultInfo = resultStep ? stepInfos.get(resultStep.stepIndex) : undefined;
      if (resultStep) {
        if (isToolStepStillActive(resultStep, resultInfo)) {
          // Tool execution is genuinely still in progress; wait for completion
          remainingPending.push(pending);
          continue;
        }
        const effectiveCallTsMs =
          pending.callTsMs ??
          resultInfo?.executionStartedAtMs ??
          resultInfo?.createdAtMs ??
          resultStep.createdAtMs ??
          Date.now();
        const rawResultTsMs =
          resultInfo?.completedAtMs ?? resultStep.createdAtMs ?? effectiveCallTsMs;
        const resultTsMs = Math.max(effectiveCallTsMs, rawResultTsMs);
        const durationMs = resultTsMs - effectiveCallTsMs;
        const resultMediaParts = await getStepMedia(resultStep, resultTsMs, 'input');
        let resultPayload: JsonValue = resultStep.content ?? null;
        if (resultMediaParts.length > 0) {
          const combined: JsonValue[] = [];
          if (resultStep.content) combined.push({ type: 'text', content: resultStep.content });
          for (const part of resultMediaParts) combined.push(part as unknown as JsonValue);
          resultPayload = combined;
        }
        const traceId = hashEventId([sessionId, pending.turnId, 'trace'], 32);
        const stepSpanId = hashEventId([sessionId, pending.turnId, pending.stepId, 'step'], 16);
        const toolSpanId = hashEventId(
          [sessionId, pending.turnId, pending.stepId, pending.callId, 'tool'],
          16,
        );
        const isErr = isToolErrorStatus(resultStep.status);
        const resultEntry = buildAgentActivityEntry({
          'event.id': hashEventId(
            [sessionId, pending.turnId, pending.stepId, pending.callId, 'tool.result'],
            32,
          ),
          'event.name': 'tool.result',
          trace_id: traceId,
          span_id: toolSpanId,
          parent_span_id: stepSpanId,
          'gen_ai.session.id': sessionId,
          'gen_ai.turn.id': pending.turnId,
          // Keep tool.result in the same step group as its parent PLANNER_RESPONSE & tool.call
          'gen_ai.step.id': pending.stepId,
          'gen_ai.agent.type': this.agentType,
          'gen_ai.agent.id': sessionId,
          'gen_ai.provider.name': resolveAntigravityProvider(
            normalizeAntigravityModel(pending.model),
          ),
          'gen_ai.tool.name': pending.toolName,
          'gen_ai.tool.call.id': pending.callId,
          'gen_ai.tool.call.result': resultPayload,
          'tool.result.status': isErr ? 'error' : 'success',
          ...(isErr
            ? {
                'error.type': isCancelledStatus(resultStep.status)
                  ? 'antigravity.tool_cancelled'
                  : 'antigravity.tool_failed',
              }
            : {}),
          ...(durationMs > 0 ? { 'gen_ai.tool.call.duration': durationMs } : {}),
          time_unix_nano: toUnixNanoString(resultTsMs),
        });
        if (resultMediaParts.length > 0) attachMultimodalMetadataForEntry(resultEntry);
        await this.attachWorkspaceContext(resultEntry, cwd);
        entries.push(resultEntry);
        toolResultStepIndices.set(toolCallKey(pending.plannerStepIndex, toolIndex), resultStep.stepIndex);
      } else if (!boundaryReached) {
        // Result not written yet (intermediate CHECKPOINT/TASK_BOUNDARY does not retire pending)
        remainingPending.push(pending);
      }
    }

    // 2) Emit new turn prompts and tool.call / tool.result
    if (transcript) {
      for (const step of transcript.steps) {
        if (step.stepIndex <= prevCursor.lastTranscriptStepIndex || processedTranscriptSteps.has(step.stepIndex)) {
          continue;
        }
        const stepInfo = stepInfos.get(step.stepIndex);
        const isPrompt = turnPromptStepSet.has(step.stepIndex);
        // Symmetric streaming gate shared with Loop 3: stop before an in-progress
        // prompt/planner step at the session tip so Loop 2 and Loop 3 stay in lockstep.
        if ((isPrompt || step.type === 'PLANNER_RESPONSE') && isPlannerOrPromptStillStreaming(step)) {
          break;
        }
        const turnId = resolveTurnForStep(step.stepIndex);
        const stepId = `${sessionId}:step:${step.stepIndex}`;
        const tsMs =
          stepInfo?.createdAtMs ?? step.createdAtMs ?? snapshot?.trajectoryTimestampMs ?? Date.now();
        const traceId = hashEventId([sessionId, turnId, 'trace'], 32);

        if (isPrompt) {
          const mediaParts = await getStepMedia(step, tsMs, 'input');
          if (!step.content && mediaParts.length === 0) continue;
          processedTranscriptSteps.add(step.stepIndex);
          const parts: JsonValue[] = [];
          if (step.content) parts.push({ type: 'text', content: step.content });
          for (const part of mediaParts) parts.push(part as unknown as JsonValue);
          const role = step.type === 'USER_INPUT' ? 'user' : 'system';
          const promptMessages: JsonValue = [{ role, parts }];
          const agentSpanId = hashEventId([sessionId, turnId, 'agent'], 16);
          const isTurnStart = !emittedTurnStartsSet.has(turnId);
          if (isTurnStart) emittedTurnStartsSet.add(turnId);
          const inputEntry = buildAgentActivityEntry({
            'event.id': hashEventId([sessionId, turnId, stepId, 'other'], 32),
            'event.name': 'other',
            trace_id: traceId,
            span_id: agentSpanId,
            'gen_ai.session.id': sessionId,
            'gen_ai.turn.id': turnId,
            'gen_ai.step.id': stepId,
            ...(isTurnStart ? { 'gen_ai.turn.start': true } : {}),
            'gen_ai.agent.type': this.agentType,
            'gen_ai.agent.id': sessionId,
            'gen_ai.provider.name': turnProviderMap.get(turnId) ?? 'gcp.gemini',
            'gen_ai.input.messages': promptMessages,
            'gen_ai.input.messages_delta': promptMessages,
            time_unix_nano: toUnixNanoString(tsMs),
          });
          if (mediaParts.length > 0) attachMultimodalMetadataForEntry(inputEntry);
          await this.attachWorkspaceContext(inputEntry, cwd);
          entries.push(inputEntry);
        } else if (step.type === 'PLANNER_RESPONSE' && step.toolCalls.length > 0) {
          processedTranscriptSteps.add(step.stepIndex);
          const stepProvider = resolveAntigravityProvider(normalizeAntigravityModel(step.model));
          const stepSpanId = hashEventId([sessionId, turnId, stepId, 'step'], 16);
          const plannerCompletedMs =
            stepCompletionMsMap.get(step.stepIndex) ?? stepInfo?.completedAtMs ?? tsMs;

          for (let i = 0; i < step.toolCalls.length; i++) {
            const tc = step.toolCalls[i]!;
            const { step: resultStep, boundaryReached } = findToolResultStep(step.stepIndex, i);
            const resultInfo = resultStep ? stepInfos.get(resultStep.stepIndex) : undefined;
            const toolName = tc.name || resultInfo?.toolName || 'unknown';
            const callId = resolveToolCallId(step.stepIndex, i, tc.id);
            const toolSpanId = hashEventId([sessionId, turnId, stepId, callId, 'tool'], 16);

            // Prefer native tool execution start time (steps.metadata field 32)
            const callTsMs = Math.max(
              plannerCompletedMs,
              resultInfo?.executionStartedAtMs ?? plannerCompletedMs,
            );

            const callEntry = buildAgentActivityEntry({
              'event.id': hashEventId([sessionId, turnId, stepId, callId, 'tool.call'], 32),
              'event.name': 'tool.call',
              trace_id: traceId,
              span_id: toolSpanId,
              parent_span_id: stepSpanId,
              'gen_ai.session.id': sessionId,
              'gen_ai.turn.id': turnId,
              'gen_ai.step.id': stepId,
              'gen_ai.agent.type': this.agentType,
              'gen_ai.agent.id': sessionId,
              'gen_ai.provider.name': stepProvider,
              'gen_ai.tool.name': toolName,
              'gen_ai.tool.call.id': callId,
              'gen_ai.tool.call.arguments': tc.args,
              time_unix_nano: toUnixNanoString(callTsMs),
            });
            await this.attachWorkspaceContext(callEntry, cwd);
            entries.push(callEntry);

            if (resultStep && !isToolStepStillActive(resultStep, resultInfo)) {
              const rawResultTsMs =
                resultInfo?.completedAtMs ?? resultStep.createdAtMs ?? callTsMs;
              const resultTsMs = Math.max(callTsMs, rawResultTsMs);
              const durationMs = resultTsMs - callTsMs;
              const resultMediaParts = await getStepMedia(resultStep, resultTsMs, 'input');
              let resultPayload: JsonValue = resultStep.content ?? null;
              if (resultMediaParts.length > 0) {
                const combined: JsonValue[] = [];
                if (resultStep.content) combined.push({ type: 'text', content: resultStep.content });
                for (const part of resultMediaParts) combined.push(part as unknown as JsonValue);
                resultPayload = combined;
              }
              const isErr = isToolErrorStatus(resultStep.status);
              const resultEntry = buildAgentActivityEntry({
                'event.id': hashEventId([sessionId, turnId, stepId, callId, 'tool.result'], 32),
                'event.name': 'tool.result',
                trace_id: traceId,
                span_id: toolSpanId,
                parent_span_id: stepSpanId,
                'gen_ai.session.id': sessionId,
                'gen_ai.turn.id': turnId,
                // Reuse parent PLANNER_RESPONSE stepId so planTurnStream keeps LLM + tool in one STEP
                'gen_ai.step.id': stepId,
                'gen_ai.agent.type': this.agentType,
                'gen_ai.agent.id': sessionId,
                'gen_ai.provider.name': stepProvider,
                'gen_ai.tool.name': toolName,
                'gen_ai.tool.call.id': callId,
                'gen_ai.tool.call.result': resultPayload,
                'tool.result.status': isErr ? 'error' : 'success',
                ...(isErr
                  ? {
                      'error.type': isCancelledStatus(resultStep.status)
                        ? 'antigravity.tool_cancelled'
                        : 'antigravity.tool_failed',
                    }
                  : {}),
                ...(durationMs > 0 ? { 'gen_ai.tool.call.duration': durationMs } : {}),
                time_unix_nano: toUnixNanoString(resultTsMs),
              });
              if (resultMediaParts.length > 0) attachMultimodalMetadataForEntry(resultEntry);
              await this.attachWorkspaceContext(resultEntry, cwd);
              entries.push(resultEntry);
              toolResultStepIndices.set(toolCallKey(step.stepIndex, i), resultStep.stepIndex);
            } else if (resultStep || !boundaryReached) {
              // Tool result is in-progress or hasn't been written yet; persist for next poll cycle
              if (stepInfo?.turnId && nativeToolCallId(step.stepIndex, i, tc.id)) {
                callEntry['gen_ai.turn.end'] = false;
              }
              remainingPending.push({
                plannerStepIndex: step.stepIndex,
                toolIndex: i,
                turnId,
                stepId,
                resultStepIndex: resultStep?.stepIndex ?? step.stepIndex + 1 + i,
                callId,
                toolName,
                model: step.model,
                callTsMs,
              });
            }
          }
        }
      }
    }

    // 3) Emit authoritative llm.request + llm.response pairs from SQLite usage events
    const pendingToolTurns = new Set(remainingPending.map((call) => call.turnId));
    const waitingForPlannerTurns = new Set<string>();
    const readyPlannerJoins: Array<{ pending: PendingPlanner; planner: AntigravityTranscriptStep | undefined }> = [];
    for (const pending of prevCursor.pendingPlanners ?? []) {
      const knownSteps = pending.stepIndices.map(idx => transcript?.byStepIndex.get(idx));
      const planner = knownSteps.find(step => step?.type === 'PLANNER_RESPONSE');
      if (planner ? isPlannerOrPromptStillStreaming(planner) : knownSteps.includes(undefined)) {
        pendingPlanners.push(pending);
        waitingForPlannerTurns.add(pending.turnId);
      } else {
        readyPlannerJoins.push({ pending, planner });
      }
    }
    if (snapshot) {
      const nowForRace = Date.now();
      for (const usage of snapshot.events) {
        const responseKey = usageResponseKey(usage);
        const rememberUsage = () => {
          if (responseKey) seenKeys.add(responseKey);
          for (const key of usage.sourceKeys) {
            seenKeys.add(key);
            if (responseKey) responseKeysBySource.set(key, responseKey);
          }
        };
        const covered = (responseKey !== undefined && seenKeys.has(responseKey)) ||
          usage.sourceKeys.some((key) => {
            const previousResponse = responseKeysBySource.get(key);
            return seenKeys.has(key) && (!responseKey || !previousResponse || responseKey === previousResponse);
          });
        if (covered || isLegacyUsageCovered(usage, prevCursor, seenKeys)) {
          // Learn the other table's exact slot when a mirror arrives later.
          rememberUsage();
          continue;
        }

        // Skip internal context-compaction CHECKPOINT steps only when ALL stepIndices
        // are visible in transcript and none is a PLANNER_RESPONSE.
        if (this.isCompactionOnlyUsage(usage, transcript)) {
          rememberUsage();
          continue;
        }

        const linkedStep = this.findLinkedPlannerStep(usage, transcript);
        // The SQLite writer can be ahead of the JSONL writer. Recheck both sources
        // at a fixed deadline even when neither file changes again.
        const missingStepIndex = linkedStep
          ? undefined : usage.stepIndices.find((idx) => !transcript?.byStepIndex.has(idx));
        if (missingStepIndex !== undefined) {
          const deadline = prevCursor.joinDeadlines?.[usage.key] ??
            Math.min(usage.timestampMs, nowForRace) + TRANSCRIPT_JOIN_GRACE_MS;
          if (deadline > nowForRace) {
            joinDeadlines.set(usage.key, deadline);
            retryAtMs = Math.min(retryAtMs ?? deadline, deadline);
            if (transcript && hasUsageTurn(usage)) {
              waitingForPlannerTurns.add(resolveUsageTurn(usage, missingStepIndex));
            }
            continue;
          }
        }
        const linkedStepIdx = linkedStep?.stepIndex ?? missingStepIndex ?? usage.stepIndices[0];
        const linkedStepInfo = linkedStepIdx !== undefined ? stepInfos.get(linkedStepIdx) : undefined;

        // Symmetric streaming gate with Loop 2: defer while linked PLANNER_RESPONSE at
        // session tip is still in-progress in transcript (even if SQLite completedAtMs or
        // partial content arrived before tool_calls flushed).
        if (
          linkedStep &&
          linkedStep.type === 'PLANNER_RESPONSE' &&
          isPlannerOrPromptStillStreaming(linkedStep)
        ) {
          continue;
        }

        rememberUsage();

        const stepId = linkedStepIdx === undefined
          ? `${sessionId}:gen:${usage.genIdx ?? 0}`
          : `${sessionId}:step:${linkedStepIdx}`;

        const isRetryUsage =
          usage.isRetry ||
          (linkedStepIdx !== undefined && seenPrimaryStepIdx.has(linkedStepIdx));
        if (!isRetryUsage && linkedStepIdx !== undefined) {
          seenPrimaryStepIdx.add(linkedStepIdx);
        }
        const observedTurn = resolveUsageTurn(usage, linkedStepIdx);
        const isLateAttempt = previouslyEndedTurns.has(observedTurn);
        const turnId = isLateAttempt
          ? `${observedTurn}:usage:${hashId([responseKey ?? usage.key], 16)}`
          : observedTurn;
        registerTurnOrder(turnId);

        const baseResponseId = usage.messageId ?? `${stepId}:r:${usage.key}`;
        let responseId = baseResponseId;
        let dupSeq = 1;
        while (usedResponseIds.has(responseId)) {
          responseId = `${baseResponseId}:${dupSeq++}`;
        }
        usedResponseIds.add(responseId);

        const traceId = hashEventId([sessionId, turnId, 'trace'], 32);
        const stepSpanId = hashEventId([sessionId, turnId, stepId, 'step'], 16);
        // Include responseId in llmSpanId so retries / multi-usage on the same step
        // never collide on span_id or event.id in OtlpTraceFlusher.
        const llmSpanId = hashEventId([sessionId, turnId, stepId, 'llm', responseId], 16);

        const plannerOutput = isRetryUsage ? undefined : linkedStep;
        const transcriptModel = normalizeAntigravityModel(plannerOutput?.model);
        const model =
          transcriptModel && modelResolutionRank(transcriptModel) > modelResolutionRank(usage.model)
            ? transcriptModel
            : usage.model;
        const provider = model === usage.model ? usage.provider : resolveAntigravityProvider(model);

        const totalInputTokens =
          usage.freshInputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
        const totalOutputTokens = usage.totalOutputTokens;
        const totalTokens = totalInputTokens + totalOutputTokens;

        // gen_metadata field 9.4 (and steps.metadata field 8) is generation completion time.
        // For retries, keep the retry's own timestamp/duration instead of reusing parent step bounds.
        // For primary calls, take max(steps.completedAtMs, usage.timestampMs) to avoid stale
        // completedAtMs === createdAtMs snapshots, and guarantee >= +1ms non-zero span duration
        // (surviving otel-util-genai readNanoMs millisecond truncation).
        const durationNs = (usage.ttftNs ?? 0) + (usage.streamDurationNs ?? 0);
        const durationMs = durationNs > 0 ? Math.max(1, Math.round(durationNs / 1_000_000)) : 0;
        let respTsMs = isRetryUsage
          ? usage.timestampMs
          : Math.max(linkedStepInfo?.completedAtMs ?? 0, usage.timestampMs);
        // Derive request start at least 1ms before completion when duration is absent,
        // keeping respTsMs anchored at the true completion timestamp (and >= +1ms span duration
        // so otel-util-genai readNanoMs never truncates to 0ms).
        const derivedReqTsMs = Math.max(1, respTsMs - Math.max(1, durationMs || 1));
        const reqTsMs =
          !isRetryUsage &&
          linkedStepInfo?.createdAtMs !== undefined &&
          linkedStepInfo.createdAtMs < respTsMs
            ? linkedStepInfo.createdAtMs
            : derivedReqTsMs;
        if (respTsMs <= reqTsMs) {
          respTsMs = reqTsMs + Math.max(1, durationMs || 1);
        }
        const reqTimeNano = BigInt(Math.floor(reqTsMs)) * 1_000_000n;
        const respTimeNano = BigInt(Math.floor(respTsMs)) * 1_000_000n;

        const inputDelta = await this.buildInputMessagesDelta(
          plannerOutput,
          transcript,
          prevPlannerByStepIndex,
          stepPositionByIndex,
          turnPromptStepSet,
          reqTsMs,
          getStepMedia,
          resolveToolCallId,
          (plannerStep, ordinal) => findToolResultStep(plannerStep, ordinal).step,
        );
        const reqEntry = buildAgentActivityEntry({
          'event.id': hashEventId([sessionId, turnId, stepId, 'llm.request', responseId], 32),
          'event.name': 'llm.request',
          trace_id: traceId,
          span_id: llmSpanId,
          parent_span_id: stepSpanId,
          'gen_ai.session.id': sessionId,
          'gen_ai.turn.id': turnId,
          'gen_ai.step.id': stepId,
          'gen_ai.response.id': responseId,
          'gen_ai.agent.type': this.agentType,
          'gen_ai.agent.id': sessionId,
          'gen_ai.provider.name': provider,
          'gen_ai.request.model': model,
          ...(inputDelta.length > 0
            ? {
                'gen_ai.input.messages_delta': inputDelta,
                'gen_ai.input.messages_hash': createHash('sha256')
                  .update(JSON.stringify(inputDelta))
                  .digest('hex'),
              }
            : {}),
          time_unix_nano: `${reqTimeNano}`,
        });
        if (inputDelta.length > 0) attachMultimodalMetadataForEntry(reqEntry);
        await this.attachWorkspaceContext(reqEntry, cwd);
        entries.push(reqEntry);

        const outputMediaParts = plannerOutput
          ? await getStepMedia(plannerOutput, respTsMs, 'output')
          : [];
        // The deadline releases the usage event. Only a planner (or an
        // independent SQLite-only invocation) can provide a turn boundary.
        const awaitsPlanner = missingStepIndex !== undefined && !isLateAttempt &&
          transcript !== null && hasUsageTurn(usage);
        const finishReason = awaitsPlanner ? undefined : plannerFinishReason(plannerOutput);
        const cancelled = finishReason === 'cancelled';
        const observedTerminal = cancelled || (finishReason === 'stop' && (!isRetryUsage || !linkedStep));
        const waitsForMore = observedTerminal && !cancelled && !isLateAttempt &&
          (pendingToolTurns.has(turnId) || waitingForPlannerTurns.has(turnId));
        const endsTurn = !awaitsPlanner && (isLateAttempt || (observedTerminal && !waitsForMore));
        if (awaitsPlanner) {
          pendingPlanners.push({ turnId, responseId, stepIndices: usage.stepIndices, provider, isRetry: isRetryUsage });
          waitingForPlannerTurns.add(turnId);
        }
        if (waitsForMore) turnsAwaitingToolResults.add(turnId);
        if (endsTurn) endedTurns.add(turnId);
        const outputMessages = this.buildOutputMessages(
          plannerOutput,
          outputMediaParts,
          finishReason,
          resolveToolCallId,
        );

        const respEntry = buildAgentActivityEntry({
          'event.id': hashEventId([sessionId, turnId, stepId, 'llm.response', responseId], 32),
          'event.name': 'llm.response',
          trace_id: traceId,
          span_id: llmSpanId,
          parent_span_id: stepSpanId,
          'gen_ai.session.id': sessionId,
          'gen_ai.turn.id': turnId,
          'gen_ai.step.id': stepId,
          'gen_ai.response.id': responseId,
          'gen_ai.agent.type': this.agentType,
          'gen_ai.agent.id': sessionId,
          'gen_ai.provider.name': provider,
          'gen_ai.request.model': model,
          'gen_ai.response.model': model,
          ...(finishReason && (!isRetryUsage || !linkedStep) ? { 'gen_ai.response.finish_reasons': [finishReason] } : {}),
          ...(endsTurn || waitsForMore || awaitsPlanner ? { 'gen_ai.turn.end': endsTurn } : {}),
          ...(awaitsPlanner ? { 'agent.antigravity.planner_pending': true } : {}),
          ...(cancelled ? { 'error.type': 'antigravity.model_cancelled' } : {}),
          ...(usage.ttftNs !== undefined && usage.ttftNs > 0
            ? { 'gen_ai.response.time_to_first_token': usage.ttftNs }
            : {}),
          'gen_ai.usage.input_tokens': totalInputTokens,
          'gen_ai.usage.output_tokens': totalOutputTokens,
          ...(usage.reasoningTokens > 0
            ? { 'gen_ai.usage.reasoning_output_tokens': usage.reasoningTokens }
            : {}),
          ...(usage.cacheReadTokens > 0
            ? { 'gen_ai.usage.cache_read.input_tokens': usage.cacheReadTokens }
            : {}),
          ...(usage.cacheCreationTokens > 0
            ? { 'gen_ai.usage.cache_creation.input_tokens': usage.cacheCreationTokens }
            : {}),
          'gen_ai.usage.total_tokens': totalTokens,
          ...(outputMessages ? { 'gen_ai.output.messages': outputMessages } : {}),
          time_unix_nano: `${respTimeNano}`,
        });
        if (outputMediaParts.length > 0) attachMultimodalMetadataForEntry(respEntry);
        await this.attachWorkspaceContext(respEntry, cwd);
        entries.push(respEntry);
      }
    }

    // A late planner may be the sole new record. Report its classification
    // separately so the already published usage and event IDs stay intact.
    for (const { pending, planner } of readyPlannerJoins) {
      const { turnId, responseId } = pending;
      const stepId = planner ? `${sessionId}:step:${planner.stepIndex}` : undefined;
      const finish = planner && !pending.isRetry ? plannerFinishReason(planner) : undefined;
      const cancelled = finish === 'cancelled';
      const waitsForMore = finish === 'stop' && (pendingToolTurns.has(turnId) || waitingForPlannerTurns.has(turnId));
      const endsTurn = cancelled || (finish === 'stop' && !waitsForMore);
      if (waitsForMore) turnsAwaitingToolResults.add(turnId);
      if (endsTurn) endedTurns.add(turnId);
      registerTurnOrder(turnId);
      const completion = buildAgentActivityEntry({
        'event.id': hashEventId([sessionId, turnId, responseId, 'planner'], 32),
        'event.name': 'other',
        trace_id: hashEventId([sessionId, turnId, 'trace'], 32),
        ...(stepId ? { parent_span_id: hashEventId([sessionId, turnId, stepId, 'step'], 16) } : {}),
        'gen_ai.session.id': sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.response.id': responseId,
        'gen_ai.agent.type': this.agentType,
        'gen_ai.agent.id': sessionId,
        'gen_ai.provider.name': pending.provider,
        'gen_ai.turn.end': endsTurn,
        'agent.antigravity.planner_joined': true,
        ...(finish ? { 'gen_ai.response.finish_reasons': [finish] } : {}),
        ...(cancelled ? { 'error.type': 'antigravity.model_cancelled' } : {}),
        time_unix_nano: toUnixNanoString(
          (planner ? stepInfos.get(planner.stepIndex)?.completedAtMs ?? planner.createdAtMs : undefined) ?? Date.now(),
        ),
      });
      await this.attachWorkspaceContext(completion, cwd);
      entries.push(completion);
    }

    // Strictly transitive lexicographic sort: turn order -> intra-turn step order ->
    // timestamp ascending -> event phase weight. Prevents cross-turn Signal B flushes
    // and intra-turn interleaving even when +1ms non-zero duration bumps cross ms ties.
    entries.sort((a, b) => {
      const turnA = turnOrderMap.get(a['gen_ai.turn.id'] ?? '') ?? Number.MAX_SAFE_INTEGER;
      const turnB = turnOrderMap.get(b['gen_ai.turn.id'] ?? '') ?? Number.MAX_SAFE_INTEGER;
      if (turnA !== turnB) return turnA - turnB;
      const stepA = extractStepOrder(a['gen_ai.step.id']);
      const stepB = extractStepOrder(b['gen_ai.step.id']);
      if (stepA !== stepB) return stepA - stepB;
      const ta = BigInt(a.time_unix_nano);
      const tb = BigInt(b.time_unix_nano);
      if (ta !== tb) return ta < tb ? -1 : 1;
      const wa = EVENT_ORDER_WEIGHT[a['event.name']] ?? 5;
      const wb = EVENT_ORDER_WEIGHT[b['event.name']] ?? 5;
      return wa - wb;
    });

    const lastEntryByTurn = new Map(entries.map((entry) => [entry['gen_ai.turn.id'], entry]));
    for (const turnId of turnsAwaitingToolResults) {
      if (pendingToolTurns.has(turnId) || waitingForPlannerTurns.has(turnId)) continue;
      const lastEntry = lastEntryByTurn.get(turnId);
      if (lastEntry) lastEntry['gen_ai.turn.end'] = true;
      // If a new prompt superseded the turn without a result, the exporter sees
      // the next turn in the same session and flushes the previous one.
      endedTurns.add(turnId);
      turnsAwaitingToolResults.delete(turnId);
    }

    const turnIdByStartStep: Record<string, string> = {};
    for (const [k, v] of latchedTurnByStartStep) {
      turnIdByStartStep[String(k)] = v;
    }
    const toolCallIdMap: Record<string, string> = {};
    for (const [k, v] of latchedToolCallIds) {
      toolCallIdMap[k] = v;
    }

    return {
      entries,
      cursor: {
        retryAtMs,
        ...(joinDeadlines.size > 0 ? { joinDeadlines: Object.fromEntries(joinDeadlines) } : {}),
        ...(pendingPlanners.length > 0 ? { pendingPlanners } : {}),
        lastTranscriptStepIndex: prevCursor.lastTranscriptStepIndex,
        processedTranscriptSteps: [...processedTranscriptSteps],
        emittedUsageKeys: [...seenKeys],
        usageResponseKeysBySource: Object.fromEntries(responseKeysBySource),
        emittedResponseIds: [...usedResponseIds],
        emittedPrimaryStepIdxs: [...seenPrimaryStepIdx],
        pendingToolCalls: remainingPending,
        turnIdByStartStep,
        emittedTurnStarts: [...emittedTurnStartsSet],
        endedTurns: [...endedTurns],
        ...(turnsAwaitingToolResults.size ? { turnsAwaitingToolResults: [...turnsAwaitingToolResults] } : {}),
        toolCallIdMap,
        toolResultStepIndexMap: Object.fromEntries(toolResultStepIndices),
      },
    };
  }

  private findLinkedPlannerStep(
    usage: AntigravityUsageEvent,
    transcript: AntigravityTranscript | null,
  ): AntigravityTranscriptStep | undefined {
    if (!transcript) return undefined;
    for (const idx of usage.stepIndices) {
      const step = transcript.byStepIndex.get(idx);
      if (step && step.type === 'PLANNER_RESPONSE') return step;
    }
    return undefined;
  }

  private isCompactionOnlyUsage(
    usage: AntigravityUsageEvent,
    transcript: AntigravityTranscript | null,
  ): boolean {
    if (!transcript || usage.stepIndices.length === 0) return false;
    let sawCheckpoint = false;
    for (const idx of usage.stepIndices) {
      const step = transcript.byStepIndex.get(idx);
      // Require ALL referenced indices to be visible in transcript so an unflushed
      // sibling PLANNER_RESPONSE is never misclassified as compaction-only.
      if (!step) return false;
      if (step.type === 'PLANNER_RESPONSE') return false;
      if (step.type === 'CHECKPOINT') sawCheckpoint = true;
    }
    return sawCheckpoint;
  }

  private async buildInputMessagesDelta(
    linkedStep: AntigravityTranscriptStep | undefined,
    transcript: AntigravityTranscript | null,
    prevPlannerByStepIndex: ReadonlyMap<number, AntigravityTranscriptStep | undefined>,
    stepPositionByIndex: ReadonlyMap<number, number>,
    turnPromptStepSet: ReadonlySet<number>,
    reqTsMs: number,
    getStepMedia: (
      step: AntigravityTranscriptStep,
      timeMs: number,
      direction: 'input' | 'output',
    ) => Promise<UriPart[]>,
    resolveToolCallId: (
      plannerStepIndex: number,
      toolIndex: number,
      explicitId?: string,
    ) => string,
    findToolResultStep: (
      plannerStepIndex: number,
      toolIndex: number,
    ) => AntigravityTranscriptStep | undefined,
  ): Promise<JsonValue[]> {
    if (!linkedStep || !transcript) return [];

    const prevPlanner = prevPlannerByStepIndex.get(linkedStep.stepIndex);
    const delta: JsonValue[] = [];

    if (prevPlanner && prevPlanner.toolCalls.length > 0) {
      const assistantParts: JsonValue[] = [];
      const toolResponseParts: JsonValue[] = [];
      for (let i = 0; i < prevPlanner.toolCalls.length; i++) {
        const tc = prevPlanner.toolCalls[i]!;
        const callId = resolveToolCallId(prevPlanner.stepIndex, i, tc.id);
        assistantParts.push({
          type: 'tool_call',
          id: callId,
          name: tc.name,
          arguments: tc.args ?? null,
        });
        const resultStep = findToolResultStep(prevPlanner.stepIndex, i);
        if (resultStep && resultStep.stepIndex < linkedStep.stepIndex) {
          const resultMedia = await getStepMedia(resultStep, resultStep.createdAtMs ?? reqTsMs, 'input');
          let responsePayload: JsonValue = resultStep.content ?? null;
          if (resultMedia.length > 0) {
            const combined: JsonValue[] = [];
            if (resultStep.content) combined.push({ type: 'text', content: resultStep.content });
            for (const part of resultMedia) combined.push(part as unknown as JsonValue);
            responsePayload = combined;
          }
          toolResponseParts.push({
            type: 'tool_call_response',
            id: callId,
            response: responsePayload,
          });
        }
      }
      if (assistantParts.length > 0) {
        delta.push({ role: 'assistant', parts: assistantParts });
      }
      if (toolResponseParts.length > 0) {
        delta.push({ role: 'tool', parts: toolResponseParts });
      }
    }

    const startPos = prevPlanner ? (stepPositionByIndex.get(prevPlanner.stepIndex) ?? -1) + 1 : 0;
    const endPos = stepPositionByIndex.get(linkedStep.stepIndex) ?? transcript.steps.length;
    for (let pos = startPos; pos < endPos; pos++) {
      const step = transcript.steps[pos]!;
      if (!turnPromptStepSet.has(step.stepIndex)) continue;
      const mediaParts = await getStepMedia(step, step.createdAtMs ?? reqTsMs, 'input');
      const parts: JsonValue[] = [];
      if (step.content) parts.push({ type: 'text', content: step.content });
      for (const part of mediaParts) parts.push(part as unknown as JsonValue);
      if (parts.length > 0) {
        const role = step.type === 'USER_INPUT' ? 'user' : 'system';
        delta.push({ role, parts });
      }
    }

    return delta;
  }

  private async resolveMediaParts(
    step: AntigravityTranscriptStep,
    timeMs: number,
    direction: 'input' | 'output',
  ): Promise<UriPart[]> {
    if (!this.pathToUri || step.media.length === 0) return [];
    const allowed =
      direction === 'input'
        ? multimodalUploadIncludesInput(this.multimodalUploadMode)
        : multimodalUploadIncludesOutput(this.multimodalUploadMode);
    if (!allowed) return [];

    const stats = { skipped: 0 };
    return convertPathsToUriParts(
      step.media.map((m) => m.uri),
      this.pathToUri,
      timeMs,
      stats,
      this.logger,
    );
  }

  private buildOutputMessages(
    step: AntigravityTranscriptStep | undefined,
    mediaParts: readonly UriPart[] = [],
    finishReason = 'stop',
    resolveToolCallId?: (
      plannerStepIndex: number,
      toolIndex: number,
      explicitId?: string,
    ) => string,
  ): JsonValue | undefined {
    if (!step && mediaParts.length === 0) return undefined;
    const parts: JsonValue[] = [];
    if (step?.thinking) {
      parts.push({ type: 'reasoning', content: step.thinking });
    }
    if (step?.content) {
      parts.push({ type: 'text', content: step.content });
    }
    for (const part of mediaParts) {
      parts.push(part as unknown as JsonValue);
    }
    for (let i = 0; i < (step?.toolCalls.length ?? 0); i++) {
      const tc = step!.toolCalls[i]!;
      const callId = resolveToolCallId
        ? resolveToolCallId(step!.stepIndex, i, tc.id)
        : tc.id;
      parts.push({
        type: 'tool_call',
        name: tc.name,
        ...(callId ? { id: callId } : {}),
        ...(tc.args !== undefined ? { arguments: tc.args } : {}),
      });
    }
    if (parts.length === 0) return undefined;
    return [{ role: 'assistant', parts, finish_reason: finishReason }];
  }

  private async attachWorkspaceContext(
    entry: AgentActivityEntry,
    cwd: string | undefined,
  ): Promise<void> {
    if (!cwd) return;
    entry['workspace.path'] = cwd;
    await enrichCanonicalEntryWithGit(entry, { 'agent.antigravity.cwd': cwd }, 'antigravity');
  }
}
