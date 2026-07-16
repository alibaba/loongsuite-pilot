import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent, FSWatcher } from 'node:fs';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import {
  buildCodexTranscriptSegment,
  nextInputMessagesForStep,
} from './codex-transcript-builder.js';
import {
  extractCodexPartialTurn,
  extractCodexTranscriptMeta,
  sessionIdFromTranscriptPath,
} from './codex-transcript-extractor.js';
import {
  MAX_EMITTED_TERMINAL_TURNS,
  MAX_GLOBAL_EMITTED_TERMINAL_TURNS,
  type CodexActiveTranscriptTurn,
  type CodexTranscriptInputContext,
  type CodexTranscriptCheckpoint,
  type CodexTranscriptGlobalState,
  type CodexTranscriptStep,
} from './codex-transcript-types.js';
import { stringValue, timestampMs } from './codex-transcript-utils.js';

const DEFAULT_SESSION_DIR = '~/.codex/sessions';
const READ_CHUNK_SIZE = 1024 * 1024;
const MAX_EMIT_BATCH_ENTRIES = 256;
const MAX_EMIT_BATCH_BYTES = 1024 * 1024;
const MAX_PERSISTED_INPUT_CONTEXT_BYTES = 1024 * 1024;
// Values emitted by DEFAULT_RESOURCE_ENV_FIELD_MAP in assets/hooks/shared/resource-context.mjs.
// Add new AgentTeams resource fields to both lists together.
const WAKEUP_RESOURCE_ATTRIBUTE_KEYS = [
  'agentteams.worker.name',
  'agentteams.instance.id',
];
const MAX_WAKEUP_RESOURCE_ATTRIBUTE_VALUE_LENGTH = 512;

interface JsonLine {
  startOffset: number;
  endOffset: number;
  record: Record<string, unknown>;
}

interface ClosedWaveRange {
  startOffset: number;
  endOffset: number;
}

interface SegmentRecoveryResult {
  entries: AgentActivityEntry[];
  consumedEndOffset: number;
}

export interface CodexTranscriptInputOptions extends InputOptions {
  sessionDir?: string;
  wakeupDir?: string;
}

export class CodexTranscriptInput extends BaseInput {
  readonly id = 'codex-transcript';
  readonly agentType = ClientType.CodexCliHook;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly sessionDir: string;
  private readonly wakeupDir: string;
  private wakeupWatcher: FSWatcher | null = null;
  private emittedTurnIdsLoaded = false;
  private emittedTurnIdsDirty = false;
  private emittedTurnIds = new Set<string>();
  private emittedTurnIdOrder: string[] = [];

