//! Visible Doubao assistant rounds. Provider metadata and usage are never inferred.
use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::doubao_work_converter::{
    digest, fixed_span, get_str, is_identifier, parse_time, root_agent_span_id, PREFIX,
};
use super::otlp_json_serializer::ReadableSpan;

type Record = Map<String, Value>;
#[derive(Clone)]
struct Interval {
    start: i128,
    end: i128,
    status: Option<String>,
}
struct RoundTimes {
    start: i128,
    llm_end: i128,
    end: i128,
    tools: HashMap<String, Interval>,
}
#[derive(Clone)]
pub(super) struct RoundPlacement {
    pub parent_id: String,
    pub step_id: String,
}

pub(super) fn add_assistant_rounds(
    owner: &mut ReadableSpan,
    records: &[Record],
    lower: i128,
    upper: i128,
    owner_record: &Record,
) -> (Vec<ReadableSpan>, HashMap<String, RoundPlacement>) {
    let empty = || (Vec::new(), HashMap::new());
    let Some(value) = owner_record.get("agent.doubao_work.assistant_rounds") else {
        return empty();
    };
    let Some(rounds) = value
        .get("rounds")
        .and_then(Value::as_array)
        .filter(|r| !r.is_empty() && r.len() <= 64)
    else {
        return empty();
    };
    let mut round_ids = HashSet::new();
    let mut call_ids = HashSet::new();
    for round in rounds {
        let Some(id) = round
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| super::doubao_work_converter::is_hex(id, 64))
        else {
            return empty();
        };
        let (Some(ids), Some(tools)) = (
            round.get("callIds").and_then(Value::as_array),
            round.get("tools").and_then(Value::as_array),
        ) else {
            return empty();
        };
        if !round_ids.insert(id)
            || ids.len() != tools.len()
            || !round.get("inputMessages").is_some_and(Value::is_array)
            || !round.get("outputMessages").is_some_and(Value::is_array)
        {
            return empty();
        }
        for (id, tool) in ids.iter().zip(tools) {
            if tool.get("callId") != Some(id)
                || !id.as_str().is_some_and(is_identifier)
                || !tool
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(is_identifier)
                || !tool.get("completed").is_some_and(Value::is_boolean)
                || !call_ids.insert(id.as_str().unwrap())
            {
                return empty();
            }
        }
    }
    let Some(times) = estimate_round_times(rounds, records, lower, upper, owner_record) else {
        owner.attributes.insert(
            format!("{PREFIX}assistant_rounds_not_in_span"),
            rounds.len().into(),
        );
        return empty();
    };
    if value
        .get("omittedRounds")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
    {
        owner.attributes.insert(
            format!("{PREFIX}assistant_rounds_omitted"),
            value["omittedRounds"].clone(),
        );
    }
    let owner_id = if get_str(owner_record, &format!("{PREFIX}observation_scope"))
        == Some("native_sandbox_execution")
    {
        owner.span_id.clone()
    } else {
        root_agent_span_id(&owner.trace_id)
    };
    // Include rejected/incomplete native observations: transcript replay cannot bypass their ambiguity checks.
    let local_ids: HashSet<Option<&str>> = records
        .iter()
        .filter(|r| matches!(get_str(r, "event.name"), Some("tool.call" | "tool.result")))
        .map(|r| get_str(r, "gen_ai.tool.call.id"))
        .collect();
    let mut common = Map::new();
    common.insert("gen_ai.framework".into(), "doubao-work".into());
    for key in [
        "gen_ai.agent.id",
        "gen_ai.agent.name",
        "gen_ai.session.id",
        "gen_ai.turn.id",
        "gen_ai.provider.name",
    ] {
        if let Some(v) = get_str(owner_record, key) {
            common.insert(key.into(), v.into());
        }
    }
    if !common.contains_key("gen_ai.turn.id") {
        if let Some(v) = get_str(owner_record, &format!("{PREFIX}root_turn_id")) {
            common.insert("gen_ai.turn.id".into(), v.into());
        }
    }
    if let Some(v) = get_str(owner_record, "user.id") {
        common.insert("gen_ai.user.id".into(), v.into());
    }
    let mut spans = Vec::new();
    let mut placements = HashMap::new();
    let mut transcript_tools = 0usize;
    let limit = 64usize.saturating_sub(local_ids.len());
    let mut expected_tools = 0usize;
    for (round, time) in rounds.iter().zip(times) {
        let round_id = round["id"].as_str().unwrap();
        let step_id = digest(
            &format!("{}:{owner_id}:assistant-step:{round_id}", owner.trace_id),
            16,
        );
        let mut step = fixed_span(
            "react step",
            &owner.trace_id,
            &step_id,
            Some(&owner.span_id),
            "STEP",
            time.start,
            time.end,
        );
        step.attributes.extend(common.clone());
        step.attributes
            .insert("gen_ai.step.id".into(), step_id.clone().into());
        if let Some(ordinal) = round.get("ordinal") {
            step.attributes
                .insert("gen_ai.react.round".into(), ordinal.clone());
        }
        let llm_id = digest(
            &format!("{}:{owner_id}:assistant-llm:{round_id}", owner.trace_id),
            16,
        );
        let mut llm = fixed_span(
            "chat",
            &owner.trace_id,
            &llm_id,
            Some(&step_id),
            "LLM",
            time.start,
            time.llm_end,
        );
        llm.kind = 2;
        llm.attributes.extend(common.clone());
        llm.attributes
            .insert("gen_ai.step.id".into(), step_id.clone().into());
        for key in ["inputMessages", "outputMessages"] {
            llm.attributes.insert(
                if key == "inputMessages" {
                    "gen_ai.input.messages"
                } else {
                    "gen_ai.output.messages"
                }
                .into(),
                round[key].to_string().into(),
            );
        }
        spans.extend([step, llm]);
        for id in round["callIds"].as_array().unwrap() {
            placements.insert(
                id.as_str().unwrap().into(),
                RoundPlacement {
                    parent_id: step_id.clone(),
                    step_id: step_id.clone(),
                },
            );
        }
        for tool in round["tools"].as_array().unwrap() {
            let id = tool["callId"].as_str().unwrap();
            let name = tool["name"].as_str().unwrap();
            if local_ids.contains(&Some(id)) || tool["completed"] != true {
                continue;
            }
            expected_tools += 1;
            if transcript_tools >= limit {
                continue;
            }
            let interval = time.tools.get(id).cloned().unwrap_or(Interval {
                start: time.llm_end,
                end: time.end,
                status: None,
            });
            let failed = interval.status.as_deref() == Some("error")
                || (matches!(
                    name,
                    "create_agent" | "send_message" | "wait_agent" | "peek_task_progress"
                ) && tool
                    .get("result")
                    .and_then(Value::as_str)
                    .is_some_and(|r| r.starts_with(&format!("{name} failed:"))));
            let span_id = digest(
                &format!("{}:{owner_id}:transcript-tool:{id}", owner.trace_id),
                16,
            );
            let mut span = fixed_span(
                &format!("execute_tool {name}"),
                &owner.trace_id,
                &span_id,
                Some(&step_id),
                "TOOL",
                interval.start,
                interval.end,
            );
            span.attributes.extend(common.clone());
            span.attributes.extend(serde_json::json!({"gen_ai.step.id":step_id,"gen_ai.tool.name":name,"gen_ai.tool.call.id":id,"gen_ai.tool.type":"function"}).as_object().unwrap().clone());
            if let Some(args) = tool.get("arguments") {
                span.attributes
                    .insert("gen_ai.tool.call.arguments".into(), args.to_string().into());
            }
            if let Some(result) = tool.get("result") {
                span.attributes
                    .insert("gen_ai.tool.call.result".into(), result.clone());
            }
            if failed {
                span.status.insert("code".into(), 2.into());
                span.attributes
                    .insert("error.type".into(), "doubao.tool_failed".into());
            }
            spans.push(span);
            transcript_tools += 1;
        }
    }
    if expected_tools > transcript_tools {
        owner.attributes.insert(
            format!("{PREFIX}transcript_tools_not_in_span"),
            (expected_tools - transcript_tools).into(),
        );
    }
    (spans, placements)
}

