import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const installer = readFileSync('deploy/installer-opensource.sh', 'utf8');
const parser = installer.slice(0, installer.indexOf('if [ -n "$ENABLE_STATUS_BAR_APP" ]'));
const helper = installer.slice(installer.indexOf('apply_installation_scope() {'), installer.indexOf('\ncmd_install() {'));

describe('POSIX installer hook scope', () => {
  it('accepts automatic and mixed selection, and rejects invalid scope requests before deployment', () => {
    for (const flag of [['--scope', 'system'], ['--scope=system']]) {
      const result = spawnSync('bash', ['-c', parser + '\nprintf "%s|%s" "$HOOK_INSTALL_SCOPE" "$SELECTED_AGENTS"',
        'installer', 'install', '--agents', 'grok-build', ...flag], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('system|grok-build');
    }
    for (const argv of [
      ['install', '--agents', 'grok-build', '--scope', 'invalid'],
      ['upgrade', '--agents', 'grok-build', '--scope', 'system'],
    ]) {
      expect(spawnSync('bash', ['-c', parser, 'installer', ...argv]).status).toBe(1);
    }
    for (const agents of [[], ['--agents', 'grok-build,claude-code'], ['--all-agents']]) {
      const result = spawnSync('bash', ['-c', parser, 'installer', 'install', '--scope', 'system', ...agents]);
      expect(result.status, result.stderr?.toString()).toBe(0);
    }
  });

  it('runs scoped hook installation before starting services and preserves failure recovery', () => {
    const order = installer.slice(installer.indexOf('\ncmd_install() {'), installer.indexOf('\ncmd_upgrade() {'));
    expect(order.indexOf('apply_installation_scope')).toBeGreaterThan(order.indexOf('install_loongsuite_pilot_command'));
    expect(order.indexOf('apply_installation_scope')).toBeLessThan(order.indexOf('run_pilot_cli start'));
    const result = spawnSync('bash', ['-c', `set -euo pipefail
${helper}
HOOK_INSTALL_SCOPE=system
SELECTED_AGENTS=grok-build
PILOT_HELD_FOR_DEPLOY=1
msg() { :; }
run_pilot_cli() { printf '<%s>' "$@"; return 1; }
if apply_installation_scope; then exit 12; fi
printf '|held=%s' "$PILOT_HELD_FOR_DEPLOY"
`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('<hook><install><--scope><system><--json><--agents><grok-build>|held=0');
  });

  it('omits the agents argument for automatic discovery and --all-agents', () => {
    const result = spawnSync('bash', ['-c', `set -euo pipefail
${helper}
HOOK_INSTALL_SCOPE=system
SELECTED_AGENTS=""
run_pilot_cli() { printf '<%s>' "$@"; }
apply_installation_scope
`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('<hook><install><--scope><system><--json>');
  });
});
