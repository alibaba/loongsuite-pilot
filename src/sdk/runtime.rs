use super::outbox::{CallbackOutboxFlusher, Outbox};
use super::policy::{AgentPlan, Init, Policy};
use crate::checkpoints::StateStore;
use crate::core::{InputManager, LiveInput};
use crate::inputs::base::{HostedInput, InputBody};
use crate::inputs::codex_transcript::{CodexTranscriptInput, CodexTranscriptInputOptions};
use crate::inputs::qoder_trace::{QoderTraceInput, QoderTraceOptions, QoderTraceReaders};
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
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
    report: Arc<Mutex<Value>>,
    metrics: Arc<Mutex<Option<Arc<InputManager>>>>,
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
    pub fn apply(&mut self, policy: &Policy) -> anyhow::Result<()> {
        let delivery_changed = *self.queue.options.read().unwrap() != policy.delivery;
        let removed: Vec<_> = self
            .agents
            .iter()
            .filter(|(id, old)| {
                policy.agents.get(*id) != Some(&old.plan)
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
        for id in removed {
            if let Some(mut old) = self.agents.remove(&id) {
                old.stop();
            }
        }
        self.queue.update(policy.delivery.clone());
        for (id, plan) in &policy.agents {
            if !self.agents.contains_key(id) {
                self.agents.insert(
                    id.clone(),
                    Agent::start(
                        &self.init,
                        plan.clone(),
                        self.queue.clone(),
                        self.global_stop.clone(),
                    )?,
                );
            }
        }
        Ok(())
    }
    pub fn snapshot(&self) -> Value {
        json!(self.agents.iter().map(|(id,agent)|json!({"agent":id,"profile":agent.plan.profile,"status":agent.report.lock().unwrap().clone()})).collect::<Vec<_>>())
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
                        ready_tx,
                    )
                }))
                .unwrap_or_else(|_| Err(anyhow::anyhow!("SDK source task panicked")));
                if let Err(error) = result {
                    queue.alarm("SDK_SOURCE_FAILURE", &error.to_string());
                    *report.lock().unwrap() = json!({"state":"failed","reason":error.to_string()});
                }
            })?;
        // Thread creation/runtime setup, not source availability, is the start
        // barrier. Missing sources remain observable per-agent waiting states.
        if ready_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .is_err()
        {
            cancel.store(true, Ordering::SeqCst);
            let _ = tx.send(());
            let _ = thread.join();
            anyhow::bail!("source runtime failed to initialize");
        }
        Ok(Self {
            plan,
            cancel,
            stop: tx,
            thread: Some(thread),
            report,
            metrics,
        })
    }
    fn stop(&mut self) {
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
fn capture(buffer: &Mutex<Cycle>, entries: &[AgentActivityEntry], limit: usize) {
    let mut cycle = buffer.lock().unwrap();
    // The actual byte limit is enforced on the one serialized representation
    // in the flusher. Bound the pre-serialization source buffer independently.
    let estimate = entries
        .iter()
        .map(|entry| entry.estimated_heap_bytes())
        .sum::<usize>();
    if cycle.estimated.saturating_add(estimate) > limit {
        cycle.failure = Some("source cycle memory limit exceeded; cursor retained".into());
        return;
    }
    cycle.estimated += estimate;
    cycle.entries.extend_from_slice(entries);
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
    ready: mpsc::SyncSender<()>,
) -> anyhow::Result<()> {
    let (cancel, global) = cancellation;
    let (report, metrics) = observer;
    let namespace = plan.namespace();
    let state_dir = init.data_dir.join("sources").join(&namespace);
    source_access::private_path(&state_dir)?;
    std::fs::create_dir_all(&state_dir)?;
    let checkpoint = state_dir.join("input-state.json");
    queue.restore(&namespace, &checkpoint)?;
    let mut roots = plan
        .sources
        .iter()
        .map(|s| super::policy::canonical_candidate(&s.path))
        .collect::<anyhow::Result<Vec<_>>>()?;
    // Resource files and another source's SDK state are not collection
    // capabilities. Inputs only need their own checkpoint/wakeup namespace.
    roots.push(state_dir.canonicalize()?);
    let scope = SourceScope::new(roots, plan.max_files, plan.max_read_bytes);
    scope.set_log(state_dir.join("collector.log"));
    let start_scope = scope.clone();
    source_access::install(Some(scope.clone()));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .thread_name("pilot-source-io")
        .on_thread_start(move || source_access::install(Some(start_scope.clone())))
        .on_thread_stop(|| source_access::install(None))
        .build()?;
    let store = Arc::new(StateStore::new(&checkpoint));
    runtime.block_on(store.load());
    let journal = queue.clone();
    let source = namespace.clone();
    store.set_write_hook(move |path, text| {
        let queue = journal.clone();
        let source = source.clone();
        async move {
            queue.checkpoint(&source, &text)?;
            write_checkpoint(&path, &text)?;
            Ok(())
        }
    });
    let flusher = Arc::new(CallbackOutboxFlusher {
        queue: queue.clone(),
        source: namespace,
        store: store.clone(),
        cancelled: cancel.clone(),
    });
    let manager = Arc::new(InputManager::new());
    manager.set_state_store(store.clone());
    manager.set_mask_config(plan.mask.clone());
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
    let input: Arc<LiveInput> = if plan.agent == "codex" {
        let input = Arc::new(CodexTranscriptInput::new(CodexTranscriptInputOptions {
            state_store: store.clone(),
            session_dir: source_path("transcript"),
            wakeup_dir: Some(state_dir.join("wakeup").to_string_lossy().into_owned()),
            span_context_dir: Some(
                state_dir
                    .join("span-context")
                    .to_string_lossy()
                    .into_owned(),
            ),
            poll_interval_ms: Some(plan.poll_interval_ms),
            multimodal: None,
        }));
        let captured = buffer.clone();
        let capture_queue = queue.clone();
        input.on_entries(move |entries| {
            capture(
                &captured,
                entries,
                capture_queue.options.read().unwrap().queue_memory_bytes,
            )
        });
        let delta_manager = Arc::downgrade(&manager);
        input.inner.on_runtime_delta(move |delta| {
            if let Some(manager) = delta_manager.upgrade() {
                manager.record_runtime_delta("codex-transcript", delta);
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
            "codex-transcript",
            "codex",
            input.clone(),
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
        let resolver=Arc::new(crate::inputs::qoder_trace::prompt_ownership::NativeQoderPromptOwnershipResolver::with_paths(paths.clone()));
        let readers = Arc::new(AuthorizedReaders {
            databases: paths,
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
                state_dir.clone(),
                readers,
                resolver,
            ));
        let captured = buffer.clone();
        let capture_queue = queue.clone();
        let delta_manager = Arc::downgrade(&manager);
        input.bind_collector(
            move |entries| {
                capture(
                    &captured,
                    entries,
                    capture_queue.options.read().unwrap().queue_memory_bytes,
                )
            },
            move |delta| {
                if let Some(manager) = delta_manager.upgrade() {
                    manager.record_runtime_delta("qoder-trace", delta);
                }
            },
        );
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
    let _ = ready.send(());
    let mut started = false;
    let mut next_start = std::time::Instant::now();
    while !cancel.load(Ordering::SeqCst) && !global.load(Ordering::SeqCst) {
        let available = plan
            .sources
            .iter()
            .filter(|source| matches!(source.kind.as_str(), "hook_jsonl" | "transcript"))
            .any(|source| source.path.exists());
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
    *report.lock().unwrap() = json!({"state":"stopped"});
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

fn write_checkpoint(path: &Path, text: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("checkpoint parent"))?;
    source_access::private_path(path)?;
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(text.as_bytes())?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    Ok(())
}
struct AuthorizedReaders {
    databases: Vec<String>,
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
