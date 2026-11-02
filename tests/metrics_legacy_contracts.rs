//! Exact legacy monitoring contracts through the public native APIs.
//! Every input, PID path and release cache is synthetic / tempfile-owned.
use base64::Engine;
use loongsuite_pilot::inputs::base::{
    CommittedInputBatch, InputRuntimeAccumulator, InputRuntimeDelta,
};
use loongsuite_pilot::metrics::{
    DataflowSnapshot, FlusherEndpointStats, HookTimingStats, InputSnapshot, MetricsCollector,
    MetricsCollectorOptions, RuntimeProbe,
};
use loongsuite_pilot::utils::{PidFileState, ProcessLiveness, ProcessLivenessSource};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;

fn options(root: &std::path::Path, clock: &Arc<AtomicI64>) -> MetricsCollectorOptions {
    let clock = clock.clone();
    MetricsCollectorOptions {
        auto_update_enabled: false,
        now_ms: Some(Arc::new(move || clock.load(Ordering::SeqCst))),
        cpu_usage: Some(Arc::new(|| (0, 0))),
        runtime_probe: Some(RuntimeProbe {
            exec_path: root.join("missing-synthetic-native-bin"),
            cache_dir: Some(root.to_path_buf()),
        }),
        ..MetricsCollectorOptions::new("1.0.0", "test-user", root.to_string_lossy())
    }
}
fn input(agent: &str) -> InputSnapshot {
    InputSnapshot {
        agent: agent.into(),
        ..InputSnapshot::default()
    }
}
fn pipeline() -> DataflowSnapshot {
    let mut data = DataflowSnapshot {
        in_events_total: 60,
        in_bytes_total: 1780,
        ..DataflowSnapshot::default()
    };
    data.inputs.insert(
        "qoder-sqlite".into(),
        InputSnapshot {
            raw_in_records: 50,
            raw_in_bytes: 2048,
            raw_in_max_batch_bytes: 1600,
            in_events: 42,
            in_bytes: 1024,
            out_failed: 2,
            last_poll_time: "2026-05-19 10:01:00".into(),
            start_time: "2026-05-19 09:00:00".into(),
            ..input("qoder")
        },
    );
    data.inputs.insert(
        "qoder-trace".into(),
        InputSnapshot {
            raw_read_calls: 4,
            raw_read_bytes: 1024,
            raw_in_records: 10,
            raw_in_bytes: 512,
            raw_in_max_batch_bytes: 4096,
            raw_in_max_record_bytes: 128,
            raw_backlog_bytes_max: 2048,
            parse_success_records: 9,
            parse_failed_records: 1,
            read_duration_ms: 12.4,
            process_duration_ms: 21.6,
            in_events: 8,
            in_bytes: 256,
            collection_method: "trace".into(),
            last_poll_time: "2026-05-19 10:03:00".into(),
            start_time: "2026-05-19 08:30:00".into(),
            ..input("qoder")
        },
    );
    data.inputs.insert(
        "cursor-hook".into(),
        InputSnapshot {
            raw_in_records: 12,
            raw_in_bytes: 700,
            raw_in_max_batch_bytes: 700,
            in_events: 10,
            in_bytes: 500,
            collection_method: "hook".into(),
            last_poll_time: "2026-05-19 10:02:00".into(),
            start_time: "2026-05-19 09:30:00".into(),
            ..input("cursor")
        },
    );
    data.input_idle_minutes.insert("qoder-sqlite".into(), 3);
    data.input_idle_minutes.insert("qoder-trace".into(), 7);
    data.flushers.insert(
        "sls:main".into(),
        FlusherEndpointStats {
            project: "proj-a".into(),
            logstore: "store-a".into(),
            mode: "sls".into(),
            in_entries: 200,
            in_bytes: 50000,
            out_entries: 195,
            out_bytes: 48000,
            out_failed: 5,
            total_delay_ms: 3500,
            last_flush_time: "2026-05-19 10:05:00".into(),
            start_time: "2026-05-19 09:00:00".into(),
            ..FlusherEndpointStats::default()
        },
    );
    data.flushers.insert(
        "cms:arms".into(),
        FlusherEndpointStats {
            kind: "cms".into(),
            bytes_basis: "estimated".into(),
            in_entries: 60,
            in_bytes: 9000,
            out_entries: 60,
            out_bytes: 8800,
            total_delay_ms: 900,
            last_flush_time: "2026-05-19 10:06:00".into(),
            start_time: "2026-05-19 09:10:00".into(),
            ..FlusherEndpointStats::default()
        },
    );
    data
}
fn fields(actual: &Value, expected: Value) {
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(&actual[key], value, "wire field {key}");
    }
}

