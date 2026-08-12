// Write-Config must never report success over a config that was not written.
//
// The config write is the last step that can silently no-op: it runs *after*
// Deploy-Package, so a swallowed failure does not look like a failed install — it
// looks like a successful install whose collector reports nowhere. node signals
// failure by printing a stack to stderr and exiting non-zero, so the exit code has
// to be captured and the file's existence confirmed before printing "Config written".
//
// installer.ps1 had the full four-piece guard; installer-inner.ps1 printed the
// success line unconditionally. This suite pins the guard in both.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// installer-opensource.ps1 is tracked separately and is not covered yet.
const VARIANTS = [
  { file: 'installer.ps1', paths: ['$configFile'] },
  // installer-inner.ps1 writes two files from one node process, so a partial write
  // (first writeFileSync succeeds, second throws) must fail the install as well.
  { file: 'installer-inner.ps1', paths: ['$configFile', '$innerDataConfigFile'] },
];

const writeConfigOf = (text) => {
  const start = text.indexOf('function Write-Config {');
  expect(start).toBeGreaterThan(-1);
  // Write-Config is followed by a `# ===` banner comment for the next section.
  const end = text.indexOf('\n# ===', start);
  return text.slice(start, end > -1 ? end : undefined);
};

describe('installers verify the config write before claiming success', () => {
  for (const { file, paths } of VARIANTS) {
    const present = existsSync(resolve('deploy', file));
    const body = present ? writeConfigOf(readFileSync(resolve('deploy', file), 'utf-8')) : '';

    it.skipIf(!present)(`${file} captures node's exit code`, () => {
      expect(body).toMatch(/\$writeExit = \$LASTEXITCODE/);
    });

    it.skipIf(!present)(`${file} lowers EAP around the node call so the check is reachable`, () => {
      // Under $ErrorActionPreference = "Stop" a single line on node's stderr becomes a
      // terminating error, and the exit-code check below it would never run.
      expect(body).toMatch(/\$prevEAP = \$ErrorActionPreference; \$ErrorActionPreference = "Continue"/);
      expect(body).toMatch(/\$ErrorActionPreference = \$prevEAP/);
    });

    it.skipIf(!present)(`${file} fails the install when the write did not land`, () => {
      // The condition spans nested parens, so take the `if (...) {` line as written and
      // the block that follows it.
      const guard = body.match(/^\s*if \(\$writeExit -ne 0(.*)\) \{\n([\s\S]*?)^\s*\}/m);
      expect(guard).not.toBeNull();
      // Every file the node payload writes must be confirmed to exist.
      for (const p of paths) {
        expect(guard[1]).toContain(`-not (Test-Path ${p})`);
      }
      // A message alone is not enough — the install has to stop.
      expect(guard[2]).toMatch(/exit 1/);
    });

    it.skipIf(!present)(`${file} prints the success line only after the guard`, () => {
      // Anchor on the Msg statement, not the bare words: the explanatory comment above
      // the guard also quotes "Config written".
      const guardAt = body.search(/^\s*if \(\$writeExit -ne 0/m);
      const successAt = body.search(/^\s*Msg "[^"]*" "[^"]*Config written"/m);
      expect(guardAt).toBeGreaterThan(-1);
      expect(successAt).toBeGreaterThan(guardAt);
    });
  }
});
