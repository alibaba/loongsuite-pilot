import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import type { InputState } from '../../types/index.js';

export const historyFileIdentity = (stat: Stats): string => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

/** Publish ACKs only for the observed file generation; never infer unread files from age. */
export function historyRetentionExtra(state: InputState, dir: string, prefix: string,
  file: string, stat: Stats, offset: number, blocked = false): InputState['extra'] | null {
  const extra = state.extra ?? {};
  const offsets = extra.hookLogOffsets as Record<string, number> | undefined;
  const identities = extra.hookLogIdentities as Record<string, string> | undefined;
  const blocks = extra.hookLogRetentionBlocked as Record<string, boolean> | undefined;
  const identity = historyFileIdentity(stat);
  const retain = blocked || (identities?.[file] === identity && blocks?.[file] === true);
  if (extra.hookLogDir === path.resolve(dir) && extra.hookLogPrefix === prefix
    && offsets?.[file] === offset && identities?.[file] === identity
    && (blocks?.[file] === true) === retain) return null;
  return { ...extra, hookLogDir: path.resolve(dir), hookLogPrefix: prefix,
    hookLogOffsets: { ...offsets, [file]: offset },
    hookLogIdentities: { ...identities, [file]: identity },
    hookLogRetentionBlocked: { ...blocks, [file]: retain } };
}

/** Upgrade the one legacy checkpoint, including when today's file does not exist. */
export async function migrateHistoryRetention(state: InputState, dir: string, prefix: string): Promise<InputState['extra'] | null> {
  const file = state.lastFile;
  if (!file || !file.startsWith(prefix + '-') || path.basename(file) !== file
    || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file.slice(prefix.length + 1))
    || !Number.isFinite(state.lastOffset) || (state.lastOffset ?? -1) < 0) return null;
  const extra = state.extra ?? {};
  const identities = extra.hookLogIdentities as Record<string, string> | undefined;
  if (extra.hookLogDir === path.resolve(dir) && extra.hookLogPrefix === prefix && identities?.[file]) return null;
  try {
    const stat = await fs.lstat(path.join(dir, file));
    if (!stat.isFile()) return null;
    const offset = state.lastOffset! <= stat.size && (extra.hookInode === undefined || extra.hookInode === stat.ino)
      ? state.lastOffset! : 0;
    const quarantined = Array.isArray(extra.qoderLegacyQuarantine)
      && extra.qoderLegacyQuarantine.some(record => record?.file === file);
    return historyRetentionExtra(state, dir, prefix, file, stat, offset,
      quarantined || extra.hookSkippingLine === true);
  } catch { return null; }
}
