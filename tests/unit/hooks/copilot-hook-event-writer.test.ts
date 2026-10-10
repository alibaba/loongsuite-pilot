import { spawnSync } from 'node:child_process';
import { access, constants, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WRITER = path.resolve('assets/hooks/copilot-hook-event-writer.mjs');
let dataDir: string;

beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'copilot-hook-')); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

function run(subcommand: string, payload: unknown) {
  return spawnSync(process.execPath, [WRITER, subcommand], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

async function wakeups(): Promise<Record<string, unknown>[]> {
  const base = path.join(dataDir, 'state', 'copilot', 'wakeups');
  let names: string[];
  try { names = await readdir(base); } catch { return []; }
  const out: Record<string, unknown>[] = [];
  for (const name of names) {
    if (name.endsWith('.json')) out.push(JSON.parse(await readFile(path.join(base, name), 'utf8')));
  }
  return out;
}

describe('copilot hook event writer', () => {
  it('records a structural wakeup and prints nothing', async () => {
    const result = run('user-prompt-submit', {
      session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: 'SECRET PROMPT', cwd: '/secret/cwd',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const [hint] = await wakeups();
    expect(hint).toMatchObject({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit' });
    expect(JSON.stringify(hint)).not.toContain('SECRET PROMPT');
    expect(JSON.stringify(hint)).not.toContain('/secret/cwd');
  });

  it('keeps the transcript path when the payload carries one', async () => {
    run('stop', { session_id: 'sess-2', transcript_path: '/x/events.jsonl' });
    expect((await wakeups())[0]).toMatchObject({ hook_event_name: 'Stop', transcript_path: '/x/events.jsonl' });
  });

  it('falls back to the subcommand when the payload has no event name', async () => {
    run('session-start', { session_id: 'sess-3' });
    expect((await wakeups())[0]).toMatchObject({ hook_event_name: 'SessionStart' });
  });

  it('is fail-open on malformed input and missing session id', async () => {
    for (const payload of ['not json', {}, '']) {
      const result = run('stop', payload);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }
    expect(await wakeups()).toEqual([]);
  });
});

describe('copilot hook wrappers', () => {
  const sh = path.resolve('assets/hooks/copilot-loongsuite-pilot-hook.sh');
  const ps1 = path.resolve('assets/hooks/copilot-loongsuite-pilot-hook.ps1');

  it('shell wrapper is executable, targets the Copilot writer and stays silent', async () => {
    await expect(access(sh, constants.X_OK)).resolves.toBeUndefined();
    const text = await readFile(sh, 'utf8');
    expect(text).toContain('copilot-hook-event-writer.mjs');
    expect(text).not.toMatch(/workbuddy/i);
    expect(text).not.toContain("printf '{}");
  });

  it('PowerShell wrapper targets the Copilot writer and never prints a JSON acknowledgement', async () => {
    const text = await readFile(ps1, 'utf8');
    expect(text).toContain('copilot-hook-event-writer.mjs');
    expect(text).not.toMatch(/workbuddy/i);
    expect(text).not.toContain('EMPTY_RESULT');
  });

  it('shell wrapper exits 0 and prints nothing even when the payload is garbage', () => {
    const result = spawnSync('bash', [sh, 'stop'], {
      input: 'garbage',
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
