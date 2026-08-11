import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderWorkTraceInput } from '../../../src/inputs/qoder-work-log/qoder-work-trace-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

describe('QoderWorkTraceInput (CN variant)', () => {
  let tmpRoot: string;
  let logsDir: string;
  let logFile: string;
  let dbDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-work-trace-test-'));
    logsDir = path.join(tmpRoot, 'logs');
    dbDir = path.join(tmpRoot, 'data');
    const sessionDir = path.join(logsDir, '2026-05-14T10-00-00', 'main');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(dbDir, { recursive: true });
    logFile = path.join(sessionDir, 'sdk-001.log');
    await fs.writeFile(logFile, '', 'utf-8');
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function makeInput(): QoderWorkTraceInput {
    return new QoderWorkTraceInput({
      stateStore: stateStore as any,
      dataRoot: tmpRoot,
      agentType: ClientType.QoderWorkCN,
      pollIntervalMs: 60_000,
    });
  }

  function seedOffset(offset: number): void {
    stateStore.setOffset(`qoder-work-cn-trace:${logFile}`, offset);
  }

  async function collectOnce(input: QoderWorkTraceInput): Promise<AgentActivityEntry[]> {
    const captured: AgentActivityEntry[] = [];
    input.on('entries', (batch: AgentActivityEntry[]) => captured.push(...batch));
    await input.start();
    await input.stop();
    return captured;
  }

  it('has correct identity', () => {
    const input = makeInput();
    expect(input.id).toBe('qoder-work-cn-trace');
    expect(input.agentType).toBe(ClientType.QoderWorkCN);
  });

  it('emits span tree with BigInt nanosecond timestamps', async () => {
    const startMs = 1717950000123;
    const endMs = 1717950005456;
    const lines = buildFullSessionLines({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      startMs,
      endMs,
      stopReason: 'end_turn',
      inputTokens: 100,
      outputTokens: 20,
      text: 'hello world',
    });
    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const entries = await collectOnce(makeInput());
    expect(entries.length).toBeGreaterThan(0);

    // parseSdkLogLine uses Date.parse on the ISO string (without Z suffix),
    // so the round-tripped ms value may differ from the original due to
    // timezone handling. Verify the nanos are 6 zeros + ms digits (BigInt format).
    const entryRequest = entries.find(
      e => e['event.name'] === 'other',
    );
    expect(entryRequest).toBeDefined();
    expect(entryRequest!['gen_ai.step.id']?.toString()).toMatch(/:s1$/);
    const startNano = entryRequest!.time_unix_nano;
    expect(startNano).toMatch(/^\d{16,}$/);
    // Verify it ends with 000000 (BigInt ms×1_000_000n always does)
    expect(startNano.endsWith('000000')).toBe(true);

    const stepResponse = entries.find(
      e => e['event.name'] === 'llm.response' && e['gen_ai.step.id'],
    );
    expect(stepResponse).toBeDefined();
    const endNano = stepResponse!.time_unix_nano;
    expect(endNano).toMatch(/^\d{16,}$/);
    expect(endNano.endsWith('000000')).toBe(true);
    expect(BigInt(endNano)).toBeGreaterThan(BigInt(startNano));
  });

  it('caps tool.result timestamp at next step boundary', async () => {
    const step1Start = 1000;
    const step1End = 5000;
    const step2Start = 3000; // overlaps with step1's tool endTs
    const step2End = 7000;

    const lines = buildTwoTurnSession({
      sessionId: 'sess-overlap',
      turn1: {
        messageId: 'msg-1', startMs: step1Start, endMs: step1End,
        stopReason: 'tool_use', inputTokens: 50, outputTokens: 10,
        toolUse: { id: 'tc-1', name: 'Read', argsJson: '{"path":"/tmp"}' },
      },
      turn2: {
        messageId: 'msg-2', startMs: step2Start, endMs: step2End,
        stopReason: 'end_turn', inputTokens: 80, outputTokens: 15,
      },
    });
    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const entries = await collectOnce(makeInput());

    const toolResult = entries.find(e => e['event.name'] === 'tool.result');
    expect(toolResult).toBeDefined();

    const step2Request = entries.find(
      e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.toString().endsWith(':s2'),
    );
    expect(step2Request).toBeDefined();

    const toolResultNano = BigInt(toolResult!.time_unix_nano);
    const step2StartNano = BigInt(step2Request!.time_unix_nano);
    expect(toolResultNano).toBeLessThan(step2StartNano);
  });

  it('includes tool results in input.messages_delta for subsequent steps', async () => {
    const lines = buildTwoTurnSession({
      sessionId: 'sess-toolmsg',
      turn1: {
        messageId: 'msg-1', startMs: 1000, endMs: 2000,
        stopReason: 'tool_use', inputTokens: 50, outputTokens: 10,
        text: 'Let me read that file.',
        toolUse: { id: 'tc-1', name: 'Read', argsJson: '{"path":"/tmp/x.txt"}' },
        postToolUse: { toolUseId: 'tc-1', toolName: 'Read', toolResponse: 'file contents here' },
      },
      turn2: {
        messageId: 'msg-2', startMs: 3000, endMs: 4000,
        stopReason: 'end_turn', inputTokens: 80, outputTokens: 15,
      },
    });
    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const entries = await collectOnce(makeInput());

    const step2Request = entries.find(
      e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.toString().endsWith(':s2'),
    );
    expect(step2Request).toBeDefined();

    const inputMessages = step2Request!['gen_ai.input.messages_delta'] as Array<Record<string, unknown>>;
    expect(inputMessages).toBeDefined();
    expect(inputMessages.length).toBeGreaterThan(0);

    const toolMsg = inputMessages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const parts = toolMsg!.parts as Array<Record<string, unknown>>;
    const toolResponsePart = parts.find(p => p.type === 'tool_call_response');
    expect(toolResponsePart).toBeDefined();
    expect(toolResponsePart!.id).toBe('tc-1');
    expect(toolResponsePart!.response).toBe('file contents here');
  });

  it('emits correct token counts on llm.response spans', async () => {
    const lines = buildFullSessionLines({
      sessionId: 'sess-tokens',
      messageId: 'msg-tokens',
      startMs: 1000,
      endMs: 2000,
      stopReason: 'end_turn',
      inputTokens: 1234,
      outputTokens: 567,
      text: 'done',
    });
    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const entries = await collectOnce(makeInput());

    const stepResponse = entries.find(
      e => e['event.name'] === 'llm.response' && e['gen_ai.step.id'],
    );
    expect(stepResponse).toBeDefined();
    expect(stepResponse!['gen_ai.usage.input_tokens']).toBe(1234);
    expect(stepResponse!['gen_ai.usage.output_tokens']).toBe(567);
    expect(stepResponse!['gen_ai.usage.total_tokens']).toBe(1801);
  });

  it('emits later result windows in the same session with distinct turn ids', async () => {
    const firstLines = buildFullSessionLines({
      sessionId: 'sess-repeat',
      messageId: 'msg-first',
      startMs: 1000,
      endMs: 2000,
      stopReason: 'end_turn',
      inputTokens: 10,
      outputTokens: 2,
      text: 'first',
    });
    await fs.appendFile(logFile, firstLines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const first = await collectOnce(makeInput());
    expect(first.length).toBeGreaterThan(0);
    const firstTurnId = first.find(e => e['gen_ai.turn.id'])?.['gen_ai.turn.id'];
    expect(firstTurnId).toBe('sess-repeat:t1');

    const secondLines = buildFullSessionLines({
      sessionId: 'sess-repeat',
      messageId: 'msg-second',
      startMs: 3000,
      endMs: 4000,
      stopReason: 'end_turn',
      inputTokens: 20,
      outputTokens: 4,
      text: 'second',
    });
    await fs.appendFile(logFile, secondLines.join('\n') + '\n', 'utf-8');

    const second = await collectOnce(makeInput());
    expect(second.length).toBeGreaterThan(0);
    const secondTurnId = second.find(e => e['gen_ai.turn.id'])?.['gen_ai.turn.id'];
    expect(secondTurnId).toBe('sess-repeat:t2');
    expect(secondTurnId).not.toBe(firstTurnId);
  });

  it('resolves model from set_model_policy', async () => {
    const lines: string[] = [];
    lines.push(sdkLine(1000, 'INFO', 'system', {
      subtype: 'init', session_id: 'sess-model',
      model: 'Premium', cwd: '/tmp', agents: [], tools: [],
    }));
    lines.push(sendingPolicyLine(1000, 'claude-sonnet-4-20250514'));
    lines.push(...turnLines('sess-model', 'msg-model', 1500, 2000, 'end_turn', 100, 20));
    lines.push(resultLine(2500, 'sess-model'));

    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const entries = await collectOnce(makeInput());

    const stepResponse = entries.find(
      e => e['event.name'] === 'llm.response' && e['gen_ai.step.id'],
    );
    expect(stepResponse).toBeDefined();
    expect(stepResponse!['gen_ai.response.model']).toBe('claude-sonnet-4-20250514');
  });

  it('emits tool.call and tool.result spans for tool_use', async () => {
    const lines = buildFullSessionLines({
      sessionId: 'sess-tool',
      messageId: 'msg-tool',
      startMs: 1000,
      endMs: 3000,
      stopReason: 'tool_use',
      inputTokens: 100,
      outputTokens: 20,
      toolUse: { id: 'tc-abc', name: 'Bash', argsJson: '{"command":"ls"}' },
    });
    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const entries = await collectOnce(makeInput());

    const toolCall = entries.find(e => e['event.name'] === 'tool.call');
    expect(toolCall).toBeDefined();
    expect(toolCall!['gen_ai.tool.name']).toBe('Bash');
    expect(toolCall!['gen_ai.tool.call.id']).toBe('tc-abc');
    expect(toolCall!['gen_ai.tool.call.arguments']).toEqual({ command: 'ls' });

    const toolResult = entries.find(e => e['event.name'] === 'tool.result');
    expect(toolResult).toBeDefined();
    expect(toolResult!['gen_ai.tool.name']).toBe('Bash');
    expect(toolResult!['gen_ai.tool.call.id']).toBe('tc-abc');
  });

  it('collects multiple tool_use blocks in a single turn', async () => {
    const ts = 1000;
    const lines: string[] = [];
    lines.push(sdkLine(ts, 'INFO', 'system', {
      subtype: 'init', session_id: 'sess-multi',
      model: 'Premium', cwd: '/tmp', agents: [], tools: [],
    }));
    lines.push(sdkLine(ts + 100, 'INFO', 'stream_event', {
      session_id: 'sess-multi',
      event: { type: 'message_start', message: { id: 'msg-multi' } },
    }));
    // Tool A
    lines.push(sdkLine(ts + 200, 'INFO', 'stream_event', {
      session_id: 'sess-multi',
      event: {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'tc-A', name: 'Read' },
      },
    }));
    lines.push(sdkLine(ts + 300, 'INFO', 'stream_event', {
      session_id: 'sess-multi',
      event: {
        type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"/a"}' },
      },
    }));
    // Tool B
    lines.push(sdkLine(ts + 400, 'INFO', 'stream_event', {
      session_id: 'sess-multi',
      event: {
        type: 'content_block_start', index: 1,
        content_block: { type: 'tool_use', id: 'tc-B', name: 'Write' },
      },
    }));
    lines.push(sdkLine(ts + 500, 'INFO', 'stream_event', {
      session_id: 'sess-multi',
      event: {
        type: 'content_block_delta', index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"path":"/b"}' },
      },
    }));
    lines.push(sdkLine(ts + 600, 'INFO', 'stream_event', {
      session_id: 'sess-multi',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    }));
    lines.push(sdkLine(ts + 700, 'INFO', 'stream_event', {
      session_id: 'sess-multi',
      event: { type: 'message_stop' },
    }));
    lines.push(resultLine(ts + 800, 'sess-multi'));

    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const entries = await collectOnce(makeInput());

    const toolCalls = entries.filter(e => e['event.name'] === 'tool.call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]['gen_ai.tool.call.id']).toBe('tc-A');
    expect(toolCalls[0]['gen_ai.tool.name']).toBe('Read');
    expect(toolCalls[1]['gen_ai.tool.call.id']).toBe('tc-B');
    expect(toolCalls[1]['gen_ai.tool.name']).toBe('Write');

    const toolResults = entries.filter(e => e['event.name'] === 'tool.result');
    expect(toolResults).toHaveLength(2);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function msToIso(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '');
}

function sdkLine(ms: number, level: string, msgType: string, payload: unknown): string {
  return `[${msToIso(ms)}] [${level}] [SDK] [QueryHandler] Received message: ${msgType} ${JSON.stringify(payload)}`;
}

function sendingPolicyLine(ms: number, chatModel: string, compactModel = 'auto'): string {
  const payload = {
    requestId: 'rq-1',
    request: {
      type: 'control_request',
      request_id: 'rq-1',
      request: {
        subtype: 'set_model_policy',
        scene: 'qwork',
        chat: { model: chatModel },
        compact: { model: compactModel },
        scene_model: { model: compactModel },
      },
    },
  };
  return `[${msToIso(ms)}] [INFO] [SDK] [QueryHandler] Sending control request: set_model_policy ${JSON.stringify(payload)}`;
}

function resultLine(ms: number, sessionId: string): string {
  return sdkLine(ms, 'INFO', 'result', {
    session_id: sessionId,
    subtype: 'success',
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    context_usage_ratio: 0,
  });
}

function turnLines(
  sessionId: string,
  messageId: string,
  startMs: number,
  endMs: number,
  stopReason: string,
  inputTokens: number,
  outputTokens: number,
  opts?: {
    text?: string;
    thinking?: string;
    toolUse?: { id: string; name: string; argsJson: string };
  },
): string[] {
  const lines: string[] = [];
  lines.push(sdkLine(startMs, 'INFO', 'stream_event', {
    session_id: sessionId,
    event: { type: 'message_start', message: { id: messageId } },
  }));

  let blockIndex = 0;
  if (opts?.thinking) {
    lines.push(sdkLine(startMs + 10, 'INFO', 'stream_event', {
      session_id: sessionId,
      event: { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking' } },
    }));
    lines.push(sdkLine(startMs + 20, 'INFO', 'stream_event', {
      session_id: sessionId,
      event: { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: opts.thinking } },
    }));
    blockIndex++;
  }

  if (opts?.text) {
    lines.push(sdkLine(startMs + 30, 'INFO', 'stream_event', {
      session_id: sessionId,
      event: { type: 'content_block_start', index: blockIndex, content_block: { type: 'text' } },
    }));
    lines.push(sdkLine(startMs + 40, 'INFO', 'stream_event', {
      session_id: sessionId,
      event: { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: opts.text } },
    }));
    blockIndex++;
  }

  if (opts?.toolUse) {
    lines.push(sdkLine(startMs + 50, 'INFO', 'stream_event', {
      session_id: sessionId,
      event: {
        type: 'content_block_start', index: blockIndex,
        content_block: { type: 'tool_use', id: opts.toolUse.id, name: opts.toolUse.name },
      },
    }));
    lines.push(sdkLine(startMs + 60, 'INFO', 'stream_event', {
      session_id: sessionId,
      event: {
        type: 'content_block_delta', index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: opts.toolUse.argsJson },
      },
    }));
    blockIndex++;
  }

  lines.push(sdkLine(endMs - 10, 'INFO', 'stream_event', {
    session_id: sessionId,
    event: {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  }));
  lines.push(sdkLine(endMs, 'INFO', 'stream_event', {
    session_id: sessionId,
    event: { type: 'message_stop' },
  }));

  return lines;
}

function buildFullSessionLines(opts: {
  sessionId: string;
  messageId: string;
  startMs: number;
  endMs: number;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  text?: string;
  thinking?: string;
  toolUse?: { id: string; name: string; argsJson: string };
}): string[] {
  const lines: string[] = [];
  lines.push(sdkLine(opts.startMs - 100, 'INFO', 'system', {
    subtype: 'init', session_id: opts.sessionId,
    model: 'Premium', cwd: '/tmp', agents: [], tools: [],
  }));
  lines.push(...turnLines(
    opts.sessionId, opts.messageId, opts.startMs, opts.endMs,
    opts.stopReason, opts.inputTokens, opts.outputTokens,
    { text: opts.text, thinking: opts.thinking, toolUse: opts.toolUse },
  ));
  lines.push(resultLine(opts.endMs + 100, opts.sessionId));
  return lines;
}

function postToolUseLine(ms: number, sessionId: string, toolUseId: string, toolName: string, toolResponse: string): string {
  const payload = {
    requestId: 'rq-ptu',
    request: {
      type: 'control_request',
      request_id: 'rq-ptu',
      input: {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        tool_use_id: toolUseId,
        tool_name: toolName,
        tool_response: toolResponse,
        transcript_path: '/tmp/transcript.jsonl',
      },
    },
  };
  return sdkLine(ms, 'INFO', 'control_request', payload);
}

function buildTwoTurnSession(opts: {
  sessionId: string;
  turn1: {
    messageId: string; startMs: number; endMs: number;
    stopReason: string; inputTokens: number; outputTokens: number;
    text?: string; toolUse?: { id: string; name: string; argsJson: string };
    postToolUse?: { toolUseId: string; toolName: string; toolResponse: string };
  };
  turn2: {
    messageId: string; startMs: number; endMs: number;
    stopReason: string; inputTokens: number; outputTokens: number;
    text?: string; toolUse?: { id: string; name: string; argsJson: string };
    postToolUse?: { toolUseId: string; toolName: string; toolResponse: string };
  };
}): string[] {
  const lines: string[] = [];
  lines.push(sdkLine(opts.turn1.startMs - 100, 'INFO', 'system', {
    subtype: 'init', session_id: opts.sessionId,
    model: 'Premium', cwd: '/tmp', agents: [], tools: [],
  }));
  lines.push(...turnLines(
    opts.sessionId, opts.turn1.messageId, opts.turn1.startMs, opts.turn1.endMs,
    opts.turn1.stopReason, opts.turn1.inputTokens, opts.turn1.outputTokens,
    { text: opts.turn1.text, toolUse: opts.turn1.toolUse },
  ));
  if (opts.turn1.postToolUse) {
    lines.push(postToolUseLine(
      opts.turn1.endMs + 10, opts.sessionId,
      opts.turn1.postToolUse.toolUseId, opts.turn1.postToolUse.toolName, opts.turn1.postToolUse.toolResponse,
    ));
  }
  lines.push(...turnLines(
    opts.sessionId, opts.turn2.messageId, opts.turn2.startMs, opts.turn2.endMs,
    opts.turn2.stopReason, opts.turn2.inputTokens, opts.turn2.outputTokens,
    { text: opts.turn2.text, toolUse: opts.turn2.toolUse },
  ));
  if (opts.turn2.postToolUse) {
    lines.push(postToolUseLine(
      opts.turn2.endMs + 10, opts.sessionId,
      opts.turn2.postToolUse.toolUseId, opts.turn2.postToolUse.toolName, opts.turn2.postToolUse.toolResponse,
    ));
  }
  lines.push(resultLine(opts.turn2.endMs + 100, opts.sessionId));
  return lines;
}
