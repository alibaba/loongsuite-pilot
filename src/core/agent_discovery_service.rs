//! Agent discovery. Port of `agent-discovery-service.ts`.
//!
//! Each entry moves Idle → Starting → Running → Stopping → Idle. Watch bursts
//! coalesce onto one in-flight refresh. `notify` is not a crate dependency, so
//! an existing watch path is observed by mtime polling (1s) and a missing path
//! falls back to the entry interval. `LOONGSUITE_PILOT_FORCE_POLLING=true`
//! skips the mtime watcher, matching the TypeScript force-polling switch.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use crate::types::{AgentDetection, AgentStopReason, EntryState};

use super::{fields, logger};

const DEFAULT_POLL_MS: u64 = 300_000;
const WATCH_POLL_MS: u64 = 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentDiscoveryEvent {
    Started(String),
    Stopped(String, AgentStopReason),
}

struct EntryRuntime {
    entry: Arc<dyn AgentDetection>,
    state: EntryState,
    consecutive_unavailable: u32,
    refresh_pending: bool,
    poll: Option<JoinHandle<()>>,
    watch: Option<JoinHandle<()>>,
}

type DiscoveryListener = Arc<dyn Fn(AgentDiscoveryEvent) + Send + Sync>;

pub struct AgentDiscoveryService {
    runtimes: Mutex<HashMap<String, EntryRuntime>>,
    gates: HashMap<String, AsyncMutex<()>>,
    stopping: AtomicBool,
    global_poll: Mutex<Option<JoinHandle<()>>>,
    listeners: Mutex<Vec<DiscoveryListener>>,
}

impl AgentDiscoveryService {
    pub fn new(entries: Vec<Arc<dyn AgentDetection>>) -> Self {
        let mut runtimes = HashMap::new();
        let mut gates = HashMap::new();
        for entry in entries {
            let id = entry.id().to_string();
            gates.insert(id.clone(), AsyncMutex::new(()));
            runtimes.insert(
                id,
                EntryRuntime {
                    entry,
                    state: EntryState::Idle,
                    consecutive_unavailable: 0,
                    refresh_pending: false,
                    poll: None,
                    watch: None,
                },
            );
        }
        Self {
            runtimes: Mutex::new(runtimes),
            gates,
            stopping: AtomicBool::new(false),
            global_poll: Mutex::new(None),
            listeners: Mutex::new(Vec::new()),
        }
    }

    pub fn on_event(&self, listener: impl Fn(AgentDiscoveryEvent) + Send + Sync + 'static) {
        self.listeners
            .lock()
            .expect("listeners")
            .push(Arc::new(listener));
    }

