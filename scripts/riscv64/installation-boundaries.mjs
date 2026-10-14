// Boundary failures in the real guest; injected subprocesses are labelled as such.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runCommand } from './run-command.mjs';
import { createFixtureProbe } from './installed-fixture.mjs';

export function publicUpgradeEnvironment({artifacts, installer, env}) {
  const transport=path.join(artifacts,'transport');fs.mkdirSync(transport);
  const program=`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');const a=process.argv.slice(2);
if(a.includes('https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh')){
const i=a.indexOf('-o');if(i<0)process.exit(2);fs.copyFileSync(${JSON.stringify(path.resolve(installer))},a[i+1]);
fs.appendFileSync(${JSON.stringify(path.join(artifacts,'installer-transport.log'))},'served pinned local installer\\n');
}else{const r=cp.spawnSync('/usr/bin/curl',a,{stdio:'inherit'});process.exit(r.status??1);}
`;
  fs.writeFileSync(path.join(transport,'curl'),program,{mode:0o755});
  return packageFile=>({PATH:`${transport}:${env.PATH}`,LOONGSUITE_PILOT_PACKAGE_URL:`file://${path.resolve(packageFile)}`});
}

export async function installationBoundaries({data,cache,cli,artifacts,options,env,command,waitHealthy}) {
  for(const key of ['installer','package-deps-bad'])assert.ok(options[key],`Boundaries require --${key}`);
  const result={cases:[],injections:'Invalid archive/local dependency; simulated architecture response and stalled acceptance subprocess'};
  const config=fs.readFileSync(path.join(data,'config.json'));
  const pin=fs.readFileSync(path.join(data,'node-bin'));
  const initial=await waitHealthy();result.initial=initial;
  const upgradeEnv=publicUpgradeEnvironment({artifacts,installer:options.installer,env});
  const invalid=path.join(artifacts,'invalid.tar.gz');fs.writeFileSync(invalid,'intentionally not a tar archive\n');
  for(const [label,file] of [['download-missing',path.join(artifacts,'missing-package.tar.gz')],['invalid-archive',invalid]]) {
    const r=await command(label,cli,['upgrade','--version','1.2.98'],120000,false,upgradeEnv(file));
    assert.notEqual(r.exit_code,0);assert.equal(r.timed_out,false);
    const health=await waitHealthy();assert.equal(health.current,initial.current);assert.equal(health.pid,initial.pid);
    assert.deepEqual(fs.readFileSync(path.join(data,'config.json')),config);
    result.cases.push({label,...r,health});
  }
  const architecture=path.join(artifacts,'architecture');fs.mkdirSync(architecture);
  const wrapper=path.join(architecture,'node');
  fs.writeFileSync(wrapper,`#!${process.execPath}
const cp=require('node:child_process');const a=process.argv.slice(2);
if(a[0]==='-p'&&a[1]==='process.arch'){console.log('x64');process.exit(0);}
const r=cp.spawnSync(${JSON.stringify(process.execPath)},a,{stdio:'inherit'});process.exit(r.status??1);
`,{mode:0o755});
  const wrong=await command('wrong-node-architecture','bash',[path.resolve(options.installer),'upgrade',
    '--data-dir',data,'--prefer-system-node','--package-url',`file://${invalid}`,'--lang','en'],120000,false,
    {PATH:`${architecture}:${env.PATH}`});
  assert.notEqual(wrong.exit_code,0);assert.equal(wrong.timed_out,false);
  assert.match(fs.readFileSync(path.join(artifacts,'wrong-node-architecture.log'),'utf8'),/requires riscv64 Node.js; selected Node architecture is x64/);
  assert.deepEqual(fs.readFileSync(path.join(data,'node-bin')),pin,'Architecture failure replaced runtime pin');
  assert.equal((await waitHealthy()).pid,initial.pid);
  result.cases.push({label:'wrong-node-architecture',simulated_arch_response:true,...wrong});

  const fixture=createFixtureProbe({data,artifacts,command});result.fixture=fixture.report;
  await fixture.phase('before-dependency-failure');
  const bad=await command('javascript-dependency-failure',cli,['upgrade','--version','1.2.98'],10*60_000,false,
    upgradeEnv(options['package-deps-bad']));
  assert.notEqual(bad.exit_code,0);assert.equal(bad.timed_out,false);
  assert.match(fs.readFileSync(path.join(artifacts,'javascript-dependency-failure.log'),'utf8'),/JavaScript dependency installation failed/);
  const health=await waitHealthy(initial.pid);assert.equal(health.current,initial.current);
  assert.deepEqual(fs.readFileSync(path.join(data,'config.json')),config);
  await fixture.phase('after-dependency-failure');
  result.cases.push({label:'javascript-dependency-failure',...bad,health});

  // Reinstall the active version with a deliberately broken dependency payload.
  // The old directory and both pointers must survive before any activation.
  const currentFile=path.join(cache,'current');
  const previousFile=path.join(cache,'previous');
  const current=fs.readFileSync(currentFile,'utf8');
  const previous=fs.existsSync(previousFile)?fs.readFileSync(previousFile,'utf8'):null;
  const installed=path.join(cache,'versions',current.trim());
  const entryHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(installed,'dist/index.js'))).digest('hex');
  const sameStage=path.join(artifacts,'same-version');fs.mkdirSync(sameStage);
  await command('same-version-extract','tar',['-xzf',path.resolve(options['package-deps-bad']),'-C',sameStage]);
  const samePackage=path.join(sameStage,'loongsuite-pilot');
  fs.copyFileSync(path.join(installed,'VERSION'),path.join(samePackage,'VERSION'));
  const sameArchive=path.join(artifacts,'same-version-bad.tar.gz');
  await command('same-version-package','tar',['-czf',sameArchive,'-C',sameStage,'loongsuite-pilot']);
  const same=await command('same-version-install-failure','bash',[path.resolve(options.installer),'install',
    '--data-dir',data,'--prefer-system-node','--package-url',`file://${sameArchive}`,
    '--agents','qwen-code-cli','--lang','en'],10*60_000,false);
  assert.notEqual(same.exit_code,0);assert.equal(same.timed_out,false);
  assert.match(fs.readFileSync(path.join(artifacts,'same-version-install-failure.log'),'utf8'),/JavaScript dependency installation failed/);
  assert.equal(fs.readFileSync(currentFile,'utf8'),current);
  assert.equal(fs.existsSync(previousFile)?fs.readFileSync(previousFile,'utf8'):null,previous);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(installed,'dist/index.js'))).digest('hex'),entryHash);
  assert.deepEqual(fs.readFileSync(path.join(data,'config.json')),config);
  const restored=await waitHealthy(health.pid);
  assert.equal(restored.current,initial.current);
  await fixture.phase('after-same-version-install-failure');
  result.cases.push({label:'same-version-install-failure',...same,health:restored,original_payload_preserved:true});

  const timeoutDir=path.join(artifacts,'subprocess-timeout');fs.mkdirSync(timeoutDir);
  const childPid=path.join(timeoutDir,'descendant.pid');
  const subprocess=path.join(timeoutDir,'subprocess');
  fs.writeFileSync(subprocess,`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(childPid)},String(child.pid));setInterval(()=>{},1000);
`,{mode:0o755});
  const timeout=await runCommand(subprocess,['acceptance-timeout'],{cwd:timeoutDir,env,
    timeoutMs:12000,logPath:path.join(timeoutDir,'timeout.log')});
  assert.equal(timeout.timed_out,true);
  const descendant=Number(fs.readFileSync(childPid,'utf8'));
  const running=()=>{try{return fs.readFileSync(`/proc/${descendant}/stat`,'utf8').split(' ')[2]!=='Z';}
    catch(error){if(error.code==='ENOENT')return false;throw error;}};
  for(let i=0;i<20&&running();i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(running(),false,'Timed-out subprocess descendant survived');
  result.cases.push({label:'subprocess-timeout',simulated_subprocess:true,report:timeout,descendant_reaped:true});
  result.config_sha256=crypto.createHash('sha256').update(config).digest('hex');
  result.status='passed';
  return result;
}
