import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertEventLogToReadableSpans, type EventLogRecord } from '@loongsuite/otel-util-genai';
import { HermesLogInput } from '../../src/inputs/hermes-log/hermes-log-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { contentHash } from '../../src/utils/content-hash.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

const PLUGIN_PATH = path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py');
const FIXTURE_PATH = path.resolve('tests/fixtures/hermes-agent/real-tool-turn-hooks.jsonl');

describe('Hermes per-turn upstream trace linking', () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { splitBatches: false, input: 'normal' },
    { splitBatches: true, input: 'normal' },
    { splitBatches: false, input: 'history-only' },
    { splitBatches: true, input: 'history-only' },
    { splitBatches: false, input: 'late-history' },
    { splitBatches: true, input: 'late-history' },
    { splitBatches: false, input: 'long-hash-only' },
    { splitBatches: true, input: 'long-hash-only' },
  ])('links repeated tool turns: $input (split=$splitBatches)', async ({ splitBatches, input: inputCase }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-upstream-'));
    temporaryDirectories.push(root);
    const producerDir = path.join(root, 'producer');
    const sessionDir = path.join(root, 'collector');
    const correlateDir = path.join(root, 'acp-correlate');
    await fs.mkdir(sessionDir);
    await fs.mkdir(correlateDir);
    const sessionId = 'hermes-native-session';
    const fixture = (await fs.readFile(FIXTURE_PATH, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const nativePrompt = fixture.find(event => event.hook === 'pre_llm_call').payload.user_message;
    const prompt = inputCase === 'long-hash-only' ? '界'.repeat(33000) : nativePrompt;
    // Deliberately repeat the same prompt: matching must consume each turn's
    // record once, in order, rather than reusing the previous turn's context.
    const turns = [
      { id: 'turn-1', trace: '11111111111111111111111111111111', parent: '1111111111111111' },
      { id: 'turn-2', trace: '22222222222222222222222222222222', parent: '2222222222222222' },
    ];
    await fs.writeFile(path.join(correlateDir, `${sessionId}.jsonl`), turns.map(turn => JSON.stringify({
      type: 'turn', sessionId, contentHash: contentHash(prompt),
      ...(inputCase === 'long-hash-only' ? {} : { contentPrefix: prompt }),
      traceparent: `00-${turn.trace}-${turn.parent}-01`,
    })).join('\n') + '\n');
    const events = turns.flatMap(turn => fixture.map(envelope => ({
      hook: envelope.hook,
      // The older fixture only learns task_id at pre_api_request. Input must
      // use that id, never the provisional id allocated at pre_llm_call.
      payload: {
        ...envelope.payload, session_id: sessionId,
        ...('user_message' in envelope.payload ? {
          user_message: ['history-only', 'late-history'].includes(inputCase) && envelope.hook === 'pre_llm_call' ? '' : prompt,
        } : {}),
        ...('conversation_history' in envelope.payload ? {
          conversation_history: inputCase === 'late-history' && envelope.hook === 'pre_llm_call' ? []
            : envelope.payload.conversation_history.map((message: any) =>
              message.role === 'user' ? { ...message, content: prompt } : message),
        } : {}),
        ...(inputCase === 'late-history' && envelope.hook === 'pre_api_request' && envelope.payload.api_call_count === 1
          ? { conversation_history: [{ role: 'user', content: prompt }] } : {}),
        ...('task_id' in envelope.payload ? { task_id: turn.id } : {}),
      },
    })));
    const eventsPath = path.join(root, 'events.json');
    await fs.writeFile(eventsPath, JSON.stringify(events));
    const driver = `
import importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location('pilot_hermes', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
hooks = {}
p.register(types.SimpleNamespace(register_hook=lambda name, cb: hooks.update({name: cb})))
for event in json.loads(pathlib.Path(sys.argv[2]).read_text()):
    hooks[event['hook']](**event['payload'])
`;
    const run = spawnSync('python3', ['-c', driver, PLUGIN_PATH, eventsPath], {
      encoding: 'utf8', env: {
        ...process.env, LOONGSUITE_PILOT_DATA_DIR: producerDir, PYTHONDONTWRITEBYTECODE: '1',
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '', LOONGSUITE_PILOT_USER_ID: '', LOONGSUITE_USER_ID: '',
      },
    });
    expect(run.status, run.stderr).toBe(0);
    const logDir = path.join(producerDir, 'logs', 'hermes-agent');
    const files = await fs.readdir(logDir);
    expect(files).toHaveLength(1);
    const lines = (await fs.readFile(path.join(logDir, files[0]), 'utf8')).trim().split('\n');
    const input = new HermesLogInput({
      stateStore: new MockStateStore() as any, sessionDir, pollIntervalMs: 60_000,
    });
    const flusher = new MockFlusher();
    const manager = new InputManager();
    manager.setFlusher(flusher);
    manager.setTraceLinker(new TraceLinker(new CorrelationStore(correlateDir), { retries: 0 }));
    manager.registerInput(input);
    try {
      for (const batch of splitBatches ? lines.map(line => [line]) : [lines]) {
        await fs.appendFile(path.join(sessionDir, 'hermes-agent-replay.jsonl'), batch.join('\n') + '\n');
        await manager.startInput(input.id);
        await manager.stopInput(input.id);
      }
    } finally {
      await manager.stopInput(input.id);
    }
    const records = flusher.batchCalls.flat();
    for (const turn of turns) {
      const turnRecords = records.filter(record => record['gen_ai.turn.id'] === turn.id);
      expect(turnRecords.length).toBeGreaterThan(0);
      expect(turnRecords.every(record => record.trace_id === turn.trace)).toBe(true);
      const inputs = turnRecords.filter(record => record['event.name'] === 'other'
        && record['agent.hermes.hook'] === 'turn_start');
      expect(inputs).toHaveLength(1);
      expect(inputs[0].parent_span_id).toBe(turn.parent);
      expect(inputs[0]['agent.pilot.correlation.content_hash']).toBe(contentHash(prompt));
      const text = (inputs[0]['gen_ai.input.messages_delta'] as any[])[0].parts[0].content;
      expect(text).toBe(inputCase === 'long-hash-only' ? prompt.slice(0, 32768) + '...[truncated]' : prompt);
      expect(inputs[0]['gen_ai.usage.input_tokens']).toBeUndefined();
      expect(inputs[0]['gen_ai.usage.output_tokens']).toBeUndefined();
      expect(turnRecords.filter(record => record['event.name'] === 'agent.input')).toHaveLength(1);
      expect(turnRecords.filter(record => record['gen_ai.turn.start'] === true)).toHaveLength(1);
      expect(turnRecords.filter(record => record['gen_ai.turn.end'] === true)).toHaveLength(1);
      const converted = await convertEventLogToReadableSpans(
        turnRecords.filter(record => record['event.name'] !== 'agent.input') as EventLogRecord[],
        { strict: false },
      );
      expect(converted.warnings).toEqual([]);
      expect(converted.spans).toHaveLength(7); // ENTRY, AGENT, 2 STEP, 2 LLM, TOOL
      expect(converted.spans.every(span => span.spanContext().traceId === turn.trace)).toBe(true);
      expect(converted.spans.find(span => span.attributes['gen_ai.span.kind'] === 'ENTRY')?.parentSpanId)
        .toBe(turn.parent);
      const llmSpans = converted.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
      const nativeUsage = fixture.filter(event => event.hook === 'post_api_request')
        .map(event => event.payload.usage);
      expect(llmSpans.map(span => [
        span.attributes['gen_ai.usage.input_tokens'], span.attributes['gen_ai.usage.output_tokens'],
      ])).toEqual(nativeUsage.map(usage => [usage.prompt_tokens, usage.output_tokens]));
      const agent = converted.spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
      expect(agent?.attributes['gen_ai.usage.input_tokens'])
        .toBe(nativeUsage.reduce((sum, usage) => sum + usage.prompt_tokens, 0));
      expect(agent?.attributes['gen_ai.usage.output_tokens'])
        .toBe(nativeUsage.reduce((sum, usage) => sum + usage.output_tokens, 0));
    }
  });
});
