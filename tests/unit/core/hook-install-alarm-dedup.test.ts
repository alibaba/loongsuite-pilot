import { describe, expect, it } from 'vitest';
import {
  hookInstallAlarmKey,
  shouldRelayHookInstallAlarm,
  type HookInstallAlarmReport,
} from '../../../src/deployment/hook-install-alarm.js';

function report(overrides: Partial<HookInstallAlarmReport> = {}): HookInstallAlarmReport {
  return {
    identity: 'a'.repeat(64),
    ts: '2026-10-16T00:00:00.000Z',
    alarmSent: false,
    agents: [{ id: 'grok-build', status: 'failed', reason: 'deploy-failed' }],
    ...overrides,
  };
}

describe('hook install alarm dedup', () => {
  it('relays one alarm per identity and timestamp', () => {
    const sent = new Set<string>();
    const first = report();
    expect(shouldRelayHookInstallAlarm(first, sent)).toBe(true);
    sent.add(hookInstallAlarmKey(first));
    expect(shouldRelayHookInstallAlarm(first, sent)).toBe(false);
    expect(shouldRelayHookInstallAlarm(report({ alarmSent: true }), new Set())).toBe(false);
    expect(shouldRelayHookInstallAlarm(report({
      agents: [{ id: 'grok-build', status: 'ok' }],
    }), new Set())).toBe(false);
    expect(shouldRelayHookInstallAlarm(report({ ts: '2026-10-16T00:00:01.000Z' }), sent)).toBe(true);
  });
});