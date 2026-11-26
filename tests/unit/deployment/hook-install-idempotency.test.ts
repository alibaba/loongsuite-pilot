import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';
import { runHookInstall } from '../../../src/deployment/hook-install-service.js';

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('hook install idempotency', () => {
  let tmp: string;
  let dataDir: string;
  let pilotDir: string;
  let settingsPath: string;
  let restoreHome: () => void;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hook-idem-'));
    restoreHome = isolateAgentHome(tmp);
    dataDir = path.join(tmp, 'data');
    pilotDir = path.join(tmp, 'pilot');
    const home = path.join(tmp, 'agent-home');
    settingsPath = path.join(home, 'settings.json');
    await fs.mkdir(path.join(pilotDir, 'agents.d'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(pilotDir, 'agents.d', 'sample-agent.json'), JSON.stringify({
      id: 'sample-agent',
      displayName: 'Sample',
      deployMode: 'hook',
      detection: { paths: [home], commands: [] },
      hook: {
        settingsPath,
        events: ['Stop'],
        hookCommand: '$PILOT_DATA/hooks/sample-agent-hook.sh',
        format: 'nested',
        matcher: '*',
      },
    }));
  });

  afterEach(async () => {
    restoreHome();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function install(agent = 'sample-agent', homes?: Record<string, string>) {
    return runHookInstall({
      dataDir,
      pilotDir,
      builtinAgentsDir: path.join(pilotDir, 'agents.d'),
      writeResult: true,
      agentsFlag: agent,
      homes,
      identity: { identity: 'd'.repeat(64), source: 'cgroup' },
    });
  }

  it('reports up-to-date without rewriting settings, then rewrites only the damaged file', async () => {
    const first = await install();
    expect(first.report.agents[0].status).toBe('ok');
    const before = await fs.readFile(settingsPath, 'utf8');
    const beforeStat = await fs.stat(settingsPath);

    const second = await install();
    expect(second.report.agents[0].status).toBe('up-to-date');
    const after = await fs.readFile(settingsPath, 'utf8');
    const afterStat = await fs.stat(settingsPath);
    expect(after).toBe(before);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    await fs.writeFile(settingsPath, '{}\n');
    const third = await install();
    expect(third.report.agents[0].status).toBe('ok');
    const restored = await fs.readFile(settingsPath, 'utf8');
    expect(restored).toBe(before);
    expect(restored).not.toBe('{}\n');
  });

  it.each(['qoder', 'qoder-cn'])('fills %s token usage defaults on initial and existing hook installs', async agent => {
    const home = path.join(tmp, `${agent} profile`);
    await fs.mkdir(home);
    await fs.copyFile(
      new URL(`../../../agents.d/${agent}.json`, import.meta.url),
      path.join(pilotDir, 'agents.d', `${agent}.json`),
    );
    const installInHome = () => install(agent, { [agent]: home });
    const envFile = path.join(home, '.env');
    const settings = path.join(home, 'settings.json');
    expect((await installInHome()).report.agents[0].status).toBe('ok');
    expect(await fs.readFile(envFile, 'utf8')).toBe('QODER_EXPOSE_TOKEN_USAGE=1\nQODERCN_EXPOSE_TOKEN_USAGE=1\n');
    const hookMtime = (await fs.stat(settings)).mtimeMs;

    // Existing hooks and a private .env with a multiline secret and an explicit override.
    const original = 'OTHER="first\r\nQODER_EXPOSE_TOKEN_USAGE=0\r\nlast"\r\nexport QODERCN_EXPOSE_TOKEN_USAGE="0"';
    await fs.writeFile(envFile, original);
    expect((await installInHome()).report.agents[0].status).toBe('ok');
    expect(await fs.readFile(envFile, 'utf8')).toBe(original + '\r\nQODER_EXPOSE_TOKEN_USAGE=1\r\n');
    expect((await fs.stat(settings)).mtimeMs).toBe(hookMtime);

    const envMtime = (await fs.stat(envFile)).mtimeMs;
    expect((await installInHome()).report.agents[0].status).toBe('up-to-date');
    expect((await fs.stat(envFile)).mtimeMs).toBe(envMtime);
  });

  it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)(
    'keeps Qoder token settings readable by the profile owner during privileged deployment',
    async () => {
      const profile = path.join(tmp, '.qoder');
      await fs.chmod(tmp, 0o711);
      await fs.mkdir(profile);
      await fs.chown(profile, 12345, 12345);
      await fs.copyFile(
        new URL('../../../agents.d/qoder.json', import.meta.url),
        path.join(pilotDir, 'agents.d', 'qoder.json'),
      );

      const envFile = path.join(profile, '.env');
      expect((await install('qoder')).report.agents[0].status).toBe('ok');
      expect(await fs.stat(envFile)).toMatchObject({ uid: 12345, gid: 12345 });
      expect((await fs.stat(envFile)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(envFile, 'utf8')).toBe('QODER_EXPOSE_TOKEN_USAGE=1\nQODERCN_EXPOSE_TOKEN_USAGE=1\n');

      const linkedEnvFile = path.join(profile, 'shared.env');
      const explicit = 'QODER_EXPOSE_TOKEN_USAGE=0\n';
      await fs.rename(envFile, linkedEnvFile);
      await fs.writeFile(linkedEnvFile, explicit);
      await fs.chmod(linkedEnvFile, 0o640);
      await fs.symlink(linkedEnvFile, envFile);

      expect((await install('qoder')).report.agents[0].status).toBe('ok');
      expect(await fs.readlink(envFile)).toBe(linkedEnvFile);
      const updated = await fs.stat(linkedEnvFile);
      expect(updated).toMatchObject({ uid: 12345, gid: 12345 });
      expect(updated.mode & 0o777).toBe(0o640);
      expect(await fs.readFile(linkedEnvFile, 'utf8')).toBe(explicit + 'QODERCN_EXPOSE_TOKEN_USAGE=1\n');

      // The helper must respect the user's access to the target path.
      await fs.chmod(tmp, 0o700);
      await fs.writeFile(linkedEnvFile, explicit);
      expect((await install('qoder')).report.agents[0].status).toBe('up-to-date');
      expect(await fs.readFile(linkedEnvFile, 'utf8')).toBe(explicit);
    },
  );

  it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0).each(['regular', 'symlink'])(
    'leaves a different owner\'s %s .env target unchanged during privileged deployment',
    async kind => {
      const profile = path.join(tmp, '.qoder');
      await fs.chmod(tmp, 0o711);
      await fs.mkdir(profile);
      await fs.chown(profile, 12345, 12345);
      await fs.copyFile(
        new URL('../../../agents.d/qoder.json', import.meta.url),
        path.join(pilotDir, 'agents.d', 'qoder.json'),
      );

      const envFile = path.join(profile, '.env');
      const target = kind === 'regular' ? envFile : path.join(tmp, 'other-owner.env');
      const original = 'OTHER_SETTING=keep\n';
      await fs.writeFile(target, original);
      await fs.chmod(target, 0o666);
      if (kind === 'symlink') await fs.symlink(target, envFile);
      const before = await fs.stat(target);

      expect((await install('qoder')).report.agents[0].status).toBe('ok');
      expect((await install('qoder')).report.agents[0].status).toBe('up-to-date');
      expect(await fs.readFile(target, 'utf8')).toBe(original);
      expect(await fs.stat(target)).toMatchObject({ ino: before.ino, uid: 0, mode: before.mode });
      if (kind === 'symlink') expect(await fs.readlink(envFile)).toBe(target);
    },
  );

  it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0).each(['file', 'profile'])(
    'does not redeploy healthy Qoder Hooks for a read-only %s',
    async kind => {
      const profile = path.join(tmp, '.qoder');
      await fs.chmod(tmp, 0o711);
      await fs.mkdir(profile);
      await fs.chown(profile, 12345, 12345);
      await fs.copyFile(
        new URL('../../../agents.d/qoder.json', import.meta.url),
        path.join(pilotDir, 'agents.d', 'qoder.json'),
      );
      const envFile = path.join(profile, '.env');
      const original = 'QODER_EXPOSE_TOKEN_USAGE=0\n';
      if (kind === 'file') {
        await fs.writeFile(envFile, original, { mode: 0o400 });
        await fs.chown(envFile, 12345, 12345);
      } else {
        await fs.chmod(profile, 0o500);
      }

      expect((await install('qoder')).report.agents[0].status).toBe('ok');
      expect((await install('qoder')).report.agents[0].status).toBe('up-to-date');
      if (kind === 'file') {
        expect(await fs.readFile(envFile, 'utf8')).toBe(original);
      } else {
        await expect(fs.access(envFile)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    },
  );
});
