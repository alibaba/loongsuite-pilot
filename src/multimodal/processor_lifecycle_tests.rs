use super::*;
use base64::Engine;
use std::sync::atomic::AtomicUsize;

#[derive(Default)]
struct LifecycleUploader {
    items: Mutex<Vec<UploadItem>>,
    attempts: AtomicUsize,
    entered: tokio::sync::Notify,
    closed: AtomicBool,
    closes: AtomicUsize,
    gate: Option<Arc<tokio::sync::Semaphore>>,
    fail_next: AtomicBool,
    panic_next: AtomicBool,
}
#[async_trait::async_trait]
impl Uploader for LifecycleUploader {
    async fn upload(&self, item: UploadItem, _: UploadOptions) -> bool {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if let Some(gate) = &self.gate {
            gate.acquire().await.unwrap().forget();
        }
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        assert!(
            !self.panic_next.swap(false, Ordering::SeqCst),
            "controlled uploader task unwind fixture"
        );
        self.items.lock().unwrap().push(item);
        !self.fail_next.swap(false, Ordering::SeqCst)
    }
    async fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
}
fn uploader(held: bool) -> Arc<LifecycleUploader> {
    Arc::new(LifecycleUploader {
        gate: held.then(|| Arc::new(tokio::sync::Semaphore::new(0))),
        ..Default::default()
    })
}
fn processor(u: &Arc<LifecycleUploader>) -> Arc<MultimodalProcessor> {
    MultimodalProcessor::new(Some("oss://bucket/pilot-mm"), u.clone(), None).unwrap()
}
fn blob(bytes: &[u8]) -> BlobToUriParams {
    BlobToUriParams {
        content: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: Some("image/png".into()),
        modality: Some("image".into()),
        time_unix_ms: Some(1_700_000_000_000.0),
        reuse_key: None,
    }
}
async fn eventually(check: impl Fn() -> bool) {
    let started = std::time::Instant::now();
    while !check() {
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "observable lifecycle transition did not finish"
        );
        tokio::task::yield_now().await;
    }
}
#[tokio::test]
async fn cancelling_the_shutdown_caller_does_not_abandon_the_accepted_close_operation() {
    let u = uploader(true);
    let p = processor(&u);
    assert!(p.blob_to_uri(blob(b"held")).is_some());
    eventually(|| u.attempts.load(Ordering::SeqCst) == 1).await;
    let owner = p.clone();
    let stop = tokio::spawn(async move { owner.shutdown(40).await });
    eventually(|| p.inner.lock().unwrap().shutting_down).await;
    stop.abort();
    assert!(stop.await.unwrap_err().is_cancelled());
    let closed = tokio::time::timeout(Duration::from_millis(200), async {
        eventually(|| u.closes.load(Ordering::SeqCst) == 1).await;
    })
    .await;
    u.gate.as_ref().unwrap().add_permits(1);
    eventually(|| p.inner.lock().unwrap().pending_bytes == 0).await;
    assert!(
        closed.is_ok(),
        "caller cancellation must not strand shutting_down before uploader.close"
    );
    assert!(p.blob_to_uri(blob(b"late")).is_none());
    assert_eq!(u.closes.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn a_concurrent_blob_cannot_be_admitted_after_the_shutdown_flag_has_committed() {
    let u = uploader(false);
    let mut p = processor(&u);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let receiver = Mutex::new(release_rx);
    Arc::get_mut(&mut p).unwrap().before_upload_admission = Some(Arc::new(move || {
        entered_tx.send(()).unwrap();
        receiver
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
    }));
    let owner = p.clone();
    let runtime = tokio::runtime::Handle::current();
    let worker = std::thread::spawn(move || {
        let _runtime = runtime.enter();
        owner.blob_to_uri(blob(b"admission-race"))
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    p.shutdown(1000).await;
    release_tx.send(()).unwrap();
    let result = worker.join().unwrap();
    tokio::task::yield_now().await;
    assert!(
        result.is_none(),
        "the authoritative enqueue lock must recheck shutdown after hashing"
    );
    assert_eq!(u.attempts.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn a_path_read_cannot_enqueue_a_relative_uri_while_the_storage_origin_is_being_relearned() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("cold.png");
    std::fs::write(&path, b"\x89PNG\r\n\x1a\nprivate").unwrap();
    let u = uploader(false);
    let resolver: Arc<dyn Fn() -> super::super::http::BoxFut<StorageBaseResult> + Send + Sync> =
        Arc::new(|| Box::pin(std::future::pending()));
    let mut p =
        MultimodalProcessor::new(Some("oss://old-bucket/pilot-mm"), u.clone(), Some(resolver))
            .unwrap();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let ready = Arc::new(tokio::sync::Notify::new());
    let (g, n) = (gate.clone(), ready.clone());
    Arc::get_mut(&mut p).unwrap().before_read = Some(Arc::new(move |_| {
        let (g, n) = (g.clone(), n.clone());
        Box::pin(async move {
            n.notify_one();
            g.acquire().await.unwrap().forget();
        })
    }));
    let owner = p.clone();
    let roots = super::super::resolve::merge_allowed_root_paths(
        &[root.path().to_string_lossy().into_owned()],
        None,
    );
    let read = tokio::spawn(async move {
        owner
            .path_to_uri(
                path.to_str().unwrap(),
                Some(1_700_000_000_000.0),
                PathToUriOptions {
                    allowed_root_paths: Some(roots),
                    deadline_ms: Some(1000),
                },
            )
            .await
    });
    tokio::time::timeout(Duration::from_millis(1000), ready.notified())
        .await
        .expect("authorized fixture must reach the read barrier within its 1000ms path deadline");
    p.note_origin_mismatch();
    assert!(p.storage_base_path().is_none());
    gate.add_permits(1);
    let result = read.await.unwrap();
    p.shutdown(1000).await;
    assert!(
        result.is_none(),
        "cold delegated origin must be checked again at final admission"
    );
    assert!(u.items.lock().unwrap().is_empty());
}
#[tokio::test(start_paused = true)]
async fn a_stopped_processor_never_invokes_its_scheduled_storage_resolver() {
    let u = uploader(false);
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let resolve: Arc<dyn Fn() -> super::super::http::BoxFut<StorageBaseResult> + Send + Sync> =
        Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                StorageBaseResult::Err {
                    error: "no origin".into(),
                }
            })
        });
    let p = MultimodalProcessor::new(None, u.clone(), Some(resolve)).unwrap();
    tokio::task::yield_now().await; // Register the constructor's scheduled timer before stopping.
    p.shutdown(1000).await;
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "a cancelled sniff timer must not perform post-stop IO"
    );
}
#[tokio::test]
async fn unwinding_an_upload_task_releases_its_dedupe_key_and_byte_budget_for_a_real_retry() {
    let u = uploader(false);
    u.panic_next.store(true, Ordering::SeqCst);
    let p = processor(&u);
    assert!(p.blob_to_uri(blob(b"unwind")).is_some());
    eventually(|| u.attempts.load(Ordering::SeqCst) == 1).await;
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    let released = p.inner.lock().unwrap().pending_bytes == 0;
    assert!(p.blob_to_uri(blob(b"unwind")).is_some());
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    p.shutdown(100).await;
    assert!(
        released,
        "task unwind must release accounting without pretending panic is a normal uploader Result"
    );
    assert_eq!(u.attempts.load(Ordering::SeqCst), 2);
    assert_eq!(u.items.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn optimistic_blob_uri_metadata_and_exact_bytes_survive_a_typed_upload_failure() {
    for fails in [false, true] {
        let u = uploader(false);
        u.fail_next.store(fails, Ordering::SeqCst);
        let p = processor(&u);
        let result = p.blob_to_uri(blob(b"hello")).unwrap();
        let sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        let day = chrono::DateTime::from_timestamp_millis(1_700_000_000_000)
            .unwrap()
            .with_timezone(&chrono::Local)
            .format("%Y%m%d")
            .to_string();
        assert_eq!(result.uri, format!("oss://bucket/pilot-mm/{day}/{sha}.png"));
        assert_eq!(result.mime_type, "image/png");
        assert_eq!(result.modality.as_deref(), Some("image"));
        assert_eq!(result.sha256, sha);
        assert_eq!(result.size, 5);
        p.shutdown(1000).await;
        let items = u.items.lock().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].target_path, format!("{day}/{sha}.png"));
        assert_eq!(items[0].content_type, "image/png");
        assert_eq!(
            items[0].meta.get("mime_type").map(String::as_str),
            Some("image/png")
        );
        assert_eq!(items[0].data.as_deref(), Some(b"hello".as_slice()));
        assert!(items[0].source_uri.is_none());
        assert_eq!(items[0].expected_size, 5);
        assert_eq!(u.attempts.load(Ordering::SeqCst), 1);
        assert_eq!(u.closes.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn malformed_overlong_and_decoded_oversize_blobs_never_enter_the_upload_queue() {
    assert_eq!(MAX_MULTIMODAL_DATA_SIZE, 30 * 1024 * 1024);
    let u = uploader(false);
    let p = processor(&u);
    let mut empty = blob(b"");
    empty.content.clear();
    assert!(p.blob_to_uri(empty).is_none());
    let mut bad = blob(b"");
    bad.content = "!!!!".into();
    assert!(p.blob_to_uri(bad).is_none());
    let mut overlong = blob(b"");
    overlong.content = "A".repeat(MAX_MULTIMODAL_BASE64_CHARS + 1);
    assert!(p.blob_to_uri(overlong).is_none());
    let huge = blob(&vec![1; MAX_MULTIMODAL_DATA_SIZE + 1]);
    assert!(
        huge.content.len() <= MAX_MULTIMODAL_BASE64_CHARS,
        "this must exercise the decoded-size gate"
    );
    assert!(p.blob_to_uri(huge).is_none());
    p.shutdown(1000).await;
    assert_eq!(u.attempts.load(Ordering::SeqCst), 0);
    assert!(u.items.lock().unwrap().is_empty());
    assert_eq!(p.inner.lock().unwrap().pending_bytes, 0);
}
#[tokio::test]
async fn the_actual_1024_upload_budget_returns_a_dangling_overflow_uri_without_enqueuing_it() {
    assert_eq!(MAX_MULTIMODAL_PENDING_UPLOADS, 1024);
    let u = uploader(true);
    let p = processor(&u);
    for i in 0..MAX_MULTIMODAL_PENDING_UPLOADS {
        assert!(p.blob_to_uri(blob(format!("img-{i}").as_bytes())).is_some());
    }
    let overflow = p.blob_to_uri(blob(b"overflow")).unwrap();
    assert!(overflow.uri.starts_with("oss://bucket/pilot-mm/"));
    assert_eq!(
        p.inner.lock().unwrap().pending.len(),
        MAX_MULTIMODAL_PENDING_UPLOADS
    );
    u.gate
        .as_ref()
        .unwrap()
        .add_permits(MAX_MULTIMODAL_PENDING_UPLOADS);
    p.shutdown(1000).await;
    let items = u.items.lock().unwrap();
    assert_eq!(items.len(), MAX_MULTIMODAL_PENDING_UPLOADS);
    assert!(items
        .iter()
        .all(|item| item.data.as_deref() != Some(b"overflow".as_slice())));
}
#[tokio::test]
async fn the_pending_byte_budget_counts_only_accepted_payloads_and_keeps_optimistic_overflow_uris()
{
    assert_eq!(MAX_MULTIMODAL_PENDING_BYTES, 1024 * 1024 * 1024);
    let u = uploader(true);
    let mut p = processor(&u);
    Arc::get_mut(&mut p).unwrap().pending_bytes_limit = 64;
    assert!(p.blob_to_uri(blob(&[1; 40])).is_some());
    assert!(p.blob_to_uri(blob(&[2; 40])).is_some());
    assert_eq!(p.inner.lock().unwrap().pending_bytes, 40);
    u.gate.as_ref().unwrap().add_permits(1);
    p.shutdown(1000).await;
    let items = u.items.lock().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].expected_size, 40);
    assert_eq!(items[0].data.as_deref(), Some([1; 40].as_slice()));
}
#[tokio::test]
async fn the_same_inflight_blob_shares_one_real_upload_and_one_pending_byte_charge() {
    let u = uploader(true);
    let p = processor(&u);
    let one = p.blob_to_uri(blob(b"dedupe")).unwrap();
    let two = p.blob_to_uri(blob(b"dedupe")).unwrap();
    assert_eq!(one, two);
    assert_eq!(p.inner.lock().unwrap().pending_bytes, 6);
    u.gate.as_ref().unwrap().add_permits(1);
    p.shutdown(1000).await;
    assert_eq!(u.attempts.load(Ordering::SeqCst), 1);
    assert_eq!(u.items.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn accepted_shutdown_drains_inflight_work_before_close_and_rejects_blobs_during_the_drain() {
    let u = uploader(true);
    let p = processor(&u);
    assert!(p.blob_to_uri(blob(b"drain-me")).is_some());
    eventually(|| u.attempts.load(Ordering::SeqCst) == 1).await;
    let owner = p.clone();
    let stop = tokio::spawn(async move {
        owner.shutdown(1000).await;
    });
    eventually(|| p.inner.lock().unwrap().shutting_down).await;
    assert_eq!(u.closes.load(Ordering::SeqCst), 0);
    assert!(p.blob_to_uri(blob(b"late")).is_none());
    u.gate.as_ref().unwrap().add_permits(1);
    stop.await.unwrap();
    assert_eq!(u.items.lock().unwrap().len(), 1);
    assert_eq!(u.closes.load(Ordering::SeqCst), 1);
    assert!(u.closed.load(Ordering::SeqCst));
    p.shutdown(1000).await;
    assert_eq!(u.closes.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn a_twenty_millisecond_shutdown_deadline_closes_once_and_late_upload_completion_stays_rejected(
) {
    let u = uploader(true);
    let p = processor(&u);
    assert!(p.blob_to_uri(blob(b"slow")).is_some());
    eventually(|| u.attempts.load(Ordering::SeqCst) == 1).await;
    p.shutdown(20).await;
    assert!(u.closed.load(Ordering::SeqCst));
    assert_eq!(u.closes.load(Ordering::SeqCst), 1);
    assert!(p.blob_to_uri(blob(b"after")).is_none());
    assert!(u.items.lock().unwrap().is_empty());
    u.gate.as_ref().unwrap().add_permits(1);
    eventually(|| p.inner.lock().unwrap().pending_bytes == 0).await;
    assert!(u.items.lock().unwrap().is_empty());
    p.shutdown(20).await;
    assert_eq!(u.closes.load(Ordering::SeqCst), 1);
}
#[tokio::test(start_paused = true)]
async fn shutdown_drops_an_already_running_storage_resolution_future() {
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let u = uploader(false);
    let started = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let (s, d) = (started.clone(), dropped.clone());
    let resolver: Arc<dyn Fn() -> super::super::http::BoxFut<StorageBaseResult> + Send + Sync> =
        Arc::new(move || {
            let (s, d) = (s.clone(), d.clone());
            Box::pin(async move {
                let _guard = Dropped(d);
                s.store(true, Ordering::SeqCst);
                std::future::pending().await
            })
        });
    let p = MultimodalProcessor::new(None, u.clone(), Some(resolver)).unwrap();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(1)).await;
    eventually(|| started.load(Ordering::SeqCst)).await;
    p.shutdown(1000).await;
    eventually(|| dropped.load(Ordering::SeqCst)).await;
    assert_eq!(u.closes.load(Ordering::SeqCst), 1);
}
