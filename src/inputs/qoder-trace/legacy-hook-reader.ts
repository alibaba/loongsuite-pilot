import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';

const CHUNK_BYTES = 64 * 1024;
export const LEGACY_HOOK_SCAN_BYTES = 4 * 1024 * 1024;
export const LEGACY_HOOK_RECORD_BYTES = 32 * 1024 * 1024;

export interface LegacyHookQuarantine {
  from: number;
  to: number | null;
  bytes: number;
  reason: 'record-byte-limit';
}

interface Tail {
  file: string;
  dev: number;
  ino: number;
  committed: number;
  position: number;
  start: number;
  parts: Buffer[];
  bytes: number;
  skipping: boolean;
  size: number;
  mtime: number;
  ctime: number;
  witness: Buffer;
  header: Buffer;
}

/** Upgrade-only JSONL reader. Physical progress is not a durable event ACK. */
export class QoderLegacyHookReader {
  private tail?: Tail;

  constructor(
    private readonly scanBytes = LEGACY_HOOK_SCAN_BYTES,
    private readonly recordBytes = LEGACY_HOOK_RECORD_BYTES,
  ) {}

  reset(): void { this.tail = undefined; }

  async read(file: string, offset: number, runtime: InputRuntimeAccumulator | null) {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    let remaining = this.scanBytes;
    const completed: Buffer[] = [];
    const quarantine: LegacyHookQuarantine[] = [];
    let total = 0;
    const read = async (buffer: Buffer, position: number) => {
      const started = runtime?.now();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      remaining -= bytesRead;
      if (runtime && started !== undefined) runtime.observeRead(bytesRead, buffer.length, runtime.now() - started);
      return bytesRead;
    };
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('legacy Hook source is not a regular file');
      let tail = this.tail;
      if (!tail || tail.file !== file || tail.dev !== stat.dev || tail.ino !== stat.ino
        || tail.committed !== offset || stat.size < tail.position) tail = undefined;
      // Growth can share the previous timestamps on coarse filesystems. Still
      // verify the retained prefix before combining it with newly read bytes.
      if (tail && (tail.size !== stat.size || tail.mtime !== stat.mtimeMs || tail.ctime !== stat.ctimeMs)) {
        let append = stat.size > tail.size;
        if (append && tail.witness.length) {
          const witness = Buffer.alloc(tail.witness.length);
          append = await read(witness, tail.position - witness.length) === witness.length && witness.equals(tail.witness);
        }
        if (append && tail.header.length) {
          const header = Buffer.alloc(tail.header.length);
          append = await read(header, tail.start) === header.length && header.equals(tail.header);
        }
        if (!append) tail = undefined;
      }
      if (!tail) {
        tail = { file, dev: stat.dev, ino: stat.ino, committed: offset, position: offset,
          start: offset, parts: [], bytes: 0, skipping: false, size: stat.size,
          mtime: stat.mtimeMs, ctime: stat.ctimeMs, witness: Buffer.alloc(0), header: Buffer.alloc(0) };
      }
      this.tail = tail;
      while (tail.position < stat.size && remaining > 0 && total < this.scanBytes) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, remaining, stat.size - tail.position));
        const bytesRead = await read(buffer, tail.position);
        if (!bytesRead) break;
        const chunkStart = tail.position;
        tail.position += bytesRead;
        tail.witness = Buffer.from(buffer.subarray(Math.max(0, bytesRead - 64), bytesRead));
        let cursor = 0;
        while (cursor < bytesRead) {
          const newline = buffer.indexOf(0x0a, cursor);
          const end = newline < 0 || newline >= bytesRead ? bytesRead : newline + 1;
          const part = buffer.subarray(cursor, end);
          if (tail.header.length < 64) tail.header = Buffer.concat([tail.header, part.subarray(0, 64 - tail.header.length)]);
          tail.bytes += part.length;
          if (!tail.skipping && tail.bytes > this.recordBytes) {
            tail.skipping = true;
            tail.parts = [];
            quarantine.push({ from: tail.start, to: null, bytes: tail.bytes, reason: 'record-byte-limit' });
          }
          if (!tail.skipping) tail.parts.push(part);
          if (end > cursor && buffer[end - 1] === 0x0a) {
            const lineEnd = chunkStart + end;
            if (tail.skipping) {
              quarantine.push({ from: tail.start, to: lineEnd, bytes: tail.bytes, reason: 'record-byte-limit' });
            } else {
              completed.push(tail.parts.length === 1 ? tail.parts[0] : Buffer.concat(tail.parts, tail.bytes));
              total += tail.bytes;
            }
            tail.committed = lineEnd;
            tail.start = lineEnd;
            tail.parts = [];
            tail.bytes = 0;
            tail.skipping = false;
            tail.header = Buffer.alloc(0);
          }
          cursor = end;
        }
      }
      const after = await fs.stat(file);
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.size < tail.position
        || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) {
        throw new Error('legacy Hook source changed during read');
      }
      tail.size = stat.size;
      tail.mtime = stat.mtimeMs;
      tail.ctime = stat.ctimeMs;
      return {
        buffer: completed.length === 1 ? completed[0] : Buffer.concat(completed, total),
        nextOffset: tail.committed,
        quarantine,
      };
    } catch (error) {
      this.reset();
      throw error;
    } finally { await handle.close(); }
  }
}
