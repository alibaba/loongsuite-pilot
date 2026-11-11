import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './subagent-fixture.mjs';
import { parseSubagentRecords } from '../../../../assets/hooks/qwen-code-cli/subagents.mjs';

let directory, f;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-subagent-')); f = fixture(directory); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const children = records => records.filter(r => r['gen_ai.agent.scope'] === 'subagent');
const llms = records => records.filter(r => r['event.name'] === 'llm.response');
const status = records => records.find(r => r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'root-call')['agent.qwen-code-cli.subagent.collection'];

describe('foreground subagent collection', () => {
  it('emits nested agents in the root trace with one LLM per round and native usage', () => {
    const records = f.run();
    expect(new Set(records.map(r => r.trace_id)).size).toBe(1);
    expect(new Set(records.map(r => r['gen_ai.turn.id'])).size).toBe(1);
    expect(llms(children(records))).toHaveLength(3);
    expect(llms(children(records)).map(r => r['gen_ai.usage.input_tokens']).sort((a,b) => a-b)).toEqual([5,10,12]);
    expect(new Set(children(records).map(r => r['gen_ai.agent.depth']))).toEqual(new Set([1,2]));
    expect(status(records)).toBe('collected');
    const childTool = records.find(r => r['gen_ai.agent.id'] === 'child' && r['event.name'] === 'tool.call');
    expect(records.find(r => r['gen_ai.agent.id'] === 'grandchild')['gen_ai.subagent.parent_tool_call.id']).toBe(childTool['gen_ai.tool.call.id']);
    expect(records.at(-1)['gen_ai.turn.end']).toBe(true);
    expect(records.at(-1)['gen_ai.agent.scope']).toBeUndefined();
  });

  it('does not replay children after another Stop process / restart', () => {
    const first = f.run();
    expect(f.run()).toEqual(first);
  });

  it('does not replay historic children on a later main turn', () => {
    f.run();
    f.write(f.transcript, [...f.main, f.user(20, 'New request'), f.round(21, 'New answer')]);
    const records = f.run();
    expect(llms(children(records))).toHaveLength(3);
    expect(new Set(records.map(r => r['gen_ai.turn.id'])).size).toBe(2);
  });

  it('marks background execution without collecting its descendants', () => {
    f.writeChild('child', null, 'root-call', f.child, { isBackgrounded: true });
    const records = f.run();
    expect(status(records)).toBe('unsupported_background');
    expect(children(records)).toHaveLength(0);
  });

  it.each(['failed','cancelled'])('preserves %s child lifecycle without changing the parent outcome', lifecycle => {
    f.writeChild('child', null, 'root-call', f.child, { status: lifecycle });
    const records = f.run();
    expect(children(records).find(r => r['gen_ai.agent.id'] === 'child')['agent.qwen-code-cli.subagent.status']).toBe(lifecycle);
    expect(records.at(-1)['agent.qwen-code-cli.subagent.status']).toBeUndefined();
  });

  it('does not treat a SubagentStop / running metadata as completion', () => {
    f.writeChild('child', null, 'root-call', f.child, { status: 'running' });
    const records = f.run();
    expect(status(records)).toBe('incomplete');
    expect(children(records)).toHaveLength(0);
  });

  it('marks unavailable metadata rather than inventing parent identity', () => {
    fs.rmSync(path.join(f.children, 'agent-child.meta.json'));
    const records = f.run();
    expect(status(records)).toBe('metadata_missing');
    expect(children(records)).toHaveLength(0);
  });

  it('rejects two agents claiming the same parent tool', () => {
    f.writeChild('other', null, 'root-call', f.child);
    const records = f.run();
    expect(status(records)).toBe('ambiguous_parent');
    expect(children(records)).toHaveLength(0);
  });

  it('does not export a partially written child file as complete', () => {
    fs.appendFileSync(path.join(f.children, 'agent-child.jsonl'), '{"type":');
    const records = f.run();
    expect(status(records)).toBe('incomplete');
    expect(children(records)).toHaveLength(0);
  });

  it('marks an unavailable child transcript without breaking parent collection', () => {
    fs.rmSync(path.join(f.children, 'agent-child.jsonl'));
    const records = f.run();
    expect(status(records)).toBe('transcript_unavailable');
    expect(llms(records)).toHaveLength(2);
  });

  it('does not invent unknown token usage or response model', () => {
    const child = structuredClone(f.child);
    delete child[1].usageMetadata;
    f.writeChild('child', null, 'root-call', child);
    const response = llms(f.run()).find(r => r['gen_ai.agent.id'] === 'child');
    expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.total_tokens']).toBeUndefined();
    expect(response['gen_ai.response.model']).toBeUndefined();
  });

  it('applies content-off to child prompts, outputs, and tool payloads', () => {
    fs.writeFileSync(path.join(f.data, 'config.json'), JSON.stringify({ agents: { 'qwen-code-cli': { captureMessageContent: false } } }));
    const records = f.run();
    expect(children(records).length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain('SENSITIVE');
    for (const r of children(records)) {
      expect(r['gen_ai.input.messages_delta']).toBeUndefined();
      expect(r['gen_ai.output.messages']).toBeUndefined();
      expect(r['gen_ai.tool.call.arguments']).toBeUndefined();
      expect(r['gen_ai.tool.call.result']).toBeUndefined();
    }
  });

  it('inherits parent invocation attributes while keeping each child identity', () => {
    const records = f.run({}, {
      AGENTTEAMS_WORKER_NAME: 'parent-worker', AGENTTEAMS_INSTANCE_ID: 'test-instance',
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES: 'multica.issue.id=test-issue',
    });
    for (const r of children(records)) {
      expect(r.resourceAttributes['agentteams.instance.id']).toBe('test-instance');
      expect(r['multica.issue.id']).toBe('test-issue');
      expect(['child', 'grandchild']).toContain(r['gen_ai.agent.name']);
    }
    expect(records.at(-1)['gen_ai.agent.name']).toBe('parent-worker');
  });

  it('rejects a file with a different agent identity', () => {
    const file = path.join(f.children, 'agent-child.jsonl');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('"agentId":"child"', '"agentId":"wrong"'));
    const records = f.run();
    expect(status(records)).toBe('transcript_unavailable');
    expect(children(records)).toHaveLength(0);
  });

  it('does not attribute a later resumed run to the original parent invocation', () => {
    f.writeChild('grandchild', 'child', 'nested-call', [...f.grandchild, f.user(50, 'Later request'), f.round(51, 'Later response', 999)]);
    const responses = llms(children(f.run()));
    expect(responses).toHaveLength(3);
    expect(responses.some(r => r['gen_ai.usage.input_tokens'] === 999)).toBe(false);
  });

  it('retains the parent checkpoint until a partial last line is completed', () => {
    const original = fs.readFileSync(f.transcript, 'utf8');
    fs.writeFileSync(f.transcript, original.slice(0, -8));
    expect(f.run()).toHaveLength(0);
    const stateFile = path.join(f.data, 'state/qwen-code-cli/sessions', `${f.sessionId}.json`);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).transcript_offset).toBe(0);
    fs.writeFileSync(f.transcript, original);
    expect(llms(children(f.run()))).toHaveLength(3);
  });

  it('separates reused native tool IDs across agent runs', () => {
    const second = f.child.map((r, i) => ({ ...structuredClone(r), uuid: `second-${i}`, agentRunId: 'run-2' }));
    const source = [...f.child, ...second].map(r => ({ ...r, agentId: 'child', isSidechain: true }));
    const turn = parseSubagentRecords(source, { agentId: 'child', parentSessionId: f.sessionId });
    const tools = turn.llmCalls.flatMap(l => l.declaredTools);
    expect(tools).toHaveLength(2);
    expect(tools[0].callId).not.toBe(tools[1].callId);
    expect(tools.every(t => t.result)).toBe(true);
  });

  it('does not positionally pair an unmatched child tool with another tool result', () => {
    const source = f.child.map(r => ({ ...r, agentId: 'child', isSidechain: true }));
    source[3] = { ...source[3], toolCallResult: { callId: 'wrong-call' } };
    const turn = parseSubagentRecords(source, { agentId: 'child', parentSessionId: f.sessionId });
    expect(turn.llmCalls[0].declaredTools[0].result).toBeNull();
  });
});
