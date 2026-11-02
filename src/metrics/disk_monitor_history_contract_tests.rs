//! Exact legacy integration contracts through native sampler, writer, sender and JSONL.
use super::*;
use crate::internal::{clear_sends, recorded_sends};
use crate::metrics::disk_usage_sampler::DiskUsageStatus;
use serde_json::json;

struct Fixture {
    root: tempfile::TempDir,
    data: PathBuf,
    writer: MetricsWriter,
}
impl Fixture {
    fn new() -> Self {
        clear_sends();
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("自定义目录");
        std::fs::create_dir_all(data.join("logs")).unwrap();
        std::fs::write(data.join(".hidden-state"), "abc").unwrap();
        std::fs::write(data.join("logs").join("collector.log"), "12345").unwrap();
        let mut opts = MetricsWriterOptions::new(
            data.to_string_lossy(),
            "1.2.0",
            "disk-test",
            DataflowSnapshot::default,
        );
        opts.alarm_manager = Some(AlarmManager::new("127.0.0.1", "1.2.0", "disk-test"));
        opts.runtime_probe = Some(RuntimeProbe {
            exec_path: root.path().join("missing-controlled-native-bin"),
            cache_dir: Some(root.path().to_path_buf()),
        });
        Self {
            root,
            data,
            writer: MetricsWriter::new(opts),
        }
    }
    fn metric_row(&self) -> Value {
        let sent = recorded_sends();
        let row = sent.iter().find(|row| row.topic == "pilot_status").unwrap();
        serde_json::from_str(&row.fields["metric_json"]).unwrap()
    }
    fn assert_metrics(&self, status: &str, sampled_at: i64) {
        let row = self.metric_row();
        for (key, expected) in [
            ("disk_dir_status", status.to_owned()),
            ("disk_data_bytes", "8".to_owned()),
            ("disk_logs_bytes", "5".to_owned()),
            ("disk_dir_sampled_at", iso_millis(sampled_at)),
        ] {
            assert_eq!(row[key], expected, "{key}");
        }
    }
}

#[tokio::test]
async fn source_l52_unicode_real_tree_reaches_status_local_jsonl_and_running_status() {
    let f = Fixture::new();
    f.writer.sampler().sample().await;
    let sample = f.writer.sampler().get_snapshot();
    assert_eq!(sample.status, DiskUsageStatus::Ok);
    assert_eq!(sample.data_bytes, Some(8));
    assert_eq!(sample.logs_bytes, Some(5));
    let sampled_at = sample.sampled_at.unwrap();
    // This is an actual completed walk, before the writer schedules its first30s sample.
    assert!(!f.writer.sampler().opened_directories().is_empty());
    f.writer.start().await;
    f.assert_metrics("ok", sampled_at);
    let dir = f.data.join("logs").join("metric_alarm");
    let mirror = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|file| {
            let name = file.file_name().unwrap().to_string_lossy();
            name.starts_with("pilot-metrics-") && name.ends_with(".jsonl")
        })
        .expect("real local L1 JSONL mirror");
    let text = std::fs::read_to_string(mirror).unwrap();
    let first: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(first["metric_json"]["disk_data_bytes"], "8");
    let sends = recorded_sends();
    let running: Vec<_> = sends.iter().filter(|row| row.kind == "running").collect();
    assert_eq!(running.len(), 1);
    let metrics: Value = serde_json::from_str(&running[0].fields["metric_json"]).unwrap();
    for (k,v) in json!({"disk_dir_status":"ok","disk_data_bytes":"8","disk_logs_bytes":"5","disk_dir_sampled_at":iso_millis(sampled_at)}).as_object().unwrap() {assert_eq!(&metrics[k],v);}
    assert!(f.metric_row().get("disk_available_bytes").is_none());
    f.writer.stop().await;
    assert!(!f.writer.sampler().test_is_scheduled());
}

#[tokio::test]
async fn source_l79_real_failed_rescan_preserves_complete_sizes_and_time_without_false_alarm() {
    let f = Fixture::new();
    f.writer.sampler().sample().await;
    let good = f.writer.sampler().get_snapshot();
    assert_eq!(good.data_bytes, Some(8));
    assert_eq!(good.logs_bytes, Some(5));
    std::fs::rename(&f.data, f.root.path().join("moved-installation")).unwrap();
    f.writer.sampler().sample().await;
    let failed = f.writer.sampler().get_snapshot();
    assert_eq!(failed.status, DiskUsageStatus::Error);
    assert_eq!(failed.data_bytes, Some(8));
    assert_eq!(failed.logs_bytes, Some(5));
    assert_eq!(failed.sampled_at, good.sampled_at);
    f.writer.start().await;
    f.assert_metrics("error", good.sampled_at.unwrap());
    f.writer.stop().await;
    assert!(!recorded_sends().iter().any(|row| row.kind == "alarm"
        && row
            .fields
            .get("alarm_type")
            .is_some_and(|kind| kind == "DISK_USAGE_ALARM")));
    assert!(!f.writer.sampler().test_is_scheduled());
}