  constructor(opts: CodexTranscriptInputOptions) {
    super({ stateStore: opts.stateStore, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.sessionDir = opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR);
    this.wakeupDir = opts.wakeupDir ?? defaultWakeupDir();
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  protected override async onStart(): Promise<void> {
    this.loadGlobalEmittedTurnIds();
    for (const filePath of await this.discoverSessionFiles()) {
      const key = this.stateKey(filePath);
      if (!this.readCheckpoint(key)) await this.baselineFile(filePath, key);
    }
    this.saveGlobalEmittedTurnIds();
    await fs.mkdir(this.wakeupDir, { recursive: true });
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
    let emittedCount = 0;
    for (const filePath of await this.discoverSessionFiles()) {
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
    if (!checkpoint) {
      checkpoint = {
        inode: stat.ino,
        scanOffset: 0,
        activeTurn: null,
        pendingTerminal: null,
        latestSessionMetaOffset: null,
        emittedTerminalTurnIds: [],
      };
    } else if (checkpoint.inode !== stat.ino) {
      await this.baselineFile(filePath, key);
      this.saveGlobalEmittedTurnIds();
      return 0;
    }

    const hadPendingTerminal = checkpoint.pendingTerminal !== null;
    const recoveredPending = await this.recoverPendingTerminal(filePath, checkpoint);
    if (recoveredPending === null) {
      this.saveCheckpoint(key, checkpoint);
      this.saveGlobalEmittedTurnIds();
      return 0;
    }
    let emittedCount = this.emitEntryBatches(recoveredPending);
    const checkpointChangedByPending = hadPendingTerminal;

    if (stat.size <= checkpoint.scanOffset) {
      if (checkpointChangedByPending || recoveredPending.length > 0) this.saveCheckpoint(key, checkpoint);
      this.saveGlobalEmittedTurnIds();
      return emittedCount;
    }
    let terminalTurnId: string | null = null;
    let terminalEndOffset: number | null = null;
    const scan = await scanJsonLines(filePath, checkpoint.scanOffset, stat.size, line => {
      const payload = asRecord(line.record.payload);
      if (!payload) return;
      if (line.record.type === 'session_meta') {
        checkpoint.latestSessionMetaOffset = line.startOffset;
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
    });
    if (scan.nextOffset === checkpoint.scanOffset) {
      if (checkpointChangedByPending || recoveredPending.length > 0) this.saveCheckpoint(key, checkpoint);
      this.saveGlobalEmittedTurnIds();
      return emittedCount;
    }

    const nextScanOffset = terminalEndOffset ?? scan.nextOffset;
    if (checkpoint.activeTurn && nextScanOffset > checkpoint.activeTurn.startOffset) {
      if (terminalTurnId && checkpoint.emittedTerminalTurnIds.includes(terminalTurnId)) {
        checkpoint.activeTurn = null;
      } else if (terminalTurnId && this.isGloballyEmittedTurn(terminalTurnId)) {
        this.rememberCheckpointTurnId(checkpoint, terminalTurnId);
        checkpoint.activeTurn = null;
      } else {
        const recovered = await this.recoverTurnSegment(
          filePath,
          checkpoint,
          nextScanOffset,
          terminalTurnId !== null,
        );
        emittedCount += this.emitEntryBatches(recovered.entries);
        if (recovered.consumedEndOffset > checkpoint.activeTurn.startOffset) {
          checkpoint.activeTurn.startOffset = recovered.consumedEndOffset;
        }
        if (terminalTurnId && checkpoint.activeTurn.turnId === terminalTurnId) {
          if (recovered.entries.length > 0) {
            this.rememberCheckpointTurnId(checkpoint, terminalTurnId);
            this.rememberGlobalEmittedTurnId(terminalTurnId);
            checkpoint.activeTurn = null;
          } else {
            checkpoint.pendingTerminal = { turnId: terminalTurnId, terminalEndOffset: nextScanOffset };
            this.logger.warn('terminal Codex turn could not be reconstructed; retaining it for the next scan', {
              transcriptPath: filePath,
              turnId: terminalTurnId,
            });
          }
        }
      }
    }

    checkpoint.scanOffset = nextScanOffset;
    this.saveCheckpoint(key, checkpoint);
    this.saveGlobalEmittedTurnIds();
    return emittedCount;
  }

  /**
   * A completed terminal line is never retried by the normal offset scan.
   * Persist the range and retry it before reading later transcript data.
   */
  private async recoverPendingTerminal(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
  ): Promise<AgentActivityEntry[] | null> {
    const pending = checkpoint.pendingTerminal;
    if (!pending) return [];
    if (checkpoint.activeTurn?.turnId !== pending.turnId) {
      checkpoint.pendingTerminal = null;
      return [];
    }
    if (this.isGloballyEmittedTurn(pending.turnId)) {
      this.rememberCheckpointTurnId(checkpoint, pending.turnId);
      checkpoint.activeTurn = null;
      checkpoint.pendingTerminal = null;
      return [];
    }
    const recovered = await this.recoverTurnSegment(filePath, checkpoint, pending.terminalEndOffset, true);
    if (recovered.entries.length === 0) {
      this.logger.warn('pending Codex terminal turn still could not be reconstructed; will retry', {
        transcriptPath: filePath,
        turnId: pending.turnId,
      });
      return null;
    }
    this.rememberCheckpointTurnId(checkpoint, pending.turnId);
    this.rememberGlobalEmittedTurnId(pending.turnId);
    checkpoint.activeTurn = null;
    checkpoint.pendingTerminal = null;
    return recovered.entries;
  }

  private async recoverTurnSegment(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    endOffset: number,
    terminal: boolean,
  ): Promise<SegmentRecoveryResult> {
    const activeTurn = checkpoint.activeTurn;
    if (!activeTurn) return { entries: [], consumedEndOffset: endOffset };
    const records = await readJsonLines(filePath, activeTurn.startOffset, endOffset);
    const metaRecord = checkpoint.latestSessionMetaOffset === null
      ? null
      : await readJsonLineAt(filePath, checkpoint.latestSessionMetaOffset);
    const meta = metaRecord ? extractCodexTranscriptMeta(metaRecord) : null;
    const turn = extractCodexPartialTurn(
      records.items.map(item => item.record),
      meta,
      sessionIdFromTranscriptPath(filePath),
      activeTurn.turnId,
      partialTurnOptions(activeTurn),
    );
    if (!turn) return { entries: [], consumedEndOffset: activeTurn.startOffset };
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
      : countLeadingClosedSteps(turn.steps);
    const inputContext = await this.resolveInputContext(filePath, activeTurn, meta);
    const built = buildCodexTranscriptSegment(turn, {
      includePrompt: activeTurn.emittedPrompt !== true,
      startStepNumber: stepStart,
      ...(inputContext ? { inputContext } : {}),
      contextStepCount: closedStepCount,
    });
    const closedStepIds = new Set(
      Array.from({ length: closedStepCount }, (_, index) => (
        `${turn.sessionId}:${turn.transcriptTurnId}:s${stepStart + index}`
      )),
    );
    const readyEntries = built.entries.filter(entry => {
      const eventName = entry['event.name'];
      if (eventName !== 'llm.request' && eventName !== 'llm.response') return true;
      return closedStepIds.has(String(entry['gen_ai.step.id'] ?? ''));
    });
    const entries = this.filterNewSegmentEntries(readyEntries, activeTurn);

    if (turn.prompt) activeTurn.emittedPrompt = true;
    activeTurn.emittedStepCount = (activeTurn.emittedStepCount ?? 0) + closedStepCount;

    const closedWaveRanges = findClosedWaveRanges(records.items);
    const lastClosedRange = closedStepCount > 0
      ? closedWaveRanges[Math.min(closedStepCount, closedWaveRanges.length) - 1]
      : undefined;
    if (closedStepCount > 0) {
      activeTurn.inputContext = persistedInputContext(built.nextInputContext, lastClosedRange);
    }

    const consumedEndOffset = terminal
      ? endOffset
      : lastClosedRange?.endOffset ?? activeTurn.startOffset;

    const resourceAttributes = await this.readWakeupResourceAttributes(turn.sessionId);
    return {
      entries: resourceAttributes ? attachWakeupResourceAttributes(entries, resourceAttributes) : entries,
      consumedEndOffset,
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

  private async baselineFile(filePath: string, key: string): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    let latestSessionMetaOffset: number | null = null;
    let activeTurn: CodexActiveTranscriptTurn | null = null;
    const completedTurnIds: string[] = [];
    const { nextOffset } = await scanJsonLines(filePath, 0, stat.size, line => {
      const payload = asRecord(line.record.payload);
      if (!payload) return;
      if (line.record.type === 'session_meta') {
        latestSessionMetaOffset = line.startOffset;
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
    for (const turnId of completedTurnIds) this.rememberGlobalEmittedTurnId(turnId);
    this.saveCheckpoint(key, {
      inode: stat.ino,
      scanOffset: nextOffset,
      activeTurn,
      pendingTerminal: null,
      latestSessionMetaOffset,
      emittedTerminalTurnIds: [],
    });
  }

  private async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    await collectRolloutFiles(this.sessionDir, files);
    return files.sort();
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
      ? { turnId: pending.turnId, terminalEndOffset: pending.terminalEndOffset }
      : null;
    return {
      inode: value.inode,
      scanOffset: value.scanOffset,
      activeTurn,
      pendingTerminal,
      latestSessionMetaOffset: typeof value.latestSessionMetaOffset === 'number'
        ? value.latestSessionMetaOffset
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

  private loadGlobalEmittedTurnIds(): void {
    if (this.emittedTurnIdsLoaded) return;
    this.emittedTurnIdsLoaded = true;

    const global = this.readGlobalState();
    const hasPersistedGlobalState = global.emittedTerminalTurnIds.length > 0;
    for (const turnId of global.emittedTerminalTurnIds) {
      if (this.emittedTurnIds.has(turnId)) continue;
      this.emittedTurnIds.add(turnId);
      this.emittedTurnIdOrder.push(turnId);
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
        if (typeof turnId === 'string') this.rememberGlobalEmittedTurnId(turnId);
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

  private saveGlobalEmittedTurnIds(): void {
    if (!this.emittedTurnIdsDirty) return;
    const current = this.stateStore.get(this.id);
    this.stateStore.update(this.id, {
      lastOffset: this.emittedTurnIdOrder.length,
      extra: {
        ...(current.extra ?? {}),
        codexTranscriptGlobal: {
          emittedTerminalTurnIds: this.emittedTurnIdOrder,
        },
      },
    });
    this.emittedTurnIdsDirty = false;
  }

  private isGloballyEmittedTurn(turnId: string): boolean {
    this.loadGlobalEmittedTurnIds();
    return this.emittedTurnIds.has(turnId);
  }

  private rememberCheckpointTurnId(checkpoint: CodexTranscriptCheckpoint, turnId: string): void {
    checkpoint.emittedTerminalTurnIds = [turnId, ...checkpoint.emittedTerminalTurnIds.filter(id => id !== turnId)]
      .slice(0, MAX_EMITTED_TERMINAL_TURNS);
  }

  private rememberGlobalEmittedTurnId(turnId: string, markDirty = true): void {
    if (this.emittedTurnIds.has(turnId)) return;
    this.emittedTurnIds.add(turnId);
    this.emittedTurnIdOrder.unshift(turnId);
    while (this.emittedTurnIdOrder.length > MAX_GLOBAL_EMITTED_TERMINAL_TURNS) {
      const removed = this.emittedTurnIdOrder.pop();
      if (removed) this.emittedTurnIds.delete(removed);
    }
    if (markDirty) this.emittedTurnIdsDirty = true;
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

function countLeadingClosedSteps(steps: CodexTranscriptStep[]): number {
  let count = 0;
  for (const step of steps) {
    if (!step.tokenUsage) break;
    count++;
  }
  return count;
}

function findClosedWaveRanges(items: JsonLine[]): ClosedWaveRange[] {
  const ranges: ClosedWaveRange[] = [];
  const pendingToolCalls = new Set<string>();
  let waveStartOffset = items[0]?.startOffset ?? 0;
  let hasResponseEvidence = false;

  for (const line of items) {
    const payload = asRecord(line.record.payload);
    if (!payload) continue;

    if (line.record.type === 'event_msg') {
      if (payload.type === 'agent_message' || payload.type === 'web_search_start') {
        hasResponseEvidence = true;
      }
      if (payload.type === 'token_count'
        && hasResponseEvidence
        && pendingToolCalls.size === 0
        && asRecord(asRecord(payload.info)?.last_token_usage)) {
        ranges.push({ startOffset: waveStartOffset, endOffset: line.endOffset });
        waveStartOffset = line.endOffset;
        hasResponseEvidence = false;
      }
      continue;
    }

    if (line.record.type !== 'response_item') continue;
    const itemType = stringValue(payload.type);
    if (itemType === 'message' && stringValue(payload.role) === 'assistant') {
      hasResponseEvidence = true;
      continue;
    }
    if (itemType === 'reasoning' || itemType === 'web_search_call') {
      hasResponseEvidence = true;
      continue;
    }
    if (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'tool_search_call') {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
      if (callId) pendingToolCalls.add(callId);
      hasResponseEvidence = true;
      continue;
    }
    if (itemType === 'function_call_output'
      || itemType === 'custom_tool_call_output'
      || itemType === 'tool_search_output') {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
      if (callId) pendingToolCalls.delete(callId);
    }
  }
  return ranges;
}

function persistedInputContext(
  context: CodexTranscriptInputContext,
  sourceRange: ClosedWaveRange | undefined,
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

function defaultWakeupDir(): string {
  const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
  return path.join(dataDir, 'state', 'codex', 'transcript-wakeups');
}
