//! Port of `src/flushers/sls-flusher.ts`.
//!
//! AK PutLogs is signed with the Aliyun LOG HMAC-SHA1 scheme and posted through
//! the same HTTP transport as API-key and WebTracking. Undici phase timeouts
//! (`headersTimeout`, `bodyTimeout`) have no direct reqwest equivalent: the
//! overall `timeoutMs` is the request timeout, and `connectTimeoutMs` is the
//! connect timeout when any phase timeout is configured.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use chrono::Local;
use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::base_flusher::{BaseFlusher, FlushError};
use super::sls_error_classifier::{classify_sls_send_error, format_sls_send_failure_message};
use super::sls_failure_log_writer::{FailureError, SlsFailureLogInput, SlsFailureLogWriter};
use super::sls_loggroup_codec::{encode_sls_log_group, SlsLogEntryPayload, SlsLogGroupPayload};
use super::sls_transport::{
    build_project_request_target, is_retryable, json_utf8_len, post_api_key_log_store_logs,
    send_error_node, signed_ak_headers, sleep_ms, HttpError, PostApiKeyOptions, ReqwestSlsHttp,
    SendError, SlsHttp, SlsHttpRequest, SlsTransportConfig, RETRYABLE_STATUS_CODES,
    RETRY_BASE_DELAY_MS, RETRY_MAX_ATTEMPTS, WEBTRACKING_MAX_BODY_BYTES, WEBTRACKING_MAX_LOGS,
};
use crate::normalization::{
    redact_code_generation_fields, serialise_log_entry, SerialiseLogEntryOptions,
};
use crate::types::{AgentActivityEntry, SlsEndpoint, SlsFlusherConfig, SlsMode};
use crate::utils::{
    build_user_agent, create_logger, format_time, local_ip, normalize_agent_type,
    read_installed_version,
};

const BATCH_MAX_SIZE: usize = 20;
const FLUSH_INTERVAL_MS: u64 = 2000;
const DEFAULT_FLUSH_CONCURRENCY: usize = 3;
const DEFAULT_OVERALL_TIMEOUT_MS: u64 = 30_000;
const MAX_BACKOFF_MS: f64 = 60_000.0;

#[derive(Clone, Debug)]
struct QueuedLog {
    content: IndexMap<String, String>,
    endpoint: SlsEndpoint,
    agent_type: String,
    byte_size: usize,
}

#[derive(Clone, Debug, Default)]
pub struct EndpointCounter {
    pub in_entries: u64,
    pub in_bytes: u64,
    pub out_entries: u64,
    pub out_bytes: u64,
    pub out_failed: u64,
    pub total_delay_ms: u64,
    pub last_flush_time: String,
    pub start_time: String,
    pub mode: String,
    pub project: String,
    pub logstore: String,
}

#[derive(Clone, Debug, Default)]
struct FlushOutcome {
    sent_entries: u64,
    sent_bytes: u64,
    failed_entries: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AkClientInit {
    pub endpoint: String,
    pub access_key_id: String,
}

pub trait AlarmSink: Send + Sync {
    fn record(&self, kind: &str, level: &str, message: &str, endpoint_name: &str);
}

#[async_trait]
pub trait AkPoster: Send + Sync {
    async fn post_log_store_logs(
        &self,
        endpoint: &SlsEndpoint,
        project: &str,
        logstore: &str,
        group: &SlsLogGroupPayload,
        user_agent: &str,
    ) -> Result<(), SendError>;
}

pub struct SigningAkPoster {
    http: Arc<dyn SlsHttp>,
    timeout_ms: u64,
}

#[async_trait]
impl AkPoster for SigningAkPoster {
    async fn post_log_store_logs(
        &self,
        endpoint: &SlsEndpoint,
        project: &str,
        logstore: &str,
        group: &SlsLogGroupPayload,
        user_agent: &str,
    ) -> Result<(), SendError> {
        let body = encode_sls_log_group(group);
        let path = format!("/logstores/{logstore}/shards/lb");
        let target = build_project_request_target(&endpoint.endpoint, project, &path);
        let headers = signed_ak_headers(
            "POST",
            &path,
            &body,
            endpoint.access_key_id.as_deref().unwrap_or(""),
            endpoint.access_key_secret.as_deref().unwrap_or(""),
            Some(user_agent),
            target.host_header.as_deref(),
        );
        let response = self
            .http
            .post(SlsHttpRequest {
                url: target.url,
                body,
                headers,
                timeout: Duration::from_millis(self.timeout_ms),
            })
            .await?;
        if (200..300).contains(&response.status) {
            Ok(())
        } else {
            Err(SendError::Http(HttpError::new(
                response.status,
                response.body,
            )))
        }
    }
}

struct SlsState {
    queue: IndexMap<String, Vec<QueuedLog>>,
    flushing: bool,
    counters: HashMap<String, EndpointCounter>,
    ak_inits: Vec<AkClientInit>,
    ak_ready: HashSet<String>,
}

pub struct SlsFlusher {
    inner: Arc<SlsInner>,
}

struct SlsInner {
    config: SlsFlusherConfig,
    state: Mutex<SlsState>,
    writer: SlsFailureLogWriter,
    http: Arc<dyn SlsHttp>,
    ak: Arc<dyn AkPoster>,
    alarm: Mutex<Option<Arc<dyn AlarmSink>>>,
    service_name: String,
    service_name_prefix: String,
    user_agent: String,
    pilot_version: String,
    timeout_ms: u64,
    retry_max_attempts: u32,
    retry_base_delay_ms: f64,
    retry_jitter: bool,
    flush_concurrency: usize,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

pub fn compute_backoff(base_ms: f64, attempt: u32, jitter: bool) -> f64 {
    let shift = attempt.min(30);
    let exponential = (base_ms * 2_f64.powi(shift as i32)).min(MAX_BACKOFF_MS);
    if !jitter {
        return exponential;
    }
    (exponential * (0.5 + random_unit() * 0.5)).round()
}

fn random_unit() -> f64 {
    static SEQ: AtomicU64 = AtomicU64::new(0x1234_5678);
    let mixed = SEQ.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mixed = mixed.wrapping_mul(0xBF58_476D_1CE4_E5B9) ^ nanos;
    (mixed >> 11) as f64 / ((1_u64 << 53) as f64)
}

fn hostname() -> String {
    static HOST: OnceLock<String> = OnceLock::new();
    HOST.get_or_init(|| {
        hostname::get()
            .ok()
            .and_then(|value| value.into_string().ok())
            .unwrap_or_default()
    })
    .clone()
}

impl SlsFlusher {
    pub fn new(config: SlsFlusherConfig, data_dir: &str) -> Self {
        let timeout_ms = config
            .timeout
            .as_ref()
            .and_then(|timeout| timeout.timeout_ms)
            .unwrap_or(DEFAULT_OVERALL_TIMEOUT_MS);
        let http: Arc<dyn SlsHttp> = Arc::new(ReqwestSlsHttp::new());
        let ak: Arc<dyn AkPoster> = Arc::new(SigningAkPoster {
            http: Arc::clone(&http),
            timeout_ms,
        });
        Self::with_io(config, data_dir, None, http, ak)
    }

    pub fn with_io(
        config: SlsFlusherConfig,
        data_dir: &str,
        pilot_version: Option<String>,
        http: Arc<dyn SlsHttp>,
        ak: Arc<dyn AkPoster>,
    ) -> Self {
        let mut counters = HashMap::new();
        for endpoint in &config.endpoints {
            counters.insert(
                endpoint.name.clone(),
                EndpointCounter {
                    mode: endpoint.mode.as_str().to_string(),
                    project: endpoint.project.clone(),
                    logstore: endpoint.logstore.clone(),
                    ..EndpointCounter::default()
                },
            );
        }
        let retry = config.retry.clone().unwrap_or_default();
        let timeout = config.timeout.clone().unwrap_or_default();
        let inner = Arc::new(SlsInner {
            service_name: config
                .service_name
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or_default(),
            service_name_prefix: config.service_name_prefix.clone(),
            user_agent: build_user_agent(data_dir),
            pilot_version: pilot_version.unwrap_or_else(|| read_installed_version(data_dir)),
            timeout_ms: timeout.timeout_ms.unwrap_or(DEFAULT_OVERALL_TIMEOUT_MS),
            retry_max_attempts: retry
                .retry_max_attempts
                .unwrap_or(RETRY_MAX_ATTEMPTS)
                .max(1),
            retry_base_delay_ms: retry.retry_base_delay_ms.unwrap_or(RETRY_BASE_DELAY_MS) as f64,
            retry_jitter: retry.retry_jitter.unwrap_or(true),
            flush_concurrency: config
                .flush_concurrency
                .unwrap_or(DEFAULT_FLUSH_CONCURRENCY)
                .max(1),
            writer: SlsFailureLogWriter::new(
                std::path::Path::new(data_dir)
                    .join("logs")
                    .join("sls-failed-logs"),
            ),
            http,
            ak,
            alarm: Mutex::new(None),
            timer: Mutex::new(None),
            state: Mutex::new(SlsState {
                queue: IndexMap::new(),
                flushing: false,
                counters,
                ak_inits: Vec::new(),
                ak_ready: HashSet::new(),
            }),
            config,
        });
        Self { inner }
    }

    pub fn endpoint_counters(&self) -> HashMap<String, EndpointCounter> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .counters
            .clone()
    }

    pub fn ak_client_inits(&self) -> Vec<AkClientInit> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .ak_inits
            .clone()
    }

    pub fn failed_log_directory(&self) -> &std::path::Path {
        self.inner.writer.directory()
    }

