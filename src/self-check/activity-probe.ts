import * as fs from 'node:fs/promises';
import { resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ActivityProbe');

export interface ActivityProbeResult {
  active: boolean;
  mtimeMs: number;
}

export async function probeActivity(
  indicatorPath: string,
  thresholdMs: number,
): Promise<ActivityProbeResult> {
  try {
    const resolved = indicatorPath.startsWith('~')
      ? resolveHome(indicatorPath)
      : indicatorPath;
    const stat = await fs.stat(resolved);
    const ageMs = Date.now() - stat.mtimeMs;
    return { active: ageMs <= thresholdMs, mtimeMs: stat.mtimeMs };
  } catch {
    logger.debug('activity indicator not accessible', { path: indicatorPath });
    return { active: false, mtimeMs: 0 };
  }
}
