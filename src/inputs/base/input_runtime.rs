//! Shared start/stop/poll lifecycle from `src/inputs/base/base-input.ts`.
//!
//! Concrete collectors are [`InputBody`] values hosted by [`HostedInput`].
//! Mutable lifecycle state sits behind mutexes so `start` and `stop` can
//! interleave the way the TypeScript promises do.

use super::runtime_metrics::{InputRuntimeAccumulator, InputRuntimeDelta};
use super::workspace_policy::WorkspacePolicy;
use crate::checkpoints::{InputState, InputStatePatch, StateStore};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{
    create_logger, resolve_poll_interval_ms, BoundLogger, DEFAULT_POLL_INTERVAL_MS,
};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

const OWNERSHIP_WARN_CAP: usize = 512;

#[async_trait]
pub trait InputBody: Send + Sync + 'static {
    /// Exact key namespaces this body mutates: id and every id:child.
    /// Include helper/legacy namespaces. None is conservative for unknown extensions.
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        None
    }
    fn id(&self) -> &str;
    fn agent_type(&self) -> ClientType;
    fn collection_method(&self) -> CollectionMethod;
    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>>;
    async fn on_start(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        Ok(())
    }
    async fn on_stop(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        Ok(())
    }
    async fn on_entries_queued(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        Ok(())
    }
    fn before_stop(&self) {}
    fn agent_version(&self) -> String {
        String::new()
    }
}

struct Gate {
    result: Mutex<Option<Result<(), String>>>,
    notify: Notify,
}

impl Gate {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            notify: Notify::new(),
        }
    }

    async fn wait(&self) -> Result<(), String> {
        loop {
            let notified = self.notify.notified();
            if let Some(result) = self
                .result
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .clone()
            {
                return result;
            }
            notified.await;
        }
    }

    fn finish(&self, result: Result<(), String>) {
        *self.result.lock().unwrap_or_else(|err| err.into_inner()) = Some(result);
        self.notify.notify_waiters();
    }
}

struct CycleGate {
    done: Mutex<bool>,
    notify: Notify,
}

impl CycleGate {
    fn new() -> Self {
        Self {
            done: Mutex::new(false),
            notify: Notify::new(),
        }
    }

    async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if *self.done.lock().unwrap_or_else(|err| err.into_inner()) {
                return;
            }
            notified.await;
        }
    }

    fn finish(&self) {
        *self.done.lock().unwrap_or_else(|err| err.into_inner()) = true;
        self.notify.notify_waiters();
    }
}

enum CycleAction {
    Wait(Arc<CycleGate>),
    Lead(Arc<CycleGate>),
}

struct Lifecycle {
    running: bool,
    collect_finished: bool,
    rescan_requested: bool,
    start: Option<Arc<Gate>>,
    stop: Option<Arc<Gate>>,
    cycle: Option<Arc<CycleGate>>,
}

/// Read-only facts from the collector's live scheduler and source handles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputRuntimeInfo {
    pub poll_interval_ms: u64,
    pub source_paths: Vec<String>,
}

pub struct InputRuntime {
    pub id: String,
    pub agent_type: ClientType,
    pub collection_method: CollectionMethod,
    pub logger: BoundLogger,
    pub state_store: Arc<StateStore>,
    poll_interval_ms: AtomicU64,
    checkpoint_waiting: AtomicBool,
    checkpoint_ready: Notify,
    checkpoint_release: Notify,
    lifecycle: Mutex<Lifecycle>,
    timer: Mutex<Option<JoinHandle<()>>>,
    workspace_policy: Mutex<WorkspacePolicy>,
    accumulator: Mutex<Option<InputRuntimeAccumulator>>,
    ownership_warned: Mutex<VecDeque<String>>,
    #[cfg(test)]
    test_warns: Mutex<Vec<String>>,
    #[cfg(test)]
    daemon_uid_override: Mutex<Option<u32>>,
}

impl InputRuntime {
    pub fn state(&self) -> InputState {
        self.state_store.get(&self.id)
    }

    pub fn update_state(&self, patch: InputStatePatch) {
        self.state_store.update(&self.id, patch);
    }

    pub fn set_state_fields(
        &self,
        last_file: Option<String>,
        last_offset: Option<f64>,
        extra: Option<Value>,
    ) {
        self.update_state(InputStatePatch {
            last_file,
            last_offset,
            extra,
            ..InputStatePatch::default()
        });
    }

