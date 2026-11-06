use async_trait::async_trait;
use loongsuite_pilot::flushers::{BaseFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter};
use loongsuite_pilot::mask::{mask_agent_activity_entry, MaskConfig};
use loongsuite_pilot::normalization::{
    project_log_entry, serialise_log_entry, SerialiseLogEntryOptions,
};
use loongsuite_pilot::types::{AgentActivityEntry, OtlpTraceFlusherConfig};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

const KEY: &str = "agent.openclaw.session_key";
type Captured = Arc<Mutex<Vec<ReadableSpan>>>;
struct Exporter(Captured);
#[async_trait]
impl TraceExporter for Exporter {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "fixtures/openclaw-session-key-frozen-fixtures.json"
    ))
    .unwrap()
}
fn records(value: &Value) -> Vec<AgentActivityEntry> {
    serde_json::from_value(value.clone()).unwrap()
}
fn flusher(root: &Path, captured: Captured) -> OtlpTraceFlusher {
    let config: OtlpTraceFlusherConfig = serde_json::from_value(json!({
        "enabled": true, "protocol": "http/protobuf", "serviceName": "session-key-test",
        "dataDir": root, "turnIdleTimeoutMs": 0,
        "endpoints": [{"name":"test","endpoint":"http://unused:4318"}]
    }))
    .unwrap();
    OtlpTraceFlusher::with_parts(
        config,
        None,
        Some(Arc::new(move |_| {
            Arc::new(Exporter(captured.clone())) as Arc<dyn TraceExporter>
        })),
        None,
    )
    .unwrap()
}
async fn exported(records: Vec<AgentActivityEntry>) -> Vec<ReadableSpan> {
    let root = tempfile::tempdir().unwrap();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let flusher = flusher(root.path(), captured.clone());
    flusher.send_batch(records, None).await.unwrap();
    flusher.shutdown().await.unwrap();
    let spans = captured.lock().unwrap().clone();
    spans
}
#[tokio::test]
async fn validated_session_key_projects_only_for_openclaw_and_invalid_or_foreign_values_never_reach_spans(
) {
    let data = fixture();
    let mut projected = records(&data["projection"]).remove(0);
    projected
        .extra
        .insert("agent.openclaw.sender.id".into(), json!("private"));
    projected
        .extra
        .insert("agent.openclaw.hook".into(), json!("private"));
    let options = SerialiseLogEntryOptions {
        drop_agent_scoped_fields: true,
    };
    let jsonl = project_log_entry(&projected, &options);
    let sls = serialise_log_entry(&projected, &options);
    assert_eq!(jsonl[KEY], "agent:main:test");
    assert_eq!(sls[KEY], "agent:main:test");
    for private in ["agent.openclaw.sender.id", "agent.openclaw.hook"] {
        assert!(!jsonl.contains_key(private));
        assert!(!sls.contains_key(private));
    }
    projected.agent_type = "codex".into();
    assert!(!project_log_entry(&projected, &options).contains_key(KEY));
    assert!(!serialise_log_entry(&projected, &options).contains_key(KEY));
    assert_eq!(data["invalids"].as_array().unwrap().len(), 9);
    for case in data["invalids"].as_array().unwrap() {
        let entries = records(&case["records"]);
        assert!(
            !project_log_entry(&entries[0], &options).contains_key(KEY),
            "{}",
            case["name"]
        );
        let spans = exported(entries).await;
        assert!(!spans.is_empty(), "{}", case["name"]);
        assert!(
            spans.iter().all(|span| !span.attributes.contains_key(KEY)),
            "{}",
            case["name"]
        );
    }
    let spans = exported(records(&data["other"])).await;
    assert!(!spans.is_empty());
    assert!(spans.iter().all(|span| !span.attributes.contains_key(KEY)));
}
#[tokio::test]
async fn interleaved_turns_reset_session_uuid_and_conflicts_keep_session_keys_on_only_their_own_five_span_kinds(
) {
    let data = fixture();
    let batches: Vec<Vec<AgentActivityEntry>> = data["parallel"]
        .as_array()
        .unwrap()
        .iter()
        .map(records)
        .collect();
    let interleaved = (0..batches[0].len())
        .flat_map(|index| batches.iter().map(move |batch| batch[index].clone()))
        .collect();
    let spans = exported(interleaved).await;
    assert!(!spans.is_empty());
    let kinds: HashSet<_> = spans
        .iter()
        .map(|span| span.attributes["gen_ai.span.kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        HashSet::from(["ENTRY", "AGENT", "STEP", "LLM", "TOOL"])
    );
    for span in &spans {
        let id = u32::from_str_radix(&span.trace_id, 16).unwrap();
        let expected = match id {
            1 | 3 => Some(json!("agent:main:a")),
            2 => Some(json!("agent:main:b")),
            4 => None,
            _ => panic!("unexpected fixture trace: {}", span.trace_id),
        };
        assert_eq!(span.attributes.get(KEY).cloned(), expected);
        assert!(!span.resource_attributes.as_ref().unwrap().contains_key(KEY));
    }
    assert!(batches[2]
        .iter()
        .all(|record| record.session_id == "reset-uuid"));
    assert_eq!(data["conflicts"].as_array().unwrap().len(), 3);
    for case in data["conflicts"].as_array().unwrap() {
        let spans = exported(records(&case["records"])).await;
        assert!(!spans.is_empty(), "{}", case["name"]);
        assert!(
            spans.iter().all(|span| !span.attributes.contains_key(KEY)),
            "{}",
            case["name"]
        );
    }
}
#[tokio::test]
async fn event_projection_and_real_spans_share_the_masked_session_key_without_replacing_the_session_uuid(
) {
    let data = fixture();
    let config: MaskConfig = serde_json::from_value(json!({"mode":"all","types":[]})).unwrap();
    let entries: Vec<_> = records(&data["maskSource"])
        .iter()
        .map(|entry| mask_agent_activity_entry(entry, &config, None, None).into_owned())
        .collect();
    let options = SerialiseLogEntryOptions {
        drop_agent_scoped_fields: true,
    };
    assert_eq!(
        project_log_entry(&entries[0], &options)[KEY],
        "agent:main:[ACCESSKEY_MASKED]"
    );
    assert_eq!(
        serialise_log_entry(&entries[0], &options)[KEY],
        "agent:main:[ACCESSKEY_MASKED]"
    );
    assert!(entries
        .iter()
        .all(|record| record.session_id == "session-1"));
    let spans = exported(entries.clone()).await;
    assert!(!spans.is_empty());
    assert!(spans
        .iter()
        .all(|span| span.attributes.get(KEY) == Some(&json!("agent:main:[ACCESSKEY_MASKED]"))));
    assert!(entries
        .iter()
        .all(|record| record.session_id == "session-1"));
}
#[tokio::test]
async fn legacy_inference_and_incomplete_flags_reach_final_spans_without_cross_turn_contamination()
{
    let mut records = Vec::new();
    for incomplete in [true, false] {
        let common = json!({
            "trace_id":if incomplete{"1234567890abcdef1234567890abcdef"}else{"abcdef1234567890abcdef1234567890"},
            "gen_ai.turn.id":if incomplete{"incomplete"}else{"complete"},
            "gen_ai.agent.type":"openclaw","agent.openclaw.compatibility":"legacy",
            "gen_ai.session.id":"session","user.id":"test"
        });
        for (index,fields) in [
            json!({"event.name":"other","gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":"test"}]}]}),
            json!({"event.name":"llm.request","gen_ai.step.id":"s","gen_ai.response.id":"r","gen_ai.request.model":"test","agent.openclaw.timing.inferred":true,"agent.openclaw.timing.quantized_ms":1}),
            json!({"event.name":"llm.response","gen_ai.step.id":"s","gen_ai.response.id":"r","gen_ai.response.model":"test"}),
            if incomplete{json!({"event.name":"other","agent.openclaw.hook":"legacy_cleanup","gen_ai.turn.end":true,"agent.openclaw.collection.incomplete":true,"agent.openclaw.collection.end_reason":"capacity_evicted"})}else{json!({"event.name":"other","agent.openclaw.hook":"llm_output"})}
        ].into_iter().enumerate() {
            let mut object=common.as_object().unwrap().clone();object.extend(fields.as_object().unwrap().clone());
            object.insert("time_unix_nano".into(),json!((1_788_220_800_000_000_000_i64+index as i64*1_000_000).to_string()));
            records.push(serde_json::from_value::<AgentActivityEntry>(Value::Object(object)).unwrap());
        }
    }
    let original = records.clone();
    let spans = exported(records).await;
    assert_eq!(
        spans
            .iter()
            .filter(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
            .count(),
        2
    );
    for span in spans {
        let incomplete = span.trace_id == "1234567890abcdef1234567890abcdef";
        assert_eq!(
            span.attributes
                .get("agent.openclaw.collection.incomplete")
                .cloned(),
            if incomplete { Some(json!(true)) } else { None }
        );
        assert!(!span.attributes.contains_key("agent.openclaw.success"));
        assert!(!span.attributes.contains_key("error.type"));
        if span.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")) {
            assert_eq!(span.attributes["agent.openclaw.timing.inferred"], true);
            assert_eq!(span.attributes["agent.openclaw.timing.quantized_ms"], 1);
        }
    }
    assert!(original[0]
        .get("agent.openclaw.collection.incomplete")
        .is_none());
}

#[tokio::test]
async fn main549_agent_type_only_openclaw_input_sets_system_on_every_real_span_resource() {
    let data = fixture();
    let mut input = data["projection"].clone();
    for entry in input.as_array_mut().unwrap() {
        entry.as_object_mut().unwrap().remove(KEY);
        assert_eq!(entry["gen_ai.agent.type"], "openclaw");
        assert!(entry.get("gen_ai.agent.system").is_none());
    }
    let spans = exported(records(&input)).await;
    let kinds: HashSet<_> = spans
        .iter()
        .map(|span| span.attributes["gen_ai.span.kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        HashSet::from(["ENTRY", "AGENT", "STEP", "LLM", "TOOL"])
    );
    for span in &spans {
        let resource = span.resource_attributes.as_ref().unwrap();
        assert_eq!(resource["gen_ai.agent.type"], "openclaw");
        assert_eq!(resource["gen_ai.agent.system"], "openclaw");
    }
}
