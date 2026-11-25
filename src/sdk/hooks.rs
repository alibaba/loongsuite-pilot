use super::abi::{OnHook, PilotJsonView, OK};
use super::agent_hooks::AgentHook;
use super::hook_protocol::*;
use super::outbox::Outbox;
use crate::interceptor::{build_interceptor_config_with, should_deploy_interceptor_hooks};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const MAX_PENDING_AUDITS: usize = 128;
const OPENCLAW_AUDIT_PAIR_TTL: Duration = Duration::from_secs(30);
const MAX_OPENCLAW_AUDIT_PAIRS: usize = 256;

pub struct Hooks {
    stop: Arc<AtomicBool>,
    listeners: Vec<JoinHandle<()>>,
    workers: Vec<JoinHandle<()>>,
    pools: Vec<Arc<WorkPool>>,
    writers: Vec<JoinHandle<()>>,
    descriptors: Vec<PathBuf>,
    pub settings: Arc<RwLock<Arc<Value>>>,
    instance: String,
}

#[derive(Default)]
struct Pending {
    jobs: VecDeque<Job>,
    active: usize,
    closed: bool,
}

#[derive(Default)]
struct WorkPool {
    pending: Mutex<Pending>,
    ready: Condvar,
}

struct Job {
    settings: Arc<Value>,
    packet: Datagram,
    peer: SocketAddr,
    received: Instant,
    deadline: Instant,
    required: bool,
    audit_slot: Option<AuditSlot>,
    response: Arc<RecentRequest>,
}

struct RecentRequest {
    peer: SocketAddr,
    received: Instant,
    deadline: Instant,
    receipt_required: bool,
    reply: Mutex<Option<Vec<u8>>>,
}

struct Endpoint {
    channel: &'static str,
    socket: UdpSocket,
    descriptor: Descriptor,
    spool: PathBuf,
    settings: Arc<RwLock<Arc<Value>>>,
    outbox: Arc<Outbox>,
    callback: Option<OnHook>,
    context: usize,
    stop: Arc<AtomicBool>,
    trace: mpsc::SyncSender<Value>,
    dropped_traces: Arc<AtomicUsize>,
    audit: mpsc::Sender<Audit>,
    audit_slots: Arc<AtomicUsize>,
    busy_alarm_pending: Arc<AtomicBool>,
}

enum Audit {
    Busy,
    Verdict {
        _slot: AuditSlot,
        activity: Value,
        blocked_prompt: Option<Box<Verdict>>,
        openclaw_pair: Option<Box<OpenClawAuditPair>>,
    },
}

enum OpenClawAuditPair {
    Middleware(OpenClawAuditKey, String),
    Persist(OpenClawAuditKey, Option<String>),
}

#[derive(Eq, Hash, PartialEq)]
struct OpenClawAuditKey {
    digest: String,
    tool_name: String,
    tool_use_id: String,
}

impl OpenClawAuditPair {
    fn from_verdict(verdict: &Verdict) -> Option<Self> {
        if verdict.status != "verdict"
            || verdict.action != "allow"
            || verdict.guardrail.as_ref().is_some_and(|guardrail| {
                guardrail.tool_action() != crate::interceptor::ToolVerdictAction::Allow
            })
        {
            return None;
        }
        let request = verdict.request.as_ref()?;
        let digest = request.raw.get("openclaw_post_tool_audit_key")?.as_str()?;
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let key = OpenClawAuditKey {
            digest: digest.to_owned(),
            tool_name: request.tool_name.clone()?,
            tool_use_id: request.tool_use_id.clone()?,
        };
        match request.raw.get("openclaw_hook")?.as_str()? {
            "tool_result_middleware" => Some(Self::Middleware(key, request.session_id.clone()?)),
            "tool_result_persist" => Some(Self::Persist(key, request.session_id.clone())),
            _ => None,
        }
    }
}

// Reserve a writer slot at admission so a slow durable writer cannot occupy
// verdict workers or make us discard an admitted request's activity.
struct AuditSlot(Arc<AtomicUsize>);

impl AuditSlot {
    fn reserve(slots: &Arc<AtomicUsize>) -> Option<Self> {
        slots
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                (count < MAX_PENDING_AUDITS).then_some(count + 1)
            })
            .ok()?;
        Some(Self(slots.clone()))
    }
}

impl Drop for AuditSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

struct Verdict {
    action: &'static str,
    reason: String,
    request: Option<crate::interceptor::HookRequest>,
    status: &'static str,
    guardrail: Option<crate::interceptor::GuardrailMetadata>,
}

impl Verdict {
    fn allow() -> Self {
        Self {
            action: "allow",
            reason: String::new(),
            request: None,
            status: "allow",
            guardrail: None,
        }
    }

