import { buildWebTrackingUrl, postWebTracking } from './webtracking-post.js';

const ALARM_ENDPOINT  = 'https://cn-shanghai.log.aliyuncs.com';
const ALARM_PROJECT   = 'loongsuite-community-edition-cn-shanghai';
const ALARM_LOGSTORE  = 'loongsuite_alarm';

const STATUS_ENDPOINT = 'https://cn-shanghai.log.aliyuncs.com';
const STATUS_PROJECT  = 'loongsuite-community-edition-cn-shanghai';
const STATUS_LOGSTORE = 'loongsuite_status';

const ALARM_URL  = buildWebTrackingUrl(ALARM_ENDPOINT, ALARM_PROJECT, ALARM_LOGSTORE);
const STATUS_URL = buildWebTrackingUrl(STATUS_ENDPOINT, STATUS_PROJECT, STATUS_LOGSTORE);

export function sendAlarm(data: Record<string, unknown>): void {
  void postWebTracking(ALARM_URL, { __logs__: [data] }, 'alarm');
}

export function sendStatus(data: Record<string, unknown>): void {
  void postWebTracking(STATUS_URL, { __logs__: [data] }, 'status');
}
