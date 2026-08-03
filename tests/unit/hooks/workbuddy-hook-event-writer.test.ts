import { execFile, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const processor = path.resolve('assets/hooks/workbuddy-hook-event-writer.mjs');

function runWriterAsync(input: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [processor, 'pre-tool-use'], { env }, error => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.end(input);
  });
}

async function readEventRecords(dataDir: string): Promise<Array<Record<string, unknown>>> {
  const root = path.join(dataDir, 'state', 'workbuddy', 'hook-events');
  const sessionDirs = await readdir(root, { withFileTypes: true });
  const records: Array<Record<string, unknown>> = [];
  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory()) continue;
    const dir = path.join(root, sessionDir.name);
    const eventFiles = (await readdir(dir)).filter(name => name.endsWith('.json'));
    for (const eventFile of eventFiles) {
      records.push(JSON.parse(await readFile(path.join(dir, eventFile), 'utf8')));
    }
  }
  return records;
}

describe('workbuddy hook event writer', () => {
  it('writes only structural fields to an immutable session event and fails open', async () => {
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
    const records = await readEventRecords(dataDir);
    expect(records).toHaveLength(1);
    const text = JSON.stringify(records[0]);
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
    const installedProcessor = path.join(hooksDir, 'workbuddy-hook-event-writer.mjs');
    await mkdir(hooksDir, { recursive: true });
    await copyFile(processor, installedProcessor);
    // The processor imports ./shared/decode-payload.mjs; a real install ships it alongside.
    await mkdir(path.join(hooksDir, 'shared'), { recursive: true });
    await copyFile(
      path.resolve('assets/hooks/shared/decode-payload.mjs'),
      path.join(hooksDir, 'shared', 'decode-payload.mjs'),
    );

    execFileSync(process.execPath, [installedProcessor, 'session-start'], {
      input: JSON.stringify({
        session_id: 'installed-session',
        transcript_path: '/tmp/installed-session.jsonl',
      }),
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'LOONGSUITE_PILOT_DATA_DIR'),
      ),
    });

    expect(await readEventRecords(dataDir)).toMatchObject([
      { session_id: 'installed-session' },
    ]);
  });

  it('does not share a writable file between concurrent Hook processes', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'workbuddy-hook-concurrent-'));
    const env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir };
    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      runWriterAsync(
        JSON.stringify({
          session_id: 'parallel-session',
          transcript_path: '/tmp/parallel-session.jsonl',
          hook_event_name: 'PreToolUse',
          tool_name: 'ParallelTool',
          call_id: `call-${index}`,
        }),
        env,
      )));

    const records = await readEventRecords(dataDir);
    expect(records).toHaveLength(24);
    expect(new Set(records.map(record => record.tool_call_id)).size).toBe(24);
  });
});
