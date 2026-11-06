//! Task-scoped equivalents of original protected activation/copy overrides.
use std::cell::RefCell;
use std::future::Future;
use std::sync::{Arc, Condvar, Mutex};
#[derive(Clone)]
pub(super) enum Mode {
    Success(&'static str),
    Unsupported,
    Timeout,
    EnableFailure,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Call {
    pub command: String,
    pub args: Vec<String>,
    pub timeout_ms: u64,
}
pub(super) struct Pause {
    phase: &'static str,
    reached: tokio::sync::Notify,
    released: Mutex<bool>,
    condition: Condvar,
    async_release: tokio::sync::Notify,
}
impl Pause {
    pub(super) fn new(phase: &'static str) -> Arc<Self> {
        Arc::new(Self {
            phase,
            reached: tokio::sync::Notify::new(),
            released: Mutex::new(false),
            condition: Condvar::new(),
            async_release: tokio::sync::Notify::new(),
        })
    }
    pub(super) async fn reached(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(5), self.reached.notified())
            .await
            .expect("pending marker fixture phase was not reached");
    }
    pub(super) fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.condition.notify_all();
        self.async_release.notify_one();
    }
    pub(super) fn wait_blocking(&self) {
        self.reached.notify_one();
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.condition.wait(released).unwrap();
        }
    }
}
struct Plan {
    mode: Option<Mode>,
    copy_failure: bool,
    calls: Vec<Call>,
    pause: Option<Arc<Pause>>,
}
tokio::task_local! {static PLAN:RefCell<Plan>;}
pub(super) async fn scope<T>(
    mode: Option<Mode>,
    copy_failure: bool,
    future: impl Future<Output = T>,
) -> T {
    PLAN.scope(
        RefCell::new(Plan {
            mode,
            copy_failure,
            calls: vec![],
            pause: None,
        }),
        future,
    )
    .await
}
pub(super) async fn paused_scope<T>(
    mode: Mode,
    pause: Arc<Pause>,
    future: impl Future<Output = T>,
) -> T {
    PLAN.scope(
        RefCell::new(Plan {
            mode: Some(mode),
            copy_failure: false,
            calls: vec![],
            pause: Some(pause),
        }),
        future,
    )
    .await
}
pub(super) fn pending_pause(phase: &str) -> Option<Arc<Pause>> {
    PLAN.try_with(|p| {
        p.borrow()
            .pause
            .as_ref()
            .filter(|p| p.phase == phase)
            .cloned()
    })
    .ok()
    .flatten()
}
pub(super) async fn pause_pending(phase: &str) {
    if let Some(pause) = pending_pause(phase) {
        pause.reached.notify_one();
        pause.async_release.notified().await;
    }
}
pub(super) fn calls() -> Vec<Call> {
    PLAN.with(|p| p.borrow().calls.clone())
}
pub(super) fn copy_error() -> bool {
    PLAN.try_with(|p| p.borrow().copy_failure).unwrap_or(false)
}
pub(super) fn command(
    command: &str,
    args: &[String],
    timeout_ms: u64,
) -> Option<Result<String, String>> {
    PLAN.try_with(|p| {
        let mut plan = p.borrow_mut();
        let mode = plan.mode.clone()?;
        plan.calls.push(Call {
            command: command.into(),
            args: args.to_vec(),
            timeout_ms,
        });
        let help = args.iter().any(|a| a == "--help");
        Some(match mode {
            Mode::Success(output) => Ok(if help { output.into() } else { String::new() }),
            Mode::Unsupported => {
                if help {
                    Err("unknown command: plugins".into())
                } else {
                    Ok(String::new())
                }
            }
            Mode::Timeout => Err("probe timed out".into()),
            Mode::EnableFailure => {
                if help {
                    Ok(String::new())
                } else {
                    Err("enable failed".into())
                }
            }
        })
    })
    .ok()
    .flatten()
}
