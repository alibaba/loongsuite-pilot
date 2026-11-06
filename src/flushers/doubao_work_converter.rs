//! Passive Doubao observations: source-accurate client/task/tool lifetimes and visible rounds.
use std::collections::HashMap;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::doubao_work_round_converter::{add_assistant_rounds, RoundPlacement};
use super::otlp_json_serializer::{
    nano_to_hr_time, ConvertOptions, ConvertResult, EventLogConverter, ReadableSpan,
};
use crate::normalization::{entry_from_map, entry_to_object};
use crate::types::AgentActivityEntry;

pub(super) const PREFIX: &str = "loongsuite.doubao_work.";
const CONTRACT: &str = "genai.observed-tools.v1";
type Record = Map<String, Value>;

pub(super) fn digest(value: &str, length: usize) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))[..length].to_owned()
}
pub(super) fn root_agent_span_id(trace: &str) -> String {
    digest(&format!("doubao-work:root-agent:{trace}"), 16)
}
pub(super) fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(super) fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
}
pub(super) fn parse_time(value: Option<&Value>) -> Option<i128> {
    let value = value?.as_str()?;
    (value.len() == 19 && value.bytes().all(|c| c.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}
pub(super) fn get_str<'a>(record: &'a Record, key: &str) -> Option<&'a str> {
    record.get(key).and_then(Value::as_str)
}
pub(super) fn fixed_span(
    name: &str,
    trace: &str,
    id: &str,
    parent: Option<&str>,
    kind: &str,
    start: i128,
    end: i128,
) -> ReadableSpan {
    let operation = match kind {
        "STEP" => "step",
        "LLM" => "chat",
        "TOOL" => "execute_tool",
        "TASK" => "run_task",
        _ => "invoke_agent",
    };
    let mut span = ReadableSpan::minimal(name, trace, id);
    span.parent_span_id = parent.map(str::to_owned);
    span.start_time = nano_to_hr_time(start);
    span.end_time = nano_to_hr_time(end);
    span.duration = nano_to_hr_time(end - start);
    span.attributes
        .insert("gen_ai.span.kind".into(), kind.into());
    span.attributes
        .insert("gen_ai.operation.name".into(), operation.into());
    span
}
fn warning(message: &str) -> ConvertResult {
    ConvertResult {
        warnings: vec![message.into()],
        ..Default::default()
    }
}

pub fn convert_doubao_work_turn(
    records: &[AgentActivityEntry],
    options: &ConvertOptions,
    converter: &dyn EventLogConverter,
) -> Result<ConvertResult, String> {
    let objects: Vec<_> = records.iter().map(entry_to_object).collect();
    if objects.iter().any(|r| {
        get_str(r, &format!("{PREFIX}observation_scope")) == Some("native_sandbox_execution")
    }) {
        return Ok(convert_local_execution(&objects));
    }
    let boundaries: Vec<_> = objects
        .iter()
        .filter(|r| {
            get_str(r, "event.name") == Some("other")
                && get_str(r, &format!("{PREFIX}observation_scope")) == Some("client_message")
                && (r.get("gen_ai.turn.start") == Some(&Value::Bool(true))
                    || r.get("gen_ai.turn.end") == Some(&Value::Bool(true)))
        })
        .collect();
    let start = boundaries
        .iter()
        .copied()
        .find(|r| r.get("gen_ai.turn.start") == Some(&Value::Bool(true)));
    let end = boundaries
        .iter()
        .copied()
        .find(|r| r.get("gen_ai.turn.end") == Some(&Value::Bool(true)));
    let invalid = || {
        warning("Doubao observation has no evidenced client invocation boundary; no invocation spans exported")
    };
    let (Some(start), Some(end)) = (start, end) else {
        return Ok(invalid());
    };
    let (Some(lower), Some(upper)) = (
        parse_time(start.get("time_unix_nano")),
        parse_time(end.get("time_unix_nano")),
    ) else {
        return Ok(invalid());
    };
    if boundaries.len() != 2
        || start.get("gen_ai.turn.id") != end.get("gen_ai.turn.id")
        || start.get("gen_ai.session.id") != end.get("gen_ai.session.id")
        || upper <= lower
    {
        return Ok(invalid());
    }
    let boundary_entries: Vec<_> = boundaries
        .into_iter()
        .map(|r| entry_from_map(r.clone()))
        .collect();
    let mut result = converter.convert(&boundary_entries, options)?;
    if let Some(index) = result
        .spans
        .iter()
        .position(|s| s.attributes.get("gen_ai.span.kind").and_then(Value::as_str) == Some("AGENT"))
    {
        let mut owner = result.spans.remove(index);
        let (rounds, placements) = add_assistant_rounds(&mut owner, &objects, lower, upper, start);
        let tools = add_local_tools(&mut owner, &objects, lower, upper, start, &placements);
        result.spans.insert(index, owner);
        result.spans.extend(rounds);
        result.spans.extend(tools);
    }
    if let Some(output) = end.get("gen_ai.output.messages").filter(|v| v.is_array()) {
        for span in &mut result.spans {
            if matches!(
                span.attributes
                    .get("gen_ai.span.kind")
                    .and_then(Value::as_str),
                Some("ENTRY" | "AGENT")
            ) {
                span.attributes
                    .insert("gen_ai.output.messages".into(), output.to_string().into());
            }
        }
    }
    enrich_client_request(&objects, &mut result.spans);
    enrich_work_spans(&objects, &mut result.spans);
    result.warnings.push("Doubao assistant rounds use visible transcript content and estimated client-side timing; actual provider requests, model usage and full delegated invocation coverage remain unavailable".into());
    result.span_count = result.spans.len();
    Ok(result)
}

