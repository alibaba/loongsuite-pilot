//! Historical writer assertions, using actual sender recording and local mirrors.
use super::*;
use crate::internal::{clear_sends, recorded_sends};
use crate::utils::{PidFileState, ProcessLiveness, ProcessLivenessSource};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

struct H {
    root: tempfile::TempDir,
    clock: Arc<AtomicI64>,
    writer: MetricsWriter,
}
impl H {
    fn new() -> Self {
        Self::with(|_| {})
    }
    fn with(configure: impl FnOnce(&mut MetricsWriterOptions)) -> Self {
        clear_sends();
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("logs")).unwrap();
        let clock = Arc::new(AtomicI64::new(1784073600000));
        let time = Arc::clone(&clock);
        let mut opts = MetricsWriterOptions::new(
            root.path().to_string_lossy(),
            "2.0.0",
            "u1",
            super::tests::snapshot,
        );
        opts.alarm_manager = Some(AlarmManager::new("127.0.0.1", "2.0.0", "test-user"));
        opts.auto_update_enabled = false;
        opts.runtime_probe = Some(RuntimeProbe {
            exec_path: root.path().join("missing-controlled-runtime"),
            cache_dir: Some(root.path().to_path_buf()),
        });
        opts.now_ms = Some(Arc::new(move || time.load(Ordering::SeqCst)));
        configure(&mut opts);
        Self {
            root,
            clock,
            writer: MetricsWriter::new(opts),
        }
    }
    fn at(&self, delta: i64) {
        self.clock.store(1784073600000 + delta, Ordering::SeqCst);
    }
    fn alarms(&self) -> Vec<crate::metrics::AlarmEntry> {
        self.writer
            .inner
            .lock()
            .unwrap()
            .alarm_manager
            .as_ref()
            .unwrap()
            .serialize()
    }
    fn alarm(&self, kind: &str) -> Option<crate::metrics::AlarmEntry> {
        self.alarms().into_iter().find(|a| a.alarm_type == kind)
    }
    fn mirror(&self, prefix: &str) -> PathBuf {
        self.root
            .path()
            .join("logs")
            .join("metric_alarm")
            .join(format!("{prefix}-{}.jsonl", get_today_date_string()))
    }
    fn first(&self, prefix: &str) -> Value {
        serde_json::from_str(
            std::fs::read_to_string(self.mirror(prefix))
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap()
    }
}
fn pipeline() -> Vec<crate::internal::RecordedSend> {
    recorded_sends()
        .into_iter()
        .filter(|s| s.topic == "pilot_pipeline")
        .collect()
}
fn assert_fields(row: &Value, expected: Value) {
    for (k, v) in expected.as_object().unwrap() {
        assert_eq!(&row[k], v, "{k}");
    }
}
fn assert_string_fields(row: &indexmap::IndexMap<String, String>, expected: Value) {
    for (k, v) in expected.as_object().unwrap() {
        assert_eq!(row.get(k).map(String::as_str), v.as_str(), "{k}");
    }
}
fn trace() -> TraceRuntimeSnapshot {
    TraceRuntimeSnapshot {
        agent_type: "codex".into(),
        pending_buffers: 1,
        pending_records: 2,
        pending_logical_bytes: 100,
        pending_unmeasured_records: 0,
        largest_buffer_logical_bytes: 100,
        largest_buffer_records: 2,
        largest_buffer_age_ms: 60000,
        largest_buffer_turn_id: Some("turn".into()),
        largest_buffer_session_id: Some("session".into()),
        oldest_buffer_age_ms: 60000,
        removed_buffers_total: 3,
        removed_logical_bytes_total: 400,
        removed_unmeasured_records_total: 0,
        converter_calls_total: 3,
        converter_duration_ms_total: 12,
        converter_failed_total: 0,
    }
}

