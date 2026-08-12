// Static CLM (Constrained Language Mode) guard for the .ps1 files that exist only
// in this repo.
//
// The validation machines run WDAC application-control policy, so any .ps1 not
// allowed by the policy executes in ConstrainedLanguage Mode. Combined with
// `$ErrorActionPreference = "Stop"` (installers) or a fail-open `catch` (hooks),
// an unguarded CLM violation is either a terminating error that aborts the install
// or silence that drops telemetry — that is exactly how `[pscustomobject]@{...}`
// crashed a real install right after "==> 检查依赖...".
//
// Scope: INTERNAL_ONLY below — the two installer variants, the Qoder plugin's
// ensure-pilot.ps1, and .specify dev tooling. The shared .ps1 (assets/hooks/*,
// scripts/loongsuite-pilot.ps1, installer-opensource.ps1) are guarded by the
// open-source repo's tests/unit/scripts/ps1-{clm-safe,comments-ascii,json-encoding}
// .test.mjs, which sweep `git ls-files '*.ps1'` and therefore cover the files here
// too once the sync lands. This file stays because the installers never leave this
// repo, and because the internal set needs a guard *before* that sync arrives.
//
// The prose rule lives in AGENTS.md ("PowerShell (.ps1) 硬约束") with the full
// argument in deploy/installer.ps1's header block; individual .ps1 files do not
// repeat it. The last assertion here pins that AGENTS.md section so the rule
// cannot quietly disappear.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PS1_VARIANTS = ['installer.ps1', 'installer-inner.ps1'];

// Present in this repo but not in the open-source mirror, so no synced ratchet
// covers them before the next sync. Path-prefix based rather than a hardcoded
// list so a new internal .ps1 is picked up automatically.
const isInternalOnly = (f) => (
  f.startsWith('.specify/')
  || f.startsWith('app/')
  || f === 'deploy/installer.ps1'
  || f === 'deploy/installer-inner.ps1'
);

// .ps1 files that still violate the rules below. Shrink this list, never grow it —
// a new .ps1 must be CLM-safe from the start. Each entry is reverse-asserted, so
// cleaning a file forces its removal from here.
//   * create-new-feature.ps1 / git-common.ps1 — .specify dev tooling, never
//     shipped to a user machine ([PSCustomObject], [Math]::, [Console]::Error.WriteLine()).
const KNOWN_CLM_UNSAFE = new Set([
  '.specify/extensions/git/scripts/powershell/create-new-feature.ps1',
  '.specify/extensions/git/scripts/powershell/git-common.ps1',
]);

// Same ratchet for ASCII-only comments: a BOM-less .ps1 decodes with the ANSI
// codepage on 5.1, and `irm <url> | iex` decodes per the HTTP charset and never
// looks at a BOM, so non-ASCII comment bytes can carry a quote and take the parser
// with them. Bilingual *output* strings (Msg / Write-Host) stay exempt.
const KNOWN_NON_ASCII_COMMENTS = new Set([
  '.specify/extensions/git/scripts/powershell/auto-commit.ps1',
  '.specify/extensions/git/scripts/powershell/git-common.ps1',
  '.specify/extensions/git/scripts/powershell/initialize-repo.ps1',
]);

// Every .NET static member access that is allowed to remain across the internal
// .ps1. Adding an entry means you confirmed one of:
//   (a) it is a property *get* — CLM permits those on any type; or
//   (b) it is a core type ([datetime], [TimeSpan], ...); or
//   (c) the call sits inside a try block whose catch is a working fallback.
// See AGENTS.md and the CLM block in deploy/installer.ps1 — notably that
// about_Language_Modes' allowed-types list is NOT authoritative for PowerShell 5.1.
const ALLOWED_STATIC_ACCESS = new Set([
  '[Environment]::UserInteractive',               // (c) Test-Interactive, in try/catch
  '[Console]::IsInputRedirected',                 // (a) property get; installers + all hooks
  '[Console]::IsOutputRedirected',                // (a) property get; Test-Interactive
  '[Net.ServicePointManager]::SecurityProtocol',  // (c) TLS1.2 bump in Download-AndExtract
  '[Net.SecurityProtocolType]::Tls12',            // (c) TLS1.2 bump in Download-AndExtract
  '[Environment]::SetEnvironmentVariable',        // (c) PATH broadcast in Install-Command
]);

