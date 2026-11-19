import { describe, expect, it } from 'vitest';
import { parseNativeContent } from '../../../src/inputs/doubao-work/doubao-work-content.js';
import { reconstructNativeRounds } from '../../../src/inputs/doubao-work/doubao-work-rounds.js';
import { maskAgentActivityEntry } from '../../../src/mask/entry-masker.js';
import { DOUBAO_EPOCH } from '../../helpers/doubao-work-fixture.js';

const actor = 'm_synthetic';
const end = (BigInt(DOUBAO_EPOCH + 30_000) * 1_000_000n).toString();
const assignment = (body: string, offset = 10) => `## [${new Date(DOUBAO_EPOCH + offset).toISOString()}] 需求\n${body}\n`;
const assistant = (ids: string[]) => ({ role: 'assistant', content: 'visible plan', tool_calls: ids.map(id => ({ id, function: { name: 'Read', arguments: { file_path: id } } })) });
const result = (id: string) => ({ role: 'tool', tool_call_id: id, content: `result ${id}` });
const final = { role: 'assistant', content: 'visible final' };
const serialize = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
function content(rows: unknown[], assignments = assignment('CURRENT')) {
  return parseNativeContent({ [actor]: serialize(rows) }, { [actor]: assignments });
}

describe('visible assistant-round reconstruction', () => {
  it('keeps the exact UTF-8/escaped JSON suffix and stable source identity for long reused history', () => {
    const history = [{ role: 'user', content: 'OLD' }, ...Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:` + '中文😀"\\\n'.repeat(120) })), { role: 'user', content: 'CURRENT' }];
    const rows = [...history, final], parsed = content(rows, assignment('OLD', -30_000) + assignment('CURRENT'));
    const rebuilt = reconstructNativeRounds(parsed, actor, DOUBAO_EPOCH, end, [])!;
    const expected = history.map(row => ({ role: row.role, parts: [{ type: 'text', content: row.content }] }));
    while (Buffer.byteLength(JSON.stringify(expected)) > 64 * 1024 && expected.length > 1) expected.shift();
    expect(rebuilt.rounds).toHaveLength(1); expect(rebuilt.rounds[0].inputMessages).toEqual(expected);
    expect(rebuilt.rounds[0].sourceIndex).toBe(rows.length - 1); expect(rebuilt.rounds[0].inputTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(rebuilt.rounds[0].inputMessages))).toBeLessThanOrEqual(64 * 1024);
  });

  it('retains the oversized-single-input omission rule', () => {
    const c = content([final], assignment('"'.repeat(40_000)));
    expect(reconstructNativeRounds(c, actor, DOUBAO_EPOCH, end, []))
      .toEqual({ rounds: [], omittedRounds: 1, duplicateAssistantRows: 0 });
  });

  it.each([
    '/Users/synthetic/Library/Application Support/DoubaoWork/Profile 2/.doubaowork/agent_mode/workspace/.skills/doubao-human-signal/SKILL.md',
    'C:\\Users\\synthetic\\AppData\\Local\\DoubaoWork\\User Data\\Profile 3\\.doubaowork\\agent_mode\\workspace\\.skills\\doubao-human-signal\\SKILL.md',
    '/Users/synthetic/Library/Application Support/Doubao/Profile 2/.doubao/agent_mode/workspace/.skills/doubao-human-signal/SKILL.md',
    'C:\\Users\\synthetic\\AppData\\Local\\Doubao\\User Data\\Default\\.doubao\\agent_mode\\workspace\\.skills\\doubao-human-signal\\SKILL.md',
  ])('matches an expanded native Skill link without duplicating the user input (%s)', skillPath => {
    const demand = '[去AI味](skill://doubao-human-signal?type=2&id=123)\nRead then Write.';
    const expanded = `[去AI味](<${skillPath}>)\nRead then Write.`;
    const rows = [{ role: 'user', content: expanded }, assistant(['read']), result('read'), assistant(['write']), result('write'), final];
    const rebuilt = reconstructNativeRounds(content(rows, assignment(demand)), actor, DOUBAO_EPOCH, end, ['read', 'write'])!;
    expect(rebuilt?.rounds).toHaveLength(3);
    expect(rebuilt.rounds.map(round => round.inputMessages.length)).toEqual([1, 3, 5]);
    expect(rebuilt.rounds[0].inputMessages[0].parts[0].content).toBe(expanded);
  });

  it('selects an expanded Skill on reuse while preserving historical messages only as input', () => {
    const demand = '[去AI味](skill://doubao-human-signal?type=2&id=123)\nCURRENT';
    const expanded = '[去AI味](</Users/synthetic/.doubaowork/agent_mode/workspace/.skills/doubao-human-signal/SKILL.md>)\nCURRENT';
    const rows = [assistant(['old']), result('old'), { ...final, content: 'OLD' }, { role: 'user', content: expanded }, assistant(['new']), result('new'), final];
    const rebuilt = reconstructNativeRounds(content(rows, assignment('OLD', -30_000) + assignment(demand)), actor, DOUBAO_EPOCH, end, ['new'])!;
    expect(rebuilt?.rounds).toHaveLength(2);
    expect(rebuilt.rounds.flatMap(round => round.callIds)).toEqual(['new']);
    expect(rebuilt.rounds[0].inputMessages.at(-1)!.parts[0].content).toBe(expanded);
  });

  it.each([
    '[去AI味](</Users/synthetic/.doubaowork/agent_mode/workspace/.skills/other-skill/SKILL.md>)\nCURRENT',
    '[去AI味](https://example.test/doubao-human-signal/SKILL.md)\nCURRENT',
    '[去AI味](</unrelated/.skills/doubao-human-signal/SKILL.md>)\nCURRENT',
    '[去AI味](</Users/synthetic/.doubaowork/agent_mode/workspace/.skills/doubao-human-signal/SKILL.md>)\nOTHER',
  ])('does not treat an unrelated link or changed instruction as the current request (%s)', expanded => {
    const demand = '[去AI味](skill://doubao-human-signal?type=2&id=123)\nCURRENT';
    const rows = [{ role: 'user', content: expanded }, assistant(['new']), result('new'), final];
    expect(reconstructNativeRounds(content(rows, assignment(demand)), actor, DOUBAO_EPOCH, end, ['new'])).toBeUndefined();
  });

  it('rejects ambiguous repeated Skill demands instead of selecting the last matching text', () => {
    const demand = '[去AI味](skill://doubao-human-signal?type=2&id=123)\nCURRENT';
    const expanded = '[去AI味](</Users/synthetic/.doubaowork/agent_mode/workspace/.skills/doubao-human-signal/SKILL.md>)\nCURRENT';
    const rows = [{ role: 'user', content: demand }, assistant(['old']), result('old'), final,
      { role: 'user', content: expanded }, assistant(['new']), result('new'), final];
    expect(reconstructNativeRounds(content(rows, assignment(demand)), actor, DOUBAO_EPOCH, end, ['new'])).toBeUndefined();
  });

  it('keeps three parallel tool calls in one assistant round and carries their results into the next input', () => {
    const rows = [assistant(['write']), result('write'), assistant(['a', 'b', 'c']), result('b'), result('c'), result('a'), assistant(['recover']), result('recover'), final];
    const rebuilt = reconstructNativeRounds(content(rows), actor, DOUBAO_EPOCH, end, ['write', 'a', 'b', 'c', 'recover'])!;
    expect(rebuilt.rounds).toHaveLength(4);
    expect(rebuilt.rounds.map(round => round.inputMessages.length)).toEqual([1, 3, 7, 9]);
    expect(rebuilt.rounds.map(round => round.callIds.length)).toEqual([1, 3, 1, 0]);
    expect(rebuilt.rounds[1].outputMessages[0].parts.filter(part => part.type === 'tool_call').map(part => part.id)).toEqual(['a', 'b', 'c']);
    expect(rebuilt.rounds[2].inputMessages.filter(message => message.role === 'tool').flatMap(message => message.parts).map(part => part.id))
      .toEqual(['write', 'b', 'c', 'a']);
    expect(JSON.stringify(rebuilt)).not.toMatch(/requestModel|responseModel|usage|startNano|endNano|finish_reason/);
    expect(reconstructNativeRounds(content(rows), actor, DOUBAO_EPOCH, end, ['write', 'a', 'b', 'c', 'recover']))
      .toEqual(rebuilt);
  });

  it('selects only a reused request while retaining earlier visible context as context', () => {
    const rows = [assistant(['old']), result('old'), { ...final, content: 'OLD_ANSWER' }, { role: 'user', content: 'CURRENT' }, assistant(['new']), result('new'), final];
    const c = content(rows, assignment('OLD', -30_000) + assignment('CURRENT'));
    const rebuilt = reconstructNativeRounds(c, actor, DOUBAO_EPOCH, end, ['new'])!;
    expect(rebuilt.rounds).toHaveLength(2);
    expect(rebuilt.rounds[0].sourceIndex).toBe(4);
    expect(rebuilt.rounds[0].inputMessages.at(-1)!.parts[0].content).toBe('CURRENT');
    expect(rebuilt.rounds[0].inputMessages[0].parts[0].content).toBe('OLD');
    expect(rebuilt.rounds.flatMap(round => round.callIds)).toEqual(['new']);
  });

  it('keeps a uniquely delimited reused demand when a same-time native completion reminder is appended', () => {
    const rows = [assistant(['old']), result('old'), final, { role: 'user', content: 'CURRENT' }, assistant(['new']), result('new'), final];
    const tasks = assignment('OLD', -30_000) + assignment('CURRENT');
    const clean = reconstructNativeRounds(content(rows, tasks), actor, DOUBAO_EPOCH, end, ['new']);
    const augmented = content(rows, tasks + assignment('<system-reminder>\n<subagent-result>completed</subagent-result>\n</system-reminder>'));
    expect(reconstructNativeRounds(augmented, actor, DOUBAO_EPOCH, end, ['new'])).toEqual(clean);
    expect(clean?.rounds).toHaveLength(2);
  });

  it('matches the client-removed reminder prefix without changing visible input or source IDs', () => {
    const demand = '\n\nCURRENT';
    const rows = [{ role: 'user', content: demand }, assistant(['new']), result('new'), final];
    const wrapped = '<system-reminder>\nNative execution mode: synthetic.\n</system-reminder>' + demand;
    const rebuilt = reconstructNativeRounds(content(rows, assignment(wrapped)), actor, DOUBAO_EPOCH, end, ['new'])!;
    const clean = reconstructNativeRounds(content(rows, assignment(demand)), actor, DOUBAO_EPOCH, end, ['new'])!;
    expect(rebuilt?.rounds).toHaveLength(2);
    expect(rebuilt).toEqual(clean);
    expect(rebuilt.rounds[0].inputMessages).toEqual([{ role: 'user', parts: [{ type: 'text', content: demand }] }]);
  });

  it.each([
    assignment('CURRENT') + assignment('ANOTHER_REAL_DEMAND'),
    assignment('CURRENT') + assignment('CURRENT'),
    assignment('CURRENT') + assignment('<system-reminder>completed</system-reminder>', 11),
    assignment('CURRENT') + assignment('<system-reminder>unfinished'),
    assignment('CURRENT') + assignment('<system-reminder>completed</system-reminder>\nALSO A REAL DEMAND'),
  ])('does not relax actual demand ambiguity or malformed reminder boundaries (%s)', tasks => {
    const rows = [{ role: 'user', content: 'CURRENT' }, assistant(['new']), result('new'), final];
    expect(reconstructNativeRounds(content(rows, tasks), actor, DOUBAO_EPOCH, end, ['new'])).toBeUndefined();
  });

  it('does not discard a reminder-shaped user message or infer an absent reused delimiter', () => {
    const reminder = '<system-reminder>completed</system-reminder>';
    const tasks = assignment('CURRENT') + assignment(reminder);
    const literal = [{ role: 'user', content: 'CURRENT' }, assistant(['old']), result('old'),
      { role: 'user', content: reminder }, assistant(['new']), result('new'), final];
    expect(reconstructNativeRounds(content(literal, tasks), actor, DOUBAO_EPOCH, end, ['new'])).toBeUndefined();
    expect(reconstructNativeRounds(content([assistant(['new']), result('new'), final], assignment('OLD', -30_000) + tasks), actor, DOUBAO_EPOCH, end, ['new'])).toBeUndefined();
  });

  it('does not guess a missing reused-request delimiter or an unrelated call', () => {
    const c = content([assistant(['old']), result('old'), final], assignment('OLD', -30_000) + assignment('CURRENT'));
    expect(reconstructNativeRounds(c, actor, DOUBAO_EPOCH, end, [])).toBeUndefined();
    expect(reconstructNativeRounds(content([assistant(['a']), result('a'), final]), actor, DOUBAO_EPOCH, end, ['missing'])).toBeUndefined();
  });

  it('stops a local execution fragment before subsequent organizer coordination', () => {
    const rows = [assistant(['a']), result('a'), final, { role: 'user', content: 'LATER' }, assistant(['later']), result('later'), final];
    const c = content(rows, assignment('CURRENT') + assignment('LATER', 60_000));
    const rebuilt = reconstructNativeRounds(c, actor, DOUBAO_EPOCH, end, ['a'], 'local_execution_fragment')!;
    expect(rebuilt.rounds.map(round => round.callIds)).toEqual([['a'], []]);
    expect(JSON.stringify(rebuilt)).not.toContain('LATER');
    expect(reconstructNativeRounds(c, actor, DOUBAO_EPOCH, end, [], 'local_execution_fragment')).toBeUndefined();
  });

  it('does not double-count an adjacent duplicate final message', () => {
    const rebuilt = reconstructNativeRounds(content([assistant(['a']), result('a'), final, { ...final, tool_calls: [] }]), actor, DOUBAO_EPOCH, end, ['a'])!;
    expect(rebuilt.rounds).toHaveLength(2);
    expect(rebuilt.duplicateAssistantRows).toBe(1);
  });

  it('bounds round expansion and reports omitted rows', () => {
    const rows = Array.from({ length: 70 }, (_, i) => ({ role: 'assistant', content: `answer ${i}` }));
    const rebuilt = reconstructNativeRounds(content(rows), actor, DOUBAO_EPOCH, end, [])!;
    expect(rebuilt.rounds).toHaveLength(64);
    expect(rebuilt.omittedRounds).toBe(6);
  });

  it('passes decoded JSON argument content through the normal recursive mask path', () => {
    const key = 'sk-' + 'x'.repeat(24);
    const rows = [{ role: 'assistant', tool_calls: [{ id: 'mask', function: { name: 'Write', arguments: JSON.stringify({ content: `value\n${key}` }) } }] }, result('mask'), final];
    const rebuilt = reconstructNativeRounds(content(rows), actor, DOUBAO_EPOCH, end, ['mask'])!;
    const entry = maskAgentActivityEntry({ time_unix_nano: end, 'event.id': 'mask-rounds', 'event.name': 'other', 'user.id': 'synthetic',
      'agent.doubao_work.assistant_rounds': rebuilt }, { mode: 'all', types: [] });
    expect(JSON.stringify(entry)).not.toContain(key);
    expect(JSON.stringify(rebuilt)).toContain(key);
  });
});
