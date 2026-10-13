import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SERVICE_SH = readFileSync('scripts/loongsuite-pilot.sh', 'utf-8');
const SERVICE_PS1 = readFileSync('scripts/loongsuite-pilot.ps1', 'utf-8');
const AUTOSTART = readFileSync('deploy/autostart.sh', 'utf-8');

describe('interceptor inside the collector process', () => {
  it('does not register or command a separate Unix interceptor service', () => {
    const install = SERVICE_SH.slice(
      SERVICE_SH.indexOf('autostart_install() {'),
      SERVICE_SH.indexOf('autostart_remove() {'),
    );
    expect(install).not.toContain('_write_launchd_interceptor_plist');
    expect(install).not.toContain('loongsuite-pilot-interceptor');
    expect(SERVICE_SH).not.toContain('retire_standalone_interceptor');
    expect(SERVICE_SH).not.toContain('start-interceptor');
    expect(SERVICE_SH).not.toContain('restart-interceptor');
    expect(SERVICE_SH).not.toContain('run-interceptor');
    expect(SERVICE_SH).not.toContain('interceptor-daemon.js');
    expect(SERVICE_SH).toContain('interceptor_embedded_status()');
    expect(SERVICE_SH).toMatch(/cmd_run\(\) \{\n    ensure_dirs/);
  });

  it('does not deploy a separate interceptor daemon', () => {
    expect(SERVICE_SH).not.toContain('cmd_run_interceptor');
    expect(SERVICE_PS1).not.toContain('function Cmd-RunInterceptor');
    expect(SERVICE_PS1).not.toContain('interceptor-daemon');
    expect(AUTOSTART).not.toContain('interceptor');
    const installerSh = readFileSync('deploy/installer-opensource.sh', 'utf-8');
    const installerPs1 = readFileSync('deploy/installer-opensource.ps1', 'utf-8');
    expect(installerSh).not.toContain('interceptor-daemon.js');
    expect(installerSh).not.toContain('loongsuite-pilot-interceptor');
    expect(installerSh).not.toContain('interceptor/interceptor.pid');
    expect(installerPs1).not.toContain('interceptor-daemon.js');
    expect(installerPs1).not.toContain('LoongsuitePilotInterceptor');
  });

  it('does not let the hook CLI start the daemon', () => {
    expect(SERVICE_SH).not.toContain('daemon ensure');
    const cli = readFileSync('src/interceptor/cli.ts', 'utf-8');
    expect(cli).not.toContain('ensure');
    expect(cli).toContain("command === 'hook'");
  });

  it('does not register interceptor as a Windows scheduled task', () => {
    expect(SERVICE_PS1).not.toContain('function Remove-StandaloneInterceptor');
    expect(SERVICE_PS1).not.toContain('function Install-InterceptorTask');
    expect(SERVICE_PS1).not.toContain('function Cmd-RestartInterceptor');
    expect(SERVICE_PS1).not.toContain('start-interceptor');
    expect(SERVICE_PS1).not.toContain('restart-interceptor');
    expect(SERVICE_PS1).not.toContain('run-interceptor');
    expect(SERVICE_PS1).not.toContain('LoongsuitePilotInterceptor');
    expect(SERVICE_PS1).toContain('function Test-InterceptorEmbedded');
    expect(SERVICE_PS1).toMatch(/function Cmd-Run \{\r?\n    Ensure-Dirs/);
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

  it('keeps the reference autostart library on collector and updater only', () => {
    expect(AUTOSTART).toContain('autostart_install()');
    expect(AUTOSTART).toContain('_LOONGSUITE_PILOT_UPDATER_UNIT');
    expect(AUTOSTART).not.toContain('interceptor');
  });
});
