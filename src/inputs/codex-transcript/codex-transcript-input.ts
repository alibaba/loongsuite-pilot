import * as fsSync from 'node:fs';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Dirent, FSWatcher } from 'node:fs';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue, MultimodalUploadMode } from '../../types/index.js';
import { isReservedKey } from '../../normalization/global-attributes.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import type { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';
import {
  buildCodexTranscriptSegment,
  nextInputMessagesForStep,
} from './codex-transcript-builder.js';
import {
  CodexSubagentLinker,
  extractCodexSpawnDescriptors,
  isCodexWorkInput,
  MAX_LINK_DESCRIPTORS,
  type CodexSubagentLink,
  type CodexSubagentLinkSnapshot,
  type CodexSpawnDescriptor,
} from './codex-subagent-linker.js';
import {
  extractCodexPartialTurn,
  extractCodexPartialTurnWithBoundaries,
  extractCodexTranscriptMeta,
  sessionIdFromTranscriptPath,
  transcriptInputMessage,
} from './codex-transcript-extractor.js';
import type { MultimodalProcessor } from '../../multimodal/processor.js';
import type { BlobToUriFn, UriResult } from '../../multimodal/types.js';
import { LruMap, MULTIMODAL_LRU_LIMIT } from '../../multimodal/uploader/lru-set.js';
import { attachMultimodalMetadataForEntry } from '../../multimodal/rewrite.js';
import {
  type CodexActiveTranscriptTurn,
  type CodexPendingFusionChild,
  type CodexPendingFusionTurn,
  type CodexPendingSubagentTurn,
  type CodexForkBootstrap,
  type CodexPendingTerminalTurn,
  type CodexDeferredTerminalTurn,
  type CodexTranscriptInputContext,
  type CodexTranscriptCheckpoint,
  type CodexTranscriptMeta,
  type CodexTranscriptSourceRange,
  type CodexExtractedTranscriptTurn,
  type CodexTranscriptTool,
  type CodexTranscriptSourceRecord,
} from './codex-transcript-types.js';
import { stringValue, timestampMs } from './codex-transcript-utils.js';
import { DEFAULT_POLL_INTERVAL_MS } from '../../utils/poll-interval.js';

const DEFAULT_SESSION_DIR = '~/.codex/sessions';
const READ_CHUNK_SIZE = 1024 * 1024;
// Bound retained bytes before Buffer -> string conversion. Completed records
// above this limit are explicitly quarantined; the native rollout is untouched.
const MAX_JSONL_RECORD_BYTES = 128 * 1024 * 1024;
const jsonlLogger = createLogger('CodexTranscriptInput');
const MAX_EMIT_BATCH_ENTRIES = 256;
const MAX_EMIT_BATCH_BYTES = 1024 * 1024;
const MAX_PERSISTED_INPUT_CONTEXT_BYTES = 1024 * 1024;
const MAX_TERMINALS_PER_FILE_CYCLE = 100;
const MAX_SCAN_BYTES_PER_FILE_CYCLE = 16 * 1024 * 1024;
const MAX_CACHED_INCOMPLETE_TAILS = 2048;
const MAX_OWNER_OFFSET_PROBES = 2048;
const MAX_DEFERRED_TERMINALS = 4;
const RECOVERY_RETRY_MIN_MS = 1_000;
const RECOVERY_RETRY_MAX_MS = 60_000;
// Dynamic roots come from user-local Hook markers. Keep discovery bounded so
// stale task homes cannot turn every polling cycle into an unbounded walk.
const MAX_WAKEUP_MARKERS_FOR_DISCOVERY = 256;
const MAX_WAKEUP_MARKERS_PER_CLEANUP = 1_024;
const MAX_SPAN_CONTEXTS_PER_CLEANUP = 1_024;
const MAX_DYNAMIC_SESSION_DIRS = 64;
const MAX_DYNAMIC_SESSION_FILES = 64;
const MAX_DYNAMIC_DIRECTORIES_PER_ROOT = 8;
const MAX_DYNAMIC_ROLLOUT_FILES_PER_ROOT = 256;
const MAX_CACHED_TRANSCRIPT_META_BYTES = 64 * 1024 * 1024;
const CACHED_TRANSCRIPT_META_ABSENCE_TTL_MS = 48 * 60 * 60 * 1_000;
const WAKEUP_MARKER_DISCOVERY_TTL_MS = 48 * 60 * 60 * 1_000;
const WAKEUP_MARKER_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const SPAN_CONTEXT_TTL_MS = 48 * 60 * 60 * 1_000;
const SPAN_CONTEXT_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const DYNAMIC_SESSION_FILE_MAX_IDLE_MS = 15 * 60 * 1_000;
// Cold historical rollouts are stat'd about as often as the old 30s default.
// Files touched within the hot window stay on the default poll path so appends stay visible.
const HISTORICAL_ROLLOUT_RECHECK_MS = 30_000;
// Values emitted by DEFAULT_RESOURCE_ENV_FIELD_MAP in assets/hooks/shared/resource-context.mjs.
// Add new AgentTeams resource fields to both lists together.
const WAKEUP_RESOURCE_ATTRIBUTE_KEYS = [
  'agentteams.worker.name',
  'agentteams.instance.id',
];
const MAX_WAKEUP_RESOURCE_ATTRIBUTE_VALUE_LENGTH = 512;
const MAX_SPAN_ATTRIBUTE_VALUE_LENGTH = 512;
const SENSITIVE_SPAN_ATTRIBUTE_NAME_RE =
  /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;

interface CodexPendingAgentResult {
  filePath: string;
  inode: number;
  startOffset: number;
  endOffset: number;
  /** Only identity/trace metadata; result bodies are reread from the native range. */
  context: AgentActivityEntry;
}

interface JsonLine {
  startOffset: number;
  endOffset: number;
  record: Record<string, unknown>;
}

interface IncompleteJsonlTail {
  startOffset: number;
  endOffset: number;
  /** Small end-of-prefix witness for append validation; never retain the body. */
  anchor: string;
}

interface CachedIncompleteJsonlTail extends IncompleteJsonlTail {
  inode: number;
  device: number;
  mtimeMs: number;
  ctimeMs: number;
  fileSize: number;
}

interface SegmentRecoveryDiagnostics {
  sourceRecordCount: number;
  stepCount: number;
  toolCount: number;
  tokenUsageCount: number;
  unmatchedTokenUsageCount: number;
  builtEntryCount: number;
  readyEntryCount: number;
  deduplicatedEntryCount: number;
  emittedEntryCount: number;
  previouslyEmittedStepCount: number;
}

type SegmentRecoveryResult = {
  kind: 'unparseable';
  entries: [];
  consumedEndOffset: number;
  diagnostics: SegmentRecoveryDiagnostics;
} | {
  kind: 'processed-empty' | 'processed-emitted';
  entries: AgentActivityEntry[];
  consumedEndOffset: number;
  terminalStatus: 'completed' | 'interrupted';
  diagnostics: SegmentRecoveryDiagnostics;
};

interface PendingRecoveryResult {
  blocked: boolean;
  emittedCount: number;
  processedTerminalCount: number;
}

interface DiscoveredSessionFile {
  filePath: string;
  baselineOnStart: boolean;
}

interface CachedCodexTranscriptMeta {
  inode: number;
  fileSize: number;
  ownerSessionMetaOffset: number;
  meta: CodexTranscriptMeta;
  estimatedBytes: number;
  lastSeenAtMs: number;
}

type TranscriptMetaCacheAccess = 'discovery' | 'active';

interface DynamicDirectoryWalkBudget {
  remainingDirectories: number;
  remainingRolloutFiles: number;
}

interface CodexWakeupMarker {
  initialTurnId?: string;
  recoveryTurnId?: string;
  hookEvent?: string;
}

/** Default pathToUri roots (reserved; Codex today uses inline base64). */
export function codexDefaultAllowedRootPaths(): string[] {
  return [resolveHome('~/.codex')];
}

export interface CodexTranscriptInputOptions extends InputOptions {
  sessionDir?: string;
  wakeupDir?: string;
  spanContextDir?: string;
  /** Multimodal options (enabled + processor). */
  multimodal?: {
    enabled: boolean;
    uploadMode?: MultimodalUploadMode;
    processor?: MultimodalProcessor;
  };
}

export class CodexTranscriptInput extends BaseInput {
  readonly id = 'codex-transcript';
  readonly agentType = ClientType.CodexCliHook;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly sessionDir: string;
  private readonly wakeupDir: string;
  private readonly spanContextDir: string;
  private readonly includeMultimodal: boolean;
  private readonly multimodalUploadMode: MultimodalUploadMode;
  private readonly multimodalProcessor: MultimodalProcessor | null;
  /** Partial-replay uri cache. */
  private readonly multimodalUriCache = new LruMap<UriResult>(MULTIMODAL_LRU_LIMIT);
  private readonly incompleteTails = new Map<string, CachedIncompleteJsonlTail>();
  private readonly ownerOffsetProbes = new LruMap<number | null>(MAX_OWNER_OFFSET_PROBES);
  private wakeupWatcher: FSWatcher | null = null;
  private wakeupTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dirtyWakeupMarkers = new Set<string>();
  private wakeupOnlyRequested = false;
  private wakeupDiscoveryPending = false;
  private wakeupDiscoveryRevision = 0;
  private lastFullScanAt = -Infinity;
  private defaultScanComplete = false;
  private baselinePending = false;
  private readonly wakeupPaths = new Map<string, Set<string>>();
  private readonly subagentLinker = new CodexSubagentLinker();
  private readonly reportedSubagentLinks = new Map<string, string>();
  private lastSubagentLinkSummary = '';
  private readonly deliveredInvocations = new Set<string>();
  private readonly pendingAgentResults = new Map<string, CodexPendingAgentResult>();
  private lastPendingAgentResultState: unknown;
  private lastWakeupMarkerCleanupAtMs = 0;
  private lastDynamicRootLimitWarningAtMs = 0;
  private lastSpanContextCleanupAtMs = 0;
  private readonly transcriptMetaByPath = new Map<string, ReturnType<typeof extractCodexTranscriptMeta>>();
  private readonly transcriptPathByThreadId = new Map<string, string>();
  private readonly transcriptMetaCacheByPath = new Map<string, CachedCodexTranscriptMeta>();
  private readonly transcriptMetaCacheMaxEntries = MAX_LINK_DESCRIPTORS;
  private readonly transcriptMetaCacheMaxBytes = MAX_CACHED_TRANSCRIPT_META_BYTES;
  private transcriptMetaCacheBytes = 0;
  /** Caught-up default-tree rollouts whose mtime is old enough to skip between rechecks. */
  private readonly rolloutIdleSnapshot = new Map<string, { ino: number; size: number; mtimeMs: number }>();
  private lastHistoricalRolloutStatAt = 0;
  private cachedDefaultRollout: { dirMtimes: Map<string, number>; files: string[] } | null = null;

