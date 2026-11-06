//! Task-local original writeFileSync error-spy adapter; real lock state machine remains in use.
use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
pub(crate) struct Plan {
    path: PathBuf,
    errno: i32,
    pub calls: AtomicUsize,
}
impl Plan {
    pub fn new(path: PathBuf, errno: i32) -> Arc<Self> {
        Arc::new(Self {
            path,
            errno,
            calls: AtomicUsize::new(0),
        })
    }
}
tokio::task_local! {static PLAN:Arc<Plan>;}
pub(crate) async fn scope<T>(plan: Arc<Plan>, future: impl std::future::Future<Output = T>) -> T {
    PLAN.scope(plan, future).await
}
pub(crate) fn write_error(path: &str) -> Option<io::Error> {
    PLAN.try_with(|p| {
        if p.path == Path::new(path) {
            p.calls.fetch_add(1, Ordering::SeqCst);
            Some(io::Error::from_raw_os_error(p.errno))
        } else {
            None
        }
    })
    .ok()
    .flatten()
}
