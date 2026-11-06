//! Doubao journal recovery through the production OTLP HTTP/protobuf exporter.
//! All records are synthetic, all receivers are loopback, and state is temporary.
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use loongsuite_pilot::flushers::{
    doubao_turn_journal_group_key, BaseFlusher, DoubaoTurnJournal, OtlpTraceFlusher,
};
use loongsuite_pilot::types::{AgentActivityEntry, OtlpTraceFlusherConfig};
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use prost::Message;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Receiver {
    url: String,
    received: Arc<Mutex<Vec<ExportTraceServiceRequest>>>,
    task: tokio::task::JoinHandle<()>,
    response_status: Arc<AtomicUsize>,
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
        let response_status = Arc::new(AtomicUsize::new(status as usize));
        let status_value = Arc::clone(&response_status);
        let task = tokio::spawn(async move {
            let mut sockets = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (mut socket, _) = result.unwrap();
                        let captured = Arc::clone(&captured);
                        let status_value=Arc::clone(&status_value);
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
                                let status=status_value.load(Ordering::SeqCst);
                                if status == 0 {
                                    let _ = socket.read(&mut chunk).await;
                                    return;
                                }
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
            response_status,
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
    let trace = hex::encode(Sha256::digest(session.as_bytes()))[..32].to_owned();
    (0..2).map(|i| {
        let mut value = json!({
            "event.name":"other", "event.id":format!("{session}-event-{i}"),
            "user.id":"synthetic-user", "gen_ai.agent.type":"doubao-work",
            "gen_ai.agent.id":"synthetic-actor", "gen_ai.agent.name":"Doubao Work",
            "gen_ai.provider.name":"bytedance.doubao",
            "gen_ai.session.id":session, "gen_ai.turn.id":format!("{session}:turn-1"),
            "time_unix_nano":(1_800_000_000_000_000_001u128 + i as u128 * 1_000_000).to_string(),
            "trace_id":trace, "gen_ai.framework":"doubao-work",
            "loongsuite.doubao_work.observation_scope":"client_message",
            "loongsuite.doubao_work.business_outcome":"unknown",
            "loongsuite.doubao_work.client_outcome":"received",
            "gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":"SYNTHETIC_JOURNAL_SECRET"}]}],
            "gen_ai.input.messages_delta":[],
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"SYNTHETIC_JOURNAL_SECRET"}]}],
            "fixture.original":true
        });
        if i == 0 { value["gen_ai.turn.start"] = json!(true); }
        if i == 1 && complete { value["gen_ai.turn.end"] = json!(true); }
        serde_json::from_value(value).unwrap()
    }).collect()
}

async fn pending(journal: &Arc<DoubaoTurnJournal>) -> Vec<Vec<AgentActivityEntry>> {
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
async fn native_doubao_journal_acks_only_after_every_endpoint_and_replays_using_current_privacy() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("pending");
    let journal = Arc::new(DoubaoTurnJournal::new(&dir));
    let accepted = Receiver::new(200).await;
    let failed = Receiver::new(503).await;
    let entries = records("session-endpoints", true);
    let first = OtlpTraceFlusher::new(config(root.path(), &[&accepted, &failed]))
        .unwrap()
        .with_doubao_journal(Arc::clone(&journal), Ok);
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
    let restored = Arc::new(DoubaoTurnJournal::new(&dir));
    let preparation = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&preparation);
    let second = OtlpTraceFlusher::new(config(root.path(), &[&accepted_a, &accepted_b]))
        .unwrap()
        .with_doubao_journal(Arc::clone(&restored), move |mut group| {
            calls.fetch_add(1, Ordering::SeqCst);
            for entry in &mut group {
                entry.input_messages = None;
                entry.input_messages_delta = Some(json!([]));
                entry.output_messages = None;
                entry
                    .extra
                    .insert("fixture.current_privacy".into(), json!(true));
            }
            Ok(group)
        });
    bounded(second.start()).await.unwrap();
    assert_eq!(preparation.load(Ordering::SeqCst), 1);
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
    let key = doubao_turn_journal_group_key(&entries[0]);
    let ack: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(dir.join(format!("doubao-done-{key}.json")))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ack, json!({"version":1,"key":key}));
    bounded(second.shutdown()).await.unwrap();
    drop(second);
    drop(restored);

    let third_journal = Arc::new(DoubaoTurnJournal::new(&dir));
    let third = OtlpTraceFlusher::new(config(root.path(), &[&accepted_a, &accepted_b]))
        .unwrap()
        .with_doubao_journal(Arc::clone(&third_journal), |_| {
            panic!("ACKed group must not be prepared again")
        });
    bounded(third.start()).await.unwrap();
    bounded(third.send_batch(entries, None)).await.unwrap();
    bounded(third.shutdown()).await.unwrap();
    assert_eq!(accepted_a.count(), 1, "ACKed turn was exported twice");
    assert_eq!(accepted_b.count(), 1, "ACKed turn was exported twice");
}

