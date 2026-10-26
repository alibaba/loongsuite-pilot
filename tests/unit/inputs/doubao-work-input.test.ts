import { appendFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { DoubaoWorkInput } from '../../../src/inputs/doubao-work/doubao-work-input.js';
import { parseDoubaoLogLine } from '../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, DOUBAO_NATIVE_FILES, doubaoCommandLine, doubaoLine, doubaoToolLine } from '../../helpers/doubao-work-fixture.js';

class ProbeInput extends DoubaoWorkInput { poll() { return this.collect(); } }
const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

async function setup(initial = '') {
  const root = await mkdtemp(path.join(tmpdir(), 'doubao-input-'));
  temporary.push(root);
  const logs = path.join(root, 'logs');
  await mkdir(logs);
  const file = path.join(logs, DOUBAO_FILE);
  await writeFile(file, initial);
  const statePath = path.join(root, 'state.json');
  const stateStore = new StateStore(statePath);
  const sessionsRoot = path.join(root, 'native');
  const snapshotRoot = path.join(root, 'snapshots');
  const input = new ProbeInput({ stateStore, logDir: logs, sessionsRoot, snapshotRoot });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
  expect(await input.poll()).toEqual([]);
  clock.mockRestore();
  return { root, logs, file, input, statePath, stateStore, sessionsRoot, snapshotRoot };
}

describe('Doubao Work passive client-message input', () => {
  it('recovers late complete execution metadata after restart without replaying history or guessing missing boundaries', async () => {
    const { file, input, stateStore, statePath, logs, sessionsRoot, snapshotRoot } = await setup();
    const conv = '12345678', query = '00000000-0000-4000-8000-000000000002';
    const e = { executionKey: '00000000-0000-4000-8000-000000000001', conversationId: conv,
      queryMessageId: query, agentId: 's_nativeLeaf', agentType: 'sub_agent', sandboxId: 'synthetic-sandbox',
      startedAtMs: DOUBAO_EPOCH + 4000, endedAtMs: DOUBAO_EPOCH + 5000 };
    const dir = path.join(snapshotRoot, '123', conv, e.executionKey); await mkdir(dir, { recursive: true });
    const metadata = path.join(dir, `${e.agentId}.json`); await writeFile(metadata, '{half');
    for (const [id, source] of Object.entries(DOUBAO_NATIVE_FILES)) {
      const folder = path.join(sessionsRoot, conv, 'agents', id, 'system');
      await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'trajectory.jsonl'), source);
    }
    const meta = { conversation_id: conv, send_local_message_id: query };
    await appendFile(file, doubaoLine('on_message_session_start', meta, 10)
      + doubaoCommandLine('synthetic-turn', 'synthetic-sandbox')
      + doubaoCommandLine('s_nativeLeaf', 'synthetic-sandbox', 4000)
      + doubaoLine('on_message_session_end', meta));
    expect(await input.poll()).toHaveLength(2);
    await stateStore.save();
    const restored = new StateStore(statePath); await restored.load();
    const restarted = new ProbeInput({ stateStore: restored, logDir: logs, sessionsRoot, snapshotRoot });
    await writeFile(metadata, JSON.stringify({ execution: { ...e, endedAtMs: undefined } }));
    expect(await restarted.poll()).toEqual([]);
    await writeFile(metadata, JSON.stringify({ execution: e, fileContents: 'SYNTHETIC_PRIVATE' }));
    expect(await restarted.poll()).toEqual([]); // Native parent can still arrive.
    const grace = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
    const events = await restarted.poll(); expect(events).toHaveLength(2);
    grace.mockRestore();
    expect(events[0]['loongsuite.doubao_work.native_execution_id']).toBe(e.executionKey);
    expect(events[0].time_unix_nano).toBe((BigInt(e.startedAtMs) * 1_000_000n).toString());
    expect(events[1].time_unix_nano).toBe((BigInt(e.endedAtMs) * 1_000_000n).toString());
    expect(JSON.stringify(events)).not.toContain('SYNTHETIC_PRIVATE');
    expect(await restarted.poll()).toEqual([]);
    await restored.save(); const again = new StateStore(statePath); await again.load();
    expect(await new ProbeInput({ stateStore: again, logDir: logs, sessionsRoot, snapshotRoot }).poll()).toEqual([]);
    // A metadata rewrite must not produce a second execution with the same ID.
    await writeFile(metadata, JSON.stringify({ execution: { ...e, endedAtMs: e.endedAtMs + 1 } }));
    expect(await restarted.poll()).toEqual([]);
    // A fresh collector baselines the existing native conversation and snapshots.
    const fresh = new ProbeInput({ stateStore: new StateStore(path.join(logs, 'fresh.json')), logDir: logs, sessionsRoot, snapshotRoot });
    expect(await fresh.poll()).toEqual([]); expect(await fresh.poll()).toEqual([]);
  });

  it('links late nested native tools, retries incomplete graph reads and restores without duplicates', async () => {
    const { file, input, stateStore, statePath, logs, sessionsRoot } = await setup();
    await appendFile(file, doubaoLine('on_message_sending_start', {}, 10)
      + doubaoCommandLine('synthetic-turn', 'synthetic-sandbox') + doubaoLine('on_message_session_end'));
    expect(await input.poll()).toHaveLength(2);
    await appendFile(file, doubaoCommandLine('s_nativeLeaf', 'synthetic-sandbox', 4000)
      + doubaoCommandLine('o_nativeOrg', 'synthetic-sandbox', 4050)
      + doubaoToolLine({ agent_id: 's_nativeLeaf', tcid: 'late-child' }, 5000));
    expect(await input.poll()).toEqual([]);
    await stateStore.save();
    const restored = new StateStore(statePath); await restored.load();
    const restarted = new ProbeInput({ stateStore: restored, logDir: logs, sessionsRoot });
    const end = doubaoToolLine({ toolCallID: 'late-child', phase: 'execution_settled', status: 'success' }, 6000);
    await appendFile(file, end);
    expect(await restarted.poll()).toEqual([]); // Graph has not synchronized yet.
    for (const [id, source] of Object.entries(DOUBAO_NATIVE_FILES)) {
      const dir = path.join(sessionsRoot, 'synthetic-conversation', 'agents', id, 'system');
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'trajectory.jsonl'), source);
    }
    const fragments = await restarted.poll();
    expect(fragments).toHaveLength(4);
    expect(fragments[0]['gen_ai.agent.id']).toBe('s_nativeLeaf');
    expect(fragments[0]['loongsuite.doubao_work.native_creation_call_ids']).toEqual(['native-child-create', 'native-root-create']);
    expect(fragments[3].time_unix_nano).toBe(parseDoubaoLogLine(end.trimEnd(), DOUBAO_FILE)!.timeNano);
    await appendFile(file, doubaoToolLine({ agent_id: 's_nativeLeaf', tcid: 'late-child' }, 5000) + end);
    expect(await restarted.poll()).toEqual([]);
    // Same native agent, new sandbox and new root request: a separate fragment.
    await appendFile(file, doubaoLine('on_message_sending_start', { chat_session_id: 'reuse-root' }, 7000)
      + doubaoCommandLine('reuse-root', 'reuse-sandbox', 7050)
      + doubaoLine('on_message_session_end', { chat_session_id: 'reuse-root' }, 8000)
      + doubaoCommandLine('s_nativeLeaf', 'reuse-sandbox', 9000)
      + doubaoCommandLine('o_nativeOrg', 'reuse-sandbox', 9050)
      + doubaoToolLine({ agent_id: 's_nativeLeaf', sandbox_id: 'reuse-sandbox', tcid: 'reuse-tool' }, 9100)
      + doubaoToolLine({ sandbox_id: 'reuse-sandbox', toolCallID: 'reuse-tool', phase: 'execution_settled', status: 'success' }, 9200));
    const reused = await restarted.poll();
    expect(reused).toHaveLength(6);
    const child = reused.find(e => e['gen_ai.agent.scope'] === 'subagent')!;
    expect(child['gen_ai.agent.id']).toBe(fragments[0]['gen_ai.agent.id']);
    expect(child.trace_id).not.toBe(fragments[0].trace_id);
    expect(child['gen_ai.turn.id']).not.toBe(fragments[0]['gen_ai.turn.id']);
  });

  it('does not assign a child to a sandbox containing two root actors', async () => {
    const { file, input, sessionsRoot } = await setup();
    for (const [id, source] of Object.entries(DOUBAO_NATIVE_FILES)) {
      const dir = path.join(sessionsRoot, 'synthetic-conversation', 'agents', id, 'system');
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'trajectory.jsonl'), source);
    }
    await appendFile(file, doubaoLine('on_message_sending_start', {}, 10)
      + doubaoCommandLine('synthetic-turn', 'synthetic-sandbox')
      + doubaoCommandLine('unidentified-root', 'synthetic-sandbox', 60)
      + doubaoCommandLine('s_nativeLeaf', 'synthetic-sandbox', 70)
      + doubaoToolLine({ agent_id: 's_nativeLeaf' }, 100)
      + doubaoToolLine({ toolCallID: 'synthetic-call', phase: 'execution_settled', status: 'success' }, 200)
      + doubaoLine('on_message_session_end'));
    const events = await input.poll();
    expect(events).toHaveLength(2);
    expect(events.some(event => event['gen_ai.agent.scope'] === 'subagent')).toBe(false);
  });

  it('does not let one unavailable native conversation starve a different valid child', async () => {
    const { file, input, sessionsRoot } = await setup();
    for (const [id, source] of Object.entries(DOUBAO_NATIVE_FILES)) {
      const dir = path.join(sessionsRoot, 'valid-conversation', 'agents', id, 'system');
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'trajectory.jsonl'), source);
    }
    let log = '';
    for (const [index, conversation] of ['missing-conversation', 'valid-conversation'].entries()) {
      const actor = `root-${index}`, box = `box-${index}`;
      log += doubaoLine('on_message_sending_start', { chat_session_id: actor, conversation_id: conversation }, 10 + index)
        + doubaoCommandLine(actor, box, 20 + index)
        + doubaoCommandLine('o_nativeOrg', box, 30 + index)
        + doubaoCommandLine('s_nativeLeaf', box, 40 + index)
        + doubaoLine('on_message_session_end', { chat_session_id: actor, conversation_id: conversation })
        + doubaoToolLine({ agent_id: 's_nativeLeaf', sandbox_id: box, tcid: `tool-${index}` }, 4000)
        + doubaoToolLine({ sandbox_id: box, toolCallID: `tool-${index}`, phase: 'execution_settled', status: 'success' }, 5000);
    }
    await appendFile(file, log);
    expect(await input.poll()).toHaveLength(4);
    const child = await input.poll();
    expect(child).toHaveLength(4);
    expect(child.every(event => event['gen_ai.session.id'] === 'valid-conversation')).toBe(true);
  });
  it('pairs parallel local tools by native ID and retains selected skills only in that request', async () => {
    const { file, input } = await setup();
    await appendFile(file, doubaoLine('on_message_sending_start', { mention_skill_list: '["synthetic-analysis"]' }, 10)
      + doubaoToolLine({ tcid: 'call-a', arguments: 'PRIVATE_ARGUMENT' }, 100)
      + doubaoToolLine({ tcid: 'call-b', name: 'Write' }, 110)
      + doubaoToolLine({ toolCallID: 'call-b', name: 'Write', status: 'success', phase: 'execution_settled', result: 'PRIVATE_RESULT' }, 120)
      + doubaoToolLine({ toolCallID: 'call-a', status: 'failed', phase: 'execution_settled', error: 'PRIVATE_ERROR' }, 150)
      + doubaoLine('on_message_session_end'));
    const entries = await input.poll();
    expect(entries).toHaveLength(6);
    expect(entries.map(e => e['event.name'])).toEqual(['other', 'tool.call', 'tool.call', 'tool.result', 'tool.result', 'other']);
    expect(entries.every(e => e['loongsuite.doubao_work.selected_skills']?.[0] === 'synthetic-analysis')).toBe(true);
    const results = entries.filter(e => e['event.name'] === 'tool.result');
    expect(results.map(e => [e['gen_ai.tool.call.id'], e['tool.result.status'], e['gen_ai.tool.call.duration']])).toEqual([
      ['call-b', 'success', 10], ['call-a', 'error', 50],
    ]);
    expect(results[1]['error.type']).toBe('doubao.local_tool_failed');
    expect(JSON.stringify(entries)).not.toMatch(/PRIVATE_|gen_ai\.tool\.call\.(arguments|result)/);
    await appendFile(file, doubaoLine('on_message_sending_start', { chat_session_id: 'next-turn' }, 4000)
      + doubaoLine('on_message_session_end', { chat_session_id: 'next-turn' }, 5000));
    const next = await input.poll();
    expect(next).toHaveLength(2);
    expect(next.every(e => e['loongsuite.doubao_work.selected_skills'] === undefined)).toBe(true);
  });

  it('restores an in-flight tool and a half result line without duplicating its call', async () => {
    const { file, input, stateStore, statePath, logs } = await setup();
    await appendFile(file, doubaoLine('on_message_sending_start', {}, 10) + doubaoToolLine({}, 100));
    expect(await input.poll()).toEqual([]);
    const result = doubaoToolLine({ toolCallID: 'synthetic-call', status: 'success', phase: 'execution_settled' }, 101, 456);
    await appendFile(file, result.slice(0, 80));
    expect(await input.poll()).toEqual([]);
    await stateStore.save();
    const restored = new StateStore(statePath);
    await restored.load();
    const restarted = new ProbeInput({ stateStore: restored, logDir: logs });
    await appendFile(file, result.slice(80) + doubaoLine('on_message_session_end'));
    const entries = await restarted.poll();
    expect(entries).toHaveLength(4);
    expect(entries[2]['gen_ai.tool.call.duration']).toBe(1.333);
    await appendFile(file, doubaoToolLine({}, 100) + result + doubaoLine('on_message_session_end'));
    expect(await restarted.poll()).toEqual([]);
  });

  it('does not guess tools from orphan results, conflicting starts or background completion', async () => {
    const { file, input } = await setup();
    await appendFile(file, doubaoLine('on_message_sending_start', {}, 10)
      + doubaoToolLine({}, 100)
      + doubaoToolLine({ agent_id: 'different-turn' }, 101)
      + doubaoToolLine({ toolCallID: 'synthetic-call', status: 'success', phase: 'execution_settled' }, 200)
      + doubaoToolLine({ toolCallID: 'orphan', status: 'success', phase: 'execution_settled' }, 200)
      + doubaoToolLine({ tcid: 'background' }, 200)
      + doubaoLine('on_message_session_end')
      + doubaoToolLine({ toolCallID: 'background', status: 'success', phase: 'execution_settled' }, 4000));
    const entries = await input.poll();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e['event.name'])).toEqual(['other', 'other']);
  });

  it('handles a result received in a previous scan before its matching dispatch record', async () => {
    const { file, input } = await setup();
    await appendFile(file, doubaoToolLine({ toolCallID: 'synthetic-call', status: 'success', phase: 'execution_settled' }, 200));
    expect(await input.poll()).toEqual([]);
    await appendFile(file, doubaoLine('on_message_sending_start', {}, 10) + doubaoToolLine({}, 100) + doubaoLine('on_message_session_end'));
    expect(await input.poll()).toHaveLength(4);
  });
  it('baselines history, then associates temporary IDs and returns a content-free pair', async () => {
    const start = doubaoLine('on_message_sending_start', { conversation_id: '' }, 10);
    const end = doubaoLine('on_message_session_end');
    const { file, input } = await setup(start + end);
    expect(await input.poll()).toEqual([]);
    await appendFile(file, start);
    expect(await input.poll()).toEqual([]);
    await appendFile(file, doubaoLine('general_agent_message_id_mapping', {
      conversation_id: undefined, conversationId: 'synthetic-conversation', localMessageId: 'synthetic-local-message',
      send_local_message_id: undefined,
    }, 500));
    await appendFile(file, doubaoLine('on_message_session_end', {
      conversation_id: undefined, model_name: '自动', session_success: '1',
      prompt: 'SYNTHETIC_PRIVATE_PROMPT', error_message: 'SYNTHETIC_PRIVATE_ERROR',
    }));
    const entries = await input.poll();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e['event.name'])).toEqual(['other', 'other']);
    expect(entries[0]['gen_ai.turn.start']).toBe(true);
    expect(entries[1]['gen_ai.turn.end']).toBe(true);
    expect(entries[0].time_unix_nano).toBe((BigInt(DOUBAO_EPOCH) * 1_000_000n).toString());
    expect(BigInt(entries[1].time_unix_nano) - BigInt(entries[0].time_unix_nano)).toBe(3_000_123_000n);
    expect(entries.every(e => e['gen_ai.session.id'] === 'synthetic-conversation')).toBe(true);
    expect(entries.every(e => e['loongsuite.doubao_work.business_outcome'] === 'unknown')).toBe(true);
    expect(entries.every(e => e['gen_ai.request.model'] === undefined && e['gen_ai.usage.input_tokens'] === undefined)).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/SYNTHETIC_PRIVATE|自动/);
    await appendFile(file, start + end);
    expect(await input.poll()).toEqual([]);
  });

  it('waits for a late server conversation mapping before completing a request', async () => {
    const { file, input } = await setup();
    await appendFile(file, doubaoLine('on_message_sending_start', { conversation_id: undefined }, 10)
      + doubaoLine('on_message_session_end', { conversation_id: undefined }));
    expect(await input.poll()).toEqual([]);
    await appendFile(file, doubaoLine('general_agent_message_id_mapping', {
      conversation_id: undefined, conversationId: 'synthetic-conversation',
      send_local_message_id: undefined, localMessageId: 'synthetic-local-message',
    }, 3100));
    expect(await input.poll()).toHaveLength(2);
  });

  it('persists a pending request and an incomplete line across a collector restart', async () => {
    const { file, input, stateStore, statePath, logs } = await setup();
    await appendFile(file, doubaoLine('on_message_session_start', {}, 10));
    await input.poll();
    const end = doubaoLine('on_message_session_end');
    const half = Math.floor(end.length / 2);
    await appendFile(file, end.slice(0, half));
    expect(await input.poll()).toEqual([]);
    await stateStore.save();
    const restored = new StateStore(statePath);
    await restored.load();
    const restarted = new ProbeInput({ stateStore: restored, logDir: logs });
    await appendFile(file, end.slice(half));
    const entries = await restarted.poll();
    expect(entries).toHaveLength(2);
    await restored.save();
    await appendFile(file, doubaoLine('on_message_session_end'));
    expect(await restarted.poll()).toEqual([]);
    expect((await readFile(statePath, 'utf8'))).not.toContain('SYNTHETIC_PRIVATE');
  });

  it('retains offsets and pending requests while the log directory is unavailable', async () => {
    const { file, logs, input, stateStore } = await setup();
    await appendFile(file, doubaoLine('on_message_session_start', {}, 10));
    await input.poll();
    const checkpoint = JSON.stringify(stateStore.get('doubao-work'));
    await rename(logs, `${logs}-away`);
    expect(await input.poll()).toEqual([]);
    expect(JSON.stringify(stateStore.get('doubao-work'))).toBe(checkpoint);
    await rename(`${logs}-away`, logs);
    await appendFile(file, doubaoLine('on_message_session_end'));
    expect(await input.poll()).toHaveLength(2);
  });

  it('handles file replacement, truncate-and-regrow and duplicate rotations without re-emission', async () => {
    const { file, input, logs } = await setup('x'.repeat(5000) + '\n');
    const turn = doubaoLine('on_message_session_start', {}, 10) + doubaoLine('on_message_session_end');
    // Same inode, new contents larger than the baseline cursor: anchor detects rewrite.
    await writeFile(file, turn + '\n'.repeat(6000));
    const first = await input.poll();
    expect(first).toHaveLength(2);
    await rename(file, path.join(logs, DOUBAO_FILE.replace('.0.log', '.1.log')));
    await writeFile(file, turn);
    expect(await input.poll()).toEqual([]);
    await writeFile(file, doubaoLine('on_message_session_start', { chat_session_id: 'synthetic-turn-2' }, 10)
      + doubaoLine('on_message_session_end', { chat_session_id: 'synthetic-turn-2' }));
    const second = await input.poll();
    expect(second).toHaveLength(2);
    expect(second[0]['event.id']).not.toBe(first[0]['event.id']);
  });

  it('requires an observed start and supports out-of-order arrival and concurrent turns', async () => {
    const { file, input } = await setup();
    await appendFile(file, doubaoLine('on_message_session_end'));
    expect(await input.poll()).toEqual([]);
    await appendFile(file, doubaoLine('on_message_session_start', {}, 10));
    expect(await input.poll()).toHaveLength(2);
    const second = { chat_session_id: 'synthetic-turn-2', conversation_id: 'synthetic-conversation-2' };
    const third = { chat_session_id: 'synthetic-turn-3', conversation_id: 'synthetic-conversation-3' };
    await appendFile(file, doubaoLine('on_message_session_start', second, 20)
      + doubaoLine('on_message_session_start', third, 30)
      + doubaoLine('on_message_session_end', third, 1000)
      + doubaoLine('on_message_session_end', second, 2000));
    const entries = await input.poll();
    expect(entries).toHaveLength(4);
    expect(new Set(entries.map(e => e.trace_id)).size).toBe(2);
    expect(entries.filter(e => e['gen_ai.turn.id'] === 'synthetic-turn-2')
      .every(e => e['gen_ai.session.id'] === 'synthetic-conversation-2')).toBe(true);
  });

  it('skips malformed and oversized records with bounded reads and resumes after their newline', async () => {
    const { file, input, stateStore } = await setup();
    await appendFile(file, 'x'.repeat(1024 * 1024 + 20) + '\n{bad json}\n'
      + doubaoLine('on_message_session_start', {}, 10) + doubaoLine('on_message_session_end'));
    expect(await input.poll()).toEqual([]);
    expect(await input.poll()).toHaveLength(2);
    expect((stateStore.get('doubao-work').extra?.doubaoWork as any).files[DOUBAO_FILE].offset)
      .toBe((await readFile(file)).length);
  });

  it('detects only frontend log files and never creates a missing source directory', async () => {
    const { logs, file, input } = await setup();
    expect(await DoubaoWorkInput.checkAvailability(logs)).toBe(true);
    await rm(file);
    await writeFile(path.join(logs, 'saman_2026.1025.0.log'), 'native log');
    expect(await DoubaoWorkInput.checkAvailability(logs)).toBe(false);
    await rm(logs, { recursive: true });
    await input.poll();
    expect(await DoubaoWorkInput.checkAvailability(logs)).toBe(false);
  });

  it('bounds saved file cursors and keeps the newest numeric rotation suffixes', async () => {
    const { logs, input, stateStore } = await setup();
    const name = (index: number) => DOUBAO_FILE.replace('.0.log', `.${index}.log`);
    for (let index = 1; index < 130; index++) await writeFile(path.join(logs, name(index)), '');
    expect(await input.poll()).toEqual([]);
    let files = (stateStore.get('doubao-work').extra?.doubaoWork as any).files;
    expect(Object.keys(files)).toHaveLength(128);
    expect(files[name(1)]).toBeUndefined();
    expect(files[name(129)]).toBeDefined();
    await writeFile(path.join(logs, name(130)), '');
    expect(await input.poll()).toEqual([]);
    files = (stateStore.get('doubao-work').extra?.doubaoWork as any).files;
    expect(Object.keys(files)).toHaveLength(128);
    expect(files[name(2)]).toBeUndefined();
    expect(files[name(130)]).toBeDefined();
  });
});

