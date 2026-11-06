//! Codex journal recovery through the production OTLP HTTP/protobuf exporter.
//! All records are synthetic, all receivers are loopback, and state is temporary.
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use loongsuite_pilot::flushers::{
    codex_turn_journal_group_key, BaseFlusher, CodexTurnJournal, OtlpTraceFlusher,
};
use loongsuite_pilot::types::{AgentActivityEntry, OtlpTraceFlusherConfig};
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use prost::Message;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Receiver {
    url: String,
    received: Arc<Mutex<Vec<ExportTraceServiceRequest>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Receiver {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Receiver {
    async fn new(status: u16) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let received = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&received);
        let task = tokio::spawn(async move {
            let mut sockets = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (mut socket, _) = result.unwrap();
                        let captured = Arc::clone(&captured);
                        sockets.spawn(async move {
                            tokio::time::timeout(Duration::from_secs(5), async move {
                                let mut bytes = Vec::new();
                                let mut chunk = [0; 4096];
                                let end = loop {
                                    let n = socket.read(&mut chunk).await.unwrap();
                                    assert_ne!(n, 0, "OTLP request ended before headers");
                                    bytes.extend_from_slice(&chunk[..n]);
                                    assert!(bytes.len() <= 1024 * 1024);
                                    if let Some(i) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                                        break i + 4;
                                    }
                                };
                                let head = String::from_utf8(bytes[..end].to_vec()).unwrap().to_ascii_lowercase();
                                assert!(head.starts_with("post /v1/traces "));
                                assert!(head.contains("content-type: application/x-protobuf"));
                                let size: usize = head.lines().find_map(|line| line.strip_prefix("content-length:"))
                                    .unwrap().trim().parse().unwrap();
                                assert!(size <= 1024 * 1024);
                                while bytes.len() < end + size {
                                    let n = socket.read(&mut chunk).await.unwrap();
                                    assert_ne!(n, 0, "OTLP request ended before body");
                                    bytes.extend_from_slice(&chunk[..n]);
                                }
                                let request = ExportTraceServiceRequest::decode(&bytes[end..end + size]).unwrap();
                                assert!(request.resource_spans.iter().any(|resource| resource.scope_spans.iter().any(|scope| !scope.spans.is_empty())));
                                captured.lock().unwrap().push(request);
                                let response = format!("HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                socket.write_all(response.as_bytes()).await.unwrap();
                            }).await.expect("OTLP loopback request exceeded its bound");
                        });
                    }
                    result = sockets.join_next(), if !sockets.is_empty() => {
                        result.unwrap().expect("OTLP loopback receiver failed");
                    }
                }
            }
        });
        Self {
            url,
            received,
            task,
        }
    }
    fn count(&self) -> usize {
        self.received.lock().unwrap().len()
    }
}
fn config(data: &Path, endpoints: &[&Receiver]) -> OtlpTraceFlusherConfig {
    serde_json::from_value(json!({
        "enabled":true, "protocol":"http/protobuf", "serviceName":"journal-fixture",
        "endpoints":endpoints.iter().enumerate().map(|(i,r)| json!({
            "name":format!("loopback-{i}"), "endpoint":r.url, "compression":"none"
        })).collect::<Vec<_>>(),
        "dataDir":data, "turnIdleTimeoutMs":0,
        "spanAttributePassthroughPrefixes":["fixture."]
    }))
    .unwrap()
}
fn records(session: &str, complete: bool) -> Vec<AgentActivityEntry> {
    let mut entries = Vec::new();
    for (i, name) in ["llm.request", "llm.response", "other"].iter().enumerate() {
        let mut value = json!({
            "event.name":name, "event.id":format!("{session}-event-{i}"),
            "user.id":"synthetic-user", "gen_ai.agent.type":"codex",
            "gen_ai.session.id":session, "gen_ai.turn.id":format!("{session}:turn-1"),
            "gen_ai.step.id":"step:1", "gen_ai.request.model":"synthetic-model",
            "gen_ai.response.id":"synthetic-response",
            "time_unix_nano":(1_800_000_000_000_000_001u128 + i as u128 * 1000).to_string(),
            "trace_id":"1234567890abcdef1234567890abcdef",
            "gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":"SYNTHETIC_JOURNAL_SECRET"}]}],
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"SYNTHETIC_JOURNAL_SECRET"}]}],
            "fixture.original":true
        });
        if i == 0 {
            value["gen_ai.turn.start"] = json!(true);
        }
        if i == 1 {
            value["gen_ai.usage.input_tokens"] = json!(9);
            value["gen_ai.usage.output_tokens"] = json!(2);
            value["gen_ai.usage.total_tokens"] = json!(11);
            value["gen_ai.response.finish_reasons"] = json!(["stop"]);
        }
        if i == 2 && complete {
            value["gen_ai.turn.end"] = json!(true);
            value["agent.codex.turn_status"] = json!("completed");
        }
        entries.push(serde_json::from_value(value).unwrap());
    }
    entries
}
async fn pending(journal: &Arc<CodexTurnJournal>) -> Vec<Vec<AgentActivityEntry>> {
    let mut replay = journal.load(None).await.unwrap();
    let mut groups = Vec::new();
    while let Some(group) = replay.next_group().await.unwrap() {
        groups.push(group);
    }
    groups
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(3), future)
        .await
        .expect("native journal lifecycle did not settle")
}

