import { appendFile, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { WorkBuddyInput } from '../../src/inputs/workbuddy/workbuddy-input.js';
import type { WorkBuddyRecord } from '../../src/inputs/workbuddy/workbuddy-types.js';

class CollectedInput extends WorkBuddyInput {
  poll() { return this.collect(); }
}

const lines = (records: readonly WorkBuddyRecord[]) => records.map(record => JSON.stringify(record) + '\n').join('');

async function setup(root: string) {
  const projects = path.join(root, 'projects', 'synthetic-project');
  const hookDir = path.join(root, 'pilot-hooks');
  const sessionId = 'fixture-session';
  const eventsDir = path.join(hookDir, sessionId);
  await mkdir(projects, { recursive: true });
  await mkdir(eventsDir, { recursive: true });
  const transcript = path.join(projects, sessionId + '.jsonl');
  await writeFile(transcript, '');
  const storePath = path.join(root, 'state.json');
  const restart = async () => {
    const stateStore = new StateStore(storePath);
    await stateStore.load();
    return { stateStore, input: new CollectedInput({ stateStore, workBuddyRoot: root, hookEventDir: hookDir }) };
  };
  const { input, stateStore } = await restart();
  expect(await input.poll()).toEqual([]);
  const messages = (await readFile(new URL('../fixtures/workbuddy/multi-tool-wave.jsonl', import.meta.url), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line) as WorkBuddyRecord);
  const [user, reasoning] = messages;
  const response = messages.at(-1)!;
  const hook = async (hook_event_name: string, observed_at_ms: number) => {
    await mkdir(eventsDir, { recursive: true });
    await writeFile(path.join(eventsDir, observed_at_ms + '.json'), JSON.stringify({
      transcript_path: transcript, session_id: sessionId, hook_event_name, observed_at_ms,
    }));
  };
  return { input, stateStore, restart, transcript, user, reasoning, response, hook };
}

it.each([false, true])('matches the second Stop for a legacy untimed response and user (paired prompt hooks: %s)', async prompts => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-stale-stop-'));
  try {
    const f = await setup(root);
    await writeFile(f.transcript, lines([
      f.user, f.response,
      { ...f.user, id: 'second-turn', timestamp: undefined },
      { ...f.response, id: 'second-response', timestamp: undefined, parentId: 'second-turn',
        providerData: { ...f.response.providerData, conversationRequestId: 'second-request', messageId: 'second-response' } },
    ]));
    if (prompts) await f.hook('UserPromptSubmit', 1000);
    await f.hook('Stop', 1600);
    if (prompts) await f.hook('UserPromptSubmit', 2000);
    await f.hook('Stop', 2300);
    expect(await f.input.poll()).toEqual([]);
    const exported = await f.input.poll();
    const later = exported.filter(entry => entry['gen_ai.turn.id'] === 'second-turn');
    expect(later.find(row => row['event.name'] === 'llm.response')?.time_unix_nano).toBe('2300000000');
    expect(later.find(row => row['event.name'] === 'other')?.time_unix_nano).toBe(prompts ? '2000000000' : '2300000000');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('retains the next entirely untimed in-flight turn without a prompt hook', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-open-untimed-'));
  try {
    const f = await setup(root);
    const older = [f.user, f.response];
    const active = [
      { ...f.user, id: 'second-turn', timestamp: undefined },
      { ...f.reasoning, id: 'second-reasoning', timestamp: undefined, parentId: 'second-turn' },
    ];
    await writeFile(f.transcript, lines([...older, ...active]));
    await f.hook('Stop', 1600);
    expect(await f.input.poll()).toEqual([]);
    const emitted = await f.input.poll();
    await f.stateStore.save();
    const { stateStore: committed } = await f.restart();
    const persisted = Object.values(committed.get(f.input.id).extra?.workbuddyTranscriptBytes as object);

    await appendFile(f.transcript, lines([{ ...f.response, id: 'second-response', parentId: 'second-turn', timestamp: 2200 }]));
    await f.hook('Stop', 2300);
    const restarted = await f.restart();
    expect(await restarted.input.poll()).toEqual([]);
    const final = await restarted.input.poll();
    expect({
      prematureEvents: emitted.filter(row => row['gen_ai.turn.id'] === 'second-turn').map(row => row['event.name']),
      persisted,
      final: final.map(row => [row['gen_ai.turn.id'], row['event.name']]),
    }).toEqual({
      prematureEvents: [],
      persisted: [Buffer.byteLength(lines(older))],
      final: [['second-turn', 'other'], ['second-turn', 'llm.request'], ['second-turn', 'llm.response']],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])('keeps a sole Stop for the responding turn if its prior turn had a terminal response: %s', async previousResponse => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-sole-stop-'));
  try {
    const f = await setup(root);
    const older = previousResponse ? [f.user, f.response] : [{ ...f.user, timestamp: undefined }];
    await writeFile(f.transcript, lines([
      ...older,
      { ...f.user, id: 'second-turn', timestamp: undefined },
      { ...f.response, id: 'second-response', timestamp: undefined, parentId: 'second-turn' },
    ]));
    if (previousResponse) await f.hook('UserPromptSubmit', 2000);
    await f.hook('Stop', 2300);
    expect(await f.input.poll()).toEqual([]);
    const exported = await f.input.poll();
    const later = exported.filter(entry => entry['gen_ai.turn.id'] === 'second-turn');
    expect(later.map(entry => [entry['event.name'], entry.time_unix_nano])).toEqual([
      ['other', previousResponse ? '2000000000' : '2300000000'],
      ['llm.request', previousResponse ? '2000000000' : '2300000000'],
      ['llm.response', '2300000000'],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps an untimed completed-looking turn in the checkpoint suffix when a third turn arrives', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-unsealed-legacy-'));
  try {
    const f = await setup(root);
    const older = [f.user, f.response];
    const later = [
      { ...f.user, id: 'second-turn', timestamp: undefined },
      { ...f.response, id: 'second-response', timestamp: undefined, parentId: 'second-turn' },
    ];
    const third = { ...f.user, id: 'third-turn', timestamp: 2500 };
    await writeFile(f.transcript, lines([...older, ...later, third]));
    await f.hook('Stop', 1600);
    expect(await f.input.poll()).toEqual([]);
    expect((await f.input.poll()).map(row => row['gen_ai.turn.id'])).toEqual([f.user.id, f.user.id, f.user.id]);
    expect(Object.values(f.stateStore.get(f.input.id).extra?.workbuddyTranscriptBytes as object))
      .toEqual([Buffer.byteLength(lines(older))]);
    await f.stateStore.save();

    await f.hook('Stop', 2300);
    const restarted = await f.restart();
    expect(await restarted.input.poll()).toEqual([]);
    const next = await restarted.input.poll();
    expect(next.map(row => [row['gen_ai.turn.id'], row.time_unix_nano])).toEqual([
      ['second-turn', '2300000000'], ['second-turn', '2300000000'], ['second-turn', '2300000000'],
    ]);
    expect(Object.values(restarted.stateStore.get(f.input.id).extra?.workbuddyTranscriptBytes as object))
      .toEqual([Buffer.byteLength(lines([...older, ...later]))]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('never uses a Stop before the request as the response timestamp', async () => {
  const { buildWorkBuddyEvents } = await import('../../src/inputs/workbuddy/workbuddy-event-builder.js');
  const source = (await readFile(new URL('../fixtures/workbuddy/multi-tool-wave.jsonl', import.meta.url), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line) as WorkBuddyRecord);
  const user = { ...source[0], timestamp: 2500 };
  const assistant = { ...source.at(-1)!, timestamp: undefined };
  const entries = await buildWorkBuddyEvents([user, assistant], {
    sessionId: 'non-monotonic-stop',
    hookEvents: [{ eventName: 'Stop', observedAtMs: 2300 }],
  });
  expect(entries.map(row => [row['event.name'], row.time_unix_nano])).toEqual([['other', '2500000000']]);
});

it.each([{ skipRun: true }, { isCompactInternal: true }, { agent: 'compact' }])(
  'keeps an untimed turn pending when only internal records establish timing (%j)', async internal => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-internal-stop-'));
    try {
      const f = await setup(root);
      const older = [f.user, f.response];
      const later = [
        { ...f.user, id: 'second-turn', timestamp: undefined },
        { ...f.reasoning, id: 'internal-compact', timestamp: 1550,
          providerData: { ...f.reasoning.providerData, ...internal } },
        { ...f.response, id: 'second-response', timestamp: undefined, parentId: 'second-turn',
          providerData: { ...f.response.providerData, conversationRequestId: 'second-request', messageId: 'second-response' } },
      ];
      await writeFile(f.transcript, lines([...older, ...later]));
      await f.hook('Stop', 1600);
      expect(await f.input.poll()).toEqual([]);
      const emitted = await f.input.poll();
      await f.stateStore.save();
      const { stateStore: committed } = await f.restart();
      const offsets = Object.values(committed.get(f.input.id).extra?.workbuddyTranscriptBytes as object);

      await f.hook('Stop', 2300);
      const restarted = await f.restart();
      expect(await restarted.input.poll()).toEqual([]);
      const final = await restarted.input.poll();
      expect({
        premature: emitted.filter(row => row['gen_ai.turn.id'] === 'second-turn'),
        offsets,
        final: final.map(row => [row['gen_ai.turn.id'], row['event.name'], row.time_unix_nano]),
      }).toEqual({
        premature: [],
        offsets: [Buffer.byteLength(lines(older))],
        final: [
          ['second-turn', 'other', '2300000000'],
          ['second-turn', 'llm.request', '2300000000'],
          ['second-turn', 'llm.response', '2300000000'],
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
