import { appendFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { DoubaoWorkInput } from '../../../src/inputs/doubao-work/doubao-work-input.js';
import { parseDoubaoLogLine } from '../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine } from '../../helpers/doubao-work-fixture.js';

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
  const input = new ProbeInput({ stateStore, logDir: logs });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
  expect(await input.poll()).toEqual([]);
  clock.mockRestore();
  return { root, logs, file, input, statePath, stateStore };
}

describe('Doubao Work passive client-message input', () => {
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
});

describe('Doubao Work log protocol', () => {
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
