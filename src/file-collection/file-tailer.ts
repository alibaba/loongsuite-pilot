import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { FileCheckpoint } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FileTailer');

const MAX_READ_BYTES = 4 * 1024 * 1024; // 4MB per read
const MAX_FILES_PER_CYCLE = 100;

export interface ReadResult {
  lines: string[];
  checkpoint: FileCheckpoint;
  drainedLines?: string[];
}

export class FileTailer {
  private readonly filePaths: string[];
  private readonly encoding: BufferEncoding;
  private readonly maxDirSearchDepth: number;

  constructor(opts: {
    filePaths: string[];
    encoding?: string;
    maxDirSearchDepth?: number;
  }) {
    this.filePaths = opts.filePaths;
    this.encoding = (opts.encoding as BufferEncoding) || 'utf8';
    this.maxDirSearchDepth = opts.maxDirSearchDepth ?? 0;
  }

  discoverFiles(): string[] {
    const result: string[] = [];
    for (const pattern of this.filePaths) {
      const matched = matchGlob(pattern, this.maxDirSearchDepth);
      result.push(...matched);
      if (result.length >= MAX_FILES_PER_CYCLE) break;
    }
    return result.slice(0, MAX_FILES_PER_CYCLE);
  }

  async readNewLines(
    filePath: string,
    checkpoint: FileCheckpoint | null,
  ): Promise<ReadResult> {
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return {
        lines: [],
        checkpoint: checkpoint ?? { offset: 0, inode: 0 },
      };
    }

    const currentInode = stat.ino;

    if (!checkpoint || checkpoint.inode === 0) {
      return this.readFromOffset(filePath, 0, {
        offset: 0,
        inode: currentInode,
      });
    }

    if (currentInode === checkpoint.inode) {
      if (stat.size < checkpoint.offset) {
        logger.info('file truncated (copytruncate rotation), resetting offset', {
          file: filePath,
          recorded: checkpoint.offset,
          actual: stat.size,
        });
        return this.readFromOffset(filePath, 0, {
          offset: 0,
          inode: currentInode,
        });
      }
      return this.readFromOffset(filePath, checkpoint.offset, {
        offset: checkpoint.offset,
        inode: currentInode,
      });
    }

    // inode changed → rename rotation
    logger.info('inode changed (rename rotation detected)', {
      file: filePath,
      oldInode: checkpoint.inode,
      newInode: currentInode,
    });
    const drainedLines = await this.drainOldFile(
      path.dirname(filePath),
      checkpoint.inode,
      checkpoint.offset,
    );

    const newResult = await this.readFromOffset(filePath, 0, {
      offset: 0,
      inode: currentInode,
    });

    return {
      ...newResult,
      drainedLines,
    };
  }

  async drainOldFile(
    dir: string,
    oldInode: number,
    oldOffset: number,
  ): Promise<string[]> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const s = await fs.stat(fullPath);
        if (s.ino === oldInode) {
          if (s.size <= oldOffset) return [];
          const handle = await fs.open(fullPath, 'r');
          try {
            const readSize = Math.min(s.size - oldOffset, MAX_READ_BYTES);
            const buf = Buffer.alloc(readSize);
            await handle.read(buf, 0, readSize, oldOffset);
            const text = buf.toString(this.encoding);
            const lines = text.split('\n').filter((l) => l.length > 0);
            logger.info('drained old file after rotation', {
              file: fullPath,
              lines: lines.length,
            });
            return lines;
          } finally {
            await handle.close();
          }
        }
      } catch {
        continue;
      }
    }

    logger.warn('old file not found for rotation drain', {
      dir,
      oldInode,
    });
    return [];
  }

  private async readFromOffset(
    filePath: string,
    offset: number,
    baseCheckpoint: FileCheckpoint,
  ): Promise<ReadResult> {
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return { lines: [], checkpoint: baseCheckpoint };
    }

    if (stat.size <= offset) {
      return { lines: [], checkpoint: { ...baseCheckpoint, offset } };
    }

    const readSize = Math.min(stat.size - offset, MAX_READ_BYTES);
    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      const text = buf.toString(this.encoding);

      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        return { lines: [], checkpoint: { ...baseCheckpoint, offset } };
      }

      const completeText = text.substring(0, lastNewline);
      const lines = completeText.split('\n').filter((l) => l.length > 0);
      const newOffset =
        offset + Buffer.byteLength(text.substring(0, lastNewline + 1), this.encoding);

      return {
        lines,
        checkpoint: {
          offset: newOffset,
          inode: stat.ino,
        },
      };
    } finally {
      await handle.close();
    }
  }
}

function matchGlob(pattern: string, maxDepth: number): string[] {
  const dir = path.dirname(pattern);
  const filePattern = path.basename(pattern);

  if (!fsSync.existsSync(dir)) return [];

  const regex = globToRegex(filePattern);
  const results: string[] = [];
  collectFiles(dir, regex, 0, maxDepth, results);
  return results.sort();
}

function collectFiles(
  dir: string,
  regex: RegExp,
  currentDepth: number,
  maxDepth: number,
  results: string[],
): void {
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_FILES_PER_CYCLE) return;

    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && regex.test(entry.name)) {
      results.push(fullPath);
    } else if (entry.isDirectory() && currentDepth < maxDepth) {
      collectFiles(fullPath, regex, currentDepth + 1, maxDepth, results);
    }
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '[^/]*');
  return new RegExp(`^${regexStr}$`);
}
