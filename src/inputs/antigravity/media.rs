use std::sync::Arc;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::transcript::Step;
use crate::multimodal::{processor::convert_paths_to_uri_parts, MultimodalProcessor};
use crate::types::{
    multimodal_upload_includes_input, multimodal_upload_includes_output, AgentActivityEntry,
    MultimodalUploadMode,
};

const INPUT: &str = "agent.antigravity.pending_input_media";
const OUTPUT: &str = "agent.antigravity.pending_output_media";

#[derive(Clone)]
pub(super) struct Policy {
    pub processor: Arc<MultimodalProcessor>,
    pub roots: Vec<String>,
    pub mode: MultimodalUploadMode,
}

impl Policy {
    pub(super) fn directions(&self) -> (bool, bool) {
        (
            multimodal_upload_includes_input(self.mode),
            multimodal_upload_includes_output(self.mode),
        )
    }
}

pub(super) fn paths(step: &Step) -> Vec<String> {
    step.media.iter().map(|item| item.uri.clone()).collect()
}

pub(super) fn set_candidates(
    entry: &mut Map<String, Value>,
    output: bool,
    attachments: Vec<Vec<String>>,
) {
    if attachments.iter().any(|paths| !paths.is_empty()) {
        entry.insert(
            if output { OUTPUT } else { INPUT }.into(),
            serde_json::json!(attachments),
        );
    }
}

pub(super) async fn enrich(entry: &mut AgentActivityEntry, policy: Option<&Policy>) {
    let input = entry.extra.shift_remove(INPUT);
    let output = entry.extra.shift_remove(OUTPUT);
    let Some(policy) = policy else {
        return;
    };
    let time = entry
        .time_unix_nano
        .parse::<i128>()
        .ok()
        .and_then(|ns| i64::try_from(ns / 1_000_000).ok())
        .unwrap_or_default();
    if multimodal_upload_includes_input(policy.mode) {
        attach(&mut entry.input_messages_delta, input, policy, time).await;
        if entry.input_messages.is_some() {
            entry.input_messages.clone_from(&entry.input_messages_delta);
        }
        if let (Some(delta), Some(hash)) =
            (&entry.input_messages_delta, &mut entry.input_messages_hash)
        {
            *hash = hex::encode(Sha256::digest(delta.to_string()));
        }
    }
    if multimodal_upload_includes_output(policy.mode) {
        attach(&mut entry.output_messages, output, policy, time).await;
    }
    crate::multimodal::attach_multimodal_metadata_for_entry(entry);
}

async fn attach(
    messages: &mut Option<Value>,
    candidates: Option<Value>,
    policy: &Policy,
    time: i64,
) {
    let Some(messages) = messages.as_mut().and_then(Value::as_array_mut) else {
        return;
    };
    let Some(candidates) =
        candidates.and_then(|value| serde_json::from_value::<Vec<Vec<String>>>(value).ok())
    else {
        return;
    };
    let mut budget = 16;
    for (message, paths) in messages.iter_mut().zip(candidates) {
        let count = paths.len().min(budget);
        if count == 0 {
            continue;
        }
        budget -= count;
        let callback = |path: String, time: i64| async move {
            Ok(policy
                .processor
                .path_to_uri(
                    &path,
                    Some(time as f64),
                    crate::multimodal::PathToUriOptions {
                        allowed_root_paths: Some(policy.roots.clone()),
                        ..Default::default()
                    },
                )
                .await)
        };
        let uris = convert_paths_to_uri_parts(&paths[..count], &callback, time).await;
        if let Some(parts) = message.get_mut("parts").and_then(Value::as_array_mut) {
            parts.retain(|part| part.get("content").and_then(Value::as_str) != Some(""));
            parts.extend(uris);
        }
    }
}
