import { describe, expect, it } from 'vitest';
import { enrichNativeToolEvents, nativeTaskContent, nativeToolObservations, parseNativeContent } from '../../../src/inputs/doubao-work/doubao-work-content.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoToolLine } from '../../helpers/doubao-work-fixture.js';
import { parseDoubaoLogLine } from '../../../src/inputs/doubao-work/doubao-work-log.js';
import { maskAgentActivityEntry } from '../../../src/mask/entry-masker.js';

const actor = 'm_synthetic';
const nano = (offset: number) => (BigInt(DOUBAO_EPOCH + offset) * 1_000_000n).toString();
const assignment = (offset: number, body: string) => `## [${new Date(DOUBAO_EPOCH + offset).toISOString()}] 需求\n${body}\n`;
const rows = [
  { role: 'assistant', content: 'INTERMEDIATE_PLAN', tool_calls: [{ id: 'call-one', function: { name: 'PowerShell', arguments: { command: 'synthetic command' } } }] },
  { role: 'tool', tool_call_id: 'call-one', content: 'TOOL_OUTPUT' },
  { role: 'assistant', content: 'FINAL_ANSWER' },
];
const lines = (values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n') + '\n';

describe('Doubao native I/O and decision identity', () => {
  it('extracts the exact current request and final answer without intermediate/tool content', () => {
    const content = parseNativeContent({ [actor]: lines(rows) }, { [actor]: '# Assignment\n' + assignment(10, 'USER_REQUEST') })!;
    expect(nativeTaskContent(content, actor, DOUBAO_EPOCH, nano(3000), ['call-one']))
      .toEqual({ input: 'USER_REQUEST', output: 'FINAL_ANSWER' });
    expect(content.calls['call-one'].arguments).toBe('{"command":"synthetic command"}');
    expect(content.calls['call-one'].result).toBe('TOOL_OUTPUT');
  });

  it('never carries an earlier assignment or answer into a reused request', () => {
    const old = assignment(-3000, 'OLD_REQUEST');
    const content = parseNativeContent({ [actor]: lines(rows) }, { [actor]: old })!;
    expect(nativeTaskContent(content, actor, DOUBAO_EPOCH, nano(3000), ['call-one'])).toEqual({});
    const reused = parseNativeContent({ [actor]: lines(rows) }, { [actor]: old + assignment(10, 'NEW_REQUEST') })!;
    // Without a call/result belonging to this work, a historical tail is not a final answer.
    expect(nativeTaskContent(reused, actor, DOUBAO_EPOCH, nano(3000), [])).toEqual({ input: 'NEW_REQUEST' });
  });

  it('omits ambiguous or superseded content instead of selecting the latest by proximity', () => {
    const ambiguous = parseNativeContent({ [actor]: lines(rows) }, { [actor]: assignment(10, 'ONE') + assignment(20, 'TWO') })!;
    expect(nativeTaskContent(ambiguous, actor, DOUBAO_EPOCH, nano(3000), ['call-one'])).toEqual({});
    const superseded = parseNativeContent({ [actor]: lines(rows) }, { [actor]: assignment(10, 'ONE') + assignment(4000, 'FUTURE') })!;
    expect(nativeTaskContent(superseded, actor, DOUBAO_EPOCH, nano(3000), ['call-one'])).toEqual({});
  });

  it('retains one native decision ID for parallel calls, with exact call/result identity and names', () => {
    const source = [
      { role: 'assistant', tool_calls: [
        { id: 'parallel-a', function: { name: 'PowerShell', arguments: '{"command":"one"}' } },
        { id: 'parallel-b', function: { name: 'Read', arguments: { file_path: 'two' } } },
      ] },
      { role: 'tool', tool_call_id: 'parallel-b', content: 'TWO' },
      { role: 'tool', tool_call_id: 'parallel-a', content: 'ONE' },
    ];
    const content = parseNativeContent({ [actor]: lines(source) }, {})!;
    expect(content.calls['parallel-a'].decisionId).toBe(content.calls['parallel-b'].decisionId);
    const events = enrichNativeToolEvents([
      { 'event.name': 'tool.call', 'gen_ai.agent.id': actor, 'gen_ai.tool.call.id': 'parallel-a', 'gen_ai.tool.name': 'Bash' },
      { 'event.name': 'tool.result', 'gen_ai.agent.id': actor, 'gen_ai.tool.call.id': 'parallel-a', 'gen_ai.tool.name': 'Bash' },
    ], content);
    expect(events[0]['gen_ai.tool.name']).toBe('PowerShell');
    expect(events[0]['gen_ai.tool.call.arguments']).toEqual({ command: 'one' });
    expect(events[0]['loongsuite.doubao_work.local_executor_tool_name']).toBe('Bash');
    expect(events[1]['gen_ai.tool.call.result']).toBe('ONE');
    expect(enrichNativeToolEvents([{ ...events[0], 'gen_ai.agent.id': 'another-agent' }], content)[0])
      .toEqual({ ...events[0], 'gen_ai.agent.id': 'another-agent' });
  });

  it('decodes JSON tool arguments before masking, including an escaped newline before a synthetic API key', () => {
    const key = 'sk-' + 'x'.repeat(24);
    const source = [
      { role: 'assistant', tool_calls: [{ id: 'mask-call', function: { name: 'Write', arguments: JSON.stringify({ content: `total=90\n${key}`, file_path: 'synthetic-file' }) } }] },
      { role: 'tool', tool_call_id: 'mask-call', content: 'written' },
    ];
    const content = parseNativeContent({ [actor]: lines(source) }, {})!;
    const rootEvents = enrichNativeToolEvents([{ 'event.name': 'tool.call', 'gen_ai.agent.id': actor, 'gen_ai.tool.call.id': 'mask-call' }], content);
    const pair = {
      start: parseDoubaoLogLine(doubaoToolLine({ name: 'Write', tcid: 'mask-call', agent_id: actor }, 100).trimEnd(), DOUBAO_FILE)!,
      end: parseDoubaoLogLine(doubaoToolLine({ name: 'Write', toolCallID: 'mask-call', phase: 'execution_settled', status: 'success' }, 200).trimEnd(), DOUBAO_FILE)!,
    };
    const observations = nativeToolObservations([pair], content);
    const masked = maskAgentActivityEntry({ time_unix_nano: nano(100), 'event.id': 'mask-json', 'event.name': 'other', 'user.id': 'test',
      ...rootEvents[0], 'agent.doubao_work.tool_observations': observations }, { mode: 'all', types: [] });
    expect(JSON.stringify(masked)).not.toContain(key);
    expect(masked['gen_ai.tool.call.arguments']).toEqual(expect.objectContaining({ file_path: 'synthetic-file' }));
    expect(observations[0].arguments).toEqual({ content: `total=90\n${key}`, file_path: 'synthetic-file' });
  });

  it('does not promote duplicate IDs or orphan results into content or decision ownership', () => {
    expect(parseNativeContent({ [actor]: lines([rows[0], rows[0]]) }, {})).toBeUndefined();
    expect(parseNativeContent({ [actor]: lines([rows[1]]) }, {})).toBeUndefined();
  });
});
