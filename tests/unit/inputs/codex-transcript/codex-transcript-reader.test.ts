import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CODEX_READ_REASONS, InputRuntimeAccumulator } from '../../../../src/inputs/base/input-runtime-metrics.js';
import { CodexWorkBudget, CodexWorkScheduler } from '../../../../src/inputs/codex-transcript/codex-transcript-work-scheduler.js';
import {
  CodexGuardedJsonlReadTask, CodexJsonlReadTask, CodexRangeReadTask, CodexRecordRangeReadTask, codexContentAnchor, codexSourceRef,
  codexSourceSnapshot, parseCodexJsonlProbeState, parseCodexRecordReadState, parseCodexSourceRef,
  type CodexJsonLine,
} from '../../../../src/inputs/codex-transcript/codex-transcript-reader.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(bytes: string | Buffer): Promise<{ file: string; inode: number }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-budget-reader-'));
  roots.push(root);
  const file = path.join(root, 'rollout.jsonl');
  await fs.writeFile(file, bytes);
  return { file, inode: (await fs.stat(file)).ino };
}

function work(runtime?: InputRuntimeAccumulator, bytes = 1024): CodexWorkBudget {
  return new CodexWorkBudget({
    cycleReadBytes: bytes, fileCycleReadBytes: bytes, fileQuantumBytes: bytes,
    maxReadChunkBytes: Math.min(bytes, 64),
  }, runtime, () => 0);
}

