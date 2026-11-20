#!/usr/bin/env bash
# Run in the disposable guest with its intended Pilot runtime on PATH.
set -euo pipefail
artifacts="${1:-/home/pilot/riscv64-evidence/environment}"
mkdir -p "$artifacts"
exec > >(tee "$artifacts/bootstrap.log") 2>&1
trap 'rc=$?; printf "bootstrap exit=%s time=%s\n" "$rc" "$(date --iso-8601=seconds)"' EXIT
printf 'bootstrap start=%s\n' "$(date --iso-8601=seconds)"
test "$(uname -m)" = riscv64
node -e 'if(process.arch!=="riscv64"||process.platform!=="linux")process.exit(1);require("node:sqlite");console.log(process.version,process.arch)'
timeout --signal=TERM --kill-after=10s 300s sudo apt-get update
timeout --signal=TERM --kill-after=10s 1200s sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  python3 curl ca-certificates git file
node - "$artifacts/environment.json" <<'JS'
const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
const command=(exe,args=[])=>cp.execFileSync(exe,args,{encoding:'utf8',timeout:15000}).trim();
const child=JSON.parse(command(process.execPath,['-e','console.log(JSON.stringify({arch:process.arch,version:process.version}))']));
assert.equal(child.arch,'riscv64');assert.equal(command('uname',['-m']),'riscv64');
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');
assert.equal(db.prepare('SELECT 42 AS answer').get().answer,42);db.close();
const evidence={recorded_at:new Date().toISOString(),platform:process.platform,arch:process.arch,
  node:process.version,versions:process.versions,child,builtin_sqlite_query:'passed',
  uname:command('uname',['-a']),os_release:fs.readFileSync('/etc/os-release','utf8'),
  shell:command('file',['/bin/bash']),init:command('ps',['-p','1','-o','comm=']),
  python:command('python3',['--version']),npm:command('npm',['--version']),
  packages:command('dpkg-query',['-W','libc6','python3','curl','git','file'])};
fs.writeFileSync(process.argv[2],JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
JS