struct ToolPair<'a> {
    call: &'a Record,
    result: &'a Record,
    id: &'a str,
    name: &'a str,
    span_id: String,
    start: i128,
    end: i128,
}
fn add_local_tools(
    owner: &mut ReadableSpan,
    records: &[Record],
    lower: i128,
    upper: i128,
    owner_record: &Record,
    placements: &HashMap<String, RoundPlacement>,
) -> Vec<ReadableSpan> {
    // Insertion order determines the same bounded prefix as native source order.
    let mut groups: indexmap::IndexMap<&str, (Vec<&Record>, Vec<&Record>)> =
        indexmap::IndexMap::new();
    for record in records {
        let Some(id) = get_str(record, "gen_ai.tool.call.id").filter(|id| is_identifier(id)) else {
            continue;
        };
        let event = get_str(record, "event.name");
        if !matches!(event, Some("tool.call" | "tool.result"))
            || get_str(record, &format!("{PREFIX}trace_role")) == Some("log_only")
        {
            continue;
        }
        let group = groups.entry(id).or_default();
        if event == Some("tool.call") {
            group.0.push(record);
        } else {
            group.1.push(record);
        }
    }
    let mut pairs = Vec::new();
    let mut counts = HashMap::new();
    for (&id, (calls, results)) in &groups {
        if calls.len() != 1 || results.len() != 1 {
            continue;
        }
        let (call, result) = (calls[0], results[0]);
        let Some(name) = get_str(call, "gen_ai.tool.name").filter(|name| is_identifier(name))
        else {
            continue;
        };
        let (Some(start), Some(end)) = (
            parse_time(call.get("time_unix_nano")),
            parse_time(result.get("time_unix_nano")),
        ) else {
            continue;
        };
        if get_str(result, "gen_ai.tool.name") != Some(name)
            || start < lower
            || end > upper
            || end <= start
            || !matches!(
                get_str(result, "tool.result.status"),
                Some("success" | "error" | "cancelled")
            )
        {
            continue;
        }
        if [
            "trace_id",
            "gen_ai.session.id",
            "gen_ai.turn.id",
            "gen_ai.agent.id",
            "span_id",
        ]
        .into_iter()
        .any(|key| {
            call.get(key) != result.get(key)
                || (key == "trace_id"
                    && call.contains_key(key)
                    && get_str(call, key) != Some(owner.trace_id.as_str()))
                || (key != "span_id"
                    && owner_record.contains_key(key)
                    && call.get(key) != owner_record.get(key))
        }) {
            continue;
        }
        let span_id = match call.get("span_id") {
            Some(Value::String(id)) => id.clone(),
            None => digest(
                &format!("{}:{}:local-tool:{id}", owner.trace_id, owner.span_id),
                16,
            ),
            _ => continue,
        };
        if !is_hex(&span_id, 16) || span_id.bytes().all(|c| c == b'0') || span_id == owner.span_id {
            continue;
        }
        *counts.entry(span_id.clone()).or_insert(0usize) += 1;
        pairs.push(ToolPair {
            call,
            result,
            id,
            name,
            span_id,
            start,
            end,
        });
    }
    let mut spans = Vec::new();
    for pair in pairs {
        if spans.len() >= 64 || counts.get(&pair.span_id) != Some(&1) {
            continue;
        }
        let placement = placements.get(pair.id);
        let parent = placement
            .map(|p| p.parent_id.as_str())
            .unwrap_or(&owner.span_id);
        let mut span = fixed_span(
            &format!("execute_tool {}", pair.name),
            &owner.trace_id,
            &pair.span_id,
            Some(parent),
            "TOOL",
            pair.start,
            pair.end,
        );
        span.attributes.extend(serde_json::json!({"gen_ai.tool.name":pair.name,"gen_ai.tool.call.id":pair.id,"gen_ai.tool.type":"function","loongsuite.trace.contract":CONTRACT,"loongsuite.doubao_work.observation_scope":"native_local_tool_execution","loongsuite.doubao_work.tool_boundary":"client_received_to_execution_settled","loongsuite.doubao_work.trace_completeness":"local_tool_observation","tool.result.status":pair.result["tool.result.status"]}).as_object().unwrap().clone());
        if let Some(p) = placement {
            span.attributes
                .insert("gen_ai.step.id".into(), p.step_id.clone().into());
        }
        for key in [
            "gen_ai.agent.id",
            "gen_ai.agent.name",
            "gen_ai.session.id",
            "gen_ai.turn.id",
            "gen_ai.user.id",
            "gen_ai.conversation.id",
            "gen_ai.framework",
            "loongsuite.doubao_work.native_decision_id",
            "loongsuite.doubao_work.local_executor_tool_name",
        ] {
            if let Some(value) = get_str(pair.call, key) {
                span.attributes.insert(key.into(), value.into());
            }
        }
        if let Some(user) = get_str(pair.call, "user.id") {
            span.attributes.insert("gen_ai.user.id".into(), user.into());
        }
        if !span.attributes.contains_key("gen_ai.turn.id") {
            if let Some(turn) = get_str(owner_record, &format!("{PREFIX}root_turn_id")) {
                span.attributes.insert("gen_ai.turn.id".into(), turn.into());
            }
        }
        if let Some(args) = pair.call.get("gen_ai.tool.call.arguments") {
            if args.is_string() {
                span.attributes
                    .insert("gen_ai.tool.call.arguments".into(), args.clone());
            } else if args.is_object() {
                span.attributes
                    .insert("gen_ai.tool.call.arguments".into(), args.to_string().into());
            }
        }
        if let Some(output) = get_str(pair.result, "gen_ai.tool.call.result") {
            span.attributes
                .insert("gen_ai.tool.call.result".into(), output.into());
        }
        let status = get_str(pair.result, "tool.result.status").unwrap();
        if status != "success" {
            span.status.insert("code".into(), 2.into());
            span.attributes.insert(
                "error.type".into(),
                if status == "cancelled" {
                    "doubao.local_tool_cancelled"
                } else {
                    "doubao.local_tool_failed"
                }
                .into(),
            );
        }
        spans.push(span);
    }
    owner
        .attributes
        .insert("loongsuite.trace.contract".into(), CONTRACT.into());
    owner.attributes.insert(
        format!("{PREFIX}tool_observations_count"),
        spans.len().into(),
    );
    owner.attributes.insert(
        format!("{PREFIX}tool_observations_not_in_span"),
        (groups.values().map(|g| g.0.len()).sum::<usize>() - spans.len()).into(),
    );
    spans
}

