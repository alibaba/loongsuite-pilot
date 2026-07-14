import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/codex-hook-processor.mjs');

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-test-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function runHook(subcommand, payload, extraEnv = {}) {
  return spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir, ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function markerPath(sessionId) {
  return path.join(dataDir, 'state', 'codex', 'transcript-wakeups', `${sessionId}.json`);
}

describe('codex Stop wakeup hook', () => {
  test('writes an atomic wakeup marker without telemetry JSONL', () => {
    const result = runHook('stop', {
      session_id: 'cdx-wakeup',
      turn_id: 'turn-wakeup',
      transcript_path: '/tmp/rollout-cdx-wakeup.jsonl',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(JSON.parse(fs.readFileSync(markerPath('cdx-wakeup'), 'utf8'))).toMatchObject({
      session_id: 'cdx-wakeup',
      turn_id: 'turn-wakeup',
      transcript_path: '/tmp/rollout-cdx-wakeup.jsonl',
    });
    expect(fs.existsSync(path.join(dataDir, 'logs', 'codex'))).toBe(false);
  });

  test('writes AgentTeams resource attributes into the wakeup marker', () => {
    const result = runHook('stop', {
      session_id: 'cdx-agentteams',
      turn_id: 'turn-agentteams',
      transcript_path: '/tmp/rollout-cdx-agentteams.jsonl',
    }, {
      AGENTTEAMS_WORKER_NAME: 'codex-worker',
      AGENTTEAMS_INSTANCE_ID: 'lw-codex',
      AGENTTEAMS_TOKEN: 'should-not-leak',
    });

    expect(result.status).toBe(0);
    const marker = JSON.parse(fs.readFileSync(markerPath('cdx-agentteams'), 'utf8'));
    expect(marker.resourceAttributes).toEqual({
      'agentteams.worker.name': 'codex-worker',
      'agentteams.instance.id': 'lw-codex',
    });
    expect(JSON.stringify(marker)).not.toContain('should-not-leak');
  });

  test('keeps only the latest wakeup for one session', () => {
    runHook('stop', { session_id: 'cdx-overwrite', turn_id: 'turn-1' });
    runHook('stop', { session_id: 'cdx-overwrite', turn_id: 'turn-2' });

    expect(JSON.parse(fs.readFileSync(markerPath('cdx-overwrite'), 'utf8'))).toMatchObject({
      session_id: 'cdx-overwrite',
      turn_id: 'turn-2',
    });
  });

  test('ignores non-Stop events and malformed session identifiers', () => {
    runHook('pre-tool-use', { session_id: 'cdx-ignore', tool_name: 'Bash' });
    runHook('stop', { turn_id: 'turn-missing-session' });

    const markerDir = path.join(dataDir, 'state', 'codex', 'transcript-wakeups');
    expect(fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : []).toEqual([]);
  });

  test('acknowledges ignored events on stdout', () => {
    const result = runHook('pre-tool-use', { session_id: 'cdx-ignore', tool_name: 'Bash' });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
  });

  test('logs wakeup write failures without failing the hook', () => {
    fs.mkdirSync(path.join(dataDir, 'state', 'codex'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state', 'codex', 'transcript-wakeups'), 'not-a-directory');

    const result = runHook('stop', { session_id: 'cdx-error', turn_id: 'turn-error' });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    const errorDir = path.join(dataDir, 'logs', 'codex', 'errors');
    const errorFile = path.join(errorDir, fs.readdirSync(errorDir)[0]);
    expect(fs.readFileSync(errorFile, 'utf8')).toContain('"stage":"wakeup_write"');
  });
});
