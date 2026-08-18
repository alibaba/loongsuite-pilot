// Every comment in every tracked .ps1 must be ASCII-only.
//
// A .ps1 with a UTF-8 BOM decodes correctly from disk, but two paths bypass the BOM:
//   * lose the BOM (copy/paste, a tool rewrite, CRLF conversion) and Windows
//     PowerShell 5.1 falls back to the ANSI codepage;
//   * the documented `irm <url>/installer.ps1 | iex` decodes per the HTTP charset and
//     never looks at a BOM at all.
// Either way non-ASCII comment text garbles, and a mangled byte sequence can carry a
// quote or backtick that takes the parser down with it. On a WDAC-locked box (see
// ps1-clm-safe.test.mjs) that turns into a failed install, so comments are held to
// ASCII.
//
// Bilingual *output* strings (Msg / Write-Host / Write-Log) are intentionally exempt:
// they are user-facing text, not parser fodder.
//
// Entries in KNOWN_UNCONVERTED for files this repo does not track are simply never
// visited, so the list stays valid downstream where the same file set is larger.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Files not yet converted. Shrink this list, never grow it — a new .ps1 must be clean.
const KNOWN_UNCONVERTED = new Set([
  'deploy/installer-opensource.ps1',
  '.specify/extensions/git/scripts/powershell/auto-commit.ps1',
  '.specify/extensions/git/scripts/powershell/git-common.ps1',
  '.specify/extensions/git/scripts/powershell/initialize-repo.ps1',
]);

const NON_ASCII = /[^\x00-\x7F]/;

// A `#` only starts a comment outside a string literal. Approximating "outside a
// string" by an even quote count ahead of it is enough here and, importantly, keeps
// `Write-Host "   loongsuite-pilot   # status"` out of the results.
const commentOffenders = (text) => text
  .replace(/^﻿/, '')
  .split('\n')
  .map((line, i) => [i + 1, line])
  .filter(([, line]) => {
    if (!NON_ASCII.test(line)) return false;
    if (line.trimStart().startsWith('#')) return true;
    const hash = line.indexOf('#');
    if (hash < 0) return false;
    const before = line.slice(0, hash);
    const balanced = (before.split('"').length - 1) % 2 === 0
      && (before.split("'").length - 1) % 2 === 0;
    return balanced && NON_ASCII.test(line.slice(hash));
  });

const tracked = execFileSync('git', ['ls-files', '*.ps1'], { encoding: 'utf-8' })
  .split('\n')
  .filter(Boolean);

describe('tracked .ps1 comments are ASCII-only', () => {
  it('finds .ps1 files to check', () => {
    expect(tracked.length).toBeGreaterThan(10);
  });

  for (const file of tracked) {
    const expectClean = !KNOWN_UNCONVERTED.has(file);
    it(`${file} ${expectClean ? 'has ASCII-only comments' : '(known unconverted)'}`, () => {
      const offenders = commentOffenders(readFileSync(file, 'utf-8'));
      if (expectClean) {
        expect(offenders).toEqual([]);
      } else {
        // Ratchet: once a file is cleaned, drop it from KNOWN_UNCONVERTED so the
        // assertion above starts protecting it.
        expect(offenders.length).toBeGreaterThan(0);
      }
    });
  }

  it('flags a BOM-less file only if it still holds non-ASCII bytes anywhere', () => {
    // scripts/loongsuite-pilot.ps1 has no BOM. That is harmless precisely because it is
    // now pure ASCII (ASCII decodes identically under every codepage). If non-ASCII
    // bytes reappear in a BOM-less file, the ANSI-fallback hazard is live again.
    const risky = tracked.filter((f) => {
      if (KNOWN_UNCONVERTED.has(f)) return false;
      const buf = readFileSync(f);
      const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      return !hasBom && NON_ASCII.test(buf.toString('utf-8'));
    });
    expect(risky).toEqual([]);
  });
});
