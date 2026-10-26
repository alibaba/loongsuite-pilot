import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildNativeExecutionEvents, nativeExecutionSpanId, parseNativeExecution, readNativeExecutions, type NativeExecution } from '../../../src/inputs/doubao-work/doubao-work-execution.js';
import { parseNativeGraph } from '../../../src/inputs/doubao-work/doubao-work-native.js';
import { doubaoRootAgentSpanId } from '../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_NATIVE_FILES } from '../../helpers/doubao-work-fixture.js';

const execution: NativeExecution = {
  executionKey: '00000000-0000-4000-8000-000000000001', conversationId: '12345678',
  queryMessageId: '00000000-0000-4000-8000-000000000002', agentId: 's_nativeLeaf',
  agentType: 'sub_agent', sandboxId: 'synthetic-sandbox', startedAtMs: DOUBAO_EPOCH + 1000, endedAtMs: DOUBAO_EPOCH + 2000,
};
const root = { turnId: 'synthetic-turn', conversationId: execution.conversationId, localMessageId: execution.queryMessageId,
  queryMs: DOUBAO_EPOCH, updatedMs: DOUBAO_EPOCH, terminal: { name: 'on_message_session_end', queryMs: DOUBAO_EPOCH,
    timeNano: (BigInt(DOUBAO_EPOCH + 300) * 1_000_000n).toString(), clientOutcome: 'ended' as const } };
