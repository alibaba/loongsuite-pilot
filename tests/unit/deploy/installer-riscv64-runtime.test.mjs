import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync('deploy/installer-opensource.sh', 'utf8');
const checkDeps = source.match(/check_deps\(\) \{[\s\S]*?\n\}/)[0];
const detectLang = source.match(/detect_lang\(\) \{[\s\S]*?\n\}/)[0];
let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-riscv-runtime-'));
  fs.mkdirSync(path.join(tmp, 'data'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'data/node-bin'), 'previous-working-node\n');
  fs.writeFileSync(path.join(tmp, 'bin/node'), '#!/bin/sh\ncase "$1" in\n-e) echo 22;;\n-p) echo "$TEST_NODE_ARCH";;\n--version) echo v22.22.2;;\nesac\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'bin/npm'), '#!/bin/sh\necho 10.9.7\n', { mode: 0o755 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(body, arch = 'riscv64') {
  return spawnSync('bash', ['-c', `set -euo pipefail
uname() { case "\${1:-}" in -m) echo riscv64;; *) echo Linux;; esac; }
msg() { echo "$2"; }
resolve_node() { echo "$TEST_ROOT/bin/node"; }
run_npm() { "$TEST_ROOT/bin/npm" "$@"; }
DATA_DIR="$TEST_ROOT/data"
PREFER_SYSTEM_NODE=1
${body}`], { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, TEST_ROOT: tmp, TEST_NODE_ARCH: arch, LOONGSUITE_PILOT_LANG: '',
      LANG: 'C', LANGUAGE: '', LC_ALL: '', LC_MESSAGES: '' } });
}

describe.skipIf(process.platform === 'win32')('RISC-V installer runtime validation', () => {
  it('can detect language before Node resolution on RISC-V', () => {
    const result = run(`${detectLang}\nunset NODE_BIN\ndetect_lang`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('en');
  });
  it('rejects a mismatched Node before changing the old runtime pin', () => {
    const result = run(`${checkDeps}\ncheck_deps`, 'x64');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('requires riscv64 Node.js');
    expect(fs.readFileSync(path.join(tmp, 'data/node-bin'), 'utf8')).toBe('previous-working-node\n');
  });
  it('pins the matching runtime after validation', () => {
    const result = run(`${checkDeps}\ncheck_deps`);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'data/node-bin'), 'utf8').trim()).toBe(path.join(tmp, 'bin/node'));
  });
});
