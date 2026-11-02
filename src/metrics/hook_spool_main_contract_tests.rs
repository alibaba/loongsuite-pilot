//! Frozen f84 spool contracts, using actual files and the actual producer/drain.
use super::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn write(root: &Path, name: &str, rows: &[Value]) -> PathBuf {
    let dir = directory(root);
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join(name);
    fs::write(
        &file,
        rows.iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>(),
    )
    .unwrap();
    file
}
fn expected(agent: &str, event: &str, calls: u64, total: f64, max: f64) -> HookTimingStats {
    HookTimingStats {
        agent: agent.into(),
        hook_event: event.into(),
        calls,
        total_duration_ms: total,
        max_duration_ms: max,
    }
}
fn fake_lock_clock<T>(
    elapsed: Arc<AtomicU64>,
    wait: Arc<dyn Fn(Duration) + Send + Sync>,
    action: impl FnOnce() -> T,
) -> T {
    let origin = Instant::now();
    let clock = Arc::clone(&elapsed);
    crate::utils::sync_file_lock::with_test_clock(
        Arc::new(move || origin + Duration::from_millis(clock.load(Ordering::SeqCst))),
        wait,
        action,
    )
}

#[test]
fn source_l59_exact_producer_two_stop_calls_and_session_start_are_consumed() {
    let root = tempfile::tempdir().unwrap();
    record_hook_timing(root.path(), "codex", "stop", 0.0);
    record_hook_timing(root.path(), "codex", "stop", 0.0);
    record_hook_timing(root.path(), "codex", "session-start", 0.0);
    let spool = HookMetricsSpool::new(root.path());
    let rows = spool.drain();
    assert_eq!(
        rows.iter()
            .map(|r| format!("{}/{}", r.agent, r.hook_event))
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["codex/session-start".to_owned(), "codex/stop".to_owned()])
    );
    assert_eq!(
        rows.iter().find(|r| r.hook_event == "stop").unwrap().calls,
        2
    );
    assert_eq!(
        rows.iter()
            .find(|r| r.hook_event == "session-start")
            .unwrap()
            .calls,
        1
    );
    assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 0);
    assert!(spool.drain().is_empty());
}

