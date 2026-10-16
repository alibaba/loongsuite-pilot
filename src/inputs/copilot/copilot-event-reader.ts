import * as fs from 'node:fs/promises';
import type { CopilotEvent, CopilotSessionHead, ReadEventsResult } from './copilot-types.js';

/** Upper bound per read so a huge transcript cannot balloon memory in one cycle. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const HEAD_READ_BYTES = 64 * 1024;
const HEAD_MAX_LINES = 20;

const EMPTY: ReadEventsResult = {
  events: [], offsets: [], nextOffset: 0, truncated: false, capped: false, malformed: 0,
};

function parseEvent(line: string): CopilotEvent | undefined {
  try {
    const value = JSON.parse(line) as Partial<CopilotEvent>;
    if (typeof value.type !== 'string' || typeof value.id !== 'string') return undefined;
    return {
      type: value.type,
      id: value.id,
      timestamp: typeof value.timestamp === 'string' ? value.timestamp : '',
      parentId: typeof value.parentId === 'string' ? value.parentId : null,
      data: value.data && typeof value.data === 'object' && !Array.isArray(value.data)
        ? value.data as Record<string, unknown>
        : {},
    };
  } catch {
    return undefined;
  }
}

/** Read complete lines appended at or after `offset`. A partial last line is left for later. */
export async function readEventsFrom(filePath: string, offset: number): Promise<ReadEventsResult> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < offset) return { ...EMPTY, truncated: true };
    if (size === offset) return { ...EMPTY, nextOffset: offset };
    const length = Math.min(size - offset, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return splitLines(buffer, offset, size - offset > MAX_READ_BYTES);
  } finally {
    await handle.close();
  }
}

function splitLines(buffer: Buffer, offset: number, chunkIsFull: boolean): ReadEventsResult {
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    // A single line larger than the whole chunk can never complete: skip it.
    return chunkIsFull
      ? { ...EMPTY, nextOffset: offset + buffer.length, malformed: 1, capped: true }
      : { ...EMPTY, nextOffset: offset };
  }
  const events: CopilotEvent[] = [];
  const offsets: number[] = [];
  let malformed = 0;
  let cursor = 0;
  while (cursor <= lastNewline) {
    const end = buffer.indexOf(0x0a, cursor);
    const line = buffer.subarray(cursor, end).toString('utf8').trim();
    if (line.length > 0) {
      const event = parseEvent(line);
      if (event) {
        events.push(event);
        offsets.push(offset + cursor);
      } else {
        malformed += 1;
      }
    }
    cursor = end + 1;
  }
  return { events, offsets, nextOffset: offset + lastNewline + 1, truncated: false, capped: chunkIsFull, malformed };
}

/** Facts from the first lines (session.start, auto_mode_resolved) that later spans still need. */
export async function readSessionHead(filePath: string): Promise<CopilotSessionHead> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    return {};
  }
  try {
    const buffer = Buffer.alloc(HEAD_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_READ_BYTES, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, HEAD_MAX_LINES);
    let head: CopilotSessionHead = {};
    for (const line of lines) {
      const event = line.trim() ? parseEvent(line) : undefined;
      if (event?.type === 'session.start') {
        const context = event.data.context as { cwd?: unknown } | undefined;
        head = {
          ...head,
          cwd: typeof context?.cwd === 'string' ? context.cwd : undefined,
          selectedModel: typeof event.data.selectedModel === 'string' ? event.data.selectedModel : undefined,
        };
      } else if (event?.type === 'session.auto_mode_resolved') {
        head = { ...head, autoModel: typeof event.data.chosenModel === 'string' ? event.data.chosenModel : undefined };
      }
    }
    return Object.fromEntries(Object.entries(head).filter(([, v]) => v !== undefined)) as CopilotSessionHead;
  } finally {
    await handle.close();
  }
}
