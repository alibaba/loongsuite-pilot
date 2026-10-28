import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoubaoWorkNativeReader } from '../../../src/inputs/doubao-work/doubao-work-reader.js';
import { DoubaoWorkBudget, DoubaoWorkDeferred } from '../../../src/inputs/doubao-work/doubao-work-budget.js';
import { parseNativeGraph } from '../../../src/inputs/doubao-work/doubao-work-native.js';
import { parseNativeContent } from '../../../src/inputs/doubao-work/doubao-work-content.js';
import { reconstructNativeRounds } from '../../../src/inputs/doubao-work/doubao-work-rounds.js';
import { DOUBAO_EPOCH } from '../../helpers/doubao-work-fixture.js';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const folders: string[] = [];
const cid = '12345678', actor = 'm_main';
const serialized = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const assignment = (text = 'CURRENT', time = DOUBAO_EPOCH + 1) => `## [${new Date(time).toISOString()}] 需求\n${text}\n`;
const budget = (bytes = 8 * 1024 * 1024, records = 4096) => new DoubaoWorkBudget(null, { bytes, records, milliseconds: 1000 });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(folders.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'doubao-native-cache-')); folders.push(root);
  const sessionsRoot = path.join(root, 'sessions'), snapshotRoot = path.join(root, 'snapshots');
  await fs.mkdir(sessionsRoot); await fs.mkdir(snapshotRoot);
  return { root, sessionsRoot, snapshotRoot };
}
async function save(sessions: string, conversation = cid, rows: unknown[] = [{ role: 'assistant', content: 'FINAL' }], task = assignment(), id = actor) {
  const system = path.join(sessions, conversation, 'agents', id, 'system'); await fs.mkdir(system, { recursive: true });
  const file = path.join(system, 'trajectory.jsonl'); await fs.writeFile(file, serialized(rows)); await fs.writeFile(path.join(system, 'assignment.md'), task);
  return file;
}
async function drain(reader: DoubaoWorkNativeReader, conversation = cid, bytes = 256 * 1024) {
  for (let i = 0; i < 100; i++) {
    try { return await reader.graph(conversation, budget(bytes)); }
    catch (error) { if (!(error instanceof DoubaoWorkDeferred) || error.reason !== 'cycle_budget') throw error; }
  }
  throw new Error('native reader did not drain');
}

