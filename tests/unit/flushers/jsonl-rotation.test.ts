import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonlFlusher } from '../../../src/flushers/jsonl-flusher.js';
import { getTodayDateString } from '../../../src/utils/fs-utils.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function setup(rotateDaily = true) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-rotation-')); dirs.push(outputDir);
  const options = { enabled: true, outputDir, rotateDaily, maxFileSizeMb: 1024 / (1024 * 1024) };
  const flusher = new JsonlFlusher(options); await flusher.start();
  return { outputDir, options, flusher };
}
const entry = (id: string, text = '界'.repeat(50)) => buildTestEntry({ uuid: id, agentType: 'copilot', 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: text }] }] });
async function readAll(dir: string) {
  const files = await fs.readdir(dir);
  const records = (await Promise.all(files.map(file => fs.readFile(path.join(dir, file), 'utf8'))))
    .flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  return { files, records };
}

it('serializes concurrent writes and preserves UTF-8 records across size-based rotation', async () => {
  const { outputDir, flusher } = await setup();
  await Promise.all(Array.from({ length: 12 }, (_, i) => flusher.send(entry(String(i)))));
  await flusher.flush();
  const { files, records } = await readAll(outputDir);
  expect(files.length).toBeGreaterThan(1);
  expect(records).toHaveLength(12); expect(new Set(records.map(r => r['event.id'])).size).toBe(12);
  expect(files).toContain(`copilot-${getTodayDateString()}.jsonl`);
  for (const file of files) expect((await fs.stat(path.join(outputDir, file))).size).toBeLessThanOrEqual(1024);
  for (const record of records) expect(record['gen_ai.input.messages'][0].parts[0].content).toBe('界'.repeat(50));
});

it('resumes existing files without overwriting closed segments after reconstruction', async () => {
  const { outputDir, options, flusher } = await setup();
  await flusher.sendBatch([entry('a'), entry('b'), entry('c')]); await flusher.shutdown();
  const before = await readAll(outputDir);
  const closed = before.files.find(file => file.includes('.part-'))!;
  const original = await fs.readFile(path.join(outputDir, closed), 'utf8');
  const next = new JsonlFlusher(options);
  await next.sendBatch([entry('d'), entry('e')]); await next.shutdown();
  expect(await fs.readFile(path.join(outputDir, closed), 'utf8')).toBe(original);
  expect((await readAll(outputDir)).records.map(r => r['event.id']).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
});

it('rotates legacy oversized files without splitting or truncating a single large event', async () => {
  const { outputDir, flusher } = await setup();
  await flusher.send(entry('large', 'x'.repeat(3000)));
  await flusher.send(entry('small'));
  const { files, records } = await readAll(outputDir);
  expect(files).toHaveLength(2); expect(records).toHaveLength(2);
  expect(records.find(r => r['event.id'] === 'large')['gen_ai.input.messages'][0].parts[0].content).toHaveLength(3000);
  expect((await fs.stat(path.join(outputDir, `copilot-${getTodayDateString()}.jsonl`))).size).toBeLessThanOrEqual(1024);
});

it('applies the same rotation to raw topics and rotateDaily=false output', async () => {
  const { outputDir, flusher } = await setup(false);
  await flusher.sendBatch([entry('a'), entry('b'), entry('c')]);
  for (let i = 0; i < 5; i++) await flusher.sendRaw('metrics', { id: i, content: 'x'.repeat(600) });
  const { files, records } = await readAll(outputDir);
  expect(files).toContain('copilot-all.jsonl'); expect(files.some(file => file.endsWith('-all.jsonl') && file.includes('.part-'))).toBe(true);
  expect(files.some(file => file.startsWith('metrics.part-'))).toBe(true);
  expect(records).toHaveLength(8);
});

it('reports filesystem failure and allows a later write to recover', async () => {
  const { outputDir, flusher } = await setup();
  const active = path.join(outputDir, `copilot-${getTodayDateString()}.jsonl`);
  await fs.mkdir(active);
  await expect(flusher.send(entry('failed'))).rejects.toThrow('not a regular file');
  await fs.rmdir(active);
  await flusher.send(entry('accepted'));
  expect((await readAll(outputDir)).records.map(r => r['event.id'])).toEqual(['accepted']);
});

it('does not reuse a segment name after retention removes previously closed files', async () => {
  const { outputDir, options, flusher } = await setup();
  await flusher.sendBatch([entry('a'), entry('b')]);
  const oldNames = (await fs.readdir(outputDir)).filter(file => file.includes('.part-'));
  expect(oldNames.length).toBeGreaterThan(0);
  for (const file of oldNames) await fs.unlink(path.join(outputDir, file));
  const next = new JsonlFlusher(options); await next.send(entry('c'));
  const newNames = (await fs.readdir(outputDir)).filter(file => file.includes('.part-'));
  expect(newNames.length).toBeGreaterThan(0);
  expect(newNames.some(file => oldNames.includes(file))).toBe(false);
});
