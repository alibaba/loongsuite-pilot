use super::hooks::Hooks;
use super::{
    abi::*,
    outbox::Outbox,
    policy::{Init, Policy},
    runtime::Collector,
};
use fs2::FileExt;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_void, CString};
use std::fs::{File, OpenOptions};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}
impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }
}
#[derive(Clone)]
struct Status {
    phase: Phase,
    version: String,
    agents: Value,
    error: Option<String>,
}
struct Notification {
    start: bool,
    result: i32,
    report: Value,
}
enum Command {
    Apply(Box<Policy>, mpsc::SyncSender<Result<Value, String>>),
    Stop(u32),
}
#[derive(Clone, Copy)]
struct Callbacks {
    activity: OnBatch,
    monitoring: OnBatch,
    hook: Option<OnHook>,
    start: OnLifecycle,
    stop: OnLifecycle,
    context: usize,
}
struct Instance {
    key: usize,
    init: Init,
    status: Mutex<Status>,
    callbacks: Callbacks,
    stop_requested: Arc<AtomicBool>,
    dispatching: AtomicBool,
    stop_notified: AtomicBool,
    start_enqueued: AtomicBool,
    commands: mpsc::Sender<Command>,
    notifications: Mutex<VecDeque<Notification>>,
    queue: Mutex<Option<Arc<Outbox>>>,
    activated: Arc<AtomicBool>,
    flow: Mutex<crate::metrics::DataflowSnapshot>,
    thread: Mutex<Option<JoinHandle<()>>>,
}
static INSTANCES: OnceLock<Mutex<HashMap<usize, Arc<Instance>>>> = OnceLock::new();
static NEXT: AtomicUsize = AtomicUsize::new(1);
fn instances() -> &'static Mutex<HashMap<usize, Arc<Instance>>> {
    INSTANCES.get_or_init(Default::default)
}
fn get(handle: *mut PilotHandle) -> Result<Arc<Instance>, i32> {
    instances()
        .lock()
        .unwrap()
        .get(&(handle as usize))
        .cloned()
        .ok_or(BAD_ARGUMENT)
}
fn boundary(f: impl FnOnce() -> i32) -> i32 {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or(FAILURE)
}

impl Instance {
    fn snapshot(&self) -> Value {
        let state = self.status.lock().unwrap().clone();
        let queue = self.queue.lock().unwrap().clone();
        json!({"schema":2,"instance_id":self.key,"state":state.phase.name(),"desired_version":state.version,"effective_version":state.version,"agents":state.agents,"reason":state.error,
            "delivery":queue.map(|q|q.snapshot()),"metrics_scope":"host_process","sdk_callbacks_require_dispatch":true})
    }
    fn notify(&self, start: bool, result: i32) {
        if start && self.start_enqueued.swap(true, Ordering::SeqCst) {
            return;
        }
        self.notifications.lock().unwrap().push_back(Notification {
            start,
            result,
            report: self.snapshot(),
        });
    }
}

unsafe fn json_input(view: PilotJsonView) -> Result<Value, i32> {
    if view.data.is_null() || view.len == 0 || view.len > 8 * 1024 * 1024 {
        return Err(BAD_ARGUMENT);
    }
    // SAFETY: the caller owns this readable byte span until the operation returns.
    let bytes = unsafe { std::slice::from_raw_parts(view.data, view.len) };
    serde_json::from_slice(bytes).map_err(|_| BAD_ARGUMENT)
}
unsafe fn output(value: &Value, target: *mut *mut c_char, len: *mut usize) -> Result<(), i32> {
    if target.is_null() || len.is_null() {
        return Err(BAD_ARGUMENT);
    }
    let bytes = serde_json::to_vec(value).map_err(|_| FAILURE)?;
    let size = bytes.len();
    let text = CString::new(bytes).map_err(|_| FAILURE)?;
    // SAFETY: caller-provided writable out parameters; ownership transfers to host.
    unsafe {
        *target = text.into_raw();
        *len = size;
    }
    Ok(())
}

