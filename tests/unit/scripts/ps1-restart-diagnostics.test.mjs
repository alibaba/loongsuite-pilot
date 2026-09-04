// restart-collector / restart-updater must never fail without saying why.
//
// The production report this pins was one line with no cause in it:
//   Cmd-RestartUpdater : Service manager failed to restart updater (init_type=taskscheduler)
// Everything that would have explained it was unreachable or unreadable:
//   * the reasons were printed with Write-Host, and the caller uses execFile, whose
//     err.message carries stderr only -- stdout was dropped on the floor;
//   * $ErrorActionPreference = "Stop" (top of the script) makes Write-Error a
//     *terminating* error, so any diagnostics written after it -- including the old
//     `return` / `exit 1` -- were dead code;
//   * several branches printed nothing at all.
//
// So every non-success exit now goes through Write-RestartFailure, which prints the
// reason and drops a breadcrumb file that the caller reads (src/utils/restart-breadcrumb.ts)
// to enrich its alarm. These checks pin the shape of that contract, not any wording.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SERVICE_PS1 = 'scripts/loongsuite-pilot.ps1';
const BREADCRUMB_TS = 'src/utils/restart-breadcrumb.ts';
const text = readFileSync(SERVICE_PS1, 'utf-8');

// Drop comment lines so prose about Write-RestartFailure cannot satisfy a structural check.
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

const RESTART_CMDS = [
  { fn: 'Cmd-RestartCollector', target: 'collector', wait: 'Wait-ForCollectorHeartbeat' },
  { fn: 'Cmd-RestartUpdater', target: 'updater', wait: 'Wait-ForUpdaterAlive' },
];

describe('restart commands report every failure path', () => {
  for (const { fn, target } of RESTART_CMDS) {
    it(`${fn}: every Write-Error is preceded by Write-RestartFailure`, () => {
      const body = bodyOf(fn);
      const segments = body.split('Write-Error');
      // Trailing segment is the code after the last Write-Error, not an exit.
      const beforeExits = segments.slice(0, -1);
      expect(beforeExits.length, `${fn} has no Write-Error exits to check`).toBeGreaterThan(1);
      beforeExits.forEach((segment, i) => {
        expect(
          segment.includes('Write-RestartFailure'),
          `${fn}: the Write-Error at exit #${i + 1} has no Write-RestartFailure before it. `
            + 'Under $ErrorActionPreference = "Stop" Write-Error terminates the script, so '
            + 'diagnostics placed after it never run.',
        ).toBe(true);
      });
    });

    it(`${fn}: clears the previous breadcrumb before doing anything`, () => {
      // "A breadcrumb exists" must mean "the most recent attempt failed". Without this the
      // reader would explain a script that never even started with an older failure.
      const body = bodyOf(fn);
      const clearAt = body.indexOf(`Clear-RestartFailure "${target}"`);
      expect(clearAt, `${fn} does not clear the ${target} breadcrumb`).toBeGreaterThan(-1);
      const firstWrite = body.indexOf('Write-RestartFailure');
      expect(firstWrite).toBeGreaterThan(clearAt);
    });
  }

  it('the fallback exit reports the stage it reached, not just init_type', () => {
    // The whole point of tracking $stage forward through the ladder: the final exit used
    // to carry init_type and nothing else.
    for (const { fn } of RESTART_CMDS) {
      const body = bodyOf(fn);
      expect(body).toContain('-Stage $stage -Detail $detail -Extra $extra');
      expect(body).toMatch(/Write-Error "Service manager failed to restart \w+ \(init_type=\$initType stage=\$stage\): \$detail"/);
    }
  });
});

describe('restart commands verify the service actually came up', () => {
  for (const { fn, wait } of RESTART_CMDS) {
    it(`${fn}: every Start-ScheduledTask is followed by ${wait}`, () => {
      // Start-ScheduledTask only means Task Scheduler accepted the request. The old code
      // slept one second and probed once, which is not enough for wscript.exe -> node to
      // reach Running -- good restarts were reported as failures, and with
      // init_type=taskscheduler that verdict was terminal.
      const body = bodyOf(fn);
      // Statement starts only: the name also appears inside the $detail strings.
      const starts = [...body.matchAll(/^[ \t]*Start-ScheduledTask\b/gm)];
      expect(starts.length, `${fn} does not start the task on both paths`).toBeGreaterThan(1);
      starts.forEach((match, i) => {
        const window = body.slice(match.index, match.index + 400);
        expect(
          window.includes(wait),
          `${fn}: Start-ScheduledTask #${i + 1} is not followed by ${wait}, so a task that `
            + 'never comes up would be reported as a successful restart',
        ).toBe(true);
      });
    });
  }

  for (const wait of ['Wait-ForCollectorHeartbeat', 'Wait-ForUpdaterAlive']) {
    it(`${wait} polls to a deadline instead of sleeping once`, () => {
      const body = bodyOf(wait);
      expect(body).toContain('$deadline');
      expect(body).toMatch(/while \(\(Get-Date\) -lt \$deadline\)/);
    });
  }
});

