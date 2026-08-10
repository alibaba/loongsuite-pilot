// Behavioral tests for the numeric node-version sorting used by the hook
// fallback search: sort_version_dirs_desc in *-loongsuite-pilot-hook.sh and
// Get-NodeVersionSortKey in shared/common.ps1. Both must order versions the
// same way as compareNodeRuntimeDirs in src/metrics/metrics-collector.ts
// (numeric, newest first), not lexicographically.
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const sh = readFileSync(resolve('assets/hooks/claude-code-loongsuite-pilot-hook.sh'), 'utf-8');
const fnMatch = sh.match(/sort_version_dirs_desc\(\) \{[\s\S]*?\n\}\n/);
if (!fnMatch) throw new Error('sort_version_dirs_desc not found in hook script');
const SORT_FN = fnMatch[0];

// node-v22.9.0 vs node-v22.22.2 is the regression case: lexicographic order
// (and a plain reverse glob) prefers the older 22.9.0.
const EXPECTED = ['node-v24.1.0-darwin-arm64', 'node-v22.22.2', 'node-v22.9.0', 'node-v18.20.0'];

function runBashSort(harnessPrefix, dirs) {
  const input = dirs.map(d => `/runtime/${d}`).join('\n') + '\n';
  const r = spawnSync('bash', ['-c', `${harnessPrefix}\n${SORT_FN}\nsort_version_dirs_desc`], {
    input,
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    throw new Error(`bash exited ${r.status}\nstderr: ${r.stderr}`);
  }
  return r.stdout.trim().split('\n').map(line => line.split('/').pop());
}

describe('sort_version_dirs_desc (hook.sh fallback)', () => {
  it('orders versions numerically descending via sort -V when available', () => {
    // Probe first: if this platform's sort lacks -V, the function itself falls
    // back, and this test still observes numeric ordering.
    expect(runBashSort('', [...EXPECTED].reverse())).toEqual(EXPECTED);
  });

  it('orders versions numerically descending via the zero-pad fallback when sort -V is missing', () => {
    // Shadow sort with a stub that rejects -V (like BSD/macOS sort), forcing
    // the zero-padded-key fallback branch.
    const stub = `sort() {
  local a
  for a in "$@"; do case "$a" in *-V*) return 2 ;; esac; done
  command sort "$@"
}`;
    expect(runBashSort(stub, ['node-v18.20.0', 'node-v22.9.0', 'node-v24.1.0-darwin-arm64', 'node-v22.22.2']))
      .toEqual(EXPECTED);
  });

  it('selects the newest runtime dir end-to-end in the fallback glob loop', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'hook-sort-'));
    try {
      for (const d of EXPECTED) mkdirSync(resolve(tmp, 'runtime', d, 'bin'), { recursive: true });
      const body = `
${SORT_FN}
candidates=()
runtime_dir="$1/runtime"
while IFS= read -r d; do
  [[ -n "$d" ]] && candidates+=("$d/bin/node")
done < <(for d in "$runtime_dir"/node-v*; do [[ -d "$d" ]] && printf '%s\\n' "$d"; done | sort_version_dirs_desc)
printf '%s\\n' "\${candidates[0]}"
`;
      const r = spawnSync('bash', ['-c', body, 'bash', tmp], { encoding: 'utf-8' });
      if (r.status !== 0) throw new Error(`bash exited ${r.status}\nstderr: ${r.stderr}`);
      expect(r.stdout.trim()).toBe(resolve(tmp, 'runtime/node-v24.1.0-darwin-arm64/bin/node'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

let pwshAvailable = false;
try {
  execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
  pwshAvailable = true;
} catch { /* pwsh not installed here; skip the PowerShell tests */ }

describe('Get-NodeVersionSortKey (common.ps1)', () => {
  const commonPs1 = resolve('assets/hooks/shared/common.ps1').replace(/\\/g, '/');

  it.skipIf(!pwshAvailable)('orders versions numerically descending', () => {
    const script = `
. "${commonPs1}"
'node-v22.9.0','node-v22.22.2','node-v18.20.0','node-v24.1.0-win-x64' |
  Sort-Object @{Expression={ Get-NodeVersionSortKey $_ }} -Descending
`;
    const out = execFileSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf-8' });
    expect(out.trim().split(/\r?\n/)).toEqual([
      'node-v24.1.0-win-x64', 'node-v22.22.2', 'node-v22.9.0', 'node-v18.20.0',
    ]);
  });

  it.skipIf(!pwshAvailable)('matches the bash helper ordering on identical input', () => {
    const script = `
. "${commonPs1}"
'node-v18.20.0','node-v22.9.0','node-v24.1.0-darwin-arm64','node-v22.22.2' |
  Sort-Object @{Expression={ Get-NodeVersionSortKey $_ }} -Descending
`;
    const out = execFileSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf-8' });
    expect(out.trim().split(/\r?\n/)).toEqual(EXPECTED);
  });
});
