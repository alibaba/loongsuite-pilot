import { describe, expect, it } from 'vitest';
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

describe('uninstall cleans the Pi Coding Agent extension injection', () => {
  it('sh defines and calls remove_pi_coding_agent_extension', () => {
    expect(sh).toMatch(/remove_pi_coding_agent_extension\(\)\s*\{/);
    const uninstall = sh.slice(sh.indexOf('cmd_uninstall()'));
    expect(uninstall).toContain('remove_pi_coding_agent_extension');
  });

  it('ps1 defines and calls Remove-PiCodingAgentExtension', () => {
    expect(ps1).toMatch(/function Remove-PiCodingAgentExtension\s*\{/);
    const uninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));
    expect(uninstall).toContain('Remove-PiCodingAgentExtension');
  });

  it('targets Pi settings and matches only the Pilot extension', () => {
    expect(sh).toContain('.pi/agent/settings.json');
    expect(ps1).toContain('.pi\\agent\\settings.json');
    expect(sh).toContain('loongsuite-pilot-pi-coding-agent');
    expect(sh).toContain('plugins/pi-coding-agent/index.mjs');
    expect(ps1).toContain('loongsuite-pilot-pi-coding-agent');
    expect(ps1).toContain('plugins/pi-coding-agent/index.mjs');
  });
});

describe('Windows uninstall verifies scheduled task removal', () => {
  it('uses PowerShell unregister with a checked schtasks fallback', () => {
    const cleanup = ps1.slice(
      ps1.indexOf('function Remove-OnePilotScheduledTask'),
      ps1.indexOf('function Assert-SafePilotDirectory'),
    );
    expect(cleanup).toContain('Unregister-ScheduledTask');
    expect(cleanup).toContain('$schtasksExit = $LASTEXITCODE');
    expect(cleanup).toContain('Scheduled task still exists after deletion');
    expect(cleanup).not.toContain('catch {}');
  });

  it('removes both current-user collector and updater task names', () => {
    const cleanup = ps1.slice(
      ps1.indexOf('function Remove-PilotScheduledTasks'),
      ps1.indexOf('function Assert-SafePilotDirectory'),
    );
    expect(cleanup).toContain('"LoongsuitePilot-$userTag"');
    expect(cleanup).toContain('"LoongsuitePilotUpdater-$userTag"');
    expect(cleanup).toContain('Remove-OnePilotScheduledTask');
  });
});

describe('Windows uninstall has dedicated Codex hook cleanup', () => {
  it('removes only Pilot direct or nested Codex hook commands', () => {
    const cleanup = ps1.slice(
      ps1.indexOf('function Test-IsPilotCodexHookCommand'),
      ps1.indexOf('function Remove-OnePilotScheduledTask'),
    );
    expect(cleanup).toContain('function Remove-CodexHookConfig');
    expect(cleanup).toContain('.codex\\hooks.json');
    expect(cleanup).toContain('codex-loongsuite-pilot-hook');
    expect(cleanup).toContain('otel-codex-hook');
    expect(cleanup).toContain('Pilot Codex nested hook command is still present');
    expect(cleanup).toContain('if ($eventProperties.Count -eq 0) { return }');
    expect(cleanup).toContain('$null -eq $entry');
    expect(cleanup).toContain('$verifyEventProperties');
  });

  it('keeps Codex cleanup separate from the generic hook cleaner', () => {
    const genericCleanup = ps1.slice(
      ps1.indexOf('function Remove-HookConfigs'),
      ps1.indexOf('function Remove-OpenCodePlugin'),
    );
    expect(genericCleanup).not.toContain('.codex\\hooks.json');
  });

  it('calls dedicated Codex cleanup from uninstall', () => {
    const uninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));
    expect(uninstall).toContain('Remove-CodexHookConfig');
    expect(uninstall.indexOf('Remove-CodexHookConfig'))
      .toBeLessThan(uninstall.indexOf('Remove-CodexTrustState'));
  });
});

describe('uninstall cleans the MiMo Code plugin-inject spec', () => {
  it('sh defines remove_mimocode_plugin', () => {
    expect(sh).toMatch(/remove_mimocode_plugin\(\)\s*\{/);
  });

  it('sh calls remove_mimocode_plugin inside cmd_uninstall', () => {
    const uninstall = sh.slice(sh.indexOf('cmd_uninstall()'));
    expect(uninstall).toContain('remove_mimocode_plugin');
  });

  it('ps1 defines Remove-MimoCodePlugin', () => {
    expect(ps1).toMatch(/function Remove-MimoCodePlugin\s*\{/);
  });

  it('ps1 calls Remove-MimoCodePlugin inside Cmd-Uninstall', () => {
    const uninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));
    expect(uninstall).toContain('Remove-MimoCodePlugin');
  });

  for (const cfg of ['mimocode.jsonc', 'mimocode.json']) {
    it(`sh cleans ~/.config/mimocode/${cfg}`, () => {
      expect(sh).toContain(`.config/mimocode/${cfg}`);
    });
    it(`ps1 cleans .config\\mimocode\\${cfg}`, () => {
      expect(ps1).toContain(`.config\\mimocode\\${cfg}`);
    });
  }

  it('matches our entries by pluginId or plugin file path', () => {
    expect(sh).toContain('loongsuite-pilot-mimo-code');
    expect(sh).toContain('plugins/mimo-code/plugin.mjs');
    expect(ps1).toContain('loongsuite-pilot-mimo-code');
    expect(ps1).toContain('plugins/mimo-code/plugin.mjs');
  });
});
