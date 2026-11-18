import { classifyFailure, digest, object, safeScalar, selectFields } from './records.js';
import { isIP } from 'node:net';
import type { MulticaRecord } from './types.js';
import { logDiagnostics } from './log-diagnostics.js';

const METRIC_LABELS = new Set('method route status terminal_status provider model model_alias outcome reason failure_reason claim_path phase result source kind type le quantile code handler runtime_mode operation op stage component decision action feature token_type direction stream transport signup_source platform path cadence trigger_kind recoverable gate event_kind'.split(' '));

export function parsePrometheus(text: string): MulticaRecord[] {
  const records: MulticaRecord[] = [];
  for (const line of text.split('\n')) {
    const match = /^((?:multica_|go_|process_)[a-zA-Z0-9_:]+)(?:\{(.*)\})?\s+([+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?)(?:\s+\d+)?\s*$/.exec(line);
    if (!match || !Number.isFinite(Number(match[3]))) continue;
    const labels: MulticaRecord = {};
    for (const label of (match[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g)) {
      if (!METRIC_LABELS.has(label[1])) continue;
      const value = label[2].replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
      // Strip user query content before serializing labels; hash the raw series below.
      labels[label[1]] = safeScalar(label[1] === 'path' ? value.split('?')[0] : value)!;
    }
    const row: MulticaRecord = {record_type: 'prometheus_sample', source_type: 'prometheus', metric_name: match[1], metric_value: match[3], metric_labels: JSON.stringify(labels)};
    for (const key of ['method', 'route', 'provider', 'model', 'outcome', 'reason', 'failure_reason', 'runtime_mode', 'source', 'claim_path', 'le', 'token_type', 'decision', 'action', 'terminal_status', 'cadence', 'trigger_kind']) if (labels[key] !== undefined) row[key] = labels[key];
    if (labels.status !== undefined) row.http_status = labels.status;
    // Unknown labels remain private, but must not collapse distinct series.
    row.entity_id = `${match[1]}:${digest(match[2] ?? '')}`;
    records.push(row);
  }
  return records;
}

const MESSAGES = [
  'http request', 'comment created', 'task claim decision', 'task phase recorded',
  'agent stream protocol summary', 'auth token renewed', 'auth token rejected by server',
  'task completed', 'task failed', 'task dispatched', 'task started',
  'terminal report', 'autopilot', 'wakeup',
  'slow global event handler', 'slow event publish',
];

export function parseDurationMs(value: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ns|µs|μs|us|ms|s|m|h)/g)];
  if (!parts.length) return undefined;
  const scales: Record<string, number> = {ns: 1e-6, 'µs': .001, 'μs': .001, us: .001, ms: 1, s: 1000, m: 60000, h: 3600000};
  return parts.reduce((sum, part) => sum + Number(part[1]) * scales[part[2]], 0);
}

const BRIDGE_PREFIX = '@multica-k8s-v1\t';
const BRIDGE_FRAME = /^@multica-k8s-v1\t([a-zA-Z0-9-]{1,128})\t([a-z0-9.-]{1,253})\t([0-9a-fA-F:.]{0,45})\t([a-z0-9-]{1,63})\t([a-f0-9]{64})\t/;
// Every valid ASCII frame fits in this bound, below the minimum 1 KiB read.
const FRAME_READ_LIMIT = 600;

/** Return a validated ASCII header, or null if a partial header needs another read. */
export function readBridgeFrame(line: Buffer, complete: boolean): string | null | undefined {
  if (line[0] !== 64) return undefined;
  const text = line.toString('latin1', 0, FRAME_READ_LIMIT);
  if (!text.startsWith(BRIDGE_PREFIX)) return undefined;
  const header = BRIDGE_FRAME.exec(text)?.[0];
  if (header) return header;
  return !complete && line.length < FRAME_READ_LIMIT ? null : undefined;
}

/** Preserve bounded, redacted diagnostics alongside canonical event names. */
export function parseMulticaLog(line: string): MulticaRecord | undefined {
  const origin: MulticaRecord = {};
  // Only the bridge frame before the Kubernetes timestamp supplies target
  // identity. Ordinary application fields cannot overwrite Pod metadata.
  if (line.startsWith(BRIDGE_PREFIX)) {
    const frame = BRIDGE_FRAME.exec(line);
    if (!frame) return undefined;
    origin.pod_uid = frame[1];
    origin.pod_name = frame[2];
    if (isIP(frame[3])) origin.pod_ip = frame[3];
    origin.container_name = frame[4];
    origin.log_event_id = frame[5];
    line = line.slice(frame[0].length);
  }
  let clean = line.replace(/\x1b\[[0-9;]*m/g, '');
  let sourceTime: string | undefined;
  const cri = /^(\d{4}-\d\d-\d\dT\S+)\s+(?:stdout|stderr)\s+([FP])\s+(.*)$/.exec(clean);
  if (cri) {
    if (cri[2] === 'P') return undefined;
    sourceTime = cri[1]; clean = cri[3];
  }
  const prefixed = /^(\d{4}-\d\d-\d\dT\S+)\s+(.*)$/.exec(clean);
  if (prefixed) { sourceTime ??= prefixed[1]; clean = prefixed[2]; }
  let fields: Record<string, unknown> = {};
  let message: string;
  if (clean.startsWith('{')) {
    try { fields = object(JSON.parse(clean)); } catch { return undefined; }
    message = String(fields.msg ?? fields.message ?? '');
    sourceTime ??= typeof fields.time === 'string' ? fields.time : undefined;
  } else {
    for (const match of clean.matchAll(/(?:^|\s)([a-zA-Z_][a-zA-Z0-9_.]*)=("(?:\\.|[^"\\])*"|\S+)/g)) {
      try { fields[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2]; } catch { /* Ignore malformed attributes. */ }
    }
    message = String(fields.msg ?? clean.slice(0, clean.search(/\s[a-zA-Z_][\w.]*=/) < 0 ? clean.length : clean.search(/\s[a-zA-Z_][\w.]*=/)));
    fields.level ??= /\b(DEBUG|INFO|WARN|ERROR|DBG|INF|WRN|ERR)\b/.exec(clean)?.[1];
    sourceTime ??= typeof fields.time === 'string' ? fields.time : /^\d{4}-\d\d-\d\dT\S+/.exec(clean)?.[0];
  }
  const template = MESSAGES.find(m => message.toLowerCase().includes(m));
  const failure = classifyFailure(String(fields.error ?? ''));
  const diagnosticLevel = /^(?:WARN|WARNING|ERROR|WRN|ERR|FATAL)$/i.test(String(fields.level ?? ''));
  if (!template && (!failure || failure === 'unclassified') && !diagnosticLevel) return undefined;
  const row: MulticaRecord = {record_type: 'server_log', source_type: 'log', ...selectFields(fields), ...origin,
    ...logDiagnostics(fields, message), message: template ?? (failure && failure !== 'unclassified' ? 'provider failure' : 'diagnostic log')};
  if (fields.level) row.level = safeScalar(fields.level)!;
  if (sourceTime && Number.isFinite(Date.parse(sourceTime))) row.source_time = sourceTime;
  if (failure) row.failure_reason = failure;
  if (fields.task_phase) row.phase = safeScalar(fields.task_phase)!;
  if (fields.status !== undefined) row.http_status = safeScalar(fields.status)!;
  if (fields.duration !== undefined) {
    const duration = parseDurationMs(String(fields.duration));
    if (duration !== undefined) row.duration_ms = String(duration);
  }
  // Query strings can contain credentials or user-authored text.
  if (row.path) row.path = row.path.split('?')[0];
  return row;
}