#[test]
fn input_runtime_sum_max_and_read_process_split() {
    let mut a = InputRuntimeAccumulator::new();
    a.observe_read(80, 128, 2.5);
    a.observe_read(20, 32, 0.5);
    a.observe_backlog(300);
    a.observe_backlog(120);
    a.observe_committed_batch(CommittedInputBatch {
        bytes: 90,
        records: 2,
        parse_success_records: 1,
        parse_failed_records: 1,
        max_record_bytes: 60,
    });
    assert_eq!(
        a.finish(10.0),
        InputRuntimeDelta {
            source_kind: "primary",
            raw_read_calls: 2,
            raw_read_bytes: 100,
            raw_in_records: 2,
            raw_in_bytes: 90,
            raw_in_max_batch_bytes: 128,
            raw_in_max_record_bytes: 60,
            raw_backlog_bytes_max: 300,
            parse_success_records: 1,
            parse_failed_records: 1,
            read_duration_ms: 3.0,
            process_duration_ms: 7.0,
        }
    );
}
#[test]
fn input_runtime_rejects_nonfinite_duration_effects_and_has_no_payload_storage() {
    for invalid in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut a = InputRuntimeAccumulator::new();
        a.observe_read(0, 0, invalid);
        a.observe_committed_batch(CommittedInputBatch {
            bytes: 0,
            records: 0,
            parse_success_records: 0,
            parse_failed_records: 0,
            max_record_bytes: 0,
        });
        a.observe_backlog(0);
        assert_eq!(
            a.finish(invalid),
            InputRuntimeDelta {
                source_kind: "primary",
                raw_read_calls: 1,
                raw_read_bytes: 0,
                raw_in_records: 0,
                raw_in_bytes: 0,
                raw_in_max_batch_bytes: 0,
                raw_in_max_record_bytes: 0,
                raw_backlog_bytes_max: 0,
                parse_success_records: 0,
                parse_failed_records: 0,
                read_duration_ms: 0.0,
                process_duration_ms: 0.0,
            }
        );
    }
    // Negative/NaN byte counts cannot be supplied to the native u64 API.
    // No claim is made that this exercises the old dynamically typed count adapter.
    assert!(!std::mem::needs_drop::<InputRuntimeAccumulator>());
}
#[test]
fn input_runtime_state_stays_bounded_for_one_hundred_thousand_records() {
    let mut a = InputRuntimeAccumulator::new();
    let size = std::mem::size_of_val(&a);
    assert!(!std::mem::needs_drop::<InputRuntimeAccumulator>());
    for _ in 0..100_000 {
        a.observe_committed_batch(CommittedInputBatch {
            bytes: 64,
            records: 1,
            parse_success_records: 1,
            parse_failed_records: 0,
            max_record_bytes: 64,
        });
    }
    assert_eq!(std::mem::size_of_val(&a), size);
    let delta = a.finish(1.0);
    assert_eq!(delta.raw_in_records, 100_000);
    assert_eq!(delta.raw_in_bytes, 6_400_000);
    assert_eq!(delta.raw_in_max_record_bytes, 64);
}

