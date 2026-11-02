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
