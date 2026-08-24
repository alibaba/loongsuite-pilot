// Every JSON file exchanged between a .ps1 and the node side must be read and
// written with an explicit -Encoding UTF8.
//
// On Windows PowerShell 5.1, Set-Content / Add-Content / Get-Content default to the
// *ANSI codepage* (GBK/936 on Chinese Windows), while node reads and writes these
// files as UTF-8 (src/utils/fs-utils.ts). Without -Encoding UTF8 a non-ASCII value
// — a targetDir under `C:\Users\张三\` is the realistic case — round-trips as
// mojibake, and the plugin at that path silently goes uncleaned on rollback.
//
// The paired half of this rule lives on the node side: 5.1 has no `utf8NoBOM`, so
// `-Encoding UTF8` always emits a BOM, and `JSON.parse` rejects a leading BOM.
// readJsonFile() swallows parse errors and returns null, which callers read as
// "file absent" — so a BOM alone would reset deployment state to empty instead of
// failing loudly. readJsonFile() therefore strips it; see
// tests/unit/utils/fs-utils.test.ts. Fixing only one side is worse than fixing
// neither.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// Files not converted yet. Shrink, never grow; each entry is reverse-asserted. An
// entry for a file this repo does not track is simply never visited, which keeps the
// list valid downstream where the same file set is larger.
const KNOWN_UNENCODED = new Set([
  'deploy/installer-opensource.ps1', // rollback state/marker reads, tracked separately
]);

// The internal installer variant. Two assertions below are specific to it, so they
// stand down where it is not part of the tree.
const INNER = 'deploy/installer-inner.ps1';

const tracked = execFileSync('git', ['ls-files', '*.ps1'], { encoding: 'utf-8' })
  .split('\n')
  .filter(Boolean);

