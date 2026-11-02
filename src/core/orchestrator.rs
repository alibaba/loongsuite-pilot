//! Collector startup sequence. Port of `orchestrator.ts`.
//!
//! Inputs that already exist in this crate are registered as thin `LiveInput`
//! wrappers. Codex transcript, aborted-turn recovery, Wukong, and WorkBuddy
//! use the same hosted collector surface as the other Rust inputs.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use tokio::task::JoinHandle;

use crate::checkpoints::StateStore;
use crate::deployment::{
    are_grok_build_hook_assets_healthy, detect_agent, hook_install_alarm_key,
    hook_install_result_path, hook_install_signal_path, is_agent_gated_enabled,
    mark_hook_install_alarm_sent, resolve_deployment_scope, resolve_pilot_dir,
    restore_grok_build_hook_assets, should_relay_hook_install_alarm, DeploymentManager,
    DeploymentManagerOptions, DeploymentScopeMode, DeploymentScopeResult, HookInstallAlarmAgent,
    HookInstallAlarmReport, HookInstallReport, PluginProbeDeployOptions, PluginProbeStrategy,
};
use crate::flushers::{
    BaseFlusher, HttpFlusher, JsonlFlusher, MultiFlusher, OtlpTraceFlusher, SlsFlusher,
};
use crate::inputs::base::InputRuntimeDelta;
use crate::inputs::claude_code_log::ClaudeCodeLogInput;
use crate::inputs::codex_aborted_turn::{CodexAbortedTurnInput, CodexAbortedTurnInputOptions};
use crate::inputs::codex_transcript::{CodexTranscriptInput, CodexTranscriptInputOptions};
use crate::inputs::copilot_log::{CopilotLogInput, CopilotLogInputOptions};
use crate::inputs::cursor_hook::CursorHookInput;
use crate::inputs::doubao_work::{DoubaoWorkInput, DoubaoWorkInputOptions};
use crate::inputs::dsh_log::{ensure_dsh_log_dir, DshLogInput};
use crate::inputs::grok_build_log::GrokBuildLogInput;
use crate::inputs::hermes_log::HermesLogInput;
use crate::inputs::kiro_cli_log::KiroCliLogInput;
use crate::inputs::kiro_cli_session::KiroCliSessionInput;
use crate::inputs::mimo_code_log::MimoCodeLogInput;
use crate::inputs::openclaw_plugin::{ensure_openclaw_plugin_log_dir, OpenClawPluginInput};
use crate::inputs::opencode_log::OpenCodeLogInput;
use crate::inputs::pi_coding_agent_log::{ensure_pi_coding_agent_log_dir, PiCodingAgentLogInput};
use crate::inputs::qoder_cn::{QoderCnInput, QoderCnOptions};
use crate::inputs::qoder_cn_sqlite::{QoderCnSqliteInput, QoderCnSqliteOptions};
use crate::inputs::qoder_cn_trace::{QoderCnTraceInput, QoderCnTraceOptions};
use crate::inputs::qoder_trace::{QoderTraceInput, QoderTraceOptions};
use crate::inputs::qoder_work::{QoderWorkInput, QoderWorkOptions};
use crate::inputs::qoder_work_log::{
    resolve_qoder_work_root, QoderWorkLogInput, QoderWorkLogOptions, QoderWorkLogTraceInput,
    QoderWorkLogTraceOptions,
};
use crate::inputs::qoder_work_sqlite::{QoderWorkSqliteInput, QoderWorkSqliteOptions};
use crate::inputs::qoder_work_trace::{QoderWorkTraceInput, QoderWorkTraceOptions};
use crate::inputs::qwen_code_cli_log::QwenCodeCliLogInput;
use crate::inputs::qwen_work_cn::{
    QwenWorkCnInput, QwenWorkCnOptions, QwenWorkCnSqliteInput, QwenWorkCnSqliteOptions,
    QwenWorkCnTraceInput, QwenWorkCnTraceOptions,
};
use crate::inputs::rest_support::{HookInputOptions, SessionInputOptions};
use crate::inputs::workbuddy::{WorkBuddyInput, WorkBuddyInputOptions};
use crate::inputs::wukong::{WukongInput, WukongInputOptions};
use crate::interceptor::daemon::{
    start_interceptor_service, InterceptorService, StartInterceptorServiceOptions,
};
use crate::interceptor::{
    load_interceptor_config, resolve_enabled_interceptor_types, ToolVerdictStore,
};
use crate::local_workers::{
    LocalWorkerActivationService, RuntimeOptionValue, RuntimeOptions, WorkerSupervisor,
};
use crate::metrics::{
    AlarmContext, AlarmManager, DataflowSnapshot, FlusherEndpointStats, InputSnapshot,
    MetricsWriter, MetricsWriterOptions,
};
use crate::multimodal::{
    any_agent_multimodal_enabled, create_delegated_oss_uploader, create_uploader,
    is_agent_multimodal_enabled, MultimodalProcessor, StorageBaseResult,
};
use crate::normalization::GlobalAttributesProvider;
use crate::pi_sdk::{ensure_registered_pi_sdk_wrappers, is_pi_sdk_registry_busy_error};
use crate::pipeline::{PipelineManager, PipelineManagerOptions};
use crate::status_bar::{MetricsSummaryWriter, ProcessOps, RuntimeWriter, StatusBarAppManager};
use crate::types::CollectionMethod;
use crate::types::{
    AgentActivityEntry, AgentDefinition, AgentDetection, AgentStopReason, AnalyticsConfig,
    ClientType, DeployMode, DeployResult, DeploySkipReason, InstalledBy, JsonlFlusherConfig,
    MultimodalStorage,
};
use crate::utils::{
    clean_stale_tmp_files, directory_exists, ensure_dir, file_exists, read_installed_version,
    resolve_home, resolve_local_ip, JsonSyntax, DEFAULT_STALE_TMP_MAX_AGE_MS,
};
use crate::{dashboard, interceptor};

use super::agent_control_manager::AgentControlManager;
use super::agent_discovery_service::{AgentDiscoveryEvent, AgentDiscoveryService};
use super::config_loader::build_otlp_trace_config;
use super::hook_watchdog::{HookWatchdog, InterceptCheckTarget, PluginCheckTarget};
use super::input_manager::{InputCounter, InputManager, LiveInput};
use super::intercept_result_linker::InterceptResultLinker;
use super::legacy_sls_failed_log_cleanup::LegacySlsFailedLogCleanupService;
use super::log_retention_service::LogRetentionService;
use super::updater_watchdog::{UpdaterWatchdog, UpdaterWatchdogOptions};
use super::upstream_link::{AcpCorrelateRetentionService, CorrelationStore, TraceLinker};
use super::workspace_policy::WorkspacePolicy;
use super::{fields, logger};

const DEFAULT_DATA_DIR: &str = "~/.loongsuite-pilot";

struct GateBits {
    scope: DeploymentScopeMode,
    recorded: HashSet<String>,
    modes: HashMap<String, crate::types::AgentControlMode>,
}

struct ProbeSupervisor {
    probe: PluginProbeStrategy,
}

#[async_trait]
impl WorkerSupervisor for ProbeSupervisor {
    async fn deploy(
        &self,
        def: &AgentDefinition,
        instance: &HashMap<String, String>,
        runtime_options: &RuntimeOptions,
    ) -> DeployResult {
        let mut options = HashMap::new();
        for (key, value) in runtime_options {
            options.insert(
                key.clone(),
                match value {
                    RuntimeOptionValue::Bool(flag) => serde_json::Value::Bool(*flag),
                    RuntimeOptionValue::Text(text) => serde_json::Value::String(text.clone()),
                },
            );
        }
        self.probe
            .deploy_with(
                def,
                &PluginProbeDeployOptions {
                    instance: Some(instance.clone()),
                    runtime_options: Some(options),
                },
            )
            .await
    }

    async fn stop_worker(
        &self,
        def: &AgentDefinition,
        instance: &HashMap<String, String>,
        runtime_options: &RuntimeOptions,
    ) -> Result<(), String> {
        let mut options = HashMap::new();
        for (key, value) in runtime_options {
            options.insert(
                key.clone(),
                match value {
                    RuntimeOptionValue::Bool(flag) => serde_json::Value::Bool(*flag),
                    RuntimeOptionValue::Text(text) => serde_json::Value::String(text.clone()),
                },
            );
        }
        if self
            .probe
            .stop_worker(
                def,
                &PluginProbeDeployOptions {
                    instance: Some(instance.clone()),
                    runtime_options: Some(options),
                },
            )
            .await
        {
            Ok(())
        } else {
            Err("local worker stop failed".into())
        }
    }

    async fn source_hash(&self, tarball: Option<&str>) -> Option<String> {
        self.probe.compute_source_hash(tarball, None).await
    }
}

/// Collector lifecycle and admission notifications for native embedders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrchestratorEvent {
    Starting,
    Started,
    StartFailed(String),
    ComponentFailure { component: String, error: String },
    MultimodalReady { storage_base_path: Option<String> },
    Stopped,
    Agent(AgentDiscoveryEvent),
}

type OrchestratorListener = Arc<dyn Fn(OrchestratorEvent) + Send + Sync>;

pub struct Orchestrator {
    config: AnalyticsConfig,
    data_dir: String,
    agents: Arc<crate::types::AgentsConfig>,
    bits: Arc<Mutex<GateBits>>,
    control: Mutex<AgentControlManager>,
    inputs: Arc<InputManager>,
    state_store: Mutex<Option<Arc<StateStore>>>,
    flusher: Mutex<Option<Arc<dyn BaseFlusher>>>,
    sls: Mutex<Option<Arc<SlsFlusher>>>,
    otlp: Mutex<Option<Arc<OtlpTraceFlusher>>>,
    discovery: Mutex<Option<Arc<AgentDiscoveryService>>>,
    deployment: Mutex<Option<Arc<DeploymentManager>>>,
    retention: Mutex<Option<Arc<LogRetentionService>>>,
    correlate_retention: Mutex<Option<Arc<AcpCorrelateRetentionService>>>,
    legacy_cleanup: Mutex<Option<Arc<LegacySlsFailedLogCleanupService>>>,
    hook_watchdog: Mutex<Option<Arc<HookWatchdog>>>,
    updater_watchdog: Mutex<Option<Arc<UpdaterWatchdog>>>,
    workers: Mutex<Option<LocalWorkerActivationService<ProbeSupervisor>>>,
    pipeline: Mutex<Option<Arc<PipelineManager>>>,
    metrics: Mutex<Option<Arc<MetricsWriter>>>,
    alarm: Mutex<Option<Arc<AlarmManager>>>,
    runtime_task: Mutex<Option<JoinHandle<()>>>,
    summary_task: Mutex<Option<JoinHandle<()>>>,
    runtime_writer: Mutex<Option<RuntimeWriter>>,
    summary_writer: Mutex<Option<MetricsSummaryWriter>>,
    dashboard: Mutex<Option<dashboard::DashboardServer>>,
    interceptor: Mutex<Option<InterceptorService>>,
    multimodal_ready: Mutex<bool>,
    verdicts: Mutex<Option<Arc<ToolVerdictStore>>>,
    status_bar: Mutex<Option<StatusBarAppManager>>,
    signal_task: Mutex<Option<JoinHandle<()>>>,
    signal_stamp: Mutex<Option<(SystemTime, Vec<u8>)>>,
    relayed_alarms: Mutex<HashSet<String>>,
    running: Mutex<bool>,
    listeners: Mutex<Vec<OrchestratorListener>>,
    #[cfg(test)]
    test_interceptor_port: Option<u16>,
    #[cfg(test)]
    test_detection_entries: Mutex<Vec<Arc<dyn AgentDetection>>>,
}

impl Orchestrator {
    pub fn new(config: AnalyticsConfig) -> Self {
        let data_dir = resolve_home(if config.data_dir.is_empty() {
            DEFAULT_DATA_DIR
        } else {
            &config.data_dir
        });
        Self {
            agents: Arc::new(config.agents.clone()),
            bits: Arc::new(Mutex::new(GateBits {
                scope: DeploymentScopeMode::Auto,
                recorded: HashSet::new(),
                modes: HashMap::new(),
            })),
            data_dir,
            control: Mutex::new(AgentControlManager::new(None)),
            inputs: Arc::new(InputManager::new()),
            state_store: Mutex::new(None),
            flusher: Mutex::new(None),
            sls: Mutex::new(None),
            otlp: Mutex::new(None),
            discovery: Mutex::new(None),
            deployment: Mutex::new(None),
            retention: Mutex::new(None),
            correlate_retention: Mutex::new(None),
            legacy_cleanup: Mutex::new(None),
            hook_watchdog: Mutex::new(None),
            updater_watchdog: Mutex::new(None),
            workers: Mutex::new(None),
            pipeline: Mutex::new(None),
            metrics: Mutex::new(None),
            alarm: Mutex::new(None),
            runtime_task: Mutex::new(None),
            summary_task: Mutex::new(None),
            runtime_writer: Mutex::new(None),
            summary_writer: Mutex::new(None),
            dashboard: Mutex::new(None),
            interceptor: Mutex::new(None),
            multimodal_ready: Mutex::new(false),
            verdicts: Mutex::new(None),
            status_bar: Mutex::new(None),
            signal_task: Mutex::new(None),
            signal_stamp: Mutex::new(None),
            relayed_alarms: Mutex::new(HashSet::new()),
            running: Mutex::new(false),
            listeners: Mutex::new(Vec::new()),
            #[cfg(test)]
            test_interceptor_port: None,
            #[cfg(test)]
            test_detection_entries: Mutex::new(Vec::new()),
            config,
        }
    }

    pub fn data_dir(&self) -> &str {
        &self.data_dir
    }

    pub async fn start(self: &Arc<Self>) -> anyhow::Result<()> {
        if *self.running.lock().expect("running") {
            logger("Orchestrator").warn("already running", None);
            return Ok(());
        }
        self.emit(OrchestratorEvent::Starting);
        match self.start_components().await {
            Ok(()) => {
                self.emit(OrchestratorEvent::Started);
                Ok(())
            }
            Err(error) => {
                // A failure after opening the state store can leave retention,
                // flushers or discovery alive before running is published.
                let partial = self.state_store.lock().expect("state").is_some();
                if partial {
                    *self.running.lock().expect("running") = true;
                    self.stop_components().await;
                }
                self.emit(OrchestratorEvent::StartFailed(error.to_string()));
                Err(error)
            }
        }
    }

