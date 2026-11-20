/**
 * A version directory is never rewritten in place, on any install channel.
 *
 * Symptom this pins: re-running the installer over a live install deleted
 * versions/<ver>_<commit>/ and re-populated it while `current` still pointed there.
 * A collector launched in that window (the installer's own "start", or the updater
 * task relaunching it) resolved versions/<current>/dist/index.js against a directory
 * whose node_modules were not back yet and died with
 *   ERR_MODULE_NOT_FOUND: Cannot find package 'pino' imported from ...\dist\index.js
 * recorded in logs/last-startup-crash.json as phase=module_load. The install then
 * reported "Collector task produced no runtime heartbeat" even though the box
 * converged minutes later, once the deploy had finished.
 *
 * Rule: deploy into a directory nothing points at (a fresh suffixed sibling when the
 * name is taken), install dependencies there, and only then write current/previous.
 * Version and commit are read from the VERSION file, not from the directory name, so
 * the suffix is inert for Get-VersionFromDir / Get-CommitFromDir / GC-OldVersions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// installer-opensource.ps1 is the only one of these that exists in the open-source repo;
// the other two arrive with the internal mirror, and the same assertions then cover them.
const INSTALLERS = [
  'deploy/installer.ps1',
  'deploy/installer-inner.ps1',
  'deploy/installer-opensource.ps1',
].filter(rel => existsSync(join(repoRoot, rel)));

/** Body of `function <name> { ... }` up to the next top-level `function` or EOF. */
function functionBody(text, name) {
  const start = text.indexOf(`function ${name} {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = text.slice(start);
  const next = rest.search(/\n# =+\nfunction |\nfunction /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('Deploy-Package never overwrites a version directory in place', () => {
  it('finds the installers to check', () => {
    // Guards against a silently empty sweep (renamed file, wrong cwd).
    expect(INSTALLERS.length).toBeGreaterThanOrEqual(1);
  });

  for (const rel of INSTALLERS) {
    describe(rel, () => {
      const text = readFileSync(join(repoRoot, rel), 'utf8');
      const body = functionBody(text, 'Deploy-Package');

      it('picks a fresh directory name instead of removing the existing one', () => {
        // The versioned branch must not rm -rf its own target. The legacy
        // (no-VERSION-file) branch still overwrites $PERMANENT_DIR, which nothing
        // points at through `current`, so it is matched narrowly by variable name.
        expect(body).not.toMatch(/Remove-Item\s+\$target\s+-Recurse/);
        expect(body).toMatch(/if \(Test-Path -LiteralPath \$target\)/);
        expect(body).toMatch(/\$deployedDirName = "\$\{baseDirName\}_\$\{suffix\}"/);
      });

      it('publishes current only after dependencies are installed', () => {
        const setCurrent = body.indexOf('Set-Content -Path $currentFile -Value $deployedDirName');
        const installDeps = body.indexOf('Ensure-NodeModules');
        expect(setCurrent, 'current is not published from $deployedDirName').toBeGreaterThan(-1);
        expect(installDeps).toBeGreaterThan(-1);
        expect(setCurrent).toBeGreaterThan(installDeps);
      });

      it('records the outgoing version as previous, without clobbering itself', () => {
        expect(body).toMatch(/if \(\$oldDir -and \$oldDir -ne \$deployedDirName\) \{/);
      });
    });
  }
});