fn estimate_round_times(
    rounds: &[Value],
    records: &[Record],
    lower: i128,
    upper: i128,
    owner: &Record,
) -> Option<Vec<RoundTimes>> {
    let mut boundaries = vec![Some(lower)];
    let mut indexes = Vec::new();
    for round in rounds {
        let mut tools = HashMap::new();
        for tool in round["tools"].as_array()? {
            let id = tool["callId"].as_str()?;
            let calls: Vec<_> = records
                .iter()
                .filter(|r| {
                    get_str(r, "event.name") == Some("tool.call")
                        && get_str(r, "gen_ai.tool.call.id") == Some(id)
                })
                .collect();
            let results: Vec<_> = records
                .iter()
                .filter(|r| {
                    get_str(r, "event.name") == Some("tool.result")
                        && get_str(r, "gen_ai.tool.call.id") == Some(id)
                })
                .collect();
            if calls.len() == 1 && results.len() == 1 {
                let (a, b) = (calls[0], results[0]);
                let start = parse_time(a.get("time_unix_nano"));
                let end = parse_time(b.get("time_unix_nano"));
                if let (Some(start), Some(end)) = (start, end) {
                    if a.get("gen_ai.tool.name") == b.get("gen_ai.tool.name")
                        && a.get("gen_ai.tool.name") == tool.get("name")
                        && a.get("gen_ai.agent.id") == owner.get("gen_ai.agent.id")
                        && b.get("gen_ai.agent.id") == owner.get("gen_ai.agent.id")
                        && ["trace_id", "gen_ai.session.id", "gen_ai.turn.id"]
                            .into_iter()
                            .all(|k| {
                                a.get(k) == b.get(k)
                                    && (owner.get(k).is_none() || a.get(k) == owner.get(k))
                            })
                        && start >= lower
                        && end <= upper
                        && end > start
                    {
                        tools.insert(
                            id.to_owned(),
                            Interval {
                                start,
                                end,
                                status: get_str(b, "tool.result.status").map(str::to_owned),
                            },
                        );
                    }
                }
            } else if calls.is_empty()
                && results.is_empty()
                && tool["name"] == "Wait"
                && tool["completed"] == true
            {
                if let Some(interval) = tool
                    .get("result")
                    .and_then(Value::as_str)
                    .and_then(|r| native_wait_interval(r, lower, upper))
                {
                    tools.insert(id.to_owned(), interval);
                }
            }
        }
        let start = boundaries.len() - 1;
        let llm_end = boundaries.len();
        boundaries.push(tools.values().map(|i| i.start).min());
        let end = if round["callIds"].as_array()?.is_empty() {
            llm_end
        } else {
            let i = boundaries.len();
            boundaries.push(if tools.len() == round["callIds"].as_array()?.len() {
                tools.values().map(|i| i.end).max()
            } else {
                None
            });
            i
        };
        indexes.push((start, llm_end, end, tools));
    }
    if boundaries.last()?.is_none() {
        *boundaries.last_mut()? = Some(upper);
    }
    let mut left = 0;
    for right in 1..boundaries.len() {
        let Some(finish) = boundaries[right] else {
            continue;
        };
        let begin = boundaries[left]?;
        if finish < begin || finish > upper {
            return None;
        }
        for (j, boundary) in boundaries.iter_mut().enumerate().take(right).skip(left + 1) {
            *boundary =
                Some(begin + (finish - begin) * (j - left) as i128 / (right - left) as i128);
        }
        left = right;
    }
    let mut out = Vec::new();
    for (start, llm_end, end, tools) in indexes {
        let time = RoundTimes {
            start: boundaries[start]?,
            llm_end: boundaries[llm_end]?,
            end: boundaries[end]?,
            tools,
        };
        if time
            .tools
            .values()
            .any(|i| i.start < time.llm_end || i.end > time.end)
        {
            return None;
        }
        out.push(time);
    }
    Some(out)
}

fn native_wait_interval(result: &str, lower: i128, upper: i128) -> Option<Interval> {
    let value: Value = serde_json::from_str(result).ok()?;
    let start = chrono::DateTime::parse_from_rfc3339(value.get("started_at")?.as_str()?)
        .ok()?
        .timestamp_millis();
    let end = chrono::DateTime::parse_from_rfc3339(value.get("ended_at")?.as_str()?)
        .ok()?
        .timestamp_millis();
    let seconds = value.get("actual_waited_seconds")?.as_f64()?;
    if !seconds.is_finite() || end <= start || ((end - start) as f64 / 1000.0 - seconds).abs() > 1.0
    {
        return None;
    }
    let (start, end) = (i128::from(start) * 1_000_000, i128::from(end) * 1_000_000);
    (start >= lower && end <= upper).then_some(Interval {
        start,
        end,
        status: None,
    })
}
