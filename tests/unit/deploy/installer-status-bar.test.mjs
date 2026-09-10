import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);

const shell = readFileSync(resolve('deploy/installer-opensource.sh'), 'utf8');
const ps = readFileSync(resolve('deploy/installer-opensource.ps1'), 'utf8');
const shellPrelude = shell.slice(0, shell.indexOf('# Validate current user'));
const shellWriter = shell.slice(shell.indexOf('write_config() {'), shell.indexOf('install_loongsuite_pilot_command() {'));
const psPrelude = ps.slice(0, ps.indexOf('# Resolve package URL'));
const psWriter = ps.slice(ps.indexOf('function Write-Config {'), ps.indexOf('# QoderWork-family runtime wrapper:'));
const psJs = psWriter.match(/-e @'\r?\n([\s\S]*?)\r?\n'@ \$cfgTmp/)?.[1];
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const hasPowerShell = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;

// Exercise the real parser and capture its expanded Node program, then execute
// that program in-process against a temporary data dir. This tests shell-to-JS
// value transport without requiring a second Node runtime or any installation.
function runConfig(platform, args = [], existing, command = 'install') {
  const root = mkdtempSync(resolve(tmpdir(), 'pilot-status-bar-config-'));
  const configPath = resolve(root, 'config.json');
  try {
    if (existing !== undefined) writeFileSync(configPath, JSON.stringify(existing));
    const env = { ...process.env, PILOT_TEST_NODE: process.execPath };
    let result;
    if (platform === 'bash') {
      const scriptPath = resolve(root, 'config-writer.js');
      const valuePath = resolve(root, 'status-bar-value');
      result = spawnSync('bash', ['-c', `${shellPrelude}
msg() { :; }
capture_node() {
  printf '%s' "$2" > "$PILOT_TEST_JS"
  printf '%s' "$LP_ENABLE_STATUS_BAR_APP" > "$PILOT_TEST_STATUS_BAR"
}
NODE_BIN=capture_node
PROBE_RESULT='[]'
${shellWriter}
write_config`, 'installer-test', command, '--data-dir', root, ...args], {
        encoding: 'utf8', env: { ...env, PILOT_TEST_JS: scriptPath, PILOT_TEST_STATUS_BAR: valuePath },
      });
      if (result.status === 0) {
        runInNewContext(readFileSync(scriptPath, 'utf8'), {
          require, console,
          process: { env: { LP_ENABLE_STATUS_BAR_APP: readFileSync(valuePath, 'utf8') } },
        });
      }
    } else if (platform === 'powershell') {
      const scriptPath = resolve(root, 'installer-test.ps1');
      writeFileSync(scriptPath, `${psPrelude}
function Msg { }
$script:NODE_BIN = $env:PILOT_TEST_NODE
$script:PROBE_RESULT = '[]'
${psWriter}
Write-Config`);
      result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        scriptPath, command, '-DataDir', root, ...args], {
        encoding: 'utf8', env: { ...env, USERPROFILE: root, TEMP: root, LOONGSUITE_PILOT_CACHE_DIR: root },
      });
    } else {
      expect(psJs).toBeTruthy();
      const optionsPath = resolve(root, 'options.json');
      writeFileSync(optionsPath, JSON.stringify({ configPath, dataDir: root, enableStatusBarApp: args[0] ?? '' }));
      runInNewContext(psJs, { require, console, process: { argv: ['node', optionsPath] } });
      result = { status: 0, stderr: '' };
    }
    expect(result.error).toBeUndefined();
    return { ...result, config: existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('installer menu bar startup option', () => {
  for (const platform of ['bash', 'powershell-js']) {
    describe(platform, () => {
      it('leaves the runtime default unchanged on a fresh install when omitted', () => {
        const result = runConfig(platform);
        expect(result.status, result.stderr).toBe(0);
        expect(result.config).not.toHaveProperty('enableStatusBarApp');
        expect(result.config.enabled).toBe(true);
      });

      it.each([true, false])('preserves existing %s and unrelated settings when omitted', enabled => {
        const existing = { enableStatusBarApp: enabled, dashboard: { port: 9010 }, userId: 'test-user' };
        const result = runConfig(platform, [], existing);
        expect(result.status, result.stderr).toBe(0);
        expect(result.config).toMatchObject(existing);
      });

      it.each(['true', 'false'])('writes %s as a boolean on fresh install and reinstall', value => {
        const args = platform === 'bash' ? ['--enable-status-bar-app', value] : [value];
        for (const existing of [undefined, { enableStatusBarApp: value !== 'true', dashboard: { port: 9010 } }]) {
          const result = runConfig(platform, args, existing);
          expect(result.status, result.stderr).toBe(0);
          expect(result.config.enableStatusBarApp).toBe(value === 'true');
          expect(result.config.enabled).toBe(true);
          expect(result.config.dashboard.port).toBe(existing?.dashboard.port ?? 8765);
        }
      });
    });
  }

  it.each(['true', 'false'])('accepts the Bash equals form: %s', value => {
    const result = runConfig('bash', [`--enable-status-bar-app=${value}`]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.config.enableStatusBarApp).toBe(value === 'true');
  });

  it.each(['', '0', '1', 'yes', 'false\n', "false';process.exit(0);//"])(
    'rejects invalid Bash value %j before changing config', value => {
      const existing = { enableStatusBarApp: true, userId: 'test-user' };
      for (const args of [['--enable-status-bar-app', value], [`--enable-status-bar-app=${value}`]]) {
        const result = runConfig('bash', args, existing);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--enable-status-bar-app requires true or false');
        expect(result.config).toEqual(existing);
      }
    },
  );

  it.each([['--enable-status-bar-app'], ['--enable-status-bar-app', '--agents', 'codex']])(
    'rejects missing Bash values: %j', (...args) => {
      const result = runConfig('bash', args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--enable-status-bar-app requires true or false');
      expect(result.config).toBeUndefined();
    },
  );

  it.each(['upgrade', 'uninstall'])('does not silently ignore the option for %s', command => {
    const result = runConfig('bash', ['--enable-status-bar-app', 'false'], undefined, command);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('only supported with install');
    expect(result.config).toBeUndefined();
  });

  it.runIf(hasPowerShell)('validates native PowerShell arguments and persists boolean values', () => {
    for (const value of ['true', 'false', 'False']) {
      const result = runConfig('powershell', ['-EnableStatusBarApp', value]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.config.enableStatusBarApp).toBe(value.toLowerCase() === 'true');
    }
    for (const args of [['-EnableStatusBarApp'], ['-EnableStatusBarApp', ''], ['-EnableStatusBarApp', 'yes']]) {
      const result = runConfig('powershell', args);
      expect(result.status).not.toBe(0);
      expect(result.config).toBeUndefined();
    }
    for (const command of ['upgrade', 'uninstall']) {
      const result = runConfig('powershell', ['-EnableStatusBarApp', 'false'], undefined, command);
      expect(result.status).not.toBe(0);
      expect(result.config).toBeUndefined();
    }
  });
});
