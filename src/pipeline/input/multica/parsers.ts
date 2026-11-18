import { classifyFailure, digest, object, safeScalar, selectFields } from './records.js';
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

/** Preserve bounded, redacted diagnostics alongside canonical event names. */
export function parseMulticaLog(line: string): MulticaRecord | undefined {
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
  const row: MulticaRecord = {record_type: 'server_log', source_type: 'log', ...selectFields(fields),
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
