//! Input lifecycle and the entry pipeline. Port of `input-manager.ts`.
//!
//! Registered collectors are `LiveInput` handles. The manager enriches, masks,
//! and forwards batches in per-input order.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Local;
use tokio::sync::{watch, Mutex as AsyncMutex};

use crate::flushers::BaseFlusher;
use crate::inputs::base::InputRuntimeDelta;
use crate::mask::{load_mask_plan, mask_agent_activity_entry, MaskPlan, PlanOrRules};
use crate::metrics::{AlarmContext, AlarmManager};
use crate::multimodal::MultimodalProcessor;
use crate::normalization::{
    apply_invocation_identity, enrich_canonical_entries_with_git, expand_agent_input_events,
    TurnBoundaryProcessor,
};
use crate::types::{AgentActivityEntry, AgentsConfig, MaskConfig, MaskMode, MaskReplacementMode};
use crate::utils::format_time;

use super::intercept_result_linker::InterceptResultLinker;
use super::upstream_link::TraceLinker;
use super::workspace_policy::WorkspacePolicy;
use super::{fields, logger};

pub type BoxFuture<T> = Pin<Box<dyn std::future::Future<Output = T> + Send>>;
type RuntimeProbe = Arc<dyn Fn() -> crate::inputs::base::InputRuntimeInfo + Send + Sync>;

#[derive(Debug, Clone)]
pub struct InputCounter {
    pub source_kind: &'static str,
    pub raw_read_calls: u64,
    pub raw_read_bytes: u64,
    pub raw_in_records: u64,
    pub raw_in_bytes: u64,
    pub raw_in_max_batch_bytes: u64,
    pub raw_in_max_record_bytes: u64,
    pub raw_backlog_bytes_max: u64,
    pub parse_success_records: u64,
    pub parse_failed_records: u64,
    pub read_duration_ms: f64,
    pub process_duration_ms: f64,
    pub in_events: u64,
    pub in_bytes: u64,
    pub out_events: u64,
    pub out_failed: u64,
    pub last_poll_time: String,
    pub start_time: String,
    pub collection_method: String,
    pub agent_type: String,
    pub last_active_time: u128,
}

pub struct LiveInput {
    pub id: String,
    pub agent_type: String,
    pub collection_method: String,
    running: Arc<dyn Fn() -> bool + Send + Sync>,
    start: Arc<dyn Fn() -> BoxFuture<Result<(), String>> + Send + Sync>,
    stop: Arc<dyn Fn() -> BoxFuture<()> + Send + Sync>,
    runtime_probe: Mutex<Option<RuntimeProbe>>,
}

impl LiveInput {
    pub fn new(
        id: impl Into<String>,
        agent_type: impl Into<String>,
        collection_method: impl Into<String>,
        running: impl Fn() -> bool + Send + Sync + 'static,
        start: impl Fn() -> BoxFuture<Result<(), String>> + Send + Sync + 'static,
        stop: impl Fn() -> BoxFuture<()> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            id: id.into(),
            agent_type: agent_type.into(),
            collection_method: collection_method.into(),
            running: Arc::new(running),
            start: Arc::new(start),
            stop: Arc::new(stop),
            runtime_probe: Mutex::new(None),
        })
    }

    /// Current scheduler/source facts, when exposed by the concrete collector.
    pub fn runtime_info(&self) -> Option<crate::inputs::base::InputRuntimeInfo> {
        let probe = self.runtime_probe.lock().expect("runtime probe").clone();
        probe.map(|probe| probe())
    }

    pub(crate) fn set_runtime_probe(
        &self,
        probe: impl Fn() -> crate::inputs::base::InputRuntimeInfo + Send + Sync + 'static,
    ) {
        *self.runtime_probe.lock().expect("runtime probe") = Some(Arc::new(probe));
    }

    pub fn running(&self) -> bool {
        (self.running)()
    }

    pub async fn start(&self) -> Result<(), String> {
        (self.start)().await
    }

    pub async fn stop(&self) {
        (self.stop)().await;
    }
}

struct QueueGate {
    output_owner: &'static str,
    lock: AsyncMutex<()>,
    inflight: AtomicUsize,
    cancellation: Mutex<Option<watch::Sender<bool>>>,
}

struct QueueActivity(Arc<QueueGate>);

