import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const shell = fs.readFileSync(new URL('../../../deploy/installer-opensource.sh', import.meta.url).pathname, 'utf8');
const powershell = fs.readFileSync(new URL('../../../deploy/installer-opensource.ps1', import.meta.url).pathname, 'utf8');
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-workspace-')); dirs.push(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ privacy: { excludeWorkspaces: ['/old'], custom: true }, userId: 'existing' }));
  return { dir, file };
}
function bashWrite(paths = []) {
  const { dir, file } = fixture();
  const fn = shell.slice(shell.indexOf('write_config() {'), shell.indexOf('install_loongsuite_pilot_command() {'));
  const start = fn.indexOf("const fs = require('fs');");
  const endText = "fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\\n');";
  const end = fn.indexOf(endText) + endText.length;
  const code = fn.slice(start, end)
    .replaceAll("'$config_file'", JSON.stringify(file))
    .replaceAll("'$DATA_DIR'", JSON.stringify(dir))
    .replace(/\$\{[A-Z_]+\}/g, '');
  const script = path.join(dir, 'writer.cjs');
  fs.writeFileSync(script, code);
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', input: '[]', env: {
    ...process.env, LP_EXCLUDE_WORKSPACES: paths.length ? JSON.stringify(paths) : '',
  } });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('workspace installer configuration', () => {
  it('bash serializes multiple paths without evaluating quotes, dollars, backticks or newlines', () => {
    const paths = ['/private/my project', "/private/it's-secret", '/private/$(exit 9)`exit 9`', '/private/中文\nfolder'];
    expect(bashWrite(paths).privacy).toEqual({ excludeWorkspaces: paths, custom: true });
  });
  it('bash preserves exclusions on reinstall without the option', () => {
    expect(bashWrite().privacy.excludeWorkspaces).toEqual(['/old']);
  });
  it('PowerShell leaves an omitted option as an empty array', () => {
    expect(powershell).toContain('excludeWorkspaces = @($ExcludeWorkspace | Where-Object { $null -ne $_ })');
  });
  it('PowerShell embedded writer preserves or replaces the array', () => {
    const fn = powershell.slice(powershell.indexOf('function Write-Config {'));
    const start = fn.indexOf("const fs = require('fs');");
    const end = fn.indexOf("fs.writeFileSync(opts.configPath, JSON.stringify(config, null, 2) + '\\n');") + "fs.writeFileSync(opts.configPath, JSON.stringify(config, null, 2) + '\\n');".length;
    const js = fn.slice(start, end).replace('fs.readFileSync(process.argv[1]', 'fs.readFileSync(process.argv[2]');
    for (const excludes of [[], ['C:\\private space', 'D:\\中文']]) {
      const { dir, file } = fixture();
      const opts = path.join(dir, 'options.json');
      fs.writeFileSync(opts, JSON.stringify({ configPath: file, dataDir: dir, excludeWorkspaces: excludes, probeResult: '[]', selectedAgents: '' }));
      const script = path.join(dir, 'writer.cjs');
      fs.writeFileSync(script, js);
      const result = spawnSync(process.execPath, [script, opts], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).privacy.excludeWorkspaces).toEqual(excludes.length ? excludes : ['/old']);
    }
  });
  it('bash rejects missing and relative option values before installation', () => {
    for (const args of [['--exclude-workspace'], ['--exclude-workspace', 'relative'], ['--exclude-workspace=relative']]) {
      const result = spawnSync('bash', [new URL('../../../deploy/installer-opensource.sh', import.meta.url).pathname, ...args], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('requires an absolute local directory');
    }
  });
});
