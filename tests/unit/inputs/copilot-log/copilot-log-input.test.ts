import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CopilotLogInput } from '../../../../src/inputs/copilot-log/copilot-log-input.js';
import { conversation } from '../../hooks/copilot/hybrid-fixture.mjs';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>fs.rm(d,{recursive:true,force:true})));});
const lines=(xs:any[])=>xs.map(x=>JSON.stringify(x)).join('\n')+'\n';
async function setup(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'copilot-hybrid-'));dirs.push(dir);
 const sessions=path.join(dir,'sessions');const session=path.join(sessions,'session-test');const otel=path.join(dir,'otel');await fs.mkdir(session,{recursive:true});await fs.mkdir(otel);
 const stateFile=path.join(dir,'state.json');const state=new StateStore(stateFile);await state.load();
 const input=new CopilotLogInput({stateStore:state,sessionDir:sessions,dataDir:dir,otelDir:otel});
 return {dir,sessions,session,otel,stateFile,state,input,file:path.join(session,'events.jsonl'),native:path.join(otel,'native.jsonl')};
}
const collect=(i:CopilotLogInput)=>(i as any).collect();
const queued=(i:CopilotLogInput)=>(i as any).onEntriesQueued();
describe('Copilot incremental recovery',()=>{
 it('reconstructs read-but-not-queued data after restart',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));
  const first=await collect(x.input);expect(first.length).toBeGreaterThan(0);await x.state.save();
  const restored=new StateStore(x.stateFile);await restored.load();const next=new CopilotLogInput({stateStore:restored,sessionDir:x.sessions,dataDir:x.dir,otelDir:x.otel});
  expect((await collect(next)).map((r:any)=>r['event.id'])).toEqual(first.map((r:any)=>r['event.id']));
  queued(next);await restored.save();const third=new CopilotLogInput({stateStore:restored,sessionDir:x.sessions,dataDir:x.dir,otelDir:x.otel});expect(await collect(third)).toEqual([]);
 });
 it('does not emit a pending interaction before native root arrival',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans.slice(0,1)));expect(await collect(x.input)).toEqual([]);
  await x.state.save();const next=new CopilotLogInput({stateStore:x.state,sessionDir:x.sessions,dataDir:x.dir,otelDir:x.otel});await fs.appendFile(x.native,lines(f.spans.slice(1)));expect((await collect(next)).length).toBeGreaterThan(0);
 });
 it('appends only the next interaction and then a separate shutdown summary',async()=>{
  const x=await setup(),a=conversation(),b=conversation({interaction:'interaction-b',base:10});await fs.writeFile(x.file,lines(a.events));await fs.writeFile(x.native,lines(a.spans));await collect(x.input);queued(x.input);
  await fs.appendFile(x.file,lines(b.events.slice(1)));await fs.appendFile(x.native,lines(b.spans));const second=await collect(x.input);expect(second.every((r:any)=>r['gen_ai.copilot.interaction.id']==='interaction-b')).toBe(true);queued(x.input);
  await fs.appendFile(x.file,lines([{type:'session.shutdown',id:'s-end',timestamp:'2026-09-01T00:00:30Z',data:{modelMetrics:{model:{usage:{inputTokens:200}}}}}]));const summary=await collect(x.input);expect(summary).toHaveLength(1);expect(summary[0]['gen_ai.copilot.session_summary']).toBe(true);queued(x.input);expect(await collect(x.input)).toEqual([]);
 });
 it('retains state across missing directory and partial line',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));await collect(x.input);queued(x.input);await x.state.save();
  await fs.rename(x.sessions,x.sessions+'-away');expect(await collect(x.input)).toEqual([]);expect(x.state.keys().length).toBe(1);await fs.rename(x.sessions+'-away',x.sessions);
  const b=conversation({interaction:'interaction-b',base:10});const text=lines(b.events.slice(1));await fs.appendFile(x.file,text.slice(0,-2));await fs.appendFile(x.native,lines(b.spans));expect(await collect(x.input)).toEqual([]);await fs.appendFile(x.file,text.slice(-2));expect((await collect(x.input)).length).toBeGreaterThan(0);
 });
 it('handles replaced native files without replaying queued interactions',async()=>{
  const x=await setup(),f=conversation();await fs.writeFile(x.file,lines(f.events));await fs.writeFile(x.native,lines(f.spans));await collect(x.input);queued(x.input);
  await fs.rename(x.native,x.native+'.old');await fs.writeFile(x.native,lines(f.spans));expect(await collect(x.input)).toEqual([]);
 });
});
