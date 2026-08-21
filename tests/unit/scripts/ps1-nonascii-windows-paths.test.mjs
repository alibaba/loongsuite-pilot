// A Windows account name can be non-ASCII (C:\Users\张三 is the case that broke a
// real install), and PowerShell 5.1 loses those characters at three boundaries. Each
// one silently produced a working-looking install that was not working:
//
//   1. Native command *stdout* is decoded with [Console]::OutputEncoding, i.e. the
//      console codepage (437 on an en-US box), so `whoami` returned "host\??" with
//      literal U+003F characters. That string reached New-ScheduledTaskPrincipal
//      -UserId, Task Scheduler failed the registration with "No mapping between
//      account names and security IDs was done" (0x80131500), and the user ended up
//      with no autostart task at all. It also collapsed every non-ASCII account to
//      the same "___" task-name tag, so two such users fought over one task name.
//   2. Native command *arguments* survive as UTF-16 through CreateProcessW, but
//      bsdtar (%SystemRoot%\System32\tar.exe) enters through the ANSI CRT and
//      converts them back through the ANSI codepage, so a staging dir under a
//      non-ASCII %TEMP% reached tar as "?" and extraction failed. Neither
//      [Console]::OutputEncoding nor `chcp 65001` changes this (measured).
//   3. Get-Content / Set-Content default to the ANSI codepage, so the node-bin pin
//      file -- one absolute path, possibly under a non-ASCII %USERPROFILE% -- was
//      written as "C:\Users\??.HOST\..." and every reader then silently fell back to
//      some other node.exe, on a shared machine another account's nvm install.
//
// The reasoning above is the rule; this file is the ratchet. Directions 1 and 3
// have exact substitutes, so they are asserted across every tracked .ps1 with no
// allowlist. Direction 2 is asserted per function: whatever staging dir a tar call
// sees must come from Get-PilotAsciiTempRoot.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const SERVICE = 'scripts/loongsuite-pilot.ps1';
// Every .ps1 that names a scheduled task, and therefore needs the shared identity
// helpers. Registration and uninstall must derive the tag the same way or uninstall
// leaves the tasks behind.
const TASK_FILES = [
  SERVICE,
  'deploy/installer.ps1',
  'deploy/installer-inner.ps1',
  'deploy/installer-opensource.ps1',
];

const tracked = execFileSync('git', ['ls-files', '*.ps1'], { encoding: 'utf-8' })
  .split('\n')
  .filter(Boolean);

const read = (f) => readFileSync(f, 'utf-8');

const codeLines = (text) => text
  .split('\n')
  .map((line, i) => [i + 1, line])
  .filter(([, line]) => !/^\s*#/.test(line));

const blockOf = (text, tag) => {
  const re = new RegExp(`^# >>> ${tag} >>>\\n[\\s\\S]*?^# <<< ${tag} <<<\\n`, 'm');
  const m = text.match(re);
  return m ? m[0] : null;
};

// Lines that read or write the node-bin pin file: either the literal is right there,
// or the path sits in a variable. Variables are tracked one alias deep (`$pinFiles`
// -> `foreach ($pinFile in $pinFiles)`) and no further, so a sibling path derived from
// the pin path (`Join-Path (Split-Path $pinFile) "runtime"`) is not mistaken for one.
// Returns the following code lines too, so a read can be paired with a later strip.
const pinSites = (text) => {
  const lines = codeLines(text);
  const vars = new Set();
  const bindings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i][1];
    const assign = line.match(/\$(?:script:)?([A-Za-z_]\w*)\s*(?:=|\+=)\s*(.*)$/);
    if (assign) bindings.push([assign[1], assign[2]]);
    // The `in` list can span lines: `foreach ($pinFile in @(\n  (Join-Path ...),\n ...))`.
    const loop = line.match(/foreach \(\$([A-Za-z_]\w*) in (.*)$/);
    if (loop) {
      bindings.push([loop[1], loop[2]]);
      bindings.push([loop[1], lines.slice(i + 1, i + 5).map(([, l]) => l).join('\n')]);
    }
  }
  for (const [name, rhs] of bindings) {
    if (/node-bin/.test(rhs)) vars.add(name);
  }
  for (const [name, rhs] of bindings) {
    const alias = rhs.match(/^\$(?:script:)?([A-Za-z_]\w*)\s*\)?\s*\{?\s*$/);
    if (alias && vars.has(alias[1])) vars.add(name);
  }
  const names = [...vars];
  const hit = (line) => (
    /\b(Get-Content|Set-Content|Add-Content|Out-File)\b/.test(line)
    && (/node-bin/.test(line)
        || names.some(v => new RegExp(`\\$(?:script:)?${v}\\b`).test(line)))
  );
  return lines
    .map(([n, line], i) => ({ n, line, after: lines.slice(i + 1, i + 6).map(([, l]) => l) }))
    .filter(({ line }) => hit(line));
};

