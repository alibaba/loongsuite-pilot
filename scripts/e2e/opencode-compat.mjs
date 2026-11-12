/** Real CLI/model smoke test in fresh HOME/XDG directories. No host Pilot changes.
 * OPENCODE_V1_BIN / OPENCODE_V2_BIN: exact installed CLI binaries.
 * PILOT_COMPAT_PACKAGE: installed candidate package root (defaults to this repo).
 * DASHSCOPE_API_KEY: test model credential (never persisted in artifacts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { JSONL_VALIDATOR_JS } from './lib/e2e-scenarios.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const candidate = process.env.PILOT_COMPAT_PACKAGE || repo;
const root = process.env.PILOT_COMPAT_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-opencode-compat-'));
const targets = [['v1', process.env.OPENCODE_V1_BIN], ['v2', process.env.OPENCODE_V2_BIN]].filter(([, bin]) => bin);
if (!targets.length || !process.env.DASHSCOPE_API_KEY) throw new Error('Set CLI binary paths and DASHSCOPE_API_KEY');
console.log('Artifacts:', root);
fs.mkdirSync(root, { recursive: true });

async function run(command, args, env, cwd, artifact, timeout = 180000) {
  const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  const killTimer = setTimeout(() => child.kill('SIGKILL'), timeout + 5000);
  let status;
  try { status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); }
  finally { clearTimeout(timer); clearTimeout(killTimer); }
  const result = { ...status, stdout, stderr };
  fs.writeFileSync(artifact, JSON.stringify(result, null, 2));
  if (status.code !== 0) throw new Error(`${path.basename(artifact)} failed: ${status.code ?? status.signal}; inspect artifact`);
  return result;
}

const summary = [];
for (const [generation, binary] of targets) {
  const home = path.join(root, generation), cfg = path.join(home, '.config/opencode');
  const data = path.join(home, '.loongsuite-pilot'), cwd = path.join(home, 'project');
  fs.mkdirSync(cfg, { recursive: true }); fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'probe.txt'), 'PILOT_COMPAT_FILE_CONTENT_7391\n');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OPENCODE_|LOONGSUITE_|ARMS_|OTEL_)/.test(key)) delete env[key];
  delete env.NODE_OPTIONS; delete env.BUN_OPTIONS;
  Object.assign(env, {
    HOME: home, USERPROFILE: home, PWD: cwd, OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCODE_CONFIG_DIR: cfg, LOONGSUITE_PILOT_DATA_DIR: data,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', PATH: `${path.dirname(binary)}:${process.env.PATH}`,
  });
  const version = await run(binary, ['--version'], env, cwd, path.join(home, 'version.json'), 30000);
  console.log(generation, version.stdout.trim());
  if (generation === 'v1') {
    // V1 installs its plugin SDK on first launch. Prepare that normal runtime
    // dependency explicitly so slow registry retries cannot hide plugin results.
    await run('npm', ['install', '--prefix', cfg, '--ignore-scripts', '--no-audit', '--no-fund',
      '--prefer-offline', '--cache', path.join(os.homedir(), '.npm'), '--fetch-timeout=20000', '--fetch-retries=0',
      `@opencode-ai/plugin@${version.stdout.trim()}`], env, cwd, path.join(home, 'sdk-install.json'));
  }
  fs.writeFileSync(path.join(cfg, 'opencode.json'), JSON.stringify({
    model: 'pilot-test/qwen-plus', small_model: 'pilot-test/qwen-plus',
    permission: { '*': 'allow' },
    provider: { 'pilot-test': {
      npm: '@ai-sdk/openai-compatible', name: 'Pilot compatibility probe',
      options: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '{env:DASHSCOPE_API_KEY}' },
      models: { 'qwen-plus': { name: 'Qwen Plus', tool_call: true, limit: { context: 131072, output: 8192 } } },
    } },
  }, null, 2));
  const agents = Object.fromEntries(fs.readdirSync(path.join(candidate, 'agents.d')).filter(f => f.endsWith('.json')).map(f => [f.slice(0, -5), { enabled: f === 'opencode.json', captureMessageContent: true }]));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ agents, dataDir: data,
    autoUpdate: { enabled: false }, sls: [], http: { enabled: false }, jsonl: { enabled: true },
    dashboard: { port: 24000 + process.pid % 10000 },
  }));
  await run(process.execPath, [path.join(candidate, 'scripts/postinstall.js')], env, cwd, path.join(home, 'postinstall.json'));
  await run(process.execPath, [path.join(candidate, 'dist/index.js'), 'deploy', '--require', 'opencode', '--json'], env, cwd, path.join(home, 'deploy.json'));
  const prompt = `Use the read tool to read this absolute path: ${path.join(cwd, 'probe.txt')}. Then reply with the exact file contents and PILOT_COMPAT_DONE. You must actually call the tool; do not guess the contents.`;
  const args = ['run', '--model', 'pilot-test/qwen-plus', '--format', 'json', '--title', 'Pilot compatibility probe'];
  if (generation === 'v2') args.push('--standalone', '--auto');
  args.push(prompt);
  const result = await run(binary, args, env, cwd, path.join(home, 'turn.json'));
  if (!result.stdout.includes('PILOT_COMPAT_DONE')) throw new Error(`${generation}: missing CLI completion marker`);
  await new Promise(resolve => setTimeout(resolve, 500));
  const spool = path.join(data, 'logs/opencode');
  const expectedResponses = fs.existsSync(spool) ? fs.readdirSync(spool).filter(f => f.endsWith('.jsonl')).flatMap(f => fs.readFileSync(path.join(spool, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)).filter(r => r['event.name'] === 'llm.response').length : 0;
  // Start the installed collector against the real plugin spool and wait for
  // canonical output. Only this run's HOME/dataDir is visible to the collector.
  const collector = spawn(process.execPath, [path.join(candidate, 'dist/index.js')], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let collectorLog = '';
  collector.stdout.on('data', b => collectorLog += b); collector.stderr.on('data', b => collectorLog += b);
  const output = path.join(data, 'logs/output');
  try {
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(output)) {
        const rows = fs.readdirSync(output).filter(f => f.startsWith('opencode') && f.endsWith('.jsonl')).flatMap(f => fs.readFileSync(path.join(output, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
        if (expectedResponses > 0 && rows.filter(r => r['event.name'] === 'llm.response').length >= expectedResponses) break;
      }
      if (collector.exitCode !== null) throw new Error('Collector exited before output');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } finally {
    collector.kill('SIGTERM');
    await new Promise(resolve => { if (collector.exitCode !== null || collector.signalCode !== null) return resolve(); collector.once('exit', resolve); setTimeout(() => { collector.kill('SIGKILL'); resolve(); }, 5000).unref(); });
    fs.writeFileSync(path.join(home, 'collector.log'), collectorLog);
  }
  const validatorPath = path.join(home, 'validator.cjs');
  fs.writeFileSync(validatorPath, JSONL_VALIDATOR_JS);
  await run(process.execPath, [validatorPath], { ...env, _JV_LOG_DIR: output, E2E_JSONL_STRICT: '1', E2E_JSONL_AGENT_FILTER: 'opencode' }, cwd, path.join(home, 'validation.json'), 30000);
  const logs = path.join(data, 'logs/opencode');
  const records = fs.existsSync(logs) ? fs.readdirSync(logs).filter(f => f.endsWith('.jsonl')).flatMap(f => fs.readFileSync(path.join(logs, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)) : [];
  const counts = Object.fromEntries([...new Set(records.map(r => r['event.name']))].map(name => [name, records.filter(r => r['event.name'] === name).length]));
  const responses = records.filter(r => r['event.name'] === 'llm.response');
  const calls = records.filter(r => r['event.name'] === 'tool.call');
  const results = records.filter(r => r['event.name'] === 'tool.result');
  const assertions = {
    request: counts['llm.request'] > 0,
    response: responses.length > 0,
    tokens: responses.some(r => r['gen_ai.usage.input_tokens'] > 0 && r['gen_ai.usage.output_tokens'] > 0),
    input: records.some(r => JSON.stringify(r['gen_ai.input.messages'] ?? r['gen_ai.input.messages_delta'] ?? '').includes('probe.txt')),
    output: responses.some(r => JSON.stringify(r['gen_ai.output.messages'] ?? '').includes('PILOT_COMPAT_DONE')),
    tool: calls.length > 0 && calls.every(c => results.some(r => r['gen_ai.tool.call.id'] === c['gen_ai.tool.call.id'])),
    pairing: records.filter(r => r['event.name'] === 'llm.request').every(q => responses.some(r => r['gen_ai.step.id'] === q['gen_ai.step.id'])),
    uniqueEvents: new Set(records.map(r => r['event.id'])).size === records.length,
    model: responses.every(r => r['gen_ai.request.model'] === 'qwen-plus'),
  };
  const report = { generation, version: version.stdout.trim(), counts, assertions, tokens: responses.map(r => ({ input: r['gen_ai.usage.input_tokens'], output: r['gen_ai.usage.output_tokens'] })) };
  fs.writeFileSync(path.join(home, 'summary.json'), JSON.stringify(report, null, 2));
  summary.push(report); console.log(JSON.stringify(report));
  if (!Object.values(assertions).every(Boolean)) throw new Error(`${generation}: collection assertions failed`);
}
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
