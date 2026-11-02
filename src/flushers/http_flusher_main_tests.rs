//! Actual loopback ACK/cancellation contracts added to f84 HttpFlusher.
use super::super::base_flusher::FlushErrorKind;
use super::*;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

struct Request {
    ids: Vec<String>,
    reply: oneshot::Sender<u16>,
    closed: oneshot::Receiver<()>,
}
struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Vec<String>>>>,
    rx: mpsc::UnboundedReceiver<Request>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let (tx, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let tx = tx.clone();
                let recorded = recorded.clone();
                tokio::spawn(async move {
                    let mut data = Vec::new();
                    let mut buf = [0; 4096];
                    let body = loop {
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        data.extend_from_slice(&buf[..n]);
                        let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") else {
                            continue;
                        };
                        let header = String::from_utf8_lossy(&data[..end]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                let (k, v) = line.split_once(':')?;
                                k.eq_ignore_ascii_case("content-length")
                                    .then(|| v.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        if data.len() < end + 4 + length {
                            continue;
                        }
                        break serde_json::from_slice::<Value>(&data[end + 4..end + 4 + length])
                            .unwrap();
                    };
                    let ids: Vec<String> = body["entries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|entry| entry["event.id"].as_str().unwrap().to_string())
                        .collect();
                    recorded.lock().unwrap().push(ids.clone());
                    let (reply, reply_rx) = oneshot::channel();
                    let (closed, closed_rx) = oneshot::channel();
                    if tx
                        .send(Request {
                            ids,
                            reply,
                            closed: closed_rx,
                        })
                        .is_err()
                    {
                        return;
                    }
                    tokio::select! {
                        result=reply_rx=>{
                            if let Ok(status)=result {
                                let response=format!("HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                let _=socket.write_all(response.as_bytes()).await;
                            }
                        }
                        result=socket.read(&mut buf)=>{
                            assert_eq!(result.unwrap(),0,"cancellation must close the actual request");
                            let _=closed.send(());
                        }
                    }
                });
            }
        });
        Self {
            url,
            requests,
            rx,
            task,
        }
    }
    async fn request(&mut self) -> Request {
        tokio::time::timeout(Duration::from_secs(3), self.rx.recv())
            .await
            .expect("expected immediate ACK/retry request")
            .unwrap()
    }
    fn writer(&self, interval: u64) -> Arc<HttpFlusher> {
        Arc::new(HttpFlusher::new(HttpFlusherConfig {
            enabled: true,
            url: self.url.clone(),
            headers: None,
            batch_max_size: 5,
            flush_interval_ms: interval,
            request_timeout_ms: 10_000,
        }))
    }
    fn ids(&self) -> Vec<Vec<String>> {
        self.requests.lock().unwrap().clone()
    }
}
fn entry(id: &str, codex: bool) -> AgentActivityEntry {
    crate::normalization::build_test_entry(
        &json!({"event.id":id,"gen_ai.agent.type":if codex {"codex"}else{"qoder"}}),
    )
}
async fn retained(writer: &HttpFlusher) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !writer.inner.tracked_waiting_retry.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}
async fn finish(task: tokio::task::JoinHandle<Result<(), FlushError>>) -> Result<(), FlushError> {
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
}
#[tokio::test]
async fn main_l45_batch_below_threshold_waits_for_its_one_actual_network_ack() {
    let mut server = Server::new().await;
    let writer = server.writer(99999);
    let send = writer.clone();
    let task = tokio::spawn(async move {
        send.send_batch(vec![entry("codex-1", true), entry("codex-2", true)], None)
            .await
    });
    let request = server.request().await;
    assert_eq!(request.ids, ["codex-1", "codex-2"]);
    assert!(!task.is_finished());
    request.reply.send(200).unwrap();
    finish(task).await.unwrap();
    writer.flush().await.unwrap();
    assert_eq!(
        server.ids(),
        [vec!["codex-1".to_string(), "codex-2".to_string()]]
    );
    writer.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l61_timer_keeps_ordinary_queue_separate_and_retries_only_the_failed_codex_batch() {
    let mut server = Server::new().await;
    let writer = server.writer(100);
    writer.start().await.unwrap();
    writer
        .send(entry("ordinary-queued", false), None)
        .await
        .unwrap();
    let send = writer.clone();
    let task = tokio::spawn(async move { send.send(entry("codex-retry", true), None).await });
    let failed = server.request().await;
    assert_eq!(failed.ids, ["codex-retry"]);
    failed.reply.send(500).unwrap();
    retained(&writer).await;
    assert!(!task.is_finished());
    let ordinary = server.request().await;
    assert_eq!(ordinary.ids, ["ordinary-queued"]);
    ordinary.reply.send(200).unwrap();
    let retry = server.request().await;
    assert_eq!(retry.ids, ["codex-retry"]);
    retry.reply.send(200).unwrap();
    finish(task).await.unwrap();
    writer.flush().await.unwrap();
    writer.shutdown().await.unwrap();
    assert_eq!(
        server.ids(),
        [
            vec!["codex-retry".to_string()],
            vec!["ordinary-queued".to_string()],
            vec!["codex-retry".to_string()]
        ]
    );
}
#[tokio::test]
async fn main_l82_concurrent_flush_calls_do_not_duplicate_the_inflight_codex_request() {
    let mut server = Server::new().await;
    let writer = server.writer(99999);
    let send = writer.clone();
    let task = tokio::spawn(async move { send.send(entry("one", true), None).await });
    let request = server.request().await;
    let a = writer.clone();
    let b = writer.clone();
    let first = tokio::spawn(async move { a.flush().await });
    let second = tokio::spawn(async move { b.flush().await });
    assert_eq!(server.ids().len(), 1);
    request.reply.send(200).unwrap();
    finish(task).await.unwrap();
    finish(first).await.unwrap();
    finish(second).await.unwrap();
    writer.flush().await.unwrap();
    assert_eq!(server.ids().len(), 1);
    writer.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l95_explicit_flush_drives_every_pending_codex_batch_until_its_own_ack() {
    let mut server = Server::new().await;
    let writer = server.writer(99999);
    let send = writer.clone();
    let first = tokio::spawn(async move { send.send(entry("first", true), None).await });
    let failed = server.request().await;
    failed.reply.send(500).unwrap();
    retained(&writer).await;
    let send = writer.clone();
    let second = tokio::spawn(async move { send.send(entry("second", true), None).await });
    tokio::task::yield_now().await;
    let flush = writer.clone();
    let flushing = tokio::spawn(async move { flush.flush().await });
    let retry = server.request().await;
    assert_eq!(retry.ids, ["first"]);
    assert!(!first.is_finished());
    retry.reply.send(200).unwrap();
    let next = server.request().await;
    assert_eq!(next.ids, ["second"]);
    assert!(!second.is_finished());
    next.reply.send(200).unwrap();
    finish(first).await.unwrap();
    finish(second).await.unwrap();
    finish(flushing).await.unwrap();
    assert_eq!(
        server.ids(),
        [
            vec!["first".to_string()],
            vec!["first".to_string()],
            vec!["second".to_string()]
        ]
    );
    writer.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l106_input_future_cancel_discards_retained_codex_without_a_later_retry() {
    let mut server = Server::new().await;
    let writer = server.writer(99999);
    let send = writer.clone();
    let task =
        tokio::spawn(async move { send.send_batch(vec![entry("cancelled", true)], None).await });
    server.request().await.reply.send(500).unwrap();
    retained(&writer).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    writer.flush().await.unwrap();
    assert_eq!(server.ids().len(), 1);
    writer.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l170_shutdown_rejects_retained_codex_and_flushes_the_ordinary_buffer() {
    let mut server = Server::new().await;
    let writer = server.writer(99999);
    writer.start().await.unwrap();
    let send = writer.clone();
    let task = tokio::spawn(async move { send.send(entry("failed", true), None).await });
    server.request().await.reply.send(500).unwrap();
    retained(&writer).await;
    writer.send(entry("ordinary", false), None).await.unwrap();
    let stop = writer.clone();
    let shutdown = tokio::spawn(async move { stop.shutdown().await });
    let ordinary = server.request().await;
    assert_eq!(ordinary.ids, ["ordinary"]);
    ordinary.reply.send(200).unwrap();
    assert_eq!(
        finish(task).await.unwrap_err().kind,
        FlushErrorKind::CodexOutputDurability
    );
    finish(shutdown).await.unwrap();
    assert!(writer.inner.timer.lock().unwrap().is_none());
    assert_eq!(server.ids().len(), 2);
}
#[tokio::test]
async fn main_l184_shutdown_aborts_the_actual_inflight_request_before_waiting() {
    let mut server = Server::new().await;
    let writer = server.writer(99999);
    let send = writer.clone();
    let task = tokio::spawn(async move { send.send(entry("hung", true), None).await });
    let request = server.request().await;
    tokio::time::timeout(Duration::from_secs(3), writer.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        finish(task).await.unwrap_err().kind,
        FlushErrorKind::CodexOutputDurability
    );
    tokio::time::timeout(Duration::from_secs(3), request.closed)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(server.ids().len(), 1);
}
