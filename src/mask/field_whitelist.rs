/// Collector fields whose values may contain prompts, tool output, or routing identifiers.
pub const FIELDS_TO_MASK: &[&str] = &[
    // Routing keys may contain channel sender/group identifiers.
    "agent.openclaw.session_key",
    "gen_ai.input.messages",
    "gen_ai.input.messages_delta",
    "gen_ai.input.multimodal_metadata",
    "gen_ai.input.multimodal_metadata_delta",
    "gen_ai.output.messages",
    "gen_ai.output.multimodal_metadata",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "gen_ai.system_instructions",
    "gen_ai.tool.definitions",
    "error.message",
    "content",
    "inlineDiffMessage",
    "agent.content",
    "agent.inline_diff_message",
    "input.messages",
    "input.messages_delta",
    "output.messages",
    "tool.arguments",
    "tool.result",
    "tool.result.payload",
    "system_instructions",
    "tool.definitions",
    // Native Doubao content is projected into TASK/round/tool spans after masking.
    "agent.doubao_work.tool_observations",
    "agent.doubao_work.task_input",
    "agent.doubao_work.task_output",
    "agent.doubao_work.assistant_rounds",
    "agent._cinput",
    "agent._ctext",
    "agent._ccontent",
    "agent._cthinking",
    "error",
    "error_message",
];

pub fn should_mask_field(field: &str) -> bool {
    FIELDS_TO_MASK.contains(&field)
}
