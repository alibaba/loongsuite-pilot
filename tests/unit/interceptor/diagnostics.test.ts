import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { managedInterceptorPath } from '../../../src/interceptor/managed/config.js';
import { ManagedInterceptor } from '../../../src/interceptor/managed/controller.js';
import { ManagedRuleEngine } from '../../../src/interceptor/managed/engine.js';
import { ManagedRegexRunner } from '../../../src/interceptor/managed/regex-runner.js';
import { recordInterceptorDiagnostic, InterceptorAlarmReporter, INTERCEPTOR_ALARM_COOLDOWN_MS } from '../../../src/interceptor/diagnostics.js';
import { AlarmManager } from '../../../src/metrics/alarm-manager.js';

describe('interceptor self-monitoring', () => {
  it('counts persistent cache rejection across cooldowns and stops reporting after recovery', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-cache-diagnostics-'));
    const manager = new AlarmManager({ ip: '127.0.0.1', version: '1', userId: 'test' });
    let now = 0;
    const reporter = new InterceptorAlarmReporter(manager, () => now);
    const controller = new ManagedInterceptor({ dataDir, onDiagnostic: reporter.record });
    const file = managedInterceptorPath(dataDir);
    try {
      await mkdir(join(dataDir, 'configs', 'managed'), { recursive: true });
      await writeFile(file, '{invalid');
      controller.reload();
      expect(manager.serialize()[0]).toMatchObject({ alarm_type: 'MANAGED_CONFIG_ALARM', alarm_count: '1' });
      now = 3_000;
      controller.reload();
      expect(manager.serialize()).toEqual([]);
      now = INTERCEPTOR_ALARM_COOLDOWN_MS - 1;
      controller.reload();
      expect(manager.serialize()).toEqual([]);
      now = INTERCEPTOR_ALARM_COOLDOWN_MS;
      controller.reload();
      expect(manager.serialize()).toEqual([expect.objectContaining({ alarm_count: '3' })]);
      now = INTERCEPTOR_ALARM_COOLDOWN_MS + 3_000;
      controller.reload();
      expect(manager.serialize()).toEqual([]);
      now = 2 * INTERCEPTOR_ALARM_COOLDOWN_MS;
      controller.reload();
      expect(manager.serialize()).toEqual([expect.objectContaining({ alarm_count: '2' })]);
      now += 3_000;
      controller.reload(); // Suppressed fault must not be emitted after recovery.
      await writeFile(file, JSON.stringify({ interceptor: { rules: [] } }));
      controller.reload();
      now = 3 * INTERCEPTOR_ALARM_COOLDOWN_MS;
      controller.reload();
      expect(manager.serialize()).toEqual([]);
    } finally {
      controller.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('still reports a matching thread that exits unexpectedly', async () => {
    const regex = new ManagedRegexRunner(5_000);
    const onDiagnostic = vi.fn();
    const engine = new ManagedRuleEngine({
      config: { rules: [{ kind: 'pattern', id: 'r', version: '1', agents: ['qoder'],
        events: ['UserPromptSubmit'], enforcement: 'enforce', match: 'regex', pattern: '(a+)+$' }] },
      rules: [], runners: {}, regex, regexTimeoutMs: 5_000, budgetMs: 5_000, onDiagnostic,
    });
    try {
      await regex.test('warm', 'warm');
      const state = regex as unknown as { worker: Worker; pending: { worker: Worker | null } | null };
      const worker = state.worker;
      const pending = engine.evaluate({ agent: 'qoder', event: 'UserPromptSubmit', prompt: 'a'.repeat(32) + '!', raw: {} });
      await vi.waitFor(() => expect(state.pending?.worker).toBe(worker));
      await worker.terminate();
      await expect(pending).resolves.toMatchObject({ action: 'allow', failOpen: true });
      expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'regex_failed', ruleId: 'r' }), 1);
    } finally {
      regex.stop();
    }
  });
  it('limits repeated faults across rules and versions and carries suppressed counts into the next eligible report', () => {
    const manager = new AlarmManager({ ip: '127.0.0.1', version: '1', userId: 'test' });
    let now = 0;
    const reporter = new InterceptorAlarmReporter(manager, () => now);
    const diagnostic = { code: 'regex_timeout' as const, source: 'regex' as const, reason: 'timeout', ruleId: 'first' };
    reporter.record(diagnostic, 3);
    expect(manager.serialize()[0].alarm_count).toBe('3');
    for (let i = 0; i < 1000; i++) {
      now++;
      reporter.record({ ...diagnostic, ruleId: String(i), ruleVersion: String(i) });
    }
    expect(manager.serialize()).toEqual([]);
    now = INTERCEPTOR_ALARM_COOLDOWN_MS - 1;
    reporter.record(diagnostic, 7);
    expect(manager.serialize()).toEqual([]);
    now = INTERCEPTOR_ALARM_COOLDOWN_MS;
    reporter.record(diagnostic, 2);
    expect(manager.serialize()[0].alarm_count).toBe('1009');
  });

  it('allows a new diagnostic category during another category cooldown', () => {
    const manager = new AlarmManager({ ip: '127.0.0.1', version: '1', userId: 'test' });
    const reporter = new InterceptorAlarmReporter(manager, () => 0);
    reporter.record({ code: 'config_rejected', source: 'remote', reason: 'invalid JSON' });
    expect(manager.serialize()[0].alarm_type).toBe('MANAGED_CONFIG_ALARM');
    reporter.record({ code: 'regex_timeout', source: 'regex', reason: 'timeout' });
    expect(manager.serialize()[0].alarm_type).toBe('INTERCEPTOR_REGEX_ALARM');
  });
  it.each([
    [49.9, false, 0], [50, false, 1], [100, true, 1],
  ])('reports %sms execution, matched=%s, without changing the verdict', async (durationMs, matched, alarms) => {
    const manager = new AlarmManager({ ip: '127.0.0.1', version: '1', userId: 'test' });
    const regex = new ManagedRegexRunner();
    vi.spyOn(regex, 'test').mockImplementation(async (_pattern, _text, _timeout, onExecuted) => {
      onExecuted?.(durationMs);
      return matched;
    });
    const engine = new ManagedRuleEngine({
      config: { rules: [{ kind: 'pattern', id: 'test-rule', version: '2', agents: ['qoder'],
        events: ['UserPromptSubmit'], enforcement: 'enforce', match: 'regex', pattern: 'private-pattern' }] },
      rules: [], runners: {}, regex,
      onDiagnostic: (diagnostic, count) => recordInterceptorDiagnostic(manager, diagnostic, count),
    });
    const result = await engine.evaluate({ agent: 'qoder', event: 'UserPromptSubmit', prompt: 'private-prompt', raw: {} });
    expect(result.action).toBe(matched ? 'block' : 'allow');
    expect(result.failOpen).toBeUndefined();
    const entries = manager.serialize();
    expect(entries).toHaveLength(alarms);
    if (alarms) {
      expect(entries[0]).toMatchObject({ alarm_type: 'INTERCEPTOR_REGEX_ALARM', alarm_level: '2', alarm_count: '1', input_name: 'interceptor' });
      expect(JSON.parse(entries[0].alarm_message)).toMatchObject({ code: 'regex_slow', ruleId: 'test-rule', ruleVersion: '2', durationMs, limitMs: 50 });
      expect(entries[0].alarm_message).not.toMatch(/private-pattern|private-prompt/);
    }
    regex.stop();
  });

  it('keeps the verdict when the diagnostic observer throws', async () => {
    const regex = new ManagedRegexRunner();
    vi.spyOn(regex, 'test').mockImplementation(async (_pattern, _text, _timeout, onExecuted) => {
      onExecuted?.(60);
      return true;
    });
    const engine = new ManagedRuleEngine({
      config: { rules: [{ kind: 'pattern', id: 'r', version: '1', agents: ['qoder'],
        events: ['UserPromptSubmit'], enforcement: 'enforce', match: 'regex', pattern: 'x' }] },
      rules: [], runners: {}, regex,
      onDiagnostic: () => { throw new Error('monitor unavailable'); },
    });
    await expect(engine.evaluate({ agent: 'qoder', event: 'UserPromptSubmit', prompt: 'x', raw: {} }))
      .resolves.toMatchObject({ action: 'block', ruleId: 'r' });
    regex.stop();
  });
});
