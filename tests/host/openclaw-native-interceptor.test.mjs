// Optional host integration: actual deployed plugin -> actual native CLI ->
// production Rust loopback server and builtin sensitive-data rules.
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {pathToFileURL} from 'node:url';import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';import {once} from 'node:events';
let root,data,cache,server;let sequence=0;
const suffix=process.platform==='win32'?'.exe':'';
const sourceBinary=process.env.PILOT_NATIVE_INTERCEPTOR_BINARY;
const serverBinary=process.env.PILOT_NATIVE_INTERCEPTOR_SERVER;
function diagnostics(){const log=path.join(data,'interceptor/logs/access.log');return fs.existsSync(log)?fs.readFileSync(log,'utf8'):'no access log';}
function event(id,text='LTAI1234567890ABCD'){return {toolName:'read',message:{toolCallId:id,content:[{type:'text',text}]}};}
async function handlers(pluginPath=path.resolve('assets/plugins/openclaw/plugin.mjs'),version='2026.6.10'){
 const plugin=(await import(/* @vite-ignore */ `${pathToFileURL(pluginPath).href}?native=${++sequence}`)).default;
 const out={};plugin.register({registrationMode:'full',runtime:{version},on:(name,fn)=>{out[name]=fn;},registerAgentToolResultMiddleware:()=>{}});return out;
}
function install(version='2.0.0-test'){
 const folder=path.join(cache,'versions',version,'bin');fs.mkdirSync(folder,{recursive:true});
 const binary=path.join(folder,`loongsuite-pilot${suffix}`);fs.copyFileSync(sourceBinary,binary);if(process.platform!=='win32')fs.chmodSync(binary,0o700);
 fs.writeFileSync(path.join(cache,'current'),`\uFEFF${version}\r\n`);return binary;
}
async function start(){
 const child=spawn(serverBinary,[data],{stdio:['pipe','pipe','pipe'],windowsHide:true});let errors='';child.stderr.on('data',v=>{errors+=v;});
 await new Promise((resolve,reject)=>{const lines=createInterface({input:child.stdout});const timer=setTimeout(()=>{child.kill();reject(new Error(`native server startup exceeded5s: ${errors}`));},5000);child.once('error',reject);child.once('exit',code=>{if(code!==null && code!==0)reject(new Error(`native server exited${code}: ${errors}`));});lines.on('line',line=>{try{if(JSON.parse(line).ready){clearTimeout(timer);resolve();}}catch{}});});return child;
}
beforeEach(async()=>{
 if(!sourceBinary || !path.isAbsolute(sourceBinary) || !serverBinary || !path.isAbsolute(serverBinary))throw new Error('Build native loongsuite-pilot and host_openclaw_interceptor_server; supply absolute PILOT_NATIVE_INTERCEPTOR_BINARY/SERVER.');
 root=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw native entry '));data=path.join(root,'synthetic data');cache=path.join(root,'cache directory');fs.mkdirSync(data);fs.mkdirSync(cache);
 vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR',data);vi.stubEnv('LOONGSUITE_PILOT_CACHE_DIR',cache);vi.stubEnv('LOONGSUITE_PILOT_BIN','');vi.stubEnv('INTERCEPTOR_CLI','');vi.stubEnv('PILOT_TEST_CLIENT_HANG','');vi.stubEnv('PILOT_TEST_CLIENT_EXIT_FAILURE','');
 server=await start();
});
afterEach(async()=>{
 if(server && server.exitCode===null){server.stdin.end();const stopped=once(server,'exit');const timer=setTimeout(()=>server.kill(),3000);await stopped;clearTimeout(timer);}server=undefined;
 vi.unstubAllEnvs();if(root)fs.rmSync(root,{recursive:true,force:true});
 globalThis[Symbol.for('loongsuite-pilot.openclaw.first-token')]?.dispose();
});
describe('OpenClaw installed native synchronous interception',()=>{
 it('uses the versioned native binary for a real synchronous block and clean allow',async()=>{
  install();const h=await handlers();const blocked=h.tool_result_persist(event('native-sensitive'),{sessionId:'synthetic-session'});
  expect(blocked?.then).toBeUndefined();expect(blocked?.message?.toolCallId,diagnostics()).toBe('native-sensitive');
  expect(blocked.message.content[0].text).toContain('[ACCESSKEY_BLOCKED]');expect(JSON.stringify(blocked)).not.toContain('LTAI1234567890ABCD');
  expect(h.tool_result_persist(event('native-clean','ordinary result'),{sessionId:'synthetic-session'})).toBeUndefined();
 });
 it('supports a separate native binary override without using the host Node executable',async()=>{
  vi.stubEnv('INTERCEPTOR_CLI',sourceBinary);const h=await handlers();const result=h.tool_result_persist(event('native-override'),{});expect(result?.message?.content[0].text,diagnostics()).toContain('[ACCESSKEY_BLOCKED]');
 });
 it.each(['../escape','..','.','v/escape','v\\escape','v:ADS','bad.','x'.repeat(241),'x'.repeat(1025)])('fails open for unsafe current pointer %#',async(pointer)=>{
  install();fs.writeFileSync(path.join(cache,'current'),pointer);const h=await handlers();expect(h.tool_result_persist(event('unsafe-pointer'),{})).toBeUndefined();
  const log=fs.readFileSync(path.join(data,'interceptor/logs/access.log'),'utf8');expect(log).toContain('fail-open');
 });
 it('uses the explicit native hook binary and preserves a real allow decision',async()=>{
  vi.stubEnv('LOONGSUITE_PILOT_BIN',sourceBinary);const h=await handlers();
  expect(h.tool_result_persist(event('native-env-block'),{})?.message?.content[0].text).toContain('[ACCESSKEY_BLOCKED]');
  expect(h.tool_result_persist(event('native-env-allow','clean result'),{})).toBeUndefined();
 });
 it('uses the data/bin layout when no current pointer exists',async()=>{
  const bin=path.join(data,'bin');fs.mkdirSync(bin);const binary=path.join(bin,`loongsuite-pilot${suffix}`);fs.copyFileSync(sourceBinary,binary);if(process.platform!=='win32')fs.chmodSync(binary,0o700);
  expect((await handlers()).tool_result_persist(event('data-bin'),{})?.message?.content[0].text).toContain('[ACCESSKEY_BLOCKED]');
 });
 it('refuses an invalid explicit native binary rather than falling back to current',async()=>{
  install();vi.stubEnv('LOONGSUITE_PILOT_BIN','relative-binary');const h=await handlers();expect(h.tool_result_persist(event('invalid-native-override'),{})).toBeUndefined();
 });
 it('does not revive the retired default Node collector path',async()=>{
  const binary=install();fs.unlinkSync(binary);const dist=path.join(cache,'versions','2.0.0-test','dist','interceptor');fs.mkdirSync(dist,{recursive:true});
  const marker=path.join(root,'old-node-executed');fs.writeFileSync(path.join(dist,'cli.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`);
  expect((await handlers()).tool_result_persist(event('retired-node'),{})).toBeUndefined();expect(fs.existsSync(marker)).toBe(false);
 });
 it('rejects a linked installed bin directory while the real native service remains healthy',async()=>{
  const binary=install();const bin=path.dirname(binary);const moved=path.join(root,'linked-bin-target');fs.renameSync(bin,moved);fs.symlinkSync(moved,bin,process.platform==='win32'?'junction':'dir');
  expect((await handlers()).tool_result_persist(event('linked-bin'),{})).toBeUndefined();
 });
 it('checks real native daemon identity before accepting a rule verdict',async()=>{
  install();const file=path.join(data,'interceptor/runtime.json');const runtime=JSON.parse(fs.readFileSync(file));runtime.pid+=1;fs.writeFileSync(file,JSON.stringify(runtime));
  expect((await handlers()).tool_result_persist(event('wrong-identity'),{})).toBeUndefined();expect(diagnostics()).toContain('fail-open');
 });
 it('preserves an explicitly configured legacy JS adapter and its exact synchronous response',async()=>{
  const cli=path.join(root,'explicit adapter.cjs');const reason='[DATABASEURL_MASKED]';
  const text=`检测到非预期行为：${reason}，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。`;
  fs.writeFileSync(cli,`const assert=require('node:assert/strict');assert.deepEqual(process.argv.slice(2),['hook','--agent','openclaw']);let data='';process.stdin.on('data',v=>data+=v);process.stdin.on('end',()=>{const p=JSON.parse(data);assert.equal(p.openclaw_hook,'tool_result_persist');process.stdout.write(JSON.stringify({message:{...p.tool_response,content:[{type:'text',text:${JSON.stringify(text)}}]}}));});`);
  vi.stubEnv('INTERCEPTOR_CLI',cli);const result=(await handlers()).tool_result_persist(event('legacy-explicit'),{});
  expect(result?.then).toBeUndefined();expect(result).toEqual({message:{toolCallId:'legacy-explicit',content:[{type:'text',text}]}});
 });
 it('preserves the legacy explicit JS adapter nonzero-plus-valid-JSON behavior',async()=>{
  const cli=path.join(root,'failing adapter.cjs');fs.writeFileSync(cli,`process.stdout.write(JSON.stringify({message:{content:[{type:'text',text:'must not block'}]}}));process.exitCode=7;`);vi.stubEnv('INTERCEPTOR_CLI',cli);
  expect((await handlers()).tool_result_persist(event('bad-exit'),{})).toEqual({message:{content:[{type:'text',text:'must not block'}]}});
 });
 it('bounds an actually hung native child at the existing four-second timeout and fails open',async()=>{
  vi.stubEnv('INTERCEPTOR_CLI',serverBinary);vi.stubEnv('PILOT_TEST_CLIENT_HANG','1');const h=await handlers();const began=performance.now();
  expect(h.tool_result_persist(event('hung-native'),{})).toBeUndefined();const elapsed=performance.now()-began;expect(elapsed).toBeGreaterThanOrEqual(3900);expect(elapsed).toBeLessThan(6000);expect(diagnostics()).toContain('ETIMEDOUT');
 });

 it('uses the native executable beside packaged plugin resources rather than an unrelated current version',async()=>{
  const release=path.join(root,'packaged release');const plugins=path.join(release,'assets/plugins');fs.mkdirSync(plugins,{recursive:true});
  for(const name of ['openclaw','shared'])fs.cpSync(path.resolve('assets/plugins',name),path.join(plugins,name),{recursive:true});
  const bin=path.join(release,'bin');fs.mkdirSync(bin);const binary=path.join(bin,`loongsuite-pilot${suffix}`);fs.copyFileSync(sourceBinary,binary);if(process.platform!=='win32')fs.chmodSync(binary,0o700);
  fs.writeFileSync(path.join(release,'runtime-manifest.json'),JSON.stringify({schema:1,runtime:'native',version:'2.0.0-test',binary:`bin/loongsuite-pilot${suffix}`,resources:[]}));
  fs.writeFileSync(path.join(cache,'current'),'../unrelated');
  // Vite 5 treats percent-encoded temp paths as literal filenames. Execute
  // this packaged copy in the actual Node host loader instead of changing the
  // real space-containing path or weakening the resource-boundary assertion.
  const pluginUrl=pathToFileURL(path.join(plugins,'openclaw/plugin.mjs')).href;
  const code=`const {default:plugin}=await import(${JSON.stringify(pluginUrl)});const h={};plugin.register({registrationMode:'full',runtime:{version:'2026.6.10'},on:(name,fn)=>h[name]=fn,registerAgentToolResultMiddleware:()=>{}});const result=h.tool_result_persist(${JSON.stringify(event('packaged-native'))},{});console.log(JSON.stringify(result));globalThis[Symbol.for('loongsuite-pilot.openclaw.first-token')]?.dispose();`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:5000,windowsHide:true});
  expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);
  const result=JSON.parse(child.stdout);expect(result?.message?.content[0].text).toContain('[ACCESSKEY_BLOCKED]');
 });
 it('does not treat a dangling current pointer as permission to run a fallback binary',async()=>{
  const bin=path.join(data,'bin');fs.mkdirSync(bin);const binary=path.join(bin,`loongsuite-pilot${suffix}`);fs.copyFileSync(sourceBinary,binary);if(process.platform!=='win32')fs.chmodSync(binary,0o700);
  fs.symlinkSync(path.join(root,'missing-version-pointer'),path.join(cache,'current'),'file');
  expect((await handlers()).tool_result_persist(event('dangling-current'),{})).toBeUndefined();
 });

 it('fails open on a genuinely native nonzero exit even if it prints a block JSON object',async()=>{
  vi.stubEnv('INTERCEPTOR_CLI',serverBinary);vi.stubEnv('PILOT_TEST_CLIENT_EXIT_FAILURE','1');
  expect((await handlers()).tool_result_persist(event('native-bad-exit'),{})).toBeUndefined();expect(diagnostics()).toContain('exited 7');
 });
 it('retains the inherited legacy-host collection-only boundary without claiming modern interception',async()=>{
  install();const h=await handlers(undefined,'2026.3.8');expect(h.tool_result_persist).toBeTypeOf('function');
  expect(h.tool_result_persist(event('legacy-host-only'),{})).toBeUndefined();expect(fs.existsSync(path.join(data,'interceptor/logs/access.log'))).toBe(false);
 });

});