    pub fn runtime_info(&self) -> InputRuntimeInfo {
        InputRuntimeInfo {
            poll_interval_ms: self.poll_interval_ms(),
            source_paths: Vec::new(),
        }
    }

    pub fn poll_interval_ms(&self) -> u64 {
        self.poll_interval_ms.load(Ordering::SeqCst)
    }

    /// Matches `BaseCliForwarder` assigning `pollIntervalMs` after `super()`.
    pub fn force_poll_interval_ms(&self, millis: u64) {
        self.poll_interval_ms.store(millis, Ordering::SeqCst);
    }

    pub fn is_running(&self) -> bool {
        self.lifecycle
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .running
    }

    pub fn timer_active(&self) -> bool {
        self.timer
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .is_some()
    }

    pub fn set_workspace_policy(&self, policy: WorkspacePolicy) {
        *self
            .workspace_policy
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = policy;
    }

    pub fn with_workspace_policy<R>(&self, f: impl FnOnce(&mut WorkspacePolicy) -> R) -> R {
        let mut policy = self
            .workspace_policy
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        f(&mut policy)
    }

    #[cfg(test)]
    pub(crate) fn reset_read_accumulator_for_test(&self) -> InputRuntimeDelta {
        self.accumulator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(InputRuntimeAccumulator::new())
            .unwrap_or_default()
            .finish(0.0)
    }

    pub fn with_accumulator(&self, f: impl FnOnce(&mut InputRuntimeAccumulator)) {
        if let Some(acc) = self
            .accumulator
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_mut()
        {
            f(acc);
        }
    }

    pub(crate) fn warn(&self, message: &str, meta: Option<&Map<String, Value>>) {
        self.logger.warn(message, meta);
        #[cfg(test)]
        self.test_warns
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(message.to_owned());
    }

    pub fn info(&self, message: &str, meta: Option<&Map<String, Value>>) {
        self.logger.info(message, meta);
    }

    pub fn error(&self, message: &str, meta: Option<&Map<String, Value>>) {
        self.logger.error(message, meta);
    }

    pub fn debug(&self, message: &str, meta: Option<&Map<String, Value>>) {
        self.logger.debug(message, meta);
    }

    #[cfg(test)]
    pub fn test_warns(&self) -> Vec<String> {
        self.test_warns
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    #[cfg(test)]
    pub fn set_daemon_uid_override(&self, uid: Option<u32>) {
        *self
            .daemon_uid_override
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = uid;
    }

    fn current_uid(&self) -> Option<u32> {
        #[cfg(test)]
        if let Some(uid) = *self
            .daemon_uid_override
            .lock()
            .unwrap_or_else(|err| err.into_inner())
        {
            return Some(uid);
        }
        current_process_uid()
    }

    pub fn is_unreadable_error(err: &std::io::Error) -> bool {
        if err.kind() == std::io::ErrorKind::PermissionDenied {
            return true;
        }
        matches!(err.raw_os_error(), Some(1 | 13))
    }

    pub async fn diagnose_unreadable_path(&self, target_path: &str, kind: &str) {
        let warn_key = format!("{kind}:{target_path}");
        {
            let mut warned = self
                .ownership_warned
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            if warned.iter().any(|existing| existing == &warn_key) {
                return;
            }
            if warned.len() >= OWNERSHIP_WARN_CAP {
                warned.pop_front();
            }
            warned.push_back(warn_key);
        }
        let owner_uid = tokio::fs::metadata(target_path)
            .await
            .ok()
            .map(|meta| file_uid(&meta));
        let daemon_uid = self.current_uid();
        let meta = json!({
            "path": target_path,
            "kind": kind,
            "ownerUid": owner_uid,
            "daemonUid": daemon_uid,
        });
        let meta = meta.as_object();
        if daemon_uid.is_none() {
            self.warn(
                &format!(
                    "ownership-mismatch: cannot read {kind} (EACCES); this platform exposes no process uid, so ensure the process writing agent events runs as the same user as this daemon"
                ),
                meta,
            );
            return;
        }
        let daemon_uid = daemon_uid.unwrap_or(0);
        if owner_uid.is_some_and(|owner| owner != daemon_uid) {
            let owner_uid = owner_uid.unwrap_or(0);
            self.warn(
                &format!(
                    "ownership-mismatch: cannot read {kind} (EACCES): owned by uid {owner_uid}, but this daemon runs as uid {daemon_uid}. A process running as a different uid loaded the pilot plugin and writes event files this daemon cannot read. Fix: run every process that loads the plugin as uid {daemon_uid} (drop the privileges of the uid-{owner_uid} process, e.g. via su or runAsUser)"
                ),
                meta,
            );
            return;
        }
        self.warn(
            &format!(
                "ownership-mismatch: cannot read {kind} (EACCES) despite matching uid {daemon_uid}; check the surrounding directory permissions or security modules (SELinux/AppArmor/ACLs)"
            ),
            meta,
        );
    }
}

fn file_uid(meta: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.uid()
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        0
    }
}

