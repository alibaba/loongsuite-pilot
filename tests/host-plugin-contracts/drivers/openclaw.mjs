// Retained real plugin; only the original synthetic host callbacks/SSE fixture are driven here.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const repo=path.resolve(import.meta.dirname,'../../..');
const source=(await fs.readFile(path.join(repo,'tests/unit/hooks/openclaw/fixtures/pilot-probe-events-cp2.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const mode=process.argv[2], root=process.env.LOONGSUITE_PILOT_DATA_DIR;
let observeStream;
if (mode==='end-first'||mode==='message-first') {
  // Execute the exact existing helper. Replace only its Vitest mocking API with
  // this explicit host shim; stream contents/timing/clock remain byte-identical.
  let helper=await fs.readFile(path.join(repo,'tests/helpers/openclaw-stream.mjs'),'utf8');
  helper=helper.replace("import { vi } from 'vitest';",`const vi={
    stubGlobal(key,value){globalThis[key]=value;},fn(value){return value;},
    spyOn(object,key){const own=Object.getOwnPropertyDescriptor(object,key);return {
      mockImplementation(value){Object.defineProperty(object,key,{configurable:true,writable:true,value});return this;},
      mockRestore(){if(own)Object.defineProperty(object,key,own);else delete object[key];}
    };}
  };`);
  ({fakeStreamingFetch:observeStream}=await import('data:text/javascript;base64,'+Buffer.from(helper).toString('base64')));
  observeStream=observeStream();
}
const plugin=(await import(pathToFileURL(path.join(repo,'assets/plugins/openclaw/plugin.mjs')).href)).default;
const handlers={};plugin.register({pluginConfig:{},runtime:{version:'2026.6.10'},on(name,handler){handlers[name]=handler;}});
let checkpointIndex=0;
async function checkpoint(type){
  const id=checkpointIndex++;const marker=path.join(root,`checkpoint-${id}.ready`);await fs.writeFile(marker+".tmp",JSON.stringify({type}));await fs.rename(marker+".tmp",marker);
  const deadline=Date.now()+25000;
  while(true){try{await fs.access(path.join(root,`checkpoint-${id}.resume`));break;}catch{}
    // Never wait indefinitely if the Native side fails an assertion.
    if(Date.now()>deadline)throw new Error(`checkpoint ${id} timeout`);
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}
try {
 if(mode==='upstream-split'||mode==='upstream-whole') {
  const prompts=['Inspect the first project','Inspect the second project'];
  for(const [index,prompt] of prompts.entries()){
    const ctx={agentId:'main',sessionId:'native-openclaw-session',runId:`upstream-run-${index}`,sessionKey:'agent:main:upstream-test'};
    await handlers.before_model_resolve({prompt},ctx);
    if(mode==='upstream-split')await checkpoint('redundant-model-hook');
    for(const envelope of source){const handler=handlers[envelope.hook];if(!handler)continue;
      const event={...envelope.event};
      if('runId'in event)event.runId=ctx.runId;if('sessionId'in event)event.sessionId=ctx.sessionId;
      if('sessionKey'in event)event.sessionKey=ctx.sessionKey;if('prompt'in event)event.prompt=prompt;
      await Promise.resolve(handler(event,ctx));
      if(mode==='upstream-split'&&envelope.hook==='before_agent_run')await checkpoint('input');
    }
    if(mode==='upstream-split')await checkpoint('turn-end');
  }
 } else {
  const envelopes=[];let pendingEnd;
  for(const envelope of source){if(envelope.hook==='model_call_ended'){
      envelope.event.timeToFirstByteMs=12.5;if(mode==='message-first'){pendingEnd=envelope;continue;}}
    envelopes.push(envelope);
    if(envelope.hook==='before_message_write'&&envelope.event.message?.role==='assistant'&&pendingEnd){envelopes.push(pendingEnd);pendingEnd=undefined;}}
  assert.equal(pendingEnd,undefined);
  const knownRun=envelopes.find(i=>i.event?.runId)?.event.runId;
  const knownSession=envelopes.find(i=>i.event?.sessionId)?.event.sessionId;
  const knownSessionKey=envelopes.find(i=>i.event?.sessionKey)?.event.sessionKey;
  const syncHooks=new Set(['tool_result_persist','before_message_write']);
  for(const envelope of envelopes){const handler=handlers[envelope.hook];if(!handler)continue;
    const event=envelope.hook==='before_agent_run'?{...envelope.event,senderId:'channel-sender',accountId:'channel-account',channelId:'channel-conversation'}:envelope.event;
    const ctx=syncHooks.has(envelope.hook)?{agentId:'main',sessionKey:envelope.event?.sessionKey||knownSessionKey}:{agentId:'main',runId:envelope.event?.runId||knownRun,sessionId:envelope.event?.sessionId||knownSession,sessionKey:envelope.event?.sessionKey||knownSessionKey,channel:'telegram'};
    if(envelope.hook==='before_message_write'&&envelope.event.message?.role==='assistant')await observeStream(envelope.event.message.responseId,{delayMs:50});
    await Promise.resolve(handler(event,ctx));
  }
 }
}finally{globalThis[Symbol.for('loongsuite-pilot.openclaw.first-token')]?.dispose();}
