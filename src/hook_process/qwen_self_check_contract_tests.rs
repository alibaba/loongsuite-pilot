use super::*;
use crate::flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter};
use crate::types::AgentActivityEntry;
use serde_json::json;
const SESSION: &str = "3821eeeb-f45b-4a91-b921-6949b9893e88";
fn value(v: &Value) -> Value {
    match v {
        Value::String(s) => serde_json::from_str(s).unwrap(),
        v => v.clone(),
    }
}
#[test]
fn self_l70_actual_hook_jsonl_default_genai_conversion_preserves_full_trace_and_content_contract() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let file = root.join(format!("{SESSION}.jsonl"));
    std::fs::write(
        &file,
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/unit/hooks/qwen-code-cli/fixtures/real-multi-step-tool-calls.jsonl"
        )),
    )
    .unwrap();
    let mut env = Env::new();
    for key in ["LOONGSUITE_PILOT_DATA_DIR", "HOME", "USERPROFILE"] {
        env.insert(key.into(), root.to_string_lossy().into_owned());
    }
    let args = vec!["stop".to_owned()];
    let payload=serde_json::to_vec(&json!({"session_id":SESSION,"transcript_path":file,"cwd":"/Users/testuser/AliYun/testNode/testQwenCode","stop_reason":"end_turn"})).unwrap();
    let mut stdout = Vec::new();
    let mut request = super::super::common::HookRequest {
        args: &args,
        stdin: &payload,
        env: &env,
        stdout: &mut stdout,
    };
    assert_eq!(run(&mut request), 0);
    assert_eq!(stdout, b"{}\n");
    let mut paths = std::fs::read_dir(root.join("logs/qwen-code-cli"))
        .unwrap()
        .map(|f| f.unwrap().path())
        .filter(|f| f.extension().is_some_and(|e| e == "jsonl"))
        .collect::<Vec<_>>();
    paths.sort();
    let events = paths
        .into_iter()
        .flat_map(|p| {
            std::fs::read_to_string(p)
                .unwrap()
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| serde_json::from_str::<Value>(l).unwrap())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    assert!(!events.is_empty());
    let records = events
        .iter()
        .cloned()
        .map(|v| serde_json::from_value::<AgentActivityEntry>(v).unwrap())
        .collect::<Vec<_>>();
    // Baseline Qwen intentionally has no raw invocation name when no resources
    // were supplied. The default converter must supply usable span identity.
    assert!(records.iter().all(|r| r.agent_name.is_none()));
    let result = GenAiEventLogConverter
        .convert(&records, &ConvertOptions::default())
        .unwrap();
    let spans = &result.spans;
    assert_eq!(
        spans
            .iter()
            .map(|s| s.trace_id.as_str())
            .collect::<HashSet<_>>()
            .len(),
        1
    );
    let mut kinds = HashMap::new();
    for s in spans {
        if let Some(kind) = s.attributes.get("gen_ai.span.kind").and_then(Value::as_str) {
            *kinds.entry(kind).or_insert(0) += 1;
        }
    }
    assert_eq!(kinds.get("STEP"), kinds.get("LLM"));
    assert_eq!(kinds.get("STEP"), Some(&2));
    assert_eq!(kinds.get("LLM"), Some(&2));
    assert_eq!(kinds.get("TOOL"), Some(&3));
    assert_eq!(kinds.get("AGENT"), Some(&1));
    assert_eq!(kinds.get("ENTRY"), Some(&1));
    assert!(spans.iter().all(|s| s.start_time != s.end_time));
    for warning in &result.warnings {
        assert!(
            !["Orphan", "Invalid", "Inconsistent"]
                .iter()
                .any(|text| warning.contains(text)),
            "{warning}"
        );
    }
    for s in spans {
        assert!(
            s.attributes
                .get("gen_ai.agent.name")
                .and_then(Value::as_str)
                .is_some_and(|n| !n.is_empty()),
            "default {} span {} must retain an agent name",
            s.attributes["gen_ai.span.kind"],
            s.name
        );
        assert!(s
            .attributes
            .get("gen_ai.user.id")
            .or_else(|| s.attributes.get("user.id"))
            .and_then(Value::as_str)
            .is_some_and(|n| !n.is_empty()));
        assert_eq!(s.attributes.get("gen_ai.session.id"), Some(&json!(SESSION)));
    }
    assert!(spans
        .iter()
        .any(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("ENTRY"))));
    let other = events.iter().find(|r| r["event.name"] == "other").unwrap();
    assert!(
        other["gen_ai.input.messages_delta"][0]["parts"][0]["content"]
            .as_str()
            .unwrap()
            .contains("subagent")
    );
    let mut llms = spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
        .collect::<Vec<_>>();
    llms.sort_by_key(|s| s.start_time);
    for llm in &llms {
        assert!(
            llm.attributes["gen_ai.usage.input_tokens"]
                .as_i64()
                .unwrap()
                > 0
        );
        assert!(
            llm.attributes["gen_ai.usage.output_tokens"]
                .as_i64()
                .unwrap()
                > 0
        );
        assert_eq!(llm.attributes["gen_ai.request.model"], "qwen3.6-plus");
        assert_eq!(llm.attributes["gen_ai.provider.name"], "qwen");
    }
    let second = value(&llms[1].attributes["gen_ai.input.messages"]);
    let second = second.as_array().unwrap();
    assert_eq!(
        second
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["user", "assistant", "tool", "tool", "tool"]
    );
    let assistants = second
        .iter()
        .filter(|m| m["role"] == "assistant")
        .collect::<Vec<_>>();
    assert_eq!(assistants.len(), 1);
    let parts = assistants[0]["parts"].as_array().unwrap();
    assert_eq!(parts.iter().filter(|p| p["type"] == "reasoning").count(), 1);
    assert_eq!(parts.iter().filter(|p| p["type"] == "text").count(), 1);
    let first = value(&llms[0].attributes["gen_ai.output.messages"]);
    assert_eq!(assistants[0]["parts"], first[0]["parts"]);
    let ids = parts
        .iter()
        .filter(|p| p["type"] == "tool_call")
        .map(|p| p["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    let result_ids = second
        .iter()
        .filter(|m| m["role"] == "tool")
        .flat_map(|m| m["parts"].as_array().unwrap())
        .map(|p| p["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(result_ids, ids);
    let agent = spans
        .iter()
        .find(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("AGENT")))
        .unwrap();
    for key in ["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"] {
        assert_eq!(
            agent.attributes[key].as_i64().unwrap(),
            llms.iter()
                .map(|s| s.attributes[key].as_i64().unwrap())
                .sum::<i64>()
        );
    }
    let tools = spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("TOOL")))
        .collect::<Vec<_>>();
    assert_eq!(tools.len(), 3);
    for tool in tools {
        assert_eq!(tool.attributes["gen_ai.tool.name"], "agent");
        assert!(tool.attributes["gen_ai.tool.call.id"]
            .as_str()
            .is_some_and(|s| !s.is_empty()));
    }
}
