//! Per-task read seam matching the historical readBytes spy; release builds have no hook.
use std::{cell::RefCell, path::PathBuf};
pub(super) enum Mode {
    ExternalEdit(Vec<u8>),
    Alternating { original: Vec<u8>, hostile: Vec<u8> },
}
pub(super) struct Plan {
    path: PathBuf,
    pub reads: usize,
    mode: Mode,
}
impl Plan {
    pub fn new(path: PathBuf, mode: Mode) -> Self {
        Self {
            path,
            reads: 0,
            mode,
        }
    }
}
tokio::task_local! { static PLAN: RefCell<Plan>; }
pub(super) async fn scope<T>(
    plan: Plan,
    future: impl std::future::Future<Output = T>,
) -> (T, usize) {
    PLAN.scope(RefCell::new(plan), async {
        let result = future.await;
        (result, PLAN.with(|p| p.borrow().reads))
    })
    .await
}
pub(super) fn read(path: &str) -> Option<Result<Vec<u8>, String>> {
    PLAN.try_with(|slot| {
        let mut plan = slot.borrow_mut();
        if plan.path != std::path::Path::new(path) {
            return None;
        }
        plan.reads += 1;
        let call = plan.reads;
        match &plan.mode {
            Mode::ExternalEdit(edited) if call == 3 => Some(
                std::fs::write(path, edited)
                    .map(|()| edited.clone())
                    .map_err(|e| e.to_string()),
            ),
            Mode::Alternating { original, hostile } => Some(Ok(if call % 2 == 1 {
                original.clone()
            } else {
                hostile.clone()
            })),
            _ => None,
        }
    })
    .ok()
    .flatten()
}
