import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { queryReadonly } from '../../utils/node-sqlite.js';
import { resolveAllQoderDbPaths } from './sqlite-token-reader.js';
import { resolveQoderCnDbPaths } from '../qoder-cn-trace/sqlite-token-reader.js';

export interface QoderOwnershipCursor { at: number; requestId: string; inventoryId: string }
export interface QoderPromptOwnership {
  inventoryId: string;
  rows: Array<{ requestId: string; at: number }>;
  complete: boolean;
  reset?: boolean;
}

/** Hook request_set_id is the DB request_id, not the transcript UUID.
 * Stream the ordered user inventory in bounded metadata-only pages. Never
 * decrypt/read conversation content or cap the number of supported Turns.
 */
export async function readQoderPromptOwnership(
  agentId: 'qoder' | 'qoder-cn', sessionId: string, requestId: string, cursor?: QoderOwnershipCursor,
): Promise<QoderPromptOwnership | null> {
  const paths = agentId === 'qoder' ? resolveAllQoderDbPaths() : resolveQoderCnDbPaths();
  for (const file of paths.slice(0, 4)) {
    try {
      const target = await queryReadonly<{ request_id: string; gmt_create: number }>(file,
        "SELECT request_id,gmt_create FROM chat_message WHERE session_id=? AND request_id=? AND role='user' LIMIT 2",
        [sessionId, requestId]);
      if (!target.length) continue;
      if (target.length !== 1) return null;
      const stat = statSync(file);
      const inventoryId = createHash('sha256').update(JSON.stringify([file, stat.dev, stat.ino])).digest('hex');
      if (cursor) {
        const anchor = await queryReadonly<{ gmt_create: number | string }>(file,
          "SELECT gmt_create FROM chat_message WHERE session_id=? AND request_id=? AND role='user' LIMIT 2",
          [sessionId, cursor.requestId]);
        if (cursor.inventoryId !== inventoryId || anchor.length !== 1 || Number(anchor[0]!.gmt_create) !== cursor.at) {
          return { inventoryId, rows: [], complete: false, reset: true };
        }
      }
      const rows = await queryReadonly<{ request_id: string; gmt_create: number | string }>(file,
        `SELECT request_id,gmt_create FROM chat_message WHERE session_id=? AND role='user'
          AND (?=0 OR gmt_create>? OR (gmt_create=? AND request_id>?))
          ORDER BY gmt_create,request_id LIMIT 257`,
        [sessionId, cursor ? 1 : 0, cursor?.at ?? 0, cursor?.at ?? 0, cursor?.requestId ?? '']);
      const page = rows.slice(0, 256).map(row => ({ requestId: row.request_id, at: Number(row.gmt_create) }));
      if (page.some((row, i) => typeof row.requestId !== 'string' || !row.requestId || row.requestId.length > 512
        || !Number.isFinite(row.at) || row.at <= (i > 0 ? page[i - 1]!.at : cursor?.at ?? 0))) return null;
      return { inventoryId, rows: page, complete: rows.length <= 256 };
    } catch { /* A missing/locked DB cannot establish ownership. Retry later. */ }
  }
  return null;
}