describe('bounded incremental Doubao native sources', () => {
  it('shares the exact decoded content and performs no body reads or parsing for unchanged sources', async () => {
    const { sessionsRoot } = await fixture();
    const rows = [{ role: 'assistant', content: 'plan', tool_calls: [{ id: 'read-one', function: { name: 'Read', arguments: { file_path: 'synthetic.txt' } } }] },
      { role: 'tool', tool_call_id: 'read-one', content: 'visible result\ud800中文' }, { role: 'assistant', content: 'FINAL' }];
    await save(sessionsRoot, cid, rows);
    const reader = new DoubaoWorkNativeReader({ sessionsRoot });
    const graph = await drain(reader), expected = parseNativeContent({ [actor]: serialized(rows) }, { [actor]: assignment() });
    expect(graph?.content).toMatchObject(expected!);
    const prior = reader.stats();
    for (let i = 0; i < 10; i++) expect(await reader.graph(cid, budget())).toBe(graph);
    expect(reader.stats()).toMatchObject({ bodyReadBytes: prior.bodyReadBytes, parsedRows: prior.parsedRows });
    expect(reader.stats().cacheHits - prior.cacheHits).toBe(20);
  });

  it('waits for a complete UTF-8 line and parses only appended records', async () => {
    const { sessionsRoot } = await fixture(), file = await save(sessionsRoot);
    const reader = new DoubaoWorkNativeReader({ sessionsRoot }); await drain(reader);
    const line = Buffer.from(JSON.stringify({ role: 'assistant', content: '中文追加' }) + '\n');
    const split = line.indexOf(Buffer.from('中')) + 1;
    await fs.appendFile(file, line.subarray(0, split));
    await expect(reader.graph(cid, budget())).rejects.toMatchObject({ reason: 'partial_line' });
    const partial = reader.stats();
    await expect(reader.graph(cid, budget())).rejects.toMatchObject({ reason: 'partial_line' });
    expect(reader.stats().bodyReadBytes).toBe(partial.bodyReadBytes);
    await fs.appendFile(file, line.subarray(split));
    const graph = await reader.graph(cid, budget());
    expect(graph?.content?.transcripts?.[actor].at(-1)).toEqual({ role: 'assistant', content: '中文追加' });
    expect(reader.stats().parsedRows - partial.parsedRows).toBe(1);
    expect(reader.stats().bodyReadBytes - partial.bodyReadBytes).toBe(line.length - split);
  });

  it.each(['same-size', 'replacement', 'truncate-regrow'] as const)('invalidates %s without using stat times as model or execution times', async mode => {
    const { sessionsRoot } = await fixture(), file = await save(sessionsRoot, cid, [{ role: 'assistant', content: 'OLD!' }]);
    const reader = new DoubaoWorkNativeReader({ sessionsRoot }); await drain(reader); const stat = await fs.stat(file);
    if (mode === 'replacement') await fs.rename(file, file + '.old');
    await fs.writeFile(file, serialized([{ role: 'assistant', content: 'NEW!' }, ...(mode === 'truncate-regrow' ? [{ role: 'assistant', content: 'longer new tail' }] : [])]));
    if (mode === 'same-size') await fs.utimes(file, stat.atime, stat.mtime);
    const graph = await drain(reader);
    expect(JSON.stringify(graph?.content)).toContain('NEW!'); expect(JSON.stringify(graph?.content)).not.toContain('OLD!');
    expect(reader.stats().resets).toBe(1);
  });

  it('caches only execution metadata after the first bounded snapshot parse and notices changes', async () => {
    const { sessionsRoot, snapshotRoot } = await fixture();
    const execution = { executionKey: '00000000-0000-4000-8000-000000000001', conversationId: cid,
      queryMessageId: '00000000-0000-4000-8000-000000000002', agentId: 's_child', agentType: 'sub_agent', sandboxId: 'box', startedAtMs: DOUBAO_EPOCH, endedAtMs: DOUBAO_EPOCH + 1000 };
    const directory = path.join(snapshotRoot, '123', cid, execution.executionKey); await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 's_child.json'); await fs.writeFile(file, JSON.stringify({ execution, fileContents: 'PRIVATE_BODY'.repeat(90_000) }));
    const reader = new DoubaoWorkNativeReader({ sessionsRoot, snapshotRoot });
    expect(await reader.executions(cid, budget())).toEqual([execution]);
    const before = reader.stats(); expect(before.retainedBytes).toBeLessThan(4096);
    for (let i = 0; i < 10; i++) expect(await reader.executions(cid, budget())).toEqual([execution]);
    expect(reader.stats()).toMatchObject({ bodyReadBytes: before.bodyReadBytes, parsedRows: before.parsedRows });
    await fs.writeFile(file, JSON.stringify({ execution: { ...execution, endedAtMs: execution.endedAtMs + 1 } }));
    expect((await reader.executions(cid, budget()))[0].endedAtMs).toBe(execution.endedAtMs + 1);
    await fs.writeFile(file, '{half'); await expect(reader.executions(cid, budget())).rejects.toThrow();
    const failed = reader.stats(); await expect(reader.executions(cid, budget())).rejects.toThrow();
    expect(reader.stats().bodyReadBytes).toBe(failed.bodyReadBytes);
    await fs.writeFile(file, JSON.stringify({ execution })); expect(await reader.executions(cid, budget())).toEqual([execution]);
  });

  it('preserves early ancestry and exact new rounds after a trajectory grows beyond 2 MiB', async () => {
    const { sessionsRoot } = await fixture();
    const rows: any[] = [
      { role: 'assistant', tool_calls: [{ id: 'create-one', function: { name: 'create_agent', arguments: { task: 'synthetic' } } }] },
      { role: 'tool', tool_call_id: 'create-one', content: 'create_agent ok\nagent_id: s_child\nparent_id: main_agent\nthread_id: 123\n' },
      ...Array.from({ length: 220 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) + 'x'.repeat(16_000) })),
      { role: 'user', content: 'CURRENT' },
      { role: 'assistant', content: 'parallel', tool_calls: ['one', 'two'].map(id => ({ id, function: { name: 'Read', arguments: { file_path: id } } })) },
      { role: 'tool', tool_call_id: 'two', content: 'second' }, { role: 'tool', tool_call_id: 'one', content: 'first' },
      { role: 'assistant', content: 'FINAL' },
    ];
    const raw = serialized(rows), tasks = assignment('OLD', DOUBAO_EPOCH - 1000) + assignment();
    expect(Buffer.byteLength(raw)).toBeGreaterThan(2 * 1024 * 1024);
    const reasons: string[] = [];
    const file = await save(sessionsRoot, cid, rows, tasks), reader = new DoubaoWorkNativeReader({ sessionsRoot, diagnostic: reason => reasons.push(reason) });
    const graph = await drain(reader, cid, 128 * 1024);
    expect(graph?.edges).toEqual(parseNativeGraph({ [actor]: raw })?.edges);
    expect(graph!.content!.transcriptOffsets![actor]).toBeGreaterThan(0);
    expect(reasons).toContain('content_window');
    const end = String(BigInt(DOUBAO_EPOCH + 5000) * 1_000_000n);
    const expected = reconstructNativeRounds(parseNativeContent({ [actor]: raw }, { [actor]: tasks }), actor, DOUBAO_EPOCH, end, ['one', 'two']);
    const actual = reconstructNativeRounds(graph!.content, actor, DOUBAO_EPOCH, end, ['one', 'two']);
    expect(actual).toEqual(expected); expect(actual?.rounds).toHaveLength(2);
    expect(reader.stats().bodyReadBytes).toBe(Buffer.byteLength(raw) + Buffer.byteLength(tasks));
    const previous = reader.stats(); await fs.appendFile(file, serialized([{ role: 'user', content: 'NEXT' }, { role: 'assistant', content: 'NEXT_FINAL' }]));
    const next = await drain(reader); expect(next?.edges.s_child).toBeDefined();
    expect(reader.stats().parsedRows - previous.parsedRows).toBe(2);
  });

  it('prioritizes active cache entries, enforces capacity and expires inactive files', async () => {
    const { sessionsRoot } = await fixture();
    for (const conversation of ['1', '2', '3']) await save(sessionsRoot, conversation);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    const reader = new DoubaoWorkNativeReader({ sessionsRoot, maxFiles: 4, ttlMs: 1000 });
    await drain(reader, '1'); reader.beginCycle(new Set(['2'])); await drain(reader, '2'); clock.mockReturnValue(200);
    await drain(reader, '3'); expect(reader.stats().files).toBeLessThanOrEqual(4);
    const before = reader.stats(); await drain(reader, '2'); expect(reader.stats().bodyReadBytes).toBe(before.bodyReadBytes);
    clock.mockReturnValue(2000); reader.beginCycle(new Set(['2'])); expect(reader.stats().files).toBe(2);
    const reasons: string[] = [], tiny = new DoubaoWorkNativeReader({ sessionsRoot, maxCacheBytes: 10, diagnostic: reason => reasons.push(reason) });
    await expect(tiny.graph('1', budget())).rejects.toThrow('capacity');
    expect(tiny.stats().retainedBytes).toBeLessThanOrEqual(10); expect(reasons).toContain('cache_capacity');
  });

  it('does not reuse cached content through a replaced symlink and recovers from transient stat errors', async () => {
    const { sessionsRoot } = await fixture(), file = await save(sessionsRoot);
    const reader = new DoubaoWorkNativeReader({ sessionsRoot }); await drain(reader); const before = reader.stats();
    const error = Object.assign(new Error('temporarily unreadable'), { code: 'EACCES' });
    vi.mocked(fs.lstat).mockRejectedValueOnce(error);
    await expect(reader.graph(cid, budget())).rejects.toThrow('temporarily');
    expect((await drain(reader))?.main).toBe(actor); expect(reader.stats().bodyReadBytes).toBe(before.bodyReadBytes);
    await fs.rename(file, file + '.saved'); await fs.symlink(file + '.saved', file);
    await expect(reader.graph(cid, budget())).rejects.toThrow('Unsafe');
  });
});
