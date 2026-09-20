import {it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
it('Unix uninstall removes only Pilot Copilot registration, assets and environment',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'copilot-uninstall-'));const data=path.join(home,'pilot');
 try {
 const root=path.join(home,'.copilot');const plugin=path.join(root,'installed-plugins/loongsuite-pilot/loongsuite-pilot');fs.mkdirSync(plugin,{recursive:true});
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({enabledPlugins:{'loongsuite-pilot@loongsuite-pilot':true,'third@third':true},user:'keep'}));
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({installedPlugins:[{name:'loongsuite-pilot',marketplace:'loongsuite-pilot'},{name:'third',marketplace:'third'}]}));
 fs.writeFileSync(path.join(home,'.bashrc'),'export KEEP=1\n# >>> loongsuite-pilot copilot otel >>>\nexport COPILOT_OTEL_FILE_EXPORTER_PATH=/tmp/native\n# <<< loongsuite-pilot copilot otel <<<\n');
 fs.mkdirSync(path.join(data,'state/copilot'),{recursive:true});fs.writeFileSync(path.join(data,'state/copilot/otel-enabled'),'');
 const source=fs.readFileSync('deploy/installer-opensource.sh','utf8');const start=source.indexOf('remove_copilot_plugin() {');const end=source.indexOf('\n}',source.indexOf('remove_copilot_otel_environment() {'))+2;
 execFileSync('bash',['-c',source.slice(start,end)+'\nremove_copilot_plugin\nremove_copilot_otel_environment'],{env:{...process.env,HOME:home,DATA_DIR:data}});
 expect(JSON.parse(fs.readFileSync(path.join(root,'settings.json'),'utf8'))).toEqual({enabledPlugins:{'third@third':true},user:'keep'});
 expect(JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8')).installedPlugins).toEqual([{name:'third',marketplace:'third'}]);
 expect(fs.existsSync(plugin)).toBe(false);expect(fs.readFileSync(path.join(home,'.bashrc'),'utf8')).toBe('export KEEP=1\n');expect(fs.existsSync(path.join(data,'state/copilot/otel-enabled'))).toBe(false);
 } finally {fs.rmSync(home,{recursive:true,force:true});}
});
