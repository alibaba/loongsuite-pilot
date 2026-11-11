import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentConfigOwner, createAgentConfigFileIfMissing, ensureAgentConfigDirectory } from '../../../src/deployment/agent-config-owner.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>() }));

const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;

describe('native Agent configuration ownership', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-config-owner-'));
    vi.stubEnv('LOONGSUITE_PILOT_ROOT_TRIGGER', '');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses existing file ownership before the enclosing directory', async () => {
    const file = path.join(root, 'config.json');
    await fs.writeFile(file, 'original');
    const stat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const result = await Reflect.apply(stat, fs, args);
      return args[0] === file ? Object.assign(result, { uid: 1234, gid: 2345 }) : result;
    });
    expect(await agentConfigOwner(file)).toEqual({ uid: 1234, gid: 2345, cwd: root });
    expect((await agentConfigOwner(path.join(root, 'missing', 'nested'))).cwd).toBe(root);
  });

  it('keeps default home creation and existing content unchanged without root opt-in', async () => {
    const spawn = vi.spyOn(childProcess, 'execFile');
    const file = path.join(root, 'native', 'config.json');
    await createAgentConfigFileIfMissing(file);
    await fs.writeFile(file, '{"thirdParty":true}\n');
    await fs.chmod(file, 0o640);
    await createAgentConfigFileIfMissing(file);
    await ensureAgentConfigDirectory(path.dirname(file));
    expect(await fs.readFile(file, 'utf8')).toBe('{"thirdParty":true}\n');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not launch a helper or change permissions for an existing directory', async () => {
    vi.stubEnv('LOONGSUITE_PILOT_ROOT_TRIGGER', '1');
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    await fs.chmod(root, 0o710);
    const spawn = vi.spyOn(childProcess, 'execFile');
    await ensureAgentConfigDirectory(root);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o710);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['directory', 'file'])('does not fall back to root creation when %s identity helper fails', async kind => {
    vi.stubEnv('LOONGSUITE_PILOT_ROOT_TRIGGER', '1');
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const stat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const result = await Reflect.apply(stat, fs, args);
      return args[0] === root ? Object.assign(result, { uid: 1234, gid: 2345 }) : result;
    });
    const spawn = vi.spyOn(childProcess, 'execFile').mockImplementation((...args: any[]) => {
      args.at(-1)(Object.assign(new Error('identity denied'), { code: 'EPERM' }), '', '');
      return {} as childProcess.ChildProcess;
    });
    const target = path.join(root, 'native', kind === 'file' ? 'config.json' : 'nested');
    await expect(kind === 'file' ? createAgentConfigFileIfMissing(target) : ensureAgentConfigDirectory(target))
      .rejects.toMatchObject({ code: 'EPERM' });
    expect(await fs.stat(path.join(root, 'native')).then(() => true, () => false)).toBe(false);
    expect(spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({
      uid: 1234, gid: 2345, cwd: root, timeout: 5000,
      env: expect.objectContaining({ NODE_OPTIONS: '', BUN_OPTIONS: '', NODE_PATH: '' }),
    }), expect.any(Function));
  });

  it.skipIf(!linuxRoot)('creates missing native directories and private config as their real non-root owner', async () => {
    vi.stubEnv('LOONGSUITE_PILOT_ROOT_TRIGGER', '1');
    await fs.chmod(root, 0o755);
    const home = path.join(root, 'home');
    await fs.mkdir(home, { mode: 0o700 });
    await fs.chown(home, 1000, 1000);
    const directory = path.join(home, '.hermes', 'plugins');
    await ensureAgentConfigDirectory(directory);
    const file = path.join(home, '.openclaw', 'openclaw.json');
    await createAgentConfigFileIfMissing(file);
    for (const target of [path.join(home, '.hermes'), directory, path.dirname(file), file]) {
      expect((await fs.stat(target)).uid).toBe(1000);
    }
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const output = childProcess.execFileSync(process.execPath, ['-e',
      'require("fs").writeFileSync(process.argv[1], "native state")', path.join(directory, 'another-plugin')],
    { uid: 1000, gid: 1000, env: { NODE_OPTIONS: '', BUN_OPTIONS: '' } });
    expect(output.toString()).toBe('');
    expect(await fs.readFile(path.join(directory, 'another-plugin'), 'utf8')).toBe('native state');
  });
});
