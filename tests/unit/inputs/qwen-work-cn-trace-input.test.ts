import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as interceptReader from '../../../src/inputs/qoder-trace/intercept-token-reader.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { QwenWorkCNTraceInput } from '../../../src/inputs/qwen-work-cn/qwen-work-cn-trace-input.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../../src/types/index.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { execSql, hasNodeSqlite } from '../../helpers/sqlite-fixture.mjs';

describe('QwenWorkCNTraceInput', () => {
  let root: string;
  let historyDir: string;
  let segmentsRoot: string;
  let interceptFile: string;
  let stateStore: MockStateStore;

  const cwd = '/Users/test/qwen-workspace';
  const encodedCwd = '-Users-test-qwen-workspace';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-work-cn-trace-'));
    historyDir = path.join(root, 'history');
    segmentsRoot = path.join(root, 'sessions');
    interceptFile = path.join(root, 'qwenworkcn-intercept.jsonl');
    vi.spyOn(interceptReader, 'getInterceptFile').mockReturnValue(interceptFile);
    vi.spyOn(interceptReader, 'readInterceptFile');
    await fs.mkdir(historyDir, { recursive: true });
    await fs.mkdir(segmentsRoot, { recursive: true });
    stateStore = new MockStateStore();
    stateStore.update('qwen-work-cn-trace', { lastFile: todayFile(), lastOffset: 0 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeInput(): QwenWorkCNTraceInput {
    return new QwenWorkCNTraceInput({
      stateStore: stateStore as never,
      logDir: historyDir,
      segmentsRoot,
      flashSource: { desktopDb: path.join(root, 'agents.db'), flashDb: path.join(root, 'qwenwork.db') },
      pollIntervalMs: 60_000,
    });
  }

  function entry(overrides: Partial<AgentActivityEntry>): AgentActivityEntry {
    return {
      'event.id': 'event',
      'event.name': 'llm.response',
      'gen_ai.agent.type': ClientType.QwenWorkCN,
      'gen_ai.session.id': 'session-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'turn-1:s1',
      'agent.qwenworkcn.cwd': cwd,
      time_unix_nano: nano('2026-08-06T06:00:05.000Z'),
      ...overrides,
    } as AgentActivityEntry;
  }

  async function writeHistory(entries: AgentActivityEntry[]): Promise<void> {
    await fs.writeFile(
      path.join(historyDir, todayFile()),
      `${entries.map(value => JSON.stringify(value)).join('\n')}\n`,
    );
  }

  async function writeSegments(events: object[]): Promise<void> {
    const directory = path.join(segmentsRoot, encodedCwd, 'session-1', 'segments');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'run.jsonl'), `${events.map(value => JSON.stringify(value)).join('\n')}\n`);
  }

  it('has an independent QwenWorkCN identity and watches only native sources', () => {
    const input = makeInput();
    expect(input.id).toBe('qwen-work-cn-trace');
    expect(input.agentType).toBe(ClientType.QwenWorkCN);
    expect(input.collectionMethod).toBe(CollectionMethod.HookJsonl);
    expect(QwenWorkCNTraceInput.getWatchPaths()).toEqual([
      expect.stringContaining('qwen-work-cn/history'),
      expect.stringContaining('.qwenworkcn/logs/sessions'),
    ]);
    expect(QwenWorkCNTraceInput.getWatchPaths({
      logDir: historyDir,
      segmentsRoot,
    })).toEqual([historyDir, segmentsRoot]);
  });

  it('strips a legacy bare runtime version while preserving the agent-scoped version', async () => {
    await writeHistory([
      entry({
        version: '0.1.5',
        'agent.qwenworkcn.version': '0.1.5',
      }),
    ]);

    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBeUndefined();
    expect(entries[0]['agent.qwenworkcn.version']).toBe('0.1.5');
  });

  it('keeps native model and timing but ignores legacy intercept data for zero-token segments', async () => {
    await writeHistory([
      entry({
        'event.id': 'request',
        'event.name': 'llm.request',
        'gen_ai.request.model': 'unknown',
      }),
      entry({
        'event.id': 'tool-call',
        'event.name': 'tool.call' as never,
        'gen_ai.request.model': 'unknown',
      }),
      entry({
        'event.id': 'tool-result',
        'event.name': 'tool.result' as never,
        'gen_ai.request.model': 'unknown',
      }),
      entry({
        'event.id': 'response',
        'gen_ai.request.model': 'unknown',
        'gen_ai.response.id': 'chatcmpl-qwen-1',
      }),
    ]);
    await writeSegments([
      { ts: '2026-08-06T06:00:00.000Z', type: 'model.request.started', turn_id: 'turn-1', request_id: 'request-1', data: { model: 'qmodel_latest' } },
      { ts: '2026-08-06T06:00:05.000Z', type: 'model.response.completed', turn_id: 'turn-1', request_id: 'request-1', data: { model: 'qmodel_latest', input_tokens: 0, output_tokens: 0 } },
    ]);
    await fs.writeFile(interceptFile, `${JSON.stringify({
      type: 'token',
      ts: Date.now(),
      id: 'chatcmpl-qwen-1',
      prompt_tokens: 32_244,
      completion_tokens: 667,
      cached_tokens: 24_576,
      reasoning_tokens: 285,
      total_tokens: 32_911,
    })}\n${JSON.stringify({ type: 'system_prompt', ts: Date.now(), content: 'Synthetic legacy instructions' })}\n`);
    const legacyContent = await fs.readFile(interceptFile, 'utf8');

    const entries = await collectOnce(makeInput());
    const response = entries.find(value => value['event.id'] === 'response')!;
    const request = entries.find(value => value['event.id'] === 'request')!;
    expect(interceptReader.readInterceptFile).not.toHaveBeenCalled();
    expect(await fs.readFile(interceptFile, 'utf8')).toBe(legacyContent);
    expect(request.time_unix_nano).toBe(nano('2026-08-06T06:00:00.000Z'));
    expect(response.time_unix_nano).toBe(nano('2026-08-06T06:00:05.000Z'));
    expect(request['gen_ai.system_instructions']).toBeUndefined();
    expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.cache_read.input_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.reasoning_tokens']).toBeUndefined();
    expect(response['workspace.path']).toBe(cwd);
    expect(response['gen_ai.usage.total_tokens']).toBeUndefined();
    expect(response['gen_ai.request.model']).toBe('qmodel_latest');
    expect(response['gen_ai.response.model']).toBe('qmodel_latest');
    expect(entries.every(value => value['gen_ai.request.model'] === 'qmodel_latest')).toBe(true);
    expect(entries.every(value => value['gen_ai.agent.type'] === ClientType.QwenWorkCN)).toBe(true);
    expect(entries[0]?.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('collects native token and cache usage without intercept overlays', async () => {
    await writeHistory([
      entry({ 'event.id': 'request', 'event.name': 'llm.request' }),
      entry({ 'event.id': 'response', 'gen_ai.response.id': 'chatcmpl-qwen-2' }),
    ]);
    await writeSegments([
      { ts: '2026-08-06T06:00:00.000Z', type: 'model.request.started', turn_id: 'turn-1', request_id: 'request-2', data: { model: 'qmodel_latest' } },
      { ts: '2026-08-06T06:00:05.000Z', type: 'model.response.completed', turn_id: 'turn-1', request_id: 'request-2', data: { model: 'qmodel_latest', input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 } },
    ]);
    await fs.writeFile(interceptFile, `${JSON.stringify({
      type: 'token', ts: Date.now(), id: 'chatcmpl-qwen-2',
      prompt_tokens: 999, completion_tokens: 999, cached_tokens: 80, reasoning_tokens: 7, total_tokens: 1998,
    })}\n`);

    const entries = await collectOnce(makeInput());
    const response = entries.find(value => value['event.id'] === 'response')!;
    expect(response['gen_ai.usage.input_tokens']).toBe(100);
    expect(response['gen_ai.usage.output_tokens']).toBe(20);
    expect(response['gen_ai.usage.total_tokens']).toBe(120);
    expect(response['gen_ai.usage.cache_read.input_tokens']).toBe(60);
    expect(response['gen_ai.usage.cache_creation.input_tokens']).toBe(10);
    expect(response['gen_ai.usage.reasoning_tokens']).toBeUndefined();
    expect(interceptReader.readInterceptFile).not.toHaveBeenCalled();
  });

  it.skipIf(!hasNodeSqlite()).each([
    { caseName: 'matching calls', secondPrompt: false, toolId: 'call-1', expected: true },
    { caseName: 'another tool invocation', secondPrompt: false, toolId: 'call-other', expected: false },
    { caseName: 'an ambiguous prompt owner', secondPrompt: true, toolId: 'call-1', expected: false },
  ])('enriches only the bound Flash calls with $caseName', async ({ secondPrompt, toolId, expected }) => {
    const prompt = 'read a synthetic fixture';
    const at = Date.parse('2026-08-06T06:00:05.000Z');
    const observed = nano('2026-08-06T06:00:12.000Z');
    const s2 = 'turn-1:s2';
    await writeHistory([
      entry({ 'event.id': 'request-1', 'event.name': 'llm.request', observed_time_unix_nano: observed,
        'gen_ai.request.model': 'unknown',
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: prompt }] }] }),
      entry({ 'event.id': 'response-1', 'gen_ai.response.id': 'response-1', 'gen_ai.response.model': 'unknown' }),
      entry({ 'event.id': 'tool-1', 'event.name': 'tool.call', 'gen_ai.tool.call.id': 'call-1' }),
      entry({ 'event.id': 'request-2', 'event.name': 'llm.request', 'gen_ai.step.id': s2 }),
      entry({ 'event.id': 'response-2', 'gen_ai.step.id': s2, 'gen_ai.response.id': 'response-2',
        'gen_ai.response.model': 'resolved-model' }),
    ]);

    const flashDb = path.join(root, 'qwenwork.db');
    const sqlJson = (value: object) => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    const binding = sqlJson({ engineSessionBindingV1: { hostSessionId: 'session-1', subChatId: 'sub-1',
      nativeSessionId: 'native-1', storageNamespace: flashDb, engineId: 'opencode' } });
    await execSql(path.join(root, 'agents.db'), `
      CREATE TABLE sub_chats(id TEXT PRIMARY KEY, session_id TEXT, ext TEXT);
      INSERT INTO sub_chats VALUES ('sub-1','session-1',${binding});
    `);
    const user = sqlJson({ role: 'user' });
    const text = sqlJson({ type: 'text', text: prompt });
    const assistant = sqlJson({ role: 'assistant', parentID: 'native-user', modelID: 'mode-test-route' });
    await execSql(flashDb, `
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
      INSERT INTO message VALUES
        ('native-user','native-1',${at + 5},${user}),
        ('native-one','native-1',${at + 10},${assistant}),
        ('native-two','native-1',${at + 1000},${assistant});
      INSERT INTO part VALUES
        ('p-user','native-user','native-1',${text}),
        ('p-01','native-one','native-1',${sqlJson({ type: 'tool', callID: toolId })}),
        ('p-02','native-one','native-1',${sqlJson({ type: 'step-finish',
          tokens: { input: 70, output: 9, reasoning: 2, cache: { read: 21, write: 3 } } })}),
        ('p-03','native-two','native-1',${sqlJson({ type: 'step-finish',
          tokens: { input: 12, output: 20, reasoning: 0, cache: { read: 90, write: 0 } } })});
      ${secondPrompt ? `INSERT INTO message VALUES ('other-user','native-1',${at + 20},${user});
        INSERT INTO part VALUES ('p-other','other-user','native-1',${text});` : ''}
    `);

    const output = await collectOnce(makeInput());
    const responses = output.filter(value => value['event.name'] === 'llm.response');
    expect(responses).toHaveLength(2);
    expect(responses.map(value => value['gen_ai.usage.total_tokens'])).toEqual(expected ? [105, 122] : [undefined, undefined]);
    expect(responses[0]!['gen_ai.request.model']).toBe(expected ? 'mode-test-route' : undefined);
    expect(responses[0]!['gen_ai.response.model']).toBe(expected ? undefined : 'unknown');
    expect(responses[1]!['gen_ai.response.model']).toBe('resolved-model');
    if (expected) {
      expect(responses[0]).toMatchObject({ 'gen_ai.usage.input_tokens': 94, 'gen_ai.usage.output_tokens': 11,
        'gen_ai.usage.cache_read.input_tokens': 21, 'gen_ai.usage.cache_creation.input_tokens': 3 });
      expect(responses[1]).toMatchObject({ 'gen_ai.usage.input_tokens': 102, 'gen_ai.usage.output_tokens': 20,
        'gen_ai.usage.cache_read.input_tokens': 90 });
    }
  });

  it('does not read the QoderWork intercept file', async () => {
    await writeHistory([
      entry({ 'event.id': 'request', 'event.name': 'llm.request' }),
      entry({ 'event.id': 'response', 'gen_ai.response.id': 'chatcmpl-qoder-only' }),
    ]);
    await fs.writeFile(path.join(root, 'qoderwork-intercept.jsonl'), `${JSON.stringify({
      type: 'token', ts: Date.now(), id: 'chatcmpl-qoder-only',
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    })}\n`);

    const entries = await collectOnce(makeInput());
    const response = entries.find(value => value['event.id'] === 'response')!;
    expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
  });

  it('drains every file after a legacy checkpoint across multi-day rollover without replay', async () => {
    const oldFile = datedFile(-2);
    const middleFile = datedFile(-1);
    const consumed = entry({ 'event.id': 'old-consumed', 'event.name': 'other' });
    const pending = entry({ 'event.id': 'old-pending', 'event.name': 'other' });
    const middle = entry({ 'event.id': 'middle-new', 'event.name': 'other' });
    const current = entry({ 'event.id': 'today-new', 'event.name': 'other' });
    const consumedLine = `${JSON.stringify(consumed)}\n`;
    await fs.writeFile(path.join(historyDir, oldFile), `${consumedLine}${JSON.stringify(pending)}\n`);
    await fs.writeFile(path.join(historyDir, middleFile), `${JSON.stringify(middle)}\n`);
    await fs.writeFile(path.join(historyDir, todayFile()), `${JSON.stringify(current)}\n`);
    stateStore.update('qwen-work-cn-trace', {
      lastFile: oldFile,
      lastOffset: Buffer.byteLength(consumedLine),
    });

    const first = await collectOnce(makeInput());
    expect(first.map(value => value['event.id'])).toEqual(['old-pending', 'middle-new', 'today-new']);
    expect(stateStore.get('qwen-work-cn-trace').extra?.hookLogOffsets).toMatchObject({
      [oldFile]: (await fs.stat(path.join(historyDir, oldFile))).size,
      [middleFile]: (await fs.stat(path.join(historyDir, middleFile))).size,
      [todayFile()]: (await fs.stat(path.join(historyDir, todayFile()))).size,
    });

    const second = await collectOnce(makeInput());
    expect(second).toEqual([]);
  });

  it('does not checkpoint an incomplete final JSONL row', async () => {
    const record = entry({ 'event.id': 'completed-later', 'event.name': 'other' });
    const logFile = path.join(historyDir, todayFile());
    await fs.writeFile(logFile, JSON.stringify(record));

    expect(await collectOnce(makeInput())).toEqual([]);
    expect((stateStore.get('qwen-work-cn-trace').extra?.hookLogOffsets as Record<string, number>)[todayFile()])
      .toBe(0);

    await fs.appendFile(logFile, '\n');
    expect((await collectOnce(makeInput())).map(value => value['event.id'])).toEqual(['completed-later']);
  });

  it('does not checkpoint an incomplete final segment row', async () => {
    const segmentDir = path.join(segmentsRoot, encodedCwd, 'session-1', 'segments');
    const segmentFile = path.join(segmentDir, 'run.jsonl');
    await fs.mkdir(segmentDir, { recursive: true });
    const event = {
      ts: '2026-08-06T06:00:00.000Z',
      type: 'model.request.started',
      turn_id: 'turn-1',
      request_id: 'request-incomplete',
      data: { model: 'qmodel_latest' },
    };
    await fs.writeFile(segmentFile, JSON.stringify(event));

    const input = makeInput();
    await (input as any).readSegmentFile('session-1', segmentFile);
    const stateKey = `qwen-work-cn-trace:segment:${segmentFile}`;
    expect(stateStore.getOffset(stateKey)).toBe(0);
    expect((input as any).inFlightPairs.get('session-1')).toBeUndefined();

    await fs.appendFile(segmentFile, '\n');
    await (input as any).readSegmentFile('session-1', segmentFile);
    expect(stateStore.getOffset(stateKey)).toBe((await fs.stat(segmentFile)).size);
    expect((input as any).inFlightPairs.get('session-1')?.has('request-incomplete')).toBe(true);
  });
});

function todayFile(): string {
  return datedFile(0);
}

function datedFile(dayOffset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `qwen-work-cn-${day}.jsonl`;
}

function nano(iso: string): string {
  return String(BigInt(Date.parse(iso)) * 1_000_000n);
}

async function collectOnce(input: QwenWorkCNTraceInput): Promise<AgentActivityEntry[]> {
  const entries: AgentActivityEntry[] = [];
  input.on('entries', batch => entries.push(...batch));
  await input.start();
  await input.stop();
  return entries;
}
