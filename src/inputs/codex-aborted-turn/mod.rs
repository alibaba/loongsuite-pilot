//! Aborted Codex turn recovery.
//!
//! Wire this module from `src/inputs/mod.rs`:
//!
//! ```ignore
//! #[path = "codex-aborted-turn/mod.rs"]
//! pub mod codex_aborted_turn;
//! ```

mod builder;
mod extractor;
mod input;
mod types;
mod utils;

pub use builder::build_codex_aborted_turn_entries;
pub use extractor::{
    extract_aborted_turn, extract_codex_transcript_meta, session_id_from_transcript_path,
};
pub use input::{CodexAbortedTurnInput, CodexAbortedTurnInputOptions};
pub use types::{
    CodexAbortedCheckpoint, CodexActiveTurn, CodexCompletedTurn, CodexExtractedAbortedTurn,
    CodexTokenUsage, CodexTranscriptMeta, TimelineEvent, MAX_EMITTED_ABORTED_TURNS,
    MAX_PENDING_COMPLETED_TURNS,
};

#[cfg(test)]
mod tests;
