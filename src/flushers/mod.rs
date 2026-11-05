//! 输出管线：HTTP/rustls、SLS 编码与重试、JSONL 轮转，以及原生 GenAI/OTLP。
//! OTLP 默认使用 Rust 事件转换器与 HTTP/protobuf exporter，不需要 JS 运行时。

mod base_flusher;
mod codex_turn_converter;
mod codex_turn_journal;
mod delegated_turn_converter;
mod doubao_turn_journal;
mod doubao_work_converter;
mod doubao_work_round_converter;
mod event_log_converter;
mod http_flusher;
mod jsonl_flusher;
mod multi_flusher;
mod otlp_http_exporter;
mod otlp_json_serializer;
mod otlp_trace_flusher;
mod qwen_subagent_converter;
mod sls_error_classifier;
mod sls_failure_log_writer;
mod sls_flusher;
mod sls_loggroup_codec;
mod sls_transport;
mod span_enricher;
mod span_id_reservation;
mod trace_event_compat;
mod turn_stream;

pub use base_flusher::{
    BaseFlusher, FlushError, FlushErrorKind, TraceRuntimeCounters, TraceRuntimeSnapshot,
};
pub use codex_turn_converter::convert_codex_turn;
pub use codex_turn_journal::{
    codex_turn_journal_group_key, is_journaled_codex_entry, CodexJournalBatch,
    CodexJournalBatchReplay, CodexJournalReplay, CodexTurnJournal,
};
pub use delegated_turn_converter::convert_delegated_turn;
pub use doubao_turn_journal::{
    doubao_turn_journal_group_key, DoubaoJournalReplay, DoubaoTurnJournal,
    DOUBAO_PENDING_GROUP_MAX_BYTES,
};
pub use doubao_work_converter::convert_doubao_work_turn;
pub use event_log_converter::GenAiEventLogConverter;
pub use http_flusher::HttpFlusher;
pub use jsonl_flusher::JsonlFlusher;
pub use multi_flusher::MultiFlusher;
pub use otlp_http_exporter::OtlpHttpExporter;
pub use otlp_json_serializer::{
    create_readable_span_to_otlp_span_json_array, estimate_span_size, hr_time_to_nano,
    ConvertOptions, ConvertResult, EventLogConverter, ReadableSpan, SpanEvent,
};
pub use otlp_trace_flusher::{
    apply_qoder_work_step_timing, ExporterOpts, OtlpEndpointCounter, OtlpTraceFlusher,
    TraceExporter,
};
pub use qwen_subagent_converter::convert_qwen_subagents;
pub use sls_error_classifier::{
    classify_sls_send_error, format_sls_send_failure_message, redact_sensitive_error_text,
    ErrorNode, SlsSendErrorCategory, SlsSendErrorClassification,
};
pub use sls_failure_log_writer::{
    build_sls_failure_log_record, estimate_string_record_bytes, safe_endpoint_file_prefix,
    FailureError, SlsFailureLogInput, SlsFailureLogRecord, SlsFailureLogWriter,
    SLS_FAILURE_ERROR_SUMMARY_MAX_BYTES, SLS_FAILURE_LOG_MAX_FILE_BYTES,
    SLS_FAILURE_LOG_MAX_TOTAL_BYTES, SLS_FAILURE_LOG_SCHEMA_VERSION,
};
pub use sls_flusher::{
    compute_backoff, AkPoster, AlarmSink, EndpointCounter, SigningAkPoster, SlsFlusher,
};
pub use sls_loggroup_codec::{encode_sls_log_group, SlsLogEntryPayload, SlsLogGroupPayload};
pub use sls_transport::{
    build_project_request_target, content_md5_hex, is_retryable, post_api_key_log_store_logs,
    post_webtracking, split_for_webtracking, HttpError, ReqwestSlsHttp, SendError, SlsHttp,
    SlsTransportConfig, WEBTRACKING_MAX_BODY_BYTES, WEBTRACKING_MAX_LOGS, WEBTRACKING_TIMEOUT_MS,
};
pub use span_enricher::{
    run_span_enricher_worker, SpanEnricher, SpanEnricherContext, SpanEnricherRunner, SpanView,
};
pub use span_id_reservation::{ReservedSpanIdGenerator, SpanIdGate, SpanIdReservations};

mod qoder_turn_converter;
pub use qoder_turn_converter::{convert_qoder_turn, QODER_TRANSCRIPT_AGENT_TYPES};
