import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { buildWorkBuddyEvents } from '../../src/inputs/workbuddy/workbuddy-event-builder.js';
import { WorkBuddyInput } from '../../src/inputs/workbuddy/workbuddy-input.js';
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

it('uses the later Stop for an untimed completed turn that follows a witnessed cancellation', async () => {
  const records = await fixture();
  const earlier = [
    records[0], records[1],
    { type: 'message', role: 'assistant', status: 'incomplete', timestamp: 1500, providerData: { skipRun: true } },
  ];
  const later = [
    { ...records[0], id: 'legacy-after-cancel', timestamp: undefined },
    { ...records[records.length - 1], id: 'legacy-completion', timestamp: undefined },
  ];
  const entries = await buildWorkBuddyEvents([...earlier, ...later], {
    sessionId: 'two-turn-fixture',
    hookEvents: [{ eventName: 'Stop', observedAtMs: 1600 }, { eventName: 'Stop', observedAtMs: 2300 }],
    stopAtMs: 2300,
  });
  expect(entries.filter(entry => entry['event.name'] === 'llm.response')
    .map(entry => [entry['gen_ai.response.finish_reasons'], entry.time_unix_nano]))
    .toEqual([[['cancelled'], '1500000000'], [['stop'], '2300000000']]);
});

it.each(['timed', 'untimed', 'untimed after restart', 'only the completion Stop'])(
  'pairs an untimed cancellation with its own Stop before the %s completion', async variant => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-cancellation-stop-'));
    try {
      const sessionId = 'cancellation-stop-pair';
      const projects = path.join(root, 'projects', 'fixture-project');
      const hookEventDir = path.join(root, 'hooks');
      const sessionHooks = path.join(hookEventDir, sessionId);
      await mkdir(projects, { recursive: true });
      const transcript = path.join(projects, `${sessionId}.jsonl`);
      await writeFile(transcript, '');

      class PolledInput extends WorkBuddyInput {
        poll() { return this.collect(); }
      }
      const restart = async () => {
        const stateStore = new StateStore(path.join(root, 'state.json'));
        await stateStore.load();
        const input = new PolledInput({ stateStore, workBuddyRoot: root, hookEventDir });
        return { input, stateStore };
      };
      const hook = async (hookEventName: string, atMs: number) => {
        await mkdir(sessionHooks, { recursive: true });
        await writeFile(path.join(sessionHooks, `${atMs}.json`), JSON.stringify({
          transcript_path: transcript, session_id: sessionId, hook_event_name: hookEventName, observed_at_ms: atMs,
        }));
      };
      const { input, stateStore } = await restart();
      expect(await input.poll()).toEqual([]);

      const records = await fixture();
      const [prompt, reasoning] = records;
      const response = records.at(-1)!;
      const laterPromptAtMs = variant === 'timed' || variant === 'only the completion Stop' ? 2000 : undefined;
      const earlier = [prompt, reasoning, {
        type: 'message', role: 'assistant', id: 'interruption', status: 'incomplete', providerData: { skipRun: true },
      }];
      const later = [
        { ...prompt, id: 'next-prompt', timestamp: laterPromptAtMs },
        { ...response, id: 'next-response', parentId: 'next-prompt', timestamp: variant === 'timed' ? 2100 : undefined,
          providerData: { ...response.providerData, conversationRequestId: 'next-request', messageId: 'next-response' } },
      ];
      const lines = (rows: WorkBuddyRecord[]) => rows.map(row => `${JSON.stringify(row)}\n`).join('');
      await writeFile(transcript, lines([...earlier, ...later]));
      await hook('UserPromptSubmit', 1000);
      if (variant !== 'only the completion Stop') await hook('Stop', 1600);
      if (variant === 'timed') {
        // This Stop precedes the cancelled turn's reasoning and cannot seal it.
        await hook('Stop', 1050);
      }
      if (laterPromptAtMs !== undefined) await hook('UserPromptSubmit', laterPromptAtMs);
      if (variant !== 'untimed after restart') await hook('Stop', 2300);

      expect(await input.poll()).toEqual([]);
      const firstExport = await input.poll();
      await stateStore.save();
      const resumed = await restart();
      const offsets = Object.values(resumed.stateStore.get(input.id).extra?.workbuddyTranscriptBytes as object);
      expect(offsets).toEqual([Buffer.byteLength(lines(variant === 'untimed after restart' ? earlier : [...earlier, ...later]))]);
      expect(await resumed.input.poll()).toEqual([]);

      const expectedCancellation = [prompt.id, ['cancelled'], variant === 'only the completion Stop' ? '2000000000' : '1600000000'];
      const expectedCompletion = ['next-prompt', ['stop'], variant === 'timed' ? '2100000000' : '2300000000'];
      const completions = (entries: typeof firstExport) => entries.filter(row => row['event.name'] === 'llm.response')
        .map(row => [row['gen_ai.turn.id'], row['gen_ai.response.finish_reasons'], row.time_unix_nano]);
      if (variant === 'untimed after restart') {
        expect(completions(firstExport)).toEqual([expectedCancellation]);
        expect(firstExport.every(row => row['gen_ai.turn.id'] === prompt.id)).toBe(true);
        await hook('Stop', 2300);
        expect(await resumed.input.poll()).toEqual([]);
        const final = await resumed.input.poll();
        expect(final.map(row => row['event.name'])).toEqual(['other', 'llm.request', 'llm.response']);
        expect(completions(final)).toEqual([expectedCompletion]);
        expect(await resumed.input.poll()).toEqual([]);
      } else {
        expect(completions(firstExport)).toEqual([expectedCancellation, expectedCompletion]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  { earlierStop: 1600, earlierPromptAtMs: 1000 },
  { earlierStop: undefined, earlierPromptAtMs: 1000 },
  { earlierStop: 1600, earlierPromptAtMs: undefined },
  { earlierStop: undefined, earlierPromptAtMs: undefined },
  { earlierStop: undefined, earlierPromptAtMs: 1000, omitEarlierPromptHook: true },
])('preserves the next untimed turn after cancellation (%j)',
  async ({ earlierStop, earlierPromptAtMs, omitEarlierPromptHook }) => {
    const source = await fixture();
    const [prompt, reasoning] = source;
    const response = source.at(-1)!;
    const records: WorkBuddyRecord[] = [
      { ...prompt, timestamp: earlierPromptAtMs },
      reasoning,
      { type: 'message', role: 'assistant', status: 'incomplete', providerData: { skipRun: true } },
      { ...prompt, id: 'next-prompt', timestamp: undefined },
      { ...response, id: 'next-response', parentId: 'next-prompt', timestamp: undefined,
        providerData: { ...response.providerData, conversationRequestId: 'next-request', messageId: 'next-response' } },
    ];
    const opts = {
      sessionId: 'cancelled-before-untimed-turn',
      hookEvents: [
        ...(omitEarlierPromptHook ? [] : [{ eventName: 'UserPromptSubmit', observedAtMs: 1000 }]),
        ...(earlierStop === undefined ? [] : [{ eventName: 'Stop', observedAtMs: earlierStop }]),
        { eventName: 'UserPromptSubmit', observedAtMs: 2000 },
        { eventName: 'Stop', observedAtMs: 2300 },
      ],
      stopAtMs: 2300,
    };
    const entries = await buildWorkBuddyEvents(records, opts);
    const repeated = await buildWorkBuddyEvents(records, opts);
    expect(repeated.map(entry => entry['event.id'])).toEqual(entries.map(entry => entry['event.id']));
    expect(entries.map(row => [row['gen_ai.turn.id'], row['event.name'], row.time_unix_nano])).toEqual([
      [prompt.id, 'other', '1000000000'],
      [prompt.id, 'llm.request', '1000000000'],
      [prompt.id, 'llm.response', earlierStop === undefined ? '2000000000' : '1600000000'],
      ['next-prompt', 'other', '2000000000'],
      ['next-prompt', 'llm.request', '2000000000'],
      ['next-prompt', 'llm.response', '2300000000'],
    ]);
    expect(entries.filter(row => row['event.name'] === 'llm.response')
      .map(row => row['gen_ai.response.finish_reasons'])).toEqual([['cancelled'], ['stop']]);
  },
);

it.each([
  { cancellationAtMs: undefined, nextPromptAtMs: 1591 },
  { cancellationAtMs: 1500, nextPromptAtMs: 1491 },
])('keeps distinct Stops in turn order when the next Prompt was queued (native cancellation $cancellationAtMs)',
  async ({ cancellationAtMs, nextPromptAtMs }) => {
    const source = await fixture();
    const [prompt, reasoning] = source;
    const response = source.at(-1)!;
    const records: WorkBuddyRecord[] = [
      prompt,
      reasoning,
      { type: 'message', role: 'assistant', status: 'incomplete', timestamp: cancellationAtMs, providerData: { skipRun: true } },
      { ...prompt, id: 'next-prompt', timestamp: undefined },
      { ...response, id: 'next-response', parentId: 'next-prompt', timestamp: undefined,
        providerData: { ...response.providerData, conversationRequestId: 'next-request', messageId: 'next-response' } },
    ];
    const opts = {
      sessionId: 'queued-prompt-stop-order',
      hookEvents: [
        { eventName: 'UserPromptSubmit', observedAtMs: 1000 },
        { eventName: 'UserPromptSubmit', observedAtMs: nextPromptAtMs },
        { eventName: 'Stop', observedAtMs: 1600 },
        { eventName: 'Stop', observedAtMs: 2300 },
      ],
      stopAtMs: 2300,
    };
    const entries = await buildWorkBuddyEvents(records, opts);
    expect(entries.filter(row => row['event.name'] === 'llm.response')
      .map(row => [row['gen_ai.turn.id'], row['gen_ai.response.finish_reasons'], row.time_unix_nano])).toEqual([
      [prompt.id, ['cancelled'], String((cancellationAtMs ?? 1600) * 1_000_000)],
      ['next-prompt', ['stop'], '2300000000'],
    ]);
    expect(entries.find(row => row['event.name'] === 'other' && row['gen_ai.turn.id'] === 'next-prompt')?.time_unix_nano)
      .toBe(String(nextPromptAtMs * 1_000_000));
  },
);

it('does not assign either of two Stops to a canceled first turn when two completed turns follow', async () => {
  const source = await fixture();
  const [prompt, reasoning] = source;
  const response = source.at(-1)!;
  const records: WorkBuddyRecord[] = [
    prompt,
    reasoning,
    { type: 'message', role: 'assistant', status: 'incomplete', providerData: { skipRun: true } },
  ];
  for (const turn of ['second', 'third']) {
    records.push(
      { ...prompt, id: `${turn}-prompt`, timestamp: undefined },
      { ...response, id: `${turn}-response`, parentId: `${turn}-prompt`, timestamp: undefined,
        providerData: { ...response.providerData, conversationRequestId: `${turn}-request`, messageId: `${turn}-response` } },
    );
  }
  const entries = await buildWorkBuddyEvents(records, {
    sessionId: 'reserve-remaining-stop-order',
    hookEvents: [
      { eventName: 'UserPromptSubmit', observedAtMs: 1000 },
      { eventName: 'UserPromptSubmit', observedAtMs: 1591 },
      { eventName: 'Stop', observedAtMs: 2300 },
      { eventName: 'UserPromptSubmit', observedAtMs: 2400 },
      { eventName: 'Stop', observedAtMs: 2600 },
    ],
    stopAtMs: 2600,
  });
  expect(entries.filter(row => row['event.name'] === 'llm.response')
    .map(row => [row['gen_ai.turn.id'], row['gen_ai.response.finish_reasons'], row.time_unix_nano])).toEqual([
    [prompt.id, ['cancelled'], '1591000000'],
    ['second-prompt', ['stop'], '2300000000'],
    ['third-prompt', ['stop'], '2600000000'],
  ]);
});
