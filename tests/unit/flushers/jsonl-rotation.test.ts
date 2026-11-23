import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonlFlusher } from '../../../src/flushers/jsonl-flusher.js';
import { getTodayDateString } from '../../../src/utils/fs-utils.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';
import { LOCAL_LOG_EMERGENCY_FILE_BYTES } from '../../../src/utils/segmented-jsonl-writer.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof fs>();
  return { ...original, open: vi.fn(original.open) };
});

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
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

it.each([false, true])('repairs the active Kimi tail before appending and preserves its accepted prefix (daily=%s)', async rotateDaily => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 20, 12));
  const { outputDir, options, flusher } = await setup(rotateDaily);
  const first = { ...entry('kimi-a'), 'gen_ai.agent.type': 'kimi-code-cli' };
  const second = { ...entry('kimi-b'), 'gen_ai.agent.type': 'kimi-code-cli' };
  await flusher.send(first);
  await flusher.shutdown();
  const file = path.join(outputDir, `kimi-code-cli-${rotateDaily ? getTodayDateString() : 'all'}.jsonl`);
  const complete = await fs.readFile(file, 'utf8');
  // Simulate termination in the middle of a UTF-8 payload. The event ID is
  // already present, but there is no committed record ending in a newline.
  await fs.appendFile(file, '{"event.id":"kimi-b","gen_ai.agent.type":"kimi-code-cli","text":"');
  await fs.appendFile(file, Buffer.from([0xe7, 0x95]));
  const restarted = new JsonlFlusher(options);
  await restarted.sendBatch([first, second]);
  await restarted.shutdown();
  const { records } = await readAll(outputDir);
  expect(records.map(record => record['event.id']).sort()).toEqual(['kimi-a', 'kimi-b']);
  expect(JSON.stringify(records.find(record => record['event.id'] === 'kimi-a')) + '\n').toBe(complete);
});

it.each(['kimi-code-cli-2026-11-20.jsonl', `kimi-code-cli.part-${'a'.repeat(32)}-2026-11-20.jsonl`])(
  'recovers complete Kimi receipts from the read-only archive %s', async filename => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 21, 12));
    const { outputDir, flusher } = await setup(true);
    const archived = path.join(outputDir, filename);
    const active = path.join(outputDir, `kimi-code-cli-${getTodayDateString()}.jsonl`);
    const accepted = { ...entry('kimi-accepted'), 'gen_ai.agent.type': 'kimi-code-cli' };
    const interrupted = { ...entry('kimi-interrupted'), 'gen_ai.agent.type': 'kimi-code-cli' };
    const bytes = JSON.stringify(accepted) + '\n' + JSON.stringify(interrupted);
    await fs.writeFile(archived, bytes, { mode: 0o444 });

    await flusher.createBatchDelivery([accepted, interrupted], undefined, undefined, { requireAcceptance: true })();

    expect(await fs.readFile(archived, 'utf8')).toBe(bytes);
    expect(JSON.parse((await fs.readFile(active, 'utf8')).trim())['event.id']).toBe('kimi-interrupted');
    await flusher.shutdown();
  },
);

