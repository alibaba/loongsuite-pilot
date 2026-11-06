//! Synthetic Claude Code skill loads.
//!
//! Port of `deterministicSkillLoadId`, `appendSyntheticSkillCalls`, and
//! `injectSyntheticSkillHistory` from `assets/hooks/claude-code-hook-processor.mjs`.
//! Explicit `/skill` and runtime meta injections have no model `tool_use` id, so
//! the same transcript fields always mint the same `toolu_skillload_` call id.
//! Subagent finalization and intercept/attempt merging live in this file as well.

use super::super::common::{
    collect_resource_attributes, data_dir, finite_f64, iso_to_unix_nanos, load_runtime_config,
    now_unix_nanos, parse_span_attributes, random_hex, sanitize_record, sha256_hex,
    write_jsonl_records, Env, Obj,
};
use super::{
    build_subagent_records, extend_background_agent_result, js_object_truthy, now_ms,
    pending_link_from_value, pending_link_value, push_finalized_ids, record_list,
    resolve_subagent_transcript_path, sort_records, wait_for_transcript_stable, AttemptContext,
    AttemptRecord, InterceptRecord, LlmCall, PendingLink, RecordBuildContext, SubagentLink,
    AGENT_ID, INTERCEPT_STALE_MS, MAX_ATTEMPT_BYTES, MAX_ATTEMPT_FILES,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug)]
