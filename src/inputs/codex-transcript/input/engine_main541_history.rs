use super::*;
use crate::inputs::base::InputBody;
use std::time::{Duration, Instant};

#[tokio::test]
async fn main541_large_fork_record_advances_and_quiet_tail_does_not_reread() {
    tokio::time::timeout(Duration::from_secs(15), async {
        for terminated in [true, false] {
            let started = Instant::now();
            let f = Fixture::new();
            let large = json!({"type":"response_item","payload":{"text":"x".repeat(17*1024*1024)}})
                .to_string();
            let path = f
                .write(
                    "rollout-fork.jsonl",
                    &(large.clone() + if terminated { "\n" } else { "" }),
                )
                .await;
            let mut checkpoint = empty_checkpoint(0);
            checkpoint.fork_bootstrap = Some(CodexForkBootstrap {
                state: ForkBootstrapState::LivePending,
                search_offset: 0,
                initial_turn_id: Some("owned".into()),
                recovery_turn_id: None,
                tail_candidate: None,
            });
            let owner = meta("fork");
            let size = tokio::fs::metadata(&path).await.unwrap().len() as i64;
            f.engine()
                .prepare_copied_transcript(f.rt(), &path, size, &owner, &mut checkpoint)
                .await
                .unwrap();
            if terminated {
                assert_eq!(
                    checkpoint.fork_bootstrap.as_ref().unwrap().search_offset,
                    large.len() as i64 + 1
                );
            }
            f.rt().reset_read_accumulator_for_test();
            f.engine()
                .prepare_copied_transcript(f.rt(), &path, size, &owner, &mut checkpoint)
                .await
                .unwrap();
            assert_eq!(f.rt().reset_read_accumulator_for_test().raw_read_bytes, 0);
            f.append(
            &path,
            &(if terminated { "" } else { "\n" }.to_owned()
                + &json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"owned"}})
                    .to_string()
                + "\n"),
        )
        .await;
            let size = tokio::fs::metadata(&path).await.unwrap().len() as i64;
            let mut result = f
                .engine()
                .prepare_copied_transcript(f.rt(), &path, size, &owner, &mut checkpoint)
                .await
                .unwrap();
            if !result.ready {
                result = f
                    .engine()
                    .prepare_copied_transcript(f.rt(), &path, size, &owner, &mut checkpoint)
                    .await
                    .unwrap();
            }
            assert!(result.ready);
            assert_eq!(checkpoint.scan_offset, large.len() as i64 + 1);
            assert!(started.elapsed() < Duration::from_secs(15));
        }
    })
    .await
    .expect("source case budget remains 15s");
}

