import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { StateStore } from '../../src/checkpoints/state-store.ts';
import { ClaudeCodeLogInput } from '../../src/inputs/claude-code-log/claude-code-log-input.ts';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.ts';
import { enqueueStop, hashStopText } from '../../assets/hooks/claude-code/pending-stops.mjs';

const HOOKS = fileURLToPath(new URL('../../assets/hooks', import.meta.url));
const start = Date.now() - 10_000;
const timestamp = (step) => new Date(start + step * 100).toISOString();
const user = (promptId, text, step) => ({
  promptId, type: 'user', timestamp: timestamp(step), message: { role: 'user', content: text },
});
const assistant = (id, content, step, reason = 'end_turn') => ({
  type: 'assistant', timestamp: timestamp(step), message: {
    id, role: 'assistant', model: 'synthetic-claude', content, stop_reason: reason, usage: { input_tokens: 120, output_tokens: 8 },
  },
});
const answer = (id, text, step) => assistant(id, [{ type: 'text', text }], step);
const records = (...rows) => rows.map((row) => JSON.stringify(row) + '\n').join('');

let dataDir;
let transcriptPath;
let configPath;
let queue;
let env;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pending-stop-'));
  transcriptPath = path.join(dataDir, 'transcript.jsonl');
  configPath = path.join(dataDir, 'config.json');
  queue = ClaudeCodeLogInput.pendingStopsDir(dataDir);
  const destination = path.join(dataDir, 'hooks');
  fs.mkdirSync(destination);
  for (const asset of ['claude-code-hook-processor.mjs', 'agent-event-normalizer.mjs', 'claude-code', 'shared']) {
    fs.cpSync(path.join(HOOKS, asset), path.join(destination, asset), { recursive: true });
  }
  env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir, AGENT_DATA_COLLECTION_CONFIG: configPath };
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function runHook(command, payload = {}, extraEnv = {}) {
  const run = spawnSync(process.execPath, [path.join(dataDir, 'hooks', 'claude-code-hook-processor.mjs'), command], {
    input: JSON.stringify(payload), env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 9000,
  });
  expect(run.error).toBeUndefined();
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({});
}

function stop(promptId, reply, extraEnv) {
  runHook('stop', { session_id: 'session', transcript_path: transcriptPath, prompt_id: promptId, last_assistant_message: reply }, extraEnv);
}

async function collect() {
  const stateStore = new StateStore(path.join(dataDir, 'collector-state.json'));
  await stateStore.load();
  const input = new ClaudeCodeLogInput({ dataDir, stateStore });
  const entries = [];
  input.on('entries', (batch) => entries.push(...batch));
  try { await input.start(); }
  finally { await input.stop(); }
  return entries;
}

async function exportSpans(entries) {
  const spans = [];
  const flusher = new OtlpTraceFlusher({
    enabled: true, dataDir, serviceName: 'synthetic-claude',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
  }, undefined, () => ({
    export(batch, cb) { spans.push(...batch); cb({ code: 0 }); },
    async shutdown() {},
  }));
  try {
    await flusher.sendBatch(entries);
    await flusher.flush();
  } finally {
    await flusher.shutdown();
  }
  return spans;
}

