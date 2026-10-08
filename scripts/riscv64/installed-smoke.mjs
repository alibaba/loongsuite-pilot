#!/usr/bin/env node
// Installed-artifact checks. This file must execute in a disposable RISC-V guest.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../install-riscv64-deps.mjs';
import { JSONL_VALIDATOR_JS } from '../e2e/lib/e2e-scenarios.mjs';
import { createFixtureProbe, eventQuality } from './installed-fixture.mjs';
import { installationBoundaries, publicUpgradeEnvironment } from './installation-boundaries.mjs';

const options = {};
const args = process.argv.slice(2);
while (args.length) {
  const flag = args.shift(); const value = args.shift();
  if (!flag?.startsWith('--') || !value) throw new Error('Use --case CASE --artifacts DIR --data-dir DIR; see docs/riscv64.md for required case arguments');
  options[flag.slice(2)] = value;
}
assert.equal(process.arch, 'riscv64'); assert.equal(process.platform, 'linux');
assert.ok(['all', 'install', 'lifecycle', 'agent', 'upgrade', 'fixture', 'native-failure', 'node18', 'node18-install', 'boundaries'].includes(options.case), 'Only implemented cases may be selected');
assert.ok(options.artifacts && options['data-dir'], '--artifacts and --data-dir are required');
const artifacts = path.resolve(options.artifacts);
assert.ok(!fs.existsSync(artifacts), 'Choose a new artifact directory; earlier results must be retained');
fs.mkdirSync(artifacts, { recursive: true });
const data = path.resolve(options['data-dir']);
const cache = path.resolve(options['cache-dir'] || path.join(os.homedir(), '.loongsuite-pilot'));
const cli = path.resolve(options.cli || path.join(os.homedir(), '.local/bin/loongsuite-pilot'));
const env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: data, LOONGSUITE_PILOT_CACHE_DIR: cache,
  AGENT_DATA_COLLECTION_CONFIG: path.join(data, 'config.json'), LOONGSUITE_PILOT_LANG: 'en' };
