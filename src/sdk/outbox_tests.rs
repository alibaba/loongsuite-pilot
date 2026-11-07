use super::*;
use crate::checkpoints::InputState;

fn settings() -> Delivery {
    Delivery {
        max_events_per_batch: 8,
        max_event_bytes: 1024,
        max_batch_bytes: 4096,
        queue_disk_bytes: 8192,
        queue_memory_bytes: 4096,
        flush_interval_ms: 1,
        retry_initial_ms: 1,
        retry_max_ms: 4,
        retry_alarm_after_ms: 1,
        ..Delivery::default()
    }
}

#[tokio::test]
async fn transaction_recovers_original_bytes_and_checkpoint_without_json_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input-state.json");
    let store = StateStore::new(&path);
    store.set("qoder-trace", InputState::new().with_last_offset(97.0));
    let original =
        br#"{"event.id":"original","extension":{"integer":"18446744073709551615"}}"#.to_vec();
    let queue = Outbox::open(dir.path(), settings()).unwrap();
    queue
        .accept(
            "source",
            &store,
            std::slice::from_ref(&original),
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
    assert!(!path.exists());
    drop(queue);
    let recovered = Outbox::open(dir.path(), settings()).unwrap();
    recovered.restore("source", &path).unwrap();
    let loaded = StateStore::new(&path);
    loaded.load().await;
    assert_eq!(loaded.get_offset("qoder-trace"), 97.0);
    let (rows, _) = recovered.read_batch(&settings()).unwrap();
    assert_eq!(rows[0].1, original);
    recovered.ack(&rows).unwrap();
    drop(recovered);
    let recovered = Outbox::open(dir.path(), settings()).unwrap();
    std::fs::remove_file(&path).unwrap();
    recovered.restore("source", &path).unwrap();
    let loaded = StateStore::new(&path);
    loaded.load().await;
    assert_eq!(loaded.get_offset("qoder-trace"), 97.0);
    assert_eq!(recovered.pending_bytes().unwrap(), 0);
}

struct Receiver {
    calls: AtomicU64,
    reply: i32,
    seen: Mutex<Vec<Vec<Vec<u8>>>>,
}
unsafe extern "C" fn receive(
    context: *mut std::ffi::c_void,
    views: *const PilotJsonView,
    count: usize,
) -> i32 {
    // SAFETY: test owns receiver until delivery thread joins; views are borrowed.
    let receiver = unsafe { &*(context as *const Receiver) };
    let rows = unsafe { std::slice::from_raw_parts(views, count) }
        .iter()
        .map(|view| unsafe { std::slice::from_raw_parts(view.data, view.len) }.to_vec())
        .collect();
    receiver.seen.lock().unwrap().push(rows);
    let call = receiver.calls.fetch_add(1, Ordering::SeqCst);
    if call == 0 {
        super::super::abi::RETRY
    } else {
        receiver.reply
    }
}
fn deliver_for(queue: Arc<Outbox>, receiver: &Receiver) {
    let context = receiver as *const _ as usize;
    let worker = queue.clone();
    let thread = std::thread::spawn(move || worker.deliver(receive, context));
    let until = Instant::now() + Duration::from_secs(2);
    while receiver.calls.load(Ordering::SeqCst) < 2 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(5));
    }
    queue.stopping.store(true, Ordering::SeqCst);
    queue.wake();
    thread.join().unwrap();
}
#[tokio::test]
async fn retry_and_ack_loss_keep_original_bytes_and_event_ids() {
    let dir = tempfile::tempdir().unwrap();
    let queue = Outbox::open(dir.path(), settings()).unwrap();
    let store = StateStore::new(dir.path().join("state"));
    let original = vec![
        br#"{"event.id":"one"}"#.to_vec(),
        br#"{"event.id":"two","unknown":[1,false,null]}"#.to_vec(),
    ];
    queue
        .accept("source", &store, &original, &AtomicBool::new(false))
        .await
        .unwrap();
    // A real SQLite write failure models ACK received before its durable removal.
    queue
        .db
        .lock()
        .unwrap()
        .execute_batch("PRAGMA query_only=ON;")
        .unwrap();
    let receiver = Receiver {
        calls: AtomicU64::new(0),
        reply: ACK,
        seen: Mutex::new(Vec::new()),
    };
    deliver_for(queue.clone(), &receiver);
    assert!(receiver.calls.load(Ordering::SeqCst) >= 2);
    assert!(receiver
        .seen
        .lock()
        .unwrap()
        .iter()
        .all(|batch| batch == &original));
    assert!(queue.pending_bytes().unwrap() > 0);
    drop(queue);
    let queue = Outbox::open(dir.path(), settings()).unwrap();
    let receiver = Receiver {
        calls: AtomicU64::new(0),
        reply: ACK,
        seen: Mutex::new(Vec::new()),
    };
    deliver_for(queue.clone(), &receiver);
    assert_eq!(queue.pending_bytes().unwrap(), 0);
    assert!(receiver
        .seen
        .lock()
        .unwrap()
        .iter()
        .all(|batch| batch == &original));
}
#[tokio::test]
async fn capacity_update_unblocks_acceptance_without_advancing_old_durable_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let mut options = settings();
    options.queue_disk_bytes = 64;
    options.max_event_bytes = 64;
    options.max_batch_bytes = 64;
    let queue = Outbox::open(dir.path(), options.clone()).unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state")));
    store.set("input", InputState::new().with_last_offset(1.0));
    queue
        .accept("source", &store, &[vec![b'x'; 48]], &AtomicBool::new(false))
        .await
        .unwrap();
    store.set("input", InputState::new().with_last_offset(2.0));
    let q = queue.clone();
    let s = store.clone();
    let task = tokio::spawn(async move {
        q.accept("source", &s, &[vec![b'y'; 48]], &AtomicBool::new(false))
            .await
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!task.is_finished());
    let text: String = queue
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT json FROM checkpoint WHERE source='source'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["input"]["lastOffset"],
        1.0
    );
    options.queue_disk_bytes = 128;
    queue.update(options);
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let text: String = queue
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT json FROM checkpoint WHERE source='source'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["input"]["lastOffset"],
        2.0
    );
}
#[tokio::test]
async fn invalid_ack_is_retry_and_corrupt_outbox_is_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let queue = Outbox::open(dir.path(), settings()).unwrap();
    let store = StateStore::new(dir.path().join("state"));
    queue
        .accept(
            "source",
            &store,
            &[br#"{"event.id":"stable"}"#.to_vec()],
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
    let receiver = Receiver {
        calls: AtomicU64::new(0),
        reply: 77,
        seen: Mutex::new(Vec::new()),
    };
    deliver_for(queue.clone(), &receiver);
    assert!(queue.pending_bytes().unwrap() > 0);
    assert!(!queue.alarm_batch().is_empty());
    drop(queue);
    let corrupt = tempfile::tempdir().unwrap();
    let bytes = b"a corrupt queue must be reported";
    std::fs::write(corrupt.path().join("delivery.sqlite"), bytes).unwrap();
    assert!(Outbox::open(corrupt.path(), settings()).is_err());
    assert_eq!(
        std::fs::read(corrupt.path().join("delivery.sqlite")).unwrap(),
        bytes
    );
}