#[tokio::test]
async fn main541_persisted_eof_fork_stays_durable_and_new_ownership_is_saved() {
    tokio::time::timeout(Duration::from_secs(15), async {
    let f = Fixture::new();
    let path=f.write("rollout-fork.jsonl", &(json!({"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"fork","forked_from_id":"parent","model_provider":"openai"}}).to_string()+"\n")).await;
    let (inode, size, _) = file_meta_snapshot(&path).await.unwrap();
    let key = f.engine().state_key(&path);
    let mut checkpoint = empty_checkpoint(inode);
    checkpoint.owner_session_meta_offset = Some(0);
    checkpoint.fork_bootstrap = Some(CodexForkBootstrap {
        state: ForkBootstrapState::LivePending,
        search_offset: size,
        initial_turn_id: None,
        recovery_turn_id: None,
        tail_candidate: None,
    });
    f.engine().save_checkpoint(f.rt(), &key, &checkpoint);
    f.process(&path).await;
    f.rt().state_store.save().await.unwrap();
    for _ in 0..10 {
        f.process(&path).await;
        assert!(
            f.rt().state_store.is_persisted(&key, None),
            "quiet fork dirtied durable checkpoint"
        );
        f.rt().state_store.save().await.unwrap();
    }
    f.marker(
        "wakeups",
        "fork.json",
        json!({"session_id":"fork","initial_turn_id":"owned"}),
    )
    .await;
    f.process(&path).await;
    assert!(!f.rt().state_store.is_persisted(&key, None));
    assert_eq!(
        f.checkpoint(&path)
            .fork_bootstrap
            .unwrap()
            .initial_turn_id
            .as_deref(),
        Some("owned")
    );

    }).await.expect("source case budget remains 15s");
}

#[tokio::test]
async fn main541_empty_delegation_is_absent_but_clearing_real_state_is_saved() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new();
        f.engine().save_delegation_state(f.rt());
        assert!(
            f.rt().state_store.get("codex-transcript").extra().is_none(),
            "empty startup wrote delegation state"
        );
        f.input.inner.body.with_shared(|s| {
            s.delivered_invocations.insert("delivered".into());
        });
        f.engine().save_delegation_state(f.rt());
        assert_eq!(
            f.rt().state_store.get("codex-transcript").extra().unwrap()["codexResultInvocations"],
            json!(["delivered"])
        );
        f.rt().state_store.save().await.unwrap();
        f.input
            .inner
            .body
            .with_shared(|s| s.delivered_invocations.clear());
        f.engine().save_delegation_state(f.rt());
        assert!(!f.rt().state_store.is_persisted("codex-transcript", None));
        assert_eq!(
            f.rt().state_store.get("codex-transcript").extra().unwrap()["codexResultInvocations"],
            json!([])
        );
    })
    .await
    .expect("source case budget remains 15s");
}

async fn settle_initial_cycle(f: &Fixture) {
    f.input.start().await.unwrap();
    f.input.inner.await_current_cycle_for_test().await;
}
fn reset_visits(f: &Fixture) {
    f.input.inner.body.with_shared(|s| {
        s.main541_discoveries = 0;
        s.main541_retries = 0;
        s.main541_visits.clear();
    });
}
async fn body_cycle(f: &Fixture) {
    f.input.inner.body.collect(f.rt()).await.unwrap();
}
fn request_named_cycle(f: &Fixture, name: Option<&str>) {
    f.input.inner.body.note_wakeup(name);
    f.input
        .inner
        .body
        .with_shared(|s| s.wakeup.only_requested = true);
}
async fn await_terminal(f: &Fixture, turns: usize) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if f.records()
                .iter()
                .filter(|e| e["gen_ai.turn.end"] == true)
                .count()
                >= turns
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("actual native watcher terminal within original 2s");
}
async fn append_first_turn(f: &Fixture, path: &str) {
    let text = completed();
    f.append(
        path,
        &(text.lines().skip(1).collect::<Vec<_>>().join("\n") + "\n"),
    )
    .await;
}
async fn write_stop_marker(f: &Fixture, path: &str, seq: u64) {
    f.marker("wakeups","session-1.json",json!({"session_id":"session-1","transcript_path":path,"hook_event":"stop","received_at":chrono::Utc::now().to_rfc3339(),"seq":seq})).await;
}

#[tokio::test]
async fn main541_actual_named_wakeup_emits_all_waves_without_full_discovery() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let started = Instant::now();
        let f = Fixture::new();
        let path = f
            .write(
                "rollout-session-1.jsonl",
                &(completed().lines().next().unwrap().to_owned() + "\n"),
            )
            .await;
        settle_initial_cycle(&f).await;
        reset_visits(&f);
        append_first_turn(&f, &path).await;
        write_stop_marker(&f, &path, 1).await;
        await_terminal(&f, 1).await;
        f.input.stop().await.unwrap();
        let entries = f.records();
        assert_eq!(responses_for(&entries, "turn-1").len(), 3);
        assert_eq!(events(&entries, "tool.call").len(), 2);
        assert_eq!(events(&entries, "tool.result").len(), 2);
        assert_eq!(
            entries
                .iter()
                .map(|e| e["event.id"].as_str().unwrap())
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            entries.len()
        );
        f.input.inner.body.with_shared(|s| {
            assert_eq!(s.main541_discoveries, 0);
            assert_eq!(s.main541_retries, 0);
            assert_eq!(s.main541_visits, vec![path.clone()]);
        });
        let checkpoint = f.checkpoint(&path);
        assert_eq!(
            checkpoint.scan_offset,
            tokio::fs::metadata(&path).await.unwrap().len() as i64
        );
        assert!(checkpoint.active_turn.is_none() && checkpoint.pending_terminal.is_none());
        assert!(started.elapsed() < Duration::from_secs(15));
    })
    .await
    .expect("source case budget remains 15s");
}

