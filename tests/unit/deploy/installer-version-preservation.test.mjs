import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync('deploy/installer-opensource.sh', 'utf8');
const deploy = source.match(/deploy_package\(\) \{[\s\S]*?\n\}/)[0]
  .replaceAll('$HOME/.loongsuite-pilot', '$TEST_ROOT/cache');
const bootstrap = source.match(/deploy_bootstrap_scripts\(\) \{[\s\S]*?\n\}/)[0]
  .replaceAll('$HOME/.loongsuite-pilot', '$TEST_ROOT/cache');
let tmp;
const old = '1.2.0_original';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-version-preservation-'));
  fs.mkdirSync(path.join(tmp, 'cache/versions', old), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'source/scripts'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'cache/current'), old + '\n');
  fs.writeFileSync(path.join(tmp, 'cache/previous'), '1.1.0_previous\n');
  fs.writeFileSync(path.join(tmp, 'cache/versions', old, 'working-payload'), 'preserve me');
  fs.writeFileSync(path.join(tmp, 'source/VERSION'), 'version=1.2.0\ngit_commit=original\n');
  fs.writeFileSync(path.join(tmp, 'source/candidate'), 'new payload');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(fail, realBootstrap = false) {
  return spawnSync('bash', ['-c', `set -euo pipefail
NODE_BIN="$TEST_NODE"
DATA_DIR="$TEST_ROOT/data"
msg() { echo "$2"; }
${realBootstrap ? bootstrap : 'deploy_bootstrap_scripts() { touch "$TEST_ROOT/bootstrap-written"; }'}
ensure_node_modules() { [ "$TEST_FAIL" = 0 ]; }
run_npm() { return 23; }
${deploy}
if deploy_package "$TEST_ROOT/source"; then exit 0; else exit 17; fi
`], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TEST_ROOT: tmp, TEST_NODE: process.execPath, TEST_FAIL: fail ? '1' : '0' } });
}

describe.skipIf(process.platform === 'win32')('Unix versioned deployment preserves its rollback payload', () => {
  it('reinstalls the same version into a new directory before activating it', () => {
    const result = run(false);
    expect(result.status, result.stderr).toBe(0);
    const current = fs.readFileSync(path.join(tmp, 'cache/current'), 'utf8').trim();
    expect(current).not.toBe(old);
    expect(fs.readFileSync(path.join(tmp, 'cache/versions', current, 'candidate'), 'utf8')).toBe('new payload');
    expect(fs.readFileSync(path.join(tmp, 'cache/versions', old, 'working-payload'), 'utf8')).toBe('preserve me');
    expect(fs.readFileSync(path.join(tmp, 'cache/previous'), 'utf8').trim()).toBe(old);
  });

  it('keeps both pointers and the running payload when dependency installation fails', () => {
    const result = run(true);
    expect(result.status, result.stderr).toBe(17);
    expect(fs.readFileSync(path.join(tmp, 'cache/current'), 'utf8').trim()).toBe(old);
    expect(fs.readFileSync(path.join(tmp, 'cache/previous'), 'utf8').trim()).toBe('1.1.0_previous');
    expect(fs.readFileSync(path.join(tmp, 'cache/versions', old, 'working-payload'), 'utf8')).toBe('preserve me');
    expect(fs.existsSync(path.join(tmp, 'bootstrap-written'))).toBe(false);
  });

  it('does not activate a candidate when its required bootstrap script cannot be copied', () => {
    const result = run(false, true);
    expect(result.status, result.stderr).toBe(17);
    expect(result.stderr).toContain('collector-daemon.js');
    expect(fs.readFileSync(path.join(tmp, 'cache/current'), 'utf8').trim()).toBe(old);
    expect(fs.readFileSync(path.join(tmp, 'cache/previous'), 'utf8').trim()).toBe('1.1.0_previous');
  });

  it('restarts current after a failed upgrade deployment without swapping to previous', () => {
    const upgrade = source.match(/cmd_upgrade\(\) \{[\s\S]*?\n\}/)[0];
    const result = spawnSync('bash', ['-c', `set -euo pipefail
PACKAGE_NAME=loongsuite-pilot
PERMANENT_DIR="$TEST_ROOT/old"
TMP_DIR=""
msg() { echo "$2"; }
validate_install_user() { :; }
migrate_legacy_layout() { :; }
get_installed_version() { echo 1.2.0; }
get_version_from_dir() { echo 1.2.1; }
get_commit_from_dir() { echo candidate; }
check_deps() { :; }
download_and_extract() { INSTALL_SRC="$TEST_ROOT/source"; }
stop_pilot_for_deploy() { :; }
restore_pilot_after_deploy() { :; }
deploy_package() { return 23; }
run_pilot_cli() { printf '%s\\n' "$1" >> "$TEST_ROOT/cli-calls"; }
${upgrade}
cmd_upgrade
`], { encoding: 'utf8', timeout: 5000, env: { ...process.env, TEST_ROOT: tmp } });
    expect(result.status, result.stderr).toBe(1);
    expect(fs.readFileSync(path.join(tmp, 'cli-calls'), 'utf8').trim()).toBe('start');
  });
});
