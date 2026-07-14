import { describe, it, expect, beforeEach } from 'vitest';
import { AlarmManager } from '../../../src/metrics/alarm-manager.js';

describe('AlarmManager', () => {
  let manager: AlarmManager;

  beforeEach(() => {
    manager = new AlarmManager({ ip: '10.0.0.1', version: '1.0.0', userId: 'test-user' });
  });

  it('serialize returns empty when no alarms recorded', () => {
    expect(manager.serialize()).toEqual([]);
  });

  it('records and serializes a single alarm', () => {
    manager.record('FLUSH_SEND_ALARM', '2', 'send failed');
    const entries = manager.serialize();

    expect(entries).toHaveLength(1);
    expect(entries[0].alarm_type).toBe('FLUSH_SEND_ALARM');
    expect(entries[0].alarm_level).toBe('2');
    expect(entries[0].alarm_message).toBe('send failed');
    expect(entries[0].alarm_count).toBe('1');
    expect(entries[0].user_id).toBe('test-user');
    expect(entries[0].ip).toBe('10.0.0.1');
    expect(entries[0].ver).toBe('1.0.0');
    expect(entries[0].__time__).toBeGreaterThan(0);
  });

  it('aggregates count for same alarm type and context', () => {
    manager.record('INPUT_STOP_ALARM', '3', 'timeout', { input_name: 'cursor-hook' });
    manager.record('INPUT_STOP_ALARM', '3', 'timeout 2', { input_name: 'cursor-hook' });
    manager.record('INPUT_STOP_ALARM', '3', 'timeout 3', { input_name: 'cursor-hook' });

    const entries = manager.serialize();
    expect(entries).toHaveLength(1);
    expect(entries[0].alarm_count).toBe('3');
    expect(entries[0].alarm_message).toBe('timeout 3');
    expect(entries[0].input_name).toBe('cursor-hook');
  });

  it('distinguishes alarms by context', () => {
    manager.record('FLUSH_SEND_ALARM', '2', 'fail A', { endpoint_name: 'ep1' });
    manager.record('FLUSH_SEND_ALARM', '2', 'fail B', { endpoint_name: 'ep2' });

    const entries = manager.serialize();
    expect(entries).toHaveLength(2);
    expect(entries[0].endpoint_name).toBe('ep1');
    expect(entries[1].endpoint_name).toBe('ep2');
  });

  it('splits SLS send alarms by failure class and status code', () => {
    manager.record('FLUSH_SEND_ALARM', '2', 'forbidden', {
      endpoint_name: 'ep1',
      failure_class: 'permission_denied',
      status_code: 403,
      endpoint_host: 'cn-hangzhou.log.aliyuncs.com',
      mode: 'ak',
      project: 'project-a',
      logstore: 'store-a',
      retryable: false,
      reason: 'HTTP 403',
    });
    manager.record('FLUSH_SEND_ALARM', '2', 'server error', {
      endpoint_name: 'ep1',
      failure_class: 'server_error',
      status_code: 500,
      endpoint_host: 'cn-hangzhou.log.aliyuncs.com',
      mode: 'ak',
      project: 'project-a',
      logstore: 'store-a',
      retryable: true,
      reason: 'HTTP 500',
    });

    const entries = manager.serialize();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.failure_class).sort()).toEqual(['permission_denied', 'server_error']);
    expect(entries.map(e => e.status_code).sort()).toEqual(['403', '500']);
    expect(entries[0].endpoint_host).toBe('cn-hangzhou.log.aliyuncs.com');
    expect(entries[0].retryable).toMatch(/^(true|false)$/);
  });

  it('keeps legacy aggregation when diagnostic fields are absent', () => {
    manager.record('FLUSH_SEND_ALARM', '2', 'fail 1', { endpoint_name: 'ep1' });
    manager.record('FLUSH_SEND_ALARM', '2', 'fail 2', { endpoint_name: 'ep1' });

    const entries = manager.serialize();
    expect(entries).toHaveLength(1);
    expect(entries[0].alarm_count).toBe('2');
    expect(entries[0].alarm_message).toBe('fail 2');
  });

  it('clears alarms after serialize', () => {
    manager.record('HOOK_INSTALL_ALARM', '2', 'install failed');
    manager.serialize();
    expect(manager.serialize()).toEqual([]);
  });
});
