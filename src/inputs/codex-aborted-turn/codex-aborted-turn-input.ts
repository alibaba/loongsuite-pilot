import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { buildCodexAbortedTurnEntries } from './codex-aborted-turn-builder.js';
import {
  extractAbortedTurn,
  extractCodexTranscriptMeta,
  sessionIdFromTranscriptPath,
} from './codex-aborted-turn-extractor.js';
import {
  MAX_EMITTED_ABORTED_TURNS,
  type CodexAbortedCheckpoint,
} from './codex-aborted-turn-types.js';

const DEFAULT_SESSION_DIR = '~/.codex/sessions';

export interface CodexAbortedTurnInputOptions extends InputOptions {
  sessionDir?: string;
}

interface JsonLine {
  startOffset: number;
  endOffset: number;
  record: Record<string, unknown>;
}

export class CodexAbortedTurnInput extends BaseInput {
  readonly id = 'codex-aborted-turn';
  readonly agentType = ClientType.CodexCliHook;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly sessionDir: string;
  private collecting: Promise<AgentActivityEntry[]> | null = null;

  constructor(opts: CodexAbortedTurnInputOptions) {
    super({
      stateStore: opts.stateStore,
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.sessionDir = opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR);
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
      if (this.readCheckpoint(key)) continue;
      await this.baselineFile(filePath, key);
    }
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    if (this.collecting) return this.collecting;
    this.collecting = this.collectOnce().finally(() => {
      this.collecting = null;
    });
    return this.collecting;
  }

  private async collectOnce(): Promise<AgentActivityEntry[]> {
    const entries: AgentActivityEntry[] = [];
    for (const filePath of await this.discoverSessionFiles()) {
      entries.push(...await this.processFile(filePath));
    }
    return entries;
  }

  private async processFile(filePath: string): Promise<AgentActivityEntry[]> {
    const key = this.stateKey(filePath);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    let checkpoint = this.readCheckpoint(key);
    if (!checkpoint) {
      checkpoint = {
        inode: stat.ino,
        scanOffset: 0,
        activeTurn: null,
        latestSessionMetaOffset: null,
        emittedAbortedTurnIds: [],
      };
    } else if (checkpoint.inode !== stat.ino) {
      await this.baselineFile(filePath, key);
      return [];
    }

    if (stat.size <= checkpoint.scanOffset) return [];
    const lines = await readJsonLines(filePath, checkpoint.scanOffset, stat.size);
    if (lines.nextOffset === checkpoint.scanOffset) return [];

    const entries: AgentActivityEntry[] = [];
    for (const line of lines.items) {
      const payload = asRecord(line.record.payload);
      if (!payload) continue;
      if (line.record.type === 'session_meta') {
        checkpoint.latestSessionMetaOffset = line.startOffset;
        continue;
      }

      if (line.record.type === 'event_msg' && payload.type === 'task_started') {
        const turnId = stringValue(payload.turn_id);
        if (turnId) {
          checkpoint.activeTurn = {
            turnId,
            startOffset: line.startOffset,
            startedAtMs: timestampMs(line.record),
          };
        }
        continue;
      }

      if (line.record.type === 'turn_context') {
        const turnId = stringValue(payload.turn_id);
        if (turnId && (!checkpoint.activeTurn || checkpoint.activeTurn.turnId !== turnId)) {
          checkpoint.activeTurn = {
            turnId,
            startOffset: line.startOffset,
            startedAtMs: timestampMs(line.record),
          };
        }
        continue;
      }

      if (line.record.type !== 'event_msg' || payload.type !== 'turn_aborted') continue;
      const turnId = stringValue(payload.turn_id);
      if (!turnId || checkpoint.activeTurn?.turnId !== turnId) continue;
      if (!checkpoint.emittedAbortedTurnIds.includes(turnId)) {
        const recovered = await this.recoverTurn(filePath, checkpoint, line.endOffset);
        if (recovered.length > 0) {
          entries.push(...recovered);
          checkpoint.emittedAbortedTurnIds = [turnId, ...checkpoint.emittedAbortedTurnIds]
            .slice(0, MAX_EMITTED_ABORTED_TURNS);
        }
      }
      checkpoint.activeTurn = null;
    }

    checkpoint.scanOffset = lines.nextOffset;
    this.saveCheckpoint(key, checkpoint);
    return entries;
  }

