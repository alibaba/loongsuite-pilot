// scripts/postinstall.js is the only thing that copies assets/{hooks,skills,plugins}
// into the data dir, and on Windows it never got past the first copy.
//
// `fs.cpSync` moved to a C++ std::filesystem implementation in Node 22.9, and that
// implementation fail-fasts on Windows: exit 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN),
// no JS exception, no stderr, nothing copied. Measured with the bundled node v22.22.2
// and with v22.22.3 on a two-file ASCII tree, so it is not about path length or the
// non-ASCII %USERPROFILE% this worktree otherwise chases. The async `fs.cp` is fine.
//
// Two things made it invisible for as long as it lasted:
//   1. The process DIED rather than throwing, so postinstall's own try/catch (and its
//      file-by-file fallback) never ran, and every step after the first copy was
//      skipped without a word -- skill docs, agent plugins, the legacy intercept stub,
//      the config migration.
//   2. The installers printed "Hook scripts deployed" without looking at the exit code.
//
// The downstream symptom was a missing $PILOT_DATA/plugins tree, which failed the dsh
// deployment on every collection cycle with "plugin file not found or unreadable" --
// and DeploymentManager only tallied that failure, so the reason never reached the log.
//
// This file pins all three: no cpSync in shipped code, every asset tree installed
// independently, and the installers reporting what actually happened.
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const POSTINSTALL = 'scripts/postinstall.js';
const PS1_INSTALLERS = [
  'deploy/installer.ps1',
  'deploy/installer-inner.ps1',
  'deploy/installer-opensource.ps1',
];
const SH_INSTALLERS = [
  'deploy/installer.sh',
  'deploy/installer-inner.sh',
  'deploy/installer-opensource.sh',
];

const read = (f) => readFileSync(f, 'utf-8');