#[tokio::test]
async fn source_l119_l145_l394_l1_start_preserves_identity_fields_and_legacy_absences() {
    let h = H::with(|opts| {
        opts.agents_config=serde_json::from_value(json!({"cursor":{"captureMessageContent":true},"qoder":{"captureMessageContent":false}})).unwrap()
    });
    h.writer.start().await;
    let entry = h.first("pilot-metrics");
    assert_fields(
        &entry,
        json!({"version":"2.0.0","user_id":"u1","capture_message_disabled_agents":""}),
    );
    assert_eq!(entry["metric_json"]["agent_count"], "1");
    for key in ["raw_in_records", "raw_in_bytes", "raw_in_max_batch_bytes"] {
        assert!(entry["metric_json"].get(key).is_none());
    }
    let sends = recorded_sends();
    let row = sends.iter().find(|s| s.topic == "pilot_status").unwrap();
    assert_eq!(row.fields["version"], "2.0.0");
    assert!(!row.fields.contains_key("__topic__"));
    assert!(sends.iter().all(|s| ![
        "pilot_input_detail",
        "pilot_flusher_detail",
        "pilot_alarm_metric"
    ]
    .contains(&s.topic.as_str())));
    h.writer.stop().await;
}

#[tokio::test]
async fn source_l172_trace_snapshot_runs_once_in_l1_and_shares_exact_process_identity() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let h = H::with(|opts| {
        opts.version = "test".into();
        opts.get_trace_runtime_snapshot = Some(Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(vec![trace()])
        }));
    });
    h.writer.start().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let sends = recorded_sends();
    let status = sends.iter().find(|s| s.topic == "pilot_status").unwrap();
    let out = sends
        .iter()
        .find(|s| s.topic == "pilot_trace_runtime")
        .unwrap();
    assert_string_fields(
        &out.fields,
        json!({"schema_version":"2","record_type":"snapshot","buffer_scope":"pending_conversion","agent_type":"codex","removed_buffers_total":"3"}),
    );
    for key in ["run_id", "instance_id", "user_id", "version", "__time__"] {
        assert_eq!(out.fields.get(key), status.fields.get(key), "{key}");
    }
    for absent in ["window_ms", "rss_before_convert_bytes"] {
        assert!(!out.fields.contains_key(absent));
    }
    h.writer.stop().await;
}

#[tokio::test]
async fn source_l196_snapshot_and_trace_send_failures_preserve_l1_and_clean_shutdown() {
    for failure in ["snapshot", "send"] {
        let h = H::with(|opts| {
            opts.get_trace_runtime_snapshot = Some(Arc::new(move || {
                if failure == "snapshot" {
                    Err("snapshot unavailable".into())
                } else {
                    Ok(vec![trace()])
                }
            }))
        });
        if failure == "send" {
            crate::internal::inject_send_error("pilot_trace_runtime", "send unavailable");
        }
        h.writer.start().await;
        h.writer.stop().await;
        assert!(h.mirror("pilot-metrics").is_file());
        assert!(!std::fs::read_to_string(h.mirror("pilot-metrics"))
            .unwrap()
            .is_empty());
        assert!(recorded_sends().iter().any(|s| s.topic == "pilot_status"));
    }
    clear_sends();
}

#[tokio::test]
async fn source_l212_l255_pipeline_has_exact_dimensions_then_zero_deltas() {
    let h = H::new();
    h.writer.write_l2().await;
    let rows = pipeline();
    assert_eq!(
        rows.iter()
            .map(|r| r.fields["type"].as_str())
            .collect::<Vec<_>>(),
        ["agent", "input", "flusher"]
    );
    let host = hostname::get().unwrap().to_string_lossy().into_owned();
    assert_eq!(rows[0].fields["hostname"], host);
    assert!(rows[0].fields.contains_key("ip"));
    assert_eq!(rows[2].fields["hostname"], host);
    assert_string_fields(
        &rows[0].fields,
        json!({"agent":"test-agent","in_events":"5"}),
    );
    for absent in ["raw_in_records", "raw_in_bytes", "raw_in_max_batch_bytes"] {
        assert!(!rows[0].fields.contains_key(absent));
    }
    assert_string_fields(
        &rows[1].fields,
        json!({"input_name":"test-input","source_kind":"primary","raw_read_bytes":"2048","parse_failed_records":"1"}),
    );
    assert_string_fields(
        &rows[2].fields,
        json!({"flusher":"sls","project":"proj-a","logstore":"store-a","out_entries":"9"}),
    );
    clear_sends();
    h.writer.write_l2().await;
    let zero = pipeline();
    assert_eq!(
        zero.iter()
            .map(|r| r.fields["type"].as_str())
            .collect::<Vec<_>>(),
        ["agent", "input", "flusher"]
    );
    assert_string_fields(&zero[0].fields, json!({"in_events":"0","in_bytes":"0"}));
    assert_string_fields(
        &zero[1].fields,
        json!({"raw_read_bytes":"0","parse_failed_records":"0"}),
    );
    assert_string_fields(&zero[2].fields, json!({"out_entries":"0","out_bytes":"0"}));
}

