import * as os from 'node:os';
import { formatTime } from '../utils/time-utils.js';
import { resolveLocalIp } from '../utils/network-utils.js';

export interface RuntimeIdentity {
  version: string;
  userId: string;
  hostname: string;
  localIp: string;
  instanceId: string;
  runId: string;
  startTime: string;
  startTimestamp: number;
}

export function createRuntimeIdentity(opts: {
  version: string;
  userId: string;
  dataDir: string;
  now?: Date;
}): RuntimeIdentity {
  const now = opts.now ?? new Date();
  const startTimestamp = Math.floor(now.getTime() / 1000);
  const hostname = os.hostname();
  const dataDirEncoded = Buffer.from(opts.dataDir, 'utf8').toString('base64url');
  const instanceId = `${hostname}_${opts.userId}_${dataDirEncoded}`;
  return {
    version: opts.version,
    userId: opts.userId,
    hostname,
    localIp: resolveLocalIp(),
    instanceId,
    runId: `${instanceId}_${startTimestamp}`,
    startTime: formatTime(now),
    startTimestamp,
  };
}