describe('Claude Code late Stop transcript', () => {
  test('a user-only snapshot stays pending across collector restarts and an incomplete UTF-8 line', async () => {
    fs.writeFileSync(transcriptPath, records(user('prompt-a', 'hello', 0)));
    stop('prompt-a', 'answer 完成');

    expect(await collect()).toEqual([]);
    expect(fs.readdirSync(queue)).toHaveLength(1);
    const reply = Buffer.from(records(answer('response-a', 'answer 完成', 1)));
    const half = reply.indexOf(Buffer.from('完')) + 1;
    fs.appendFileSync(transcriptPath, reply.subarray(0, half));
    expect(await collect()).toEqual([]);
    fs.appendFileSync(transcriptPath, reply.subarray(half));

    const spans = await exportSpans(await collect());
    const response = spans.find((span) => span.attributes['gen_ai.span.kind'] === 'LLM');
    const entry = spans.find((span) => span.attributes['gen_ai.span.kind'] === 'ENTRY');
    expect(response.attributes).toMatchObject({
      'gen_ai.response.id': 'response-a',
      'gen_ai.usage.input_tokens': 120,
      'gen_ai.usage.output_tokens': 8,
    });
    expect(entry.attributes['gen_ai.input.messages']).toContain('hello');
    expect(entry.attributes['gen_ai.output.messages']).toContain('answer 完成');
    expect(response.spanContext().traceId).toBe(entry.spanContext().traceId);
    expect(fs.readdirSync(queue)).toEqual([]);
    expect(await collect()).toEqual([]);
  });

  test('a later prompt and identical reply do not claim an earlier tool turn', async () => {
    fs.writeFileSync(transcriptPath, records(
      user('prompt-a', 'use a tool', 0),
      assistant('response-tool', [{ type: 'tool_use', name: 'Read', id: 'tool-a', input: { file_path: '/fixture' } }], 1, 'tool_use'),
      user('prompt-a', [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'tool output' }], 2),
    ));
    stop('prompt-a', 'same answer');
    expect(await collect()).toEqual([]);

    fs.appendFileSync(transcriptPath, records(
      answer('response-a', 'same answer', 3),
      user('prompt-b', 'another question', 4),
      answer('response-b', 'same answer', 5),
    ));
    stop('prompt-b', 'same answer');
    const spans = await exportSpans(await collect());
    const turns = spans.filter((span) => span.attributes['gen_ai.span.kind'] === 'ENTRY');
    expect(turns).toHaveLength(2);
    const traceA = turns.find((span) => span.attributes['gen_ai.input.messages'].includes('use a tool')).spanContext().traceId;
    const traceB = turns.find((span) => span.attributes['gen_ai.input.messages'].includes('another question')).spanContext().traceId;
    const idOf = (id) => spans.find((span) => span.attributes['gen_ai.span.kind'] === 'LLM'
      && span.attributes['gen_ai.response.id'] === id).spanContext().traceId;
    expect(idOf('response-a')).toBe(traceA);
    expect(idOf('response-tool')).toBe(traceA);
    expect(idOf('response-b')).toBe(traceB);
    expect(spans.find((span) => span.attributes['gen_ai.span.kind'] === 'TOOL').spanContext().traceId).toBe(traceA);
    expect(await collect()).toEqual([]);
  });

  test('keeps the original Stop identity and content policy after an output write fails', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { 'claude-code': { captureMessageContent: false } } }));
    fs.writeFileSync(transcriptPath, records(user('prompt-a', 'private prompt', 0), answer('response-a', 'private reply', 1)));
    stop('prompt-a', 'private reply', { LOONGSUITE_PILOT_USER_ID: 'stop-user' });
    const stopPath = path.join(queue, fs.readdirSync(queue)[0]);
    expect(fs.readFileSync(stopPath, 'utf8')).not.toContain('private reply');
    fs.writeFileSync(configPath, '{}');

    const logs = path.join(dataDir, 'logs');
    fs.writeFileSync(logs, '');
    runHook('drain-stops');
    expect(fs.existsSync(stopPath)).toBe(true);
    fs.unlinkSync(logs);

    const entries = await collect();
    expect(entries.find((event) => event['event.name'] === 'llm.response')).toMatchObject({
      'user.id': 'stop-user', 'gen_ai.response.id': 'response-a', 'gen_ai.usage.output_tokens': 8,
    });
    const raw = fs.readdirSync(path.join(logs, 'claude-code')).filter((name) => name.endsWith('.jsonl'))
      .map((name) => fs.readFileSync(path.join(logs, 'claude-code', name), 'utf8')).join('');
    expect(raw).not.toContain('private prompt');
    expect(raw).not.toContain('private reply');
    expect(await collect()).toEqual([]);
  });

  test('an expired Stop with no model record allows the next prompt to progress', async () => {
    fs.writeFileSync(transcriptPath, records(
      user('prompt-a', 'lost before source was written', 0),
      user('prompt-b', 'available prompt', 1),
      answer('response-b', 'available answer', 2),
    ));
    enqueueStop(dataDir, {
      observedAt: Date.now() - 65_000, sessionId: 'session', transcriptPath, promptId: 'prompt-a',
      replyHash: hashStopText('unavailable'), stopReason: 'end_turn', context: { userId: 'test' },
    });
    stop('prompt-b', 'available answer');
    const spans = await exportSpans(await collect());
    const turns = spans.filter((span) => span.attributes['gen_ai.span.kind'] === 'ENTRY');
    expect(turns).toHaveLength(1);
    expect(turns[0].attributes['gen_ai.input.messages']).toContain('available prompt');
    expect(turns[0].attributes['gen_ai.output.messages']).toContain('available answer');
    expect(fs.readdirSync(queue)).toEqual([]);
  });

  test('a repeat Stop after a committed prompt does not block the next prompt', async () => {
    fs.writeFileSync(transcriptPath, records(user('prompt-a', 'first', 0), answer('response-a', 'answer a', 1)));
    stop('prompt-a', 'answer a');
    expect((await collect()).filter((event) => event['event.name'] === 'llm.response')).toHaveLength(1);

    stop('prompt-a', 'answer a');
    fs.appendFileSync(transcriptPath, records(user('prompt-b', 'second', 2), answer('response-b', 'answer b', 3)));
    stop('prompt-b', 'answer b');
    const events = await collect();
    const responses = events.filter((event) => event['event.name'] === 'llm.response');
    expect(responses.map((event) => event['gen_ai.response.id'])).toEqual(['response-b']);
    expect(fs.readdirSync(queue)).toEqual([]);
  });
});