#[tokio::test]
async fn native_doubao_journal_obeys_current_workspace_filter_during_restart() {
    let root = tempfile::tempdir().unwrap();
    let journal = Arc::new(DoubaoTurnJournal::new(root.path().join("pending")));
    let entries = records("now-excluded-workspace", true);
    journal.append(&entries).await.unwrap();
    let receiver = Receiver::new(200).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&calls);
    let flusher = OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
        .unwrap()
        .with_doubao_journal(Arc::clone(&journal), move |group| {
            observed.fetch_add(1, Ordering::SeqCst);
            assert_eq!(group[0].session_id, "now-excluded-workspace");
            Ok(Vec::new())
        });
    bounded(flusher.start()).await.unwrap();
    bounded(flusher.shutdown()).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(receiver.count(), 0, "excluded workspace reached exporter");
    assert!(pending(&journal).await.is_empty());
    assert!(
        !journal.is_acknowledged(&entries[0]).await.unwrap(),
        "filtering must not fabricate a backend ACK"
    );
}

#[tokio::test]
async fn native_doubao_incomplete_turns_survive_eviction_flush_idle_stop_and_restart() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("pending");
    let journal = Arc::new(DoubaoTurnJournal::new(&dir));
    let receiver = Receiver::new(200).await;
    let flusher = OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
        .unwrap()
        .with_doubao_journal(Arc::clone(&journal), Ok);
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
        "unfinished Doubao turns must not be fabricated as complete"
    );
    assert_eq!(pending(&journal).await.len(), groups.len());
    for group in &groups {
        assert!(!journal.is_acknowledged(&group[0]).await.unwrap());
    }
    drop(flusher);
    drop(journal);

    let restored = Arc::new(DoubaoTurnJournal::new(&dir));
    let flusher = OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
        .unwrap()
        .with_doubao_journal(Arc::clone(&restored), Ok);
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

#[tokio::test]
async fn native_doubao_abort_during_real_export_keeps_fsynced_facts_for_fresh_process() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("pending");
    let journal = Arc::new(DoubaoTurnJournal::new(&dir));
    let hanging = Receiver::new(0).await;
    let entries = records("cancelled-export", true);
    let flusher = Arc::new(
        OtlpTraceFlusher::new(config(root.path(), &[&hanging]))
            .unwrap()
            .with_doubao_journal(journal.clone(), Ok),
    );
    let sending = flusher.clone();
    let input = entries.clone();
    let task = tokio::spawn(async move { sending.send_batch(input, None).await });
    bounded(async {
        while hanging.count() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_eq!(pending(&journal).await[0].len(), entries.len());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(!journal.is_acknowledged(&entries[0]).await.unwrap());
    drop(flusher);
    drop(journal);
    let receiver = Receiver::new(200).await;
    let journal = Arc::new(DoubaoTurnJournal::new(&dir));
    let rebuilt = OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
        .unwrap()
        .with_doubao_journal(journal.clone(), Ok);
    bounded(rebuilt.start()).await.unwrap();
    assert_eq!(receiver.count(), 1);
    assert!(journal.is_acknowledged(&entries[0]).await.unwrap());
    assert!(pending(&journal).await.is_empty());
    bounded(rebuilt.shutdown()).await.unwrap();
}

#[tokio::test]
async fn native_doubao_journal_io_failure_propagates_through_multi_and_preserves_checkpoint() {
    use loongsuite_pilot::checkpoints::StateStore;
    use loongsuite_pilot::core::{InputManager, LiveInput};
    use loongsuite_pilot::flushers::MultiFlusher;
    let root = tempfile::tempdir().unwrap();
    let state_path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&state_path));
    store.set_offset("doubao-work", 0.0);
    store.save().await.unwrap();
    let receiver = Receiver::new(200).await;
    let dir = root.path().join("blocked");
    let journal = Arc::new(DoubaoTurnJournal::new(&dir));
    let flusher = Arc::new(
        OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
            .unwrap()
            .with_doubao_journal(journal, Ok),
    );
    flusher.start().await.unwrap();
    tokio::fs::write(&dir, b"ordinary file blocking pending directory")
        .await
        .unwrap();
    let manager = Arc::new(InputManager::new());
    manager.set_state_store(store.clone());
    manager.set_user_id("synthetic-user");
    manager.set_flusher(Arc::new(MultiFlusher::new(vec![flusher])));
    manager.register_input(LiveInput::new(
        "doubao-work",
        "doubao-work",
        "session-file-polling",
        || false,
        || Box::pin(async { Ok(()) }),
        || Box::pin(async {}),
    ));
    store.set_offset("doubao-work", 1.0);
    let error = bounded(manager.accept_entries("doubao-work", records("io-failure", true)))
        .await
        .unwrap_err();
    assert!(error.contains("Doubao"));
    assert!(store.save_failed());
    assert!(store.save().await.is_err());
    let restored = StateStore::new(&state_path);
    restored.load().await;
    assert_eq!(restored.get_offset("doubao-work"), 0.0);
    assert_eq!(receiver.count(), 0);
}

