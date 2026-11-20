import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseOutputSegment } from './jsonl-output-file.js';
import { createLogger } from './logger.js';
import { completeJsonlEnd, LOCAL_LOG_EMERGENCY_FILE_BYTES, withJsonlFileLock } from './segmented-jsonl-writer.js';

const MAX_RECENT_IDS = 65_536;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const FILTER_BYTES = 4 * 1024 * 1024;
const logger = createLogger('KimiJsonlReceipts');

function isKimiOutput(name: string): boolean {
  return /^kimi-code-cli-(?:all|\d{4}-\d{2}-\d{2})\.jsonl$/.test(name)
    || parseOutputSegment(name)?.stream === 'kimi-code-cli';
}

function visitHashBits(id: string, visit: (bit: number) => boolean): boolean {
  let first = 0x811c9dc5;
  let step = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    step = Math.imul(step ^ code, 0x85ebca6b);
  }
  step |= 1;
  for (let i = 0; i < 5; i++) {
    if (!visit((first + i * step) & (FILTER_BYTES * 8 - 1))) return false;
  }
  return true;
}

/** The written line is the receipt, including after rotation. The Bloom
 * filter only selects candidates for an exact scan, never accepts a record. */
export class KimiJsonlReceipts {
  private readonly recent = new Set<string>();
  private readonly filter = Buffer.alloc(FILTER_BYTES);

  constructor(private readonly outputDir: string) {}

  load(signal?: AbortSignal): Promise<void> {
    return scanOutput(this.outputDir, id => { this.remember(id); return true; }, signal, true);
  }

  hasRecent(id: string): boolean { return this.recent.has(id); }

  remember(id: string): void {
    this.recent.delete(id);
    this.recent.add(id);
    if (this.recent.size > MAX_RECENT_IDS) this.recent.delete(this.recent.keys().next().value!);
    visitHashBits(id, bit => { this.filter[bit >>> 3] |= 1 << (bit & 7); return true; });
  }

  async find(ids: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
    const accepted = new Set<string>();
    const pending = new Set<string>();
    for (const id of ids) {
      if (this.hasRecent(id)) accepted.add(id);
      else if (visitHashBits(id, bit => Boolean(this.filter[bit >>> 3] & (1 << (bit & 7))))) pending.add(id);
    }
    if (pending.size) {
      await scanOutput(this.outputDir, id => {
        if (pending.delete(id)) accepted.add(id);
        return pending.size > 0;
      }, signal);
    }
    return accepted;
  }
}

async function scanOutput(
  outputDir: string,
  visit: (id: string) => boolean,
  signal?: AbortSignal,
  repair = false,
): Promise<void> {
  const files = await fs.readdir(outputDir).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  });
  const segments: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of files.filter(isKimiOutput)) {
    signal?.throwIfAborted();
    const file = path.join(outputDir, name);
    const stat = await fs.lstat(file).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat?.isFile() && stat.size > 0 && stat.size <= LOCAL_LOG_EMERGENCY_FILE_BYTES) {
      segments.push({ file, mtimeMs: stat.mtimeMs });
    }
  }
  segments.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const { file } of segments) {
    signal?.throwIfAborted();
    if (!await withJsonlFileLock(file, () => scanSegment(file, visit, signal, repair))) return;
  }
}

async function scanSegment(
  file: string,
  visit: (id: string) => boolean,
  signal: AbortSignal | undefined,
  repair: boolean,
): Promise<boolean> {
  const handle = await fs.open(file, 'r').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!handle) return true;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > LOCAL_LOG_EMERGENCY_FILE_BYTES) return true;
    let end = stat.size;
    if (repair) {
      end = await completeJsonlEnd(handle, end);
      if (end < stat.size) {
        const writable = await fs.open(file, 'r+');
        try {
          const current = await writable.stat();
          if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
            throw new Error(`Kimi JSONL file changed during tail repair: ${file}`);
          }
          await writable.truncate(end);
          await writable.sync();
          logger.warn('Repaired incomplete Kimi JSONL tail on restart', { file, bytes: stat.size - end });
        } finally { await writable.close(); }
      }
    }
    if (end === 0) return true;
    const stream = handle.createReadStream({ end: end - 1, autoClose: false });
    let pieces: Buffer[] = [];
    let bytes = 0;
    // Only a complete line with the expected event identity can acknowledge
    // a write. Limit scratch data even if an old segment contains a bad row.
    for await (const data of stream) {
      signal?.throwIfAborted();
      const chunk = data as Buffer;
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        bytes += end - start;
        if (bytes <= MAX_RECORD_BYTES) pieces.push(chunk.subarray(start, end));
        else pieces = [];
        if (newline < 0) break;
        if (bytes > 0 && bytes <= MAX_RECORD_BYTES) {
          const id = readKimiEventId(pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, bytes));
          if (id && !visit(id)) return false;
        }
        pieces = [];
        bytes = 0;
        start = newline + 1;
      }
    }
    return true;
  } finally { await handle.close(); }
}

function readKimiEventId(line: Buffer): string | undefined {
  try {
    const record = JSON.parse(line.toString('utf8'));
    const id = record?.['event.id'];
    if (record?.['gen_ai.agent.type'] === 'kimi-code-cli' && typeof id === 'string' && id.length <= 128) return id;
  } catch { /* Malformed output is not evidence of acceptance. */ }
}
