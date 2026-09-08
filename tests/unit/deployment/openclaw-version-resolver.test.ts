import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveOpenClawHost, isOpenClawHostBound } from '../../../src/deployment/openclaw-version-resolver.js';
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
  afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
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
  it('resolves a pnpm global shell wrapper without reading or executing the script', async () => {
    const entry = await pkg('pnpm/global/5/node_modules/openclaw');
    await fs.writeFile(path.join(root, 'pnpm/openclaw'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const host = await resolveOpenClawHost({ PATH: path.join(root, 'pnpm') }, root);
    expect(host?.source).toBe(await fs.realpath(path.join(path.dirname(entry), 'package.json')));
  });
  it('does not fall through to a second PATH installation when the first is unidentifiable', async () => {
    await fs.mkdir(path.join(root, 'first'));
    await fs.writeFile(path.join(root, 'first/openclaw'), 'opaque binary', { mode: 0o755 });
    const entry = await pkg('second');
    await fs.symlink(entry, path.join(root, 'second/openclaw'));
    expect(await resolveOpenClawHost({ PATH: [path.join(root, 'first'), path.join(root, 'second')].join(path.delimiter) }, root)).toBeNull();
  });
  it('reads a source container working directory without a PATH command', async () => {
    await pkg('app');
    expect(await resolveOpenClawHost({}, path.join(root, 'app'))).toMatchObject({ version: '2026.3.8' });
  });
  it('rejects conflicting source-container and PATH installations, but honors a bound launch entry', async () => {
    const oldEntry = await pkg('gateway', '2026.3.8');
    const newEntry = await pkg('cli', '2026.6.10');
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin); await fs.symlink(newEntry, path.join(bin, 'openclaw'));
    expect(await resolveOpenClawHost({ PATH: bin }, path.join(root, 'gateway'))).toBeNull();
    expect(await resolveOpenClawHost({ PATH: bin, OPENCLAW_CLI_PATH: oldEntry }, path.join(root, 'gateway')))
      .toMatchObject({ version: '2026.3.8', conversationAccess: false });
  });
  it('does not select another installation or stale environment when the selected package is unsupported', async () => {
    const entry = await pkg('old', '2026.3.2');
    await pkg('new', '2026.5.12');
    expect(await resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry, OPENCLAW_SERVICE_VERSION: '2026.5.12' }, root)).toBeNull();
  });
  it.each(['', 'openclaw.mjs', './app/openclaw.mjs'])('rejects non-absolute explicit bindings (%s) without PATH/cwd fallback', async entry => {
    await pkg('app');
    expect(await resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry }, path.join(root, 'app'))).toBeNull();
  });
  it.each(['path', 'cwd', 'bundle'])('keeps %s metadata discovery separate from deployment authority', async source => {
    const entry = await pkg(source === 'bundle' ? 'bundle/openclaw/node_modules/openclaw' : 'app', '2026.6.10');
    await fs.symlink(entry, path.join(path.dirname(entry), 'openclaw'));
    const env = source === 'path' ? { PATH: path.dirname(entry) }
      : source === 'bundle' ? { OPENCLAW_BUNDLE_ROOT: path.join(root, 'bundle') } : {};
    const cwd = source === 'cwd' ? path.dirname(entry) : root;
    const host = await resolveOpenClawHost(env, cwd);
    expect(host?.version).toBe('2026.6.10');
    expect(isOpenClawHostBound(host)).toBe(false);
    const configPath = path.join(root, 'gateway.json');
    const def: AgentDefinition = { id: 'openclaw', displayName: 'OpenClaw', deployMode: 'plugin-inject',
      detection: { paths: [], commands: [] }, pluginInject: { configPaths: [configPath], configShape: 'openclaw-nested',
        createIfMissing: true, pluginId: 'loongsuite-pilot-openclaw', pluginSpec: 'file://$PILOT_DATA/plugins/openclaw' } };
    const strategy = new PluginInjectStrategy(root, root, () => resolveOpenClawHost(env, cwd));
    expect(await strategy.detect(def)).toBe(false);
    expect(await strategy.needsDeploy(def)).toBe(true);
    expect(await strategy.deploy(def)).toMatchObject({ success: false, error: expect.stringContaining('OPENCLAW_CLI_PATH') });
    await expect(fs.stat(configPath)).rejects.toThrow();
    const before = '{"plugins":{"entries":{"third-party":{"enabled":true}}}}';
    await fs.writeFile(configPath, before);
    await strategy.deploy(def);
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
  });
  it.each([['2026.3.8', '2026.6.10', false], ['2026.6.10', '2026.3.8', true]])(
    'binds Gateway %s despite PATH %s across collector cwd changes and lost bindings', async (gatewayVersion, pathVersion, access) => {
      const entry = await pkg('app', gatewayVersion as string);
      const other = await pkg('other-cli', pathVersion as string);
      await fs.symlink(other, path.join(root, 'other-cli/openclaw'));
      const env: NodeJS.ProcessEnv = { OPENCLAW_CLI_PATH: entry, PATH: path.join(root, 'other-cli') };
      const configPath = path.join(root, 'gateway.json');
      const def: AgentDefinition = { id: 'openclaw', displayName: 'OpenClaw', deployMode: 'plugin-inject',
        detection: { paths: [], commands: [] }, pluginInject: { configPaths: [configPath], configShape: 'openclaw-nested',
          createIfMissing: true, pluginId: 'loongsuite-pilot-openclaw', pluginSpec: 'file://$PILOT_DATA/plugins/openclaw' } };
      const strategy = () => new PluginInjectStrategy(root, root, () => resolveOpenClawHost(env, root));
      expect((await strategy().deploy(def)).success).toBe(true);
      const before = await fs.readFile(configPath, 'utf8');
      expect(JSON.parse(before).plugins.entries['loongsuite-pilot-openclaw'].hooks?.allowConversationAccess).toBe(access ? true : undefined);
      expect(await strategy().needsDeploy(def)).toBe(false);
      delete env.OPENCLAW_CLI_PATH;
      expect(await strategy().detect(def)).toBe(false);
      expect(await strategy().needsDeploy(def)).toBe(true);
      expect((await strategy().deploy(def)).success).toBe(false);
      expect(await fs.readFile(configPath, 'utf8')).toBe(before);
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
  it('never grants installation/schema capabilities from environment versions alone', async () => {
    for (const key of ['OPENCLAW_SERVICE_VERSION', 'OPENCLAW_BUNDLED_VERSION']) {
      for (const version of ['2026.3.8', '2026.6.10']) {
        expect(await resolveOpenClawHost({ [key]: version }, root)).toBeNull();
      }
    }
    expect(await resolveOpenClawHost({ OPENCLAW_VERSION: '2026.5.12', npm_package_version: '2026.5.12' }, root)).toBeNull();
  });
  it.each(['{broken', ' '.repeat(256 * 1024 + 1)])('checks fixed sibling packages after unidentified wrapper metadata fails (%#)', async content => {
    const entry = await pkg('wrapper', '1.0.0', 'wrapper');
    await fs.writeFile(path.join(root, 'wrapper/package.json'), content);
    await pkg('wrapper/node_modules/openclaw');
    expect(await resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry }, root)).toMatchObject({ version: '2026.3.8' });
  });
  it('does not bypass a confirmed unsupported OpenClaw package via a nested candidate', async () => {
    const entry = await pkg('wrapper', '2026.3.2');
    await pkg('wrapper/node_modules/openclaw', '2026.6.10');
    expect(await resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry }, root)).toBeNull();
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
  it('uses the container config path for both injection and cleanup', async () => {
    const configPath = path.join(root, 'profile/openclaw.json');
    vi.stubEnv('OPENCLAW_CONFIG_PATH', configPath);
    const def: AgentDefinition = {
      id: 'openclaw', displayName: 'OpenClaw', deployMode: 'plugin-inject', detection: { paths: [], commands: [] },
      pluginInject: { configPaths: [path.join(root, 'unused.json')], configShape: 'openclaw-nested', createIfMissing: true,
        pluginId: 'loongsuite-pilot-openclaw', pluginSpec: 'file://$PILOT_DATA/plugins/openclaw' },
    };
    const entry = await pkg('app');
    const strategy = new PluginInjectStrategy(root, root, () => resolveOpenClawHost({ OPENCLAW_CLI_PATH: entry }, root));
    expect((await strategy.deploy(def)).success).toBe(true);
    expect(await strategy.needsDeploy(def)).toBe(false);
    expect(await strategy.undeploy(def)).toBe(true);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).plugins.entries).toEqual({});
    await expect(fs.stat(path.join(root, 'unused.json'))).rejects.toThrow();
  });
});
