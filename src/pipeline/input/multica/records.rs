use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::LazyLock;

use chrono::{DateTime, SecondsFormat};
use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::config::{source_url, Input};

pub(crate) type Record = BTreeMap<String, String>;

const FIELDS: &str = "workspace_id project_id issue_id task_id agent_id runtime_id daemon_id
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
action used reserved total limit reached period_start period_end reset_at retry_of_task_id rerun_of_task_id delegated_by_task_id";

const METRIC_LABELS: &str = "method route status terminal_status provider model model_alias outcome reason failure_reason claim_path phase result source kind type le quantile code handler runtime_mode operation op stage component decision action feature token_type direction stream transport signup_source platform path cadence trigger_kind recoverable gate event_kind";
const PROMOTED_LABELS: &str = "method route provider model outcome reason failure_reason runtime_mode source claim_path le token_type decision action terminal_status cadence trigger_kind";

static METRIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"^((?:multica_|go_|process_)[a-zA-Z0-9_:]+)(?:\{(.*)\})?\s+([+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?)(?:\s+\d+)?\s*$"
).expect("Prometheus line pattern")
});
static LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)""#).expect("Prometheus label pattern")
});
static REASON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_.-]{0,159}$").expect("Multica reason pattern"));

pub(crate) fn digest(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value.as_ref()))
}

pub(crate) fn record<const N: usize>(pairs: [(&str, &str); N]) -> Record {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

pub(crate) fn scalar(value: &Value) -> Option<String> {
    let raw = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => return None,
    };
    Some(
        super::diagnostics::redact(&raw)
            .chars()
            .map(|ch| if ch == '\r' || ch == '\n' { ' ' } else { ch })
            .take(512)
            .collect(),
    )
}

pub(crate) fn fields(value: &Value) -> Record {
    FIELDS
        .split_ascii_whitespace()
        .filter_map(|key| scalar(&value[key]).map(|value| (key.to_owned(), value)))
        .collect()
}

pub(crate) fn is_multica_metric(line: &str) -> bool {
    line.starts_with("multica_")
        && METRIC
            .captures(line)
            .is_some_and(|row| row[3].parse::<f64>().is_ok_and(f64::is_finite))
}

pub(crate) fn prometheus(text: &str) -> Vec<Record> {
    text.lines()
        .filter_map(|line| {
            let matched = METRIC.captures(line)?;
            if !matched[3].parse::<f64>().is_ok_and(f64::is_finite) {
                return None;
            }
            let raw_labels = matched.get(2).map_or("", |value| value.as_str());
            let labels: Record = LABEL
                .captures_iter(raw_labels)
                .filter(|label| {
                    METRIC_LABELS
                        .split_ascii_whitespace()
                        .any(|key| key == &label[1])
                })
                .filter_map(|label| {
                    let text: String = if &label[1] == "path" {
                        label[2].split('?').next().unwrap_or_default().to_owned()
                    } else {
                        format!("\"{}\"", &label[2])
                    };
                    let decoded = if &label[1] == "path" {
                        Value::String(text)
                    } else {
                        serde_json::from_str(&text)
                            .unwrap_or_else(|_| Value::String(label[2].to_owned()))
                    };
                    scalar(&decoded).map(|value| (label[1].to_owned(), value))
                })
                .collect();
            let mut row = record([
                ("record_type", "prometheus_sample"),
                ("source_type", "prometheus"),
                ("metric_name", &matched[1]),
                ("metric_value", &matched[3]),
            ]);
            row.insert(
                "metric_labels".into(),
                serde_json::to_string(&labels).expect("labels are strings"),
            );
            for key in PROMOTED_LABELS.split_ascii_whitespace() {
                if let Some(value) = labels.get(key) {
                    row.insert(key.to_owned(), value.clone());
                }
            }
            if let Some(value) = labels.get("status") {
                row.insert("http_status".into(), value.clone());
            }
            row.insert(
                "entity_id".into(),
                format!("{}:{}", &matched[1], digest(raw_labels)),
            );
            Some(row)
        })
        .collect()
}