fn convert_local_execution(records: &[Record]) -> ConvertResult {
    let start = records
        .iter()
        .find(|r| get_str(r, &format!("{PREFIX}local_execution_phase")) == Some("start"));
    let end = records
        .iter()
        .find(|r| get_str(r, &format!("{PREFIX}local_execution_phase")) == Some("end"));
    let invalid = || warning("Invalid local execution observation; no TASK exported");
    let (Some(start), Some(end)) = (start, end) else {
        return invalid();
    };
    let (Some(lower), Some(upper), Some(origin), Some(span_id)) = (
        parse_time(start.get("time_unix_nano")),
        parse_time(end.get("time_unix_nano")),
        get_str(start, "trace_id"),
        get_str(start, &format!("{PREFIX}local_execution_span_id")),
    ) else {
        return invalid();
    };
    if upper <= lower || !is_hex(origin, 32) || !is_hex(span_id, 16) {
        return invalid();
    }
    let root_start = parse_time(start.get(&format!("{PREFIX}root_request_start_unix_nano")));
    let root_end = parse_time(start.get(&format!("{PREFIX}root_request_end_unix_nano")));
    let bad_root = || {
        warning("Local execution has no consistent originating request boundary; no TASK exported")
    };
    let (Some(root_start), Some(root_end)) = (root_start, root_end) else {
        return bad_root();
    };
    if root_end <= root_start || lower < root_start {
        return bad_root();
    }
    let background = upper > root_end;
    let trace = if background {
        digest(&format!("doubao-work:background:{origin}:{span_id}"), 32)
    } else {
        origin.into()
    };
    let root_id = root_agent_span_id(origin);
    let local_parent = get_str(start, &format!("{PREFIX}parent_resolution"))
        == Some("same_query_native_execution")
        && start.get(&format!("{PREFIX}native_parent_in_request")) == Some(&Value::Bool(true))
        && get_str(start, "parent_span_id").is_some_and(|id| is_hex(id, 16));
    let parent = if background {
        None
    } else if local_parent {
        get_str(start, "parent_span_id")
    } else {
        Some(root_id.as_str())
    };
    let mut owner = fixed_span(
        "run_task doubao.local_execution",
        &trace,
        span_id,
        parent,
        "TASK",
        lower,
        upper,
    );
    owner.attributes.extend(serde_json::json!({"gen_ai.task.name":"doubao.local_execution","gen_ai.framework":"doubao-work","loongsuite.trace.contract":CONTRACT,"loongsuite.doubao_work.observation_scope":"native_sandbox_execution","loongsuite.doubao_work.trace_completeness":"local_execution_observation","loongsuite.doubao_work.trace_parent_resolution":if background { "linked_client_request" } else if local_parent { "enclosing_local_execution" } else { "owning_client_request" }}).as_object().unwrap().clone());
    if background {
        owner
            .attributes
            .insert(format!("{PREFIX}origin_trace_id"), origin.into());
        owner
            .attributes
            .insert(format!("{PREFIX}origin_span_id"), root_id.clone().into());
    }
    if let Some(turn) = get_str(start, &format!("{PREFIX}root_turn_id")) {
        owner
            .attributes
            .insert("gen_ai.turn.id".into(), turn.into());
    }
    for (key, value) in start {
        if value.is_string()
            && (key.starts_with(PREFIX)
                || [
                    "gen_ai.agent.id",
                    "gen_ai.agent.name",
                    "gen_ai.session.id",
                    "gen_ai.turn.id",
                    "gen_ai.user.id",
                ]
                .contains(&key.as_str()))
        {
            owner.attributes.insert(key.clone(), value.clone());
        }
    }
    if let Some(user) = get_str(start, "user.id") {
        owner
            .attributes
            .insert("gen_ai.user.id".into(), user.into());
    }
    for (source, target) in [
        ("agent.doubao_work.task_input", "input"),
        ("agent.doubao_work.task_output", "output"),
    ] {
        if let Some(value) = get_str(start, source) {
            owner
                .attributes
                .insert(format!("{target}.value"), value.into());
            owner
                .attributes
                .insert(format!("{target}.mime_type"), "text/plain".into());
        }
    }
    owner.links.push(serde_json::json!({"context":{"traceId":origin,"spanId":root_id,"traceFlags":1},"attributes":{"loongsuite.link.type":"origin_client_request"}}));
    let observations = start
        .get("agent.doubao_work.tool_observations")
        .and_then(Value::as_array);
    let mut tool_records = Vec::new();
    for raw in observations.into_iter().flatten().take(64) {
        let Some(item) = raw.as_object() else {
            continue;
        };
        let (Some(a), Some(b), Some(id), Some(name)) = (
            parse_time(item.get("startNano")),
            parse_time(item.get("endNano")),
            get_str(item, "callId"),
            get_str(item, "name"),
        ) else {
            continue;
        };
        if a < lower || b > upper {
            continue;
        }
        let mut common = Map::new();
        for key in [
            "gen_ai.agent.id",
            "gen_ai.agent.name",
            "gen_ai.session.id",
            "gen_ai.turn.id",
            "user.id",
        ] {
            if let Some(value) = start.get(key) {
                common.insert(key.into(), value.clone());
            }
        }
        common.insert("trace_id".into(), trace.clone().into());
        common.insert("gen_ai.framework".into(), "doubao-work".into());
        common.insert("gen_ai.tool.call.id".into(), id.into());
        common.insert("gen_ai.tool.name".into(), name.into());
        for (source, target) in [
            ("decisionId", "native_decision_id"),
            ("executorName", "local_executor_tool_name"),
        ] {
            if let Some(value) = item.get(source) {
                common.insert(format!("{PREFIX}{target}"), value.clone());
            }
        }
        let mut call = common.clone();
        call.insert("event.name".into(), "tool.call".into());
        call.insert("time_unix_nano".into(), item["startNano"].clone());
        if let Some(args) = item.get("arguments") {
            call.insert("gen_ai.tool.call.arguments".into(), args.clone());
        }
        let mut result = common;
        result.insert("event.name".into(), "tool.result".into());
        result.insert("time_unix_nano".into(), item["endNano"].clone());
        if let Some(status) = item.get("status") {
            result.insert("tool.result.status".into(), status.clone());
        }
        if let Some(value) = item.get("result") {
            result.insert("gen_ai.tool.call.result".into(), value.clone());
        }
        tool_records.extend([call, result]);
    }
    let mut owner_record = start.clone();
    owner_record.insert("trace_id".into(), trace.clone().into());
    let (rounds, placements) =
        add_assistant_rounds(&mut owner, &tool_records, lower, upper, &owner_record);
    let tools = add_local_tools(
        &mut owner,
        &tool_records,
        lower,
        upper,
        &owner_record,
        &placements,
    );
    if let Some(observations) = observations {
        owner.attributes.insert(
            format!("{PREFIX}tool_observations_not_in_span"),
            (observations.len() - tools.len()).into(),
        );
    }
    let mut spans = vec![owner];
    spans.extend(rounds);
    spans.extend(tools);
    ConvertResult {
        span_count: spans.len(),
        spans,
        trace_ids: vec![trace],
        warnings: vec![],
    }
}

