use super::*;
use crate::checkpoints::{InputState, StateStore};
use serde_json::json;
use std::io::Write;
fn event(id: &str, text: &str) -> Value {
    json!({"event.id":id,"event.name":"llm.response","time_unix_nano":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos().to_string(),
        "gen_ai.agent.type":"qoder-cn","gen_ai.session.id":"synthetic-session","gen_ai.turn.id":format!("turn-{id}"),
        "gen_ai.usage.input_tokens":11,"gen_ai.usage.output_tokens":7,
        "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":text}]}]})
}
fn make_input(root: &Path, store: Arc<StateStore>) -> QoderCnTraceInput {
    QoderCnTraceInput::new(QoderCnTraceOptions {
        state_store: store,
        log_dir: Some(root.join("history").to_string_lossy().into_owned()),
        poll_interval_ms: Some(60_000),
    })
}
async fn read(input: &QoderCnTraceInput) -> Vec<AgentActivityEntry> {
    input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap()
}
#[tokio::test]
async fn source_l14_cn_real_input_drains_legal_16mib_successor_and_restarted_utf8_tail_once() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    std::fs::create_dir(r.join("history")).unwrap();
    let name = format!("qoder-cn-{}.jsonl", get_today_date_string());
    let file = r.join("history").join(&name);
    let content = format!(
        "{}\n{}\n",
        event("large", &"x".repeat(16 * 1024 * 1024)),
        event("small", "trailing answer")
    );
    std::fs::write(&file, &content).unwrap();
    let store = Arc::new(StateStore::new(r.join("state.json")));
    let mut input = make_input(r, Arc::clone(&store));
    store.set(
        input.inner.id(),
        InputState::new()
            .with_last_file(&name)
            .with_last_offset(0.0),
    );
    let mut records = Vec::new();
    for _ in 0..8 {
        if store.get(input.inner.id()).last_offset().unwrap_or(0.0) >= content.len() as f64 {
            break;
        }
        records.extend(read(&input).await);
    }
    assert_eq!(
        records
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        ["large", "small"]
    );
    assert_eq!(
        records.iter().map(|e| e.input_tokens).collect::<Vec<_>>(),
        [Some(11), Some(11)]
    );
    assert_eq!(
        store.get(input.inner.id()).last_offset(),
        Some(content.len() as f64)
    );
    assert!(read(&input).await.is_empty());
    let saved = store.get(input.inner.id()).last_offset();
    let tail = serde_json::to_vec(&event("partial", "中文🙂")).unwrap();
    let split = tail
        .windows("中文".len())
        .position(|v| v == "中文".as_bytes())
        .unwrap()
        + 1;
    let mut append = std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap();
    append.write_all(&tail[..split]).unwrap();
    assert!(read(&input).await.is_empty());
    assert_eq!(store.get(input.inner.id()).last_offset(), saved);
    input.stop().await.unwrap();
    input = make_input(r, Arc::clone(&store));
    append.write_all(&tail[split..]).unwrap();
    append.write_all(b"\n").unwrap();
    drop(append);
    let completed = read(&input).await;
    assert_eq!(
        completed
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        ["partial"]
    );
    assert!(serde_json::to_string(&completed)
        .unwrap()
        .contains("中文🙂"));
    assert!(read(&input).await.is_empty());
    input.stop().await.unwrap();
}

#[tokio::test]
async fn native_actual_cn_collection_preserves_128_distinct_turns_in_source_order() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    std::fs::create_dir(r.join("history")).unwrap();
    let name = format!("qoder-cn-{}.jsonl", get_today_date_string());
    let ids = (0..128)
        .map(|i| format!("ordered-{i:03}"))
        .collect::<Vec<_>>();
    let mut bytes = Vec::new();
    for id in &ids {
        let mut row = event(id, id);
        row.as_object_mut()
            .unwrap()
            .insert("gen_ai.response.id".into(), json!(id));
        serde_json::to_writer(&mut bytes, &row).unwrap();
        bytes.push(b'\n');
    }
    std::fs::write(r.join("history").join(&name), bytes).unwrap();
    let store = Arc::new(StateStore::new(r.join("state.json")));
    let input = make_input(r, Arc::clone(&store));
    store.set(
        input.inner.id(),
        InputState::new().with_last_file(name).with_last_offset(0.0),
    );
    let records = read(&input).await;
    assert_eq!(
        records
            .iter()
            .map(|r| r.event_id.clone())
            .collect::<Vec<_>>(),
        ids
    );
    input.stop().await.unwrap();
}
