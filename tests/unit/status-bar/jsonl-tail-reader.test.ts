import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scanJsonlTail } from '../../../src/status-bar/jsonl-tail-reader.js';
import { cleanupTempDir, createTempDir } from '../../helpers/fixture-builder.js';

describe('scanJsonlTail', () => {
  it('reads only complete records and resumes from the committed newline', async () => {
    const tmpDir = await createTempDir('jsonl-tail-reader-');
    try {
      const filePath = path.join(tmpDir, 'events.jsonl');
      const first = JSON.stringify({ id: 1, text: '你好' }) + '\n';
      const second = JSON.stringify({ id: 2, text: 'partial' });
      const splitAt = Math.floor(second.length / 2);
      await fs.writeFile(filePath, first + second.slice(0, splitAt));

      const records: Record<string, unknown>[] = [];
      let stat = await fs.stat(filePath);
      const initial = await scanJsonlTail(filePath, 0, stat.size, {
        chunkSizeBytes: 7,
        onRecord: record => records.push(record),
      });

      expect(records).toEqual([{ id: 1, text: '你好' }]);
      expect(initial.nextOffset).toBe(Buffer.byteLength(first));
      expect(initial.bytesRead).toBe(stat.size);

      await fs.appendFile(filePath, second.slice(splitAt) + '\n');
      stat = await fs.stat(filePath);
      const resumedRecords: Record<string, unknown>[] = [];
      const resumed = await scanJsonlTail(filePath, initial.nextOffset, stat.size, {
        chunkSizeBytes: 5,
        onRecord: record => resumedRecords.push(record),
      });

      expect(resumedRecords).toEqual([{ id: 2, text: 'partial' }]);
      expect(resumed.nextOffset).toBe(stat.size);
    } finally {
      await cleanupTempDir(tmpDir);
    }
  });

  it('does not open or read a file when the range is empty', async () => {
    const records: Record<string, unknown>[] = [];
    const result = await scanJsonlTail('/path/does/not/need/to/exist', 42, 42, {
      onRecord: record => records.push(record),
    });

    expect(result).toEqual({ nextOffset: 42, bytesRead: 0 });
    expect(records).toEqual([]);
  });
});
