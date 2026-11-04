import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source=fs.readFileSync('scripts/loongsuite-pilot.sh','utf8');
const wait=source.match(/wait_for_collector_process\(\) \{[\s\S]*?\n\}/)[0];
let tmp;
beforeEach(()=>{tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-start-stability-'));});
afterEach(()=>fs.rmSync(tmp,{recursive:true,force:true}));
function run(lifetime) {
  return spawnSync('bash',['-c',`set -uo pipefail
PID_FILE="$TEST_ROOT/collector.pid"
sleep "$TEST_LIFETIME" &
probe_child=$!
trap 'kill "$probe_child" 2>/dev/null || true' EXIT
printf '%s' "$probe_child" > "$PID_FILE"
process_matches_installed_entry() { [ "$1" = "$probe_child" ] && kill -0 "$1" 2>/dev/null; }
find_installed_collector_pid() { cat "$PID_FILE"; }
${wait}
wait_for_collector_process 5`],{encoding:'utf8',timeout:9000,env:{...process.env,TEST_ROOT:tmp,TEST_LIFETIME:String(lifetime)}});
}
describe.skipIf(process.platform==='win32')('collector startup process stability',()=>{
  it('rejects a real short-lived launcher instead of confirming its first PID sighting',()=>{
    const result=run(0.2);
    expect(result.status).toBe(1);
    expect(fs.readFileSync(path.join(tmp,'collector.pid'),'utf8')).toMatch(/^\d+$/);
  },10000);
  it('accepts the same live process after bounded observations and leaves its PID file intact',()=>{
    const result=run(20);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(tmp,'collector.pid'),'utf8')).toMatch(/^\d+$/);
  },10000);
});
