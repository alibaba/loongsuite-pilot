import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { KiroDesktopSessionInput } from '../../../src/inputs/kiro-desktop-session/kiro-desktop-session-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { InputManager } from '../../../src/core/input-manager.js';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

// Fixture derived from real ~/.kiro/sessions/01ebf2a66fa98655/sess_57fd9524-c06e-4026-8424-9f5ea0173c08/messages.jsonl
// captured during AGE-933 CDP smoke (comment 7b671636 attachment cp1-report.md).
// Two turns, 13 records, 7 distinct payload types: user / turn_start / turn_end /
// session_metadata / usage_summary / session_event / assistant.
const REAL_FIXTURE_LINES: string[] = [
  JSON.stringify({
    id: 'b76c1b6a-ba6d-4e6f-bcfd-ebc214e3da90',
    timestamp: '2026-07-20T02:48:12.722Z',
    payload: { type: 'user', content: 'Reply exactly KIRO_LINUX_CDP_OK. Do not use tools.', images: [], documents: [], _meta: { traceparent: '00-6a5d8c6c2ac880bfed3fa96757436921-e2ff3eb14d8c37f0-01', kiro: { __callerClientId: 'client_1' } } },
  }),
  JSON.stringify({
    id: '14c105db-f336-420a-82b0-1f4273aa41b5-turn-start',
    timestamp: '2026-07-20T02:48:12.730Z',
    payload: { type: 'turn_start', executionId: '14c105db-f336-420a-82b0-1f4273aa41b5' },
  }),
  JSON.stringify({
    id: 'b295e7a6-da8d-4fc6-917b-80df01fa353c',
    timestamp: '2026-07-20T02:48:14.729Z',
    payload: { type: 'session_metadata', key: 'displayError', value: { message: 'The selected model is not available.', errorType: 'st' }, executionId: '14c105db-f336-420a-82b0-1f4273aa41b5' },
  }),
  JSON.stringify({
    id: '14c105db-f336-420a-82b0-1f4273aa41b5-usage',
    timestamp: '2026-07-20T02:48:14.733Z',
    payload: { type: 'usage_summary', promptTurnSummaries: [], elapsedTime: 2003, status: 'failed', executionId: '14c105db-f336-420a-82b0-1f4273aa41b5' },
  }),
  JSON.stringify({
    id: '14c105db-f336-420a-82b0-1f4273aa41b5-complete',
    timestamp: '2026-07-20T02:48:14.733Z',
    payload: { type: 'session_event', category: 'session_pause', context: { executionId: '14c105db-f336-420a-82b0-1f4273aa41b5', status: 'failed' } },
  }),
  JSON.stringify({
    id: '14c105db-f336-420a-82b0-1f4273aa41b5-turn-end',
    timestamp: '2026-07-20T02:48:14.733Z',
    payload: { type: 'turn_end', stopReason: 'error', executionId: '14c105db-f336-420a-82b0-1f4273aa41b5' },
  }),
  JSON.stringify({
    id: '53d92ca3-ec8b-464d-9f97-e8005fb948e4',
    timestamp: '2026-07-20T02:54:37.397Z',
    payload: { type: 'user', content: 'Reply exactly KIRO_LINUX_CDP_OK. Do not use tools.', images: [], documents: [], _meta: { traceparent: '00-6a5d8edef1b3b0cc2a0ad5ede0073e7-40e780b897c1e012-01', kiro: { __callerClientId: 'client_1' } } },
  }),
  JSON.stringify({
    id: '8860b840-ea17-48a8-8701-a29eec903de5-turn-start',
    timestamp: '2026-07-20T02:54:37.400Z',
    payload: { type: 'turn_start', executionId: '8860b840-ea17-48a8-8701-a29eec903de5' },
  }),
  JSON.stringify({
    id: '21a6ce6e-dc5d-45bc-9c14-b88ebb66a877-say',
    timestamp: '2026-07-20T02:54:42.489Z',
    payload: { type: 'assistant', content: 'KIRO_LINUX_CDP_OK', operationType: 'Say', executionId: '8860b840-ea17-48a8-8701-a29eec903de5', _meta: { kiro: { agentMode: 'vibe' } } },
  }),
  JSON.stringify({
    id: 'bf53a429-c795-4652-9bdd-6b01fac91b5d',
    timestamp: '2026-07-20T02:54:42.489Z',
    payload: { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 8.149609565734863 }, executionId: '8860b840-ea17-48a8-8701-a29eec903de5' },
  }),
  JSON.stringify({
    id: '8860b840-ea17-48a8-8701-a29eec903de5-usage',
    timestamp: '2026-07-20T02:54:42.514Z',
    payload: { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: 0.028211164179104475 }], elapsedTime: 5114, status: 'success', executionId: '8860b840-ea17-48a8-8701-a29eec903de5' },
  }),
  JSON.stringify({
    id: '8860b840-ea17-48a8-8701-a29eec903de5-complete',
    timestamp: '2026-07-20T02:54:42.514Z',
    payload: { type: 'session_event', category: 'session_pause', context: { executionId: '8860b840-ea17-48a8-8701-a29eec903de5', status: 'success' } },
  }),
  JSON.stringify({
    id: '8860b840-ea17-48a8-8701-a29eec903de5-turn-end',
    timestamp: '2026-07-20T02:54:42.514Z',
    payload: { type: 'turn_end', stopReason: 'end_turn', executionId: '8860b840-ea17-48a8-8701-a29eec903de5' },
  }),
];