#[test]
fn source_l75_captured_duration_excludes_lock_and_persistence_work() {
    struct Restore(Option<ProducerStage>);
    impl Drop for Restore {
        fn drop(&mut self) {
            PRODUCER_STAGE.with_borrow_mut(|value| *value = self.0.take());
        }
    }
    let root = tempfile::tempdir().unwrap();
    let now = Arc::new(AtomicU64::new(40.4f64.to_bits()));
    let reads = Arc::new(AtomicUsize::new(0));
    let opens = Arc::new(AtomicUsize::new(0));
    let appends = Arc::new(AtomicUsize::new(0));
    let (clock, open_count, append_count) =
        (Arc::clone(&now), Arc::clone(&opens), Arc::clone(&appends));
    let hook: ProducerStage = Arc::new(move |stage| match stage {
        "lock-acquired" => {
            clock.store(90f64.to_bits(), Ordering::SeqCst);
            open_count.fetch_add(1, Ordering::SeqCst);
        }
        "append" => {
            clock.store(140f64.to_bits(), Ordering::SeqCst);
            append_count.fetch_add(1, Ordering::SeqCst);
        }
        _ => {}
    });
    let prior = PRODUCER_STAGE.with_borrow_mut(|value| value.replace(hook));
    let _restore = Restore(prior);
    // v2's hook_process captures Instant.elapsed before this public producer
    // call; the explicit value is the native adapter for JS performance.now.
    let duration = {
        reads.fetch_add(1, Ordering::SeqCst);
        f64::from_bits(now.load(Ordering::SeqCst))
    };
    record_hook_timing(root.path(), "codex", "stop", duration);
    let row: Value = serde_json::from_str(
        fs::read_to_string(directory(root.path()).join("codex.jsonl"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(
        row.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["duration_ms", "hook_event"])
    );
    assert_eq!(row["hook_event"], "stop");
    assert_eq!(row["duration_ms"].as_f64(), Some(40.0));
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    assert_eq!(appends.load(Ordering::SeqCst), 1);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

#[test]
fn source_l98_exact_fifty_ms_five_wait_budget_preserves_held_lock_and_active_file() {
    let root = tempfile::tempdir().unwrap();
    let active = write(
        root.path(),
        "codex.jsonl",
        &[json!({"hook_event":"stop","duration_ms":20})],
    );
    let lock = suffix(&active, ".lock");
    fs::write(&lock, "holder").unwrap();
    let elapsed = Arc::new(AtomicU64::new(0));
    let waits = Arc::new(Mutex::new(Vec::new()));
    let (time, seen) = (Arc::clone(&elapsed), Arc::clone(&waits));
    fake_lock_clock(
        Arc::clone(&elapsed),
        Arc::new(move |duration| {
            seen.lock().unwrap().push(duration.as_millis() as u64);
            time.fetch_add(duration.as_millis() as u64, Ordering::SeqCst);
        }),
        || record_hook_timing(root.path(), "codex", "stop", 30.0),
    );
    assert_eq!(elapsed.load(Ordering::SeqCst), 50);
    assert_eq!(waits.lock().unwrap().as_slice(), [10, 10, 10, 10, 10]);
    assert_eq!(fs::read_to_string(lock).unwrap(), "holder");
    assert_eq!(
        fs::read_to_string(active).unwrap().trim().lines().count(),
        1
    );
}

#[test]
fn source_l118_contention_clearing_after_ten_ms_records_once_without_wait_duration() {
    let root = tempfile::tempdir().unwrap();
    let active = write(
        root.path(),
        "codex.jsonl",
        &[json!({"hook_event":"stop","duration_ms":20})],
    );
    let lock = suffix(&active, ".lock");
    fs::write(&lock, "holder").unwrap();
    let elapsed = Arc::new(AtomicU64::new(0));
    let waits = Arc::new(Mutex::new(Vec::new()));
    let perf = Arc::new(AtomicU64::new(12.4f64.to_bits()));
    let reads = Arc::new(AtomicUsize::new(0));
    let captured = {
        reads.fetch_add(1, Ordering::SeqCst);
        f64::from_bits(perf.load(Ordering::SeqCst))
    };
    let (time, seen, clock, path) = (
        Arc::clone(&elapsed),
        Arc::clone(&waits),
        Arc::clone(&perf),
        lock.clone(),
    );
    fake_lock_clock(
        Arc::clone(&elapsed),
        Arc::new(move |duration| {
            seen.lock().unwrap().push(duration.as_millis() as u64);
            let value = time.fetch_add(duration.as_millis() as u64, Ordering::SeqCst)
                + duration.as_millis() as u64;
            clock.store((12.4 + value as f64).to_bits(), Ordering::SeqCst);
            fs::remove_file(&path).unwrap();
        }),
        || record_hook_timing(root.path(), "codex", "stop", captured),
    );
    assert_eq!(waits.lock().unwrap().as_slice(), [10]);
    assert_eq!(elapsed.load(Ordering::SeqCst), 10);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(!lock.exists());
    assert_eq!(
        HookMetricsSpool::new(root.path()).drain(),
        vec![expected("codex", "stop", 2, 32.0, 20.0)]
    );
}

#[test]
fn source_l142_literal_samples_sum_and_keep_per_agent_event_maximum() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "codex.jsonl",
        &[
            json!({"hook_event":"stop","duration_ms":40}),
            json!({"hook_event":"stop","duration_ms":250}),
            json!({"hook_event":"user-prompt-submit","duration_ms":35}),
        ],
    );
    write(
        root.path(),
        "qoder.jsonl",
        &[json!({"hook_event":"stop","duration_ms":90})],
    );
    let rows = HookMetricsSpool::new(root.path())
        .drain()
        .into_iter()
        .map(|row| (format!("{}/{}", row.agent, row.hook_event), row))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        rows,
        BTreeMap::from([
            (
                "codex/stop".to_owned(),
                expected("codex", "stop", 2, 290.0, 250.0)
            ),
            (
                "codex/user-prompt-submit".to_owned(),
                expected("codex", "user-prompt-submit", 1, 35.0, 35.0)
            ),
            (
                "qoder/stop".to_owned(),
                expected("qoder", "stop", 1, 90.0, 90.0)
            )
        ])
    );
}

