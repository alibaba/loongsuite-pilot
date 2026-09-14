import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { promises as probeFs } from 'node:fs';
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
  it.each(['2026.3.8', '2026.6.10'])('discovers a fixed openclaw child from its container workdir (%s)', async version => {
    const entry = await pkg('app/openclaw', version);
    await pkg('app', '1.0.0', 'customer-container');
    expect(await resolveOpenClawHost({}, path.join(root, 'app'))).toMatchObject({
      executable: entry, version, binding: 'auto-entry',
    });
  });
  it('does not recursively search arbitrary nested directories', async () => {
    await pkg('app/vendor/openclaw');
    expect(await resolveOpenClawHost({}, path.join(root, 'app'))).toBeNull();
  });
  it.each(['broken', 'unreadable', 'directory'])('checks the fixed child after unidentified parent metadata (%s)', async kind => {
    const entry = await pkg('app/openclaw');
    const metadata = path.join(root, 'app/package.json');
    if (kind === 'directory') await fs.mkdir(metadata);
    else await fs.writeFile(metadata, kind === 'unreadable' ? JSON.stringify({ name: 'customer-container' }) : '{');
    if (kind === 'unreadable') await fs.chmod(metadata, 0);
    try {
      expect(await resolveOpenClawHost({ HOME: root, PATH: '' }, path.join(root, 'app')))
        .toMatchObject({ executable: entry, version: '2026.3.8', binding: 'auto-entry' });
    } finally { if (kind === 'unreadable') await fs.chmod(metadata, 0o600); }
  });
  it.each(['present', 'loop'])('does not bypass an unidentified parent with a %s launch entry', async kind => {
    await pkg('app/openclaw');
    await fs.writeFile(path.join(root, 'app/package.json'), '{');
    const entry = path.join(root, 'app/openclaw.mjs');
    if (kind === 'present') await fs.writeFile(entry, '/* unknown installation */');
    else await fs.symlink(entry, entry);
    expect(await resolveOpenClawHost({ HOME: root }, path.join(root, 'app'))).toBeNull();
  });
  it('rechecks an unidentified parent entry before selecting its fixed child', async () => {
    await pkg('app/openclaw');
    await fs.writeFile(path.join(root, 'app/package.json'), '{');
    const parentEntry = path.join(root, 'app/openclaw.mjs');
    const originalStat = probeFs.stat;
    let parentChecks = 0;
    const stat = vi.spyOn(probeFs, 'stat').mockImplementation(async (...args) => {
      if (args[0] === parentEntry && ++parentChecks === 2) await fs.writeFile(parentEntry, '/* appeared during discovery */');
      return Reflect.apply(originalStat, probeFs, args);
    });
    const onProblem = vi.fn();
    try {
      expect(await resolveOpenClawHost({ HOME: root }, path.join(root, 'app'), { onProblem })).toBeNull();
      expect(parentChecks).toBe(2);
      expect(onProblem).toHaveBeenCalledWith(expect.stringContaining('appeared or became inaccessible'));
    } finally { stat.mockRestore(); }
  });
  it.each(['missing', 'unrelated'])('does not escape unidentified parent metadata to PATH when the child is %s', async kind => {
    const entry = await pkg('cli');
    await fs.symlink(entry, path.join(root, 'cli/openclaw'));
    await fs.mkdir(path.join(root, 'app'));
    await fs.writeFile(path.join(root, 'app/package.json'), '{');
    if (kind === 'unrelated') await pkg('app/openclaw', '1.0.0', 'unrelated');
    expect(await resolveOpenClawHost({ HOME: root, PATH: path.join(root, 'cli') }, path.join(root, 'app'))).toBeNull();
  });
  it('keeps the conflict guard after recovering a child from unidentified parent metadata', async () => {
    await pkg('app/openclaw');
    await fs.writeFile(path.join(root, 'app/package.json'), '{');
    const entry = await pkg('cli', '2026.6.10');
    await fs.symlink(entry, path.join(root, 'cli/openclaw'));
    expect(await resolveOpenClawHost({ HOME: root, PATH: path.join(root, 'cli') }, path.join(root, 'app'))).toBeNull();
  });
  it('does not bypass a confirmed unsupported cwd package via its fixed child', async () => {
    await pkg('app', '2026.3.2'); await pkg('app/openclaw');
    expect(await resolveOpenClawHost({ HOME: root }, path.join(root, 'app'))).toBeNull();
  });
  it.each(['EACCES', 'EPERM', 'ELOOP'])('reports child stat %s instead of silently selecting PATH', async code => {
    const child = path.join(root, 'app/openclaw');
    await pkg('app/openclaw');
    const other = await pkg('cli');
    await fs.symlink(other, path.join(root, 'cli/openclaw'));
    const stat = vi.spyOn(probeFs, 'stat').mockRejectedValueOnce(Object.assign(new Error('lookup failed'), { code }));
    const onProblem = vi.fn();
    try {
      expect(await resolveOpenClawHost({ HOME: root, PATH: path.join(root, 'cli') }, path.join(root, 'app'), { onProblem })).toBeNull();
      expect(stat).toHaveBeenCalledWith(child);
      expect(onProblem).toHaveBeenCalledWith(expect.stringContaining(child));
      expect(onProblem).toHaveBeenCalledWith(expect.stringContaining(code));
    } finally { stat.mockRestore(); }
  });
  it.each(['2026.3.8', '2026.6.10'])('rejects distinct cwd and child installations (%s)', async version => {
    await pkg('app');
    await pkg('app/openclaw', version);
    expect(await resolveOpenClawHost({}, path.join(root, 'app'))).toBeNull();
  });
  it('deduplicates a child installation also exposed on PATH', async () => {
    const entry = await pkg('app/openclaw');
    await fs.mkdir(path.join(root, 'bin'));
    await fs.symlink(entry, path.join(root, 'bin/openclaw'));
    expect(await resolveOpenClawHost({ PATH: path.join(root, 'bin') }, path.join(root, 'app')))
      .toMatchObject({ executable: entry, binding: 'auto-entry' });
  });
  it.each(['missing-entry', 'unsupported', 'broken-metadata'])('does not bypass an invalid fixed child (%s)', async problem => {
    const entry = await pkg('app/openclaw', problem === 'unsupported' ? '2026.3.2' : '2026.3.8');
    if (problem === 'missing-entry') await fs.unlink(entry);
    if (problem === 'broken-metadata') await fs.writeFile(path.join(path.dirname(entry), 'package.json'), '{');
    const other = await pkg('cli');
    await fs.symlink(other, path.join(root, 'cli/openclaw'));
    expect(await resolveOpenClawHost({ PATH: path.join(root, 'cli') }, path.join(root, 'app'))).toBeNull();
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
  it.each(['path', 'cwd', 'bundle'])('automatically deploys a unique %s entry without CLI_PATH', async source => {
    const entry = await pkg(source === 'bundle' ? 'bundle/openclaw/node_modules/openclaw' : 'app', '2026.6.10');
    await fs.symlink(entry, path.join(path.dirname(entry), 'openclaw'));
    const env = source === 'path' ? { PATH: path.dirname(entry) }
      : source === 'bundle' ? { OPENCLAW_BUNDLE_ROOT: path.join(root, 'bundle') } : {};
    const cwd = source === 'cwd' ? path.dirname(entry) : root;
    const host = await resolveOpenClawHost(env, cwd);
    expect(host?.version).toBe('2026.6.10');
    expect(isOpenClawHostBound(host)).toBe(true);
    expect(host?.binding).toBe('auto-entry');
    const configPath = path.join(root, 'gateway.json');
    const def: AgentDefinition = { id: 'openclaw', displayName: 'OpenClaw', deployMode: 'plugin-inject',
      detection: { paths: [], commands: [] }, pluginInject: { configPaths: [configPath], configShape: 'openclaw-nested',
        createIfMissing: true, pluginId: 'loongsuite-pilot-openclaw', pluginSpec: 'file://$PILOT_DATA/plugins/openclaw' } };
    const strategy = new PluginInjectStrategy(root, root, () => resolveOpenClawHost(env, cwd));
    expect(await strategy.detect(def)).toBe(true);
    expect(await strategy.needsDeploy(def)).toBe(true);
    expect(await strategy.deploy(def)).toMatchObject({ success: true });
    expect(await strategy.needsDeploy(def)).toBe(false);
    const installed = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(installed.plugins.entries['loongsuite-pilot-openclaw'].hooks.allowConversationAccess).toBe(true);
  });
  it.each([['2026.3.8', '2026.6.10', false], ['2026.6.10', '2026.3.8', true]])(
    'persists Gateway %s despite PATH %s across collector cwd changes and lost environment', async (gatewayVersion, pathVersion, access) => {
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
      env.AGENT_DATA_COLLECTION_CONFIG = path.join(root, 'pilot-config.json');
      await fs.writeFile(env.AGENT_DATA_COLLECTION_CONFIG, JSON.stringify({ agents: { openclaw: { cliPath: entry } } }));
      delete env.OPENCLAW_CLI_PATH;
      expect(await strategy().detect(def)).toBe(true);
      expect(await strategy().needsDeploy(def)).toBe(false);
      expect((await strategy().deploy(def)).success).toBe(true);
      expect(await fs.readFile(configPath, 'utf8')).toBe(before);
      // A missing persisted entry must never silently rebind to another CLI.
      await fs.unlink(entry);
      expect(await strategy().detect(def)).toBe(false);
      expect(await strategy().needsDeploy(def)).toBe(true);
      expect((await strategy().deploy(def)).success).toBe(false);
      expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    });
  it('detects the standard home bundle with an empty service PATH', async () => {
    const entry = await pkg('home/.openclaw-bundle/openclaw/node_modules/openclaw');
    expect(await resolveOpenClawHost({ HOME: path.join(root, 'home'), PATH: '' }, root))
      .toMatchObject({ executable: entry, binding: 'auto-entry', version: '2026.3.8' });
  });
  it('only lets the installer recover a confirmed missing saved entry', async () => {
    const entry = await pkg('app');
    const old = path.join(root, 'missing/openclaw.mjs');
    const config = path.join(root, 'config.json');
    await fs.writeFile(config, JSON.stringify({ agents: { openclaw: { cliPath: old } } }));
    const env = { HOME: root, AGENT_DATA_COLLECTION_CONFIG: config };
    const details: string[] = [];
    expect(await resolveOpenClawHost(env, path.dirname(entry), { onProblem: text => details.push(text) })).toBeNull();
    expect(details.join()).toContain(old);
    expect(await resolveOpenClawHost(env, path.dirname(entry), { mode: 'installer' }))
      .toMatchObject({ executable: entry, binding: 'auto-entry', recoveredFrom: old });
    expect(JSON.parse(await fs.readFile(config, 'utf8')).agents.openclaw.cliPath).toBe(old);
    expect(await resolveOpenClawHost({ ...env, OPENCLAW_CLI_PATH: old }, path.dirname(entry), { mode: 'installer' })).toBeNull();
  });
  it.each(['unsupported', 'broken', 'directory', 'unreadable'])('does not recover an existing %s entry', async kind => {
    const old = await pkg('old', kind === 'unsupported' ? '2026.3.2' : '2026.3.8');
    const entry = await pkg('app');
    if (kind === 'broken') await fs.writeFile(path.join(root, 'old/package.json'), '{');
    if (kind === 'directory') { await fs.unlink(old); await fs.mkdir(old); }
    if (kind === 'unreadable') await fs.chmod(path.join(root, 'old/package.json'), 0);
    const config = path.join(root, 'config.json');
    await fs.writeFile(config, JSON.stringify({ agents: { openclaw: { cliPath: old } } }));
    try {
      expect(await resolveOpenClawHost({ HOME: root, AGENT_DATA_COLLECTION_CONFIG: config }, path.dirname(entry), { mode: 'installer' })).toBeNull();
    } finally { await fs.chmod(path.join(root, 'old/package.json'), 0o600); }
  });
  it('does not recover a missing entry when new candidates conflict', async () => {
    await pkg('app'); await pkg('app/openclaw');
    const config = path.join(root, 'config.json');
    await fs.writeFile(config, JSON.stringify({ agents: { openclaw: { cliPath: path.join(root, 'missing.mjs') } } }));
    expect(await resolveOpenClawHost({ HOME: root, AGENT_DATA_COLLECTION_CONFIG: config }, path.join(root, 'app'), { mode: 'installer' })).toBeNull();
  });
  it.each(['2026.3.2', '2026.3.8'])('skips an implicit leftover only after its entry is confirmed missing (%s)', async version => {
    const leftover = await pkg('home/.openclaw-bundle/openclaw/node_modules/openclaw', version);
    await fs.unlink(leftover);
    const entry = await pkg('cli', '2026.6.10');
    await fs.symlink(entry, path.join(root, 'cli/openclaw'));
    const env = { HOME: path.join(root, 'home'), PATH: path.join(root, 'cli') };
    expect(await resolveOpenClawHost(env, root)).toMatchObject({ executable: path.join(root, 'cli/openclaw'), binding: 'auto-entry' });
    expect(await resolveOpenClawHost({ ...env, OPENCLAW_BUNDLE_ROOT: path.join(root, 'home/.openclaw-bundle') }, root)).toBeNull();
    expect(await resolveOpenClawHost({ ...env, OPENCLAW_BUNDLE_ROOT: './bundle' }, root)).toBeNull();
  });
  it.each(['unsupported', 'broken', 'unreadable', 'missing-metadata'])('does not bypass an existing implicit bundle with %s metadata', async kind => {
    const bundle = await pkg('home/.openclaw-bundle/openclaw/node_modules/openclaw', kind === 'unsupported' ? '2026.3.2' : '2026.3.8');
    const metadata = path.join(path.dirname(bundle), 'package.json');
    if (kind === 'broken') await fs.writeFile(metadata, '{');
    if (kind === 'unreadable') await fs.chmod(metadata, 0);
    if (kind === 'missing-metadata') await fs.unlink(metadata);
    const entry = await pkg('cli', '2026.6.10');
    await fs.symlink(entry, path.join(root, 'cli/openclaw'));
    try {
      expect(await resolveOpenClawHost({ HOME: path.join(root, 'home'), PATH: path.join(root, 'cli') }, root)).toBeNull();
    } finally { if (kind !== 'missing-metadata') await fs.chmod(metadata, 0o600); }
  });
  it('deduplicates bundle and PATH symlinks to the same package', async () => {
    const entry = await pkg('home/.openclaw-bundle/openclaw/node_modules/openclaw');
    await fs.mkdir(path.join(root, 'bin'));
    await fs.symlink(entry, path.join(root, 'bin/openclaw'));
    expect(isOpenClawHostBound(await resolveOpenClawHost({ HOME: path.join(root, 'home'), PATH: path.join(root, 'bin') }, root))).toBe(true);
  });
  it.each(['2026.3.8', '2026.6.10'])('rejects distinct bundle/PATH installs even when their versions match (%s)', async version => {
    await pkg('home/.openclaw-bundle/openclaw/node_modules/openclaw', version);
    const entry = await pkg('cli', version);
    await fs.symlink(entry, path.join(root, 'cli/openclaw'));
    expect(await resolveOpenClawHost({ HOME: path.join(root, 'home'), PATH: path.join(root, 'cli') }, root)).toBeNull();
  });
  it('requires an actual source entry rather than package metadata alone', async () => {
    const entry = await pkg('app');
    await fs.unlink(entry);
    expect(await resolveOpenClawHost({}, path.join(root, 'app'))).toBeNull();
    await fs.mkdir(entry);
    expect(await resolveOpenClawHost({}, path.join(root, 'app'))).toBeNull();
  });
  it('leaves existing Gateway config byte-for-byte unchanged when auto discovery is ambiguous', async () => {
    await pkg('app', '2026.3.8');
    const other = await pkg('cli', '2026.6.10');
    await fs.symlink(other, path.join(root, 'cli/openclaw'));
    const configPath = path.join(root, 'gateway.json');
    const before = '{"plugins":{"entries":{"third-party":{"enabled":true}}}}';
    await fs.writeFile(configPath, before);
    const mtime = (await fs.stat(configPath)).mtimeMs;
    const def: AgentDefinition = { id: 'openclaw', displayName: 'OpenClaw', deployMode: 'plugin-inject',
      detection: { paths: [], commands: [] }, pluginInject: { configPaths: [configPath], configShape: 'openclaw-nested',
        createIfMissing: true, pluginId: 'loongsuite-pilot-openclaw', pluginSpec: 'file://$PILOT_DATA/plugins/openclaw' } };
    const strategy = new PluginInjectStrategy(root, root, () => resolveOpenClawHost({ PATH: path.join(root, 'cli') }, path.join(root, 'app')));
    expect(await strategy.detect(def)).toBe(false);
    expect((await strategy.deploy(def)).success).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    expect((await fs.stat(configPath)).mtimeMs).toBe(mtime);
    await fs.unlink(configPath);
    expect((await strategy.deploy(def)).success).toBe(false);
    await expect(fs.stat(configPath)).rejects.toThrow();
  });
  it('reads a saved entry from the custom config and rechecks versions on upgrade/downgrade', async () => {
    const entry = await pkg('app');
    const config = path.join(root, 'custom config.json');
    await fs.writeFile(config, '\uFEFF' + JSON.stringify({ agents: { openclaw: { cliPath: entry } } }));
    const env = { AGENT_DATA_COLLECTION_CONFIG: config };
    expect(await resolveOpenClawHost(env, root)).toMatchObject({ binding: 'persisted-entry', conversationAccess: false });
    await pkg('app', '2026.6.10');
    expect(await resolveOpenClawHost(env, root)).toMatchObject({ conversationAccess: true });
    await pkg('app');
    expect(await resolveOpenClawHost(env, root)).toMatchObject({ conversationAccess: false });
    await fs.writeFile(config, '{broken');
    expect(await resolveOpenClawHost(env, path.dirname(entry))).toBeNull();
    expect(await resolveOpenClawHost({ ...env, OPENCLAW_CLI_PATH: entry }, root)).toMatchObject({ binding: 'explicit-entry' });
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
