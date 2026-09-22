import { describe,it,expect } from 'vitest';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { parseInteractions } from '../../../../assets/hooks/copilot/interaction-parser.mjs';
import { conversation } from '../../hooks/copilot/hybrid-fixture.mjs';
import { applyAgentContentPolicy } from '../../../../src/normalization/agent-content-policy.js';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

describe('Copilot hybrid final spans',()=>{
 it('exports separate traces, exact LLM/AGENT usage and no summary trace',async()=>{
  const captured:ReadableSpan[]=[];
  const flusher=new OtlpTraceFlusher({enabled:true,protocol:'http/protobuf',serviceName:'test',endpoints:[{name:'test',endpoint:'http://localhost:4318'}]},undefined,()=>({export:(spans,cb)=>{captured.push(...spans);cb({code:0});},shutdown:async()=>{}}));
  const a=conversation(),b=conversation({interaction:'interaction-b',base:10});
  b.events[1].data.content='Second prompt.';
  const records=parseInteractions([...a.events,...b.events.slice(1),{type:'session.shutdown',id:'summary',timestamp:'2026-09-01T00:00:30Z',data:{modelMetrics:{}}}],[...a.spans,...b.spans],{requireOtel:true}).flatMap(b=>b.records);
  await flusher.sendBatch(records);await flusher.shutdown();
  expect(new Set(captured.map(s=>s.spanContext().traceId)).size).toBe(2);
  const llms=captured.filter(s=>s.attributes['gen_ai.span.kind']==='LLM');expect(llms).toHaveLength(2);
  for(const s of llms){expect(s.attributes['gen_ai.usage.input_tokens']).toBe(100);expect(s.attributes['gen_ai.usage.output_tokens']).toBe(10);expect(s.duration[0]+s.duration[1]/1e9).toBeGreaterThan(0);}
  for(const root of captured.filter(s=>['ENTRY','AGENT'].includes(String(s.attributes['gen_ai.span.kind'])))){
   expect(JSON.parse(String(root.attributes['gen_ai.input.messages']))).toEqual([{role:'user',parts:[{type:'text',content: root.spanContext().traceId===records.find(r=>r['gen_ai.copilot.interaction.id']==='interaction-b')!.trace_id ? 'Second prompt.' : 'Read the sample.'}]}]);
  }
  const agents=captured.filter(s=>s.attributes['gen_ai.span.kind']==='AGENT');expect(agents).toHaveLength(2);for(const s of agents)expect(s.attributes['gen_ai.usage.input_tokens']).toBe(100);
 });
 it('preserves ordered current-interaction prompts and removes all message content when disabled',async()=>{
  const f=conversation();f.events.splice(2,0,{type:'user.message',id:'follow-up',timestamp:'2026-09-01T00:00:01.500Z',data:{interactionId:'interaction-a',content:'Also explain it.'}});
  const records=parseInteractions(f.events,f.spans,{requireOtel:true}).flatMap(b=>b.records);
  for(const capture of [true,false]){
   const captured:ReadableSpan[]=[];
   const flusher=new OtlpTraceFlusher({enabled:true,protocol:'http/protobuf',serviceName:'test',endpoints:[{name:'test',endpoint:'http://localhost:4318'}]},undefined,()=>({export:(spans,cb)=>{captured.push(...spans);cb({code:0});},shutdown:async()=>{}}));
   await flusher.sendBatch(records.map(r=>applyAgentContentPolicy(r,{copilot:{captureMessageContent:capture}})));await flusher.shutdown();
   const roots=captured.filter(s=>['ENTRY','AGENT'].includes(String(s.attributes['gen_ai.span.kind'])));expect(roots).toHaveLength(2);
   for(const root of roots){
    if(capture)expect(JSON.parse(String(root.attributes['gen_ai.input.messages'])).map((m:any)=>m.parts[0].content)).toEqual(['Read the sample.','Also explain it.']);
    else expect(root.attributes['gen_ai.input.messages']).toBeUndefined();
   }
   expect(captured.filter(s=>s.attributes['gen_ai.span.kind']==='STEP')).toHaveLength(1);
  }
 });

});
