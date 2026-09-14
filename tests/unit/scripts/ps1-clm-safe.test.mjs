// Static CLM (Constrained Language Mode) guard for every tracked .ps1.
//
// Some machines that run these scripts have a WDAC / AppLocker application-control
// policy, so any .ps1 the policy does not allow executes in ConstrainedLanguage
// Mode. Under CLM only "core types" may be cast or have their *methods* invoked;
// a method call on any other .NET type throws. Static *property gets* are exempt —
// CLM permits those on any type.
//
// Combined with `$ErrorActionPreference = "Stop"` (installers) or the fail-open
// `catch` every hook wraps its body in, an unguarded CLM violation is either a
// terminating error that aborts the install or silence that drops telemetry on
// precisely the locked-down machines where the error log matters. A real install
// died this way on `[pscustomobject]@{...}`: the accelerator's true conversion
// target is the internal type `LanguagePrimitives+InternalPSCustomObject`, which is
// not in Windows PowerShell 5.1's CoreTypes list even though `about_Language_Modes`
// documents `[pscustomobject]` as allowed. The documented allow-list is NOT
// authoritative for 5.1 — only a run on a WDAC box is.
//
// So: structured data in a .ps1 uses a plain `[hashtable]`, paths are inspected with
// language operators and cmdlets (`Split-Path`, `-match`, `Test-Path`) rather than
// `[System.IO.Path]::`, and anything with no CLM-safe substitute is wrapped in
// `try { } catch { }` with a working fallback in the catch.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// .ps1 files that still violate the rules below. Shrink this list, never grow it —
// a new .ps1 must be CLM-safe from the start. Each entry is reverse-asserted, so
// cleaning a file forces its removal from here. Entries for files this repo does
// not track are simply never visited, which keeps the list valid downstream where
// the same file set is larger.
//   * installer-opensource.ps1 — [pscustomobject]/[ordered]/.PSObject plus
//     [System.IO.Directory|File]:: method calls; tracked as its own change.
//   * create-new-feature.ps1 / git-common.ps1 — dev tooling, never shipped to a
//     user machine ([PSCustomObject], [Math]::, [Console]::Error.WriteLine()).
const KNOWN_CLM_UNSAFE = new Set([
  'deploy/installer-opensource.ps1',
  '.specify/extensions/git/scripts/powershell/create-new-feature.ps1',
  '.specify/extensions/git/scripts/powershell/git-common.ps1',
]);