const codeLines = (text) => text
  .split('\n')
  .map((line, i) => [i + 1, line])
  .filter(([, line]) => !/^\s*#/.test(line));

const blockOf = (text, tag) => {
  const re = new RegExp(`^\\s*# >>> ${tag} >>>\\n[\\s\\S]*?^\\s*# <<< ${tag} <<<\\n`, 'm');
  const m = text.match(re);
  return m ? m[0] : null;
};

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

// Run postinstall.js against a throwaway data dir. HOME/USERPROFILE are redirected too:
// the legacy intercept stub is written under $HOME/.cache, and a test has no business
// touching the developer's real one.
//
// spawnSync rather than execFileSync: the exit code is the thing under test here (the
// installers key their check mark off it), and the per-tree failures are on stderr.
const runPostinstall = (dataDir, home) => {
  const res = spawnSync(process.execPath, [POSTINSTALL], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
    },
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
};

describe('postinstall installs every asset tree', () => {
  it('no shipped script or source file calls fs.cpSync', () => {
    // No allowlist: cpSync is unusable on the platform we ship a Node runtime for, and
    // the async fs.cp / a mkdir+copyFile walk are exact substitutes. Tests may still use
    // it -- they only ever run on the dev/CI machine, never on a user's Windows box.
    const tracked = execFileSync('git', ['ls-files', 'src', 'scripts', 'assets'], { encoding: 'utf-8' })
      .split('\n')
      .filter(f => /\.(ts|js|mjs|cjs)$/.test(f));
    expect(tracked.length).toBeGreaterThan(50);
    const offenders = [];
    for (const file of tracked) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        // Skip the explanatory comments that name it on purpose.
        if (/^\s*(\*|\/\/|#)/.test(line)) return;
        if (/\bcpSync\s*\(/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('postinstall.js explains why, so nobody puts cpSync back', () => {
    const text = read(POSTINSTALL);
    expect(text).toMatch(/0xC0000409|STATUS_STACK_BUFFER_OVERRUN/);
    expect(text).toMatch(/cpSync/);
  });

  it('installs hooks, skills and plugins into the data dir', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pilot-postinstall-'));
    try {
      const dataDir = path.join(root, 'data');
      const { status, out } = runPostinstall(dataDir, root);
      expect(status, out).toBe(0);

      for (const tree of ['hooks', 'skills', 'plugins']) {
        const dir = path.join(dataDir, tree);
        expect(existsSync(dir), `${tree} not created; postinstall said:\n${out}`).toBe(true);
        expect(walk(dir).length, `${tree} is empty`).toBeGreaterThan(4);
      }
      // Floors, not exact counts: 68 hooks / 19 skills / 16 plugins at the time of
      // writing. A tree that collapses to a handful of files is the failure mode here.
      expect(walk(path.join(dataDir, 'hooks')).length).toBeGreaterThanOrEqual(30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs the exact plugin path the dsh agent definition resolves to', () => {
    // The two ends of this were only connected at runtime, in a log line nobody emitted:
    // agents.d/dsh.json points at $PILOT_DATA/plugins/dsh/plugin.mjs, agent-def-loader
    // expands $PILOT_DATA to the data dir, and postinstall is what has to put a file
    // there. Renaming either side now fails here instead of once per collection cycle.
    const dsh = JSON.parse(read('agents.d/dsh.json'));
    const source = dsh.dshYamlPatch?.pluginSource ?? dsh.pluginSource;
    expect(source).toMatch(/^\$PILOT_DATA\//);
    const rel = source.replace(/^\$PILOT_DATA\//, '');
    expect(existsSync(path.join('assets', rel)), `${rel} not in assets/`).toBe(true);

    const root = mkdtempSync(path.join(tmpdir(), 'pilot-postinstall-dsh-'));
    try {
      const dataDir = path.join(root, 'data');
      const { status, out } = runPostinstall(dataDir, root);
      expect(status, out).toBe(0);
      const resolved = path.join(dataDir, ...rel.split('/'));
      expect(existsSync(resolved), `dsh plugin missing at ${resolved}`).toBe(true);
      expect(statSync(resolved).size).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('one failing tree does not take the others down with it', () => {
    // The old shape ran the three copies as one straight line, so whatever failed first
    // ended the script. Forced here by leaving a plain FILE where the hooks directory
    // should go: the hook copy fails with ENOTDIR, and skills and plugins must still
    // arrive.
    const root = mkdtempSync(path.join(tmpdir(), 'pilot-postinstall-partial-'));
    try {
      const dataDir = path.join(root, 'data');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path.join(dataDir, 'hooks'), 'not a directory');

      const { out } = runPostinstall(dataDir, root);

      expect(out).toMatch(/Failed to install hook script/);
      expect(existsSync(path.join(dataDir, 'skills')), `skills skipped:\n${out}`).toBe(true);
      expect(existsSync(path.join(dataDir, 'plugins')), `plugins skipped:\n${out}`).toBe(true);
      expect(walk(path.join(dataDir, 'plugins')).length).toBeGreaterThan(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 0 on a partial failure, and says so', () => {
    // Deliberate: this file is package.json's `postinstall`, so on the installers'
    // `npm install` fallback a non-zero exit surfaces as "Dependencies installation
    // failed" and aborts the install (the .ps1 installers exit 1 on a non-zero npm exit).
    // The installers key their check mark off the exit code to catch a hard crash, and
    // off this line to explain a partial result -- so both have to keep working.
    const root = mkdtempSync(path.join(tmpdir(), 'pilot-postinstall-exit-'));
    try {
      const dataDir = path.join(root, 'data');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path.join(dataDir, 'hooks'), 'not a directory');
      const { status, out } = runPostinstall(dataDir, root);
      expect(status, out).toBe(0);
      expect(out).toMatch(/failed asset tree/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clears AppleDouble sidecars an earlier install left behind', () => {
    // Not self-clearing otherwise: nothing deletes a file the current package no longer
    // ships, so the ~75 strays every pre-fix install put in hooks/ would sit there
    // forever -- in a directory hook-manager and the plugin strategies enumerate.
    const root = mkdtempSync(path.join(tmpdir(), 'pilot-postinstall-stale-'));
    try {
      const dataDir = path.join(root, 'data');
      const hooks = path.join(dataDir, 'hooks', 'claude-code');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(path.join(hooks, '._leftover.mjs'), 'stale');
      writeFileSync(path.join(dataDir, 'hooks', '.DS_Store'), 'stale');

      const { status, out } = runPostinstall(dataDir, root);
      expect(status, out).toBe(0);

      expect(existsSync(path.join(hooks, '._leftover.mjs'))).toBe(false);
      expect(existsSync(path.join(dataDir, 'hooks', '.DS_Store'))).toBe(false);
      expect(out).toMatch(/removed \d+ stale sidecar/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not carry AppleDouble sidecars into the data dir', () => {
    // The release tarball is built on a Mac, so assets/ ships ._* resource forks (75 of
    // them under assets/hooks alone). They are not runnable content and they land in
    // directories that other code enumerates.
    const root = mkdtempSync(path.join(tmpdir(), 'pilot-postinstall-appledouble-'));
    try {
      const dataDir = path.join(root, 'data');
      const { status, out } = runPostinstall(dataDir, root);
      expect(status, out).toBe(0);
      const junk = walk(dataDir)
        .map(f => path.basename(f))
        .filter(n => n.startsWith('._') || n === '.DS_Store');
      expect(junk).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('installers report what postinstall actually did', () => {
  it('every .ps1 installer captures the postinstall exit code', () => {
    for (const file of PS1_INSTALLERS.filter(existsSync)) {
      const block = blockOf(read(file), 'pilot-postinstall-exit-check');
      expect(block, file).toBeTruthy();
      const code = codeLines(block).map(([, l]) => l).join('\n');
      expect(code, file).toMatch(/\$postinstallExit = \$LASTEXITCODE/);
      // The success message must sit behind the check, not before it.
      expect(code, file).toMatch(/if \(\$postinstallExit -ne 0\)/);
      const successAt = code.indexOf('Hook scripts deployed');
      const checkAt = code.indexOf('$postinstallExit -ne 0');
      expect(successAt, file).toBeGreaterThan(checkAt);
    }
  });

  it('every .ps1 installer also catches a partial failure', () => {
    // The exit code covers a crash, not a tree postinstall.js could not copy: it exits 0
    // after reporting "N failed asset tree(s)" on purpose, because a non-zero exit would
    // abort the npm install fallback. Keying the check mark off the exit code alone printed
    // "Hook scripts deployed" over an install that had just said it lost a tree -- the same
    // silent-success shape this whole file exists to prevent, one notch smaller.
    //
    // "Post-install failed" is the third mode and the one that hid behind both checks: a
    // throw out of main() is caught at the bottom of postinstall.js, printed, and the process
    // still exits 0 -- no non-zero code and no "failed asset tree" line to grep for.
    for (const file of PS1_INSTALLERS.filter(existsSync)) {
      const block = blockOf(read(file), 'pilot-postinstall-exit-check');
      const code = codeLines(block).map(([, l]) => l).join('\n');
      // Streaming the output straight to the console would leave nothing to match against;
      // 2>&1 because postinstall.js reports the count on stderr.
      expect(code, file).toMatch(/\$postinstallOut = & \$script:NODE_BIN \$postinstallScript 2>&1/);
      expect(code, file).toMatch(/-match "failed asset tree\|Post-install failed"/);
      // The user still sees everything postinstall printed.
      expect(code, file).toMatch(/\$postinstallOut \| ForEach-Object \{ Write-Host \$_ \}/);
      // And the check mark sits behind the partial-failure branch, not in front of it.
      const partialAt = code.indexOf('elseif ($postinstallPartial)');
      expect(partialAt, `${file}: no partial-failure branch`).toBeGreaterThan(-1);
      expect(code.indexOf('Hook scripts deployed'), file).toBeGreaterThan(partialAt);
    }
  });

  it('postinstall.js still prints the two lines the installers grep for', () => {
    // The installers cannot see a per-tree failure or a thrown main() any other way -- both
    // exit 0 by design. Reword either line and the abort below silently stops firing.
    const text = read(POSTINSTALL);
    expect(text).toMatch(/failed asset tree/);
    expect(text).toMatch(/Post-install failed/);
  });

  it('no .ps1 installer keeps going after a failed postinstall', () => {
    // Reporting the failure was only half of it: the install used to print the ❌ and then
    // carry on to "Installation complete", leaving a collector with an empty
    // $DataDir\hooks -- it loads no hook at all and every collection cycle fails on a plugin
    // that was never written. Nothing downstream repairs that, so install aborts and upgrade
    // rolls back.
    //
    // The block itself only records the reason ($script:PILOT_POSTINSTALL_ERR, empty when
    // fine); the policy is at the call sites, which is what keeps the block byte-identical
    // across three installers with three different failure paths. Same split as
    // $script:PILOT_LAST_RESTART_ERR.
    for (const file of PS1_INSTALLERS.filter(existsSync)) {
      const text = read(file);
      const block = blockOf(text, 'pilot-postinstall-exit-check');
      const code = codeLines(block).map(([, l]) => l).join('\n');
      expect(code, `${file}: the block records no reason`)
        .toMatch(/\$script:PILOT_POSTINSTALL_ERR = "postinstall\.js/);
      // Set in both failure branches, and left empty in the ✅ one.
      expect(code.match(/\$script:PILOT_POSTINSTALL_ERR = "postinstall\.js/g).length, file).toBe(2);

      const lines = text.split('\n');
      const calls = lines
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /^\s*Deploy-Package \$script:INSTALL_SRC\s*$/.test(line));
      // install and upgrade. A third caller that ignores the verdict is the bug coming back.
      expect(calls.length, `${file}: expected two Deploy-Package call sites`).toBe(2);
      for (const [lineNo] of calls) {
        const after = lines.slice(lineNo, lineNo + 20).join('\n');
        expect(after, `${file}:${lineNo}: the postinstall verdict is never read`)
          .toMatch(/\$script:PILOT_POSTINSTALL_ERR/);
      }
      // The install path stops outright; the upgrade path falls into its existing
      // `if (-not $started)` rollback, so it must not start the new version either.
      expect(text, `${file}: install does not abort`)
        .toMatch(/if \(\$script:PILOT_POSTINSTALL_ERR\) \{[\s\S]{0,400}?exit 1/);
      expect(text, `${file}: upgrade starts the collector anyway`)
        .toMatch(/-not \$script:PILOT_POSTINSTALL_ERR|\} else \{\n\s*\$started = Start-PilotAndWait/);
    }
  });

  it('the exit check is byte-identical across the .ps1 installers', () => {
    // Same reason as the other shared blocks: a copy that drifts is a variant that goes
    // back to claiming success.
    const present = PS1_INSTALLERS.filter(existsSync);
    expect(present.length).toBeGreaterThanOrEqual(1);
    const blocks = present.map(f => blockOf(read(f), 'pilot-postinstall-exit-check'));
    expect(blocks.filter(b => !b)).toEqual([]);
    expect(new Set(blocks).size).toBe(1);
  });

  it('every .sh installer checks the postinstall exit code too', () => {
    for (const file of SH_INSTALLERS.filter(existsSync)) {
      const text = read(file);
      const run = text.match(/"\$NODE_BIN" "\$PERMANENT_DIR\/scripts\/postinstall\.js"(.*)/);
      expect(run, `${file}: postinstall invocation not found`).toBeTruthy();
      // Either `|| postinstall_exit=$?` or the older `|| { ...; return 1; }` shape.
      expect(run[1], file).toMatch(/\|\|/);
    }
  });

  it('no .sh installer keeps going after a failed postinstall either', () => {
    for (const file of SH_INSTALLERS.filter(existsSync)) {
      const text = read(file);
      // Captured, not streamed: two of the three failure modes are only in the output.
      expect(text, `${file}: postinstall output is not captured`).toMatch(/postinstall_out="\$\(/);
      expect(text, file).toMatch(/grep -qE "failed asset tree\|Post-install failed"/);
      // The user still sees it. `if`, not `&&`: under set -e a false `[ -n ... ]` would end
      // deploy_package right there, turning an empty (successful) run into a failure.
      expect(text, file).toMatch(/if \[ -n "\$postinstall_out" \]; then\n\s*printf '%s\\n' "\$postinstall_out"/);
      // Two failure branches, each leaving deploy_package.
      const branches = text.match(/hooks\/plugins are missing"\n\s*return 1/g) ?? [];
      expect(branches.length, `${file}: deploy_package does not give up`).toBe(2);
      // And both callers act on it: the install says why before exiting, the upgrade rolls the
      // version pointer back. A bare `deploy_package "$INSTALL_SRC"` would abort under set -e
      // without either.
      expect(text.match(/if ! deploy_package "\$INSTALL_SRC"; then/g)?.length, `${file}: an unguarded call site`).toBe(2);
      expect(text, `${file}: the upgrade path does not roll back`).toMatch(/rollback 2>\/dev\/null \|\| _rollback_ok=0/);
    }
  });

  it('every installer tells postinstall which data dir to fill', () => {
    // postinstall.js resolves LOONGSUITE_PILOT_DATA_DIR and otherwise falls back to
    // $HOME/.loongsuite-pilot. With -DataDir / --data-dir that fallback is the wrong
    // tree: hooks and plugins land next to a config that lives somewhere else, and the
    // collector finds no hooks at all -- silently, like everything else in this file.
    for (const file of PS1_INSTALLERS.filter(existsSync)) {
      const block = blockOf(read(file), 'pilot-postinstall-exit-check');
      const code = codeLines(block).map(([, l]) => l).join('\n');
      expect(code, file).toMatch(/\$env:LOONGSUITE_PILOT_DATA_DIR = \$DataDir/);
      // Set for the child only: the surrounding installer must keep seeing what it had.
      expect(code, file).toMatch(/Remove-Item Env:LOONGSUITE_PILOT_DATA_DIR/);
    }
    for (const file of SH_INSTALLERS.filter(existsSync)) {
      const text = read(file);
      const at = text.indexOf('"$NODE_BIN" "$PERMANENT_DIR/scripts/postinstall.js"');
      expect(at, `${file}: postinstall invocation not found`).toBeGreaterThan(-1);
      // The assignment sits on the line(s) directly above the command.
      const preamble = text.slice(Math.max(0, at - 400), at);
      expect(preamble, file).toMatch(/LOONGSUITE_PILOT_DATA_DIR="\$DATA_DIR" \\\n\s*$/);
    }
  });

  it('the auto-upgrade path runs postinstall and reports what it said', () => {
    // Same fix, other entry point: an auto-upgrade re-runs the new package's postinstall,
    // which is how an already-broken install heals without a reinstall. Two ways to lose
    // it -- delete the call (pinned behaviourally in tests/unit/updater/updater.test.ts),
    // or keep the call and drop its output on the floor. postinstall exits 0 on a partial
    // failure by design, so the output is the only signal there is.
    const updater = read('src/updater/updater.ts');
    expect(updater).toMatch(/'scripts', 'postinstall\.js'/);
    expect(updater).toMatch(/LOONGSUITE_PILOT_DATA_DIR: this\.paths\.dataDir/);
    expect(updater).toMatch(/failed asset tree/);
  });
});
