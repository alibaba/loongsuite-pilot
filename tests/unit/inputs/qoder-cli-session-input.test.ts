import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderCliSessionInput, VALID_FINISH_REASONS } from '../../../src/inputs/qoder-cli-session/qoder-cli-session-input.js';
import { VALID_FINISH_REASONS as VALIDATOR_FINISH_REASONS } from '../../../scripts/validate-trace.mjs';
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
    expect(entries[0]?.['gen_ai.response.id']).toBe('new-request');
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
    expect(entries[0]?.['gen_ai.response.id']).toBe('runtime-request');
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
      'gen_ai.turn.id': 'turn-123',
      'gen_ai.step.id': 'turn-123:s1',
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
    expect(entries[0]?.['gen_ai.response.id']).toBe('request-123');
    expect(entries[0]?.['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    expect(entries[0]?.['gen_ai.request.id']).toBeUndefined();
  });

  it('normalizes the vendor stop_reason tool_use into the OTel value tool_call', async () => {
    // gen_ai.response.finish_reasons is the normalized OTel GenAI enum:
    // validate-trace.mjs errors on values outside VALID_FINISH_REASONS, and
    // `tool_use` is Anthropic's native wording, not part of it. The transcript
    // hook emits `tool_call` for the same situation, so both collection paths
    // must agree or downstream aggregation splits one meaning across two values.
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    const row = makeModelResponse({ requestId: 'req-fr', seq: 1 });
    (row.data as Record<string, unknown>).stop_reason = 'tool_use';

    const entry = await input.mapOnce(row, file);

    expect(entry?.['event.name']).toBe('llm.response');
    expect(entry?.['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    expect(Array.isArray(entry?.['gen_ai.response.finish_reasons'])).toBe(true);
    // The raw vendor value must stay reachable — normalization is a rename at
    // the semantic-convention layer, not a loss of the source observation.
    expect(entry?.['agent.stop_reason']).toBe('tool_use');
  });

  it('passes through stop_reason values that are already valid OTel finish reasons', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    for (const reason of ['end_turn', 'max_tokens', 'stop']) {
      const row = makeModelResponse({ requestId: `req-${reason}`, seq: 1 });
      (row.data as Record<string, unknown>).stop_reason = reason;

      const entry = await input.mapOnce(row, file);

      expect(entry?.['gen_ai.response.finish_reasons']).toEqual([reason]);
    }
  });

  it('emits gen_ai.response.id top-level field equal to responseId', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    const row = makeModelResponse({ requestId: 'resp-id-xyz', seq: 1 });

    const entry = await input.mapOnce(row, file);

    expect(entry?.['gen_ai.response.id']).toBe('resp-id-xyz');
    expect(entry?.['agent.request_id']).toBe('resp-id-xyz');
  });

  it('omits gen_ai.response.finish_reasons and gen_ai.response.id when stop_reason/request_id missing', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    const row = makeModelResponse({ seq: 1 });
    delete (row.data as Record<string, unknown>).stop_reason;
    delete (row as Record<string, unknown>).request_id;

    const entry = await input.mapOnce(row, file);

    expect(entry?.['gen_ai.response.finish_reasons']).toBeUndefined();
    expect(entry?.['gen_ai.response.id']).toBeUndefined();
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

  // --- Fix A: paired llm.request + top-level step.id/turn.id ---

  it('emits llm.request for model.request.started with startNanos from record.ts', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();
    const row = makeModelRequestStarted({
      requestId: 'req-1',
      turnId: 'turn-1',
      seq: 7,
      requestIndex: 3,
    });

    const entry = await input.mapOnce(row, file);

    expect(entry).not.toBeNull();
    expect(entry?.['event.name']).toBe('llm.request');
    expect(entry?.['gen_ai.request.model']).toBe('auto');
    expect(entry?.['gen_ai.response.model']).toBeUndefined();
    expect(entry?.['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(entry?.['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(entry?.['gen_ai.turn.id']).toBe('turn-1');
    expect(entry?.['gen_ai.step.id']).toBe('turn-1:s3');
    expect(entry?.['agent.qoder.type']).toBe('model.request.started');
    expect(entry?.time_unix_nano).toBe('1777659871533000000');
  });

  it('pairs model.request.started + model.response.completed into llm.request + llm.response with matching step.id', async () => {
    const file = await writeSegmentFile('cwd-a', 'session-a', 'a.jsonl', []);
    const input = makeInput();
    await input.baselineOnce();

    await fs.appendFile(file, `${JSON.stringify(makeModelRequestStarted({
      requestId: 'req-pair',
      turnId: 'turn-pair',
      seq: 5,
      requestIndex: 2,
      ts: '2026-08-28T11:25:42.331+08:00',
    }))}\n`);
    await fs.appendFile(file, `${JSON.stringify(makeModelResponse({
      requestId: 'req-pair',
      turnId: 'turn-pair',
      seq: 6,
      requestIndex: 2,
      ts: '2026-08-28T11:25:54.000+08:00',
      inputTokens: 22030,
      outputTokens: 163,
    }))}\n`);

    const entries = await input.collectOnce();

    expect(entries).toHaveLength(2);
    const request = entries.find(e => e['event.name'] === 'llm.request');
    const response = entries.find(e => e['event.name'] === 'llm.response');
    expect(request).toBeDefined();
    expect(response).toBeDefined();
    expect(request?.['gen_ai.step.id']).toBe('turn-pair:s2');
    expect(response?.['gen_ai.step.id']).toBe('turn-pair:s2');
    expect(request?.['gen_ai.turn.id']).toBe('turn-pair');
    expect(response?.['gen_ai.turn.id']).toBe('turn-pair');
    expect(request?.time_unix_nano).toBe('1787887542331000000');
    expect(response?.time_unix_nano).toBe('1787887554000000000');
    expect(response?.['gen_ai.usage.input_tokens']).toBe(22030);
    expect(response?.['gen_ai.usage.output_tokens']).toBe(163);
    expect(request?.['gen_ai.usage.input_tokens']).toBeUndefined();
  });

  it('still emits llm.response when model.request.started is missing (backward compatible)', async () => {
    const file = await writeSegmentFile('cwd-a', 'session-a', 'a.jsonl', []);
    const input = makeInput();
    await input.baselineOnce();

    await fs.appendFile(file, `${JSON.stringify(makeModelResponse({
      requestId: 'lone-response',
      turnId: 'turn-lone',
      seq: 1,
      requestIndex: 0,
    }))}\n`);

    const entries = await input.collectOnce();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.['event.name']).toBe('llm.response');
    expect(entries[0]?.['gen_ai.turn.id']).toBe('turn-lone');
    expect(entries[0]?.['gen_ai.step.id']).toBe('turn-lone:s0');
  });

  it('produces gen_ai.step.id matching the groupByStep round extraction regex :s(\\d+)$', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    const cases: Array<{ turnId: string; requestIndex: number; expected: string }> = [
      { turnId: '96866b2d935cf', requestIndex: 21, expected: '96866b2d935cf:s21' },
      { turnId: 'aa9fce91-9296-4964-9ab4-ce5eda305af7', requestIndex: 1, expected: 'aa9fce91-9296-4964-9ab4-ce5eda305af7:s1' },
      { turnId: 'turn-0', requestIndex: 0, expected: 'turn-0:s0' },
    ];

    for (const { turnId, requestIndex, expected } of cases) {
      const row = makeModelRequestStarted({
        requestId: `req-${requestIndex}`,
        turnId,
        requestIndex,
        seq: requestIndex,
      });
      const entry = await input.mapOnce(row, file);
      expect(entry?.['gen_ai.step.id']).toBe(expected);
      expect(/:s(\d+)$/.test(entry?.['gen_ai.step.id'] ?? '')).toBe(true);
    }
  });

  it('omits gen_ai.step.id when turn_id or request_index is missing', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    const noTurn = makeModelRequestStarted({ requestId: 'r1', seq: 1, requestIndex: 1 });
    delete (noTurn as Record<string, unknown>).turn_id;
    const noIndex = makeModelRequestStarted({ requestId: 'r2', turnId: 'turn-x', seq: 2 });
    delete (noIndex.data as Record<string, unknown>).request_index;

    const entryNoTurn = await input.mapOnce(noTurn, file);
    const entryNoIndex = await input.mapOnce(noIndex, file);

    expect(entryNoTurn?.['gen_ai.step.id']).toBeUndefined();
    expect(entryNoTurn?.['gen_ai.turn.id']).toBeUndefined();
    expect(entryNoIndex?.['gen_ai.step.id']).toBeUndefined();
    expect(entryNoIndex?.['gen_ai.turn.id']).toBe('turn-x');
  });

  it('maps the remaining terminal vendor stop_reasons onto the enum', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    // stop_sequence and refusal both end the turn, so they must land on a
    // terminal enum value rather than being dropped: otlp-trace-flusher keys its
    // turn-completion signal off finish_reasons, and an absent one leaves the
    // turn buffer open until a later heuristic closes it.
    for (const [vendor, expected] of [['stop_sequence', 'stop'], ['refusal', 'stop']]) {
      const row = makeModelResponse({ requestId: `req-${vendor}`, seq: 1 });
      (row.data as Record<string, unknown>).stop_reason = vendor;

      const entry = await input.mapOnce(row, file);

      expect(entry?.['gen_ai.response.finish_reasons']).toEqual([expected]);
      expect(entry?.['agent.stop_reason']).toBe(vendor);
    }
  });

  it('passes cancelled through because the trace validator and flusher both accept it', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    const row = makeModelResponse({ requestId: 'req-cancelled', seq: 1 });
    (row.data as Record<string, unknown>).stop_reason = 'cancelled';

    const entry = await input.mapOnce(row, file);

    // Coercing this to `stop` would still satisfy the validator but would lose
    // the interruption, which is the one thing a cancelled turn records.
    expect(entry?.['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
  });

  it('omits finish_reasons for mid-turn stop_reasons while keeping the raw value', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    // pause_turn means the model will resume, so mapping it to any member of
    // TERMINAL_FINISH_REASONS would flush the turn early and split one turn into
    // two traces. An absent finish reason is only a validator warning.
    for (const reason of ['pause_turn', 'some_future_reason']) {
      const row = makeModelResponse({ requestId: `req-${reason}`, seq: 1 });
      (row.data as Record<string, unknown>).stop_reason = reason;

      const entry = await input.mapOnce(row, file);

      expect(entry?.['gen_ai.response.finish_reasons']).toBeUndefined();
      expect(entry?.['agent.stop_reason']).toBe(reason);
    }
  });

  it('accepts a canonical decimal string request_index', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    // request_index arrives from Qoder's own JSON, so its runtime type is not
    // ours to guarantee across builds. This is drift defence, not a reproduced
    // failure: today's segments write it as a JSON number.
    for (const raw of ['0', '2', '21']) {
      const row = makeModelRequestStarted({ requestId: `req-${raw}`, turnId: 'turn-s', seq: 1 });
      (row.data as Record<string, unknown>).request_index = raw;

      const entry = await input.mapOnce(row, file);

      expect(entry?.['gen_ai.step.id']).toBe(`turn-s:s${raw}`);
    }
  });

  it('omits gen_ai.step.id for request_index spellings outside the canonical form', async () => {
    const file = path.join(tmpDir, 'cwd-a', 'session-a', 'segments', 'a.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const input = makeInput();

    // A tolerant Number() would accept all of these. Padded and exponential
    // spellings are dropped so one logical step cannot arrive under two step ids;
    // fractional and negative values are dropped because the converter's
    // :s(\d+)$ readers would not match the id they produce.
    const rejected: unknown[] = [' 2 ', '2.0', '2e0', '+2', '02', '', 'abc', 1.5, -1, NaN, null, {}];

    for (const [i, raw] of rejected.entries()) {
      const row = makeModelRequestStarted({ requestId: `req-bad-${i}`, turnId: 'turn-s', seq: 1 });
      (row.data as Record<string, unknown>).request_index = raw;

      const entry = await input.mapOnce(row, file);

      // turn.id still lands: only the step dimension is unknown.
      expect(entry?.['gen_ai.step.id'], `request_index=${JSON.stringify(raw)}`).toBeUndefined();
      expect(entry?.['gen_ai.turn.id']).toBe('turn-s');
    }
  });

  it('keeps its finish-reason allowlist equal to the trace validator\'s', () => {
    // The collector must not depend on scripts/validate-trace.mjs at runtime, so
    // the set is duplicated. This asserts the duplicate cannot drift: an allowlist
    // narrower than the validator's silently drops valid finish reasons, and a
    // wider one emits values the validator rejects.
    expect([...VALID_FINISH_REASONS].sort()).toEqual([...VALIDATOR_FINISH_REASONS].sort());
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

// Fixture derived from researcher attachment p0-evidence.json (issue AGE-1730,
// thread comment 3351def6): raw segment event for problem span at 11:25:42.
// Shape: { ts, seq, level, type, turn_id, loop_id, request_id, data:{...} }.
function makeModelResponse(overrides: {
  requestId?: string;
  turnId?: string;
  loopId?: string;
  seq?: number;
  requestIndex?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  ts?: string | number;
} = {}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    request_index: overrides.requestIndex ?? 1,
    model: 'auto',
    stop_reason: 'end_turn',
    content_block_count: 2,
    input_tokens: overrides.inputTokens ?? 10,
    output_tokens: overrides.outputTokens ?? 2,
    cache_read_input_tokens: overrides.cacheReadTokens ?? 3,
    cache_creation_input_tokens: overrides.cacheWriteTokens ?? 0,
  };
  return {
    ts: overrides.ts ?? 1_777_659_871_533,
    seq: overrides.seq ?? 1,
    level: 'info',
    type: 'model.response.completed',
    turn_id: overrides.turnId ?? 'turn-1',
    loop_id: overrides.loopId ?? 'turn-1:1',
    request_id: overrides.requestId ?? 'request-1',
    data,
  };
}

// model.request.started segment event — same shape as model.response.completed
// but emitted at request start, so token counts are absent.
function makeModelRequestStarted(overrides: {
  requestId?: string;
  turnId?: string;
  loopId?: string;
  seq?: number;
  requestIndex?: number;
  ts?: string | number;
} = {}): Record<string, unknown> {
  return {
    ts: overrides.ts ?? 1_777_659_871_533,
    seq: overrides.seq ?? 1,
    level: 'info',
    type: 'model.request.started',
    turn_id: overrides.turnId ?? 'turn-1',
    loop_id: overrides.loopId ?? 'turn-1:1',
    request_id: overrides.requestId ?? 'request-1',
    data: {
      request_index: overrides.requestIndex ?? 1,
      model: 'auto',
    },
  };
}