    pub async fn start(self: &Arc<Self>) {
        self.stopping.store(false, Ordering::SeqCst);
        let ids: Vec<String> = self
            .runtimes
            .lock()
            .expect("runtimes")
            .keys()
            .cloned()
            .collect();
        for id in &ids {
            self.setup_watcher(id);
        }
        self.refresh("startup").await;
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        let interval = std::env::var("LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_POLL_MS);
        let this = Arc::clone(self);
        *self.global_poll.lock().expect("global poll") = Some(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(interval));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if this.stopping.load(Ordering::SeqCst) {
                    break;
                }
                this.refresh("poll").await;
            }
        }));
    }

    pub async fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(task) = self.global_poll.lock().expect("global poll").take() {
            task.abort();
        }
        let ids: Vec<String> = self
            .runtimes
            .lock()
            .expect("runtimes")
            .keys()
            .cloned()
            .collect();
        for id in ids {
            {
                let mut runtimes = self.runtimes.lock().expect("runtimes");
                if let Some(rt) = runtimes.get_mut(&id) {
                    if let Some(task) = rt.watch.take() {
                        task.abort();
                    }
                    if let Some(task) = rt.poll.take() {
                        task.abort();
                    }
                }
            }
            if let Some(gate) = self.gates.get(&id) {
                let _guard = gate.lock().await;
            }
            let should_stop = self
                .runtimes
                .lock()
                .expect("runtimes")
                .get(&id)
                .map(|rt| matches!(rt.state, EntryState::Running | EntryState::Starting))
                .unwrap_or(false);
            if should_stop {
                self.stop_entry(&id, AgentStopReason::Shutdown).await;
            }
        }
    }

    pub async fn refresh(&self, trigger: &str) {
        logger("AgentDiscoveryService").debug(
            "refresh triggered",
            Some(&fields(serde_json::json!({ "trigger": trigger }))),
        );
        let ids: Vec<String> = self
            .runtimes
            .lock()
            .expect("runtimes")
            .keys()
            .cloned()
            .collect();
        for id in ids {
            self.process_entry(&id).await;
        }
    }

    pub fn get_states(&self) -> HashMap<String, EntryState> {
        self.runtimes
            .lock()
            .expect("runtimes")
            .iter()
            .map(|(id, rt)| (id.clone(), rt.state))
            .collect()
    }

    async fn process_entry(&self, id: &str) {
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut runtimes = self.runtimes.lock().expect("runtimes");
            let Some(rt) = runtimes.get_mut(id) else {
                return;
            };
            rt.refresh_pending = true;
        }
        let Some(gate) = self.gates.get(id) else {
            return;
        };
        let _guard = gate.lock().await;
        loop {
            let pending = {
                let mut runtimes = self.runtimes.lock().expect("runtimes");
                let Some(rt) = runtimes.get_mut(id) else {
                    return;
                };
                let pending = rt.refresh_pending;
                rt.refresh_pending = false;
                pending
            };
            if !pending || self.stopping.load(Ordering::SeqCst) {
                break;
            }
            self.process_entry_once(id).await;
        }
    }

    async fn process_entry_once(&self, id: &str) {
        let entry = {
            let runtimes = self.runtimes.lock().expect("runtimes");
            let Some(rt) = runtimes.get(id) else { return };
            Arc::clone(&rt.entry)
        };
        let state = self
            .runtimes
            .lock()
            .expect("runtimes")
            .get(id)
            .map(|rt| rt.state)
            .unwrap_or(EntryState::Idle);
        let outcome = async {
            let enabled = entry.enabled();
            let availability = if enabled {
                entry.availability_result().await
            } else {
                Ok(false)
            };
            // Shutdown owns cleanup/reason classification after a pending lookup.
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            let available = match availability {
                Ok(available) => available,
                Err(error) => {
                    self.fail_entry(id, &error.to_string()).await;
                    return;
                }
            };
            let should_run = enabled && available;
            if !should_run && state == EntryState::Idle {
                logger("AgentDiscoveryService").debug(
                    "agent skipped",
                    Some(&fields(serde_json::json!({ "id": entry.id(), "enabled": enabled, "available": available }))),
                );
            }
            if should_run && state != EntryState::Running {
                if let Some(rt) = self.runtimes.lock().expect("runtimes").get_mut(id) {
                    rt.consecutive_unavailable = 0;
                    rt.state = EntryState::Starting;
                }
                logger("AgentDiscoveryService").info(
                    "starting agent",
                    Some(&fields(serde_json::json!({ "id": entry.id() }))),
                );
                if let Err(err) = entry.start().await {
                    if self.stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    self.fail_entry(id, &err.to_string()).await;
                    return;
                }
                if self.stopping.load(Ordering::SeqCst) {
                    return;
                }
                if let Some(rt) = self.runtimes.lock().expect("runtimes").get_mut(id) {
                    rt.state = EntryState::Running;
                }
                self.emit(AgentDiscoveryEvent::Started(entry.id().to_string()));
            } else if !should_run && matches!(state, EntryState::Running | EntryState::Starting) {
                if !enabled {
                    if let Some(rt) = self.runtimes.lock().expect("runtimes").get_mut(id) {
                        rt.consecutive_unavailable = 0;
                    }
                    self.stop_entry(id, AgentStopReason::Disabled).await;
                } else {
                    let threshold = entry.unavailable_threshold();
                    let count = {
                        let mut runtimes = self.runtimes.lock().expect("runtimes");
                        let Some(rt) = runtimes.get_mut(id) else {
                            return;
                        };
                        rt.consecutive_unavailable += 1;
                        rt.consecutive_unavailable
                    };
                    if count >= threshold {
                        if let Some(rt) = self.runtimes.lock().expect("runtimes").get_mut(id) {
                            rt.consecutive_unavailable = 0;
                        }
                        self.stop_entry(id, AgentStopReason::Unavailable).await;
                    } else {
                        logger("AgentDiscoveryService").debug(
                            "agent unavailable, debouncing",
                            Some(&fields(serde_json::json!({
                                "id": entry.id(),
                                "consecutiveUnavailable": count,
                                "threshold": threshold,
                            }))),
                        );
                    }
                }
            } else if should_run && state == EntryState::Running && entry.run_on_active() {
                if let Some(rt) = self.runtimes.lock().expect("runtimes").get_mut(id) {
                    rt.consecutive_unavailable = 0;
                }
                if let Err(error) = entry.start().await {
                    if !self.stopping.load(Ordering::SeqCst) {
                        self.fail_entry(id, &error.to_string()).await;
                    }
                }
            } else if should_run && state == EntryState::Running {
                if let Some(rt) = self.runtimes.lock().expect("runtimes").get_mut(id) {
                    rt.consecutive_unavailable = 0;
                }
            }
        };
        outcome.await;
    }

    async fn fail_entry(&self, id: &str, error: &str) {
        logger("AgentDiscoveryService").error(
            "processEntry failed",
            Some(&fields(serde_json::json!({ "id": id, "error": error }))),
        );
        let was_running = self
            .runtimes
            .lock()
            .expect("runtimes")
            .get(id)
            .is_some_and(|runtime| runtime.state == EntryState::Running);
        if was_running {
            // Cancel the live input before publishing Idle; do not leave an
            // untracked collector behind after a failed availability probe.
            self.stop_entry(id, AgentStopReason::Unexpected).await;
        } else if let Some(runtime) = self.runtimes.lock().expect("runtimes").get_mut(id) {
            runtime.consecutive_unavailable = 0;
            runtime.state = EntryState::Idle;
        }
    }

    async fn stop_entry(&self, id: &str, reason: AgentStopReason) {
        let entry = {
            let mut runtimes = self.runtimes.lock().expect("runtimes");
            let Some(rt) = runtimes.get_mut(id) else {
                return;
            };
            rt.state = EntryState::Stopping;
            Arc::clone(&rt.entry)
        };
        if let Err(err) = entry.stop().await {
            logger("AgentDiscoveryService").warn(
                "entry stop failed",
                Some(&fields(
                    serde_json::json!({ "id": id, "error": err.to_string() }),
                )),
            );
        }
        if let Some(rt) = self.runtimes.lock().expect("runtimes").get_mut(id) {
            rt.state = EntryState::Idle;
        }
        self.emit(AgentDiscoveryEvent::Stopped(id.to_string(), reason));
    }

    fn emit(&self, event: AgentDiscoveryEvent) {
        for listener in self.listeners.lock().expect("listeners").iter() {
            listener(event.clone());
        }
    }

    fn setup_watcher(self: &Arc<Self>, id: &str) {
        let force = std::env::var("LOONGSUITE_PILOT_FORCE_POLLING")
            .ok()
            .as_deref()
            == Some("true");
        if force {
            self.setup_polling(id);
            return;
        }
        let paths = self
            .runtimes
            .lock()
            .expect("runtimes")
            .get(id)
            .map(|rt| rt.entry.watch_paths().to_vec())
            .unwrap_or_default();
        if let Some(path) = paths
            .into_iter()
            .find(|path| std::path::Path::new(path).exists())
        {
            let this = Arc::clone(self);
            let id = id.to_string();
            let watched = id.clone();
            let task = tokio::spawn(async move {
                let mut previous = signature(&path);
                let mut ticker = tokio::time::interval(Duration::from_millis(WATCH_POLL_MS));
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    if this.stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    let next = signature(&path);
                    if next != previous {
                        previous = next;
                        this.process_entry(&watched).await;
                    }
                }
            });
            if let Some(rt) = self.runtimes.lock().expect("runtimes").get_mut(&id) {
                rt.watch = Some(task);
            }
            return;
        }
        self.setup_polling(id);
    }

    fn setup_polling(self: &Arc<Self>, id: &str) {
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        let already = self
            .runtimes
            .lock()
            .expect("runtimes")
            .get(id)
            .and_then(|rt| rt.poll.as_ref())
            .is_some();
        if already {
            return;
        }
        let interval = self
            .runtimes
            .lock()
            .expect("runtimes")
            .get(id)
            .map(|rt| {
                let value = rt.entry.poll_interval_ms();
                if value == 0 {
                    DEFAULT_POLL_MS
                } else {
                    value
                }
            })
            .unwrap_or(DEFAULT_POLL_MS);
        let this = Arc::clone(self);
        let id_owned = id.to_string();
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(interval));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if this.stopping.load(Ordering::SeqCst) {
                    break;
                }
                this.process_entry(&id_owned).await;
            }
        });
        if let Some(rt) = self.runtimes.lock().expect("runtimes").get_mut(id) {
            rt.poll = Some(task);
        }
    }
}

