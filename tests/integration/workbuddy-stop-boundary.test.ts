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

const fixture = async (): Promise<WorkBuddyRecord[]> => (
  await readFile(new URL('../fixtures/workbuddy/multi-tool-wave.jsonl', import.meta.url), 'utf8')
).trim().split('\n').map(line => JSON.parse(line) as WorkBuddyRecord);

const lines = (records: readonly WorkBuddyRecord[]) => records.map(record => JSON.stringify(record) + '\n').join('');

it.each([
  { promptAtMs: 2000, laterHook: true },
  { promptAtMs: undefined, laterHook: true },
  { promptAtMs: undefined, laterHook: false },
])('retains the new turn after an earlier Stop ($promptAtMs, hook $laterHook)', async ({ promptAtMs, laterHook }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-stop-ownership-'));
  try {
    const projects = path.join(root, 'projects', 'synthetic-project');
    const hookDir = path.join(root, 'pilot-hooks');
    const sessionId = 'fixture-session';
    const eventsDir = path.join(hookDir, sessionId);
    await mkdir(projects, { recursive: true });
    await mkdir(eventsDir, { recursive: true });
    const transcript = path.join(projects, sessionId + '.jsonl');
    await writeFile(transcript, '');
    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new CollectedInput({ stateStore, workBuddyRoot: root, hookEventDir: hookDir });
    expect(await input.poll()).toEqual([]);
    const records = await fixture();
    const firstTurn = [records[0], records[records.length - 1]];
    const nextTurn = [
      { ...records[0], id: 'still-running-turn', timestamp: promptAtMs },
      { ...records[1], id: 'still-running-reasoning', timestamp: 2100 },
    ];
    await writeFile(transcript, lines([...firstTurn, ...nextTurn]));
    await mkdir(eventsDir, { recursive: true });
    await writeFile(path.join(eventsDir, '1600-first.json'), JSON.stringify({
      transcript_path: transcript, session_id: sessionId, hook_event_name: 'Stop', observed_at_ms: 1600,
    }));
    if (laterHook) {
      await writeFile(path.join(eventsDir, '2000-second.json'), JSON.stringify({
        transcript_path: transcript, session_id: sessionId, hook_event_name: 'UserPromptSubmit', observed_at_ms: 2000,
      }));
    }
    expect(await input.poll()).toEqual([]);
    const exported = await input.poll();
    const secondTurn = exported.filter(entry => entry['gen_ai.turn.id'] === 'still-running-turn');
    const checkpoint = stateStore.get(input.id).extra?.workbuddyTranscriptBytes;
    expect({ exported: secondTurn.map(entry => [entry['event.name'], entry['gen_ai.response.finish_reasons']]),
      offsets: Object.values(checkpoint as object),
    }).toEqual({ exported: [], offsets: [Buffer.byteLength(lines(firstTurn))] });

    // Flush the retained turn only when the transcript and its own Stop settle.
    const complete = { ...records[records.length - 1], id: 'second-turn-response', timestamp: 2200 };
    await appendFile(transcript, lines([complete]));
    await writeFile(path.join(eventsDir, '2300-second-stop.json'), JSON.stringify({
      transcript_path: transcript, session_id: sessionId, hook_event_name: 'Stop', observed_at_ms: 2300,
    }));
    await stateStore.save();
    const restartedStore = new StateStore(path.join(root, 'state.json'));
    await restartedStore.load();
    const restarted = new CollectedInput({ stateStore: restartedStore, workBuddyRoot: root, hookEventDir: hookDir });
    expect(await restarted.poll()).toEqual([]);
    const final = await restarted.poll();
    expect(final.map(entry => [entry['gen_ai.turn.id'], entry['event.name']])).toEqual([
      ['still-running-turn', 'other'],
      ['still-running-turn', 'llm.request'],
      ['still-running-turn', 'llm.response'],
    ]);
    expect(final[2]['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(Object.values(restartedStore.get(input.id).extra?.workbuddyTranscriptBytes as object))
      .toEqual([Buffer.byteLength(lines([...firstTurn, ...nextTurn, complete]))]);
    expect(await restarted.poll()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])('exports the closed untimed turn even when the next prompt hook is already present (next rows %s)', async hasNextRows => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-sealed-untimed-review-'));
  try {
    const projects = path.join(root, 'projects', 'synthetic-project');
    const hookDir = path.join(root, 'pilot-hooks');
    const sessionId = 'fixture-session';
    const eventsDir = path.join(hookDir, sessionId);
    await mkdir(projects, { recursive: true });
    const transcript = path.join(projects, sessionId + '.jsonl');
    await writeFile(transcript, '');
    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new CollectedInput({ stateStore, workBuddyRoot: root, hookEventDir: hookDir });
    expect(await input.poll()).toEqual([]);
    const records = await fixture();
    const closed = [
      { ...records[0], id: 'closed-untimed', timestamp: undefined },
      { ...records[records.length - 1], parentId: 'closed-untimed', timestamp: undefined },
    ];
    const next = hasNextRows ? [
      { ...records[0], id: 'next-in-flight', timestamp: 2000 },
      { ...records[1], parentId: 'next-in-flight', timestamp: 2100 },
    ] : [];
    await writeFile(transcript, lines([...closed, ...next]));
    await mkdir(eventsDir, { recursive: true });
    await writeFile(path.join(eventsDir, '1600-stop.json'), JSON.stringify({
      transcript_path: transcript, session_id: sessionId, hook_event_name: 'Stop', observed_at_ms: 1600,
    }));
    await writeFile(path.join(eventsDir, '2000-next-prompt.json'), JSON.stringify({
      transcript_path: transcript, session_id: sessionId, hook_event_name: 'UserPromptSubmit', observed_at_ms: 2000,
    }));
    expect(await input.poll()).toEqual([]);
    const exported = await input.poll();
    await stateStore.save();
    const prevEmitted = exported.filter(row => row['gen_ai.turn.id'] === 'closed-untimed');
    expect(Object.values(stateStore.get(input.id).extra?.workbuddyTranscriptBytes as object))
      .toEqual([Buffer.byteLength(lines(closed))]);
    expect(prevEmitted.map(row => row['event.name'])).toEqual(['other', 'llm.request', 'llm.response']);
    expect(prevEmitted.map(row => row.time_unix_nano)).toEqual(['1600000000', '1600000000', '1600000000']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['reasoning', 'incomplete'])('exports the older untimed turn while the later prompt hook identifies a second untimed %s turn', async mode => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-sealed-untimed-review-'));
  try {
    const projects = path.join(root, 'projects', 'synthetic-project');
    const hookDir = path.join(root, 'pilot-hooks');
    const sessionId = 'fixture-session';
    const eventsDir = path.join(hookDir, sessionId);
    await mkdir(projects, { recursive: true });
    const transcript = path.join(projects, sessionId + '.jsonl');
    await writeFile(transcript, '');
    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new CollectedInput({ stateStore, workBuddyRoot: root, hookEventDir: hookDir });
    expect(await input.poll()).toEqual([]);
    const records = await fixture();
    const closed = [
      { ...records[0], id: 'closed-untimed', timestamp: undefined },
      { ...records[records.length - 1], parentId: 'closed-untimed', timestamp: undefined },
    ];
    const next = [
      { ...records[0], id: 'next-in-flight', timestamp: undefined },
      mode === 'reasoning' ? { ...records[1], parentId: 'next-in-flight', timestamp: undefined }
        : { ...records[records.length - 1], parentId: 'next-in-flight', status: 'incomplete', timestamp: undefined },
    ];
    await writeFile(transcript, lines([...closed, ...next]));
    await mkdir(eventsDir, { recursive: true });
    await writeFile(path.join(eventsDir, '1600-stop.json'), JSON.stringify({
      transcript_path: transcript, session_id: sessionId, hook_event_name: 'Stop', observed_at_ms: 1600,
    }));
    await writeFile(path.join(eventsDir, '2000-next-prompt.json'), JSON.stringify({
      transcript_path: transcript, session_id: sessionId, hook_event_name: 'UserPromptSubmit', observed_at_ms: 2000,
    }));
    expect(await input.poll()).toEqual([]);
    const exported = await input.poll();
    await stateStore.save();
    const prevEmitted = exported.filter(row => row['gen_ai.turn.id'] === 'closed-untimed');
    expect(Object.values(stateStore.get(input.id).extra?.workbuddyTranscriptBytes as object))
      .toEqual([Buffer.byteLength(lines(closed))]);
    expect(prevEmitted.map(row => row['event.name'])).toEqual(['other', 'llm.request', 'llm.response']);
    expect(prevEmitted.map(row => row.time_unix_nano)).toEqual(['1600000000', '1600000000', '1600000000']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('uses the responding turn Stop to time a missing assistant timestamp after two native Stops', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-two-stops-review-'));
  try {
    const projects = path.join(root, 'projects', 'plain');
    const hookDir = path.join(root, 'hooks');
    const sessionId = 'fixture-session';
    const eventsDir = path.join(hookDir, sessionId);
    await mkdir(projects, { recursive: true });
    const transcript = path.join(projects, sessionId + '.jsonl');
    await writeFile(transcript, '');
    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new CollectedInput({ stateStore, workBuddyRoot: root, hookEventDir: hookDir });
    await input.poll();
    const records = await fixture();
    const response = records[records.length - 1];
    await writeFile(transcript, lines([
      records[0],
      response,
      { ...records[0], id: 'second-turn', timestamp: 2000 },
      { ...response, id: 'second-response', timestamp: undefined, parentId: 'second-turn',
        providerData: { ...response.providerData, conversationRequestId: 'second-request', messageId: 'second-response' } },
    ]));
    await mkdir(eventsDir, { recursive: true });
    for (const observed_at_ms of [1600, 2300]) {
      await writeFile(path.join(eventsDir, observed_at_ms + '.json'), JSON.stringify({
        transcript_path: transcript, session_id: sessionId, hook_event_name: 'Stop', observed_at_ms,
      }));
    }
    expect(await input.poll()).toEqual([]);
    const exported = await input.poll();
    const later = exported.filter(entry => entry['gen_ai.turn.id'] === 'second-turn');
    expect(later.find(row => row['event.name'] === 'llm.response')?.time_unix_nano).toBe('2300000000');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