// Shapes that are never acceptable, whatever the file. `.PSObject` is included
// because its member-removal form is a method call on a non-core type; the CLM-safe
// substitute is `Select-Object -Property * -ExcludeProperty k`.
const BANNED_SHAPES = [
  [/\[pscustomobject\]/i, '[pscustomobject] (throws ConversionSupportedOnlyToCoreTypes on 5.1)'],
  [/\[ordered\]/, '[ordered]'],
  [/\bNew-Object\b/, 'New-Object'],
  [/\bAdd-Type\b/, 'Add-Type'],
  [/\bInvoke-Expression\b/, 'Invoke-Expression'],
  [/\.PSObject\b/, '.PSObject member access'],
  [/\bContainsKey\b/, '.ContainsKey() (use `.Keys -contains`)'],
  [/^\s*(class|enum)\s+\w+/m, 'class/enum declaration'],
];

// Drop whole-line comments so the assertions below only see executable code.
const codeOf = (text) => text
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .join('\n');

const staticsIn = (code) => [...new Set(
  code.match(/\[[A-Za-z_][A-Za-z0-9_.]*\]::[A-Za-z_][A-Za-z0-9_]*/g) || []
)];

const violationsIn = (code) => [
  ...BANNED_SHAPES.filter(([re]) => re.test(code)).map(([, label]) => label),
  ...staticsIn(code).filter(m => !ALLOWED_STATIC_ACCESS.has(m)),
];

const internal = execFileSync('git', ['ls-files', '*.ps1'], { encoding: 'utf-8' })
  .split('\n')
  .filter(Boolean)
  .filter(isInternalOnly);

