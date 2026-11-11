//! 按轮次缓冲事件并执行真实 GenAI 转换、资源投影和 OTLP HTTP/protobuf 导出。
//! 保留终止信号、批量上限、运行指标及失败落盘；依赖注入仅用于测试和扩展。

#[cfg(test)]
#[path = "otlp_multimodal_main568_export_tests.rs"]
mod multimodal_main568_export_tests;
#[path = "otlp_multimodal_span_metadata.rs"]
mod multimodal_span_metadata;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use chrono::Local;
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;
use uuid::Uuid;

use super::base_flusher::{BaseFlusher, FlushError, TraceRuntimeCounters, TraceRuntimeSnapshot};
use super::delegated_turn_converter::convert_delegated_turn;
use super::otlp_json_serializer::{
    create_readable_span_to_otlp_span_json_array, estimate_span_size, hr_time_to_nano,
    nano_to_hr_time, ConvertOptions, ConvertResult, EventLogConverter, ReadableSpan,
};
use super::qwen_subagent_converter::convert_qwen_subagents;
use super::span_enricher::{SpanEnricherContext, SpanEnricherRunner};
use crate::normalization::{
    entry_from_map, entry_to_object, is_openclaw_session_key, is_reserved_key,
    resolve_agent_system, GlobalAttributesProvider, DEFAULT_GIT_PASSTHROUGH_KEYS,
    OPENCLAW_SESSION_KEY, OPENCLAW_SESSION_KEY_AMBIGUOUS,
};
use crate::types::{AgentActivityEntry, OtlpCompression, OtlpTraceFlusherConfig};
use crate::utils::{
    append_segmented_jsonl, create_logger, ensure_dir, format_time, get_today_date_string,
    normalize_agent_type, read_installed_version, DEFAULT_JSONL_SEGMENT_BYTES,
};

#[derive(Clone, Copy)]
struct ConvertScope<'a> {
    agent_type: &'a str,
    service_name: &'a str,
    system: &'a str,
    framework: &'a str,
    convert_key: &'a str,
}

#[derive(Default)]
struct StreamEnrichment {
    grok_instructions_applied: bool,
    reasoning_seen: bool,
    reasoning_total: f64,
}

const VALID_TRACE_ID: &str = "^[0-9a-f]{32}$";
const MAX_TURN_BUFFERS: usize = 64;
const MAX_RUNTIME_AGENTS: usize = 64;
const MAX_CONVERT_STATES: usize = 64;
// Only payload waiting for native terminal evidence is bounded here. Conversion
// rehydrates one complete durable turn at a time.
const MAX_CODEX_TURN_RESIDENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_CODEX_RESIDENT_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_MAX_EXPORT_BATCH_BYTES: u64 = 10 * 1024 * 1024;
const ARMS_TRACE_LOGSTORE: &str = "logstore-tracing";

static TRACE_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(VALID_TRACE_ID).expect("trace id"));
static STEP_ROUND_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[_:s])(\d+)$").expect("step round"));
static SENSITIVE_RESOURCE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$",
    )
    .expect("sensitive")
});

const TERMINAL_FINISH: &[&str] = &["stop", "end_turn", "cancelled", "error"];
const CLAUDE_TERMINAL_FINISH: &[&str] = &["stop", "end_turn", "cancelled"];
const GROK_TERMINAL_FINISH: &[&str] = &["length", "content_filter"];
const USER_IDENTITY_KEYS: &[&str] = &["user.name", "user.email"];
const GROK_PASSTHROUGH: &[&str] = &[
    "loongsuite.grok.match.strategy",
    "loongsuite.grok.timing.source",
];
const OPENCLAW_COMPAT_KEYS: &[&str] = &[
    "agent.openclaw.compatibility",
    "agent.openclaw.timing.inferred",
    "agent.openclaw.timing.source",
    "agent.openclaw.timing.quantized_ms",
    "agent.openclaw.collection.incomplete",
    "agent.openclaw.collection.end_reason",
    "agent.openclaw.correlation.ambiguous",
];
const HIERARCHY_KEYS: &[&str] = &[
    "gen_ai.turn.id",
    "gen_ai.agent.scope",
    "gen_ai.agent.depth",
    "gen_ai.agent.parent.id",
    "gen_ai.subagent.parent_tool_call.id",
    "agent.pilot.parent.turn.id",
    "agent.qwen-code-cli.subagent.collection",
    "agent.qwen-code-cli.subagent.status",
    "agent.qwen-code-cli.timing.source",
];
const SKILL_KEYS: &[&str] = &[
    "gen_ai.skill.name",
    "gen_ai.skill.id",
    "gen_ai.skill.description",
    "gen_ai.skill.version",
];
const RESERVED_RESOURCE_KEYS: &[&str] = &[
    "service.name",
    "service.version",
    "service.instance.id",
    "service.namespace",
    "host.name",
    "gen_ai.agent.type",
    "gen_ai.agent.system",
    "gen_ai.framework",
];
const SPAN_KINDS: &[&str] = &["ENTRY", "AGENT", "STEP", "LLM", "TOOL"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeySource {
    TurnId,
    TraceId,
    SessionId,
    Ephemeral,
}

struct TurnBuffer {
    key: String,
    key_source: KeySource,
    key_value: String,
    agent_type: String,
    session_id: Option<String>,
    records: Vec<AgentActivityEntry>,
    record_index: HashMap<String, usize>,
    journal_key: Option<String>,
    spillable: bool,
    spilled_records: usize,
    spilled_event_ids: Option<HashSet<String>>,
    resident_bytes: usize,
    completed: bool,
    last_activity_ms: i64,
    logical_bytes: f64,
    unmeasured_records: u64,
    opened_at: Instant,
    has_counters: bool,
}

#[derive(Clone, Debug)]
pub struct ExporterOpts {
    pub url: String,
    pub headers: HashMap<String, String>,
    pub compression: String,
    pub name: String,
}

#[async_trait]
pub trait TraceExporter: Send + Sync {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String>;
    async fn shutdown(&self);
}

pub type ExporterFactory = Arc<dyn Fn(ExporterOpts) -> Arc<dyn TraceExporter> + Send + Sync>;

#[derive(Clone, Debug, Default)]
pub struct OtlpEndpointCounter {
    pub in_spans: u64,
    pub in_bytes: u64,
    pub out_spans: u64,
    pub out_bytes: u64,
    pub out_failed: u64,
    pub total_delay_ms: u64,
    pub last_flush_time: String,
    pub start_time: String,
    pub is_cms: bool,
    pub project: String,
    pub logstore: String,
}

#[derive(Clone, Debug)]
struct ResolvedEndpoint {
    name: String,
    url: String,
    headers: HashMap<String, String>,
    compression: String,
    service_name: String,
    append_agent_type: bool,
}

struct ExportState {
    exporters: Vec<(String, Arc<dyn TraceExporter>)>,
}

struct ConvertState {
    active: usize,
}

struct OtlpState {
    buffers: IndexMap<String, TurnBuffer>,
    flushed: HashSet<String>,
    batch_depth: usize,
    counters: IndexMap<String, TraceRuntimeCounters>,
    endpoint_counters: HashMap<String, OtlpEndpointCounter>,
    export_states: HashMap<String, ExportState>,
    convert_states: IndexMap<String, ConvertState>,
    created_exporters: Vec<ExporterOpts>,
}

// The owning scope lives outside Inner: worker→Inner→Weak(scope) has no
// strong cycle. Dropping the last flusher drops JoinSet and aborts its requests.
#[derive(Default)]
struct OrdinaryFlushScope {
    tasks: Mutex<tokio::task::JoinSet<Result<(), FlushError>>>,
    // JoinSet has one join waker. Concurrent flush/shutdown callers must not
    // overwrite each other's waiter; cancellation releases this owned guard.
    draining: tokio::sync::Mutex<()>,
}
impl OrdinaryFlushScope {
    fn report(result: Result<Result<(), FlushError>, tokio::task::JoinError>) {
        let error = match result {
            Ok(Ok(())) => return,
            Ok(Err(error)) => error.to_string(),
            Err(error) => format!("ordinary trace worker failed: {error}"),
        };
        create_logger("otlp-trace-flusher").error(&error, None);
    }
    fn spawn(
        &self,
        job: impl std::future::Future<Output = Result<(), FlushError>> + Send + 'static,
    ) -> tokio::sync::oneshot::Receiver<()> {
        let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        while let Some(result) = tasks.try_join_next() {
            Self::report(result);
        }
        let (finished, waiting) = tokio::sync::oneshot::channel();
        tasks.spawn(async move {
            let result = job.await;
            let _ = finished.send(());
            result
        });
        waiting
    }
    async fn drain(&self) {
        let _draining = self.draining.lock().await;
        while let Some(result) = std::future::poll_fn(|cx| {
            self.tasks
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .poll_join_next(cx)
        })
        .await
        {
            Self::report(result);
        }
    }
}

pub struct OtlpTraceFlusher {
    inner: Arc<OtlpInner>,
    ordinary_flushes: Arc<OrdinaryFlushScope>,
}
impl Drop for OtlpTraceFlusher {
    fn drop(&mut self) {
        if let Some(idle) = self
            .inner
            .idle
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            idle.abort();
        }
    }
}

impl std::fmt::Debug for OtlpTraceFlusher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OtlpTraceFlusher")
            .field("service_name", &self.inner.cfg.service_name)
            .finish()
    }
}

type CodexReplayPrepare =
    Arc<dyn Fn(Vec<AgentActivityEntry>) -> Result<Vec<AgentActivityEntry>, String> + Send + Sync>;

#[derive(Clone)]
struct CodexJournalContext {
    journal: Arc<super::CodexTurnJournal>,
    prepare: CodexReplayPrepare,
}

#[derive(Clone)]
struct DoubaoJournalContext {
    journal: Arc<super::DoubaoTurnJournal>,
    prepare: CodexReplayPrepare,
}

struct OtlpBatch(Arc<OtlpInner>);

impl OtlpBatch {
    fn new(inner: &Arc<OtlpInner>) -> Self {
        inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .batch_depth += 1;
        Self(Arc::clone(inner))
    }
}
impl Drop for OtlpBatch {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .batch_depth -= 1;
    }
}

#[cfg(test)]
type TestConversionClock = Arc<dyn Fn() -> Instant + Send + Sync>;

#[cfg(test)]
type TestCodexPreparation = Arc<
    dyn Fn(
            Vec<AgentActivityEntry>,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), FlushError>> + Send>>
        + Send
        + Sync,
>;

#[cfg(test)]
type TestCodexExport = Arc<
    dyn Fn(
            Vec<AgentActivityEntry>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

struct OtlpInner {
    ordinary_flushes: std::sync::Weak<OrdinaryFlushScope>,
    #[cfg(test)]
    test_codex_preparation: Mutex<Option<TestCodexPreparation>>,
    #[cfg(test)]
    test_codex_startup_replay: Mutex<Option<TestCodexPreparation>>,
    codex_journal: Mutex<Option<CodexJournalContext>>,
    doubao_journal: Mutex<Option<DoubaoJournalContext>>,
    doubao_restore: tokio::sync::OnceCell<()>,
    journal_restore: tokio::sync::OnceCell<()>,
    acceptance: tokio::sync::Mutex<()>,
    codex_flush: tokio::sync::Mutex<()>,
    #[cfg(test)]
    test_codex_export: Mutex<Option<TestCodexExport>>,
    cfg: OtlpTraceFlusherConfig,
    endpoints: Vec<ResolvedEndpoint>,
    state: Mutex<OtlpState>,
    enrichers: SpanEnricherRunner,
    converter: Arc<dyn EventLogConverter>,
    exporter_factory: ExporterFactory,
    global_attributes: Option<Arc<Mutex<GlobalAttributesProvider>>>,
    instance_id: String,
    pilot_version: String,
    debug_dir: PathBuf,
    failed_dir: PathBuf,
    resource_attribute_keys: Vec<String>,
    passthrough_prefixes: Vec<String>,
    #[cfg(test)]
    test_conversion_clock: Mutex<Option<TestConversionClock>>,
    idle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    convert_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl OtlpTraceFlusher {
    pub fn new(cfg: OtlpTraceFlusherConfig) -> Result<Self, String> {
        Self::with_parts(cfg, None, None, None)
    }

    pub fn with_parts(
        cfg: OtlpTraceFlusherConfig,
        global_attributes: Option<Arc<Mutex<GlobalAttributesProvider>>>,
        exporter_factory: Option<ExporterFactory>,
        converter: Option<Arc<dyn EventLogConverter>>,
    ) -> Result<Self, String> {
        Self::with_parts_and_enricher_worker(
            cfg,
            global_attributes,
            exporter_factory,
            converter,
            None,
        )
    }

    /// Explicit worker executable for native embedding/integration tests.
    /// Production constructors use the running Pilot executable.
    pub fn with_parts_and_enricher_worker(
        cfg: OtlpTraceFlusherConfig,
        global_attributes: Option<Arc<Mutex<GlobalAttributesProvider>>>,
        exporter_factory: Option<ExporterFactory>,
        converter: Option<Arc<dyn EventLogConverter>>,
        worker_executable: Option<PathBuf>,
    ) -> Result<Self, String> {
        if cfg.endpoints.is_empty() {
            return Err(
                "[otlp-trace-flusher] config.endpoints must be non-empty when enabled".to_string(),
            );
        }
        if cfg.service_name.is_empty() {
            return Err(
                "[otlp-trace-flusher] config.serviceName is required when enabled".to_string(),
            );
        }
        enable_content_capture();
        let append_default = cfg.append_agent_type_to_service_name != Some(false);
        let endpoints: Vec<ResolvedEndpoint> = cfg
            .endpoints
            .iter()
            .enumerate()
            .map(|(index, endpoint)| {
                let headers = endpoint.headers.clone().unwrap_or_default();
                ResolvedEndpoint {
                    name: if endpoint.name.is_empty() {
                        format!("otlp-{index}")
                    } else {
                        endpoint.name.clone()
                    },
                    url: resolve_endpoint_url(&endpoint.endpoint),
                    compression: if endpoint.compression == Some(OtlpCompression::None) {
                        "none".to_string()
                    } else {
                        "gzip".to_string()
                    },
                    service_name: endpoint
                        .service_name
                        .clone()
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| cfg.service_name.clone()),
                    append_agent_type: append_default,
                    headers,
                }
            })
            .collect();
        let mut endpoint_counters = HashMap::new();
        for endpoint in &endpoints {
            let is_cms = is_cms_endpoint(&endpoint.headers);
            endpoint_counters.insert(
                endpoint.name.clone(),
                OtlpEndpointCounter {
                    is_cms,
                    project: if is_cms {
                        cms_project_of(&endpoint.headers, &endpoint.url)
                    } else {
                        String::new()
                    },
                    logstore: if is_cms {
                        ARMS_TRACE_LOGSTORE.to_string()
                    } else {
                        String::new()
                    },
                    ..OtlpEndpointCounter::default()
                },
            );
        }
        let data_dir = cfg.data_dir.clone().unwrap_or_else(default_data_dir);
        let ordinary_flushes = Arc::new(OrdinaryFlushScope::default());
        let inner = Arc::new(OtlpInner {
            ordinary_flushes: Arc::downgrade(&ordinary_flushes),
            codex_journal: Mutex::new(None),
            doubao_journal: Mutex::new(None),
            doubao_restore: tokio::sync::OnceCell::new(),
            journal_restore: tokio::sync::OnceCell::new(),
            acceptance: tokio::sync::Mutex::new(()),
            codex_flush: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            test_codex_export: Mutex::new(None),
            #[cfg(test)]
            test_codex_preparation: Mutex::new(None),
            #[cfg(test)]
            test_codex_startup_replay: Mutex::new(None),
            enrichers: {
                let runner =
                    SpanEnricherRunner::new(cfg.span_enricher_paths.as_deref().unwrap_or(&[]))?;
                match worker_executable {
                    Some(path) => runner.with_worker_executable(path),
                    None => runner,
                }
            },
            converter: converter
                .unwrap_or_else(|| Arc::new(super::event_log_converter::GenAiEventLogConverter)),
            exporter_factory: exporter_factory.unwrap_or_else(|| {
                Arc::new(|opts| {
                    Arc::new(super::otlp_http_exporter::OtlpHttpExporter::new(opts))
                        as Arc<dyn TraceExporter>
                })
            }),
            global_attributes,
            instance_id: Uuid::new_v4().to_string(),
            pilot_version: read_installed_version(&data_dir),
            debug_dir: PathBuf::from(&data_dir).join("logs").join("otlp-debug"),
            failed_dir: PathBuf::from(&data_dir).join("logs").join("otlp-failed"),
            resource_attribute_keys: cfg
                .resource_attribute_keys
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(|key| key.trim().to_string())
                .filter(|key| !key.is_empty())
                .collect(),
            passthrough_prefixes: cfg
                .span_attribute_passthrough_prefixes
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(|prefix| prefix.trim().to_string())
                .filter(|prefix| !prefix.is_empty())
                .collect(),
            #[cfg(test)]
            test_conversion_clock: Mutex::new(None),
            idle: Mutex::new(None),
            convert_locks: Mutex::new(HashMap::new()),
            endpoints,
            state: Mutex::new(OtlpState {
                buffers: IndexMap::new(),
                flushed: HashSet::new(),
                batch_depth: 0,
                counters: IndexMap::new(),
                endpoint_counters,
                export_states: HashMap::new(),
                convert_states: IndexMap::new(),
                created_exporters: Vec::new(),
            }),
            cfg,
        });
        if let Some(timeout) = inner
            .cfg
            .turn_idle_timeout_ms
            .filter(|timeout| *timeout > 0)
        {
            let idle_inner = Arc::clone(&inner);
            let handle = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(1));
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    idle_inner.tick_idle(timeout).await;
                }
            });
            *inner.idle.lock().unwrap_or_else(|err| err.into_inner()) = Some(handle);
        }
        let names = inner
            .endpoints
            .iter()
            .map(|endpoint| format!("{}({})", endpoint.name, endpoint.url))
            .collect::<Vec<_>>()
            .join(", ");
        create_logger("otlp-trace-flusher")
            .info(&format!("OTLP trace flusher initialized → {names}"), None);
        Ok(Self {
            inner,
            ordinary_flushes,
        })
    }

    pub fn with_codex_journal(
        self,
        journal: Arc<super::CodexTurnJournal>,
        prepare: impl Fn(Vec<AgentActivityEntry>) -> Result<Vec<AgentActivityEntry>, String>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        *self
            .inner
            .codex_journal
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(CodexJournalContext {
            journal,
            prepare: Arc::new(prepare),
        });
        self
    }

    pub fn with_doubao_journal(
        self,
        journal: Arc<super::DoubaoTurnJournal>,
        prepare: impl Fn(Vec<AgentActivityEntry>) -> Result<Vec<AgentActivityEntry>, String>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        *self
            .inner
            .doubao_journal
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(DoubaoJournalContext {
            journal,
            prepare: Arc::new(prepare),
        });
        self
    }

    async fn accept_entries(
        &self,
        entries: Vec<AgentActivityEntry>,
        logical_bytes: Option<Vec<f64>>,
        single: bool,
    ) -> Result<(), FlushError> {
        self.inner.ensure_started().await?;
        let mut batch = Some(OtlpBatch::new(&self.inner));
        let sizes = logical_bytes.filter(|sizes| sizes.len() == entries.len());
        {
            // Keep Doubao's existing ownership gate. Codex preparation must
            // overlap other batches/single sends, with durable append preceding
            // the serialized admission step and batch_depth deferring terminals.
            let has_doubao = entries
                .iter()
                .any(|entry| normalize_agent_type(&entry.agent_type) == "doubao-work");
            let _doubao_acceptance = if has_doubao {
                Some(self.inner.acceptance.lock().await)
            } else {
                None
            };
            self.inner.persist_codex_entries(&entries).await?;
            self.inner.persist_doubao_entries(&entries).await?;
            let _codex_acceptance = if !has_doubao
                && entries
                    .iter()
                    .any(|entry| normalize_agent_type(&entry.agent_type) == "codex")
            {
                Some(self.inner.acceptance.lock().await)
            } else {
                None
            };
            // Main's public single call leaves preparation scope before
            // append: trim existing buffers first, protecting this continuation.
            if single {
                drop(batch.take());
            }
            for (index, entry) in entries.into_iter().enumerate() {
                self.inner
                    .send_entry(entry, sizes.as_ref().map(|sizes| sizes[index]))
                    .await?;
            }
        }
        drop(batch);
        if single {
            self.inner.flush_completed().await
        } else {
            self.inner.finish_batch().await
        }
    }

    pub fn endpoint_counters(&self) -> HashMap<String, OtlpEndpointCounter> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .endpoint_counters
            .clone()
    }

    pub fn created_exporters(&self) -> Vec<ExporterOpts> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .created_exporters
            .clone()
    }

    pub fn endpoint_service_name(&self, index: usize, agent_type: &str) -> String {
        self.inner
            .resolve_endpoint_service_name(&self.inner.endpoints[index], agent_type)
    }

    pub fn resource_attributes(&self, agent_type: &str, service_name: &str) -> Map<String, Value> {
        self.inner.build_resource(
            agent_type,
            service_name,
            &Map::new(),
            agent_type,
            resolve_agent_system(agent_type),
        )
    }

    pub async fn export_spans_for_agent(&self, agent_type: &str, spans: Vec<ReadableSpan>) {
        Arc::clone(&self.inner)
            .export_spans_for_agent(agent_type, spans)
            .await;
    }

    pub async fn tick_idle(&self) {
        let timeout = self.inner.cfg.turn_idle_timeout_ms.unwrap_or(0);
        self.inner.tick_idle(timeout).await;
    }
}

#[async_trait]
impl BaseFlusher for OtlpTraceFlusher {
    fn name(&self) -> &str {
        "otlp-trace"
    }

    fn trace_runtime_snapshot(&self) -> Vec<TraceRuntimeSnapshot> {
        self.inner.snapshot()
    }

    async fn start(&self) -> Result<(), FlushError> {
        self.inner.ensure_started().await
    }

    async fn send(
        &self,
        entry: AgentActivityEntry,
        logical_bytes: Option<f64>,
    ) -> Result<(), FlushError> {
        self.accept_entries(vec![entry], logical_bytes.map(|bytes| vec![bytes]), true)
            .await
    }

    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        logical_bytes: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        self.accept_entries(entries, logical_bytes, false).await
    }

    async fn flush(&self) -> Result<(), FlushError> {
        let journaled = self.inner.codex_context().is_some();
        {
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            for buffer in state.buffers.values_mut() {
                if !buffer.completed
                    && ((journaled && buffer.agent_type == "codex")
                        || (self.inner.doubao_context().is_some()
                            && buffer.agent_type == "doubao-work"))
                {
                    continue;
                }
                buffer.completed = true;
            }
        }
        let completed = self.inner.flush_completed().await;
        self.ordinary_flushes.drain().await;
        completed
    }

    async fn shutdown(&self) -> Result<(), FlushError> {
        if let Some(handle) = self
            .inner
            .idle
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
        {
            handle.abort();
        }
        self.flush().await?;
        let exporters: Vec<Arc<dyn TraceExporter>> = {
            let state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            state
                .export_states
                .values()
                .flat_map(|export| {
                    export
                        .exporters
                        .iter()
                        .map(|(_, exporter)| Arc::clone(exporter))
                })
                .collect()
        };
        for exporter in exporters {
            exporter.shutdown().await;
        }
        self.inner
            .state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .export_states
            .clear();
        self.inner
            .state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .convert_states
            .clear();
        self.inner.enrichers.shutdown().await;
        create_logger("otlp-trace-flusher").info("OTLP trace flusher shut down", None);
        Ok(())
    }
}

impl OtlpInner {
    async fn ensure_started(self: &Arc<Self>) -> Result<(), FlushError> {
        self.ensure_codex_started().await?;
        self.ensure_doubao_started().await
    }

