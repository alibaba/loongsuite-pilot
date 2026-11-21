import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveHookInstallScope } from '../../../src/deployment/hook-scope.js';
import { parseHookArgs } from '../../../src/deployment/hook-command.js';
import { runEagerInjection } from '../../../src/inject-hooks.js';
import { DeploymentManager } from '../../../src/deployment/deployment-manager.js';
import { resolveDeploymentScope } from '../../../src/deployment/deployment-scope.js';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  redirectRootLoggerToStderr: vi.fn(),
}));
vi.mock('../../../src/utils/container-identity.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/utils/container-identity.js')>(),
  readContainerIdentity: () => ({ identity: 'a'.repeat(64), source: 'cgroup' }),
}));

let root: string;
let pilot: string;
let data: string;
let restoreHome: () => void;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-scope-env-'));
  restoreHome = isolateAgentHome(root);
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  pilot = path.join(root, 'payload'); data = path.join(root, 'data');
  await fs.mkdir(path.join(pilot, 'agents.d'), { recursive: true });
  await fs.mkdir(path.join(pilot, 'assets'), { recursive: true });
  await fs.symlink(path.resolve('assets/hooks'), path.join(pilot, 'assets/hooks'), 'dir');
  for (const id of ['pi-coding-agent', 'dsh']) {
    await fs.cp(path.resolve('assets/plugins', id), path.join(data, 'plugins', id), { recursive: true });
    await fs.copyFile(path.resolve('agents.d', id + '.json'), path.join(pilot, 'agents.d', id + '.json'));
  }
  for (const home of ['.grok', '.codex', '.pi/agent', '.dsh']) await fs.mkdir(path.join(root, home), { recursive: true });
  for (const [id, home, script, event] of [
    ['grok-build', '.grok', 'grok-build-loongsuite-pilot-hook.sh', 'stop'],
    ['codex', '.codex', 'codex-loongsuite-pilot-hook.sh', 'Stop'],
    ['claude-code', '.claude', 'claude-code-loongsuite-pilot-hook.sh', 'Stop'],
  ]) {
    await fs.mkdir(path.join(root, home), { recursive: true });
    await fs.writeFile(path.join(pilot, 'agents.d', id + '.json'), JSON.stringify({
      id, displayName: id, deployMode: 'hook', detection: { paths: [path.join(root, home)], commands: [] },
      hook: { settingsPath: path.join(root, home, 'hooks.json'),
        systemSettingsPath: path.join(root, 'etc', id + '.toml'),
        hookCommand: '$PILOT_DATA/hooks/' + script, events: [event], format: 'nested' },
    }));
  }
  await fs.writeFile(path.join(root, '.pi/agent/settings.json'), '{"theme":"keep","extensions":[]}');
  await fs.writeFile(path.join(root, '.dsh/cordis.patch.yml'), '[]\n');
  vi.stubEnv('LOONGSUITE_PILOT_HOOK_SCOPE', 'system');
  vi.stubEnv('LOONGSUITE_PILOT_AGENTS', '');
  vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', path.join(root, 'config.json'));
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'inject-hooks.cjs', '--pilot-dir=' + pilot, '--data-dir=' + data]);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', platform);
  restoreHome(); await fs.rm(root, { recursive: true, force: true });
});

