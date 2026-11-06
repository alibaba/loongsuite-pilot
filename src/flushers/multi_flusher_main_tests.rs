//! f84 MultiFlusher additions, retaining the original four parameter combinations.
use super::super::base_flusher::FlushErrorKind;
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::{Notify, Semaphore};

struct Endpoint {
    error: Option<FlushErrorKind>,
    calls: AtomicUsize,
    entered: Semaphore,
    release: Notify,
    settled: AtomicBool,
    dropped: AtomicBool,
}
impl Endpoint {
    fn new(error: Option<FlushErrorKind>) -> Arc<Self> {
        Arc::new(Self {
            error,
            calls: AtomicUsize::new(0),
            entered: Semaphore::new(0),
            release: Notify::new(),
            settled: AtomicBool::new(false),
            dropped: AtomicBool::new(false),
        })
    }
    async fn accept(&self) -> Result<(), FlushError> {
        struct Inflight<'a>(&'a Endpoint);
        impl Drop for Inflight<'_> {
            fn drop(&mut self) {
                self.0.dropped.store(true, Ordering::SeqCst);
            }
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        let _guard = Inflight(self);
        self.entered.add_permits(1);
        if let Some(kind) = self.error {
            self.settled.store(true, Ordering::SeqCst);
            return Err(FlushError {
                message: "durable output failed".into(),
                kind,
            });
        }
        self.release.notified().await;
        self.settled.store(true, Ordering::SeqCst);
        Ok(())
    }
    async fn wait_entered(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(3), self.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
}
#[async_trait]
impl BaseFlusher for Endpoint {
    fn name(&self) -> &str {
        "controlled-child"
    }
    async fn send(&self, _: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
        self.accept().await
    }
    async fn send_batch(
        &self,
        _: Vec<AgentActivityEntry>,
        _: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        self.accept().await
    }
    async fn flush(&self) -> Result<(), FlushError> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<(), FlushError> {
        Ok(())
    }
}
fn entry() -> AgentActivityEntry {
    crate::normalization::build_test_entry(&serde_json::json!({}))
}

#[tokio::test]
async fn main_l74_all_four_durable_errors_preserve_type_and_message_after_every_child_settles() {
    for (batch, kind) in [
        (false, FlushErrorKind::CodexTurnJournal),
        (true, FlushErrorKind::CodexTurnJournal),
        (false, FlushErrorKind::CodexOutputDurability),
        (true, FlushErrorKind::CodexOutputDurability),
    ] {
        let failed = Endpoint::new(Some(kind));
        let healthy = Endpoint::new(None);
        let multi = MultiFlusher::new(vec![failed.clone(), healthy.clone()]);
        let task = tokio::spawn(async move {
            if batch {
                multi.send_batch(vec![entry()], None).await
            } else {
                multi.send(entry(), None).await
            }
        });
        failed.wait_entered().await;
        healthy.wait_entered().await;
        assert!(
            !task.is_finished(),
            "durable error must wait for the healthy output"
        );
        healthy.release.notify_one();
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.kind, kind);
        assert_eq!(error.message, "durable output failed");
        assert!(error.preserves_checkpoint());
        assert_eq!(failed.calls.load(Ordering::SeqCst), 1);
        assert_eq!(healthy.calls.load(Ordering::SeqCst), 1);
        assert!(healthy.settled.load(Ordering::SeqCst));
    }
}
#[tokio::test]
async fn main_l32_input_future_cancellation_reaches_every_inflight_destination() {
    let first = Endpoint::new(None);
    let second = Endpoint::new(None);
    let multi = MultiFlusher::new(vec![first.clone(), second.clone()]);
    let task = tokio::spawn(async move { multi.send_batch(vec![entry()], None).await });
    first.wait_entered().await;
    second.wait_entered().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !first.dropped.load(Ordering::SeqCst) || !second.dropped.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    for child in [first, second] {
        assert_eq!(child.calls.load(Ordering::SeqCst), 1);
        assert!(!child.settled.load(Ordering::SeqCst));
        assert!(child.dropped.load(Ordering::SeqCst));
    }
}
