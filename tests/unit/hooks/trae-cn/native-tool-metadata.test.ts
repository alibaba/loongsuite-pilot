import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cbor from 'cbor';
import { deflateRawSync } from 'node:zlib';
import { HubMetadata } from '../../../../src/inputs/trae-cn-log/hub-metadata.js';
import { NativeToolMetadata } from '../../../../src/inputs/trae-cn-log/native-tool-metadata.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

it('resumes split compressed records and separates concurrent turns in one session by native trace ID', async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), 'trae-native-'));
  const state = new StateStore(path.join(run, 'state'));
  const hub = new HubMetadata(path.join(run, 'hub'));
  let reader = new NativeToolMetadata(state, hub);
  try {
    const dir = path.join(run, 'Modular');
    await mkdir(dir);
    const file = path.join(dir, 'ai_agent-0-2026-11-19.alaudalog');
    const header = Buffer.alloc(178);
    header.write('AalG'); header.write('Atab', 8); header.writeUInt32LE(152, 16);
    header.write('AALG', 152); header.writeUInt32LE(65536, 156); header.writeUInt32LE(6, 168);
    await writeFile(file, header);
    const entries: AgentActivityEntry[] = [];
    expect(await reader.collect(run, entries, false)).toBe(true);
    const traceA = 'a'.repeat(32), traceB = 'b'.repeat(32);
    const record = (trace: string, message: string, extra: Record<string,string>) => cbor.encode({
      time: [2026, 323, 8, 4, 4, 1, 0, 0, 0],
      fields: Object.fromEntries(Object.entries({ message, trace_id: trace, secret: 'never-export', ...extra })
        .map(([k,v]) => [k,Buffer.from(v)])),
    });
    const records = [traceA,traceB].map(trace => record(trace, 'context resolve applied to task request',
      { session_id: '1'.repeat(24), turn_id: trace.slice(0,24) }));
    for (const name of ['Shell','Shell','Read','Read','Read']) {
      const fields = { tool_name: name, toolcall_id: 'call_' + records.length };
      records.push(record(traceA,'tool execution started', fields), record(traceA,'tool execution started', fields));
    }
    const parent = '847f3047-50bc-52ae-902b-fc1c6049e676';
    const child = '19e2e050-31d4-4d99-be08-5efb578b8f79';
    for (const call of ['first', 'second', 'third', 'unstarted']) {
      records.push(record(traceA, 'async subagent commit metadata', {
        conversation_id: '1'.repeat(24), parent_turn_id: traceA.slice(0,24), parent_agent_run_id: parent,
        toolcall_name: 'Task', async_action: 'run_sub_agent', phase: 'submit_subagent_initial_commit', toolcall_id: call,
      }));
      if (call !== 'unstarted') {
        const start = record(traceA, 'starting SubAgent through commit_results', { toolcall_id: call, agent_run_id: parent });
        records.push(start, start);
      }
    }
    records.push(record(traceA, '[subagent→parent] detected parent takeover, returning stream', {
      new_agent_run_id: parent, new_task_id: 'third', source_agent_run_id: child,
    }));
    const reply = '9'.repeat(24);
    const row = (type: string, data: object) => JSON.stringify({ type,
      data: JSON.stringify({ ...data, reply_to_message_id: reply }) });
    const source = path.join(hub.root, 'workspace');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, reply + '.jsonl'), [
      row('metadata', { trace_id: traceB, session_id: '1'.repeat(24), turn_id: traceB.slice(0,24) }),
      row('timing_events', { logid: 'request-id', model_name: 'model-1', data: {
        rs_17_before_request_llm: 1000, rs_18_llm_response_first_token: 1010,
      } }),
      row('plan_item', { agent_run_id: parent, tool_call_info: {
        name: 'Read', meta: { llm_toolcall_id: 'call_2' }, params: 'never-export',
      }, timing: { tool_call_started_at_ms: 1050, tool_call_finished_at_ms: 1067 } }),
    ].join('\n') + '\n');
    await hub.scan();
    records.push(record(traceB,'tool execution started',{ tool_name:'Read', toolcall_id:'call_2' }),
      record(traceB,'chat: runner completed',{turn_id:traceB.slice(0,24)}),
      record(traceA,'chat: runner completed',{turn_id:traceA.slice(0,24)}));
    const compressed = deflateRawSync(Buffer.concat(records));
    const split = Math.floor(compressed.length * .8);
    await appendFile(file, compressed.subarray(0,split));
    await reader.collect(run,entries,true);
    reader.close();
    reader = new NativeToolMetadata(state, hub);
    await appendFile(file,compressed.subarray(split));
    await reader.collect(run,entries,true);
    await reader.collect(run,entries,true);
    expect(entries.filter(e => e.trace_id === traceA && e['event.name'] === 'tool.call')
      .map(e => e['gen_ai.tool.name'])).toEqual(['Shell','Shell','Read','Read','Read']);
    const ordinary = entries.filter(e => e.trace_id === traceB);
    expect(ordinary.map(e => e['gen_ai.span.kind'])).toEqual(['TOOL', 'LLM', 'AGENT', 'ENTRY']);
    expect(ordinary[0].parent_span_id).toBe(ordinary[2].span_id);
    expect(ordinary[1].parent_span_id).toBe(ordinary[2].span_id);
    expect(ordinary[2].parent_span_id).toBe(ordinary[3].span_id);
    expect(ordinary[0].endTimeUnixNano).toBe('1067000000');
    expect(ordinary[0].startTimeUnixNano).toBe('1050000000');
    expect(ordinary[1]['gen_ai.response.time_to_first_token']).toBe(10_000_000);
    expect(ordinary[1]['agent.trae-cn.observed_until']).toBe('first_token');
    const children = entries.filter(e => e['gen_ai.agent.scope'] === 'subagent');
    const parentSpan = entries.find(e => e['gen_ai.agent.invocation.id'] === parent);
    expect(parentSpan?.parent_span_id).toBe(entries.find(e => e.trace_id === traceA && e['gen_ai.span.kind'] === 'ENTRY')?.span_id);
    expect(children.map(e => e['gen_ai.subagent.parent_tool_call.id'])).toEqual(['first', 'second', 'third']);
    expect(children.map(e => e.parent_span_id)).toEqual(Array(3).fill(parentSpan?.span_id));
    expect(children.map(e => e['gen_ai.agent.invocation.id'])).toEqual([undefined, undefined, child]);
    expect(new Set(entries.map(e=>e.span_id)).size).toBe(entries.length);
    expect(JSON.stringify(entries)).not.toContain('never-export');
    expect(JSON.stringify(state.get('trae-cn-log:native-turns:'+run))).not.toContain('never-export');
  } finally {
    reader.close();
    await rm(run,{recursive:true,force:true});
  }
});