describe('scope env at existing installation entry points', () => {
  it('preserves omission and accepts trimmed scope; explicit CLI overrides even a malformed env', () => {
    expect(resolveHookInstallScope(undefined, '')).toBeUndefined();
    expect(resolveHookInstallScope(undefined, '  ')).toBeUndefined();
    expect(resolveHookInstallScope(undefined, ' system ')).toBe('system');
    expect(resolveHookInstallScope('user', 'wrong')).toBe('user');
    vi.stubEnv('LOONGSUITE_PILOT_HOOK_SCOPE', 'wrong');
    expect(parseHookArgs(['install', '--scope', 'user']).deploymentScope).toBe('user');
    expect(() => parseHookArgs(['install'])).toThrow('HOOK_SCOPE');
  });

  it('applies env scope to the hook CLI and validates incompatible home overrides', () => {
    expect(parseHookArgs(['install']).deploymentScope).toBe('system');
    expect(() => parseHookArgs(['install', '--home', 'grok-build=/tmp/other'])).toThrow('cannot be combined');
  });

  it('automatically installs four agents from inherited env while unsupported hooks stay in home', async () => {
    expect(await runEagerInjection()).toBe(0);
    for (const id of ['grok-build', 'codex']) {
      expect(await fs.readFile(path.join(root, 'etc', id + '.toml'), 'utf8')).toContain('loongsuite-pilot:' + id);
    }
    expect(JSON.parse(await fs.readFile(path.join(root, '.pi/agent/settings.json'), 'utf8')).theme).toBe('keep');
    expect(await fs.readFile(path.join(root, '.dsh/cordis.patch.yml'), 'utf8')).toContain('PILOT-OBSERVABILITY-MANAGED');
    expect(await fs.readFile(path.join(root, '.claude/hooks.json'), 'utf8')).toContain('Stop');
    const state = JSON.parse(await fs.readFile(path.join(data, 'deployed-agents.json'), 'utf8'));
    expect(state['grok-build'].hookScope).toBe('system');
    expect(state.codex.hookScope).toBe('system');
    expect(state.dsh.dshPatchPath).toBe(path.join(root, '.dsh/cordis.patch.yml'));
    expect(await runEagerInjection()).toBe(0);
  });

  it('leaves the default eager path unchanged when scope is absent', async () => {
    vi.stubEnv('LOONGSUITE_PILOT_HOOK_SCOPE', '');
    expect(await runEagerInjection()).toBe(0);
    expect(await fs.readFile(path.join(root, '.grok/hooks.json'), 'utf8')).toContain('stop');
    expect(await fs.stat(path.join(root, 'etc')).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(data, 'last-hook-install.json')).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(data, 'hook-install.signal')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, '.dsh/cordis.patch.yml'), 'utf8')).toBe('[]\n');
  });

  it('rejects invalid scope before modifying configuration and reports failed installs to the launcher', async () => {
    vi.stubEnv('LOONGSUITE_PILOT_HOOK_SCOPE', 'typo');
    await expect(runEagerInjection()).rejects.toThrow('HOOK_SCOPE');
    expect(await fs.stat(path.join(data, 'deployed-agents.json')).catch(() => null)).toBeNull();
    vi.stubEnv('LOONGSUITE_PILOT_HOOK_SCOPE', 'system');
    await fs.mkdir(path.join(root, 'etc'));
    const config = path.join(root, 'etc/grok-build.toml');
    await fs.writeFile(config, '# keep\n', { mode: 0o444 });
    expect(await runEagerInjection()).toBe(1);
    expect(await fs.readFile(config, 'utf8')).toBe('# keep\n');
  });

  it('retains the explicit none opt-out without writing installation state', async () => {
    vi.stubEnv('LOONGSUITE_PILOT_AGENTS', 'none');
    expect(await runEagerInjection()).toBe(0);
    expect(await fs.stat(path.join(data, 'deployed-agents.json')).catch(() => null)).toBeNull();
  });

  it.each([
    ['system', false],
    ['system', true],
    ['user', false],
  ])('leaves deferred Hermes to the daemon for %s scope (existing deployment: %s)', async (scope, existing) => {
    const hermesHome = path.join(root, '.hermes');
    const sourceDir = path.join(data, 'plugins', 'hermes-agent', 'loongsuite-pilot');
    const targetDir = path.join(hermesHome, 'plugins', 'loongsuite-pilot');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(hermesHome, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'plugin.yaml'), 'name: loongsuite-pilot\n');
    await fs.writeFile(path.join(pilot, 'agents.d', 'hermes-agent.json'), JSON.stringify({
      id: 'hermes-agent', displayName: 'Hermes', deployMode: 'directory-plugin',
      detection: { paths: [hermesHome], commands: [] },
      directoryPlugin: { sourceDir, targetDir },
    }));
    const daemon = new DeploymentManager({ dataDir: data, pilotDir: pilot, installedBy: 'daemon' });
    const defs = await daemon.loadDefinitions();
    const hermes = defs.find(def => def.id === 'hermes-agent')!;
    if (existing) expect((await daemon.deploySingle(hermes)).success).toBe(true);

    vi.stubEnv('LOONGSUITE_PILOT_HOOK_SCOPE', scope);
    vi.stubEnv('LOONGSUITE_PILOT_AGENTS', 'pi-coding-agent,hermes-agent');
    expect(await runEagerInjection()).toBe(0);
    const report = await fs.readFile(path.join(data, 'last-hook-install.json'), 'utf8')
      .then(JSON.parse, () => null);
    expect(resolveDeploymentScope({ identity: 'a'.repeat(64), source: 'cgroup' }, report)).toBe('auto');
    expect(report).toBeNull();

    const results = await daemon.deployAll();
    expect(results.find(result => result.agentId === 'hermes-agent')).toMatchObject({ success: true });
    expect(await fs.readFile(path.join(targetDir, 'plugin.yaml'), 'utf8')).toContain('loongsuite-pilot');
    const state = JSON.parse(await fs.readFile(path.join(data, 'deployed-agents.json'), 'utf8'));
    expect(state['hermes-agent']).toBeDefined();
    expect(state['pi-coding-agent']).toBeDefined();
  });
});