#[tokio::test]
async fn native_codex_journal_acks_only_after_every_endpoint_and_replays_using_current_privacy() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("pending");
    let journal = Arc::new(CodexTurnJournal::new(&dir));
    let accepted = Receiver::new(200).await;
    let failed = Receiver::new(503).await;
    let entries = records("session-endpoints", true);
    let first = OtlpTraceFlusher::new(config(root.path(), &[&accepted, &failed]))
        .unwrap()
        .with_codex_journal(Arc::clone(&journal), Ok);
    bounded(first.send_batch(entries.clone(), None))
        .await
        .unwrap();
    assert_eq!(accepted.count(), 1);
    assert_eq!(failed.count(), 1);
    assert!(!journal.is_acknowledged(&entries[0]).await.unwrap());
    assert_eq!(pending(&journal).await[0].len(), entries.len());
    bounded(first.shutdown()).await.unwrap();
    drop(first);
    drop(journal);

    let accepted_a = Receiver::new(200).await;
    let accepted_b = Receiver::new(200).await;
    let restored = Arc::new(CodexTurnJournal::new(&dir));
    let preparation = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&preparation);
    let before_export_a = Arc::clone(&accepted_a.received);
    let before_export_b = Arc::clone(&accepted_b.received);
    let second = OtlpTraceFlusher::new(config(root.path(), &[&accepted_a, &accepted_b]))
        .unwrap()
        .with_codex_journal(Arc::clone(&restored), move |mut group| {
            calls.fetch_add(1, Ordering::SeqCst);
            // Whole-key preflight and streamed admission each receive the
            // original journal facts, before either endpoint can export.
            assert_eq!(group.len(), 3);
            assert!(serde_json::to_string(&group)
                .unwrap()
                .contains("SYNTHETIC_JOURNAL_SECRET"));
            assert!(before_export_a.lock().unwrap().is_empty());
            assert!(before_export_b.lock().unwrap().is_empty());
            for entry in &mut group {
                entry.input_messages = None;
                entry.input_messages_delta = None;
                entry.output_messages = None;
                entry
                    .extra
                    .insert("fixture.current_privacy".into(), json!(true));
            }
            Ok(group)
        });
    bounded(second.start()).await.unwrap();
    assert_eq!(
        preparation.load(Ordering::SeqCst),
        2,
        "preflight then admission"
    );
    assert_eq!(accepted_a.count(), 1);
    assert_eq!(accepted_b.count(), 1);
    for receiver in [&accepted_a, &accepted_b] {
        let requests = receiver.received.lock().unwrap();
        let bytes = requests[0].encode_to_vec();
        assert!(!bytes
            .windows(b"SYNTHETIC_JOURNAL_SECRET".len())
            .any(|b| b == b"SYNTHETIC_JOURNAL_SECRET"));
        assert!(bytes
            .windows(b"fixture.current_privacy".len())
            .any(|b| b == b"fixture.current_privacy"));
    }
    assert!(restored.is_acknowledged(&entries[0]).await.unwrap());
    assert!(pending(&restored).await.is_empty());
    let key = codex_turn_journal_group_key(&entries[0]);
    let ack: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(dir.join(format!("codex-done-{key}.json")))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ack, json!({"version":1,"key":key}));
    bounded(second.shutdown()).await.unwrap();
    drop(second);
    drop(restored);

    let third_journal = Arc::new(CodexTurnJournal::new(&dir));
    let third = OtlpTraceFlusher::new(config(root.path(), &[&accepted_a, &accepted_b]))
        .unwrap()
        .with_codex_journal(Arc::clone(&third_journal), |_| {
            panic!("ACKed group must not be prepared again")
        });
    bounded(third.start()).await.unwrap();
    bounded(third.send_batch(entries, None)).await.unwrap();
    bounded(third.shutdown()).await.unwrap();
    assert_eq!(accepted_a.count(), 1, "ACKed turn was exported twice");
    assert_eq!(accepted_b.count(), 1, "ACKed turn was exported twice");
}