pub struct SkillLoad {
    pub prompt_id: Option<String>,
    pub source_tool_use_id: Option<String>,
    pub name: Option<String>,
    pub id: Option<String>,
    pub root_path: Option<String>,
    pub meta_uuid: Option<String>,
    pub meta_timestamp: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SyntheticSkill {
    pub call_id: String,
    pub name: String,
    pub load_index: usize,
}

const SKILL_BASE_DIR_PREFIX: &str = "Base directory for this skill:";

pub fn normalize_skill_name(value: &str) -> Option<String> {
    let name = value.trim().trim_start_matches('/');
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

pub fn extract_skill_root_path(text: &str) -> Option<String> {
    if !text.starts_with(SKILL_BASE_DIR_PREFIX) {
        return None;
    }
    let first_line = text.split('\n').next().unwrap_or(text);
    let base = first_line[SKILL_BASE_DIR_PREFIX.len()..].trim();
    if base.is_empty() {
        return None;
    }
    let trimmed = base.trim_end_matches(['\\', '/']);
    Some(format!("{trimmed}/SKILL.md"))
}

pub fn extract_slash_command_name(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let start = lower.find("<command-name>")?;
    let after = &text[start + "<command-name>".len()..];
    let end = after.to_ascii_lowercase().find("</command-name>")?;
    let inner = after[..end].trim();
    if !inner.starts_with('/') {
        return None;
    }
    let token = inner[1..]
        .split(|ch: char| ch.is_whitespace() || ch == '<')
        .next()
        .unwrap_or("");
    if token.is_empty() {
        None
    } else {
        normalize_skill_name(token)
    }
}

pub fn extract_skill_name_from_root_path(root_path: &str) -> Option<String> {
    let stripped = if root_path.to_ascii_lowercase().ends_with("skill.md") {
        root_path[..root_path.len() - "skill.md".len()].trim_end_matches(['\\', '/'])
    } else {
        root_path
    };
    let name = stripped.split(['\\', '/']).rfind(|part| !part.is_empty())?;
    normalize_skill_name(name)
}

pub fn deterministic_skill_load_id(
    session_id: &str,
    prompt_id: &str,
    meta_uuid: &str,
    root_path: &str,
) -> String {
    let material = format!("{session_id}\0{prompt_id}\0{meta_uuid}\0{root_path}");
    let digest = sha256_hex(material.as_bytes());
    format!("toolu_skillload_{}", &digest[..24])
}

pub fn skill_fields(
    load: Option<&SkillLoad>,
    fallback_name: Option<&str>,
) -> Vec<(String, String)> {
    let fallback = fallback_name.and_then(normalize_skill_name);
    let name = load
        .and_then(|load| load.name.clone())
        .filter(|name| !name.is_empty())
        .or(fallback);
    let id = load
        .and_then(|load| load.id.clone())
        .filter(|id| !id.is_empty())
        .or_else(|| name.clone());
    let mut fields = Vec::new();
    if let Some(name) = name {
        fields.push(("gen_ai.skill.name".into(), name));
    }
    if let Some(id) = id {
        fields.push(("gen_ai.skill.id".into(), id));
    }
    fields
}

pub fn synthetic_skills(
    session_id: &str,
    turn_prompt_id: Option<&str>,
    loads: &[SkillLoad],
    real_tool_ids: &HashSet<String>,
) -> Vec<SyntheticSkill> {
    let mut skills = Vec::new();
    let mut seen = HashSet::new();
    for (index, load) in loads.iter().enumerate() {
        if let Some(source) = load
            .source_tool_use_id
            .as_deref()
            .filter(|source| !source.is_empty())
        {
            if real_tool_ids.contains(source) {
                continue;
            }
        }
        let prompt = load
            .prompt_id
            .as_deref()
            .filter(|prompt| !prompt.is_empty())
            .or_else(|| turn_prompt_id.filter(|prompt| !prompt.is_empty()))
            .unwrap_or("");
        let meta = load
            .meta_uuid
            .as_deref()
            .filter(|meta| !meta.is_empty())
            .or(load.meta_timestamp.as_deref())
            .unwrap_or("");
        let root = load.root_path.as_deref().unwrap_or("");
        let call_id = deterministic_skill_load_id(session_id, prompt, meta, root);
        if !seen.insert(call_id.clone()) {
            continue;
        }
        let name = load
            .name
            .clone()
            .filter(|name| !name.is_empty())
            .or_else(|| load.id.clone().filter(|id| !id.is_empty()))
            .unwrap_or_else(|| "unknown".into());
        skills.push(SyntheticSkill {
            call_id,
            name,
            load_index: index,
        });
    }
    skills
}

fn synthetic_call_part(skill: &SyntheticSkill) -> Value {
    json!({
        "type": "tool_call",
        "id": skill.call_id,
        "name": "load_skill",
        "arguments": { "skill": skill.name },
    })
}

fn synthetic_result_message(skill: &SyntheticSkill) -> Value {
    json!({
        "role": "tool",
        "parts": [{
            "type": "tool_call_response",
            "id": skill.call_id,
            "response": { "success": true },
        }],
    })
}

fn tool_call_ids(message: &Value) -> HashSet<String> {
    message
        .get("parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("tool_call"))
                .filter_map(|part| {
                    part.get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parts_array(message: &mut Value) -> Option<&mut Vec<Value>> {
    let object = message.as_object_mut()?;
    let parts = object
        .entry("parts")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !parts.is_array() {
        *parts = Value::Array(Vec::new());
    }
    parts.as_array_mut()
}

pub fn append_synthetic_skill_calls(output_messages: &mut [Value], skills: &[SyntheticSkill]) {
    let Some(assistant) = output_messages
        .iter_mut()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
    else {
        return;
    };
    let Some(parts) = parts_array(assistant) else {
        return;
    };
    let existing: HashSet<String> = parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("tool_call"))
        .filter_map(|part| part.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    for skill in skills {
        if !existing.contains(&skill.call_id) {
            parts.push(synthetic_call_part(skill));
        }
    }
}

pub fn inject_synthetic_skill_history(
    input_messages: &mut Vec<Value>,
    first_output: &[Value],
    skills: &[SyntheticSkill],
) {
    if skills.is_empty() {
        return;
    }
    let Some(first_assistant) = first_output
        .iter()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
    else {
        return;
    };
    let native_ids = tool_call_ids(first_assistant);
    let mut assistant_index = input_messages.iter().position(|message| {
        message.get("role").and_then(Value::as_str) == Some("assistant")
            && !native_ids.is_empty()
            && native_ids
                .iter()
                .all(|id| tool_call_ids(message).contains(id))
    });
    if assistant_index.is_none() {
        let expected = serde_json::to_string(
            first_assistant
                .get("parts")
                .unwrap_or(&Value::Array(Vec::new())),
        )
        .unwrap_or_default();
        assistant_index = input_messages.iter().position(|message| {
            message.get("role").and_then(Value::as_str) == Some("assistant")
                && serde_json::to_string(message.get("parts").unwrap_or(&Value::Array(Vec::new())))
                    .unwrap_or_default()
                    == expected
        });
    }
    let Some(assistant_index) = assistant_index else {
        return;
    };
    if let Some(parts) = parts_array(&mut input_messages[assistant_index]) {
        let existing: HashSet<String> = parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("tool_call"))
            .filter_map(|part| part.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        for skill in skills {
            if !existing.contains(&skill.call_id) {
                parts.push(synthetic_call_part(skill));
            }
        }
    }
    let existing_results: HashSet<String> = input_messages
        .iter()
        .flat_map(|message| {
            message
                .get("parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("tool_call_response"))
        .filter_map(|part| {
            part.get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .collect();
    let results: Vec<Value> = skills
        .iter()
        .filter(|skill| !existing_results.contains(&skill.call_id))
        .map(synthetic_result_message)
        .collect();
    let mut insert_at = assistant_index + 1;
    while insert_at < input_messages.len()
        && input_messages[insert_at]
            .get("role")
            .and_then(Value::as_str)
            == Some("tool")
    {
        insert_at += 1;
    }
    for (offset, message) in results.into_iter().enumerate() {
        input_messages.insert(insert_at + offset, message);
    }
}

pub fn skill_load_times(llm_end: Option<&str>) -> (String, String) {
    let parsed = iso_to_unix_nanos(llm_end.unwrap_or(""))
        .parse::<u128>()
        .unwrap_or(0);
    let call = if parsed == 0 {
        now_unix_nanos().parse::<u128>().unwrap_or(0)
    } else {
        parsed
    };
    (call.to_string(), call.saturating_add(1_000_000).to_string())
}

pub struct SkillStep<'a> {
    pub id: &'a str,
    pub span_id: &'a str,
}

struct SyntheticSkillSpan<'a> {
    time: &'a str,
    event_name: &'a str,
    span_id: &'a str,
    call_id: &'a str,
    payload: Value,
    payload_key: Option<&'a str>,
    status: Option<&'a str>,
    fields: &'a [(String, String)],
}

pub fn append_synthetic_skill_spans(
    records: &mut Vec<Obj>,
    base: &Obj,
    step: &SkillStep<'_>,
    loads: &[SkillLoad],
    skills: &[SyntheticSkill],
    consumed: &HashSet<usize>,
    llm_end: Option<&str>,
) {
    let (call_time, result_time) = skill_load_times(llm_end);
    for skill in skills {
        if consumed.contains(&skill.load_index) {
            continue;
        }
        let load = loads.get(skill.load_index);
        let fields = skill_fields(load, None);
        let span_id = random_hex(8);
        records.push(skill_span_record(
            base,
            step,
            SyntheticSkillSpan {
                time: &call_time,
                event_name: "tool.call",
                span_id: &span_id,
                call_id: &skill.call_id,
                payload: json!({ "skill": skill.name }),
                payload_key: None,
                status: None,
                fields: &fields,
            },
        ));
        records.push(skill_span_record(
            base,
            step,
            SyntheticSkillSpan {
                time: &result_time,
                event_name: "tool.result",
                span_id: &span_id,
                call_id: &skill.call_id,
                payload: json!({ "success": true }),
                payload_key: Some("gen_ai.tool.call.result"),
                status: Some("success"),
                fields: &fields,
            },
        ));
    }
}

fn skill_span_record(base: &Obj, step: &SkillStep<'_>, span: SyntheticSkillSpan<'_>) -> Obj {
    let SyntheticSkillSpan {
        time,
        event_name,
        span_id,
        call_id,
        payload,
        payload_key,
        status,
        fields,
    } = span;
    let SkillStep {
        id: step_id,
        span_id: step_span,
    } = *step;
    let mut record = base.clone();
    record.insert("time_unix_nano".into(), Value::String(time.to_string()));
    record.insert(
        "event.id".into(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    record.insert("event.name".into(), Value::String(event_name.into()));
    record.insert("span_id".into(), Value::String(span_id.to_string()));
    record.insert("parent_span_id".into(), Value::String(step_span.into()));
    record.insert("gen_ai.step.id".into(), Value::String(step_id.into()));
    record.insert(
        "gen_ai.tool.name".into(),
        Value::String("load_skill".into()),
    );
    record.insert("gen_ai.tool.type".into(), Value::String("extension".into()));
    record.insert("gen_ai.tool.call.id".into(), Value::String(call_id.into()));
    if event_name == "tool.call" {
        record.insert("gen_ai.tool.call.arguments".into(), payload);
    } else if let Some(key) = payload_key {
        record.insert(key.into(), payload);
    }
    if let Some(status) = status {
        record.insert("tool.result.status".into(), Value::String(status.into()));
    }
    for (key, value) in fields {
        record.insert(key.clone(), Value::String(value.clone()));
    }
    record
}

pub fn skill_index_by_tool(loads: &[SkillLoad]) -> HashMap<String, usize> {
    let mut index = HashMap::new();
    for (position, load) in loads.iter().enumerate() {
        if let Some(tool_id) = load
            .source_tool_use_id
            .as_deref()
            .filter(|tool_id| !tool_id.is_empty())
        {
            index.insert(tool_id.to_string(), position);
        }
    }
    index
}

pub(super) fn finalize_pending_subagent_turns(env: &Env, state: &mut Obj) {
    let pending_in = state
        .get("pending_subagent_turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if pending_in.is_empty() {
        return;
    }
    let session_id = state
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let user_id = load_runtime_config(env).user_id;
    let cwd = state
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let resources = collect_resource_attributes(env, AGENT_ID);
    let span_attributes = parse_span_attributes(env, AGENT_ID, true);
    let intercept = load_intercept_for_session(env, &session_id);
    let mut attempts = AttemptContext {
        records: load_attempt_records(env, &session_id),
        consumed: HashSet::new(),
    };
    let mut merged_response_ids = HashSet::new();
    let mut consumed_attempt_files = HashSet::new();
    let mut completed = state
        .get("completed_subagents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let transcript_path = state
        .get("transcript_path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut remaining = Vec::new();
    for pending in &pending_in {
        let Some(pending_obj) = pending.as_object() else {
            continue;
        };
        let mut records = record_list(pending_obj.get("records"));
        let mut links: Vec<PendingLink> = pending_obj
            .get("background_links")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(pending_link_from_value).collect())
            .unwrap_or_default();
        for link in &mut links {
            if link.completed {
                completed.remove(&link.agent_id);
                continue;
            }
            if !js_object_truthy(&completed, &link.agent_id) {
                continue;
            }
            if let Some(path) = resolve_subagent_transcript_path(&transcript_path, &link.agent_id) {
                wait_for_transcript_stable(&path, 0);
            }
            let child_link = SubagentLink {
                agent_id: link.agent_id.clone(),
                agent_name: link.agent_name.clone(),
                parent_tool_call_id: link.parent_tool_call_id.clone(),
                is_background: true,
            };
            let child = build_subagent_records(
                RecordBuildContext {
                    env,
                    user_id: &user_id,
                    cwd: cwd.as_deref(),
                    resources: &resources,
                    span_attributes: &span_attributes,
                    intercept: &intercept,
                    attempts: &mut attempts,
                },
                &transcript_path,
                &session_id,
                pending_obj
                    .get("trace_id")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                pending_obj
                    .get("turn_id")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                &child_link,
            );
            extend_background_agent_result(&mut records, &link.parent_tool_call_id, &child.records);
            records.extend(child.records.into_iter().map(sanitize_record));
            merged_response_ids.extend(child.merged_response_ids);
            consumed_attempt_files.extend(child.consumed_attempt_files);
            link.completed = true;
            completed.remove(&link.agent_id);
        }
        if links.iter().all(|link| link.completed) {
            sort_records(&mut records);
            let _ = write_jsonl_records(
                env,
                &data_dir(env).join("logs").join(AGENT_ID),
                AGENT_ID,
                &records,
            );
            push_finalized_ids(
                state,
                &links
                    .iter()
                    .map(|link| link.agent_id.clone())
                    .collect::<Vec<_>>(),
            );
        } else {
            let mut kept = pending_obj.clone();
            kept.insert(
                "records".into(),
                Value::Array(records.into_iter().map(Value::Object).collect()),
            );
            kept.insert(
                "background_links".into(),
                Value::Array(links.iter().map(pending_link_value).collect()),
            );
            remaining.push(Value::Object(kept));
        }
    }
    state.insert("pending_subagent_turns".into(), Value::Array(remaining));
    state.insert("completed_subagents".into(), Value::Object(completed));
    reap_intercept_files(&intercept, &merged_response_ids);
    reap_attempt_files(&consumed_attempt_files);
    reap_stale_intercept(env, &session_id);
}

pub(super) fn is_span_id(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && value.bytes().any(|byte| byte != b'0')
}

fn intercept_root(env: &Env) -> PathBuf {
    data_dir(env).join("intercept").join(AGENT_ID)
}

fn intercept_session_dir(env: &Env, session_id: &str) -> PathBuf {
    intercept_root(env).join(session_id)
}

pub(super) fn load_intercept_for_session(
    env: &Env,
    session_id: &str,
) -> HashMap<String, InterceptRecord> {
    let mut out = HashMap::new();
    let Ok(entries) = fs::read_dir(intercept_session_dir(env, session_id)) else {
        return out;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.ends_with(".json") {
            continue;
        }
        let path = entry.path();
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(Value::Object(raw)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(response_id) = raw
            .get("response_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
        else {
            continue;
        };
        out.insert(
            response_id,
            InterceptRecord {
                file: path,
                ttft_ns: finite_f64(raw.get("ttft_ns")),
                system_instructions: raw
                    .get("system_instructions")
                    .and_then(Value::as_array)
                    .filter(|items| !items.is_empty())
                    .cloned(),
                llm_span_id: raw
                    .get("llm_span_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            },
        );
    }
    out
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn digit_u128(value: &str) -> Option<u128> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn json_status(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
}

fn attempt_from_json(raw: &Obj, file: PathBuf) -> Option<AttemptRecord> {
    if raw.get("schema_version").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    let attempt_id = raw.get("attempt_id").and_then(Value::as_str)?.to_string();
    let start_ns = digit_u128(raw.get("start_time_unix_nano").and_then(Value::as_str)?)?;
    let end_ns = digit_u128(raw.get("end_time_unix_nano").and_then(Value::as_str)?)?;
    let outcome = raw.get("outcome").and_then(Value::as_str)?.to_string();
    if outcome != "success" && outcome != "http_error" && outcome != "network_error" {
        return None;
    }
    Some(AttemptRecord {
        file,
        attempt_id,
        request_id: optional_string(raw.get("request_id")),
        client_request_id: optional_string(raw.get("client_request_id")),
        response_id: optional_string(raw.get("response_id")),
        request_hash: optional_string(raw.get("request_hash")),
        model: optional_string(raw.get("model")),
        start_ns,
        end_ns,
        outcome,
        status_code: json_status(raw.get("status_code")),
        error_type: optional_string(raw.get("error_type")),
        llm_span_id: optional_string(raw.get("llm_span_id")),
    })
}

pub(super) fn load_attempt_records(env: &Env, session_id: &str) -> Vec<AttemptRecord> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(intercept_session_dir(env, session_id).join("attempts")) else {
        return out;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !name.ends_with(".json") {
            continue;
        }
        let path = entry.path();
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(Value::Object(raw)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(record) = attempt_from_json(&raw, path) {
            out.push(record);
        }
    }
    out.sort_by_key(|entry| entry.start_ns);
    out
}

pub(super) fn reap_intercept_files(
    intercept: &HashMap<String, InterceptRecord>,
    merged: &HashSet<String>,
) {
    for response_id in merged {
        if let Some(data) = intercept.get(response_id) {
            let _ = fs::remove_file(&data.file);
        }
    }
}

pub(super) fn reap_attempt_files(files: &HashSet<PathBuf>) {
    for file in files {
        let _ = fs::remove_file(file);
    }
}

fn file_mtime_ms(meta: &std::fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn cap_attempt_dir(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files = Vec::new();
    let mut total = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        total = total.saturating_add(meta.len());
        files.push((path, file_mtime_ms(&meta), meta.len()));
    }
    if files.len() <= MAX_ATTEMPT_FILES && total <= MAX_ATTEMPT_BYTES {
        return;
    }
    files.sort_by_key(|entry| entry.1);
    let mut count = files.len();
    for (path, _mtime, size) in files {
        if count <= MAX_ATTEMPT_FILES && total <= MAX_ATTEMPT_BYTES {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            count -= 1;
            total = total.saturating_sub(size);
        }
    }
}

fn reap_session_dir(dir: &Path, now: u128) {
    let attempt_dir = dir.join("attempts");
    if let Ok(entries) = fs::read_dir(&attempt_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(meta) = fs::metadata(&path) {
                if now.saturating_sub(file_mtime_ms(&meta)) > INTERCEPT_STALE_MS {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
    cap_attempt_dir(&attempt_dir);
    let _ = fs::remove_dir(&attempt_dir);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(meta) = fs::metadata(&path) {
            if meta.is_file() && now.saturating_sub(file_mtime_ms(&meta)) > INTERCEPT_STALE_MS {
                let _ = fs::remove_file(&path);
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

pub(super) fn reap_stale_intercept(env: &Env, session_id: &str) {
    let now = now_ms();
    reap_session_dir(&intercept_session_dir(env, session_id), now);
    let Ok(entries) = fs::read_dir(intercept_root(env)) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name == session_id {
            continue;
        }
        let path = entry.path();
        if fs::metadata(&path)
            .map(|meta| meta.is_dir())
            .unwrap_or(false)
        {
            reap_session_dir(&path, now);
        }
    }
}

pub(super) fn apply_attempt_attributes(record: &mut Obj, attempt: &AttemptRecord) {
    if record
        .get("gen_ai.request.id")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        return;
    }
    let request_id = attempt
        .request_id
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            attempt
                .client_request_id
                .clone()
                .filter(|value| !value.is_empty())
        });
    if let Some(request_id) = request_id {
        record.insert("gen_ai.request.id".into(), Value::String(request_id));
    }
}

pub(super) fn build_retry_attempt_records(
    attempts: &[AttemptRecord],
    base: &Obj,
    step_id: &str,
    step_span: &str,
    model: &str,
) -> Vec<Obj> {
    let mut records = Vec::new();
    for attempt in attempts {
        if attempt.outcome == "success" {
            continue;
        }
        let span_id = attempt
            .llm_span_id
            .as_deref()
            .filter(|span| is_span_id(span))
            .map(str::to_owned)
            .unwrap_or_else(|| random_hex(8));
        let response_id = format!("attempt:{}", attempt.attempt_id);
        let request_model = attempt
            .model
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                if model.is_empty() {
                    "unknown".into()
                } else {
                    model.to_string()
                }
            });
        let mut request = base.clone();
        request.insert(
            "time_unix_nano".into(),
            Value::String(attempt.start_ns.to_string()),
        );
        request.insert(
            "event.id".into(),
            Value::String(uuid::Uuid::new_v4().to_string()),
        );
        request.insert("event.name".into(), Value::String("llm.request".into()));
        request.insert("span_id".into(), Value::String(span_id.clone()));
        request.insert("parent_span_id".into(), Value::String(step_span.into()));
        request.insert("gen_ai.step.id".into(), Value::String(step_id.into()));
        request.insert(
            "gen_ai.response.id".into(),
            Value::String(response_id.clone()),
        );
        request.insert(
            "gen_ai.provider.name".into(),
            Value::String("anthropic".into()),
        );
        request.insert(
            "gen_ai.request.model".into(),
            Value::String(request_model.clone()),
        );
        request.insert(
            "gen_ai.input.messages_delta".into(),
            Value::Array(Vec::new()),
        );
        apply_attempt_attributes(&mut request, attempt);
        let mut response = base.clone();
        response.insert(
            "time_unix_nano".into(),
            Value::String(attempt.end_ns.to_string()),
        );
        response.insert(
            "event.id".into(),
            Value::String(uuid::Uuid::new_v4().to_string()),
        );
        response.insert("event.name".into(), Value::String("llm.response".into()));
        response.insert("span_id".into(), Value::String(span_id));
        response.insert("parent_span_id".into(), Value::String(step_span.into()));
        response.insert("gen_ai.step.id".into(), Value::String(step_id.into()));
        response.insert("gen_ai.response.id".into(), Value::String(response_id));
        response.insert(
            "gen_ai.provider.name".into(),
            Value::String("anthropic".into()),
        );
        response.insert(
            "gen_ai.request.model".into(),
            Value::String(request_model.clone()),
        );
        response.insert("gen_ai.response.model".into(), Value::String(request_model));
        response.insert("gen_ai.response.finish_reasons".into(), json!(["error"]));
        response.insert("gen_ai.usage.input_tokens".into(), Value::from(0));
        response.insert("gen_ai.usage.output_tokens".into(), Value::from(0));
        response.insert("gen_ai.usage.total_tokens".into(), Value::from(0));
        response.insert(
            "error.type".into(),
            Value::String(
                attempt
                    .error_type
                    .clone()
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "model_error".into()),
            ),
        );
        apply_attempt_attributes(&mut response, attempt);
        if let Some(status) = attempt.status_code {
            response.insert("http.response.status_code".into(), Value::from(status));
        }
        records.push(request);
        records.push(response);
    }
    records
}

pub(super) fn consume_attempts_for_call(
    ctx: &mut AttemptContext,
    call: &LlmCall,
    turn_start_ns: u128,
) -> Vec<AttemptRecord> {
    if ctx.records.is_empty() {
        return Vec::new();
    }
    let mut matches = Vec::new();
    for (index, attempt) in ctx.records.iter().enumerate() {
        let matched = if let Some(request_id) = call
            .api_error
            .as_ref()
            .and_then(|error| error.request_id.as_deref())
            .filter(|id| !id.is_empty())
        {
            attempt.request_id.as_deref() == Some(request_id)
        } else if !call.message_id.is_empty() {
            attempt.response_id.as_deref() == Some(call.message_id.as_str())
        } else {
            false
        };
        if matched {
            matches.push(index);
        }
    }
    if matches.len() != 1 {
        return Vec::new();
    }
    let match_index = matches[0];
    if ctx.consumed.contains(&match_index) || ctx.records[match_index].start_ns < turn_start_ns {
        return Vec::new();
    }
    let mut indices = Vec::new();
    if let Some(hash) = ctx.records[match_index]
        .request_hash
        .clone()
        .filter(|hash| !hash.is_empty())
    {
        let mut next_start = ctx.records[match_index].start_ns;
        let mut index = match_index;
        while index > 0 {
            index -= 1;
            let same_hash = ctx.records[index].request_hash.as_deref() == Some(hash.as_str());
            if !same_hash {
                continue;
            }
            if ctx.consumed.contains(&index)
                || ctx.records[index].outcome == "success"
                || ctx.records[index].start_ns < turn_start_ns
            {
                break;
            }
            if ctx.records[index].end_ns > next_start {
                indices.clear();
                break;
            }
            next_start = ctx.records[index].start_ns;
            indices.push(index);
        }
    }
    indices.reverse();
    indices.push(match_index);
    for index in &indices {
        ctx.consumed.insert(*index);
    }
    indices
        .into_iter()
        .map(|index| ctx.records[index].clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::super::common::{Env, HookRequest};
    use super::super::run;
    use super::deterministic_skill_load_id;
    use serde_json::{json, Value};
    use std::fs;
    use std::path::Path;

    fn invoke(root: &Path, command: &str, payload: &Value) -> String {
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        );
        let args = vec![command.to_string()];
        let stdin = serde_json::to_vec(payload).unwrap();
        let mut stdout = Vec::new();
        let code = {
            let mut request = HookRequest {
                args: &args,
                stdin: &stdin,
                env: &env,
                stdout: &mut stdout,
            };
            run(&mut request)
        };
        assert_eq!(code, 0);
        String::from_utf8(stdout).unwrap()
    }

    fn write_jsonl(path: &Path, records: &[Value]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut body = String::new();
        for record in records {
            body.push_str(&serde_json::to_string(record).unwrap());
            body.push('\n');
        }
        fs::write(path, body).unwrap();
    }

    fn append_jsonl(path: &Path, records: &[Value]) {
        let mut body = fs::read_to_string(path).unwrap_or_default();
        for record in records {
            body.push_str(&serde_json::to_string(record).unwrap());
            body.push('\n');
        }
        fs::write(path, body).unwrap();
    }

    fn read_records(root: &Path) -> Vec<Value> {
        let dir = root.join("logs").join("claude-code");
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(dir) else {
            return out;
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !name.ends_with(".jsonl") {
                continue;
            }
            let text = fs::read_to_string(entry.path()).unwrap_or_default();
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    out.push(value);
                }
            }
        }
        out
    }

    fn read_state(root: &Path, session_id: &str) -> Value {
        let path = root
            .join("state")
            .join("claude-code")
            .join("sessions")
            .join(format!("{session_id}.json"));
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn events<'a>(records: &'a [Value], name: &str, tool: Option<&str>) -> Vec<&'a Value> {
        records
            .iter()
            .filter(|record| {
                record.get("event.name").and_then(Value::as_str) == Some(name)
                    && tool.is_none_or(|tool_name| {
                        record.get("gen_ai.tool.name").and_then(Value::as_str) == Some(tool_name)
                    })
            })
            .collect()
    }

    #[test]
    fn background_subagent_completion_exports_child_on_stop() {
        let root = tempfile::tempdir().unwrap();
        let transcripts = tempfile::tempdir().unwrap();
        let session_id = "s-subagent-background";
        let agent_id = "background-child-1";
        let parent = transcripts.path().join(format!("{session_id}.jsonl"));
        write_jsonl(
            &parent,
            &[
                json!({
                    "type": "user",
                    "timestamp": "2026-06-04T02:57:32.000Z",
                    "message": { "content": [{ "type": "text", "text": "delegate this in background" }] }
                }),
                json!({
                    "type": "assistant",
                    "timestamp": "2026-06-04T02:57:35.000Z",
                    "message": {
                        "id": "msg_parent_bg_1",
                        "content": [{
                            "type": "tool_use",
                            "id": "agent_call_bg_1",
                            "name": "Agent",
                            "input": { "subagent_type": "general-purpose", "run_in_background": true }
                        }],
                        "usage": { "input_tokens": 10, "output_tokens": 5 },
                        "stop_reason": "tool_use"
                    }
                }),
                json!({
                    "type": "user",
                    "timestamp": "2026-06-04T02:57:36.000Z",
                    "toolUseResult": {
                        "agentId": agent_id,
                        "agentType": "general-purpose",
                        "status": "async_launched",
                        "isAsync": true
                    },
                    "message": {
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": "agent_call_bg_1",
                            "content": "Background agent launched successfully."
                        }]
                    }
                }),
                json!({
                    "type": "assistant",
                    "timestamp": "2026-06-04T02:57:37.000Z",
                    "message": {
                        "id": "msg_parent_bg_2",
                        "content": [{ "type": "text", "text": "background task started" }],
                        "usage": { "input_tokens": 20, "output_tokens": 6 },
                        "stop_reason": "end_turn"
                    }
                }),
            ],
        );
        let child = transcripts
            .path()
            .join(session_id)
            .join("subagents")
            .join(format!("agent-{agent_id}.jsonl"));
        write_jsonl(
            &child,
            &[
                json!({
                    "type": "user",
                    "timestamp": "2026-06-04T02:57:35.100Z",
                    "message": { "content": [{ "type": "text", "text": "run background command" }] }
                }),
                json!({
                    "type": "assistant",
                    "timestamp": "2026-06-04T02:57:35.900Z",
                    "message": {
                        "id": "msg_child_bg_1",
                        "content": [{
                            "type": "tool_use",
                            "id": "child_bash_1",
                            "name": "Bash",
                            "input": { "command": "echo done" }
                        }],
                        "usage": { "input_tokens": 7, "output_tokens": 2 },
                        "stop_reason": "tool_use"
                    }
                }),
            ],
        );
        let launch = json!({
            "session_id": session_id,
            "stop_reason": "end_turn",
            "transcript_path": parent,
        });
        assert_eq!(invoke(root.path(), "stop", &launch), "{}\n");
        assert!(read_records(root.path()).is_empty());
        assert_eq!(
            read_state(root.path(), session_id)["pending_subagent_turns"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        append_jsonl(
            &child,
            &[
                json!({
                    "type": "user",
                    "timestamp": "2026-06-04T03:07:36.100Z",
                    "message": {
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": "child_bash_1",
                            "content": "done"
                        }]
                    }
                }),
                json!({
                    "type": "assistant",
                    "timestamp": "2026-06-04T03:07:37.000Z",
                    "message": {
                        "id": "msg_child_bg_2",
                        "content": [{ "type": "text", "text": "background child completed" }],
                        "usage": { "input_tokens": 8, "output_tokens": 4 },
                        "stop_reason": "end_turn"
                    }
                }),
            ],
        );
        let completion = json!({
            "session_id": session_id,
            "agent_id": agent_id,
            "agent_type": "general-purpose",
            "agent_transcript_path": child,
            "transcript_path": parent,
        });
        assert_eq!(invoke(root.path(), "subagent-stop", &completion), "{}\n");
        let records = read_records(root.path());
        let child_response = records
            .iter()
            .find(|record| {
                record.get("event.name").and_then(Value::as_str) == Some("llm.response")
                    && record.get("gen_ai.agent.scope").and_then(Value::as_str) == Some("subagent")
                    && record.get("gen_ai.response.id").and_then(Value::as_str)
                        == Some("msg_child_bg_2")
            })
            .expect("child response");
        assert_eq!(child_response["gen_ai.usage.output_tokens"], 4);
        assert_eq!(child_response["gen_ai.agent.id"], agent_id);
        assert_eq!(child_response["gen_ai.agent.name"], "general-purpose");
        assert_eq!(child_response["gen_ai.agent.depth"], 1);
        assert_eq!(child_response["gen_ai.agent.parent.id"], session_id);
        assert_eq!(
            child_response["gen_ai.subagent.parent_tool_call.id"],
            "agent_call_bg_1"
        );
        assert_eq!(child_response["gen_ai.turn.id"], format!("{session_id}:t1"));
        assert!(child_response["gen_ai.output.messages"]
            .to_string()
            .contains("background child completed"));
        let parent_result = records
            .iter()
            .find(|record| {
                record.get("event.name").and_then(Value::as_str) == Some("tool.result")
                    && record.get("gen_ai.tool.call.id").and_then(Value::as_str)
                        == Some("agent_call_bg_1")
            })
            .expect("parent agent result");
        assert_eq!(
            parent_result["time_unix_nano"],
            child_response["time_unix_nano"]
        );
        let state = read_state(root.path(), session_id);
        assert!(state["pending_subagent_turns"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(state["completed_subagents"].get(agent_id).is_none());

        assert_eq!(invoke(root.path(), "subagent-stop", &completion), "{}\n");
        assert_eq!(read_records(root.path()).len(), records.len());
    }

    #[test]
    fn slash_skill_injects_deterministic_load_skill() {
        let root = tempfile::tempdir().unwrap();
        let transcripts = tempfile::tempdir().unwrap();
        let session_id = "slash-hook";
        let skill_name = "e2e-build-push";
        let base = format!("/abs/workdir/.claude/skills/{skill_name}");
        let root_path = format!("{base}/SKILL.md");
        let transcript = transcripts.path().join(format!("{session_id}.jsonl"));
        write_jsonl(
            &transcript,
            &[
                json!({
                    "type": "user",
                    "promptId": "p1",
                    "timestamp": "2026-07-29T02:00:00.000Z",
                    "message": {
                        "role": "user",
                        "content": [{
                            "type": "text",
                            "text": format!(
                                "<command-message>{skill_name}</command-message>\n<command-name>/{skill_name}</command-name>\n<command-args>run it</command-args>"
                            )
                        }]
                    }
                }),
                json!({
                    "type": "user",
                    "isMeta": true,
                    "promptId": "p1",
                    "uuid": "meta-skill-stable-uuid",
                    "timestamp": "2026-07-29T02:00:00.100Z",
                    "message": {
                        "role": "user",
                        "content": [{
                            "type": "text",
                            "text": format!("Base directory for this skill: {base}\n\n# Title\n\nskill body secret")
                        }]
                    }
                }),
                json!({
                    "type": "assistant",
                    "timestamp": "2026-07-29T02:00:01.000Z",
                    "message": {
                        "id": "msg_read",
                        "model": "claude-opus-4-8",
                        "content": [{
                            "type": "tool_use",
                            "id": "toolu_reference",
                            "name": "Read",
                            "input": { "file_path": format!("{base}/references/guide.md") }
                        }],
                        "usage": { "input_tokens": 5, "output_tokens": 3 },
                        "stop_reason": "tool_use"
                    }
                }),
                json!({
                    "type": "user",
                    "promptId": "p1",
                    "timestamp": "2026-07-29T02:00:01.100Z",
                    "message": {
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": "toolu_reference",
                            "content": "reference body"
                        }]
                    }
                }),
                json!({
                    "type": "assistant",
                    "timestamp": "2026-07-29T02:00:02.000Z",
                    "message": {
                        "id": "msg_final",
                        "model": "claude-opus-4-8",
                        "content": [{ "type": "text", "text": "done" }],
                        "usage": { "input_tokens": 5, "output_tokens": 3 },
                        "stop_reason": "end_turn"
                    }
                }),
            ],
        );
        let payload = json!({
            "session_id": session_id,
            "stop_reason": "end_turn",
            "transcript_path": transcript,
            "cwd": "/abs/workdir",
        });
        assert_eq!(invoke(root.path(), "stop", &payload), "{}\n");
        let records = read_records(root.path());
        let calls = events(&records, "tool.call", Some("load_skill"));
        let results = events(&records, "tool.result", Some("load_skill"));
        assert_eq!(calls.len(), 1);
        assert_eq!(results.len(), 1);
        let expected =
            deterministic_skill_load_id(session_id, "p1", "meta-skill-stable-uuid", &root_path);
        assert_eq!(expected, "toolu_skillload_ff1a29348b7867ba798c76fd");
        assert_eq!(calls[0]["gen_ai.tool.call.id"], expected);
        assert_eq!(results[0]["gen_ai.tool.call.id"], expected);
        assert_eq!(calls[0]["gen_ai.tool.type"], "extension");
        assert_eq!(calls[0]["gen_ai.skill.name"], skill_name);
        assert_eq!(calls[0]["gen_ai.skill.id"], skill_name);
        assert_eq!(
            calls[0]["gen_ai.tool.call.arguments"],
            json!({ "skill": skill_name })
        );
        let call_ns = calls[0]["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap();
        let result_ns = results[0]["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap();
        assert!(result_ns > call_ns);
        let responses = events(&records, "llm.response", None);
        assert_eq!(calls[0]["time_unix_nano"], responses[0]["time_unix_nano"]);
        let output_names: Vec<&str> = responses[0]["gen_ai.output.messages"][0]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|part| part["type"] == "tool_call")
            .map(|part| part["name"].as_str().unwrap())
            .collect();
        assert_eq!(output_names, vec!["Read", "load_skill"]);
        let requests = events(&records, "llm.request", None);
        assert_eq!(
            requests[1]["gen_ai.input.messages_delta"],
            json!([
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "tool_call",
                            "id": "toolu_reference",
                            "name": "Read",
                            "arguments": { "file_path": format!("{base}/references/guide.md") }
                        },
                        {
                            "type": "tool_call",
                            "id": expected,
                            "name": "load_skill",
                            "arguments": { "skill": skill_name }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "parts": [{
                        "type": "tool_call_response",
                        "id": "toolu_reference",
                        "response": "reference body"
                    }]
                },
                {
                    "role": "tool",
                    "parts": [{
                        "type": "tool_call_response",
                        "id": expected,
                        "response": { "success": true }
                    }]
                }
            ])
        );
    }
}
