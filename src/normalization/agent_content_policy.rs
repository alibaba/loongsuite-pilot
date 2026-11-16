use serde_json::{Map, Value};

use crate::types::AgentActivityEntry;

const MESSAGE_CONTENT_FIELDS: &[&str] = &[
    "gen_ai.input.messages",
    "gen_ai.input.messages_delta",
    "gen_ai.input.multimodal_metadata",
    "gen_ai.input.multimodal_metadata_delta",
    "gen_ai.output.messages",
    "gen_ai.output.messages_delta",
    "gen_ai.output.multimodal_metadata",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "gen_ai.system_instructions",
    "gen_ai.tool.definitions",
    "gen_ai.llm.reasoning.text",
    "input.messages",
    "input.messages_delta",
    "output.messages",
    "tool.arguments",
    "tool.result",
    "tool.result.payload",
    "system_instructions",
    "tool.definitions",
    "content",
    "inlineDiffMessage",
    "agent.content",
    "agent.inline_diff_message",
    "agent._cinput",
    "agent._ctext",
    "agent._ccontent",
    "agent._cthinking",
    "agent.doubao_work.tool_observations",
    "agent.doubao_work.task_input",
    "agent.doubao_work.task_output",
    "agent.doubao_work.assistant_rounds",
    "agent.openclaw.persisted_message",
    "agent.openclaw.message",
    "agent.openclaw.last_assistant_message",
    "error",
    "error.message",
    "error_message",
];

const NESTED_CONTENT_FIELDS: &[&str] = &[
    "content",
    "inlineDiffMessage",
    "agent.content",
    "agent.inline_diff_message",
    "_cinput",
    "_ctext",
    "_ccontent",
    "_cthinking",
    "agent._cinput",
    "agent._ctext",
    "agent._ccontent",
    "agent._cthinking",
];

pub(crate) fn remove_message_content_fields(fields: &mut Map<String, Value>) {
    for field in MESSAGE_CONTENT_FIELDS {
        fields.remove(*field);
    }
}

pub(crate) fn strip_agent_message_content(entry: &mut AgentActivityEntry) {
    entry.input_messages = None;
    entry.input_messages_delta = None;
    entry.input_multimodal_metadata = None;
    entry.input_multimodal_metadata_delta = None;
    entry.output_messages = None;
    entry.output_multimodal_metadata = None;
    entry.tool_call_arguments = None;
    entry.tool_call_result = None;
    entry.system_instructions = None;
    entry.tool_definitions = None;
    entry.error_message = None;
    remove_message_content_fields(&mut entry.extra);
    if let Some(attributes) = entry
        .extra
        .get_mut("attributes")
        .and_then(Value::as_object_mut)
    {
        for field in NESTED_CONTENT_FIELDS {
            attributes.remove(*field);
        }
    }
}
