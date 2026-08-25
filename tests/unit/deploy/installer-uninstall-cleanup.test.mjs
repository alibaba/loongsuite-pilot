import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const sh = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf-8');
const ps1 = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf-8');
const runtimeSh = readFileSync(resolve('scripts', 'loongsuite-pilot.sh'), 'utf-8');
const runtimePs1 = readFileSync(resolve('scripts', 'loongsuite-pilot.ps1'), 'utf-8');

function extractPiCleanupNodeScript(source, style) {
  const functionMarker = style === 'sh'
    ? 'remove_pi_coding_agent_extension()'
    : 'function Remove-PiCodingAgentExtension';
  const functionStart = source.indexOf(functionMarker);
  const functionEnd = source.indexOf('# ====', functionStart);
  const body = source.slice(functionStart, functionEnd);
  const scriptStartMarker = style === 'sh' ? 'result=$(node -e "\n' : "-e @'\n";
  const scriptEndMarker = style === 'sh' ? '\n" "$cfg" "$DATA_DIR"' : "\n'@ $cfg $DATA_DIR";
  const scriptStart = body.indexOf(scriptStartMarker) + scriptStartMarker.length;
  const scriptEnd = body.indexOf(scriptEndMarker, scriptStart);
  if (scriptStart < scriptStartMarker.length || scriptEnd < scriptStart) {
    throw new Error(`failed to extract ${style} Pi cleanup script`);
  }
  return body.slice(scriptStart, scriptEnd);
}

