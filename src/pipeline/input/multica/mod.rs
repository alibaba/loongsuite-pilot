mod activation;
pub(crate) mod cli;
pub(crate) mod config;
mod diagnostics;
mod pprof;
mod records;
mod source_http;
mod sources;

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};

use crate::checkpoints::{InputStatePatch, StateStore};
use crate::flushers::{
    self as sls_transport, PostApiKeyOptions, PostWebtrackingOptions, ReqwestSlsHttp, SlsHttp,
    SlsLogEntryPayload, SlsLogGroupPayload, SlsTransportConfig, WEBTRACKING_MAX_BODY_BYTES,
    WEBTRACKING_MAX_LOGS,
};
use crate::utils::{create_logger, write_json_file};
use activation::Gate;
use config::{CollectionMode, Destination, Input, ProfileKind};
use records::{digest, envelope, pod_labels, record, Record};
use sources::{ApiSource, Array, Checkpoint, Pagination, SourceResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub(crate) successful_sources: usize,
    pub(crate) failed_sources: usize,
    pub(crate) collection_enabled: bool,
    collection_mode: &'static str,
    activation_reason: &'static str,
    detection_misses: u64,
    collection_stopped: bool,
}

#[derive(Default)]
struct Cycle {
    gate: Option<Gate>,
    loaded: bool,
    last_activation: String,
    profiles: HashMap<ProfileKind, SourceResult>,
    profile_failures: HashMap<ProfileKind, (u32, i64)>,
}

#[derive(Deserialize, Serialize)]
struct Pending {
    records: Vec<Record>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checkpoint: Option<Checkpoint>,
}

struct Background {
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
    heartbeat: Option<tokio::task::JoinHandle<()>>,
}

pub(crate) struct Options<'a> {
    pub(crate) name: &'a str,
    pub(crate) input: Input,
    pub(crate) destination: Destination,
    pub(crate) state_dir: &'a Path,
    pub(crate) mode: CollectionMode,
    pub(crate) enabled: bool,
    pub(crate) prefix: &'a str,
    pub(crate) activation_path: Option<PathBuf>,
}

struct ActivationLease {
    path: PathBuf,
    state: Mutex<LeaseState>,
}

struct LeaseState {
    enabled: bool,
    mode: &'static str,
    stopped: bool,
    closing: bool,
}

impl Default for LeaseState {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: "off",
            stopped: false,
            closing: false,
        }
    }
}

impl ActivationLease {
    async fn update(&self, status: &activation::Status) {
        let mut state = self.state.lock().await;
        state.enabled = status.enabled;
        state.mode = status.mode;
        state.stopped = status.stopped;
        self.write(&state).await;
    }

    async fn refresh(&self) {
        let state = self.state.lock().await;
        self.write(&state).await;
    }

    async fn close(&self) {
        let mut state = self.state.lock().await;
        state.closing = true;
        self.write(&state).await;
    }

    async fn write(&self, state: &LeaseState) {
        let enabled = !state.closing && state.enabled;
        let expires = if enabled {
            Utc::now().timestamp_millis() + 30_000
        } else {
            0
        };
        if write_json_file(
            &self.path.to_string_lossy(),
            &json!({
                "mode": state.mode,
                "enabled": enabled,
                "stopped": state.stopped,
                "expiresAt": expires,
            }),
        )
        .await
        .is_err()
        {
            create_logger("MulticaPipeline").warn("write activation state failed", None);
        }
    }
}

pub(crate) struct MulticaPipeline {
    name: String,
    input: Input,
    destination: Destination,
    mode: CollectionMode,
    enabled: bool,
    state: StateStore,
    spool: PathBuf,
    cycle: Mutex<Cycle>,
    background: Mutex<Option<Background>>,
    client: reqwest::Client,
    sender: Arc<dyn SlsHttp>,
    lease: Option<Arc<ActivationLease>>,
}