    async fn start_components(self: &Arc<Self>) -> anyhow::Result<()> {
        logger("Orchestrator").info("starting orchestrator", None);
        // 在启动输出、后台任务及任何 Agent 部署之前，先拒绝损坏或未提交的安装报告。
        let hook_report = crate::deployment::read_committed_hook_install_report(
            &hook_install_result_path(&self.data_dir),
        )
        .await
        .map_err(anyhow::Error::msg)?;
        ensure_dir(&self.data_dir).await;
        ensure_dir(&self.data_dir_join("logs")).await;
        clean_stale_tmp_files(&self.data_dir_join("logs"), DEFAULT_STALE_TMP_MAX_AGE_MS).await;
        let state_store = Arc::new(StateStore::new(self.data_dir_join("logs/input-state.json")));
        state_store.load().await;
        *self.state_store.lock().expect("state") = Some(Arc::clone(&state_store));
        self.inputs.set_state_store(Arc::clone(&state_store));
        self.load_agent_control().await;
        self.inputs
            .set_configured_user_id(self.config.user_id.clone());
        let policy = WorkspacePolicy::new(
            &self
                .config
                .privacy
                .as_ref()
                .map(|privacy| privacy.exclude_workspaces.clone())
                .unwrap_or_default(),
            Some(self.data_dir_join("state/workspace-exclusions")),
        )
        .map_err(|err| anyhow::anyhow!(err))?;
        let pipeline_policy = Arc::new(Mutex::new(
            WorkspacePolicy::new(
                &self
                    .config
                    .privacy
                    .as_ref()
                    .map(|privacy| privacy.exclude_workspaces.clone())
                    .unwrap_or_default(),
                Some(self.data_dir_join("state/workspace-exclusions")),
            )
            .map_err(|err| anyhow::anyhow!(err))?,
        ));
        self.inputs.set_workspace_policy(policy);
        self.inputs.set_agents_config(&self.config.agents);
        self.inputs.set_mask_config(self.config.mask.clone());
        let attributes = Arc::new(Mutex::new(GlobalAttributesProvider::new(
            &span_map(self.config.global_span_attributes.as_ref()),
            self.data_dir_join("span-attributes.json"),
        )));
        let (flusher, sls, otlp) = self.build_flusher(Arc::clone(&attributes)).await?;
        *self.flusher.lock().expect("flusher") = Some(Arc::clone(&flusher));
        *self.sls.lock().expect("sls") = sls;
        *self.otlp.lock().expect("otlp") = otlp;
        let version = read_installed_version(&self.data_dir);
        let alarm = Arc::new(AlarmManager::new(
            resolve_local_ip(),
            version.clone(),
            self.config.user_id.clone(),
        ));
        *self.alarm.lock().expect("alarm") = Some(Arc::clone(&alarm));
        self.inputs.set_flusher(flusher);
        self.inputs.set_alarm_manager(Arc::clone(&alarm));
        let verdicts = Arc::new(ToolVerdictStore::new(
            interceptor::interceptor_tool_verdict_path(Some(&self.data_dir)),
        ));
        verdicts.restore(chrono::Utc::now().timestamp_millis());
        *self.verdicts.lock().expect("verdicts") = Some(Arc::clone(&verdicts));
        let interceptor_config = load_interceptor_config(None).await;
        self.inputs
            .set_intercept_result_linker(Arc::new(InterceptResultLinker::new(
                Arc::clone(&verdicts),
                !resolve_enabled_interceptor_types(&interceptor_config).is_empty(),
            )));
        if self.config.upstream_link.enabled {
            let correlate = self.data_dir_join("acp-correlate");
            ensure_dir(&correlate).await;
            let store = CorrelationStore::new(&correlate);
            let linker = Arc::new(TraceLinker::new(store));
            self.inputs.set_trace_linker(Arc::clone(&linker));
            let retention = Arc::new(AcpCorrelateRetentionService::new(
                &self.data_dir,
                &self.config.upstream_link,
                Some(Arc::clone(&linker)),
            ));
            retention.start();
            *self.correlate_retention.lock().expect("correlate") = Some(retention);
            logger("Orchestrator").info("upstream trace linking enabled", Some(&fields(serde_json::json!({ "correlateDir": correlate, "ttlMs": self.config.upstream_link.ttl_ms }))));
        }
        self.start_multimodal().await;
        let pilot_dir = resolve_pilot_dir(&self.data_dir, &[]).map_err(anyhow::Error::msg)?;
        self.restore_pi_sdk(&alarm).await;
        let deployment = Arc::new(DeploymentManager::new(DeploymentManagerOptions {
            data_dir: self.data_dir.clone(),
            pilot_dir: pilot_dir.clone(),
            builtin_agents_dir: None,
            installed_by: Some(InstalledBy::Daemon),
        }));
        deployment.load_definitions().await;
        *self.deployment.lock().expect("deploy") = Some(Arc::clone(&deployment));
        self.apply_deployment_scope(hook_report.as_ref());
        self.relay_hook_install_alarm(hook_report.as_ref()).await;
        self.reconcile_recorded().await;
        if self.bits.lock().expect("bits").scope == DeploymentScopeMode::Auto {
            let bits = Arc::clone(&self.bits);
            let agents = Arc::clone(&self.agents);
            let config = self.config.clone();
            deployment
                .deploy_all(Some(&move |def: &AgentDefinition| {
                    listener_on(
                        &config,
                        &agents,
                        &bits.lock().expect("bits"),
                        &def.id,
                        &def.id,
                    )
                }))
                .await;
        } else {
            logger("Orchestrator").info("recorded deployment scope; skipping deployAll", None);
        }
        let watchdog = Arc::new(self.build_watchdog(&deployment));
        let workers = LocalWorkerActivationService::new(
            self.data_dir.clone(),
            pilot_dir.clone(),
            deployment.get_definitions(),
            ProbeSupervisor {
                probe: PluginProbeStrategy::new(self.data_dir.clone(), pilot_dir.clone()),
            },
        );
        workers.start().await;
        *self.workers.lock().expect("workers") = Some(workers);
        let detection = self.register_all_inputs(&state_store).await;
        let deploy_entries = self.deploy_detection_entries(&deployment);
        let mut entries = detection;
        entries.extend(deploy_entries);
        #[cfg(test)]
        entries.extend(
            self.test_detection_entries
                .lock()
                .expect("test entries")
                .drain(..),
        );

        let discovery = Arc::new(AgentDiscoveryService::new(entries));
        let owner = Arc::downgrade(self);
        discovery.on_event(move |event| {
            if let Some(owner) = owner.upgrade() {
                owner.handle_discovery_event(event);
            }
        });
        discovery.start().await;
        *self.discovery.lock().expect("discovery") = Some(discovery);
        let retention = Arc::new(LogRetentionService::new(
            &self.data_dir,
            self.config.retention.clone(),
        ));
        retention.start();
        *self.retention.lock().expect("retention") = Some(retention);
        watchdog.start();
        *self.hook_watchdog.lock().expect("watchdog") = Some(watchdog);
        self.watch_hook_install_signal();
        if self
            .config
            .auto_update
            .as_ref()
            .is_some_and(|update| update.enabled)
        {
            let updater = Arc::new(UpdaterWatchdog::new(UpdaterWatchdogOptions {
                enabled: true,
                data_dir: self.data_dir.clone(),
                loongsuite_pilot_bin: None,
                interval_ms: None,
                stale_heartbeat_ms: None,
                startup_grace_ms: None,
                sleep_wake_grace_ms: None,
                restart_cooldown_ms: None,
                alarm_manager: Some(Arc::clone(&alarm)),
                updater_liveness: None,
                restart_command: None,
                now_ms: None,
            }));
            updater.start();
            *self.updater_watchdog.lock().expect("updater") = Some(updater);
        }
        if self.config.pipeline.enabled {
            let pipeline = Arc::new(PipelineManager::new(PipelineManagerOptions {
                workspace_policy: Some(pipeline_policy),
                config_dir: self.data_dir_join("configs/local"),
                state_dir: self.data_dir_join("state/pipeline"),
                failed_log_dir: self.data_dir_join("logs/pipeline-failed"),
                data_dir: self.data_dir.clone(),
                pipeline_config: crate::pipeline::PipelineToggle {
                    enabled: self.config.pipeline.enabled,
                    file_enabled: self.config.pipeline.file.enabled,
                    qoder_api_enabled: self.config.pipeline.qoder_api.enabled,
                },
            }));
            pipeline.start().await;
            *self.pipeline.lock().expect("pipeline") = Some(pipeline);
        } else {
            logger("Orchestrator").info("pipeline subsystem disabled, skipping", None);
        }
        if let Some(sls) = self.sls.lock().expect("sls").clone() {
            sls.set_alarm_manager(Arc::new(AlarmBridge(Arc::clone(&alarm))));
        }
        let metrics = Arc::new(self.metrics_writer(&version, Arc::clone(&alarm)));
        metrics.start().await;
        *self.metrics.lock().expect("metrics") = Some(metrics);
        let package_version = self.read_package_version();
        let package_git = self.read_package_git_commit();
        let runtime = RuntimeWriter::new(
            &self.data_dir,
            self.config.status_bar.clone(),
            package_version.clone(),
            package_git.clone(),
        );
        let runtime_for_task = RuntimeWriter::new(
            &self.data_dir,
            self.config.status_bar.clone(),
            package_version.clone(),
            package_git.clone(),
        );
        let interval = runtime.refresh_interval_ms().max(1);
        *self.runtime_task.lock().expect("runtime task") = Some(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(interval));
            loop {
                ticker.tick().await;
                let _ = runtime_for_task.write_once().await;
            }
        }));
        *self.runtime_writer.lock().expect("runtime") = Some(runtime);
        let summary = MetricsSummaryWriter::new(
            &self.data_dir,
            self.config.status_bar.clone(),
            self.config
                .flushers
                .jsonl
                .as_ref()
                .map(|jsonl| jsonl.output_dir.as_str()),
        );
        let summary_for_task = MetricsSummaryWriter::new(
            &self.data_dir,
            self.config.status_bar.clone(),
            self.config
                .flushers
                .jsonl
                .as_ref()
                .map(|jsonl| jsonl.output_dir.as_str()),
        );
        let summary_interval = self.config.status_bar.metrics_summary_interval_ms.max(1);
        *self.summary_task.lock().expect("summary task") = Some(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(summary_interval));
            loop {
                ticker.tick().await;
                summary_for_task.refresh().await;
            }
        }));
        *self.summary_writer.lock().expect("summary") = Some(summary);
        let dashboard = dashboard::DashboardServer::new(dashboard::DashboardServerOptions {
            data_dir: self.data_dir.clone(),
            asset_path: Path::new(&pilot_dir)
                .join("assets")
                .join("dashboard")
                .join("index.html")
                .to_string_lossy()
                .into_owned(),
            host: None,
            port: Some(self.config.dashboard.port),
        });
        if let Err(err) = dashboard.start() {
            logger("Orchestrator").warn(
                "dashboard start failed (non-fatal)",
                Some(&fields(serde_json::json!({ "error": err }))),
            );
        }
        if let Some(error) = dashboard.last_start_error() {
            self.emit(OrchestratorEvent::ComponentFailure {
                component: "dashboard".into(),
                error,
            });
        }
        *self.dashboard.lock().expect("dashboard") = Some(dashboard);
        let inputs_for_prompt = Arc::clone(&self.inputs);
        match self
            .start_collector_interceptor(StartInterceptorServiceOptions {
                data_dir: self.data_dir.clone(),
                version: package_version.clone(),
                git_commit: if package_git.is_empty() {
                    None
                } else {
                    Some(package_git)
                },
                verdict_store: Some(verdicts),
                emit_blocked_prompt: Some(Arc::new(move |entry| {
                    let inputs = Arc::clone(&inputs_for_prompt);
                    tokio::spawn(async move {
                        if let Err(err) = inputs.flush_prepared_entries(vec![entry]).await {
                            logger("Orchestrator").warn(
                                "blocked prompt flush failed",
                                Some(&fields(serde_json::json!({ "error": err }))),
                            );
                        }
                    });
                })),
            })
            .await
        {
            Ok(service) => {
                *self.interceptor.lock().expect("interceptor") = Some(service);
            }
            Err(err) => logger("Orchestrator").warn(
                "interceptor start failed (non-fatal)",
                Some(&fields(serde_json::json!({ "error": err.to_string() }))),
            ),
        }
        if cfg!(target_os = "macos") && self.config.status_bar.enabled {
            let status = StatusBarAppManager::new(
                self.data_dir.clone(),
                package_version,
                ProcessOps::native(&self.data_dir),
            )
            .with_source_roots(vec![pilot_dir.clone()]);
            if let Err(err) = status.sync_desired_state(true).await {
                logger("Orchestrator").warn(
                    "status bar app start failed (non-fatal)",
                    Some(&fields(serde_json::json!({ "error": err }))),
                );
            }
            *self.status_bar.lock().expect("status") = Some(status);
        }
        *self.running.lock().expect("running") = true;
        logger("Orchestrator").info("orchestrator started", None);
        let cleanup = Arc::new(LegacySlsFailedLogCleanupService::new(&self.data_dir));
        cleanup.start();
        *self.legacy_cleanup.lock().expect("legacy") = Some(cleanup);
        Ok(())
    }

    async fn load_agent_control(&self) {
        let mut control = AgentControlManager::new(Some(self.data_dir_join("agent-control.json")));
        // 文件读取期间不持同步锁，完成后再发布控制配置与门禁快照。
        control.load().await;
        let modes = control.get_all_modes();
        *self.control.lock().expect("control") = control;
        self.bits.lock().expect("bits").modes = modes;
    }

    pub async fn stop(&self) {
        if !*self.running.lock().expect("running") {
            return;
        }
        self.stop_components().await;
        self.emit(OrchestratorEvent::Stopped);
    }

    async fn stop_components(&self) {
        logger("Orchestrator").info("stopping orchestrator", None);
        // 先取出组件再等待停止，避免回调或后台任务访问同一同步锁时死锁。
        let pipeline = self.pipeline.lock().expect("pipeline").take();
        if let Some(pipeline) = pipeline {
            pipeline.stop().await;
        }
        let status = self.status_bar.lock().expect("status").take();
        if let Some(status) = status {
            if let Err(err) = status.stop("orchestrator-shutdown").await {
                logger("Orchestrator").warn(
                    "status bar app stop failed during orchestrator shutdown",
                    Some(&fields(serde_json::json!({ "error": err }))),
                );
                self.emit(OrchestratorEvent::ComponentFailure {
                    component: "status-bar".into(),
                    error: err,
                });
            }
        }
        if let Some(dashboard) = self.dashboard.lock().expect("dashboard").take() {
            dashboard.stop();
        }
        let service = self.interceptor.lock().expect("interceptor").take();
        if let Some(service) = service {
            service.stop().await;
        } else if let Some(verdicts) = self.verdicts.lock().expect("verdicts").clone() {
            if let Err(err) = verdicts.dump(chrono::Utc::now().timestamp_millis()) {
                logger("Orchestrator").warn(
                    "interceptor verdict checkpoint failed",
                    Some(&fields(serde_json::json!({ "error": err.to_string() }))),
                );
            }
        }
        *self.verdicts.lock().expect("verdicts") = None;
        let summary = self.summary_writer.lock().expect("summary").take();
        if let Some(summary) = summary {
            summary.stop().await;
        }
        if let Some(task) = self.summary_task.lock().expect("summary task").take() {
            task.abort();
        }
        if let Some(runtime) = self.runtime_writer.lock().expect("runtime").take() {
            runtime.remove();
        }
        if let Some(task) = self.runtime_task.lock().expect("runtime task").take() {
            task.abort();
        }
        if let Some(task) = self.signal_task.lock().expect("signal").take() {
            task.abort();
        }
        if let Some(updater) = self.updater_watchdog.lock().expect("updater").take() {
            updater.stop();
        }
        if let Some(watchdog) = self.hook_watchdog.lock().expect("watchdog").take() {
            watchdog.stop();
        }
        if let Some(cleanup) = self.legacy_cleanup.lock().expect("legacy").take() {
            cleanup.stop();
        }
        if let Some(retention) = self.retention.lock().expect("retention").take() {
            retention.stop();
        }
        if let Some(retention) = self.correlate_retention.lock().expect("correlate").take() {
            retention.stop();
        }
        let workers = self.workers.lock().expect("workers").take();
        if let Some(workers) = workers {
            workers.stop().await;
        }
        let deployment = self.deployment.lock().expect("deploy").clone();
        if let Some(deployment) = deployment {
            if let Err(error) = deployment.stop_workers().await {
                logger("Orchestrator").error(
                    "probe worker 停止失败",
                    Some(&fields(serde_json::json!({"error": error}))),
                );
            }
        }
        self.inputs.cancel_pending_outputs();
        let discovery = self.discovery.lock().expect("discovery").clone();
        if let Some(discovery) = discovery {
            discovery.stop().await;
        }
        self.inputs.stop_all().await;
        let metrics = self.metrics.lock().expect("metrics").take();
        if let Some(metrics) = metrics {
            metrics.stop().await;
        }
        let flusher = self.flusher.lock().expect("flusher").clone();
        if let Some(flusher) = flusher {
            if let Err(error) = flusher.shutdown().await {
                self.emit(OrchestratorEvent::ComponentFailure {
                    component: "flusher".into(),
                    error: error.to_string(),
                });
            }
        }
        let store = self.state_store.lock().expect("state").clone();
        if let Some(store) = store {
            if let Err(error) = store.save().await {
                self.emit(OrchestratorEvent::ComponentFailure {
                    component: "checkpoint".into(),
                    error: error.to_string(),
                });
            }
        }
        *self.running.lock().expect("running") = false;
        logger("Orchestrator").info("orchestrator stopped", None);
    }

    /// Set the asynchronously resolved fallback identity. Explicit configured
    /// and invocation identities keep their existing precedence.
    pub fn set_user_id(&self, user_id: impl Into<String>) {
        self.inputs.set_user_id(user_id);
    }

    pub fn on_event(&self, listener: impl Fn(OrchestratorEvent) + Send + Sync + 'static) {
        self.listeners
            .lock()
            .expect("listeners")
            .push(Arc::new(listener));
    }

    fn emit(&self, event: OrchestratorEvent) {
        // Callbacks may inspect the collector or register another callback.
        let listeners = self.listeners.lock().expect("listeners").clone();
        for listener in listeners {
            listener(event.clone());
        }
    }

    fn handle_discovery_event(&self, event: AgentDiscoveryEvent) {
        match &event {
            AgentDiscoveryEvent::Started(id) => logger("Orchestrator").info(
                "agent detected and started",
                Some(&fields(serde_json::json!({ "id": id }))),
            ),
            AgentDiscoveryEvent::Stopped(id, AgentStopReason::Unexpected) => {
                logger("Orchestrator").warn(
                    "agent stopped unexpectedly",
                    Some(&fields(serde_json::json!({ "id": id }))),
                );
                if let Some(alarm) = self.alarm_manager() {
                    alarm.record(
                        "INPUT_STOP_ALARM",
                        "3",
                        &format!("input {id} stopped unexpectedly (reason=unexpected)"),
                        Some(AlarmContext {
                            input_name: Some(id.clone()),
                            endpoint_name: None,
                        }),
                    );
                }
            }
            AgentDiscoveryEvent::Stopped(id, reason) => logger("Orchestrator").debug(
                "agent stopped",
                Some(&fields(
                    serde_json::json!({ "id": id, "reason": reason.as_str() }),
                )),
            ),
        }
        self.emit(OrchestratorEvent::Agent(event));
    }

    pub fn input_manager(&self) -> &InputManager {
        &self.inputs
    }
    pub fn alarm_manager(&self) -> Option<Arc<AlarmManager>> {
        self.alarm.lock().expect("alarm").clone()
    }

    async fn start_collector_interceptor(
        &self,
        options: StartInterceptorServiceOptions,
    ) -> std::io::Result<InterceptorService> {
        #[cfg(test)]
        if let Some(port) = self.test_interceptor_port {
            return crate::interceptor::daemon::start_interceptor_service_at_port(options, port)
                .await;
        }
        start_interceptor_service(options).await
    }

    async fn start_multimodal(&self) {
        let Some(config) = self.config.multimodal.clone() else {
            if any_agent_multimodal_enabled(&self.config.agents) {
                logger("Orchestrator").warn("agents enable multimodal but global multimodal infra is missing; inputs will not convert media to uri", None);
            }
            return;
        };
        if !any_agent_multimodal_enabled(&self.config.agents) {
            return;
        }
        let processor = match &config.storage {
            MultimodalStorage::DelegatedOss { target, auth } => {
                let runtime = match create_delegated_oss_uploader(
                    target.clone(),
                    auth.clone(),
                    &config.storage_base_path,
                ) {
                    Ok(runtime) => runtime,
                    Err(err) => {
                        logger("Orchestrator").error(
                            "multimodal init failed; disabled for process",
                            Some(&fields(serde_json::json!({ "error": err }))),
                        );
                        return;
                    }
                };
                let discovered = runtime.resolve_storage_base().await;
                let initial = match &discovered {
                    StorageBaseResult::Ok { storage_base_path } => Some(storage_base_path.clone()),
                    StorageBaseResult::Err { error } => {
                        logger("Orchestrator").warn(
                            "multimodal processor waiting for delegatedOss bucket",
                            Some(&fields(serde_json::json!({ "error": error }))),
                        );
                        None
                    }
                };
                let uploader = Arc::clone(&runtime.uploader);
                match MultimodalProcessor::new(
                    initial.as_deref(),
                    uploader,
                    Some(Arc::new(move || {
                        let runtime_uploader = Arc::clone(&runtime.uploader);
                        Box::pin(
                            async move { runtime_uploader.discover_delegated_oss_bucket().await },
                        )
                    })),
                ) {
                    Ok(processor) => processor,
                    Err(err) => {
                        logger("Orchestrator").error(
                            "multimodal init failed; disabled for process",
                            Some(&fields(serde_json::json!({ "error": err }))),
                        );
                        return;
                    }
                }
            }
            _ => match create_uploader(&config, None) {
                Ok(uploader) => {
                    match MultimodalProcessor::new(Some(&config.storage_base_path), uploader, None)
                    {
                        Ok(processor) => processor,
                        Err(err) => {
                            logger("Orchestrator").error(
                                "multimodal init failed; disabled for process",
                                Some(&fields(serde_json::json!({ "error": err }))),
                            );
                            return;
                        }
                    }
                }
                Err(err) => {
                    logger("Orchestrator").error(
                        "multimodal init failed; disabled for process",
                        Some(&fields(serde_json::json!({ "error": err }))),
                    );
                    return;
                }
            },
        };
        let storage_base_path = processor.storage_base_path();
        self.inputs.set_multimodal_processor(processor);
        *self.multimodal_ready.lock().expect("multimodal") = true;
        self.emit(OrchestratorEvent::MultimodalReady { storage_base_path });
        logger("Orchestrator").info(
            "multimodal processor enabled",
            Some(&fields(
                serde_json::json!({ "storageBasePath": config.storage_base_path }),
            )),
        );
    }

    async fn restore_pi_sdk(&self, alarm: &AlarmManager) {
        match ensure_registered_pi_sdk_wrappers(&self.data_dir).await {
            Ok(count) if count > 0 => logger("Orchestrator").info(
                "restored generated PI SDK Agent wrappers",
                Some(&fields(serde_json::json!({ "count": count }))),
            ),
            Ok(_) => {}
            Err(err) => {
                let busy = is_pi_sdk_registry_busy_error(&err);
                logger("Orchestrator").error(
                    "failed to restore generated PI SDK Agent wrappers",
                    Some(&fields(
                        serde_json::json!({ "error": err, "registryBusy": busy }),
                    )),
                );
                alarm.record(
                    "DEGRADED_STARTUP_ALARM",
                    "2",
                    if busy { "PI SDK Agent wrapper restore skipped because the registry remained busy after bounded retries" } else { "PI SDK Agent wrapper restore failed during startup; inspect local Pilot logs and run agent doctor" },
                    Some(AlarmContext { input_name: Some("pi-coding-agent-log".into()), endpoint_name: None }),
                );
            }
        }
    }

    async fn refresh_deployment_scope(&self) -> Result<(), String> {
        let path = hook_install_result_path(&self.data_dir);
        let report = crate::deployment::read_committed_hook_install_report(&path).await?;
        self.apply_deployment_scope(report.as_ref());
        self.relay_hook_install_alarm(report.as_ref()).await;
        Ok(())
    }

    fn apply_deployment_scope(&self, report: Option<&HookInstallReport>) {
        let scope_input = report.map(|report| DeploymentScopeResult {
            scope: Some(report.scope.clone()),
            identity: Some(report.identity.clone()),
        });
        let scope = resolve_deployment_scope(
            &crate::utils::read_container_identity(),
            scope_input.as_ref(),
        );
        {
            let mut bits = self.bits.lock().expect("bits");
            bits.scope = scope;
            bits.recorded = if scope == DeploymentScopeMode::Recorded {
                self.allow_list(report)
            } else {
                HashSet::new()
            };
        }
    }

    fn allow_list(&self, report: Option<&HookInstallReport>) -> HashSet<String> {
        let mut allowed = HashSet::new();
        if let Some(report) = report {
            for agent in &report.agents {
                if agent.status == "ok" || agent.status == "up-to-date" {
                    allowed.insert(agent.id.clone());
                }
            }
        }
        if let Some(deployment) = self.deployment.lock().expect("deploy").clone() {
            for def in deployment.get_definitions() {
                if deployment.record_installed_by(&def.id) == Some(InstalledBy::Build) {
                    allowed.insert(def.id);
                }
            }
        }
        allowed
    }

    async fn relay_hook_install_alarm(&self, report: Option<&HookInstallReport>) {
        let alarm_report = report.map(|report| HookInstallAlarmReport {
            identity: report.identity.clone(),
            ts: report.ts.clone(),
            alarm_sent: report.alarm_sent,
            agents: report
                .agents
                .iter()
                .map(|agent| HookInstallAlarmAgent {
                    id: Some(agent.id.clone()),
                    status: agent.status.clone(),
                    reason: agent.reason.clone(),
                })
                .collect(),
        });
        let sent = self.relayed_alarms.lock().expect("relay").clone();
        if !should_relay_hook_install_alarm(alarm_report.as_ref(), &sent) {
            return;
        }
        let Some(report) = report else { return };
        let marked =
            mark_hook_install_alarm_sent(&hook_install_result_path(&self.data_dir), &report.ts)
                .await
                .unwrap_or("stale");
        if marked == "stale" {
            return;
        }
        self.relayed_alarms
            .lock()
            .expect("relay")
            .insert(hook_install_alarm_key(&report.identity, &report.ts));
        if marked != "marked" {
            return;
        }
        let failed = report
            .agents
            .iter()
            .filter(|agent| agent.status == "failed")
            .map(|agent| agent.id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        if let Some(alarm) = self.alarm.lock().expect("alarm").clone() {
            alarm.record(
                "HOOK_INSTALL_ALARM",
                "2",
                &format!(
                    "hook install failed identity={} ts={} agents={failed}",
                    report.identity, report.ts
                ),
                None,
            );
        }
    }

    async fn reconcile_recorded(&self) {
        if self.bits.lock().expect("bits").scope != DeploymentScopeMode::Recorded {
            return;
        }
        let Some(deployment) = self.deployment.lock().expect("deploy").clone() else {
            return;
        };
        let recorded = self.bits.lock().expect("bits").recorded.clone();
        for def in deployment.get_definitions() {
            if !deployment.has_record(&def.id)
                || recorded.contains(&def.id)
                || deployment.record_installed_by(&def.id) == Some(InstalledBy::Build)
            {
                continue;
            }
            if let Err(err) = async {
                if !deployment.undeploy_agent(&def).await {
                    Err(anyhow::anyhow!("undeploy returned false"))
                } else {
                    Ok(())
                }
            }
            .await
            {
                logger("Orchestrator").warn(
                    "failed to remove agent outside recorded scope",
                    Some(&fields(
                        serde_json::json!({ "agentId": def.id, "error": err.to_string() }),
                    )),
                );
            }
        }
        let discovery = self.discovery.lock().expect("discovery").clone();
        if let Some(discovery) = discovery {
            discovery.refresh("recorded-scope").await;
        }
    }

    fn watch_hook_install_signal(self: &Arc<Self>) {
        let this = Arc::clone(self);
        *self.signal_task.lock().expect("signal") = Some(tokio::spawn(async move {
            let signal = hook_install_signal_path(&this.data_dir);
            let mut ticker = tokio::time::interval(Duration::from_secs(1));
            loop {
                ticker.tick().await;
                this.poll_hook_install_signal(&signal).await;
            }
        }));
    }

    async fn poll_hook_install_signal(&self, signal: &str) {
        let Ok(meta) = crate::utils::runtime_paths::runtime_metadata(Path::new(signal)) else {
            return;
        };
        if !meta.is_file() || meta.len() > 256 {
            return;
        }
        let Ok(stamp) = (|| -> std::io::Result<_> {
            let file = std::fs::File::open(signal)?;
            let modified = file.metadata()?.modified()?;
            let mut token = Vec::new();
            file.take(257).read_to_end(&mut token)?;
            if token.len() > 256 {
                return Err(std::io::Error::other("Hook 刷新信号超限"));
            }
            Ok((modified, token))
        })() else {
            return;
        };
        // 内容参与比较，避免低精度文件系统或连续安装产生相同 mtime 而漏掉刷新。
        if self.signal_stamp.lock().expect("signal stamp").as_ref() == Some(&stamp) {
            return;
        }
        let deployment = self.deployment.lock().expect("deploy").clone();
        if let Some(deployment) = deployment {
            deployment.load_definitions().await;
        }
        if let Err(err) = self.refresh_deployment_scope().await {
            logger("Orchestrator").warn(&format!("Hook 报告未提交，暂缓刷新：{err}"), None);
            return;
        }
        self.reconcile_recorded().await;
        *self.signal_stamp.lock().expect("signal stamp") = Some(stamp);
    }

    fn deploy_detection_entries(
        &self,
        deployment: &DeploymentManager,
    ) -> Vec<Arc<dyn AgentDetection>> {
        let mut entries = Vec::new();
        for def in deployment.get_definitions() {
            let watch = def
                .detection
                .paths
                .iter()
                .map(|path| {
                    if path.starts_with('~') {
                        resolve_home(path)
                    } else {
                        path.clone()
                    }
                })
                .collect::<Vec<_>>();
            if watch.is_empty() {
                continue;
            }
            let id = format!("deploy:{}", def.id);
            let deployment = Arc::clone(
                &self
                    .deployment
                    .lock()
                    .expect("deploy")
                    .clone()
                    .unwrap_or_else(|| {
                        Arc::new(DeploymentManager::new(DeploymentManagerOptions {
                            data_dir: self.data_dir.clone(),
                            pilot_dir: self.data_dir.clone(),
                            builtin_agents_dir: None,
                            installed_by: None,
                        }))
                    }),
            );
            let def_for_available = def.clone();
            let def_for_start = def.clone();
            let bits = Arc::clone(&self.bits);
            let agents = Arc::clone(&self.agents);
            let config = self.config.clone();
            let agent_id = def.id.clone();
            entries.push(Arc::new(ClosureDetection {
                id,
                type_name: "deploy-detection".into(),
                watch,
                poll_ms: 300_000,
                threshold: 1,
                enabled: Arc::new(move || {
                    let bits = bits.lock().expect("bits");
                    listener_on(&config, &agents, &bits, &agent_id, &agent_id)
                }),
                available: Arc::new(move || {
                    let deployment = Arc::clone(&deployment);
                    let def = def_for_available.clone();
                    let bits_scope = DeploymentScopeMode::Auto;
                    let _ = bits_scope;
                    Box::pin(async move { deployment.is_agent_detected(&def).await })
                }),
                start: Arc::new({
                    let deployment = self.deployment.lock().expect("deploy").clone().unwrap();
                    move || {
                        let deployment = Arc::clone(&deployment);
                        let def = def_for_start.clone();
                        Box::pin(async move {
                            logger("Orchestrator").info(
                                "new agent discovered, deploying",
                                Some(&fields(serde_json::json!({ "agentId": def.id }))),
                            );
                            let _ = deployment.deploy_single(&def).await;
                            Ok(())
                        })
                    }
                }),
                stop: Arc::new(|| Box::pin(async { Ok(()) })),
            }) as Arc<dyn AgentDetection>);
        }
        entries
    }

    fn hook_watchdog_targets(&self, deployment: &DeploymentManager) -> Vec<PluginCheckTarget> {
        let mut targets = Vec::new();
        for def in deployment.get_definitions() {
            if def.deploy_mode != DeployMode::Hook || def.hook.is_none() || def.id == "grok-build" {
                continue;
            }
            let hook = def.hook.clone().unwrap();
            let script = Path::new(hook.hook_command.split_whitespace().next().unwrap_or(""))
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_string();
            let def_for_repair = def.clone();
            let deployment_repair =
                Arc::clone(self.deployment.lock().expect("deploy").as_ref().unwrap());
            let bits = Arc::clone(&self.bits);
            let agents = Arc::clone(&self.agents);
            let config = self.config.clone();
            let agent_id = def.id.clone();
            let mut target = PluginCheckTarget {
                agent_id: def.id.clone(),
                settings_path: hook.settings_path.clone(),
                settings_syntax: match hook.settings_syntax {
                    Some(crate::types::SettingsSyntax::Jsonc) => JsonSyntax::Jsonc,
                    _ => JsonSyntax::Json,
                },
                expected_hooks: hook.events.clone(),
                markers: vec![script],
                bin_path: None,
                install_args: Vec::new(),
                repair_fn: Some(Arc::new(move || {
                    let deployment = Arc::clone(&deployment_repair);
                    let def = def_for_repair.clone();
                    Box::pin(async move { Ok(deployment.deploy_single(&def).await.success) })
                })),
                change_watch_path: None,
                needs_repair_on_change: None,
                enabled: Some(Arc::new(move || {
                    listener_on(
                        &config,
                        &agents,
                        &bits.lock().expect("bits"),
                        &agent_id,
                        &agent_id,
                    )
                })),
            };
            if def.id == "codex" {
                if let Some(trust) = hook.trust_toml.as_ref() {
                    target.change_watch_path = Some(resolve_home(&trust.config_path));
                    let deployment_change =
                        Arc::clone(self.deployment.lock().expect("deploy").as_ref().unwrap());
                    let def_change = def.clone();
                    target.needs_repair_on_change = Some(Arc::new(move || {
                        let deployment = Arc::clone(&deployment_change);
                        let def = def_change.clone();
                        Box::pin(async move { Ok(deployment.needs_redeploy(&def, None).await) })
                    }));
                }
            }
            targets.push(target);
        }
        targets
    }

    fn build_watchdog(&self, deployment: &DeploymentManager) -> HookWatchdog {
        let targets = self.hook_watchdog_targets(deployment);
        let enabled = {
            let bits = Arc::clone(&self.bits);
            let agents = Arc::clone(&self.agents);
            let config = self.config.clone();
            move |id: &str| listener_on(&config, &agents, &bits.lock().expect("bits"), id, id)
        };
        let mut intercepts = HookWatchdog::default_intercept_targets(&self.data_dir, enabled);
        intercepts.extend(self.grok_intercepts(deployment));
        intercepts.extend(self.plugin_inject_intercepts(deployment));
        intercepts.extend(self.directory_plugin_intercepts(deployment));
        intercepts.extend(self.copilot_intercepts(deployment));
        intercepts.extend(self.dsh_intercepts(deployment));
        HookWatchdog::new(self.config.hook_watchdog.clone(), targets, intercepts)
    }

    fn grok_intercepts(&self, deployment: &DeploymentManager) -> Vec<InterceptCheckTarget> {
        let Some(def) = deployment
            .get_definitions()
            .into_iter()
            .find(|def| def.id == "grok-build" && def.hook.is_some())
        else {
            return Vec::new();
        };
        let pilot_dir = deployment.pilot_dir().to_owned();
        let data_dir = self.data_dir.clone();
        let deployment_check =
            Arc::clone(self.deployment.lock().expect("deploy").as_ref().unwrap());
        let deployment_repair = Arc::clone(&deployment_check);
        let deployment_cleanup = Arc::clone(&deployment_check);
        let deployment_pre = Arc::clone(&deployment_check);
        let bits = Arc::clone(&self.bits);
        let agents = Arc::clone(&self.agents);
        let config = self.config.clone();
        let def_pre = def.clone();
        let def_check = def.clone();
        let def_repair = def.clone();
        let def_cleanup = def.clone();
        let pilot_for_repair = pilot_dir.clone();
        let data_for_repair = data_dir.clone();
        vec![InterceptCheckTarget {
            id: "hook:grok-build".into(),
            enabled: Arc::new(move || {
                listener_on(
                    &config,
                    &agents,
                    &bits.lock().expect("bits"),
                    "grok-build",
                    "grok-build",
                )
            }),
            precondition: Arc::new(move || {
                let deployment = Arc::clone(&deployment_pre);
                let def = def_pre.clone();
                Box::pin(async move { deployment.is_agent_detected(&def).await })
            }),
            check: Arc::new(move || {
                let deployment = Arc::clone(&deployment_check);
                let def = def_check.clone();
                let pilot = pilot_dir.clone();
                let data = data_dir.clone();
                Box::pin(async move {
                    !deployment.needs_redeploy(&def, None).await
                        && are_grok_build_hook_assets_healthy(&pilot, &data).await
                })
            }),
            repair: Arc::new(move || {
                let deployment = Arc::clone(&deployment_repair);
                let def = def_repair.clone();
                let pilot = pilot_for_repair.clone();
                let data = data_for_repair.clone();
                Box::pin(async move {
                    restore_grok_build_hook_assets(&pilot, &data).await?;
                    let result = deployment.deploy_single(&def).await;
                    if !result.success {
                        return Err(result
                            .error
                            .unwrap_or_else(|| "failed to restore Grok Build hook".into()));
                    }
                    if deployment.needs_redeploy(&def, None).await
                        || !are_grok_build_hook_assets_healthy(&pilot, &data).await
                    {
                        return Err("Grok Build hook remains unhealthy after repair".into());
                    }
                    Ok(())
                })
            }),
            cleanup: Some(Arc::new(move || {
                let deployment = Arc::clone(&deployment_cleanup);
                let def = def_cleanup.clone();
                Box::pin(async move {
                    if deployment.undeploy_agent(&def).await {
                        Ok(())
                    } else {
                        Err("failed to remove Grok Build hook".into())
                    }
                })
            })),
        }]
    }

    fn plugin_inject_intercepts(
        &self,
        deployment: &DeploymentManager,
    ) -> Vec<InterceptCheckTarget> {
        self.mode_intercepts(deployment, DeployMode::PluginInject, "plugin-inject", true)
    }

    fn directory_plugin_intercepts(
        &self,
        deployment: &DeploymentManager,
    ) -> Vec<InterceptCheckTarget> {
        self.mode_intercepts(
            deployment,
            DeployMode::DirectoryPlugin,
            "directory-plugin",
            false,
        )
    }

    fn copilot_intercepts(&self, deployment: &DeploymentManager) -> Vec<InterceptCheckTarget> {
        // Copilot's current automatic plugin deployment uses Unix shell hooks.
        if cfg!(windows) {
            return Vec::new();
        }
        self.mode_intercepts(
            deployment,
            DeployMode::CopilotPlugin,
            "copilot-plugin",
            true,
        )
    }

    fn dsh_intercepts(&self, deployment: &DeploymentManager) -> Vec<InterceptCheckTarget> {
        self.mode_intercepts(deployment, DeployMode::DshYamlPatch, "dsh-yaml-patch", true)
    }

    fn mode_intercepts(
        &self,
        deployment: &DeploymentManager,
        mode: DeployMode,
        prefix: &str,
        cleanup: bool,
    ) -> Vec<InterceptCheckTarget> {
        let mut targets = Vec::new();
        for def in deployment.get_definitions() {
            if def.deploy_mode != mode
                || (mode == DeployMode::DirectoryPlugin && def.directory_plugin.is_none())
                || (mode == DeployMode::DshYamlPatch && def.dsh_yaml_patch.is_none())
                || (mode == DeployMode::CopilotPlugin && def.copilot_plugin.is_none())
            {
                continue;
            }
            let deployment_arc =
                Arc::clone(self.deployment.lock().expect("deploy").as_ref().unwrap());
            let bits = Arc::clone(&self.bits);
            let agents = Arc::clone(&self.agents);
            let config = self.config.clone();
            let agent_id = def.id.clone();
            let id = format!("{prefix}:{}", def.id);
            let def_pre = def.clone();
            let def_check = def.clone();
            let def_repair = def.clone();
            let def_cleanup = def.clone();
            let data_dir = self.data_dir.clone();
            targets.push(InterceptCheckTarget {
                id,
                enabled: Arc::new(move || {
                    listener_on(
                        &config,
                        &agents,
                        &bits.lock().expect("bits"),
                        &agent_id,
                        &agent_id,
                    )
                }),
                precondition: Arc::new(move || {
                    let deployment = Arc::clone(&deployment_arc);
                    let def = def_pre.clone();
                    let data_dir = data_dir.clone();
                    Box::pin(async move {
                        if def.deploy_mode == DeployMode::CopilotPlugin {
                            deployment.is_agent_detected(&def).await
                        } else {
                            precondition_for(&def, &deployment, &data_dir).await
                        }
                    })
                }),
                check: Arc::new({
                    let deployment =
                        Arc::clone(self.deployment.lock().expect("deploy").as_ref().unwrap());
                    move || {
                        let deployment = Arc::clone(&deployment);
                        let def = def_check.clone();
                        Box::pin(async move { !deployment.needs_redeploy(&def, None).await })
                    }
                }),
                repair: Arc::new({
                    let deployment =
                        Arc::clone(self.deployment.lock().expect("deploy").as_ref().unwrap());
                    move || {
                        let deployment = Arc::clone(&deployment);
                        let def = def_repair.clone();
                        Box::pin(async move {
                            let result = deployment.deploy_single(&def).await;
                            if def.deploy_mode == DeployMode::CopilotPlugin
                                && result.skipped == Some(true)
                            {
                                return Err(result.error.unwrap_or_else(|| {
                                    "Copilot disappeared before plugin repair".into()
                                }));
                            }
                            if result.skipped == Some(true)
                                && result.reason == Some(DeploySkipReason::NotDetected)
                            {
                                return Err(if def.deploy_mode == DeployMode::DshYamlPatch {
                                    "DSH disappeared before YAML patch repair".into()
                                } else {
                                    format!("Agent disappeared before repair for {}", def.id)
                                });
                            }
                            if !result.success {
                                return Err(result
                                    .error
                                    .unwrap_or_else(|| format!("repair failed for {}", def.id)));
                            }
                            Ok(())
                        })
                    }
                }),
                cleanup: if cleanup {
                    let deployment =
                        Arc::clone(self.deployment.lock().expect("deploy").as_ref().unwrap());
                    Some(Arc::new(move || {
                        let deployment = Arc::clone(&deployment);
                        let def = def_cleanup.clone();
                        Box::pin(async move {
                            if def.deploy_mode == DeployMode::CopilotPlugin
                                && !deployment.has_record(&def.id)
                            {
                                return Ok(());
                            }
                            if deployment.undeploy_agent(&def).await {
                                Ok(())
                            } else {
                                Err(if def.deploy_mode == DeployMode::DshYamlPatch {
                                    "failed to remove DSH YAML patch".into()
                                } else {
                                    format!("failed to remove {}", def.id)
                                })
                            }
                        })
                    }))
                } else {
                    None
                },
            });
        }
        targets
    }

    async fn build_flusher(
        &self,
        attributes: Arc<Mutex<GlobalAttributesProvider>>,
    ) -> anyhow::Result<(
        Arc<dyn BaseFlusher>,
        Option<Arc<SlsFlusher>>,
        Option<Arc<OtlpTraceFlusher>>,
    )> {
        let mut flushers: Vec<Arc<dyn BaseFlusher>> = Vec::new();
        let mut sls = None;
        let version = self.read_package_version();
        let _ = version;
        if self
            .config
            .flushers
            .sls
            .as_ref()
            .is_some_and(|sls| sls.enabled)
            && self.config.collect_log
        {
            let flusher = Arc::new(SlsFlusher::new(
                self.config.flushers.sls.clone().unwrap(),
                &self.data_dir,
            ));
            if let Err(err) = flusher.start().await {
                logger("Orchestrator").warn(
                    "sls flusher start failed",
                    Some(&fields(serde_json::json!({ "error": err.to_string() }))),
                );
            }
            sls = Some(Arc::clone(&flusher));
            flushers.push(flusher);
        }
        if self
            .config
            .flushers
            .jsonl
            .as_ref()
            .is_some_and(|jsonl| jsonl.enabled)
        {
            let flusher = Arc::new(JsonlFlusher::new(
                self.config.flushers.jsonl.clone().unwrap(),
            ));
            if let Err(err) = flusher.start().await {
                logger("Orchestrator").warn(
                    "jsonl flusher start failed",
                    Some(&fields(serde_json::json!({ "error": err.to_string() }))),
                );
            }
            flushers.push(flusher);
        }
        if self
            .config
            .flushers
            .http
            .as_ref()
            .is_some_and(|http| http.enabled)
        {
            let flusher = Arc::new(HttpFlusher::new(self.config.flushers.http.clone().unwrap()));
            if let Err(err) = flusher.start().await {
                logger("Orchestrator").warn(
                    "http flusher start failed",
                    Some(&fields(serde_json::json!({ "error": err.to_string() }))),
                );
            }
            flushers.push(flusher);
        }
        let mut otlp = None;
        if let Some(mut trace) = build_otlp_trace_config(&self.config) {
            if trace.enabled && !trace.endpoints.is_empty() {
                trace.data_dir = Some(self.data_dir.clone());
                match OtlpTraceFlusher::with_parts(trace, Some(attributes), None, None) {
                    Ok(flusher) => {
                        let manager = Arc::downgrade(&self.inputs);
                        let journal = Arc::new(crate::flushers::CodexTurnJournal::new(
                            self.data_dir_join("logs/codex-pending-turns"),
                        ));
                        let flusher = flusher.with_codex_journal(journal, move |entries| {
                            manager
                                .upgrade()
                                .map(|manager| manager.prepare_restored_entries(entries))
                                .ok_or_else(|| {
                                    "Codex replay privacy context is unavailable".to_string()
                                })
                        });
                        let manager = Arc::downgrade(&self.inputs);
                        let journal = Arc::new(crate::flushers::DoubaoTurnJournal::new(
                            self.data_dir_join("logs/doubao-pending-turns"),
                        ));
                        let flusher = flusher.with_doubao_journal(journal, move |entries| {
                            manager
                                .upgrade()
                                .map(|manager| manager.prepare_restored_entries(entries))
                                .ok_or_else(|| {
                                    "Doubao replay privacy context is unavailable".to_string()
                                })
                        });
                        if let Err(error) = flusher.start().await {
                            let _ = flusher.shutdown().await;
                            for prior in &flushers {
                                let _ = prior.shutdown().await;
                            }
                            return Err(anyhow::Error::new(error));
                        }
                        let flusher = Arc::new(flusher);
                        otlp = Some(Arc::clone(&flusher));
                        flushers.push(flusher);
                    }
                    Err(err) => logger("Orchestrator").warn(
                        "OtlpTraceFlusher unavailable, skipping",
                        Some(&fields(serde_json::json!({ "error": err }))),
                    ),
                }
            }
        }
        if flushers.is_empty() {
            logger("Orchestrator").warn("no flushers enabled, using JSONL fallback", None);
            let fallback = Arc::new(JsonlFlusher::new(JsonlFlusherConfig {
                enabled: true,
                output_dir: self.data_dir_join("logs/output"),
                rotate_daily: true,
                max_file_size_mb: 100,
            }));
            let _ = fallback.start().await;
            flushers.push(fallback);
        }
        let flusher: Arc<dyn BaseFlusher> = if flushers.len() == 1 {
            flushers.remove(0)
        } else {
            Arc::new(MultiFlusher::new(flushers))
        };
        Ok((flusher, sls, otlp))
    }

    async fn register_all_inputs(
        self: &Arc<Self>,
        state_store: &Arc<StateStore>,
    ) -> Vec<Arc<dyn AgentDetection>> {
        let mut entries = Vec::new();
        self.add_hosted(
            &mut entries,
            HostedInputSpec::new("qoder-work-trace", "qoder-work", "hook-jsonl", 1),
            QoderWorkTraceInput::new(QoderWorkTraceOptions {
                state_store: Arc::clone(state_store),
                log_dir: Some(self.data_dir_join("logs/qoder-work/history")),
                segments_root: None,
                sdk_log_dir: None,
                poll_interval_ms: self.poll("qoder-work-trace"),
            }),
            QoderWorkTraceInput::get_watch_paths(),
            QoderWorkTraceInput::check_availability,
        )
        .await;
        let trace_bits = Arc::clone(&self.bits);
        let trace_agents = Arc::clone(&self.agents);
        let trace_config = self.config.clone();
        let qoder_cn_trace_on: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            listener_on(
                &trace_config,
                &trace_agents,
                &trace_bits.lock().expect("bits"),
                "qoder-cn-trace",
                "qoder-cn-trace",
            )
        });
        self.add_hosted_when(
            &mut entries,
            HostedInputSpec::new("qoder-cn-sqlite", "qoder-cn", "sqlite-polling", 1),
            QoderCnSqliteInput::new(QoderCnSqliteOptions {
                state_store: Arc::clone(state_store),
                db_path: None,
                data_root: None,
                poll_interval_ms: self.poll("qoder-cn-sqlite"),
            }),
            QoderCnSqliteInput::get_watch_paths(),
            QoderCnSqliteInput::check_availability,
            {
                let on = qoder_cn_trace_on.clone();
                let bits = Arc::clone(&self.bits);
                let agents = Arc::clone(&self.agents);
                let config = self.config.clone();
                move || {
                    !on()
                        && listener_on(
                            &config,
                            &agents,
                            &bits.lock().expect("bits"),
                            "qoder-cn-sqlite",
                            "qoder-cn-sqlite",
                        )
                }
            },
        )
        .await;
        self.add_hosted_when(
            &mut entries,
            HostedInputSpec::new("qoder-cn", "qoder-cn", "ide-snapshot-polling", 1),
            QoderCnInput::new(QoderCnOptions {
                state_store: Arc::clone(state_store),
                data_root: None,
                snapshot_store_path: None,
                poll_interval_ms: self.poll("qoder-cn"),
                snapshot_retention_ms: None,
            }),
            QoderCnInput::get_watch_paths(),
            QoderCnInput::check_availability,
            {
                let on = qoder_cn_trace_on.clone();
                let bits = Arc::clone(&self.bits);
                let agents = Arc::clone(&self.agents);
                let config = self.config.clone();
                move || {
                    !on()
                        && listener_on(
                            &config,
                            &agents,
                            &bits.lock().expect("bits"),
                            "qoder-cn",
                            "qoder-cn",
                        )
                }
            },
        )
        .await;
        self.add_hosted(
            &mut entries,
            HostedInputSpec::new("qoder-cn-trace", "qoder-cn", "hook-jsonl", 1),
            QoderCnTraceInput::new(QoderCnTraceOptions {
                state_store: Arc::clone(state_store),
                log_dir: Some(self.data_dir_join("logs/qoder-cn/history")),
                poll_interval_ms: self.poll("qoder-cn-trace"),
            }),
            QoderCnTraceInput::get_watch_paths(),
            QoderCnTraceInput::check_availability,
        )
        .await;
        self.add_hosted(
            &mut entries,
            HostedInputSpec::new(
                "copilot-log",
                "copilot",
                CollectionMethod::SessionFilePolling.as_str(),
                1,
            ),
            CopilotLogInput::new(CopilotLogInputOptions {
                state_store: Arc::clone(state_store),
                data_dir: std::path::PathBuf::from(self.data_dir_join("")),
                session_dir: None,
                otel_dir: None,
                poll_interval_ms: self.poll("copilot-log"),
                native_grace_ms: None,
                history_start_time_ms: None,
            }),
            CopilotLogInput::watch_paths(),
            CopilotLogInput::check_availability,
        )
        .await;
        let wakeup = self.data_dir_join("state/codex/transcript-wakeups");
        let spans = self.data_dir_join("state/codex/transcript-span-contexts");
        ensure_dir(&wakeup).await;
        let wakeup_for_watch = wakeup.clone();
        self.add_hosted(
            &mut entries,
            HostedInputSpec::new("codex-transcript", "codex", CollectionMethod::SessionFilePolling.as_str(), 1),
            CodexTranscriptInput::new(CodexTranscriptInputOptions {
                state_store: Arc::clone(state_store),
                session_dir: None,
                wakeup_dir: Some(wakeup.clone()),
                span_context_dir: Some(spans),
                poll_interval_ms: self.poll("codex-transcript"),
                multimodal: None,
            }),
            CodexTranscriptInput::watch_paths(Some(&wakeup_for_watch), None),
            {
                let wakeup = wakeup.clone();
                move || {
                    let wakeup = wakeup.clone();
                    async move {
                        CodexTranscriptInput::check_availability(Some(&wakeup), None).await
                    }
                }
            },
        )
        .await;
        self.add_hosted(
            &mut entries,
            HostedInputSpec::new(
                "codex-aborted-turn",
                "codex",
                CollectionMethod::SessionFilePolling.as_str(),
                1,
            ),
            CodexAbortedTurnInput::new(CodexAbortedTurnInputOptions {
                state_store: Arc::clone(state_store),
                session_dir: None,
                hook_state_dir: None,
                diagnostic_dir: None,
                hook_gap_grace_ms: None,
                poll_interval_ms: self.poll("codex-aborted-turn"),
            }),
            CodexAbortedTurnInput::watch_paths(),
            CodexAbortedTurnInput::check_availability,
        )
        .await;
        self.add_hosted(
            &mut entries,
            HostedInputSpec::new(
                "wukong",
                "wukong",
                CollectionMethod::CliApiPolling.as_str(),
                3,
            ),
            WukongInput::new(WukongInputOptions {
                state_store: Arc::clone(state_store),
                poll_interval_ms: self.poll("wukong"),
                cli_path: None,
            }),
            WukongInput::get_watch_paths(),
            WukongInput::check_availability,
        )
        .await;
        let hook_events = self.data_dir_join("state/workbuddy/hook-events");
        self.add_hosted(
            &mut entries,
            HostedInputSpec::new(
                "workbuddy",
                "workbuddy",
                CollectionMethod::SessionFilePolling.as_str(),
                1,
            ),
            WorkBuddyInput::new(WorkBuddyInputOptions {
                state_store: Arc::clone(state_store),
                poll_interval_ms: self.poll("workbuddy"),
                work_buddy_root: None,
                hook_event_dir: Some(hook_events),
            }),
            WorkBuddyInput::watch_paths(None),
            || WorkBuddyInput::check_availability(None),
        )
        .await;
        let doubao_log_dir = self
            .config
            .listeners
            .get("doubao-work")
            .and_then(|listener| listener.log_dir.clone());
        let available_log_dir = doubao_log_dir.clone();
        let mut doubao_options = DoubaoWorkInputOptions::new(Arc::clone(state_store));
        doubao_options.log_dir = doubao_log_dir.clone();
        doubao_options.poll_interval_ms = self.poll("doubao-work");
        self.add_hosted(
            &mut entries,
            HostedInputSpec::new(
                "doubao-work",
                "doubao-work",
                CollectionMethod::SessionFilePolling.as_str(),
                1,
            ),
            DoubaoWorkInput::new(doubao_options),
            DoubaoWorkInput::watch_paths(doubao_log_dir.as_deref()),
            move || {
                let log_dir = available_log_dir.clone();
                async move { DoubaoWorkInput::check_availability(log_dir.as_deref()).await }
            },
        )
        .await;
        self.register_remaining(&mut entries, state_store).await;
        entries
    }

    async fn register_remaining(
        &self,
        entries: &mut Vec<Arc<dyn AgentDetection>>,
        state_store: &Arc<StateStore>,
    ) {
        let work_trace_on: Arc<dyn Fn() -> bool + Send + Sync> = {
            let bits = Arc::clone(&self.bits);
            let agents = Arc::clone(&self.agents);
            let config = self.config.clone();
            Arc::new(move || {
                listener_on(
                    &config,
                    &agents,
                    &bits.lock().expect("bits"),
                    "qoder-work-trace",
                    "qoder-work-trace",
                )
            })
        };
        self.add_hosted_when(
            entries,
            HostedInputSpec::new("qoder-work", "qoder-work", "hook-jsonl", 1),
            QoderWorkInput::new(QoderWorkOptions {
                state_store: Arc::clone(state_store),
                log_dir: Some(self.data_dir_join("logs/qoder-work/history")),
                log_prefix: None,
                poll_interval_ms: self.poll("qoder-work"),
                agent_type: None,
            }),
            QoderWorkInput::get_watch_paths(),
            QoderWorkInput::check_availability,
            {
                let on = work_trace_on.clone();
                let bits = Arc::clone(&self.bits);
                let agents = Arc::clone(&self.agents);
                let config = self.config.clone();
                move || {
                    !on()
                        && listener_on(
                            &config,
                            &agents,
                            &bits.lock().expect("bits"),
                            "qoder-work",
                            "qoder-work",
                        )
                }
            },
        )
        .await;
        self.add_hosted_when(
            entries,
            HostedInputSpec::new("qoder-work-log", "qoder-work", "session-file-polling", 1),
            QoderWorkLogInput::new(QoderWorkLogOptions {
                state_store: Arc::clone(state_store),
                data_root: None,
                agent_type: None,
                poll_interval_ms: self.poll("qoder-work-log"),
            }),
            QoderWorkLogInput::get_watch_paths(),
            QoderWorkLogInput::check_availability,
            {
                let on = work_trace_on.clone();
                let bits = Arc::clone(&self.bits);
                let agents = Arc::clone(&self.agents);
                let config = self.config.clone();
                move || {
                    !on()
                        && listener_on(
                            &config,
                            &agents,
                            &bits.lock().expect("bits"),
                            "qoder-work-log",
                            "qoder-work-log",
                        )
                }
            },
        )
        .await;
        self.add_hosted_when(
            entries,
            HostedInputSpec::new("qoder-work-sqlite", "qoder-work", "sqlite-polling", 1),
            QoderWorkSqliteInput::new(QoderWorkSqliteOptions {
                state_store: Arc::clone(state_store),
                db_path: None,
                data_root: None,
                agent_type: None,
                poll_interval_ms: self.poll("qoder-work-sqlite"),
            }),
            QoderWorkSqliteInput::get_watch_paths(),
            QoderWorkSqliteInput::check_availability,
            {
                let on = work_trace_on;
                let bits = Arc::clone(&self.bits);
                let agents = Arc::clone(&self.agents);
                let config = self.config.clone();
                move || {
                    !on()
                        && listener_on(
                            &config,
                            &agents,
                            &bits.lock().expect("bits"),
                            "qoder-work-sqlite",
                            "qoder-work-sqlite",
                        )
                }
            },
        )
        .await;
        let cn_root = resolve_qoder_work_root("cn");
        let cn_trace_on: Arc<dyn Fn() -> bool + Send + Sync> = {
            let bits = Arc::clone(&self.bits);
            let agents = Arc::clone(&self.agents);
            let config = self.config.clone();
            Arc::new(move || {
                listener_on(
                    &config,
                    &agents,
                    &bits.lock().expect("bits"),
                    "qoder-work-cn-trace",
                    "qoder-work-cn-trace",
                )
            })
        };
        let logs = Path::new(&cn_root)
            .join("logs")
            .to_string_lossy()
            .into_owned();
        self.add_hosted(
            entries,
            HostedInputSpec::new(
                "qoder-work-cn-trace",
                "qoder-work-cn",
                "session-file-polling",
                1,
            ),
            QoderWorkLogTraceInput::new(QoderWorkLogTraceOptions {
                state_store: Arc::clone(state_store),
                data_root: Some(cn_root.clone()),
                agent_type: Some(ClientType::QoderWorkCN),
                poll_interval_ms: self.poll("qoder-work-cn-trace"),
            }),
            vec![logs.clone()],
            move || {
                let logs = logs.clone();
                async move { directory_exists(&logs).await }
            },
        )
        .await;
        let detection = resolve_home("~/.qoderworkcn");
        self.add_hosted_when(
            entries,
            HostedInputSpec::new("qoder-work-cn-hook", "qoder-work-cn", "hook-jsonl", 1),
            QoderWorkInput::new(QoderWorkOptions {
                state_store: Arc::clone(state_store),
                log_dir: Some(self.data_dir_join("logs/qoder-work-cn/history")),
                log_prefix: None,
                poll_interval_ms: self.poll("qoder-work-cn-hook"),
                agent_type: Some(ClientType::QoderWorkCN),
            }),
            vec![detection.clone()],
            {
                let detection = detection.clone();
                move || {
                    let detection = detection.clone();
                    async move { directory_exists(&detection).await }
                }
            },
            {
                let on = cn_trace_on.clone();
                let bits = Arc::clone(&self.bits);
                let agents = Arc::clone(&self.agents);
                let config = self.config.clone();
                move || {
                    !on()
                        && listener_on(
                            &config,
                            &agents,
                            &bits.lock().expect("bits"),
                            "qoder-work-cn-hook",
                            "qoder-work-cn-hook",
                        )
                }
            },
        )
        .await;
        self.add_hosted_when(
            entries,
            HostedInputSpec::new(
                "qoder-work-cn-log",
                "qoder-work-cn",
                "session-file-polling",
                1,
            ),
            QoderWorkLogInput::new(QoderWorkLogOptions {
                state_store: Arc::clone(state_store),
                data_root: Some(cn_root.clone()),
                agent_type: Some(ClientType::QoderWorkCN),
                poll_interval_ms: self.poll("qoder-work-cn-log"),
            }),
            vec![Path::new(&cn_root)
                .join("logs")
                .to_string_lossy()
                .into_owned()],
            {
                let root = cn_root.clone();
                move || {
                    let path = Path::new(&root).join("logs").to_string_lossy().into_owned();
                    async move { directory_exists(&path).await }
                }
            },
            {
                let on = cn_trace_on.clone();
                let bits = Arc::clone(&self.bits);
                let agents = Arc::clone(&self.agents);
                let config = self.config.clone();
                move || {
                    !on()
                        && listener_on(
                            &config,
                            &agents,
                            &bits.lock().expect("bits"),
                            "qoder-work-cn-log",
                            "qoder-work-cn-log",
                        )
                }
            },
        )
        .await;
        let data = Path::new(&cn_root)
            .join("data")
            .to_string_lossy()
            .into_owned();
        self.add_hosted_when(
            entries,
            HostedInputSpec::new("qoder-work-cn-sqlite", "qoder-work-cn", "sqlite-polling", 1),
            QoderWorkSqliteInput::new(QoderWorkSqliteOptions {
                state_store: Arc::clone(state_store),
                db_path: None,
                data_root: Some(cn_root.clone()),
                agent_type: Some(ClientType::QoderWorkCN),
                poll_interval_ms: self.poll("qoder-work-cn-sqlite"),
            }),
            vec![data.clone()],
            {
                let data = data.clone();
                move || {
                    let db = Path::new(&data)
                        .join("agents.db")
                        .to_string_lossy()
                        .into_owned();
                    async move { file_exists(&db).await }
                }
            },
            {
                let on = cn_trace_on;
                let bits = Arc::clone(&self.bits);
                let agents = Arc::clone(&self.agents);
                let config = self.config.clone();
                move || {
                    !on()
                        && listener_on(
                            &config,
                            &agents,
                            &bits.lock().expect("bits"),
                            "qoder-work-cn-sqlite",
                            "qoder-work-cn-sqlite",
                        )
                }
            },
        )
        .await;
        let qwen_log = self.data_dir_join("logs/qwen-work-cn/history");
        let qwen_segments = resolve_home("~/.qwenworkcn/logs/sessions");
        let qwen_on: Arc<dyn Fn() -> bool + Send + Sync> = {
            let bits = Arc::clone(&self.bits);
            let agents = Arc::clone(&self.agents);
            let config = self.config.clone();
            Arc::new(move || {
                listener_on(
                    &config,
                    &agents,
                    &bits.lock().expect("bits"),
                    "qwen-work-cn-trace",
                    "qwen-work-cn-trace",
                )
            })
        };
        self.add_hosted(
            entries,
            HostedInputSpec::new("qwen-work-cn-trace", "qwen-work-cn", "hook-jsonl", 1),
            QwenWorkCnTraceInput::new(QwenWorkCnTraceOptions {
                state_store: Arc::clone(state_store),
                log_dir: Some(qwen_log.clone()),
                segments_root: Some(qwen_segments.clone()),
                poll_interval_ms: self.poll("qwen-work-cn-trace"),
            }),
            QwenWorkCnTraceInput::get_watch_paths(Some(&qwen_log), Some(&qwen_segments)),
            QwenWorkCnTraceInput::check_availability,
        )
        .await;
        self.add_hosted_when(
            entries,
            HostedInputSpec::new("qwen-work-cn-hook", "qwen-work-cn", "hook-jsonl", 1),
            QwenWorkCnInput::new(QwenWorkCnOptions {
                state_store: Arc::clone(state_store),
                log_dir: Some(qwen_log.clone()),
                log_prefix: None,
                poll_interval_ms: self.poll("qwen-work-cn-hook"),
            }),
            vec![qwen_log.clone()],
            QwenWorkCnInput::check_availability,
            {
                let on = qwen_on.clone();
                let bits = Arc::clone(&self.bits);
                let agents = Arc::clone(&self.agents);
                let config = self.config.clone();
                move || {
                    !on()
                        && listener_on(
                            &config,
                            &agents,
                            &bits.lock().expect("bits"),
                            "qwen-work-cn-hook",
                            "qwen-work-cn-hook",
                        )
                }
            },
        )
        .await;
        self.add_hosted_when(
            entries,
            HostedInputSpec::new("qwen-work-cn-sqlite", "qwen-work-cn", "sqlite-polling", 1),
            QwenWorkCnSqliteInput::new(QwenWorkCnSqliteOptions {
                state_store: Arc::clone(state_store),
                db_path: None,
                data_root: None,
                poll_interval_ms: self.poll("qwen-work-cn-sqlite"),
            }),
            QwenWorkCnSqliteInput::get_watch_paths(),
            QwenWorkCnSqliteInput::check_availability,
            {
                let on = qwen_on;
                let bits = Arc::clone(&self.bits);
                let agents = Arc::clone(&self.agents);
                let config = self.config.clone();
                move || {
                    !on()
                        && listener_on(
                            &config,
                            &agents,
                            &bits.lock().expect("bits"),
                            "qwen-work-cn-sqlite",
                            "qwen-work-cn-sqlite",
                        )
                }
            },
        )
        .await;
        let qoder_agent = self.config.agents.get("qoder").cloned().unwrap_or_default();
        let qoder_multimodal = self.inputs_have_multimodal()
            && is_agent_multimodal_enabled(Some("qoder"), &qoder_agent);
        let qoder = QoderTraceInput::new(QoderTraceOptions {
            state_store: Arc::clone(state_store),
            log_dir: Some(self.data_dir_join("logs/qoder/history")),
            poll_interval_ms: self.poll("qoder-trace"),
            multimodal_enabled: qoder_multimodal,
            upload_mode: qoder_agent.multimodal.as_ref().map(|item| item.upload_mode),
            allowed_root_paths: qoder_agent
                .multimodal
                .as_ref()
                .and_then(|item| item.allowed_root_paths.clone())
                .unwrap_or_default(),
        });
        if qoder_multimodal {
            if let Some(processor) = self.inputs.multimodal_processor() {
                qoder.set_multimodal_processor(processor);
            }
        }
        self.add_hosted(
            entries,
            HostedInputSpec::new("qoder-trace", "qoder", "hook-jsonl", 1),
            qoder,
            QoderTraceInput::get_watch_paths(),
            QoderTraceInput::check_availability,
        )
        .await;
        let cursor_dir = self.data_dir_join("logs/cursor/history");
        self.attach_hook(
            entries,
            "cursor-hook",
            "cursor",
            CursorHookInput::new(self.hook_opts_dir(state_store, &cursor_dir, "cursor-hook")),
            vec![cursor_dir.clone()],
            {
                let cursor_dir = cursor_dir.clone();
                move || {
                    let cursor_dir = cursor_dir.clone();
                    async move { directory_exists(&cursor_dir).await }
                }
            },
        )
        .await;
        self.attach_simple_hooks(entries, state_store).await;
    }

    async fn attach_simple_hooks(
        &self,
        entries: &mut Vec<Arc<dyn AgentDetection>>,
        state_store: &Arc<StateStore>,
    ) {
        let claude = self.claude_log_dir();
        self.attach_hook(
            entries,
            "claude-code-log",
            "claude-code",
            ClaudeCodeLogInput::new(self.hook_opts_dir(state_store, &claude, "claude-code-log")),
            vec![claude.clone()],
            {
                let claude = claude.clone();
                move || {
                    let claude = claude.clone();
                    async move { directory_exists(&claude).await }
                }
            },
        )
        .await;
        let grok = self.data_dir_join("logs/grok-build");
        self.attach_hook(
            entries,
            "grok-build-log",
            "grok-build",
            GrokBuildLogInput::new(self.hook_opts_dir(state_store, &grok, "grok-build-log")),
            vec![grok.clone()],
            {
                let grok = grok.clone();
                move || {
                    let grok = grok.clone();
                    async move { directory_exists(&grok).await }
                }
            },
        )
        .await;
        let kiro = self.data_dir_join("logs/kiro-cli");
        ensure_dir(&kiro).await;
        self.attach_hook(
            entries,
            "kiro-cli-log",
            "kiro-cli",
            KiroCliLogInput::new(self.hook_opts_dir(state_store, &kiro, "kiro-cli-log")),
            vec![kiro.clone()],
            {
                let kiro = kiro.clone();
                move || {
                    let kiro = kiro.clone();
                    async move { directory_exists(&kiro).await }
                }
            },
        )
        .await;
        let session = Arc::new(KiroCliSessionInput::new(
            crate::inputs::kiro_cli_session::KiroCliSessionInputOptions {
                state_store: Arc::clone(state_store),
                data_dir: self.data_dir.clone(),
                poll_interval_ms: self.poll("kiro-cli-session"),
                mature_delay_ms: None,
                max_age_ms: None,
                subprocess_timeout_ms: None,
                max_concurrent: None,
            },
        ));
        let live = live_from_parts(
            "kiro-cli-session",
            "kiro-cli",
            "session-file-polling",
            Arc::clone(&session),
            |input| input.running(),
            |input| {
                Box::pin(async move {
                    input.start().await;
                    Ok(())
                })
            },
            |input| {
                Box::pin(async move {
                    input.stop().await;
                })
            },
        );
        self.inputs.register_input(Arc::clone(&live));
        self.push_detection(
            entries,
            live,
            KiroCliSessionInput::watch_paths(Some(&self.data_dir)),
            KiroCliSessionInput::check_availability,
            1,
            None,
        );
        let opencode = self.data_dir_join("logs/opencode");
        ensure_dir(&opencode).await;
        self.attach_hook(
            entries,
            "opencode-log",
            "opencode",
            OpenCodeLogInput::new(self.hook_opts_dir(state_store, &opencode, "opencode-log")),
            vec![opencode.clone()],
            {
                let opencode = opencode.clone();
                move || {
                    let opencode = opencode.clone();
                    async move { directory_exists(&opencode).await }
                }
            },
        )
        .await;
        let pi_dir = self.data_dir_join("logs/pi-coding-agent");
        ensure_pi_coding_agent_log_dir(&pi_dir).await;
        let bits = Arc::clone(&self.bits);
        let agents = Arc::clone(&self.agents);
        let config = self.config.clone();
        let deployment = self.deployment.lock().expect("deploy").clone();
        let pi = PiCodingAgentLogInput::new(
            crate::inputs::pi_coding_agent_log::PiCodingAgentLogInputOptions {
                state_store: Arc::clone(state_store),
                log_dir: Some(pi_dir.clone()),
                log_prefix: None,
                poll_interval_ms: self.poll("pi-coding-agent-log"),
                data_dir: Some(self.data_dir.clone()),
                agent_enabled: Some(Arc::new(move |agent| {
                    listener_on(&config, &agents, &bits.lock().expect("bits"), agent, agent)
                })),
            },
        );
        self.attach_hook(
            entries,
            "pi-coding-agent-log",
            "pi-coding-agent",
            pi,
            vec![pi_dir.clone()],
            {
                let pi_dir = pi_dir.clone();
                move || {
                    let pi_dir = pi_dir.clone();
                    async move { directory_exists(&pi_dir).await }
                }
            },
        )
        .await;
        let _ = deployment;
        let mimo = self.data_dir_join("logs/mimo-code");
        ensure_dir(&mimo).await;
        self.attach_hook(
            entries,
            "mimo-code-log",
            "mimo-code",
            MimoCodeLogInput::new(self.hook_opts_dir(state_store, &mimo, "mimo-code-log")),
            vec![mimo.clone()],
            {
                let mimo = mimo.clone();
                move || {
                    let mimo = mimo.clone();
                    async move { directory_exists(&mimo).await }
                }
            },
        )
        .await;
        let qwen = self.data_dir_join("logs/qwen-code-cli");
        ensure_dir(&qwen).await;
        self.attach_hook(
            entries,
            "qwen-code-cli-log",
            "qwen-code-cli",
            QwenCodeCliLogInput::new(self.hook_opts_dir(state_store, &qwen, "qwen-code-cli-log")),
            vec![qwen.clone()],
            {
                let qwen = qwen.clone();
                move || {
                    let qwen = qwen.clone();
                    async move { directory_exists(&qwen).await }
                }
            },
        )
        .await;
        let openclaw = self.data_dir_join("logs/openclaw");
        ensure_openclaw_plugin_log_dir(&openclaw).await;
        self.attach_hook(
            entries,
            "openclaw-plugin-log",
            "openclaw",
            OpenClawPluginInput::new(crate::inputs::openclaw_plugin::OpenClawPluginInputOptions {
                state_store: Arc::clone(state_store),
                log_dir: Some(openclaw.clone()),
                log_prefix: None,
                poll_interval_ms: self.poll("openclaw-plugin-log"),
                data_dir: Some(self.data_dir.clone()),
            }),
            vec![openclaw.clone()],
            {
                let openclaw = openclaw.clone();
                move || {
                    let openclaw = openclaw.clone();
                    async move { directory_exists(&openclaw).await }
                }
            },
        )
        .await;
        let hermes = self.data_dir_join("logs/hermes-agent");
        ensure_dir(&hermes).await;
        self.attach_hook(
            entries,
            "hermes-agent-log",
            "hermes-agent",
            HermesLogInput::new(SessionInputOptions {
                state_store: Arc::clone(state_store),
                session_dir: Some(hermes.clone()),
                file_pattern: None,
                poll_interval_ms: self.poll("hermes-agent-log"),
            }),
            vec![hermes.clone()],
            {
                let hermes = hermes.clone();
                move || {
                    let hermes = hermes.clone();
                    async move { directory_exists(&hermes).await }
                }
            },
        )
        .await;
        let dsh = self.data_dir_join("logs/dsh");
        ensure_dsh_log_dir(&dsh).await;
        self.attach_hook(
            entries,
            "dsh-log",
            "dsh",
            DshLogInput::new(SessionInputOptions {
                state_store: Arc::clone(state_store),
                session_dir: Some(dsh.clone()),
                file_pattern: None,
                poll_interval_ms: self.poll("dsh-log"),
            }),
            vec![dsh.clone()],
            {
                let dsh = dsh.clone();
                move || {
                    let dsh = dsh.clone();
                    async move { directory_exists(&dsh).await }
                }
            },
        )
        .await;
    }

    fn inputs_have_multimodal(&self) -> bool {
        *self.multimodal_ready.lock().expect("multimodal")
    }

    fn hook_opts_dir(
        &self,
        state_store: &Arc<StateStore>,
        dir: &str,
        listener: &str,
    ) -> HookInputOptions {
        HookInputOptions {
            state_store: Arc::clone(state_store),
            log_dir: Some(dir.to_string()),
            log_prefix: None,
            poll_interval_ms: self.poll(listener),
        }
    }

    fn claude_log_dir(&self) -> String {
        let config_path = Path::new(&std::env::var("HOME").unwrap_or_default())
            .join(".claude")
            .join("otel-config.json");
        if let Ok(raw) = std::fs::read_to_string(&config_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(dir) = value.get("log_dir").and_then(|item| item.as_str()) {
                    return dir.replacen('~', &std::env::var("HOME").unwrap_or_default(), 1);
                }
            }
        }
        self.data_dir_join("logs/claude-code")
    }

    async fn add_hosted<T, A, Av>(
        &self,
        entries: &mut Vec<Arc<dyn AgentDetection>>,
        spec: HostedInputSpec<'_>,
        input: T,
        watch: Vec<String>,
        available: A,
    ) where
        T: HostedSurface + 'static,
        A: Fn() -> Av + Send + Sync + 'static,
        Av: std::future::Future<Output = bool> + Send + 'static,
    {
        let bits = Arc::clone(&self.bits);
        let agents = Arc::clone(&self.agents);
        let config = self.config.clone();
        let listener_owned = spec.listener.to_string();
        let agent_owned = spec.agent.to_string();
        self.add_hosted_when(entries, spec, input, watch, available, move || {
            listener_on(
                &config,
                &agents,
                &bits.lock().expect("bits"),
                &agent_owned,
                &listener_owned,
            )
        })
        .await;
    }

    async fn add_hosted_when<T, A, Av, E>(
        &self,
        entries: &mut Vec<Arc<dyn AgentDetection>>,
        spec: HostedInputSpec<'_>,
        input: T,
        watch: Vec<String>,
        available: A,
        enabled: E,
    ) where
        T: HostedSurface + 'static,
        A: Fn() -> Av + Send + Sync + 'static,
        Av: std::future::Future<Output = bool> + Send + 'static,
        E: Fn() -> bool + Send + Sync + 'static,
    {
        let input = Arc::new(input);
        let live = live_from_parts(
            spec.listener,
            spec.agent,
            spec.method,
            Arc::clone(&input),
            |input| input.collector_running(),
            |input| Box::pin(async move { input.start().await }),
            |input| {
                Box::pin(async move {
                    let _ = input.stop().await;
                })
            },
        );
        let observed = Arc::clone(&input);
        live.set_runtime_probe(move || observed.runtime_info());
        let id = live.id.clone();
        self.inputs.register_input(Arc::clone(&live));
        let manager = Arc::clone(&self.inputs);
        let delta_manager = Arc::clone(&self.inputs);
        let delta_id = id.clone();
        input.bind_collector(
            move |batch| manager.bind_entries(&id, batch.to_vec()),
            move |delta| delta_manager.record_runtime_delta(&delta_id, delta),
        );
        self.push_detection(
            entries,
            live,
            watch,
            available,
            spec.threshold,
            Some(Arc::new(enabled)),
        );
    }

    fn push_detection<A, Av>(
        &self,
        entries: &mut Vec<Arc<dyn AgentDetection>>,
        live: Arc<LiveInput>,
        watch: Vec<String>,
        available: A,
        threshold: u32,
        enabled: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    ) where
        A: Fn() -> Av + Send + Sync + 'static,
        Av: std::future::Future<Output = bool> + Send + 'static,
    {
        let bits = Arc::clone(&self.bits);
        let agents = Arc::clone(&self.agents);
        let config = self.config.clone();
        let listener = live.id.as_str();
        let listener_owned = listener.to_string();
        let agent = listener_agent(listener).to_string();
        let manager = Arc::clone(&self.inputs);
        let id = live.id.clone();
        let stop_manager = Arc::clone(&self.inputs);
        let stop_id = id.clone();
        let poll = self.poll(listener).unwrap_or(300_000);
        entries.push(Arc::new(ClosureDetection {
            id: id.clone(),
            type_name: live.collection_method.clone(),
            watch,
            poll_ms: poll,
            threshold,
            enabled: enabled.unwrap_or_else(|| {
                Arc::new(move || {
                    listener_on(
                        &config,
                        &agents,
                        &bits.lock().expect("bits"),
                        &agent,
                        &listener_owned,
                    )
                })
            }),
            available: Arc::new(move || Box::pin(available())),
            start: Arc::new(move || {
                let manager = Arc::clone(&manager);
                let id = id.clone();
                Box::pin(async move {
                    manager.start_input(&id).await;
                    Ok(())
                })
            }),
            stop: Arc::new(move || {
                let manager = Arc::clone(&stop_manager);
                let id = stop_id.clone();
                Box::pin(async move {
                    manager.stop_input(&id).await;
                    Ok(())
                })
            }),
        }));
    }

    async fn attach_hook<T, A, Av>(
        &self,
        entries: &mut Vec<Arc<dyn AgentDetection>>,
        listener: &str,
        agent: &str,
        input: T,
        watch: Vec<String>,
        available: A,
    ) where
        T: HookSurface + 'static,
        A: Fn() -> Av + Send + Sync + 'static,
        Av: std::future::Future<Output = bool> + Send + 'static,
    {
        let input = Arc::new(input);
        let live = live_from_parts(
            listener,
            agent,
            &input.collection_method_name(),
            Arc::clone(&input),
            |input| input.surface_running(),
            |input| {
                Box::pin(async move {
                    input.surface_start().await;
                    Ok(())
                })
            },
            |input| {
                Box::pin(async move {
                    input.surface_stop().await;
                })
            },
        );
        let observed = Arc::clone(&input);
        live.set_runtime_probe(move || observed.runtime_info());
        let id = live.id.clone();
        self.inputs.register_input(Arc::clone(&live));
        let manager = Arc::clone(&self.inputs);
        input.surface_on_entries(move |batch| manager.bind_entries(&id, batch.to_vec()));
        self.push_detection(entries, live, watch, available, 1, None);
    }

    fn poll(&self, listener: &str) -> Option<u64> {
        self.config
            .listeners
            .get(listener)
            .map(|listener| listener.poll_interval)
    }

    fn metrics_writer(&self, version: &str, alarm: Arc<AlarmManager>) -> MetricsWriter {
        let _ = alarm;
        let inputs = Arc::clone(&self.inputs);
        let sls = self.sls.lock().expect("sls").clone();
        let otlp = self.otlp.lock().expect("otlp").clone();
        MetricsWriter::new(MetricsWriterOptions {
            data_dir: self.data_dir.clone(),
            version: version.to_string(),
            user_id: self.config.user_id.clone(),
            canary_policy: self
                .config
                .auto_update
                .as_ref()
                .and_then(|update| update.canary_policy)
                .map(|policy| policy.as_str().to_string())
                .unwrap_or_default(),
            get_snapshot: Arc::new(move || Ok(snapshot_from(&inputs, sls.clone(), otlp.clone()))),
            get_trace_runtime_snapshot: None,
            alarm_manager: None,
            agents_config: self.config.agents.clone(),
            sls_endpoints: self
                .config
                .flushers
                .sls
                .as_ref()
                .map(|sls| sls.endpoints.clone())
                .unwrap_or_default(),
            cms_workspace: self.config.cms.workspace.clone(),
            auto_update_enabled: self
                .config
                .auto_update
                .as_ref()
                .is_some_and(|update| update.enabled),
            updater_liveness: None,
            runtime_probe: None,
            now_ms: None,
        })
        .tap(|_| {})
    }

    fn read_package_version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_owned()
    }
    fn read_package_git_commit(&self) -> String {
        resolve_pilot_dir(&self.data_dir, &[])
            .ok()
            .and_then(|root| read_version_field(&root, "git_commit"))
            .unwrap_or_default()
    }
    fn data_dir_join(&self, relative: &str) -> String {
        Path::new(&self.data_dir)
            .join(relative)
            .to_string_lossy()
            .into_owned()
    }
}

