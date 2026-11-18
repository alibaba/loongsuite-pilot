use super::*;
use crate::flushers::hermes_process_identity::{HermesOwner, ProcessNamespace};

const QUIET_MS: i64 = 5 * 60_000;
const CONFIRM_MS: i64 = 60_000;
const CHECK_INTERVAL: Duration = Duration::from_secs(30);
const PROCESS_BUDGET: usize = 32;
const DRAIN_BUDGET: usize = 2;
const GROUP_LIMIT: usize = 10_000;

pub(super) type SourceProbe = Arc<
    dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

#[derive(Default)]
pub(super) struct RecoveryState {
    pub(super) deferred: IndexMap<String, TurnBuffer>,
    groups: HashMap<String, String>,
    sources: HashMap<String, usize>,
    overflow: bool,
    cursor: usize,
}

impl RecoveryState {
    pub(super) fn track(&mut self, key: &str, source: &str) {
        if self.groups.contains_key(key) {
            return;
        }
        if self.groups.len() >= GROUP_LIMIT {
            self.report_overflow();
            return;
        }
        self.groups.insert(key.to_string(), source.to_string());
        *self.sources.entry(source.to_string()).or_default() += 1;
    }

    pub(super) fn release(&mut self, key: &str) {
        if let Some(source) = self.groups.remove(key) {
            if let Some(count) = self.sources.get_mut(&source) {
                *count -= 1;
                if *count == 0 {
                    self.sources.remove(&source);
                }
            }
        }
    }

    pub(super) fn protects(&self, source: &str) -> bool {
        self.overflow || self.sources.contains_key(source)
    }

    pub(super) fn defer(&mut self, mut buffer: TurnBuffer) {
        if self.deferred.len() >= GROUP_LIMIT {
            self.report_overflow();
            return;
        }
        buffer.completed = false;
        buffer.hermes_abandoned = false;
        buffer.records = Vec::new();
        buffer.record_index = HashMap::new();
        buffer.spilled_records = 1;
        buffer.spilled_event_ids = None;
        buffer.resident_bytes = 0;
        self.deferred.insert(buffer.key.clone(), buffer);
    }

    fn report_overflow(&mut self) {
        if !self.overflow {
            self.overflow = true;
            create_logger("otlp-trace-flusher").warn(
                "Hermes recovery limit reached; retaining producer sources until restart",
                None,
            );
        }
    }
}

#[derive(Default)]
pub(super) struct OwnerState {
    owner: Option<HermesOwner>,
    uncertain: bool,
    dead_since: Option<i64>,
    next_drain: i64,
    drain_failures: u32,
}

impl OwnerState {
    pub(super) fn observe(&mut self, entry: &AgentActivityEntry) {
        match HermesOwner::from_entry(entry) {
            Some(owner) if self.owner.as_ref().is_none_or(|old| old == &owner) => {
                self.owner = Some(owner);
            }
            _ => self.uncertain = true,
        }
        self.dead_since = None;
        self.next_drain = 0;
        self.drain_failures = 0;
    }

    pub(super) fn owner(&self) -> Option<&HermesOwner> {
        if self.uncertain {
            None
        } else {
            self.owner.as_ref()
        }
    }

    fn ready(&mut self, dead: bool, now: i64) -> bool {
        if !dead {
            self.dead_since = None;
            return false;
        }
        let first = *self.dead_since.get_or_insert(now);
        now - first >= CONFIRM_MS && now >= self.next_drain
    }

    fn backoff(&mut self, now: i64) {
        self.drain_failures = (self.drain_failures + 1).min(5);
        self.next_drain = now + (30_000 * 2_i64.pow(self.drain_failures - 1)).min(300_000);
    }
}

