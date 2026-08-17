import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent, FSWatcher } from 'node:fs';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue, MultimodalUploadMode } from '../../types/index.js';
import { isReservedKey } from '../../normalization/global-attributes.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import {
  buildCodexTranscriptSegment,
  nextInputMessagesForStep,
} from './codex-transcript-builder.js';
import {
  CodexSubagentLinker,
  extractCodexSpawnDescriptors,
  MAX_LINK_DESCRIPTORS,
  type CodexSubagentLink,
  type CodexSubagentLinkSnapshot,
} from './codex-subagent-linker.js';
import {
  extractCodexPartialTurn,
  extractCodexPartialTurnWithBoundaries,
  extractCodexTranscriptMeta,
  sessionIdFromTranscriptPath,
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
} from './codex-transcript-types.js';
import { stringValue, timestampMs } from './codex-transcript-utils.js';

type ReliableCodexSubagentLink = CodexSubagentLink & {
  parentTurnId: string;
  parentTraceId: string;
  parentToolCallId: string;
  confidence: 'explicit_id' | 'agent_path';
};

const DEFAULT_SESSION_DIR = '~/.codex/sessions';
const READ_CHUNK_SIZE = 1024 * 1024;
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
const WAKEUP_MARKER_DISCOVERY_TTL_MS = 48 * 60 * 60 * 1_000;
const WAKEUP_MARKER_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const SPAN_CONTEXT_TTL_MS = 48 * 60 * 60 * 1_000;
const SPAN_CONTEXT_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const DYNAMIC_SESSION_FILE_MAX_IDLE_MS = 15 * 60 * 1_000;
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

interface JsonLine {
  startOffset: number;
  endOffset: number;
  record: Record<string, unknown>;
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

interface DynamicDirectoryWalkBudget {
  remainingDirectories: number;
  remainingRolloutFiles: number;
}

interface CodexWakeupMarker {
  initialTurnId?: string;
  recoveryTurnId?: string;
  hookEvent?: string;
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
  private lastWakeupMarkerCleanupAtMs = 0;
  private lastSpanContextCleanupAtMs = 0;
  private readonly transcriptMetaByPath = new Map<string, ReturnType<typeof extractCodexTranscriptMeta>>();
  private readonly transcriptPathByThreadId = new Map<string, string>();