describe('self-heal is reachable on a taskscheduler install', () => {
  for (const { fn } of RESTART_CMDS) {
    it(`${fn}: the self-heal branch is not gated on init_type`, () => {
      // The original defect behind the production report: with init_type=taskscheduler a
      // task that was missing or unusable was not allowed to be re-registered, so the run
      // could only fall through to the reasonless Write-Error -- forever, once per cycle.
      const body = bodyOf(fn);
      const selfHealAt = body.indexOf('if (-not $restarted)');
      const fallbackAt = body.indexOf('if ($initType -in @(');
      expect(selfHealAt, `${fn} has no self-heal branch`).toBeGreaterThan(-1);
      expect(fallbackAt, `${fn} has no init_type-gated fallback`).toBeGreaterThan(selfHealAt);
      expect(
        body.slice(selfHealAt, fallbackAt).includes('$initType'),
        `${fn}: the self-heal branch still consults $initType`,
      ).toBe(false);
    });

    it(`${fn}: the unmanaged background fallback stays gated`, () => {
      // Self-heal opening up does not open this up: on a taskscheduler install a detached
      // powershell is not a repair, it is a second daemon that dies at the next logoff
      // while hiding the real breakage. Skipping it must be reported, not silent.
      const body = bodyOf(fn);
      expect(body).toContain('if ($initType -in @("background", "unknown", ""))');
      const fallbackAt = body.indexOf('if ($initType -in @(');
      expect(body.slice(fallbackAt)).toContain('Write-RestartFailure');
    });
  }
});

describe('the breadcrumb writer is safe for the reader', () => {
  const writer = bodyOf('Write-RestartFailure');

  it('writes UTF-8 and renames into place', () => {
    // Set-Content defaults to the ANSI codepage while node reads UTF-8: a localized
    // Windows message or a non-ASCII account name would arrive as mojibake.
    expect(writer).toContain('-Encoding UTF8');
    expect(writer).toContain('ConvertTo-Json');
    expect(writer).toMatch(/Move-Item -LiteralPath \$tmp -Destination \$file -Force/);
  });

  it('prints to the console before touching the file', () => {
    // The console copy is the only one a human running the command by hand sees, and it
    // must survive a failure of the file write.
    expect(writer.indexOf('Write-Host "[restart-failure]')).toBeGreaterThan(-1);
    expect(writer.indexOf('Write-Host "[restart-failure]')).toBeLessThan(writer.indexOf('Set-Content'));
  });

  it('builds the payload with hashtables only', () => {
    // Constrained Language Mode: [pscustomobject]@{} throws on 5.1 CLM (measured), so the
    // payload and the diag map have to be plain hashtables.
    expect(writer).not.toContain('pscustomobject');
    expect(writer).not.toContain('New-Object');
    expect(bodyOf('Get-RestartDiagnostics')).not.toContain('pscustomobject');
  });

  it('collects diagnostics read-only', () => {
    // Test-PidRunning deletes a pid file whose process is gone. A diagnostic must not
    // change the state it is describing -- least of all the state the next probe reads.
    expect(bodyOf('Get-RestartDiagnostics')).not.toContain('Test-PidRunning');
  });

  it('timestamps in real UTC epoch seconds', () => {
    // Get-Date -UFormat %s on 5.1 formats local time as if it were UTC, so the value is
    // off by the timezone offset and the reader's freshness check would misjudge it.
    const epoch = bodyOf('Get-EpochSeconds');
    expect(epoch).toContain('ToUniversalTime()');
    expect(epoch).not.toContain('UFormat');
  });
});

