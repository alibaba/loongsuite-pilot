import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InterceptorStatusCollector, type InterceptorRuleStatus } from '../../../src/interceptor/status.js';
import { ManagedInterceptor } from '../../../src/interceptor/managed/controller.js';
import { managedInterceptorPath, managedScriptsDir } from '../../../src/interceptor/managed/config.js';

const EMPTY_RULES: InterceptorRuleStatus = {
  configured: 0, config_valid: true, effective: 0, pattern: 0, regex: 0, substring: 0,
  script: 0, audit: 0, enforce: 0, pending_scripts: 0, unsupported_http: 0,
};

describe('interceptor status', () => {
  it('counts outcomes and fixed histogram totals without draining snapshots', () => {
    const collector = new InterceptorStatusCollector();
    expect(collector.snapshot(true, EMPTY_RULES).activity?.duration_ms_avg).toBeNull();
    for (let i = 0; i < 19; i++) collector.record({
      action: 'allow', evaluatedRules: [], matched: true,
      matches: [{ matched: true, action: 'log', reason: 'audit', ruleId: 'r', ruleVersion: '1' }],
    }, 10);
    collector.record(null, 5_000);
    collector.recordDiagnostic({ code: 'regex_timeout', source: 'regex', reason: 'timeout' });
    const status = collector.snapshot(true, EMPTY_RULES);
    expect(status.activity).toMatchObject({
      evaluations_total: 20, blocked_total: 0, matched_total: 19, audit_hits_total: 19,
      fail_open_total: 1, evaluation_errors_total: 1, duration_ms_total: 5190,
      duration_ms_avg: 259.5, duration_ms_max: 5000, duration_ms_p95_upper: 10,
      duration_over_3500ms_total: 1,
    });
    expect(status.diagnostics?.regex_timeout).toBe(1);
    if (status.diagnostics) status.diagnostics.regex_timeout = 999;
    expect(collector.snapshot(false, EMPTY_RULES).diagnostics?.regex_timeout).toBe(1);
    collector.record({ action: 'block', evaluatedRules: ['r'] }, 5); // Count blocking verdicts even without matched metadata.
    collector.record({ action: 'allow', failOpen: true, evaluatedRules: [] }, 5);
    expect(collector.snapshot(true, EMPTY_RULES).activity).toMatchObject({
      evaluations_total: 22, blocked_total: 1, matched_total: 20, fail_open_total: 2, evaluation_errors_total: 1,
    });
  });

  it('distinguishes configured, executable, pending and unsupported rules and retains the last valid generation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-rule-status-'));
    const controller = new ManagedInterceptor({ dataDir, platform: 'linux', createRunners: () => ({}) });
    const base = { version: '1', agents: ['qoder'], events: ['UserPromptSubmit'] };
    try {
      await mkdir(managedScriptsDir(dataDir), { recursive: true });
      await writeFile(join(managedScriptsDir(dataDir), 'ready@1.sh'), 'exit 0');
      await writeFile(managedInterceptorPath(dataDir), JSON.stringify({ interceptor: { rules: [
        { ...base, kind: 'pattern', id: 'regex', match: 'regex', pattern: 'x', action: 'log' },
        { ...base, kind: 'pattern', id: 'substring', match: 'substring', keywords: ['x'] },
        { ...base, kind: 'script', id: 'ready', shell: 'sh' },
        { ...base, kind: 'script', id: 'pending', shell: 'sh' },
        { ...base, kind: 'script', id: 'foreign', shell: 'powershell' },
        { ...base, kind: 'http', id: 'http', url: 'https://example.com' },
      ] } }));
      controller.reload();
      const expected = { configured: 6, config_valid: true, effective: 3, pattern: 2, regex: 1,
        substring: 1, script: 1, audit: 1, enforce: 2, pending_scripts: 1, unsupported_http: 1 };
      expect(controller.getRuleStatus()).toEqual(expected);
      await writeFile(managedInterceptorPath(dataDir), '{invalid');
      controller.reload();
      expect(controller.getRuleStatus()).toEqual({ ...expected, config_valid: false });
      await rm(managedInterceptorPath(dataDir));
      controller.reload();
      expect(controller.getRuleStatus()).toEqual(EMPTY_RULES);
    } finally {
      controller.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
