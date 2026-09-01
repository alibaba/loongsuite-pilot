// Windows hands out %TEMP% in 8.3 short form whenever the profile name does not fit 8.3,
// which a dot in an account name is often enough to do: C:\Users\zhang.wang gives
// %TEMP% = C:\Users\ZHANG~1.WAN\AppData\Local\Temp while %USERPROFILE% stays long.
// Reading such a path works everywhere, but Remove-Item, Move-Item (source), Rename-Item,
// Set-Location and Push-Location fail with
//
//     An object at the specified path C:\Users\ZHANG~1.WAN does not exist.
//
// naming the prefix their walk broke on rather than the path that was passed in.
//
// It is one guard in FileSystemProvider.NormalizeThePath, which the .NET stack trace on the
// PSArgumentException names. The walk accumulates currentPath in the form it was typed and,
// per segment, throws when `fsinfo.FullName.Length < currentPath.Length` -- a check aimed at
// a child name of two or more dots (.NET resolves that to the parent, so it comes back
// shorter), which an 8.3 name longer than the name it stands for trips in exactly the same
// way. The very next line only expands a short name when doing so would not shorten it.
//
// So the trigger is narrower than "a segment is in 8.3 form", and reproducing with the wrong
// name proves nothing. Measured on 5.1.26100 over 13 profile names and 7 nesting cases:
// zhang.wang -> ZHANG~1.WAN (11 > 10) throws, abcd.wang -> ABCD~1.WAN (10 > 9) throws,
// wang.zhang -> WANG~1.ZHA (10 = 10) works, zhangsan.wang -> ZHANGS~1.WAN (12 < 13) works,
// zhang.san gets no short name at all. It takes a short base with an over-long extension.
// Depth is not irrelevant either: the guard runs per prefix, so deltas prefix-sum and order
// matters -- VERYLO~1\ZHANG~1.WAN is fine (-11 masks +1) while ZHANG~1.WAN\VERYLO~1 throws
// on its first segment, and wrapping the offender in a long outer directory does not help.
// -LiteralPath behaves identically to -Path (file, empty directory and -Recurse tree
// alike), so this is not the globbing hazard that -LiteralPath fixes, and Convert-Path /
// Resolve-Path are not the fix either -- both hand the short form straight back.
//
// It cost one real install twice over. Move-Item could not land the prebuilt
// node_modules, so that degraded to npm install; then the cleanup in the finally raised
// the error above, and because it arrives during parameter binding as a
// PSArgumentException rather than as an error record, -ErrorAction SilentlyContinue did
// not suppress it. Thrown from inside a finally it replaced the exception in flight and
// aborted the run, leaving no config, no command shim and no service.
//
// The reasoning is the rule; this file is the ratchet. Two invariants carry it:
// nothing that could be a temp path reaches Remove-Item or Move-Item unnormalised, and
// no finally deletes a file at all -- cleanup there goes through a helper that cannot
// raise.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VARIANTS = ['installer.ps1', 'installer-inner.ps1', 'installer-opensource.ps1'];
const present = VARIANTS.filter(f => existsSync(resolve('deploy', f)));
const read = (f) => readFileSync(resolve('deploy', f), 'utf-8');

const blockOf = (text, tag) => {
  const re = new RegExp(`^# >>> ${tag} >>>\\n[\\s\\S]*?^# <<< ${tag} <<<\\n`, 'm');
  const m = text.match(re);
  return m ? m[0] : null;
};

// installer-opensource.ps1 is landed on GitHub separately from the internal
// variants, so the internal tree may still have the file without the block
// until the next opensource sync. Sweep helpers only on copies that have it.
const withBlock = present.filter(f => blockOf(read(f), 'pilot-short-path'));

const functionOf = (text, name) => {
  const start = text.indexOf(`function ${name} {`);
  if (start < 0) return '';
  const next = text.indexOf('\nfunction ', start + 1);
  return text.slice(start, next < 0 ? text.length : next);
};