describe('CodexJsonlReadTask', () => {
  it('resumes large lines without rereading the consumed prefix or committing partial bytes', async () => {
    const raw = Buffer.from(JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(512) } }) + '\n');
    const { file, inode } = await fixture(raw);
    const task = new CodexJsonlReadTask(file, 0, raw.length, 'fork_search', inode);
    const lines: CodexJsonLine[] = [];
    let totalRead = 0;
    for (let cycle = 0; cycle < 20; cycle++) {
      const runtime = new InputRuntimeAccumulator();
      const budget = work(runtime, 80);
      const result = await task.step(budget.fileSlice(file), line => { lines.push(line); });
      const delta = runtime.finish(0);
      totalRead += delta.rawReadBytes;
      expect(delta.rawReadBytes).toBeLessThanOrEqual(80);
      expect(delta.codexRead!.readBytes.fork_search).toBe(delta.rawReadBytes);
      if (result.status === 'complete') {
        expect(result.nextOffset).toBe(raw.length);
        expect(result.records).toBe(1);
        break;
      }
      expect(result.status).toBe('deferred');
      expect(result.nextOffset).toBe(0);
      expect(lines).toHaveLength(0);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]!.sha256).toBe(codexContentAnchor(raw, 0).sha256);
    expect(totalRead).toBe(raw.length);
  });

  it('makes forward progress through a single record larger than the old 16 MiB window', async () => {
    const raw = Buffer.from(JSON.stringify({ payload: 'x'.repeat(20 * 1024 * 1024) }) + '\n');
    const { file, inode } = await fixture(raw);
    const task = new CodexJsonlReadTask(file, 0, raw.length, 'fork_search', inode);
    const runtime = new InputRuntimeAccumulator();
    let lines = 0;
    for (let cycle = 0; cycle < 20 && lines === 0; cycle++) {
      const budget = new CodexWorkBudget({}, runtime, () => 0);
      for (let quantum = 0; quantum < 8 && budget.canReadFile(file) && lines === 0; quantum++) {
        await task.step(budget.fileSlice(file), () => { lines++; });
      }
      expect(budget.fileReadBytes(file)).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(budget.readBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    }
    expect(lines).toBe(1);
    expect(task.parsedOffset).toBe(raw.length);
    expect(runtime.finish(0).rawReadBytes).toBe(raw.length);
  }, 30_000);

  it('keeps UTF-8 and CRLF boundaries intact while consuming invalid complete lines', async () => {
    const raw = Buffer.from('{"text":"中文 😀"}\r\nnot-json\n[]\n \n{"last":true}\n');
    const { file } = await fixture(raw);
    const task = new CodexJsonlReadTask(file, 0, raw.length, 'normal_scan');
    const lines: CodexJsonLine[] = [];
    let result;
    for (let cycle = 0; cycle < raw.length; cycle++) {
      result = await task.step(work(undefined, 1).fileSlice(file), line => { lines.push(line); });
      if (result.status === 'complete') break;
    }
    expect(result).toMatchObject({ status: 'complete', nextOffset: raw.length, records: 4, parseSuccessRecords: 2, parseFailedRecords: 2 });
    expect(lines.map(line => line.record)).toEqual([{ text: '中文 😀' }, { last: true }]);
    expect(lines[0]!.endOffset).toBe(Buffer.byteLength('{"text":"中文 😀"}\r\n'));
  });

  it('does not reread an unchanged incomplete EOF and safely rebuilds an evicted tail', async () => {
    const raw = Buffer.from('{"complete":true}\n{"tail":');
    const { file } = await fixture(raw);
    const task = new CodexJsonlReadTask(file, 0, raw.length, 'owner_probe');
    const lines: CodexJsonLine[] = [];
    const onLine = (line: CodexJsonLine) => { lines.push(line); };
    expect(await task.step(work().fileSlice(file), onLine)).toMatchObject({ status: 'incomplete-tail', records: 1 });
    const watermark = task.parsedOffset;
    task.releaseBuffers();
    const runtime = new InputRuntimeAccumulator();
    expect(await task.step(work(runtime).fileSlice(file), onLine)).toMatchObject({ status: 'incomplete-tail', nextOffset: watermark });
    expect(runtime.finish(0).rawReadCalls).toBe(0);
    await fs.appendFile(file, 'true}\n');
    task.resumeTail((await fs.stat(file)).size);
    expect(await task.step(work().fileSlice(file), onLine)).toMatchObject({ status: 'complete', records: 2 });
    expect(lines.map(line => line.record)).toEqual([{ complete: true }, { tail: true }]);
  });

  it('retains buffered complete lines when a time slice ends without another source read', async () => {
    const raw = Buffer.from('{"one":1}\n{"two":2}\n');
    const { file } = await fixture(raw);
    const task = new CodexJsonlReadTask(file, 0, raw.length, 'normal_scan');
    let now = 0;
    const budget = new CodexWorkBudget({ workSliceMs: 10 }, null, () => now);
    const lines: CodexJsonLine[] = [];
    expect(await task.step(budget.fileSlice(file), line => { lines.push(line); now = 10; })).toMatchObject({ status: 'deferred', records: 1 });
    const runtime = new InputRuntimeAccumulator();
    expect(await task.step(work(runtime).fileSlice(file), line => { lines.push(line); })).toMatchObject({ status: 'complete', records: 2 });
    expect(runtime.finish(0).rawReadBytes).toBe(0);
    expect(lines.map(line => line.record)).toEqual([{ one: 1 }, { two: 2 }]);
  });

  it('does not disguise callback failures as invalid JSON or consume their source line', async () => {
    const raw = Buffer.from('{"one":1}\n');
    const { file } = await fixture(raw);
    const task = new CodexJsonlReadTask(file, 0, raw.length, 'normal_scan');
    const runtime = new InputRuntimeAccumulator();
    await expect(task.step(work(runtime).fileSlice(file), () => { throw new Error('builder failed'); })).rejects.toThrow('builder failed');
    expect(task.parsedOffset).toBe(0);
    const lines: CodexJsonLine[] = [];
    expect(await task.step(work(runtime).fileSlice(file), line => { lines.push(line); })).toMatchObject({
      status: 'complete', nextOffset: raw.length, records: 1, parseSuccessRecords: 1, parseFailedRecords: 0,
    });
    expect(lines.map(line => line.record)).toEqual([{ one: 1 }]);
    expect(runtime.finish(0).rawReadBytes).toBe(raw.length);
  });

  it('extends a fixed target only through its unfinished boundary line', async () => {
    const before = '{"head":true}\n{"boundary":';
    const { file } = await fixture(before);
    const task = new CodexJsonlReadTask(file, 0, Buffer.byteLength(before), 'owner_probe');
    const lines: CodexJsonLine[] = [];
    const onLine = (line: CodexJsonLine) => { lines.push(line); };
    expect((await task.step(work().fileSlice(file), onLine)).status).toBe('incomplete-tail');
    await fs.appendFile(file, 'true}\n{"future":true}\n');
    task.resumeTail((await fs.stat(file)).size);
    const result = await task.step(work().fileSlice(file), onLine);
    expect(result).toMatchObject({
      status: 'complete', nextOffset: Buffer.byteLength(before + 'true}\n'), records: 2,
    });
    expect(lines.map(line => line.record)).toEqual([{ head: true }, { boundary: true }]);
    expect(task.bufferedBytes).toBe(0);
  });

  it('settles a failed source read without consuming bytes or exhausting the next attempt', async () => {
    const raw = Buffer.from('{"retry":true}\n');
    const { file, inode } = await fixture(raw);
    const handle = await fs.open(file, 'r');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const read = vi.spyOn(prototype, 'read').mockRejectedValueOnce(new Error('transient source read'));
    try {
      const runtime = new InputRuntimeAccumulator();
      const budget = work(runtime, raw.length);
      const task = new CodexJsonlReadTask(file, 0, raw.length, 'recovery', inode);
      await expect(task.step(budget.fileSlice(file), () => {})).rejects.toThrow('transient source read');
      expect(task.parsedOffset).toBe(0);
      expect(budget.readBytes).toBe(0);
      expect(budget.readCalls).toBe(1);
      const lines: CodexJsonLine[] = [];
      expect(await task.step(budget.fileSlice(file), line => { lines.push(line); })).toMatchObject({ status: 'complete', records: 1 });
      expect(lines.map(line => line.record)).toEqual([{ retry: true }]);
      expect(budget.readBytes).toBe(raw.length);
      expect(budget.readCalls).toBe(2);
      expect(runtime.finish(0)).toMatchObject({ rawReadBytes: raw.length, rawReadCalls: 2 });
    } finally {
      read.mockRestore();
    }
  });

  it('freezes and releases a paused line after source replacement', async () => {
    const raw = Buffer.from('{"body":"' + 'x'.repeat(128) + '"}\n');
    const { file, inode } = await fixture(raw);
    const task = new CodexJsonlReadTask(file, 0, raw.length, 'normal_scan', inode);
    const lines: CodexJsonLine[] = [];
    const onLine = (line: CodexJsonLine) => { lines.push(line); };
    expect((await task.step(work(undefined, 16).fileSlice(file), onLine)).status).toBe('deferred');
    expect(task.bufferedBytes).toBeGreaterThan(0);
    await fs.rename(file, `${file}.old`);
    await fs.writeFile(file, raw);
    const result = await task.step(work().fileSlice(file), onLine);
    expect(result).toMatchObject({ status: 'source-conflict', nextOffset: 0, records: 0 });
    expect(task.bufferedBytes).toBe(0);
    expect(lines).toHaveLength(0);
    const runtime = new InputRuntimeAccumulator();
    expect(await task.step(work(runtime).fileSlice(file), onLine)).toEqual(result);
    expect(runtime.finish(0).rawReadCalls).toBe(0);
  });

  it.each([1, 7, 31, 64])('preserves record ranges and fingerprints with %i-byte cycles', async bytes => {
    const raw = Buffer.from('{"text":"中文 😀"}\r\n \n["invalid-record"]\n{"last":true}\n');
    const { file } = await fixture(raw);
    const task = new CodexJsonlReadTask(file, 0, raw.length, 'normal_scan');
    const lines: CodexJsonLine[] = [];
    const runtime = new InputRuntimeAccumulator();
    let result;
    for (let cycle = 0; cycle <= raw.length; cycle++) {
      result = await task.step(work(runtime, bytes).fileSlice(file), line => { lines.push(line); });
      if (result.status === 'complete') break;
      expect(result.status).toBe('deferred');
    }
    expect(result).toMatchObject({ status: 'complete', nextOffset: raw.length, records: 3, parseSuccessRecords: 2, parseFailedRecords: 1 });
    expect(lines.map(line => line.record)).toEqual([{ text: '中文 😀' }, { last: true }]);
    for (const line of lines) {
      expect(line.sha256).toBe(codexContentAnchor(raw.subarray(line.startOffset, line.endOffset), line.startOffset).sha256);
    }
    expect(runtime.finish(0).rawReadBytes).toBe(raw.length);
  });
});

