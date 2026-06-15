import * as fs from 'node:fs/promises';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';

export interface SessionInputOptions extends InputOptions {
  /** Glob-like base directory to scan for session files. */
  sessionDir: string;
  /** File name pattern (e.g. "rollout-*.jsonl"). */
  filePattern: string;
}

/**
 * Base input for session file polling (e.g. Codex CLI, OpenCode).
 * Reads JSONL session files with offset tracking per file (inode-aware rotation).
 *
 * Subclass must implement:
 *   - discoverSessionFiles(): list session files to process
 *   - processSessionLine(): handle a single JSONL line from a session file
 */
export abstract class BaseSessionInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  protected readonly sessionDir: string;
  protected readonly filePattern: string;

  constructor(opts: SessionInputOptions) {
    super(opts);
    this.sessionDir = opts.sessionDir;
    this.filePattern = opts.filePattern;
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const allEntries: AgentActivityEntry[] = [];

    for (const filePath of files) {
      const entries = await this.processFile(filePath);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  private async processFile(filePath: string): Promise<AgentActivityEntry[]> {
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    const prevOffset = this.stateStore.getOffset(stateKey);
    const prevState = this.stateStore.get(stateKey);
    const prevInode = prevState.extra?.inode as number | undefined;

    // Detect file rotation via inode change
    if (prevInode !== undefined && prevInode !== (stat as any).ino) {
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });
    }

    let offset = this.stateStore.getOffset(stateKey);
    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated or rotated, resetting offset', {
        file: filePath,
        recorded: offset,
        actual: stat.size,
      });
      offset = 0;
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: Number((stat as any).ino) } });
    }
    if (stat.size <= offset) return [];

    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');
      this.stateStore.setOffset(stateKey, stat.size);
      this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });

      const entries: AgentActivityEntry[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const entry = await this.processSessionLine(parsed, filePath);
          if (entry) entries.push(entry);
        } catch (err) {
          this.logger.warn('invalid session line', { file: filePath, error: String(err) });
        }
      }
      return entries;
    } finally {
      await handle.close();
    }
  }

  /** Discover session files to process. */
  protected abstract discoverSessionFiles(): Promise<string[]>;

  /** Process a single parsed JSON line from a session file. Return null to skip. */
  protected abstract processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null>;
}
