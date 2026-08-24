// Uninstall must not be abortable by something that has nothing to do with uninstalling.
//
// A measured Windows box left `%USERPROFILE%\.loongsuite-pilot\config.json` -- SLS
// AccessKeySecret and CMS license key inside it -- on disk after `-Uninstall -Purge`
// reported nothing wrong to look at. The chain:
//
//   1. Resolve-Node probes third-party version managers, and NVM_HOME is commonly a
//      *machine*-level variable pointing into another account's profile. A bare
//      Test-Path on an unreadable directory emits a PermissionDenied
//      UnauthorizedAccessException record, which $ErrorActionPreference = "Stop" -- set
//      in the header of every one of these scripts -- promotes to terminating.
//   2. Cmd-Uninstall called Resolve-Node bare, before any cleanup step. One terminating
//      error there skipped the plugin cleanups, the install-directory removal, and the
//      `if ($Purge)` branch that deletes the data dir. Nothing downstream repairs that:
//      the next `-Purge` takes the same path and dies at the same line.
//   3. The one failure mode that *is* expected -- scheduled tasks owned by
//      BUILTIN\Administrators after an elevated install -- was reported as a bare
//      "ERROR: Access is denied." line, because the diagnostic `throw` behind it was
//      unreachable (see the EAP assertions below), and its text taught the workaround as
//      if elevation were a requirement of uninstall rather than a consequence of how the
//      install ran.
//
// So this file pins three separable things: the probes stay non-fatal, uninstall keeps
// going when Node cannot be resolved at all, and the native-command diagnostic actually
// reaches the user. It sweeps whatever .ps1 the repo tracks rather than a fixed list, so
// the same file is meaningful in the open-source mirror (one installer) and downstream
// (three plus the service wrapper) without editing. The prose form of the native-stderr
// rule is pinned separately, by whichever repo's AGENTS.md carries that section.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const PS1 = [
  'deploy/installer.ps1',
  'deploy/installer-inner.ps1',
  'deploy/installer-opensource.ps1',
  'scripts/loongsuite-pilot.ps1',
].filter(existsSync);

const read = (f) => readFileSync(f, 'utf-8');

// Top-level functions in these scripts close with `}` in column 0.
const funcOf = (text, name) => {
  const start = text.indexOf(`function ${name} {`);
  if (start < 0) return null;
  const end = text.indexOf('\n}\n', start);
  return end < 0 ? text.slice(start) : text.slice(start, end + 3);
};

const codeOf = (text) => text
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .join('\n');

const blockOf = (text, tag) => {
  const re = new RegExp(`^\\s*# >>> ${tag} >>>\\n[\\s\\S]*?^\\s*# <<< ${tag} <<<\\n`, 'm');
  const m = text.match(re);
  return m ? m[0] : null;
};

describe('Resolve-Node cannot take the caller down with it', () => {
  it('finds the scripts to check', () => {
    // Guards against a silently empty sweep (wrong cwd, renamed files).
    expect(PS1.length).toBeGreaterThanOrEqual(2);
    expect(PS1).toContain('scripts/loongsuite-pilot.ps1');
  });

  for (const file of PS1) {
    it(`${file}: the version-manager probes in Resolve-Node are non-fatal`, () => {
      // Scoped to the third-party roots on purpose. These are the only paths here that
      // belong to somebody else: NVM_HOME is routinely a machine-level variable pointing
      // into another account's profile, and reading such a directory is a
      // PermissionDenied record, not a "not found". The pin file and its parent live
      // under the caller's own data dir, where failing fast is still the right answer.
      const body = funcOf(read(file), 'Resolve-Node');
      expect(body, `${file}: Resolve-Node not found`).toBeTruthy();
      const probes = codeOf(body)
        .split('\n')
        .filter(l => l.includes('Test-Path'))
        .filter(l => /NVM_HOME|\$nvmHome|\$fnmDir/.test(l))
        .map(l => l.trim());
      // Both roots are still probed -- a rename must not empty this check.
      expect(probes.length, `${file}: version-manager probes not found`).toBe(2);
      const unguarded = probes.filter(l => !l.includes('-ErrorAction SilentlyContinue'));
      expect(unguarded, `${file}: version-manager probe at "Stop"`).toEqual([]);
    });
  }
});

const INSTALLERS = PS1.filter(f => f.startsWith('deploy/installer'));

