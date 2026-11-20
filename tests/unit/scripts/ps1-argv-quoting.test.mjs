// Regression guards for the Windows argument-passing defects that aborted the
// installer and made the CLI probes report false negatives.
//
// PowerShell does not preserve double quotes inside a multi-line argument it
// hands to a native command, so a `node -e @'...'@` payload that uses `"` for a
// JS string arrives at Node with the quotes stripped (`require("fs")` becomes
// `require(fs)`) and fails to parse. The installer's payloads therefore stay
// single-quoted, and the CLI probes send their payload over stdin instead of
// through argv.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = process.env.PILOT_TEST_PWSH || (process.platform === 'win32' ? 'powershell.exe' : undefined);

const installer = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf8');
const cli = readFileSync(resolve('scripts', 'loongsuite-pilot.ps1'), 'utf8');

/** Every `node -e @' ... '@` payload, with the line its here-string opens on. */
function nodeEvalPayloads(text) {
  const blocks = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/-e @'/.test(lines[i])) continue;
    const body = [];
    let j = i + 1;
    while (j < lines.length && !/^'@/.test(lines[j])) body.push(lines[j++]);
    blocks.push({ line: i + 1, body: body.join('\n') });
    i = j;
  }
  return blocks;
}

describe('Windows node -e payloads survive native argument passing', () => {
  it('finds the installer payloads', () => {
    // Guards against a silently empty sweep (marker rename, file move).
    expect(nodeEvalPayloads(installer).length).toBeGreaterThan(10);
  });

  it('installer payloads contain no double quotes', () => {
    const offenders = nodeEvalPayloads(installer)
      .filter(entry => entry.body.includes('"'))
      .map(entry => entry.line);
    expect(offenders).toEqual([]);
  });

  it('CLI probes pipe their payload in instead of passing it as argv', () => {
    expect(cli).toContain("eval(require('fs').readFileSync(0,'utf8'))");
    expect(cli).not.toMatch(/-e \$probe\b/);
    expect(cli).not.toMatch(/-e \$js\b/);
  });

  it('builds sub-argument arrays by assignment, never from an if expression', () => {
    // A statement-block value is pipeline-enumerated, so a single element
    // collapses to a string: $SubArgs[0] then yields a Char and @SubArgs
    // splats the string per character.
    expect(cli).not.toMatch(/\$SubArgs = if \(/);
    expect(cli).not.toMatch(/\$rest = if \(/);
    expect(cli).toContain('$SubArgs = @()');
    expect(cli).toContain('$rest = @()');
  });
});

it.runIf(Boolean(powershell))('sets, lists and unsets a single span attribute through the actual CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-span-argv-'));
  try {
    const dataDir = join(root, 'data dir');
    const cacheDir = join(root, 'cache dir');
    mkdirSync(dataDir);
    mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, 'node-bin'), process.execPath + '\n');
    const env = {
      ...process.env,
      USERPROFILE: root,
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      LOONGSUITE_PILOT_CACHE_DIR: cacheDir,
    };
    function run(...args) {
      const result = spawnSync(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        resolve('scripts/loongsuite-pilot.ps1'), 'span-attr', ...args,
      ], { env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    }
    expect(run('set', 'example', 'value with spaces')).toBe('set example=value with spaces');
    expect(run('list')).toBe('example=value with spaces');
    expect(run('unset', 'example')).toBe('unset example');
    expect(run('list')).toBe('(no custom span attributes)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
