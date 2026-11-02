//! Port of `src/updater/updater-metrics.ts`.

use crate::updater::startup_crash_classifier::classify_startup_crash;
use crate::utils::{
    append_line, check_process_liveness, create_logger, ensure_dir, flatten_to_strings,
    get_today_date_string, read_startup_crash, resolve_local_ip, ProcessCommandPattern,
    ProcessLivenessProbe, COLLECTOR_PROCESS_PATTERNS,
};
use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const COLLECTOR_HEALTH_INTERVAL_MS: u64 = 60_000;
pub const COLLECTOR_HEALTH_STARTUP_GRACE_MS: u64 = 3 * 60_000;
pub const COLLECTOR_HEALTH_FAILURE_THRESHOLD: u32 = 2;
pub const COLLECTOR_HEALTH_ALARM_COOLDOWN_MS: u64 = 60 * 60_000;
pub const FLUSH_INTERVAL_MS: u64 = 30_000;

pub const EVENT_UPDATER_STARTED: &str = "updater_started";
pub const EVENT_UPDATER_STOPPED: &str = "updater_stopped";
pub const EVENT_NEW_VERSION_AVAILABLE: &str = "new_version_available";
pub const EVENT_DOWNLOADING: &str = "downloading";
pub const EVENT_DOWNLOAD_VERIFIED: &str = "download_verified";
pub const EVENT_DEPLOYED: &str = "deployed";
pub const EVENT_COLLECTOR_RESTARTED: &str = "collector_restarted";
pub const EVENT_UPDATE_FAILURE: &str = "update_failure";
pub const EVENT_UPDATER_STOPPED_MAX_FAILURES: &str = "updater_stopped_max_failures";

#[derive(Clone, Debug, Default)]
pub struct UpdaterEventExtra {
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub error: Option<String>,
    pub consecutive_failures: Option<u32>,
    pub node_bin: Option<String>,
    pub pin: Option<String>,
}

pub type AlarmSender = Arc<dyn Fn(&str, &IndexMap<String, String>) + Send + Sync>;

pub struct UpdaterMetrics {
    logs_dir: String,
    data_dir: String,
    version: String,
    ip: String,
    user_id: String,
    collector_pid_file: String,
    collector_liveness: ProcessLivenessProbe,
    date_string: Arc<dyn Fn() -> String + Send + Sync>,
    now_ms: Arc<dyn Fn() -> u128 + Send + Sync>,
    alarm_sender: AlarmSender,
    event_queue: Mutex<Vec<Value>>,
    alarm_queue: Mutex<Vec<Value>>,
    user_id_alarm_emitted: AtomicBool,
    started_at: Mutex<u128>,
    collector_consecutive_failures: Mutex<u32>,
    last_collector_alarm_at: Mutex<u128>,
}

pub struct UpdaterMetricsOptions {
    pub data_dir: String,
    pub version: String,
    pub collector_pid_file: String,
    pub user_id: String,
    pub collector_liveness: Option<ProcessLivenessProbe>,
    pub date_string: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    pub now_ms: Option<Arc<dyn Fn() -> u128 + Send + Sync>>,
    pub alarm_sender: Option<AlarmSender>,
    pub ip: Option<String>,
}

impl UpdaterMetrics {
    pub fn new(opts: UpdaterMetricsOptions) -> Self {
        let liveness = opts.collector_liveness.unwrap_or_else(|| {
            Arc::new(|pid_file: &str| check_process_liveness(pid_file, COLLECTOR_PROCESS_PATTERNS))
        });
        Self {
            logs_dir: Path::new(&opts.data_dir)
                .join("logs")
                .join("metric_alarm")
                .to_string_lossy()
                .into_owned(),
            data_dir: opts.data_dir,
            version: opts.version,
            ip: opts.ip.unwrap_or_else(resolve_local_ip),
            user_id: opts.user_id,
            collector_pid_file: opts.collector_pid_file,
            collector_liveness: liveness,
            date_string: opts
                .date_string
                .unwrap_or_else(|| Arc::new(get_today_date_string)),
            now_ms: opts.now_ms.unwrap_or_else(|| Arc::new(now_millis)),
            alarm_sender: opts
                .alarm_sender
                .unwrap_or_else(|| Arc::new(crate::internal::sender::send_alarm)),
            event_queue: Mutex::new(Vec::new()),
            alarm_queue: Mutex::new(Vec::new()),
            user_id_alarm_emitted: AtomicBool::new(false),
            started_at: Mutex::new(0),
            collector_consecutive_failures: Mutex::new(0),
            last_collector_alarm_at: Mutex::new(0),
        }
    }

