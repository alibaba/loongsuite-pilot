// Exact synthetic spawn/callback shapes from immutable plugin.test.mjs L1502/L1526.
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const repo=path.resolve(import.meta.dirname,'../../..');
delete process.env.LOONGSUITE_USER_ID;delete process.env.LOONGSUITE_PILOT_USER_ID;
let seq=0;
async function load(){const plugin=(await import(pathToFileURL(path.join(repo,'assets/plugins/openclaw/plugin.mjs')).href+'?native-subagent='+seq++)).default;const h={};plugin.register({pluginConfig:{},runtime:{version:'2026.6.10'},on(name,callback){h[name]=callback;}});return h;}
try{
 const h=await load();
 if(process.argv[2]==='early-child'){
  const parent={runId:'parent-run',sessionId:'parent-session',sessionKey:'agent:main:main'};
  await h.before_agent_run({prompt:'delegate',senderId:'user-a'},parent);
  await h.before_tool_call({toolName:'sessions_spawn',toolCallId:'spawn-a',params:{}},parent);
  const child={runId:'child-run',sessionId:'child-session',sessionKey:'agent:main:subagent:child-a'};
  await h.before_agent_run({prompt:'child task'},child);
  await h.after_tool_call({toolName:'sessions_spawn',toolCallId:'spawn-a',result:{details:{status:'accepted',runId:child.runId,childSessionKey:child.sessionKey}}},parent);
  await h.llm_output({},child);
 }else{
  const parents=[0,1].map(i=>({runId:`p${i}`,sessionId:`ps${i}`,sessionKey:`agent:main:p${i}`}));
  for(const [i,parent] of parents.entries()){await h.before_agent_run({prompt:'secret-task',senderId:`user-${i}`},parent);await h.before_tool_call({toolName:'sessions_spawn',toolCallId:'same-native-id',params:{task:'secret-task'}},parent);}
  for(const i of [1,0])await h.after_tool_call({toolName:'sessions_spawn',toolCallId:'same-native-id',result:{details:{status:'accepted',runId:`c${i}`,childSessionKey:`agent:main:subagent:c${i}`}}},parents[i]);
  const restarted=await load();
  for(const i of [0,1]){const child={runId:`c${i}`,sessionId:`cs${i}`,sessionKey:`agent:main:subagent:c${i}`};await restarted.before_agent_run({prompt:'secret-task'},child);await restarted.llm_output({},child);}
  const dir=path.join(process.env.LOONGSUITE_PILOT_DATA_DIR,'subagent-contexts/openclaw');
  const texts=await Promise.all((await fs.readdir(dir)).map(file=>fs.readFile(path.join(dir,file),'utf8')));assert(!texts.join('').includes('secret-task'));
 }
}finally{globalThis[Symbol.for('loongsuite-pilot.openclaw.first-token')]?.dispose();}