#[test]
fn l1_wire_identity_dimensions_and_schema_do_not_leak_raw_input_totals() {
    let root = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let mut c = MetricsCollector::from_options(options(root.path(), &clock));
    let mut s = pipeline();
    s.in_events_total = 110;
    s.in_bytes_total = 5000;
    s.flushers.get_mut("sls:main").unwrap().out_entries = 70;
    s.flushers.get_mut("sls:main").unwrap().out_bytes = 3000;
    s.flushers.get_mut("cms:arms").unwrap().out_entries = 30;
    s.flushers.get_mut("cms:arms").unwrap().out_bytes = 1800;
    s.inputs.insert(
        "never-installed".into(),
        InputSnapshot {
            running: false,
            ..input("kiro-cli")
        },
    );
    let row = c.collect_l1(&s);
    let value = serde_json::to_value(&row).unwrap();
    let hostname = hostname::get().unwrap().into_string().unwrap();
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(root.path().to_string_lossy().as_bytes());
    assert_eq!(row.instance_id, format!("{hostname}_test-user_{encoded}"));
    assert!(!row.instance_id.contains(root.path().to_str().unwrap()));
    assert_eq!(
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .unwrap(),
        root.path().to_string_lossy().as_bytes()
    );
    assert!(row.run_id.starts_with(&(row.instance_id.clone() + "_")));
    assert!(row
        .run_id
        .rsplit('_')
        .next()
        .unwrap()
        .parse::<u64>()
        .is_ok());
    assert_eq!(row.pid, u64::from(std::process::id()));
    assert_eq!(row.hostname, hostname);
    assert!(row.ip.parse::<std::net::Ipv4Addr>().is_ok());
    #[cfg(target_os = "linux")]
    assert!(row.os_detail.contains("Linux"));
    #[cfg(target_os = "macos")]
    assert!(row.os_detail.contains("Darwin"));
    #[cfg(target_os = "windows")]
    assert!(row.os_detail.contains("Windows_NT"));
    #[cfg(target_arch = "x86_64")]
    assert!(row.os_detail.contains("x64"));
    #[cfg(target_arch = "aarch64")]
    assert!(row.os_detail.contains("arm64"));
    assert!(row.mem.parse::<u64>().unwrap() > 0);
    for field in ["cpu", "mem", "mem_heap"] {
        assert!(value[field].is_string());
    }
    fields(
        &value,
        json!({"version":"1.0.0", "user_id":"test-user", "__time__":1800000000}),
    );
    fields(
        &value["metric_json"],
        json!({
            "agent_count":"2", "active_agent_count":"1", "in_events":"110", "in_bytes":"5000",
            "out_events":"100", "out_bytes":"4800"
        }),
    );
    for field in [
        "input_count",
        "active_input_count",
        "raw_in_records",
        "raw_in_bytes",
        "raw_in_max_batch_bytes",
    ] {
        assert!(value["metric_json"].get(field).is_none());
    }
    for field in ["flusher_runner", "updater_event"] {
        assert!(value.get(field).is_none());
    }
    for field in ["window_ms", "open_fd"] {
        assert!(value["metric_json"][field].is_string());
    }
}
#[test]
fn l1_rates_drain_each_axis_and_keep_zero_first_rate_and_stable_start() {
    let root = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let mut c = MetricsCollector::from_options(options(root.path(), &clock));
    let mut s = DataflowSnapshot {
        in_events_total: 110,
        in_bytes_total: 5000,
        ..DataflowSnapshot::default()
    };
    s.flushers.insert(
        "sls".into(),
        FlusherEndpointStats {
            out_entries: 100,
            out_bytes: 4800,
            ..FlusherEndpointStats::default()
        },
    );
    let first = c.collect_l1(&s);
    let value = serde_json::to_value(&first.metric_json).unwrap();
    for key in [
        "in_events_ps",
        "in_bytes_ps",
        "out_events_ps",
        "out_bytes_ps",
    ] {
        assert_eq!(value[key], "0.0");
    }
    clock.fetch_add(1000, Ordering::SeqCst);
    let idle = serde_json::to_value(c.collect_l1(&s).metric_json).unwrap();
    for key in ["in_events", "in_bytes", "out_events", "out_bytes"] {
        assert_eq!(idle[key], "0");
    }
    s.in_events_total = 135;
    s.in_bytes_total = 5600;
    s.flushers.get_mut("sls").unwrap().out_entries = 130;
    s.flushers.get_mut("sls").unwrap().out_bytes = 5400;
    clock.fetch_add(1000, Ordering::SeqCst);
    let moved = c.collect_l1(&s);
    assert_eq!(moved.start_time, first.start_time);
    fields(
        &serde_json::to_value(moved.metric_json).unwrap(),
        json!({
            "in_events":"25","in_bytes":"600","out_events":"30","out_bytes":"600",
            "in_events_ps":"25.0","in_bytes_ps":"600.0","out_events_ps":"30.0","out_bytes_ps":"600.0"
        }),
    );
    s.in_events_total = 10;
    s.in_bytes_total = 400;
    clock.fetch_add(1000, Ordering::SeqCst);
    fields(
        &serde_json::to_value(c.collect_l1(&s).metric_json).unwrap(),
        json!({"in_events":"0","in_bytes":"0"}),
    );
}

