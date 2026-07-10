import { createLogger } from '../utils/logger.js';

const logger = createLogger('AlarmManager');

export type AlarmLevel = '1' | '2' | '3';

export type AlarmType =
  | 'FLUSH_SEND_ALARM'
  | 'FLUSH_QUOTA_ALARM'
  | 'HOOK_INSTALL_ALARM'
  | 'PROCESS_RESOURCE_ALARM'
  | 'DISPATCH_DROP_ALARM'
  | 'INPUT_STOP_ALARM'
  | 'SERVICE_NOT_RUNNING_ALARM'
  | 'UPDATER_FAILURE_ALARM'
  | 'USER_ID_FORMAT_ALARM'
  | 'DEGRADED_STARTUP_ALARM'
  | 'UPDATER_NOT_RUNNING_ALARM'
  | 'BROKEN_VERSION_POINTER_ALARM'
  | 'INVALID_NODE_BIN_ALARM';

export interface AlarmContext {
  input_name?: string;
  endpoint_name?: string;
  mode?: string;
  endpoint_host?: string;
  project?: string;
  logstore?: string;
  failure_class?: string;
  status_code?: string | number;
  retryable?: string | boolean;
  reason?: string;
}

export interface AlarmEntry {
  alarm_type: string;
  alarm_level: string;
  alarm_message: string;
  alarm_count: string;
  user_id: string;
  ip: string;
  ver: string;
  input_name?: string;
  endpoint_name?: string;
  mode?: string;
  endpoint_host?: string;
  project?: string;
  logstore?: string;
  failure_class?: string;
  status_code?: string;
  retryable?: string;
  reason?: string;
  __time__: number;
}

interface AlarmItem {
  alarmType: AlarmType;
  level: AlarmLevel;
  message: string;
  count: number;
  context?: AlarmContext;
}

export class AlarmManager {
  private readonly alarms: Map<string, AlarmItem> = new Map();
  private readonly ip: string;
  private readonly version: string;
  private readonly userId: string;

  constructor(opts: { ip: string; version: string; userId: string }) {
    this.ip = opts.ip;
    this.version = opts.version;
    this.userId = opts.userId;
  }

  record(type: AlarmType, level: AlarmLevel, message: string, context?: AlarmContext): void {
    const key = [
      type,
      context?.input_name ?? '',
      context?.endpoint_name ?? '',
      context?.failure_class ?? '',
      context?.status_code ?? '',
    ].join('_');
    const existing = this.alarms.get(key);
    if (existing) {
      existing.count++;
      existing.message = message;
      existing.context = context;
    } else {
      this.alarms.set(key, { alarmType: type, level, message, count: 1, context });
    }
  }

  serialize(): AlarmEntry[] {
    if (this.alarms.size === 0) return [];

    const now = Math.floor(Date.now() / 1000);
    const entries: AlarmEntry[] = [];

    for (const item of this.alarms.values()) {
      if (item.count === 0) continue;
      const entry: AlarmEntry = {
        alarm_type: item.alarmType,
        alarm_level: item.level,
        alarm_message: item.message,
        alarm_count: String(item.count),
        user_id: this.userId,
        ip: this.ip,
        ver: this.version,
        __time__: now,
      };
      this.copyContext(entry, item.context);
      entries.push(entry);
    }

    this.alarms.clear();
    return entries;
  }

  private copyContext(entry: AlarmEntry, context?: AlarmContext): void {
    if (!context) return;
    const target = entry as unknown as Record<string, string | number>;
    for (const key of [
      'input_name',
      'endpoint_name',
      'mode',
      'endpoint_host',
      'project',
      'logstore',
      'failure_class',
      'status_code',
      'retryable',
      'reason',
    ] as const) {
      const value = context[key];
      if (value !== undefined && value !== '') {
        target[key] = String(value);
      }
    }
  }
}