describe('the schtasks cross-check survives EAP=Stop', () => {
  for (const fn of ['Test-TaskExistsViaSchtasks', 'Invoke-SchtasksRun']) {
  it(`${fn} uses the prevEAP / 2>&1 / $LASTEXITCODE shape`, () => {
    // Under $ErrorActionPreference = "Stop", a native command writing a single line to
    // stderr with a 2>&1 redirect in effect raises a terminating NativeCommandError whose
    // message is that raw line: every branch below would be skipped and the caller would
    // see raw schtasks text instead of a diagnosis. See AGENTS.md rule 2.
    const body = bodyOf(fn);
    expect(body).toContain('$prevEAP = $ErrorActionPreference');
    expect(body).toContain('$ErrorActionPreference = "Continue"');
    expect(body).toMatch(/finally \{\s*\$ErrorActionPreference = \$prevEAP/);

    // $LASTEXITCODE must be read on the very next line -- any command in between
    // overwrites it -- and be preset non-zero in case schtasks.exe never launches.
    // The captured stderr is a report field, so it must not carry the capture's own
    // artifacts: an empty stderr line arrives as an ErrorRecord that stringifies to its
    // exception type name (measured on 5.1).
    expect(body).toContain('System.Management.Automation.RemoteException');
    expect(body).not.toMatch(/\[System\.Management\.Automation\.ErrorRecord\]/);

    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const nativeAt = lines.findIndex((l) => l.includes('& schtasks.exe') && l.includes('2>&1'));
    expect(nativeAt, 'no schtasks.exe call with 2>&1').toBeGreaterThan(-1);
    expect(lines[nativeAt + 1]).toBe('$code = $LASTEXITCODE');
    expect(lines.slice(0, nativeAt).some((l) => /^\$code = [1-9]/.test(l))).toBe(true);
  });
  }
});

describe('stage labels agree with the reader', () => {
  it('every stage the script writes is known to restart-breadcrumb.ts', () => {
    // The stages are aggregation keys in the alarm stream. A label only one side knows
    // makes the alarm unqueryable, which is a silent failure of its own.
    const tsText = readFileSync(BREADCRUMB_TS, 'utf-8');
    const listed = tsText.slice(
      tsText.indexOf('RESTART_STAGES = ['),
      tsText.indexOf('] as const'),
    );
    const known = new Set([...listed.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
    expect(known.size).toBeGreaterThan(5);

    const code = codeOf(text);
    const used = new Set([
      ...[...code.matchAll(/-Stage "([^"$]+)"/g)].map((m) => m[1]),
      ...[...code.matchAll(/\$stage = "([^"$]+)"/g)].map((m) => m[1]),
    ]);
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((stage) => !known.has(stage))).toEqual([]);
  });
});

describe('query-fail still starts the task', () => {
  it('Get-TaskStartIntent starts on query error or schtasks yes, and only confirms missing otherwise', () => {
    const body = bodyOf('Get-TaskStartIntent');
    expect(body).toContain('Test-TaskExistsViaSchtasks');
    expect(body).toContain('$Query.error');
    expect(body).toContain('$existsSchtasks -eq "yes"');
    expect(body).toContain('should_start');
    expect(body).toContain('confirmed_missing');
  });

  for (const { fn } of RESTART_CMDS) {
    it(`${fn}: Start-ScheduledTask is gated on $shouldStart, self-heal on $confirmedMissing`, () => {
      const body = bodyOf(fn);
      expect(body).toContain('Get-TaskStartIntent');
      expect(body).toContain('if ($shouldStart)');
      expect(body).toContain('Invoke-SchtasksRun');
      const selfHealAt = body.indexOf('if (-not $restarted)');
      expect(selfHealAt).toBeGreaterThan(-1);
      expect(body.indexOf('if ($confirmedMissing)', selfHealAt)).toBeGreaterThan(selfHealAt);
    });
  }
});

describe('wait loops do not delete pid files', () => {
  it('Test-PidAlive is read-only', () => {
    const body = bodyOf('Test-PidAlive');
    expect(body).toContain('Get-Process -Id');
    expect(body).not.toContain('Remove-Item');
    expect(body).not.toContain('Stop-Process');
  });

  for (const wait of ['Wait-ForCollectorHeartbeat', 'Wait-ForUpdaterAlive']) {
    it(`${wait} uses Test-PidAlive, not Test-PidRunning`, () => {
      const body = bodyOf(wait);
      expect(body).toContain('Test-PidAlive');
      expect(body).not.toContain('Test-PidRunning');
      expect(body).not.toContain('Remove-Item');
    });
  }
});

describe('Windows background fallback waits instead of faking success', () => {
  for (const { fn, wait } of RESTART_CMDS) {
    it(`${fn}: Start-BackgroundDaemon is followed by ${wait} and fails closed`, () => {
      const body = bodyOf(fn);
      const fallbackAt = body.indexOf('Start-BackgroundDaemon');
      expect(fallbackAt, `${fn} has no Start-BackgroundDaemon`).toBeGreaterThan(-1);
      const window = body.slice(fallbackAt, fallbackAt + 1200);
      expect(window).toContain(wait);
      expect(window).toContain('Write-RestartFailure');
      expect(window).toContain('not-running-after-start');
    });
  }
});

describe('definition_owner does not treat Access Denied as missing', () => {
  it('Get-RestartDiagnostics calls Get-Acl without a Test-Path short-circuit', () => {
    const body = bodyOf('Get-RestartDiagnostics');
    expect(body).toContain('Get-Acl');
    expect(body).toContain('unreadable:');
    expect(body).not.toContain('no definition file');
  });
});