describe('Codex reader and shared scheduler', () => {
  it('bounds real mixed-file reads across reasons and serves small files ahead of a giant line', async () => {
    const scheduler = new CodexWorkScheduler(() => 0);
    const sources: { file: string; bytes: number }[] = [];
    const seen = new Set<number>();
    const expectedByReason = Object.fromEntries(CODEX_READ_REASONS.map(reason => [reason, 0]));
    for (let index = 0; index < 24; index++) {
      const raw = Buffer.from(JSON.stringify({ index, body: 'x'.repeat(index === 0 ? 20 * 1024 * 1024 : 2048) }) + '\n');
      const { file, inode } = await fixture(raw);
      const reason = CODEX_READ_REASONS[index % CODEX_READ_REASONS.length]!;
      expectedByReason[reason] += raw.length;
      sources.push({ file, bytes: raw.length });
      const reader = new CodexJsonlReadTask(file, 0, raw.length, reason, inode);
      scheduler.enqueue({
        key: file, filePath: file, priority: index % 2 === 0 ? 'hot' : 'cold',
        async step(slice) {
          const before = reader.observedReadOffset;
          const result = await reader.step(slice, line => {
            expect(line.record.index).toBe(index);
            expect(seen.has(index)).toBe(false);
            seen.add(index);
          });
          expect(result.status).not.toBe('source-conflict');
          return {
            status: result.status === 'complete' ? 'complete' : 'deferred',
            progressed: reader.observedReadOffset > before,
          };
        },
      });
    }
    const runtime = new InputRuntimeAccumulator();
    for (let cycle = 0; cycle < 16 && scheduler.size > 0; cycle++) {
      const budget = new CodexWorkBudget({}, runtime, () => 0);
      await scheduler.run(budget);
      expect(budget.readBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(budget.readCalls).toBeLessThanOrEqual(128);
      for (const source of sources) expect(budget.fileReadBytes(source.file)).toBeLessThanOrEqual(16 * 1024 * 1024);
      if (cycle === 0) {
        expect(seen.size).toBe(23);
        expect(seen.has(0)).toBe(false);
      }
    }
    expect(scheduler.size).toBe(0);
    expect(seen.size).toBe(24);
    const delta = runtime.finish(0);
    expect(delta.rawReadBytes).toBe(sources.reduce((total, source) => total + source.bytes, 0));
    expect(delta.codexRead!.readBytes).toEqual(expectedByReason);
    expect(CODEX_READ_REASONS.reduce((total, reason) => total + delta.codexRead!.readCalls[reason], 0)).toBe(delta.rawReadCalls);
  }, 30_000);
});

describe('CodexGuardedJsonlReadTask', () => {
  it('persists an unchanged EOF half-line without rereading it after restart or eviction', async () => {
    const before = '{"head":true}\n{"boundary":';
    const { file } = await fixture(before);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'fork_search', 0);
    expect((await task.step(work().fileSlice(file), snapshot, () => {})).status).toBe('incomplete-tail');
    const state = parseCodexJsonlProbeState(JSON.parse(JSON.stringify(task.serialize())))!;
    task.releaseBuffers();
    const restored = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'fork_search', state.nextCompleteOffset, state);
    const runtime = new InputRuntimeAccumulator();
    expect((await restored.step(work(runtime).fileSlice(file), snapshot, () => {})).status).toBe('incomplete-tail');
    expect(runtime.finish(0).rawReadCalls).toBe(0);
    await fs.appendFile(file, 'true}\n{"future":true}\n');
    const grown = codexSourceSnapshot(await fs.stat(file));
    const lines: CodexJsonLine[] = [];
    expect(await restored.step(work().fileSlice(file), grown, line => { lines.push(line); }))
      .toMatchObject({ status: 'complete', nextOffset: Buffer.byteLength(before + 'true}\n') });
    expect(lines.map(line => line.record)).toEqual([{ boundary: true }]);
    expect((await restored.step(work().fileSlice(file), grown, line => { lines.push(line); })).status).toBe('complete');
    expect(lines.map(line => line.record)).toEqual([{ boundary: true }, { future: true }]);
  });

  it('does not extend a paused fixed target to later appended records', async () => {
    const raw = '{"head":true}\n' + JSON.stringify({ body: 'x'.repeat(300) }) + '\n';
    const { file } = await fixture(raw);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'fork_search', 0);
    const lines: CodexJsonLine[] = [];
    const onLine = (line: CodexJsonLine) => { lines.push(line); };
    expect((await task.step(work(undefined, 80).fileSlice(file), snapshot, onLine)).status).toBe('deferred');
    await fs.appendFile(file, '{"future":true}\n');
    const grown = codexSourceSnapshot(await fs.stat(file));
    let result;
    for (let cycle = 0; cycle < 20; cycle++) {
      result = await task.step(work(undefined, 80).fileSlice(file), grown, onLine);
      if (result.status === 'complete') break;
      expect(result.status).toBe('deferred');
      expect(task.serialize().targetSize).toBe(Buffer.byteLength(raw));
    }
    expect(result).toMatchObject({ status: 'complete', nextOffset: Buffer.byteLength(raw) });
    expect(lines).toHaveLength(2);
    expect(lines.some(line => line.record.future)).toBe(false);
    expect((await task.step(work().fileSlice(file), grown, onLine)).status).toBe('complete');
    expect(lines).toHaveLength(3);
  });

  it('defers old-anchor validation without moving the complete-line watermark', async () => {
    const { file } = await fixture('{"head":true}\n');
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'fork_search', 0);
    await task.step(work().fileSlice(file), snapshot, () => {});
    const watermark = task.parsedOffset;
    await fs.appendFile(file, '{"new":true}\n');
    const grown = codexSourceSnapshot(await fs.stat(file));
    const onLine = vi.fn();
    const runtime = new InputRuntimeAccumulator();
    expect((await task.step(work(runtime, 1).fileSlice(file), grown, onLine)).status).toBe('deferred');
    expect(task.parsedOffset).toBe(watermark);
    expect(task.serialize().snapshot).toEqual(snapshot);
    expect(onLine).not.toHaveBeenCalled();
    expect(runtime.finish(0).codexRead!.readBytes.integrity_check).toBe(1);
    for (let cycle = 0; cycle < 40 && task.parsedOffset === watermark; cycle++) {
      await task.step(work(undefined, 4).fileSlice(file), grown, onLine);
    }
    expect(task.parsedOffset).toBe(grown.size);
    expect(onLine).toHaveBeenCalledTimes(1);
  });

  it('freezes a rewritten frontier outside the header and retains the old expectation across restart', async () => {
    const head = '{"head":true}\n';
    const raw = head + JSON.stringify({ padding: 'x'.repeat(6000), marker: 'old' }) + '\n';
    const { file } = await fixture(raw);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    let now = 0;
    const task = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'fork_search', 0, undefined, [], snapshot.size, () => now);
    for (let cycle = 0; cycle < 20 && task.parsedOffset < snapshot.size; cycle++) {
      await task.step(work().fileSlice(file), snapshot, () => {});
    }
    const oldState = task.serialize();
    await fs.writeFile(file, raw.replace('"old"', '"new"') + '{"later":true}\n');
    const changed = codexSourceSnapshot(await fs.stat(file));
    const onLine = vi.fn();
    expect((await task.step(work(undefined, 8192).fileSlice(file), changed, onLine)).status).toBe('source-conflict');
    expect(task.serialize()).toMatchObject({ nextCompleteOffset: oldState.nextCompleteOffset,
      snapshot, anchors: oldState.anchors, conflict: { reason: 'fingerprint', retryCount: 1, nextRetryAtMs: 10_000 } });
    expect(task.bufferedBytes).toBe(0);
    const state = parseCodexJsonlProbeState(task.serialize())!;
    const restored = new CodexGuardedJsonlReadTask(file, changed, 0, 'fork_search', state.nextCompleteOffset,
      state, [], changed.size, () => now);
    const runtime = new InputRuntimeAccumulator();
    expect((await restored.step(work(runtime).fileSlice(file), changed, onLine)).status).toBe('source-conflict');
    expect(runtime.finish(0).rawReadCalls).toBe(0);
    now = 10_000;
    expect((await restored.step(work(undefined, 8192).fileSlice(file), changed, onLine)).status).toBe('source-conflict');
    expect(restored.serialize().conflict?.retryCount).toBe(2);
    expect(onLine).not.toHaveBeenCalled();
    await fs.writeFile(file, raw + '{"later":true}\n');
    now = 30_000;
    expect((await restored.step(work(undefined, 8192).fileSlice(file), codexSourceSnapshot(await fs.stat(file)), onLine)).status).toBe('complete');
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(restored.serialize().conflict).toBeUndefined();
    expect(restored.sourceGeneration).toBe(0);
  });

  it('rebuilds provisional callbacks after failure rather than mixing them with a later checkpoint candidate', async () => {
    const { file } = await fixture('{"first":true}\n{"second":true}\n');
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'baseline', 0);
    await expect(task.step(work().fileSlice(file), snapshot, line => {
      if (line.record.second) throw new Error('provisional callback failed');
    }, false)).rejects.toThrow('provisional callback failed');
    expect(task.parsedOffset).toBe(0);
    expect(task.bufferedBytes).toBe(0);
    const lines: CodexJsonLine[] = [];
    expect((await task.step(work().fileSlice(file), snapshot, line => { lines.push(line); }, false)).status).toBe('complete');
    expect(lines.map(line => line.record)).toEqual([{ first: true }, { second: true }]);
    await expect(task.validate(work().fileSlice('another-file'), snapshot)).rejects.toThrow('another file');
  });

  it('rejects a provisional located line if the named source changes during its callback', async () => {
    const raw = '{"located":true}\n';
    const { file } = await fixture(raw);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const anchor = codexContentAnchor(Buffer.from(raw), 0);
    const task = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'fork_search', 0, undefined, [anchor]);
    const result = await task.step(work().fileSlice(file), snapshot, async () => {
      await fs.rename(file, `${file}.old`);
      await fs.writeFile(file, raw);
      return false;
    });
    expect(result).toMatchObject({ status: 'source-conflict', nextOffset: 0, records: 0 });
    expect(task.serialize()).toMatchObject({ snapshot, anchors: [anchor],
      conflict: { reason: 'identity', retryCount: 1 }, nextCompleteOffset: 0 });
    expect(task.bufferedBytes).toBe(0);
    const onLine = vi.fn();
    expect((await task.step(work().fileSlice(file), codexSourceSnapshot(await fs.stat(file)), onLine)).status).toBe('source-conflict');
    expect(onLine).not.toHaveBeenCalled();
  });

  it('retains the unfinished boundary stop after a failed tail callback', async () => {
    const before = '{"head":true}\n{"tail":';
    const { file } = await fixture(before);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'fork_search', 0);
    await task.step(work().fileSlice(file), snapshot, () => {});
    await fs.appendFile(file, 'true}\n{"future":true}\n');
    const grown = codexSourceSnapshot(await fs.stat(file));
    await expect(task.step(work().fileSlice(file), grown, () => { throw new Error('retry'); })).rejects.toThrow('retry');
    expect(task.serialize()).toMatchObject({ incompleteTail: true, nextCompleteOffset: Buffer.byteLength('{"head":true}\n') });
    const lines: CodexJsonLine[] = [];
    expect(await task.step(work().fileSlice(file), grown, line => { lines.push(line); }))
      .toMatchObject({ status: 'complete', nextOffset: Buffer.byteLength(before + 'true}\n') });
    expect(lines.map(line => line.record)).toEqual([{ tail: true }]);
  });

  it('rebuilds only its fixed baseline range and rejects invalid persisted evidence', async () => {
    const raw = '{"first":true}\n{"tail":true}\n';
    const { file } = await fixture(raw + '{"future":true}\n');
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'baseline', 0, undefined, [], Buffer.byteLength(raw));
    expect((await task.step(work(undefined, 4).fileSlice(file), snapshot, () => {})).status).toBe('deferred');
    const state = task.serialize();
    const parsed = parseCodexJsonlProbeState(state)!;
    parsed.anchors.push(codexContentAnchor(Buffer.from('x'), 0));
    expect(task.serialize()).toEqual(state);
    for (const invalid of [
      { ...state, sourceGeneration: -1 }, { ...state, nextCompleteOffset: state.targetSize + 1 },
      { ...state, targetSize: snapshot.size + 1 }, { ...state, incompleteTail: 'yes' },
      { ...state, anchors: [{ startOffset: 0, endOffset: 1, sha256: 'bad' }] },
      { ...state, conflict: { reason: 'bad', retryCount: 0, nextRetryAtMs: 0 } },
    ]) expect(parseCodexJsonlProbeState(invalid)).toBeUndefined();
    const restored = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'baseline', state.nextCompleteOffset, state);
    const lines: CodexJsonLine[] = [];
    expect((await restored.step(work().fileSlice(file), snapshot, line => { lines.push(line); }, false)).status).toBe('complete');
    expect(restored.parsedOffset).toBe(Buffer.byteLength(raw));
    expect(lines.map(line => line.record)).toEqual([{ first: true }, { tail: true }]);
  });
});

