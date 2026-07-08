import { readFileSync } from 'fs';

const file = '/Users/yunshen/.loongsuite-pilot/logs/output/codex-2026-06-18.jsonl';
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);

// Find a multi-step turn with gen_ai.input.messages (full)
const turnReqs = new Map();

for (const line of lines) {
  let evt;
  try { evt = JSON.parse(line); } catch { continue; }
  if (evt['event.name'] !== 'llm.request') continue;
  if (!evt['gen_ai.step.id']) continue;
  
  const turnId = evt['gen_ai.turn.id'] || 'unknown';
  if (!turnReqs.has(turnId)) turnReqs.set(turnId, []);
  turnReqs.get(turnId).push(evt);
}

for (const [turnId, reqs] of turnReqs) {
  if (reqs.length < 3) continue;
  const hasFull = reqs.some(r => r['gen_ai.input.messages']);
  if (!hasFull) continue;
  
  console.log(`=== Turn ${turnId} (${reqs.length} steps) ===`);
  for (const req of reqs) {
    const stepId = req['gen_ai.step.id'];
    const full = req['gen_ai.input.messages'];
    const delta = req['gen_ai.input.messages_delta'];
    
    const fullStr = full ? (typeof full === 'string' ? full : JSON.stringify(full)) : 'N/A';
    const deltaStr = delta ? (typeof delta === 'string' ? delta : JSON.stringify(delta)) : 'N/A';
    
    const fullToolCount = (fullStr.match(/tool_call_response/g) || []).length;
    const deltaToolCount = (deltaStr.match(/tool_call_response/g) || []).length;
    const fullUserCount = (fullStr.match(/"role"\s*:\s*"user"/g) || []).length;
    const fullAssistantCount = (fullStr.match(/"role"\s*:\s*"assistant"/g) || []).length;
    const fullToolCallCount = (fullStr.match(/"role"\s*:\s*"tool"/g) || []).length;
    
    console.log(`  ${stepId}:`);
    console.log(`    messages (full): ${fullToolCount} tool_responses, ${fullUserCount} user, ${fullAssistantCount} assistant, ${fullToolCallCount} tool, len=${fullStr.length}`);
    console.log(`    messages_delta:  ${deltaToolCount} tool_responses, len=${deltaStr.length}`);
    
    // Show first 300 chars of full
    if (fullStr.length > 0 && fullStr !== 'N/A') {
      console.log(`    full preview: ${fullStr.slice(0, 300)}${fullStr.length > 300 ? '...' : ''}`);
    }
  }
  break;
}
