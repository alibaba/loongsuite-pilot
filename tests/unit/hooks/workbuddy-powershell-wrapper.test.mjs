import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(
  __dirname,
  '../../../assets/hooks/workbuddy-loongsuite-pilot-hook.ps1',
);
const PROCESSOR = path.resolve(
  __dirname,
  '../../../assets/hooks/workbuddy-hook-event-writer.mjs',
);
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function powershellPath() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function pathWithoutNode() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return [
    path.join(systemRoot, 'System32'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(';');
}

function readWorkBuddyEvents(dataDir) {
  const root = path.join(dataDir, 'state', 'workbuddy', 'hook-events');
  const records = [];
  for (const sessionDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!sessionDir.isDirectory()) continue;
    const dir = path.join(root, sessionDir.name);
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
    }
  }
  return records;
}

describe.runIf(process.platform === 'win32')('WorkBuddy PowerShell hook wrapper', () => {
  test('uses installer-pinned node-bin for immediate hook wakeup when PATH lacks Node', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Pilot WorkBuddy Hook-'));
    tempDirs.push(tempRoot);
    const dataDir = path.join(tempRoot, 'pilot-data');
    const hooksDir = path.join(dataDir, 'hooks');
    const userProfile = path.join(tempRoot, 'user');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.mkdirSync(userProfile, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'node-bin'), process.execPath, 'utf8');
    fs.copyFileSync(WRAPPER, path.join(hooksDir, 'workbuddy-loongsuite-pilot-hook.ps1'));
    fs.copyFileSync(PROCESSOR, path.join(hooksDir, 'workbuddy-hook-event-writer.mjs'));
    const env = {
      ...process.env,
      USERPROFILE: userProfile,
      HOME: userProfile,
      PATH: pathWithoutNode(),
    };
    delete env.LOONGSUITE_PILOT_DATA_DIR;

    const startedAt = Date.now();
    const result = spawnSync(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(hooksDir, 'workbuddy-loongsuite-pilot-hook.ps1'),
        'pre-tool-use',
      ],
      {
        input: Buffer.from(JSON.stringify({
          session_id: 'windows-pinned-node-session',
          transcript_path: 'C:\\Users\\Test\\.workbuddy\\projects\\demo\\session.jsonl',
          cwd: 'C:\\Users\\Test\\repo',
          tool_name: 'Write',
          call_id: 'call-from-hook',
        }), 'utf8'),
        env,
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    const records = readWorkBuddyEvents(dataDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      session_id: 'windows-pinned-node-session',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_call_id: 'call-from-hook',
    });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(fs.existsSync(path.join(userProfile, '.loongsuite-pilot'))).toBe(false);
  });
});