pub(crate) fn failure(text: &str, explicit: bool) -> Option<&str> {
    if text.is_empty() {
        return None;
    }
    if explicit && REASON.is_match(text) && super::diagnostics::redact(text) == text {
        return Some(text);
    }
    let lower = text.to_ascii_lowercase();
    let contains = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    if contains(&[
        "429",
        "capacity",
        "overload",
        "rate limit",
        "rate_limit",
        "ratelimit",
        "rate-limit",
    ]) {
        Some("provider_capacity_or_rate_limit")
    } else if contains(&["unauth", "401", "403", "auth"])
        || (contains(&["expir", "invalid"]) && contains(&["token", "credential"]))
    {
        Some("provider_auth_or_access")
    } else if contains(&["quota", "credit", "billing", "budget"]) {
        Some("provider_quota_limit")
    } else if contains(&["timeout", "timed out", "timed_out", "timedout"]) {
        Some("timeout")
    } else {
        Some("unclassified")
    }
}

pub(crate) fn snapshot(kind: &str, value: &Value, extra: &Record, collect_names: bool) -> Record {
    let mut row = record([("record_type", kind), ("source_type", "api")]);
    row.extend(fields(value));
    row.extend(extra.clone());
    if kind == "task_snapshot" {
        row.extend(super::diagnostics::log(value, ""));
    }
    let identity = scalar(&value["id"]).unwrap_or_else(|| {
        digest(serde_json::to_vec(&row).expect("snapshot fields are strings"))[..24].to_owned()
    });
    row.insert("entity_id".into(), identity.clone());
    if let Some(key) = match kind {
        "issue_snapshot" => Some("issue_id"),
        "task_snapshot" => Some("task_id"),
        "agent_snapshot" => Some("agent_id"),
        "runtime_snapshot" => Some("runtime_id"),
        "autopilot_snapshot" => Some("autopilot_id"),
        _ => None,
    } {
        row.insert(key.into(), identity);
    }
    if kind == "issue_status_snapshot" {
        row.insert("status".into(), scalar(&value["key"]).unwrap_or_default());
        row.insert(
            "status_category".into(),
            scalar(&value["category"]).unwrap_or_default(),
        );
        row.insert("is_system".into(), (value["is_system"] == true).to_string());
    }
    let reason = non_null(&value["reason_code"]).or_else(|| non_null(&value["failure_reason"]));
    let sensitive = reason.unwrap_or(&value["error"]);
    if let Some(reason) = sensitive
        .as_str()
        .and_then(|text| failure(text, reason.is_some()))
    {
        row.insert("failure_reason".into(), reason.to_owned());
    }
    for key in [
        "retry_of_task_id",
        "rerun_of_task_id",
        "delegated_by_task_id",
    ] {
        if let Some(attribution) = scalar(&value["attribution"][key]) {
            row.insert(key.to_owned(), attribution);
        }
    }
    if let Some(usage) = value["usage"]
        .as_array()
        .filter(|values| !values.is_empty())
    {
        for key in [
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "cost_usd_ticks",
            "credits_micros",
        ] {
            let mut values = usage.iter().filter_map(|usage| usage[key].as_f64());
            if let Some(first) = values.next() {
                row.insert(key.to_owned(), (first + values.sum::<f64>()).to_string());
            }
        }
        for key in ["provider", "model"] {
            let options: std::collections::BTreeSet<_> = usage
                .iter()
                .filter_map(|usage| scalar(&usage[key]))
                .filter(|value| !value.is_empty())
                .collect();
            if options.len() == 1 {
                row.insert(
                    key.to_owned(),
                    options.into_iter().next().expect("one value"),
                );
            }
        }
        row.insert("usage_recorded".into(), "true".into());
    }
    if let Some(cost) = number(&row, "cost_usd_ticks") {
        row.insert("cost_usd".into(), (cost / 1e10).to_string());
    }
    if row.contains_key("input_tokens") {
        let total: f64 = [
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
        ]
        .into_iter()
        .filter_map(|key| number(&row, key))
        .sum();
        row.insert("total_tokens".into(), total.to_string());
    }
    if let Some(day) = row.get("date").cloned().or_else(|| {
        row.get("bucket_at")
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .map(|at| at.format("%Y-%m-%d").to_string())
    }) {
        row.insert("day".into(), day);
    }
    for (key, from, to) in [
        ("queue_wait_ms", "created_at", "started_at"),
        ("run_duration_ms", "started_at", "completed_at"),
        ("total_duration_ms", "created_at", "completed_at"),
    ] {
        if let (Some(start), Some(end)) = (date_ms(&row, from), date_ms(&row, to)) {
            if end >= start {
                row.insert(key.into(), (end - start).to_string());
            }
        }
    }
    if collect_names {
        let labels: &[(&str, &str)] = match kind {
            "agent_snapshot" => &[("agent_name", "name")],
            "runtime_snapshot" => &[(
                "runtime_name",
                if value["custom_name"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty())
                {
                    "custom_name"
                } else {
                    "name"
                },
            )],
            "issue_snapshot" => &[("issue_identifier", "identifier"), ("issue_title", "title")],
            "autopilot_snapshot" => &[("autopilot_title", "title")],
            "project_snapshot" => &[("project_id", "id"), ("project_title", "title")],
            "workspace_snapshot" => &[("workspace_name", "name"), ("workspace_slug", "slug")],
            _ => &[],
        };
        for (key, raw) in labels {
            if let Some(label) = scalar(&value[*raw]).filter(|label| !label.trim().is_empty()) {
                row.insert((*key).into(), label);
            }
        }
    }
    row
}

