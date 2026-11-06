use super::types::*;
use super::util::*;
use chrono::{Datelike, TimeZone};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;
pub fn is_doubao_presentation_inspection(name: &str, id: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)^present-files-path-inspection-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$",
        )
        .unwrap()
    });
    name == "Bash" && RE.is_match(id)
}
fn selected_names(value: Option<&Value>) -> Option<Vec<String>> {
    let source = text(value)?;
    if source.encode_utf16().count() > 8192 {
        return None;
    }
    let parsed = parse_json(source).ok()?;
    let values = parsed.as_array()?;
    if values.len() > 32 {
        return None;
    }
    let mut out = Vec::new();
    for value in values {
        let id = identifier(Some(value))?;
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Some(out)
}
fn local_ms(date: chrono::NaiveDateTime) -> Option<i64> {
    if let Some(value) = chrono::Local.from_local_datetime(&date).earliest() {
        return Some(value.timestamp_millis());
    }
    // Match Date's forward adjustment through a local DST gap.
    for minutes in 1..=180 {
        let prior = date - chrono::Duration::minutes(minutes);
        if let Some(value) = chrono::Local.from_local_datetime(&prior).earliest() {
            return value
                .offset()
                .from_local_datetime(&date)
                .single()
                .map(|value| value.timestamp_millis());
        }
    }
    None
}
fn js_local_ms(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    milli: u32,
) -> Option<i64> {
    let year = if (0..=99).contains(&year) {
        year + 1900
    } else {
        year
    };
    let month_index = i64::from(month) - 1;
    let year = year + i32::try_from(month_index.div_euclid(12)).ok()?;
    let month = u32::try_from(month_index.rem_euclid(12) + 1).ok()?;
    let date = chrono::NaiveDate::from_ymd_opt(year, month, 1)?
        .checked_add_signed(chrono::Duration::days(i64::from(day) - 1))?
        .and_hms_milli_opt(hour, minute, second, milli)?;
    local_ms(date)
}
fn source_time(line: &str, file_name: &str) -> Option<String> {
    static FILE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^saman(_frontend)?_(\d{4})\.(\d{2})(\d{2})\.\d+\.log$").unwrap()
    });
    static FRONT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\[\d+:\d+:(\d{2})(\d{2})/(\d{2})(\d{2})(\d{2})\.(\d{6}):(?:INFO|WARNING|ERROR):FRONTEND\(0\)\]").unwrap()
    });
    static CONSOLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\[\d+:\d+:(\d{2})(\d{2})/(\d{2})(\d{2})(\d{2})\.(\d{3}):(?:INFO|WARNING|ERROR):CONSOLE\(0\)\]").unwrap()
    });
    let file = FILE.captures(file_name)?;
    let front = file.get(1).is_some();
    let header = if front {
        FRONT.captures(line)?
    } else {
        CONSOLE.captures(line)?
    };
    let parse = |index: usize| header.get(index)?.as_str().parse::<u32>().ok();
    let (month, day, hour, minute, second) =
        (parse(1)?, parse(2)?, parse(3)?, parse(4)?, parse(5)?);
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let micros = parse(6)? * if front { 1 } else { 1000 };
    let year = file[2].parse::<i32>().ok()?;
    let anchor =
        chrono::NaiveDate::from_ymd_opt(year, file[3].parse().ok()?, file[4].parse().ok()?)?
            .and_hms_opt(0, 0, 0)?;
    let anchor = local_ms(anchor)?;
    let mut candidates = Vec::new();
    for year in [year - 1, year, year + 1] {
        if let Some(ms) = js_local_ms(year, month, day, hour, minute, second, micros / 1000) {
            candidates.push(ms);
        }
    }
    candidates.sort_by_key(|ms| (*ms - anchor).unsigned_abs());
    let ms = *candidates.first()?;
    let date = chrono::Local.timestamp_millis_opt(ms).single()?;
    if date.month() != month || date.day() != day {
        return None;
    }
    Some((i128::from(ms) * 1_000_000 + i128::from(micros % 1000) * 1000).to_string())
}
pub fn parse_doubao_log_line(line: &str, file_name: &str) -> Option<DoubaoLogEvent> {
    if line.contains("[neotix] [agent-task]")
        && line.ends_with(", source: local-file-local-tools-sse-wiring.ts (0)")
    {
        let begin = line.find("\"{")?;
        let end = line.rfind("}\", source:")?;
        if end < begin {
            return None;
        }
        let value = parse_json(&line[begin + 1..end + 1]).ok()?;
        let data = value.get("data")?.as_object()?;
        let time_nano = source_time(line, file_name)?;
        if value.get("event").and_then(Value::as_str) == Some("command")
            && text(data.get("name")) == Some("sandbox")
            && text(data.get("status")) == Some("received")
        {
            return Some(DoubaoLogEvent {
                name: "native_sandbox_actor".into(),
                time_nano,
                command: Some(Command {
                    agent_id: identifier(data.get("agent_id"))?,
                    sandbox_id: identifier(data.get("sand_box_id"))?,
                    id: identifier(data.get("command_id"))?,
                }),
                ..Default::default()
            });
        }
        if value.get("event").and_then(Value::as_str) != Some("toolcall") {
            return None;
        }
        let name = identifier(data.get("name"))?;
        let sandbox_id = identifier(data.get("sandbox_id"))?;
        let received = text(data.get("status")) == Some("received") && !data.contains_key("phase");
        let id = identifier(data.get(if received { "tcid" } else { "toolCallID" }))?;
        let turn_id = identifier(data.get("agent_id"));
        let status = match text(data.get("status")) {
            Some("success") => Some("success"),
            Some("error" | "failed") => Some("error"),
            Some("cancelled") => Some("cancelled"),
            _ => None,
        };
        if received {
            turn_id.as_ref()?;
        } else if text(data.get("phase")) != Some("execution_settled") || status.is_none() {
            return None;
        }
        if is_doubao_presentation_inspection(&name, &id) {
            return None;
        }
        return Some(DoubaoLogEvent {
            name: if received {
                "local_tool_received"
            } else {
                "local_tool_settled"
            }
            .into(),
            time_nano,
            turn_id: if received { turn_id } else { None },
            tool: Some(LocalTool {
                id,
                name,
                sandbox_id,
                phase: if received { "received" } else { "settled" }.into(),
                status: status.map(str::to_owned),
            }),
            ..Default::default()
        });
    }
    static PREFILTER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#""eventName"\s*:\s*"(?:on_message_session_start|on_message_sending_start|on_message_sending_end|general_agent_message_id_mapping|on_message_session_end|flow_message_time)""#).unwrap()
    });
    if !line.contains("[office-api-logger]") || !PREFILTER.is_match(line) {
        return None;
    }
    let begin = line.find("{\"version\":")?;
    let end = line.rfind('}')?;
    if end < begin {
        return None;
    }
    let value = parse_json(&line[begin..=end]).ok()?;
    if safe_i64(value.get("version")?) != Some(1) {
        return None;
    }
    let name = text(value.get("eventName"))?;
    if ![
        "on_message_session_start",
        "on_message_sending_start",
        "on_message_sending_end",
        "general_agent_message_id_mapping",
        "on_message_session_end",
        "flow_message_time",
    ]
    .contains(&name)
    {
        return None;
    }
    let meta = value.get("meta")?.as_object()?;
    let time_nano = source_time(line, file_name)?;
    if name == "flow_message_time" {
        let turn_id = identifier(meta.get("task_session_id"))?;
        let event_id = identifier(meta.get("event_instance_id"))?;
        let answer_id = identifier(meta.get("answer_id"))?;
        let message_id = identifier(meta.get("message_id"))?;
        let duration_ms = safe_i64(meta.get("duration")?)?;
        let prefix = format!("{turn_id}:sync:");
        let suffix = event_id.strip_prefix(&prefix)?;
        static SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+:1$").unwrap());
        if !SUFFIX.is_match(suffix)
            || text(meta.get("metric_scene")) != Some("sse")
            || text(meta.get("ev_name")) != Some("cot_first_token")
            || text(meta.get("ev_type")) != Some("query_duration")
            || text(meta.get("task_stage")) != Some("sync")
            || meta.get("is_recovery") != Some(&Value::Bool(false))
            || safe_i64(meta.get("occurrence_index")?) != Some(1)
            || duration_ms <= 0
            || duration_ms > 86_400_000
        {
            return None;
        }
        return Some(DoubaoLogEvent {
            name: "native_first_model_output".into(),
            time_nano,
            turn_id: Some(turn_id),
            first_output: Some(FirstOutput {
                event_id,
                duration_ms,
                answer_id,
                message_id,
            }),
            ..Default::default()
        });
    }
    let turn_id = identifier(meta.get("chat_session_id"));
    let query_ms = meta.get("query_send_timestamp").and_then(epoch);
    if name != "general_agent_message_id_mapping" && (turn_id.is_none() || query_ms.is_none()) {
        return None;
    }
    let client_outcome = if name == "on_message_session_end" {
        let cancel = identifier(meta.get("cancel_source"));
        let no = |value: Option<&Value>| {
            value.is_some_and(|value| {
                value == &json!("0") || value == &json!(0) || value == &Value::Bool(false)
            })
        };
        let yes = |value: Option<&Value>| {
            value.is_some_and(|value| {
                value == &json!("1") || value == &json!(1) || value == &Value::Bool(true)
            })
        };
        Some(
            if cancel
                .as_ref()
                .is_some_and(|cancel| cancel != "none" && cancel != "0")
            {
                "cancelled"
            } else if no(meta.get("session_success")) {
                "error"
            } else if yes(meta.get("receive_success")) {
                "received"
            } else {
                "ended"
            }
            .into(),
        )
    } else {
        None
    };
    Some(DoubaoLogEvent {
        name: name.into(),
        time_nano,
        turn_id,
        query_ms,
        client_outcome,
        conversation_id: identifier(
            meta.get("conversation_id")
                .filter(|v| !v.is_null())
                .or_else(|| meta.get("conversationId")),
        ),
        local_message_id: identifier(
            meta.get("send_local_message_id")
                .filter(|v| !v.is_null())
                .or_else(|| meta.get("localMessageId")),
        ),
        selected_skills: selected_names(meta.get("mention_skill_list")),
        selected_partners: selected_names(meta.get("mention_partner_list")),
        ..Default::default()
    })
}
pub fn doubao_root_agent_span_id(trace_id: &str) -> String {
    digest(&format!("doubao-work:root-agent:{trace_id}"))[..16].into()
}
pub fn build_doubao_task_events(
    scope: &str,
    pending: &DoubaoPendingTurn,
    terminal: &DoubaoLogEvent,
    observed_ms: i64,
    tools: &[DoubaoToolPair],
) -> Vec<RawEvent> {
    let Some(conversation) = terminal
        .conversation_id
        .as_ref()
        .or(pending.conversation_id.as_ref())
    else {
        return Vec::new();
    };
    if terminal.query_ms != Some(pending.query_ms) {
        return Vec::new();
    }
    let start = i128::from(pending.query_ms) * 1_000_000;
    let Some(end) = nanos(&terminal.time_nano) else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    let identity = encode(&json!([
        scope,
        conversation,
        pending.turn_id,
        pending.query_ms
    ]));
    let outcome = terminal.client_outcome.as_deref().unwrap_or("ended");
    let mut context = RawEvent::new();
    if let Some(values) = pending.selected_skills.as_ref().filter(|v| !v.is_empty()) {
        set(
            &mut context,
            "loongsuite.doubao_work.selected_skills",
            json!(values),
        );
    }
    if let Some(values) = pending.selected_partners.as_ref().filter(|v| !v.is_empty()) {
        set(
            &mut context,
            "loongsuite.doubao_work.selected_partners",
            json!(values),
        );
    }
    let mut common = object(json!({
        "time_unix_nano":start.to_string(),"observed_time_unix_nano":ms_nanos(observed_ms),
        "event.id":"","event.name":"other","user.id":"","trace_id":digest(&identity)[..32],
        "gen_ai.session.id":conversation,"gen_ai.turn.id":pending.turn_id,"gen_ai.agent.type":"doubao-work",
        "gen_ai.agent.id":"doubao-work","gen_ai.agent.name":"Doubao Work","gen_ai.agent.system":"doubao",
        "gen_ai.framework":"doubao-work","gen_ai.provider.name":"bytedance.doubao",
        "loongsuite.doubao_work.observation_scope":"client_message","loongsuite.doubao_work.business_outcome":"unknown",
        "loongsuite.doubao_work.client_outcome":outcome
    }));
    common.extend(context.clone());
    let mut resource = object(
        json!({"loongsuite.doubao_work.observation_scope":"client_message",
        "loongsuite.doubao_work.business_outcome":"unknown","loongsuite.doubao_work.client_outcome":outcome}),
    );
    resource.extend(context);
    set(&mut common, "resourceAttributes", Value::Object(resource));
    let mut middle: Vec<RawEvent> = Vec::new();
    for pair in tools {
        let (Some(call), Some(result)) = (&pair.start.tool, &pair.end.tool) else {
            continue;
        };
        if call.phase != "received"
            || result.phase != "settled"
            || result.status.is_none()
            || call.id != result.id
            || call.name != result.name
            || call.sandbox_id != result.sandbox_id
            || pair.start.turn_id.as_ref() != Some(&pending.turn_id)
        {
            continue;
        }
        let (Some(tool_start), Some(tool_end)) =
            (nanos(&pair.start.time_nano), nanos(&pair.end.time_nano))
        else {
            continue;
        };
        if tool_start < start || tool_end > end || tool_end <= tool_start {
            continue;
        }
        let tool_identity = format!("{identity}:tool:{}:{}", call.sandbox_id, call.id);
        let mut attributes = common.clone();
        set(
            &mut attributes,
            "span_id",
            digest(&tool_identity)[..16].to_owned(),
        );
        set(&mut attributes, "gen_ai.tool.name", call.name.clone());
        set(&mut attributes, "gen_ai.tool.call.id", call.id.clone());
        set(&mut attributes, "gen_ai.tool.type", "function");
        set(
            &mut attributes,
            "loongsuite.doubao_work.tool_boundary",
            "client_received_to_execution_settled",
        );
        let mut event = attributes.clone();
        set(&mut event, "event.name", "tool.call");
        set(
            &mut event,
            "event.id",
            digest(&format!("{tool_identity}:call")),
        );
        set(&mut event, "time_unix_nano", pair.start.time_nano.clone());
        middle.push(event);
        set(&mut attributes, "event.name", "tool.result");
        set(
            &mut attributes,
            "event.id",
            digest(&format!("{tool_identity}:result")),
        );
        set(
            &mut attributes,
            "time_unix_nano",
            pair.end.time_nano.clone(),
        );
        set(
            &mut attributes,
            "gen_ai.tool.call.duration",
            number((tool_end - tool_start) as f64 / 1_000_000.0),
        );
        let status = result.status.as_deref().unwrap();
        set(&mut attributes, "tool.result.status", status);
        if status != "success" {
            set(
                &mut attributes,
                "error.type",
                if status == "cancelled" {
                    "doubao.local_tool_cancelled"
                } else {
                    "doubao.local_tool_failed"
                },
            );
        }
        middle.push(attributes);
    }
    if !pending.first_output_conflict {
        if let Some(mark) = &pending.first_output {
            if mark.turn_id.as_ref() == Some(&pending.turn_id) {
                if let Some(output) = &mark.first_output {
                    let response = start + i128::from(output.duration_ms) * 1_000_000;
                    if nanos(&mark.time_nano).is_some_and(|mark| response <= mark)
                        && response <= end
                    {
                        let step = digest(&format!("{identity}:first-output:{}", output.event_id));
                        let mut attrs = common.clone();
                        for (key, value) in [
                            (
                                "loongsuite.doubao_work.observation_scope",
                                "native_first_model_output",
                            ),
                            (
                                "loongsuite.doubao_work.observation_boundary",
                                "client_submit_to_first_cot_receipt",
                            ),
                            (
                                "loongsuite.doubao_work.timing_basis",
                                "native_query_send_plus_sse_duration",
                            ),
                            (
                                "loongsuite.doubao_work.observation_completeness",
                                "first_output_only",
                            ),
                        ] {
                            set(&mut attrs, key, value);
                        }
                        set(
                            &mut attrs,
                            "loongsuite.doubao_work.native_event_instance_id",
                            output.event_id.clone(),
                        );
                        set(
                            &mut attrs,
                            "loongsuite.doubao_work.native_answer_id",
                            output.answer_id.clone(),
                        );
                        set(
                            &mut attrs,
                            "loongsuite.doubao_work.native_query_message_id",
                            output.message_id.clone(),
                        );
                        set(
                            &mut attrs,
                            "loongsuite.doubao_work.client_time_to_first_cot_ms",
                            output.duration_ms,
                        );
                        set(&mut attrs, "event.name", "other");
                        set(
                            &mut attrs,
                            "event.id",
                            digest(&format!("{step}:observation")),
                        );
                        set(&mut attrs, "time_unix_nano", response.to_string());
                        // Source places first-output observations before tools on equal timestamps.
                        middle.insert(0, attrs);
                    }
                }
            }
        }
    }
    middle.sort_by(|a, b| {
        nanos(a["time_unix_nano"].as_str().unwrap())
            .cmp(&nanos(b["time_unix_nano"].as_str().unwrap()))
    });
    let mut begin = common.clone();
    set(&mut begin, "event.id", digest(&format!("{identity}:start")));
    set(&mut begin, "gen_ai.turn.start", true);
    set(&mut begin, "gen_ai.input.messages_delta", json!([]));
    set(&mut common, "time_unix_nano", end.to_string());
    set(&mut common, "event.id", digest(&format!("{identity}:end")));
    set(&mut common, "gen_ai.turn.end", true);
    if outcome == "error" {
        set(&mut common, "error.type", "doubao.client_request_failed");
    } else if outcome == "cancelled" {
        set(&mut common, "error.type", "doubao.client_request_cancelled");
    }
    let mut entries = vec![begin];
    entries.extend(middle);
    entries.push(common);
    entries
}