fn execution(id: &str) -> Vec<AgentActivityEntry> {
    let mut rows = records("shared-request", true);
    let span = hex::encode(Sha256::digest(id.as_bytes()))[..16].to_owned();
    for (i, row) in rows.iter_mut().enumerate() {
        row.event_id = format!("{id}-{i}");
        row.agent_id = Some(id.into());
        row.turn_start = None;
        row.turn_end = None;
        row.time_unix_nano =
            (1_800_000_000_000_000_001u128 + (i as u128 + 1) * 1_000_000).to_string();
        row.extra.extend(
            json!({
                "loongsuite.doubao_work.observation_scope":"native_sandbox_execution",
                "loongsuite.doubao_work.local_execution_phase":if i==0 {"start"}else{"end"},
                "loongsuite.doubao_work.native_execution_id":id,
                "loongsuite.doubao_work.local_execution_span_id":span,
                "loongsuite.doubao_work.root_request_start_unix_nano":"1800000000000000001",
                "loongsuite.doubao_work.root_request_end_unix_nano":"1800000000010000001",
                "loongsuite.doubao_work.root_turn_id":"shared-request-turn"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
    }
    rows
}

#[tokio::test]
async fn native_doubao_executions_under_one_request_have_independent_journal_acks_and_real_task_spans(
) {
    let root = tempfile::tempdir().unwrap();
    let journal = Arc::new(DoubaoTurnJournal::new(root.path().join("pending")));
    let a = execution("execution_a");
    let b = execution("execution_b");
    assert_eq!(a[0].trace_id, b[0].trace_id);
    assert_ne!(
        doubao_turn_journal_group_key(&a[0]),
        doubao_turn_journal_group_key(&b[0])
    );
    journal
        .append(&[a.clone(), b.clone()].concat())
        .await
        .unwrap();
    assert_eq!(pending(&journal).await.len(), 2);
    let receiver = Receiver::new(200).await;
    let flusher = OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
        .unwrap()
        .with_doubao_journal(journal.clone(), Ok);
    bounded(flusher.start()).await.unwrap();
    assert_eq!(receiver.count(), 2);
    assert!(journal.is_acknowledged(&a[0]).await.unwrap());
    assert!(journal.is_acknowledged(&b[0]).await.unwrap());
    assert!(pending(&journal).await.is_empty());
    let spans = receiver
        .received
        .lock()
        .unwrap()
        .iter()
        .flat_map(|r| r.resource_spans.iter())
        .flat_map(|r| r.scope_spans.iter())
        .flat_map(|s| s.spans.iter())
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(spans.len(), 2);
    assert_ne!(spans[0].span_id, spans[1].span_id);
    for span in &spans {
        assert_eq!(span.name, "run_task doubao.local_execution");
        assert!(span.encode_to_vec().windows(4).any(|b| b == b"TASK"));
        assert!(!span.encode_to_vec().windows(3).any(|b| b == b"LLM"));
    }
    bounded(flusher.shutdown()).await.unwrap();
}

#[tokio::test]
async fn native_doubao_without_journal_reports_failed_export_and_retries_same_facts_without_false_flushed_cache(
) {
    let root = tempfile::tempdir().unwrap();
    let receiver = Receiver::new(503).await;
    let flusher = OtlpTraceFlusher::new(config(root.path(), &[&receiver])).unwrap();
    let rows = records("no-journal", true);
    for expected in 1..=2 {
        let error = bounded(flusher.send_batch(rows.clone(), Some(vec![10.0, 20.0])))
            .await
            .unwrap_err();
        assert!(error.preserves_checkpoint());
        assert!(error.to_string().contains("Doubao Work"));
        assert_eq!(receiver.count(), expected);
        let snapshot = flusher.trace_runtime_snapshot();
        let row = snapshot
            .iter()
            .find(|r| r.agent_type == "doubao-work")
            .unwrap();
        assert_eq!(
            (
                row.pending_buffers,
                row.pending_records,
                row.removed_buffers_total
            ),
            (1, 2, 0)
        );
        assert_eq!(row.pending_logical_bytes, 30.0);
        assert_eq!(row.pending_unmeasured_records, 0);
    }
}

#[tokio::test]
async fn native_doubao_cancelled_export_can_retry_in_the_same_process_without_a_false_flushed_marker(
) {
    let root = tempfile::tempdir().unwrap();
    let journal = Arc::new(DoubaoTurnJournal::new(root.path().join("pending")));
    let receiver = Receiver::new(0).await;
    let rows = records("same-process-cancel", true);
    let flusher = Arc::new(
        OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
            .unwrap()
            .with_doubao_journal(journal.clone(), Ok),
    );
    let sending = flusher.clone();
    let first = rows.clone();
    let task = tokio::spawn(async move { sending.send_batch(first, None).await });
    bounded(async {
        while receiver.count() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    receiver.response_status.store(200, Ordering::SeqCst);
    bounded(flusher.send_batch(rows.clone(), None))
        .await
        .unwrap();
    assert_eq!(receiver.count(), 2);
    assert!(journal.is_acknowledged(&rows[0]).await.unwrap());
    assert!(pending(&journal).await.is_empty());
    let snapshot = flusher.trace_runtime_snapshot();
    let row = snapshot
        .iter()
        .find(|r| r.agent_type == "doubao-work")
        .unwrap();
    assert_eq!(row.removed_unmeasured_records_total, 2);
    assert_eq!(row.removed_buffers_total, 1);
    bounded(flusher.shutdown()).await.unwrap();
}

#[tokio::test]
async fn native_doubao_replay_merges_same_id_missing_tool_content_and_parent_context_before_real_export(
) {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("pending");
    let journal = Arc::new(DoubaoTurnJournal::new(&dir));
    let original = execution("late_details");
    journal.append(&original[..1]).await.unwrap();
    let mut enriched = original.clone();
    enriched[0].parent_span_id = Some("bbbbbbbbbbbbbbbb".into());
    enriched[0].extra.extend(json!({
        "loongsuite.doubao_work.parent_resolution":"same_query_native_execution",
        "loongsuite.doubao_work.native_parent_in_request":true,
        "agent.doubao_work.task_input":"ENRICHED_REQUEST_INPUT",
        "agent.doubao_work.tool_observations":[{
            "callId":"read_late","name":"Read",
            "startNano":"1800000000001100001","endNano":"1800000000001500001",
            "status":"success","arguments":{"file_path":"readme"},"result":"ENRICHED_TOOL_RESULT"
        }]
    }).as_object().unwrap().clone());
    assert_eq!(original[0].event_id, enriched[0].event_id);
    journal.append(&enriched).await.unwrap();
    drop(journal);
    let journal = Arc::new(DoubaoTurnJournal::new(&dir));
    let receiver = Receiver::new(200).await;
    let flusher = OtlpTraceFlusher::new(config(root.path(), &[&receiver]))
        .unwrap()
        .with_doubao_journal(journal.clone(), Ok);
    bounded(flusher.start()).await.unwrap();
    assert_eq!(receiver.count(), 1);
    let spans = receiver
        .received
        .lock()
        .unwrap()
        .iter()
        .flat_map(|r| r.resource_spans.iter())
        .flat_map(|r| r.scope_spans.iter())
        .flat_map(|s| s.spans.iter())
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(spans.len(), 2);
    let task = spans
        .iter()
        .find(|s| s.name == "run_task doubao.local_execution")
        .unwrap();
    assert_eq!(
        task.parent_span_id,
        hex::decode("bbbbbbbbbbbbbbbb").unwrap()
    );
    let bytes = receiver.received.lock().unwrap()[0].encode_to_vec();
    for content in [
        b"ENRICHED_REQUEST_INPUT".as_slice(),
        b"ENRICHED_TOOL_RESULT".as_slice(),
    ] {
        assert!(bytes.windows(content.len()).any(|part| part == content));
    }
    assert!(journal.is_acknowledged(&enriched[0]).await.unwrap());
    assert!(pending(&journal).await.is_empty());
    bounded(flusher.shutdown()).await.unwrap();
}