pub(crate) fn non_null(value: &Value) -> Option<&Value> {
    (!value.is_null()).then_some(value)
}

fn number(row: &Record, key: &str) -> Option<f64> {
    row.get(key)?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn date_ms(row: &Record, key: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(row.get(key)?)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn pod_label(value: &str) -> Option<String> {
    (value.len() <= 253
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'.' | b'-')))
    .then(|| value.to_owned())
}

pub(crate) fn pod_labels(input: &Input, source: &str) -> Record {
    let name = std::env::var("POD_NAME")
        .ok()
        .as_deref()
        .and_then(pod_label)
        .or_else(|| {
            hostname::get()
                .ok()
                .and_then(|name| name.into_string().ok())
                .as_deref()
                .and_then(pod_label)
        });
    let uid = input
        .pod_uid
        .clone()
        .or_else(|| std::env::var("POD_UID").ok())
        .as_deref()
        .and_then(pod_label);
    let ip = input
        .pod_ip
        .clone()
        .or_else(|| std::env::var("POD_IP").ok())
        .filter(|ip| ip.parse::<IpAddr>().is_ok());
    let mut row = Record::new();
    for (key, value) in [
        ("collector_pod_name", &name),
        ("collector_pod_uid", &uid),
        ("collector_pod_ip", &ip),
    ] {
        if let Some(value) = value {
            row.insert(key.into(), value.clone());
        }
    }
    let (kind, path) = source.split_once(':').unwrap_or_default();
    let address = match kind {
        "metrics" | "health" => Some(path),
        "pprof" => input.pprof_base_url.as_deref(),
        _ => None,
    };
    let local = kind == "stat"
        || address
            .and_then(|uri| source_url(uri).ok())
            .and_then(|uri| uri.host_str().map(str::to_owned))
            .is_some_and(|host| {
                let address = host.trim_matches(['[', ']']).parse::<IpAddr>().ok();
                host == "localhost"
                    || address.is_some_and(|address| {
                        address.is_loopback()
                            || ip.as_deref().and_then(|ip| ip.parse::<IpAddr>().ok())
                                == Some(address)
                    })
            });
    let profile_name = (kind == "pprof")
        .then(|| input.pprof_pod_name.as_deref().and_then(pod_label))
        .flatten();
    if let Some(profile) = &profile_name {
        row.insert("pod_name".into(), profile.clone());
        if name.as_ref().is_some_and(|name| name != profile) {
            return row;
        }
    }
    if local {
        for (key, value) in [
            ("pod_name", profile_name.or(name)),
            ("pod_uid", uid),
            ("pod_ip", ip),
        ] {
            if let Some(value) = value {
                row.insert(key.into(), value);
            }
        }
    }
    row
}

