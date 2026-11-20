import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function runHook(subcommand, payload, extraEnv = {}, processor = PROCESSOR) {
  const env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir, ...extraEnv };
  if (!Object.hasOwn(extraEnv, 'LOONGSUITE_PILOT_SPAN_ATTRIBUTES')) {
    delete env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
  }
  return spawnSync('node', [processor, subcommand], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function markerPath(sessionId) {
  return path.join(dataDir, 'state', 'codex', 'transcript-wakeups', `${sessionId}.json`);
}

function spanContextPath(sessionId, turnId) {
  return path.join(
    dataDir,
    'state',
    'codex',
    'transcript-span-contexts',
    `${sessionId}--${turnId}.json`,
  );
}

function timingSpoolPath(root = dataDir) {
  return path.join(root, 'state', 'hook-metrics', 'codex.jsonl');
}

function timingSamples(root = dataDir) {
  return fs.readFileSync(timingSpoolPath(root), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

function installProcessor() {
  const hookDir = path.join(dataDir, 'hooks');
  const sharedDir = path.join(hookDir, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  const processor = path.join(hookDir, 'codex-hook-processor.mjs');
  fs.copyFileSync(PROCESSOR, processor);
  for (const name of fs.readdirSync(SHARED_HOOK_ASSETS)) {
    fs.copyFileSync(path.join(SHARED_HOOK_ASSETS, name), path.join(sharedDir, name));
  }
  return processor;
}

describe('codex transcript discovery hook', () => {
  test('deploys early discovery hooks while retiring telemetry-heavy hooks', () => {
    const definition = JSON.parse(fs.readFileSync(AGENT_DEFINITION, 'utf8'));

    expect(definition.hook.events).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'SubagentStart',
      'SubagentStop',
      'Stop',
    ]);
    expect(definition.hook.retiredEvents).toEqual([
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
    ]);
    expect(definition.hook).not.toHaveProperty('replaceHookCommands');
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

  test('records the isolated user session directory from transcript_path', () => {
    const codexHome = path.join(dataDir, 'codex-home');
    const isolatedSessionDir = path.join(codexHome, 'u', 'd4bb12dfd37d67c70484b62e0ed31509', 'sessions');
    const transcriptPath = path.join(
      isolatedSessionDir,
      '2026',
      '09',
      '17',
      'rollout-2026-09-17T02-43-12-session.jsonl',
    );

    const result = runHook('stop', {
      session_id: 'cdx-isolated-home',
      turn_id: 'turn-isolated-home',
      transcript_path: transcriptPath,
    }, { CODEX_HOME: codexHome });

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(markerPath('cdx-isolated-home'), 'utf8'))).toMatchObject({
      codex_home: codexHome,
      session_dir: isolatedSessionDir,
      transcript_path: transcriptPath,
    });
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

  test('normalizes SubagentStart to the child rollout identity', () => {
    const childTranscript = '/tmp/rollout-child.jsonl';
    const result = runHook('subagent-start', {
      session_id: 'parent-session',
      agent_id: 'child-session',
      turn_id: 'child-turn',
      transcript_path: childTranscript,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(markerPath('child-session'), 'utf8'))).toMatchObject({
      session_id: 'child-session',
      turn_id: 'child-turn',
      initial_turn_id: 'child-turn',
      transcript_path: childTranscript,
      hook_event: 'subagent-start',
    });
    expect(fs.existsSync(markerPath('parent-session'))).toBe(false);
  });

  test('normalizes SubagentStop and preserves the SubagentStart anchor', () => {
    const childTranscript = '/tmp/rollout-child.jsonl';
    runHook('subagent-start', {
      session_id: 'parent-session',
      agent_id: 'child-session',
      turn_id: 'child-turn',
      transcript_path: childTranscript,
    });
    const result = runHook('subagent-stop', {
      session_id: 'parent-session',
      agent_id: 'child-session',
      turn_id: 'child-turn',
      transcript_path: '/tmp/rollout-parent.jsonl',
      agent_transcript_path: childTranscript,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(markerPath('child-session'), 'utf8'))).toMatchObject({
      session_id: 'child-session',
      turn_id: 'child-turn',
      initial_turn_id: 'child-turn',
      recovery_turn_id: 'child-turn',
      transcript_path: childTranscript,
      hook_event: 'subagent-stop',
    });
  });

  test('records Stop as recovery evidence without claiming it is the initial turn', () => {
    const result = runHook('stop', {
      session_id: 'fork-session',
      turn_id: 'latest-terminal-turn',
      transcript_path: '/tmp/rollout-fork.jsonl',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(markerPath('fork-session'), 'utf8'))).toMatchObject({
      session_id: 'fork-session',
      turn_id: 'latest-terminal-turn',
      recovery_turn_id: 'latest-terminal-turn',
      hook_event: 'stop',
    });
    expect(JSON.parse(fs.readFileSync(markerPath('fork-session'), 'utf8')))
      .not.toHaveProperty('initial_turn_id');
  });

  test('does not promote a later UserPromptSubmit after terminal recovery evidence', () => {
    runHook('stop', {
      session_id: 'multi-turn-fork',
      turn_id: 'first-terminal-turn',
      transcript_path: '/tmp/rollout-multi-turn.jsonl',
    });
    runHook('user-prompt-submit', {
      session_id: 'multi-turn-fork',
      turn_id: 'later-prompt-turn',
      transcript_path: '/tmp/rollout-multi-turn.jsonl',
    });

    const marker = JSON.parse(fs.readFileSync(markerPath('multi-turn-fork'), 'utf8'));
    expect(marker).not.toHaveProperty('initial_turn_id');
    expect(marker.recovery_turn_id).toBe('first-terminal-turn');
    expect(marker.turn_id).toBe('later-prompt-turn');
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

  test.each(['user-prompt-submit', 'stop'])(
    'writes filtered invocation span attributes for %s',
    subcommand => {
      const longValue = 'x'.repeat(513);
      const result = runHook(subcommand, {
        session_id: 'cdx-span-context',
        turn_id: 'turn-span-context',
      }, {
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES: [
          'multica.issue.id=issue-1',
          'multica.agent.name=codex',
          'gen_ai.agent.name=must-not-overwrite',
          'multica.secret=must-not-leak',
          `multica.long=${longValue}`,
          'malformed',
        ].join(','),
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(
        spanContextPath('cdx-span-context', 'turn-span-context'),
        'utf8',
      ))).toMatchObject({
        session_id: 'cdx-span-context',
        turn_id: 'turn-span-context',
        spanAttributes: {
          'multica.issue.id': 'issue-1',
          'multica.agent.name': 'codex',
        },
        received_at: expect.any(String),
      });
      const serialized = fs.readFileSync(
        spanContextPath('cdx-span-context', 'turn-span-context'),
        'utf8',
      );
      expect(serialized).not.toContain('must-not-overwrite');
      expect(serialized).not.toContain('must-not-leak');
      expect(serialized).not.toContain(longValue);
    },
  );

  test('does not persist invocation span attributes for SessionStart', () => {
    const result = runHook('session-start', {
      session_id: 'cdx-session-start',
      turn_id: 'turn-session-start',
    }, {
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES: 'multica.issue.id=issue-session-start',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(spanContextPath('cdx-session-start', 'turn-session-start'))).toBe(false);
    expect(fs.existsSync(markerPath('cdx-session-start'))).toBe(true);
  });

  test('keeps invocation span attributes isolated by turn within one session', () => {
    runHook('user-prompt-submit', {
      session_id: 'cdx-shared-session',
      turn_id: 'turn-1',
    }, {
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES: 'multica.issue.id=issue-1',
    });
    runHook('user-prompt-submit', {
      session_id: 'cdx-shared-session',
      turn_id: 'turn-2',
    }, {
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES: 'multica.issue.id=issue-2',
    });

    expect(JSON.parse(fs.readFileSync(
      spanContextPath('cdx-shared-session', 'turn-1'),
      'utf8',
    )).spanAttributes).toEqual({ 'multica.issue.id': 'issue-1' });
    expect(JSON.parse(fs.readFileSync(
      spanContextPath('cdx-shared-session', 'turn-2'),
      'utf8',
    )).spanAttributes).toEqual({ 'multica.issue.id': 'issue-2' });
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

  test('logs span context write failures without blocking the wakeup marker', () => {
    fs.mkdirSync(path.join(dataDir, 'state', 'codex'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'state', 'codex', 'transcript-span-contexts'),
      'not-a-directory',
    );

    const result = runHook('user-prompt-submit', {
      session_id: 'cdx-span-error',
      turn_id: 'turn-span-error',
    }, {
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES: 'multica.issue.id=issue-error',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(fs.existsSync(markerPath('cdx-span-error'))).toBe(true);
    const errorDir = path.join(dataDir, 'logs', 'codex', 'errors');
    const errorFiles = fs.readdirSync(errorDir);
    expect(errorFiles.some(file => (
      fs.readFileSync(path.join(errorDir, file), 'utf8').includes('"stage":"span_context_write"')
    ))).toBe(true);
  });

  test('records the duration of every call in the timing spool', () => {
    runHook('session-start', { session_id: 'cdx-timing' });
    runHook('stop', { session_id: 'cdx-timing', turn_id: 'turn-timing' });

    const samples = timingSamples();
    expect(samples.map(sample => sample.hook_event)).toEqual(['session-start', 'stop']);
    for (const sample of samples) {
      expect(Object.keys(sample).sort()).toEqual(['duration_ms', 'hook_event']);
      expect(Number.isInteger(sample.duration_ms)).toBe(true);
      expect(sample.duration_ms).toBeGreaterThanOrEqual(0);
    }
    // The writers' lock is released once the sample is appended.
    expect(fs.readdirSync(path.dirname(timingSpoolPath()))).toEqual(['codex.jsonl']);
  });

  test('times ignored events too, with an invalid event name recorded as unknown', () => {
    const ignored = runHook('pre-tool-use', { session_id: 'cdx-ignore', tool_name: 'Bash' });
    const invalid = runHook('Not An Event', { session_id: 'cdx-ignore' });

    expect(ignored.stdout.trim()).toBe('{}');
    expect(invalid.stdout.trim()).toBe('{}');
    expect(timingSamples().map(sample => sample.hook_event)).toEqual(['pre-tool-use', 'unknown']);
  });

  test('drops new samples once the spool reaches its cap', () => {
    fs.mkdirSync(path.dirname(timingSpoolPath()), { recursive: true });
    const full = `${'x'.repeat(1024 * 1024 - 1)}\n`;
    fs.writeFileSync(timingSpoolPath(), full);

    const result = runHook('stop', { session_id: 'cdx-spool-full', turn_id: 'turn-spool-full' });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(fs.readFileSync(timingSpoolPath(), 'utf8')).toBe(full);
    expect(fs.existsSync(markerPath('cdx-spool-full'))).toBe(true);
  });

  test.each(['missing', 'syntax-error', 'initialization-error'])(
    'keeps the response, span context and wakeup when the timing module has a %s failure',
    failure => {
      const processor = installProcessor();
      const timingModule = path.join(path.dirname(processor), 'shared', 'hook-metrics.mjs');
      if (failure === 'missing') fs.unlinkSync(timingModule);
      else fs.writeFileSync(timingModule, failure === 'syntax-error'
        ? 'export function recordHookTiming('
        : 'throw new Error("timing initialization failed"); export function recordHookTiming() {}');
      const result = runHook('stop', {
        session_id: 'cdx-optional-metrics', turn_id: 'turn-optional-metrics',
      }, {
        CODEX_HOME: path.join(dataDir, 'task-codex-home'),
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES: 'multica.issue.id=issue-optional-metrics',
      }, processor);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{}');
      expect(result.stderr).toBe('');
      expect(JSON.parse(fs.readFileSync(markerPath('cdx-optional-metrics'), 'utf8'))).toMatchObject({
        codex_home: path.join(dataDir, 'task-codex-home'),
        turn_id: 'turn-optional-metrics',
      });
      expect(JSON.parse(fs.readFileSync(
        spanContextPath('cdx-optional-metrics', 'turn-optional-metrics'), 'utf8',
      )).spanAttributes).toEqual({ 'multica.issue.id': 'issue-optional-metrics' });
      expect(fs.existsSync(timingSpoolPath())).toBe(false);
    },
  );

  test('captures through the response write but excludes optional module loading', () => {
    const processor = installProcessor();
    const timingModule = path.join(path.dirname(processor), 'shared', 'hook-metrics.mjs');
    fs.writeFileSync(timingModule, `
      import { performance as testClock } from 'node:perf_hooks';
      Object.defineProperty(testClock, 'now', { configurable: true, value: () => 900 });
    ` + fs.readFileSync(timingModule, 'utf8'));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { performance } from 'node:perf_hooks';
      let now = 10;
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
      const read = fs.readFileSync;
      fs.readFileSync = (...args) => {
        if (args[0] === 0) now = 40;
        return read(...args);
      };
      const write = process.stdout.write;
      process.stdout.write = function (...args) {
        now = 80;
        return write.apply(this, args);
      };
      process.argv[2] = 'stop';
      await import(${JSON.stringify(pathToFileURL(processor).href)});
    `], {
      input: JSON.stringify({ session_id: 'cdx-timing-boundary' }),
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(fs.existsSync(markerPath('cdx-timing-boundary'))).toBe(true);
    expect(timingSamples()).toEqual([{ hook_event: 'stop', duration_ms: 80 }]);
  });

  test('keeps the response and wakeup when the timing lock remains held', () => {
    fs.mkdirSync(path.dirname(timingSpoolPath()), { recursive: true });
    const lock = `${timingSpoolPath()}.lock`;
    fs.writeFileSync(lock, 'holder');

    const result = runHook('stop', { session_id: 'cdx-timing-lock', turn_id: 'turn-timing-lock' });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(fs.existsSync(markerPath('cdx-timing-lock'))).toBe(true);
    expect(fs.existsSync(timingSpoolPath())).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe('holder');
  });

  test('keeps the hook response when the timing spool cannot be written', () => {
    fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state', 'hook-metrics'), 'not-a-directory');

    const result = runHook('stop', { session_id: 'cdx-spool-error', turn_id: 'turn-spool-error' });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(fs.existsSync(markerPath('cdx-spool-error'))).toBe(true);
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
    // The timing sample follows the same data directory as the wakeup marker.
    expect(timingSamples(pilotRoot).map(sample => sample.hook_event)).toEqual(['session-start']);
    expect(fs.existsSync(path.join(taskHome, '.loongsuite-pilot'))).toBe(false);
  });
});
