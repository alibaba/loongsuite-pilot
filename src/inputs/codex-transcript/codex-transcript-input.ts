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
  extractCodexPartialTurn,
  extractCodexTranscriptMeta,
  sessionIdFromTranscriptPath,
} from './codex-transcript-extractor.js';
import {
  MAX_EMITTED_TERMINAL_TURNS,
  type CodexActiveTranscriptTurn,
  type CodexTranscriptCheckpoint,
  type CodexTranscriptTool,
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
  private readonly nextStepInputMessages = new Map<string, JsonValue[]>();

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
    for (const filePath of await this.discoverSessionFiles()) {
      const key = this.stateKey(filePath);
      if (!this.readCheckpoint(key)) await this.baselineFile(filePath, key);
    }
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
      return [];
    }

    const recoveredPending = await this.recoverPendingTerminal(filePath, checkpoint);
    if (recoveredPending === null) {
      this.saveCheckpoint(key, checkpoint);
      return [];
    }

    if (stat.size <= checkpoint.scanOffset) {
      if (recoveredPending.length > 0) this.saveCheckpoint(key, checkpoint);
      return recoveredPending;
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
          checkpoint.activeTurn = {
            turnId,
            startOffset: line.startOffset,
            startedAtMs: timestampMs(line.record, Date.now()),
            emittedPrompt: false,
            emittedStepCount: 0,
            emittedStepRequestIds: [],
            emittedStepResponseIds: [],
            emittedToolCallIds: [],
            emittedToolResultIds: [],
          };
        }
        return;
      }

      const terminal = terminalTurnIdFor(line.record, payload);
      if (!terminal || checkpoint.activeTurn?.turnId !== terminal) return;
      terminalTurnId = terminal;
      terminalEndOffset = line.endOffset;
      return false;
    });
    if (scan.nextOffset === checkpoint.scanOffset) {
      if (recoveredPending.length > 0) this.saveCheckpoint(key, checkpoint);
      return recoveredPending;
    }

    const entries: AgentActivityEntry[] = recoveredPending;
    const nextScanOffset = terminalEndOffset ?? scan.nextOffset;

    if (checkpoint.activeTurn && nextScanOffset > checkpoint.activeTurn.startOffset) {
      const recovered = await this.recoverTurnSegment(filePath, checkpoint, nextScanOffset);
      entries.push(...recovered);
      const hasClosedWave = recovered.some(entry => entry['event.name'] === 'llm.response');
      if (hasClosedWave || terminalTurnId) {
        checkpoint.activeTurn.startOffset = nextScanOffset;
      }
      if (terminalTurnId && checkpoint.activeTurn.turnId === terminalTurnId) {
        checkpoint.emittedTerminalTurnIds = [terminalTurnId, ...checkpoint.emittedTerminalTurnIds]
          .slice(0, MAX_EMITTED_TERMINAL_TURNS);
        this.nextStepInputMessages.delete(this.turnStateKey(filePath, terminalTurnId));
        checkpoint.activeTurn = null;
      }
    }

    checkpoint.scanOffset = nextScanOffset;
    this.saveCheckpoint(key, checkpoint);
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
    const recovered = await this.recoverTurn(filePath, checkpoint, pending.terminalEndOffset);
    if (recovered.length === 0) {
      this.logger.warn('pending Codex terminal turn still could not be reconstructed; will retry', {
        transcriptPath: filePath,
        turnId: pending.turnId,
      });
      return null;
    }
    checkpoint.emittedTerminalTurnIds = [pending.turnId, ...checkpoint.emittedTerminalTurnIds]
      .slice(0, MAX_EMITTED_TERMINAL_TURNS);
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

  private async recoverTurnSegment(
    filePath: string,
    checkpoint: CodexTranscriptCheckpoint,
    endOffset: number,
  ): Promise<AgentActivityEntry[]> {
    const activeTurn = checkpoint.activeTurn;
    if (!activeTurn) return [];
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
      { startedAtMs: activeTurn.startedAtMs },
    );
    if (!turn) return [];

    const stateKey = this.turnStateKey(filePath, activeTurn.turnId);
    const pendingInput = this.nextStepInputMessages.get(stateKey);
    if (pendingInput && turn.steps[0] && !turn.steps[0].inputMessages) {
      turn.steps[0].inputMessages = pendingInput;
    }

    const stepStart = (activeTurn.emittedStepCount ?? 0) + 1;
    const built = buildCodexTranscriptEntries(turn, {
      includePrompt: activeTurn.emittedPrompt !== true,
      startStepNumber: stepStart,
    });
    const entries = this.filterNewSegmentEntries(built, activeTurn);

    if (turn.prompt) activeTurn.emittedPrompt = true;
    activeTurn.emittedStepCount = (activeTurn.emittedStepCount ?? 0) + turn.steps.length;

    const lastStep = turn.steps.at(-1);
    const nextInput = lastStep ? toolResponseMessage(lastStep.tools) : undefined;
    if (nextInput) this.nextStepInputMessages.set(stateKey, [nextInput]);
    else if (turn.steps.length > 0) this.nextStepInputMessages.delete(stateKey);

    const resourceAttributes = await this.readWakeupResourceAttributes(turn.sessionId);
    return resourceAttributes ? attachWakeupResourceAttributes(entries, resourceAttributes) : entries;
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

  private turnStateKey(filePath: string, turnId: string): string {
    return `${filePath}:${turnId}`;
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
    const { nextOffset } = await scanJsonLines(filePath, 0, stat.size, line => {
      const payload = asRecord(line.record.payload);
      if (!payload) return;
      if (line.record.type === 'session_meta') {
        latestSessionMetaOffset = line.startOffset;
        return;
      }
      const turnId = turnIdForStart(line.record, payload);
      if (turnId && (!activeTurn || activeTurn.turnId !== turnId)) {
        activeTurn = {
          turnId,
          startOffset: line.startOffset,
          startedAtMs: timestampMs(line.record, Date.now()),
          emittedPrompt: true,
          emittedStepCount: 0,
          emittedStepRequestIds: [],
          emittedStepResponseIds: [],
          emittedToolCallIds: [],
          emittedToolResultIds: [],
        };
        return;
      }
      if (terminalTurnIdFor(line.record, payload) === activeTurn?.turnId) activeTurn = null;
    });
    const baselineActiveTurn = activeTurn as CodexActiveTranscriptTurn | null;
    if (baselineActiveTurn) {
      baselineActiveTurn.startOffset = nextOffset;
    }
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
    const activeTurn = active
      && typeof active.turnId === 'string'
      && typeof active.startOffset === 'number'
      && typeof active.startedAtMs === 'number'
      ? {
          turnId: active.turnId,
          startOffset: active.startOffset,
          startedAtMs: active.startedAtMs,
          emittedPrompt: active.emittedPrompt === true,
          emittedStepCount: typeof active.emittedStepCount === 'number' ? active.emittedStepCount : 0,
          emittedStepRequestIds: stringArray(active.emittedStepRequestIds),
          emittedStepResponseIds: stringArray(active.emittedStepResponseIds),
          emittedToolCallIds: stringArray(active.emittedToolCallIds),
          emittedToolResultIds: stringArray(active.emittedToolResultIds),
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
      emittedTerminalTurnIds: stringArray(value.emittedTerminalTurnIds)
        .slice(0, MAX_EMITTED_TERMINAL_TURNS),
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

function toolResponseMessage(tools: CodexTranscriptTool[]): JsonValue | undefined {
  const completed = tools.filter(tool => tool.completedAtMs !== undefined);
  if (completed.length === 0) return undefined;
  return {
    role: 'tool',
    parts: completed.map(tool => ({
      type: 'tool_call_response',
      id: tool.callId,
      response: tool.output ?? null,
    })),
  };
}

function safeWakeupSessionPart(value: string): string {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function defaultWakeupDir(): string {
  const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
  return path.join(dataDir, 'state', 'codex', 'transcript-wakeups');
}