fn current_process_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        extern "C" {
            fn getuid() -> u32;
        }
        Some(unsafe { getuid() })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

pub type EntriesHandler = Arc<dyn Fn(&[AgentActivityEntry]) + Send + Sync>;
pub type ErrorHandler = Arc<dyn Fn(&str) + Send + Sync>;
pub type DeltaHandler = Arc<dyn Fn(&InputRuntimeDelta) + Send + Sync>;

type CycleHook = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send>>
        + Send
        + Sync,
>;

pub struct HostedInput<T: InputBody> {
    pub runtime: InputRuntime,
    pub body: T,
    entries_handlers: Mutex<Vec<EntriesHandler>>,
    cycle_begin: Mutex<Option<CycleHook>>,
    cycle_accept: Mutex<Option<CycleHook>>,
    error_handlers: Mutex<Vec<ErrorHandler>>,
    delta_handlers: Mutex<Vec<DeltaHandler>>,
    running_flag: AtomicBool,
    // One StateStore-owned save survives releasing an output wait on stop.
    checkpoint_save: Mutex<Option<Arc<Gate>>>,
}

impl<T: InputBody> HostedInput<T> {
    pub fn new(
        body: T,
        logger_name: &str,
        state_store: Arc<StateStore>,
        poll_interval_ms: Option<u64>,
    ) -> Arc<Self> {
        let id = body.id().to_owned();
        let agent_type = body.agent_type();
        let collection_method = body.collection_method();
        Arc::new(Self {
            runtime: InputRuntime {
                id,
                agent_type,
                collection_method,
                logger: create_logger(logger_name),
                state_store,
                poll_interval_ms: AtomicU64::new(resolve_poll_interval_ms(
                    poll_interval_ms,
                    DEFAULT_POLL_INTERVAL_MS,
                )),
                checkpoint_waiting: AtomicBool::new(false),
                checkpoint_ready: Notify::new(),
                checkpoint_release: Notify::new(),
                lifecycle: Mutex::new(Lifecycle {
                    running: false,
                    collect_finished: false,
                    rescan_requested: false,
                    start: None,
                    stop: None,
                    cycle: None,
                }),
                timer: Mutex::new(None),
                workspace_policy: Mutex::new(WorkspacePolicy::default()),
                accumulator: Mutex::new(None),
                ownership_warned: Mutex::new(VecDeque::new()),
                #[cfg(test)]
                test_warns: Mutex::new(Vec::new()),
                #[cfg(test)]
                daemon_uid_override: Mutex::new(None),
            },
            body,
            entries_handlers: Mutex::new(Vec::new()),
            cycle_begin: Mutex::new(None),
            cycle_accept: Mutex::new(None),
            error_handlers: Mutex::new(Vec::new()),
            delta_handlers: Mutex::new(Vec::new()),
            running_flag: AtomicBool::new(false),
            checkpoint_save: Mutex::new(None),
        })
    }

    pub fn id(&self) -> &str {
        self.body.id()
    }

    pub fn agent_type(&self) -> ClientType {
        self.body.agent_type()
    }

    pub fn collection_method(&self) -> CollectionMethod {
        self.body.collection_method()
    }

    pub fn running(&self) -> bool {
        self.running_flag.load(Ordering::SeqCst)
    }

    pub fn agent_version(&self) -> String {
        self.body.agent_version()
    }

    pub fn on_entries(&self, handler: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static) {
        self.entries_handlers
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(Arc::new(handler));
    }

    /// Optional SDK transaction boundaries; ordinary collectors keep their callbacks.
    pub(crate) fn set_cycle_hooks(&self, begin: CycleHook, accept: CycleHook) {
        *self.cycle_begin.lock().unwrap() = Some(begin);
        *self.cycle_accept.lock().unwrap() = Some(accept);
    }

