import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { QwenWorkCNTraceInput } from '../../../src/inputs/qwen-work-cn/qwen-work-cn-trace-input.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../../src/types/index.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

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
    await fs.mkdir(historyDir, { recursive: true });
    await fs.mkdir(segmentsRoot, { recursive: true });
    stateStore = new MockStateStore();
    stateStore.update('qwen-work-cn-trace', { lastFile: todayFile(), lastOffset: 0 });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeInput(): QwenWorkCNTraceInput {
    return new QwenWorkCNTraceInput({
      stateStore: stateStore as never,
      logDir: historyDir,
      segmentsRoot,
      interceptFile,
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

  it('has an independent QwenWorkCN identity and watches all three sources', () => {
    const input = makeInput();
    expect(input.id).toBe('qwen-work-cn-trace');
    expect(input.agentType).toBe(ClientType.QwenWorkCN);
    expect(input.collectionMethod).toBe(CollectionMethod.HookJsonl);
    expect(QwenWorkCNTraceInput.getWatchPaths()).toEqual(expect.arrayContaining([
      expect.stringContaining('.qwenworkcn/logs/sessions'),
      expect.stringContaining('qwenworkcn-intercept.jsonl'),
    ]));
    expect(QwenWorkCNTraceInput.getWatchPaths({
      logDir: historyDir,
      segmentsRoot,
      interceptFile,
    })).toEqual([historyDir, segmentsRoot, interceptFile]);
  });

  it('enriches zero-token Qwen segments from qwenworkcn-intercept by response id', async () => {
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
    })}\n`);

    const entries = await collectOnce(makeInput());
    const response = entries.find(value => value['event.id'] === 'response')!;
    expect(response['gen_ai.usage.input_tokens']).toBe(32_244);
    expect(response['gen_ai.usage.output_tokens']).toBe(667);
    expect(response['gen_ai.usage.cache_read.input_tokens']).toBe(24_576);
    expect(response['gen_ai.usage.reasoning_tokens']).toBe(285);
    expect(response['gen_ai.usage.total_tokens']).toBe(32_911);
    expect(response['gen_ai.request.model']).toBe('qmodel_latest');
    expect(response['gen_ai.response.model']).toBe('qmodel_latest');
    expect(entries.every(value => value['gen_ai.request.model'] === 'qmodel_latest')).toBe(true);
    expect(entries.every(value => value['gen_ai.agent.type'] === ClientType.QwenWorkCN)).toBe(true);
    expect(entries[0]?.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps non-zero segment usage authoritative and only overlays missing cache usage', async () => {
    await writeHistory([
      entry({ 'event.id': 'request', 'event.name': 'llm.request' }),
      entry({ 'event.id': 'response', 'gen_ai.response.id': 'chatcmpl-qwen-2' }),
    ]);
    await writeSegments([
      { ts: '2026-08-06T06:00:00.000Z', type: 'model.request.started', turn_id: 'turn-1', request_id: 'request-2', data: { model: 'qmodel_latest' } },
      { ts: '2026-08-06T06:00:05.000Z', type: 'model.response.completed', turn_id: 'turn-1', request_id: 'request-2', data: { model: 'qmodel_latest', input_tokens: 100, output_tokens: 20 } },
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
    expect(response['gen_ai.usage.cache_read.input_tokens']).toBe(80);
    expect(response['gen_ai.usage.reasoning_tokens']).toBe(7);
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
