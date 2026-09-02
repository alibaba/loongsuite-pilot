// Stop-PilotService only ends the current task instance. The updater task's 5-minute
// repeating trigger (and RestartCount) relaunches it while Deploy-Package is still
// filling in a versions/ directory that neither `current` nor `previous` names, and
// gcOldVersions deletes that directory. Disable-ScheduledTask is a write to the task
// definition, so it actually holds the watchdog for the rest of the deploy.
//
// Only the .ps1 installers are pinned here: the relaunch is a Task Scheduler artefact,
// and the .sh installers unload launchd / disable systemd in `loongsuite-pilot stop`.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const INTERNAL_PS1 = [
  'deploy/installer.ps1',
  'deploy/installer-inner.ps1',
];
const OPENSOURCE_PS1 = 'deploy/installer-opensource.ps1';
const PS1_INSTALLERS = [...INTERNAL_PS1, OPENSOURCE_PS1];

const TAG = 'pilot-hold-tasks-during-deploy';

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

const functionBody = (text, name) => {
  const start = text.indexOf(`function ${name} {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = text.slice(start);
  const end = rest.search(/\nfunction \S+ \{/);
  return rest.slice(0, end === -1 ? rest.length : end);
};

const present = PS1_INSTALLERS.filter(existsSync);
const patched = present.filter(f => blockOf(read(f), TAG));

describe('installers disable scheduled tasks for the duration of a deploy', () => {
  it('defines the hold/restore helpers', () => {
    expect(patched.length).toBeGreaterThanOrEqual(1);
    for (const file of INTERNAL_PS1.filter(existsSync)) {
      expect(blockOf(read(file), TAG), `${file}: ${TAG} block missing`).toBeTruthy();
    }
    for (const file of patched) {
      const code = codeOf(blockOf(read(file), TAG));
      expect(code, file).toMatch(/function Disable-PilotScheduledTasksDuringDeploy/);
      expect(code, file).toMatch(/function Enable-PilotScheduledTasksAfterDeploy/);
      expect(code, file).toMatch(/Disable-ScheduledTask/);
      expect(code, file).toMatch(/Enable-ScheduledTask/);
    }
  });

  it('the block is byte-identical across the patched .ps1 installers', () => {
    const blocks = patched.map(f => blockOf(read(f), TAG));
    expect(blocks.filter(b => !b)).toEqual([]);
    expect(new Set(blocks).size).toBe(1);
  });

  it('disables both the collector and the updater task', () => {
    const code = codeOf(blockOf(read(patched[0]), TAG));
    expect(code).toMatch(/LoongsuitePilot-\$tag/);
    expect(code).toMatch(/LoongsuitePilotUpdater-\$tag/);
  });

  it('does not abort the install when Disable is denied', () => {
    // Elevated first installs leave the tasks owned by Administrators; the same
    // Access is denied that blocks schtasks /Delete would also block Disable.
    // Swallowing that is required -- a denied hold must not turn a working reinstall
    // into a failed one. Restart-StaleCollector still covers that machine.
    const code = codeOf(blockOf(read(patched[0]), TAG));
    expect(code).toMatch(/Disable-ScheduledTask[\s\S]*catch/);
    expect(code).not.toMatch(/Disable-ScheduledTask[\s\S]*exit 1/);
  });

  it('re-enables only the tasks this deploy actually disabled', () => {
    // Enabling a task we never held would turn on something the user had disabled,
    // or a task whose Disable failed (and is therefore still enabled).
    const code = codeOf(blockOf(read(patched[0]), TAG));
    expect(code).toMatch(/PILOT_HELD_TASK_NAMES/);
    expect(code).toMatch(/Enable-PilotScheduledTasksAfterDeploy[\s\S]*PILOT_HELD_TASK_NAMES = @\(\)/);
  });

  it('Cmd-Install stops, then disables, then deploys', () => {
    for (const file of patched) {
      const body = functionBody(read(file), 'Cmd-Install');
      const stopAt = body.indexOf('Stop-PilotService');
      const disableAt = body.indexOf('Disable-PilotScheduledTasksDuringDeploy');
      const deployAt = body.indexOf('Deploy-Package');
      expect(stopAt, `${file}: Stop-PilotService missing from Cmd-Install`).toBeGreaterThan(-1);
      expect(disableAt, `${file}: Disable missing from Cmd-Install`).toBeGreaterThan(-1);
      expect(deployAt, `${file}: Deploy-Package missing from Cmd-Install`).toBeGreaterThan(-1);
      expect(stopAt).toBeLessThan(disableAt);
      expect(disableAt).toBeLessThan(deployAt);
    }
  });

  it('Cmd-Upgrade stops, then disables, then deploys', () => {
    for (const file of patched) {
      const body = functionBody(read(file), 'Cmd-Upgrade');
      const stopAt = body.indexOf('Stop-PilotService');
      const disableAt = body.indexOf('Disable-PilotScheduledTasksDuringDeploy');
      const deployAt = body.indexOf('Deploy-Package');
      expect(stopAt, `${file}: Stop-PilotService missing from Cmd-Upgrade`).toBeGreaterThan(-1);
      expect(disableAt, `${file}: Disable missing from Cmd-Upgrade`).toBeGreaterThan(-1);
      expect(deployAt, `${file}: Deploy-Package missing from Cmd-Upgrade`).toBeGreaterThan(-1);
      expect(stopAt).toBeLessThan(disableAt);
      expect(disableAt).toBeLessThan(deployAt);
    }
  });

  it('enables before start, and again in finally', () => {
    // Enable must precede Start-ScheduledTask: a disabled task will not start.
    // finally must also Enable so Ctrl+C / exit 1 cannot leave the tasks disabled.
    // Start itself stays on the success path -- a failed postinstall must not launch
    // a collector whose hooks were never written.
    for (const file of patched) {
      for (const fn of ['Cmd-Install', 'Cmd-Upgrade']) {
        const body = functionBody(read(file), fn);
        const enables = [];
        let from = 0;
        while (true) {
          const at = body.indexOf('Enable-PilotScheduledTasksAfterDeploy', from);
          if (at === -1) break;
          enables.push(at);
          from = at + 1;
        }
        expect(enables.length, `${file} ${fn}: expected Enable twice (before start + finally)`).toBeGreaterThanOrEqual(2);
        expect(body).toMatch(/finally[\s\S]*Enable-PilotScheduledTasksAfterDeploy/);
        const startAt = body.search(/启动服务|启动新版本/);
        expect(startAt, `${file} ${fn}: start prompt missing`).toBeGreaterThan(-1);
        expect(enables[0]).toBeLessThan(startAt);
      }
    }
  });

  it('does not hold tasks during uninstall', () => {
    // Uninstall deletes the tasks. Re-enabling them in a finally would fight
    // Remove-PilotScheduledTasks.
    for (const file of patched) {
      const body = functionBody(read(file), 'Cmd-Uninstall');
      expect(body, file).not.toMatch(/Disable-PilotScheduledTasksDuringDeploy/);
      expect(body, file).not.toMatch(/Enable-PilotScheduledTasksAfterDeploy/);
    }
  });
});
