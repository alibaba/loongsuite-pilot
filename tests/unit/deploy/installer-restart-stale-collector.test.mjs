// A re-install can leave the previous version's collector running, and nothing about it
// looks wrong.
//
// `start` is a deliberate no-op when a collector is already running, and on a re-install
// one usually is: Stop-PilotService only ends the current task instance, and Task
// Scheduler (or the updater's collector watchdog) relaunches it within seconds -- while
// `current` still names the OLD version dir, because Deploy-Package writes the new one
// only after Ensure-NodeModules. collector-daemon.js resolves `current` exactly once at
// startup, so that survivor serves the old dist forever while `status` reads `current`
// and reports the NEW version. The install prints "Service started"; the bytes the user
// just installed are never loaded.
//
// It went quiet the moment re-installs stopped overwriting the live version dir (pinned by
// installer-version-dir-not-overwritten.test.mjs): while Deploy-Package still did Remove-Item on it,
// the survivor died with ERR_MODULE_NOT_FOUND and got restarted onto the new version, so
// the bug announced itself. Keeping the old dir is right -- Restart-StaleCollector is the
// other half of it.
//
// Only the .ps1 installers are pinned here: the survivor is a Task Scheduler / watchdog
// artefact, and the .sh installers have no equivalent relaunch racing the deploy.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const PS1_INSTALLERS = [
  'deploy/installer.ps1',
  'deploy/installer-inner.ps1',
  'deploy/installer-opensource.ps1',
];

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

const present = PS1_INSTALLERS.filter(existsSync);

describe('installers displace a stale collector after re-installing', () => {
  it('defines Restart-StaleCollector', () => {
    expect(present.length).toBeGreaterThanOrEqual(1);
    for (const file of present) {
      const block = blockOf(read(file), 'pilot-restart-stale-collector');
      expect(block, `${file}: pilot-restart-stale-collector block missing`).toBeTruthy();
      expect(codeOf(block), file).toMatch(/function Restart-StaleCollector/);
    }
  });

  it('the block is byte-identical across the .ps1 installers', () => {
    // The three installers are near-copies maintained by hand; a block that drifts in one
    // of them is a variant that quietly goes back to serving the old dist.
    const blocks = present.map(f => blockOf(read(f), 'pilot-restart-stale-collector'));
    expect(blocks.filter(b => !b)).toEqual([]);
    expect(new Set(blocks).size).toBe(1);
  });

  it('uses restart-collector, not a bare restart', () => {
    // `restart` would also bounce the updater. restart-collector is what the updater
    // itself uses after deploying a version: stop unconditionally, kill orphans,
    // re-register, start -- and leave the updater running.
    const code = codeOf(blockOf(read(present[0]), 'pilot-restart-stale-collector'));
    expect(code).toMatch(/restart-collector/);
    expect(code.match(/\brestart\b(?!-collector)/), 'bare restart').toBeNull();
  });

  it('does nothing on a fresh install', () => {
    // No prior version means no survivor to displace, and `start` already launched the
    // collector from the new `current`. Bouncing it again would only slow the install.
    // $true, not a bare return: nothing to do is not a failure to displace.
    const code = codeOf(blockOf(read(present[0]), 'pilot-restart-stale-collector'));
    expect(code).toMatch(/if \(-not \$priorVersion\) \{ return \$true \}/);
  });

  it('reports a failed displacement instead of swallowing it', () => {
    // Native commands do not throw on a nonzero exit, so $LASTEXITCODE is the only signal
    // there is. Cmd-RestartCollector exits 1 when it cannot resolve node, when the
    // bootstrap entry is gone, and when the service manager refuses -- in all three the
    // survivor keeps serving the OLD version dir, and `2>$null | Out-Null` made that
    // indistinguishable from success.
    const code = codeOf(blockOf(read(present[0]), 'pilot-restart-stale-collector'));
    expect(code).toMatch(/if \(\$LASTEXITCODE -eq 0\) \{ return \$true \}/);
    expect(code).toMatch(/\$script:PILOT_LAST_RESTART_ERR = "restart-collector \(exit \$LASTEXITCODE\)/);
    expect(code).toMatch(/return \$false/);
    // Nothing may be discarded: no `| Out-Null` on the restart itself.
    expect(code).not.toMatch(/restart-collector[^\n]*Out-Null/);
  });

  it('every installer calls it with the prior version, after start', () => {
    for (const file of present) {
      const text = read(file);
      const lines = text.split('\n');
      const calls = lines
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /Restart-StaleCollector \$/.test(line));
      expect(calls.length, `${file}: never called`).toBeGreaterThanOrEqual(1);

      for (const [lineNo, line] of calls) {
        // Two arguments, both variables: the resolved service entry and the version that
        // was current before this deploy. A literal or a missing second argument means the
        // guard above turns the whole thing into a no-op. And the verdict has to be
        // captured -- see the next test for what has to happen to it.
        expect(line.trim(), `${file}:${lineNo}`).toMatch(/^\$\w+ = Restart-StaleCollector \$\S+ \$\S+$/);

        // It has to run after the start attempt -- displacing a survivor before `start`
        // just lets the watchdog put the old one back.
        const before = lines.slice(0, lineNo - 1).join('\n');
        expect(/-File \$\S+ start\b|& \$\S+ start\b/.test(before), `${file}:${lineNo}: no preceding start`).toBe(true);
      }
    }
  });

  it('no installer reports success when the displacement failed', () => {
    // `status` resolves `current`, and the survivor answers to it exactly as well as the new
    // collector would, so "is running" cannot tell them apart. An installer that captures
    // the verdict and then prints its check mark anyway is back to the original bug with
    // extra steps, so the captured variable has to reach the decision that prints it.
    for (const file of present) {
      const lines = read(file).split('\n');
      const calls = lines
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /Restart-StaleCollector \$/.test(line));

      for (const [lineNo, line] of calls) {
        const captured = line.trim().match(/^\$(\w+) = Restart-StaleCollector /);
        expect(captured, `${file}:${lineNo}: verdict discarded`).toBeTruthy();
        const after = lines.slice(lineNo).join('\n');
        const used = new RegExp(`(-and \\$${captured[1]}\\b|-not \\$${captured[1]}\\b|return \\$${captured[1]}\\b)`);
        expect(used.test(after), `${file}:${lineNo}: $${captured[1]} never gates anything`).toBe(true);
      }
    }
  });
});
