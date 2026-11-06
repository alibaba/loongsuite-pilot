//! Real native transcript → manager → loopback HTTP acceptance and restart.
use chrono::{Datelike, TimeZone};
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::core::{InputManager, LiveInput};
use loongsuite_pilot::flushers::{BaseFlusher, HttpFlusher};
use loongsuite_pilot::inputs::base::InputBody;
use loongsuite_pilot::inputs::doubao_work::{
    DoubaoWorkBudgetOptions, DoubaoWorkInput, DoubaoWorkInputOptions,
};
use loongsuite_pilot::types::HttpFlusherConfig;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Receiver {
    url: String,
    healthy: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    disconnected: Arc<AtomicUsize>,
    accepted: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Receiver {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Receiver {
    async fn new(hang: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let healthy = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let disconnected = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::new(Mutex::new(Vec::new()));
        let (health, count, closed, received) = (
            healthy.clone(),
            requests.clone(),
            disconnected.clone(),
            accepted.clone(),
        );
        let task = tokio::spawn(async move {
            let mut sockets = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (mut socket, _) = result.unwrap();
                        let (health, count, closed, received) = (health.clone(), count.clone(), closed.clone(), received.clone());
                        sockets.spawn(async move {
                            tokio::time::timeout(Duration::from_secs(10), async move {
                                let mut bytes = Vec::new();
                                let mut chunk = [0u8; 4096];
                                let end = loop {
                                    let size = socket.read(&mut chunk).await.unwrap();
                                    if size == 0 { return; }
                                    bytes.extend_from_slice(&chunk[..size]);
                                    assert!(bytes.len() < 1024 * 1024);
                                    if let Some(i) = bytes.windows(4).position(|b| b == b"\r\n\r\n") { break i + 4; }
                                };
                                let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                                let length: usize = headers.lines().find_map(|s| s.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                                while bytes.len() < end + length {
                                    let size = socket.read(&mut chunk).await.unwrap();
                                    if size == 0 { return; }
                                    bytes.extend_from_slice(&chunk[..size]);
                                    assert!(bytes.len() < 1024 * 1024);
                                }
                                count.fetch_add(1, Ordering::SeqCst);
                                if hang {
                                    if socket.read(&mut chunk).await.unwrap_or(0) == 0 { closed.fetch_add(1, Ordering::SeqCst); }
                                    return;
                                }
                                let status = if health.load(Ordering::SeqCst) {
                                    received.lock().unwrap().push(serde_json::from_slice(&bytes[end..end+length]).unwrap());
                                    "200 OK"
                                } else { "503 Unavailable" };
                                let response = format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
                                let _ = socket.write_all(response.as_bytes()).await;
                            }).await.expect("loopback HTTP socket did not settle");
                        });
                    }
                    result = sockets.join_next(), if !sockets.is_empty() => {
                        result.unwrap().expect("loopback HTTP task failed");
                    }
                }
            }
        });
        Self {
            url,
            healthy,
            requests,
            disconnected,
            accepted,
            task,
        }
    }
}
async fn eventually(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("native pipeline condition did not settle");
}

