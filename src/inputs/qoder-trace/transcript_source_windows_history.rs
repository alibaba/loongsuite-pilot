use super::*;
fn events(f: &Fixture) -> PathBuf {
    f.root
        .join("state/qoder-transcripts")
        .join(&f.agent)
        .join("sources")
        .join(&f.key)
        .join("events")
}
async fn unread_receipt(f: &mut Fixture) -> PathBuf {
    f.write(&turn(0, false));
    f.wake("Stop", json!({}));
    let mut batch = f.collect().await.records;
    if batch.is_empty() {
        f.clock.fetch_add(6000, Ordering::SeqCst);
        batch = f.collect().await.records;
    }
    assert_eq!(user_texts(&batch), ["prompt 0"]);
    assert_eq!(f.state[&f.key]["receipts"].as_array().unwrap().len(), 1);
    let files = crate::utils::source_access::read_dir(events(f))
        .unwrap()
        .map(Result::unwrap)
        .map(|e| e.path())
        .collect::<Vec<_>>();
    assert_eq!(files.len(), 1);
    files[0].clone()
}
#[tokio::test]
async fn inventory_names_change_even_when_directory_clock_hints_are_identical() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.source.inner.lock().await.directory_inventory = true;
        unread_receipt(&mut f).await;
        f.collect().await;
        assert_eq!(
            crate::utils::source_access::read_dir(events(&f))
                .unwrap()
                .count(),
            0
        );
        let next = f.file.with_extension("replacement");
        std::fs::write(&next, jsonl(&turn(1, false))).unwrap();
        std::fs::rename(next, &f.file).unwrap();
        f.wake("Stop", json!({}));
        let current = directory_version(&events(&f), true).unwrap();
        {
            let mut collector = f.source.inner.lock().await;
            let directory = events(&f).parent().unwrap().to_path_buf();
            let cached = collector.metadata.get_mut(&directory).unwrap();
            assert_eq!(cached.version.inventory.as_ref().unwrap().len(), 0);
            // Model the actual Windows failure: equal/coalesced metadata hints,
            // while a fresh UUID notice has appeared on the real filesystem.
            cached.version.modified = current.modified;
            cached.version.changed = current.changed;
        }
        assert_eq!(
            user_texts(&f.settle().await),
            ["prompt 1"],
            "agent={agent} state={}",
            f.state
        );
        f.collect().await;
        assert_eq!(
            crate::utils::source_access::read_dir(events(&f))
                .unwrap()
                .count(),
            0
        );
        f.restart().await;
        assert!(f.settle().await.is_empty());
    }
}
#[tokio::test]
async fn durable_ack_accepts_identical_notice_content_after_metadata_only_change() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let notice = unread_receipt(&mut f).await;
        let path = notice.clone();
        let touched = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = Arc::clone(&touched);
        let fault = inject_metadata_read_fault(move |p| {
            if p == path && seen.fetch_add(1, Ordering::SeqCst) == 0 {
                let file = std::fs::OpenOptions::new().write(true).open(p).unwrap();
                let modified = file.metadata().unwrap().modified().unwrap()
                    + std::time::Duration::from_secs(1);
                file.set_times(std::fs::FileTimes::new().set_modified(modified))
                    .unwrap();
            }
        });
        f.source
            .inner
            .lock()
            .await
            .acknowledge(&f.state, &f.source.stopped);
        drop(fault);
        assert!(touched.load(Ordering::SeqCst) >= 2);
        assert!(
            !notice.exists(),
            "unchanged observation must not remain pending after durable ACK"
        );
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn durable_ack_preserves_a_changed_observation_published_during_receipt_revalidation() {
    let mut f = Fixture::new("qoder").await;
    let notice = unread_receipt(&mut f).await;
    let path = notice.clone();
    let changed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = Arc::clone(&changed);
    let fault = inject_metadata_read_fault(move |p| {
        if p == path && seen.fetch_add(1, Ordering::SeqCst) == 0 {
            let mut v: Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
            v["observationId"] = json!("replacement-not-the-acknowledged-observation");
            std::fs::write(p, serde_json::to_vec(&v).unwrap()).unwrap();
        }
    });
    f.source
        .inner
        .lock()
        .await
        .acknowledge(&f.state, &f.source.stopped);
    drop(fault);
    let kept: Value = serde_json::from_slice(&std::fs::read(notice).unwrap()).unwrap();
    assert_eq!(
        kept["observationId"],
        "replacement-not-the-acknowledged-observation"
    );
}
