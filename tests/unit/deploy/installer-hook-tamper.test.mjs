import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/core/config-loader.ts';

const installerSh = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');
const installerPs1 = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf8');

function sliceBlock(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

function applyShellMerge(config, value) {
  const code = sliceBlock(
    installerSh,
    'const hookTamperProtection = process.env.LP_HOOK_TAMPER_PROTECTION',
    'const INTERCEPTOR_MASK_TYPES',
  );
  runInNewContext(code, { config, process: { env: { LP_HOOK_TAMPER_PROTECTION: value } } });
}

function applyPowerShellMerge(config, value) {
  const code = sliceBlock(installerPs1, 'if (opts.hookTamperProtection)', 'if (opts.interceptorMode)');
  runInNewContext(code, { config, opts: { hookTamperProtection: value } });
}

describe('installer hook tamper protection flag', () => {
  it('rejects the flag when its value is missing', () => {
    const result = spawnSync('bash', [
      resolve('deploy', 'installer-opensource.sh'),
      'install',
      '--hook-tamper-protection',
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--hook-tamper-protection requires true or false');
  });

  it('rejects a value other than true or false before install starts', () => {
    const result = spawnSync('bash', [
      resolve('deploy', 'installer-opensource.sh'),
      'install',
      '--hook-tamper-protection',
      'maybe',
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--hook-tamper-protection requires true or false');
  });

  it('rejects the flag outside install', () => {
    const result = spawnSync('bash', [
      resolve('deploy', 'installer-opensource.sh'),
      'upgrade',
      '--hook-tamper-protection',
      'true',
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--hook-tamper-protection is only supported with install');
  });

  it('PowerShell declares the same flag and install-only check', () => {
    expect(installerPs1).toContain('[ValidateSet("true", "false")]');
    expect(installerPs1).toContain('[string]$HookTamperProtection');
    expect(installerPs1).toContain("-HookTamperProtection is only supported with install");
    expect(installerPs1).toContain('hookTamperProtection = "$HookTamperProtection"');
    expect(installerSh).toContain('HOOK_TAMPER_PROTECTION_SET=1');
    expect(installerSh).toContain('--hook-tamper-protection=*)');
    expect(installerSh).toContain('LP_HOOK_TAMPER_PROTECTION="$HOOK_TAMPER_PROTECTION"');
  });

  it.each([
    ['shell', applyShellMerge],
    ['powershell', applyPowerShellMerge],
  ])('%s writes the child switch without turning the watchdog parent back on', (_name, apply) => {
    const keptOff = { hookWatchdog: { enabled: false, tamperProtection: { enabled: false } } };
    apply(keptOff, 'true');
    expect(keptOff.hookWatchdog.enabled).toBe(false);
    expect(keptOff.hookWatchdog.tamperProtection.enabled).toBe(true);

    const keptOn = { hookWatchdog: { enabled: true, tamperProtection: { enabled: true } } };
    apply(keptOn, '');
    expect(keptOn.hookWatchdog.tamperProtection.enabled).toBe(true);

    const fresh = {};
    apply(fresh, '');
    expect(fresh.hookWatchdog).toBeUndefined();
  });

  it('a config written by install is still the effective switch after the process reads it again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-tamper-install-'));
    const configPath = join(dir, 'config.json');
    const config = { hookWatchdog: { enabled: false } };
    applyShellMerge(config, 'true');
    writeFileSync(configPath, JSON.stringify(config));
    const previous = process.env.AGENT_DATA_COLLECTION_CONFIG;
    process.env.AGENT_DATA_COLLECTION_CONFIG = configPath;
    try {
      const loaded = await loadConfig();
      expect(loaded.hookWatchdog.enabled).toBe(false);
      expect(loaded.hookWatchdog.tamperProtection).toBe(false);
      expect(loaded.autoUpdate?.tamperProtection).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.AGENT_DATA_COLLECTION_CONFIG;
      else process.env.AGENT_DATA_COLLECTION_CONFIG = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