fn config(url: &str) -> HttpFlusherConfig {
    serde_json::from_value(json!({"enabled":true,"url":url,"batchMaxSize":100,"flushIntervalMs":10,"requestTimeoutMs":60000})).unwrap()
}
fn pipeline(
    root: &Path,
    store: Arc<StateStore>,
    url: &str,
) -> (Arc<DoubaoWorkInput>, Arc<InputManager>, Arc<HttpFlusher>) {
    let input = Arc::new(DoubaoWorkInput::new(DoubaoWorkInputOptions {
        log_dir: Some(root.join("logs").to_string_lossy().into_owned()),
        sessions_root: Some(root.join("native").to_string_lossy().into_owned()),
        snapshot_root: Some(root.join("snapshots").to_string_lossy().into_owned()),
        poll_interval_ms: Some(60000),
        native_scan_interval_ms: Some(0),
        work_budget: Some(DoubaoWorkBudgetOptions {
            milliseconds: 1000,
            ..Default::default()
        }),
        ..DoubaoWorkInputOptions::new(store.clone())
    }));
    let http = Arc::new(HttpFlusher::new(config(url)));
    let manager = Arc::new(InputManager::new());
    manager.set_state_store(store);
    manager.set_flusher(http.clone());
    manager.set_user_id("synthetic-user");
    let (running, start, stop) = (input.clone(), input.clone(), input.clone());
    manager.register_input(LiveInput::new(
        "doubao-work",
        "doubao-work",
        "session-file-polling",
        move || running.collector_running(),
        move || {
            let input = start.clone();
            Box::pin(async move { input.start().await })
        },
        move || {
            let input = stop.clone();
            Box::pin(async move {
                input.stop().await.unwrap();
            })
        },
    ));
    let weak = Arc::downgrade(&manager);
    input.on_entries(move |entries| {
        if let Some(manager) = weak.upgrade() {
            manager.bind_entries("doubao-work", entries.to_vec());
        }
    });
    (input, manager, http)
}
fn log_name(query: i64) -> String {
    let d = chrono::Local.timestamp_millis_opt(query).single().unwrap();
    format!(
        "saman_frontend_{}.{:02}{:02}.0.log",
        d.year(),
        d.month(),
        d.day()
    )
}
fn line(query: i64, turn: &str, event: &str, elapsed: i64) -> String {
    let at = chrono::Local
        .timestamp_millis_opt(query + elapsed)
        .single()
        .unwrap();
    let payload = json!({"version":1,"type":"event","level":"info","eventName":event,"meta":{"chat_session_id":turn,"query_send_timestamp":query,"conversation_id":"12345678","send_local_message_id":"00000000-0000-4000-8000-000000000002","session_success":"1","receive_success":"1","prompt":"LOG_PRIVATE_SENTINEL"}});
    format!("[100:200:{}123:INFO:FRONTEND(0)] [neotix] [office-api-logger] \"[webview][unknown][flow-web][logifier-report]: {}\", source: (0)\n",at.format("%m%d/%H%M%S.%3f"),payload)
}
fn tool(query: i64, received: bool) -> String {
    let at = chrono::Local
        .timestamp_millis_opt(query + if received { 100 } else { 200 })
        .single()
        .unwrap();
    let data = if received {
        json!({"name":"Read","sandbox_id":"synthetic-sandbox","status":"received","tcid":"fresh-call","agent_id":"fresh-turn"})
    } else {
        json!({"name":"Read","sandbox_id":"synthetic-sandbox","status":"success","toolCallID":"fresh-call","phase":"execution_settled"})
    };
    format!("[100:200:{}123:INFO:FRONTEND(0)] [neotix] [agent-task] \"{}\", source: local-file-local-tools-sse-wiring.ts (0)\n",at.format("%m%d/%H%M%S.%3f"),json!({"event":"toolcall","data":data}))
}
async fn native(root: &Path, query: i64) {
    let system = root.join("native/12345678/agents/m_current/system");
    tokio::fs::create_dir_all(&system).await.unwrap();
    let rows = [
        json!({"role":"assistant","content":"FRESH_PLAN","tool_calls":[{"id":"fresh-call","function":{"name":"Read","arguments":{"file_path":"FRESH_FILE"}}}]}),
        json!({"role":"tool","tool_call_id":"fresh-call","content":"FRESH_TOOL_RESULT"}),
        json!({"role":"assistant","content":"FRESH_FINAL"}),
    ];
    let source = rows
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    tokio::fs::write(system.join("trajectory.jsonl"), source)
        .await
        .unwrap();
    tokio::fs::write(
        system.join("assignment.md"),
        format!(
            "## [{}] 需求\nFRESH_REQUEST\n",
            chrono::Utc
                .timestamp_millis_opt(query + 10)
                .single()
                .unwrap()
                .to_rfc3339()
        ),
    )
    .await
    .unwrap();
}
async fn has_key(path: &Path) -> bool {
    serde_json::from_slice::<Value>(&tokio::fs::read(path).await.unwrap())
        .unwrap()
        .get("doubao-work")
        .is_some()
}
fn proof_snapshot(root: &Path) -> Vec<(String, Vec<u8>)> {
    fn visit(base: &Path, path: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        if !path.exists() {
            return;
        }
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let p = entry.path();
            let kind = entry.file_type().unwrap();
            assert!(!kind.is_symlink());
            if kind.is_dir() {
                visit(base, &p, out)
            } else {
                out.push((
                    p.strip_prefix(base).unwrap().to_string_lossy().into_owned(),
                    std::fs::read(p).unwrap(),
                ));
            }
        }
    }
    let mut entries = Vec::new();
    visit(root, &root.join(".pilot-source-ownership"), &mut entries);
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}
async fn append(path: &Path, text: &str) {
    tokio::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .await
        .unwrap()
        .write_all(text.as_bytes())
        .await
        .unwrap();
}
fn assert_fresh_facts(receiver: &Receiver, query: i64) {
    let bodies = receiver.accepted.lock().unwrap();
    let entries: Vec<_> = bodies
        .iter()
        .flat_map(|v| v["entries"].as_array().unwrap().iter())
        .collect();
    assert_eq!(entries.len(), 5);
    assert_eq!(
        entries
            .iter()
            .filter(|e| e["event.name"] == "agent.input")
            .count(),
        1
    );
    assert_eq!(
        entries
            .iter()
            .filter(|e| e["event.name"] == "other")
            .count(),
        2
    );
    assert_eq!(
        entries
            .iter()
            .filter(|e| e["event.name"] == "tool.call")
            .count(),
        1
    );
    assert_eq!(
        entries
            .iter()
            .filter(|e| e["event.name"] == "tool.result")
            .count(),
        1
    );
    let ids: BTreeSet<_> = entries.iter().map(|e| e["event.id"].to_string()).collect();
    assert_eq!(ids.len(), 5);
    for name in ["other", "tool.call", "tool.result"] {
        assert!(entries.iter().any(|e| e["event.name"] == name), "{name}")
    }
    assert!(entries.iter().all(|e| e["gen_ai.turn.id"] == "fresh-turn"));
    assert!(entries
        .iter()
        .any(|e| e["time_unix_nano"] == (i128::from(query) * 1_000_000).to_string()));
    let serialized = serde_json::to_string(&*bodies).unwrap();
    for fact in [
        "FRESH_REQUEST",
        "FRESH_FINAL",
        "FRESH_FILE",
        "FRESH_TOOL_RESULT",
    ] {
        assert!(serialized.contains(fact), "{fact}")
    }
    for excluded in [
        "historical-turn",
        "LOG_PRIVATE_SENTINEL",
        "gen_ai.request.model",
        "gen_ai.usage",
    ] {
        assert!(!serialized.contains(excluded), "{excluded}")
    }
}
async fn baseline_failure_then_http_cancel(mode: &str, rotate: bool, fresh_rotation: bool) {
    let root = tempfile::tempdir().unwrap();
    let logs = root.path().join("logs");
    tokio::fs::create_dir(&logs).await.unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    let history = line(
        now + 60_000,
        "historical-turn",
        "on_message_session_start",
        10,
    ) + &line(
        now + 60_000,
        "historical-turn",
        "on_message_session_end",
        3000,
    );
    let source = logs.join(log_name(now));
    tokio::fs::write(&source, &history).await.unwrap();
    let state_path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&state_path));
    store.set_offset("unrelated-source", 7.0);
    store.save().await.unwrap();
    let hanging = Receiver::new(true).await;
    let (input, manager, http) = pipeline(root.path(), store.clone(), &hanging.url);
    http.start().await.unwrap();
    assert!(input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap()
        .is_empty());
    assert!(!has_key(&state_path).await);
    let proof_before = proof_snapshot(root.path());
    assert_eq!(proof_before.len(), 2);
    let original_since = store.get("doubao-work").extra().unwrap()["doubaoWork"]["sinceMs"]
        .as_i64()
        .unwrap();
    let floor = proof_before
        .iter()
        .map(|(_, b)| serde_json::from_slice::<Value>(b).unwrap())
        .find(|v| v.get("floor").is_some())
        .unwrap();
    assert_eq!(floor["floor"]["offset"], history.len());
    for (_, bytes) in &proof_before {
        let text = String::from_utf8(bytes.clone()).unwrap();
        for disallowed in [
            "LOG_PRIVATE_SENTINEL",
            "historical-turn",
            "lastOffset",
            "scanOffset",
            "pending",
            "completed",
        ] {
            assert!(!text.contains(disallowed), "{disallowed}");
        }
    }
    if mode == "save-cancel" {
        let blocker = store.begin_output();
        let saving = {
            let store = store.clone();
            tokio::spawn(async move { store.save().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!saving.is_finished());
        saving.abort();
        assert!(saving.await.unwrap_err().is_cancelled());
        blocker.finish(Ok(()));
    } else {
        let backup = state_path.with_extension("saved");
        tokio::fs::rename(&state_path, &backup).await.unwrap();
        tokio::fs::create_dir(&state_path).await.unwrap();
        assert!(store.save().await.is_err());
        tokio::fs::remove_dir(&state_path).await.unwrap();
        tokio::fs::rename(backup, &state_path).await.unwrap();
    }
    assert!(!has_key(&state_path).await);
    assert_eq!(proof_snapshot(root.path()), proof_before);
    let query = chrono::Utc::now().timestamp_millis().max(original_since);
    native(root.path(), query).await;
    let source = if fresh_rotation {
        let next = source.with_file_name(
            source
                .file_name()
                .unwrap()
                .to_string_lossy()
                .replace(".0.log", ".1.log"),
        );
        tokio::fs::write(&next, "").await.unwrap();
        next
    } else {
        source
    };
    append(
        &source,
        &(line(query, "fresh-turn", "on_message_session_start", 10)
            + &tool(query, true)
            + &tool(query, false)
            + &line(query, "fresh-turn", "on_message_session_end", 3000)),
    )
    .await;
    input.run_cycle().await;
    eventually(|| hanging.requests.load(Ordering::SeqCst) > 0).await;
    assert!(store.waiting_for_output());
    assert!(!has_key(&state_path).await);
    let proof_after_output = proof_snapshot(root.path());
    assert_eq!(proof_after_output.len(), if fresh_rotation { 3 } else { 2 });
    for item in &proof_before {
        assert!(
            proof_after_output.contains(item),
            "initial exclusion proof changed"
        );
    }
    manager.cancel_pending_outputs();
    tokio::time::timeout(Duration::from_secs(1), manager.stop_all())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), http.shutdown())
        .await
        .unwrap()
        .unwrap();
    eventually(|| hanging.disconnected.load(Ordering::SeqCst) > 0).await;
    assert!(store.save_failed());
    assert!(store.save().await.is_err());
    assert!(!has_key(&state_path).await);
    // A different key saves the same canonical file without carrying any failed-input memory.
    let other = StateStore::new(&state_path);
    other.load().await;
    other.set_offset("additional-source", 11.0);
    other.save().await.unwrap();
    assert!(!has_key(&state_path).await);
    assert_eq!(proof_snapshot(root.path()), proof_after_output);
    let current_source = if rotate {
        let rotated = source.with_file_name(
            source
                .file_name()
                .unwrap()
                .to_string_lossy()
                .replace(".0.log", ".1.log"),
        );
        tokio::fs::rename(&source, &rotated).await.unwrap();
        rotated
    } else {
        source.clone()
    };
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert!(chrono::Utc::now().timestamp_millis() > query);
    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let restored = Arc::new(StateStore::new(&state_path));
    restored.load().await;
    assert!(restored.get("doubao-work").extra().is_none());
    let (restarted, manager, http) = pipeline(root.path(), restored.clone(), &receiver.url);
    http.start().await.unwrap();
    restarted.run_cycle().await;
    assert_eq!(
        restored.get("doubao-work").extra().unwrap()["doubaoWork"]["sinceMs"],
        original_since
    );
    for _ in 0..8 {
        restarted.run_cycle().await;
        if receiver.requests.load(Ordering::SeqCst) > 0 {
            break;
        }
    }
    tokio::time::timeout(Duration::from_secs(3), restored.save())
        .await
        .unwrap()
        .unwrap();
    eventually(|| receiver.requests.load(Ordering::SeqCst) > 0).await;
    assert_fresh_facts(&receiver, query);
    let checkpoint = restored.get("doubao-work").extra().unwrap();
    let name = current_source.file_name().unwrap().to_string_lossy();
    assert_eq!(
        checkpoint["doubaoWork"]["files"][name.as_ref()]["offset"],
        tokio::fs::metadata(&current_source).await.unwrap().len()
    );
    assert_eq!(restored.get("unrelated-source").last_offset(), Some(7.0));
    assert_eq!(restored.get("additional-source").last_offset(), Some(11.0));
    let accepted = receiver.accepted.lock().unwrap().len();
    restarted.run_cycle().await;
    restored.save().await.unwrap();
    assert_eq!(receiver.accepted.lock().unwrap().len(), accepted);
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}
#[tokio::test]
async fn native_doubao_unsaved_historical_floor_survives_save_cancel_then_real_http_cancel() {
    baseline_failure_then_http_cancel("save-cancel", false, false).await;
}
#[tokio::test]
async fn native_doubao_unsaved_historical_floor_survives_real_save_failure_then_http_cancel_and_rename(
) {
    baseline_failure_then_http_cancel("save-failure", true, false).await;
}

