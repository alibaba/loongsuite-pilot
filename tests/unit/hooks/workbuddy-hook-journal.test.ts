import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const processor = path.resolve('assets/hooks/workbuddy-hook-journal.mjs');

describe('workbuddy hook journal', () => {
  it('writes only structural fields and fails open', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'workbuddy-hook-'));
    const input = JSON.stringify({
      session_id: 'safe-session',
      transcript_path: '/tmp/safe/session.jsonl',
      cwd: '/tmp/safe',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      call_id: 'safe-call',
      prompt: 'DO_NOT_PERSIST_PROMPT',
      tool_input: { command: 'DO_NOT_PERSIST_ARGUMENTS' },
      tool_response: 'DO_NOT_PERSIST_RESULT',
    });
    const output = execFileSync(process.execPath, [processor, 'pre-tool-use'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    });
    expect(output.trim()).toBe('{}');
    const day = new Date().toISOString().slice(0, 10);
    const text = await readFile(path.join(dataDir, 'logs', 'workbuddy', `wakeup-${day}.jsonl`), 'utf8');
    expect(text).toContain('safe-session');
    expect(text).toContain('safe-call');
    expect(text).not.toContain('DO_NOT_PERSIST');

    expect(() => execFileSync(process.execPath, [processor, 'stop'], {
      input: '{bad-json', encoding: 'utf8', env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    })).not.toThrow();
  });

  it('derives the Pilot data directory from its installed hooks directory', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'workbuddy-hook-installed-'));
    const hooksDir = path.join(dataDir, 'hooks');
    const installedProcessor = path.join(hooksDir, 'workbuddy-hook-journal.mjs');
    await mkdir(hooksDir, { recursive: true });
    await copyFile(processor, installedProcessor);

    execFileSync(process.execPath, [installedProcessor, 'session-start'], {
      input: JSON.stringify({ session_id: 'installed-session' }),
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'LOONGSUITE_PILOT_DATA_DIR'),
      ),
    });

    const day = new Date().toISOString().slice(0, 10);
    const text = await readFile(path.join(dataDir, 'logs', 'workbuddy', `wakeup-${day}.jsonl`), 'utf8');
    expect(text).toContain('installed-session');
  });
});