#[tokio::test]
async fn source_l280_real_start_stop_mirrors_each_pipeline_row_type() {
    let h = H::new();
    h.writer.start().await;
    h.writer.stop().await;
    assert_fields(
        &h.first("pilot-agent-metrics"),
        json!({"type":"agent","user_id":"u1","agent":"test-agent","in_events":"5"}),
    );
    assert_fields(
        &h.first("pilot-input-metrics"),
        json!({"type":"input","input_name":"test-input","raw_read_calls":"2"}),
    );
    assert_fields(
        &h.first("pilot-flusher-metrics"),
        json!({"type":"flusher","flusher":"sls","logstore":"store-a","out_entries":"9"}),
    );
}

#[tokio::test]
async fn source_l350_failed_final_snapshot_does_not_reject_stop() {
    let fail = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&fail);
    let h = H::with(|opts| {
        opts.get_snapshot = Arc::new(move || {
            if flag.load(Ordering::SeqCst) {
                Err("snapshot exploded".into())
            } else {
                Ok(super::tests::snapshot())
            }
        })
    });
    h.writer.start().await;
    fail.store(true, Ordering::SeqCst);
    h.writer.stop().await;
    assert!(h.writer.tasks.lock().unwrap().is_empty());
    assert!(h.mirror("pilot-metrics").is_file());
}

#[tokio::test]
async fn source_l369_empty_snapshot_creates_no_l2_mirror_including_main_hook_type() {
    let h = H::with(|opts| opts.get_snapshot = Arc::new(|| Ok(DataflowSnapshot::default())));
    h.writer.start().await;
    h.writer.stop().await;
    for prefix in [
        "pilot-agent-metrics",
        "pilot-input-metrics",
        "pilot-flusher-metrics",
        "pilot-hook-metrics",
    ] {
        assert!(!h.mirror(prefix).exists(), "{prefix}");
    }
}

