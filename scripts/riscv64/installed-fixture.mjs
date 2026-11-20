// Synthetic transcript -> installed shell Hook -> collector -> JSONL.
// No final output record is fabricated or written into the collector's output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { JSONL_VALIDATOR_JS } from '../e2e/lib/e2e-scenarios.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// The Qwen foreground producer appends a separate, final `other` seal after
// the user input, two model pairs and one tool pair. agent.input dual-write
// adds the ninth canonical event. Keep the seal in the acceptance contract.
const EVENTS_PER_TURN = 9;

export function eventQuality(events) {
  const fields = ['trace_id', 'span_id', 'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.step.id',
    'gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens', 'gen_ai.tool.call.id', 'gen_ai.tool.name'];
  return Object.fromEntries([...new Set(events.map(e=>e['event.name']))].map(name=>{
    const rows = events.filter(e=>e['event.name']===name);
    return [name, { count: rows.length, fields: Object.fromEntries(fields.map(field=>{
      const values = rows.map(e=>e[field]).filter(v=>v!==undefined && v!==null && v!=='');
      return [field, { populated: values.length, total: rows.length,
        types: [...new Set(values.map(v=>Array.isArray(v)?'array':typeof v))] }];
    })) }];
  }));
}

export function createFixtureProbe({ data, artifacts, command }) {
  const sid = `riscv-fixture-${crypto.randomUUID()}`;
  const transcript = path.join(artifacts, `${sid}.jsonl`);
  const payload = path.join(artifacts, 'fixture-hook-input.json');
  const hook = path.join(data, 'hooks/qwen-code-cli-loongsuite-pilot-hook.sh');
  const stateFile = path.join(data, 'state/qwen-code-cli/sessions', `${sid}.json`);
  const output = path.join(data, 'logs/output');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(payload, JSON.stringify({ session_id: sid, transcript_path: transcript,
    cwd: artifacts, stop_reason: 'end_turn' })+'\n');
  let turn = 0;
  let previous;
  const report = { synthetic: true, session_id: sid, transcript, phases: [] };
  const files = () => fs.existsSync(output) ? fs.readdirSync(output).filter(f=>f.startsWith('qwen-code-cli-')&&f.endsWith('.jsonl')) : [];
  const lines = file => fs.readFileSync(path.join(output,file),'utf8').split('\n').filter(Boolean);
  const sessionEvents = () => files().flatMap(file=>lines(file).map(JSON.parse)).filter(e=>e['gen_ai.session.id']===sid);
  const hookCommand = label => command(label, 'bash', ['-c', 'exec bash "$1" stop < "$2"',
    'riscv64-fixture', hook, payload], 60000);
  const checkpoint = () => ({ hook: readJson(stateFile),
    input: readJson(path.join(data,'logs/input-state.json'))?.['qwen-code-cli-log'] });

  async function phase(label) {
    const dir = path.join(artifacts, label); fs.mkdirSync(dir);
    const offsets = Object.fromEntries(files().map(file=>[file,lines(file).length]));
    fs.writeFileSync(path.join(dir,'before-lines.json'),JSON.stringify(offsets,null,2)+'\n');
    if (previous) {
      const current = checkpoint();
      assert.equal(current.hook?.turn_count, previous.hook.turn_count, `${label}: Hook turn checkpoint lost`);
      assert.equal(current.hook?.transcript_offset, previous.hook.transcript_offset, `${label}: transcript offset lost`);
      for (const [file,offset] of Object.entries(previous.input.extra.hookLogOffsets)) {
        assert.ok(current.input?.extra?.hookLogOffsets?.[file]>=offset, `${label}: collector checkpoint regressed for ${file}`);
      }
      await hookCommand(`${label}-replay-hook`);
      // One full 30-second input poll plus flush allowance; repeated Hook must
      // not re-emit already acknowledged turns after restart/upgrade/rollback.
      await sleep(35000);
      assert.equal(sessionEvents().length, turn*EVENTS_PER_TURN, `${label}: old turn replayed after service transition`);
    }
    turn++;
    const base = Date.now()-4000;
    const record = (type, suffix, delta, extra) => ({ uuid:`${sid}-${turn}-${suffix}`,
      parentUuid:null, sessionId:sid, timestamp:new Date(base+delta).toISOString(),
      type, cwd:artifacts, version:'0.23.2', ...extra });
    const model = (suffix,delta,parts,input,output) => record('assistant',suffix,delta,{
      model:'riscv64-fixture-model', message:{role:'model',parts},
      usageMetadata:{promptTokenCount:input,candidatesTokenCount:output,
        cachedContentTokenCount:0,totalTokenCount:input+output,thoughtsTokenCount:0} });
    const callId = `${sid}-tool-${turn}`;
    const records = [
      record('user','user',0,{message:{role:'user',parts:[{text:`Synthetic RISC-V turn ${turn}: read a fixed value.`}]}}),
      model('request-tool',1000,[{text:'Reading the synthetic value.'},
        {functionCall:{name:'read_file',args:{path:'synthetic-value.txt'},id:callId}}],100,15),
      record('tool_result','tool-result',2000,{message:{role:'user',parts:[{
        functionResponse:{name:'read_file',response:{output:'synthetic-value-42'}}}]},
        toolCallResult:{callId,status:'success'}}),
      model('answer',3000,[{text:'The synthetic value is 42.'}],120,8),
    ];
    fs.appendFileSync(transcript,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
    await hookCommand(`${label}-append-hook`);
    let events=[];
    const deadline=Date.now()+90000;
    while(Date.now()<deadline) {
      events=sessionEvents().filter(e=>e['gen_ai.turn.id']===`${sid}:t${turn}`);
      const state=checkpoint();
      if(events.length>=EVENTS_PER_TURN && events.some(e=>e['gen_ai.turn.end']===true)
        && state.hook?.transcript_offset===fs.statSync(transcript).size
        && state.input?.extra?.hookLogOffsets && Object.entries(state.input.extra.hookLogOffsets).every(([file,offset])=>{
          const p=path.join(data,'logs/qwen-code-cli',file);
          return !fs.existsSync(p) || offset===fs.statSync(p).size;
        })) break;
      await sleep(500);
    }
    assert.equal(events.length,EVENTS_PER_TURN,`${label}: expected 2 model pairs, 1 tool pair, input, agent.input and final seal`);
    const counts=Object.fromEntries([...new Set(events.map(e=>e['event.name']))]
      .map(name=>[name,events.filter(e=>e['event.name']===name).length]));
    assert.deepEqual(counts,{other:2,'agent.input':1,'llm.request':2,'llm.response':2,'tool.call':1,'tool.result':1},
      `${label}: missing, extra or duplicate fixture event`);
    assert.equal(events.filter(e=>e['gen_ai.turn.start']===true).length,1,`${label}: expected one turn start`);
    const ends=events.filter(e=>e['gen_ai.turn.end']===true);
    assert.equal(ends.length,1,`${label}: expected one turn end`);
    assert.equal(ends[0]['event.name'],'other',`${label}: foreground seal must own the turn end`);
    const state=checkpoint();
    assert.equal(state.hook?.turn_count,turn);
    assert.equal(state.hook?.transcript_offset,fs.statSync(transcript).size);
    assert.ok(state.input?.extra?.hookLogOffsets,'Collector must persist input offsets');
    for(const [file,offset] of Object.entries(state.input.extra.hookLogOffsets)) {
      const p=path.join(data,'logs/qwen-code-cli',file);
      if(fs.existsSync(p))assert.equal(offset,fs.statSync(p).size,`${label}: collector did not acknowledge complete Hook file`);
    }
    const all=sessionEvents();
    assert.equal(all.length,turn*EVENTS_PER_TURN,`${label}: missing or duplicate earlier turns`);
    assert.equal(new Set(all.map(e=>e['event.id'])).size,all.length,`${label}: duplicate event id`);
    const keys=all.map(e=>`${e['gen_ai.turn.id']}|${e['event.name']}|${e.span_id}|${e['gen_ai.turn.start']===true}|${e['gen_ai.turn.end']===true}`);
    assert.equal(new Set(keys).size,all.length,`${label}: duplicate event identity`);
    const toolCall=events.find(e=>e['event.name']==='tool.call');
    const toolResult=events.find(e=>e['event.name']==='tool.result');
    assert.equal(toolCall['gen_ai.tool.call.id'],callId);
    assert.equal(toolResult['gen_ai.tool.call.id'],callId);
    const newDir=path.join(dir,'new-jsonl');fs.mkdirSync(newDir);
    for(const file of files()) {
      const added=lines(file).slice(offsets[file]||0).map(JSON.parse).filter(e=>e['gen_ai.session.id']===sid);
      if(added.length)fs.writeFileSync(path.join(newDir,file),added.map(e=>JSON.stringify(e)).join('\n')+'\n');
    }
    await command(`${label}-strict-validator`,process.execPath,['-e',JSONL_VALIDATOR_JS],60000,true,
      {_JV_LOG_DIR:newDir,E2E_JSONL_STRICT:'1',E2E_JSONL_AGENT_FILTER:'qwen-code-cli'});
    previous=state;
    const result={label,turn,event_count:events.length,total_session_events:all.length,
      replay_checked:turn>1,checkpoint:state,quality:eventQuality(events)};
    report.phases.push(result);
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2)+'\n');
    return result;
  }
  return { phase, report };
}
