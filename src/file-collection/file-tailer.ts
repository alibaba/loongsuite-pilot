import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { FileCheckpoint, FileReaderState, DevInode } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FileTailer');

const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_FILES_PER_CYCLE = 100;
const SIGNATURE_BYTES = 1024;
const MAX_READER_QUEUE_LENGTH = 20;
const READER_TIMEOUT_MS = 3_600_000;
const MAX_CACHE_BYTES = 1024 * 1024;

export interface ReadResult {
  lines: string[];
  checkpoint: FileCheckpoint;
  hasMore: boolean;
}

export class FileTailer {
  private readonly filePaths: string[];
  private readonly encoding: BufferEncoding;
  private readonly maxDirSearchDepth: number;
  private readerQueues: Map<string, FileReaderState[]> = new Map();

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

  async initReaderFromCheckpoint(filePath: string, checkpoint: FileCheckpoint): Promise<boolean> {
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      logger.info('checkpoint file no longer exists, skipping', { file: filePath });
      return false;
    }

    if (stat.dev !== checkpoint.dev || stat.ino !== checkpoint.inode) {
      logger.info('checkpoint dev/inode mismatch, skipping', {
        file: filePath,
        checkpointDev: checkpoint.dev,
        checkpointInode: checkpoint.inode,
        actualDev: stat.dev,
        actualInode: stat.ino,
      });
      return false;
    }

    if (checkpoint.signatureHash) {
      const currentSig = await computeFileSignature(filePath);
      if (currentSig && currentSig !== checkpoint.signatureHash) {
        logger.info('inode reused (signature mismatch), discarding checkpoint', {
          file: filePath,
          inode: checkpoint.inode,
          savedSig: checkpoint.signatureHash,
          currentSig,
        });
        return false;
      }
    }

    const reader: FileReaderState = {
      filePath,
      devInode: { dev: checkpoint.dev, ino: checkpoint.inode },
      offset: checkpoint.offset,
      signatureHash: checkpoint.signatureHash,
      lastUpdateTime: checkpoint.lastUpdateTime || Date.now(),
      cache: checkpoint.cache || '',
      deleted: false,
      deletedTime: 0,
    };

