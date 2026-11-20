import type { InterceptorDiagnostic } from './diagnostics.js';
import type { EvaluateHookResponse } from './types.js';

export interface InterceptorRuleStatus {
  /** Counts from the most recently parsed valid document, including other platforms. */
  configured: number;
  config_valid: boolean;
  /** Current executable managed generation; HTTP rules are excluded. */
  effective: number;
  pattern: number;
  regex: number;
  substring: number;
  script: number;
  audit: number;
  enforce: number;
  pending_scripts: number;
  unsupported_http: number;
  builtin: number;
}

export interface InterceptorActivityStatus {
  evaluations_total: number;
  blocked_total: number;
  matched_total: number;
  audit_hits_total: number;
  fail_open_total: number;
  evaluation_errors_total: number;
  duration_ms_total: number;
  duration_ms_avg: number | null;
  duration_ms_max: number | null;
  /** Histogram bucket upper bound; null means no observations or >3500ms. */
  duration_ms_p95_upper: number | null;
  duration_over_3500ms_total: number;
}

export interface InterceptorStatus {
  enabled: boolean;
  running: boolean;
  collection_status: 'ok' | 'disabled' | 'unavailable';
  sampled_at: string | null;
  worker_started_at: string | null;
  worker_restarts_total: number;
  rules: InterceptorRuleStatus | null;
  activity: InterceptorActivityStatus | null;
  diagnostics: Record<InterceptorDiagnostic['code'], number> | null;
}

export function unavailableInterceptorStatus(enabled: boolean): InterceptorStatus {
  return { enabled, running: false, collection_status: enabled ? 'unavailable' : 'disabled',
    sampled_at: null, worker_started_at: null, worker_restarts_total: 0,
    rules: null, activity: null, diagnostics: null };
}

const BUCKETS_MS = [1, 5, 10, 25, 50, 100, 200, 500, 1000, 3500, Infinity];

/** Fixed-size, metadata-only totals for this Worker lifetime. No observations are retained. */
export class InterceptorStatusCollector {
  private readonly startedAt = new Date().toISOString();
  private evaluations = 0;
  private blocked = 0;
  private matched = 0;
  private auditHits = 0;
  private failOpen = 0;
  private errors = 0;
  private duration = 0;
  private maxDuration = 0;
  private readonly buckets = BUCKETS_MS.map(() => 0);
  private readonly diagnostics = {
    config_rejected: 0, config_pull_failed: 0, config_apply_failed: 0,
    regex_slow: 0, regex_timeout: 0, regex_failed: 0,
  };

  record(verdict: EvaluateHookResponse | null, durationMs: number): void {
    this.evaluations++;
    if (verdict?.action === 'block') this.blocked++;
    if (verdict?.matched || verdict?.action === 'block') this.matched++;
    for (const match of verdict?.matches ?? []) if (match.action === 'log') this.auditHits++;
    if (!verdict || verdict.failOpen) this.failOpen++;
    if (!verdict) this.errors++;
    const elapsed = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    this.duration += elapsed;
    this.maxDuration = Math.max(this.maxDuration, elapsed);
    this.buckets[BUCKETS_MS.findIndex(limit => elapsed <= limit)]++;
  }

  recordDiagnostic(diagnostic: InterceptorDiagnostic): void {
    this.diagnostics[diagnostic.code]++;
  }

  snapshot(running: boolean, rules: InterceptorRuleStatus): InterceptorStatus {
    const rank = Math.ceil(this.evaluations * 0.95);
    let seen = 0;
    const index = this.buckets.findIndex(count => (seen += count) >= rank);
    const upper = this.evaluations ? BUCKETS_MS[index] : Infinity;
    return {
      enabled: true, running, collection_status: 'ok', sampled_at: new Date().toISOString(),
      worker_started_at: this.startedAt, worker_restarts_total: 0, rules: { ...rules },
      activity: {
        evaluations_total: this.evaluations, blocked_total: this.blocked, matched_total: this.matched,
        audit_hits_total: this.auditHits, fail_open_total: this.failOpen, evaluation_errors_total: this.errors,
        duration_ms_total: this.duration, duration_ms_avg: this.evaluations ? this.duration / this.evaluations : null,
        duration_ms_max: this.evaluations ? this.maxDuration : null,
        duration_ms_p95_upper: Number.isFinite(upper) ? upper : null,
        duration_over_3500ms_total: this.buckets[this.buckets.length - 1],
      },
      diagnostics: { ...this.diagnostics },
    };
  }
}
