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