const report = { case: options.case, recorded_at: new Date().toISOString(), arch: process.arch,
  node: process.version, data_dir: data, cache_dir: cache, installed_artifact: true, status: 'failed', steps: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z'; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function versionDir() {
  const current = fs.readFileSync(path.join(cache, 'current'), 'utf8').trim();
  assert.ok(current && path.basename(current) === current, 'Version pointer must name one directory');
  return { current, dir: path.join(cache, 'versions', current) };
}
async function command(label, executable, argv, timeoutMs=120000, requireSuccess=true, extraEnv={}) {
  const result = await runCommand(executable, argv, { cwd: os.homedir(), env: { ...env, ...extraEnv }, timeoutMs, logPath: path.join(artifacts, `${label}.log`) });
  report.steps.push({ label, executable, args: argv, ...result });
  if (requireSuccess) assert.ok(result.exit_code === 0 && !result.timed_out && !result.interrupted && !result.error, `${label} failed: ${JSON.stringify(result)}`);
  return result;
}
async function waitHealthy(previousPid) {
  const started = Date.now();
  while (Date.now()-started < 120000) {
    const record = readJson(path.join(data, 'logs/runtime.json'));
    const pid = Number(fs.existsSync(path.join(data, 'loongsuite-pilot.pid')) ? fs.readFileSync(path.join(data, 'loongsuite-pilot.pid'),'utf8').trim() : 0);
    if (record?.status === 'active' && record.pid === pid && pid !== previousPid && alive(pid)
      && Date.parse(record.updatedAt) >= started-60000) {
      const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').filter(Boolean);
      const version = versionDir();
      assert.ok(commandLine.includes(path.join(cache,'bin/collector-daemon.js')) || commandLine.includes(path.join(version.dir,'dist/index.js')), 'PID does not belong to installed collector');
      const metadata = Object.fromEntries(fs.readFileSync(path.join(version.dir,'VERSION'),'utf8').trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
      assert.equal(record.packageVersion, metadata.version);
      assert.equal(record.gitCommit, metadata.git_commit);
      return { ...record, current: version.current, command_line: commandLine,
        init_type: fs.readFileSync(path.join(data,'init-type'),'utf8').trim(), wait_ms: Date.now()-started };
    }
    await sleep(500);
  }
  throw new Error('Installed collector did not reach fresh PID/version-matched health within 120s');
}

try {
  if (options.case === 'all') {
    for(const key of ['package','installer','agent-entry','agent-node','package-b','package-bad','package-deps-bad','node18']) {
      assert.ok(options[key],`All cases require --${key}; do not silently skip a planned acceptance`);
    }
    report.cases=[];
    for(const [label,selected] of [['install','install'],['lifecycle','lifecycle'],['boundaries','boundaries'],['upgrade','upgrade'],
      ['fixture','fixture'],['agent','agent'],['native-failure','native-failure'],['node18-install','node18-install'],['node18','node18'],['agent-restored','agent']]) {
      const childOptions={...options,case:selected,artifacts:path.join(artifacts,label)};
      await command(`case-${label}`,process.execPath,[fileURLToPath(import.meta.url),
        ...Object.entries(childOptions).flatMap(([k,v])=>[`--${k}`,v])],90*60_000);
      const result=readJson(path.join(childOptions.artifacts,'result.json'));
      assert.equal(result?.status,'passed');
      report.cases.push({case:label,status:result.status,result:path.join(childOptions.artifacts,'result.json')});
    }
  } else if (options.case === 'install') {
    assert.ok(options.package && options.installer, 'Install requires --package and --installer');
    await command('installer', 'bash', [path.resolve(options.installer), 'install', '--package-url',
      `file://${path.resolve(options.package)}`, '--data-dir', data, '--agents', 'qwen-code-cli',
      '--prefer-system-node', '--lang', 'en', '--userId', 'riscv64-installed-probe'], 40*60_000);
    report.health = await waitHealthy();
    await command('status', cli, ['status']);
    await command('info', cli, ['info']);
    for (const file of ['hooks/qwen-code-cli-loongsuite-pilot-hook.sh','plugins/pi-coding-agent/index.mjs']) {
      assert.ok(fs.existsSync(path.join(data,file)), `Missing installed asset ${file}`);
    }
    report.capabilities = readJson(path.join(data,'native-capabilities.json'));
    assert.ok(report.capabilities, 'Missing native capability diagnostics');
  } else if (options.case === 'lifecycle') {
    await command('start-initial', cli, ['start']);
    const initial = await waitHealthy();
    report.initial = initial;
    assert.match(initial.init_type, /^systemd/, 'This guest must exercise systemd service management');
    await command('status-initial', cli, ['status']);
    await command('info-initial', cli, ['info']);
    await command('stop', cli, ['stop']);
    assert.equal(alive(initial.pid), false, 'Old collector survived stop');
    await command('start', cli, ['start']);
    const restarted = await waitHealthy(initial.pid); report.after_start = restarted;
    await command('restart', cli, ['restart']);
    report.after_restart = await waitHealthy(restarted.pid);

    const entry = path.join(versionDir().dir, 'dist/index.js');
    const backup = path.join(artifacts, 'index.js.backup'); fs.copyFileSync(entry, backup);
    const attemptedAt = Date.now()/1000;
    try {
      fs.writeFileSync(entry, "throw new Error('riscv64 lifecycle injected startup failure');\n");
      const failed = await command('restart-injected-failure', cli, ['restart-collector','--defer-updater-restart'], 120000, false);
      assert.notEqual(failed.exit_code, 0, 'Startup failure returned success');
      assert.equal(failed.timed_out, false, 'CLI must produce its own bounded failure diagnostic');
      const breadcrumb = readJson(path.join(data,'logs/last-restart-failure-collector.json'));
      report.restart_failure = breadcrumb;
      assert.equal(breadcrumb?.schema, 1); assert.equal(breadcrumb?.target, 'collector');
      assert.ok(breadcrumb.stage && breadcrumb.ts >= attemptedAt-5, 'Missing/stale restart stage');
      fs.writeFileSync(path.join(artifacts,'restart-failure.json'),JSON.stringify(breadcrumb,null,2)+'\n');
      const crash = readJson(path.join(data,'logs/last-startup-crash.json'));
      report.startup_crash = crash;
      assert.ok(crash?.error_message?.includes('riscv64 lifecycle injected startup failure'));
    } finally {
      fs.copyFileSync(backup, entry);
      await command('restore-startup', cli, ['restart-collector','--defer-updater-restart']);
      report.restored = await waitHealthy(report.after_restart.pid);
    }
    assert.equal(fs.existsSync(path.join(data,'logs/last-restart-failure-collector.json')), false, 'Successful restart left a failure marker');
  } else if (options.case === 'agent') {
    assert.ok(options['agent-entry'], 'Agent case requires --agent-entry');
    report.health = await waitHealthy();
    const output = path.join(data, 'logs/output');
    const files = () => fs.existsSync(output) ? fs.readdirSync(output).filter(f=>f.startsWith('qwen-code-cli-')&&f.endsWith('.jsonl')) : [];
    const offsets = Object.fromEntries(files().map(file=>[file, fs.readFileSync(path.join(output,file),'utf8').split('\n').filter(Boolean).length]));
    fs.writeFileSync(path.join(artifacts,'before-lines.json'),JSON.stringify(offsets,null,2)+'\n');
    const agentScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-preflight.mjs');
    await command('real-agent', options['agent-node'] || process.execPath,
      [agentScript, path.resolve(options['agent-entry']), path.join(artifacts,'agent')], 6*60_000);
    const newDir = path.join(artifacts,'new-jsonl'); fs.mkdirSync(newDir);
    const deadline = Date.now()+90000;
    let events = [];
    while (Date.now()<deadline) {
      events = [];
      for (const file of files()) {
        const lines=fs.readFileSync(path.join(output,file),'utf8').split('\n').filter(Boolean).slice(offsets[file]||0);
        fs.writeFileSync(path.join(newDir,file),lines.join('\n')+(lines.length?'\n':''));
        events.push(...lines.map(line=>JSON.parse(line)));
      }
      if (events.some(e=>e['gen_ai.turn.end']===true)) break;
      await sleep(500);
    }
    assert.ok(events.length>0, 'No new Agent events; empty validation is not acceptance');
    assert.ok(events.some(e=>e['event.name']==='llm.response'), 'No model response in Agent capture');
    assert.ok(events.some(e=>e['gen_ai.turn.end']===true), 'Agent capture did not complete a turn within 90s');
    await command('strict-validator', process.execPath, ['-e',JSONL_VALIDATOR_JS], 60000, true,
      { _JV_LOG_DIR: newDir, E2E_JSONL_STRICT:'1', E2E_JSONL_AGENT_FILTER:'qwen-code-cli' });
    report.event_count = events.length;
    report.event_counts = Object.fromEntries([...new Set(events.map(e=>e['event.name']))].map(name=>[name,events.filter(e=>e['event.name']===name).length]));
    report.privacy = { synthetic_api_key_absent: !JSON.stringify(events).includes('pilot-local-test'),
      scope: 'Synthetic local test key only; no claim of comprehensive PII coverage' };
    assert.equal(report.privacy.synthetic_api_key_absent,true);
    report.live_model=false;
    report.agent = readJson(path.join(artifacts,'agent/result.json'));
    report.quality = eventQuality(events);
  } else if (options.case === 'fixture') {
    report.before = await waitHealthy();
    const fixture = createFixtureProbe({data,artifacts,command});
    report.fixture=fixture.report;
    await fixture.phase('baseline');
    await command('fixture-restart',cli,['restart']);
    report.after_restart=await waitHealthy(report.before.pid);
    await fixture.phase('after-restart');
  } else if (options.case === 'boundaries') {
    report.boundaries=await installationBoundaries({data,cache,cli,artifacts,options,env,command,waitHealthy});
  } else if (options.case === 'node18-install') {
    assert.ok(options.node18, 'Node18 installation requires --node18');
    const node18 = fs.realpathSync(options.node18);
    await command('node18-version', node18, ['-e', "if(process.arch!=='riscv64'||!process.version.startsWith('v18.'))process.exit(1);console.log(process.version,process.arch)"]);
    const installed = versionDir().dir;
    const clean = path.join(artifacts, 'clean-package'); fs.mkdirSync(clean);
    for (const file of ['package.json','package-lock.json']) fs.copyFileSync(path.join(installed,file),path.join(clean,file));
    const npm = path.join(path.dirname(node18),'npm');
    const nodeEnv = { PATH: `${path.dirname(node18)}:${env.PATH}` };
    const strict = await command('engine-strict', node18, [npm,'install','--prefix',clean,
      '--omit=dev','--omit=optional','--ignore-scripts','--engine-strict','--no-audit','--no-fund'], 5*60_000, false, nodeEnv);
    assert.equal(strict.timed_out,false);
    const strictLog = fs.readFileSync(path.join(artifacts,'engine-strict.log'),'utf8');
    if (strict.exit_code !== 0) {
      assert.match(strictLog,/EBADENGINE/);
      assert.match(strictLog,/@loongsuite\/otel-util-genai/);
    }
    report.engine_strict = { exit_code: strict.exit_code, compatible: strict.exit_code === 0,
      note: 'The upstream dependency declares Node >=20. A runtime probe does not override that declaration.' };
    // Start the default-policy check without dependencies left by the strict attempt.
    fs.rmSync(path.join(clean,'node_modules'),{recursive:true,force:true});
    await command('clean-native-install',node18,[path.join(installed,'scripts/install-riscv64-deps.mjs'),
      '--package-dir',clean,'--log-dir',path.join(artifacts,'native-install'),'--npm-bin',npm],35*60_000,true,
      {...nodeEnv,npm_config_engine_strict:'false'});
    const compatibility = path.join(path.dirname(fileURLToPath(import.meta.url)),'runtime-native-compat.cjs');
    await command('clean-native-compatibility',node18,[compatibility,clean,path.join(artifacts,'native-compatibility'),node18]);
    await command('real-genai-conversion',node18,[path.join(path.dirname(fileURLToPath(import.meta.url)),
      'genai-runtime-probe.mjs'),clean]);
  } else if (options.case === 'node18') {
    assert.ok(options.node18,'Node18 compatibility requires --node18 /absolute/path/to/node');
    const node18=fs.realpathSync(options.node18);
    await command('node18-version',node18,['-e',"if(process.arch!=='riscv64'||!process.version.startsWith('v18.'))process.exit(1);console.log(process.version,process.arch)"]);
    report.before=await waitHealthy();
    const compatibility=path.join(path.dirname(fileURLToPath(import.meta.url)),'runtime-native-compat.cjs');
    await command('native-compatibility',process.execPath,[compatibility,versionDir().dir,
      path.join(artifacts,'native-compatibility'),node18,process.execPath]);
    const pins=[path.join(cache,'node-bin'),path.join(data,'node-bin')];
    const previousPins=pins.map(file=>fs.existsSync(file)?fs.readFileSync(file):null);
    const fixture=createFixtureProbe({data,artifacts,command});report.fixture=fixture.report;
    await fixture.phase('node22-baseline');
    try {
      for(const pin of pins)fs.writeFileSync(pin,node18+'\n');
      await command('restart-node18',cli,['restart']);
      report.node18=await waitHealthy(report.before.pid);
      assert.equal(fs.realpathSync(`/proc/${report.node18.pid}/exe`),node18);
      await fixture.phase('node18-capture');
      const selected={...options,case:'agent',artifacts:path.join(artifacts,'node18-real-agent')};
      await command('node18-real-agent',process.execPath,[fileURLToPath(import.meta.url),
        ...Object.entries(selected).flatMap(([k,v])=>[`--${k}`,v])],10*60_000);
    } finally {
      pins.forEach((file,i)=>{if(previousPins[i])fs.writeFileSync(file,previousPins[i]);else fs.rmSync(file,{force:true});});
      await command('restore-runtime',cli,['restart']);
      report.restored=await waitHealthy(report.node18?.pid);
    }
    await fixture.phase('node22-restored-capture');
  } else if (options.case === 'native-failure') {
    const initial = await waitHealthy(); report.initial=initial;
    const fixture=createFixtureProbe({data,artifacts,command});report.fixture=fixture.report;
    await fixture.phase('healthy-baseline');
    const sqlite=path.join(versionDir().dir,'node_modules/sqlite3');
    const saved=path.join(artifacts,'sqlite3.backup');
    const binary=path.join(sqlite,'build/Release/node_sqlite3.node');
    const original=path.join(artifacts,'node_sqlite3.node.backup');
    assert.ok(fs.existsSync(binary),'Start native failure checks from a healthy source-built addon');
    fs.copyFileSync(binary,original);
    report.failures=[];
    for(const mode of ['missing','broken']) {
      const before=await waitHealthy();
      await command(`${mode}-stop`,cli,['stop']);
      try {
        if(mode==='missing') fs.renameSync(sqlite,saved);
        else fs.writeFileSync(binary,'riscv64 deliberately invalid ELF file\n');
        await command(`${mode}-start`,cli,['start']);
        const health=await waitHealthy(before.pid);
        const capability=readJson(path.join(data,'native-capabilities.json'));
        assert.equal(capability?.sqlite3?.available,false);
        assert.ok(Date.parse(capability.checked_at)>=Date.now()-120000,'Capability report is stale');
        assert.equal(fs.existsSync(path.join(data,'daemon.fatal')),false,'Degraded core must not leave a native fatal marker');
        await command(`${mode}-status`,cli,['status']);
        await command(`${mode}-info`,cli,['info']);
        await fixture.phase(`${mode}-capture`);
        report.failures.push({mode,health,capability});
      } finally {
        await command(`${mode}-stop-for-restore`,cli,['stop']);
        if(mode==='missing' && fs.existsSync(saved)) fs.renameSync(saved,sqlite);
        if(mode==='broken') fs.copyFileSync(original,binary);
        await command(`${mode}-restore`,cli,['start']);
        report.restored=await waitHealthy(before.pid);
      }
      assert.equal(readJson(path.join(data,'native-capabilities.json'))?.sqlite3?.available,true);
      await fixture.phase(`${mode}-restored-capture`);
    }
  } else {
    for (const key of ['package-b','package-bad','installer']) assert.ok(options[key], `Upgrade requires --${key}`);
    const upgradeEnv=publicUpgradeEnvironment({artifacts,installer:options.installer,env});
    const snapshot = () => {
      const state={};
      for(const file of ['config.json','logs/input-state.json','logs/snapshot-store.json']) {
        const p=path.join(data,file);
        if(fs.existsSync(p))state[file]={sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),json:readJson(p)};
      }
      return state;
    };
    const before = await waitHealthy(); report.before=before;
    const fixture = createFixtureProbe({data,artifacts,command});
    report.fixture = fixture.report;
    await fixture.phase('before-upgrade');
    report.state_before=snapshot();
    const failed=await command('public-upgrade-bad',cli,['upgrade','--version','1.2.99'],40*60_000,false,upgradeEnv(options['package-bad']));
    assert.notEqual(failed.exit_code,0,'Bad upgrade unexpectedly succeeded');
    assert.equal(failed.timed_out,false,'Public upgrade must recover within its own budget');
    report.after_failed_upgrade=await waitHealthy(before.pid);
    assert.equal(report.after_failed_upgrade.current,before.current,'Bad upgrade did not restore the original version');
    await fixture.phase('after-failed-upgrade');
    report.state_after_failed=snapshot();
    assert.equal(report.state_after_failed['config.json'].sha256,report.state_before['config.json'].sha256);
    await command('public-upgrade-b',cli,['upgrade','--version','1.2.1'],40*60_000,true,upgradeEnv(options['package-b']));
    report.after_upgrade=await waitHealthy(report.after_failed_upgrade.pid);
    assert.equal(report.after_upgrade.packageVersion,'1.2.1');
    assert.notEqual(report.after_upgrade.current,before.current);
    await fixture.phase('after-upgrade');
    report.state_after_upgrade=snapshot();
    assert.equal(report.state_after_upgrade['config.json'].sha256,report.state_before['config.json'].sha256);
    await command('public-rollback',cli,['rollback']);
    report.after_rollback=await waitHealthy(report.after_upgrade.pid);
    assert.equal(report.after_rollback.current,before.current);
    await fixture.phase('after-rollback');
    report.state_after_rollback=snapshot();
    assert.equal(report.state_after_rollback['config.json'].sha256,report.state_before['config.json'].sha256);
    assert.equal(fs.readFileSync(path.join(artifacts,'installer-transport.log'),'utf8').trim().split('\n').length,2);
  }
  report.status = 'passed';
} catch (error) { report.error = error.stack || String(error); }
finally {
  report.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({case:report.case,status:report.status,error:report.error,
    result:path.join(artifacts,'result.json'),steps:report.steps.map(({label,exit_code,timed_out,elapsed_ms})=>
      ({label,exit_code,timed_out,elapsed_ms}))},null,2));
}
process.exitCode = report.status === 'passed' ? 0 : 1;