impl MulticaPipeline {
    pub(crate) fn new(options: Options<'_>) -> anyhow::Result<Self> {
        let Options {
            name,
            mut input,
            destination,
            state_dir,
            mode,
            enabled,
            prefix,
            activation_path,
        } = options;
        anyhow::ensure!(
            config::valid_name(name, true),
            "invalid Multica pipeline configName"
        );
        input.validate()?;
        if !prefix.trim().is_empty() {
            input.instance = Some(prefix.trim().to_owned());
        }
        let destination_id = digest(serde_json::to_vec(&[
            &destination.endpoint,
            &destination.project,
            &destination.logstore,
        ])?);
        let state_name = format!("{name}.{destination_id}.multica");
        Ok(Self {
            name: name.to_owned(),
            input,
            destination,
            mode,
            enabled,
            state: StateStore::new(state_dir.join(format!("{state_name}.json"))),
            spool: state_dir.join(format!("{state_name}-pending")),
            cycle: Mutex::new(Cycle::default()),
            background: Mutex::new(None),
            client: source_http::client()?,
            sender: Arc::new(ReqwestSlsHttp::new()),
            lease: activation_path.map(|path| {
                Arc::new(ActivationLease {
                    path,
                    state: Mutex::new(LeaseState::default()),
                })
            }),
        })
    }

