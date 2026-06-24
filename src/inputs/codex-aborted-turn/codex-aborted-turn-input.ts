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
  MAX_PENDING_COMPLETED_TURNS,
  type CodexAbortedCheckpoint,
} from './codex-aborted-turn-types.js';
import { asRecord, stringValue, timestampMs } from './codex-aborted-turn-utils.js';

const DEFAULT_SESSION_DIR = '~/.codex/sessions';
const DEFAULT_HOOK_STATE_DIR = '~/.loongsuite-pilot/state/codex/sessions';
const DEFAULT_DIAGNOSTIC_DIR = '~/.loongsuite-pilot/logs/diagnostics';
const DEFAULT_HOOK_GAP_GRACE_MS = 60_000;

export interface CodexAbortedTurnInputOptions extends InputOptions {
  sessionDir?: string;
  hookStateDir?: string;
  diagnosticDir?: string;
  hookGapGraceMs?: number;
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
  private readonly hookStateDir: string;
  private readonly diagnosticDir: string;
  private readonly hookGapGraceMs: number;
  private collecting: Promise<AgentActivityEntry[]> | null = null;

  constructor(opts: CodexAbortedTurnInputOptions) {
    super({
      stateStore: opts.stateStore,
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.sessionDir = opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR);
    this.hookStateDir = opts.hookStateDir ?? resolveHome(DEFAULT_HOOK_STATE_DIR);
    this.diagnosticDir = opts.diagnosticDir ?? resolveHome(DEFAULT_DIAGNOSTIC_DIR);
    this.hookGapGraceMs = opts.hookGapGraceMs ?? DEFAULT_HOOK_GAP_GRACE_MS;
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
        latestSessionId: null,
        emittedAbortedTurnIds: [],
        pendingCompletedTurns: [],
        emittedHookGapTurnIds: [],
      };
    } else if (checkpoint.inode !== stat.ino) {
      await this.baselineFile(filePath, key);
      return [];
    }

    if (stat.size <= checkpoint.scanOffset) {
      await this.emitDueHookGapWarnings(checkpoint);
      this.saveCheckpoint(key, checkpoint);
      return [];
    }
    const lines = await readJsonLines(filePath, checkpoint.scanOffset, stat.size);
    if (lines.nextOffset === checkpoint.scanOffset) return [];

    const entries: AgentActivityEntry[] = [];
    for (const line of lines.items) {
      const payload = asRecord(line.record.payload);
      if (!payload) continue;
      if (line.record.type === 'session_meta') {
        checkpoint.latestSessionMetaOffset = line.startOffset;
        checkpoint.latestSessionId = extractCodexTranscriptMeta(line.record)?.sessionId ?? checkpoint.latestSessionId;
        continue;
      }

      if (line.record.type === 'event_msg' && payload.type === 'task_started') {
        const turnId = stringValue(payload.turn_id);
        if (turnId && (!checkpoint.activeTurn || checkpoint.activeTurn.turnId !== turnId)) {
          checkpoint.activeTurn = {
            turnId,
            startOffset: line.startOffset,
            startedAtMs: timestampMs(line.record) ?? Date.now(),
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
            startedAtMs: timestampMs(line.record) ?? Date.now(),
          };
        }
        continue;
      }

      if (line.record.type !== 'event_msg') continue;
      if (payload.type === 'task_complete') {
        const turnId = stringValue(payload.turn_id);
        if (turnId && checkpoint.activeTurn?.turnId === turnId && !checkpoint.emittedHookGapTurnIds.includes(turnId)) {
          checkpoint.pendingCompletedTurns.push({
            turnId,
            sessionId: checkpoint.latestSessionId ?? sessionIdFromTranscriptPath(filePath),
            completedAtMs: timestampMs(line.record) ?? Date.now(),
          });
          checkpoint.pendingCompletedTurns = checkpoint.pendingCompletedTurns
            .slice(-MAX_PENDING_COMPLETED_TURNS);
          checkpoint.activeTurn = null;
        }
        continue;
      }
      if (payload.type !== 'turn_aborted') continue;
      const turnId = stringValue(payload.turn_id);
      if (!turnId || checkpoint.activeTurn?.turnId !== turnId) continue;
      if (!checkpoint.emittedAbortedTurnIds.includes(turnId)) {
        const recovered = await this.recoverTurn(filePath, checkpoint, line.endOffset);
        if (recovered.length > 0) {
          entries.push(...recovered);
          checkpoint.emittedAbortedTurnIds = [turnId, ...checkpoint.emittedAbortedTurnIds]
            .slice(0, MAX_EMITTED_ABORTED_TURNS);
        } else {
          await this.emitRecoveryFailureDiagnostic(filePath, turnId, line.record);
        }
      }
      checkpoint.activeTurn = null;
    }

