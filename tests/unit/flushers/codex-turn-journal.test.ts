import { readJournal } from '../../helpers/codex-journal.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CodexTurnJournal, codexTurnJournalGroupKey } from '../../../src/flushers/codex-turn-journal.js';
import { buildAgentActivityEntry } from '../../../src/normalization/entry-builder.js';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function entry(id: string, overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return buildAgentActivityEntry({
    'event.id': id, 'event.name': 'llm.request', 'user.id': 'user-1',
    'gen_ai.agent.type': 'codex', 'gen_ai.session.id': 'child-session',
    'gen_ai.turn.id': 'child-turn', 'gen_ai.agent.parent.invocation.id': 'incoming',
    ...overrides,
  });
}

describe('CodexTurnJournal', () => {
  let directory: string;
  beforeEach(async () => { directory = await createTempDir('codex-turn-journal-'); });
  afterEach(async () => { await cleanupTempDir(directory); });
  const filename = (dir: string, record: AgentActivityEntry) =>
    path.join(dir, `codex-turn-${codexTurnJournalGroupKey(record)}.jsonl`);

  it('restores separate users/sessions/turns and stable records after restart without duplicate event IDs', async () => {
    const records = [entry('a'), entry('b'), entry('c', { 'gen_ai.turn.id': 'turn-2' }),
      entry('d', { 'gen_ai.session.id': 'session-2' }), entry('e', { 'user.id': 'user-2' })];
    const journal = new CodexTurnJournal(directory);
    await Promise.all([journal.append(records), journal.append([records[0]])]);
    const restored = await readJournal(new CodexTurnJournal(directory));
    expect(restored).toHaveLength(4);
    expect(restored.flat().sort((a, b) => a['event.id'].localeCompare(b['event.id']))).toEqual(records);
    expect((await fs.readdir(directory)).every(name => /^codex-turn-[a-f0-9]{64}\.jsonl$/.test(name))).toBe(true);
  });

  it('reads the next pending group only after the previous group is consumed', async () => {
    const journal = new CodexTurnJournal(directory);
    const records = Array.from({ length: 70 }, (_, index) => entry(`event-${index}`, {
      'gen_ai.turn.id': `turn-${index}`,
    }));
    await journal.append(records);
    const iterator = journal.load();
    try {
      const first = await iterator.next();
      expect(first.done).toBe(false);
      await journal.acknowledge(first.value!);
      const next = records.filter(record => record['event.id'] !== first.value![0]['event.id'])
        .sort((a, b) => filename(directory, a).localeCompare(filename(directory, b)))[0];
      await fs.writeFile(filename(directory, next), JSON.stringify({ ...next, 'event.id': 'written-after-yield' }) + '\n');
      const second = await iterator.next();
      expect(second.done).toBe(false);
      expect(second.value![0]['event.id']).toBe('written-after-yield');

    } finally { await iterator.return(undefined); }

  });

  it('preserves complete records before a truncated tail and repairs that tail before appending', async () => {
    const first = entry('first');
    await new CodexTurnJournal(directory).append([first]);
    await fs.appendFile(filename(directory, first), '{"event.id":"partial');
    const restarted = new CodexTurnJournal(directory);
    expect(await readJournal(restarted)).toEqual([[first]]);
    const second = entry('second');
    await restarted.append([second]);
    expect(await readJournal(new CodexTurnJournal(directory))).toEqual([[first, second]]);
  });

  it('reads only owned files and valid matching Codex groups, excluding malformed and foreign records', async () => {
    const record = entry('valid');
    const journal = new CodexTurnJournal(directory);
    await journal.append([record, entry('other-agent', { 'gen_ai.agent.type': 'openclaw' }), entry('missing-turn', { 'gen_ai.turn.id': undefined })]);
    await fs.writeFile(path.join(directory, 'unrelated.jsonl'), JSON.stringify(entry('foreign')) + '\n');
    await fs.appendFile(filename(directory, record), [
      'bad json', JSON.stringify(entry('wrong-group', { 'user.id': 'different-user' })),
      JSON.stringify({ ...record, 'event.id': '' }),
      JSON.stringify({ ...record, 'gen_ai.agent.type': 'openclaw' }), '',
    ].join('\n'));
    expect(await readJournal(journal)).toEqual([[record]]);
  });

  it('uses private permissions and removes only exported group files by records or group key', async () => {
    const first = entry('first');
    const second = entry('second', { 'gen_ai.turn.id': 'another-turn' });
    const journal = new CodexTurnJournal(directory);
    await journal.append([first, second]);
    if (process.platform !== 'win32') {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(filename(directory, first))).mode & 0o777).toBe(0o600);
    }
    await journal.remove([first]);
    expect(await readJournal(journal)).toEqual([[second]]);
    await journal.remove(codexTurnJournalGroupKey(second));
    await journal.remove('../unrelated');
    expect(await readJournal(journal)).toEqual([]);
    await journal.append([first]);
    expect(await readJournal(journal)).toEqual([[first]]);
    expect(await readJournal(new CodexTurnJournal(path.join(directory, 'absent')))).toEqual([]);
  });

  it('persists private metadata-only acknowledgements and suppresses replay after restart', async () => {
    const record = entry('exported', {
      'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'body-must-not-enter-ack' }] }],
    });
    const journal = new CodexTurnJournal(directory);
    await journal.append([record]);
    expect(await journal.isAcknowledged(record)).toBe(false);
    await journal.acknowledge([record]);
    const key = codexTurnJournalGroupKey(record);
    const ackPath = path.join(directory, `codex-done-${key}.json`);
    expect(JSON.parse(await fs.readFile(ackPath, 'utf8'))).toEqual({ version: 1, key });
    if (process.platform !== 'win32') {
      expect((await fs.stat(ackPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
    const restarted = new CodexTurnJournal(directory);
    expect(await restarted.isAcknowledged(record)).toBe(true);
    await restarted.append([record]);
    expect(await readJournal(restarted)).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([`codex-done-${key}.json`]);
    // Generic remove is not an acknowledgement, and cannot undo one.
    await restarted.remove([record]);
    expect(await restarted.isAcknowledged(record)).toBe(true);
  });

  it('ignores residual pending content if acknowledgement was written before a crash', async () => {
    const record = entry('exported');
    await new CodexTurnJournal(directory).append([record]);
    const key = codexTurnJournalGroupKey(record);
    await fs.writeFile(path.join(directory, `codex-done-${key}.json`), JSON.stringify({ version: 1, key }), { mode: 0o600 });
    const restarted = new CodexTurnJournal(directory);
    expect(await restarted.isAcknowledged(record)).toBe(true);
    expect(await readJournal(restarted)).toEqual([]);
    expect(await readJournal(restarted, key)).toEqual([]);
    const before = await fs.readFile(filename(directory, record), 'utf8');
    await restarted.append([entry('source-replay')]);
    expect(await fs.readFile(filename(directory, record), 'utf8')).toBe(before);
  });

  it('cleans residual pending content before evicting its oldest acknowledgement and retains ACK on cleanup failure', async () => {
    const crashed = entry('crashed-after-ack', { 'gen_ai.turn.id': 'old-crashed-turn' });
    const keys = [codexTurnJournalGroupKey(crashed),
      ...Array.from({ length: 9999 }, (_, index) => index.toString(16).padStart(64, '0'))];
    for (let index = 0; index < keys.length; index += 100) {
      await Promise.all(keys.slice(index, index + 100).map(key =>
        fs.writeFile(path.join(directory, `codex-done-${key}.json`), JSON.stringify({ version: 1, key }), { mode: 0o600 })));
    }
    const oldest = path.join(directory, `codex-done-${keys[0]}.json`);
    await fs.utimes(oldest, new Date(0), new Date(0));
    await fs.writeFile(filename(directory, crashed), JSON.stringify(crashed) + '\n', { mode: 0o600 });
    const record = entry('latest');
    const journal = new CodexTurnJournal(directory);
    await journal.acknowledge([record]);
    expect(await journal.isAcknowledged(record)).toBe(true);
    await expect(fs.stat(oldest)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(filename(directory, crashed))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readJournal(new CodexTurnJournal(directory))).toEqual([]);
    expect((await fs.readdir(directory)).filter(name => name.startsWith('codex-done-'))).toHaveLength(10_000);

    // A non-file at the pending path causes a real unlink failure on every platform.
    const blockedAck = path.join(directory, `codex-done-${keys[1]}.json`);
    await fs.utimes(blockedAck, new Date(0), new Date(0));
    await fs.mkdir(path.join(directory, `codex-turn-${keys[1]}.jsonl`));
    const restarted = new CodexTurnJournal(directory);
    await expect(restarted.acknowledge([entry('next', { 'gen_ai.turn.id': 'next-turn' })])).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(blockedAck, 'utf8'))).toEqual({ version: 1, key: keys[1] });
  }, 30_000);
});
