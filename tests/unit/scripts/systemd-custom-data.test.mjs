import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source=fs.readFileSync('scripts/loongsuite-pilot.sh','utf8');
const names=['_systemd_quote','_systemd_working_directory','_write_systemd_user_unit','_write_systemd_user_updater_unit','_write_systemd_system_unit','_write_systemd_system_updater_unit'];
const functions=names.map(name=>source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0]).join('\n');
let tmp;
beforeEach(()=>{tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-systemd-data-'));});
afterEach(()=>fs.rmSync(tmp,{recursive:true,force:true}));
function run(body, extraEnv = {}) {
  return spawnSync('bash',['-c',`set -euo pipefail
DATA_DIR="$TEST_ROOT/data % with spaces"
CACHE_DIR="$TEST_ROOT/cache % with spaces"
if [ -n "\${TEST_WORKDIR:-}" ]; then CACHE_DIR="$TEST_WORKDIR"; fi
CONFIG_FILE="$DATA_DIR/config.json"
SYSTEMD_USER_UNIT_DIR="$TEST_ROOT/user-units"
SYSTEMD_SYSTEM_UNIT_DIR="$TEST_ROOT/system-units"
whoami() { echo caller; }
resolve_user_home() { echo "$TEST_ROOT/homes/$1"; }
maybe_sudo() { "$@"; }
ensure_dirs() { :; }
${functions}
${body}`],{encoding:'utf8',timeout:5000,env:{...process.env,TEST_ROOT:tmp,...extraEnv}});
}
describe.skipIf(process.platform==='win32')('systemd installation paths',()=>{
  it('passes custom config/data/cache to both user services with literal percent escaping',()=>{
    const result=run('_write_systemd_user_unit\n_write_systemd_user_updater_unit');
    expect(result.status).toBe(0);
    for(const file of ['loongsuite-pilot.service','loongsuite-pilot-updater.service']) {
      const unit=fs.readFileSync(path.join(tmp,'user-units',file),'utf8');
      expect(unit).toContain(`Environment="AGENT_DATA_COLLECTION_CONFIG=${tmp}/data %% with spaces/config.json"`);
      expect(unit).toContain(`Environment="LOONGSUITE_PILOT_DATA_DIR=${tmp}/data %% with spaces"`);
      expect(unit).toContain(`Environment="LOONGSUITE_PILOT_CACHE_DIR=${tmp}/cache %% with spaces"`);
      expect(unit).toContain(`WorkingDirectory=${tmp}/cache %% with spaces`);
    }
  });
  it('uses caller custom paths for system services and keeps another user on that user home',()=>{
    const result=run('_write_systemd_system_unit caller\n_write_systemd_system_updater_unit caller\n_write_systemd_system_unit other');
    expect(result.status).toBe(0);
    for(const file of ['loongsuite-pilot-caller.service','loongsuite-pilot-updater-caller.service']) {
      expect(fs.readFileSync(path.join(tmp,'system-units',file),'utf8'))
        .toContain(`Environment="LOONGSUITE_PILOT_DATA_DIR=${tmp}/data %% with spaces"`);
    }
    const other=fs.readFileSync(path.join(tmp,'system-units/loongsuite-pilot-other.service'),'utf8');
    expect(other).toContain(`Environment="LOONGSUITE_PILOT_DATA_DIR=${tmp}/homes/other/.loongsuite-pilot"`);
    expect(other).not.toContain('/data %% with spaces');
  });
  it('quotes embedded quotes, backslashes and newlines as single directive values',()=>{
    // Exercise the helper with an independent process so env contents never get
    // interpolated into shell code.
    const escaped=spawnSync('bash',['-c',`${functions}\n_systemd_quote "$TEST_VALUE"`],{
      encoding:'utf8',env:{...process.env,TEST_VALUE:'a"b\\c\n%h'},timeout:5000,
    });
    expect(escaped.status).toBe(0);
    expect(escaped.stdout).toBe('"a\\"b\\\\c\\n%%h"');
  });

  it('rejects unsafe working directories before writing any of the four units',()=>{
    for (const writer of ['_write_systemd_user_unit','_write_systemd_user_updater_unit',
      '_write_systemd_system_unit caller','_write_systemd_system_updater_unit caller']) {
      for (const suffix of ['\nUser=root','\rUser=root','\\',' ','\t']) {
        const result=run(writer,{TEST_WORKDIR:`${tmp}/cache${suffix}`});
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Invalid systemd working directory');
        expect(fs.existsSync(path.join(tmp,'user-units'))).toBe(false);
        expect(fs.existsSync(path.join(tmp,'system-units'))).toBe(false);
      }
    }
  });

  it.skipIf(!fs.existsSync('/usr/bin/systemd-analyze'))('preserves literal quotes and backslashes in WorkingDirectory without wrapping it in quotes',()=>{
    const workdir=`${tmp}/cache "quoted"\\literal % with spaces`;
    const result=run('_write_systemd_user_unit\n_write_systemd_user_updater_unit\n_write_systemd_system_unit caller\n_write_systemd_system_updater_unit caller',
      {TEST_WORKDIR:workdir});
    expect(result.status,result.stderr).toBe(0);
    for (const [directory,files] of [['user-units',['loongsuite-pilot.service','loongsuite-pilot-updater.service']],
      ['system-units',['loongsuite-pilot-caller.service','loongsuite-pilot-updater-caller.service']]]) {
      for (const file of files) {
        const unit=path.join(tmp,directory,file);
        const content=fs.readFileSync(unit,'utf8');
        expect(content).toContain(`WorkingDirectory=${workdir.replaceAll('%','%%')}\n`);
        expect(content.match(/^WorkingDirectory=/gm)).toHaveLength(1);
        fs.writeFileSync(unit,content.replace(/^ExecStart=.*$/m,'ExecStart=/usr/bin/true'));
        const check=spawnSync('/usr/bin/systemd-analyze',['verify','--generators=no',unit],{encoding:'utf8',timeout:15000});
        expect(check.status,check.stderr).toBe(0);
      }
    }
  });

  it.skipIf(!fs.existsSync('/usr/bin/systemd-analyze'))('generates units accepted by the real systemd parser',()=>{
    expect(run('_write_systemd_user_unit\n_write_systemd_user_updater_unit').status).toBe(0);
    for(const file of ['loongsuite-pilot.service','loongsuite-pilot-updater.service']) {
      const unit=path.join(tmp,'user-units',file);
      // Validate directives without requiring the real user's Pilot executable.
      fs.writeFileSync(unit,fs.readFileSync(unit,'utf8').replace(/^ExecStart=.*$/m,'ExecStart=/usr/bin/true'));
      const result=spawnSync('/usr/bin/systemd-analyze',['verify',unit],{encoding:'utf8',timeout:15000});
      expect(result.status,result.stderr).toBe(0);
    }
  });
});
