import { describe,it,expect } from 'vitest';
import { parseInteractions } from '../../../../assets/hooks/copilot/interaction-parser.mjs';
import { conversation } from './hybrid-fixture.mjs';
describe('Copilot native OTel / transcript contract',()=>{
 it('separates repeated turn 0 by interaction and keeps real usage',()=>{
  const a=conversation(),b=conversation({interaction:'interaction-b',base:10});
  const batches=parseInteractions([...a.events,...b.events.slice(1)],[...a.spans,...b.spans],{requireOtel:true});
  expect(batches).toHaveLength(2);
  expect(new Set(batches.map(b=>b.records[0].trace_id)).size).toBe(2);
  for(const b of batches){const llm=b.records.find(r=>r['event.name']==='llm.response');expect(llm['gen_ai.usage.input_tokens']).toBe(100);expect(llm['gen_ai.usage.total_tokens']).toBe(110);expect(llm['gen_ai.session.id']).toBe('session-test');expect(b.records.filter(r=>r['gen_ai.turn.end'])).toHaveLength(1);}
 });
 it('waits for both the root and matching message/usage, regardless of arrival order',()=>{
  const {events,spans}=conversation();
  expect(parseInteractions(events,spans.slice(0,1),{requireOtel:true})).toEqual([]);
  expect(parseInteractions(events.filter(e=>e.type!=='assistant.message'),spans,{requireOtel:true})).toEqual([]);
  expect(parseInteractions(events,spans.slice(1),{requireOtel:true})).toEqual([]);
  expect(parseInteractions(events,spans,{requireOtel:true})).toHaveLength(1);
 });
 it('does not fabricate unavailable token fields',()=>{
  const {events}=conversation();const llm=parseInteractions(events)[0].records.find(r=>r['event.name']==='llm.response');expect(llm['gen_ai.usage.input_tokens']).toBeUndefined();
 });
 it('preserves every model in an independent shutdown summary',()=>{
  const {events,spans}=conversation();const models={one:{usage:{inputTokens:1}},two:{usage:{inputTokens:2}}};events.push({type:'session.shutdown',id:'shutdown-1',timestamp:'2026-09-01T00:00:09Z',data:{modelMetrics:models}});
  const b=parseInteractions(events,spans,{requireOtel:true});expect(b).toHaveLength(2);expect(b[1].records[0]['gen_ai.session.model_metrics']).toEqual(models);expect(b[1].records[0].trace_id).toBeUndefined();expect(b[0].records.every(r=>r['gen_ai.session.model_metrics']===undefined)).toBe(true);
 });
 it('uses native cancelled tool endpoint even without transcript completion',()=>{
  const {events,spans}=conversation({cancelled:true});events.splice(4,0,{type:'tool.execution_start',id:'tool-start',timestamp:'2026-09-01T00:00:03Z',data:{interactionId:'interaction-a',turnId:'0',toolCallId:'tool-a',toolName:'bash',arguments:{command:'sleep 5'}}});
  spans.push({type:'span',traceId:spans[0].traceId,spanId:'tool-span',startTime:spans[0].endTime,endTime:spans[1].endTime,status:{code:2},attributes:{'gen_ai.operation.name':'execute_tool','gen_ai.conversation.id':'session-test','gen_ai.tool.call.id':'tool-a','error.type':'cancelled'}});
  const records=parseInteractions(events,spans,{requireOtel:true})[0].records;const tool=records.find(r=>r['event.name']==='tool.result');expect(tool['gen_ai.tool.success']).toBe(false);expect(tool['error.type']).toBe('cancelled');expect(tool['gen_ai.tool.call.result']).toBeUndefined();
 });
 it('retains a provider failure with no assistant output or fabricated usage',()=>{
  const {events,spans}=conversation();
  spans[0].status={code:2};spans[0].attributes['error.type']='provider_error';
  for(const key of Object.keys(spans[0].attributes))if(key.startsWith('gen_ai.usage.'))delete spans[0].attributes[key];
  spans[1].status={code:2};spans[1].attributes['error.type']='provider_error';
  const batch=parseInteractions(events.filter(e=>e.type!=='assistant.message'),spans,{requireOtel:true});
  expect(batch).toHaveLength(1);const response=batch[0].records.find(r=>r['event.name']==='llm.response');
  expect(response['error.type']).toBe('provider_error');expect(response['gen_ai.usage.input_tokens']).toBeUndefined();expect(response['gen_ai.output.messages']).toBeUndefined();
 });

});