trait Tap {
    fn tap<F: FnOnce(&Self)>(self, f: F) -> Self
    where
        Self: Sized,
    {
        f(&self);
        self
    }
}
impl<T> Tap for T {}

async fn precondition_for(
    def: &AgentDefinition,
    deployment: &DeploymentManager,
    data_dir: &str,
) -> bool {
    if let Some(plugin) = &def.directory_plugin {
        return directory_exists(&plugin.source_dir).await && detect_agent(&def.detection).await;
    }
    if let Some(patch) = &def.dsh_yaml_patch {
        return file_exists(&resolve_home(&patch.plugin_source)).await
            && deployment.is_agent_detected(def).await;
    }
    if let Some(inject) = &def.plugin_inject {
        let spec = inject.plugin_spec.replace("$PILOT_DATA", data_dir);
        let path = spec.strip_prefix("file://").unwrap_or(&spec);
        if Path::new(path).is_absolute()
            && !file_exists(path).await
            && !directory_exists(path).await
        {
            return false;
        }
    }
    deployment.is_agent_detected(def).await
}

fn listener_agent(listener: &str) -> &str {
    match listener {
        "qoder-trace" => "qoder",
        "qoder-cn-trace" | "qoder-cn-sqlite" | "qoder-cn" => "qoder-cn",
        "qoder-work" | "qoder-work-trace" | "qoder-work-log" | "qoder-work-sqlite" => "qoder-work",
        "qoder-work-cn-trace"
        | "qoder-work-cn-hook"
        | "qoder-work-cn-log"
        | "qoder-work-cn-sqlite" => "qoder-work-cn",
        "qwen-work-cn-trace" | "qwen-work-cn-hook" | "qwen-work-cn-sqlite" => "qwen-work-cn",
        "cursor-hook" => "cursor",
        "claude-code-log" => "claude-code",
        "grok-build-log" => "grok-build",
        "codex-transcript" => "codex",
        "kiro-cli-log" | "kiro-cli-session" => "kiro-cli",
        "opencode-log" => "opencode",
        "pi-coding-agent-log" => "pi-coding-agent",
        "mimo-code-log" => "mimo-code",
        "qwen-code-cli-log" => "qwen-code-cli",
        "hermes-agent-log" => "hermes-agent",
        "openclaw-plugin-log" => "openclaw",
        "dsh-log" => "dsh",
        "wukong" => "wukong",
        "workbuddy" => "workbuddy",
        other => other,
    }
}

