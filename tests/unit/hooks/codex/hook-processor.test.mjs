import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/codex-hook-processor.mjs');
const SHELL_WRAPPER = path.resolve(__dirname, '../../../../assets/hooks/codex-loongsuite-pilot-hook.sh');
const SHARED_HOOK_ASSETS = path.resolve(__dirname, '../../../../assets/hooks/shared');
const AGENT_DEFINITION = path.resolve(__dirname, '../../../../agents.d/codex.json');

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

describe('codex transcript discovery hook', () => {
  test('deploys early discovery hooks while retiring telemetry-heavy hooks', () => {
    const definition = JSON.parse(fs.readFileSync(AGENT_DEFINITION, 'utf8'));

    expect(definition.hook.events).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    expect(definition.hook.retiredEvents).toEqual([
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
    ]);
  });

  test('writes an atomic wakeup marker with the effective CODEX_HOME', () => {
    const codexHome = path.join(dataDir, 'task-codex-home');
    const result = runHook('stop', {
      session_id: 'cdx-wakeup',
      turn_id: 'turn-wakeup',
      transcript_path: '/tmp/rollout-cdx-wakeup.jsonl',
    }, {
      CODEX_HOME: codexHome,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(JSON.parse(fs.readFileSync(markerPath('cdx-wakeup'), 'utf8'))).toMatchObject({
      session_id: 'cdx-wakeup',
      turn_id: 'turn-wakeup',
      transcript_path: '/tmp/rollout-cdx-wakeup.jsonl',
      codex_home: codexHome,
      session_dir: path.join(codexHome, 'sessions'),
    });
    expect(fs.existsSync(path.join(dataDir, 'logs', 'codex'))).toBe(false);
  });

  test.each(['session-start', 'user-prompt-submit', 'stop'])(
    'writes the discovery marker for %s',
    subcommand => {
      const codexHome = path.join(dataDir, `${subcommand}-codex-home`);
      const result = runHook(subcommand, {
        session_id: `cdx-${subcommand}`,
        turn_id: `turn-${subcommand}`,
      }, {
        CODEX_HOME: codexHome,
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(markerPath(`cdx-${subcommand}`), 'utf8'))).toMatchObject({
        session_id: `cdx-${subcommand}`,
        codex_home: codexHome,
        session_dir: path.join(codexHome, 'sessions'),
      });
    },
  );

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

  test('ignores non-discovery events and malformed session identifiers', () => {
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

  test('derives the shared Pilot data directory from the installed shell wrapper', () => {
    if (process.platform === 'win32') return;
    const pilotRoot = path.join(dataDir, 'shared-pilot');
    const hookDir = path.join(pilotRoot, 'hooks');
    const taskHome = path.join(dataDir, 'task-home');
    const codexHome = path.join(dataDir, 'task-codex-home');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.mkdirSync(taskHome, { recursive: true });
    fs.copyFileSync(PROCESSOR, path.join(hookDir, 'codex-hook-processor.mjs'));
    fs.copyFileSync(SHELL_WRAPPER, path.join(hookDir, 'codex-loongsuite-pilot-hook.sh'));
    fs.cpSync(SHARED_HOOK_ASSETS, path.join(hookDir, 'shared'), { recursive: true });
    fs.chmodSync(path.join(hookDir, 'codex-loongsuite-pilot-hook.sh'), 0o755);

    const env = {
      ...process.env,
      HOME: taskHome,
      CODEX_HOME: codexHome,
    };
    delete env.LOONGSUITE_PILOT_DATA_DIR;
    const result = spawnSync('bash', [
      path.join(hookDir, 'codex-loongsuite-pilot-hook.sh'),
      'session-start',
    ], {
      input: JSON.stringify({ session_id: 'cdx-wrapper' }),
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const marker = path.join(
      pilotRoot,
      'state',
      'codex',
      'transcript-wakeups',
      'cdx-wrapper.json',
    );
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toMatchObject({
      session_id: 'cdx-wrapper',
      codex_home: codexHome,
      session_dir: path.join(codexHome, 'sessions'),
    });
    expect(fs.existsSync(path.join(taskHome, '.loongsuite-pilot'))).toBe(false);
  });
});
