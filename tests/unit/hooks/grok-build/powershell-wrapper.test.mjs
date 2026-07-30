import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(
  dirname,
  '../../../../assets/hooks/grok-build-loongsuite-pilot-hook.ps1',
);
const wrapperText = fs.readFileSync(WRAPPER, 'utf8');
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

describe('Grok Build PowerShell hook wrapper contract', () => {
  test('supports only the four production lifecycle hooks', () => {
    for (const event of ['stop', 'stop-failure', 'user-prompt-submit', 'session-end']) {
      expect(wrapperText).toContain(`"${event}"`);
    }
    for (const retired of ['subagent-start', 'subagent-stop', 'subagent-end']) {
      expect(wrapperText).not.toContain(`"${retired}"`);
    }
  });

  test('derives custom dataDir, requires Node 18, preserves raw stdin, and fails open', () => {
    expect(wrapperText).toContain('$env:LOONGSUITE_PILOT_DATA_DIR = $PilotDataDir');
    expect(wrapperText).toContain('$MIN_NODE_MAJOR = 18');
    expect(wrapperText).toContain('[Console]::OpenStandardInput()');
    expect(wrapperText).toContain('$process.StandardInput.BaseStream.Write($rawBytes');
    expect(wrapperText).toContain('Write-EmptyResult');
    expect(wrapperText).toContain('exit 0');
  });
});

describe.runIf(process.platform === 'win32')('Grok Build PowerShell hook wrapper runtime', () => {
  test('preserves UTF-8 stdin through a custom data directory with spaces', () => {
    const pilotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Grok Pilot 用户 With Space-'));
    tempDirs.push(pilotRoot);
    const hookDir = path.join(pilotRoot, 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.copyFileSync(WRAPPER, path.join(hookDir, path.basename(WRAPPER)));
    fs.writeFileSync(path.join(pilotRoot, 'node-bin'), toMsysPath(process.execPath), 'utf8');
    fs.writeFileSync(
      path.join(hookDir, 'grok-build-hook-processor.mjs'),
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "for await (const chunk of process.stdin) input += chunk;",
        "fs.writeFileSync(path.join(process.env.LOONGSUITE_PILOT_DATA_DIR, 'captured.json'), input, 'utf8');",
        "process.stdout.write('{}');",
        '',
      ].join('\n'),
      'utf8',
    );
    const payload = {
      session_id: 'session-中文',
      prompt_id: 'prompt-测试',
      transcript_path: 'C:\\Users\\测试 User\\.grok\\sessions\\chat_history.jsonl',
    };

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(hookDir, path.basename(WRAPPER)),
        'stop',
      ],
      {
        input: Buffer.from(JSON.stringify(payload), 'utf8'),
        env: { ...process.env },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(JSON.parse(fs.readFileSync(path.join(pilotRoot, 'captured.json'), 'utf8')))
      .toEqual(payload);
  });

  test('returns an empty result when the processor is missing', () => {
    const pilotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Grok Pilot Missing Processor-'));
    tempDirs.push(pilotRoot);
    const hookDir = path.join(pilotRoot, 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.copyFileSync(WRAPPER, path.join(hookDir, path.basename(WRAPPER)));

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(hookDir, path.basename(WRAPPER)),
        'stop',
      ],
      {
        input: Buffer.from('{}', 'utf8'),
        env: { ...process.env },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
  });
});
