//! Task-local controls count real native IO and force short native read slices.
use std::sync::{Arc, Mutex};
pub(super) struct Probe {
    pub read_calls: usize,
    pub read_bytes: usize,
    pub max_read_bytes: usize,
}
impl Default for Probe {
    fn default() -> Self {
        Self {
            read_calls: 0,
            read_bytes: 0,
            max_read_bytes: usize::MAX,
        }
    }
}
tokio::task_local! {pub(super) static PROBE:Arc<Mutex<Probe>>;}
pub(super) fn read_limit(wanted: usize) -> usize {
    PROBE
        .try_with(|p| wanted.min(p.lock().unwrap().max_read_bytes.max(1)))
        .unwrap_or(wanted)
}
pub(super) fn read_completed(bytes: usize) {
    let _ = PROBE.try_with(|p| {
        let mut p = p.lock().unwrap();
        p.read_calls += 1;
        p.read_bytes += bytes;
    });
}
