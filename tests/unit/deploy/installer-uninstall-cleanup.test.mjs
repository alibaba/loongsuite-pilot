import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
  '.grok/hooks/loongsuite-pilot.json',
  '.workbuddy/settings.json',
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

  it('matches Pilot hook basenames when a custom data directory is used', () => {
    expect(sh).toContain('-loongsuite-pilot-hook');
    expect(ps1).toContain('-loongsuite-pilot-hook');
    expect(sh).toContain('markers.some(marker => cmd.includes(marker))');
    expect(ps1).toContain('markers.some(marker => cmd.includes(marker))');
  });

  it('checks direct and nested commands while preserving unrelated entries', () => {
    for (const installer of [sh, ps1]) {
      expect(installer).toContain('Array.isArray(e.hooks)');
      expect(installer).toContain('const filtered = entries.filter');
      expect(installer).toContain('return !hasMarker');
    }
  });

  it.runIf(process.platform !== 'win32')(
    'POSIX cleanup removes custom-dataDir Grok hooks and preserves third-party hooks',
    () => {
      const root = mkdtempSync(resolve(tmpdir(), 'pilot-uninstall-grok-'));
      try {
        const grokDir = resolve(root, '.grok', 'hooks');
        mkdirSync(grokDir, { recursive: true });
        const settingsPath = resolve(grokDir, 'loongsuite-pilot.json');
        writeFileSync(settingsPath, JSON.stringify({
          hooks: {
            stop: [
              {
                matcher: '',
                hooks: [{
                  command: '/opt/custom-pilot/hooks/grok-build-loongsuite-pilot-hook.sh stop',
                  type: 'command',
                }],
              },
              {
                matcher: '',
                hooks: [{
                  command: '/opt/third-party/grok-hook.sh stop',
                  type: 'command',
                }],
              },
            ],
            subagent_start: [{
              command: '/opt/custom-pilot/hooks/grok-build-loongsuite-pilot-hook.sh subagent-start',
            }],
          },
        }), 'utf8');

        const start = sh.indexOf('remove_hook_configs()');
        const end = sh.indexOf('\n# ============================================================', start + 1);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const scriptPath = resolve(root, 'cleanup.sh');
        writeFileSync(scriptPath, [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'msg() { :; }',
          sh.slice(start, end),
          'remove_hook_configs',
          '',
        ].join('\n'), { mode: 0o755 });

        execFileSync('bash', [scriptPath], {
          env: { ...process.env, HOME: root },
          stdio: 'pipe',
        });

        const cleaned = JSON.parse(readFileSync(settingsPath, 'utf8'));
        expect(cleaned.hooks.stop).toEqual([{
          matcher: '',
          hooks: [{
            command: '/opt/third-party/grok-hook.sh stop',
            type: 'command',
          }],
        }]);
        expect(cleaned.hooks.subagent_start).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('ps1 removes the empty hooks object after the last Pilot hook', () => {
    const cleanup = ps1.slice(
      ps1.indexOf('function Remove-HookConfigs'),
      ps1.indexOf('function Remove-OpenCodePlugin'),
    );
    expect(cleanup).toContain('if (Object.keys(hooks).length === 0)');
    expect(cleanup).toContain('delete data.hooks');
  });
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

  // Regression for the 2026-07-29 bug where a rebase resolution dropped the
  // opening `$configs = @(` line of Remove-OpenCodePlugin, leaving the
  // foreach loop referencing an undefined $configs and breaking PowerShell
  // parsing of the whole uninstall flow.
  it('ps1 Remove-OpenCodePlugin body opens with $configs = @(', () => {
    const fn = ps1.slice(
      ps1.indexOf('function Remove-OpenCodePlugin'),
      ps1.indexOf('function Remove-PiCodingAgentExtension'),
    );
    expect(fn).toMatch(/function Remove-OpenCodePlugin\s*\{\s*\n\s*\$configs\s*=\s*@\(/);
  });
});

// Regression for the 2026-07-29 bug where two orphan `}` survived after
// Remove-MimoCodePlugin's closing brace (rebase artifact), throwing the
// whole .ps1 brace balance off and breaking PowerShell parsing. The brace
// counts must match across the entire file — PowerShell is whitespace- and
// brace-sensitive, so even one orphan brace aborts the uninstall flow.
describe('installer-opensource.ps1 brace balance', () => {
  it('open { count equals close } count across the whole file', () => {
    const open = (ps1.match(/\{/g) || []).length;
    const close = (ps1.match(/\}/g) || []).length;
    expect(open).toBe(close);
  });

  it('Remove-MimoCodePlugin is followed by exactly one closing brace', () => {
    // Find the function, then check that immediately after its closing
    // `}` (which we locate by scanning to the next `# ===` banner) there
    // is no orphan `}`.
    const start = ps1.indexOf('function Remove-MimoCodePlugin');
    expect(start).toBeGreaterThan(-1);
    const end = ps1.indexOf('# ====', start);
    expect(end).toBeGreaterThan(start);
    const body = ps1.slice(start, end);
    // The function body must be brace-balanced on its own.
    const open = (body.match(/\{/g) || []).length;
    const close = (body.match(/\}/g) || []).length;
    expect(open).toBe(close);
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

describe('Windows uninstall removes deep installation trees', () => {
  it('uses the extended-length path API instead of recursive Remove-Item', () => {
    const cleanup = ps1.slice(
      ps1.indexOf('function ConvertTo-ExtendedLengthPath'),
      ps1.indexOf('function Cmd-Uninstall'),
    );
    expect(cleanup).toContain('function Remove-PilotPath');
    expect(cleanup).toContain('return "\\\\?\\$fullPath"');
    expect(cleanup).toContain('[System.IO.Directory]::Delete($extendedPath, $true)');
    expect(cleanup).not.toContain('Remove-Item -LiteralPath $target -Recurse -Force');
  });
});

describe('Windows uninstall reuses the installer-pinned Node runtime', () => {
  it('resolves node-bin before PATH-based candidates and before removing installation files', () => {
    const resolver = ps1.slice(
      ps1.indexOf('function Resolve-Node'),
      ps1.indexOf('function Check-Deps'),
    );
    expect(resolver).toContain('(Join-Path $DataDir "node-bin")');
    expect(resolver.indexOf('(Join-Path $DataDir "node-bin")'))
      .toBeLessThan(resolver.indexOf('# nvm-windows'));

    const uninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));
    expect(uninstall).toContain('$script:NODE_BIN = Resolve-Node');
    expect(uninstall.indexOf('$script:NODE_BIN = Resolve-Node'))
      .toBeLessThan(uninstall.indexOf('Remove-PilotInstallationFiles'));
    expect(uninstall).toContain('Remove-PilotPath -Path $safeDataDir');
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
