import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderCliSessionInput } from '../../../src/inputs/qoder-cli-session/qoder-cli-session-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

class TestQoderCliSessionInput extends QoderCliSessionInput {
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

describe('QoderCliSessionInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-cli-session-test-'));
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct identity and collection method', () => {
    const input = makeInput();

    expect(input.id).toBe('qoder-cli-session');
    expect(input.agentType).toBe(ClientType.QoderCli);
    expect(input.collectionMethod).toBe(CollectionMethod.SessionFilePolling);
  });

  it('discovers segment JSONL files across multiple session directories', async () => {
    const fileA = await writeSegmentFile('cwd-a', 'session-a', 'a.jsonl', []);
    const fileB = await writeSegmentFile('cwd-b', 'session-b', 'b.jsonl', []);

    const files = await makeInput().discoverOnce();

    expect(files).toEqual([fileA, fileB].sort());
  });

  it('ignores JSONL files outside segments directories', async () => {
    const segmentFile = await writeSegmentFile('cwd-a', 'session-a', 'a.jsonl', []);
    const otherFile = path.join(tmpDir, 'cwd-a', 'session-a', 'other.jsonl');
    await fs.writeFile(otherFile, '{}\n');

    const files = await makeInput().discoverOnce();

    expect(files).toEqual([segmentFile]);
  });

  it('does not recursively scan arbitrary nested segments directories', async () => {
    const segmentFile = await writeSegmentFile('cwd-a', 'session-a', 'a.jsonl', []);
    const nestedFile = path.join(tmpDir, 'cwd-a', 'nested', 'session-b', 'segments', 'b.jsonl');
    await fs.mkdir(path.dirname(nestedFile), { recursive: true });
    await fs.writeFile(nestedFile, '{}\n');

    const files = await makeInput().discoverOnce();

    expect(files).toEqual([segmentFile]);
  });

  it('baselines existing segment files and collects only appended token usage', async () => {
    const file = await writeSegmentFile('cwd-a', 'session-a', 'a.jsonl', [
      makeModelResponse({ requestId: 'old-request', seq: 1, inputTokens: 10 }),
    ]);
    const input = makeInput();

    await input.baselineOnce();
    expect(await input.collectOnce()).toHaveLength(0);

    await fs.appendFile(file, `${JSON.stringify(makeModelResponse({
      requestId: 'new-request',
      seq: 2,
      inputTokens: 20,
    }))}\n`);

    const entries = await input.collectOnce();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.['gen_ai.response.id']).toBeUndefined();
    expect(entries[0]?.['gen_ai.request.id']).toBeUndefined();
    expect(entries[0]?.['agent.request_id']).toBe('new-request');
    expect(entries[0]?.['gen_ai.usage.input_tokens']).toBe(20);
  });

  it('reads runtime-created segment files from the beginning', async () => {
    const input = makeInput();
    await input.baselineOnce();

    await writeSegmentFile('cwd-a', 'session-a', 'a.jsonl', [
      makeModelResponse({ requestId: 'runtime-request', seq: 1, inputTokens: 33 }),
    ]);

    const entries = await input.collectOnce();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.['gen_ai.response.id']).toBeUndefined();
    expect(entries[0]?.['gen_ai.request.id']).toBeUndefined();
    expect(entries[0]?.['agent.request_id']).toBe('runtime-request');
    expect(entries[0]?.['gen_ai.usage.input_tokens']).toBe(33);
  });

  it('ignores unsupported Qoder event types', async () => {
    const file = await writeSegmentFile('cwd-a', 'session-a', 'a.jsonl', []);
    const input = makeInput();
    await input.baselineOnce();

    await fs.appendFile(file, `${JSON.stringify({
      ts: 1_777_659_871_533,
      seq: 2,
      level: 'info',
      type: 'turn.started',
      turn_id: 'turn-1',
      data: { model: 'auto' },
    })}\n`);

    expect(await input.collectOnce()).toHaveLength(0);
  });

  it('maps model response token usage and identifiers to AgentActivityEntry', async () => {
    const file = await writeSegmentFile('cwd-key', 'session-123', 'a.jsonl', []);
    const input = makeInput();
    await input.baselineOnce();

    await fs.appendFile(file, `${JSON.stringify(makeModelResponse({
      requestId: 'request-123',
      turnId: 'turn-123',
      loopId: 'turn-123:1',
      seq: 9,
      inputTokens: 22030,
      outputTokens: 163,
      cacheReadTokens: 21814,
      cacheWriteTokens: 4,
    }))}\n`);

    const entries = await input.collectOnce();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.name': 'llm.response',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.session.id': 'session-123',
      'gen_ai.request.model': 'auto',
      'gen_ai.response.model': 'auto',
      'gen_ai.usage.input_tokens': 22030,
      'gen_ai.usage.output_tokens': 163,
      'gen_ai.usage.cache_read.input_tokens': 21814,
      'gen_ai.usage.cache_creation.input_tokens': 4,
      'gen_ai.usage.total_tokens': 22193,
      time_unix_nano: '1777659871533000000',
    });
    expect(entries[0]).toMatchObject({
      'agent.source': 'qoder-cli-session-segment',
      'agent.qoder.type': 'model.response.completed',
      'agent.segment_file': file,
      'agent.segment_name': 'a.jsonl',
      'agent.cwd_key': 'cwd-key',
      'agent.seq': 9,
      'agent.level': 'info',
      'agent.request_index': 1,
      'agent.request_id': 'request-123',
      'agent.turn_id': 'turn-123',
      'agent.loop_id': 'turn-123:1',
      'agent.stop_reason': 'end_turn',
      'agent.content_block_count': 2,
    });
    expect(entries[0]?.['gen_ai.response.id']).toBeUndefined();
    expect(entries[0]?.['gen_ai.request.id']).toBeUndefined();
    expect(entries[0]?.['gen_ai.turn.id']).toBeUndefined();
    expect(entries[0]?.['gen_ai.step.id']).toBeUndefined();
  });

  it('generates deterministic event ids for the same source row', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    const row = makeModelResponse({ requestId: 'request-1', seq: 1 });
    const first = await input.mapOnce(row, file);
    const second = await input.mapOnce(row, file);

    expect(first?.['event.id']).toBe(second?.['event.id']);
  });

  it('defaults missing segment model fields to unknown', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();
    const row = makeModelResponse({ requestId: 'request-no-model', seq: 3 });
    delete (row.data as Record<string, unknown>).model;

    const entry = await input.mapOnce(row, file);

    expect(entry?.['gen_ai.request.model']).toBe('unknown');
    expect(entry?.['gen_ai.response.model']).toBe('unknown');
  });

  function makeInput(): TestQoderCliSessionInput {
    return new TestQoderCliSessionInput({
      stateStore: stateStore as any,
      sessionDir: tmpDir,
      pollIntervalMs: 60_000,
    });
  }

  async function writeSegmentFile(
    cwdKey: string,
    sessionId: string,
    fileName: string,
    records: Record<string, unknown>[],
  ): Promise<string> {
    const file = path.join(tmpDir, cwdKey, sessionId, 'segments', fileName);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      records.map(record => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''),
    );
    return file;
  }
});

function makeModelResponse(overrides: {
  requestId?: string;
  turnId?: string;
  loopId?: string;
  seq?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} = {}): Record<string, unknown> {
  return {
    ts: 1_777_659_871_533,
    seq: overrides.seq ?? 1,
    level: 'info',
    type: 'model.response.completed',
    turn_id: overrides.turnId ?? 'turn-1',
    loop_id: overrides.loopId ?? 'turn-1:1',
    request_id: overrides.requestId ?? 'request-1',
    data: {
      request_index: 1,
      model: 'auto',
      stop_reason: 'end_turn',
      content_block_count: 2,
      input_tokens: overrides.inputTokens ?? 10,
      output_tokens: overrides.outputTokens ?? 2,
      cache_read_input_tokens: overrides.cacheReadTokens ?? 3,
      cache_creation_input_tokens: overrides.cacheWriteTokens ?? 0,
    },
  };
}
