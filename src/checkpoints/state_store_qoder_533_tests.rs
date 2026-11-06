//! #533 successful durable per-input/extra receipts using actual filesystem writes.
use super::*;
use serde_json::json;

#[tokio::test]
async fn source_per_input_receipts_ignore_other_input_and_retry_real_directory_write_failure() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let store = StateStore::new(&path);
    store.set_offset("qoder-trace", 1.0);
    assert!(!store.is_persisted("qoder-trace", None));
    store.save().await.unwrap();
    assert!(store.is_persisted("qoder-trace", None));
    store.set_offset("other-input", 2.0);
    assert!(store.is_persisted("qoder-trace", None));
    assert!(!store.is_persisted("other-input", None));
    let old = path.with_extension("old");
    std::fs::rename(&path, &old).unwrap();
    std::fs::create_dir(&path).unwrap();
    store.set_offset("qoder-trace", 3.0);
    assert!(store.save().await.is_err());
    assert!(!store.is_persisted("qoder-trace", None));
    assert!(
        !store.save_failed(),
        "ordinary filesystem failure remains retryable"
    );
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&old, &path).unwrap();
    store.save().await.unwrap();
    assert!(store.is_persisted("qoder-trace", None));
    assert!(store.is_persisted("other-input", None));
    let loaded = StateStore::new(&path);
    loaded.load().await;
    assert!(loaded.is_persisted("qoder-trace", None));
    assert_eq!(loaded.get_offset("qoder-trace"), 3.0);
    assert_eq!(loaded.get_offset("other-input"), 2.0);
}
#[tokio::test]
async fn source_native_cursor_receipt_survives_other_metadata_and_tracks_pending_delete() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let store = StateStore::new(&path);
    store.set(
        "qoder-trace",
        InputState::new()
            .with_extra(json!({"qoderTranscripts":{"source":{"offset":10}},"other":1})),
    );
    store.save().await.unwrap();
    store.update(
        "qoder-trace",
        InputStatePatch {
            extra: Some(json!({"other":2})),
            ..Default::default()
        },
    );
    assert!(!store.is_persisted("qoder-trace", None));
    assert!(store.is_persisted("qoder-trace", Some("qoderTranscripts")));
    store.update(
        "qoder-trace",
        InputStatePatch {
            extra: Some(json!({"qoderTranscripts":{"source":{"offset":20}}})),
            ..Default::default()
        },
    );
    assert!(!store.is_persisted("qoder-trace", Some("qoderTranscripts")));
    store.save().await.unwrap();
    assert!(store.is_persisted("qoder-trace", Some("qoderTranscripts")));
    let loaded = StateStore::new(&path);
    loaded.load().await;
    assert!(loaded.is_persisted("qoder-trace", Some("qoderTranscripts")));
    assert!(loaded.delete("qoder-trace"));
    assert!(!loaded.is_persisted("qoder-trace", Some("qoderTranscripts")));
    loaded.save().await.unwrap();
    assert!(loaded.is_persisted("qoder-trace", Some("qoderTranscripts")));
}
#[tokio::test]
async fn native_deleted_receipt_tombstones_are_reclaimed_after_real_save() {
    let root = tempfile::tempdir().unwrap();
    let store = StateStore::new(root.path().join("state.json"));
    for index in 0..256 {
        store.set(
            &format!("file:{index}"),
            InputState::new().with_extra(json!({"qoderTranscripts":{"offset":index}})),
        );
    }
    store.save().await.unwrap();
    for key in store.keys() {
        assert!(store.delete(&key));
    }
    assert!(!store.is_persisted("file:255", Some("qoderTranscripts")));
    store.save().await.unwrap();
    let data = store.mu.lock().unwrap();
    assert!(data.input_revisions.is_empty());
    assert!(data.extra_revisions.is_empty());
}
#[tokio::test]
async fn native_output_failure_revokes_even_previously_written_receipts_until_restart() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    store.set(
        "qoder-trace",
        InputState::new().with_extra(json!({"qoderTranscripts":{"offset":10}})),
    );
    store.save().await.unwrap();
    assert!(store.is_persisted("qoder-trace", Some("qoderTranscripts")));
    store
        .begin_output()
        .finish(Err("actual output cancelled".into()));
    assert!(!store.is_persisted("qoder-trace", Some("qoderTranscripts")));
    assert!(store.save_failed());
    assert!(store.save().await.is_err());
    let loaded = StateStore::new(&path);
    loaded.load().await;
    assert!(loaded.is_persisted("qoder-trace", Some("qoderTranscripts")));
    assert_eq!(
        loaded.get("qoder-trace").extra().unwrap()["qoderTranscripts"]["offset"],
        10
    );
}

