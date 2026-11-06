//! Port of `src/utils/restart-breadcrumb.ts`.

use super::fs_utils::{now_ms, read_json_file};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

pub const RESTART_STAGES: &[&str] = &[
    "binary-missing",
    "node-missing",
    "bootstrap-missing",
    "task-missing",
    "task-query-failed",
    "register-denied",
    "start-failed",
    "not-running-after-start",
    "selfheal-register-failed",
    "selfheal-not-running",
    "service-manager-refused",
    "timeout",
];

const DETAIL_MAX_CHARS: usize = 300;
const VALUE_MAX_CHARS: usize = 200;
const SUMMARY_MAX_CHARS: usize = 900;

const DIAG_KEY_ORDER: &[&str] = &[
    "task_state",
    "exists_ps",
    "exists_schtasks",
    "query_error",
    "last_task_result",
    "last_run_time",
    "missed_runs",
    "register_error",
    "start_error",
    "selfheal_error",
    "principal_user",
    "logon_type",
    "run_level",
    "definition_owner",
    "action_exe",
    "node_bin",
    "pid_state",
    "service_state",
    "unit_state",
    "log_tail",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartTarget {
    Collector,
    Updater,
}

impl RestartTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Collector => "collector",
            Self::Updater => "updater",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "collector" => Some(Self::Collector),
            "updater" => Some(Self::Updater),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RestartFailureBreadcrumb {
    pub schema: i64,
    pub ts: f64,
    pub target: String,
    pub stage: String,
    pub init_type: Option<String>,
    pub detail: Option<String>,
    pub diag: Option<IndexMap<String, String>>,
}

#[derive(Debug, Clone)]
pub struct RestartFailureWrite {
    pub stage: String,
    pub init_type: Option<String>,
    pub detail: Option<String>,
    pub diag: Option<IndexMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartExitCode {
    Number(i64),
    Name(String),
}

impl std::fmt::Display for RestartExitCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Number(value) => write!(f, "{value}"),
            Self::Name(value) => write!(f, "{value}"),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct RestartCommandError {
    pub message: Option<String>,
    pub killed: Option<bool>,
    pub signal: Option<String>,
    pub code: Option<RestartExitCode>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

pub fn restart_failure_path(data_dir: &str, target: RestartTarget) -> String {
    Path::new(data_dir)
        .join("logs")
        .join(format!("last-restart-failure-{}.json", target.as_str()))
        .to_string_lossy()
        .into_owned()
}

pub async fn read_restart_failure(
    data_dir: &str,
    target: RestartTarget,
) -> Option<RestartFailureBreadcrumb> {
    let parsed: Value = read_json_file(&restart_failure_path(data_dir, target)).await?;
    breadcrumb_from_value(&parsed)
}

pub fn clear_restart_failure(data_dir: &str, target: RestartTarget) {
    let _ = std::fs::remove_file(restart_failure_path(data_dir, target));
}

pub fn write_restart_failure(data_dir: &str, target: RestartTarget, fields: &RestartFailureWrite) {
    let _ = (|| -> std::io::Result<()> {
        let file = RestartFile {
            schema: 1,
            ts: (now_ms() / 1000) as u64,
            target: target.as_str(),
            stage: &fields.stage,
            init_type: fields.init_type.as_deref(),
            detail: fields.detail.as_deref(),
            diag: fields.diag.as_ref(),
        };
        let mut body = serde_json::to_string_pretty(&file).unwrap_or_else(|_| "{}".to_string());
        body.push('\n');
        let path = restart_failure_path(data_dir, target);
        if let Some(parent) = Path::new(&path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = format!("{path}.{}.{}.tmp", std::process::id(), now_ms());
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
}

#[derive(Serialize)]
struct RestartFile<'a> {
    schema: i64,
    ts: u64,
    target: &'a str,
    stage: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    init_type: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diag: Option<&'a IndexMap<String, String>>,
}

pub fn coerce_restart_diag(raw: &Value) -> Option<IndexMap<String, String>> {
    if raw.is_null() {
        return None;
    }
    if let Some(items) = raw.as_array() {
        let mut out = IndexMap::new();
        for item in items {
            let Some(record) = item.as_object() else {
                continue;
            };
            let key = match record.get("Key").or_else(|| record.get("key")) {
                Some(Value::String(key)) if !key.is_empty() => key.clone(),
                _ => continue,
            };
            let value = record.get("Value").or_else(|| record.get("value"));
            out.insert(key, js_string(value));
        }
        return Some(out);
    }
    if let Some(record) = raw.as_object() {
        let mut out = IndexMap::new();
        for (key, value) in record {
            if value.is_null() || value.is_object() || value.is_array() {
                continue;
            }
            out.insert(key.clone(), js_string(Some(value)));
        }
        return Some(out);
    }
    None
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => {
            if *flag {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_string(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

pub fn is_restart_failure_fresh(
    breadcrumb: &RestartFailureBreadcrumb,
    attempt_start_ms: f64,
    skew_ms: Option<f64>,
) -> bool {
    let skew = skew_ms.unwrap_or(5_000.0);
    if !breadcrumb.ts.is_finite() || breadcrumb.ts <= 0.0 {
        return false;
    }
    breadcrumb.ts * 1000.0 >= attempt_start_ms - skew
}

pub fn summarize_restart_failure(breadcrumb: &RestartFailureBreadcrumb) -> String {
    let mut parts = vec![format!(
        "stage={}",
        sanitize_alarm_text(&breadcrumb.stage, 60)
    )];
    if let Some(detail) = breadcrumb.detail.as_deref().filter(|text| !text.is_empty()) {
        parts.push(format!(
            "reason=\"{}\"",
            sanitize_alarm_text(detail, DETAIL_MAX_CHARS)
        ));
    }
    if let Some(init_type) = breadcrumb
        .init_type
        .as_deref()
        .filter(|text| !text.is_empty())
    {
        parts.push(format!("init_type={}", sanitize_alarm_text(init_type, 40)));
    }
    let diag = breadcrumb.diag.clone().unwrap_or_default();
    let keys: Vec<&str> = diag.keys().map(String::as_str).collect();
    let mut ordered = Vec::new();
    for key in DIAG_KEY_ORDER {
        if keys.contains(key) {
            ordered.push(*key);
        }
    }
    let mut rest: Vec<&str> = keys
        .iter()
        .copied()
        .filter(|key| !DIAG_KEY_ORDER.contains(key))
        .collect();
    rest.sort_unstable();
    ordered.extend(rest);
    let mut rendered = parts.join(" ");
    for key in ordered {
        let value = sanitize_alarm_text(
            diag.get(key).map(String::as_str).unwrap_or(""),
            VALUE_MAX_CHARS,
        );
        if value.is_empty() {
            continue;
        }
        let next = format!("{rendered} {}=\"{value}\"", sanitize_alarm_text(key, 40));
        if next.chars().count() > SUMMARY_MAX_CHARS {
            break;
        }
        rendered = next;
    }
    rendered
}

pub fn sanitize_alarm_text(text: &str, max_chars: usize) -> String {
    let quotes = regex::Regex::new(r#"[\"\r\n\t]+"#).expect("alarm quote pattern");
    let spaces = regex::Regex::new(r"\s+").expect("alarm space pattern");
    let quoted = quotes.replace_all(text, " ");
    let collapsed = spaces.replace_all(&quoted, " ");
    collapsed.trim().chars().take(max_chars).collect()
}

pub fn is_restart_command_timeout(err: Option<&RestartCommandError>) -> bool {
    let Some(err) = err else { return false };
    err.killed == Some(true)
        || err.signal.as_deref() == Some("SIGTERM")
        || matches!(err.code, Some(RestartExitCode::Name(ref code)) if code == "ETIMEDOUT")
}

pub fn describe_restart_command_error(err: Option<&RestartCommandError>) -> String {
    let Some(err) = err else {
        return "no error detail".to_string();
    };
    let mut parts = Vec::new();
    if err.killed == Some(true) || err.signal.is_some() {
        let killed = err.killed == Some(true);
        let signal = err.signal.as_deref().unwrap_or("none");
        parts.push(format!("killed={killed} signal={signal}"));
    }
    if let Some(code) = &err.code {
        parts.push(format!("exit={code}"));
    }
    let stderr = tail_text(err.stderr.as_deref(), DETAIL_MAX_CHARS);
    let stdout = tail_text(err.stdout.as_deref(), DETAIL_MAX_CHARS);
    if !stderr.is_empty() {
        parts.push(format!("stderr=\"{stderr}\""));
    }
    if !stdout.is_empty() {
        parts.push(format!("stdout=\"{stdout}\""));
    }
    if parts.is_empty() {
        let message = sanitize_alarm_text(err.message.as_deref().unwrap_or(""), DETAIL_MAX_CHARS);
        if !message.is_empty() {
            parts.push(format!("err=\"{message}\""));
        }
    }
    if parts.is_empty() {
        "no error detail".to_string()
    } else {
        parts.join(" ")
    }
}

fn tail_text(text: Option<&str>, max_chars: usize) -> String {
    let clean = sanitize_alarm_text(text.unwrap_or(""), usize::MAX);
    let count = clean.chars().count();
    if count > max_chars {
        clean.chars().skip(count - max_chars).collect()
    } else {
        clean
    }
}

fn breadcrumb_from_value(parsed: &Value) -> Option<RestartFailureBreadcrumb> {
    let object = parsed.as_object()?;
    let schema = object.get("schema")?.as_i64()?;
    if schema != 1 {
        return None;
    }
    let stage = object.get("stage").and_then(Value::as_str).unwrap_or("");
    if stage.is_empty() {
        return None;
    }
    let ts = object.get("ts").and_then(Value::as_f64).unwrap_or(f64::NAN);
    Some(RestartFailureBreadcrumb {
        schema,
        ts,
        target: object
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        stage: stage.to_string(),
        init_type: object
            .get("init_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        detail: object
            .get("detail")
            .and_then(Value::as_str)
            .map(str::to_string),
        diag: object.get("diag").and_then(coerce_restart_diag),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::path::Path;

    fn write_breadcrumb(data_dir: &str, target: RestartTarget, payload: &Value, bom: bool) {
        let file = restart_failure_path(data_dir, target);
        std::fs::create_dir_all(Path::new(&file).parent().unwrap()).unwrap();
        let mut body = String::new();
        if bom {
            body.push('\u{feff}');
        }
        body.push_str(&serde_json::to_string_pretty(payload).unwrap());
        body.push('\n');
        std::fs::write(file, body).unwrap();
    }

    #[tokio::test]
    async fn reads_a_breadcrumb_written_with_a_bom() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        write_breadcrumb(
            data_dir,
            RestartTarget::Updater,
            &json!({
                "schema": 1,
                "ts": 1_700_000_000u64,
                "target": "updater",
                "stage": "register-denied",
                "init_type": "taskscheduler",
                "detail": "Access is denied.",
                "diag": {"definition_owner": "BUILTIN\\Administrators"}
            }),
            true,
        );
        let bc = read_restart_failure(data_dir, RestartTarget::Updater)
            .await
            .unwrap();
        assert_eq!(bc.stage, "register-denied");
        assert_eq!(
            bc.diag
                .as_ref()
                .unwrap()
                .get("definition_owner")
                .map(String::as_str),
            Some("BUILTIN\\Administrators")
        );
    }

    #[tokio::test]
    async fn returns_none_for_missing_unknown_schema_and_stage_less() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        assert!(read_restart_failure(data_dir, RestartTarget::Collector)
            .await
            .is_none());
        write_breadcrumb(
            data_dir,
            RestartTarget::Collector,
            &json!({"schema": 2, "ts": 1, "target": "collector", "stage": "task-missing"}),
            false,
        );
        assert!(read_restart_failure(data_dir, RestartTarget::Collector)
            .await
            .is_none());
        write_breadcrumb(
            data_dir,
            RestartTarget::Collector,
            &json!({"schema": 1, "ts": 1, "target": "collector"}),
            false,
        );
        assert!(read_restart_failure(data_dir, RestartTarget::Collector)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn returns_none_for_a_truncated_file() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        let file = restart_failure_path(data_dir, RestartTarget::Updater);
        std::fs::create_dir_all(Path::new(&file).parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"schema": 1, "stage": "task-mis"#).unwrap();
        assert!(read_restart_failure(data_dir, RestartTarget::Updater)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn clears_the_file_and_tolerates_a_second_clear() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        write_breadcrumb(
            data_dir,
            RestartTarget::Updater,
            &json!({"schema": 1, "ts": 1, "target": "updater", "stage": "timeout"}),
            false,
        );
        clear_restart_failure(data_dir, RestartTarget::Updater);
        assert!(read_restart_failure(data_dir, RestartTarget::Updater)
            .await
            .is_none());
        clear_restart_failure(data_dir, RestartTarget::Updater);
    }

    #[test]
    fn places_the_file_under_logs_per_target() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        for (target, filename) in [
            (RestartTarget::Updater, "last-restart-failure-updater.json"),
            (
                RestartTarget::Collector,
                "last-restart-failure-collector.json",
            ),
        ] {
            assert_eq!(
                Path::new(&restart_failure_path(data_dir, target)),
                dir.path().join("logs").join(filename)
            );
        }
    }

    #[test]
    fn maps_powershell_key_value_arrays_and_ignores_nested_objects() {
        let mapped = coerce_restart_diag(&json!([
            {"Key": "definition_owner", "Value": "BUILTIN\\Administrators"},
            {"key": "task_state", "value": "Ready"}
        ]))
        .unwrap();
        assert_eq!(
            mapped.get("definition_owner").map(String::as_str),
            Some("BUILTIN\\Administrators")
        );
        assert_eq!(mapped.get("task_state").map(String::as_str), Some("Ready"));
        let object = coerce_restart_diag(&json!({
            "task_state": "Ready", "nested": {"secret": "not-for-summary"}, "array": [1], "empty": null
        })).unwrap();
        assert_eq!(object.get("task_state").map(String::as_str), Some("Ready"));
        assert_eq!(object.len(), 1);
        assert!(coerce_restart_diag(&Value::Null).is_none());
    }

    #[tokio::test]
    async fn coerces_nested_hashtable_shape_into_a_string_map() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        write_breadcrumb(
            data_dir,
            RestartTarget::Updater,
            &json!({
                "schema": 1,
                "ts": 1_700_000_000u64,
                "target": "updater",
                "stage": "register-denied",
                "init_type": "taskscheduler",
                "detail": "Access is denied.",
                "diag": [
                    {"Key": "definition_owner", "Value": "BUILTIN\\Administrators"},
                    {"Key": "task_state", "Value": "Ready"},
                    {"Key": "exists_schtasks", "Value": "yes"}
                ]
            }),
            false,
        );
        let bc = read_restart_failure(data_dir, RestartTarget::Updater)
            .await
            .unwrap();
        assert_eq!(
            bc.diag
                .as_ref()
                .unwrap()
                .get("definition_owner")
                .map(String::as_str),
            Some("BUILTIN\\Administrators")
        );
        assert_eq!(
            bc.diag
                .as_ref()
                .unwrap()
                .get("task_state")
                .map(String::as_str),
            Some("Ready")
        );
        let summary = summarize_restart_failure(&bc);
        assert!(
            summary.contains("definition_owner=\"BUILTIN\\\\Administrators\"")
                || summary.contains("definition_owner=\"BUILTIN\\Administrators\"")
        );
        assert!(summary.contains("task_state=\"Ready\""));
        assert!(!summary.contains("[object Object]"));
    }

    #[tokio::test]
    async fn write_restart_failure_persists_a_timeout_breadcrumb() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        write_restart_failure(
            data_dir,
            RestartTarget::Updater,
            &RestartFailureWrite {
                stage: "timeout".into(),
                init_type: None,
                detail: Some("restart command killed by timeout before it reported a stage".into()),
                diag: None,
            },
        );
        let bc = read_restart_failure(data_dir, RestartTarget::Updater)
            .await
            .unwrap();
        assert_eq!(bc.stage, "timeout");
        assert!(summarize_restart_failure(&bc).contains("stage=timeout"));
    }

    fn at(ts: f64) -> RestartFailureBreadcrumb {
        RestartFailureBreadcrumb {
            schema: 1,
            ts,
            target: "updater".into(),
            stage: "start-failed".into(),
            init_type: None,
            detail: None,
            diag: None,
        }
    }

    #[test]
    fn freshness_accepts_a_breadcrumb_written_during_the_attempt() {
        let start = 1_700_000_000_000.0;
        assert!(is_restart_failure_fresh(
            &at(start / 1000.0 + 3.0),
            start,
            None
        ));
    }

    #[test]
    fn freshness_accepts_skew_and_rejects_an_older_breadcrumb() {
        let start = 1_700_000_000_000.0;
        assert!(is_restart_failure_fresh(
            &at(start / 1000.0 - 2.0),
            start,
            None
        ));
        assert!(!is_restart_failure_fresh(
            &at(start / 1000.0 - 60.0),
            start,
            None
        ));
    }

    #[test]
    fn freshness_rejects_a_missing_or_nonsensical_timestamp() {
        let start = 1_700_000_000_000.0;
        assert!(!is_restart_failure_fresh(&at(0.0), start, None));
        assert!(!is_restart_failure_fresh(&at(f64::NAN), start, None));
        let mut missing = at(0.0);
        missing.ts = f64::NAN;
        assert!(!is_restart_failure_fresh(&missing, start, None));
    }

    #[test]
    fn summary_leads_with_the_stage_and_quotes_the_reason() {
        let summary = summarize_restart_failure(&RestartFailureBreadcrumb {
            schema: 1,
            ts: 1.0,
            target: "updater".into(),
            stage: "register-denied".into(),
            init_type: Some("taskscheduler".into()),
            detail: Some("Register-ScheduledTask failed".into()),
            diag: Some({
                let mut diag = IndexMap::new();
                diag.insert("task_state".into(), "Ready".into());
                diag.insert("definition_owner".into(), "BUILTIN\\Administrators".into());
                diag
            }),
        });
        assert!(summary.starts_with("stage=register-denied"));
        assert!(summary.contains("reason=\"Register-ScheduledTask failed\""));
        assert!(summary.contains("init_type=taskscheduler"));
        assert!(summary.contains("task_state=\"Ready\""));
        assert!(summary.contains("definition_owner=\"BUILTIN\\Administrators\""));
    }

    #[test]
    fn summary_drops_empty_diag_values() {
        let summary = summarize_restart_failure(&RestartFailureBreadcrumb {
            schema: 1,
            ts: 1.0,
            target: "updater".into(),
            stage: "task-missing".into(),
            init_type: None,
            detail: None,
            diag: Some({
                let mut diag = IndexMap::new();
                diag.insert("start_error".into(), String::new());
                diag.insert("selfheal_error".into(), "   ".into());
                diag.insert("task_state".into(), "Ready".into());
                diag
            }),
        });
        assert!(!summary.contains("start_error"));
        assert!(!summary.contains("selfheal_error"));
        assert!(summary.contains("task_state=\"Ready\""));
    }

    #[test]
    fn summary_keeps_the_stage_readable() {
        let summary = summarize_restart_failure(&RestartFailureBreadcrumb {
            schema: 1,
            ts: 1.0,
            target: "updater".into(),
            stage: "not-running-after-start".into(),
            init_type: None,
            detail: Some("x".repeat(5_000)),
            diag: Some({
                let mut diag = IndexMap::new();
                diag.insert("log_tail".into(), "y".repeat(5_000));
                diag.insert("task_state".into(), "Ready".into());
                diag.insert("extra_one".into(), "z".repeat(5_000));
                diag.insert("extra_two".into(), "w".repeat(5_000));
                diag
            }),
        });
        assert!(summary.starts_with("stage=not-running-after-start"));
        assert!(summary.chars().count() <= 1_000);
        assert!(summary.contains("task_state=\"Ready\""));
    }

    #[test]
    fn summary_strips_quotes_newlines_and_tabs() {
        let summary = summarize_restart_failure(&RestartFailureBreadcrumb {
            schema: 1,
            ts: 1.0,
            target: "collector".into(),
            stage: "start-failed".into(),
            init_type: None,
            detail: Some("boom \"quoted\"\nsecond line\tafter tab".into()),
            diag: None,
        });
        assert_eq!(
            summary,
            "stage=start-failed reason=\"boom quoted second line after tab\""
        );
    }

    #[test]
    fn describe_reports_both_stream_tails() {
        let detail = describe_restart_command_error(Some(&RestartCommandError {
            message: Some("Command failed: powershell.exe ...".into()),
            code: Some(RestartExitCode::Number(1)),
            stdout: Some("[restart-failure] target=updater stage=register-denied".into()),
            stderr: Some("Cmd-RestartUpdater : Service manager failed to restart updater".into()),
            ..RestartCommandError::default()
        }));
        assert!(detail.contains("exit=1"));
        assert!(
            detail.contains("stdout=\"[restart-failure] target=updater stage=register-denied\"")
        );
        assert!(detail
            .contains("stderr=\"Cmd-RestartUpdater : Service manager failed to restart updater\""));
    }

    #[test]
    fn describe_keeps_the_end_of_a_long_stream() {
        let detail = describe_restart_command_error(Some(&RestartCommandError {
            code: Some(RestartExitCode::Number(1)),
            stdout: Some(format!("{}THE-REAL-REASON", "a".repeat(5_000))),
            ..RestartCommandError::default()
        }));
        assert!(detail.contains("THE-REAL-REASON"));
        assert!(detail.chars().count() < 1_000);
    }

    #[test]
    fn describe_falls_back_to_the_error_message() {
        let detail = describe_restart_command_error(Some(&RestartCommandError {
            message: Some("spawn powershell.exe ENOENT".into()),
            ..RestartCommandError::default()
        }));
        assert!(detail.contains("spawn powershell.exe ENOENT"));
        assert_eq!(describe_restart_command_error(None), "no error detail");
    }

    #[test]
    fn recognises_a_timeout_kill() {
        assert!(is_restart_command_timeout(Some(&RestartCommandError {
            killed: Some(true),
            signal: Some("SIGTERM".into()),
            ..RestartCommandError::default()
        })));
        assert!(is_restart_command_timeout(Some(&RestartCommandError {
            code: Some(RestartExitCode::Name("ETIMEDOUT".into())),
            ..RestartCommandError::default()
        })));
        assert!(!is_restart_command_timeout(Some(&RestartCommandError {
            code: Some(RestartExitCode::Number(1)),
            ..RestartCommandError::default()
        })));
        assert!(!is_restart_command_timeout(Some(&RestartCommandError {
            message: Some("nope".into()),
            ..RestartCommandError::default()
        })));
    }

    #[test]
    fn sanitize_collapses_whitespace_and_truncates() {
        assert_eq!(sanitize_alarm_text("  a\t b \n c  ", 100), "a b c");
        assert_eq!(sanitize_alarm_text("abcdef", 3), "abc");
    }

    fn script_function<'a>(source: &'a str, header: &str) -> &'a str {
        let start = source
            .find(header)
            .unwrap_or_else(|| panic!("missing production writer function {header}"));
        let end = source[start..]
            .find("\n}")
            .expect("production function has no top-level terminator")
            + start
            + 2;
        &source[start..end]
    }

    fn isolate_writer_command(command: &mut tokio::process::Command, root: &Path) {
        command
            .env_clear()
            .env("HOME", root)
            .env("USERPROFILE", root)
            .env("PILOT_RESTART_WRITER_ROOT", root)
            .current_dir(root)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "ComSpec",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "PATHEXT",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .env("TMPDIR", root)
            .env("TMP", root)
            .env("TEMP", root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn actual_shell_writer_round_trips_native_missing_binary_and_unicode_diagnostics() {
        let root = tempfile::tempdir().unwrap();
        let source = include_str!("../../scripts/loongsuite-pilot.sh");
        let mut harness =
            String::from("set -euo pipefail\nLOG_DIR=\"$PILOT_RESTART_WRITER_ROOT/logs\"\n");
        for name in [
            "json_escape",
            "restart_failure_file",
            "clear_restart_failure",
            "write_restart_failure",
        ] {
            harness.push_str(script_function(source, &format!("{name}() {{")));
            harness.push('\n');
        }
        harness.push_str(
            r#"
read_init_type() { printf '%s\n' 'background'; }
ensure_dirs() { mkdir -p "$LOG_DIR"; }
collect_restart_diag() {
    printf '%s\n' 'task_state=Ready' 'definition_owner=研发\成员'
}
clear_restart_failure collector
write_restart_failure collector binary-missing $'missing "native"\nnext\t\033'
write_restart_failure updater start-failed 'synthetic updater refusal'
"#,
        );
        let file = root.path().join("writer-fixture.sh");
        std::fs::write(&file, harness).unwrap();
        let start = now_ms() as f64;
        let mut command = tokio::process::Command::new("/bin/bash");
        command.arg(&file);
        isolate_writer_command(&mut command, root.path());
        command.env("PATH", "/usr/bin:/bin");
        let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "isolated shell writer failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let data = root.path().to_str().unwrap();
        let collector = read_restart_failure(data, RestartTarget::Collector)
            .await
            .unwrap();
        assert_eq!(collector.stage, "binary-missing");
        assert!(RESTART_STAGES.contains(&collector.stage.as_str()));
        assert_eq!(collector.init_type.as_deref(), Some("background"));
        assert_eq!(
            collector
                .diag
                .as_ref()
                .unwrap()
                .get("definition_owner")
                .map(String::as_str),
            Some("研发\\成员")
        );
        assert_eq!(
            collector.detail.as_deref(),
            Some("missing \"native\" next ")
        );
        assert!(is_restart_failure_fresh(&collector, start, None));
        let summary = summarize_restart_failure(&collector);
        assert!(summary.starts_with("stage=binary-missing"));
        assert!(summary.contains("definition_owner=\"研发\\成员\""));
        assert!(!summary.contains('\n'));
        assert_eq!(
            read_restart_failure(data, RestartTarget::Updater)
                .await
                .unwrap()
                .stage,
            "start-failed"
        );
        assert!(!root
            .path()
            .join("logs/last-restart-failure-collector.json.tmp")
            .exists());
        assert!(String::from_utf8_lossy(&output.stderr).contains("stage=binary-missing"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn actual_powershell_writer_keeps_utf8_flat_diag_in_full_and_constrained_language() {
        let source = include_str!("../../scripts/loongsuite-pilot.ps1");
        for constrained in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let mut harness=String::from("$ErrorActionPreference = 'Stop'\nImport-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop\nImport-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop\n$LOG_DIR = Join-Path $env:PILOT_RESTART_WRITER_ROOT 'logs'\n");
            if constrained {
                harness.push_str(
                    "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n",
                );
            }
            for name in [
                "Get-RestartFailureFile",
                "Get-EpochSeconds",
                "Escape-RestartJsonString",
                "ConvertTo-RestartFailureJson",
                "Write-RestartFailure",
            ] {
                harness.push_str(script_function(source, &format!("function {name} {{")));
                harness.push('\n');
            }
            harness.push_str(
                r#"
function Get-InitType { return 'taskscheduler' }
function Ensure-Dirs { New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null }
function Get-RestartDiagnostics {
    param([string]$TaskName,[string]$PidFile,[string]$LogFile,[hashtable]$Extra)
    return @{ task_state = 'Ready'; definition_owner = '研发\成员' }
}
$TASK_NAME_UPDATER = 'fixture-unused'
$TASK_NAME_COLLECTOR = 'fixture-unused'
$UPDATER_PID_FILE = Join-Path $LOG_DIR 'fixture-updater.pid'
$PID_FILE = Join-Path $LOG_DIR 'fixture-collector.pid'
$UPDATER_LOG_FILE = Join-Path $LOG_DIR 'fixture-updater.log'
$LOG_FILE = Join-Path $LOG_DIR 'fixture-collector.log'
"#,
            );
            harness.push_str("Write-RestartFailure -Target updater -Stage register-denied -Detail 'synthetic 访问拒绝'\n");
            let file = root.path().join("writer-fixture.ps1");
            std::fs::write(&file, format!("\u{feff}{harness}")).unwrap();
            let system = std::env::var_os("SystemRoot").expect("Windows SystemRoot");
            let mut command = tokio::process::Command::new(
                Path::new(&system).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            );
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&file);
            isolate_writer_command(&mut command, root.path());
            let output = tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
                .await
                .unwrap()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated PowerShell writer constrained={constrained} failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let data = root.path().to_str().unwrap();
            let bytes = std::fs::read(restart_failure_path(data, RestartTarget::Updater)).unwrap();
            assert!(
                bytes.starts_with(&[0xef, 0xbb, 0xbf]),
                "Windows PowerShell5.1 writer must emit UTF8 BOM"
            );
            let raw: Value =
                serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap()).unwrap();
            assert!(
                raw["diag"].is_object(),
                "real writer must not serialize diag as Key/Value array"
            );
            let breadcrumb = read_restart_failure(data, RestartTarget::Updater)
                .await
                .unwrap();
            assert_eq!(breadcrumb.stage, "register-denied");
            assert_eq!(breadcrumb.detail.as_deref(), Some("synthetic 访问拒绝"));
            assert_eq!(
                breadcrumb
                    .diag
                    .as_ref()
                    .unwrap()
                    .get("definition_owner")
                    .map(String::as_str),
                Some("研发\\成员")
            );
            assert!(
                summarize_restart_failure(&breadcrumb).contains("definition_owner=\"研发\\成员\"")
            );
        }
    }
}