describe('普通扫描 dispatch 统计与预读保留', () => {
  it('rejects provisional complete lines when source replacement happens at a deferred time boundary', async () => {
    const raw = '{"first":true}\n{"second":true}\n';
    const { file } = await fixture(raw);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'normal_scan', 0);
    let now = 0;
    const budget = new CodexWorkBudget({ workSliceMs: 10 }, null, () => now);
    expect(await task.step(budget.fileSlice(file), snapshot, async () => {
      await fs.rename(file, `${file}.old`);
      await fs.writeFile(file, raw);
      now = 10;
    })).toMatchObject({ status: 'source-conflict', nextOffset: 0, records: 0 });
    expect(task.lastStepStatistics.records).toBe(0);
    expect(task.bufferedBytes).toBe(0);
  });

  it('keeps prefetched records after a terminal-style stop and reports only this dispatch statistics', async () => {
    const raw = Buffer.from('{"first":true}\nnot-json\n \n{"second":true}\n');
    const { file } = await fixture(raw);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexGuardedJsonlReadTask(file, snapshot, 0, 'normal_scan', 0);
    const runtime = new InputRuntimeAccumulator();
    const lines: CodexJsonLine[] = [];
    expect(await task.step(work(runtime).fileSlice(file), snapshot, line => { lines.push(line); return false; }, true, undefined, true))
      .toMatchObject({ status: 'deferred', records: 1, nextOffset: Buffer.byteLength('{"first":true}\n') });
    expect(task.lastStepStatistics).toEqual({ records: 1, parseSuccessRecords: 1, parseFailedRecords: 0,
      maxRecordBytes: Buffer.byteLength('{"first":true}\n') });
    expect(task.bufferedBytes).toBeGreaterThan(0);
    expect((await task.step(work(runtime).fileSlice(file), snapshot, line => { lines.push(line); })).status).toBe('complete');
    expect(task.lastStepStatistics).toEqual({ records: 2, parseSuccessRecords: 1, parseFailedRecords: 1,
      maxRecordBytes: Buffer.byteLength('{"second":true}\n') });
    expect(lines.map(line => line.record)).toEqual([{ first: true }, { second: true }]);
    expect(runtime.finish(0).rawReadBytes).toBe(raw.length);
    await task.step(work(runtime).fileSlice(file), snapshot, () => {});
    expect(task.lastStepStatistics).toEqual({ records: 0, parseSuccessRecords: 0, parseFailedRecords: 0, maxRecordBytes: 0 });
  });
});

