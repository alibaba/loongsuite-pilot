import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CopilotLogInput } from '../../../../src/inputs/copilot-log/copilot-log-input.js';
import { InputManager } from '../../../../src/core/input-manager.js';
import { MockFlusher } from '../../../helpers/mock-flusher.js';
import { conversation } from '../../hooks/copilot/hybrid-fixture.mjs';
const dirs:string[]=[];
const inputs:CopilotLogInput[]=[];
const tracked=(i:CopilotLogInput)=>{inputs.push(i);return i;};
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const i of inputs.splice(0))await (i as any).onStop();await Promise.all(dirs.splice(0).map(d=>fs.rm(d,{recursive:true,force:true})));});
const lines=(xs:any[])=>xs.map(x=>JSON.stringify(x)).join('\n')+'\n';
async function setup(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'copilot-hybrid-'));dirs.push(dir);
 const sessions=path.join(dir,'sessions');const session=path.join(sessions,'session-test');const otel=path.join(dir,'otel');await fs.mkdir(session,{recursive:true});await fs.mkdir(otel);
 const stateFile=path.join(dir,'state.json');const state=new StateStore(stateFile);await state.load();
 const input=tracked(new CopilotLogInput({stateStore:state,sessionDir:sessions,dataDir:dir,otelDir:otel,historyStartTimeMs:0}));
 return {dir,sessions,session,otel,stateFile,state,input,file:path.join(session,'events.jsonl'),native:path.join(otel,'native.jsonl')};
}
const collect=(i:CopilotLogInput)=>(i as any).collect();
const queued=(i:CopilotLogInput)=>(i as any).onEntriesQueued();
describe('Copilot incremental recovery',()=>{
 it('degrades unknown old-shell sessions after a durable grace window, regardless of global installation',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));
  await fs.writeFile(path.join(x.dir,'otel-enabled'),'managed');
  const now=vi.spyOn(Date,'now').mockReturnValue(100_000);
  expect(await collect(x.input)).toEqual([]);await (x.input as any).onStop();
  const next=tracked(new CopilotLogInput({stateStore:x.state,sessionDir:x.sessions,dataDir:x.dir,otelDir:x.otel}));
  now.mockReturnValue(129_999);expect(await collect(next)).toEqual([]);
  now.mockReturnValue(130_000);const records=await collect(next);
  expect(records.some((r:any)=>r['event.name']==='llm.response')).toBe(true);
  expect(records.every((r:any)=>r['gen_ai.copilot.telemetry.source']==='transcript-only')).toBe(true);
  expect(records.find((r:any)=>r['event.name']==='llm.response')['gen_ai.usage.input_tokens']).toBeUndefined();
  await queued(next);const later=conversation({interaction:'interaction-b',base:10});
  await fs.appendFile(x.file,lines(later.events.slice(1)));
  expect(await collect(next)).toEqual([]);
  now.mockReturnValue(160_000);expect((await collect(next)).length).toBeGreaterThan(0);
 });
 it('accepts delayed native data within grace with exact per-call usage',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));
  const now=vi.spyOn(Date,'now').mockReturnValue(100_000);expect(await collect(x.input)).toEqual([]);
  now.mockReturnValue(125_000);await fs.writeFile(x.native,lines(f.spans));
  const records=await collect(x.input);expect(records.find((r:any)=>r['event.name']==='llm.response')['gen_ai.usage.input_tokens']).toBe(100);
  expect(records[0]['gen_ai.copilot.telemetry.source']).toBe('native-otel');
 });
 it('uses explicit per-session no-exporter evidence without waiting and keeps known exporters pending',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));
  const markers=path.join(x.dir,'state/copilot/session-wakeups');await fs.mkdir(markers,{recursive:true});
  await fs.writeFile(path.join(markers,'session-test.json'),JSON.stringify({session_id:'session-test',otel_file:x.native}));
  expect(await collect(x.input)).toEqual([]);
  await fs.writeFile(path.join(markers,'session-test.json'),JSON.stringify({session_id:'session-test'}));
  expect((await collect(x.input)).length).toBeGreaterThan(0);
 });
 it('falls back to polling after an asynchronous watcher error',async()=>{
  const x=await setup();await (x.input as any).onStart();
  expect(()=> (x.input as any).watcher.emit('error',new Error('watch failed'))).not.toThrow();
  expect((x.input as any).watcher).toBeUndefined();
  const f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));
  expect((await collect(x.input)).length).toBeGreaterThan(0);
 });
 it('uses a valid configured polling interval and defaults invalid values',async()=>{
  vi.stubEnv('LOONGSUITE_PILOT_POLL_INTERVAL_MS','');
  const x=await setup();
  expect((x.input as any).pollIntervalMs).toBe(10_000);
  for(const [value,expected] of [[1234,1234],[0,10_000],[-1,10_000],[NaN,10_000],[Infinity,10_000]]){
   const input=tracked(new CopilotLogInput({stateStore:x.state,dataDir:x.dir,pollIntervalMs:value}));
   expect((input as any).pollIntervalMs).toBe(expected);
  }
 });
 it('lets the unified polling interval override the Copilot default and listener value',async()=>{
  vi.stubEnv('LOONGSUITE_PILOT_POLL_INTERVAL_MS','3000');
  const x=await setup();
  expect((x.input as any).pollIntervalMs).toBe(3000);
  const input=tracked(new CopilotLogInput({stateStore:x.state,dataDir:x.dir,pollIntervalMs:45_000}));
  expect((input as any).pollIntervalMs).toBe(3000);
 });
 it('reconstructs read-but-not-queued data after restart',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));
  const first=await collect(x.input);expect(first.length).toBeGreaterThan(0);await x.state.save();
  const restored=new StateStore(x.stateFile);await restored.load();const next=tracked(new CopilotLogInput({stateStore:restored,sessionDir:x.sessions,dataDir:x.dir,otelDir:x.otel}));
  expect((await collect(next)).map((r:any)=>r['event.id'])).toEqual(first.map((r:any)=>r['event.id']));
  await queued(next);await restored.save();const third=tracked(new CopilotLogInput({stateStore:restored,sessionDir:x.sessions,dataDir:x.dir,otelDir:x.otel}));expect(await collect(third)).toEqual([]);
 });
 it('does not emit a pending interaction before native root arrival',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans.slice(0,1)));expect(await collect(x.input)).toEqual([]);
  await x.state.save();const next=tracked(new CopilotLogInput({stateStore:x.state,sessionDir:x.sessions,dataDir:x.dir,otelDir:x.otel}));await fs.appendFile(x.native,lines(f.spans.slice(1)));expect((await collect(next)).length).toBeGreaterThan(0);
 });
 it('appends only the next interaction and then a separate shutdown summary',async()=>{
  const x=await setup(),a=conversation(),b=conversation({interaction:'interaction-b',base:10});await fs.writeFile(x.file,lines(a.events));await fs.writeFile(x.native,lines(a.spans));await collect(x.input);await queued(x.input);
  await fs.appendFile(x.file,lines(b.events.slice(1)));await fs.appendFile(x.native,lines(b.spans));const second=await collect(x.input);expect(second.every((r:any)=>r['gen_ai.copilot.interaction.id']==='interaction-b')).toBe(true);await queued(x.input);
  await fs.appendFile(x.file,lines([{type:'session.shutdown',id:'s-end',timestamp:'2026-09-01T00:00:30Z',data:{modelMetrics:{model:{usage:{inputTokens:200}}}}}]));const summary=await collect(x.input);expect(summary).toHaveLength(1);expect(summary[0]['gen_ai.copilot.session_summary']).toBe(true);await queued(x.input);expect(await collect(x.input)).toEqual([]);
 });
 it('retains state across missing directory and partial line',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));await collect(x.input);await queued(x.input);await x.state.save();
  await fs.rename(x.sessions,x.sessions+'-away');expect(await collect(x.input)).toEqual([]);expect((await (x.input as any).index.all('SELECT * FROM delivered')).length).toBe(1);await fs.rename(x.sessions+'-away',x.sessions);
  const b=conversation({interaction:'interaction-b',base:10});const text=lines(b.events.slice(1));await fs.appendFile(x.file,text.slice(0,-2));await fs.appendFile(x.native,lines(b.spans));expect(await collect(x.input)).toEqual([]);await fs.appendFile(x.file,text.slice(-2));expect((await collect(x.input)).length).toBeGreaterThan(0);
 });
 it('handles replaced native files without replaying queued interactions',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));await collect(x.input);await queued(x.input);
  await fs.rename(x.native,x.native+'.old');await fs.writeFile(x.native,lines(f.spans));expect(await collect(x.input)).toEqual([]);
 });
 it('drains a source above 64 MiB and emits completed interactions before a partial EOF',async()=>{
  const x=await setup(),f=conversation();
  const handle=await fs.open(x.file,'w');
  const padding=JSON.stringify({type:'hook.end',data:{padding:'x'.repeat(1024*1024)}})+'\n';
  await handle.write(lines(f.events.slice(0,1)));
  for(let n=0;n<65;n++)await handle.write(padding);
  await handle.write(lines(f.events.slice(1))+'{"type":');await handle.close();
  await fs.writeFile(x.native,lines(f.spans));
  let result:any[]=[];
  for(let n=0;n<40&&!result.length;n++)result=await collect(x.input);
  expect(result.filter(r=>r['event.name']==='llm.response')).toHaveLength(1);
  await queued(x.input);
  expect(await collect(x.input)).toEqual([]);
 });

 it('drains native OTel above 64 MiB, resumes persisted offsets and ignores an unfinished tail',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));
  await fs.writeFile(path.join(x.dir,'otel-enabled'),'managed');
  const handle=await fs.open(x.native,'w');
  const padding=JSON.stringify({type:'log',body:'x'.repeat(1024*1024)})+'\n';
  for(let n=0;n<65;n++)await handle.write(padding);
  await handle.write(lines(f.spans)+'{"type":');await handle.close();
  expect(await collect(x.input)).toEqual([]);
  const indexed=(await (x.input as any).index.all('SELECT offset FROM sources WHERE path=?',[x.native]))[0].offset;
  expect(indexed).toBeGreaterThan(0);expect(indexed).toBeLessThanOrEqual(4*1024*1024);
  expect((await (x.input as any).index.all('SELECT position FROM partial_sources WHERE path=?',[x.native]))[0].position).toBe(4*1024*1024);
  await (x.input as any).onStop();
  const next=tracked(new CopilotLogInput({stateStore:x.state,sessionDir:x.sessions,dataDir:x.dir,otelDir:x.otel}));
  let result:any[]=[];for(let n=0;n<40&&!result.length;n++)result=await collect(next);
  expect(result.filter(r=>r['event.name']==='llm.response')).toHaveLength(1);await queued(next);
  const offset=(await (next as any).index.all('SELECT offset FROM sources WHERE path=?',[x.native]))[0].offset;
  expect(offset).toBe((await fs.stat(x.native)).size-8);
  expect(await collect(next)).toEqual([]);
 });
 it('accepts a complete JSON record larger than the cycle budget',async()=>{
  const x=await setup(),f=conversation();f.events[1].data.content='x'.repeat(5*1024*1024);
  await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));
  expect(await collect(x.input)).toEqual([]);
  const result=await collect(x.input);expect(result.find((r:any)=>r['event.name']==='other')['gen_ai.input.messages']).toContain('x'.repeat(1024));
 });
 it('does not let old pending interactions starve a later complete interaction',async()=>{
  const x=await setup(),f=conversation();const pending=Array.from({length:12},(_,i)=>({type:'user.message',id:'pending-'+i,timestamp:'2026-08-01T00:00:00Z',data:{interactionId:'pending-'+i,content:'pending'}}));
  await fs.writeFile(x.file,lines([f.events[0],...pending,...f.events.slice(1)]));await fs.writeFile(x.native,lines(f.spans));
  let result:any[]=[];for(let n=0;n<4&&!result.length;n++)result=await collect(x.input);
  expect(result.filter(r=>r['event.name']==='llm.response')).toHaveLength(1);
 });
 it('imports v2 delivered keys without replay, then survives transcript truncation',async()=>{
  const x=await setup(),f=conversation();
  x.state.update('copilot-log:v2:session-test',{extra:{interactions:['copilot:session-test:interaction-a']}});
  await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));expect(await collect(x.input)).toEqual([]);
  expect(x.state.keys()).not.toContain('copilot-log:v2:session-test');
  await fs.writeFile(x.file,lines(f.events.slice(0,1)));expect(await collect(x.input)).toEqual([]);
  await fs.appendFile(x.file,lines(f.events.slice(1)));expect(await collect(x.input)).toEqual([]);
 });
 it('replays a batch rejected when another input freezes the shared checkpoint during collect',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));
  const manager=new InputManager(),flusher=new MockFlusher();manager.setFlusher(flusher);manager.registerInput(x.input);
  const original=(x.input as any).collect.bind(x.input);let expected:string[]=[];
  vi.spyOn(x.input as any,'collect').mockImplementation(async()=>{
   const batch=await original();expected=batch.map((r:any)=>r['event.id']);
   x.state.holdSaveUntil(Promise.reject(new Error('another input output failed')));await Promise.resolve();return batch;
  });
  await x.input.start();await manager.stopAll();
  expect(x.state.saveFailed).toBe(true);expect(flusher.batchCalls.flat()).toEqual([]);
  const restored=new StateStore(x.stateFile);await restored.load();
  const next=tracked(new CopilotLogInput({stateStore:restored,sessionDir:x.sessions,dataDir:x.dir,otelDir:x.otel}));
  const replay=await collect(next);expect(expected.length).toBeGreaterThan(0);expect(replay.map((r:any)=>r['event.id'])).toEqual(expected);
  expect(await (next as any).index.all('SELECT * FROM delivered')).toEqual([]);
  await queued(next);expect(await collect(next)).toEqual([]);
 });

 it('commits only after queue acceptance through the shared input lifecycle',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));
  const reject=()=>{throw new Error('queue rejected')};x.input.on('entries',reject);
  await x.input.start();await x.input.stop();
  x.input.off('entries',reject);let accepted=0;x.input.on('entries',()=>{accepted++});
  await x.input.start();await x.input.stop();expect(accepted).toBe(1);
  await x.input.start();await x.input.stop();expect(accepted).toBe(1);
 });

 it('detects copy-truncate followed by regrowth past the old offset',async()=>{
  const x=await setup(),a=conversation(),b=conversation({interaction:'interaction-b',base:10});
  await fs.writeFile(x.file,lines(a.events));await fs.writeFile(x.native,lines(a.spans));await collect(x.input);await queued(x.input);
  b.events[1].data.content='New content '.repeat(200);
  await fs.writeFile(x.file,lines(b.events));await fs.appendFile(x.native,lines(b.spans));
  const batch=await collect(x.input);expect(batch.filter((r:any)=>r['event.name']==='llm.response')).toHaveLength(1);expect(batch.every((r:any)=>r['gen_ai.copilot.interaction.id']==='interaction-b')).toBe(true);
 });
 it('prunes a confirmed deleted session without deleting native source files',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));await collect(x.input);await queued(x.input);
  await fs.rm(x.session,{recursive:true});expect(await collect(x.input)).toEqual([]);
  expect(await (x.input as any).index.all('SELECT * FROM records')).toEqual([]);
  expect(await (x.input as any).index.all('SELECT * FROM delivered')).toEqual([]);expect((await fs.stat(x.native)).size).toBeGreaterThan(0);
 });

});