    fn codex_context(&self) -> Option<CodexJournalContext> {
        self.codex_journal
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    async fn ensure_codex_started(self: &Arc<Self>) -> Result<(), FlushError> {
        let Some(context) = self.codex_context() else {
            return Ok(());
        };
        self.journal_restore
            .get_or_try_init(|| async {
                #[cfg(test)]
                {
                    let hook = self.test_codex_startup_replay.lock().unwrap().clone();
                    if let Some(hook) = hook {
                        hook(Vec::new()).await?;
                    }
                }
                let replay = context
                    .journal
                    .load_batches(None)
                    .await
                    .map_err(FlushError::codex_journal)?;
                self.replay_journal(replay).await
            })
            .await
            .map(|_| ())
    }

    async fn replay_journal(
        self: &Arc<Self>,
        mut replay: super::codex_turn_journal::CodexJournalBatchReplay,
    ) -> Result<(), FlushError> {
        let context = self.codex_context().expect("journal replay context");
        while let Some(batch) = replay
            .next_batch()
            .await
            .map_err(FlushError::codex_journal)?
        {
            // Workspace/privacy evidence can occur in the final batch. Prime
            // the complete turn before accepting any of its prefix.
            (context.prepare)(batch.entries).map_err(FlushError::codex_journal)?;
            if !batch.last {
                continue;
            }
            let mut prepared = context
                .journal
                .load_batches(Some(&batch.key))
                .await
                .map_err(FlushError::codex_journal)?;
            let guard = OtlpBatch::new(self);
            let mut accepted = false;
            while let Some(part) = prepared
                .next_batch()
                .await
                .map_err(FlushError::codex_journal)?
            {
                for entry in (context.prepare)(part.entries).map_err(FlushError::codex_journal)? {
                    accepted = true;
                    self.send_entry(entry, None).await?;
                }
            }
            if !accepted {
                context
                    .journal
                    .remove_key(&batch.key)
                    .await
                    .map_err(FlushError::codex_journal)?;
            }
            drop(guard);
            self.finish_batch().await?;
        }
        Ok(())
    }

    async fn rehydrate_codex_turn(&self, buffer: &mut TurnBuffer) -> Result<(), FlushError> {
        if buffer.spilled_records == 0 {
            return Ok(());
        }
        let context = self.codex_context().expect("durable Codex spill context");
        let key = buffer
            .journal_key
            .as_ref()
            .expect("durable Codex spill key");
        let ids = buffer
            .spilled_event_ids
            .as_ref()
            .expect("durable Codex spill ids");
        let mut prime = context
            .journal
            .load_batches(Some(key))
            .await
            .map_err(FlushError::codex_journal)?;
        while let Some(batch) = prime
            .next_batch()
            .await
            .map_err(FlushError::codex_journal)?
        {
            (context.prepare)(batch.entries).map_err(FlushError::codex_journal)?;
        }
        let mut replay = context
            .journal
            .load_batches(Some(key))
            .await
            .map_err(FlushError::codex_journal)?;
        let mut restored = Vec::new();
        while let Some(batch) = replay
            .next_batch()
            .await
            .map_err(FlushError::codex_journal)?
        {
            restored.extend(
                (context.prepare)(batch.entries)
                    .map_err(FlushError::codex_journal)?
                    .into_iter()
                    .filter(|entry| ids.contains(&entry.event_id)),
            );
        }
        // A public batch is persisted before admission. Never pull a future
        // terminal suffix ahead of an unpersistable continuation.
        if restored.is_empty() {
            return Err(FlushError::codex_journal(
                "spilled turn has no accepted journal records; refusing ACK",
            ));
        }
        let bytes = restored
            .iter()
            .try_fold(0usize, |total, entry| {
                serde_json::to_vec(entry).map(|bytes| total.saturating_add(bytes.len()))
            })
            .map_err(FlushError::codex_journal)?;
        buffer.records = restored;
        buffer.resident_bytes = bytes;
        buffer.spilled_records = 0;
        buffer.spilled_event_ids = None;
        Ok(())
    }

    fn spill_codex_payloads(state: &mut OtlpState) {
        let mut candidates: Vec<_> = state
            .buffers
            .iter()
            .filter(|(_, buffer)| {
                buffer.agent_type == "codex" && buffer.spillable && buffer.spilled_records == 0
            })
            .map(|(key, buffer)| (key.clone(), buffer.resident_bytes))
            .collect();
        let mut resident: usize = candidates.iter().map(|(_, bytes)| *bytes).sum();
        candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.1));
        for (key, bytes) in candidates {
            if bytes <= MAX_CODEX_TURN_RESIDENT_BYTES && resident <= MAX_CODEX_RESIDENT_BYTES {
                continue;
            }
            let buffer = state
                .buffers
                .get_mut(&key)
                .expect("resident spill candidate");
            buffer.spilled_records = buffer.records.len();
            buffer.spilled_event_ids = Some(
                buffer
                    .records
                    .iter()
                    .map(|entry| entry.event_id.clone())
                    .collect(),
            );
            buffer.records.clear();
            buffer.records.shrink_to_fit();
            buffer.resident_bytes = 0;
            buffer.record_index.clear();
            resident = resident.saturating_sub(bytes);
        }
    }

    async fn persist_codex_entries(
        self: &Arc<Self>,
        entries: &[AgentActivityEntry],
    ) -> Result<(), FlushError> {
        // The historical tests gate the private preparation boundary before any
        // journal lock; this seam is absent from production builds.
        #[cfg(test)]
        {
            let hook = self.test_codex_preparation.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook(entries.to_vec()).await?;
            }
        }
        let Some(context) = self.codex_context() else {
            return Ok(());
        };
        let codex: Vec<_> = entries
            .iter()
            .filter(|entry| {
                normalize_agent_type(&entry.agent_type) == "codex"
                    && !super::trace_event_compat::is_agent_audit_event(entry)
            })
            .collect();
        let mut checked = HashSet::new();
        for entry in &codex {
            let key = resolve_group_key(entry).2;
            if !checked.insert(key.clone()) {
                continue;
            }
            let resident = {
                let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                state.buffers.contains_key(&key) || state.flushed.contains(&key)
            };
            if resident {
                continue;
            }
            if context
                .journal
                .is_acknowledged(entry)
                .await
                .map_err(FlushError::codex_journal)?
            {
                self.state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .flushed
                    .insert(key);
                continue;
            }
            let group = super::codex_turn_journal_group_key(entry);
            let replay = context
                .journal
                .load_batches(Some(&group))
                .await
                .map_err(FlushError::codex_journal)?;
            self.replay_journal(replay).await?;
        }
        let pending: Vec<_> = {
            let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            codex
                .into_iter()
                .filter(|entry| !state.flushed.contains(&resolve_group_key(entry).2))
                .cloned()
                .collect()
        };
        context
            .journal
            .append(&pending)
            .await
            .map_err(FlushError::codex_journal)
    }

    fn doubao_context(&self) -> Option<DoubaoJournalContext> {
        self.doubao_journal
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    async fn ensure_doubao_started(self: &Arc<Self>) -> Result<(), FlushError> {
        let Some(context) = self.doubao_context() else {
            return Ok(());
        };
        self.doubao_restore
            .get_or_try_init(|| async {
                let replay = context
                    .journal
                    .load(None)
                    .await
                    .map_err(FlushError::doubao_journal)?;
                self.replay_doubao_journal(replay).await
            })
            .await
            .map(|_| ())
    }

    async fn replay_doubao_journal(
        self: &Arc<Self>,
        mut replay: super::DoubaoJournalReplay,
    ) -> Result<(), FlushError> {
        let context = self.doubao_context().expect("journal replay context");
        while let Some(group) = replay
            .next_group()
            .await
            .map_err(FlushError::doubao_journal)?
        {
            let prepared = (context.prepare)(group.clone()).map_err(FlushError::doubao_journal)?;
            if prepared.is_empty() {
                context
                    .journal
                    .remove_entries(&group)
                    .await
                    .map_err(FlushError::doubao_journal)?;
                continue;
            }
            let batch = OtlpBatch::new(self);
            for entry in prepared {
                self.send_entry(entry, None).await?;
            }
            drop(batch);
            self.finish_batch().await?;
        }
        Ok(())
    }

    async fn persist_doubao_entries(
        self: &Arc<Self>,
        entries: &[AgentActivityEntry],
    ) -> Result<(), FlushError> {
        let Some(context) = self.doubao_context() else {
            return Ok(());
        };
        let doubao: Vec<_> = entries
            .iter()
            .filter(|entry| {
                normalize_agent_type(&entry.agent_type) == "doubao-work"
                    && !super::trace_event_compat::is_agent_audit_event(entry)
                    && entry_str(entry, "loongsuite.doubao_work.trace_role").as_deref()
                        != Some("log_only")
            })
            .collect();
        if doubao.iter().any(|entry| {
            entry.event_id.is_empty() || super::doubao_turn_journal::trace_identity(entry).is_none()
        }) {
            return Err(FlushError::doubao_journal(
                "trace fact has no stable native request/execution identity",
            ));
        }
        let mut checked = HashSet::new();
        for entry in &doubao {
            let key = resolve_group_key(entry).2;
            if !checked.insert(key.clone()) {
                continue;
            }
            let resident = {
                let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                state.buffers.contains_key(&key) || state.flushed.contains(&key)
            };
            if resident {
                continue;
            }
            if context
                .journal
                .is_acknowledged(entry)
                .await
                .map_err(FlushError::doubao_journal)?
            {
                self.state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .flushed
                    .insert(key);
                continue;
            }
            let group = super::doubao_turn_journal_group_key(entry);
            let replay = context
                .journal
                .load(Some(&group))
                .await
                .map_err(FlushError::doubao_journal)?;
            self.replay_doubao_journal(replay).await?;
        }
        let pending: Vec<_> = {
            let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            doubao
                .into_iter()
                .filter(|entry| !state.flushed.contains(&resolve_group_key(entry).2))
                .cloned()
                .collect()
        };
        context
            .journal
            .append(&pending)
            .await
            .map_err(FlushError::doubao_journal)
    }

    async fn finish_batch(self: &Arc<Self>) -> Result<(), FlushError> {
        self.flush_completed().await?;
        self.trim_turn_buffers(None).await
    }

    async fn trim_turn_buffers(
        self: &Arc<Self>,
        incoming_key: Option<&str>,
    ) -> Result<(), FlushError> {
        let journaled = self.codex_context().is_some();
        let evicted = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.batch_depth > 0 || state.buffers.len() <= MAX_TURN_BUFFERS {
                return Ok(());
            }
            let overflow = state.buffers.len() - MAX_TURN_BUFFERS;
            let mut candidates: Vec<_> = state
                .buffers
                .iter()
                .filter(|(key, buffer)| !buffer.completed && incoming_key != Some(key.as_str()))
                .map(|(key, buffer)| (key.clone(), buffer.last_activity_ms))
                .collect();
            candidates.sort_by_key(|(_, activity)| *activity);
            candidates
                .into_iter()
                .take(overflow)
                .filter_map(|(key, _)| state.buffers.shift_remove(&key))
                .collect::<Vec<_>>()
        };
        for mut buffer in evicted {
            if (journaled && buffer.agent_type == "codex")
                || (buffer.agent_type == "doubao-work" && self.doubao_context().is_some())
            {
                self.record_removal(&buffer);
            } else {
                buffer.completed = true;
                self.trigger_ordinary_flush(buffer, false).await?;
            }
        }
        Ok(())
    }
    async fn send_entry(
        self: &Arc<Self>,
        entry: AgentActivityEntry,
        logical_bytes: Option<f64>,
    ) -> Result<(), FlushError> {
        if super::trace_event_compat::is_agent_audit_event(&entry)
            || (normalize_agent_type(&entry.agent_type) == "copilot"
                && entry.get("gen_ai.copilot.session_summary") == Some(&Value::Bool(true)))
            || (entry.agent_type == "doubao-work"
                && entry_str(&entry, "loongsuite.doubao_work.trace_role").as_deref()
                    == Some("log_only"))
        {
            return Ok(());
        }
        let (source, value, key) = resolve_group_key(&entry);
        let agent_type = normalize_agent_type(&entry.agent_type);
        if source == KeySource::Ephemeral {
            if is_metadata_only_other(&entry) {
                return Ok(());
            }
            Arc::clone(self)
                .convert_and_export(&agent_type, &[entry])
                .await;
            return Ok(());
        }
        let durable_codex = self.codex_context().is_some()
            && super::codex_turn_journal::is_journaled_codex_entry(&entry);
        let resident_bytes = if agent_type == "codex" && self.codex_context().is_some() {
            serde_json::to_vec(&entry)
                .map_err(FlushError::codex_journal)?
                .len()
        } else {
            0
        };
        let logical_bytes =
            logical_bytes.or_else(|| durable_codex.then_some(resident_bytes as f64));
        if agent_type == "codex" && !durable_codex {
            let displaced = {
                let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
                if state
                    .buffers
                    .get(&key)
                    .is_some_and(|buffer| buffer.spilled_records > 0)
                {
                    state.buffers.shift_remove_full(&key)
                } else {
                    None
                }
            };
            if let Some((index, key, mut buffer)) = displaced {
                let result = {
                    let _serial = self.codex_flush.lock().await;
                    self.rehydrate_codex_turn(&mut buffer).await
                };
                {
                    let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
                    let index = index.min(state.buffers.len());
                    state.buffers.shift_insert(index, key, buffer);
                }
                result?;
            }
        }
        let incoming_session = nonempty(entry_str(&entry, "gen_ai.session.id"));
        let preempted = {
            let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
            if state.flushed.contains(&key) {
                return Ok(());
            }
            let mut preempt = Vec::new();
            for (buf_key, buffer) in &state.buffers {
                if agent_type == "codex" || agent_type == "doubao-work" {
                    break;
                }
                if buffer.agent_type != agent_type || buf_key == &key || buffer.completed {
                    continue;
                }
                if agent_type == "hermes"
                    && buffer.records.iter().any(|record| {
                        entry_str(record, "agent.hermes.collection").as_deref()
                            == Some("realtime-v1")
                    })
                {
                    continue;
                }
                if incoming_session.is_none()
                    || buffer.session_id.is_none()
                    || incoming_session != buffer.session_id
                {
                    continue;
                }
                preempt.push(buf_key.clone());
            }
            let mut buffers = Vec::new();
            for buf_key in preempt {
                if let Some(mut buffer) = state.buffers.shift_remove(&buf_key) {
                    buffer.completed = true;
                    buffers.push(buffer);
                }
            }
            buffers
        };
        for buffer in preempted {
            self.trigger_ordinary_flush(buffer, false).await?;
        }
        self.trim_turn_buffers(Some(&key)).await?;
        let ready = {
            let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
            let now = now_ms();
            let has_counters = state.counters.contains_key(&agent_type)
                || state.counters.len() < MAX_RUNTIME_AGENTS;
            if has_counters && !state.counters.contains_key(&agent_type) {
                state
                    .counters
                    .insert(agent_type.clone(), TraceRuntimeCounters::default());
            }
            {
                let buffer = state
                    .buffers
                    .entry(key.clone())
                    .or_insert_with(|| TurnBuffer {
                        key: key.clone(),
                        key_source: source,
                        key_value: value,
                        agent_type: agent_type.clone(),
                        session_id: incoming_session.clone(),
                        records: Vec::new(),
                        record_index: HashMap::new(),
                        journal_key: durable_codex
                            .then(|| super::codex_turn_journal_group_key(&entry)),
                        spillable: durable_codex,
                        spilled_records: 0,
                        spilled_event_ids: None,
                        resident_bytes: 0,
                        completed: false,
                        last_activity_ms: now,
                        logical_bytes: 0.0,
                        unmeasured_records: 0,
                        opened_at: Instant::now(),
                        has_counters,
                    });
                if buffer.session_id.is_none() {
                    buffer.session_id = incoming_session;
                }
                if !durable_codex && agent_type == "codex" {
                    buffer.spillable = false;
                }
                let duplicate_doubao = agent_type == "doubao-work"
                    && !entry.event_id.is_empty()
                    && buffer.record_index.contains_key(&entry.event_id);
                if matches!(agent_type.as_str(), "copilot" | "doubao-work")
                    && !entry.event_id.is_empty()
                {
                    if let Some(index) = buffer.record_index.get(&entry.event_id).copied() {
                        if agent_type == "doubao-work" {
                            buffer.records[index] = super::doubao_turn_journal::merge_facts(
                                &buffer.records[index],
                                &entry,
                            );
                        } else {
                            let mut existing = entry_to_object(&buffer.records[index]);
                            for (key, value) in entry_to_object(&entry) {
                                if value.is_null() || value.as_str() == Some("") {
                                    continue;
                                }
                                if existing
                                    .get(&key)
                                    .is_none_or(|old| old.is_null() || old.as_str() == Some(""))
                                {
                                    existing.insert(key, value);
                                }
                            }
                            buffer.records[index] = entry_from_map(existing);
                        }
                    } else {
                        buffer
                            .record_index
                            .insert(entry.event_id.clone(), buffer.records.len());
                        buffer.records.push(entry.clone());
                    }
                } else if buffer.spilled_records > 0 && durable_codex {
                    buffer.spilled_records += 1;
                    buffer
                        .spilled_event_ids
                        .as_mut()
                        .expect("spilled event ids")
                        .insert(entry.event_id.clone());
                } else {
                    buffer.records.push(entry.clone());
                }
                if buffer.spilled_records == 0 {
                    buffer.resident_bytes = buffer.resident_bytes.saturating_add(resident_bytes);
                }
                buffer.last_activity_ms = now;
                if !duplicate_doubao {
                    if let Some(bytes) =
                        logical_bytes.filter(|bytes| bytes.is_finite() && *bytes >= 0.0)
                    {
                        buffer.logical_bytes += bytes;
                    } else {
                        buffer.unmeasured_records += 1;
                    }
                }
                if is_terminal_event(&entry) {
                    buffer.completed = true;
                }
            }
            Self::spill_codex_payloads(&mut state);
            let defer = state.batch_depth > 0;
            let should_flush = state
                .buffers
                .get(&key)
                .is_some_and(|buffer| buffer.completed)
                && !defer;
            if should_flush {
                state.buffers.shift_remove(&key)
            } else {
                None
            }
        };
        if let Some(buffer) = ready {
            self.trigger_ordinary_flush(buffer, true).await?;
        }
        Ok(())
    }

    async fn trigger_ordinary_flush(
        self: &Arc<Self>,
        buffer: TurnBuffer,
        mark_flushed: bool,
    ) -> Result<(), FlushError> {
        if matches!(buffer.agent_type.as_str(), "codex" | "doubao-work") {
            return self.finish_buffer(buffer, mark_flushed).await;
        }
        let Some(scope) = self.ordinary_flushes.upgrade() else {
            return self.finish_buffer(buffer, mark_flushed).await;
        };
        let waiting = self
            .start_ordinary_export(&scope, buffer, mark_flushed)
            .await;
        if waiting.is_some() {
            // The pending task is already owned before this scheduling point.
            tokio::task::yield_now().await;
        }
        Ok(())
    }

    async fn start_ordinary_export(
        self: &Arc<Self>,
        scope: &OrdinaryFlushScope,
        buffer: TurnBuffer,
        mark_flushed: bool,
    ) -> Option<tokio::sync::oneshot::Receiver<()>> {
        let buffer = self.prepare_buffer_export(buffer, mark_flushed);
        let inner = Arc::clone(self);
        let mut exporting = Box::pin(async move { inner.export_buffer(buffer).await });
        // JS async functions execute up to their first suspension immediately.
        // Drive that same initial phase before transferring the pending export
        // into the flusher-owned scope; never detach a request from its owner.
        use std::future::Future;
        let first =
            std::future::poll_fn(|cx| std::task::Poll::Ready(exporting.as_mut().poll(cx))).await;
        match first {
            std::task::Poll::Ready(result) => {
                OrdinaryFlushScope::report(Ok(result));
                None
            }
            std::task::Poll::Pending => Some(scope.spawn(exporting)),
        }
    }

    fn prepare_buffer_export(&self, mut buffer: TurnBuffer, mark_flushed: bool) -> TurnBuffer {
        let doubao = buffer.agent_type == "doubao-work";
        if mark_flushed && !doubao {
            self.state
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .flushed
                .insert(buffer.key.clone());
        }
        if !doubao {
            self.record_removal(&buffer);
        }
        if buffer.key_source != KeySource::TurnId {
            for record in &mut buffer.records {
                if entry_str(record, "gen_ai.turn.id").is_none() {
                    set_string(record, "gen_ai.turn.id", &buffer.key_value);
                }
            }
        }
        buffer
    }

    async fn finish_buffer(
        self: &Arc<Self>,
        mut buffer: TurnBuffer,
        mark_flushed: bool,
    ) -> Result<(), FlushError> {
        let _serial = if buffer.agent_type == "codex" && self.codex_context().is_some() {
            Some(self.codex_flush.lock().await)
        } else {
            None
        };
        self.rehydrate_codex_turn(&mut buffer).await?;
        let buffer = self.prepare_buffer_export(buffer, mark_flushed);
        self.export_buffer(buffer).await
    }

    async fn export_buffer(self: &Arc<Self>, buffer: TurnBuffer) -> Result<(), FlushError> {
        let doubao = buffer.agent_type == "doubao-work";
        let exported = self
            .convert_and_export(&buffer.agent_type, &buffer.records)
            .await;
        if doubao {
            if exported {
                if let Some(context) = self.doubao_context() {
                    context
                        .journal
                        .acknowledge(&buffer.records)
                        .await
                        .map_err(FlushError::doubao_journal)?;
                }
                self.state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .flushed
                    .insert(buffer.key.clone());
                self.record_removal(&buffer);
            } else {
                let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                state.flushed.remove(&buffer.key);
                if self.doubao_context().is_some() {
                    drop(state);
                    // The accepted facts remain replayable in the fsync'ed journal.
                    self.record_removal(&buffer);
                } else {
                    state.buffers.insert(buffer.key.clone(), buffer);
                    return Err(FlushError::output_durability("Doubao Work", "OTLP"));
                }
            }
            return Ok(());
        }
        if exported && buffer.completed && buffer.agent_type == "codex" {
            if let Some(context) = self.codex_context() {
                context
                    .journal
                    .acknowledge(&buffer.records)
                    .await
                    .map_err(FlushError::codex_journal)?;
            }
        }
        Ok(())
    }

    fn record_removal(&self, buffer: &TurnBuffer) {
        if !buffer.has_counters {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(counters) = state.counters.get_mut(&buffer.agent_type) {
            counters.removed_buffers_total += 1;
            counters.removed_logical_bytes_total += buffer.logical_bytes;
            counters.removed_unmeasured_records_total += buffer.unmeasured_records;
        }
    }

    async fn flush_completed(self: &Arc<Self>) -> Result<(), FlushError> {
        let completed = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.batch_depth > 0 {
                return Ok(());
            }
            let keys: Vec<_> = state
                .buffers
                .iter()
                .filter(|(_, buffer)| buffer.completed)
                .map(|(key, _)| key.clone())
                .collect();
            let mut completed = Vec::new();
            for key in keys {
                if let Some(buffer) = state.buffers.shift_remove(&key) {
                    if buffer.agent_type != "doubao-work" {
                        state.flushed.insert(key);
                    }
                    completed.push(buffer);
                }
            }
            completed
        };
        let mut failure = None;
        let mut durable = Vec::new();
        let mut waiting = Vec::new();
        let scope = self.ordinary_flushes.upgrade();
        // Transfer ordinary records before the first cancellable wait. These
        // completion signals describe task lifetime only, never transport ACK.
        for buffer in completed {
            if !matches!(buffer.agent_type.as_str(), "codex" | "doubao-work") {
                if let Some(scope) = &scope {
                    if let Some(done) = self.start_ordinary_export(scope, buffer, false).await {
                        waiting.push(done);
                    }
                    continue;
                }
            }
            durable.push(buffer);
        }
        for buffer in durable {
            if let Err(error) = self.finish_buffer(buffer, false).await {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        for done in waiting {
            if done.await.is_err() {
                create_logger("otlp-trace-flusher")
                    .error("ordinary trace worker did not complete", None);
            }
        }
        if let Some(error) = failure {
            Err(error)
        } else {
            Ok(())
        }
    }

    async fn tick_idle(self: &Arc<Self>, timeout: u64) {
        if timeout == 0
            || self
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .batch_depth
                > 0
        {
            return;
        }
        let now = now_ms();
        let stale: Vec<String> = {
            let state = self.state.lock().unwrap_or_else(|err| err.into_inner());
            state
                .buffers
                .iter()
                .filter(|(_, buffer)| {
                    !buffer.completed
                        && now.saturating_sub(buffer.last_activity_ms) > timeout as i64
                })
                .map(|(key, _)| key.clone())
                .collect()
        };
        for key in stale {
            let buffer = {
                let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
                state.buffers.shift_remove(&key)
            };
            if let Some(mut buffer) = buffer {
                if (buffer.agent_type == "codex" && self.codex_context().is_some())
                    || (buffer.agent_type == "doubao-work" && self.doubao_context().is_some())
                {
                    self.record_removal(&buffer);
                    continue;
                }
                buffer.completed = true;
                if let Err(error) = self.trigger_ordinary_flush(buffer, true).await {
                    create_logger("otlp-trace-flusher").warn(&error.to_string(), None);
                }
            }
        }
    }

    async fn convert_and_export(
        self: &Arc<Self>,
        agent_type: &str,
        records: &[AgentActivityEntry],
    ) -> bool {
        if records.is_empty() {
            return true;
        }
        #[cfg(test)]
        if agent_type == "codex" {
            let hook = self.test_codex_export.lock().unwrap().clone();
            if let Some(hook) = hook {
                return hook(records.to_vec()).await;
            }
        }
        let projected = collect_resource_attributes(self, records);
        let (system, framework) = resource_identity(agent_type, records);
        let service_names = unique_service_names(self, agent_type);
        let mut set = tokio::task::JoinSet::new();
        for service_name in service_names {
            let records = records.to_vec();
            let projected = projected.clone();
            let agent_type = agent_type.to_string();
            let system = system.clone();
            let framework = framework.clone();
            let key = convert_state_key(&agent_type, &service_name, &projected);
            let gate = self.convert_lock(&key);
            let inner = Arc::clone(self);
            set.spawn(async move {
                let _guard = gate.lock().await;
                let converter = Arc::clone(&inner.converter);
                inner
                    .do_convert(
                        ConvertScope {
                            agent_type: &agent_type,
                            service_name: &service_name,
                            system: &system,
                            framework: &framework,
                            convert_key: &key,
                        },
                        records,
                        projected,
                        converter.as_ref(),
                    )
                    .await
            });
        }
        let mut exported = true;
        while let Some(result) = set.join_next().await {
            exported &= matches!(result, Ok(true));
        }
        self.evict_convert_states();
        exported
    }

    fn convert_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .convert_locks
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn conversion_instant(&self) -> Instant {
        #[cfg(test)]
        {
            let clock = self
                .test_conversion_clock
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            if let Some(clock) = clock {
                return clock();
            }
        }
        Instant::now()
    }

    async fn do_convert(
        self: &Arc<Self>,
        scope: ConvertScope<'_>,
        records: Vec<AgentActivityEntry>,
        projected: Map<String, Value>,
        converter: &dyn EventLogConverter,
    ) -> bool {
        let ConvertScope {
            agent_type,
            convert_key,
            ..
        } = scope;
        {
            let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
            let entry = state
                .convert_states
                .entry(convert_key.to_string())
                .or_insert(ConvertState { active: 0 });
            entry.active += 1;
        }
        let prepared = prepare_records(self, agent_type, &records);
        let trace_records = super::trace_event_compat::prepare_trace_events(&prepared.records);
        // Doubao validates native pairs itself; retain incomplete/ambiguous facts so
        // transcript tools cannot bypass a rejected native observation.
        let sanitized = if agent_type == "doubao-work" {
            trace_records
        } else {
            drop_orphan_pairs(&trace_records)
        };
        if converter.supports_streaming()
            && agent_type != "doubao-work"
            && !(agent_type == "qwen-code-cli"
                && sanitized.iter().any(|record| {
                    record.get("gen_ai.agent.scope").and_then(Value::as_str) == Some("subagent")
                }))
        {
            let capture = StreamPreparation::default();
            let planned = route_convert(agent_type, &sanitized, &prepared.passthrough, &capture);
            let captured = capture
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            if let (Ok(_), Some((local, options))) = (planned, captured) {
                if super::turn_stream::can_stream(&local) {
                    let exported = self
                        .stream_and_export(
                            &scope, &records, &prepared, &projected, sanitized, local, options,
                        )
                        .await;
                    self.note_convert_done(convert_key);
                    return exported;
                }
            }
        }
        let started = self.conversion_instant();
        let result = route_convert(agent_type, &sanitized, &prepared.passthrough, converter);
        let succeeded = result.is_ok();
        {
            let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
            if let Some(counters) = state.counters.get_mut(agent_type) {
                counters.converter_calls_total += 1;
                counters.converter_duration_ms_total += self
                    .conversion_instant()
                    .saturating_duration_since(started)
                    .as_secs_f64()
                    * 1000.0;
                if !succeeded {
                    counters.converter_failed_total += 1;
                }
            }
        }
        let Ok(result) = result else {
            self.note_convert_done(convert_key);
            return false;
        };
        if !result.warnings.is_empty() {
            create_logger("otlp-trace-flusher").warn(
                &format!("Conversion warnings for {agent_type}"),
                Some(&meta(&[(
                    "warnings",
                    Value::String(result.warnings.join("; ")),
                )])),
            );
        }
        if result.spans.is_empty() {
            self.note_convert_done(convert_key);
            return true;
        }
        let exported = self
            .export_converted_spans(&scope, &records, &prepared, &projected, result.spans, None)
            .await;
        self.note_convert_done(convert_key);
        exported
    }

    async fn export_converted_spans(
        self: &Arc<Self>,
        scope: &ConvertScope<'_>,
        records: &[AgentActivityEntry],
        prepared: &PreparedRecords,
        projected: &Map<String, Value>,
        mut spans: Vec<ReadableSpan>,
        mut stream: Option<&mut StreamEnrichment>,
    ) -> bool {
        if spans.is_empty() {
            return true;
        }
        let ConvertScope {
            agent_type,
            service_name,
            system,
            framework,
            ..
        } = *scope;
        let resource = self.build_resource(agent_type, service_name, projected, framework, system);
        for span in &mut spans {
            span.resource_attributes = Some(resource.clone());
        }
        apply_qoder_work_step_timing(records, &mut spans);
        enrich_tool_skills(records, &mut spans);
        multimodal_span_metadata::enrich(records, &mut spans);
        if agent_type == "openclaw" {
            enrich_openclaw(records, &prepared.identity, &mut spans);
            if let Some(state) = stream.as_deref_mut() {
                for span in &spans {
                    if span
                        .attributes
                        .get("gen_ai.span.kind")
                        .and_then(Value::as_str)
                        == Some("LLM")
                    {
                        if let Some(value) = span
                            .attributes
                            .get("gen_ai.usage.reasoning_tokens")
                            .and_then(Value::as_f64)
                        {
                            state.reasoning_seen = true;
                            state.reasoning_total += value;
                        }
                    }
                }
                if state.reasoning_seen {
                    let total = state.reasoning_total;
                    let value = if total.fract() == 0.0
                        && ((i64::MIN as f64)..-(i64::MIN as f64)).contains(&total)
                    {
                        Value::from(total as i64)
                    } else {
                        Value::from(total)
                    };
                    for span in &mut spans {
                        if span
                            .attributes
                            .get("gen_ai.span.kind")
                            .and_then(Value::as_str)
                            == Some("AGENT")
                        {
                            span.attributes
                                .insert("gen_ai.usage.reasoning_tokens".into(), value.clone());
                        }
                    }
                }
            }
        }
        if agent_type == "claude-code" {
            enrich_claude(records, &mut spans);
        }
        if agent_type == "grok-build" {
            let mut metadata = prepared.grok.clone();
            if stream
                .as_ref()
                .is_some_and(|state| state.grok_instructions_applied)
            {
                metadata.system_instructions.clear();
            }
            enrich_grok(records, &metadata, &mut spans);
            if let Some(state) = stream {
                state.grok_instructions_applied |= spans.iter().any(|span| {
                    span.attributes
                        .get("gen_ai.span.kind")
                        .and_then(Value::as_str)
                        == Some("LLM")
                });
            }
        }
        let spans = self
            .enrichers
            .enrich(
                spans,
                SpanEnricherContext {
                    agent_type: agent_type.to_string(),
                    service_name: service_name.to_string(),
                },
            )
            .await;
        if self.cfg.debug == Some(true) {
            self.write_debug_log(agent_type, &spans).await;
        }
        self.export_in_batches(agent_type, service_name, spans)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn stream_and_export(
        self: &Arc<Self>,
        scope: &ConvertScope<'_>,
        records: &[AgentActivityEntry],
        prepared: &PreparedRecords,
        projected: &Map<String, Value>,
        original: Vec<AgentActivityEntry>,
        local: Vec<AgentActivityEntry>,
        options: ConvertOptions,
    ) -> bool {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        let agent_type = scope.agent_type.to_owned();
        let passthrough = prepared.passthrough.clone();
        let started = self.conversion_instant();
        let converter = Arc::clone(&self.converter);
        let worker = tokio::task::spawn_blocking(move || {
            converter.convert_stream(&local, &options, &mut |spans, final_parents| {
                let converted = ConvertResult {
                    span_count: spans.len(),
                    spans,
                    ..ConvertResult::default()
                };
                let mut result = if agent_type == "codex" {
                    super::codex_turn_converter::map_codex_spans(&original, converted)?
                } else {
                    let converter = StreamResult(Mutex::new(Some(converted)));
                    route_convert(&agent_type, &original, &passthrough, &converter)?
                };
                if !final_parents {
                    result.spans.retain(|span| {
                        matches!(
                            span.attributes
                                .get("gen_ai.span.kind")
                                .and_then(Value::as_str),
                            Some("LLM" | "TOOL")
                        )
                    });
                }
                sender
                    .blocking_send(result.spans)
                    .map_err(|_| "turn stream receiver closed".into())
            })
        });
        let mut exported = true;
        let mut export_duration = Duration::ZERO;
        let limit = self
            .cfg
            .max_export_batch_bytes
            .unwrap_or(DEFAULT_MAX_EXPORT_BATCH_BYTES) as usize;
        let mut pending = Vec::new();
        let mut pending_bytes = 0usize;
        let mut enrichment = StreamEnrichment::default();
        while let Some(spans) = receiver.recv().await {
            for span in spans {
                let size = estimate_span_size(&span);
                if !pending.is_empty() && pending_bytes.saturating_add(size) > limit {
                    let export_started = self.conversion_instant();
                    exported &= self
                        .export_converted_spans(
                            scope,
                            records,
                            prepared,
                            projected,
                            std::mem::take(&mut pending),
                            Some(&mut enrichment),
                        )
                        .await;
                    export_duration += self
                        .conversion_instant()
                        .saturating_duration_since(export_started);
                    pending_bytes = 0;
                }
                pending.push(span);
                pending_bytes = pending_bytes.saturating_add(size);
                if pending_bytes >= limit {
                    let export_started = self.conversion_instant();
                    exported &= self
                        .export_converted_spans(
                            scope,
                            records,
                            prepared,
                            projected,
                            std::mem::take(&mut pending),
                            Some(&mut enrichment),
                        )
                        .await;
                    export_duration += self
                        .conversion_instant()
                        .saturating_duration_since(export_started);
                    pending_bytes = 0;
                }
            }
        }
        let succeeded = matches!(worker.await, Ok(Ok(())));
        if !pending.is_empty() {
            let export_started = self.conversion_instant();
            exported &= self
                .export_converted_spans(
                    scope,
                    records,
                    prepared,
                    projected,
                    pending,
                    Some(&mut enrichment),
                )
                .await;
            export_duration += self
                .conversion_instant()
                .saturating_duration_since(export_started);
        }
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(counters) = state.counters.get_mut(scope.agent_type) {
                counters.converter_calls_total += 1;
                counters.converter_duration_ms_total += self
                    .conversion_instant()
                    .saturating_duration_since(started)
                    .saturating_sub(export_duration)
                    .as_secs_f64()
                    * 1000.0;
                if !succeeded {
                    counters.converter_failed_total += 1;
                }
            }
        }
        exported && succeeded
    }

    fn note_convert_done(&self, key: &str) {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(convert) = state.convert_states.get_mut(key) {
            convert.active = convert.active.saturating_sub(1);
        }
    }

    fn evict_convert_states(&self) {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        while state.convert_states.len() > MAX_CONVERT_STATES {
            let Some(key) = state
                .convert_states
                .iter()
                .find(|(_, convert)| convert.active == 0)
                .map(|(key, _)| key.clone())
            else {
                return;
            };
            state.convert_states.shift_remove(&key);
            self.convert_locks
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .remove(&key);
        }
    }

    async fn export_spans_for_agent(self: &Arc<Self>, agent_type: &str, spans: Vec<ReadableSpan>) {
        if self.cfg.debug == Some(true) {
            self.write_debug_log(agent_type, &spans).await;
        }
        let names = unique_service_names(self, agent_type);
        for service_name in names {
            Arc::clone(self)
                .export_in_batches(agent_type, &service_name, spans.clone())
                .await;
        }
    }

    async fn export_in_batches(
        self: &Arc<Self>,
        agent_type: &str,
        service_name: &str,
        spans: Vec<ReadableSpan>,
    ) -> bool {
        let max_bytes = self
            .cfg
            .max_export_batch_bytes
            .unwrap_or(DEFAULT_MAX_EXPORT_BATCH_BYTES) as usize;
        let mut batches = Vec::new();
        let mut current = Vec::new();
        let mut current_size = 0_usize;
        for span in spans {
            let size = estimate_span_size(&span);
            if !current.is_empty() && current_size + size > max_bytes {
                batches.push(std::mem::take(&mut current));
                current_size = 0;
            }
            current_size += size;
            current.push(span);
        }
        if !current.is_empty() {
            batches.push(current);
        }
        let exporters = self.exporters_for(agent_type, service_name);
        let mut set = tokio::task::JoinSet::new();
        for (name, exporter) in exporters {
            let batches = batches.clone();
            let agent_type = agent_type.to_string();
            let inner = Arc::clone(self);
            set.spawn(async move {
                let mut exported = true;
                for batch in batches {
                    exported &= inner
                        .do_export(exporter.as_ref(), &name, &agent_type, batch)
                        .await;
                }
                exported
            });
        }
        let mut exported = true;
        while let Some(result) = set.join_next().await {
            exported &= matches!(result, Ok(true));
        }
        exported
    }

    async fn do_export(
        &self,
        exporter: &dyn TraceExporter,
        endpoint_name: &str,
        agent_type: &str,
        spans: Vec<ReadableSpan>,
    ) -> bool {
        let batch_bytes: u64 = spans
            .iter()
            .map(|span| estimate_span_size(span) as u64)
            .sum();
        let count = spans.len() as u64;
        {
            let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
            if let Some(counter) = state.endpoint_counters.get_mut(endpoint_name) {
                counter.in_spans += count;
                counter.in_bytes += batch_bytes;
                if counter.start_time.is_empty() {
                    counter.start_time = format_time(Local::now());
                }
            }
        }
        let started = Instant::now();
        let result = exporter.export(spans.clone()).await;
        {
            let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
            if let Some(counter) = state.endpoint_counters.get_mut(endpoint_name) {
                counter.total_delay_ms += started.elapsed().as_millis() as u64;
                match &result {
                    Ok(()) => {
                        counter.out_spans += count;
                        counter.out_bytes += batch_bytes;
                        counter.last_flush_time = format_time(Local::now());
                    }
                    Err(_) => counter.out_failed += count,
                }
            }
        }
        let exported = result.is_ok();
        if let Err(error) = result {
            create_logger("otlp-trace-flusher").warn(
                &format!("Export failed for {agent_type} → {endpoint_name}: {error}"),
                None,
            );
            self.write_failed_log(agent_type, endpoint_name, &spans, &error)
                .await;
        }
        exported
    }

    fn exporters_for(
        &self,
        agent_type: &str,
        service_name: &str,
    ) -> Vec<(String, Arc<dyn TraceExporter>)> {
        let key = format!("{agent_type}|{service_name}");
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(existing) = state.export_states.get(&key) {
            return existing.exporters.clone();
        }
        let mut exporters = Vec::new();
        for endpoint in &self.endpoints {
            if self.resolve_endpoint_service_name(endpoint, agent_type) != service_name {
                continue;
            }
            let opts = ExporterOpts {
                url: endpoint.url.clone(),
                headers: endpoint.headers.clone(),
                compression: endpoint.compression.clone(),
                name: endpoint.name.clone(),
            };
            state.created_exporters.push(opts.clone());
            exporters.push((endpoint.name.clone(), (self.exporter_factory)(opts)));
        }
        state.export_states.insert(
            key,
            ExportState {
                exporters: exporters.clone(),
            },
        );
        exporters
    }

    fn resolve_endpoint_service_name(
        &self,
        endpoint: &ResolvedEndpoint,
        agent_type: &str,
    ) -> String {
        if endpoint.append_agent_type {
            format!("{}-{agent_type}", endpoint.service_name)
        } else {
            endpoint.service_name.clone()
        }
    }

    fn build_resource(
        &self,
        agent_type: &str,
        service_name: &str,
        projected: &Map<String, Value>,
        framework: &str,
        system: &str,
    ) -> Map<String, Value> {
        let mut attributes = Map::new();
        attributes.insert(
            "service.name".to_string(),
            Value::String(service_name.to_string()),
        );
        attributes.insert(
            "service.version".to_string(),
            Value::String(self.pilot_version.clone()),
        );
        attributes.insert(
            "service.instance.id".to_string(),
            Value::String(self.instance_id.clone()),
        );
        attributes.insert(
            "service.namespace".to_string(),
            Value::String("loongsuite-pilot".to_string()),
        );
        attributes.insert("host.name".to_string(), Value::String(host_name()));
        attributes.insert(
            "gen_ai.agent.type".to_string(),
            Value::String(agent_type.to_string()),
        );
        attributes.insert(
            "gen_ai.agent.system".to_string(),
            Value::String(system.to_string()),
        );
        attributes.insert(
            "gen_ai.framework".to_string(),
            Value::String(framework.to_string()),
        );
        if let Some(configured) = &self.cfg.resource_attributes {
            for (key, value) in configured {
                if RESERVED_RESOURCE_KEYS.contains(&key.as_str()) {
                    continue;
                }
                attributes.insert(key.clone(), Value::String(value.clone()));
            }
        }
        for (key, value) in projected {
            if RESERVED_RESOURCE_KEYS.contains(&key.as_str())
                || SENSITIVE_RESOURCE_KEY.is_match(key)
            {
                continue;
            }
            attributes.insert(key.clone(), value.clone());
        }
        attributes
    }

    fn snapshot(&self) -> Vec<TraceRuntimeSnapshot> {
        self.snapshot_at(None)
    }

    fn snapshot_at(&self, now: Option<Instant>) -> Vec<TraceRuntimeSnapshot> {
        let journaled = self.codex_context().is_some();
        let state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        let now = now.unwrap_or_else(Instant::now);
        let mut rows: IndexMap<String, TraceRuntimeSnapshot> = IndexMap::new();
        for (agent_type, counters) in &state.counters {
            rows.insert(
                agent_type.clone(),
                TraceRuntimeSnapshot::from_counters(agent_type, counters),
            );
        }
        if journaled {
            if let Some(row) = rows.get_mut("codex") {
                row.resident_records = Some(0);
                row.resident_payload_bytes = Some(0);
                row.spilled_buffers = Some(0);
                row.spilled_records = Some(0);
            }
        }
        for buffer in state.buffers.values() {
            let Some(row) = rows.get_mut(&buffer.agent_type) else {
                continue;
            };
            let age = now.saturating_duration_since(buffer.opened_at).as_millis() as u64;
            row.pending_buffers += 1;
            let records = (buffer.records.len() + buffer.spilled_records) as u64;
            row.pending_records += records;
            if journaled && buffer.agent_type == "codex" {
                *row.resident_records.as_mut().expect("Codex gauge") += buffer.records.len() as u64;
                *row.resident_payload_bytes.as_mut().expect("Codex gauge") +=
                    buffer.resident_bytes as u64;
                *row.spilled_buffers.as_mut().expect("Codex gauge") +=
                    u64::from(buffer.spilled_records > 0);
                *row.spilled_records.as_mut().expect("Codex gauge") +=
                    buffer.spilled_records as u64;
            }
            row.pending_logical_bytes += buffer.logical_bytes;
            row.pending_unmeasured_records += buffer.unmeasured_records;
            row.oldest_buffer_age_ms = row.oldest_buffer_age_ms.max(age);
            if row.pending_buffers == 1 || buffer.logical_bytes > row.largest_buffer_logical_bytes {
                row.largest_buffer_logical_bytes = buffer.logical_bytes;
                row.largest_buffer_records = records;
                row.largest_buffer_age_ms = age;
                row.largest_buffer_turn_id = if buffer.key_source == KeySource::TurnId {
                    Some(buffer.key_value.clone())
                } else {
                    None
                };
                row.largest_buffer_session_id = buffer.session_id.clone();
            }
        }
        rows.into_values().collect()
    }

    async fn write_debug_log(&self, agent_type: &str, spans: &[ReadableSpan]) {
        let dir = self.debug_dir.to_string_lossy().to_string();
        ensure_dir(&dir).await;
        let path = self.debug_dir.join(format!(
            "{}-{agent_type}-{}.jsonl",
            self.cfg.service_name,
            get_today_date_string()
        ));
        for line in create_readable_span_to_otlp_span_json_array(spans) {
            if append_segmented_jsonl(&path, &line, DEFAULT_JSONL_SEGMENT_BYTES, false)
                .await
                .is_err()
            {
                create_logger("otlp-trace-flusher")
                    .warn("OTLP debug mirror could not be persisted", None);
            }
        }
    }

    async fn write_failed_log(
        &self,
        agent_type: &str,
        endpoint_name: &str,
        spans: &[ReadableSpan],
        message: &str,
    ) {
        self.write_failed_log_at(agent_type, endpoint_name, spans, 1, message, None)
            .await;
    }

    async fn write_failed_log_at(
        &self,
        agent_type: &str,
        endpoint_name: &str,
        spans: &[ReadableSpan],
        error_code: i64,
        message: &str,
        local_time: Option<chrono::DateTime<Local>>,
    ) {
        let safe: String = endpoint_name
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        let dir = self.failed_dir.to_string_lossy().to_string();
        ensure_dir(&dir).await;
        let local_time = local_time.unwrap_or_else(Local::now);
        let path = self.failed_dir.join(format!(
            "{}-{agent_type}__{safe}-{}.jsonl",
            self.cfg.service_name,
            local_time.format("%Y-%m-%d")
        ));
        for line in create_readable_span_to_otlp_span_json_array(spans) {
            let mut obj: Value = serde_json::from_str(&line).unwrap_or(Value::Object(Map::new()));
            if let Value::Object(map) = &mut obj {
                map.insert(
                    "_error".to_string(),
                    serde_json::json!({"code": error_code, "message": message}),
                );
            }
            if let Ok(text) = serde_json::to_string(&obj) {
                if append_segmented_jsonl(&path, &text, DEFAULT_JSONL_SEGMENT_BYTES, true)
                    .await
                    .is_err()
                {
                    create_logger("otlp-trace-flusher")
                        .warn("OTLP failed evidence could not be persisted", None);
                }
            }
        }
    }
}

struct PreparedRecords {
    records: Vec<AgentActivityEntry>,
    passthrough: Vec<String>,
    identity: Map<String, Value>,
    grok: GrokMeta,
}

#[derive(Clone, Debug, Default)]
struct GrokMeta {
    system_instructions: Vec<Value>,
    agent_description: Option<String>,
    data_source_id: Option<String>,
}

fn prepare_records(
    inner: &OtlpInner,
    agent_type: &str,
    records: &[AgentActivityEntry],
) -> PreparedRecords {
    let mut custom = Map::new();
    if let Some(provider) = &inner.global_attributes {
        let resolved = provider
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .resolve();
        for key in resolved.keys() {
            if let Some(value) = resolved.get(&key) {
                custom.insert(key, Value::String(value.to_string()));
            }
        }
    }
    let mut prefix_keys = Vec::new();
    for record in records {
        for key in entry_to_object(record).keys() {
            if is_reserved_key(key) {
                continue;
            }
            if inner
                .passthrough_prefixes
                .iter()
                .any(|prefix| key.starts_with(prefix))
                && !prefix_keys.contains(key)
            {
                prefix_keys.push(key.clone());
            }
        }
    }
    let mut passthrough = Vec::new();
    for key in DEFAULT_GIT_PASSTHROUGH_KEYS
        .iter()
        .chain(USER_IDENTITY_KEYS)
        .chain(HIERARCHY_KEYS)
    {
        passthrough.push((*key).to_string());
    }
    if agent_type == "grok-build" {
        passthrough.extend(GROK_PASSTHROUGH.iter().map(|key| (*key).to_string()));
    }
    if agent_type == "copilot" {
        passthrough.push("gen_ai.copilot.telemetry.source".into());
    }
    if super::qoder_turn_converter::is_qoder_transcript_agent(agent_type) {
        passthrough.push("agent.transcript_incomplete".into());
    }
    if agent_type == "openclaw" {
        passthrough.extend(OPENCLAW_COMPAT_KEYS.iter().map(|key| (*key).to_string()));
    }
    for key in custom.keys() {
        if !passthrough.contains(key) {
            passthrough.push(key.clone());
        }
    }
    passthrough.extend(prefix_keys);
    let mut copied: Vec<AgentActivityEntry> = records.to_vec();
    if !custom.is_empty() {
        for record in &mut copied {
            let mut map = entry_to_object(record);
            for (key, value) in &custom {
                if !map.contains_key(key) {
                    map.insert(key.clone(), value.clone());
                }
            }
            *record = entry_from_map(map);
        }
    }
    let mut identity = Map::new();
    if agent_type == "openclaw" {
        copied = prepare_openclaw_collection(&copied);
        let prepared = prepare_openclaw_identity(&copied);
        copied = prepared.0;
        identity = prepared.1;
    }
    let mut grok = GrokMeta::default();
    if agent_type == "grok-build" {
        let prepared = prepare_grok(&copied);
        copied = prepared.0;
        grok = prepared.1;
    }
    PreparedRecords {
        records: copied,
        passthrough,
        identity,
        grok,
    }
}

#[derive(Default)]
struct StreamPreparation(Mutex<Option<(Vec<AgentActivityEntry>, ConvertOptions)>>);
impl EventLogConverter for StreamPreparation {
    fn convert(
        &self,
        records: &[AgentActivityEntry],
        options: &ConvertOptions,
    ) -> Result<ConvertResult, String> {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) =
            Some((records.to_vec(), options.clone()));
        Ok(ConvertResult::default())
    }
}