unsafe extern "C" fn start(
    init: PilotJsonView,
    policy: PilotJsonView,
    activity: Option<OnBatch>,
    monitoring: Option<OnBatch>,
    hook: Option<OnHook>,
    on_start: Option<OnLifecycle>,
    on_stop: Option<OnLifecycle>,
    context: *mut c_void,
    out: *mut *mut PilotHandle,
) -> i32 {
    boundary(|| {
        if out.is_null() {
            return BAD_ARGUMENT;
        }
        // SAFETY: validated writable out parameter. No callback is dispatched here.
        unsafe {
            *out = std::ptr::null_mut();
        }
        let result = (|| -> Result<_, i32> {
            let mut init: Init =
                serde_json::from_value(unsafe { json_input(init)? }).map_err(|_| BAD_ARGUMENT)?;
            init.validate().map_err(|_| BAD_ARGUMENT)?;
            init.data_dir =
                super::policy::canonical_candidate(&init.data_dir).map_err(|_| BAD_ARGUMENT)?;
            init.resource_dir =
                super::policy::canonical_candidate(&init.resource_dir).map_err(|_| BAD_ARGUMENT)?;

            let policy =
                Policy::parse(unsafe { json_input(policy)? }, &init).map_err(|_| BAD_ARGUMENT)?;
            let callbacks = Callbacks {
                activity: activity.ok_or(BAD_ARGUMENT)?,
                monitoring: monitoring.ok_or(BAD_ARGUMENT)?,
                hook,
                start: on_start.ok_or(BAD_ARGUMENT)?,
                stop: on_stop.ok_or(BAD_ARGUMENT)?,
                context: context as usize,
            };
            let key = NEXT
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |v| v.checked_add(1))
                .map_err(|_| FAILURE)?;
            let (tx, rx) = mpsc::channel();
            let instance = Arc::new(Instance {
                key,
                init,
                status: Mutex::new(Status {
                    phase: Phase::Starting,
                    version: policy.version.clone(),
                    agents: json!([]),
                    error: None,
                }),
                callbacks,
                stop_requested: Arc::new(AtomicBool::new(false)),
                dispatching: AtomicBool::new(false),
                stop_notified: AtomicBool::new(false),
                start_enqueued: AtomicBool::new(false),
                commands: tx,
                notifications: Mutex::new(VecDeque::new()),
                queue: Mutex::new(None),
                activated: Arc::new(AtomicBool::new(false)),
                flow: Mutex::new(Default::default()),
                thread: Mutex::new(None),
            });
            instances().lock().unwrap().insert(key, instance.clone());
            let owner = instance.clone();
            let thread = match std::thread::Builder::new()
                .name("pilot-sdk-control".into())
                .spawn(move || worker(owner, policy, rx))
            {
                Ok(thread) => thread,
                Err(_) => {
                    instances().lock().unwrap().remove(&key);
                    return Err(FAILURE);
                }
            };
            *instance.thread.lock().unwrap() = Some(thread);
            Ok(key as *mut PilotHandle)
        })();
        match result {
            Ok(handle) => {
                unsafe {
                    *out = handle;
                }
                OK
            }
            Err(code) => code,
        }
    })
}
unsafe extern "C" fn snapshot(
    handle: *mut PilotHandle,
    out: *mut *mut c_char,
    len: *mut usize,
) -> i32 {
    boundary(|| {
        if out.is_null() || len.is_null() {
            return BAD_ARGUMENT;
        }
        unsafe {
            *out = std::ptr::null_mut();
            *len = 0;
        }
        match get(handle) {
            Ok(instance) => {
                unsafe { output(&instance.snapshot(), out, len) }.map_or_else(|code| code, |_| OK)
            }
            Err(code) => code,
        }
    })
}
unsafe extern "C" fn apply(
    handle: *mut PilotHandle,
    policy: PilotJsonView,
    out: *mut *mut c_char,
    len: *mut usize,
) -> i32 {
    boundary(|| {
        if out.is_null() || len.is_null() {
            return BAD_ARGUMENT;
        }
        unsafe {
            *out = std::ptr::null_mut();
            *len = 0;
        }
        let instance = match get(handle) {
            Ok(i) => i,
            Err(c) => return c,
        };
        if instance.status.lock().unwrap().phase != Phase::Running {
            return BUSY;
        }
        let policy = match unsafe { json_input(policy) }
            .map_err(|code| (code, "invalid policy JSON".to_owned()))
            .and_then(|raw| {
                Policy::parse(raw, &instance.init)
                    .map_err(|error| (BAD_ARGUMENT, error.to_string()))
            }) {
            Ok(p) => p,
            Err((code, reason)) => {
                let _ = unsafe {
                    output(
                        &json!({"ok":false,"reason":reason,"previous_policy_retained":true}),
                        out,
                        len,
                    )
                };
                return code;
            }
        };
        let (tx, rx) = mpsc::sync_channel(1);
        if instance
            .commands
            .send(Command::Apply(Box::new(policy), tx))
            .is_err()
        {
            return FAILURE;
        }
        match rx.recv() {
            Ok(Ok(report)) => unsafe { output(&report, out, len) }
                .map(|_| OK)
                .unwrap_or_else(|e| e),
            Ok(Err(error)) => {
                let _ = unsafe { output(&json!({"ok":false,"reason":error}), out, len) };
                FAILURE
            }
            Err(_) => FAILURE,
        }
    })
}
unsafe extern "C" fn stop(handle: *mut PilotHandle, drain: u32) -> i32 {
    boundary(|| {
        let instance = match get(handle) {
            Ok(i) => i,
            Err(c) => return c,
        };
        {
            let mut status = instance.status.lock().unwrap();
            if matches!(status.phase, Phase::Stopping | Phase::Stopped) {
                return BUSY;
            }
            status.phase = Phase::Stopping;
        }
        instance.stop_requested.store(true, Ordering::SeqCst);
        if instance
            .commands
            .send(Command::Stop(drain.min(300000)))
            .is_err()
        {
            return FAILURE;
        }
        if let Some(queue) = instance.queue.lock().unwrap().clone() {
            queue.capacity_changed.notify_waiters();
            queue.wake();
        }
        OK
    })
}
unsafe extern "C" fn dispatch(handle: *mut PilotHandle, reserved: u32) -> i32 {
    boundary(|| {
        if reserved != 0 {
            return BAD_ARGUMENT;
        }
        let instance = match get(handle) {
            Ok(i) => i,
            Err(c) => return c,
        };
        instance.activated.store(true, Ordering::SeqCst);
        if instance.dispatching.swap(true, Ordering::SeqCst) {
            return BUSY;
        }
        struct DispatchGuard<'a>(&'a AtomicBool);
        impl Drop for DispatchGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = DispatchGuard(&instance.dispatching);
        let notification = instance.notifications.lock().unwrap().pop_front();
        if let Some(notification) = notification {
            let data = serde_json::to_vec(&notification.report).expect("status JSON");
            let callback = if notification.start {
                instance.callbacks.start
            } else {
                instance.callbacks.stop
            };
            // SAFETY: callback view lives through the call; context belongs to
            // the host. The dispatch guard makes destroy return BUSY in callbacks.
            unsafe {
                callback(
                    instance.callbacks.context as *mut _,
                    handle,
                    notification.result,
                    PilotJsonView::from_bytes(&data),
                );
            }
            if !notification.start {
                instance.stop_notified.store(true, Ordering::SeqCst);
            }
        }
        OK
    })
}
unsafe extern "C" fn destroy(handle: *mut PilotHandle) -> i32 {
    boundary(|| {
        let instance = match get(handle) {
            Ok(i) => i,
            Err(c) => return c,
        };
        if instance.dispatching.load(Ordering::SeqCst)
            || !instance.stop_notified.load(Ordering::SeqCst)
            || instance.status.lock().unwrap().phase != Phase::Stopped
        {
            return BUSY;
        }
        let mut thread = instance.thread.lock().unwrap();
        if thread.as_ref().is_some_and(|t| !t.is_finished()) {
            return BUSY;
        }
        if let Some(thread) = thread.take() {
            if thread.join().is_err() {
                return FAILURE;
            }
        }
        let mut registry = instances().lock().unwrap();
        registry.remove(&(handle as usize));
        if registry.is_empty() {
            *registry = HashMap::new();
        }
        OK
    })
}
unsafe extern "C" fn string_free(text: *mut c_char) {
    if !text.is_null() {
        // SAFETY: host returns exactly one live allocation from this SDK.
        unsafe {
            drop(CString::from_raw(text));
        }
    }
}
unsafe extern "C" fn host_main() -> i32 {
    boundary(|| {
        let result = (|| -> anyhow::Result<i32> {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            let result = runtime.block_on(crate::cli_main::run());
            // The native process exits after this reserved command returns.
            // Preserve its original process::exit behavior after the CLI has
            // completed its own shutdown; background runtime jobs must not
            // delay returning an installer result. The host pins this library
            // through process exit. Embedded sessions use their own barriers.
            runtime.shutdown_background();
            result
        })();
        match result {
            Ok(code) => code,
            Err(error) => {
                eprintln!("loongsuite-pilot: {error}");
                1
            }
        }
    })
}