#[test]
fn source_l417_soft_memory_needs_three_consecutive_soft_samples() {
    let h = H::new();
    h.writer.check_thresholds("0", "600");
    h.writer.check_thresholds("0", "620");
    assert!(h.alarm("PROCESS_MEMORY_ALARM").is_none());
    h.writer.check_thresholds("0", "640");
    let alarm = h.alarm("PROCESS_MEMORY_ALARM").unwrap();
    assert_eq!(alarm.alarm_level, "2");
    assert!(alarm.alarm_message.contains("soft threshold 512MB"));
    assert!(alarm.alarm_message.contains("3 consecutive soft samples"));
}
#[test]
fn source_l435_hard_and_critical_memory_alarm_immediately_and_escalate() {
    let h = H::new();
    for (mem, level, threshold, tier) in [
        ("1200", "2", "hard threshold 1024MB", "hard"),
        ("2300", "3", "critical threshold 2048MB", "critical"),
    ] {
        h.writer.check_thresholds("0", mem);
        let alarm = h.alarm("PROCESS_MEMORY_ALARM").unwrap();
        assert_eq!(alarm.alarm_level, level);
        assert!(alarm.alarm_message.contains(threshold));
        assert!(alarm
            .alarm_message
            .contains(&format!("1 consecutive {tier} sample")));
    }
}
#[test]
fn source_l455_soft_streak_does_not_reuse_hard_or_critical_samples() {
    for initial in ["1200", "2300"] {
        let h = H::new();
        h.writer.check_thresholds("0", initial);
        assert!(h.alarm("PROCESS_MEMORY_ALARM").is_some());
        h.at(3_600_001);
        for mem in ["600", "620"] {
            h.writer.check_thresholds("0", mem);
            assert!(h.alarm("PROCESS_MEMORY_ALARM").is_none());
        }
        h.writer.check_thresholds("0", "640");
        let alarm = h.alarm("PROCESS_MEMORY_ALARM").unwrap();
        assert!(alarm.alarm_message.contains("soft threshold 512MB"));
        assert!(alarm.alarm_message.contains("3 consecutive soft samples"));
    }
}
#[test]
fn source_l480_memory_uses_one_cooldown_but_higher_tiers_escalate() {
    let h = H::new();
    for mem in ["600", "620", "640"] {
        h.writer.check_thresholds("0", mem);
    }
    assert!(h
        .alarm("PROCESS_MEMORY_ALARM")
        .unwrap()
        .alarm_message
        .contains("soft threshold 512MB"));
    h.at(1_800_000);
    h.writer.check_thresholds("0", "650");
    assert!(h.alarm("PROCESS_MEMORY_ALARM").is_none());
    h.writer.check_thresholds("0", "1200");
    assert!(h
        .alarm("PROCESS_MEMORY_ALARM")
        .unwrap()
        .alarm_message
        .contains("hard threshold 1024MB"));
    for mem in ["700", "710", "720"] {
        h.writer.check_thresholds("0", mem);
    }
    assert!(h.alarm("PROCESS_MEMORY_ALARM").is_none());
}
#[test]
fn source_l508_l528_cpu_debounce_uses_raw_process_percent_and_exact_message() {
    let h = H::new();
    for _ in 0..2 {
        h.writer.check_thresholds("81", "128");
    }
    assert!(h.alarm("PROCESS_CPU_ALARM").is_none());
    h.writer.check_thresholds("81", "128");
    let alarm = h.alarm("PROCESS_CPU_ALARM").unwrap();
    assert_eq!(alarm.alarm_level, "2");
    assert!(alarm.alarm_message.contains("3 consecutive samples"));
    assert!(alarm.alarm_message.contains("CPU usage 81% exceeds 80%"));
    assert!(!alarm.alarm_message.contains("cores"));
}
#[test]
fn source_l542_cpu_and_memory_are_separate_in_the_same_drain() {
    let h = H::new();
    h.writer.check_thresholds("81", "128");
    h.writer.check_thresholds("81", "128");
    h.writer.check_thresholds("81", "1200");
    let entries = h.alarms();
    let mut kinds = entries
        .iter()
        .map(|a| a.alarm_type.as_str())
        .collect::<Vec<_>>();
    kinds.sort_unstable();
    assert_eq!(kinds, ["PROCESS_CPU_ALARM", "PROCESS_MEMORY_ALARM"]);
    assert!(entries
        .iter()
        .find(|a| a.alarm_type == "PROCESS_CPU_ALARM")
        .unwrap()
        .alarm_message
        .contains("CPU usage"));
    assert!(entries
        .iter()
        .find(|a| a.alarm_type == "PROCESS_MEMORY_ALARM")
        .unwrap()
        .alarm_message
        .contains("Memory usage"));
}
#[test]
fn source_l561_memory_resource_reminder_waits_full_hour() {
    let h = H::new();
    h.writer.check_thresholds("0", "1200");
    assert!(h.alarm("PROCESS_MEMORY_ALARM").is_some());
    h.at(1_800_000);
    h.writer.check_thresholds("0", "1300");
    assert!(h.alarm("PROCESS_MEMORY_ALARM").is_none());
    h.at(3_600_001);
    h.writer.check_thresholds("0", "1300");
    assert!(h.alarm("PROCESS_MEMORY_ALARM").is_some());
}

#[tokio::test]
async fn source_l581_l602_l621_l640_startup_modes_have_original_alarm_contracts() {
    for (init, expected) in [
        (Some("nohup"), true),
        (None, true),
        (Some("launchd"), false),
        (Some("systemd-user"), false),
    ] {
        let h = H::with(|opts| {
            if let Some(value) = init {
                std::fs::write(Path::new(&opts.data_dir).join("init-type"), value).unwrap();
            }
        });
        h.writer.start().await;
        let alarm = h.alarm("DEGRADED_STARTUP_ALARM");
        if expected {
            let alarm = alarm.unwrap();
            assert_eq!(alarm.alarm_level, "2");
            assert!(alarm.alarm_message.contains(init.unwrap_or("unknown")));
        } else {
            assert!(alarm.is_none());
        }
        h.writer.stop().await;
    }
}

fn missing_updater() -> ProcessLiveness {
    ProcessLiveness {
        running: false,
        pid: None,
        source: ProcessLivenessSource::None,
        reason: "no matching updater command found".into(),
        pid_file_state: Some(PidFileState::Missing),
        pid_file_process_alive: None,
        pid_file_command: None,
        pid_file_command_matched: None,
    }
}
#[tokio::test]
async fn source_l661_l679_l709_updater_alarm_keeps_grace_failure_count_and_disable_gate() {
    for enabled in [true, false] {
        let h = H::with(|opts| {
            opts.auto_update_enabled = enabled;
            opts.updater_liveness = Some(Arc::new(|_| missing_updater()));
        });
        for cycle in 1..=4 {
            h.writer.write_l1().await;
            let alarm = h.alarm("UPDATER_NOT_RUNNING_ALARM");
            if enabled && cycle == 4 {
                assert_eq!(alarm.unwrap().alarm_level, "3");
            } else {
                assert!(alarm.is_none(), "enabled={enabled} cycle={cycle}");
            }
        }
    }
}

