//! Bounded, metadata-only counters for the local native decision path.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const LIMITS_MS: [f64; 10] = [1., 5., 10., 25., 50., 100., 200., 500., 1000., 3500.];

#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct HookActivity {
    count: u64,
    blocked: u64,
    matched: u64,
    audit: u64,
    fail_open: u64,
    errors: u64,
    total_ms: f64,
    max_ms: f64,
    buckets: [u64; 11],
}

impl HookActivity {
    pub(crate) fn record(
        &mut self,
        verdict: &Value,
        elapsed_ms: f64,
        unavailable: bool,
        stopping: bool,
    ) {
        self.count += 1;
        let blocked = verdict["action"] == "block";
        self.blocked += u64::from(blocked);
        self.matched += u64::from(blocked || verdict["matched"] == true);
        self.audit += verdict["matches"].as_array().map_or(0, |hits| {
            hits.iter()
                .filter(|hit| hit["enforcement"] == "audit")
                .count() as u64
        });
        self.fail_open += u64::from(unavailable || verdict["failOpen"] == true);
        self.errors += u64::from(unavailable && !stopping);
        self.total_ms += elapsed_ms;
        self.max_ms = self.max_ms.max(elapsed_ms);
        let bucket = LIMITS_MS
            .iter()
            .position(|limit| elapsed_ms <= *limit)
            .unwrap_or(LIMITS_MS.len());
        self.buckets[bucket] += 1;
    }

    pub(crate) fn merge(&mut self, other: &Self) {
        self.count += other.count;
        self.blocked += other.blocked;
        self.matched += other.matched;
        self.audit += other.audit;
        self.fail_open += other.fail_open;
        self.errors += other.errors;
        self.total_ms += other.total_ms;
        self.max_ms = self.max_ms.max(other.max_ms);
        for (total, count) in self.buckets.iter_mut().zip(other.buckets) {
            *total += count;
        }
    }

    pub(crate) fn snapshot(&self) -> Value {
        let mut seen = 0;
        let upper = if self.count == 0 {
            None
        } else {
            let rank = self.count.saturating_mul(95).div_ceil(100);
            self.buckets
                .iter()
                .position(|count| {
                    seen += count;
                    seen >= rank
                })
                .and_then(|index| LIMITS_MS.get(index).copied())
        };
        json!({
            "evaluations_total": self.count, "blocked_total": self.blocked,
            "matched_total": self.matched, "audit_hits_total": self.audit,
            "fail_open_total": self.fail_open, "evaluation_errors_total": self.errors,
            "duration_ms_total": self.total_ms,
            "duration_ms_avg": (self.count != 0).then(|| self.total_ms / self.count as f64),
            "duration_ms_max": (self.count != 0).then_some(self.max_ms),
            "duration_ms_p95_upper": upper,
            "duration_over_3500ms_total": self.buckets[10],
        })
    }
}

pub(crate) const DIAGNOSTIC_CODES: [&str; 6] = [
    "config_rejected",
    "config_pull_failed",
    "config_apply_failed",
    "regex_slow",
    "regex_timeout",
    "regex_failed",
];

pub(crate) fn unavailable(enabled: bool) -> Value {
    json!({
        "enabled": enabled, "running": false,
        "collection_status": if enabled { "unavailable" } else { "disabled" },
        "sampled_at": null, "worker_started_at": null, "worker_restarts_total": 0,
        "rules": null, "activity": null, "diagnostics": null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histogram_and_verdict_totals_merge_without_retaining_request_data() {
        let mut activity = HookActivity::default();
        assert!(activity.snapshot()["duration_ms_p95_upper"].is_null());
        for _ in 0..19 {
            activity.record(&json!({"action":"allow"}), 3.0, false, false);
        }
        let mut other = HookActivity::default();
        other.record(
            &json!({"action":"block","matches":[{"enforcement":"audit"}]}),
            4000.0,
            false,
            false,
        );
        activity.merge(&other);
        let snapshot = activity.snapshot();
        assert_eq!(snapshot["evaluations_total"], 20);
        assert_eq!(snapshot["blocked_total"], 1);
        assert_eq!(snapshot["audit_hits_total"], 1);
        assert_eq!(snapshot["duration_ms_p95_upper"], 5.0);
        assert_eq!(snapshot["duration_over_3500ms_total"], 1);
    }
}
