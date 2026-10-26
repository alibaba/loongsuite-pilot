import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { parse } from 'jsonc-parser';

let bundleDir: string;
let home: string;
let data: string;
let root: string;
let plugin: string;
const source = fs.readFileSync('deploy/installer-opensource.sh', 'utf8');
const start = source.indexOf('remove_copilot_plugin() {');
const end = source.indexOf('\n}', source.indexOf('remove_copilot_otel_environment() {')) + 2;
function uninstall(helperDir = bundleDir) {
  return execFileSync('bash', ['-c', source.slice(start, end) + '\nremove_copilot_plugin\nremove_copilot_otel_environment'], {
    env: { ...process.env, HOME: home, DATA_DIR: data, PERMANENT_DIR: helperDir, NODE_BIN: process.execPath },
    encoding: 'utf8',
  });
}
beforeAll(() => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cleanup-bundle-'));
  buildSync({ entryPoints: ['src/copilot-cleanup-cli.ts'], outfile: path.join(bundleDir, 'dist/copilot-cleanup.cjs'),
    bundle: true, platform: 'node', target: 'es2022', format: 'cjs', mainFields: ['module', 'main'],
    define: { __PROPRIETARY_BUILD__: 'false' } });
});
afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-uninstall-')); data = path.join(home, 'pilot');
  root = path.join(home, '.copilot'); plugin = path.join(root, 'installed-plugins/loongsuite-pilot/loongsuite-pilot');
  fs.mkdirSync(plugin, { recursive: true });
  fs.mkdirSync(path.join(data, 'state/copilot'), { recursive: true });
  fs.writeFileSync(path.join(data, 'state/copilot/otel-enabled'), '');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

it('Unix uninstall preserves foreign JSONC comments, UTF8, arrays and shell settings', () => {
  fs.writeFileSync(path.join(root, 'settings.json'), `// user settings\n{
  "enabledPlugins": {
    "loongsuite-pilot@loongsuite-pilot": true,
    // third-party registration
    "third@third": true,
  },
  "user": "中文",
}\n`);
  fs.writeFileSync(path.join(root, 'config.json'), `// CLI managed settings\n{
  "installedPlugins": [
    {"name":"loongsuite-pilot","marketplace":"loongsuite-pilot"},
    // third-party plugin metadata
    {"name":"third","marketplace":"third"},
    {"name":"loongsuite-pilot","marketplace":"loongsuite-pilot"},
  ],
  "url":"https://example.test/path//keep",
}\n`);
  fs.writeFileSync(path.join(home, '.bashrc'), 'export KEEP=1\n# >>> loongsuite-pilot copilot otel >>>\nexport COPILOT_OTEL_FILE_EXPORTER_PATH=/tmp/native\n# <<< loongsuite-pilot copilot otel <<<\n');
  uninstall();
  const settings = fs.readFileSync(path.join(root, 'settings.json'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
  expect(settings).toContain('// user settings'); expect(settings).toContain('// third-party registration');
  expect(parse(settings)).toEqual({ enabledPlugins: { 'third@third': true }, user: '中文' });
  expect(config).toContain('// CLI managed settings'); expect(config).toContain('// third-party plugin metadata');
  expect(parse(config).installedPlugins).toEqual([{ name: 'third', marketplace: 'third' }]);
  expect(parse(config).url).toBe('https://example.test/path//keep');
  expect(fs.existsSync(plugin)).toBe(false);
  expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe('export KEEP=1\n');
  expect(fs.existsSync(path.join(data, 'state/copilot/otel-enabled'))).toBe(false);
  uninstall();
  expect(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).toBe(settings);
  expect(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).toBe(config);
});

it.each([0, 1, 2])('preserves array entries and trivia when Pilot is at position %i without trailing commas', position => {
  const entries = ['{"name":"first"}', '{"name":"last"}'];
  entries.splice(position, 0, '{"name":"loongsuite-pilot","marketplace":"loongsuite-pilot"}');
  fs.writeFileSync(path.join(root, 'config.json'), '{"installedPlugins":[' + entries.join(', /* foreign separator */ ') + ']}');
  uninstall();
  const raw = fs.readFileSync(path.join(root,'config.json'),'utf8');
  expect(parse(raw).installedPlugins).toEqual([{name:'first'},{name:'last'}]);
  expect(raw.match(/foreign separator/g)).toHaveLength(2);
});

it('keeps symlinks and exact target permissions with a self-contained helper', () => {
  const target = path.join(home, 'settings-target.json');
  fs.writeFileSync(target, '\uFEFF{"enabledPlugins":{"loongsuite-pilot@loongsuite-pilot":true},"foreign":1}\n', { mode: 0o640 });
  fs.symlinkSync(target, path.join(root, 'settings.json'));
  uninstall();
  expect(fs.lstatSync(path.join(root, 'settings.json')).isSymbolicLink()).toBe(true);
  expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  expect(parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')).foreign).toBe(1);
  expect(fs.readFileSync(target, 'utf8').startsWith('\uFEFF')).toBe(true);
});

it.each(['{broken', '{"installedPlugins":{}}'])('does not edit either file or delete assets when config is invalid: %s', bad => {
  const settings = '// keep\n{"enabledPlugins":{"loongsuite-pilot@loongsuite-pilot":true}}';
  fs.writeFileSync(path.join(root, 'settings.json'), settings); fs.writeFileSync(path.join(root, 'config.json'), bad);
  uninstall();
  expect(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).toBe(settings);
  expect(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).toBe(bad);
  expect(fs.existsSync(plugin)).toBe(true);
});

it('preserves files and assets when the safe helper is unavailable', () => {
  const settings = '// keep\n{"enabledPlugins":{"loongsuite-pilot@loongsuite-pilot":true}}';
  fs.writeFileSync(path.join(root, 'settings.json'), settings);
  uninstall(path.join(home, 'missing-helper'));
  expect(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).toBe(settings);
  expect(fs.existsSync(plugin)).toBe(true);
});

it('Windows shared uninstall delegates to the same JSONC helper without round-trip fallback', () => {
  const ps = fs.readFileSync('deploy/installer-opensource.ps1', 'utf8');
  const cleanup = ps.slice(ps.indexOf('function Remove-CopilotPlugin {'), ps.indexOf('function Remove-CopilotOtelEnvironment'));
  expect(cleanup).toContain('dist/copilot-cleanup.cjs');
  expect(cleanup).toContain('& $script:NODE_BIN $helper $copilotHome');
  expect(cleanup).not.toMatch(/Convert(?:To|From)-Json|WriteAllText|PSObject\.Properties|\[regex\]/);
});
