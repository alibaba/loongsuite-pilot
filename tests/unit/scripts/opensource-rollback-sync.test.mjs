import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source=fs.readFileSync('scripts/loongsuite-pilot.sh','utf8');
const sync=source.match(/sync_installed_scripts_from_version\(\) \{[\s\S]*?\n\}/)[0];
const start=source.match(/cmd_start\(\) \{[\s\S]*?\n\}/)[0];
let dir;
beforeEach(()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-public-rollback-'));
  fs.mkdirSync(path.join(dir,'version/scripts'),{recursive:true});
  for(const name of ['collector-daemon.js','loongsuite-pilot.sh'])fs.writeFileSync(path.join(dir,'version/scripts',name),'target-version');
  fs.mkdirSync(path.join(dir,'bootstrap'));
  fs.writeFileSync(path.join(dir,'bootstrap/updater-daemon.js'),'old-updater');
});
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}));
const run=extra=>spawnSync('bash',['-c',`set -euo pipefail
BOOTSTRAP_DIR="$TEST_DIR/bootstrap"
LOONGSUITE_PILOT_BIN="$TEST_DIR/bin/pilot"
${sync}
${extra||''}
if ! sync_installed_scripts_from_version "$TEST_DIR/version"; then exit 17; fi
`],{encoding:'utf8',timeout:5000,env:{...process.env,TEST_DIR:dir}});

describe.skipIf(process.platform==='win32')('public rollback payload and startup failure',()=>{
  it('rolls back a public package without an updater and removes a stale updater bootstrap',()=>{
    expect(run().status).toBe(0);
    expect(fs.readFileSync(path.join(dir,'bin/pilot'),'utf8')).toBe('target-version');
    expect(fs.readFileSync(path.join(dir,'bootstrap/collector-daemon.js'),'utf8')).toBe('target-version');
    expect(fs.existsSync(path.join(dir,'bootstrap/updater-daemon.js'))).toBe(false);
  });
  it('retains the updater when the target actually supplies one',()=>{
    fs.writeFileSync(path.join(dir,'version/scripts/updater-daemon.js'),'target-updater');
    expect(run().status).toBe(0);
    expect(fs.readFileSync(path.join(dir,'bootstrap/updater-daemon.js'),'utf8')).toBe('target-updater');
  });
  it('propagates copy failures even when called in a conditional that disables errexit',()=>{
    fs.writeFileSync(path.join(dir,'version/scripts/updater-daemon.js'),'target-updater');
    // Fail only the first copy. Later copies would succeed, so the original
    // function could hide this failure behind its successful final command.
    expect(run('cp() { if [ "$2" = "$TEST_DIR/version/scripts/collector-daemon.js" ]; then return 9; fi; command cp "$@"; }').status).toBe(17);
    expect(fs.existsSync(path.join(dir,'bin/pilot'))).toBe(false);
  });
  it('returns failure if registration succeeds but the collector does not stay alive',()=>{
    const result=spawnSync('bash',['-c',`set -euo pipefail
cleanup_legacy_monitor_processes() { :; }
is_running() { return 1; }
ensure_dirs() { :; }
sync_bootstrap_scripts() { :; }
autostart_install() { return 0; }
wait_for_collector_process() { return 1; }
INIT_TYPE_FILE="$TEST_DIR/missing-init"
LOG_FILE="$TEST_DIR/collector.log"
${start}
cmd_start`],{encoding:'utf8',timeout:5000,env:{...process.env,TEST_DIR:dir}});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not remain alive');
  });
});
