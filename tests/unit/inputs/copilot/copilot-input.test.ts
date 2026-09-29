import { appendFile, mkdir, mkdtemp, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CopilotInput } from '../../../../src/inputs/copilot/copilot-input.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import { checkpointEvent, ev, shutdownEvent, T0, textOnlyTurn, toJsonl, toolTurn } from '../../../fixtures/copilot/events.js';

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'copilot-root-'));
  dataDir = await mkdtemp(path.join(tmpdir(), 'copilot-data-'));
  await mkdir(path.join(root, 'session-state'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

async function makeInput(grace = 60_000): Promise<{ input: CopilotInput; run: () => Promise<AgentActivityEntry[]> }> {
  const store = new StateStore(path.join(dataDir, 'state.json'));
  await store.load();
  const input = new CopilotInput({
    stateStore: store, copilotRoot: root, wakeupDir: path.join(dataDir, 'wakeups'), deadSessionGraceMs: grace,
  });
  const run = async () => {
    const entries = await (input as unknown as { collect(): Promise<AgentActivityEntry[]> }).collect();
    await store.save();
    return entries;
  };
  return { input, run };
}

async function sessionFile(id: string): Promise<string> {
  const dir = path.join(root, 'session-state', id);
  await mkdir(dir, { recursive: true });
  return path.join(dir, 'events.jsonl');
}

describe('CopilotInput', () => {
  it('does not replay history that predates the first run', async () => {
    const file = await sessionFile('old');
    await writeFile(file, toJsonl(textOnlyTurn()));
    const { run } = await makeInput();
    expect(await run()).toEqual([]);
  });

  it('reads sessions created after the baseline from the start', async () => {
    const { run } = await makeInput();
    await run();
    await writeFile(await sessionFile('new'), toJsonl(textOnlyTurn()));
    const entries = await run();
    expect(entries.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response']);
    expect(entries[0]['gen_ai.session.id']).toBe('new');
  });

  it('emits appended data once and tolerates a partial trailing line', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    const full = toJsonl(toolTurn());
    const cut = full.length - 30;
    await writeFile(file, full.slice(0, cut));
    const first = await run();
    await appendFile(file, full.slice(cut));
    const second = await run();
    const all = [...first, ...second];
    const ids = all.map(e => e['event.id']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.map(e => e['event.name'])).toEqual([
      'llm.request', 'llm.response', 'tool.call', 'tool.result', 'llm.request', 'llm.response',
    ]);
  });

  it('emits later steps of an open interaction without duplicating earlier ones', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    const events = toolTurn();
    await writeFile(file, toJsonl(events.slice(0, 7)));
    const first = await run();
    await appendFile(file, toJsonl(events.slice(7)));
    const second = await run();
    expect(first.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response', 'tool.call', 'tool.result']);
    expect(second.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response']);
  });

  it('does not duplicate entries after a restart', async () => {
    const a = await makeInput();
    await a.run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl(toolTurn()));
    const before = await a.run();
    expect(before.length).toBe(6);
    const b = await makeInput();
    expect(await b.run()).toEqual([]);
  });

  it('restarts cleanly when the transcript is truncated and rewritten smaller', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl(toolTurn()));
    await run();
    // Rewritten file is smaller than what was already consumed: restart from the top
    // and emit the new content in the same cycle that detects the shrink.
    await truncate(file, 0);
    await writeFile(file, toJsonl(textOnlyTurn()));
    const entries = await run();
    expect(entries.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response']);
  });

  it('emits the usage summary on shutdown and stops watching that session', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl([
      ...textOnlyTurn(),
      shutdownEvent(T0 + 9_000, { 'model-a': { inputTokens: 5, outputTokens: 1 } }),
    ]));
    const entries = await run();
    expect(entries.filter(e => e['event.name'] === 'other')).toHaveLength(1);
    expect(await run()).toEqual([]);
  });

  it('resumes a session that was closed by shutdown when the host appends more', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    const first = toJsonl([
      ...textOnlyTurn(),
      shutdownEvent(T0 + 9_000, { 'model-a': { inputTokens: 5, outputTokens: 1 } }),
    ]);
    await writeFile(file, first);
    await run();
    // Copilot resumes the same transcript: a new interaction after the shutdown line.
    const resumed = [
      ev('session.resume', {}, T0 + 20_000),
      ev('user.message', { content: 'again', interactionId: 'i-2', messageId: 'm-2' }, T0 + 21_000),
      ev('assistant.turn_start', { turnId: '7', interactionId: 'i-2' }, T0 + 21_100),
      ev('assistant.message', {
        messageId: 'am-7', content: 'welcome back', model: 'model-a', apiCallId: 'api-7', turnId: '7', interactionId: 'i-2',
      }, T0 + 22_000),
    ];
    await appendFile(file, toJsonl(resumed));
    const entries = await run();
    expect(entries.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response']);
    expect(entries[0]['gen_ai.turn.id']).toBe('i-2');
  });

  it('tolerates a missing session-state directory', async () => {
    await rm(path.join(root, 'session-state'), { recursive: true, force: true });
    const { run } = await makeInput();
    await expect(run()).resolves.toEqual([]);
  });

  it('closes a session with no growth and no live lock after the grace period', async () => {
    const { run } = await makeInput(0);
    await run();
    const file = await sessionFile('dead');
    await writeFile(file, toJsonl(textOnlyTurn()));
    await run();
    // No growth on this cycle, grace 0 and no inuse lock: the session is closed.
    await run();
    // The host was only quiet, not dead: later growth must be collected again.
    await appendFile(file, toJsonl([
      ev('user.message', { content: 'wake', interactionId: 'i-9', messageId: 'm-9' }, T0 + 50_000),
      ev('assistant.turn_start', { turnId: '9', interactionId: 'i-9' }, T0 + 50_100),
      ev('assistant.message', {
        messageId: 'am-9', content: 'up again', model: 'model-a', apiCallId: 'api-9', turnId: '9', interactionId: 'i-9',
      }, T0 + 51_000),
    ]));
    const entries = await run();
    expect(entries.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response']);
  });

  it('keeps watching an idle session while its lock belongs to a live process', async () => {
    const { run } = await makeInput(0);
    await run();
    const file = await sessionFile('live');
    await writeFile(path.join(path.dirname(file), `inuse.${process.pid}.lock`), String(process.pid));
    await writeFile(file, toJsonl(textOnlyTurn().slice(0, 4)));
    await run();
    await run();
    await appendFile(file, toJsonl(textOnlyTurn().slice(4)));
    const entries = await run();
    expect(entries.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response']);
  });
});

describe('CopilotInput default home', () => {
  it('follows COPILOT_HOME for watch paths and availability', async () => {
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = root;
    try {
      expect(CopilotInput.getWatchPaths()).toEqual([root, path.join(root, 'session-state')]);
      await expect(CopilotInput.checkAvailability()).resolves.toBe(true);
    } finally {
      if (previous === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previous;
    }
  });
});

describe('wakeup directory lifecycle', () => {
  it('keeps the watched wakeup directory across cycles and consumes the wakeups', async () => {
    const wakeupDir = path.join(dataDir, 'wakeups');
    const { run } = await makeInput();
    await mkdir(wakeupDir, { recursive: true });
    await writeFile(path.join(wakeupDir, 'a.json'), '{}');
    const before = (await stat(wakeupDir)).ino;
    await run();
    expect((await stat(wakeupDir)).ino).toBe(before);
    await expect(readdir(wakeupDir)).resolves.toEqual([]);
  });

  it('survives an error event from the directory watcher', async () => {
    const { input } = await makeInput();
    await input.start();
    const watcher = (input as unknown as { watcher: NodeJS.EventEmitter | null }).watcher;
    expect(() => watcher?.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' }))).not.toThrow();
    await input.stop();
  });
});

describe('robustness of session discovery', () => {
  it('does not warn for a session directory that has no events.jsonl yet', async () => {
    const { input, run } = await makeInput();
    await run();
    await mkdir(path.join(root, 'session-state', 'empty'), { recursive: true });
    const warn = vi.spyOn((input as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn');
    await run();
    await run();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not wedge on an open interaction larger than one read', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('big');
    const head = textOnlyTurn().slice(0, 3);
    const filler = Array.from({ length: 220 }, (_, i) => ev('assistant.message', {
      messageId: `f-${i}`, content: 'x'.repeat(50_000), model: 'model-a', apiCallId: `f-api-${i}`,
      turnId: String(i), interactionId: 'i-1',
    }, T0 + 5_000 + i));
    const tail = [
      ev('user.message', { content: 'second', interactionId: 'i-2', messageId: 'm-2' }, T0 + 9_000_000),
      ev('assistant.turn_start', { turnId: '900', interactionId: 'i-2' }, T0 + 9_000_100),
      ev('assistant.message', {
        messageId: 'am-900', content: 'done', model: 'model-a', apiCallId: 'api-900', turnId: '900', interactionId: 'i-2',
      }, T0 + 9_001_000),
      shutdownEvent(T0 + 9_002_000, { 'model-a': { inputTokens: 5, outputTokens: 1 } }),
    ];
    await writeFile(file, toJsonl([...head, ...filler, ...tail]));
    const seen: AgentActivityEntry[] = [];
    for (let cycle = 0; cycle < 6; cycle++) seen.push(...await run());
    expect(seen.some(e => e['event.name'] === 'llm.response' && e['gen_ai.turn.id'] === 'i-2')).toBe(true);
    expect(seen.filter(e => e['event.name'] === 'other')).toHaveLength(1);
  });
});

describe('token totals across resumed sessions', () => {
  const totals = (i: number, o: number) => ({ 'model-a': { inputTokens: i, outputTokens: o } });

  it('does not report the same session totals twice and emits only later increments', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl([...textOnlyTurn(), shutdownEvent(T0 + 9_000, totals(1000, 50))]));
    const first = (await run()).filter(e => e['event.name'] === 'other');
    expect(first.map(e => e['gen_ai.usage.input_tokens'])).toEqual([1000]);

    // Resume and close again without new usage: Copilot repeats the cumulative totals.
    await appendFile(file, toJsonl([
      ev('session.resume', {}, T0 + 20_000),
      shutdownEvent(T0 + 21_000, totals(1000, 50)),
    ]));
    expect((await run()).filter(e => e['event.name'] === 'other')).toEqual([]);

    // Resume, use more tokens, close: only the increment is reported.
    await appendFile(file, toJsonl([
      ev('session.resume', {}, T0 + 40_000),
      shutdownEvent(T0 + 41_000, totals(1600, 90)),
    ]));
    const later = (await run()).filter(e => e['event.name'] === 'other');
    expect(later.map(e => [e['gen_ai.usage.input_tokens'], e['gen_ai.usage.output_tokens']])).toEqual([[600, 40]]);
  });

  it('remembers reported totals across a restart', async () => {
    const a = await makeInput();
    await a.run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl([...textOnlyTurn(), shutdownEvent(T0 + 9_000, totals(1000, 50))]));
    await a.run();
    await appendFile(file, toJsonl([ev('session.resume', {}, T0 + 20_000), shutdownEvent(T0 + 21_000, totals(1000, 50))]));
    const b = await makeInput();
    expect((await b.run()).filter(e => e['event.name'] === 'other')).toEqual([]);
  });
});

describe('session cost across checkpoints', () => {
  const cost = (entries: AgentActivityEntry[]) =>
    entries.filter(e => e['agent.copilot.usage.source'] !== undefined)
      .map(e => [e['agent.copilot.usage.source'], e['agent.copilot.usage.nano_aiu'], e['agent.copilot.usage.premium_requests']]);
  const second = () => [
    ev('user.message', { content: 'more', interactionId: 'i-2', messageId: 'm-2' }, T0 + 20_000),
    ev('assistant.turn_start', { turnId: '5', interactionId: 'i-2' }, T0 + 20_100),
    ev('assistant.message', { messageId: 'am-5', content: 'ok', model: 'model-a', apiCallId: 'api-5', turnId: '5', interactionId: 'i-2' }, T0 + 21_000),
  ];

  it('reports cost for a session that never closes and only the increment afterwards', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl([...textOnlyTurn(), checkpointEvent(T0 + 3_000, 100, 1)]));
    expect(cost(await run())).toEqual([['checkpoint', 100, 1]]);
    await appendFile(file, toJsonl([...second(), checkpointEvent(T0 + 22_000, 260, 2)]));
    expect(cost(await run())).toEqual([['checkpoint', 160, 1]]);
  });

  it('does not count the cost twice when the shutdown repeats the reported totals', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl([...textOnlyTurn(), checkpointEvent(T0 + 3_000, 100, 1)]));
    await run();
    await appendFile(file, toJsonl([shutdownEvent(T0 + 9_000, { 'model-a': { inputTokens: 10, outputTokens: 1, totalNanoAiu: 100 } }, { nanoAiu: 100, premiumRequests: 1 })]));
    const entries = await run();
    expect(cost(entries)).toEqual([]);
    expect(entries.filter(e => e['gen_ai.usage.input_tokens'] !== undefined)).toHaveLength(1);
  });

  it('remembers reported cost across a restart', async () => {
    const a = await makeInput();
    await a.run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl([...textOnlyTurn(), checkpointEvent(T0 + 3_000, 100, 1)]));
    expect(cost(await a.run())).toEqual([['checkpoint', 100, 1]]);
    await appendFile(file, toJsonl([checkpointEvent(T0 + 4_000, 100, 1)]));
    const b = await makeInput();
    expect(cost(await b.run())).toEqual([]);
  });
});
