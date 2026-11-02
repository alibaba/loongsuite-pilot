use super::*;
fn closed_turn(index: i64, tool: bool) -> Vec<Value> {
    let mut rows = turn(index, tool);
    rows.push(json!({"type":"last-prompt"}));
    rows
}
fn legacy_cursor(f: &Fixture, lines: usize) {
    let session = hex::encode(Sha256::digest(b"session"));
    let dir = f
        .root
        .join("state/hooks")
        .join(format!("{}-line-records", f.agent));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(format!("{session}.json")),
        json!({"session_id":"session","transcript_path":f.file,"last_line_count":lines})
            .to_string(),
    )
    .unwrap();
}
#[tokio::test]
async fn collector_l210_migrates_exact_legacy_line_cursor_without_replaying_accepted_turn() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let previous = turn(0, false);
        f.write(&previous);
        legacy_cursor(&f, previous.len());
        f.append(&turn(1, true));
        f.wake("Stop", json!({}));
        assert_eq!(user_texts(&f.settle().await), ["prompt 1"]);
    }
}
#[tokio::test]
async fn collector_l221_out_of_order_retry_notices_use_earliest_physical_anchor() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let a = turn(0, false);
        let b = turn(1, false);
        f.write(&[a.clone(), b.clone()].concat());
        f.wake("Stop", json!({"legacyTriggerLine":a.len()+b.len()-1}));
        f.wake("Stop", json!({"legacyTriggerLine":a.len()-1}));
        assert_eq!(user_texts(&f.settle().await), ["prompt 0", "prompt 1"]);
    }
}
#[tokio::test]
async fn collector_l228_missing_native_source_preserves_checkpoint_and_recovers_suffix() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&turn(0, false));
        f.wake("Stop", json!({}));
        f.settle().await;
        let before = f.state.to_string();
        let away = f.file.with_extension("away");
        std::fs::rename(&f.file, &away).unwrap();
        assert!(f.collect().await.records.is_empty());
        assert_eq!(f.state.to_string(), before);
        std::fs::rename(&away, &f.file).unwrap();
        f.append(&turn(1, false));
        f.wake("Stop", json!({}));
        assert_eq!(user_texts(&f.settle().await), ["prompt 1"]);
    }
}
#[tokio::test]
async fn collector_l249_real_stop_notice_closes_turn_without_any_native_terminal_markers() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let mut rows = turn(0, false);
        rows.pop();
        rows.last_mut().unwrap()["message"]
            .as_object_mut()
            .unwrap()
            .remove("stop_reason");
        f.write(&rows);
        f.wake("Stop", json!({}));
        assert_eq!(user_texts(&f.settle().await), ["prompt 0"]);
    }
}
#[tokio::test]
async fn collector_l254_same_inode_rewrite_has_new_user_and_distinct_turn_identity() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&turn(0, false));
        f.wake("Stop", json!({}));
        let previous = f.settle().await;
        let inode = scanner::version(&scanner::open_regular(&f.file).unwrap())
            .unwrap()
            .ino;
        f.write(&turn(1, false));
        f.wake("Stop", json!({}));
        assert_eq!(
            scanner::version(&scanner::open_regular(&f.file).unwrap())
                .unwrap()
                .ino,
            inode
        );
        let next = f.settle().await;
        assert_eq!(user_texts(&next), ["prompt 1"]);
        assert_ne!(next[0]["gen_ai.turn.id"], previous[0]["gen_ai.turn.id"]);
    }
}
#[tokio::test]
async fn collector_l330_live_legacy_writer_grace_defers_and_release_resumes_current_turn() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&turn(0, false));
        f.wake("Stop", json!({}));
        let lock = qoder_legacy_retry_lock_path(&f.root, &f.file);
        std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
        std::fs::write(&lock, json!({"pid":std::process::id(),"ts":0}).to_string()).unwrap();
        assert!(f
            .source
            .inner
            .lock()
            .await
            .legacy_worker_alive(&f.file, &f.key)
            .unwrap());
        assert!(f.collect().await.records.is_empty());
        assert_eq!(f.state, json!({}));
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(user_texts(&f.settle().await), ["prompt 0"]);
    }
}
#[tokio::test]
async fn collector_l357_small_budget_bootstrap_selects_last_of_400_turns_without_checkpoint_bodies()
{
    let mut f = Fixture::new("qoder-cn").await;
    f.source.inner.lock().await.scan_bytes = 64 * 1024;
    let rows = (0..400).flat_map(|i| turn(i, false)).collect::<Vec<_>>();
    f.write(&rows);
    f.wake("Stop", json!({}));
    let mut result = Vec::new();
    for _ in 0..8 {
        if !result.is_empty() {
            break;
        }
        result.extend(f.collect().await.records);
        f.clock.fetch_add(6000, Ordering::SeqCst);
    }
    assert_eq!(user_texts(&result), ["prompt 399"]);
    assert!(f.state.to_string().len() < 4096);
}
#[tokio::test]
async fn collector_l413_bad_notice_json_preserves_unread_source_then_repairs_without_body_cache() {
    let mut f = Fixture::new("qoder-cn").await;
    f.write(&closed_turn(0, false));
    f.wake("Stop", json!({}));
    let events = f
        .root
        .join("state/qoder-transcripts/qoder-cn/sources")
        .join(&f.key)
        .join("events");
    let path = std::fs::read_dir(events)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let original = std::fs::read(&path).unwrap();
    std::fs::write(&path, b"{").unwrap();
    assert!(f.collect().await.records.is_empty());
    assert_eq!(f.state, json!({}));
    std::fs::write(&path, &original).unwrap();
    assert_eq!(user_texts(&f.collect().await.records), ["prompt 0"]);
    assert!(f.source.inner.lock().await.cache.is_empty());
}
#[tokio::test]
async fn collector_l370_real_publisher_1030_sources_have_no_admission_starvation_or_duplicates() {
    let mut f = Fixture::new("qoder-cn").await;
    let empty = Map::new();
    for index in 0..1030 {
        let file = f.root.join(format!("source-{index}.jsonl"));
        std::fs::write(&file, jsonl(&closed_turn(index, false))).unwrap();
        let payload = json!({"session_id":format!("session-{index}"),"transcript_path":file,"hook_event_name":"Stop"});
        assert!(crate::hook_process::publish_qoder_wakeup(
            &payload, &f.root, "qoder-cn", None, &empty, &empty
        ));
    }
    let mut records = Vec::new();
    for _ in 0..40 {
        records.extend(f.collect().await.records);
    }
    let users = user_texts(&records);
    assert_eq!(users.iter().collect::<HashSet<_>>().len(), 1030);
    assert_eq!(users.len(), 1030);
    assert!(f.source.inner.lock().await.metadata_bytes <= 4 * 1024 * 1024);
}
#[tokio::test]
async fn collector_l383_oversize_quarantine_keeps_healthy_source_and_later_turn_without_replay() {
    let mut f = Fixture::new("qoder-cn").await;
    f.source.inner.lock().await.max_turn_bytes = 64 * 1024;
    let mut oversized = turn(0, false);
    oversized[2]["message"]["content"] = json!("x".repeat(70 * 1024));
    f.write(&oversized[..1]);
    f.wake("UserPromptSubmit", json!({}));
    f.collect().await;
    let mut suffix = oversized[1..].to_vec();
    suffix.push(json!({"type":"last-prompt"}));
    f.append(&suffix);
    f.wake("Stop", json!({}));
    let original = std::fs::read(&f.file).unwrap();
    let healthy = f.root.join("healthy.jsonl");
    std::fs::write(&healthy, jsonl(&closed_turn(1, false))).unwrap();
    let empty = Map::new();
    assert!(crate::hook_process::publish_qoder_wakeup(
        &json!({"session_id":"healthy","transcript_path":healthy,"hook_event_name":"Stop"}),
        &f.root,
        "qoder-cn",
        None,
        &empty,
        &empty
    ));
    let records = f.settle().await;
    let mut users = user_texts(&records);
    users.sort();
    assert_eq!(users, ["prompt 0", "prompt 1"]);
    let incomplete = records
        .iter()
        .filter(|r| flag(r, "agent.transcript_incomplete"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(user_texts(&incomplete), ["prompt 0"]);
    assert_eq!(count(&incomplete, "llm.response"), 0);
    {
        let c = f.source.inner.lock().await;
        assert!(c.warned.keys().any(|k| k.contains("byte-limit")));
        assert!(c.cache_size <= c.cache_limit);
    }
    assert_eq!(
        number(&f.state[&f.key], "committedOffset"),
        original.len() as u64
    );
    assert_eq!(f.state[&f.key]["quarantines"].as_array().unwrap().len(), 1);
    assert_eq!(std::fs::read(&f.file).unwrap(), original);
    f.append(&closed_turn(2, false));
    f.wake("Stop", json!({}));
    let later = f.settle().await;
    assert_eq!(user_texts(&later), ["prompt 2"]);
    assert!(later
        .iter()
        .all(|r| !flag(r, "agent.transcript_incomplete")));
    f.restart().await;
    f.source.inner.lock().await.max_turn_bytes = 64 * 1024;
    assert!(f.settle().await.is_empty());
}
#[tokio::test]
async fn collector_l264_atomic_generation_change_during_actual_open_does_not_publish_mixed_turn() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&closed_turn(0, false));
        f.wake("Stop", json!({}));
        let path = f.file.clone();
        let next = path.with_extension("replacement");
        std::fs::write(&next, jsonl(&closed_turn(1, false))).unwrap();
        let opened = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let probe = opened.clone();
        let guard = scanner::inject_open_fault(move |p| {
            if p == path && probe.fetch_add(1, Ordering::SeqCst) == 1 {
                std::fs::rename(&next, &path).unwrap();
            }
        });
        assert!(f.collect().await.records.is_empty());
        assert_eq!(f.state, json!({}));
        assert!(opened.load(Ordering::SeqCst) >= 2);
        drop(guard);
        f.wake("Stop", json!({}));
        assert_eq!(user_texts(&f.settle().await), ["prompt 1"]);
    }
}
#[tokio::test]
async fn collector_l301_real_same_watermark_publication_after_old_read_survives_ack_and_collects_new_generation(
) {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&closed_turn(0, false));
        let empty = Map::new();
        let payload = json!({"session_id":"session","transcript_path":f.file,"hook_event_name":"Stop","cwd":f.root});
        assert!(crate::hook_process::publish_qoder_wakeup(
            &payload, &f.root, agent, None, &empty, &empty
        ));
        // One production read stages the exact output receipt; the following read
        // is the durable-ack cleanup boundary under test.
        assert_eq!(user_texts(&f.collect().await.records), ["prompt 0"]);
        let key = f.state.as_object().unwrap().keys().next().unwrap().clone();
        let events = f
            .root
            .join("state/qoder-transcripts")
            .join(agent)
            .join("sources")
            .join(&key)
            .join("events");
        let notice = std::fs::read_dir(&events)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let from = f.file.clone();
        let replacement = from.with_extension("new");
        let rewritten = jsonl(&closed_turn(1, false));
        assert_eq!(
            rewritten.len() as u64,
            std::fs::metadata(&from).unwrap().len()
        );
        std::fs::write(&replacement, rewritten).unwrap();
        let observed = Arc::new(AtomicBool::new(false));
        let fired = observed.clone();
        let notice_target = notice.clone();
        let root = f.root.clone();
        let agent = agent.to_owned();
        let descriptor = payload.clone();
        let guard = inject_metadata_read_fault(move |path| {
            if path == notice_target && !fired.swap(true, Ordering::SeqCst) {
                std::fs::rename(&replacement, &from).unwrap();
                let empty = Map::new();
                assert!(crate::hook_process::publish_qoder_wakeup(
                    &descriptor,
                    &root,
                    &agent,
                    None,
                    &empty,
                    &empty
                ));
            }
        });
        f.source
            .inner
            .lock()
            .await
            .acknowledge(&f.state, &f.source.stopped);
        assert!(observed.load(Ordering::SeqCst));
        assert!(
            notice.exists(),
            "a later notice at the same watermark must survive the old receipt"
        );
        drop(guard);
        assert_eq!(user_texts(&f.settle().await), ["prompt 1"]);
        assert!(f.collect().await.records.is_empty());
    }
}
