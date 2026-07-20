import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { KiroDesktopSessionInput } from '../../../src/inputs/kiro-desktop-session/kiro-desktop-session-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

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

  it('collects nothing after cold-start (offset=size); a lone appended user record is dropped (no following turn to attach to)', async () => {
    const file = await writeSessionFile('hash-a', 'sess_aaa', REAL_FIXTURE_LINES);
    const input = makeInput();
    await input.baselineOnce();

    expect(await input.collectOnce()).toHaveLength(0);

    const appended = JSON.stringify({
      id: 'post-baseline-user',
      timestamp: '2026-07-20T03:00:00.000Z',
      payload: { type: 'user', content: 'post-baseline prompt' },
    }) + '\n';
    await fs.appendFile(file, appended);

    // A lone user record (no following turn_start in the same batch) is
    // intentionally dropped to avoid creating a spurious ENTRY+AGENT trace
    // in the OTLP flusher. When Kiro eventually writes turn_start +
    // assistant/tool records, those will trigger emission of the user
    // marker attached to that turn's executionId.
    const entries = await input.collectOnce();
    expect(entries).toHaveLength(0);
  });

  it('reads runtime-created session files from the beginning (no prior offset)', async () => {
    const input = makeInput();
    await input.baselineOnce();

    await writeSessionFile('hash-runtime', 'sess_runtime', REAL_FIXTURE_LINES.slice(0, 2));

    const entries = await input.collectOnce();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.['agent.kiro_event_type']).toBe('user');
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

  function makeInput(): TestKiroDesktopSessionInput {
    return new TestKiroDesktopSessionInput({
      stateStore: stateStore as any,
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
