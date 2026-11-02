//! f84 SLS additions at the original mocked SDK/fetch boundary, no real SLS.
use super::super::base_flusher::FlushErrorKind;
use super::super::sls_loggroup_codec::SlsLogGroupPayload;
use super::super::sls_transport::SlsHttpResponse;
use super::*;
use crate::types::{SlsEndpointKind, SlsRetryConfig};
use std::sync::atomic::AtomicUsize;
use tokio::sync::{mpsc, oneshot};

struct AkRequest {
    store: String,
    group: SlsLogGroupPayload,
    reply: oneshot::Sender<Result<(), SendError>>,
    dropped: oneshot::Receiver<()>,
}
struct WebRequest {
    body: Value,
    timeout: Duration,
    reply: oneshot::Sender<Result<SlsHttpResponse, SendError>>,
    dropped: oneshot::Receiver<()>,
}
struct Backend {
    ak: mpsc::UnboundedSender<AkRequest>,
    web: mpsc::UnboundedSender<WebRequest>,
    calls: AtomicUsize,
}
struct TransportGuard(Option<oneshot::Sender<()>>);
impl Drop for TransportGuard {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}
#[async_trait]
impl AkPoster for Backend {
    async fn post_log_store_logs(
        &self,
        _: &SlsEndpoint,
        _: &str,
        store: &str,
        group: &SlsLogGroupPayload,
        _: &str,
    ) -> Result<(), SendError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let (reply, rx) = oneshot::channel();
        let (dropped, drop_rx) = oneshot::channel();
        let _guard = TransportGuard(Some(dropped));
        self.ak
            .send(AkRequest {
                store: store.into(),
                group: group.clone(),
                reply,
                dropped: drop_rx,
            })
            .unwrap();
        rx.await
            .unwrap_or_else(|_| Err(SendError::Message("controlled reply dropped".into())))
    }
}
#[async_trait]
impl SlsHttp for Backend {
    async fn post(&self, request: SlsHttpRequest) -> Result<SlsHttpResponse, SendError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let (reply, rx) = oneshot::channel();
        let (dropped, drop_rx) = oneshot::channel();
        let _guard = TransportGuard(Some(dropped));
        self.web
            .send(WebRequest {
                body: serde_json::from_slice(&request.body).unwrap(),
                timeout: request.timeout,
                reply,
                dropped: drop_rx,
            })
            .unwrap();
        rx.await
            .unwrap_or_else(|_| Err(SendError::Message("controlled reply dropped".into())))
    }
}
struct Harness {
    _data: tempfile::TempDir,
    writer: Arc<SlsFlusher>,
    backend: Arc<Backend>,
    ak: mpsc::UnboundedReceiver<AkRequest>,
    web: mpsc::UnboundedReceiver<WebRequest>,
}
impl Harness {
    fn new(config: SlsFlusherConfig) -> Self {
        let data = tempfile::tempdir().unwrap();
        let (ak_tx, ak) = mpsc::unbounded_channel();
        let (web_tx, web) = mpsc::unbounded_channel();
        let backend = Arc::new(Backend {
            ak: ak_tx,
            web: web_tx,
            calls: AtomicUsize::new(0),
        });
        let writer = Arc::new(SlsFlusher::with_io(
            config,
            data.path().to_str().unwrap(),
            Some("synthetic-version".into()),
            backend.clone(),
            backend.clone(),
        ));
        Self {
            _data: data,
            writer,
            backend,
            ak,
            web,
        }
    }
    async fn ak(&mut self) -> AkRequest {
        tokio::time::timeout(Duration::from_secs(3), self.ak.recv())
            .await
            .unwrap()
            .unwrap()
    }
    async fn web(&mut self) -> WebRequest {
        tokio::time::timeout(Duration::from_secs(3), self.web.recv())
            .await
            .unwrap()
            .unwrap()
    }
    fn count(&self) -> usize {
        self.backend.calls.load(Ordering::SeqCst)
    }
}
fn endpoint(name: &str, mode: SlsMode, kind: SlsEndpointKind) -> SlsEndpoint {
    let mut endpoint = tests::endpoint(name, mode, "p", name, kind);
    endpoint.endpoint = "https://example.invalid".into();
    endpoint
}
fn config(endpoints: Vec<SlsEndpoint>) -> SlsFlusherConfig {
    tests::config(endpoints)
}
fn entry(id: &str, codex: bool) -> AgentActivityEntry {
    crate::normalization::build_test_entry(
        &serde_json::json!({"event.id":id,"gen_ai.agent.type":if codex {"codex"}else{"qoder"}}),
    )
}
fn ids(group: &SlsLogGroupPayload) -> Vec<String> {
    group
        .logs
        .iter()
        .map(|log| log.content["event.id"].clone())
        .collect()
}
async fn finish(task: tokio::task::JoinHandle<Result<(), FlushError>>) -> Result<(), FlushError> {
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
}
async fn dropped(receiver: oneshot::Receiver<()>) {
    tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn main_l85_cancel_before_first_poll_cannot_send_or_enqueue_the_codex_batch() {
    let h = Harness::new(config(vec![endpoint(
        "activity",
        SlsMode::Ak,
        SlsEndpointKind::AgentActivity,
    )]));
    let pending = h.writer.send_batch(vec![entry("cancelled", true)], None);
    // Rust owned futures are lazy: the input cancels the owned scope before it
    // is polled, rather than passing an already-aborted JavaScript signal.
    drop(pending);
    h.writer.flush().await.unwrap();
    assert_eq!(h.count(), 0);
    let counter = &h.writer.endpoint_counters()["activity"];
    assert_eq!(
        (counter.in_entries, counter.out_entries, counter.out_failed),
        (0, 0, 0)
    );
}
#[tokio::test(start_paused = true)]
async fn main_l94_cancelled_backoff_skips_later_endpoint_waves_after_original_thirty_seconds() {
    let mut cfg = config(vec![
        endpoint("first", SlsMode::Ak, SlsEndpointKind::AgentActivity),
        endpoint("second", SlsMode::Ak, SlsEndpointKind::AgentActivity),
    ]);
    cfg.flush_concurrency = Some(1);
    cfg.retry = Some(SlsRetryConfig {
        retry_max_attempts: Some(3),
        retry_base_delay_ms: Some(10_000),
        retry_jitter: Some(false),
    });
    let mut h = Harness::new(cfg);
    let writer = h.writer.clone();
    let task = tokio::spawn(async move { writer.send_batch(vec![entry("one", true)], None).await });
    let first = h.ak().await;
    assert_eq!(first.store, "first");
    first
        .reply
        .send(Err(SendError::Message("ECONNRESET".into())))
        .unwrap();
    dropped(first.dropped).await;
    assert_eq!(h.count(), 1);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(30_000)).await;
    tokio::task::yield_now().await;
    assert_eq!(h.count(), 1);
    assert!(h.ak.try_recv().is_err());
    assert!(h.web.try_recv().is_err());
}
#[tokio::test(start_paused = true)]
async fn main_l121_cancels_first_of_original_4097_webtracking_records_before_later_chunks() {
    let mut web = endpoint("web", SlsMode::Webtracking, SlsEndpointKind::AgentActivity);
    web.project = String::new();
    let mut h = Harness::new(config(vec![web]));
    let writer = h.writer.clone();
    let task = tokio::spawn(async move {
        writer
            .send_batch(
                (0..4097)
                    .map(|i| entry(&format!("chunk-{i}"), true))
                    .collect(),
                None,
            )
            .await
    });
    let first = h.web().await;
    assert!(
        !first.reply.is_closed(),
        "the first transport future must still own its ACK receiver"
    );
    assert_eq!(first.body["__logs__"].as_array().unwrap().len(), 4096);
    assert_eq!(first.timeout, Duration::from_millis(30_000));
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    dropped(first.dropped).await;
    assert!(
        first.reply.is_closed(),
        "cancellation must release the transport's pending receiver"
    );
    tokio::time::advance(Duration::from_millis(30_001)).await;
    tokio::task::yield_now().await;
    assert_eq!(h.count(), 1);
    assert!(h.web.try_recv().is_err());
}
#[tokio::test(start_paused = true)]
async fn main_l148_original_hundred_ms_retry_recovers_and_releases_its_wait_resources() {
    let mut cfg = config(vec![endpoint(
        "activity",
        SlsMode::Ak,
        SlsEndpointKind::AgentActivity,
    )]);
    cfg.retry = Some(SlsRetryConfig {
        retry_max_attempts: Some(3),
        retry_base_delay_ms: Some(100),
        retry_jitter: Some(false),
    });
    let mut h = Harness::new(cfg);
    let writer = h.writer.clone();
    let task = tokio::spawn(async move { writer.send_batch(vec![entry("one", true)], None).await });
    let first = h.ak().await;
    first
        .reply
        .send(Err(SendError::Message("ECONNRESET".into())))
        .unwrap();
    dropped(first.dropped).await;
    assert_eq!(h.count(), 1);
    tokio::time::advance(Duration::from_millis(100)).await;
    let second = h.ak().await;
    assert_eq!(ids(&second.group), ["one"]);
    second.reply.send(Ok(())).unwrap();
    dropped(second.dropped).await;
    finish(task).await.unwrap();
    tokio::time::advance(Duration::from_millis(30_000)).await;
    tokio::task::yield_now().await;
    assert_eq!(h.count(), 2);
    assert!(h.ak.try_recv().is_err());
    let counter = &h.writer.endpoint_counters()["activity"];
    assert_eq!((counter.out_entries, counter.out_failed), (1, 0));
}
#[tokio::test]
async fn main_l167_three_below_threshold_entries_are_counted_out_only_after_their_one_ack() {
    let mut h = Harness::new(config(vec![endpoint(
        "activity",
        SlsMode::Ak,
        SlsEndpointKind::AgentActivity,
    )]));
    let writer = h.writer.clone();
    let task = tokio::spawn(async move {
        writer
            .send_batch(
                (1..=3)
                    .map(|i| entry(&format!("codex-{i}"), true))
                    .collect(),
                None,
            )
            .await
    });
    let request = h.ak().await;
    assert_eq!(ids(&request.group), ["codex-1", "codex-2", "codex-3"]);
    assert!(!task.is_finished());
    let before = h.writer.endpoint_counters()["activity"].clone();
    assert_eq!((before.in_entries, before.out_entries), (3, 0));
    request.reply.send(Ok(())).unwrap();
    finish(task).await.unwrap();
    h.writer.flush().await.unwrap();
    let after = &h.writer.endpoint_counters()["activity"];
    assert_eq!(
        (after.in_entries, after.out_entries, after.out_failed),
        (3, 3, 0)
    );
    assert_eq!(h.count(), 1);
}
#[tokio::test]
async fn main_l188_endpoint_failure_settles_all_outputs_preserves_ordinary_queue_and_redacts_only_its_leg(
) {
    let good = endpoint("good", SlsMode::Ak, SlsEndpointKind::AgentActivity);
    let mut bad = endpoint("bad", SlsMode::Ak, SlsEndpointKind::AgentTelemetry);
    bad.redact = Some(true);
    let mut cfg = config(vec![good, bad]);
    cfg.retry = Some(SlsRetryConfig {
        retry_max_attempts: Some(1),
        retry_base_delay_ms: None,
        retry_jitter: None,
    });
    let mut h = Harness::new(cfg);
    h.writer
        .send(entry("ordinary-queued", false), None)
        .await
        .unwrap();
    let writer = h.writer.clone();
    let codex = crate::normalization::build_test_entry(&serde_json::json!({
        "event.id":"codex-failed","gen_ai.agent.type":"codex","gen_ai.tool.call.arguments":{"prompt":"body"}
    }));
    let task = tokio::spawn(async move { writer.send_batch(vec![codex], None).await });
    let a = h.ak().await;
    let b = h.ak().await;
    let (good, bad) = if a.store == "good" { (a, b) } else { (b, a) };
    assert_eq!(ids(&good.group), ["codex-failed"]);
    assert_eq!(ids(&bad.group), ["codex-failed"]);
    assert!(good.group.logs[0]
        .content
        .contains_key("gen_ai.tool.call.arguments"));
    assert!(!bad.group.logs[0]
        .content
        .contains_key("gen_ai.tool.call.arguments"));
    bad.reply
        .send(Err(SendError::Message(
            "synthetic transport failure".into(),
        )))
        .unwrap();
    dropped(bad.dropped).await;
    assert!(
        !task.is_finished(),
        "failure cannot bypass another endpoint's pending ACK"
    );
    good.reply.send(Ok(())).unwrap();
    assert_eq!(
        finish(task).await.unwrap_err().kind,
        FlushErrorKind::CodexOutputDurability
    );
    assert_eq!(h.count(), 2);
    let counters = h.writer.endpoint_counters();
    assert_eq!(
        (
            counters["good"].in_entries,
            counters["good"].out_entries,
            counters["good"].out_failed
        ),
        (2, 1, 0)
    );
    assert_eq!(
        (
            counters["bad"].in_entries,
            counters["bad"].out_entries,
            counters["bad"].out_failed
        ),
        (2, 0, 1)
    );
    let mut evidence = String::new();
    for file in std::fs::read_dir(h.writer.failed_log_directory()).unwrap() {
        evidence.push_str(&std::fs::read_to_string(file.unwrap().path()).unwrap());
    }
    assert_eq!(evidence.lines().count(), 1);
    let writer = h.writer.clone();
    let flush = tokio::spawn(async move { writer.flush().await });
    for _ in 0..2 {
        let request = h.ak().await;
        assert_eq!(ids(&request.group), ["ordinary-queued"]);
        request.reply.send(Ok(())).unwrap();
    }
    finish(flush).await.unwrap();
    assert_eq!(h.count(), 4);
}
#[tokio::test]
async fn main_l217_single_entry_waits_for_ack_and_does_not_leave_a_timer_copy() {
    let mut h = Harness::new(config(vec![endpoint(
        "activity",
        SlsMode::Ak,
        SlsEndpointKind::AgentActivity,
    )]));
    let writer = h.writer.clone();
    let task = tokio::spawn(async move { writer.send(entry("single", true), None).await });
    let request = h.ak().await;
    assert!(!task.is_finished());
    assert_eq!(ids(&request.group), ["single"]);
    request.reply.send(Ok(())).unwrap();
    finish(task).await.unwrap();
    h.writer.flush().await.unwrap();
    assert_eq!(h.count(), 1);
}
