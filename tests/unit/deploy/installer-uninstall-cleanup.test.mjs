import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sh = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf-8');
const ps1 = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf-8');

// Hook-mode agents whose settings files must be cleaned on uninstall. Kept in
// sync with agents.d/*.json (deployMode: hook). A missing entry means the
// agent's hook survives uninstall.
const HOOK_CONFIG_FILES = [
  '.cursor/hooks.json',
  '.qoder/settings.json',
  '.qoder-cn/settings.json',
  '.qoderwork/settings.json',
  '.qoderworkcn/settings.json',
  '.claude/settings.json',
  '.codex/hooks.json',
  '.qwen/settings.json',
];

describe('uninstall cleans hook configs for all hook agents', () => {
  for (const f of HOOK_CONFIG_FILES) {
    it(`sh remove_hook_configs includes ${f}`, () => {
      expect(sh).toContain(`$HOME/${f}`);
    });
    it(`ps1 Remove-HookConfigs includes ${f}`, () => {
      expect(ps1).toContain(f.replace(/\//g, '\\'));
    });
  }
});

describe('uninstall cleans the OpenCode plugin-inject spec', () => {
  it('sh defines remove_opencode_plugin', () => {
    expect(sh).toMatch(/remove_opencode_plugin\(\)\s*\{/);
  });

  it('sh calls remove_opencode_plugin inside cmd_uninstall', () => {
    const uninstall = sh.slice(sh.indexOf('cmd_uninstall()'));
    expect(uninstall).toContain('remove_opencode_plugin');
  });

  it('ps1 defines Remove-OpenCodePlugin', () => {
    expect(ps1).toMatch(/function Remove-OpenCodePlugin\s*\{/);
  });

  it('ps1 calls Remove-OpenCodePlugin inside Cmd-Uninstall', () => {
    const uninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));
    expect(uninstall).toContain('Remove-OpenCodePlugin');
  });

  for (const cfg of ['opencode.jsonc', 'opencode.json', 'config.json']) {
    it(`sh cleans ~/.config/opencode/${cfg}`, () => {
      expect(sh).toContain(`.config/opencode/${cfg}`);
    });
    it(`ps1 cleans .config\\opencode\\${cfg}`, () => {
      expect(ps1).toContain(`.config\\opencode\\${cfg}`);
    });
  }

  it('matches our entries by pluginId or plugin file path', () => {
    expect(sh).toContain('loongsuite-pilot-opencode');
    expect(sh).toContain('plugins/opencode/plugin.mjs');
    expect(ps1).toContain('loongsuite-pilot-opencode');
    expect(ps1).toContain('plugins/opencode/plugin.mjs');
  });
});

describe('Windows uninstall removes scheduled tasks for the current user', () => {
  it('uses the same DOMAIN-user task tag as the Windows service CLI', () => {
    expect(ps1).toContain('$currentIdentity = (whoami).Trim()');
    expect(ps1).toContain("$userTag = ($currentIdentity -replace '[^A-Za-z0-9._-]', '_')");
  });

  it('removes both current-user collector and updater tasks', () => {
    expect(ps1).toContain('"LoongsuitePilot-$userTag"');
    expect(ps1).toContain('"LoongsuitePilotUpdater-$userTag"');
  });

  it('keeps best-effort cleanup for both legacy task names', () => {
    expect(ps1).toContain('$legacyTasks = @("LoongsuitePilot", "LoongsuitePilotUpdater")');
    expect(ps1).toContain('if ($taskOwner -and $taskOwner -ine $currentIdentity) { continue }');
  });

  it('calls scheduled-task cleanup before deleting the installation', () => {
    const uninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));
    const taskCleanup = uninstall.indexOf('Remove-PilotScheduledTasks');
    const installRemoval = uninstall.indexOf('Remove-PilotInstallationFiles');

    expect(taskCleanup).toBeGreaterThanOrEqual(0);
    expect(installRemoval).toBeGreaterThan(taskCleanup);
  });

  it.runIf(process.platform === 'win32')('targets the sanitized current-user tasks at runtime', () => {
    const functionStart = ps1.indexOf('function Remove-PilotScheduledTasks');
    const functionEnd = ps1.indexOf('\nfunction Cmd-Uninstall', functionStart);
    const functionSource = ps1.slice(functionStart, functionEnd);
    const harness = `
$script:events = @()
function whoami { "CORP\\Test User" }
function Get-ScheduledTask {
  param($TaskName, $TaskPath, $ErrorAction)
  $script:events += "get:$TaskPath$TaskName"
  [pscustomobject]@{
    State = "Running"
    Principal = [pscustomobject]@{ UserId = "CORP\\Test User" }
  }
}
function Stop-ScheduledTask {
  param($TaskName, $TaskPath, $ErrorAction)
  $script:events += "stop:$TaskPath$TaskName"
}
function global:schtasks.exe {
  $script:events += "delete:$($args -join ' ')"
}
${functionSource}
Remove-PilotScheduledTasks
$script:events | ConvertTo-Json -Compress
`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', harness],
      { encoding: 'utf8', timeout: 15_000 },
    );

    expect(result.status).toBe(0);
    const events = JSON.parse(result.stdout.trim());
    expect(events).toContain('get:\\LoongsuitePilot\\LoongsuitePilot-CORP_Test_User');
    expect(events).toContain('get:\\LoongsuitePilot\\LoongsuitePilotUpdater-CORP_Test_User');
    expect(events).toContain('stop:\\LoongsuitePilot\\LoongsuitePilot-CORP_Test_User');
    expect(events).toContain('stop:\\LoongsuitePilot\\LoongsuitePilotUpdater-CORP_Test_User');
    expect(events.some(event => event.includes('Another_User'))).toBe(false);
  });
});