const graph = parseNativeGraph(DOUBAO_NATIVE_FILES)!;
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() { const r = await mkdtemp(path.join(tmpdir(), 'doubao-execution-')); folders.push(r); return r; }
async function save(r: string, e = execution, account = '123') {
  const dir = path.join(r, account, e.conversationId, e.executionKey); await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${e.agentId}.json`);
  await writeFile(file, JSON.stringify({ execution: { ...e, userId: 'SYNTHETIC_PRIVATE_USER' }, files: [{ path: 'SYNTHETIC_PRIVATE_PATH' }], fileContents: 'SYNTHETIC_PRIVATE_CONTENT' }));
  return file;
}

describe('native persisted sandbox execution evidence', () => {
  it('projects only bounded execution metadata, never account, file paths or contents', () => {
    const row = parseNativeExecution({ execution: { ...execution, userId: 'SYNTHETIC_PRIVATE' }, fileContents: 'SYNTHETIC_PRIVATE' });
    expect(row).toEqual(execution); expect(JSON.stringify(row)).not.toContain('SYNTHETIC_PRIVATE');
  });
  it.each([
    ['executionKey', 'unproven'], ['queryMessageId', 'missing-request'], ['conversationId', '../history'],
    ['startedAtMs', undefined], ['endedAtMs', undefined], ['startedAtMs', execution.endedAtMs],
    ['endedAtMs', execution.startedAtMs - 1], ['startedAtMs', DOUBAO_EPOCH + .1], ['endedAtMs', Infinity],
    ['agentType', 'unknown'], ['agentId', '../escape'],
  ])('rejects missing or invalid native %s', (key, value) => {
    expect(parseNativeExecution({ execution: { ...execution, [key]: value } })).toBeUndefined();
  });
  it('uses genuine execution start/end and stable execution IDs independently of poll time', () => {
    const events = buildNativeExecutionEvents('scope', root, graph, execution, [execution], DOUBAO_EPOCH + 50000);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.time_unix_nano)).toEqual([execution.startedAtMs, execution.endedAtMs].map(t => (BigInt(t) * 1_000_000n).toString()));
    expect(events[0]['loongsuite.doubao_work.agent_span_id']).toBe(nativeExecutionSpanId('scope', execution.executionKey));
    expect(events[0].parent_span_id).toBe(doubaoRootAgentSpanId(events[0].trace_id!));
    expect(events[0]['gen_ai.agent.parent.id']).toBe('o_nativeOrg');
    expect(events[0]['loongsuite.doubao_work.parent_resolution']).toBe('root_request_ancestor');
    expect(events[0]['loongsuite.doubao_work.native_ancestor_ids']).toEqual(['o_nativeOrg', 'm_nativeMain']);
    expect(events.map(e => e['event.id'])).toEqual(buildNativeExecutionEvents('scope', root, graph, execution, [execution], DOUBAO_EPOCH + 70000).map(e => e['event.id']));
    expect(JSON.stringify(events)).not.toMatch(/gen_ai\.usage|request\.model|tool\.call|SYNTHETIC_PRIVATE/);
  });
  it('links an enclosing parent execution only with native ancestry, same query and sandbox', () => {
    const parent = { ...execution, executionKey: '00000000-0000-4000-8000-000000000003', agentId: 'o_nativeOrg', agentType: 'organizer' as const,
      startedAtMs: DOUBAO_EPOCH + 500, endedAtMs: DOUBAO_EPOCH + 2500 };
    const build = (parents: NativeExecution[]) => buildNativeExecutionEvents('scope', root, graph, execution, parents, Date.now())[0];
    expect(build([parent]).parent_span_id).toBe(nativeExecutionSpanId('scope', parent.executionKey));
    expect(build([parent])['loongsuite.doubao_work.native_parent_execution_id']).toBe(parent.executionKey);
    for (const p of [{ ...parent, sandboxId: 'another' }, { ...parent, queryMessageId: '00000000-0000-4000-8000-000000000004' },
      { ...parent, endedAtMs: execution.endedAtMs - 1 }, { ...parent, startedAtMs: execution.startedAtMs + 1 }]) {
      expect(build([p])['loongsuite.doubao_work.parent_resolution']).toBe('root_request_ancestor');
    }
    expect(build([parent, { ...parent, executionKey: '00000000-0000-4000-8000-000000000005' }])['loongsuite.doubao_work.parent_resolution']).toBe('root_request_ancestor');
    expect(buildNativeExecutionEvents('scope', { ...root, localMessageId: 'another' }, graph, execution, [], Date.now())).toEqual([]);
    expect(buildNativeExecutionEvents('scope', root, { ...graph, edges: {} }, execution, [], Date.now())).toEqual([]);
  });
  it('keeps reuse executions distinct and rejects cycle or pre-request timing evidence', () => {
    const first = buildNativeExecutionEvents('scope', root, graph, execution, [], Date.now());
    const second = buildNativeExecutionEvents('scope', root, graph, { ...execution, executionKey: '00000000-0000-4000-8000-000000000006' }, [], Date.now());
    expect(second[0]['loongsuite.doubao_work.agent_span_id']).not.toBe(first[0]['loongsuite.doubao_work.agent_span_id']);
    expect(buildNativeExecutionEvents('scope', root, graph, { ...execution, startedAtMs: root.queryMs - 1 }, [], Date.now())).toEqual([]);
    const cyclic = { ...graph, edges: { ...graph.edges, o_nativeOrg: { ...graph.edges.o_nativeOrg, parent: 's_nativeLeaf' } } };
    expect(buildNativeExecutionEvents('scope', root, cyclic, execution, [], Date.now())).toEqual([]);
  });
  it('reads only the current conversation and ignores file mtime and file contents', async () => {
    const r = await fixture(); await save(r); await save(r, { ...execution, conversationId: '87654321' });
    expect(await readNativeExecutions(r, execution.conversationId)).toEqual([execution]);
    expect(await readNativeExecutions(r, '../escape')).toEqual([]);
  });
  it('defers truncated files and rejects identity conflicts rather than committing partial scans', async () => {
    const r = await fixture(), file = await save(r); await writeFile(file, '{half');
    await expect(readNativeExecutions(r, execution.conversationId)).rejects.toThrow();
    await save(r); await save(r, { ...execution, endedAtMs: execution.endedAtMs + 1 }, '456');
    await expect(readNativeExecutions(r, execution.conversationId)).rejects.toThrow('Conflicting');
  });
  it('rejects path identity mismatches and bounded oversized native files', async () => {
    const r = await fixture(), file = await save(r); await writeFile(file, JSON.stringify({ execution: { ...execution, agentId: 'unrelated' } }));
    await expect(readNativeExecutions(r, execution.conversationId)).rejects.toThrow('identity mismatch');
    await writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
    await expect(readNativeExecutions(r, execution.conversationId)).rejects.toThrow('limit');
  });
  it('never follows a conversation or execution directory symlink', async () => {
    const r = await fixture(), elsewhere = await fixture(); await save(elsewhere);
    await mkdir(path.join(r, '123')); await symlink(path.join(elsewhere, '123', execution.conversationId), path.join(r, '123', execution.conversationId));
    await expect(readNativeExecutions(r, execution.conversationId)).rejects.toThrow('Unsafe');
  });
});