struct StreamResult(Mutex<Option<ConvertResult>>);
impl EventLogConverter for StreamResult {
    fn convert(
        &self,
        _: &[AgentActivityEntry],
        _: &ConvertOptions,
    ) -> Result<ConvertResult, String> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
            .ok_or_else(|| "stream adapter consumed twice".into())
    }
}

fn route_convert(
    agent_type: &str,
    records: &[AgentActivityEntry],
    passthrough: &[String],
    converter: &dyn EventLogConverter,
) -> Result<ConvertResult, String> {
    let options = ConvertOptions {
        strict: false,
        passthrough_keys: passthrough.to_vec(),
    };
    if agent_type == "codex" {
        super::convert_codex_turn(records, &options, converter)
    } else if super::qoder_turn_converter::is_qoder_transcript_agent(agent_type) {
        super::convert_qoder_turn(records, &options, converter)
    } else if agent_type == "doubao-work" {
        super::convert_doubao_work_turn(records, &options, converter)
    } else if agent_type == "qwen-code-cli" {
        convert_qwen_subagents(records, &options, converter)
    } else if agent_type == "hermes" || agent_type == "openclaw" {
        convert_delegated_turn(records, &options, converter)
    } else if agent_type == "copilot" {
        let mut result = converter.convert(records, &options)?;
        if let Some(error) = records
            .iter()
            .find_map(|record| record.get("gen_ai.copilot.interaction.error"))
        {
            for span in &mut result.spans {
                if span
                    .attributes
                    .get("gen_ai.operation.name")
                    .and_then(Value::as_str)
                    == Some("invoke_agent")
                {
                    span.status.insert("code".into(), Value::from(2));
                    span.attributes.insert("error.type".into(), error.clone());
                }
            }
        }
        Ok(result)
    } else {
        converter.convert(records, &options)
    }
}

fn unique_service_names(inner: &OtlpInner, agent_type: &str) -> Vec<String> {
    let mut names = Vec::new();
    for endpoint in &inner.endpoints {
        let name = inner.resolve_endpoint_service_name(endpoint, agent_type);
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

fn convert_state_key(
    agent_type: &str,
    service_name: &str,
    projected: &Map<String, Value>,
) -> String {
    let mut keys: Vec<&String> = projected.keys().collect();
    keys.sort();
    let mut stable = Map::new();
    for key in keys {
        if let Some(value) = projected.get(key) {
            stable.insert(key.clone(), value.clone());
        }
    }
    format!(
        "{agent_type}|{service_name}|{}",
        serde_json::to_string(&Value::Object(stable)).unwrap_or_else(|_| "{}".to_string())
    )
}

fn resolve_group_key(entry: &AgentActivityEntry) -> (KeySource, String, String) {
    if entry.agent_type == "doubao-work" {
        if entry_str(entry, "loongsuite.doubao_work.observation_scope").as_deref()
            == Some("native_sandbox_execution")
        {
            if let Some(id) =
                entry_str(entry, "loongsuite.doubao_work.native_execution_id").filter(|id| {
                    !id.is_empty()
                        && id.len() <= 128
                        && id
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                })
            {
                return (
                    KeySource::TurnId,
                    id.clone(),
                    format!("doubao-local-execution:{id}"),
                );
            }
        }
        if let Some(trace) = entry_str(entry, "trace_id").filter(|id| TRACE_ID_RE.is_match(id)) {
            return (
                KeySource::TraceId,
                trace.clone(),
                format!("doubao-request:{trace}"),
            );
        }
    }
    if let Some(turn_id) = entry_str(entry, "gen_ai.turn.id") {
        if normalize_agent_type(&entry.agent_type) == "codex" {
            let parts = [
                entry.user_id.as_str(),
                entry.session_id.as_str(),
                turn_id.as_str(),
            ];
            let key = parts
                .into_iter()
                .map(|part| format!("{}:{part}", part.encode_utf16().count()))
                .collect::<String>();
            return (KeySource::TurnId, turn_id, format!("codex:{key}"));
        }
        return (
            KeySource::TurnId,
            turn_id.clone(),
            format!("turn:{turn_id}"),
        );
    }
    if let Some(trace_id) = entry_str(entry, "trace_id") {
        if TRACE_ID_RE.is_match(&trace_id) {
            return (
                KeySource::TraceId,
                trace_id.clone(),
                format!("trace:{trace_id}"),
            );
        }
    }
    if let Some(session_id) = entry_str(entry, "gen_ai.session.id") {
        return (
            KeySource::SessionId,
            session_id.clone(),
            format!("session:{session_id}"),
        );
    }
    let ephemeral = entry_str(entry, "event.id").unwrap_or_else(|| Uuid::new_v4().to_string());
    (
        KeySource::Ephemeral,
        ephemeral.clone(),
        format!("ephemeral:{ephemeral}"),
    )
}

fn is_terminal_event(entry: &AgentActivityEntry) -> bool {
    let agent_type = normalize_agent_type(&entry.agent_type);
    if agent_type == "doubao-work" {
        return entry_str(entry, "event.name").as_deref() == Some("other")
            && if entry_str(entry, "loongsuite.doubao_work.observation_scope").as_deref()
                == Some("native_sandbox_execution")
            {
                entry_str(entry, "loongsuite.doubao_work.local_execution_phase").as_deref()
                    == Some("end")
            } else {
                entry_bool(entry, "gen_ai.turn.end") == Some(true)
            };
    }
    if agent_type == "copilot"
        && entry_str(entry, "gen_ai.copilot.source").as_deref() == Some("hybrid-v2")
    {
        return entry_bool(entry, "gen_ai.turn.end") == Some(true);
    }
    if agent_type == "opencode"
        && entry_str(entry, "agent.opencode.collection").as_deref() == Some("v2")
    {
        return entry_bool(entry, "gen_ai.turn.end") == Some(true);
    }
    if agent_type == "hermes"
        && entry_str(entry, "agent.hermes.collection").as_deref() == Some("realtime-v1")
    {
        return entry_bool(entry, "gen_ai.turn.end") == Some(true);
    }
    if agent_type == "qwen-code-cli"
        && entry_str(entry, "agent.qwen-code-cli.collection").as_deref() == Some("foreground-v1")
    {
        return entry_str(entry, "gen_ai.agent.scope").as_deref() != Some("subagent")
            && entry_bool(entry, "gen_ai.turn.end") == Some(true);
    }
    if agent_type == "codex" {
        let status = entry_str(entry, "agent.codex.turn_status");
        if status.as_deref() != Some("completed") && status.as_deref() != Some("interrupted") {
            return false;
        }
        return entry_bool(entry, "gen_ai.turn.end") == Some(true);
    }
    if agent_type == "openclaw" {
        return entry_str(entry, "agent.openclaw.hook").as_deref() == Some("llm_output")
            || (entry_str(entry, "agent.openclaw.compatibility").as_deref() == Some("legacy")
                && matches!(
                    entry_str(entry, "agent.openclaw.hook").as_deref(),
                    Some("agent_end") | Some("legacy_cleanup")
                )
                && entry_bool(entry, "gen_ai.turn.end") == Some(true));
    }
    if agent_type == "grok-build" {
        return entry_str(entry, "event.name").as_deref() == Some("other")
            && (has_finish(entry, TERMINAL_FINISH) || has_finish(entry, GROK_TERMINAL_FINISH));
    }
    if agent_type == "claude-code" {
        return entry_bool(entry, "gen_ai.turn.end") == Some(true)
            || has_finish(entry, CLAUDE_TERMINAL_FINISH);
    }
    has_finish(entry, TERMINAL_FINISH)
}

fn has_finish(entry: &AgentActivityEntry, expected: &[&str]) -> bool {
    entry
        .finish_reasons
        .as_ref()
        .map(|reasons| {
            reasons
                .iter()
                .any(|reason| expected.contains(&reason.as_str()))
        })
        .unwrap_or(false)
}

fn is_metadata_only_other(entry: &AgentActivityEntry) -> bool {
    if entry_str(entry, "event.name").as_deref() != Some("other") {
        return false;
    }
    entry.input_messages.is_none() && entry.input_messages_delta.is_none()
}

fn drop_orphan_pairs(records: &[AgentActivityEntry]) -> Vec<AgentActivityEntry> {
    let mut steps_with_response = HashSet::new();
    let mut completed_tools = HashSet::new();
    for record in records {
        if entry_str(record, "event.name").as_deref() == Some("llm.response") {
            steps_with_response.insert(
                entry_str(record, "gen_ai.step.id").unwrap_or_else(|| "__no_step__".to_string()),
            );
        }
        if entry_str(record, "event.name").as_deref() == Some("tool.result") {
            if let Some(call_id) = entry_str(record, "gen_ai.tool.call.id") {
                completed_tools.insert(call_id);
            }
        }
    }
    records
        .iter()
        .filter(|record| match entry_str(record, "event.name").as_deref() {
            Some("llm.request") => steps_with_response.contains(
                &entry_str(record, "gen_ai.step.id").unwrap_or_else(|| "__no_step__".to_string()),
            ),
            Some("tool.call") => match entry_str(record, "gen_ai.tool.call.id") {
                Some(call_id) => completed_tools.contains(&call_id),
                None => true,
            },
            _ => true,
        })
        .cloned()
        .collect()
}

pub fn apply_qoder_work_step_timing(records: &[AgentActivityEntry], spans: &mut [ReadableSpan]) {
    let mut boundaries: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for record in records {
        let Some(session_id) = entry_str(record, "gen_ai.session.id") else {
            continue;
        };
        let Some(step_id) = entry_str(record, "gen_ai.step.id") else {
            continue;
        };
        let start = entry_str(record, "agent.qoderwork.step.start_time_unix_nano");
        let end = entry_str(record, "agent.qoderwork.step.end_time_unix_nano");
        if start.is_none() && end.is_none() {
            continue;
        }
        let Some(round) = step_round(&step_id) else {
            continue;
        };
        boundaries.insert(format!("{session_id}\0{round}"), (start, end));
    }
    if boundaries.is_empty() {
        return;
    }
    for span in spans {
        if span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(|value| value.as_str())
            != Some("STEP")
        {
            continue;
        }
        let Some(session_id) = span
            .attributes
            .get("gen_ai.session.id")
            .and_then(|value| value.as_str())
        else {
            continue;
        };
        let Some(round) = span
            .attributes
            .get("gen_ai.react.round")
            .and_then(|value| value.as_i64())
        else {
            continue;
        };
        let Some((start, end)) = boundaries.get(&format!("{session_id}\0{round}")) else {
            continue;
        };
        let current_start = hr_time_to_nano(span.start_time)
            .parse::<i128>()
            .unwrap_or(0);
        let current_duration = hr_time_to_nano(span.duration).parse::<i128>().unwrap_or(0);
        let current_end = current_start + current_duration;
        let desired_start = start
            .as_deref()
            .and_then(|value| value.parse().ok())
            .unwrap_or(current_start);
        let desired_end = end
            .as_deref()
            .and_then(|value| value.parse().ok())
            .unwrap_or(current_end);
        if desired_end < desired_start {
            continue;
        }
        span.start_time = nano_to_hr_time(desired_start);
        span.end_time = nano_to_hr_time(desired_end);
        span.duration = nano_to_hr_time(desired_end - desired_start);
    }
}

fn step_round(step_id: &str) -> Option<i64> {
    STEP_ROUND_RE
        .captures(step_id)
        .and_then(|caps| caps.get(1))
        .and_then(|value| value.as_str().parse().ok())
}

fn enrich_tool_skills(records: &[AgentActivityEntry], spans: &mut [ReadableSpan]) {
    let mut by_call: HashMap<String, Map<String, Value>> = HashMap::new();
    for record in records {
        let name = entry_str(record, "event.name");
        if name.as_deref() != Some("tool.call") && name.as_deref() != Some("tool.result") {
            continue;
        }
        let Some(call_id) = entry_str(record, "gen_ai.tool.call.id") else {
            continue;
        };
        let slot = by_call.entry(call_id).or_default();
        for key in SKILL_KEYS {
            if let Some(value) = entry_str(record, key) {
                slot.insert((*key).to_string(), Value::String(value));
            }
        }
    }
    for span in spans {
        if span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(|v| v.as_str())
            != Some("TOOL")
        {
            continue;
        }
        let Some(call_id) = span
            .attributes
            .get("gen_ai.tool.call.id")
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        if let Some(attributes) = by_call.get(call_id) {
            for (key, value) in attributes {
                span.attributes.insert(key.clone(), value.clone());
            }
        }
    }
}

#[derive(Default)]
struct OpenClawLlmExtension {
    reasoning: Option<Value>,
    error_type: Option<String>,
}

fn enrich_openclaw_llm_attributes(records: &[AgentActivityEntry], spans: &mut [ReadableSpan]) {
    let mut by_response = HashMap::new();
    for record in records {
        if record.event_name != Some(crate::types::AgentEventName::LlmResponse) {
            continue;
        }
        let Some(response_id) = record
            .response_id
            .as_deref()
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let reasoning = record
            .get("gen_ai.usage.reasoning_tokens")
            .filter(|value| value.as_f64().is_some_and(f64::is_finite))
            .cloned();
        by_response.insert(
            response_id,
            OpenClawLlmExtension {
                reasoning,
                error_type: record.error_type.clone().filter(|value| !value.is_empty()),
            },
        );
    }
    let mut total = 0_f64;
    let mut saw_reasoning = false;
    for span in spans.iter_mut() {
        if span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            != Some("LLM")
        {
            continue;
        }
        let Some(extension) = span
            .attributes
            .get("gen_ai.response.id")
            .and_then(Value::as_str)
            .and_then(|id| by_response.get(id))
        else {
            continue;
        };
        if let Some(reasoning) = &extension.reasoning {
            span.attributes
                .insert("gen_ai.usage.reasoning_tokens".into(), reasoning.clone());
            total += reasoning.as_f64().expect("finite reasoning was validated");
            saw_reasoning = true;
        }
        if let Some(error_type) = &extension.error_type {
            span.attributes
                .insert("error.type".into(), Value::String(error_type.clone()));
            span.status.insert("code".into(), Value::from(2));
            span.status.insert(
                "message".into(),
                Value::String("OpenClaw model call failed".into()),
            );
        }
    }
    if !saw_reasoning {
        return;
    }
    // The JS SDK encodes every Number.isInteger count as OTLP intValue.
    // Preserve that wire kind for integral values representable by OTLP int64.
    let total = if total.fract() == 0.0 && ((i64::MIN as f64)..-(i64::MIN as f64)).contains(&total)
    {
        Value::from(total as i64)
    } else if let Some(total) = serde_json::Number::from_f64(total) {
        Value::Number(total)
    } else {
        return;
    };
    for span in spans {
        if span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            == Some("AGENT")
        {
            span.attributes
                .insert("gen_ai.usage.reasoning_tokens".into(), total.clone());
        }
    }
}

#[derive(Default)]
struct OpenClawToolExtension {
    result_status: Option<String>,
    error_type: Option<String>,
    error_message: Option<String>,
}

fn enrich_openclaw_tool_attributes(records: &[AgentActivityEntry], spans: &mut [ReadableSpan]) {
    let mut by_call = HashMap::new();
    for record in records {
        if record.event_name != Some(crate::types::AgentEventName::ToolResult) {
            continue;
        }
        let Some(call_id) = record
            .tool_call_id
            .as_deref()
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        by_call.insert(
            call_id,
            OpenClawToolExtension {
                result_status: record
                    .tool_result_status
                    .clone()
                    .filter(|value| !value.is_empty()),
                error_type: record.error_type.clone().filter(|value| !value.is_empty()),
                error_message: record
                    .error_message
                    .clone()
                    .filter(|value| !value.is_empty()),
            },
        );
    }
    for span in spans {
        if span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            != Some("TOOL")
        {
            continue;
        }
        let Some(extension) = span
            .attributes
            .get("gen_ai.tool.call.id")
            .and_then(Value::as_str)
            .and_then(|id| by_call.get(id))
        else {
            continue;
        };
        for (key, value) in [
            ("tool.result.status", &extension.result_status),
            ("error.type", &extension.error_type),
            ("error.message", &extension.error_message),
        ] {
            if let Some(value) = value {
                span.attributes
                    .insert(key.into(), Value::String(value.clone()));
            }
        }
        let failed = extension.error_type.is_some()
            || extension.result_status.as_deref().is_some_and(|status| {
                status.eq_ignore_ascii_case("failure") || status.eq_ignore_ascii_case("error")
            });
        if failed {
            span.status.insert("code".into(), Value::from(2));
            span.status.insert(
                "message".into(),
                Value::String(
                    extension
                        .error_message
                        .clone()
                        .unwrap_or_else(|| "OpenClaw tool call failed".into()),
                ),
            );
        }
    }
}

fn enrich_openclaw(
    records: &[AgentActivityEntry],
    identity: &Map<String, Value>,
    spans: &mut [ReadableSpan],
) {
    enrich_openclaw_llm_attributes(records, spans);
    enrich_openclaw_tool_attributes(records, spans);
    for span in spans.iter_mut() {
        for (key, value) in identity {
            span.attributes.insert(key.clone(), value.clone());
        }
    }
    let mut keys = HashSet::new();
    let mut scopes = HashSet::new();
    let mut valid = true;
    for record in records {
        if entry_str(record, "gen_ai.agent.type").as_deref() != Some("openclaw")
            || entry_bool(record, OPENCLAW_SESSION_KEY_AMBIGUOUS) == Some(true)
        {
            valid = false;
            break;
        }
        scopes.insert(format!(
            "{:?}|{:?}|{:?}|{:?}|{:?}|{:?}",
            record.trace_id,
            entry_str(record, "gen_ai.session.id"),
            entry_str(record, "gen_ai.turn.id"),
            record.agent_id,
            record.agent_name,
            entry_str(record, "gen_ai.agent.scope")
        ));
        if let Some(value) = record.get(OPENCLAW_SESSION_KEY) {
            if !is_openclaw_session_key(value) {
                valid = false;
                break;
            }
            if let Some(text) = value.as_str() {
                keys.insert(text.to_string());
            }
        }
    }
    if valid && scopes.len() == 1 && keys.len() == 1 {
        let session_key = keys.into_iter().next().unwrap_or_default();
        let trace_id = records.first().and_then(|record| record.trace_id.clone());
        for span in spans.iter_mut() {
            let kind = span
                .attributes
                .get("gen_ai.span.kind")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if Some(span.trace_id.as_str()) == trace_id.as_deref() && SPAN_KINDS.contains(&kind) {
                span.attributes.insert(
                    OPENCLAW_SESSION_KEY.to_string(),
                    Value::String(session_key.clone()),
                );
            }
        }
    }
}

#[derive(Default)]
struct ClaudeResponseMetadata {
    error: Option<String>,
    status: Option<i64>,
    request: Option<String>,
}

fn enrich_claude(records: &[AgentActivityEntry], spans: &mut [ReadableSpan]) {
    let mut by_response: HashMap<String, ClaudeResponseMetadata> = HashMap::new();
    for record in records {
        let name = entry_str(record, "event.name");
        if name.as_deref() != Some("llm.request") && name.as_deref() != Some("llm.response") {
            continue;
        }
        let Some(response_id) = entry_str(record, "gen_ai.response.id") else {
            continue;
        };
        let slot = by_response.entry(response_id).or_default();
        if let Some(error) = entry_str(record, "error.type") {
            slot.error = Some(error);
        }
        if let Some(status) = record.http_response_status_code {
            slot.status = Some(status);
        }
        if let Some(request_id) = record.request_id.clone() {
            slot.request = Some(request_id);
        }
    }
    for span in spans {
        if span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(|v| v.as_str())
            != Some("LLM")
        {
            continue;
        }
        let Some(response_id) = span
            .attributes
            .get("gen_ai.response.id")
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        let Some(ClaudeResponseMetadata {
            error,
            status,
            request,
        }) = by_response.get(response_id)
        else {
            continue;
        };
        if let Some(request) = request {
            span.attributes.insert(
                "gen_ai.request.id".to_string(),
                Value::String(request.clone()),
            );
        }
        if let Some(status) = status {
            span.attributes.insert(
                "http.response.status_code".to_string(),
                Value::from(*status),
            );
        }
        if let Some(error) = error {
            span.attributes
                .insert("error.type".to_string(), Value::String(error.clone()));
            span.status.insert("code".to_string(), Value::from(2));
            span.status.insert(
                "message".to_string(),
                Value::String("model request failed".to_string()),
            );
        }
    }
}

#[derive(Default)]
struct GrokToolExtension {
    duration: Option<Value>,
    status: Option<String>,
    error_type: Option<String>,
    match_strategy: Option<String>,
    timing_source: Option<String>,
}

#[derive(Default)]
struct GrokLlmExtension {
    error_type: Option<String>,
    timing_source: Option<String>,
}

fn enrich_grok(records: &[AgentActivityEntry], meta: &GrokMeta, spans: &mut [ReadableSpan]) {
    use crate::types::AgentEventName;
    let mut tools: HashMap<String, GrokToolExtension> = HashMap::new();
    let mut llms: HashMap<String, GrokLlmExtension> = HashMap::new();
    let mut terminal: Option<(String, Option<String>)> = None;
    for record in records {
        if matches!(
            record.event_name,
            Some(AgentEventName::ToolCall | AgentEventName::ToolResult)
        ) {
            if let Some(call_id) = record.tool_call_id.as_ref().filter(|id| !id.is_empty()) {
                let tool = tools.entry(call_id.clone()).or_default();
                if let Some(duration) = record
                    .tool_call_duration
                    .filter(|value| value.is_finite() && *value > 0.0)
                {
                    // Original JS SDK: integral millisecond durations use OTLP intValue.
                    tool.duration = Some(
                        if duration.fract() == 0.0
                            && ((i64::MIN as f64)..-(i64::MIN as f64)).contains(&duration)
                        {
                            Value::from(duration as i64)
                        } else {
                            Value::Number(
                                serde_json::Number::from_f64(duration)
                                    .expect("finite positive duration"),
                            )
                        },
                    );
                }
                if let Some(status) = record
                    .tool_result_status
                    .as_ref()
                    .filter(|value| !value.is_empty())
                {
                    tool.status = Some(status.clone());
                }
                if let Some(error) = record.error_type.as_ref().filter(|value| !value.is_empty()) {
                    tool.error_type = Some(error.clone());
                }
                if let Some(strategy) = record.grok_match_strategy.as_ref() {
                    tool.match_strategy = Some(strategy.as_str().to_string());
                }
                if let Some(source) = record.grok_timing_source.as_ref() {
                    tool.timing_source = Some(source.as_str().to_string());
                }
            }
        }
        if matches!(
            record.event_name,
            Some(AgentEventName::LlmRequest | AgentEventName::LlmResponse)
        ) {
            if let Some(response_id) = record.response_id.as_ref().filter(|id| !id.is_empty()) {
                let llm = llms.entry(response_id.clone()).or_default();
                if let Some(error) = record.error_type.as_ref().filter(|value| !value.is_empty()) {
                    llm.error_type = Some(error.clone());
                }
                if let Some(source) = record.grok_timing_source.as_ref() {
                    llm.timing_source = Some(source.as_str().to_string());
                }
            }
        }
        if record.event_name == Some(AgentEventName::Other) {
            if let Some(reason) = record.finish_reasons.as_ref().and_then(|reasons| {
                reasons
                    .iter()
                    .find(|reason| matches!(reason.as_str(), "error" | "cancelled"))
            }) {
                terminal = Some((
                    reason.clone(),
                    record.error_type.clone().filter(|value| !value.is_empty()),
                ));
            }
        }
    }
    for span in spans.iter_mut() {
        let kind = span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if kind == "TOOL" {
            if let Some(data) = span
                .attributes
                .get("gen_ai.tool.call.id")
                .and_then(Value::as_str)
                .and_then(|id| tools.get(id))
            {
                if let Some(duration) = &data.duration {
                    span.attributes
                        .insert("gen_ai.tool.call.duration".into(), duration.clone());
                }
                for (key, value) in [
                    ("tool.result.status", &data.status),
                    ("loongsuite.grok.match.strategy", &data.match_strategy),
                    ("loongsuite.grok.timing.source", &data.timing_source),
                ] {
                    if let Some(value) = value {
                        span.attributes
                            .insert(key.into(), Value::String(value.clone()));
                    }
                }
                if matches!(data.status.as_deref(), Some("failure" | "cancelled")) {
                    let cancelled = data.status.as_deref() == Some("cancelled");
                    let message = if cancelled {
                        "tool execution cancelled"
                    } else {
                        "tool execution failed"
                    };
                    span.attributes.insert(
                        "error.type".into(),
                        Value::String(data.error_type.clone().unwrap_or_else(|| {
                            if cancelled {
                                "ToolCancelled"
                            } else {
                                "ToolError"
                            }
                            .into()
                        })),
                    );
                    span.attributes
                        .insert("error.message".into(), Value::String(message.into()));
                    span.status.insert("code".into(), Value::from(2));
                    span.status
                        .insert("message".into(), Value::String(message.into()));
                }
            }
            continue;
        }
        if kind == "LLM" {
            if let Some(data) = span
                .attributes
                .get("gen_ai.response.id")
                .and_then(Value::as_str)
                .and_then(|id| llms.get(id))
            {
                if let Some(source) = &data.timing_source {
                    span.attributes.insert(
                        "loongsuite.grok.timing.source".into(),
                        Value::String(source.clone()),
                    );
                }
                if let Some(error) = &data.error_type {
                    span.attributes
                        .insert("error.type".into(), Value::String(error.clone()));
                    span.attributes.insert(
                        "error.message".into(),
                        Value::String("model request failed".into()),
                    );
                    span.status.insert("code".into(), Value::from(2));
                    span.status.insert(
                        "message".into(),
                        Value::String("model request failed".into()),
                    );
                }
            }
            continue;
        }
        if kind == "AGENT" {
            if let Some(description) = &meta.agent_description {
                span.attributes.insert(
                    "gen_ai.agent.description".into(),
                    Value::String(description.clone()),
                );
            }
            if let Some(source) = &meta.data_source_id {
                span.attributes.insert(
                    "gen_ai.data_source.id".into(),
                    Value::String(source.clone()),
                );
            }
        }
        if matches!(kind.as_str(), "AGENT" | "ENTRY") {
            if let Some((reason, error)) = &terminal {
                let cancelled = reason == "cancelled";
                let message = if cancelled {
                    "turn cancelled"
                } else {
                    "model request failed"
                };
                span.attributes.insert(
                    "error.type".into(),
                    Value::String(error.clone().unwrap_or_else(|| {
                        if cancelled {
                            "cancelled"
                        } else {
                            "model_error"
                        }
                        .into()
                    })),
                );
                span.attributes
                    .insert("error.message".into(), Value::String(message.into()));
                span.status.insert("code".into(), Value::from(2));
                span.status
                    .insert("message".into(), Value::String(message.into()));
            }
        }
    }
    if !meta.system_instructions.is_empty() {
        if let Some(first) = spans
            .iter_mut()
            .filter(|span| {
                span.attributes
                    .get("gen_ai.span.kind")
                    .and_then(Value::as_str)
                    == Some("LLM")
            })
            .min_by_key(|span| (span.start_time[0], span.start_time[1]))
        {
            if let Ok(text) = serde_json::to_string(&meta.system_instructions) {
                first
                    .attributes
                    .insert("gen_ai.system_instructions".into(), Value::String(text));
            }
        }
    }
}

fn prepare_openclaw_collection(records: &[AgentActivityEntry]) -> Vec<AgentActivityEntry> {
    let mut endings: HashMap<String, Map<String, Value>> = HashMap::new();
    for record in records {
        if entry_str(record, "agent.openclaw.compatibility").as_deref() == Some("legacy")
            && entry_str(record, "agent.openclaw.hook").as_deref() == Some("legacy_cleanup")
        {
            let key = format!(
                "{:?}|{:?}",
                record.trace_id,
                entry_str(record, "gen_ai.turn.id")
            );
            let mut fields = Map::new();
            fields.insert(
                "agent.openclaw.collection.incomplete".to_string(),
                Value::Bool(true),
            );
            if let Some(reason) = entry_str(record, "agent.openclaw.collection.end_reason") {
                fields.insert(
                    "agent.openclaw.collection.end_reason".to_string(),
                    Value::String(reason),
                );
            }
            if entry_bool(record, "agent.openclaw.correlation.ambiguous") == Some(true) {
                fields.insert(
                    "agent.openclaw.correlation.ambiguous".to_string(),
                    Value::Bool(true),
                );
            }
            endings.insert(key, fields);
        }
    }
    if endings.is_empty() {
        return records.to_vec();
    }
    records
        .iter()
        .map(|record| {
            let key = format!(
                "{:?}|{:?}",
                record.trace_id,
                entry_str(record, "gen_ai.turn.id")
            );
            let Some(extra) = endings.get(&key) else {
                return record.clone();
            };
            let mut map = entry_to_object(record);
            for (key, value) in extra {
                map.insert(key.clone(), value.clone());
            }
            entry_from_map(map)
        })
        .collect()
}

fn prepare_openclaw_identity(
    records: &[AgentActivityEntry],
) -> (Vec<AgentActivityEntry>, Map<String, Value>) {
    let mut metadata = Map::new();
    let mut sender: Option<Map<String, Value>> = None;
    for record in records {
        insert_first(
            &mut metadata,
            "agent.openclaw.sender.id",
            entry_str(record, "agent.openclaw.sender.id"),
        );
        insert_first(
            &mut metadata,
            "agent.openclaw.channel",
            entry_str(record, "agent.openclaw.channel"),
        );
        insert_first(
            &mut metadata,
            "agent.openclaw.account.id",
            entry_str(record, "agent.openclaw.account.id"),
        );
        insert_first(
            &mut metadata,
            "agent.openclaw.channel.id",
            entry_str(record, "agent.openclaw.channel.id"),
        );
        insert_first(
            &mut metadata,
            "agent.openclaw.user.id.source",
            entry_str(record, "agent.openclaw.user.id.source"),
        );
        if entry_str(record, "agent.openclaw.user.id.source").as_deref() == Some("sender") {
            if let Some(sender_id) = entry_str(record, "agent.openclaw.sender.id") {
                let mut chosen = Map::new();
                chosen.insert(
                    "agent.openclaw.sender.id".to_string(),
                    Value::String(sender_id),
                );
                if let Some(value) = entry_str(record, "agent.openclaw.channel") {
                    chosen.insert("agent.openclaw.channel".to_string(), Value::String(value));
                }
                if let Some(value) = entry_str(record, "agent.openclaw.account.id") {
                    chosen.insert(
                        "agent.openclaw.account.id".to_string(),
                        Value::String(value),
                    );
                }
                if let Some(value) = entry_str(record, "agent.openclaw.channel.id") {
                    chosen.insert(
                        "agent.openclaw.channel.id".to_string(),
                        Value::String(value),
                    );
                }
                chosen.insert(
                    "agent.openclaw.user.id.source".to_string(),
                    Value::String("sender".to_string()),
                );
                sender = Some(chosen);
            }
        }
    }
    let Some(sender) = sender else {
        return (records.to_vec(), metadata);
    };
    let sender_id = sender
        .get("agent.openclaw.sender.id")
        .cloned()
        .unwrap_or(Value::Null);
    let records = records
        .iter()
        .map(|record| {
            let mut map = entry_to_object(record);
            map.insert("user.id".to_string(), sender_id.clone());
            for (key, value) in &sender {
                map.insert(key.clone(), value.clone());
            }
            entry_from_map(map)
        })
        .collect();
    (records, sender)
}

fn prepare_grok(records: &[AgentActivityEntry]) -> (Vec<AgentActivityEntry>, GrokMeta) {
    let mut meta = GrokMeta::default();
    let records = records
        .iter()
        .map(|record| {
            if meta.system_instructions.is_empty() {
                if let Some(value) = record.system_instructions.clone() {
                    meta.system_instructions = parse_system_instructions(&value);
                }
            }
            if meta.agent_description.is_none() {
                meta.agent_description = record.agent_description.clone();
            }
            if meta.data_source_id.is_none() {
                meta.data_source_id = record.data_source_id.clone();
            }
            let mut map = entry_to_object(record);
            for key in [
                "gen_ai.system_instructions",
                "gen_ai.agent.description",
                "gen_ai.data_source.id",
                "gen_ai.tool.call.duration",
            ] {
                map.remove(key);
            }
            for key in ["gen_ai.input.messages", "gen_ai.input.messages_delta"] {
                if let Some(value) = map.get(key).cloned() {
                    map.insert(key.to_string(), strip_system_messages(value));
                }
            }
            if map.get("event.name").and_then(|value| value.as_str()) == Some("other")
                && !map.contains_key("gen_ai.input.messages")
                && !map.contains_key("gen_ai.input.messages_delta")
            {
                map.insert(
                    "gen_ai.input.messages_delta".to_string(),
                    Value::Array(Vec::new()),
                );
            }
            if map.get("event.name").and_then(|value| value.as_str()) == Some("other") {
                map.remove("error.type");
                map.remove("error.message");
            }
            entry_from_map(map)
        })
        .collect();
    (records, meta)
}

fn parse_system_instructions(value: &Value) -> Vec<Value> {
    if let Value::Array(items) = value {
        return items.clone();
    }
    if let Value::String(text) = value {
        if text.is_empty() {
            return Vec::new();
        }
        if let Ok(Value::Array(items)) = serde_json::from_str(text) {
            return items;
        }
        return vec![serde_json::json!({"type": "text", "content": text})];
    }
    Vec::new()
}

fn strip_system_messages(value: Value) -> Value {
    let strip_array = |items: Vec<Value>| {
        items
            .into_iter()
            .filter(|message| message.get("role").and_then(|role| role.as_str()) != Some("system"))
            .collect::<Vec<_>>()
    };
    match value {
        Value::Array(items) => Value::Array(strip_array(items)),
        Value::String(text) if !text.is_empty() => {
            if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&text) {
                Value::String(serde_json::to_string(&strip_array(items)).unwrap_or(text))
            } else {
                Value::String(text)
            }
        }
        other => other,
    }
}

fn collect_resource_attributes(
    inner: &OtlpInner,
    records: &[AgentActivityEntry],
) -> Map<String, Value> {
    let allowed: HashSet<&str> = inner
        .resource_attribute_keys
        .iter()
        .map(String::as_str)
        .collect();
    let mut attributes = Map::new();
    for record in records {
        if let Some(resource) = &record.resource_attributes {
            for (key, value) in resource {
                insert_resource(&mut attributes, key, value);
            }
        }
        if allowed.is_empty() {
            continue;
        }
        for (key, value) in entry_to_object(record) {
            if allowed.contains(key.as_str()) {
                insert_resource(&mut attributes, &key, &value);
            }
        }
    }
    attributes
}

fn insert_resource(attributes: &mut Map<String, Value>, key: &str, raw: &Value) {
    if SENSITIVE_RESOURCE_KEY.is_match(key) {
        return;
    }
    let Some(value) = normalize_resource_value(raw) else {
        return;
    };
    if let Some(existing) = attributes.get(key) {
        if existing != &value {
            return;
        }
    }
    attributes.insert(key.to_string(), value);
}

fn normalize_resource_value(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(Value::String(trimmed.to_string()))
            }
        }
        Value::Bool(flag) => Some(Value::Bool(*flag)),
        Value::Number(number) if number.as_f64().is_some_and(|number| number.is_finite()) => {
            Some(Value::Number(number.clone()))
        }
        _ => None,
    }
}

