//! Shared producer of Qwen Work history from native Stop notifications.

use crate::hook_process::TranscriptReadBudget;
use crate::inputs::base::InputRuntime;
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MISSING_SOURCE_GRACE: Duration = Duration::from_secs(600);

#[derive(Clone)]
pub(crate) struct QwenWorkCnNativeWakeups {
    pub directory: PathBuf,
    pub pilot_policy_dir: Option<PathBuf>,
    pub transcript_roots: Vec<PathBuf>,
    pub producer_data_dir: PathBuf,
    pub user_id: String,
    pub legacy_cursor_root: Option<PathBuf>,
}

#[derive(Default)]
pub(super) struct NativeWakeupReader {
    settings: Mutex<Option<QwenWorkCnNativeWakeups>>,
    worker: tokio::sync::Mutex<Option<NativeStopWorker>>,
}

impl NativeWakeupReader {
    pub(super) fn configure(&self, native: QwenWorkCnNativeWakeups) {
        *self.settings.lock().expect("native wakeups") = Some(native);
    }

    pub(super) fn start(&self, rt: &InputRuntime) {
        let settings = self.settings.lock().expect("native wakeups");
        let Some(native) = settings.as_ref() else {
            return;
        };
        let Some(data) = &native.pilot_policy_dir else {
            return;
        };
        let roots: Vec<_> = native
            .transcript_roots
            .iter()
            .map(PathBuf::as_path)
            .collect();
        if let Err(error) = crate::sdk::configure_qwen_wakeups(data, &roots) {
            rt.warn(
                "Qwen Work transcript wakeup setup failed",
                serde_json::json!({"error": error.to_string()}).as_object(),
            );
        }
    }

    pub(super) fn owns_history(&self) -> bool {
        self.settings
            .lock()
            .expect("native wakeups")
            .as_ref()
            .is_some_and(|native| native.legacy_cursor_root.is_none())
    }

    pub(super) async fn stop(&self) -> anyhow::Result<()> {
        if let Some(mut worker) = self.worker.lock().await.take() {
            worker.budget.cancel();
            (&mut worker.task).await?;
        }
        Ok(())
    }

