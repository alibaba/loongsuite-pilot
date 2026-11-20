import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { updateDashboardConfig } from '../../../scripts/dashboard-config.mjs';

const root = path.resolve();
const runtimeSh = readFileSync(path.join(root, 'scripts/loongsuite-pilot.sh'), 'utf8');
const runtimePs1 = readFileSync(path.join(root, 'scripts/loongsuite-pilot.ps1'), 'utf8');
const tempDirs = [];

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pilot-dashboard-command-'));
  tempDirs.push(dir);
  return { config: path.join(dir, 'config.json'), marker: path.join(dir, 'restart') };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dashboard command', () => {
  it('preserves unrelated settings and the saved port across start and stop', async () => {
    const { config } = fixture();
    writeFileSync(config, '\uFEFF' + JSON.stringify({ userId: 'user', dashboard: { port: 9000, extra: 1 } }));
    expect(await updateDashboardConfig(config, 'start', ['9999'])).toBe(9999);
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
      userId: 'user', dashboard: { enabled: true, port: 9999, extra: 1 },
    });
    expect(await updateDashboardConfig(config, 'stop')).toBe(9999);
    expect(JSON.parse(readFileSync(config, 'utf8')).dashboard).toEqual({ enabled: false, port: 9999, extra: 1 });
  });

  it.each(['0', '65536', '1.5', 'abc'])('rejects invalid port %s without changing config', async port => {
    const { config } = fixture();
    writeFileSync(config, '{"dashboard":{"enabled":false}}');
    await expect(updateDashboardConfig(config, 'start', [port])).rejects.toThrow('port must be');
    expect(readFileSync(config, 'utf8')).toBe('{"dashboard":{"enabled":false}}');
  });

  it('refuses malformed config rather than replacing it', async () => {
    const { config } = fixture();
    writeFileSync(config, '{broken');
    await expect(updateDashboardConfig(config, 'start')).rejects.toThrow('invalid JSON');
    expect(readFileSync(config, 'utf8')).toBe('{broken');
  });

  it('wires Unix start and stop to the collector lifecycle', () => {
    const { config, marker } = fixture();
    const command = runtimeSh.slice(runtimeSh.indexOf('cmd_dashboard()'), runtimeSh.indexOf('cmd_token_usage()'));
    const harness = `set -euo pipefail
SCRIPT_DIR="$PILOT_TEST_ROOT/scripts"
CONFIG_FILE="$PILOT_TEST_CONFIG"
LOG_FILE="$PILOT_TEST_ROOT/service.log"
${command}
resolve_node() { printf '%s\\n' "$PILOT_TEST_NODE"; }
is_running() { return 0; }
cmd_restart() { printf 'restart\\n' >> "$PILOT_TEST_MARKER"; }
dashboard_port() { "$PILOT_TEST_NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).dashboard.port' "$PILOT_TEST_CONFIG"; }
dashboard_is_available() { return 0; }
cmd_dashboard "$@"`;
    const run = (...args) => spawnSync('bash', ['-c', harness, 'dashboard-test', ...args], {
      encoding: 'utf8', env: { ...process.env, PILOT_TEST_ROOT: root, PILOT_TEST_CONFIG: config,
        PILOT_TEST_MARKER: marker, PILOT_TEST_NODE: process.execPath },
    });
    const started = run('start', '9999');
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout).toContain('http://127.0.0.1:9999/');
    expect(readFileSync(marker, 'utf8')).toBe('restart\n');
    const stopped = run('stop');
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('restart\nrestart\n');
    expect(JSON.parse(readFileSync(config, 'utf8')).dashboard.enabled).toBe(false);
  });

  it('reports disabled without probing and supports the Windows command', () => {
    expect(runtimeSh).toContain('if ! dashboard_enabled; then');
    expect(runtimePs1).toContain('if (-not (Test-DashboardEnabled))');
    expect(runtimePs1).toContain('"dashboard"          { Cmd-Dashboard }');
  });
});
