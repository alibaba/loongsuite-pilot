// Overlay `install` used to SIGTERM only the collector pid file. The updater
// stayed up, and gcOldVersions() deletes any versions/<dir> that is not
// current/previous -- including the directory this deploy just copied, before
// current is published. installer-opensource.sh writes current after
// node_modules + postinstall, so that window is minutes (same class of bug as
// Windows Stop-ScheduledTask without Disable).
//
// Unix stop already unloads LaunchAgent / disables systemd (autostart_remove).
// Overlay install has to call that, the same way `cmd_upgrade` always did; a
// collector-only pid kill does not close the GC race.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const INTERNAL_SH = [
  'deploy/installer.sh',
  'deploy/installer-inner.sh',
];
const OPENSOURCE_SH = 'deploy/installer-opensource.sh';
const SH_INSTALLERS = [...INTERNAL_SH, OPENSOURCE_SH];

const read = (f) => readFileSync(f, 'utf-8');

const blockOf = (text, tag) => {
  const re = new RegExp(`^\\s*# >>> ${tag} >>>\\n[\\s\\S]*?^\\s*# <<< ${tag} <<<\\n`, 'm');
  const m = text.match(re);
  return m ? m[0] : null;
};

const codeOf = (text) => text
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .join('\n');

const fnOf = (text, name) => {
  const start = text.indexOf(`${name}() {`);
  if (start < 0) return '';
  const end = text.indexOf('\n# ============================================================', start + 1);
  return end > start ? text.slice(start, end) : text.slice(start);
};

const present = SH_INSTALLERS.filter(existsSync);
const patched = present.filter(f => blockOf(read(f), 'pilot-stop-for-deploy'));

