import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const installerSh = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');
const installerPs1 = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf8');

const bashPrelude = installerSh.slice(0, installerSh.indexOf('# Validate current user'));
const bashConfig = installerSh.slice(
  installerSh.indexOf('write_config() {'),
  installerSh.indexOf('install_loongsuite_pilot_command() {'),
);
const bashConfirm = installerSh.slice(
  installerSh.indexOf('confirm_config_overwrite() {'),
  installerSh.indexOf('deploy_bootstrap_scripts() {'),
);
const psConfig = installerPs1.slice(
  installerPs1.indexOf('function Write-Config {'),
  installerPs1.indexOf('function Install-Command {'),
);
const psConfigJs = psConfig.match(/-e @'\r?\n([\s\S]*?)\r?\n'@ \$cfgTmp/)?.[1];

function runBashConfig(args = [], existing) {
  const root = mkdtempSync(resolve(tmpdir(), 'pilot-interceptor-install-'));
  const configPath = resolve(root, 'config.json');
  try {
    if (existing !== undefined) writeFileSync(configPath, JSON.stringify(existing));
    const result = spawnSync('bash', ['-c', `${bashPrelude}
msg() { :; }
NODE_BIN="$PILOT_TEST_NODE"
PROBE_RESULT='[]'
${bashConfirm}
${bashConfig}
confirm_config_overwrite
write_config`, 'installer-test', 'install', '--data-dir', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PILOT_TEST_NODE: process.execPath },
    });
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined;
    return { ...result, config };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runPowerShellJs(opts, existing) {
  expect(psConfigJs).toBeTruthy();
  const root = mkdtempSync(resolve(tmpdir(), 'pilot-interceptor-ps-'));
  const configPath = resolve(root, 'config.json');
  try {
    if (existing !== undefined) writeFileSync(configPath, JSON.stringify(existing));
    const optsPath = resolve(root, 'options.json');
    writeFileSync(optsPath, JSON.stringify({ configPath, dataDir: root, ...opts }));
    const result = spawnSync(process.execPath, ['-e', psConfigJs, optsPath], { encoding: 'utf8' });
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined;
    return { ...result, config };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('installer interceptor flags', () => {
  it('shell installer mirrors mask flag parsing, validation, and config write', () => {
    expect(installerSh).toContain('--interceptor-mode)');
    expect(installerSh).toContain('--interceptor-mode=*)');
    expect(installerSh).not.toContain('--interceptor-types)');
    expect(installerSh).toContain("Unknown interceptor mode:");
    expect(installerSh).toContain("use 'all' or 'none'");
    expect(installerSh).toContain("label: 'interceptor.mode'");
    expect(installerSh).not.toContain("label: 'interceptor.types'");
    expect(installerSh).toContain('config.interceptor.mode = interceptorMode');
    expect(installerSh).toContain('delete config.interceptor.types');
    expect(installerSh).toContain('ensureMaskCoversInterceptor');
  });

  it('PowerShell installer mirrors mask flag parsing, validation, and config write', () => {
    expect(installerPs1).toContain('[string]$InterceptorMode');
    expect(installerPs1).not.toContain('[string]$InterceptorTypes');
    expect(installerPs1).toContain('Unknown interceptor mode:');
    expect(installerPs1).toContain("use 'all' or 'none'");
    expect(installerPs1).toContain("label: 'interceptor.mode'");
    expect(installerPs1).not.toContain("label: 'interceptor.types'");
    expect(installerPs1).toContain('config.interceptor.mode = opts.interceptorMode');
    expect(installerPs1).toContain('delete config.interceptor.types');
    expect(installerPs1).toContain('ensureMaskCoversInterceptor');
  });

  it('writes interceptor.mode=all and drops types', () => {
    const result = runBashConfig(['--interceptor-mode', 'all'], {
      interceptor: { mode: 'custom', types: ['apiKey'] },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.config.interceptor).toEqual({ mode: 'all' });
    expect(result.config.mask).toEqual({
      mode: 'custom',
      types: ['cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl'],
    });
  });

  it('rejects custom interceptor mode', () => {
    const result = runBashConfig(['--interceptor-mode', 'custom']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown interceptor mode: custom');
    expect(result.config).toBeUndefined();
  });

  it('preserves an existing interceptor object when flags are omitted', () => {
    const existing = { interceptor: { mode: 'custom', types: ['privateKey'] }, logLevel: 'debug' };
    const result = runBashConfig([], existing);
    expect(result.status, result.stderr).toBe(0);
    expect(result.config).toMatchObject(existing);
    expect(result.config.mask).toBeUndefined();
  });

  it('shows interceptor.mode in the overwrite prompt', () => {
    const changed = runBashConfig(['--interceptor-mode', 'all'], { interceptor: { mode: 'none' } });
    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.stdout).toContain('interceptor.mode: none -> all');
  });

  it('rejects unknown interceptor mode before writing config', () => {
    const existing = { interceptor: { mode: 'none' } };
    const result = runBashConfig(['--interceptor-mode', 'audit'], existing);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown interceptor mode: audit");
    expect(result.config).toEqual(existing);
  });

  it('PowerShell JS writer matches the shell interceptor config shape', () => {
    const all = runPowerShellJs({ interceptorMode: 'all', interceptorTypes: 'apiKey' }, {
      interceptor: { mode: 'custom', types: ['apiKey'] },
    });
    expect(all.status, all.stderr).toBe(0);
    expect(all.config.interceptor).toEqual({ mode: 'all' });
    expect(all.config.mask).toEqual({
      mode: 'custom',
      types: ['cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl'],
    });

  });

  describe('mask covers interceptor types', () => {
    it('adds every interceptor type when interceptor is all and mask is custom', () => {
      const result = runBashConfig([
        '--interceptor-mode', 'all',
        '--mask-mode', 'custom',
        '--mask-types', 'idCard',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.config.interceptor).toEqual({ mode: 'all' });
      expect(result.config.mask).toEqual({
        mode: 'custom',
        types: ['idCard', 'cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl'],
      });
    });

    it('promotes mask none to custom so credential mask types are covered', () => {
      const result = runBashConfig([
        '--interceptor-mode', 'all',
        '--mask-mode', 'none',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.config.mask).toEqual({
        mode: 'custom',
        types: ['cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl'],
      });
    });

    it('leaves mask all unchanged because it already covers interceptor types', () => {
      const result = runBashConfig([
        '--interceptor-mode', 'all',
        '--mask-mode', 'all',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.config.mask).toEqual({ mode: 'all' });
    });

    it('does not duplicate types already present in mask custom', () => {
      const result = runBashConfig([
        '--interceptor-mode', 'all',
        '--mask-mode', 'custom',
        '--mask-types', 'apiKey,idCard',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.config.mask).toEqual({
        mode: 'custom',
        types: ['apiKey', 'idCard', 'cloudAccessKey', 'privateKey', 'databaseUrl'],
      });
    });

    it('shows expanded mask.types in the overwrite prompt', () => {
      const result = runBashConfig([
        '--interceptor-mode', 'all',
        '--mask-mode', 'custom',
        '--mask-types', 'idCard',
      ], { mask: { mode: 'custom', types: ['idCard'] } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('mask.types: idCard -> idCard,cloudAccessKey,apiKey,privateKey,databaseUrl');
    });

    it('PowerShell JS writer also unions interceptor types into mask custom', () => {
      const result = runPowerShellJs({
        interceptorMode: 'all',
        maskMode: 'custom',
        maskTypes: 'idCard',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.config.mask).toEqual({
        mode: 'custom',
        types: ['idCard', 'cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl'],
      });
    });
  });
});