// Every .NET static member access that is allowed to remain across all tracked
// .ps1. Adding an entry means you confirmed one of:
//   (a) it is a property *get* — CLM permits those on any type; or
//   (b) it is a core type ([datetime], [TimeSpan], ...); or
//   (c) the call sits inside a try block whose catch is a working fallback.
// Nothing qualifies just because about_Language_Modes lists it (see header).
const ALLOWED_STATIC_ACCESS = new Set([
  '[Console]::IsInputRedirected',                 // (a) property get; every hook
  '[Console]::IsOutputRedirected',                // (a) property get; Test-Interactive
  '[Environment]::UserInteractive',               // (c) Test-Interactive, in try/catch
  '[Net.ServicePointManager]::SecurityProtocol',  // (c) TLS1.2 bump before a download
  '[Net.SecurityProtocolType]::Tls12',            // (c) TLS1.2 bump before a download
  '[Environment]::SetEnvironmentVariable',        // (c) PATH broadcast on install
  '[datetime]::MinValue',                         // (b) core type; scripts/loongsuite-pilot.ps1
  '[TimeSpan]::Zero',                             // (b) core type; scripts/loongsuite-pilot.ps1
  // (c) UTF-8 bump for both console directions at script load, in try/catch. The catch
  // is a no-op on purpose: the fallback is 5.1's ASCII $OutputEncoding / ANSI stdout
  // decoding, which is why the config payloads are staged through a UTF-8 file rather
  // than piped -- see tests/unit/scripts/ps1-json-encoding.test.mjs.
  '[Console]::OutputEncoding',
  '[System.Text.Encoding]::UTF8',
  // (c) Test-PilotElevated, in try/catch. GetCurrent() is a static *method* call and so
  // is genuinely CLM-forbidden; the catch returns $false, which only costs the elevated
  // install warning -- see the pilot-elevation-warning block. Administrator is an enum
  // field read, i.e. (a) as well.
  '[Security.Principal.WindowsIdentity]::GetCurrent',
  '[Security.Principal.WindowsBuiltInRole]::Administrator',
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

// Drop whole-line comments so the assertions below only see executable code. The
// comments explaining each rewrite necessarily name the API they replaced.
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

const tracked = execFileSync('git', ['ls-files', '*.ps1'], { encoding: 'utf-8' })
  .split('\n')
  .filter(Boolean);

describe('every tracked .ps1 stays CLM-safe', () => {
  it('finds .ps1 files to check', () => {
    // Guards against a silently empty sweep (wrong cwd, glob change).
    expect(tracked.length).toBeGreaterThan(10);
    expect(tracked).toContain('scripts/loongsuite-pilot.ps1');
    expect(tracked.filter(f => f.startsWith('assets/hooks/')).length).toBeGreaterThan(5);
  });

  for (const file of tracked) {
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
});

describe('the CLM-safe rewrites stay in place', () => {
  // The two shapes that actually broke on a WDAC box, pinned at their call sites so
  // a refactor cannot quietly reintroduce them while the sweep above still passes
  // (both substitutes are invisible to a shape/static match).
  it('hooks probe for a file extension with -match, not [System.IO.Path]', () => {
    for (const file of tracked.filter(f => f.startsWith('assets/hooks/'))) {
      const code = codeOf(readFileSync(file, 'utf-8'));
      if (!/function Convert-NodePath/.test(code)) continue;
      expect(code).not.toContain('HasExtension');
      expect(code).toMatch(/-match '\\\.\[\^\\\\\/\.\]\+\$'/);
    }
  });

  it('the CLI wrapper prunes state with Select-Object, not $state.PSObject', () => {
    // PSMemberInfoCollection is not a core type, so .Properties.Remove() throws under
    // CLM and the rollback would leave a stale hermes-agent entry behind.
    const cli = codeOf(readFileSync('scripts/loongsuite-pilot.ps1', 'utf-8'));
    expect(cli).toMatch(/Select-Object -Property \* -ExcludeProperty 'hermes-agent'/);
    // -Property * is required alongside -ExcludeProperty on PowerShell 5.1.
    expect(cli).not.toMatch(/Select-Object -ExcludeProperty/);
  });

  it('the public installer checks bound parameters without ContainsKey', () => {
    // installer-opensource.ps1 is still in KNOWN_CLM_UNSAFE for older violations,
    // so pin this top-level check separately: it runs for every subcommand.
    const installer = codeOf(readFileSync('deploy/installer-opensource.ps1', 'utf-8'));
    expect(installer).toContain("$PSBoundParameters.Keys -contains 'DashboardPort'");
    expect(installer).not.toMatch(/\$PSBoundParameters\.ContainsKey\(/);
  });

  it('the CLI wrapper validates an absolute path with a regex, not IsPathRooted', () => {
    const cli = codeOf(readFileSync('scripts/loongsuite-pilot.ps1', 'utf-8'));
    expect(cli).not.toContain('IsPathRooted');
    // Drive-absolute (C:\ or C:/) or UNC (\\server\share). Deliberately narrower
    // than IsPathRooted, which also accepts the drive-relative "C:dir" and
    // root-relative "\dir" forms — neither is safe as an absolute delete target.
    expect(cli).toMatch(/\^\(\[A-Za-z\]:\[\\\\\/\]\|\\\\\\\\\[\^\\\\\/\]\+\[\\\\\/\]\)/);
  });
});
