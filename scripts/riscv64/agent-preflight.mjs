#!/usr/bin/env node
// A real CLI with a deterministic local model transport. This is not a live LLM test.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createMockServer } from '../e2e/lib/mock-server.mjs';

const [entry, artifacts] = process.argv.slice(2);
if (!entry || !artifacts) throw new Error('Usage: agent-preflight.mjs QWEN_ENTRY ARTIFACT_DIR');
assert.equal(process.arch, 'riscv64', 'Run this probe in the RISC-V guest');
fs.mkdirSync(artifacts, { recursive: true });
const marker = 'PILOT_RISCV64_AGENT_OK';
const requests = [];
const handlers = new Map();
handlers.set('/v1/chat/completions', (req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      requests.push({ method: req.method, model: payload.model, stream: payload.stream,
        messages: payload.messages, tools: payload.tools?.map(t => t.function?.name) });
      if (requests.length > 20) { res.writeHead(429); res.end('Probe request limit'); return; }
      const base = { id: `chatcmpl-pilot-${requests.length}`, created: Math.floor(Date.now()/1000), model: 'pilot-test-model' };
      const usage = { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 };
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for (const choices of [
          [{ index: 0, delta: { role: 'assistant', content: marker }, finish_reason: null }],
          [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ]) res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...base, object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: marker }, finish_reason: 'stop' }], usage }));
      }
    } catch (err) { res.writeHead(400); res.end(String(err)); }
  });
});
const mock = await createMockServer(handlers);
const args = [entry, '--auth-type', 'openai', '--openai-api-key', 'pilot-local-test',
  '--openai-base-url', `http://127.0.0.1:${mock.port}/v1`, '-m', 'pilot-test-model',
  '--output-format', 'text', '-p', `Reply with exactly ${marker}. Do not use any tools.`];
const started = Date.now();
const child = spawn(process.execPath, args, {
  cwd: path.dirname(path.resolve(artifacts)),
  env: { ...process.env, QWEN_TELEMETRY_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let stdout = '', stderr = '', timedOut = false, killTimer;
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
const terminateGroup = sig => { try { process.kill(-child.pid, sig); } catch (err) { if (err.code !== 'ESRCH') throw err; } };
const timer = setTimeout(() => {
  timedOut = true;
  terminateGroup('SIGTERM');
  killTimer = setTimeout(() => terminateGroup('SIGKILL'), 10000);
}, 300000);
let code, signal, spawnError;
try {
  ({ code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }));
} catch (err) { spawnError = String(err); }
finally {
  clearTimeout(timer); clearTimeout(killTimer);
  mock.server.closeAllConnections();
  await mock.close();
}
fs.writeFileSync(path.join(artifacts, 'stdout.log'), stdout);
fs.writeFileSync(path.join(artifacts, 'stderr.log'), stderr);
fs.writeFileSync(path.join(artifacts, 'model-requests.json'), JSON.stringify(requests, null, 2)+'\n');
const passed = code === 0 && !timedOut && requests.length > 0 && stdout.includes(marker);
const evidence = { recorded_at: new Date().toISOString(), arch: process.arch, node: process.version,
  agent: '@qwen-code/qwen-code@0.23.2', entry, model_transport: 'local deterministic OpenAI-compatible mock',
  live_model: false, elapsed_ms: Date.now()-started, exit_code: code, signal, spawn_error: spawnError,
  timeout: timedOut, model_requests: requests.length, marker_seen: stdout.includes(marker),
  status: passed ? 'passed' : 'failed',
  scope: 'CLI platform/model-transport preflight only; installed Pilot capture requires separate acceptance' };
fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(evidence, null, 2)+'\n');
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = passed ? 0 : 1;
