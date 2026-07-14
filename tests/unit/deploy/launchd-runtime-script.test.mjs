import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'scripts/loongsuite-pilot.sh');
const script = readFileSync(scriptPath, 'utf8');
const autostartPath = resolve(process.cwd(), 'deploy/autostart.sh');
const autostart = readFileSync(autostartPath, 'utf8');

describe('macOS launchd runtime script', () => {
  it('uses modern launchd commands with legacy fallbacks for older macOS', () => {
    expect(script).toContain('launchctl bootout "$domain" "$plist"');
    expect(script).toContain('launchctl unload -w "$plist"');
    expect(script).toContain('launchctl bootstrap "$domain" "$plist"');
    expect(script).toContain('launchctl load -w "$plist"');
    expect(script).toContain('launchctl enable "$target"');
    expect(script).toContain('launchctl kickstart -k "$target"');
    expect(script).toContain('launchctl start "$label"');
  });

  it('does not report start success until the collector PID is alive', () => {
    expect(script).toContain('wait_for_collector_running()');
    expect(script).toContain('if wait_for_collector_running 5; then');
    expect(script).toContain('Service manager did not start collector');
    expect(script).not.toContain('if is_managed_by_launchd || is_managed_by_systemd_user || is_managed_by_systemd_system || is_managed_by_initd; then');
  });

  it('restarts collector through kickstart and falls back when PID verification fails', () => {
    expect(script).toContain('launchd_kickstart_or_start "$SERVICE_LABEL"');
    expect(script).toContain('service manager reported success but collector process not found, falling back to nohup');
    expect(script).toContain('nohup "$node_bin" "$entry" >> "$LOG_FILE" 2>&1 &');
  });

  it('keeps updater restart on the same launchd compatibility path', () => {
    expect(script).toContain('launchd_kickstart_or_start "$UPDATER_LABEL"');
    expect(script).toContain('wait_for_updater_running()');
    expect(script).toContain('service manager reported success but updater process not found, falling back to nohup');
  });

  it('keeps deploy autostart reference script on the same launchd compatibility path', () => {
    expect(autostart).toContain('launchctl bootout "$domain" "$plist"');
    expect(autostart).toContain('launchctl unload -w "$plist"');
    expect(autostart).toContain('launchctl bootstrap "$domain" "$plist"');
    expect(autostart).toContain('launchctl load -w "$plist"');
    expect(autostart).toContain('launchctl enable "$target"');
    expect(autostart).toContain('launchctl kickstart -k "$target"');
    expect(autostart).toContain('launchctl start "$label"');
  });
});
