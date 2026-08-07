import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent, FSWatcher } from 'node:fs';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { isReservedKey } from '../../normalization/global-attributes.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import {
  buildCodexTranscriptSegment,
  nextInputMessagesForStep,
} from './codex-transcript-builder.js';
import {
  extractCodexPartialTurn,
  extractCodexPartialTurnWithBoundaries,
  extractCodexTranscriptMeta,
  sessionIdFromTranscriptPath,
} from './codex-transcript-extractor.js';
import {
  MAX_EMITTED_TERMINAL_TURNS,
  MAX_GLOBAL_EMITTED_TERMINAL_TURNS,
  type CodexActiveTranscriptTurn,
  type CodexPendingTerminalTurn,
  type CodexTranscriptInputContext,
  type CodexTranscriptCheckpoint,
  type CodexTranscriptGlobalState,
  type CodexTranscriptSourceRange,
} from './codex-transcript-types.js';
import { stringValue, timestampMs } from './codex-transcript-utils.js';

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

export interface CodexTranscriptInputOptions extends InputOptions {
  sessionDir?: string;
  wakeupDir?: string;
  spanContextDir?: string;
}

export class CodexTranscriptInput extends BaseInput {
  readonly id = 'codex-transcript';
  readonly agentType = ClientType.CodexCliHook;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly sessionDir: string;
  private readonly wakeupDir: string;
  private readonly spanContextDir: string;
  private wakeupWatcher: FSWatcher | null = null;
  private processedTerminalTurnIdsLoaded = false;
  private processedTerminalTurnIdsDirty = false;
  private processedTerminalTurnIds = new Set<string>();
  private processedTerminalTurnIdOrder: string[] = [];
  private lastWakeupMarkerCleanupAtMs = 0;
  private lastSpanContextCleanupAtMs = 0;

