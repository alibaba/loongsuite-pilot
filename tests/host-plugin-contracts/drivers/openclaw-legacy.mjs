// Synthetic 3.8 callback shapes from the retained immutable legacy contract.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const repo=path.resolve(import.meta.dirname,'../../..');
const mode=process.argv[2];
if(mode==='verify-session-key'){
 const {assertOpenClawSessionKey}=await import(pathToFileURL(path.join(repo,'scripts/e2e/openclaw-assertions.mjs')).href);
 const evidence=JSON.parse(await fs.readFile(path.join(process.env.LOONGSUITE_PILOT_DATA_DIR,'native-session-key-evidence.json'),'utf8'));
 assertOpenClawSessionKey(evidence);
}else{
 process.env.LOONGSUITE_USER_ID='test'; // exact retained legacy beforeEach identity
 const plugin=(await import(pathToFileURL(path.join(repo,'assets/plugins/openclaw/plugin.mjs')).href)).default;
 const handlers={};plugin.register({runtime:{version:'2026.3.8'},on(name,handler){handlers[name]=handler;}});
 assert.equal(Object.keys(handlers).length,9);assert.equal(handlers.model_call_started,undefined);
 const ctx={agentId:'main',sessionKey:'agent:main:test',sessionId:'session-1'};
 const originalNow=Date.now;let clock=originalNow();Date.now=()=>clock;
 const fire=(name,event)=>{clock+=10;assert.equal(handlers[name](event,ctx),undefined);};
 const message=(id,content=[{type:'text',text:'private output'}],stopReason='stop')=>({role:'assistant',responseId:id,timestamp:clock,provider:'openai',model:'gpt-test',content,stopReason,usage:{input:20,output:4,cacheRead:5,totalTokens:29}});
 try{
  fire('llm_input',{runId:'run-1',sessionId:ctx.sessionId,provider:'openai',model:'gpt-test',prompt:'private prompt',systemPrompt:'system rules'});
  if(mode==='parallel-tools'){
   fire('before_message_write',{message:message('r1',[{type:'toolCall',id:'t1',name:'read',arguments:{path:'a'}},{type:'toolCall',id:'t2',name:'read',arguments:{path:'b'}}],'toolUse')});
   for(const id of ['t1','t2'])fire('before_tool_call',{runId:'run-1',toolCallId:id,toolName:'read',params:{path:id}});
   for(const id of ['t2','t1']){fire('after_tool_call',{runId:'run-1',toolCallId:id,toolName:'read',result:{content:[{type:'text',text:id}]},durationMs:10});fire('tool_result_persist',{toolCallId:id,toolName:'read',message:{role:'toolResult',toolCallId:id,content:[{type:'text',text:id}]}});}
   fire('before_message_write',{message:message('r2')});
   fire('agent_end',{success:true,messages:[]});fire('llm_output',{runId:'run-1',sessionId:ctx.sessionId,usage:{input:40,output:8,cacheRead:10}});
  }else{
   handlers.before_message_write({message:mode==='rollback-tool'?message('r1',[{type:'toolCall',id:'t',name:'read',arguments:{}}],'toolUse'):message('r1')},ctx);
   if(mode==='rollback-tool'){const tool={runId:'run-1',toolCallId:'t',toolName:'read'};handlers.before_tool_call(tool,ctx);handlers.after_tool_call({...tool,durationMs:0,result:'ok'},ctx);handlers.tool_result_persist({toolCallId:'t',message:{role:'toolResult',toolCallId:'t',content:[{type:'text',text:'ok'}]}},ctx);}
   clock-=1000;handlers.before_message_write({message:message('r2')},ctx);handlers.agent_end({success:true},ctx);handlers.llm_output({runId:'run-1'},ctx);
  }
 }finally{Date.now=originalNow;globalThis[Symbol.for('loongsuite-pilot.openclaw.first-token')]?.dispose();}
}
