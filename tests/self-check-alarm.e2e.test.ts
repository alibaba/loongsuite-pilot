import './_e2e-setup.js';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { AlarmManager } from '../src/metrics/alarm-manager.js';
import { MetricsWriter } from '../src/metrics/metrics-writer.js';
import { SelfCheckService } from '../src/self-check/self-check-service.js';
import type { InputCounter } from '../src/core/input-manager.js';

function counter(lastActiveTime: number): InputCounter {
  return {
    inEvents: 0, inBytes: 0, outEvents: 0, outFailed: 0,
    lastPollTime: '', startTime: '', type: 'hook-jsonl', lastActiveTime,
  };
}

describe('E2E: self-check -> AlarmManager -> pilot-alarms.jsonl', () => {
  it('writes a real structured alarm event with version embedded', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-e2e-'));

    // Real native files that probe + version-resolver will read.
    const ccIndicator = path.join(dataDir, 'claude-history.jsonl');
    const ccVersion = path.join(dataDir, 'claude-version.json');
    const cxIndicator = path.join(dataDir, 'codex-index.jsonl');
    const cxVersion = path.join(dataDir, 'codex-version.json');
    await fs.writeFile(ccIndicator, 'x\n');            // fresh mtime => agent active
    await fs.writeFile(ccVersion, JSON.stringify({ version: '9.9.9-cc' }));
    await fs.writeFile(cxIndicator, 'x\n');
    await fs.writeFile(cxVersion, JSON.stringify({ latest_version: '1.2.3-cx' }));

    const alarmManager = new AlarmManager({
      ip: '10.0.0.9', version: '1.0.0-pilot', userId: '536799',
    });

    const writer = new MetricsWriter({
      dataDir,
      version: '1.0.0-pilot',
      userId: '536799',
      getSnapshot: () => ({}) as any,
      alarmManager,
    });

    // Two input counters: claude never collected (lastActiveTime=0),
    // codex collected 5h ago (idle beyond 4h threshold).
    const counters = new Map<string, InputCounter>();
    counters.set('claude-code-log', counter(0));
    counters.set('codex-transcript', counter(Date.now() - 5 * 3_600_000));

    const svc = new SelfCheckService({
      config: {
        enabled: true,
        intervalMs: 600_000,
        dataGapThresholdMs: 4 * 3_600_000,
        neverCollectedGraceMs: 0,      // fire NEVER_COLLECTED immediately
        cooldownMs: 86_400_000,
      },
      inputManager: {
        getInputCounters: () => counters,
        getInputIdleMinutes: () => 0,
        getActiveInputIds: () => [...counters.keys()],
      } as any,
      alarmManager,
      agentsConfig: {
        'claude-code': { enabled: true, captureMessageContent: false },
        'codex': { enabled: true, captureMessageContent: false },
      },
      definitions: [
        {
          id: 'claude-code', displayName: 'Claude Code', deployMode: 'hook',
          detection: { paths: [], commands: [] },
          activityIndicator: ccIndicator,
          versionSource: { type: 'jsonFile', file: ccVersion, key: 'version' },
        },
        {
          id: 'codex', displayName: 'Codex', deployMode: 'hook',
          detection: { paths: [], commands: [] },
          activityIndicator: cxIndicator,
          versionSource: { type: 'jsonFile', file: cxVersion, key: 'latest_version' },
        },
      ],
      inputToAgentMap: { 'claude-code-log': 'claude-code', 'codex-transcript': 'codex' },
      pilotVersion: '1.0.0-pilot',
    });

    // Real detection cycle -> records alarms into AlarmManager.
    await svc.runCheck();

    // Real serialize + file append (same path MetricsWriter uses on its 30s timer).
    await (writer as any).writeAlarms();

    const alarmFile = path.join(dataDir, 'logs', 'metric_alarm', 'pilot-alarms.jsonl');
    const raw = await fs.readFile(alarmFile, 'utf8');

    const lines: any[] = raw.trimEnd().split('\n').map(l => JSON.parse(l));
    const never = lines.find(l => l.alarm_type === 'SELF_CHECK_NEVER_COLLECTED_ALARM');
    const gap = lines.find(l => l.alarm_type === 'SELF_CHECK_DATA_GAP_ALARM');

    expect(never).toBeTruthy();
    expect(never.input_name).toBe('claude-code');
    expect(never.ver).toBe('1.0.0-pilot');
    expect(never.user_id).toBe('536799');
    expect(never.alarm_message).toContain('agent version: 9.9.9-cc');
    expect(never.alarm_message).toContain('pilot version: 1.0.0-pilot');

    expect(gap).toBeTruthy();
    expect(gap.input_name).toBe('codex');
    expect(gap.alarm_message).toContain('agent version: 1.2.3-cx');
    expect(gap.alarm_message).toContain('idle');

    // No dingtalk/notification artifacts anywhere.
    expect(raw).not.toContain('dingtalk');

    await fs.rm(dataDir, { recursive: true, force: true });
  });
});
