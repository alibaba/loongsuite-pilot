import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  let segmentsRoot: string;
  let sdkLogDir: string;
  let stateStore: MockStateStore;

  const TEST_CWD = '/Users/test/.qoderwork/workspace/wsabc';
  const TEST_CWD_ENCODED = '-Users-test--qoderwork-workspace-wsabc';

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-work-trace-test-'));
    hookLogDir = path.join(tmpRoot, 'hook-history');
    segmentsRoot = path.join(tmpRoot, 'sessions');
    sdkLogDir = path.join(tmpRoot, 'sdk-logs');
    await fs.mkdir(hookLogDir, { recursive: true });
    await fs.mkdir(segmentsRoot, { recursive: true });
    await fs.mkdir(sdkLogDir, { recursive: true });
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function makeInput() {
    return new QoderWorkTraceInput({
      stateStore: stateStore as any,
      logDir: hookLogDir,
      segmentsRoot,
      sdkLogDir,
    });
  }

  async function writeSegments(sessionId: string, runFile: string, lines: object[]) {
    const segDir = path.join(segmentsRoot, TEST_CWD_ENCODED, sessionId, 'segments');
    await fs.mkdir(segDir, { recursive: true });
    const filePath = path.join(segDir, runFile);
    await fs.writeFile(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return filePath;
  }

  async function writeSdkLog(sessionDir: string, lines: string[]) {
    const dir = path.join(sdkLogDir, sessionDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'main.log'), lines.join('\n') + '\n');
  }

  function segTurnStarted(turnId: string, isSubagent = false, ts = '2026-06-16T10:00:00.000Z') {
    return { ts, type: 'turn.started', turn_id: turnId, data: { is_subagent: isSubagent } };
  }
  function segModelStart(turnId: string, requestId: string, ts: string, model = 'qwork-ultimate') {
    return { ts, type: 'model.request.started', turn_id: turnId, request_id: requestId, data: { model } };
  }
  function segModelEnd(
    turnId: string,
    requestId: string,
    ts: string,
    model = 'qwork-ultimate',
    usage: Record<string, number> = {},
  ) {
    return { ts, type: 'model.response.completed', turn_id: turnId, request_id: requestId, data: { model, ...usage } };
  }
  function segToolRequested(turnId: string, toolCallId: string, ts: string, toolName = 'TodoWrite') {
    return { ts, type: 'tool.requested', turn_id: turnId, tool_call_id: toolCallId, data: { tool_name: toolName, args: {} } };
  }
  function segToolFinished(turnId: string, toolCallId: string, ts: string, toolName = 'TodoWrite') {
    return { ts, type: 'tool.execution.finished', turn_id: turnId, tool_call_id: toolCallId, data: { tool_name: toolName, status: 'success' } };
  }
  function nano(iso: string) {
    return String(BigInt(Date.parse(iso)) * 1_000_000n);
  }

  function sdkMessageStart(sessionId: string, messageId: string, iso: string) {
    return `[${iso}] [INFO] [SDK] [QueryHandler] Received message: stream_event ${JSON.stringify({
      event: { type: 'message_start', message: { id: messageId } }, session_id: sessionId,
    })}`;
  }

  function sdkMessageDelta(sessionId: string, iso: string, inputTokens: number, outputTokens: number) {
    return `[${iso}] [INFO] [SDK] [QueryHandler] Received message: stream_event ${JSON.stringify({
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
      session_id: sessionId,
    })}`;
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
      'agent.qoderwork.cwd': TEST_CWD,
      time_unix_nano: '1780000000000000000',
      ...overrides,
    } as AgentActivityEntry;
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

  it('on first run emits only the last historical turn and checkpoints the whole file', async () => {
    const hookFile = path.join(hookLogDir, todayFileName());
    const oldRequest = buildHookEntry({
      'event.id': 'old-request',
      'event.name': 'llm.request' as any,
      'gen_ai.turn.id': 'turn-old',
      'gen_ai.step.id': 'turn-old:s1',
    });
    const oldResponse = buildHookEntry({
      'event.id': 'old-response',
      'gen_ai.turn.id': 'turn-old',
      'gen_ai.step.id': 'turn-old:s1',
    });
    const latestRequest = buildHookEntry({
      'event.id': 'latest-request',
      'event.name': 'llm.request' as any,
      'gen_ai.turn.id': 'turn-latest',
      'gen_ai.step.id': 'turn-latest:s1',
    });
    const latestResponse = buildHookEntry({
      'event.id': 'latest-response',
      'gen_ai.turn.id': 'turn-latest',
      'gen_ai.step.id': 'turn-latest:s1',
    });
    const initialText = [oldRequest, oldResponse, latestRequest, latestResponse]
      .map(entry => JSON.stringify(entry))
      .join('\n') + '\n';
    await fs.writeFile(hookFile, initialText);

    const input = makeInput();
    const initialEntries = await startAndCollect(input);

    expect(initialEntries.map(entry => entry['event.id'])).toEqual([
      'latest-request',
      'latest-response',
    ]);
    expect(stateStore.get('qoder-work-trace').lastOffset).toBe(Buffer.byteLength(initialText));
    expect(stateStore.get('qoder-work-trace').extra).toMatchObject({ qoderWorkTurnCount: 2 });

    const nextResponse = buildHookEntry({
      'event.id': 'next-response',
      'gen_ai.turn.id': 'turn-next',
      'gen_ai.step.id': 'turn-next:s1',
    });
    await fs.appendFile(hookFile, JSON.stringify(nextResponse) + '\n');

    const nextEntries = await triggerCycle(input);
    await input.stop();

    expect(nextEntries.map(entry => entry['event.id'])).toEqual(['next-response']);
  });

  it('on first run emits the only turn', async () => {
    const hookFile = path.join(hookLogDir, todayFileName());
    const onlyEntry = buildHookEntry({
      'event.id': 'only-response',
      'gen_ai.turn.id': 'turn-only',
      'gen_ai.step.id': 'turn-only:s1',
    });
    await fs.writeFile(hookFile, JSON.stringify(onlyEntry) + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    expect(entries.map(entry => entry['event.id'])).toEqual(['only-response']);
    expect(stateStore.get('qoder-work-trace').extra).toMatchObject({ qoderWorkTurnCount: 1 });
  });

  it('streams a large first-run history and exports only its last turn', async () => {
    const hookFile = path.join(hookLogDir, todayFileName());
    const oldEntry = {
      ...buildHookEntry({ 'event.id': 'large-old', 'gen_ai.turn.id': 'turn-old' }),
      'agent.qoderwork.padding': 'x'.repeat(17 * 1024 * 1024),
    };
    const latestEntry = buildHookEntry({ 'event.id': 'large-latest', 'gen_ai.turn.id': 'turn-latest' });
    const text = `${JSON.stringify(oldEntry)}\n${JSON.stringify(latestEntry)}\n`;
    await fs.writeFile(hookFile, text);

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    expect(entries.map(entry => entry['event.id'])).toEqual(['large-latest']);
    expect(stateStore.get('qoder-work-trace').lastOffset).toBe(Buffer.byteLength(text));
  });

  it('caps tool.result to not exceed next step llm.request', async () => {
    // Step 1 has a long-running tool whose result ts overshoots step 2's
    // llm.request. The clamp prevents STEP spans from overlapping.
    const sessionId = 'sess-cap';
    const turnId = 'turn-cap';
    const hookFile = path.join(hookLogDir, todayFileName());

    const step1Req = buildHookEntry({
      'event.id': 's1-req',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      time_unix_nano: '1000000000000000000', // t=1000s
    });
    const step1Resp = buildHookEntry({
      'event.id': 's1-resp',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      time_unix_nano: '1010000000000000000', // t=1010s
    });
    const step1Tool = buildHookEntry({
      'event.id': 's1-tool',
      'event.name': 'tool.result' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      time_unix_nano: '1500000000000000000', // t=1500s (overshoots s2)
    });
    const step2Req = buildHookEntry({
      'event.id': 's2-req',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s2`,
      time_unix_nano: '1200000000000000000', // t=1200s
    });
    const step2Resp = buildHookEntry({
      'event.id': 's2-resp',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s2`,
      time_unix_nano: '1210000000000000000',
    });

    await fs.writeFile(hookFile, [
      JSON.stringify(step1Req),
      JSON.stringify(step1Resp),
      JSON.stringify(step1Tool),
      JSON.stringify(step2Req),
      JSON.stringify(step2Resp),
    ].join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const clamped = entries.find(e => e['event.id'] === 's1-tool');
    expect(clamped).toBeDefined();
    // tool.result ts must be clamped to just before step 2's llm.request (1200s - 1ms)
    expect(clamped!.time_unix_nano).toBe('1199999999999000000');
    // Non-tool entries stay untouched
    expect(entries.find(e => e['event.id'] === 's1-resp')!.time_unix_nano).toBe('1010000000000000000');
    expect(entries.find(e => e['event.id'] === 's2-req')!.time_unix_nano).toBe('1200000000000000000');
  });

  it('assigns unique trace_id per turn group', async () => {
    const hookFile = path.join(hookLogDir, todayFileName());
    const e1 = buildHookEntry({ 'event.id': 'e1', 'gen_ai.turn.id': 'turn-A' });
    const e2 = buildHookEntry({ 'event.id': 'e2', 'gen_ai.turn.id': 'turn-A' });
    const e3 = buildHookEntry({ 'event.id': 'e3', 'gen_ai.turn.id': 'turn-B' });
    await fs.writeFile(hookFile, [JSON.stringify(e1), JSON.stringify(e2), JSON.stringify(e3)].join('\n') + '\n');
    stateStore.set('qoder-work-trace', { extra: { qoderWorkTurnCount: 1 } });

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    expect(entries.length).toBe(3);
    const traceA = entries[0].trace_id;
    expect(entries[1].trace_id).toBe(traceA);
    expect(entries[2].trace_id).not.toBe(traceA);
  });

  it('overrides llm.request/response time and model from segments', async () => {
    const sessionId = 'sess-seg';
    const hookFile = path.join(hookLogDir, todayFileName());

    const req = buildHookEntry({
      'event.id': 'req',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'hook-turn-1',
      'gen_ai.step.id': 'hook-turn-1:s1',
      'gen_ai.request.model': 'auto',
      time_unix_nano: '1000000000000000000',
    });
    const resp = buildHookEntry({
      'event.id': 'resp',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'hook-turn-1',
      'gen_ai.step.id': 'hook-turn-1:s1',
      'gen_ai.request.model': 'auto',
      time_unix_nano: '1000010000000000000',
    });
    await fs.writeFile(hookFile, [JSON.stringify(req), JSON.stringify(resp)].join('\n') + '\n');

    // Segment: main turn, one LLM pair from 2026-06-16T10:00:00.000Z to 10:00:05.000Z
    await writeSegments(sessionId, 'run1.jsonl', [
      segTurnStarted('hook-turn-1', false),
      segModelStart('hook-turn-1', 'req-X', '2026-06-16T10:00:00.000Z', 'qwork-ultimate'),
      segModelEnd('hook-turn-1', 'req-X', '2026-06-16T10:00:05.000Z', 'qwork-ultimate'),
    ]);

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const startNano = String(BigInt(Date.parse('2026-06-16T10:00:00.000Z')) * 1_000_000n);
    const endNano = String(BigInt(Date.parse('2026-06-16T10:00:05.000Z')) * 1_000_000n);

    const reqOut = entries.find(e => e['event.id'] === 'req')!;
    const respOut = entries.find(e => e['event.id'] === 'resp')!;
    expect(reqOut.time_unix_nano).toBe(startNano);
    expect(respOut.time_unix_nano).toBe(endNano);
    expect(reqOut['gen_ai.request.model']).toBe('qwork-ultimate');
    expect(respOut['gen_ai.request.model']).toBe('qwork-ultimate');
    expect(respOut['gen_ai.response.model']).toBe('qwork-ultimate');
  });

  it('enriches response usage from a matched segment pair', async () => {
    const sessionId = 'sess-segment-usage';
    const turnId = 'turn-segment-usage';
    const hookFile = path.join(hookLogDir, todayFileName());
    const request = buildHookEntry({
      'event.id': 'usage-request',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
    });
    const response = buildHookEntry({
      'event.id': 'usage-response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
    });
    await fs.writeFile(hookFile, [request, response].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await writeSegments(sessionId, 'usage.jsonl', [
      segModelStart(turnId, 'usage-request-id', '2026-06-16T10:00:00.000Z'),
      segModelEnd(turnId, 'usage-request-id', '2026-06-16T10:00:05.000Z', 'qwork-ultimate', {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
      }),
    ]);

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const enriched = entries.find(entry => entry['event.id'] === 'usage-response')!;
    expect(enriched['gen_ai.usage.input_tokens']).toBe(120);
    expect(enriched['gen_ai.usage.output_tokens']).toBe(30);
    expect(enriched['gen_ai.usage.total_tokens']).toBe(150);
    expect(enriched['gen_ai.usage.cache_read.input_tokens']).toBe(50);
    expect(enriched['gen_ai.usage.cache_creation.input_tokens']).toBe(10);
  });

  it('uses SDK token data only when the matched segment has no usage', async () => {
    const sessionId = 'sess-sdk-usage';
    const turnId = 'turn-sdk-usage';
    const hookFile = path.join(hookLogDir, todayFileName());
    const request = buildHookEntry({
      'event.id': 'sdk-request',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      time_unix_nano: nano('2026-06-16T10:00:00.000Z'),
    });
    const response = buildHookEntry({
      'event.id': 'sdk-response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      time_unix_nano: nano('2026-06-16T10:00:05.000Z'),
    });
    await fs.writeFile(hookFile, [request, response].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await writeSdkLog('sdk-session', [
      sdkMessageStart(sessionId, 'sdk-message-1', '2026-06-16T10:00:00.000Z'),
      sdkMessageDelta(sessionId, '2026-06-16T10:00:05.000Z', 321, 45),
    ]);

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const enriched = entries.find(entry => entry['event.id'] === 'sdk-response')!;
    expect(enriched['gen_ai.usage.input_tokens']).toBe(321);
    expect(enriched['gen_ai.usage.output_tokens']).toBe(45);
    expect(enriched['gen_ai.usage.total_tokens']).toBe(366);
    expect(enriched.time_unix_nano).toBe(nano('2026-06-16T10:00:05.000Z'));
  });

  it('falls back to locating segment directories by session id', async () => {
    const sessionId = 'sess-segment-directory-fallback';
    const turnId = 'turn-segment-directory-fallback';
    const hookFile = path.join(hookLogDir, todayFileName());
    const request = buildHookEntry({
      'event.id': 'fallback-request',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
    });
    const response = buildHookEntry({
      'event.id': 'fallback-response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
    });
    await fs.writeFile(hookFile, [request, response].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const fallbackDir = path.join(segmentsRoot, 'writer-format-changed', sessionId, 'segments');
    await fs.mkdir(fallbackDir, { recursive: true });
    await fs.writeFile(path.join(fallbackDir, 'fallback.jsonl'), [
      segModelStart(turnId, 'fallback-request-id', '2026-06-16T10:00:00.000Z'),
      segModelEnd(turnId, 'fallback-request-id', '2026-06-16T10:00:05.000Z', 'qwork-fallback'),
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    expect(entries.find(entry => entry['event.id'] === 'fallback-response')?.['gen_ai.response.model'])
      .toBe('qwork-fallback');
  });

  it('evicts stale segment state even when no later hook entries arrive', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T10:00:00.000Z'));
    const sessionId = 'sess-stale-segment';
    const turnId = 'turn-stale-segment';
    const hookFile = path.join(hookLogDir, todayFileName());
    const toolCall = buildHookEntry({
      'event.id': 'stale-tool-call',
      'event.name': 'tool.call' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      'gen_ai.tool.call.id': 'stale-tool',
    });
    await fs.writeFile(hookFile, JSON.stringify(toolCall) + '\n');
    await writeSegments(sessionId, 'stale.jsonl', [
      segTurnStarted('stale-subagent', true),
      segModelStart(turnId, 'stale-request', '2026-06-16T10:00:00.000Z'),
      segModelEnd(turnId, 'stale-request', '2026-06-16T10:00:01.000Z'),
      segToolRequested(turnId, 'stale-tool', '2026-06-16T10:00:00.100Z'),
    ]);

    const input = makeInput();
    await startAndCollect(input);
    expect((input as any).segmentPairs.size).toBe(1);
    expect((input as any).subagentTurns.size).toBe(1);

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    await triggerCycle(input);
    await input.stop();

    expect((input as any).segmentPairs.size).toBe(0);
    expect((input as any).segmentToolTimings.size).toBe(0);
    expect((input as any).subagentTurns.size).toBe(0);
    expect((input as any).inFlightPairs.size).toBe(0);
  });

  it('skips subagent LLM pairs when matching to hook steps', async () => {
    const sessionId = 'sess-sub';
    const hookFile = path.join(hookLogDir, todayFileName());

    const req = buildHookEntry({
      'event.id': 'req',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'hook-turn-1',
      'gen_ai.step.id': 'hook-turn-1:s1',
      time_unix_nano: '1000000000000000000',
    });
    const resp = buildHookEntry({
      'event.id': 'resp',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'hook-turn-1',
      'gen_ai.step.id': 'hook-turn-1:s1',
      time_unix_nano: '1000010000000000000',
    });
    await fs.writeFile(hookFile, [JSON.stringify(req), JSON.stringify(resp)].join('\n') + '\n');

    // Segments: subagent LLM (should be ignored) THEN main LLM
    await writeSegments(sessionId, 'run1.jsonl', [
      segTurnStarted('sub-turn', true),
      segModelStart('sub-turn', 'sub-req', '2026-06-16T09:00:00.000Z', 'qwork-fast'),
      segModelEnd('sub-turn', 'sub-req', '2026-06-16T09:00:01.000Z', 'qwork-fast'),
      segTurnStarted('hook-turn-1', false),
      segModelStart('hook-turn-1', 'main-req', '2026-06-16T10:00:00.000Z', 'qwork-ultimate'),
      segModelEnd('hook-turn-1', 'main-req', '2026-06-16T10:00:05.000Z', 'qwork-ultimate'),
    ]);

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const respOut = entries.find(e => e['event.id'] === 'resp')!;
    // Should consume the MAIN turn pair, not the subagent one
    expect(respOut['gen_ai.response.model']).toBe('qwork-ultimate');
    expect(respOut.time_unix_nano).toBe(String(BigInt(Date.parse('2026-06-16T10:00:05.000Z')) * 1_000_000n));
  });

  it('matches multiple hook steps to multiple segment pairs in FIFO order', async () => {
    const sessionId = 'sess-multi';
    const turnId = 'hook-turn-multi';
    const hookFile = path.join(hookLogDir, todayFileName());

    const lines: AgentActivityEntry[] = [];
    for (let i = 1; i <= 3; i++) {
      lines.push(buildHookEntry({
        'event.id': `s${i}-req`,
        'event.name': 'llm.request' as any,
        'gen_ai.session.id': sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': `${turnId}:s${i}`,
        time_unix_nano: '1000000000000000000',
      }));
      lines.push(buildHookEntry({
        'event.id': `s${i}-resp`,
        'event.name': 'llm.response',
        'gen_ai.session.id': sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': `${turnId}:s${i}`,
        time_unix_nano: '1000010000000000000',
      }));
    }
    await fs.writeFile(hookFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    await writeSegments(sessionId, 'run1.jsonl', [
      segTurnStarted(turnId, false),
      segModelStart(turnId, 'r1', '2026-06-16T10:00:00.000Z'),
      segModelEnd(turnId, 'r1', '2026-06-16T10:00:01.000Z'),
      segModelStart(turnId, 'r2', '2026-06-16T10:00:02.000Z'),
      segModelEnd(turnId, 'r2', '2026-06-16T10:00:03.000Z'),
      segModelStart(turnId, 'r3', '2026-06-16T10:00:04.000Z'),
      segModelEnd(turnId, 'r3', '2026-06-16T10:00:05.000Z'),
    ]);

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const s1Resp = entries.find(e => e['event.id'] === 's1-resp')!;
    const s2Resp = entries.find(e => e['event.id'] === 's2-resp')!;
    const s3Resp = entries.find(e => e['event.id'] === 's3-resp')!;
    expect(s1Resp.time_unix_nano).toBe(String(BigInt(Date.parse('2026-06-16T10:00:01.000Z')) * 1_000_000n));
    expect(s2Resp.time_unix_nano).toBe(String(BigInt(Date.parse('2026-06-16T10:00:03.000Z')) * 1_000_000n));
    expect(s3Resp.time_unix_nano).toBe(String(BigInt(Date.parse('2026-06-16T10:00:05.000Z')) * 1_000_000n));
  });

  it('matches segment timing by turn id and uses segment tool timing without consuming background pairs', async () => {
    const sessionId = 'sess-background-pair';
    const turnId = 'prompt-real-turn';
    const toolCallId = 'tool-call-real';
    const hookFile = path.join(hookLogDir, todayFileName());

    const step1Req = buildHookEntry({
      'event.id': 's1-req',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      'agent.qoderwork.promptId': turnId,
      time_unix_nano: nano('2026-06-18T02:37:42.905Z'),
    });
    const step1Resp = buildHookEntry({
      'event.id': 's1-resp',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      'agent.qoderwork.promptId': turnId,
      time_unix_nano: nano('2026-06-18T02:38:05.180Z'),
    });
    const step1ToolCall = buildHookEntry({
      'event.id': 's1-tool-call',
      'event.name': 'tool.call' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      'gen_ai.tool.call.id': toolCallId,
      'agent.qoderwork.promptId': turnId,
      time_unix_nano: nano('2026-06-18T02:38:05.180Z'),
    });
    const step1ToolResult = buildHookEntry({
      'event.id': 's1-tool-result',
      'event.name': 'tool.result' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      'gen_ai.tool.call.id': toolCallId,
      'agent.qoderwork.promptId': turnId,
      time_unix_nano: nano('2026-06-18T02:38:06.722Z'),
    });
    const step2Req = buildHookEntry({
      'event.id': 's2-req',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s2`,
      'agent.qoderwork.promptId': turnId,
      time_unix_nano: nano('2026-06-18T02:38:06.722Z'),
    });
    const step2Resp = buildHookEntry({
      'event.id': 's2-resp',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s2`,
      'agent.qoderwork.promptId': turnId,
      time_unix_nano: nano('2026-06-18T02:38:11.107Z'),
    });

    await fs.writeFile(hookFile, [
      step1Req,
      step1Resp,
      step1ToolCall,
      step1ToolResult,
      step2Req,
      step2Resp,
    ].map(l => JSON.stringify(l)).join('\n') + '\n');

    await writeSegments(sessionId, 'run1.jsonl', [
      segModelStart('qoderwork-memory-sink-fork-qoderwork-memory-sink', 'memory-1', '2026-06-18T09:39:42.866+08:00'),
      segModelEnd('qoderwork-memory-sink-fork-qoderwork-memory-sink', 'memory-1', '2026-06-18T09:39:50.736+08:00'),
      segModelStart(turnId, 'real-1', '2026-06-18T10:37:43.032+08:00'),
      segToolRequested(turnId, toolCallId, '2026-06-18T10:38:05.093+08:00'),
      segModelEnd(turnId, 'real-1', '2026-06-18T10:38:05.168+08:00'),
      segToolFinished(turnId, toolCallId, '2026-06-18T10:38:06.616+08:00'),
      segModelStart(turnId, 'real-2', '2026-06-18T10:38:06.840+08:00'),
      segModelEnd(turnId, 'real-2', '2026-06-18T10:38:11.107+08:00'),
    ]);

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    expect(entries.find(e => e['event.id'] === 's1-req')!.time_unix_nano).toBe(nano('2026-06-18T10:37:43.032+08:00'));
    expect(entries.find(e => e['event.id'] === 's1-resp')!.time_unix_nano).toBe(nano('2026-06-18T10:38:05.168+08:00'));
    expect(entries.find(e => e['event.id'] === 's1-tool-call')!.time_unix_nano).toBe(nano('2026-06-18T10:38:05.093+08:00'));
    expect(entries.find(e => e['event.id'] === 's1-tool-result')!.time_unix_nano).toBe(nano('2026-06-18T10:38:06.616+08:00'));
    expect(entries.find(e => e['event.id'] === 's2-req')!.time_unix_nano).toBe(nano('2026-06-18T10:38:06.840+08:00'));
    expect(entries.find(e => e['event.id'] === 's2-resp')!.time_unix_nano).toBe(nano('2026-06-18T10:38:11.107+08:00'));
  });

  it('retains segment tool timing when tool.call and tool.result arrive in separate batches', async () => {
    const sessionId = 'sess-split-tool';
    const turnId = 'prompt-split-tool';
    const toolCallId = 'tool-call-split';
    const hookFile = path.join(hookLogDir, todayFileName());

    const req = buildHookEntry({
      'event.id': 'req',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      time_unix_nano: nano('2026-06-18T02:00:00.000Z'),
    });
    const resp = buildHookEntry({
      'event.id': 'resp',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      time_unix_nano: nano('2026-06-18T02:00:05.000Z'),
    });
    const toolCall = buildHookEntry({
      'event.id': 'tool-call',
      'event.name': 'tool.call' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      'gen_ai.tool.call.id': toolCallId,
      time_unix_nano: nano('2026-06-18T02:00:05.100Z'),
    });
    const toolResult = buildHookEntry({
      'event.id': 'tool-result',
      'event.name': 'tool.result' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': `${turnId}:s1`,
      'gen_ai.tool.call.id': toolCallId,
      time_unix_nano: nano('2026-06-18T02:00:06.900Z'),
    });

    await fs.writeFile(hookFile, [req, resp, toolCall].map(l => JSON.stringify(l)).join('\n') + '\n');
    await writeSegments(sessionId, 'run1.jsonl', [
      segModelStart(turnId, 'r1', '2026-06-18T10:00:00.000+08:00'),
      segToolRequested(turnId, toolCallId, '2026-06-18T10:00:05.050+08:00'),
      segModelEnd(turnId, 'r1', '2026-06-18T10:00:05.200+08:00'),
      segToolFinished(turnId, toolCallId, '2026-06-18T10:00:06.700+08:00'),
    ]);

    const input = makeInput();
    const firstBatch = await startAndCollect(input);
    expect(firstBatch.find(e => e['event.id'] === 'tool-call')!.time_unix_nano).toBe(nano('2026-06-18T10:00:05.050+08:00'));

    await fs.appendFile(hookFile, JSON.stringify(toolResult) + '\n');
    const secondBatch = await triggerCycle(input);
    await input.stop();

    expect(secondBatch.find(e => e['event.id'] === 'tool-result')!.time_unix_nano).toBe(nano('2026-06-18T10:00:06.700+08:00'));
  });

  it('keeps hook timing when segments are unavailable', async () => {
    const sessionId = 'sess-no-seg';
    const hookFile = path.join(hookLogDir, todayFileName());
    const req = buildHookEntry({
      'event.id': 'req',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-x',
      'gen_ai.step.id': 'turn-x:s1',
      time_unix_nano: '1700000000000000000',
    });
    const resp = buildHookEntry({
      'event.id': 'resp',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-x',
      'gen_ai.step.id': 'turn-x:s1',
      time_unix_nano: '1700001000000000000',
    });
    await fs.writeFile(hookFile, [JSON.stringify(req), JSON.stringify(resp)].join('\n') + '\n');

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const reqOut = entries.find(e => e['event.id'] === 'req')!;
    const respOut = entries.find(e => e['event.id'] === 'resp')!;
    expect(reqOut.time_unix_nano).toBe('1700000000000000000');
    expect(respOut.time_unix_nano).toBe('1700001000000000000');
  });

  it('keeps hook tool.call timestamp when segments have no tool.requested event', async () => {
    const sessionId = 'sess-tc';
    const hookFile = path.join(hookLogDir, todayFileName());

    const req = buildHookEntry({
      'event.id': 'req',
      'event.name': 'llm.request' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-tc',
      'gen_ai.step.id': 'turn-tc:s1',
      time_unix_nano: '1000000000000000000',
    });
    const resp = buildHookEntry({
      'event.id': 'resp',
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-tc',
      'gen_ai.step.id': 'turn-tc:s1',
      time_unix_nano: '1000010000000000000',
    });
    const toolCall = buildHookEntry({
      'event.id': 'tc',
      'event.name': 'tool.call' as any,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': 'turn-tc',
      'gen_ai.step.id': 'turn-tc:s1',
      time_unix_nano: '999999999999000000',
    });
    await fs.writeFile(hookFile, [JSON.stringify(req), JSON.stringify(resp), JSON.stringify(toolCall)].join('\n') + '\n');

    await writeSegments(sessionId, 'run1.jsonl', [
      segTurnStarted('turn-tc', false),
      segModelStart('turn-tc', 'r1', '2026-06-16T10:00:00.000Z'),
      segModelEnd('turn-tc', 'r1', '2026-06-16T10:00:05.000Z'),
    ]);

    const input = makeInput();
    const entries = await startAndCollect(input);
    await input.stop();

    const tcOut = entries.find(e => e['event.id'] === 'tc')!;
    expect(tcOut.time_unix_nano).toBe('999999999999000000');
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
  const result = await input['collect']();
  if (result && result.length > 0) {
    entries.push(...result);
  }
  input.off('entries', handler);
  return entries;
}
