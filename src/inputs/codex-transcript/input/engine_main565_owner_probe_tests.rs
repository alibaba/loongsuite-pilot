//! Original #565 source-recovery additions and its default offline probe workload.
use super::*;

fn persisted_absence(f: &Fixture, path: &str) -> Option<Value> {
    f.rt()
        .state_store
        .get(&f.engine().state_key(path))
        .extra()
        .and_then(|extra| extra.get("codexOwnerAbsentVersion").cloned())
}

async fn collect_without_history(f: &Fixture) {
    f.rt().reset_read_accumulator_for_test();
    assert!(InputBody::collect(&f.input.inner.body, f.rt())
        .await
        .unwrap()
        .is_empty());
    let read = f.rt().reset_read_accumulator_for_test();
    assert_eq!(read.raw_read_bytes, 0);
    assert_eq!(read.raw_read_calls, 0);
    assert_eq!(read.raw_in_bytes, 0);
}

#[tokio::test]
async fn main565_original_inventory_larger_than_lru_has_zero_reads_including_restart() {
    for invalid_header in [false, true] {
        tokio::time::timeout(Duration::from_secs(30), async {
            let f = Fixture::new();
            let sessions = f.root.path().join("sessions");
            std::fs::create_dir_all(&sessions).unwrap();
            let ordinary = row(
                "event_msg",
                json!({"type":"historical_without_owner","padding":"x".repeat(128)}),
                0,
            );
            let text = if invalid_header {
                json!({"type":"session_meta","payload":null}).to_string()
                    + "\n"
                    + &ordinary.repeat(2)
            } else {
                ordinary
            };
            for index in 0..2056 {
                std::fs::write(
                    sessions.join(format!("rollout-missing-{index}.jsonl")),
                    &text,
                )
                .unwrap();
            }
            InputBody::on_start(&f.input.inner.body, f.rt())
                .await
                .unwrap();
            let revision = f.rt().state_store.revision();
            for _ in 0..2 {
                collect_without_history(&f).await;
            }
            assert_eq!(f.rt().state_store.revision(), revision);
            assert!(f.records().is_empty());
            f.rt().state_store.save().await.unwrap();
            InputBody::on_stop(&f.input.inner.body, f.rt())
                .await
                .unwrap();
            let restarted = f.restart().await;
            restarted.rt().reset_read_accumulator_for_test();
            InputBody::on_start(&restarted.input.inner.body, restarted.rt())
                .await
                .unwrap();
            assert_eq!(
                restarted
                    .rt()
                    .reset_read_accumulator_for_test()
                    .raw_read_bytes,
                0
            );
            collect_without_history(&restarted).await;
            InputBody::on_stop(&restarted.input.inner.body, restarted.rt())
                .await
                .unwrap();
        })
        .await
        .expect("original #565 each 2056-file case's 30-second budget");
    }
}

#[tokio::test]
async fn main565_original_invalid_header_keeps_searching_for_a_later_valid_owner() {
    source_budget(async {
        let f = Fixture::new();
        let prefix = json!({"type":"session_meta","payload":null}).to_string()
            + "\n"
            + &row("event_msg", json!({"type":"ordinary_record"}), 0);
        let path = f
            .write(
                "rollout-session.jsonl",
                &(prefix.clone() + &owner_header() + &diagnostic()),
            )
            .await;
        assert_eq!(
            probe_owner(&f, &path, None).await,
            Some(prefix.len() as i64)
        );
        assert!(persisted_absence(&f, &path).is_none());
    })
    .await;
}

#[tokio::test]
async fn main565_original_persisted_absence_repairs_invalidate_with_empty_lru_and_preserved_mtime()
{
    for mode in ["append", "same-size", "new-inode", "truncate"] {
        source_budget(async {
            let f = Fixture::new();
            let original = diagnostic();
            let path = f.write("rollout-session.jsonl", &original).await;
            let stat = std::fs::metadata(&path).unwrap();
            assert_eq!(probe_owner(&f, &path, None).await, None);
            assert!(persisted_absence(&f, &path).unwrap().is_string());
            assert!(f
                .engine()
                .read_checkpoint(f.rt(), &f.engine().state_key(&path))
                .is_none());
            f.input
                .inner
                .body
                .with_shared(|shared| shared.owner_offset_probes.clear());
            let before = crate::inputs::codex_transcript::scan::file_version_snapshot(&path)
                .await
                .unwrap();
            if mode == "same-size" {
                // File-system change timestamps can share a clock tick on Unix
                // as well as Windows. This fixture restores mtime, so ensure
                // its separate change-time witness can actually distinguish it.
                tokio::time::sleep(Duration::from_millis(32)).await;
            }
            if mode == "append" {
                f.append(&path, &owner_header()).await;
            } else {
                let header = owner_header();
                let body = if mode == "same-size" {
                    header.clone() + &" ".repeat(original.len() - header.len() - 1) + "\n"
                } else {
                    header
                };
                if mode == "new-inode" {
                    let replacement = format!("{path}.new");
                    std::fs::write(&replacement, body).unwrap();
                    std::fs::rename(&replacement, &path).unwrap();
                } else {
                    std::fs::write(&path, body).unwrap();
                }
            }
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_accessed(stat.accessed().unwrap())
                        .set_modified(stat.modified().unwrap()),
                )
                .unwrap();
            if mode == "same-size" {
                let after = crate::inputs::codex_transcript::scan::file_version_snapshot(&path)
                    .await
                    .unwrap();
                assert_eq!(after.modified, before.modified);
                assert_ne!(
                    after.changed, before.changed,
                    "same-size fixture must expose a distinct change-time witness"
                );
            }
            assert_eq!(
                probe_owner(&f, &path, None).await,
                Some(if mode == "append" {
                    original.len() as i64
                } else {
                    0
                }),
                "{mode}",
            );
            assert!(persisted_absence(&f, &path).is_none(), "{mode}");
        })
        .await;
    }
}

