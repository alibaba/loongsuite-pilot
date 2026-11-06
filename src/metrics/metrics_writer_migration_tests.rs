//! Legacy disk-monitoring contracts through actual writer and sampler APIs.
//! Sender records use the existing cfg(test) adapter: no private destination is read.
use super::*;
use crate::internal::{clear_sends, recorded_sends};
use crate::metrics::disk_usage_sampler::DiskUsageStatus;
use serde_json::json;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::task::Poll;

const GIB: u64 = 1024 * 1024 * 1024;
struct Harness {
    root: tempfile::TempDir,
    now: Arc<AtomicI64>,
    writer: MetricsWriter,
}
impl Harness {
    fn new() -> Self {
        clear_sends();
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("logs/metric_alarm")).unwrap();
        let now = Arc::new(AtomicI64::new(chrono::Utc::now().timestamp_millis()));
        let clock = now.clone();
        let mut opts = MetricsWriterOptions::new(
            root.path().to_string_lossy(),
            "1.2.0",
            "test-user",
            DataflowSnapshot::default,
        );
        opts.alarm_manager = Some(AlarmManager::new("127.0.0.1", "1.2.0", "test-user"));
        opts.auto_update_enabled = false;
        opts.runtime_probe = Some(RuntimeProbe {
            exec_path: root.path().join("missing-synthetic-bin"),
            cache_dir: Some(root.path().into()),
        });
        opts.now_ms = Some(Arc::new(move || clock.load(Ordering::SeqCst)));
        Self {
            root,
            now,
            writer: MetricsWriter::new(opts),
        }
    }
    fn at(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn advance(&self, minutes: i64) {
        self.now.fetch_add(minutes * 60_000, Ordering::SeqCst);
    }
    fn snapshot(&self, bytes: u64) -> DiskUsageSnapshot {
        DiskUsageSnapshot {
            status: DiskUsageStatus::Ok,
            sampled_at: Some(self.at()),
            scan_ms: Some(2000),
            data_bytes: Some(bytes),
            logs_bytes: Some(bytes.min(GIB)),
        }
    }
    fn accept(&self, snapshot: DiskUsageSnapshot) {
        self.writer.sampler().store_snapshot(snapshot.clone());
        self.writer.observe_disk_sample(snapshot);
    }
    fn complete(&self, bytes: u64) {
        self.accept(self.snapshot(bytes));
    }
    fn disk_alarms(&self) -> Vec<crate::metrics::AlarmEntry> {
        self.writer
            .inner
            .lock()
            .unwrap()
            .alarm_manager
            .as_ref()
            .unwrap()
            .serialize()
            .into_iter()
            .filter(|row| row.alarm_type == "DISK_USAGE_ALARM")
            .collect()
    }
    fn mirror_path(&self, prefix: &str) -> PathBuf {
        self.root
            .path()
            .join("logs/metric_alarm")
            .join(format!("{prefix}-{}.jsonl", get_today_date_string()))
    }
}
fn latest_metrics() -> Value {
    let sends = recorded_sends();
    let row = sends
        .iter()
        .rev()
        .find(|row| row.topic == "pilot_status")
        .unwrap();
    serde_json::from_str(&row.fields["metric_json"]).unwrap()
}
fn fields(actual: &Value, expected: Value) {
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(&actual[key], value, "metric {key}");
    }
}
#[tokio::test]
async fn sampler_lifecycle_reports_pending_without_waiting_for_scan_and_stops_owned_tasks() {
    let h = Harness::new();
    tokio::time::timeout(Duration::from_secs(1), h.writer.start())
        .await
        .unwrap();
    assert_eq!(
        h.writer.sampler().get_snapshot().status,
        DiskUsageStatus::Pending
    );
    assert!(h.writer.sampler().test_is_scheduled());
    assert!(h.writer.sampler().opened_directories().is_empty());
    let row = latest_metrics();
    assert_eq!(row["disk_dir_status"], "pending");
    for key in ["disk_data_bytes", "disk_dir_sampled_at"] {
        assert!(row.get(key).is_none());
    }
    h.writer.stop().await;
    assert!(h.writer.tasks.lock().unwrap().is_empty());
    assert!(!h.writer.sampler().test_is_scheduled());
    h.writer.sampler().sample().await;
    assert!(h.writer.sampler().opened_directories().is_empty());
}
#[tokio::test]
async fn cached_disk_gauges_match_status_and_running_status_and_keep_last_success_on_timeout() {
    let h = Harness::new();
    h.complete(6 * GIB);
    h.writer.write_l1().await;
    let expected = json!({"disk_data_bytes":(6*GIB).to_string(),"disk_logs_bytes":GIB.to_string(),
        "disk_dir_sampled_at":iso_millis(h.at()),"disk_dir_scan_ms":"2000","disk_dir_status":"ok"});
    fields(&latest_metrics(), expected.clone());
    assert!(latest_metrics().get("disk_available_bytes").is_none());
    let sends = recorded_sends();
    let running: Vec<_> = sends.iter().filter(|row| row.kind == "running").collect();
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].fields["version"], "1.2.0");
    fields(
        &serde_json::from_str::<Value>(&running[0].fields["metric_json"]).unwrap(),
        expected,
    );
    let sampled_at = h.at();
    h.advance(10);
    let mut failed = h.snapshot(6 * GIB);
    failed.status = DiskUsageStatus::Timeout;
    failed.sampled_at = Some(sampled_at);
    failed.scan_ms = Some(60_000);
    h.accept(failed);
    h.writer.write_l1().await;
    fields(
        &latest_metrics(),
        json!({"disk_data_bytes":(6*GIB).to_string(),"disk_dir_scan_ms":"60000",
        "disk_dir_sampled_at":iso_millis(sampled_at),"disk_dir_status":"timeout"}),
    );
    assert!(h.disk_alarms().is_empty());
}
#[tokio::test]
async fn metric_reports_do_not_count_as_samples_and_normal_samples_reset_the_streak() {
    let h = Harness::new();
    h.complete(6 * GIB);
    for _ in 0..3 {
        h.writer.write_l1().await;
    }
    assert!(h.disk_alarms().is_empty());
    h.advance(10);
    h.complete(6 * GIB);
    assert_eq!(h.disk_alarms()[0].alarm_level, "2");
    let h = Harness::new();
    for bytes in [6 * GIB, 5 * GIB, 6 * GIB] {
        h.complete(bytes);
        h.advance(10);
    }
    assert!(h.disk_alarms().is_empty());
    h.complete(6 * GIB);
    assert_eq!(h.disk_alarms().len(), 1);
}
#[test]
fn exact_disk_thresholds_keep_five_and_ten_gib_boundary_semantics() {
    for (bytes, level) in [
        (5 * GIB, None),
        (5 * GIB + 1, Some("2")),
        (10 * GIB, Some("2")),
        (10 * GIB + 1, Some("3")),
    ] {
        let h = Harness::new();
        h.complete(bytes);
        if level == Some("3") {
            assert_eq!(h.disk_alarms()[0].alarm_level, "3");
            continue;
        }
        assert!(h.disk_alarms().is_empty());
        h.advance(10);
        h.complete(bytes);
        let alarms = h.disk_alarms();
        assert_eq!(alarms.len(), usize::from(level.is_some()));
        if let Some(level) = level {
            assert_eq!(alarms[0].alarm_level, level);
        }
    }
}
#[test]
fn non_ok_statuses_cannot_alarm_and_reset_consecutive_sample_state() {
    for status in [
        DiskUsageStatus::Pending,
        DiskUsageStatus::Partial,
        DiskUsageStatus::Timeout,
        DiskUsageStatus::Error,
        DiskUsageStatus::Stale,
    ] {
        let h = Harness::new();
        h.complete(6 * GIB);
        h.advance(10);
        let mut sample = h.snapshot(11 * GIB);
        sample.status = status;
        h.accept(sample);
        h.advance(10);
        h.complete(6 * GIB);
        assert!(h.disk_alarms().is_empty());
        h.advance(10);
        h.complete(6 * GIB);
        assert_eq!(h.disk_alarms().len(), 1);
    }
}
#[test]
fn duplicate_out_of_order_expired_and_freshness_gap_samples_do_not_create_false_alarms() {
    let h = Harness::new();
    h.complete(6 * GIB);
    h.complete(6 * GIB);
    let mut sample = h.snapshot(6 * GIB);
    sample.sampled_at = Some(h.at() - 1);
    h.accept(sample);
    assert!(h.disk_alarms().is_empty());
    h.advance(10);
    h.complete(6 * GIB);
    assert_eq!(h.disk_alarms().len(), 1);
    let h = Harness::new();
    let mut expired = h.snapshot(11 * GIB);
    expired.sampled_at = Some(h.at() - 20 * 60_000 - 1);
    h.accept(expired);
    assert!(h.disk_alarms().is_empty());
    h.complete(6 * GIB);
    h.advance(21);
    h.complete(6 * GIB);
    assert!(h.disk_alarms().is_empty());
    h.advance(10);
    h.complete(6 * GIB);
    assert_eq!(h.disk_alarms().len(), 1);
}
#[test]
fn invalid_snapshot_fields_never_emit_a_disk_alarm() {
    let future = chrono::DateTime::parse_from_rfc3339("2099-01-01T00:00:00Z")
        .unwrap()
        .timestamp_millis();
    for (key, value) in [
        ("data_bytes", json!(f64::NAN)),
        ("data_bytes", json!(-1)),
        ("data_bytes", json!(f64::INFINITY)),
        ("logs_bytes", json!(-1)),
        ("logs_bytes", json!(12 * GIB)),
        ("sampled_at", json!(f64::NAN)),
        ("sampled_at", json!(future)),
        ("sampled_at", Value::Null),
    ] {
        let h = Harness::new();
        let mut snapshot = serde_json::to_value(h.snapshot(11 * GIB)).unwrap();
        snapshot[key] = value;
        match serde_json::from_value::<DiskUsageSnapshot>(snapshot) {
            Ok(snapshot) => h.accept(snapshot),
            // Unsigned native counters reject signed/non-number JSON at the
            // actual snapshot boundary; no invalid sample is delivered.
            Err(error) => assert!(key == "data_bytes" || key == "logs_bytes", "{error}"),
        }
        assert!(h.disk_alarms().is_empty());
    }
}
#[test]
fn escalation_is_immediate_and_reminders_remain_per_level_and_hourly() {
    let h = Harness::new();
    h.complete(6 * GIB);
    h.advance(10);
    h.complete(6 * GIB);
    assert_eq!(h.disk_alarms()[0].alarm_level, "2");
    h.advance(10);
    h.complete(11 * GIB);
    let alarms = h.disk_alarms();
    assert_eq!(alarms[0].alarm_level, "3");
    assert!(alarms[0]
        .alarm_message
        .contains(&format!("logs {GIB} bytes")));
    assert!(alarms[0].alarm_message.contains(&iso_millis(h.at())));
    for _ in 0..5 {
        h.advance(10);
        h.complete(11 * GIB);
        assert!(h.disk_alarms().is_empty());
    }
    h.advance(10);
    h.complete(11 * GIB);
    assert_eq!(h.disk_alarms()[0].alarm_level, "3");
    let h = Harness::new();
    let mut minutes = Vec::new();
    for i in 0..9 {
        h.complete(6 * GIB);
        if !h.disk_alarms().is_empty() {
            minutes.push(i * 10);
        }
        h.advance(10);
    }
    assert_eq!(minutes, vec![10, 70]);
}
#[tokio::test]
async fn thirty_second_alarm_drain_is_independent_of_the_l1_cycle() {
    assert_eq!(ALARM_FLUSH_INTERVAL, Duration::from_secs(30));
    let h = Harness::new();
    h.writer
        .start_with_intervals(DATAFLOW_INTERVAL, Duration::from_millis(2))
        .await;
    h.complete(11 * GIB);
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if recorded_sends().iter().any(|row| {
                row.topic == "pilot_alarm" && row.fields["alarm_type"] == "DISK_USAGE_ALARM"
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        recorded_sends()
            .iter()
            .filter(|row| row.topic == "pilot_status")
            .count(),
        1
    );
    h.writer.stop().await;
}

// Block the only filesystem worker. Pending native append I/O is then a
// deterministic ordering barrier, without mocking the implementation or sleeping.
struct Release(Option<std::sync::mpsc::Sender<()>>);
impl Release {
    fn now(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}
impl Drop for Release {
    fn drop(&mut self) {
        self.now();
    }
}
async fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    let mut future = future;
    std::future::poll_fn(|cx| Poll::Ready(future.as_mut().poll(cx))).await
}
fn blocked_io() -> (tokio::runtime::Runtime, Release) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (ready, entered) = std::sync::mpsc::channel();
    let (release, wait) = std::sync::mpsc::channel();
    rt.spawn_blocking(move || {
        ready.send(()).unwrap();
        let _ = wait.recv();
    });
    entered.recv_timeout(Duration::from_secs(3)).unwrap();
    (rt, Release(Some(release)))
}
#[test]
fn running_status_is_sent_before_native_local_metrics_failure() {
    let (rt, mut release) = blocked_io();
    let h = Harness::new();
    h.complete(6 * GIB);
    std::fs::create_dir(h.mirror_path("pilot-metrics")).unwrap();
    rt.block_on(async {
        let mut write = Box::pin(h.writer.write_l1());
        assert!(poll_once(write.as_mut()).await.is_pending());
        let sends = recorded_sends();
        let running: Vec<_> = sends.iter().filter(|row| row.kind == "running").collect();
        assert_eq!(
            running.len(),
            1,
            "running status must precede the blocked local append"
        );
        let metric: Value = serde_json::from_str(&running[0].fields["metric_json"]).unwrap();
        assert_eq!(metric["disk_data_bytes"], (6 * GIB).to_string());
        release.now();
        write.await;
    });
    assert!(h.mirror_path("pilot-metrics").is_dir());
}
#[test]
fn every_pending_alarm_is_sent_before_native_local_alarm_failure() {
    let (rt, mut release) = blocked_io();
    let h = Harness::new();
    h.complete(11 * GIB);
    h.writer
        .inner
        .lock()
        .unwrap()
        .alarm_manager
        .as_ref()
        .unwrap()
        .record("PROCESS_CPU_ALARM", "2", "CPU test", None);
    std::fs::create_dir(h.mirror_path("pilot-alarms")).unwrap();
    rt.block_on(async {
        let mut write = Box::pin(h.writer.write_alarms());
        assert!(poll_once(write.as_mut()).await.is_pending());
        assert_eq!(
            recorded_sends()
                .iter()
                .filter(|row| row.kind == "alarm")
                .count(),
            2,
            "all outbound alarms must precede the blocked first local append"
        );
        release.now();
        write.await;
    });
    assert!(h.mirror_path("pilot-alarms").is_dir());
}
