import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Text-level regression tests for the hook node-selection contract introduced
// after the review finding that the fallback loop overwrote the shared
// resolver's pick (an old Volta node silently shadowed the managed runtime and
// dropped events — the writer needs >= Node 18). The shell wrappers have no
// test harness of their own, so these assertions pin the structural invariants
// instead of executing the scripts; the gating itself was verified against
// stubbed node binaries (managed runtime survives, v16 rejected in favor of
// v20, host with only v16 prints {} without executing).

const shell = readFileSync(resolve('assets/hooks/codebuddy-loongsuite-pilot-hook.sh'), 'utf-8');
const powershell = readFileSync(resolve('assets/hooks/codebuddy-loongsuite-pilot-hook.ps1'), 'utf-8');
const shellRuntime = readFileSync(resolve('assets/hooks/shared/node-runtime.sh'), 'utf-8');

describe('CodeBuddy hook node selection gating', () => {
  it('prefers the shared resolver and delegates the version bar to it', () => {
    expect(shell).toContain('shared/node-runtime.sh');
    expect(shell).toContain('NODE_BIN="$(resolve_pilot_node_bin || true)"');
    // Same bar as the resolver: delegate when the shared file was sourced.
    expect(shell).toContain('if declare -F pilot_node_is_suitable >/dev/null 2>&1; then');
    expect(shell).toContain('pilot_node_is_suitable "$bin"');
    expect(shellRuntime).toContain('pilot_node_is_suitable()');
  });

  it('probes major >= 18 when the shared resolver is unavailable', () => {
    expect(shell).toContain('[[ "$major" =~ ^[0-9]+$ ]] && (( major >= 18 ))');
    expect(powershell).toContain('$MIN_NODE_MAJOR = 18');
  });

  it('runs the fallback candidates only when the shared resolver returned nothing', () => {
    // The guard must precede the candidate loop, and the loop body must not
    // assign NODE_BIN without passing the gate first.
    const guard = shell.indexOf('if [[ -z "$NODE_BIN" ]]; then');
    const loop = shell.indexOf('for candidate in');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(loop).toBeGreaterThan(guard);
    expect(shell).toContain('if [[ -n "$candidate" ]] && pilot_hook_node_ok "$candidate"; then');
    // The unversioned `-x` shortcut of the other wrappers must not creep back:
    // candidates are admitted only through the gate.
    expect(shell).not.toContain('-x "$candidate" ]]; then');
  });

  it('gates the PATH node probe behind the same version check', () => {
    expect(shell).toContain('if pilot_hook_node_ok "$(command -v node)"; then');
  });

  it('stays fail-open when no suitable node exists', () => {
    expect(shell).toContain("printf '{}\\n'");
    expect(powershell).toContain("Write-EmptyResult");
    expect(shell).toContain('exit 0');
  });

  it('gates every PowerShell fallback candidate through Test-NodeSuitable', () => {
    // The pin file candidate is checked first; every loop candidate passes the
    // same gate before being returned to the caller.
    expect(powershell).toContain('if (Test-NodeSuitable $pinned) { return $pinned }');
    expect(powershell).toContain('if (Test-NodeSuitable $resolved) { return $resolved }');
    // Unversioned admission shortcuts must not creep back.
    expect(powershell).not.toMatch(/return \$resolved\s*$/m);
  });
});