fn resource_identity(agent_type: &str, records: &[AgentActivityEntry]) -> (String, String) {
    let mut system = None;
    let mut framework = None;
    for record in records {
        if system.is_none() {
            system = entry_str(record, "gen_ai.agent.system")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
        }
        if framework.is_none() {
            framework = entry_str(record, "gen_ai.framework")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
        }
    }
    (
        system.unwrap_or_else(|| resolve_agent_system(agent_type).to_string()),
        framework.unwrap_or_else(|| agent_type.to_string()),
    )
}

fn resolve_endpoint_url(raw: &str) -> String {
    let url = raw.trim_end_matches('/').to_string();
    if url.ends_with("/v1/traces") {
        url
    } else {
        format!("{url}/v1/traces")
    }
}

fn is_cms_endpoint(headers: &HashMap<String, String>) -> bool {
    headers.keys().any(|key| {
        let key = key.to_ascii_lowercase();
        key == "x-cms-workspace" || key == "x-arms-license-key" || key == "x-arms-project"
    })
}

fn cms_project_of(headers: &HashMap<String, String>, url: &str) -> String {
    for (key, value) in headers {
        if key.eq_ignore_ascii_case("x-arms-project") && !value.is_empty() {
            return value.clone();
        }
    }
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .and_then(|host| host.split('.').next())
        .unwrap_or("")
        .to_string()
}

fn enable_content_capture() {
    let current = std::env::var("OTEL_SEMCONV_STABILITY_OPT_IN").unwrap_or_default();
    let mut parts: Vec<String> = current
        .split(',')
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    if !parts
        .iter()
        .any(|value| value.eq_ignore_ascii_case("gen_ai_latest_experimental"))
    {
        parts.push("gen_ai_latest_experimental".to_string());
    }
    unsafe {
        std::env::set_var("OTEL_SEMCONV_STABILITY_OPT_IN", parts.join(","));
        std::env::set_var(
            "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
            "SPAN_ONLY",
        );
    }
}

fn default_data_dir() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    format!("{home}/.loongsuite-pilot")
}

fn host_name() -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn entry_map(entry: &AgentActivityEntry) -> Map<String, Value> {
    entry_to_object(entry)
}

fn entry_str(entry: &AgentActivityEntry, key: &str) -> Option<String> {
    match key {
        "event.name" => entry.event_name.map(|name| name.as_str().to_string()),
        "event.id" => nonempty(Some(entry.event_id.clone())),
        "gen_ai.agent.type" => nonempty(Some(entry.agent_type.clone())),
        "gen_ai.turn.id" => entry.turn_id.clone().filter(|value| !value.is_empty()),
        "gen_ai.session.id" => nonempty(Some(entry.session_id.clone())),
        "gen_ai.step.id" => entry.step_id.clone().filter(|value| !value.is_empty()),
        "trace_id" => entry.trace_id.clone().filter(|value| !value.is_empty()),
        "gen_ai.tool.call.id" => entry.tool_call_id.clone().filter(|value| !value.is_empty()),
        "gen_ai.response.id" => entry.response_id.clone().filter(|value| !value.is_empty()),
        "gen_ai.request.id" => entry.request_id.clone().filter(|value| !value.is_empty()),
        "error.type" => entry.error_type.clone().filter(|value| !value.is_empty()),
        _ => entry_map(entry)
            .get(key)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    }
}

