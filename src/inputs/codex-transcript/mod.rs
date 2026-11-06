//! Codex rollout transcript collector.
//!
//! Wire this module from `src/inputs/mod.rs` without replacing `codex_log`:
//!
//! ```ignore
//! #[path = "codex-transcript/mod.rs"]
//! pub mod codex_transcript;
//! ```

mod builder;
mod checkpoint;
mod discovery;
mod extractor;
mod input;
mod invocation_audit;
mod scan;
mod subagent_linker;
mod types;
mod utils;

pub use builder::{
    build_codex_transcript_entries, build_codex_transcript_segment, codex_tool_span_id,
    next_input_messages_for_step, CodexTranscriptBuildOptions, CodexTranscriptBuildResult,
};
pub use extractor::{
    extract_codex_partial_turn, extract_codex_partial_turn_with_boundaries,
    extract_codex_terminal_turn, extract_codex_transcript_meta, session_id_from_transcript_path,
    ExtractOptions,
};
pub use input::{
    codex_default_allowed_root_paths, default_span_context_dir, default_wakeup_dir,
    CodexMultimodalOptions, CodexTranscriptInput, CodexTranscriptInputOptions,
};
pub use subagent_linker::{
    extract_codex_spawn_descriptors, CodexSpawnDescriptor, CodexSubagentLink,
    CodexSubagentLinkConfidence, CodexSubagentLinkSnapshot, CodexSubagentLinker,
    MAX_LINK_DESCRIPTORS,
};
pub use types::{
    CodexActiveTranscriptTurn, CodexExtractedTranscriptTurn, CodexForkBootstrap,
    CodexPartialTurnExtraction, CodexPendingFusionChild, CodexPendingFusionTurn,
    CodexPendingSubagentTurn, CodexPendingTerminalTurn, CodexTerminalStatus,
    CodexTranscriptCheckpoint, CodexTranscriptInputContext, CodexTranscriptMeta,
    CodexTranscriptStep, CodexTranscriptTool, CodexTranscriptUsage, FusionConfidence,
};

#[cfg(test)]
mod tests;