    pub fn set_alarm_manager(&self, alarm: Arc<dyn AlarmSink>) {
        *self
            .inner
            .alarm
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(alarm);
    }
}

#[async_trait]
impl BaseFlusher for SlsFlusher {
    fn name(&self) -> &str {
        "sls"
    }

    async fn start(&self) -> Result<(), FlushError> {
        self.inner.writer.start().await;
        let interval = if self.inner.config.flush_interval_ms == 0 {
            FLUSH_INTERVAL_MS
        } else {
            self.inner.config.flush_interval_ms
        };
        let inner = Arc::clone(&self.inner);
        let handle = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(interval));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                inner.flush_queue().await;
            }
        });
        *self
            .inner
            .timer
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(handle);
        Ok(())
    }

    async fn send(
        &self,
        entry: AgentActivityEntry,
        _logical_bytes: Option<f64>,
    ) -> Result<(), FlushError> {
        let agent = normalize_agent_type(&entry.agent_type);
        if matches!(agent.as_str(), "codex" | "doubao-work") {
            return self
                .inner
                .accept_tracked(std::slice::from_ref(&entry))
                .await;
        }
        self.inner.enqueue_entry(&entry).await;
        Ok(())
    }

    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        _logical_bytes: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        let mut tracked: IndexMap<String, Vec<AgentActivityEntry>> = IndexMap::new();
        for entry in entries {
            let agent = normalize_agent_type(&entry.agent_type);
            if matches!(agent.as_str(), "codex" | "doubao-work") {
                tracked.entry(agent).or_default().push(entry);
            } else {
                Arc::clone(&self.inner).enqueue_entry(&entry).await;
            }
        }
        for group in tracked.values() {
            self.inner.accept_tracked(group).await?;
        }
        Ok(())
    }

    async fn flush(&self) -> Result<(), FlushError> {
        Arc::clone(&self.inner).flush_queue().await;
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), FlushError> {
        if let Some(handle) = self
            .inner
            .timer
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
        {
            handle.abort();
        }
        Arc::clone(&self.inner).flush_queue().await;
        Ok(())
    }

    async fn send_raw(&self, topic: &str, payload: &Map<String, Value>) -> Result<(), FlushError> {
        self.inner.send_raw(topic, payload).await;
        Ok(())
    }
}

impl SlsInner {
    async fn accept_tracked(
        self: &Arc<Self>,
        entries: &[AgentActivityEntry],
    ) -> Result<(), FlushError> {
        let agent = normalize_agent_type(&entries[0].agent_type);
        let owner = if agent == "codex" {
            "Codex"
        } else {
            "Doubao Work"
        };
        let serialized: Vec<_> = entries
            .iter()
            .map(|entry| {
                let mut content = serialise_log_entry(
                    entry,
                    &SerialiseLogEntryOptions {
                        drop_agent_scoped_fields: true,
                    },
                );
                content.insert("version".into(), self.pilot_version.clone());
                content
            })
            .collect();
        let capacity = Arc::new(tokio::sync::Semaphore::new(self.flush_concurrency));
        let mut pending = tokio::task::JoinSet::new();
        for endpoint in &self.config.endpoints {
            let logs: Vec<_> = serialized
                .iter()
                .map(|content| {
                    let content = if endpoint.redact == Some(true) {
                        redact_code_generation_fields(content)
                    } else {
                        content.clone()
                    };
                    QueuedLog {
                        byte_size: json_utf8_len(&content),
                        content,
                        endpoint: endpoint.clone(),
                        agent_type: agent.clone(),
                    }
                })
                .collect();
            {
                let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                if let Some(counter) = state.counters.get_mut(&endpoint.name) {
                    counter.in_entries += logs.len() as u64;
                    counter.in_bytes += logs.iter().map(|log| log.byte_size as u64).sum::<u64>();
                    if counter.start_time.is_empty() {
                        counter.start_time = format_time(Local::now());
                    }
                }
            }
            let inner = Arc::clone(self);
            let capacity = Arc::clone(&capacity);
            pending.spawn(async move {
                let _permit = capacity
                    .acquire_owned()
                    .await
                    .expect("tracked output capacity remains open");
                inner.flush_bucket(&logs).await
            });
        }
        let mut accepted = true;
        while let Some(result) = pending.join_next().await {
            accepted &= matches!(result, Ok(true));
        }
        if accepted {
            Ok(())
        } else {
            Err(FlushError::output_durability(owner, "SLS"))
        }
    }

    async fn enqueue_entry(self: &Arc<Self>, entry: &AgentActivityEntry) {
        let mut serialized = serialise_log_entry(
            entry,
            &SerialiseLogEntryOptions {
                drop_agent_scoped_fields: true,
            },
        );
        serialized.insert("version".to_string(), self.pilot_version.clone());
        let agent_type = normalize_agent_type(&entry.agent_type);
        let mut flush_now = false;
        for endpoint in &self.config.endpoints {
            let content = if endpoint.redact == Some(true) {
                redact_code_generation_fields(&serialized)
            } else {
                serialized.clone()
            };
            if self.enqueue(endpoint, content, &agent_type) {
                flush_now = true;
            }
        }
        if flush_now {
            self.flush_queue().await;
        }
    }

    fn enqueue(
        &self,
        endpoint: &SlsEndpoint,
        content: IndexMap<String, String>,
        agent_type: &str,
    ) -> bool {
        let base = format!(
            "{}/{}/{}",
            endpoint.name, endpoint.project, endpoint.logstore
        );
        let key = if !self.effective_service_name(endpoint).is_empty() && !agent_type.is_empty() {
            format!("{base}/{agent_type}")
        } else {
            base
        };
        let byte_size = json_utf8_len(&content);
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        let bucket = state.queue.entry(key).or_default();
        bucket.push(QueuedLog {
            content,
            endpoint: endpoint.clone(),
            agent_type: agent_type.to_string(),
            byte_size,
        });
        let len = bucket.len();
        if let Some(counter) = state.counters.get_mut(&endpoint.name) {
            counter.in_entries += 1;
            counter.in_bytes += byte_size as u64;
            if counter.start_time.is_empty() {
                counter.start_time = format_time(Local::now());
            }
        }
        let max_size = if self.config.batch_max_size == 0 {
            BATCH_MAX_SIZE
        } else {
            self.config.batch_max_size
        };
        len >= max_size
    }