fn entry_bool(entry: &AgentActivityEntry, key: &str) -> Option<bool> {
    match key {
        "gen_ai.turn.end" => entry.turn_end,
        _ => entry_map(entry).get(key).and_then(|value| value.as_bool()),
    }
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

fn set_string(entry: &mut AgentActivityEntry, key: &str, value: &str) {
    let mut map = entry_map(entry);
    map.insert(key.to_string(), Value::String(value.to_string()));
    *entry = entry_from_map(map);
}

fn insert_first(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if map.contains_key(key) {
        return;
    }
    if let Some(value) = value {
        map.insert(key.to_string(), Value::String(value));
    }
}

fn meta(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::base_flusher::BaseFlusher;
    use super::super::otlp_json_serializer::{
        ConvertOptions, ConvertResult, EventLogConverter, ReadableSpan,
    };
    use super::{entry_str, ExporterFactory, OtlpTraceFlusher, TraceExporter};
    use crate::normalization::entry_from_map;
    use crate::types::{
        AgentActivityEntry, OtlpCompression, OtlpEndpoint, OtlpProtocol, OtlpTraceFlusherConfig,
    };
    use async_trait::async_trait;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn cfg(endpoints: Vec<OtlpEndpoint>) -> OtlpTraceFlusherConfig {
        OtlpTraceFlusherConfig {
            span_enricher_paths: None,
            enabled: true,
            endpoints,
            protocol: OtlpProtocol::HttpProtobuf,
            service_name: "test-pilot".to_string(),
            append_agent_type_to_service_name: None,
            resource_attributes: None,
            capture_message_content: None,
            debug: None,
            turn_idle_timeout_ms: None,
            resource_attribute_keys: None,
            span_attribute_passthrough_prefixes: None,
            max_export_batch_bytes: None,
            data_dir: None,
        }
    }

    fn ep(name: &str, endpoint: &str) -> OtlpEndpoint {
        crate::types::OtlpEndpoint {
            name: name.to_string(),
            endpoint: endpoint.to_string(),
            headers: None,
            compression: None,
            service_name: None,
        }
    }

    fn entry(fields: Value) -> AgentActivityEntry {
        entry_from_map(fields.as_object().cloned().unwrap_or_default())
    }

    struct RecConv {
        calls: Mutex<Vec<Vec<AgentActivityEntry>>>,
    }

    impl EventLogConverter for RecConv {
        fn convert(
            &self,
            records: &[AgentActivityEntry],
            _options: &ConvertOptions,
        ) -> Result<ConvertResult, String> {
            self.calls.lock().unwrap().push(records.to_vec());
            Ok(ConvertResult {
                span_count: records.len(),
                ..ConvertResult::default()
            })
        }
    }

    fn make_flusher() -> (OtlpTraceFlusher, Arc<RecConv>) {
        let converter = Arc::new(RecConv {
            calls: Mutex::new(Vec::new()),
        });
        let flusher = OtlpTraceFlusher::with_parts(
            cfg(vec![ep("primary", "http://localhost:4318")]),
            None,
            None,
            Some(converter.clone()),
        )
        .unwrap();
        (flusher, converter)
    }

    #[tokio::test]
    async fn copilot_hybrid_replay_merges_missing_fields_waits_for_interaction_and_ignores_summary()
    {
        let (flusher, converter) = make_flusher();
        let request = json!({"event.name":"llm.request","event.id":"request","time_unix_nano":"100",
            "gen_ai.agent.type":"copilot","gen_ai.session.id":"session","gen_ai.turn.id":"interaction",
            "trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","gen_ai.copilot.source":"hybrid-v2",
            "gen_ai.response.id":"response","gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"first prompt"}]}]});
        flusher.send(entry(request.clone()), None).await.unwrap();
        let mut replay = request.clone();
        replay["gen_ai.input.messages_delta"] =
            json!([{"role":"user","parts":[{"type":"text","content":"replacement"}]}]);
        replay["gen_ai.llm.reasoning.text"] = json!("new evidence");
        flusher.send(entry(replay), None).await.unwrap();
        let mut response = request.clone();
        response["event.name"] = json!("llm.response");
        response["event.id"] = json!("response-event");
        response["gen_ai.response.finish_reasons"] = json!(["stop"]);
        flusher.send(entry(response), None).await.unwrap();
        assert!(converter.calls.lock().unwrap().is_empty());
        flusher.send(entry(json!({"event.name":"other","event.id":"summary",
            "gen_ai.agent.type":"copilot","gen_ai.session.id":"session","gen_ai.copilot.session_summary":true})),None).await.unwrap();
        let mut terminal = request;
        terminal["event.name"] = json!("other");
        terminal["event.id"] = json!("terminal");
        terminal["gen_ai.turn.end"] = json!(true);
        flusher.send(entry(terminal), None).await.unwrap();
        {
            let calls = converter.calls.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].len(), 3);
            assert_eq!(
                calls[0][0].input_messages_delta.as_ref().unwrap()[0]["parts"][0]["content"],
                "first prompt"
            );
            assert_eq!(
                calls[0][0].get("gen_ai.llm.reasoning.text"),
                Some(&json!("new evidence"))
            );
        }
        flusher.shutdown().await.unwrap();
        assert_eq!(converter.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn copilot_cancellation_sets_agent_error_without_inventing_model_error_or_usage() {
        let records = vec![
            entry(
                json!({"event.name":"llm.request","event.id":"req","time_unix_nano":"100","gen_ai.agent.type":"copilot",
                "gen_ai.session.id":"s","gen_ai.turn.id":"t","gen_ai.step.id":"step","gen_ai.response.id":"r"}),
            ),
            entry(
                json!({"event.name":"llm.response","event.id":"resp","time_unix_nano":"200","gen_ai.agent.type":"copilot",
                "gen_ai.session.id":"s","gen_ai.turn.id":"t","gen_ai.step.id":"step","gen_ai.response.id":"r",
                "gen_ai.copilot.interaction.error":"cancelled"}),
            ),
        ];
        let result = super::route_convert(
            "copilot",
            &records,
            &[],
            &crate::flushers::GenAiEventLogConverter,
        )
        .unwrap();
        let agent = result
            .spans
            .iter()
            .find(|span| span.attributes["gen_ai.span.kind"] == "AGENT")
            .unwrap();
        assert_eq!(agent.status["code"], 2);
        assert_eq!(agent.attributes["error.type"], "cancelled");
        let llm = result
            .spans
            .iter()
            .find(|span| span.attributes["gen_ai.span.kind"] == "LLM")
            .unwrap();
        assert_ne!(llm.status["code"], 2);
        assert!(!llm.attributes.contains_key("gen_ai.usage.input_tokens"));
    }

    #[test]
    fn rejects_empty_endpoints_and_service_name() {
        let error = OtlpTraceFlusher::new(cfg(Vec::new())).unwrap_err();
        assert!(error.contains("endpoints must be non-empty"));
        let mut config = cfg(vec![ep("primary", "http://localhost:4318")]);
        config.service_name.clear();
        let error = OtlpTraceFlusher::new(config).unwrap_err();
        assert!(error.contains("serviceName is required"));
        let flusher =
            OtlpTraceFlusher::new(cfg(vec![ep("primary", "http://localhost:4318")])).unwrap();
        assert_eq!(flusher.name(), "otlp-trace");
        assert_eq!(
            std::env::var("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT").unwrap(),
            "SPAN_ONLY"
        );
    }

    #[tokio::test]
    async fn normalizes_endpoint_urls_and_cms_identity() {
        let flusher = OtlpTraceFlusher::new(cfg(vec![ep(
            "primary",
            "https://example.com/apm/trace/opentelemetry",
        )]))
        .unwrap();
        flusher
            .export_spans_for_agent("claude-code", Vec::new())
            .await;
        assert_eq!(
            flusher.created_exporters()[0].url,
            "https://example.com/apm/trace/opentelemetry/v1/traces"
        );
        assert_eq!(flusher.created_exporters()[0].compression, "gzip");

        let mut already = ep("primary", "https://example.com/v1/traces");
        already.compression = Some(OtlpCompression::None);
        let flusher = OtlpTraceFlusher::new(cfg(vec![already])).unwrap();
        flusher.export_spans_for_agent("codex", Vec::new()).await;
        assert_eq!(
            flusher.created_exporters()[0].url,
            "https://example.com/v1/traces"
        );
        assert_eq!(flusher.created_exporters()[0].compression, "none");

        let slashed =
            OtlpTraceFlusher::new(cfg(vec![ep("primary", "https://example.com/otlp/")])).unwrap();
        slashed.export_spans_for_agent("codex", Vec::new()).await;
        assert_eq!(
            slashed.created_exporters()[0].url,
            "https://example.com/otlp/v1/traces"
        );

        let cms_url = "https://proj-xtrace-1d3dc285e44fcb12fa8cbcb1dd13551-cn-hongkong.cn-hongkong.log.aliyuncs.com/apm/trace/opentelemetry";
        let mut cms = ep("user-cms", cms_url);
        cms.headers = Some(HashMap::from([
            ("x-arms-license-key".to_string(), "lk".to_string()),
            (
                "x-arms-project".to_string(),
                "proj-xtrace-1d3dc285e44fcb12fa8cbcb1dd13551-cn-hongkong".to_string(),
            ),
        ]));
        let counters = OtlpTraceFlusher::new(cfg(vec![cms]))
            .unwrap()
            .endpoint_counters();
        let counter = counters.get("user-cms").unwrap();
        assert!(counter.is_cms);
        assert_eq!(
            counter.project,
            "proj-xtrace-1d3dc285e44fcb12fa8cbcb1dd13551-cn-hongkong"
        );
        assert_eq!(counter.logstore, "logstore-tracing");

        let mut workspace = ep("inner-cms-0", cms_url);
        workspace.headers = Some(HashMap::from([(
            "X-CMS-Workspace".to_string(),
            "ws-1".to_string(),
        )]));
        let counter = OtlpTraceFlusher::new(cfg(vec![workspace]))
            .unwrap()
            .endpoint_counters();
        let counter = counter.get("inner-cms-0").unwrap();
        assert!(counter.is_cms);
        assert_eq!(
            counter.project,
            "proj-xtrace-1d3dc285e44fcb12fa8cbcb1dd13551-cn-hongkong"
        );

        let mut plain = ep("user-otlp", "https://collector.example.com/v1/traces");
        plain.headers = Some(HashMap::from([(
            "authorization".to_string(),
            "Bearer t".to_string(),
        )]));
        let counter = OtlpTraceFlusher::new(cfg(vec![plain]))
            .unwrap()
            .endpoint_counters()
            .remove("user-otlp")
            .unwrap();
        assert!(!counter.is_cms);
        assert!(counter.project.is_empty());
        assert!(counter.logstore.is_empty());
    }

    #[tokio::test]
    async fn groups_by_turn_then_trace_then_session() {
        let (flusher, converter) = make_flusher();
        let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","gen_ai.turn.id":"turn-abc","trace_id":trace,"gen_ai.session.id":"session-1"})), None).await.unwrap();
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","gen_ai.turn.id":"turn-abc","trace_id":"aaaa2f3577b34da6a3ce929d0e0e4736","gen_ai.session.id":"session-1"})), None).await.unwrap();
        flusher.shutdown().await.unwrap();
        assert_eq!(converter.calls.lock().unwrap().len(), 1);
        assert_eq!(converter.calls.lock().unwrap()[0].len(), 2);

        let (flusher, converter) = make_flusher();
        flusher.send(entry(json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","trace_id":"aaaa2f3577b34da6a3ce929d0e0e4736","gen_ai.session.id":"session-1"})), None).await.unwrap();
        flusher.send(entry(json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","trace_id":"bbbb2f3577b34da6a3ce929d0e0e4736","gen_ai.session.id":"session-1"})), None).await.unwrap();
        assert_eq!(converter.calls.lock().unwrap().len(), 1);
        flusher.shutdown().await.unwrap();
        assert_eq!(converter.calls.lock().unwrap().len(), 2);

        let (flusher, converter) = make_flusher();
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","trace_id":"invalid-not-32-hex","gen_ai.session.id":"session-1"})), None).await.unwrap();
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","trace_id":"still-invalid","gen_ai.session.id":"session-1"})), None).await.unwrap();
        flusher.shutdown().await.unwrap();
        assert_eq!(converter.calls.lock().unwrap().len(), 1);
        assert_eq!(converter.calls.lock().unwrap()[0].len(), 2);
    }

    #[tokio::test]
    async fn opencode_v2_flushes_only_execution_completion_and_v1_keeps_finish_reason_behavior() {
        for v2 in [false, true] {
            let (flusher, converter) = make_flusher();
            let mut request = json!({"event.name":"llm.request","gen_ai.agent.type":"opencode",
                "gen_ai.session.id":"session-1","gen_ai.turn.id":"turn",
                "trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"});
            if v2 {
                request["agent.opencode.collection"] = json!("v2");
            }
            flusher.send(entry(request.clone()), None).await.unwrap();
            let mut response = request.clone();
            response["event.name"] = json!("llm.response");
            response["gen_ai.response.finish_reasons"] = json!(["stop"]);
            flusher.send(entry(response.clone()), None).await.unwrap();
            if !v2 {
                assert_eq!(converter.calls.lock().unwrap()[0].len(), 2);
                flusher.shutdown().await.unwrap();
                continue;
            }
            assert!(converter.calls.lock().unwrap().is_empty());
            for name in ["tool.call", "tool.result", "llm.request", "llm.response"] {
                let mut record = request.clone();
                record["event.name"] = json!(name);
                record["gen_ai.response.finish_reasons"] = json!(["error"]);
                record["error.type"] = json!("RetryableModelError");
                flusher.send(entry(record), None).await.unwrap();
                assert!(converter.calls.lock().unwrap().is_empty());
            }
            response["event.name"] = json!("other");
            response["gen_ai.turn.end"] = json!(true);
            flusher.send(entry(response), None).await.unwrap();
            assert_eq!(converter.calls.lock().unwrap().len(), 1);
            assert_eq!(converter.calls.lock().unwrap()[0].len(), 7);
            flusher.shutdown().await.unwrap();
            assert_eq!(converter.calls.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn terminal_rules_match_the_typescript_flusher() {
        let (flusher, converter) = make_flusher();
        flusher.send(entry(json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"})), None).await.unwrap();
        assert!(converter.calls.lock().unwrap().is_empty());
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","gen_ai.response.finish_reasons":["stop"]})), None).await.unwrap();
        assert_eq!(converter.calls.lock().unwrap()[0].len(), 2);

        let (flusher, converter) = make_flusher();
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","gen_ai.response.finish_reasons":["tool_calls"]})), None).await.unwrap();
        assert!(converter.calls.lock().unwrap().is_empty());

        let (flusher, converter) = make_flusher();
        flusher.send(entry(json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"})), None).await.unwrap();
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","gen_ai.response.finish_reasons":["error"],"error.type":"RateLimitError"})), None).await.unwrap();
        assert!(converter.calls.lock().unwrap().is_empty());
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","gen_ai.response.finish_reasons":["error"],"gen_ai.turn.end":true})), None).await.unwrap();
        assert_eq!(converter.calls.lock().unwrap()[0].len(), 3);

        let (flusher, converter) = make_flusher();
        let turn = "parent:turn-1";
        for extra in [
            json!({"event.name":"llm.request"}),
            json!({"gen_ai.response.finish_reasons":["stop"]}),
            json!({"gen_ai.agent.scope":"subagent","gen_ai.response.finish_reasons":["stop"]}),
            json!({"gen_ai.response.finish_reasons":["stop"]}),
        ] {
            let mut value = json!({"event.name":"llm.response", "gen_ai.turn.id": turn, "gen_ai.agent.type":"codex"});
            if let (Value::Object(base), Value::Object(extra)) = (&mut value, extra) {
                for (key, item) in extra {
                    base.insert(key, item);
                }
            }
            flusher.send(entry(value), None).await.unwrap();
        }
        assert!(converter.calls.lock().unwrap().is_empty());
        flusher.send(entry(json!({"gen_ai.turn.id": turn, "gen_ai.agent.type":"codex","event.name":"other","agent.codex.turn_status":"completed","gen_ai.turn.end":true})), None).await.unwrap();
        assert_eq!(converter.calls.lock().unwrap()[0].len(), 5);

        let (flusher, converter) = make_flusher();
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"openclaw","gen_ai.turn.id":"oc","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","agent.openclaw.hook":"before_message_write","gen_ai.response.finish_reasons":["stop"]})), None).await.unwrap();
        assert!(converter.calls.lock().unwrap().is_empty());
        flusher.send(entry(json!({"event.name":"other","gen_ai.agent.type":"openclaw","gen_ai.turn.id":"oc","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","agent.openclaw.hook":"llm_output"})), None).await.unwrap();
        assert_eq!(converter.calls.lock().unwrap()[0].len(), 2);
    }

    #[tokio::test]
    async fn signal_b_requires_the_same_session_and_shutdown_backfills_turn_id() {
        let (flusher, converter) = make_flusher();
        flusher.send(entry(json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","trace_id":"aaaa2f3577b34da6a3ce929d0e0e4736"})), None).await.unwrap();
        flusher.send(entry(json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","trace_id":"bbbb2f3577b34da6a3ce929d0e0e4736"})), None).await.unwrap();
        assert!(converter.calls.lock().unwrap().is_empty());
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","trace_id":"aaaa2f3577b34da6a3ce929d0e0e4736","gen_ai.response.finish_reasons":["stop"]})), None).await.unwrap();
        assert_eq!(converter.calls.lock().unwrap()[0].len(), 2);

        let (flusher, converter) = make_flusher();
        let trace = "aaaa2f3577b34da6a3ce929d0e0e4736";
        flusher.send(entry(json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","trace_id":trace})), None).await.unwrap();
        flusher.send(entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","trace_id":trace,"gen_ai.response.finish_reasons":["stop"]})), None).await.unwrap();
        for record in &converter.calls.lock().unwrap()[0] {
            assert_eq!(entry_str(record, "gen_ai.turn.id").as_deref(), Some(trace));
        }
    }

    #[tokio::test]
    async fn send_batch_defers_signal_a_until_the_batch_is_appended() {
        let (flusher, converter) = make_flusher();
        let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
        flusher.send_batch(vec![
            entry(json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","trace_id":trace})),
            entry(json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","trace_id":trace,"gen_ai.response.finish_reasons":["stop"]})),
            entry(json!({"event.name":"tool.result","gen_ai.agent.type":"claude-code","trace_id":trace})),
        ], None).await.unwrap();
        assert_eq!(converter.calls.lock().unwrap().len(), 1);
        assert_eq!(converter.calls.lock().unwrap()[0].len(), 3);
    }

    #[tokio::test]
    async fn orphan_starts_are_removed_at_the_conversion_boundary() {
        let (flusher, converter) = make_flusher();
        flusher.send_batch(vec![
            entry(json!({"event.name":"other", "gen_ai.agent.type":"mimo-code", "gen_ai.turn.id":"orphan", "gen_ai.input.messages_delta":[]})),
            entry(json!({"event.name":"llm.request", "gen_ai.agent.type":"mimo-code", "gen_ai.turn.id":"orphan", "gen_ai.step.id":"s1"})),
            entry(json!({"event.name":"tool.call", "gen_ai.agent.type":"mimo-code", "gen_ai.turn.id":"orphan", "gen_ai.tool.call.id":"call-1"})),
            entry(json!({"event.name":"tool.call", "gen_ai.agent.type":"mimo-code", "gen_ai.turn.id":"orphan", "gen_ai.tool.call.id":"call-2"})),
        ], None).await.unwrap();
        flusher.shutdown().await.unwrap();
        let calls = converter.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].len(), 1);
        assert_eq!(
            calls[0][0].event_name,
            Some(crate::types::AgentEventName::Other)
        );
    }

    #[tokio::test]
    async fn exports_batches_and_sanitizes_failed_log_names() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&calls);
        let factory: ExporterFactory = Arc::new(move |_opts| {
            let seen = Arc::clone(&seen);
            Arc::new(CountExporter { seen }) as Arc<dyn TraceExporter>
        });
        struct CountExporter {
            seen: Arc<AtomicUsize>,
        }
        #[async_trait]
        impl TraceExporter for CountExporter {
            async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
                self.seen.fetch_add(spans.len(), Ordering::SeqCst);
                Ok(())
            }
            async fn shutdown(&self) {}
        }
        let mut config = cfg(vec![ep("primary", "http://localhost:4318")]);
        config.max_export_batch_bytes = Some(10 * 1024);
        let flusher = OtlpTraceFlusher::with_parts(config, None, Some(factory), None).unwrap();
        let mut spans = Vec::new();
        for _ in 0..5 {
            let mut span = ReadableSpan::minimal("s", &"a".repeat(32), &"b".repeat(16));
            span.attributes.insert(
                "gen_ai.agent.type".to_string(),
                Value::String("claude-code".to_string()),
            );
            span.attributes.insert(
                "gen_ai.input.messages".to_string(),
                Value::String("x".repeat(4096)),
            );
            spans.push(span);
        }
        flusher.export_spans_for_agent("claude-code", spans).await;
        assert_eq!(calls.load(Ordering::SeqCst), 5);

        let dir = tempfile::tempdir().unwrap();
        let bad = ep("../../../../tmp/pwn", "http://evil:4318");
        let mut config = cfg(vec![bad.clone()]);
        config.data_dir = Some(dir.path().to_string_lossy().to_string());
        config.service_name = "test-pilot".to_string();
        struct FailExport;
        #[async_trait]
        impl TraceExporter for FailExport {
            async fn export(&self, _spans: Vec<ReadableSpan>) -> Result<(), String> {
                Err("boom".to_string())
            }
            async fn shutdown(&self) {}
        }
        let flusher = OtlpTraceFlusher::with_parts(
            config,
            None,
            Some(Arc::new(|_| Arc::new(FailExport) as Arc<dyn TraceExporter>)),
            None,
        )
        .unwrap();
        flusher
            .export_spans_for_agent("claude-code", vec![ReadableSpan::minimal("s", "a", "b")])
            .await;
        let failed = std::fs::read_dir(dir.path().join("logs").join("otlp-failed"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        let name = failed.file_name().to_string_lossy().to_string();
        assert!(name.contains(".._.._.._.._tmp_pwn"));
        assert!(!name.contains("/tmp/pwn"));
        let text = std::fs::read_to_string(failed.path()).unwrap();
        let parsed: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert!(parsed["_error"]["message"]
            .as_str()
            .unwrap()
            .contains("boom"));
        let _ = bad;
    }

    #[test]
    fn service_names_can_disable_the_agent_suffix() {
        let user = ep("user", "http://a:4318");
        let mut inner = ep("inner", "http://b:4318");
        inner.service_name = Some("managed-svc".to_string());
        let mut config = cfg(vec![user, inner]);
        config.append_agent_type_to_service_name = Some(false);
        config.service_name = "shared-service".to_string();
        let flusher = OtlpTraceFlusher::new(config).unwrap();
        assert_eq!(
            flusher.endpoint_service_name(0, "opencode"),
            "shared-service"
        );
        assert_eq!(flusher.endpoint_service_name(1, "codex"), "managed-svc");
        let resource = flusher.resource_attributes("codex", "shared-service");
        assert_eq!(resource["service.name"], "shared-service");
        assert_eq!(resource["gen_ai.agent.type"], "codex");
        assert_eq!(resource["service.namespace"], "loongsuite-pilot");
    }

    #[tokio::test]
    async fn runtime_snapshot_counts_pending_buffers() {
        let (flusher, _) = make_flusher();
        flusher.send(entry(json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","gen_ai.turn.id":"t1"})), Some(10.0)).await.unwrap();
        let snapshot = flusher.trace_runtime_snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].agent_type, "claude-code");
        assert_eq!(snapshot[0].pending_buffers, 1);
        assert_eq!(snapshot[0].pending_records, 1);
        assert_eq!(snapshot[0].pending_logical_bytes, 10.0);
        assert_eq!(snapshot[0].largest_buffer_turn_id.as_deref(), Some("t1"));
    }

    #[tokio::test]
    async fn standard_aliases_reach_converter_without_audit_creating_or_closing_buffers() {
        let (flusher, converter) = make_flusher();
        let audit = entry(json!({
            "event.id":"audit-only","event.name":"gen_ai.agent.invoke","time_unix_nano":"1000000",
            "gen_ai.agent.type":"cursor","gen_ai.session.id":"session","gen_ai.turn.id":"audit-only",
            "gen_ai.turn.end":true,"gen_ai.response.finish_reasons":["stop"]
        }));
        flusher.send(audit.clone(), None).await.unwrap();
        assert!(flusher.trace_runtime_snapshot().is_empty());
        assert!(converter.calls.lock().unwrap().is_empty());
        let request = entry(json!({
            "event.id":"request","event.name":"gen_ai.model.request","time_unix_nano":"1000000",
            "gen_ai.agent.type":"cursor","gen_ai.session.id":"session","gen_ai.turn.id":"turn",
            "gen_ai.response.id":"response"
        }));
        flusher.send(request.clone(), None).await.unwrap();
        let mut audit = audit;
        audit.turn_id = Some("turn".into());
        audit.event_name = Some(crate::types::AgentEventName::AgentResult);
        flusher.send(audit, None).await.unwrap();
        assert_eq!(flusher.trace_runtime_snapshot()[0].pending_records, 1);
        assert!(converter.calls.lock().unwrap().is_empty());
        let mut alias = request;
        alias.event_id = "legacy-alias".into();
        alias.event_name = Some(crate::types::AgentEventName::LlmRequest);
        let response = entry(json!({
            "event.id":"response","event.name":"gen_ai.model.response","time_unix_nano":"2000000",
            "gen_ai.agent.type":"cursor","gen_ai.session.id":"session","gen_ai.turn.id":"turn",
            "gen_ai.response.id":"response","gen_ai.response.finish_reasons":["stop"]
        }));
        flusher
            .send_batch(vec![alias, response], None)
            .await
            .unwrap();
        let calls = converter.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].len(), 2);
        assert_eq!(
            calls[0][0].event_name,
            Some(crate::types::AgentEventName::LlmRequest)
        );
        assert_eq!(
            calls[0][1].event_name,
            Some(crate::types::AgentEventName::LlmResponse)
        );
    }

    // Exact frozen TS config/grouping/counter declarations, no external endpoints.
    mod migration_configuration_contracts {
        use super::*;

        #[test]
        fn empty_or_absent_headers_complete_configuration_and_resource_attributes_construct() {
            let dir = tempfile::tempdir().unwrap();
            for headers in [None, Some(HashMap::new())] {
                let mut endpoint = ep("primary", "http://localhost:4318");
                endpoint.headers = headers;
                let mut config = cfg(vec![endpoint]);
                config.data_dir = Some(dir.path().to_string_lossy().into_owned());
                let flusher = OtlpTraceFlusher::new(config).unwrap();
                assert_eq!(flusher.name(), "otlp-trace");
                assert!(flusher.inner.endpoints[0].headers.is_empty());
            }

            let mut arms = ep("arms", "http://localhost:4318/apm/trace/opentelemetry");
            arms.headers = Some(HashMap::from([("x-arms-license-key".into(), "abc".into())]));
            let mut config = cfg(vec![arms]);
            config.data_dir = Some(dir.path().to_string_lossy().into_owned());
            config.service_name = "loongsuite-pilot".into();
            config.debug = Some(true);
            config.turn_idle_timeout_ms = Some(0);
            config.capture_message_content = Some(false);
            config.resource_attributes = Some(
                serde_json::from_value(json!({
                    "acs.arms.service.feature": "genai_app", "custom.key": "val"
                }))
                .unwrap(),
            );
            let flusher = OtlpTraceFlusher::new(config).unwrap();
            assert_eq!(flusher.name(), "otlp-trace");
            assert_eq!(
                flusher.inner.endpoints[0].headers["x-arms-license-key"],
                "abc"
            );
            assert_eq!(
                std::env::var("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT").unwrap(),
                "SPAN_ONLY"
            );
            let resource =
                flusher.resource_attributes("claude-code", "loongsuite-pilot-claude-code");
            assert_eq!(resource["acs.arms.service.feature"], "genai_app");
            assert_eq!(resource["custom.key"], "val");

            let a = ep("a", "http://a:4318");
            let mut b = ep("b", "http://b:4318");
            b.headers = Some(HashMap::from([("x-arms-license-key".into(), "k".into())]));
            let mut config = cfg(vec![a, b]);
            config.data_dir = Some(dir.path().to_string_lossy().into_owned());
            config.service_name = "loongsuite-pilot".into();
            let flusher = OtlpTraceFlusher::new(config).unwrap();
            assert_eq!(flusher.name(), "otlp-trace");
            assert_eq!(flusher.inner.endpoints.len(), 2);
            assert_eq!(flusher.inner.endpoints[0].name, "a");
            assert_eq!(flusher.inner.endpoints[1].name, "b");
            assert_eq!(
                flusher.inner.endpoints[1].headers["x-arms-license-key"],
                "k"
            );
        }

        fn scoped() -> (tempfile::TempDir, OtlpTraceFlusher, Arc<RecConv>) {
            let dir = tempfile::tempdir().unwrap();
            let mut config = cfg(vec![ep("primary", "http://unused:4318")]);
            config.data_dir = Some(dir.path().to_string_lossy().into_owned());
            let converter = Arc::new(RecConv {
                calls: Mutex::new(Vec::new()),
            });
            let flusher =
                OtlpTraceFlusher::with_parts(config, None, None, Some(converter.clone())).unwrap();
            (dir, flusher, converter)
        }

        #[tokio::test]
        async fn grouping_priority_uses_real_buffers_and_ephemeral_records_convert_immediately() {
            let (_dir, flusher, converter) = scoped();
            for (index, trace) in [
                "4bf92f3577b34da6a3ce929d0e0e4736",
                "aaaa2f3577b34da6a3ce929d0e0e4736",
            ]
            .iter()
            .enumerate()
            {
                flusher
                    .send(
                        entry(json!({
                            "event.id": format!("req{index}"), "event.name": "llm.request",
                            "gen_ai.agent.type": "claude-code", "gen_ai.turn.id": "turn-abc",
                            "trace_id": trace, "gen_ai.session.id": "session-1"
                        })),
                        None,
                    )
                    .await
                    .unwrap();
            }
            {
                let state = flusher.inner.state.lock().unwrap();
                assert_eq!(state.buffers.len(), 1);
                assert_eq!(state.buffers["turn:turn-abc"].records.len(), 2);
                assert_eq!(
                    state.buffers["turn:turn-abc"]
                        .records
                        .iter()
                        .map(|entry| entry.event_id.as_str())
                        .collect::<Vec<_>>(),
                    ["req0", "req1"]
                );
            }
            assert!(converter.calls.lock().unwrap().is_empty());
            flusher.shutdown().await.unwrap();
            assert_eq!(converter.calls.lock().unwrap().len(), 1);
            // Grouping retains both source records. The real conversion boundary
            // correctly removes unmatched model requests rather than inventing responses.
            assert!(converter.calls.lock().unwrap()[0].is_empty());

            let (_dir, flusher, converter) = scoped();
            for (index, trace) in [
                "4bf92f3577b34da6a3ce929d0e0e4736",
                "bbbb2f3577b34da6a3ce929d0e0e4736",
            ]
            .iter()
            .enumerate()
            {
                flusher.send(entry(json!({
                    "event.id": format!("trace{index}"), "event.name": "llm.request", "gen_ai.agent.type": "claude-code",
                    "trace_id": trace, "gen_ai.session.id": "session-1"
                })), None).await.unwrap();
            }
            assert_eq!(converter.calls.lock().unwrap().len(), 1);
            assert!(flusher
                .inner
                .state
                .lock()
                .unwrap()
                .buffers
                .contains_key("trace:bbbb2f3577b34da6a3ce929d0e0e4736"));
            flusher.shutdown().await.unwrap();
            assert_eq!(converter.calls.lock().unwrap().len(), 2);

            let (_dir, flusher, converter) = scoped();
            flusher
                .send(
                    entry(json!({
                        "event.name": "llm.request", "gen_ai.agent.type": "claude-code",
                        "trace_id": "invalid-not-32-hex", "gen_ai.session.id": "session-1"
                    })),
                    None,
                )
                .await
                .unwrap();
            assert!(flusher
                .inner
                .state
                .lock()
                .unwrap()
                .buffers
                .contains_key("session:session-1"));
            flusher.shutdown().await.unwrap();
            assert_eq!(converter.calls.lock().unwrap().len(), 1);

            let (_dir, flusher, converter) = scoped();
            flusher.send(entry(json!({
                "event.name": "llm.request", "event.id": "evt-1", "gen_ai.agent.type": "claude-code"
            })), None).await.unwrap();
            assert!(flusher.inner.state.lock().unwrap().buffers.is_empty());
            assert_eq!(converter.calls.lock().unwrap().len(), 1);
            assert!(converter.calls.lock().unwrap()[0].is_empty());
            // A completed fact also converts immediately, with its source identity intact.
            flusher
                .send(
                    entry(json!({
                        "event.name": "tool.result", "event.id": "evt-completed",
                        "gen_ai.agent.type": "claude-code", "gen_ai.tool.call.id": "tool-1",
                        "gen_ai.tool.name": "Bash", "gen_ai.tool.call.result": "synthetic result",
                        "gen_ai.tool.status": "success"
                    })),
                    None,
                )
                .await
                .unwrap();
            assert!(flusher.inner.state.lock().unwrap().buffers.is_empty());
            assert_eq!(converter.calls.lock().unwrap().len(), 2);
            assert_eq!(converter.calls.lock().unwrap()[1].len(), 1);
            assert_eq!(
                converter.calls.lock().unwrap()[1][0].event_id,
                "evt-completed"
            );
            flusher.shutdown().await.unwrap();
            assert_eq!(converter.calls.lock().unwrap().len(), 2);
        }

        #[test]
        fn destination_counters_keep_the_arms_workspace_and_plain_otlp_identities() {
            let dir = tempfile::tempdir().unwrap();
            let project = "proj-xtrace-1d3dc285e44fcb12fa8cbcb1dd13551-cn-hongkong";
            let url =
                format!("https://{project}.cn-hongkong.log.aliyuncs.com/apm/trace/opentelemetry");
            for (name, endpoint_url, headers, is_cms, expected_project, store) in [
                (
                    "user-cms",
                    url.as_str(),
                    HashMap::from([
                        ("x-arms-license-key".into(), "lk".into()),
                        ("x-arms-project".into(), project.into()),
                    ]),
                    true,
                    project,
                    "logstore-tracing",
                ),
                (
                    "inner-cms-0",
                    url.as_str(),
                    HashMap::from([("X-CMS-Workspace".into(), "ws-1".into())]),
                    true,
                    project,
                    "logstore-tracing",
                ),
                (
                    "user-otlp",
                    "https://collector.example.com/v1/traces",
                    HashMap::from([("authorization".into(), "Bearer t".into())]),
                    false,
                    "",
                    "",
                ),
            ] {
                let mut endpoint = ep(name, endpoint_url);
                endpoint.headers = Some(headers);
                let mut config = cfg(vec![endpoint]);
                config.data_dir = Some(dir.path().to_string_lossy().into_owned());
                let flusher = OtlpTraceFlusher::new(config).unwrap();
                let counter = flusher.endpoint_counters().remove(name).unwrap();
                assert_eq!(counter.is_cms, is_cms);
                assert_eq!(counter.project, expected_project);
                assert_eq!(counter.logstore, store);
            }
        }
    }

    mod migration_export_lifecycle_contracts {
        use super::*;
        use crate::flushers::create_readable_span_to_otlp_span_json_array;
        use std::time::Duration;

        type ExportCalls = Arc<Mutex<Vec<(String, Vec<ReadableSpan>)>>>;
        struct RecordingExporter {
            name: String,
            calls: ExportCalls,
            shutdowns: Arc<AtomicUsize>,
            failure: Option<String>,
        }
        #[async_trait]
        impl TraceExporter for RecordingExporter {
            async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
                self.calls.lock().unwrap().push((self.name.clone(), spans));
                match &self.failure {
                    Some(message) => Err(message.clone()),
                    None => Ok(()),
                }
            }
            async fn shutdown(&self) {
                self.shutdowns.fetch_add(1, Ordering::SeqCst);
            }
        }

        fn factory(
            calls: &ExportCalls,
            shutdowns: &Arc<AtomicUsize>,
            failed_name: Option<&str>,
            message: &str,
        ) -> ExporterFactory {
            let calls = calls.clone();
            let shutdowns = shutdowns.clone();
            let failed_name = failed_name.map(str::to_string);
            let message = message.to_string();
            Arc::new(move |options| {
                Arc::new(RecordingExporter {
                    failure: if failed_name.as_deref() == Some(options.name.as_str()) {
                        Some(message.clone())
                    } else {
                        None
                    },
                    name: options.name,
                    calls: calls.clone(),
                    shutdowns: shutdowns.clone(),
                }) as Arc<dyn TraceExporter>
            })
        }

        fn single(dir: &std::path::Path) -> OtlpTraceFlusherConfig {
            let mut config = cfg(vec![ep("primary", "http://unused:4318")]);
            config.data_dir = Some(dir.to_string_lossy().into_owned());
            config.service_name = "test-pilot".into();
            config
        }

        fn mock_span() -> ReadableSpan {
            let mut span = ReadableSpan::minimal("test-span", &"a".repeat(32), &"b".repeat(16));
            span.start_time = [1000, 0];
            span.end_time = [1001, 0];
            span.attributes
                .insert("gen_ai.agent.type".into(), json!("claude-code"));
            span.resource_attributes = Some(
                serde_json::from_value(json!({"service.name": "test-pilot-claude-code"})).unwrap(),
            );
            span
        }

        #[tokio::test]
        async fn shutdown_drains_a_pending_turn_and_direct_export_bypasses_the_converter() {
            let dir = tempfile::tempdir().unwrap();
            let converter = Arc::new(RecConv {
                calls: Mutex::new(Vec::new()),
            });
            let calls = Arc::new(Mutex::new(Vec::new()));
            let shutdowns = Arc::new(AtomicUsize::new(0));
            let flusher = OtlpTraceFlusher::with_parts(
                single(dir.path()),
                None,
                Some(factory(&calls, &shutdowns, None, "")),
                Some(converter.clone()),
            )
            .unwrap();
            flusher.send(entry(json!({"event.name": "llm.request", "gen_ai.agent.type": "claude-code", "gen_ai.turn.id": "pending-turn"})), None).await.unwrap();
            assert!(converter.calls.lock().unwrap().is_empty());
            flusher.shutdown().await.unwrap();
            assert_eq!(converter.calls.lock().unwrap().len(), 1);

            let converter = Arc::new(RecConv {
                calls: Mutex::new(Vec::new()),
            });
            let flusher = OtlpTraceFlusher::with_parts(
                single(dir.path()),
                None,
                Some(factory(&calls, &shutdowns, None, "")),
                Some(converter.clone()),
            )
            .unwrap();
            flusher
                .export_spans_for_agent("claude-code", vec![mock_span()])
                .await;
            assert!(converter.calls.lock().unwrap().is_empty());
            assert!(flusher.inner.state.lock().unwrap().buffers.is_empty());
            assert_eq!(calls.lock().unwrap().len(), 1);
            assert_eq!(calls.lock().unwrap()[0].1[0].name, "test-span");
            flusher.export_spans_for_agent("codex", Vec::new()).await;
            flusher.shutdown().await.unwrap();
            assert_eq!(shutdowns.load(Ordering::SeqCst), 2);
        }

        #[tokio::test]
        async fn configured_idle_timer_really_flushes_the_stale_turn_once_and_stops_on_shutdown() {
            let dir = tempfile::tempdir().unwrap();
            let converter = Arc::new(RecConv {
                calls: Mutex::new(Vec::new()),
            });
            let mut config = single(dir.path());
            config.turn_idle_timeout_ms = Some(100);
            let flusher =
                OtlpTraceFlusher::with_parts(config, None, None, Some(converter.clone())).unwrap();
            let timer = flusher
                .inner
                .idle
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .abort_handle();
            flusher.send(entry(json!({"event.name": "llm.request", "gen_ai.agent.type": "claude-code", "gen_ai.turn.id": "idle-turn"})), None).await.unwrap();
            assert!(converter.calls.lock().unwrap().is_empty());
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if !converter.calls.lock().unwrap().is_empty() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(converter.calls.lock().unwrap().len(), 1);
            assert!(flusher.inner.state.lock().unwrap().buffers.is_empty());
            flusher.shutdown().await.unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                while !timer.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(converter.calls.lock().unwrap().len(), 1);
        }

        #[tokio::test]
        async fn small_large_and_default_batches_preserve_exact_original_batch_lengths() {
            for (limit, count, large, expected) in [
                (Some(10 * 1024), 10, false, vec![10]),
                (Some(10 * 1024), 5, true, vec![2, 2, 1]),
                (None, 100, false, vec![100]),
            ] {
                let dir = tempfile::tempdir().unwrap();
                let mut config = single(dir.path());
                config.max_export_batch_bytes = limit;
                let calls = Arc::new(Mutex::new(Vec::new()));
                let shutdowns = Arc::new(AtomicUsize::new(0));
                let flusher = OtlpTraceFlusher::with_parts(
                    config,
                    None,
                    Some(factory(&calls, &shutdowns, None, "")),
                    None,
                )
                .unwrap();
                let spans = (0..count)
                    .map(|_| {
                        let mut span = mock_span();
                        if large {
                            span.attributes
                                .insert("gen_ai.input.messages".into(), json!("x".repeat(4096)));
                        }
                        span
                    })
                    .collect();
                flusher.export_spans_for_agent("claude-code", spans).await;
                flusher.shutdown().await.unwrap();
                let lengths: Vec<_> = calls
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(_, spans)| spans.len())
                    .collect();
                assert_eq!(lengths, expected);
                assert_eq!(flusher.created_exporters()[0].compression, "gzip");
            }
        }

        #[tokio::test]
        async fn debug_and_failure_output_matrix_writes_only_the_requested_daily_evidence() {
            let failed_file_name =
                regex::Regex::new(r"^test-pilot-claude-code__primary-\d{4}-\d{2}-\d{2}\.jsonl$")
                    .unwrap();
            for (debug, failure) in [(false, false), (true, false), (false, true), (true, true)] {
                let dir = tempfile::tempdir().unwrap();
                let mut config = single(dir.path());
                config.debug = Some(debug);
                let calls = Arc::new(Mutex::new(Vec::new()));
                let shutdowns = Arc::new(AtomicUsize::new(0));
                let flusher = OtlpTraceFlusher::with_parts(
                    config,
                    None,
                    Some(factory(
                        &calls,
                        &shutdowns,
                        if failure { Some("primary") } else { None },
                        "401 unauthorized",
                    )),
                    None,
                )
                .unwrap();
                flusher
                    .export_spans_for_agent("claude-code", vec![mock_span()])
                    .await;
                flusher.shutdown().await.unwrap();
                assert_eq!(calls.lock().unwrap().len(), 1);
                for (subdir, exists) in [("otlp-debug", debug), ("otlp-failed", failure)] {
                    let path = dir.path().join("logs").join(subdir);
                    assert_eq!(path.exists(), exists);
                    if !exists {
                        continue;
                    }
                    let files: Vec<_> = std::fs::read_dir(&path)
                        .unwrap()
                        .map(|file| file.unwrap().path())
                        .collect();
                    assert_eq!(files.len(), 1);
                    let name = files[0].file_name().unwrap().to_string_lossy();
                    assert!(name.contains("test-pilot-claude-code"));
                    let text = std::fs::read_to_string(&files[0]).unwrap();
                    assert_eq!(text.lines().count(), 1);
                    let record: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
                    assert_eq!(record["name"], "test-span");
                    if subdir == "otlp-failed" {
                        assert!(failed_file_name.is_match(&name));
                        assert_eq!(record["_error"]["message"], "401 unauthorized");
                    }
                }
            }
        }

        #[tokio::test]
        async fn every_backend_exports_once_across_service_groups_and_one_failure_is_isolated() {
            let failed_backend_name =
                regex::Regex::new(r"__backend-b-\d{4}-\d{2}-\d{2}\.jsonl$").unwrap();
            for (distinct, failing) in [(false, false), (true, false), (false, true)] {
                let dir = tempfile::tempdir().unwrap();
                let mut config = single(dir.path());
                config.endpoints = vec![
                    ep("backend-a", "http://a:4318"),
                    ep("backend-b", "http://b:4318"),
                ];
                if distinct {
                    config.endpoints[1].service_name = Some("managed-svc".into());
                }
                let calls = Arc::new(Mutex::new(Vec::new()));
                let shutdowns = Arc::new(AtomicUsize::new(0));
                let flusher = OtlpTraceFlusher::with_parts(
                    config,
                    None,
                    Some(factory(
                        &calls,
                        &shutdowns,
                        if failing { Some("backend-b") } else { None },
                        "503 from b",
                    )),
                    None,
                )
                .unwrap();
                flusher
                    .export_spans_for_agent("claude-code", vec![mock_span()])
                    .await;
                flusher.shutdown().await.unwrap();
                let calls = calls.lock().unwrap();
                assert_eq!(calls.len(), 2);
                for name in ["backend-a", "backend-b"] {
                    let selected: Vec<_> = calls
                        .iter()
                        .filter(|(backend, _)| backend == name)
                        .collect();
                    assert_eq!(selected.len(), 1);
                    assert_eq!(selected[0].1.len(), 1);
                    assert_eq!(selected[0].1[0].name, "test-span");
                    assert_eq!(selected[0].1[0].span_id, "b".repeat(16));
                }
                if distinct {
                    assert_eq!(
                        flusher.resource_attributes(
                            "claude-code",
                            &flusher.endpoint_service_name(0, "claude-code")
                        )["service.name"],
                        "test-pilot-claude-code"
                    );
                    assert_eq!(
                        flusher.resource_attributes(
                            "claude-code",
                            &flusher.endpoint_service_name(1, "claude-code")
                        )["service.name"],
                        "managed-svc-claude-code"
                    );
                }
                if failing {
                    let files: Vec<_> =
                        std::fs::read_dir(dir.path().join("logs").join("otlp-failed"))
                            .unwrap()
                            .map(|file| file.unwrap().file_name().to_string_lossy().into_owned())
                            .collect();
                    assert_eq!(files.len(), 1);
                    assert!(failed_backend_name.is_match(&files[0]));
                    assert!(!files[0].contains("__backend-a-"));
                }
            }
        }

        #[test]
        fn disabled_suffix_keeps_exact_resource_service_for_both_original_agent_types() {
            let dir = tempfile::tempdir().unwrap();
            let mut config = single(dir.path());
            config.service_name = "shared-service".into();
            config.append_agent_type_to_service_name = Some(false);
            let flusher = OtlpTraceFlusher::new(config).unwrap();
            for agent in ["opencode", "codex"] {
                let service = flusher.endpoint_service_name(0, agent);
                let resource = flusher.resource_attributes(agent, &service);
                assert_eq!(resource["service.name"], "shared-service");
                assert_eq!(resource["gen_ai.agent.type"], agent);
            }
        }

        #[tokio::test]
        async fn malicious_backend_name_stays_inside_the_safe_daily_failure_directory() {
            let daily_file_name = regex::Regex::new(r"-\d{4}-\d{2}-\d{2}\.jsonl$").unwrap();
            let dir = tempfile::tempdir().unwrap();
            let mut config = single(dir.path());
            config.endpoints = vec![ep("../../../../tmp/pwn", "http://evil:4318")];
            let calls = Arc::new(Mutex::new(Vec::new()));
            let shutdowns = Arc::new(AtomicUsize::new(0));
            let flusher = OtlpTraceFlusher::with_parts(
                config,
                None,
                Some(factory(
                    &calls,
                    &shutdowns,
                    Some("../../../../tmp/pwn"),
                    "boom",
                )),
                None,
            )
            .unwrap();
            flusher
                .export_spans_for_agent("claude-code", vec![mock_span()])
                .await;
            flusher.shutdown().await.unwrap();
            let failed = dir.path().join("logs").join("otlp-failed");
            let files: Vec<_> = std::fs::read_dir(&failed)
                .unwrap()
                .map(|file| file.unwrap().path())
                .collect();
            assert_eq!(files.len(), 1);
            assert_eq!(files[0].parent(), Some(failed.as_path()));
            let name = files[0].file_name().unwrap().to_string_lossy();
            assert!(!name.contains('/'));
            assert!(name.contains(".._.._.._.._tmp_pwn"));
            assert!(daily_file_name.is_match(&name));
        }

        fn long_turn(turn: &str, count: usize) -> Vec<AgentActivityEntry> {
            let mut records = Vec::new();
            for index in 1..=count {
                for response in [false, true] {
                    records.push(entry(json!({
                        "event.id": format!("{turn}.{index}.{response}"),
                        "time_unix_nano": format!("{}", 1_780_000_000_000_000_000_i64 + index as i64 * 1_000_000 + if response { 100_000 } else { 0 }),
                        "event.name": if response { "llm.response" } else { "llm.request" },
                        "gen_ai.agent.type": "claude-code",
                        "gen_ai.turn.id": turn,
                        "gen_ai.step.id": format!("{turn}.{index}"),
                        "gen_ai.request.model": "claude-test",
                        "gen_ai.response.id": format!("resp-{turn}-{index}"),
                        "gen_ai.response.finish_reasons": if response { if index == count { vec!["stop"] } else { vec!["tool_calls"] } } else { Vec::<&str>::new() }
                    })));
                }
            }
            records
        }

        #[tokio::test]
        async fn four_call_turn_followed_by_short_turn_and_fifty_turn_session_keep_records_and_locks_isolated(
        ) {
            for counts in [vec![4], vec![4, 1], vec![4; 50]] {
                let dir = tempfile::tempdir().unwrap();
                let converter = Arc::new(RecConv {
                    calls: Mutex::new(Vec::new()),
                });
                let flusher = OtlpTraceFlusher::with_parts(
                    single(dir.path()),
                    None,
                    None,
                    Some(converter.clone()),
                )
                .unwrap();
                for (index, count) in counts.iter().enumerate() {
                    for record in long_turn(&format!("turn-{index}"), *count) {
                        flusher.send(record, None).await.unwrap();
                    }
                }
                flusher.flush().await.unwrap();
                {
                    let calls = converter.calls.lock().unwrap();
                    assert_eq!(calls.len(), counts.len());
                    let lengths: Vec<_> = calls.iter().map(Vec::len).collect();
                    assert_eq!(
                        lengths,
                        counts.iter().map(|count| count * 2).collect::<Vec<_>>()
                    );
                    for (index, records) in calls.iter().enumerate() {
                        for record in records {
                            assert_eq!(
                                record.turn_id.as_deref(),
                                Some(format!("turn-{index}").as_str())
                            );
                        }
                    }
                }
                assert!(flusher.inner.state.lock().unwrap().buffers.is_empty());
                {
                    let locks = flusher.inner.convert_locks.lock().unwrap();
                    assert_eq!(locks.len(), 1);
                    for lock in locks.values() {
                        assert!(
                            lock.try_lock().is_ok(),
                            "no unresolved conversion lock after terminal export"
                        );
                    }
                }
                flusher.shutdown().await.unwrap();
            }
        }

        #[tokio::test]
        async fn failed_long_conversion_drops_state_before_the_real_recovery_converter_exports() {
            struct FailOnce {
                calls: AtomicUsize,
            }
            impl EventLogConverter for FailOnce {
                fn convert(
                    &self,
                    records: &[AgentActivityEntry],
                    options: &ConvertOptions,
                ) -> Result<ConvertResult, String> {
                    if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        return Err("conversion failed".into());
                    }
                    super::super::super::event_log_converter::GenAiEventLogConverter
                        .convert(records, options)
                }
            }
            let dir = tempfile::tempdir().unwrap();
            let converter = Arc::new(FailOnce {
                calls: AtomicUsize::new(0),
            });
            let calls = Arc::new(Mutex::new(Vec::new()));
            let shutdowns = Arc::new(AtomicUsize::new(0));
            let flusher = OtlpTraceFlusher::with_parts(
                single(dir.path()),
                None,
                Some(factory(&calls, &shutdowns, None, "")),
                Some(converter.clone()),
            )
            .unwrap();
            for record in long_turn("failed-turn", 4) {
                flusher.send(record, None).await.unwrap();
            }
            flusher.flush().await.unwrap();
            assert_eq!(converter.calls.load(Ordering::SeqCst), 1);
            assert!(calls.lock().unwrap().is_empty());
            {
                let state = flusher.inner.state.lock().unwrap();
                assert_eq!(state.convert_states.len(), 1);
                assert!(state
                    .convert_states
                    .values()
                    .all(|convert| convert.active == 0));
                assert!(state.buffers.is_empty());
            }
            for record in long_turn("recovery-turn", 1) {
                flusher.send(record, None).await.unwrap();
            }
            flusher.flush().await.unwrap();
            assert_eq!(converter.calls.load(Ordering::SeqCst), 2);
            {
                let calls = calls.lock().unwrap();
                assert_eq!(calls.len(), 1);
                assert!(!calls[0].1.is_empty());
                let exported = create_readable_span_to_otlp_span_json_array(&calls[0].1).join("\n");
                assert!(exported.contains("recovery-turn"));
                assert!(!exported.contains("failed-turn"));
            }
            flusher.shutdown().await.unwrap();
        }
    }
    mod legacy_conversion_contracts {
        use super::super::{
            collect_resource_attributes, convert_state_key, enrich_claude,
            enrich_openclaw_llm_attributes, enrich_openclaw_tool_attributes, enrich_tool_skills,
            resource_identity,
        };
        use super::*;
        use crate::flushers::create_readable_span_to_otlp_span_json_array;
        use crate::normalization::{entry_to_object, GlobalAttributesProvider};
        use serde_json::Map;

        type Calls = Vec<(Vec<AgentActivityEntry>, ConvertOptions)>;
        struct Capture {
            calls: Mutex<Calls>,
        }
        impl EventLogConverter for Capture {
            fn convert(
                &self,
                records: &[AgentActivityEntry],
                options: &ConvertOptions,
            ) -> Result<ConvertResult, String> {
                self.calls
                    .lock()
                    .unwrap()
                    .push((records.to_vec(), options.clone()));
                Ok(ConvertResult {
                    warnings: vec!["orphan llm.request".into()],
                    ..Default::default()
                })
            }
        }
        fn configuration(root: &std::path::Path) -> OtlpTraceFlusherConfig {
            let mut config = cfg(vec![ep("primary", "http://unused:4318")]);
            config.service_name = "test-pilot".into();
            config.data_dir = Some(root.to_string_lossy().into_owned());
            config.resource_attributes =
                Some(serde_json::from_value(json!({"custom.attr":"hello"})).unwrap());
            config
        }
        fn capture(
            config: OtlpTraceFlusherConfig,
            provider: Option<Arc<Mutex<GlobalAttributesProvider>>>,
        ) -> (OtlpTraceFlusher, Arc<Capture>) {
            let converter = Arc::new(Capture {
                calls: Mutex::new(Vec::new()),
            });
            let flusher =
                OtlpTraceFlusher::with_parts(config, provider, None, Some(converter.clone()))
                    .unwrap();
            (flusher, converter)
        }
        fn terminal(turn: &str) -> AgentActivityEntry {
            entry(
                json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","gen_ai.turn.id":turn,"gen_ai.response.finish_reasons":["stop"]}),
            )
        }
        fn span(kind: &str, key: Option<(&str, &str)>) -> ReadableSpan {
            let mut span = ReadableSpan::minimal("contract", &"a".repeat(32), &"b".repeat(16));
            span.attributes
                .insert("gen_ai.span.kind".into(), json!(kind));
            if let Some((key, value)) = key {
                span.attributes.insert(key.into(), json!(value));
            }
            span
        }

        #[tokio::test]
        async fn conversion_boundary_keeps_the_pair_default_options_hierarchy_and_zero_span_warning_behavior(
        ) {
            let dir = tempfile::tempdir().unwrap();
            let (flusher, converter) = capture(configuration(dir.path()), None);
            flusher.send(entry(json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","gen_ai.turn.id":"t1"})), None).await.unwrap();
            assert!(converter.calls.lock().unwrap().is_empty());
            flusher.send(terminal("t1"), None).await.unwrap();
            {
                let calls = converter.calls.lock().unwrap();
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].0.len(), 2);
                assert_eq!(
                    calls[0].0[0].event_name,
                    Some(crate::types::AgentEventName::LlmRequest)
                );
                assert_eq!(
                    calls[0].0[1].event_name,
                    Some(crate::types::AgentEventName::LlmResponse)
                );
                assert!(!calls[0].1.strict);
                for key in [
                    "git.repo",
                    "git.branch",
                    "git.domain",
                    "workspace.current_root",
                    "user.name",
                    "user.email",
                    "gen_ai.turn.id",
                    "gen_ai.agent.scope",
                    "gen_ai.agent.depth",
                    "gen_ai.agent.parent.id",
                    "gen_ai.subagent.parent_tool_call.id",
                ] {
                    assert!(
                        calls[0].1.passthrough_keys.contains(&key.to_string()),
                        "{key}"
                    );
                }
            }
            // The injected converter returns a warning and zero spans. No exporter is created.
            assert!(flusher.created_exporters().is_empty());
            flusher.shutdown().await.unwrap();
        }

        #[tokio::test]
        async fn openclaw_identity_reconciles_sender_copies_and_never_overrides_explicit_environment_identity(
        ) {
            for environment in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let (flusher, converter) = capture(configuration(dir.path()), None);
                let early = entry(json!({
                    "event.name":"other","event.id":"early","gen_ai.agent.type":"openclaw",
                    "gen_ai.turn.id":"openclaw-turn","user.id":if environment {"environment-user"} else {"collector-user"},
                    "agent.openclaw.hook":"before_model_resolve","gen_ai.input.messages_delta":[],
                    "agent.openclaw.user.id.source":if environment {"environment"} else {"hostname"}
                }));
                let mut sender = entry_to_object(&early);
                sender.insert("event.id".into(), json!("sender-known"));
                sender.insert("agent.openclaw.hook".into(), json!("before_agent_run"));
                sender.insert("agent.openclaw.sender.id".into(), json!("channel-sender"));
                sender.insert("agent.openclaw.channel".into(), json!("telegram"));
                sender.insert("agent.openclaw.account.id".into(), json!("channel-account"));
                sender.insert(
                    "agent.openclaw.channel.id".into(),
                    json!("channel-conversation"),
                );
                if !environment {
                    sender.insert("user.id".into(), json!("channel-sender"));
                    sender.insert("agent.openclaw.user.id.source".into(), json!("sender"));
                }
                let mut terminal = sender.clone();
                terminal.insert("event.id".into(), json!("terminal"));
                terminal.insert("agent.openclaw.hook".into(), json!("llm_output"));
                flusher
                    .send_batch(
                        vec![
                            early.clone(),
                            entry_from_map(sender),
                            entry_from_map(terminal),
                        ],
                        None,
                    )
                    .await
                    .unwrap();
                {
                    let calls = converter.calls.lock().unwrap();
                    assert_eq!(calls.len(), 1);
                    assert!(!calls[0].0.is_empty());
                    for record in &calls[0].0 {
                        assert_eq!(
                            record.user_id,
                            if environment {
                                "environment-user"
                            } else {
                                "channel-sender"
                            }
                        );
                        if !environment {
                            for (key, value) in [
                                ("agent.openclaw.user.id.source", "sender"),
                                ("agent.openclaw.sender.id", "channel-sender"),
                                ("agent.openclaw.channel", "telegram"),
                                ("agent.openclaw.account.id", "channel-account"),
                                ("agent.openclaw.channel.id", "channel-conversation"),
                            ] {
                                assert_eq!(record.get(key), Some(&json!(value)));
                            }
                        }
                    }
                    assert_eq!(
                        early.user_id,
                        if environment {
                            "environment-user"
                        } else {
                            "collector-user"
                        }
                    );
                    assert_eq!(
                        early.get("agent.openclaw.user.id.source"),
                        Some(&json!(if environment {
                            "environment"
                        } else {
                            "hostname"
                        }))
                    );
                }
                flusher.shutdown().await.unwrap();
            }
        }

        #[test]
        fn hook_resource_projection_and_explicit_pi_identity_keep_exact_values_and_drop_secrets() {
            let dir = tempfile::tempdir().unwrap();
            let (flusher, _) = capture(configuration(dir.path()), None);
            let records = vec![
                entry(
                    json!({"resourceAttributes":{"agentteams.worker.name":" local-worker ","agentteams.instance.id":"example-instance","agentteams.token":"should-not-leak"}}),
                ),
                entry(json!({"resourceAttributes":{"agentteams.worker.name":"other-worker"}})),
            ];
            let attrs = collect_resource_attributes(&flusher.inner, &records);
            assert_eq!(attrs, serde_json::from_value::<Map<String, Value>>(json!({
                "agentteams.worker.name":"local-worker","agentteams.instance.id":"example-instance"
            })).unwrap());
            let resource = flusher.inner.build_resource(
                "claude-code",
                "test-pilot",
                &attrs,
                "claude-code",
                "claude",
            );
            assert_eq!(resource["custom.attr"], "hello");
            assert_eq!(resource["agentteams.worker.name"], "local-worker");
            assert_eq!(resource["agentteams.instance.id"], "example-instance");
            assert!(!resource.contains_key("agentteams.token"));
            let identity_records = vec![entry(
                json!({"gen_ai.agent.system":"pi","gen_ai.framework":"pi-coding-agent"}),
            )];
            let (system, framework) = resource_identity("acme-code", &identity_records);
            let resource = flusher.inner.build_resource(
                "acme-code",
                "test-pilot",
                &Map::new(),
                &framework,
                &system,
            );
            assert_eq!(resource["gen_ai.agent.type"], "acme-code");
            assert_eq!(resource["gen_ai.agent.system"], "pi");
            assert_eq!(resource["gen_ai.framework"], "pi-coding-agent");
        }

        #[tokio::test]
        async fn seventy_real_resource_conversions_evict_the_first_state_and_keep_the_last_below_the_cap(
        ) {
            let dir = tempfile::tempdir().unwrap();
            let (flusher, converter) = capture(configuration(dir.path()), None);
            for index in 0..70 {
                let mut record = terminal(&format!("turn-{index}"));
                record.resource_attributes = Some(
                    serde_json::from_value(
                        json!({"agentteams.worker.name":format!("worker-{index}")}),
                    )
                    .unwrap(),
                );
                flusher.send(record, None).await.unwrap();
            }
            assert_eq!(converter.calls.lock().unwrap().len(), 70);
            let service = flusher.endpoint_service_name(0, "claude-code");
            let first = convert_state_key(
                "claude-code",
                &service,
                &serde_json::from_value(json!({"agentteams.worker.name":"worker-0"})).unwrap(),
            );
            let last = convert_state_key(
                "claude-code",
                &service,
                &serde_json::from_value(json!({"agentteams.worker.name":"worker-69"})).unwrap(),
            );
            {
                let state = flusher.inner.state.lock().unwrap();
                assert!(state.convert_states.len() <= 64);
                assert!(!state.convert_states.contains_key(&first));
                assert!(state.convert_states.contains_key(&last));
            }
            flusher.shutdown().await.unwrap();
        }

        #[tokio::test]
        async fn global_attributes_are_fill_only_record_copies_and_prefix_passthrough_never_admits_reserved_keys(
        ) {
            for local in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let baseline =
                    serde_json::from_value::<Map<String, Value>>(json!({"team":"infra"})).unwrap();
                let provider = Arc::new(Mutex::new(GlobalAttributesProvider::new(
                    &baseline,
                    dir.path().join("missing-span-attributes.json"),
                )));
                let (flusher, converter) = capture(configuration(dir.path()), Some(provider));
                let mut original = terminal("custom-turn");
                if local {
                    original.extra.insert("team".into(), json!("local"));
                }
                flusher.send(original.clone(), None).await.unwrap();
                {
                    let calls = converter.calls.lock().unwrap();
                    assert_eq!(calls.len(), 1);
                    assert_eq!(
                        calls[0].0[0].get("team"),
                        Some(&json!(if local { "local" } else { "infra" }))
                    );
                    assert!(calls[0].1.passthrough_keys.contains(&"team".into()));
                    assert!(calls[0].1.passthrough_keys.contains(&"git.repo".into()));
                    assert_eq!(
                        original.get("team").cloned(),
                        if local { Some(json!("local")) } else { None }
                    );
                }
                flusher.shutdown().await.unwrap();
            }
            for prefixes in [
                Vec::new(),
                vec!["multica.".to_string()],
                vec!["gen_ai.".to_string()],
            ] {
                let dir = tempfile::tempdir().unwrap();
                let mut config = configuration(dir.path());
                config.span_attribute_passthrough_prefixes = Some(prefixes.clone());
                let (flusher, converter) = capture(config, None);
                let mut record = terminal("prefix-turn");
                for (key, value) in [
                    ("multica.issue.id", "AGE-992"),
                    ("multica.user.id", "staff"),
                    ("other.key", "ignored"),
                    ("gen_ai.unapproved.attribute", "ignored"),
                ] {
                    record.extra.insert(key.into(), json!(value));
                }
                flusher.send(record, None).await.unwrap();
                {
                    let calls = converter.calls.lock().unwrap();
                    let keys = &calls[0].1.passthrough_keys;
                    let enabled = prefixes.first().map(String::as_str) == Some("multica.");
                    assert_eq!(keys.contains(&"multica.issue.id".into()), enabled);
                    assert_eq!(keys.contains(&"multica.user.id".into()), enabled);
                    assert!(!keys.contains(&"other.key".into()));
                    assert!(!keys.contains(&"gen_ai.unapproved.attribute".into()));
                    for key in [
                        "git.repo",
                        "gen_ai.turn.id",
                        "gen_ai.agent.scope",
                        "gen_ai.agent.depth",
                        "gen_ai.agent.parent.id",
                        "gen_ai.subagent.parent_tool_call.id",
                    ] {
                        assert!(keys.contains(&key.to_string()));
                    }
                }
                flusher.shutdown().await.unwrap();
            }
        }

        #[test]
        fn skill_attributes_only_reach_the_matching_tool_and_claude_errors_stay_on_the_exact_llm() {
            let records = vec![
                entry(
                    json!({"event.name":"tool.call","gen_ai.tool.call.id":"skill-call-1","gen_ai.skill.name":"dogfood","gen_ai.skill.id":"dogfood"}),
                ),
                entry(
                    json!({"event.name":"tool.result","gen_ai.tool.call.id":"skill-call-1","gen_ai.skill.description":"Exploratory QA for web apps.","gen_ai.skill.version":"1.0.0"}),
                ),
            ];
            let mut spans = vec![
                span("TOOL", Some(("gen_ai.tool.call.id", "skill-call-1"))),
                span("LLM", Some(("gen_ai.tool.call.id", "skill-call-1"))),
            ];
            enrich_tool_skills(&records, &mut spans);
            for (key, value) in [
                ("gen_ai.skill.name", "dogfood"),
                ("gen_ai.skill.id", "dogfood"),
                ("gen_ai.skill.description", "Exploratory QA for web apps."),
                ("gen_ai.skill.version", "1.0.0"),
            ] {
                assert_eq!(spans[0].attributes[key], value);
            }
            assert!(!spans[1].attributes.contains_key("gen_ai.skill.name"));
            let records = vec![
                entry(
                    json!({"event.name":"llm.response","gen_ai.response.id":"retry-response-1","gen_ai.request.id":"req-1","gen_ai.response.finish_reasons":["error"],"http.response.status_code":529,"error.type":"overloaded_error"}),
                ),
                entry(
                    json!({"event.name":"llm.response","gen_ai.response.id":"success-response-2","gen_ai.request.id":"req-2","gen_ai.response.finish_reasons":["stop"]}),
                ),
            ];
            let mut spans = vec![
                span("LLM", Some(("gen_ai.response.id", "retry-response-1"))),
                span("LLM", Some(("gen_ai.response.id", "success-response-2"))),
                span("AGENT", None),
                span("ENTRY", None),
            ];
            enrich_claude(&records, &mut spans);
            assert_eq!(spans[0].attributes["gen_ai.request.id"], "req-1");
            assert_eq!(spans[0].attributes["http.response.status_code"], 529);
            assert_eq!(spans[0].attributes["error.type"], "overloaded_error");
            assert!(!spans[0].attributes.contains_key("error.message"));
            assert_eq!(spans[0].status["code"], 2);
            assert_eq!(spans[1].attributes["gen_ai.request.id"], "req-2");
            for span in &spans[1..] {
                assert_eq!(span.status["code"], 0);
            }
            let records = vec![entry(
                json!({"event.name":"llm.response","gen_ai.response.id":"terminal-error","gen_ai.turn.end":true,"error.type":"server_error"}),
            )];
            let mut spans = vec![
                span("LLM", Some(("gen_ai.response.id", "terminal-error"))),
                span("AGENT", None),
                span("AGENT", None),
                span("ENTRY", None),
            ];
            enrich_claude(&records, &mut spans);
            assert_eq!(spans[0].status["code"], 2);
            assert_eq!(spans[0].attributes["error.type"], "server_error");
            for span in &spans[1..] {
                assert_eq!(span.status["code"], 0);
                assert!(!span.attributes.contains_key("error.type"));
            }
        }

        #[test]
        fn openclaw_reasoning_aggregates_matched_llms_and_tool_failure_status_is_case_insensitive()
        {
            let records = vec![
                entry(
                    json!({"event.name":"llm.response","gen_ai.response.id":"provider-response-1","gen_ai.usage.reasoning_tokens":59,"error.type":"model_call_error"}),
                ),
                entry(
                    json!({"event.name":"llm.response","gen_ai.response.id":"provider-response-2","gen_ai.usage.reasoning_tokens":22}),
                ),
            ];
            let mut spans = vec![
                span("LLM", Some(("gen_ai.response.id", "provider-response-1"))),
                span("LLM", Some(("gen_ai.response.id", "provider-response-2"))),
                span("AGENT", None),
            ];
            enrich_openclaw_llm_attributes(&records, &mut spans);
            assert_eq!(spans[0].attributes["gen_ai.usage.reasoning_tokens"], 59);
            assert_eq!(spans[0].attributes["error.type"], "model_call_error");
            assert_eq!(spans[0].status["code"], 2);
            assert_eq!(spans[0].status["message"], "OpenClaw model call failed");
            assert_eq!(spans[1].attributes["gen_ai.usage.reasoning_tokens"], 22);
            assert_eq!(spans[1].status["code"], 0);
            assert_eq!(
                spans[2].attributes["gen_ai.usage.reasoning_tokens"].as_i64(),
                Some(81)
            );
            assert_eq!(spans[2].status["code"], 0);

            for status in ["failure", "error", "ERROR"] {
                let records = vec![
                    entry(
                        json!({"event.name":"tool.result","gen_ai.tool.call.id":"failed-tool-1","tool.result.status":status,"error.type":"tool_use_failure","error.message":"command exited with code 7"}),
                    ),
                    entry(
                        json!({"event.name":"tool.result","gen_ai.tool.call.id":"successful-tool-1","tool.result.status":"success"}),
                    ),
                ];
                let mut spans = vec![
                    span("TOOL", Some(("gen_ai.tool.call.id", "failed-tool-1"))),
                    span("TOOL", Some(("gen_ai.tool.call.id", "successful-tool-1"))),
                ];
                enrich_openclaw_tool_attributes(&records, &mut spans);
                assert_eq!(spans[0].attributes["tool.result.status"], status);
                assert_eq!(spans[0].attributes["error.type"], "tool_use_failure");
                assert_eq!(
                    spans[0].attributes["error.message"],
                    "command exited with code 7"
                );
                assert_eq!(spans[0].status["code"], 2);
                assert_eq!(spans[0].status["message"], "command exited with code 7");
                assert_eq!(spans[1].attributes["tool.result.status"], "success");
                assert_eq!(spans[1].status["code"], 0);
            }
            let records = vec![entry(
                json!({"event.name":"tool.result","gen_ai.tool.call.id":"status-only","tool.result.status":"ErRoR"}),
            )];
            let mut spans = vec![span("TOOL", Some(("gen_ai.tool.call.id", "status-only")))];
            enrich_openclaw_tool_attributes(&records, &mut spans);
            assert_eq!(spans[0].status["code"], 2);
            assert_eq!(spans[0].status["message"], "OpenClaw tool call failed");
        }

        #[tokio::test]
        async fn complete_llm_and_tool_pairs_survive_the_real_flusher_boundary_as_all_four_records()
        {
            let dir = tempfile::tempdir().unwrap();
            let (flusher, converter) = capture(configuration(dir.path()), None);
            for fields in [
                json!({"event.name":"llm.request","gen_ai.agent.type":"claude-code","gen_ai.turn.id":"t6","gen_ai.step.id":"t6:s1"}),
                json!({"event.name":"tool.call","gen_ai.agent.type":"claude-code","gen_ai.turn.id":"t6","gen_ai.step.id":"t6:s1","gen_ai.tool.call.id":"call_ok"}),
                json!({"event.name":"tool.result","gen_ai.agent.type":"claude-code","gen_ai.turn.id":"t6","gen_ai.step.id":"t6:s1","gen_ai.tool.call.id":"call_ok"}),
                json!({"event.name":"llm.response","gen_ai.agent.type":"claude-code","gen_ai.turn.id":"t6","gen_ai.step.id":"t6:s1","gen_ai.response.finish_reasons":["stop"]}),
            ] {
                flusher.send(entry(fields), None).await.unwrap();
            }
            {
                let calls = converter.calls.lock().unwrap();
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].0.len(), 4);
            }
            flusher.shutdown().await.unwrap();
        }

        #[tokio::test]
        async fn real_openclaw_converter_exports_the_agent_reasoning_sum_and_status_only_tool_error(
        ) {
            struct Exported(Arc<Mutex<Vec<ReadableSpan>>>);
            #[async_trait]
            impl TraceExporter for Exported {
                async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
                    self.0.lock().unwrap().extend(spans);
                    Ok(())
                }
                async fn shutdown(&self) {}
            }
            let dir = tempfile::tempdir().unwrap();
            let exported = Arc::new(Mutex::new(Vec::new()));
            let sink = exported.clone();
            let flusher = OtlpTraceFlusher::with_parts(
                configuration(dir.path()),
                None,
                Some(Arc::new(move |_| {
                    Arc::new(Exported(sink.clone())) as Arc<dyn TraceExporter>
                })),
                None,
            )
            .unwrap();
            let payloads = [
                json!({"event.name":"llm.request","gen_ai.step.id":"step-1","gen_ai.response.id":"provider-response-1","gen_ai.request.model":"model"}),
                json!({"event.name":"llm.response","gen_ai.step.id":"step-1","gen_ai.response.id":"provider-response-1","gen_ai.response.finish_reasons":["tool_calls"],"gen_ai.usage.reasoning_tokens":59,"error.type":"model_call_error"}),
                json!({"event.name":"tool.call","gen_ai.step.id":"step-1","gen_ai.tool.call.id":"status-only-tool","gen_ai.tool.name":"shell"}),
                json!({"event.name":"tool.result","gen_ai.step.id":"step-1","gen_ai.tool.call.id":"status-only-tool","tool.result.status":"ErRoR"}),
                json!({"event.name":"llm.request","gen_ai.step.id":"step-2","gen_ai.response.id":"provider-response-2","gen_ai.request.model":"model"}),
                json!({"event.name":"llm.response","gen_ai.step.id":"step-2","gen_ai.response.id":"provider-response-2","gen_ai.response.finish_reasons":["stop"],"gen_ai.usage.reasoning_tokens":22}),
                json!({"event.name":"other","agent.openclaw.hook":"llm_output"}),
            ];
            let records = payloads
                .into_iter()
                .enumerate()
                .map(|(index, payload)| {
                    let mut object = payload.as_object().unwrap().clone();
                    object.insert("event.id".into(), json!(format!("native-{index}")));
                    object.insert(
                        "time_unix_nano".into(),
                        json!((1_780_000_000_000_000_000_i64 + index as i64 * 100_000_000)
                            .to_string()),
                    );
                    object.insert("trace_id".into(), json!("4bf92f3577b34da6a3ce929d0e0e4736"));
                    object.insert("gen_ai.agent.type".into(), json!("openclaw"));
                    object.insert("gen_ai.session.id".into(), json!("real-session"));
                    object.insert("gen_ai.turn.id".into(), json!("real-openclaw"));
                    entry_from_map(object)
                })
                .collect();
            flusher.send_batch(records, None).await.unwrap();
            flusher.shutdown().await.unwrap();
            let spans = exported.lock().unwrap();
            assert!(!spans.is_empty());
            let agent = spans
                .iter()
                .find(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!("AGENT")))
                .unwrap();
            assert_eq!(
                agent.attributes["gen_ai.usage.reasoning_tokens"].as_i64(),
                Some(81)
            );
            assert_eq!(agent.status["code"], 0);

            // Inspect actual debug JSON and encoded/decoded OTLP wire variants,
            // rather than coercing both integer and float through as_f64.
            assert_reasoning_wire_kind(&spans, 81, [59, 22]);
            let llms: Vec<_> = spans
                .iter()
                .filter(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
                .collect();
            assert_eq!(llms.len(), 2);
            let failed = llms
                .iter()
                .find(|span| {
                    span.attributes.get("gen_ai.response.id") == Some(&json!("provider-response-1"))
                })
                .unwrap();
            assert_eq!(failed.attributes["gen_ai.usage.reasoning_tokens"], 59);
            assert_eq!(failed.status["code"], 2);
            assert_eq!(failed.status["message"], "OpenClaw model call failed");
            let tool = spans
                .iter()
                .find(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!("TOOL")))
                .unwrap();
            assert_eq!(tool.attributes["tool.result.status"], "ErRoR");
            assert_eq!(tool.status["code"], 2);
            assert_eq!(tool.status["message"], "OpenClaw tool call failed");
        }

        #[tokio::test]
        async fn agent_input_is_excluded_only_from_the_actual_converter_call_and_native_context_is_explicit(
        ) {
            let dir = tempfile::tempdir().unwrap();
            let (flusher, converter) = capture(configuration(dir.path()), None);
            let source = entry(json!({
                "time_unix_nano":"1700000000000000000","event.id":"input-other","event.name":"other",
                "user.id":"user-1","gen_ai.session.id":"session-1","gen_ai.agent.type":"claude-code",
                "gen_ai.provider.name":"anthropic","gen_ai.turn.id":"dual-write-turn",
                "gen_ai.input.messages_delta":[{"role":"user","content":"hello"}]
            }));
            let mut finish = entry_to_object(&source);
            finish.insert("time_unix_nano".into(), json!("1700000001000000000"));
            finish.insert("event.id".into(), json!("terminal"));
            finish.insert("event.name".into(), json!("llm.response"));
            finish.insert("gen_ai.response.finish_reasons".into(), json!(["stop"]));
            finish.remove("gen_ai.input.messages_delta");
            let mut records = crate::normalization::expand_agent_input_events(vec![source]);
            assert_eq!(records.len(), 2);
            assert_eq!(
                records[1].event_name,
                Some(crate::types::AgentEventName::AgentInput)
            );
            records.push(entry_from_map(finish));
            flusher.send_batch(records, None).await.unwrap();
            {
                let calls = converter.calls.lock().unwrap();
                assert_eq!(calls.len(), 1);
                assert_eq!(
                    calls[0]
                        .0
                        .iter()
                        .map(|record| record.event_name)
                        .collect::<Vec<_>>(),
                    [
                        Some(crate::types::AgentEventName::Other),
                        Some(crate::types::AgentEventName::LlmResponse)
                    ]
                );
            }
            flusher.shutdown().await.unwrap();
            let (flusher, converter) = capture(configuration(dir.path()), None);
            for index in 0..2 {
                flusher.send(entry(json!({
                    "event.name":"other","gen_ai.agent.type":"codex","gen_ai.turn.id":format!("t2-{index}"),
                    "agent.codex.turn_status":"completed","gen_ai.turn.end":true
                })),None).await.unwrap();
            }
            assert_eq!(converter.calls.lock().unwrap().len(), 2);
            {
                let state = flusher.inner.state.lock().unwrap();
                assert_eq!(state.convert_states.len(), 1);
                assert!(state.convert_states.values().all(|state| state.active == 0));
            }
            flusher.shutdown().await.unwrap();
        }

        fn assert_reasoning_wire_kind(
            spans: &[ReadableSpan],
            expected_agent: i64,
            expected_llms: [i64; 2],
        ) {
            use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
            use opentelemetry_proto::tonic::common::v1::any_value;
            use prost::Message;
            let json: Vec<Value> = create_readable_span_to_otlp_span_json_array(spans)
                .iter()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            let agent = json
                .iter()
                .find(|span| span["attributes"]["gen_ai.span.kind"] == "AGENT")
                .unwrap();
            assert_eq!(
                agent["attributes"]["gen_ai.usage.reasoning_tokens"],
                json!(expected_agent)
            );
            assert_eq!(
                agent["attributes"]["gen_ai.usage.reasoning_tokens"].as_i64(),
                Some(expected_agent)
            );
            let encoded = crate::flushers::otlp_http_exporter::encode_request(spans)
                .unwrap()
                .encode_to_vec();
            let request = ExportTraceServiceRequest::decode(encoded.as_slice()).unwrap();
            let wire: Vec<_> = request
                .resource_spans
                .iter()
                .flat_map(|resource| resource.scope_spans.iter())
                .flat_map(|scope| scope.spans.iter())
                .collect();
            let attribute = |span: &opentelemetry_proto::tonic::trace::v1::Span, key: &str| {
                span.attributes
                    .iter()
                    .find(|attribute| attribute.key == key)
                    .unwrap()
                    .value
                    .as_ref()
                    .unwrap()
                    .value
                    .clone()
                    .unwrap()
            };
            let agent = wire
                .iter()
                .find(|span| {
                    attribute(span, "gen_ai.span.kind")
                        == any_value::Value::StringValue("AGENT".into())
                })
                .unwrap();
            assert_eq!(
                attribute(agent, "gen_ai.usage.reasoning_tokens"),
                any_value::Value::IntValue(expected_agent)
            );
            let mut llm_counts: Vec<_> = wire
                .iter()
                .filter(|span| {
                    attribute(span, "gen_ai.span.kind")
                        == any_value::Value::StringValue("LLM".into())
                })
                .map(
                    |span| match attribute(span, "gen_ai.usage.reasoning_tokens") {
                        any_value::Value::IntValue(value) => value,
                        other => panic!("reasoning token lost its integer wire kind: {other:?}"),
                    },
                )
                .collect();
            llm_counts.sort_unstable();
            let mut expected_llms = expected_llms;
            expected_llms.sort_unstable();
            assert_eq!(llm_counts, expected_llms);
        }

        #[test]
        fn openclaw_aggregate_number_kind_matches_the_original_js_sdk_for_integer_and_fractional_sums(
        ) {
            use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
            use opentelemetry_proto::tonic::common::v1::any_value;
            use prost::Message;
            let oracle: Value = serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/openclaw-sdk-number-kind-oracle.json"
            )))
            .unwrap();
            for case in oracle["cases"].as_array().unwrap() {
                let mut spans = vec![
                    span("LLM", Some(("gen_ai.response.id", "r0"))),
                    span("LLM", Some(("gen_ai.response.id", "r1"))),
                    span("AGENT", None),
                ];
                let records:Vec<_>=case["input"].as_array().unwrap().iter().enumerate().map(|(index,value)|entry(json!({
                    "event.name":"llm.response","gen_ai.response.id":format!("r{index}"),"gen_ai.usage.reasoning_tokens":value
                }))).collect();
                enrich_openclaw_llm_attributes(&records, &mut spans);
                let value = &spans[2].attributes["gen_ai.usage.reasoning_tokens"];
                let expected = &case["anyValue"];
                if let Some(integer) = expected.get("intValue").and_then(Value::as_i64) {
                    assert_eq!(value.as_i64(), Some(integer), "{case}");
                } else {
                    assert!(value.is_f64(), "{case}");
                    assert_eq!(value.as_f64(), expected["doubleValue"].as_f64(), "{case}");
                }
                let lines = create_readable_span_to_otlp_span_json_array(&spans);
                let actual_json: Value = serde_json::from_str(&lines[2]).unwrap();
                assert_eq!(
                    actual_json["attributes"]["gen_ai.usage.reasoning_tokens"], case["total"],
                    "{case}"
                );
                let bytes = crate::flushers::otlp_http_exporter::encode_request(&spans)
                    .unwrap()
                    .encode_to_vec();
                let request = ExportTraceServiceRequest::decode(bytes.as_slice()).unwrap();
                let agent = request
                    .resource_spans
                    .iter()
                    .flat_map(|resource| resource.scope_spans.iter())
                    .flat_map(|scope| scope.spans.iter())
                    .find(|span| {
                        span.attributes.iter().any(|attribute| {
                            attribute.key == "gen_ai.span.kind"
                                && attribute
                                    .value
                                    .as_ref()
                                    .and_then(|value| value.value.as_ref())
                                    == Some(&any_value::Value::StringValue("AGENT".into()))
                        })
                    })
                    .unwrap();
                let wire = agent
                    .attributes
                    .iter()
                    .find(|attribute| attribute.key == "gen_ai.usage.reasoning_tokens")
                    .unwrap()
                    .value
                    .as_ref()
                    .unwrap()
                    .value
                    .as_ref()
                    .unwrap();
                if let Some(integer) = expected.get("intValue").and_then(Value::as_i64) {
                    assert_eq!(wire, &any_value::Value::IntValue(integer), "{case}");
                } else {
                    assert_eq!(
                        wire,
                        &any_value::Value::DoubleValue(expected["doubleValue"].as_f64().unwrap()),
                        "{case}"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod legacy_failed_log_contracts {
    use super::*;
    use chrono::TimeZone;

    fn span() -> ReadableSpan {
        let mut span = ReadableSpan::minimal("failed-span", &"a".repeat(32), &"b".repeat(16));
        span.start_time = [1000, 0];
        span.end_time = [1001, 0];
        span.duration = [1, 0];
        span.attributes
            .insert("gen_ai.agent.type".into(), serde_json::json!("claude-code"));
        span.attributes.insert(
            "gen_ai.input.messages".into(),
            serde_json::json!("diagnostic payload"),
        );
        span.status.insert("code".into(), Value::from(2));
        span.status
            .insert("message".into(), Value::String("failed".into()));
        span.resource_attributes = Some(
            serde_json::from_value(serde_json::json!({"service.name":"test-pilot-claude-code"}))
                .unwrap(),
        );
        span
    }
    fn flusher(root: &std::path::Path, name: &str) -> OtlpTraceFlusher {
        let config: OtlpTraceFlusherConfig = serde_json::from_value(serde_json::json!({
            "enabled":true,"protocol":"http/protobuf","serviceName":"test-pilot","dataDir":root,
            "turnIdleTimeoutMs":0,"endpoints":[{"name":name,"endpoint":"http://unused:4318"}]
        }))
        .unwrap();
        OtlpTraceFlusher::new(config).unwrap()
    }
    fn files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(root.join("logs").join("otlp-failed"))
            .unwrap()
            .map(|file| file.unwrap().path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "jsonl")
            })
            .collect()
    }

    #[tokio::test]
    async fn complete_error_object_and_diagnostic_span_stay_in_one_safe_daily_file() {
        let root = tempfile::tempdir().unwrap();
        let flusher = flusher(root.path(), "../../../../tmp/pwn");
        flusher
            .inner
            .write_failed_log_at(
                "claude-code",
                "../../../../tmp/pwn",
                &[span()],
                2,
                "connection refused",
                Some(Local::now()),
            )
            .await;
        let files = files(root.path());
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].parent(),
            Some(root.path().join("logs").join("otlp-failed").as_path())
        );
        let name = files[0].file_name().unwrap().to_string_lossy();
        assert!(name.contains("__.._.._.._.._tmp_pwn-"));
        assert!(!name.contains('/'));
        assert!(Regex::new(r"-\d{4}-\d{2}-\d{2}\.jsonl$")
            .unwrap()
            .is_match(&name));
        let text = std::fs::read_to_string(&files[0]).unwrap();
        assert_eq!(text.lines().count(), 1);
        let record: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(
            record["_error"],
            serde_json::json!({"code":2,"message":"connection refused"})
        );
        assert_eq!(record["name"], "failed-span");
        assert!(text.contains("diagnostic payload"));
    }

    #[tokio::test]
    async fn a_fresh_legacy_fixed_file_remains_untouched_when_daily_evidence_is_written() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("logs").join("otlp-failed");
        std::fs::create_dir_all(&folder).unwrap();
        let legacy = folder.join("test-pilot-claude-code__primary.jsonl");
        std::fs::write(&legacy, "legacy\n").unwrap();
        let flusher = flusher(root.path(), "primary");
        flusher
            .inner
            .write_failed_log_at(
                "claude-code",
                "primary",
                &[span()],
                2,
                "failed",
                Some(Local::now()),
            )
            .await;
        assert_eq!(std::fs::read_to_string(&legacy).unwrap(), "legacy\n");
        let files = files(root.path());
        assert_eq!(files.len(), 2);
        let daily = Regex::new(r"-\d{4}-\d{2}-\d{2}\.jsonl$").unwrap();
        assert!(files
            .iter()
            .any(|path| daily.is_match(&path.file_name().unwrap().to_string_lossy())));
    }

    #[tokio::test]
    async fn local_midnight_rollover_uses_two_daily_files_and_preserves_each_error() {
        let root = tempfile::tempdir().unwrap();
        let flusher = flusher(root.path(), "primary");
        let before = Local
            .with_ymd_and_hms(2026, 8, 20, 23, 59, 0)
            .single()
            .unwrap();
        let after = Local
            .with_ymd_and_hms(2026, 8, 21, 0, 1, 0)
            .single()
            .unwrap();
        flusher
            .inner
            .write_failed_log_at(
                "claude-code",
                "primary",
                &[span()],
                2,
                "first day",
                Some(before),
            )
            .await;
        flusher
            .inner
            .write_failed_log_at(
                "claude-code",
                "primary",
                &[span()],
                2,
                "second day",
                Some(after),
            )
            .await;
        let files = files(root.path());
        assert_eq!(files.len(), 2);
        for (suffix, message) in [
            ("-2026-08-20.jsonl", "first day"),
            ("-2026-08-21.jsonl", "second day"),
        ] {
            let file = files
                .iter()
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .ends_with(suffix)
                })
                .unwrap();
            let text = std::fs::read_to_string(file).unwrap();
            assert_eq!(text.lines().count(), 1);
            let record: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
            assert_eq!(
                record["_error"],
                serde_json::json!({"code":2,"message":message})
            );
        }
    }
}

