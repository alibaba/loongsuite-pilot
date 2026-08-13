import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const runtimeSh = readFileSync(resolve('scripts', 'loongsuite-pilot.sh'), 'utf8');
const runtimePs1 = readFileSync(resolve('scripts', 'loongsuite-pilot.ps1'), 'utf8');
const dashboardHtml = readFileSync(resolve('assets', 'dashboard', 'index.html'), 'utf8');

describe('dashboard service lifecycle', () => {
  it('does not expose the removed monitor command', () => {
    const helpAndDispatch = runtimeSh.slice(runtimeSh.indexOf('cmd_help()'));
    expect(helpAndDispatch).not.toMatch(/monitor (start|stop)/);
    expect(helpAndDispatch).not.toMatch(/^\s*monitor\)/m);
  });

  it('cleans legacy standalone processes on start, stop, and collector restart', () => {
    for (const command of ['cmd_start', 'cmd_stop', 'cmd_restart_collector']) {
      const body = runtimeSh.slice(runtimeSh.indexOf(`${command}()`));
      expect(body.split('\n').slice(0, 4).join('\n')).toContain('cleanup_legacy_monitor_processes');
    }
  });

  it('validates a legacy PID command line before killing it', () => {
    const cleanup = runtimeSh.slice(
      runtimeSh.indexOf('cleanup_legacy_monitor_process()'),
      runtimeSh.indexOf('cleanup_legacy_monitor_processes()'),
    );
    expect(cleanup.indexOf('ps -p "$pid" -o command=')).toBeLessThan(cleanup.indexOf('kill "$pid"'));
    expect(cleanup).toContain('[[ "$command_line" == *"$script_name"* ]]');
    expect(cleanup).toContain('rm -f "$pid_file"');
    expect(cleanup).not.toContain('pkill');
  });

  it('probes the dashboard before printing its URL on Unix and Windows', () => {
    const unixProbe = runtimeSh.slice(
      runtimeSh.indexOf('dashboard_is_available()'),
      runtimeSh.indexOf('cmd_status()'),
    );
    const windowsProbe = runtimePs1.slice(
      runtimePs1.indexOf('function Test-DashboardAvailable'),
      runtimePs1.indexOf('function Cmd-Status'),
    );

    for (const probe of [unixProbe, windowsProbe]) {
      expect(probe).toContain('require("node:http")');
      expect(probe).toContain('path: "/metrics-summary.json"');
      expect(probe).toContain('method: "HEAD"');
      expect(probe).toContain('setTimeout');
      expect(probe).toContain('}, 300)');
    }
    expect(runtimeSh).toContain('dashboard: unavailable (http://127.0.0.1:18765/)');
    expect(runtimePs1).toContain('dashboard: unavailable (http://127.0.0.1:18765/)');
  });
});

describe('dashboard static page', () => {
  it('reads only metrics-summary.json and renders agentShares dynamically', () => {
    expect(dashboardHtml).toContain("fetch('/metrics-summary.json'");
    expect(dashboardHtml).toContain('today.agentShares');
    expect(dashboardHtml).toContain('agentShares.map');
    expect(dashboardHtml).not.toContain('/api/overview');
    expect(dashboardHtml).not.toContain('/api/metrics');
  });
});
