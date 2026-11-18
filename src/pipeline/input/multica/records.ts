import { createHash } from 'node:crypto';
import type { JsonObject, MulticaInputConfig, MulticaRecord } from './types.js';
import { logDiagnostics } from './log-diagnostics.js';
import { podScopedSource } from './pod-labels.js';

export const SCALAR_FIELDS = new Set(`workspace_id project_id issue_id task_id agent_id runtime_id daemon_id
  status status_category priority assignee_type assignee_id parent_issue_id parent_task_id
  created_at updated_at last_activity_at dispatched_at started_at completed_at triggered_at
  last_seen_at last_run_at next_run_at last_run_status runtime_bound runtime_availability
  runtime_mode max_concurrent_tasks provider model attempt max_attempts reason_code
  execution_mode pause_reason source autopilot_id trigger_id date day hour bucket_at
  input_tokens output_tokens cache_read_tokens cache_write_tokens total_tokens cost_usd_ticks credits_micros
  uncosted_input_tokens uncosted_output_tokens uncosted_cache_read_tokens uncosted_cache_write_tokens
  task_count count failed_count completed_count cancelled_count duration_count metered_task_count run_count total_count duration_ms duration_seconds runtime_seconds
  total_seconds avg_seconds p50_seconds p95_seconds active_task_count running_task_count resource_wait_task_count
  pending_terminal_report_count pending_terminal_report_bytes failed_terminal_report_count failed_terminal_report_bytes
  repo_maintenance_active repo_checkout_waiters cli_version cli_commit pid os uptime
  request_id comment_id task_phase phase_elapsed_ms total_elapsed_ms method route path http_status size_bytes
  claim_path outcome reason candidates running max_concurrent exit_code event_count invalid_event_count
  tool_use_count saw_result result_is_error expires_at event event_type handler_index handler_count total_duration_ms version connected enabled
  action used reserved total limit reached period_start period_end reset_at
  retry_of_task_id rerun_of_task_id delegated_by_task_id`.split(/\s+/));

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export function safeScalar(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\r\n\x00-\x08]/g, ' ')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|mat_|mpt_|ghp_|github_pat_)[\w.-]+)/gi, '[REDACTED]')
    .replace(/((?:password|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[REDACTED]').slice(0, 512);
}

export function selectFields(value: unknown): MulticaRecord {
  const out: MulticaRecord = {};
  for (const [key, val] of Object.entries(object(value))) {
    if (!SCALAR_FIELDS.has(key)) continue;
    const scalar = safeScalar(val);
    if (scalar !== undefined) out[key] = scalar;
  }
  return out;
}

export function classifyFailure(value: unknown, allowReasonCode = false): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  // Only dedicated API reason fields may preserve enum codes. Raw errors can
  // contain credentials even when the entire string resembles a valid code.
  if (allowReasonCode && /^[a-z][a-z0-9_.-]{0,159}$/.test(value) && safeScalar(value) === value) return value;
  if (/rate.?limit|429|capacity|overload/i.test(value)) return 'provider_capacity_or_rate_limit';
  if (/token.*expir|expir.*token|unauth|invalid.*(?:token|credential)|401|403|auth/i.test(value)) return 'provider_auth_or_access';
  if (/quota|credit|billing|budget/i.test(value)) return 'provider_quota_limit';
  if (/timeout|timed.?out/i.test(value)) return 'timeout';
  return 'unclassified';
}

export function snapshot(recordType: string, value: unknown, extra: MulticaRecord = {}): MulticaRecord {
  const row = object(value);
  const out: MulticaRecord = { record_type: recordType, source_type: 'api', ...selectFields(row), ...extra };
  if (recordType === 'task_snapshot') Object.assign(out, logDiagnostics(row, ''));
  out.entity_id = safeScalar(row.id) ?? digest(JSON.stringify(out)).slice(0, 24);
  if (recordType === 'issue_status_snapshot') {
    out.status = safeScalar(row.key) ?? '';
    out.status_category = safeScalar(row.category) ?? '';
    out.is_system = String(row.is_system === true);
  }
  const idField: Record<string, string> = {issue_snapshot: 'issue_id', task_snapshot: 'task_id', agent_snapshot: 'agent_id', runtime_snapshot: 'runtime_id', autopilot_snapshot: 'autopilot_id'};
  if (idField[recordType]) out[idField[recordType]] = out.entity_id;
  const reasonCode = row.reason_code ?? row.failure_reason;
  const reason = reasonCode === undefined || reasonCode === null
    ? classifyFailure(row.error) : classifyFailure(reasonCode, true);
  if (reason) out.failure_reason = reason;
  const attribution = object(row.attribution);
  for (const key of ['retry_of_task_id', 'rerun_of_task_id', 'delegated_by_task_id']) {
    const val = safeScalar(attribution[key]);
    if (val) out[key] = val;
  }
  if (Array.isArray(row.usage) && row.usage.length) {
    const usage = row.usage.map(object);
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd_ticks', 'credits_micros']) {
      const values = usage.map(u => u[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (values.length) out[key] = String(values.reduce((sum, v) => sum + v, 0));
    }
    const providers = [...new Set(usage.map(u => safeScalar(u.provider)).filter(Boolean))];
    const models = [...new Set(usage.map(u => safeScalar(u.model)).filter(Boolean))];
    if (providers.length === 1) out.provider = providers[0]!;
    if (models.length === 1) out.model = models[0]!;
    out.usage_recorded = 'true';
  }
  if (out.cost_usd_ticks !== undefined) out.cost_usd = String(Number(out.cost_usd_ticks) / 1e10);
  if (out.input_tokens !== undefined) out.total_tokens = String(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].reduce((sum, k) => sum + Number(out[k] ?? 0), 0));
  if (out.date) out.day = out.date;
  else if (out.bucket_at && Number.isFinite(Date.parse(out.bucket_at))) out.day = out.bucket_at.slice(0, 10);
  for (const [key, from, to] of [['queue_wait_ms', 'created_at', 'started_at'], ['run_duration_ms', 'started_at', 'completed_at'], ['total_duration_ms', 'created_at', 'completed_at']]) {
    const delta = Date.parse(out[to]) - Date.parse(out[from]);
    if (Number.isFinite(delta) && delta >= 0) out[key] = String(delta);
  }
  return out;
}

export function envelope(input: MulticaInputConfig, source: string, observed: number, record: MulticaRecord, identity?: string,
  podLabels: MulticaRecord = {}): MulticaRecord {
  const agentId = record.agent_id ?? (record.assignee_type === 'agent' ? record.assignee_id : undefined);
  const evidence = agentId && Object.prototype.hasOwnProperty.call(input.AgentEvidence ?? {}, agentId)
    ? input.AgentEvidence![agentId] : undefined;
  const scopedSource = podScopedSource(source, podLabels);
  const multicaEnv = safeScalar(input.Instance) ?? 'multica';
  const result: MulticaRecord = {
    schema_version: 'multica.v1', multica_env: multicaEnv, instance: multicaEnv,
    environment: safeScalar(input.Environment) ?? '', namespace: safeScalar(input.Namespace) ?? '',
    evidence_kind: input.EvidenceKind ?? 'observed', test_case: safeScalar(input.TestCase) ?? '',
    observed_at: new Date(observed).toISOString(), observed_at_ms: String(observed), source_name: source,
    snapshot_id: digest(`${scopedSource}\0${observed}`).slice(0, 24),
    ...record,
    ...podLabels,
  };
  if (input.AgentEvidence) {
    // Rules are explicit experiment metadata, never inferred from the error text.
    result.evidence_kind = evidence?.Kind ?? input.EvidenceKind ?? 'observed';
    result.workload_type = evidence?.WorkloadType ?? 'mixed_lab';
  }
  if (record.record_type === 'task_snapshot') {
    const base = ['queued', 'dispatched'].includes(record.status) ? record.created_at : record.status === 'running' ? record.started_at : undefined;
    const age = observed - Date.parse(base ?? '');
    if (Number.isFinite(age) && age >= 0) result[record.status === 'running' ? 'run_age_ms' : 'queue_age_ms'] = String(age);
  }
  result.event_id = digest(`${result.instance}\0${scopedSource}\0${identity ?? `${observed}\0${JSON.stringify(record)}`}`);
  return result;
}
