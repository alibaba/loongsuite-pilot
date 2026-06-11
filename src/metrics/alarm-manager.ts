import { createLogger } from '../utils/logger.js';

const logger = createLogger('AlarmManager');

export type AlarmLevel = '2' | '3';

export type AlarmType =
  | 'FLUSH_SEND_ALARM'
  | 'FLUSH_QUOTA_ALARM'
  | 'HOOK_INSTALL_ALARM'
  | 'PROCESS_RESOURCE_ALARM'
  | 'DISPATCH_DROP_ALARM'
  | 'INPUT_STOP_ALARM'
  | 'SERVICE_NOT_RUNNING_ALARM'
  | 'UPDATER_FAILURE_ALARM';

export interface AlarmContext {
  input_name?: string;
  endpoint_name?: string;
}

export interface AlarmEntry {
  alarm_type: string;
  alarm_level: string;
  alarm_message: string;
  alarm_count: string;
  ip: string;
  ver: string;
  input_name?: string;
  endpoint_name?: string;
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

  constructor(opts: { ip: string; version: string }) {
    this.ip = opts.ip;
    this.version = opts.version;
  }

  record(type: AlarmType, level: AlarmLevel, message: string, context?: AlarmContext): void {
    const key = `${type}_${context?.input_name ?? ''}_${context?.endpoint_name ?? ''}`;
    const existing = this.alarms.get(key);
    if (existing) {
      existing.count++;
      existing.message = message;
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
        ip: this.ip,
        ver: this.version,
        __time__: now,
      };
      if (item.context?.input_name) entry.input_name = item.context.input_name;
      if (item.context?.endpoint_name) entry.endpoint_name = item.context.endpoint_name;
      entries.push(entry);
    }

    this.alarms.clear();
    return entries;
  }
}
