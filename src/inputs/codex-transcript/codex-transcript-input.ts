import * as fsSync from 'node:fs';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent, FSWatcher } from 'node:fs';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue, MultimodalUploadMode } from '../../types/index.js';
import { isReservedKey } from '../../normalization/global-attributes.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';
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
  type CodexTranscriptInputContext,
  type CodexTranscriptCheckpoint,
  type CodexTranscriptMeta,
  type CodexTranscriptSourceRange,
  type CodexExtractedTranscriptTurn,
  type CodexTranscriptTool,
  type CodexTranscriptSourceRecord,
  type CodexTranscriptSourceRef,
} from './codex-transcript-types.js';
import { stringValue, timestampMs } from './codex-transcript-utils.js';
import { CodexTranscriptContinuation } from './codex-transcript-continuation.js';
import { DEFAULT_POLL_INTERVAL_MS } from '../../utils/poll-interval.js';
import { CodexTranscriptOwnerProbe, codexOwnerSummary, parseCodexOwnerProbeState } from './codex-transcript-owner-probe.js';
import { CodexWorkBudget, CodexWorkScheduler, type CodexFileWorkSlice, type CodexWorkStepResult } from './codex-transcript-work-scheduler.js';
import { CodexGuardedJsonlReadTask, CodexJsonlReadTask, CodexRecordRangeReadTask, codexSourceSnapshot,
  parseCodexJsonlProbeState, parseCodexRecordReadState, parseCodexSourceRef } from './codex-transcript-reader.js';
import type { CodexJsonLine } from './codex-transcript-reader.js';
import type { CodexTranscriptSourceSnapshot } from './codex-transcript-types.js';

const DEFAULT_SESSION_DIR = '~/.codex/sessions';
const MAX_EMIT_BATCH_ENTRIES = 256;
const MAX_EMIT_BATCH_BYTES = 1024 * 1024;
const MAX_PERSISTED_INPUT_CONTEXT_BYTES = 1024 * 1024;
const MAX_TERMINALS_PER_FILE_CYCLE = 100;
const MAX_SCAN_BYTES_PER_FILE_CYCLE = 16 * 1024 * 1024;
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
  sourceRef?: CodexTranscriptSourceRef;
}

class CodexReadPostponed extends Error {
  constructor(readonly status: 'deferred' | 'waiting' | 'source-conflict') {
    super(`Codex source read postponed: ${status}`);
  }
}

interface ForkLocation {
  startOffset: number | null;
  nextOffset: number;
  turnId?: string;
  anchorKind?: 'initial-hook' | 'uuidv7' | 'terminal-recovery';
  status: CodexWorkStepResult['status'];
}

interface ForkReadWork {
  criteria: string;
  reader: CodexGuardedJsonlReadTask;
  located?: ForkLocation;
}

interface JsonLine {
  startOffset: number;
  endOffset: number;
  record: Record<string, unknown>;
  sha256?: string;
  headAnchor?: CodexJsonLine['headAnchor'];
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
  sourceRef?: CodexTranscriptSourceRef;
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
  changed?: boolean;
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
  private wakeupWatcher: FSWatcher | null = null;
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
  private startupRuntime: InputRuntimeAccumulator | null = null;
  private readonly ownerProbes = new Map<string, CodexTranscriptOwnerProbe>();
  private readonly ownerSnapshots = new Map<string, CodexTranscriptSourceSnapshot>();
  private readonly ownerScheduler = new CodexWorkScheduler();
  private readonly ownerBlockedPaths = new Set<string>();
  private cycleWorkBudget: CodexWorkBudget | null = null;
  private readonly forkScheduler = new CodexWorkScheduler();
  private readonly forkReaders = new Map<string, ForkReadWork>();
  private readonly forkBlockedPaths = new Set<string>();
  private readonly forkReadyPaths = new Set<string>();
  private readonly forkTrackedPaths = new Set<string>();
  private readonly recordReads = new Map<string, CodexRecordRangeReadTask>();
  private readonly recordReadScheduler = new CodexWorkScheduler();
  private readonly deferredBusinessPaths = new Set<string>();
  private activeReadSlice: CodexFileWorkSlice | null = null;
  private readonly clearedRecordReadPaths = new Set<string>();
  private readonly normalScanReaders = new Map<string, CodexGuardedJsonlReadTask>();
  private readonly baselineReaders = new Map<string, CodexGuardedJsonlReadTask>();
  private readonly metaReaders = new Map<string, CodexJsonlReadTask>();
  private readonly businessScheduler = new CodexWorkScheduler();
  private readonly businessTrackedPaths = new Set<string>();
  private readonly cycleTerminalCounts = new Map<string, number>();
  private readonly cycleFailedPaths = new Set<string>();
  private readonly continuations = new Map<string, CodexTranscriptContinuation>();
  private readonly scanBatches = new Map<string, { startOffset: number; endOffset: number; items: CodexTranscriptSourceRecord[] }>();
  private readonly continuationMaxBytes = 32 * 1024 * 1024;
  private readonly ownerIndexMaxBytes = 16 * 1024 * 1024;
  private readonly pausedReaderMaxBytes = 32 * 1024 * 1024;
  private giantReaderPath: string | null = null;
  private businessEmittedCount = 0;

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
        const result = { ...record, sourceRef: parseCodexSourceRef(record.sourceRef) } as unknown as CodexPendingAgentResult;
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

  protected override getInputRuntimeAccumulator(): InputRuntimeAccumulator | null {
    return super.getInputRuntimeAccumulator() ?? this.startupRuntime;
  }

  protected override async onStart(): Promise<void> {
    const runtime = new InputRuntimeAccumulator();
    runtime.enableCodexReadMetrics();
    const startedAt = runtime.now();
    this.startupRuntime = runtime;
    try {
      await this.initializeCodexInput();
    } finally {
      this.startupRuntime = null;
      const delta = runtime.finish(runtime.now() - startedAt);
      if (delta.rawReadCalls > 0 || delta.codexRead!.ownerBlockedFilesMax > 0) this.emit('input-runtime-delta', delta);
    }
  }

