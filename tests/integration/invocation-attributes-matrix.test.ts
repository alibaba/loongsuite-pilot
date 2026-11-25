import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InvocationAttributeStore } from '../../assets/hooks/shared/invocation-attribute-store.mjs';
import { INVOCATION_MESSAGE_ID_FIELD } from '../../assets/hooks/shared/invocation-attributes.mjs';
import { InvocationAttributeJoin } from '../../src/invocation-attributes/join.js';
import { readInvocationAttributeConfig } from '../../src/invocation-attributes/config.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { BaseInput } from '../../src/inputs/base/base-input.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { maskAgentActivityEntry } from '../../src/mask/entry-masker.js';
import { buildDoubaoTaskEvents, parseDoubaoLogLine } from '../../src/inputs/doubao-work/doubao-work-log.js';
import { buildAgentActivityEntry } from '../../src/normalization/entry-builder.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../src/types/index.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine } from '../helpers/doubao-work-fixture.js';
import { MockFlusher } from '../helpers/mock-flusher.js';

const matrix: [string,string,string][] = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/invocation-attributes/entry-matrix.json'),'utf8')).agents;

it('accounts for every agents.d entry plus runtime-only variants', () => {
  const definitions = fs.readdirSync('agents.d').filter(name => name.endsWith('.json')).map(name => name.slice(0,-5));
  expect(new Set(matrix.map(([id]) => id))).toEqual(new Set([...definitions, 'qoder-app', 'qoder-cli', 'wukong']));
});

class ReplayInput extends BaseInput {
  readonly type = CollectionMethod.HookJsonl;
  readonly agentType: ClientType;
  constructor(readonly id:string, agent:string, stateStore:StateStore) {
    super({stateStore,pollIntervalMs:60_000}); this.agentType=agent as ClientType;
  }
  protected async collect(): Promise<AgentActivityEntry[]> { return []; }
}
const now = BigInt(Date.now()) * 1_000_000n;
const attrFields=(r:Record<string,unknown>)=>Object.fromEntries(Object.entries(r).filter(([k])=>k.startsWith('memory.')));
function entries(agent:string, session:string, turn:string, t:number) {
  if (agent === 'doubao' || agent === 'doubao-work') {
    const queryMs = DOUBAO_EPOCH + t;
    const terminal = parseDoubaoLogLine(doubaoLine('on_message_session_end', {
      chat_session_id: turn, conversation_id: session, query_send_timestamp: queryMs,
    }, t + 2000), DOUBAO_FILE)!;
    return buildDoubaoTaskEvents('fixture', {
      turnId: turn, queryMs, conversationId: session, updatedMs: queryMs,
    }, terminal, Date.now()).map(row => ({
      ...row, 'gen_ai.agent.type': agent, 'loongsuite.doubao_work.client': agent,
      'memory.owner': 'unscoped-default',
    }));
  }
  const common={
    'gen_ai.agent.type':agent,'gen_ai.agent.name':agent,
    'gen_ai.session.id':session,'gen_ai.turn.id':turn,'gen_ai.step.id':turn+':step',
    'gen_ai.provider.name':'openai','gen_ai.request.model':'fixture-model','gen_ai.response.model':'fixture-model',
    'gen_ai.request.id':turn+':request','user.id':'user-before-output','memory.owner':'unscoped-default',
  };
  const start={...common,'event.name':'other','gen_ai.turn.start':true,
    'gen_ai.input.messages_delta':[{role:'user',parts:[{type:'text',content:'identical prompt'}]}]};
  const output=[{role:'assistant',parts:[{type:'text',content:'OK'}]}];
  const end={...common,'event.name':'other','gen_ai.turn.end':true,
    'gen_ai.output.messages':output};
  const rows=[
    start,{...common,'event.name':'llm.request'},
    {...common,'event.name':'llm.response','gen_ai.output.messages':output,'gen_ai.usage.input_tokens':4,'gen_ai.usage.output_tokens':1},end,
  ];
  return rows.map((r,i)=>buildAgentActivityEntry({...r,'event.id':randomUUID(),
     time_unix_nano:String(now+BigInt(t+i)*1_000_000n)})!);
}

