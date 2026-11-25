use super::outbox::{write_checkpoint, CallbackOutboxFlusher, LegacyCheckpointHandoff, Outbox};
use super::policy::{AgentPlan, Init, Policy};
use crate::checkpoints::StateStore;
use crate::core::{InputManager, LiveInput};
use crate::inputs::base::{HostedInput, InputBody};
use crate::inputs::codex_aborted_turn::{CodexAbortedTurnInput, CodexAbortedTurnInputOptions};
use crate::inputs::codex_transcript::{CodexTranscriptInput, CodexTranscriptInputOptions};
use crate::inputs::qoder_trace::{QoderTraceInput, QoderTraceOptions, QoderTraceReaders};
use crate::inputs::qwen_work_cn::{
    QwenWorkCnCollaborationInput, QwenWorkCnNativeWakeups, QwenWorkCnTraceInput,
    QwenWorkCnTraceOptions,
};
use crate::types::AgentActivityEntry;
use crate::utils::source_access::{self, SourceScope};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;

pub struct Collector {
    init: Init,
    pub queue: Arc<Outbox>,
    agents: BTreeMap<String, Agent>,
    global_stop: Arc<AtomicBool>,
}
struct Agent {
    plan: AgentPlan,
    cancel: Arc<AtomicBool>,
    activate: Option<mpsc::Sender<()>>,
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
    report: Arc<Mutex<Value>>,
    metrics: Arc<Mutex<Option<Arc<InputManager>>>>,
}

pub(crate) fn configure_qwen_wakeups(
    data_dir: &Path,
    transcript_root: Option<&Path>,
) -> anyhow::Result<()> {
    let path = data_dir.join("wakeups/qwen-work-cn-policy.json");
    if transcript_root.is_some() || path.try_exists()? {
        write_checkpoint(&path, &qwen_wakeup_policy(transcript_root))?;
    }
    Ok(())
}

fn qwen_wakeup_policy(transcript_root: Option<&Path>) -> String {
    match transcript_root {
        Some(root) => json!({"schema":1,"enabled":true,"transcript_root":root}),
        None => json!({"schema":1,"enabled":false}),
    }
    .to_string()
}

