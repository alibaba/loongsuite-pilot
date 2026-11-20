import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';

export const DEFAULT_JSONL_SEGMENT_BYTES = 100 * 1024 * 1024;
export const LOCAL_LOG_EMERGENCY_FILE_BYTES = 3 * 1024 * 1024 * 1024;
const logger = createLogger('SegmentedJsonlWriter');
const writes = new Map<string, Promise<unknown>>();

/** Return the byte offset after the last newline. */
export async function completeJsonlEnd(file: fs.FileHandle, end: number): Promise<number> {
  if (end === 0) return 0;
  const last = Buffer.allocUnsafe(1);
  const { bytesRead: lastRead } = await file.read(last, 0, 1, end - 1);
  if (lastRead && last[0] === 10) return end;
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end));
  while (end > 0) {
    const from = Math.max(0, end - buffer.length);
    const { bytesRead } = await file.read(buffer, 0, end - from, from);
    const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
    if (newline >= 0) return from + newline + 1;
    end = from;
  }
  return 0;
}

/** Retention and append share ownership of a path, including rename/unlink. */
export async function withJsonlFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = writes.get(key) ?? Promise.resolve();
  const writing = previous.catch(() => undefined).then(action);
  writes.set(key, writing);
  try { return await writing; }
  finally { if (writes.get(key) === writing) writes.delete(key); }
}

export async function appendSegmentedJsonl(
  file: string,
  line: string,
  maxFileBytes = DEFAULT_JSONL_SEGMENT_BYTES,
  kind: 'mirror' | 'failed' = 'mirror',
  durability?: 'repair-and-sync',
): Promise<void> {
  await withJsonlFileLock(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const data = `${line}\n`;
    const bytes = Buffer.byteLength(data, 'utf8');
    let size = 0;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw new Error(`JSONL output is not a regular file: ${file}`);
      size = stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Emergency disk protection also bounds failed evidence; warn explicitly
    // when discarding it, without claiming that the backend accepted it.
    if (size > LOCAL_LOG_EMERGENCY_FILE_BYTES) {
      await fs.unlink(file);
      logger.warn('Deleted oversized local JSONL file', { file, bytes: size, discardedFailedData: kind === 'failed' });
      size = 0;
    }
    if (durability && size > 0) {
      const active = await fs.open(file, 'r+');
      try {
        const complete = await completeJsonlEnd(active, size);
        if (complete < size) {
          await active.truncate(complete);
          logger.warn('Removed incomplete local JSONL record before append', { file, bytes: size - complete });
          size = complete;
        }
      } finally { await active.close(); }
    }
    if (size > 0 && size + bytes > maxFileBytes) {
      const match = /^(.*)-(\d{4}-\d{2}-\d{2}|all)\.jsonl$/.exec(path.basename(file));
      if (!match) throw new Error(`Unsupported JSONL output filename: ${file}`);
      const id = randomUUID().replace(/-/g, '');
      await fs.rename(file, path.join(path.dirname(file), `${match[1]}.part-${id}-${match[2]}.jsonl`));
      size = 0;
    }
    // Keep one complete event even when it exceeds the normal segment size.
    if (bytes > maxFileBytes) logger.warn('JSONL record exceeds file size limit', { file, bytes, maxFileBytes });
    if (!durability) {
      await fs.appendFile(file, data, 'utf8');
      return;
    }
    const active = await fs.open(file, 'a');
    try {
      await active.writeFile(data, 'utf8');
      await active.sync();
    } catch (error) {
      try {
        await active.truncate(size);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Could not append or roll back JSONL output: ${file}`);
      }
      throw error;
    } finally { await active.close(); }
  });
}