fn listener_on(
    config: &AnalyticsConfig,
    agents: &crate::types::AgentsConfig,
    bits: &GateBits,
    agent: &str,
    listener: &str,
) -> bool {
    let _ = agents;
    let mapped = listener_agent(listener);
    let agent = if mapped == listener { agent } else { mapped };
    scope_allows(bits, agent)
        && is_agent_gated_enabled(config, agent)
        && mode_enabled(
            &bits.modes,
            listener,
            config
                .listeners
                .get(listener)
                .map(|item| item.enabled)
                .unwrap_or(true),
        )
}

fn scope_allows(bits: &GateBits, agent: &str) -> bool {
    bits.scope != DeploymentScopeMode::Recorded || bits.recorded.contains(agent)
}

fn mode_enabled(
    modes: &HashMap<String, crate::types::AgentControlMode>,
    listener: &str,
    default_when_auto: bool,
) -> bool {
    match modes
        .get(listener)
        .copied()
        .unwrap_or(crate::types::AgentControlMode::Auto)
    {
        crate::types::AgentControlMode::On => true,
        crate::types::AgentControlMode::Off => false,
        crate::types::AgentControlMode::Auto => default_when_auto,
    }
}

fn span_map(
    attributes: Option<&HashMap<String, String>>,
) -> serde_json::Map<String, serde_json::Value> {
    attributes
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|(key, value)| (key, serde_json::Value::String(value)))
        .collect()
}

