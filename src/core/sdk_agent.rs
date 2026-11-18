//! Full Pilot's client for the same activity and lifecycle ABI used by embedders.
use super::{managed_hook::ManagedHook, InputManager};
use crate::checkpoints::StateStore;
use crate::interceptor::{ToolInterceptPhase, ToolVerdictAction, ToolVerdictKey, ToolVerdictStore};
use crate::sdk::abi;
use crate::sdk::host_loader::{self, Library};
use serde_json::Value;
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{mpsc, Arc, Weak};
use std::time::Duration;

const PENDING: i32 = -1;

pub(super) struct SdkAgent {
    input: &'static str,
    init: Vec<u8>,
    policy: Vec<u8>,
    manager: Weak<InputManager>,
    sdk_data: PathBuf,
    legacy_state: Weak<StateStore>,
    verdicts: Option<Arc<ToolVerdictStore>>,
    managed: Option<Arc<ManagedHook>>,
    running: Arc<AtomicBool>,
    session: tokio::sync::Mutex<Option<Session>>,
}

struct Session {
    stop: mpsc::Sender<()>,
    worker: std::thread::JoinHandle<Result<(), String>>,
}

impl SdkAgent {
    pub fn new(
        input: &'static str,
        init: Value,
        policy: Value,
        manager: &Arc<InputManager>,
        sdk_data: PathBuf,
        legacy_state: &Arc<StateStore>,
    ) -> Self {
        Self {
            input,
            init: init.to_string().into_bytes(),
            managed: configure_managed_hook(&policy, &sdk_data),
            policy: policy.to_string().into_bytes(),
            manager: Arc::downgrade(manager),
            sdk_data,
            legacy_state: Arc::downgrade(legacy_state),
            verdicts: None,
            running: Arc::new(AtomicBool::new(false)),
            session: tokio::sync::Mutex::new(None),
        }
    }