it.each(matrix)('canonical-stage fixture: %s (client %s, Input %s)', async (label,agent,source) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-matrix-'));
  const store=new InvocationAttributeStore({root:path.join(dir,'db')});
  const manager=new InputManager();
  const captures:ReadableSpan[]=[];
  const trace=new OtlpTraceFlusher({
    enabled:true,serviceName:'fixture-'+label,protocol:'http/protobuf',dataDir:dir,spanAttributePassthroughPrefixes:['memory.'],
    endpoints:[{name:'fixture',endpoint:'http://127.0.0.1:4318'}],
  }, undefined, () => ({export(rows,done) {captures.push(...rows);done({code:0});},shutdown:async()=>{}}));
  const output=new MockFlusher();
  manager.setFlusher(new MultiFlusher([output,trace]));
  manager.setInvocationAttributeJoin(new InvocationAttributeJoin(store,
    readInvocationAttributeConfig({sources:{[source]:{scope:'test-scope',attributePrefixes:['memory.']}}})!));
  const input = new ReplayInput(source,agent,new StateStore(path.join(dir,'state.json')));
  manager.registerInput(input);
  try {
    await manager.startInput(source);
    // Same session and exactly the same input text, different stable turn keys.
    const sessionId='same-native-session';
    const cases=[
      ['A-a',{ 'memory.owner':'tenant:A,甲', 'memory.try':2, 'memory.flag':false }],
      ['B_a',{ 'memory.owner':'tenant:B', 'memory.try':1, 'memory.flag':true }],
      ['empty',{}],
    ] as const;
    for (const [turnId,attributes] of cases) store.register({
      agent,scope:'test-scope',selector:{kind:'turn',sessionId,turnId},invocationId:randomUUID(),attributes,
    });
    // IDs are equal across unrelated agents and scopes; they cannot win.
    for (const [wrongAgent,wrongScope] of [
      ['unrelated','test-scope'],[agent,'other-scope'],
    ]) store.register({
      agent:wrongAgent,scope:wrongScope,selector:{kind:'turn',sessionId,turnId:cases[0][0]},
      invocationId:randomUUID(),attributes:{'memory.owner':'wrong'},
    });
    const rows=[
      ...entries(agent,sessionId,cases[1][0],20),
      ...entries(agent,sessionId,cases[0][0],1),
      ...entries(agent,sessionId,cases[2][0],30),
    ];
    input.emit('entries',rows);
    await vi.waitFor(() => expect(output.batchCalls.flat().length).toBeGreaterThan(0), {timeout:2000});
    await manager.stopAll(); await trace.flush();
    for(const [id,attrs] of cases) {
      const matched=output.batchCalls.flat().filter(e=>e['gen_ai.turn.id']===id);
      expect(matched.length).toBeGreaterThan(0);
      for(const event of matched) expect(attrFields(event)).toEqual(attrs);
      // The passive Doubao fixture has a client boundary, not a model call.
      // Each exported span must keep the corresponding invocation's values.
      const spans=captures.filter(s=>s.attributes['gen_ai.turn.id']===id);
      expect(spans.length, label+'/'+id+' span coverage').toBeGreaterThan(0);
      for(const span of spans) expect(attrFields(span.attributes)).toEqual(attrs);
    }
  } finally {
    await manager.stopAll();await trace.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});
  }
});