fn native_package(root: &Path) -> PathBuf {
    use crate::utils::runtime_paths::{
        build_edition, build_target, sha256_file, RuntimeManifest, RuntimeResource,
    };
    let binary = if cfg!(windows) {
        "bin/loongsuite-pilot.exe"
    } else {
        "bin/loongsuite-pilot"
    };
    let mut resources = Vec::new();
    for (relative, text) in [
        (binary, ""),
        ("VERSION", "version=1.2.0\n"),
        ("LICENSE", "license"),
        ("agents.d/fixture.json", "{}"),
        ("assets/fixture", "resource"),
    ] {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        if relative == binary {
            std::fs::write(
                &path,
                crate::utils::native_binary::fixture_binary(build_target()),
            )
            .unwrap();
        } else {
            std::fs::write(&path, text).unwrap();
        }
        resources.push(RuntimeResource {
            path: relative.into(),
            sha256: sha256_file(&path).unwrap(),
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.join(binary), std::fs::Permissions::from_mode(0o755))
            .unwrap();
    }
    let manifest = RuntimeManifest {
        schema: 1,
        runtime: "rust".into(),
        version: "1.2.0".into(),
        git_commit: "a".repeat(40),
        target: build_target().into(),
        edition: build_edition().into(),
        binary: binary.into(),
        resources,
    };
    std::fs::write(
        root.join("runtime-manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    root.join(binary)
}

#[tokio::test]
async fn source_l738_l758_real_native_current_pointer_failure_and_success() {
    for valid in [false, true] {
        let h = H::with(|opts| {
            let root = PathBuf::from(&opts.data_dir);
            let binary = native_package(&root.join("versions").join("1.2.0_abc"));
            std::fs::write(
                root.join("current"),
                if valid {
                    "1.2.0_abc"
                } else {
                    "nonexistent_version"
                },
            )
            .unwrap();
            opts.runtime_probe = Some(RuntimeProbe {
                exec_path: binary,
                cache_dir: Some(root),
            });
        });
        h.writer.start().await;
        let alarm = h.alarm("BROKEN_VERSION_POINTER_ALARM");
        if valid {
            assert!(alarm.is_none());
        } else {
            assert_eq!(alarm.unwrap().alarm_level, "2");
        }
        h.writer.stop().await;
    }
}

#[tokio::test]
async fn source_l778_l810_invalid_runtime_contract_is_owned_by_native_package_health() {
    for valid in [false, true] {
        let h = H::with(|opts| {
            let root = PathBuf::from(&opts.data_dir);
            std::fs::write(root.join("node-bin"), "/never-invoke-legacy-node").unwrap();
            if valid {
                opts.runtime_probe = Some(RuntimeProbe {
                    exec_path: native_package(&root.join("portable")),
                    cache_dir: Some(root),
                });
            }
        });
        h.writer.start().await;
        let alarms = h.alarms();
        assert!(alarms
            .iter()
            .all(|a| a.alarm_type != "INVALID_NODE_BIN_ALARM"));
        let alarm = alarms
            .iter()
            .find(|a| a.alarm_type == "INVALID_RUNTIME_BIN_ALARM");
        if valid {
            assert!(alarm.is_none());
        } else {
            let alarm = alarm.unwrap();
            assert_eq!(alarm.alarm_level, "2");
            assert!(alarm.alarm_message.contains("原生二进制"));
        }
        assert_eq!(
            std::fs::read_to_string(h.root.path().join("node-bin")).unwrap(),
            "/never-invoke-legacy-node"
        );
        h.writer.stop().await;
    }
}

#[tokio::test]
async fn main_f84_source_l315_hook_spool_pipeline_and_mirror_are_consumed_once() {
    let h = H::new();
    let spool = h.root.path().join("state").join("hook-metrics");
    std::fs::create_dir_all(&spool).unwrap();
    std::fs::write(spool.join("codex.jsonl"),"{\"hook_event\":\"stop\",\"duration_ms\":40}\n{\"hook_event\":\"stop\",\"duration_ms\":120}\n").unwrap();
    h.writer.write_l2().await;
    let rows = pipeline();
    assert_eq!(
        rows.iter()
            .map(|r| r.fields["type"].as_str())
            .collect::<Vec<_>>(),
        ["agent", "input", "flusher", "hook"]
    );
    assert_string_fields(
        &rows[3].fields,
        json!({"agent":"codex","hook_event":"stop","calls":"2","total_duration_ms":"160","max_duration_ms":"120","user_id":"u1","hostname":hostname::get().unwrap().to_string_lossy()}),
    );
    assert_fields(
        &h.first("pilot-hook-metrics"),
        json!({"type":"hook","agent":"codex","hook_event":"stop","calls":"2"}),
    );
    clear_sends();
    h.writer.write_l2().await;
    assert_eq!(
        pipeline()
            .iter()
            .map(|r| r.fields["type"].as_str())
            .collect::<Vec<_>>(),
        ["agent", "input", "flusher"]
    );
}

#[tokio::test]
async fn main_f84_source_l361_shutdown_drains_hook_samples_created_after_startup() {
    let h = H::new();
    h.writer.start().await;
    clear_sends();
    let spool = h.root.path().join("state").join("hook-metrics");
    std::fs::create_dir_all(&spool).unwrap();
    std::fs::write(
        spool.join("codex.jsonl"),
        "{\"hook_event\":\"stop\",\"duration_ms\":55}\n",
    )
    .unwrap();
    h.writer.stop().await;
    let rows = pipeline();
    let hooks = rows
        .iter()
        .filter(|r| r.fields["type"] == "hook")
        .collect::<Vec<_>>();
    assert_eq!(hooks.len(), 1);
    assert_string_fields(
        &hooks[0].fields,
        json!({"calls":"1","total_duration_ms":"55","max_duration_ms":"55"}),
    );
    assert_eq!(std::fs::read_dir(spool).unwrap().count(), 0);
}

struct Release(Option<std::sync::mpsc::Sender<()>>);
impl Release {
    fn now(&mut self) {
        if let Some(send) = self.0.take() {
            let _ = send.send(());
        }
    }
}
impl Drop for Release {
    fn drop(&mut self) {
        self.now();
    }
}
async fn poll_once<F: std::future::Future>(
    mut future: std::pin::Pin<&mut F>,
) -> std::task::Poll<F::Output> {
    std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx))).await
}