describe('CodexRecordRangeReadTask', () => {
  it('defers complete-record delivery and hashes every raw byte including invalid JSON and CRLF', async () => {
    const raw = Buffer.from('{"head":true}\r\nnot-json\n \n' + JSON.stringify({ body: '中文'.repeat(300) }) + '\n');
    const { file, inode } = await fixture(raw);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const expectedRef = codexSourceRef(raw, 0, inode, 0);
    const task = new CodexRecordRangeReadTask(file, 0, raw.length, snapshot, 0, 'recovery', undefined, [], expectedRef);
    const runtime = new InputRuntimeAccumulator();
    let result;
    for (let cycle = 0; cycle < 50; cycle++) {
      result = await task.step(work(runtime, 80).fileSlice(file), snapshot);
      if (result.status === 'complete') break;
      expect(result).toEqual({ status: 'deferred' });
    }
    expect(result).toMatchObject({ status: 'complete', nextOffset: raw.length, sourceRef: expectedRef });
    if (result?.status !== 'complete') throw new Error('range did not complete');
    expect(result.items.map(line => line.record)).toEqual([{ head: true }, { body: '中文'.repeat(300) }]);
    expect(runtime.finish(0).rawReadBytes).toBe(raw.length);
    const cached = new InputRuntimeAccumulator();
    expect((await task.step(work(cached).fileSlice(file), snapshot)).status).toBe('complete');
    expect(cached.finish(0).rawReadBytes).toBe(0);
  });

  it('restores a partial fixed range by rebuilding all required records without persisting bodies', async () => {
    const raw = Buffer.from('{"first":true}\n' + JSON.stringify({ body: 'x'.repeat(1500) }) + '\n');
    const { file } = await fixture(raw);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexRecordRangeReadTask(file, 0, raw.length, snapshot, 0, 'hydrate');
    expect((await task.step(work(undefined, 80).fileSlice(file), snapshot)).status).toBe('deferred');
    const state = parseCodexRecordReadState(JSON.parse(JSON.stringify(task.serialize())))!;
    expect(state.probe.nextCompleteOffset).toBe(Buffer.byteLength('{"first":true}\n'));
    expect(JSON.stringify(state)).not.toContain('x'.repeat(100));
    const restored = new CodexRecordRangeReadTask(file, 0, raw.length, snapshot, 0, 'hydrate', state);
    const runtime = new InputRuntimeAccumulator();
    const result = await restored.step(work(runtime, 2048).fileSlice(file), snapshot);
    expect(result).toMatchObject({ status: 'complete', nextOffset: raw.length });
    if (result.status !== 'complete') throw new Error('range did not complete');
    expect(result.items).toHaveLength(2);
    expect(result.sourceRef.sha256).toBe(codexContentAnchor(raw, 0).sha256);
    expect(runtime.finish(0).rawReadBytes).toBe(raw.length);
  });

  it('freezes a full-range mismatch in a sparse-anchor blind spot and retains the original digest', async () => {
    const raw = Buffer.from(JSON.stringify({ head: 'x'.repeat(5000), marker: 'old', tail: 'y'.repeat(5000) }) + '\n');
    const { file, inode } = await fixture(raw);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const expectedRef = codexSourceRef(raw, 0, inode, 0);
    const rewritten = Buffer.from(raw.toString().replace('"old"', '"new"'));
    await fs.writeFile(file, rewritten);
    const changed = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexRecordRangeReadTask(file, 0, raw.length, changed, 0, 'recovery', undefined, [], expectedRef);
    let result;
    for (let cycle = 0; cycle < 4; cycle++) {
      result = await task.step(work(undefined, 16384).fileSlice(file), changed);
      if (result.status !== 'deferred') break;
    }
    expect(result?.status).toBe('source-conflict');
    const state = parseCodexRecordReadState(task.serialize())!;
    expect(state.expectedRef).toEqual(expectedRef);
    expect(state.probe.conflict?.reason).toBe('fingerprint');
    const restored = new CodexRecordRangeReadTask(file, 0, raw.length, changed, 0, 'recovery', state);
    const runtime = new InputRuntimeAccumulator();
    expect((await restored.step(work(runtime, 16384).fileSlice(file), changed)).status).toBe('source-conflict');
    expect(runtime.finish(0).rawReadCalls).toBe(0);
    expect(restored.serialize().expectedRef).toEqual(expectedRef);
  });

  it('waits for an incomplete fixed range without exposing records or retrying static EOF', async () => {
    const raw = Buffer.from('{"head":true}\n{"tail":');
    const { file } = await fixture(raw);
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexRecordRangeReadTask(file, 0, raw.length, snapshot, 0, 'recovery');
    expect(await task.step(work().fileSlice(file), snapshot)).toEqual({ status: 'waiting' });
    const runtime = new InputRuntimeAccumulator();
    expect(await task.step(work(runtime).fileSlice(file), snapshot)).toEqual({ status: 'waiting' });
    expect(runtime.finish(0).rawReadCalls).toBe(0);
  });

  it('rejects invalid range/checkpoint/source-reference fields and deep copies evidence', async () => {
    const { file } = await fixture('{"head":true}\n');
    const snapshot = codexSourceSnapshot(await fs.stat(file));
    const task = new CodexRecordRangeReadTask(file, 0, snapshot.size, snapshot, 0, 'recovery');
    await task.step(work().fileSlice(file), snapshot);
    const state = task.serialize();
    const parsed = parseCodexRecordReadState(state)!;
    parsed.probe.anchors[0]!.sha256 = 'f'.repeat(64);
    expect(task.serialize()).toEqual(state);
    for (const invalid of [{ ...state, endOffset: 0 }, { ...state, startOffset: -1 }, { ...state, reason: 'normal_scan' },
      { ...state, probe: { ...state.probe, targetSize: snapshot.size - 1 } },
      { ...state, expectedRef: { inode: snapshot.inode, sourceGeneration: 2, startOffset: 0, endOffset: snapshot.size, sha256: 'a'.repeat(64) } },
    ]) expect(parseCodexRecordReadState(invalid)).toBeUndefined();
    for (const invalid of [null, {}, { ...codexSourceRef(Buffer.from('x'), 0, snapshot.inode, 0), endOffset: 0 }]) {
      expect(parseCodexSourceRef(invalid)).toBeUndefined();
    }
  });
});