  private async initializeCodexInput(): Promise<void> {
    this.subagentLinker.restore(this.stateStore.get(this.id).extra?.codexDelegations);
    this.discardLegacyGlobalTurnRegistry();
    const discovered = await this.discoverSessionFiles();
    await this.indexDiscoveredTranscriptOwners(discovered, undefined, true, false);
    await this.scheduleDiscoveredFiles(discovered);
    await Promise.all([
      fs.mkdir(this.wakeupDir, { recursive: true }),
      fs.mkdir(this.spanContextDir, { recursive: true }),
    ]);
    try {
      this.wakeupWatcher = fsSync.watch(this.wakeupDir, { persistent: false }, () => {
        this.requestCollection();
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
    this.multimodalUriCache.clear();
    this.transcriptMetaCacheByPath.clear();
    this.transcriptMetaCacheBytes = 0;
    this.ownerScheduler.clear();
    this.ownerProbes.clear();
    this.ownerSnapshots.clear();
    this.ownerBlockedPaths.clear();
    this.forkScheduler.clear();
    this.forkReaders.clear();
    this.forkBlockedPaths.clear();
    this.forkReadyPaths.clear();
    this.forkTrackedPaths.clear();
    this.recordReads.clear();
    this.recordReadScheduler.clear();
    this.deferredBusinessPaths.clear();
    this.clearedRecordReadPaths.clear();
    this.normalScanReaders.clear();
    this.baselineReaders.clear();
    this.metaReaders.clear();
    this.continuations.clear();
    this.scanBatches.clear();
    this.transcriptMetaByPath.clear();
    this.transcriptPathByThreadId.clear();
    this.giantReaderPath = null;
    this.businessScheduler.clear();
    this.businessTrackedPaths.clear();
    this.cycleTerminalCounts.clear();
    this.activeReadSlice = null;
    this.cycleWorkBudget = null;
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    this.getInputRuntimeAccumulator()?.enableCodexReadMetrics();
    await this.cleanupExpiredSpanContexts(Date.now());
    let emittedCount = 0;
    const discovered = await this.discoverSessionFiles();
    const discoveredPaths = new Set(discovered.map(file => file.filePath));
    for (const filePath of this.rolloutIdleSnapshot.keys()) {
      if (!discoveredPaths.has(filePath)) this.rolloutIdleSnapshot.delete(filePath);
    }
    const skipPaths = this.historicalRolloutSkipPaths(discovered, Date.now());
    await this.indexDiscoveredTranscriptOwners(discovered, skipPaths, false, false);
    discovered.sort((left, right) => {
      const leftDepth = this.transcriptMetaByPath.get(left.filePath)?.depth ?? 0;
      const rightDepth = this.transcriptMetaByPath.get(right.filePath)?.depth ?? 0;
      return leftDepth - rightDepth || left.filePath.localeCompare(right.filePath);
    });
    emittedCount += await this.scheduleDiscoveredFiles(discovered, skipPaths);
    emittedCount += await this.retryPendingAgentResults();
    this.getInputRuntimeAccumulator()?.observeCodexWork({ sourceConflictFilesMax: new Set([
      ...[...this.ownerProbes].filter(([, probe]) => probe.sourceConflict).map(([file]) => file),
      ...[...this.forkReaders].filter(([, work]) => work.reader.sourceConflict).map(([file]) => file),
      ...[...this.normalScanReaders].filter(([, reader]) => reader.sourceConflict).map(([file]) => file),
      ...[...this.recordReads.values()].filter(task => task.sourceConflict).map(task => task.filePath),
    ]).size });
    this.reportSubagentLinks();
    if (emittedCount > 0) this.logger.debug('cycle produced entries', { count: emittedCount });
    return [];
  }

  private async scheduleDiscoveredFiles(discovered: DiscoveredSessionFile[], skipPaths: ReadonlySet<string> = new Set()): Promise<number> {
    this.forkBlockedPaths.clear();
    this.forkReadyPaths.clear();
    this.deferredBusinessPaths.clear();
    this.businessEmittedCount = 0;
    this.cycleFailedPaths.clear();
    const failedPaths = this.cycleFailedPaths;
    for (const { filePath } of discovered) {
      if (skipPaths.has(filePath)) continue;
      this.businessTrackedPaths.add(filePath);
      const checkpoint = this.readCheckpoint(this.stateKey(filePath));
      const snapshot = this.ownerSnapshots.get(filePath);
      const hot = checkpoint?.activeTurn || checkpoint?.pendingTerminal || checkpoint?.deferredScan
        || (snapshot && !checkpoint?.startupBaselineTarget && (checkpoint?.scanOffset ?? 0) < snapshot.size);
      this.businessScheduler.enqueue({ key: filePath, filePath, priority: hot ? 'hot' : 'cold',
        eligible: () => !failedPaths.has(filePath) && (this.normalScanReaders.get(filePath)?.retryEligible ?? true)
          && (this.baselineReaders.get(filePath)?.retryEligible ?? true)
          && (!this.ownerProbes.get(filePath)?.sourceConflict || (!!this.ownerSnapshots.get(filePath)
            && this.ownerProbes.get(filePath)!.eligible(this.ownerSnapshots.get(filePath)!)))
          && (this.cycleTerminalCounts.get(filePath) ?? 0) < MAX_TERMINALS_PER_FILE_CYCLE,
        step: async slice => {
          try {
          const before = this.readCheckpoint(this.stateKey(filePath));
          const source = this.ownerSnapshots.get(filePath);
          if (!source) return { status: 'waiting' };
          const owner = this.ensureOwnerProbe(filePath, source);
          if (!owner.readyFor(source)) {
            let result: CodexWorkStepResult;
            try { result = await owner.step(slice, source); }
            catch (error) {
              this.logger.warn('Codex owner probe failed; retaining its source range', { transcriptPath: filePath, error: String(error) });
              return { status: 'waiting' };
            }
            this.publishReadyOwner(filePath, source);
            if (!owner.readyFor(source)) return result;
          }
          const pendingBaseline = this.readCheckpoint(this.stateKey(filePath))?.startupBaselineTarget;
          if (pendingBaseline) {
            const meta = this.transcriptMetaByPath.get(filePath);
            if (meta?.depth === 1 && meta.parentThreadId && this.hasLegacyPendingFusionForParent(meta.parentThreadId)) {
              const current = this.readCheckpoint(this.stateKey(filePath))!;
              current.startupBaselineTarget = undefined;
              this.saveCheckpoint(this.stateKey(filePath), current);
            } else if (hasCopiedHistoryPrefix(meta)) {
              await this.parkForkBaseline(filePath, this.stateKey(filePath), pendingBaseline.size, slice);
            } else {
              await this.baselineFile(filePath, this.stateKey(filePath), pendingBaseline.size, slice);
            }
            if (this.readCheckpoint(this.stateKey(filePath))?.startupBaselineTarget) return { status: 'deferred', progressed: slice.readBytes > 0 };
          }
          const settled = this.readCheckpoint(this.stateKey(filePath));
          if (settled && rolloutCaughtUp(settled, { ino: source.inode, size: source.size })) {
            this.noteRolloutIdle(filePath, { ino: source.inode, size: source.size, mtimeMs: source.mtimeMs });
            return { status: 'complete' };
          }
          let count: number;
          try { count = await this.processFile(filePath, slice); }
          catch (error) {
            failedPaths.add(filePath);
            this.logger.warn('Codex file task failed; retaining its source range', { transcriptPath: filePath, error: String(error) });
            return { status: 'waiting' };
          }
          this.businessEmittedCount += count;
          const after = this.readCheckpoint(this.stateKey(filePath));
          const snapshot = this.ownerSnapshots.get(filePath);
          if (!after || !snapshot || rolloutCaughtUp(after, { ino: snapshot.inode, size: snapshot.size })) return { status: 'complete' };
          const progressed = count > 0 || after.scanOffset !== before?.scanOffset || slice.readBytes > 0;
          return { status: progressed ? 'deferred' : 'waiting', progressed };
          } finally {
            if (slice.readBytes > 0) {
              this.trimPausedReaders(filePath);
              this.trimOwnerIndex(filePath);
            }
          }
        },
      });
    }
    if (this.cycleWorkBudget) await this.businessScheduler.run(this.cycleWorkBudget);
    return this.businessEmittedCount;
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

  private async processFile(filePath: string, slice?: CodexFileWorkSlice): Promise<number> {
    const observed: { stat?: RolloutStatSnapshot } = {};
    try {
      this.activeReadSlice = slice ?? (this.cycleWorkBudget ?? this.createOwnerProbeBudget(this.getInputRuntimeAccumulator())).fileSlice(filePath);
      return await this.scanRolloutFile(filePath, observed);
    } catch (error) {
      if (!(error instanceof CodexReadPostponed)) throw error;
      this.deferredBusinessPaths.add(filePath);
      return 0;
    } finally {
      this.activeReadSlice = null;
      this.scanBatches.delete(filePath);
      this.trimContinuations();
      this.trimPausedReaders(filePath);
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
    if (cached && await this.rolloutDirsUnchanged(cached.dirMtimes)) return cached.files;
    const files: string[] = [];
    const dirMtimes = new Map<string, number>();
    await collectRolloutFiles(this.sessionDir, files, dirMtimes);
    this.cachedDefaultRollout = dirMtimes.size > 0 ? { dirMtimes, files } : null;
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
    const ownerProbe = this.ownerProbes.get(filePath);
    if (!ownerProbe?.readyFor(codexSourceSnapshot(stat)) || this.forkBlockedPaths.has(filePath)) return 0;
    if (this.readCheckpoint(key)?.startupBaselineTarget) return 0;
    // onStart()/collect() index the current inode before processFile(). Keep
    // this lookup ahead of inode recovery: forkBootstrap is intentionally
    // cleared after owned data advances, while the owner meta remains the
    // durable proof that every replacement still starts with copied history.
    const indexedOwnerMeta = this.transcriptMetaByPath.get(filePath) ?? null;
    const parentPath = indexedOwnerMeta?.parentThreadId ? this.transcriptPathByThreadId.get(indexedOwnerMeta.parentThreadId) : undefined;
    if (parentPath && parentPath !== filePath) {
      const parent = this.readCheckpoint(this.stateKey(parentPath));
      if (this.ownerBlockedPaths.has(parentPath) || parent?.deferredScan || parent?.recordReads?.length) {
        this.deferredBusinessPaths.add(filePath);
        return 0;
      }
    }
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
    // 重启或 continuation 淘汰也不得绕开已经发现的完整正文范围冲突。
    for (const state of checkpoint.recordReads ?? []) if (state.probe.conflict) {
      await this.readRecordRange(filePath, state.startOffset, state.endOffset, state.reason, state.expectedRef);
    }
    runtime?.observeBacklog(Math.max(0, stat.size - checkpoint.scanOffset));
    if (rolloutCaughtUp(checkpoint, stat)) return 0;

    const resolution = ownerProbe.resolution;
    if (resolution.kind === 'searching') return 0;
    const resolvedOwnerOffset = resolution.kind === 'resolved' ? resolution.ownerOffset : null;
    if (checkpoint.ownerSessionMetaOffset !== resolvedOwnerOffset) {
      checkpoint.ownerSessionMetaOffset = resolvedOwnerOffset;
      checkpointChanged = true;
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
      && !this.forkReadyPaths.has(filePath)
      && !checkpoint.deferredScan
      && checkpoint.activeTurn === null
      && checkpoint.pendingTerminal === null
    ) {
      let prepared: Awaited<ReturnType<CodexTranscriptInput['prepareCopiedTranscript']>>;
      try {
        prepared = await this.prepareCopiedTranscript(filePath, stat.size, ownerMeta!, checkpoint,
          this.activeReadSlice ?? (this.cycleWorkBudget ?? this.createOwnerProbeBudget(runtime)).fileSlice(filePath));
      } catch (error) {
        this.logger.warn('Codex fork probe failed; retaining its source range', { transcriptPath: filePath, error: String(error) });
        this.cycleFailedPaths.add(filePath);
        return 0;
      }
      checkpointChanged ||= prepared.changed;
      if (!prepared.ready) {
        this.saveCheckpoint(key, checkpoint);
        return 0;
      }
    }

    const forkBootstrapAtOwnedScanStart = checkpoint.forkBootstrap;
    const ownedScanStartOffset = checkpoint.scanOffset;
    let emittedCount = 0;
    let processedTerminalCount = this.cycleTerminalCounts.get(filePath) ?? 0;
    const noteTerminal = (): void => {
      processedTerminalCount++;
      this.cycleTerminalCounts.set(filePath, processedTerminalCount);
    };
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
      noteTerminal();
      checkpointChanged = true;
    }
    // Migrate retained legacy fusion ranges to independent lifecycle recovery.
    // A parent terminal never supplies a terminal boundary for a child.
    if (checkpoint.pendingSubagent) {
      const released = await this.releaseCapturedSubagentIndependently(filePath, checkpoint);
      emittedCount += released.emittedCount;
      for (let count = 0; count < released.processedTerminalCount; count++) noteTerminal();
      checkpointChanged = true;
      if (checkpoint.pendingSubagent) {
        this.saveCheckpoint(key, checkpoint);
        return emittedCount;
      }
    }
    if (checkpoint.pendingFusion) {
      const released = await this.releaseParentFusionIndependently(filePath, checkpoint);
      emittedCount += released.emittedCount;
      for (let count = 0; count < released.processedTerminalCount; count++) noteTerminal();
      checkpointChanged = true;
    }

    let scannedBytes = 0;

    const hadPendingTerminal = checkpoint.pendingTerminal !== null;
    const pendingResult = await this.recoverPendingTerminal(filePath, checkpoint);
    checkpointChanged ||= hadPendingTerminal && pendingResult.changed !== false;
    emittedCount += pendingResult.emittedCount;
    for (let count = 0; count < pendingResult.processedTerminalCount; count++) noteTerminal();
    if (pendingResult.blocked) {
      if (checkpointChanged) this.saveCheckpoint(key, checkpoint);
      return emittedCount;
    }

    while (
      (checkpoint.deferredScan || checkpoint.scanOffset < stat.size)
      && processedTerminalCount < MAX_TERMINALS_PER_FILE_CYCLE
      && scannedBytes < MAX_SCAN_BYTES_PER_FILE_CYCLE
      && !this.activeReadSlice!.timeExpired
      && !this.activeReadSlice!.quantumExpired
    ) {
      const scanStartOffset = checkpoint.scanOffset;
      const scanEndOffset = stat.size;
      const originalActive = checkpoint.activeTurn ? cloneActiveTurn(checkpoint.activeTurn) : null;
      const originalOwnerOffset = checkpoint.ownerSessionMetaOffset;
      const deferred = checkpoint.deferredScan;
      if (deferred) {
        checkpoint.activeTurn = deferred.activeTurn ? cloneActiveTurn(deferred.activeTurn) : null;
        checkpoint.ownerSessionMetaOffset = deferred.ownerSessionMetaOffset;
      }
      let terminalTurnId: string | null = deferred?.terminalTurnId ?? null;
      let terminalEndOffset: number | null = deferred?.terminalTurnId ? deferred.endOffset : null;
      const scannedItems: CodexTranscriptSourceRecord[] = [];
      const processScannedLine = (line: JsonLine): void | false => {
        scannedItems.push(line);
        const payload = asRecord(line.record.payload);
        if (!payload) return;
        if (line.record.type === 'session_meta') {
          const ownerSessionMetaOffset = selectOwnerSessionMetaOffset(
            filePath,
            checkpoint.ownerSessionMetaOffset,
            line,
          );
          checkpoint.ownerSessionMetaOffset = ownerSessionMetaOffset;
          // owner 的最终选择已由本轮探测确认，扫描回调只更新候选偏移。
          return;
        }

        const turnId = turnIdForStart(line.record, payload);
        if (turnId) {
          if (!checkpoint.activeTurn || checkpoint.activeTurn.turnId !== turnId) {
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
      const reader = this.normalScanReader(filePath, checkpoint, codexSourceSnapshot(stat), scanEndOffset);
      if (deferred && checkpoint.scanProbe) {
        const validation = await reader.validate(this.activeReadSlice!, codexSourceSnapshot(stat));
        checkpoint.scanProbe = reader.serialize();
        checkpointChanged = true;
        if (validation !== 'complete') {
          checkpoint.activeTurn = originalActive;
          checkpoint.ownerSessionMetaOffset = originalOwnerOffset;
          break;
        }
      }
      const progress = deferred ? undefined : await reader.step(this.activeReadSlice!, codexSourceSnapshot(stat), processScannedLine,
        true, undefined, true);
      checkpoint.scanProbe = reader.serialize();
      checkpointChanged = true;
      if (progress?.status === 'source-conflict') {
        checkpoint.activeTurn = originalActive;
        checkpoint.ownerSessionMetaOffset = originalOwnerOffset;
        break;
      }
      const scan = deferred ? { nextOffset: deferred.endOffset, records: deferred.records,
        parseSuccessRecords: deferred.parseSuccessRecords, parseFailedRecords: deferred.parseFailedRecords,
        maxRecordBytes: deferred.maxRecordBytes } : { nextOffset: progress!.nextOffset, ...reader!.lastStepStatistics };
      if (scan.nextOffset === scanStartOffset) {
        checkpoint.activeTurn = originalActive;
        checkpoint.ownerSessionMetaOffset = originalOwnerOffset;
        if (progress?.status === 'deferred') this.cycleWorkBudget?.noteDeferred(`normal_scan:${filePath}`);
        break;
      }
      checkpointChanged = true;

      const nextScanOffset = terminalEndOffset ?? scan.nextOffset;
      if (!deferred) this.scanBatches.set(filePath, { startOffset: scanStartOffset, endOffset: nextScanOffset, items: scannedItems });
      const commitScannedBatch = (): void => {
        runtime?.observeCommittedBatch({ bytes: nextScanOffset - scanStartOffset, records: scan.records,
          parseSuccessRecords: scan.parseSuccessRecords, parseFailedRecords: scan.parseFailedRecords, maxRecordBytes: scan.maxRecordBytes });
        scannedBytes += nextScanOffset - scanStartOffset;
        checkpoint.deferredScan = undefined;
      };
      let blocked = false;

      if (checkpoint.activeTurn && nextScanOffset > checkpoint.activeTurn.startOffset) {
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
            noteTerminal();
            commitScannedBatch();
            checkpoint.scanOffset = nextScanOffset;
            continue;
          }

          let recovered: SegmentRecoveryResult;
          try {
            recovered = await this.recoverTurnSegment(filePath, checkpoint, nextScanOffset, terminalTurnId !== null);
          } catch (error) {
            if (!(error instanceof CodexReadPostponed)) throw error;
            this.deferredBusinessPaths.add(filePath);
            checkpoint.deferredScan = { endOffset: nextScanOffset, terminalTurnId,
              activeTurn: checkpoint.activeTurn ? cloneActiveTurn(checkpoint.activeTurn) : null,
              ownerSessionMetaOffset: checkpoint.ownerSessionMetaOffset, records: scan.records,
              parseSuccessRecords: scan.parseSuccessRecords, parseFailedRecords: scan.parseFailedRecords, maxRecordBytes: scan.maxRecordBytes };
            checkpoint.activeTurn = originalActive;
            checkpoint.ownerSessionMetaOffset = originalOwnerOffset;
            break;
          }
          emittedCount += this.emitEntryBatches(recovered.entries);
          if (
            recovered.kind !== 'unparseable'
            && recovered.consumedEndOffset > checkpoint.activeTurn.startOffset
          ) {
            checkpoint.activeTurn.startOffset = recovered.consumedEndOffset;
          }

          if (terminalTurnId && checkpoint.activeTurn.turnId === terminalTurnId) {
            if (recovered.kind === 'unparseable') {
              checkpoint.pendingTerminal = newPendingTerminal(
                terminalTurnId,
                nextScanOffset,
                recovered.diagnostics.sourceRecordCount,
                recovered.sourceRef,
              );
              checkpoint.pendingTerminal.failureKey = this.pendingFailureKey(filePath, checkpoint, checkpoint.pendingTerminal);
              this.logger.warn('terminal Codex turn could not be parsed; retaining it for the next scan', {
                transcriptPath: filePath,
                turnId: terminalTurnId,
                range: { startOffset: checkpoint.activeTurn.startOffset, endOffset: nextScanOffset },
                retryCount: checkpoint.pendingTerminal.retryCount,
                sourceRecordCount: recovered.diagnostics.sourceRecordCount,
              });
              blocked = true;
            } else if (!checkpoint.pendingFusion) {
              checkpoint.activeTurn = null;
              checkpoint.pendingTerminal = null;
              noteTerminal();
            }
        }
      }

      commitScannedBatch();
      checkpoint.scanOffset = nextScanOffset;
      if (blocked || terminalTurnId === null) break;
    }

    if (
      forkBootstrapAtOwnedScanStart
      && checkpoint.scanOffset > ownedScanStartOffset
    ) {
      checkpoint.forkBootstrap = undefined;
      this.forkReaders.delete(filePath);
      checkpointChanged = true;
    }
    if (checkpointChanged) this.saveCheckpoint(key, checkpoint);
    return emittedCount;
  }

  private normalScanReader(
    filePath: string, checkpoint: CodexTranscriptCheckpoint, snapshot: CodexTranscriptSourceSnapshot, targetSize: number,
  ): CodexGuardedJsonlReadTask {
    const generation = this.ownerProbes.get(filePath)!.sourceGeneration;
    const startOffset = checkpoint.deferredScan?.endOffset ?? checkpoint.scanOffset;
    let reader = this.normalScanReaders.get(filePath);
    if (!reader || reader.sourceGeneration !== generation || reader.parsedOffset !== startOffset) {
      reader = new CodexGuardedJsonlReadTask(filePath, snapshot, generation, 'normal_scan', startOffset,
        checkpoint.scanProbe, checkpoint.ownerProbe?.anchors, targetSize);
      this.normalScanReaders.set(filePath, reader);
    }
    return reader;
  }

  /**
   * A completed terminal line is never retried by the normal offset scan.
   * Persist the range and retry it before reading later transcript data.
   */
  private async recoverPendingTerminal(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
  ): Promise<PendingRecoveryResult> {
    const pending = checkpoint.pendingTerminal;
    if (!pending) return { blocked: false, emittedCount: 0, processedTerminalCount: 0 };
    if (checkpoint.activeTurn?.turnId !== pending.turnId) {
      checkpoint.pendingTerminal = null;
      return { blocked: false, emittedCount: 0, processedTerminalCount: 0 };
    }
    const failureKey = this.pendingFailureKey(filePath, checkpoint, pending);
    if (pending.failureKey === failureKey && pending.nextRetryAtMs !== undefined && Date.now() < pending.nextRetryAtMs) {
      return { blocked: true, changed: false, emittedCount: 0, processedTerminalCount: 0 };
    }
    let recovered: SegmentRecoveryResult;
    try {
      recovered = await this.recoverTurnSegment(filePath, checkpoint, pending.terminalEndOffset, true);
    } catch (error) {
      if (!(error instanceof CodexReadPostponed)) throw error;
      this.deferredBusinessPaths.add(filePath);
      return { blocked: true, changed: false, emittedCount: 0, processedTerminalCount: 0 };
    }
    if (recovered.kind === 'unparseable') {
      const now = Date.now();
      const backoffCount = pending.failureKey === failureKey ? (pending.backoffCount ?? pending.retryCount ?? 0) + 1 : 1;
      checkpoint.pendingTerminal = {
        ...pending,
        retryCount: (pending.retryCount ?? 0) + 1,
        firstPendingAtMs: pending.firstPendingAtMs ?? now,
        lastAttemptAtMs: now,
        sourceRecordCount: recovered.diagnostics.sourceRecordCount,
        nextRetryAtMs: now + pendingRetryDelay(backoffCount),
        backoffCount,
        failureKey,
        sourceRef: recovered.sourceRef ?? pending.sourceRef,
      };
      this.logger.warn('pending Codex terminal turn still could not be parsed; will retry', {
        transcriptPath: filePath,
        turnId: pending.turnId,
        range: { startOffset: checkpoint.activeTurn.startOffset, endOffset: pending.terminalEndOffset },
        retryCount: checkpoint.pendingTerminal.retryCount,
        firstPendingAtMs: checkpoint.pendingTerminal.firstPendingAtMs,
        sourceRecordCount: recovered.diagnostics.sourceRecordCount,
      });
      return { blocked: true, emittedCount: 0, processedTerminalCount: 0 };
    }

    const emittedCount = this.emitEntryBatches(recovered.entries);
    checkpoint.activeTurn = null;
    checkpoint.pendingTerminal = null;
    return { blocked: false, emittedCount, processedTerminalCount: 1 };
  }

  private async recoverTurnSegment(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    endOffset: number,
    terminal: boolean,
    inferredTerminalStatus?: 'interrupted',
    attachmentParentThreadId?: string,
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
    const expectedRef = checkpoint.pendingTerminal?.sourceRef;
    const owner = this.ownerProbes.get(filePath)!;
    const identity = JSON.stringify([checkpoint.inode, owner.sourceGeneration, owner.serialize().ownerRef?.sha256, activeTurn.turnId]);
    let continuation = this.continuations.get(filePath);
    if (continuation && (continuation.identity !== identity || continuation.startOffset !== activeTurn.startOffset || continuation.parsedOffset > endOffset)) {
      this.continuations.delete(filePath); continuation = undefined;
    }
    const useContinuation = !checkpoint.pendingTerminal && !checkpoint.pendingFusion && !checkpoint.pendingSubagent
      && (!terminal || !!continuation);
    let records: { items: CodexTranscriptSourceRecord[]; sourceRef?: CodexTranscriptSourceRef };
    if (useContinuation) {
      const snapshot = codexSourceSnapshot(await fs.stat(filePath));
      continuation ??= new CodexTranscriptContinuation(filePath, identity, owner.sourceGeneration, snapshot,
        activeTurn.startOffset, owner.ownerMeta, activeTurn.turnId, { requireTerminal: false, ...this.partialTurnOptions(activeTurn, filePath) },
        checkpoint.scanProbe?.anchors ?? owner.serialize().anchors);
      this.continuations.set(filePath, continuation);
      const validation = await continuation.guard.validate(this.activeReadSlice!, snapshot);
      if (validation !== 'complete') throw new CodexReadPostponed(validation);
      const batch = this.scanBatches.get(filePath);
      if (batch && batch.startOffset <= continuation.parsedOffset && batch.endOffset === endOffset) {
        continuation.feed(batch.items, endOffset);
      } else if (continuation.parsedOffset < endOffset) {
        const delta = await this.readRecordRange(filePath, continuation.parsedOffset, endOffset, 'recovery');
        continuation.feed(delta.items, endOffset);
      }
      this.scanBatches.delete(filePath);
      records = { items: [] };
    } else {
      continuation = undefined;
      records = await this.readRecordRange(filePath, activeTurn.startOffset, endOffset, 'recovery',
        expectedRef?.startOffset === activeTurn.startOffset && expectedRef.endOffset === endOffset ? expectedRef : undefined);
    }
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
      if (currentStat?.ino !== checkpoint.inode) throw new CodexReadPostponed('waiting');
      meta = await this.loadTranscriptOwnerMeta(filePath, checkpoint.inode, currentStat.size,
        checkpoint.ownerSessionMetaOffset, runtime);
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
    // 所有可能延期的源读取先完成，避免 extractor 的多模态处理及语义副作用提前发生。
    const inputContext = await this.resolveInputContext(filePath, activeTurn, meta, attachmentParentThreadId);
    const options = this.partialTurnOptions(activeTurn, filePath,
      attachmentParentThreadId ?? activeTurn.delegation?.parentThreadId ?? meta?.parentThreadId);
    let extraction = continuation ? continuation.snapshot() : extractCodexPartialTurnWithBoundaries(
      records.items, meta, sessionIdFromTranscriptPath(filePath), activeTurn.turnId, options);
    if (continuation && extraction) {
      const hydrated = await continuation.materialize(extraction, async ref => {
        const source = await this.readRecordRange(filePath, ref.startOffset, ref.endOffset, 'hydrate', ref);
        const item = source.items[0];
        if (!item) throw new CodexReadPostponed('waiting');
        return item;
      }, { requireTerminal: false, ...options }, terminal);
      extraction = hydrated.extraction;
      if (meta?.baseInstructions) extraction.turn.baseInstructions = meta.baseInstructions;
      if (meta?.toolDefinitions !== undefined) extraction.turn.toolDefinitions = meta.toolDefinitions;
      records.items = hydrated.items;
    }
    const previouslyEmittedStepCount = activeTurn.emittedStepCount ?? 0;
    if (!extraction) {
      this.continuations.delete(filePath);
      this.clearRecordReads(filePath);
      return {
        kind: 'unparseable',
        sourceRef: records.sourceRef,
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
    // authoritative task_complete / turn_aborted boundary. This also closes a
    // turn whose final LLM response was already emitted in an earlier poll.
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
    if (terminal) this.continuations.delete(filePath);
    else if (continuation && closedStepCount > 0) continuation.commit(closedStepCount, consumedEndOffset);
    this.clearRecordReads(filePath);
    return {
      kind: outputEntries.length > 0 ? 'processed-emitted' : 'processed-empty',
      entries: outputEntries,
      consumedEndOffset,
      terminalStatus: turn.status,
      diagnostics,
    };
  }

  private trimContinuations(): void {
    let bytes = [...this.continuations.values()].reduce((sum, work) => sum + work.estimatedBytes, 0);
    for (const [filePath, work] of this.continuations) {
      if (bytes <= this.continuationMaxBytes) break;
      bytes -= work.estimatedBytes;
      this.continuations.delete(filePath);
    }
  }

  /** 暂停对象的估算预算不包含正在组装/输出的唯一巨大文件槽位。 */
  private pausedReaders(): Map<string, { bytes: number; assembly: number; waiting: boolean; release: () => void }> {
    const readers = new Map<string, { bytes: number; assembly: number; waiting: boolean; release: () => void }>();
    const add = (file: string, bytes: number, assembly: number, waiting: boolean, release: () => void): void => {
      const previous = readers.get(file);
      readers.set(file, { bytes: bytes + (previous?.bytes ?? 0), assembly: Math.max(assembly, previous?.assembly ?? 0),
        waiting: waiting && (previous?.waiting ?? true), release: () => { previous?.release(); release(); } });
    };
    for (const [file, probe] of this.ownerProbes) add(file, probe.bufferedBytes, probe.bufferedBytes,
      !probe.eligible(this.ownerSnapshots.get(file) ?? probe.serialize().snapshot), () => probe.releaseBuffers());
    for (const [file, reader] of [...this.normalScanReaders, ...this.baselineReaders]) {
      add(file, reader.bufferedBytes, reader.bufferedBytes, reader.serialize().incompleteTail, () => reader.releaseBuffers());
    }
    for (const [file, work] of this.forkReaders) add(file, work.reader.bufferedBytes, work.reader.bufferedBytes,
      work.reader.serialize().incompleteTail, () => work.reader.releaseBuffers());
    for (const reader of this.metaReaders.values()) add(reader.filePath, reader.bufferedBytes, reader.bufferedBytes, false,
      () => reader.releaseBuffers());
    for (const task of this.recordReads.values()) add(task.filePath, task.bufferedBytes, task.assemblyBytes, false,
      () => task.releaseBuffers());
    return readers;
  }

  private allowReaderGrowth(filePath: string, bufferedBytes: number, requestedBytes: number): boolean {
    const readers = this.pausedReaders();
    const held = this.giantReaderPath ? readers.get(this.giantReaderPath) : undefined;
    if (!held || (held.bytes === 0 && this.giantReaderPath !== filePath)) this.giantReaderPath = null;
    const wantsGiant = bufferedBytes + requestedBytes > 2 * 1024 * 1024
      || (readers.get(filePath)?.bytes ?? 0) + requestedBytes * 3 > this.pausedReaderMaxBytes;
    if (wantsGiant && this.giantReaderPath && this.giantReaderPath !== filePath) {
      if (!held?.waiting) return false;
      // 静止半行让出槽位，但保留 EOF 和原校验依据；未追加时不会因此回读。
      held.release();
      this.giantReaderPath = null;
    }
    if (wantsGiant) this.giantReaderPath = filePath;
    let bytes = [...readers].reduce((sum, [file, work]) => sum + (file === this.giantReaderPath ? 0 : work.bytes), 0);
    for (const [file, work] of readers) {
      if (bytes + requestedBytes * 3 <= this.pausedReaderMaxBytes) break;
      if (file === filePath || file === this.giantReaderPath || work.bytes === 0) continue;
      work.release(); bytes -= work.bytes;
    }
    return true;
  }

  private trimPausedReaders(currentFile?: string): void {
    const readers = this.pausedReaders();
    const giant = [...readers].filter(([, work]) => work.assembly > 2 * 1024 * 1024 || work.bytes > this.pausedReaderMaxBytes);
    if (!this.giantReaderPath || !readers.get(this.giantReaderPath)?.bytes) this.giantReaderPath = giant[0]?.[0] ?? null;
    let bytes = [...readers].reduce((sum, [file, work]) => sum + (file === this.giantReaderPath ? 0 : work.bytes), 0);
    for (const [file, work] of readers) {
      if (bytes <= this.pausedReaderMaxBytes) break;
      if (file === this.giantReaderPath || file === currentFile) continue;
      work.release(); bytes -= work.bytes;
    }
  }

  private trimOwnerIndex(currentFile?: string): void {
    const estimate = (file: string, probe: CodexTranscriptOwnerProbe): number =>
      1024 + file.length * 4 + 2 * JSON.stringify(probe.ownerMeta).length;
    let bytes = [...this.ownerProbes].reduce((sum, [file, probe]) => sum + estimate(file, probe), 0);
    if (bytes <= this.ownerIndexMaxBytes && this.ownerProbes.size <= MAX_LINK_DESCRIPTORS) {
      if (currentFile) {
        const probe = this.ownerProbes.get(currentFile);
        if (probe?.resolution.kind === 'searching') probe.releaseCompleteMeta();
      }
      return;
    }
    const ordered = [...this.ownerProbes].sort(([left], [right]) => {
      const hot = (file: string): number => {
        const checkpoint = this.readCheckpoint(this.stateKey(file));
        return Number(file === currentFile) * 2 + Number(!!this.ownerProbes.get(file)?.bufferedBytes) * 4
          + Number(!!(checkpoint?.activeTurn || checkpoint?.pendingTerminal || checkpoint?.pendingFusion || checkpoint?.pendingSubagent));
      };
      return hot(left) - hot(right);
    });
    for (const [file, probe] of ordered) {
      if (bytes <= this.ownerIndexMaxBytes && this.ownerProbes.size <= MAX_LINK_DESCRIPTORS) break;
      if (file === currentFile) continue;
      bytes -= estimate(file, probe);
      this.ownerProbes.delete(file);
      this.transcriptMetaByPath.delete(file);
      this.ownerBlockedPaths.add(file);
    }
    // searching 的候选完整正文也不在身份索引中长期持有。
    for (const probe of this.ownerProbes.values()) if (probe.resolution.kind === 'searching') probe.releaseCompleteMeta();
  }

  private workMemorySnapshot(): { fullMetaBytes: number; ownerIndexBytes: number; continuationBytes: number;
    pausedReaderBytes: number; giantReaderFiles: number; giantReaderBytes: number } {
    const readers = this.pausedReaders();
    return { fullMetaBytes: this.transcriptMetaCacheBytes,
      ownerIndexBytes: [...this.ownerProbes].reduce((sum, [file, probe]) => sum + 1024 + file.length * 4
        + 2 * JSON.stringify(probe.ownerMeta).length, 0),
      continuationBytes: [...this.continuations.values()].reduce((sum, work) => sum + work.estimatedBytes, 0),
      pausedReaderBytes: [...readers].reduce((sum, [file, work]) => sum + (file === this.giantReaderPath ? 0 : work.bytes), 0),
      giantReaderFiles: [...readers].filter(([, work]) => work.assembly > 2 * 1024 * 1024 || work.bytes > this.pausedReaderMaxBytes).length,
      giantReaderBytes: (this.giantReaderPath ? readers.get(this.giantReaderPath)?.bytes : 0) ?? 0 };
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

    const records = await this.readRecordRange(filePath, range.startOffset, range.endOffset, 'hydrate');
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

  private pendingFailureKey(filePath: string, checkpoint: CodexTranscriptCheckpoint, pending: CodexPendingTerminalTurn): string {
    const owner = this.ownerProbes.get(filePath)?.serialize();
    const active = checkpoint.activeTurn;
    return crypto.createHash('sha256').update(JSON.stringify([checkpoint.inode, owner?.probe.sourceGeneration,
      owner?.ownerRef?.sha256, active?.turnId, active?.startOffset, pending.terminalEndOffset, active?.model,
      active?.cwd, active?.developerInstructions, active?.inputContext])).digest('hex');
  }

  private clearRecordReads(filePath: string): void {
    this.clearedRecordReadPaths.add(filePath);
    for (const [key, task] of this.recordReads) if (task.filePath === filePath && !task.sourceConflict) {
      this.recordReads.delete(key);
      this.recordReadScheduler.delete(key);
    }
  }

  private async readRecordRange(filePath: string, startOffset: number, endOffset: number, reason: 'recovery' | 'hydrate',
    expectedRef?: CodexTranscriptSourceRef): Promise<{ items: CodexJsonLine[]; nextOffset: number; sourceRef?: CodexTranscriptSourceRef }> {
    if (endOffset <= startOffset) return { items: [], nextOffset: startOffset };
    const stat = await fs.stat(filePath);
    const snapshot = codexSourceSnapshot(stat);
    const owner = this.ownerProbes.get(filePath);
    if (!owner?.readyFor(snapshot)) throw new CodexReadPostponed('waiting');
    const key = JSON.stringify([filePath, owner.sourceGeneration, reason, startOffset, endOffset, expectedRef?.sha256]);
    let task = this.recordReads.get(key);
    if (!task) {
      const restored = this.readCheckpoint(this.stateKey(filePath))?.recordReads?.find(state => state.reason === reason
        && state.startOffset === startOffset && state.endOffset === endOffset
        && state.probe.snapshot.inode === snapshot.inode && state.probe.sourceGeneration === owner.sourceGeneration);
      task = new CodexRecordRangeReadTask(filePath, startOffset, endOffset, snapshot, owner.sourceGeneration,
        reason, restored, owner.serialize().anchors, expectedRef);
      this.recordReads.set(key, task);
    }
    const slice = this.activeReadSlice?.filePath === filePath ? this.activeReadSlice
      : (this.cycleWorkBudget ?? this.createOwnerProbeBudget(this.getInputRuntimeAccumulator())).fileSlice(filePath);
    const result = slice.timeExpired ? { status: 'deferred' as const } : await task.step(slice, snapshot);
    if (result.status !== 'complete') {
      this.recordReadScheduler.enqueue({ key, filePath, priority: 'hot',
        eligible: () => {
          const current = this.ownerSnapshots.get(filePath);
          const work = this.recordReads.get(key);
          return !!current && !!work && work.retryEligible && work.sourceGeneration === this.ownerProbes.get(filePath)?.sourceGeneration
            && !!this.ownerProbes.get(filePath)?.readyFor(current);
        },
        step: async nextSlice => {
          const work = this.recordReads.get(key);
          const current = this.ownerSnapshots.get(filePath);
          if (!work || !current) return { status: 'waiting' };
          try {
            const result = await work.step(nextSlice, current);
            const checkpoint = this.readCheckpoint(this.stateKey(filePath));
            if (checkpoint) this.saveCheckpoint(this.stateKey(filePath), checkpoint);
            return { status: result.status === 'source-conflict' ? 'waiting' : result.status, progressed: nextSlice.readBytes > 0 };
          } catch (error) {
            this.logger.warn('Codex fixed recovery read failed; retaining its range', { transcriptPath: filePath, error: String(error) });
            return { status: 'waiting' };
          }
        },
      });
      if (result.status === 'deferred') slice.budget.noteDeferred(key);
      const checkpoint = this.readCheckpoint(this.stateKey(filePath));
      if (checkpoint) this.saveCheckpoint(this.stateKey(filePath), checkpoint);
      if (result.status === 'source-conflict') this.getInputRuntimeAccumulator()?.observeCodexWork({ sourceConflictFilesMax: 1 });
      throw new CodexReadPostponed(result.status);
    }
    return result;
  }

  private async drainRecordReads(): Promise<void> {
    if (this.cycleWorkBudget) await this.recordReadScheduler.run(this.cycleWorkBudget);
  }

  private async preloadRecovery(filePath: string, active: CodexActiveTranscriptTurn | null, endOffset: number): Promise<void> {
    if (!active) return;
    await this.readRecordRange(filePath, active.startOffset, endOffset, 'recovery');
    await this.resolveInputContext(filePath, active, this.ownerProbes.get(filePath)?.ownerMeta ?? null);
  }

  private async registerSubagentOwnerMeta(
    filePath: string,
    inode: number,
    fileSize: number,
    ownerSessionMetaOffset: number | null,
    cacheAccess: TranscriptMetaCacheAccess = 'active',
  ): Promise<void> {
    if (ownerSessionMetaOffset === null) return;
    const owner = this.ownerProbes.get(filePath);
    const indexedMeta = owner?.ownerMeta;
    if (indexedMeta) {
      const full = owner.completeMeta;
      if (full) {
        this.rememberTranscriptOwnerMeta(filePath, inode, fileSize, ownerSessionMetaOffset, full, cacheAccess);
        owner.releaseCompleteMeta();
      }
      if (!full && !this.activeReadSlice && cacheAccess === 'active' && !this.transcriptMetaCacheByPath.has(filePath)) {
        await this.loadTranscriptOwnerMeta(filePath, inode, fileSize, ownerSessionMetaOffset,
          this.getInputRuntimeAccumulator(), cacheAccess);
      }
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

  protected createOwnerProbeBudget(runtime: InputRuntimeAccumulator | null): CodexWorkBudget {
    return new CodexWorkBudget({}, runtime);
  }

  /** owner 与 fork 定位共享本周期预算；每个 dispatch 独立让出 2 MiB 量子。 */
  private async prepareDiscoveredForks(files: DiscoveredSessionFile[], skipPaths?: ReadonlySet<string>): Promise<void> {
    this.forkBlockedPaths.clear();
    this.forkReadyPaths.clear();
    const paths = new Set(files.map(file => file.filePath));
    for (const filePath of new Set([...this.forkReaders.keys(), ...this.forkTrackedPaths])) if (!paths.has(filePath)) {
      this.forkReaders.delete(filePath);
      this.forkScheduler.delete(filePath);
      this.forkTrackedPaths.delete(filePath);
    }
    for (const { filePath } of files) {
      const checkpoint = this.readCheckpoint(this.stateKey(filePath));
      const meta = this.transcriptMetaByPath.get(filePath);
      const snapshot = this.ownerSnapshots.get(filePath);
      if (skipPaths?.has(filePath) || !snapshot || this.ownerBlockedPaths.has(filePath)) continue;
      if (!checkpoint || checkpoint.inode !== snapshot.inode || checkpoint.startupBaselineTarget
        || checkpoint.activeTurn || checkpoint.pendingTerminal || checkpoint.deferredScan || !hasCopiedHistoryPrefix(meta)
        || (checkpoint.scanOffset !== 0 && !checkpoint.forkBootstrap)) {
        this.forkScheduler.delete(filePath);
        this.forkReaders.delete(filePath);
        this.forkTrackedPaths.delete(filePath);
        continue;
      }
      this.forkBlockedPaths.add(filePath);
      this.forkTrackedPaths.add(filePath);
      this.forkScheduler.enqueue({ key: filePath, filePath,
        priority: checkpoint.forkBootstrap?.state === 'baseline-search' || checkpoint.forkBootstrap?.state === 'baseline-tail' ? 'cold' : 'hot',
        eligible: () => !this.ownerBlockedPaths.has(filePath) && !!this.ownerSnapshots.get(filePath)
          && (this.forkReaders.get(filePath)?.reader.retryEligible ?? true),
        step: async slice => {
          const current = this.readCheckpoint(this.stateKey(filePath));
          const source = this.ownerSnapshots.get(filePath);
          const owner = this.transcriptMetaByPath.get(filePath);
          if (!current || !source || !owner || !this.ownerProbes.get(filePath)?.readyFor(source)) return { status: 'waiting' };
          const before = JSON.stringify(current);
          try {
            const prepared = await this.prepareCopiedTranscript(filePath, source.size, owner, current, slice);
            if (prepared.changed && JSON.stringify(current) !== before) this.saveCheckpoint(this.stateKey(filePath), current);
            if (prepared.ready) {
              this.forkBlockedPaths.delete(filePath);
              this.forkReadyPaths.add(filePath);
            }
            if (prepared.status === 'complete') this.forkTrackedPaths.delete(filePath);
            return { status: prepared.status, progressed: slice.readBytes > 0 };
          } catch (error) {
            this.logger.warn('Codex fork probe failed; retaining its source range', { transcriptPath: filePath, error: String(error) });
            return { status: 'waiting' };
          }
        },
      });
    }
    if (this.cycleWorkBudget) await this.forkScheduler.run(this.cycleWorkBudget);
    this.getInputRuntimeAccumulator()?.observeCodexWork({
      sourceConflictFilesMax: new Set([
        ...[...this.ownerProbes].filter(([, probe]) => probe.sourceConflict).map(([file]) => file),
        ...[...this.forkReaders].filter(([, work]) => work.reader.sourceConflict).map(([file]) => file),
      ]).size,
    });
  }

  private async finishStartupBaselines(files: DiscoveredSessionFile[]): Promise<void> {
    for (const { filePath } of files) {
      const key = this.stateKey(filePath);
      const checkpoint = this.readCheckpoint(key);
      if (!checkpoint?.startupBaselineTarget || this.ownerBlockedPaths.has(filePath)) continue;
      const meta = this.transcriptMetaByPath.get(filePath);
      if (meta?.depth === 1 && meta.parentThreadId && this.hasLegacyPendingFusionForParent(meta.parentThreadId)) {
        checkpoint.startupBaselineTarget = undefined;
        this.saveCheckpoint(key, checkpoint);
      } else if (hasCopiedHistoryPrefix(meta)) {
        await this.parkForkBaseline(filePath, key, checkpoint.startupBaselineTarget.size);
      } else {
        await this.baselineFile(filePath, key, checkpoint.startupBaselineTarget.size);
      }
    }
  }

  private async indexDiscoveredTranscriptOwners(
    files: DiscoveredSessionFile[],
    skipPaths?: ReadonlySet<string>,
    startup = false,
    runProbes = true,
  ): Promise<void> {
    this.cycleWorkBudget = this.createOwnerProbeBudget(this.getInputRuntimeAccumulator());
    this.cycleWorkBudget.allowBufferGrowth = (file, buffered, requested) => this.allowReaderGrowth(file, buffered, requested);
    this.cycleTerminalCounts.clear();
    const kept = new Map<string, NonNullable<ReturnType<typeof extractCodexTranscriptMeta>>>();
    if (skipPaths) {
      for (const filePath of skipPaths) {
        const meta = this.transcriptMetaByPath.get(filePath);
        if (meta) kept.set(filePath, meta);
      }
    }
    this.transcriptMetaByPath.clear();
    this.transcriptPathByThreadId.clear();
    this.ownerSnapshots.clear();
    this.ownerBlockedPaths.clear();
    const discoveredPaths = new Set(files.map(file => file.filePath));
    this.pruneAbsentTranscriptMetaCache(discoveredPaths, Date.now());
    for (const filePath of this.continuations.keys()) if (!discoveredPaths.has(filePath)) this.continuations.delete(filePath);
    for (const filePath of this.forkReaders.keys()) if (!discoveredPaths.has(filePath)) this.forkReaders.delete(filePath);
    for (const filePath of this.normalScanReaders.keys()) if (!discoveredPaths.has(filePath)) this.normalScanReaders.delete(filePath);
    for (const filePath of this.baselineReaders.keys()) if (!discoveredPaths.has(filePath)) this.baselineReaders.delete(filePath);
    // 调度队列还可能保留尚未开始扫描的文件，因此按旧发现集独立清理。
    for (const filePath of this.businessTrackedPaths) if (!discoveredPaths.has(filePath)) {
      this.businessScheduler.delete(filePath);
      this.businessTrackedPaths.delete(filePath);
    }
    for (const [key, task] of this.recordReads) if (!discoveredPaths.has(task.filePath)) {
      this.recordReads.delete(key);
      this.recordReadScheduler.delete(key);
    }
    for (const filePath of this.ownerProbes.keys()) if (!discoveredPaths.has(filePath)) {
      this.ownerProbes.delete(filePath);
      this.ownerScheduler.delete(filePath);
    }
    for (const [filePath, meta] of kept) {
      this.publishTranscriptOwnerMeta(filePath, meta);
    }
    for (const { filePath, baselineOnStart } of files) {
      if (skipPaths?.has(filePath)) continue;
      this.ownerBlockedPaths.add(filePath);
      let stat;
      try { stat = await fs.stat(filePath); } catch { continue; }
      const snapshot = codexSourceSnapshot(stat);
      this.ownerSnapshots.set(filePath, snapshot);
      const key = this.stateKey(filePath);
      let checkpoint = this.readCheckpoint(key);
      if (!checkpoint) {
        checkpoint = { inode: stat.ino, scanOffset: 0, activeTurn: null, pendingTerminal: null,
          pendingFusion: null, pendingSubagent: null, ownerSessionMetaOffset: null,
          ...(startup && baselineOnStart ? { startupBaselineTarget: { inode: stat.ino, size: stat.size } } : {}) };
        this.saveCheckpoint(key, checkpoint);
      }
      // 未缓存的身份只在其公平工作单元被选中时重建，容量溢出不按目录排序反复丢弃同一前缀。
      this.ownerScheduler.enqueue({
        key: filePath, filePath, priority: checkpoint.activeTurn || checkpoint.pendingTerminal || checkpoint.pendingFusion || checkpoint.pendingSubagent ? 'hot' : 'cold',
        eligible: () => {
          const current = this.ownerSnapshots.get(filePath);
          const probe = this.ownerProbes.get(filePath);
          return !!current && (!probe || probe.inode !== current.inode || probe.eligible(current));
        },
        step: async slice => {
          try {
            const current = this.ownerSnapshots.get(filePath)!;
            const result = await this.ensureOwnerProbe(filePath, current).step(slice, current);
            this.publishReadyOwner(filePath, current);
            this.trimPausedReaders(filePath);
            this.trimOwnerIndex(filePath);
            return result;
          }
          catch (error) {
            this.logger.warn('Codex owner probe failed; retaining its source range', { transcriptPath: filePath, error: String(error) });
            return { status: 'waiting' };
          }
        },
      });
    }
    if (runProbes) await this.ownerScheduler.run(this.cycleWorkBudget);
    for (const [filePath, snapshot] of this.ownerSnapshots) this.publishReadyOwner(filePath, snapshot);
    this.trimOwnerIndex();
    this.getInputRuntimeAccumulator()?.observeCodexWork({
      ownerBlockedFilesMax: this.ownerBlockedPaths.size,
      sourceConflictFilesMax: [...this.ownerProbes.values()].filter(probe => probe.sourceConflict).length,
    });
  }

  private ensureOwnerProbe(filePath: string, snapshot: CodexTranscriptSourceSnapshot): CodexTranscriptOwnerProbe {
    const previous = this.ownerProbes.get(filePath);
    if (previous?.inode === snapshot.inode) return previous;
    const checkpoint = this.readCheckpoint(this.stateKey(filePath))!;
    const restored = checkpoint.ownerProbe?.probe.inode === snapshot.inode ? checkpoint.ownerProbe : undefined;
    const cached = this.transcriptMetaCacheByPath.get(filePath);
    const probe = new CodexTranscriptOwnerProbe(filePath, snapshot, restored,
      cached?.inode === snapshot.inode && cached.ownerSessionMetaOffset === restored?.probe.candidateOwnerOffset ? cached.meta : null,
      undefined, (previous?.sourceGeneration ?? checkpoint.ownerProbe?.probe.sourceGeneration ?? -1) + 1);
    this.ownerProbes.set(filePath, probe);
    return probe;
  }

  private publishReadyOwner(filePath: string, snapshot: CodexTranscriptSourceSnapshot): void {
    const probe = this.ownerProbes.get(filePath);
    if (!probe) return;
    const key = this.stateKey(filePath);
    const checkpoint = this.readCheckpoint(key)!;
    const state = probe.serialize();
    const resolution = probe.resolution;
    if (probe.readyFor(snapshot)) {
      this.ownerBlockedPaths.delete(filePath);
      const meta = probe.completeMeta;
      if (meta && resolution.kind === 'resolved') {
        const cached = this.transcriptMetaCacheByPath.get(filePath);
        if (cached && reusableCachedTranscriptMeta(cached, snapshot.inode, snapshot.size, resolution.ownerOffset)
          && cached.estimatedBytes === estimateCachedTranscriptMetaBytes(filePath, meta)) {
          cached.meta = meta;
          cached.fileSize = snapshot.size;
          cached.lastSeenAtMs = Date.now();
        } else {
          this.rememberTranscriptOwnerMeta(filePath, snapshot.inode, snapshot.size, resolution.ownerOffset, meta, 'discovery');
        }
        probe.releaseCompleteMeta();
      }
      if (probe.ownerMeta) this.publishTranscriptOwnerMeta(filePath, probe.ownerMeta);
      if (checkpoint.inode === snapshot.inode) checkpoint.ownerSessionMetaOffset = resolution.kind === 'resolved' ? resolution.ownerOffset : null;
    }
    if (JSON.stringify(checkpoint.ownerProbe) !== JSON.stringify(state)
      || this.readCheckpoint(key)!.ownerSessionMetaOffset !== checkpoint.ownerSessionMetaOffset) {
      checkpoint.ownerProbe = state;
      this.saveCheckpoint(key, checkpoint);
    }
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

    const owner = this.ownerProbes.get(filePath);
    const slice = this.activeReadSlice?.filePath === filePath ? this.activeReadSlice
      : this.createOwnerProbeBudget(runtime ?? null).fileSlice(filePath);
    let meta: CodexTranscriptMeta | null = null;
    if (owner && this.activeReadSlice) {
      const snapshot = codexSourceSnapshot(await fs.stat(filePath));
      if (!owner.readyFor(snapshot)) throw new CodexReadPostponed('waiting');
      const result = await owner.hydrateCompleteMeta(slice);
      if (result.status !== 'complete') throw new CodexReadPostponed(result.status);
      meta = owner.completeMeta;
      owner.releaseCompleteMeta();
    } else {
      // 内部独立读取同样使用预算；生产恢复始终经过上面的 ownerRef 完整校验。
      const key = JSON.stringify([filePath, inode, fileSize, ownerSessionMetaOffset]);
      let reader = this.metaReaders.get(key);
      if (!reader) {
        reader = new CodexJsonlReadTask(filePath, ownerSessionMetaOffset, fileSize, 'hydrate', inode, true);
        this.metaReaders.set(key, reader);
      }
      const result = await reader.step(slice, line => { meta = extractCodexTranscriptMeta(line.record); return false; });
      if (result.status === 'deferred') throw new CodexReadPostponed('deferred');
      this.metaReaders.delete(key);
      if (result.status === 'source-conflict') throw new CodexReadPostponed('source-conflict');
    }
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
    this.transcriptMetaByPath.set(filePath, codexOwnerSummary(meta));
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

    await this.preloadRecovery(filePath, checkpoint.activeTurn, pending.terminalEndOffset);
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
        recovered.sourceRef,
      );
      checkpoint.pendingTerminal.failureKey = this.pendingFailureKey(filePath, checkpoint, checkpoint.pendingTerminal);
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
    await this.preloadRecovery(filePath, captured.activeTurn, captured.terminalEndOffset);
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
    slice: CodexFileWorkSlice,
  ): Promise<{ ready: boolean; changed: boolean; status: CodexWorkStepResult['status'] }> {
    // A newly discovered live fork must not enter the normal scanner until its
    // first positively-owned turn is located.
    if (checkpoint.scanOffset === 0 && checkpoint.forkBootstrap === undefined) {
      checkpoint.forkBootstrap = {
        state: 'live-pending',
        searchOffset: 0,
      };
    }

    const current = checkpoint.forkBootstrap;
    if (!current) return { ready: true, changed: false, status: 'complete' };
    if (current.state === 'baseline-tail') {
      return this.rebuildForkBaselineTail(filePath, checkpoint, slice);
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
        readProbe: bootstrap.readProbe,
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
        readProbe: bootstrap.readProbe,
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

    const located = await this.findTurnStartOffset(filePath, ownerMeta.threadId, bootstrap, slice);
    if (located.startOffset === null) {
      checkpoint.forkBootstrap = {
        ...bootstrap,
        searchOffset: located.nextOffset,
        readProbe: this.forkReaders.get(filePath)!.reader.serialize(),
      };
      if (
        located.status === 'waiting' && !checkpoint.forkBootstrap.readProbe?.incompleteTail
        && located.nextOffset >= fileSize
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
      return { ready: false, changed: true, status: located.status };
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
      return this.rebuildForkBaselineTail(filePath, checkpoint, slice);
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
          readProbe: this.forkReaders.get(filePath)!.reader.serialize(),
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
    return { ready: !startHookOnly, changed: true, status: 'complete' };
  }

  private forkReadWork(filePath: string, bootstrap: CodexForkBootstrap, targetSize: number, criteria: string): ForkReadWork {
    const snapshot = this.ownerSnapshots.get(filePath)!;
    const owner = this.ownerProbes.get(filePath)!;
    const key = JSON.stringify([snapshot.inode, owner.sourceGeneration, criteria]);
    const existing = this.forkReaders.get(filePath);
    if (existing?.criteria === key && (existing.reader.parsedOffset === bootstrap.searchOffset
      || existing.located?.startOffset === bootstrap.searchOffset)) return existing;
    const work: ForkReadWork = { criteria: key, reader: new CodexGuardedJsonlReadTask(filePath, snapshot,
      owner.sourceGeneration, bootstrap.state === 'baseline-tail' ? 'baseline' : 'fork_search', bootstrap.searchOffset,
      bootstrap.readProbe ?? existing?.reader.serialize(), owner.serialize().anchors, targetSize) };
    this.forkReaders.set(filePath, work);
    return work;
  }

  private async findTurnStartOffset(filePath: string, ownerThreadId: string, bootstrap: CodexForkBootstrap,
    slice: CodexFileWorkSlice): Promise<ForkLocation> {
    const snapshot = this.ownerSnapshots.get(filePath)!;
    const work = this.forkReadWork(filePath, bootstrap, snapshot.size,
      JSON.stringify(['search', ownerThreadId, bootstrap.initialTurnId, bootstrap.initialTurnId ? null : bootstrap.recoveryTurnId]));
    if (work.located) {
      const validated = await work.reader.validate(slice, snapshot);
      if (validated === 'complete') return work.located;
      return { startOffset: null, nextOffset: work.reader.parsedOffset,
        status: validated === 'deferred' ? 'deferred' : 'waiting' };
    }
    let located: ForkLocation | undefined;
    const ownerTimestamp = uuidV7TimestampMs(ownerThreadId);
    const result = await work.reader.step(slice, snapshot, line => {
      const payload = asRecord(line.record.payload);
      const turnId = payload && turnIdForStart(line.record, payload);
      if (!turnId) return;
      let anchorKind: ForkLocation['anchorKind'];
      if (bootstrap.initialTurnId) {
        if (turnId === bootstrap.initialTurnId) anchorKind = 'initial-hook';
      } else {
        const candidateTimestamp = uuidV7TimestampMs(turnId);
        if (ownerTimestamp !== undefined && candidateTimestamp !== undefined && candidateTimestamp >= ownerTimestamp) anchorKind = 'uuidv7';
        else if (turnId === bootstrap.recoveryTurnId) anchorKind = 'terminal-recovery';
      }
      if (!anchorKind) return;
      located = { startOffset: line.startOffset, nextOffset: line.endOffset, turnId, anchorKind, status: 'complete' };
      return false;
    });
    if (located && result.status === 'complete') {
      work.located = located;
      return located;
    }
    return { startOffset: null, nextOffset: result.nextOffset,
      status: result.status === 'deferred' ? 'deferred' : 'waiting' };
  }

  private async parkForkBaseline(filePath: string, key: string, targetSize?: number, slice?: CodexFileWorkSlice): Promise<void> {
    await this.readBaseline(filePath, key, 'fork', targetSize, slice);
  }

  private async rebuildForkBaselineTail(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    slice: CodexFileWorkSlice,
  ): Promise<{ ready: boolean; changed: boolean; status: CodexWorkStepResult['status'] }> {
    const bootstrap = checkpoint.forkBootstrap;
    if (!bootstrap || bootstrap.state !== 'baseline-tail') return { ready: true, changed: false, status: 'complete' };

    const baselineEnd = checkpoint.scanOffset;
    const searchOffset = boundedSearchOffset(bootstrap.searchOffset, baselineEnd);
    bootstrap.searchOffset = searchOffset;
    const work = this.forkReadWork(filePath, bootstrap, baselineEnd, `tail:${baselineEnd}`);
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

    const scan = await work.reader.step(slice, this.ownerSnapshots.get(filePath)!, processLine, false);
    if (scan.status === 'source-conflict') {
      checkpoint.forkBootstrap = { ...bootstrap, readProbe: work.reader.serialize() };
      return { ready: false, changed: true, status: 'waiting' };
    }
    if (scan.status !== 'complete' || scan.nextOffset < baselineEnd) {
      checkpoint.forkBootstrap = {
        ...bootstrap,
        searchOffset: scan.nextOffset,
        readProbe: work.reader.serialize(),
        ...(candidate ? { tailCandidate: candidate } : { tailCandidate: undefined }),
      };
      return { ready: false, changed: true, status: scan.status === 'deferred' ? 'deferred' : 'waiting' };
    }

    if (candidate) {
      candidate.startOffset = baselineEnd;
      checkpoint.activeTurn = candidate;
    }
    checkpoint.forkBootstrap = undefined;
    this.forkReaders.delete(filePath);
    return { ready: true, changed: true, status: 'complete' };
  }

  private async baselineFile(filePath: string, key: string, targetSize?: number, slice?: CodexFileWorkSlice): Promise<void> {
    await this.readBaseline(filePath, key, 'normal', targetSize, slice);
  }

  private async readBaseline(filePath: string, key: string, mode: 'normal' | 'fork', targetSize?: number,
    slice?: CodexFileWorkSlice): Promise<void> {
    let stat;
    try { stat = await fs.stat(filePath); } catch { return; }
    const snapshot = codexSourceSnapshot(stat);
    const owner = this.ownerProbes.get(filePath);
    if (!owner?.readyFor(snapshot)) return;
    const checkpoint = this.readCheckpoint(key)!;
    const startup = checkpoint.startupBaselineTarget;
    const limit = startup?.inode === snapshot.inode ? startup.size : targetSize !== undefined && checkpoint.inode === snapshot.inode
      ? targetSize : snapshot.size;
    checkpoint.startupBaselineTarget = { inode: snapshot.inode, size: limit };
    const restored = checkpoint.baselineRead?.mode === mode && checkpoint.baselineRead.probe.snapshot.inode === snapshot.inode
      ? checkpoint.baselineRead : undefined;
    let reader = this.baselineReaders.get(filePath);
    if (!reader || reader.sourceGeneration !== owner.sourceGeneration || reader.serialize().targetSize !== limit) {
      reader = new CodexGuardedJsonlReadTask(filePath, snapshot, owner.sourceGeneration, 'baseline',
        restored?.probe.nextCompleteOffset ?? 0, restored?.probe, owner.serialize().anchors, limit);
      this.baselineReaders.set(filePath, reader);
    }
    let activeTurn = restored?.activeTurn ? cloneActiveTurn(restored.activeTurn) : null;
    let ownerSessionMetaOffset = restored?.ownerSessionMetaOffset ??
      (owner.resolution.kind === 'resolved' ? owner.resolution.ownerOffset : null);
    const work = slice ?? this.activeReadSlice ?? this.cycleWorkBudget!.fileSlice(filePath);
    const progress = await reader.step(work, snapshot, line => {
      if (mode === 'fork') return;
      const payload = asRecord(line.record.payload);
      if (!payload) return;
      if (line.record.type === 'session_meta') {
        ownerSessionMetaOffset = selectOwnerSessionMetaOffset(filePath, ownerSessionMetaOffset, line);
        return;
      }
      const turnId = turnIdForStart(line.record, payload);
      if (turnId && (!activeTurn || activeTurn.turnId !== turnId)) {
        activeTurn = createActiveTurn(turnId, line.startOffset, timestampMs(line.record, Date.now()), true);
      }
      if (turnId && activeTurn) { updateActiveTurnMetadata(activeTurn, line.record, payload); return; }
      if (terminalTurnIdFor(line.record, payload) === activeTurn?.turnId) activeTurn = null;
    }, false);
    if (progress.status === 'deferred' || progress.status === 'source-conflict') {
      checkpoint.baselineRead = { mode, probe: reader.serialize(),
        activeTurn: progress.status === 'source-conflict' ? restored?.activeTurn ?? null : activeTurn,
        ownerSessionMetaOffset: progress.status === 'source-conflict' ? restored?.ownerSessionMetaOffset ?? null : ownerSessionMetaOffset };
      this.saveCheckpoint(key, checkpoint);
      return;
    }
    // 原启动水位落在半行内时只取其之前的完整行，不吞掉启动后的补齐字节。
    const candidate = activeTurn as CodexActiveTranscriptTurn | null;
    if (candidate) candidate.startOffset = progress.nextOffset;
    this.baselineReaders.delete(filePath);
    this.normalScanReaders.delete(filePath);
    this.saveCheckpoint(key, { inode: snapshot.inode, scanOffset: progress.nextOffset, startupBaselineTarget: undefined,
      activeTurn: mode === 'fork' ? null : candidate, pendingTerminal: null, pendingFusion: null, pendingSubagent: null,
      ownerSessionMetaOffset, ...(mode === 'fork' ? { forkBootstrap: { state: 'baseline-search' as const, searchOffset: 0 } } : {}) });
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
    if (!value || typeof value.inode !== 'number' || typeof value.scanOffset !== 'number') return null;
    const activeTurn = parseActiveTranscriptTurn(value.activeTurn);
    const pending = asRecord(value.pendingTerminal);
    let pendingTerminal = pending
      && typeof pending.turnId === 'string'
      && typeof pending.terminalEndOffset === 'number'
      ? {
          turnId: pending.turnId,
          terminalEndOffset: pending.terminalEndOffset,
          ...(typeof pending.retryCount === 'number' ? { retryCount: pending.retryCount } : {}),
          ...(typeof pending.firstPendingAtMs === 'number' ? { firstPendingAtMs: pending.firstPendingAtMs } : {}),
          ...(typeof pending.lastAttemptAtMs === 'number' ? { lastAttemptAtMs: pending.lastAttemptAtMs } : {}),
          ...(typeof pending.sourceRecordCount === 'number' ? { sourceRecordCount: pending.sourceRecordCount } : {}),
          ...(typeof pending.nextRetryAtMs === 'number' && Number.isFinite(pending.nextRetryAtMs) ? { nextRetryAtMs: pending.nextRetryAtMs } : {}),
          ...(typeof pending.failureKey === 'string' ? { failureKey: pending.failureKey } : {}),
          ...(Number.isSafeInteger(pending.backoffCount) && Number(pending.backoffCount) >= 0 ? { backoffCount: Number(pending.backoffCount) } : {}),
          ...(parseCodexSourceRef(pending.sourceRef) ? { sourceRef: parseCodexSourceRef(pending.sourceRef) } : {}),
        }
      : null;
    const fusion = asRecord(value.pendingFusion);
    const fusionChildren = parsePendingFusionChildren(fusion?.children);
    const pendingFusion: CodexPendingFusionTurn | null = fusion
      && typeof fusion.turnId === 'string'
      && typeof fusion.parentThreadId === 'string'
      && typeof fusion.parentTraceId === 'string'
      && typeof fusion.terminalEndOffset === 'number'
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
      && typeof subagent.terminalEndOffset === 'number'
      && capturedActiveTurn
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
      && typeof subagent.terminalEndOffset === 'number'
      && activeTurn.turnId === subagent.turnId
    ) {
      // Older pendingSubagent checkpoints blocked the child file and retained
      // the active turn at the top level. They have no reliable spawn identity,
      // so recover them through the normal independent terminal path.
      pendingTerminal ??= newPendingTerminal(subagent.turnId, subagent.terminalEndOffset, 0);
    }
    const deferred = asRecord(value.deferredScan);
    const deferredScan = deferred && Number.isSafeInteger(deferred.endOffset) && Number(deferred.endOffset) >= value.scanOffset
      && (deferred.terminalTurnId === null || typeof deferred.terminalTurnId === 'string')
      && (deferred.ownerSessionMetaOffset === null || typeof deferred.ownerSessionMetaOffset === 'number')
      && ['records', 'parseSuccessRecords', 'parseFailedRecords', 'maxRecordBytes'].every(key => Number.isSafeInteger(deferred[key]) && Number(deferred[key]) >= 0)
      ? { endOffset: Number(deferred.endOffset), terminalTurnId: deferred.terminalTurnId as string | null,
        activeTurn: parseActiveTranscriptTurn(deferred.activeTurn), ownerSessionMetaOffset: deferred.ownerSessionMetaOffset as number | null,
        records: Number(deferred.records), parseSuccessRecords: Number(deferred.parseSuccessRecords),
        parseFailedRecords: Number(deferred.parseFailedRecords), maxRecordBytes: Number(deferred.maxRecordBytes) } : undefined;
    const parsedScanProbe = parseCodexJsonlProbeState(value.scanProbe);
    const scanProbe = parsedScanProbe?.snapshot.inode === value.inode
      && parsedScanProbe.nextCompleteOffset === (deferredScan?.endOffset ?? value.scanOffset) ? parsedScanProbe : undefined;
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
      && typeof bootstrapRecord.searchOffset === 'number'
      && Number.isFinite(bootstrapRecord.searchOffset)
      && bootstrapRecord.searchOffset >= 0
      ? {
          state: bootstrapState,
          searchOffset: bootstrapRecord.searchOffset,
          readProbe: parseCodexJsonlProbeState(bootstrapRecord.readProbe),
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
      pendingFusion,
      pendingSubagent,
      // Do not migrate legacy latestSessionMetaOffset. In forked rollouts that
      // value commonly points at copied parent metadata, so processFile will
      // perform one bounded header scan to recover the owning meta safely.
      ownerSessionMetaOffset: typeof value.ownerSessionMetaOffset === 'number'
        ? value.ownerSessionMetaOffset
        : null,
      ...(forkBootstrap ? { forkBootstrap } : {}),
      ...(typeof value.firstOwnedTurnId === 'string' ? { firstOwnedTurnId: value.firstOwnedTurnId } : {}),
      ownerProbe: parseCodexOwnerProbeState(value.ownerProbe),
      ...(asRecord(value.baselineRead) && ['normal', 'fork'].includes(String(asRecord(value.baselineRead)!.mode))
        && parseCodexJsonlProbeState(asRecord(value.baselineRead)!.probe)
        ? { baselineRead: { mode: asRecord(value.baselineRead)!.mode as 'normal' | 'fork',
          probe: parseCodexJsonlProbeState(asRecord(value.baselineRead)!.probe)!,
          activeTurn: parseActiveTranscriptTurn(asRecord(value.baselineRead)!.activeTurn),
          ownerSessionMetaOffset: typeof asRecord(value.baselineRead)!.ownerSessionMetaOffset === 'number'
            ? asRecord(value.baselineRead)!.ownerSessionMetaOffset as number : null } } : {}),
      ...(deferredScan ? { deferredScan } : {}),
      ...(scanProbe ? { scanProbe } : {}),
      recordReads: Array.isArray(value.recordReads) ? value.recordReads.slice(0, 4).flatMap(state => {
        const parsed = parseCodexRecordReadState(state);
        return parsed ? [parsed] : [];
      }) : [],
      ...(asRecord(value.startupBaselineTarget)
        && typeof asRecord(value.startupBaselineTarget)!.inode === 'number'
        && Number.isSafeInteger(asRecord(value.startupBaselineTarget)!.size)
        && Number(asRecord(value.startupBaselineTarget)!.size) >= 0
        ? { startupBaselineTarget: value.startupBaselineTarget as { inode: number; size: number } } : {}),
    };
  }

  private saveCheckpoint(key: string, checkpoint: CodexTranscriptCheckpoint): void {
    this.saveDelegationState();
    const current = this.stateStore.get(key);
    const filePath = key.slice(this.id.length + 1);
    const ownerProbe = this.ownerProbes.get(filePath)?.serialize() ?? checkpoint.ownerProbe;
    const previous = asRecord(current.extra?.codexTranscript);
    const readStates = new Map((this.clearedRecordReadPaths.has(filePath) ? [] : checkpoint.recordReads ?? [])
      .map(state => [JSON.stringify([state.reason, state.startOffset, state.endOffset]), state]));
    this.clearedRecordReadPaths.delete(filePath);
    for (const task of this.recordReads.values()) if (task.filePath === filePath) {
      readStates.set(JSON.stringify([task.reason, task.startOffset, task.endOffset]), task.serialize());
    }
    const recordReads = [...readStates.values()].filter(state => state.probe.snapshot.inode === checkpoint.inode).slice(-4);
    const persisted = { ...checkpoint, recordReads, ...(ownerProbe ? { ownerProbe } : {}),
      ...(!('startupBaselineTarget' in checkpoint) && previous?.startupBaselineTarget
        ? { startupBaselineTarget: previous.startupBaselineTarget as { inode: number; size: number } } : {}) };
    this.stateStore.update(key, {
      lastOffset: checkpoint.scanOffset,
      extra: {
        ...(current.extra ?? {}),
        codexTranscript: persisted,
      },
    });
  }

  private saveDelegationState(): void {
    const global = this.stateStore.get(this.id);
    this.stateStore.update(this.id, { extra: { ...(global.extra ?? {}),
      codexDelegations: this.subagentLinker.serialize(),
      codexResultInvocations: [...this.deliveredInvocations].slice(-MAX_LINK_DESCRIPTORS),
      codexPendingAgentResults: [...this.pendingAgentResults.values()],
    } });
  }

  private retainPendingAgentResult(
    filePath: string, inode: number, source: CodexTranscriptSourceRecord, context: AgentActivityEntry,
  ): void {
    const key = `${filePath}:${source.startOffset}`;
    if (this.pendingAgentResults.has(key)) return;
    const sha256 = 'sha256' in source && typeof source.sha256 === 'string' ? source.sha256 : undefined;
    this.pendingAgentResults.set(key, { filePath, inode, startOffset: source.startOffset, endOffset: source.endOffset,
      context: codexResultIdentityContext(context),
      ...(sha256 ? { sourceRef: { inode, sourceGeneration: this.ownerProbes.get(filePath)?.sourceGeneration ?? 0,
        startOffset: source.startOffset, endOffset: source.endOffset, sha256 } } : {}) });
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
      if (this.ownerBlockedPaths.has(pending.filePath) || this.forkBlockedPaths.has(pending.filePath)
        || !this.ownerProbes.has(pending.filePath)) { unavailable = true; continue; }
      if (!this.workspacePolicy.allows({ 'gen_ai.session.id': pending.context['gen_ai.session.id'],
        cwd: pending.context['agent.codex.cwd'] }, this.agentType)) {
        this.pendingAgentResults.delete(key);
        changed = true;
        continue;
      }
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try { stat = await fs.stat(pending.filePath); } catch { unavailable = true; continue; }
      if (stat.ino !== pending.inode || stat.size < pending.endOffset
        || !this.ownerProbes.get(pending.filePath)!.readyFor(codexSourceSnapshot(stat))) { unavailable = true; continue; }
      let records: Awaited<ReturnType<CodexTranscriptInput['readRecordRange']>>;
      try {
        records = await this.readRecordRange(pending.filePath, pending.startOffset, pending.endOffset, 'recovery', pending.sourceRef);
      } catch (error) {
        if (!(error instanceof CodexReadPostponed)) throw error;
        unavailable = true;
        continue;
      }
      this.clearRecordReads(pending.filePath);
      if (!pending.sourceRef && records.sourceRef) { pending.sourceRef = records.sourceRef; changed = true; }
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
      if (this.ownerProbes.get(transcriptPath)?.resolution.kind === 'searching') return null;
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
    && (checkpoint.ownerSessionMetaOffset !== null
      || (checkpoint.ownerProbe?.kind === 'absent-at-watermark' && checkpoint.ownerProbe.probe.nextCompleteOffset >= stat.size))
    && checkpoint.ownerProbe?.kind !== 'searching'
    && !checkpoint.ownerProbe?.conflict
    && checkpoint.startupBaselineTarget === undefined
    && checkpoint.baselineRead === undefined
    && checkpoint.deferredScan === undefined
    && !checkpoint.scanProbe?.conflict
    && !checkpoint.recordReads?.some(state => state.probe.conflict)
    && checkpoint.activeTurn === null
    && checkpoint.pendingTerminal === null
    && checkpoint.pendingFusion === null
    && checkpoint.pendingSubagent === null
    && checkpoint.forkBootstrap === undefined;
}

async function collectRolloutFiles(
  dir: string,
  files: string[],
  dirMtimes?: Map<string, number>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (dirMtimes) {
    try {
      dirMtimes.set(dir, (await fs.stat(dir)).mtimeMs);
    } catch {
      return;
    }
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRolloutFiles(entryPath, files, dirMtimes);
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
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
    || typeof active.startOffset !== 'number'
    || typeof active.startedAtMs !== 'number'
  ) return null;
  const model = stringValue(active.model);
  const cwd = stringValue(active.cwd);
  const developerInstructions = stringValue(active.developerInstructions);
  return {
    turnId: active.turnId,
    startOffset: active.startOffset,
    startedAtMs: active.startedAtMs,
    ...(typeof active.nextStepStartedAtMs === 'number'
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
      || typeof child.spawnedAtMs !== 'number'
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
  // builder 把上下文视为不可变值：提交只替换整个引用，不修改旧消息或 delta。
  // 回滚副本仍隔离可变的去重/委派状态，但不重复深拷贝已提交的大消息上下文。
  const { inputContext, ...mutable } = activeTurn;
  return { ...structuredClone(mutable), ...(inputContext ? { inputContext: { ...inputContext } } : {}) };
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

function pendingRetryDelay(retryCount: number): number {
  return Math.min(300_000, 10_000 * 2 ** Math.min(5, Math.max(0, retryCount - 1)));
}

function newPendingTerminal(
  turnId: string,
  terminalEndOffset: number,
  sourceRecordCount: number,
  sourceRef?: CodexTranscriptSourceRef,
): CodexPendingTerminalTurn {
  const now = Date.now();
  return {
    turnId,
    terminalEndOffset,
    retryCount: 1,
    firstPendingAtMs: now,
    lastAttemptAtMs: now,
    nextRetryAtMs: now + pendingRetryDelay(1),
    backoffCount: 1,
    ...(sourceRef ? { sourceRef } : {}),
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