    fn unavailable(status: &'static str, required: bool) -> Self {
        let mut verdict = Self::allow();
        verdict.status = status;
        if required {
            verdict.action = "block";
            verdict.reason = TEMPORARY_DENIAL.to_owned();
        }
        verdict
    }
}

impl Hooks {
    pub fn start(
        root: &Path,
        queue: Arc<Outbox>,
        settings: Value,
        callback: Option<OnHook>,
        context: usize,
        stop: Arc<AtomicBool>,
        activated: Arc<AtomicBool>,
    ) -> anyhow::Result<Self> {
        let instance = uuid::Uuid::new_v4().to_string();
        // This hosted profile has no cloud callback or SDK-owned sources.
        let channels: &[&str] = if settings["agents"] == json!(["qoder-cn"]) {
            &["local"]
        } else {
            &["cloud", "local", "observe"]
        };
        let settings = Arc::new(RwLock::new(Arc::new(settings)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
        }
        let mut hooks = Self {
            stop: stop.clone(),
            listeners: Vec::new(),
            workers: Vec::new(),
            pools: Vec::new(),
            writers: Vec::new(),
            descriptors: Vec::new(),
            settings: settings.clone(),
            instance: instance.clone(),
        };
        let (trace, trace_rx) = mpsc::sync_channel::<Value>(2048);
        // AuditSlot bounds all queued verdicts; there is at most one alarm.
        let (audit, audit_rx) = mpsc::channel::<Audit>();
        let audit_slots = Arc::new(AtomicUsize::new(0));
        let busy_alarm_pending = Arc::new(AtomicBool::new(false));
        let dropped_traces = Arc::new(AtomicUsize::new(0));
        let trace_root = root.to_owned();
        let dropped = dropped_traces.clone();
        hooks.writers.push(
            std::thread::Builder::new()
                .name("pilot-hook-trace".into())
                .spawn(move || {
                    let sdk_log = trace_root.join("hook-verdict.jsonl");
                    let client_log = trace_root.join("hook-client.jsonl");
                    for mut row in trace_rx {
                        for path in [&sdk_log, &client_log] {
                            if std::fs::symlink_metadata(path)
                                .is_ok_and(|meta| meta.is_file() && meta.len() >= TRACE_LIMIT)
                            {
                                let _ = std::fs::rename(path, path.with_extension("jsonl.1"));
                            }
                        }
                        let lost = dropped.swap(0, Ordering::Relaxed);
                        if lost > 0 {
                            row["dropped_trace_rows"] = json!(lost);
                        }
                        append_hook_trace(&sdk_log, row);
                    }
                })?,
        );
        let audit_queue = queue.clone();
        let audit_settings = settings.clone();
        let clear_busy_alarm = busy_alarm_pending.clone();
        hooks.writers.push(
            std::thread::Builder::new()
                .name("pilot-hook-audit".into())
                .spawn(move || {
                    let mut written_openclaw_pairs: HashMap<OpenClawAuditKey, (Instant, String)> =
                        HashMap::new();
                    for entry in audit_rx {
                        match entry {
                            Audit::Busy => {
                                audit_queue
                                    .alarm("SDK_HOOK_BUSY", "hook admission capacity exhausted");
                                clear_busy_alarm.store(false, Ordering::Relaxed);
                            }
                            Audit::Verdict {
                                _slot,
                                activity,
                                blocked_prompt,
                                openclaw_pair,
                            } => {
                                let openclaw_pair = openclaw_pair.map(|pair| *pair);
                                if let Some(OpenClawAuditPair::Persist(key, session)) =
                                    &openclaw_pair
                                {
                                    if written_openclaw_pairs.get(key).is_some_and(
                                        |(time, seen)| {
                                            time.elapsed() < OPENCLAW_AUDIT_PAIR_TTL
                                                && session.as_ref().is_none_or(|id| id == seen)
                                        },
                                    ) {
                                        written_openclaw_pairs.remove(key);
                                        continue;
                                    }
                                }
                                if let Some(verdict) = blocked_prompt {
                                    record_blocked_prompt(&audit_queue, &audit_settings, &verdict);
                                }
                                let written = match audit_queue
                                    .enqueue_hook(activity.to_string().as_bytes())
                                {
                                    Ok(()) => true,
                                    Err(error) => {
                                        audit_queue
                                            .alarm("SDK_HOOK_RECORD_FULL", &error.to_string());
                                        false
                                    }
                                };
                                if let Some(OpenClawAuditPair::Middleware(key, session)) =
                                    openclaw_pair.filter(|_| written)
                                {
                                    written_openclaw_pairs.retain(|_, (time, _)| {
                                        time.elapsed() < OPENCLAW_AUDIT_PAIR_TTL
                                    });
                                    if written_openclaw_pairs.len() < MAX_OPENCLAW_AUDIT_PAIRS {
                                        written_openclaw_pairs
                                            .insert(key, (Instant::now(), session));
                                    }
                                }
                            }
                        }
                    }
                })?,
        );
        // Hold startup senders only until endpoints have been made. On a
        // partial startup, drop those senders before Hooks joins its writers.
        let endpoints = (|| -> anyhow::Result<()> {
            for &channel in channels {
                let (workers, capacity) = if channel == "cloud" {
                    (CLOUD_WORKERS, CLOUD_IN_FLIGHT)
                } else {
                    (8, 8)
                };
                let spool = root.join(format!("hook-requests-{channel}"));
                crate::utils::source_access::private_path(&spool)?;
                std::fs::create_dir_all(&spool)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&spool, std::fs::Permissions::from_mode(0o700))?;
                }
                let socket = UdpSocket::bind("127.0.0.1:0")?;
                socket.set_read_timeout(Some(Duration::from_millis(100)))?;
                let descriptor = Descriptor {
                    schema: 2,
                    pid: std::process::id(),
                    port: socket.local_addr()?.port(),
                    token: format!(
                        "{}{}",
                        uuid::Uuid::new_v4().simple(),
                        uuid::Uuid::new_v4().simple()
                    ),
                    instance: instance.clone(),
                    request_receipts: true,
                    cloud_capacity: channel == "cloud",
                };
                let path = root.join(format!("sdk-hooks-{channel}.json"));
                atomic_descriptor(&path, &descriptor)?;
                hooks.descriptors.push(path);
                let pool = Arc::new(WorkPool::default());
                hooks.pools.push(pool.clone());
                let endpoint = Arc::new(Endpoint {
                    channel,
                    socket,
                    descriptor,
                    spool,
                    settings: settings.clone(),
                    outbox: queue.clone(),
                    callback,
                    context,
                    stop: stop.clone(),
                    trace: trace.clone(),
                    dropped_traces: dropped_traces.clone(),
                    audit: audit.clone(),
                    audit_slots: audit_slots.clone(),
                    busy_alarm_pending: busy_alarm_pending.clone(),
                });
                for _ in 0..workers {
                    let (endpoint, pool) = (endpoint.clone(), pool.clone());
                    hooks.workers.push(
                        std::thread::Builder::new()
                            .name(format!("pilot-hook-{channel}-worker"))
                            .spawn(move || endpoint.work(&pool))?,
                    );
                }
                let activated = activated.clone();
                hooks.listeners.push(
                    std::thread::Builder::new()
                        .name(format!("pilot-hook-{channel}"))
                        .spawn(move || endpoint.receive(&pool, &activated, workers, capacity))?,
                );
            }
            Ok(())
        })();
        drop(trace);
        drop(audit);
        endpoints?;
        Ok(hooks)
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for pool in &self.pools {
            let mut pending = pool.pending.lock().unwrap();
            pending.closed = true;
            pending.jobs.clear();
            pool.ready.notify_all();
        }
        for thread in self
            .listeners
            .drain(..)
            .chain(self.workers.drain(..))
            .chain(self.writers.drain(..))
        {
            let _ = thread.join();
        }
        for path in &self.descriptors {
            if std::fs::read(path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Descriptor>(&b).ok())
                .is_some_and(|d| d.instance == self.instance)
            {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

impl Drop for Hooks {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Endpoint {
    fn receive(&self, pool: &WorkPool, activated: &AtomicBool, workers: usize, capacity: usize) {
        let mut buffer = [0u8; 4096];
        let mut seen = HashMap::<String, Arc<RecentRequest>>::new();
        while !self.stop.load(Ordering::SeqCst) {
            if !activated.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            let Ok((len, peer)) = self.socket.recv_from(&mut buffer) else {
                continue;
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            let Ok(packet) = serde_json::from_slice::<Datagram>(&buffer[..len]) else {
                continue;
            };
            if packet.schema != 2
                || !constant_time_eq(packet.token.as_bytes(), self.descriptor.token.as_bytes())
                || packet.id.len() != 40
                || !packet.id.bytes().all(|b| b.is_ascii_hexdigit())
                || packet.length > MAX_REQUEST
                || packet.remaining_ms == 0
                || (packet.capacity_probe
                    && (!self.descriptor.cloud_capacity || packet.length != 0))
            {
                continue;
            }
            let settings = self.settings.read().unwrap().clone();
            if packet.managed && packet.agent == "codex" && settings["embedded_codex"] == true {
                // A client may have cached commands from a rolled-back deployment.
                let Some(channel) = settings["codex_hook_channel"].as_str() else {
                    continue;
                };
                let expected = if super::agent_hooks::AgentHook::for_wire_id("codex")
                    .expect("Codex Hook")
                    .supports_blocking(&packet.event)
                {
                    channel
                } else {
                    "observe"
                };
                if self.channel != expected {
                    continue;
                }
            }
            seen.retain(|_, prior| prior.received.elapsed() < Duration::from_secs(5));
            if let Some(prior) = seen.get(&packet.id) {
                // Retransmission is only supported by the paired cloud bin.
                // Reply to the original peer without running the callback again.
                if self.descriptor.cloud_capacity
                    && packet.want_receipt
                    && prior.peer == peer
                    && Instant::now() < prior.deadline
                {
                    let reply = prior.reply.lock().unwrap();
                    if let Some(bytes) = reply.as_ref() {
                        let _ = self.socket.send_to(bytes, peer);
                    } else {
                        self.send_receipt(&packet.id, peer, prior.receipt_required);
                    }
                }
                continue;
            }
            let received = Instant::now();
            let age = (chrono::Utc::now().timestamp_millis().max(0) as u64)
                .saturating_sub(packet.t0_unix_ms);
            let remaining = u64::from(packet.remaining_ms).min(DEADLINE_MS.saturating_sub(age));
            if remaining == 0 {
                continue;
            }
            let required = self.channel == "cloud"
                && self.callback.is_some()
                && packet.event == "PreToolUse"
                && may_block(&packet, &settings, self.channel);
            let deadline = received + Duration::from_millis(remaining);
            let response = Arc::new(RecentRequest {
                peer,
                received,
                deadline,
                receipt_required: required,
                reply: Mutex::new(None),
            });
            let mut job = Job {
                settings,
                packet,
                peer,
                received,
                deadline,
                required,
                audit_slot: None,
                response: response.clone(),
            };
            let rate_limited = seen.len() >= 1024;
            if !rate_limited {
                seen.insert(job.packet.id.clone(), response);
            }
            let mut pending = pool.pending.lock().unwrap();
            if pending.closed {
                break;
            }
            let in_flight = pending.active + pending.jobs.len();
            self.log(&job, "received", json!({"in_flight":in_flight}));
            if job.packet.capacity_probe || in_flight >= capacity || rate_limited {
                drop(pending);
                self.reject_busy(&job, "overload");
                continue;
            }
            if self.channel != "observe" {
                job.audit_slot = AuditSlot::reserve(&self.audit_slots);
                if job.audit_slot.is_none() {
                    drop(pending);
                    self.reject_busy(&job, "audit_overload");
                    continue;
                }
            }
            if job.packet.want_receipt && !self.send_receipt(&job.packet.id, peer, job.required) {
                self.log(&job, "receipt_failed", Value::Null);
                if !self.descriptor.cloud_capacity {
                    continue;
                }
            }
            let queued = (in_flight + 1).saturating_sub(workers);
            self.log(
                &job,
                "admitted",
                json!({"queued":queued, "in_flight":in_flight+1}),
            );
            pending.jobs.push_back(job);
            pool.ready.notify_one();
        }
    }

    fn work(&self, pool: &WorkPool) {
        let scope = crate::utils::source_access::SourceScope::new(Vec::new(), 0, 0);
        if let Some(root) = self.spool.parent() {
            scope.set_log(root.join("hook.log"));
        }
        crate::utils::source_access::install(Some(scope));
        loop {
            let mut job = {
                let mut pending = pool
                    .ready
                    .wait_while(pool.pending.lock().unwrap(), |pending| {
                        pending.jobs.is_empty() && !pending.closed
                    })
                    .unwrap();
                if pending.closed {
                    return;
                }
                let job = pending.jobs.pop_front().unwrap();
                pending.active += 1;
                self.log(&job, "started", json!({"active":pending.active}));
                job
            };
            if let Some(audit) = self.decide(&mut job) {
                let _ = self.audit.send(audit);
            }
            pool.pending.lock().unwrap().active -= 1;
        }
    }

    fn decide(&self, job: &mut Job) -> Option<Audit> {
        let started = Instant::now();
        let cutoff = if self.descriptor.cloud_capacity {
            job.deadline - Duration::from_millis(2 * REPLY_MARGIN_MS)
        } else {
            job.deadline
        };
        let verdict = if started >= cutoff {
            let _ = std::fs::remove_file(self.spool.join(&job.packet.id));
            Verdict::unavailable("expired", job.required)
        } else {
            process(self, job, cutoff)
        };
        let packet = &job.packet;
        self.outbox.record_hook(
            &packet.agent,
            &format!("{}:{}", self.channel, packet.event),
            started.elapsed().as_secs_f64() * 1000.0,
        );
        let late = Instant::now() >= job.deadline;
        let sent = if !late && !self.stop.load(Ordering::SeqCst) {
            if verdict.status == "verdict" {
                record_tool_verdict(
                    &self.outbox,
                    &job.settings,
                    &verdict,
                    if self.channel == "local" {
                        self.callback
                    } else {
                        None
                    },
                    self.context,
                    cutoff,
                );
            }
            self.reply(job, &verdict)
        } else {
            self.log(
                job,
                if late { "late" } else { "stopped" },
                json!({"status":verdict.status}),
            );
            false
        };
        let slot = job.audit_slot.take()?;
        let openclaw_pair = if sent
            && self.channel == "local"
            && packet.agent == "openclaw"
            && packet.event == "PostToolUse"
        {
            OpenClawAuditPair::from_verdict(&verdict).map(Box::new)
        } else {
            None
        };
        let activity = json!({
            "event.id":uuid::Uuid::new_v4().to_string(), "event.name":"other",
            "time_unix_nano":chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0).to_string(),
            "gen_ai.agent.type":packet.agent, "gen_ai.session.id":verdict.request.as_ref()
                .and_then(|r|r.session_id.as_deref()).unwrap_or(""),
            "gen_ai.provider.name":"pilot", "event.kind":"interceptor.result",
            "hook.channel":self.channel, "hook.request_id":packet.id,
            "hook.action":verdict.action,
            "hook.reason":if self.channel == "local" { "" } else { verdict.reason.as_str() },
            "hook.status":verdict.status, "hook.late":late,
            "version":env!("CARGO_PKG_VERSION"), "user.id":self.outbox.identity.read().unwrap()["user_id"],
        });
        let blocked_prompt = (sent
            && verdict.status == "verdict"
            && verdict.action == "block"
            && packet.event == "UserPromptSubmit")
            .then(|| Box::new(verdict));
        Some(Audit::Verdict {
            _slot: slot,
            activity,
            blocked_prompt,
            openclaw_pair,
        })
    }

    fn reject_busy(&self, job: &Job, status: &'static str) {
        self.reply(job, &Verdict::unavailable(status, job.required));
        if !self.busy_alarm_pending.swap(true, Ordering::Relaxed) {
            let _ = self.audit.send(Audit::Busy);
        }
    }

    fn reply(&self, job: &Job, verdict: &Verdict) -> bool {
        let mut sent = false;
        if Instant::now() < job.deadline {
            let reply = json!({
                "id":job.packet.id, "instance":self.descriptor.instance, "action":verdict.action,
                "reason":verdict.reason, "status":verdict.status,
            });
            if let Some(bytes) = serde_json::to_vec(&reply)
                .ok()
                .filter(|bytes| bytes.len() <= MAX_REPLY)
            {
                if self.descriptor.cloud_capacity && job.packet.want_receipt {
                    let mut cached = job.response.reply.lock().unwrap();
                    sent = self.socket.send_to(&bytes, job.peer).is_ok();
                    *cached = Some(bytes);
                } else {
                    sent = self.socket.send_to(&bytes, job.peer).is_ok();
                }
            }
        }
        self.log(
            job,
            "reply",
            json!({"status":verdict.status,"action":verdict.action,"sent":sent}),
        );
        sent
    }

    fn send_receipt(&self, id: &str, peer: SocketAddr, required: bool) -> bool {
        let receipt = json!({
            "id": id, "instance": self.descriptor.instance, "received": true, "required": required,
        });
        serde_json::to_vec(&receipt).is_ok_and(|bytes| self.socket.send_to(&bytes, peer).is_ok())
    }

    fn log(&self, job: &Job, stage: &str, detail: Value) {
        let row = json!({
            "id":job.packet.id, "instance":self.descriptor.instance,
            "channel":self.channel, "stage":stage,
            "since_receive_ms":job.received.elapsed().as_millis(),
            "at_unix_ms":chrono::Utc::now().timestamp_millis(), "detail":detail,
        });
        if self.trace.try_send(row).is_err() {
            self.dropped_traces.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn atomic_descriptor(path: &Path, descriptor: &Descriptor) -> anyhow::Result<()> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| anyhow::anyhow!("descriptor parent"))?,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(&serde_json::to_vec(descriptor)?)?;
    file.persist(path)?;
    Ok(())
}
fn may_block(packet: &Datagram, trusted: &Value, channel: &str) -> bool {
    AgentHook::for_wire_id(&packet.agent).is_some_and(|adapter| {
        adapter.supports_channel(channel)
            && adapter.supports_blocking(&packet.event)
            && trusted["agents"]
                .as_array()
                .is_some_and(|list| list.iter().any(|a| a == adapter.policy_id()))
            && trusted["sync_wait_enabled"].as_bool().unwrap_or(true)
            && trusted["blocking_agents"]
                .as_array()
                .is_none_or(|list| list.iter().any(|a| a == &packet.agent))
    })
}

pub(super) fn update_local_status(queue: &Outbox, policy: &Value) {
    let config = build_interceptor_config_with(policy.get("local"), |_| None);
    *queue.local_hook_config.lock().unwrap() =
        should_deploy_interceptor_hooks(&config).then_some(0);
}

fn process(endpoint: &Endpoint, job: &Job, deadline: Instant) -> Verdict {
    let packet = &job.packet;
    let Endpoint {
        spool,
        channel,
        callback,
        context,
        outbox: queue,
        ..
    } = endpoint;
    let (channel, callback, context) = (*channel, *callback, *context);
    let allow = Verdict::allow;
    let input_error = || Verdict::unavailable("input_unavailable", job.required);
    let path = spool.join(&packet.id);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(_) => return input_error(),
    };
    if !metadata.is_file()
        || metadata.len() as usize != packet.length
        || metadata.file_type().is_symlink()
    {
        return input_error();
    }
    let bytes = (|| -> std::io::Result<Vec<u8>> {
        use std::io::Read;
        let file = crate::utils::source_access::open_under(&path, spool)?;
        let mut body = Vec::new();
        file.take((MAX_REQUEST + 1) as u64).read_to_end(&mut body)?;
        Ok(body)
    })();
    let body = match bytes {
        Ok(bytes) if bytes.len() <= MAX_REQUEST => bytes,
        _ => return input_error(),
    };
    let _ = std::fs::remove_file(path);
    let payload = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(object)) => object,
        _ => return input_error(),
    };
    let trusted = job.settings.as_ref();
    let Some(adapter) = AgentHook::for_wire_id(&packet.agent) else {
        return allow();
    };
    if !adapter.supports_channel(channel)
        || !trusted
            .get("agents")
            .and_then(Value::as_array)
            .is_some_and(|agents| agents.iter().any(|a| a == adapter.policy_id()))
    {
        return allow();
    }

    let accepted = adapter.wakeup(&payload, &packet.event, channel, trusted, queue);
    if channel == "observe" {
        if accepted && packet.event != "SubagentStop" && trusted["relay_host_verdicts"] == true {
            let session = payload
                .get("session_id")
                .or_else(|| payload.get("conversation_id"))
                .and_then(Value::as_str);
            let traceparent = payload
                .get(QODER_OBSERVE_CONTEXT)
                .and_then(|value| value["TRACEPARENT"].as_str());
            if let (Some(callback), Some(session), Some(traceparent)) =
                (callback, session, traceparent)
            {
                notify_shell(
                    queue,
                    callback,
                    context,
                    deadline,
                    json!({
                        "kind": "qoder_upstream",
                        "session_id": session,
                        "traceparent": traceparent,
                    }),
                );
            }
        }
        return allow();
    }

    let blocking = may_block(packet, trusted, channel);
    let request = adapter.parse(&payload, &packet.event);
    let prompt_key = (channel == "local" && blocking && trusted["managed_host_rules"] == true)
        .then(|| {
            request
                .as_ref()
                .and_then(crate::interceptor::prompt_verdict::PromptKey::for_request)
        })
        .flatten();
    let prompt_at = chrono::Utc::now().timestamp_millis();
    let relay_prompt = callback.filter(|_| trusted["relay_host_verdicts"] == true);
    let record_prompt =
        |key: &crate::interceptor::prompt_verdict::PromptKey,
         guardrail: Option<crate::interceptor::GuardrailMetadata>| {
            queue
                .verdicts
                .put_prompt(key.clone(), guardrail.clone(), prompt_at);
            if let Some(callback) = relay_prompt {
                notify_shell(
                    queue,
                    callback,
                    context,
                    deadline,
                    json!({
                        "kind":"prompt_verdict","key":key,"guardrail":guardrail,"at":prompt_at,
                    }),
                );
            }
        };
    if let Some(key) = &prompt_key {
        record_prompt(key, None);
    }
    let verdict = if channel == "cloud" {
        let Some(callback) = callback else {
            return allow();
        };
        let mut normalized = payload.clone();
        if let Some(request) = request.as_ref() {
            normalized.insert("session_id".into(), json!(request.session_id));
            normalized.insert("tool_name".into(), json!(request.tool_name));
            normalized.insert("tool_input".into(), json!(request.tool_input));
            normalized.insert("prompt_text".into(), json!(request.prompt));
            normalized.insert("response_text".into(), json!(request.tool_response));
            normalized.insert("cwd".into(), json!(request.cwd));
        }
        if let Some(command) = normalized
            .get("tool_input")
            .and_then(|i| i.get("command"))
            .cloned()
        {
            normalized.insert("command".into(), command);
        }
        if let Some(path) = normalized
            .get("tool_input")
            .and_then(|i| i.get("file_path").or_else(|| i.get("path")))
            .cloned()
        {
            normalized.insert("file_path".into(), path);
        }
        normalized.insert("t0_unix_ms".into(), json!(packet.t0_unix_ms));
        normalized.insert("trace_id".into(), json!(packet.id));
        normalized.insert("client_event_id".into(), json!(packet.id));
        normalized.insert("agent".into(), json!(packet.agent));
        normalized.insert("event".into(), json!(packet.event));
        normalized.insert("supports_blocking".into(), json!(blocking));
        normalized.insert("truncated".into(), json!(false));
        let request = match serde_json::to_vec(&normalized) {
            Ok(bytes) => bytes,
            Err(_) => return allow(),
        };
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u32;
        if remaining == 0 {
            return Verdict::unavailable("expired", job.required && blocking);
        }
        let mut reply = vec![0u8; MAX_REPLY];
        let mut length = 0usize;
        let callback_started = Instant::now();
        endpoint.log(job, "callback_start", json!({"remaining_ms":remaining}));
        queue.callbacks.fetch_add(1, Ordering::SeqCst);
        // SAFETY: SDK-owned input/output buffers and host-retained context. No
        // collector, policy, or queue lock is held during external code.
        let result = unsafe {
            callback(
                context as *mut _,
                PilotJsonView::from_bytes(&request),
                remaining,
                reply.as_mut_ptr(),
                reply.len(),
                &mut length,
            )
        };
        queue.callbacks.fetch_sub(1, Ordering::SeqCst);
        endpoint.log(
            job,
            "callback_end",
            json!({
                "duration_ms":callback_started.elapsed().as_millis(), "return_code":result,
            }),
        );
        let required = job.required && blocking;
        if Instant::now() >= deadline {
            return Verdict::unavailable("expired", required);
        }
        if result != OK || length > reply.len() {
            return Verdict::unavailable("callback_failed", required);
        }
        match serde_json::from_slice::<Value>(&reply[..length]) {
            Ok(value) if reply_action(&value).is_some() => value,
            _ => return Verdict::unavailable("callback_failed", required),
        }
    } else {
        let Some(request) = request.as_ref() else {
            return allow();
        };
        let started = Instant::now();
        let config = build_interceptor_config_with(trusted.get("local"), |_| None);
        let result = if blocking && trusted["managed_host_rules"] == true {
            callback
                .and_then(|callback| managed_verdict(queue, callback, context, deadline, request))
        } else {
            Some(json!({"action":"allow","matched":false}))
        };
        let unavailable = result.is_none();
        let verdict = result.unwrap_or_else(|| json!({"action":"allow","failOpen":true}));
        if should_deploy_interceptor_hooks(&config) {
            queue.local_hook_stats.lock().unwrap().record(
                &verdict,
                started.elapsed().as_secs_f64() * 1_000.0,
                unavailable,
                endpoint.stop.load(Ordering::Relaxed),
            );
        }
        if unavailable && packet.agent == "openclaw" {
            return Verdict::unavailable("callback_failed", false);
        }
        verdict
    };
    let guardrail = (channel == "local" && trusted["managed_host_rules"] == true)
        .then(|| crate::interceptor::GuardrailMetadata::from_verdict(&verdict));
    if let Some(key) = prompt_key {
        if verdict["action"] == "allow"
            && (verdict["failOpen"] != true || verdict["matched"] == true)
            && Instant::now() < deadline
            && !endpoint.stop.load(Ordering::Relaxed)
        {
            record_prompt(&key, guardrail.clone());
        }
    }
    match reply_action(&verdict) {
        Some(("block", reason)) if blocking => Verdict {
            action: "block",
            reason: reason.chars().take(512).collect(),
            request,
            status: "verdict",
            guardrail,
        },
        Some(("allow", _)) => Verdict {
            request,
            status: if packet.agent == "openclaw" && verdict["failOpen"] == true {
                "fail_open"
            } else {
                "verdict"
            },
            guardrail,
            ..Verdict::allow()
        },
        _ => allow(),
    }
}

fn managed_verdict(
    queue: &Outbox,
    callback: OnHook,
    context: usize,
    deadline: Instant,
    request: &crate::interceptor::HookRequest,
) -> Option<Value> {
    let mut normalized = request.clone();
    normalized.raw.clear();
    let row = serde_json::to_vec(&json!({"kind":"managed_local","request": normalized})).ok()?;
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u32;
    if remaining == 0 {
        return None;
    }
    let mut reply = vec![0; MAX_REPLY];
    let mut used = 0;
    queue.callbacks.fetch_add(1, Ordering::SeqCst);
    // SAFETY: the callback and these bounded buffers remain live until return.
    let status = unsafe {
        callback(
            context as *mut _,
            PilotJsonView::from_bytes(&row),
            remaining,
            reply.as_mut_ptr(),
            reply.len(),
            &mut used,
        )
    };
    queue.callbacks.fetch_sub(1, Ordering::SeqCst);
    if status != OK || used > reply.len() || Instant::now() >= deadline {
        return None;
    }
    serde_json::from_slice(&reply[..used]).ok()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn record_tool_verdict(
    queue: &Outbox,
    settings: &Value,
    result: &Verdict,
    callback: Option<OnHook>,
    context: usize,
    deadline: Instant,
) {
    use crate::interceptor::{
        HookEventName, ToolInterceptPhase, ToolVerdictAction, ToolVerdictKey,
    };
    let Some(request) = result.request.as_ref() else {
        return;
    };
    let phase = match request.event {
        HookEventName::PreToolUse => Some(ToolInterceptPhase::PreToolUse),
        HookEventName::PostToolUse => Some(ToolInterceptPhase::PostToolUse),
        _ => None,
    };
    if let Some((phase, tool_use_id)) =
        phase.zip(request.tool_use_id.as_ref().filter(|s| !s.is_empty()))
    {
        let key = ToolVerdictKey {
            session_id: request.session_id.clone(),
            tool_use_id: tool_use_id.clone(),
            phase,
        };
        let now = chrono::Utc::now().timestamp_millis();
        let action = if result.action == "block" {
            ToolVerdictAction::Block
        } else {
            result
                .guardrail
                .as_ref()
                .map_or(ToolVerdictAction::Allow, |guardrail| {
                    guardrail.tool_action()
                })
        };
        // Both independent chains may decide the same tool operation. Retain a
        // block when its peer later allows; one allow cannot erase a block.
        queue
            .verdicts
            .put_sdk_verdict(&key, action, result.guardrail.clone(), now);
        if let Some(callback) = callback.filter(|_| settings["relay_host_verdicts"] == true) {
            let verdict = json!({
                "session_id": key.session_id,
                "tool_use_id": key.tool_use_id,
                "phase": phase,
                "action": action,
                "guardrail": result.guardrail,
            });
            notify_shell(queue, callback, context, deadline, verdict);
        }
    }
}

fn notify_shell(queue: &Outbox, callback: OnHook, context: usize, deadline: Instant, row: Value) {
    let Ok(bytes) = serde_json::to_vec(&row) else {
        return;
    };
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u32;
    if remaining == 0 {
        return;
    }
    queue.callbacks.fetch_add(1, Ordering::SeqCst);
    let mut reply = [0; 1];
    let mut length = 0;
    // SAFETY: all buffers remain valid until the host callback returns.
    unsafe {
        callback(
            context as *mut _,
            PilotJsonView::from_bytes(&bytes),
            remaining,
            reply.as_mut_ptr(),
            reply.len(),
            &mut length,
        );
    }
    queue.callbacks.fetch_sub(1, Ordering::SeqCst);
}

fn record_blocked_prompt(queue: &Outbox, settings: &RwLock<Arc<Value>>, result: &Verdict) {
    use crate::interceptor::HookEventName;
    let Some(request) = result.request.as_ref() else {
        return;
    };
    if result.action == "block"
        && (request.agent.is_qoder_cn()
            || matches!(
                request.agent,
                crate::interceptor::InterceptorAgent::Qoder
                    | crate::interceptor::InterceptorAgent::QoderCli
            ))
        && request.event == HookEventName::UserPromptSubmit
    {
        let mut entry = crate::interceptor::build_blocked_qoder_prompt_entry(request, None);
        if let Some(guardrail) = &result.guardrail {
            guardrail.apply(&mut entry);
        }
        let policy_id = AgentHook::for_wire_id(request.agent.as_str())
            .map(AgentHook::policy_id)
            .expect("Qoder Hook adapter");
        let (host, mask) = {
            let settings = settings.read().unwrap();
            entry.user_id = settings["user_id"].as_str().unwrap_or("").to_owned();
            (
                settings["collector_plans"][policy_id]
                    .get("pilot_host")
                    .cloned(),
                settings["mask"].clone(),
            )
        };
        if let Some(host) = host
            .and_then(|state| serde_json::from_value::<super::policy::PilotHostState>(state).ok())
        {
            let Ok(mut workspace) = crate::core::WorkspacePolicy::new(
                &host.exclude_workspaces,
                Some(
                    host.data_dir
                        .join("state/workspace-exclusions")
                        .to_string_lossy()
                        .into_owned(),
                ),
            ) else {
                return;
            };
            if !workspace.allows(
                &crate::normalization::entry_to_object(&entry),
                "interceptor",
            ) {
                return;
            }
            if host.capture_message_content == Some(false) {
                crate::normalization::agent_content_policy::strip_agent_message_content(&mut entry);
            }
        }
        let mask = serde_json::from_value::<crate::types::MaskConfig>(mask).ok();
        let entry = mask
            .as_ref()
            .map(|mask| {
                crate::mask::mask_agent_activity_entry(&entry, mask, None, None).into_owned()
            })
            .unwrap_or(entry);
        if let Ok(bytes) = serde_json::to_vec(&entry) {
            if let Err(error) = queue.enqueue_hook(&bytes) {
                queue.alarm("SDK_BLOCKED_PROMPT_QUEUE", &error.to_string());
            }
        }
    }
}
