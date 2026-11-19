import { createHash } from 'node:crypto';
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
import {
  isStrongUsageIdentity,
  readAntigravityConversationDb,
  type AntigravityConversationSnapshot,
  type AntigravityStepInfo,
  type AntigravityUsageEvent,
} from './sqlite-reader.js';
import {
  readAntigravityTranscript,
  type AntigravityTranscript,
  type AntigravityTranscriptStep,
} from './transcript-reader.js';
import {
  modelResolutionRank,
  normalizeAntigravityModel,
  resolveAntigravityProvider,
} from './model-normalizer.js';

export type AntigravityClientType =
  | ClientType.Antigravity
  | ClientType.AntigravityIde
  | ClientType.AntigravityCli;

const DEFAULT_ROOT_SEGMENTS: Readonly<Record<AntigravityClientType, string>> = {
  [ClientType.Antigravity]: '~/.gemini/antigravity',
  [ClientType.AntigravityIde]: '~/.gemini/antigravity-ide',
  [ClientType.AntigravityCli]: '~/.gemini/antigravity-cli',
};

const MAX_DBS_PER_CYCLE = 16;
const MAX_TRACKED_SESSIONS = 512;
const MAX_EMITTED_KEYS_PER_SESSION = 512;
const MAX_PENDING_TOOL_CALLS_PER_SESSION = 128;
const MAX_LATCHED_TURNS_PER_SESSION = 128;
const MAX_LATCHED_TOOL_CALLS_PER_SESSION = 256;
const BACKLOG_DRAIN_DELAY_MS = 50;
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

function isToolCancelledStatus(status: string | undefined): boolean {
  if (!status) return false;
  const upper = status.toUpperCase();
  return upper === 'CANCELED' || upper === 'CANCELLED';
}

function isToolErrorStatus(status: string | undefined): boolean {
  if (!status) return false;
  const upper = status.toUpperCase();
  return upper === 'ERROR' || upper === 'CANCELED' || upper === 'CANCELLED';
}

function usageKeyMeta(usage: AntigravityUsageEvent): [number, number] {
  const genIdx = usage.genIdx ?? -1;
  const stepIdx =
    usage.genIdx === undefined && usage.stepIndices.length > 0
      ? Math.max(...usage.stepIndices)
      : -1;
  return [genIdx, stepIdx];
}

function recordUsageIdentities(
  seenKeys: Set<string>,
  keyOrder: string[],
  keyMeta: Array<[number, number]>,
  usage: AntigravityUsageEvent,
): void {
  const strongIds = usage.identities.filter(isStrongUsageIdentity);
  const toRecord = strongIds.length > 0 ? [usage.key, ...strongIds] : [usage.key, ...usage.identities];
  const meta = usageKeyMeta(usage);
  for (const id of toRecord) {
    if (seenKeys.has(id)) continue;
    seenKeys.add(id);
    keyOrder.push(id);
    keyMeta.push(meta);
  }
}

