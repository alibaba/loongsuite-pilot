import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';

interface Range { start: number; end: number }
interface PendingLine { position: number; witness: string; witnessBytes: number; oversized?: boolean }
export interface NativeToolCursor {
  inode: number; offset: number; size: number; mtime: number; witness?: string; witnessBytes?: number; ambiguous?: boolean;
  callFingerprint?: string; pendingLine?: PendingLine; blocked?: 'line-byte-limit' | 'range-byte-limit';
  matches: Record<string, { call?: Range; result?: Range }>;
}
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
// Match the existing transcript reader's per-turn limit. This is separate from
// the per-cycle I/O budget, which also applies while rehydrating after restart.
const MAX_ROW_BYTES = 16 * 1024 * 1024;
interface LineCache { owner: string; key: string; position: number; parts: Buffer[]; bytes: number }
interface FetchCache { owner: string; key: string; index: number; position: number; parts: Buffer[]; rows: Record<string, any>[] }

/** Bounded discovery persists only offsets, fingerprints and native byte ranges. */
export class NativeToolRowReader {
  // One incomplete line and one range fetch can occupy memory at a time. Other
  // sources keep their durable cursor and retry when the slot becomes free.
  private line?: LineCache;
  private fetch?: FetchCache;

  activeOwners(): string[] { return [...new Set([this.line?.owner, this.fetch?.owner].filter((owner): owner is string => !!owner))]; }
  releaseOwner(owner: string): void {
    if (this.line?.owner === owner) this.line = undefined;
    if (this.fetch?.owner === owner) this.fetch = undefined;
  }
  retainOwners(owners: Set<string>): void {
    for (const owner of this.activeOwners()) if (!owners.has(owner)) this.releaseOwner(owner);
  }

