import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { buildWorkBuddyEvents } from '../../src/inputs/workbuddy/workbuddy-event-builder.js';
import type { WorkBuddyRecord } from '../../src/inputs/workbuddy/workbuddy-types.js';
import { JSONL_VALIDATOR_JS } from '../../scripts/e2e/lib/e2e-scenarios.mjs';

const fixture = async (): Promise<WorkBuddyRecord[]> => (
  await readFile(new URL('../fixtures/workbuddy/multi-tool-wave.jsonl', import.meta.url), 'utf8')
).trim().split('\n').map(line => JSON.parse(line) as WorkBuddyRecord);

it('validates real JSONL projection of a complete turn with its native ai-title record', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-title-strict-'));
  try {
    const records = await fixture();
    records.push({ type: 'ai-title', id: 'synthetic-title', timestamp: 1600, aiTitle: 'Generated session title' });
    const flusher = new JsonlFlusher({ enabled: true, outputDir: root, rotateDaily: false, maxFileSizeMb: 8 });
    await flusher.start();
    const entries = await buildWorkBuddyEvents(records, { sessionId: 'title-fixture' });
    await flusher.sendBatch(entries.map(entry => ({ ...entry, 'user.id': 'fixture-user' })));
    await flusher.shutdown();
    const validated = spawnSync(process.execPath, ['-'], {
      input: JSONL_VALIDATOR_JS,
      encoding: 'utf8',
      env: { ...process.env, _JV_LOG_DIR: root, E2E_JSONL_STRICT: '1', E2E_JSONL_AGENT_FILTER: 'workbuddy' },
    });
    const metrics = validated.stdout.split('\n').filter(line => /missing_required=|model_pair_error=|turn_boundary_error=/.test(line));
    expect({ code: validated.status, metrics }).toEqual({
      code: 0, metrics: ['  missing_required=0', '  model_pair_error=0', '  turn_boundary_error=0'],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('retains reasoning from a follow-up model request that is cancelled after completed tools', async () => {
  const records = await fixture();
  records.pop();
  records.push({ type: 'message', role: 'assistant', id: 'interrupt-followup', status: 'incomplete',
    timestamp: 1600, providerData: { skipRun: true }, content: [{ type: 'output_text', text: 'Interrupted by user' }] });
  const entries = await buildWorkBuddyEvents(records, { sessionId: 'followup-fixture' });
  const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
  expect(responses.map(entry => [entry['gen_ai.step.id'], entry['gen_ai.response.finish_reasons'], entry['gen_ai.turn.end']]))
    .toEqual([['request-synthetic-1:s1', ['tool_call'], undefined], ['request-synthetic-1:s2', ['cancelled'], true]]);
  expect(responses[1]['gen_ai.output.messages']).toEqual([
    expect.objectContaining({ parts: [expect.objectContaining({ type: 'reasoning' })] }),
  ]);
  expect(entries.filter(entry => entry['event.name'] === 'other')).toHaveLength(1);
});

it('does not infer per-call usage from a shared conversation ID', async () => {
  const records = await fixture();
  for (const record of records) {
    if (record.providerData) {
      delete record.providerData.usage;
      delete record.providerData.rawUsage;
    }
    if (record.message) delete record.message.usage;
  }
  records.push(
    { type: 'model-usage', timestamp: 1210, providerData: {
      conversationRequestId: 'request-synthetic-1', messageId: 'response-synthetic-1', rawUsage: { prompt_tokens: 100, completion_tokens: 20 },
    } },
    { type: 'model-usage', timestamp: 1510, providerData: {
      conversationRequestId: 'request-synthetic-1', messageId: 'response-synthetic-2', rawUsage: { prompt_tokens: 200, completion_tokens: 30 },
    } },
  );
  const entries = await buildWorkBuddyEvents(records, { sessionId: 'usage-fixture' });
  const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
  expect(responses.map(entry => [entry['gen_ai.response.id'], entry['gen_ai.usage.input_tokens'], entry['gen_ai.usage.output_tokens']]))
    .toEqual([['response-synthetic-1', undefined, undefined], ['response-synthetic-2', undefined, undefined]]);
});

it('strictly exports the recovered first-call reasoning cancellation once with stable event identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-cancel-strict-'));
  try {
    const records = (await fixture()).slice(0, 2);
    records.push({ type: 'message', role: 'assistant', id: 'interrupt-first', status: 'incomplete',
      timestamp: 1600, providerData: { skipRun: true }, content: [{ type: 'output_text', text: 'Interrupted by user' }] });
    const opts = { sessionId: 'strict-cancel-fixture' };
    const entries = await buildWorkBuddyEvents(records, opts);
    const repeated = await buildWorkBuddyEvents(records, opts);
    expect(entries.map(entry => entry['event.name'])).toEqual(['other', 'llm.request', 'llm.response']);
    expect(repeated.map(entry => entry['event.id'])).toEqual(entries.map(entry => entry['event.id']));
    expect(entries.filter(entry => entry['gen_ai.turn.start'])).toHaveLength(1);
    expect(entries.filter(entry => entry['gen_ai.turn.end'])).toHaveLength(1);
    expect(entries[2]['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
    const sink = new JsonlFlusher({ enabled: true, outputDir: root, rotateDaily: false, maxFileSizeMb: 8 });
    await sink.start();
    await sink.sendBatch(entries.map(entry => ({ ...entry, 'user.id': 'fixture-user' })));
    await sink.shutdown();
    const validated = spawnSync(process.execPath, ['-'], {
      input: JSONL_VALIDATOR_JS, encoding: 'utf8',
      env: { ...process.env, _JV_LOG_DIR: root, E2E_JSONL_STRICT: '1', E2E_JSONL_AGENT_FILTER: 'workbuddy' },
    });
    expect(validated.status, validated.stdout).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
