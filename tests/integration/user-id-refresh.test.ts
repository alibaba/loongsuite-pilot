import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createUserIdProvider, USER_ID_REFRESH_INTERVAL_MS } from '../../src/core/config-loader.js';
import { InputManager } from '../../src/core/input-manager.js';
import { AlarmManager } from '../../src/metrics/alarm-manager.js';
import { MetricsCollector, type DataflowSnapshot } from '../../src/metrics/metrics-collector.js';
import { INVOCATION_USER_ID_FIELD } from '../../src/normalization/invocation-identity.js';
import { buildTestEntry } from '../helpers/fixture-builder.js';
import { MockFlusher } from '../helpers/mock-flusher.js';

it('refreshes the configured identity across collection, metrics and alarms while preserving event overrides', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pilot-user-id-refresh-'));
  const configPath = path.join(dataDir, 'config.json');
  vi.stubEnv('LOONGSUITE_PILOT_USER_ID', '');
  try {
    await writeFile(configPath, '{"userId":"original"}');
    let now = 0;
    const userId = 'startup-snapshot';
    const userIdProvider = createUserIdProvider({ initialUserId: userId, configPath, now: () => now });
    const version = 'test';
    const collector = new MetricsCollector({ dataDir, version, userId, userIdProvider, autoUpdateEnabled: false });
    const alarms = new AlarmManager({ ip: '127.0.0.1', version, userId, userIdProvider });
    const manager = new InputManager();
    const flusher = new MockFlusher();
    manager.setFlusher(flusher);
    manager.setUserIdProvider(userIdProvider);
    const snapshot: DataflowSnapshot = {
      inEventsTotal: 0,
      inBytesTotal: 0,
      inputs: new Map(),
      flushers: new Map(),
      inputIdleMinutes: new Map(),
    };
    const startup = collector.collectL1(snapshot);
    expect(startup.user_id).toBe('original');
    expect(startup.instance_id).toContain('_startup-snapshot_');
    await manager.flushPreparedEntries([buildTestEntry()]);
    expect(flusher.batchCalls.at(-1)?.[0]['user.id']).toBe('original');
    alarms.record('HOOK_INSTALL_ALARM', '2', 'initial failure', { input_name: 'cursor' }, 2);
    alarms.record('HOOK_INSTALL_ALARM', '2', 'still failing', { input_name: 'cursor' });

    await writeFile(configPath, '{"userId":"corrected"}');
    now = USER_ID_REFRESH_INTERVAL_MS;
    const refreshed = collector.collectL1(snapshot);
    expect(refreshed).toMatchObject({
      user_id: 'corrected',
      instance_id: startup.instance_id,
      run_id: startup.run_id,
    });
    const l2 = collector.collectL2(snapshot, [{
      agent: 'cursor', hookEvent: 'stop', calls: 1, totalDurationMs: 2, maxDurationMs: 2,
    }]);
    expect(l2?.hooks).toMatchObject([{ user_id: 'corrected', instance_id: startup.instance_id }]);
    alarms.record('HOOK_INSTALL_ALARM', '2', 'failure after refresh', { input_name: 'cursor' });
    expect(alarms.serialize()).toMatchObject([
      { user_id: 'original', alarm_count: '3', alarm_message: 'still failing' },
      { user_id: 'corrected', alarm_count: '1', alarm_message: 'failure after refresh' },
    ]);

    await manager.flushPreparedEntries([
      buildTestEntry(),
      { ...buildTestEntry(), [INVOCATION_USER_ID_FIELD]: 'invocation-user' },
    ]);
    expect(flusher.batchCalls.at(-1)?.map(entry => entry['user.id'])).toEqual(['corrected', 'invocation-user']);
    expect(manager.prepareRestoredEntries([buildTestEntry({ 'user.id': 'original' })])[0]['user.id']).toBe('original');
  } finally {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  }
});