impl OtlpTraceFlusher {
    pub(crate) fn with_hermes_source_probe(
        self,
        probe: impl Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        if cfg!(target_os = "linux") {
            let inner = Arc::downgrade(&self.inner);
            let probe: SourceProbe = Arc::new(probe);
            let task = tokio::spawn(async move {
                let mut tick = tokio::time::interval(CHECK_INTERVAL);
                tick.tick().await;
                loop {
                    tick.tick().await;
                    let Some(inner) = inner.upgrade() else {
                        break;
                    };
                    inner.recover_hermes(&probe).await;
                }
            });
            *self.inner.hermes_timer.lock().expect("Hermes owner timer") = Some(task);
        }
        self
    }

    pub(crate) fn has_pending_hermes_source(&self, source: &str) -> bool {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .hermes
            .protects(source)
    }
}

struct Candidate {
    key: String,
    owner: HermesOwner,
    last_activity: i64,
}

impl Candidate {
    fn buffer<'a>(&self, state: &'a mut OtlpState) -> Option<&'a mut TurnBuffer> {
        if state.batch_depth > 0 {
            return None;
        }
        let buffer = state
            .buffers
            .get_mut(&self.key)
            .or_else(|| state.hermes.deferred.get_mut(&self.key))?;
        (!buffer.completed
            && buffer.last_activity_ms == self.last_activity
            && buffer.hermes_owner.owner() == Some(&self.owner))
        .then_some(buffer)
    }
}

impl OtlpInner {
    pub(super) async fn recover_hermes(self: &Arc<Self>, probe: &SourceProbe) {
        self.recover_hermes_at(probe, now_ms()).await;
    }

    pub(super) async fn recover_hermes_at(self: &Arc<Self>, probe: &SourceProbe, now: i64) {
        let candidates = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.batch_depth > 0 {
                return;
            }
            let ready: Vec<_> = state
                .buffers
                .values()
                .chain(state.hermes.deferred.values())
                .filter_map(|buffer| {
                    if buffer.completed
                        || buffer.journal_key.is_none()
                        || now - buffer.last_activity_ms < QUIET_MS
                    {
                        return None;
                    }
                    Some(Candidate {
                        key: buffer.key.clone(),
                        owner: buffer.hermes_owner.owner()?.clone(),
                        last_activity: buffer.last_activity_ms,
                    })
                })
                .collect();
            if ready.is_empty() {
                return;
            }
            let start = state.hermes.cursor % ready.len();
            let count = ready.len().min(PROCESS_BUDGET);
            state.hermes.cursor = state.hermes.cursor.wrapping_add(count);
            let mut ready = ready;
            ready.rotate_left(start);
            ready.truncate(count);
            ready
        };
        let Some(namespace) = ProcessNamespace::current() else {
            return;
        };
        let mut checked = HashMap::new();
        let mut drained = HashMap::new();
        for candidate in candidates {
            let dead = *checked
                .entry(candidate.owner.clone())
                .or_insert_with(|| candidate.owner.proven_dead(&namespace));
            let can_probe = {
                let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                candidate
                    .buffer(&mut state)
                    .is_some_and(|buffer| buffer.hermes_owner.ready(dead, now))
            };
            if !can_probe {
                continue;
            }
            let source = &candidate.owner.source;
            let source_drained = if let Some(drained) = drained.get(source) {
                *drained
            } else if drained.len() < DRAIN_BUDGET {
                let result = probe(source.clone()).await;
                drained.insert(source.clone(), result);
                result
            } else {
                continue;
            };
            let buffer = {
                let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                let Some(buffer) = candidate.buffer(&mut state) else {
                    continue;
                };
                if !source_drained {
                    buffer.hermes_owner.backoff(now);
                    continue;
                }
                buffer.completed = true;
                buffer.hermes_abandoned = true;
                state.flushed.insert(candidate.key.clone());
                state
                    .buffers
                    .shift_remove(&candidate.key)
                    .or_else(|| state.hermes.deferred.shift_remove(&candidate.key))
            };
            if let Some(buffer) = buffer {
                if let Err(error) = self.finish_buffer(buffer, false).await {
                    create_logger("otlp-trace-flusher").warn(&error.to_string(), None);
                }
            }
        }
    }
}