describe('Doubao Work log protocol', () => {
  it('accepts only the exact local tool lifecycle producer and allowlisted metadata', () => {
    const line = doubaoToolLine({ arguments: { command: 'PRIVATE_COMMAND' }, result: 'PRIVATE_RESULT' }, 100).trimEnd();
    const parsed = parseDoubaoLogLine(line, DOUBAO_FILE)!;
    expect(parsed.tool).toMatchObject({ id: 'synthetic-call', name: 'Read', sandboxId: 'synthetic-sandbox', phase: 'received' });
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
    expect(parseDoubaoLogLine(line.replace('local-file-local-tools-sse-wiring.ts', 'other.ts'), DOUBAO_FILE)).toBeUndefined();
    expect(parseDoubaoLogLine(line.replace('"received"', '"pending"'), DOUBAO_FILE)).toBeUndefined();
    expect(parseDoubaoLogLine(line.replace('synthetic-call', '../unsafe'), DOUBAO_FILE)).toBeUndefined();
    expect(parseDoubaoLogLine(doubaoLine('on_message_sending_start', {
      mention_skill_list: '["safe","../PRIVATE"]', mention_partner_list: '{}',
    }), DOUBAO_FILE)!.selectedSkills).toBeUndefined();
  });
  it.each([
    [{ session_success: '1', receive_success: '1' }, 'received'],
    [{ session_success: undefined, receive_success: undefined }, 'ended'],
    [{ session_success: '0', session_err: 'SYNTHETIC_PRIVATE_ERROR' }, 'error'],
    [{ cancel_source: 'stop_button' }, 'cancelled'],
  ])('keeps the client outcome separate from business success: %j', (meta, expected) => {
    const parsed = parseDoubaoLogLine(doubaoLine('on_message_session_end', meta), DOUBAO_FILE)!;
    expect(parsed.clientOutcome).toBe(expected);
    expect(JSON.stringify(parsed)).not.toContain('SYNTHETIC_PRIVATE');
  });

  it('rejects monotonic clocks, malformed identifiers, unsupported schemas and unrelated events', () => {
    expect(parseDoubaoLogLine(doubaoLine('on_message_session_start', { query_send_timestamp: 541251.3 }), DOUBAO_FILE)).toBeUndefined();
    expect(parseDoubaoLogLine(doubaoLine('on_message_session_start', { chat_session_id: '../../private' }), DOUBAO_FILE)).toBeUndefined();
    expect(parseDoubaoLogLine(doubaoLine('on_message_session_end').replace('"version":1', '"version":2'), DOUBAO_FILE)).toBeUndefined();
    expect(parseDoubaoLogLine(doubaoLine('access_token_subscribe'), DOUBAO_FILE)).toBeUndefined();
  });

  it('resolves the year across a Chromium log date rollover', () => {
    const line = doubaoLine('on_message_session_end').replace(/\d{4}\/\d{6}\.\d{6}/, '0101/010203.004005');
    const parsed = parseDoubaoLogLine(line, 'saman_frontend_2026.1231.0.log')!;
    const sourceMs = Number(BigInt(parsed.timeNano) / 1_000_000n);
    const expected = new Date(2027, 0, 1, 1, 2, 3, 4).getTime();
    expect(sourceMs).toBe(expected);
    expect(BigInt(parsed.timeNano) % 1_000_000n).toBe(5000n);
  });
});