fn enrich_client_request(records: &[Record], spans: &mut [ReadableSpan]) {
    let start = records
        .iter()
        .find(|r| r.get("gen_ai.turn.start") == Some(&Value::Bool(true)));
    let end = records
        .iter()
        .find(|r| r.get("gen_ai.turn.end") == Some(&Value::Bool(true)));
    let (Some(start), Some(end), Some(agent)) = (
        start,
        end,
        spans.iter().find(|s| {
            s.attributes.get("gen_ai.span.kind").and_then(Value::as_str) == Some("AGENT")
        }),
    ) else {
        return;
    };
    let old = agent.span_id.clone();
    let id = root_agent_span_id(&agent.trace_id);
    let has_rounds = spans
        .iter()
        .any(|s| s.attributes.get("gen_ai.span.kind").and_then(Value::as_str) == Some("LLM"));
    let (Some(lower), Some(upper)) = (
        parse_time(start.get("time_unix_nano")),
        parse_time(end.get("time_unix_nano")),
    ) else {
        return;
    };
    let first_output = records
        .iter()
        .find(|r| {
            get_str(r, "event.name") == Some("other")
                && get_str(r, &format!("{PREFIX}observation_scope"))
                    == Some("native_first_model_output")
        })
        .and_then(|r| r.get(&format!("{PREFIX}client_time_to_first_cot_ms")))
        .and_then(Value::as_f64)
        .filter(|n| *n > 0.0 && *n <= 9_007_199_254_740_991.0 && n.fract() == 0.0);
    for span in spans {
        let kind = span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind == "AGENT" {
            span.span_id = id.clone();
        }
        if span.parent_span_id.as_deref() == Some(&old) {
            span.parent_span_id = Some(id.clone());
        }
        if !matches!(kind, "ENTRY" | "AGENT") {
            continue;
        }
        span.start_time = nano_to_hr_time(lower);
        span.end_time = nano_to_hr_time(upper);
        span.duration = nano_to_hr_time(upper - lower);
        if has_rounds {
            span.attributes.remove("loongsuite.trace.contract");
        } else {
            span.attributes
                .insert("loongsuite.trace.contract".into(), CONTRACT.into());
        }
        span.attributes.insert(
            format!("{PREFIX}trace_completeness"),
            if has_rounds {
                "client_request_and_assistant_rounds"
            } else {
                "client_request_and_local_observations"
            }
            .into(),
        );
        span.attributes.insert(
            format!("{PREFIX}unsupported_trace_layers"),
            if has_rounds {
                serde_json::json!([
                    "provider_model_metadata",
                    "provider_usage",
                    "provider_timing",
                    "full_delegated_agent",
                    "complete_background_execution_coverage"
                ])
            } else {
                serde_json::json!([
                    "react",
                    "llm",
                    "cloud_tool_span",
                    "full_delegated_agent",
                    "complete_background_execution_coverage"
                ])
            },
        );
        span.attributes.insert(
            format!("{PREFIX}observed_local_tool_calls"),
            records
                .iter()
                .filter(|r| get_str(r, "event.name") == Some("tool.call"))
                .count()
                .into(),
        );
        if let Some(value) = first_output {
            span.attributes.insert(
                format!("{PREFIX}client_time_to_first_cot_ms"),
                Value::from(value),
            );
        }
    }
}

