import { readFileSync } from 'fs';

function checkFieldUsage(file, label) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  const lines = text.split('\n').filter(Boolean);
  
  let hasFullMessages = 0;
  let hasDeltaOnly = 0;
  let hasNeither = 0;
  let deltaHasToolResponse = 0;
  
  // Group by turn, find step-level llm.requests (have step.id)
  const turnReqs = new Map();
  
  for (const line of lines) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt['event.name'] !== 'llm.request') continue;
    if (!evt['gen_ai.step.id']) continue; // skip user-hook events
    
    const turnId = evt['gen_ai.turn.id'] || 'unknown';
    if (!turnReqs.has(turnId)) turnReqs.set(turnId, []);
    
    const hasFull = !!evt['gen_ai.input.messages'];
    const hasDelta = !!evt['gen_ai.input.messages_delta'];
    
    if (hasFull) hasFullMessages++;
    else if (hasDelta) hasDeltaOnly++;
    else hasNeither++;
    
    if (hasDelta) {
      const deltaStr = typeof evt['gen_ai.input.messages_delta'] === 'string' 
        ? evt['gen_ai.input.messages_delta'] 
        : JSON.stringify(evt['gen_ai.input.messages_delta']);
      if (deltaStr.includes('tool_call_response')) deltaHasToolResponse++;
    }
    
    turnReqs.get(turnId).push({ hasFull, hasDelta, stepId: evt['gen_ai.step.id'] });
  }
  
  console.log(`\n[${label}]`);
  console.log(`  Step-level llm.requests:`);
  console.log(`    Has gen_ai.input.messages (full): ${hasFullMessages}`);
  console.log(`    Has gen_ai.input.messages_delta only: ${hasDeltaOnly}`);
  console.log(`    Has neither: ${hasNeither}`);
  console.log(`    Deltas containing tool_call_response: ${deltaHasToolResponse}`);
  
  // Show a multi-step turn example
  for (const [turnId, reqs] of turnReqs) {
    if (reqs.length >= 3) {
      console.log(`  Example turn ${turnId}: ${reqs.length} step requests`);
      for (const r of reqs.slice(0, 4)) {
        console.log(`    ${r.stepId}: full=${r.hasFull}, delta=${r.hasDelta}`);
      }
      break;
    }
  }
}

checkFieldUsage('/Users/yunshen/.loongsuite-pilot/logs/output/qoder-work-2026-06-18.jsonl', 'qoder-work (06-18)');
checkFieldUsage('/Users/yunshen/.loongsuite-pilot/logs/output/codex-2026-06-18.jsonl', 'codex (06-18)');