#[tokio::test]
async fn native_doubao_initial_history_is_still_excluded_even_with_future_query_timestamps() {
    let root = tempfile::tempdir().unwrap();
    let logs = root.path().join("logs");
    tokio::fs::create_dir(&logs).await.unwrap();
    let query = chrono::Utc::now().timestamp_millis() + 60_000;
    let source = logs.join(log_name(query));
    let history = line(query, "historical-turn", "on_message_session_start", 10)
        + &line(query, "historical-turn", "on_message_session_end", 3000);
    tokio::fs::write(&source, &history).await.unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let (input, manager, http) = pipeline(root.path(), store.clone(), &receiver.url);
    http.start().await.unwrap();
    input.run_cycle().await;
    input.run_cycle().await;
    store.save().await.unwrap();
    assert_eq!(receiver.requests.load(Ordering::SeqCst), 0);
    assert_eq!(
        store.get("doubao-work").extra().unwrap()["doubaoWork"]["files"]
            [source.file_name().unwrap().to_str().unwrap()]["offset"],
        history.len()
    );
    assert_eq!(proof_snapshot(root.path()).len(), 2);
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}
#[tokio::test]
async fn native_doubao_replaced_or_copied_source_cannot_use_original_floor_after_unsaved_baseline()
{
    let root = tempfile::tempdir().unwrap();
    let logs = root.path().join("logs");
    tokio::fs::create_dir(&logs).await.unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    let source = logs.join(log_name(now));
    let history = line(
        now + 60_000,
        "historical-turn",
        "on_message_session_start",
        10,
    ) + &line(
        now + 60_000,
        "historical-turn",
        "on_message_session_end",
        3000,
    );
    tokio::fs::write(&source, &history).await.unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    store.set_offset("unrelated-source", 7.0);
    store.save().await.unwrap();
    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let (input, manager, http) = pipeline(root.path(), store.clone(), &receiver.url);
    http.start().await.unwrap();
    assert!(input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap()
        .is_empty());
    assert!(!has_key(&path).await);
    // Keep the original inode alive. A byte-identical historical prefix is deliberately insufficient.
    tokio::fs::rename(&source, source.with_extension("kept-original"))
        .await
        .unwrap();
    let copied = history.clone()
        + &line(now + 1, "fresh-turn", "on_message_session_start", 10)
        + &line(now + 1, "fresh-turn", "on_message_session_end", 3000);
    tokio::fs::write(&source, &copied).await.unwrap();
    let restored = Arc::new(StateStore::new(&path));
    restored.load().await;
    let (restarted, other_manager, other_http) =
        pipeline(root.path(), restored.clone(), &receiver.url);
    other_http.start().await.unwrap();
    restarted.run_cycle().await;
    restarted.run_cycle().await;
    restored.save().await.unwrap();
    assert_eq!(receiver.requests.load(Ordering::SeqCst), 0);
    assert_eq!(
        restored.get("doubao-work").extra().unwrap()["doubaoWork"]["files"]
            [source.file_name().unwrap().to_str().unwrap()]["offset"],
        copied.len()
    );
    assert_eq!(proof_snapshot(root.path()).len(), 3);
    other_manager.cancel_pending_outputs();
    other_manager.stop_all().await;
    other_http.shutdown().await.unwrap();
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}
#[tokio::test]
async fn native_doubao_ownership_write_failure_and_corrupt_floor_cannot_emit_or_advance_state() {
    for corrupt in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        tokio::fs::create_dir(&logs).await.unwrap();
        let query = chrono::Utc::now().timestamp_millis();
        let source = logs.join(log_name(query));
        let history = line(
            query + 60_000,
            "historical-turn",
            "on_message_session_start",
            10,
        ) + &line(
            query + 60_000,
            "historical-turn",
            "on_message_session_end",
            3000,
        );
        tokio::fs::write(&source, &history).await.unwrap();
        let state_path = root.path().join("state.json");
        let store = Arc::new(StateStore::new(&state_path));
        store.set_offset("unrelated-source", 7.0);
        store.save().await.unwrap();
        let receiver = Receiver::new(false).await;
        receiver.healthy.store(true, Ordering::SeqCst);
        let (input, manager, http) = pipeline(root.path(), store.clone(), &receiver.url);
        http.start().await.unwrap();
        if corrupt {
            assert!(input
                .inner
                .body
                .collect(&input.inner.runtime)
                .await
                .unwrap()
                .is_empty());
            let proof = proof_snapshot(root.path())
                .into_iter()
                .find(|(name, _)| !name.ends_with("installation.json"))
                .unwrap();
            tokio::fs::write(root.path().join(proof.0), "{half")
                .await
                .unwrap();
        } else {
            tokio::fs::write(root.path().join(".pilot-source-ownership"), "blocked")
                .await
                .unwrap();
        }
        append(
            &source,
            &(line(query + 1, "fresh-turn", "on_message_session_start", 10)
                + &line(query + 1, "fresh-turn", "on_message_session_end", 3000)),
        )
        .await;
        let fresh = Arc::new(StateStore::new(&state_path));
        fresh.load().await;
        let (restarted, other_manager, other_http) =
            pipeline(root.path(), fresh.clone(), &receiver.url);
        other_http.start().await.unwrap();
        assert!(restarted
            .inner
            .body
            .collect(&restarted.inner.runtime)
            .await
            .is_err());
        assert!(fresh.get("doubao-work").extra().is_none());
        assert_eq!(receiver.requests.load(Ordering::SeqCst), 0);
        fresh.save().await.unwrap();
        assert!(!has_key(&state_path).await);
        assert_eq!(fresh.get("unrelated-source").last_offset(), Some(7.0));
        other_manager.cancel_pending_outputs();
        other_manager.stop_all().await;
        other_http.shutdown().await.unwrap();
        manager.cancel_pending_outputs();
        manager.stop_all().await;
        http.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn native_doubao_fresh_rotation_without_canonical_key_recovers_live_claim() {
    baseline_failure_then_http_cancel("save-cancel", false, true).await;
}
