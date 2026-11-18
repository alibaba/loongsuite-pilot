import { expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexTurnJournal } from '../../../src/flushers/codex-turn-journal.js';
import { RoutedTurnJournal } from '../../../src/flushers/routed-turn-journal.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

it('keeps the QwenPaw capacity budget independent of Codex and routes replay and ACKs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routed-journal-'));
  const codex = new CodexTurnJournal(path.join(root, 'codex'), 100, ['codex'], 4096);
  const qwen = new CodexTurnJournal(path.join(root, 'qwenpaw'), 100, ['qwenpaw'], 256);
  const journal = new RoutedTurnJournal([codex, qwen]);
  const entry = (agent: string, id: string, body = '') => ({
    'user.id': 'user', 'gen_ai.agent.type': agent, 'gen_ai.session.id': `s-${id}`,
    'gen_ai.turn.id': `t-${id}`, 'event.id': id, 'event.name': 'other',
    time_unix_nano: '1700000000000000000', content: body,
  }) as AgentActivityEntry;
  try {
    const first = entry('codex', 'first');
    const second = entry('codex', 'second');
    const tooLarge = entry('qwenpaw', 'large', 'x'.repeat(1024));
    await journal.append([first]);
    await expect(journal.append([tooLarge])).rejects.toMatchObject({ name: 'CodexTurnJournalCapacityError' });
    await journal.append([second]);
    const replayed = [];
    for await (const batch of journal.loadBatches()) replayed.push(...batch.entries);
    expect(replayed.map(row => row['event.id']).sort()).toEqual(['first', 'second']);
    await journal.acknowledge([first]);
    expect(await journal.isAcknowledged(first)).toBe(true);
    expect(await journal.isAcknowledged(second)).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('isolates an unreadable QwenPaw recovery directory without accepting its new events', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routed-journal-failure-'));
  const broken = path.join(root, 'not-a-directory');
  await fs.writeFile(broken, 'synthetic failure');
  const codex = new CodexTurnJournal(path.join(root, 'codex'), 100, ['codex']);
  const qwen = new CodexTurnJournal(broken, 100, ['qwenpaw']);
  const journal = new RoutedTurnJournal([codex, qwen], [qwen]);
  const event = (agent: string, id: string) => ({ 'user.id': 'user', 'gen_ai.agent.type': agent,
    'gen_ai.session.id': `s-${id}`, 'gen_ai.turn.id': `t-${id}`, 'event.id': id,
    'event.name': 'other', time_unix_nano: '1700000000000000000' }) as AgentActivityEntry;
  try {
    const first = event('codex', 'first');
    await journal.append([first]);
    const replayed: AgentActivityEntry[] = [];
    for await (const batch of journal.loadBatches()) replayed.push(...batch.entries);
    expect(replayed.map(row => row['event.id'])).toEqual(['first']);
    await journal.append([event('codex', 'second')]);
    await expect(journal.append([event('qwenpaw', 'blocked')])).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