function verifyPiCleanupContinuesPastInvalidConfig(script, envKey) {
  const root = mkdtempSync(join(tmpdir(), 'pilot-pi-uninstall-'));
  try {
    const dataDir = join(root, 'pilot-data');
    const definitionsDir = join(dataDir, 'agents.d.local');
    const defaultConfig = join(root, 'default-pi', 'settings.json');
    const goodConfig = join(root, 'good-agent', 'settings.json');
    const badConfig = join(root, 'bad-agent', 'settings.json');
    for (const dir of [definitionsDir, join(root, 'default-pi'), join(root, 'good-agent'), join(root, 'bad-agent')]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(defaultConfig, '{ broken default config');
    writeFileSync(badConfig, '{ broken custom config');
    const managedSpec = join(dataDir, 'plugins', 'pi-coding-agent', 'agents', 'good-code.mjs');
    writeFileSync(goodConfig, `{
  // preserve a backup before normalizing JSONC
  "url": "https://example.test/path//segment",
  "extensions": [
    ${JSON.stringify(managedSpec)},
    "/third-party.mjs"
  ]
}\n`);

    for (const [id, configPath] of [['good-code', goodConfig], ['bad-code', badConfig]]) {
      writeFileSync(join(definitionsDir, `${id}.json`), JSON.stringify({
        id,
        piSdk: { schemaVersion: 1 },
        pluginInject: {
          pluginId: `loongsuite-pilot-pi-sdk-${id}`,
          pluginSpec: `$PILOT_DATA/plugins/pi-coding-agent/agents/${id}.mjs`,
          configPaths: [configPath],
        },
      }));
    }

    const run = spawnSync(process.execPath, ['-e', script, defaultConfig, dataDir], {
      encoding: 'utf8',
      env: { ...process.env, [envKey]: root },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('partial');
    expect(JSON.parse(readFileSync(goodConfig, 'utf8'))).toEqual({
      url: 'https://example.test/path//segment',
      extensions: ['/third-party.mjs'],
    });
    expect(readFileSync(badConfig, 'utf8')).toBe('{ broken custom config');
    expect(existsSync(`${goodConfig}.bak`)).toBe(true);
    expect(readFileSync(`${goodConfig}.bak`, 'utf8')).toContain('// preserve a backup');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function extractOpenClawCleanupScripts() {
  const shMarker = "<<'NODE'\n";
  const shStart = sh.indexOf(shMarker, sh.indexOf('remove_openclaw_plugin()'));
  const psMarker = "$cleanupScript = @'\n";
  const psStart = ps1.indexOf(psMarker, ps1.indexOf('function Remove-OpenClawPlugin'));
  return [
    ['sh', sh.slice(shStart + shMarker.length, sh.indexOf('\nNODE', shStart))],
    ['ps1', ps1.slice(psStart + psMarker.length, ps1.indexOf("\n'@", psStart))],
  ];
}

function extractGrokCleanupNodeScript(source, style) {
  const functionMarker = style === 'sh'
    ? 'remove_grok_build_hook_config()'
    : 'function Remove-GrokBuildHookConfig';
  const functionStart = source.indexOf(functionMarker);
  const functionEnd = source.indexOf('# ====', functionStart);
  const body = source.slice(functionStart, functionEnd);
  const scriptStartMarker = style === 'sh' ? 'result="$(node -e \'\n' : "$result = & $script:NODE_BIN -e @'\n";
  const scriptEndMarker = style === 'sh' ? '\n\' "$cfg"' : "\n'@ $cfg";
  const scriptStart = body.indexOf(scriptStartMarker) + scriptStartMarker.length;
  const scriptEnd = body.indexOf(scriptEndMarker, scriptStart);
  if (scriptStart < scriptStartMarker.length || scriptEnd < scriptStart) {
    throw new Error(`failed to extract ${style} Grok cleanup script`);
  }
  return body.slice(scriptStart, scriptEnd);
}

function verifyGrokCleanupScript(script) {
  const root = mkdtempSync(join(tmpdir(), 'pilot-grok-cleanup-script-'));
  try {
    const configPath = join(root, 'loongsuite-pilot.json');
    writeFileSync(configPath, JSON.stringify({
      hooks: {
        stop: [
          { command: '/custom/pilot/hooks/grok-build-loongsuite-pilot-hook.sh stop' },
          { command: '/opt/third-party/stop-hook.sh' },
          {
            matcher: '',
            hooks: [
              { command: 'powershell.exe -File "C:\\pilot data\\hooks\\grok-build-loongsuite-pilot-hook.ps1" stop' },
              { command: '/opt/third-party/nested-hook.sh' },
            ],
          },
        ],
      },
    }, null, 2));

    const run = spawnSync(process.execPath, ['-e', script, configPath], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('cleaned');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      hooks: {
        stop: [
          { command: '/opt/third-party/stop-hook.sh' },
          {
            matcher: '',
            hooks: [{ command: '/opt/third-party/nested-hook.sh' }],
          },
        ],
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Derive lifecycle coverage from the deployment manifests. New hook agents
// must not require a second hand-maintained list in this test.
const HOOK_CONFIG_FILES = [...new Set(
  readdirSync(resolve('agents.d'))
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(resolve('agents.d', name), 'utf-8')))
    .filter(agent => agent.deployMode === 'hook' && agent.hook?.settingsPath)
    .map(agent => agent.hook.settingsPath.replace(/^~\//, '')),
)].sort();

describe('uninstall cleans hook configs for all hook agents', () => {
  for (const f of HOOK_CONFIG_FILES) {
    it(`sh remove_hook_configs includes ${f}`, () => {
      expect(sh).toContain(`$HOME/${f}`);
    });
    it(`PowerShell uninstall covers ${f}`, () => {
      // Codex uses a dedicated schema-aware cleanup function; checking the
      // complete installer source covers both generic and dedicated cleaners.
      expect(ps1).toContain(f.replace(/\//g, '\\'));
    });
  }

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

  it('discovers registered PI SDK Agent settings from local definitions', () => {
    for (const source of [sh, ps1]) {
      expect(source).toContain('agents.d.local');
      expect(source).toContain('piSdk?.schemaVersion');
      expect(source).toContain('loongsuite-pilot-pi-sdk-');
      expect(source).toContain('plugins/pi-coding-agent/agents/');
    }
  });

  it.each([
    ['Unix', extractPiCleanupNodeScript(sh, 'sh'), 'HOME'],
    ['Windows', extractPiCleanupNodeScript(ps1, 'ps1'), 'USERPROFILE'],
  ])('%s cleanup accepts JSONC and continues past damaged targets', (_platform, script, envKey) => {
    verifyPiCleanupContinuesPastInvalidConfig(script, envKey);
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

  it('passes a valid fs module literal to node when rewriting Codex files', () => {
    const writer = ps1.slice(
      ps1.indexOf('function Write-FileUtf8NoBom'),
      ps1.indexOf('function Remove-CodexTrustState'),
    );
    expect(writer).toContain("$rewriteScript = @'");
    expect(writer).toContain("const fs = require('fs');");
    expect(writer).not.toContain("-e 'const fs=require(\"fs\")");
    expect(writer).toContain('if ($rewriteExit -ne 0)');

    const script = writer.match(/\$rewriteScript = @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
    expect(script).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'pilot-codex-rewrite-'));
    try {
      const input = join(root, 'input.txt');
      const output = join(root, 'output.txt');
      writeFileSync(input, '\uFEFFcodex-hook-config', 'utf8');
      const run = spawnSync(process.execPath, ['-e', script, input, output], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('codex-hook-config');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('continues uninstall when dedicated Codex cleanup fails', () => {
    const uninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));
    expect(uninstall).toMatch(/try\s*\{\s*Remove-CodexHookConfig\s*\}\s*catch\s*\{/);
    expect(uninstall).toMatch(/try\s*\{\s*Remove-CodexTrustState\s*\}\s*catch\s*\{/);
    expect(uninstall).toContain('Codex hook cleanup failed; continuing uninstall');
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

describe('uninstall cleans only the Pilot OpenClaw plugin injection', () => {
  it('defines and calls cleanup in both installers', () => {
    expect(sh).toMatch(/remove_openclaw_plugin\(\)\s*\{/);
    expect(sh.slice(sh.indexOf('cmd_uninstall()'))).toContain('remove_openclaw_plugin');
    expect(ps1).toMatch(/function Remove-OpenClawPlugin\s*\{/);
    expect(ps1.slice(ps1.indexOf('function Cmd-Uninstall'))).toContain('Remove-OpenClawPlugin');
  });

  it('checks the supported config paths and environment overrides', () => {
    for (const marker of ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'openclaw.json', 'config.json']) {
      expect(sh).toContain(marker);
      expect(ps1).toContain(marker);
    }
  });

  it('removes the exact entry and managed path while filtering arrays', () => {
    for (const installer of [sh, ps1]) {
      expect(installer).toContain("delete plugins.entries['loongsuite-pilot-openclaw']");
      expect(installer).toContain("plugins.load.paths.filter(value => !isOurs(value))");
      expect(installer).toContain("['plugin', 'plugins']");
      expect(installer).toContain("plain === managed + '/plugin.mjs'");
      expect(installer).toContain('plugins/openclaw/plugin.mjs');
    }
  });

  it('streams cleanup code and paths without putting openclaw in Node argv', () => {
    const shCleanup = sh.slice(
      sh.indexOf('remove_openclaw_plugin()'),
      sh.indexOf('# CMD: uninstall', sh.indexOf('remove_openclaw_plugin()')),
    );
    const psCleanup = ps1.slice(
      ps1.indexOf('function Remove-OpenClawPlugin'),
      ps1.indexOf('# Remove OTel plugin', ps1.indexOf('function Remove-OpenClawPlugin')),
    );

    expect(shCleanup).not.toMatch(/node\s+-e/);
    expect(shCleanup).toContain('PILOT_OC_CONFIG="$cfg" PILOT_OC_MANAGED="$managed_path" node');
    expect(psCleanup).not.toContain('& $script:NODE_BIN -e');
    expect(psCleanup).toContain('$cleanupScript | & $script:NODE_BIN');
  });

  it.each(extractOpenClawCleanupScripts())(
    '%s streamed cleanup removes both current and legacy managed paths',
    (_platform, cleanupScript) => {
      const configPath = '/tmp/pilot-openclaw-config.json';
      const managedPath = '/tmp/.loongsuite-pilot/plugins/openclaw';
      let writtenConfig;
      let stdout = '';
      let stderr = '';
      const fs = {
        readFileSync(path, encoding) {
          expect(path).toBe(configPath);
          expect(['utf8', 'utf-8']).toContain(encoding);
          return JSON.stringify({
            plugin: [`file://${managedPath}/plugin.mjs`, '/unrelated/legacy.mjs'],
            plugins: {
              load: { paths: [managedPath, `${managedPath}/plugin.mjs`, '/unrelated/plugin'] },
              entries: {
                'loongsuite-pilot-openclaw': { enabled: true },
                unrelated: { enabled: true },
              },
            },
          });
        },
        writeFileSync(path, value, encoding) {
          expect(path).toBe(configPath);
          expect(['utf8', 'utf-8']).toContain(encoding);
          writtenConfig = value;
        },
      };
      const sandboxProcess = {
        env: {
          PILOT_OC_CONFIG: configPath,
          PILOT_OC_MANAGED: managedPath,
        },
        stdout: { write: value => { stdout += value; } },
        stderr: { write: value => { stderr += value; } },
        exit: code => { throw new Error(`cleanup unexpectedly exited with ${code}: ${stderr}`); },
      };

      runInNewContext(cleanupScript, {
        process: sandboxProcess,
        require(id) {
          expect(id).toBe('fs');
          return fs;
        },
      });

      expect(stdout).toBe('cleaned');
      expect(stderr).toBe('');
      const cleaned = JSON.parse(writtenConfig);
      expect(cleaned.plugin).toEqual(['/unrelated/legacy.mjs']);
      expect(cleaned.plugins.load.paths).toEqual(['/unrelated/plugin']);
      expect(cleaned.plugins.entries).toEqual({ unrelated: { enabled: true } });
    },
  );

  it('runs cleanup before installation files are removed', () => {
    const shUninstall = sh.slice(sh.indexOf('cmd_uninstall()'));
    expect(shUninstall.indexOf('remove_openclaw_plugin'))
      .toBeLessThan(shUninstall.indexOf('local _cache_dir="$HOME/.loongsuite-pilot"'));
    const psUninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));
    expect(psUninstall.indexOf('Remove-OpenClawPlugin'))
      .toBeLessThan(psUninstall.indexOf('Remove-PilotInstallationFiles'));
  });
});

describe('uninstall only cleans the managed Hermes directory plugin', () => {
  it('defines and calls marker-aware cleanup in the shell installer', () => {
    expect(sh).toMatch(/remove_hermes_plugin\(\)\s*\{/);
    expect(sh.slice(sh.indexOf('cmd_uninstall()'))).toContain('remove_hermes_plugin');
    expect(sh).toContain('.loongsuite-pilot-managed.json');
    expect(sh).toContain("meta.owner !== 'loongsuite-pilot'");
    expect(sh).toContain("meta.agentId !== 'hermes-agent'");
    expect(sh).toContain("state?.['hermes-agent']?.targetDir");
    expect(sh).toContain('plugins disable loongsuite-pilot');
    const uninstall = sh.slice(sh.indexOf('cmd_uninstall()'));
    expect(uninstall.indexOf('remove_hermes_plugin'))
      .toBeLessThan(uninstall.indexOf('local _cache_dir="$HOME/.loongsuite-pilot"'));
  });

  it('defines and calls marker-aware cleanup in the PowerShell installer', () => {
    expect(ps1).toMatch(/function Remove-HermesPlugin\s*\{/);
    expect(ps1.slice(ps1.indexOf('function Cmd-Uninstall'))).toContain('Remove-HermesPlugin');
    expect(ps1).toContain('.loongsuite-pilot-managed.json');
    expect(ps1).toContain('$meta.owner -ne "loongsuite-pilot"');
    expect(ps1).toContain('$meta.agentId -ne "hermes-agent"');
    expect(ps1).toContain("$state.'hermes-agent'.targetDir");
    expect(ps1).toContain('plugins disable loongsuite-pilot');
    const uninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));
    expect(uninstall.indexOf('Remove-HermesPlugin'))
      .toBeLessThan(uninstall.indexOf('Remove-PilotInstallationFiles'));
  });

  it('removes Hermes on rollback only when the target version lacks support', () => {
    expect(runtimeSh).toMatch(/cleanup_hermes_for_rollback\(\)\s*\{/);
    expect(runtimeSh).toContain('agents.d/hermes-agent.json');
    expect(runtimeSh.slice(runtimeSh.indexOf('cmd_rollback()')))
      .toContain('cleanup_hermes_for_rollback');
    expect(runtimePs1).toMatch(/function Remove-HermesPluginForRollback\s*\{/);
    expect(runtimePs1).toContain('agents.d\\hermes-agent.json');
    expect(runtimePs1.slice(runtimePs1.indexOf('function Cmd-Rollback')))
      .toContain('Remove-HermesPluginForRollback');
  });
});

describe('Grok Build uninstall smoke', () => {
  it('cleans the Windows Grok config before deleting the pinned runtime and assets', () => {
    const uninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));
    expect(uninstall.indexOf('Remove-GrokBuildHookConfig'))
      .toBeLessThan(uninstall.indexOf('Remove-PilotInstallationFiles'));
    expect(uninstall.match(/Remove-GrokBuildHookConfig/g)).toHaveLength(1);
  });

  it.each([
    ['POSIX', extractGrokCleanupNodeScript(sh, 'sh')],
    ['PowerShell', extractGrokCleanupNodeScript(ps1, 'ps1')],
  ])('%s cleanup removes direct/nested Pilot hooks and preserves third-party hooks', (_platform, script) => {
    verifyGrokCleanupScript(script);
  });

  it('removes Pilot direct and nested hooks from an isolated HOME and preserves third-party hooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'pilot-grok-uninstall-'));
    try {
      const configDir = join(root, '.grok', 'hooks');
      const configPath = join(configDir, 'loongsuite-pilot.json');
      const dataDir = join(root, 'custom pilot data');
      mkdirSync(configDir, { recursive: true });
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({
        hooks: {
          stop: [
            { command: `\"${join(dataDir, 'hooks', 'grok-build-loongsuite-pilot-hook.sh')}\" stop` },
            { command: '/opt/third-party/stop-hook.sh' },
            {
              matcher: '',
              hooks: [
                { command: `powershell.exe -File \"${join(dataDir, 'hooks', 'grok-build-loongsuite-pilot-hook.ps1')}\" stop` },
                { command: '/opt/third-party/nested-hook.sh' },
              ],
            },
          ],
          session_end: [
            { command: `${join(dataDir, 'hooks', 'grok-build-loongsuite-pilot-hook.sh')} session_end` },
          ],
        },
      }, null, 2));

      const run = spawnSync('/bin/bash', [
        resolve('deploy', 'installer-opensource.sh'),
        'uninstall',
        '--data-dir',
        dataDir,
        '--lang',
        'en',
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          // Exclude a developer-machine Pilot binary while retaining Node and
          // standard system tools. The uninstall must stay inside this HOME.
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        },
      });

      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
        hooks: {
          stop: [
            { command: '/opt/third-party/stop-hook.sh' },
            {
              matcher: '',
              hooks: [{ command: '/opt/third-party/nested-hook.sh' }],
            },
          ],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('Windows QoderWork-family runtime override lifecycle', () => {
  const runtimeSection = ps1.slice(
    ps1.indexOf('function Get-PilotRuntimeOverride'),
    ps1.indexOf('function Install-Command'),
  );
  const uninstall = ps1.slice(ps1.indexOf('function Cmd-Uninstall'));

  it('uses the final agent config and independently maintains both environment variables', () => {
    expect(runtimeSection).toContain('config?.agents?.[agentId]?.enabled === false');
    expect(runtimeSection).toContain('QW_QODER_WORKER_RUNTIME_PATH');
    expect(runtimeSection).toMatch(/\bQODER_WORKER_RUNTIME_PATH\b/);
    expect(runtimeSection).toContain("Test-AgentCollectionEnabled -AgentId 'qwen-work-cn'");
    expect(runtimeSection).toContain("Test-AgentCollectionEnabled -AgentId 'qoder-work'");
    expect(runtimeSection).toContain("Test-AgentCollectionEnabled -AgentId 'qoder-work-cn'");
    expect(ps1.match(/Inject-QoderworkRuntimeWrapper/g)).toHaveLength(3);
  });

  it('uses CLM-safe registry persistence with a guarded Explorer broadcast', () => {
    expect(runtimeSection).toContain('reg.exe query "HKCU\\Environment"');
    expect(runtimeSection).toContain('reg.exe add "HKCU\\Environment"');
    expect(runtimeSection).toContain('reg.exe delete "HKCU\\Environment"');
    expect(runtimeSection).toContain('[Environment]::SetEnvironmentVariable');
    expect(runtimeSection).toContain('catch {');
    expect(runtimeSection).toContain('sign out and back in');
  });

  it('treats a missing runtime override as absent instead of aborting under ErrorActionPreference Stop', () => {
    const getter = runtimeSection.slice(
      runtimeSection.indexOf('function Get-PilotRuntimeOverride'),
      runtimeSection.indexOf('function Test-AgentCollectionEnabled'),
    );
    expect(getter).toContain('$prevEAP = $ErrorActionPreference');
    expect(getter).toContain('$ErrorActionPreference = "Continue"');
    expect(getter).toContain('$regExitCode = $LASTEXITCODE');
    expect(getter).toContain('$ErrorActionPreference = $prevEAP');
    expect(getter.indexOf('$ErrorActionPreference = $prevEAP'))
      .toBeLessThan(getter.indexOf('if ($regExitCode -ne 0)'));
  });

  it('detects app roots without assuming executables are outside version directories', () => {
    expect(runtimeSection).toContain('Programs\\QwenWorkCN');
    expect(runtimeSection).toContain('Programs\\QoderWork');
    expect(runtimeSection).toContain('Programs\\QoderWorkCN');
    expect(runtimeSection).toContain('Programs\\QoderWork CN');
    expect(runtimeSection).not.toContain('QoderWork\\QoderWork.exe');
    expect(runtimeSection).not.toContain('QoderWorkCN\\QoderWorkCN.exe');
  });

  it('cleans an owned override before returning when the wrapper is missing', () => {
    const sync = runtimeSection.slice(runtimeSection.indexOf('function Sync-PilotRuntimeOverride'));
    expect(sync.indexOf('Get-PilotRuntimeOverride')).toBeLessThan(sync.indexOf('Test-Path $WrapperPath'));
    expect(sync).toContain('Remove-PilotRuntimeOverride -Name $Name');
    expect(sync).toContain('Wrapper missing; cleaned $Name');
    expect(sync).toContain('Wrapper missing; did not set $Name');
    expect(sync).toContain('$script:RUNTIME_WRAPPER_MISSING = $true');
  });

  it('uninstalls both overrides only when owned by the current dataDir', () => {
    expect(uninstall).toContain("@('QW_QODER_WORKER_RUNTIME_PATH', 'QODER_WORKER_RUNTIME_PATH')");
    expect(uninstall).toContain('$currentRuntime -ieq $wrapperPath');
    expect(uninstall).not.toContain("*\\hooks\\qoderwork-runtime-wrapper.mjs");
  });

  it('continues external cleanup but preserves retry assets when runtime env cleanup fails', () => {
    const envCleanup = uninstall.slice(
      uninstall.indexOf("foreach ($envName in @('QW_QODER_WORKER_RUNTIME_PATH', 'QODER_WORKER_RUNTIME_PATH'))"),
      uninstall.indexOf('if ($script:RUNTIME_ENV_BROADCAST_FAILED)'),
    );
    expect(envCleanup).toMatch(/foreach[\s\S]*try\s*\{[\s\S]*Remove-PilotRuntimeOverride[\s\S]*\}\s*catch\s*\{/);
    expect(envCleanup).toContain('$runtimeEnvCleanupFailed = $true');
    expect(uninstall.indexOf('Remove-MimoCodePlugin'))
      .toBeLessThan(uninstall.indexOf('if ($runtimeEnvCleanupFailed)'));
    expect(uninstall.indexOf('if ($runtimeEnvCleanupFailed)'))
      .toBeLessThan(uninstall.indexOf('Remove-PilotInstallationFiles'));
    expect(uninstall).toContain('installation files were preserved for retry');
  });

  it('cleans hook configs and runtime overrides before deleting their files and pinned node', () => {
    expect(uninstall.indexOf('Remove-HookConfigs'))
      .toBeLessThan(uninstall.indexOf("@('QW_QODER_WORKER_RUNTIME_PATH', 'QODER_WORKER_RUNTIME_PATH')"));
    expect(uninstall.indexOf("@('QW_QODER_WORKER_RUNTIME_PATH', 'QODER_WORKER_RUNTIME_PATH')"))
      .toBeLessThan(uninstall.indexOf('Remove-PilotInstallationFiles'));
    expect(uninstall.indexOf('Remove-MimoCodePlugin'))
      .toBeLessThan(uninstall.indexOf('Remove-PilotInstallationFiles'));
  });
});
