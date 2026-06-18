import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CollectionMethod, ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderWorkTraceInput } from '../../../src/inputs/qoder-work-trace/qoder-work-trace-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

describe('QoderWorkTraceInput', () => {
  let tmpRoot: string;
  let hookLogDir: string;
  let sdkLogDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-work-trace-test-'));
    hookLogDir = path.join(tmpRoot, 'hook-history');
    sdkLogDir = path.join(tmpRoot, 'sdk-logs');
    await fs.mkdir(hookLogDir, { recursive: true });
    await fs.mkdir(sdkLogDir, { recursive: true });
    stateStore = new MockStateStore();
    sdkLineCounter = 0;
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function makeInput() {
    return new QoderWorkTraceInput({
      stateStore: stateStore as any,
      logDir: hookLogDir,
      sdkLogDir,
    });
  }

  function todayFileName() {
    const d = new Date();
    return `qoder-work-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
  }

  function buildHookEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
    return {
      'event.id': 'test-id',
      'event.name': 'llm.response',
      'gen_ai.session.id': 'sess-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'turn-1:s1',
      'gen_ai.agent.type': ClientType.QoderWork,
      'gen_ai.output.messages': '[{"role":"assistant","parts":[{"type":"reasoning","content":"thinking"},{"type":"text","content":"hello"}]}]',
      'agent.source': 'qoder-transcript-hook',
      time_unix_nano: '1780000000000000000',
      ...overrides,
    } as AgentActivityEntry;
  }

  let sdkLineCounter = 0;

  function buildSdkMessageStartLine(sessionId: string, messageId: string, ts?: string): string {
    const timestamp = ts ?? new Date(Date.now() + sdkLineCounter * 1000).toISOString();
    sdkLineCounter++;
    return `[${timestamp}] [INFO] [SDK] [QueryHandler] Received message: stream_event {"event":{"message":{"id":"${messageId}"},"type":"message_start"},"session_id":"${sessionId}","type":"stream_event","uuid":"uuid-${sdkLineCounter}"}`;
  }

  function buildSdkMessageDeltaLine(sessionId: string, inputTokens: number, outputTokens: number, ts?: string): string {
    const timestamp = ts ?? new Date(Date.now() + sdkLineCounter * 1000).toISOString();
    sdkLineCounter++;
    return `[${timestamp}] [INFO] [SDK] [QueryHandler] Received message: stream_event {"event":{"delta":{"stop_reason":"end_turn"},"type":"message_delta","usage":{"input_tokens":${inputTokens},"output_tokens":${outputTokens}}},"session_id":"${sessionId}","type":"stream_event","uuid":"uuid-${sdkLineCounter}"}`;
  }

  function buildSdkModelPolicyLine(chatModel: string, ts?: string): string {
    const timestamp = ts ?? new Date(Date.now() + sdkLineCounter * 1000).toISOString();
    sdkLineCounter++;
    return `[${timestamp}] [INFO] [SDK] [QueryHandler] Sending control request: set_model_policy {"requestId":"rq-1","request":{"type":"control","request_id":"rq-1","request":{"subtype":"set_model_policy","chat":{"model":"${chatModel}"},"compact":{"model":"auto"},"scene_model":{"model":"auto"}}}}`;
  }

  // 生成一对 message_start + message_delta 行
  function buildSdkMessagePair(sessionId: string, messageId: string, inputTokens: number, outputTokens: number, startTs?: string, endTs?: string): string[] {
    return [
      buildSdkMessageStartLine(sessionId, messageId, startTs),
      buildSdkMessageDeltaLine(sessionId, inputTokens, outputTokens, endTs),
    ];
  }

  it('has correct identity', () => {
    const input = makeInput();
    expect(input.id).toBe('qoder-work-trace');
    expect(input.agentType).toBe(ClientType.QoderWork);
    expect(input.collectionMethod).toBe(CollectionMethod.HookJsonl);
  });

  it('reads hook JSONL and injects trace_id', async () => {
    const hookFile = path.join(hookLogDir, todayFileName());
    const entry = buildHookEntry();
    await fs.writeFile(hookFile, JSON.stringify(entry) + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    expect(entries.length).toBe(1);
    expect(entries[0].trace_id).toBeDefined();
    expect((entries[0].trace_id as string).length).toBe(32);
  });

  it('resumes from offset on second poll', async () => {
    const hookFile = path.join(hookLogDir, todayFileName());
    const entry1 = buildHookEntry({ 'event.id': 'e1', 'gen_ai.turn.id': 'turn-1' });
    await fs.writeFile(hookFile, JSON.stringify(entry1) + '\n');

    const input = makeInput();
    const batch1 = await startAndCollect(input);
    expect(batch1.length).toBe(1);

    const entry2 = buildHookEntry({ 'event.id': 'e2', 'gen_ai.turn.id': 'turn-2' });
    await fs.appendFile(hookFile, JSON.stringify(entry2) + '\n');

    const batch2 = await triggerCycle(input);
    expect(batch2.length).toBe(1);
    expect(batch2[0]['event.id']).toBe('e2');
    await input.stop();
  });

  it('enriches each step llm.response with its own tokens from SDK log', async () => {
    const sessionId = 'sess-token-test';
    const hookFile = path.join(hookLogDir, todayFileName());
    const resp1 = buildHookEntry({ 'event.id': 'r1', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1', 'gen_ai.step.id': 'turn-1:s1' });
    const resp2 = buildHookEntry({ 'event.id': 'r2', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1', 'gen_ai.step.id': 'turn-1:s2' });
    await fs.writeFile(hookFile, [JSON.stringify(resp1), JSON.stringify(resp2)].join('\n') + '\n');

    // SDK log: 2 message pairs for 2 steps
    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    const lines = [
      ...buildSdkMessagePair(sessionId, 'msg-1', 5000, 200),
      ...buildSdkMessagePair(sessionId, 'msg-2', 3000, 100),
    ];
    await fs.writeFile(sdkFile, lines.join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    expect(responses.length).toBe(2);
    // Step 1 gets first SDK message
    expect(responses[0]['gen_ai.usage.input_tokens']).toBe(5000);
    expect(responses[0]['gen_ai.usage.output_tokens']).toBe(200);
    expect(responses[0]['gen_ai.usage.total_tokens']).toBe(5200);
    // Step 2 gets second SDK message
    expect(responses[1]['gen_ai.usage.input_tokens']).toBe(3000);
    expect(responses[1]['gen_ai.usage.output_tokens']).toBe(100);
    expect(responses[1]['gen_ai.usage.total_tokens']).toBe(3100);
  });

  it('handles SDK log inode rotation', async () => {
    const sessionId = 'sess-rotate';
    const hookFile = path.join(hookLogDir, todayFileName());
    const resp = buildHookEntry({ 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1' });
    await fs.writeFile(hookFile, JSON.stringify(resp) + '\n');

    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    const lines1 = buildSdkMessagePair(sessionId, 'msg-r1', 1000, 50);
    await fs.writeFile(sdkFile, lines1.join('\n') + '\n');

    const input = makeInput();
    const batch1 = await startAndCollect(input);
    expect(batch1[0]['gen_ai.usage.input_tokens']).toBe(1000);

    // Simulate rotation: rename old file first then create new one.
    // Keep old file alive during creation to prevent inode reuse on Linux.
    const oldSdkFile = sdkFile + '.old';
    await fs.rename(sdkFile, oldSdkFile);
    const lines2 = buildSdkMessagePair(sessionId, 'msg-r2', 2000, 100);
    await fs.writeFile(sdkFile, lines2.join('\n') + '\n');
    await fs.rm(oldSdkFile);

    // Write new hook entry
    const resp2 = buildHookEntry({ 'event.id': 'r2', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-2' });
    await fs.appendFile(hookFile, JSON.stringify(resp2) + '\n');

    const batch2 = await triggerCycle(input);
    const responses2 = batch2.filter(e => e['event.name'] === 'llm.response');
    expect(responses2[0]['gen_ai.usage.input_tokens']).toBe(2000);
    await input.stop();
  });

  it('enriches each step independently across multi-step turn (tool_use scenario)', async () => {
    const sessionId = 'sess-multi-step';
    const hookFile = path.join(hookLogDir, todayFileName());
    // Turn 1: 2 steps
    const resp1 = buildHookEntry({ 'event.id': 'r1', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1', 'gen_ai.step.id': 'turn-1:s1' });
    const resp2 = buildHookEntry({ 'event.id': 'r2', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1', 'gen_ai.step.id': 'turn-1:s2' });
    // Turn 2: 1 step
    const resp3 = buildHookEntry({ 'event.id': 'r3', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-2', 'gen_ai.step.id': 'turn-2:s1' });
    await fs.writeFile(hookFile, [JSON.stringify(resp1), JSON.stringify(resp2), JSON.stringify(resp3)].join('\n') + '\n');

    // SDK log: 3 message pairs (one per LLM call / step)
    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    const lines = [
      ...buildSdkMessagePair(sessionId, 'msg-1', 1000, 50),
      ...buildSdkMessagePair(sessionId, 'msg-2', 2000, 100),
      ...buildSdkMessagePair(sessionId, 'msg-3', 3000, 150),
    ];
    await fs.writeFile(sdkFile, lines.join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const turn1Responses = entries.filter(e => e['gen_ai.turn.id'] === 'turn-1' && e['event.name'] === 'llm.response');
    const turn2Responses = entries.filter(e => e['gen_ai.turn.id'] === 'turn-2' && e['event.name'] === 'llm.response');

    // Turn 1, step 1: own tokens
    expect(turn1Responses[0]['gen_ai.usage.input_tokens']).toBe(1000);
    expect(turn1Responses[0]['gen_ai.usage.output_tokens']).toBe(50);
    expect(turn1Responses[0]['gen_ai.usage.total_tokens']).toBe(1050);
    // Turn 1, step 2: own tokens
    expect(turn1Responses[1]['gen_ai.usage.input_tokens']).toBe(2000);
    expect(turn1Responses[1]['gen_ai.usage.output_tokens']).toBe(100);
    expect(turn1Responses[1]['gen_ai.usage.total_tokens']).toBe(2100);

    // Turn 2: gets its own token, NOT leaked from turn 1
    expect(turn2Responses[0]['gen_ai.usage.input_tokens']).toBe(3000);
    expect(turn2Responses[0]['gen_ai.usage.output_tokens']).toBe(150);
    expect(turn2Responses[0]['gen_ai.usage.total_tokens']).toBe(3150);
  });

  it('persists SDK message buffer across collect() cycles', async () => {
    const sessionId = 'sess-cross-cycle';
    const hookFile = path.join(hookLogDir, todayFileName());

    // Cycle 1: SDK log arrives but no hook JSONL yet
    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    const sdkLines = buildSdkMessagePair(sessionId, 'msg-cc', 4000, 250);
    await fs.writeFile(sdkFile, sdkLines.join('\n') + '\n');

    const input = makeInput();
    const batch1 = await startAndCollect(input);
    expect(batch1.length).toBe(0);

    // Cycle 2: hook JSONL arrives — should find buffered SDK data
    const resp = buildHookEntry({ 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1' });
    await fs.writeFile(hookFile, JSON.stringify(resp) + '\n');

    const batch2 = await triggerCycle(input);
    await input.stop();

    expect(batch2.length).toBe(1);
    expect(batch2[0]['gen_ai.usage.input_tokens']).toBe(4000);
    expect(batch2[0]['gen_ai.usage.output_tokens']).toBe(250);
  });

  it('enriches timing from SDK log message_start/message_delta', async () => {
    const sessionId = 'sess-timing';
    const hookFile = path.join(hookLogDir, todayFileName());

    // Hook entry with request + response in same step
    const request = buildHookEntry({
      'event.id': 'req-1',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'turn-1:s1',
    });
    const response = buildHookEntry({
      'event.id': 'resp-1',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'turn-1:s1',
    });
    await fs.writeFile(hookFile, [JSON.stringify(request), JSON.stringify(response)].join('\n') + '\n');

    // SDK log with precise timestamps
    const startTs = '2026-06-04T10:00:01.000Z';
    const endTs = '2026-06-04T10:00:05.500Z';
    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    const sdkLines = buildSdkMessagePair(sessionId, 'msg-t1', 1000, 50, startTs, endTs);
    await fs.writeFile(sdkFile, sdkLines.join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const req = entries.find(e => e['event.name'] === 'llm.request');
    const resp = entries.find(e => e['event.name'] === 'llm.response');
    // request 时间戳应被覆盖为 message_start 的时间
    expect(req!.time_unix_nano).toBe(String(BigInt(Date.parse(startTs)) * 1_000_000n));
    // response 时间戳应被覆盖为 message_delta 的时间
    expect(resp!.time_unix_nano).toBe(String(BigInt(Date.parse(endTs)) * 1_000_000n));
    // 确保 duration > 0
    expect(BigInt(resp!.time_unix_nano)).toBeGreaterThan(BigInt(req!.time_unix_nano));
  });

  it('enriches model from SDK log set_model_policy', async () => {
    const sessionId = 'sess-model';
    const hookFile = path.join(hookLogDir, todayFileName());
    const resp = buildHookEntry({
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.request.model': 'auto',
    });
    await fs.writeFile(hookFile, JSON.stringify(resp) + '\n');

    // SDK log with model policy
    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    const lines = [
      buildSdkModelPolicyLine('qwork-ultimate'),
      ...buildSdkMessagePair(sessionId, 'msg-m1', 1000, 50),
    ];
    await fs.writeFile(sdkFile, lines.join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    expect(entries[0]['gen_ai.request.model']).toBe('qwork-ultimate');
    expect(entries[0]['gen_ai.response.model']).toBe('qwork-ultimate');
  });

  it('gracefully degrades when SDK log has no message_delta', async () => {
    const sessionId = 'sess-no-delta';
    const hookFile = path.join(hookLogDir, todayFileName());
    const resp = buildHookEntry({
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.request.model': 'auto',
    });
    await fs.writeFile(hookFile, JSON.stringify(resp) + '\n');

    // SDK log with only message_start (no message_delta)
    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    await fs.writeFile(sdkFile, buildSdkMessageStartLine(sessionId, 'msg-orphan') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    // Should not crash; model stays 'auto' since no policy line, tokens undefined
    expect(entries.length).toBe(1);
    expect(entries[0]['gen_ai.request.model']).toBe('auto');
    expect(entries[0]['gen_ai.usage.input_tokens']).toBeUndefined();
  });

  it('isolates model policy per SDK log file', async () => {
    const sessionId = 'sess-iso';
    const hookFile = path.join(hookLogDir, todayFileName());
    const resp = buildHookEntry({
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.request.model': 'auto',
    });
    await fs.writeFile(hookFile, JSON.stringify(resp) + '\n');

    // File 1: sets model to qwork-ultimate
    const sessionDir1 = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir1, { recursive: true });
    const sdkFile1 = path.join(sessionDir1, 'main.log');
    await fs.writeFile(sdkFile1, buildSdkModelPolicyLine('qwork-ultimate') + '\n');

    // File 2: sets different model, has the actual message pair
    const sessionDir2 = path.join(sdkLogDir, '202606041001');
    await fs.mkdir(sessionDir2, { recursive: true });
    const sdkFile2 = path.join(sessionDir2, 'main.log');
    const lines = [
      buildSdkModelPolicyLine('qwork-standard'),
      ...buildSdkMessagePair(sessionId, 'msg-iso', 500, 25),
    ];
    await fs.writeFile(sdkFile2, lines.join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    // The last file processed sets currentModelPolicy, so model should be from file 2
    expect(entries[0]['gen_ai.request.model']).toBe('qwork-standard');
  });

  it('enriches tool.call timestamps with response time', async () => {
    const sessionId = 'sess-tool-ts';
    const hookFile = path.join(hookLogDir, todayFileName());

    const request = buildHookEntry({
      'event.id': 'req-t1',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'turn-1:s1',
    });
    const response = buildHookEntry({
      'event.id': 'resp-t1',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'turn-1:s1',
    });
    const toolCall = buildHookEntry({
      'event.id': 'tc-t1',
      'event.name': 'tool.call' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'turn-1:s1',
    });
    await fs.writeFile(hookFile, [JSON.stringify(request), JSON.stringify(response), JSON.stringify(toolCall)].join('\n') + '\n');

    const endTs = '2026-06-04T10:00:05.500Z';
    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    const sdkLines = buildSdkMessagePair(sessionId, 'msg-tc', 1000, 50, undefined, endTs);
    await fs.writeFile(sdkFile, sdkLines.join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const tc = entries.find(e => e['event.name'] === 'tool.call');
    const resp = entries.find(e => e['event.name'] === 'llm.response');
    expect(tc!.time_unix_nano).toBe(String(BigInt(Date.parse(endTs)) * 1_000_000n));
    expect(tc!.time_unix_nano).toBe(resp!.time_unix_nano);
  });

  it('assigns unique trace_id per turn group', async () => {
    const hookFile = path.join(hookLogDir, todayFileName());
    const e1 = buildHookEntry({ 'event.id': 'e1', 'gen_ai.turn.id': 'turn-A' });
    const e2 = buildHookEntry({ 'event.id': 'e2', 'gen_ai.turn.id': 'turn-A' });
    const e3 = buildHookEntry({ 'event.id': 'e3', 'gen_ai.turn.id': 'turn-B' });
    await fs.writeFile(hookFile, [JSON.stringify(e1), JSON.stringify(e2), JSON.stringify(e3)].join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    expect(entries.length).toBe(3);
    const traceA = entries[0].trace_id;
    expect(entries[1].trace_id).toBe(traceA);
    expect(entries[2].trace_id).not.toBe(traceA);
  });
});

async function startAndCollect(input: any): Promise<AgentActivityEntry[]> {
  const entries: AgentActivityEntry[] = [];
  input.on('entries', (batch: AgentActivityEntry[]) => { entries.push(...batch); });
  await input.start();
  return entries;
}

async function triggerCycle(input: any): Promise<AgentActivityEntry[]> {
  const entries: AgentActivityEntry[] = [];
  const handler = (batch: AgentActivityEntry[]) => { entries.push(...batch); };
  input.on('entries', handler);
  // Access protected collect via bracket notation
  const result = await input['collect']();
  if (result && result.length > 0) {
    entries.push(...result);
  }
  input.off('entries', handler);
  return entries;
}
