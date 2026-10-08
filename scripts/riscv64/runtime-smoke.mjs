#!/usr/bin/env node
// Source-artifact diagnostic before installer acceptance. Run only in the guest.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { JSONL_VALIDATOR_JS } from '../e2e/lib/e2e-scenarios.mjs';

const [source, built, runtime, agentNode, agentEntry, artifacts, fault] = process.argv.slice(2).map((x, i) => i === 6 ? x : path.resolve(x));
assert.equal(process.arch, 'riscv64');
assert.ok(['missing', 'broken', 'incompatible', 'healthy'].includes(fault), 'Fault must be missing|broken|incompatible|healthy');
const incompatibleNative = process.argv[9];
if (fault === 'incompatible') assert.ok(incompatibleNative && fs.existsSync(incompatibleNative), 'Supply the incompatible .node binary as the last argument');
assert.ok(!fs.existsSync(artifacts), 'Use a new artifact directory for every attempt');
fs.mkdirSync(artifacts, { recursive: true });
const root = path.join(artifacts, 'package');
const data = path.join(artifacts, 'data');
const bin = path.join(artifacts, 'bin');
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
fs.mkdirSync(data); fs.mkdirSync(bin);
fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
await fs.promises.cp(path.join(built, 'dist'), path.join(root, 'dist'), { recursive: true });
for (const item of ['scripts', 'assets', 'agents.d']) fs.symlinkSync(path.join(source, item), path.join(root, item));
for (const item of fs.readdirSync(path.join(source, 'node_modules'))) {
  if (item === 'sqlite3' && fault !== 'healthy') continue;
  fs.symlinkSync(path.join(source, 'node_modules', item), path.join(root, 'node_modules', item));
}
if (fault === 'broken' || fault === 'incompatible') {
  const addon = path.join(root, 'node_modules', 'sqlite3');
  fs.mkdirSync(addon);
  fs.writeFileSync(path.join(addon, 'package.json'), JSON.stringify({ name: 'sqlite3', main: 'index.cjs' }));
  fs.writeFileSync(path.join(addon, 'index.cjs'), "module.exports = require('./broken.node');\n");
  if (fault === 'incompatible') fs.copyFileSync(incompatibleNative, path.join(addon, 'broken.node'));
  else fs.writeFileSync(path.join(addon, 'broken.node'), 'Deliberately invalid ELF for the RISC-V fault probe.\n');
}
const quote = x => `'${x.replaceAll("'", "'\\''")}'`;
fs.writeFileSync(path.join(bin, 'qwen'), `#!/bin/sh\nexec ${quote(agentNode)} ${quote(agentEntry)} "$@"\n`, { mode: 0o755 });
const agents = { wukong: { enabled: false } };
for (const file of fs.readdirSync(path.join(source, 'agents.d')).filter(f => f.endsWith('.json'))) {
  const def = JSON.parse(fs.readFileSync(path.join(source, 'agents.d', file), 'utf8'));
  agents[def.id] = { enabled: def.id === 'qwen-code-cli' };
}
const config = path.join(data, 'config.json');
fs.writeFileSync(config, JSON.stringify({ enabled: true, dataDir: data, userId: 'riscv64-probe-user', agents,
  jsonl: { enabled: true }, sls: { enabled: false }, http: { enabled: false },
  listeners: { 'qwen-code-cli-log': { enabled: true, pollInterval: 500 } },
  autoUpdate: { enabled: false }, dashboard: { port: 28765 } }, null, 2));