    pub fn hook_only(
        init: Value,
        policy: Value,
        manager: &Arc<InputManager>,
        sdk_data: PathBuf,
        verdicts: Arc<ToolVerdictStore>,
    ) -> Self {
        Self {
            input: "qoder-trace",
            init: init.to_string().into_bytes(),
            managed: configure_managed_hook(&policy, &sdk_data),
            policy: policy.to_string().into_bytes(),
            manager: Arc::downgrade(manager),
            sdk_data,
            legacy_state: Weak::new(),
            verdicts: Some(verdicts),
            running: Arc::new(AtomicBool::new(false)),
            session: tokio::sync::Mutex::new(None),
        }
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub async fn start(&self) -> Result<(), String> {
        let mut session = self.session.lock().await;
        if session.is_some() {
            return Ok(());
        }
        let (stop, stopping) = mpsc::channel();
        let (ready, started) = tokio::sync::oneshot::channel();
        let init = self.init.clone();
        let policy = self.policy.clone();
        let running = self.running.clone();
        let context = Box::new(Context {
            input: self.input,
            runtime: tokio::runtime::Handle::current(),
            manager: self.manager.clone(),
            sdk_data: self.sdk_data.clone(),
            legacy_state: self.legacy_state.clone(),
            verdicts: self.verdicts.clone(),
            managed: self.managed.clone(),
            start_result: AtomicI32::new(PENDING),
            stop_result: AtomicI32::new(PENDING),
        });
        let worker = std::thread::Builder::new()
            .name(format!("pilot-sdk-host-{}", self.input))
            .spawn(move || {
                let result = run(context, &init, &policy, ready, stopping, &running);
                running.store(false, Ordering::Release);
                result
            })
            .map_err(|error| error.to_string())?;
        // Own the stop sender before awaiting readiness. If discovery cancels,
        // its later stop can still retire the accepted SDK instance.
        *session = Some(Session { stop, worker });
        match started.await {
            Ok(Ok(())) => Ok(()),
            error => {
                let Session { stop, worker } = session.take().expect("SDK start worker");
                drop(stop);
                let outcome = tokio::task::spawn_blocking(move || worker.join())
                    .await
                    .map_err(|error| error.to_string())?
                    .map_err(|_| "SDK host thread panicked".to_owned())?;
                outcome
                    .and_then(|()| error.unwrap_or_else(|_| Err("SDK start did not finish".into())))
            }
        }
    }

    pub async fn stop(&self) {
        let mut session = self.session.lock().await;
        if let Some(Session { stop, worker }) = session.take() {
            let _ = stop.send(());
            let outcome = tokio::task::spawn_blocking(move || worker.join()).await;
            if !matches!(outcome, Ok(Ok(Ok(())))) {
                super::logger("SdkAgent").warn("SDK instance failed to stop cleanly", None);
            }
        }
    }
}

fn configure_managed_hook(policy: &Value, sdk_data: &std::path::Path) -> Option<Arc<ManagedHook>> {
    if policy
        .pointer("/sdk_options/hooks/local/mode")
        .and_then(Value::as_str)
        != Some("all")
    {
        return None;
    }
    sdk_data
        .parent()?
        .parent()
        .map(|data| Arc::new(ManagedHook::new(data)))
}

struct Context {
    input: &'static str,
    runtime: tokio::runtime::Handle,
    manager: Weak<InputManager>,
    sdk_data: PathBuf,
    legacy_state: Weak<StateStore>,
    verdicts: Option<Arc<ToolVerdictStore>>,
    managed: Option<Arc<ManagedHook>>,
    start_result: AtomicI32,
    stop_result: AtomicI32,
}

impl Context {
    fn export_drained_checkpoint(
        &self,
        api: &abi::PilotApiV2,
        handle: *mut abi::PilotHandle,
    ) -> Result<(), String> {
        let Some(legacy) = self.legacy_state.upgrade() else {
            return Ok(());
        };
        let mut json = std::ptr::null_mut();
        let mut length = 0;
        // SAFETY: the control worker owns the handle and both out-parameters.
        let status = unsafe { (api.snapshot)(handle, &mut json, &mut length) };
        if status != abi::OK || json.is_null() {
            return Err(format!("SDK snapshot failed ({status})"));
        }
        // SAFETY: SDK gave us this report and its byte length; free exactly once.
        let report = serde_json::from_slice::<Value>(unsafe {
            std::slice::from_raw_parts(json.cast::<u8>(), length)
        });
        unsafe { (api.string_free)(json) };
        let report = report.map_err(|error| error.to_string())?;
        if report
            .pointer("/delivery/pending_events")
            .and_then(Value::as_u64)
            != Some(0)
        {
            return Err("SDK activity remains queued; previous Pilot checkpoint retained".into());
        }
        let Some(namespace) = report
            .pointer("/agents/0/status/source_namespace")
            .and_then(Value::as_str)
        else {
            return Ok(());
        };
        if namespace.len() != 64 || !namespace.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("SDK returned an invalid source namespace".into());
        }
        let checkpoint = StateStore::new(
            self.sdk_data
                .join("sources")
                .join(namespace)
                .join("input-state.json"),
        );
        let persisted = crate::sdk::outbox::Outbox::read_persisted_checkpoint(
            &self.sdk_data.join("outbox"),
            namespace,
        )
        .map_err(|error| error.to_string())?;
        self.runtime.block_on(async {
            if let Some(text) = persisted.as_deref() {
                checkpoint
                    .load_checkpoint_text(text)
                    .map_err(|error| error.to_string())?;
            } else {
                // A fresh SDK source may only have imported the Node checkpoint.
                checkpoint.load().await;
            }
            let mut imported = false;
            for id in checkpoint.keys() {
                if crate::checkpoints::key_in_namespace(&id, self.input) {
                    legacy.set(&id, checkpoint.get(&id));
                    imported = true;
                }
            }
            if imported {
                legacy.save().await.map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }
}

unsafe extern "C" fn on_start(
    ctx: *mut c_void,
    _: *mut abi::PilotHandle,
    code: i32,
    _: abi::PilotJsonView,
) {
    // SAFETY: both lifecycle callbacks run on the owning dispatch thread.
    unsafe { &*ctx.cast::<Context>() }
        .start_result
        .store(code, Ordering::Release);
}

unsafe extern "C" fn on_stop(
    ctx: *mut c_void,
    _: *mut abi::PilotHandle,
    code: i32,
    _: abi::PilotJsonView,
) {
    // SAFETY: both lifecycle callbacks run on the owning dispatch thread.
    unsafe { &*ctx.cast::<Context>() }
        .stop_result
        .store(code, Ordering::Release);
}

unsafe extern "C" fn on_activity(
    ctx: *mut c_void,
    rows: *const abi::PilotJsonView,
    len: usize,
) -> i32 {
    let result = std::panic::catch_unwind(|| {
        // SAFETY: SDK owns these views through this callback. The activity
        // thread accesses only the immutable fields of the host context.
        let ctx = unsafe { &*ctx.cast::<Context>() };
        let (input, runtime, manager) = (ctx.input, &ctx.runtime, &ctx.manager);
        let manager = manager.upgrade().ok_or("Pilot output stopped")?;
        let rows = unsafe { std::slice::from_raw_parts(rows, len) };
        let rows = rows
            .iter()
            .map(|row| unsafe { std::slice::from_raw_parts(row.data, row.len) })
            .collect::<Vec<_>>();
        runtime
            .block_on(manager.accept_sdk_activity(input, &rows))
            .map_err(|_| "Pilot output failed")
    });
    if matches!(result, Ok(Ok(()))) {
        abi::ACK
    } else {
        abi::RETRY
    }
}

unsafe extern "C" fn on_monitoring(
    ctx: *mut c_void,
    rows: *const abi::PilotJsonView,
    len: usize,
) -> i32 {
    let result = std::panic::catch_unwind(|| {
        // SAFETY: SDK owns these nonempty batch views through the callback.
        let ctx = unsafe { &*ctx.cast::<Context>() };
        let manager = ctx.manager.upgrade().ok_or("Pilot output stopped")?;
        let rows = unsafe { std::slice::from_raw_parts(rows, len) };
        let parsed = rows
            .iter()
            .map(|row| {
                let bytes = unsafe { std::slice::from_raw_parts(row.data, row.len) };
                serde_json::from_slice::<Value>(bytes)
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "invalid SDK monitoring JSON")?;
        for row in parsed {
            // Full Pilot already reports process CPU/RSS and resource alarms.
            if row["event.name"] == "pilot.alarm" && row["metrics_scope"] != "host_process" {
                manager.accept_sdk_alarm(ctx.input, &row);
            }
        }
        Ok::<(), &str>(())
    });
    if matches!(result, Ok(Ok(()))) {
        abi::ACK
    } else {
        abi::RETRY
    }
}

/// Relay a native SDK decision into the full shell's legacy input linker when
/// the shell owns Qoder's ACP or multimodal processing.
unsafe extern "C" fn on_host_hook_event(
    ctx: *mut c_void,
    row: abi::PilotJsonView,
    remaining_ms: u32,
    reply: *mut u8,
    capacity: usize,
    length: *mut usize,
) -> i32 {
    #[derive(serde::Deserialize)]
    struct Verdict {
        session_id: Option<String>,
        tool_use_id: String,
        phase: ToolInterceptPhase,
        action: ToolVerdictAction,
        guardrail: Option<crate::interceptor::GuardrailMetadata>,
    }

    let result = std::panic::catch_unwind(|| {
        // SAFETY: the SDK retains the buffer and the host context for this call.
        let ctx = unsafe { &*ctx.cast::<Context>() };
        let rows = unsafe { std::slice::from_raw_parts(row.data, row.len) };
        let mut row: Value = serde_json::from_slice(rows).ok()?;
        if row["kind"] == "managed_local" {
            let rules = ctx.managed.as_ref()?;
            let request = serde_json::from_value(row["request"].take()).ok()?;
            let verdict = ctx.runtime.block_on(rules.evaluate(&request, remaining_ms));
            let bytes = serde_json::to_vec(&verdict).ok()?;
            if bytes.len() > capacity || reply.is_null() || length.is_null() {
                return None;
            }
            // SAFETY: both output pointers belong to the active SDK call.
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), reply, bytes.len());
                *length = bytes.len();
            }
            return Some(());
        }
        if row["kind"] == "qoder_upstream" {
            let data = ctx.sdk_data.parent()?.parent()?;
            crate::hook_process::record_qoder_upstream_for_host(
                data,
                row["session_id"].as_str()?,
                row["traceparent"].as_str()?,
            );
            return Some(());
        }
        let verdict = serde_json::from_value::<Verdict>(row).ok()?;
        let store = ctx.verdicts.as_ref()?;
        let key = ToolVerdictKey {
            session_id: verdict.session_id,
            tool_use_id: verdict.tool_use_id,
            phase: verdict.phase,
        };
        let now = chrono::Utc::now().timestamp_millis();
        store.put_sdk_verdict(&key, verdict.action, verdict.guardrail, now);
        Some(())
    });
    if matches!(result, Ok(Some(()))) {
        abi::OK
    } else {
        abi::FAILURE
    }
}

fn run(
    context: Box<Context>,
    init: &[u8],
    policy: &[u8],
    ready: tokio::sync::oneshot::Sender<Result<(), String>>,
    stopping: mpsc::Receiver<()>,
    running: &AtomicBool,
) -> Result<(), String> {
    let library = Library::open(&host_loader::library_path()?)?;
    let api = library.api();
    let required = abi::CAP_ACTIVITY_V2 | abi::CAP_HOOK_UDP | abi::CAP_MONITORING;
    if api.capabilities & required != required {
        return Err("SDK is missing required host capabilities".into());
    }
    let on_hook = (context.verdicts.is_some() || context.managed.is_some())
        .then_some(on_host_hook_event as abi::OnHook);
    let context_ptr = Box::into_raw(context);
    let ctx = context_ptr.cast::<c_void>();
    let mut handle = std::ptr::null_mut();
    // SAFETY: all JSON views live through start. Context remains allocated
    // until destroy succeeds, including any in-flight activity callbacks.
    let code = unsafe {
        (api.start)(
            abi::PilotJsonView::from_bytes(init),
            abi::PilotJsonView::from_bytes(policy),
            Some(on_activity),
            Some(on_monitoring),
            on_hook,
            Some(on_start),
            Some(on_stop),
            ctx,
            &mut handle,
        )
    };
    if code != abi::OK {
        // SAFETY: a rejected start retained no callback or handle.
        drop(unsafe { Box::from_raw(context_ptr) });
        return Err(if code == abi::BAD_ARGUMENT {
            "SDK rejected the Pilot configuration".into()
        } else {
            format!("SDK start rejected ({code})")
        });
    }
    let context = unsafe { &*context_ptr };
    let interval = Duration::from_millis(10);
    let start_result = loop {
        unsafe { (api.dispatch)(handle, 0) };
        let code = context.start_result.load(Ordering::Acquire);
        if code != PENDING {
            break code;
        }
        if !matches!(
            stopping.recv_timeout(interval),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            break abi::FAILURE;
        }
    };
    if start_result == abi::OK {
        running.store(true, Ordering::Release);
        if ready.send(Ok(())).is_ok() {
            let _ = stopping.recv();
        }
    } else {
        let _ = ready.send(Err(format!("SDK start failed ({start_result})")));
    }
    running.store(false, Ordering::Release);
    let stop_code = unsafe { (api.stop)(handle, 5000) };
    if stop_code == abi::OK || stop_code == abi::BUSY {
        loop {
            unsafe { (api.dispatch)(handle, 0) };
            let code = context.stop_result.load(Ordering::Acquire);
            if code != PENDING {
                let checkpoint = if code == abi::OK {
                    context.export_drained_checkpoint(api, handle)
                } else {
                    Err(format!("SDK stop failed ({code})"))
                };
                loop {
                    match unsafe { (api.destroy)(handle) } {
                        abi::OK => {
                            // SAFETY: destroy retired both the SDK handle and callbacks.
                            drop(unsafe { Box::from_raw(context_ptr) });
                            return checkpoint;
                        }
                        abi::BUSY => std::thread::sleep(interval),
                        _ => break,
                    }
                }
                break;
            }
            std::thread::sleep(interval);
        }
    }
    // The ABI can still hold this instance after an unexpected failure.
    // Pin both allocations for the remaining lifetime of the host process.
    std::mem::forget(library);
    Err(format!(
        "SDK host could not retire the instance ({stop_code})"
    ))
}
