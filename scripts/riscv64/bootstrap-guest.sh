#!/usr/bin/env bash
# Run inside the isolated guest, with the chosen Node runtime already on PATH.
set -euo pipefail
artifacts="${1:-/home/pilot/riscv64-evidence/environment}"
mkdir -p "$artifacts"
exec > >(tee "$artifacts/bootstrap.log") 2>&1
trap 'rc=$?; printf "bootstrap exit=%s time=%s\n" "$rc" "$(date --iso-8601=seconds)"' EXIT
printf 'bootstrap start=%s\n' "$(date --iso-8601=seconds)"
test "$(uname -m)" = riscv64
node -e 'if(process.arch!=="riscv64" || process.platform!=="linux") process.exit(1); console.log(process.version,process.arch)'

timeout --signal=TERM --kill-after=10s 300s sudo apt-get update
timeout --signal=TERM --kill-after=10s 1200s sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential python3 pkg-config curl ca-certificates git file

export PILOT_NODE_ROOT
PILOT_NODE_ROOT="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
test -f "$PILOT_NODE_ROOT/include/node/node_api.h"
probe_dir="$artifacts/minimal-addon"
mkdir -p "$probe_dir"
cat > "$probe_dir/package.json" <<'JSON'
{
  "name": "pilot-riscv64-toolchain-probe", "version": "1.0.0", "private": true,
  "scripts": {"install": "cc -shared -fPIC -I\"$PILOT_NODE_ROOT/include/node\" addon.c -o probe.node"}
}
JSON
cat > "$probe_dir/addon.c" <<'C'
#include <node_api.h>
static napi_value init(napi_env env, napi_value exports) {
  napi_value answer;
  if (napi_create_int32(env, 42, &answer) != napi_ok ||
      napi_set_named_property(env, exports, "answer", answer) != napi_ok) {
    napi_throw_error(env, NULL, "N-API toolchain probe failed");
    return NULL;
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
C
timeout --signal=TERM --kill-after=10s 180s npm --prefix "$probe_dir" install --offline --no-audit --no-fund
file "$probe_dir/probe.node" | tee "$artifacts/minimal-addon-elf.txt"
node - "$probe_dir/probe.node" "$artifacts/environment.json" <<'JS'
const fs = require('node:fs');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const command = (exe, args=[]) => cp.execFileSync(exe,args,{encoding:'utf8',timeout:15000}).trim();
const child = JSON.parse(command(process.execPath,['-e','console.log(JSON.stringify({arch:process.arch,version:process.version}))']));
assert.equal(child.arch,'riscv64');
assert.equal(command('uname',['-m']),'riscv64');
const addon = require(process.argv[2]);
assert.equal(addon.answer,42);
const elf = command('file',[process.argv[2]]);
assert.match(elf,/RISC-V/);
const evidence = {
  recorded_at:new Date().toISOString(), platform:process.platform, arch:process.arch,
  node:process.version, versions:process.versions, child,
  uname:command('uname',['-a']), os_release:fs.readFileSync('/etc/os-release','utf8'),
  shell:command('file',['/bin/bash']), init:command('ps',['-p','1','-o','comm=']),
  compiler:command('cc',['--version']), compiler_target:command('cc',['-dumpmachine']),
  python:command('python3',['--version']), npm:command('npm',['--version']),
  packages:command('dpkg-query',['-W','build-essential','gcc','g++','make','libc6','python3','pkg-config']),
  minimal_npm_addon:{elf,answer:addon.answer,status:'passed'}
};
assert.match(evidence.compiler_target,/riscv64/);
fs.writeFileSync(process.argv[3],JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
JS