// Different diagnostic data dirs share this disposable guest's Qwen home.
// Remove only hooks installed by earlier runs under this artifact parent;
// otherwise both old/new hooks inherit the current data-dir env and duplicate events.
const qwenSettings = path.join(os.homedir(), '.qwen/settings.json');
if (fs.existsSync(qwenSettings)) {
  const original = fs.readFileSync(qwenSettings, 'utf8');
  fs.writeFileSync(path.join(artifacts, 'qwen-settings-before.json'), original);
  const settings = JSON.parse(original);
  const removed = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.map(group => {
      if (!Array.isArray(group.hooks)) return group;
      return { ...group, hooks: group.hooks.filter(hook => {
        const command = hook.command || '';
        if (command.includes(path.dirname(artifacts) + '/runtime-') && command.includes('loongsuite-pilot-hook.sh')) {
          removed.push({ event, command }); return false;
        }
        return true;
      }) };
    }).filter(group => !Array.isArray(group.hooks) || group.hooks.length > 0);
  }
  fs.writeFileSync(qwenSettings, JSON.stringify(settings, null, 2)+'\n');
  fs.writeFileSync(path.join(artifacts, 'qwen-hook-cleanup.json'), JSON.stringify(removed, null, 2)+'\n');
}
const env = { ...process.env, NODE_PATH: '', PATH: `${bin}:${path.dirname(runtime)}:/usr/local/bin:/usr/bin:/bin`,
  AGENT_DATA_COLLECTION_CONFIG: config, LOONGSUITE_PILOT_DATA_DIR: data,
  LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED: 'false', LOONGSUITE_PILOT_STDOUT: '1', QWEN_TELEMETRY_ENABLED: 'false' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function launch(exe, args, label, extraEnv = {}) {
  const child = spawn(exe, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const result = { stdout: '', stderr: '', code: undefined, signal: undefined };
  child.stdout.on('data', chunk => { result.stdout += chunk; });
  child.stderr.on('data', chunk => { result.stderr += chunk; });
  const done = new Promise(resolve => {
    child.once('error', error => { result.error = String(error); result.code = -1; resolve(result); });
    child.once('close', (code, signal) => {
      result.code = code; result.signal = signal;
      fs.writeFileSync(path.join(artifacts, `${label}.stdout.log`), result.stdout);
      fs.writeFileSync(path.join(artifacts, `${label}.stderr.log`), result.stderr);
      resolve(result);
    });
  });
  const signal = sig => { if (result.code !== undefined) return; try { process.kill(-child.pid, sig); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  async function stop() {
    signal('SIGTERM');
    const deadline = Date.now()+30000;
    while (result.code === undefined && Date.now()<deadline) await sleep(200);
    if (result.code === undefined) signal('SIGKILL');
    await done;
  }
  async function wait(ms) {
    const timer = setTimeout(() => signal('SIGTERM'), ms);
    const killTimer = setTimeout(() => signal('SIGKILL'), ms+10000);
    try { return await done; } finally { clearTimeout(timer); clearTimeout(killTimer); }
  }
  return { child, result, done, stop, wait };
}

const started = Date.now();
const summary = { fault, runtime, agent_node: agentNode, source, built, source_artifact_only: true,
  live_model: false, status: 'failed', checks: {} };
let collector;
try {
  const disabled = await launch(runtime, [path.join(root, 'dist/index.js')], 'disabled-core', { LOONGSUITE_PILOT_ENABLED: 'false' }).wait(60000);
  assert.equal(disabled.code, 0, disabled.stderr);
  summary.checks.disabled_core_exit = disabled.code;
  const setup = await launch(runtime, [path.join(root, 'scripts/postinstall.js')], 'postinstall').wait(90000);
  assert.equal(setup.code, 0, setup.stderr);
  assert.ok(!/failed asset tree|Post-install failed/.test(setup.stdout+setup.stderr), 'Asset deployment failed');
  collector = launch(runtime, [path.join(root, 'dist/index.js')], 'collector');
  const readyDeadline = Date.now()+120000;
  const serviceLog = path.join(data, 'logs/loongsuite-pilot-service.log');
  let ready = false;
  while (Date.now()<readyDeadline && collector.result.code === undefined) {
    const logs = collector.result.stdout + (fs.existsSync(serviceLog) ? fs.readFileSync(serviceLog, 'utf8') : '');
    if (logs.includes('orchestrator started')) { ready = true; break; }
    await sleep(500);
  }
  assert.ok(ready, `Collector failed readiness: ${collector.result.stderr}`);
  summary.checks.collector_ready = true;
  const output = path.join(data, 'logs/output');
  const offsets = {};
  if (fs.existsSync(output)) for (const file of fs.readdirSync(output).filter(f => f.startsWith('qwen-code-cli-') && f.endsWith('.jsonl'))) {
    offsets[file] = fs.readFileSync(path.join(output, file), 'utf8').split('\n').filter(Boolean).length;
  }
  fs.writeFileSync(path.join(artifacts, 'before-lines.json'), JSON.stringify(offsets, null, 2));
  const agent = await launch(agentNode, [path.join(source, 'scripts/riscv64/agent-preflight.mjs'), agentEntry,
    path.join(artifacts, 'agent')], 'agent-command').wait(330000);
  assert.equal(agent.code, 0, agent.stdout+agent.stderr);
  const slice = path.join(artifacts, 'new-jsonl'); fs.mkdirSync(slice);
  let events = [];
  const outputDeadline = Date.now()+90000;
  while (Date.now()<outputDeadline) {
    events = [];
    if (fs.existsSync(output)) for (const file of fs.readdirSync(output).filter(f => f.startsWith('qwen-code-cli-') && f.endsWith('.jsonl'))) {
      const lines = fs.readFileSync(path.join(output, file), 'utf8').split('\n').filter(Boolean).slice(offsets[file] || 0);
      fs.writeFileSync(path.join(slice, file), lines.join('\n')+(lines.length ? '\n' : ''));
      events.push(...lines.map(line => JSON.parse(line)));
    }
    if (events.some(e => e['event.name'] === 'llm.response')) break;
    if (collector.result.code !== undefined) throw new Error('Collector exited during Agent interaction');
    await sleep(1000);
  }
  assert.ok(events.length > 0, 'No new Qwen events; an empty validator run cannot pass');
  summary.checks.new_event_count = events.length;
  summary.checks.event_counts = Object.fromEntries([...new Set(events.map(e => e['event.name']))].map(name => [name, events.filter(e => e['event.name']===name).length]));
  const validation = await launch(runtime, ['-e', JSONL_VALIDATOR_JS], 'validator', {
    _JV_LOG_DIR: slice, E2E_JSONL_STRICT: '1', E2E_JSONL_AGENT_FILTER: 'qwen-code-cli',
  }).wait(60000);
  assert.equal(validation.code, 0, validation.stdout+validation.stderr);
  summary.checks.strict_validator_exit = 0;
  summary.checks.capability = JSON.parse(fs.readFileSync(path.join(data, 'native-capabilities.json'), 'utf8'));
  assert.equal(summary.checks.capability.sqlite3.available, fault === 'healthy');
  summary.status = 'passed';
} catch (error) { summary.error = error.stack || String(error); }
finally {
  if (collector) { await collector.stop(); summary.checks.collector_stop_exit = collector.result.code; }
  summary.elapsed_ms = Date.now()-started; summary.recorded_at = new Date().toISOString();
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(summary, null, 2)+'\n');
  console.log(JSON.stringify(summary, null, 2));
}
process.exitCode = summary.status === 'passed' ? 0 : 1;