    async fn flush_queue(self: &Arc<Self>) {
        let batches = {
            let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
            if state.flushing {
                return;
            }
            state.flushing = true;
            let queue = std::mem::take(&mut state.queue);
            queue
                .into_values()
                .filter(|logs| !logs.is_empty())
                .collect::<Vec<_>>()
        };
        if !batches.is_empty() {
            create_logger("SlsFlusher").debug(
                "flush dispatching",
                Some(&meta(&[
                    ("buckets", Value::from(batches.len())),
                    (
                        "totalLogs",
                        Value::from(batches.iter().map(|logs| logs.len()).sum::<usize>()),
                    ),
                ])),
            );
        }
        let next = Arc::new(AtomicU64::new(0));
        let shared = Arc::new(batches);
        let workers = self
            .flush_concurrency
            .min(shared.len())
            .max(if shared.is_empty() { 0 } else { 1 });
        let mut set = tokio::task::JoinSet::new();
        for _ in 0..workers {
            let batches = Arc::clone(&shared);
            let inner = Arc::clone(self);
            let next = Arc::clone(&next);
            set.spawn(async move {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst) as usize;
                    if index >= batches.len() {
                        break;
                    }
                    inner.flush_bucket(&batches[index]).await;
                }
            });
        }
        while set.join_next().await.is_some() {}
        self.state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .flushing = false;
    }

    async fn flush_bucket(&self, logs: &[QueuedLog]) -> bool {
        let endpoint = logs[0].endpoint.clone();
        let started = Instant::now();
        let outcome = match endpoint.mode {
            SlsMode::Ak => self.flush_via_ak(&endpoint, logs).await,
            SlsMode::ApiKey => self.flush_via_api_key(&endpoint, logs).await,
            SlsMode::Webtracking => self.flush_via_webtracking(&endpoint, logs).await,
        };
        let accepted = outcome.failed_entries == 0;
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(counter) = state.counters.get_mut(&endpoint.name) {
            counter.out_entries += outcome.sent_entries;
            counter.out_bytes += outcome.sent_bytes;
            counter.out_failed += outcome.failed_entries;
            counter.total_delay_ms += started.elapsed().as_millis() as u64;
            if outcome.sent_entries > 0 {
                counter.last_flush_time = format_time(Local::now());
            }
        }
        accepted
    }

    fn effective_service_name(&self, endpoint: &SlsEndpoint) -> String {
        if !self.service_name.is_empty() {
            return self.service_name.clone();
        }
        if let Some(name) = endpoint
            .service_name
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            return name.to_string();
        }
        self.service_name_prefix.clone()
    }

    fn resolve_service_name(&self, endpoint: &SlsEndpoint, agent_type: Option<&str>) -> String {
        let base = self.effective_service_name(endpoint);
        if base.is_empty() {
            return String::new();
        }
        if !self.service_name.is_empty() {
            return self.service_name.clone();
        }
        match agent_type.filter(|value| !value.is_empty()) {
            Some(agent_type) => format!("{base}-{agent_type}"),
            None => base,
        }
    }

    fn ak_tags(
        &self,
        endpoint: &SlsEndpoint,
        agent_type: Option<&str>,
    ) -> Vec<IndexMap<String, String>> {
        let mut tags = vec![single_tag("__hostname__", &hostname())];
        let name = self.resolve_service_name(endpoint, agent_type);
        if !name.is_empty() {
            tags.push(single_tag("__service_name__", &name));
        }
        tags
    }

    fn web_tags(&self, endpoint: &SlsEndpoint, agent_type: Option<&str>) -> Map<String, Value> {
        let mut tags = Map::new();
        tags.insert("__hostname__".to_string(), Value::String(hostname()));
        let name = self.resolve_service_name(endpoint, agent_type);
        if !name.is_empty() {
            tags.insert("__service_name__".to_string(), Value::String(name));
        }
        tags
    }

    fn log_group(&self, endpoint: &SlsEndpoint, logs: &[QueuedLog]) -> SlsLogGroupPayload {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        SlsLogGroupPayload {
            logs: logs
                .iter()
                .map(|log| SlsLogEntryPayload {
                    timestamp: now,
                    content: log.content.clone(),
                    timestamp_ns_part: None,
                })
                .collect(),
            source: Some(local_ip().to_string()),
            topic: Some(endpoint.kind.as_str().to_string()),
            tags: Some(self.ak_tags(endpoint, logs.first().map(|log| log.agent_type.as_str()))),
        }
    }

    fn note_ak_client(&self, endpoint: &SlsEndpoint) {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if state.ak_ready.insert(endpoint.name.clone()) {
            state.ak_inits.push(AkClientInit {
                endpoint: endpoint.endpoint.clone(),
                access_key_id: endpoint.access_key_id.clone().unwrap_or_default(),
            });
        }
    }

    async fn flush_via_ak(&self, endpoint: &SlsEndpoint, logs: &[QueuedLog]) -> FlushOutcome {
        self.note_ak_client(endpoint);
        let group = self.log_group(endpoint, logs);
        let mut last_err = SendError::Message("unknown ak error".to_string());
        let mut attempts = 0_i64;
        for attempt in 0..self.retry_max_attempts {
            attempts = i64::from(attempt) + 1;
            match self
                .ak
                .post_log_store_logs(
                    endpoint,
                    &endpoint.project,
                    &endpoint.logstore,
                    &group,
                    &self.user_agent,
                )
                .await
            {
                Ok(()) => return succeeded(logs),
                Err(error) => {
                    let stop = !is_retryable(&error) || attempt + 1 == self.retry_max_attempts;
                    last_err = error;
                    if stop {
                        break;
                    }
                }
            }
            let delay = compute_backoff(self.retry_base_delay_ms, attempt, self.retry_jitter);
            sleep_ms(delay as u64).await;
        }
        self.alarm_failure("ak", endpoint, &last_err, attempts);
        self.persist(
            endpoint,
            logs.len() as i64,
            sum_bytes(logs) as i64,
            &last_err,
        )
        .await;
        failed(logs)
    }

    async fn flush_via_api_key(&self, endpoint: &SlsEndpoint, logs: &[QueuedLog]) -> FlushOutcome {
        let group = self.log_group(endpoint, logs);
        let mut last_err = SendError::Message("unknown apiKey error".to_string());
        let mut attempts = 0_i64;
        for attempt in 0..self.retry_max_attempts {
            attempts = i64::from(attempt) + 1;
            let result = post_api_key_log_store_logs(
                &SlsTransportConfig {
                    endpoint: endpoint.endpoint.clone(),
                    project: endpoint.project.clone(),
                    logstore: endpoint.logstore.clone(),
                    timeout_ms: Some(self.timeout_ms),
                    max_retries: Some(1),
                    retry_base_delay_ms: Some(0),
                },
                endpoint.api_key.as_deref().unwrap_or(""),
                &group,
                &PostApiKeyOptions {
                    user_agent: Some(self.user_agent.clone()),
                    ..PostApiKeyOptions::default()
                },
                self.http.as_ref(),
            )
            .await;
            match result {
                Ok(()) => return succeeded(logs),
                Err(error) => {
                    let stop = !is_retryable(&error) || attempt + 1 == self.retry_max_attempts;
                    last_err = error;
                    if stop {
                        break;
                    }
                }
            }
            let delay = compute_backoff(self.retry_base_delay_ms, attempt, self.retry_jitter);
            sleep_ms(delay as u64).await;
        }
        self.alarm_failure("apiKey", endpoint, &last_err, attempts);
        self.persist(
            endpoint,
            logs.len() as i64,
            sum_bytes(logs) as i64,
            &last_err,
        )
        .await;
        failed(logs)
    }

    async fn flush_via_webtracking(
        &self,
        endpoint: &SlsEndpoint,
        logs: &[QueuedLog],
    ) -> FlushOutcome {
        let mut total = FlushOutcome::default();
        for chunk in split_queued(logs) {
            let outcome = self.post_webtracking(endpoint, &chunk).await;
            total.sent_entries += outcome.sent_entries;
            total.sent_bytes += outcome.sent_bytes;
            total.failed_entries += outcome.failed_entries;
        }
        total
    }

    async fn post_webtracking(&self, endpoint: &SlsEndpoint, logs: &[QueuedLog]) -> FlushOutcome {
        let agent_type = logs.first().map(|log| log.agent_type.as_str());
        let mut body = Map::new();
        body.insert(
            "__topic__".to_string(),
            Value::String(endpoint.kind.as_str().to_string()),
        );
        body.insert(
            "__source__".to_string(),
            Value::String(local_ip().to_string()),
        );
        body.insert(
            "__logs__".to_string(),
            Value::Array(
                logs.iter()
                    .map(|log| string_map_value(&log.content))
                    .collect(),
            ),
        );
        body.insert(
            "__tags__".to_string(),
            Value::Object(self.web_tags(endpoint, agent_type)),
        );
        let raw = serde_json::to_string(&Value::Object(body)).unwrap_or_else(|_| "{}".to_string());
        let url = webtracking_url(endpoint);
        let headers = vec![
            ("x-log-apiversion".to_string(), "0.6.0".to_string()),
            ("x-log-bodyrawsize".to_string(), raw.len().to_string()),
            ("content-type".to_string(), "application/json".to_string()),
            ("user-agent".to_string(), self.user_agent.clone()),
        ];
        let mut last_err = SendError::Message("unknown webtracking error".to_string());
        let mut attempts = 0_i64;
        for attempt in 0..self.retry_max_attempts {
            attempts = i64::from(attempt) + 1;
            let result = self
                .http
                .post(SlsHttpRequest {
                    url: url.clone(),
                    body: raw.as_bytes().to_vec(),
                    headers: headers.clone(),
                    timeout: Duration::from_millis(self.timeout_ms),
                })
                .await;
            match result {
                Ok(response) if (200..300).contains(&response.status) => return succeeded(logs),
                Ok(response) => {
                    let error = SendError::Http(HttpError::new(response.status, response.body));
                    let stop = http_error_wait(&error) || attempt + 1 == self.retry_max_attempts;
                    last_err = error;
                    if stop {
                        break;
                    }
                }
                Err(error) => {
                    let stop = http_error_wait(&error) || attempt + 1 == self.retry_max_attempts;
                    last_err = error;
                    if stop {
                        break;
                    }
                }
            }
            let delay = compute_backoff(self.retry_base_delay_ms, attempt, self.retry_jitter);
            sleep_ms(delay as u64).await;
        }
        self.alarm_failure("webtracking", endpoint, &last_err, attempts);
        self.persist(endpoint, logs.len() as i64, raw.len() as i64, &last_err)
            .await;
        failed(logs)
    }

    fn alarm_failure(
        &self,
        transport: &str,
        endpoint: &SlsEndpoint,
        error: &SendError,
        attempts: i64,
    ) {
        let classification = classify_sls_send_error(&send_error_node(error));
        let message = format_sls_send_failure_message(transport, &classification, attempts);
        if let Some(alarm) = self
            .alarm
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_ref()
        {
            alarm.record("FLUSH_SEND_ALARM", "2", &message, &endpoint.name);
            if matches!(error, SendError::Http(http) if http.status == 429) {
                alarm.record(
                    "FLUSH_QUOTA_ALARM",
                    "2",
                    "SLS endpoint throttled (429)",
                    &endpoint.name,
                );
            }
        }
        let _ = RETRYABLE_STATUS_CODES;
    }

    async fn persist(
        &self,
        endpoint: &SlsEndpoint,
        batch_count: i64,
        batch_bytes: i64,
        error: &SendError,
    ) {
        let (type_name, code, status, summary) = match error {
            SendError::Http(http) => (
                "HttpError".to_string(),
                String::new(),
                i64::from(http.status),
                http.to_string(),
            ),
            SendError::Message(message) => ("Error".to_string(), String::new(), 0, message.clone()),
            SendError::Chain(chain) => (
                chain.name.clone(),
                chain.code.clone().unwrap_or_default(),
                chain.status.unwrap_or(0),
                chain.message.clone(),
            ),
        };
        let _ = self
            .writer
            .write(&SlsFailureLogInput {
                endpoint: endpoint.name.clone(),
                mode: endpoint.mode.as_str().to_string(),
                project: endpoint.project.clone(),
                logstore: endpoint.logstore.clone(),
                kind: endpoint.kind.as_str().to_string(),
                batch_count,
                batch_bytes,
                error: FailureError {
                    type_name,
                    code,
                    http_status: status,
                    summary,
                },
            })
            .await;
    }

    async fn send_raw(&self, topic: &str, payload: &Map<String, Value>) {
        let mut content = IndexMap::new();
        content.insert("topic".to_string(), topic.to_string());
        for (key, value) in payload {
            let text = match value {
                Value::String(text) => text.clone(),
                other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_string()),
            };
            content.insert(key.clone(), text);
        }
        for endpoint in &self.config.endpoints {
            if endpoint.kind.as_str() != "mcp" && endpoint.kind.as_str() != "trace" {
                continue;
            }
            let result = match endpoint.mode {
                SlsMode::Ak => {
                    self.note_ak_client(endpoint);
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    let group = SlsLogGroupPayload {
                        logs: vec![SlsLogEntryPayload {
                            timestamp: now,
                            content: content.clone(),
                            timestamp_ns_part: None,
                        }],
                        source: Some(local_ip().to_string()),
                        topic: Some(topic.to_string()),
                        tags: Some(self.ak_tags(endpoint, None)),
                    };
                    self.ak
                        .post_log_store_logs(
                            endpoint,
                            &endpoint.project,
                            &endpoint.logstore,
                            &group,
                            &self.user_agent,
                        )
                        .await
                }
                SlsMode::ApiKey => {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    post_api_key_log_store_logs(
                        &SlsTransportConfig {
                            endpoint: endpoint.endpoint.clone(),
                            project: endpoint.project.clone(),
                            logstore: endpoint.logstore.clone(),
                            timeout_ms: Some(self.timeout_ms),
                            max_retries: Some(1),
                            retry_base_delay_ms: Some(0),
                        },
                        endpoint.api_key.as_deref().unwrap_or(""),
                        &SlsLogGroupPayload {
                            logs: vec![SlsLogEntryPayload {
                                timestamp: now,
                                content: content.clone(),
                                timestamp_ns_part: None,
                            }],
                            source: Some(local_ip().to_string()),
                            topic: Some(topic.to_string()),
                            tags: Some(self.ak_tags(endpoint, None)),
                        },
                        &PostApiKeyOptions {
                            user_agent: Some(self.user_agent.clone()),
                            ..PostApiKeyOptions::default()
                        },
                        self.http.as_ref(),
                    )
                    .await
                }
                SlsMode::Webtracking => {
                    let mut tags = Map::new();
                    tags.insert("__hostname__".to_string(), Value::String(hostname()));
                    super::sls_transport::post_webtracking(
                        &SlsTransportConfig {
                            endpoint: endpoint.endpoint.clone(),
                            project: endpoint.project.clone(),
                            logstore: endpoint.logstore.clone(),
                            timeout_ms: Some(self.timeout_ms),
                            max_retries: None,
                            retry_base_delay_ms: None,
                        },
                        &[content.clone()],
                        &super::sls_transport::PostWebtrackingOptions {
                            topic: Some(topic.to_string()),
                            source: Some(local_ip().to_string()),
                            tags: Some(tags),
                            user_agent: Some(self.user_agent.clone()),
                        },
                        self.http.as_ref(),
                    )
                    .await
                }
            };
            if result.is_err() {
                create_logger("SlsFlusher").warn(
                    "sendRaw failed",
                    Some(&meta(&[
                        ("topic", Value::String(topic.to_string())),
                        ("endpoint", Value::String(endpoint.name.clone())),
                    ])),
                );
            }
        }
    }
}