describe('sh overlay install stops updater, not just the collector pid', () => {
  it('defines stop_pilot_for_deploy', () => {
    expect(patched.length).toBeGreaterThanOrEqual(1);
    for (const file of INTERNAL_SH.filter(existsSync)) {
      expect(blockOf(read(file), 'pilot-stop-for-deploy'), `${file}: pilot-stop-for-deploy block missing`).toBeTruthy();
    }
    for (const file of patched) {
      expect(codeOf(blockOf(read(file), 'pilot-stop-for-deploy')), file).toMatch(/stop_pilot_for_deploy\(\) \{/);
    }
  });

  it('the block is byte-identical across the patched .sh installers', () => {
    const blocks = patched.map(f => blockOf(read(f), 'pilot-stop-for-deploy'));
    expect(blocks.filter(b => !b)).toEqual([]);
    expect(new Set(blocks).size).toBe(1);
  });

  it('calls loongsuite-pilot stop, not a collector-only kill', () => {
    const code = codeOf(blockOf(read(patched[0]), 'pilot-stop-for-deploy'));
    expect(code).toMatch(/run_pilot_cli stop/);
    expect(code).toMatch(/loongsuite-pilot-updater\.pid/);
    // The CLI is how autostart_remove happens. Pid fallback is for a missing CLI,
    // not the overlay path.
    expect(code).toMatch(/command -v loongsuite-pilot/);
  });

  it('passes the installer data dir into every CLI verb after stop', () => {
    // Without this, --data-dir overlay would stop the custom instance and then
    // start/status/rollback the default ~/.loongsuite-pilot one.
    const code = codeOf(blockOf(read(patched[0]), 'pilot-stop-for-deploy'));
    expect(code).toMatch(/run_pilot_cli\(\)/);
    expect(code).toMatch(/LOONGSUITE_PILOT_DATA_DIR="\$DATA_DIR"/);
    // deploy_package writes versions/current under $HOME/.loongsuite-pilot.
    // Pointing the CLI cache at DATA_DIR would start/rollback a different tree.
    expect(code).not.toMatch(/LOONGSUITE_PILOT_CACHE_DIR=/);
  });

  it('sets PILOT_HELD_FOR_DEPLOY before stop, so a killed stop still restores', () => {
    const code = codeOf(blockOf(read(patched[0]), 'pilot-stop-for-deploy'));
    const stopFn = code.slice(
      code.indexOf('stop_pilot_for_deploy() {'),
      code.indexOf('restore_pilot_after_deploy() {'),
    );
    const heldAt = stopFn.lastIndexOf('PILOT_HELD_FOR_DEPLOY=1');
    const cliStopAt = stopFn.indexOf('run_pilot_cli stop');
    expect(heldAt).toBeGreaterThan(-1);
    expect(cliStopAt).toBeGreaterThan(-1);
    expect(heldAt).toBeLessThan(cliStopAt);
  });

  it('restores autostart after a failed overlay, except in container mode', () => {
    // stop deletes LaunchAgent/systemd unit files. Windows Enable-in-finally is
    // reversible; Unix restore is `start`, which re-registers autostart. A
    // docker build layer must not launch a daemon.
    const code = codeOf(blockOf(read(patched[0]), 'pilot-stop-for-deploy'));
    expect(code).toMatch(/restore_pilot_after_deploy\(\)/);
    expect(code).toMatch(/INSTALL_MODE:-host/);
    expect(code).toMatch(/run_pilot_cli start/);
    // Swallowing start hides the only signal that autostart did not come back.
    expect(code).not.toMatch(/run_pilot_cli start\s+>\/dev\/null/);
    expect(code).toMatch(/Could not restore autostart/);
  });

  it('cmd_install and cmd_upgrade both call it before deploy_package', () => {
    for (const file of patched) {
      const text = read(file);
      expect(text.match(/stop_pilot_for_deploy/g)?.length, `${file}: expected helper + two call sites`)
        .toBeGreaterThanOrEqual(3);

      const install = fnOf(text, 'cmd_install');
      const upgrade = fnOf(text, 'cmd_upgrade');
      expect(install, `${file}: cmd_install missing`).toContain('stop_pilot_for_deploy');
      expect(upgrade, `${file}: cmd_upgrade missing`).toContain('stop_pilot_for_deploy');

      const stopAt = install.indexOf('stop_pilot_for_deploy');
      const deployAt = install.indexOf('deploy_package');
      expect(stopAt, `${file}: cmd_install never calls stop_pilot_for_deploy`).toBeGreaterThan(-1);
      expect(deployAt, `${file}: cmd_install never calls deploy_package`).toBeGreaterThan(-1);
      expect(stopAt, `${file}: cmd_install stops after deploy_package`).toBeLessThan(deployAt);

      const upStopAt = upgrade.indexOf('stop_pilot_for_deploy');
      const upDeployAt = upgrade.indexOf('deploy_package');
      expect(upStopAt, file).toBeGreaterThan(-1);
      expect(upDeployAt, file).toBeGreaterThan(-1);
      expect(upStopAt, `${file}: cmd_upgrade stops after deploy_package`).toBeLessThan(upDeployAt);

      // The old overlay path printed this and killed only the collector pid.
      expect(install, `${file}: cmd_install still uses the collector-only pid kill`)
        .not.toMatch(/Stopping running service \(PID/);

      expect(install, `${file}: cmd_install EXIT trap does not restore autostart`)
        .toMatch(/restore_pilot_after_deploy/);
      expect(upgrade, `${file}: cmd_upgrade EXIT trap does not restore autostart`)
        .toMatch(/restore_pilot_after_deploy/);

      // start/status/rollback after stop must go through run_pilot_cli so --data-dir matches.
      expect(install, `${file}: cmd_install start is not DATA_DIR-aware`)
        .toMatch(/run_pilot_cli start/);
      expect(upgrade, `${file}: cmd_upgrade start is not DATA_DIR-aware`)
        .toMatch(/run_pilot_cli start/);
      expect(upgrade, `${file}: cmd_upgrade rollback is not DATA_DIR-aware`)
        .toMatch(/run_pilot_cli rollback/);

      const trapAt = (fn) => fn.indexOf("trap 'restore_pilot_after_deploy");
      const stopCall = (fn) => fn.search(/^\s*stop_pilot_for_deploy$/m);
      expect(trapAt(install), `${file}: cmd_install restore trap missing`).toBeGreaterThan(-1);
      expect(stopCall(install), `${file}: cmd_install stop call missing`).toBeGreaterThan(-1);
      expect(trapAt(install), `${file}: cmd_install trap must be armed before stop`)
        .toBeLessThan(stopCall(install));
      expect(trapAt(upgrade), `${file}: cmd_upgrade restore trap missing`).toBeGreaterThan(-1);
      expect(stopCall(upgrade), `${file}: cmd_upgrade stop call missing`).toBeGreaterThan(-1);
      expect(trapAt(upgrade), `${file}: cmd_upgrade trap must be armed before stop`)
        .toBeLessThan(stopCall(upgrade));

      const failAt = upgrade.indexOf('New version failed to start');
      expect(failAt, `${file}: cmd_upgrade start-failure path missing`).toBeGreaterThan(-1);
      expect(upgrade.slice(failAt), `${file}: start-failure path never starts after rollback`)
        .toMatch(/run_pilot_cli start/);
    }
  });

  it('AGENTS.md still names the helper when this repo documents the rule', () => {
    const agents = read('AGENTS.md');
    if (!agents.includes('pilot-stop-for-deploy')) return;
    expect(agents).toContain('tests/unit/deploy/installer-stop-for-deploy.test.mjs');
  });
});