#[cfg(test)]
mod legacy_concurrent_subagent_contracts {
    use super::*;

    struct Capture(Mutex<Vec<Vec<AgentActivityEntry>>>);
    impl Capture {
        fn calls(&self) -> Vec<Vec<AgentActivityEntry>> {
            self.0.lock().unwrap().clone()
        }
    }
    impl EventLogConverter for Capture {
        fn convert(
            &self,
            records: &[AgentActivityEntry],
            _options: &ConvertOptions,
        ) -> Result<ConvertResult, String> {
            self.0.lock().unwrap().push(records.to_vec());
            Ok(ConvertResult::default())
        }
    }
    fn entry(fields: Value) -> AgentActivityEntry {
        let mut object = serde_json::json!({
            "event.name":"llm.response","gen_ai.agent.type":"mimo-code",
            "trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"
        })
        .as_object()
        .unwrap()
        .clone();
        object.extend(fields.as_object().unwrap().clone());
        entry_from_map(object)
    }
    fn setup() -> (tempfile::TempDir, OtlpTraceFlusher, Arc<Capture>) {
        let root = tempfile::tempdir().unwrap();
        let config:OtlpTraceFlusherConfig=serde_json::from_value(serde_json::json!({
            "enabled":true,"protocol":"http/protobuf","serviceName":"test-pilot","dataDir":root.path(),
            "turnIdleTimeoutMs":0,"endpoints":[{"name":"primary","endpoint":"http://unused:4318","headers":{"x-test":"1"}}]
        })).unwrap();
        let capture = Arc::new(Capture(Mutex::new(Vec::new())));
        let flusher =
            OtlpTraceFlusher::with_parts(config, None, None, Some(capture.clone())).unwrap();
        (root, flusher, capture)
    }
    async fn send(flusher: &OtlpTraceFlusher, fields: Value) {
        flusher.send(entry(fields), None).await.unwrap();
    }

    #[tokio::test]
    async fn different_session_subagent_never_splits_the_main_turn_before_its_own_completion() {
        let (_root, flusher, capture) = setup();
        let main = serde_json::json!({"gen_ai.turn.id":"main-session:t1","gen_ai.session.id":"main-session","trace_id":"aaaa2f3577b34da6a3ce929d0e0e4736"});
        let sub = serde_json::json!({"gen_ai.turn.id":"sub-session:t1","gen_ai.session.id":"sub-session","trace_id":"bbbb2f3577b34da6a3ce929d0e0e4736"});
        for (fields, events) in [
            (
                &main,
                vec![
                    serde_json::json!({"event.name":"other"}),
                    serde_json::json!({"event.name":"llm.request","gen_ai.step.id":"main-session:t1:s1"}),
                    serde_json::json!({"event.name":"llm.response","gen_ai.step.id":"main-session:t1:s1","gen_ai.response.finish_reasons":["tool_call"]}),
                ],
            ),
            (
                &sub,
                vec![
                    serde_json::json!({"event.name":"other"}),
                    serde_json::json!({"event.name":"llm.request","gen_ai.step.id":"sub-session:t1:s1"}),
                ],
            ),
        ] {
            for event in events {
                let mut object = fields.as_object().unwrap().clone();
                object.extend(event.as_object().unwrap().clone());
                send(&flusher, Value::Object(object)).await;
            }
            assert!(capture.calls().is_empty());
        }
        let mut object = sub.as_object().unwrap().clone();
        object.extend(serde_json::json!({"event.name":"llm.response","gen_ai.step.id":"sub-session:t1:s1","gen_ai.response.finish_reasons":["stop"]}).as_object().unwrap().clone());
        send(&flusher, Value::Object(object)).await;
        let calls = capture.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].len(), 3);
        assert!(calls[0]
            .iter()
            .all(|record| record.turn_id.as_deref() == Some("sub-session:t1")));
        for event in [
            serde_json::json!({"event.name":"llm.request","gen_ai.step.id":"main-session:t1:s2"}),
            serde_json::json!({"event.name":"llm.response","gen_ai.step.id":"main-session:t1:s2","gen_ai.response.finish_reasons":["stop"]}),
        ] {
            let mut object = main.as_object().unwrap().clone();
            object.extend(event.as_object().unwrap().clone());
            send(&flusher, Value::Object(object)).await;
        }
        flusher.flush().await.unwrap();
        let calls = capture.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].len(), 5);
        for record in &calls[1] {
            assert_eq!(record.turn_id.as_deref(), Some("main-session:t1"));
            assert_eq!(
                record.trace_id.as_deref(),
                Some("aaaa2f3577b34da6a3ce929d0e0e4736")
            );
        }
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn interleaved_codex_sessions_keep_exact_four_and_two_record_conversions_without_cross_preemption(
    ) {
        let (_root, flusher, capture) = setup();
        let a = serde_json::json!({"gen_ai.agent.type":"codex","gen_ai.turn.id":"codex-session-a:t1","gen_ai.session.id":"codex-session-a","trace_id":"77772f3577b34da6a3ce929d0e0e4736"});
        let b = serde_json::json!({"gen_ai.agent.type":"codex","gen_ai.turn.id":"codex-session-b:t1","gen_ai.session.id":"codex-session-b","trace_id":"88882f3577b34da6a3ce929d0e0e4736"});
        for (base, event) in [
            (&a, serde_json::json!({"event.name":"other"})),
            (
                &a,
                serde_json::json!({"event.name":"llm.response","gen_ai.response.finish_reasons":["tool_call"]}),
            ),
            (&b, serde_json::json!({"event.name":"other"})),
            (&a, serde_json::json!({"event.name":"llm.request"})),
        ] {
            let mut object = base.as_object().unwrap().clone();
            object.extend(event.as_object().unwrap().clone());
            send(&flusher, Value::Object(object)).await;
        }
        assert!(capture.calls().is_empty());
        for base in [&b, &a] {
            let mut object = base.as_object().unwrap().clone();
            object.extend(serde_json::json!({"event.name":"llm.response","gen_ai.response.finish_reasons":["stop"]}).as_object().unwrap().clone());
            send(&flusher, Value::Object(object)).await;
        }
        // As in the original declaration, assert the final conversions after flush.
        // Do not weaken the production Codex explicit terminal/durability rules.
        flusher.flush().await.unwrap();
        let calls = capture.calls();
        assert_eq!(calls.len(), 2);
        let by_turn: HashMap<_, _> = calls
            .iter()
            .map(|records| (records[0].turn_id.as_deref().unwrap(), records))
            .collect();
        assert_eq!(by_turn["codex-session-a:t1"].len(), 4);
        assert_eq!(by_turn["codex-session-b:t1"].len(), 2);
        for (turn, records) in by_turn {
            assert!(records
                .iter()
                .all(|record| record.turn_id.as_deref() == Some(turn)));
        }
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn signal_b_requires_two_known_matching_sessions_and_learns_late_session_identity() {
        for (first, second) in [
            (None, None),
            (Some("known-session"), None),
            (None, Some("known-session")),
        ] {
            let (_root, flusher, capture) = setup();
            for (index, session) in [first, second].into_iter().enumerate() {
                let mut fields=serde_json::json!({"event.name":"other","gen_ai.turn.id":format!("unknown-pair:t{index}"),"trace_id":if index==0{"33332f3577b34da6a3ce929d0e0e4736"}else{"44442f3577b34da6a3ce929d0e0e4736"}}).as_object().unwrap().clone();
                if let Some(session) = session {
                    fields.insert("gen_ai.session.id".into(), serde_json::json!(session));
                }
                send(&flusher, Value::Object(fields)).await;
            }
            assert!(capture.calls().is_empty());
            assert_eq!(flusher.inner.state.lock().unwrap().buffers.len(), 2);
            flusher.shutdown().await.unwrap();
        }
        let (_root, flusher, capture) = setup();
        for (turn, trace) in [
            ("s1:t1", "11112f3577b34da6a3ce929d0e0e4736"),
            ("s1:t2", "22222f3577b34da6a3ce929d0e0e4736"),
        ] {
            send(&flusher,serde_json::json!({"event.name":"other","gen_ai.turn.id":turn,"gen_ai.session.id":"s1","trace_id":trace})).await;
        }
        let calls = capture.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].len(), 1);
        assert_eq!(calls[0][0].turn_id.as_deref(), Some("s1:t1"));
        flusher.flush().await.unwrap();
        assert!(!capture.calls().is_empty());
        flusher.shutdown().await.unwrap();

        let (_root, flusher, capture) = setup();
        send(&flusher,serde_json::json!({"event.name":"other","gen_ai.turn.id":"late-session:t1","trace_id":"55552f3577b34da6a3ce929d0e0e4736"})).await;
        send(&flusher,serde_json::json!({"event.name":"llm.response","gen_ai.turn.id":"late-session:t1","gen_ai.session.id":"late-session","trace_id":"55552f3577b34da6a3ce929d0e0e4736","gen_ai.response.finish_reasons":["tool_call"]})).await;
        {
            let state = flusher.inner.state.lock().unwrap();
            assert_eq!(
                state.buffers["turn:late-session:t1"].session_id.as_deref(),
                Some("late-session")
            );
        }
        send(&flusher,serde_json::json!({"event.name":"other","gen_ai.turn.id":"parallel-session:t1","gen_ai.session.id":"parallel-session","trace_id":"66662f3577b34da6a3ce929d0e0e4736"})).await;
        assert!(capture.calls().is_empty());
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn seventy_unfinished_sessions_keep_soft65_and_force_five_oldest_before_final_flush() {
        let (_root, flusher, capture) = setup();
        for index in 0..70 {
            let hex = format!("{index:08x}");
            let trace = format!("{hex}2f3577b34da6a3ce929d0e0e4736")[..32].to_string();
            send(&flusher,serde_json::json!({"event.name":"other","gen_ai.turn.id":format!("s{index}:t1"),"gen_ai.session.id":format!("s{index}"),"trace_id":trace})).await;
        }
        assert_eq!(flusher.inner.state.lock().unwrap().buffers.len(), 65);
        let calls = capture.calls();
        assert_eq!(calls.len(), 5);
        for (index, records) in calls.iter().enumerate() {
            assert_eq!(records.len(), 1);
            assert_eq!(
                records[0].turn_id.as_deref(),
                Some(format!("s{index}:t1").as_str())
            );
        }
        flusher.flush().await.unwrap();
        assert!(capture.calls().len() >= 6);
        assert_eq!(capture.calls().len(), 70);
        flusher.shutdown().await.unwrap();
    }
}