fn webtracking_url(endpoint: &SlsEndpoint) -> String {
    let base = if endpoint.project.is_empty() {
        endpoint.endpoint.clone()
    } else if let Some(rest) = endpoint.endpoint.strip_prefix("https://") {
        format!("https://{}.{rest}", endpoint.project)
    } else if let Some(rest) = endpoint.endpoint.strip_prefix("http://") {
        format!("http://{}.{rest}", endpoint.project)
    } else {
        endpoint.endpoint.clone()
    };
    format!("{base}/logstores/{}/track", endpoint.logstore)
}

fn split_queued(logs: &[QueuedLog]) -> Vec<Vec<QueuedLog>> {
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    let mut current_size = 0_usize;
    for log in logs {
        let log_size = json_utf8_len(&log.content);
        if !current.is_empty()
            && (current.len() >= WEBTRACKING_MAX_LOGS
                || current_size + log_size > WEBTRACKING_MAX_BODY_BYTES)
        {
            chunks.push(std::mem::take(&mut current));
            current_size = 0;
        }
        current_size += log_size;
        current.push(log.clone());
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn succeeded(logs: &[QueuedLog]) -> FlushOutcome {
    FlushOutcome {
        sent_entries: logs.len() as u64,
        sent_bytes: sum_bytes(logs) as u64,
        failed_entries: 0,
    }
}

fn failed(logs: &[QueuedLog]) -> FlushOutcome {
    FlushOutcome {
        sent_entries: 0,
        sent_bytes: 0,
        failed_entries: logs.len() as u64,
    }
}

fn sum_bytes(logs: &[QueuedLog]) -> usize {
    logs.iter().map(|log| log.byte_size).sum()
}

fn single_tag(key: &str, value: &str) -> IndexMap<String, String> {
    let mut map = IndexMap::new();
    map.insert(key.to_string(), value.to_string());
    map
}

fn string_map_value(map: &IndexMap<String, String>) -> Value {
    let mut out = Map::new();
    for (key, value) in map {
        out.insert(key.clone(), Value::String(value.clone()));
    }
    Value::Object(out)
}

fn meta(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

// `http_error_wait` is defined here as a local alias so the webtracking loop
// stops on a non-retryable HTTP status and keeps going for every other error.
fn http_error_wait(error: &SendError) -> bool {
    matches!(error, SendError::Http(http) if !RETRYABLE_STATUS_CODES.contains(&http.status))
}

#[cfg(test)]
mod tests {
    use super::super::sls_loggroup_codec::SlsLogGroupPayload;
    use super::super::sls_transport::{SendError, SlsHttp, SlsHttpRequest, SlsHttpResponse};
    use super::*;
    use crate::types::{SlsEndpoint, SlsEndpointKind, SlsFlusherConfig, SlsMode, SlsRetryConfig};
    use async_trait::async_trait;
    use serde_json::{json, Map, Value};
    use std::collections::{HashSet, VecDeque};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    pub(super) fn endpoint(
        name: &str,
        mode: SlsMode,
        project: &str,
        logstore: &str,
        kind: SlsEndpointKind,
    ) -> SlsEndpoint {
        SlsEndpoint {
            name: name.to_string(),
            endpoint: "https://cn-hangzhou.log.aliyuncs.com".to_string(),
            project: project.to_string(),
            logstore: logstore.to_string(),
            kind,
            mode,
            access_key_id: Some(format!("{name}-ak")),
            access_key_secret: Some(format!("{name}-sk")),
            api_key: Some(format!("{name}-api-key")),
            redact: Some(false),
            service_name: None,
        }
    }

    pub(super) fn config(endpoints: Vec<SlsEndpoint>) -> SlsFlusherConfig {
        SlsFlusherConfig {
            enabled: true,
            mode: endpoints
                .first()
                .map(|item| item.mode)
                .unwrap_or(SlsMode::Ak),
            access_key_id: "ak".to_string(),
            access_key_secret: "sk".to_string(),
            api_key: String::new(),
            endpoint: "https://cn-hangzhou.log.aliyuncs.com".to_string(),
            endpoints,
            batch_max_size: 20,
            flush_interval_ms: 60_000,
            service_name: None,
            service_name_prefix: String::new(),
            timeout: None,
            retry: None,
            flush_concurrency: None,
        }
    }

    struct RecAk {
        calls: Mutex<Vec<(String, String, SlsLogGroupPayload)>>,
        failures: Mutex<VecDeque<String>>,
        current: AtomicUsize,
        max: AtomicUsize,
    }

    #[async_trait]
    impl AkPoster for RecAk {
        async fn post_log_store_logs(
            &self,
            _endpoint: &SlsEndpoint,
            project: &str,
            logstore: &str,
            group: &SlsLogGroupPayload,
            _user_agent: &str,
        ) -> Result<(), SendError> {
            let now = self.current.fetch_add(1, Ordering::SeqCst) + 1;
            self.max.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(15)).await;
            self.current.fetch_sub(1, Ordering::SeqCst);
            self.calls.lock().unwrap().push((
                project.to_string(),
                logstore.to_string(),
                group.clone(),
            ));
            if let Some(message) = self.failures.lock().unwrap().pop_front() {
                return Err(SendError::Message(message));
            }
            Ok(())
        }
    }

    struct RecHttp {
        calls: Mutex<Vec<SlsHttpRequest>>,
        results: Mutex<VecDeque<Result<super::super::sls_transport::SlsHttpResponse, SendError>>>,
    }

    #[async_trait]
    impl SlsHttp for RecHttp {
        async fn post(&self, request: SlsHttpRequest) -> Result<SlsHttpResponse, SendError> {
            self.calls.lock().unwrap().push(request);
            if let Some(result) = self.results.lock().unwrap().pop_front() {
                return result;
            }
            Ok(SlsHttpResponse {
                status: 200,
                body: String::new(),
            })
        }
    }

    struct RecAlarm {
        messages: Mutex<Vec<String>>,
    }

    impl AlarmSink for RecAlarm {
        fn record(&self, _kind: &str, _level: &str, message: &str, _endpoint_name: &str) {
            self.messages.lock().unwrap().push(message.to_string());
        }
    }

    fn harness(config: SlsFlusherConfig) -> (SlsFlusher, Arc<RecAk>, Arc<RecHttp>) {
        let ak = Arc::new(RecAk {
            calls: Mutex::new(Vec::new()),
            failures: Mutex::new(VecDeque::new()),
            current: AtomicUsize::new(0),
            max: AtomicUsize::new(0),
        });
        let http = Arc::new(RecHttp {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(VecDeque::new()),
        });
        let flusher = SlsFlusher::with_io(
            config,
            "/tmp/data",
            Some("0.0.0-test".to_string()),
            http.clone(),
            ak.clone(),
        );
        (flusher, ak, http)
    }

    #[test]
    fn backoff_is_exponential_capped_and_jittered() {
        assert_eq!(compute_backoff(1000.0, 0, false), 1000.0);
        assert_eq!(compute_backoff(1000.0, 1, false), 2000.0);
        assert_eq!(compute_backoff(1000.0, 2, false), 4000.0);
        assert_eq!(compute_backoff(1000.0, 10, false), 60000.0);
        assert_eq!(compute_backoff(1000.0, 20, false), 60000.0);
        let mut delays = HashSet::new();
        for _ in 0..20 {
            delays.insert(compute_backoff(1000.0, 1, true) as i64);
        }
        assert!(delays.len() > 1);
    }

    #[tokio::test]
    async fn routes_serialised_entries_and_overrides_version() {
        let ep = endpoint(
            "activity",
            SlsMode::Ak,
            "proj-a",
            "store-a",
            SlsEndpointKind::AgentActivity,
        );
        let (flusher, ak, http) = harness(config(vec![ep]));
        let entry = crate::normalization::build_test_entry(&json!({
            "version": "agent-runtime-version",
            "agent.qoder.cwd": "/workspace/project",
            "agent.cursor.hook_event_name": "preToolUse"
        }));
        flusher.send(entry, None).await.unwrap();
        flusher.flush().await.unwrap();
        assert_eq!(ak.calls.lock().unwrap().len(), 1);
        assert!(http.calls.lock().unwrap().is_empty());
        let (project, logstore, group) = ak.calls.lock().unwrap()[0].clone();
        assert_eq!(project, "proj-a");
        assert_eq!(logstore, "store-a");
        assert_eq!(group.logs.len(), 1);
        assert!(group.source.unwrap().contains('.'));
        let content = &group.logs[0].content;
        assert!(content.get("agent.qoder.cwd").is_none());
        assert!(content.get("agent.cursor.hook_event_name").is_none());
        assert_eq!(
            content.get("agent.file_path").map(String::as_str),
            Some("/tmp/test/file.ts")
        );
        assert_eq!(
            content.get("gen_ai.agent.type").map(String::as_str),
            Some("qoder")
        );
        assert_eq!(
            content.get("version").map(String::as_str),
            Some("0.0.0-test")
        );
        let counter = flusher.endpoint_counters().remove("activity").unwrap();
        assert_eq!(counter.out_entries, 1);
        assert!(counter.out_bytes > 0);
        assert_eq!(counter.out_failed, 0);
    }

    #[tokio::test]
    async fn splits_service_names_and_keeps_an_exact_global_name() {
        let user = endpoint(
            "user",
            SlsMode::Ak,
            "p1",
            "l1",
            crate::types::SlsEndpointKind::AgentActivity,
        );
        let mut inner = endpoint(
            "inner",
            SlsMode::Ak,
            "p2",
            "l2",
            crate::types::SlsEndpointKind::AgentActivity,
        );
        inner.service_name = Some("managed-svc".to_string());
        let mut cfg = config(vec![user.clone(), inner]);
        cfg.service_name = Some("shared-service".to_string());
        cfg.service_name_prefix = "legacy-prefix".to_string();
        let (flusher, ak, _) = harness(cfg);
        flusher
            .send(
                crate::normalization::build_test_entry(&json!({"agentType": "claude-code"})),
                None,
            )
            .await
            .unwrap();
        flusher
            .send(
                crate::normalization::build_test_entry(&json!({"agentType": "opencode"})),
                None,
            )
            .await
            .unwrap();
        flusher.flush().await.unwrap();
        assert_eq!(ak.calls.lock().unwrap().len(), 4);
        for (_, _, group) in ak.calls.lock().unwrap().iter() {
            let name = group
                .tags
                .as_ref()
                .unwrap()
                .iter()
                .find_map(|tag| tag.get("__service_name__").cloned());
            assert_eq!(name.as_deref(), Some("shared-service"));
        }
        let _ = user;
    }

    #[tokio::test]
    async fn per_endpoint_service_name_appends_the_agent_type() {
        let user = endpoint(
            "user",
            SlsMode::Ak,
            "p1",
            "l1",
            crate::types::SlsEndpointKind::AgentActivity,
        );
        let mut inner = endpoint(
            "inner",
            SlsMode::Ak,
            "p2",
            "l2",
            crate::types::SlsEndpointKind::AgentActivity,
        );
        inner.service_name = Some("managed-svc".to_string());
        let mut cfg = config(vec![user, inner]);
        cfg.service_name_prefix = "user-svc".to_string();
        let (flusher, ak, _) = harness(cfg);
        flusher
            .send(
                crate::normalization::build_test_entry(&json!({"agentType": "claude-code"})),
                None,
            )
            .await
            .unwrap();
        flusher.flush().await.unwrap();
        let calls = ak.calls.lock().unwrap();
        let name = |project: &str| {
            calls
                .iter()
                .find(|(item, _, _)| item == project)
                .and_then(|(_, _, group)| {
                    group
                        .tags
                        .as_ref()
                        .unwrap()
                        .iter()
                        .find_map(|tag| tag.get("__service_name__").cloned())
                })
        };
        assert_eq!(name("p1").as_deref(), Some("user-svc-claude-code"));
        assert_eq!(name("p2").as_deref(), Some("managed-svc-claude-code"));
    }

    #[tokio::test]
    async fn webtracking_posts_json_and_skips_an_empty_project() {
        let mut ep = endpoint(
            "ep-wt",
            SlsMode::Webtracking,
            "p",
            "l",
            crate::types::SlsEndpointKind::AgentActivity,
        );
        let mut cfg = config(vec![ep.clone()]);
        cfg.service_name_prefix = "loongsuite-pilot".to_string();
        let (flusher, ak, http) = harness(cfg);
        flusher
            .send(
                crate::normalization::build_test_entry(&json!({"agentType": "cursor"})),
                None,
            )
            .await
            .unwrap();
        flusher.flush().await.unwrap();
        assert!(ak.calls.lock().unwrap().is_empty());
        let request = http.calls.lock().unwrap()[0].clone();
        assert!(request.url.contains("p.cn-hangzhou.log.aliyuncs.com"));
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(
            body["__tags__"]["__service_name__"],
            "loongsuite-pilot-cursor"
        );

        ep.project.clear();
        ep.endpoint = "http://127.0.0.1:9999".to_string();
        ep.logstore = "raw".to_string();
        let (flusher, _, http) = harness(config(vec![ep]));
        flusher
            .send(crate::normalization::build_test_entry(&json!({})), None)
            .await
            .unwrap();
        flusher.flush().await.unwrap();
        assert_eq!(
            http.calls.lock().unwrap()[0].url,
            "http://127.0.0.1:9999/logstores/raw/track"
        );
    }

    #[tokio::test]
    async fn failed_batches_are_counted_as_failed_and_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let ak = Arc::new(RecAk {
            calls: Mutex::new(Vec::new()),
            failures: Mutex::new(VecDeque::from(["invalid request".to_string()])),
            current: AtomicUsize::new(0),
            max: AtomicUsize::new(0),
        });
        let http = Arc::new(RecHttp {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(VecDeque::new()),
        });
        let flusher = SlsFlusher::with_io(
            config(vec![endpoint(
                "activity",
                SlsMode::Ak,
                "proj-a",
                "store-a",
                crate::types::SlsEndpointKind::AgentActivity,
            )]),
            dir.path().to_str().unwrap(),
            Some("0.0.0-test".to_string()),
            http,
            ak.clone(),
        );
        flusher
            .send(crate::normalization::build_test_entry(&json!({})), None)
            .await
            .unwrap();
        flusher
            .send(crate::normalization::build_test_entry(&json!({})), None)
            .await
            .unwrap();
        flusher.flush().await.unwrap();
        let counter = flusher.endpoint_counters().remove("activity").unwrap();
        assert_eq!(counter.out_entries, 0);
        assert_eq!(counter.out_bytes, 0);
        assert_eq!(counter.out_failed, 2);
        assert!(counter.last_flush_time.is_empty());
        let failed = dir.path().join("logs").join("sls-failed-logs");
        let mut text = String::new();
        for entry in std::fs::read_dir(&failed).unwrap() {
            text.push_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap());
        }
        let record: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert!(record["error_summary"]
            .as_str()
            .unwrap()
            .contains("invalid request"));
        assert_eq!(record["project"], "proj-a");
        assert_eq!(record["kind"], "agentActivity");
        assert_eq!(record["endpoint"], "activity");
        assert_eq!(record["mode"], "ak");
        assert_eq!(record["batch_count"], 2);
        assert!(record["batch_bytes"].as_i64().unwrap() > 0);
        assert!(record.get("logGroup").is_none());
    }

    #[tokio::test]
    async fn webtracking_retries_network_errors_and_stops_on_403() {
        let mut ep = endpoint(
            "web-network",
            SlsMode::Webtracking,
            "web-project",
            "web-logstore",
            crate::types::SlsEndpointKind::AgentActivity,
        );
        ep.endpoint = "https://cn-shanghai.log.aliyuncs.com".to_string();
        let mut cfg = config(vec![ep]);
        cfg.retry = Some(SlsRetryConfig {
            retry_max_attempts: Some(3),
            retry_base_delay_ms: Some(0),
            retry_jitter: Some(false),
        });
        let (flusher, _, http) = harness(cfg);
        let cause = super::super::sls_transport::OwnedError {
            name: "Error".to_string(),
            message: format!(
                "getaddrinfo ENOTFOUND original-host.example Authorization: Bearer test-token {}",
                "x".repeat(700)
            ),
            code: Some("ENOTFOUND".to_string()),
            cause: None,
            status: None,
            status_code: None,
            error_code: None,
            body: None,
        };
        let network = SendError::Chain(Box::new(super::super::sls_transport::OwnedError {
            name: "TypeError".to_string(),
            message: "fetch failed".to_string(),
            cause: Some(Box::new(cause)),
            status: None,
            status_code: None,
            error_code: None,
            code: None,
            body: None,
        }));
        for _ in 0..3 {
            http.results.lock().unwrap().push_back(Err(network.clone()));
        }
        let alarm = Arc::new(RecAlarm {
            messages: Mutex::new(Vec::new()),
        });
        flusher.set_alarm_manager(alarm.clone());
        flusher
            .send(crate::normalization::build_test_entry(&json!({})), None)
            .await
            .unwrap();
        flusher.flush().await.unwrap();
        assert_eq!(http.calls.lock().unwrap().len(), 3);
        assert_eq!(alarm.messages.lock().unwrap().len(), 1);
        let message = alarm.messages.lock().unwrap()[0].clone();
        assert!(message.contains("category=dns code=ENOTFOUND attempts=3"));
        assert!(message.contains("TypeError: fetch failed"));
        assert!(message.contains("original-host.example"));
        assert!(message.contains("Authorization: [REDACTED]"));
        assert!(!message.contains("test-token"));
        assert!(!message.contains(&"x".repeat(700)));

        let mut ep = endpoint(
            "web-http",
            SlsMode::Webtracking,
            "web-project",
            "l",
            crate::types::SlsEndpointKind::AgentActivity,
        );
        ep.endpoint = "https://cn-shanghai.log.aliyuncs.com".to_string();
        let mut cfg = config(vec![ep]);
        cfg.retry = Some(SlsRetryConfig {
            retry_max_attempts: Some(3),
            retry_base_delay_ms: Some(0),
            retry_jitter: Some(false),
        });
        let (flusher, _, http) = harness(cfg);
        http.results.lock().unwrap().push_back(Ok(SlsHttpResponse {
            status: 403,
            body: r#"{"errorCode":"Forbidden","message":"original response text"}"#.to_string(),
        }));
        let alarm = Arc::new(RecAlarm {
            messages: Mutex::new(Vec::new()),
        });
        flusher.set_alarm_manager(alarm.clone());
        flusher
            .send(crate::normalization::build_test_entry(&json!({})), None)
            .await
            .unwrap();
        flusher.flush().await.unwrap();
        assert_eq!(http.calls.lock().unwrap().len(), 1);
        assert_eq!(alarm.messages.lock().unwrap().len(), 1);
        let message = &alarm.messages.lock().unwrap()[0];
        assert!(message.contains("category=http code=Forbidden status=403 attempts=1"));
        assert!(!message.contains("original response text"));
    }

    #[tokio::test]
    async fn send_raw_only_forwards_mcp_and_trace() {
        let (flusher, ak, _) = harness(config(vec![
            endpoint(
                "ep-activity",
                SlsMode::Ak,
                "p1",
                "l1",
                crate::types::SlsEndpointKind::AgentActivity,
            ),
            endpoint(
                "ep-mcp",
                SlsMode::Ak,
                "p2",
                "l2",
                crate::types::SlsEndpointKind::Mcp,
            ),
            endpoint(
                "ep-trace",
                SlsMode::Ak,
                "p3",
                "l3",
                crate::types::SlsEndpointKind::Trace,
            ),
        ]));
        let mut payload = Map::new();
        payload.insert("data".to_string(), Value::String("payload".to_string()));
        flusher.send_raw("my-topic", &payload).await.unwrap();
        let projects: Vec<_> = ak
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(project, _, _)| project.clone())
            .collect();
        assert!(projects.contains(&"p2".to_string()));
        assert!(projects.contains(&"p3".to_string()));
        assert!(!projects.contains(&"p1".to_string()));
    }

    #[tokio::test]
    async fn limits_flush_concurrency() {
        let mut cfg = config(vec![endpoint(
            "ep",
            SlsMode::Ak,
            "p",
            "l",
            crate::types::SlsEndpointKind::AgentActivity,
        )]);
        cfg.service_name_prefix = "pilot".to_string();
        cfg.flush_concurrency = Some(2);
        let (flusher, ak, _) = harness(cfg);
        for agent in ["claude-code", "cursor", "opencode", "codex"] {
            flusher
                .send(
                    crate::normalization::build_test_entry(&json!({"agentType": agent})),
                    None,
                )
                .await
                .unwrap();
        }
        flusher.flush().await.unwrap();
        assert_eq!(ak.calls.lock().unwrap().len(), 4);
        assert!(ak.max.load(Ordering::SeqCst) <= 2);
    }

    // Frozen baseline ef8953: routing, lifecycle, configuration and tag contracts.
    mod migration_dispatch_contracts {
        use super::*;
        use crate::types::{SlsRetryConfig, SlsTimeoutConfig};

        fn scoped(
            config: SlsFlusherConfig,
        ) -> (tempfile::TempDir, SlsFlusher, Arc<RecAk>, Arc<RecHttp>) {
            let dir = tempfile::tempdir().unwrap();
            let ak = Arc::new(RecAk {
                calls: Mutex::new(Vec::new()),
                failures: Mutex::new(VecDeque::new()),
                current: AtomicUsize::new(0),
                max: AtomicUsize::new(0),
            });
            let http = Arc::new(RecHttp {
                calls: Mutex::new(Vec::new()),
                results: Mutex::new(VecDeque::new()),
            });
            let flusher = SlsFlusher::with_io(
                config,
                dir.path().to_str().unwrap(),
                Some("0.0.0-test".into()),
                http.clone(),
                ak.clone(),
            );
            (dir, flusher, ak, http)
        }

        fn activity(name: &str, mode: SlsMode) -> SlsEndpoint {
            endpoint(
                name,
                mode,
                "proj-a",
                "store-a",
                SlsEndpointKind::AgentActivity,
            )
        }

        fn tag(group: &SlsLogGroupPayload, key: &str) -> Option<String> {
            group
                .tags
                .as_ref()?
                .iter()
                .find_map(|item| item.get(key).cloned())
        }

        #[tokio::test]
        async fn independent_endpoint_redaction_preserves_routing_ip_and_success_counters() {
            let ipv4_source = regex::Regex::new(r"^\d+\.\d+\.\d+\.\d+$").unwrap();
            let mut telemetry = endpoint(
                "telemetry",
                SlsMode::Ak,
                "p2",
                "l2",
                SlsEndpointKind::AgentTelemetry,
            );
            telemetry.redact = Some(true);
            let (_dir, flusher, ak, _) =
                scoped(config(vec![activity("activity", SlsMode::Ak), telemetry]));
            let entry = crate::normalization::build_test_entry(&json!({
                "filePath": "/visible/file.ts", "content": "secret content", "inlineDiffMessage": "secret diff",
                "agent.content": "secret content", "agent.inline_diff_message": "secret diff",
                "agent.qoder.cwd": "/workspace/project", "agent.cursor.hook_event_name": "preToolUse"
            }));
            flusher.send(entry.clone(), None).await.unwrap();
            flusher.send(entry, None).await.unwrap();
            flusher.flush().await.unwrap();
            let calls = ak.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            for (project, logstore, group) in calls.iter() {
                assert_eq!(group.logs.len(), 2);
                let source = group.source.as_deref().unwrap();
                assert!(source.parse::<std::net::IpAddr>().unwrap().is_ipv4());
                assert!(ipv4_source.is_match(source));
                if project == "proj-a" {
                    assert_eq!(logstore, "store-a");
                    assert_eq!(
                        group.logs[0]
                            .content
                            .get("agent.file_path")
                            .map(String::as_str),
                        Some("/visible/file.ts")
                    );
                    assert_eq!(
                        group.logs[0]
                            .content
                            .get("agent.content")
                            .map(String::as_str),
                        Some("secret content")
                    );
                } else {
                    assert_eq!(project, "p2");
                    assert_eq!(logstore, "l2");
                    for key in [
                        "filePath",
                        "content",
                        "inlineDiffMessage",
                        "agent.content",
                        "agent.inline_diff_message",
                    ] {
                        assert!(!group.logs[0].content.contains_key(key), "{key}");
                    }
                }
                assert!(!group.logs[0].content.contains_key("agent.qoder.cwd"));
                assert!(!group.logs[0]
                    .content
                    .contains_key("agent.cursor.hook_event_name"));
                assert_eq!(
                    group.logs[0].content.get("version").map(String::as_str),
                    Some("0.0.0-test")
                );
            }
            for counter in flusher.endpoint_counters().values() {
                assert_eq!(counter.out_entries, 2);
                assert!(counter.out_bytes > 0);
                assert_eq!(counter.out_failed, 0);
            }
        }

        #[tokio::test]
        async fn batch_threshold_three_and_actual_shutdown_timer_finish_the_pending_batch() {
            let mut cfg = config(vec![activity("activity", SlsMode::Ak)]);
            cfg.batch_max_size = 3;
            let (_dir, flusher, ak, _) = scoped(cfg);
            for _ in 0..2 {
                flusher
                    .send(crate::normalization::build_test_entry(&json!({})), None)
                    .await
                    .unwrap();
            }
            assert!(ak.calls.lock().unwrap().is_empty());
            flusher
                .send(crate::normalization::build_test_entry(&json!({})), None)
                .await
                .unwrap();
            assert_eq!(ak.calls.lock().unwrap().len(), 1);
            assert_eq!(ak.calls.lock().unwrap()[0].2.logs.len(), 3);
            flusher.start().await.unwrap();
            let timer = flusher
                .inner
                .timer
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .abort_handle();
            flusher
                .send(crate::normalization::build_test_entry(&json!({})), None)
                .await
                .unwrap();
            flusher.shutdown().await.unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                while !timer.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(flusher.inner.timer.lock().unwrap().is_none());
            let calls = ak.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            assert_eq!(calls[1].2.logs.len(), 1);
        }

        #[tokio::test]
        async fn ak_and_webtracking_failures_write_only_one_bounded_metadata_record() {
            for mode in [SlsMode::Ak, SlsMode::Webtracking] {
                let (dir, flusher, ak, http) = scoped(config(vec![activity("activity", mode)]));
                if mode == SlsMode::Ak {
                    ak.failures
                        .lock()
                        .unwrap()
                        .push_back("invalid request".into());
                } else {
                    http.results.lock().unwrap().push_back(Ok(SlsHttpResponse {
                        status: 400,
                        body: "invalid payload".into(),
                    }));
                }
                flusher
                    .send(
                        crate::normalization::build_test_entry(
                            &json!({"content": "SYNTHETIC_PAYLOAD_MUST_NOT_PERSIST"}),
                        ),
                        None,
                    )
                    .await
                    .unwrap();
                flusher.flush().await.unwrap();
                let expected = dir.path().join("logs").join("sls-failed-logs");
                assert_eq!(flusher.failed_log_directory(), expected);
                let files: Vec<_> = std::fs::read_dir(expected)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .collect();
                assert_eq!(files.len(), 1);
                let text = std::fs::read_to_string(&files[0]).unwrap();
                assert_eq!(text.lines().count(), 1);
                let record: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
                assert_eq!(record["endpoint"], "activity");
                assert_eq!(record["project"], "proj-a");
                assert_eq!(record["logstore"], "store-a");
                assert_eq!(record["kind"], "agentActivity");
                assert_eq!(record["mode"], mode.as_str());
                assert_eq!(record["batch_count"], 1);
                assert!(record["batch_bytes"].as_u64().unwrap() > 0);
                assert!(record.get("logGroup").is_none());
                assert!(record.get("__logs__").is_none());
                assert!(!text.contains("SYNTHETIC_PAYLOAD_MUST_NOT_PERSIST"));
                if mode == SlsMode::Ak {
                    assert!(record["error_summary"]
                        .as_str()
                        .unwrap()
                        .contains("invalid request"));
                }
            }
        }

        #[tokio::test]
        async fn prefix_tags_distinguish_agents_unknown_and_empty_endpoint_overrides() {
            for (prefix, override_name, expected_user, expected_inner) in [
                (
                    "loongsuite-pilot",
                    None,
                    Some("loongsuite-pilot-claude-code"),
                    Some("loongsuite-pilot-claude-code"),
                ),
                (
                    "",
                    Some("managed-svc"),
                    None,
                    Some("managed-svc-claude-code"),
                ),
                ("", None, None, None),
            ] {
                let user = activity("user", SlsMode::Ak);
                let mut inner = endpoint(
                    "inner",
                    SlsMode::Ak,
                    "p2",
                    "l2",
                    SlsEndpointKind::AgentActivity,
                );
                inner.service_name = override_name.map(str::to_string);
                let mut cfg = config(vec![user, inner]);
                cfg.service_name_prefix = prefix.into();
                let (_dir, flusher, ak, _) = scoped(cfg);
                flusher
                    .send(
                        crate::normalization::build_test_entry(
                            &json!({"agentType": "claude-code"}),
                        ),
                        None,
                    )
                    .await
                    .unwrap();
                flusher.flush().await.unwrap();
                let calls = ak.calls.lock().unwrap();
                assert_eq!(calls.len(), 2);
                for (project, _, group) in calls.iter() {
                    assert!(tag(group, "__hostname__").is_some());
                    assert_eq!(
                        tag(group, "__service_name__").as_deref(),
                        if project == "proj-a" {
                            expected_user
                        } else {
                            expected_inner
                        }
                    );
                }
            }
            let mut cfg = config(vec![activity("activity", SlsMode::Ak)]);
            cfg.service_name_prefix = "pilot".into();
            let (_dir, flusher, ak, _) = scoped(cfg);
            for agent in ["claude-code", "cursor", ""] {
                flusher
                    .send(
                        crate::normalization::build_test_entry(&json!({"agentType": agent})),
                        None,
                    )
                    .await
                    .unwrap();
            }
            flusher.flush().await.unwrap();
            let calls = ak.calls.lock().unwrap();
            assert_eq!(calls.len(), 3);
            let mut names: Vec<_> = calls
                .iter()
                .map(|(_, _, group)| tag(group, "__service_name__").unwrap())
                .collect();
            names.sort();
            assert_eq!(
                names,
                ["pilot-claude-code", "pilot-cursor", "pilot-unknown"]
            );
        }

        #[tokio::test]
        async fn raw_prefix_has_no_agent_suffix_and_one_endpoint_failure_is_swallowed() {
            let mut cfg = config(vec![
                endpoint("raw", SlsMode::Ak, "p", "l", SlsEndpointKind::Mcp),
                activity("activity", SlsMode::Ak),
            ]);
            cfg.service_name_prefix = "my-service".into();
            let (_dir, flusher, ak, _) = scoped(cfg);
            let payload = json!({"key": "val"}).as_object().unwrap().clone();
            flusher.send_raw("topic", &payload).await.unwrap();
            {
                let calls = ak.calls.lock().unwrap();
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].0, "p");
                assert_eq!(
                    tag(&calls[0].2, "__service_name__").as_deref(),
                    Some("my-service")
                );
                assert_eq!(
                    calls[0].2.logs[0].content.get("topic").map(String::as_str),
                    Some("topic")
                );
                assert_eq!(
                    calls[0].2.logs[0].content.get("key").map(String::as_str),
                    Some("val")
                );
            }
            ak.failures.lock().unwrap().push_back("fail".into());
            flusher
                .send_raw("t", json!({"d": 1}).as_object().unwrap())
                .await
                .unwrap();
            assert_eq!(ak.calls.lock().unwrap().len(), 2);
        }

        #[tokio::test]
        async fn custom_timeout_and_retry_attempts_reach_the_transport_including_zero_guard() {
            for (configured, expected) in [(5, 5), (0, 1)] {
                let mut cfg = config(vec![activity("web", SlsMode::Webtracking)]);
                cfg.timeout = Some(SlsTimeoutConfig {
                    timeout_ms: Some(25_000),
                    ..Default::default()
                });
                cfg.retry = Some(SlsRetryConfig {
                    retry_max_attempts: Some(configured),
                    retry_base_delay_ms: Some(1),
                    retry_jitter: Some(false),
                });
                let (_dir, flusher, _, http) = scoped(cfg);
                for _ in 0..expected {
                    http.results
                        .lock()
                        .unwrap()
                        .push_back(Err(SendError::Message("TimeoutError".into())));
                }
                flusher
                    .send(crate::normalization::build_test_entry(&json!({})), None)
                    .await
                    .unwrap();
                flusher.flush().await.unwrap();
                let calls = http.calls.lock().unwrap();
                assert_eq!(calls.len(), expected);
                assert!(calls
                    .iter()
                    .all(|request| request.timeout == Duration::from_millis(25_000)));
            }
        }

        #[tokio::test]
        async fn default_concurrency_three_and_zero_guard_process_every_agent_bucket() {
            for (configured, bound) in [(None, 3), (Some(0), 1)] {
                let mut cfg = config(vec![activity("activity", SlsMode::Ak)]);
                cfg.flush_concurrency = configured;
                cfg.service_name_prefix = "pilot".into();
                let (_dir, flusher, ak, _) = scoped(cfg);
                for agent in ["claude-code", "cursor", "opencode", "codex", "qoder-cn"] {
                    flusher
                        .send(
                            crate::normalization::build_test_entry(&json!({"agentType": agent})),
                            None,
                        )
                        .await
                        .unwrap();
                }
                flusher.flush().await.unwrap();
                assert_eq!(ak.calls.lock().unwrap().len(), 5);
                let max = ak.max.load(Ordering::SeqCst);
                assert!(max >= 1 && max <= bound);
            }
        }
    }

    mod migration_dual_write_contracts {
        mod independent_md5 {
            include!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/support/independent_md5.rs"
            ));
        }
        use super::*;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        fn scoped(
            endpoints: Vec<SlsEndpoint>,
        ) -> (tempfile::TempDir, SlsFlusher, Arc<RecAk>, Arc<RecHttp>) {
            let dir = tempfile::tempdir().unwrap();
            let ak = Arc::new(RecAk {
                calls: Mutex::new(Vec::new()),
                failures: Mutex::new(VecDeque::new()),
                current: AtomicUsize::new(0),
                max: AtomicUsize::new(0),
            });
            let http = Arc::new(RecHttp {
                calls: Mutex::new(Vec::new()),
                results: Mutex::new(VecDeque::new()),
            });
            let flusher = SlsFlusher::with_io(
                config(endpoints),
                dir.path().to_str().unwrap(),
                Some("0.0.0-test".into()),
                http.clone(),
                ak.clone(),
            );
            (dir, flusher, ak, http)
        }

        fn destination(name: &str, mode: SlsMode, region: &str, project: &str) -> SlsEndpoint {
            let mut ep = endpoint(
                name,
                mode,
                project,
                &format!("{project}-store"),
                SlsEndpointKind::AgentActivity,
            );
            ep.endpoint = format!("https://{region}.log.aliyuncs.com");
            ep
        }

        fn failures(dir: &std::path::Path) -> Vec<Value> {
            let path = dir.join("logs").join("sls-failed-logs");
            if !path.exists() {
                return Vec::new();
            }
            std::fs::read_dir(path)
                .unwrap()
                .flat_map(|file| {
                    std::fs::read_to_string(file.unwrap().path())
                        .unwrap()
                        .lines()
                        .map(|line| serde_json::from_str(line).unwrap())
                        .collect::<Vec<_>>()
                })
                .collect()
        }

        #[tokio::test]
        async fn webtracking_ak_and_mixed_destinations_dispatch_independently_with_cached_clients()
        {
            for modes in [
                vec![SlsMode::Webtracking],
                vec![SlsMode::Ak],
                vec![SlsMode::Ak, SlsMode::Webtracking],
            ] {
                let endpoints: Vec<_> = modes
                    .iter()
                    .enumerate()
                    .map(|(index, mode)| {
                        destination(
                            &format!("endpoint-{index}"),
                            *mode,
                            if index == 0 {
                                "cn-shanghai"
                            } else {
                                "cn-heyuan"
                            },
                            if index == 0 {
                                "user-proj"
                            } else {
                                "internal-proj"
                            },
                        )
                    })
                    .collect();
                let (_dir, flusher, ak, http) = scoped(endpoints.clone());
                for _ in 0..2 {
                    flusher
                        .send(crate::normalization::build_test_entry(&json!({})), None)
                        .await
                        .unwrap();
                    flusher.flush().await.unwrap();
                }
                let ak_count = modes.iter().filter(|mode| **mode == SlsMode::Ak).count();
                let wt_count = modes.len() - ak_count;
                assert_eq!(ak.calls.lock().unwrap().len(), ak_count * 2);
                assert_eq!(http.calls.lock().unwrap().len(), wt_count * 2);
                let inits = flusher.ak_client_inits();
                assert_eq!(inits.len(), ak_count);
                for init in inits {
                    let ep = endpoints
                        .iter()
                        .find(|ep| ep.endpoint == init.endpoint)
                        .unwrap();
                    assert_eq!(init.access_key_id, ep.access_key_id.as_deref().unwrap());
                    assert_eq!(ep.mode, SlsMode::Ak);
                }
                for request in http.calls.lock().unwrap().iter() {
                    let ep = endpoints
                        .iter()
                        .find(|ep| ep.mode == SlsMode::Webtracking)
                        .unwrap();
                    assert!(request.url.contains(&format!(
                        "{}.{}",
                        ep.project,
                        ep.endpoint.strip_prefix("https://").unwrap()
                    )));
                    let body: Value = serde_json::from_slice(&request.body).unwrap();
                    assert_eq!(body["__logs__"].as_array().unwrap().len(), 1);
                }
            }
        }

        #[tokio::test]
        async fn one_failed_leg_preserves_healthy_dispatch_and_same_kind_failures_keep_distinct_metadata(
        ) {
            let user = destination("user-sls", SlsMode::Ak, "cn-shanghai", "user-proj");
            let inner = destination(
                "internal-sls",
                SlsMode::Webtracking,
                "cn-heyuan",
                "internal-proj",
            );
            let (dir, flusher, ak, http) = scoped(vec![user.clone(), inner]);
            ak.failures
                .lock()
                .unwrap()
                .push_back("quota exceeded".into());
            flusher
                .send(crate::normalization::build_test_entry(&json!({})), None)
                .await
                .unwrap();
            flusher.flush().await.unwrap();
            assert_eq!(ak.calls.lock().unwrap().len(), 1);
            assert_eq!(http.calls.lock().unwrap().len(), 1);
            let rows = failures(dir.path());
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["endpoint"], "user-sls");
            assert!(rows[0]["error_summary"]
                .as_str()
                .unwrap()
                .contains("quota exceeded"));
            assert!(rows[0].get("logGroup").is_none());
            assert_eq!(flusher.endpoint_counters()["internal-sls"].out_entries, 1);

            let inner = destination("internal-sls", SlsMode::Ak, "cn-heyuan", "internal-proj");
            let (dir, flusher, ak, _) = scoped(vec![user, inner]);
            ak.failures
                .lock()
                .unwrap()
                .extend(["user-fail".into(), "internal-fail".into()]);
            flusher
                .send(crate::normalization::build_test_entry(&json!({})), None)
                .await
                .unwrap();
            flusher.flush().await.unwrap();
            let rows = failures(dir.path());
            assert_eq!(rows.len(), 2);
            let mut names: Vec<_> = rows
                .iter()
                .map(|row| row["endpoint"].as_str().unwrap())
                .collect();
            names.sort();
            assert_eq!(names, ["internal-sls", "user-sls"]);
            assert_eq!(ak.calls.lock().unwrap().len(), 2);
        }

        struct WireRequest {
            line: String,
            headers: HashMap<String, String>,
            body: Vec<u8>,
        }

        async fn server(status: u16) -> (String, tokio::task::JoinHandle<WireRequest>) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = Vec::new();
                let header_end = loop {
                    let mut part = [0_u8; 4096];
                    let read = socket.read(&mut part).await.unwrap();
                    assert!(read > 0);
                    buffer.extend_from_slice(&part[..read]);
                    assert!(buffer.len() <= 65_536);
                    if let Some(pos) = buffer.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        break pos + 4;
                    }
                };
                let text = String::from_utf8(buffer[..header_end].to_vec()).unwrap();
                let mut lines = text.split("\r\n");
                let line = lines.next().unwrap().to_string();
                let headers: HashMap<_, _> = lines
                    .filter_map(|line| line.split_once(':'))
                    .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_string()))
                    .collect();
                let length: usize = headers["content-length"].parse().unwrap();
                while buffer.len() < header_end + length {
                    let mut part = [0_u8; 4096];
                    let read = socket.read(&mut part).await.unwrap();
                    assert!(read > 0);
                    buffer.extend_from_slice(&part[..read]);
                }
                let body = buffer[header_end..header_end + length].to_vec();
                let response = if status == 200 {
                    ""
                } else {
                    r#"{"errorCode":"Forbidden"}"#
                };
                let reason = if status == 200 { "OK" } else { "Forbidden" };
                socket.write_all(format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
                WireRequest {
                    line,
                    headers,
                    body,
                }
            });
            (url, task)
        }

        #[tokio::test]
        async fn real_api_key_flusher_posts_protobuf_and_forbidden_persistence_never_contains_the_key(
        ) {
            for status in [200, 403] {
                let (url, task) = server(status).await;
                let dir = tempfile::tempdir().unwrap();
                let mut endpoint =
                    destination("api-key-sls", SlsMode::ApiKey, "unused", "api-key-project");
                endpoint.endpoint = url;
                let flusher = SlsFlusher::new(config(vec![endpoint]), dir.path().to_str().unwrap());
                tokio::time::timeout(Duration::from_secs(3), async {
                    flusher
                        .send(crate::normalization::build_test_entry(&json!({})), None)
                        .await
                        .unwrap();
                    flusher.flush().await.unwrap();
                })
                .await
                .unwrap();
                let received = tokio::time::timeout(Duration::from_secs(3), task)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    received.line,
                    "POST /logstores/api-key-project-store/shards/lb HTTP/1.1"
                );
                assert_eq!(
                    received.headers["authorization"],
                    "Bearer api-key-sls-api-key"
                );
                assert_eq!(received.headers["content-type"], "application/x-protobuf");
                assert!(chrono::DateTime::parse_from_rfc2822(&received.headers["date"]).is_ok());
                assert_eq!(received.headers["x-log-apiversion"], "0.6.0");
                assert!(!received.headers.contains_key("x-log-signaturemethod"));
                assert_eq!(
                    received.headers["x-log-bodyrawsize"],
                    received.body.len().to_string()
                );
                let digest = &received.headers["content-md5"];
                assert_eq!(digest.len(), 32);
                assert!(digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte)));
                // Hash the exact captured dynamic body using the independent test oracle,
                // separately checked against offline Node crypto vectors.
                assert_eq!(digest, &independent_md5::digest_hex(&received.body));
                assert!(received
                    .body
                    .windows(b"gen_ai.session.id".len())
                    .any(|bytes| bytes == b"gen_ai.session.id"));
                assert!(received
                    .body
                    .windows(b"test-session-1".len())
                    .any(|bytes| bytes == b"test-session-1"));
                let rows = failures(dir.path());
                if status == 200 {
                    assert!(rows.is_empty());
                } else {
                    assert_eq!(rows.len(), 1);
                    let row = &rows[0];
                    assert_eq!(row["endpoint"], "api-key-sls");
                    assert_eq!(row["mode"], "apiKey");
                    assert_eq!(row["project"], "api-key-project");
                    assert_eq!(row["logstore"], "api-key-project-store");
                    assert_eq!(row["kind"], "agentActivity");
                    assert_eq!(row["batch_count"], 1);
                    assert!(row["batch_bytes"].as_u64().unwrap() > 0);
                    assert!(row["error_summary"].as_str().unwrap().contains("Forbidden"));
                    assert!(!serde_json::to_string(row)
                        .unwrap()
                        .contains("api-key-sls-api-key"));
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "sls_flusher_main_tests.rs"]
mod main_tests;