#[test]
fn source_l315_stop_waits_for_real_inflight_write_then_takes_fresh_final_snapshot() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    rt.spawn_blocking(move || {
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(5));
    });
    ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let mut release = Release(Some(release_tx));
    rt.block_on(async {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let h = H::with(|opts| {
            opts.get_snapshot = Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(super::tests::snapshot())
            })
        });
        let first = h.writer.write_dataflow();
        tokio::pin!(first);
        assert!(poll_once(first.as_mut()).await.is_pending());
        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let stopping = h.writer.stop();
        tokio::pin!(stopping);
        assert!(poll_once(stopping.as_mut()).await.is_pending());
        // Let the owned stop cycle run until it waits on the same gate.
        tokio::time::sleep(Duration::from_millis(10)).await;
        // The first cycle is at a real native append IO boundary. Stop must wait,
        // then invoke the provider again, rather than overlap or reuse its snapshot.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        release.now();
        tokio::join!(first, stopping);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            std::fs::read_to_string(h.mirror("pilot-metrics"))
                .unwrap()
                .lines()
                .count(),
            2
        );
    });
}

#[test]
fn cancelling_the_actual_scheduling_task_does_not_cancel_its_owned_inflight_cycle() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    rt.spawn_blocking(move || {
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(5));
    });
    ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let mut release = Release(Some(release_tx));
    rt.block_on(async {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let h = H::with(|opts| {
            opts.get_snapshot = Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(super::tests::snapshot())
            })
        });
        let shared = h.writer.share();
        let scheduled = tokio::spawn(async move {
            shared.write_dataflow().await;
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        scheduled.abort();
        assert!(scheduled.await.unwrap_err().is_cancelled());
        let stopping = h.writer.stop();
        tokio::pin!(stopping);
        assert!(poll_once(stopping.as_mut()).await.is_pending());
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        release.now();
        stopping.await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            std::fs::read_to_string(h.mirror("pilot-metrics"))
                .unwrap()
                .lines()
                .count(),
            2
        );
    });
}