fn read_version_field(pilot_dir: &str, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(Path::new(pilot_dir).join("VERSION")).ok()?;
    let prefix = format!("{key}=");
    text.lines().find_map(|line| {
        line.strip_prefix(&prefix)
            .map(|value| value.trim().to_string())
    })
}

fn snapshot_from(
    inputs: &InputManager,
    sls: Option<Arc<SlsFlusher>>,
    otlp: Option<Arc<OtlpTraceFlusher>>,
) -> DataflowSnapshot {
    let counters = inputs.take_input_counter_snapshot();
    let active: HashSet<String> = inputs.get_active_input_ids().into_iter().collect();
    let mut snapshot = DataflowSnapshot::default();
    for counter in counters.values() {
        snapshot.in_events_total += counter.in_events as i64;
        snapshot.in_bytes_total += counter.in_bytes as i64;
    }
    if let Some(sls) = sls {
        for (name, counter) in sls.endpoint_counters() {
            snapshot.flushers.insert(
                format!("sls:{name}"),
                FlusherEndpointStats {
                    kind: "sls".into(),
                    project: counter.project,
                    logstore: counter.logstore,
                    mode: counter.mode,
                    bytes_basis: "measured".into(),
                    in_entries: counter.in_entries as i64,
                    in_bytes: counter.in_bytes as i64,
                    out_entries: counter.out_entries as i64,
                    out_bytes: counter.out_bytes as i64,
                    out_failed: counter.out_failed as i64,
                    total_delay_ms: counter.total_delay_ms as i64,
                    last_flush_time: counter.last_flush_time,
                    start_time: counter.start_time,
                },
            );
        }
    }
    if let Some(otlp) = otlp {
        for (name, counter) in otlp.endpoint_counters() {
            let kind = if counter.is_cms { "cms" } else { "otlp" };
            snapshot.flushers.insert(
                format!("{kind}:{name}"),
                FlusherEndpointStats {
                    kind: kind.into(),
                    project: counter.project,
                    logstore: counter.logstore,
                    mode: String::new(),
                    bytes_basis: "estimated".into(),
                    in_entries: counter.in_spans as i64,
                    in_bytes: counter.in_bytes as i64,
                    out_entries: counter.out_spans as i64,
                    out_bytes: counter.out_bytes as i64,
                    out_failed: counter.out_failed as i64,
                    total_delay_ms: counter.total_delay_ms as i64,
                    last_flush_time: counter.last_flush_time,
                    start_time: counter.start_time,
                },
            );
        }
    }
    for (id, counter) in counters {
        let agent = listener_agent(&id);
        let agent = if agent == id {
            counter.agent_type.clone()
        } else {
            agent.to_string()
        };
        snapshot
            .input_idle_minutes
            .insert(id.clone(), inputs.get_input_idle_minutes(&id));
        snapshot.inputs.insert(
            id.clone(),
            counter_to_snapshot(&counter, &agent, active.contains(&id)),
        );
    }
    snapshot
}

fn counter_to_snapshot(counter: &InputCounter, agent: &str, running: bool) -> InputSnapshot {
    InputSnapshot {
        source_kind: counter.source_kind.to_string(),
        raw_read_calls: counter.raw_read_calls as i64,
        raw_read_bytes: counter.raw_read_bytes as i64,
        raw_in_records: counter.raw_in_records as i64,
        raw_in_bytes: counter.raw_in_bytes as i64,
        raw_in_max_batch_bytes: counter.raw_in_max_batch_bytes as i64,
        raw_in_max_record_bytes: counter.raw_in_max_record_bytes as i64,
        raw_backlog_bytes_max: counter.raw_backlog_bytes_max as i64,
        parse_success_records: counter.parse_success_records as i64,
        parse_failed_records: counter.parse_failed_records as i64,
        read_duration_ms: counter.read_duration_ms,
        process_duration_ms: counter.process_duration_ms,
        in_events: counter.in_events as i64,
        in_bytes: counter.in_bytes as i64,
        out_failed: counter.out_failed as i64,
        last_poll_time: counter.last_poll_time.clone(),
        start_time: counter.start_time.clone(),
        collection_method: counter.collection_method.clone(),
        agent: agent.to_string(),
        running,
    }
}