  constructor(opts: CodexTranscriptInputOptions) {
    const processor = opts.multimodal?.processor ?? null;
    const includeMultimodal = opts.multimodal?.enabled === true && !!processor;
    super({
      stateStore: opts.stateStore,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    });
    this.sessionDir = opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR);
    this.wakeupDir = opts.wakeupDir ?? defaultWakeupDir();
    this.spanContextDir = opts.spanContextDir ?? defaultSpanContextDir();
    this.includeMultimodal = includeMultimodal;
    this.multimodalUploadMode = opts.multimodal?.uploadMode ?? 'none';
    this.multimodalProcessor = includeMultimodal ? processor : null;
    for (const id of stringArray(this.stateStore.get(this.id).extra?.codexResultInvocations)) this.deliveredInvocations.add(id);
    const pendingResults = this.stateStore.get(this.id).extra?.codexPendingAgentResults;
    if (Array.isArray(pendingResults)) for (const pending of pendingResults) {
      const record = asRecord(pending);
      const context = asRecord(record?.context);
      if (record && typeof record.filePath === 'string' && typeof record.inode === 'number'
        && typeof record.startOffset === 'number' && Number.isSafeInteger(record.startOffset) && record.startOffset >= 0
        && typeof record.endOffset === 'number' && Number.isSafeInteger(record.endOffset) && record.endOffset > record.startOffset
        && context && typeof context['gen_ai.session.id'] === 'string' && typeof context['event.id'] === 'string') {
        const result = record as unknown as CodexPendingAgentResult;
        this.pendingAgentResults.set(`${result.filePath}:${result.startOffset}`, result);
      }
    }
    this.subagentLinker.restore(this.stateStore.get(this.id).extra?.codexDelegations);
  }

  static getWatchPaths(
    wakeupDir = defaultWakeupDir(),
    sessionDir = resolveHome(DEFAULT_SESSION_DIR),
  ): string[] {
    return [sessionDir, wakeupDir];
  }

  static async checkAvailability(
    wakeupDir = defaultWakeupDir(),
    sessionDir = resolveHome(DEFAULT_SESSION_DIR),
  ): Promise<boolean> {
    if (await directoryExists(sessionDir)) return true;
    try {
      const entries = await fs.readdir(wakeupDir, { withFileTypes: true });
      const now = Date.now();
      for (const entry of selectCodexWakeupMarkers(entries)) {
        const roots = await readCodexWakeupRoots(path.join(wakeupDir, entry.name), now);
        for (const candidate of roots.flat()) {
          if (await directoryExists(candidate)) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    this.subagentLinker.restore(this.stateStore.get(this.id).extra?.codexDelegations);
    this.discardLegacyGlobalTurnRegistry();
    const discovered = await this.discoverSessionFiles();
    await this.indexDiscoveredTranscriptOwners(discovered);
    let isBaselineInit = this.stateStore.get(this.id).extra?.isBaselineInit === true;
    if (!isBaselineInit) {
      const prefix = `${this.id}:`;
      const legacy = this.stateStore.keys().some(key =>
        key.startsWith(prefix) && this.readCheckpoint(key) !== null);
      if (legacy) {
        this.stateStore.update(this.id, { extra: { isBaselineInit: true } });
        isBaselineInit = true;
      }
    }
    for (const { filePath, baselineOnStart } of discovered) {
      const key = this.stateKey(filePath);
      const meta = this.transcriptMetaByPath.get(filePath);
      const neededByPendingFusion = meta?.depth === 1
        && meta.parentThreadId !== undefined
        && this.hasLegacyPendingFusionForParent(meta.parentThreadId);
      if (baselineOnStart && !neededByPendingFusion && !this.readCheckpoint(key)) {
        const hasCopiedPrefix = hasCopiedHistoryPrefix(meta);
        if (hasCopiedPrefix) {
          await this.parkForkBaseline(filePath, key);
        } else if (!isBaselineInit) {
          await this.baselineFile(filePath, key);
        }
      }
    }
    if (!isBaselineInit && this.defaultScanComplete) {
      this.stateStore.update(this.id, { extra: { isBaselineInit: true } });
    } else if (!isBaselineInit) {
      this.baselinePending = true;
    }
    await Promise.all([
      fs.mkdir(this.wakeupDir, { recursive: true }),
      fs.mkdir(this.spanContextDir, { recursive: true }),
    ]);
    try {
      this.wakeupWatcher = fsSync.watch(this.wakeupDir, { persistent: false }, (_event, filename) => {
        this.noteWakeup(filename?.toString());
      });
      this.wakeupWatcher.on('error', () => {
        this.wakeupWatcher?.close();
        this.wakeupWatcher = null;
      });
    } catch {
      this.logger.warn('failed to watch Codex wakeup directory; polling remains active', {
        wakeupDir: this.wakeupDir,
      });
    }
  }

  protected override async onStop(): Promise<void> {
    this.wakeupWatcher?.close();
    this.wakeupWatcher = null;
    if (this.wakeupTimer) clearTimeout(this.wakeupTimer);
    this.wakeupTimer = null;
    this.dirtyWakeupMarkers.clear();
    this.wakeupOnlyRequested = false;
    this.wakeupDiscoveryPending = false;
    this.wakeupDiscoveryRevision = 0;
    this.wakeupPaths.clear();
    this.lastFullScanAt = -Infinity;
    this.multimodalUriCache.clear();
    this.incompleteTails.clear();
    this.ownerOffsetProbes.clear();
    this.transcriptMetaCacheByPath.clear();
    this.transcriptMetaCacheBytes = 0;
  }

  /** Fixed window, not trailing debounce: continuous events cannot postpone work. */
  private noteWakeup(filename?: string): void {
    if (filename && (!/^[a-zA-Z0-9_-]+\.json$/.test(filename))) return;
    // Bounded queue. Unknown/overflow notifications are covered by full polling.
    if (this.dirtyWakeupMarkers.size < MAX_WAKEUP_MARKERS_PER_CLEANUP) {
      this.dirtyWakeupMarkers.add(filename ?? '*');
    } else {
      this.wakeupDiscoveryPending = true;
      this.wakeupDiscoveryRevision++;
    }
    this.scheduleWakeup();
  }

  private scheduleWakeup(): void {
    if (this.wakeupTimer || !this.running || !this.dirtyWakeupMarkers.size) return;
    this.wakeupTimer = setTimeout(() => {
      this.wakeupTimer = null;
      this.wakeupOnlyRequested = true;
      this.requestCollection();
      // A busy BaseInput coalesces requests. Keep retrying until collect takes
      // the dirty set; never clear notifications just because a timer fired.
      this.scheduleWakeup();
    }, 200);
    this.wakeupTimer.unref();
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    const wakeupOnly = this.wakeupOnlyRequested;
    this.wakeupOnlyRequested = false;
    const dirty = new Set(this.dirtyWakeupMarkers);
    this.dirtyWakeupMarkers.clear();
    const targeted = new Set<string>();
    for (const marker of dirty) {
      const paths = this.wakeupPaths.get(marker);
      if (!paths) {
        this.wakeupDiscoveryPending = true;
        this.wakeupDiscoveryRevision++;
      }
      for (const file of paths ?? []) targeted.add(file);
    }
    const discoveryRevision = this.wakeupDiscoveryRevision;
    const now = Date.now();
    const fullScan = !wakeupOnly || now - this.lastFullScanAt >= this.pollIntervalMs;
    await this.cleanupExpiredSpanContexts(now);
    let emittedCount = 0;
    let discovered: DiscoveredSessionFile[];
    let skipPaths = new Set<string>();
    if (fullScan) {
      discovered = await this.discoverSessionFiles();
      this.lastFullScanAt = now;
      const discoveredPaths = new Set(discovered.map(file => file.filePath));
      for (const filePath of this.rolloutIdleSnapshot.keys()) {
        if (!discoveredPaths.has(filePath)) this.rolloutIdleSnapshot.delete(filePath);
      }
      skipPaths = this.historicalRolloutSkipPaths(discovered, now);
      // A filename-less/overflow notification may carry only new ownership
      // evidence for a cold file. Do not lose it to historical-file skipping.
      if (this.wakeupDiscoveryPending) skipPaths.clear();
      for (const file of targeted) skipPaths.delete(file);
      await this.indexDiscoveredTranscriptOwners(discovered, skipPaths);
      this.wakeupPaths.clear();
      for (const { filePath } of discovered) {
        const meta = this.transcriptMetaByPath.get(filePath);
        if (!meta) continue;
        const marker = `${safeWakeupSessionPart(meta.threadId)}.json`;
        if (!this.wakeupPaths.has(marker)) this.wakeupPaths.set(marker, new Set());
        this.wakeupPaths.get(marker)!.add(filePath);
      }
      if (this.wakeupDiscoveryRevision === discoveryRevision) this.wakeupDiscoveryPending = false;
    } else {
      // Known sessions need no directory/marker enumeration. Newly created
      // sessions and filename-less notifications retain full polling fallback.
      discovered = [...targeted].map(filePath => ({ filePath, baselineOnStart: false }));
      await this.indexDiscoveredTranscriptOwners(discovered, skipPaths, 'targeted');
    }
    discovered.sort((left, right) => {
      const leftDepth = this.transcriptMetaByPath.get(left.filePath)?.depth ?? 0;
      const rightDepth = this.transcriptMetaByPath.get(right.filePath)?.depth ?? 0;
      return leftDepth - rightDepth || left.filePath.localeCompare(right.filePath);
    });
    for (const { filePath, baselineOnStart } of discovered) {
      if (skipPaths.has(filePath)) continue;
      if (baselineOnStart && this.baselinePending) {
        const key = this.stateKey(filePath);
        const meta = this.transcriptMetaByPath.get(filePath);
        const neededByPendingFusion = meta?.depth === 1
          && meta.parentThreadId !== undefined
          && this.hasLegacyPendingFusionForParent(meta.parentThreadId);
        if (!neededByPendingFusion && !this.readCheckpoint(key)) {
          if (hasCopiedHistoryPrefix(meta)) await this.parkForkBaseline(filePath, key);
          else await this.baselineFile(filePath, key);
          continue;
        }
      }
      emittedCount += await this.processFile(filePath);
    }
    if (fullScan) {
      if (this.baselinePending && this.defaultScanComplete) {
        this.stateStore.update(this.id, { extra: { isBaselineInit: true } });
        this.baselinePending = false;
      }
      emittedCount += await this.retryPendingAgentResults();
    }
    this.reportSubagentLinks();
    this.saveDelegationState();
    if (emittedCount > 0) {
      this.logger.debug('cycle produced entries', { count: emittedCount });
    }
    return [];
  }

  /** Current parent/child assignments, including diagnostic-only confidence levels. */
  getSubagentLinkSnapshot(): CodexSubagentLinkSnapshot {
    return this.subagentLinker.snapshot();
  }

  private emitEntryBatches(entries: AgentActivityEntry[]): number {
    let emittedCount = 0;
    let batch: AgentActivityEntry[] = [];
    let batchBytes = 0;

    const flush = (): void => {
      if (batch.length === 0) return;
      for (const entry of batch) {
        attachMultimodalMetadataForEntry(entry);
      }
      this.emit('entries', batch);
      emittedCount += batch.length;
      batch = [];
      batchBytes = 0;
    };

    for (const entry of entries) {
      const entryBytes = serializedEntryBytes(entry);
      if (
        batch.length > 0
        && (batch.length >= MAX_EMIT_BATCH_ENTRIES || batchBytes + entryBytes > MAX_EMIT_BATCH_BYTES)
      ) {
        flush();
      }
      batch.push(entry);
      batchBytes += entryBytes;
    }
    flush();
    return emittedCount;
  }

  private async processFile(filePath: string): Promise<number> {
    const observed: { stat?: RolloutStatSnapshot } = {};
    try {
      return await this.scanRolloutFile(filePath, observed);
    } finally {
      this.noteRolloutIdle(filePath, observed.stat);
    }
  }

  private historicalRolloutSkipPaths(files: DiscoveredSessionFile[], now: number): Set<string> {
    if (now - this.lastHistoricalRolloutStatAt >= HISTORICAL_ROLLOUT_RECHECK_MS) {
      this.lastHistoricalRolloutStatAt = now;
      return new Set();
    }
    const skip = new Set<string>();
    for (const file of files) {
      if (!file.baselineOnStart) continue;
      const snap = this.rolloutIdleSnapshot.get(file.filePath);
      if (!snap) continue;
      if (now - snap.mtimeMs < DYNAMIC_SESSION_FILE_MAX_IDLE_MS) continue;
      skip.add(file.filePath);
    }
    return skip;
  }

  private noteRolloutIdle(
    filePath: string,
    stat: { ino: number; size: number; mtimeMs: number } | undefined,
  ): void {
    if (!stat) {
      this.rolloutIdleSnapshot.delete(filePath);
      return;
    }
    const checkpoint = this.readCheckpoint(this.stateKey(filePath));
    if (!checkpoint || !rolloutCaughtUp(checkpoint, stat)) {
      this.rolloutIdleSnapshot.delete(filePath);
      return;
    }
    this.rolloutIdleSnapshot.set(filePath, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  private async listDefaultRolloutFiles(): Promise<string[]> {
    const cached = this.cachedDefaultRollout;
    if (cached && await this.rolloutDirsUnchanged(cached.dirMtimes)) {
      this.defaultScanComplete = true;
      return cached.files;
    }
    const files: string[] = [];
    const dirMtimes = new Map<string, number>();
    let rootMissing = false;
    const complete = await collectRolloutFiles(this.sessionDir, files, dirMtimes, (dir, error) => {
      if (dir === this.sessionDir && (error as NodeJS.ErrnoException).code === 'ENOENT') rootMissing = true;
      this.logger.warn('Codex rollout directory scan failed; retrying next poll', { dir, error: String(error) });
    });
    this.defaultScanComplete = complete || rootMissing;
    this.cachedDefaultRollout = this.defaultScanComplete && dirMtimes.size > 0 ? { dirMtimes, files } : null;
    return files;
  }

  private async rolloutDirsUnchanged(dirMtimes: Map<string, number>): Promise<boolean> {
    if (dirMtimes.size === 0) return false;
    for (const [dir, mtimeMs] of dirMtimes) {
      try {
        const stat = await fs.stat(dir);
        if (stat.mtimeMs !== mtimeMs) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async scanRolloutFile(
    filePath: string,
    observed: { stat?: RolloutStatSnapshot },
  ): Promise<number> {
    const runtime = this.getInputRuntimeAccumulator();
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return 0;
    }
    observed.stat = rolloutStatSnapshot(stat);
    const key = this.stateKey(filePath);
    // onStart()/collect() index the current inode before processFile(). Keep
    // this lookup ahead of inode recovery: forkBootstrap is intentionally
    // cleared after owned data advances, while the owner meta remains the
    // durable proof that every replacement still starts with copied history.
    const indexedOwnerMeta = this.transcriptMetaByPath.get(filePath) ?? null;
    const hasIndexedCopiedPrefix = hasCopiedHistoryPrefix(indexedOwnerMeta);
    let checkpoint = this.readCheckpoint(key);
    let checkpointChanged = false;
    if (!checkpoint) {
      checkpoint = {
        inode: stat.ino,
        scanOffset: 0,
        activeTurn: null,
        pendingTerminal: null,
        pendingFusion: null,
        pendingSubagent: null,
        ownerSessionMetaOffset: null,
      };
      checkpointChanged = true;
    } else if (checkpoint.inode !== stat.ino) {
      const forkBootstrap = checkpoint.forkBootstrap;
      if (hasIndexedCopiedPrefix && forkBootstrap?.state === 'live-pending') {
        this.logger.warn('Codex fork transcript inode changed before owned history was consumed; restarting bootstrap', {
          transcriptPath: filePath,
          previousInode: checkpoint.inode,
          currentInode: stat.ino,
          previousScanOffset: checkpoint.scanOffset,
          previousSearchOffset: forkBootstrap.searchOffset,
        });
        checkpoint = {
          inode: stat.ino,
          scanOffset: 0,
          activeTurn: null,
          pendingTerminal: null,
          pendingFusion: null,
          pendingSubagent: null,
          ownerSessionMetaOffset: null,
          forkBootstrap: {
            ...forkBootstrap,
            state: 'live-pending',
            searchOffset: 0,
          },
        };
        checkpointChanged = true;
      } else {
        this.logger.warn('Codex transcript inode changed; applying no-replay baseline', {
          transcriptPath: filePath,
          previousInode: checkpoint.inode,
          currentInode: stat.ino,
          previousScanOffset: checkpoint.scanOffset,
          hadForkBootstrap: checkpoint.forkBootstrap !== undefined,
          hasCopiedPrefix: hasIndexedCopiedPrefix,
        });
        if (hasIndexedCopiedPrefix) {
          await this.parkForkBaseline(filePath, key);
        } else {
          await this.baselineFile(filePath, key);
        }
        return 0;
      }
    }
    runtime?.observeBacklog(Math.max(0, stat.size - checkpoint.scanOffset));
    if (rolloutCaughtUp(checkpoint, stat)) return 0;

    // An owner may be ahead of a parked live-fork scan cursor. Its actual
    // read boundary is the current file size, not the consumed scan offset.
    if (checkpoint.ownerSessionMetaOffset !== null && checkpoint.ownerSessionMetaOffset >= stat.size) {
      checkpoint.ownerSessionMetaOffset = null;
      checkpointChanged = true;
    }
    if (checkpoint.ownerSessionMetaOffset === null) {
      const offset = await this.findOwnerOffset(filePath, stat);
      if (offset !== null) {
        checkpoint.ownerSessionMetaOffset = offset;
        checkpointChanged = true;
      }
    }
    const ownerMetaCacheAccess: TranscriptMetaCacheAccess = (
      checkpoint.scanOffset < stat.size
      || checkpoint.activeTurn !== null
      || checkpoint.pendingTerminal !== null
      || checkpoint.pendingFusion !== null
      || checkpoint.pendingSubagent !== null
      || checkpoint.forkBootstrap?.state === 'live-pending'
    ) ? 'active' : 'discovery';
    await this.registerSubagentOwnerMeta(
      filePath,
      checkpoint.inode,
      stat.size,
      checkpoint.ownerSessionMetaOffset,
      ownerMetaCacheAccess,
    );

    const ownerMeta = this.transcriptMetaByPath.get(filePath) ?? null;
    const isDirectSubagent = ownerMeta?.threadSource === 'subagent';
    if (ownerMeta) this.registerPersistedSubagentSpawns(checkpoint, ownerMeta.threadId);

    const hasCopiedPrefix = hasCopiedHistoryPrefix(ownerMeta);
    if (
      hasCopiedPrefix
      && checkpoint.activeTurn === null
      && checkpoint.pendingTerminal === null
    ) {
      const prepared = await this.prepareCopiedTranscript(filePath, stat.size, ownerMeta!, checkpoint);
      checkpointChanged ||= prepared.changed;
      if (!prepared.ready) {
        if (checkpointChanged) this.saveCheckpoint(key, checkpoint);
        else this.saveDelegationState();
        return 0;
      }
    }

    const forkBootstrapAtOwnedScanStart = checkpoint.forkBootstrap;
    const ownedScanStartOffset = checkpoint.scanOffset;
    let emittedCount = 0;
    let processedTerminalCount = 0;
    if (
      isDirectSubagent
      && checkpoint.pendingTerminal
      && checkpoint.activeTurn?.turnId === checkpoint.pendingTerminal.turnId
      && shouldSkipCopiedParentTurn(
        checkpoint.pendingTerminal.turnId,
        checkpoint.activeTurn.startedAtMs,
        ownerMeta?.createdAtMs,
      )
    ) {
      checkpoint.activeTurn = null;
      checkpoint.pendingTerminal = null;
      processedTerminalCount++;
      checkpointChanged = true;
    }
    // Migrate retained legacy fusion ranges to independent lifecycle recovery.
    // A parent terminal never supplies a terminal boundary for a child.
    if (checkpoint.pendingSubagent) {
      const released = await this.releaseCapturedSubagentIndependently(filePath, checkpoint);
      emittedCount += released.emittedCount;
      processedTerminalCount += released.processedTerminalCount;
      checkpointChanged = true;
      if (checkpoint.pendingSubagent) {
        this.saveCheckpoint(key, checkpoint);
        return emittedCount;
      }
    }
    if (checkpoint.pendingFusion) {
      const released = await this.releaseParentFusionIndependently(filePath, checkpoint);
      emittedCount += released.emittedCount;
      processedTerminalCount += released.processedTerminalCount;
      checkpointChanged = true;
    }

    let scannedBytes = 0;

    const deferredResult = await this.recoverDeferredTerminals(filePath, checkpoint, stat);
    checkpointChanged ||= deferredResult.changed;
    emittedCount += deferredResult.emittedCount;
    processedTerminalCount += deferredResult.processedTerminalCount;
    const priorPending = checkpoint.pendingTerminal;
    const pendingResult = await this.recoverPendingTerminal(filePath, checkpoint, stat);
    checkpointChanged ||= checkpoint.pendingTerminal !== priorPending;
    emittedCount += pendingResult.emittedCount;
    processedTerminalCount += pendingResult.processedTerminalCount;
    if (pendingResult.blocked) {
      if (checkpointChanged) this.saveCheckpoint(key, checkpoint);
      return emittedCount;
    }

    while (
      checkpoint.scanOffset < stat.size
      && processedTerminalCount < MAX_TERMINALS_PER_FILE_CYCLE
      && scannedBytes < MAX_SCAN_BYTES_PER_FILE_CYCLE
    ) {
      // Physical newline discovery is speculative, separate from the durable
      // complete-line checkpoint. Unchanged tails require no content reads;
      // appends are searched only beyond the previously inspected prefix.
      if (!await this.incompleteTailReady(filePath, checkpoint.scanOffset, stat, runtime)) break;
      const scanStartOffset = checkpoint.scanOffset;
      const scanEndOffset = Math.min(
        stat.size,
        scanStartOffset + (MAX_SCAN_BYTES_PER_FILE_CYCLE - scannedBytes),
      );
      let terminalTurnId: string | null = null;
      let terminalEndOffset: number | null = null;
      let deferredTurnStart = false;
      let nextTurnStartedAtMs: number | undefined;
      const processScannedLine = (line: JsonLine): void | false => {
        const payload = asRecord(line.record.payload);
        if (!payload) return;
        if (line.record.type === 'session_meta') {
          const ownerSessionMetaOffset = selectOwnerSessionMetaOffset(
            filePath,
            checkpoint.ownerSessionMetaOffset,
            line,
          );
          checkpoint.ownerSessionMetaOffset = ownerSessionMetaOffset;
          if (ownerSessionMetaOffset === line.startOffset) {
            const meta = extractCodexTranscriptMeta(line.record);
            if (meta) {
              this.rememberTranscriptOwnerMeta(
                filePath,
                checkpoint.inode,
                stat.size,
                ownerSessionMetaOffset,
                meta,
              );
              this.publishTranscriptOwnerMeta(filePath, meta);
            }
          }
          return;
        }

        const turnId = turnIdForStart(line.record, payload);
        if (turnId) {
          if (checkpoint.activeTurn && checkpoint.activeTurn.turnId !== turnId) {
            // The previous terminal may have been quarantined. Close its
            // retained steps before replacing it, and leave this new start
            // uncommitted so it is processed again after recovery succeeds.
            terminalTurnId = checkpoint.activeTurn.turnId;
            terminalEndOffset = line.startOffset;
            deferredTurnStart = true;
            nextTurnStartedAtMs = timestampMs(line.record, Date.now());
            return false;
          }
          if (!checkpoint.activeTurn) {
            checkpoint.activeTurn = createActiveTurn(turnId, line.startOffset, timestampMs(line.record, Date.now()));
          }
          updateActiveTurnMetadata(checkpoint.activeTurn, line.record, payload);
          return;
        }

        const terminal = terminalTurnIdFor(line.record, payload);
        if (!terminal || checkpoint.activeTurn?.turnId !== terminal) return;
        terminalTurnId = terminal;
        terminalEndOffset = line.endOffset;
        return false;
      };
      let scan = await scanJsonLines(
        filePath,
        scanStartOffset,
        scanEndOffset,
        processScannedLine,
        runtime,
      );

      // A single JSONL record may exceed the byte budget. Read far enough to
      // consume one complete line so this file can make forward progress.
      if (scan.nextOffset === scanStartOffset && scanEndOffset < stat.size) {
        scan = await scanJsonLines(
          filePath,
          scanStartOffset,
          stat.size,
          line => {
            processScannedLine(line);
            return false;
          },
          runtime,
        );
      }
      if (scan.incompleteTail?.endOffset === stat.size) {
        const current = await fs.stat(filePath);
        if (sameFileVersion(stat, current)) {
          this.incompleteTails.delete(filePath);
          this.incompleteTails.set(filePath, {
            ...scan.incompleteTail,
            inode: stat.ino,
            device: stat.dev,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            fileSize: stat.size,
          });
          // Bound metadata even when many abandoned sessions have partial tails.
          if (this.incompleteTails.size > MAX_CACHED_INCOMPLETE_TAILS) {
            this.incompleteTails.delete(this.incompleteTails.keys().next().value!);
          }
        }
      }
      if (scan.nextOffset === scanStartOffset) break;
      checkpointChanged = true;

      const nextScanOffset = terminalEndOffset ?? scan.nextOffset;
      runtime?.observeCommittedBatch({
        bytes: nextScanOffset - scanStartOffset,
        records: scan.records - Number(deferredTurnStart),
        parseSuccessRecords: scan.parseSuccessRecords - Number(deferredTurnStart),
        parseFailedRecords: scan.parseFailedRecords,
        maxRecordBytes: scan.maxRecordBytes,
      });
      scannedBytes += nextScanOffset - scanStartOffset;
      let blocked = false;

      if (checkpoint.activeTurn && (terminalTurnId || nextScanOffset > checkpoint.activeTurn.startOffset)) {
          if (
            isDirectSubagent
            && terminalTurnId
            && shouldSkipCopiedParentTurn(
              terminalTurnId,
              checkpoint.activeTurn.startedAtMs,
              ownerMeta?.createdAtMs,
            )
          ) {
            // Forked child rollouts contain copied parent history after their
            // owning session_meta. It must not become the child's pending turn.
            checkpoint.activeTurn = null;
            processedTerminalCount++;
            checkpoint.scanOffset = nextScanOffset;
            continue;
          }

          const recovered = await this.recoverTurnSegment(
            filePath,
            checkpoint,
            nextScanOffset,
            terminalTurnId !== null,
            deferredTurnStart ? 'interrupted' : undefined,
            undefined,
            nextTurnStartedAtMs,
          );
          emittedCount += this.emitEntryBatches(recovered.entries);
          if (
            recovered.kind !== 'unparseable'
            && recovered.consumedEndOffset > checkpoint.activeTurn.startOffset
          ) {
            checkpoint.activeTurn.startOffset = recovered.consumedEndOffset;
          }

          if (terminalTurnId && checkpoint.activeTurn.turnId === terminalTurnId) {
            if (recovered.kind === 'unparseable') {
              const now = Date.now();
              const pending = newPendingTerminal(
                terminalTurnId,
                nextScanOffset,
                recovered.diagnostics.sourceRecordCount,
                now,
              );
              checkpoint.pendingTerminal = pending;
              this.noteTerminalFailure(pending, stat, now);
              const startOffset = checkpoint.activeTurn.startOffset;
              const deferred = this.deferPendingTerminal(checkpoint);
              this.logTerminalFailure(filePath, checkpoint, pending, { startOffset, phase: 'terminal', deferred });
              blocked = !deferred;
              processedTerminalCount++;
            } else if (!checkpoint.pendingFusion) {
              checkpoint.activeTurn = null;
              checkpoint.pendingTerminal = null;
              processedTerminalCount++;
            } else {
              // A deferred next-turn start may make no byte progress. Yield
              // until pending fusion is resolved rather than spinning here.
              blocked = true;
            }
        }
      }

      checkpoint.scanOffset = nextScanOffset;
      if (blocked || terminalTurnId === null) break;
    }

    if (
      forkBootstrapAtOwnedScanStart
      && checkpoint.scanOffset > ownedScanStartOffset
    ) {
      checkpoint.forkBootstrap = undefined;
      checkpointChanged = true;
    }
    if (checkpointChanged) this.saveCheckpoint(key, checkpoint);
    return emittedCount;
  }

  private async incompleteTailReady(
    filePath: string,
    startOffset: number,
    stat: fsSync.Stats,
    runtime: InputRuntimeAccumulator | null,
  ): Promise<boolean> {
    const tail = this.incompleteTails.get(filePath);
    if (!tail) return true;
    this.incompleteTails.delete(filePath);
    if (
      tail.startOffset !== startOffset || tail.inode !== stat.ino || tail.device !== stat.dev
      || stat.size < tail.fileSize
      || (stat.size === tail.fileSize && (stat.mtimeMs !== tail.mtimeMs || stat.ctimeMs !== tail.ctimeMs))
    ) return true;
    if (stat.size === tail.endOffset) {
      if (stat.mtimeMs !== tail.mtimeMs || stat.ctimeMs !== tail.ctimeMs) return true;
      this.incompleteTails.set(filePath, tail);
      return false;
    }
    const handle = await fs.open(filePath, 'r');
    try {
      const read = async (position: number, length: number): Promise<Buffer> => {
        const chunk = Buffer.alloc(length);
        const started = runtime?.now();
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (runtime && started !== undefined) runtime.observeRead(bytesRead, length, runtime.now() - started);
        return chunk.subarray(0, bytesRead);
      };
      const anchorBytes = tail.anchor.length / 2;
      const anchor = await read(tail.endOffset - anchorBytes, anchorBytes);
      if (anchor.toString('hex') !== tail.anchor) return true;
      let position = tail.endOffset;
      let last = anchor;
      const searchEnd = Math.min(stat.size, position + MAX_SCAN_BYTES_PER_FILE_CYCLE);
      while (position < searchEnd) {
        const chunk = await read(position, Math.min(READ_CHUNK_SIZE, searchEnd - position));
        if (chunk.length === 0) return true;
        if (chunk.includes(0x0a)) return true;
        position += chunk.length;
        last = chunk.length >= 64 ? chunk.subarray(-64) : Buffer.concat([last, chunk]).subarray(-64);
      }
      if (sameFileVersion(stat, await handle.stat())) {
        this.incompleteTails.set(filePath, {
          ...tail, endOffset: position, anchor: last.toString('hex'),
          mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
          fileSize: stat.size,
        });
      }
      return false;
    } finally {
      await handle.close();
    }
  }

  /**
   * A completed terminal line is never retried by the normal offset scan.
   * Persist the range and retry it before reading later transcript data.
   */
  private async recoverPendingTerminal(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    stat: fsSync.Stats,
  ): Promise<PendingRecoveryResult> {
    const pending = checkpoint.pendingTerminal;
    if (!pending) return { blocked: false, emittedCount: 0, processedTerminalCount: 0 };
    if (checkpoint.activeTurn?.turnId !== pending.turnId) {
      checkpoint.pendingTerminal = null;
      return { blocked: false, emittedCount: 0, processedTerminalCount: 0 };
    }
    if (!this.terminalRetryReady(pending, stat)) {
      // No conversion is attempted, so no terminal attempt budget is spent,
      // even when full deferred capacity leaves this pending barrier blocked.
      const deferred = this.deferPendingTerminal(checkpoint);
      return { blocked: !deferred, emittedCount: 0, processedTerminalCount: 0 };
    }
    const recovered = await this.recoverTurnSegment(filePath, checkpoint, pending.terminalEndOffset, true);
    if (recovered.kind === 'unparseable') {
      const now = Date.now();
      checkpoint.pendingTerminal = {
        ...pending,
        retryCount: Math.min(Number.MAX_SAFE_INTEGER, (pending.retryCount ?? 0) + 1),
        firstPendingAtMs: pending.firstPendingAtMs ?? now,
        lastAttemptAtMs: now,
        sourceRecordCount: recovered.diagnostics.sourceRecordCount,
      };
      this.noteTerminalFailure(checkpoint.pendingTerminal, stat, now);
      const failedPending = checkpoint.pendingTerminal;
      const startOffset = checkpoint.activeTurn.startOffset;
      const deferred = this.deferPendingTerminal(checkpoint);
      this.logTerminalFailure(filePath, checkpoint, failedPending, { startOffset, phase: 'pending', deferred });
      return { blocked: !deferred, emittedCount: 0, processedTerminalCount: 1 };
    }

    const emittedCount = this.emitEntryBatches(recovered.entries);
    checkpoint.activeTurn = null;
    checkpoint.pendingTerminal = null;
    return { blocked: false, emittedCount, processedTerminalCount: 1 };
  }

  private logTerminalFailure(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    pending: CodexPendingTerminalTurn,
    context: { startOffset: number; phase: 'terminal' | 'pending' | 'deferred'; deferred: boolean },
  ): void {
    // Report the retained pending barrier in this checkpoint snapshot. A
    // deferred range can coexist with a different blocking pending terminal.
    this.logger.warn('Codex terminal turn could not be parsed; retained until source changes and backoff expires', {
      transcriptPath: filePath,
      turnId: pending.turnId,
      recoveryPhase: context.phase,
      range: { startOffset: context.startOffset, endOffset: pending.terminalEndOffset },
      retryCount: pending.retryCount ?? 0,
      firstPendingAtMs: pending.firstPendingAtMs,
      lastAttemptAtMs: pending.lastAttemptAtMs,
      sourceRecordCount: pending.sourceRecordCount ?? 0,
      retryDelayMs: pending.failure?.delayMs,
      deferred: context.deferred,
      deferredRanges: checkpoint.deferredTerminals?.length ?? 0,
      deferredLimit: MAX_DEFERRED_TERMINALS,
      blocked: checkpoint.pendingTerminal !== null,
      blockingTurnId: checkpoint.pendingTerminal?.turnId,
    });
  }

  private terminalRetryReady(pending: CodexPendingTerminalTurn, stat: fsSync.Stats): boolean {
    // Allow an initial attempt for legacy checkpoints. An unparseable result
    // records failure before saving, so later cycles/restarts remain gated.
    return !pending.failure || (pending.failure.sourceVersion !== sourceVersion(stat)
      && Date.now() >= pending.failure.retryAtMs);
  }

  private noteTerminalFailure(pending: CodexPendingTerminalTurn, stat: fsSync.Stats, now: number): void {
    const delayMs = Math.min(RECOVERY_RETRY_MAX_MS,
      Math.max(RECOVERY_RETRY_MIN_MS, (pending.failure?.delayMs ?? RECOVERY_RETRY_MIN_MS / 2) * 2));
    pending.failure = { sourceVersion: sourceVersion(stat), delayMs, retryAtMs: now + delayMs };
  }

  private deferPendingTerminal(checkpoint: CodexTranscriptCheckpoint): boolean {
    if (!checkpoint.activeTurn || !checkpoint.pendingTerminal) return false;
    const deferred = checkpoint.deferredTerminals ?? [];
    if (deferred.length >= MAX_DEFERRED_TERMINALS) return false;
    deferred.push({ activeTurn: checkpoint.activeTurn, pendingTerminal: checkpoint.pendingTerminal });
    checkpoint.deferredTerminals = deferred;
    checkpoint.scanOffset = Math.max(checkpoint.scanOffset, checkpoint.pendingTerminal.terminalEndOffset);
    checkpoint.activeTurn = null;
    checkpoint.pendingTerminal = null;
    return true;
  }

  private async recoverDeferredTerminals(
    filePath: string, checkpoint: CodexTranscriptCheckpoint, stat: fsSync.Stats,
  ): Promise<{ changed: boolean; emittedCount: number; processedTerminalCount: number }> {
    const deferred = checkpoint.deferredTerminals;
    if (!deferred?.length) return { changed: false, emittedCount: 0, processedTerminalCount: 0 };
    for (let i = 0; i < deferred.length; i++) {
      const item = deferred[i]!;
      if (!this.terminalRetryReady(item.pendingTerminal, stat)) continue;
      const recovery = { ...checkpoint, activeTurn: item.activeTurn, pendingTerminal: item.pendingTerminal };
      const result = await this.recoverTurnSegment(filePath, recovery, item.pendingTerminal.terminalEndOffset, true);
      if (result.kind === 'unparseable') {
        const now = Date.now();
        item.pendingTerminal.retryCount = Math.min(Number.MAX_SAFE_INTEGER, (item.pendingTerminal.retryCount ?? 0) + 1);
        item.pendingTerminal.firstPendingAtMs ??= now;
        item.pendingTerminal.lastAttemptAtMs = now;
        item.pendingTerminal.sourceRecordCount = result.diagnostics.sourceRecordCount;
        this.noteTerminalFailure(item.pendingTerminal, stat, now);
        this.logTerminalFailure(filePath, checkpoint, item.pendingTerminal,
          { startOffset: item.activeTurn.startOffset, phase: 'deferred', deferred: true });
      } else {
        deferred.splice(i, 1);
        if (deferred.length === 0) delete checkpoint.deferredTerminals;
      }
      // At most one deferred range is materialized per file/cycle. Do not let
      // several failed histories accumulate simultaneous parsed body arrays.
      // Failed attempts also spend one slot in the shared terminal budget.
      return { changed: true, processedTerminalCount: 1, emittedCount: result.kind === 'unparseable'
        ? 0 : this.emitEntryBatches(result.entries) };
    }
    return { changed: false, emittedCount: 0, processedTerminalCount: 0 };
  }

  private async recoverTurnSegment(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    endOffset: number,
    terminal: boolean,
    inferredTerminalStatus?: 'interrupted',
    attachmentParentThreadId?: string,
    nextTurnStartedAtMs?: number,
  ): Promise<SegmentRecoveryResult> {
    const activeTurn = checkpoint.activeTurn;
    if (!activeTurn) {
      return {
        kind: 'unparseable',
        entries: [],
        consumedEndOffset: endOffset,
        diagnostics: emptySegmentRecoveryDiagnostics(),
      };
    }
    const runtime = this.getInputRuntimeAccumulator();
    const records = await readJsonLines(
      filePath,
      activeTurn.startOffset,
      endOffset,
      runtime,
    );
    let currentStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      currentStat = await fs.stat(filePath);
    } catch {
      // The already-read recovery range can still be processed, but without a
      // trustworthy file-size watermark its metadata must not enter the cache.
    }
    let meta = currentStat?.ino === checkpoint.inode
      ? this.cachedTranscriptOwnerMetaForCheckpoint(filePath, checkpoint, currentStat.size)
      : null;
    if (!meta && checkpoint.ownerSessionMetaOffset !== null) {
      const metaRecord = await readJsonLineAt(filePath, checkpoint.ownerSessionMetaOffset, runtime);
      meta = metaRecord ? extractCodexTranscriptMeta(metaRecord) : null;
      if (meta) {
        if (
          currentStat?.ino === checkpoint.inode
          && checkpoint.ownerSessionMetaOffset >= 0
          && checkpoint.ownerSessionMetaOffset < currentStat.size
        ) {
          this.rememberTranscriptOwnerMeta(
            filePath,
            checkpoint.inode,
            currentStat.size,
            checkpoint.ownerSessionMetaOffset,
            meta,
          );
        }
        this.publishTranscriptOwnerMeta(filePath, meta);
      }
    }
    // A different turn proves this turn ended, but cannot reveal whether its
    // unreadable terminal meant success or cancellation. Infer interruption at
    // the next start; a recovery-only boundary also handles an empty retained
    // range after every response was already committed. Never persist it as a
    // source record or include the new turn's input in the previous turn.
    const extractionRecords = nextTurnStartedAtMs === undefined ? records.items : [
      ...records.items,
      {
        startOffset: endOffset,
        endOffset,
        record: {
          timestamp: new Date(nextTurnStartedAtMs).toISOString(),
          type: 'event_msg',
          payload: { type: 'turn_aborted', turn_id: activeTurn.turnId },
        },
      },
    ];
    const extraction = extractCodexPartialTurnWithBoundaries(
      extractionRecords,
      meta,
      sessionIdFromTranscriptPath(filePath),
      activeTurn.turnId,
      this.partialTurnOptions(activeTurn, filePath, attachmentParentThreadId ?? activeTurn.delegation?.parentThreadId ?? meta?.parentThreadId),
    );
    const previouslyEmittedStepCount = activeTurn.emittedStepCount ?? 0;
    if (!extraction) {
      return {
        kind: 'unparseable',
        entries: [],
        consumedEndOffset: activeTurn.startOffset,
        diagnostics: emptySegmentRecoveryDiagnostics(records.items.length, previouslyEmittedStepCount),
      };
    }
    const turn = extraction.turn;
    if (inferredTerminalStatus) turn.status = inferredTerminalStatus;
    updateActiveTurnFromExtractedTurn(activeTurn, turn);
    if (turn.unmatchedTokenUsages.length > 0) {
      this.logger.warn('Codex transcript token samples could not be assigned to a response wave', {
        transcriptPath: filePath,
        turnId: activeTurn.turnId,
        count: turn.unmatchedTokenUsages.length,
        lastUsage: turn.unmatchedTokenUsages.at(-1),
      });
    }

    const stepStart = (activeTurn.emittedStepCount ?? 0) + 1;
    const closedStepCount = terminal
      ? turn.steps.length
      : extraction.committedStepCount;
    const committedTurn = closedStepCount === turn.steps.length
      ? turn
      : { ...turn, steps: turn.steps.slice(0, closedStepCount) };
    const inputContext = await this.resolveInputContext(filePath, activeTurn, meta, attachmentParentThreadId);
    const built = buildCodexTranscriptSegment(committedTurn, {
      includePrompt: activeTurn.emittedPrompt !== true,
      startStepNumber: stepStart,
      ...(inputContext ? { inputContext } : {}),
      contextStepCount: committedTurn.steps.length,
    });
    if (meta) {
      const hasCanonicalUserInput = records.items.some(source => source.record.type === 'response_item'
        && asRecord(source.record.payload)?.type === 'message' && isCodexWorkInput(source, turn.transcriptTurnId));
      // Canonical user input precedes its legacy mirror before model execution.
      // Both remain in the unfinished range; legacy-only rollouts retain the fallback.
      const hasNewWork = records.items.some(source => source.startOffset >= checkpoint.scanOffset
        && (!hasCanonicalUserInput || source.record.type !== 'event_msg')
        && isCodexWorkInput(source, turn.transcriptTurnId));
      // Rereading an unfinished wave must preserve its original binding. After
      // new unbound work, however, saved linker context must not revive it.
      if (!activeTurn.delegationUnbound || hasNewWork) {
        const resolved = this.subagentLinker.resolveWork(meta, turn, records.items, checkpoint.firstOwnedTurnId === turn.transcriptTurnId);
        if (resolved) {
          activeTurn.delegation = resolved;
          activeTurn.delegationUnbound = undefined;
        } else if (hasNewWork && activeTurn.delegation) {
          activeTurn.delegation = undefined;
          activeTurn.delegationUnbound = true;
        }
      }
    }
    const delegation = activeTurn.delegation;
    if (delegation && terminal) this.subagentLinker.registerCompletedWorkResult(delegation, turn, records.items);
    const traceId = activeTurn.emittedTraceId
      ?? delegation?.parentTraceId
      ?? stringValue(built.entries[0]?.trace_id)
      ?? crypto.createHash('sha256').update([turn.sessionId, turn.transcriptTurnId, 'trace'].join('\0')).digest('hex').slice(0, 32);
    if (traceId && built.entries.length > 0) activeTurn.emittedTraceId = traceId;
    if (traceId) built.entries = built.entries.map(entry => ({ ...entry, trace_id: traceId }));
    if (delegation) {
      built.entries = stampCodexDelegation(built.entries, delegation, meta, traceId === delegation.parentTraceId);
    }
    const dispatchTurn = withPendingCodexDispatches(turn, records.items);
    let spawns = traceId ? extractCodexSpawnDescriptors(dispatchTurn, records.items, traceId) : [];
    this.subagentLinker.registerSpawns(spawns);
    if (spawns.length > 0) {
      const known = new Map(this.subagentLinker.getDelegationsForParent(turn.sessionId)
        .map(work => [work.invocationId, work]));
      spawns = spawns.map(work => known.get(work.invocationId) ?? work);
    }
    built.entries = appendCodexInvocations(built.entries, spawns);
    if (closedStepCount < dispatchTurn.steps.length && spawns.length > 0) {
      // The dispatch audit boundary does not wait for a long-running tool or
      // model wave to become eligible for the normal streaming checkpoint.
      const committedCalls = new Set(built.entries.filter(entry => entry['event.name'] === 'tool.call')
        .map(entry => entry['gen_ai.tool.call.id']));
      let calls = buildCodexTranscriptSegment(dispatchTurn, {
        includePrompt: false, startStepNumber: stepStart,
        ...(inputContext ? { inputContext } : {}),
      }).entries.filter(entry => entry['event.name'] === 'tool.call' && !committedCalls.has(entry['gen_ai.tool.call.id']))
        .map(entry => ({ ...entry, ...(traceId ? { trace_id: traceId } : {}) }));
      if (delegation) calls = stampCodexDelegation(calls, delegation, meta, traceId === delegation.parentTraceId);
      built.entries.push(...appendCodexInvocations(calls, spawns).filter(entry => entry['event.name'] === 'gen_ai.agent.invoke'));
    }
    if (built.entries.length > 0) activeTurn.emittedTraceId = traceId;
    const auditContext = codexAuditContext(turn, traceId);
    const auditBase = delegation ? stampCodexDelegation([auditContext], delegation, meta, traceId === delegation.parentTraceId)[0]! : auditContext;
    if (hasCodexResultDelivery(built.entries, records.items, spawns)) {
      built.entries = appendCodexAgentResults(built.entries, records.items,
        this.subagentLinker.getDelegationsForParent(turn.sessionId), turn.sessionId, this.deliveredInvocations, auditBase,
        (source, context) => this.retainPendingAgentResult(filePath, checkpoint.inode, source, context),
        () => { this.lastPendingAgentResultState = undefined; });
    }
    // A Codex model wave may finish with `stop` and then resume in the same
    // transcript turn (for example after a subagent completion notification or
    // a failed spawn retry). Emit a distinct lifecycle marker only after the
    // task_complete / turn_aborted boundary, or before a different turn starts
    // when the terminal was unreadable. This also closes a turn whose final
    // LLM response was already emitted in an earlier poll.
    const readyEntries = terminal && (built.entries.length > 0 || activeTurn.emittedTraceId)
      ? [...built.entries, codexTurnEndMarker(built.entries.length > 0 ? built.entries : [auditBase], turn)]
      : built.entries;
    const entries = this.filterNewSegmentEntries(readyEntries, activeTurn);
    const diagnostics: SegmentRecoveryDiagnostics = {
      sourceRecordCount: records.items.length,
      stepCount: turn.steps.length,
      toolCount: turn.steps.reduce((count, step) => count + step.tools.length, 0),
      tokenUsageCount: turn.steps.filter(step => step.tokenUsage !== undefined).length,
      unmatchedTokenUsageCount: turn.unmatchedTokenUsages.length,
      builtEntryCount: built.entries.length,
      readyEntryCount: readyEntries.length,
      deduplicatedEntryCount: readyEntries.length - entries.length,
      emittedEntryCount: entries.length,
      previouslyEmittedStepCount,
    };

    if (terminal && entries.length === 0) {
      if (built.entries.length === 0) {
        this.logger.debug('processed terminal Codex turn without observable entries', {
          transcriptPath: filePath,
          turnId: activeTurn.turnId,
          terminalStatus: turn.status,
          diagnostics,
        });
      } else if (readyEntries.length > 0 && diagnostics.deduplicatedEntryCount === readyEntries.length) {
        this.logger.debug('terminal Codex turn entries were already emitted incrementally', {
          transcriptPath: filePath,
          turnId: activeTurn.turnId,
          terminalStatus: turn.status,
          diagnostics,
        });
      } else {
        this.logger.warn('processed terminal Codex turn produced no explainable new entries', {
          transcriptPath: filePath,
          turnId: activeTurn.turnId,
          terminalStatus: turn.status,
          diagnostics,
        });
      }
    }

    activeTurn.emittedStepCount = (activeTurn.emittedStepCount ?? 0) + closedStepCount;

    const lastClosedRange = closedStepCount > 0
      ? extraction.committedStepRanges[closedStepCount - 1]
      : undefined;
    if (closedStepCount > 0) {
      activeTurn.inputContext = persistedInputContext(built.nextInputContext, lastClosedRange);
      if (extraction.nextStepStartedAtMs !== undefined) {
        activeTurn.nextStepStartedAtMs = extraction.nextStepStartedAtMs;
      }
      if (extraction.lastCumulativeTokenTotal !== undefined) {
        activeTurn.lastCumulativeTokenTotal = extraction.lastCumulativeTokenTotal;
      }
    }

    const consumedEndOffset = terminal
      ? endOffset
      : extraction.consumedEndOffset;

    const [resourceAttributes, spanAttributes] = await Promise.all([
      this.readWakeupResourceAttributes(turn.sessionId),
      this.readTurnSpanAttributes(turn.sessionId, activeTurn.turnId),
    ]);
    let outputEntries = resourceAttributes
      ? attachWakeupResourceAttributes(entries, resourceAttributes)
      : entries;
    if (spanAttributes) {
      outputEntries = attachTurnSpanAttributes(outputEntries, spanAttributes);
    }
    const parentSession = delegation?.parentThreadId ?? meta?.parentThreadId;
    if (parentSession && !this.workspacePolicy.allows({ 'gen_ai.session.id': parentSession }, this.agentType)) outputEntries = [];
    return {
      kind: outputEntries.length > 0 ? 'processed-emitted' : 'processed-empty',
      entries: outputEntries,
      consumedEndOffset,
      terminalStatus: turn.status,
      diagnostics,
    };
  }

  private async resolveInputContext(
    filePath: string,
    activeTurn: CodexActiveTranscriptTurn,
    meta: ReturnType<typeof extractCodexTranscriptMeta>,
    attachmentParentThreadId?: string,
  ): Promise<CodexTranscriptInputContext | undefined> {
    const context = activeTurn.inputContext;
    if (!context || context.delta) return context;
    const range = context.deltaRange;
    if (!range) return context;

    const records = await readJsonLines(
      filePath,
      range.startOffset,
      range.endOffset,
      this.getInputRuntimeAccumulator(),
    );
    const previous = extractCodexPartialTurn(
      records.items.map(item => item.record),
      meta,
      sessionIdFromTranscriptPath(filePath),
      activeTurn.turnId,
      this.partialTurnOptions(activeTurn, filePath, attachmentParentThreadId),
    );
    const lastStep = previous?.steps.at(-1);
    if (!lastStep) {
      this.logger.warn('could not rebuild oversized Codex input delta from transcript range', {
        transcriptPath: filePath,
        turnId: activeTurn.turnId,
        range,
      });
      return context;
    }
    return { ...context, delta: nextInputMessagesForStep(lastStep) };
  }

  private async registerSubagentOwnerMeta(
    filePath: string,
    inode: number,
    fileSize: number,
    ownerSessionMetaOffset: number | null,
    cacheAccess: TranscriptMetaCacheAccess = 'active',
  ): Promise<void> {
    if (ownerSessionMetaOffset === null) return;
    const indexedMeta = cacheAccess === 'active'
      && !this.transcriptMetaCacheByPath.has(filePath)
      ? this.transcriptMetaByPath.get(filePath)
      : null;
    if (indexedMeta) {
      this.rememberTranscriptOwnerMeta(
        filePath,
        inode,
        fileSize,
        ownerSessionMetaOffset,
        indexedMeta,
        'active',
      );
      this.publishTranscriptOwnerMeta(filePath, indexedMeta);
      return;
    }
    const meta = await this.loadTranscriptOwnerMeta(
      filePath,
      inode,
      fileSize,
      ownerSessionMetaOffset,
      this.getInputRuntimeAccumulator(),
      cacheAccess,
    );
    if (meta) this.publishTranscriptOwnerMeta(filePath, meta);
  }

  private async indexDiscoveredTranscriptOwners(
    files: DiscoveredSessionFile[],
    skipPaths?: ReadonlySet<string>,
    mode: 'full' | 'targeted' = 'full',
  ): Promise<void> {
    const kept = new Map<string, NonNullable<ReturnType<typeof extractCodexTranscriptMeta>>>();
    const discoveredPaths = new Set(files.map(file => file.filePath));
    if (mode === 'targeted') {
      for (const [filePath, meta] of this.transcriptMetaByPath) {
        if (meta && !discoveredPaths.has(filePath)) kept.set(filePath, meta);
      }
    }
    if (skipPaths) {
      for (const filePath of skipPaths) {
        const meta = this.transcriptMetaByPath.get(filePath);
        if (meta) kept.set(filePath, meta);
      }
    }
    this.transcriptMetaByPath.clear();
    this.transcriptPathByThreadId.clear();
    // Only a complete discovery can establish that an unrelated file is gone.
    if (mode === 'full') this.pruneAbsentTranscriptMetaCache(discoveredPaths, Date.now());
    for (const [filePath, meta] of kept) {
      this.publishTranscriptOwnerMeta(filePath, meta);
    }
    for (const { filePath } of files) {
      if (skipPaths?.has(filePath)) continue;
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }
      const checkpoint = this.readCheckpoint(this.stateKey(filePath));
      const ownerOffset = checkpoint?.inode === stat.ino
        ? checkpoint.ownerSessionMetaOffset ?? await this.findOwnerOffset(filePath, stat)
        : await this.findOwnerOffset(filePath, stat);
      if (ownerOffset === null) continue;
      const meta = await this.loadTranscriptOwnerMeta(
        filePath,
        stat.ino,
        stat.size,
        ownerOffset,
        this.getInputRuntimeAccumulator(),
        'discovery',
      );
      if (!meta) continue;
      this.publishTranscriptOwnerMeta(filePath, meta);
    }
  }

  private async findOwnerOffset(
    filePath: string,
    stat: fsSync.Stats,
    endOffset = stat.size,
  ): Promise<number | null> {
    const stateKey = this.stateKey(filePath);
    const version = sourceVersion(stat);
    const key = filePath + '\0' + version + '\0' + endOffset;
    const previous = this.ownerOffsetProbes.get(key);
    const absentVersion = this.stateStore.get(stateKey).extra?.codexOwnerAbsentVersion;
    // A full, stable negative result belongs to this file's checkpoint, not
    // the shared LRU: inventories larger than the LRU otherwise evict every
    // result before the next poll. This does not advance the collection cursor
    // or bypass pending turn/fork recovery. Prefix probes remain independent.
    if (endOffset === stat.size && typeof absentVersion === 'string'
      && absentVersion.length <= 256 && absentVersion === version) return null;
    // Owner selection uses the rollout filename, so paths stay distinct even
    // for hard links. Different scan boundaries can coexist for one version.
    // NUL cannot occur in a filesystem path, so the tuple stays unambiguous
    // without allocating an intermediate array or running a JSON serializer.
    // Hits perform no content I/O. A same-size rewrite preserving both
    // timestamps is indistinguishable and can retain stale owner state until
    // another source-version component changes.
    // A shorter search cannot establish absence in the rest of the file, and
    // an owner found by a longer search may lie outside the requested prefix.
    if (previous !== undefined) return previous;
    const { offset, completeAbsence } = await findOwnerSessionMetaOffset(
      filePath, endOffset, this.getInputRuntimeAccumulator(),
    );
    // Never cache a result observed while a writer changed or removed the file.
    try {
      if (!sameFileVersion(stat, await fs.stat(filePath))) return null;
    } catch {
      return null;
    }
    this.ownerOffsetProbes.set(key, offset);
    const current = this.stateStore.get(stateKey);
    if (completeAbsence && endOffset === stat.size) {
      // Separate from codexTranscript so a caller holding an older checkpoint
      // cannot overwrite the evidence when it later saves its scan progress.
      this.stateStore.update(stateKey, { extra: { ...current.extra, codexOwnerAbsentVersion: version } });
    } else if (offset !== null && current.extra?.codexOwnerAbsentVersion !== undefined) {
      const { codexOwnerAbsentVersion: _discarded, ...extra } = current.extra;
      this.stateStore.set(stateKey, { ...current, extra });
    }
    return offset;
  }

  private async loadTranscriptOwnerMeta(
    filePath: string,
    inode: number,
    fileSize: number,
    ownerSessionMetaOffset: number,
    runtime?: InputRuntimeAccumulator | null,
    cacheAccess: TranscriptMetaCacheAccess = 'active',
  ): Promise<CodexTranscriptMeta | null> {
    const cached = this.transcriptMetaCacheByPath.get(filePath);
    if (cached && reusableCachedTranscriptMeta(cached, inode, fileSize, ownerSessionMetaOffset)) {
      cached.fileSize = fileSize;
      cached.lastSeenAtMs = Date.now();
      if (cacheAccess === 'active') {
        this.transcriptMetaCacheByPath.delete(filePath);
        this.transcriptMetaCacheByPath.set(filePath, cached);
      }
      return cached.meta;
    }
    if (cached) this.removeTranscriptMetaCacheEntry(filePath);
    if (ownerSessionMetaOffset < 0 || ownerSessionMetaOffset >= fileSize) return null;

    const record = await readJsonLineAt(filePath, ownerSessionMetaOffset, runtime);
    const meta = record ? extractCodexTranscriptMeta(record) : null;
    if (!meta) return null;
    this.rememberTranscriptOwnerMeta(
      filePath,
      inode,
      fileSize,
      ownerSessionMetaOffset,
      meta,
      cacheAccess,
    );
    return meta;
  }

  private rememberTranscriptOwnerMeta(
    filePath: string,
    inode: number,
    fileSize: number,
    ownerSessionMetaOffset: number,
    meta: CodexTranscriptMeta,
    cacheAccess: TranscriptMetaCacheAccess = 'active',
  ): void {
    this.removeTranscriptMetaCacheEntry(filePath);
    const estimatedBytes = estimateCachedTranscriptMetaBytes(filePath, meta);
    if (estimatedBytes > this.transcriptMetaCacheMaxBytes) return;
    // A periodic inventory scan proves that a transcript still exists, not
    // that the user is actively using it. Do not let an uncached historical
    // path evict the small set of sessions that are actually growing.
    if (
      cacheAccess === 'discovery'
      && (
        this.transcriptMetaCacheByPath.size >= this.transcriptMetaCacheMaxEntries
        || this.transcriptMetaCacheBytes + estimatedBytes > this.transcriptMetaCacheMaxBytes
      )
    ) {
      return;
    }
    const cached: CachedCodexTranscriptMeta = {
      inode,
      fileSize,
      ownerSessionMetaOffset,
      meta,
      estimatedBytes,
      lastSeenAtMs: Date.now(),
    };
    this.transcriptMetaCacheByPath.set(filePath, cached);
    this.transcriptMetaCacheBytes += estimatedBytes;
    this.trimTranscriptMetaCache();
  }

  private cachedTranscriptOwnerMetaForCheckpoint(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    fileSize: number,
  ): CodexTranscriptMeta | null {
    if (checkpoint.ownerSessionMetaOffset === null) return null;
    const cached = this.transcriptMetaCacheByPath.get(filePath);
    if (
      !cached
      || !reusableCachedTranscriptMeta(
        cached,
        checkpoint.inode,
        fileSize,
        checkpoint.ownerSessionMetaOffset,
      )
    ) {
      return null;
    }
    cached.fileSize = fileSize;
    cached.lastSeenAtMs = Date.now();
    this.transcriptMetaCacheByPath.delete(filePath);
    this.transcriptMetaCacheByPath.set(filePath, cached);
    return cached.meta;
  }

  private pruneAbsentTranscriptMetaCache(discoveredPaths: Set<string>, now: number): void {
    for (const [filePath, cached] of this.transcriptMetaCacheByPath) {
      if (
        !discoveredPaths.has(filePath)
        && now - cached.lastSeenAtMs >= CACHED_TRANSCRIPT_META_ABSENCE_TTL_MS
      ) {
        this.removeTranscriptMetaCacheEntry(filePath);
      }
    }
  }

  private removeTranscriptMetaCacheEntry(filePath: string): void {
    const cached = this.transcriptMetaCacheByPath.get(filePath);
    if (!cached) return;
    this.transcriptMetaCacheByPath.delete(filePath);
    this.transcriptMetaCacheBytes = Math.max(0, this.transcriptMetaCacheBytes - cached.estimatedBytes);
  }

  private trimTranscriptMetaCache(): void {
    while (
      this.transcriptMetaCacheByPath.size > this.transcriptMetaCacheMaxEntries
      || this.transcriptMetaCacheBytes > this.transcriptMetaCacheMaxBytes
    ) {
      const oldest = this.transcriptMetaCacheByPath.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.removeTranscriptMetaCacheEntry(oldest);
    }
  }

  private publishTranscriptOwnerMeta(filePath: string, meta: CodexTranscriptMeta): void {
    const previous = this.transcriptMetaByPath.get(filePath);
    if (
      previous
      && previous.threadId !== meta.threadId
      && this.transcriptPathByThreadId.get(previous.threadId) === filePath
    ) {
      this.transcriptPathByThreadId.delete(previous.threadId);
    }
    this.transcriptMetaByPath.set(filePath, meta);
    this.transcriptPathByThreadId.set(meta.threadId, filePath);
    // Linker descriptors have an independent eviction policy. Re-register on
    // every publish, including cache hits, so metadata and linkage cannot drift.
    this.subagentLinker.registerChild(meta);
  }

  private registerPersistedSubagentSpawns(
    checkpoint: CodexTranscriptCheckpoint,
    parentThreadId: string,
  ): void {
    const active = checkpoint.activeTurn;
    if (!active?.subagentSpawns?.length) return;
    this.subagentLinker.registerSpawns(active.subagentSpawns.map(spawn => ({
      parentThreadId,
      parentTurnId: active.turnId,
      parentTraceId: spawn.parentTraceId,
      parentToolCallId: spawn.parentToolCallId,
      spawnedAtMs: spawn.spawnedAtMs,
      ...(spawn.taskName ? { taskName: spawn.taskName } : {}),
      ...(spawn.agentPath ? { agentPath: spawn.agentPath } : {}),
      ...(spawn.childThreadId ? { childThreadId: spawn.childThreadId } : {}),
    })));
  }

  /** Legacy parent checkpoints can retain child bytes not yet independently emitted. */
  private hasLegacyPendingFusionForParent(parentThreadId: string): boolean {
    for (const key of this.stateStore.keys()) {
      if (!key.startsWith(`${this.id}:`)) continue;
      const checkpoint = this.readCheckpoint(key);
      if (checkpoint?.pendingFusion?.parentThreadId === parentThreadId) return true;
    }
    return false;
  }

  private async releaseParentFusionIndependently(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
  ): Promise<{ emittedCount: number; processedTerminalCount: number }> {
    const pending = checkpoint.pendingFusion;
    if (!pending) return { emittedCount: 0, processedTerminalCount: 0 };

    checkpoint.scanOffset = Math.max(checkpoint.scanOffset, pending.terminalEndOffset);
    checkpoint.pendingFusion = null;
    this.logger.info('migrating legacy Codex parent fusion checkpoint to independent turn recovery', {
      transcriptPath: filePath,
      turnId: pending.turnId,
    });

    if (!checkpoint.activeTurn) {
      return { emittedCount: 0, processedTerminalCount: 0 };
    }
    const recovered = await this.recoverTurnSegment(
      filePath,
      checkpoint,
      pending.terminalEndOffset,
      true,
    );
    if (recovered.kind === 'unparseable') {
      checkpoint.pendingTerminal = newPendingTerminal(
        pending.turnId,
        pending.terminalEndOffset,
        recovered.diagnostics.sourceRecordCount,
      );
      return { emittedCount: 0, processedTerminalCount: 0 };
    }

    const emittedCount = this.emitEntryBatches(recovered.entries);
    checkpoint.activeTurn = null;
    checkpoint.pendingTerminal = null;
    return { emittedCount, processedTerminalCount: 1 };
  }

  private async releaseCapturedSubagentIndependently(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
  ): Promise<{ emittedCount: number; processedTerminalCount: number }> {
    const captured = checkpoint.pendingSubagent;
    if (!captured) return { emittedCount: 0, processedTerminalCount: 0 };
    const childThreadId = this.transcriptMetaByPath.get(filePath)?.threadId ?? sessionIdFromTranscriptPath(filePath);
    this.subagentLinker.registerSpawns([{
      parentThreadId: captured.parentThreadId,
      parentTurnId: captured.parentTurnId,
      parentTraceId: captured.parentTraceId,
      parentToolCallId: captured.parentToolCallId,
      childThreadId,
      childTurnId: captured.turnId,
      spawnedAtMs: captured.activeTurn.startedAtMs,
    }]);
    const recoveryCheckpoint: CodexTranscriptCheckpoint = {
      ...checkpoint,
      activeTurn: cloneActiveTurn(captured.activeTurn),
      pendingSubagent: null,
    };
    const recovered = await this.recoverTurnSegment(
      filePath,
      recoveryCheckpoint,
      captured.terminalEndOffset,
      true,
    );
    if (recovered.kind === 'unparseable') {
      this.logger.warn('captured Codex child could not be rebuilt for independent fallback', {
        transcriptPath: filePath,
        turnId: captured.turnId,
        parentToolCallId: captured.parentToolCallId,
      });
      return { emittedCount: 0, processedTerminalCount: 0 };
    }
    const emittedCount = this.emitEntryBatches(recovered.entries);
    checkpoint.pendingSubagent = null;
    return { emittedCount, processedTerminalCount: 1 };
  }

  private reportSubagentLinks(): void {
    const snapshot = this.subagentLinker.snapshot();
    if (snapshot.detectedChildren === 0 && snapshot.detectedSpawns === 0) return;

    const summary = [
      snapshot.detectedChildren,
      snapshot.detectedSpawns,
      snapshot.linkedChildren,
      snapshot.orphanChildren,
    ].join(':');
    if (summary !== this.lastSubagentLinkSummary) {
      this.lastSubagentLinkSummary = summary;
      this.logger.info('Codex subagent linker summary', {
        detectedChildren: snapshot.detectedChildren,
        detectedSpawns: snapshot.detectedSpawns,
        linkedChildren: snapshot.linkedChildren,
        orphanChildren: snapshot.orphanChildren,
      });
    }

    for (const link of snapshot.links) {
      const fingerprint = [
        link.confidence,
        link.parentToolCallId ?? '',
        link.orphanReason ?? '',
      ].join(':');
      if (this.reportedSubagentLinks.get(link.childThreadId) === fingerprint) continue;
      // Refresh insertion order when a link changes so the bounded map keeps
      // the most recently reported lifecycle fingerprints.
      this.reportedSubagentLinks.delete(link.childThreadId);
      this.reportedSubagentLinks.set(link.childThreadId, fingerprint);
      trimOldestMap(this.reportedSubagentLinks, MAX_LINK_DESCRIPTORS);
      this.logger.debug('Codex subagent link resolved', {
        childThreadId: link.childThreadId,
        parentThreadId: link.parentThreadId,
        parentTurnId: link.parentTurnId,
        parentToolCallId: link.parentToolCallId,
        agentPath: link.agentPath,
        confidence: link.confidence,
        orphanReason: link.orphanReason,
      });
    }
  }

  private filterNewSegmentEntries(
    entries: AgentActivityEntry[],
    activeTurn: NonNullable<CodexTranscriptCheckpoint['activeTurn']>,
  ): AgentActivityEntry[] {
    const out: AgentActivityEntry[] = [];
    activeTurn.emittedStepRequestIds ??= [];
    activeTurn.emittedStepResponseIds ??= [];
    activeTurn.emittedToolCallIds ??= [];
    activeTurn.emittedToolResultIds ??= [];

    const stepRequests = new Set(activeTurn.emittedStepRequestIds);
    const stepResponses = new Set(activeTurn.emittedStepResponseIds);
    const toolCalls = new Set(activeTurn.emittedToolCallIds);
    const toolResults = new Set(activeTurn.emittedToolResultIds);
    const auditEvents = new Set(activeTurn.emittedAuditEventIds ?? []);

    for (const entry of entries) {
      const eventName = entry['event.name'];
      if (eventName === 'gen_ai.agent.invoke' || eventName === 'gen_ai.agent.result') {
        if (auditEvents.has(entry['event.id'])) continue;
        auditEvents.add(entry['event.id']);
        out.push(entry);
        continue;
      }
      if (eventName === 'other') {
        if (entry['gen_ai.turn.end'] === true) {
          out.push(entry);
          continue;
        }
        if (activeTurn.emittedPrompt) continue;
        activeTurn.emittedPrompt = true;
        out.push({ ...entry, 'gen_ai.turn.start': true });
        continue;
      }

      const stepId = typeof entry['gen_ai.step.id'] === 'string' ? entry['gen_ai.step.id'] : '';
      const toolCallId = typeof entry['gen_ai.tool.call.id'] === 'string' ? entry['gen_ai.tool.call.id'] : '';
      if (eventName === 'llm.request') {
        if (!stepId || stepRequests.has(stepId)) continue;
        stepRequests.add(stepId);
        out.push(entry);
      } else if (eventName === 'llm.response') {
        if (!stepId || stepResponses.has(stepId)) continue;
        stepResponses.add(stepId);
        out.push(entry);
      } else if (eventName === 'tool.call') {
        if (!toolCallId || toolCalls.has(toolCallId)) continue;
        toolCalls.add(toolCallId);
        out.push(entry);
      } else if (eventName === 'tool.result') {
        if (!toolCallId || toolResults.has(toolCallId)) continue;
        toolResults.add(toolCallId);
        out.push(entry);
      } else {
        out.push(entry);
      }
    }

    activeTurn.emittedStepRequestIds = [...stepRequests];
    activeTurn.emittedStepResponseIds = [...stepResponses];
    activeTurn.emittedToolCallIds = [...toolCalls];
    activeTurn.emittedToolResultIds = [...toolResults];
    activeTurn.emittedAuditEventIds = [...auditEvents];
    return out;
  }

  private async readWakeupResourceAttributes(sessionId: string): Promise<Record<string, JsonValue> | undefined> {
    const marker = path.join(this.wakeupDir, `${safeWakeupSessionPart(sessionId)}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(marker, 'utf8');
    } catch {
      return undefined;
    }

    let markerRecord: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw);
      markerRecord = asRecord(parsed);
    } catch {
      this.logger.debug('Codex wakeup marker could not be parsed; resource attributes skipped', { marker });
      return undefined;
    }

    const markerAttributes = asRecord(markerRecord?.resourceAttributes);
    if (!markerAttributes) {
      this.logger.debug('Codex wakeup marker has no resourceAttributes; attribution skipped', { marker });
      return undefined;
    }

    const resourceAttributes: Record<string, JsonValue> = {};
    for (const key of WAKEUP_RESOURCE_ATTRIBUTE_KEYS) {
      const value = markerAttributes[key];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length > MAX_WAKEUP_RESOURCE_ATTRIBUTE_VALUE_LENGTH) {
        this.logger.debug('Codex wakeup resource attribute skipped because value is too long', {
          marker,
          key,
          maxLength: MAX_WAKEUP_RESOURCE_ATTRIBUTE_VALUE_LENGTH,
        });
        continue;
      }
      if (trimmed) resourceAttributes[key] = trimmed;
    }

    if (Object.keys(resourceAttributes).length === 0) {
      this.logger.debug('Codex wakeup marker has no whitelisted resourceAttributes; attribution skipped', { marker });
      return undefined;
    }
    return resourceAttributes;
  }

  private async readWakeupMarker(
    sessionId: string,
    transcriptPath: string,
  ): Promise<CodexWakeupMarker | undefined> {
    const markerPath = path.join(this.wakeupDir, `${safeWakeupSessionPart(sessionId)}.json`);
    let record: Record<string, unknown> | null = null;
    try {
      record = asRecord(JSON.parse(await fs.readFile(markerPath, 'utf8')));
    } catch {
      return undefined;
    }
    if (!record || stringValue(record.session_id) !== sessionId) return undefined;

    const recordedTranscriptPath = stringValue(record.transcript_path);
    if (recordedTranscriptPath) {
      try {
        const [recordedRealPath, transcriptRealPath] = await Promise.all([
          fs.realpath(recordedTranscriptPath),
          fs.realpath(transcriptPath),
        ]);
        if (recordedRealPath !== transcriptRealPath) {
          this.logger.warn('Codex wakeup transcript path differs from discovered session file; accepting session anchor', {
            sessionId,
            recordedTranscriptPath,
            transcriptPath,
          });
        }
      } catch {
        if (path.resolve(recordedTranscriptPath) !== path.resolve(transcriptPath)) {
          this.logger.warn('Codex wakeup transcript path could not be canonicalized; accepting session anchor', {
            sessionId,
            recordedTranscriptPath,
            transcriptPath,
          });
        }
      }
    }
    const initialTurnId = stringValue(record.initial_turn_id);
    const recoveryTurnId = stringValue(record.recovery_turn_id);
    const hookEvent = stringValue(record.hook_event);
    return {
      ...(initialTurnId ? { initialTurnId } : {}),
      ...(recoveryTurnId ? { recoveryTurnId } : {}),
      ...(hookEvent ? { hookEvent } : {}),
    };
  }

  private async readTurnSpanAttributes(
    sessionId: string,
    turnId: string,
  ): Promise<Record<string, string> | undefined> {
    const marker = path.join(this.spanContextDir, spanContextMarkerName(sessionId, turnId));
    let raw: string;
    try {
      raw = await fs.readFile(marker, 'utf8');
    } catch {
      return undefined;
    }

    let markerRecord: Record<string, unknown> | null = null;
    try {
      markerRecord = asRecord(JSON.parse(raw));
    } catch {
      this.logger.debug('Codex span context could not be parsed; invocation attributes skipped', { marker });
      return undefined;
    }

    if (
      !markerRecord
      || stringValue(markerRecord.session_id) !== sessionId
      || stringValue(markerRecord.turn_id) !== turnId
    ) {
      this.logger.debug('Codex span context identifiers do not match the transcript turn', {
        marker,
        sessionId,
        turnId,
      });
      return undefined;
    }

    const receivedAt = stringValue(markerRecord.received_at);
    const receivedAtMs = receivedAt ? Date.parse(receivedAt) : Number.NaN;
    if (Number.isFinite(receivedAtMs) && Date.now() - receivedAtMs > SPAN_CONTEXT_TTL_MS) {
      this.logger.debug('Codex span context is expired; invocation attributes skipped', { marker });
      return undefined;
    }

    const markerAttributes = asRecord(markerRecord.spanAttributes);
    if (!markerAttributes) return undefined;

    const spanAttributes: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(markerAttributes)) {
      const key = rawKey.trim();
      if (
        !key
        || isReservedKey(key)
        || SENSITIVE_SPAN_ATTRIBUTE_NAME_RE.test(key)
        || typeof rawValue !== 'string'
      ) {
        continue;
      }
      const value = rawValue.trim();
      if (!value || value.length > MAX_SPAN_ATTRIBUTE_VALUE_LENGTH) continue;
      spanAttributes[key] = value;
    }

    return Object.keys(spanAttributes).length > 0 ? spanAttributes : undefined;
  }

  /**
   * Prepare the normal scan range for a rollout that starts with copied history.
   * The method owns the complete bootstrap state machine so processFile only
   * needs to distinguish ready-to-scan from waiting-for-more-evidence.
   */
  private async prepareCopiedTranscript(
    filePath: string,
    fileSize: number,
    ownerMeta: CodexTranscriptMeta,
    checkpoint: CodexTranscriptCheckpoint,
  ): Promise<{ ready: boolean; changed: boolean }> {
    const previousBootstrap = checkpoint.forkBootstrap;
    const changed = () => !isDeepStrictEqual(previousBootstrap, checkpoint.forkBootstrap);
    // A newly discovered live fork must not enter the normal scanner until its
    // first positively-owned turn is located.
    if (checkpoint.scanOffset === 0 && checkpoint.forkBootstrap === undefined) {
      checkpoint.forkBootstrap = {
        state: 'live-pending',
        searchOffset: 0,
      };
    }

    const current = checkpoint.forkBootstrap;
    if (!current) return { ready: true, changed: false };
    if (current.state === 'baseline-tail') {
      const rebuilt = await this.rebuildForkBaselineTail(filePath, checkpoint);
      return { ready: rebuilt, changed: rebuilt || changed() };
    }

    // Prefer the lifecycle Hook's exact initial turn. UUIDv7 causality is the
    // fallback; a terminal Hook is recovery evidence, not necessarily turn one.
    const marker = await this.readWakeupMarker(ownerMeta.threadId, filePath);
    let bootstrap: CodexForkBootstrap = current;
    if (marker?.initialTurnId && bootstrap.initialTurnId !== marker.initialTurnId) {
      bootstrap = {
        state: bootstrap.state,
        initialTurnId: marker.initialTurnId,
        ...(marker.recoveryTurnId ? { recoveryTurnId: marker.recoveryTurnId } : {}),
        searchOffset: 0,
      };
    } else if (
      marker?.recoveryTurnId
      && bootstrap.recoveryTurnId !== marker.recoveryTurnId
    ) {
      bootstrap = {
        ...bootstrap,
        recoveryTurnId: marker.recoveryTurnId,
        // The terminal evidence may lie before an EOF reached by an earlier
        // evidence-free UUID probe, so restart that probe from the beginning.
        searchOffset: bootstrap.initialTurnId ? bootstrap.searchOffset : 0,
      };
    }

    const safeSearchOffset = boundedSearchOffset(bootstrap.searchOffset, fileSize);
    if (safeSearchOffset !== bootstrap.searchOffset) {
      this.logger.warn('repaired invalid Codex fork bootstrap search offset', {
        transcriptPath: filePath,
        searchOffset: bootstrap.searchOffset,
        repairedSearchOffset: safeSearchOffset,
        fileSize,
      });
      bootstrap = { ...bootstrap, searchOffset: safeSearchOffset };
    }
    checkpoint.forkBootstrap = bootstrap;
    const searchedNewBytes = bootstrap.searchOffset < fileSize;

    const searchStat = await fs.stat(filePath);
    if (searchStat.size !== fileSize) return { ready: false, changed: changed() };
    if (!await this.incompleteTailReady(filePath, bootstrap.searchOffset, searchStat, this.getInputRuntimeAccumulator())) {
      return { ready: false, changed: changed() };
    }

    const located = await findTurnStartOffset(
      filePath,
      ownerMeta.threadId,
      bootstrap.initialTurnId,
      bootstrap.recoveryTurnId,
      bootstrap.searchOffset,
      fileSize,
      this.getInputRuntimeAccumulator(),
    );
    if (located.incompleteTail?.endOffset === fileSize && sameFileVersion(searchStat, await fs.stat(filePath))) {
      this.incompleteTails.delete(filePath);
      this.incompleteTails.set(filePath, {
        ...located.incompleteTail, inode: searchStat.ino, device: searchStat.dev,
        mtimeMs: searchStat.mtimeMs, ctimeMs: searchStat.ctimeMs, fileSize,
      });
      if (this.incompleteTails.size > MAX_CACHED_INCOMPLETE_TAILS) {
        this.incompleteTails.delete(this.incompleteTails.keys().next().value!);
      }
    }
    if (located.startOffset === null) {
      checkpoint.forkBootstrap = {
        state: bootstrap.state,
        ...(bootstrap.initialTurnId ? { initialTurnId: bootstrap.initialTurnId } : {}),
        ...(bootstrap.recoveryTurnId ? { recoveryTurnId: bootstrap.recoveryTurnId } : {}),
        searchOffset: located.nextOffset,
      };
      if (
        located.nextOffset >= fileSize
        && searchedNewBytes
        && !bootstrap.initialTurnId
        && uuidV7TimestampMs(ownerMeta.threadId) === undefined
        && !bootstrap.recoveryTurnId
      ) {
        this.logger.warn('Codex fork bootstrap has no usable Hook or UUIDv7 ownership evidence', {
          transcriptPath: filePath,
          threadId: ownerMeta.threadId,
          searchedBytes: located.nextOffset,
        });
      }
      return { ready: false, changed: changed() };
    }

    if (located.anchorKind === 'initial-hook' || located.anchorKind === 'uuidv7') {
      checkpoint.firstOwnedTurnId = located.turnId;
    }
    const previousScanOffset = checkpoint.scanOffset;
    if (bootstrap.state === 'baseline-search' && located.startOffset < previousScanOffset) {
      checkpoint.forkBootstrap = {
        state: 'baseline-tail',
        ...(bootstrap.initialTurnId ? { initialTurnId: bootstrap.initialTurnId } : {}),
        ...(bootstrap.recoveryTurnId ? { recoveryTurnId: bootstrap.recoveryTurnId } : {}),
        searchOffset: located.startOffset,
      };
      this.logger.info('located owned history below Codex fork baseline; rebuilding active tail', {
        transcriptPath: filePath,
        turnId: located.turnId,
        anchorKind: located.anchorKind,
        ownedStartOffset: located.startOffset,
        baselineOffset: previousScanOffset,
      });
      const rebuilt = await this.rebuildForkBaselineTail(filePath, checkpoint);
      return { ready: rebuilt, changed: rebuilt || changed() };
    }

    checkpoint.scanOffset = Math.max(previousScanOffset, located.startOffset);
    // Keep live evidence until owned bytes advance. If the inode changes before
    // then, recovery must restart from zero instead of applying a no-replay baseline.
    checkpoint.forkBootstrap = previousScanOffset < located.startOffset
      ? {
          state: 'live-pending',
          ...(bootstrap.initialTurnId ? { initialTurnId: bootstrap.initialTurnId } : {}),
          ...(bootstrap.recoveryTurnId ? { recoveryTurnId: bootstrap.recoveryTurnId } : {}),
          searchOffset: located.startOffset,
        }
      : undefined;
    this.logger.info('anchored fork/subagent rollout at its first owned turn', {
      transcriptPath: filePath,
      turnId: located.turnId,
      anchorKind: located.anchorKind,
      skippedBytes: located.startOffset,
      hookEvent: marker?.hookEvent,
      threadSource: ownerMeta.threadSource,
      forkedFromId: ownerMeta.forkedFromId,
      parentThreadId: ownerMeta.parentThreadId,
    });
    const startHookOnly = previousScanOffset < located.startOffset
      && (marker?.hookEvent === 'user-prompt-submit' || marker?.hookEvent === 'subagent-start');
    return { ready: !startHookOnly, changed: true };
  }

  private async parkForkBaseline(
    filePath: string,
    key: string,
  ): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    const runtime = this.getInputRuntimeAccumulator();
    const scanOffset = await lastCompleteJsonlOffset(filePath, stat.size, runtime);
    const ownerSessionMetaOffset = await this.findOwnerOffset(filePath, stat, scanOffset);
    this.saveCheckpoint(key, {
      inode: stat.ino,
      scanOffset,
      activeTurn: null,
      pendingTerminal: null,
      pendingFusion: null,
      pendingSubagent: null,
      ownerSessionMetaOffset,
      forkBootstrap: {
        state: 'baseline-search',
        searchOffset: 0,
      },
    });
  }

  private async rebuildForkBaselineTail(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
  ): Promise<boolean> {
    const bootstrap = checkpoint.forkBootstrap;
    if (!bootstrap || bootstrap.state !== 'baseline-tail') return true;

    const baselineEnd = checkpoint.scanOffset;
    const searchOffset = boundedSearchOffset(bootstrap.searchOffset, baselineEnd);
    const scanEnd = Math.min(baselineEnd, searchOffset + MAX_SCAN_BYTES_PER_FILE_CYCLE);
    let candidate = bootstrap.tailCandidate
      ? cloneActiveTurn(bootstrap.tailCandidate)
      : null;
    const processLine = (line: JsonLine): void => {
      const payload = asRecord(line.record.payload);
      if (!payload || line.record.type === 'session_meta') return;
      const turnId = turnIdForStart(line.record, payload);
      if (turnId) {
        if (!candidate || candidate.turnId !== turnId) {
          candidate = createActiveTurn(
            turnId,
            line.startOffset,
            timestampMs(line.record, Date.now()),
            true,
          );
        }
        updateActiveTurnMetadata(candidate, line.record, payload);
        return;
      }
      if (terminalTurnIdFor(line.record, payload) === candidate?.turnId) candidate = null;
    };

    const runtime = this.getInputRuntimeAccumulator();
    let scan = await scanJsonLines(filePath, searchOffset, scanEnd, processLine, runtime);
    if (scan.nextOffset === searchOffset && scanEnd < baselineEnd) {
      scan = await scanJsonLines(
        filePath,
        searchOffset,
        baselineEnd,
        line => {
          processLine(line);
          return false;
        },
        runtime,
      );
    }

    if (scan.nextOffset < baselineEnd) {
      checkpoint.forkBootstrap = {
        ...bootstrap,
        searchOffset: scan.nextOffset,
        ...(candidate ? { tailCandidate: candidate } : { tailCandidate: undefined }),
      };
      return false;
    }

    if (candidate) {
      candidate.startOffset = baselineEnd;
      checkpoint.activeTurn = candidate;
    }
    checkpoint.forkBootstrap = undefined;
    return true;
  }

  private async baselineFile(filePath: string, key: string): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    let ownerSessionMetaOffset: number | null = null;
    let activeTurn: CodexActiveTranscriptTurn | null = null;
    const { nextOffset } = await scanJsonLinesThroughQuarantine(filePath, 0, stat.size, line => {
      const payload = asRecord(line.record.payload);
      if (!payload) return;
      if (line.record.type === 'session_meta') {
        ownerSessionMetaOffset = selectOwnerSessionMetaOffset(
          filePath,
          ownerSessionMetaOffset,
          line,
        );
        return;
      }
      const turnId = turnIdForStart(line.record, payload);
      if (turnId && (!activeTurn || activeTurn.turnId !== turnId)) {
        activeTurn = createActiveTurn(turnId, line.startOffset, timestampMs(line.record, Date.now()), true);
      }
      if (turnId && activeTurn?.turnId === turnId) {
        updateActiveTurnMetadata(activeTurn, line.record, payload);
        return;
      }
      const terminalTurnId = terminalTurnIdFor(line.record, payload);
      if (terminalTurnId === activeTurn?.turnId) {
        activeTurn = null;
      }
    }, this.getInputRuntimeAccumulator());
    const baselineActiveTurn = activeTurn as CodexActiveTranscriptTurn | null;
    if (baselineActiveTurn) baselineActiveTurn.startOffset = nextOffset;
    this.saveCheckpoint(key, {
      inode: stat.ino,
      scanOffset: nextOffset,
      activeTurn: baselineActiveTurn,
      pendingTerminal: null,
      pendingFusion: null,
      pendingSubagent: null,
      ownerSessionMetaOffset,
    });
  }

  private async discoverSessionFiles(): Promise<DiscoveredSessionFile[]> {
    const discovered = new Map<string, DiscoveredSessionFile>();
    const canonicalDefaultSessionDir = await canonicalDirectoryPath(this.sessionDir);
    const defaultFiles = await this.listDefaultRolloutFiles();
    for (const filePath of defaultFiles) {
      const canonicalPath = path.join(
        canonicalDefaultSessionDir,
        path.relative(this.sessionDir, filePath),
      );
      // Keep the configured/default path as the checkpoint key for backwards
      // compatibility. Canonicalizing the root once avoids a realpath syscall
      // for every historical rollout on every collection cycle.
      discovered.set(canonicalPath, { filePath, baselineOnStart: true });
    }

    let remainingDynamicFiles = MAX_DYNAMIC_SESSION_FILES;
    for (const sessionDir of await this.discoverDynamicSessionDirs(canonicalDefaultSessionDir)) {
      if (remainingDynamicFiles <= 0) break;
      const files: string[] = [];
      await collectRecentRolloutFiles(
        sessionDir,
        files,
        Date.now() - DYNAMIC_SESSION_FILE_MAX_IDLE_MS,
        remainingDynamicFiles,
        {
          remainingDirectories: MAX_DYNAMIC_DIRECTORIES_PER_ROOT,
          remainingRolloutFiles: MAX_DYNAMIC_ROLLOUT_FILES_PER_ROOT,
        },
      );
      for (const filePath of files) {
        if (discovered.has(filePath)) continue;
        discovered.set(filePath, { filePath, baselineOnStart: false });
        remainingDynamicFiles--;
        if (remainingDynamicFiles <= 0) break;
      }
    }

    return [...discovered.values()].sort((left, right) => left.filePath.localeCompare(right.filePath));
  }

  private async discoverDynamicSessionDirs(canonicalDefaultSessionDir: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.wakeupDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const allMarkerEntries = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'));
    const now = Date.now();
    await this.cleanupExpiredWakeupMarkers(allMarkerEntries, now);
    // Reserve the global budget for evidence-backed roots before legacy fallbacks.
    // Per-marker ordering alone still spends two slots per dual-layout home.
    const tiers: Set<string>[] = [new Set(), new Set(), new Set()];
    for (const entry of selectCodexWakeupMarkers(allMarkerEntries)) {
      const roots = await readCodexWakeupRoots(path.join(this.wakeupDir, entry.name), now);
      roots.forEach((candidates, tier) => {
        for (const candidate of candidates) tiers[tier].add(candidate);
      });
    }
    const sessionDirs = new Set<string>();
    for (const candidates of tiers) {
      for (const candidate of candidates) {
        try {
          const canonical = await fs.realpath(candidate);
          if (canonical === canonicalDefaultSessionDir || !(await fs.stat(canonical)).isDirectory()) continue;
          sessionDirs.add(canonical);
        } catch {
          // A temporarily unavailable root can be retried on the next discovery.
        }
      }
    }
    // At most three roots per marker are examined within the existing marker cap.
    const dropped = sessionDirs.size - MAX_DYNAMIC_SESSION_DIRS;
    if (dropped > 0 && now - this.lastDynamicRootLimitWarningAtMs >= WAKEUP_MARKER_CLEANUP_INTERVAL_MS) {
      this.lastDynamicRootLimitWarningAtMs = now;
      this.logger.warn('Codex dynamic session root limit reached within scanned markers', {
        dropped,
        cap: MAX_DYNAMIC_SESSION_DIRS,
      });
    }
    return [...sessionDirs].slice(0, MAX_DYNAMIC_SESSION_DIRS);
  }

  private async cleanupExpiredWakeupMarkers(entries: Dirent[], now: number): Promise<void> {
    if (now - this.lastWakeupMarkerCleanupAtMs < WAKEUP_MARKER_CLEANUP_INTERVAL_MS) return;
    this.lastWakeupMarkerCleanupAtMs = now;

    const candidates = [...entries]
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_WAKEUP_MARKERS_PER_CLEANUP);
    for (const entry of candidates) {
      const markerPath = path.join(this.wakeupDir, entry.name);
      let expired = false;
      try {
        const marker = asRecord(JSON.parse(await fs.readFile(markerPath, 'utf8')));
        const receivedAt = stringValue(marker?.received_at);
        const receivedAtMs = receivedAt ? Date.parse(receivedAt) : Number.NaN;
        if (Number.isFinite(receivedAtMs)) {
          expired = now - receivedAtMs > WAKEUP_MARKER_DISCOVERY_TTL_MS;
        } else {
          expired = now - (await fs.stat(markerPath)).mtimeMs > WAKEUP_MARKER_DISCOVERY_TTL_MS;
        }
      } catch {
        try {
          expired = now - (await fs.stat(markerPath)).mtimeMs > WAKEUP_MARKER_DISCOVERY_TTL_MS;
        } catch {
          continue;
        }
      }
      if (!expired) continue;
      try {
        await fs.unlink(markerPath);
      } catch {
        // Another process or cleanup cycle may have removed the marker first.
      }
    }
  }

  private async cleanupExpiredSpanContexts(now: number): Promise<void> {
    if (now - this.lastSpanContextCleanupAtMs < SPAN_CONTEXT_CLEANUP_INTERVAL_MS) return;
    this.lastSpanContextCleanupAtMs = now;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.spanContextDir, { withFileTypes: true });
    } catch {
      return;
    }

    const candidates = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_SPAN_CONTEXTS_PER_CLEANUP);
    for (const entry of candidates) {
      const markerPath = path.join(this.spanContextDir, entry.name);
      let expired = false;
      try {
        const marker = asRecord(JSON.parse(await fs.readFile(markerPath, 'utf8')));
        const receivedAt = stringValue(marker?.received_at);
        const receivedAtMs = receivedAt ? Date.parse(receivedAt) : Number.NaN;
        if (Number.isFinite(receivedAtMs)) {
          expired = now - receivedAtMs > SPAN_CONTEXT_TTL_MS;
        } else {
          expired = now - (await fs.stat(markerPath)).mtimeMs > SPAN_CONTEXT_TTL_MS;
        }
      } catch {
        try {
          expired = now - (await fs.stat(markerPath)).mtimeMs > SPAN_CONTEXT_TTL_MS;
        } catch {
          continue;
        }
      }
      if (!expired) continue;
      try {
        await fs.unlink(markerPath);
      } catch {
        // Another process or cleanup cycle may have removed the context first.
      }
    }
  }

  private stateKey(filePath: string): string {
    return `${this.id}:${filePath}`;
  }

  private readCheckpoint(key: string): CodexTranscriptCheckpoint | null {
    const raw = this.stateStore.get(key).extra?.codexTranscript;
    const value = asRecord(raw);
    if (!value || typeof value.inode !== 'number' || !isNonNegativeSafeInteger(value.scanOffset)) return null;
    const activeTurn = parseActiveTranscriptTurn(value.activeTurn);
    let pendingTerminal = parsePendingTerminal(value.pendingTerminal);
    const deferredTerminals: CodexDeferredTerminalTurn[] = [];
    // Apply the same bound to persisted input, retaining the oldest queue
    // positions without walking an arbitrarily large malformed checkpoint.
    if (Array.isArray(value.deferredTerminals)) for (const raw of value.deferredTerminals.slice(0, MAX_DEFERRED_TERMINALS)) {
      const item = asRecord(raw);
      const active = parseActiveTranscriptTurn(item?.activeTurn);
      const pending = parsePendingTerminal(item?.pendingTerminal);
      if (active && pending && active.turnId === pending.turnId
        && pending.terminalEndOffset >= active.startOffset
        && pending.terminalEndOffset <= value.scanOffset) {
        deferredTerminals.push({ activeTurn: active, pendingTerminal: pending });
      }
    }
    const fusion = asRecord(value.pendingFusion);
    const fusionChildren = parsePendingFusionChildren(fusion?.children);
    const pendingFusion: CodexPendingFusionTurn | null = fusion
      && typeof fusion.turnId === 'string'
      && typeof fusion.parentThreadId === 'string'
      && typeof fusion.parentTraceId === 'string'
      && isNonNegativeSafeInteger(fusion.terminalEndOffset)
      && fusion.terminalEndOffset <= value.scanOffset
      && (!activeTurn || (fusion.turnId === activeTurn.turnId
        && fusion.terminalEndOffset >= activeTurn.startOffset))
      && fusionChildren.length > 0
      ? {
          turnId: fusion.turnId,
          parentThreadId: fusion.parentThreadId,
          parentTraceId: fusion.parentTraceId,
          terminalEndOffset: fusion.terminalEndOffset,
          children: fusionChildren,
        }
      : null;
    const subagent = asRecord(value.pendingSubagent);
    const capturedActiveTurn = parseActiveTranscriptTurn(subagent?.activeTurn);
    const confidence = subagent?.confidence;
    const pendingSubagent: CodexPendingSubagentTurn | null = subagent
      && typeof subagent.turnId === 'string'
      && typeof subagent.parentThreadId === 'string'
      && typeof subagent.parentTurnId === 'string'
      && typeof subagent.parentTraceId === 'string'
      && typeof subagent.parentToolCallId === 'string'
      && (confidence === 'explicit_id' || confidence === 'agent_path')
      && isNonNegativeSafeInteger(subagent.terminalEndOffset)
      && subagent.terminalEndOffset <= value.scanOffset
      && capturedActiveTurn
      && capturedActiveTurn.turnId === subagent.turnId
      && subagent.terminalEndOffset >= capturedActiveTurn.startOffset
      ? {
          turnId: subagent.turnId,
          parentThreadId: subagent.parentThreadId,
          parentTurnId: subagent.parentTurnId,
          parentTraceId: subagent.parentTraceId,
          parentToolCallId: subagent.parentToolCallId,
          confidence,
          terminalEndOffset: subagent.terminalEndOffset,
          activeTurn: capturedActiveTurn,
        }
      : null;
    if (
      subagent
      && !pendingSubagent
      && activeTurn
      && typeof subagent.turnId === 'string'
      && isNonNegativeSafeInteger(subagent.terminalEndOffset)
      && activeTurn.turnId === subagent.turnId
    ) {
      // Older pendingSubagent checkpoints blocked the child file and retained
      // the active turn at the top level. They have no reliable spawn identity,
      // so recover them through the normal independent terminal path.
      // Parsing records no attempt; recovery initializes retry metadata only
      // when it actually tries to convert the retained source range.
      pendingTerminal ??= { turnId: subagent.turnId, terminalEndOffset: subagent.terminalEndOffset };
    }
    if (pendingTerminal && (!activeTurn || pendingTerminal.turnId !== activeTurn.turnId
      || pendingTerminal.terminalEndOffset < activeTurn.startOffset
      || pendingTerminal.terminalEndOffset > value.scanOffset)) pendingTerminal = null;
    const bootstrapRecord = asRecord(value.forkBootstrap);
    const bootstrapTailCandidate = parseActiveTranscriptTurn(bootstrapRecord?.tailCandidate);
    const bootstrapState = bootstrapRecord?.state === 'baseline-tail'
      ? 'baseline-tail' as const
      : bootstrapRecord?.state === 'baseline-search'
        ? 'baseline-search' as const
        : bootstrapRecord?.state === 'live-pending'
          ? 'live-pending' as const
          // Migrate the mode/phase representation used by development builds.
          : bootstrapRecord?.phase === 'rebuild-owned-tail'
            ? 'baseline-tail' as const
            : bootstrapRecord?.mode === 'baseline'
              ? 'baseline-search' as const
              : 'live-pending' as const;
    const forkBootstrap: CodexForkBootstrap | null = bootstrapRecord
      && isNonNegativeSafeInteger(bootstrapRecord.searchOffset)
      ? {
          state: bootstrapState,
          searchOffset: bootstrapRecord.searchOffset,
          ...(typeof bootstrapRecord.initialTurnId === 'string'
            ? { initialTurnId: bootstrapRecord.initialTurnId }
            : typeof bootstrapRecord.turnId === 'string'
              // Migrate checkpoints written by the first Hook-anchor version.
              ? { initialTurnId: bootstrapRecord.turnId }
              : {}),
          ...(typeof bootstrapRecord.recoveryTurnId === 'string'
            ? { recoveryTurnId: bootstrapRecord.recoveryTurnId }
            : {}),
          ...(bootstrapState === 'baseline-tail' && bootstrapTailCandidate
            ? { tailCandidate: bootstrapTailCandidate }
            : {}),
        }
      : null;
    return {
      inode: value.inode,
      scanOffset: value.scanOffset,
      activeTurn,
      pendingTerminal,
      ...(deferredTerminals.length ? { deferredTerminals } : {}),
      pendingFusion,
      pendingSubagent,
      // Do not migrate legacy latestSessionMetaOffset. In forked rollouts that
      // value commonly points at copied parent metadata, so processFile will
      // perform one bounded header scan to recover the owning meta safely.
      // A live fork can park scanOffset at zero behind valid owner metadata;
      // scanRolloutFile checks this position against file size before use.
      ownerSessionMetaOffset: isNonNegativeSafeInteger(value.ownerSessionMetaOffset)
        ? value.ownerSessionMetaOffset
        : null,
      ...(forkBootstrap ? { forkBootstrap } : {}),
      ...(typeof value.firstOwnedTurnId === 'string' ? { firstOwnedTurnId: value.firstOwnedTurnId } : {}),
    };
  }

  private saveCheckpoint(key: string, checkpoint: CodexTranscriptCheckpoint): void {
    this.saveDelegationState();
    const current = this.stateStore.get(key);
    this.stateStore.update(key, {
      lastOffset: checkpoint.scanOffset,
      extra: {
        ...(current.extra ?? {}),
        codexTranscript: checkpoint,
      },
    });
  }

  private saveDelegationState(): void {
    const global = this.stateStore.get(this.id);
    const extra = global.extra ?? {};
    const delegations = this.subagentLinker.serialize();
    const invocations = [...this.deliveredInvocations].slice(-MAX_LINK_DESCRIPTORS);
    const pending = [...this.pendingAgentResults.values()];
    const same = (before: unknown, after: unknown[]) => (before === undefined && after.length === 0)
      || (Array.isArray(before) && before.length === after.length
        && after.every((value, index) => before[index] === value));
    const emptyDelegations = delegations.spawns.length === 0 && delegations.children.length === 0
      && delegations.bindings.length === 0 && !delegations.completedWorkResults?.length
      && !delegations.workTerminals?.length;
    if ((extra.codexDelegations === delegations || (extra.codexDelegations === undefined && emptyDelegations))
      && same(extra.codexResultInvocations, invocations)
      && same(extra.codexPendingAgentResults, pending)) return;
    this.stateStore.update(this.id, { extra: { ...extra,
      codexDelegations: delegations,
      codexResultInvocations: invocations,
      codexPendingAgentResults: pending,
    } });
  }

  private retainPendingAgentResult(
    filePath: string, inode: number, source: CodexTranscriptSourceRecord, context: AgentActivityEntry,
  ): void {
    const key = `${filePath}:${source.startOffset}`;
    if (this.pendingAgentResults.has(key)) return;
    this.pendingAgentResults.set(key, { filePath, inode, startOffset: source.startOffset, endOffset: source.endOffset,
      context: codexResultIdentityContext(context) });
    trimOldestMap(this.pendingAgentResults, MAX_LINK_DESCRIPTORS);
  }

  /** Child terminal evidence may arrive after the parent file has been fully consumed. */
  private async retryPendingAgentResults(): Promise<number> {
    if (this.pendingAgentResults.size === 0) return 0;
    const state = this.subagentLinker.serialize();
    if (state === this.lastPendingAgentResultState) return 0;
    this.lastPendingAgentResultState = state;
    let emitted = 0;
    let changed = false;
    let unavailable = false;
    for (const [key, pending] of this.pendingAgentResults) {
      if (!this.workspacePolicy.allows({ 'gen_ai.session.id': pending.context['gen_ai.session.id'],
        cwd: pending.context['agent.codex.cwd'] }, this.agentType)) {
        this.pendingAgentResults.delete(key);
        changed = true;
        continue;
      }
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try { stat = await fs.stat(pending.filePath); } catch { unavailable = true; continue; }
      if (stat.ino !== pending.inode || stat.size < pending.endOffset) { unavailable = true; continue; }
      const records = await readJsonLines(pending.filePath, pending.startOffset, pending.endOffset, this.getInputRuntimeAccumulator());
      if (records.items.length !== 1) { unavailable = true; continue; }
      const session = pending.context['gen_ai.session.id'];
      let unresolved = false;
      const entries = appendCodexAgentResults([], records.items, this.subagentLinker.getDelegationsForParent(session),
        session, this.deliveredInvocations, pending.context, () => { unresolved = true; },
        () => { this.lastPendingAgentResultState = undefined; });
      if (unresolved) continue;
      // Re-enter the ordinary output queue with only the late audit result.
      // Model/tool facts and their already-exported spans are never replayed.
      emitted += this.emitEntryBatches(entries);
      this.pendingAgentResults.delete(key);
      changed = true;
    }
    if (unavailable) this.lastPendingAgentResultState = undefined;
    if (changed) this.saveDelegationState();
    return emitted;
  }

  private discardLegacyGlobalTurnRegistry(): void {
    const current = this.stateStore.get(this.id);
    if (!current.extra || !('codexTranscriptGlobal' in current.extra)) return;
    const { codexTranscriptGlobal: _discarded, ...extra } = current.extra;
    this.stateStore.set(this.id, { ...current, extra });
  }

  private partialTurnOptions(
    activeTurn: CodexActiveTranscriptTurn,
    filePath: string,
    attachmentParentThreadId?: string,
  ): {
    startedAtMs?: number;
    nextStepStartedAtMs?: number;
    lastCumulativeTokenTotal?: number;
    model?: string;
    cwd?: string;
    developerInstructions?: string;
    blobToUri?: BlobToUriFn;
    uploadMode?: MultimodalUploadMode;
  } {
    return {
      startedAtMs: activeTurn.startedAtMs,
      ...(activeTurn.nextStepStartedAtMs !== undefined
        ? { nextStepStartedAtMs: activeTurn.nextStepStartedAtMs }
        : {}),
      ...(activeTurn.lastCumulativeTokenTotal !== undefined
        ? { lastCumulativeTokenTotal: activeTurn.lastCumulativeTokenTotal }
        : {}),
      ...(this.includeMultimodal && this.multimodalProcessor
        ? { blobToUri: this.blobToUri(filePath, activeTurn.cwd, attachmentParentThreadId), uploadMode: this.multimodalUploadMode }
        : {}),
      ...(activeTurn.model ? { model: activeTurn.model } : {}),
      ...(activeTurn.cwd ? { cwd: activeTurn.cwd } : {}),
      ...(activeTurn.developerInstructions
        ? { developerInstructions: activeTurn.developerInstructions }
        : {}),
    };
  }

  /** blob→uri with per-transcript replay cache. */
  private blobToUri(transcriptPath: string, cwd?: string, attachmentParentThreadId?: string): BlobToUriFn {
    return (params) => {
      const meta = this.transcriptMetaByPath.get(transcriptPath);
      if (!this.workspacePolicy.allows({
        // Match the event session identity, including child rollout threads.
        'gen_ai.session.id': meta?.threadId ?? sessionIdFromTranscriptPath(transcriptPath),
        cwd,
      }, this.agentType)) return null;
      // Linked recovery checks the known parent as well as the child
      // session. Check that destination too, before upload or replay-cache reuse.
      if (attachmentParentThreadId && !this.workspacePolicy.allows({
        'gen_ai.session.id': attachmentParentThreadId,
      }, this.agentType)) return null;
      if (!this.multimodalProcessor) return null;
      const cacheKey = params.reuseKey ? `${transcriptPath}\0${params.reuseKey}` : undefined;
      if (cacheKey) {
        const hit = this.multimodalUriCache.get(cacheKey);
        if (hit) return hit;
      }
      const result = this.multimodalProcessor.blobToUri(params);
      if (result && cacheKey) this.multimodalUriCache.set(cacheKey, result);
      return result;
    };
  }
}

interface RolloutStatSnapshot {
  ino: number;
  size: number;
  mtimeMs: number;
}

function rolloutStatSnapshot(stat: {
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number | bigint;
}): RolloutStatSnapshot {
  return {
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
  };
}

function rolloutCaughtUp(
  checkpoint: CodexTranscriptCheckpoint,
  stat: { ino: number; size: number },
): boolean {
  return checkpoint.inode === stat.ino
    && checkpoint.scanOffset >= stat.size
    && checkpoint.ownerSessionMetaOffset !== null
    && checkpoint.activeTurn === null
    && checkpoint.pendingTerminal === null
    && !checkpoint.deferredTerminals?.length
    && checkpoint.pendingFusion === null
    && checkpoint.pendingSubagent === null
    && checkpoint.forkBootstrap === undefined;
}

async function collectRolloutFiles(
  dir: string,
  files: string[],
  dirMtimes?: Map<string, number>,
  onError?: (dir: string, error: unknown) => void,
): Promise<boolean> {
  let entries: Dirent[];
  try {
    // Snapshot before readdir: a producer may publish a rollout (or a dated
    // subdirectory) after readdir took its listing. Recording the later mtime
    // would cache that stale listing indefinitely, missing all new turns.
    // With the earlier mtime, the next poll invalidates and rescans it.
    const mtime = dirMtimes ? (await fs.stat(dir)).mtimeMs : undefined;
    entries = await fs.readdir(dir, { withFileTypes: true });
    if (dirMtimes && mtime !== undefined) dirMtimes.set(dir, mtime);
  } catch (error) {
    onError?.(dir, error);
    return false;
  }
  let complete = true;
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!await collectRolloutFiles(entryPath, files, dirMtimes, onError)) complete = false;
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return complete;
}

async function collectRecentRolloutFiles(
  dir: string,
  files: string[],
  modifiedAfterMs: number,
  maxFiles: number,
  budget: DynamicDirectoryWalkBudget,
  depth = 0,
): Promise<void> {
  if (files.length >= maxFiles || budget.remainingDirectories <= 0) return;
  budget.remainingDirectories--;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => right.name.localeCompare(left.name));
  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isCodexSessionDateDirectory(entry.name, depth)) continue;
      await collectRecentRolloutFiles(entryPath, files, modifiedAfterMs, maxFiles, budget, depth + 1);
      continue;
    }
    if (
      depth !== 3
      || !entry.isFile()
      || !entry.name.startsWith('rollout-')
      || !entry.name.endsWith('.jsonl')
    ) {
      continue;
    }
    if (budget.remainingRolloutFiles <= 0) return;
    budget.remainingRolloutFiles--;
    try {
      if ((await fs.stat(entryPath)).mtimeMs >= modifiedAfterMs) files.push(entryPath);
    } catch {
      // The transcript may disappear while a short-lived task directory is being cleaned up.
    }
  }
}

function isCodexSessionDateDirectory(name: string, depth: number): boolean {
  if (depth === 0) return /^\d{4}$/.test(name);
  if (depth === 1) return /^(0[1-9]|1[0-2])$/.test(name);
  if (depth === 2) return /^(0[1-9]|[12]\d|3[01])$/.test(name);
  return false;
}

/** Shared by activation and collection so stale/invalid markers cannot start an Input. */
async function readCodexWakeupRoots(markerPath: string, now: number): Promise<string[][]> {
  const roots: string[][] = [[], [], []];
  try {
    const marker = asRecord(JSON.parse(await fs.readFile(markerPath, 'utf8')));
    if (!marker) return roots;
    const receivedAt = stringValue(marker.received_at);
    const receivedAtMs = receivedAt ? Date.parse(receivedAt) : Number.NaN;
    if (!Number.isFinite(receivedAtMs) || now - receivedAtMs > WAKEUP_MARKER_DISCOVERY_TTL_MS) return roots;

    const home = stringValue(marker.codex_home);
    const sessionDir = stringValue(marker.session_dir);
    const transcriptPath = stringValue(marker.transcript_path);
    if ((home && !path.isAbsolute(home)) || (sessionDir && !path.isAbsolute(sessionDir))) return roots;
    const legacy = home ? path.resolve(home, 'sessions') : undefined;
    const transcriptRoot = transcriptPath ? sessionDirFromTranscriptPath(transcriptPath) : undefined;
    if (transcriptRoot && (!home || isCodexSessionDirForHome(transcriptRoot, home))) {
      roots[0].push(transcriptRoot);
    }
    if (sessionDir && (!home || isCodexSessionDirForHome(sessionDir, home))) {
      const resolved = path.resolve(sessionDir);
      roots[resolved === legacy ? 2 : 1].push(resolved);
    }
    if (legacy) roots[2].push(legacy);
  } catch {
    // Atomic replacement, invalid JSON, and unreadable markers are retried later.
  }
  return roots;
}

function selectCodexWakeupMarkers(entries: Dirent[]): Dirent[] {
  // UUIDv7 marker names sort newest first; keep every read within the scan budget.
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, MAX_WAKEUP_MARKERS_FOR_DISCOVERY);
}

function sessionDirFromTranscriptPath(transcriptPath: string): string | undefined {
  if (!path.isAbsolute(transcriptPath)) return undefined;
  const fileName = path.basename(transcriptPath);
  if (!fileName.startsWith('rollout-') || !fileName.endsWith('.jsonl')) return undefined;

  const dayDir = path.dirname(transcriptPath);
  const monthDir = path.dirname(dayDir);
  const yearDir = path.dirname(monthDir);
  const sessionDir = path.dirname(yearDir);
  if (
    !isCodexSessionDateDirectory(path.basename(yearDir), 0)
    || !isCodexSessionDateDirectory(path.basename(monthDir), 1)
    || !isCodexSessionDateDirectory(path.basename(dayDir), 2)
    || path.basename(sessionDir) !== 'sessions'
  ) {
    return undefined;
  }
  return path.resolve(sessionDir);
}

function isCodexSessionDirForHome(sessionDir: string, codexHome: string): boolean {
  const relative = path.relative(path.resolve(codexHome), path.resolve(sessionDir));
  if (relative === 'sessions') return true;
  const parts = relative.split(path.sep);
  return parts.length === 3
    && parts[0] === 'u'
    && parts[1].length > 0
    && parts[1] !== '.'
    && parts[1] !== '..'
    && parts[2] === 'sessions';
}

async function canonicalDirectoryPath(directoryPath: string): Promise<string> {
  try {
    return await fs.realpath(directoryPath);
  } catch {
    return path.resolve(directoryPath);
  }
}

async function readJsonLines(
  filePath: string,
  startOffset: number,
  endOffset: number,
  runtime?: InputRuntimeAccumulator | null,
): Promise<{
  items: JsonLine[];
  nextOffset: number;
}> {
  if (endOffset <= startOffset) return { items: [], nextOffset: startOffset };
  const items: JsonLine[] = [];
  const { nextOffset } = await scanJsonLinesThroughQuarantine(filePath, startOffset, endOffset, line => {
    items.push(line);
  }, runtime);
  return { items, nextOffset };
}

async function lastCompleteJsonlOffset(
  filePath: string,
  fileSize: number,
  runtime?: InputRuntimeAccumulator | null,
): Promise<number> {
  if (fileSize <= 0) return 0;
  const handle = await fs.open(filePath, 'r');
  try {
    const lastByte = Buffer.alloc(1);
    const lastByteReadStartedAt = runtime?.now();
    const lastByteRead = await handle.read(lastByte, 0, 1, fileSize - 1);
    if (runtime && lastByteReadStartedAt !== undefined) {
      runtime.observeRead(lastByteRead.bytesRead, 1, runtime.now() - lastByteReadStartedAt);
    }
    if (lastByteRead.bytesRead === 1 && lastByte[0] === 0x0a) {
      return fileSize;
    }
    let position = fileSize;
    while (position > 0) {
      const length = Math.min(READ_CHUNK_SIZE, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      const readStartedAt = runtime?.now();
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (runtime && readStartedAt !== undefined) {
        runtime.observeRead(bytesRead, length, runtime.now() - readStartedAt);
      }
      if (bytesRead <= 0) break;
      const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) return position + newline + 1;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

async function scanJsonLines(
  filePath: string,
  startOffset: number,
  endOffset: number,
  onLine: (line: JsonLine) => void | false | Promise<void | false>,
  runtime?: InputRuntimeAccumulator | null,
): Promise<{
  nextOffset: number;
  records: number;
  parseSuccessRecords: number;
  parseFailedRecords: number;
  maxRecordBytes: number;
  quarantined?: boolean;
  incompleteTail?: IncompleteJsonlTail;
}> {
  if (endOffset <= startOffset) {
    return {
      nextOffset: startOffset,
      records: 0,
      parseSuccessRecords: 0,
      parseFailedRecords: 0,
      maxRecordBytes: 0,
    };
  }
  const handle = await fs.open(filePath, 'r');
  try {
    let nextOffset = startOffset;
    let position = startOffset;
    let pending: Buffer[] = [];
    let pendingStartOffset = startOffset;
    let records = 0;
    let parseSuccessRecords = 0;
    let parseFailedRecords = 0;
    let maxRecordBytes = 0;
    let tailAnchor = '';

    while (position < endOffset) {
      const length = Math.min(READ_CHUNK_SIZE, endOffset - position);
      const chunk = Buffer.alloc(length);
      const readStartedAt = runtime?.now();
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (runtime && readStartedAt !== undefined) {
        runtime.observeRead(bytesRead, length, runtime.now() - readStartedAt);
      }
      if (bytesRead <= 0) break;
      position += bytesRead;
      tailAnchor = chunk.subarray(Math.max(0, bytesRead - 64), bytesRead).toString('hex');

      let cursor = 0;
      const chunkStartOffset = position - bytesRead;
      while (cursor < bytesRead) {
        const newline = chunk.subarray(0, bytesRead).indexOf(0x0a, cursor);
        const partEnd = newline < 0 ? bytesRead : newline;
        const recordBytes = chunkStartOffset + partEnd - pendingStartOffset;
        if (recordBytes <= MAX_JSONL_RECORD_BYTES) {
          pending.push(chunk.subarray(cursor, partEnd));
        } else {
          // Keep only offsets while seeking the newline: never retain, decode,
          // or parse an unbounded record, including a fully persisted one.
          pending = [];
        }
        if (newline < 0) break;
        const lineEndOffset = chunkStartOffset + newline + 1;
        if (recordBytes > MAX_JSONL_RECORD_BYTES) {
          records++;
          parseFailedRecords++;
          maxRecordBytes = Math.max(maxRecordBytes, recordBytes + 1);
          jsonlLogger.warn('Codex JSONL record exceeds size limit; quarantined in source transcript', {
            fileId: crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16),
            startOffset: pendingStartOffset,
            endOffset: lineEndOffset,
            recordBytes,
            maxRecordBytes: MAX_JSONL_RECORD_BYTES,
            reason: 'record-too-large',
          });
          // Let the caller recover the current turn before any later start
          // can replace it. The skipped record might itself be a terminal.
          return {
            nextOffset: lineEndOffset,
            records,
            parseSuccessRecords,
            parseFailedRecords,
            maxRecordBytes,
            quarantined: true,
          };
        } else {
          // Concatenate once per completed line, rather than copying the whole
          // accumulated prefix for every 1 MiB read (quadratic for large lines).
          const data = pending.length === 1 ? pending[0]! : Buffer.concat(pending, recordBytes);
          pending = [];
          // Conversion itself can throw, so it belongs inside the parse guard.
          try {
            const text = data.toString('utf8').trim();
            if (!text) {
              nextOffset = lineEndOffset;
              pendingStartOffset = lineEndOffset;
              cursor = newline + 1;
              continue;
            }
            records++;
            maxRecordBytes = Math.max(maxRecordBytes, recordBytes + 1);
            const record: unknown = JSON.parse(text);
            if (record && typeof record === 'object' && !Array.isArray(record)) {
              parseSuccessRecords++;
              const keepGoing = await onLine({
                startOffset: pendingStartOffset,
                endOffset: lineEndOffset,
                record: record as Record<string, unknown>,
              });
              if (keepGoing === false) {
                nextOffset = lineEndOffset;
                return {
                  nextOffset,
                  records,
                  parseSuccessRecords,
                  parseFailedRecords,
                  maxRecordBytes,
                };
              }
            } else {
              parseFailedRecords++;
            }
          } catch {
            // Invalid completed lines are ignored but their bytes are consumed.
            parseFailedRecords++;
          }
        }
        pending = [];
        nextOffset = lineEndOffset;
        pendingStartOffset = lineEndOffset;
        cursor = newline + 1;
      }
    }

    return {
      nextOffset,
      records,
      parseSuccessRecords,
      parseFailedRecords,
      maxRecordBytes,
      ...(position > pendingStartOffset ? {
        incompleteTail: {
          startOffset: pendingStartOffset,
          endOffset: position,
          anchor: tailAnchor,
        },
      } : {}),
    };
  } finally {
    await handle.close();
  }
}

// Range readers and startup baselining own their entire requested range.
// Resume explicitly at each quarantine boundary; live scanning instead returns
// to its turn-recovery state machine at that point.
async function scanJsonLinesThroughQuarantine(
  filePath: string,
  startOffset: number,
  endOffset: number,
  onLine: Parameters<typeof scanJsonLines>[3],
  runtime?: InputRuntimeAccumulator | null,
): Promise<{ nextOffset: number }> {
  let nextOffset = startOffset;
  while (nextOffset < endOffset) {
    const scan = await scanJsonLines(filePath, nextOffset, endOffset, onLine, runtime);
    if (scan.nextOffset <= nextOffset) break;
    nextOffset = scan.nextOffset;
    if (!scan.quarantined) break;
  }
  return { nextOffset };
}

function sameFileVersion(a: fsSync.Stats, b: fsSync.Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function sourceVersion(stat: fsSync.Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parsePendingTerminal(raw: unknown): CodexPendingTerminalTurn | null {
  const value = asRecord(raw);
  if (!value || typeof value.turnId !== 'string' || !isNonNegativeSafeInteger(value.terminalEndOffset)) return null;
  const failure = asRecord(value.failure);
  const validFailure = failure && typeof failure.sourceVersion === 'string'
    && isNonNegativeSafeInteger(failure.retryAtMs)
    && isNonNegativeSafeInteger(failure.delayMs)
    && failure.delayMs >= RECOVERY_RETRY_MIN_MS && failure.delayMs <= RECOVERY_RETRY_MAX_MS;
  return {
    turnId: value.turnId, terminalEndOffset: value.terminalEndOffset,
    ...(isNonNegativeSafeInteger(value.retryCount) ? { retryCount: value.retryCount } : {}),
    ...(isNonNegativeSafeInteger(value.firstPendingAtMs) ? { firstPendingAtMs: value.firstPendingAtMs } : {}),
    ...(isNonNegativeSafeInteger(value.lastAttemptAtMs) ? { lastAttemptAtMs: value.lastAttemptAtMs } : {}),
    ...(isNonNegativeSafeInteger(value.sourceRecordCount) ? { sourceRecordCount: value.sourceRecordCount } : {}),
    ...(validFailure ? { failure: {
      sourceVersion: failure.sourceVersion as string,
      retryAtMs: failure.retryAtMs as number,
      delayMs: failure.delayMs as number,
    } } : {}),
  };
}

async function findOwnerSessionMetaOffset(
  filePath: string,
  endOffset: number,
  runtime?: InputRuntimeAccumulator | null,
): Promise<{ offset: number | null; completeAbsence: boolean }> {
  let ownerOffset: number | null = null;
  const scan = await scanJsonLines(filePath, 0, endOffset, line => {
    if (line.record.type !== 'session_meta') {
      // Codex writes the owning meta and any copied fork metadata as a header.
      // Only a valid owner closes that header. A malformed session_meta must
      // not turn a partial probe into an uncacheable negative on every poll.
      return ownerOffset !== null ? false : undefined;
    }
    ownerOffset = selectOwnerSessionMetaOffset(filePath, ownerOffset, line);
    return undefined;
  }, runtime);
  return {
    offset: ownerOffset,
    completeAbsence: ownerOffset === null && scan.nextOffset === endOffset
      && !scan.quarantined && !scan.incompleteTail,
  };
}

type ForkAnchorKind = 'initial-hook' | 'uuidv7' | 'terminal-recovery';

/** Locate the first positively-owned turn of a forked rollout in one bounded window. */
async function findTurnStartOffset(
  filePath: string,
  ownerThreadId: string,
  initialTurnId: string | undefined,
  recoveryTurnId: string | undefined,
  startOffset: number,
  fileSize: number,
  runtime?: InputRuntimeAccumulator | null,
): Promise<{
  startOffset: number | null;
  nextOffset: number;
  incompleteTail?: IncompleteJsonlTail;
  turnId?: string;
  anchorKind?: ForkAnchorKind;
}> {
  let turnStartOffset: number | null = null;
  let matchedTurnId: string | undefined;
  let anchorKind: ForkAnchorKind | undefined;
  const safeStart = boundedSearchOffset(startOffset, fileSize);
  const scanEnd = Math.min(fileSize, safeStart + MAX_SCAN_BYTES_PER_FILE_CYCLE);
  const ownerTimestamp = uuidV7TimestampMs(ownerThreadId);
  const processLine = (line: JsonLine): void | false => {
    const payload = asRecord(line.record.payload);
    if (!payload) return undefined;
    const candidateTurnId = turnIdForStart(line.record, payload);
    if (!candidateTurnId) return undefined;

    if (initialTurnId && candidateTurnId === initialTurnId) {
      turnStartOffset = line.startOffset;
      matchedTurnId = candidateTurnId;
      anchorKind = 'initial-hook';
      return false;
    }
    if (initialTurnId) return undefined;

    const candidateTimestamp = uuidV7TimestampMs(candidateTurnId);
    if (
      ownerTimestamp !== undefined
      && candidateTimestamp !== undefined
      && candidateTimestamp >= ownerTimestamp
    ) {
      turnStartOffset = line.startOffset;
      matchedTurnId = candidateTurnId;
      anchorKind = 'uuidv7';
      return false;
    }
    if (recoveryTurnId && candidateTurnId === recoveryTurnId) {
      turnStartOffset = line.startOffset;
      matchedTurnId = candidateTurnId;
      anchorKind = 'terminal-recovery';
      return false;
    }
    return undefined;
  };
  let scan = await scanJsonLines(filePath, safeStart, scanEnd, processLine, runtime);
  // A cycle budget is not a record-size limit. Finish one record when the
  // window contains no complete line, as the baseline-tail scanner does.
  // scanJsonLines retains its normal oversized-record quarantine bound.
  if (scan.nextOffset === safeStart && scanEnd < fileSize) {
    scan = await scanJsonLines(filePath, safeStart, fileSize, line => {
      processLine(line);
      return false;
    }, runtime);
  }
  return {
    startOffset: turnStartOffset,
    nextOffset: scan.nextOffset,
    ...(scan.incompleteTail ? { incompleteTail: scan.incompleteTail } : {}),
    ...(matchedTurnId ? { turnId: matchedTurnId } : {}),
    ...(anchorKind ? { anchorKind } : {}),
  };
}

function boundedSearchOffset(value: number, fileSize: number): number {
  if (!Number.isFinite(value) || value < 0 || value > fileSize) return 0;
  return Math.trunc(value);
}

function selectOwnerSessionMetaOffset(
  filePath: string,
  currentOffset: number | null,
  line: JsonLine,
): number | null {
  const meta = extractCodexTranscriptMeta(line.record);
  if (!meta) return currentOffset;
  const rolloutThreadId = sessionIdFromTranscriptPath(filePath);
  if (meta.threadId === rolloutThreadId) return line.startOffset;
  return currentOffset ?? line.startOffset;
}

async function readJsonLineAt(
  filePath: string,
  offset: number,
  runtime?: InputRuntimeAccumulator | null,
): Promise<Record<string, unknown> | null> {
  const handle = await fs.open(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let position = offset;
    for (let attempt = 0; attempt < 16; attempt++) {
      const buffer = Buffer.alloc(64 * 1024);
      const readStartedAt = runtime?.now();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (runtime && readStartedAt !== undefined) {
        runtime.observeRead(bytesRead, buffer.length, runtime.now() - readStartedAt);
      }
      if (bytesRead === 0) break;
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      chunks.push(buffer.subarray(0, newline >= 0 ? newline : bytesRead));
      if (newline >= 0) {
        try {
          const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
        } catch {
          return null;
        }
      }
      position += bytesRead;
    }
    return null;
  } finally {
    await handle.close();
  }
}

function turnIdForStart(record: Record<string, unknown>, payload: Record<string, unknown>): string | null {
  if (record.type !== 'turn_context' && !(record.type === 'event_msg' && payload.type === 'task_started')) return null;
  return stringValue(payload.turn_id) ?? null;
}

function createActiveTurn(
  turnId: string,
  startOffset: number,
  startedAtMs: number,
  emittedPrompt = false,
): CodexActiveTranscriptTurn {
  return {
    turnId,
    startOffset,
    startedAtMs,
    emittedPrompt,
    emittedStepCount: 0,
    emittedStepRequestIds: [],
    emittedStepResponseIds: [],
    emittedToolCallIds: [],
    emittedToolResultIds: [],
  };
}

function updateActiveTurnMetadata(
  activeTurn: CodexActiveTranscriptTurn,
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): void {
  if (record.type !== 'turn_context') return;
  const model = stringValue(payload.model);
  const cwd = stringValue(payload.cwd);
  const developerInstructions = stringValue(payload.developer_instructions);
  if (model) activeTurn.model = model;
  if (cwd) activeTurn.cwd = cwd;
  if (developerInstructions) activeTurn.developerInstructions = developerInstructions;
}


function updateActiveTurnFromExtractedTurn(
  activeTurn: CodexActiveTranscriptTurn,
  turn: { model: string; cwd?: string; developerInstructions?: string },
): void {
  if (turn.model && turn.model !== 'unknown') activeTurn.model = turn.model;
  if (turn.cwd) activeTurn.cwd = turn.cwd;
  if (turn.developerInstructions) activeTurn.developerInstructions = turn.developerInstructions;
}

function terminalTurnIdFor(record: Record<string, unknown>, payload: Record<string, unknown>): string | null {
  if (record.type !== 'event_msg' || (payload.type !== 'task_complete' && payload.type !== 'turn_aborted')) return null;
  return stringValue(payload.turn_id) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseActiveTranscriptTurn(value: unknown): CodexActiveTranscriptTurn | null {
  const active = asRecord(value);
  if (
    !active
    || typeof active.turnId !== 'string'
    || !isNonNegativeSafeInteger(active.startOffset)
    || !isNonNegativeSafeInteger(active.startedAtMs)
  ) return null;
  const model = stringValue(active.model);
  const cwd = stringValue(active.cwd);
  const developerInstructions = stringValue(active.developerInstructions);
  return {
    turnId: active.turnId,
    startOffset: active.startOffset,
    startedAtMs: active.startedAtMs,
    ...(isNonNegativeSafeInteger(active.nextStepStartedAtMs)
      ? { nextStepStartedAtMs: active.nextStepStartedAtMs }
      : {}),
    ...(typeof active.lastCumulativeTokenTotal === 'number'
      ? { lastCumulativeTokenTotal: active.lastCumulativeTokenTotal }
      : {}),
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    emittedPrompt: active.emittedPrompt === true,
    emittedStepCount: typeof active.emittedStepCount === 'number' ? active.emittedStepCount : 0,
    emittedStepRequestIds: stringArray(active.emittedStepRequestIds),
    emittedStepResponseIds: stringArray(active.emittedStepResponseIds),
    emittedToolCallIds: stringArray(active.emittedToolCallIds),
    emittedToolResultIds: stringArray(active.emittedToolResultIds),
    inputContext: parseInputContext(active.inputContext),
    ...(asRecord(active.delegation) ? { delegation: active.delegation as CodexSubagentLink } : {}),
    ...(active.delegationUnbound === true ? { delegationUnbound: true } : {}),
    ...(typeof active.emittedTraceId === 'string' ? { emittedTraceId: active.emittedTraceId } : {}),
    emittedAuditEventIds: stringArray(active.emittedAuditEventIds),
    subagentSpawns: parsePendingFusionChildren(active.subagentSpawns),
  };
}

function parsePendingFusionChildren(value: unknown): CodexPendingFusionChild[] {
  if (!Array.isArray(value)) return [];
  const children: CodexPendingFusionChild[] = [];
  for (const item of value) {
    const child = asRecord(item);
    if (
      !child
      || typeof child.parentToolCallId !== 'string'
      || typeof child.parentTraceId !== 'string'
      || !isNonNegativeSafeInteger(child.spawnedAtMs)
    ) continue;
    children.push({
      parentToolCallId: child.parentToolCallId,
      parentTraceId: child.parentTraceId,
      spawnedAtMs: child.spawnedAtMs,
      ...(typeof child.taskName === 'string' ? { taskName: child.taskName } : {}),
      ...(typeof child.agentPath === 'string' ? { agentPath: child.agentPath } : {}),
      ...(typeof child.childThreadId === 'string' ? { childThreadId: child.childThreadId } : {}),
    });
  }
  return children;
}

function hasCopiedHistoryPrefix(
  meta: CodexTranscriptMeta | null | undefined,
): boolean {
  return meta != null && (
    meta.forkedFromId != null
    || meta.parentThreadId != null
    || meta.threadSource === 'subagent'
  );
}

function shouldSkipCopiedParentTurn(
  turnId: string,
  observedStartedAtMs: number,
  ownerCreatedAtMs: number | undefined,
): boolean {
  if (ownerCreatedAtMs === undefined) return false;
  return isCopiedParentTurnByTime(turnId, observedStartedAtMs, ownerCreatedAtMs);
}

function isCopiedParentTurnByTime(
  turnId: string,
  observedStartedAtMs: number,
  ownerCreatedAtMs: number,
): boolean {
  const uuidTimestamp = uuidV7TimestampMs(turnId);
  return (uuidTimestamp ?? observedStartedAtMs) < ownerCreatedAtMs;
}

function reusableCachedTranscriptMeta(
  cached: CachedCodexTranscriptMeta,
  inode: number,
  fileSize: number,
  ownerSessionMetaOffset: number,
): boolean {
  return cached.inode === inode
    && cached.ownerSessionMetaOffset === ownerSessionMetaOffset
    && fileSize >= cached.fileSize
    && ownerSessionMetaOffset >= 0
    && ownerSessionMetaOffset < fileSize;
}

function estimateCachedTranscriptMetaBytes(filePath: string, meta: CodexTranscriptMeta): number {
  return Buffer.byteLength(filePath, 'utf8')
    + Buffer.byteLength(JSON.stringify(meta), 'utf8');
}

function trimOldestMap<T>(values: Map<string, T>, maxSize: number): void {
  while (values.size > maxSize) {
    const oldest = values.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    values.delete(oldest);
  }
}

function uuidV7TimestampMs(value: string): number | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return undefined;
  }
  const timestamp = Number.parseInt(value.replace(/-/g, '').slice(0, 12), 16);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

function cloneActiveTurn(activeTurn: CodexActiveTranscriptTurn): CodexActiveTranscriptTurn {
  return structuredClone(activeTurn);
}

function codexTurnEndMarker(
  entries: AgentActivityEntry[],
  turn: Pick<CodexExtractedTranscriptTurn, 'sessionId' | 'transcriptTurnId' | 'terminalAtMs' | 'status'>,
): AgentActivityEntry {
  const source = [...entries].reverse().find(entry => entry['event.name'] === 'llm.response')
    ?? entries.at(-1);
  if (!source) throw new Error('cannot build Codex turn-end marker without a source entry');
  return {
    time_unix_nano: String(BigInt(Math.trunc(turn.terminalAtMs)) * 1_000_000n),
    ...(source.observed_time_unix_nano
      ? { observed_time_unix_nano: source.observed_time_unix_nano }
      : {}),
    'event.id': crypto.createHash('sha256').update([turn.sessionId, turn.transcriptTurnId, 'turn-end'].join('\0')).digest('hex').slice(0, 32),
    'event.name': 'other',
    'user.id': source['user.id'],
    ...(source.trace_id ? { trace_id: source.trace_id } : {}),
    span_id: crypto.createHash('sha256').update([turn.sessionId, turn.transcriptTurnId, 'agent'].join('\0')).digest('hex').slice(0, 16),
    parent_span_id: stringValue(source['agent.codex.parent_span_id']) ?? '0000000000000001',
    'gen_ai.session.id': source['gen_ai.session.id'],
    ...(source['gen_ai.turn.id'] ? { 'gen_ai.turn.id': source['gen_ai.turn.id'] } : {}),
    'gen_ai.turn.end': true,
    'gen_ai.agent.type': source['gen_ai.agent.type'],
    ...(source['gen_ai.agent.id'] ? { 'gen_ai.agent.id': source['gen_ai.agent.id'] } : {}),
    ...(source['gen_ai.agent.name'] ? { 'gen_ai.agent.name': source['gen_ai.agent.name'] } : {}),
    'gen_ai.provider.name': source['gen_ai.provider.name'],
    ...(source['agent.codex.transcript_turn_id']
      ? { 'agent.codex.transcript_turn_id': source['agent.codex.transcript_turn_id'] }
      : {}),
    ...(source['agent.codex.cwd']
      ? { 'agent.codex.cwd': source['agent.codex.cwd'] }
      : {}),
    'agent.codex.turn_status': turn.status,
    ...Object.fromEntries(Object.entries(source).filter(([key]) => [
      'gen_ai.agent.parent.invocation.id', 'gen_ai.agent.parent.id', 'gen_ai.agent.scope',
      'gen_ai.agent.depth', 'gen_ai.subagent.parent_tool_call.id',
      'agent.codex.delegated', 'agent.codex.parent_span_id',
    ].includes(key))),
  };
}

function serializedEntryBytes(entry: AgentActivityEntry): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8');
  } catch {
    return MAX_EMIT_BATCH_BYTES;
  }
}

function newPendingTerminal(
  turnId: string,
  terminalEndOffset: number,
  sourceRecordCount: number,
  now = Date.now(),
): CodexPendingTerminalTurn {
  return {
    turnId,
    terminalEndOffset,
    retryCount: 1,
    firstPendingAtMs: now,
    lastAttemptAtMs: now,
    sourceRecordCount,
  };
}

function emptySegmentRecoveryDiagnostics(
  sourceRecordCount = 0,
  previouslyEmittedStepCount = 0,
): SegmentRecoveryDiagnostics {
  return {
    sourceRecordCount,
    stepCount: 0,
    toolCount: 0,
    tokenUsageCount: 0,
    unmatchedTokenUsageCount: 0,
    builtEntryCount: 0,
    readyEntryCount: 0,
    deduplicatedEntryCount: 0,
    emittedEntryCount: 0,
    previouslyEmittedStepCount,
  };
}

function attachWakeupResourceAttributes(
  entries: AgentActivityEntry[],
  resourceAttributes: Record<string, JsonValue>,
): AgentActivityEntry[] {
  const workerName = resourceAttributes['agentteams.worker.name'];
  for (const entry of entries) {
    entry.resourceAttributes = resourceAttributes;
    if (typeof workerName === 'string' && workerName.trim()) {
      entry['gen_ai.agent.name'] = workerName.trim();
    }
  }
  return entries;
}

function attachTurnSpanAttributes(
  entries: AgentActivityEntry[],
  spanAttributes: Record<string, string>,
): AgentActivityEntry[] {
  for (const entry of entries) {
    for (const [key, value] of Object.entries(spanAttributes)) {
      if (entry[key] === undefined) entry[key] = value;
    }
  }
  return entries;
}

function persistedInputContext(
  context: CodexTranscriptInputContext,
  sourceRange: CodexTranscriptSourceRange | undefined,
): CodexTranscriptInputContext {
  const delta = context.delta ?? [];
  const deltaBytes = Buffer.byteLength(JSON.stringify(delta), 'utf8');
  return {
    hash: context.hash,
    ...(context.fullMessages ? { fullMessages: context.fullMessages } : {}),
    ...(deltaBytes <= MAX_PERSISTED_INPUT_CONTEXT_BYTES || !sourceRange
      ? { delta }
      : { deltaRange: sourceRange }),
  };
}

function parseInputContext(value: unknown): CodexTranscriptInputContext | undefined {
  const context = asRecord(value);
  if (!context || typeof context.hash !== 'string') return undefined;
  const range = asRecord(context.deltaRange);
  return {
    hash: context.hash,
    ...(Array.isArray(context.delta) ? { delta: context.delta as JsonValue[] } : {}),
    ...(Array.isArray(context.fullMessages) ? { fullMessages: context.fullMessages as JsonValue[] } : {}),
    ...(range && typeof range.startOffset === 'number' && typeof range.endOffset === 'number'
      ? { deltaRange: { startOffset: range.startOffset, endOffset: range.endOffset } }
      : {}),
  };
}

function safeWakeupSessionPart(value: string): string {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function spanContextMarkerName(sessionId: string, turnId: string): string {
  return `${safeWakeupSessionPart(sessionId)}--${safeWakeupSessionPart(turnId)}.json`;
}

function defaultWakeupDir(): string {
  const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
  return path.join(dataDir, 'state', 'codex', 'transcript-wakeups');
}

function defaultSpanContextDir(): string {
  const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
  return path.join(dataDir, 'state', 'codex', 'transcript-span-contexts');
}

function stampCodexDelegation(
  entries: AgentActivityEntry[],
  link: CodexSubagentLink,
  meta: CodexTranscriptMeta | null,
  attachTrace: boolean,
): AgentActivityEntry[] {
  return entries.map(entry => ({
    ...entry,
    ...(link.invocationId ? { 'gen_ai.agent.parent.invocation.id': link.invocationId } : {}),
    'gen_ai.agent.parent.id': link.parentThreadId,
    ...(meta?.agentNickname ? { 'gen_ai.agent.name': meta.agentNickname } : {}),
    ...(link.parentToolCallId ? { 'gen_ai.subagent.parent_tool_call.id': link.parentToolCallId } : {}),
    ...(attachTrace && link.parentToolSpanId ? {
      'gen_ai.agent.scope': 'subagent' as const,
      'gen_ai.agent.depth': meta?.depth ?? 1,
      'agent.codex.delegated': true,
      'agent.codex.parent_span_id': link.parentToolSpanId,
    } : {}),
  }));
}

function appendCodexInvocations(
  entries: AgentActivityEntry[],
  spawns: CodexSpawnDescriptor[],
): AgentActivityEntry[] {
  const byCall = new Map<string, CodexSpawnDescriptor[]>();
  for (const spawn of spawns) {
    const list = byCall.get(spawn.parentToolCallId) ?? [];
    list.push(spawn);
    byCall.set(spawn.parentToolCallId, list);
  }
  const output: AgentActivityEntry[] = [];
  for (const original of entries) {
    const callId = stringValue(original['gen_ai.tool.call.id']);
    const works = callId ? byCall.get(callId) : undefined;
    const entry = works?.length === 1 && works[0]!.invocationId
      ? { ...original, 'gen_ai.agent.invocation.id': works[0]!.invocationId }
      : original;
    output.push(entry);
    if (entry['event.name'] !== 'tool.call' || !works) continue;
    const args = asRecord(entry['gen_ai.tool.call.arguments']);
    const tasks = Array.isArray(args?.agents) ? args.agents
      : Array.isArray(args?.tasks) ? args.tasks : undefined;
    for (const work of works) {
      if (!work.invocationId) continue;
      // Preserve batch positions; never substitute the batch envelope or a
      // sibling's task when this work has no readable input.
      const task = tasks ? asRecord(tasks[work.workIndex ?? 0]) : args;
      const message = [task?.message, task?.prompt, task?.input]
        .map(content => transcriptInputMessage('user', content)).find(value => value !== null);
      const invoke: AgentActivityEntry = {
        ...entry,
        'event.name': 'gen_ai.agent.invoke',
        'event.id': crypto.createHash('sha256').update(`${work.invocationId}\0invoke`).digest('hex').slice(0, 32),
        'gen_ai.agent.invocation.id': work.invocationId,
        ...(work.childThreadId ? { 'gen_ai.agent.peer.id': work.childThreadId } : {}),
        ...(work.agentNickname ? { 'gen_ai.agent.peer.name': work.agentNickname } : {}),
        ...(message ? { 'gen_ai.input.messages': [message] } : {}),
      };
      delete invoke['gen_ai.tool.call.arguments'];
      delete invoke['gen_ai.tool.call.result'];
      delete invoke['tool.result.status'];
      output.push(invoke);
    }
  }
  return output;
}

/** Results require observed delivery; accepted spawn acknowledgements are not results. */
function appendCodexAgentResults(
  entries: AgentActivityEntry[],
  records: CodexTranscriptSourceRecord[],
  descriptors: CodexSpawnDescriptor[],
  receivingSession: string,
  delivered: Set<string>,
  fallbackBase: AgentActivityEntry,
  retainPending?: (source: CodexTranscriptSourceRecord, context: AgentActivityEntry) => void,
  onDelivered?: () => void,
): AgentActivityEntry[] {
  const output = [...entries];
  const base = entries.find(entry => entry['event.name'] === 'llm.request') ?? entries[0] ?? fallbackBase;
  const pending = descriptors.filter(work => work.parentThreadId === receivingSession);
  const append = (source: AgentActivityEntry, key: string, peer: string | undefined, value: unknown, callId?: string, childTurnId?: string, invocationId?: string, terminal = true): 'emitted' | 'duplicate' | 'unresolved' => {
    const peerIds = new Set(pending.filter(work => peer && (work.agentPath === peer || work.taskName === peer))
      .map(work => work.childThreadId).filter((id): id is string => typeof id === 'string'));
    const candidates = pending.filter(work => (!invocationId || work.invocationId === invocationId)
      && BigInt(Math.trunc(work.spawnedAtMs)) * 1_000_000n <= BigInt(source.time_unix_nano)
      && (!callId || work.parentToolCallId === callId)
      && (!peer || work.childThreadId === peer || work.agentPath === peer || work.taskName === peer
        || !!work.childThreadId && peerIds.has(work.childThreadId))
      && (!childTurnId || work.childTurnId === childTurnId || work.resultChildTurnIds?.includes(childTurnId)));
    const fingerprint = codexDeliveredResultFingerprint(value);
    const proven = candidates.filter(work => work.resultFingerprints?.includes(fingerprint));
    // A known matching completion cannot exclude another dispatched work
    // whose terminal or completion body has not arrived yet; it might return identical text.
    const allOutcomesKnown = candidates.every(work => work.resultOutcomeKnown === true);
    if (candidates.length > 1 && allOutcomesKnown && proven.length > 0
      && proven.every(work => !!work.invocationId && delivered.has(work.invocationId))) return 'duplicate';
    const work = candidates.length === 1 ? candidates[0]
      : proven.length === 1 && allOutcomesKnown ? proven[0] : undefined;
    if (!work?.invocationId || proven.length > 1) return 'unresolved';
    if (delivered.has(work.invocationId)) return 'duplicate';
    const result: AgentActivityEntry = {
      ...source,
      'event.name': 'gen_ai.agent.result',
      'event.id': crypto.createHash('sha256').update(`${receivingSession}\0${key}\0${work.invocationId}`).digest('hex').slice(0, 32),
      'gen_ai.agent.invocation.id': work.invocationId,
      ...(work.childThreadId ? { 'gen_ai.agent.peer.id': work.childThreadId } : {}),
      ...(work.agentNickname ? { 'gen_ai.agent.peer.name': work.agentNickname } : {}),
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: typeof value === 'string' ? value : JSON.stringify(value) }] }],
    };
    delete result['gen_ai.input.messages'];
    delete result['gen_ai.input.messages_delta'];
    delete result['gen_ai.tool.call.arguments'];
    delete result['gen_ai.tool.call.result'];
    delete result['tool.result.status'];
    for (const name of Object.keys(result)) if (name.startsWith('gen_ai.usage.')) delete result[name];
    output.push(result);
    if (terminal) { delivered.add(work.invocationId!); onDelivered?.(); }
    while (delivered.size > MAX_LINK_DESCRIPTORS) delivered.delete(delivered.values().next().value!);
    return 'emitted';
  };
  for (const entry of entries) {
    if (entry['event.name'] !== 'tool.result') continue;
    const name = stringValue(entry['gen_ai.tool.name'])?.replace(/^.*[./]/, '');
    const result = asRecord(entry['gen_ai.tool.call.result']);
    const callId = stringValue(entry['gen_ai.tool.call.id']);
    const dispatch = pending.filter(work => work.parentToolCallId === callId);
    const failedResult = result?.error || result?.success === false || ['failed', 'rejected'].includes(stringValue(result?.status) ?? '');
    for (const work of dispatch) {
      if (work.dispatchFailed || failedResult) append({ ...entry, 'error.type': 'codex.delegation_failed' },
        `${entry['event.id']}:dispatch-failed:${work.workIndex ?? 0}`, work.childThreadId,
        entry['gen_ai.tool.call.result'], callId, undefined, work.invocationId);
    }
    if (!name || !['wait', 'wait_agent', 'wait_threads'].includes(name) || !result) continue;
    const status = asRecord(result.status);
    if (status) for (const [peer, state] of Object.entries(status)) {
      const completed = asRecord(state);
      if (completed && ('completed' in completed || 'errored' in completed || 'failed' in completed)) {
        const value = completed.completed ?? completed.errored ?? completed.failed;
        if (value !== undefined && value !== null) append(entry, `${entry['event.id']}:${peer}`, peer, value);
      }
    }
    if (Array.isArray(result.results)) for (const item of result.results) {
      const receipt = asRecord(item);
      if (receipt && ['completed', 'failed', 'errored'].includes(stringValue(receipt.status) ?? '')) {
        const value = receipt.output ?? receipt.result ?? receipt.error;
        if (value !== undefined && value !== null) append(entry,
          `${entry['event.id']}:${stringValue(receipt.agent_id) ?? ''}`, stringValue(receipt.agent_id), value,
          undefined, stringValue(receipt.turn_id));
      }
    }
  }
  for (const source of records) {
    const payload = asRecord(source.record.payload);
    if (!payload) continue;
    if (source.record.type === 'response_item' && payload.type === 'agent_message') {
      const parts = Array.isArray(payload.content) ? payload.content : [];
      const text = parts.map(part => stringValue(asRecord(part)?.text) ?? '').join('\n');
      if (/Message Type:\s*FINAL_ANSWER/.test(text)) {
        const receipt = { ...base };
        delete receipt.span_id;
        delete receipt.parent_span_id;
        delete receipt['gen_ai.step.id'];
        delete receipt['gen_ai.response.id'];
        receipt.time_unix_nano = String(BigInt(Math.trunc(timestampMs(source.record, 0))) * 1_000_000n);
        const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
        const result = append(receipt, `message:${source.startOffset}`, stringValue(payload.author) ?? stringValue(payload.agent_id), text,
          stringValue(metadata?.tool_call_id), stringValue(metadata?.source_turn_id), stringValue(metadata?.invocation_id));
        if (result === 'unresolved') retainPending?.(source, receipt);
      }
      continue;
    }
    if (source.record.type !== 'event_msg' || payload.type !== 'sub_agent_activity') continue;
    if (!['completed', 'result', 'failed'].includes(stringValue(payload.kind) ?? '')) continue;
    const value = payload.result ?? payload.output ?? payload.message ?? payload.error;
    if (value === undefined) continue;
    const receipt = { ...base };
    delete receipt.span_id;
    delete receipt.parent_span_id;
    delete receipt['gen_ai.step.id'];
    delete receipt['gen_ai.response.id'];
    receipt.time_unix_nano = String(BigInt(Math.trunc(timestampMs(source.record, 0))) * 1_000_000n);
    append(receipt, `activity:${source.startOffset}`, stringValue(payload.agent_thread_id) ?? stringValue(payload.agent_id), value,
      stringValue(payload.event_id) ?? stringValue(payload.call_id), stringValue(payload.agent_turn_id), stringValue(payload.invocation_id), payload.kind !== 'result');
  }
  return output;
}

function codexAuditContext(turn: CodexExtractedTranscriptTurn, traceId?: string): AgentActivityEntry {
  return {
    time_unix_nano: String(BigInt(Math.trunc(turn.terminalAtMs)) * 1_000_000n),
    'event.id': `${turn.sessionId}:${turn.transcriptTurnId}:boundary`,
    'event.name': 'other',
    'user.id': '',
    'gen_ai.session.id': turn.sessionId,
    'gen_ai.turn.id': `${turn.sessionId}:${turn.transcriptTurnId}`,
    'gen_ai.agent.type': 'codex',
    'gen_ai.agent.id': turn.sessionId,
    'gen_ai.provider.name': turn.provider,
    'agent.codex.transcript_turn_id': turn.transcriptTurnId,
    ...(traceId ? { trace_id: traceId } : {}),
    ...(turn.cwd ? { 'agent.codex.cwd': turn.cwd } : {}),
  };
}

/** Dispatch intent is observable before an LLM/tool wave can be committed. */
function withPendingCodexDispatches(
  turn: CodexExtractedTranscriptTurn,
  records: CodexTranscriptSourceRecord[],
): CodexExtractedTranscriptTurn {
  const known = new Set(turn.steps.flatMap(step => step.tools.map(tool => tool.callId)));
  const pending = new Map<string, CodexTranscriptTool>();
  const value = (raw: unknown): JsonValue | undefined => {
    if (typeof raw === 'string') { try { return JSON.parse(raw) as JsonValue; } catch { return raw; } }
    return raw === undefined ? undefined : raw as JsonValue;
  };
  for (const source of records) {
    if (source.record.type !== 'response_item') continue;
    const payload = asRecord(source.record.payload);
    const callId = stringValue(payload?.call_id);
    if (!payload || !callId || known.has(callId)) continue;
    if (payload.type === 'function_call') {
      const name = stringValue(payload.name);
      if (name && ['spawn_agent', 'followup_task', 'send_input'].includes(name.replace(/^.*[./]/, ''))) {
        pending.set(callId, { callId, name, input: value(payload.arguments), startedAtMs: timestampMs(source.record, turn.startedAtMs) });
      }
    } else if (payload.type === 'function_call_output') {
      const tool = pending.get(callId);
      if (tool) { tool.output = value(payload.output); tool.completedAtMs = timestampMs(source.record, turn.terminalAtMs); }
    }
  }
  if (pending.size === 0) return turn;
  return { ...turn, steps: [...turn.steps, {
    startedAtMs: Math.min(...[...pending.values()].map(tool => tool.startedAtMs)),
    responseAtMs: turn.terminalAtMs,
    hasResponseEvidence: false,
    completedAtMs: turn.terminalAtMs,
    reasoning: [], tools: [...pending.values()],
  }] };
}

/** Ordinary model/tool segments do not need a delegation-result lookup. */
function hasCodexResultDelivery(
  entries: AgentActivityEntry[], records: CodexTranscriptSourceRecord[], spawns: CodexSpawnDescriptor[],
): boolean {
  if (spawns.some(work => work.dispatchFailed)) return true;
  if (entries.some(entry => entry['event.name'] === 'tool.result'
    && ['wait', 'wait_agent', 'wait_threads', 'spawn_agent', 'followup_task', 'send_input'].includes(stringValue(entry['gen_ai.tool.name'])?.replace(/^.*[./]/, '') ?? ''))) return true;
  return records.some(source => {
    const payload = asRecord(source.record.payload);
    if (source.record.type === 'event_msg' && payload?.type === 'sub_agent_activity') {
      return ['completed', 'result', 'failed'].includes(stringValue(payload.kind) ?? '');
    }
    return source.record.type === 'response_item' && payload?.type === 'agent_message'
      && Array.isArray(payload.content) && payload.content.some(part => /Message Type:\s*FINAL_ANSWER/.test(stringValue(asRecord(part)?.text) ?? ''));
  });
}

function codexDeliveredResultFingerprint(value: unknown): string {
  let text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  if (/Message Type:\s*FINAL_ANSWER/.test(text)) {
    const separator = /\r?\nPayload:[ \t]*\r?\n?/.exec(text);
    if (separator) text = text.slice(separator.index + separator[0].length);
  }
  return crypto.createHash('sha256').update(text).digest('hex');
}

function codexResultIdentityContext(source: AgentActivityEntry): AgentActivityEntry {
  const keys = [
    'time_unix_nano', 'observed_time_unix_nano', 'event.id', 'event.name', 'user.id', 'trace_id',
    'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.agent.id', 'gen_ai.agent.type', 'gen_ai.agent.name',
    'gen_ai.agent.parent.id', 'gen_ai.agent.parent.invocation.id', 'gen_ai.agent.scope', 'gen_ai.agent.depth',
    'gen_ai.provider.name', 'gen_ai.subagent.parent_tool_call.id', 'resourceAttributes',
    'agent.codex.cwd', 'agent.codex.transcript_turn_id', 'agent.codex.delegated', 'agent.codex.parent_span_id',
  ];
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]])) as AgentActivityEntry;
}
