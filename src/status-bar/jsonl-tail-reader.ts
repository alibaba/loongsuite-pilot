import * as fs from 'node:fs/promises';

const DEFAULT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

export interface JsonlTailScanResult {
  nextOffset: number;
  bytesRead: number;
}

export interface JsonlTailScanOptions {
  chunkSizeBytes?: number;
  onRecord: (record: Record<string, unknown>) => void;
}

/**
 * Reads a stable byte range from a JSONL file and advances only through complete
 * newline-terminated records. A trailing partial record is deliberately left
 * behind for the next scan.
 */
export async function scanJsonlTail(
  filePath: string,
  startOffset: number,
  endOffset: number,
  options: JsonlTailScanOptions,
): Promise<JsonlTailScanResult> {
  if (startOffset >= endOffset) {
    return { nextOffset: startOffset, bytesRead: 0 };
  }

  const chunkSize = Math.max(1, options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES);
  const handle = await fs.open(filePath, 'r');
  let readOffset = startOffset;
  let committedOffset = startOffset;
  let bytesReadTotal = 0;
  let carry = Buffer.alloc(0);

  try {
    while (readOffset < endOffset) {
      const requestedBytes = Math.min(chunkSize, endOffset - readOffset);
      const chunk = Buffer.allocUnsafe(requestedBytes);
      const { bytesRead } = await handle.read(chunk, 0, requestedBytes, readOffset);
      if (bytesRead === 0) break;

      const data = bytesRead === requestedBytes ? chunk : chunk.subarray(0, bytesRead);
      const dataStartOffset = readOffset - carry.length;
      const combined = carry.length > 0 ? Buffer.concat([carry, data]) : data;
      let lineStart = 0;

      for (let index = 0; index < combined.length; index++) {
        if (combined[index] !== 0x0a) continue;

        const line = combined.subarray(lineStart, index);
        parseJsonlLine(line, options.onRecord);
        lineStart = index + 1;
        committedOffset = dataStartOffset + lineStart;
      }

      carry = lineStart < combined.length
        ? Buffer.from(combined.subarray(lineStart))
        : Buffer.alloc(0);
      readOffset += bytesRead;
      bytesReadTotal += bytesRead;

      // Initial migration may need to read a large current-day file. Yield
      // between chunks so the collector's event loop remains responsive.
      if (readOffset < endOffset) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
  } finally {
    await handle.close();
  }

  return {
    nextOffset: committedOffset,
    bytesRead: bytesReadTotal,
  };
}

function parseJsonlLine(
  line: Buffer,
  onRecord: (record: Record<string, unknown>) => void,
): void {
  let text = line.toString('utf8');
  if (text.endsWith('\r')) text = text.slice(0, -1);
  if (!text.trim()) return;

  try {
    const record = JSON.parse(text) as unknown;
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      onRecord(record as Record<string, unknown>);
    }
  } catch {
    // Malformed complete lines are skipped. Partial lines never reach this
    // function because their offsets are not committed.
  }
}
