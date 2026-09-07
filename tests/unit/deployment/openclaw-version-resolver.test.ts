import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveOpenClawHost } from '../../../src/deployment/openclaw-version-resolver.js';
import { openClawCapabilities } from '../../../assets/plugins/openclaw/compatibility.mjs';
import { PluginInjectStrategy } from '../../../src/deployment/plugin-inject-strategy.js';
import type { AgentDefinition } from '../../../src/types/index.js';

vi.mock('node:child_process', () => ({
  execFile: () => { throw new Error('Version discovery must not execute child processes'); },
  spawn: () => { throw new Error('Version discovery must not execute child processes'); },
}));

describe('OpenClaw read-only version discovery and injection', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-oc-version-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  async function pkg(relative: string, version = '2026.3.8', name = 'openclaw') {
    const dir = path.join(root, relative);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
    await fs.writeFile(path.join(dir, 'openclaw.mjs'), '/* metadata test, never executed */', { mode: 0o755 });
    return path.join(dir, 'openclaw.mjs');
  }
  it.each(['npm/lib/node_modules/openclaw', 'pnpm/.pnpm/openclaw@2026.3.8/node_modules/openclaw'])(
    'resolves a real executable link under %s without child processes', async layout => {
      const entry = await pkg(layout);
      const bin = path.join(root, 'bin');
      await fs.mkdir(bin);
      await fs.symlink(entry, path.join(bin, 'openclaw'));
      expect(await resolveOpenClawHost({ PATH: bin }, root)).toMatchObject({
        version: '2026.3.8', adapter: 'legacy', conversationAccess: false,
        source: await fs.realpath(path.join(path.dirname(entry), 'package.json')),
      });
    });
  it('distinguishes enterprise bundle version from the nested OpenClaw version', async () => {
    const entry = await pkg('.openclaw-bundle/wrapper', '1.0.0', 'wrapper');
    await pkg('.openclaw-bundle/openclaw', '1.0.0', 'openclaw-bundle-cli');
    await pkg('.openclaw-bundle/openclaw/node_modules/openclaw');
    expect(await resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry }, root)).toMatchObject({ version: '2026.3.8' });
  });
  it('reads a source container working directory without a PATH command', async () => {
    await pkg('app');
    expect(await resolveOpenClawHost({}, path.join(root, 'app'))).toMatchObject({ version: '2026.3.8' });
  });
  it('does not select another installation or stale environment when the selected package is unsupported', async () => {
    const entry = await pkg('old', '2026.3.2');
    await pkg('new', '2026.5.12');
    expect(await resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry, OPENCLAW_SERVICE_VERSION: '2026.5.12' }, root)).toBeNull();
  });
  it('prefers installed metadata over stale environment version', async () => {
    const entry = await pkg('app');
    expect(await resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry, OPENCLAW_SERVICE_VERSION: '2026.5.12' }, root))
      .toMatchObject({ version: '2026.3.8' });
  });
  it('fails closed for invalid/oversized metadata and symlink loops', async () => {
    const entry = await pkg('app');
    await fs.writeFile(path.join(root, 'app/package.json'), '{broken');
    expect(await resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry }, root)).toBeNull();
    await fs.writeFile(path.join(root, 'app/package.json'), ' '.repeat(256 * 1024 + 1));
    expect(await resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry }, root)).toBeNull();
    await fs.symlink(path.join(root, 'loop'), path.join(root, 'loop'));
    expect(await resolveOpenClawHost({ OPENCLAW_CLI_PATH: path.join(root, 'loop') }, root)).toBeNull();
  });
  it('only accepts recognized runtime version environment variables as a fallback', async () => {
    expect(await resolveOpenClawHost({ OPENCLAW_SERVICE_VERSION: '2026.3.8' }, root)).toMatchObject({ source: 'env:OPENCLAW_SERVICE_VERSION' });
    expect(await resolveOpenClawHost({ OPENCLAW_VERSION: '2026.5.12', npm_package_version: '2026.5.12' }, root)).toBeNull();
  });
  it.each([
    ['2026.3.7', null, null], ['2026.3.8-beta.1', null, null],
    ['2026.3.8', 'legacy', false], ['2026.3.8-1', 'legacy', false],
    ['2026.4.24-beta.1', 'legacy', false], ['2026.4.24', 'legacy', true],
    ['2026.5.11', 'legacy', true], ['2026.5.12-beta.1', 'legacy', true],
    ['v2026.5.12', 'modern', true], ['2027.1.1', 'modern', true],
  ])('maps the capability boundary %s', (version, adapter, conversationAccess) => {
    const caps = openClawCapabilities(version);
    expect(caps?.adapter ?? null).toBe(adapter);
    expect(caps?.conversationAccess ?? null).toBe(conversationAccess);
  });
  it('repairs 3.8, upgrades, downgrades, retries unknown versions and uninstalls while preserving user config', async () => {
    const entry = await pkg('app');
    const configPath = path.join(root, 'openclaw.json');
    const pluginId = 'loongsuite-pilot-openclaw';
    const definition: AgentDefinition = {
      id: 'openclaw', displayName: 'OpenClaw', deployMode: 'plugin-inject', detection: { paths: [], commands: [] },
      pluginInject: { configPaths: [configPath], configShape: 'openclaw-nested', createIfMissing: true,
        pluginId, pluginSpec: 'file://$PILOT_DATA/plugins/openclaw' },
    };
    const strategy = new PluginInjectStrategy(root, root, () => resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry }, root));
    await fs.writeFile(configPath, JSON.stringify({ plugins: { entries: {
      [pluginId]: { enabled: true, hooks: { allowConversationAccess: true }, config: { captureMessageContent: false } },
      thirdParty: { enabled: true },
    } } }));
    const read = async () => JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(await strategy.needsDeploy(definition)).toBe(true);
    expect((await strategy.deploy(definition)).success).toBe(true);
    expect((await read()).plugins.entries[pluginId]).toEqual({ enabled: true, config: { captureMessageContent: false } });
    expect(await strategy.needsDeploy(definition)).toBe(false);
    await pkg('app', '2026.5.12');
    expect(await strategy.needsDeploy(definition)).toBe(true);
    await strategy.deploy(definition);
    expect((await read()).plugins.entries[pluginId].hooks.allowConversationAccess).toBe(true);
    await pkg('app', '2026.3.8');
    await strategy.deploy(definition);
    expect((await read()).plugins.entries[pluginId].hooks).toBeUndefined();
    await pkg('app', 'broken');
    const before = await fs.readFile(configPath, 'utf8');
    expect((await strategy.deploy(definition)).success).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    expect(await strategy.undeploy(definition)).toBe(true);
    expect((await read()).plugins.entries).toEqual({ thirdParty: { enabled: true } });
    await fs.unlink(configPath);
    expect((await strategy.deploy(definition)).success).toBe(false);
    await expect(fs.stat(configPath)).rejects.toThrow();
  });
});
