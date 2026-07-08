import { readFileSync } from 'fs';

function analyzeFile(file, label) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  const lines = text.split('\n').filter(Boolean);
  
  // Group LLM spans by traceId
  const traceLLMs = new Map();
  
  for (const line of lines) {
    let spans;
    try { spans = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(spans)) spans = [spans];
    
    for (const span of spans) {
      const attrs = span.attributes || {};
      if (attrs['gen_ai.span.kind'] !== 'LLM') continue;
      
      const traceId = span.traceId;
      const input = attrs['gen_ai.input.messages'];
      if (!input) continue;
      
      if (!traceLLMs.has(traceId)) traceLLMs.set(traceId, []);
      
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
      const toolCount = (inputStr.match(/tool_call_response/g) || []).length;
      const userCount = (inputStr.match(/"role"\s*:\s*"user"/g) || []).length;
      
      traceLLMs.get(traceId).push({
        name: span.name,
        toolCount,
        userCount,
        startTime: span.startTimeUnixNano,
        inputLen: inputStr.length,
      });
    }
  }
  
  // Find multi-LLM traces and check for accumulation pattern
  let multiTraces = 0;
  let cumulativeTraces = 0;
  let maxToolCount = 0;
  
  for (const [traceId, llms] of traceLLMs) {
    if (llms.length < 3) continue;
    multiTraces++;
    
    // Check if tool_count is monotonically increasing (cumulative pattern)
    llms.sort((a, b) => {
      if (a.startTime < b.startTime) return -1;
      if (a.startTime > b.startTime) return 1;
      return 0;
    });
    
    let isCumulative = true;
    for (let i = 1; i < llms.length; i++) {
      if (llms[i].toolCount < llms[i-1].toolCount) {
        isCumulative = false;
        break;
      }
    }
    
    if (isCumulative && llms[llms.length-1].toolCount > 0) {
      cumulativeTraces++;
      maxToolCount = Math.max(maxToolCount, llms[llms.length-1].toolCount);
    }
  }
  
  console.log(`\n[${label}]`);
  console.log(`  Total LLM spans with input: ${[...traceLLMs.values()].reduce((s,a) => s+a.length, 0)}`);
  console.log(`  Multi-step traces (>=3 LLM spans): ${multiTraces}`);
  console.log(`  Cumulative pattern traces: ${cumulativeTraces}`);
  console.log(`  Max tool_call_response count: ${maxToolCount}`);
  
  // Show first cumulative trace as example
  for (const [traceId, llms] of traceLLMs) {
    if (llms.length < 3) continue;
    llms.sort((a, b) => {
      if (a.startTime < b.startTime) return -1;
      if (a.startTime > b.startTime) return 1;
      return 0;
    });
    let isCum = true;
    for (let i = 1; i < llms.length; i++) {
      if (llms[i].toolCount < llms[i-1].toolCount) { isCum = false; break; }
    }
    if (isCum && llms[llms.length-1].toolCount > 0) {
      console.log(`  Example trace ${traceId.slice(0,8)}...:`);
      for (let i = 0; i < Math.min(llms.length, 6); i++) {
        console.log(`    LLM#${i+1}: ${llms[i].toolCount} tool_responses, user=${llms[i].userCount}`);
      }
      if (llms.length > 6) console.log(`    ... (${llms.length} total)`);
      break;
    }
  }
}

analyzeFile('/Users/yunshen/.loongsuite-pilot/logs/otlp-debug/ys-pilot-qoder-work-2026-06-18.jsonl', 'qoder-work (06-18)');
analyzeFile('/Users/yunshen/.loongsuite-pilot/logs/otlp-debug/ys-pilot-qoder-work-2026-06-17.jsonl', 'qoder-work (06-17)');
analyzeFile('/Users/yunshen/.loongsuite-pilot/logs/otlp-debug/ys-pilot-codex-2026-06-18.jsonl', 'codex (06-18)');
analyzeFile('/Users/yunshen/.loongsuite-pilot/logs/otlp-debug/ys-pilot-codex-2026-06-17.jsonl', 'codex (06-17)');
