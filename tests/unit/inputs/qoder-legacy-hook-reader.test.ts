import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as promises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QoderLegacyHookReader } from '../../../src/inputs/qoder-trace/legacy-hook-reader.js';
import type { InputRuntimeAccumulator } from '../../../src/inputs/base/input-runtime-metrics.js';

// Copy the ESM namespace so spies can replace exports. Direct spying on the
// native namespace throws "Cannot redefine property: stat" in this runner.
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

let root: string;
afterEach(() => { vi.restoreAllMocks(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
function setup(recordBytes = 256 * 1024) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-legacy-reader-'));
  const file = path.join(root, 'history.jsonl');
  const reader = new QoderLegacyHookReader(64 * 1024, recordBytes);
  let offset = 0;
  let bytes = 0;
  const runtime = { now: () => performance.now(), observeRead: (count: number) => { bytes += count; } } as InputRuntimeAccumulator;
  const poll = async () => {
    bytes = 0;
    const batch = await reader.read(file, offset, runtime);
    offset = batch.nextOffset;
    return { ...batch, bytes };
  };
  return { file, reader, poll, offset: () => offset };
}

it('reads unchanged partial bodies once, then completes split UTF-8 without repeated output', async () => {
  const p = setup();
  const value = JSON.stringify({ text: 'x'.repeat(160 * 1024) + '中文🙂' });
  const bytes = Buffer.from(value);
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  fs.writeFileSync(p.file, bytes.subarray(0, split));
  let totalRead = 0;
  for (let i = 0; i < 4; i++) {
    const batch = await p.poll();
    expect(batch.buffer.length).toBe(0);
    expect(batch.nextOffset).toBe(0);
    expect(batch.bytes).toBeLessThanOrEqual(64 * 1024);
    totalRead += batch.bytes;
  }
  expect(totalRead).toBe(split);
  expect((await p.poll()).bytes).toBe(0);
  fs.appendFileSync(p.file, Buffer.concat([bytes.subarray(split), Buffer.from('\n')]));
  const completed = await p.poll();
  expect(JSON.parse(completed.buffer.toString())).toEqual(JSON.parse(value));
  expect(completed.bytes).toBeLessThan(256);
  expect((await p.poll()).buffer.length).toBe(0);
  expect((await p.poll()).bytes).toBe(0);
});

it('quarantines an over-limit record by byte range, drains the following line, and retains the source', async () => {
  const p = setup(128 * 1024);
  const large = JSON.stringify({ text: 'x'.repeat(192 * 1024) }) + '\n';
  const small = JSON.stringify({ id: 'following-record' }) + '\n';
  const source = large + small;
  fs.writeFileSync(p.file, source);
  const records: unknown[] = [];
  const ranges: { from: number; to: number | null }[] = [];
  for (let i = 0; i < 6 && p.offset() < Buffer.byteLength(source); i++) {
    const batch = await p.poll();
    expect(batch.bytes).toBeLessThanOrEqual(64 * 1024);
    records.push(...batch.buffer.toString().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    ranges.push(...batch.quarantine);
  }
  expect(records).toEqual([{ id: 'following-record' }]);
  expect(ranges).toContainEqual(expect.objectContaining({ from: 0, to: Buffer.byteLength(large) }));
  expect(p.offset()).toBe(Buffer.byteLength(source));
  expect(fs.readFileSync(p.file, 'utf8')).toBe(source);
  expect((await p.poll()).bytes).toBe(0);
});

it('does not retain a partial record after truncation or replacement', async () => {
  const p = setup();
  fs.writeFileSync(p.file, '{"text":"' + 'x'.repeat(96 * 1024));
  expect((await p.poll()).nextOffset).toBe(0);
  fs.writeFileSync(p.file, '{"id":"rewritten"}\n');
  const rewritten = await p.poll();
  expect(JSON.parse(rewritten.buffer.toString())).toEqual({ id: 'rewritten' });
  fs.writeFileSync(p.file + '.new', '{"id":"replacement"}\n');
  fs.renameSync(p.file + '.new', p.file);
  // The Input resets its semantic cursor for a shorter file; a fresh reader
  // similarly starts at an explicit complete-record checkpoint.
  p.reader.reset();
  const replacement = await p.reader.read(p.file, 0, null);
  expect(JSON.parse(replacement.buffer.toString())).toEqual({ id: 'replacement' });
});

it('invalidates a growing partial record when its identity prefix was rewritten', async () => {
  const p = setup();
  fs.writeFileSync(p.file, '{"id":"old","text":"' + 'x'.repeat(96 * 1024));
  expect((await p.poll()).nextOffset).toBe(0);
  fs.writeFileSync(p.file, JSON.stringify({ id: 'new', text: 'x'.repeat(96 * 1024) }) + '\n');
  const buffers: Buffer[] = [];
  for (let i = 0; i < 4 && p.offset() < fs.statSync(p.file).size; i++) buffers.push((await p.poll()).buffer);
  expect(JSON.parse(Buffer.concat(buffers).toString())).toEqual({ id: 'new', text: 'x'.repeat(96 * 1024) });
});

it.each(['rewrite', 'append'])('checks growing partial records with unchanged timestamps (%s)', async mode => {
  const p = setup();
  const coarseTimes = { mtimeMs: 1700000000000, ctimeMs: 1700000000000 };
  const snapshot = (stat: fs.Stats): fs.Stats => Object.create(Object.getPrototypeOf(stat), {
    ...Object.getOwnPropertyDescriptors(stat),
    mtimeMs: { value: coarseTimes.mtimeMs, enumerable: true, configurable: true },
    ctimeMs: { value: coarseTimes.ctimeMs, enumerable: true, configurable: true },
  });
  const open = promises.open;
  // Model a coarse-timestamp filesystem while retaining real bytes, inode,
  // sizes and bounded reads. Both stat paths must describe the same source.
  vi.spyOn(promises, 'stat').mockImplementation(async file => snapshot(fs.statSync(file)));
  vi.spyOn(promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    vi.spyOn(handle, 'stat').mockImplementation(async () => snapshot(fs.fstatSync(handle.fd)));
    return handle;
  });
  fs.writeFileSync(p.file, '{"id":"old","text":"' + 'x'.repeat(96 * 1024));
  expect((await p.poll()).nextOffset).toBe(0);
  if (mode === 'rewrite') fs.writeFileSync(p.file, JSON.stringify({ id: 'new', text: 'x'.repeat(96 * 1024) }) + '\n');
  else fs.appendFileSync(p.file, '"}\n');
  const buffers: Buffer[] = [];
  for (let i = 0; i < 4 && p.offset() < fs.statSync(p.file).size; i++) {
    const batch = await p.poll();
    expect(batch.bytes).toBeLessThanOrEqual(64 * 1024);
    buffers.push(batch.buffer);
  }
  const value = JSON.parse(Buffer.concat(buffers).toString());
  expect(value.id).toBe(mode === 'rewrite' ? 'new' : 'old');
  expect(value.text).toBe('x'.repeat(96 * 1024));
  expect((await p.poll()).bytes).toBe(0);
});