    pub async fn start(&self) {
        *self
            .started_at
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = (self.now_ms)();
        ensure_dir(&self.logs_dir).await;
        self.check_collector_health();
    }

    pub async fn stop(&self) {
        self.flush().await;
    }

    pub fn write_event(&self, event_type: &str, extra: UpdaterEventExtra) {
        let mut event = Map::new();
        event.insert("event_type".into(), Value::String(event_type.to_string()));
        event.insert("version".into(), Value::String(self.version.clone()));
        insert_opt(&mut event, "current_version", extra.current_version);
        insert_opt(&mut event, "latest_version", extra.latest_version);
        insert_opt(&mut event, "error", extra.error);
        if let Some(count) = extra.consecutive_failures {
            event.insert("consecutive_failures".into(), Value::from(count));
        }
        insert_opt(&mut event, "node_bin", extra.node_bin);
        insert_opt(&mut event, "pin", extra.pin);
        event.insert("user_id".into(), Value::String(self.user_id.clone()));
        event.insert("ip".into(), Value::String(self.ip.clone()));
        event.insert("__time__".into(), Value::from(self.unix_time()));
        self.event_queue
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(Value::Object(event));
    }

    pub fn write_alarm(&self, alarm_type: &str, level: &str, message: &str) {
        let mut alarm = Map::new();
        alarm.insert("alarm_type".into(), Value::String(alarm_type.to_string()));
        alarm.insert("alarm_level".into(), Value::String(level.to_string()));
        alarm.insert("alarm_message".into(), Value::String(message.to_string()));
        alarm.insert("alarm_count".into(), Value::String("1".to_string()));
        alarm.insert("user_id".into(), Value::String(self.user_id.clone()));
        alarm.insert("ip".into(), Value::String(self.ip.clone()));
        alarm.insert("ver".into(), Value::String(self.version.clone()));
        alarm.insert("__time__".into(), Value::from(self.unix_time()));
        self.alarm_queue
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(Value::Object(alarm));
    }

    pub async fn flush(&self) {
        if !self.user_id_alarm_emitted.load(Ordering::SeqCst) && is_braced_user_id(&self.user_id) {
            self.user_id_alarm_emitted.store(true, Ordering::SeqCst);
            self.write_alarm(
                "USER_ID_FORMAT_ALARM",
                "1",
                &format!(
                    "userId \"{}\" contains braces, expected plain number like \"123456\"",
                    self.user_id
                ),
            );
        }
        let events = std::mem::take(
            &mut *self
                .event_queue
                .lock()
                .unwrap_or_else(|err| err.into_inner()),
        );
        let alarms = std::mem::take(
            &mut *self
                .alarm_queue
                .lock()
                .unwrap_or_else(|err| err.into_inner()),
        );
        if events.is_empty() && alarms.is_empty() {
            return;
        }
        let day = (self.date_string)();
        if !events.is_empty() {
            let file_path =
                Path::new(&self.logs_dir).join(format!("pilot-updater-events-{day}.jsonl"));
            for event in &events {
                append_line(&file_path.to_string_lossy(), &event.to_string()).await;
            }
        }
        if !alarms.is_empty() {
            let file_path = Path::new(&self.logs_dir).join(format!("pilot-alarms-{day}.jsonl"));
            for alarm in &alarms {
                append_line(&file_path.to_string_lossy(), &alarm.to_string()).await;
                if let Some(object) = alarm.as_object() {
                    let flat = flatten_to_strings(object);
                    (self.alarm_sender)("pilot_alarm", &flat);
                }
            }
        }
    }

