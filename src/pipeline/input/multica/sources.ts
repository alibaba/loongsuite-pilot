import { open, stat } from 'node:fs/promises';
import { fetchBounded, SourceError } from './http.js';
import { digest, object, safeScalar, selectFields, snapshot } from './records.js';
import { parseMulticaLog, parsePrometheus } from './parsers.js';
import { entityLabels } from './entity-labels.js';
import type { CollectionResult, MulticaInputConfig, MulticaRecord, SourceCheckpoint } from './types.js';

export interface ApiSource {
  name: string;
  path: string;
  recordType: string;
  workspace: string;
  key?: string;
  pagination?: 'offset' | 'cursor';
  discover?: boolean;
  extra?: MulticaRecord;
  single?: boolean;
}

export async function collectApi(input: MulticaInputConfig, source: ApiSource): Promise<CollectionResult> {
  const records: MulticaRecord[] = [];
  const entityIds: string[] = [];
  const pageSize = 100;
  let cursor = '';
  let truncated = false;
  for (let page = 0; page < (input.MaxPages ?? 10); page++) {
    const url = new URL(`${input.ApiBase!.replace(/\/$/, '')}${source.path}`);
    if (source.pagination) {
      url.searchParams.set('limit', String(pageSize));
      if (source.pagination === 'offset') url.searchParams.set('offset', String(page * pageSize));
      if (cursor) url.searchParams.set('before', cursor);
    }
    const response = await fetchBounded(url.toString(), input, source.workspace);
    let body: unknown;
    try { body = JSON.parse(response.text); } catch { throw new SourceError('invalid_json'); }
    const rows = source.single ? [body] : source.key ? object(body)[source.key] : body;
    if (!Array.isArray(rows)) throw new SourceError('unexpected_response_shape');
    for (const item of rows) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SourceError('unexpected_row_shape');
      const row = snapshot(source.recordType, item, {workspace_id: source.workspace, ...source.extra});
      if (input.CollectEntityNames) Object.assign(row, entityLabels(source.recordType, item));
      if (source.recordType === 'usage_snapshot') {
        // Values change between polls; identity is the aggregate's dimensions.
        row.entity_id = digest(JSON.stringify([source.name, row.agent_id, row.runtime_id, row.day, row.bucket_at, row.hour, row.provider, row.model, row.failure_reason]));
      }
      records.push(row);
      if (source.discover && typeof object(item).id === 'string') entityIds.push(String(object(item).id));
    }
    const previous = cursor;
    cursor = response.headers.get('X-Agent-Tasks-Next-Cursor') ?? '';
    const total = Number(object(body).total);
    const more = source.pagination === 'cursor' ? Boolean(cursor)
      : source.pagination === 'offset' && rows.length === pageSize && (!Number.isFinite(total) || total <= rows.length || records.length < total);
    truncated = Boolean(more);
    if (!more) break;
    if (cursor && cursor === previous) throw new SourceError('repeated_pagination_cursor');
  }
  return {records, truncated, checkpoint: source.discover ? {entityIds} : undefined};
}

export async function collectMetrics(input: MulticaInputConfig, url: string): Promise<CollectionResult> {
  const {text} = await fetchBounded(url, input);
  const records = parsePrometheus(text);
  if (!records.length) throw new SourceError('no_supported_metrics');
  return {records};
}

export async function collectDaemonHealth(input: MulticaInputConfig, url: string): Promise<CollectionResult> {
  const {text} = await fetchBounded(url, input);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new SourceError('invalid_json'); }
  const row = object(body);
  if (typeof row.status !== 'string') throw new SourceError('unexpected_response_shape');
  return {records: [{record_type: 'daemon_health', source_type: 'daemon_health', ...selectFields(row),
    entity_id: safeScalar(row.daemon_id) || url, skipped_agent_count: String(Object.keys(object(row.skipped_agents)).length),
    discovered_agent_count: String(Array.isArray(row.agents) ? row.agents.length : 0)}]};
}

export async function collectFileStat(file: string): Promise<CollectionResult> {
  try {
    const info = await stat(file);
    return {records: [{record_type: 'file_stat', source_type: 'file_stat', entity_id: file,
      file_path: file, exists: 'true', size_bytes: String(info.size), mtime_ms: String(info.mtimeMs),
      inode: String(info.ino), is_regular_file: String(info.isFile())}]};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {records: [{record_type: 'file_stat', source_type: 'file_stat', entity_id: file, file_path: file, exists: 'false'}]};
  }
}

/** Only explicitly configured regular files are read, in bounded byte slices. */
export async function collectLog(input: MulticaInputConfig, file: string, checkpoint: SourceCheckpoint): Promise<CollectionResult> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new SourceError('not_regular_file');
    const prefix = Buffer.alloc(Math.min(checkpoint.signatureSize || 128, info.size));
    await handle.read(prefix, 0, prefix.length, 0);
    const signature = digest(prefix.toString('base64'));
    const rotated = checkpoint.inode !== undefined && (checkpoint.inode !== info.ino || checkpoint.dev !== info.dev
      || info.size < (checkpoint.offset ?? 0) || (checkpoint.signatureSize === prefix.length && checkpoint.signature !== signature));
    const offset = rotated ? 0 : checkpoint.offset ?? 0;
    let discardPartial = rotated ? false : checkpoint.discardPartial ?? false;
    const buffer = Buffer.alloc(Math.min(input.MaxLogBytes ?? 1024 * 1024, Math.max(0, info.size - offset)));
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, offset);
    const content = buffer.subarray(0, bytesRead);
    const records: MulticaRecord[] = [];
    const maxLine = input.MaxLineBytes ?? 16384;
    let begin = 0;
    let skipped = 0;
    for (let end = content.indexOf(10); end >= 0; end = content.indexOf(10, begin)) {
      if (!discardPartial && end - begin <= maxLine) {
        const line = content.subarray(begin, end).toString('utf8');
        const row = parseMulticaLog(line);
        if (row) {
          row.file_path = file;
          row.entity_id = `${info.dev}:${info.ino}:${offset + begin}`;
          row.log_identity = `${row.entity_id}:${digest(line)}`;
          records.push(row);
        }
      } else skipped++;
      discardPartial = false;
      begin = end + 1;
    }
    if (content.length - begin > maxLine || discardPartial) {
      begin = content.length;
      discardPartial = true;
      skipped++;
    }
    if (skipped || rotated) records.push({record_type: 'collection_status', source_type: 'collector',
      success: 'true', error_kind: rotated ? 'log_rotation_detected' : 'oversized_log_line_skipped',
      skipped_line_count: String(skipped), file_path: file, entity_id: file});
    return {records, truncated: offset + begin < info.size, checkpoint: {offset: offset + begin,
      inode: info.ino, dev: info.dev, signature, signatureSize: prefix.length, discardPartial}};
  } finally { await handle.close(); }
}
