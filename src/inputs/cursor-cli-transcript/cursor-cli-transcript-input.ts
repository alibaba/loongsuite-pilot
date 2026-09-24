import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';
import { BaseSessionInput, type SessionInputOptions } from '../base/base-session-input.js';
import {
  buildTurnEntries,
  parseTranscriptRow,
  type CursorCliRow,
  type CursorCliTurn,
} from './cursor-cli-transcript.js';

const DEFAULT_PROJECTS_DIR = '~/.cursor/projects';
const MAX_WALK_DEPTH = 4;
const READ_BUDGET_BYTES = 8 * 1024 * 1024;
const logger = createLogger('CursorCliTranscriptInput');

interface PendingRow {
  row: CursorCliRow;
  endOffset: number;
}

export interface CursorCliTranscriptInputOptions
  extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
  projectsDir?: string;
}

export class CursorCliTranscriptInput extends BaseSessionInput {
  readonly id = 'cursor-cli-transcript';
  readonly agentType = ClientType.CursorCli;
  private readonly projectsDir: string;
  private readonly pending = new Map<string, PendingRow[]>();

  constructor(opts: CursorCliTranscriptInputOptions) {
    super({
      stateStore: opts.stateStore,
      sessionDir: opts.sessionDir ?? resolveHome(DEFAULT_PROJECTS_DIR),
      filePattern: opts.filePattern ?? '*.jsonl',
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.projectsDir = opts.projectsDir ?? resolveHome(DEFAULT_PROJECTS_DIR);
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_PROJECTS_DIR));
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_PROJECTS_DIR)];
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    const out: string[] = [];
    await this.walk(this.projectsDir, 0, out);
    return out.sort();
  }

  private async walk(dir: string, depth: number, out: string[]): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, depth + 1, out);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && full.includes('agent-transcripts')) {
        out.push(full);
      }
    }
  }

  protected async processSessionLine(): Promise<AgentActivityEntry | null> {
    throw new Error('CursorCliTranscriptInput.collect drives line processing directly');
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const entries: AgentActivityEntry[] = [];
    for (const filePath of files) {
      try {
        entries.push(...await this.processTranscriptFile(filePath));
      } catch (err) {
        if (this.isUnreadableError(err)) {
          await this.diagnoseUnreadablePath(filePath, 'event file');
          continue;
        }
        throw err;
      }
    }
    return entries;
  }

  private async processTranscriptFile(filePath: string): Promise<AgentActivityEntry[]> {
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }
    let offset = this.stateStore.getOffset(stateKey);
    if (offset > 0 && stat.size < offset) {
      logger.info('cursor cli transcript truncated, resetting offset', {
        file: filePath,
        recorded: offset,
        actual: stat.size,
      });
      offset = 0;
      this.stateStore.setOffset(stateKey, 0);
      this.pending.delete(filePath);
    }
    if (stat.size > offset) {
      const end = Math.min(stat.size, offset + READ_BUDGET_BYTES);
      const rows = await this.readCompleteRows(filePath, offset, end);
      const pending = this.pending.get(filePath) ?? [];
      pending.push(...rows);
      this.pending.set(filePath, pending);
    }
    const sessionId = path.basename(path.dirname(filePath));
    const timeNanos = `${Math.trunc(stat.mtimeMs)}000000`;
    let turnSeq = this.turnCount(filePath);
    const entries: AgentActivityEntry[] = [];
    const pending = this.pending.get(filePath) ?? [];
    let turnStart = 0;
    let turn: CursorCliTurn | null = null;
    const openTurn = (): CursorCliTurn => {
      turn ??= { userTexts: [], assistantTexts: [], toolCalls: [], status: 'unknown' };
      return turn;
    };
    const flushTurn = (endOffset: number): void => {
      if (turn && this.turnHasContent(turn)) {
        turnSeq += 1;
        entries.push(...buildTurnEntries(sessionId, turnSeq, turn, timeNanos));
        this.setTurnCount(filePath, turnSeq);
      }
      this.stateStore.setOffset(stateKey, endOffset);
      turn = null;
    };
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      if (item.row.kind === 'user') {
        if (turn && this.turnHasContent(turn)) {
          flushTurn(pending[index - 1].endOffset);
          turnStart = index;
        }
        if (item.row.text.length > 0) openTurn().userTexts.push(item.row.text);
        else openTurn();
      } else if (item.row.kind === 'assistant') {
        const open = openTurn();
        open.assistantTexts.push(...item.row.texts);
        open.toolCalls.push(...item.row.toolCalls);
      } else {
        openTurn().status = item.row.status;
        flushTurn(item.endOffset);
        turnStart = index + 1;
      }
    }
    this.pending.set(filePath, turn ? pending.slice(turnStart) : []);
    return entries;
  }

  private turnHasContent(turn: CursorCliTurn): boolean {
    return turn.userTexts.length > 0 || turn.assistantTexts.length > 0 || turn.toolCalls.length > 0;
  }

  private turnCount(filePath: string): number {
    const extra = this.stateStore.get(`${this.id}:${filePath}`).extra ?? {};
    return typeof extra.cursorCliTurns === 'number' ? extra.cursorCliTurns : 0;
  }

  private setTurnCount(filePath: string, count: number): void {
    this.stateStore.update(`${this.id}:${filePath}`, { extra: { cursorCliTurns: count } });
  }

  private async readCompleteRows(
    filePath: string,
    offset: number,
    end: number,
  ): Promise<PendingRow[]> {
    const rows: PendingRow[] = [];
    if (end <= offset) return rows;
    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(end - offset);
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      const bytes = buf.subarray(0, bytesRead);
      const lastNewline = bytes.lastIndexOf(0x0a);
      if (lastNewline < 0) return rows;
      const text = bytes.subarray(0, lastNewline + 1).toString('utf-8');
      let position = offset;
      for (const line of text.split('\n')) {
        const lineBytes = Buffer.byteLength(line) + 1;
        if (!line.trim()) {
          position += lineBytes;
          continue;
        }
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            position += lineBytes;
            continue;
          }
          const row = parseTranscriptRow(parsed);
          if (row) rows.push({ row, endOffset: position + lineBytes });
        } catch (err) {
          logger.warn('invalid cursor cli transcript line', { file: filePath, error: String(err) });
        }
        position += lineBytes;
      }
      return rows;
    } finally {
      await handle.close();
    }
  }
}