fn signature(path: &str) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => format!(
            "{}:{}",
            meta.len(),
            meta.modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ),
        Err(_) => "missing".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::AtomicU32;

    struct Fake {
        id: String,
        enabled: AtomicBool,
        available: AtomicBool,
        starts: AtomicU32,
        stops: AtomicU32,
        fail_start: AtomicBool,
        threshold: u32,
        watch: Vec<String>,
    }

    #[async_trait]
    impl AgentDetection for Fake {
        fn id(&self) -> &str {
            &self.id
        }
        fn type_name(&self) -> &str {
            "test"
        }
        async fn is_available(&self) -> bool {
            self.available.load(Ordering::SeqCst)
        }
        fn watch_paths(&self) -> &[String] {
            &self.watch
        }
        fn enabled(&self) -> bool {
            self.enabled.load(Ordering::SeqCst)
        }
        async fn start(&self) -> anyhow::Result<()> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            if self.fail_start.load(Ordering::SeqCst) {
                anyhow::bail!("start failed");
            }
            Ok(())
        }
        async fn stop(&self) -> anyhow::Result<()> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn poll_interval_ms(&self) -> u64 {
            60_000
        }
        fn unavailable_threshold(&self) -> u32 {
            self.threshold
        }
    }

    fn fake(id: &str) -> Arc<Fake> {
        Arc::new(Fake {
            id: id.into(),
            enabled: AtomicBool::new(true),
            available: AtomicBool::new(true),
            starts: AtomicU32::new(0),
            stops: AtomicU32::new(0),
            fail_start: AtomicBool::new(false),
            threshold: 1,
            watch: Vec::new(),
        })
    }

    #[tokio::test]
    async fn starts_when_enabled_and_available_and_stops_on_disable() {
        let agent = fake("claude");
        let service = Arc::new(AgentDiscoveryService::new(vec![agent.clone()]));
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&events);
        service.on_event(move |event| seen.lock().unwrap().push(event));
        service.refresh("manual").await;
        assert_eq!(
            service.get_states().get("claude"),
            Some(&EntryState::Running)
        );
        assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
        agent.enabled.store(false, Ordering::SeqCst);
        service.refresh("manual").await;
        assert_eq!(service.get_states().get("claude"), Some(&EntryState::Idle));
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert!(events.lock().unwrap().iter().any(|event| matches!(
            event,
            AgentDiscoveryEvent::Stopped(_, AgentStopReason::Disabled)
        )));
    }

    #[tokio::test]
    async fn does_not_start_when_unavailable_and_debounces_threshold() {
        let agent = Arc::new(Fake {
            id: "cursor".into(),
            enabled: AtomicBool::new(true),
            available: AtomicBool::new(false),
            starts: AtomicU32::new(0),
            stops: AtomicU32::new(0),
            fail_start: AtomicBool::new(false),
            threshold: 3,
            watch: Vec::new(),
        });
        let service = Arc::new(AgentDiscoveryService::new(vec![agent.clone()]));
        service.refresh("manual").await;
        assert_eq!(agent.starts.load(Ordering::SeqCst), 0);
        agent.available.store(true, Ordering::SeqCst);
        service.refresh("manual").await;
        agent.available.store(false, Ordering::SeqCst);
        service.refresh("manual").await;
        assert_eq!(
            service.get_states().get("cursor"),
            Some(&EntryState::Running)
        );
        service.refresh("manual").await;
        assert_eq!(
            service.get_states().get("cursor"),
            Some(&EntryState::Running)
        );
        service.refresh("manual").await;
        assert_eq!(service.get_states().get("cursor"), Some(&EntryState::Idle));
    }

    #[tokio::test]
    async fn unexpected_stop_when_start_fails_after_running_is_not_emitted_for_idle() {
        let agent = Arc::new(Fake {
            id: "boom".into(),
            enabled: AtomicBool::new(true),
            available: AtomicBool::new(true),
            starts: AtomicU32::new(0),
            stops: AtomicU32::new(0),
            fail_start: AtomicBool::new(true),
            threshold: 1,
            watch: Vec::new(),
        });
        let service = Arc::new(AgentDiscoveryService::new(vec![agent]));
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&events);
        service.on_event(move |event| seen.lock().unwrap().push(event));
        service.refresh("manual").await;
        assert_eq!(service.get_states().get("boom"), Some(&EntryState::Idle));
        assert!(events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn shutdown_emits_shutdown_and_stops_running_entries() {
        let agent = fake("qoder");
        let service = Arc::new(AgentDiscoveryService::new(vec![agent.clone()]));
        service.refresh("manual").await;
        service.stop().await;
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert_eq!(service.get_states().get("qoder"), Some(&EntryState::Idle));
    }
}

