//! Port of `src/inputs/base/hook-record-transform.ts`.

use crate::normalization::{
    build_agent_activity_entry, enrich_canonical_entry_with_git, normalize_event_name,
    to_json_value,
};
use crate::types::{AgentActivityEntry, ClientType};
use serde_json::{Map, Number, Value};

pub async fn transform_hook_record(
    record: &Map<String, Value>,
    agent_type: ClientType,
    git_namespace: &str,
) -> Option<AgentActivityEntry> {
    let raw_event_name = string_value(record, "event.name")?;
    let event_name = normalize_event_name(Some(&Value::String(raw_event_name)));
    let mut opts = record.clone();
    insert_string(
        &mut opts,
        "time_unix_nano",
        string_value(record, "time_unix_nano"),
    );
    insert_string(
        &mut opts,
        "observed_time_unix_nano",
        string_value(record, "observed_time_unix_nano"),
    );
    insert_string(&mut opts, "event.id", string_value(record, "event.id"));
    opts.insert(
        "event.name".to_string(),
        Value::String(event_name.as_str().to_owned()),
    );
    opts.insert(
        "user.id".to_string(),
        Value::String(string_value(record, "user.id").unwrap_or_default()),
    );
    opts.insert(
        "gen_ai.session.id".to_string(),
        Value::String(
            string_value(record, "gen_ai.session.id")
                .or_else(|| string_value(record, "session.id"))
                .unwrap_or_default(),
        ),
    );
    insert_string(
        &mut opts,
        "gen_ai.turn.id",
        string_value(record, "gen_ai.turn.id").or_else(|| string_value(record, "turn.id")),
    );
    insert_string(
        &mut opts,
        "gen_ai.step.id",
        string_value(record, "gen_ai.step.id").or_else(|| string_value(record, "step.id")),
    );
    opts.insert(
        "gen_ai.agent.type".to_string(),
        Value::String(agent_type.as_str().to_owned()),
    );
    insert_string(
        &mut opts,
        "gen_ai.provider.name",
        string_value(record, "gen_ai.provider.name")
            .or_else(|| string_value(record, "provider.name")),
    );
    insert_string(
        &mut opts,
        "gen_ai.request.model",
        string_value(record, "gen_ai.request.model")
            .or_else(|| string_value(record, "request.model")),
    );
    insert_string(
        &mut opts,
        "gen_ai.response.model",
        string_value(record, "gen_ai.response.model")
            .or_else(|| string_value(record, "response.model")),
    );
    insert_string(
        &mut opts,
        "response.finish_reasons",
        string_value(record, "response.finish_reasons"),
    );
    insert_number(
        &mut opts,
        "gen_ai.usage.input_tokens",
        number_value(record, "gen_ai.usage.input_tokens")
            .or_else(|| number_value(record, "usage.input_tokens")),
    );
    insert_number(
        &mut opts,
        "gen_ai.usage.output_tokens",
        number_value(record, "gen_ai.usage.output_tokens")
            .or_else(|| number_value(record, "usage.output_tokens")),
    );
    insert_number(
        &mut opts,
        "gen_ai.usage.cache_read.input_tokens",
        number_value(record, "gen_ai.usage.cache_read.input_tokens")
            .or_else(|| number_value(record, "usage.cache_read_tokens")),
    );
    insert_number(
        &mut opts,
        "gen_ai.usage.total_tokens",
        number_value(record, "gen_ai.usage.total_tokens")
            .or_else(|| number_value(record, "usage.total_tokens")),
    );
    insert_string(
        &mut opts,
        "gen_ai.input.messages_hash",
        string_value(record, "gen_ai.input.messages_hash")
            .or_else(|| string_value(record, "input.messages_hash")),
    );
    insert_opt(
        &mut opts,
        "gen_ai.input.messages_delta",
        to_json_value(
            record
                .get("gen_ai.input.messages_delta")
                .or_else(|| record.get("input.messages_delta")),
        ),
    );
    insert_opt(
        &mut opts,
        "gen_ai.input.messages",
        to_json_value(
            record
                .get("gen_ai.input.messages")
                .or_else(|| record.get("input.messages")),
        ),
    );
    insert_opt(
        &mut opts,
        "gen_ai.output.messages",
        to_json_value(
            record
                .get("gen_ai.output.messages")
                .or_else(|| record.get("output.messages")),
        ),
    );
    insert_string(
        &mut opts,
        "gen_ai.tool.name",
        string_value(record, "gen_ai.tool.name").or_else(|| string_value(record, "tool.name")),
    );
    insert_string(
        &mut opts,
        "gen_ai.tool.call.id",
        string_value(record, "gen_ai.tool.call.id")
            .or_else(|| string_value(record, "tool.call.id")),
    );
    insert_opt(
        &mut opts,
        "gen_ai.tool.call.arguments",
        to_json_value(
            record
                .get("gen_ai.tool.call.arguments")
                .or_else(|| record.get("tool.arguments")),
        ),
    );
    insert_opt(
        &mut opts,
        "gen_ai.tool.call.result",
        to_json_value(
            record
                .get("gen_ai.tool.call.result")
                .or_else(|| record.get("tool.result")),
        ),
    );
    insert_string(
        &mut opts,
        "tool.result.status",
        string_value(record, "tool.result.status"),
    );
    insert_number(
        &mut opts,
        "gen_ai.tool.call.duration",
        number_value(record, "gen_ai.tool.call.duration")
            .or_else(|| number_value(record, "gen_ai.tool.call.duration_ms"))
            .or_else(|| number_value(record, "tool.result.duration"))
            .or_else(|| number_value(record, "tool.result.duration_ms")),
    );
    for key in [
        "gen_ai.skill.name",
        "gen_ai.skill.id",
        "gen_ai.skill.description",
        "gen_ai.skill.version",
        "error.type",
        "error.message",
    ] {
        insert_string(&mut opts, key, string_value(record, key));
    }
    insert_opt(
        &mut opts,
        "gen_ai.system_instructions",
        to_json_value(record.get("gen_ai.system_instructions")),
    );
    insert_opt(
        &mut opts,
        "gen_ai.tool.definitions",
        to_json_value(record.get("gen_ai.tool.definitions")),
    );
    let mut entry = build_agent_activity_entry(&Value::Object(opts));
    let _ = enrich_canonical_entry_with_git(&mut entry, record, git_namespace).await;
    Some(entry)
}

fn string_value(data: &Map<String, Value>, key: &str) -> Option<String> {
    match data.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

fn number_value(data: &Map<String, Value>, key: &str) -> Option<f64> {
    data.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn insert_string(opts: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        opts.insert(key.to_owned(), Value::String(value));
    }
}

fn insert_number(opts: &mut Map<String, Value>, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        if let Some(number) = Number::from_f64(value) {
            opts.insert(key.to_owned(), Value::Number(number));
        }
    }
}

fn insert_opt(opts: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        opts.insert(key.to_owned(), value);
    }
}