#[tokio::test]
async fn native_codex_journal_obeys_current_workspace_filter_during_restart() {
    let root = tempfile::tempdir().unwrap();
    let journal = Arc::new(CodexTurnJournal::new(root.path().join("pending")));
    let entries = records("now-excluded-workspace", true);
    journal.append(&entries).await.unwrap();
    let receiver = Receiver::new(200).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&calls);
    let before_export = Arc::clone(&receiver.received);
    let flusher = OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
        .unwrap()
        .with_codex_journal(Arc::clone(&journal), move |group| {
            observed.fetch_add(1, Ordering::SeqCst);
            assert_eq!(group.len(), 3);
            assert_eq!(group[0].session_id, "now-excluded-workspace");
            assert!(before_export.lock().unwrap().is_empty());
            Ok(Vec::new())
        });
    bounded(flusher.start()).await.unwrap();
    bounded(flusher.shutdown()).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2, "preflight then admission");
    assert_eq!(receiver.count(), 0, "excluded workspace reached exporter");
    assert!(pending(&journal).await.is_empty());
    assert!(
        !journal.is_acknowledged(&entries[0]).await.unwrap(),
        "filtering must not fabricate a backend ACK"
    );
}

#[tokio::test]
async fn native_codex_incomplete_turns_survive_eviction_flush_idle_stop_and_restart() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("pending");
    let journal = Arc::new(CodexTurnJournal::new(&dir));
    let receiver = Receiver::new(200).await;
    let flusher = OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
        .unwrap()
        .with_codex_journal(Arc::clone(&journal), Ok);
    // Production buffers cap at 64. Seventy independent unfinished turns force
    // memory eviction while keeping every pending native turn recoverable.
    let groups: Vec<_> = (0..70)
        .map(|i| records(&format!("unfinished-{i}"), false))
        .collect();
    for group in &groups {
        bounded(flusher.send_batch(group.clone(), None))
            .await
            .unwrap();
    }
    bounded(flusher.tick_idle()).await;
    bounded(flusher.flush()).await.unwrap();
    bounded(flusher.shutdown()).await.unwrap();
    assert_eq!(
        receiver.count(),
        0,
        "unfinished Codex turns must not be fabricated as complete"
    );
    assert_eq!(pending(&journal).await.len(), groups.len());
    for group in &groups {
        assert!(!journal.is_acknowledged(&group[0]).await.unwrap());
    }
    drop(flusher);
    drop(journal);

    let restored = Arc::new(CodexTurnJournal::new(&dir));
    let flusher = OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
        .unwrap()
        .with_codex_journal(Arc::clone(&restored), Ok);
    bounded(flusher.start()).await.unwrap();
    assert_eq!(pending(&restored).await.len(), groups.len());
    // Complete an evicted turn using the same native session and turn IDs.
    let mut completion = records("unfinished-0", true).pop().unwrap();
    completion.event_id = "unfinished-0-completed".into();
    bounded(flusher.send(completion, None)).await.unwrap();
    assert_eq!(receiver.count(), 1);
    assert!(restored.is_acknowledged(&groups[0][0]).await.unwrap());
    assert_eq!(pending(&restored).await.len(), groups.len() - 1);
    bounded(flusher.shutdown()).await.unwrap();
    assert_eq!(receiver.count(), 1);
}
