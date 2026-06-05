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

  function buildSdkLogLine(sessionId: string, inputTokens: number, outputTokens: number): string {
    const ts = new Date().toISOString();
    return `[${ts}] [INFO] [SDK] [QueryHandler] Received message: stream_event {"event":{"delta":{"stop_reason":"end_turn"},"type":"message_delta","usage":{"input_tokens":${inputTokens},"output_tokens":${outputTokens}}},"session_id":"${sessionId}","type":"stream_event","uuid":"uuid-1"}`;
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

  it('enriches first llm.response with tokens from SDK log', async () => {
    const sessionId = 'sess-token-test';
    const hookFile = path.join(hookLogDir, todayFileName());
    const resp1 = buildHookEntry({ 'event.id': 'r1', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1' });
    const resp2 = buildHookEntry({ 'event.id': 'r2', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1', 'gen_ai.step.id': 'turn-1:s2' });
    await fs.writeFile(hookFile, [JSON.stringify(resp1), JSON.stringify(resp2)].join('\n') + '\n');

    // Write SDK log with token data
    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    await fs.writeFile(sdkFile, buildSdkLogLine(sessionId, 5000, 200) + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    expect(responses.length).toBe(2);
    expect(responses[0]['gen_ai.usage.input_tokens']).toBe(5000);
    expect(responses[0]['gen_ai.usage.output_tokens']).toBe(200);
    expect(responses[0]['gen_ai.usage.total_tokens']).toBe(5200);
    expect(responses[1]['gen_ai.usage.input_tokens']).toBe(0);
    expect(responses[1]['gen_ai.usage.output_tokens']).toBe(0);
    expect(responses[1]['gen_ai.usage.total_tokens']).toBe(0);
  });

  it('handles SDK log inode rotation', async () => {
    const sessionId = 'sess-rotate';
    const hookFile = path.join(hookLogDir, todayFileName());
    const resp = buildHookEntry({ 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1' });
    await fs.writeFile(hookFile, JSON.stringify(resp) + '\n');

    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    await fs.writeFile(sdkFile, buildSdkLogLine(sessionId, 1000, 50) + '\n');

    const input = makeInput();
    const batch1 = await startAndCollect(input);
    expect(batch1[0]['gen_ai.usage.input_tokens']).toBe(1000);

    // Simulate rotation: delete and recreate with new content
    await fs.rm(sdkFile);
    await fs.writeFile(sdkFile, buildSdkLogLine(sessionId, 2000, 100) + '\n');

    // Write new hook entry
    const resp2 = buildHookEntry({ 'event.id': 'r2', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-2' });
    await fs.appendFile(hookFile, JSON.stringify(resp2) + '\n');

    const batch2 = await triggerCycle(input);
    const responses2 = batch2.filter(e => e['event.name'] === 'llm.response');
    expect(responses2[0]['gen_ai.usage.input_tokens']).toBe(2000);
    await input.stop();
  });

  it('aggregates tokens across multi-step turn (tool_use scenario)', async () => {
    const sessionId = 'sess-multi-step';
    const hookFile = path.join(hookLogDir, todayFileName());
    // Turn 1: 2 steps (step 1 = tool_use, step 2 = text response)
    const resp1 = buildHookEntry({ 'event.id': 'r1', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1', 'gen_ai.step.id': 'turn-1:s1' });
    const resp2 = buildHookEntry({ 'event.id': 'r2', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-1', 'gen_ai.step.id': 'turn-1:s2' });
    // Turn 2: 1 step
    const resp3 = buildHookEntry({ 'event.id': 'r3', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'turn-2', 'gen_ai.step.id': 'turn-2:s1' });
    await fs.writeFile(hookFile, [JSON.stringify(resp1), JSON.stringify(resp2), JSON.stringify(resp3)].join('\n') + '\n');

    // SDK log: 3 message_delta events (one per LLM call / step)
    const sessionDir = path.join(sdkLogDir, '202606041000');
    await fs.mkdir(sessionDir, { recursive: true });
    const sdkFile = path.join(sessionDir, 'main.log');
    await fs.writeFile(sdkFile, [
      buildSdkLogLine(sessionId, 1000, 50),
      buildSdkLogLine(sessionId, 2000, 100),
      buildSdkLogLine(sessionId, 3000, 150),
    ].join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const turn1Responses = entries.filter(e => e['gen_ai.turn.id'] === 'turn-1' && e['event.name'] === 'llm.response');
    const turn2Responses = entries.filter(e => e['gen_ai.turn.id'] === 'turn-2' && e['event.name'] === 'llm.response');

    // Turn 1 first response: aggregated tokens from both steps (1000+2000, 50+100)
    expect(turn1Responses[0]['gen_ai.usage.input_tokens']).toBe(3000);
    expect(turn1Responses[0]['gen_ai.usage.output_tokens']).toBe(150);
    expect(turn1Responses[0]['gen_ai.usage.total_tokens']).toBe(3150);
    // Turn 1 second response: zeroed
    expect(turn1Responses[1]['gen_ai.usage.input_tokens']).toBe(0);
    expect(turn1Responses[1]['gen_ai.usage.output_tokens']).toBe(0);
    expect(turn1Responses[1]['gen_ai.usage.total_tokens']).toBe(0);

    // Turn 2 response: gets its own token (3000, 150), NOT leaked from turn 1
    expect(turn2Responses[0]['gen_ai.usage.input_tokens']).toBe(3000);
    expect(turn2Responses[0]['gen_ai.usage.output_tokens']).toBe(150);
    expect(turn2Responses[0]['gen_ai.usage.total_tokens']).toBe(3150);
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