describe('CodexRangeReadTask', () => {
  it('hydrates the same complete raw bytes whose SHA-256 was checked', async () => {
    const raw = Buffer.from('{"instructions":"' + 'x'.repeat(256) + '"}\r\n');
    const { file, inode } = await fixture(raw);
    const ref = codexSourceRef(raw, 0, inode, 1);
    const task = new CodexRangeReadTask(file, ref);
    // Mutating a caller-owned expectation cannot alter a retained task.
    ref.sha256 = '0'.repeat(64);
    const runtime = new InputRuntimeAccumulator();
    let result;
    for (let cycle = 0; cycle < 10; cycle++) {
      result = await task.step(work(runtime, 50).fileSlice(file), 1);
      if (result.status === 'complete') break;
      expect(result.status).toBe('deferred');
    }
    expect(result!.status).toBe('complete');
    if (result?.status === 'complete') expect(result.bytes).toEqual(raw);
    expect(runtime.finish(0).codexRead!.readBytes.hydrate).toBe(raw.length);
  });

  it('rejects a rewritten prefix followed by growth despite an unchanged inode', async () => {
    const old = Buffer.from('{"body":"original"}\n');
    const { file, inode } = await fixture(old);
    const task = new CodexRangeReadTask(file, codexSourceRef(old, 0, inode, 1));
    await fs.writeFile(file, '{"body":"rewritten"}\n' + 'padding'.repeat(32));
    expect((await fs.stat(file)).ino).toBe(inode);
    expect((await fs.stat(file)).size).toBeGreaterThan(old.length);
    const result = await task.step(work().fileSlice(file), 1);
    expect(result.status).toBe('source-conflict');
    if (result.status === 'source-conflict') expect(result.conflict.reason).toBe('fingerprint');
    expect(await task.step(work().fileSlice(file), 1)).toEqual(result);
  });

  it('rejects changes between paused hydration chunks, including non-anchor bytes', async () => {
    const raw = Buffer.from('a'.repeat(200));
    const { file, inode } = await fixture(raw);
    const task = new CodexRangeReadTask(file, codexSourceRef(raw, 0, inode, 2), 'integrity_check');
    expect(await task.step(work(undefined, 50).fileSlice(file), 2)).toEqual({ status: 'deferred' });
    const handle = await fs.open(file, 'r+');
    await handle.write(Buffer.from('b'), 0, 1, 100);
    await handle.close();
    let result;
    for (let cycle = 0; cycle < 10; cycle++) {
      result = await task.step(work(undefined, 50).fileSlice(file), 2);
      if (result.status !== 'deferred') break;
    }
    expect(result!.status).toBe('source-conflict');
    if (result?.status === 'source-conflict') expect(result.conflict.reason).toBe('fingerprint');
  });

  it('rejects a replaced inode and a generation mismatch without accepting old offsets', async () => {
    const raw = Buffer.from('{"old":true}\n');
    const { file, inode } = await fixture(raw);
    const ref = codexSourceRef(raw, 0, inode, 1);
    const task = new CodexRangeReadTask(file, ref);
    await fs.rename(file, `${file}.old`);
    await fs.writeFile(file, raw);
    const result = await task.step(work().fileSlice(file), 1);
    expect(result.status).toBe('source-conflict');
    if (result.status === 'source-conflict') expect(result.conflict.reason).toBe('identity');
    const next = new CodexRangeReadTask(file, ref);
    const runtime = new InputRuntimeAccumulator();
    expect((await next.step(work(runtime).fileSlice(file), 2)).status).toBe('source-conflict');
    expect(runtime.finish(0).rawReadCalls).toBe(0);
  });

  it('does not mistake budget exhaustion or truncation for successful empty hydration', async () => {
    const raw = Buffer.from('{"body":true}\n');
    const { file, inode } = await fixture(raw);
    const task = new CodexRangeReadTask(file, codexSourceRef(raw, 0, inode, 1));
    expect(await task.step(work(undefined, 0).fileSlice(file), 1)).toEqual({ status: 'deferred' });
    await fs.truncate(file, 0);
    const result = await task.step(work().fileSlice(file), 1);
    expect(result.status).toBe('source-conflict');
    if (result.status === 'source-conflict') expect(result.conflict.reason).toBe('truncated');
  });
});