#[cfg(test)]
mod legacy_turn_boundary_contracts {
    use super::*;
    use crate::normalization::TurnBoundaryProcessor;

    struct Capture(Mutex<Vec<Vec<AgentActivityEntry>>>);
    impl Capture {
        fn calls(&self) -> Vec<Vec<AgentActivityEntry>> {
            self.0.lock().unwrap().clone()
        }
    }
    impl EventLogConverter for Capture {
        fn convert(
            &self,
            records: &[AgentActivityEntry],
            _options: &ConvertOptions,
        ) -> Result<ConvertResult, String> {
            self.0.lock().unwrap().push(records.to_vec());
            Ok(ConvertResult::default())
        }
    }
    fn index(value: i64, len: usize) -> usize {
        if value < 0 {
            (len as i64 + value) as usize
        } else {
            value as usize
        }
    }
    fn check(checkpoint: &Value, calls: &[Vec<AgentActivityEntry>], source: &str) {
        let kind = checkpoint["kind"].as_str().unwrap();
        if kind == "calls" {
            assert_eq!(
                calls.len(),
                checkpoint["count"].as_u64().unwrap() as usize,
                "{source}: {checkpoint}"
            );
            return;
        }
        if kind == "calls-at-least" {
            assert!(
                calls.len() >= checkpoint["count"].as_u64().unwrap() as usize,
                "{source}: {checkpoint}"
            );
            return;
        }
        let call = index(checkpoint["call"].as_i64().unwrap(), calls.len());
        let records = calls
            .get(call)
            .unwrap_or_else(|| panic!("{source}: missing call for {checkpoint}"));
        if kind == "records" {
            assert_eq!(
                records.len(),
                checkpoint["count"].as_u64().unwrap() as usize,
                "{source}: {checkpoint}"
            );
            return;
        }
        let selected: Vec<_> = if checkpoint["record"].as_str() == Some("all") {
            assert!(
                !records.is_empty(),
                "{source}: forall contract must have real records"
            );
            records.iter().collect()
        } else {
            let record = index(checkpoint["record"].as_i64().unwrap(), records.len());
            vec![records
                .get(record)
                .unwrap_or_else(|| panic!("{source}: missing record for {checkpoint}"))]
        };
        for record in selected {
            let object = entry_to_object(record);
            match kind {
                "property" => {
                    let key = checkpoint["key"].as_str().unwrap();
                    assert_eq!(
                        object.get(key),
                        Some(&checkpoint["value"]),
                        "{source}: {checkpoint}"
                    );
                }
                "subset" => {
                    for (key, expected) in checkpoint["fields"].as_object().unwrap() {
                        assert_eq!(object.get(key), Some(expected), "{source}: {checkpoint}");
                    }
                }
                _ => panic!("unsupported frozen assertion {source}: {checkpoint}"),
            }
        }
    }

    async fn replay(source_id: &str) {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/turn-boundary-frozen-contracts.json"
        )))
        .unwrap();
        let case = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["source"]["id"] == source_id)
            .unwrap();
        assert!(!case["checkpoints"].as_array().unwrap().is_empty());
        let root = tempfile::tempdir().unwrap();
        let config:OtlpTraceFlusherConfig=serde_json::from_value(serde_json::json!({
            "enabled":true,"protocol":"http/protobuf","serviceName":"test-pilot","dataDir":root.path(),
            "turnIdleTimeoutMs":0,"endpoints":[{"name":"primary","endpoint":"http://unused:4318","headers":{"x-test":"1"}}]
        })).unwrap();
        let capture = Arc::new(Capture(Mutex::new(Vec::new())));
        let flusher =
            OtlpTraceFlusher::with_parts(config, None, None, Some(capture.clone())).unwrap();
        let mut boundaries = TurnBoundaryProcessor::new();
        let operations = case["operations"].as_array().unwrap();
        for completed in 0..=operations.len() {
            if completed > 0 {
                let operation = &operations[completed - 1];
                match operation["op"].as_str().unwrap() {
                    "send" | "batch" => {
                        let enrich = operation["enrich"] == true;
                        let input = if enrich {
                            &operation["raw"]
                        } else {
                            &operation["records"]
                        };
                        let mut records: Vec<AgentActivityEntry> =
                            serde_json::from_value(input.clone()).unwrap();
                        if enrich {
                            boundaries.enrich(&mut records);
                            for (record, expected) in
                                records.iter().zip(operation["records"].as_array().unwrap())
                            {
                                let actual = entry_to_object(record);
                                for (key, value) in expected.as_object().unwrap() {
                                    assert_eq!(
                                        actual.get(key),
                                        Some(value),
                                        "{source_id}: original boundary normalization {key}"
                                    );
                                }
                                for key in ["gen_ai.turn.start", "gen_ai.turn.end"] {
                                    assert_eq!(
                                        actual.get(key),
                                        expected.get(key),
                                        "{source_id}: boundary marker {key}"
                                    );
                                }
                            }
                        }
                        if operation["op"] == "send" {
                            assert_eq!(records.len(), 1);
                            flusher.send(records.remove(0), None).await.unwrap();
                        } else {
                            flusher.send_batch(records, None).await.unwrap();
                        }
                    }
                    "flush" => flusher.flush().await.unwrap(),
                    "shutdown" => flusher.shutdown().await.unwrap(),
                    other => panic!("unknown frozen operation {other}"),
                }
            }
            for checkpoint in case["checkpoints"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|checkpoint| checkpoint["after"].as_u64().unwrap() as usize == completed)
            {
                check(checkpoint, &capture.calls(), source_id);
            }
        }
        if source_id == "L89:C3" {
            // The original declaration also checks that incomplete cleanup did
            // not add a model failure or a success claim to the original input.
            let terminal = &operations.last().unwrap()["records"][0];
            assert!(terminal.get("error.type").is_none());
            assert!(terminal.get("agent.openclaw.success").is_none());
            let calls = capture.calls();
            assert_eq!(calls.len(), 1);
            assert!(!calls[0].is_empty());
            for record in &calls[0] {
                assert!(record.error_type.is_none());
                assert!(record.get("agent.openclaw.success").is_none());
            }
        }
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn hermes_realtime_retry_overlapping_turns_wait_for_explicit_end() {
        replay("L47:C3").await;
    }

    #[tokio::test]
    async fn legacy_openclaw_agent_end_flushes_failed_turn() {
        replay("L73:C3").await;
    }

    #[tokio::test]
    async fn legacy_openclaw_cleanup_does_not_invent_model_failure() {
        replay("L89:C3").await;
    }

    #[tokio::test]
    async fn stop_finishes_the_complete_pair() {
        replay("L103:C3").await;
    }

    #[tokio::test]
    async fn cancelled_finishes_the_complete_pair() {
        replay("L120:C3").await;
    }

    #[tokio::test]
    async fn codex_root_and_subagent_stops_wait_for_explicit_parent_end() {
        replay("L135:C3").await;
    }

    #[tokio::test]
    async fn claude_retry_error_waits_for_turn_end() {
        replay("L176:C3").await;
    }

    #[tokio::test]
    async fn tool_calls_does_not_close_the_turn() {
        replay("L201:C3").await;
    }

    #[tokio::test]
    async fn openclaw_per_call_stop_waits_for_llm_output() {
        replay("L213:C3").await;
    }

    #[tokio::test]
    async fn known_session_new_trace_preempts_the_old_buffer() {
        replay("L240:C3").await;
    }

    #[tokio::test]
    async fn unknown_session_traces_do_not_preempt_each_other() {
        replay("L262:C3").await;
    }

    #[tokio::test]
    async fn shutdown_drains_the_pending_buffer_once() {
        replay("L293:C3").await;
    }

    #[tokio::test]
    async fn trace_group_key_backfills_turn_identity() {
        replay("L307:C3").await;
    }

    #[tokio::test]
    async fn codex_step_with_tools_in_one_batch_keeps_six_records() {
        replay("L326:C5").await;
    }

    #[tokio::test]
    async fn hermes_retry_in_the_same_batch_keeps_four_records() {
        replay("L367:C5").await;
    }

    #[tokio::test]
    async fn openclaw_error_and_recovery_batches_wait_for_the_output_marker() {
        replay("L400:C5").await;
    }

    #[tokio::test]
    async fn claude_sorted_tools_and_stop_batch_keeps_four_records() {
        replay("L457:C5").await;
    }

    #[tokio::test]
    async fn cursor_stop_and_child_records_in_the_same_batch_all_survive() {
        replay("L485:C5").await;
    }

    #[tokio::test]
    async fn two_codex_turns_in_a_batch_convert_once_each() {
        replay("L523:C5").await;
    }

    #[tokio::test]
    async fn late_tool_from_the_next_batch_never_reopens_the_closed_turn() {
        replay("L555:C5").await;
    }

    #[tokio::test]
    async fn late_single_events_and_shutdown_never_convert_again() {
        replay("L584:C3").await;
    }
}

#[cfg(test)]
mod legacy_runtime_contracts {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