    pub fn on_collect_error(&self, handler: impl Fn(&str) + Send + Sync + 'static) {
        self.error_handlers
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(Arc::new(handler));
    }

    pub fn on_runtime_delta(&self, handler: impl Fn(&InputRuntimeDelta) + Send + Sync + 'static) {
        self.delta_handlers
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(Arc::new(handler));
    }

    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        loop {
            enum Action {
                WaitStop(Arc<Gate>),
                WaitStart(Arc<Gate>),
                Already,
                Lead(Arc<Gate>),
            }
            let action = {
                let mut life = self
                    .runtime
                    .lifecycle
                    .lock()
                    .unwrap_or_else(|err| err.into_inner());
                if let Some(stop) = &life.stop {
                    Action::WaitStop(Arc::clone(stop))
                } else if let Some(start) = &life.start {
                    Action::WaitStart(Arc::clone(start))
                } else if life.running {
                    Action::Already
                } else {
                    life.running = true;
                    self.running_flag.store(true, Ordering::SeqCst);
                    let gate = Arc::new(Gate::new());
                    life.start = Some(Arc::clone(&gate));
                    Action::Lead(gate)
                }
            };
            match action {
                Action::WaitStop(gate) => {
                    gate.wait().await?;
                }
                Action::WaitStart(gate) => return gate.wait().await,
                Action::Already => return Ok(()),
                Action::Lead(gate) => {
                    let result = self.start_once().await;
                    {
                        let mut life = self
                            .runtime
                            .lifecycle
                            .lock()
                            .unwrap_or_else(|err| err.into_inner());
                        life.start = None;
                    }
                    gate.finish(result.clone());
                    return result;
                }
            }
        }
    }

    async fn start_once(self: &Arc<Self>) -> Result<(), String> {
        self.runtime.logger.info("starting", None);
        if let Err(err) = self.body.on_start(&self.runtime).await {
            self.fail_start();
            let stop_in_progress = self
                .runtime
                .lifecycle
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .stop
                .is_some();
            if !stop_in_progress {
                let _ = self.body.on_stop(&self.runtime).await;
            }
            return Err(err.to_string());
        }
        if !self.runtime.is_running() {
            return Ok(());
        }
        let first = Arc::clone(self);
        let mut first_cycle = tokio::spawn(async move {
            if first.runtime.is_running() {
                first.run_cycle_request(false).await;
            }
        });
        loop {
            let ready = self.runtime.checkpoint_ready.notified();
            if self.runtime.checkpoint_waiting.load(Ordering::SeqCst) {
                break;
            }
            tokio::select! {
                result=&mut first_cycle => {
                    result.map_err(|error|format!("initial collection failed: {error}"))?;
                    break;
                },
                _=ready=>{},
            }
        }
        if !self.runtime.is_running() {
            return Ok(());
        }
        self.arm_timer();
        // Let the interval register before returning so paused-time tests can advance it.
        tokio::task::yield_now().await;
        Ok(())
    }

    fn fail_start(&self) {
        let mut life = self
            .runtime
            .lifecycle
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        life.running = false;
        self.running_flag.store(false, Ordering::SeqCst);
    }

    pub async fn stop(self: &Arc<Self>) -> Result<(), String> {
        self.body.before_stop();
        enum Action {
            Wait(Arc<Gate>),
            Idle,
            Lead(Arc<Gate>),
        }
        let action = {
            let mut life = self
                .runtime
                .lifecycle
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            if let Some(stop) = &life.stop {
                Action::Wait(Arc::clone(stop))
            } else if !life.running && life.start.is_none() {
                Action::Idle
            } else {
                life.running = false;
                self.running_flag.store(false, Ordering::SeqCst);
                if let Some(handle) = self
                    .runtime
                    .timer
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .take()
                {
                    handle.abort();
                }
                let gate = Arc::new(Gate::new());
                life.stop = Some(Arc::clone(&gate));
                Action::Lead(gate)
            }
        };
        if self.runtime.state_store.waiting_for_output() {
            self.runtime.checkpoint_release.notify_waiters();
        }
        match action {
            Action::Wait(gate) => gate.wait().await,
            Action::Idle => Ok(()),
            Action::Lead(gate) => {
                let result = self.stop_once().await;
                {
                    let mut life = self
                        .runtime
                        .lifecycle
                        .lock()
                        .unwrap_or_else(|err| err.into_inner());
                    life.stop = None;
                }
                gate.finish(result.clone());
                result
            }
        }
    }

    async fn stop_once(self: &Arc<Self>) -> Result<(), String> {
        let start = self
            .runtime
            .lifecycle
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .start
            .clone();
        if let Some(start) = start {
            let _ = start.wait().await;
        }
        let cycle = self
            .runtime
            .lifecycle
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .cycle
            .clone();
        if let Some(cycle) = cycle {
            cycle.wait().await;
        }
        let stopped = self
            .body
            .on_stop(&self.runtime)
            .await
            .map_err(|err| err.to_string());
        self.runtime.logger.info("stopped", None);
        stopped
    }

    #[cfg(test)]
    pub(crate) async fn await_current_cycle_for_test(&self) {
        let cycle = self
            .runtime
            .lifecycle
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .cycle
            .clone();
        if let Some(cycle) = cycle {
            cycle.wait().await;
        }
    }

    pub fn request_collection(self: &Arc<Self>) {
        // Register synchronously: a wakeup burst creates one worker, not one
        // task per notification. Existing work retains one pending rescan.
        if let Some(CycleAction::Lead(gate)) = self.begin_cycle(true, true) {
            let this = Arc::clone(self);
            tokio::spawn(async move {
                this.run_cycle_lead(gate).await;
            });
        }
    }

    fn begin_cycle(&self, rescan_after_collect: bool, only_running: bool) -> Option<CycleAction> {
        if self.runtime.state_store.save_failed() {
            return None;
        }
        let mut life = self
            .runtime
            .lifecycle
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if only_running && !life.running {
            return None;
        }
        if let Some(gate) = life.cycle.as_ref().map(Arc::clone) {
            if rescan_after_collect && life.running && life.collect_finished {
                life.rescan_requested = true;
            }
            Some(CycleAction::Wait(gate))
        } else {
            let gate = Arc::new(CycleGate::new());
            life.cycle = Some(Arc::clone(&gate));
            life.collect_finished = false;
            life.rescan_requested = false;
            Some(CycleAction::Lead(gate))
        }
    }

    pub async fn run_cycle(self: &Arc<Self>) {
        self.run_cycle_request(true).await;
    }

    async fn run_cycle_request(self: &Arc<Self>, rescan_after_collect: bool) {
        match self.begin_cycle(rescan_after_collect, false) {
            Some(CycleAction::Wait(gate)) => gate.wait().await,
            Some(CycleAction::Lead(gate)) => self.run_cycle_lead(gate).await,
            None => {}
        }
    }

    async fn run_cycle_lead(self: &Arc<Self>, gate: Arc<CycleGate>) {
        loop {
            self.run_cycle_once().await;
            let failed = self.runtime.state_store.save_failed();
            let rescan = {
                let mut life = self
                    .runtime
                    .lifecycle
                    .lock()
                    .unwrap_or_else(|err| err.into_inner());
                let rescan = life.rescan_requested && life.running && !failed;
                life.rescan_requested = false;
                life.collect_finished = false;
                if !rescan {
                    life.cycle = None;
                }
                rescan
            };
            if !rescan {
                gate.finish();
                return;
            }
            // Old collection and save have settled. Drain one coalesced
            // post-collect request before releasing explicit cycle waiters.
        }
    }

    fn report_cycle_error(&self, message: &str) {
        self.runtime.logger.error(
            "collection cycle failed",
            json!({ "error": message }).as_object(),
        );
        let handlers = self
            .error_handlers
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone();
        for handler in handlers {
            handler(message);
        }
    }

    fn begin_checkpoint_save(self: &Arc<Self>) -> (Arc<Gate>, bool) {
        let mut pending = self
            .checkpoint_save
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(gate) = pending.as_ref() {
            return (Arc::clone(gate), false);
        }
        let gate = Arc::new(Gate::new());
        *pending = Some(Arc::clone(&gate));
        let saved = Arc::clone(&gate);
        let owner = Arc::clone(self);
        tokio::spawn(async move {
            // Dropping a cycle's wait must not drop StateStore's save leader.
            let result = owner
                .runtime
                .state_store
                .save()
                .await
                .map_err(|err| err.to_string());
            {
                let mut pending = owner
                    .checkpoint_save
                    .lock()
                    .unwrap_or_else(|err| err.into_inner());
                if pending
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &saved))
                {
                    *pending = None;
                }
            }
            if let Err(error) = &result {
                owner.report_cycle_error(error);
            }
            saved.finish(result);
        });
        (gate, true)
    }

    async fn wait_checkpoint_save(self: &Arc<Self>, mut gate: Arc<Gate>, mut owns_save: bool) {
        loop {
            let result = gate.wait().await;
            if owns_save || result.is_err() {
                return;
            }
            // A restart reused an older pending save. Request one save after
            // that generation, so completion cannot swallow our new revision.
            (gate, owns_save) = self.begin_checkpoint_save();
        }
    }

    async fn run_cycle_once(self: &Arc<Self>) {
        let started = InputRuntimeAccumulator::now();
        *self
            .runtime
            .accumulator
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(InputRuntimeAccumulator::new());
        let collect_hold = self
            .runtime
            .state_store
            .begin_collect(self.body.checkpoint_namespaces());
        let produced = async {
            let begin = self.cycle_begin.lock().unwrap().clone();
            if let Some(begin) = begin {
                begin().await?;
            }
            let entries = self.body.collect(&self.runtime).await?;
            self.runtime
                .lifecycle
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .collect_finished = true;
            // Another input can freeze shared progress while this collect
            // awaits IO. Reject before output or source acknowledgement.
            if self.runtime.state_store.save_failed() {
                anyhow::bail!("input checkpoint is frozen after output failure");
            }
            let filtered = self.runtime.with_workspace_policy(|policy| {
                policy.filter_entries(&entries, self.runtime.agent_type)
            });
            if !filtered.is_empty() {
                let handlers = self
                    .entries_handlers
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .clone();
                for handler in handlers {
                    // This boundary covers externally supplied queue callbacks
                    // only; internal collection/normalization panics propagate.
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&filtered)))
                        .is_err()
                    {
                        // Never format a callback payload or panic value here.
                        anyhow::bail!("entry queue callback rejected the batch");
                    }
                }
                self.runtime.logger.debug(
                    "cycle produced entries",
                    json!({ "count": filtered.len() }).as_object(),
                );
            }
            self.body.on_entries_queued(&self.runtime).await?;
            let accept = self.cycle_accept.lock().unwrap().clone();
            if let Some(accept) = accept {
                accept().await?;
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;
        // Known no-progress read errors stay retryable; changed checkpoints
        // cannot become durable after an un-emitted partial collection failed.
        collect_hold.finish(produced.as_ref().map(|_| ()).map_err(ToString::to_string));
        let cycle_result = async {
            produced?;
            let released = self.runtime.checkpoint_release.notified();
            let waiting = self.runtime.state_store.waiting_for_output();
            let (save, owns_save) = self.begin_checkpoint_save();
            // Startup readiness is collection readiness, independent of IO.
            // A write can acquire an output hold after it starts.
            self.runtime
                .checkpoint_waiting
                .store(true, Ordering::SeqCst);
            self.runtime.checkpoint_ready.notify_waiters();
            if waiting && !self.runtime.is_running() {
                return Ok(());
            }
            tokio::select! {
                _=self.wait_checkpoint_save(save, owns_save)=>{},
                _=released=>{},
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;
        self.runtime
            .checkpoint_waiting
            .store(false, Ordering::SeqCst);
        if let Err(err) = cycle_result {
            self.report_cycle_error(&err.to_string());
        }
        let duration = InputRuntimeAccumulator::now() - started;
        let delta = self
            .runtime
            .accumulator
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
            .unwrap_or_default()
            .finish(duration);
        let handlers = self
            .delta_handlers
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone();
        for handler in handlers {
            handler(&delta);
        }
    }

    fn arm_timer(self: &Arc<Self>) {
        let this = Arc::clone(self);
        let period = Duration::from_millis(self.runtime.poll_interval_ms().max(1));
        let handle = tokio::spawn(async move {
            let start = tokio::time::Instant::now() + period;
            let mut ticker = tokio::time::interval_at(start, period);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if !this.runtime.is_running() {
                    break;
                }
                let cycle = Arc::clone(&this);
                tokio::spawn(async move {
                    cycle.run_cycle().await;
                });
            }
        });
        *self
            .runtime
            .timer
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(handle);
    }
}

#[cfg(test)]
#[path = "checkpoint_lifecycle_main_tests.rs"]
mod checkpoint_lifecycle_main_tests;
