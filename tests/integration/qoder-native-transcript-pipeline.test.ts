import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { convertEventLogToReadableSpans, type EventLogRecord } from '@loongsuite/otel-util-genai';
import { QoderTraceInput } from '../../src/inputs/qoder-trace/qoder-trace-input.js';
import { QoderCnTraceInput } from '../../src/inputs/qoder-cn-trace/qoder-cn-trace-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { MockStateStore } from '../helpers/mock-state-store.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { publishQoderWakeup } from '../../assets/hooks/qoder/hook-wakeup.mjs';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { expectTurnStrategyParity } from '../helpers/turn-strategy-parity.js';

const secret = 'sk-' + 'synthetic'.repeat(4); // Construct an artificial mask fixture, never a credential.
const epoch = Date.now() - 60_000;
const at = (turn: number, ms: number) => new Date(epoch + turn * 10_000 + ms).toISOString();
function rows(turn: number, cli: boolean) {
  const progress = (hookEvent: string, ms: number) => ({ type: 'progress', timestamp: at(turn, ms), data: { hookEvent } });
  return [progress('UserPromptSubmit', 0),
    { type: 'user', uuid: `user-${turn}`, timestamp: at(turn, 10), ...(cli ? { entrypoint: 'cli' } : {}), message: { role: 'user', content: `prompt ${turn} ${secret}` } },
    { type: 'assistant', timestamp: at(turn, 100), message: { id: `response-${turn}-0`, model: 'synthetic-model', role: 'assistant', usage: { request_id: `req-${turn}-0` }, content: [{ type: 'tool_use', id: `tool-${turn}`, name: 'Read', input: { path: secret } }], stop_reason: 'tool_use' } },
    progress('PreToolUse', 120),
    { type: 'user', timestamp: at(turn, 200), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${turn}`, content: `result ${secret}` }] } },
    progress('PostToolUse', 220),
    { type: 'assistant', timestamp: at(turn, 300), message: { id: `response-${turn}-1`, model: 'synthetic-model', role: 'assistant', usage: { request_id: `req-${turn}-1` }, content: [{ type: 'text', text: `answer ${turn} ${secret}` }], stop_reason: 'end_turn' } },
    progress('Stop', 400), { type: 'last-prompt' },
    // Real CLI 1.1.81 also persists local command envelopes as user records.
    // They must not add execution IDs or inputs between the model turns.
    ...(cli ? [{ type: 'user', entrypoint: 'cli', timestamp: at(turn, 500),
      message: { role: 'user', content: '<command-message>exit</command-message>\n<command-name>/exit</command-name>' } }] : [])];
}
const jsonl = (value: object[]) => value.map(row => JSON.stringify(row)).join('\n') + '\n';
let root: string;
let manager: InputManager | undefined;
afterEach(async () => {
  await manager?.stopAll(); manager = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe.each(['qoder', 'qoder-cn'] as const)('%s native transcript to enriched output', agentId => {
  it('keeps a long tool turn on the shared streaming path with complete history and usage', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-long-native-'));
    const transcript = path.join(root, 'native.jsonl');
    const calls = 96;
    const stamp = (step: number, delta = 0) => new Date(epoch + step * 100 + delta).toISOString();
    const native: object[] = [
      { type: 'progress', timestamp: stamp(0), data: { hookEvent: 'UserPromptSubmit' } },
      { type: 'user', uuid: 'user-long', timestamp: stamp(0, 10), message: { role: 'user', content: 'inspect a synthetic JSON file' } },
    ];
    for (let step = 0; step < calls; step++) {
      const last = step === calls - 1;
      native.push({ type: 'assistant', timestamp: stamp(step + 1), message: {
        id: `long-response-${step}`, model: 'synthetic-model', role: 'assistant', usage: {},
        content: last ? [{ type: 'text', text: 'done' }]
          : [{ type: 'tool_use', id: `long-tool-${step}`, name: 'Read', input: { index: step } }],
        stop_reason: last ? 'end_turn' : 'tool_use',
      } });
      if (!last) native.push({ type: 'user', timestamp: stamp(step + 1, 20), message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `long-tool-${step}`, content: '合成内容'.repeat(256) + step },
      ] } });
    }
    native.push({ type: 'progress', timestamp: stamp(calls + 1), data: { hookEvent: 'Stop' } }, { type: 'last-prompt' });
    await fs.writeFile(transcript, jsonl(native));
    expect(publishQoderWakeup({ session_id: 'synthetic-long-session', transcript_path: transcript,
      hook_event_name: 'Stop', cwd: root }, { dataDir: root, agentId })).toBe(true);
    const Ctor = agentId === 'qoder' ? QoderTraceInput : QoderCnTraceInput;
    const input = new Ctor({ stateStore: new MockStateStore() as any, dataDir: root,
      logDir: path.join(root, 'history'), pollIntervalMs: 60_000 });
    vi.spyOn(input as any, 'readIdeSqliteTokens').mockResolvedValue({ matchedDbPath: null,
      rows: Array.from({ length: calls }, (_, step) => ({ sessionId: 'synthetic-long-session', requestId: 'owned-long',
        messageId: `long-response-${step}`, gmtCreate: epoch + (step + 1) * 100,
        model: 'synthetic-model', inputTokens: 100 + step, outputTokens: 10, cacheReadTokens: 5 })) });
    vi.spyOn(input as any, 'readCliSegments').mockResolvedValue([]);
    vi.spyOn(input as any, 'readCliIntercept').mockResolvedValue({ systemPrompt: null, tokens: [] });
    const output = new MockFlusher();
    manager = new InputManager(); manager.setConfiguredUserId('synthetic-user'); manager.setFlusher(output); manager.registerInput(input);
    await input.start(); await (input as any).cyclePromise; await manager.stopAll();
    const entries = output.batchCalls.flat();
    expect(entries.filter(row => row['event.name'] === 'llm.response')).toHaveLength(calls);
    expect(entries.filter(row => row['event.name'] === 'llm.response').map(row => row['gen_ai.usage.input_tokens']))
      .toEqual(Array.from({ length: calls }, (_, step) => 100 + step));
    expect(entries.filter(row => row['event.name'] === 'tool.result')).toHaveLength(calls - 1);
    const parity = await expectTurnStrategyParity(entries, `${agentId}-long-native-transcript`);
    expect(parity.decisions.every(choice => choice.streamed)).toBe(true);
    expect(parity.currentKinds).toEqual({ LLM: calls, TOOL: calls - 1, STEP: calls, AGENT: 1, ENTRY: 1 });
  });

  it.each([false, true])('retains exact Turn/tool/token counts across queued turns, duplicate Hooks and restart (CLI=%s)', async cli => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-native-pipeline-'));
    const transcript = path.join(root, 'native.jsonl');
    const stateStore = new MockStateStore();
    const flusher = new MockFlusher();
    const wake = () => expect(publishQoderWakeup({ session_id: 'synthetic-session', transcript_path: transcript, hook_event_name: 'Stop', cwd: root }, { dataDir: root, agentId })).toBe(true);
    await fs.writeFile(transcript, jsonl(rows(0, cli).slice(0, 2)));
    wake(); // Capture the first turn before a later turn is queued.
    await fs.appendFile(transcript, jsonl([...rows(0, cli).slice(2), ...rows(1, cli)]));
    wake();

    const createInput = () => {
      const Ctor = agentId === 'qoder' ? QoderTraceInput : QoderCnTraceInput;
      const input = new Ctor({ stateStore: stateStore as any, dataDir: root,
        logDir: path.join(root, 'custom-history'), pollIntervalMs: 60_000 });
      const sqlite = Array.from({ length: 3 }, (_, turn) => [0, 1].map(step => ({
        sessionId: 'synthetic-session', requestId: cli ? `req-${turn}-${step}` : `req-${turn}`, messageId: `response-${turn}-${step}`,
        gmtCreate: epoch + turn * 10_000 + (step === 0 ? 100 : 300), inputTokens: 100 + turn * 20 + step * 10,
        outputTokens: 10 + turn * 2 + step, cacheReadTokens: 50, model: 'synthetic-model',
      }))).flat();
      vi.spyOn(input as any, 'readIdeSqliteTokens').mockImplementation(async () => {
        const end = epoch + ((await fs.readFile(transcript, 'utf8')).includes('prompt 2') ? 30_000 : 20_000);
        return { rows: sqlite.filter(row => row.gmtCreate < end), matchedDbPath: null };
      });
      vi.spyOn(input as any, 'readCliSegments').mockResolvedValue([]);
      vi.spyOn(input as any, 'readCliIntercept').mockResolvedValue({ systemPrompt: null,
        tokens: sqlite.map(row => ({ id: row.messageId, ts: row.gmtCreate,
          promptTokens: row.inputTokens, completionTokens: row.outputTokens, cachedTokens: row.cacheReadTokens,
          reasoningTokens: 0, totalTokens: row.inputTokens + row.outputTokens })) });
      manager = new InputManager(); manager.setFlusher(flusher);
      manager.setMaskConfig({ mode: 'all', types: [] });
      manager.registerInput(input);
      return input;
    };
    let input = createInput();
    await input.start();
    await (input as any).cyclePromise;
    await vi.waitFor(() => expect(flusher.batchCalls.flat().filter(row => row['event.name'] === 'llm.response')).toHaveLength(4));
    // Duplicate observations must not re-enrich/re-emit a committed turn.
    wake();
    const queuedBeforeDuplicate = flusher.batchCalls.length;
    // Exercise the real collect -> queue -> save cycle; direct collect() leaves
    // its metadata checkpoint optimistic and does not model a durable restart.
    await (input as any).runCycle();
    expect(flusher.batchCalls.length).toBe(queuedBeforeDuplicate);
    await manager!.stopAll();
    const initial = flusher.batchCalls.flat();
    expect(new Set(initial.map(row => row['gen_ai.turn.id'])).size).toBe(2);
    expect(initial.filter(row => row['event.name'] === 'tool.call')).toHaveLength(2);
    expect(initial.filter(row => row['event.name'] === 'tool.result')).toHaveLength(2);

    await fs.appendFile(transcript, jsonl(rows(2, cli))); wake();
    input = createInput();
    await input.start(); await manager!.stopAll();
    const entries = flusher.batchCalls.flat();
    const responses = entries.filter(row => row['event.name'] === 'llm.response');
    expect(responses).toHaveLength(6);
    expect(entries.filter(row => row['event.name'] === 'llm.request')).toHaveLength(6);
    expect(entries.filter(row => row['event.name'] === 'tool.call')).toHaveLength(3);
    expect(entries.filter(row => row['event.name'] === 'tool.result')).toHaveLength(3);
    expect(new Set(entries.map(row => row['event.id'])).size).toBe(entries.length);
    expect(new Set(entries.map(row => row.trace_id)).size).toBe(3);
    expect(responses.map(row => row['gen_ai.usage.input_tokens'])).toEqual([100, 110, 120, 130, 140, 150]);
    expect(responses.reduce((sum, row) => sum + Number(row['gen_ai.usage.output_tokens']), 0)).toBe(75);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(entries)).toContain('[APIKEY_MASKED]');
    expect(entries.filter(row => row['event.name'] === 'tool.call').map(row => row['gen_ai.tool.call.arguments']))
      .toEqual(Array.from({ length: 3 }, () => ({ path: '[APIKEY_MASKED]' })));

    const converted = await convertEventLogToReadableSpans(entries.filter(row => row['event.name'] !== 'agent.input') as unknown as EventLogRecord[], { strict: false });
    const spans = converted.spans;
    const llms = spans.filter(span => span.attributes['gen_ai.operation.name'] === 'chat');
    const tools = spans.filter(span => span.attributes['gen_ai.operation.name'] === 'execute_tool');
    expect(llms).toHaveLength(6);
    expect(tools).toHaveLength(3);
    expect(llms.reduce((sum, span) => sum + Number(span.attributes['gen_ai.usage.input_tokens']), 0)).toBe(750);
    expect(llms.reduce((sum, span) => sum + Number(span.attributes['gen_ai.usage.output_tokens']), 0)).toBe(75);
    expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(3);
    await expectTurnStrategyParity(entries, `${agentId}-native-transcript-cli-${cli}`);
  });
});