    pub(crate) async fn start(self: &Arc<Self>) {
        let mut background = self.background.lock().await;
        if background.is_some() {
            return;
        }
        if let Some(lease) = &self.lease {
            lease.refresh().await;
        }
        let (stop, mut stopped) = oneshot::channel();
        let pipeline = Arc::clone(self);
        let task = tokio::spawn(async move {
            loop {
                let summary = pipeline.collect_once().await;
                if summary.collection_stopped || summary.collection_mode == "off" {
                    break;
                }
                let delay = Duration::from_secs(pipeline.input.interval_seconds.unwrap_or(30));
                tokio::select! {
                    _ = &mut stopped => break,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        });
        let heartbeat = self.lease.as_ref().map(|lease| {
            let lease = Arc::clone(lease);
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    lease.refresh().await;
                }
            })
        });
        *background = Some(Background {
            stop,
            task,
            heartbeat,
        });
    }

    pub(crate) async fn stop(&self) {
        let mut background = self.background.lock().await;
        if let Some(lease) = &self.lease {
            lease.close().await;
        }
        if let Some(Background {
            stop,
            task,
            heartbeat,
        }) = background.take()
        {
            if let Some(heartbeat) = heartbeat {
                heartbeat.abort();
            }
            let _ = stop.send(());
            let _ = task.await;
        }
    }

    pub(crate) async fn collect_once(&self) -> Summary {
        let mut state = self.cycle.lock().await;
        let gate = state.gate.get_or_insert_with(|| Gate::new(&self.input));
        let activation = gate
            .evaluate(&self.client, &self.input, self.mode, self.enabled)
            .await;
        let snapshot = json!({
            "configName": self.name,
            "enabled": activation.enabled,
            "mode": activation.mode,
            "reason": activation.reason,
            "consecutiveMisses": activation.consecutive_misses,
            "stopped": activation.stopped,
        });
        if let Some(lease) = &self.lease {
            lease.update(&activation).await;
        }
        let signature = snapshot.to_string();
        if signature != state.last_activation {
            state.last_activation = signature;
            create_logger("MulticaPipeline")
                .info("Multica collection activation", snapshot.as_object());
        }
        let mut summary = Summary {
            successful_sources: 0,
            failed_sources: 0,
            collection_enabled: activation.enabled,
            collection_mode: activation.mode,
            activation_reason: activation.reason,
            detection_misses: activation.consecutive_misses,
            collection_stopped: activation.stopped,
        };
        if !activation.enabled {
            return summary;
        }
        if !state.loaded {
            if self.prepare_spool().await.is_err() {
                summary.failed_sources += 1;
                create_logger("MulticaPipeline")
                    .warn("prepare source checkpoint and pending batches failed", None);
                return summary;
            }
            self.state.load().await;
            state.loaded = true;
        }
        let input = &self.input;
        for (kind, urls) in [
            ("metrics", &input.metrics_urls),
            ("health", &input.daemon_health_urls),
        ] {
            for url in urls {
                self.source(
                    &format!("{kind}:{url}"),
                    &mut summary,
                    sources::metrics_or_health(&self.client, input, url, kind == "health"),
                )
                .await;
            }
        }
        for path in &input.stat_files {
            self.source(
                &format!("stat:{}", path.display()),
                &mut summary,
                sources::stat(path),
            )
            .await;
        }
        for path in &input.log_files {
            let name = format!("log:{}", path.display());
            self.source(
                &name,
                &mut summary,
                sources::log(input, path.clone(), self.checkpoint(&name)),
            )
            .await;
        }
        for workspace in input
            .workspace_ids
            .iter()
            .filter(|_| input.api_base.is_some())
        {
            self.workspace(workspace, &mut summary).await;
        }
        if let Some(base) = &input.pprof_base_url {
            let kinds = input
                .pprof_types
                .as_deref()
                .unwrap_or(&[ProfileKind::Cpu, ProfileKind::Allocs]);
            for kind in kinds.iter().copied() {
                let name = format!("pprof:{base}:{}", kind.name());
                let now = Utc::now().timestamp_millis();
                if self.checkpoint(&name).pprof_next_capture_at_ms > now
                    || state
                        .profile_failures
                        .get(&kind)
                        .is_some_and(|(_, retry)| *retry > now)
                {
                    continue;
                }
                let delivered = self
                    .source(&name, &mut summary, async {
                        if let Some(profile) = state.profiles.get(&kind) {
                            return Ok(profile.clone());
                        }
                        match pprof::collect(&self.client, input, kind).await {
                            Ok(result) => {
                                state.profiles.insert(kind, result.clone());
                                state.profile_failures.remove(&kind);
                                Ok(result)
                            }
                            Err(error) => {
                                let count = state
                                    .profile_failures
                                    .get(&kind)
                                    .map_or(1, |(count, _)| (count + 1).min(4));
                                let delay = (60_000 * 2_i64.pow(count - 1)).min(300_000);
                                state.profile_failures.insert(kind, (count, now + delay));
                                Err(error)
                            }
                        }
                    })
                    .await;
                if delivered {
                    state.profiles.remove(&kind);
                }
            }
        }
        create_logger("MulticaPipeline")
            .info("collection cycle complete", json!(&summary).as_object());
        summary
    }

    async fn prepare_spool(&self) -> std::io::Result<()> {
        let mut builder = tokio::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&self.spool).await
    }

    fn checkpoint(&self, name: &str) -> Checkpoint {
        self.state
            .get(name)
            .extra()
            .and_then(|mut extra| extra.get_mut("checkpoint").map(std::mem::take))
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default()
    }

    async fn workspace(&self, workspace: &str, summary: &mut Summary) {
        let mut sources = Vec::new();
        if self.input.collect_entity_names {
            sources.push(api(
                "workspace",
                &format!("/api/workspaces/{}", segment(workspace)),
                "workspace_snapshot",
                Array::Single,
            ));
            sources.push(
                api(
                    "projects",
                    "/api/projects",
                    "project_snapshot",
                    Array::Named("projects"),
                )
                .paginated(Pagination::Offset),
            );
        }
        sources.extend([
            api(
                "issues",
                "/api/issues",
                "issue_snapshot",
                Array::Named("issues"),
            )
            .paginated(Pagination::Offset),
            api(
                "issue_statuses",
                "/api/issue-statuses",
                "issue_status_snapshot",
                Array::Named("statuses"),
            ),
            api("agents", "/api/agents", "agent_snapshot", Array::Root).discover(),
            api("runtimes", "/api/runtimes", "runtime_snapshot", Array::Root),
            api(
                "active_tasks",
                "/api/agent-task-snapshot",
                "task_snapshot",
                Array::Root,
            ),
            api(
                "autopilots",
                "/api/autopilots",
                "autopilot_snapshot",
                Array::Named("autopilots"),
            )
            .discover(),
            api(
                "autopilot_quota",
                "/api/autopilots/usage",
                "usage_snapshot",
                Array::Single,
            )
            .with("report_type", "autopilot_quota"),
        ]);
        for source in sources {
            self.api(workspace, &source, summary).await;
        }
        for agent in self
            .checkpoint(&format!("api:{workspace}:agents"))
            .entity_ids
        {
            let source = api(
                &format!("tasks:{agent}"),
                &format!("/api/agents/{}/tasks?include_usage=true", segment(&agent)),
                "task_snapshot",
                Array::Root,
            )
            .paginated(Pagination::Cursor);
            self.api(workspace, &source, summary).await;
        }
        for autopilot in self
            .checkpoint(&format!("api:{workspace}:autopilots"))
            .entity_ids
        {
            let source = api(
                &format!("triggers:{autopilot}"),
                &format!("/api/autopilots/{}/runs", segment(&autopilot)),
                "trigger_snapshot",
                Array::Named("runs"),
            )
            .paginated(Pagination::Offset)
            .with("autopilot_id", &autopilot);
            self.api(workspace, &source, summary).await;
        }
        let days = self.input.usage_days.unwrap_or(7);
        for report in [
            "usage/daily",
            "usage/by-agent",
            "agent-runtime",
            "runtime/daily",
            "failures/daily",
            "failures/by-agent",
        ] {
            let source = api(
                &format!("dashboard:{report}"),
                &format!("/api/dashboard/{report}?days={days}&tz=UTC"),
                "usage_snapshot",
                Array::Root,
            )
            .with("report_type", report);
            self.api(workspace, &source, summary).await;
        }
        for report in ["agent-activity-30d", "agent-run-counts"] {
            let source = api(
                report,
                &format!("/api/{report}"),
                "usage_snapshot",
                Array::Root,
            )
            .with("report_type", report);
            self.api(workspace, &source, summary).await;
        }
    }

    async fn api(&self, workspace: &str, source: &ApiSource, summary: &mut Summary) {
        let name = format!("api:{workspace}:{}", source.name);
        self.source(
            &name,
            summary,
            sources::api(&self.client, &self.input, workspace, source),
        )
        .await;
    }

    async fn source(
        &self,
        name: &str,
        summary: &mut Summary,
        collect: impl Future<Output = Result<SourceResult, String>>,
    ) -> bool {
        let observed = Utc::now().timestamp_millis();
        let labels = pod_labels(&self.input, name);
        match self.deliver_source(name, observed, &labels, collect).await {
            Ok(()) => {
                summary.successful_sources += 1;
                true
            }
            Err(error) => {
                summary.failed_sources += 1;
                create_logger("MulticaPipeline").warn(
                    "source collection failed",
                    json!({"source":name, "error_kind":error}).as_object(),
                );
                let failure = envelope(
                    &self.input,
                    name,
                    observed,
                    collection_status(name, observed, Some(&error)),
                    &labels,
                );
                let _ = self.send(&[failure]).await;
                false
            }
        }
    }

    async fn deliver_source(
        &self,
        name: &str,
        observed: i64,
        labels: &Record,
        collect: impl Future<Output = Result<SourceResult, String>>,
    ) -> Result<(), String> {
        let path = self.spool.join(format!("{}.json", digest(name)));
        let pending: Pending = match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "invalid_pending_batch")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let result = collect.await?;
                let mut status = collection_status(name, observed, None);
                status.insert("record_count".into(), result.records.len().to_string());
                status.insert("truncated".into(), result.truncated.to_string());
                let records = result
                    .records
                    .into_iter()
                    .chain(std::iter::once(status))
                    .map(|row| envelope(&self.input, name, observed, row, labels))
                    .collect();
                let pending = Pending {
                    records,
                    checkpoint: result.checkpoint,
                };
                write_json_file(&path.to_string_lossy(), &pending)
                    .await
                    .map_err(|_| "write_pending_batch_failed")?;
                pending
            }
            Err(_) => return Err("read_pending_batch_failed".into()),
        };
        self.send(&pending.records).await?;
        if let Some(checkpoint) = pending.checkpoint {
            self.state.update(
                name,
                InputStatePatch {
                    extra: Some(json!({"checkpoint": checkpoint})),
                    ..InputStatePatch::default()
                },
            );
        }
        self.state
            .save()
            .await
            .map_err(|_| "write_checkpoint_failed")?;
        tokio::fs::remove_file(path)
            .await
            .map_err(|_| "remove_pending_batch_failed")?;
        Ok(())
    }

    async fn send(&self, records: &[Record]) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }
        if records
            .iter()
            .any(|row| sls_transport::json_utf8_len(row) > WEBTRACKING_MAX_BODY_BYTES)
        {
            return Err("sls_record_too_large".into());
        }
        let destination = &self.destination;
        let transport = SlsTransportConfig {
            endpoint: destination.endpoint.clone(),
            project: destination.project.clone(),
            logstore: destination.logstore.clone(),
            timeout_ms: None,
            max_retries: None,
            retry_base_delay_ms: None,
        };
        let content: Vec<IndexMap<String, String>> = records
            .iter()
            .map(|row| row.clone().into_iter().collect())
            .collect();
        let source = records[0]
            .get("multica_env")
            .or_else(|| records[0].get("instance"))
            .cloned();
        let tags = [
            ("pipeline_type", "multica"),
            ("schema_version", "multica.v1"),
        ];
        if let Some(api_key) = &destination.api_key {
            let options = PostApiKeyOptions {
                topic: Some("multica".into()),
                source,
                tags: Some(vec![tags
                    .into_iter()
                    .map(|(k, v)| (k.into(), v.into()))
                    .collect()]),
                user_agent: None,
            };
            for chunk in sls_transport::split_for_webtracking(
                &content,
                WEBTRACKING_MAX_LOGS,
                WEBTRACKING_MAX_BODY_BYTES,
            ) {
                let now = Utc::now().timestamp();
                let logs = chunk
                    .into_iter()
                    .map(|content| {
                        let timestamp = content
                            .get("observed_at")
                            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
                            .map(|time| time.timestamp())
                            .filter(|timestamp| *timestamp >= 0)
                            .unwrap_or(now);
                        SlsLogEntryPayload {
                            timestamp,
                            content,
                            timestamp_ns_part: None,
                        }
                    })
                    .collect();
                sls_transport::post_api_key_log_store_logs(
                    &transport,
                    api_key,
                    &SlsLogGroupPayload {
                        logs,
                        ..Default::default()
                    },
                    &options,
                    self.sender.as_ref(),
                )
                .await
                .map_err(|_| "sls_api_key_delivery_failed")?;
            }
        } else {
            let options = PostWebtrackingOptions {
                topic: Some("multica".into()),
                source,
                tags: Some(
                    tags.into_iter()
                        .map(|(k, v)| (k.into(), Value::String(v.into())))
                        .collect(),
                ),
                user_agent: None,
            };
            sls_transport::post_webtracking(&transport, &content, &options, self.sender.as_ref())
                .await
                .map_err(|_| "sls_webtracking_delivery_failed")?;
        }
        Ok(())
    }
}