unsafe extern "C" fn host_hook(
    args: PilotJsonView,
    stdin: PilotJsonView,
    report: *mut *mut c_char,
    len: *mut usize,
) -> i32 {
    boundary(|| {
        let args = match unsafe { json_input(args) }
            .and_then(|v| serde_json::from_value::<Vec<String>>(v).map_err(|_| BAD_ARGUMENT))
        {
            Ok(args) => args,
            Err(code) => return code,
        };
        if stdin.data.is_null() || stdin.len > 5 * 1024 * 1024 {
            return BAD_ARGUMENT;
        }
        // SAFETY: borrowed readable input is retained by the native worker.
        let input =
            match std::str::from_utf8(unsafe { std::slice::from_raw_parts(stdin.data, stdin.len) })
            {
                Ok(text) => text.to_owned(),
                Err(_) => return BAD_ARGUMENT,
            };
        crate::utils::logger::redirect_root_logger_to_stderr();
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(_) => return FAILURE,
        };
        let (code, stdout) =
            runtime.block_on(crate::interceptor::cli::run_hook_captured(&args, input));
        unsafe { output(&json!({"exit_code":code,"stdout":stdout}), report, len) }
            .map_or_else(|e| e, |_| OK)
    })
}

type MonitoringBatch = (Vec<Vec<u8>>, Vec<(String, String)>);

