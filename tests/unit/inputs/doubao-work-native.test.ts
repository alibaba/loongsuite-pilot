import { describe, expect, it } from 'vitest';
import { parseNativeGraph, buildNativeToolEvents } from '../../../src/inputs/doubao-work/doubao-work-native.js';
import { parseDoubaoLogLine } from '../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, DOUBAO_NATIVE_FILES, doubaoCommandLine, doubaoLine, doubaoToolLine } from '../../helpers/doubao-work-fixture.js';

describe('Doubao native identity evidence and log-only tool observations', () => {
  const root = { turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH, conversationId: 'synthetic-conversation', updatedMs: DOUBAO_EPOCH,
    terminal: parseDoubaoLogLine(doubaoLine('on_message_session_end'), DOUBAO_FILE)! };
  const pair = {
    start: parseDoubaoLogLine(doubaoToolLine({ agent_id: 's_nativeLeaf', name: 'TaskOutput', tcid: 'native-tool' }, 6000, 999).trimEnd(), DOUBAO_FILE)!,
    end: parseDoubaoLogLine(doubaoToolLine({ name: 'TaskOutput', toolCallID: 'native-tool', phase: 'execution_settled', status: 'success' }, 6001, 123).trimEnd(), DOUBAO_FILE)!,
  };
  it('projects only sandbox actor identity from the exact producer', () => {
    const line = doubaoCommandLine('s_nativeLeaf', 'synthetic-sandbox').trimEnd();
    expect(parseDoubaoLogLine(line, DOUBAO_FILE)?.command).toEqual({ agentId: 's_nativeLeaf', sandboxId: 'synthetic-sandbox', id: 'command-s_nativeLeaf' });
    expect(parseDoubaoLogLine(line.replace('local-file-local-tools-sse-wiring.ts', 'unrelated.ts'), DOUBAO_FILE)).toBeUndefined();
    expect(parseDoubaoLogLine(line.replace('"name":"sandbox"', '"name":"other"'), DOUBAO_FILE)).toBeUndefined();
  });
  it('requires matching create_agent call/result and native parent IDs, without copying instructions', () => {
    const graph = parseNativeGraph(DOUBAO_NATIVE_FILES)!;
    expect(graph.edges.s_nativeLeaf).toEqual({ child: 's_nativeLeaf', parent: 'o_nativeOrg', callId: 'native-child-create', threadId: '102' });
    expect(JSON.stringify(graph)).not.toContain('SYNTHETIC_PRIVATE');
    expect(parseNativeGraph({ ...DOUBAO_NATIVE_FILES, o_nativeOrg: DOUBAO_NATIVE_FILES.o_nativeOrg.replace('parent_id: o_nativeOrg', 'parent_id: unrelated') })).toBeUndefined();
    expect(parseNativeGraph({ ...DOUBAO_NATIVE_FILES, m_secondMain: '' })).toBeUndefined();
    expect(parseNativeGraph({ ...DOUBAO_NATIVE_FILES, o_nativeOrg: DOUBAO_NATIVE_FILES.o_nativeOrg + '{half' })).toBeUndefined();
  });
  it('emits late tool facts without synthesizing Agent invocation boundaries', () => {
    const entries = buildNativeToolEvents('synthetic-scope', root, parseNativeGraph(DOUBAO_NATIVE_FILES)!, pair, Date.now());
    expect(entries).toHaveLength(2);
    expect(entries[0].time_unix_nano).toBe(pair.start.timeNano);
    expect(entries[1].time_unix_nano).toBe(pair.end.timeNano);
    expect(entries[1]['gen_ai.tool.call.duration']).toBe(0.124);
    expect(entries[0]['gen_ai.turn.id']).toBeUndefined();
    expect(entries[0]['loongsuite.doubao_work.root_turn_id']).toBe(root.turnId);
    expect(entries[0]['loongsuite.doubao_work.trace_role']).toBe('log_only');
    expect(entries.every(e => e['gen_ai.turn.start'] === undefined && e['gen_ai.turn.end'] === undefined)).toBe(true);
    expect(entries).toEqual(buildNativeToolEvents('synthetic-scope', root, parseNativeGraph(DOUBAO_NATIVE_FILES)!, pair, Date.now()).map((entry, i) => ({ ...entry, observed_time_unix_nano: entries[i].observed_time_unix_nano })));
    expect(JSON.stringify(entries)).not.toMatch(/SYNTHETIC_PRIVATE|gen_ai\.usage|request\.model|selected_skills/);
    expect(buildNativeToolEvents('synthetic-scope', root, { main: 'm_nativeMain', edges: {} }, pair, Date.now())).toEqual([]);
    expect(buildNativeToolEvents('synthetic-scope', root, parseNativeGraph(DOUBAO_NATIVE_FILES)!, { ...pair, end: { ...pair.end, timeNano: pair.start.timeNano } }, Date.now())).toEqual([]);
  });
});
