import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SERVICE_SH = readFileSync('scripts/loongsuite-pilot.sh', 'utf-8');
const SERVICE_PS1 = readFileSync('scripts/loongsuite-pilot.ps1', 'utf-8');
const AUTOSTART = readFileSync('deploy/autostart.sh', 'utf-8');

describe('interceptor peer service registration', () => {
  it('registers interceptor as a third Unix service', () => {
    expect(SERVICE_SH).toContain('cmd_run_interceptor()');
    expect(SERVICE_SH).toContain('cmd_restart_interceptor()');
    expect(SERVICE_SH).toContain('cmd_start_interceptor()');
    expect(SERVICE_SH).toContain('_write_launchd_interceptor_plist');
    expect(SERVICE_SH).toContain('_write_systemd_user_interceptor_unit');
    expect(SERVICE_SH).toContain('_write_systemd_system_interceptor_unit');
    expect(SERVICE_SH).toContain('_write_initd_interceptor_script');
    expect(SERVICE_SH).toContain('autostart_install_interceptor_only');
    expect(SERVICE_SH).toMatch(/run-interceptor\)\s+cmd_run_interceptor/);
    expect(SERVICE_SH).toContain('loongsuite-pilot-interceptor.service');
    expect(SERVICE_SH).toContain('com.loongsuite-pilot.interceptor');
  });

  it('propagates custom data and cache directories to every Unix service manager', () => {
    const interceptorSection = SERVICE_SH.slice(
      SERVICE_SH.indexOf('_write_systemd_user_interceptor_unit()'),
      SERVICE_SH.indexOf('_register_initd_boot()'),
    );
    expect(interceptorSection).toContain('Environment=LOONGSUITE_PILOT_DATA_DIR=${DATA_DIR}');
    expect(interceptorSection).toContain('Environment=LOONGSUITE_PILOT_CACHE_DIR=${CACHE_DIR}');
    expect(interceptorSection).toContain('<key>LOONGSUITE_PILOT_DATA_DIR</key>');
    expect(interceptorSection).toContain('<key>LOONGSUITE_PILOT_CACHE_DIR</key>');
    expect(interceptorSection).toContain('export LOONGSUITE_PILOT_DATA_DIR="$DATA_DIR"');
    expect(interceptorSection).toContain('export LOONGSUITE_PILOT_CACHE_DIR="$CACHE_DIR"');

    const referenceSection = AUTOSTART.slice(AUTOSTART.indexOf('_write_launchd_interceptor_plist()'));
    expect(referenceSection).toContain('<key>LOONGSUITE_PILOT_DATA_DIR</key>');
    expect(referenceSection).toContain('<key>LOONGSUITE_PILOT_CACHE_DIR</key>');
    expect(referenceSection).toContain(
      'Environment=LOONGSUITE_PILOT_DATA_DIR=${LOONGSUITE_PILOT_DATA_DIR}',
    );
    expect(referenceSection).toContain(
      'Environment=LOONGSUITE_PILOT_CACHE_DIR=${LOONGSUITE_PILOT_CACHE_DIR}',
    );
  });

  it('does not let the hook CLI start the daemon', () => {
    expect(SERVICE_SH).not.toContain('daemon ensure');
    const cli = readFileSync('src/interceptor/cli.ts', 'utf-8');
    expect(cli).not.toContain('ensure');
    expect(cli).toContain("command === 'hook'");
  });

  it('registers interceptor as a Windows scheduled task', () => {
    expect(SERVICE_PS1).toContain('function Install-InterceptorTask');
    expect(SERVICE_PS1).toContain('function Cmd-RunInterceptor');
    expect(SERVICE_PS1).toContain('function Cmd-RestartInterceptor');
    expect(SERVICE_PS1).toContain('LoongsuitePilotInterceptor-');
    expect(SERVICE_PS1).toContain('interceptor-daemon');
  });

  it('pins QwenWork interceptor scripts to --agent qwen-work-cn, not qoder-auto', () => {
    const sh = readFileSync('assets/hooks/interceptor-qwenworkcn-hook.sh', 'utf-8');
    const ps1 = readFileSync('assets/hooks/interceptor-qwenworkcn-hook.ps1', 'utf-8');
    expect(sh).toContain('hook --agent qwen-work-cn');
    expect(ps1).toContain('hook --agent qwen-work-cn');
    expect(sh).not.toMatch(/--agent qoder-auto/);
    expect(ps1).not.toMatch(/--agent qoder-auto/);
  });

  it('declares QwenWork interceptor command hooks separately from collection Stop', () => {
    const def = JSON.parse(readFileSync('agents.d/qwen-work-cn.json', 'utf-8'));
    expect(def.hook.events).toEqual(['Stop']);
    expect(def.hook.interceptor.events).toEqual(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
    expect(def.hook.interceptor.hookCommand).toContain('interceptor-qwenworkcn-hook.sh');
    expect(def.hook.interceptor.insert).toBe('head');
  });

  it('keeps the reference autostart library in sync', () => {
    expect(AUTOSTART).toContain('run-interceptor');
    expect(AUTOSTART).toContain('loongsuite-pilot-interceptor.service');
    expect(AUTOSTART).toContain('com.loongsuite-pilot.interceptor');
  });
});
