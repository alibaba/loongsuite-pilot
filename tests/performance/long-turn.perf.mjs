#!/usr/bin/env node
/** Manual resource regression: npm run perf:turn-stream [-- agent ...]
 * Uses real conversion/SDK/export buffering with a 256 MiB old-space limit. This is
 * a synthetic conversion gate, separate from full installed-collector E2E. */
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const worker = path.join(repo, 'dist', `turn-perf-${process.pid}.mjs`);
const agents = process.argv.slice(2).length ? process.argv.slice(2)
  : ['openclaw', 'claude-code', 'opencode', 'hermes', 'codex', 'qoder', 'qwen-code-cli', 'grok-build', 'copilot', 'dsh', 'cursor'];
const count = Number(process.env.PILOT_PERF_CALLS ?? 600);
if (!Number.isInteger(count) || count < 32 || count > 5000) throw new Error('PILOT_PERF_CALLS must be 32..5000');
await mkdir(path.dirname(worker), { recursive: true });
await build({ stdin: { resolveDir: repo, sourcefile: 'turn-perf.ts', loader: 'ts', contents: `
  import { OtlpTraceFlusher } from './src/flushers/otlp-trace-flusher.js';
  import assert from 'node:assert/strict';
  import v8 from 'node:v8';
  const count = ${count};
  const agent = process.argv[2];
  const base = { trace_id: '1234567890abcdef1234567890abcdef', 'gen_ai.agent.type': agent,
    'gen_ai.agent.id': 'main', 'gen_ai.turn.id': 'synthetic-long-turn', 'gen_ai.session.id': 'synthetic-session',
    'user.id': 'synthetic-user', 'gen_ai.provider.name': 'synthetic' };
  const messages = (role, text) => [{ role, parts: [{ type: 'text', content: text }] }];
  let clock = Date.parse('2026-07-01T00:00:00Z');
  const event = (name, fields = {}) => ({ ...base, 'event.name': name, 'event.id': String(clock),
    time_unix_nano: String(BigInt(clock += 10) * 1000000n), ...fields });
  const records = [event('other', { 'gen_ai.input.messages_delta': messages('user', 'synthetic task') })];
  for (let i = 0; i < count; i++) {
    const common = { 'gen_ai.step.id': 'step_' + i, 'gen_ai.response.id': 'response-' + i };
    records.push(event('llm.request', { ...common, 'gen_ai.request.model': 'synthetic-model',
      'gen_ai.input.messages_delta': messages('user', '复'.repeat(1000) + i) }),
      event('llm.response', { ...common, 'gen_ai.response.model': 'synthetic-model',
        'gen_ai.output.messages': messages('assistant', 'output-' + i),
        'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 10,
        'gen_ai.usage.total_tokens': 110, 'gen_ai.response.finish_reasons': ['tool_calls'] }));
    if (i < count - 1) records.push(event('tool.call', { ...common, 'gen_ai.tool.name': 'synthetic-tool',
      'gen_ai.tool.call.id': 'tool-' + i, 'gen_ai.tool.call.arguments': { index: i } }),
      event('tool.result', { ...common, 'gen_ai.tool.name': 'synthetic-tool', 'gen_ai.tool.call.id': 'tool-' + i,
        'gen_ai.tool.call.result': { value: i }, 'tool.result.status': 'success' }));
  }
  records.push(event('other', { 'agent.openclaw.hook': 'llm_output', 'gen_ai.turn.end': true,
    ...(agent === 'codex' ? { 'agent.codex.turn_status': 'completed' } : {}) }));
  const ids = new Set(); let spans = 0, llms = 0, input = 0, output = 0, agentInput, agentOutput, peakHeap = 0;
  const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'synthetic-memory',
    endpoints: [{ name: 'local', endpoint: 'http://127.0.0.1:4318' }] }, undefined, () => ({
      export(batch, callback) {
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        for (const span of batch) {
          spans++; ids.add(span.spanContext().spanId);
          const a = span.attributes;
          if (a['gen_ai.span.kind'] === 'LLM') { llms++; input += a['gen_ai.usage.input_tokens']; output += a['gen_ai.usage.output_tokens']; }
          if (a['gen_ai.span.kind'] === 'AGENT') { agentInput = a['gen_ai.usage.input_tokens']; agentOutput = a['gen_ai.usage.output_tokens']; }
        }
        callback({ code: 0 });
      }, shutdown: async () => {} }));
  try { await flusher.sendBatch(records); } finally { await flusher.shutdown(); }
  assert.equal(spans, count * 3 + 1); assert.equal(ids.size, spans); assert.equal(llms, count);
  assert.equal(input, count * 100); assert.equal(output, count * 10);
  assert.equal(agentInput, input); assert.equal(agentOutput, output);
  console.log(JSON.stringify({ pass: true, agent, calls: count, spans, uniqueSpans: ids.size, llms, input, output,
    agentInput, agentOutput, peakHeap, peakRSS: process.resourceUsage().maxRSS * 1024,
    heapLimit: v8.getHeapStatistics().heap_size_limit, node: process.version }));
` }, outfile: worker, platform: 'node', target: 'node22', format: 'esm', bundle: true, packages: 'external',
  define: { '__PROPRIETARY_BUILD__': 'false' } });
try {
  for (const agent of agents) {
    const child = spawn(process.execPath, ['--max-old-space-size=256', worker, agent], { cwd: repo,
      env: { ...process.env, LOG_LEVEL: 'silent' }, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    const [code, signal] = await new Promise(resolve => child.once('exit', (...args) => resolve(args)));
    clearTimeout(timer);
    if (signal || code !== 0) throw new Error('Long-turn resource regression failed: ' + (signal ?? code));
  }
} finally { await rm(worker, { force: true }); }
