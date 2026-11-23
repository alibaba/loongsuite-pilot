import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveHome } from '../utils/fs-utils.js';

/** Native usage evidence only. Do not read record contents to detect activity. */
export async function readActivityTime(indicator: string): Promise<number | undefined> {
  if (typeof indicator !== 'string' || !indicator) return undefined;
  const file = resolveHome(indicator);
  if (!path.isAbsolute(file)) return undefined;
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}
