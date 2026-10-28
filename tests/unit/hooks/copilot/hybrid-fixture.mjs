// Synthetic protocol fixture: no captured user content, identities or credentials.
export function conversation({ interaction = 'interaction-a', model = 'qwen-test', base = 0, cancelled = false } = {}) {
  const t = n => new Date(Date.UTC(2026, 8, 1, 0, 0, base + n)).toISOString();
  const ht = n => [Date.UTC(2026,8,1,0,0,base+n)/1000,0];
  const e = (type,n,data) => ({type,id:`${interaction}-${type}-${n}`,timestamp:t(n),data});
  const trace = interaction.endsWith('a') ? 'a'.repeat(32) : 'b'.repeat(32);
  const api = `${interaction}-api`;
  const common = {'gen_ai.conversation.id':'session-test','github.copilot.interaction_id':interaction};
  const events = [e('session.start',0,{sessionId:'session-test'}),e('user.message',1,{interactionId:interaction,turnId:'0',content:'Read the sample.'}),e('assistant.turn_start',2,{interactionId:interaction,turnId:'0'}),e('assistant.message',3,{interactionId:interaction,turnId:'0',apiCallId:api,messageId:`${api}-message`,model,content:'Sample read.',toolRequests:[]}),e('assistant.turn_end',4,{turnId:'0'})];
  const spans = [{type:'span',traceId:trace,spanId:`${interaction}-chat`,parentSpanId:`${interaction}-root`,startTime:ht(2),endTime:ht(3),status:{code:0},attributes:{...common,'gen_ai.operation.name':'chat','github.copilot.turn_id':'0','gen_ai.response.id':api,'gen_ai.provider.name':'anthropic','gen_ai.request.model':model,'gen_ai.response.model':model,'gen_ai.usage.input_tokens':100,'gen_ai.usage.output_tokens':10,'gen_ai.usage.cache_read.input_tokens':50,'gen_ai.response.finish_reasons':['stop']}},{type:'span',traceId:trace,spanId:`${interaction}-root`,startTime:ht(1),endTime:ht(4),status:{code:cancelled?2:0},attributes:{...common,'gen_ai.operation.name':'invoke_agent',...(cancelled?{'error.type':'cancelled'}:{})}}];
  return {events,spans};
}