  constructor(opts: CodexTranscriptInputOptions) {
    const processor = opts.multimodal?.processor ?? null;
    const includeMultimodal = opts.multimodal?.enabled === true && !!processor;
    super({
      stateStore: opts.stateStore,
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.sessionDir = opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR);
    this.wakeupDir = opts.wakeupDir ?? defaultWakeupDir();
    this.spanContextDir = opts.spanContextDir ?? defaultSpanContextDir();
    this.includeMultimodal = includeMultimodal;
    this.multimodalUploadMode = opts.multimodal?.uploadMode ?? 'none';
    this.multimodalProcessor = includeMultimodal ? processor : null;
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  protected override async onStart(): Promise<void> {
    this.discardLegacyGlobalTurnRegistry();
    const discovered = await this.discoverSessionFiles();
    await this.indexDiscoveredTranscriptOwners(discovered);
    for (const { filePath, baselineOnStart } of discovered) {
      const key = this.stateKey(filePath);
      const meta = this.transcriptMetaByPath.get(filePath);
      const neededByPendingFusion = meta?.depth === 1
        && meta.parentThreadId !== undefined
        && this.hasPendingFusionForParent(meta.parentThreadId);
      if (baselineOnStart && !neededByPendingFusion && !this.readCheckpoint(key)) {
        const hasCopiedPrefix = hasCopiedHistoryPrefix(meta);
        if (hasCopiedPrefix) {
          await this.parkForkBaseline(filePath, key);
        } else {
          await this.baselineFile(filePath, key);
        }
      }
    }
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
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    await this.cleanupExpiredSpanContexts(Date.now());
    let emittedCount = 0;
    const discovered = await this.discoverSessionFiles();
    await this.indexDiscoveredTranscriptOwners(discovered);
    discovered.sort((left, right) => {
      const leftDepth = this.transcriptMetaByPath.get(left.filePath)?.depth ?? 0;
      const rightDepth = this.transcriptMetaByPath.get(right.filePath)?.depth ?? 0;
      return leftDepth - rightDepth || left.filePath.localeCompare(right.filePath);
    });
    for (const { filePath } of discovered) {
      emittedCount += await this.processFile(filePath);
    }
    emittedCount += await this.finalizeReadySubagentFusions();
    this.reportSubagentLinks();
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
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return 0;
    }
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

    if (checkpoint.ownerSessionMetaOffset === null) {
      checkpoint.ownerSessionMetaOffset = await findOwnerSessionMetaOffset(filePath, stat.size);
      checkpointChanged = true;
    }
    await this.registerSubagentOwnerMeta(filePath, checkpoint.ownerSessionMetaOffset);

    const ownerMeta = this.transcriptMetaByPath.get(filePath) ?? null;
    const isDirectSubagent = ownerMeta?.threadSource === 'subagent' && ownerMeta.depth === 1;
    if (ownerMeta?.depth === 0) this.registerPersistedSubagentSpawns(checkpoint, ownerMeta.threadId);

    const hasCopiedPrefix = hasCopiedHistoryPrefix(ownerMeta);
    if (
      hasCopiedPrefix
      && checkpoint.activeTurn === null
      && checkpoint.pendingTerminal === null
    ) {
      const prepared = await this.prepareCopiedTranscript(filePath, stat.size, ownerMeta!, checkpoint);
      checkpointChanged ||= prepared.changed;
      if (!prepared.ready) {
        this.saveCheckpoint(key, checkpoint);
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
    if (isDirectSubagent && ownerMeta && checkpoint.pendingSubagent) {
      const candidate = this.reliableCandidateForChild(ownerMeta);
      if (
        !candidate
        || candidate.parentThreadId !== checkpoint.pendingSubagent.parentThreadId
        || candidate.parentTurnId !== checkpoint.pendingSubagent.parentTurnId
        || candidate.parentTraceId !== checkpoint.pendingSubagent.parentTraceId
        || candidate.parentToolCallId !== checkpoint.pendingSubagent.parentToolCallId
      ) {
        const released = await this.releaseCapturedSubagentIndependently(filePath, checkpoint);
        emittedCount += released.emittedCount;
        processedTerminalCount += released.processedTerminalCount;
        checkpointChanged = true;
      }
    }
    if (checkpoint.pendingFusion) {
      const reliableChildren = this.reliableFusionChildren(
        checkpoint.pendingFusion.parentThreadId,
        checkpoint.pendingFusion.turnId,
        checkpoint.pendingFusion.children,
      );
      if (reliableChildren.length !== checkpoint.pendingFusion.children.length) {
        checkpoint.pendingFusion.children = reliableChildren;
        if (checkpoint.activeTurn) checkpoint.activeTurn.subagentSpawns = reliableChildren;
        checkpointChanged = true;
      }
    }
    if (checkpoint.pendingFusion?.children.length === 0) {
      const released = await this.releaseParentFusionIndependently(filePath, checkpoint);
      emittedCount += released.emittedCount;
      processedTerminalCount += released.processedTerminalCount;
      checkpointChanged = true;
    }
    if (checkpoint.pendingFusion) {
      if (checkpointChanged) this.saveCheckpoint(key, checkpoint);
      return emittedCount;
    }

    let scannedBytes = 0;

    const hadPendingTerminal = checkpoint.pendingTerminal !== null;
    const pendingResult = await this.recoverPendingTerminal(filePath, checkpoint);
    checkpointChanged ||= hadPendingTerminal;
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
      const scanStartOffset = checkpoint.scanOffset;
      const scanEndOffset = Math.min(
        stat.size,
        scanStartOffset + (MAX_SCAN_BYTES_PER_FILE_CYCLE - scannedBytes),
      );
      let terminalTurnId: string | null = null;
      let terminalEndOffset: number | null = null;
      const processScannedLine = (line: JsonLine): void | false => {
        const payload = asRecord(line.record.payload);
        if (!payload) return;
        if (line.record.type === 'session_meta') {
          checkpoint.ownerSessionMetaOffset = selectOwnerSessionMetaOffset(
            filePath,
            checkpoint.ownerSessionMetaOffset,
            line,
          );
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
      let scan = await scanJsonLines(filePath, scanStartOffset, scanEndOffset, processScannedLine);

      // A single JSONL record may exceed the byte budget. Read far enough to
      // consume one complete line so this file can make forward progress.
      if (scan.nextOffset === scanStartOffset && scanEndOffset < stat.size) {
        scan = await scanJsonLines(filePath, scanStartOffset, stat.size, line => {
          processScannedLine(line);
          return false;
        });
      }
      if (scan.nextOffset === scanStartOffset) break;
      checkpointChanged = true;

      const nextScanOffset = terminalEndOffset ?? scan.nextOffset;
      scannedBytes += nextScanOffset - scanStartOffset;
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
            processedTerminalCount++;
            checkpoint.scanOffset = nextScanOffset;
            continue;
          }

          const activeBeforeRecovery = terminalTurnId
            ? cloneActiveTurn(checkpoint.activeTurn)
            : null;
          const reliableCandidate = isDirectSubagent
            && ownerMeta
            && !checkpoint.pendingSubagent
            ? this.reliableCandidateForChild(ownerMeta)
            : undefined;
          // A reliably linked child must not emit an independent partial trace
          // before the parent reaches task_complete. Recover on a clone so the
          // persisted child snapshot keeps the complete turn range and empty
          // emission registry for terminal capture or forced finalization.
          const recoveryCheckpoint = reliableCandidate
            ? {
                ...checkpoint,
                activeTurn: cloneActiveTurn(checkpoint.activeTurn),
              }
            : checkpoint;
          const recovered = await this.recoverTurnSegment(
            filePath,
            recoveryCheckpoint,
            nextScanOffset,
            terminalTurnId !== null,
          );
          if (
            terminalTurnId
            && activeBeforeRecovery
            && recovered.kind !== 'unparseable'
            && reliableCandidate
          ) {
            checkpoint.pendingSubagent = {
              turnId: terminalTurnId,
              parentThreadId: reliableCandidate.parentThreadId,
              parentTurnId: reliableCandidate.parentTurnId,
              parentTraceId: reliableCandidate.parentTraceId,
              parentToolCallId: reliableCandidate.parentToolCallId,
              confidence: reliableCandidate.confidence,
              terminalEndOffset: nextScanOffset,
              activeTurn: activeBeforeRecovery,
            };
            // The terminal range is consumed but deliberately not marked as
            // emitted. The persisted snapshot is the sole owner until fusion.
            checkpoint.activeTurn = null;
            checkpoint.scanOffset = nextScanOffset;
            processedTerminalCount++;
            continue;
          }
          const fusionParentThreadId = ownerMeta?.threadId ?? sessionIdFromTranscriptPath(filePath);
          const fusionChildren = terminalTurnId
            ? this.reliableFusionChildren(
                fusionParentThreadId,
                terminalTurnId,
                checkpoint.activeTurn?.subagentSpawns ?? [],
              )
            : [];
          if (
            terminalTurnId
            && recovered.kind !== 'unparseable'
            && fusionChildren.length > 0
            && activeBeforeRecovery
            // A root rollout can contain many completed historical turns. Only
            // the terminal at the current file tail may still be waiting for
            // its children. Gating an earlier terminal lets later children be
            // consumed by that stale turn's time-order fallback.
            && nextScanOffset >= stat.size
          ) {
            activeBeforeRecovery.subagentSpawns = fusionChildren;
            checkpoint.activeTurn = activeBeforeRecovery;
            checkpoint.pendingFusion = {
              turnId: terminalTurnId,
              parentThreadId: fusionParentThreadId,
              parentTraceId: parentTraceIdForChildren(fusionChildren),
              terminalEndOffset: nextScanOffset,
              children: fusionChildren,
            };
            blocked = true;
          } else if (!reliableCandidate) {
            emittedCount += this.emitEntryBatches(recovered.entries);
          }
          if (
            recovered.kind !== 'unparseable'
            && !checkpoint.pendingFusion
            && !reliableCandidate
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
              );
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
              processedTerminalCount++;
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
    const recovered = await this.recoverTurnSegment(filePath, checkpoint, pending.terminalEndOffset, true);
    if (recovered.kind === 'unparseable') {
      const now = Date.now();
      checkpoint.pendingTerminal = {
        ...pending,
        retryCount: (pending.retryCount ?? 0) + 1,
        firstPendingAtMs: pending.firstPendingAtMs ?? now,
        lastAttemptAtMs: now,
        sourceRecordCount: recovered.diagnostics.sourceRecordCount,
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
    const records = await readJsonLines(filePath, activeTurn.startOffset, endOffset);
    const metaRecord = checkpoint.ownerSessionMetaOffset === null
      ? null
      : await readJsonLineAt(filePath, checkpoint.ownerSessionMetaOffset);
    const meta = metaRecord ? extractCodexTranscriptMeta(metaRecord) : null;
    const extraction = extractCodexPartialTurnWithBoundaries(
      records.items,
      meta,
      sessionIdFromTranscriptPath(filePath),
      activeTurn.turnId,
      this.partialTurnOptions(activeTurn, filePath),
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
    const inputContext = await this.resolveInputContext(filePath, activeTurn, meta);
    const built = buildCodexTranscriptSegment(committedTurn, {
      includePrompt: activeTurn.emittedPrompt !== true,
      startStepNumber: stepStart,
      ...(inputContext ? { inputContext } : {}),
      contextStepCount: committedTurn.steps.length,
    });
    if (meta?.depth === 0) {
      const parentTraceId = stringValue(built.entries[0]?.trace_id);
      if (parentTraceId) {
        const spawns = extractCodexSpawnDescriptors(turn, records.items, parentTraceId);
        this.subagentLinker.registerSpawns(spawns);
        const fusionChildren = spawns.map(spawn => ({
          parentToolCallId: spawn.parentToolCallId,
          parentTraceId: spawn.parentTraceId,
          spawnedAtMs: spawn.spawnedAtMs,
          ...(spawn.taskName ? { taskName: spawn.taskName } : {}),
          ...(spawn.agentPath ? { agentPath: spawn.agentPath } : {}),
          ...(spawn.childThreadId ? { childThreadId: spawn.childThreadId } : {}),
        }));
        activeTurn.subagentSpawns = mergePendingFusionChildren(
          activeTurn.subagentSpawns ?? [],
          fusionChildren,
        );
      }
    }
    // A Codex model wave may finish with `stop` and then resume in the same
    // transcript turn (for example after a subagent completion notification or
    // a failed spawn retry). Emit a distinct lifecycle marker only after the
    // authoritative task_complete / turn_aborted boundary. This also closes a
    // turn whose final LLM response was already emitted in an earlier poll.
    const readyEntries = terminal && built.entries.length > 0
      ? [...built.entries, codexTurnEndMarker(built.entries, turn.status)]
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
  ): Promise<CodexTranscriptInputContext | undefined> {
    const context = activeTurn.inputContext;
    if (!context || context.delta) return context;
    const range = context.deltaRange;
    if (!range) return context;

    const records = await readJsonLines(filePath, range.startOffset, range.endOffset);
    const previous = extractCodexPartialTurn(
      records.items.map(item => item.record),
      meta,
      sessionIdFromTranscriptPath(filePath),
      activeTurn.turnId,
      this.partialTurnOptions(activeTurn, filePath),
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
    ownerSessionMetaOffset: number | null,
  ): Promise<void> {
    if (ownerSessionMetaOffset === null) return;
    const threadId = sessionIdFromTranscriptPath(filePath);
    if (this.subagentLinker.hasThread(threadId)) return;
    const record = await readJsonLineAt(filePath, ownerSessionMetaOffset);
    const meta = record ? extractCodexTranscriptMeta(record) : null;
    if (meta) {
      this.transcriptMetaByPath.set(filePath, meta);
      this.transcriptPathByThreadId.set(meta.threadId, filePath);
      this.subagentLinker.registerChild(meta);
    }
  }

  private async indexDiscoveredTranscriptOwners(files: DiscoveredSessionFile[]): Promise<void> {
    this.transcriptMetaByPath.clear();
    this.transcriptPathByThreadId.clear();
    for (const { filePath } of files) {
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }
      const checkpoint = this.readCheckpoint(this.stateKey(filePath));
      const ownerOffset = checkpoint?.inode === stat.ino
        ? checkpoint.ownerSessionMetaOffset ?? await findOwnerSessionMetaOffset(filePath, stat.size)
        : await findOwnerSessionMetaOffset(filePath, stat.size);
      if (ownerOffset === null) continue;
      const record = await readJsonLineAt(filePath, ownerOffset);
      const meta = record ? extractCodexTranscriptMeta(record) : null;
      if (!meta) continue;
      this.transcriptMetaByPath.set(filePath, meta);
      this.transcriptPathByThreadId.set(meta.threadId, filePath);
      this.subagentLinker.registerChild(meta);
    }
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

  private hasPendingFusionForParent(parentThreadId: string): boolean {
    for (const key of this.stateStore.keys()) {
      if (!key.startsWith(`${this.id}:`)) continue;
      const checkpoint = this.readCheckpoint(key);
      if (checkpoint?.pendingFusion?.parentThreadId === parentThreadId) return true;
    }
    return false;
  }

  private reliableCandidateForChild(
    meta: CodexTranscriptMeta,
  ): ReliableCodexSubagentLink | undefined {
    if (!meta.parentThreadId) return undefined;
    const link = this.subagentLinker.snapshot().links.find(candidate => (
      candidate.childThreadId === meta.threadId
      && candidate.parentThreadId === meta.parentThreadId
      && candidate.parentTurnId !== undefined
      && candidate.parentTraceId !== undefined
      && candidate.parentToolCallId !== undefined
      && isReliableFusionConfidence(candidate.confidence)
    ));
    if (
      !link
      || !link.parentTurnId
      || !link.parentTraceId
      || !link.parentToolCallId
      || !isReliableFusionConfidence(link.confidence)
    ) return undefined;
    for (const [filePath, parentMeta] of this.transcriptMetaByPath) {
      if (parentMeta?.threadId !== link.parentThreadId || parentMeta.depth !== 0) continue;
      const checkpoint = this.readCheckpoint(this.stateKey(filePath));
      const parentTurnId = checkpoint?.pendingFusion?.turnId ?? checkpoint?.activeTurn?.turnId;
      const spawns = checkpoint?.pendingFusion?.children ?? checkpoint?.activeTurn?.subagentSpawns ?? [];
      if (
        parentTurnId === link.parentTurnId
        && spawns.some(spawn => spawn.parentToolCallId === link.parentToolCallId)
      ) {
        return {
          ...link,
          parentTurnId: link.parentTurnId,
          parentTraceId: link.parentTraceId,
          parentToolCallId: link.parentToolCallId,
          confidence: link.confidence,
        };
      }
    }
    return undefined;
  }

  private reliableFusionChildren(
    parentThreadId: string,
    parentTurnId: string,
    children: CodexPendingFusionChild[],
  ): CodexPendingFusionChild[] {
    const links = this.subagentLinker.snapshot().links;
    const reliable: CodexPendingFusionChild[] = [];
    for (const child of children) {
      const matches = links.filter(link => (
        link.parentThreadId === parentThreadId
        && link.parentTurnId === parentTurnId
        && link.parentToolCallId === child.parentToolCallId
        && isReliableFusionConfidence(link.confidence)
      ));
      if (matches.length !== 1) continue;
      const link = matches[0]!;
      const childPath = this.transcriptPathByThreadId.get(link.childThreadId);
      const checkpoint = childPath ? this.readCheckpoint(this.stateKey(childPath)) : null;
      const captured = checkpoint?.pendingSubagent;
      if (captured && captured.parentToolCallId !== child.parentToolCallId) continue;
      if (
        checkpoint
        && !captured
        && isChildCollectionSettled(checkpoint)
      ) continue;
      reliable.push({ ...child, childThreadId: link.childThreadId });
    }
    return reliable;
  }

  private async releaseParentFusionIndependently(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
  ): Promise<{ emittedCount: number; processedTerminalCount: number }> {
    const pending = checkpoint.pendingFusion;
    if (!pending) return { emittedCount: 0, processedTerminalCount: 0 };

    checkpoint.scanOffset = Math.max(checkpoint.scanOffset, pending.terminalEndOffset);
    checkpoint.pendingFusion = null;
    this.logger.warn('Codex parent fusion has no reliable child candidates; emitting independently', {
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

  private async finalizeReadySubagentFusions(): Promise<number> {
    let emittedCount = 0;
    for (const [parentPath, meta] of this.transcriptMetaByPath) {
      if (!meta || meta.depth !== 0) continue;
      const parentKey = this.stateKey(parentPath);
      const parentCheckpoint = this.readCheckpoint(parentKey);
      const pending = parentCheckpoint?.pendingFusion;
      if (!parentCheckpoint || !pending || !parentCheckpoint.activeTurn) continue;

      const resolved = pending.children.map(child => {
        const childThreadId = child.childThreadId;
        const childPath = childThreadId ? this.transcriptPathByThreadId.get(childThreadId) : undefined;
        const childCheckpoint = childPath ? this.readCheckpoint(this.stateKey(childPath)) : null;
        const captured = childCheckpoint?.pendingSubagent;
        return { child, childThreadId, childPath, childCheckpoint, captured };
      });

      const childOutputs: Array<{
        entries: AgentActivityEntry[];
        path: string;
        checkpoint: CodexTranscriptCheckpoint;
        turnId: string;
        parentToolCallId: string;
        source: 'captured-terminal' | 'forced-parent-terminal';
      }> = [];
      const degradedToolCallIds: string[] = [];
      for (const item of resolved) {
        const childCheckpoint = item.childCheckpoint;
        const childPath = item.childPath;
        const childThreadId = item.childThreadId;
        if (!childCheckpoint || !childPath || !childThreadId) {
          degradedToolCallIds.push(item.child.parentToolCallId);
          continue;
        }
        const captured = item.captured;
        const capturedMatches = captured
          && captured.parentThreadId === pending.parentThreadId
          && captured.parentTurnId === pending.turnId
          && captured.parentTraceId === pending.parentTraceId
          && captured.parentToolCallId === item.child.parentToolCallId;
        const canForceActive = !captured
          && childCheckpoint.activeTurn !== null
          && !hasEmittedActiveTurnState(childCheckpoint.activeTurn)
          && childCheckpoint.scanOffset > childCheckpoint.activeTurn.startOffset;
        if (!capturedMatches && !canForceActive) {
          degradedToolCallIds.push(item.child.parentToolCallId);
          continue;
        }

        const activeSnapshot = capturedMatches
          ? captured.activeTurn
          : childCheckpoint.activeTurn!;
        const terminalEndOffset = capturedMatches
          ? captured.terminalEndOffset
          : childCheckpoint.scanOffset;
        const recoveryCheckpoint: CodexTranscriptCheckpoint = {
          ...childCheckpoint,
          activeTurn: cloneActiveTurn(activeSnapshot),
          pendingSubagent: null,
        };
        const recovered = await this.recoverTurnSegment(
          childPath,
          recoveryCheckpoint,
          terminalEndOffset,
          true,
          capturedMatches ? undefined : 'interrupted',
        );
        if (recovered.kind === 'unparseable') {
          degradedToolCallIds.push(item.child.parentToolCallId);
          continue;
        }
        childOutputs.push({
          entries: rewriteSubagentEntries(recovered.entries, {
            parentThreadId: pending.parentThreadId,
            parentTurnId: pending.turnId,
            parentTraceId: pending.parentTraceId,
            parentToolCallId: item.child.parentToolCallId,
            childThreadId,
            agentName: this.transcriptMetaByPath.get(childPath)?.agentNickname
              ?? item.child.agentPath
              ?? item.child.taskName,
          }),
          path: childPath,
          checkpoint: childCheckpoint,
          turnId: activeSnapshot.turnId,
          parentToolCallId: item.child.parentToolCallId,
          source: capturedMatches ? 'captured-terminal' : 'forced-parent-terminal',
        });
      }

      const parentRecovered = await this.recoverTurnSegment(
        parentPath,
        parentCheckpoint,
        pending.terminalEndOffset,
        true,
      );
      if (parentRecovered.kind === 'unparseable') continue;

      if (degradedToolCallIds.length > 0) {
        this.logger.warn('Codex parent reached task_complete before every child could be rebuilt; degrading missing children', {
          transcriptPath: parentPath,
          turnId: pending.turnId,
          parentToolCallIds: degradedToolCallIds,
        });
      }

      for (const output of childOutputs) {
        emittedCount += this.emitEntryBatches(output.entries);
        if (
          output.source === 'captured-terminal'
          && output.checkpoint.pendingSubagent?.parentToolCallId === output.parentToolCallId
        ) {
          output.checkpoint.pendingSubagent = null;
        } else if (
          output.source === 'forced-parent-terminal'
          && output.checkpoint.activeTurn?.turnId === output.turnId
        ) {
          output.checkpoint.activeTurn = null;
          output.checkpoint.pendingTerminal = null;
        }
        this.saveCheckpoint(this.stateKey(output.path), output.checkpoint);
      }
      emittedCount += this.emitEntryBatches(parentRecovered.entries);
      parentCheckpoint.activeTurn = null;
      parentCheckpoint.pendingFusion = null;
      this.saveCheckpoint(parentKey, parentCheckpoint);
    }
    return emittedCount;
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

    for (const entry of entries) {
      const eventName = entry['event.name'];
      if (eventName === 'other') {
        if (entry['gen_ai.turn.end'] === true) {
          out.push(entry);
          continue;
        }
        if (activeTurn.emittedPrompt) continue;
        activeTurn.emittedPrompt = true;
        out.push(entry);
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
      return { ready: rebuilt, changed: true };
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

    const located = await findTurnStartOffset(
      filePath,
      ownerMeta.threadId,
      bootstrap.initialTurnId,
      bootstrap.recoveryTurnId,
      bootstrap.searchOffset,
      fileSize,
    );
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
      return { ready: false, changed: true };
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
      return { ready: rebuilt, changed: true };
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
    const scanOffset = await lastCompleteJsonlOffset(filePath, stat.size);
    const ownerSessionMetaOffset = await findOwnerSessionMetaOffset(filePath, scanOffset);
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

    let scan = await scanJsonLines(filePath, searchOffset, scanEnd, processLine);
    if (scan.nextOffset === searchOffset && scanEnd < baselineEnd) {
      scan = await scanJsonLines(filePath, searchOffset, baselineEnd, line => {
        processLine(line);
        return false;
      });
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
    const { nextOffset } = await scanJsonLines(filePath, 0, stat.size, line => {
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
    });
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
    const defaultFiles: string[] = [];
    await collectRolloutFiles(this.sessionDir, defaultFiles);
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
    const markerEntries = allMarkerEntries
      // Marker names are Codex UUIDv7 session IDs, so descending lexical order
      // keeps the newest task markers inside the bounded discovery window.
      .sort((left, right) => right.name.localeCompare(left.name))
      .slice(0, MAX_WAKEUP_MARKERS_FOR_DISCOVERY);
    const sessionDirs = new Set<string>();

    for (const entry of markerEntries) {
      let marker: Record<string, unknown> | null = null;
      try {
        marker = asRecord(JSON.parse(await fs.readFile(path.join(this.wakeupDir, entry.name), 'utf8')));
      } catch {
        continue;
      }
      if (!marker) continue;

      const receivedAt = stringValue(marker.received_at);
      const receivedAtMs = receivedAt ? Date.parse(receivedAt) : Number.NaN;
      if (!Number.isFinite(receivedAtMs) || now - receivedAtMs > WAKEUP_MARKER_DISCOVERY_TTL_MS) continue;

      const configuredSessionDir = stringValue(marker.session_dir);
      const configuredCodexHome = stringValue(marker.codex_home);
      if (configuredSessionDir && !path.isAbsolute(configuredSessionDir)) continue;
      if (configuredCodexHome && !path.isAbsolute(configuredCodexHome)) continue;

      let sessionDir = configuredSessionDir;
      if (configuredCodexHome) {
        const codexHomeSessionDir = path.resolve(configuredCodexHome, 'sessions');
        if (configuredSessionDir && path.resolve(configuredSessionDir) !== codexHomeSessionDir) continue;
        sessionDir = codexHomeSessionDir;
      }
      if (!sessionDir || !path.isAbsolute(sessionDir)) continue;

      let canonicalSessionDir: string;
      try {
        canonicalSessionDir = await fs.realpath(sessionDir);
        if (!(await fs.stat(canonicalSessionDir)).isDirectory()) continue;
      } catch {
        continue;
      }
      if (canonicalSessionDir === canonicalDefaultSessionDir) continue;
      sessionDirs.add(canonicalSessionDir);
      if (sessionDirs.size >= MAX_DYNAMIC_SESSION_DIRS) break;
    }

    return [...sessionDirs];
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
    };
  }

  private saveCheckpoint(key: string, checkpoint: CodexTranscriptCheckpoint): void {
    const current = this.stateStore.get(key);
    this.stateStore.update(key, {
      lastOffset: checkpoint.scanOffset,
      extra: {
        ...(current.extra ?? {}),
        codexTranscript: checkpoint,
      },
    });
  }

  private discardLegacyGlobalTurnRegistry(): void {
    const current = this.stateStore.get(this.id);
    if (!current.extra || !('codexTranscriptGlobal' in current.extra)) return;
    const { codexTranscriptGlobal: _discarded, ...extra } = current.extra;
    this.stateStore.set(this.id, { ...current, extra });
  }

  private partialTurnOptions(activeTurn: CodexActiveTranscriptTurn, filePath: string): {
    startedAtMs?: number;
    model?: string;
    cwd?: string;
    developerInstructions?: string;
    blobToUri?: BlobToUriFn;
    uploadMode?: MultimodalUploadMode;
  } {
    return {
      startedAtMs: activeTurn.startedAtMs,
      ...(this.includeMultimodal && this.multimodalProcessor
        ? { blobToUri: this.blobToUri(filePath), uploadMode: this.multimodalUploadMode }
        : {}),
      ...(activeTurn.model ? { model: activeTurn.model } : {}),
      ...(activeTurn.cwd ? { cwd: activeTurn.cwd } : {}),
      ...(activeTurn.developerInstructions
        ? { developerInstructions: activeTurn.developerInstructions }
        : {}),
    };
  }

  /** blob→uri with per-transcript replay cache. */
  private blobToUri(transcriptPath: string): BlobToUriFn {
    return (params) => {
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

async function collectRolloutFiles(dir: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRolloutFiles(entryPath, files);
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

async function canonicalDirectoryPath(directoryPath: string): Promise<string> {
  try {
    return await fs.realpath(directoryPath);
  } catch {
    return path.resolve(directoryPath);
  }
}

async function readJsonLines(filePath: string, startOffset: number, endOffset: number): Promise<{
  items: JsonLine[];
  nextOffset: number;
}> {
  if (endOffset <= startOffset) return { items: [], nextOffset: startOffset };
  const items: JsonLine[] = [];
  const { nextOffset } = await scanJsonLines(filePath, startOffset, endOffset, line => {
    items.push(line);
  });
  return { items, nextOffset };
}

async function lastCompleteJsonlOffset(filePath: string, fileSize: number): Promise<number> {
  if (fileSize <= 0) return 0;
  const handle = await fs.open(filePath, 'r');
  try {
    const lastByte = Buffer.alloc(1);
    if ((await handle.read(lastByte, 0, 1, fileSize - 1)).bytesRead === 1 && lastByte[0] === 0x0a) {
      return fileSize;
    }
    let position = fileSize;
    while (position > 0) {
      const length = Math.min(READ_CHUNK_SIZE, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
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
): Promise<{ nextOffset: number }> {
  if (endOffset <= startOffset) return { nextOffset: startOffset };
  const handle = await fs.open(filePath, 'r');
  try {
    let nextOffset = startOffset;
    let position = startOffset;
    let pending = Buffer.alloc(0);
    let pendingStartOffset = startOffset;

    while (position < endOffset) {
      const length = Math.min(READ_CHUNK_SIZE, endOffset - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;

      const data = pending.length > 0
        ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      const dataStartOffset = pendingStartOffset;
      let cursor = 0;
      while (cursor < data.length) {
        const newline = data.indexOf(0x0a, cursor);
        if (newline < 0) break;
        const text = data.subarray(cursor, newline).toString('utf8').trim();
        if (text) {
          try {
            const record = JSON.parse(text);
            if (record && typeof record === 'object' && !Array.isArray(record)) {
              const keepGoing = await onLine({
                startOffset: dataStartOffset + cursor,
                endOffset: dataStartOffset + newline + 1,
                record,
              });
              if (keepGoing === false) {
                nextOffset = dataStartOffset + newline + 1;
                return { nextOffset };
              }
            }
          } catch {
            // Invalid completed lines are ignored but their bytes are consumed.
          }
        }
        nextOffset = dataStartOffset + newline + 1;
        cursor = newline + 1;
      }

      pending = cursor < data.length ? Buffer.from(data.subarray(cursor)) : Buffer.alloc(0);
      pendingStartOffset = dataStartOffset + cursor;
    }

    return { nextOffset };
  } finally {
    await handle.close();
  }
}

async function findOwnerSessionMetaOffset(
  filePath: string,
  endOffset: number,
): Promise<number | null> {
  let ownerOffset: number | null = null;
  let sawSessionMeta = false;
  await scanJsonLines(filePath, 0, endOffset, line => {
    if (line.record.type !== 'session_meta') {
      // Codex writes the owning meta and any copied fork metadata as a header.
      // Stop before scanning the potentially large inherited conversation.
      return sawSessionMeta ? false : undefined;
    }
    sawSessionMeta = true;
    ownerOffset = selectOwnerSessionMetaOffset(filePath, ownerOffset, line);
    return undefined;
  });
  return ownerOffset;
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
): Promise<{
  startOffset: number | null;
  nextOffset: number;
  turnId?: string;
  anchorKind?: ForkAnchorKind;
}> {
  let turnStartOffset: number | null = null;
  let matchedTurnId: string | undefined;
  let anchorKind: ForkAnchorKind | undefined;
  const safeStart = boundedSearchOffset(startOffset, fileSize);
  const scanEnd = Math.min(fileSize, safeStart + MAX_SCAN_BYTES_PER_FILE_CYCLE);
  const ownerTimestamp = uuidV7TimestampMs(ownerThreadId);
  const { nextOffset } = await scanJsonLines(filePath, safeStart, scanEnd, line => {
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
  });
  return {
    startOffset: turnStartOffset,
    nextOffset,
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

async function readJsonLineAt(filePath: string, offset: number): Promise<Record<string, unknown> | null> {
  const handle = await fs.open(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let position = offset;
    for (let attempt = 0; attempt < 16; attempt++) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
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
    subagentSpawns: parsePendingFusionChildren(active.subagentSpawns),
  };
}

function isReliableFusionConfidence(
  confidence: CodexSubagentLink['confidence'],
): confidence is 'explicit_id' | 'agent_path' {
  return confidence === 'explicit_id' || confidence === 'agent_path';
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

function mergePendingFusionChildren(
  current: CodexPendingFusionChild[],
  incoming: CodexPendingFusionChild[],
): CodexPendingFusionChild[] {
  const merged = new Map(current.map(child => [child.parentToolCallId, child]));
  for (const child of incoming) {
    merged.set(child.parentToolCallId, { ...merged.get(child.parentToolCallId), ...child });
  }
  return [...merged.values()];
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

/** Child completion is derived from the existing scan state, not a second lifecycle flag. */
function isChildCollectionSettled(checkpoint: CodexTranscriptCheckpoint): boolean {
  return checkpoint.scanOffset > 0
    && checkpoint.forkBootstrap === undefined
    && checkpoint.activeTurn === null
    && checkpoint.pendingTerminal === null
    && checkpoint.pendingSubagent === null;
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

function hasEmittedActiveTurnState(activeTurn: CodexActiveTranscriptTurn): boolean {
  return activeTurn.emittedPrompt === true
    || (activeTurn.emittedStepCount ?? 0) > 0
    || (activeTurn.emittedStepRequestIds?.length ?? 0) > 0
    || (activeTurn.emittedStepResponseIds?.length ?? 0) > 0
    || (activeTurn.emittedToolCallIds?.length ?? 0) > 0
    || (activeTurn.emittedToolResultIds?.length ?? 0) > 0;
}

function parentTraceIdForChildren(children: CodexPendingFusionChild[]): string {
  return children[0]?.parentTraceId ?? '';
}

function rewriteSubagentEntries(
  entries: AgentActivityEntry[],
  context: {
    parentThreadId: string;
    parentTurnId: string;
    parentTraceId: string;
    parentToolCallId: string;
    childThreadId: string;
    agentName?: string;
  },
): AgentActivityEntry[] {
  const parentTurnId = `${context.parentThreadId}:${context.parentTurnId}`;
  // The converter consumes every `other` record as a turn-level ENTRY input
  // before it partitions subagent records. Keep the child prompt on its
  // llm.request and omit child `other` markers so they cannot pollute or
  // re-parent the parent ENTRY span.
  return entries.filter(entry => entry['event.name'] !== 'other').map(entry => ({
    ...entry,
    trace_id: context.parentTraceId,
    'gen_ai.session.id': context.parentThreadId,
    'gen_ai.turn.id': parentTurnId,
    'gen_ai.agent.scope': 'subagent',
    'gen_ai.agent.depth': 1,
    'gen_ai.agent.id': context.childThreadId,
    ...(context.agentName ? { 'gen_ai.agent.name': context.agentName } : {}),
    'gen_ai.agent.parent.id': context.parentThreadId,
    'gen_ai.subagent.parent_tool_call.id': context.parentToolCallId,
  }));
}

function codexTurnEndMarker(
  entries: AgentActivityEntry[],
  status: 'completed' | 'interrupted',
): AgentActivityEntry {
  const source = [...entries].reverse().find(entry => entry['event.name'] === 'llm.response')
    ?? entries.at(-1);
  if (!source) throw new Error('cannot build Codex turn-end marker without a source entry');
  return {
    time_unix_nano: source.time_unix_nano,
    ...(source.observed_time_unix_nano
      ? { observed_time_unix_nano: source.observed_time_unix_nano }
      : {}),
    'event.id': `${source['event.id']}:turn-end`,
    'event.name': 'other',
    'user.id': source['user.id'],
    ...(source.trace_id ? { trace_id: source.trace_id } : {}),
    parent_span_id: '0000000000000001',
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
    'agent.codex.turn_status': status,
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
): CodexPendingTerminalTurn {
  const now = Date.now();
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