#[tokio::test]
async fn main541_known_targeted_wakeups_keep_other_owners_and_cold_index_fast_paths() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new();
        let mut paths = Vec::new();
        for id in ["a", "b", "c"] {
            let path = f
                .write(
                    &format!("rollout-{id}.jsonl"),
                    &(json!({"type":"session_meta","payload":{"id":id,"model_provider":"openai"}})
                        .to_string()
                        + "\n"),
                )
                .await;
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1))
                .unwrap();
            paths.push(path);
        }
        body_cycle(&f).await;
        reset_visits(&f);
        let cached_b = f.input.inner.body.with_shared(|s| {
            let b = &s.meta_cache[&paths[1]];
            (
                b.file_size,
                b.owner_offset,
                b.estimated_bytes,
                b.last_seen_at_ms,
            )
        });
        for _ in 0..1000 {
            f.input.inner.body.note_wakeup(Some("a.json"));
        }
        f.input.inner.body.note_wakeup(Some("b.json"));
        f.input.inner.body.note_wakeup(Some(".a.json.123.tmp"));
        f.input.inner.body.note_wakeup(Some("._a.json"));
        f.input
            .inner
            .body
            .with_shared(|s| s.wakeup.only_requested = true);
        body_cycle(&f).await;
        f.input.inner.body.with_shared(|s| {
            assert_eq!(s.main541_visits, paths[..2]);
            assert_eq!(s.main541_discoveries, 0);
            assert_eq!(s.main541_retries, 0);
            assert_eq!(s.meta_by_path.len(), 3);
            assert_eq!(s.path_by_thread["c"], paths[2]);
        });
        // Target only A and prove B's cached object contents and index are untouched.
        let b_before = f.input.inner.body.with_shared(|s| {
            let b = &s.meta_cache[&paths[1]];
            (
                b.file_size,
                b.owner_offset,
                b.estimated_bytes,
                b.last_seen_at_ms,
            )
        });
        request_named_cycle(&f, Some("a.json"));
        body_cycle(&f).await;
        f.input.inner.body.with_shared(|s| {
            let b = &s.meta_cache[&paths[1]];
            assert_eq!(
                (
                    b.file_size,
                    b.owner_offset,
                    b.estimated_bytes,
                    b.last_seen_at_ms
                ),
                b_before
            );
            assert_eq!(s.path_by_thread["b"], paths[1]);
        });
        assert_eq!(cached_b.0, b_before.0);
        // All three are real cold unchanged files, so a normal full pass skips them
        // but must retain the complete named owner index.
        reset_visits(&f);
        body_cycle(&f).await;
        f.input.inner.body.with_shared(|s| {
            assert!(s.main541_visits.is_empty());
            assert!(s.wakeup.paths["b.json"].contains(&paths[1]));
        });
        request_named_cycle(&f, Some("b.json"));
        body_cycle(&f).await;
        f.input
            .inner
            .body
            .with_shared(|s| assert_eq!(s.main541_visits, vec![paths[1].clone()]));
    })
    .await
    .expect("source case budget remains 15s");
}

#[tokio::test]
async fn main541_unknown_and_filename_less_notifications_force_next_full_cold_pass_and_periodic_scan(
) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new();
        let mut paths = Vec::new();
        for id in ["a", "b", "c"] {
            let path = f
                .write(
                    &format!("rollout-{id}.jsonl"),
                    &(json!({"type":"session_meta","payload":{"id":id,"model_provider":"openai"}})
                        .to_string()
                        + "\n"),
                )
                .await;
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1))
                .unwrap();
            paths.push(path);
        }
        body_cycle(&f).await;
        reset_visits(&f);
        request_named_cycle(&f, None);
        body_cycle(&f).await;
        f.input.inner.body.with_shared(|s| {
            assert_eq!(s.main541_discoveries, 0);
            assert!(s.main541_visits.is_empty());
            assert!(s.wakeup.discovery_pending);
        });
        body_cycle(&f).await;
        f.input.inner.body.with_shared(|s| {
            assert_eq!(s.main541_visits, paths);
            assert!(!s.wakeup.discovery_pending);
        });
        reset_visits(&f);
        request_named_cycle(&f, Some("new.json"));
        body_cycle(&f).await;
        f.input
            .inner
            .body
            .with_shared(|s| assert_eq!(s.main541_discoveries, 0));
        let new_path = f
            .write(
                "rollout-new.jsonl",
                &(json!({"type":"session_meta","payload":{"id":"new","model_provider":"openai"}})
                    .to_string()
                    + "\n"),
            )
            .await;
        body_cycle(&f).await;
        f.input
            .inner
            .body
            .with_shared(|s| assert!(s.main541_visits.contains(&new_path)));
        reset_visits(&f);
        f.input.inner.body.with_shared(|s| {
            s.wakeup.last_full_scan_at =
                Some(tokio::time::Instant::now() - Duration::from_millis(f.rt().poll_interval_ms()))
        });
        request_named_cycle(&f, Some("a.json"));
        body_cycle(&f).await;
        f.input.inner.body.with_shared(|s| {
            assert_eq!(s.main541_discoveries, 1);
            assert_eq!(s.main541_retries, 1);
        });
    })
    .await
    .expect("source case budget remains 15s");
}

