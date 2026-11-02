//! Fixed upstream-link e2e source assertion through the real native converter.
use loongsuite_pilot::core::{CorrelationStore, TraceLinker};
use loongsuite_pilot::flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter};
use loongsuite_pilot::types::AgentActivityEntry;
use loongsuite_pilot::utils::content_hash;
use serde_json::{json, Value};
const SID: &str = "ses_e2e";
const TRACE: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT: &str = "00f067aa0ba902b7";
const TP: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const LOCAL: &str = "ffeeddccbbaa99887766554433221100";
const RESERVED: &str = "d4d4d4d4d4d4d4d4";
const PROMPT: &str = "场景检查里的野图怪物检查,需要在主页面加个配置";
fn records() -> Vec<AgentActivityEntry> {
    let mut rows = vec![
        json!({"event.id":"e-other","event.name":"other","span_id":"a1a1a1a1a1a1a1a1","gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":PROMPT}]}]}),
        json!({"event.id":"e-req","event.name":"llm.request","gen_ai.step.id":"ses_e2e:t1:s1","span_id":"b2b2b2b2b2b2b2b2","parent_span_id":"c3c3c3c3c3c3c3c3","gen_ai.request.model":"claude"}),
        json!({"event.id":"e-tool-call","event.name":"tool.call","gen_ai.step.id":"ses_e2e:t1:s1","gen_ai.tool.name":"Bash","gen_ai.tool.call.id":"tool-reserved","gen_ai.tool.call.arguments":{"command":"my-cli"},"span_id":RESERVED,"parent_span_id":"c3c3c3c3c3c3c3c3"}),
        json!({"event.id":"e-tool-result","event.name":"tool.result","gen_ai.step.id":"ses_e2e:t1:s1","gen_ai.tool.name":"Bash","gen_ai.tool.call.id":"tool-reserved","gen_ai.tool.call.result":"ok","tool.result.status":"success","span_id":RESERVED,"parent_span_id":"c3c3c3c3c3c3c3c3"}),
        json!({"event.id":"e-resp","event.name":"llm.response","gen_ai.step.id":"ses_e2e:t1:s1","span_id":"b2b2b2b2b2b2b2b2","parent_span_id":"c3c3c3c3c3c3c3c3","gen_ai.request.model":"claude","gen_ai.response.model":"claude","gen_ai.response.finish_reasons":["stop"],"gen_ai.usage.input_tokens":10,"gen_ai.usage.output_tokens":20}),
    ];
    for (index, row) in rows.iter_mut().enumerate() {
        let object = row.as_object_mut().unwrap();
        object.insert("trace_id".into(), json!(LOCAL));
        object.insert("gen_ai.session.id".into(), json!(SID));
        object.insert("gen_ai.turn.id".into(), json!("ses_e2e:t1"));
        object.insert("gen_ai.agent.type".into(), json!("opencode"));
        object.insert("gen_ai.provider.name".into(), json!("anthropic"));
        object.insert(
            "time_unix_nano".into(),
            json!((1_700_000_000_000_000_000u64 + index as u64 * 1_000_000).to_string()),
        );
    }
    rows.into_iter()
        .map(|row: Value| serde_json::from_value(row).unwrap())
        .collect()
}
#[tokio::test]
async fn real_stamp_and_native_converter_reparent_entry_and_preserve_the_reserved_tool_span() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join(format!("{SID}.jsonl")),format!("{}\n",
        json!({"type":"turn","sessionId":SID,"contentHash":content_hash(PROMPT),"contentPrefix":PROMPT.chars().take(128).collect::<String>(),"traceparent":TP}))).unwrap();
    let mut rows = records();
    TraceLinker::with_retry(CorrelationStore::new(root.path()), 0, 0)
        .stamp(&mut rows)
        .await;
    let converted = GenAiEventLogConverter
        .convert(
            &rows,
            &ConvertOptions {
                strict: false,
                passthrough_keys: Vec::new(),
            },
        )
        .unwrap();
    assert!(converted.warnings.is_empty(), "{:?}", converted.warnings);
    assert!(!converted.spans.is_empty());
    assert!(converted
        .spans
        .iter()
        .all(|span| span.trace_id == TRACE && span.trace_id != LOCAL));
    let entry = converted
        .spans
        .iter()
        .find(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!("ENTRY")))
        .unwrap();
    assert_eq!(entry.parent_span_id.as_deref(), Some(PARENT));
    let tool = converted
        .spans
        .iter()
        .find(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!("TOOL")))
        .unwrap();
    assert_eq!(tool.span_id, RESERVED);
}
