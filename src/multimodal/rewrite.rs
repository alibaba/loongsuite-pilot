//! Attach `gen_ai.*.multimodal_metadata` from uri parts already on an entry.

use crate::types::AgentActivityEntry;
use serde_json::{Map, Value};

use super::types::{
    MultimodalMetadataItem, UriPart, INPUT_MULTIMODAL_METADATA_DELTA_FIELD,
    INPUT_MULTIMODAL_METADATA_FIELD, OUTPUT_MULTIMODAL_METADATA_FIELD,
};

pub fn is_uri_part(value: &Value) -> bool {
    value.as_object().is_some_and(|record| {
        record.get("type").and_then(Value::as_str) == Some("uri")
            && record.get("uri").and_then(Value::as_str).is_some()
    })
}

fn uri_part_from(value: &Value) -> Option<UriPart> {
    if !is_uri_part(value) {
        return None;
    }
    let record = value.as_object()?;
    Some(UriPart {
        uri: record.get("uri")?.as_str()?.to_string(),
        mime_type: record
            .get("mime_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        modality: record
            .get("modality")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub fn attach_multimodal_metadata(
    entry: &mut AgentActivityEntry,
    items: &[MultimodalMetadataItem],
) {
    if items.is_empty() {
        entry.input_multimodal_metadata = None;
        return;
    }
    entry.input_multimodal_metadata = Some(items_to_value(items));
}

pub fn attach_multimodal_metadata_for_entry(entry: &mut AgentActivityEntry) {
    let mut input_parts = Vec::new();
    if let Some(Value::Array(messages)) = entry.input_messages_delta.as_ref() {
        input_parts.extend(collect_uri_parts_from_messages(messages));
    }
    if let Some(value) = entry.tool_call_result.as_ref() {
        input_parts.extend(collect_uri_parts_from_value(value));
    }
    write_metadata(
        entry,
        INPUT_MULTIMODAL_METADATA_DELTA_FIELD,
        &metadata_items(&input_parts),
    );

    if let Some(Value::Array(messages)) = entry.input_messages.as_ref() {
        input_parts.extend(collect_uri_parts_from_messages(messages));
    }
    write_metadata(
        entry,
        INPUT_MULTIMODAL_METADATA_FIELD,
        &metadata_items(&input_parts),
    );

    let mut output_parts = Vec::new();
    if let Some(Value::Array(messages)) = entry.output_messages.as_ref() {
        output_parts.extend(collect_uri_parts_from_messages(messages));
    }
    if let Some(value) = entry.tool_call_arguments.as_ref() {
        output_parts.extend(collect_uri_parts_from_value(value));
    }
    write_metadata(
        entry,
        OUTPUT_MULTIMODAL_METADATA_FIELD,
        &metadata_items(&output_parts),
    );
}

/// URI summaries for a converted span's own (possibly cumulative) messages.
pub(crate) fn multimodal_metadata_items_from_messages(messages: &[Value]) -> Value {
    items_to_value(&metadata_items(&collect_uri_parts_from_messages(messages)))
}

fn metadata_items(parts: &[UriPart]) -> Vec<MultimodalMetadataItem> {
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for part in parts {
        if !seen.insert(part.uri.clone()) {
            continue;
        }
        items.push(MultimodalMetadataItem {
            uri: part.uri.clone(),
            mime_type: part
                .mime_type
                .clone()
                .filter(|mime| !mime.is_empty())
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            modality: part.modality.clone().filter(|value| !value.is_empty()),
        });
    }
    items
}

fn write_metadata(entry: &mut AgentActivityEntry, field: &str, items: &[MultimodalMetadataItem]) {
    let slot = match field {
        INPUT_MULTIMODAL_METADATA_FIELD => &mut entry.input_multimodal_metadata,
        INPUT_MULTIMODAL_METADATA_DELTA_FIELD => &mut entry.input_multimodal_metadata_delta,
        OUTPUT_MULTIMODAL_METADATA_FIELD => &mut entry.output_multimodal_metadata,
        _ => return,
    };
    if items.is_empty() {
        *slot = None;
    } else {
        *slot = Some(items_to_value(items));
    }
}

fn items_to_value(items: &[MultimodalMetadataItem]) -> Value {
    Value::Array(
        items
            .iter()
            .map(|item| {
                let mut map = Map::new();
                map.insert("uri".into(), Value::String(item.uri.clone()));
                map.insert("mime_type".into(), Value::String(item.mime_type.clone()));
                if let Some(modality) = &item.modality {
                    map.insert("modality".into(), Value::String(modality.clone()));
                }
                Value::Object(map)
            })
            .collect(),
    )
}

fn collect_uri_parts_from_messages(messages: &[Value]) -> Vec<UriPart> {
    let mut parts = Vec::new();
    for message in messages {
        let Some(record) = message.as_object() else {
            continue;
        };
        let Some(Value::Array(message_parts)) = record.get("parts") else {
            continue;
        };
        for part in message_parts {
            if let Some(uri) = uri_part_from(part) {
                parts.push(uri);
                continue;
            }
            if part.get("type").and_then(Value::as_str) == Some("tool_call_response") {
                if let Some(response) = part.get("response") {
                    parts.extend(collect_uri_parts_from_value(response));
                }
            } else if part.get("type").and_then(Value::as_str) == Some("tool_call") {
                if let Some(arguments) = part.get("arguments") {
                    parts.extend(collect_uri_parts_from_value(arguments));
                }
            }
        }
    }
    parts
}

fn collect_uri_parts_from_value(value: &Value) -> Vec<UriPart> {
    match value {
        Value::Array(items) => items.iter().filter_map(uri_part_from).collect(),
        other => uri_part_from(other).into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_entry(overrides: Value) -> AgentActivityEntry {
        let mut map = json!({
            "time_unix_nano": "0",
            "event.id": "e1",
            "user.id": "u1",
            "event.name": "other",
            "gen_ai.session.id": "s1",
            "gen_ai.agent.type": "codex",
            "gen_ai.provider.name": "openai"
        });
        if let (Value::Object(base), Value::Object(extra)) = (&mut map, overrides) {
            for (key, value) in extra {
                base.insert(key, value);
            }
        }
        serde_json::from_value(map).unwrap()
    }

    // tests/unit/multimodal/rewrite.test.ts: collects URI parts in tool_call arguments.
    #[test]
    fn main2caa_collects_nested_tool_call_arguments() {
        let uri = "oss://bucket/mm/nested.png";
        let mut entry = base_entry(
            json!({"gen_ai.output.messages":[{"role":"assistant","parts":[{
            "type":"tool_call","id":"call-1","name":"Read","arguments":[
                {"type":"text","content":"{\"file_path\":\"/tmp/a.png\"}"},
                {"type":"uri","uri":uri,"mime_type":"image/png","modality":"image"}]}]}]}),
        );
        attach_multimodal_metadata_for_entry(&mut entry);
        assert_eq!(
            entry.output_multimodal_metadata,
            Some(json!([{"uri":uri,"mime_type":"image/png","modality":"image"}]))
        );
    }

    #[test]
    fn is_uri_part_accepts_only_uri_shaped_objects() {
        assert!(is_uri_part(&json!({"type": "uri", "uri": "oss://b/k.png"})));
        assert!(!is_uri_part(&json!({"type": "blob", "content": "x"})));
        assert!(!is_uri_part(&json!({"type": "uri"})));
        assert!(!is_uri_part(&Value::Null));
        assert!(!is_uri_part(&json!("oss://b/k.png")));
    }

    #[test]
    fn attach_deletes_field_when_items_empty() {
        let mut entry = base_entry(json!({
            "gen_ai.input.multimodal_metadata": [{"uri": "oss://old"}]
        }));
        attach_multimodal_metadata(&mut entry, &[]);
        assert!(entry.input_multimodal_metadata.is_none());
    }

    #[test]
    fn skips_when_entry_has_no_uri_parts() {
        let mut entry = base_entry(json!({
            "gen_ai.input.messages": [
                {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
            ]
        }));
        attach_multimodal_metadata_for_entry(&mut entry);
        assert!(entry.input_multimodal_metadata.is_none());
    }

    #[test]
    fn reads_mime_and_dedupes_by_uri() {
        let uri = "oss://bucket/mm/a.png";
        let mut entry = base_entry(json!({
            "gen_ai.input.messages": [{
                "role": "user",
                "parts": [
                    {"type": "uri", "uri": uri, "mime_type": "image/png", "modality": "image"},
                    {"type": "uri", "uri": uri, "mime_type": "image/png", "modality": "image"},
                    {"type": "uri", "uri": "oss://bucket/mm/b.png", "mime_type": "image/jpeg"},
                    {"type": "text", "content": "hi"}
                ]
            }]
        }));
        attach_multimodal_metadata_for_entry(&mut entry);
        assert_eq!(
            entry.input_multimodal_metadata,
            Some(json!([
                {"uri": uri, "mime_type": "image/png", "modality": "image"},
                {"uri": "oss://bucket/mm/b.png", "mime_type": "image/jpeg"}
            ]))
        );
    }

    #[test]
    fn collects_tool_result_uris_into_input_metadata() {
        let uri = "oss://bucket/mm/tool.png";
        let mut entry = base_entry(json!({
            "gen_ai.tool.call.result": [{"type": "uri", "uri": uri, "mime_type": "image/png", "modality": "image"}]
        }));
        attach_multimodal_metadata_for_entry(&mut entry);
        let expected = json!([{"uri": uri, "mime_type": "image/png", "modality": "image"}]);
        assert_eq!(entry.input_multimodal_metadata, Some(expected.clone()));
        assert_eq!(entry.input_multimodal_metadata_delta, Some(expected));
        assert!(entry.output_multimodal_metadata.is_none());
    }

    #[test]
    fn collects_tool_call_argument_uris_into_output_metadata() {
        let uri = "oss://bucket/mm/call.png";
        let mut entry = base_entry(json!({
            "gen_ai.tool.call.arguments": [{"type": "uri", "uri": uri, "mime_type": "image/png", "modality": "image"}]
        }));
        attach_multimodal_metadata_for_entry(&mut entry);
        assert_eq!(
            entry.output_multimodal_metadata,
            Some(json!([{"uri": uri, "mime_type": "image/png", "modality": "image"}]))
        );
        assert!(entry.input_multimodal_metadata.is_none());
    }

    #[test]
    fn ignores_non_uri_tool_arguments() {
        let mut entry =
            base_entry(json!({"gen_ai.tool.call.arguments": {"file_path": "/tmp/a.png"}}));
        attach_multimodal_metadata_for_entry(&mut entry);
        assert!(entry.output_multimodal_metadata.is_none());
    }

    #[test]
    fn writes_output_message_uris_only_to_output_metadata() {
        let uri = "oss://bucket/mm/out.png";
        let mut entry = base_entry(json!({
            "gen_ai.output.messages": [
                {"role": "assistant", "parts": [{"type": "uri", "uri": uri, "mime_type": "image/png", "modality": "image"}]}
            ]
        }));
        attach_multimodal_metadata_for_entry(&mut entry);
        assert_eq!(
            entry.output_multimodal_metadata,
            Some(json!([{"uri": uri, "mime_type": "image/png", "modality": "image"}]))
        );
        assert!(entry.input_multimodal_metadata.is_none());
    }

    #[test]
    fn dedupes_the_same_input_uri_across_messages_and_delta() {
        let uri = "oss://bucket/mm/same.png";
        let part =
            json!({"type": "uri", "uri": uri, "mime_type": "image/png", "modality": "image"});
        let mut entry = base_entry(json!({
            "gen_ai.input.messages": [{"role": "user", "parts": [part.clone()]}],
            "gen_ai.input.messages_delta": [{"role": "user", "parts": [part]}]
        }));
        attach_multimodal_metadata_for_entry(&mut entry);
        assert_eq!(
            entry.input_multimodal_metadata,
            Some(json!([{"uri": uri, "mime_type": "image/png", "modality": "image"}]))
        );
    }

    #[test]
    fn defaults_mime_type_when_uri_part_omits_it() {
        let mut entry = base_entry(json!({
            "gen_ai.input.messages": [
                {"role": "user", "parts": [{"type": "uri", "uri": "oss://b/x.bin"}]}
            ]
        }));
        attach_multimodal_metadata_for_entry(&mut entry);
        assert_eq!(
            entry.input_multimodal_metadata,
            Some(json!([{"uri": "oss://b/x.bin", "mime_type": "application/octet-stream"}]))
        );
        assert!(entry.input_multimodal_metadata_delta.is_none());
    }

    #[test]
    fn keeps_cumulative_messages_out_of_input_metadata_delta() {
        let old_uri = "oss://bucket/mm/old.png";
        let delta_uri = "oss://bucket/mm/delta.png";
        let mut entry = base_entry(json!({
            "gen_ai.input.messages": [
                {"role": "user", "parts": [{"type": "uri", "uri": old_uri, "mime_type": "image/png", "modality": "image"}]}
            ],
            "gen_ai.input.messages_delta": [
                {"role": "user", "parts": [{"type": "uri", "uri": delta_uri, "mime_type": "image/png", "modality": "image"}]}
            ]
        }));
        attach_multimodal_metadata_for_entry(&mut entry);
        assert_eq!(
            entry.input_multimodal_metadata_delta,
            Some(json!([{"uri": delta_uri, "mime_type": "image/png", "modality": "image"}]))
        );
        assert_eq!(
            entry.input_multimodal_metadata,
            Some(json!([
                {"uri": delta_uri, "mime_type": "image/png", "modality": "image"},
                {"uri": old_uri, "mime_type": "image/png", "modality": "image"}
            ]))
        );
    }
}