    checkpoint.scanOffset = lines.nextOffset;
    await this.emitDueHookGapWarnings(checkpoint);
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
      latestSessionId: null,
      emittedAbortedTurnIds: [],
      pendingCompletedTurns: [],
      emittedHookGapTurnIds: [],
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
      latestSessionId: typeof value.latestSessionId === 'string' ? value.latestSessionId : null,
      emittedAbortedTurnIds: Array.isArray(value.emittedAbortedTurnIds)
        ? value.emittedAbortedTurnIds.filter((id): id is string => typeof id === 'string')
          .slice(0, MAX_EMITTED_ABORTED_TURNS)
        : [],
      pendingCompletedTurns: readCompletedTurns(value.pendingCompletedTurns),
      emittedHookGapTurnIds: Array.isArray(value.emittedHookGapTurnIds)
        ? value.emittedHookGapTurnIds.filter((id): id is string => typeof id === 'string')
          .slice(0, MAX_PENDING_COMPLETED_TURNS)
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

  private async emitDueHookGapWarnings(checkpoint: CodexAbortedCheckpoint): Promise<void> {
    const now = Date.now();
    const pending: typeof checkpoint.pendingCompletedTurns = [];
    for (const completed of checkpoint.pendingCompletedTurns) {
      if (now - completed.completedAtMs < this.hookGapGraceMs) {
        pending.push(completed);
        continue;
      }
      if (await this.hasHookState(completed.sessionId)) continue;
      try {
        await fs.mkdir(this.diagnosticDir, { recursive: true });
        const day = new Date(completed.completedAtMs).toISOString().slice(0, 10);
        await fs.appendFile(path.join(this.diagnosticDir, `codex-hook-gap-${day}.jsonl`), JSON.stringify({
          type: 'codex_hook_missing',
          session_id: completed.sessionId,
          transcript_turn_id: completed.turnId,
          completed_at: new Date(completed.completedAtMs).toISOString(),
          detected_at: new Date(now).toISOString(),
        }) + '\n', 'utf8');
        this.logger.warn('Codex Hook state missing for completed transcript turn', {
          sessionId: completed.sessionId,
          transcriptTurnId: completed.turnId,
        });
        checkpoint.emittedHookGapTurnIds = [completed.turnId, ...checkpoint.emittedHookGapTurnIds]
          .slice(0, MAX_PENDING_COMPLETED_TURNS);
      } catch (error) {
        this.logger.warn('failed to write Codex Hook gap diagnostic', {
          sessionId: completed.sessionId,
          transcriptTurnId: completed.turnId,
          error: String(error),
        });
        pending.push(completed);
      }
    }
    checkpoint.pendingCompletedTurns = pending;
  }

  private async emitRecoveryFailureDiagnostic(
    filePath: string,
    turnId: string,
    abortRecord: Record<string, unknown>,
  ): Promise<void> {
    const reason = timestampMs(abortRecord) === undefined
      ? 'missing_or_invalid_abort_timestamp'
      : 'no_entries_recovered';
    try {
      await fs.mkdir(this.diagnosticDir, { recursive: true });
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      await fs.appendFile(path.join(this.diagnosticDir, `codex-aborted-turn-recovery-failed-${day}.jsonl`), JSON.stringify({
        type: 'codex_aborted_turn_recovery_failed',
        transcript_path: filePath,
        transcript_turn_id: turnId,
        reason,
        detected_at: now.toISOString(),
      }) + '\n', 'utf8');
      this.logger.warn('Codex aborted turn recovery produced no entries', { filePath, turnId, reason });
    } catch (error) {
      this.logger.warn('failed to write Codex aborted turn recovery diagnostic', {
        filePath,
        turnId,
        error: String(error),
      });
    }
  }

  private async hasHookState(sessionId: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.hookStateDir, `${sessionId}.json`));
      return true;
    } catch {
      return false;
    }
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
  const available = stat.size - offset;
  if (available <= 0) return null;
  const handle = await fs.open(filePath, 'r');
  try {
    let size = Math.min(64 * 1024, available);
    while (size > 0) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newline >= 0) {
        try {
          return asRecord(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
        } catch {
          return null;
        }
      }
      if (bytesRead < size || size === available) return null;
      size = Math.min(size * 2, available);
    }
    return null;
  } finally {
    await handle.close();
  }
}

function readCompletedTurns(value: unknown): CodexAbortedCheckpoint['pendingCompletedTurns'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const record = asRecord(item);
    const turnId = record && stringValue(record.turnId);
    const sessionId = record && stringValue(record.sessionId);
    const completedAtMs = record?.completedAtMs;
    return turnId && sessionId && typeof completedAtMs === 'number'
      ? [{ turnId, sessionId, completedAtMs }]
      : [];
  }).slice(-MAX_PENDING_COMPLETED_TURNS);
}