it('rejects a failed Kimi write and accepts a single record once the active output is writable', async () => {
  const { outputDir, flusher } = await setup(false);
  const active = path.join(outputDir, 'kimi-code-cli-all.jsonl');
  const kimi = { ...entry('kimi-failed-append'), 'gen_ai.agent.type': 'kimi-code-cli' };
  await fs.mkdir(active);
  const deliver = flusher.createBatchDelivery([kimi], undefined, undefined, { requireAcceptance: true });
  await expect(deliver()).rejects.toThrow('not a regular file');
  await fs.rmdir(active);
  await deliver();
  await deliver();
  expect((await readAll(outputDir)).records.map(record => record['event.id'])).toEqual(['kimi-failed-append']);
  await flusher.shutdown();
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'rejects an unreadable Kimi archive until its receipt can be checked', async () => {
    const { outputDir, flusher } = await setup(false);
    const archived = path.join(outputDir, `kimi-code-cli.part-${'b'.repeat(32)}-all.jsonl`);
    const kimi = { ...entry('kimi-unreadable-receipt'), 'gen_ai.agent.type': 'kimi-code-cli' };
    await fs.writeFile(archived, JSON.stringify(kimi) + '\n');
    const deliver = flusher.createBatchDelivery([kimi], undefined, undefined, { requireAcceptance: true });
    await fs.chmod(archived, 0o000);
    try {
      await expect(deliver()).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await fs.chmod(archived, 0o600);
    }
    await deliver();
    expect(await fs.readdir(outputDir)).toEqual([path.basename(archived)]);
    await flusher.shutdown();
  },
);

it('finds a retained Kimi receipt beyond the recent cache and avoids archive reads for new IDs', async () => {
  const { outputDir, options } = await setup(false);
  const old = 'kimi-retained-event';
  const archive = path.join(outputDir, `kimi-code-cli.part-${'a'.repeat(32)}-all.jsonl`);
  const active = path.join(outputDir, 'kimi-code-cli-all.jsonl');
  const otherAgent = path.join(outputDir, 'codex-all.jsonl');
  const line = (id: string) => JSON.stringify({ 'event.id': id, 'gen_ai.agent.type': 'kimi-code-cli' }) + '\n';
  await fs.writeFile(archive, line(old));
  await fs.utimes(archive, 1, 1);
  await fs.writeFile(active, Array.from({ length: 65_536 }, (_, index) => line(`kimi-recent-${index}`)).join(''));
  await fs.writeFile(otherAgent, line('kimi-new-event-after-restart'));
  const flusher = new JsonlFlusher({ ...options, maxFileSizeMb: 100 });
  const open = vi.mocked(fs.open);
  open.mockClear();
  const deliver = (id: string) => flusher.createBatchDelivery([
    { ...entry(id), 'gen_ai.agent.type': 'kimi-code-cli' },
  ], undefined, undefined, { requireAcceptance: true })();

  await deliver(old);
  expect(open.mock.calls.filter(([file]) => file === archive)).toHaveLength(2);
  expect(open.mock.calls.some(([file]) => file === otherAgent)).toBe(false);
  expect((await fs.readFile(active, 'utf8')).includes(old)).toBe(false);
  open.mockClear();
  await deliver('kimi-new-event-after-restart');
  expect(open.mock.calls.some(([file]) => file === archive)).toBe(false);
  expect((await fs.readFile(active, 'utf8')).includes('kimi-new-event-after-restart')).toBe(true);
  await flusher.shutdown();
});

it('serializes two writer instances sharing the same active file', async () => {
  const { outputDir, options, flusher } = await setup();
  const next = new JsonlFlusher(options);
  await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? next : flusher).send(entry(String(i)))));
  await Promise.all([flusher.shutdown(), next.shutdown()]);
  const { files, records } = await readAll(outputDir);
  expect(records).toHaveLength(24);
  expect(new Set(records.map(record => record['event.id'])).size).toBe(24);
  for (const file of files) expect((await fs.stat(path.join(outputDir, file))).size).toBeLessThanOrEqual(1024);
});

it('reclaims a sparse legacy file over 3 GiB before the next append without archiving it', async () => {
  const { outputDir, flusher } = await setup();
  const active = path.join(outputDir, `copilot-${getTodayDateString()}.jsonl`);
  await fs.writeFile(active, 'old');
  await fs.truncate(active, LOCAL_LOG_EMERGENCY_FILE_BYTES + 1);
  await flusher.send(entry('new'));
  const { files, records } = await readAll(outputDir);
  expect(files).toHaveLength(1);
  expect(records.map(record => record['event.id'])).toEqual(['new']);
  expect((await fs.stat(active)).size).toBeLessThanOrEqual(1024);
});