#[tokio::test]
async fn main565_original_prefix_and_incomplete_probes_never_persist_full_absence() {
    for kind in ["prefix", "incomplete"] {
        source_budget(async {
            let f = Fixture::new();
            let prefix = diagnostic();
            let suffix = if kind == "prefix" {
                owner_header()
            } else {
                "{\"unfinished\":".to_owned()
            };
            let path = f
                .write("rollout-session.jsonl", &(prefix.clone() + &suffix))
                .await;
            let end = if kind == "prefix" {
                Some(prefix.len() as i64)
            } else {
                None
            };
            assert_eq!(probe_owner(&f, &path, end).await, None);
            assert!(persisted_absence(&f, &path).is_none(), "{kind}");
        })
        .await;
    }
}

#[tokio::test]
async fn main565_original_malformed_persisted_absence_is_ignored_and_cleared() {
    for value in [json!(123), json!({}), json!("x".repeat(257))] {
        source_budget(async {
            let f = Fixture::new();
            let path = f.write("rollout-session.jsonl", &owner_header()).await;
            f.rt().state_store.update(
                &f.engine().state_key(&path),
                InputStatePatch {
                    extra: Some(json!({"codexOwnerAbsentVersion":value})),
                    ..Default::default()
                },
            );
            assert_eq!(probe_owner(&f, &path, None).await, Some(0));
            assert!(persisted_absence(&f, &path).is_none());
        })
        .await;
    }
}

fn process_cpu_ms() -> Option<f64> {
    #[cfg(unix)]
    {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        // SAFETY: getrusage writes the exact rusage buffer before it is read.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0 {
            let usage = unsafe { usage.assume_init() };
            return Some(
                (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) as f64 * 1000.0
                    + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) as f64 / 1000.0,
            );
        }
    }
    None
}

async fn measure_original_workload(f: &Fixture, startup: bool, phase: &str) -> Value {
    f.rt().reset_read_accumulator_for_test();
    let cpu = process_cpu_ms();
    let started = std::time::Instant::now();
    if startup {
        InputBody::on_start(&f.input.inner.body, f.rt())
            .await
            .unwrap();
    } else {
        assert!(InputBody::collect(&f.input.inner.body, f.rt())
            .await
            .unwrap()
            .is_empty());
    }
    let wall_ms = started.elapsed().as_secs_f64() * 1000.0;
    let cpu_ms = cpu
        .zip(process_cpu_ms())
        .map(|(before, after)| after - before);
    let read = f.rt().reset_read_accumulator_for_test();
    assert_eq!(read.raw_in_bytes, 0);
    assert!(f.records().is_empty());
    json!({"phase":phase,"wallMs":wall_ms,"cpuMs":cpu_ms,
        "raw_read_bytes":read.raw_read_bytes,"raw_read_calls":read.raw_read_calls,
        "raw_in_bytes":read.raw_in_bytes,"raw_in_records":read.raw_in_records,"events":0})
}

#[tokio::test]
async fn main565_original_owner_probe_performance_default_2056_files_and_three_cycles() {
    tokio::time::timeout(Duration::from_secs(300), async {
        let f = Fixture::new();
        let sessions = f.root.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let empty = json!({"type":"event_msg","payload":{"type":"historical_without_owner","padding":""}}).to_string() + "\n";
        let body = json!({"type":"event_msg","payload":{"type":"historical_without_owner","padding":"x".repeat(4096-empty.len())}}).to_string() + "\n";
        assert_eq!(body.len(), 4096);
        assert!(body.ends_with('\n'));
        serde_json::from_str::<Value>(body.trim()).unwrap();
        let mut written = 0;
        for index in 0..2056 {
            std::fs::write(sessions.join(format!("rollout-missing-{index:08}.jsonl")), &body).unwrap();
            written += body.len();
        }
        assert_eq!(written, 2056 * 4096);
        let mut measured = vec![measure_original_workload(&f, true, "startup").await];
        for _ in 0..3 {
            measured.push(measure_original_workload(&f, false, "collect").await);
        }
        f.rt().state_store.save().await.unwrap();
        InputBody::on_stop(&f.input.inner.body, f.rt()).await.unwrap();
        let restarted = f.restart().await;
        measured.push(measure_original_workload(&restarted, true, "restart-startup").await);
        measured.push(measure_original_workload(&restarted, false, "restart-collect").await);
        InputBody::on_stop(&restarted.input.inner.body, restarted.rt()).await.unwrap();
        for phase in measured.iter().skip(1) {
            assert_eq!(phase["raw_read_bytes"], 0, "{phase}");
            assert_eq!(phase["raw_read_calls"], 0, "{phase}");
        }
        println!("MAIN565_OWNER_PROBE_PERF {}", json!({
            "sourceCommit":"eb763691580423478216715455bbcdd698dc8384",
            "fixtureValidated":true,"writtenBytes":written,
            "workload":{"files":2056,"totalBytes":2056*4096,"cycles":3,"ownerMetadata":false},
            "rows":measured,
            "limitations":"Synthetic static JSONL; real Native Input/StateStore/accumulator. Startup reconstructs baselines; collect excludes state-file save. CPU/wall are descriptive process totals affected by concurrent tests; CPU may be unavailable outside Unix. No timing threshold."
        }));
    }).await.expect("original benchmark's 300-second worker budget");
}