function collectSeedUsageCursor(events: readonly AntigravityUsageEvent[]): {
  keys: string[];
  meta: Array<[number, number]>;
} {
  const seen = new Set<string>();
  const keys: string[] = [];
  const meta: Array<[number, number]> = [];
  for (const event of events) {
    recordUsageIdentities(seen, keys, meta, event);
  }
  return { keys, meta };
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

interface SessionCheckpoint {
  effectiveMtimeMs: number;
  effectiveSize: number;
  /** Highest genIdx among evicted keys (advanced only on eviction, never blocking out-of-order 0-token rows). */
  maxEmittedGenIdx: number;
  /** Highest stepIdx among evicted step-only keys (advanced only on eviction). */
  maxEmittedStepIdx: number;
  emittedUsageKeys: string[];
  /** Parallel `[genIdx, stepIdx]` metadata for `emittedUsageKeys` to compute exact eviction watermarks. */
  emittedKeyMeta?: Array<[number, number]>;
  /** Unemitted 0-token or Loop-3-deferred genIdx values exempt from >512-key eviction watermarks. */
  deferredGenIdxs?: number[];
  /** Unemitted 0-token or Loop-3-deferred step-only indices exempt from >512-key eviction watermarks. */
  deferredStepIdxs?: number[];
  /** Emitted responseIds (bounded) for cross-cycle collision disambiguation. */
  emittedResponseIds?: string[];
  /** Step indices whose primary LLM usage has already been emitted across cycles (for retry detection). */
  emittedPrimaryStepIdxs?: number[];
  lastTranscriptStepIndex: number;
  pendingToolCalls: PendingToolCall[];
  /** Latched turnId per turn-start stepIndex so delayed native UUIDs never split an already-emitted turn. */
  turnIdByStartStep?: Record<string, string>;
  /** Turn IDs that have already emitted `gen_ai.turn.start: true`. */
  emittedTurnStarts?: string[];
  /** Latched tool call IDs keyed by `${plannerStepIndex}:${toolIndex}` for cross-cycle stability. */
  toolCallIdMap?: Record<string, string>;
}

interface AntigravityCheckpoint {
  schema: 1;
  seeded: boolean;
  evictedWatermarkMtimeMs: number;
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

const SYNTHETIC_ROOT_PARENT_SPAN_ID = '0000000000000001';

function hashId(parts: readonly string[], length: number): string {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, length);
  return /^0+$/.test(hex) ? `${'0'.repeat(length - 1)}1` : hex;
}

function toUnixNanoString(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : Date.now();
  return `${BigInt(safeMs) * 1_000_000n}`;
}

async function statFileInfo(filePath: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : { mtimeMs: 0, size: 0 };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function isUsageAlreadyCovered(
  usage: AntigravityUsageEvent,
  cursor: SessionCheckpoint,
  seenKeys: Set<string>,
  deferredGenSet: ReadonlySet<number>,
  deferredStepSet: ReadonlySet<number>,
): boolean {
  if (seenKeys.has(usage.key)) return true;
  if (usage.identities.some((id) => seenKeys.has(id))) return true;
  // Never let >512-key eviction watermarks drop a row explicitly tracked as 0-token / deferred
  if (usage.genIdx !== undefined && deferredGenSet.has(usage.genIdx)) {
    return false;
  }
  if (usage.stepIndices.some((s) => deferredStepSet.has(s))) {
    return false;
  }
  // Eviction-only monotonic index watermarks protect long sessions (>512 events) against replay.
  // Check maxEmittedStepIdx across both steps-only and gen_metadata rows so an already-emitted
  // steps row evicted past 512 keys is not replayed if gen_metadata later references that step.
  if (usage.genIdx !== undefined && cursor.maxEmittedGenIdx >= 0 && usage.genIdx <= cursor.maxEmittedGenIdx) {
    return true;
  }
  if (
    usage.stepIndices.length > 0 &&
    cursor.maxEmittedStepIdx >= 0 &&
    Math.max(...usage.stepIndices) <= cursor.maxEmittedStepIdx
  ) {
    return true;
  }
  return false;
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
  private backlogTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly failedDbBackoff = new Map<string, { failures: number; retryAfterMs: number }>();
  private warnedSqliteUnavailable = false;

  constructor(opts: AntigravityInputOptions) {
    super(opts);
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
    this.failedDbBackoff.clear();
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
    if (raw && typeof raw === 'object' && (raw as AntigravityCheckpoint).schema === 1) {
      const cp = raw as Partial<AntigravityCheckpoint>;
      const sessions: Record<string, SessionCheckpoint> = {};
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
          const rawMeta = Array.isArray(cur.emittedKeyMeta) ? cur.emittedKeyMeta : undefined;
          const emittedKeyMeta: Array<[number, number]> | undefined =
            rawMeta && rawMeta.length === emittedUsageKeys.length
              ? rawMeta.map((pair) =>
                  Array.isArray(pair) &&
                  typeof pair[0] === 'number' &&
                  typeof pair[1] === 'number'
                    ? [pair[0], pair[1]]
                    : [-1, -1],
                )
              : undefined;
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
            effectiveMtimeMs: typeof cur.effectiveMtimeMs === 'number' ? cur.effectiveMtimeMs : 0,
            effectiveSize: typeof cur.effectiveSize === 'number' ? cur.effectiveSize : 0,
            maxEmittedGenIdx: typeof cur.maxEmittedGenIdx === 'number' ? cur.maxEmittedGenIdx : -1,
            maxEmittedStepIdx:
              typeof cur.maxEmittedStepIdx === 'number' ? cur.maxEmittedStepIdx : -1,
            emittedUsageKeys,
            ...(emittedKeyMeta ? { emittedKeyMeta } : {}),
            ...(deferredGenIdxs && deferredGenIdxs.length > 0 ? { deferredGenIdxs } : {}),
            ...(deferredStepIdxs && deferredStepIdxs.length > 0 ? { deferredStepIdxs } : {}),
            ...(emittedResponseIds && emittedResponseIds.length > 0 ? { emittedResponseIds } : {}),
            ...(emittedPrimaryStepIdxs && emittedPrimaryStepIdxs.length > 0
              ? { emittedPrimaryStepIdxs }
              : {}),
            lastTranscriptStepIndex:
              typeof cur.lastTranscriptStepIndex === 'number' ? cur.lastTranscriptStepIndex : -1,
            pendingToolCalls,
            ...(turnIdByStartStep && Object.keys(turnIdByStartStep).length > 0
              ? { turnIdByStartStep }
              : {}),
            ...(emittedTurnStarts && emittedTurnStarts.length > 0 ? { emittedTurnStarts } : {}),
            ...(toolCallIdMap && Object.keys(toolCallIdMap).length > 0 ? { toolCallIdMap } : {}),
          };
        }
      }
      const pendingSeedSessionIds = Array.isArray(cp.pendingSeedSessionIds)
        ? cp.pendingSeedSessionIds.filter((id): id is string => typeof id === 'string')
        : [];
      return {
        schema: 1,
        seeded: Boolean(cp.seeded),
        evictedWatermarkMtimeMs:
          typeof cp.evictedWatermarkMtimeMs === 'number' ? cp.evictedWatermarkMtimeMs : 0,
        ...(pendingSeedSessionIds.length > 0 ? { pendingSeedSessionIds } : {}),
        sessions,
      };
    }
    return { schema: 1, seeded: false, evictedWatermarkMtimeMs: 0, sessions: {} };
  }

  private saveCheckpoint(cp: AntigravityCheckpoint): void {
    // Bound total tracked sessions while recording eviction watermark so evicted
    // old sessions are never treated as brand-new and replayed in an infinite loop.
    const entries = Object.entries(cp.sessions);
    if (entries.length > MAX_TRACKED_SESSIONS) {
      entries.sort((a, b) => b[1].effectiveMtimeMs - a[1].effectiveMtimeMs);
      const evicted = entries.slice(MAX_TRACKED_SESSIONS);
      for (const [, cur] of evicted) {
        if (cur.effectiveMtimeMs > cp.evictedWatermarkMtimeMs) {
          cp.evictedWatermarkMtimeMs = cur.effectiveMtimeMs;
        }
      }
      cp.sessions = Object.fromEntries(entries.slice(0, MAX_TRACKED_SESSIONS));
    }
    if (cp.pendingSeedSessionIds && cp.pendingSeedSessionIds.length > MAX_TRACKED_SESSIONS) {
      cp.pendingSeedSessionIds = cp.pendingSeedSessionIds.slice(-MAX_TRACKED_SESSIONS);
    }
    for (const cur of Object.values(cp.sessions)) {
      if (cur.emittedUsageKeys.length > MAX_EMITTED_KEYS_PER_SESSION) {
        // Advance monotonic watermarks strictly from the evicted oldest prefix so
        // out-of-order 0-token rows within the active window are never skipped.
        const overflow = cur.emittedUsageKeys.length - MAX_EMITTED_KEYS_PER_SESSION;
        if (cur.emittedKeyMeta && cur.emittedKeyMeta.length === cur.emittedUsageKeys.length) {
          for (let i = 0; i < overflow; i++) {
            const [g, s] = cur.emittedKeyMeta[i]!;
            if (g > cur.maxEmittedGenIdx) cur.maxEmittedGenIdx = g;
            if (s > cur.maxEmittedStepIdx) cur.maxEmittedStepIdx = s;
          }
          cur.emittedKeyMeta = cur.emittedKeyMeta.slice(overflow);
        } else {
          cur.emittedKeyMeta = undefined;
        }
        cur.emittedUsageKeys = cur.emittedUsageKeys.slice(overflow);
      }
      if (cur.pendingToolCalls.length > MAX_PENDING_TOOL_CALLS_PER_SESSION) {
        cur.pendingToolCalls = cur.pendingToolCalls.slice(-MAX_PENDING_TOOL_CALLS_PER_SESSION);
      }
      if (cur.emittedTurnStarts && cur.emittedTurnStarts.length > MAX_LATCHED_TURNS_PER_SESSION) {
        cur.emittedTurnStarts = cur.emittedTurnStarts.slice(-MAX_LATCHED_TURNS_PER_SESSION);
      }
      if (cur.turnIdByStartStep) {
        const turnEntries = Object.entries(cur.turnIdByStartStep);
        if (turnEntries.length > MAX_LATCHED_TURNS_PER_SESSION) {
          turnEntries.sort((a, b) => Number(a[0]) - Number(b[0]));
          cur.turnIdByStartStep = Object.fromEntries(
            turnEntries.slice(-MAX_LATCHED_TURNS_PER_SESSION),
          );
        }
      }
      if (cur.toolCallIdMap) {
        const callEntries = Object.entries(cur.toolCallIdMap);
        if (callEntries.length > MAX_LATCHED_TOOL_CALLS_PER_SESSION) {
          cur.toolCallIdMap = Object.fromEntries(
            callEntries.slice(-MAX_LATCHED_TOOL_CALLS_PER_SESSION),
          );
        }
      }
      if (cur.deferredGenIdxs && cur.deferredGenIdxs.length > MAX_LATCHED_TURNS_PER_SESSION) {
        cur.deferredGenIdxs = cur.deferredGenIdxs.slice(-MAX_LATCHED_TURNS_PER_SESSION);
      }
      if (cur.deferredStepIdxs && cur.deferredStepIdxs.length > MAX_LATCHED_TURNS_PER_SESSION) {
        cur.deferredStepIdxs = cur.deferredStepIdxs.slice(-MAX_LATCHED_TURNS_PER_SESSION);
      }
      if (cur.emittedResponseIds && cur.emittedResponseIds.length > MAX_EMITTED_KEYS_PER_SESSION) {
        cur.emittedResponseIds = cur.emittedResponseIds.slice(-MAX_EMITTED_KEYS_PER_SESSION);
      }
      if (cur.emittedPrimaryStepIdxs && cur.emittedPrimaryStepIdxs.length > MAX_EMITTED_KEYS_PER_SESSION) {
        cur.emittedPrimaryStepIdxs = cur.emittedPrimaryStepIdxs.slice(-MAX_EMITTED_KEYS_PER_SESSION);
      }
    }
    const prev = this.stateStore.get(this.id);
    this.stateStore.set(this.id, {
      ...prev,
      lastTimestamp: Date.now(),
      extra: {
        ...(prev?.extra ?? {}),
        antigravityCheckpoint: cp,
      },
    });
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

    let dirEntries: string[];
    try {
      dirEntries = await fs.readdir(this.conversationsDir);
    } catch {
      if (isFreshSeed) {
        checkpoint.seeded = true;
        this.saveCheckpoint(checkpoint);
      }
      return [];
    }

    const dbFiles = dirEntries
      .filter((name) => name.endsWith('.db') && name !== 'conversation_summaries.db')
      .sort();
    if (dbFiles.length === 0) {
      if (isFreshSeed) {
        checkpoint.seeded = true;
        this.saveCheckpoint(checkpoint);
      }
      return [];
    }

    const presentSessionIds = new Set(dbFiles.map((f) => f.slice(0, -3)).filter(Boolean));
    for (const backedOffId of this.failedDbBackoff.keys()) {
      if (!presentSessionIds.has(backedOffId)) {
        this.failedDbBackoff.delete(backedOffId);
      }
    }
    const pendingSeedSet = new Set(
      (checkpoint.pendingSeedSessionIds ?? []).filter((id) => presentSessionIds.has(id)),
    );

    // Stat candidates and pick changed files (most recently modified first)
    const candidates: Array<{
      sessionId: string;
      dbPath: string;
      effectiveMtimeMs: number;
      effectiveSize: number;
    }> = [];

    for (const fileName of dbFiles) {
      if (!this.running) return [];
      const sessionId = fileName.slice(0, -3);
      if (!sessionId) continue;
      const dbPath = path.join(this.conversationsDir, fileName);
      const transcriptPath = path.join(
        this.dataRoot,
        'brain',
        sessionId,
        '.system_generated',
        'logs',
        'transcript.jsonl',
      );
      const [dbInfo, walInfo, transcriptInfo] = await Promise.all([
        statFileInfo(dbPath),
        statFileInfo(`${dbPath}-wal`),
        statFileInfo(transcriptPath),
      ]);
      const effectiveMtimeMs = Math.max(dbInfo.mtimeMs, walInfo.mtimeMs, transcriptInfo.mtimeMs);
      const effectiveSize = dbInfo.size + walInfo.size + transcriptInfo.size;
      if (effectiveMtimeMs <= 0) continue;

      const prev = checkpoint.sessions[sessionId];
      if (!isFreshSeed) {
        if (prev) {
          if (effectiveMtimeMs === prev.effectiveMtimeMs && effectiveSize === prev.effectiveSize) {
            continue;
          }
        } else if (
          !pendingSeedSet.has(sessionId) &&
          checkpoint.seeded &&
          checkpoint.evictedWatermarkMtimeMs > 0 &&
          effectiveMtimeMs <= checkpoint.evictedWatermarkMtimeMs
        ) {
          // Previously evicted historical session that has not changed since eviction
          continue;
        }
      }
      candidates.push({ sessionId, dbPath, effectiveMtimeMs, effectiveSize });
    }

    if (isFreshSeed) {
      for (const candidate of candidates) {
        if (!this.running) return [];
        try {
          const snapshot = await readAntigravityConversationDb(candidate.dbPath);
          const transcript = await readAntigravityTranscript(this.dataRoot, candidate.sessionId);
          const maxStep = transcript
            ? transcript.steps.reduce((max, s) => Math.max(max, s.stepIndex), -1)
            : -1;
          const seedCursor = snapshot
            ? collectSeedUsageCursor(snapshot.events)
            : { keys: [], meta: [] };
          checkpoint.sessions[candidate.sessionId] = {
            effectiveMtimeMs: candidate.effectiveMtimeMs,
            effectiveSize: candidate.effectiveSize,
            maxEmittedGenIdx: -1,
            maxEmittedStepIdx: -1,
            emittedUsageKeys: seedCursor.keys,
            emittedKeyMeta: seedCursor.meta,
            lastTranscriptStepIndex: maxStep,
            pendingToolCalls: [],
          };
          pendingSeedSet.delete(candidate.sessionId);
          this.failedDbBackoff.delete(candidate.sessionId);
        } catch (err) {
          // Track failed DB in pendingSeedSet so it seeds without replaying history once
          // readable, while allowing other valid/new sessions to proceed immediately.
          pendingSeedSet.add(candidate.sessionId);
          this.logger.warn('failed to seed Antigravity conversation DB', {
            agentType: this.agentType,
            sessionId: candidate.sessionId,
            error: String(err),
          });
        }
      }
      checkpoint.seeded = true;
      checkpoint.pendingSeedSessionIds = pendingSeedSet.size > 0 ? [...pendingSeedSet] : undefined;
      this.saveCheckpoint(checkpoint);
      return [];
    }

    if (candidates.length === 0) return [];

    // Filter out DBs currently in exponential failure backoff so Top-16 persistently
    // corrupt/locked DBs can never starve healthy DBs (#17..N) behind them.
    const nowMs = Date.now();
    const readyCandidates = candidates.filter((c) => {
      const backoff = this.failedDbBackoff.get(c.sessionId);
      return !backoff || nowMs >= backoff.retryAfterMs;
    });
    if (readyCandidates.length === 0) return [];

    readyCandidates.sort((a, b) => b.effectiveMtimeMs - a.effectiveMtimeMs);
    const hasBacklog = readyCandidates.length > MAX_DBS_PER_CYCLE;
    const batch = readyCandidates.slice(0, MAX_DBS_PER_CYCLE);

    const emitted: AgentActivityEntry[] = [];
    let checkpointDirty =
      (checkpoint.pendingSeedSessionIds?.length ?? 0) !== pendingSeedSet.size;
    let progressMade = false;
    let newlyBackedOff = false;

    for (const candidate of batch) {
      if (!this.running) break;

      let snapshot: AntigravityConversationSnapshot | null;
      try {
        snapshot = await readAntigravityConversationDb(candidate.dbPath);
        this.failedDbBackoff.delete(candidate.sessionId);
      } catch (err) {
        const prevFail = this.failedDbBackoff.get(candidate.sessionId);
        const failures = (prevFail?.failures ?? 0) + 1;
        const delayMs = Math.min(
          DB_FAILURE_BACKOFF_MAX_MS,
          DB_FAILURE_BACKOFF_BASE_MS * 2 ** (failures - 1),
        );
        this.failedDbBackoff.set(candidate.sessionId, {
          failures,
          retryAfterMs: Date.now() + delayMs,
        });
        newlyBackedOff = true;
        this.logger.warn('failed to read Antigravity conversation DB', {
          agentType: this.agentType,
          sessionId: candidate.sessionId,
          error: String(err),
        });
        continue;
      }

      const transcript = await readAntigravityTranscript(this.dataRoot, candidate.sessionId);

      // Deferred seed for DBs that failed transiently during initial fresh seed
      if (pendingSeedSet.has(candidate.sessionId)) {
        const maxStep = transcript
          ? transcript.steps.reduce((max, s) => Math.max(max, s.stepIndex), -1)
          : -1;
        const seedCursor = snapshot
          ? collectSeedUsageCursor(snapshot.events)
          : { keys: [], meta: [] };
        checkpoint.sessions[candidate.sessionId] = {
          effectiveMtimeMs: candidate.effectiveMtimeMs,
          effectiveSize: candidate.effectiveSize,
          maxEmittedGenIdx: -1,
          maxEmittedStepIdx: -1,
          emittedUsageKeys: seedCursor.keys,
          emittedKeyMeta: seedCursor.meta,
          lastTranscriptStepIndex: maxStep,
          pendingToolCalls: [],
        };
        pendingSeedSet.delete(candidate.sessionId);
        checkpointDirty = true;
        progressMade = true;
        continue;
      }

      const workspaceAllowed = this.workspacePolicy.allows(
        {
          'gen_ai.agent.type': this.agentType,
          'gen_ai.session.id': candidate.sessionId,
          ...(snapshot?.workspacePath ? { 'workspace.path': snapshot.workspacePath } : {}),
        },
        this.agentType,
      );
      if (!workspaceAllowed) {
        const maxStep = transcript
          ? transcript.steps.reduce((max, s) => Math.max(max, s.stepIndex), -1)
          : (checkpoint.sessions[candidate.sessionId]?.lastTranscriptStepIndex ?? -1);
        const seedCursor = snapshot
          ? collectSeedUsageCursor(snapshot.events)
          : { keys: [], meta: [] };
        checkpoint.sessions[candidate.sessionId] = {
          effectiveMtimeMs: candidate.effectiveMtimeMs,
          effectiveSize: candidate.effectiveSize,
          maxEmittedGenIdx: -1,
          maxEmittedStepIdx: -1,
          emittedUsageKeys: seedCursor.keys,
          emittedKeyMeta: seedCursor.meta,
          lastTranscriptStepIndex: maxStep,
          pendingToolCalls: [],
        };
        checkpointDirty = true;
        progressMade = true;
        continue;
      }

      const prevCursor: SessionCheckpoint = checkpoint.sessions[candidate.sessionId] ?? {
        effectiveMtimeMs: 0,
        effectiveSize: 0,
        maxEmittedGenIdx: -1,
        maxEmittedStepIdx: -1,
        emittedUsageKeys: [],
        emittedKeyMeta: [],
        lastTranscriptStepIndex: -1,
        pendingToolCalls: [],
      };

      const sessionResult = await this.buildSessionEntries(
        candidate.sessionId,
        snapshot,
        transcript,
        prevCursor,
      );

      emitted.push(...sessionResult.entries);

      checkpoint.sessions[candidate.sessionId] = {
        effectiveMtimeMs: candidate.effectiveMtimeMs,
        effectiveSize: candidate.effectiveSize,
        maxEmittedGenIdx: sessionResult.maxEmittedGenIdx,
        maxEmittedStepIdx: sessionResult.maxEmittedStepIdx,
        emittedUsageKeys: sessionResult.emittedUsageKeys,
        emittedKeyMeta: sessionResult.emittedKeyMeta,
        ...(sessionResult.deferredGenIdxs.length > 0
          ? { deferredGenIdxs: sessionResult.deferredGenIdxs }
          : {}),
        ...(sessionResult.deferredStepIdxs.length > 0
          ? { deferredStepIdxs: sessionResult.deferredStepIdxs }
          : {}),
        ...(sessionResult.emittedResponseIds.length > 0
          ? { emittedResponseIds: sessionResult.emittedResponseIds }
          : {}),
        ...(sessionResult.emittedPrimaryStepIdxs.length > 0
          ? { emittedPrimaryStepIdxs: sessionResult.emittedPrimaryStepIdxs }
          : {}),
        lastTranscriptStepIndex: sessionResult.maxTranscriptStepIndex,
        pendingToolCalls: sessionResult.pendingToolCalls,
        ...(Object.keys(sessionResult.turnIdByStartStep).length > 0
          ? { turnIdByStartStep: sessionResult.turnIdByStartStep }
          : {}),
        ...(sessionResult.emittedTurnStarts.length > 0
          ? { emittedTurnStarts: sessionResult.emittedTurnStarts }
          : {}),
        ...(Object.keys(sessionResult.toolCallIdMap).length > 0
          ? { toolCallIdMap: sessionResult.toolCallIdMap }
          : {}),
      };
      checkpointDirty = true;
      progressMade = true;
    }

    checkpoint.pendingSeedSessionIds = pendingSeedSet.size > 0 ? [...pendingSeedSet] : undefined;

    if (checkpointDirty) {
      checkpoint.seeded = true;
      if (emitted.length > 0) {
        // Defer StateStore commit until BaseInput invokes onEntriesQueued()
        this.pendingCheckpoint = checkpoint;
      } else {
        this.saveCheckpoint(checkpoint);
      }
    }

    // Drain remaining ready backlog via a managed delayed timer whenever this cycle
    // either made progress or moved failing DBs into backoff so healthy #17..N DBs
    // are drained immediately without spinning on backed-off DBs.
    if (hasBacklog && (progressMade || newlyBackedOff) && this.running) {
      this.backlogTimer = setTimeout(() => {
        this.backlogTimer = null;
        this.requestCollection();
      }, BACKLOG_DRAIN_DELAY_MS);
    }

    return emitted;
  }

  private async buildSessionEntries(
    sessionId: string,
    snapshot: AntigravityConversationSnapshot | null,
    transcript: AntigravityTranscript | null,
    prevCursor: SessionCheckpoint,
  ): Promise<{
    entries: AgentActivityEntry[];
    maxTranscriptStepIndex: number;
    maxEmittedGenIdx: number;
    maxEmittedStepIdx: number;
    emittedUsageKeys: string[];
    emittedKeyMeta: Array<[number, number]>;
    deferredGenIdxs: number[];
    deferredStepIdxs: number[];
    emittedResponseIds: string[];
    emittedPrimaryStepIdxs: number[];
    pendingToolCalls: PendingToolCall[];
    turnIdByStartStep: Record<string, string>;
    emittedTurnStarts: string[];
    toolCallIdMap: Record<string, string>;
  }> {
    const entries: AgentActivityEntry[] = [];
    const cwd = snapshot?.workspacePath;
    const stepInfos = snapshot?.stepInfos ?? new Map<number, AntigravityStepInfo>();
    const seenKeys = new Set(prevCursor.emittedUsageKeys);
    const keyOrder = [...prevCursor.emittedUsageKeys];
    const keyMeta: Array<[number, number]> =
      prevCursor.emittedKeyMeta && prevCursor.emittedKeyMeta.length === prevCursor.emittedUsageKeys.length
        ? prevCursor.emittedKeyMeta.map(([g, s]) => [g, s])
        : prevCursor.emittedUsageKeys.map(() => [-1, -1]);
    const deferredGenSet = new Set<number>([
      ...(prevCursor.deferredGenIdxs ?? []),
      ...(snapshot?.zeroTokenGenIdxs ?? []),
    ]);
    const deferredStepSet = new Set<number>([
      ...(prevCursor.deferredStepIdxs ?? []),
      ...(snapshot?.zeroTokenStepIdxs ?? []),
    ]);
    const usedResponseIds = new Set<string>(prevCursor.emittedResponseIds ?? []);
    const seenPrimaryStepIdx = new Set<number>(prevCursor.emittedPrimaryStepIdxs ?? []);
    let maxStepIndex = prevCursor.lastTranscriptStepIndex;
    const maxEmittedGenIdx = prevCursor.maxEmittedGenIdx;
    const maxEmittedStepIdx = prevCursor.maxEmittedStepIdx;
    const latchedTurnByStartStep = new Map<number, string>(
      Object.entries(prevCursor.turnIdByStartStep ?? {}).map(([k, v]) => [Number(k), v]),
    );
    const emittedTurnStartsSet = new Set<string>(prevCursor.emittedTurnStarts ?? []);
    const latchedToolCallIds = new Map<string, string>(
      Object.entries(prevCursor.toolCallIdMap ?? {}),
    );

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
          if (!group || group.steps.includes(idx)) continue;
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
          if (!existingNativeTurn && idxNativeTurn) {
            groupNativeTurns[groupIdx] = idxNativeTurn;
          }
        }
      }
    }
    for (let gi = 0; gi < turnGroups.length; gi++) {
      const group = turnGroups[gi]!;
      let resolvedTurn = latchedTurnByStartStep.get(group.startStep);
      if (!resolvedTurn) {
        const nativeTurn = groupNativeTurns[gi];
        resolvedTurn = nativeTurn
          ? `${sessionId}:${nativeTurn}`
          : `${sessionId}:turn:${gi + 1}`;
        latchedTurnByStartStep.set(group.startStep, resolvedTurn);
      }
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
      // When transcript is absent in Cycle 1 and native turnId isn't written yet,
      // latch fallback turn:1 on startStep 0 so Cycle 2 does not split the turn.
      const latchedRoot = latchedTurnByStartStep.get(0);
      if (latchedRoot) return latchedRoot;
      const fallback = `${sessionId}:turn:1`;
      latchedTurnByStartStep.set(0, fallback);
      return fallback;
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

    // Locate the result step for a tool call, skipping intermediate non-tool bookkeeping
    // steps (e.g. CHECKPOINT / TASK_BOUNDARY) up to the next turn/planner boundary.
    // Prefers exact native toolCallId match, then positional match verified by toolName.
    const locateToolResultStep = (
      plannerStepIndex: number,
      toolIndex: number,
      toolName?: string,
      callId?: string,
    ): { step?: AntigravityTranscriptStep; stepIndex: number; boundaryReached: boolean } => {
      if (transcript) {
        const startPos = stepPositionByIndex.get(plannerStepIndex);
        if (startPos !== undefined) {
          const toolResults: AntigravityTranscriptStep[] = [];
          let boundaryReached = false;
          for (let pos = startPos + 1; pos < transcript.steps.length; pos++) {
            const candidate = transcript.steps[pos]!;
            if (TURN_BOUNDARY_STEP_TYPES.has(candidate.type)) {
              boundaryReached = true;
              break;
            }
            if (!isToolResultStep(candidate)) continue;
            toolResults.push(candidate);
          }
          // 1) Exact native toolCallId match (handles out-of-order parallel completion)
          if (callId) {
            const byCallId = toolResults.find(
              (c) => stepInfos.get(c.stepIndex)?.toolCallId === callId,
            );
            if (byCallId) {
              return { step: byCallId, stepIndex: byCallId.stepIndex, boundaryReached };
            }
          }
          // 2) Positional match if toolName is compatible
          const positional = toolResults[toolIndex];
          if (positional) {
            const posInfo = stepInfos.get(positional.stepIndex);
            if (!toolName || !posInfo?.toolName || posInfo.toolName === toolName) {
              return { step: positional, stepIndex: positional.stepIndex, boundaryReached };
            }
            // Out-of-order parallel tool completion: look for matching toolName
            const byName = toolResults.find(
              (c) => stepInfos.get(c.stepIndex)?.toolName === toolName,
            );
            if (byName) {
              return { step: byName, stepIndex: byName.stepIndex, boundaryReached };
            }
            return { step: positional, stepIndex: positional.stepIndex, boundaryReached };
          }
          return { step: undefined, stepIndex: plannerStepIndex + 1 + toolIndex, boundaryReached };
        }
      }
      const fallbackIdx = plannerStepIndex + 1 + toolIndex;
      return {
        step: transcript?.byStepIndex.get(fallbackIdx),
        stepIndex: fallbackIdx,
        boundaryReached: latestFollowupStepIndex > plannerStepIndex,
      };
    };

    const findToolResultStepIndex = (
      plannerStepIndex: number,
      toolIndex: number,
      toolName?: string,
      callId?: string,
    ): number => locateToolResultStep(plannerStepIndex, toolIndex, toolName, callId).stepIndex;

    const resolveToolCallId = (
      plannerStepIndex: number,
      toolIndex: number,
      explicitId?: string,
      toolName?: string,
    ): string => {
      if (explicitId) return explicitId;
      const latchKey = `${plannerStepIndex}:${toolIndex}`;
      const latched = latchedToolCallIds.get(latchKey);
      if (latched) return latched;
      const located = locateToolResultStep(plannerStepIndex, toolIndex, toolName);
      const info = stepInfos.get(located.stepIndex);
      const nameCompatible =
        !toolName || !info?.toolName || info.toolName === toolName;
      const chosen =
        info?.toolCallId && nameCompatible
          ? info.toolCallId
          : `${sessionId}:step:${plannerStepIndex}:tc:${toolIndex}`;
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

    const lastTranscriptStepIdx =
      transcript && transcript.steps.length > 0
        ? transcript.steps[transcript.steps.length - 1]!.stepIndex
        : -1;

    // Precompute per-turn primary provider and per-step LLM completion timestamp
    // from SQLite usage events (excluding context-compaction CHECKPOINT steps).
    const turnProviderMap = new Map<string, string>();
    const stepCompletionMsMap = new Map<number, number>();
    if (snapshot) {
      for (const usage of snapshot.events) {
        if (this.isCompactionOnlyUsage(usage, transcript)) continue;
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
        const turnId = resolveTurnForStep(primaryIdx, usage.stepIndices);
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
      const toolIndex =
        pending.toolIndex ?? Math.max(0, pending.resultStepIndex - pending.plannerStepIndex - 1);
      const located = locateToolResultStep(
        pending.plannerStepIndex,
        toolIndex,
        pending.toolName,
        pending.callId,
      );
      const resultStep = located.step;
      const resultInfo = resultStep ? stepInfos.get(resultStep.stepIndex) : undefined;
      if (resultStep && isToolResultStep(resultStep)) {
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
        const traceId = hashId([sessionId, pending.turnId, 'trace'], 32);
        const stepSpanId = hashId([sessionId, pending.turnId, pending.stepId, 'step'], 16);
        const toolSpanId = hashId(
          [sessionId, pending.turnId, pending.stepId, pending.callId, 'tool'],
          16,
        );
        const isErr = isToolErrorStatus(resultStep.status);
        const resultEntry = buildAgentActivityEntry({
          'event.id': hashId(
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
                'error.type': isToolCancelledStatus(resultStep.status)
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
      } else if (located.boundaryReached) {
        // Next turn/planner boundary already landed without this tool result; retire
      } else {
        // Result not written yet (intermediate CHECKPOINT/TASK_BOUNDARY does not retire pending)
        remainingPending.push(pending);
      }
    }

    // 2) Emit new turn prompts and tool.call / tool.result
    if (transcript) {
      for (const step of transcript.steps) {
        if (step.stepIndex <= prevCursor.lastTranscriptStepIndex) continue;
        const stepInfo = stepInfos.get(step.stepIndex);
        const isPrompt = turnPromptStepSet.has(step.stepIndex);
        // Symmetric streaming gate shared with Loop 3: stop before an in-progress
        // prompt/planner step at the session tip so Loop 2 and Loop 3 stay in lockstep.
        if ((isPrompt || step.type === 'PLANNER_RESPONSE') && isPlannerOrPromptStillStreaming(step)) {
          break;
        }
        if (step.stepIndex > maxStepIndex) maxStepIndex = step.stepIndex;

        const turnId = resolveTurnForStep(step.stepIndex);
        const stepId = `${sessionId}:step:${step.stepIndex}`;
        const tsMs =
          stepInfo?.createdAtMs ?? step.createdAtMs ?? snapshot?.trajectoryTimestampMs ?? Date.now();
        const traceId = hashId([sessionId, turnId, 'trace'], 32);

        if (isPrompt) {
          const mediaParts = await getStepMedia(step, tsMs, 'input');
          if (!step.content && mediaParts.length === 0) continue;
          const parts: JsonValue[] = [];
          if (step.content) parts.push({ type: 'text', content: step.content });
          for (const part of mediaParts) parts.push(part as unknown as JsonValue);
          const role = step.type === 'USER_INPUT' ? 'user' : 'system';
          const promptMessages: JsonValue = [{ role, parts }];
          const agentSpanId = hashId([sessionId, turnId, 'agent'], 16);
          const isTurnStart = !emittedTurnStartsSet.has(turnId);
          if (isTurnStart) emittedTurnStartsSet.add(turnId);
          const inputEntry = buildAgentActivityEntry({
            'event.id': hashId([sessionId, turnId, stepId, 'other'], 32),
            'event.name': 'other',
            trace_id: traceId,
            span_id: agentSpanId,
            parent_span_id: SYNTHETIC_ROOT_PARENT_SPAN_ID,
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
          const stepProvider = resolveAntigravityProvider(normalizeAntigravityModel(step.model));
          const stepSpanId = hashId([sessionId, turnId, stepId, 'step'], 16);
          const plannerCompletedMs =
            stepCompletionMsMap.get(step.stepIndex) ?? stepInfo?.completedAtMs ?? tsMs;

          for (let i = 0; i < step.toolCalls.length; i++) {
            const tc = step.toolCalls[i]!;
            const located = locateToolResultStep(step.stepIndex, i, tc.name, tc.id);
            const resultStepIndex = located.stepIndex;
            const resultStep = located.step;
            const resultInfo = stepInfos.get(resultStepIndex);
            const toolName = tc.name || resultInfo?.toolName || 'unknown';
            const callId = resolveToolCallId(step.stepIndex, i, tc.id, toolName);
            const toolSpanId = hashId([sessionId, turnId, stepId, callId, 'tool'], 16);

            // Prefer native tool execution start time (steps.metadata field 32)
            const callTsMs = Math.max(
              plannerCompletedMs,
              resultInfo?.executionStartedAtMs ?? plannerCompletedMs,
            );

            const callEntry = buildAgentActivityEntry({
              'event.id': hashId([sessionId, turnId, stepId, callId, 'tool.call'], 32),
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

            if (resultStep && isToolResultStep(resultStep) && !isToolStepStillActive(resultStep, resultInfo)) {
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
                'event.id': hashId([sessionId, turnId, stepId, callId, 'tool.result'], 32),
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
                      'error.type': isToolCancelledStatus(resultStep.status)
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
            } else if (
              (resultStep && isToolResultStep(resultStep) && isToolStepStillActive(resultStep, resultInfo)) ||
              (!resultStep && !located.boundaryReached)
            ) {
              // Tool result is in-progress or hasn't been written yet; persist for next poll cycle
              remainingPending.push({
                plannerStepIndex: step.stepIndex,
                toolIndex: i,
                turnId,
                stepId,
                resultStepIndex,
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
    if (snapshot) {
      const nowForRace = Date.now();
      for (const usage of snapshot.events) {
        if (isUsageAlreadyCovered(usage, prevCursor, seenKeys, deferredGenSet, deferredStepSet)) {
          continue;
        }

        // Skip internal context-compaction CHECKPOINT steps only when ALL stepIndices
        // are visible in transcript and none is a PLANNER_RESPONSE.
        if (this.isCompactionOnlyUsage(usage, transcript)) {
          recordUsageIdentities(seenKeys, keyOrder, keyMeta, usage);
          if (usage.genIdx !== undefined) deferredGenSet.delete(usage.genIdx);
          for (const s of usage.stepIndices) deferredStepSet.delete(s);
          continue;
        }

        // Cross-file compaction race guard: if SQLite wrote a steps-only row (or partial
        // CHECKPOINT row) whose stepIndices haven't flushed to transcript yet while recent,
        // defer instead of eagerly emitting ['stop'] or swallowing a pending PLANNER_RESPONSE.
        if (this.shouldDeferCompactionRace(usage, transcript, lastTranscriptStepIdx, nowForRace)) {
          if (usage.genIdx !== undefined) deferredGenSet.add(usage.genIdx);
          for (const s of usage.stepIndices) deferredStepSet.add(s);
          continue;
        }

        const linkedStep = this.findLinkedPlannerStep(usage, transcript);
        const linkedStepIdx = linkedStep?.stepIndex ?? usage.stepIndices[0];
        const linkedStepInfo = linkedStepIdx !== undefined ? stepInfos.get(linkedStepIdx) : undefined;

        // Symmetric streaming gate with Loop 2: defer while linked PLANNER_RESPONSE at
        // session tip is still in-progress in transcript (even if SQLite completedAtMs or
        // partial content arrived before tool_calls flushed).
        if (
          linkedStep &&
          linkedStep.type === 'PLANNER_RESPONSE' &&
          isPlannerOrPromptStillStreaming(linkedStep)
        ) {
          if (usage.genIdx !== undefined) deferredGenSet.add(usage.genIdx);
          for (const s of usage.stepIndices) deferredStepSet.add(s);
          continue;
        }

        recordUsageIdentities(seenKeys, keyOrder, keyMeta, usage);
        if (usage.genIdx !== undefined) deferredGenSet.delete(usage.genIdx);
        for (const s of usage.stepIndices) deferredStepSet.delete(s);

        const turnId = resolveTurnForStep(linkedStepIdx, usage.stepIndices);
        registerTurnOrder(turnId);
        const stepId = linkedStep
          ? `${sessionId}:step:${linkedStep.stepIndex}`
          : usage.stepIndices.length > 0
            ? `${sessionId}:step:${usage.stepIndices[0]}`
            : `${sessionId}:gen:${usage.genIdx ?? 0}`;

        const isRetryUsage =
          usage.key.startsWith('gen-retry:') ||
          usage.key.startsWith('step-retry:') ||
          (linkedStepIdx !== undefined && seenPrimaryStepIdx.has(linkedStepIdx));
        if (!isRetryUsage && linkedStepIdx !== undefined) {
          seenPrimaryStepIdx.add(linkedStepIdx);
        }

        const baseResponseId = usage.messageId ?? `${stepId}:r:${usage.key}`;
        let responseId = baseResponseId;
        let dupSeq = 1;
        while (usedResponseIds.has(responseId)) {
          responseId = `${baseResponseId}:${dupSeq++}`;
        }
        usedResponseIds.add(responseId);

        const traceId = hashId([sessionId, turnId, 'trace'], 32);
        const stepSpanId = hashId([sessionId, turnId, stepId, 'step'], 16);
        // Include responseId in llmSpanId so retries / multi-usage on the same step
        // never collide on span_id or event.id in OtlpTraceFlusher.
        const llmSpanId = hashId([sessionId, turnId, stepId, 'llm', responseId], 16);

        const transcriptModel = normalizeAntigravityModel(linkedStep?.model);
        const model =
          transcriptModel && modelResolutionRank(transcriptModel) > modelResolutionRank(usage.model)
            ? transcriptModel
            : usage.model;
        const provider = resolveAntigravityProvider(model);

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
          linkedStep,
          transcript,
          prevPlannerByStepIndex,
          stepPositionByIndex,
          turnPromptStepSet,
          reqTsMs,
          getStepMedia,
          resolveToolCallId,
          findToolResultStepIndex,
        );
        const reqEntry = buildAgentActivityEntry({
          'event.id': hashId([sessionId, turnId, stepId, 'llm.request', responseId], 32),
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

        const outputMediaParts = linkedStep
          ? await getStepMedia(linkedStep, respTsMs, 'output')
          : [];
        const finishReason = linkedStep && linkedStep.toolCalls.length > 0 ? 'tool_call' : 'stop';
        const outputMessages = this.buildOutputMessages(
          linkedStep,
          outputMediaParts,
          finishReason,
          resolveToolCallId,
        );

        const respEntry = buildAgentActivityEntry({
          'event.id': hashId([sessionId, turnId, stepId, 'llm.response', responseId], 32),
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
          'gen_ai.response.finish_reasons': [finishReason],
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
      maxTranscriptStepIndex: maxStepIndex,
      maxEmittedGenIdx,
      maxEmittedStepIdx,
      emittedUsageKeys: keyOrder,
      emittedKeyMeta: keyMeta,
      deferredGenIdxs: [...deferredGenSet],
      deferredStepIdxs: [...deferredStepSet],
      emittedResponseIds: [...usedResponseIds],
      emittedPrimaryStepIdxs: [...seenPrimaryStepIdx],
      pendingToolCalls: remainingPending,
      turnIdByStartStep,
      emittedTurnStarts: [...emittedTurnStartsSet],
      toolCallIdMap,
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

  private shouldDeferCompactionRace(
    usage: AntigravityUsageEvent,
    transcript: AntigravityTranscript | null,
    lastTranscriptStepIdx: number,
    nowMs: number,
  ): boolean {
    if (!transcript || usage.stepIndices.length === 0) return false;
    let hasMissing = false;
    let hasCheckpoint = false;
    let hasPlanner = false;
    for (const idx of usage.stepIndices) {
      const step = transcript.byStepIndex.get(idx);
      if (!step) {
        hasMissing = true;
      } else if (step.type === 'PLANNER_RESPONSE') {
        hasPlanner = true;
      } else if (step.type === 'CHECKPOINT') {
        hasCheckpoint = true;
      }
    }
    if (!hasMissing || hasPlanner) return false;
    // Partial CHECKPOINT + missing sibling index, OR recent steps-only row ahead of transcript tip
    if (hasCheckpoint && nowMs - usage.timestampMs < 30_000) return true;
    if (
      usage.genIdx === undefined &&
      Math.max(...usage.stepIndices) > lastTranscriptStepIdx &&
      nowMs - usage.timestampMs < 30_000
    ) {
      return true;
    }
    return false;
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
      toolName?: string,
    ) => string,
    findToolResultStepIndex: (
      plannerStepIndex: number,
      toolIndex: number,
      toolName?: string,
      callId?: string,
    ) => number,
  ): Promise<JsonValue[]> {
    if (!linkedStep || !transcript) return [];

    const prevPlanner = prevPlannerByStepIndex.get(linkedStep.stepIndex);
    const delta: JsonValue[] = [];
    const consumedStepIndices = new Set<number>();

    if (prevPlanner && prevPlanner.toolCalls.length > 0) {
      const assistantParts: JsonValue[] = [];
      const toolResponseParts: JsonValue[] = [];
      for (let i = 0; i < prevPlanner.toolCalls.length; i++) {
        const tc = prevPlanner.toolCalls[i]!;
        const callId = resolveToolCallId(prevPlanner.stepIndex, i, tc.id, tc.name);
        assistantParts.push({
          type: 'tool_call',
          id: callId,
          name: tc.name,
          arguments: tc.args ?? null,
        });
        const resultIdx = findToolResultStepIndex(prevPlanner.stepIndex, i, tc.name, callId);
        if (resultIdx < linkedStep.stepIndex) {
          const resultStep = transcript.byStepIndex.get(resultIdx);
          if (resultStep && isToolResultStep(resultStep)) {
            consumedStepIndices.add(resultIdx);
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
      if (consumedStepIndices.has(step.stepIndex)) continue;
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
      toolName?: string,
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
        ? resolveToolCallId(step!.stepIndex, i, tc.id, tc.name)
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