    pub(super) async fn drain(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        let native = self.settings.lock().expect("native wakeups").clone();
        let Some(native) = native else {
            return Ok(());
        };
        let mut worker = self.worker.lock().await;
        let mut seen_sessions = HashSet::new();
        let mut seen_sources = HashSet::new();
        if let Some(pending) = worker.as_ref() {
            seen_sessions.insert(pending.session.clone());
            seen_sources.insert(pending.source.clone());
            pending.budget.resume();
            if !poll_native_stop(&mut worker, rt).await? {
                return Ok(());
            }
        }

        let mut entries = match crate::utils::source_access::read_dir_async(&native.directory).await
        {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let mut markers = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_name().to_string_lossy().ends_with(".json") {
                markers.push(entry.path());
            }
        }
        markers.sort();
        for marker in markers {
            let bytes = crate::utils::source_access::read(&marker).await?;
            let value: Value = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => {
                    rt.warn(
                        "invalid Qwen Work SDK wakeup; discarding SDK-owned marker",
                        None,
                    );
                    tokio::fs::remove_file(marker).await?;
                    continue;
                }
            };
            let Some(path) = value
                .get("transcript_path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
            else {
                rt.warn(
                    "invalid Qwen Work SDK wakeup; discarding SDK-owned marker",
                    None,
                );
                tokio::fs::remove_file(marker).await?;
                continue;
            };
            let Some(session) = value
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                rt.warn(
                    "invalid Qwen Work SDK wakeup; discarding SDK-owned marker",
                    None,
                );
                tokio::fs::remove_file(marker).await?;
                continue;
            };
            if !native
                .transcript_roots
                .iter()
                .any(|root| path.starts_with(root))
                || path
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
            {
                rt.warn(
                    "Qwen Work SDK wakeup is outside the authorized transcript source; discarding SDK-owned marker",
                    None,
                );
                tokio::fs::remove_file(marker).await?;
                continue;
            }
            // The SDK read budget is per source per collection cycle. Keep
            // same-session notifications ordered and avoid resetting that
            // budget by draining many wakeups for the same file in one poll.
            if seen_sessions.contains(session) || seen_sources.contains(&path) {
                continue;
            }
            if let Err(error) = crate::utils::source_access::private_path(&path)
                .and_then(|()| crate::utils::source_access::check(&path))
            {
                if error.kind() == std::io::ErrorKind::PermissionDenied {
                    rt.warn(
                        "Qwen Work SDK wakeup source was rejected; discarding SDK-owned marker",
                        None,
                    );
                    tokio::fs::remove_file(marker).await?;
                    continue;
                }
                if error.kind() == std::io::ErrorKind::NotFound {
                    let expired = tokio::fs::metadata(&marker).await.is_ok_and(|metadata| {
                        metadata
                            .modified()
                            .ok()
                            .and_then(|mtime| mtime.elapsed().ok())
                            .is_some_and(|age| age >= MISSING_SOURCE_GRACE)
                    });
                    if expired {
                        rt.warn("Qwen Work SDK wakeup source remained missing; discarding expired marker", None);
                        tokio::fs::remove_file(marker).await?;
                    }
                    continue;
                }
                rt.warn(
                    "Qwen Work SDK wakeup retained while its source is unavailable",
                    None,
                );
                continue;
            }
            seen_sessions.insert(session.to_owned());
            seen_sources.insert(path.clone());
            let input = serde_json::to_vec(&value)?;
            let limit = value.get("snapshot_bytes").and_then(Value::as_u64);
            let native = native.clone();
            let scope = crate::utils::source_access::current();
            let budget = Arc::new(TranscriptReadBudget::new(
                crate::utils::source_access::read_limit(usize::MAX),
            ));
            let read_budget = budget.clone();
            let task = tokio::task::spawn_blocking(move || {
                struct Restore(Option<Arc<crate::utils::source_access::SourceScope>>);
                impl Drop for Restore {
                    fn drop(&mut self) {
                        crate::utils::source_access::install(self.0.take());
                    }
                }
                let _restore = Restore(crate::utils::source_access::current());
                crate::utils::source_access::install(scope);
                crate::hook_process::run_qwen_work_cn_for_sdk(
                    &native.producer_data_dir,
                    &native.user_id,
                    &input,
                    limit,
                    native.legacy_cursor_root.as_deref(),
                    &read_budget,
                )
            });
            *worker = Some(NativeStopWorker {
                marker,
                source: path,
                session: session.to_owned(),
                budget,
                task,
            });
            if !poll_native_stop(&mut worker, rt).await? {
                break;
            }
        }
        Ok(())
    }
}

struct NativeStopWorker {
    marker: PathBuf,
    source: PathBuf,
    session: String,
    budget: Arc<TranscriptReadBudget>,
    task: tokio::task::JoinHandle<bool>,
}

impl Drop for NativeStopWorker {
    fn drop(&mut self) {
        self.budget.cancel();
    }
}

/// A blocked reader yields to the collector until the next poll grants bytes.
async fn poll_native_stop(
    worker: &mut Option<NativeStopWorker>,
    rt: &InputRuntime,
) -> anyhow::Result<bool> {
    let pending = worker.as_mut().expect("native Stop worker");
    let result = tokio::select! {
        result = &mut pending.task => result,
        _ = pending.budget.exhausted.notified() => return Ok(false),
    };
    let pending = worker.take().expect("native Stop worker");
    if result? {
        tokio::fs::remove_file(&pending.marker).await?;
    } else {
        rt.warn("Qwen Work SDK wakeup retained for source retry", None);
    }
    Ok(true)
}
