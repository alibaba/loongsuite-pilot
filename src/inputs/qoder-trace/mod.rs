//! Qoder / qoder-cli trace merge input and its token readers.

pub mod transcript_scanner;
mod intercept_token_reader;
pub mod multimodal;
mod qoder_trace_input;
mod segment_token_reader;
mod sqlite_token_reader;
mod token_enricher;

pub use intercept_token_reader::{
    get_intercept_file, read_intercept_data, read_intercept_file, InterceptData,
    InterceptSystemPrompt, InterceptTokenData,
};
pub use qoder_trace_input::{
    qoder_default_allowed_root_paths, resolve_qoder_allowed_root_paths, QoderTraceInput,
    QoderTraceOptions, QoderTraceReaders,
};
pub use segment_token_reader::{
    read_segment_tokens_for_session, SegmentTokenData, QODER_CN_SEGMENTS_ROOT, QODER_SEGMENTS_ROOT,
};
pub use sqlite_token_reader::{
    is_idea_db_path, read_attached_image_paths, read_attached_image_paths_for_request_ids,
    read_sqlite_tokens, read_sqlite_tokens_for_session, resolve_all_qoder_db_paths,
    resolve_qoder_app_root, resolve_qoder_cn_db_paths, AttachedImageLookup, SqliteTokenData,
    SqliteTokenResult,
};
pub use token_enricher::{
    collect_cli_expected_request_ids, enrich_cli_from_segments, enrich_cli_primary,
    enrich_cli_turn, enrich_ide_turn, inject_trace_id, needs_cli_segment_fallback,
};

pub mod prompt_ownership;

pub mod legacy_hook_reader;
