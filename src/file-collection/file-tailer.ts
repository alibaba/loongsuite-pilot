import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { FileCheckpoint } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FileTailer');

const MAX_READ_BYTES = 4 * 1024 * 1024; // 4MB per read
const MAX_FILES_PER_CYCLE = 100;
const SIGNATURE_BYTES = 1024; // first 1KB for file signature

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
      const sig = await computeFileSignature(filePath);
      return this.readFromOffset(filePath, 0, {
        offset: 0,
        inode: currentInode,
        signature: sig,
      });
    }

    if (currentInode === checkpoint.inode) {
      // Same inode: check for copytruncate via size OR signature
      if (stat.size < checkpoint.offset) {
        logger.info('file truncated (copytruncate rotation, size < offset), resetting', {
          file: filePath,
          recorded: checkpoint.offset,
          actual: stat.size,
        });
        const sig = await computeFileSignature(filePath);
        return this.readFromOffset(filePath, 0, {
          offset: 0,
          inode: currentInode,
          signature: sig,
        });
      }

      // Size >= offset: could still be copytruncate if new data filled past old offset.
      // Compare file head signature to detect this case.
      if (checkpoint.signature) {
        const currentSig = await computeFileSignature(filePath);
        if (currentSig !== checkpoint.signature) {
          logger.info('file head signature changed (copytruncate rotation, content replaced), resetting', {
            file: filePath,
            oldSignature: checkpoint.signature.substring(0, 16),
            newSignature: currentSig.substring(0, 16),
          });
          return this.readFromOffset(filePath, 0, {
            offset: 0,
            inode: currentInode,
            signature: currentSig,
          });
        }
      }

      return this.readFromOffset(filePath, checkpoint.offset, {
        offset: checkpoint.offset,
        inode: currentInode,
        signature: checkpoint.signature,
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

    const sig = await computeFileSignature(filePath);
    const newResult = await this.readFromOffset(filePath, 0, {
      offset: 0,
      inode: currentInode,
      signature: sig,
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
          const allLines: string[] = [];
          const handle = await fs.open(fullPath, 'r');
          try {
            let pos = oldOffset;
            while (pos < s.size) {
              const readSize = Math.min(s.size - pos, MAX_READ_BYTES);
              const buf = Buffer.alloc(readSize);
              await handle.read(buf, 0, readSize, pos);
              const text = buf.toString(this.encoding);
              const lastNewline = text.lastIndexOf('\n');
              if (lastNewline === -1) break;
              const completeText = text.substring(0, lastNewline);
              allLines.push(...completeText.split('\n').filter((l) => l.length > 0));
              pos += Buffer.byteLength(text.substring(0, lastNewline + 1), this.encoding);
            }
            logger.info('drained old file after rotation', {
              file: fullPath,
              lines: allLines.length,
            });
            return allLines;
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

    const allLines: string[] = [];
    const handle = await fs.open(filePath, 'r');
    try {
      let pos = offset;
      while (pos < stat.size) {
        const readSize = Math.min(stat.size - pos, MAX_READ_BYTES);
        const buf = Buffer.alloc(readSize);
        await handle.read(buf, 0, readSize, pos);
        const text = buf.toString(this.encoding);
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) break;
        const completeText = text.substring(0, lastNewline);
        allLines.push(...completeText.split('\n').filter((l) => l.length > 0));
        pos += Buffer.byteLength(text.substring(0, lastNewline + 1), this.encoding);
      }

      return {
        lines: allLines,
        checkpoint: {
          offset: pos,
          inode: stat.ino,
          signature: baseCheckpoint.signature,
        },
      };
    } finally {
      await handle.close();
    }
  }
}

async function computeFileSignature(filePath: string): Promise<string> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SIGNATURE_BYTES, 0);
    if (bytesRead === 0) return '';
    return crypto.createHash('md5').update(buf.subarray(0, bytesRead)).digest('hex');
  } catch {
    return '';
  } finally {
    await handle?.close();
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
