use async_trait::async_trait;
use loongsuite_pilot::flushers::{BaseFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter};
use loongsuite_pilot::inputs::dsh::{
    new_state, transform_dsh_record, transform_dsh_record_entries,
};
use loongsuite_pilot::types::{AgentActivityEntry, ClientType};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

fn entry_json(entry: &AgentActivityEntry) -> Value {
    serde_json::to_value(entry).expect("native entry serialization")
}

const FIXTURE: &str = include_str!("fixtures/dsh/dsh-probe-events-real.jsonl");

struct Capture(Arc<Mutex<Vec<ReadableSpan>>>);
#[async_trait]
impl TraceExporter for Capture {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().expect("capture").extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
struct Harness {
    _root: tempfile::TempDir,
    flusher: OtlpTraceFlusher,
    captured: Arc<Mutex<Vec<ReadableSpan>>>,
}
impl Harness {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("synthetic output root");
        let captured = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::new(Capture(Arc::clone(&captured)));
        let flusher=OtlpTraceFlusher::with_parts(serde_json::from_value(json!({
            "enabled":true,"protocol":"http/protobuf","serviceName":"dsh-history",
            "endpoints":[{"name":"controlled-capture","endpoint":"http://127.0.0.1:1/v1/traces","headers":{},"compression":"none"}],
            "dataDir":root.path(),"turnIdleTimeoutMs":0
        })).expect("native config"),None,Some(Arc::new(move |_|Arc::clone(&capture) as Arc<dyn TraceExporter>)),None).expect("native flusher");
        Self {
            _root: root,
            flusher,
            captured,
        }
    }
    async fn export(&self, entries: Vec<AgentActivityEntry>) {
        self.flusher
            .send_batch(entries, None)
            .await
            .expect("real native batch acceptance");
        self.flusher
            .flush()
            .await
            .expect("real conversion and controlled export");
    }
    fn spans(&self) -> Vec<ReadableSpan> {
        self.captured.lock().expect("capture").clone()
    }
}
fn turn(sid: &str, time: i64) -> Vec<AgentActivityEntry> {
    let mut state = new_state();
    [
        json!({"type":"turn/start","sid":sid,"time":time,"data":{"turn":1}}),
        json!({"type":"step/start","sid":sid,"time":time+1,"data":{"turn":1,"step":1}}),
        json!({"type":"user/message","sid":sid,"time":time+2,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"hello"}]}}),
        json!({"type":"request/header","sid":sid,"time":time+3,"data":{"header":{"config":{"provider":"deepseek","model":"deepseek-test"}}}}),
        json!({"type":"request/context","sid":sid,"time":time+4,"data":{}}),
        json!({"type":"assistant/chunk","sid":sid,"time":time+5,"data":{"turn":1,"step":1,"chunk":{"type":"text-delta","text":"done"}}}),
        json!({"type":"assistant/chunk","sid":sid,"time":time+6,"data":{"turn":1,"step":1,"chunk":{"type":"finish","reason":{"kind":"stop"}}}}),
        json!({"type":"assistant/message","sid":sid,"time":time+7,"data":{"turn":1,"step":1,
            "message":{"id":format!("{sid}-response"),"content":[{"type":"text","text":"done"}],"source":{"provider":"deepseek","model":"deepseek-test"}},
            "usage":{"inputTokens":3,"outputTokens":5,"cacheReadTokens":7,"cacheWriteTokens":11,"reasoningTokens":2}}})
    ].iter().filter_map(|record|transform_dsh_record(record,ClientType::Dsh,&mut state)).collect()
}
fn kind<'a>(spans: &'a [ReadableSpan], name: &str) -> Vec<&'a ReadableSpan> {
    spans
        .iter()
        .filter(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!(name)))
        .collect()
}
fn inputs(span: &ReadableSpan) -> Vec<Value> {
    serde_json::from_str(
        span.attributes["gen_ai.input.messages"]
            .as_str()
            .expect("native OTLP JSON input attribute"),
    )
    .expect("input messages")
}
fn text(message: &Value) -> String {
    message["parts"]
        .as_array()
        .expect("parts")
        .iter()
        .map(|part| part["content"].as_str().unwrap_or(""))
        .collect()
}
fn fixture() -> Vec<Value> {
    FIXTURE
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("immutable historical fixture"))
        .collect()
}

