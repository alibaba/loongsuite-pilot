use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;

#[derive(Default)]
struct Recorder {
    items: Mutex<Vec<UploadItem>>,
    closed: AtomicBool,
    close_calls: AtomicUsize,
}
#[async_trait::async_trait]
impl Uploader for Recorder {
    async fn upload(&self, item: UploadItem, _: UploadOptions) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        self.items.lock().unwrap().push(item);
        true
    }
    async fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.close_calls.fetch_add(1, Ordering::SeqCst);
    }
}
fn processor(recorder: &Arc<Recorder>) -> Arc<MultimodalProcessor> {
    MultimodalProcessor::new(Some("oss://bucket/pilot-mm"), recorder.clone(), None).unwrap()
}
fn image(root: &Path, name: &str, suffix: &[u8]) -> PathBuf {
    let path = root.join(name);
    let bytes = [b"\x89PNG\r\n\x1a\n".as_slice(), suffix].concat();
    std::fs::write(&path, bytes).unwrap();
    path
}
fn options(root: &Path) -> PathToUriOptions {
    PathToUriOptions {
        allowed_root_paths: Some(super::super::resolve::merge_allowed_root_paths(
            &[root.to_string_lossy().into_owned()],
            None,
        )),
        deadline_ms: Some(1000),
    }
}
fn before_first_read(
    processor: &mut Arc<MultimodalProcessor>,
) -> (
    Arc<tokio::sync::Notify>,
    Arc<tokio::sync::Semaphore>,
    Arc<AtomicUsize>,
) {
    let entered = Arc::new(tokio::sync::Notify::new());
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let (n, g, c) = (entered.clone(), gate.clone(), calls.clone());
    Arc::get_mut(processor).unwrap().before_read = Some(Arc::new(move |_| {
        let (n, g, c) = (n.clone(), g.clone(), c.clone());
        Box::pin(async move {
            if c.fetch_add(1, Ordering::SeqCst) == 0 {
                n.notify_one();
                g.acquire().await.unwrap().forget();
            }
        })
    }));
    (entered, gate, calls)
}
fn request(
    processor: Arc<MultimodalProcessor>,
    path: PathBuf,
    opts: PathToUriOptions,
) -> tokio::task::JoinHandle<Option<UriResult>> {
    tokio::spawn(async move {
        processor
            .path_to_uri(path.to_str().unwrap(), Some(1_700_000_000_000.0), opts)
            .await
    })
}
#[tokio::test]
async fn coalesced_path_call_never_inherits_another_callers_allowed_roots() {
    let root = tempfile::tempdir().unwrap();
    let denied = tempfile::tempdir().unwrap();
    let path = image(root.path(), "private.png", b"authorized-content");
    let recorder = Arc::new(Recorder::default());
    let mut processor = processor(&recorder);
    let (entered, gate, _) = before_first_read(&mut processor);
    let owner = request(processor.clone(), path.clone(), options(root.path()));
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    let other = request(processor.clone(), path, options(denied.path()));
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if other.is_finished()
                || processor
                    .inner
                    .lock()
                    .unwrap()
                    .path_waiters
                    .values()
                    .any(|waiters| !waiters.is_empty())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    gate.add_permits(1);
    let allowed = owner.await.unwrap();
    let rejected = other.await.unwrap();
    processor.shutdown(1000).await;
    assert!(allowed.is_some());
    assert!(
        rejected.is_none(),
        "a waiter with disjoint roots must not receive the owner's private URI"
    );
    assert_eq!(recorder.items.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn deadline_cancellation_releases_the_path_slot_and_allows_real_followup_reads() {
    let root = tempfile::tempdir().unwrap();
    let first = image(root.path(), "first.png", b"first");
    let second = image(root.path(), "second.png", b"second");
    let recorder = Arc::new(Recorder::default());
    let mut processor = processor(&recorder);
    Arc::get_mut(&mut processor).unwrap().path_inflight_limit = 1;
    let (_, gate, _) = before_first_read(&mut processor);
    let mut short = options(root.path());
    short.deadline_ms = Some(40);
    assert!(processor
        .path_to_uri(first.to_str().unwrap(), Some(1_700_000_000_000.0), short)
        .await
        .is_none());
    let other = processor
        .path_to_uri(
            second.to_str().unwrap(),
            Some(1_700_000_000_000.0),
            options(root.path()),
        )
        .await;
    gate.add_permits(1);
    let retry = processor
        .path_to_uri(
            first.to_str().unwrap(),
            Some(1_700_000_000_000.0),
            options(root.path()),
        )
        .await;
    processor.shutdown(1000).await;
    assert!(
        other.is_some(),
        "timed-out owner must release capacity for unrelated files"
    );
    assert!(
        retry.is_some(),
        "same path must have a fresh owner after deadline cancellation"
    );
    assert_eq!(recorder.items.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn aborting_the_owner_future_releases_its_read_slot_and_notifies_joiners() {
    let root = tempfile::tempdir().unwrap();
    let first = image(root.path(), "first.png", b"first");
    let second = image(root.path(), "second.png", b"second");
    let recorder = Arc::new(Recorder::default());
    let mut processor = processor(&recorder);
    Arc::get_mut(&mut processor).unwrap().path_inflight_limit = 1;
    let (entered, gate, _) = before_first_read(&mut processor);
    let mut no_deadline = options(root.path());
    no_deadline.deadline_ms = Some(0);
    let owner = request(processor.clone(), first.clone(), no_deadline.clone());
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    let waiter = request(processor.clone(), first, no_deadline);
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if processor
                .inner
                .lock()
                .unwrap()
                .path_waiters
                .values()
                .any(|waiters| !waiters.is_empty())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    owner.abort();
    assert!(owner.await.unwrap_err().is_cancelled());
    let finished = tokio::time::timeout(Duration::from_millis(100), waiter).await;
    gate.add_permits(1);
    let next = processor
        .path_to_uri(
            second.to_str().unwrap(),
            Some(1_700_000_000_000.0),
            options(root.path()),
        )
        .await;
    processor.shutdown(1000).await;
    assert!(
        matches!(finished, Ok(Ok(None))),
        "aborted owner must finish coalesced waiters instead of orphaning them"
    );
    assert!(
        next.is_some(),
        "aborted read cannot retain the sole path slot"
    );
}

#[tokio::test(start_paused = true)]
async fn deadlines_preserve_success_result_errors_disabled_races_and_the_exact_expiry_boundary() {
    assert_eq!(
        with_deadline(async { Ok::<_, &str>("ok") }, 50, || Err("late")).await,
        Ok("ok")
    );
    assert_eq!(
        with_deadline(async { Err::<&str, _>("boom") }, 50, || Err("late")).await,
        Err("boom")
    );
    for disabled in [0, -1] {
        let (sender, receiver) = oneshot::channel::<&str>();
        let task = tokio::spawn(with_deadline(
            async move { receiver.await.unwrap() },
            disabled,
            || "late",
        ));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(!task.is_finished());
        sender.send("ok").unwrap();
        assert_eq!(task.await.unwrap(), "ok");
    }
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let task = tokio::spawn(with_deadline(
        std::future::pending::<&str>(),
        30,
        move || {
            calls.fetch_add(1, Ordering::SeqCst);
            "late"
        },
    ));
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(29)).await;
    assert!(!task.is_finished());
    assert_eq!(count.load(Ordering::SeqCst), 0);
    tokio::time::advance(Duration::from_millis(1)).await;
    assert_eq!(task.await.unwrap(), "late");
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn a_real_local_image_emits_exact_uploaded_bytes_hash_mime_and_a_day_scoped_uri() {
    let root = tempfile::tempdir().unwrap();
    let path = image(root.path(), "logo.png", b"png-bytes");
    let bytes = std::fs::read(&path).unwrap();
    let recorder = Arc::new(Recorder::default());
    let processor = processor(&recorder);
    let result = processor
        .path_to_uri(
            path.to_str().unwrap(),
            Some(1_700_000_000_000.0),
            options(root.path()),
        )
        .await
        .unwrap();
    let day = chrono::DateTime::from_timestamp_millis(1_700_000_000_000)
        .unwrap()
        .with_timezone(&chrono::Local)
        .format("%Y%m%d")
        .to_string();
    let sha = hex::encode(Sha256::digest(&bytes));
    assert_eq!(result.uri, format!("oss://bucket/pilot-mm/{day}/{sha}.png"));
    assert_eq!(result.mime_type, "image/png");
    assert_eq!(result.modality.as_deref(), Some("image"));
    assert_eq!(result.size, bytes.len());
    assert_eq!(result.sha256, sha);
    processor.shutdown(1000).await;
    let items = recorder.items.lock().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].data.as_deref(), Some(bytes.as_slice()));
    assert_eq!(items[0].content_type, "image/png");
    assert_eq!(
        items[0].meta.get("mime_type").map(String::as_str),
        Some("image/png")
    );
    assert!(items[0].source_uri.is_none());
    assert_eq!(items[0].expected_size, bytes.len());
}
#[tokio::test]
async fn path_cache_is_normalized_but_never_reuses_a_uri_across_event_days() {
    let root = tempfile::tempdir().unwrap();
    let path = image(root.path(), "same.png", b"same-bytes");
    let recorder = Arc::new(Recorder::default());
    let mut processor = processor(&recorder);
    let reads = Arc::new(AtomicUsize::new(0));
    let count = reads.clone();
    Arc::get_mut(&mut processor).unwrap().before_read = Some(Arc::new(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {})
    }));
    let first = processor
        .path_to_uri(
            path.to_str().unwrap(),
            Some(1_700_000_000_000.0),
            options(root.path()),
        )
        .await
        .unwrap();
    let alias = root.path().join(".").join("same.png");
    let duplicate = processor
        .path_to_uri(
            alias.to_str().unwrap(),
            Some(1_700_000_000_000.0),
            options(root.path()),
        )
        .await
        .unwrap();
    assert_eq!(first, duplicate);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    let next = processor
        .path_to_uri(
            path.to_str().unwrap(),
            Some(1_700_086_400_000.0),
            options(root.path()),
        )
        .await
        .unwrap();
    assert_ne!(first.uri, next.uri);
    assert_eq!(first.sha256, next.sha256);
    processor.shutdown(1000).await;
    let items = recorder.items.lock().unwrap();
    assert_eq!(items.len(), 2);
    let days = items
        .iter()
        .map(|item| item.target_path.split('/').next().unwrap().to_owned())
        .collect::<Vec<_>>();
    let expected = [1_700_000_000_000_i64, 1_700_086_400_000].map(|ms| {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .with_timezone(&chrono::Local)
            .format("%Y%m%d")
            .to_string()
    });
    assert_eq!(days, expected);
}
#[tokio::test]
async fn real_path_cache_revalidates_missing_files_and_changed_size_and_mtime() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("later.png");
    let recorder = Arc::new(Recorder::default());
    let mut processor = processor(&recorder);
    let stats = Arc::new(AtomicUsize::new(0));
    let count = stats.clone();
    Arc::get_mut(&mut processor).unwrap().before_stat = Some(Arc::new(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {})
    }));
    for _ in 0..2 {
        assert!(processor
            .path_to_uri(
                path.to_str().unwrap(),
                Some(1_700_000_000_000.0),
                options(root.path())
            )
            .await
            .is_none());
    }
    assert_eq!(stats.load(Ordering::SeqCst), 2);
    assert!(recorder.items.lock().unwrap().is_empty());
    image(root.path(), "later.png", b"version-1");
    let first = processor
        .path_to_uri(
            path.to_str().unwrap(),
            Some(1_700_000_000_000.0),
            options(root.path()),
        )
        .await
        .unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap() + Duration::from_secs(1);
    image(root.path(), "later.png", b"version-2-different-bytes");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let next = processor
        .path_to_uri(
            path.to_str().unwrap(),
            Some(1_700_000_000_000.0),
            options(root.path()),
        )
        .await
        .unwrap();
    assert_ne!(first.uri, next.uri);
    processor.shutdown(1000).await;
    assert_eq!(recorder.items.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn a_full_two_path_budget_still_coalesces_an_authorized_existing_owner() {
    let root = tempfile::tempdir().unwrap();
    let paths = [
        image(root.path(), "one.png", b"one"),
        image(root.path(), "two.png", b"two"),
        image(root.path(), "three.png", b"three"),
    ];
    let recorder = Arc::new(Recorder::default());
    let mut processor = processor(&recorder);
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let reads = Arc::new(AtomicUsize::new(0));
    let (g, c) = (gate.clone(), reads.clone());
    let body = Arc::get_mut(&mut processor).unwrap();
    body.path_inflight_limit = 2;
    body.before_read = Some(Arc::new(move |_| {
        let (g, c) = (g.clone(), c.clone());
        Box::pin(async move {
            c.fetch_add(1, Ordering::SeqCst);
            g.acquire().await.unwrap().forget();
        })
    }));
    let mut opts = options(root.path());
    opts.deadline_ms = Some(0);
    let one = request(processor.clone(), paths[0].clone(), opts.clone());
    let two = request(processor.clone(), paths[1].clone(), opts.clone());
    tokio::time::timeout(Duration::from_secs(2), async {
        while reads.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(processor
        .path_to_uri(
            paths[2].to_str().unwrap(),
            Some(1_700_000_000_000.0),
            opts.clone()
        )
        .await
        .is_none());
    let duplicate = request(processor.clone(), paths[0].clone(), opts);
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if processor
                .inner
                .lock()
                .unwrap()
                .path_waiters
                .values()
                .any(|v| !v.is_empty())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    gate.add_permits(2);
    let first = one.await.unwrap().unwrap();
    assert!(two.await.unwrap().is_some());
    assert_eq!(duplicate.await.unwrap().unwrap(), first);
    processor.shutdown(1000).await;
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert_eq!(recorder.items.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn absent_disjoint_and_changed_roots_never_authorize_a_file_or_cached_uri() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let path = image(root.path(), "private.png", b"private");
    let recorder = Arc::new(Recorder::default());
    let processor = processor(&recorder);
    assert!(processor
        .path_to_uri(path.to_str().unwrap(), None, PathToUriOptions::default())
        .await
        .is_none());
    assert!(processor
        .path_to_uri(path.to_str().unwrap(), None, options(outside.path()))
        .await
        .is_none());
    assert!(processor
        .path_to_uri(path.to_str().unwrap(), None, options(root.path()))
        .await
        .is_some());
    assert!(processor
        .path_to_uri(path.to_str().unwrap(), None, options(outside.path()))
        .await
        .is_none());
    processor.shutdown(1000).await;
    assert_eq!(recorder.items.lock().unwrap().len(), 1);
}
#[cfg(unix)]
#[tokio::test]
async fn directory_symlink_escape_and_leaf_symlink_inside_the_root_never_upload() {
    let root = tempfile::tempdir().unwrap();
    let allowed = root.path().join("allowed");
    let outside = root.path().join("outside");
    std::fs::create_dir_all(&allowed).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    image(&outside, "secret.png", b"outside-secret");
    let real = image(&allowed, "real.png", b"inside-real");
    std::os::unix::fs::symlink(&outside, allowed.join("via")).unwrap();
    std::os::unix::fs::symlink(&real, allowed.join("alias.png")).unwrap();
    let recorder = Arc::new(Recorder::default());
    let processor = processor(&recorder);
    for path in [allowed.join("via/secret.png"), allowed.join("alias.png")] {
        assert!(processor
            .path_to_uri(path.to_str().unwrap(), None, options(&allowed))
            .await
            .is_none());
    }
    processor.shutdown(1000).await;
    assert!(recorder.items.lock().unwrap().is_empty());
}
#[tokio::test]
async fn image_extension_with_non_image_magic_is_rejected_before_upload() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("secret.png");
    std::fs::write(&path, b"not-an-image").unwrap();
    let recorder = Arc::new(Recorder::default());
    let processor = processor(&recorder);
    assert!(processor
        .path_to_uri(path.to_str().unwrap(), None, options(root.path()))
        .await
        .is_none());
    processor.shutdown(1000).await;
    assert!(recorder.items.lock().unwrap().is_empty());
}
#[tokio::test(start_paused = true)]
async fn a_never_settling_stat_returns_none_at_the_requested_forty_millisecond_deadline() {
    let root = tempfile::tempdir().unwrap();
    let path = image(root.path(), "hung.png", b"hung");
    let recorder = Arc::new(Recorder::default());
    let mut processor = processor(&recorder);
    Arc::get_mut(&mut processor).unwrap().before_stat =
        Some(Arc::new(|_| Box::pin(std::future::pending())));
    let mut opts = options(root.path());
    opts.deadline_ms = Some(40);
    let task = request(processor.clone(), path, opts);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(39)).await;
    assert!(!task.is_finished());
    tokio::time::advance(Duration::from_millis(1)).await;
    assert!(task.await.unwrap().is_none());
    processor.shutdown(1000).await;
    assert!(recorder.items.lock().unwrap().is_empty());
}
#[tokio::test]
async fn shutdown_rejects_new_paths_without_even_starting_the_stat_phase() {
    let root = tempfile::tempdir().unwrap();
    let path = image(root.path(), "closed.png", b"closed");
    let recorder = Arc::new(Recorder::default());
    let mut processor = processor(&recorder);
    let stats = Arc::new(AtomicUsize::new(0));
    let count = stats.clone();
    Arc::get_mut(&mut processor).unwrap().before_stat = Some(Arc::new(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {})
    }));
    processor.shutdown(1000).await;
    assert!(processor
        .path_to_uri(path.to_str().unwrap(), None, options(root.path()))
        .await
        .is_none());
    assert_eq!(stats.load(Ordering::SeqCst), 0);
    assert_eq!(recorder.close_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_timed_out_real_file_worker_retains_its_io_permit_until_late_completion_without_uploading(
) {
    struct Gate {
        entered: AtomicBool,
        entry: tokio::sync::Notify,
        released: Mutex<bool>,
        cv: std::sync::Condvar,
        watchdog_fired: AtomicBool,
    }
    struct Release {
        gate: Arc<Gate>,
        watchdog: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Release {
        fn drop(&mut self) {
            *self.gate.released.lock().unwrap() = true;
            self.gate.cv.notify_all();
            if let Some(thread) = self.watchdog.take() {
                thread.join().unwrap();
            }
        }
    }
    let root = tempfile::tempdir().unwrap();
    let path = image(root.path(), "held.png", b"held-private-image");
    let other = image(root.path(), "other.png", b"other-image");
    let recorder = Arc::new(Recorder::default());
    let mut processor = processor(&recorder);
    Arc::get_mut(&mut processor).unwrap().io_slots = Arc::new(tokio::sync::Semaphore::new(1));
    let gate = Arc::new(Gate {
        entered: AtomicBool::new(false),
        entry: tokio::sync::Notify::new(),
        released: Mutex::new(false),
        cv: std::sync::Condvar::new(),
        watchdog_fired: AtomicBool::new(false),
    });
    let worker = gate.clone();
    let (done_sender, done_receiver) = std::sync::mpsc::channel();
    let hook: super::super::resolve::ImageReadWorkerHook = Arc::new(move |entering, _| {
        if entering {
            worker.entered.store(true, Ordering::SeqCst);
            worker.entry.notify_one();
            let mut released = worker.released.lock().unwrap();
            while !*released {
                released = worker.cv.wait(released).unwrap();
            }
        } else {
            let _ = done_sender.send(());
        }
    });
    let watchdog_gate = gate.clone();
    let watchdog = std::thread::spawn(move || {
        let released = watchdog_gate.released.lock().unwrap();
        let (mut released, timeout) = watchdog_gate
            .cv
            .wait_timeout_while(released, Duration::from_millis(500), |v| !*v)
            .unwrap();
        if timeout.timed_out() && !*released {
            watchdog_gate.watchdog_fired.store(true, Ordering::SeqCst);
            *released = true;
            watchdog_gate.cv.notify_all();
            watchdog_gate.entry.notify_one();
        }
    });
    let release = Release {
        gate: gate.clone(),
        watchdog: Some(watchdog),
    };
    // Keep paused time from auto-advancing while real filesystem metadata runs.
    let keepalive = tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    });
    let owned = processor.clone();
    let mut opts = options(root.path());
    opts.deadline_ms = Some(40);
    let owner = tokio::spawn(async move {
        super::super::resolve::IMAGE_READ_WORKER_HOOK
            .scope(
                hook,
                owned.path_to_uri(path.to_str().unwrap(), Some(1_700_000_000_000.0), opts),
            )
            .await
    });
    gate.entry.notified().await;
    assert!(
        gate.entered.load(Ordering::SeqCst),
        "the real file worker must actually start"
    );
    assert!(
        !owner.is_finished(),
        "synchronous filesystem work must not pin the Tokio deadline thread until watchdog release"
    );
    tokio::time::advance(Duration::from_millis(39)).await;
    tokio::task::yield_now().await;
    assert!(!owner.is_finished());
    tokio::time::advance(Duration::from_millis(1)).await;
    assert!(owner.await.unwrap().is_none());
    assert!(!gate.watchdog_fired.load(Ordering::SeqCst));
    assert_eq!(
        processor.io_slots.available_permits(),
        0,
        "caller cancellation cannot free an active OS worker's permit"
    );
    assert!(
        processor
            .path_to_uri(
                other.to_str().unwrap(),
                Some(1_700_000_000_000.0),
                options(root.path())
            )
            .await
            .is_none(),
        "an occupied physical IO budget cannot enqueue another orphan worker"
    );
    assert!(recorder.items.lock().unwrap().is_empty());
    *gate.released.lock().unwrap() = true;
    gate.cv.notify_all();
    done_receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    let released_at = std::time::Instant::now();
    while processor.io_slots.available_permits() == 0 {
        assert!(released_at.elapsed() < Duration::from_secs(2));
        tokio::task::yield_now().await;
    }
    assert!(
        recorder.items.lock().unwrap().is_empty(),
        "late completion cannot upload"
    );
    assert!(processor
        .path_to_uri(
            other.to_str().unwrap(),
            Some(1_700_000_000_000.0),
            options(root.path())
        )
        .await
        .is_some());
    processor.shutdown(1000).await;
    assert_eq!(recorder.items.lock().unwrap().len(), 1);
    keepalive.abort();
    let _ = keepalive.await;
    drop(release);
}
