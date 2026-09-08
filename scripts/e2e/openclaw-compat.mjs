// Real-provider, installed Gateway acceptance. See openclaw-compat.md.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { assertOpenClawEvidence, assertContentOff, assertOpenClawSessionKey } from './openclaw-assertions.mjs';
import { JSONL_VALIDATOR_JS } from './lib/e2e-scenarios.mjs';

assert(process.env.OPENCLAW_E2E_DISPOSABLE === '1' && process.platform === 'linux'
  && (existsSync('/.dockerenv') || existsSync('/run/.containerenv')),
'Run only in a disposable Linux container; this test installs and uninstalls Pilot.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const home = os.homedir(), state = path.join(home, '.openclaw'), data = path.join(home, '.loongsuite-pilot');
assert(!existsSync(state) && !existsSync(path.join(data, 'config.json')), 'Fresh container HOME required');
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const write = (p, value) => fs.writeFile(p, JSON.stringify(value, null, 2), { mode: 0o600 });
const install = process.env.OPENCLAW_E2E_INSTALL, version = process.env.OPENCLAW_E2E_VERSION;
assert(install && /^2026\.\d+\.\d+$/.test(version ?? ''), 'Set OPENCLAW_E2E_INSTALL and exact OPENCLAW_E2E_VERSION');
assert.equal((await read(path.join(install, 'node_modules/openclaw/package.json'))).version, version);
const gatewayEntry = process.env.OPENCLAW_CLI_PATH;
assert(gatewayEntry && path.isAbsolute(gatewayEntry), 'Bind OPENCLAW_CLI_PATH to the absolute real Gateway entry');
assert.equal((await read(path.join(path.dirname(gatewayEntry), 'package.json'))).version, version);
const pathInstall = process.env.OPENCLAW_E2E_PATH_INSTALL ?? install;
const pathVersion = (await read(path.join(pathInstall, 'node_modules/openclaw/package.json'))).version;
const versionNumber = Number(version.split('.').map((v, i) => i ? v.padStart(2, '0') : v).join(''));
const provider = await read(process.env.OPENCLAW_E2E_PROVIDER_FILE);
assert(provider.provider && provider.model && provider.apiKey, 'Provider JSON requires provider, model, apiKey');
const endpoint = new URL(provider.baseUrl);
assert(endpoint.protocol === 'https:' && !endpoint.search && !endpoint.username && !endpoint.password, 'Use a credential-free HTTPS provider URL');
const cms = process.env.OPENCLAW_E2E_CMS_FILE ? (await read(process.env.OPENCLAW_E2E_CMS_FILE)).cms : undefined;
const run = process.env.OPENCLAW_E2E_RUN_ID ?? `oc-${Date.now()}`;
assert(/^[a-zA-Z0-9-]{1,64}$/.test(run), 'Invalid run ID');
const evidence = process.env.OPENCLAW_E2E_EVIDENCE ?? `/evidence/${run}`;
assert(!existsSync(evidence), 'Evidence directory must not exist');
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const workspace = path.join(evidence, 'workspace'), configPath = path.join(state, 'openclaw.json');
const pilotConfig = path.join(data, 'config.json'), cli = path.join(home, '.local/bin/loongsuite-pilot');
const service = process.env.OPENCLAW_E2E_SERVICE ?? `pilot-openclaw-gateway-${run}`, workerName = `worker-${run}`;
const env = { ...process.env, HOME: home,
  PATH: `${pathInstall}/node_modules/.bin:${home}/.local/bin:${process.env.PATH}`,
  OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath, LOONGSUITE_PILOT_DATA_DIR: data,
  LOONGSUITE_PILOT_NODE_MODULES_URL: `file://${evidence}/deps`,
  OPENCLAW_E2E_MODEL_KEY: provider.apiKey, OPENCLAW_GATEWAY_TOKEN: crypto.randomBytes(24).toString('hex'),
  AGENTTEAMS_WORKER_NAME: workerName };
for (const key of ['NODE_OPTIONS', 'BASH_ENV', 'OPENCLAW_BUNDLE_ROOT', 'OPENCLAW_VERSION',
  'OPENCLAW_SERVICE_VERSION', 'OPENCLAW_BUNDLED_VERSION', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY',
  'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'LOONGSUITE_PILOT_OTLP_ENDPOINT',
  'LOONGSUITE_PILOT_OTLP_HEADERS', 'CMS_ENDPOINT', 'CMS_LICENSE_KEY', 'CMS_WORKSPACE', 'USER_ID', 'LOONGSUITE_USER_ID']) delete env[key];
const secrets = [provider.apiKey, cms?.licenseKey, env.OPENCLAW_GATEWAY_TOKEN].filter(Boolean);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function safeFile(p, text) {
  assert(!secrets.some(secret => text.includes(secret)), 'Secret detected; refusing to archive output');
  await fs.writeFile(p, text, { mode: 0o600 });
}
function killGroup(child, signal) { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
async function command(label, exe, args, timeout = 240_000) {
  // Native CLI commands address the same bound installation as Gateway, even
  // when PATH deliberately selects another installation for the regression.
  if (exe === 'openclaw') { exe = process.execPath; args = [gatewayEntry, ...args]; }
  const chunks = [], child = spawn(exe, args, { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => chunks.push(chunk));
  const timer = setTimeout(() => killGroup(child, 'SIGKILL'), timeout);
  let code;
  try { code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
  finally { clearTimeout(timer); }
  const output = Buffer.concat(chunks).toString();
  await safeFile(path.join(evidence, `${label}.log`), output);
  assert.equal(code, 0, `${label}: exit ${code}`);
  if (label !== 'gateway-health') console.log(JSON.stringify({ stage: label, exit: code }));
  return output;
}
async function until(label, predicate, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(1500); }
  throw Error(`${label}: timeout`);
}
async function rows(dir) {
  let names;
  try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const result = [];
  for (const name of names.sort()) if (name.endsWith('.jsonl')) {
    for (const line of (await fs.readFile(path.join(dir, name), 'utf8')).split('\n')) if (line.trim()) result.push(JSON.parse(line));
  }
  return result;
}
async function archiveTree(src, dst) {
  let entries;
  try { entries = await fs.readdir(src, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  await fs.mkdir(dst, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (entry.isDirectory()) await archiveTree(path.join(src, entry.name), path.join(dst, entry.name));
    else if (entry.isFile()) await safeFile(path.join(dst, entry.name), await fs.readFile(path.join(src, entry.name), 'utf8'));
  }
}
const gwChunks = []; let gateway, gatewayClosed, installed = false, sink, sinkRequests = 0;
async function startGateway() {
  gateway = spawn(process.execPath, [path.basename(gatewayEntry), 'gateway', '--allow-unconfigured', '--bind', 'loopback', '--port', '18789'],
    { cwd: path.dirname(gatewayEntry), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  gatewayClosed = new Promise((resolve, reject) => { gateway.on('error', reject); gateway.on('close', resolve); });
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', chunk => gwChunks.push(chunk));
  await until('Gateway readiness', async () => {
    if (gateway.exitCode !== null) throw Error(`Gateway exited: ${gateway.exitCode}`);
    // Native readiness does not create an operator.read-only CLI device before
    // the first real agent RPC pairs the client with its required write scope.
    try {
      const response = await fetch('http://127.0.0.1:18789/readyz', { signal: AbortSignal.timeout(5000) });
      await safeFile(`${evidence}/gateway-health.log`, await response.text());
      return response.ok;
    }
    catch { return false; }
  });
}
async function stopGateway() {
  if (!gateway) return;
  killGroup(gateway, 'SIGTERM');
  const timer = setTimeout(() => killGroup(gateway, 'SIGKILL'), 10_000);
  try { await gatewayClosed; } finally { clearTimeout(timer); gateway = undefined; }
}
async function assertConfig() {
  const cfg = await read(configPath), entry = cfg.plugins.entries['loongsuite-pilot-openclaw'];
  assert.equal(entry?.enabled, true);
  assert.equal(entry.hooks?.allowConversationAccess, versionNumber >= 20260424 ? true : undefined);
  assert.equal(cfg.messages.ackReaction, '🧪');
  assert.deepEqual(cfg.plugins.entries['memory-core'], { enabled: false });
  assert.equal(cfg.plugins.load.paths.filter(p => p.includes('plugins/openclaw')).length, 1);
}
const sessionKey = `agent:main:${run}`, nonce = `GW_OK_${crypto.randomBytes(5).toString('hex')}`;
async function traffic(label, message, marker = nonce) {
  const params = { agentId: 'main', sessionKey, message, thinking: 'off', deliver: false, timeout: 120, idempotencyKey: `${run}-${label}` };
  const output = await command(`gateway-${label}`, 'openclaw', ['gateway', 'call', 'agent', '--params', JSON.stringify(params), '--expect-final', '--json', '--timeout', '150000'], 180_000);
  assert(output.includes(marker), `${label}: missing completion marker`);
  await until(`${label}: terminal trace`, async () => (await rows(`${data}/logs/otlp-debug`))
    .some(s => s.attributes['gen_ai.span.kind'] === 'AGENT' && s.attributes['gen_ai.turn.id'] === `${run}-${label}`));
}
const report = { run, service, workerName, openclaw: version, adapter: versionNumber >= 20260512 ? 'modern' : 'legacy',
  provider: provider.provider, model: provider.model, endpoint: provider.baseUrl, sessionKey,
  backend: cms ? 'CMS configured; independent readback required' : 'local OTLP receiver', workspace: cms?.workspace,
  node: process.version, platform: `${process.platform}-${process.arch}`,
  gatewayEntry, gatewayCwd: path.dirname(gatewayEntry), pathVersion,
  harnessSha256: crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),
  assertionsSha256: crypto.createHash('sha256').update(await fs.readFile(new URL('./openclaw-assertions.mjs', import.meta.url))).digest('hex'),
  startMs: Date.now(), checks: [] };
try {
  await fs.mkdir(state, { recursive: true }); await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'alpha.txt'), 'alpha number 17\n');
  await fs.writeFile(path.join(workspace, 'beta.txt'), 'beta number 29\n');
  await write(configPath, { gateway: { mode: 'local', bind: 'loopback', port: 18789, auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' } },
    agents: { defaults: { workspace, skipBootstrap: true, model: { primary: `${provider.provider}/${provider.model}` } } },
    models: { providers: { [provider.provider]: { baseUrl: provider.baseUrl, apiKey: '${OPENCLAW_E2E_MODEL_KEY}',
      api: provider.api ?? 'openai-completions', models: [{ id: provider.model, name: provider.model,
        reasoning: false, input: ['text'], contextWindow: provider.contextWindow ?? 128000, maxTokens: 4096 }] } } },
    messages: { ackReaction: '🧪' }, plugins: { entries: { 'memory-core': { enabled: false } } } });
  await command('package', 'bash', ['deploy/package-opensource.sh', '--skip-build', '-o', `${evidence}/pilot.tar.gz`]);
  report.packageSha256 = crypto.createHash('sha256').update(await fs.readFile(`${evidence}/pilot.tar.gz`)).digest('hex');
  const deps = `${evidence}/deps/${(await read(path.join(repo, 'package.json'))).version}`;
  const archive = `node-modules-linux-${process.arch}.tar.gz`; await fs.mkdir(deps, { recursive: true });
  await command('deps-package', 'tar', ['-czf', `${deps}/${archive}`, 'node_modules']);
  const hash = crypto.createHash('sha256').update(await fs.readFile(`${deps}/${archive}`)).digest('hex');
  await fs.writeFile(`${deps}/SHASUMS256.txt`, `${hash}  ${archive}\n`);
  const installArgs = ['deploy/installer-opensource.sh', 'install', '--prefer-system-node', '--agents', 'openclaw',
    '--user.id', run, '--collect-log', 'true', '--collect-trace', 'true', '--package-url', `file://${evidence}/pilot.tar.gz`];
  await command('install', 'bash', installArgs); installed = true;
  await assertConfig(); await command('config-valid', 'openclaw', ['config', 'validate']);
  report.checks.push('bound entry version detection independent of PATH; config validation; existing user/plugin settings preserved');
  await command('stop-before-config', cli, ['stop']);
  const cfg = await read(pilotConfig);
  cfg.serviceName = service; cfg.otlpTrace = { debug: true, captureMessageContent: true }; cfg.collectTrace = true; cfg.collectLog = true;
  if (cms) cfg.cms = { ...cms, debug: true };
  else {
    sink = http.createServer((req, res) => { req.resume(); req.on('end', () => { sinkRequests++; res.writeHead(200, { 'Content-Type': 'application/x-protobuf' }); res.end(); }); });
    await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
    cfg.otlpTrace.endpoint = `http://127.0.0.1:${sink.address().port}/v1/traces`;
  }
  cfg.agents.openclaw.captureMessageContent = true; cfg.hookWatchdog = { enabled: true, intervalMs: 3000, repairCooldownMs: 1000 };
  await write(pilotConfig, cfg); await command('start-collector', cli, ['start']); await startGateway();
  await traffic('text', `Do not use tools. Reply with exactly ${nonce}.`);
  await traffic('tools', `Use the read tool twice: read ${workspace}/alpha.txt and ${workspace}/beta.txt separately. Add the two numbers and reply with the sum and ${nonce}.`);
  assert.equal((await rows(`${data}/logs/output`)).filter(e => e['event.name'] === 'tool.result').length, 2);
  const previousIds = (await rows(`${data}/logs/output`)).map(e => e['event.id']);
  await stopGateway(); await command('stop-restart', cli, ['stop']);
  await command('start-restart', cli, ['start']); await startGateway();
  await traffic('restart', `Do not use tools. Reply with exactly ${nonce}.`);
  const afterRestart = await rows(`${data}/logs/output`);
  for (const id of previousIds) assert.equal(afterRestart.filter(e => e['event.id'] === id).length, 1, 'restart replay');
  report.checks.push('Gateway and collector restart; same native session; no replay');
  await stopGateway(); await command('stop-privacy', cli, ['stop']);
  const privateMarker = `PRIVATE_${crypto.randomBytes(12).toString('hex')}`;
  await fs.writeFile(`${workspace}/private.txt`, privateMarker);
  const privateCfg = await read(pilotConfig); privateCfg.otlpTrace.captureMessageContent = false;
  privateCfg.agents.openclaw.captureMessageContent = false; await write(pilotConfig, privateCfg);
  await command('start-privacy', cli, ['start']); await startGateway();
  await traffic('privacy', `Read ${workspace}/private.txt and ${workspace}/missing-${privateMarker}.txt using read separately. Reply with ${privateMarker} and acknowledge the missing file.`, privateMarker);
  // OTLP and canonical JSONL fan out independently. A terminal debug span
  // does not prove all JSONL writes completed; drain before taking evidence.
  await stopGateway(); await command('stop-before-validation', cli, ['stop']);
  const events = await rows(`${data}/logs/output`), spans = await rows(`${data}/logs/otlp-debug`);
  const privateEvents = events.filter(e => e['gen_ai.turn.id'] === `${run}-privacy`);
  const privateTraceIds = [...new Set(privateEvents.map(e => e.trace_id))];
  assertContentOff(privateEvents, [privateMarker]);
  assertContentOff(spans.filter(s => privateTraceIds.includes(s.traceId)), [privateMarker]);
  assertContentOff((await rows(`${data}/logs/openclaw`)).filter(e => e['gen_ai.turn.id'] === `${run}-privacy`), [privateMarker]);
  const nativeMessages = (await rows(`${state}/agents/main/sessions`)).filter(r => r.type === 'message').map(r => r.message);
  report.validation = assertOpenClawEvidence({ events, spans, nativeMessages, provider: provider.provider, model: provider.model, service, workerName, turns: 4, expectedToolErrorTraceIds: privateTraceIds });
  report.privacyTraceIds = privateTraceIds;
  report.sessionKeyValidation = assertOpenClawSessionKey({
    rawEvents: (await rows(`${data}/logs/openclaw`)).filter(e => e['gen_ai.turn.id']),
    events, spans, sessionKey,
  });
  env._JV_LOG_DIR = `${data}/logs/output`;
  env.E2E_JSONL_STRICT = '1'; env.E2E_JSONL_AGENT_FILTER = 'openclaw';
  await command('strict-jsonl-validation', process.execPath, ['-e', JSONL_VALIDATOR_JS]);
  report.checks.push('repository strict JSONL validator including system instruction text-part arrays');
  report.checks.push('native per-call tokens/cache parity; worker identity; trace topology/timing; content-off including missing-file result');
  await command('start-watchdog', cli, ['start']);
  const broken = await read(configPath), entry = broken.plugins.entries['loongsuite-pilot-openclaw'];
  if (versionNumber < 20260424) entry.hooks = { allowConversationAccess: true }; else delete entry.hooks;
  broken.plugins.load.paths = broken.plugins.load.paths.filter(p => !p.includes('plugins/openclaw'));
  await write(configPath, broken);
  await until('watchdog repair', async () => { try { await assertConfig(); return true; } catch { return false; } });
  await command('config-valid-repair', 'openclaw', ['config', 'validate']);
  await command('reinstall', 'bash', installArgs); await assertConfig();
  await command('config-valid-reinstall', 'openclaw', ['config', 'validate']);
  await command('stop-final', cli, ['stop']);
  assert.equal((await rows(`${data}/logs/otlp-failed`)).length, 0, 'persisted OTLP failures');
  await archiveTree(`${data}/logs`, `${evidence}/pilot-logs`);
  await command('uninstall', 'bash', ['deploy/installer-opensource.sh', 'uninstall']); installed = false;
  const removed = await read(configPath);
  assert.equal(removed.plugins?.entries?.['loongsuite-pilot-openclaw'], undefined);
  assert(!(removed.plugins?.load?.paths ?? []).some(p => p.includes('plugins/openclaw')));
  assert.deepEqual(removed.plugins.entries['memory-core'], { enabled: false }); assert.equal(removed.messages.ackReaction, '🧪');
  await command('config-valid-uninstall', 'openclaw', ['config', 'validate']);
  report.checks.push('watchdog repair; idempotent reinstall; uninstall removes only Pilot config');
  if (!cms) assert(sinkRequests > 0, 'No OTLP requests received');
  report.verdict = 'PASS';
} catch (error) { report.verdict = 'FAIL'; report.error = String(error); process.exitCode = 1; }
finally {
  await stopGateway();
  if (installed) try { await command('stop-cleanup', cli, ['stop']); } catch { /* retain original failure */ }
  await archiveTree(`${data}/logs`, `${evidence}/pilot-logs`);
  await archiveTree(`${state}/agents/main/sessions`, `${evidence}/native-sessions`);
  await safeFile(`${evidence}/gateway-process.log`, Buffer.concat(gwChunks).toString());
  if (sink) await new Promise(resolve => sink.close(resolve));
  report.endMs = Date.now(); await write(`${evidence}/result.json`, report); console.log(JSON.stringify(report));
}
