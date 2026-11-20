import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AlarmManager } from '../../../src/metrics/alarm-manager.js';
import { MetricsWriter } from '../../../src/metrics/metrics-writer.js';
import { SelfCheckService, type SelfCheckInput } from '../../../src/self-check/self-check-service.js';
import * as versions from '../../../src/self-check/version-resolver.js';
import type { AgentDefinition } from '../../../src/types/deployment.js';
import { getTodayDateString } from '../../../src/utils/fs-utils.js';

describe('collection self-check', () => {
  let root: string;
  let clock: number;
  let alarms: AlarmManager;
  let inputs: SelfCheckInput[];
  let definitions: AgentDefinition[];
  let service: SelfCheckService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-self-check-'));
    clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    alarms = new AlarmManager({ userId: 'test', ip: '127.0.0.1', version: '1.2.3' });
    inputs = [{ id: 'codex-transcript', agentId: 'codex', lastActiveTime: 0 }];
    definitions = [{
      id: 'codex', displayName: 'Codex', deployMode: 'hook', detection: { paths: [], commands: [] },
      activityIndicator: path.join(root, 'native.jsonl'),
      versionSource: { type: 'jsonFile', file: path.join(root, 'version.json'), key: 'version' },
    }];
    await fs.writeFile(path.join(root, 'version.json'), '{"version":"2.7.1"}');
    service = new SelfCheckService({
      config: { enabled: true, intervalMs: 1000, dataGapThresholdMs: 1000, neverCollectedGraceMs: 1000, cooldownMs: 4000 },
      alarmManager: alarms, getEligibleInputs: () => inputs, getDefinitions: () => definitions, pilotVersion: '1.2.3',
    });
  });

  afterEach(async () => {
    service.stop();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function nativeActivity(ms = clock - 10): Promise<void> {
    const file = definitions[0].activityIndicator!;
    await fs.writeFile(file, 'synthetic native activity');
    await fs.utimes(file, new Date(ms), new Date(ms));
  }

  it('emits both gap kinds through the dated alarm pipeline and applies per-kind cooldown', async () => {
    await service.runCheck();
    clock += 1100;
    await nativeActivity();
    await service.runCheck();
    await service.runCheck();

    inputs[0].lastActiveTime = clock;
    clock += 1100;
    await nativeActivity();
    await service.runCheck();
    const writer = new MetricsWriter({
      dataDir: root, version: '1.2.3', userId: 'test', alarmManager: alarms,
      getSnapshot: () => ({ inEventsTotal: 0, inBytesTotal: 0, inputs: new Map(), flushers: new Map(), inputIdleMinutes: new Map() }),
    });
    // The normal stop path flushes the same staged alarms the periodic writer uses.
    await writer.start();
    await writer.stop();
    const text = await fs.readFile(path.join(root, 'logs', 'metric_alarm', `pilot-alarms-${getTodayDateString()}.jsonl`), 'utf8');
    const rows = text.trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.alarm_type.startsWith('SELF_CHECK_'));
    expect(rows).toMatchObject([
      { alarm_type: 'SELF_CHECK_NEVER_COLLECTED_ALARM', input_name: 'codex', alarm_count: '1' },
      { alarm_type: 'SELF_CHECK_DATA_GAP_ALARM', input_name: 'codex', alarm_count: '1' },
    ]);
    for (const row of rows) expect(row.alarm_message).toContain('agent version: 2.7.1, pilot version: 1.2.3');
  });

  it('restores grace after runtime disable and requires activity after the new eligibility window', async () => {
    await service.runCheck();
    clock += 2000;
    const suspended = inputs.pop()!;
    await nativeActivity();
    await service.runCheck();
    expect(alarms.serialize()).toEqual([]);

    inputs.push(suspended);
    await service.runCheck();
    clock += 1001;
    await service.runCheck();
    expect(alarms.serialize()).toEqual([]);
    await nativeActivity();
    await service.runCheck();
    expect(alarms.serialize()).toHaveLength(1);
  });

  it('uses current definitions and suppresses the alert when another running input collected', async () => {
    const available = definitions.pop()!;
    await service.runCheck();
    definitions.push(available);
    await service.runCheck();
    clock += 1100;
    await nativeActivity();
    inputs.push({ id: 'codex-aux', agentId: 'codex', lastActiveTime: clock });
    await service.runCheck();
    expect(alarms.serialize()).toEqual([]);
    clock += 1100;
    await nativeActivity();
    await service.runCheck();
    expect(alarms.serialize()[0]?.alarm_type).toBe('SELF_CHECK_DATA_GAP_ALARM');
  });

  it.each(['disable', 'recover', 'stop'])('coalesces cycles and suppresses late alarms after %s', async change => {
    await service.runCheck();
    clock += 1100;
    await nativeActivity();
    let finish: (value: string) => void = () => {};
    const resolver = vi.spyOn(versions, 'resolveAgentVersion').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const running = service.runCheck();
    expect(service.runCheck()).toBe(running);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
    if (change === 'disable') inputs.length = 0;
    if (change === 'recover') inputs[0].lastActiveTime = clock;
    if (change === 'stop') service.stop();
    finish('1.0.0');
    await running;
    expect(alarms.serialize()).toEqual([]);
  });

  it('reads a bounded version tail and treats incomplete and non-version strings as unknown', async () => {
    const file = path.join(root, 'version-tail.jsonl');
    await fs.writeFile(file, `${' '.repeat(156_000)}\n{"version":"4.3.2"}\n{"version":`);
    const signal = new AbortController().signal;
    expect(await versions.resolveAgentVersion({ type: 'jsonlTail', file, key: 'version' }, signal)).toBe('4.3.2');
    await fs.writeFile(file, '{"version":"unrelated content"}');
    expect(await versions.resolveAgentVersion({ type: 'jsonFile', file, key: 'version' }, signal)).toBe('unknown');
    expect(await versions.resolveAgentVersion({ type: 'command', command: 'other-command --version' }, signal)).toBe('unknown');
  });

  it.each([
    { prefix: '{}\n', expected: '4.3.2' },
    { prefix: 'partial ', expected: 'unknown' },
  ])('returns $expected for a version at the tail boundary after $prefix', async ({ prefix, expected }) => {
    const file = path.join(root, 'version-tail-boundary.jsonl');
    const versionLine = '{"version":"4.3.2"}\n';
    const incompleteLine = '{"message":"'.padEnd(32 * 1024 - versionLine.length, 'x');
    await fs.writeFile(file, `${prefix}${versionLine}${incompleteLine}`);
    const signal = new AbortController().signal;

    expect(await versions.resolveAgentVersion({ type: 'jsonlTail', file, key: 'version' }, signal)).toBe(expected);
  });
});