#[tokio::test]
async fn main541_real_wakeup_survives_busy_durable_save_and_coalesces_requests() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let started = Instant::now();
        let f = Fixture::new();
        let path = f
            .write(
                "rollout-session-1.jsonl",
                &(completed().lines().next().unwrap().to_owned() + "\n"),
            )
            .await;
        settle_initial_cycle(&f).await;
        reset_visits(&f);
        let entered = Arc::new(tokio::sync::Notify::new());
        let enter = entered.clone();
        let (release, rx) = tokio::sync::oneshot::channel::<()>();
        let waiting = Arc::new(Mutex::new(Some(rx)));
        f.rt().state_store.set_write_hook(move |path, text| {
            let rx = waiting.lock().unwrap().take();
            let enter = enter.clone();
            async move {
                if let Some(rx) = rx {
                    enter.notify_one();
                    rx.await.map_err(|e| anyhow::anyhow!(e))?;
                }
                tokio::fs::write(path, text)
                    .await
                    .map_err(anyhow::Error::from)
            }
        });
        append_first_turn(&f, &path).await;
        write_stop_marker(&f, &path, 1).await;
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        let next = completed()
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
            .replace("turn-1", "turn-2")
            .replace("call-1", "second-call-1")
            .replace("call-2", "second-call-2")
            + "\n";
        f.append(&path, &next).await;
        for _ in 0..1000 {
            f.input.inner.body.note_wakeup(Some("session-1.json"));
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
        f.input
            .inner
            .body
            .with_shared(|s| assert!(s.wakeup.dirty.contains("session-1.json")));
        release.send(()).unwrap();
        await_terminal(&f, 2).await;
        f.input.stop().await.unwrap();
        f.input.inner.body.with_shared(|s| {
            assert_eq!(s.main541_discoveries, 0);
            assert!(s.main541_visits.len() <= 3);
            assert!(s.wakeup.dirty.is_empty());
        });
        assert_eq!(responses_for(&f.records(), "turn-2").len(), 3);
        assert!(started.elapsed() < Duration::from_secs(15));
    })
    .await
    .expect("source case budget remains 15s");
}

#[tokio::test]
async fn main541_same_session_update_during_real_output_is_collected_in_following_cycle() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new();
        let path = f
            .write(
                "rollout-session-1.jsonl",
                &(completed().lines().next().unwrap().to_owned() + "\n"),
            )
            .await;
        settle_initial_cycle(&f).await;
        reset_visits(&f);
        let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let once = fired.clone();
        let weak = Arc::downgrade(&f.input.inner);
        let next = completed()
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
            .replace("turn-1", "turn-2")
            .replace("call-1", "second-call-1")
            .replace("call-2", "second-call-2")
            + "\n";
        let append_path = path.clone();
        f.input.on_entries(move |_| {
            if !once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&append_path)
                    .unwrap();
                file.write_all(next.as_bytes()).unwrap();
                file.flush().unwrap();
                weak.upgrade()
                    .unwrap()
                    .body
                    .note_wakeup(Some("session-1.json"));
            }
        });
        append_first_turn(&f, &path).await;
        write_stop_marker(&f, &path, 1).await;
        await_terminal(&f, 2).await;
        f.input.stop().await.unwrap();
        assert!(fired.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(responses_for(&f.records(), "turn-1").len(), 3);
        assert_eq!(responses_for(&f.records(), "turn-2").len(), 3);
        f.input.inner.body.with_shared(|s| {
            assert_eq!(s.main541_discoveries, 0);
            assert_eq!(s.main541_visits, vec![path.clone(), path.clone()]);
        });
    })
    .await
    .expect("source case budget remains 15s");
}

#[tokio::test]
async fn main541_stop_cancels_queued_native_wakeups_and_reaps_owned_scheduler() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new();
        let path = f
            .write(
                "rollout-session-1.jsonl",
                &(completed().lines().next().unwrap().to_owned() + "\n"),
            )
            .await;
        settle_initial_cycle(&f).await;
        reset_visits(&f);
        append_first_turn(&f, &path).await;
        f.input.inner.body.note_wakeup(Some("session-1.json"));
        f.input.stop().await.unwrap();
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert!(f.records().is_empty());
        assert!(!f.input.collector_running());
        assert!(f.input.inner.body.watcher_stop.lock().unwrap().is_none());
        f.input.inner.body.with_shared(|s| {
            assert!(s.main541_visits.is_empty());
            assert!(s.wakeup.dirty.is_empty());
            assert!(s.wakeup.paths.is_empty());
            assert!(!s.wakeup.discovery_pending);
        });
    })
    .await
    .expect("source case budget remains 15s");
}