    pub fn check_collector_health(&self) {
        let liveness = (self.collector_liveness)(&self.collector_pid_file);
        let mut failures = self
            .collector_consecutive_failures
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if liveness.running {
            *failures = 0;
            return;
        }
        let now = (self.now_ms)();
        let started = *self
            .started_at
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if now.saturating_sub(started) < COLLECTOR_HEALTH_STARTUP_GRACE_MS as u128 {
            return;
        }
        *failures += 1;
        let count = *failures;
        if count < COLLECTOR_HEALTH_FAILURE_THRESHOLD {
            return;
        }
        let mut last = self
            .last_collector_alarm_at
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if now.saturating_sub(*last) < COLLECTOR_HEALTH_ALARM_COOLDOWN_MS as u128 {
            return;
        }
        *last = now;
        drop(last);
        drop(failures);
        self.write_alarm(
            "SERVICE_NOT_RUNNING_ALARM",
            "3",
            &self.build_not_running_message(&liveness.reason, count),
        );
    }

    fn build_not_running_message(&self, liveness_reason: &str, failures: u32) -> String {
        let base = format!("loongsuite-pilot collector process is not running after {failures} checks: {liveness_reason}");
        let Some(breadcrumb) = read_startup_crash(&self.data_dir) else {
            return base;
        };
        let classified = classify_startup_crash(&breadcrumb);
        format!(
            "{base} | cause={} detail=\"{}\" phase={} version={}",
            classified.reason.as_str(),
            classified.detail_head,
            breadcrumb.phase,
            breadcrumb.version
        )
    }

    fn unix_time(&self) -> u64 {
        ((self.now_ms)() / 1000) as u64
    }
}

fn insert_opt(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.to_string(), Value::String(value));
    }
}