// Multi-turn ReAct fixture: 2 turns, 3 tool cycles (list_directory, execute_bash,
// read_file), plus a final assistant Say. Derived from real Kiro session records
// observed in /root/.kiro/sessions/01ebf2a66fa98655/sess_57fd9524-.../messages.jsonl
// (turns 61e6c102-5a1c-4a18-ba29-04328d433989 and 6a628511-a65b-442b-a98e-f3599b871dfc).
// Timestamps spaced out so tool_call < tool_result (no zero-duration TOOL spans).
const REACT_FIXTURE_LINES: string[] = [
  JSON.stringify({ id: 'react-user-1', timestamp: '2026-07-20T03:10:00.000Z', payload: { type: 'user', content: 'List files in /tmp and then run pwd.' } }),
  JSON.stringify({ id: '61e6c102-turn-start', timestamp: '2026-07-20T03:10:00.500Z', payload: { type: 'turn_start', executionId: '61e6c102-5a1c-4a18-ba29-04328d433989' } }),
  JSON.stringify({ id: '61e6c102-metadata', timestamp: '2026-07-20T03:10:00.700Z', payload: { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 1.2 }, executionId: '61e6c102-5a1c-4a18-ba29-04328d433989' } }),
  JSON.stringify({ id: 'tooluse_listdir_1-call', timestamp: '2026-07-20T03:10:01.000Z', payload: { type: 'tool_call', toolCallId: 'tooluse_listdir_1', toolName: 'list_directory', args: { path: '/tmp' }, status: 'approved', kind: 'execute', executionId: '61e6c102-5a1c-4a18-ba29-04328d433989', actionType: 'list_directory', title: 'List Directory' } }),
  JSON.stringify({ id: 'tooluse_listdir_1-result', timestamp: '2026-07-20T03:10:01.200Z', payload: { type: 'tool_result', toolCallId: 'tooluse_listdir_1', content: '{"entries":["file_a.txt","file_b.txt"]}', success: true, executionId: '61e6c102-5a1c-4a18-ba29-04328d433989' } }),
  JSON.stringify({ id: 'tooluse_bash_1-call', timestamp: '2026-07-20T03:10:02.000Z', payload: { type: 'tool_call', toolCallId: 'tooluse_bash_1', toolName: 'execute_bash', args: { command: 'pwd' }, status: 'approved', kind: 'execute', executionId: '61e6c102-5a1c-4a18-ba29-04328d433989', actionType: 'run_command', title: 'Run Command' } }),
  JSON.stringify({ id: 'tooluse_bash_1-result', timestamp: '2026-07-20T03:10:02.300Z', payload: { type: 'tool_result', toolCallId: 'tooluse_bash_1', content: '/tmp', success: true, executionId: '61e6c102-5a1c-4a18-ba29-04328d433989' } }),
  JSON.stringify({ id: '61e6c102-usage', timestamp: '2026-07-20T03:10:02.500Z', payload: { type: 'usage_summary', promptTurnSummaries: [], elapsedTime: 2000, status: 'success', executionId: '61e6c102-5a1c-4a18-ba29-04328d433989' } }),
  JSON.stringify({ id: '61e6c102-turn-end', timestamp: '2026-07-20T03:10:02.500Z', payload: { type: 'turn_end', stopReason: 'end_turn', executionId: '61e6c102-5a1c-4a18-ba29-04328d433989' } }),
  JSON.stringify({ id: 'react-user-2', timestamp: '2026-07-20T03:11:00.000Z', payload: { type: 'user', content: 'Now read /tmp/file_a.txt.' } }),
  JSON.stringify({ id: '6a628511-turn-start', timestamp: '2026-07-20T03:11:00.500Z', payload: { type: 'turn_start', executionId: '6a628511-a65b-442b-a98e-f3599b871dfc' } }),
  JSON.stringify({ id: 'tooluse_read_1-call', timestamp: '2026-07-20T03:11:01.000Z', payload: { type: 'tool_call', toolCallId: 'tooluse_read_1', toolName: 'read_file', args: { path: '/tmp/file_a.txt' }, status: 'approved', kind: 'execute', executionId: '6a628511-a65b-442b-a98e-f3599b871dfc', actionType: 'read_file', title: 'Read File' } }),
  JSON.stringify({ id: 'tooluse_read_1-result', timestamp: '2026-07-20T03:11:01.300Z', payload: { type: 'tool_result', toolCallId: 'tooluse_read_1', content: 'hello world', success: true, executionId: '6a628511-a65b-442b-a98e-f3599b871dfc' } }),
  JSON.stringify({ id: '6a628511-say', timestamp: '2026-07-20T03:11:02.000Z', payload: { type: 'assistant', content: 'The file contains: hello world', operationType: 'Say', executionId: '6a628511-a65b-442b-a98e-f3599b871dfc' } }),
  JSON.stringify({ id: '6a628511-usage', timestamp: '2026-07-20T03:11:02.100Z', payload: { type: 'usage_summary', promptTurnSummaries: [], elapsedTime: 1100, status: 'success', executionId: '6a628511-a65b-442b-a98e-f3599b871dfc' } }),
  JSON.stringify({ id: '6a628511-turn-end', timestamp: '2026-07-20T03:11:02.100Z', payload: { type: 'turn_end', stopReason: 'end_turn', executionId: '6a628511-a65b-442b-a98e-f3599b871dfc' } }),
];

