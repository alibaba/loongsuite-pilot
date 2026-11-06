import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(
  __dirname,
  '../../../../assets/hooks/codex-loongsuite-pilot-hook.ps1',
);
const PROCESSOR = path.resolve(
  __dirname,
  '../../../../assets/hooks/codex-hook-processor.mjs',
);
const SHARED_HOOK_ASSETS = path.resolve(__dirname, '../../../../assets/hooks/shared');
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function toMsysPath(filePath) {
  const match = filePath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return filePath;
  return `/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/').replace(/\.exe$/i, '')}`;
}

describe.runIf(process.platform === 'win32')('Codex PowerShell hook wrapper', () => {
  test('preserves UTF-8 stdin and resolves an MSYS-style pinned Node path', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Pilot 用户 With Space-'));
    tempDirs.push(dataDir);
    fs.writeFileSync(path.join(dataDir, 'node-bin'), toMsysPath(process.execPath), 'utf8');

    const payload = {
      session_id: 'windows-unicode-session',
      turn_id: 'turn-中文',
      transcript_path: 'C:\\Users\\测试 User\\.codex\\sessions\\2026\\07\\23\\rollout-test.jsonl',
    };
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        WRAPPER,
        'stop',
      ],
      {
        input: Buffer.from(JSON.stringify(payload), 'utf8'),
        env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    const marker = path.join(
      dataDir,
      'state',
      'codex',
      'transcript-wakeups',
      'windows-unicode-session.json',
    );
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toMatchObject(payload);
  });

  test('remains fail-open when node-bin is empty', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Pilot Empty Pin-'));
    tempDirs.push(dataDir);
    fs.writeFileSync(path.join(dataDir, 'node-bin'), '', 'utf8');

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        WRAPPER,
        'stop',
      ],
      {
        input: Buffer.from(JSON.stringify({ session_id: 'windows-empty-pin' }), 'utf8'),
        env: {
          ...process.env,
          LOONGSUITE_PILOT_DATA_DIR: dataDir,
          PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ''}`,
        },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(JSON.parse(fs.readFileSync(
      path.join(
        dataDir,
        'state',
        'codex',
        'transcript-wakeups',
        'windows-empty-pin.json',
      ),
      'utf8',
    ))).toMatchObject({ session_id: 'windows-empty-pin' });
  });

  test('derives the shared Pilot data directory while publishing a custom CODEX_HOME', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Pilot Shared Root-'));
    tempDirs.push(tempRoot);
    const pilotRoot = path.join(tempRoot, 'shared-pilot');
    const hookDir = path.join(pilotRoot, 'hooks');
    const taskHome = path.join(tempRoot, 'task-home');
    const codexHome = path.join(tempRoot, 'task-codex-home');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.mkdirSync(taskHome, { recursive: true });
    fs.writeFileSync(path.join(pilotRoot, 'node-bin'), process.execPath, 'utf8');
    fs.copyFileSync(WRAPPER, path.join(hookDir, 'codex-loongsuite-pilot-hook.ps1'));
    fs.copyFileSync(PROCESSOR, path.join(hookDir, 'codex-hook-processor.mjs'));
    fs.cpSync(SHARED_HOOK_ASSETS, path.join(hookDir, 'shared'), { recursive: true });

    const env = {
      ...process.env,
      USERPROFILE: taskHome,
      HOME: taskHome,
      CODEX_HOME: codexHome,
    };
    delete env.LOONGSUITE_PILOT_DATA_DIR;
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(hookDir, 'codex-loongsuite-pilot-hook.ps1'),
        'session-start',
      ],
      {
        input: Buffer.from(JSON.stringify({ session_id: 'windows-custom-codex-home' }), 'utf8'),
        env,
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    const marker = path.join(
      pilotRoot,
      'state',
      'codex',
      'transcript-wakeups',
      'windows-custom-codex-home.json',
    );
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toMatchObject({
      session_id: 'windows-custom-codex-home',
      codex_home: codexHome,
      session_dir: path.join(codexHome, 'sessions'),
    });
    expect(fs.existsSync(path.join(taskHome, '.loongsuite-pilot'))).toBe(false);
  });
});