  async read(file: string, session: string, calls: Set<string>, saved: NativeToolCursor | undefined,
    budget: { remaining: number }, owner = `${file}\0${session}`): Promise<{ cursor: NativeToolCursor; rows: Record<string, any>[] | null }> {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('IDE source is not a regular file');
      const read = async (start: number, length: number) => {
        if (length > budget.remaining) throw new Error('IDE source byte budget');
        const buffer = Buffer.alloc(length); let offset = 0;
        while (offset < length) {
          const result = await handle.read(buffer, offset, length - offset, start + offset);
          if (!result.bytesRead) throw new Error('IDE source truncated');
          offset += result.bytesRead;
        }
        budget.remaining -= length; return buffer;
      };
      const fingerprint = digest(JSON.stringify([...calls].sort()));
      let cursor: NativeToolCursor = saved ? { ...saved,
        ...(saved.pendingLine ? { pendingLine: { ...saved.pendingLine } } : {}),
        matches: Object.fromEntries(Object.entries(saved.matches ?? {}).map(([key, value]) => [key, { ...value }])) }
        : { inode: stat.ino, offset: 0, size: stat.size, mtime: stat.mtimeMs, matches: {} };
      let reset = cursor.inode !== stat.ino || cursor.offset > stat.size || cursor.callFingerprint !== fingerprint
        || (cursor.size === stat.size && cursor.mtime !== stat.mtimeMs)
        || !!(cursor.pendingLine && (cursor.pendingLine.position < cursor.offset || cursor.pendingLine.position > stat.size));
      const verifyWitness = async (position: number, witness: string | undefined, witnessBytes: number | undefined) => {
        if (!position || !witness) return true;
        const length = Math.min(position, witnessBytes ?? 64);
        if (length > budget.remaining) return undefined;
        return digest(await read(position - length, length)) === witness;
      };
      if (!reset) {
        const valid = await verifyWitness(cursor.offset, cursor.witness, cursor.witnessBytes);
        if (valid === undefined) return { cursor, rows: null };
        reset = !valid;
      }
      if (!reset && cursor.pendingLine) {
        const valid = await verifyWitness(cursor.pendingLine.position, cursor.pendingLine.witness, cursor.pendingLine.witnessBytes);
        if (valid === undefined) return { cursor, rows: null };
        reset = !valid;
      }
      if (reset) {
        if (this.line?.owner === owner) this.line = undefined;
        if (this.fetch?.owner === owner) this.fetch = undefined;
        cursor = { inode: stat.ino, offset: 0, size: stat.size, mtime: stat.mtimeMs, matches: {} };
      }
      cursor.callFingerprint = fingerprint;
      const lineKey = `${owner}\0${file}\0${session}\0${stat.ino}\0${cursor.offset}\0${fingerprint}`;
      if (this.line?.owner === owner && this.line.key !== lineKey) this.line = undefined;
      if (this.line?.key === lineKey && (!cursor.pendingLine || this.line.position > cursor.pendingLine.position)) this.line = undefined;
      // An unfinished EOF is not a complete JSONL row. Wait for an append;
      // dropping its cache prevents a stalled writer from occupying the slot.
      if (cursor.pendingLine?.position === stat.size) {
        if (this.line?.key === lineKey) this.line = undefined;
        cursor.size = stat.size; cursor.mtime = stat.mtimeMs;
        return { cursor, rows: null };
      }
      if (cursor.pendingLine && !cursor.pendingLine.oversized && this.line && this.line.key !== lineKey) {
        return { cursor, rows: null };
      }
      if (cursor.pendingLine && !cursor.pendingLine.oversized && !this.line) {
        this.line = { owner, key: lineKey, position: cursor.offset, parts: [], bytes: 0 };
      }
      let position = cursor.pendingLine?.oversized ? cursor.pendingLine.position
        : this.line?.key === lineKey ? this.line.position : cursor.offset;
      const oldPendingPosition = cursor.pendingLine?.position ?? cursor.offset;
      const length = Math.min(stat.size - position, budget.remaining);
      const buffer = await read(position, length);
      const scanStart = position; position += buffer.length;
      let start = 0;
      for (let end = buffer.indexOf(0x0a); end >= 0; end = buffer.indexOf(0x0a, start)) {
        const begin = cursor.offset; const finish = scanStart + end + 1;
        if (cursor.pendingLine && finish < oldPendingPosition) throw new Error('IDE source changed during partial row');
        let body: Buffer | undefined;
        if (cursor.pendingLine?.oversized) {
          cursor.blocked = 'line-byte-limit';
        } else if (cursor.pendingLine || this.line?.key === lineKey) {
          const partial = this.line;
          if (!partial || partial.key !== lineKey || partial.position !== scanStart + start) throw new Error('IDE partial row unavailable');
          const fragment = buffer.subarray(start, end);
          if (partial.bytes + fragment.length > MAX_ROW_BYTES) cursor.blocked = 'line-byte-limit';
          else body = Buffer.concat([...partial.parts, fragment], partial.bytes + fragment.length);
          this.line = undefined;
        } else if (end - start > MAX_ROW_BYTES) cursor.blocked = 'line-byte-limit';
        else body = buffer.subarray(start, end);
        if (body) {
          let row: Record<string, any> | undefined;
          try { row = JSON.parse(body.toString('utf8')); } catch { /* Ignore complete malformed rows, as before. */ }
          if (row?.sessionId === session && Array.isArray(row.message?.content)) for (const block of row.message.content) {
            const key = block.type === 'tool_use' ? block.id : block.type === 'tool_result' ? block.tool_use_id : null;
            if (!calls.has(key)) continue;
            const field = block.type === 'tool_use' ? 'call' : 'result';
            const match = cursor.matches[key] ??= {};
            if (match[field] && match[field]!.start !== begin) cursor.ambiguous = true;
            match[field] = { start: begin, end: finish };
          }
        }
        cursor.offset = finish; delete cursor.pendingLine;
        cursor.witnessBytes = Math.min(end - start + 1, 64);
        cursor.witness = digest(buffer.subarray(end + 1 - cursor.witnessBytes, end + 1));
        start = end + 1;
      }
      if (start < buffer.length) {
        const fragment = buffer.subarray(start);
        const partialKey = `${owner}\0${file}\0${session}\0${stat.ino}\0${cursor.offset}\0${fingerprint}`;
        const pendingPosition = Math.max(oldPendingPosition, position);
        const oversized = cursor.pendingLine?.oversized || position - cursor.offset > MAX_ROW_BYTES;
        if (oversized) {
          if (this.line?.key === partialKey) this.line = undefined;
        } else {
          if (!this.line) this.line = { owner, key: partialKey, position: scanStart + start, parts: [], bytes: 0 };
          if (this.line.key === partialKey && this.line.position === scanStart + start) {
            this.line.parts.push(Buffer.from(fragment)); this.line.bytes += fragment.length;
            this.line.position = position;
          }
        }
        if (position >= oldPendingPosition) {
          const witnessBytes = Math.min(fragment.length, 64);
          cursor.pendingLine = { position: pendingPosition, witness: digest(fragment.subarray(fragment.length - witnessBytes)), witnessBytes,
            ...(oversized ? { oversized: true } : {}) };
        }
      }
      cursor.size = stat.size; cursor.mtime = stat.mtimeMs;
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('IDE source changed');
      if (cursor.offset < stat.size || cursor.ambiguous || cursor.blocked
        || [...calls].some(key => !cursor.matches[key]?.call || !cursor.matches[key]?.result)) return { cursor, rows: null };
      const ranges = new Map<string, Range>();
      for (const key of calls) for (const range of Object.values(cursor.matches[key]!)) if (range) ranges.set(`${range.start}:${range.end}`, range);
      const sorted = [...ranges.values()].sort((a, b) => a.start - b.start);
      const required = sorted.reduce((size, range) => size + range.end - range.start, 0);
      if (required > MAX_ROW_BYTES) { cursor.blocked = 'range-byte-limit'; return { cursor, rows: null }; }
      const fetchKey = `${owner}\0${file}\0${session}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${fingerprint}\0${JSON.stringify(sorted)}`;
      if (this.fetch && this.fetch.key !== fetchKey && this.fetch.owner === owner) this.fetch = undefined;
      if (this.fetch && this.fetch.key !== fetchKey) return { cursor, rows: null };
      const fetch = this.fetch ??= { owner, key: fetchKey, index: 0, position: sorted[0]?.start ?? 0, parts: [], rows: [] };
      while (fetch.index < sorted.length && budget.remaining > 0) {
        const range = sorted[fetch.index]!;
        const chunk = await read(fetch.position, Math.min(range.end - fetch.position, budget.remaining));
        fetch.parts.push(chunk); fetch.position += chunk.length;
        if (fetch.position < range.end) break;
        const row = JSON.parse(Buffer.concat(fetch.parts).toString('utf8'));
        if (row.sessionId !== session || !Array.isArray(row.message?.content)) throw new Error('IDE source range changed');
        fetch.rows.push({ ...row, message: { ...row.message, content: row.message.content.filter((block: Record<string, any>) =>
          calls.has(block.type === 'tool_use' ? block.id : block.type === 'tool_result' ? block.tool_use_id : null)) } });
        fetch.parts = []; fetch.index++; fetch.position = sorted[fetch.index]?.start ?? 0;
      }
      const final = await handle.stat();
      if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs) throw new Error('IDE source changed');
      if (fetch.index < sorted.length) return { cursor, rows: null };
      this.fetch = undefined;
      return { cursor, rows: fetch.rows };
    } finally { await handle.close(); }
  }
}