    const existing = this.readerQueues.get(filePath);
    if (existing) {
      existing.push(reader);
    } else {
      this.readerQueues.set(filePath, [reader]);
    }
    return true;
  }

  getActiveFiles(): string[] {
    return [...this.readerQueues.keys()];
  }

  getCheckpoints(): Map<string, FileCheckpoint> {
    const result = new Map<string, FileCheckpoint>();
    for (const [filePath, queue] of this.readerQueues) {
      const latestReader = queue[queue.length - 1];
      if (latestReader) {
        result.set(filePath, this.readerToCheckpoint(latestReader));
      }
    }
    return result;
  }

  getAllReaderCheckpoints(): Map<string, FileCheckpoint> {
    const result = new Map<string, FileCheckpoint>();
    for (const [filePath, queue] of this.readerQueues) {
      for (const reader of queue) {
        const key = `${filePath}*${reader.devInode.dev}*${reader.devInode.ino}`;
        result.set(key, this.readerToCheckpoint(reader));
      }
    }
    return result;
  }

  async readNewLines(filePath: string, checkpoint?: FileCheckpoint | null): Promise<ReadResult> {
    if (checkpoint && !this.readerQueues.has(filePath)) {
      await this.initReaderFromCheckpoint(filePath, checkpoint);
    }

    let queue = this.readerQueues.get(filePath);

    if (!queue || queue.length === 0) {
      let stat: fsSync.Stats;
      try {
        stat = await fs.stat(filePath);
      } catch {
        return this.emptyResult();
      }
      const sig = await computeFileSignature(filePath);
      const reader: FileReaderState = {
        filePath,
        devInode: { dev: stat.dev, ino: stat.ino },
        offset: 0,
        signatureHash: sig,
        lastUpdateTime: Date.now(),
        cache: '',
        deleted: false,
        deletedTime: 0,
      };
      queue = [reader];
      this.readerQueues.set(filePath, queue);
    }

    await this.detectRotation(filePath, queue);

    return this.processQueue(filePath, queue);
  }

  async checkRotation(filePath: string): Promise<void> {
    const queue = this.readerQueues.get(filePath);
    if (!queue || queue.length === 0) return;
    await this.detectRotation(filePath, queue);
  }

  refreshReaderTimestamps(): void {
    const now = Date.now();
    for (const [, queue] of this.readerQueues) {
      for (const reader of queue) {
        reader.lastUpdateTime = now;
        if (reader.deleted) {
          reader.deletedTime = now;
        }
      }
    }
  }

  cleanupStaleReaders(): void {
    const now = Date.now();
    for (const [filePath, queue] of this.readerQueues) {
      const filtered = queue.filter((reader) => {
        if (reader.deleted && now - reader.deletedTime > READER_TIMEOUT_MS && now - reader.lastUpdateTime > READER_TIMEOUT_MS) {
          return false;
        }
        if (!reader.deleted && now - reader.lastUpdateTime > READER_TIMEOUT_MS) {
          return false;
        }
        return true;
      });
      if (filtered.length === 0) {
        this.readerQueues.delete(filePath);
      } else {
        this.readerQueues.set(filePath, filtered);
      }
    }
  }

  private async detectRotation(filePath: string, queue: FileReaderState[]): Promise<void> {
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      const latest = queue[queue.length - 1];
      if (latest && !latest.deleted) {
        latest.deleted = true;
        latest.deletedTime = Date.now();
      }
      return;
    }

    const latestReader = queue[queue.length - 1];

    if (latestReader.devInode.ino !== stat.ino || latestReader.devInode.dev !== stat.dev) {
      logger.info('inode changed (rename rotation detected)', {
        file: filePath,
        oldInode: latestReader.devInode.ino,
        newInode: stat.ino,
      });
      latestReader.deleted = true;
      latestReader.deletedTime = Date.now();

      const sig = await computeFileSignature(filePath);
      const newReader: FileReaderState = {
        filePath,
        devInode: { dev: stat.dev, ino: stat.ino },
        offset: 0,
        signatureHash: sig,
        lastUpdateTime: Date.now(),
        cache: '',
        deleted: false,
        deletedTime: 0,
      };
      queue.push(newReader);

      while (queue.length > MAX_READER_QUEUE_LENGTH) {
        const evicted = queue.shift()!;
        logger.warn('reader queue overflow, evicting oldest reader', {
          file: filePath,
          evictedInode: evicted.devInode.ino,
          evictedOffset: evicted.offset,
          queueLength: queue.length,
        });
      }
    } else if (stat.size < latestReader.offset) {
      logger.info('file truncated (copytruncate rotation)', {
        file: filePath,
        recorded: latestReader.offset,
        actual: stat.size,
      });
      const sig = await computeFileSignature(filePath);
      latestReader.offset = 0;
      latestReader.signatureHash = sig;
      latestReader.cache = '';
      latestReader.lastUpdateTime = Date.now();
    }
  }

  private async processQueue(filePath: string, queue: FileReaderState[]): Promise<ReadResult> {
    while (queue.length > 0) {
      const reader = queue[0];

      const readPath = reader.deleted
        ? await this.findFileByDevInode(path.dirname(filePath), reader.devInode)
        : reader.filePath;

      if (!readPath) {
        if (reader.deleted && Date.now() - reader.deletedTime > READER_TIMEOUT_MS) {
          logger.warn('deleted reader file not found after timeout, discarding', {
            file: filePath,
            inode: reader.devInode.ino,
            offset: reader.offset,
          });
          queue.shift();
          continue;
        }
        logger.debug('deleted reader file temporarily not found, skipping to next reader', {
          file: filePath,
          inode: reader.devInode.ino,
        });
        break;
      }

      const result = await this.readFromReader(readPath, reader);

      if (result.lines.length === 0 && !result.hasMore && reader.deleted) {
        queue.shift();
        continue;
      }

      const removedFront = !result.hasMore && reader.deleted;
      if (removedFront) {
        queue.shift();
      }

      const latestReader = queue[queue.length - 1] || reader;
      const hasUnprocessedReaders = removedFront ? queue.length > 0 : queue.length > 1;
      return {
        lines: result.lines,
        checkpoint: this.readerToCheckpoint(latestReader),
        hasMore: result.hasMore || hasUnprocessedReaders,
      };
    }

    this.readerQueues.delete(filePath);
    return this.emptyResult();
  }

  private async readFromReader(
    filePath: string,
    reader: FileReaderState,
  ): Promise<{ lines: string[]; hasMore: boolean }> {
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return { lines: [], hasMore: false };
    }

    if (stat.size <= reader.offset) {
      return { lines: [], hasMore: false };
    }

    const readSize = Math.min(stat.size - reader.offset, MAX_READ_BYTES);
    let handle;
    try {
      handle = await fs.open(filePath, 'r');
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, reader.offset);
      const text = buf.toString(this.encoding);

      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        const newCache = reader.cache + text;
        if (Buffer.byteLength(newCache, this.encoding) > MAX_CACHE_BYTES) {
          logger.warn('cache overflow, discarding', {
            file: filePath,
            cacheSize: Buffer.byteLength(newCache, this.encoding),
          });
          reader.cache = '';
        } else {
          reader.cache = newCache;
        }
        reader.offset += readSize;
        reader.lastUpdateTime = Date.now();
        return { lines: [], hasMore: stat.size > reader.offset };
      }

      const completePart = reader.cache + text.substring(0, lastNewline);
      reader.cache = text.substring(lastNewline + 1);
      const lines = completePart.split('\n').filter((l) => l.length > 0);

      reader.offset += readSize;
      reader.lastUpdateTime = Date.now();

      return { lines, hasMore: stat.size > reader.offset };
    } finally {
      await handle?.close();
    }
  }

  private async findFileByDevInode(dir: string, devInode: DevInode): Promise<string | null> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const s = await fs.stat(fullPath);
        if (s.dev === devInode.dev && s.ino === devInode.ino) {
          return fullPath;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private readerToCheckpoint(reader: FileReaderState): FileCheckpoint {
    return {
      offset: reader.offset,
      inode: reader.devInode.ino,
      dev: reader.devInode.dev,
      signatureHash: reader.signatureHash,
      signatureSize: SIGNATURE_BYTES,
      lastUpdateTime: reader.lastUpdateTime,
      cache: reader.cache,
    };
  }

  private emptyResult(): ReadResult {
    return {
      lines: [],
      checkpoint: {
        offset: 0,
        inode: 0,
        dev: 0,
        signatureHash: '',
        signatureSize: SIGNATURE_BYTES,
        lastUpdateTime: Date.now(),
        cache: '',
      },
      hasMore: false,
    };
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

export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '[^/]*');
  return new RegExp(`^${regexStr}$`);
}