#[cfg(test)]
mod migration_lifecycle_tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::{Notify, Semaphore};

    struct Detection {
        id: String,
        enabled: AtomicBool,
        available: AtomicBool,
        starts: AtomicUsize,
        stops: AtomicUsize,
        threshold: u32,
        watch: Vec<String>,
        interval: u64,
        start_gate: Option<Arc<Semaphore>>,
        availability_gate: Option<Arc<Semaphore>>,
        entered: Notify,
        completed: AtomicBool,
    }
    impl Detection {
        fn new(id: &str) -> Self {
            Self {
                id: id.into(),
                enabled: AtomicBool::new(true),
                available: AtomicBool::new(true),
                starts: AtomicUsize::new(0),
                stops: AtomicUsize::new(0),
                threshold: 1,
                watch: Vec::new(),
                interval: 25,
                start_gate: None,
                availability_gate: None,
                entered: Notify::new(),
                completed: AtomicBool::new(false),
            }
        }
    }
    #[async_trait]
    impl AgentDetection for Detection {
        fn id(&self) -> &str {
            &self.id
        }
        fn type_name(&self) -> &str {
            "migration-fixture"
        }
        fn enabled(&self) -> bool {
            self.enabled.load(Ordering::SeqCst)
        }
        async fn is_available(&self) -> bool {
            if let Some(gate) = &self.availability_gate {
                self.entered.notify_one();
                gate.acquire().await.unwrap().forget();
            }
            self.available.load(Ordering::SeqCst)
        }
        fn watch_paths(&self) -> &[String] {
            &self.watch
        }
        async fn start(&self) -> anyhow::Result<()> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            if let Some(gate) = &self.start_gate {
                self.entered.notify_one();
                gate.acquire().await.unwrap().forget();
            }
            self.completed.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn stop(&self) -> anyhow::Result<()> {
            assert!(
                self.completed.load(Ordering::SeqCst),
                "stop raced unfinished startup"
            );
            self.stops.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn poll_interval_ms(&self) -> u64 {
            self.interval
        }
        fn unavailable_threshold(&self) -> u32 {
            self.threshold
        }
    }
    fn service(entries: Vec<Arc<Detection>>) -> Arc<AgentDiscoveryService> {
        Arc::new(AgentDiscoveryService::new(
            entries
                .into_iter()
                .map(|e| e as Arc<dyn AgentDetection>)
                .collect(),
        ))
    }
    fn record_events(service: &AgentDiscoveryService) -> Arc<Mutex<Vec<AgentDiscoveryEvent>>> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let slot = events.clone();
        service.on_event(move |event| slot.lock().unwrap().push(event));
        events
    }
    fn no_timers(service: &AgentDiscoveryService) {
        assert!(service.global_poll.lock().unwrap().is_none());
        for runtime in service.runtimes.lock().unwrap().values() {
            assert!(runtime.poll.is_none());
            assert!(runtime.watch.is_none());
        }
    }
    async fn ready(signal: &Notify) {
        tokio::time::timeout(Duration::from_secs(1), signal.notified())
            .await
            .expect("lifecycle fixture was not entered");
    }

    #[tokio::test]
    async fn availability_transitions_emit_started_and_unavailable_without_redundant_starts() {
        let agent = Arc::new(Detection::new("claude-code-log"));
        agent.available.store(false, Ordering::SeqCst);
        let service = service(vec![agent.clone()]);
        let events = record_events(&service);
        service.start().await;
        assert_eq!(service.get_states()[agent.id()], EntryState::Idle);
        assert_eq!(agent.starts.load(Ordering::SeqCst), 0);
        agent.available.store(true, Ordering::SeqCst);
        service.refresh("installed").await;
        assert_eq!(service.get_states()[agent.id()], EntryState::Running);
        service.refresh("still-installed").await;
        assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
        agent.available.store(false, Ordering::SeqCst);
        service.refresh("removed").await;
        assert_eq!(service.get_states()[agent.id()], EntryState::Idle);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                AgentDiscoveryEvent::Started(agent.id.clone()),
                AgentDiscoveryEvent::Stopped(agent.id.clone(), AgentStopReason::Unavailable)
            ]
        );
        service.stop().await;
        no_timers(&service);
    }
    #[tokio::test]
    async fn enabled_available_matrix_and_stop_return_to_idle() {
        for (enabled, available, starts) in [
            (false, true, 0),
            (true, false, 0),
            (true, true, 1),
            (false, false, 0),
        ] {
            let agent = Arc::new(Detection::new("matrix"));
            agent.enabled.store(enabled, Ordering::SeqCst);
            agent.available.store(available, Ordering::SeqCst);
            let service = service(vec![agent.clone()]);
            assert_eq!(service.get_states()[agent.id()], EntryState::Idle);
            service.start().await;
            assert_eq!(agent.starts.load(Ordering::SeqCst), starts);
            assert_eq!(
                service.get_states()[agent.id()],
                if starts == 1 {
                    EntryState::Running
                } else {
                    EntryState::Idle
                }
            );
            service.stop().await;
            assert_eq!(service.get_states()[agent.id()], EntryState::Idle);
            assert_eq!(agent.stops.load(Ordering::SeqCst), starts);
            no_timers(&service);
        }
    }
    #[tokio::test]
    async fn disable_refresh_and_shutdown_emit_the_exact_independent_reasons_once() {
        let disabled = Arc::new(Detection::new("disabled"));
        let shutdown = Arc::new(Detection::new("shutdown"));
        let service = service(vec![disabled.clone(), shutdown.clone()]);
        let events = record_events(&service);
        service.start().await;
        assert_eq!(service.get_states()[disabled.id()], EntryState::Running);
        assert_eq!(service.get_states()[shutdown.id()], EntryState::Running);
        disabled.enabled.store(false, Ordering::SeqCst);
        service.refresh("disable").await;
        assert_eq!(disabled.stops.load(Ordering::SeqCst), 1);
        assert_eq!(service.get_states()[disabled.id()], EntryState::Idle);
        service.stop().await;
        service.stop().await;
        assert_eq!(shutdown.stops.load(Ordering::SeqCst), 1);
        let events = events.lock().unwrap();
        for agent in [&disabled, &shutdown] {
            assert_eq!(
                events
                    .iter()
                    .filter(|e| **e == AgentDiscoveryEvent::Started(agent.id.clone()))
                    .count(),
                1
            );
        }
        assert_eq!(
            events
                .iter()
                .filter(|e| **e
                    == AgentDiscoveryEvent::Stopped(disabled.id.clone(), AgentStopReason::Disabled))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| **e
                    == AgentDiscoveryEvent::Stopped(shutdown.id.clone(), AgentStopReason::Shutdown))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, AgentDiscoveryEvent::Stopped(..)))
                .count(),
            2
        );
        no_timers(&service);
    }
    #[tokio::test(start_paused = true)]
    async fn missing_watch_path_uses_polling_and_shutdown_cancels_every_timer() {
        let directory = tempfile::tempdir().unwrap();
        let mut definition = Detection::new("poll");
        definition.watch = vec![directory
            .path()
            .join("not-created")
            .to_string_lossy()
            .into_owned()];
        let agent = Arc::new(definition);
        agent.available.store(false, Ordering::SeqCst);
        let service = service(vec![agent.clone()]);
        service.start().await;
        tokio::task::yield_now().await;
        {
            let runtimes = service.runtimes.lock().unwrap();
            let rt = &runtimes[agent.id()];
            assert!(rt.poll.is_some());
            assert!(rt.watch.is_none());
        }
        agent.available.store(true, Ordering::SeqCst);
        tokio::time::advance(Duration::from_millis(26)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(service.get_states()[agent.id()], EntryState::Running);
        assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
        service.stop().await;
        no_timers(&service);
        tokio::time::advance(Duration::from_secs(600)).await;
        tokio::task::yield_now().await;
        assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn unavailable_threshold_requires_consecutive_failures_and_recovers_its_counter() {
        let mut definition = Detection::new("debounce");
        definition.threshold = 3;
        let agent = Arc::new(definition);
        let service = service(vec![agent.clone()]);
        let events = record_events(&service);
        service.start().await;
        agent.available.store(false, Ordering::SeqCst);
        for reason in ["first", "second"] {
            service.refresh(reason).await;
            assert_eq!(service.get_states()[agent.id()], EntryState::Running);
        }
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, AgentDiscoveryEvent::Stopped(..))));
        agent.available.store(true, Ordering::SeqCst);
        service.refresh("recovered").await;
        agent.available.store(false, Ordering::SeqCst);
        for reason in ["new-first", "new-second"] {
            service.refresh(reason).await;
            assert_eq!(service.get_states()[agent.id()], EntryState::Running);
        }
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, AgentDiscoveryEvent::Stopped(..))));
        service.refresh("new-third").await;
        assert_eq!(service.get_states()[agent.id()], EntryState::Idle);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| **e
                    == AgentDiscoveryEvent::Stopped(agent.id.clone(), AgentStopReason::Unavailable))
                .count(),
            1
        );
        service.stop().await;
        no_timers(&service);
    }
    #[tokio::test]
    async fn concurrent_refresh_bursts_wait_for_startup_before_stopping_and_do_not_duplicate_start()
    {
        let gate = Arc::new(Semaphore::new(0));
        let mut definition = Detection::new("burst");
        definition.start_gate = Some(gate.clone());
        let agent = Arc::new(definition);
        let service = service(vec![agent.clone()]);
        let starting = {
            let service = service.clone();
            tokio::spawn(async move { service.start().await })
        };
        ready(&agent.entered).await;
        assert_eq!(service.get_states()[agent.id()], EntryState::Starting);
        let mut refreshes = Vec::new();
        for _ in 0..10 {
            let service = service.clone();
            refreshes.push(tokio::spawn(async move { service.refresh("burst").await }));
        }
        tokio::task::yield_now().await;
        agent.available.store(false, Ordering::SeqCst);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 0);
        gate.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), starting)
            .await
            .unwrap()
            .unwrap();
        for refresh in refreshes {
            tokio::time::timeout(Duration::from_secs(1), refresh)
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert_eq!(service.get_states()[agent.id()], EntryState::Idle);
        service.stop().await;
        no_timers(&service);
    }
    #[tokio::test]
    async fn shutdown_drains_pending_start_without_republishing_running_events_or_timers() {
        let gate = Arc::new(Semaphore::new(0));
        let mut definition = Detection::new("shutdown-start");
        definition.start_gate = Some(gate.clone());
        let agent = Arc::new(definition);
        let service = service(vec![agent.clone()]);
        let events = record_events(&service);
        let starting = {
            let service = service.clone();
            tokio::spawn(async move { service.start().await })
        };
        ready(&agent.entered).await;
        let stopping = {
            let service = service.clone();
            tokio::spawn(async move { service.stop().await })
        };
        tokio::task::yield_now().await;
        assert!(service.stopping.load(Ordering::SeqCst));
        assert_eq!(agent.stops.load(Ordering::SeqCst), 0);
        gate.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), starting)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), stopping)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(service.get_states()[agent.id()], EntryState::Idle);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, AgentDiscoveryEvent::Started(_))));
        no_timers(&service);
        service.refresh("late-watch").await;
        assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn shutdown_during_availability_lookup_prevents_late_start_and_timer_recreation() {
        let gate = Arc::new(Semaphore::new(0));
        let mut definition = Detection::new("shutdown-lookup");
        definition.availability_gate = Some(gate.clone());
        let agent = Arc::new(definition);
        let service = service(vec![agent.clone()]);
        let starting = {
            let service = service.clone();
            tokio::spawn(async move { service.start().await })
        };
        ready(&agent.entered).await;
        let stopping = {
            let service = service.clone();
            tokio::spawn(async move { service.stop().await })
        };
        tokio::task::yield_now().await;
        assert!(service.stopping.load(Ordering::SeqCst));
        gate.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), starting)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), stopping)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(agent.starts.load(Ordering::SeqCst), 0);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 0);
        assert_eq!(service.get_states()[agent.id()], EntryState::Idle);
        no_timers(&service);
    }
}