struct Session {
    collector: Collector,
    queue: Arc<Outbox>,
    activity: Option<JoinHandle<()>>,
    monitor: Option<JoinHandle<()>>,
    _lock: File,
    hooks: Option<Hooks>,
}
impl Session {
    fn boot(instance: &Arc<Instance>, policy: &Policy) -> anyhow::Result<Self> {
        crate::utils::source_access::private_path(&instance.init.data_dir)?;
        std::fs::create_dir_all(&instance.init.data_dir)?;
        anyhow::ensure!(
            instance.init.resource_dir.is_dir(),
            "resource_dir is not a directory"
        );
        crate::utils::source_access::private_path(&instance.init.data_dir.join("collector.lock"))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(instance.init.data_dir.join("collector.lock"))?;
        lock.try_lock_exclusive().map_err(|_| {
            anyhow::anyhow!("SDK state directory is already owned by another collector")
        })?;
        let queue = Outbox::open(
            &instance.init.data_dir.join("outbox"),
            policy.delivery.clone(),
        )?;
        queue.identity.write().unwrap()["user_id"] = json!(instance.init.user_id);
        *instance.queue.lock().unwrap() = Some(queue.clone());
        let mut monitoring = super::monitoring::Monitoring::new(&instance.init, &queue)?;
        let callbacks = instance.callbacks;
        let activity_queue = queue.clone();
        let activity_owner = Arc::downgrade(instance);
        let activity = std::thread::Builder::new()
            .name("pilot-activity".into())
            .spawn(move || {
                while !activity_queue.stopping.load(Ordering::SeqCst)
                    && activity_owner
                        .upgrade()
                        .is_some_and(|i| !i.activated.load(Ordering::SeqCst))
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                activity_queue.deliver(callbacks.activity, callbacks.context)
            })?;
        let mut session = Self {
            collector: Collector::new(
                instance.init.clone(),
                queue.clone(),
                instance.stop_requested.clone(),
            ),
            queue,
            activity: Some(activity),
            monitor: None,
            _lock: lock,
            hooks: None,
        };
        let owner = Arc::downgrade(instance);
        let monitor_queue = session.queue.clone();
        session.monitor=Some(std::thread::Builder::new().name("pilot-monitoring".into()).spawn(move||{
            monitoring.enter_scope();
            let mut pending:Option<MonitoringBatch>=None;
            let mut last_options=monitor_queue.options.read().unwrap().clone();
            let mut rotation=0usize;
            while !monitor_queue.stopping.load(Ordering::SeqCst){
                if owner.upgrade().is_some_and(|i| !i.activated.load(Ordering::SeqCst)) {
                    std::thread::sleep(Duration::from_millis(5)); continue;
                }
                let options=monitor_queue.options.read().unwrap().clone();
                if options!=last_options { pending=None;last_options=options.clone(); }
                if pending.is_none(){if let Some(instance)=owner.upgrade(){
                    let alarms=monitor_queue.alarm_batch();
                    let flow=instance.flow.lock().unwrap().clone();
                    let mut rows=monitoring.collect(flow,instance.snapshot(),&monitor_queue);
                    let metric_count=rows.len();
                    rows.rotate_left(rotation%metric_count);rotation=rotation.wrapping_add(1);
                    let mut selected=Vec::new();let mut acknowledged=Vec::new();let mut bytes=0usize;
                    // Persistent alarms take priority over coalescible metric snapshots.
                    for (row,alarm) in alarms.into_iter().filter_map(|alarm|{match serde_json::from_str::<Value>(&alarm.1).ok().filter(Value::is_object){Some(row)=>Some((serde_json::to_vec(&monitor_queue.decorate_alarm(row)).expect("alarm JSON"),Some(alarm))),None=>{*monitor_queue.last_error.lock().unwrap()=Some("invalid persisted alarm retained".into());None}}})
                        .chain(rows.into_iter().map(|row|(row,None))) {
                        if row.len()>options.max_event_bytes || row.len()>options.max_batch_bytes {
                            *monitor_queue.last_error.lock().unwrap()=Some("monitoring event exceeds current delivery limit; retained alarms wait for a policy update".into());
                            continue;
                        }
                        if selected.len()>=options.max_events_per_batch || bytes+row.len()>options.max_batch_bytes {continue;}
                        bytes+=row.len();selected.push(row);
                        if let Some(alarm)=alarm {acknowledged.push(alarm);}
                    }
                    if !selected.is_empty() {pending=Some((selected,acknowledged));}
                }else{break;}}
                if let Some((rows,alarms))=&pending{
                    let views:Vec<_>=rows.iter().map(|row|PilotJsonView::from_bytes(row)).collect();
                    monitor_queue.callbacks.fetch_add(1,Ordering::SeqCst);
                    // SAFETY: owned immutable batch and host-retained context.
                    let ack=unsafe{(callbacks.monitoring)(callbacks.context as *mut _,views.as_ptr(),views.len())};
                    monitor_queue.callbacks.fetch_sub(1,Ordering::SeqCst);
                    if ack==ACK{monitor_queue.ack_alarms(alarms);pending=None;}
                    else if ack!=RETRY {monitor_queue.alarm("SDK_MONITORING_PROTOCOL","on_monitoring returned an unknown code; batch retained");}
                }
                monitoring.pause(&monitor_queue.stopping);
            }
        })?);
        session.hooks = Some(Hooks::start(
            &instance.init.data_dir,
            session.queue.clone(),
            policy.hooks.clone(),
            callbacks.hook,
            callbacks.context,
            instance.stop_requested.clone(),
            instance.activated.clone(),
        )?);
        session.collector.apply(policy)?;
        Ok(session)
    }
    fn shutdown(&mut self) {
        self.collector.stop();
        if let Some(mut hooks) = self.hooks.take() {
            hooks.stop();
        }
        if let Err(error) = self
            .queue
            .verdicts
            .stop_checkpoint_loop(chrono::Utc::now().timestamp_millis())
        {
            self.queue
                .alarm("SDK_VERDICT_CHECKPOINT", &error.to_string());
        }
        self.queue.stopping.store(true, Ordering::SeqCst);
        self.queue.wake();
        self.queue.capacity_changed.notify_waiters();
        if let Some(thread) = self.activity.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.monitor.take() {
            let _ = thread.join();
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn worker(instance: Arc<Instance>, policy: Policy, receiver: mpsc::Receiver<Command>) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        worker_inner(instance.clone(), policy, &receiver)
    }));
    if result.is_ok() {
        return;
    }
    {
        let mut status = instance.status.lock().unwrap();
        status.phase = Phase::Failed;
        status.error = Some("SDK control task panicked; resources were stopped".into());
    }
    instance.notify(true, FAILURE);
    // Session Drop completed its joins during unwinding. Preserve the accepted
    // stop notification, including a stop already removed from the command queue.
    loop {
        if instance.stop_requested.load(Ordering::SeqCst) {
            instance.status.lock().unwrap().phase = Phase::Stopped;
            instance.notify(false, FAILURE);
            return;
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(Command::Apply(_, reply)) => {
                let _ = reply.send(Err("SDK failed; stop and recreate the instance".into()));
            }
            Ok(Command::Stop(_)) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return,
        }
    }
}
fn worker_inner(instance: Arc<Instance>, mut policy: Policy, receiver: &mpsc::Receiver<Command>) {
    let started = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Session::boot(&instance, &policy)
    }));
    let mut session = match started {
        Ok(Ok(session)) => Some(session),
        result => {
            let reason = match result {
                Ok(Err(error)) => error.to_string(),
                _ => "SDK startup panicked".into(),
            };
            let mut status = instance.status.lock().unwrap();
            status.error = Some(reason);
            if status.phase != Phase::Stopping {
                status.phase = Phase::Failed;
            }
            None
        }
    };
    let success = session.is_some() && !instance.stop_requested.load(Ordering::SeqCst);
    if success {
        instance.status.lock().unwrap().phase = Phase::Running;
    }
    instance.notify(true, if success { OK } else { FAILURE });
    loop {
        if let Some(session) = &session {
            instance.status.lock().unwrap().agents = session.collector.snapshot();
            *instance.flow.lock().unwrap() = session.collector.dataflow();
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(Command::Apply(next, reply)) => {
                let result = if instance.stop_requested.load(Ordering::SeqCst) {
                    Err("SDK is stopping".into())
                } else if let Some(session) = session.as_mut() {
                    match session.collector.apply(&next) {
                        Ok(()) => {
                            if let Some(hooks) = &session.hooks {
                                *hooks.settings.write().unwrap() = next.hooks.clone();
                            }
                            policy = *next;
                            let mut status = instance.status.lock().unwrap();
                            status.version = policy.version.clone();
                            status.agents = session.collector.snapshot();
                            drop(status);
                            Ok(instance.snapshot())
                        }
                        Err(error) => {
                            let _ = session.collector.apply(&policy);
                            Err(error.to_string())
                        }
                    }
                } else {
                    Err("SDK is not running".into())
                };
                let _ = reply.send(result);
            }
            Ok(Command::Stop(drain)) => {
                if let Some(mut session) = session.take() {
                    session.collector.stop();
                    let deadline = Instant::now() + Duration::from_millis(drain as u64);
                    while session.queue.pending_bytes().unwrap_or(0) > 0
                        && Instant::now() < deadline
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    session.shutdown();
                }
                instance.status.lock().unwrap().phase = Phase::Stopped;
                instance.notify(false, OK);
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return,
        }
    }
}

static API: PilotApiV2 = PilotApiV2 {
    abi_version: ABI_VERSION,
    struct_size: std::mem::size_of::<PilotApiV2>() as u32,
    capabilities: CAP_ACTIVITY_V2 | CAP_HOOK_UDP | CAP_MONITORING,
    start,
    apply_policy: apply,
    snapshot,
    stop,
    destroy,
    string_free,
    dispatch,
    host_main,
    host_hook,
};

/// Return the immutable versioned function table. No initialization, callbacks
/// or thread creation takes place under the operating system loader lock.
#[no_mangle]
pub extern "C" fn aah_collector_get_api_v2() -> *const PilotApiV2 {
    &API
}
