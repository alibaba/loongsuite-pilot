import { describe,it,expect } from 'vitest';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { parseInteractions } from '../../../../assets/hooks/copilot/interaction-parser.mjs';
import { conversation } from '../../hooks/copilot/hybrid-fixture.mjs';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

describe('Copilot hybrid final spans',()=>{
 it('exports separate traces, exact LLM/AGENT usage and no summary trace',async()=>{
  const captured:ReadableSpan[]=[];
  const flusher=new OtlpTraceFlusher({enabled:true,protocol:'http/protobuf',serviceName:'test',endpoints:[{name:'test',endpoint:'http://localhost:4318'}]},undefined,()=>({export:(spans,cb)=>{captured.push(...spans);cb({code:0});},shutdown:async()=>{}}));
  const a=conversation(),b=conversation({interaction:'interaction-b',base:10});
  const records=parseInteractions([...a.events,...b.events.slice(1),{type:'session.shutdown',id:'summary',timestamp:'2026-09-01T00:00:30Z',data:{modelMetrics:{}}}],[...a.spans,...b.spans],{requireOtel:true}).flatMap(b=>b.records);
  await flusher.sendBatch(records);await flusher.shutdown();
  expect(new Set(captured.map(s=>s.spanContext().traceId)).size).toBe(2);
  const llms=captured.filter(s=>s.attributes['gen_ai.span.kind']==='LLM');expect(llms).toHaveLength(2);
  for(const s of llms){expect(s.attributes['gen_ai.usage.input_tokens']).toBe(100);expect(s.attributes['gen_ai.usage.output_tokens']).toBe(10);expect(s.duration[0]+s.duration[1]/1e9).toBeGreaterThan(0);}
  const agents=captured.filter(s=>s.attributes['gen_ai.span.kind']==='AGENT');expect(agents).toHaveLength(2);for(const s of agents)expect(s.attributes['gen_ai.usage.input_tokens']).toBe(100);
 });
});
