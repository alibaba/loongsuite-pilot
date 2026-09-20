import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {installCopilotShellIntegration,removeCopilotShellIntegration,needsCopilotShellIntegration} from '../../../src/deployment/copilot-shell-integration.js';
describe('Copilot native telemetry shell activation',()=>{
 let home:string,data:string;
 beforeEach(async()=>{home=await fs.mkdtemp(path.join(os.tmpdir(),'copilot shell '));data=path.join(home,"pilot's data");await fs.writeFile(path.join(home,'.bashrc'),'export USER_SETTING=preserved\n');});
 afterEach(async()=>{await fs.rm(home,{recursive:true,force:true});});
 const activate=(extra:Record<string,string>={})=>{
 const env={PATH:process.env.PATH,HOME:home,...extra};
 return execFileSync('bash',['--noprofile','--rcfile',path.join(home,'.bashrc'),'-ic','printf "%s" "${COPILOT_OTEL_FILE_EXPORTER_PATH-unset}"'],{env,stdio:['ignore','pipe','ignore']}).toString();
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
 it('removes only managed configuration and prevents activation after disable',async()=>{
 await installCopilotShellIntegration(data,home);await removeCopilotShellIntegration(data,home);
 expect(activate()).toBe('unset');expect(await fs.readFile(path.join(home,'.bashrc'),'utf8')).toContain('export USER_SETTING=preserved');expect(await needsCopilotShellIntegration(data,home)).toBe(true);
 });
});