const commentOffenders = (text) => text
  .replace(/^﻿/, '')
  .split('\n')
  .map((line, i) => [i + 1, line])
  .filter(([, line]) => /^\s*#/.test(line) && /[^\x00-\x7F]/.test(line));

describe('every internal-only .ps1 stays CLM-safe', () => {
  it('finds .ps1 files to check', () => {
    // Guards against a silently empty sweep (wrong cwd, glob change, or the
    // prefix predicate drifting away from where these files actually live).
    expect(internal).toContain('deploy/installer.ps1');
    expect(internal).toContain('deploy/installer-inner.ps1');
    expect(internal).toContain(
      'app/qoder-plugin/loongsuite-pilot-installer/scripts/ensure-pilot.ps1');
    expect(internal.length).toBeGreaterThan(5);
  });

  for (const file of internal) {
    const expectClean = !KNOWN_CLM_UNSAFE.has(file);
    it(`${file} ${expectClean ? 'is CLM-safe' : '(known CLM-unsafe)'}`, () => {
      const found = violationsIn(codeOf(readFileSync(file, 'utf-8')));
      if (expectClean) {
        // A failure naming a static is not automatically a bug: it means a new
        // .NET static access appeared and someone must confirm (a)/(b)/(c) above
        // before adding it to ALLOWED_STATIC_ACCESS.
        expect(found).toEqual([]);
      } else {
        // Ratchet: once a file is cleaned, drop it from KNOWN_CLM_UNSAFE so the
        // assertion above starts protecting it.
        expect(found.length).toBeGreaterThan(0);
      }
    });
  }

  for (const file of internal) {
    const expectClean = !KNOWN_NON_ASCII_COMMENTS.has(file);
    it(`${file} ${expectClean ? 'has ASCII-only comments' : '(known non-ASCII comments)'}`, () => {
      const offenders = commentOffenders(readFileSync(file, 'utf-8'));
      if (expectClean) {
        expect(offenders).toEqual([]);
      } else {
        expect(offenders.length).toBeGreaterThan(0);
      }
    });
  }
});

describe('windows installers stay CLM-safe', () => {
  for (const f of PS1_VARIANTS) {
    const present = existsSync(resolve('deploy', f));
    const raw = present ? readFileSync(resolve('deploy', f), 'utf-8') : '';
    const code = codeOf(raw);

    it.skipIf(!present)(`${f} carries the authoritative CLM constraint header`, () => {
      // These two files hold the full argument; every other .ps1 defers to
      // AGENTS.md, which points here.
      const header = raw.slice(0, raw.indexOf('[CmdletBinding()]'));
      expect(header).toContain('ConstrainedLanguage');
      expect(header).toContain('WDAC');
      // The lesson that cost a real install: the docs' allowed-types list is not
      // the 5.1 CoreTypes whitelist.
      expect(header).toContain('ConversionSupportedOnlyToCoreTypes');
    });

    it.skipIf(!present)(`${f} resolves the temp root via Get-PilotTempRoot, not [System.IO.Path]`, () => {
      expect(code).toMatch(/function Get-PilotTempRoot \{/);
      expect(code).not.toContain('GetTempPath');
      // No raw $env:TEMP joins left: an empty TEMP makes Join-Path throw.
      expect(code).not.toMatch(/Join-Path \$env:TEMP\b/);
    });

    it.skipIf(!present)(`${f} creates the download temp dir inside try so failures degrade`, () => {
      // New-Item must sit *inside* the try: outside it, an unwritable temp root
      // becomes a terminating error under $EAP=Stop and skips the managed-node /
      // node_modules fallbacks (the latter fires after Deploy-Package, i.e.
      // "deployed but no dependencies").
      const guarded = code.match(/\$tmp = Join-Path \(Get-PilotTempRoot\)[^\n]*\n\s*try \{/g) || [];
      expect(guarded.length).toBe(2);
      expect(code).not.toMatch(/New-Item -ItemType Directory -Path \$tmp[^\n]*\n\s*try \{/);
    });

    it.skipIf(!present)(`${f} probes bound parameters without invoking a method`, () => {
      // $PSBoundParameters is a PSBoundParametersDictionary (a Dictionary<string,object>
      // subclass), not a hashtable, so .ContainsKey() is a method invocation on an
      // off-list type. `$PSBoundParameters.Keys -contains "X"` is a property *get*
      // (CLM allows those on any type) plus a language operator, and is semantically
      // identical — both are case-insensitive. Keep the truthiness rewrite off the
      // table: the *_SET flags must distinguish "-CmsEndpoint ''" (clear the field)
      // from an absent parameter.
      const calls = code.match(/\$PSBoundParameters\.[A-Za-z_][A-Za-z0-9_]*\s*\(/g) || [];
      expect(calls).toEqual([]);
    });

    it.skipIf(!present)(`${f} parses SHASUMS256.txt with language operators only`, () => {
      const start = code.indexOf('function Test-ManagedNodeChecksum {');
      expect(start).toBeGreaterThan(-1);
      const body = code.slice(start, code.indexOf('\n}', start));
      expect(body).not.toContain('[regex]::');
      expect(body).toContain("-split '\\s+'");
      // Filename is compared exactly rather than through a regex fragment.
      expect(body).toMatch(/-ne \$Name/);
      expect(body).toMatch(/\$hash\.Length -ne 64/);
      expect(body).toMatch(/\$hash -notmatch '\^\[0-9a-fA-F\]\+\$'/);
    });
  }
});

describe('the CLM rule is documented centrally', () => {
  // Per-file header blocks were dropped in favour of one authoritative section, so
  // that section is now the only prose copy of the rule. If it is deleted or
  // renamed, this fails rather than leaving the ratchet unexplained.
  it('AGENTS.md states the .ps1 CLM constraint', () => {
    const agents = readFileSync('AGENTS.md', 'utf-8');
    expect(agents).toContain('PowerShell (.ps1) 硬约束');
    expect(agents).toContain('ConstrainedLanguage');
    expect(agents).toContain('WDAC');
    expect(agents).toContain('ConversionSupportedOnlyToCoreTypes');
    // The substitution table and the enforcement pointers must survive too.
    expect(agents).toContain('Select-Object -Property * -ExcludeProperty');
    expect(agents).toContain('tests/unit/deploy/installer-ps1-clm-safe.test.mjs');
  });
});