#[cfg(test)]
mod migration_availability_result_tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::{Notify, Semaphore};

    struct CheckedDetection {
        fail_lookup: AtomicBool,
        fail_start: AtomicBool,
        fail_stop: AtomicBool,
        active: bool,
        starts: AtomicUsize,
        stops: AtomicUsize,
        lookups: AtomicUsize,
        next_lookup_gate: Mutex<Option<Arc<Semaphore>>>,
        entered: Notify,
    }
    impl CheckedDetection {
        fn new(active: bool) -> Arc<Self> {
            Arc::new(Self {
                fail_lookup: AtomicBool::new(false),
                fail_start: AtomicBool::new(false),
                fail_stop: AtomicBool::new(false),
                active,
                starts: AtomicUsize::new(0),
                stops: AtomicUsize::new(0),
                lookups: AtomicUsize::new(0),
                next_lookup_gate: Mutex::new(None),
                entered: Notify::new(),
            })
        }
    }
    #[async_trait]
    impl AgentDetection for CheckedDetection {
        fn id(&self) -> &str {
            "checked"
        }
        fn type_name(&self) -> &str {
            "native-checked-fixture"
        }
        fn enabled(&self) -> bool {
            true
        }
        fn watch_paths(&self) -> &[String] {
            &[]
        }
        fn poll_interval_ms(&self) -> u64 {
            60000
        }
        fn run_on_active(&self) -> bool {
            self.active
        }
        async fn is_available(&self) -> bool {
            true
        }
        async fn availability_result(&self) -> anyhow::Result<bool> {
            self.lookups.fetch_add(1, Ordering::SeqCst);
            let gate = { self.next_lookup_gate.lock().unwrap().take() };
            if let Some(gate) = gate {
                self.entered.notify_one();
                gate.acquire().await.unwrap().forget();
            }
            if self.fail_lookup.load(Ordering::SeqCst) {
                anyhow::bail!("synthetic lookup error");
            }
            Ok(true)
        }
        async fn start(&self) -> anyhow::Result<()> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            if self.fail_start.load(Ordering::SeqCst) {
                anyhow::bail!("synthetic active restart error");
            }
            Ok(())
        }
        async fn stop(&self) -> anyhow::Result<()> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            if self.fail_stop.load(Ordering::SeqCst) {
                anyhow::bail!("synthetic cleanup error");
            }
            Ok(())
        }
    }
    fn setup(
        agent: Arc<CheckedDetection>,
    ) -> (
        Arc<AgentDiscoveryService>,
        Arc<Mutex<Vec<AgentDiscoveryEvent>>>,
    ) {
        let service = Arc::new(AgentDiscoveryService::new(vec![agent]));
        let events = Arc::new(Mutex::new(Vec::new()));
        let slot = events.clone();
        service.on_event(move |event| slot.lock().unwrap().push(event));
        (service, events)
    }
    fn unexpected_count(events: &Mutex<Vec<AgentDiscoveryEvent>>) -> usize {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| {
                **e == AgentDiscoveryEvent::Stopped("checked".into(), AgentStopReason::Unexpected)
            })
            .count()
    }
    #[tokio::test]
    async fn idle_lookup_error_keeps_idle_without_start_or_unexpected_stop_and_can_recover() {
        let agent = CheckedDetection::new(false);
        agent.fail_lookup.store(true, Ordering::SeqCst);
        let (service, events) = setup(agent.clone());
        service.refresh("lookup-error").await;
        assert_eq!(agent.lookups.load(Ordering::SeqCst), 1);
        assert_eq!(service.get_states()["checked"], EntryState::Idle);
        assert_eq!(agent.starts.load(Ordering::SeqCst), 0);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 0);
        assert!(events.lock().unwrap().is_empty());
        agent.fail_lookup.store(false, Ordering::SeqCst);
        service.refresh("recovered").await;
        assert_eq!(service.get_states()["checked"], EntryState::Running);
        assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
        service.stop().await;
    }
    #[tokio::test]
    async fn running_lookup_error_stops_once_emits_unexpected_and_allows_a_later_restart() {
        let agent = CheckedDetection::new(false);
        let (service, events) = setup(agent.clone());
        service.refresh("startup").await;
        agent.fail_lookup.store(true, Ordering::SeqCst);
        service.refresh("lookup-error").await;
        assert_eq!(service.get_states()["checked"], EntryState::Idle);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert_eq!(unexpected_count(&events), 1);
        service.refresh("still-error").await;
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert_eq!(unexpected_count(&events), 1);
        agent.fail_lookup.store(false, Ordering::SeqCst);
        service.refresh("recovered").await;
        assert_eq!(service.get_states()["checked"], EntryState::Running);
        assert_eq!(agent.starts.load(Ordering::SeqCst), 2);
        service.stop().await;
        assert_eq!(agent.stops.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn active_restart_failure_is_not_discarded_or_classified_as_unavailable() {
        let agent = CheckedDetection::new(true);
        let (service, events) = setup(agent.clone());
        service.refresh("startup").await;
        agent.fail_start.store(true, Ordering::SeqCst);
        service.refresh("active").await;
        assert_eq!(agent.starts.load(Ordering::SeqCst), 2);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert_eq!(service.get_states()["checked"], EntryState::Idle);
        assert_eq!(unexpected_count(&events), 1);
        assert!(!events.lock().unwrap().iter().any(|e| matches!(
            e,
            AgentDiscoveryEvent::Stopped(_, AgentStopReason::Unavailable)
        )));
        service.stop().await;
    }
    #[tokio::test]
    async fn lookup_error_racing_shutdown_preserves_shutdown_reason_without_late_start() {
        let agent = CheckedDetection::new(false);
        let (service, events) = setup(agent.clone());
        service.refresh("startup").await;
        let gate = Arc::new(Semaphore::new(0));
        *agent.next_lookup_gate.lock().unwrap() = Some(gate.clone());
        agent.fail_lookup.store(true, Ordering::SeqCst);
        let refreshing = {
            let service = service.clone();
            tokio::spawn(async move { service.refresh("blocked-lookup").await })
        };
        tokio::time::timeout(Duration::from_secs(1), agent.entered.notified())
            .await
            .unwrap();
        let stopping = {
            let service = service.clone();
            tokio::spawn(async move { service.stop().await })
        };
        tokio::task::yield_now().await;
        assert!(service.stopping.load(Ordering::SeqCst));
        gate.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), refreshing)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), stopping)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(service.get_states()["checked"], EntryState::Idle);
        assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert_eq!(unexpected_count(&events), 0);
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| **e
                    == AgentDiscoveryEvent::Stopped("checked".into(), AgentStopReason::Shutdown))
                .count(),
            1
        );
        assert!(service.global_poll.lock().unwrap().is_none());
        service.refresh("late").await;
        assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn cleanup_error_does_not_resurrect_a_running_entry_after_lookup_failure() {
        let agent = CheckedDetection::new(false);
        let (service, events) = setup(agent.clone());
        service.refresh("startup").await;
        agent.fail_lookup.store(true, Ordering::SeqCst);
        agent.fail_stop.store(true, Ordering::SeqCst);
        service.refresh("error-with-cleanup-error").await;
        assert_eq!(service.get_states()["checked"], EntryState::Idle);
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
        assert_eq!(unexpected_count(&events), 1);
        service.stop().await;
        assert_eq!(agent.stops.load(Ordering::SeqCst), 1);
    }
}