it('applies a late binding within the budget, then seals a missing turn across restart', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-late-'));
  let store=new InvocationAttributeStore({root:dir});
  const source='native';
  const config=readInvocationAttributeConfig({sources:{[source]:{scope:'app',waitMs:400,attributePrefixes:['memory.']}}})!;
  try {
    const sessionId='s',turnId='t',agent='codex',invocationId='x';
    const a={scope:'app',agent,invocationId};
    store.put({...a,attributes:{'memory.owner':'A'}});
    const rows=entries(agent,sessionId,turnId,1);
    const work=new InvocationAttributeJoin(store,config).apply(source,rows);
    expect(store.bind({...a,selector:{kind:'turn',sessionId,turnId}})).toBe('bound');
    await work;
    expect(rows.every(e=>e['memory.owner']==='A')).toBe(true);
    const missing=entries(agent,sessionId,'missing',1);
    await new InvocationAttributeJoin(store,readInvocationAttributeConfig({sources:{[source]:{scope:'app',attributePrefixes:['memory.']}}})!).apply(source,missing);
    expect(missing.every(e=>e['memory.owner']===undefined)).toBe(true);
    store.close();
    store=new InvocationAttributeStore({root:dir});
    expect(()=>store.register({scope:'app',agent,invocationId:'late',
      selector:{kind:'turn',sessionId,turnId:'missing'},attributes:{'memory.owner':'late'}})).toThrow('sealed');
  } finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

it('selects a message only on explicitly configured sources and keeps its transport out of JSON', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-message-'));
  const store=new InvocationAttributeStore({root:dir});
  try {
    const source='qoder-trace',agent='qoder-cli';
    const config=readInvocationAttributeConfig({sources:{[source]:{scope:'app',selector:'message',attributePrefixes:['memory.']}}})!;
    const join=new InvocationAttributeJoin(store,config);
    store.register({scope:'app',agent,invocationId:'m',selector:{kind:'message',messageId:'m'},attributes:{'memory.owner':'correct'}});
    const rows=entries(agent,'session','pilot-derived-turn',1);
    for(const e of rows)Object.assign(e,{[INVOCATION_MESSAGE_ID_FIELD]:'m'});
    await join.apply(source,rows);
    expect(rows.every(e=>e['memory.owner']==='correct')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('invocation.messageId');
    const absent=entries(agent,'session','unrelated',3);
    await join.apply(source,absent);
    expect(absent.every(e=>e['memory.owner']===undefined)).toBe(true);
  } finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

it('does not treat the session fallback, placeholder or missing store as an attributed invocation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-identity-fallback-'));
  const store = new InvocationAttributeStore({ root: dir });
  const source = 'cursor-hook', scope = 'app', agent = 'cursor-cli';
  const config = readInvocationAttributeConfig({
    sources: { [source]: { scope, attributePrefixes: ['memory.'] } },
  })!;
  try {
    const rows = [...entries(agent, 's', 's', 1), ...entries(agent, 's', 'unknown', 2), ...entries(agent, 's', 't2', 3)];
    store.register({ agent, scope, invocationId: 'r2', selector: { kind: 'turn', sessionId: 's', turnId: 't2' },
      attributes: { 'memory.owner': 'tenant:second', 'memory.note': 'sk-' + '1234567890abcdefghijklmnop' } });
    await new InvocationAttributeJoin(store, config).apply('unconfigured-source', rows);
    expect(rows.every(row => row['memory.owner'] === 'unscoped-default')).toBe(true);
    await new InvocationAttributeJoin(store, config).apply(source, rows);
    for (const row of rows) {
      const matched = row['gen_ai.turn.id'] === 't2';
      expect(row['memory.owner']).toBe(matched ? 'tenant:second' : undefined);
      const masked = maskAgentActivityEntry(row, { mode: 'all', types: [], replacementMode: 'placeholder' });
      expect(masked['memory.note']).toBe(matched ? '[APIKEY_MASKED]' : undefined);
    }
    await new InvocationAttributeJoin(null, config).apply(source, rows);
    expect(rows.every(row => row['memory.owner'] === undefined && row['memory.note'] === undefined)).toBe(true);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