// Here-strings carry the JS payloads that patch config.json, and that JS has its own
// `} finally {` and its own braces. Blank their bodies (keeping the line count) before
// anything counts a brace or greps for a cmdlet. A here-string opens at the end of a
// line and can only close with "@ / '@ at the start of one.
const stripHereStrings = (text) => {
  const out = [];
  let closer = null;
  for (const line of text.split('\n')) {
    if (closer) {
      if (line.startsWith(closer)) { closer = null; out.push(''); } else out.push('');
      continue;
    }
    const open = line.match(/@("|')\s*$/);
    if (open) { closer = open[1] === '"' ? '"@' : "'@"; out.push(''); continue; }
    out.push(line);
  }
  return out;
};

// Full-line comments only: enough to keep a brace in prose out of the counting, while
// leaving code untouched.
const codeOnly = (lines) => lines.map(l => (/^\s*#/.test(l) ? '' : l));

// Bodies of every finally block, by brace matching from the `finally {`.
const finallyBodies = (text) => {
  const src = codeOnly(stripHereStrings(text)).join('\n');
  const out = [];
  const re = /\bfinally\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
};

// Paths that could carry an 8.3 segment: anything rooted in a temp dir, plus anything
// derived from one via Join-Path / Split-Path / Get-ChildItem, plus plain aliases.
// Seeded from the two temp-root helpers and from $env:TEMP / $env:TMP directly, then
// run to a fixpoint -- `$tmp` -> `$stage` -> `$stagedModules` is the chain that broke
// the real install. Get-ChildItem is how the 7-Zip fallback's `$tarFile` is born.
const taintedVars = (text) => {
  const lines = codeOnly(stripHereStrings(text));
  const bindings = [];
  for (const line of lines) {
    const assign = line.match(/\$(?:script:)?([A-Za-z_]\w*)\s*=\s*(.*)$/);
    if (assign) bindings.push([assign[1], assign[2]]);
  }
  // GetTempPath() is not CLM-safe and installer-opensource.ps1 should be using the
  // shared helper, but it is still a temp root, so it is seeded here all the same.
  const seed = /Get-PilotTempRoot|Get-PilotAsciiTempRoot|\$env:TEMP\b|\$env:TMP\b|GetTempPath/;
  const vars = new Set();
  for (const [name, rhs] of bindings) if (seed.test(rhs)) vars.add(name);
  for (let pass = 0; pass < 8; pass++) {
    const before = vars.size;
    for (const [name, rhs] of bindings) {
      const derived = /\b(Join-Path|Split-Path|Get-ChildItem)\b/.test(rhs) || /^\$(?:script:)?[A-Za-z_]\w*\s*$/.test(rhs);
      if (!derived) continue;
      if ([...vars].some(v => new RegExp(`\\$(?:script:)?${v}\\b`).test(rhs))) vars.add(name);
    }
    if (vars.size === before) break;
  }
  return vars;
};

// Every delete or move of a possibly-short path, the helper calls included -- counting
// those too is what keeps the sweep from going quiet the moment a site is converted.
const hazardSites = (text) => {
  const names = [...taintedVars(text)];
  const out = [];
  const lines = stripHereStrings(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    // Every cmdlet measured to go through NormalizeThePath, not just the two that broke
    // the real install -- Rename-Item, Set-Location and Push-Location throw the identical
    // PSArgumentException, so a future `Push-Location $tmp` has to be caught here too.
    if (!/\b(Remove-Item|Move-Item|Rename-Item|Set-Location|Push-Location|Remove-PilotPathQuietly)\b/.test(line)) continue;
    if (!names.some(v => new RegExp(`\\$(?:script:)?${v}\\b`).test(line))) continue;
    out.push({ n: i + 1, line: line.trim() });
  }
  return out;
};

describe('installers survive an 8.3 short %TEMP%', () => {
  it('finds the installers to check', () => {
    // Guards against a silently empty sweep. The GitHub tree only has
    // installer-opensource.ps1; the internal tree always has installer.ps1.
    expect(present.length).toBeGreaterThan(0);
    if (present.includes('installer.ps1')) {
      expect(present).toContain('installer.ps1');
    } else {
      expect(present).toContain('installer-opensource.ps1');
    }
  });

  it('every present internal installer carries the short-path block', () => {
    for (const f of ['installer.ps1', 'installer-inner.ps1']) {
      if (!present.includes(f)) continue;
      expect(blockOf(read(f), 'pilot-short-path'), f).toBeTruthy();
    }
  });

  it('the public installer carries the block when it is the only variant', () => {
    // GitHub: this file is the whole tree. Internal: it may lag until sync.
    if (!present.includes('installer.ps1') && present.includes('installer-opensource.ps1')) {
      expect(blockOf(read('installer-opensource.ps1'), 'pilot-short-path')).toBeTruthy();
    }
  });

  it('all variants that carry the helper share one byte-identical block', () => {
    // Three copies of the same reasoning is how the bare Remove-Item survived in the
    // first place. One implementation, or the next fix reaches only one file.
    expect(withBlock.length).toBeGreaterThan(0);
    const blocks = withBlock.map(f => blockOf(read(f), 'pilot-short-path'));
    expect(new Set(blocks).size).toBe(1);
  });

  for (const f of withBlock) {
    const ps1 = read(f);

    it(`${f} normalises short paths through Get-Item .FullName`, () => {
      const fn = functionOf(ps1, 'Get-PilotLongPath');
      expect(fn, 'Get-PilotLongPath must exist').not.toBe('');
      expect(fn).toContain('Get-Item -LiteralPath $Path -Force -ErrorAction Stop');
      expect(fn).toContain('$item.FullName');
      // A Move-Item destination does not exist yet; only an existing directory can
      // carry a short name, so the parent has to be expanded instead of giving up.
      expect(fn).toContain('Split-Path -Parent $Path');
      expect(fn).toContain('$parentItem.FullName');
      // Measured non-fixes. Keeping them out is the point of the helper.
      expect(fn).not.toMatch(/Convert-Path|Resolve-Path/);
      // CLM/WDAC: a property read off the DirectoryInfo is allowed, a type call is not.
      expect(fn).not.toMatch(/\[(System\.)?IO\.|New-Object|Add-Type/);
    });

    it(`${f} cleanup deletes cannot raise`, () => {
      const fn = functionOf(ps1, 'Remove-PilotPathQuietly');
      expect(fn, 'Remove-PilotPathQuietly must exist').not.toBe('');
      expect(fn).toContain('Remove-Item -LiteralPath (Get-PilotLongPath $Path) -Recurse -Force -ErrorAction SilentlyContinue');
      // -ErrorAction covers the non-terminating half (a file a scanner holds open); the
      // catch covers the binding failure, which -ErrorAction cannot reach.
      expect(fn).toMatch(/try \{[\s\S]*\} catch \{/);
    });

    it(`${f} deletes nothing on disk from inside a finally`, () => {
      // A throw here replaces the exception in flight, so the caller never learns why
      // it failed and, under $ErrorActionPreference = "Stop", the run aborts. Env:
      // entries are in-process and cannot be short, so they stay allowed.
      const offenders = [];
      for (const body of finallyBodies(ps1)) {
        for (const line of body.split('\n')) {
          if (!/\b(Remove-Item|Move-Item)\b/.test(line)) continue;
          if (/\bEnv:/.test(line)) continue;
          offenders.push(line.trim());
        }
      }
      expect(offenders, 'use Remove-PilotPathQuietly').toEqual([]);
    });

    it(`${f} never hands a possibly-short path to Remove-Item or Move-Item raw`, () => {
      const sites = hazardSites(ps1);
      // Non-vacuity: the temp-root taint has to actually reach the cleanup sites. Six
      // of them today -- two staging dirs, the staged node_modules move, both command
      // finallys and the npm log.
      expect(sites.length).toBeGreaterThanOrEqual(4);
      const offenders = sites
        .filter(({ line }) => !/Get-PilotLongPath|Remove-PilotPathQuietly/.test(line))
        .map(({ n, line }) => `${n}: ${line}`);
      expect(offenders, 'wrap in Get-PilotLongPath or call Remove-PilotPathQuietly').toEqual([]);
    });

    it(`${f} keeps no bare best-effort recursive delete`, () => {
      // `Remove-Item $x -Recurse -Force -ErrorAction SilentlyContinue` is the exact
      // shape that failed: it reads as "cannot fail" and is not.
      const offenders = stripHereStrings(ps1)
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => !/^\s*#/.test(line))
        .filter(([, line]) => /Remove-Item\s+[^-\n]/.test(line) && /-Recurse/.test(line) && /SilentlyContinue/.test(line))
        .map(([n, line]) => `${n}: ${line.trim()}`);
      expect(offenders, 'use Remove-PilotPathQuietly').toEqual([]);
    });

    it(`${f} Get-PilotAsciiTempRoot expands an ASCII 8.3 TEMP`, () => {
      const fn = functionOf(ps1, 'Get-PilotAsciiTempRoot');
      expect(fn, 'Get-PilotAsciiTempRoot must exist').not.toBe('');
      // Pure-ASCII 8.3 TEMP used to skip expand because the charset check passed.
      // Both the early return and the nothing-writable fallback start from that
      // same $root, so both must expand.
      const hits = fn.match(/Get-PilotLongPath \$root/g) || [];
      expect(hits.length).toBeGreaterThanOrEqual(2);
    });

    if (f !== 'installer-opensource.ps1') {
      it(`${f} 7-Zip fallback cleans the intermediate .tar quietly`, () => {
        const fn = functionOf(ps1, 'Download-AndExtract');
        expect(fn, 'Download-AndExtract must exist').not.toBe('');
        expect(fn).toMatch(/Remove-PilotPathQuietly \$(?:tarFile|tarPath)/);
        const bare = fn.split('\n')
          .filter((line) => !/^\s*#/.test(line))
          .filter((line) => /\bRemove-Item\b/.test(line) && /\$(?:tarFile|tarPath)\b/.test(line));
        expect(bare, 'intermediate .tar delete must go through Remove-PilotPathQuietly').toEqual([]);
      });
    }
  }
});
