import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileTailer } from '../../../src/file-collection/file-tailer.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-tailer-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FileTailer.discoverFiles', () => {
  it('discovers files matching glob pattern', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.log'), 'data');
    fs.writeFileSync(path.join(tmpDir, 'error.log'), 'data');
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'data');

    const tailer = new FileTailer({
      filePaths: [path.join(tmpDir, '*.log')],
    });
    const files = tailer.discoverFiles();
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.log'))).toBe(true);
  });

  it('returns empty array for non-existent directory', () => {
    const tailer = new FileTailer({
      filePaths: ['/nonexistent/dir/*.log'],
    });
    expect(tailer.discoverFiles()).toEqual([]);
  });

  it('respects maxDirSearchDepth=0 (no subdirectory scanning)', () => {
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(tmpDir, 'a.log'), 'data');
    fs.writeFileSync(path.join(subDir, 'b.log'), 'data');

    const tailer = new FileTailer({
      filePaths: [path.join(tmpDir, '*.log')],
      maxDirSearchDepth: 0,
    });
    const files = tailer.discoverFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('a.log');
  });
});

describe('FileTailer.readNewLines', () => {
  it('reads all lines from a new file (no checkpoint)', async () => {
    const filePath = path.join(tmpDir, 'test.log');
    fs.writeFileSync(filePath, 'line1\nline2\nline3\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const result = await tailer.readNewLines(filePath, null);

    expect(result.lines).toEqual(['line1', 'line2', 'line3']);
    expect(result.checkpoint.offset).toBeGreaterThan(0);
    expect(result.checkpoint.inode).toBeGreaterThan(0);
  });

  it('reads only new lines from an existing checkpoint', async () => {
    const filePath = path.join(tmpDir, 'test.log');
    fs.writeFileSync(filePath, 'line1\nline2\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const first = await tailer.readNewLines(filePath, null);
    expect(first.lines).toEqual(['line1', 'line2']);

    fs.appendFileSync(filePath, 'line3\nline4\n');
    const second = await tailer.readNewLines(filePath, first.checkpoint);
    expect(second.lines).toEqual(['line3', 'line4']);
  });

  it('does not emit incomplete lines (no trailing newline)', async () => {
    const filePath = path.join(tmpDir, 'test.log');
    fs.writeFileSync(filePath, 'line1\nincomplete');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const result = await tailer.readNewLines(filePath, null);
    expect(result.lines).toEqual(['line1']);

    fs.writeFileSync(filePath, 'line1\nincomplete_now_done\nline3\n');
    const result2 = await tailer.readNewLines(filePath, result.checkpoint);
    expect(result2.lines).toEqual(['incomplete_now_done', 'line3']);
  });

  it('returns empty for non-existent file', async () => {
    const tailer = new FileTailer({ filePaths: [] });
    const result = await tailer.readNewLines('/nonexistent/file.log', null);
    expect(result.lines).toEqual([]);
  });
});

describe('FileTailer rotation detection', () => {
  it('handles copytruncate rotation (same inode, smaller size)', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    fs.writeFileSync(filePath, 'old_line1\nold_line2\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const first = await tailer.readNewLines(filePath, null);
    expect(first.lines).toEqual(['old_line1', 'old_line2']);

    // Simulate copytruncate: truncate and write new content
    fs.writeFileSync(filePath, 'new_line1\n');
    const second = await tailer.readNewLines(filePath, first.checkpoint);
    expect(second.lines).toEqual(['new_line1']);
    expect(second.checkpoint.offset).toBeLessThan(first.checkpoint.offset);
  });

  it('handles rename rotation (different inode)', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    fs.writeFileSync(filePath, 'line1\nline2\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const first = await tailer.readNewLines(filePath, null);
    expect(first.lines).toEqual(['line1', 'line2']);

    // Simulate rename rotation
    fs.renameSync(filePath, path.join(tmpDir, 'app.log.1'));
    fs.writeFileSync(filePath, 'new_line1\nnew_line2\n');

    const second = await tailer.readNewLines(filePath, first.checkpoint);
    expect(second.lines).toEqual(['new_line1', 'new_line2']);
    expect(second.checkpoint.inode).not.toBe(first.checkpoint.inode);
  });
});
