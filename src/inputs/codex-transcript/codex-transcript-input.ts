import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent, FSWatcher } from 'node:fs';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { buildCodexTranscriptEntries } from './codex-transcript-builder.js';
import {
  extractCodexTerminalTurn,
  extractCodexTranscriptMeta,
  sessionIdFromTranscriptPath,
} from './codex-transcript-extractor.js';
import {
  MAX_EMITTED_TERMINAL_TURNS,
  MAX_GLOBAL_EMITTED_TERMINAL_TURNS,
  type CodexActiveTranscriptTurn,
  type CodexTranscriptCheckpoint,
  type CodexTranscriptGlobalState,
} from './codex-transcript-types.js';
import { stringValue, timestampMs } from './codex-transcript-utils.js';

const DEFAULT_SESSION_DIR = '~/.codex/sessions';
const READ_CHUNK_SIZE = 1024 * 1024;
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
    const entries: AgentActivityEntry[] = [];
    for (const filePath of await this.discoverSessionFiles()) {
      entries.push(...await this.processFile(filePath));
    }
    return entries;
  }

  private async processFile(filePath: string): Promise<AgentActivityEntry[]> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
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
      return [];
    }

    const hadPendingTerminal = checkpoint.pendingTerminal !== null;
    const recoveredPending = await this.recoverPendingTerminal(filePath, checkpoint);
    if (recoveredPending === null) {
      this.saveCheckpoint(key, checkpoint);
      this.saveGlobalEmittedTurnIds();
      return [];
    }
    const checkpointChangedByPending = hadPendingTerminal;

    if (stat.size <= checkpoint.scanOffset) {
      if (checkpointChangedByPending || recoveredPending.length > 0) this.saveCheckpoint(key, checkpoint);
      this.saveGlobalEmittedTurnIds();
      return recoveredPending;
    }
    const lines = await readJsonLines(filePath, checkpoint.scanOffset, stat.size);
    if (lines.nextOffset === checkpoint.scanOffset) {
      if (checkpointChangedByPending || recoveredPending.length > 0) this.saveCheckpoint(key, checkpoint);
      this.saveGlobalEmittedTurnIds();
      return recoveredPending;
    }

    const entries: AgentActivityEntry[] = recoveredPending;
    let nextScanOffset = lines.nextOffset;
    for (const line of lines.items) {
      const payload = asRecord(line.record.payload);
      if (!payload) continue;
      if (line.record.type === 'session_meta') {
        checkpoint.latestSessionMetaOffset = line.startOffset;
        continue;
      }

      const turnId = turnIdForStart(line.record, payload);
      if (turnId) {
        if (!checkpoint.activeTurn || checkpoint.activeTurn.turnId !== turnId) {
          checkpoint.activeTurn = {
            turnId,
            startOffset: line.startOffset,
            startedAtMs: timestampMs(line.record, Date.now()),
          };
        }
        continue;
      }

      const terminalTurnId = terminalTurnIdFor(line.record, payload);
      if (!terminalTurnId || checkpoint.activeTurn?.turnId !== terminalTurnId) continue;
      if (!checkpoint.emittedTerminalTurnIds.includes(terminalTurnId)) {
        if (this.isGloballyEmittedTurn(terminalTurnId)) {
          this.rememberCheckpointTurnId(checkpoint, terminalTurnId);
          checkpoint.activeTurn = null;
        } else {
          const recovered = await this.recoverTurn(filePath, checkpoint, line.endOffset);
          if (recovered.length > 0) {
            entries.push(...recovered);
            this.rememberCheckpointTurnId(checkpoint, terminalTurnId);
            this.rememberGlobalEmittedTurnId(terminalTurnId);
          } else {
            checkpoint.pendingTerminal = { turnId: terminalTurnId, terminalEndOffset: line.endOffset };
            this.logger.warn('terminal Codex turn could not be reconstructed; retaining it for the next scan', {
              transcriptPath: filePath,
              turnId: terminalTurnId,
            });
            nextScanOffset = line.endOffset;
            break;
          }
        }
      }
      checkpoint.activeTurn = null;
    }

    checkpoint.scanOffset = nextScanOffset;
    this.saveCheckpoint(key, checkpoint);
    this.saveGlobalEmittedTurnIds();
    return entries;
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
    const recovered = await this.recoverTurn(filePath, checkpoint, pending.terminalEndOffset);
    if (recovered.length === 0) {
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
    return recovered;
  }

  private async recoverTurn(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    terminalEndOffset: number,
  ): Promise<AgentActivityEntry[]> {
    const activeTurn = checkpoint.activeTurn;
    if (!activeTurn) return [];
    const records = await readJsonLines(filePath, activeTurn.startOffset, terminalEndOffset);
    const metaRecord = checkpoint.latestSessionMetaOffset === null
      ? null
      : await readJsonLineAt(filePath, checkpoint.latestSessionMetaOffset);
    const meta = metaRecord ? extractCodexTranscriptMeta(metaRecord) : null;
    const turn = extractCodexTerminalTurn(
      records.items.map(item => item.record),
      meta,
      sessionIdFromTranscriptPath(filePath),
      activeTurn.turnId,
    );
    if (turn && turn.unmatchedTokenUsages.length > 0) {
      this.logger.warn('Codex transcript token samples could not be assigned to a response wave', {
        transcriptPath: filePath,
        turnId: activeTurn.turnId,
        count: turn.unmatchedTokenUsages.length,
        lastUsage: turn.unmatchedTokenUsages.at(-1),
      });
    }
    if (!turn) return [];
    const entries = buildCodexTranscriptEntries(turn);
    const resourceAttributes = await this.readWakeupResourceAttributes(turn.sessionId);
    return resourceAttributes ? attachWakeupResourceAttributes(entries, resourceAttributes) : entries;
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
    const lines = await readJsonLines(filePath, 0, stat.size);
    let latestSessionMetaOffset: number | null = null;
    let activeTurn: CodexActiveTranscriptTurn | null = null;
    const completedTurnIds: string[] = [];
    for (const line of lines.items) {
      const payload = asRecord(line.record.payload);
      if (!payload) continue;
      if (line.record.type === 'session_meta') {
        latestSessionMetaOffset = line.startOffset;
        continue;
      }
      const turnId = turnIdForStart(line.record, payload);
      if (turnId && (!activeTurn || activeTurn.turnId !== turnId)) {
        activeTurn = { turnId, startOffset: line.startOffset, startedAtMs: timestampMs(line.record, Date.now()) };
        continue;
      }
      const terminalTurnId = terminalTurnIdFor(line.record, payload);
      if (terminalTurnId === activeTurn?.turnId) {
        completedTurnIds.push(terminalTurnId);
        activeTurn = null;
      }
    }
    for (const turnId of completedTurnIds) this.rememberGlobalEmittedTurnId(turnId);
    this.saveCheckpoint(key, {
      inode: stat.ino,
      scanOffset: lines.nextOffset,
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
    const activeTurn = active
      && typeof active.turnId === 'string'
      && typeof active.startOffset === 'number'
      && typeof active.startedAtMs === 'number'
      ? { turnId: active.turnId, startOffset: active.startOffset, startedAtMs: active.startedAtMs }
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
  const handle = await fs.open(filePath, 'r');
  try {
    const items: JsonLine[] = [];
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
              items.push({
                startOffset: dataStartOffset + cursor,
                endOffset: dataStartOffset + newline + 1,
                record,
              });
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

    return { items, nextOffset };
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

function terminalTurnIdFor(record: Record<string, unknown>, payload: Record<string, unknown>): string | null {
  if (record.type !== 'event_msg' || (payload.type !== 'task_complete' && payload.type !== 'turn_aborted')) return null;
  return stringValue(payload.turn_id) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

function safeWakeupSessionPart(value: string): string {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function defaultWakeupDir(): string {
  const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
  return path.join(dataDir, 'state', 'codex', 'transcript-wakeups');
}
