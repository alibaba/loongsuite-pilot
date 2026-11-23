import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('Windows worker CLI wrapper', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('pins the installer Node runtime for both worker and deployed Hooks', async () => {
    const installer = await fs.readFile(path.resolve('deploy/installer-opensource.ps1'), 'utf-8');
    const checkDeps = installer.slice(
      installer.indexOf('function Check-Deps'),
      installer.indexOf('function Download-AndExtract'),
    );

    expect(checkDeps).toContain('Join-Path $CACHE_DIR "node-bin"');
    expect(checkDeps).toContain('Join-Path $DataDir "node-bin"');
  });

  it.runIf(process.platform === 'win32')('uses separate Unicode data/cache dirs and forwards worker argv unchanged', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-worker-cli-'));
    const binDir = path.join(tmpDir, '命令 dir');
    const dataDir = path.join(tmpDir, '数据 dir');
    const cacheDir = path.join(tmpDir, '缓存 dir');
    const versionName = 'test-version';
    const versionDir = path.join(cacheDir, 'versions', versionName);
    const captureEntry = path.join(versionDir, 'dist', 'index.js');
    await fs.mkdir(path.dirname(captureEntry), { recursive: true });
    await fs.writeFile(
      captureEntry,
      `console.log(JSON.stringify({
        argv: process.argv.slice(2),
        dataDir: process.env.LOONGSUITE_PILOT_DATA_DIR,
        cacheDir: process.env.LOONGSUITE_PILOT_CACHE_DIR,
      }));`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(cacheDir, 'current'),
      versionName,
      'utf-8',
    );
    await fs.writeFile(
      path.join(cacheDir, 'node-bin'),
      process.execPath,
      'utf-8',
    );
    await fs.mkdir(binDir, { recursive: true });
    const script = path.join(binDir, 'loongsuite-pilot.ps1');
    await fs.copyFile(path.resolve('scripts/loongsuite-pilot.ps1'), script);
    await fs.writeFile(
      path.join(binDir, 'loongsuite-pilot-layout.json'),
      JSON.stringify({ dataDir, cacheDir }),
      'utf-8',
    );

    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      'worker',
      'connect',
      '--runtime',
      'fake-runtime',
      '--json',
      '--',
      '--runtime-command',
      'C:\\Program Files\\Fake Runtime\\runtime.cmd',
    ], {
      env: {
        ...process.env,
        USERPROFILE: tmpDir,
        LOONGSUITE_PILOT_DATA_DIR: '',
        LOONGSUITE_PILOT_CACHE_DIR: '',
      },
    });

    expect(JSON.parse(stdout.trim())).toEqual({
      argv: [
        'worker',
        'connect',
        '--runtime',
        'fake-runtime',
        '--json',
        '--',
        '--runtime-command',
        'C:\\Program Files\\Fake Runtime\\runtime.cmd',
      ],
      dataDir,
      cacheDir,
    });
  });
});