fn is_braced_user_id(user_id: &str) -> bool {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(r"^\{.*\}$").expect("user id braces"))
        .is_match(user_id)
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Silence an unused import warning if a caller only needs the pattern constant.
#[allow(dead_code)]
fn _patterns(patterns: &[ProcessCommandPattern<'_>]) -> usize {
    let _ = create_logger("UpdaterMetrics");
    patterns.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::{PidFileState, ProcessLiveness, ProcessLivenessSource};
    use std::sync::Mutex;

    fn down(reason: &str) -> ProcessLiveness {
        ProcessLiveness {
            running: false,
            pid: None,
            source: ProcessLivenessSource::None,
            reason: reason.to_string(),
            pid_file_state: Some(PidFileState::Missing),
            pid_file_process_alive: None,
            pid_file_command: None,
            pid_file_command_matched: None,
        }
    }

    type RecordedAlarms = Arc<Mutex<Vec<(String, IndexMap<String, String>)>>>;

    struct Harness {
        dir: tempfile::TempDir,
        alarms: RecordedAlarms,
        now: Arc<Mutex<u128>>,
    }

    impl Harness {
        fn new() -> Self {
            Self {
                dir: tempfile::tempdir().unwrap(),
                alarms: Arc::new(Mutex::new(Vec::new())),
                // Vitest fake timers start at the wall clock. `lastCollectorAlarmAt`
                // begins at 0, and the one-hour cooldown is `now - last`. A clock
                // inside that first hour suppresses the first alarm in both ports.
                now: Arc::new(Mutex::new(1_700_000_000_000)),
            }
        }

        fn metrics(&self, user_id: &str, liveness: Option<ProcessLivenessProbe>) -> UpdaterMetrics {
            let sent = self.alarms.clone();
            let now = self.now.clone();
            UpdaterMetrics::new(UpdaterMetricsOptions {
                data_dir: self.dir.path().to_string_lossy().into_owned(),
                version: "1.0.0".into(),
                collector_pid_file: self
                    .dir
                    .path()
                    .join("loongsuite-pilot.pid")
                    .to_string_lossy()
                    .into_owned(),
                user_id: user_id.into(),
                collector_liveness: liveness,
                date_string: Some(Arc::new(|| "2026-09-02".to_string())),
                now_ms: Some(Arc::new(move || *now.lock().unwrap())),
                alarm_sender: Some(Arc::new(move |topic, fields| {
                    sent.lock()
                        .unwrap()
                        .push((topic.to_string(), fields.clone()));
                })),
                ip: Some("127.0.0.1".into()),
            })
        }
    }

    fn read_lines(dir: &std::path::Path, prefix: &str) -> Vec<Value> {
        let path = dir
            .join("logs")
            .join("metric_alarm")
            .join(format!("{prefix}-2026-09-02.jsonl"));
        let text = std::fs::read_to_string(path).unwrap_or_default();
        text.lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn writes_events_and_alarms_without_status_rows() {
        let harness = Harness::new();
        let metrics = harness.metrics("user-123", Some(Arc::new(|_| down("pid file is missing"))));
        metrics.start().await;
        metrics.write_event(
            EVENT_NEW_VERSION_AVAILABLE,
            UpdaterEventExtra {
                current_version: Some("1.0.0".into()),
                latest_version: Some("1.0.1".into()),
                ..UpdaterEventExtra::default()
            },
        );
        metrics.write_event(
            EVENT_UPDATE_FAILURE,
            UpdaterEventExtra {
                error: Some("download timeout".into()),
                consecutive_failures: Some(3),
                ..UpdaterEventExtra::default()
            },
        );
        metrics.write_alarm("UPDATER_FAILURE_ALARM", "2", "update failed");
        metrics.stop().await;

        let events = read_lines(harness.dir.path(), "pilot-updater-events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["current_version"], "1.0.0");
        assert_eq!(events[0]["user_id"], "user-123");
        assert!(events[0]["__time__"].is_number());
        assert_eq!(events[1]["error"], "download timeout");
        assert_eq!(events[1]["consecutive_failures"], 3);

        let alarms = read_lines(harness.dir.path(), "pilot-alarms");
        assert_eq!(alarms.len(), 1);
        assert_eq!(alarms[0]["alarm_type"], "UPDATER_FAILURE_ALARM");
        assert_eq!(alarms[0]["alarm_level"], "2");
        assert_eq!(alarms[0]["alarm_count"], "1");
        assert_eq!(alarms[0]["ver"], "1.0.0");
        let sent = harness.alarms.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "pilot_alarm");
        assert!(!sent[0].1.contains_key("__topic__"));
    }

    #[tokio::test]
    async fn emits_braced_user_id_alarm_once() {
        let harness = Harness::new();
        let metrics = harness.metrics("{123456}", Some(Arc::new(|_| down("pid file is missing"))));
        metrics.start().await;
        metrics.flush().await;
        metrics.flush().await;
        let alarms = read_lines(harness.dir.path(), "pilot-alarms");
        let format_alarms: Vec<_> = alarms
            .iter()
            .filter(|alarm| alarm["alarm_type"] == "USER_ID_FORMAT_ALARM")
            .collect();
        assert_eq!(format_alarms.len(), 1);
        assert_eq!(format_alarms[0]["alarm_level"], "1");
        assert!(format_alarms[0]["alarm_message"]
            .as_str()
            .unwrap()
            .contains("{123456}"));

        let plain = Harness::new();
        let metrics = plain.metrics("123456", Some(Arc::new(|_| down("pid file is missing"))));
        metrics.start().await;
        metrics.stop().await;
        let alarms = read_lines(plain.dir.path(), "pilot-alarms");
        assert!(alarms
            .iter()
            .all(|alarm| alarm["alarm_type"] != "USER_ID_FORMAT_ALARM"));
    }

    #[tokio::test]
    async fn suppresses_service_alarm_during_grace_then_requires_two_misses() {
        let harness = Harness::new();
        let metrics = harness.metrics(
            "test-user",
            Some(Arc::new(|_| down("no matching collector command found"))),
        );
        metrics.start().await;
        metrics.stop().await;
        assert!(read_lines(harness.dir.path(), "pilot-alarms").is_empty());

        *harness.now.lock().unwrap() += (3 * 60_000 + 60_000) as u128;
        metrics.check_collector_health();
        *harness.now.lock().unwrap() += 60_000;
        metrics.check_collector_health();
        metrics.flush().await;
        let alarms = read_lines(harness.dir.path(), "pilot-alarms");
        assert_eq!(alarms.len(), 1);
        assert_eq!(alarms[0]["alarm_type"], "SERVICE_NOT_RUNNING_ALARM");
        assert!(alarms[0]["alarm_message"]
            .as_str()
            .unwrap()
            .contains("no matching collector command found"));

        *harness.now.lock().unwrap() += 60_000;
        metrics.check_collector_health();
        metrics.flush().await;
        assert_eq!(read_lines(harness.dir.path(), "pilot-alarms").len(), 1);
    }

    #[tokio::test]
    async fn enriches_not_running_alarm_from_startup_crash() {
        let harness = Harness::new();
        let crash = harness
            .dir
            .path()
            .join("logs")
            .join("last-startup-crash.json");
        std::fs::create_dir_all(crash.parent().unwrap()).unwrap();
        std::fs::write(
            &crash,
            r#"{"schema":1,"ts":1,"phase":"module_load","version":"9.9.9","pid":1,"error_message":"Cannot open sqlite3 binding","error_stack_head":"Error: Cannot open sqlite3 binding"}
"#,
        )
        .unwrap();
        let metrics = harness.metrics(
            "test-user",
            Some(Arc::new(|_| down("no matching collector command found"))),
        );
        metrics.start().await;
        *harness.now.lock().unwrap() += (3 * 60_000 + 60_000) as u128;
        metrics.check_collector_health();
        *harness.now.lock().unwrap() += 60_000;
        metrics.check_collector_health();
        metrics.flush().await;
        let alarms = read_lines(harness.dir.path(), "pilot-alarms");
        assert_eq!(alarms.len(), 1);
        assert_eq!(alarms[0]["alarm_type"], "SERVICE_NOT_RUNNING_ALARM");
        let message = alarms[0]["alarm_message"].as_str().unwrap();
        assert!(message.contains("no matching collector command found"));
        assert!(message.contains("cause=native_module_missing"));
        assert!(message.contains("version=9.9.9"));
    }

    #[tokio::test]
    async fn resets_failures_when_process_identity_recovers() {
        let healthy = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = healthy.clone();
        let liveness = Arc::new(move |_pid: &str| {
            if flag.load(std::sync::atomic::Ordering::SeqCst) {
                ProcessLiveness {
                    running: true,
                    pid: Some(456),
                    source: ProcessLivenessSource::ProcessScan,
                    reason: "matching process command found".into(),
                    pid_file_state: None,
                    pid_file_process_alive: None,
                    pid_file_command: None,
                    pid_file_command_matched: None,
                }
            } else {
                down("no matching collector command found")
            }
        });
        let harness = Harness::new();
        let metrics = harness.metrics("test-user", Some(liveness));
        metrics.start().await;
        *harness.now.lock().unwrap() += 3 * 60_000;
        metrics.check_collector_health();
        healthy.store(true, std::sync::atomic::Ordering::SeqCst);
        metrics.check_collector_health();
        *harness.now.lock().unwrap() += 60_000;
        metrics.check_collector_health();
        metrics.flush().await;
        assert!(read_lines(harness.dir.path(), "pilot-alarms").is_empty());
    }
    include!("updater_metrics_history_tests.rs");
}