pub(crate) fn envelope(
    input: &Input,
    source: &str,
    observed: i64,
    mut record: Record,
    labels: &Record,
) -> Record {
    let pod = ["pod_uid", "pod_name", "pod_ip"]
        .into_iter()
        .find_map(|key| labels.get(key).filter(|value| !value.is_empty()));
    let scoped = pod.map_or_else(|| source.to_owned(), |pod| format!("{source}\0{pod}"));
    let instance = input
        .instance
        .as_ref()
        .and_then(|text| scalar(&Value::String(text.clone())))
        .unwrap_or_else(|| "multica".into());
    let mut row = self::record([
        ("schema_version", "multica.v1"),
        ("multica_env", &instance),
        ("instance", &instance),
        ("source_name", source),
        (
            "evidence_kind",
            input.evidence_kind.as_deref().unwrap_or("observed"),
        ),
    ]);
    for (key, value) in [
        ("environment", &input.environment),
        ("namespace", &input.namespace),
        ("test_case", &input.test_case),
    ] {
        row.insert(
            key.into(),
            value
                .as_ref()
                .map(|value| {
                    super::diagnostics::redact(value)
                        .chars()
                        .take(512)
                        .collect()
                })
                .unwrap_or_default(),
        );
    }
    let observed_at = DateTime::from_timestamp_millis(observed)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default();
    row.insert("observed_at".into(), observed_at);
    row.insert("observed_at_ms".into(), observed.to_string());
    row.insert(
        "snapshot_id".into(),
        digest(format!("{scoped}\0{observed}"))[..24].to_owned(),
    );
    let durable_identity = record.remove("log_identity").unwrap_or_else(|| {
        format!(
            "{observed}\0{}",
            serde_json::to_string(&record).expect("record is strings")
        )
    });
    row.extend(record);
    row.extend(labels.clone());
    if let Some(rules) = &input.agent_evidence {
        let agent = row.get("agent_id").or_else(|| {
            (row.get("assignee_type").map(String::as_str) == Some("agent"))
                .then(|| row.get("assignee_id"))
                .flatten()
        });
        let rule = agent.and_then(|id| rules.get(id));
        row.insert(
            "workload_type".into(),
            rule.map_or("mixed_lab", |rule| rule.workload_type.as_str())
                .to_owned(),
        );
        if let Some(rule) = rule {
            row.insert("evidence_kind".into(), rule.kind.clone());
        }
    }
    if row
        .get("record_type")
        .is_some_and(|kind| kind == "task_snapshot")
    {
        let field = match row.get("status").map(String::as_str) {
            Some("queued" | "dispatched") => Some(("queue_age_ms", "created_at")),
            Some("running") => Some(("run_age_ms", "started_at")),
            _ => None,
        };
        if let Some((key, then)) = field {
            if let Some(then) = date_ms(&row, then).filter(|then| *then <= observed) {
                row.insert(key.into(), (observed - then).to_string());
            }
        }
    }
    row.insert(
        "event_id".into(),
        digest(format!("{instance}\0{scoped}\0{durable_identity}")),
    );
    row
}