#[test]
fn l2_wire_rows_preserve_identity_agent_rollup_input_detail_and_destinations() {
    let root = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let mut c = MetricsCollector::from_options(options(root.path(), &clock));
    let s = pipeline();
    let rows = c.collect_l2(&s).unwrap();
    let shape = serde_json::to_value(&rows).unwrap();
    assert_eq!(
        shape
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["agents", "flushers", "hooks", "inputs"])
    );
    let l1 = serde_json::to_value(c.collect_l1(&DataflowSnapshot::default())).unwrap();
    assert!(rows.hooks.is_empty());
    assert_eq!(rows.agents.len(), 2);
    assert!(rows.agents.iter().all(|row| row.row_type == "agent"));
    assert_eq!(
        rows.agents
            .iter()
            .map(|row| row.agent.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["cursor", "qoder"])
    );
    assert_eq!(rows.inputs.len(), 3);
    assert_eq!(rows.flushers.len(), 2);
    assert_eq!(
        rows.flushers
            .iter()
            .map(|row| row.flusher.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["cms", "sls"])
    );

    let all: Vec<Value> = rows
        .agents
        .iter()
        .map(|row| serde_json::to_value(row).unwrap())
        .chain(
            rows.inputs
                .iter()
                .map(|row| serde_json::to_value(row).unwrap()),
        )
        .chain(
            rows.flushers
                .iter()
                .map(|row| serde_json::to_value(row).unwrap()),
        )
        .collect();
    for row in &all {
        for key in ["hostname", "ip", "instance_id", "user_id"] {
            assert_eq!(row[key], l1[key]);
        }
        assert!(row["run_id"]
            .as_str()
            .unwrap()
            .rsplit('_')
            .next()
            .unwrap()
            .parse::<u64>()
            .is_ok());
        assert!(row["window_ms"].as_str().unwrap().parse::<u64>().is_ok());
        assert!(row["__time__"].as_i64().unwrap() > 0);
        assert_ne!(row["type"], "pipeline");
    }
    assert_eq!(
        all.iter()
            .map(|row| row["window_ms"].as_str().unwrap())
            .collect::<BTreeSet<_>>()
            .len(),
        1
    );
    let q = rows.agents.iter().find(|row| row.agent == "qoder").unwrap();
    let q = serde_json::to_value(q).unwrap();
    fields(
        &q,
        json!({"type":"agent","in_events":"50","in_bytes":"1280","failed_events":"2",
        "last_poll_time":"2026-05-19 10:03:00","start_time":"2026-05-19 08:30:00","idle_minutes":"3"}),
    );
    for key in [
        "raw_in_records",
        "raw_in_bytes",
        "raw_in_max_batch_bytes",
        "out_events",
        "out_bytes",
    ] {
        assert!(q.get(key).is_none());
    }
    assert_eq!(
        rows.agents
            .iter()
            .find(|row| row.agent == "cursor")
            .unwrap()
            .idle_minutes,
        "-1"
    );
    let t = serde_json::to_value(
        rows.inputs
            .iter()
            .find(|row| row.input_name == "qoder-trace")
            .unwrap(),
    )
    .unwrap();
    fields(
        &t,
        json!({"type":"input","agent":"qoder","source_kind":"primary","collection_method":"trace",
        "raw_read_calls":"4","raw_read_bytes":"1024","raw_in_records":"10","raw_in_bytes":"512",
        "raw_in_max_batch_bytes":"4096","raw_in_max_record_bytes":"128","raw_backlog_bytes_max":"2048",
        "parse_success_records":"9","parse_failed_records":"1","read_duration_ms":"12","process_duration_ms":"22",
        "in_events":"8","in_bytes":"256","failed_events":"0"}),
    );
    for key in ["session_id", "turn_id", "trace_id"] {
        assert!(t.get(key).is_none());
    }
    let sls = serde_json::to_value(
        rows.flushers
            .iter()
            .find(|row| row.flusher == "sls")
            .unwrap(),
    )
    .unwrap();
    fields(
        &sls,
        json!({"type":"flusher","project":"proj-a","logstore":"store-a","mode":"sls",
        "in_entries":"200","in_bytes":"50000","out_entries":"195","out_bytes":"48000","failed_entries":"5",
        "total_delay_ms":"3500","last_flush_time":"2026-05-19 10:05:00","start_time":"2026-05-19 09:00:00"}),
    );
    for row in &rows.flushers {
        assert!(serde_json::to_value(row).unwrap().get("endpoint").is_none());
    }
    let cms = rows
        .flushers
        .iter()
        .find(|row| row.flusher == "cms")
        .unwrap();
    assert_eq!(
        (
            cms.project.as_str(),
            cms.logstore.as_str(),
            cms.out_entries.as_str(),
            cms.out_bytes.as_str()
        ),
        ("", "", "60", "8800")
    );
    assert_eq!(
        rows.inputs
            .iter()
            .map(|row| row.raw_in_records.parse::<u64>().unwrap())
            .sum::<u64>(),
        72
    );
    assert_eq!(
        rows.inputs
            .iter()
            .map(|row| row.raw_in_bytes.parse::<u64>().unwrap())
            .sum::<u64>(),
        3260
    );
    assert_eq!(
        rows.agents
            .iter()
            .map(|row| row.in_events.parse::<u64>().unwrap())
            .sum::<u64>(),
        60
    );
    assert_eq!(
        rows.agents
            .iter()
            .map(|row| row.in_bytes.parse::<u64>().unwrap())
            .sum::<u64>(),
        1780
    );
    assert_eq!(
        rows.flushers
            .iter()
            .map(|row| row.out_entries.parse::<u64>().unwrap())
            .sum::<u64>(),
        255
    );
    assert_eq!(
        rows.flushers
            .iter()
            .map(|row| row.out_bytes.parse::<u64>().unwrap())
            .sum::<u64>(),
        56800
    );
}
#[test]
fn l2_windows_keep_destination_identity_count_new_inputs_and_retain_stopped_traffic() {
    let root = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let mut c = MetricsCollector::from_options(options(root.path(), &clock));
    let mut s = pipeline();
    c.collect_l2(&s).unwrap();
    let idle = c.collect_l2(&s).unwrap();
    assert!(idle
        .agents
        .iter()
        .all(|row| row.in_events == "0" && row.in_bytes == "0"));
    assert_eq!(
        idle.agents
            .iter()
            .find(|row| row.agent == "qoder")
            .unwrap()
            .idle_minutes,
        "3"
    );
    let sls = idle
        .flushers
        .iter()
        .find(|row| row.flusher == "sls")
        .unwrap();
    assert_eq!(
        (
            sls.out_entries.as_str(),
            sls.out_bytes.as_str(),
            sls.total_delay_ms.as_str()
        ),
        ("0", "0", "0")
    );
    assert_eq!(
        (sls.project.as_str(), sls.last_flush_time.as_str()),
        ("proj-a", "2026-05-19 10:05:00")
    );
    s.inputs.get_mut("qoder-sqlite").unwrap().raw_in_records = 55;
    s.inputs.get_mut("qoder-sqlite").unwrap().raw_in_bytes = 2248;
    s.inputs.get_mut("qoder-sqlite").unwrap().in_events = 50;
    s.inputs.get_mut("qoder-sqlite").unwrap().out_failed = 3;
    s.flushers.get_mut("sls:main").unwrap().out_entries = 200;
    s.flushers.get_mut("sls:main").unwrap().out_bytes = 49000;
    let next = c.collect_l2(&s).unwrap();
    let q = next.agents.iter().find(|row| row.agent == "qoder").unwrap();
    assert_eq!((q.in_events.as_str(), q.failed_events.as_str()), ("8", "1"));
    assert_eq!(
        next.agents
            .iter()
            .find(|row| row.agent == "cursor")
            .unwrap()
            .in_events,
        "0"
    );
    let sls = next
        .flushers
        .iter()
        .find(|row| row.flusher == "sls")
        .unwrap();
    assert_eq!(
        (sls.out_entries.as_str(), sls.out_bytes.as_str()),
        ("5", "1000")
    );
    assert_eq!(
        next.flushers
            .iter()
            .find(|row| row.flusher == "cms")
            .unwrap()
            .out_entries,
        "0"
    );
    s.inputs.insert(
        "codex-jsonl".into(),
        InputSnapshot {
            in_events: 12,
            in_bytes: 900,
            ..input("codex")
        },
    );
    let added = c.collect_l2(&s).unwrap();
    assert_eq!(
        added
            .agents
            .iter()
            .find(|row| row.agent == "codex")
            .unwrap()
            .in_events,
        "12"
    );
    let mut s = pipeline();
    s.inputs.insert(
        "kiro-cli".into(),
        InputSnapshot {
            in_events: 5,
            in_bytes: 300,
            running: false,
            ..input("kiro-cli")
        },
    );
    let mut fresh = MetricsCollector::from_options(options(root.path(), &clock));
    let stopped = fresh.collect_l2(&s).unwrap();
    assert_eq!(
        stopped
            .agents
            .iter()
            .find(|row| row.agent == "kiro-cli")
            .unwrap()
            .in_events,
        "5"
    );
    assert_eq!(
        stopped
            .agents
            .iter()
            .map(|row| row.in_events.parse::<u64>().unwrap())
            .sum::<u64>(),
        65
    );
    assert_eq!(fresh.collect_l1(&s).metric_json.agent_count, "2");
    s.flushers.insert(
        "sls:second".into(),
        FlusherEndpointStats {
            project: "proj-a".into(),
            logstore: "store-b".into(),
            out_entries: 7,
            out_bytes: 700,
            ..FlusherEndpointStats::default()
        },
    );
    let mut fresh = MetricsCollector::from_options(options(root.path(), &clock));
    let destinations = fresh.collect_l2(&s).unwrap();
    assert_eq!(
        destinations
            .flushers
            .iter()
            .filter(|row| row.flusher == "sls")
            .map(|row| row.logstore.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["store-a", "store-b"])
    );
    assert_eq!(
        destinations
            .flushers
            .iter()
            .map(|row| row.out_entries.parse::<u64>().unwrap())
            .sum::<u64>(),
        262
    );
}
fn liveness(running: bool) -> ProcessLiveness {
    ProcessLiveness {
        running,
        pid: running.then_some(456),
        source: if running {
            ProcessLivenessSource::ProcessScan
        } else {
            ProcessLivenessSource::None
        },
        reason: if running {
            "matching process command found; stale pid 123"
        } else {
            "no matching updater command found"
        }
        .into(),
        pid_file_state: Some(if running {
            PidFileState::Stale
        } else {
            PidFileState::Missing
        }),
        pid_file_process_alive: None,
        pid_file_command: None,
        pid_file_command_matched: None,
    }
}
#[test]
fn updater_grace_identity_recovery_and_disabled_install_are_not_false_alarms() {
    let root = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let healthy = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));
    let (h, n) = (healthy.clone(), calls.clone());
    let mut opts =
        MetricsCollectorOptions::new("1.0.0", "test-user", root.path().to_string_lossy());
    opts.now_ms = options(root.path(), &clock).now_ms;
    opts.cpu_usage = options(root.path(), &clock).cpu_usage;
    opts.runtime_probe = options(root.path(), &clock).runtime_probe;
    opts.updater_liveness = Some(Arc::new(move |_| {
        n.fetch_add(1, Ordering::SeqCst);
        liveness(h.load(Ordering::SeqCst))
    }));
    let mut c = MetricsCollector::from_options(opts);
    for _ in 0..2 {
        assert_eq!(
            c.collect_l1(&DataflowSnapshot::default()).updater_pid_alive,
            "true"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    for expected in [1, 2] {
        assert_eq!(
            c.collect_l1(&DataflowSnapshot::default()).updater_pid_alive,
            "false"
        );
        assert_eq!(
            c.last_infra_health().unwrap().updater_consecutive_failures,
            expected
        );
    }
    healthy.store(true, Ordering::SeqCst);
    assert_eq!(
        c.collect_l1(&DataflowSnapshot::default()).updater_pid_alive,
        "true"
    );
    assert_eq!(
        c.last_infra_health().unwrap().updater_consecutive_failures,
        0
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    let n = calls.clone();
    let mut opts = options(root.path(), &clock);
    opts.updater_liveness = Some(Arc::new(move |_| {
        n.fetch_add(1, Ordering::SeqCst);
        liveness(false)
    }));
    let mut disabled = MetricsCollector::from_options(opts);
    for _ in 0..5 {
        disabled.collect_l1(&DataflowSnapshot::default());
    }
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        disabled
            .last_infra_health()
            .unwrap()
            .updater_consecutive_failures,
        0
    );
    assert!(disabled.last_infra_health().unwrap().updater_pid_alive);
}
#[test]
fn latest_main_hook_rows_round_durations_and_share_window_identity() {
    let root = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let mut c = MetricsCollector::from_options(options(root.path(), &clock));
    let timings = vec![
        HookTimingStats {
            agent: "codex".into(),
            hook_event: "stop".into(),
            calls: 3,
            total_duration_ms: 150.6,
            max_duration_ms: 90.4,
        },
        HookTimingStats {
            agent: "codex".into(),
            hook_event: "session-start".into(),
            calls: 1,
            total_duration_ms: 42.0,
            max_duration_ms: 42.0,
        },
    ];
    let rows = c
        .collect_l2_with_hook_timings(&pipeline(), &timings)
        .unwrap();
    assert_eq!(rows.hooks.len(), 2);
    fields(
        &serde_json::to_value(&rows.hooks[0]).unwrap(),
        json!({
            "type":"hook","agent":"codex","hook_event":"stop","calls":"3","total_duration_ms":"151","max_duration_ms":"90","user_id":"test-user"
        }),
    );
    for hook in &rows.hooks {
        assert_eq!(hook.identity.window_ms, rows.agents[0].identity.window_ms);
        assert_eq!(
            hook.identity.instance_id,
            rows.agents[0].identity.instance_id
        );
        assert_eq!(hook.identity.window_ms, rows.flushers[0].identity.window_ms);
    }
}
#[test]
fn latest_main_hook_only_rows_filter_zero_calls_including_the_all_zero_cycle() {
    let root = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let mut c = MetricsCollector::from_options(options(root.path(), &clock));
    let active = HookTimingStats {
        agent: "codex".into(),
        hook_event: "stop".into(),
        calls: 1,
        total_duration_ms: 30.0,
        max_duration_ms: 30.0,
    };
    let empty = HookTimingStats {
        agent: "codex".into(),
        hook_event: "session-start".into(),
        calls: 0,
        total_duration_ms: 0.0,
        max_duration_ms: 0.0,
    };
    let rows = c
        .collect_l2_with_hook_timings(&DataflowSnapshot::default(), &[active, empty.clone()])
        .unwrap();
    assert!(rows.agents.is_empty() && rows.inputs.is_empty() && rows.flushers.is_empty());
    assert_eq!(
        rows.hooks
            .iter()
            .map(|row| row.hook_event.as_str())
            .collect::<Vec<_>>(),
        vec!["stop"]
    );
    assert!(c
        .collect_l2_with_hook_timings(&DataflowSnapshot::default(), &[empty])
        .is_none());
}

#[test]
fn installed_idle_agents_stay_counted_and_only_flushers_can_emit_without_inputs() {
    let root = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let mut c = MetricsCollector::from_options(options(root.path(), &clock));
    let mut s = DataflowSnapshot::default();
    s.inputs.insert("qoder-sqlite".into(), input("qoder"));
    s.inputs.insert("codex-jsonl".into(), input("codex"));
    s.inputs.insert(
        "wukong-hook".into(),
        InputSnapshot {
            running: false,
            ..input("wukong")
        },
    );
    s.input_idle_minutes.insert("qoder-sqlite".into(), 120);
    s.input_idle_minutes.insert("codex-jsonl".into(), -1);
    let row = c.collect_l1(&s);
    assert_eq!(
        (
            row.metric_json.agent_count.as_str(),
            row.metric_json.active_agent_count.as_str()
        ),
        ("2", "1")
    );
    assert!(c.collect_l2(&DataflowSnapshot::default()).is_none());
    let mut only = DataflowSnapshot::default();
    only.flushers.insert(
        "sls:main".into(),
        FlusherEndpointStats {
            in_entries: 1,
            in_bytes: 2,
            out_entries: 1,
            out_bytes: 2,
            total_delay_ms: 5,
            ..FlusherEndpointStats::default()
        },
    );
    let rows = c.collect_l2(&only).unwrap();
    assert!(rows.agents.is_empty() && rows.inputs.is_empty());
    assert_eq!(rows.flushers[0].out_entries, "1");
    let mut stopped = pipeline();
    stopped
        .inputs
        .insert("idle-hook".into(), input("idle-agent"));
    stopped.inputs.insert(
        "dsh-hook".into(),
        InputSnapshot {
            running: false,
            ..input("dsh")
        },
    );
    stopped.inputs.insert(
        "stopped-file".into(),
        InputSnapshot {
            running: false,
            raw_in_max_batch_bytes: 4096,
            ..input("stopped-agent")
        },
    );
    let mut fresh = MetricsCollector::from_options(options(root.path(), &clock));
    let rows = fresh.collect_l2(&stopped).unwrap();
    assert_eq!(
        rows.agents
            .iter()
            .map(|row| row.agent.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["cursor", "idle-agent", "qoder"])
    );
    let idle = rows
        .agents
        .iter()
        .find(|row| row.agent == "idle-agent")
        .unwrap();
    assert_eq!(
        (idle.in_events.as_str(), idle.in_bytes.as_str()),
        ("0", "0")
    );
    assert_eq!(fresh.collect_l1(&stopped).metric_json.agent_count, "3");
}
#[test]
fn metric_metadata_keeps_init_defaults_legacy_capture_empty_and_project_deduplication() {
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    for (file, expected) in [
        (Some("launchd"), "launchd"),
        (Some("nohup"), "nohup"),
        (None, "unknown"),
        (Some(""), "unknown"),
    ] {
        let root = tempfile::tempdir().unwrap();
        if let Some(value) = file {
            std::fs::write(root.path().join("init-type"), value).unwrap();
        }
        let mut c = MetricsCollector::from_options(options(root.path(), &clock));
        assert_eq!(
            c.collect_l1(&DataflowSnapshot::default()).init_type,
            expected
        );
    }
    let root = tempfile::tempdir().unwrap();
    for agents in [
        json!({}),
        json!({"cursor":{"captureMessageContent":false},"claude-code":{"captureMessageContent":false},"codex":{"captureMessageContent":true}}),
        json!({"cursor":{"captureMessageContent":true}}),
    ] {
        let mut opts = options(root.path(), &clock);
        opts.agents_config = serde_json::from_value(agents).unwrap();
        let mut c = MetricsCollector::from_options(opts);
        let row = c.collect_l1(&DataflowSnapshot::default());
        assert_eq!(row.capture_message_disabled_agents, "");
        assert_eq!(row.projects, "");
        assert_eq!(row.cms_workspace, "");
    }
    let mut opts = options(root.path(), &clock);
    opts.sls_endpoints=serde_json::from_value(json!([
        {"name":"a","endpoint":"https://example.invalid","project":"bbb","logstore":"l1","kind":"agentActivity","mode":"ak"},
        {"name":"b","endpoint":"https://example.invalid","project":"aaa","logstore":"l2","kind":"agentActivity","mode":"ak"},
        {"name":"c","endpoint":"https://example.invalid","project":"aaa","logstore":"l3","kind":"agentActivity","mode":"ak"}
    ])).unwrap();
    opts.cms_workspace = "ws-abc".into();
    let mut c = MetricsCollector::from_options(opts);
    let row = c.collect_l1(&DataflowSnapshot::default());
    assert_eq!(row.projects, "aaa bbb");
    assert_eq!(row.cms_workspace, "ws-abc");
}
