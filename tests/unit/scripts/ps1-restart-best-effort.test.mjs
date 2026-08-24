// A -RunLevel Limited scheduled task cannot rewrite its own definition, so the
// re-registration inside restart-collector / restart-updater must not gate the start.
//
// Task Scheduler gives a task's own principal only `Read, Synchronize`; every write ACE
// sits on BUILTIN\Administrators, which UAC filters out of the token of a Limited task.
// Both daemons run as Limited tasks, so when the updater deploys a new version and calls
// `restart-collector`, the re-register step it does "in case paths changed" is guaranteed
// to fail on any machine where the task already exists. Measured on a Medium-integrity
// Limited task: `schtasks /Delete`, `Register-ScheduledTask` and `Register-ScheduledTask
// -Force` all return "Access is denied" (so -Force is NOT the fix), while
// `Start-ScheduledTask` succeeds -- starting needs no write access.
//
// While both calls shared one try block, that guaranteed failure jumped over
// Start-ScheduledTask. With init_type=taskscheduler the self-heal branch is skipped too,
// so every single update ended in `Service manager failed to restart collector` + exit 1
// and left the collector down until the task's own 5-minute watchdog trigger happened to
// relaunch it. The re-registration is genuinely unnecessary: Install-*Task rewrites the
// launcher .vbs and reaps orphaned daemons *before* it reaches the registration, and the
// task action invokes that .vbs by a version-independent path.
//
// This pins the shape, not the wording: the Install-*Task call must be closed off by its
// own catch before Start-ScheduledTask is reached.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SERVICE_PS1 = 'scripts/loongsuite-pilot.ps1';
const text = readFileSync(SERVICE_PS1, 'utf-8');

// Drop comment lines so prose about try/catch cannot satisfy a structural check.
const codeOf = (s) => s.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

// Body = from the function header to the next top-level `function` declaration. Brace
// counting would trip over the format strings and script blocks in this file.
const bodyOf = (name) => {
  const start = text.indexOf(`function ${name} {`);
  expect(start, `${name} not found in ${SERVICE_PS1}`).toBeGreaterThan(-1);
  const rest = text.slice(start + `function ${name} {`.length);
  const end = rest.search(/\nfunction \S+ \{/);
  return codeOf(end === -1 ? rest : rest.slice(0, end));
};

// The "task already registered" branch, up to the `if (-not $restarted)` fallback.
const existingTaskBranch = (body) => {
  const start = body.search(/if \(Get-TaskExists /);
  expect(start, 'no Get-TaskExists branch').toBeGreaterThan(-1);
  const rest = body.slice(start);
  const end = rest.search(/if \(-not \$restarted\)/);
  return end === -1 ? rest : rest.slice(0, end);
};

const CASES = [
  { fn: 'Cmd-RestartCollector', install: 'Install-CollectorTask' },
  { fn: 'Cmd-RestartUpdater', install: 'Install-UpdaterTask' },
];

describe('restart-collector / restart-updater start the task even if re-registration is denied', () => {
  for (const { fn, install } of CASES) {
    it(`${fn}: ${install} cannot skip Start-ScheduledTask`, () => {
      const branch = existingTaskBranch(bodyOf(fn));

      // Count lower bounds first: an empty or mis-sliced branch must not pass vacuously.
      const installAt = branch.indexOf(install);
      const startAt = branch.indexOf('Start-ScheduledTask');
      expect(installAt, `${install} missing from the existing-task branch`).toBeGreaterThan(-1);
      expect(startAt, 'Start-ScheduledTask missing from the existing-task branch').toBeGreaterThan(-1);
      expect(installAt).toBeLessThan(startAt);

      // The re-register must be closed off by its own catch before the start is reached,
      // i.e. they live in two separate try blocks.
      const between = branch.slice(installAt, startAt);
      expect(
        /catch\s*\{[\s\S]*\btry\s*\{/.test(between),
        `${install} and Start-ScheduledTask still share one try block in ${fn}; a denied `
          + 're-registration would skip the start',
      ).toBe(true);
    });
  }

  it('Register-PilotTask reports a task that survives the pre-registration delete', () => {
    // The delete is suppressed on purpose (nothing to delete on a fresh install, and a
    // bare native stderr line can turn terminating under $ErrorActionPreference=Stop),
    // so a surviving task is the only signal that write access is missing. Without it
    // the sole symptom is the registration error, which reads like a principal bug.
    const body = bodyOf('Register-PilotTask');
    const deleteAt = body.indexOf('schtasks.exe /Delete');
    const registerAt = body.indexOf('Register-ScheduledTask');
    expect(deleteAt).toBeGreaterThan(-1);
    expect(registerAt).toBeGreaterThan(deleteAt);
    expect(
      /Get-TaskExists/.test(body.slice(deleteAt, registerAt)),
      'Register-PilotTask must check whether the task survived the delete before re-registering',
    ).toBe(true);
  });
});