  private async recoverTurn(
    filePath: string,
    checkpoint: CodexAbortedCheckpoint,
    abortEndOffset: number,
  ): Promise<AgentActivityEntry[]> {
    const activeTurn = checkpoint.activeTurn;
    if (!activeTurn) return [];
    const range = await readJsonLines(filePath, activeTurn.startOffset, abortEndOffset);
    const metaRecord = checkpoint.latestSessionMetaOffset === null
      ? null
      : await readJsonLineAt(filePath, checkpoint.latestSessionMetaOffset);
    const meta = metaRecord ? extractCodexTranscriptMeta(metaRecord) : null;
    const turn = extractAbortedTurn(
      range.items.map(line => line.record),
      meta,
      sessionIdFromTranscriptPath(filePath),
      activeTurn.turnId,
    );
    return turn ? buildCodexAbortedTurnEntries(turn) : [];
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
    for (const line of lines.items) {
      if (line.record.type === 'session_meta') latestSessionMetaOffset = line.startOffset;
    }
    this.saveCheckpoint(key, {
      inode: stat.ino,
      scanOffset: stat.size,
      activeTurn: null,
      latestSessionMetaOffset,
      emittedAbortedTurnIds: [],
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

  private readCheckpoint(key: string): CodexAbortedCheckpoint | null {
    const raw = this.stateStore.get(key).extra?.codexAbortedTurn;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.inode !== 'number' || typeof value.scanOffset !== 'number') return null;
    const active = asRecord(value.activeTurn);
    const activeTurn = active
      && typeof active.turnId === 'string'
      && typeof active.startOffset === 'number'
      && typeof active.startedAtMs === 'number'
      ? { turnId: active.turnId, startOffset: active.startOffset, startedAtMs: active.startedAtMs }
      : null;
    return {
      inode: value.inode,
      scanOffset: value.scanOffset,
      activeTurn,
      latestSessionMetaOffset: typeof value.latestSessionMetaOffset === 'number'
        ? value.latestSessionMetaOffset
        : null,
      emittedAbortedTurnIds: Array.isArray(value.emittedAbortedTurnIds)
        ? value.emittedAbortedTurnIds.filter((id): id is string => typeof id === 'string')
          .slice(0, MAX_EMITTED_ABORTED_TURNS)
        : [],
    };
  }

  private saveCheckpoint(key: string, checkpoint: CodexAbortedCheckpoint): void {
    const current = this.stateStore.get(key);
    this.stateStore.update(key, {
      lastOffset: checkpoint.scanOffset,
      extra: {
        ...(current.extra ?? {}),
        codexAbortedTurn: checkpoint,
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
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(endOffset - startOffset);
    await handle.read(buffer, 0, buffer.length, startOffset);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return { items: [], nextOffset: startOffset };
    const items: JsonLine[] = [];
    let cursor = 0;
    while (cursor <= lastNewline) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0 || newline > lastNewline) break;
      const text = buffer.subarray(cursor, newline).toString('utf8').trim();
      const lineStart = startOffset + cursor;
      const lineEnd = startOffset + newline + 1;
      if (text) {
        try {
          const record = JSON.parse(text);
          if (record && typeof record === 'object' && !Array.isArray(record)) {
            items.push({ startOffset: lineStart, endOffset: lineEnd, record });
          }
        } catch {
          // Invalid completed lines are ignored but still advance the cursor.
        }
      }
      cursor = newline + 1;
    }
    return { items, nextOffset: startOffset + lastNewline + 1 };
  } finally {
    await handle.close();
  }
}

async function readJsonLineAt(filePath: string, offset: number): Promise<Record<string, unknown> | null> {
  const stat = await fs.stat(filePath);
  const lines = await readJsonLines(filePath, offset, stat.size);
  return lines.items[0]?.record ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timestampMs(record: Record<string, unknown>): number {
  const timestamp = stringValue(record.timestamp);
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}
