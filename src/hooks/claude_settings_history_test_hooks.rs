//! Per-task native shared-lock barrier and one-shot unowned recovery race adapter.
use crate::utils::LockAcquireResult;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::sync::Notify;
pub(crate) enum Plan {
    Pause {
        path: PathBuf,
        reached: Arc<Notify>,
        release: Arc<Notify>,
    },
    RetryOnce {
        calls: AtomicUsize,
    },
}
impl Plan {
    pub fn pause(path: PathBuf, reached: Arc<Notify>, release: Arc<Notify>) -> Arc<Self> {
        Arc::new(Self::Pause {
            path,
            reached,
            release,
        })
    }
    pub fn retry_once() -> Arc<Self> {
        Arc::new(Self::RetryOnce {
            calls: AtomicUsize::new(0),
        })
    }
    pub fn calls(&self) -> usize {
        match self {
            Self::RetryOnce { calls } => calls.load(Ordering::SeqCst),
            _ => 0,
        }
    }
}
tokio::task_local! {static PLAN:Arc<Plan>;}
pub(crate) async fn scope<T>(plan: Arc<Plan>, future: impl std::future::Future<Output = T>) -> T {
    PLAN.scope(plan, future).await
}
pub(super) fn acquire(path: &str) -> LockAcquireResult {
    let denied = PLAN
        .try_with(|p| match p.as_ref() {
            Plan::RetryOnce { calls } if calls.fetch_add(1, Ordering::SeqCst) == 0 => {
                Some(LockAcquireResult {
                    lock: None,
                    holder_pid: None,
                    error: None,
                    holder_process_start_state: None,
                    holder_command_state: None,
                    recovered_stale_lock: None,
                })
            }
            _ => None,
        })
        .ok()
        .flatten();
    denied.unwrap_or_else(|| super::acquire_single_instance_lock(path, None))
}
pub(super) async fn after_acquired(path: &str) {
    let pause = PLAN
        .try_with(|p| match p.as_ref() {
            Plan::Pause {
                path: expected,
                reached,
                release,
            } if expected == Path::new(path) => Some((reached.clone(), release.clone())),
            _ => None,
        })
        .ok()
        .flatten();
    if let Some((reached, release)) = pause {
        reached.notify_one();
        release.notified().await;
    }
}
