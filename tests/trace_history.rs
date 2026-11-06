//! 旧转换器合同的 Rust 回归：真实转换、父子关联、取消及输入内容。

use loongsuite_pilot::flushers::{
    convert_delegated_turn, convert_qwen_subagents, ConvertOptions, ConvertResult,
    EventLogConverter, GenAiEventLogConverter, ReadableSpan,
};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
use std::collections::HashSet;

const TRACE: &str = "1234567890abcdef1234567890abcdef";

fn event(agent: &str, id: &str, name: &str, time: u64, step: &str) -> AgentActivityEntry {
    serde_json::from_value(json!({
        "gen_ai.agent.type": agent, "gen_ai.agent.id": id,
        "gen_ai.session.id": "session", "gen_ai.turn.id": "turn",
        "gen_ai.step.id": step, "event.name": name, "time_unix_nano": time.to_string(),
        "trace_id": TRACE
    }))
    .unwrap()
}

fn llm(
    agent: &str,
    id: &str,
    step: &str,
    start: u64,
    end: u64,
    tokens: i64,
) -> Vec<AgentActivityEntry> {
    let mut request = event(agent, id, "llm.request", start, step);
    request.input_messages_delta = Some(
        json!([{"role":"user", "parts":[{"type":"text", "content":format!("delegated task {id}")}]}]),
    );
    let mut response = event(agent, id, "llm.response", end, step);
    response.finish_reasons = Some(vec!["stop".into()]);
    response.input_tokens = Some(tokens);
    vec![request, response]
}

fn tool(agent: &str, id: &str, call: &str, start: u64, end: u64) -> Vec<AgentActivityEntry> {
    [("tool.call", start), ("tool.result", end)]
        .into_iter()
        .map(|(name, time)| {
            let mut record = event(agent, id, name, time, "s1");
            record.tool_call_id = Some(call.into());
            record.tool_name = Some("spawn_agent".into());
            record
        })
        .collect()
}

fn child(
    mut records: Vec<AgentActivityEntry>,
    parent: &str,
    call: &str,
) -> Vec<AgentActivityEntry> {
    for record in &mut records {
        record
            .extra
            .insert("gen_ai.agent.scope".into(), json!("subagent"));
        record
            .extra
            .insert("gen_ai.agent.parent.id".into(), json!(parent));
        record
            .extra
            .insert("gen_ai.subagent.parent_tool_call.id".into(), json!(call));
    }
    records
}

fn kind<'a>(result: &'a ConvertResult, value: &str) -> Vec<&'a ReadableSpan> {
    result
        .spans
        .iter()
        .filter(|span| span.attributes["gen_ai.span.kind"] == value)
        .collect()
}

fn tree(result: &ConvertResult) {
    assert_eq!(result.span_count, result.spans.len());
    assert_eq!(result.trace_ids, [TRACE]);
    assert_eq!(
        result
            .spans
            .iter()
            .map(|span| &span.span_id)
            .collect::<HashSet<_>>()
            .len(),
        result.spans.len()
    );
    for span in &result.spans {
        assert_eq!(span.trace_id, TRACE);
        if span.attributes["gen_ai.span.kind"] == "ENTRY" {
            continue;
        }
        let parent = result
            .spans
            .iter()
            .find(|parent| Some(&parent.span_id) == span.parent_span_id.as_ref())
            .unwrap();
        if span.attributes.get("gen_ai.agent.scope") == Some(&json!("subagent"))
            && span.attributes["gen_ai.span.kind"] == "AGENT"
        {
            assert_eq!(parent.attributes["gen_ai.span.kind"], "TOOL");
            assert_eq!(
                span.attributes["gen_ai.subagent.parent_tool_call.id"],
                parent.attributes["gen_ai.tool.call.id"]
            );
        }
    }
}

#[test]
fn codex_three_children_attach_to_spawn_tools_and_keep_input() {
    let mut records = llm("codex", "parent", "s1", 1010, 1020, 10);
    records.extend(llm("codex", "parent", "s2", 1050, 1060, 20));
    for index in 1..=3 {
        let id = format!("child-{index}");
        let call = format!("call-{index}");
        records.extend(tool("codex", "parent", &call, 1020 + index, 1030 + index));
        records.extend(child(
            llm("codex", &id, "s1", 1025 + index, 1040 + index, 2),
            "parent",
            &call,
        ));
    }
    let result = GenAiEventLogConverter
        .convert(&records, &ConvertOptions::default())
        .unwrap();
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!(kind(&result, "ENTRY").len(), 1);
    assert_eq!(kind(&result, "AGENT").len(), 4);
    assert_eq!(kind(&result, "TOOL").len(), 3);
    tree(&result);
    for agent in kind(&result, "AGENT") {
        let id = agent.attributes["gen_ai.agent.id"].as_str().unwrap();
        assert!(agent.attributes["gen_ai.input.messages"]
            .as_str()
            .unwrap()
            .contains(&format!("delegated task {id}")));
        if id != "parent" {
            let parent = result
                .spans
                .iter()
                .find(|span| Some(&span.span_id) == agent.parent_span_id.as_ref())
                .unwrap();
            assert!(
                agent.end_time > parent.end_time,
                "异步子 Agent 不能拉长父 TOOL"
            );
        }
    }
}

