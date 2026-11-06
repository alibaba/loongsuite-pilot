/// Segment records carry Anthropic's native stop_reason, but
/// `gen_ai.response.finish_reasons` is the normalized OTel GenAI enum — the same
/// one the transcript hook emits, so both collection paths must agree, including
/// on which values are dropped. The raw value stays reachable through
/// `attributes.stop_reason`, which entry-builder prefixes to `agent.stop_reason`.
///
/// Duplicated rather than imported from `scripts/validate-trace.mjs`: that is a
/// dev validator, not a runtime dependency of the collector.
///
/// Unknown values are dropped, never coerced to `stop`: a mid-turn value such
/// as `pause_turn` would then read as terminal and flush the turn buffer early.
pub const VALID_FINISH_REASONS: &[&str] = &[
    "stop",
    "length",
    "content_filter",
    "tool_call",
    "tool_calls",
    "error",
    "end_turn",
    "max_tokens",
    // Terminal in otlp-trace-flusher and already emitted by Codex and WorkBuddy.
    "cancelled",
];

pub fn normalize_finish_reason(reason: &str) -> Option<&'static str> {
    let mapped = match reason {
        "tool_use" => "tool_call",
        "stop_sequence" => "stop",
        "refusal" => "stop",
        "model_context_window_exceeded" => "length",
        other => other,
    };
    VALID_FINISH_REASONS
        .iter()
        .copied()
        .find(|item| *item == mapped)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirror of `VALID_FINISH_REASONS` in `scripts/validate-trace.mjs`.
    /// The collector must not import that script at runtime.
    const VALIDATOR_FINISH_REASONS: &[&str] = &[
        "stop",
        "length",
        "content_filter",
        "tool_call",
        "tool_calls",
        "error",
        "end_turn",
        "max_tokens",
        "cancelled",
    ];

    #[test]
    fn keep_finish_reason_allowlist_equal_to_the_trace_validator() {
        let mut ours = VALID_FINISH_REASONS.to_vec();
        let mut validator = VALIDATOR_FINISH_REASONS.to_vec();
        ours.sort_unstable();
        validator.sort_unstable();
        assert_eq!(ours, validator);
    }

    #[test]
    fn maps_vendor_spellings_onto_the_otel_genai_enum() {
        assert_eq!(normalize_finish_reason("tool_use"), Some("tool_call"));
        assert_eq!(normalize_finish_reason("stop_sequence"), Some("stop"));
        assert_eq!(normalize_finish_reason("refusal"), Some("stop"));
        assert_eq!(
            normalize_finish_reason("model_context_window_exceeded"),
            Some("length")
        );
    }

    #[test]
    fn passes_through_values_already_in_the_enum() {
        for reason in VALID_FINISH_REASONS {
            assert_eq!(normalize_finish_reason(reason), Some(*reason));
        }
    }

    #[test]
    fn drops_unknown_values_instead_of_coercing_them_to_a_terminal_reason() {
        assert_eq!(normalize_finish_reason("pause_turn"), None);
        assert_eq!(normalize_finish_reason("some_future_reason"), None);
        assert_eq!(normalize_finish_reason(""), None);
    }
}
