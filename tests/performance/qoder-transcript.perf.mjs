#!/usr/bin/env node
// Same-machine, same-runtime wrapper + parser comparison with synthetic data.
// node tests/performance/qoder-transcript.perf.mjs <baseline-assets/hooks> <output-dir> <node>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const here = path.dirname(fileURLToPath(import.meta.url));
const candidate = path.resolve(here, '../../assets/hooks');
const [baseline, output, node] = process.argv.slice(2);
if (!baseline || !output || !node) throw new Error('Expected baseline Hook directory, fresh output directory, and Node executable');
fs.mkdirSync(output, { recursive: false, mode: 0o700 });
const report = { environment: { platform: os.platform(), os: os.release(), arch: os.arch(), node },
  sources: Object.fromEntries([
    ['baselineProcessor', path.join(baseline, 'qoder-hook-processor.mjs')],
    ['candidateProcessor', path.join(candidate, 'qoder-hook-processor.mjs')],
    ['candidateCollector', path.join(candidate, 'qoder/transcript-collector.mjs')],
    ['candidateWakeup', path.join(candidate, 'qoder/hook-wakeup.mjs')],
  ].map(([name, file]) => [name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
  scope: 'Synthetic OS execution; full shell wrapper plus collector parser. Token joins/trace export validated separately. No OS reset test.',
  limits: { aggregateRSSMiB: 1536, oldSpaceMiB: 256, retrySpawns: 64, retryGeneration: 3 },
  sampling: { intervalMs: 50, trackWrapperFromSpawn: true }, scale: [], natural: [] };
const rows = file => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
};
const at = ms => new Date(Date.UTC(2026, 9, 31) + ms).toISOString();
function turn(index, padding = 0) {
  const base = index * 10_000;
  return [{ type: 'progress', timestamp: at(base), data: { hookEvent: 'UserPromptSubmit' } },
    { type: 'user', uuid: 'user-' + index, timestamp: at(base + 10), message: { role: 'user', content: 'prompt ' + index } },
    { type: 'assistant', timestamp: at(base + 300), message: { id: 'message-' + index, model: 'synthetic-model', role: 'assistant', content: [{ type: 'text', text: 'answer ' + index + 'x'.repeat(padding) }], stop_reason: 'end_turn' } },
    { type: 'progress', timestamp: at(base + 400), data: { hookEvent: 'Stop' } }];
}
const jsonl = value => value.map(row => JSON.stringify(row)).join('\n') + '\n';
async function runCase(revision, agentId, sizeMiB, natural = false) {
  const directory = fs.mkdtempSync(path.join(output, `${revision}-${agentId}-${sizeMiB}-`));
  fs.mkdirSync(directory + '/slots');
  const transcript = directory + '/native.jsonl';
  const history = []; let historyBytes = 0; let index = 0;
  while (historyBytes < sizeMiB * 1048576) {
    const text = jsonl(turn(index++, 9000)); history.push(text); historyBytes += Buffer.byteLength(text);
  }
  fs.writeFileSync(transcript, history.join('')); history.length = 0;
  const env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: directory,
    QODER_PERF_CASE: directory, QODER_PERF_TRANSCRIPT: transcript,
    NODE_OPTIONS: `--max-old-space-size=256 --import=${here}/qoder-resource-preload.mjs` };
  for (const key of ['HOOK_RETRY_DELAY','HOOK_RETRY_LOCK_WAIT_MS','HOOK_RETRY_LOCK_POLL_MS','HOOK_RETRY_BOUNDARY_POLL_INTERVAL_MS']) delete env[key];
  const audit = () => rows(directory + '/audit.jsonl');
  let peakRSSMiB = 0; let peakProcesses = 0; let guardHit = false; let worker;
  const parsed = []; const collectorSamples = []; const hookMs = [];
  const wrappers = new Set();
  const known = () => new Set([...wrappers, ...audit().flatMap(row => [row.pid, row.childPid].filter(Boolean))]);
  let sampling;
  const sample = () => {
    if (sampling) return sampling;
    sampling = (async () => {
      const pids = [...known()]; if (!pids.length) return;
      // Keep one asynchronous ps in flight. Sampling must not block the
      // parent's Hook completion/timeout handlers or create a process storm.
      const output = await new Promise(resolve => execFile('ps', ['-o', 'pid=,rss=,stat=', '-p', pids.join(',')],
        { encoding: 'utf8', timeout: 1500 }, (_error, stdout) => resolve(stdout ?? '')));
      const processes = output.trim().split('\n').filter(Boolean).flatMap(line => {
        const [pid, rss, stat] = line.trim().split(/\s+/);
        return stat?.startsWith('Z') ? [] : [{ pid: Number(pid), rss: Number(rss) / 1024 }];
      });
      const total = processes.reduce((sum, proc) => sum + proc.rss, 0);
      peakRSSMiB = Math.max(peakRSSMiB, total); peakProcesses = Math.max(peakProcesses, processes.length);
      if (total > 1536) { guardHit = true; fs.writeFileSync(directory + '/stop', 'rss-cap'); for (const proc of processes) try { process.kill(proc.pid, 'SIGKILL'); } catch {} }
    })().finally(() => { sampling = null; });
    return sampling;
  };
  const timer = setInterval(sample, 50);
  const waitMessage = () => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('collector timed out')), 10000);
    worker.once('message', value => { clearTimeout(deadline); value.error ? reject(new Error(value.error)) : resolve(value); });
  });
  async function collect() {
    if (!worker) return;
    const message = waitMessage(); worker.send('collect');
    const result = await message; parsed.push(...result.records); collectorSamples.push(result);
  }
  async function hook(event = 'Stop') {
    const wrapper = path.join(revision === 'baseline' ? baseline : candidate,
      agentId === 'qoder' ? 'qoder-loongsuite-pilot-hook.sh' : 'qodercn-loongsuite-pilot-hook.sh');
    const child = spawn('/bin/bash', [wrapper, agentId], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    // Register immediately, before Node's preload starts: short candidate Hooks
    // can otherwise exit entirely between the 50 ms samples and bias totals.
    wrappers.add(child.pid);
    const start = performance.now(); let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Hook timed out')); }, 10000);
      child.on('error', reject); child.on('close', code => { clearTimeout(deadline); code === 0 ? resolve() : reject(new Error(stderr)); });
    });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'synthetic-session', transcript_path: transcript, cwd: directory }));
    await done; wrappers.delete(child.pid);
    assert.equal(stdout.trim(), '{}'); hookMs.push(performance.now() - start);
    await collect();
  }
  try {
    if (revision === 'candidate') {
      worker = spawn(node, [here + '/qoder-collector-worker.mjs', candidate + '/qoder/transcript-collector.mjs', agentId], { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      await waitMessage();
    }
    if (natural) {
      fs.appendFileSync(transcript, jsonl(turn(index).slice(0, 2)));
      await hook('UserPromptSubmit');
      for (let tool = 0; tool < 3; tool++) {
        fs.appendFileSync(transcript, jsonl([
          { type: 'assistant', timestamp: at(index * 10000 + 100 + tool * 1000), message: { id: 'call-' + tool, role: 'assistant', model: 'synthetic-model', content: [{ type: 'tool_use', id: 'tool-' + tool, name: 'Read', input: { path: 'synthetic.txt' } }], stop_reason: 'tool_use' } },
          { type: 'progress', timestamp: at(index * 10000 + 120 + tool * 1000), data: { hookEvent: 'PreToolUse' } }]));
        await hook('PreToolUse');
        fs.appendFileSync(transcript, jsonl([
          { type: 'user', timestamp: at(index * 10000 + 200 + tool * 1000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-' + tool, content: 'ok' }] } },
          { type: 'progress', timestamp: at(index * 10000 + 220 + tool * 1000), data: { hookEvent: 'PostToolUse' } }]));
        await hook('PostToolUse');
      }
      fs.appendFileSync(transcript, jsonl(turn(index).slice(2))); await hook('Stop');
      await sample(); await sleep(1000);
      fs.appendFileSync(transcript, jsonl([{ type: 'last-prompt' }]));
      for (let cycle = 0; cycle < 14; cycle++) { await collect(); await sleep(500); }
    } else {
      fs.appendFileSync(transcript, jsonl([...turn(index), { type: 'last-prompt' }]));
      await hook(); const cold = collectorSamples.at(-1);
      for (const event of ['PreToolUse', 'PostToolUse', 'Stop']) await hook(event);
      const warm = collectorSamples.slice(1);
      fs.appendFileSync(transcript, jsonl([...turn(index + 1), { type: 'last-prompt' }])); await hook();
      assert.equal(warm.reduce((sum, item) => sum + item.metrics.bytesRead, 0), 0);
      if (cold) assert.ok(cold.metrics.bytesRead < 2 * 1048576);
    }
    const events = revision === 'candidate' ? parsed : rows(path.join(directory, 'logs', agentId, 'history', `${agentId}-2026-10-31.jsonl`));
    // Daily file names use wall-clock local date, not fixture timestamps.
    if (revision === 'baseline' && !events.length) {
      const logs = path.join(directory, 'logs', agentId, 'history');
      if (fs.existsSync(logs)) for (const file of fs.readdirSync(logs).filter(name => name.endsWith('.jsonl'))) events.push(...rows(path.join(logs, file)));
    }
    const counts = Object.fromEntries(['other','llm.request','llm.response','tool.call','tool.result'].map(name => [name, events.filter(row => row['event.name'] === name).length]));
    assert.equal(counts.other, natural ? 1 : 2);
    assert.equal(counts['llm.response'], natural ? 4 : 2);
    if (natural) { assert.equal(counts['tool.call'], 3); assert.equal(counts['tool.result'], 3); }
    if (worker) { worker.send('stop'); await new Promise(resolve => worker.once('exit', resolve)); }
    await sample();
    const observed = audit();
    assert.equal(guardHit, false); assert.equal(observed.some(row => row.event === 'guard'), false);
    const maximumRSS = Math.max(0, ...observed.filter(row => row.event === 'exit').map(row => row.maxRSSKiB / 1024));
    return { revision, agentId, sizeMiB, hookMs, counts, fullReads: observed.filter(row => row.event === 'full-read').length,
      fullReadBytes: observed.filter(row => row.event === 'full-read').reduce((sum, row) => sum + row.bytes, 0),
      retrySpawns: observed.filter(row => row.event === 'spawn').length, peakRSSMiB, peakProcesses, maximumProcessRSSMiB: maximumRSS,
      collector: collectorSamples.map(({ metrics, elapsedMs, cpu, rssMiB }) => ({ metrics, elapsedMs, cpu, rssMiB })),
      runtimes: [...new Set(observed.filter(row => row.event === 'start').map(row => row.node))] };
  } finally {
    clearInterval(timer);
    await sampling;
    for (const pid of known()) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    worker?.kill();
  }
}
for (const agent of process.argv.includes('--natural-only') ? [] : ['qoder', 'qoder-cn']) {
  for (const size of [1, 8, 32]) for (const revision of ['baseline', 'candidate']) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const result = await runCase(revision, agent, size); report.scale.push(result);
      console.log(JSON.stringify({ revision, agent, size, repeat, hookMs: result.hookMs, maxRSSMiB: result.maximumProcessRSSMiB }));
    }
  }
}
for (const revision of ['baseline', 'candidate']) report.natural.push(await runCase(revision, 'qoder-cn', 8, true));
report.allAssertionsPassed = true;
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(path.join(output, 'results.json'));
