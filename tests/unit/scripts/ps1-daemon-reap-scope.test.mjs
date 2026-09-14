// Killing "node processes whose command line mentions collector-daemon" is not the same
// thing as killing *our* daemons.
//
// The daemon file names are identical for every installation on the machine, and on a
// shared Windows box each account runs its own pair out of its own %USERPROFILE%. The
// reap in Stop-OrphanProcesses matched on the name alone, so any install, restart or stop
// killed every account's daemons -- Get-Process only enumerates other users' processes
// when the caller is elevated, so the damage was confined to elevated sessions, which is
// also the sessions people are most likely to run an installer from. The victims were
// left with a pid file naming a process that no longer existed, i.e. the "stale
// single-instance lock" reports. The scope key is $BOOTSTRAP_DIR, which every launcher
// puts in the command line verbatim ("<node>" "<$BOOTSTRAP_DIR\<name>-daemon.js>").
//
// Two more traps that only show up once you look at the whole file:
//   * The reap existed in three places -- the helper plus a hand-inlined copy in
//     Cmd-RestartCollector and another in Cmd-RestartUpdater, neither of which the helper's
//     -Match parameter had ever been threaded into. Fixing the helper alone fixed nothing
//     for restart-collector, which is the command the updater runs on every deploy.
//   * Stop-PidFile deleted the pid file unconditionally after killing, up to ten seconds
//     later. The collector task re-runs every five minutes, so the successor may already
//     have written its own pid there; deleting that leaves a live daemon with no pid file.
//
// So this pins: one reap implementation, scoped; and a pid-file removal that checks whose
// pid it is removing.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SERVICE_PS1 = 'scripts/loongsuite-pilot.ps1';
const text = readFileSync(SERVICE_PS1, 'utf-8');

// Drop comment lines so the prose explaining each rule cannot satisfy a check.
const codeOf = (s) => s.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

// Body = from the function header to the next top-level `function` declaration. Brace
// counting would trip over the here-strings and script blocks in this file.
const bodyOf = (name) => {
  const start = text.indexOf(`function ${name} {`);
  expect(start, `${name} not found in ${SERVICE_PS1}`).toBeGreaterThan(-1);
  const rest = text.slice(start + `function ${name} {`.length);
  const end = rest.search(/\nfunction \S+ \{/);
  return codeOf(end === -1 ? rest : rest.slice(0, end));
};

const code = codeOf(text);

describe('the orphan reap only kills this installation', () => {
  it('enumerates node command lines with one bulk CIM query', () => {
    // Both inline copies are gone. A fourth copy appearing is the failure mode this
    // catches: the scope below would be correct and irrelevant.
    const scans = code.match(/Get-CimInstance Win32_Process/g) || [];
    expect(scans).toHaveLength(1);
    const body = bodyOf('Stop-OrphanProcesses');
    expect(body).toContain('Get-CimInstance Win32_Process');
    expect(body).toContain('-Filter "Name = \'node.exe\'"');
    expect(body).not.toMatch(/Get-Process -Name "node"/);
    expect(body).not.toMatch(/ProcessId\s*=\s*\$\(\$_\./);
  });

  it('Stop-OrphanProcesses requires the command line to name our bootstrap dir', () => {
    const body = bodyOf('Stop-OrphanProcesses');
    // Both halves, in one predicate: the daemon name *and* the install scope.
    expect(body).toContain('$Match');
    expect(body).toMatch(/\$ownRoot = \(\[string\]\$BOOTSTRAP_DIR\)\.ToLower\(\)/);
    expect(body).toMatch(/\(\$cmdLine -match \$Match\) -and \$cmdLine\.ToLower\(\)\.Contains\(\$ownRoot\)/);
    // $DATA_DIR is the wrong key even though it is usually the same directory: the entry
    // script is loaded from $BOOTSTRAP_DIR = $CACHE_DIR\bin, and the two roots diverge
    // whenever LOONGSUITE_PILOT_CACHE_DIR is set without LOONGSUITE_PILOT_DATA_DIR.
    expect(body).not.toContain('$DATA_DIR');
  });

  it('restart-collector and restart-updater reap through the helper', () => {
    // Each must reap only its own daemon -- restart-collector deliberately leaves the
    // updater running, and vice versa -- so the -Match argument is part of the contract.
    expect(bodyOf('Cmd-RestartCollector')).toContain('Stop-OrphanProcesses -Match "collector-daemon"');
    expect(bodyOf('Cmd-RestartUpdater')).toContain('Stop-OrphanProcesses -Match "updater-daemon"');
  });

  it('the single-daemon callers still narrow the reap', () => {
    // Install-CollectorTask / Install-UpdaterTask reap immediately before re-registering
    // one task; an unnarrowed call there would take down the daemon they are not touching.
    expect(bodyOf('Install-CollectorTask')).toContain('Stop-OrphanProcesses -Match "collector-daemon"');
    expect(bodyOf('Install-UpdaterTask')).toContain('Stop-OrphanProcesses -Match "updater-daemon"');
  });
});

describe('Stop-PidFile removes only the pid it killed', () => {
  it('re-reads the file and compares before deleting', () => {
    const body = bodyOf('Stop-PidFile');
    // Re-read, not a reuse of the value captured before Stop-Process: the question is
    // what is on disk now.
    expect(body).toMatch(/\$currentPid = \(\[string\]\(Get-Content -LiteralPath \$pidFile[^\n]*\)\)\.Trim\(\)/);
    expect(body).toMatch(/if \(\$currentPid -eq \$pidVal\) \{\s*\n\s*Remove-Item \$pidFile/);
  });

  it('the only unconditional removal is the one for a pid that is already dead', () => {
    // The early return above it has already established the recorded process is gone, so
    // deleting there cannot clobber a successor -- it is the stale-file cleanup.
    const body = bodyOf('Stop-PidFile');
    const removals = body.split('\n').filter((l) => l.includes('Remove-Item $pidFile'));
    expect(removals).toHaveLength(2);
    const guarded = body.slice(body.indexOf('$pidVal ='));
    expect(guarded.split('\n').filter((l) => l.includes('Remove-Item $pidFile'))).toHaveLength(1);
  });
});
