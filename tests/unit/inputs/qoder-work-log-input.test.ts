import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CollectionMethod, ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderWorkLogInput } from '../../../src/inputs/qoder-work-log/qoder-work-log-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

describe('QoderWorkLogInput', () => {
  let tmpRoot: string;
  let logsDir: string;
  let logFile: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-work-log-test-'));
    logsDir = path.join(tmpRoot, 'logs');
    const sessionDir = path.join(logsDir, '2026-05-14T10-00-00', 'main');
    await fs.mkdir(sessionDir, { recursive: true });
    logFile = path.join(sessionDir, 'sdk-001.log');
    await fs.writeFile(logFile, '', 'utf-8');
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('has correct identity and collection method', () => {
    const input = makeInput();
    expect(input.id).toBe('qoder-work-log');
    expect(input.agentType).toBe(ClientType.QoderWork);
    expect(input.collectionMethod).toBe(CollectionMethod.SessionFilePolling);
  });

  it('emits one metadata-only llm.response and one tool.call per turn (no content reconstructed)', async () => {
    const lines = buildSdkLogLines({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      tier: 'Standard',
      cwd: '/home/dev/proj',
      thinking: 'analyse user intent',
      text: 'I will read the file.',
      toolUse: { id: 'tool-call-1', name: 'Read', argsJson: '{"path":"/tmp/x.txt"}' },
      stopReason: 'tool_use',
      inputTokens: 1234,
      outputTokens: 56,
    });
    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const entries = await collectOnce(makeInput());

    const llmResponses = entries.filter(e => e['event.name'] === 'llm.response');
    const toolCalls = entries.filter(e => e['event.name'] === 'tool.call');

    // SDK log delta write order is unreliable, so we deliberately emit a
    // single metadata-only llm.response per turn (no thinking/text content).
    expect(llmResponses).toHaveLength(1);
    expect(toolCalls).toHaveLength(1);

    const resp = llmResponses[0];
    expect(resp['gen_ai.output.messages']).toBeUndefined();
    expect(resp['gen_ai.usage.input_tokens']).toBe(1234);
    expect(resp['gen_ai.usage.output_tokens']).toBe(56);
    expect(resp['gen_ai.usage.total_tokens']).toBe(1290);
    expect(resp['gen_ai.session.id']).toBe('sess-1');
    expect(resp['gen_ai.response.id']).toBe('msg-1');
    // No `set_model_policy` in this fixture; tier "Standard" is filtered out
    // by the model fallback (not a valid model key), so falls back to UNKNOWN.
    expect(resp['gen_ai.response.model']).toBe('unknown');
    expect(resp['agent.subscription_tier']).toBe('Standard');
    expect(resp['agent.cwd']).toBe('/home/dev/proj');
    expect(resp['gen_ai.response.finish_reasons']).toEqual(['tool_use']);
    expect(resp['agent.event_kind']).toBe('response');
    expect(resp['agent.tool_use_count']).toBe(1);

    expect(toolCalls[0]['gen_ai.tool.name']).toBe('Read');
    expect(toolCalls[0]['gen_ai.tool.call.id']).toBe('tool-call-1');
    // Arguments are intentionally NOT reconstructed (delta order unreliable).
    expect(toolCalls[0]['gen_ai.tool.call.arguments']).toBeUndefined();
    expect(toolCalls[0]['agent.subscription_tier']).toBe('Standard');
    expect(toolCalls[0]['agent.cwd']).toBe('/home/dev/proj');
  });

  it('skips system_init and message_start lines (no entries before message_delta)', async () => {
    const tsBase = '2026-05-14T10:00:00.000';
    await fs.appendFile(
      logFile,
      [
        sdkLine(tsBase, 'INFO', 'system', { subtype: 'init', session_id: 's', model: 'm', agents: [], tools: [] }),
        sdkLine(tsBase, 'INFO', 'stream_event', {
          session_id: 's',
          event: { type: 'message_start', message: { id: 'mid' } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    seedOffset(0);

    const entries = await collectOnce(makeInput());
    expect(entries).toHaveLength(0);
  });

  it('emits a result summary entry on result event', async () => {
    const ts = '2026-05-14T10:00:05.000';
    await fs.appendFile(
      logFile,
      [
        sdkLine(ts, 'INFO', 'system', { subtype: 'init', session_id: 's2', model: 'm', agents: [], tools: [] }),
        sdkLine(ts, 'INFO', 'result', {
          session_id: 's2',
          subtype: 'success',
          duration_ms: 1500,
          duration_api_ms: 1200,
          num_turns: 1,
          context_usage_ratio: 0.42,
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    seedOffset(0);

    const entries = await collectOnce(makeInput());
    expect(entries).toHaveLength(1);
    expect(entries[0]['event.name']).toBe('other');
    expect(entries[0]['agent.event_kind']).toBe('result');
    expect(entries[0]['agent.duration_ms']).toBe(1500);
    expect(entries[0]['agent.num_turns']).toBe(1);
  });

  it('does not re-emit on subsequent collect when no new lines appended', async () => {
    const lines = buildSdkLogLines({
      sessionId: 'sess-2',
      messageId: 'msg-2',
      text: 'done',
      stopReason: 'end_turn',
      inputTokens: 100,
      outputTokens: 10,
    });
    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const input = makeInput();
    const captured: AgentActivityEntry[] = [];
    input.on('entries', (b: AgentActivityEntry[]) => captured.push(...b));
    await input.start();
    await input.stop();
    expect(captured.length).toBeGreaterThan(0);

    const captured2: AgentActivityEntry[] = [];
    const input2 = makeInput();
    input2.on('entries', (b: AgentActivityEntry[]) => captured2.push(...b));
    await input2.start();
    await input2.stop();
    expect(captured2).toHaveLength(0);
  });

  it('snapshots the most recent set_model_policy.chat.model onto each turn', async () => {
    // Two turns separated by a `Sending control request: set_model_policy`
    // line that switches chat.model from qwork-ultimate to qwork-auto. The
    // first turn must report qwork-ultimate, the second turn qwork-auto, and
    // the trailing `result` summary must reflect the latest policy value.
    const tsBase = '2026-05-14T10:00:00.000';
    const lines: string[] = [];

    lines.push(sdkLine(tsBase, 'INFO', 'system', {
      subtype: 'init',
      session_id: 'sess-policy',
      model: 'Premium',
      cwd: '/tmp',
      agents: [],
      tools: [],
    }));
    lines.push(sendingPolicyLine(tsBase, 'qwork-ultimate'));
    lines.push(...turnLines('sess-policy', 'msg-A', 'end_turn', 100, 20));
    lines.push(sendingPolicyLine(tsBase, 'qwork-auto'));
    lines.push(...turnLines('sess-policy', 'msg-B', 'end_turn', 200, 30));
    lines.push(sdkLine(tsBase, 'INFO', 'result', {
      session_id: 'sess-policy',
      subtype: 'success',
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 2,
      context_usage_ratio: 0,
    }));

    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const entries = await collectOnce(makeInput());
    const responses = entries
      .filter(e => e['event.name'] === 'llm.response')
      .sort((a, b) => String(a['gen_ai.response.id']).localeCompare(String(b['gen_ai.response.id'])));
    expect(responses).toHaveLength(2);
    expect(responses[0]['gen_ai.response.id']).toBe('msg-A');
    expect(responses[0]['gen_ai.response.model']).toBe('qwork-ultimate');
    expect(responses[1]['gen_ai.response.id']).toBe('msg-B');
    expect(responses[1]['gen_ai.response.model']).toBe('qwork-auto');

    const result = entries.find(e => e['agent.event_kind'] === 'result');
    expect(result).toBeDefined();
    expect(result!['gen_ai.response.model']).toBe('qwork-auto');
  });

  it('routes parallel sessions to chat/scene model slots based on subscription tier', async () => {
    // Real QoderWork emits ONE set_model_policy with chat+compact+scene_model
    // slots, then runs main (Premium→chat) and summarizer (Standard→scene)
    // turns concurrently in the same SDK process / log file. The input must
    // pick the correct slot per session, not apply chat.model globally.
    const tsBase = '2026-05-14T10:00:00.000';
    const lines: string[] = [];

    lines.push(sdkLine(tsBase, 'INFO', 'system', {
      subtype: 'init',
      session_id: 'sess-summarizer',
      model: 'Standard',
      cwd: '/',
      agents: [],
      tools: [],
    }));
    lines.push(sdkLine(tsBase, 'INFO', 'system', {
      subtype: 'init',
      session_id: 'sess-main',
      model: 'Premium',
      cwd: '/Users/wsy/.qoderwork/workspace/foo',
      agents: [],
      tools: [],
    }));
    lines.push(sendingPolicyLine(tsBase, 'qwork-ultimate', 'qwork-auto'));
    lines.push(...turnLines('sess-main', 'msg-main', 'end_turn', 100, 20));
    lines.push(...turnLines('sess-summarizer', 'msg-sum', 'end_turn', 50, 5));
    lines.push(sdkLine(tsBase, 'INFO', 'result', {
      session_id: 'sess-main',
      subtype: 'success',
      duration_ms: 0, duration_api_ms: 0, num_turns: 1, context_usage_ratio: 0,
    }));
    lines.push(sdkLine(tsBase, 'INFO', 'result', {
      session_id: 'sess-summarizer',
      subtype: 'success',
      duration_ms: 0, duration_api_ms: 0, num_turns: 1, context_usage_ratio: 0,
    }));

    await fs.appendFile(logFile, lines.join('\n') + '\n', 'utf-8');
    seedOffset(0);

    const entries = await collectOnce(makeInput());
    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    const mainResp = responses.find(e => e['gen_ai.session.id'] === 'sess-main');
    const sumResp = responses.find(e => e['gen_ai.session.id'] === 'sess-summarizer');
    expect(mainResp).toBeDefined();
    expect(sumResp).toBeDefined();
    expect(mainResp!['gen_ai.response.model']).toBe('qwork-ultimate');
    expect(sumResp!['gen_ai.response.model']).toBe('qwork-auto');

    const results = entries.filter(e => e['agent.event_kind'] === 'result');
    const mainResult = results.find(e => e['gen_ai.session.id'] === 'sess-main');
    const sumResult = results.find(e => e['gen_ai.session.id'] === 'sess-summarizer');
    expect(mainResult!['gen_ai.response.model']).toBe('qwork-ultimate');
    expect(sumResult!['gen_ai.response.model']).toBe('qwork-auto');
  });

  function makeInput(): QoderWorkLogInput {
    return new QoderWorkLogInput({
      stateStore: stateStore as any,
      dataRoot: tmpRoot,
      pollIntervalMs: 60_000,
    });
  }

  /**
   * Pre-seed per-file offset so onStart() does not baseline-skip pre-existing
   * log content (the production input intentionally skips historical bytes on
   * first start; tests need to opt-out by writing a known offset first).
   */
  function seedOffset(offset: number): void {
    stateStore.setOffset(`qoder-work-log:${logFile}`, offset);
  }

  describe('QoderWork CN variant (parameterized)', () => {
    it('has CN id and agentType', () => {
      const cnInput = new QoderWorkLogInput({
        stateStore: stateStore as any,
        dataRoot: tmpRoot,
        agentType: ClientType.QoderWorkCN,
        pollIntervalMs: 60_000,
      });
      expect(cnInput.id).toBe('qoder-work-cn-log');
      expect(cnInput.agentType).toBe(ClientType.QoderWorkCN);
    });
  });
});

async function collectOnce(input: QoderWorkLogInput): Promise<AgentActivityEntry[]> {
  const captured: AgentActivityEntry[] = [];
  input.on('entries', (batch: AgentActivityEntry[]) => captured.push(...batch));
  await input.start();
  await input.stop();
  return captured;
}

function sdkLine(ts: string, level: string, msgType: string, payload: unknown): string {
  return `[${ts}] [${level}] [SDK] [QueryHandler] Received message: ${msgType} ${JSON.stringify(payload)}`;
}

function sendingPolicyLine(ts: string, chatModel: string, compactModel: string = 'qwork-auto'): string {
  const payload = {
    requestId: `req_${chatModel}`,
    request: {
      type: 'control_request',
      request_id: `req_${chatModel}`,
      request: {
        subtype: 'set_model_policy',
        scene: 'qwork',
        chat: { model: chatModel },
        compact: { model: compactModel },
        scene_model: { model: compactModel },
      },
    },
  };
  return `[${ts}] [INFO] [SDK] [QueryHandler] Sending control request: set_model_policy ${JSON.stringify(payload)}`;
}

function turnLines(sessionId: string, messageId: string, stopReason: string, inputTokens: number, outputTokens: number): string[] {
  const ts = '2026-05-14T10:00:00.000';
  return [
    sdkLine(ts, 'INFO', 'stream_event', {
      session_id: sessionId,
      event: { type: 'message_start', message: { id: messageId } },
    }),
    sdkLine(ts, 'INFO', 'stream_event', {
      session_id: sessionId,
      event: {
        type: 'message_delta',
        delta: { stop_reason: stopReason },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    }),
    sdkLine(ts, 'INFO', 'stream_event', {
      session_id: sessionId,
      event: { type: 'message_stop' },
    }),
  ];
}

function buildSdkLogLines(opts: {
  sessionId: string;
  messageId: string;
  tier?: string;
  cwd?: string;
  thinking?: string;
  text?: string;
  toolUse?: { id: string; name: string; argsJson: string };
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}): string[] {
  const tsBase = '2026-05-14T10:00:00.000';
  const lines: string[] = [];

  lines.push(sdkLine(tsBase, 'INFO', 'system', {
    subtype: 'init',
    session_id: opts.sessionId,
    model: opts.tier ?? 'Standard',
    cwd: opts.cwd ?? '/tmp',
    agents: [],
    tools: [],
  }));

  lines.push(sdkLine(tsBase, 'INFO', 'stream_event', {
    session_id: opts.sessionId,
    event: { type: 'message_start', message: { id: opts.messageId } },
  }));

  let blockIndex = 0;

  if (opts.thinking) {
    lines.push(sdkLine(tsBase, 'INFO', 'stream_event', {
      session_id: opts.sessionId,
      event: { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking' } },
    }));
    lines.push(sdkLine(tsBase, 'INFO', 'stream_event', {
      session_id: opts.sessionId,
      event: { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: opts.thinking } },
    }));
    blockIndex += 1;
  }

  if (opts.text) {
    lines.push(sdkLine(tsBase, 'INFO', 'stream_event', {
      session_id: opts.sessionId,
      event: { type: 'content_block_start', index: blockIndex, content_block: { type: 'text' } },
    }));
    lines.push(sdkLine(tsBase, 'INFO', 'stream_event', {
      session_id: opts.sessionId,
      event: { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: opts.text } },
    }));
    blockIndex += 1;
  }

  if (opts.toolUse) {
    lines.push(sdkLine(tsBase, 'INFO', 'stream_event', {
      session_id: opts.sessionId,
      event: {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: opts.toolUse.id, name: opts.toolUse.name },
      },
    }));
    lines.push(sdkLine(tsBase, 'INFO', 'stream_event', {
      session_id: opts.sessionId,
      event: {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: opts.toolUse.argsJson },
      },
    }));
    blockIndex += 1;
  }

  lines.push(sdkLine(tsBase, 'INFO', 'stream_event', {
    session_id: opts.sessionId,
    event: {
      type: 'message_delta',
      delta: { stop_reason: opts.stopReason },
      usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens },
    },
  }));
  lines.push(sdkLine(tsBase, 'INFO', 'stream_event', {
    session_id: opts.sessionId,
    event: { type: 'message_stop' },
  }));
  lines.push(sdkLine(tsBase, 'INFO', 'result', {
    session_id: opts.sessionId,
    subtype: 'success',
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    context_usage_ratio: 0,
  }));

  return lines;
}