impl Drop for QueueActivity {
    fn drop(&mut self) {
        self.0.inflight.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn wait_output_cancellation(mut receiver: watch::Receiver<bool>) {
    loop {
        let stopped = *receiver.borrow_and_update();
        if stopped {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

type FlushListener = Arc<dyn Fn(usize, u64) + Send + Sync>;

pub struct InputManager {
    inputs: Mutex<HashMap<String, Arc<LiveInput>>>,
    counters: Mutex<HashMap<String, InputCounter>>,
    queues: Mutex<HashMap<String, Arc<QueueGate>>>,
    flusher: Mutex<Option<Arc<dyn BaseFlusher>>>,
    state_store: Mutex<Option<Arc<crate::checkpoints::StateStore>>>,
    alarm_manager: Mutex<Option<Arc<AlarmManager>>>,
    user_id: Mutex<String>,
    configured_user_id: Mutex<String>,
    mask_config: Mutex<MaskConfig>,
    mask_plan: Mutex<MaskPlan>,
    trace_linker: Mutex<Option<Arc<TraceLinker>>>,
    intercept_linker: Mutex<Option<Arc<InterceptResultLinker>>>,
    multimodal: Mutex<Option<Arc<MultimodalProcessor>>>,
    turn_boundary: Mutex<TurnBoundaryProcessor>,
    workspace_policy: Mutex<WorkspacePolicy>,
    flushed: Mutex<Vec<FlushListener>>,
}

impl InputManager {
    pub fn new() -> Self {
        Self {
            inputs: Mutex::new(HashMap::new()),
            counters: Mutex::new(HashMap::new()),
            queues: Mutex::new(HashMap::new()),
            flusher: Mutex::new(None),
            state_store: Mutex::new(None),
            alarm_manager: Mutex::new(None),
            user_id: Mutex::new(String::new()),
            configured_user_id: Mutex::new(String::new()),
            mask_config: Mutex::new(MaskConfig {
                mode: MaskMode::None,
                types: Vec::new(),
                replacement_mode: Some(MaskReplacementMode::Placeholder),
            }),
            mask_plan: Mutex::new(load_mask_plan(&MaskConfig {
                mode: MaskMode::None,
                types: Vec::new(),
                replacement_mode: Some(MaskReplacementMode::Placeholder),
            })),
            trace_linker: Mutex::new(None),
            intercept_linker: Mutex::new(None),
            multimodal: Mutex::new(None),
            turn_boundary: Mutex::new(TurnBoundaryProcessor::new()),
            workspace_policy: Mutex::new(
                WorkspacePolicy::new(&[], None).expect("empty workspace policy"),
            ),
            flushed: Mutex::new(Vec::new()),
        }
    }

    pub fn set_workspace_policy(&self, policy: WorkspacePolicy) {
        *self.workspace_policy.lock().expect("policy") = policy;
    }

    pub fn set_state_store(&self, store: Arc<crate::checkpoints::StateStore>) {
        *self.state_store.lock().expect("state store") = Some(store);
    }

    pub fn set_flusher(&self, flusher: Arc<dyn BaseFlusher>) {
        *self.flusher.lock().expect("flusher") = Some(flusher);
    }

    pub fn set_alarm_manager(&self, alarm_manager: Arc<AlarmManager>) {
        *self.alarm_manager.lock().expect("alarm") = Some(alarm_manager);
    }

    pub fn set_user_id(&self, user_id: impl Into<String>) {
        *self.user_id.lock().expect("user") = user_id.into();
    }

    pub fn set_configured_user_id(&self, user_id: impl Into<String>) {
        *self.configured_user_id.lock().expect("configured") = user_id.into();
    }

    /// Retained for callers. Per-agent content opt-outs are ignored.
    pub fn set_agents_config(&self, _config: &AgentsConfig) {}

    pub fn set_mask_config(&self, config: MaskConfig) {
        *self.mask_plan.lock().expect("plan") = load_mask_plan(&config);
        *self.mask_config.lock().expect("mask") = config;
    }

    pub(crate) fn trace_linker(&self) -> Option<Arc<TraceLinker>> {
        self.trace_linker.lock().expect("trace").clone()
    }

    pub fn set_trace_linker(&self, linker: Arc<TraceLinker>) {
        *self.trace_linker.lock().expect("trace") = Some(linker);
    }

    pub fn set_intercept_result_linker(&self, linker: Arc<InterceptResultLinker>) {
        *self.intercept_linker.lock().expect("intercept") = Some(linker);
    }

    pub fn set_multimodal_processor(&self, processor: Arc<MultimodalProcessor>) {
        let mut slot = self.multimodal.lock().expect("multimodal");
        if let Some(existing) = slot.as_ref() {
            if !Arc::ptr_eq(existing, &processor) {
                logger("InputManager").warn(
                    "multimodal processor already set; ignoring replacement",
                    None,
                );
                return;
            }
        }
        *slot = Some(processor);
    }

    /// Share the initialized processor with inputs that resolve local image paths.
    pub fn multimodal_processor(&self) -> Option<Arc<MultimodalProcessor>> {
        self.multimodal.lock().expect("multimodal").clone()
    }

    /// Actual usable multimodal origin; delegated discovery may still be waiting.
    pub fn multimodal_storage_base_path(&self) -> Option<String> {
        let processor = self.multimodal.lock().expect("multimodal").clone();
        processor.and_then(|processor| processor.storage_base_path())
    }

    pub fn on_flushed(&self, listener: impl Fn(usize, u64) + Send + Sync + 'static) {
        self.flushed
            .lock()
            .expect("flushed")
            .push(Arc::new(listener));
    }

    pub fn register_input(&self, input: Arc<LiveInput>) {
        if self.inputs.lock().expect("inputs").contains_key(&input.id) {
            logger("InputManager").warn(
                "input already registered",
                Some(&fields(serde_json::json!({ "id": input.id }))),
            );
            return;
        }
        self.counters.lock().expect("counters").insert(
            input.id.clone(),
            empty_counter(&input.collection_method, &input.agent_type),
        );
        self.queues.lock().expect("queues").insert(
            input.id.clone(),
            Arc::new(QueueGate {
                output_owner: if crate::utils::normalize_agent_type(&input.agent_type) == "codex" {
                    "Codex"
                } else {
                    "Doubao Work"
                },
                lock: AsyncMutex::new(()),
                inflight: AtomicUsize::new(0),
                cancellation: Mutex::new(
                    matches!(
                        crate::utils::normalize_agent_type(&input.agent_type).as_str(),
                        "codex" | "doubao-work"
                    )
                    .then(|| watch::channel(false).0),
                ),
            }),
        );
        let id = input.id.clone();
        self.inputs
            .lock()
            .expect("inputs")
            .insert(id.clone(), input);
        logger("InputManager").info(
            "input registered",
            Some(&fields(serde_json::json!({ "id": id }))),
        );
    }

    fn output_hold(
        &self,
        input_id: &str,
        gate: &QueueGate,
    ) -> Result<Option<crate::checkpoints::CheckpointOutputHold>, String> {
        if gate.cancellation.lock().expect("cancellation").is_none() {
            return Ok(None);
        }
        let store = self.state_store.lock().expect("state store").clone();
        let Some(store) = store else {
            return Ok(None);
        };
        if store.save_failed_for(input_id) {
            return Err(format!(
                "{} checkpoint is frozen after output failure",
                gate.output_owner
            ));
        }
        Ok(Some(store.begin_output_for(input_id)))
    }

    async fn queued_entries(
        &self,
        id: &str,
        entries: Vec<AgentActivityEntry>,
        gate: &QueueGate,
    ) -> Result<(), String> {
        let cancellation = gate
            .cancellation
            .lock()
            .expect("cancellation")
            .as_ref()
            .map(watch::Sender::subscribe);
        let processing = async {
            let _guard = gate.lock.lock().await;
            self.handle_entries(id, entries).await
        };
        if let Some(receiver) = cancellation {
            tokio::select! {
                biased;
                _=wait_output_cancellation(receiver)=>Err(format!("{} output acceptance cancelled", gate.output_owner)),
                result=processing=>result,
            }
        } else {
            processing.await
        }
    }

    pub fn bind_entries(self: &Arc<Self>, input_id: &str, entries: Vec<AgentActivityEntry>) {
        let Some(gate) = self.queues.lock().expect("queues").get(input_id).cloned() else {
            return;
        };
        let hold = match self.output_hold(input_id, &gate) {
            Ok(hold) => hold,
            Err(_) => return,
        };
        let id = input_id.to_owned();
        let manager = Arc::clone(self);
        gate.inflight.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            let activity = QueueActivity(Arc::clone(&gate));
            let result = manager.queued_entries(&id, entries, &gate).await;
            if let Err(error) = &result {
                logger("InputManager").error(
                    "entry handling failed",
                    Some(&fields(serde_json::json!({"inputId":id,"error":error}))),
                );
            }
            if let Some(hold) = hold {
                hold.finish(result);
            }
            drop(activity);
        });
    }

    /// Await the same ordered, cancellable acceptance path used by collectors.
    pub async fn accept_entries(
        &self,
        input_id: &str,
        entries: Vec<AgentActivityEntry>,
    ) -> Result<(), String> {
        let gate = self
            .queues
            .lock()
            .expect("queues")
            .get(input_id)
            .cloned()
            .ok_or_else(|| format!("unknown input {input_id}"))?;
        let hold = self.output_hold(input_id, &gate)?;
        gate.inflight.fetch_add(1, Ordering::SeqCst);
        let activity = QueueActivity(Arc::clone(&gate));
        let result = self.queued_entries(input_id, entries, &gate).await;
        if let Some(hold) = hold {
            hold.finish(result.clone());
        }
        drop(activity);
        result
    }

    pub fn cancel_pending_outputs(&self) {
        for gate in self.queues.lock().expect("queues").values() {
            if let Some(sender) = gate.cancellation.lock().expect("cancellation").as_ref() {
                sender.send_replace(true);
            }
        }
    }

    pub fn prepare_restored_entries(
        &self,
        entries: Vec<AgentActivityEntry>,
    ) -> Vec<AgentActivityEntry> {
        self.apply_mask(self.filter_workspace(entries, "codex"))
    }

    pub fn record_runtime_delta(&self, input_id: &str, delta: &InputRuntimeDelta) {
        let mut counters = self.counters.lock().expect("counters");
        let Some(counter) = counters.get_mut(input_id) else {
            return;
        };
        let count = |value: u64| value;
        counter.raw_read_calls += count(delta.raw_read_calls);
        counter.raw_read_bytes += count(delta.raw_read_bytes);
        counter.raw_in_records += count(delta.raw_in_records);
        counter.raw_in_bytes += count(delta.raw_in_bytes);
        counter.raw_in_max_batch_bytes = counter
            .raw_in_max_batch_bytes
            .max(count(delta.raw_in_max_batch_bytes));
        counter.raw_in_max_record_bytes = counter
            .raw_in_max_record_bytes
            .max(count(delta.raw_in_max_record_bytes));
        counter.raw_backlog_bytes_max = counter
            .raw_backlog_bytes_max
            .max(count(delta.raw_backlog_bytes_max));
        counter.parse_success_records += count(delta.parse_success_records);
        counter.parse_failed_records += count(delta.parse_failed_records);
        counter.read_duration_ms += if delta.read_duration_ms.is_finite() {
            delta.read_duration_ms.max(0.0)
        } else {
            0.0
        };
        counter.process_duration_ms += if delta.process_duration_ms.is_finite() {
            delta.process_duration_ms.max(0.0)
        } else {
            0.0
        };
    }

    pub async fn start_input(&self, id: &str) {
        let input = self.inputs.lock().expect("inputs").get(id).cloned();
        let Some(input) = input else {
            logger("InputManager").warn(
                "cannot start unknown input",
                Some(&fields(serde_json::json!({ "id": id }))),
            );
            return;
        };
        if let Some(gate) = self.queues.lock().expect("queues").get(id) {
            let mut slot = gate.cancellation.lock().expect("cancellation");
            if slot.as_ref().is_some_and(|sender| *sender.borrow()) {
                *slot = Some(watch::channel(false).0);
            }
        }
        if let Err(err) = input.start().await {
            logger("InputManager").warn(
                "input start failed",
                Some(&fields(serde_json::json!({ "id": id, "error": err }))),
            );
            return;
        }
        logger("InputManager").info(
            "input started",
            Some(&fields(serde_json::json!({ "id": id }))),
        );
    }

    pub async fn stop_input(&self, id: &str) {
        let input = self.inputs.lock().expect("inputs").get(id).cloned();
        let Some(input) = input else { return };
        if let Some(gate) = self.queues.lock().expect("queues").get(id) {
            if let Some(sender) = gate.cancellation.lock().expect("cancellation").as_ref() {
                sender.send_replace(true);
            }
        }
        input.stop().await;
        self.drain_input(id).await;
        logger("InputManager").info(
            "input stopped",
            Some(&fields(serde_json::json!({ "id": id }))),
        );
    }

    pub async fn stop_all(&self) {
        self.cancel_pending_outputs();
        let inputs: Vec<Arc<LiveInput>> = self
            .inputs
            .lock()
            .expect("inputs")
            .values()
            .cloned()
            .collect();
        for input in inputs {
            if input.running() {
                input.stop().await;
            }
        }
        self.drain_all().await;
        let processor = self.multimodal.lock().expect("multimodal").take();
        if let Some(processor) = processor {
            // Supervise this subsystem boundary so an unexpected uploader task
            // panic cannot abort the rest of collector shutdown.
            let shutdown = crate::multimodal::http::spawn_with_http_context(async move {
                processor.shutdown(30_000).await;
            });
            if let Err(error) = shutdown.await {
                logger("InputManager").warn(
                    "multimodal processor shutdown failed",
                    Some(&fields(serde_json::json!({"error":error.to_string()}))),
                );
            }
        }
    }

    async fn drain_input(&self, id: &str) {
        loop {
            let gate = self.queues.lock().expect("queues").get(id).cloned();
            let Some(gate) = gate else { return };
            let _guard = gate.lock.lock().await;
            if gate.inflight.load(Ordering::SeqCst) == 0 {
                return;
            }
        }
    }

    async fn drain_all(&self) {
        let ids: Vec<String> = self
            .queues
            .lock()
            .expect("queues")
            .keys()
            .cloned()
            .collect();
        for id in ids {
            self.drain_input(&id).await;
        }
    }

    pub fn get_input(&self, id: &str) -> Option<Arc<LiveInput>> {
        self.inputs.lock().expect("inputs").get(id).cloned()
    }

    pub fn get_input_counters(&self) -> HashMap<String, InputCounter> {
        self.counters.lock().expect("counters").clone()
    }

    pub fn take_input_counter_snapshot(&self) -> HashMap<String, InputCounter> {
        let mut counters = self.counters.lock().expect("counters");
        let mut snapshot = HashMap::new();
        for (id, counter) in counters.iter_mut() {
            snapshot.insert(id.clone(), counter.clone());
            counter.raw_in_max_batch_bytes = 0;
            counter.raw_in_max_record_bytes = 0;
            counter.raw_backlog_bytes_max = 0;
        }
        snapshot
    }

    pub fn get_active_input_ids(&self) -> Vec<String> {
        self.inputs
            .lock()
            .expect("inputs")
            .iter()
            .filter(|(_, input)| input.running())
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn get_input_idle_minutes(&self, id: &str) -> i64 {
        let counters = self.counters.lock().expect("counters");
        let Some(counter) = counters.get(id) else {
            return -1;
        };
        if counter.last_active_time == 0 {
            return -1;
        }
        let now = now_ms();
        ((now.saturating_sub(counter.last_active_time)) / 60_000) as i64
    }

    pub fn mark_input_started(&self, id: &str) {
        let mut counters = self.counters.lock().expect("counters");
        if let Some(counter) = counters.get_mut(id) {
            if counter.start_time.is_empty() {
                counter.start_time = format_time(Local::now());
            }
        }
    }

    pub async fn flush_prepared_entries(
        &self,
        entries: Vec<AgentActivityEntry>,
    ) -> Result<(), String> {
        if entries.is_empty() {
            return Ok(());
        }
        // Interceptor-originated records are an output path too. Preflight
        // the whole native-session batch before identity rewriting or masking.
        let mut entries = self.filter_workspace(entries, "interceptor");
        if entries.is_empty() {
            return Ok(());
        }
        if crate::utils::source_access::current().is_none() {
            enrich_canonical_entries_with_git(&mut entries).await;
        }
        self.apply_identity(&mut entries);
        let prepared = self.apply_mask(entries);
        self.dispatch_entries("interceptor", prepared).await
    }

    async fn handle_entries(
        &self,
        input_id: &str,
        mut entries: Vec<AgentActivityEntry>,
    ) -> Result<(), String> {
        let agent = self
            .inputs
            .lock()
            .expect("inputs")
            .get(input_id)
            .map(|input| input.agent_type.clone())
            .unwrap_or_default();
        entries = self.filter_workspace(entries, &agent);
        if entries.is_empty() {
            return Ok(());
        }
        if let Some(linker) = self.intercept_linker.lock().expect("intercept").clone() {
            linker.enrich(&mut entries);
        }
        if crate::utils::source_access::current().is_none() {
            enrich_canonical_entries_with_git(&mut entries).await;
        }
        if let Some(counter) = self.counters.lock().expect("counters").get_mut(input_id) {
            counter.in_events += entries.len() as u64;
            for entry in &entries {
                counter.in_bytes += crate::utils::json_size::serialized_json_size(entry)
                    .map(|bytes| bytes as u64)
                    .unwrap_or(0);
            }
            counter.last_poll_time = format_time(Local::now());
            counter.last_active_time = now_ms();
            if counter.start_time.is_empty() {
                counter.start_time = format_time(Local::now());
            }
        }
        let trace_linker = self.trace_linker.lock().expect("trace").clone();
        if let Some(linker) = trace_linker {
            linker.stamp(&mut entries).await;
        }
        self.apply_identity(&mut entries);
        self.enrich_turn_boundaries_fail_open(&mut entries);
        let expanded = expand_agent_input_events(self.apply_mask(entries));
        logger("InputManager").info(
            "dispatching entries",
            Some(&fields(
                serde_json::json!({ "inputId": input_id, "count": expanded.len() }),
            )),
        );
        self.dispatch_entries(input_id, expanded).await
    }

    fn enrich_turn_boundaries_fail_open(&self, entries: &mut [AgentActivityEntry]) {
        // This derived stage may mutate only the two boundary flags. Keep a
        // small rollback journal instead of cloning potentially large payloads.
        let before: Vec<_> = entries
            .iter()
            .map(|entry| (entry.turn_start, entry.turn_end))
            .collect();
        let enriched = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.turn_boundary.lock().expect("turns").enrich(entries);
        }));
        if enriched.is_err() {
            for (entry, (start, end)) in entries.iter_mut().zip(before) {
                entry.turn_start = start;
                entry.turn_end = end;
            }
            // Do not retain partially updated derived turn state after a panic.
            let mut processor = self
                .turn_boundary
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            *processor = TurnBoundaryProcessor::new();
            self.turn_boundary.clear_poison();
            logger("InputManager").warn("turn boundary enrichment failed (skipped)", None);
        }
    }

    fn filter_workspace(
        &self,
        entries: Vec<AgentActivityEntry>,
        agent: &str,
    ) -> Vec<AgentActivityEntry> {
        let mut policy = self.workspace_policy.lock().expect("policy");
        if !policy.enabled() {
            return entries;
        }
        let maps: Vec<serde_json::Map<String, serde_json::Value>> = entries
            .iter()
            .filter_map(|entry| match serde_json::to_value(entry) {
                Ok(serde_json::Value::Object(map)) => Some(map),
                _ => None,
            })
            .collect();
        let kept = policy.filter(&maps, agent);
        kept.into_iter()
            .filter_map(|map| serde_json::from_value(serde_json::Value::Object(map)).ok())
            .collect()
    }

    fn apply_identity(&self, entries: &mut [AgentActivityEntry]) {
        let configured = self.configured_user_id.lock().expect("configured").clone();
        let user = self.user_id.lock().expect("user").clone();
        for entry in entries {
            apply_invocation_identity(entry, &configured, &user);
        }
    }

    fn apply_mask(&self, entries: Vec<AgentActivityEntry>) -> Vec<AgentActivityEntry> {
        let plan = self.mask_plan.lock().expect("plan").clone();
        if plan.rules.is_empty() && plan.pii_types.is_empty() {
            return entries;
        }
        let config = self.mask_config.lock().expect("mask").clone();
        entries
            .into_iter()
            .map(|entry| {
                mask_agent_activity_entry(&entry, &config, Some(PlanOrRules::Plan(&plan)), None)
                    .into_owned()
            })
            .collect()
    }

    async fn dispatch_entries(
        &self,
        input_id: &str,
        entries: Vec<AgentActivityEntry>,
    ) -> Result<(), String> {
        let encoded = entries
            .iter()
            .map(serde_json::to_vec)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let batch_bytes = encoded.iter().map(|row| row.len() as u64).sum();
        let flusher = self.flusher.lock().expect("flusher").clone();
        let Some(flusher) = flusher else {
            logger("InputManager").warn(
                "no flusher set, dropping entries",
                Some(&fields(serde_json::json!({ "count": entries.len() }))),
            );
            if let Some(alarm) = self.alarm_manager.lock().expect("alarm").clone() {
                alarm.record(
                    "DISPATCH_DROP_ALARM",
                    "3",
                    &format!(
                        "dropped {} entries from {input_id}: no flusher",
                        entries.len()
                    ),
                    Some(AlarmContext {
                        input_name: Some(input_id.to_string()),
                        endpoint_name: None,
                    }),
                );
            }
            return Ok(());
        };
        let entry_count = entries.len();
        let alarm_manager = self.alarm_manager.lock().expect("alarm").clone();
        let alarm_input = input_id.to_owned();
        let quota_alarm = Arc::new(move |endpoint: &str, error: &crate::flushers::FlushError| {
            let message =
                format!("Codex pending journal is full, retaining source checkpoint: {error}");
            logger("InputManager").warn(&message, None);
            if let Some(manager) = &alarm_manager {
                manager.record(
                    "FLUSH_QUOTA_ALARM",
                    "3",
                    &message,
                    Some(AlarmContext {
                        input_name: Some(alarm_input.clone()),
                        endpoint_name: Some(endpoint.to_owned()),
                    }),
                );
            }
        });
        match flusher
            .deliver_prepared_batch(entries, encoded, quota_alarm)
            .await
        {
            Ok(()) => {
                if let Some(counter) = self.counters.lock().expect("counters").get_mut(input_id) {
                    counter.out_events += entry_count as u64;
                }
                for listener in self.flushed.lock().expect("flushed").iter() {
                    listener(entry_count, batch_bytes);
                }
                Ok(())
            }
            Err(err) => {
                if let Some(counter) = self.counters.lock().expect("counters").get_mut(input_id) {
                    counter.out_failed += entry_count as u64;
                }
                logger("InputManager").error(
                    "dispatch failed",
                    Some(&fields(
                        serde_json::json!({ "count": entry_count, "error": err.to_string() }),
                    )),
                );
                Err(err.to_string())
            }
        }
    }
}

impl Default for InputManager {
    fn default() -> Self {
        Self::new()
    }
}

fn empty_counter(collection_method: &str, agent_type: &str) -> InputCounter {
    InputCounter {
        source_kind: "primary",
        raw_read_calls: 0,
        raw_read_bytes: 0,
        raw_in_records: 0,
        raw_in_bytes: 0,
        raw_in_max_batch_bytes: 0,
        raw_in_max_record_bytes: 0,
        raw_backlog_bytes_max: 0,
        parse_success_records: 0,
        parse_failed_records: 0,
        read_duration_ms: 0.0,
        process_duration_ms: 0.0,
        in_events: 0,
        in_bytes: 0,
        out_events: 0,
        out_failed: 0,
        last_poll_time: String::new(),
        start_time: String::new(),
        collection_method: collection_method.to_string(),
        agent_type: agent_type.to_string(),
        last_active_time: 0,
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flushers::FlushError;
    use async_trait::async_trait;

    struct MemFlusher {
        entries: Mutex<Vec<AgentActivityEntry>>,
        fail: bool,
    }

    #[async_trait]
    impl BaseFlusher for MemFlusher {
        fn name(&self) -> &str {
            "mem"
        }
        async fn send(
            &self,
            entry: AgentActivityEntry,
            _logical_bytes: Option<f64>,
        ) -> Result<(), FlushError> {
            self.send_batch(vec![entry], None).await
        }
        async fn send_batch(
            &self,
            entries: Vec<AgentActivityEntry>,
            _logical_bytes: Option<Vec<f64>>,
        ) -> Result<(), FlushError> {
            if self.fail {
                return Err(FlushError::new("nope"));
            }
            self.entries.lock().unwrap().extend(entries);
            Ok(())
        }
        async fn flush(&self) -> Result<(), FlushError> {
            Ok(())
        }
        async fn shutdown(&self) -> Result<(), FlushError> {
            Ok(())
        }
    }

    fn manager() -> InputManager {
        let manager = InputManager::new();
        manager.register_input(LiveInput::new(
            "cursor-hook",
            "cursor",
            "hook-jsonl",
            || true,
            || Box::pin(async { Ok(()) }),
            || Box::pin(async {}),
        ));
        manager.set_configured_user_id("configured");
        manager.set_flusher(Arc::new(MemFlusher {
            entries: Mutex::new(Vec::new()),
            fail: false,
        }));
        manager
    }

    #[tokio::test]
    async fn fills_configured_user_and_counts_egress() {
        let manager = manager();
        manager
            .accept_entries(
                "cursor-hook",
                vec![AgentActivityEntry {
                    event_name: Some(crate::types::AgentEventName::Other),
                    agent_type: "cursor".into(),
                    ..AgentActivityEntry::default()
                }],
            )
            .await
            .unwrap();
        let counters = manager.get_input_counters();
        assert_eq!(counters["cursor-hook"].in_events, 1);
        assert_eq!(counters["cursor-hook"].out_events, 1);
        assert_eq!(counters["cursor-hook"].collection_method, "hook-jsonl");
        assert_eq!(counters["cursor-hook"].agent_type, "cursor");
    }

    #[test]
    fn duplicate_registration_is_ignored() {
        let manager = InputManager::new();
        let input = LiveInput::new(
            "qoder",
            "qoder",
            "hook-jsonl",
            || false,
            || Box::pin(async { Ok(()) }),
            || Box::pin(async {}),
        );
        manager.register_input(Arc::clone(&input));
        let other = LiveInput::new(
            "qoder",
            "cursor",
            "different-fixture",
            || false,
            || Box::pin(async { Ok(()) }),
            || Box::pin(async {}),
        );
        manager.register_input(other);
        assert!(Arc::ptr_eq(&manager.get_input("qoder").unwrap(), &input));
        assert_eq!(manager.get_input("qoder").unwrap().agent_type, "qoder");
        assert_eq!(manager.get_input_counters().len(), 1);
    }

    #[tokio::test]
    async fn drops_entries_when_no_flusher_is_set() {
        let manager = InputManager::new();
        manager.register_input(LiveInput::new(
            "qoder",
            "qoder",
            "hook-jsonl",
            || false,
            || Box::pin(async { Ok(()) }),
            || Box::pin(async {}),
        ));
        let alarm = Arc::new(AlarmManager::new("127.0.0.1", "test", "user"));
        manager.set_alarm_manager(Arc::clone(&alarm));
        manager
            .accept_entries("qoder", vec![AgentActivityEntry::default()])
            .await
            .unwrap();
        assert_eq!(manager.get_input_counters()["qoder"].out_events, 0);
    }
}

#[cfg(test)]
mod migration_pipeline_tests {
    use super::*;
    use crate::flushers::{FlushError, MultiFlusher};
    use crate::normalization::{
        derive_agent_input_event_id, INVOCATION_SESSION_ID_FIELD, INVOCATION_USER_ID_FIELD,
    };
    use crate::types::{AgentEventName, GuardrailAction};
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::sync::{Notify, Semaphore};

    #[derive(Clone)]
    pub(super) struct Batch {
        entries: Vec<AgentActivityEntry>,
        bytes: Option<Vec<f64>>,
    }
    pub(super) struct Sink {
        batches: Mutex<Vec<Batch>>,
        fail: AtomicBool,
        gate: Option<Arc<Semaphore>>,
        entered: Notify,
    }
    impl Sink {
        pub(super) fn new() -> Arc<Self> {
            Arc::new(Self {
                batches: Mutex::new(Vec::new()),
                fail: AtomicBool::new(false),
                gate: None,
                entered: Notify::new(),
            })
        }
    }
    #[async_trait]
    impl BaseFlusher for Sink {
        fn name(&self) -> &str {
            "captured"
        }
        async fn send(
            &self,
            entry: AgentActivityEntry,
            bytes: Option<f64>,
        ) -> Result<(), FlushError> {
            self.send_batch(vec![entry], bytes.map(|b| vec![b])).await
        }
        async fn send_batch(
            &self,
            entries: Vec<AgentActivityEntry>,
            bytes: Option<Vec<f64>>,
        ) -> Result<(), FlushError> {
            self.entered.notify_one();
            if let Some(gate) = &self.gate {
                gate.acquire().await.unwrap().forget();
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err(FlushError::new("synthetic rejection"));
            }
            self.batches.lock().unwrap().push(Batch { entries, bytes });
            Ok(())
        }
        async fn flush(&self) -> Result<(), FlushError> {
            Ok(())
        }
        async fn shutdown(&self) -> Result<(), FlushError> {
            Ok(())
        }
    }
    pub(super) struct Control {
        running: AtomicBool,
        starts: AtomicUsize,
        stops: AtomicUsize,
    }
    pub(super) fn register(manager: &InputManager, id: &str, agent: &str) -> Arc<Control> {
        let state = Arc::new(Control {
            running: AtomicBool::new(false),
            starts: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
        });
        let (running, start, stop) = (state.clone(), state.clone(), state.clone());
        manager.register_input(LiveInput::new(
            id,
            agent,
            "hook-jsonl",
            move || running.running.load(Ordering::SeqCst),
            move || {
                let state = start.clone();
                Box::pin(async move {
                    state.starts.fetch_add(1, Ordering::SeqCst);
                    state.running.store(true, Ordering::SeqCst);
                    Ok(())
                })
            },
            move || {
                let state = stop.clone();
                Box::pin(async move {
                    state.stops.fetch_add(1, Ordering::SeqCst);
                    state.running.store(false, Ordering::SeqCst);
                })
            },
        ));
        state
    }
    pub(super) fn entry(id: &str, event: AgentEventName) -> AgentActivityEntry {
        AgentActivityEntry {
            time_unix_nano: "1700000000000000000".into(),
            event_id: id.into(),
            event_name: Some(event),
            agent_type: "cursor".into(),
            session_id: "native-session".into(),
            turn_id: Some("turn".into()),
            step_id: Some("step".into()),
            ..AgentActivityEntry::default()
        }
    }
    pub(super) fn all_mask() -> MaskConfig {
        MaskConfig {
            mode: MaskMode::All,
            types: Vec::new(),
            replacement_mode: Some(MaskReplacementMode::Placeholder),
        }
    }
    pub(super) fn flattened(sink: &Sink) -> Vec<AgentActivityEntry> {
        sink.batches
            .lock()
            .unwrap()
            .iter()
            .flat_map(|b| b.entries.clone())
            .collect()
    }

    #[test]
    fn raw_runtime_counters_sum_independently_and_reset_only_window_maxima() {
        let manager = InputManager::new();
        register(&manager, "raw", "qoder");
        for delta in [
            InputRuntimeDelta {
                source_kind: "primary",
                raw_read_calls: 2,
                raw_read_bytes: 180,
                raw_in_records: 3,
                raw_in_bytes: 120,
                raw_in_max_batch_bytes: 80,
                raw_in_max_record_bytes: 50,
                raw_backlog_bytes_max: 120,
                parse_success_records: 2,
                parse_failed_records: 1,
                read_duration_ms: 1.5,
                process_duration_ms: 2.5,
            },
            InputRuntimeDelta {
                source_kind: "primary",
                raw_read_calls: 1,
                raw_read_bytes: 40,
                raw_in_records: 2,
                raw_in_bytes: 40,
                raw_in_max_batch_bytes: 40,
                raw_in_max_record_bytes: 20,
                raw_backlog_bytes_max: 40,
                parse_success_records: 2,
                parse_failed_records: 0,
                read_duration_ms: 0.5,
                process_duration_ms: 1.5,
            },
        ] {
            manager.record_runtime_delta("raw", &delta);
        }
        let counter = manager.get_input_counters()["raw"].clone();
        assert_eq!(
            (
                counter.raw_read_calls,
                counter.raw_read_bytes,
                counter.raw_in_records,
                counter.raw_in_bytes
            ),
            (3, 220, 5, 160)
        );
        assert_eq!(
            (
                counter.raw_in_max_batch_bytes,
                counter.raw_in_max_record_bytes,
                counter.raw_backlog_bytes_max
            ),
            (80, 50, 120)
        );
        assert_eq!(
            (counter.parse_success_records, counter.parse_failed_records),
            (4, 1)
        );
        assert_eq!(
            (counter.read_duration_ms, counter.process_duration_ms),
            (2.0, 4.0)
        );
        assert_eq!((counter.in_events, counter.in_bytes), (0, 0));
        let first = manager.take_input_counter_snapshot();
        let second = manager.take_input_counter_snapshot();
        assert_eq!(
            (
                first["raw"].raw_in_max_batch_bytes,
                first["raw"].raw_backlog_bytes_max
            ),
            (80, 120)
        );
        assert_eq!(
            (
                second["raw"].raw_in_max_batch_bytes,
                second["raw"].raw_in_max_record_bytes,
                second["raw"].raw_backlog_bytes_max
            ),
            (0, 0, 0)
        );
        assert_eq!(second["raw"].raw_in_bytes, 160);
        assert_eq!(counter.collection_method, "hook-jsonl");
        assert_eq!(counter.agent_type, "qoder");
    }

    #[tokio::test]
    async fn identity_precedence_is_applied_through_dispatch_and_consumes_transport_overrides() {
        for (native, configured, fallback, expected) in [
            ("", "", "fallback", "fallback"),
            ("native", "", "fallback", "native"),
            ("", "configured", "fallback", "configured"),
            ("native", "configured", "fallback", "configured"),
        ] {
            let manager = InputManager::new();
            register(&manager, "identity", "cursor");
            let sink = Sink::new();
            manager.set_flusher(sink.clone());
            manager.set_user_id(fallback);
            manager.set_configured_user_id(configured);
            let mut record = entry("identity", AgentEventName::Other);
            record.user_id = native.into();
            manager
                .accept_entries("identity", vec![record])
                .await
                .unwrap();
            let received = flattened(&sink);
            assert_eq!(received.len(), 1);
            assert_eq!(received[0].user_id, expected);
            assert!(
                serde_json::to_value(&received[0]).unwrap()["attributes"]["identity"].is_null()
            );
        }
        let manager = InputManager::new();
        register(&manager, "identity", "cursor");
        let sink = Sink::new();
        manager.set_flusher(sink.clone());
        manager.set_user_id("fallback");
        manager.set_configured_user_id("configured");
        let mut record = entry("override", AgentEventName::Other);
        record.user_id = "native".into();
        record.extra.insert(
            INVOCATION_SESSION_ID_FIELD.into(),
            json!("customer-session"),
        );
        record
            .extra
            .insert(INVOCATION_USER_ID_FIELD.into(), json!("customer-user"));
        manager
            .accept_entries("identity", vec![record])
            .await
            .unwrap();
        let received = flattened(&sink);
        assert_eq!(received[0].session_id, "customer-session");
        assert_eq!(received[0].user_id, "customer-user");
        assert!(!received[0].extra.contains_key(INVOCATION_SESSION_ID_FIELD));
        assert!(!received[0].extra.contains_key(INVOCATION_USER_ID_FIELD));
    }

    #[tokio::test]
    async fn queued_batches_stay_ordered_and_shutdown_waits_for_non_codex_acceptance() {
        let manager = Arc::new(InputManager::new());
        let control = register(&manager, "ordered", "cursor");
        let gate = Arc::new(Semaphore::new(0));
        let sink = Arc::new(Sink {
            batches: Mutex::new(Vec::new()),
            fail: AtomicBool::new(false),
            gate: Some(gate.clone()),
            entered: Notify::new(),
        });
        manager.set_flusher(sink.clone());
        manager.start_input("ordered").await;
        manager.bind_entries("ordered", vec![entry("first", AgentEventName::Other)]);
        tokio::time::timeout(Duration::from_secs(1), sink.entered.notified())
            .await
            .unwrap();
        manager.bind_entries("ordered", vec![entry("second", AgentEventName::Other)]);
        let stopping = {
            let manager = manager.clone();
            tokio::spawn(async move { manager.stop_all().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!stopping.is_finished());
        assert_eq!(control.stops.load(Ordering::SeqCst), 1);
        gate.add_permits(2);
        tokio::time::timeout(Duration::from_secs(1), stopping)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            flattened(&sink)
                .iter()
                .map(|e| e.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert_eq!(sink.batches.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn whole_batch_privacy_preflight_precedes_identity_and_fanout() {
        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private");
        let manager = InputManager::new();
        register(&manager, "privacy", "cursor");
        manager.set_workspace_policy(
            WorkspacePolicy::new(&[private.to_string_lossy().into_owned()], None).unwrap(),
        );
        let sinks = [Sink::new(), Sink::new(), Sink::new()];
        manager.set_flusher(Arc::new(MultiFlusher::new(
            sinks
                .iter()
                .map(|s| s.clone() as Arc<dyn BaseFlusher>)
                .collect(),
        )));
        let mut early = entry("early-private", AgentEventName::Other);
        early.session_id = "denied".into();
        early
            .extra
            .insert(INVOCATION_SESSION_ID_FIELD.into(), json!("customer"));
        let mut denied = early.clone();
        denied.event_id = "late-private".into();
        denied
            .extra
            .insert("workspace.path".into(), json!(private.join("app")));
        let mut public = entry("public", AgentEventName::Other);
        public.session_id = "allowed".into();
        public
            .extra
            .insert(INVOCATION_SESSION_ID_FIELD.into(), json!("customer"));
        manager
            .accept_entries("privacy", vec![early, public, denied])
            .await
            .unwrap();
        for sink in sinks {
            let rows = flattened(&sink);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].event_id, "public");
            assert_eq!(rows[0].session_id, "customer");
        }
    }

    #[tokio::test]
    async fn dual_write_masks_before_expansion_and_fans_out_identical_boundaries_and_serialized_sizes(
    ) {
        let manager = InputManager::new();
        register(&manager, "dual", "cursor");
        manager.set_mask_config(all_mask());
        let agents: AgentsConfig =
            serde_json::from_value(json!({"cursor":{"captureMessageContent":false}})).unwrap();
        manager.set_agents_config(&agents);
        let sinks = [Sink::new(), Sink::new(), Sink::new()];
        manager.set_flusher(Arc::new(MultiFlusher::new(
            sinks
                .iter()
                .map(|s| s.clone() as Arc<dyn BaseFlusher>)
                .collect(),
        )));
        let flushed = Arc::new(Mutex::new(Vec::new()));
        let slot = flushed.clone();
        manager.on_flushed(move |count, bytes| slot.lock().unwrap().push((count, bytes)));
        let key = format!("AKIA{}", "IOSFODNN7EXAMPLE");
        let mut source = entry("input-other", AgentEventName::Other);
        source.input_messages_delta = Some(json!([{"role":"user","content":format!("use {key}")}]));
        let original = source.clone();
        manager.accept_entries("dual", vec![source]).await.unwrap();
        let expected_ids = vec![
            "input-other".to_owned(),
            derive_agent_input_event_id("input-other"),
        ];
        let mut baseline = None;
        for sink in sinks {
            let batches = sink.batches.lock().unwrap();
            assert_eq!(batches.len(), 1);
            let batch = &batches[0];
            assert_eq!(
                batch
                    .entries
                    .iter()
                    .map(|e| e.event_id.clone())
                    .collect::<Vec<_>>(),
                expected_ids
            );
            assert_eq!(batch.entries[0].event_name, Some(AgentEventName::Other));
            assert_eq!(
                batch.entries[1].event_name,
                Some(AgentEventName::AgentInput)
            );
            assert_eq!(batch.entries[0].turn_start, Some(true));
            assert_eq!(batch.entries[1].turn_start, None);
            assert_eq!(batch.entries[1].turn_end, None);
            let encoded = serde_json::to_string(&batch.entries).unwrap();
            assert!(encoded.contains("[ACCESSKEY_MASKED]"));
            assert!(!encoded.contains(&key));
            let mut comparable: Vec<_> = batch
                .entries
                .iter()
                .map(|e| serde_json::to_value(e).unwrap())
                .collect();
            for value in &mut comparable {
                for field in [
                    "event.id",
                    "event.name",
                    "gen_ai.turn.start",
                    "gen_ai.turn.end",
                ] {
                    value.as_object_mut().unwrap().remove(field);
                }
            }
            assert_eq!(comparable[0], comparable[1]);
            let expected_sizes: Vec<_> = batch
                .entries
                .iter()
                .map(|e| serde_json::to_vec(e).unwrap().len() as f64)
                .collect();
            assert_eq!(batch.bytes.as_ref().unwrap(), &expected_sizes);
            if let Some(expected) = &baseline {
                assert_eq!(&encoded, expected);
            } else {
                baseline = Some(encoded);
            }
        }
        assert_eq!(original.event_name, Some(AgentEventName::Other));
        assert_eq!(original.event_id, "input-other");
        assert!(serde_json::to_string(&original).unwrap().contains(&key));
        let counters = manager.get_input_counters();
        assert_eq!(
            (
                counters["dual"].in_events,
                counters["dual"].out_events,
                counters["dual"].out_failed
            ),
            (1, 2, 0)
        );
        let first = sink_from_encoded(baseline.as_ref().unwrap());
        let bytes = first
            .iter()
            .map(|e| serde_json::to_vec(e).unwrap().len() as u64)
            .sum::<u64>();
        assert_eq!(*flushed.lock().unwrap(), vec![(2, bytes)]);
    }
    fn sink_from_encoded(text: &str) -> Vec<AgentActivityEntry> {
        serde_json::from_str(text).unwrap()
    }

    #[tokio::test]
    async fn non_input_metadata_is_not_copied_and_failed_expanded_batch_counts_both_records() {
        let manager = InputManager::new();
        register(&manager, "metadata", "cursor");
        let sink = Sink::new();
        manager.set_flusher(sink.clone());
        manager
            .accept_entries("metadata", vec![entry("metadata", AgentEventName::Other)])
            .await
            .unwrap();
        assert_eq!(flattened(&sink).len(), 1);
        assert_eq!(flattened(&sink)[0].event_id, "metadata");
        let manager = InputManager::new();
        register(&manager, "failure", "cursor");
        let sink = Sink::new();
        sink.fail.store(true, Ordering::SeqCst);
        manager.set_flusher(sink.clone());
        let mut source = entry("failure", AgentEventName::Other);
        source.input_messages_delta = Some(json!([{"role":"user","content":"hello"}]));
        assert!(manager
            .accept_entries("failure", vec![source])
            .await
            .is_err());
        let counter = &manager.get_input_counters()["failure"];
        assert_eq!(
            (counter.in_events, counter.out_events, counter.out_failed),
            (1, 0, 2)
        );
    }

    #[tokio::test]
    async fn tool_verdicts_join_native_identity_before_invocation_rewrite() {
        use crate::interceptor::{
            ToolInterceptPhase, ToolVerdictAction, ToolVerdictKey, ToolVerdictStore,
        };
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(ToolVerdictStore::new(
            directory.path().join("verdicts.json"),
        ));
        for (phase, action) in [
            (ToolInterceptPhase::PreToolUse, ToolVerdictAction::Allow),
            (ToolInterceptPhase::PostToolUse, ToolVerdictAction::Block),
        ] {
            store.put(
                &ToolVerdictKey {
                    session_id: Some("native-session".into()),
                    tool_use_id: "call-1".into(),
                    phase,
                },
                action,
                chrono::Utc::now().timestamp_millis(),
            );
        }
        let manager = InputManager::new();
        register(&manager, "tools", "qoder");
        manager.set_intercept_result_linker(Arc::new(InterceptResultLinker::new(store, true)));
        manager.set_configured_user_id("installer");
        let sink = Sink::new();
        manager.set_flusher(sink.clone());
        let mut entries = vec![
            entry("call", AgentEventName::ToolCall),
            entry("result", AgentEventName::ToolResult),
            entry("missing", AgentEventName::ToolCall),
        ];
        for (index, entry) in entries.iter_mut().enumerate() {
            entry.agent_type = "qoder".into();
            entry
                .extra
                .insert(INVOCATION_SESSION_ID_FIELD.into(), json!("customer"));
            if index < 2 {
                entry.tool_call_id = Some("call-1".into());
            }
        }
        manager.accept_entries("tools", entries).await.unwrap();
        let rows = flattened(&sink);
        assert_eq!(rows[0].guardrail_action, Some(GuardrailAction::Allow));
        assert_eq!(rows[0].guardrail_triggered, Some(true));
        assert_eq!(rows[1].guardrail_action, Some(GuardrailAction::Block));
        assert_eq!(rows[1].guardrail_triggered, Some(true));
        assert_eq!(rows[2].guardrail_action, None);
        assert_eq!(rows[2].guardrail_triggered, None);
        assert!(rows
            .iter()
            .all(|e| e.session_id == "customer" && e.user_id == "installer"));
    }

    #[tokio::test]
    async fn lifecycle_proxies_known_ids_ignores_unknowns_and_stops_every_running_input() {
        let manager = InputManager::new();
        let first = register(&manager, "first", "cursor");
        let second = register(&manager, "second", "qoder");
        manager.start_input("unknown").await;
        manager.stop_input("unknown").await;
        assert_eq!(
            (
                first.starts.load(Ordering::SeqCst),
                first.stops.load(Ordering::SeqCst)
            ),
            (0, 0)
        );
        manager.start_input("first").await;
        manager.start_input("second").await;
        assert_eq!(
            (
                first.starts.load(Ordering::SeqCst),
                second.starts.load(Ordering::SeqCst)
            ),
            (1, 1)
        );
        manager.stop_input("first").await;
        assert_eq!(first.stops.load(Ordering::SeqCst), 1);
        manager.stop_all().await;
        assert_eq!(first.stops.load(Ordering::SeqCst), 1);
        assert_eq!(second.stops.load(Ordering::SeqCst), 1);
        assert!(manager.get_active_input_ids().is_empty());
    }
}

#[cfg(test)]
mod migration_content_mask_tests {
    use super::migration_pipeline_tests::{all_mask, entry, flattened, register, Sink};
    use super::*;
    use crate::flushers::MultiFlusher;
    use crate::types::AgentEventName;
    use serde_json::json;

    #[tokio::test]
    async fn legacy_and_canonical_content_masking_preserves_non_content_fields_across_every_sink() {
        let key = format!("AKIA{}", "IOSFODNN7EXAMPLE");
        let api = format!("sk-{}", "1234567890abcdefghijklmnop");
        let phone = "13800138000";
        for variant in ["native-input", "legacy-input", "native-output"] {
            let manager = InputManager::new();
            register(&manager, "mask", "cursor");
            manager.set_mask_config(all_mask());
            let agents: AgentsConfig =
                serde_json::from_value(json!({"cursor":{"captureMessageContent":false}})).unwrap();
            manager.set_agents_config(&agents);
            let sinks = [Sink::new(), Sink::new(), Sink::new()];
            manager.set_flusher(Arc::new(MultiFlusher::new(
                sinks
                    .iter()
                    .map(|s| s.clone() as Arc<dyn BaseFlusher>)
                    .collect(),
            )));
            let mut source = entry(variant, AgentEventName::Other);
            match variant {
                "native-input" => {
                    source.input_messages =
                        Some(json!([{"role":"user","content":format!("use {key}")}]));
                    source.extra.insert(
                        "workspace.current_root".into(),
                        json!(format!("/tmp/{key}")),
                    );
                }
                "legacy-input" => {
                    source.extra.insert(
                        "input.messages".into(),
                        json!([{"role":"user","content":api}]),
                    );
                }
                _ => {
                    source.output_messages = Some(
                        json!([{"role":"assistant","content":format!("apiKey={api} phone={phone}")}]),
                    );
                }
            }
            manager.accept_entries("mask", vec![source]).await.unwrap();
            for sink in sinks {
                let rows = flattened(&sink);
                let row = serde_json::to_value(&rows[0]).unwrap();
                match variant {
                    "native-input" => {
                        assert_eq!(
                            row["gen_ai.input.messages"],
                            json!([{"role":"user","content":"use [ACCESSKEY_MASKED]"}])
                        );
                        assert_eq!(row["workspace.current_root"], format!("/tmp/{key}"));
                    }
                    "legacy-input" => {
                        assert_eq!(
                            row["input.messages"],
                            json!([{"role":"user","content":"[APIKEY_MASKED]"}])
                        );
                        assert!(!row.to_string().contains(&api));
                    }
                    _ => {
                        let text = row.to_string();
                        assert!(text.contains("[APIKEY_MASKED]"));
                        assert!(text.contains("[PHONE_MASKED]"));
                        assert!(!text.contains(&api));
                        assert!(!text.contains(phone));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod migration_remaining_contracts {
    use super::migration_pipeline_tests::{all_mask, entry, flattened, register, Sink};
    use super::*;
    use crate::checkpoints::StateStore;
    use crate::flushers::{FlushError, FlushErrorKind, MultiFlusher};
    use crate::inputs::base::{HostedInput, InputBody, InputRuntime};
    use crate::types::{AgentEventName, ClientType, CollectionMethod, GuardrailAction};
    use async_trait::async_trait;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tokio::sync::{Notify, Semaphore};

    struct EmitsOnce(AtomicBool);
    #[async_trait]
    impl InputBody for EmitsOnce {
        fn id(&self) -> &str {
            "bound-fixture"
        }
        fn agent_type(&self) -> ClientType {
            ClientType::Qoder
        }
        fn collection_method(&self) -> CollectionMethod {
            CollectionMethod::HookJsonl
        }
        async fn collect(&self, _: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
            if self.0.swap(true, Ordering::SeqCst) {
                return Ok(Vec::new());
            }
            let mut event = entry("actual-hosted-event", AgentEventName::Other);
            event.agent_type = "input-manager-fixture".into();
            Ok(vec![event])
        }
    }

    #[tokio::test]
    async fn hosted_entries_subscription_reaches_actual_manager_queue_and_flusher() {
        let root = tempfile::tempdir().unwrap();
        let manager = Arc::new(InputManager::new());
        let source = HostedInput::new(
            EmitsOnce(AtomicBool::new(false)),
            "BoundFixture",
            Arc::new(StateStore::new(root.path().join("source.json"))),
            Some(300_000),
        );
        let (running, start, stop) = (source.clone(), source.clone(), source.clone());
        manager.register_input(LiveInput::new(
            "bound-fixture",
            "input-manager-fixture",
            "hook-jsonl",
            move || running.running(),
            move || {
                let source = start.clone();
                Box::pin(async move { source.start().await })
            },
            move || {
                let source = stop.clone();
                Box::pin(async move {
                    source.stop().await.unwrap();
                })
            },
        ));
        let output = Sink::new();
        manager.set_flusher(output.clone());
        let receiver = manager.clone();
        source.on_entries(move |batch| receiver.bind_entries("bound-fixture", batch.to_vec()));
        manager.start_input("bound-fixture").await;
        tokio::time::timeout(Duration::from_secs(3), manager.stop_all())
            .await
            .unwrap();
        assert!(!source.running());
        let rows = flattened(&output);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event_id, "actual-hosted-event");
        assert_eq!(manager.get_input_counters()["bound-fixture"].in_events, 1);
        assert_eq!(manager.get_input_counters()["bound-fixture"].out_events, 1);
    }

    #[tokio::test]
    async fn all_codex_completion_interrupt_and_subagent_paths_receive_workspace_context() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("workspace");
        std::fs::create_dir(&cwd).unwrap();
        let manager = InputManager::new();
        register(&manager, "codex-transcript", "codex");
        let output = Sink::new();
        manager.set_flusher(output.clone());
        let mut rows = Vec::new();
        for status in ["completed", "interrupted", "subagent"] {
            let mut row = entry(status, AgentEventName::Other);
            row.agent_type = "codex".into();
            row.git_repo = Some("synthetic/repo".into());
            row.git_branch = Some("synthetic-branch".into());
            row.extra.insert("agent.codex.cwd".into(), json!(cwd));
            if status == "subagent" {
                row.extra
                    .insert("gen_ai.agent.scope".into(), json!("subagent"));
            } else {
                row.extra
                    .insert("agent.codex.turn_status".into(), json!(status));
            }
            rows.push(row);
        }
        manager
            .accept_entries("codex-transcript", rows)
            .await
            .unwrap();
        let rows = flattened(&output);
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows.iter()
                .map(|row| row.event_id.as_str())
                .collect::<Vec<_>>(),
            ["completed", "interrupted", "subagent"]
        );
        assert!(rows
            .iter()
            .all(|row| row.workspace_path.as_deref() == cwd.to_str()));
    }

    #[tokio::test]
    async fn native_correlation_precedes_invocation_identity_and_metadata_cannot_consume_it() {
        use crate::core::{CorrelationStore, TraceLinker};
        use crate::normalization::INVOCATION_SESSION_ID_FIELD;
        let root = tempfile::tempdir().unwrap();
        let native = "native-fixture-session";
        let customer = "customer-fixture-session";
        let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
        let span = "00f067aa0ba902b7";
        std::fs::write(root.path().join(format!("{native}.jsonl")),
            json!({"type":"session","sessionId":native,"traceparent":format!("00-{trace}-{span}-01")}).to_string()+"\n").unwrap();
        let decoy=json!({"type":"session","sessionId":customer,"traceparent":"00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-cccccccccccccccc-01"}).to_string()+"\n";
        std::fs::write(root.path().join(format!("{customer}.jsonl")), &decoy).unwrap();
        let manager = InputManager::new();
        register(&manager, "linked", "opencode");
        manager.set_trace_linker(Arc::new(TraceLinker::with_retry(
            CorrelationStore::new(root.path()),
            0,
            0,
        )));
        let output = Sink::new();
        manager.set_flusher(output.clone());
        let mut metadata = entry("metadata", AgentEventName::Other);
        metadata.agent_type = "opencode".into();
        metadata.session_id = native.into();
        metadata.turn_id = Some(format!("{native}:t1"));
        metadata.trace_id = Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into());
        metadata
            .extra
            .insert(INVOCATION_SESSION_ID_FIELD.into(), json!(customer));
        manager
            .accept_entries("linked", vec![metadata.clone()])
            .await
            .unwrap();
        let dispatched = flattened(&output);
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].session_id, customer);
        assert_eq!(
            dispatched[0].trace_id.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(dispatched[0].parent_span_id, None);
        assert!(!dispatched[0]
            .extra
            .contains_key(INVOCATION_SESSION_ID_FIELD));
        assert!(!root
            .path()
            .join(format!("{native}.session-context.done"))
            .exists());
        let preserved =
            std::fs::read_to_string(root.path().join(format!("{native}.jsonl"))).unwrap();
        let record: serde_json::Value = serde_json::from_str(preserved.trim()).unwrap();
        assert_eq!(record["traceparent"], format!("00-{trace}-{span}-01"));
        let mut input = metadata;
        input.event_id = "input".into();
        input.input_messages_delta = Some(
            json!([{"role":"user","parts":[{"type":"text","content":"synthetic input evidence"}]}]),
        );
        manager.accept_entries("linked", vec![input]).await.unwrap();
        let rows = flattened(&output);
        let linked = rows.iter().find(|row| row.event_id == "input").unwrap();
        assert_eq!(linked.session_id, customer);
        assert_eq!(linked.trace_id.as_deref(), Some(trace));
        assert_eq!(linked.parent_span_id.as_deref(), Some(span));
        assert!(root
            .path()
            .join(format!("{native}.session-context.done"))
            .is_file());
        assert!(!linked.extra.contains_key(INVOCATION_SESSION_ID_FIELD));
        assert_eq!(
            std::fs::read_to_string(root.path().join(format!("{customer}.jsonl"))).unwrap(),
            decoy
        );
    }

    #[tokio::test]
    async fn legacy_content_setting_preserves_every_legacy_field_across_inputs_and_destinations() {
        for configured in [None, Some(false), Some(true)] {
            let manager = InputManager::new();
            for id in ["cursor-hook", "cursor-sqlite"] {
                register(&manager, id, "cursor");
            }
            if let Some(value) = configured {
                let agents: AgentsConfig =
                    serde_json::from_value(json!({"cursor":{"captureMessageContent":value}}))
                        .unwrap();
                manager.set_agents_config(&agents);
            }
            let sinks = [Sink::new(), Sink::new(), Sink::new()];
            manager.set_flusher(Arc::new(MultiFlusher::new(
                sinks
                    .iter()
                    .map(|sink| sink.clone() as Arc<dyn BaseFlusher>)
                    .collect(),
            )));
            for id in ["cursor-hook", "cursor-sqlite"] {
                let mut source = entry(id, AgentEventName::Other);
                source.input_messages = Some(
                    json!([{"role":"user","parts":[{"type":"text","content":format!("{id} canonical prompt")}]}]),
                );
                source.input_messages_delta = source.input_messages.clone();

                source.extra.insert(
                    "input.messages".into(),
                    json!([{"role":"user","content":format!("{id} prompt")}]),
                );
                source.extra.insert(
                    "output.messages".into(),
                    json!([{"type":"text","content":"synthetic response"}]),
                );
                source.extra.insert(
                    "tool.result.payload".into(),
                    json!({"output":"synthetic tool output"}),
                );
                source
                    .extra
                    .insert("content".into(), json!("synthetic legacy source"));
                source
                    .extra
                    .insert("inlineDiffMessage".into(), json!("synthetic diff"));
                manager.accept_entries(id, vec![source]).await.unwrap();
            }
            for sink in sinks {
                let rows = flattened(&sink);
                assert_eq!(rows.len(), 4);
                for (pair, id) in rows
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .zip(["cursor-hook", "cursor-sqlite"])
                {
                    assert_eq!(pair[0].event_name, Some(AgentEventName::Other));
                    assert_eq!(pair[0].event_id, id);
                    assert_eq!(pair[1].event_name, Some(AgentEventName::AgentInput));
                    assert_ne!(pair[1].event_id, pair[0].event_id);
                    for row in pair {
                        assert_eq!(
                            row.extra["input.messages"],
                            json!([{"role":"user","content":format!("{id} prompt")}])
                        );
                        assert_eq!(
                            row.extra["output.messages"],
                            json!([{"type":"text","content":"synthetic response"}])
                        );
                        assert_eq!(
                            row.extra["tool.result.payload"],
                            json!({"output":"synthetic tool output"})
                        );
                        assert_eq!(row.extra["content"], "synthetic legacy source");
                        assert_eq!(row.extra["inlineDiffMessage"], "synthetic diff");
                        let canonical = json!([{"role":"user","parts":[{"type":"text","content":format!("{id} canonical prompt")}]}]);
                        assert_eq!(row.input_messages.as_ref(), Some(&canonical));
                        assert_eq!(row.input_messages_delta.as_ref(), Some(&canonical));
                        assert_eq!(row.agent_type, "cursor");
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn shared_turn_boundaries_are_inferred_once_and_identical_for_every_destination() {
        let manager = InputManager::new();
        register(&manager, "boundaries", "cursor");
        let sinks = [Sink::new(), Sink::new(), Sink::new()];
        manager.set_flusher(Arc::new(MultiFlusher::new(
            sinks
                .iter()
                .map(|sink| sink.clone() as Arc<dyn BaseFlusher>)
                .collect(),
        )));
        let request = entry("request", AgentEventName::LlmRequest);
        let mut response = entry("response", AgentEventName::LlmResponse);
        response.finish_reasons = Some(vec!["stop".into()]);
        manager
            .accept_entries("boundaries", vec![request, response])
            .await
            .unwrap();
        let expected = flattened(&sinks[0]);
        assert_eq!(expected.len(), 2);
        assert_eq!(expected[0].event_id, "request");
        assert_eq!(expected[0].turn_start, Some(true));
        assert_eq!(expected[1].event_id, "response");
        assert_eq!(expected[1].turn_end, Some(true));
        for sink in sinks {
            assert_eq!(flattened(&sink), expected);
        }
    }

    #[tokio::test]
    async fn actual_blocked_prompt_builder_flows_through_identity_mask_and_shared_output() {
        use crate::interceptor::{build_blocked_qoder_prompt_entry, HookRequest};
        let root = tempfile::tempdir().unwrap();
        for opted_out in [false, true] {
            let manager = InputManager::new();
            manager.set_configured_user_id("configured-user");
            manager.set_mask_config(all_mask());
            if opted_out {
                manager.set_agents_config(
                    &serde_json::from_value(json!({"qoder":{"captureMessageContent":false}}))
                        .unwrap(),
                );
            }
            let sinks = [Sink::new(), Sink::new()];
            manager.set_flusher(Arc::new(MultiFlusher::new(
                sinks
                    .iter()
                    .map(|sink| sink.clone() as Arc<dyn BaseFlusher>)
                    .collect(),
            )));
            let key = format!("sk-{}", "1234567890abcdefghijklmnop");
            let request: HookRequest = serde_json::from_value(json!({
                "agent":if opted_out {"qodercli"} else {"qoder"},
                "event":"UserPromptSubmit","prompt":format!("token {key}"),
                "sessionId":"synthetic-blocked","cwd":root.path()
            }))
            .unwrap();
            let mut source = build_blocked_qoder_prompt_entry(&request, Some(1_700_000_000_000));
            // Avoid probing any global git configuration; workspace enrichment is
            // still performed by the real production function before masking.
            source.git_repo = Some("synthetic/repo".into());
            source.git_branch = Some("fixture".into());
            manager.flush_prepared_entries(vec![source]).await.unwrap();
            for sink in sinks {
                let rows = flattened(&sink);
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].user_id, "configured-user");
                assert_eq!(
                    rows[0].input_messages,
                    Some(
                        json!([{"role":"user","parts":[{"type":"text","content":"token [APIKEY_MASKED]"}]}])
                    )
                );
                assert_eq!(rows[0].guardrail_action, Some(GuardrailAction::Block));
                assert_eq!(rows[0].trace_id, None);
                assert_eq!(rows[0].turn_start, None);
                assert!(!serde_json::to_string(&rows).unwrap().contains(&key));
            }
        }
    }

    struct DurabilityGate {
        failure: Option<FlushErrorKind>,
        entered: Notify,
        release: Semaphore,
    }
    #[async_trait]
    impl BaseFlusher for DurabilityGate {
        fn name(&self) -> &str {
            "controlled-durability"
        }
        async fn send(&self, row: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
            self.send_batch(vec![row], None).await
        }
        async fn send_batch(
            &self,
            rows: Vec<AgentActivityEntry>,
            _: Option<Vec<f64>>,
        ) -> Result<(), FlushError> {
            assert_eq!(rows.len(), 1);
            self.entered.notify_one();
            self.release.acquire().await.unwrap().forget();
            match self.failure {
                Some(FlushErrorKind::CodexTurnJournal) => {
                    Err(FlushError::codex_journal("synthetic journal refusal"))
                }
                Some(FlushErrorKind::CodexOutputDurability) => {
                    Err(FlushError::codex_output("synthetic backend"))
                }
                _ => Ok(()),
            }
        }
        async fn flush(&self) -> Result<(), FlushError> {
            Ok(())
        }
        async fn shutdown(&self) -> Result<(), FlushError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn shared_codex_checkpoint_waits_for_all_destinations_and_freezes_both_durability_failures(
    ) {
        for failure in [
            None,
            Some(FlushErrorKind::CodexTurnJournal),
            Some(FlushErrorKind::CodexOutputDurability),
        ] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("state.json");
            let store = Arc::new(StateStore::new(&path));
            store.set_offset("codex", 1.0);
            store.save().await.unwrap();
            let before = std::fs::read(&path).unwrap();
            let manager = Arc::new(InputManager::new());
            register(&manager, "codex-checkpoint", "codex");
            manager.set_state_store(store.clone());
            let gate = Arc::new(DurabilityGate {
                failure,
                entered: Notify::new(),
                release: Semaphore::new(0),
            });
            let healthy = Sink::new();
            manager.set_flusher(Arc::new(MultiFlusher::new(vec![
                gate.clone(),
                healthy.clone(),
            ])));
            store.set_offset("codex", 2.0);
            store.set_offset("other-input", 3.0);
            manager.bind_entries(
                "codex-checkpoint",
                vec![entry("durable-input", AgentEventName::Other)],
            );
            let saving_store = store.clone();
            let saving = tokio::spawn(async move { saving_store.save().await });
            tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
                .await
                .unwrap();
            assert!(store.waiting_for_output());
            assert!(!saving.is_finished());
            assert_eq!(std::fs::read(&path).unwrap(), before);
            gate.release.add_permits(1);
            let saved = tokio::time::timeout(Duration::from_secs(3), saving)
                .await
                .unwrap()
                .unwrap();
            if failure.is_some() {
                assert!(saved.is_err());
                assert!(store.save().await.is_err());
                assert!(store.save_failed());
                assert_eq!(std::fs::read(&path).unwrap(), before);
            } else {
                saved.unwrap();
                assert!(!store.save_failed());
                let disk: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                assert_eq!(disk["codex"]["lastOffset"], 2.0);
                assert_eq!(disk["other-input"]["lastOffset"], 3.0);
            }
            tokio::time::timeout(Duration::from_secs(3), manager.stop_all())
                .await
                .unwrap();
            assert_eq!(flattened(&healthy).len(), 1);
        }
    }

    struct LifecycleUploader {
        shutdowns: std::sync::atomic::AtomicUsize,
        panic_on_shutdown: bool,
        must_follow: Option<Arc<AtomicBool>>,
    }
    #[async_trait]
    impl crate::multimodal::types::Uploader for LifecycleUploader {
        async fn upload(
            &self,
            _: crate::multimodal::types::UploadItem,
            _: crate::multimodal::types::UploadOptions,
        ) -> bool {
            panic!("lifecycle fixtures must not submit images or external uploads")
        }
        async fn shutdown(&self) {
            self.shutdowns.fetch_add(1, Ordering::SeqCst);
            if let Some(accepted) = &self.must_follow {
                assert!(
                    accepted.load(Ordering::SeqCst),
                    "actual processor shutdown must follow queue acceptance"
                );
            }
            assert!(
                !self.panic_on_shutdown,
                "synthetic uploader shutdown failure"
            );
        }
    }
    fn lifecycle_processor(
        origin: &str,
        panic_on_shutdown: bool,
        must_follow: Option<Arc<AtomicBool>>,
    ) -> (Arc<MultimodalProcessor>, Arc<LifecycleUploader>) {
        let uploader = Arc::new(LifecycleUploader {
            shutdowns: std::sync::atomic::AtomicUsize::new(0),
            panic_on_shutdown,
            must_follow,
        });
        let processor = MultimodalProcessor::new(Some(origin), uploader.clone(), None).unwrap();
        (processor, uploader)
    }
    struct QueuedOutput {
        entered: Notify,
        release: Semaphore,
        accepted: Arc<AtomicBool>,
    }
    #[async_trait]
    impl BaseFlusher for QueuedOutput {
        fn name(&self) -> &str {
            "controlled-queue"
        }
        async fn send(&self, entry: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
            self.send_batch(vec![entry], None).await
        }
        async fn send_batch(
            &self,
            entries: Vec<AgentActivityEntry>,
            _: Option<Vec<f64>>,
        ) -> Result<(), FlushError> {
            assert_eq!(entries.len(), 1);
            self.entered.notify_one();
            self.release.acquire().await.unwrap().forget();
            self.accepted.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn flush(&self) -> Result<(), FlushError> {
            Ok(())
        }
        async fn shutdown(&self) -> Result<(), FlushError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn actual_multimodal_processor_shutdown_waits_for_the_real_non_codex_queue() {
        let manager = Arc::new(InputManager::new());
        register(&manager, "queued-source", "cursor");
        let accepted = Arc::new(AtomicBool::new(false));
        let output = Arc::new(QueuedOutput {
            entered: Notify::new(),
            release: Semaphore::new(0),
            accepted: accepted.clone(),
        });
        manager.set_flusher(output.clone());
        let (processor, uploader) =
            lifecycle_processor("oss://fixture/first", false, Some(accepted.clone()));
        manager.set_multimodal_processor(processor);
        manager.bind_entries(
            "queued-source",
            vec![entry("queued-before-multimodal", AgentEventName::Other)],
        );
        tokio::time::timeout(Duration::from_secs(3), output.entered.notified())
            .await
            .unwrap();
        let owner = manager.clone();
        let stopping = tokio::spawn(async move { owner.stop_all().await });
        assert!(tokio::time::timeout(Duration::from_millis(25), async {
            while !stopping.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_err());
        assert_eq!(uploader.shutdowns.load(Ordering::SeqCst), 0);
        assert_eq!(
            manager.multimodal_storage_base_path().as_deref(),
            Some("oss://fixture/first")
        );
        output.release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(3), stopping)
            .await
            .unwrap()
            .unwrap();
        assert!(accepted.load(Ordering::SeqCst));
        assert_eq!(uploader.shutdowns.load(Ordering::SeqCst), 1);
        assert!(manager.multimodal_storage_base_path().is_none());
    }

    #[tokio::test]
    async fn actual_multimodal_shutdown_task_failure_is_contained_after_clearing_the_slot() {
        let manager = InputManager::new();
        let (processor, uploader) = lifecycle_processor("oss://fixture/failing", true, None);
        manager.set_multimodal_processor(processor);
        tokio::time::timeout(Duration::from_secs(3), manager.stop_all())
            .await
            .unwrap();
        assert_eq!(uploader.shutdowns.load(Ordering::SeqCst), 1);
        assert!(manager.multimodal_storage_base_path().is_none());
        manager.stop_all().await;
        assert_eq!(uploader.shutdowns.load(Ordering::SeqCst), 1);
        let (healthy, healthy_uploader) =
            lifecycle_processor("oss://fixture/recovered", false, None);
        manager.set_multimodal_processor(healthy);
        manager.stop_all().await;
        assert_eq!(healthy_uploader.shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn active_processor_replacement_is_rejected_and_stop_reinstall_uses_new_real_instance() {
        let manager = InputManager::new();
        let (first, first_uploader) = lifecycle_processor("oss://fixture/first", false, None);
        let (second, second_uploader) = lifecycle_processor("oss://fixture/second", false, None);
        manager.set_multimodal_processor(first.clone());
        manager.set_multimodal_processor(first);
        manager.set_multimodal_processor(second.clone());
        assert_eq!(
            manager.multimodal_storage_base_path().as_deref(),
            Some("oss://fixture/first")
        );
        manager.stop_all().await;
        assert_eq!(first_uploader.shutdowns.load(Ordering::SeqCst), 1);
        assert_eq!(second_uploader.shutdowns.load(Ordering::SeqCst), 0);
        manager.set_multimodal_processor(second);
        assert_eq!(
            manager.multimodal_storage_base_path().as_deref(),
            Some("oss://fixture/second")
        );
        manager.stop_all().await;
        assert_eq!(first_uploader.shutdowns.load(Ordering::SeqCst), 1);
        assert_eq!(second_uploader.shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn actual_git_probe_failure_does_not_drop_the_batch_or_later_entries() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("definitely-missing-workspace");
        assert!(!missing.exists());
        let manager = InputManager::new();
        register(&manager, "git-failure", "codex");
        manager.set_configured_user_id("configured-after-probe");
        let output = Sink::new();
        manager.set_flusher(output.clone());
        let mut first = entry("failed-probe", AgentEventName::Other);
        first.agent_type = "codex".into();
        first.extra.insert("agent.codex.cwd".into(), json!(missing));
        let mut later = first.clone();
        later.event_id = "later-entry".into();
        manager
            .accept_entries("git-failure", vec![first, later])
            .await
            .unwrap();
        let rows = flattened(&output);
        assert_eq!(
            rows.iter()
                .map(|entry| entry.event_id.as_str())
                .collect::<Vec<_>>(),
            ["failed-probe", "later-entry"]
        );
        assert!(rows
            .iter()
            .all(|entry| entry.workspace_path.as_deref() == missing.to_str()));
        assert!(rows
            .iter()
            .all(|entry| entry.user_id == "configured-after-probe" && entry.git_repo.is_none()));
        assert_eq!(manager.get_input_counters()["git-failure"].out_events, 2);
    }

    #[tokio::test]
    async fn real_boundary_state_failure_preserves_current_records_and_recovers_next_batch() {
        let manager = InputManager::new();
        register(&manager, "boundary-error", "cursor");
        let sinks = [Sink::new(), Sink::new()];
        manager.set_flusher(Arc::new(MultiFlusher::new(
            sinks
                .iter()
                .map(|sink| sink.clone() as Arc<dyn BaseFlusher>)
                .collect(),
        )));
        let poisoned = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _state = manager.turn_boundary.lock().unwrap();
                    panic!("synthetic previous boundary-state failure");
                })
                .join()
        });
        assert!(poisoned.is_err());
        assert!(manager.turn_boundary.is_poisoned());
        let mut source = entry("original-on-enrichment-error", AgentEventName::LlmRequest);
        source.turn_id = Some("failed-turn".into());
        source.turn_end = Some(false);
        manager
            .accept_entries("boundary-error", vec![source.clone()])
            .await
            .unwrap();
        assert!(!manager.turn_boundary.is_poisoned());
        for sink in &sinks {
            let rows = flattened(sink);
            assert_eq!(rows.len(), 1);
            assert_eq!(
                rows[0], source,
                "failed derived enrichment must not mutate facts/boundaries"
            );
            assert_eq!(rows[0].turn_start, None);
            assert_eq!(rows[0].turn_end, Some(false));
        }
        let mut recovered = entry("after-enrichment-error", AgentEventName::LlmRequest);
        recovered.turn_id = Some("recovered-turn".into());
        manager
            .accept_entries("boundary-error", vec![recovered])
            .await
            .unwrap();
        for sink in sinks {
            let rows = flattened(&sink);
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[1].event_id, "after-enrichment-error");
            assert_eq!(rows[1].turn_start, Some(true));
        }
    }

    #[tokio::test]
    async fn interceptor_prepared_batch_exclusions_precede_identity_and_every_destination() {
        use crate::interceptor::{build_blocked_qoder_prompt_entry, HookRequest};
        use crate::normalization::INVOCATION_SESSION_ID_FIELD;
        let root = tempfile::tempdir().unwrap();
        let excluded = root.path().join("private");
        std::fs::create_dir(&excluded).unwrap();
        let manager = InputManager::new();
        manager.set_workspace_policy(
            WorkspacePolicy::new(&[excluded.to_string_lossy().into_owned()], None).unwrap(),
        );
        manager.set_configured_user_id("configured-user");
        manager.set_mask_config(all_mask());
        let sinks = [Sink::new(), Sink::new()];
        manager.set_flusher(Arc::new(MultiFlusher::new(
            sinks
                .iter()
                .map(|sink| sink.clone() as Arc<dyn BaseFlusher>)
                .collect(),
        )));
        let request:HookRequest=serde_json::from_value(json!({
            "agent":"qodercli","event":"UserPromptSubmit","prompt":"synthetic hidden prompt","sessionId":"native-private"
        })).unwrap();
        let mut early = build_blocked_qoder_prompt_entry(&request, Some(1_700_000_000_000));
        early.event_id = "early-private".into();
        early.extra.insert(
            INVOCATION_SESSION_ID_FIELD.into(),
            json!("rewritten-customer-session"),
        );
        let mut known = early.clone();
        known.event_id = "known-private".into();
        known.workspace_path = Some(excluded.to_string_lossy().into_owned());
        let mut allowed = early.clone();
        allowed.event_id = "public".into();
        allowed.session_id = "native-public".into();
        allowed.git_repo = Some("synthetic/repo".into());
        allowed.git_branch = Some("fixture".into());
        manager
            .flush_prepared_entries(vec![early, allowed, known])
            .await
            .unwrap();
        for sink in sinks {
            let rows = flattened(&sink);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].event_id, "public");
            assert_eq!(rows[0].session_id, "rewritten-customer-session");
            assert_eq!(rows[0].user_id, "configured-user");
        }
    }
}