fn collection_status(name: &str, observed: i64, error: Option<&str>) -> Record {
    let mut row = record([
        ("record_type", "collection_status"),
        ("source_type", "collector"),
        ("entity_id", name),
        ("success", if error.is_none() { "true" } else { "false" }),
    ]);
    row.insert(
        "duration_ms".into(),
        (Utc::now().timestamp_millis() - observed)
            .max(0)
            .to_string(),
    );
    if let Some(error) = error {
        row.insert("error_kind".into(), error.to_owned());
    }
    row
}

fn segment(value: &str) -> String {
    let mut url = reqwest::Url::parse("https://localhost/").expect("static URL");
    url.path_segments_mut()
        .expect("hierarchical URL")
        .push(value);
    url.path().trim_start_matches('/').to_owned()
}

fn api(name: &str, path: &str, record_type: &'static str, array: Array) -> ApiSource {
    ApiSource {
        name: name.to_owned(),
        path: path.to_owned(),
        record_type,
        array,
        pagination: Pagination::None,
        discover: false,
        extra: Record::new(),
    }
}

impl ApiSource {
    fn paginated(mut self, pagination: Pagination) -> Self {
        self.pagination = pagination;
        self
    }
    fn discover(mut self) -> Self {
        self.discover = true;
        self
    }
    fn with(mut self, key: &str, value: &str) -> Self {
        self.extra.insert(key.to_owned(), value.to_owned());
        self
    }
}

#[cfg(test)]
mod tests;
