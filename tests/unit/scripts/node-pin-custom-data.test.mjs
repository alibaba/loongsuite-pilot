import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync('scripts/loongsuite-pilot.sh', 'utf8');
const resolveNode = source.match(/resolve_node\(\) \{[\s\S]*?\n\}/)[0];
let tmp;
beforeEach(() => {
  tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-custom-node-pin-'));
  fs.mkdirSync(path.join(tmp,'data'));
  fs.writeFileSync(path.join(tmp,'data/node-bin'),path.join(tmp,'runtime with spaces/node')+'\n');
});
afterEach(()=>fs.rmSync(tmp,{recursive:true,force:true}));
function run(persist=true) {
  return spawnSync('bash',['-c',`set -euo pipefail
DATA_DIR="$TEST_ROOT/data"
NODE_PIN_FILE="$TEST_ROOT/cache/node-bin"
_node_is_suitable() { [ "$1" = "$TEST_ROOT/runtime with spaces/node" ] || [ "$1" = "$TEST_ROOT/canonical-node" ]; }
_resolve_realpath() { echo "$1"; }
${resolveNode}
resolve_node ${persist}`],{encoding:'utf8',timeout:5000,env:{...process.env,TEST_ROOT:tmp}});
}
describe.skipIf(process.platform==='win32')('Node pin with a custom data directory',()=>{
  it('recovers a missing cache pin from the install data pin without relying on PATH',()=>{
    const result=run();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(tmp,'runtime with spaces/node'));
    expect(fs.readFileSync(path.join(tmp,'cache/node-bin'),'utf8').trim()).toBe(path.join(tmp,'runtime with spaces/node'));
  });
  it('does not persist a pin during a read-only lookup',()=>{
    const result=run(false);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp,'cache/node-bin'))).toBe(false);
  });
  it('keeps a valid canonical pin ahead of the legacy data-directory fallback',()=>{
    fs.mkdirSync(path.join(tmp,'cache'));
    fs.writeFileSync(path.join(tmp,'cache/node-bin'),path.join(tmp,'canonical-node')+'\n');
    expect(run().stdout.trim()).toBe(path.join(tmp,'canonical-node'));
  });
});
