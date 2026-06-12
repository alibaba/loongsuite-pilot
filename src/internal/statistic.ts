import { buildWebTrackingUrl, postWebTracking } from './webtracking-post.js';

const ENDPOINT = 'https://cn-shanghai.log.aliyuncs.com';
const PROJECT  = 'loongsuite-community-edition';
const LOGSTORE = 'loongsuite-online';

const STATUS_URL = buildWebTrackingUrl(ENDPOINT, PROJECT, LOGSTORE);

// L1 is collected every 10 minutes; send once per 12 hours → 72 intervals.
const SEND_INTERVAL_COUNT = 72;

const SELECTED_FIELDS = new Set([
  'cpu',
  'mem',
  'version',
  'instance_id',
  'os',
  'os_detail',
  'metric_json',
  'agent_versions',
]);

let callCount = 0;

export function sendRunningStatus(data: Record<string, unknown>): void {
  if (callCount++ % SEND_INTERVAL_COUNT !== 0) return;

  const status: Record<string, unknown> = {};
  for (const key of SELECTED_FIELDS) {
    if (key in data) {
      status[key] = data[key];
    }
  }

  void postWebTracking(STATUS_URL, {
    __topic__: 'pilot_running_status',
    __logs__: [status],
  }, 'running-status');
}