describe('uninstall continues when Node cannot be resolved', () => {
  for (const file of INSTALLERS) {
    it(`${file}: Cmd-Uninstall guards its Resolve-Node call`, () => {
      const body = funcOf(read(file), 'Cmd-Uninstall');
      expect(body, `${file}: Cmd-Uninstall not found`).toBeTruthy();
      const code = codeOf(body);
      // The assignment must sit inside a try. Matching the shape rather than just
      // "contains try" -- Cmd-Uninstall is full of unrelated try blocks.
      expect(code, file).toMatch(/try\s*\{\s*\n\s*\$script:NODE_BIN = Resolve-Node\s*\n\s*\}\s*catch\s*\{/);
      // And the failure has to be visible: silently continuing with no Node would
      // report a clean uninstall that skipped every JSON config on the machine.
      expect(code, file).toMatch(/\$script:NODE_BIN = ""/);
    });

    it(`${file}: every Node-dependent cleanup skips explicitly without a Node`, () => {
      // Consequence of the guard above: uninstall now reaches these with an empty
      // $NODE_BIN. Remove-HookConfigs was the one that did not check, so it would have
      // run `& ""` and then printed its success line for a file it never touched.
      for (const fn of ['Remove-HookConfigs', 'Remove-OpenClawPlugin']) {
        const body = funcOf(read(file), fn);
        if (!body) continue;
        expect(codeOf(body), `${file}: ${fn}`).toMatch(/if \(-not \$script:NODE_BIN\)/);
      }
    });
  }
});

describe('the scheduled-task failure reaches the user', () => {
  for (const file of INSTALLERS) {
    it(`${file}: the schtasks call runs at "Continue" and restores in finally`, () => {
      // On Windows PowerShell 5.1 a native command that writes stderr while a 2>
      // redirection is in effect raises a NativeCommandError, and EAP=Stop promotes it
      // to a terminating error whose Message is just the raw stderr line. schtasks.exe
      // prints "ERROR: Access is denied." there on exactly the failure this branch
      // exists to report, so the throw below it never ran.
      const body = funcOf(read(file), 'Remove-OnePilotScheduledTask');
      expect(body, `${file}: Remove-OnePilotScheduledTask not found`).toBeTruthy();
      const code = codeOf(body);
      expect(code, file).toContain('$ErrorActionPreference = "Continue"');
      expect(code, file).toMatch(/\}\s*finally\s*\{\s*\n\s*\$ErrorActionPreference = \$prevEAP/);
      // Exit code from the call, not from whatever ran before it.
      expect(code, file).toContain('$schtasksExit = $LASTEXITCODE');
      // Pre-seeded to non-zero: a schtasks.exe that cannot launch at all must not
      // inherit a stale $LASTEXITCODE of 0 and be read as success.
      expect(code, file).toContain('$schtasksExit = 1');
      expect(code, file).not.toContain('catch {}');
    });

    it(`${file}: the message names the cause, not just the workaround`, () => {
      // It used to say only "Run uninstall from an elevated PowerShell.", which reads as
      // "uninstall needs admin". It does not. The tasks are owned by Administrators
      // because the *install* ran elevated, and the durable fix is to install without
      // elevation -- so both halves have to be in the text.
      const code = codeOf(funcOf(read(file), 'Remove-OnePilotScheduledTask'));
      expect(code, file).toContain('BUILTIN\\Administrators');
      expect(code, file).toContain('does not need administrator');
      expect(code, file).toContain('reinstall without elevation');
      // The stderr that explains which of the two failures happened must be quoted.
      expect(code, file).toContain('$schtasksDetail');
      // And quoted as the stderr line, not as a rendered ErrorRecord. At "Continue" the
      // NativeCommandError still goes to the error stream, so 2>&1 merges the record
      // object; `$schtasksOut | Out-String` therefore expanded one stderr line into a
      // six-line PowerShell error block -- source line, squiggles, CategoryInfo -- inside
      // the sentence. Measured on a 5.1 box, where schtasks.exe produced two records for
      // one line, the second empty.
      expect(code, file).not.toContain('$schtasksOut | Out-String');
      expect(code, file).toContain('$schtasksLine.Exception.Message');
    });
  }
});

describe('an elevated install says what it costs', () => {
  // Cheap half of the fix. Rewriting the task security descriptor after registration so
  // the user can delete their own tasks again is the real repair and is not attempted
  // here; until then the install has to tell the user what it just did to them.
  for (const file of INSTALLERS) {
    it(`${file}: warns before doing any work`, () => {
      const src = read(file);
      const block = blockOf(src, 'pilot-elevation-warning');
      expect(block, `${file}: pilot-elevation-warning block missing`).toBeTruthy();
      const code = codeOf(block);
      expect(code, file).toMatch(/function Test-PilotElevated/);
      // Best-effort by construction: the cast and GetCurrent() are both CLM-forbidden,
      // so on a WDAC box this throws and the catch has to swallow it. Losing a hint is
      // acceptable; failing an install over a hint is not.
      expect(code, file).toMatch(/catch\s*\{\s*\n\s*return \$false/);
      // Called from Cmd-Install before Check-Deps / Download-AndExtract, so Ctrl+C is
      // still free at that point.
      const install = codeOf(funcOf(src, 'Cmd-Install'));
      expect(install, file).toContain('Warn-ElevatedInstall');
      expect(
        install.indexOf('Warn-ElevatedInstall'),
        `${file}: warning must precede Check-Deps`,
      ).toBeLessThan(install.indexOf('Check-Deps'));
    });
  }

  it('the block is byte-identical across the installers', () => {
    // Three hand-maintained near-copies; a block that drifts in one of them is a
    // variant nobody is testing.
    const blocks = INSTALLERS.map(f => blockOf(read(f), 'pilot-elevation-warning'));
    expect(blocks.filter(b => !b)).toEqual([]);
    expect(new Set(blocks).size).toBe(1);
  });
});
