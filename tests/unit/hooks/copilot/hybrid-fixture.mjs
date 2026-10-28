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

export function toolConversation() {
  const f = conversation();
  const t = n => new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString();
  const ht = n => [Date.UTC(2026, 8, 1, 0, 0, n) / 1000, 0];
  const data = { interactionId: 'interaction-a', turnId: '0', toolCallId: 'read-1' };
  f.events[3].data.toolRequests = [{ toolCallId: 'read-1', name: 'read', arguments: { path: 'sample.txt' } }];
  f.events.push(
    { type: 'tool.execution_start', id: 'read-start', timestamp: t(4), data: { ...data, toolName: 'read', arguments: { path: 'sample.txt' } } },
    { type: 'tool.execution_complete', id: 'read-result', timestamp: t(5), data: { ...data, success: true, result: { content: 'sample file contents' } } },
    { type: 'assistant.turn_start', id: 'next-start', timestamp: t(6), data: { interactionId: 'interaction-a', turnId: '1' } },
    { type: 'assistant.message', id: 'next-message', timestamp: t(7), data: { interactionId: 'interaction-a', turnId: '1', apiCallId: 'second-api', model: 'qwen-test', content: 'Done.', toolRequests: [] } },
    { type: 'assistant.turn_end', id: 'next-end', timestamp: t(8), data: { turnId: '1' } },
  );
  f.spans[0].attributes['gen_ai.response.finish_reasons'] = ['tool_calls'];
  f.spans[1].endTime = ht(8);
  f.spans.push(
    { ...f.spans[0], spanId: 'second-chat', startTime: ht(6), endTime: ht(7), attributes: { ...f.spans[0].attributes, 'github.copilot.turn_id': '1', 'gen_ai.response.id': 'second-api', 'gen_ai.response.finish_reasons': ['stop'] } },
    { type: 'span', traceId: f.spans[0].traceId, spanId: 'read-tool', startTime: ht(4), endTime: ht(5), status: { code: 0 }, attributes: { 'gen_ai.conversation.id': 'session-test', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.id': 'read-1' } },
  );
  return f;
}
