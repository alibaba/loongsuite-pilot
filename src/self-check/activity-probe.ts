import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentActivityIndicator } from '../types/deployment.js';
import { resolveHome } from '../utils/fs-utils.js';
import { queryReadonly } from '../utils/node-sqlite.js';

/** Native usage evidence from file metadata, without reading conversation contents. */
export async function readActivityTime(indicator: AgentActivityIndicator): Promise<number | undefined> {
  if (typeof indicator === 'string') return indicator ? fileMtime(resolveHome(indicator)) : undefined;
  if (indicator?.type === 'codexRollouts' && typeof indicator.home === 'string') {
    const home = resolveHome(indicator.home);
    if (path.isAbsolute(home)) return readCodexActivityTime(home);
  }
  return undefined;
}

async function fileMtime(file: string): Promise<number | undefined> {
  if (!path.isAbsolute(file)) return undefined;
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

async function readCodexActivityTime(home: string): Promise<number | undefined> {
  const legacyActivity = await fileMtime(path.join(home, 'session_index.jsonl'));
  const sessions = path.join(home, 'sessions');
  try {
    const sessionRoot = await fs.realpath(sessions);
    // Codex indexes threads by updated_at. A bounded read also finds resumed
    // sessions whose rollout lives in a much older date directory.
    const rows = await queryReadonly<{ rollout_path: unknown }>(
      path.join(home, 'state_5.sqlite'),
      'SELECT rollout_path FROM threads ORDER BY updated_at DESC LIMIT 64',
      [],
    );
    let latest = legacyActivity;
    for (const { rollout_path: file } of rows) {
      if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
      const relative = path.relative(sessions, file);
      if (!/^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(relative.split(path.sep).join('/'))) continue;
      const canonical = await fs.realpath(file).catch(() => undefined);
      if (canonical !== path.join(sessionRoot, relative)) continue;
      const mtime = await fileMtime(canonical);
      if (mtime !== undefined && (latest === undefined || mtime > latest)) latest = mtime;
    }
    return latest;
  } catch {
    // Older Codex installations may only have the JSONL index.
    return legacyActivity;
  }
}
