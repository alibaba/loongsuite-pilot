import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const installer = fs.readFileSync(path.resolve('deploy', 'installer-opensource.ps1'), 'utf8');
const cliSource = fs.readFileSync(path.resolve('scripts', 'loongsuite-pilot.ps1'), 'utf8');

function extractPowerShellFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`\nfunction ${nextName}`, start);
  if (start < 0 || end < 0) throw new Error(`cannot extract ${name}`);
  return source.slice(start, end);
}

function psQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

describe.runIf(process.platform === 'win32')('Windows installer lifecycle', () => {
  test('repeated config writes preserve existing fields and checkpoints', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-reinstall-config-'));
    const configPath = path.join(root, 'config.json');
    const checkpoint = path.join(root, 'logs', 'input-state.json');
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ customSetting: 'keep-me', userId: 'existing-user' }));
    fs.writeFileSync(checkpoint, '{"offset":42}\n');

    try {
      const fn = extractPowerShellFunction(installer, 'Write-Config', 'Install-Command');
      const harness = `
$DataDir=${psQuote(root)}
$SlsEndpoint="";$SlsProject="";$SlsLogstore="";$SlsAkId="";$SlsAkSecret=""
$LogLevel="";$CollectLog="";$CollectTrace="";$CmsLicenseKey="";$CmsEndpoint="";$CmsWorkspace=""
$ServiceNamePrefix="";$MaskMode="";$MaskTypes=""
$script:UserId="";$script:SELECTED_AGENTS="";$script:PROBE_RESULT="[]"
$script:NODE_BIN=${psQuote(process.execPath)}
function Msg { param($zh, $en) }
${fn}
Write-Config
`;
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', harness],
        { encoding: 'utf8', timeout: 15_000 },
      );

      expect(result.status, result.stderr).toBe(0);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.customSetting).toBe('keep-me');
      expect(config.userId).toBe('existing-user');
      expect(config.dataDir).toBe(root);
      expect(fs.readFileSync(checkpoint, 'utf8')).toContain('"offset":42');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('normal uninstall preserves durable data in the default co-located layout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-uninstall-shared-'));
    try {
      for (const relative of [
        'versions/v1/VERSION',
        'bin/collector-daemon.js',
        'package/VERSION',
        'current',
        'previous',
        'node-bin',
        'hooks/codex-hook.ps1',
        'skills/README.md',
        'plugins/plugin.json',
        'config.json',
        'logs/input-state.json',
        'logs/output/codex-2026-07-24.jsonl',
        'state/codex/checkpoint.json',
      ]) {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, relative);
      }

      const fn = extractPowerShellFunction(installer, 'Assert-SafePilotDirectory', 'Cmd-Uninstall');
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `$CACHE_DIR=${psQuote(root)};$DataDir=${psQuote(root)};${fn};Remove-PilotInstallationFiles`],
        { encoding: 'utf8', timeout: 15_000 },
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(root, 'versions'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'bin'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'hooks'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'config.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'logs', 'input-state.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'logs', 'output', 'codex-2026-07-24.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'state', 'codex', 'checkpoint.json'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('normal uninstall removes a separate cache but preserves data and checkpoints', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-uninstall-split-'));
    const cacheDir = path.join(root, '缓存');
    const dataDir = path.join(root, '数据');
    fs.mkdirSync(path.join(cacheDir, 'versions', 'v1'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'versions', 'v1', 'VERSION'), 'v1');
    fs.mkdirSync(path.join(dataDir, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'hooks', 'codex.ps1'), 'hook');
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}');
    fs.writeFileSync(path.join(dataDir, 'logs', 'input-state.json'), '{}');

    try {
      const fn = extractPowerShellFunction(installer, 'Assert-SafePilotDirectory', 'Cmd-Uninstall');
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `$CACHE_DIR=${psQuote(cacheDir)};$DataDir=${psQuote(dataDir)};${fn};Remove-PilotInstallationFiles`],
        { encoding: 'utf8', timeout: 15_000 },
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(cacheDir)).toBe(false);
      expect(fs.existsSync(path.join(dataDir, 'hooks'))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, 'config.json'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'logs', 'input-state.json'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('normal uninstall preserves nested data when the cache directory is its parent', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-uninstall-parent-'));
    const dataDir = path.join(cacheDir, 'durable data');
    fs.mkdirSync(path.join(cacheDir, 'versions', 'v1'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'versions', 'v1', 'VERSION'), 'v1');
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}');
    fs.writeFileSync(path.join(dataDir, 'logs', 'input-state.json'), '{}');

    try {
      const fn = extractPowerShellFunction(installer, 'Assert-SafePilotDirectory', 'Cmd-Uninstall');
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `$CACHE_DIR=${psQuote(cacheDir)};$DataDir=${psQuote(dataDir)};${fn};Remove-PilotInstallationFiles`],
        { encoding: 'utf8', timeout: 15_000 },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(cacheDir, 'versions'))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, 'config.json'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'logs', 'input-state.json'))).toBe(true);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('removes only the owned Codex trust block and leaves sessions untouched', () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trust-cleanup-'));
    const codexDir = path.join(profile, '.codex');
    const session = path.join(codexDir, 'sessions', '2026', '07', '24', 'rollout-test.jsonl');
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(session, '{"type":"session_meta"}\n');
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      [
        'model = "gpt-5"',
        '# BEGIN otel-codex-hook trust',
        '[hooks.state."C:\\\\Users\\\\test\\\\.codex\\\\hooks.json:stop:0:0"]',
        'trusted_hash = "sha256:test"',
        '# END otel-codex-hook trust',
        '[projects."C:\\\\work"]',
        'trust_level = "trusted"',
        '',
      ].join('\n'),
    );

    try {
      const fn = extractPowerShellFunction(installer, 'Remove-CodexTrustState', 'Remove-OtelPlugin');
      const harness = `
$env:USERPROFILE=${psQuote(profile)}
function Msg { param($zh, $en) }
${fn}
Remove-CodexTrustState
`;
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', harness],
        { encoding: 'utf8', timeout: 15_000 },
      );

      expect(result.status).toBe(0);
      const config = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
      expect(config).not.toContain('otel-codex-hook trust');
      expect(config).toContain('[projects."C:\\\\work"]');
      expect(fs.existsSync(session)).toBe(true);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });

  test('upgrade preserves config/checkpoints and invokes rollback when startup fails', () => {
    const upgrade = installer.slice(
      installer.indexOf('function Cmd-Upgrade'),
      installer.indexOf('function Remove-PilotScheduledTasks'),
    );

    expect(upgrade).not.toContain('Write-Config');
    expect(upgrade).not.toContain('input-state.json');
    expect(upgrade).toContain('& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path rollback');
    expect(upgrade).toContain('if (-not $started)');
  });

  test('rollback swaps current/previous and supports packages without updater-daemon.js', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-rollback-'));
    const profile = path.join(root, 'profile');
    const cacheDir = path.join(root, 'custom cache');
    const dataDir = path.join(root, 'custom data');
    const binDir = path.join(profile, '.local', 'bin');
    const cli = path.join(binDir, 'loongsuite-pilot.ps1');
    fs.mkdirSync(binDir, { recursive: true });

    const rollbackStart = cliSource.indexOf('function Cmd-Rollback');
    const rollbackEnd = cliSource.indexOf('\n# ============================================================\n# CMD: token-usage', rollbackStart);
    const before = cliSource.slice(0, rollbackStart);
    const rollback = cliSource
      .slice(rollbackStart, rollbackEnd)
      .replace('    Cmd-Restart', '    Write-Host "__restart__"');
    const after = cliSource.slice(rollbackEnd);
    fs.writeFileSync(cli, `${before}${rollback}${after}`);
    fs.writeFileSync(
      path.join(binDir, 'loongsuite-pilot-layout.json'),
      JSON.stringify({ dataDir, cacheDir }),
    );

    for (const [version, marker] of [['old', 'OLD'], ['new', 'NEW']]) {
      const scripts = path.join(cacheDir, 'versions', version, 'scripts');
      fs.mkdirSync(scripts, { recursive: true });
      fs.writeFileSync(path.join(scripts, 'collector-daemon.js'), marker);
      fs.writeFileSync(path.join(scripts, 'loongsuite-pilot.ps1'), `# ${marker}\n`);
    }
    fs.mkdirSync(path.join(cacheDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'bin', 'collector-daemon.js'), 'NEW');
    fs.writeFileSync(path.join(cacheDir, 'current'), 'new\n');
    fs.writeFileSync(path.join(cacheDir, 'previous'), 'old\n');
    fs.writeFileSync(path.join(dataDir, 'logs', 'input-state.json'), '{"checkpoint":true}\n');

    try {
      const env = { ...process.env, USERPROFILE: profile };
      delete env.LOONGSUITE_PILOT_DATA_DIR;
      delete env.LOONGSUITE_PILOT_CACHE_DIR;
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cli, 'rollback'],
        { env, encoding: 'utf8', timeout: 15_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('__restart__');
      expect(fs.readFileSync(path.join(cacheDir, 'current'), 'utf8').trim()).toBe('old');
      expect(fs.readFileSync(path.join(cacheDir, 'previous'), 'utf8').trim()).toBe('new');
      expect(fs.readFileSync(path.join(cacheDir, 'bin', 'collector-daemon.js'), 'utf8')).toBe('OLD');
      expect(fs.readFileSync(cli, 'utf8')).toContain('# OLD');
      expect(fs.readFileSync(path.join(dataDir, 'logs', 'input-state.json'), 'utf8')).toContain('checkpoint');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