  constructor(opts: CodexTranscriptInputOptions) {
    super({ stateStore: opts.stateStore, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.sessionDir = opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR);
    this.wakeupDir = opts.wakeupDir ?? defaultWakeupDir();
    this.spanContextDir = opts.spanContextDir ?? defaultSpanContextDir();
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  protected override async onStart(): Promise<void> {
    this.loadGlobalProcessedTerminalTurnIds();
    for (const { filePath, baselineOnStart } of await this.discoverSessionFiles()) {
      const key = this.stateKey(filePath);
      if (baselineOnStart && !this.readCheckpoint(key)) await this.baselineFile(filePath, key);
    }
    this.saveGlobalProcessedTerminalTurnIds();
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
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    await this.cleanupExpiredSpanContexts(Date.now());
    let emittedCount = 0;
    for (const { filePath } of await this.discoverSessionFiles()) {
      emittedCount += await this.processFile(filePath);
    }
    if (emittedCount > 0) {
      this.logger.debug('cycle produced entries', { count: emittedCount });
    }
    return [];
  }

  private emitEntryBatches(entries: AgentActivityEntry[]): number {
    let emittedCount = 0;
    let batch: AgentActivityEntry[] = [];
    let batchBytes = 0;

    const flush = (): void => {
      if (batch.length === 0) return;
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
    let checkpoint = this.readCheckpoint(key);
    let checkpointChanged = false;
    if (!checkpoint) {
      checkpoint = {
        inode: stat.ino,
        scanOffset: 0,
        activeTurn: null,
        pendingTerminal: null,
        ownerSessionMetaOffset: null,
        emittedTerminalTurnIds: [],
      };
      checkpointChanged = true;
    } else if (checkpoint.inode !== stat.ino) {
      await this.baselineFile(filePath, key);
      this.saveGlobalProcessedTerminalTurnIds();
      return 0;
    }

    if (checkpoint.ownerSessionMetaOffset === null) {
      checkpoint.ownerSessionMetaOffset = await findOwnerSessionMetaOffset(filePath, stat.size);
      checkpointChanged = true;
    }

    let emittedCount = 0;
    let processedTerminalCount = 0;
    let scannedBytes = 0;

    const hadPendingTerminal = checkpoint.pendingTerminal !== null;
    const pendingResult = await this.recoverPendingTerminal(filePath, checkpoint);
    checkpointChanged ||= hadPendingTerminal;
    emittedCount += pendingResult.emittedCount;
    processedTerminalCount += pendingResult.processedTerminalCount;
    if (pendingResult.blocked) {
      if (checkpointChanged) this.saveCheckpoint(key, checkpoint);
      this.saveGlobalProcessedTerminalTurnIds();
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
        if (terminalTurnId && checkpoint.emittedTerminalTurnIds.includes(terminalTurnId)) {
          checkpoint.activeTurn = null;
          checkpoint.pendingTerminal = null;
          processedTerminalCount++;
        } else if (terminalTurnId && this.isGloballyProcessedTerminalTurn(terminalTurnId)) {
          this.rememberProcessedTerminalTurnId(checkpoint, terminalTurnId);
          checkpoint.activeTurn = null;
          checkpoint.pendingTerminal = null;
          processedTerminalCount++;
        } else {
          const recovered = await this.recoverTurnSegment(
            filePath,
            checkpoint,
            nextScanOffset,
            terminalTurnId !== null,
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
            } else {
              this.rememberProcessedTerminalTurnId(checkpoint, terminalTurnId);
              this.rememberGlobalProcessedTerminalTurnId(terminalTurnId);
              checkpoint.activeTurn = null;
              checkpoint.pendingTerminal = null;
              processedTerminalCount++;
            }
          }
        }
      }

      checkpoint.scanOffset = nextScanOffset;
      if (blocked || terminalTurnId === null) break;
    }

    if (checkpointChanged) this.saveCheckpoint(key, checkpoint);
    this.saveGlobalProcessedTerminalTurnIds();
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
    if (this.isGloballyProcessedTerminalTurn(pending.turnId)) {
      this.rememberProcessedTerminalTurnId(checkpoint, pending.turnId);
      checkpoint.activeTurn = null;
      checkpoint.pendingTerminal = null;
      return { blocked: false, emittedCount: 0, processedTerminalCount: 1 };
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
    this.rememberProcessedTerminalTurnId(checkpoint, pending.turnId);
    this.rememberGlobalProcessedTerminalTurnId(pending.turnId);
    checkpoint.activeTurn = null;
    checkpoint.pendingTerminal = null;
    return { blocked: false, emittedCount, processedTerminalCount: 1 };
  }

  private async recoverTurnSegment(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    endOffset: number,
    terminal: boolean,
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
      partialTurnOptions(activeTurn),
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
    const readyEntries = built.entries;
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
      partialTurnOptions(activeTurn),
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

  private async baselineFile(filePath: string, key: string): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    let ownerSessionMetaOffset: number | null = null;
    let activeTurn: CodexActiveTranscriptTurn | null = null;
    const completedTurnIds: string[] = [];
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
        completedTurnIds.push(terminalTurnId);
        activeTurn = null;
      }
    });
    const baselineActiveTurn = activeTurn as CodexActiveTranscriptTurn | null;
    if (baselineActiveTurn) {
      baselineActiveTurn.startOffset = nextOffset;
    }
    for (const turnId of completedTurnIds) this.rememberGlobalProcessedTerminalTurnId(turnId);
    this.saveCheckpoint(key, {
      inode: stat.ino,
      scanOffset: nextOffset,
      activeTurn,
      pendingTerminal: null,
      ownerSessionMetaOffset,
      emittedTerminalTurnIds: [],
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
    const active = asRecord(value.activeTurn);
    const model = stringValue(active?.model);
    const cwd = stringValue(active?.cwd);
    const developerInstructions = stringValue(active?.developerInstructions);
    const activeTurn = active
      && typeof active.turnId === 'string'
      && typeof active.startOffset === 'number'
      && typeof active.startedAtMs === 'number'
      ? {
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
        }
      : null;
    const pending = asRecord(value.pendingTerminal);
    const pendingTerminal = pending
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
    return {
      inode: value.inode,
      scanOffset: value.scanOffset,
      activeTurn,
      pendingTerminal,
      // Do not migrate legacy latestSessionMetaOffset. In forked rollouts that
      // value commonly points at copied parent metadata, so processFile will
      // perform one bounded header scan to recover the owning meta safely.
      ownerSessionMetaOffset: typeof value.ownerSessionMetaOffset === 'number'
        ? value.ownerSessionMetaOffset
        : null,
      emittedTerminalTurnIds: Array.isArray(value.emittedTerminalTurnIds)
        ? value.emittedTerminalTurnIds.filter((item): item is string => typeof item === 'string')
          .slice(0, MAX_EMITTED_TERMINAL_TURNS)
        : [],
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

  private loadGlobalProcessedTerminalTurnIds(): void {
    if (this.processedTerminalTurnIdsLoaded) return;
    this.processedTerminalTurnIdsLoaded = true;

    const global = this.readGlobalState();
    const hasPersistedGlobalState = global.emittedTerminalTurnIds.length > 0;
    for (const turnId of global.emittedTerminalTurnIds) {
      if (this.processedTerminalTurnIds.has(turnId)) continue;
      this.processedTerminalTurnIds.add(turnId);
      this.processedTerminalTurnIdOrder.push(turnId);
    }

    if (hasPersistedGlobalState) return;
    for (const key of this.stateStore.keys()) {
      if (!key.startsWith(`${this.id}:`)) continue;
      const raw = this.stateStore.get(key).extra?.codexTranscript;
      const value = asRecord(raw);
      const emittedTerminalTurnIds = Array.isArray(value?.emittedTerminalTurnIds)
        ? value.emittedTerminalTurnIds
        : [];
      for (const turnId of emittedTerminalTurnIds) {
        if (typeof turnId === 'string') this.rememberGlobalProcessedTerminalTurnId(turnId);
      }
    }
  }

  private readGlobalState(): CodexTranscriptGlobalState {
    const raw = this.stateStore.get(this.id).extra?.codexTranscriptGlobal;
    const value = asRecord(raw);
    return {
      emittedTerminalTurnIds: Array.isArray(value?.emittedTerminalTurnIds)
        ? value.emittedTerminalTurnIds
          .filter((item): item is string => typeof item === 'string')
          .slice(0, MAX_GLOBAL_EMITTED_TERMINAL_TURNS)
        : [],
    };
  }

  private saveGlobalProcessedTerminalTurnIds(): void {
    if (!this.processedTerminalTurnIdsDirty) return;
    const current = this.stateStore.get(this.id);
    this.stateStore.update(this.id, {
      lastOffset: this.processedTerminalTurnIdOrder.length,
      extra: {
        ...(current.extra ?? {}),
        codexTranscriptGlobal: {
          emittedTerminalTurnIds: this.processedTerminalTurnIdOrder,
        },
      },
    });
    this.processedTerminalTurnIdsDirty = false;
  }

  private isGloballyProcessedTerminalTurn(turnId: string): boolean {
    this.loadGlobalProcessedTerminalTurnIds();
    return this.processedTerminalTurnIds.has(turnId);
  }

  private rememberProcessedTerminalTurnId(checkpoint: CodexTranscriptCheckpoint, turnId: string): void {
    checkpoint.emittedTerminalTurnIds = [turnId, ...checkpoint.emittedTerminalTurnIds.filter(id => id !== turnId)]
      .slice(0, MAX_EMITTED_TERMINAL_TURNS);
  }

  private rememberGlobalProcessedTerminalTurnId(turnId: string, markDirty = true): void {
    if (this.processedTerminalTurnIds.has(turnId)) return;
    this.processedTerminalTurnIds.add(turnId);
    this.processedTerminalTurnIdOrder.unshift(turnId);
    while (this.processedTerminalTurnIdOrder.length > MAX_GLOBAL_EMITTED_TERMINAL_TURNS) {
      const removed = this.processedTerminalTurnIdOrder.pop();
      if (removed) this.processedTerminalTurnIds.delete(removed);
    }
    if (markDirty) this.processedTerminalTurnIdsDirty = true;
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

function partialTurnOptions(activeTurn: CodexActiveTranscriptTurn): {
  startedAtMs: number;
  model?: string;
  cwd?: string;
  developerInstructions?: string;
} {
  return {
    startedAtMs: activeTurn.startedAtMs,
    ...(activeTurn.model ? { model: activeTurn.model } : {}),
    ...(activeTurn.cwd ? { cwd: activeTurn.cwd } : {}),
    ...(activeTurn.developerInstructions ? { developerInstructions: activeTurn.developerInstructions } : {}),
  };
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