class TestKiroDesktopSessionInput extends KiroDesktopSessionInput {
  async discoverOnce(): Promise<string[]> {
    return this.discoverSessionFiles();
  }

  async baselineOnce(): Promise<void> {
    return this.onStart();
  }

  async collectOnce(): Promise<AgentActivityEntry[]> {
    return this.collect();
  }

  async mapOnce(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    return this.processSessionLine(record, filePath);
  }
}

describe('KiroDesktopSessionInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-desktop-session-test-'));
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct identity and collection method', () => {
    const input = makeInput();
    expect(input.id).toBe('kiro-desktop-session');
    expect(input.agentType).toBe(ClientType.Kiro);
    expect(input.collectionMethod).toBe(CollectionMethod.SessionFilePolling);
  });

  it('discovers messages.jsonl under <hash>/sess_*/ directories', async () => {
    const fileA = await writeSessionFile('hash-a', 'sess_aaa', []);
    const fileB = await writeSessionFile('hash-b', 'sess_bbb', []);

    const files = await makeInput().discoverOnce();

    expect(files).toEqual([fileA, fileB].sort());
  });

  it('skips underscore-prefixed top-level dirs (e.g. _global)', async () => {
    const real = await writeSessionFile('01ebf2a66fa98655', 'sess_57fd9524', []);
    const globalDir = path.join(tmpDir, '_global', 'sess_xxx');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(path.join(globalDir, 'messages.jsonl'), '{}\n');

    const files = await makeInput().discoverOnce();

    expect(files).toEqual([real]);
  });

  it('only picks messages.jsonl, not other files in sess_ dir', async () => {
    const real = await writeSessionFile('hash-a', 'sess_aaa', []);
    const sibling = path.join(tmpDir, 'hash-a', 'sess_aaa', 'session.json');
    await fs.writeFile(sibling, '{}\n');

    const files = await makeInput().discoverOnce();

    expect(files).toEqual([real]);
  });

  it('cold-start onStart() seeds offset = file size to avoid backfilling history', async () => {
    const file = await writeSessionFile('hash-a', 'sess_aaa', REAL_FIXTURE_LINES);
    const input = makeInput();

    await input.baselineOnce();

    const stateKey = `kiro-desktop-session:${file}`;
    expect(stateStore.getOffset(stateKey)).toBe((await fs.stat(file)).size);
  });

  it.each([
    { history: false, padding: 0 },
    { history: true, padding: 0 },
    { history: true, padding: 64 * 1024 },
  ])('preserves a startup partial UTF-8 row with history=$history and padding=$padding', async ({ history, padding }) => {
    const file = await writeSessionFile('hash-cold-tail', 'sess_cold_tail', history ? REAL_FIXTURE_LINES : []);
    const key = `kiro-desktop-session:${file}`;
    const lastComplete = (await fs.stat(file)).size;
    const id = 'cold-tail-response';
    const content = `${'x'.repeat(padding)}结果 🧪`;
    const bytes = Buffer.from(JSON.stringify({
      id, timestamp: '2026-07-20T03:15:00.500Z',
      payload: { type: 'assistant', executionId: 'cold-tail-turn', operationType: 'Say', content },
    }) + '\n');
    const cut = bytes.indexOf(Buffer.from('🧪')) + 2;
    await fs.appendFile(file, bytes.subarray(0, cut));

    const input = makeInput();
    await input.baselineOnce();
    expect(stateStore.getOffset(key)).toBe(lastComplete);
    expect(await input.collectOnce()).toEqual([]);
    await fs.appendFile(file, bytes.subarray(cut));

    const entries = await input.collectOnce();
    expect(entries.map(entry => entry['event.name'])).toEqual(['llm.request', 'llm.response']);
    expect(entries[1]['gen_ai.output.messages']).toEqual([{ role: 'assistant', parts: [{ type: 'text', content }] }]);
    expect(entries[1]['event.id']).toBe(createHash('sha256').update(`${file}::${id}::llm-resp`).digest('hex').slice(0, 32));
    expect(stateStore.getOffset(key)).toBe(lastComplete + bytes.length);
    expect(await input.collectOnce()).toEqual([]);
  });

  it.each([false, true])('resumes a runtime file completed while stopped, first observed empty=%s', async (empty) => {
    const statePath = path.join(tmpDir, 'new-source-state.json');
    const state = new StateStore(statePath);
    await state.load();
    const first = makeInput(state);
    await first.baselineOnce();
    const file = await writeSessionFile('hash-new-partial', 'sess_new_partial', []);
    const key = `kiro-desktop-session:${file}`;
    const inode = (await fs.stat(file)).ino;
    const id = 'first-partial';
    const content = 'New source 🧪';
    const line = Buffer.from(JSON.stringify({
      id, timestamp: '2026-07-20T03:15:00.500Z',
      payload: { type: 'assistant', executionId: 'new-source-turn', operationType: 'Say', content },
    }) + '\n');
    const cut = line.indexOf(Buffer.from('🧪')) + 2;
    if (!empty) await fs.appendFile(file, line.subarray(0, cut));
    expect(await first.collectOnce()).toEqual([]);
    await state.save();

    // The sole poll observed an empty or incomplete file. Kiro finishes it
    // while Pilot is down, before the next instance can inspect the end.
    await fs.appendFile(file, empty ? line : line.subarray(cut));
    const restored = new StateStore(statePath);
    await restored.load();
    expect(restored.get(key)).toMatchObject({ lastOffset: 0, extra: { inode } });
    const restarted = makeInput(restored);
    await restarted.baselineOnce();
    const entries = await restarted.collectOnce();
    expect(entries.map(entry => entry['event.name'])).toEqual(['llm.request', 'llm.response']);
    expect(entries[1]['gen_ai.output.messages']).toEqual([{ role: 'assistant', parts: [{ type: 'text', content }] }]);
    expect(entries[1]['event.id']).toBe(createHash('sha256').update(`${file}::${id}::llm-resp`).digest('hex').slice(0, 32));
    expect(restored.getOffset(key)).toBe(line.length);
    expect(await restarted.collectOnce()).toEqual([]);
  });

  it('keeps the archived prompts with their own turns across unscoped session_pause rows', async () => {
    const input = makeInput();
    await input.baselineOnce();
    const file = await writeSessionFile('hash-archived-gap', 'sess_archived_gap', REAL_FIXTURE_LINES.slice(0, 2));
    expect(await input.collectOnce()).toEqual([]);
    expect(stateStore.getOffset(`kiro-desktop-session:${file}`)).toBe(0);
    await fs.appendFile(file, REAL_FIXTURE_LINES.slice(2).join('\n') + '\n');
    const output = await input.collectOnce();

    const expected = [[0, 1], [6, 7]].map(([user, start]) => ({
      id: JSON.parse(REAL_FIXTURE_LINES[start]).payload.executionId,
      messages: [{ role: 'user', parts: [{ type: 'text', content: JSON.parse(REAL_FIXTURE_LINES[user]).payload.content }] }],
    }));
    for (const [eventName, attr] of [
      ['other', 'gen_ai.input.messages'], ['llm.request', 'gen_ai.input.messages_delta'],
    ] as const) {
      expect(output.filter(entry => entry['event.name'] === eventName && entry[attr] !== undefined)
        .map(entry => ({ id: entry['gen_ai.turn.id'], messages: entry[attr] }))).toEqual(expected);
    }
    expect(output.some(entry => entry['agent.kiro_event_type'] === 'session_event')).toBe(false);
    expect(stateStore.getOffset(`kiro-desktop-session:${file}`)).toBe((await fs.stat(file)).size);
    expect(await input.collectOnce()).toEqual([]);
  });

  it('collects completed turns appended to a tracked file while Pilot is stopped', async () => {
    const file = await writeSessionFile('hash-resume', 'sess_resume', REAL_FIXTURE_LINES);
    await makeInput().baselineOnce();
    const key = `kiro-desktop-session:${file}`;
    const initialOffset = stateStore.getOffset(key);
    await fs.appendFile(file, REACT_FIXTURE_LINES.join('\n') + '\n');

    const restarted = makeInput();
    await restarted.baselineOnce();
    expect(stateStore.getOffset(key)).toBe(initialOffset);
    const entries = await restarted.collectOnce();
    expect(entries.filter(entry => entry['event.name'] === 'tool.result')).toHaveLength(3);
    expect(stateStore.getOffset(key)).toBe((await fs.stat(file)).size);
    expect(await restarted.collectOnce()).toEqual([]);
  });

  it('retains a JSONL record until its last bytes and newline are available', async () => {
    const file = await writeSessionFile('hash-tail', 'sess_tail', []);
    const input = makeInput();
    await input.baselineOnce();
    const key = `kiro-desktop-session:${file}`;
    const response = REACT_FIXTURE_LINES.find(line => line.includes('"id":"6a628511-say"'))!;
    const split = Math.floor(response.length / 2);
    await fs.appendFile(file, response.slice(0, split));
    expect(await input.collectOnce()).toEqual([]);
    expect(stateStore.getOffset(key)).toBe(0);

    await fs.appendFile(file, response.slice(split) + '\n');
    const entries = await input.collectOnce();
    expect(entries.filter(entry => entry['event.name'] === 'llm.response')).toHaveLength(1);
    expect(stateStore.getOffset(key)).toBe((await fs.stat(file)).size);
    expect(await input.collectOnce()).toEqual([]);
  });

  it('keeps an unmatched prompt on disk through separate polls and restart while committing the preceding turns', async () => {
    const file = await writeSessionFile('hash-split-user', 'sess_split_user', REAL_FIXTURE_LINES);
    const stateFile = path.join(tmpDir, 'input-state.json');
    const state = new StateStore(stateFile);
    await state.load();
    const input = makeInput(state);
    await input.baselineOnce();
    expect(await input.collectOnce()).toHaveLength(0);

    const executionId = 'split-prompt-turn';
    const prompt = 'Later prompt 要保留 🧪';
    const row = (id: string, timestamp: string, payload: Record<string, unknown>) => JSON.stringify({ id, timestamp, payload }) + '\n';
    await fs.appendFile(file, REACT_FIXTURE_LINES.join('\n') + '\n');
    const lastComplete = (await fs.stat(file)).size;
    const key = `kiro-desktop-session:${file}`;
    await fs.appendFile(file, row('split-user', '2026-07-20T03:15:00.000Z', { type: 'user', content: prompt }));
    const precedingEntries = await input.collectOnce();
    expect(precedingEntries.filter(entry => entry['event.name'] === 'tool.result')).toHaveLength(3);
    expect(state.getOffset(key)).toBe(lastComplete);
    await fs.appendFile(file, row('split-start', '2026-07-20T03:15:00.400Z', { type: 'turn_start', executionId }));
    expect(await input.collectOnce()).toEqual([]);
    expect(state.getOffset(key)).toBe(lastComplete);
    await state.save();
    expect(await fs.readFile(stateFile, 'utf8')).not.toContain(prompt);

    await fs.appendFile(file, row('split-say', '2026-07-20T03:15:00.500Z', {
      type: 'assistant', executionId, operationType: 'Say', content: 'Done.',
    }) + row('split-end', '2026-07-20T03:15:00.550Z', { type: 'turn_end', executionId, stopReason: 'end_turn' }));
    const reopened = new StateStore(stateFile);
    await reopened.load();
    expect(reopened.getOffset(key)).toBe(lastComplete);
    const resumed = makeInput(reopened);
    const spans: ReadableSpan[] = [];
    const output = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'kiro-test',
      endpoints: [{ endpoint: 'http://unused.invalid' }] }, undefined, () => ({
      export(batch, callback) { spans.push(...batch); callback({ code: 0 }); },
      async shutdown() {},
    }));
    const manager = new InputManager();
    manager.setFlusher(output);
    manager.registerInput(resumed);
    try {
      await manager.startInput(resumed.id);
      await vi.waitFor(() => expect(spans.map(span => span.attributes['gen_ai.span.kind']).sort())
        .toEqual(['AGENT', 'ENTRY', 'LLM', 'STEP']));
      for (const kind of ['ENTRY', 'LLM']) {
        const span = spans.find(span => span.attributes['gen_ai.span.kind'] === kind);
        expect(String(span?.attributes['gen_ai.input.messages'])).toContain(prompt);
      }
      expect(reopened.getOffset(key)).toBe((await fs.stat(file)).size);
      expect(await resumed.collectOnce()).toEqual([]);
    } finally {
      await manager.stopAll();
      await output.shutdown();
    }
  });

  it('reads runtime-created session files from the beginning (no prior offset)', async () => {
    const input = makeInput();
    await input.baselineOnce();

    await writeSessionFile('hash-runtime', 'sess_runtime', REAL_FIXTURE_LINES.slice(0, 6));

    const entries = await input.collectOnce();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.['agent.kiro_event_type']).toBe('user');
  });

  it('returns entries from other sessions if a discovered file disappears before open', async () => {
    const before = await writeSessionFile('hash-a', 'sess_first', REAL_FIXTURE_LINES);
    const removed = await writeSessionFile('hash-b', 'sess_removed', REAL_FIXTURE_LINES);
    const after = await writeSessionFile('hash-c', 'sess_last', REAL_FIXTURE_LINES);
    const { open: openFile } = await vi.importActual<typeof fs>('node:fs/promises');
    const open = vi.mocked(fs.open).mockImplementation(async (file, ...args) => {
      if (file === removed) await fs.unlink(removed);
      return openFile(file, ...args);
    });

    try {
      const entries = await makeInput().collectOnce();
      expect([...new Set(entries.map(entry => entry['gen_ai.session.id']))]).toEqual(['sess_first', 'sess_last']);
      expect(stateStore.getOffset(`kiro-desktop-session:${before}`)).toBe((await fs.stat(before)).size);
      expect(stateStore.getOffset(`kiro-desktop-session:${after}`)).toBe((await fs.stat(after)).size);
    } finally {
      open.mockReset().mockImplementation(openFile);
    }
  });

  it('uses the replacement inode and size when a session rotates before open', async () => {
    const file = await writeSessionFile('hash-a', 'sess_rotated', REAL_FIXTURE_LINES);
    const input = makeInput();
    await input.baselineOnce();
    await fs.appendFile(file, `${REAL_FIXTURE_LINES[0]}\n`);

    const { open: openFile } = await vi.importActual<typeof fs>('node:fs/promises');
    const open = vi.mocked(fs.open).mockImplementationOnce(async (name, ...args) => {
      await fs.rename(file, `${file}.old`);
      await fs.writeFile(file, `${REAL_FIXTURE_LINES.slice(6).join('\n')}\n`);
      return openFile(name, ...args);
    });

    try {
      const entries = await input.collectOnce();
      expect(entries.filter(entry => entry['event.name'] === 'llm.response')).toHaveLength(1);
      expect(stateStore.getOffset(`kiro-desktop-session:${file}`)).toBe((await fs.stat(file)).size);
      expect(await input.collectOnce()).toEqual([]);
    } finally {
      open.mockReset().mockImplementation(openFile);
    }
  });

  it('emits llm.request / llm.response from REAL_FIXTURE (turn 2 has assistant Say; turn 1 gets synthetic final Say)', async () => {
    const file = await writeSessionFile('01ebf2a66fa98655', 'sess_aaa', REAL_FIXTURE_LINES);
    const input = makeInput();

    const entries = await input.collectOnce();
    const eventNames = entries.map(e => e['event.name']);
    expect(eventNames).toContain('llm.request');
    expect(eventNames).toContain('llm.response');

    const llmReqCount = eventNames.filter(n => n === 'llm.request').length;
    const llmRespCount = eventNames.filter(n => n === 'llm.response').length;
    // Turn 14c105db failed (no assistant Say) → synthetic final Say at turn_end
    // (1 req + 1 resp). Turn 8860b840 has assistant Say (1 req + 1 resp, no
    // synthetic because emittedSayInTurn=true). Total: 2 llm.requests.
    expect(llmReqCount).toBe(2);
    expect(llmRespCount).toBe(2);
  });

  it('attaches gen_ai.turn.id from payload.executionId on llm spans', async () => {
    const file = await writeSessionFile('hash-a', 'sess_aaa', REAL_FIXTURE_LINES);
    const input = makeInput();
    const entries = await input.collectOnce();
    // Find the real assistant Say llm.response (turn 8860b840), not the
    // synthetic final Say emitted for turn 14c105db.
    const llmResp = entries.find(e => e['event.name'] === 'llm.response' && (e['gen_ai.turn.id'] as string)?.startsWith('8860b840'));
    expect(llmResp).toBeDefined();
    expect(llmResp?.['gen_ai.turn.id']).toBe('8860b840-ea17-48a8-8701-a29eec903de5');
    expect(llmResp?.['gen_ai.session.id']).toBe('sess_aaa');
    expect(llmResp?.['gen_ai.agent.type']).toBe(ClientType.Kiro);
    expect(llmResp?.['gen_ai.agent.name']).toBe('Kiro Desktop');
    expect(llmResp?.['gen_ai.step.id']).toContain('8860b840-ea17-48a8-8701-a29eec903de5#');
  });

  it('does not crash when executionId is missing (lone user record is dropped, no spurious trace)', async () => {
    const file = await writeSessionFile('h', 'sess_x', [
      JSON.stringify({
        id: 'lone-user',
        timestamp: '2026-07-20T03:00:00.000Z',
        payload: { type: 'user', content: 'lone' },
      }),
    ]);
    const input = makeInput();
    const entries = await input.collectOnce();
    // Lone user with no following turn_start is dropped (would otherwise
    // create a spurious ENTRY+AGENT trace via the OTLP flusher's
    // session-keyed buffer backfill).
    expect(entries).toHaveLength(0);
  });

  it('parses ISO-8601 timestamps into Unix nanoseconds', async () => {
    const file = await writeSessionFile('h', 'sess_ts', [
      JSON.stringify({
        id: '21a6ce6e-dc5d-45bc-9c14-b88ebb66a877-say',
        timestamp: '2026-07-20T02:54:42.489Z',
        payload: { type: 'assistant', content: 'KIRO_LINUX_CDP_OK', operationType: 'Say', executionId: '8860b840-ea17-48a8-8701-a29eec903de5' },
      }),
    ]);
    const input = makeInput();
    const entries = await input.collectOnce();
    // 2026-07-20T02:54:42.489Z -> 1784516082489000000 ns
    const llmResp = entries.find(e => e['event.name'] === 'llm.response');
    expect(llmResp?.['time_unix_nano']).toBe('1784516082489000000');
  });

  it('REACT_FIXTURE produces 3+ STEP groups, 3+ TOOL spans, multi-turn ReAct', async () => {
    const file = await writeSessionFile('01ebf2a66fa98655', 'sess_react', REACT_FIXTURE_LINES);
    const input = makeInput();

    const entries = await input.collectOnce();
    const eventNames = entries.map(e => e['event.name']);
    const toolCallCount = eventNames.filter(n => n === 'tool.call').length;
    const toolResultCount = eventNames.filter(n => n === 'tool.result').length;
    expect(toolCallCount).toBeGreaterThanOrEqual(3);
    expect(toolResultCount).toBeGreaterThanOrEqual(3);

    const stepIds = new Set(entries.map(e => e['gen_ai.step.id']).filter((v): v is string => typeof v === 'string'));
    expect(stepIds.size).toBeGreaterThanOrEqual(3);

    const turnIds = new Set(entries.map(e => e['gen_ai.turn.id']).filter((v): v is string => typeof v === 'string'));
    expect(turnIds.size).toBeGreaterThanOrEqual(2);
  });

  it('every llm.response has non-empty gen_ai.output.messages; every llm.request has gen_ai.input.messages_delta', async () => {
    const file = await writeSessionFile('01ebf2a66fa98655', 'sess_react2', REACT_FIXTURE_LINES);
    const input = makeInput();
    const entries = await input.collectOnce();
    const llmResponses = entries.filter(e => e['event.name'] === 'llm.response');
    expect(llmResponses.length).toBeGreaterThan(0);
    for (const r of llmResponses) {
      const out = r['gen_ai.output.messages'];
      expect(out).toBeDefined();
      expect(Array.isArray(out) ? out.length : 0).toBeGreaterThan(0);
    }

    const llmRequests = entries.filter(e => e['event.name'] === 'llm.request');
    expect(llmRequests.length).toBeGreaterThan(0);
    for (const r of llmRequests) {
      const delta = r['gen_ai.input.messages_delta'];
      expect(delta).toBeDefined();
    }
  });

  it('tool.result entries share step.id with their tool.call and have later time', async () => {
    const file = await writeSessionFile('01ebf2a66fa98655', 'sess_react3', REACT_FIXTURE_LINES);
    const input = makeInput();
    const entries = await input.collectOnce();
    const calls = entries.filter(e => e['event.name'] === 'tool.call');
    const results = entries.filter(e => e['event.name'] === 'tool.result');
    expect(calls.length).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      const matchedCall = calls.find(c => c['gen_ai.tool.call.id'] === result['gen_ai.tool.call.id']);
      expect(matchedCall).toBeDefined();
      expect(result['gen_ai.step.id']).toBe(matchedCall!['gen_ai.step.id']);
      expect(BigInt(result['time_unix_nano'] as string)).toBeGreaterThan(
        BigInt(matchedCall!['time_unix_nano'] as string),
      );
    }
  });

  it('preserves kiro_event_type attribute across all emitted entries', async () => {
    const file = await writeSessionFile('01ebf2a66fa98655', 'sess_react4', REACT_FIXTURE_LINES);
    const input = makeInput();
    const entries = await input.collectOnce();
    const types = new Set(entries.map(e => e['agent.kiro_event_type']));
    expect([...types].sort()).toEqual([
      'assistant',
      'session_metadata',
      'tool_call',
      'tool_result',
      'turn_end',
      'turn_start',
      'usage_summary',
      'user',
    ]);
  });

  function makeInput(state: StateStore = stateStore as unknown as StateStore): TestKiroDesktopSessionInput {
    return new TestKiroDesktopSessionInput({
      stateStore: state,
      sessionDir: tmpDir,
      pollIntervalMs: 60_000,
    });
  }

  async function writeSessionFile(
    hashDir: string,
    sessDir: string,
    records: string[],
  ): Promise<string> {
    const file = path.join(tmpDir, hashDir, sessDir, 'messages.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      records.length > 0 ? records.join('\n') + '\n' : '',
    );
    return file;
  }
});