const codeLines = (text) => text
  .split('\n')
  .map((line, i) => [i + 1, line])
  .filter(([, line]) => !/^\s*#/.test(line));

// Variables holding a path that ends in .json/.jsonl. Needed because matching only
// on ConvertTo-Json/ConvertFrom-Json misses the hand-rolled case: the four hook
// Log-Error helpers build their JSONL line by string interpolation and contain no
// ConvertTo-Json anywhere, so a converter-keyed rule stayed silent while all four
// appended to a .jsonl with the ANSI codepage. Keying off the *target path* catches
// them regardless of how the JSON text was produced.
const jsonPathVars = (lines) => {
  const vars = new Set();
  for (const [, line] of lines) {
    const m = line.match(/\$(?:script:)?([A-Za-z_]\w*)\s*=\s*[^=].*\.jsonl?["']/);
    if (m) vars.add(m[1]);
  }
  return vars;
};

// A line is a JSON interchange site when it converts to or from JSON while touching
// a file, or when a file cmdlet touches a known .json/.jsonl path. Pipelines in this
// repo are written on one line, so per-line matching is sufficient and keeps the rule
// easy to read at the call site.
const interchangeSites = (text) => {
  const lines = codeLines(text);
  const vars = [...jsonPathVars(lines)];
  const touchesJsonPath = (line) =>
    /\b(Get-Content|Set-Content|Add-Content|Out-File)\b/.test(line)
    && vars.some(v => new RegExp(`\\$(?:script:)?${v}\\b`).test(line));

  return lines.filter(([, line]) => (
    (/\bGet-Content\b/.test(line) && /\bConvertFrom-Json\b/.test(line))
    || (/\bConvertTo-Json\b/.test(line) && /\b(Set-Content|Add-Content|Out-File)\b/.test(line))
    || touchesJsonPath(line)
  ));
};

// The node half of the same boundary. Every `readFileSync` whose result is handed to
// JSON.parse must strip a leading BOM, because `-Encoding UTF8` on 5.1 always writes
// one and JSON.parse rejects it. Scoped to JSON.parse deliberately: a bare
// readFileSync is *not* required to strip — installer-inner.ps1 filters the user's
// ~/.codex/config.toml line by line and writes it straight back, so stripping there
// would silently rewrite someone else's file. A plain count comparison
// (`readFileSync count == replace count`) would demand exactly that.
const jsonParseReads = (text) => codeLines(text)
  .filter(([, line]) => /\bJSON\.parse\b/.test(line) && /\breadFileSync\b/.test(line));

// The third direction of the same boundary: JSON handed to an embedded node payload
// through a *pipe* instead of a file. PowerShell 5.1 encodes a string piped to a native
// command with $OutputEncoding, whose default is ASCII, so `$cfgJson | & node -e ...`
// replaced every non-ASCII character with a literal "?" before node could parse it. With
// a Chinese username that turned dataDir into C:\Users\???\.loongsuite-pilot and the
// install died in writeFileSync with ENOENT. Set-Content -Encoding UTF8 staging is the
// fix; unlike an $OutputEncoding assignment it keeps working under CLM/WDAC, where a
// .NET static assignment throws and the try/catch degrades to a no-op.
const convertToJsonVars = (lines) => {
  const vars = new Set();
  for (const [, line] of lines) {
    const m = line.match(/\$(?:script:)?([A-Za-z_]\w*)\s*=.*\|\s*ConvertTo-Json\b/);
    if (m) vars.add(m[1]);
  }
  return vars;
};

const pipedJsonToNode = (text) => {
  const lines = codeLines(text);
  const vars = [...convertToJsonVars(lines)];
  if (vars.length === 0) return [];
  return lines.filter(([, line]) => (
    /\|\s*&\s*\$(?:script:)?NODE_BIN\b/.test(line)
    && vars.some(v => new RegExp(`\\$(?:script:)?${v}\\s*\\|`).test(line))
  ));
};

// Every installer variant stages its config payload instead of piping it, so all three are
// checked -- the open-source one included, and it is the only one of them present in the
// open-source tree, where the two internal entries skip and the rule would otherwise go
// unchecked entirely. The floor differs because the internal variants run this shape twice
// (install and reconfigure), the open-source one once.
const STAGED_VARIANTS = [
  ['deploy/installer.ps1', 2],
  ['deploy/installer-inner.ps1', 2],
  ['deploy/installer-opensource.ps1', 1],
];

// $OutputEncoding is bumped only by the internal variants. The open-source one deliberately
// does NOT: its ad-hoc PROBE_RESULT pipes do not strip a BOM and would break if one appeared.
const OUTPUT_ENCODING_VARIANTS = ['deploy/installer.ps1', 'deploy/installer-inner.ps1'];

describe('ps1 <-> node JSON interchange is explicitly UTF-8', () => {
  it('finds interchange sites to check', () => {
    // Guards against the regex silently matching nothing (renamed cmdlet, reflow).
    const total = tracked.reduce(
      (n, f) => n + interchangeSites(readFileSync(f, 'utf-8')).length, 0);
    expect(total).toBeGreaterThanOrEqual(6);
  });

  for (const file of tracked) {
    const sites = interchangeSites(readFileSync(file, 'utf-8'));
    if (sites.length === 0) continue;
    const expectClean = !KNOWN_UNENCODED.has(file);
    it(`${file} ${expectClean ? 'passes -Encoding UTF8 at every site' : '(known unencoded)'}`, () => {
      const bare = sites
        .filter(([, line]) => !/-Encoding\s+UTF8\b/.test(line))
        .map(([n, line]) => `${n}: ${line.trim()}`);
      if (expectClean) {
        expect(bare).toEqual([]);
      } else {
        expect(bare.length).toBeGreaterThan(0);
      }
    });
  }

  it('catches a hand-rolled JSONL write that never calls ConvertTo-Json', () => {
    // Pins the blind spot itself, not just its symptom: the hook Log-Error helpers
    // are the shape that escaped the converter-keyed rule. If someone reverts the
    // matcher to converters only, this fails even when the hooks stay correct.
    const hook = readFileSync('assets/hooks/shared/common.ps1', 'utf-8');
    expect(hook).not.toMatch(/\bConvertTo-Json\b/);
    const sites = interchangeSites(hook).map(([, l]) => l.trim());
    expect(sites.some(l => /\bAdd-Content\b/.test(l))).toBe(true);
  });

  it('every embedded-node readFileSync feeding JSON.parse strips the BOM', () => {
    const bare = [];
    let total = 0;
    for (const file of tracked) {
      if (KNOWN_UNENCODED.has(file)) continue;
      for (const [n, line] of jsonParseReads(readFileSync(file, 'utf-8'))) {
        total += 1;
        if (!/\.replace\(\/\^\\uFEFF\//.test(line)) bare.push(`${file}:${n}: ${line.trim()}`);
      }
    }
    // Guards against the matcher silently matching nothing. The floor here is the
    // span-attr payload in scripts/loongsuite-pilot.ps1; the internal installer
    // variants carry ~15 more sites wherever they are part of the tree.
    expect(total).toBeGreaterThanOrEqual(existsSync(INNER) ? 15 : 1);
    expect(bare).toEqual([]);
  });

  it.skipIf(!existsSync(INNER))('leaves the codex config.toml read unstripped', () => {
    // The exclusion above is load-bearing, so assert it directly: this read filters
    // the user's TOML and writes it back, and a BOM strip would silently alter a file
    // we do not own. If it ever becomes a JSON.parse, the previous test takes over.
    const inner = readFileSync(INNER, 'utf-8');
    const toml = codeLines(inner).filter(([, l]) =>
      /\breadFileSync\b/.test(l) && !/\bJSON\.parse\b/.test(l));
    expect(toml.length).toBe(1);
    expect(toml[0][1]).toContain("split('\\n')");
    expect(toml[0][1]).not.toContain('uFEFF');
  });

  it('no tracked .ps1 pipes a ConvertTo-Json payload into node', () => {
    const offenders = [];
    for (const file of tracked) {
      for (const [n, line] of pipedJsonToNode(readFileSync(file, 'utf-8'))) {
        offenders.push(`${file}:${n}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the pipe matcher still recognises the shape it bans', () => {
    // Pins the rule rather than the current state: once every site is staged the
    // assertion above passes vacuously, so a regressed matcher would look clean.
    const sample = [
      '    $cfgJson = $cfgArgs | ConvertTo-Json -Compress',
      "    $cfgJson | & $script:NODE_BIN -e @'",
    ].join('\n');
    expect(pipedJsonToNode(sample)).toHaveLength(1);
    // A pipe of something that never came from ConvertTo-Json is out of scope.
    expect(pipedJsonToNode("    $other | & $script:NODE_BIN -e @'")).toEqual([]);
  });

  for (const [file, floor] of STAGED_VARIANTS) {
    it.skipIf(!existsSync(file))(`${file} stages every config payload as a UTF-8 file`, () => {
      const text = readFileSync(file, 'utf-8');
      const staged = text.match(
        /Set-Content -LiteralPath \$cfgTmp -Value \$cfgJson -Encoding UTF8 -NoNewline/g) || [];
      // Each staged payload must be handed to node as argv[1] and then deleted: it
      // carries the SLS AccessKeySecret and the CMS license key.
      const consumed = text.match(/^'@ \$cfgTmp$/gm) || [];
      const removed = text.match(
        /Remove-Item -LiteralPath \$cfgTmp -Force -ErrorAction SilentlyContinue/g) || [];
      expect(staged.length).toBeGreaterThanOrEqual(floor);
      expect(consumed.length).toBe(staged.length);
      expect(removed.length).toBe(staged.length);
    });
  }

  for (const file of OUTPUT_ENCODING_VARIANTS) {
    it.skipIf(!existsSync(file))(`${file} bumps $OutputEncoding to UTF-8 in a try/catch`, () => {
      // Belt to the staging braces: it also covers the ad-hoc PROBE_RESULT pipes, which
      // stay on stdin. CLM makes both assignments throw, so the catch must be present
      // and must not rethrow.
      expect(readFileSync(file, 'utf-8')).toMatch(
        /try \{\n\s*\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8\n\s*\$OutputEncoding = \[System\.Text\.Encoding\]::UTF8\n\} catch \{\}/);
    });
  }

  it('the hermes rollback path reads and writes deployed-agents.json as UTF-8', () => {
    // Named explicitly because this is the site the CR flagged: the write alone was
    // reported, but Get-Content without -Encoding also falls back to ANSI when there
    // is no BOM to sniff, so the read direction needed the same fix.
    const cli = readFileSync('scripts/loongsuite-pilot.ps1', 'utf-8');
    const fn = cli.slice(cli.indexOf('function Remove-HermesPluginForRollback'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/\$state = Get-Content \$stateFile -Raw -Encoding UTF8/);
    expect(body).toMatch(/\$meta = Get-Content \$marker -Raw -Encoding UTF8/);
    expect(body).toMatch(/ConvertTo-Json -Depth 20 \| Set-Content \$tmp -Encoding UTF8/);
  });
});