fn count_actual_writes(store: &StateStore, count: Arc<std::sync::atomic::AtomicUsize>) {
    store.set_write_hook(move |path, text| {
        let count = count.clone();
        async move {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            super::json_file::write_text_atomic(&path, &text).await
        }
    });
}
#[tokio::test]
async fn main_l192_every_async_hold_must_accept_before_exactly_one_shared_write() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    let writes = Arc::new(AtomicUsize::new(0));
    count_actual_writes(&store, writes.clone());
    let (codex_tx, codex_rx) = oneshot::channel::<()>();
    store.hold_save_until(async move { codex_rx.await.map_err(|e| e.to_string()) });
    store.set_offset("codex", 10.0);
    store.set_offset("other-input", 20.0);
    let mut saving = tokio::spawn({
        let store = store.clone();
        async move { store.save().await }
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(25), &mut saving)
            .await
            .is_err()
    );
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    let (later_tx, later_rx) = oneshot::channel::<()>();
    store.hold_save_until(async move { later_rx.await.map_err(|e| e.to_string()) });
    store.set_offset("codex", 30.0);
    codex_tx.send(()).unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(25), &mut saving)
            .await
            .is_err()
    );
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    later_tx.send(()).unwrap();
    saving.await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap(),
        json!({"codex":{"lastOffset":30},"other-input":{"lastOffset":20}})
    );
    store.save().await.unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn main_l216_rejected_async_hold_keeps_exact_first_failure_and_last_durable_cursor() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    let writes = Arc::new(AtomicUsize::new(0));
    count_actual_writes(&store, writes.clone());
    store.set_offset("codex", 1.0);
    store.save().await.unwrap();
    store.hold_save_until(async { Err("journal unavailable".into()) });
    store.set_offset("codex", 2.0);
    store.set_offset("other-input", 3.0);
    assert_eq!(
        store.save().await.unwrap_err().to_string(),
        "journal unavailable"
    );
    assert_eq!(
        store.save().await.unwrap_err().to_string(),
        "journal unavailable"
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap(),
        json!({"codex":{"lastOffset":1}})
    );
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn main_l229_hundred_settled_failures_release_holds_without_replacing_first_error_or_writing()
{
    use std::sync::atomic::{AtomicUsize, Ordering};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    let writes = Arc::new(AtomicUsize::new(0));
    count_actual_writes(&store, writes.clone());
    store.set_offset("codex", 1.0);
    store.save().await.unwrap();
    for attempt in 0..100 {
        store.hold_save_until(async move {
            Err(if attempt == 0 {
                "first journal failure".into()
            } else {
                "still unavailable".into()
            })
        });
        store.set_offset("codex", f64::from(attempt + 2));
        assert_eq!(
            store.save().await.unwrap_err().to_string(),
            "first journal failure"
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while store.waiting_for_output() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    assert_eq!(store.mu.lock().unwrap().output_holds, 0);
    store.hold_save_until(async { Ok(()) });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while store.waiting_for_output() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        store.save().await.unwrap_err().to_string(),
        "first journal failure"
    );
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap(),
        json!({"codex":{"lastOffset":1}})
    );
    let restarted = Arc::new(StateStore::new(&path));
    restarted.load().await;
    restarted.hold_save_until(async { Ok(()) });
    restarted.set_offset("codex", 2.0);
    restarted.save().await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap(),
        json!({"codex":{"lastOffset":2}})
    );
}
#[tokio::test]
async fn main_l253_settled_failure_rejects_noop_save_without_any_revision_or_write() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    let writes = Arc::new(AtomicUsize::new(0));
    count_actual_writes(&store, writes.clone());
    store.hold_save_until(async { Err("journal failure without state mutation".into()) });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while store.waiting_for_output() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        store.save().await.unwrap_err().to_string(),
        "journal failure without state mutation"
    );
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    assert!(!path.exists());
}
#[tokio::test]
async fn main_l261_new_hold_blocks_second_revision_after_first_actual_write_finishes() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    let writes = Arc::new(AtomicUsize::new(0));
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let finished = Arc::new(Notify::new());
    store.set_write_hook({
        let writes = writes.clone();
        let snapshots = snapshots.clone();
        let started = started.clone();
        let release = release.clone();
        let finished = finished.clone();
        move |path, text| {
            let writes = writes.clone();
            let snapshots = snapshots.clone();
            let started = started.clone();
            let release = release.clone();
            let finished = finished.clone();
            async move {
                let first = writes.fetch_add(1, Ordering::SeqCst) == 0;
                snapshots
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str::<serde_json::Value>(&text).unwrap());
                if first {
                    started.notify_one();
                    release.notified().await;
                }
                super::json_file::write_text_atomic(&path, &text).await?;
                if first {
                    finished.notify_one();
                }
                Ok(())
            }
        }
    });
    store.set_offset("codex", 1.0);
    let mut saving = tokio::spawn({
        let store = store.clone();
        async move { store.save().await }
    });
    started.notified().await;
    let (accept, accepted) = oneshot::channel::<()>();
    store.hold_save_until(async move { accepted.await.map_err(|e| e.to_string()) });
    store.set_offset("codex", 2.0);
    release.notify_one();
    finished.notified().await;
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(25), &mut saving)
            .await
            .is_err()
    );
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert_eq!(snapshots.lock().unwrap()[0]["codex"]["lastOffset"], 1);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap()
            ["codex"]["lastOffset"],
        1
    );
    accept.send(()).unwrap();
    saving.await.unwrap().unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), 2);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap()
            ["codex"]["lastOffset"],
        2
    );
}
