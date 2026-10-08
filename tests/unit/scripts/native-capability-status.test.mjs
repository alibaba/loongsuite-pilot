import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source=fs.readFileSync('scripts/loongsuite-pilot.sh','utf8');
const fn=source.slice(source.indexOf('print_native_capabilities() {'),source.indexOf('\ncmd_status() {'));
let dir;
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-native-status-'));});
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}));
const run=()=>spawnSync('bash',['-c',`set -euo pipefail
DATA_DIR="$TEST_DATA"
resolve_node() { test "$1" = false; echo "$TEST_NODE"; }
${fn}
print_native_capabilities`],{encoding:'utf8',timeout:5000,
  env:{...process.env,TEST_DATA:dir,TEST_NODE:process.execPath}});

describe.skipIf(process.platform==='win32')('native startup diagnostics in status/info',()=>{
  it('shows the degraded capability and recovery without importing native modules',()=>{
    fs.writeFileSync(path.join(dir,'native-capabilities.json'),JSON.stringify({schema:1,
      checked_at:'2026-09-09T00:00:00Z',sqlite3:{available:false,reason:'SIGSEGV\nprobe failed'},
      recovery:'Rebuild sqlite3 and restart Pilot.'}));
    const result=run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('sqlite3=unavailable');
    expect(result.stdout).toContain('sqlite3_reason=SIGSEGV probe failed');
    expect(result.stdout).toContain('native_recovery=Rebuild sqlite3 and restart Pilot.');
    expect(result.stdout).toContain('native_last_startup=2026-09-09T00:00:00Z');
  });
  it('keeps missing or malformed diagnostics from failing status',()=>{
    expect(run().stdout).toBe('');
    fs.writeFileSync(path.join(dir,'native-capabilities.json'),'{broken');
    const result=run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('native_capabilities_status=unreadable');
  });
});