    struct Capture(Mutex<Vec<Vec<AgentActivityEntry>>>);
    impl Capture {
        fn calls(&self) -> Vec<Vec<AgentActivityEntry>> {
            self.0.lock().unwrap().clone()
        }
    }
    impl EventLogConverter for Capture {
        fn convert(
            &self,
            records: &[AgentActivityEntry],
            _options: &ConvertOptions,
        ) -> Result<ConvertResult, String> {
            self.0.lock().unwrap().push(records.to_vec());
            Ok(ConvertResult::default())
        }
    }
    fn record(turn: &str, agent: &str, session: &str) -> AgentActivityEntry {
        entry_from_map(
            serde_json::json!({
                "event.name":"llm.response","gen_ai.agent.type":agent,"gen_ai.turn.id":turn,
                "gen_ai.session.id":session,"gen_ai.output.messages":"private body"
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    }
    fn configuration(root: &std::path::Path) -> OtlpTraceFlusherConfig {
        serde_json::from_value(serde_json::json!({
            "enabled":true,"serviceName":"test","protocol":"http/protobuf","dataDir":root,
            "turnIdleTimeoutMs":0,"endpoints":[{"name":"primary","endpoint":"http://unused:4318","headers":{}}]
        })).unwrap()
    }
    fn setup() -> (tempfile::TempDir, OtlpTraceFlusher, Arc<Capture>) {
        let root = tempfile::tempdir().unwrap();
        let capture = Arc::new(Capture(Mutex::new(Vec::new())));
        let flusher = OtlpTraceFlusher::with_parts(
            configuration(root.path()),
            None,
            None,
            Some(capture.clone()),
        )
        .unwrap();
        (root, flusher, capture)
    }

    #[tokio::test]
    async fn snapshots_keep_exact_largest_oldest_scalars_without_live_counter_aliasing() {
        let (_root, flusher, _) = setup();
        flusher
            .send(record("older", "codex", "a"), Some(20.0))
            .await
            .unwrap();
        flusher
            .send_batch(
                vec![
                    record("larger", "codex", "b"),
                    record("larger", "codex", "b"),
                ],
                Some(vec![40.0, 60.0]),
            )
            .await
            .unwrap();
        let now = Instant::now();
        {
            let mut state = flusher.inner.state.lock().unwrap();
            for buffer in state.buffers.values_mut() {
                buffer.opened_at = now
                    - Duration::from_millis(if buffer.key_value == "older" {
                        200
                    } else {
                        100
                    });
            }
        }
        let mut rows = flusher.inner.snapshot_at(Some(now));
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.pending_buffers, 2);
        assert_eq!(row.pending_records, 3);
        assert_eq!(row.pending_logical_bytes, 120.0);
        assert_eq!(row.pending_unmeasured_records, 0);
        assert_eq!(row.largest_buffer_turn_id.as_deref(), Some("larger"));
        assert_eq!(row.largest_buffer_session_id.as_deref(), Some("b"));
        assert_eq!(row.largest_buffer_logical_bytes, 100.0);
        assert_eq!(row.largest_buffer_records, 2);
        assert_eq!(row.largest_buffer_age_ms, 100);
        assert_eq!(row.oldest_buffer_age_ms, 200);
        assert!(!format!("{rows:?}").contains("private body"));
        rows[0].removed_buffers_total = 999;
        assert_eq!(
            flusher.inner.snapshot_at(Some(now))[0].removed_buffers_total,
            0
        );
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn main_claude_successor_accounts_original_bytes_while_the_original_codex_fixture_is_retained(
    ) {
        let (_root, flusher, capture) = setup();
        let mut entries = vec![record("first", "claude-code", "session")];
        entries.extend((0..64).map(|_| record("next", "claude-code", "session")));
        let mut bytes = vec![123.0];
        bytes.extend([10.0; 64]);
        flusher.send_batch(entries, Some(bytes)).await.unwrap();
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(row.removed_buffers_total, 1);
        assert_eq!(row.removed_logical_bytes_total, 123.0);
        assert_eq!(row.pending_buffers, 1);
        assert_eq!(row.pending_records, 64);
        assert_eq!(row.pending_logical_bytes, 640.0);
        flusher.flush().await.unwrap();
        let cleared = flusher.trace_runtime_snapshot();
        assert_eq!(cleared[0].pending_buffers, 0);
        assert_eq!(cleared[0].removed_buffers_total, 2);
        assert_eq!(cleared[0].removed_logical_bytes_total, 763.0);
        assert_eq!(
            capture.calls().iter().map(Vec::len).collect::<Vec<_>>(),
            [1, 64]
        );
        flusher.flush().await.unwrap();
        assert_eq!(flusher.trace_runtime_snapshot(), cleared);
        flusher.shutdown().await.unwrap();

        // Baseline used Codex here. Main explicitly switches accounting to
        // Claude and separately requires native Codex turns to remain resident.
        let (_root, flusher, capture) = setup();
        let mut entries = vec![record("first", "codex", "session")];
        entries.extend((0..64).map(|_| record("next", "codex", "session")));
        let mut bytes = vec![123.0];
        bytes.extend([10.0; 64]);
        flusher.send_batch(entries, Some(bytes)).await.unwrap();
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(row.pending_buffers, 2);
        assert_eq!(row.pending_records, 65);
        assert_eq!(row.pending_logical_bytes, 763.0);
        assert_eq!(row.removed_buffers_total, 0);
        assert!(capture.calls().is_empty());
        flusher.shutdown().await.unwrap();

        let (_root, flusher, _) = setup();
        flusher
            .send(record("first", "codex", "session"), Some(12.0))
            .await
            .unwrap();
        flusher
            .send(record("next", "codex", "session"), Some(34.0))
            .await
            .unwrap();
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(row.pending_buffers, 2);
        assert_eq!(row.pending_logical_bytes, 46.0);
        assert_eq!(row.removed_buffers_total, 0);
        let mut terminal = record("first", "codex", "session");
        terminal.turn_end = Some(true);
        terminal.extra.insert(
            "agent.codex.turn_status".into(),
            serde_json::json!("completed"),
        );
        flusher.send(terminal, Some(0.0)).await.unwrap();
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(row.pending_buffers, 1);
        assert_eq!(row.pending_logical_bytes, 34.0);
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn unavailable_measurements_never_block_collection_and_are_removed_exactly_once() {
        let (_root, flusher, _) = setup();
        flusher
            .send_batch(
                vec![
                    record("turn", "codex", "session"),
                    record("turn", "codex", "session"),
                ],
                Some(vec![100.0]),
            )
            .await
            .unwrap();
        for bytes in [f64::NAN, -1.0, 0.0] {
            flusher
                .send(record("turn", "codex", "session"), Some(bytes))
                .await
                .unwrap();
        }
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(row.pending_records, 5);
        assert_eq!(row.pending_logical_bytes, 0.0);
        assert_eq!(row.pending_unmeasured_records, 4);
        flusher.flush().await.unwrap();
        assert_eq!(
            flusher.trace_runtime_snapshot()[0].removed_unmeasured_records_total,
            4
        );
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn removal_accounting_is_visible_before_the_blocked_conversion_settles() {
        let (_root, flusher, capture) = setup();
        flusher
            .send(record("first", "claude-code", "session"), Some(12.0))
            .await
            .unwrap();
        let service = flusher.endpoint_service_name(0, "claude-code");
        let key = convert_state_key("claude-code", &service, &Map::new());
        let gate = flusher.inner.convert_lock(&key).lock_owned().await;
        let old = {
            let mut state = flusher.inner.state.lock().unwrap();
            state.buffers.shift_remove("turn:first").unwrap()
        };
        let inner = flusher.inner.clone();
        let finishing = tokio::spawn(async move { inner.finish_buffer(old, false).await });
        tokio::time::timeout(Duration::from_secs(3), async {
            while flusher.trace_runtime_snapshot()[0].removed_buffers_total == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!finishing.is_finished());
        assert!(capture.calls().is_empty());
        flusher
            .send(record("next", "claude-code", "session"), Some(34.0))
            .await
            .unwrap();
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(row.pending_buffers, 1);
        assert_eq!(row.pending_logical_bytes, 34.0);
        assert_eq!(row.removed_logical_bytes_total, 12.0);
        // Rust send awaits conversion backpressure; hold the actual conversion
        // lock to observe the same removal/next-buffer lifecycle without
        // changing production Signal B or reverting Codex ownership rules.
        drop(gate);
        finishing.await.unwrap().unwrap();
        flusher.flush().await.unwrap();
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(row.pending_buffers, 0);
        assert_eq!(row.removed_buffers_total, 2);
        assert_eq!(row.removed_logical_bytes_total, 46.0);
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn public_send_accepts_successor_before_owned_preemption_export_and_flush_joins() {
        let (_root, flusher, capture) = setup();
        let flusher = Arc::new(flusher);
        flusher
            .send(record("first", "claude-code", "session"), Some(12.0))
            .await
            .unwrap();
        let service = flusher.endpoint_service_name(0, "claude-code");
        let key = convert_state_key("claude-code", &service, &Map::new());
        let gate = flusher.inner.convert_lock(&key).lock_owned().await;
        let out = flusher.clone();
        let mut sending = tokio::spawn(async move {
            out.send(record("next", "claude-code", "session"), Some(34.0))
                .await
        });
        let result = tokio::time::timeout(Duration::from_secs(5), &mut sending).await;
        let early = result.is_ok();
        if let Ok(result) = result {
            result.unwrap().unwrap();
        }
        let snapshot = flusher.trace_runtime_snapshot();
        let out = flusher.clone();
        let draining = tokio::spawn(async move { out.flush().await });
        tokio::task::yield_now().await;
        let drained_early = draining.is_finished();
        assert!(capture.calls().is_empty());
        drop(gate);
        if !early {
            sending.await.unwrap().unwrap();
        }
        draining.await.unwrap().unwrap();
        assert!(early);
        assert!(!drained_early);
        assert_eq!(snapshot[0].pending_buffers, 1);
        assert_eq!(snapshot[0].pending_logical_bytes, 34.0);
        assert_eq!(snapshot[0].removed_logical_bytes_total, 12.0);
        assert_eq!(flusher.trace_runtime_snapshot()[0].pending_buffers, 0);
        assert_eq!(capture.calls().iter().map(Vec::len).sum::<usize>(), 2);
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn cumulative_counters_preserve_original_single_send_soft65_then_flush_all_seventy_records(
    ) {
        let (_root, flusher, capture) = setup();
        for index in 0..70 {
            flusher
                .send(
                    record(
                        &format!("turn-{index}"),
                        "codex",
                        &format!("session-{index}"),
                    ),
                    Some(1.0),
                )
                .await
                .unwrap();
        }
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(row.pending_buffers, 65);
        assert_eq!(row.removed_buffers_total, 5);
        assert_eq!(flusher.inner.state.lock().unwrap().buffers.len(), 65);
        flusher.flush().await.unwrap();
        let snapshot = flusher.trace_runtime_snapshot();
        assert_eq!(snapshot[0].removed_buffers_total, 70);
        assert_eq!(snapshot[0].removed_logical_bytes_total, 70.0);
        assert_eq!(capture.calls().iter().map(Vec::len).sum::<usize>(), 70);
        assert_eq!(flusher.trace_runtime_snapshot(), snapshot);
        flusher
            .send(record("fresh", "codex", "session"), Some(7.0))
            .await
            .unwrap();
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(row.removed_buffers_total, 70);
        assert_eq!(row.pending_logical_bytes, 7.0);
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn diagnostic_dimensions_cap_at_64_without_dropping_any_of_the_seventy_business_records()
    {
        let (_root, flusher, capture) = setup();
        for index in 0..70 {
            flusher
                .send(
                    record(
                        &format!("turn-{index}"),
                        &format!("agent-{index}"),
                        &format!("session-{index}"),
                    ),
                    Some(1.0),
                )
                .await
                .unwrap();
        }
        assert_eq!(flusher.trace_runtime_snapshot().len(), 64);
        assert_eq!(flusher.inner.state.lock().unwrap().buffers.len(), 65);
        flusher.flush().await.unwrap();
        assert_eq!(flusher.inner.state.lock().unwrap().buffers.len(), 0);
        assert_eq!(flusher.trace_runtime_snapshot().len(), 64);
        assert_eq!(capture.calls().iter().map(Vec::len).sum::<usize>(), 70);
        flusher.shutdown().await.unwrap();
    }

    struct Clock {
        base: Instant,
        ms: AtomicU64,
        failed: AtomicBool,
        calls: AtomicUsize,
    }
    impl Clock {
        fn now(&self) -> Instant {
            self.base + Duration::from_millis(self.ms.load(Ordering::SeqCst))
        }
        fn advance(&self, ms: u64) {
            self.ms.fetch_add(ms, Ordering::SeqCst);
        }
    }
    struct TimedConverter(Arc<Clock>);
    impl EventLogConverter for TimedConverter {
        fn convert(
            &self,
            records: &[AgentActivityEntry],
            options: &ConvertOptions,
        ) -> Result<ConvertResult, String> {
            self.0.calls.fetch_add(1, Ordering::SeqCst);
            self.0.advance(10);
            if self.0.failed.load(Ordering::SeqCst) {
                return Err("conversion failure".into());
            }
            crate::flushers::event_log_converter::GenAiEventLogConverter.convert(records, options)
        }
    }
    type Release = Arc<Mutex<Option<tokio::sync::OwnedMutexGuard<()>>>>;
    struct Export {
        clock: Arc<Clock>,
        exports: Arc<AtomicUsize>,
        name: String,
        release: Release,
    }
    #[async_trait]
    impl TraceExporter for Export {
        async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
            assert!(!spans.is_empty());
            self.exports.fetch_add(1, Ordering::SeqCst);
            if self.name == "user" {
                let released = self.release.lock().unwrap().take();
                if released.is_some() {
                    self.clock.advance(500);
                    drop(released);
                }
            }
            Ok(())
        }
        async fn shutdown(&self) {}
    }
    fn stage_records() -> Vec<AgentActivityEntry> {
        [
            serde_json::json!({"time_unix_nano":"1780000000000000000","event.name":"llm.request"}),
            serde_json::json!({"time_unix_nano":"1780000000001000000","event.name":"llm.response","gen_ai.response.finish_reasons":["stop"]})
        ].into_iter().map(|value|{
            let mut object=value.as_object().unwrap().clone();
            object.extend(serde_json::json!({"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","gen_ai.session.id":"session","gen_ai.turn.id":"turn","gen_ai.agent.type":"opencode","gen_ai.step.id":"step","gen_ai.request.model":"model"}).as_object().unwrap().clone());
            entry_from_map(object)
        }).collect()
    }
    type StageSetup = (
        tempfile::TempDir,
        OtlpTraceFlusher,
        Arc<Clock>,
        Arc<AtomicUsize>,
        Release,
    );
    fn stage_setup(services: &[&str]) -> StageSetup {
        let root = tempfile::tempdir().unwrap();
        let endpoints:Vec<_>=services.iter().map(|service|serde_json::json!({"name":service,"serviceName":service,"endpoint":"http://unused:4318"})).collect();
        let config:OtlpTraceFlusherConfig=serde_json::from_value(serde_json::json!({
            "enabled":true,"protocol":"http/protobuf","serviceName":"fallback","appendAgentTypeToServiceName":false,
            "dataDir":root.path(),"turnIdleTimeoutMs":0,"endpoints":endpoints
        })).unwrap();
        let clock = Arc::new(Clock {
            base: Instant::now(),
            ms: AtomicU64::new(0),
            failed: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
        });
        let exports = Arc::new(AtomicUsize::new(0));
        let release: Release = Arc::new(Mutex::new(None));
        let converter = Arc::new(TimedConverter(clock.clone()));
        let factory_clock = clock.clone();
        let factory_exports = exports.clone();
        let factory_release = release.clone();
        let factory: ExporterFactory = Arc::new(move |options| {
            Arc::new(Export {
                clock: factory_clock.clone(),
                exports: factory_exports.clone(),
                name: options.name,
                release: factory_release.clone(),
            }) as Arc<dyn TraceExporter>
        });
        let flusher =
            OtlpTraceFlusher::with_parts(config, None, Some(factory), Some(converter)).unwrap();
        let time = clock.clone();
        *flusher.inner.test_conversion_clock.lock().unwrap() = Some(Arc::new(move || time.now()));
        (root, flusher, clock, exports, release)
    }

    #[tokio::test]
    async fn actual_conversion_calls_and_durations_follow_one_or_two_service_groups() {
        for (services, expected) in [(["same", "same"], 1), (["user", "inner"], 2)] {
            let (_root, flusher, clock, exports, _release) = stage_setup(&services);
            flusher
                .send_batch(stage_records(), Some(vec![100.0, 200.0]))
                .await
                .unwrap();
            let snapshot = flusher.trace_runtime_snapshot();
            let row = &snapshot[0];
            assert_eq!(clock.calls.load(Ordering::SeqCst), expected);
            assert_eq!(row.converter_calls_total, expected as u64);
            assert_eq!(row.converter_duration_ms_total, expected as f64 * 10.0);
            assert_eq!(row.converter_failed_total, 0);
            assert_eq!(row.removed_buffers_total, 1);
            assert_eq!(row.pending_buffers, 0);
            assert_eq!(exports.load(Ordering::SeqCst), 2);
            flusher.shutdown().await.unwrap();
        }
    }

    #[tokio::test]
    async fn actual_conversion_lock_wait_is_excluded_while_two_durations_still_sum() {
        let (_root, flusher, clock, exports, release) = stage_setup(&["user", "inner"]);
        let input = stage_records();
        let key = convert_state_key(
            "opencode",
            "inner",
            &collect_resource_attributes(&flusher.inner, &input),
        );
        let gate = flusher.inner.convert_lock(&key).lock_owned().await;
        *release.lock().unwrap() = Some(gate);
        tokio::time::timeout(
            Duration::from_secs(3),
            flusher.send_batch(input, Some(vec![100.0, 200.0])),
        )
        .await
        .unwrap()
        .unwrap();
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(clock.calls.load(Ordering::SeqCst), 2);
        assert_eq!(clock.ms.load(Ordering::SeqCst), 520);
        assert_eq!(row.converter_calls_total, 2);
        assert_eq!(row.converter_duration_ms_total, 20.0);
        assert_eq!(exports.load(Ordering::SeqCst), 2);
        assert!(release.lock().unwrap().is_none());
        flusher.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn failed_conversion_accounts_bytes_once_without_a_pending_diagnostic_turn() {
        let (_root, flusher, clock, exports, _release) = stage_setup(&["single"]);
        clock.failed.store(true, Ordering::SeqCst);
        flusher
            .send_batch(stage_records(), Some(vec![100.0, 200.0]))
            .await
            .unwrap();
        let row = &flusher.trace_runtime_snapshot()[0];
        assert_eq!(row.converter_calls_total, 1);
        assert_eq!(row.converter_duration_ms_total, 10.0);
        assert_eq!(row.converter_failed_total, 1);
        assert_eq!(row.removed_logical_bytes_total, 300.0);
        assert_eq!(row.pending_buffers, 0);
        assert_eq!(exports.load(Ordering::SeqCst), 0);
        {
            let state = flusher.inner.state.lock().unwrap();
            assert!(state.buffers.is_empty());
            assert_eq!(state.convert_states.len(), 1);
            assert!(state.convert_states.values().all(|state| state.active == 0));
        }
        flusher.shutdown().await.unwrap();
    }
}

#[cfg(test)]
mod doubao_contract_tests {
    use super::*;
    use crate::types::{OtlpEndpoint, OtlpProtocol};
    use async_trait::async_trait;
    use serde_json::json;
    const EPOCH: i128 = 1_760_000_000_000_000_000;
    fn time(ms: i128) -> String {
        (EPOCH + ms * 1_000_000).to_string()
    }
    fn ns(t: [i64; 2]) -> i128 {
        i128::from(t[0]) * 1_000_000_000 + i128::from(t[1])
    }
    fn kind(s: &ReadableSpan) -> &str {
        s.attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            .unwrap_or("")
    }
    fn records(trace: &str) -> Vec<AgentActivityEntry> {
        let mut start=entry_from_map(json!({"event.id":format!("{trace}-start"),"event.name":"other","time_unix_nano":time(0),"user.id":"synthetic-user","trace_id":trace,"gen_ai.agent.type":"doubao-work","gen_ai.agent.id":"synthetic-actor","gen_ai.agent.name":"Doubao Work","gen_ai.provider.name":"bytedance.doubao","gen_ai.session.id":"reused-session","gen_ai.turn.id":"reused-turn","gen_ai.turn.start":true,"gen_ai.framework":"doubao-work","loongsuite.doubao_work.observation_scope":"client_message","loongsuite.doubao_work.business_outcome":"unknown","loongsuite.doubao_work.client_outcome":"received","resourceAttributes":{"loongsuite.doubao_work.business_outcome":"unknown","loongsuite.doubao_work.observation_scope":"client_message"}}).as_object().unwrap().clone());
        // main's native producer marks an evidenced content-free client input
        // boundary explicitly. This is not a fabricated user prompt.
        start.input_messages_delta = Some(json!([]));
        let mut end = start.clone();
        end.event_id = format!("{trace}-end");
        end.time_unix_nano = (EPOCH + 10_000_123_000).to_string();
        end.turn_start = None;
        end.turn_end = Some(true);
        start.turn_end = None;
        vec![start, end]
    }
    fn tools(
        root: &AgentActivityEntry,
        specs: &[(&str, i128, i128, &str)],
    ) -> Vec<AgentActivityEntry> {
        let mut out = Vec::new();
        for (id, a, b, status) in specs {
            let mut call = root.clone();
            call.event_id = format!("{}-{id}-call", root.event_id);
            call.turn_start = None;
            call.turn_end = None;
            call.event_name = Some(crate::types::AgentEventName::ToolCall);
            call.time_unix_nano = time(*a);
            call.tool_call_id = Some((*id).into());
            call.tool_name = Some("Read".into());
            call.span_id = Some(super::super::doubao_work_converter::digest(
                &format!("observed:{id}"),
                16,
            ));
            let mut result = call.clone();
            result.event_id = format!("{}-{id}-result", root.event_id);
            result.event_name = Some(crate::types::AgentEventName::ToolResult);
            result.time_unix_nano = time(*b);
            result
                .extra
                .insert("tool.result.status".into(), (*status).into());
            out.extend([call, result]);
        }
        out
    }
    fn with_tools(specs: &[(&str, i128, i128, &str)]) -> Vec<AgentActivityEntry> {
        let mut rows = records(&"a".repeat(32));
        let t = tools(&rows[0], specs);
        rows.splice(1..1, t);
        rows
    }
    fn round(
        ordinal: usize,
        ids: &[(&str, &str, bool, Option<&str>)],
        inputs: Value,
        outputs: Value,
    ) -> Value {
        json!({"id":format!("{ordinal:064x}"),"ordinal":ordinal,"inputMessages":inputs,"outputMessages":outputs,"callIds":ids.iter().map(|x|x.0).collect::<Vec<_>>(),"tools":ids.iter().map(|x| { let mut value=json!({"callId":x.0,"name":x.1,"completed":x.2}); if let Some(result)=x.3 {value["result"]=json!(result);} value }).collect::<Vec<_>>()})
    }
    fn rounds(rows: &mut [AgentActivityEntry], values: Vec<Value>) {
        rows[0].extra.insert(
            "agent.doubao_work.assistant_rounds".into(),
            json!({"rounds":values,"omittedRounds":0,"duplicateAssistantRows":0}),
        );
    }
    fn task(id: &str, start: i128, end: i128, parent: Option<&str>) -> Vec<AgentActivityEntry> {
        let mut rows = records(&"a".repeat(32));
        for (i, row) in rows.iter_mut().enumerate() {
            row.event_id = format!("{id}-{i}");
            row.turn_start = None;
            row.turn_end = None;
            row.time_unix_nano = time(if i == 0 { start } else { end });
            row.agent_id = Some(id.into());
            row.extra.extend(json!({"loongsuite.doubao_work.observation_scope":"native_sandbox_execution","loongsuite.doubao_work.local_execution_phase":if i==0 {"start"} else {"end"},"loongsuite.doubao_work.native_execution_id":id,"loongsuite.doubao_work.local_execution_span_id":super::super::doubao_work_converter::digest(id,16),"loongsuite.doubao_work.root_request_start_unix_nano":time(0),"loongsuite.doubao_work.root_request_end_unix_nano":time(10_000),"loongsuite.doubao_work.root_turn_id":"reused-turn"}).as_object().unwrap().clone());
            if let Some(parent) = parent {
                row.parent_span_id = Some(parent.into());
                row.extra.insert(
                    "loongsuite.doubao_work.parent_resolution".into(),
                    "same_query_native_execution".into(),
                );
                row.extra.insert(
                    "loongsuite.doubao_work.native_parent_in_request".into(),
                    true.into(),
                );
            }
        }
        rows
    }
    #[derive(Default)]
    struct Capture(Mutex<Vec<ReadableSpan>>);
    #[async_trait]
    impl TraceExporter for Capture {
        async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
            self.0.lock().unwrap().extend(spans);
            Ok(())
        }
        async fn shutdown(&self) {}
    }
    fn collector() -> (OtlpTraceFlusher, Arc<Capture>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let capture = Arc::new(Capture::default());
        let sink = capture.clone();
        let factory: ExporterFactory = Arc::new(move |_| sink.clone());
        let cfg = OtlpTraceFlusherConfig {
            enabled: true,
            endpoints: vec![OtlpEndpoint {
                name: "synthetic".into(),
                endpoint: "http://127.0.0.1:1".into(),
                headers: None,
                compression: None,
                service_name: None,
            }],
            protocol: OtlpProtocol::HttpProtobuf,
            service_name: "doubao-contract".into(),
            append_agent_type_to_service_name: None,
            resource_attributes: None,
            capture_message_content: None,
            debug: None,
            turn_idle_timeout_ms: None,
            resource_attribute_keys: None,
            span_attribute_passthrough_prefixes: None,
            max_export_batch_bytes: None,
            data_dir: Some(dir.path().to_string_lossy().into_owned()),
            span_enricher_paths: None,
        };
        (
            OtlpTraceFlusher::with_parts(cfg, None, Some(factory), None).unwrap(),
            capture,
            dir,
        )
    }
    async fn convert(rows: Vec<AgentActivityEntry>) -> Vec<ReadableSpan> {
        let (f, s, _dir) = collector();
        f.send_batch(rows, None).await.unwrap();
        f.flush().await.unwrap();
        f.shutdown().await.unwrap();
        let spans = s.0.lock().unwrap().clone();
        spans
    }
    fn ids(spans: &[ReadableSpan]) -> Vec<String> {
        spans
            .iter()
            .filter(|s| kind(s) != "ENTRY")
            .map(|s| s.span_id.clone())
            .collect()
    }

    #[tokio::test]
    async fn passive_boundaries_preserve_precision_parent_outcomes_and_no_provider_fabrication() {
        for (outcome, code, parent) in [
            ("received", 0, None),
            ("error", 2, None),
            ("cancelled", 2, None),
            ("received", 0, Some("1234567890abcdef")),
        ] {
            let mut rows = records(&"a".repeat(32));
            for row in &mut rows {
                row.parent_span_id = parent.map(str::to_owned);
                row.extra.insert(
                    "loongsuite.doubao_work.client_outcome".into(),
                    outcome.into(),
                );
            }
            rows[1].extra.insert(
                "loongsuite.doubao_work.selected_skills".into(),
                json!(["synthetic-skill"]),
            );
            let spans = convert(rows).await;
            assert_eq!(spans.len(), 2);
            let entry = spans.iter().find(|s| kind(s) == "ENTRY").unwrap();
            let agent = spans.iter().find(|s| kind(s) == "AGENT").unwrap();
            assert_eq!(entry.parent_span_id.as_deref(), parent);
            assert_eq!(
                agent.parent_span_id.as_deref(),
                Some(entry.span_id.as_str())
            );
            assert_eq!(
                agent.span_id,
                super::super::doubao_work_converter::root_agent_span_id(&"a".repeat(32))
            );
            for s in &spans {
                assert_eq!(ns(s.start_time), EPOCH);
                assert_eq!(ns(s.end_time), EPOCH + 10_000_123_000);
                assert_eq!(ns(s.duration), 10_000_123_000);
                assert_eq!(s.status["code"], code);
                assert_eq!(s.attributes["gen_ai.framework"], "doubao-work");
                assert_eq!(
                    s.attributes["loongsuite.doubao_work.selected_skills"],
                    json!(["synthetic-skill"])
                );
                assert!(!s
                    .attributes
                    .keys()
                    .any(|k| k.starts_with("gen_ai.usage.") || k == "gen_ai.request.model"));
                assert_eq!(
                    s.resource_attributes.as_ref().unwrap()
                        ["loongsuite.doubao_work.business_outcome"],
                    "unknown"
                );
            }
        }
    }

    #[tokio::test]
    async fn concurrent_same_name_tools_keep_real_identity_bounds_content_and_cancel_status() {
        let mut rows = with_tools(&[("a", 1000, 1500, "success"), ("b", 1100, 1400, "error")]);
        rows[0].input_messages_delta = Some(
            json!([{"role":"user","parts":[{"type":"text","content":"synthetic user input"}]}]),
        );
        rows.last_mut().unwrap().output_messages = Some(
            json!([{"role":"assistant","parts":[{"type":"text","content":"synthetic final answer"}]}]),
        );
        rows[1].tool_call_arguments = Some(json!({"file_path":"synthetic-a"}));
        rows[2].tool_call_result = Some(json!("synthetic-result"));
        let mut mark = rows[0].clone();
        mark.event_id = "first-output".into();
        mark.turn_start = None;
        mark.extra.insert(
            "loongsuite.doubao_work.observation_scope".into(),
            "native_first_model_output".into(),
        );
        mark.extra.insert(
            "loongsuite.doubao_work.client_time_to_first_cot_ms".into(),
            1000.into(),
        );
        rows.insert(1, mark);
        let spans = convert(rows.clone()).await;
        let agent = spans.iter().find(|s| kind(s) == "AGENT").unwrap();
        assert_eq!(spans.len(), 4);
        assert!(agent.attributes["gen_ai.input.messages"]
            .as_str()
            .unwrap()
            .contains("synthetic user input"));
        assert!(agent.attributes["gen_ai.output.messages"]
            .as_str()
            .unwrap()
            .contains("synthetic final answer"));
        assert!(agent.events.is_empty());
        assert_eq!(
            agent.attributes["loongsuite.doubao_work.client_time_to_first_cot_ms"],
            json!(1000.0)
        );
        for (id, a, b, code) in [("a", 1000, 1500, 0), ("b", 1100, 1400, 2)] {
            let s = spans
                .iter()
                .find(|s| s.attributes.get("gen_ai.tool.call.id") == Some(&json!(id)))
                .unwrap();
            assert_eq!(s.parent_span_id.as_deref(), Some(agent.span_id.as_str()));
            assert_eq!(
                (ns(s.start_time), ns(s.end_time)),
                (EPOCH + a * 1_000_000, EPOCH + b * 1_000_000)
            );
            assert_eq!(s.status["code"], code);
        }
        assert!(spans.iter().all(|s| !matches!(kind(s), "LLM" | "STEP")));
        assert_eq!(
            spans
                .iter()
                .find(|s| s.attributes.get("gen_ai.tool.call.id") == Some(&json!("a")))
                .unwrap()
                .attributes["gen_ai.tool.call.result"],
            "synthetic-result"
        );
        assert_eq!(ids(&spans), ids(&convert(rows.clone()).await));
        let result = rows
            .iter_mut()
            .find(|r| {
                r.tool_call_id.as_deref() == Some("a")
                    && r.event_name == Some(crate::types::AgentEventName::ToolResult)
            })
            .unwrap();
        let exact = result.time_unix_nano.clone();
        result
            .extra
            .insert("tool.result.status".into(), "cancelled".into());
        let spans = convert(rows).await;
        let s = spans
            .iter()
            .find(|s| s.attributes.get("gen_ai.tool.call.id") == Some(&json!("a")))
            .unwrap();
        assert_eq!(s.attributes["error.type"], "doubao.local_tool_cancelled");
        assert_eq!(s.status["code"], 2);
        assert_eq!(hr_time_to_nano(s.end_time), exact);
    }

    #[tokio::test]
    async fn rejects_ambiguous_wrong_owner_and_invalid_tool_boundaries_without_transcript_bypass() {
        for failure in [
            "duplicate",
            "wrong-name",
            "wrong-actor",
            "different-owner",
            "wrong-trace",
            "outside-owner",
            "nonpositive",
            "log-only",
            "collision",
            "bad-status",
        ] {
            let mut rows =
                with_tools(&[("a", 1000, 1500, "success"), ("b", 1100, 1400, "success")]);
            match failure {
                "duplicate" => {
                    let mut extra = rows[2].clone();
                    extra.event_id = "ambiguous-result".into();
                    extra.time_unix_nano = time(1501);
                    rows.insert(3, extra);
                }
                "wrong-name" => rows[2].tool_name = Some("Write".into()),
                "wrong-actor" => rows[2].agent_id = Some("other".into()),
                "different-owner" => {
                    rows[1].agent_id = Some("other".into());
                    rows[2].agent_id = Some("other".into());
                }
                "wrong-trace" => rows[2].trace_id = Some("b".repeat(32)),
                "outside-owner" => rows[2].time_unix_nano = time(20_000),
                "nonpositive" => rows[2].time_unix_nano = rows[1].time_unix_nano.clone(),
                "log-only" => {
                    rows[2].extra.insert(
                        "loongsuite.doubao_work.trace_role".into(),
                        "log_only".into(),
                    );
                }
                "collision" => {
                    rows[3].span_id = rows[1].span_id.clone();
                    rows[4].span_id = rows[1].span_id.clone();
                }
                "bad-status" => {
                    rows[2]
                        .extra
                        .insert("tool.result.status".into(), "maybe".into());
                }
                _ => unreachable!(),
            }
            rounds(
                &mut rows,
                vec![round(
                    1,
                    &[
                        ("a", "Read", true, Some("cannot bypass")),
                        ("b", "Read", true, None),
                    ],
                    json!([]),
                    json!([]),
                )],
            );
            let spans = convert(rows).await;
            let tools: Vec<_> = spans
                .iter()
                .filter(|s| kind(s) == "TOOL")
                .map(|s| s.attributes["gen_ai.tool.call.id"].as_str().unwrap())
                .collect();
            assert_eq!(
                tools,
                if failure == "collision" {
                    vec![]
                } else {
                    vec!["b"]
                },
                "{failure}"
            );
        }
    }

    #[tokio::test]
    async fn local_tool_spans_are_bounded_and_absent_content_is_not_invented() {
        let specs: Vec<_> = (0..65)
            .map(|n| (format!("call-{n}"), 1000 + n * 2, 1001 + n * 2, "success"))
            .collect();
        let borrowed: Vec<_> = specs
            .iter()
            .map(|s| (s.0.as_str(), s.1, s.2, s.3))
            .collect();
        let spans = convert(with_tools(&borrowed)).await;
        assert_eq!(spans.iter().filter(|s| kind(s) == "TOOL").count(), 64);
        let owner = spans.iter().find(|s| kind(s) == "AGENT").unwrap();
        assert_eq!(
            owner.attributes["loongsuite.doubao_work.tool_observations_count"],
            64
        );
        assert_eq!(
            owner.attributes["loongsuite.doubao_work.tool_observations_not_in_span"],
            1
        );
        for tool in spans.iter().filter(|s| kind(s) == "TOOL") {
            assert!(!tool.attributes.contains_key("gen_ai.tool.call.arguments"));
            assert!(!tool.attributes.contains_key("gen_ai.tool.call.result"));
        }
    }

    #[tokio::test]
    async fn request_identity_survives_reused_session_interleaving_other_agents_and_replay() {
        let (f, s, _dir) = collector();
        let a = records(&"a".repeat(32));
        let b = records(&"b".repeat(32));
        f.send_batch(vec![a[0].clone(), b[0].clone()], None)
            .await
            .unwrap();
        assert!(s.0.lock().unwrap().is_empty());
        f.send_batch(vec![a[1].clone(), b[1].clone()], None)
            .await
            .unwrap();
        assert_eq!(s.0.lock().unwrap().len(), 4);
        f.send_batch(a.clone(), None).await.unwrap();
        f.send_batch(b.clone(), None).await.unwrap();
        assert_eq!(s.0.lock().unwrap().len(), 4);
        let mut c = records(&"c".repeat(32));
        for row in &mut c {
            row.agent_type = "claude-code".into();
            row.input_messages = Some(json!([]));
        }
        f.send_batch(c, None).await.unwrap();
        assert_eq!(s.0.lock().unwrap().len(), 6);
        f.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn local_execution_and_log_only_facts_do_not_preempt_active_client_request() {
        let (f, s, _dir) = collector();
        let rows = records(&"a".repeat(32));
        f.send(rows[0].clone(), None).await.unwrap();
        let mut audit = rows[0].clone();
        audit.event_id = "audit".into();
        audit.extra.insert(
            "loongsuite.doubao_work.trace_role".into(),
            "log_only".into(),
        );
        audit.event_name = Some(crate::types::AgentEventName::ToolCall);
        f.send(audit, None).await.unwrap();
        f.send_batch(task("organizer", 4000, 9000, None), None)
            .await
            .unwrap();
        assert_eq!(
            s.0.lock().unwrap().iter().map(kind).collect::<Vec<_>>(),
            ["TASK"]
        );
        f.send(rows[1].clone(), None).await.unwrap();
        assert_eq!(s.0.lock().unwrap().len(), 3);
        f.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn local_task_parent_links_nested_tool_ownership_and_background_replay_are_exact() {
        for end in [9000, 12_000] {
            let mut rows = task("child", 4000, end, Some("1234567890abcdef"));
            rows[0].extra.insert(
                "agent.doubao_work.task_input".into(),
                "visible task input".into(),
            );
            rows[0].extra.insert(
                "agent.doubao_work.task_output".into(),
                "visible task output".into(),
            );
            rows[0].extra.insert("agent.doubao_work.tool_observations".into(),json!([{"callId":"child-read","name":"Read","startNano":time(5000),"endNano":time(6000),"status":"success","arguments":{"file_path":"child.txt"},"result":"child result","decisionId":"decision","executorName":"sandbox"}]));
            let spans = convert(rows.clone()).await;
            assert_eq!(spans.len(), 2);
            let task = spans.iter().find(|s| kind(s) == "TASK").unwrap();
            let tool = spans.iter().find(|s| kind(s) == "TOOL").unwrap();
            assert_eq!(tool.parent_span_id.as_deref(), Some(task.span_id.as_str()));
            assert_eq!(tool.trace_id, task.trace_id);
            assert_eq!(task.attributes["input.value"], "visible task input");
            assert_eq!(task.attributes["output.mime_type"], "text/plain");
            assert_eq!(
                task.links[0]["context"]["spanId"],
                super::super::doubao_work_converter::root_agent_span_id(&"a".repeat(32))
            );
            assert_eq!(ns(task.end_time), EPOCH + end * 1_000_000);
            if end > 10_000 {
                assert!(task.parent_span_id.is_none());
                assert_ne!(task.trace_id, "a".repeat(32));
                assert_eq!(
                    task.attributes["loongsuite.doubao_work.trace_parent_resolution"],
                    "linked_client_request"
                );
            } else {
                assert_eq!(task.parent_span_id.as_deref(), Some("1234567890abcdef"));
                assert_eq!(task.trace_id, "a".repeat(32));
            }
            assert_eq!(ids(&spans), ids(&convert(rows).await));
        }
    }

    #[tokio::test]
    async fn invalid_legacy_fragments_or_unproved_request_boundaries_export_nothing() {
        for failure in [
            "fragment",
            "missing-end",
            "same-time",
            "bad-time",
            "wrong-session",
            "wrong-turn",
            "extra-boundary",
        ] {
            let mut rows = records(&"a".repeat(32));
            match failure {
                "fragment" => {
                    for row in &mut rows {
                        row.extra.insert(
                            "loongsuite.doubao_work.observation_scope".into(),
                            "native_local_tool_fragment".into(),
                        );
                    }
                }
                "missing-end" => {
                    rows.pop();
                }
                "same-time" => rows[1].time_unix_nano = rows[0].time_unix_nano.clone(),
                "bad-time" => rows[0].time_unix_nano = "123".into(),
                "wrong-session" => rows[1].session_id = "other".into(),
                "wrong-turn" => rows[1].turn_id = Some("other".into()),
                "extra-boundary" => {
                    let mut more = rows[0].clone();
                    more.event_id = "extra-start".into();
                    rows.insert(1, more);
                }
                _ => unreachable!(),
            }
            assert!(convert(rows).await.is_empty(), "{failure}");
        }
        for failure in ["root-before", "no-root", "bad-span"] {
            let mut rows = task("invalid", 4000, 9000, None);
            match failure {
                "root-before" => {
                    rows[0].extra.insert(
                        "loongsuite.doubao_work.root_request_start_unix_nano".into(),
                        time(5000).into(),
                    );
                }
                "no-root" => {
                    rows[0]
                        .extra
                        .remove("loongsuite.doubao_work.root_request_end_unix_nano");
                }
                "bad-span" => {
                    rows[0].extra.insert(
                        "loongsuite.doubao_work.local_execution_span_id".into(),
                        "bad".into(),
                    );
                }
                _ => unreachable!(),
            }
            assert!(convert(rows).await.is_empty(), "{failure}");
        }
    }

    #[tokio::test]
    async fn four_visible_rounds_preserve_parallel_tool_anchors_exact_messages_and_stable_ids() {
        let mut rows = with_tools(&[
            ("write", 1000, 1100, "success"),
            ("a", 2000, 2300, "success"),
            ("b", 2100, 2400, "success"),
            ("c", 2200, 2500, "error"),
            ("recover", 5000, 5200, "success"),
        ]);
        rounds(
            &mut rows,
            vec![
                round(
                    1,
                    &[("write", "Read", true, None)],
                    json!([{"role":"user","parts":[{"type":"text","content":"VISIBLE_INPUT"}]}]),
                    json!([{"role":"assistant","parts":[{"type":"tool_call","id":"write"}]}]),
                ),
                round(
                    2,
                    &[
                        ("a", "Read", true, None),
                        ("b", "Read", true, None),
                        ("c", "Read", true, None),
                    ],
                    json!([{"role":"tool","parts":[{"type":"text","content":"write result"}]}]),
                    json!([{"role":"assistant","parts":[{"type":"tool_call","id":"a"},{"type":"tool_call","id":"b"},{"type":"tool_call","id":"c"}]}]),
                ),
                round(3, &[("recover", "Read", true, None)], json!([]), json!([])),
                round(
                    4,
                    &[],
                    json!([]),
                    json!([{"role":"assistant","parts":[{"type":"text","content":"visible final"}]}]),
                ),
            ],
        );
        let spans = convert(rows.clone()).await;
        assert_eq!(spans.len(), 15);
        let llms: Vec<_> = spans.iter().filter(|s| kind(s) == "LLM").collect();
        assert_eq!(llms.len(), 4);
        let originals = rows[0].extra["agent.doubao_work.assistant_rounds"]["rounds"]
            .as_array()
            .unwrap();
        for (span, original) in llms.iter().zip(originals) {
            assert_eq!(
                span.attributes["gen_ai.input.messages"],
                original["inputMessages"].to_string()
            );
            assert_eq!(
                span.attributes["gen_ai.output.messages"],
                original["outputMessages"].to_string()
            );
        }

        assert_eq!(
            llms.iter()
                .map(|s| (ns(s.start_time) - EPOCH, ns(s.end_time) - EPOCH))
                .collect::<Vec<_>>(),
            [
                (0, 1_000_000_000),
                (1_100_000_000, 2_000_000_000),
                (2_500_000_000, 5_000_000_000),
                (5_200_000_000, 10_000_123_000)
            ]
        );
        assert!(llms[0].attributes["gen_ai.input.messages"]
            .as_str()
            .unwrap()
            .contains("VISIBLE_INPUT"));
        let output: Value = serde_json::from_str(
            llms[1].attributes["gen_ai.output.messages"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(output[0]["parts"].as_array().unwrap().len(), 3);
        for tool in spans.iter().filter(|s| kind(s) == "TOOL") {
            let step = spans
                .iter()
                .find(|s| Some(s.span_id.as_str()) == tool.parent_span_id.as_deref())
                .unwrap();
            assert_eq!(kind(step), "STEP");
            assert!(
                ns(step.start_time) <= ns(tool.start_time)
                    && ns(step.end_time) >= ns(tool.end_time)
            );
        }
        for llm in llms {
            assert_eq!(llm.name, "chat");
            assert_eq!(llm.status["code"], 0);
            assert!(
                !llm.attributes.keys().any(|k| k.starts_with("gen_ai.usage.")
                    || matches!(
                        k.as_str(),
                        "gen_ai.request.model" | "gen_ai.response.id" | "gen_ai.response.model"
                    ))
            );
        }
        assert_eq!(ids(&spans), ids(&convert(rows).await));
        assert_eq!(
            spans
                .iter()
                .map(|s| &s.span_id)
                .collect::<HashSet<_>>()
                .len(),
            15
        );
    }

    #[tokio::test]
    async fn untimed_coordination_is_interpolated_between_native_anchors_and_error_is_preserved() {
        let mut rows = with_tools(&[("local", 6000, 6500, "success")]);
        rounds(
            &mut rows,
            vec![
                round(
                    1,
                    &[(
                        "create",
                        "create_agent",
                        true,
                        Some("create_agent failed: capacity limit"),
                    )],
                    json!([]),
                    json!([]),
                ),
                round(
                    2,
                    &[("send", "send_message", true, Some("send_message ok"))],
                    json!([]),
                    json!([]),
                ),
                round(3, &[("local", "Read", true, None)], json!([]), json!([])),
                round(4, &[], json!([]), json!([])),
            ],
        );
        let spans = convert(rows).await;
        let create = spans
            .iter()
            .find(|s| s.attributes.get("gen_ai.tool.call.id") == Some(&json!("create")))
            .unwrap();
        assert_eq!(
            (ns(create.start_time) - EPOCH, ns(create.end_time) - EPOCH),
            (1_200_000_000, 2_400_000_000)
        );
        assert_eq!(create.status["code"], 2);
        assert_eq!(
            create.attributes["gen_ai.tool.call.result"],
            "create_agent failed: capacity limit"
        );
        let send = spans
            .iter()
            .find(|s| s.attributes.get("gen_ai.tool.call.id") == Some(&json!("send")))
            .unwrap();
        assert_eq!(
            (ns(send.start_time) - EPOCH, ns(send.end_time) - EPOCH),
            (3_600_000_000, 4_800_000_000)
        );
        assert!(!send.attributes.contains_key("tool.result.status"));
    }

    #[tokio::test]
    async fn explicit_native_wait_interval_is_excluded_from_estimated_model_latency() {
        let mut rows = with_tools(&[("local", 9000, 9100, "success")]);
        let wait=json!({"started_at":"2025-10-09T08:53:24Z","ended_at":"2025-10-09T08:53:28Z","actual_waited_seconds":4}).to_string();
        // Derive RFC3339 from the isolated synthetic epoch instead of a wall clock.
        let start =
            chrono::DateTime::from_timestamp(((EPOCH + 4_000_000_000) / 1_000_000_000) as i64, 0)
                .unwrap()
                .to_rfc3339();
        let end =
            chrono::DateTime::from_timestamp(((EPOCH + 8_000_000_000) / 1_000_000_000) as i64, 0)
                .unwrap()
                .to_rfc3339();
        let mut parsed: Value = serde_json::from_str(&wait).unwrap();
        parsed["started_at"] = json!(start);
        parsed["ended_at"] = json!(end);
        let wait = parsed.to_string();
        rounds(
            &mut rows,
            vec![
                round(
                    1,
                    &[("wait", "Wait", true, Some(&wait))],
                    json!([]),
                    json!([]),
                ),
                round(2, &[("local", "Read", true, None)], json!([]), json!([])),
                round(3, &[], json!([]), json!([])),
            ],
        );
        let spans = convert(rows).await;
        let first = spans.iter().find(|s| kind(s) == "LLM").unwrap();
        assert_eq!(ns(first.end_time), EPOCH + 4_000_000_000);
        let wait = spans
            .iter()
            .find(|s| s.attributes.get("gen_ai.tool.call.id") == Some(&json!("wait")))
            .unwrap();
        assert_eq!(
            (ns(wait.start_time), ns(wait.end_time)),
            (EPOCH + 4_000_000_000, EPOCH + 8_000_000_000)
        );
    }

    #[tokio::test]
    async fn orphan_intent_and_inconsistent_round_order_keep_native_facts_without_fabrication() {
        let mut rows = records(&"a".repeat(32));
        rounds(
            &mut rows,
            vec![
                round(
                    1,
                    &[("unfinished", "Read", false, None)],
                    json!([]),
                    json!([]),
                ),
                round(2, &[], json!([]), json!([])),
            ],
        );
        let spans = convert(rows).await;
        assert_eq!(spans.iter().filter(|s| kind(s) == "LLM").count(), 2);
        assert!(!spans.iter().any(|s| kind(s) == "TOOL"));
        let mut rows = with_tools(&[
            ("late", 6000, 6500, "success"),
            ("early", 2000, 2500, "success"),
        ]);
        rounds(
            &mut rows,
            vec![
                round(1, &[("late", "Read", true, None)], json!([]), json!([])),
                round(2, &[("early", "Read", true, None)], json!([]), json!([])),
            ],
        );
        let spans = convert(rows).await;
        assert_eq!(spans.iter().filter(|s| kind(s) == "TOOL").count(), 2);
        assert!(!spans.iter().any(|s| matches!(kind(s), "LLM" | "STEP")));
        let owner = spans.iter().find(|s| kind(s) == "AGENT").unwrap();
        assert_eq!(
            owner.attributes["loongsuite.doubao_work.assistant_rounds_not_in_span"],
            2
        );
    }

    #[tokio::test]
    async fn contained_and_background_task_rounds_keep_exact_owner_turn_fallback_and_time_bounds() {
        for (start, end) in [(5000, 8000), (2000, 12000), (11000, 15000)] {
            let mut rows = task("child-rounds", start, end, None);
            for row in &mut rows {
                row.turn_id = None;
            }
            let a = start + 1000;
            let b = start + 1500;
            rows[0].extra.insert("agent.doubao_work.tool_observations".into(),json!([{"callId":"child-read","name":"Read","startNano":time(a),"endNano":time(b),"status":"success","arguments":{"file_path":"child.txt"},"result":"CHILD_RESULT"}]));
            let input = json!([{"role":"user","parts":[{"type":"text","content":"CHILD_INPUT"}]}]);
            let intermediate = json!([{"role":"assistant","parts":[{"type":"tool_call","id":"child-read","name":"Read"}]}]);
            rounds(
                &mut rows,
                vec![
                    round(
                        1,
                        &[("child-read", "Read", true, None)],
                        input.clone(),
                        intermediate.clone(),
                    ),
                    round(
                        2,
                        &[],
                        json!([{"role":"tool","parts":[{"type":"text","content":"CHILD_RESULT"}]}]),
                        json!([{"role":"assistant","parts":[{"type":"text","content":"CHILD_FINAL"}]}]),
                    ),
                ],
            );
            let facts = rows.clone();
            let spans = convert(rows).await;
            assert_eq!(spans.len(), 6);
            let owner = spans.iter().find(|s| kind(s) == "TASK").unwrap();
            let llms: Vec<_> = spans.iter().filter(|s| kind(s) == "LLM").collect();
            assert_eq!(llms.len(), 2);
            assert_eq!(
                llms.iter()
                    .map(|s| (ns(s.start_time), ns(s.end_time)))
                    .collect::<Vec<_>>(),
                [
                    (EPOCH + start * 1_000_000, EPOCH + a * 1_000_000),
                    (EPOCH + b * 1_000_000, EPOCH + end * 1_000_000)
                ]
            );
            assert_eq!(
                llms[0].attributes["gen_ai.input.messages"],
                input.to_string()
            );
            assert_eq!(
                llms[0].attributes["gen_ai.output.messages"],
                intermediate.to_string()
            );
            assert!(llms[1].attributes["gen_ai.input.messages"]
                .as_str()
                .unwrap()
                .contains("CHILD_RESULT"));
            assert!(llms[1].attributes["gen_ai.output.messages"]
                .as_str()
                .unwrap()
                .contains("CHILD_FINAL"));
            for span in spans
                .iter()
                .filter(|s| matches!(kind(s), "LLM" | "STEP" | "TOOL"))
            {
                assert_eq!(span.trace_id, owner.trace_id);
                assert_eq!(span.attributes["gen_ai.agent.id"], "child-rounds");
                assert_eq!(span.attributes["gen_ai.turn.id"], "reused-turn");
                assert!(
                    ns(span.start_time) >= ns(owner.start_time)
                        && ns(span.end_time) <= ns(owner.end_time)
                );
            }
            for step in spans.iter().filter(|s| kind(s) == "STEP") {
                assert_eq!(step.parent_span_id.as_deref(), Some(owner.span_id.as_str()));
            }
            let tool = spans.iter().find(|s| kind(s) == "TOOL").unwrap();
            let step = spans
                .iter()
                .find(|s| Some(s.span_id.as_str()) == tool.parent_span_id.as_deref())
                .unwrap();
            assert_eq!(kind(step), "STEP");

            if end > 10_000 {
                assert!(owner.parent_span_id.is_none());
                assert_ne!(owner.trace_id, "a".repeat(32));
            } else {
                assert_eq!(
                    owner.parent_span_id.as_deref(),
                    Some(
                        super::super::doubao_work_converter::root_agent_span_id(&"a".repeat(32))
                            .as_str()
                    )
                );
            }
            assert_eq!(ids(&spans), ids(&convert(facts).await));
        }
    }

    #[tokio::test]
    async fn mask_native_task_tool_and_round_content_before_real_span_and_json_projection() {
        let secret = format!("sk-{}", "x".repeat(24));
        let mut rows = task("masked-child", 4000, 9000, None);
        rows[0]
            .extra
            .insert("agent.doubao_work.task_input".into(), secret.clone().into());
        rows[0].extra.insert(
            "agent.doubao_work.task_output".into(),
            secret.clone().into(),
        );
        rows[0].extra.insert("agent.doubao_work.tool_observations".into(),json!([{"callId":"masked-read","name":"Read","startNano":time(5000),"endNano":time(6000),"status":"success","arguments":{"key":secret},"result":secret}]));
        rounds(
            &mut rows,
            vec![round(
                1,
                &[("masked-read", "Read", true, Some(&secret))],
                json!([{"role":"user","parts":[{"type":"text","content":secret}]}]),
                json!([{"role":"assistant","parts":[{"type":"text","content":secret}]}]),
            )],
        );
        let config = crate::types::MaskConfig {
            mode: crate::types::MaskMode::All,
            types: vec![],
            replacement_mode: None,
        };
        let rows: Vec<_> = rows
            .iter()
            .map(|entry| {
                crate::mask::mask_agent_activity_entry(entry, &config, None, None).into_owned()
            })
            .collect();
        assert!(!serde_json::to_string(&rows).unwrap().contains(&secret));
        assert!(rows[0]
            .extra
            .get("agent.doubao_work.tool_observations")
            .unwrap()
            .is_array());
        let spans = convert(rows).await;
        assert_eq!(spans.len(), 4);
        assert!(spans.iter().any(|s| kind(s) == "TASK"));
        assert!(spans.iter().any(|s| kind(s) == "TOOL"));
        assert!(spans.iter().any(|s| kind(s) == "LLM"));
        let projected = create_readable_span_to_otlp_span_json_array(&spans).join("\n");
        assert!(!projected.contains(&secret));
        let owner = spans.iter().find(|s| kind(s) == "TASK").unwrap();
        assert_ne!(owner.attributes["input.value"], secret);
        assert_ne!(owner.attributes["output.value"], secret);
        let tool = spans.iter().find(|s| kind(s) == "TOOL").unwrap();
        assert!(
            tool.attributes.contains_key("gen_ai.tool.call.arguments")
                && tool.attributes.contains_key("gen_ai.tool.call.result")
        );
    }

    #[tokio::test]
    async fn duplicate_round_ids_call_ids_and_invalid_round_payload_cannot_create_synthetic_models()
    {
        for failure in [
            "round-id",
            "call-id",
            "invalid-tool",
            "invalid-messages",
            "too-many",
        ] {
            let mut rows = with_tools(&[("local", 1000, 1500, "success")]);
            let mut values = vec![
                round(1, &[("local", "Read", true, None)], json!([]), json!([])),
                round(2, &[], json!([]), json!([])),
            ];
            match failure {
                "round-id" => values[1]["id"] = values[0]["id"].clone(),
                "call-id" => {
                    values[1] = round(2, &[("local", "Read", true, None)], json!([]), json!([]))
                }
                "invalid-tool" => values[0]["tools"][0]["completed"] = json!("yes"),
                "invalid-messages" => values[0]["inputMessages"] = json!({}),
                "too-many" => {
                    values = (1..=65)
                        .map(|n| round(n, &[], json!([]), json!([])))
                        .collect()
                }
                _ => unreachable!(),
            }
            rounds(&mut rows, values);
            let spans = convert(rows).await;
            assert_eq!(spans.iter().filter(|s| kind(s) == "TOOL").count(), 1);
            assert!(
                !spans.iter().any(|s| matches!(kind(s), "LLM" | "STEP")),
                "{failure}"
            );
        }
    }

    #[tokio::test]
    async fn root_client_nested_tasks_and_background_links_do_not_stretch_or_duplicate_invocations()
    {
        let (f, capture, _dir) = collector();
        let request = records(&"a".repeat(32));
        let root_end = request[1].time_unix_nano.clone();
        f.send_batch(request, None).await.unwrap();
        let organizer = task("organizer", 4000, 9000, None);
        let organizer_id = super::super::doubao_work_converter::digest("organizer", 16);
        f.send_batch(organizer, None).await.unwrap();
        let child = task("child", 5000, 8000, Some(&organizer_id));
        f.send_batch(child, None).await.unwrap();
        let background = task("background", 5000, 12_000, None);
        f.send_batch(background, None).await.unwrap();
        let spans = capture.0.lock().unwrap().clone();
        assert_eq!(spans.len(), 5);
        assert_eq!(spans.iter().filter(|s| kind(s) == "AGENT").count(), 1);
        assert_eq!(spans.iter().filter(|s| kind(s) == "ENTRY").count(), 1);
        let agent = spans.iter().find(|s| kind(s) == "AGENT").unwrap();
        let organizer = spans
            .iter()
            .find(|s| s.attributes.get("gen_ai.agent.id") == Some(&json!("organizer")))
            .unwrap();
        let child = spans
            .iter()
            .find(|s| s.attributes.get("gen_ai.agent.id") == Some(&json!("child")))
            .unwrap();
        let background = spans
            .iter()
            .find(|s| s.attributes.get("gen_ai.agent.id") == Some(&json!("background")))
            .unwrap();
        assert_eq!(
            organizer.parent_span_id.as_deref(),
            Some(agent.span_id.as_str())
        );
        assert_eq!(organizer.links[0]["context"]["spanId"], agent.span_id);
        assert_eq!(
            child.parent_span_id.as_deref(),
            Some(organizer.span_id.as_str())
        );
        assert_eq!(background.links[0]["context"]["traceId"], agent.trace_id);
        assert_eq!(background.links[0]["context"]["spanId"], agent.span_id);
        assert!(background.parent_span_id.is_none());
        assert_ne!(background.trace_id, agent.trace_id);
        for root in spans
            .iter()
            .filter(|s| matches!(kind(s), "AGENT" | "ENTRY"))
        {
            assert_eq!(hr_time_to_nano(root.end_time), root_end);
        }
        f.flush().await.unwrap();
        assert_eq!(capture.0.lock().unwrap().len(), 5);
        f.shutdown().await.unwrap();
    }
}

#[cfg(test)]
#[path = "codex_native_turn_main_tests.rs"]
mod codex_native_turn_main_tests;

#[cfg(test)]
#[path = "qoder_turn_main_tests.rs"]
mod qoder_turn_main_tests;

#[cfg(test)]
#[path = "otlp_failed_log_main_tests.rs"]
mod failed_log_main_tests;

#[cfg(test)]
#[path = "otlp_runtime_main_tests.rs"]
mod runtime_main_tests;

#[cfg(test)]
#[path = "otlp_dedup_main_tests.rs"]
mod dedup_main_tests;

#[cfg(test)]
#[path = "otlp_codex_spill_main541_tests.rs"]
mod codex_spill_main541_tests;