fn enrich_work_spans(records: &[Record], spans: &mut [ReadableSpan]) {
    let terminal = records
        .iter()
        .rev()
        .find(|r| r.get("gen_ai.turn.end") == Some(&Value::Bool(true)));
    let outcome = terminal.and_then(|r| get_str(r, &format!("{PREFIX}client_outcome")));
    let parent = records.iter().any(|r| {
        get_str(r, "event.name") == Some("other")
            && get_str(r, "parent_span_id")
                .is_some_and(|id| is_hex(id, 16) && id.bytes().any(|c| c != b'0'))
    });
    for span in spans {
        let kind = span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if !matches!(kind.as_str(), "ENTRY" | "AGENT") {
            continue;
        }
        span.attributes
            .insert("gen_ai.framework".into(), "doubao-work".into());
        for key in [
            "loongsuite.doubao_work.selected_skills",
            "loongsuite.doubao_work.selected_partners",
        ] {
            if let Some(value) = terminal.and_then(|r| r.get(key)).filter(|v| {
                v.as_array().is_some_and(|v| {
                    v.len() <= 32 && v.iter().all(|s| s.as_str().is_some_and(is_identifier))
                })
            }) {
                span.attributes.insert(key.into(), value.clone());
            }
        }
        if kind == "ENTRY" && !parent {
            span.parent_span_id = None;
        }
        let failed = matches!(outcome, Some("error" | "cancelled"));
        span.status
            .insert("code".into(), Value::from(if failed { 2 } else { 0 }));
        if failed {
            span.attributes.insert(
                "error.type".into(),
                if outcome == Some("cancelled") {
                    "doubao.client_request_cancelled"
                } else {
                    "doubao.client_request_failed"
                }
                .into(),
            );
        }
    }
}