#[test]
fn source_l171_read_and_unlink_errors_keep_pending_and_active_then_recover_exactly_once() {
    for read_fails in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let pending = write(
            root.path(),
            "codex.jsonl.draining",
            &[json!({"hook_event":"stop","duration_ms":10})],
        );
        let active = write(
            root.path(),
            "codex.jsonl",
            &[json!({"hook_event":"stop","duration_ms":30})],
        );
        let spool = HookMetricsSpool::new(root.path());
        let read = |path: &Path| {
            if read_fails && path == pending {
                Err(io::ErrorKind::PermissionDenied.into())
            } else {
                read_pending(path)
            }
        };
        let remove = |path: &Path| {
            if !read_fails && path == pending {
                Err(io::ErrorKind::PermissionDenied.into())
            } else {
                fs::remove_file(path)
            }
        };
        assert!(spool.drain_with_io(read, remove).is_empty());
        assert!(pending.exists());
        assert!(fs::read_to_string(&active).unwrap().contains("30"));
        assert_eq!(
            spool.drain(),
            vec![expected("codex", "stop", 2, 40.0, 30.0)]
        );
        assert!(spool.drain().is_empty());
    }
}

#[test]
fn source_l231_literal_malformed_and_out_of_range_rows_do_not_hide_valid_twelve_ms() {
    let root = tempfile::tempdir().unwrap();
    let file = write(root.path(), "codex.jsonl", &[]);
    let rows = [
        "{\"hook_event\":\"stop\",\"duration_ms\":".to_owned(),
        "null".to_owned(),
        json!({"duration_ms":5}).to_string(),
        json!({"hook_event":"Stop Event","duration_ms":5}).to_string(),
        json!({"hook_event":"stop","duration_ms":"5"}).to_string(),
        json!({"hook_event":"stop","duration_ms":-1}).to_string(),
        json!({"hook_event":"stop","duration_ms":86400001}).to_string(),
        json!({"hook_event":"stop","duration_ms":12}).to_string(),
    ];
    fs::write(file, rows.join("\n") + "\n").unwrap();
    assert_eq!(
        HookMetricsSpool::new(root.path()).drain(),
        vec![expected("codex", "stop", 1, 12.0, 12.0)]
    );
}

#[test]
fn source_l248_valid_repeated_samples_over_the_size_limit_are_discarded_before_counting() {
    let root = tempfile::tempdir().unwrap();
    let file = write(root.path(), "codex.jsonl", &[]);
    let line = "{\"hook_event\":\"stop\",\"duration_ms\":1}\n";
    let count = ((HOOK_METRICS_SPOOL_MAX_BYTES + 1) as usize).div_ceil(line.len());
    fs::write(&file, line.repeat(count)).unwrap();
    assert!(fs::metadata(&file).unwrap().len() > HOOK_METRICS_SPOOL_MAX_BYTES);
    assert!(HookMetricsSpool::new(root.path()).drain().is_empty());
    assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 0);
}

#[test]
fn source_l258_non_agent_spool_filenames_remain_untouched_and_generate_no_stats() {
    let root = tempfile::tempdir().unwrap();
    for name in ["Codex Agent.jsonl", "codex.json"] {
        write(
            root.path(),
            name,
            &[json!({"hook_event":"stop","duration_ms":1})],
        );
    }
    assert!(HookMetricsSpool::new(root.path()).drain().is_empty());
    let names = fs::read_dir(directory(root.path()))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        names,
        BTreeSet::from(["Codex Agent.jsonl".to_owned(), "codex.json".to_owned()])
    );
}