trait HostedSurface: Send + Sync {
    fn runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo;
    fn collector_running(&self) -> bool;
    fn start(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>;
    fn stop(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>;
    fn bind_collector(
        &self,
        on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&InputRuntimeDelta) + Send + Sync + 'static,
    );
}

macro_rules! hosted_surface {
    ($ty:ty) => {
        impl HostedSurface for $ty {
            fn runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo { self.collector_runtime_info() }
            fn collector_running(&self) -> bool { self.collector_running() }
            fn start(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> { Box::pin(self.start()) }
            fn stop(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> { Box::pin(self.stop()) }
            fn bind_collector(&self, on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static, on_delta: impl Fn(&InputRuntimeDelta) + Send + Sync + 'static) { self.bind_collector(on_entries, on_delta); }
        }
    };
}

hosted_surface!(QoderWorkTraceInput);
hosted_surface!(QoderCnSqliteInput);
hosted_surface!(QoderCnInput);
hosted_surface!(QoderCnTraceInput);
hosted_surface!(QoderWorkInput);
hosted_surface!(QoderWorkLogInput);
hosted_surface!(QoderWorkSqliteInput);
hosted_surface!(QoderWorkLogTraceInput);
hosted_surface!(QwenWorkCnTraceInput);
hosted_surface!(QwenWorkCnInput);
hosted_surface!(QwenWorkCnSqliteInput);
hosted_surface!(QoderTraceInput);
hosted_surface!(CodexTranscriptInput);
hosted_surface!(CopilotLogInput);
hosted_surface!(CodexAbortedTurnInput);
hosted_surface!(WukongInput);
hosted_surface!(WorkBuddyInput);
hosted_surface!(DoubaoWorkInput);

trait HookSurface: Send + Sync {
    fn runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo;
    fn collection_method_name(&self) -> String;
    fn surface_running(&self) -> bool;
    fn surface_start(&self)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>;
    fn surface_stop(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>;
    fn surface_on_entries(&self, listener: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static);
}

macro_rules! hook_surface {
    ($ty:ty) => {
        hook_surface!($ty, |input: &$ty| std::ops::Deref::deref(input)
            .runtime_info());
    };
    ($ty:ty, $runtime:expr) => {
        impl HookSurface for $ty {
            fn runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
                ($runtime)(self)
            }
            fn collection_method_name(&self) -> String {
                self.collection_method().as_str().to_string()
            }
            fn surface_running(&self) -> bool {
                self.running()
            }
            fn surface_start(
                &self,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
                Box::pin(self.start())
            }
            fn surface_stop(
                &self,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
                Box::pin(self.stop())
            }
            fn surface_on_entries(
                &self,
                listener: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
            ) {
                self.on_entries(listener);
            }
        }
    };
}

hook_surface!(CursorHookInput);
hook_surface!(ClaudeCodeLogInput);
hook_surface!(GrokBuildLogInput);
hook_surface!(KiroCliLogInput);
hook_surface!(OpenCodeLogInput);
hook_surface!(PiCodingAgentLogInput);
hook_surface!(MimoCodeLogInput);
hook_surface!(QwenCodeCliLogInput);
hook_surface!(OpenClawPluginInput);
hook_surface!(HermesLogInput);
hook_surface!(DshLogInput, DshLogInput::runtime_info);

fn live_from_parts<T: Send + Sync + 'static>(
    id: &str,
    agent: &str,
    method: &str,
    input: Arc<T>,
    running: impl Fn(&T) -> bool + Send + Sync + 'static,
    start: impl Fn(
            Arc<T>,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync
        + 'static,
    stop: impl Fn(Arc<T>) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync
        + 'static,
) -> Arc<LiveInput> {
    let running_input = Arc::clone(&input);
    let start_input = Arc::clone(&input);
    let stop_input = Arc::clone(&input);
    LiveInput::new(
        id,
        agent,
        method,
        move || running(&running_input),
        move || start(Arc::clone(&start_input)),
        move || stop(Arc::clone(&stop_input)),
    )
}

struct HostedInputSpec<'a> {
    listener: &'a str,
    agent: &'a str,
    method: &'a str,
    threshold: u32,
}

impl<'a> HostedInputSpec<'a> {
    fn new(listener: &'a str, agent: &'a str, method: &'a str, threshold: u32) -> Self {
        Self {
            listener,
            agent,
            method,
            threshold,
        }
    }
}

type DetectionAction = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send>>
        + Send
        + Sync,
>;

struct ClosureDetection {
    id: String,
    type_name: String,
    watch: Vec<String>,
    poll_ms: u64,
    threshold: u32,
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    available: Arc<
        dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>> + Send + Sync,
    >,
    start: DetectionAction,
    stop: DetectionAction,
}

#[async_trait]
impl AgentDetection for ClosureDetection {
    fn id(&self) -> &str {
        &self.id
    }
    fn type_name(&self) -> &str {
        &self.type_name
    }
    async fn is_available(&self) -> bool {
        (self.available)().await
    }
    fn watch_paths(&self) -> &[String] {
        &self.watch
    }
    fn enabled(&self) -> bool {
        (self.enabled)()
    }
    async fn start(&self) -> anyhow::Result<()> {
        (self.start)().await
    }
    async fn stop(&self) -> anyhow::Result<()> {
        (self.stop)().await
    }
    fn poll_interval_ms(&self) -> u64 {
        self.poll_ms
    }
    fn unavailable_threshold(&self) -> u32 {
        self.threshold
    }
}

struct AlarmBridge(Arc<AlarmManager>);

impl crate::flushers::AlarmSink for AlarmBridge {
    fn record(&self, kind: &str, level: &str, message: &str, endpoint_name: &str) {
        self.0.record(
            kind,
            level,
            message,
            Some(AlarmContext {
                input_name: None,
                endpoint_name: if endpoint_name.is_empty() {
                    None
                } else {
                    Some(endpoint_name.to_string())
                },
            }),
        );
    }
}

#[cfg(test)]
#[path = "orchestrator_watchdog_tests.rs"]
mod watchdog_contract_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn isolated_orchestrator(data: &Path) -> Arc<Orchestrator> {
        let env = HashMap::new();
        let file = serde_json::json!({"dataDir": data, "dashboard": {"enabled": false},
            "autoUpdate": {"enabled": false}, "jsonl": {"enabled": false}});
        let config = super::super::config_loader::assemble_config(
            Some(&file),
            None,
            &super::super::config_loader::ConfigSources {
                env: &env,
                platform: crate::utils::Platform::current(),
                hostname: "isolated",
                config_path: "isolated.json",
                global_poll_ms: None,
            },
        )
        .unwrap();
        Arc::new(Orchestrator::new(config))
    }

    fn write_report_fixture(data: &Path) {
        std::fs::write(
            data.join("last-hook-install.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema": 1, "identity": "isolated-report", "ts": "2026-01-01T00:00:00Z",
                "scope": "detected", "agents": [], "alarmSent": true,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn invalid_or_pending_report_blocks_start_before_background_components() {
        for pending in [false, true] {
            let root = tempfile::tempdir().unwrap();
            write_report_fixture(root.path());
            if pending {
                std::fs::create_dir(root.path().join(".hook-report")).unwrap();
                std::fs::write(
                    root.path().join(".hook-report/update-recovery.json"),
                    "pending",
                )
                .unwrap();
            } else {
                std::fs::write(root.path().join("last-hook-install.json"), "broken").unwrap();
            }
            let orchestrator = isolated_orchestrator(root.path());
            assert!(orchestrator.start().await.is_err());
            assert!(!*orchestrator.running.lock().unwrap());
            assert!(orchestrator.flusher.lock().unwrap().is_none());
            assert!(orchestrator.state_store.lock().unwrap().is_none());
            assert!(orchestrator.deployment.lock().unwrap().is_none());
            assert!(orchestrator.correlate_retention.lock().unwrap().is_none());
            assert!(orchestrator.signal_task.lock().unwrap().is_none());
            assert!(!root.path().join("logs").exists());
            assert!(!root.path().join("deployed-agents.json").exists());
        }
    }

    #[tokio::test]
    async fn signal_refresh_compares_content_and_retries_failed_report_without_new_signal() {
        let root = tempfile::tempdir().unwrap();
        write_report_fixture(root.path());
        let signal = root.path().join("hook-install.signal");
        let fixed_time = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let write_signal = |token: &str| {
            std::fs::write(&signal, token).unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(&signal)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(fixed_time))
                .unwrap();
        };
        write_signal("first");
        let orchestrator = isolated_orchestrator(root.path());
        orchestrator
            .poll_hook_install_signal(signal.to_str().unwrap())
            .await;
        let first = orchestrator.signal_stamp.lock().unwrap().clone().unwrap();
        assert_eq!(first.1, b"first");
        orchestrator.bits.lock().unwrap().scope = DeploymentScopeMode::Recorded;
        orchestrator
            .poll_hook_install_signal(signal.to_str().unwrap())
            .await;
        assert_eq!(
            orchestrator.bits.lock().unwrap().scope,
            DeploymentScopeMode::Recorded
        );
        write_signal("other");
        orchestrator
            .poll_hook_install_signal(signal.to_str().unwrap())
            .await;
        assert_eq!(
            orchestrator.bits.lock().unwrap().scope,
            DeploymentScopeMode::Auto
        );
        let second = orchestrator.signal_stamp.lock().unwrap().clone().unwrap();
        assert_eq!(first.0, second.0);
        assert_ne!(first.1, second.1);
        orchestrator.bits.lock().unwrap().scope = DeploymentScopeMode::Recorded;
        std::fs::write(root.path().join("last-hook-install.json"), "broken").unwrap();
        write_signal("retry");
        orchestrator
            .poll_hook_install_signal(signal.to_str().unwrap())
            .await;
        assert_eq!(
            orchestrator.bits.lock().unwrap().scope,
            DeploymentScopeMode::Recorded
        );
        assert_eq!(
            *orchestrator.signal_stamp.lock().unwrap(),
            Some(second.clone())
        );
        write_report_fixture(root.path());
        orchestrator
            .poll_hook_install_signal(signal.to_str().unwrap())
            .await;
        assert_eq!(
            orchestrator.bits.lock().unwrap().scope,
            DeploymentScopeMode::Auto
        );
        assert_eq!(
            orchestrator
                .signal_stamp
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .1,
            b"retry"
        );
    }

    #[tokio::test]
    async fn control_loading_publishes_modes_and_does_not_hold_a_sync_guard() {
        fn assert_send<T: Send>(_: T) {}
        let root = tempfile::tempdir().unwrap();
        let orchestrator = isolated_orchestrator(root.path());
        assert_send(orchestrator.load_agent_control());
        let path = root.path().join("agent-control.json");
        std::fs::write(
            &path,
            r#"{"version":3,"tools":{"codex":"off","cursor":"on"}}"#,
        )
        .unwrap();
        orchestrator.load_agent_control().await;
        {
            let control = orchestrator.control.try_lock().unwrap();
            let bits = orchestrator.bits.try_lock().unwrap();
            assert_eq!(control.get_all_modes(), bits.modes);
            assert_eq!(
                control.get_mode("codex"),
                crate::types::AgentControlMode::Off
            );
            assert_eq!(
                control.get_mode("cursor"),
                crate::types::AgentControlMode::On
            );
            assert_eq!(Path::new(control.file_path()), path);
        }
        // 损坏文件保持既有启动语义：采用新管理器的默认配置，不继承旧门禁。
        std::fs::write(&path, "broken").unwrap();
        orchestrator.load_agent_control().await;
        assert!(orchestrator
            .control
            .try_lock()
            .unwrap()
            .get_all_modes()
            .is_empty());
        assert!(orchestrator.bits.try_lock().unwrap().modes.is_empty());
    }

    struct ShutdownLockProbe {
        owner: std::sync::Weak<Orchestrator>,
        calls: std::sync::atomic::AtomicUsize,
        fail: bool,
    }

    #[async_trait]
    impl BaseFlusher for ShutdownLockProbe {
        fn name(&self) -> &str {
            "shutdown-lock-probe"
        }

        async fn send(
            &self,
            _: AgentActivityEntry,
            _: Option<f64>,
        ) -> Result<(), crate::flushers::FlushError> {
            panic!("停止测试不应发送事件")
        }

        async fn send_batch(
            &self,
            _: Vec<AgentActivityEntry>,
            _: Option<Vec<f64>>,
        ) -> Result<(), crate::flushers::FlushError> {
            panic!("停止测试不应发送批次")
        }

        async fn flush(&self) -> Result<(), crate::flushers::FlushError> {
            panic!("停止流程应调用 shutdown")
        }

        async fn shutdown(&self) -> Result<(), crate::flushers::FlushError> {
            let owner = self.owner.upgrade().unwrap();
            for _ in 0..2 {
                assert!(
                    owner.flusher.try_lock().is_ok(),
                    "等待 shutdown 时不得持 flusher 锁"
                );
                assert!(owner.state_store.try_lock().is_ok());
                assert!(*owner.running.try_lock().unwrap());
                assert!(!Path::new(&owner.data_dir_join("state.json")).exists());
                tokio::task::yield_now().await;
            }
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail {
                Err(crate::flushers::FlushError::new("合成停止失败"))
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn shutdown_releases_component_lock_and_still_saves_after_flusher_failure() {
        for fail in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let orchestrator = isolated_orchestrator(root.path());
            let probe = Arc::new(ShutdownLockProbe {
                owner: Arc::downgrade(&orchestrator),
                calls: std::sync::atomic::AtomicUsize::new(0),
                fail,
            });
            let state_path = root.path().join("state.json");
            let store = Arc::new(StateStore::new(&state_path));
            store.set_offset("shutdown-fixture", 42.0);
            *orchestrator.state_store.lock().unwrap() = Some(store);
            *orchestrator.flusher.lock().unwrap() = Some(probe.clone());
            orchestrator.stop().await;
            assert_eq!(probe.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
            assert!(!state_path.exists());
            *orchestrator.running.lock().unwrap() = true;
            tokio::time::timeout(Duration::from_secs(5), orchestrator.stop())
                .await
                .unwrap();
            assert_eq!(probe.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert!(!*orchestrator.running.lock().unwrap());
            assert!(state_path.is_file());
            let state: serde_json::Value =
                serde_json::from_slice(&std::fs::read(state_path).unwrap()).unwrap();
            assert_eq!(state["shutdown-fixture"]["lastOffset"], 42.0);
            orchestrator.stop().await;
            assert_eq!(probe.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn listener_map_rolls_trace_listeners_up_to_the_agent_gate() {
        assert_eq!(listener_agent("qoder-trace"), "qoder");
        assert_eq!(listener_agent("qoder-cn-sqlite"), "qoder-cn");
        assert_eq!(listener_agent("codex-transcript"), "codex");
        assert_eq!(listener_agent("custom-agent"), "custom-agent");
    }

    #[test]
    fn recorded_scope_blocks_agents_outside_the_allow_list() {
        let bits = GateBits {
            scope: DeploymentScopeMode::Recorded,
            recorded: HashSet::from(["codex".into()]),
            modes: HashMap::new(),
        };
        assert!(scope_allows(&bits, "codex"));
        assert!(!scope_allows(&bits, "cursor"));
    }

    fn local_output_orchestrator(data: &Path) -> Arc<Orchestrator> {
        let mut config = isolated_orchestrator(data).config.clone();
        config.flushers = crate::types::FlusherConfig::default();
        config.collect_log = false;
        config.collect_trace = false;
        config.otlp_trace = None;
        config.inner_trace = None;
        Arc::new(Orchestrator::new(config))
    }

    async fn install_local_output(orchestrator: &Orchestrator) -> Arc<dyn BaseFlusher> {
        let attributes = Arc::new(Mutex::new(GlobalAttributesProvider::new(
            &serde_json::Map::new(),
            orchestrator.data_dir_join("span-attributes.json"),
        )));
        let (flusher, sls, otlp) = orchestrator.build_flusher(attributes).await.unwrap();
        assert!(sls.is_none());
        assert!(otlp.is_none());
        orchestrator.inputs.set_flusher(flusher.clone());
        *orchestrator.flusher.lock().unwrap() = Some(flusher.clone());
        flusher
    }

    fn fixture_entry(id: &str, user: &str) -> AgentActivityEntry {
        AgentActivityEntry {
            event_id: id.into(),
            agent_type: "orchestrator-fixture".into(),
            user_id: user.into(),
            session_id: "isolated-fixture-session".into(),
            ..Default::default()
        }
    }

    fn output_rows(data: &Path) -> Vec<serde_json::Value> {
        let mut rows: Vec<serde_json::Value> = Vec::new();
        for path in std::fs::read_dir(data.join("logs/output")).unwrap() {
            let path = path.unwrap().path();
            assert!(path.starts_with(data));
            if path.extension().is_some_and(|ext| ext == "jsonl") {
                for line in std::fs::read_to_string(path).unwrap().lines() {
                    rows.push(serde_json::from_str(line).unwrap());
                }
            }
        }
        rows.sort_by_key(|row| row["event.id"].as_str().unwrap().to_string());
        rows
    }

    #[tokio::test]
    async fn disabled_destinations_write_real_jsonl_fallback_in_configured_data_dir() {
        let root = tempfile::tempdir().unwrap();
        let orchestrator = local_output_orchestrator(root.path());
        let output = install_local_output(&orchestrator).await;
        assert_eq!(output.name(), "jsonl");
        output
            .send(fixture_entry("fallback", ""), None)
            .await
            .unwrap();
        output.shutdown().await.unwrap();
        let rows = output_rows(root.path());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["event.id"], "fallback");
        assert_eq!(rows[0]["gen_ai.agent.type"], "orchestrator-fixture");
    }

    #[tokio::test]
    async fn fallback_user_identity_updates_real_manager_output_without_overriding_configured_identity(
    ) {
        let root = tempfile::tempdir().unwrap();
        let orchestrator = local_output_orchestrator(root.path());
        let output = install_local_output(&orchestrator).await;
        // A deliberately inert fixture source; acceptance still traverses the real
        // registered manager queue, identity normalization, projection and writer.
        orchestrator.inputs.register_input(LiveInput::new(
            "identity-fixture",
            "orchestrator-fixture",
            "fixture",
            || false,
            || Box::pin(async { Ok(()) }),
            || Box::pin(async {}),
        ));
        orchestrator.set_user_id("fallback-one");
        orchestrator
            .inputs
            .accept_entries("identity-fixture", vec![fixture_entry("a", "")])
            .await
            .unwrap();
        orchestrator.set_user_id("fallback-two");
        orchestrator
            .inputs
            .accept_entries(
                "identity-fixture",
                vec![fixture_entry("b", ""), fixture_entry("c", "native-user")],
            )
            .await
            .unwrap();
        orchestrator
            .inputs
            .set_configured_user_id("configured-user");
        orchestrator.set_user_id("fallback-three");
        orchestrator
            .inputs
            .accept_entries("identity-fixture", vec![fixture_entry("d", "")])
            .await
            .unwrap();
        output.shutdown().await.unwrap();
        let rows = output_rows(root.path());
        assert_eq!(
            rows.iter()
                .map(|v| v["user.id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "fallback-one",
                "fallback-two",
                "native-user",
                "configured-user"
            ]
        );
    }

    #[tokio::test]
    async fn lifecycle_notifications_report_start_failure_and_running_guards_without_io() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("last-hook-install.json"), "broken").unwrap();
        let orchestrator = isolated_orchestrator(root.path());
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let weak = Arc::downgrade(&orchestrator);
        orchestrator.on_event(move |event| {
            let owner = weak.upgrade().unwrap();
            assert!(owner.listeners.try_lock().is_ok());
            assert!(owner.running.try_lock().is_ok());
            received.lock().unwrap().push(event);
        });
        assert!(orchestrator.start().await.is_err());
        let observed = events.lock().unwrap().clone();
        assert_eq!(observed.len(), 2);
        assert_eq!(observed[0], OrchestratorEvent::Starting);
        assert!(
            matches!(&observed[1], OrchestratorEvent::StartFailed(message) if !message.is_empty())
        );
        assert!(!root.path().join("logs").exists());
        // Already-running start must return before even reading the invalid report.
        *orchestrator.running.lock().unwrap() = true;
        orchestrator.start().await.unwrap();
        assert_eq!(events.lock().unwrap().len(), 2);
        orchestrator.stop().await;
        orchestrator.stop().await;
        assert_eq!(
            events.lock().unwrap().last(),
            Some(&OrchestratorEvent::Stopped)
        );
        assert_eq!(events.lock().unwrap().len(), 3);
    }

    #[test]
    fn discovery_notifications_only_aggregate_unexpected_stop_alarms() {
        let root = tempfile::tempdir().unwrap();
        let orchestrator = isolated_orchestrator(root.path());
        let alarm = Arc::new(AlarmManager::new(
            "127.0.0.1",
            "fixture-version",
            "configured-user",
        ));
        *orchestrator.alarm.lock().unwrap() = Some(alarm.clone());
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        orchestrator.on_event(move |event| received.lock().unwrap().push(event));
        orchestrator.handle_discovery_event(AgentDiscoveryEvent::Started("fixture-source".into()));
        assert!(alarm.serialize().is_empty());
        for reason in [
            AgentStopReason::Unavailable,
            AgentStopReason::Disabled,
            AgentStopReason::Shutdown,
        ] {
            orchestrator.handle_discovery_event(AgentDiscoveryEvent::Stopped(
                "fixture-source".into(),
                reason,
            ));
            assert!(alarm.serialize().is_empty());
        }
        orchestrator.handle_discovery_event(AgentDiscoveryEvent::Stopped(
            "fixture-source".into(),
            AgentStopReason::Unexpected,
        ));
        let alarms = alarm.serialize();
        assert_eq!(alarms.len(), 1);
        assert_eq!(alarms[0].alarm_type, "INPUT_STOP_ALARM");
        assert_eq!(alarms[0].alarm_level, "3");
        assert_eq!(alarms[0].input_name.as_deref(), Some("fixture-source"));
        assert_eq!(
            alarms[0].alarm_message,
            "input fixture-source stopped unexpectedly (reason=unexpected)"
        );
        assert_eq!(alarms[0].user_id, "configured-user");
        assert_eq!(events.lock().unwrap().len(), 5);
    }

    type FixtureLifecycleCheck = Arc<dyn Fn() + Send + Sync>;

    struct FixtureBody {
        start_check: Option<FixtureLifecycleCheck>,
        stop_check: Option<FixtureLifecycleCheck>,
        starts: Arc<std::sync::atomic::AtomicUsize>,
        stops: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait]
    impl crate::inputs::base::InputBody for FixtureBody {
        fn id(&self) -> &str {
            "fixture-listener"
        }
        fn agent_type(&self) -> ClientType {
            ClientType::CodexCliHook
        }
        fn collection_method(&self) -> CollectionMethod {
            CollectionMethod::HookJsonl
        }
        async fn on_start(&self, _: &crate::inputs::base::InputRuntime) -> anyhow::Result<()> {
            self.starts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some(check) = &self.start_check {
                check();
            }

            Ok(())
        }
        async fn collect(
            &self,
            _: &crate::inputs::base::InputRuntime,
        ) -> anyhow::Result<Vec<AgentActivityEntry>> {
            Ok(Vec::new())
        }
        async fn on_stop(&self, _: &crate::inputs::base::InputRuntime) -> anyhow::Result<()> {
            self.stops.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some(check) = &self.stop_check {
                check();
            }

            Ok(())
        }
    }

    struct FixtureSurface {
        inner: Arc<crate::inputs::base::HostedInput<FixtureBody>>,
        wait_for_cancel: Option<Arc<tokio::sync::Notify>>,
    }

    impl HostedSurface for FixtureSurface {
        fn runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
            self.inner.runtime.runtime_info()
        }
        fn collector_running(&self) -> bool {
            self.inner.running()
        }
        fn start(
            &self,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
        {
            Box::pin(async move {
                self.inner.start().await?;
                if let Some(cancelled) = &self.wait_for_cancel {
                    cancelled.notified().await;
                }
                Ok(())
            })
        }
        fn stop(
            &self,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
        {
            Box::pin(self.inner.stop())
        }
        fn bind_collector(
            &self,
            on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
            on_delta: impl Fn(&InputRuntimeDelta) + Send + Sync + 'static,
        ) {
            self.inner.on_entries(on_entries);
            self.inner.on_runtime_delta(on_delta);
        }
    }

    fn fixture_source(store: Arc<StateStore>) -> FixtureSurface {
        FixtureSurface {
            inner: crate::inputs::base::HostedInput::new(
                FixtureBody {
                    start_check: None,
                    stop_check: None,
                    starts: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                    stops: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                },
                "IsolatedOrchestratorFixture",
                store,
                Some(300_000),
            ),
            wait_for_cancel: None,
        }
    }

    #[tokio::test]
    async fn admission_reload_starts_and_stops_real_registered_hosted_input() {
        use std::sync::atomic::Ordering;
        let root = tempfile::tempdir().unwrap();
        let mut config = local_output_orchestrator(root.path()).config.clone();
        config.listeners.insert(
            "fixture-listener".into(),
            crate::types::ListenerConfig {
                log_dir: None,
                enabled: true,
                poll_interval: 1234,
            },
        );
        let orchestrator = Arc::new(Orchestrator::new(config));
        let source = fixture_source(Arc::new(StateStore::new(root.path().join("state.json"))));
        let inner = source.inner.clone();
        let mut entries = Vec::new();
        orchestrator
            .add_hosted(
                &mut entries,
                HostedInputSpec::new("fixture-listener", "orchestrator-fixture", "fixture", 2),
                source,
                Vec::new(),
                || async { true },
            )
            .await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].poll_interval_ms(), 1234);
        assert_eq!(entries[0].unavailable_threshold(), 2);
        let live = orchestrator.inputs.get_input("fixture-listener").unwrap();
        assert_eq!(
            live.runtime_info().unwrap().poll_interval_ms,
            inner.runtime.poll_interval_ms()
        );
        inner.runtime.force_poll_interval_ms(7654);
        assert_eq!(live.runtime_info().unwrap().poll_interval_ms, 7654);

        assert!(orchestrator.inputs.get_input("fixture-listener").is_some());
        let discovery = Arc::new(AgentDiscoveryService::new(entries));
        let weak = Arc::downgrade(&orchestrator);
        discovery.on_event(move |event| weak.upgrade().unwrap().handle_discovery_event(event));
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        orchestrator.on_event(move |event| received.lock().unwrap().push(event));
        discovery.start().await;
        assert!(inner.running());
        assert_eq!(inner.body.starts.load(Ordering::SeqCst), 1);
        for (mode, running, starts, stops) in [("off", false, 1, 1), ("on", true, 2, 1)] {
            std::fs::write(
                root.path().join("agent-control.json"),
                serde_json::to_vec(
                    &serde_json::json!({"version":3,"tools":{"fixture-listener":mode}}),
                )
                .unwrap(),
            )
            .unwrap();
            orchestrator.load_agent_control().await;
            discovery.refresh("fixture-config-update").await;
            assert_eq!(inner.running(), running);
            assert_eq!(inner.body.starts.load(Ordering::SeqCst), starts);
            assert_eq!(inner.body.stops.load(Ordering::SeqCst), stops);
        }
        *orchestrator.discovery.lock().unwrap() = Some(discovery);
        *orchestrator.running.lock().unwrap() = true;
        orchestrator.stop().await;
        assert!(!inner.running());
        assert_eq!(inner.body.stops.load(Ordering::SeqCst), 2);
        let events = events.lock().unwrap();
        assert!(
            events.contains(&OrchestratorEvent::Agent(AgentDiscoveryEvent::Stopped(
                "fixture-listener".into(),
                AgentStopReason::Disabled
            )))
        );
        assert!(
            events.contains(&OrchestratorEvent::Agent(AgentDiscoveryEvent::Stopped(
                "fixture-listener".into(),
                AgentStopReason::Shutdown
            )))
        );
        assert_eq!(events.last(), Some(&OrchestratorEvent::Stopped));
    }

    struct PendingAcceptance {
        entered: tokio::sync::Notify,
        cancelled: Arc<tokio::sync::Notify>,
        dropped: Arc<std::sync::atomic::AtomicBool>,
        stops: Arc<std::sync::atomic::AtomicUsize>,
    }

    struct AcceptanceDrop {
        cancelled: Arc<tokio::sync::Notify>,
        dropped: Arc<std::sync::atomic::AtomicBool>,
    }

    impl Drop for AcceptanceDrop {
        fn drop(&mut self) {
            self.dropped
                .store(true, std::sync::atomic::Ordering::SeqCst);
            self.cancelled.notify_one();
        }
    }

    #[async_trait]
    impl BaseFlusher for PendingAcceptance {
        fn name(&self) -> &str {
            "fixture-pending-acceptance"
        }
        async fn send(
            &self,
            entry: AgentActivityEntry,
            _: Option<f64>,
        ) -> Result<(), crate::flushers::FlushError> {
            self.send_batch(vec![entry], None).await
        }
        async fn send_batch(
            &self,
            entries: Vec<AgentActivityEntry>,
            _: Option<Vec<f64>>,
        ) -> Result<(), crate::flushers::FlushError> {
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].agent_type, "orchestrator-fixture");
            let _drop = AcceptanceDrop {
                cancelled: self.cancelled.clone(),
                dropped: self.dropped.clone(),
            };
            self.entered.notify_one();
            std::future::pending().await
        }
        async fn flush(&self) -> Result<(), crate::flushers::FlushError> {
            Ok(())
        }
        async fn shutdown(&self) -> Result<(), crate::flushers::FlushError> {
            assert!(self.dropped.load(std::sync::atomic::Ordering::SeqCst));
            assert_eq!(self.stops.load(std::sync::atomic::Ordering::SeqCst), 1);
            Ok(())
        }
    }

    #[tokio::test]
    async fn shutdown_cancels_manager_output_before_waiting_for_discovery_startup_gate() {
        let root = tempfile::tempdir().unwrap();
        let orchestrator = local_output_orchestrator(root.path());
        let state_path = root.path().join("state.json");
        let store = Arc::new(StateStore::new(&state_path));
        store.set_offset("fixture-listener", 0.0);
        store.save().await.unwrap();
        let mut source = fixture_source(store.clone());
        let inner = source.inner.clone();
        let cancelled = Arc::new(tokio::sync::Notify::new());
        source.wait_for_cancel = Some(cancelled.clone());
        let output = Arc::new(PendingAcceptance {
            entered: tokio::sync::Notify::new(),
            cancelled,
            dropped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            stops: inner.body.stops.clone(),
        });
        orchestrator.inputs.set_state_store(store.clone());
        orchestrator.inputs.set_flusher(output.clone());
        *orchestrator.flusher.lock().unwrap() = Some(output.clone());
        *orchestrator.state_store.lock().unwrap() = Some(store.clone());
        let mut entries = Vec::new();
        // The cancellation lane is selected by source metadata; the only payload
        // remains the deliberately non-Agent fixture type.
        orchestrator
            .add_hosted_when(
                &mut entries,
                HostedInputSpec::new("fixture-listener", "codex", "fixture", 1),
                source,
                Vec::new(),
                || async { true },
                || true,
            )
            .await;
        let discovery = Arc::new(AgentDiscoveryService::new(entries));
        *orchestrator.discovery.lock().unwrap() = Some(discovery.clone());
        *orchestrator.running.lock().unwrap() = true;
        let startup = tokio::spawn(async move { discovery.start().await });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !inner.running() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        store.set_offset("fixture-listener", 9.0);
        let manager = orchestrator.inputs.clone();
        let pending = tokio::spawn(async move {
            manager
                .accept_entries("fixture-listener", vec![fixture_entry("pending", "")])
                .await
        });
        tokio::time::timeout(Duration::from_secs(3), output.entered.notified())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), orchestrator.stop())
            .await
            .expect("output cancellation must happen before discovery waits for its startup gate");
        startup.await.unwrap();
        assert!(pending.await.unwrap().is_err());
        assert!(store.save_failed());
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(state_path).unwrap()).unwrap();
        assert_eq!(persisted["fixture-listener"]["lastOffset"], 0.0);
        assert!(!inner.running());
    }

    #[tokio::test]
    async fn failed_start_after_state_initialization_cleans_components_and_emits_one_failure() {
        let root = tempfile::tempdir().unwrap();
        let mut config = local_output_orchestrator(root.path()).config.clone();
        config.privacy = Some(crate::types::PrivacyConfig {
            exclude_workspaces: vec!["relative-is-invalid".into()],
        });
        let orchestrator = Arc::new(Orchestrator::new(config));
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        orchestrator.on_event(move |event| received.lock().unwrap().push(event));
        let error = orchestrator.start().await.unwrap_err().to_string();
        assert!(error.contains("absolute"));
        assert!(!*orchestrator.running.lock().unwrap());
        assert!(orchestrator.flusher.lock().unwrap().is_none());
        assert!(orchestrator.discovery.lock().unwrap().is_none());
        assert!(orchestrator.runtime_task.lock().unwrap().is_none());
        assert!(orchestrator.summary_task.lock().unwrap().is_none());
        let store = orchestrator.state_store.lock().unwrap().clone().unwrap();
        assert!(
            !root.path().join("logs/input-state.json").exists(),
            "empty unchanged state must not be spuriously created during failed startup"
        );
        assert!(!store.save_failed());
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [
                OrchestratorEvent::Starting,
                OrchestratorEvent::StartFailed(error)
            ]
        );
        orchestrator.stop().await;
        assert_eq!(events.lock().unwrap().len(), 2);
    }

    // This test launches itself with a fresh environment instead of changing
    // HOME while unrelated tests or already-created async tasks are running.
    #[tokio::test]
    async fn full_start_and_registration_are_isolated_in_temp_home_subprocess() {
        const CHILD: &str = "PILOT_ORCHESTRATOR_FIXTURE_CHILD";
        if let Ok(mode) = std::env::var(CHILD) {
            let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
            let data = home.join("pilot-data");
            assert!(home.starts_with(std::env::temp_dir()));
            let mut config = local_output_orchestrator(&data).config.clone();
            config.pipeline.enabled = false;
            config.retention.enabled = false;
            config.hook_watchdog.enabled = false;
            config.upstream_link.enabled = false;
            config.status_bar.enabled = false;
            config.dashboard.port = 0;
            config.status_bar.runtime_refresh_interval_ms = 300_000;
            config.status_bar.metrics_summary_interval_ms = 300_000;
            if mode == "custom-output" {
                config.flushers.jsonl = Some(JsonlFlusherConfig {
                    enabled: true,
                    output_dir: home
                        .join("configured-output")
                        .to_string_lossy()
                        .into_owned(),
                    rotate_daily: true,
                    max_file_size_mb: 10,
                });
            }
            let mut agents = serde_json::Map::new();
            for agent in [
                "qoder",
                "qoder-cn",
                "qoder-work",
                "qoder-work-cn",
                "qwen-work-cn",
                "cursor",
                "claude-code",
                "grok-build",
                "codex",
                "github-copilot",
                "copilot",
                "kiro-cli",
                "opencode",
                "pi-coding-agent",
                "mimo-code",
                "qwen-code-cli",
                "hermes-agent",
                "openclaw",
                "dsh",
                "wukong",
                "workbuddy",
                "doubao-work",
            ] {
                agents.insert(agent.into(), serde_json::json!({"enabled":false}));
            }
            config.agents = serde_json::from_value(serde_json::Value::Object(agents)).unwrap();
            if mode == "opencode-home" || mode == "opencode-cli-home" {
                config.agents.get_mut("opencode").unwrap().enabled = Some(true);
                assert!(!home.join(".config/opencode/opencode.jsonc").exists());
            }

            let excluded = home.join("excluded-workspace");
            std::fs::create_dir_all(&excluded).unwrap();
            config.privacy = Some(crate::types::PrivacyConfig {
                exclude_workspaces: vec![excluded.to_string_lossy().into_owned()],
            });
            config.mask = crate::types::MaskConfig {
                mode: crate::types::MaskMode::All,
                types: Vec::new(),
                replacement_mode: Some(crate::types::MaskReplacementMode::Placeholder),
            };
            let occupied = if mode == "dashboard-occupied" {
                let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
                config.dashboard.port = listener.local_addr().unwrap().port();
                Some(listener)
            } else {
                None
            };
            for id in [
                "cursor-hook",
                "codex-transcript",
                "qoder-cn-sqlite",
                "doubao-work",
            ] {
                config.listeners.insert(
                    id.into(),
                    crate::types::ListenerConfig {
                        log_dir: None,
                        enabled: false,
                        poll_interval: 30_000,
                    },
                );
            }
            let doubao_fixture = home.join("doubao-fixture").join("log");
            {
                let listener = config.listeners.get_mut("doubao-work").unwrap();
                listener.log_dir = Some(doubao_fixture.to_string_lossy().into_owned());
                listener.poll_interval = 7331;
                assert!(!listener.enabled);
                assert_eq!(config.agents["doubao-work"].enabled, Some(false));
            }
            for (id, interval) in [
                ("opencode-log", 1000),
                ("qoder-cn-trace", 1000),
                ("openclaw-plugin-log", 1234),
            ] {
                config.listeners.insert(
                    id.into(),
                    crate::types::ListenerConfig {
                        log_dir: None,
                        enabled: false,
                        poll_interval: interval,
                    },
                );
            }
            if mode == "ordered-start" {
                config.listeners.insert(
                    "fixture-listener".into(),
                    crate::types::ListenerConfig {
                        log_dir: None,
                        enabled: false,
                        poll_interval: 300_000,
                    },
                );
                std::fs::create_dir_all(data.join("logs")).unwrap();
                let seed = Arc::new(StateStore::new(data.join("logs/input-state.json")));
                seed.set_offset("restored-before-discovery", 73.0);
                seed.save().await.unwrap();
                std::fs::write(
                    data.join("agent-control.json"),
                    r#"{"version":3,"tools":{"fixture-listener":"on"}}"#,
                )
                .unwrap();
            }
            config.user_id = "configured-user".into();
            if mode == "opencode-cli-home" {
                assert!(
                    !crate::deployment::command_exists("pilot-uninstalled-fixture-cli").await,
                    "the fixture locator must reject commands absent from PATH"
                );
            }
            let mut collector = Orchestrator::new(config);
            collector.test_interceptor_port = Some(0);
            let orchestrator = Arc::new(collector);
            let events = Arc::new(Mutex::new(Vec::new()));
            let received = events.clone();
            orchestrator.on_event(move |event| received.lock().unwrap().push(event));
            let start_gate = if mode == "ordered-start" {
                let entered = Arc::new(tokio::sync::Notify::new());
                let release = Arc::new(tokio::sync::Notify::new());
                let mut source = fixture_source(Arc::new(StateStore::new(
                    home.join("fixture-source-state.json"),
                )));
                source.wait_for_cancel = Some(release.clone());
                let owner = Arc::downgrade(&orchestrator);
                let observed = entered.clone();
                Arc::get_mut(&mut source.inner).unwrap().body.start_check =
                    Some(Arc::new(move || {
                        let owner = owner.upgrade().unwrap();
                        assert!(Path::new(&owner.data_dir_join("logs")).is_dir());
                        let store = owner.state_store.lock().unwrap().clone().unwrap();
                        assert_eq!(store.get_offset("restored-before-discovery"), 73.0,
                        "actual StateStore.load must finish before discovery invokes the source");
                        assert_eq!(
                            owner.control.lock().unwrap().get_mode("fixture-listener"),
                            crate::types::AgentControlMode::On
                        );
                        assert_eq!(
                            owner.bits.lock().unwrap().modes.get("fixture-listener"),
                            Some(&crate::types::AgentControlMode::On)
                        );
                        assert!(owner.flusher.lock().unwrap().is_some());
                        assert!(owner.metrics.lock().unwrap().is_none());
                        assert!(!*owner.running.lock().unwrap());
                        observed.notify_one();
                    }));
                let owner = Arc::downgrade(&orchestrator);
                Arc::get_mut(&mut source.inner).unwrap().body.stop_check =
                    Some(Arc::new(move || {
                        let owner = owner.upgrade().unwrap();
                        assert!(
                            owner.metrics.lock().unwrap().is_some(),
                            "discovery/source stop must precede final metrics stop"
                        );
                        let disk: serde_json::Value = serde_json::from_slice(
                            &std::fs::read(owner.data_dir_join("logs/input-state.json")).unwrap(),
                        )
                        .unwrap();
                        assert_eq!(
                            disk["restored-before-discovery"]["lastOffset"], 73.0,
                            "final shared state save must follow discovery/source stop"
                        );
                        assert_eq!(
                            owner
                                .state_store
                                .lock()
                                .unwrap()
                                .as_ref()
                                .unwrap()
                                .get_offset("restored-before-discovery"),
                            99.0
                        );
                    }));
                let mut entries = Vec::new();
                orchestrator
                    .add_hosted(
                        &mut entries,
                        HostedInputSpec::new(
                            "fixture-listener",
                            "orchestrator-fixture",
                            "fixture",
                            1,
                        ),
                        source,
                        Vec::new(),
                        || async { true },
                    )
                    .await;
                *orchestrator.test_detection_entries.lock().unwrap() = entries;
                Some((entered, release))
            } else {
                None
            };
            if let Some((entered, release)) = start_gate {
                let owner = orchestrator.clone();
                let startup = owner.start();
                tokio::pin!(startup);
                tokio::select! {
                    result = &mut startup => panic!("startup completed before release: {result:?}"),
                    result = tokio::time::timeout(Duration::from_secs(3), entered.notified()) => result.unwrap(),
                }
                assert!(!*orchestrator.running.lock().unwrap());
                assert!(orchestrator.metrics.lock().unwrap().is_none());
                assert!(orchestrator.summary_task.lock().unwrap().is_none());
                assert!(!events.lock().unwrap().contains(&OrchestratorEvent::Started));
                release.notify_one();
                tokio::time::timeout(Duration::from_secs(10), startup)
                    .await
                    .unwrap()
                    .unwrap();
            } else {
                tokio::time::timeout(Duration::from_secs(10), orchestrator.start())
                    .await
                    .unwrap()
                    .unwrap();
            }
            assert!(*orchestrator.running.lock().unwrap());
            let initial_events = events.lock().unwrap().clone();
            assert_eq!(initial_events.first(), Some(&OrchestratorEvent::Starting));
            assert_eq!(initial_events.last(), Some(&OrchestratorEvent::Started));
            assert_eq!(
                initial_events
                    .iter()
                    .filter(|event| **event == OrchestratorEvent::Starting)
                    .count(),
                1
            );
            assert_eq!(
                initial_events
                    .iter()
                    .filter(|event| **event == OrchestratorEvent::Started)
                    .count(),
                1
            );
            if mode == "dashboard-occupied" {
                assert!(initial_events.iter().any(|event| matches!(event,
                    OrchestratorEvent::ComponentFailure {component,error}
                    if component == "dashboard" && error.contains("AddrInUse"))));
                assert!(orchestrator
                    .dashboard
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .last_start_error()
                    .is_some());
            } else {
                assert!(!initial_events
                    .iter()
                    .any(|event| matches!(event, OrchestratorEvent::ComponentFailure { .. })));
            }
            if mode == "opencode-home" || mode == "opencode-cli-home" {
                let path = home.join(".config/opencode/opencode.jsonc");
                let document = std::fs::read_to_string(&path).unwrap();
                let document =
                    crate::utils::parse_json_document(&document, crate::utils::JsonSyntax::Jsonc)
                        .unwrap();
                assert_eq!(
                    document["plugin"],
                    serde_json::json!([format!(
                        "file://{}/plugins/opencode",
                        data.to_string_lossy().replace('\\', "/")
                    )])
                );
                assert!(data.join("plugins/opencode/index.js").is_file());
                assert!(data.join("plugins/opencode/plugin.mjs").is_file());
                assert!(data.join("plugins/shared/resource-context.mjs").is_file());
                assert!(data.join("deployed-agents.json").is_file());
                assert!(path.starts_with(&home));
                assert!(!home
                    .join("decoy-home/.config/opencode/opencode.jsonc")
                    .exists());
                #[cfg(unix)]
                if mode == "opencode-cli-home" {
                    let lookup = std::fs::read_to_string(home.join("lookup.log")).unwrap();
                    assert!(lookup
                        .lines()
                        .any(|line| line == "pilot-uninstalled-fixture-cli"));
                    assert!(lookup.lines().any(|line| line == "opencode"));
                }
            }
            let events_after_start = initial_events.len();
            assert!(orchestrator.status_bar.lock().unwrap().is_none());
            assert!(orchestrator.summary_writer.lock().unwrap().is_some());
            assert!(orchestrator.summary_task.lock().unwrap().is_some());
            assert!(orchestrator.metrics.lock().unwrap().is_some());
            let bound = orchestrator
                .dashboard
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .address();
            assert_eq!(bound.is_none(), occupied.is_some());
            if mode == "custom-output" {
                let summary_file = data.join("logs/metrics-summary.json");
                tokio::time::timeout(Duration::from_secs(5), async {
                    while !summary_file.exists() {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                orchestrator.inputs.register_input(LiveInput::new(
                    "summary-fixture",
                    "orchestrator-fixture",
                    "fixture",
                    || false,
                    || Box::pin(async { Ok(()) }),
                    || Box::pin(async {}),
                ));
                let mut response = fixture_entry("configured-summary-response", "");
                response.event_name = Some(crate::types::AgentEventName::LlmResponse);
                response.time_unix_nano = chrono::Utc::now()
                    .timestamp_nanos_opt()
                    .unwrap()
                    .to_string();
                response.input_tokens = Some(120);
                response.output_tokens = Some(30);
                response.total_tokens = Some(150);
                response.response_model = Some("configured-summary-model".into());
                orchestrator
                    .inputs
                    .accept_entries("summary-fixture", vec![response])
                    .await
                    .unwrap();
                let configured = home.join("configured-output");
                let rows = std::fs::read_dir(&configured)
                    .unwrap()
                    .filter_map(Result::ok)
                    .filter(|e| e.path().extension().is_some_and(|ext| ext == "jsonl"))
                    .flat_map(|e| {
                        std::fs::read_to_string(e.path())
                            .unwrap()
                            .lines()
                            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>();
                assert!(rows
                    .iter()
                    .any(|r| r["event.id"] == "configured-summary-response"));
                let summary = orchestrator.summary_writer.lock().unwrap().take().unwrap();
                summary.refresh().await;
                *orchestrator.summary_writer.lock().unwrap() = Some(summary);
                let document: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&summary_file).unwrap()).unwrap();
                assert_eq!(document["ranges"]["today"]["totalTokens"], 150.0,
                    "actual Orchestrator summary must scan configured JSONL output, not default logs/output");
                assert!(orchestrator.status_bar.lock().unwrap().is_none());
                assert!(orchestrator.summary_task.lock().unwrap().is_some());
                assert!(bound.is_some());
                let store = orchestrator.state_store.lock().unwrap().clone().unwrap();
                store.set_offset("configured-summary-stop", 42.0);
                orchestrator.stop().await;
                assert!(!*orchestrator.running.lock().unwrap());
                assert!(orchestrator.dashboard.lock().unwrap().is_none());
                assert!(orchestrator.summary_task.lock().unwrap().is_none());
                assert!(orchestrator.runtime_task.lock().unwrap().is_none());
                assert!(!data.join("logs/runtime.json").exists());
                let saved: serde_json::Value = serde_json::from_slice(
                    &std::fs::read(data.join("logs/input-state.json")).unwrap(),
                )
                .unwrap();
                assert_eq!(saved["configured-summary-stop"]["lastOffset"], 42.0);
                return;
            }
            if mode == "ordered-start" {
                assert_eq!(
                    orchestrator.inputs.get_active_input_ids(),
                    ["fixture-listener"]
                );
            } else {
                assert!(
                    orchestrator.inputs.get_active_input_ids().is_empty(),
                    "disabled real Agents must stay stopped"
                );
            }
            for id in [
                "opencode-log",
                "qoder-cn-trace",
                "codex-transcript",
                "cursor-hook",
                "qwen-work-cn-trace",
                "qwen-work-cn-hook",
                "openclaw-plugin-log",
                "doubao-work",
            ] {
                assert!(
                    orchestrator.inputs.get_input(id).is_some(),
                    "missing real registration: {id}"
                );
            }
            for (id, configured) in [
                ("cursor-hook", 30_000),
                ("codex-transcript", 30_000),
                ("qoder-cn-sqlite", 30_000),
                ("opencode-log", 1000),
                ("qoder-cn-trace", 1000),
                ("openclaw-plugin-log", 1234),
                ("doubao-work", 7331),
            ] {
                let live = orchestrator.inputs.get_input(id).unwrap();
                let actual = live
                    .runtime_info()
                    .unwrap_or_else(|| panic!("missing runtime probe: {id}"));
                let expected = if mode == "poll-env" { 3000 } else { configured };
                assert_eq!(
                    actual.poll_interval_ms, expected,
                    "real constructor interval for {id}"
                );
                if id == "doubao-work" {
                    assert_eq!(
                        actual.source_paths,
                        [doubao_fixture.to_string_lossy().into_owned()]
                    );
                    assert_eq!(live.agent_type, "doubao-work");
                    assert_eq!(
                        live.collection_method,
                        CollectionMethod::SessionFilePolling.as_str()
                    );
                    assert!(
                        !doubao_fixture.exists(),
                        "disabled full-start must not create or read a real Doubao source"
                    );
                }
                if id == "openclaw-plugin-log" {
                    assert_eq!(
                        actual.source_paths,
                        [data.join("logs/openclaw").to_string_lossy().into_owned()]
                    );
                    assert_eq!(live.agent_type, "openclaw");
                }
                if id == "opencode-log" {
                    assert_eq!(
                        actual.source_paths,
                        [data.join("logs/opencode").to_string_lossy().into_owned()]
                    );
                }
            }
            let mut registration_config = orchestrator.config.clone();
            registration_config
                .agents
                .get_mut("doubao-work")
                .unwrap()
                .enabled = Some(true);
            {
                let listener = registration_config
                    .listeners
                    .get_mut("doubao-work")
                    .unwrap();
                listener.enabled = true;
                listener.poll_interval = 7331;
            }
            registration_config
                .agents
                .get_mut("qwen-work-cn")
                .unwrap()
                .enabled = Some(true);
            for (listener, enabled, poll_interval) in [
                ("opencode-log", true, 1000),
                ("qoder-cn-trace", true, 1000),
                ("qwen-work-cn-trace", false, 30_000),
                ("qwen-work-cn-hook", true, 1234),
                ("openclaw-plugin-log", true, 1234),
            ] {
                registration_config.listeners.insert(
                    listener.into(),
                    crate::types::ListenerConfig {
                        log_dir: None,
                        enabled,
                        poll_interval,
                    },
                );
            }
            let registration = Arc::new(Orchestrator::new(registration_config));
            let registration_store =
                Arc::new(StateStore::new(home.join("registration-state.json")));
            let entries = registration.register_all_inputs(&registration_store).await;
            let find = |id: &str| entries.iter().find(|entry| entry.id() == id).unwrap();
            let doubao = find("doubao-work");
            assert_eq!(
                doubao.watch_paths(),
                [doubao_fixture.to_string_lossy().into_owned()]
            );
            assert_eq!(
                doubao.type_name(),
                CollectionMethod::SessionFilePolling.as_str()
            );
            assert_eq!(doubao.poll_interval_ms(), 7331);
            assert!(doubao.enabled());
            assert!(!doubao.is_available().await);
            std::fs::create_dir_all(&doubao_fixture).unwrap();
            std::fs::write(doubao_fixture.join("unrelated.log"), "").unwrap();
            assert!(!doubao.is_available().await);
            std::fs::write(doubao_fixture.join("saman_2026.1031.001.log"), "").unwrap();
            assert!(doubao.is_available().await);
            assert!(!registration
                .inputs
                .get_input("doubao-work")
                .unwrap()
                .running());
            // The registered closure must re-evaluate actual scope/control changes.
            let original_gate_bits = {
                let bits = registration.bits.lock().unwrap();
                (bits.scope, bits.recorded.clone(), bits.modes.clone())
            };
            {
                let mut bits = registration.bits.lock().unwrap();
                bits.scope = DeploymentScopeMode::Recorded;
                bits.recorded.clear();
            }
            assert!(!doubao.enabled());
            registration
                .bits
                .lock()
                .unwrap()
                .recorded
                .insert("doubao-work".into());
            assert!(doubao.enabled());
            registration
                .bits
                .lock()
                .unwrap()
                .modes
                .insert("doubao-work".into(), crate::types::AgentControlMode::Off);
            assert!(!doubao.enabled());
            registration
                .bits
                .lock()
                .unwrap()
                .modes
                .insert("doubao-work".into(), crate::types::AgentControlMode::On);
            assert!(doubao.enabled());
            {
                let mut bits = registration.bits.lock().unwrap();
                (bits.scope, bits.recorded, bits.modes) = original_gate_bits;
            }
            let history = data
                .join("logs/qwen-work-cn/history")
                .to_string_lossy()
                .into_owned();
            assert_eq!(
                find("qwen-work-cn-trace").watch_paths(),
                [
                    history.clone(),
                    home.join(".qwenworkcn")
                        .join("logs")
                        .join("sessions")
                        .to_string_lossy()
                        .into_owned(),
                ]
            );
            assert_eq!(find("qwen-work-cn-hook").watch_paths(), [history]);
            assert!(!find("qwen-work-cn-trace").enabled());
            assert!(find("qwen-work-cn-hook").enabled());
            assert_eq!(find("qwen-work-cn-hook").poll_interval_ms(), 1234);
            // Prove the real registered trace body received custom dataDir:
            // startup must baseline this physical sentinel history, without
            // exporting it or probing any actual Agent source.
            let history_dir = data.join("logs/qwen-work-cn/history");
            std::fs::create_dir_all(&history_dir).unwrap();
            let history_file = format!(
                "qwen-work-cn-{}.jsonl",
                crate::utils::get_today_date_string()
            );
            std::fs::write(history_dir.join(&history_file), "{}\n").unwrap();
            let trace = registration.inputs.get_input("qwen-work-cn-trace").unwrap();
            trace.start().await.unwrap();
            let checkpoint = registration_store.get("qwen-work-cn-trace");
            assert_eq!(checkpoint.last_file(), Some(history_file.as_str()));
            assert_eq!(checkpoint.last_offset(), Some(3.0));
            trace.stop().await;
            assert_eq!(
                find("openclaw-plugin-log").watch_paths(),
                [data.join("logs/openclaw").to_string_lossy().into_owned(),]
            );
            assert_eq!(find("openclaw-plugin-log").poll_interval_ms(), 1234);
            assert_eq!(find("opencode-log").poll_interval_ms(), 1000);
            assert_eq!(find("qoder-cn-trace").poll_interval_ms(), 1000);
            // start() must already have installed configured identity, privacy
            // and masking on the production manager before any fixture is accepted.
            orchestrator.inputs.register_input(LiveInput::new(
                "privacy-fixture",
                "orchestrator-fixture",
                "fixture",
                || false,
                || Box::pin(async { Ok(()) }),
                || Box::pin(async {}),
            ));
            orchestrator.set_user_id("fallback-user");
            let key = format!("AKIA{}", "IOSFODNN7EXAMPLE");
            let mut included = fixture_entry("included", "");
            included.event_name = Some(crate::types::AgentEventName::Other);
            included.workspace_current_root =
                Some(home.join("included").to_string_lossy().into_owned());
            included.extra.insert(
                "workspace.path".into(),
                serde_json::json!(home.join("included")),
            );
            included.input_messages =
                Some(serde_json::json!([{"role":"user","content":format!("use {key}")}]));
            let mut blocked = included.clone();
            blocked.event_id = "excluded".into();
            blocked.session_id = "excluded-fixture-session".into();
            blocked.workspace_current_root = Some(excluded.to_string_lossy().into_owned());
            blocked
                .extra
                .insert("workspace.path".into(), serde_json::json!(excluded));
            orchestrator
                .inputs
                .accept_entries("privacy-fixture", vec![included, blocked])
                .await
                .unwrap();
            let rows = output_rows(&data)
                .into_iter()
                .filter(|row| row["gen_ai.agent.type"] == "orchestrator-fixture")
                .collect::<Vec<_>>();
            assert_eq!(
                rows.len(),
                2,
                "original Other plus exactly one standard agent.input"
            );
            let expected_ids = std::collections::HashSet::from([
                "included".to_owned(),
                crate::normalization::derive_agent_input_event_id("included"),
            ]);
            let observed_ids = rows
                .iter()
                .map(|row| row["event.id"].as_str().unwrap().to_owned())
                .collect::<std::collections::HashSet<_>>();
            assert_eq!(observed_ids, expected_ids);
            assert!(rows.iter().all(|row| row["user.id"] == "configured-user"));
            let serialized = serde_json::to_string(&rows).unwrap();
            assert!(!serialized.contains(&key));
            assert!(serialized.contains("[ACCESSKEY_MASKED]"));
            let summary = orchestrator.summary_writer.lock().unwrap().take().unwrap();
            summary.refresh().await;
            *orchestrator.summary_writer.lock().unwrap() = Some(summary);
            assert!(data.join("logs/metrics-summary.json").is_file());
            tokio::time::timeout(Duration::from_secs(3), async {
                while !data.join("logs/runtime.json").exists() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let discovery = orchestrator.discovery.lock().unwrap().clone().unwrap();
            let task = orchestrator
                .runtime_task
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .abort_handle();
            orchestrator.start().await.unwrap();
            assert!(Arc::ptr_eq(
                &discovery,
                orchestrator.discovery.lock().unwrap().as_ref().unwrap()
            ));
            assert_eq!(events.lock().unwrap().len(), events_after_start);
            orchestrator
                .state_store
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .set_offset("full-start-checkpoint", 42.0);
            if mode == "ordered-start" {
                orchestrator
                    .state_store
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .set_offset("restored-before-discovery", 99.0);
            }
            tokio::time::timeout(Duration::from_secs(5), orchestrator.stop())
                .await
                .unwrap();
            assert!(!*orchestrator.running.lock().unwrap());
            tokio::time::timeout(Duration::from_secs(3), async {
                while !task.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(orchestrator.runtime_task.lock().unwrap().is_none());
            assert!(orchestrator.summary_task.lock().unwrap().is_none());
            assert!(orchestrator.signal_task.lock().unwrap().is_none());
            assert!(orchestrator.dashboard.lock().unwrap().is_none());
            assert!(orchestrator.interceptor.lock().unwrap().is_none());
            assert!(!data.join("logs/runtime.json").exists());
            assert!(data.join("logs/input-state.json").is_file());
            let saved: serde_json::Value =
                serde_json::from_slice(&std::fs::read(data.join("logs/input-state.json")).unwrap())
                    .unwrap();
            assert_eq!(saved["full-start-checkpoint"]["lastOffset"], 42.0);
            if mode == "ordered-start" {
                let disk: serde_json::Value = serde_json::from_slice(
                    &std::fs::read(data.join("logs/input-state.json")).unwrap(),
                )
                .unwrap();
                assert_eq!(disk["restored-before-discovery"]["lastOffset"], 99.0);
            }

            assert_eq!(
                events.lock().unwrap().last(),
                Some(&OrchestratorEvent::Stopped)
            );
            let events_after_stop = events.lock().unwrap().len();
            orchestrator.stop().await;
            assert_eq!(events.lock().unwrap().len(), events_after_stop);
            return;
        }
        for mode in [
            "success",
            "dashboard-occupied",
            "poll-env",
            "opencode-home",
            "ordered-start",
            "custom-output",
            "opencode-cli-home",
        ] {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            let resources = root.path().join("resources");
            std::fs::create_dir_all(home.join(".loongsuite-pilot")).unwrap();
            std::fs::create_dir_all(resources.join("agents.d")).unwrap();
            std::fs::create_dir_all(resources.join("assets/dashboard")).unwrap();
            std::fs::write(resources.join("runtime-manifest.json"), "{}").unwrap();
            std::fs::write(
                resources.join("assets/dashboard/index.html"),
                "<!doctype html><title>fixture</title>",
            )
            .unwrap();
            std::fs::write(home.join(".loongsuite-pilot/config.json"), "{}").unwrap();

            if mode == "opencode-home" || mode == "opencode-cli-home" {
                use sha2::Digest;
                if mode == "opencode-cli-home" {
                    std::fs::create_dir_all(home.join("bin")).unwrap();
                    #[cfg(windows)]
                    std::fs::write(home.join("bin/opencode.cmd"), "@exit /b 0\r\n").unwrap();
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let executable = home.join("bin/opencode");
                        std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
                        std::fs::set_permissions(
                            executable,
                            std::fs::Permissions::from_mode(0o755),
                        )
                        .unwrap();
                        // The minimal glibc verification image has no which.
                        // Supply its lookup protocol, not a canned success:
                        // delegate to the OS shell's actual PATH lookup.
                        let locator = home.join("bin/which");
                        let log = format!(
                            "'{}'",
                            home.join("lookup.log")
                                .to_string_lossy()
                                .replace('\'', "'\\''")
                        );
                        std::fs::write(&locator, format!(
                            "#!/bin/sh\n[ \"$#\" -eq 1 ] || exit 79\nprintf '%s\\n' \"$1\" >> {log}\ncommand -v \"$1\" >/dev/null 2>&1\n"
                        )).unwrap();
                        std::fs::set_permissions(locator, std::fs::Permissions::from_mode(0o755))
                            .unwrap();
                    }
                    assert!(
                        !home.join(".config/opencode").exists(),
                        "CLI-only detection must not be satisfied by an existing config directory"
                    );
                } else {
                    std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
                }
                std::fs::create_dir_all(home.join("decoy-home")).unwrap();
                std::fs::write(
                    resources.join("agents.d/opencode.json"),
                    include_str!("../../agents.d/opencode.json"),
                )
                .unwrap();
                let assets: [(&str, &[u8]); 5] = [
                    (
                        "opencode/index.js",
                        include_bytes!("../../assets/plugins/opencode/index.js"),
                    ),
                    (
                        "opencode/package.json",
                        include_bytes!("../../assets/plugins/opencode/package.json"),
                    ),
                    (
                        "opencode/plugin.mjs",
                        include_bytes!("../../assets/plugins/opencode/plugin.mjs"),
                    ),
                    (
                        "opencode/v2.mjs",
                        include_bytes!("../../assets/plugins/opencode/v2.mjs"),
                    ),
                    (
                        "shared/resource-context.mjs",
                        include_bytes!("../../assets/plugins/shared/resource-context.mjs"),
                    ),
                ];
                let mut entries = Vec::new();
                for (relative, bytes) in assets {
                    let path = format!("assets/plugins/{relative}");
                    let destination = resources.join(&path);
                    std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
                    std::fs::write(destination, bytes).unwrap();
                    entries.push(serde_json::json!({"path":path,"sha256":hex::encode(sha2::Sha256::digest(bytes))}));
                }
                std::fs::write(
                    resources.join("runtime-manifest.json"),
                    serde_json::to_vec(&serde_json::json!({
                        "schema":1,"runtime":"rust","version":"2.0.0-fixture","gitCommit":"fixture",
                        "target":crate::utils::runtime_paths::build_target(),"edition":"opensource",
                        "binary":"fixture-unused","resources":entries
                    }))
                    .unwrap(),
                )
                .unwrap();
            }
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", "core::orchestrator::tests::full_start_and_registration_are_isolated_in_temp_home_subprocess", "--nocapture"])
                .env_clear()
                .env(CHILD, mode).env("HOME", &home).env("USERPROFILE", &home)
                .env("PATH", &home).env("LOONGSUITE_PILOT_RESOURCE_ROOT", &resources)
                .current_dir(&home).stdin(std::process::Stdio::null());
            for key in [
                "SystemRoot",
                "WINDIR",
                "TEMP",
                "TMP",
                "ComSpec",
                "ProgramFiles",
                "ProgramFiles(x86)",
                "ProgramW6432",
                "PATHEXT",
            ] {
                if let Some(value) = std::env::var_os(key) {
                    command.env(key, value);
                }
            }
            command
                .env("TMPDIR", std::env::temp_dir())
                .env("TMP", std::env::temp_dir())
                .env("TEMP", std::env::temp_dir());
            if mode == "poll-env" {
                command.env("LOONGSUITE_PILOT_POLL_INTERVAL_MS", "3000");
            }
            if mode == "opencode-cli-home" {
                // Only this declared Agent is enabled, and our inert stub comes
                // first. Keep the fixture POSIX locator / system where host;
                // HOME and all writable configuration paths remain isolated.
                let mut search = vec![home.join("bin")];
                #[cfg(windows)]
                search.push(
                    std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                        .join("System32"),
                );
                #[cfg(unix)]
                search.extend([
                    std::path::PathBuf::from("/usr/bin"),
                    std::path::PathBuf::from("/bin"),
                ]);
                command.env("PATH", std::env::join_paths(search).unwrap());
            }
            let result = command.output().unwrap();
            assert!(
                result.status.success(),
                "isolated {mode} failed:\n{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }

    #[tokio::test]
    async fn actual_menu_stop_failure_notifies_and_preserves_final_state_save() {
        let root = tempfile::tempdir().unwrap();
        let orchestrator = local_output_orchestrator(root.path());
        let mut ops = ProcessOps::inert(true);
        let executable = root
            .path()
            .join("fixture-menu-app")
            .to_string_lossy()
            .into_owned();
        let owned = executable.clone();
        ops.read_command = Arc::new(move |pid| (pid == 424242).then(|| owned.clone()));
        ops.alive = Arc::new(|pid| pid == 424242);
        let signals = Arc::new(Mutex::new(Vec::new()));
        let sent = signals.clone();
        ops.signal =
            Arc::new(move |pid, signal| sent.lock().unwrap().push((pid, signal.to_string())));
        let mut status = StatusBarAppManager::new(root.path().to_string_lossy(), "fixture", ops);
        status.set_cache_dir(root.path().join("cache").to_string_lossy());
        std::fs::create_dir(root.path().join("logs")).unwrap();
        std::fs::write(
            status.runtime_record_path(),
            serde_json::to_vec(&serde_json::json!({
                "executablePath": executable, "packageVersion":"fixture", "pid":424242,
                "updatedAt":"2026-01-01T00:00:00Z"
            }))
            .unwrap(),
        )
        .unwrap();
        let runtime = status.runtime_record_path();
        *orchestrator.status_bar.lock().unwrap() = Some(status);
        let store = Arc::new(StateStore::new(root.path().join("state.json")));
        store.set_offset("shutdown-fixture", 42.0);
        *orchestrator.state_store.lock().unwrap() = Some(store);
        let sink = Arc::new(ShutdownLockProbe {
            owner: Arc::downgrade(&orchestrator),
            calls: std::sync::atomic::AtomicUsize::new(0),
            fail: false,
        });
        *orchestrator.flusher.lock().unwrap() = Some(sink.clone());
        *orchestrator.running.lock().unwrap() = true;
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        orchestrator.on_event(move |event| received.lock().unwrap().push(event));
        tokio::time::timeout(Duration::from_secs(8), orchestrator.stop())
            .await
            .unwrap();
        assert_eq!(
            signals.lock().unwrap().as_slice(),
            [(424242, "SIGTERM".into()), (424242, "SIGKILL".into())]
        );
        assert!(
            Path::new(&runtime).is_file(),
            "failed menu stop must retain its real runtime breadcrumb"
        );
        assert!(!*orchestrator.running.lock().unwrap());
        assert_eq!(sink.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("state.json")).unwrap())
                .unwrap();
        assert_eq!(state["shutdown-fixture"]["lastOffset"], 42.0);
        let events = events.lock().unwrap();
        assert!(
            matches!(&events[0], OrchestratorEvent::ComponentFailure { component, error }
            if component == "status-bar" && error.contains("did not stop"))
        );
        assert_eq!(events.last(), Some(&OrchestratorEvent::Stopped));
    }

    #[tokio::test(start_paused = true)]
    async fn actual_multimodal_factory_reports_direct_and_discovered_storage_and_cold_waiting() {
        use crate::multimodal::http::{HttpHandler, HttpReply, HTTP_HANDLER};
        for kind in ["sls", "delegated-ready", "delegated-cold"] {
            let root = tempfile::tempdir().unwrap();
            let mut config = local_output_orchestrator(root.path()).config.clone();
            config.agents = serde_json::from_value(serde_json::json!({
                "codex":{"multimodal":{"uploadMode":"all"}}
            }))
            .unwrap();
            config.multimodal = Some(serde_json::from_value(serde_json::json!({
                "storage":{
                    "type":if kind == "sls" {"sls"} else {"delegatedOss"},
                    "target":{"endpoint":"https://cn-hangzhou.log.aliyuncs.com","project":"fixture-proj","logstore":"fixture-store"},
                    "auth":{"mode":"ak","accessKeyId":"synthetic-ak","accessKeySecret":"synthetic-sk"}
                },
                "storageBasePath":"sls://fixture-proj/fixture-store"
            })).unwrap());
            let orchestrator = Arc::new(Orchestrator::new(config));
            let events = Arc::new(Mutex::new(Vec::new()));
            let received = events.clone();
            orchestrator.on_event(move |event| received.lock().unwrap().push(event));
            let calls = Arc::new(Mutex::new(Vec::new()));
            let requests = calls.clone();
            let mode = kind.to_string();
            let transport: HttpHandler = Arc::new(move |call| {
                assert_eq!(call.method, "POST");
                assert!(call.url.ends_with("/presign"));
                requests.lock().unwrap().push(call);
                let ready = mode == "delegated-ready";
                Box::pin(async move {
                    Ok(HttpReply {
                    status: if ready {200} else {401}, headers:Vec::new(), error:None,
                    body: serde_json::to_vec(&if ready {
                        serde_json::json!({"url":"https://fixture-bucket.oss-cn-hangzhou.aliyuncs.com/fixture-proj/fixture-store/probe?signature=synthetic"})
                    } else { serde_json::json!({"error":"synthetic startup refusal"}) }).unwrap(),
                })
                })
            });
            HTTP_HANDLER
                .scope(transport, async {
                    orchestrator.start_multimodal().await;
                    // Let the cold retry task register its real sleep before it
                    // is closed and the paused clock is advanced.
                    tokio::task::yield_now().await;
                    assert!(orchestrator.inputs_have_multimodal());
                    let storage_base_path = match kind {
                        "sls" => Some("sls://fixture-proj/fixture-store".into()),
                        "delegated-ready" => {
                            Some("oss://fixture-bucket/fixture-proj/fixture-store".into())
                        }
                        _ => None,
                    };
                    assert_eq!(
                        events.lock().unwrap().as_slice(),
                        [OrchestratorEvent::MultimodalReady { storage_base_path }]
                    );
                    assert_eq!(calls.lock().unwrap().len(), usize::from(kind != "sls"));
                    // No blobs or fake Agent events: do not spawn an upload. Closing
                    // the real installed manager processor also closes its uploader
                    // before the cold retry timer is allowed to wake.
                    orchestrator.inputs.stop_all().await;
                    tokio::time::advance(Duration::from_secs(2)).await;
                    tokio::task::yield_now().await;
                    assert_eq!(calls.lock().unwrap().len(), usize::from(kind != "sls"));
                })
                .await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn delegated_cold_processor_recovers_live_through_actual_retry_scheduler_and_factory() {
        use crate::multimodal::http::{HttpHandler, HttpReply, HTTP_HANDLER};
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let root = tempfile::tempdir().unwrap();
        let mut config = local_output_orchestrator(root.path()).config.clone();
        config.agents = serde_json::from_value(serde_json::json!({
            "codex":{"multimodal":{"uploadMode":"all"}}
        }))
        .unwrap();
        config.multimodal = Some(serde_json::from_value(serde_json::json!({
            "storage":{"type":"delegatedOss",
                "target":{"endpoint":"https://cn-hangzhou.log.aliyuncs.com","project":"fixture-proj","logstore":"fixture-store"},
                "auth":{"mode":"ak","accessKeyId":"synthetic-ak","accessKeySecret":"synthetic-sk"}},
            "storageBasePath":"sls://fixture-proj/fixture-store"
        })).unwrap());
        let orchestrator = Arc::new(Orchestrator::new(config));
        let healthy = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let (ready, count) = (healthy.clone(), requests.clone());
        let transport: HttpHandler = Arc::new(move |call| {
            assert_eq!(call.method, "POST");
            assert!(call.url.ends_with("/presign"));
            let body: serde_json::Value = serde_json::from_slice(&call.body).unwrap();
            assert_eq!(body["method"], "PUT");
            count.fetch_add(1, Ordering::SeqCst);
            let ready = ready.load(Ordering::SeqCst);
            Box::pin(async move {
                Ok(HttpReply {
                status:if ready {200} else {401}, headers:Vec::new(), error:None,
                body:serde_json::to_vec(&if ready {
                    serde_json::json!({"url":"https://recovered-fixture.oss-cn-hangzhou.aliyuncs.com/fixture-proj/fixture-store/probe?signature=synthetic"})
                } else {serde_json::json!({"error":"synthetic initial refusal"})}).unwrap()
            })
            })
        });
        HTTP_HANDLER
            .scope(transport, async {
                orchestrator.start_multimodal().await;
                assert!(orchestrator.inputs_have_multimodal());
                assert_eq!(orchestrator.inputs.multimodal_storage_base_path(), None);
                assert_eq!(requests.load(Ordering::SeqCst), 1);
                // The actual processor owns the delayed retry. No replacement
                // callback, storage setter or reconstructed processor is involved.
                tokio::task::yield_now().await;
                healthy.store(true, Ordering::SeqCst);
                tokio::time::advance(Duration::from_millis(1000)).await;
                tokio::time::timeout(Duration::from_secs(3), async {
                    while orchestrator.inputs.multimodal_storage_base_path().is_none() {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .expect("actual delegated retry did not establish a usable origin");
                assert_eq!(requests.load(Ordering::SeqCst), 2);
                assert_eq!(
                    orchestrator
                        .inputs
                        .multimodal_storage_base_path()
                        .as_deref(),
                    Some("oss://recovered-fixture/fixture-proj/fixture-store")
                );
                orchestrator.inputs.stop_all().await;
                assert_eq!(orchestrator.inputs.multimodal_storage_base_path(), None);
                tokio::time::advance(Duration::from_secs(120)).await;
                tokio::task::yield_now().await;
                assert_eq!(
                    requests.load(Ordering::SeqCst),
                    2,
                    "closed processor must not restart sniffing"
                );
            })
            .await;
    }

    struct OrderedFailureSink {
        owner: std::sync::Weak<Orchestrator>,
        metrics_attempts: Arc<std::sync::atomic::AtomicUsize>,
        source_stops: Arc<std::sync::atomic::AtomicUsize>,
        entered: tokio::sync::Notify,
        release: tokio::sync::Semaphore,
    }

    #[async_trait]
    impl BaseFlusher for OrderedFailureSink {
        fn name(&self) -> &str {
            "ordered-fixture-failure"
        }
        async fn send(
            &self,
            _: AgentActivityEntry,
            _: Option<f64>,
        ) -> Result<(), crate::flushers::FlushError> {
            panic!("ordering fixture must not emit Agent payloads")
        }
        async fn send_batch(
            &self,
            _: Vec<AgentActivityEntry>,
            _: Option<Vec<f64>>,
        ) -> Result<(), crate::flushers::FlushError> {
            panic!("ordering fixture must not emit Agent payloads")
        }
        async fn flush(&self) -> Result<(), crate::flushers::FlushError> {
            Ok(())
        }
        async fn shutdown(&self) -> Result<(), crate::flushers::FlushError> {
            let owner = self.owner.upgrade().unwrap();
            assert_eq!(
                self.source_stops.load(std::sync::atomic::Ordering::SeqCst),
                1
            );
            assert_eq!(
                self.metrics_attempts
                    .load(std::sync::atomic::Ordering::SeqCst),
                2
            );
            assert!(owner.metrics.lock().unwrap().is_none());
            assert!(!Path::new(&owner.data_dir_join("state.json")).exists());
            self.entered.notify_one();
            self.release.acquire().await.unwrap().forget();
            Err(crate::flushers::FlushError::new(
                "synthetic sink shutdown refusal",
            ))
        }
    }

    #[tokio::test]
    async fn metrics_snapshot_failure_during_actual_stop_does_not_skip_sink_or_checkpoint() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let root = tempfile::tempdir().unwrap();
        let orchestrator = local_output_orchestrator(root.path());
        let source = fixture_source(Arc::new(StateStore::new(
            root.path().join("source-state.json"),
        )));
        let stops = source.inner.body.stops.clone();
        let mut entries = Vec::new();
        orchestrator
            .add_hosted_when(
                &mut entries,
                HostedInputSpec::new("fixture-listener", "orchestrator-fixture", "fixture", 1),
                source,
                Vec::new(),
                || async { true },
                || true,
            )
            .await;
        let discovery = Arc::new(AgentDiscoveryService::new(entries));
        discovery.start().await;
        assert_eq!(stops.load(Ordering::SeqCst), 0);
        *orchestrator.discovery.lock().unwrap() = Some(discovery);
        let attempts = Arc::new(AtomicUsize::new(0));
        let mut options = MetricsWriterOptions::new(
            root.path().to_string_lossy(),
            "fixture",
            "fixture-user",
            DataflowSnapshot::default,
        );
        let observed = attempts.clone();
        let stopped = stops.clone();
        options.get_snapshot = Arc::new(move || {
            let before = observed.fetch_add(1, Ordering::SeqCst);
            if before == 0 {
                assert_eq!(stopped.load(Ordering::SeqCst), 0);
            } else {
                assert_eq!(
                    stopped.load(Ordering::SeqCst),
                    1,
                    "discovery/input must stop before final metrics snapshot"
                );
            }
            Err("synthetic actual metrics snapshot refusal".into())
        });
        let metrics = Arc::new(MetricsWriter::new(options));
        metrics.start().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        *orchestrator.metrics.lock().unwrap() = Some(metrics);
        let sink = Arc::new(OrderedFailureSink {
            owner: Arc::downgrade(&orchestrator),
            metrics_attempts: attempts.clone(),
            source_stops: stops,
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Semaphore::new(0),
        });
        *orchestrator.flusher.lock().unwrap() = Some(sink.clone());
        let state = Arc::new(StateStore::new(root.path().join("state.json")));
        state.set_offset("ordered-fixture", 42.0);
        *orchestrator.state_store.lock().unwrap() = Some(state);
        *orchestrator.running.lock().unwrap() = true;
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        orchestrator.on_event(move |event| received.lock().unwrap().push(event));
        let owner = orchestrator.clone();
        let stopping = tokio::spawn(async move { owner.stop().await });
        tokio::time::timeout(Duration::from_secs(3), sink.entered.notified())
            .await
            .unwrap();
        assert!(!stopping.is_finished());
        assert!(
            !root.path().join("state.json").exists(),
            "final save must wait for sink shutdown settlement"
        );
        assert!(
            events.lock().unwrap().is_empty(),
            "Stopped cannot precede final cleanup"
        );
        sink.release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(3), stopping)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("state.json")).unwrap())
                .unwrap();
        assert_eq!(persisted["ordered-fixture"]["lastOffset"], 42.0);
        let events = events.lock().unwrap();
        assert!(
            matches!(&events[0], OrchestratorEvent::ComponentFailure {component,error}
            if component == "flusher" && error.contains("shutdown refusal"))
        );
        assert_eq!(events.last(), Some(&OrchestratorEvent::Stopped));
    }
    #[test]
    fn doubao_listener_override_cannot_bypass_agent_disable_or_recorded_scope() {
        let root = tempfile::tempdir().unwrap();
        let mut config = isolated_orchestrator(root.path()).config.clone();
        config.agents =
            serde_json::from_value(serde_json::json!({"doubao-work":{"enabled":true}})).unwrap();
        let mut bits = GateBits {
            scope: DeploymentScopeMode::Auto,
            recorded: HashSet::new(),
            modes: HashMap::new(),
        };
        let enabled = |config: &AnalyticsConfig, bits: &GateBits| {
            listener_on(config, &config.agents, bits, "doubao-work", "doubao-work")
        };
        assert!(enabled(&config, &bits));
        config.listeners.get_mut("doubao-work").unwrap().enabled = false;
        assert!(!enabled(&config, &bits));
        bits.modes
            .insert("doubao-work".into(), crate::types::AgentControlMode::On);
        assert!(enabled(&config, &bits));
        config.agents.get_mut("doubao-work").unwrap().enabled = Some(false);
        assert!(
            !enabled(&config, &bits),
            "explicit agent disable wins over a forced listener"
        );
        config.agents.get_mut("doubao-work").unwrap().enabled = Some(true);
        bits.scope = DeploymentScopeMode::Recorded;
        assert!(
            !enabled(&config, &bits),
            "forced listener cannot escape the recorded scope"
        );
        bits.recorded.insert("doubao-work".into());
        assert!(enabled(&config, &bits));
        bits.modes
            .insert("doubao-work".into(), crate::types::AgentControlMode::Off);
        assert!(!enabled(&config, &bits));
    }
}
