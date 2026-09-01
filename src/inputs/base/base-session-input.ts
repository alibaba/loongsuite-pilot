import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
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

    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, 'r');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return []; // rotated away between discovery and open
      if (code === 'EACCES' || code === 'EPERM') {
        // Almost always an ownership mismatch: a process running as a different
        // uid (commonly root) loaded the plugin and wrote this file 0600. One
        // unreadable file must not abort the whole cycle — diagnose it once and
        // keep collecting the remaining files.
        await this.diagnoseUnreadablePath(filePath, 'event file');
        return [];
      }
      throw err;
    }
    try {
      const buf = Buffer.alloc(stat.size - offset);
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      const bytes = buf.subarray(0, bytesRead);
      const lastNewline = bytes.lastIndexOf(0x0a);
      this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });
      if (lastNewline < 0) {
        this.reportRawInput({ records: 0, bytes: 0, maxBatchBytes: buf.length });
        return [];
      }

      const completeBytes = bytes.subarray(0, lastNewline + 1);
      const text = completeBytes.toString('utf-8');
      this.stateStore.setOffset(stateKey, offset + completeBytes.length);

      const entries: AgentActivityEntry[] = [];
      const lines = text.split('\n').filter(line => line.trim().length > 0);
      this.reportRawInput({
        records: lines.length,
        bytes: completeBytes.length,
        maxBatchBytes: buf.length,
      });
      for (const line of lines) {
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