impl Collector {
    pub fn new(init: Init, queue: Arc<Outbox>, stop: Arc<AtomicBool>) -> Self {
        Self {
            init,
            queue,
            agents: BTreeMap::new(),
            global_stop: stop,
        }
    }
    pub fn apply(
        &mut self,
        policy: &Policy,
        commit: impl FnOnce() -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        let mut plans = policy.agents.clone();
        if let Some(recovery) = &policy.codex_recovery {
            plans.insert("codex-recovery".into(), recovery.clone());
        }
        let delivery_changed = *self.queue.options.read().unwrap() != policy.delivery;
        let removed: Vec<_> = self
            .agents
            .iter()
            .filter(|(id, old)| {
                plans.get(*id) != Some(&old.plan)
                    || (delivery_changed
                        && old
                            .report
                            .lock()
                            .unwrap()
                            .get("state")
                            .and_then(Value::as_str)
                            .is_some_and(|s| matches!(s, "paused" | "failed")))
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut staged = BTreeMap::new();
        for (id, plan) in plans {
            if !self.agents.contains_key(&id) || removed.contains(&id) {
                staged.insert(
                    id,
                    Agent::start(
                        &self.init,
                        plan,
                        self.queue.clone(),
                        self.global_stop.clone(),
                    )?,
                );
            }
        }
        let qwen_root = policy.agents.get("qwen-work-cn").and_then(|plan| {
            plan.sources
                .iter()
                .find(|source| source.kind == "transcript")
                .map(|source| source.path.as_path())
        });
        let qwen_policy = self.init.data_dir.join("wakeups/qwen-work-cn-policy.json");
        let backup = if qwen_root.is_some() || qwen_policy.try_exists()? {
            stage_checkpoint_mirror(&qwen_policy, Some(&qwen_wakeup_policy(qwen_root)), false)?
        } else {
            MirrorRollback::Unchanged
        };
        if let Err(error) = commit() {
            backup.restore(&qwen_policy)?;
            return Err(error);
        }
        for id in removed {
            self.agents.remove(&id);
        }
        self.queue.update(policy.delivery.clone());
        for (id, mut agent) in staged {
            agent
                .activate
                .take()
                .expect("staged source")
                .send(())
                .expect("source waiting for activation");
            self.agents.insert(id, agent);
        }
        Ok(())
    }
    pub fn snapshot(&self) -> Value {
        json!(self.agents.values().map(|agent|json!({"agent":agent.plan.agent,"profile":agent.plan.profile,"status":agent.report.lock().unwrap().clone()})).collect::<Vec<_>>())
    }
    pub fn dataflow(&self) -> crate::metrics::DataflowSnapshot {
        let mut flow = crate::metrics::DataflowSnapshot::default();
        for agent in self.agents.values() {
            let manager = agent.metrics.lock().unwrap().clone();
            if let Some(manager) = manager {
                for (id, c) in manager.take_input_counter_snapshot() {
                    flow.in_events_total += c.in_events as i64;
                    flow.in_bytes_total += c.in_bytes as i64;
                    flow.inputs.insert(
                        id,
                        crate::metrics::InputSnapshot {
                            source_kind: c.source_kind.into(),
                            raw_read_calls: c.raw_read_calls as i64,
                            raw_read_bytes: c.raw_read_bytes as i64,
                            raw_in_records: c.raw_in_records as i64,
                            raw_in_bytes: c.raw_in_bytes as i64,
                            raw_in_max_batch_bytes: c.raw_in_max_batch_bytes as i64,
                            raw_in_max_record_bytes: c.raw_in_max_record_bytes as i64,
                            raw_backlog_bytes_max: c.raw_backlog_bytes_max as i64,
                            parse_success_records: c.parse_success_records as i64,
                            parse_failed_records: c.parse_failed_records as i64,
                            read_duration_ms: c.read_duration_ms,
                            process_duration_ms: c.process_duration_ms,
                            in_events: c.in_events as i64,
                            in_bytes: c.in_bytes as i64,
                            out_failed: c.out_failed as i64,
                            last_poll_time: c.last_poll_time,
                            start_time: c.start_time,
                            collection_method: c.collection_method,
                            agent: c.agent_type,
                            running: agent.thread.as_ref().is_some_and(|t| !t.is_finished()),
                        },
                    );
                }
            }
        }
        flow
    }
    pub fn stop(&mut self) {
        for agent in self.agents.values_mut() {
            agent.stop();
        }
    }
}
impl Drop for Collector {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Agent {
    fn start(
        init: &Init,
        plan: AgentPlan,
        queue: Arc<Outbox>,
        global: Arc<AtomicBool>,
    ) -> anyhow::Result<Self> {
        let cancel = Arc::new(AtomicBool::new(false));
        let report = Arc::new(Mutex::new(json!({"state":"starting"})));
        let metrics = Arc::new(Mutex::new(None));
        let source_metrics = metrics.clone();
        let (tx, rx) = mpsc::channel();
        let (activate, activation) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let context = (
            init.clone(),
            plan.clone(),
            queue,
            cancel.clone(),
            global,
            report.clone(),
        );
        let thread = std::thread::Builder::new()
            .name(format!("pilot-source-{}", plan.agent))
            .spawn(move || {
                let (init, plan, queue, cancel, global, report) = context;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_agent(
                        init,
                        plan,
                        queue.clone(),
                        (cancel, global),
                        (report.clone(), source_metrics),
                        rx,
                        (ready_tx.clone(), activation),
                    )
                }))
                .unwrap_or_else(|_| Err(anyhow::anyhow!("SDK source task panicked")));
                if let Err(error) = result {
                    if ready_tx.send(Err(error.to_string())).is_ok() {
                        return;
                    }
                    queue.alarm("SDK_SOURCE_FAILURE", &error.to_string());
                    *report.lock().unwrap() = json!({"state":"failed","reason":error.to_string()});
                }
            })?;
        // Thread creation/runtime setup, not source availability, is the start
        // barrier. Missing sources remain observable per-agent waiting states.
        let initialized = ready_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|err| err.to_string())
            .and_then(|result| result);
        if let Err(error) = initialized {
            cancel.store(true, Ordering::SeqCst);
            let _ = tx.send(());
            drop(activate);
            let _ = thread.join();
            anyhow::bail!("source runtime failed to initialize: {error}");
        }
        Ok(Self {
            plan,
            cancel,
            activate: Some(activate),
            stop: tx,
            thread: Some(thread),
            report,
            metrics,
        })
    }
    fn stop(&mut self) {
        self.activate.take();
        self.cancel.store(true, Ordering::SeqCst);
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Drop for Agent {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Cycle {
    entries: Vec<AgentActivityEntry>,
    estimated: usize,
    failure: Option<String>,
}
impl Cycle {
    fn reserve_batch(&mut self, entries: &[AgentActivityEntry], limit: usize) -> bool {
        // Bound the pre-serialization source buffer separately from the outbox.
        let estimate = entries
            .iter()
            .map(|entry| entry.estimated_heap_bytes())
            .sum::<usize>();
        let estimated = self.estimated.saturating_add(estimate);
        if estimated > limit {
            self.failure = Some("source cycle memory limit exceeded; cursor retained".into());
            return false;
        }
        self.estimated = estimated;
        true
    }
}

fn bind<T: InputBody>(
    input: &Arc<HostedInput<T>>,
    manager: Arc<InputManager>,
    queue: Arc<Outbox>,
    scope: Arc<SourceScope>,
    cancel: Arc<AtomicBool>,
    global: Arc<AtomicBool>,
    buffer: Arc<Mutex<Cycle>>,
) {
    let error_queue = queue.clone();
    input.on_collect_error(move |error| error_queue.alarm("SDK_SOURCE_READ", error));
    let id = input.id().to_owned();
    let manager = Arc::downgrade(&manager);
    // The synchronous callbacks capture all native Codex sub-batches as well as
    // the Qoder return batch. Only this completed cycle enters the manager.
    let begin_buffer = buffer.clone();
    let begin_queue = queue.clone();
    let begin_cancel = cancel.clone();
    input.set_cycle_hooks(
        Arc::new(move || {
            let queue = begin_queue.clone();
            let cancel = begin_cancel.clone();
            let global = global.clone();
            let buffer = begin_buffer.clone();
            let scope = scope.clone();
            Box::pin(async move {
                anyhow::ensure!(!global.load(Ordering::SeqCst), "SDK stopping");
                queue.before_collect(&cancel).await?;
                scope.reset();
                *buffer.lock().unwrap() = Cycle {
                    entries: Vec::new(),
                    estimated: 0,
                    failure: None,
                };
                Ok(())
            })
        }),
        Arc::new(move || {
            let buffer = buffer.clone();
            let manager = manager.clone();
            let id = id.clone();
            Box::pin(async move {
                let mut entries = {
                    let mut cycle = buffer.lock().unwrap();
                    if let Some(error) = &cycle.failure {
                        anyhow::bail!(error.clone());
                    }
                    std::mem::take(&mut cycle.entries)
                };
                for entry in &mut entries {
                    entry
                        .extra
                        .insert("version".into(), json!(env!("CARGO_PKG_VERSION")));
                }
                manager
                    .upgrade()
                    .ok_or_else(|| anyhow::anyhow!("SDK source manager stopped"))?
                    .accept_entries(&id, entries)
                    .await
                    .map_err(anyhow::Error::msg)
            })
        }),
    );
}

type SourceObserver = (Arc<Mutex<Value>>, Arc<Mutex<Option<Arc<InputManager>>>>);

fn run_agent(
    init: Init,
    plan: AgentPlan,
    queue: Arc<Outbox>,
    cancellation: (Arc<AtomicBool>, Arc<AtomicBool>),
    observer: SourceObserver,
    stop: mpsc::Receiver<()>,
    activation: (mpsc::SyncSender<Result<(), String>>, mpsc::Receiver<()>),
) -> anyhow::Result<()> {
    let (cancel, global) = cancellation;
    let (report, metrics) = observer;
    let namespace = plan.namespace();
    let state_dir = init.data_dir.join("sources").join(&namespace);
    source_access::private_path(&state_dir)?;
    std::fs::create_dir_all(&state_dir)?;
    let checkpoint = state_dir.join("input-state.json");
    source_access::private_path(&checkpoint)?;
    let checkpoint_key = plan.checkpoint_key();
    let mut roots = plan
        .sources
        .iter()
        .map(|source| {
            if plan.agent == "codex" {
                source_access::private_path(&source.path)?;
                Ok(source.path.clone())
            } else {
                super::policy::canonical_candidate(&source.path)
            }
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let native_wakeups = if plan.agent == "qwen-work-cn" {
        if let Some(source) = plan
            .sources
            .iter()
            .find(|source| source.kind == "transcript")
        {
            let directory = init.data_dir.join("wakeups/qwen-work-cn");
            source_access::private_path(&directory)?;
            std::fs::create_dir_all(&directory)?;
            source_access::private_path(&directory)?;
            // The full host already has a durable Hook history and cursor. Publish
            // native transcript records to the same source the collector reads.
            let shared_history = plan.pilot_host.as_ref().filter(|host| {
                plan.sources.iter().any(|source| {
                    source.kind == "hook_jsonl"
                        && source.path == host.data_dir.join("logs/qwen-work-cn/history")
                })
            });
            let producer_data_dir = shared_history.map_or_else(
                || state_dir.join("qwen-work-cn-producer"),
                |host| host.data_dir.clone(),
            );
            let history = producer_data_dir.join("logs/qwen-work-cn/history");
            source_access::private_path(&history)?;
            std::fs::create_dir_all(&history)?;
            if shared_history.is_none() {
                let capture = plan.capture_message_content.or_else(|| {
                    plan.pilot_host
                        .as_ref()
                        .and_then(|state| state.capture_message_content)
                });
                let exclusions = plan.pilot_host.as_ref().map_or_else(
                    || plan.exclude_workspaces.clone(),
                    |state| state.exclude_workspaces.clone(),
                );
                let config = json!({"userId":init.user_id,
                "agents":{"qwen-work-cn":{"captureMessageContent":capture.unwrap_or(true)}},
                "privacy":{"excludeWorkspaces":exclusions}});
                write_checkpoint(&producer_data_dir.join("config.json"), &config.to_string())?;
            }
            roots.push(super::policy::canonical_candidate(&directory)?);
            Some(QwenWorkCnNativeWakeups {
                directory,
                pilot_policy_dir: None,
                transcript_root: source.path.clone(),
                producer_data_dir,
                user_id: init.user_id.clone(),
                legacy_cursor_root: plan.pilot_host.as_ref().map(|state| state.data_dir.clone()),
            })
        } else {
            None
        }
    } else {
        None
    };
    if let Some(state) = &plan.pilot_host {
        let agent_roots: &[&str] = match checkpoint_key {
            "codex-transcript" => &[
                "state/codex/transcript-wakeups",
                "state/codex/transcript-span-contexts",
            ],
            "codex-aborted-turn" => &["state/codex/sessions", "logs/diagnostics"],
            "qwen-work-cn-trace" => &["state/hooks", "hooks"],
            "qwen-work-cn-collaboration" => &[],
            _ => &["state/qoder-transcripts/qoder", "logs/qoder"],
        };
        if checkpoint_key == "codex-transcript" {
            if let Some(home) = roots[0].parent() {
                let isolated = home.join("u");
                source_access::private_path(&isolated)?;
                roots.push(isolated);
            }
        }
        for relative in agent_roots
            .iter()
            .copied()
            .chain(["logs/input-state.json", "state/workspace-exclusions"])
        {
            let path = state.data_dir.join(relative);
            if plan.agent == "codex" {
                source_access::private_path(&path)?;
            }
            let path = super::policy::canonical_candidate(&path)?;
            anyhow::ensure!(
                path.starts_with(&state.data_dir),
                "Pilot source {relative} escapes its data directory"
            );
            roots.push(path);
        }
    }
    // Recovery may consult its paired primary collector's Hook markers. Its
    // checkpoint and diagnostics stay within its own SDK-owned namespace.
    let recovery_hook_markers = plan
        .codex_recovery_wakeup_namespace
        .as_ref()
        .map(|namespace| {
            init.data_dir
                .join("sources")
                .join(namespace)
                .join("state/codex/transcript-wakeups")
        });
    if let Some(markers) = &recovery_hook_markers {
        source_access::private_path(markers)?;
        roots.push(markers.clone());
    }
    roots.push(state_dir.canonicalize()?);
    let isolated_codex = checkpoint_key == "codex-transcript";
    let mut scope = SourceScope::new(roots, plan.max_files, plan.max_read_bytes);
    // Linux Codex already runs on a dedicated source runtime. Keep the
    // guarded open and read together there instead of waking a blocking task.
    Arc::get_mut(&mut scope)
        .expect("new source scope")
        .inline_reads = cfg!(target_os = "linux") && isolated_codex;
    scope.set_log(state_dir.join("collector.log"));
    let start_scope = scope.clone();
    source_access::install(Some(scope.clone()));
    // Use only the timer driver. Enabling I/O on Unix initializes Tokio's
    // process-wide signal socket pair, which survives runtime shutdown.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_time()
        .thread_name("pilot-source-io")
        .on_thread_start(move || source_access::install(Some(start_scope.clone())))
        .on_thread_stop(|| source_access::install(None))
        .build()?;
    let shell_handoff = plan.pilot_host.as_ref().and_then(|host| {
        let handoff = LegacyCheckpointHandoff::for_input(checkpoint_key)?;
        let expected = handoff.data_dir(&host.data_dir, checkpoint_key);
        (init.data_dir == expected).then_some((host, handoff))
    });
    let mut preview = if let Some((host, handoff)) = shell_handoff {
        queue.preview_shell_checkpoint(&namespace, handoff, || {
            read_shell_checkpoint(&host.data_dir, checkpoint_key)
        })?
    } else {
        queue.checkpoint_text(&namespace)?
    };
    let replaces_mirror =
        shell_handoff.is_some_and(|(_, handoff)| handoff == LegacyCheckpointHandoff::Codex);
    if let Some(host) = &plan.pilot_host {
        if preview.is_none() && (replaces_mirror || !checkpoint.try_exists()?) {
            preview = runtime.block_on(read_pilot_checkpoint(&host.data_dir, checkpoint_key))?;
        }
    }
    let store = Arc::new(if isolated_codex || plan.agent == "qwen-work-cn" {
        StateStore::new_sdk_source(&checkpoint)
    } else {
        StateStore::new(&checkpoint)
    });
    if let Some(text) = preview.as_deref() {
        store.load_checkpoint_text(text)?;
    }
    // The compatibility mirror is reversible. Complete the actual filesystem
    // operation while the old policy and workers are still active.
    let backup = stage_checkpoint_mirror(&checkpoint, preview.as_deref(), replaces_mirror)?;
    if preview.is_none() && !replaces_mirror {
        runtime.block_on(store.load());
    }
    let (ready, activate) = activation;
    if ready.send(Ok(())).is_err() || activate.recv().is_err() {
        backup.restore(&checkpoint)?;
        return Ok(());
    }
    drop(backup);
    // A replaced worker can advance its cursor during preparation. Start from
    // the latest authoritative SQLite value after it stops, without another mirror write.
    let latest = if let Some((host, handoff)) = shell_handoff {
        queue.prepare_shell_checkpoint(&namespace, handoff, || {
            read_shell_checkpoint(&host.data_dir, checkpoint_key)
        })?
    } else {
        queue.checkpoint_text(&namespace)?
    };
    if let Some(text) = latest
        .as_deref()
        .filter(|text| Some(*text) != preview.as_deref())
    {
        store.load_checkpoint_text(text)?;
    }
    drop((latest, preview));
    let journal = queue.clone();
    let source = namespace.clone();
    // The outbox is authoritative after an interruption. Keep the JSON
    // mirror at activation and shutdown for existing recovery tooling.
    store.set_write_hook(move |_, text| {
        let queue = journal.clone();
        let source = source.clone();
        async move { queue.checkpoint(&source, &text) }
    });
    let flusher = Arc::new(CallbackOutboxFlusher {
        queue: queue.clone(),
        source: namespace.clone(),
        store: store.clone(),
        cancelled: cancel.clone(),
    });
    let manager = Arc::new(InputManager::new());
    manager.set_state_store(store.clone());
    manager.set_mask_config(plan.mask.clone());
    if let Some(state) = &plan.pilot_host {
        manager.set_workspace_policy(
            crate::core::WorkspacePolicy::new(
                &state.exclude_workspaces,
                Some(
                    state
                        .data_dir
                        .join("state/workspace-exclusions")
                        .to_string_lossy()
                        .into_owned(),
                ),
            )
            .map_err(anyhow::Error::msg)?,
        );
    } else if !plan.exclude_workspaces.is_empty() {
        manager.set_workspace_policy(
            crate::core::WorkspacePolicy::new(
                &plan.exclude_workspaces,
                Some(
                    state_dir
                        .join("workspace-exclusions")
                        .to_string_lossy()
                        .into_owned(),
                ),
            )
            .map_err(anyhow::Error::msg)?,
        );
    }
    if let Some(capture_message_content) = plan.capture_message_content.or_else(|| {
        plan.pilot_host
            .as_ref()
            .and_then(|state| state.capture_message_content)
    }) {
        manager.set_agents_config(&crate::types::AgentsConfig::from([(
            plan.agent.clone(),
            crate::types::AgentConfig {
                capture_message_content: Some(capture_message_content),
                ..Default::default()
            },
        )]));
    }
    manager.set_configured_user_id(init.user_id.clone());
    manager.set_flusher(flusher);
    manager.set_intercept_result_linker(Arc::new(crate::core::InterceptResultLinker::new(
        queue.verdicts.clone(),
        true,
    )));
    *metrics.lock().unwrap() = Some(manager.clone());
    let buffer = Arc::new(Mutex::new(Cycle {
        entries: Vec::new(),
        estimated: 0,
        failure: None,
    }));
    let source_path = |kind: &str| {
        plan.sources
            .iter()
            .find(|s| s.kind == kind)
            .map(|s| s.path.to_string_lossy().into_owned())
    };
    let host_path = |relative: &str, embedded: &str| {
        plan.pilot_host
            .as_ref()
            .map_or_else(
                || state_dir.join(embedded),
                |state| state.data_dir.join(relative),
            )
            .to_string_lossy()
            .into_owned()
    };
    let codex_workspace_policy = plan.pilot_host.as_ref().map(|state| {
        crate::inputs::base::WorkspacePolicy::new(
            state.exclude_workspaces.clone(),
            Some(state.data_dir.join("state/workspace-exclusions")),
        )
    });
    let capture_codex = {
        let capture_queue = queue.clone();
        let buffer = buffer.clone();
        move |entries: Vec<AgentActivityEntry>| {
            let limit = capture_queue.options.read().unwrap().queue_memory_bytes;
            let mut cycle = buffer.lock().unwrap();
            if cycle.reserve_batch(&entries, limit) {
                cycle.entries.extend(entries);
            }
        }
    };
    let record_delta = {
        let manager = Arc::downgrade(&manager);
        move |delta: &crate::inputs::base::InputRuntimeDelta| {
            if let Some(manager) = manager.upgrade() {
                manager.record_runtime_delta(checkpoint_key, delta);
            }
        }
    };
    let codex_wakeup = host_path(
        "state/codex/transcript-wakeups",
        "state/codex/transcript-wakeups",
    );
    let input: Arc<LiveInput> = if checkpoint_key == "codex-transcript" {
        let input = Arc::new(CodexTranscriptInput::new(CodexTranscriptInputOptions {
            state_store: store.clone(),
            session_dir: source_path("transcript"),
            wakeup_dir: Some(codex_wakeup.clone()),
            span_context_dir: Some(host_path(
                "state/codex/transcript-span-contexts",
                "state/codex/transcript-span-contexts",
            )),
            poll_interval_ms: Some(plan.poll_interval_ms),
            multimodal: None,
        }));
        if let Some(policy) = codex_workspace_policy {
            input.set_collector_workspace_policy(policy);
        }
        input.bind_owned_collector(capture_codex, record_delta);
        bind(
            &input.inner,
            manager.clone(),
            queue.clone(),
            scope,
            cancel.clone(),
            global.clone(),
            buffer,
        );
        live(
            checkpoint_key,
            "codex",
            input,
            |i| i.collector_running(),
            |i| Box::pin(async move { i.start().await }),
            |i| {
                Box::pin(async move {
                    let _ = i.stop().await;
                })
            },
        )
    } else if checkpoint_key == "codex-aborted-turn" {
        let input = Arc::new(CodexAbortedTurnInput::with_rollout_owner(
            CodexAbortedTurnInputOptions {
                state_store: store.clone(),
                session_dir: source_path("transcript"),
                hook_state_dir: Some(recovery_hook_markers.as_ref().map_or_else(
                    || host_path("state/codex/sessions", "sessions"),
                    |path| path.to_string_lossy().into_owned(),
                )),
                diagnostic_dir: Some(host_path("logs/diagnostics", "diagnostics")),
                hook_gap_grace_ms: None,
                poll_interval_ms: Some(plan.poll_interval_ms),
            },
            recovery_hook_markers.is_some()
                || plan
                    .pilot_host
                    .as_ref()
                    .is_some_and(|host| host.codex_rollout_owns_interrupted_turns),
        ));
        if let Some(policy) = codex_workspace_policy {
            input.set_collector_workspace_policy(policy);
        }
        input.inner.set_owned_entries_handler(capture_codex);
        input.inner.on_runtime_delta(record_delta);
        bind(
            &input.inner,
            manager.clone(),
            queue.clone(),
            scope,
            cancel.clone(),
            global.clone(),
            buffer,
        );
        live(
            checkpoint_key,
            "codex",
            input,
            |i| i.collector_running(),
            |i| Box::pin(async move { i.start().await }),
            |i| {
                Box::pin(async move {
                    let _ = i.stop().await;
                })
            },
        )
    } else if checkpoint_key == "qwen-work-cn-collaboration" {
        let input = Arc::new(QwenWorkCnCollaborationInput::new(
            std::path::PathBuf::from(source_path("collaboration").expect("validated Qwen source")),
            plan.include_conversation_ids.as_deref(),
            store.clone(),
            Some(plan.poll_interval_ms),
        ));
        let policy = plan
            .pilot_host
            .as_ref()
            .map(|state| {
                crate::inputs::base::WorkspacePolicy::new(
                    state.exclude_workspaces.clone(),
                    Some(state.data_dir.join("state/workspace-exclusions")),
                )
            })
            .or_else(|| {
                (!plan.exclude_workspaces.is_empty()).then(|| {
                    crate::inputs::base::WorkspacePolicy::new(
                        plan.exclude_workspaces.clone(),
                        Some(state_dir.join("workspace-exclusions")),
                    )
                })
            });
        if let Some(policy) = policy {
            input.set_collector_workspace_policy(policy);
        }
        input.bind_sdk_collector(capture_codex, record_delta);
        bind(
            &input.0,
            manager.clone(),
            queue.clone(),
            scope,
            cancel.clone(),
            global.clone(),
            buffer,
        );
        live(
            checkpoint_key,
            "qwen-work-cn",
            input,
            |i| i.collector_running(),
            |i| Box::pin(async move { i.start().await }),
            |i| {
                Box::pin(async move {
                    let _ = i.stop().await;
                })
            },
        )
    } else if checkpoint_key == "qwen-work-cn-trace" {
        let input = Arc::new(QwenWorkCnTraceInput::with_flash_databases(
            QwenWorkCnTraceOptions {
                state_store: store.clone(),
                log_dir: Some(source_path("hook_jsonl").unwrap_or_else(|| {
                    native_wakeups
                        .as_ref()
                        .expect("validated Qwen source")
                        .producer_data_dir
                        .join("logs/qwen-work-cn/history")
                        .to_string_lossy()
                        .into_owned()
                })),
                segments_root: Some(source_path("segments").unwrap_or_else(|| {
                    state_dir.join("no-segments").to_string_lossy().into_owned()
                })),
                poll_interval_ms: Some(plan.poll_interval_ms),
                multimodal: None,
            },
            source_path("desktop_database").zip(source_path("flash_database")),
        ));
        if let Some(native) = native_wakeups {
            input.set_native_wakeups(native);
        }
        let input_policy = plan
            .pilot_host
            .as_ref()
            .map(|state| {
                crate::inputs::base::WorkspacePolicy::new(
                    state.exclude_workspaces.clone(),
                    Some(state.data_dir.join("state/workspace-exclusions")),
                )
            })
            .or_else(|| {
                (!plan.exclude_workspaces.is_empty()).then(|| {
                    crate::inputs::base::WorkspacePolicy::new(
                        plan.exclude_workspaces.clone(),
                        Some(state_dir.join("workspace-exclusions")),
                    )
                })
            });
        if let Some(policy) = input_policy {
            input.set_collector_workspace_policy(policy);
        }
        input.bind_sdk_collector(capture_codex, record_delta);
        bind(
            &input.inner,
            manager.clone(),
            queue.clone(),
            scope,
            cancel.clone(),
            global.clone(),
            buffer,
        );
        live(
            checkpoint_key,
            "qwen-work-cn",
            input,
            |i| i.collector_running(),
            |i| Box::pin(async move { i.start().await }),
            |i| {
                Box::pin(async move {
                    let _ = i.stop().await;
                })
            },
        )
    } else {
        let paths = plan
            .sources
            .iter()
            .filter(|s| s.kind == "sqlite")
            .map(|s| s.path.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        use crate::inputs::qoder_trace::prompt_ownership::NativeQoderPromptOwnershipResolver;
        let standalone = plan.pilot_host.is_some();
        let resolver = Arc::new(if standalone {
            NativeQoderPromptOwnershipResolver::default()
        } else {
            NativeQoderPromptOwnershipResolver::with_paths(paths.clone())
        });
        let readers = Arc::new(AuthorizedReaders {
            databases: paths,
            standalone,
            segments: source_path("segments"),
            intercept: source_path("intercept"),
            intercept_index: Default::default(),
        });
        let input =
            Arc::new(QoderTraceInput::new_with_sources(
                QoderTraceOptions {
                    state_store: store.clone(),
                    log_dir: Some(source_path("hook_jsonl").unwrap_or_else(|| {
                        state_dir.join("history").to_string_lossy().into_owned()
                    })),
                    poll_interval_ms: Some(plan.poll_interval_ms),
                    multimodal_enabled: false,
                    upload_mode: None,
                    allowed_root_paths: Vec::new(),
                },
                plan.pilot_host
                    .as_ref()
                    .map_or_else(|| state_dir.clone(), |state| state.data_dir.clone()),
                readers,
                resolver,
            ));
        let captured = buffer.clone();
        let capture_queue = queue.clone();
        let delta_manager = Arc::downgrade(&manager);
        input.inner.set_owned_entries_handler(move |entries| {
            let limit = capture_queue.options.read().unwrap().queue_memory_bytes;
            let mut cycle = captured.lock().unwrap();
            if cycle.reserve_batch(&entries, limit) {
                // Qoder returns a single filtered batch per cycle.
                cycle.entries = entries;
            }
        });
        input.inner.on_runtime_delta(move |delta| {
            if let Some(manager) = delta_manager.upgrade() {
                manager.record_runtime_delta("qoder-trace", delta);
            }
        });
        bind(
            &input.inner,
            manager.clone(),
            queue.clone(),
            scope,
            cancel.clone(),
            global.clone(),
            buffer,
        );
        live(
            "qoder-trace",
            "qoder",
            input.clone(),
            |i| i.collector_running(),
            |i| Box::pin(async move { i.inner.start().await }),
            |i| {
                Box::pin(async move {
                    let _ = i.inner.stop().await;
                })
            },
        )
    };
    let name = input.id.clone();
    manager.register_input(input.clone());
    // Missing Agent sources stay waiting. Do not let a native input's setup
    // create a directory in the Agent installation merely because HCD names it.
    let mut started = false;
    let mut next_start = std::time::Instant::now();
    while !cancel.load(Ordering::SeqCst) && !global.load(Ordering::SeqCst) {
        let available = plan
            .sources
            .iter()
            .filter(|source| {
                matches!(
                    source.kind.as_str(),
                    "hook_jsonl" | "transcript" | "collaboration"
                )
            })
            .any(|source| source.path.exists())
            || (checkpoint_key == "codex-transcript"
                && !started
                && std::time::Instant::now() >= next_start
                && runtime.block_on(CodexTranscriptInput::check_availability(
                    Some(&codex_wakeup),
                    source_path("transcript").as_deref(),
                )))
            || (checkpoint_key == "codex-transcript" && started);
        if !started && available && std::time::Instant::now() >= next_start {
            next_start = std::time::Instant::now()
                + std::time::Duration::from_millis(plan.poll_interval_ms.max(1000));
            match runtime.block_on(input.start()) {
                Ok(()) => {
                    started = true;
                    *report.lock().unwrap() =
                        json!({"state":"running","source_namespace":plan.namespace()});
                }
                Err(error) => {
                    queue.alarm("SDK_SOURCE_START", &error);
                    *report.lock().unwrap() = json!({"state":"waiting","reason":error});
                }
            }
        }
        if !available {
            *report.lock().unwrap() = json!({"state":"waiting","reason":"source_not_found","source_namespace":plan.namespace()});
        } else if store.save_failed() {
            *report.lock().unwrap() = json!({"state":"paused","reason":"source output/checkpoint transaction failed","source_namespace":plan.namespace()});
        } else if started {
            *report.lock().unwrap() =
                json!({"state":"running","source_namespace":plan.namespace()});
        }
        if stop
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_ok()
        {
            break;
        }
    }
    cancel.store(true, Ordering::SeqCst);
    queue.capacity_changed.notify_waiters();
    runtime.block_on(async {
        input.stop().await;
        manager.stop_input(&name).await;
        let _ = store.save().await;
    });
    drop(runtime);
    source_access::install(None);
    queue.restore(&namespace, &checkpoint)?;
    *report.lock().unwrap() = json!({"state":"stopped","source_namespace":namespace});
    Ok(())
}

type SdkFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;
fn live<T: Send + Sync + 'static>(
    id: &str,
    agent: &str,
    input: Arc<T>,
    running: impl Fn(&T) -> bool + Send + Sync + 'static,
    start: impl Fn(Arc<T>) -> SdkFuture<Result<(), String>> + Send + Sync + 'static,
    stop: impl Fn(Arc<T>) -> SdkFuture<()> + Send + Sync + 'static,
) -> Arc<LiveInput> {
    let running_input = input.clone();
    let start_input = input.clone();
    LiveInput::new(
        id,
        agent,
        "sdk-hosted",
        move || running(&running_input),
        move || start(start_input.clone()),
        move || stop(input.clone()),
    )
}

enum MirrorRollback {
    Unchanged,
    Created,
    Restore(tempfile::NamedTempFile),
}

impl MirrorRollback {
    fn restore(self, path: &Path) -> anyhow::Result<()> {
        match self {
            Self::Created => std::fs::remove_file(path)?,
            Self::Restore(saved) => {
                saved.persist(path)?;
            }
            Self::Unchanged => {}
        }
        Ok(())
    }
}

fn stage_checkpoint_mirror(
    path: &Path,
    text: Option<&str>,
    remove_stale: bool,
) -> anyhow::Result<MirrorRollback> {
    let existing = match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            anyhow::ensure!(
                meta.is_file(),
                "checkpoint mirror is not a regular file: {}",
                path.display()
            );
            true
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(err) => return Err(err.into()),
    };
    if text.is_none() && !(existing && remove_stale) {
        return Ok(MirrorRollback::Unchanged);
    }
    let backup = if existing {
        let saved =
            tempfile::NamedTempFile::new_in(path.parent().expect("source state directory"))?;
        std::fs::copy(path, saved.path())?;
        MirrorRollback::Restore(saved)
    } else {
        MirrorRollback::Created
    };
    if let Some(text) = text {
        write_checkpoint(path, text)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(backup)
}

async fn read_pilot_checkpoint(data_dir: &Path, input: &str) -> anyhow::Result<Option<String>> {
    let legacy_path = data_dir.join("logs/input-state.json");
    let body = match source_access::read_to_string(&legacy_path).await {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    filter_shell_checkpoint(&body, input)
}

fn read_shell_checkpoint(data_dir: &Path, input: &str) -> anyhow::Result<Option<String>> {
    use std::io::Read;
    let legacy_path = data_dir.join("logs/input-state.json");
    source_access::private_path(&legacy_path)?;
    let mut file = match source_access::open_under(&legacy_path, data_dir) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(
        file.metadata()?.len() <= 64 * 1024 * 1024,
        "Pilot shell checkpoint exceeds 64 MiB"
    );
    let mut body = String::new();
    file.read_to_string(&mut body)?;
    filter_shell_checkpoint(&body, input)
}

fn filter_shell_checkpoint(body: &str, input: &str) -> anyhow::Result<Option<String>> {
    let mut legacy: serde_json::Map<String, Value> = serde_json::from_str(body)?;
    legacy.retain(|key, _| crate::checkpoints::key_in_namespace(key, input));
    Ok((!legacy.is_empty()).then(|| Value::Object(legacy).to_string()))
}

struct AuthorizedReaders {
    databases: Vec<String>,
    standalone: bool,
    segments: Option<String>,
    intercept: Option<String>,
    intercept_index: tokio::sync::Mutex<crate::inputs::qoder_trace::InterceptTokenIndex>,
}
#[async_trait]
impl QoderTraceReaders for AuthorizedReaders {
    async fn read_cli_intercept(&self) -> crate::inputs::qoder_trace::InterceptData {
        match &self.intercept {
            Some(path) => crate::inputs::qoder_trace::read_intercept_file(path, None).await,
            None => Default::default(),
        }
    }
    async fn read_cli_intercept_for(
        &self,
        ids: &[String],
    ) -> crate::inputs::qoder_trace::InterceptData {
        match &self.intercept {
            Some(path) => {
                self.intercept_index
                    .lock()
                    .await
                    .read_for_responses(path, None, ids)
                    .await
            }
            None => Default::default(),
        }
    }
    async fn read_cli_segments(
        &self,
        session: &str,
        ids: &[String],
    ) -> Vec<crate::inputs::qoder_trace::SegmentTokenData> {
        match &self.segments {
            Some(path) => {
                crate::inputs::qoder_trace::read_segment_tokens_for_session(session, ids, path)
                    .await
            }
            None => Vec::new(),
        }
    }
    async fn read_ide_tokens(
        &self,
        session: &str,
    ) -> crate::inputs::qoder_trace::SqliteTokenResult {
        if self.standalone {
            return crate::inputs::qoder_trace::read_sqlite_tokens_for_session(session).await;
        }
        crate::inputs::qoder_trace::read_sqlite_tokens(session, &self.databases).await
    }
    async fn read_ide_images(
        &self,
        _: &[String],
    ) -> Result<
        std::collections::HashMap<String, crate::inputs::qoder_trace::AttachedImageLookup>,
        String,
    > {
        Ok(Default::default())
    }
}

#[cfg(test)]
#[test]
fn failed_codex_commit_discards_staged_source_before_checkpoint_or_delivery() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let home = root.join("codex");
    let sessions = home.join("sessions");
    let settings = home.join("hooks.json");
    let trust = home.join("config.toml");
    let init: Init = serde_json::from_value(
        json!({"data_dir":root.join("sdk"),"resource_dir":root.join("package"),"codex_home":home}),
    )
    .unwrap();
    let day = sessions.join("2026/08/07");
    std::fs::create_dir_all(&day).unwrap();
    let rollout = "rollout-2026-08-07T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl";
    std::fs::write(day.join(rollout), include_bytes!("../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl")).unwrap();
    std::fs::write(&trust, "model = 'original'\n").unwrap();
    std::fs::create_dir_all(init.resource_dir.join("bin")).unwrap();
    let binary = format!("loongsuite-pilot-sdk-hook{}", std::env::consts::EXE_SUFFIX);
    // Only the executable permission is needed to plan the Hook command.
    std::fs::copy(
        std::env::current_exe().unwrap(),
        init.resource_dir.join("bin").join(binary),
    )
    .unwrap();
    let policy = Policy::parse(
        json!({"agents":["codex"],"hcd":{"agent_configs":{"codex":{
            "collection":{"enabled":true,"profile":"codex_rollout_v1","allowed_roots":[sessions],
                "sources":[{"id":"rollout","type":"transcript","path":sessions}]},
            "hook_deployment":{"channel":"cloud","settings_path":settings}
        }}}}),
        &init,
    )
    .unwrap();
    let queue = Outbox::open(&init.data_dir.join("outbox"), Default::default()).unwrap();
    let namespace = policy.agents["codex"].namespace();
    queue.checkpoint(&namespace, "{}").unwrap();
    let mirror = init
        .data_dir
        .join("sources")
        .join(namespace)
        .join("input-state.json");
    let mut collector = Collector::new(init.clone(), queue.clone(), Default::default());
    for original in [None, Some("{ }\n")] {
        if let Some(text) = original {
            std::fs::write(&mirror, text).unwrap();
        }
        let error =
            collector
                .apply(&policy, || {
                    crate::deployment::reconcile_embedded_codex_hooks(
                        &home,
                        &init.data_dir,
                        &init.resource_dir,
                        Some("cloud"),
                        || {
                            assert!(
                                std::fs::read_to_string(&settings)?.contains("--pilot-sdk-managed")
                            );
                            assert_eq!(std::fs::read_to_string(&mirror)?, "{}");
                            // An external writer restores the original bytes before commit validation.
                            std::fs::write(&trust, "model = 'original'\n")?;
                            Ok(())
                        },
                    )?;
                    Ok(())
                })
                .unwrap_err();
        assert!(format!("{error:#}").contains("提交前"), "{error:#}");
        assert!(!settings.exists());
        assert_eq!(std::fs::read_to_string(&mirror).ok().as_deref(), original);
    }
    assert_eq!(queue.pending_bytes().unwrap(), 0);
    assert_eq!(collector.snapshot(), json!([]));
}

#[cfg(test)]
mod authorized_cache_binding_tests {
    use super::*;
    use crate::utils::source_access::{self, SourceScope};
    use std::io::Write;

    struct RestoreScope(Option<Arc<SourceScope>>);
    impl Drop for RestoreScope {
        fn drop(&mut self) {
            source_access::install(self.0.take());
        }
    }

    #[tokio::test]
    async fn authorized_reader_cache_preserves_fields_late_usage_and_capabilities() {
        let _restore = RestoreScope(source_access::current());
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().canonicalize().unwrap();
        let file = dir.join("intercept.jsonl");
        let ts = chrono::Utc::now().timestamp_millis();
        let row = |id: &str, input: i64, output: i64| json!({"type":"token","ts":ts,"id":id,"prompt_tokens":input,"completion_tokens":output,"cached_tokens":3,"reasoning_tokens":2,"total_tokens":input+output});
        std::fs::write(
            &file,
            format!(
                "{}\n{}\n{}\n",
                json!({"type":"system_prompt","ts":ts,"content":"authorized prompt"}),
                row("selected", 35, 11),
                row("unrelated", 999, 999)
            ),
        )
        .unwrap();
        source_access::install(Some(SourceScope::new(vec![dir.clone()], 1, 1024 * 1024)));
        let readers: Arc<dyn QoderTraceReaders> = Arc::new(AuthorizedReaders {
            databases: Vec::new(),
            standalone: false,
            segments: None,
            intercept: Some(file.to_string_lossy().into_owned()),
            intercept_index: Default::default(),
        });
        let ids = vec!["selected".to_owned()];
        let first = readers.read_cli_intercept_for(&ids).await;
        assert_eq!(
            first.tokens.len(),
            1,
            "the old default trait path would expose unrelated usage"
        );
        assert_eq!(
            (
                first.tokens[0].prompt_tokens,
                first.tokens[0].completion_tokens,
                first.tokens[0].cached_tokens,
                first.tokens[0].reasoning_tokens,
                first.tokens[0].total_tokens
            ),
            (35, 11, 3, 2, 46)
        );
        assert_eq!(
            first.system_prompt.as_ref().unwrap().content,
            "authorized prompt"
        );
        assert_eq!(readers.read_cli_intercept_for(&ids).await, first);
        source_access::install(Some(SourceScope::new(vec![dir.clone()], 1, 1)));
        let denied = readers.read_cli_intercept_for(&ids).await;
        assert!(
            denied.tokens.is_empty() && denied.system_prompt.is_none(),
            "warm cache must not bypass the actual whole-file read budget"
        );
        source_access::install(Some(SourceScope::new(vec![dir], 1, 1024 * 1024)));
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&file)
                .unwrap(),
            "{}",
            row("selected", 40, 13)
        )
        .unwrap();
        let late = readers.read_cli_intercept_for(&ids).await;
        assert_eq!(
            (
                late.tokens[0].prompt_tokens,
                late.tokens[0].completion_tokens,
                late.tokens[0].total_tokens
            ),
            (40, 13, 53)
        );
        assert_eq!(readers.read_cli_intercept().await.tokens.len(), 3);
        assert!(
            file.is_file(),
            "source ownership remains with the Agent/host"
        );
    }
    #[tokio::test]
    async fn actual_collect_requests_all_sessions_response_ids_once() {
        // Reuse qoder_trace_collect_history's initialized Hook JSONL setup.
        // The observing wrapper delegates the new method to the real authorized
        // sidecar reader/index and forbids falling back to the old trait path.
        struct ObservedReaders {
            actual: AuthorizedReaders,
            queries: Mutex<Vec<Vec<String>>>,
        }
        #[async_trait]
        impl QoderTraceReaders for ObservedReaders {
            async fn read_cli_intercept(&self) -> crate::inputs::qoder_trace::InterceptData {
                panic!("collect must invoke read_cli_intercept_for, not the legacy method")
            }
            async fn read_cli_intercept_for(
                &self,
                ids: &[String],
            ) -> crate::inputs::qoder_trace::InterceptData {
                self.queries.lock().unwrap().push(ids.to_vec());
                self.actual.read_cli_intercept_for(ids).await
            }
            async fn read_cli_segments(
                &self,
                _: &str,
                _: &[String],
            ) -> Vec<crate::inputs::qoder_trace::SegmentTokenData> {
                panic!("complete primary usage and valid request/response times need no fallback")
            }
        }
        let _restore = RestoreScope(source_access::current());
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().canonicalize().unwrap();
        let history = dir.join("history");
        std::fs::create_dir_all(&history).unwrap();
        let filename = format!("qoder-{}.jsonl", crate::utils::get_today_date_string());
        let raw = |id: &str,
                   session: &str,
                   turn: &str,
                   name: &str,
                   response: Option<&str>,
                   time: &str| {
            let mut value = json!({"event.id":id,"event.name":name,"gen_ai.session.id":session,
                    "gen_ai.turn.id":turn,"gen_ai.step.id":format!("{turn}:s1"),
                    "gen_ai.agent.type":"qoder-cli","time_unix_nano":time});
            if let Some(response) = response {
                value["gen_ai.response.id"] = json!(response);
            }
            value
        };
        let records = [
            raw(
                "first-request",
                "session-a",
                "turn-a",
                "llm.request",
                None,
                "1780000000000000000",
            ),
            raw(
                "first-response",
                "session-a",
                "turn-a",
                "llm.response",
                Some("response-a"),
                "1780000001000000000",
            ),
            raw(
                "second-request",
                "session-b",
                "turn-b",
                "llm.request",
                None,
                "1780000002000000000",
            ),
            raw(
                "second-response",
                "session-b",
                "turn-b",
                "llm.response",
                Some("response-b-only"),
                "1780000003000000000",
            ),
            raw(
                "second-response-duplicate",
                "session-b",
                "turn-b",
                "llm.response",
                Some("response-b-only"),
                "1780000003000000001",
            ),
        ];
        std::fs::write(
            history.join(&filename),
            records
                .iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let intercept = dir.join("intercept.jsonl");
        let ts = chrono::Utc::now().timestamp_millis();
        let usage = |id: &str, input: i64, output: i64| {
            json!({"type":"token","ts":ts,"id":id,
                "prompt_tokens":input,"completion_tokens":output,"cached_tokens":3,"total_tokens":input+output})
        };
        let sidecar = [
            usage("response-a", 35, 11),
            usage("response-b-only", 70, 9),
            usage("unrelated", 999, 999),
        ];
        std::fs::write(
            &intercept,
            sidecar
                .iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let store = Arc::new(StateStore::new(dir.join("state.json")));
        store.set(
            "qoder-trace",
            crate::checkpoints::InputState::new()
                .with_last_file(filename)
                .with_last_offset(0.0)
                .with_extra(json!({"hookHistoryInitialized":true})),
        );
        source_access::install(Some(SourceScope::new(vec![dir.clone()], 32, 1024 * 1024)));
        let readers = Arc::new(ObservedReaders {
            actual: AuthorizedReaders {
                databases: Vec::new(),
                standalone: false,
                segments: None,
                intercept: Some(intercept.to_string_lossy().into_owned()),
                intercept_index: Default::default(),
            },
            queries: Mutex::new(Vec::new()),
        });
        let input = QoderTraceInput::new_with_sources(QoderTraceOptions {
                state_store: store, log_dir: Some(history.to_string_lossy().into_owned()),
                poll_interval_ms: Some(60000), multimodal_enabled: false,
                upload_mode: None, allowed_root_paths: Vec::new(),
            }, dir.join("native-data"), readers.clone(), Arc::new(
                crate::inputs::qoder_trace::prompt_ownership::NativeQoderPromptOwnershipResolver::with_paths(Vec::new())
            ));
        let entries = input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .unwrap();
        assert_eq!(*readers.queries.lock().unwrap(), vec![vec!["response-a".to_owned(), "response-b-only".to_owned()]],
                "one shared intercept snapshot must include IDs from both sessions and deduplicate repeated response IDs");
        assert_eq!(entries.len(), records.len());
        for (id, session, expected) in [
            (
                "first-response",
                "session-a",
                (Some(35), Some(11), Some(46)),
            ),
            (
                "second-response",
                "session-b",
                (Some(70), Some(9), Some(79)),
            ),
            (
                "second-response-duplicate",
                "session-b",
                (Some(0), Some(0), Some(0)),
            ),
        ] {
            let entry = entries.iter().find(|entry| entry.event_id == id).unwrap();
            assert_eq!(entry.session_id, session);
            assert_eq!(
                (entry.input_tokens, entry.output_tokens, entry.total_tokens),
                expected
            );
        }
        assert_eq!(
            entries
                .iter()
                .filter_map(|entry| entry.total_tokens)
                .sum::<i64>(),
            125,
            "unrelated sidecar usage and duplicate responses must not inflate the batch"
        );
    }
}
