import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {installCopilotShellIntegration,removeCopilotShellIntegration,needsCopilotShellIntegration} from '../../../src/deployment/copilot-shell-integration.js';
describe('Copilot native telemetry shell activation',()=>{
 let home:string,data:string;
 beforeEach(async()=>{home=await fs.mkdtemp(path.join(os.tmpdir(),'copilot shell '));data=path.join(home,"pilot's data");await fs.writeFile(path.join(home,'.bashrc'),'export USER_SETTING=preserved\n');});
 afterEach(async()=>{await fs.rm(home,{recursive:true,force:true});});
 const activate=(extra:Record<string,string>={})=>{
 const env={PATH:process.env.PATH,HOME:home,...extra};
 const result=spawnSync('bash',['--noprofile','--rcfile',path.join(home,'.bashrc'),'-ic','printf "%s" "${COPILOT_OTEL_FILE_EXPORTER_PATH-unset}" >&3'],{env,stdio:['ignore','ignore','ignore','pipe']});
 expect(result.status).toBe(0);return (result.output[3] as Buffer).toString();
 };
 it('activates native file export in fresh shells and repairs managed block idempotently',async()=>{
 await installCopilotShellIntegration(data,home);await installCopilotShellIntegration(data,home);
 const profile=await fs.readFile(path.join(home,'.bashrc'),'utf8');expect(profile.match(/# >>>/g)).toHaveLength(1);expect(profile).toContain('export USER_SETTING=preserved');expect(await needsCopilotShellIntegration(data,home)).toBe(false);
 expect(activate()).toContain(path.join(data,'state','copilot','otel','copilot-'));
 });
 it('preserves explicit user file, remote exporter and disabled settings',async()=>{
 await installCopilotShellIntegration(data,home);
 expect(activate({COPILOT_OTEL_FILE_EXPORTER_PATH:'/tmp/user-otel.jsonl'})).toBe('/tmp/user-otel.jsonl');
 for(const setting of [{OTEL_EXPORTER_OTLP_ENDPOINT:'http://localhost:4318'},{COPILOT_OTEL_ENABLED:'false'},{COPILOT_OTEL_EXPORTER_TYPE:'otlp-http'}])expect(activate(setting)).toBe('unset');
 });
 it('preserves profile symlinks and modes on install and cleanup',async()=>{
 const target=path.join(home,'actual rc');await fs.writeFile(target,'export KEEP=1\n',{mode:0o640});
 await fs.chmod(target,0o664);
 await fs.rm(path.join(home,'.bashrc'));await fs.symlink(target,path.join(home,'.bashrc'));
 await installCopilotShellIntegration(data,home);
 expect((await fs.lstat(path.join(home,'.bashrc'))).isSymbolicLink()).toBe(true);
 expect((await fs.stat(target)).mode&0o777).toBe(0o664);expect(activate()).toContain('copilot-');
 await removeCopilotShellIntegration(data,home);
 expect(await fs.readFile(target,'utf8')).toBe('export KEEP=1\n');
 expect((await fs.lstat(path.join(home,'.bashrc'))).isSymbolicLink()).toBe(true);
 });
 it('retains dangling profile symlinks instead of replacing them',async()=>{
 await fs.rm(path.join(home,'.bashrc'));await fs.symlink(path.join(home,'missing'),path.join(home,'.bashrc'));
 await expect(installCopilotShellIntegration(data,home)).rejects.toThrow();
 expect((await fs.lstat(path.join(home,'.bashrc'))).isSymbolicLink()).toBe(true);
 });
 it('removes only managed configuration and prevents activation after disable',async()=>{
 await installCopilotShellIntegration(data,home);await removeCopilotShellIntegration(data,home);
 expect(activate()).toBe('unset');expect(await fs.readFile(path.join(home,'.bashrc'),'utf8')).toContain('export USER_SETTING=preserved');expect(await needsCopilotShellIntegration(data,home)).toBe(true);
 });
});