// Function bodies, so a tar call can be tied to the staging dir in scope.
const functionsOf = (text) => {
  const out = [];
  const re = /^function ([A-Za-z][\w-]*) \{$/gm;
  let m;
  const starts = [];
  while ((m = re.exec(text)) !== null) starts.push([m[1], m.index]);
  for (let i = 0; i < starts.length; i++) {
    const [name, start] = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1][1] : text.length;
    out.push([name, text.slice(start, end)]);
  }
  return out;
};

const tarFunctions = (text) => functionsOf(text)
  // The helper itself resolves tar.exe; its callers own the path encoding.
  .filter(([name, body]) => name !== 'Expand-PilotTarGz' && /Expand-PilotTarGz \$/.test(body));

describe('non-ASCII Windows account names survive every .ps1 boundary', () => {
  it('finds the files to check', () => {
    // Guards against a silently empty sweep (wrong cwd, renamed glob).
    expect(tracked).toContain(SERVICE);
    expect(tracked.length).toBeGreaterThan(5);
  });

  it('no tracked .ps1 derives an account identity from whoami', () => {
    // No allowlist on purpose: $env:USERNAME / $env:USERDOMAIN / $env:COMPUTERNAME are
    // exact substitutes, carry the real UTF-16 string, and stay CLM-safe.
    const offenders = [];
    for (const file of tracked) {
      for (const [n, line] of codeLines(read(file))) {
        if (/\bwhoami\b/.test(line)) offenders.push(`${file}:${n}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the identity helpers are byte-identical everywhere they appear', () => {
    // Registration (service script) and uninstall (installers) must produce the same
    // tag. A copy that drifts silently orphans the tasks it was supposed to remove.
    const present = TASK_FILES.filter(existsSync);
    expect(present).toContain(SERVICE);
    const blocks = present.map(f => [f, blockOf(read(f), 'pilot-account-identity')]);
    const missing = blocks.filter(([, b]) => !b).map(([f]) => f);
    expect(missing).toEqual([]);
    expect(new Set(blocks.map(([, b]) => b)).size).toBe(1);
  });

  it('the identity helpers use environment variables and handle WORKGROUP', () => {
    // Pins the rule, not just the copies: [Security.Principal.WindowsIdentity]::
    // GetCurrent() is blocked under CLM (measured), and $env:USERDOMAIN is the literal
    // "WORKGROUP" under some logon providers (OpenSSH sshd), which maps to no SID
    // either -- the first attempted fix failed exactly there.
    const block = blockOf(read(SERVICE), 'pilot-account-identity');
    expect(block).toBeTruthy();
    const code = codeLines(block).map(([, l]) => l).join('\n');
    expect(code).toContain('$env:USERNAME');
    expect(code).toContain('$env:USERDOMAIN');
    expect(code).toMatch(/\$domain -eq "WORKGROUP"/);
    expect(code).toContain('$env:COMPUTERNAME');
    expect(code).not.toMatch(/WindowsIdentity|\[Environment\]::UserName/);
    // Non-ASCII names all normalise to "_", so the tag needs a discriminator; ASCII
    // names must keep the tag they already registered with.
    expect(code).toMatch(/\[\^\\x20-\\x7E\]/);
    expect(code).toMatch(/\$hash = \(\$hash \* 31 \+ \[int\]\$ch\)/);
  });

  for (const file of TASK_FILES) {
    it.skipIf(!existsSync(file))(`${file} builds task names via Get-PilotUserTag`, () => {
      const text = read(file);
      // Outside the shared block, which legitimately contains the one -replace. Blanked
      // rather than removed so reported line numbers stay real.
      const block = blockOf(text, 'pilot-account-identity') ?? '';
      const outside = text.replace(block, '#\n'.repeat(block.split('\n').length - 1));
      const lines = codeLines(outside);
      const tagAssigns = lines.filter(([, l]) => /\$(?:USER_TAG|userTag)\s*=/.test(l));
      expect(tagAssigns.length).toBeGreaterThan(0);
      for (const [n, line] of tagAssigns) {
        expect(line, `${file}:${n}`).toMatch(/Get-PilotUserTag/);
      }
      // And nobody rebuilds the tag by hand from an identity string.
      const handRolled = lines.filter(([, l]) => /-replace '\[\^A-Za-z0-9\._-\]', '_'/.test(l));
      expect(handRolled.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
    });
  }

  it('the scheduled-task principal and logon trigger come from Get-PilotAccountName', () => {
    const text = read(SERVICE);
    const identityArgs = codeLines(text)
      .filter(([, l]) => /-UserId\b|New-ScheduledTaskTrigger .*-User\b/.test(l));
    expect(identityArgs.length).toBeGreaterThanOrEqual(3);
    for (const [n, line] of identityArgs) {
      expect(line, `${SERVICE}:${n}`).toMatch(/Get-PilotAccountName|\$userId\b/);
    }
    expect(text).toMatch(/\$userId = Get-PilotAccountName/);
  });

  it('every node-bin pin read and write is explicitly UTF-8', () => {
    const bare = [];
    let total = 0;
    for (const file of tracked) {
      for (const { n, line } of pinSites(read(file))) {
        total += 1;
        if (!/-Encoding\s+UTF8\b/.test(line)) bare.push(`${file}:${n}: ${line.trim()}`);
      }
    }
    // Floor: 21 here, but only 15 survive the open-source sync (8 hook wrappers +
    // shared/common.ps1 + the service script + installer-opensource.ps1), and this
    // file is one of the synced ones. Below that the matcher has gone blind.
    expect(total).toBeGreaterThanOrEqual(15);
    expect(bare).toEqual([]);
  });

  it('every node-bin pin read strips the UTF-8 BOM', () => {
    // -Encoding UTF8 on 5.1 always writes a BOM (there is no utf8NoBOM) and U+FEFF is
    // not whitespace in PowerShell, so .Trim() alone leaves it inside the path and
    // Test-Path then fails on a file that exists. Two accepted shapes: strip on the
    // read itself, or read into a variable that is stripped a few lines below.
    const bare = [];
    let reads = 0;
    for (const file of tracked) {
      for (const { n, line, after } of pinSites(read(file))) {
        if (!/\bGet-Content\b/.test(line)) continue;
        reads += 1;
        const strip = /Trim\(\[char\]0xFEFF\)/;
        if (strip.test(line)) continue;
        const target = line.match(/\$(?:script:)?(\w+)\s*=/);
        const stripped = target
          && after.some(l => strip.test(l) && new RegExp(`\\$${target[1]}\\b`).test(l));
        if (!stripped) bare.push(`${file}:${n}: ${line.trim()}`);
      }
    }
    expect(reads).toBeGreaterThanOrEqual(12);  // 16 here, 12 after the open-source sync
    expect(bare).toEqual([]);
  });

  it('tar staging dirs come from Get-PilotAsciiTempRoot', () => {
    // Direction 2: tar.exe cannot see a non-ASCII path, so both the archive and the
    // extraction dir must sit under an ASCII root; the result is moved into the real
    // (possibly non-ASCII) destination afterwards, which Move-Item does natively.
    const offenders = [];
    let checked = 0;
    for (const file of tracked) {
      const text = read(file);
      for (const [name, body] of tarFunctions(text)) {
        checked += 1;
        for (const [, line] of codeLines(body)) {
          if (!/Join-Path/.test(line)) continue;
          if (/Get-PilotTempRoot|GetTempPath|Join-Path \$env:(TEMP|TMP)\b/.test(line)) {
            offenders.push(`${file} ${name}: ${line.trim()}`);
          }
        }
      }
    }
    // Floor: 5 here (Ensure-NodeModules + Download-AndExtract in the two internal
    // installers, Ensure-NodeModules in the open-source one), but only that last one
    // survives the sync, so 1 is all this can assert. It still catches a matcher that
    // stops recognising `function X {` or the call shape.
    expect(checked).toBeGreaterThanOrEqual(1);
    expect(offenders).toEqual([]);
  });

  it('the ASCII temp root is probed for writability and never used for secrets', () => {
    const variants = ['deploy/installer.ps1', 'deploy/installer-inner.ps1',
                      'deploy/installer-opensource.ps1'].filter(existsSync);
    for (const file of variants) {
      const block = blockOf(read(file), 'pilot-ascii-temp');
      expect(block, file).toBeTruthy();
      const code = codeLines(block).map(([, l]) => l).join('\n');
      // Env vars only: [System.IO.Path]::GetTempPath() throws under CLM.
      expect(code, file).not.toContain('GetTempPath');
      // A machine-wide fallback is only safe if it is confirmed writable first.
      expect(code, file).toMatch(/Set-Content -LiteralPath \$probe/);
      expect(code, file).toMatch(/\[\^\\x20-\\x7E\]/);
      // Config payloads carry the SLS AccessKeySecret and the CMS license key, so they
      // keep going to $DataDir; this root can be C:\Windows\Temp.
      expect(read(file)).not.toMatch(/\$cfgTmp = Join-Path \(Get-PilotAsciiTempRoot\)/);
    }
    if (variants.length > 0) {
      // The block is shared verbatim, same reason as the identity helpers.
      const blocks = variants.map(f => blockOf(read(f), 'pilot-ascii-temp'));
      expect(new Set(blocks).size).toBe(1);
    }
  });
});