#[test]
fn qwen_recursive_children_keep_separate_usage_and_failed_diagnostics() {
    let agent = "qwen-code-cli";
    let mut records = llm(agent, "parent", "s1", 10, 20, 20);
    records.extend(tool(agent, "parent", "outer", 20, 90));
    records.extend(llm(agent, "parent", "s2", 90, 100, 30));
    let mut middle = llm(agent, "child", "s1", 30, 40, 10);
    middle.extend(tool(agent, "child", "inner", 40, 70));
    middle.extend(llm(agent, "child", "s2", 70, 80, 12));
    records.extend(child(middle, "parent", "outer"));
    let mut grandchild = child(llm(agent, "grandchild", "s1", 50, 60, 5), "child", "inner");
    for record in &mut grandchild {
        record.extra.insert(
            "agent.qwen-code-cli.subagent.status".into(),
            json!("failed"),
        );
    }
    records.extend(grandchild);
    let options = ConvertOptions {
        passthrough_keys: vec!["agent.qwen-code-cli.subagent.status".into()],
        ..Default::default()
    };
    for reverse in [false, true] {
        if reverse {
            records.reverse();
        }
        let result = convert_qwen_subagents(&records, &options, &GenAiEventLogConverter).unwrap();
        assert!(result.warnings.is_empty());
        tree(&result);
        for (name, count) in [
            ("ENTRY", 1),
            ("AGENT", 3),
            ("LLM", 5),
            ("STEP", 5),
            ("TOOL", 2),
        ] {
            assert_eq!(kind(&result, name).len(), count, "{name}");
        }
        for (id, tokens) in [("parent", 50), ("child", 22), ("grandchild", 5)] {
            let span = kind(&result, "AGENT")
                .into_iter()
                .find(|span| span.attributes["gen_ai.agent.id"] == id)
                .unwrap();
            assert_eq!(span.attributes["gen_ai.usage.input_tokens"], tokens);
            if id == "grandchild" {
                assert_eq!(span.status["code"], 2);
                assert_eq!(
                    span.attributes["agent.qwen-code-cli.subagent.status"],
                    "failed"
                );
            }
        }
        for span in result
            .spans
            .iter()
            .filter(|span| span.attributes["gen_ai.span.kind"] != "ENTRY")
        {
            let parent = result
                .spans
                .iter()
                .find(|parent| Some(&parent.span_id) == span.parent_span_id.as_ref())
                .unwrap();
            assert!(span.start_time >= parent.start_time);
            assert!(span.end_time <= parent.end_time);
        }
    }
}

#[test]
fn ambiguous_and_cyclic_children_are_not_attached_to_unrelated_tools() {
    let mut records = llm("qwen-code-cli", "parent", "s1", 10, 20, 1);
    records.extend(tool("qwen-code-cli", "parent", "outer", 20, 90));
    for id in ["child1", "child2"] {
        records.extend(child(
            llm("qwen-code-cli", id, "s1", 30, 40, 1),
            "parent",
            "outer",
        ));
    }
    records.extend(child(
        llm("qwen-code-cli", "cycle", "s1", 30, 40, 1),
        "cycle",
        "missing",
    ));
    let result = convert_qwen_subagents(
        &records,
        &ConvertOptions::default(),
        &GenAiEventLogConverter,
    )
    .unwrap();
    assert_eq!(kind(&result, "AGENT").len(), 1);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("matching parent tool")));
    tree(&result);
}

#[test]
fn delegated_turn_suppresses_entry_and_retains_external_parent() {
    for agent in ["openclaw", "hermes"] {
        let mut records = child(llm(agent, "child", "s1", 30, 40, 1), "parent", "call");
        for record in &mut records {
            record.parent_span_id = Some("abcdef0123456789".into());
        }
        let result = convert_delegated_turn(
            &records,
            &ConvertOptions::default(),
            &GenAiEventLogConverter,
        )
        .unwrap();
        assert!(result.warnings.is_empty());
        assert!(kind(&result, "ENTRY").is_empty());
        assert_eq!(result.span_count, 3);
        assert_eq!(
            kind(&result, "AGENT")[0].parent_span_id.as_deref(),
            Some("abcdef0123456789")
        );
        assert!(result
            .spans
            .iter()
            .all(|span| span.attributes["gen_ai.agent.scope"] == "subagent"));
    }
}

#[test]
fn incremental_input_reconstruction_does_not_leak_future_messages() {
    let mut first = llm("claude-code", "parent", "s1", 10, 20, 1);
    let initial = first[0].input_messages_delta.clone().unwrap();
    let mut second = llm("claude-code", "parent", "s2", 30, 40, 1);
    let delta = json!([{"role":"tool", "content":"next round 😀"}]);
    second[0].input_messages_delta = Some(delta.clone());
    first.extend(second);
    let result = GenAiEventLogConverter
        .convert(&first, &ConvertOptions::default())
        .unwrap();
    let spans = kind(&result, "LLM");
    let input = |span: &ReadableSpan| {
        serde_json::from_str::<Value>(span.attributes["gen_ai.input.messages"].as_str().unwrap())
            .unwrap()
    };
    assert_eq!(input(spans[0]), initial);
    let mut expected = initial.as_array().unwrap().clone();
    expected.extend(delta.as_array().unwrap().clone());
    assert_eq!(input(spans[1]), json!(expected));
    assert_eq!(input(kind(&result, "AGENT")[0]), initial);
}
