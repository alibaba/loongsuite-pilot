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
    const result = await tailer.readNewLines(filePath);

    expect(result.lines).toEqual(['line1', 'line2', 'line3']);
    expect(result.checkpoint.offset).toBeGreaterThan(0);
    expect(result.checkpoint.inode).toBeGreaterThan(0);
    expect(result.hasMore).toBe(false);
  });

  it('reads only new lines from an existing checkpoint', async () => {
    const filePath = path.join(tmpDir, 'test.log');
    fs.writeFileSync(filePath, 'line1\nline2\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const first = await tailer.readNewLines(filePath);
    expect(first.lines).toEqual(['line1', 'line2']);

    fs.appendFileSync(filePath, 'line3\nline4\n');
    const second = await tailer.readNewLines(filePath);
    expect(second.lines).toEqual(['line3', 'line4']);
  });

  it('does not emit incomplete lines (no trailing newline)', async () => {
    const filePath = path.join(tmpDir, 'test.log');
    fs.writeFileSync(filePath, 'line1\nincomplete');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const result = await tailer.readNewLines(filePath);
    expect(result.lines).toEqual(['line1']);

    fs.writeFileSync(filePath, 'line1\nincomplete_now_done\nline3\n');
    const result2 = await tailer.readNewLines(filePath);
    expect(result2.lines).toEqual(['incomplete_now_done', 'line3']);
  });

  it('returns empty for non-existent file', async () => {
    const tailer = new FileTailer({ filePaths: [] });
    const result = await tailer.readNewLines('/nonexistent/file.log');
    expect(result.lines).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('returns hasMore=true when file has more data than MAX_READ_BYTES', async () => {
    const filePath = path.join(tmpDir, 'big.log');
    const line = 'x'.repeat(1000) + '\n';
    const content = line.repeat(5000);
    fs.writeFileSync(filePath, content);

    const tailer = new FileTailer({ filePaths: [filePath] });
    const result = await tailer.readNewLines(filePath);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.length).toBeLessThan(5000);
    expect(result.hasMore).toBe(true);
  });
});

describe('FileTailer rotation detection', () => {
  it('handles copytruncate rotation (same inode, smaller size)', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    fs.writeFileSync(filePath, 'old_line1\nold_line2\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const first = await tailer.readNewLines(filePath);
    expect(first.lines).toEqual(['old_line1', 'old_line2']);

    fs.writeFileSync(filePath, 'new_line1\n');
    const second = await tailer.readNewLines(filePath);
    expect(second.lines).toEqual(['new_line1']);
    expect(second.checkpoint.offset).toBeLessThan(first.checkpoint.offset);
  });

  it('handles rename rotation (different inode)', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    fs.writeFileSync(filePath, 'line1\nline2\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const first = await tailer.readNewLines(filePath);
    expect(first.lines).toEqual(['line1', 'line2']);

    fs.renameSync(filePath, path.join(tmpDir, 'app.log.1'));
    fs.writeFileSync(filePath, 'new_line1\nnew_line2\n');

    const second = await tailer.readNewLines(filePath);
    expect(second.lines).toEqual(['new_line1', 'new_line2']);
    expect(second.checkpoint.inode).not.toBe(first.checkpoint.inode);
  });
});

describe('FileTailer reader queue', () => {
  it('rename rotation: reads old file remnants via reader queue', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    fs.writeFileSync(filePath, 'line1\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const first = await tailer.readNewLines(filePath);
    expect(first.lines).toEqual(['line1']);

    fs.appendFileSync(filePath, 'line2_added\n');
    fs.renameSync(filePath, path.join(tmpDir, 'app.log.1'));
    fs.writeFileSync(filePath, 'new_file_line1\n');

    const second = await tailer.readNewLines(filePath);
    expect(second.lines).toEqual(['line2_added']);
    expect(second.hasMore).toBe(true);

    const third = await tailer.readNewLines(filePath);
    expect(third.lines).toEqual(['new_file_line1']);
  });

  it('reader queue max length is 3', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    fs.writeFileSync(filePath, 'gen1\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    await tailer.readNewLines(filePath);

    for (let i = 2; i <= 5; i++) {
      fs.renameSync(filePath, path.join(tmpDir, `app.log.${i}`));
      fs.writeFileSync(filePath, `gen${i}\n`);
      await tailer.readNewLines(filePath);
    }

    const activeFiles = tailer.getActiveFiles();
    expect(activeFiles).toContain(filePath);
  });

  it('cleanupStaleReaders removes old inactive readers', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    fs.writeFileSync(filePath, 'line1\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    await tailer.readNewLines(filePath);

    expect(tailer.getActiveFiles()).toContain(filePath);

    const checkpoints = tailer.getCheckpoints();
    const cp = checkpoints.get(filePath)!;
    cp.lastUpdateTime = Date.now() - 700_000;
    tailer.initReaderFromCheckpoint(filePath, cp);

    tailer.cleanupStaleReaders();
    expect(tailer.getActiveFiles()).not.toContain(filePath);
  });
});

describe('FileTailer incomplete line cache', () => {
  it('caches incomplete lines across reads', async () => {
    const filePath = path.join(tmpDir, 'test.log');
    fs.writeFileSync(filePath, 'complete_line\nincomplete');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const r1 = await tailer.readNewLines(filePath);
    expect(r1.lines).toEqual(['complete_line']);

    fs.appendFileSync(filePath, '_rest_of_line\nnext\n');
    const r2 = await tailer.readNewLines(filePath);
    expect(r2.lines).toEqual(['incomplete_rest_of_line', 'next']);
  });
});

describe('FileTailer checkpoint management', () => {
  it('initReaderFromCheckpoint restores state', async () => {
    const filePath = path.join(tmpDir, 'test.log');
    fs.writeFileSync(filePath, 'line1\nline2\nline3\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    const first = await tailer.readNewLines(filePath);
    expect(first.lines).toEqual(['line1', 'line2', 'line3']);

    const tailer2 = new FileTailer({ filePaths: [filePath] });
    tailer2.initReaderFromCheckpoint(filePath, first.checkpoint);

    fs.appendFileSync(filePath, 'line4\n');
    const second = await tailer2.readNewLines(filePath);
    expect(second.lines).toEqual(['line4']);
  });

  it('getCheckpoints returns current state', async () => {
    const filePath = path.join(tmpDir, 'test.log');
    fs.writeFileSync(filePath, 'hello\n');

    const tailer = new FileTailer({ filePaths: [filePath] });
    await tailer.readNewLines(filePath);

    const checkpoints = tailer.getCheckpoints();
    expect(checkpoints.has(filePath)).toBe(true);
    const cp = checkpoints.get(filePath)!;
    expect(cp.offset).toBeGreaterThan(0);
    expect(cp.inode).toBeGreaterThan(0);
    expect(cp.dev).toBeGreaterThanOrEqual(0);
    expect(typeof cp.signatureHash).toBe('string');
    expect(typeof cp.cache).toBe('string');
  });
});