#[tokio::test]
async fn l108_native_turn_one_in_two_sessions_exports_distinct_traces_exact_usage_ttft_and_dsh_resource(
) {
    let harness = Harness::new();
    let a = turn("session-a", 1_800_000_000_000);
    let b = turn("session-b", 1_800_000_001_000);
    for (entries, expected) in [(&a, "session-a:1"), (&b, "session-b:1")] {
        let ids = entries
            .iter()
            .map(|entry| {
                entry_json(entry)["gen_ai.turn.id"]
                    .as_str()
                    .expect("turn")
                    .to_owned()
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(ids, BTreeSet::from([expected.to_owned()]));
    }
    harness.export(a).await;
    harness.export(b).await;
    let spans = harness.spans();
    let entry = kind(&spans, "ENTRY");
    let agent = kind(&spans, "AGENT");
    let llm = kind(&spans, "LLM");
    assert_eq!(entry.len(), 2);
    assert_eq!(agent.len(), 2);
    assert_eq!(llm.len(), 2);
    assert_eq!(
        entry
            .iter()
            .map(|span| span.trace_id.as_str())
            .collect::<BTreeSet<_>>()
            .len(),
        2
    );
    assert_eq!(
        llm.iter()
            .map(
                |span| span.attributes["gen_ai.response.time_to_first_token"]
                    .as_f64()
                    .expect("ttft")
            )
            .collect::<Vec<_>>(),
        vec![1_000_000.0, 1_000_000.0]
    );
    for span in llm.iter().chain(agent.iter()) {
        for (key, value) in [
            ("gen_ai.usage.input_tokens", 21.0),
            ("gen_ai.usage.output_tokens", 5.0),
            ("gen_ai.usage.cache_read.input_tokens", 7.0),
            ("gen_ai.usage.cache_creation.input_tokens", 11.0),
            ("gen_ai.usage.total_tokens", 26.0),
        ] {
            assert_eq!(
                span.attributes.get(key).and_then(Value::as_f64),
                Some(value),
                "field {key} missing or wrong on native span kind {:?}",
                span.attributes.get("gen_ai.span.kind")
            );
        }
    }
    for span in &spans {
        let resource = span
            .resource_attributes
            .as_ref()
            .expect("actual OTLP resource");
        assert_eq!(resource["gen_ai.agent.type"], "dsh");
        assert_eq!(resource["gen_ai.agent.system"], "dsh");
    }
    harness.flusher.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn l141_native_flusher_keeps_injected_context_on_llm_but_only_human_input_on_entry_and_agent()
{
    let harness = Harness::new();
    let mut state = new_state();
    let entries = fixture()
        .iter()
        .filter_map(|record| transform_dsh_record(record, ClientType::Dsh, &mut state))
        .collect();
    harness.export(entries).await;
    let spans = harness.spans();
    let entry = kind(&spans, "ENTRY");
    let agent = kind(&spans, "AGENT");
    assert_eq!(entry.len(), 1);
    assert_eq!(agent.len(), 1);
    let user = inputs(entry[0]);
    assert_eq!(user.len(), 1);
    assert_eq!(inputs(agent[0]), user);
    assert!(text(&user[0]).contains("Create a hello.txt file"));
    assert!(!text(&user[0]).contains("Current runtime context"));
    let mut llm = kind(&spans, "LLM");
    llm.sort_by_key(|span| span.start_time);
    assert_eq!(llm.len(), 3);
    let all = llm.iter().map(|span| inputs(span)).collect::<Vec<_>>();
    assert_eq!(
        all.iter()
            .map(|messages| messages
                .iter()
                .map(|message| message["role"].as_str().expect("role"))
                .collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        vec![
            vec!["user", "user"],
            vec!["user", "user", "assistant", "tool"],
            vec!["user", "user", "assistant", "tool", "assistant", "tool"]
        ]
    );
    assert!(text(&all[0][0]).contains("Create a hello.txt file"));
    assert!(text(&all[0][1]).contains("Current runtime context"));
    harness.flusher.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn l179_compact_streams_export_each_response_once_with_its_finish_and_exact_native_time() {
    let harness = Harness::new();
    let mut streams: HashMap<String, Vec<Value>> = HashMap::new();
    let mut state = new_state();
    let mut entries = Vec::new();
    for mut record in fixture() {
        let key = format!(
            "{}:{}:{}",
            record["sid"].as_str().unwrap_or(""),
            record["data"]["turn"],
            record["data"]["step"]
        );
        if record["type"] == "assistant/chunk" {
            let chunk = &record["data"]["chunk"];
            let chunk_kind = chunk["type"].as_str().unwrap_or("");
            let item = match chunk_kind {
                "text-delta" | "reasoning-delta" => json!({
                    "type":if chunk_kind=="text-delta"{"text-chunks"}else{"reasoning-chunks"},
                    "time0":record["time"],"index":chunk["index"],"dt":[],"texts":[chunk["text"]]
                }),
                "tool-call-delta" => {
                    json!({"type":"tool-call-chunks","time0":record["time"],"index":chunk["index"],
                    "id":chunk["id"],"name":chunk["name"],"dt":[],"args":[chunk["argumentsDelta"]]})
                }
                _ => json!({"type":"chunk","time":record["time"],"chunk":chunk}),
            };
            streams.entry(key).or_default().push(item);
            continue;
        }
        if record["type"] == "assistant/message" {
            if let Some(stream) = streams.remove(&key) {
                record["data"]["stream"] = json!(stream);
            } else {
                record["data"]
                    .as_object_mut()
                    .expect("native message data")
                    .remove("stream");
            }
        }
        entries.extend(transform_dsh_record_entries(
            &record,
            ClientType::Dsh,
            &mut state,
        ));
    }
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name
                == Some(loongsuite_pilot::types::AgentEventName::LlmRequest))
            .count(),
        3
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name
                == Some(loongsuite_pilot::types::AgentEventName::LlmResponse))
            .count(),
        3
    );
    harness.export(entries).await;
    let spans = harness.spans();
    let mut llm = kind(&spans, "LLM");
    llm.sort_by_key(|span| span.start_time);
    assert_eq!(llm.len(), 3);
    assert_eq!(
        llm.iter()
            .map(|span| span.attributes["gen_ai.response.finish_reasons"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!(["tool_calls"]),
            json!(["tool_calls"]),
            json!(["stop"])
        ]
    );
    assert_eq!(
        llm.iter()
            .map(
                |span| span.attributes["gen_ai.response.time_to_first_token"]
                    .as_f64()
                    .expect("native ttft")
            )
            .collect::<Vec<_>>(),
        vec![671_000_000.0, 591_000_000.0, 943_000_000.0]
    );
    assert_eq!(
        llm.iter()
            .map(|span| loongsuite_pilot::flushers::hr_time_to_nano(span.start_time).to_string())
            .collect::<Vec<_>>(),
        vec![
            "1786643725829000000",
            "1786643727189000000",
            "1786643727920000000"
        ]
    );
    assert_eq!(
        llm.iter()
            .map(|span| loongsuite_pilot::flushers::hr_time_to_nano(span.end_time).to_string())
            .collect::<Vec<_>>(),
        vec![
            "1786643727158000000",
            "1786643727905000000",
            "1786643729118000000"
        ]
    );
    harness.flusher.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn actual_poll_stop_and_new_store_restart_restore_pending_turn_before_native_otlp_export() {
    use loongsuite_pilot::checkpoints::StateStore;
    use loongsuite_pilot::inputs::dsh_log::DshLogInput;
    use loongsuite_pilot::inputs::rest_support::SessionInputOptions;
    use std::io::Write;
    use std::time::Duration;

    let input_root = tempfile::tempdir().expect("synthetic input root");
    let path = input_root.path().join("dsh-poll.jsonl");
    let state_path = input_root.path().join("input-state.json");
    let cut = FIXTURE
        .split_inclusive('\n')
        .scan(0usize, |offset, line| {
            let start = *offset;
            *offset += line.len();
            Some((start, line))
        })
        .find_map(|(offset, line)| {
            let record: Value = serde_json::from_str(line).expect("native fixture record");
            (record["type"] == "assistant/message").then_some(offset)
        })
        .expect("first settled response");
    assert!(cut > 0 && cut < FIXTURE.len());
    std::fs::write(&path, &FIXTURE[..cut]).expect("real incomplete-turn prefix");
    let collected = Arc::new(Mutex::new(Vec::<AgentActivityEntry>::new()));
    let store = Arc::new(StateStore::new(&state_path));
    store.load().await;
    let input = DshLogInput::new(SessionInputOptions {
        state_store: Arc::clone(&store),
        session_dir: Some(input_root.path().to_string_lossy().into_owned()),
        file_pattern: None,
        poll_interval_ms: Some(20),
    });
    let captured = Arc::clone(&collected);
    input.on_entries(move |entries| {
        captured
            .lock()
            .expect("collector subscriber")
            .extend_from_slice(entries)
    });
    input.start().await;
    let key = format!("dsh-log:{}", path.to_string_lossy());
    tokio::time::timeout(Duration::from_secs(4), async {
        while store.get_offset(&key) != (cut as f64) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("actual initial poll consumes complete prefix");
    tokio::time::timeout(Duration::from_secs(4), input.stop())
        .await
        .expect("bounded actual stop");
    assert!(!input.running());
    store.save().await.expect("durable prefix checkpoint");
    assert_eq!(
        collected
            .lock()
            .expect("subscriber")
            .iter()
            .filter(|entry| entry.event_name
                == Some(loongsuite_pilot::types::AgentEventName::LlmRequest))
            .count(),
        1
    );
    assert_eq!(
        collected
            .lock()
            .expect("subscriber")
            .iter()
            .filter(|entry| entry.event_name
                == Some(loongsuite_pilot::types::AgentEventName::LlmResponse))
            .count(),
        0
    );
    assert!(!std::fs::read_to_string(&state_path)
        .expect("state text")
        .contains("Create a hello.txt file"));
    let count = collected.lock().expect("subscriber").len();
    drop(input);
    drop(store);
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append while stopped")
        .write_all(&FIXTURE.as_bytes()[cut..])
        .expect("complete native source");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        collected.lock().expect("stopped subscriber").len(),
        count,
        "stopped timer must not emit"
    );
    let loaded = Arc::new(StateStore::new(&state_path));
    loaded.load().await;
    assert_eq!(loaded.get_offset(&key), cut as f64);
    let restarted = DshLogInput::new(SessionInputOptions {
        state_store: Arc::clone(&loaded),
        session_dir: Some(input_root.path().to_string_lossy().into_owned()),
        file_pattern: None,
        poll_interval_ms: Some(20),
    });
    let captured = Arc::clone(&collected);
    restarted.on_entries(move |entries| {
        captured
            .lock()
            .expect("restarted subscriber")
            .extend_from_slice(entries)
    });
    restarted.start().await;
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let done = loaded.get_offset(&key) == FIXTURE.len() as f64
                && collected
                    .lock()
                    .expect("subscriber")
                    .iter()
                    .filter(|entry| {
                        entry.event_name
                            == Some(loongsuite_pilot::types::AgentEventName::LlmResponse)
                    })
                    .count()
                    == 3;
            if done {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("actual restarted polls recover complete turn");
    tokio::time::timeout(Duration::from_secs(4), restarted.stop())
        .await
        .expect("bounded recovered stop");
    assert!(!restarted.running());
    let entries = collected.lock().expect("subscriber").clone();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name
                == Some(loongsuite_pilot::types::AgentEventName::LlmRequest))
            .count(),
        3
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name
                == Some(loongsuite_pilot::types::AgentEventName::LlmResponse))
            .count(),
        3
    );
    let harness = Harness::new();
    harness.export(entries).await;
    let spans = harness.spans();
    let mut llm = kind(&spans, "LLM");
    llm.sort_by_key(|span| span.start_time);
    assert_eq!(llm.len(), 3);
    assert_eq!(
        llm.iter()
            .map(
                |span| span.attributes["gen_ai.response.time_to_first_token"]
                    .as_f64()
                    .expect("recovered native ttft")
            )
            .collect::<Vec<_>>(),
        vec![671_000_000.0, 591_000_000.0, 943_000_000.0]
    );
    assert_eq!(
        llm.iter()
            .map(|span| span.attributes["gen_ai.response.finish_reasons"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!(["tool_calls"]),
            json!(["tool_calls"]),
            json!(["stop"])
        ]
    );
    assert!(inputs(llm[0])
        .iter()
        .any(|message| text(message).contains("Create a hello.txt file")));
    harness.flusher.shutdown().await.expect("shutdown");
}
