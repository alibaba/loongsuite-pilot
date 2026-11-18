import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';

interface Range { start: number; end: number }
export interface NativeToolCursor {
  inode: number; offset: number; size: number; mtime: number; witness?: string; witnessBytes?: number; ambiguous?: boolean;
  matches: Record<string, { call?: Range; result?: Range }>;
}
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

/** Bounded discovery stores only native byte ranges; no message bodies in state. */
export async function readNativeToolRows(file: string, session: string, calls: Set<string>,
  saved: NativeToolCursor | undefined, budget: { remaining: number }): Promise<{ cursor: NativeToolCursor; rows: Record<string, any>[] | null }> {
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
    let cursor: NativeToolCursor = saved ? { ...saved,
      matches: Object.fromEntries(Object.entries(saved.matches).map(([key, value]) => [key, { ...value }])) }
      : { inode: stat.ino, offset: 0, size: stat.size, mtime: stat.mtimeMs, matches: {} };
    let reset = cursor.inode !== stat.ino || cursor.offset > stat.size
      || (cursor.size === stat.size && cursor.mtime !== stat.mtimeMs);
    if (!reset && cursor.offset && cursor.witness) {
      const length = Math.min(cursor.offset, cursor.witnessBytes ?? 64);
      const tail = await read(cursor.offset - length, length);
      reset = digest(tail) !== cursor.witness;
    }
    if (reset) cursor = { inode: stat.ino, offset: 0, size: stat.size, mtime: stat.mtimeMs, matches: {} };
    const buffer = await read(cursor.offset, Math.min(stat.size - cursor.offset, budget.remaining));
    let start = 0;
    for (let end = buffer.indexOf(0x0a); end >= 0; end = buffer.indexOf(0x0a, start)) {
      const begin = cursor.offset + start; const finish = cursor.offset + end + 1;
      let row: Record<string, any>;
      try { row = JSON.parse(buffer.subarray(start, end).toString('utf8')); }
      catch { start = end + 1; continue; }
      if (row.sessionId === session && Array.isArray(row.message?.content)) for (const block of row.message.content) {
        const key = block.type === 'tool_use' ? block.id : block.type === 'tool_result' ? block.tool_use_id : null;
        if (!calls.has(key)) continue;
        const field = block.type === 'tool_use' ? 'call' : 'result';
        const match = cursor.matches[key] ??= {};
        if (match[field] && match[field]!.start !== begin) cursor.ambiguous = true;
        match[field] = { start: begin, end: finish };
      }
      start = end + 1;
    }
    cursor.offset += start;
    cursor.size = stat.size; cursor.mtime = stat.mtimeMs;
    if (start) { cursor.witnessBytes = Math.min(start, 64); cursor.witness = digest(buffer.subarray(start - cursor.witnessBytes, start)); }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('IDE source changed');
    if (cursor.offset < stat.size || cursor.ambiguous
      || [...calls].some(key => !cursor.matches[key]?.call || !cursor.matches[key]?.result)) return { cursor, rows: null };
    const ranges = new Map<string, Range>();
    for (const key of calls) for (const range of Object.values(cursor.matches[key]!)) if (range) ranges.set(`${range.start}:${range.end}`, range);
    const required = [...ranges.values()].reduce((size, range) => size + range.end - range.start, 0);
    if (required > budget.remaining) return { cursor, rows: null };
    const rows: Record<string, any>[] = [];
    for (const range of [...ranges.values()].sort((a, b) => a.start - b.start)) {
      const row = JSON.parse((await read(range.start, range.end - range.start)).toString('utf8'));
      if (row.sessionId !== session || !Array.isArray(row.message?.content)) throw new Error('IDE source range changed');
      rows.push({ ...row, message: { ...row.message, content: row.message.content.filter((block: Record<string, any>) =>
        calls.has(block.type === 'tool_use' ? block.id : block.type === 'tool_result' ? block.tool_use_id : null)) } });
    }
    const final = await handle.stat();
    if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs) throw new Error('IDE source changed');
    return { cursor, rows };
  } finally { await handle.close(); }
}
